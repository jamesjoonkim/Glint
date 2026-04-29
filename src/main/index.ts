import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logger/index.js';

// Catch otherwise-silent main-process failures and surface them via the
// daily logger. Without this an early throw vanishes (Electron just exits
// without printing the stack to any visible stdout in dev).
process.on('uncaughtException', (e) => {
  createLogger('main').fatal({ err: e.stack ?? String(e) }, 'uncaught exception');
});
process.on('unhandledRejection', (e) => {
  createLogger('main').error({ err: String(e) }, 'unhandled rejection');
});
import { DEFAULT_BINDINGS, registerHotkeys, unregisterHotkeys } from './hotkey.js';
import { closeOverlay, openOverlay } from './windows/overlay.js';
import { openHistory } from './windows/history.js';
import { captureBBox } from './capture.js';
import { ensureScreenRecording } from './permissions.js';
import { setPromptsDir } from '../core/models/prompts.js';
import { runPipeline, startStream, type PipelineDeps } from './pipeline.js';
import { destroyWorker } from '../core/ocr/tesseract.js';
import { startRuntime, type RuntimeHandle } from '../core/models/runtime.js';
import {
  closeStore,
  listRecent,
  openStore,
  searchKeyword,
  type CaptureRow,
} from '../core/history/store.js';
import { setMigrationsDir } from '../core/history/migrations.js';
import type { CaptureBBox } from '../shared/types.js';

const log = createLogger('main');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'api.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined') {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(rendererIndex());
  }

  win.once('ready-to-show', () => win.show());
  return win;
}

function wireIpc(): void {
  ipcMain.handle('ping', () => 'pong' as const);

  ipcMain.handle('capture:cancel', () => {
    closeOverlay();
    return { ok: true } as const;
  });

  ipcMain.handle('capture:request', async (_e, bbox: CaptureBBox) => {
    closeOverlay(); // dismiss before capturing so it isn't in the frame
    try {
      const record = await captureBBox(bbox);
      log.info({ id: record.id }, 'capture complete');
      const streamId = startStream();
      void runPipeline(record, streamId, getPipelineDeps());
      return { ok: true, id: record.id, streamId };
    } catch (err) {
      log.error({ err: String(err) }, 'capture failed');
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('history:list', () => mapHistory(listRecent(200)));

  ipcMain.handle('history:search', (_e, query: unknown) =>
    mapHistory(searchKeyword(typeof query === 'string' ? query : '')),
  );

  ipcMain.handle('history:open', (_e, payload: unknown) => {
    log.info({ payload }, 'history:open (continue thread P4)');
    return { ok: true };
  });
}

function mapHistory(rows: CaptureRow[]) {
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    pngPath: r.png_path,
    thumbPath: r.thumb_path,
    ocrText: r.ocr_text,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    threadId: r.thread_id,
  }));
}

function rendererIndex(): string {
  // Forge's plugin-vite emits the production renderer to .vite/renderer/index.html
  // (no per-window subdir despite forge.config.ts naming it 'main_window').
  // __dirname in the bundled main is .vite/build, so step up + over.
  return path.join(__dirname, '..', 'renderer', 'index.html');
}

function resolvePromptsDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'prompts');
  return path.join(app.getAppPath(), 'prompts');
}

function resolveMigrationsDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'migrations');
  return path.join(app.getAppPath(), 'migrations');
}

function resolveDbPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Glint',
    'glint.db',
  );
}

function resolveRuntimeBinary(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime', 'glint-mlx-server');
  }
  return path.join(app.getAppPath(), 'resources', 'runtime', 'glint-mlx-server');
}

function resolveModelPath(name: string): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Glint',
    'models',
    name,
  );
}

// eslint-disable-next-line prefer-const
let textRuntime: RuntimeHandle | null = null;
// vision runtime spawn lands when the wizard installs the model; declared now
// for tear-down + dep wiring.
const visionRuntime: RuntimeHandle | null = null;

async function startTextRuntime(): Promise<RuntimeHandle | null> {
  const fs = await import('node:fs');
  const mode = resolveLlmMode();

  if (mode === 'fake') {
    log.info({ reason: 'env or test' }, 'fake LLM mode — skipping runtime spawn');
    return null;
  }

  const binaryPath = resolveRuntimeBinary();
  const modelPath = resolveModelPath('qwen2.5-7b-mlx');

  // Auto-fallback: if either the runtime binary or the text model is missing,
  // we can't usefully spawn. Surface this in logs and let the pipeline emit a
  // helpful message instead of timing out at health-check.
  if (!fs.existsSync(binaryPath)) {
    log.warn({ binaryPath }, 'runtime binary missing — fake mode');
    return null;
  }
  if (!fs.existsSync(modelPath)) {
    log.warn({ modelPath }, 'text model missing — fake mode (run first-run wizard)');
    return null;
  }

  try {
    const handle = await startRuntime({ binaryPath, modelPath, preferredPort: 8765 });
    log.info({ url: handle.url, pid: handle.pid }, 'text runtime live');
    return handle;
  } catch (err) {
    log.error({ err: String(err) }, 'text runtime spawn failed');
    return null;
  }
}

/**
 * Resolve LLM mode. Priority: explicit env var → auto-detect from disk.
 *   GLINT_LLM=fake  → always fake
 *   GLINT_LLM=real  → always real (errors if binary/model missing)
 *   unset           → real if both binary + text model exist, else fake
 */
function resolveLlmMode(): 'fake' | 'real' {
  if (process.env.GLINT_LLM === 'fake') return 'fake';
  if (process.env.NODE_ENV === 'test') return 'fake';
  if (process.env.GLINT_LLM === 'real') return 'real';
  // Default: auto-detect.
  return 'real';
}

function getPipelineDeps(): PipelineDeps {
  return {
    textUrl: textRuntime?.url ?? null,
    visionUrl: visionRuntime?.url ?? null,
    textModel: 'default_model',
    visionModel: 'default_model',
  };
}

app.whenReady().then(async () => {
  log.info('app ready');
  setPromptsDir(resolvePromptsDir());
  setMigrationsDir(resolveMigrationsDir());
  await openStore(resolveDbPath()).catch((err) =>
    log.error({ err: String(err) }, 'store open failed'),
  );
  // Start text runtime in background — UI can render before model is ready.
  void startTextRuntime().then((h) => (textRuntime = h));
  wireIpc();
  createMainWindow();

  registerHotkeys(DEFAULT_BINDINGS, {
    onCapture: async () => {
      const { granted } = await ensureScreenRecording();
      if (!granted) return;
      openOverlay();
    },
    onHistory: () => openHistory(),
    onSettings: () => log.info('settings hotkey (P5)'),
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  log.info('all windows closed; quitting');
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  unregisterHotkeys();
});

app.on('before-quit', async () => {
  log.info('before-quit; tearing down workers');
  await Promise.allSettled([
    destroyWorker().catch((err) => log.warn({ err: String(err) }, 'ocr teardown')),
    textRuntime?.stop().catch((err: unknown) => log.warn({ err: String(err) }, 'text runtime stop')),
    (visionRuntime as RuntimeHandle | null)?.stop().catch((err: unknown) =>
      log.warn({ err: String(err) }, 'vision runtime stop'),
    ),
  ]);
  closeStore();
});
