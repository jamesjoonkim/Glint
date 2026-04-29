import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logger/index.js';
import {
  registerAssetSchemePrivileged,
  registerAssetProtocolHandler,
} from './asset-protocol.js';
import { backfillThumbnails } from '../core/history/backfill.js';

// Privileged schemes must register synchronously at module load — before
// app.whenReady — or Chromium refuses to treat them as standard URLs.
registerAssetSchemePrivileged();

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
import { onResponseClosed, openResponse } from './windows/response.js';
import { captureBBox } from './capture.js';
import { ensureScreenRecording } from './permissions.js';
import { setPromptsDir } from '../core/models/prompts.js';
import { continueThread, runPipeline, startStream, type PipelineDeps } from './pipeline.js';
import { destroyWorker } from '../core/ocr/tesseract.js';
import { startRuntime, type RuntimeHandle } from '../core/models/runtime.js';
import {
  closeStore,
  createThread,
  getTurns,
  listRecent,
  openStore,
  searchKeyword,
  type CaptureRow,
} from '../core/history/store.js';
import { setMigrationsDir } from '../core/history/migrations.js';
import type { CaptureBBox } from '../shared/types.js';

const log = createLogger('main');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
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
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else {
    createMainWindow();
  }
}

function wireIpc(): void {
  ipcMain.handle('ping', () => 'pong' as const);

  ipcMain.handle('capture:cancel', () => {
    closeOverlay();
    return { ok: true } as const;
  });

  ipcMain.handle('capture:request', async (_e, bbox: CaptureBBox) => {
    closeOverlay(); // dismiss before capturing so it isn't in the frame
    hideMainWindow(); // dashboard out of frame while answer streams
    try {
      const record = await captureBBox(bbox);
      log.info({ id: record.id }, 'capture complete');
      const streamId = startStream();
      // Wait for BOTH runtime spawns before dispatching — the router doesn't
      // know yet whether this capture goes text or vision. First-launch
      // warmup can take ~25s per model; the response window's empty state
      // shows the reading-the-capture animation until tokens arrive.
      void (async () => {
        await Promise.allSettled([textRuntimePromise, visionRuntimePromise]);
        return runPipeline(record, streamId, getPipelineDeps());
      })();
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
    const captureId = (payload as { captureId?: unknown })?.captureId;
    if (typeof captureId !== 'string') return { ok: false, error: 'invalid captureId' };
    const row = listRecent(500).find((r) => r.id === captureId);
    if (!row) return { ok: false, error: 'capture not found' };
    const threadId = row.thread_id;
    if (!threadId) return { ok: false, error: 'capture has no thread' };
    hideMainWindow();
    // Open (or focus) response window in replay mode — no live stream id;
    // the renderer pulls saved turns via thread:getTurns.
    const win = openResponse(`replay-${threadId}`);
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('response:set-thread', { threadId });
      win.webContents.send('response:replay', { threadId });
    });
    // Existing window: send immediately.
    if (!win.webContents.isLoading()) {
      win.webContents.send('response:set-thread', { threadId });
      win.webContents.send('response:replay', { threadId });
    }
    return { ok: true, threadId };
  });

  ipcMain.handle('thread:getTurns', (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    if (typeof threadId !== 'string') return { ok: false, error: 'invalid threadId' };
    return { ok: true, turns: getTurns(threadId) };
  });

  ipcMain.handle('thread:getCapture', (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    if (typeof threadId !== 'string') return { ok: false, error: 'invalid threadId' };
    // Threads may have many captures over time, but for replay we want the
    // first one — that's the original screenshot the conversation is about.
    const rows = listRecent(500);
    const head = rows
      .filter((r) => r.thread_id === threadId)
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (!head) return { ok: false, error: 'no capture for thread' };
    return {
      ok: true,
      capture: {
        id: head.id,
        createdAt: head.created_at,
        ocrText: head.ocr_text,
        tags: head.tags ? (JSON.parse(head.tags) as string[]) : [],
      },
    };
  });

  ipcMain.handle('chat:start', () => {
    // Capture-less thread for direct chat. Reuses the response window;
    // the renderer treats `chat-${threadId}` as a non-streaming sentinel
    // (same shape as `replay-${threadId}`) so no token subscription opens
    // until the user actually sends a message.
    const thread = createThread();
    hideMainWindow();
    const win = openResponse(`chat-${thread.id}`);
    const fire = () => {
      win.webContents.send('response:set-thread', { threadId: thread.id });
      win.webContents.send('response:replay', { threadId: thread.id });
    };
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', fire);
    } else {
      fire();
    }
    return { ok: true, threadId: thread.id };
  });

  ipcMain.handle('thread:appendTurn', async (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    const content = (payload as { content?: unknown })?.content;
    if (typeof threadId !== 'string' || typeof content !== 'string') {
      return { ok: false, error: 'invalid payload' };
    }
    // Don't await — continueThread streams tokens via webContents.send and
    // returns when the model finishes. The renderer doesn't need a result.
    void (async () => {
      await textRuntimePromise.catch(() => null);
      try {
        await continueThread(threadId, content, getPipelineDeps());
      } catch (err) {
        log.error({ err: String(err), threadId }, 'continueThread failed');
      }
    })();
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

function resolveCapturesDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Glint',
    'captures',
  );
}

/**
 * Resolve the absolute path to better_sqlite3.node, pinned so the
 * `bindings`-style resolver inside better-sqlite3 can't walk out of
 * app.asar.unpacked and find a different ABI on dev machines.
 *
 * In packaged form: process.resourcesPath/app.asar.unpacked/node_modules/...
 * In dev form:     project/node_modules/better-sqlite3/build/Release/...
 */
function resolveBetterSqliteBinding(): string {
  const rel = ['node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'];
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', ...rel);
  }
  return path.join(app.getAppPath(), ...rel);
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

// Runtime spawn is async + slow on first launch (~25s for PyInstaller unpack
// + model load). We hold Promises so capture handlers can await them
// instead of racing into a fetch against a server that hasn't bound its
// port yet. Two runtimes — text on 8765, vision on 8766 — are independent.
let textRuntime: RuntimeHandle | null = null;
let textRuntimePromise: Promise<RuntimeHandle | null> = Promise.resolve(null);
let visionRuntime: RuntimeHandle | null = null;
let visionRuntimePromise: Promise<RuntimeHandle | null> = Promise.resolve(null);

type RuntimeKind = 'text' | 'vision';
const RUNTIME_CONFIG: Record<
  RuntimeKind,
  { modelDir: string; preferredPort: number }
> = {
  text:   { modelDir: 'qwen2.5-7b-mlx',     preferredPort: 8765 },
  vision: { modelDir: 'qwen3-vl-8b-mlx',    preferredPort: 8766 },
};

async function startNamedRuntime(kind: RuntimeKind): Promise<RuntimeHandle | null> {
  const fs = await import('node:fs');
  const mode = resolveLlmMode();

  if (mode === 'fake') {
    log.info({ kind, reason: 'env or test' }, 'fake LLM mode — skipping runtime spawn');
    return null;
  }

  const cfg = RUNTIME_CONFIG[kind];
  const binaryPath = resolveRuntimeBinary();
  const modelPath = resolveModelPath(cfg.modelDir);

  if (!fs.existsSync(binaryPath)) {
    log.warn({ kind, binaryPath }, 'runtime binary missing — fake mode');
    return null;
  }
  if (!fs.existsSync(modelPath)) {
    log.warn({ kind, modelPath }, `${kind} model missing — skipping spawn (run first-run wizard)`);
    return null;
  }

  try {
    const handle = await startRuntime({
      binaryPath,
      modelPath,
      preferredPort: cfg.preferredPort,
      backend: kind,
    });
    log.info({ kind, url: handle.url, pid: handle.pid }, `${kind} runtime live`);
    return handle;
  } catch (err) {
    log.error({ kind, err: String(err) }, `${kind} runtime spawn failed`);
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

void visionRuntime; // referenced in tear-down + getPipelineDeps

app.whenReady().then(async () => {
  log.info('app ready');
  setPromptsDir(resolvePromptsDir());
  setMigrationsDir(resolveMigrationsDir());
  await openStore(resolveDbPath(), {
    nativeBinding: resolveBetterSqliteBinding(),
  }).catch((err) =>
    log.error({ err: String(err) }, 'store open failed'),
  );
  // Custom protocol must register after the store opens — the resolver
  // does a DB lookup on every request to translate ids → file paths.
  registerAssetProtocolHandler(resolveCapturesDir());
  // Backfill missing thumbs in the background. Don't await — this can take
  // 5–10s for ~30 captures and would block UI startup.
  void backfillThumbnails().catch((err) =>
    log.warn({ err: String(err) }, 'backfill failed'),
  );
  // Start text + vision runtimes in parallel — UI is interactive immediately,
  // capture handlers await the relevant promise before dispatching.
  textRuntimePromise = startNamedRuntime('text');
  visionRuntimePromise = startNamedRuntime('vision');
  void textRuntimePromise.then((h) => (textRuntime = h));
  void visionRuntimePromise.then((h) => (visionRuntime = h));
  wireIpc();
  createMainWindow();
  onResponseClosed(() => showMainWindow());

  registerHotkeys(DEFAULT_BINDINGS, {
    onCapture: async () => {
      const { granted } = await ensureScreenRecording();
      if (!granted) return;
      openOverlay();
    },
    onChat: () => {
      // Direct chat: no overlay, no capture. Mint a thread, open response.
      const thread = createThread();
      hideMainWindow();
      const win = openResponse(`chat-${thread.id}`);
      const fire = () => {
        win.webContents.send('response:set-thread', { threadId: thread.id });
        win.webContents.send('response:replay', { threadId: thread.id });
      };
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', fire);
      } else {
        fire();
      }
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
    visionRuntime?.stop().catch((err: unknown) => log.warn({ err: String(err) }, 'vision runtime stop')),
  ]);
  closeStore();
});
