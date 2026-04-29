import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../logger/index.js';

const log = createLogger('models:runtime');

export type RuntimeConfig = {
  binaryPath: string; // resources/runtime/glint-mlx-server
  modelPath: string;
  preferredPort: number;
  /** 'text' uses mlx_lm.server, 'vision' uses mlx_vlm.server. */
  backend?: 'text' | 'vision';
};

export type RuntimeHandle = {
  port: number;
  pid: number;
  url: string;
  stop: () => Promise<void>;
};

// PyInstaller cold-start unpacks ~150MB to a tmp dir on first launch (~20-30s
// on M-series; ~10s subsequent launches). Plus mlx_lm.server boot (~10s).
// Generous ceiling: 90s.
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 500;
const SIGTERM_GRACE_MS = 3_000;

/**
 * Find a free TCP port. Tries `preferred` first; if EADDRINUSE, asks the OS
 * for any free port via bind(0).
 */
export async function findPort(preferred: number): Promise<number> {
  const tryBind = (port: number) =>
    new Promise<number | null>((resolve) => {
      const sock = net.createServer();
      sock.unref();
      sock.on('error', () => resolve(null));
      sock.listen(port, '127.0.0.1', () => {
        const addr = sock.address();
        sock.close(() => resolve(typeof addr === 'object' && addr ? addr.port : null));
      });
    });

  return (await tryBind(preferred)) ?? (await tryBind(0)) ?? 0;
}

async function pingHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the bundled MLX server. Resolves after /v1/models returns 200, or
 * rejects after HEALTH_TIMEOUT_MS.
 *
 * Localhost-only binding via --host 127.0.0.1 (privacy contract).
 */
export async function startRuntime(cfg: RuntimeConfig): Promise<RuntimeHandle> {
  const port = await findPort(cfg.preferredPort);
  if (port === 0) throw new Error('failed to allocate localhost port');

  const url = `http://127.0.0.1:${port}`;

  // Tee child stdio to ~/Library/Application Support/Glint/logs/runtime-<port>.log
  // for diagnosis — Electron's main-process stdout is unreliable.
  const logDir = path.join(os.homedir(), 'Library', 'Application Support', 'Glint', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const runtimeLogPath = path.join(logDir, `runtime-${port}.log`);
  const runtimeLog = fs.createWriteStream(runtimeLogPath, { flags: 'a' });
  runtimeLog.write(`\n=== ${new Date().toISOString()} spawning ${cfg.binaryPath} ===\n`);

  const backend = cfg.backend ?? 'text';
  const proc: ChildProcess = spawn(
    cfg.binaryPath,
    [
      '--backend', backend,
      '--model', cfg.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (!proc.pid) throw new Error('runtime spawn failed (no pid)');
  log.info({ pid: proc.pid, port, model: cfg.modelPath, runtimeLog: runtimeLogPath }, 'runtime spawning');

  proc.stderr?.pipe(runtimeLog, { end: false });
  proc.stdout?.pipe(runtimeLog, { end: false });

  // Short-circuit on early process exit so callers don't wait the full
  // 90s health timeout when the spawn fails immediately (e.g. missing
  // mlx_vlm.server module).
  let exitedCode: number | null | undefined = undefined;
  proc.on('exit', (code) => {
    runtimeLog.write(`=== exit code=${code} ===\n`);
    exitedCode = code;
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitedCode !== undefined) {
      throw new Error(`runtime exited with code ${exitedCode} before health check`);
    }
    if (await pingHealth(url)) {
      log.info({ url }, 'runtime healthy');
      return {
        port,
        pid: proc.pid,
        url,
        stop: () => stopRuntime(proc),
      };
    }
    await delay(HEALTH_INTERVAL_MS);
  }

  await stopRuntime(proc);
  throw new Error(`runtime failed health check within ${HEALTH_TIMEOUT_MS}ms`);
}

export async function stopRuntime(proc: ChildProcess): Promise<void> {
  if (proc.exitCode != null) return;
  proc.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((r) => proc.once('exit', () => r())),
    delay(SIGTERM_GRACE_MS),
  ]);
  if (proc.exitCode == null) {
    log.warn({ pid: proc.pid }, 'runtime did not exit on SIGTERM; SIGKILL');
    proc.kill('SIGKILL');
  }
}

// Test helpers
export const __HEALTH_TIMEOUT_MS = HEALTH_TIMEOUT_MS;
