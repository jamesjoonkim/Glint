import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger/index.js';
import type { CaptureRecord } from './capture.js';
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
import { closeOverlay, openOverlay, restoreOverlayHiddenWindows } from './windows/overlay.js';
import { openHistory } from './windows/history.js';
import { hideResponseWindow, onResponseClosed, openResponse } from './windows/response.js';
import { captureBBox } from './capture.js';
import { ensureScreenRecording } from './permissions.js';
import { setPromptsDir } from '../core/models/prompts.js';
import { cancelStream, continueThread, runComposedTurn, runPipeline, startStream, type PipelineDeps } from './pipeline.js';
import { destroyWorker } from '../core/ocr/tesseract.js';
import { startRuntime, type RuntimeHandle } from '../core/models/runtime.js';
import {
  closeStore,
  createCaptureWithThread,
  createThread,
  getTurns,
  listChatThreads,
  listRecent,
  searchChatThreads,
  openStore,
  searchKeyword,
  setThumbnail,
  type CaptureRow,
} from '../core/history/store.js';
import { makeThumbnail } from '../core/history/thumbnails.js';
import { setMigrationsDir } from '../core/history/migrations.js';
import { loadSettings, setSettingsPath } from './settings.js';
import type { CaptureBBox } from '../shared/types.js';

const log = createLogger('main');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let mainWindow: BrowserWindow | null = null;

/**
 * When set, the next capture:request will attach the resulting capture row
 * to this existing thread instead of creating a new one. Used by the
 * `+` button inside the response window's chat input via capture:openForThread.
 * Consumed atomically inside capture:request so a stale value can't leak
 * into a subsequent ⌘⇧X capture.
 */
let pendingCaptureThreadId: string | null = null;

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
    backgroundColor: '#0a0b0f',
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

  ipcMain.handle('model:stream:cancel', (_e, payload: unknown) => {
    const streamId = (payload as { streamId?: unknown })?.streamId;
    if (typeof streamId !== 'string') return { ok: false, error: 'invalid streamId' };
    const aborted = cancelStream(streamId);
    return { ok: aborted, streamId };
  });

  ipcMain.handle('capture:cancel', () => {
    closeOverlay();
    restoreOverlayHiddenWindows();
    pendingCaptureThreadId = null;
    return { ok: true } as const;
  });

  ipcMain.handle('capture:openForThread', async (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    if (typeof threadId !== 'string') return { ok: false, error: 'invalid threadId' };
    const { granted } = await ensureScreenRecording();
    if (!granted) return { ok: false, error: 'screen recording denied' };
    // Stash the target thread; capture:request consumes it on the next call.
    pendingCaptureThreadId = threadId;
    // openOverlay() hides every visible Glint window (incl. the response
    // chat) so none appear in the captured frame, and tracks them for
    // restore on cancel. openResponse() re-shows the chat when the stream
    // fires after a successful capture.
    openOverlay();
    return { ok: true };
  });

  ipcMain.handle('capture:attachImage', async (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    const dataUrl = (payload as { dataUrl?: unknown })?.dataUrl;
    if (typeof threadId !== 'string') return { ok: false, error: 'invalid threadId' };
    if (typeof dataUrl !== 'string') return { ok: false, error: 'invalid dataUrl' };

    const decoded = await decodeAndWriteImage(dataUrl);
    if ('error' in decoded) return { ok: false, error: decoded.error };
    log.info({ id: decoded.id, threadId, ...decoded.size }, 'image attached');

    const record: CaptureRecord = {
      id: decoded.id,
      pngPath: decoded.pngPath,
      bbox: { x: 0, y: 0, width: decoded.size.width, height: decoded.size.height, displayId: 0 },
      displayId: 0,
      byteSize: decoded.bytes,
    };

    const streamId = startStream();
    void (async () => {
      await Promise.allSettled([textRuntimePromise, visionRuntimePromise]);
      return runPipeline(record, streamId, getPipelineDeps(), threadId);
    })();
    return { ok: true, id: decoded.id, streamId };
  });

  ipcMain.handle('chat:sendComposed', async (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    const attachments = (payload as { attachments?: unknown })?.attachments;
    const text = (payload as { text?: unknown })?.text;
    if (typeof threadId !== 'string') return { ok: false, error: 'invalid threadId' };
    if (!Array.isArray(attachments)) return { ok: false, error: 'invalid attachments' };
    const textStr = typeof text === 'string' ? text : '';

    // Save each attachment as a capture row, collect pngPaths for the
    // composed multimodal user turn.
    const pngPaths: string[] = [];
    for (const att of attachments) {
      const dataUrl = (att as { dataUrl?: unknown })?.dataUrl;
      if (typeof dataUrl !== 'string') continue;
      const decoded = await decodeAndWriteImage(dataUrl);
      if ('error' in decoded) {
        log.warn({ err: decoded.error }, 'composed attachment decode failed');
        continue;
      }
      // Persist the capture row so it shows up in history. Skip OCR — these
      // are explicit user-attached images, the composed turn always goes
      // through the vision route when possible.
      try {
        const { capture } = createCaptureWithThread({
          pngPath: decoded.pngPath,
          ocrText: '',
          ocrConfidence: 0,
          textDensity: 0,
          route: 'vision',
          threadId,
        });
        // Generate thumbnail async — pasted/dropped attachments otherwise
        // render with the empty placeholder in the captures grid until the
        // startup backfill catches them on next launch.
        void makeThumbnail(decoded.pngPath)
          .then((thumb) => setThumbnail(capture.id, thumb))
          .catch((err) => log.warn({ err: String(err) }, 'attachment thumb failed'));
      } catch (err) {
        log.warn({ err: String(err) }, 'composed attachment row insert failed');
      }
      pngPaths.push(decoded.pngPath);
    }

    log.info(
      { threadId, images: pngPaths.length, hasText: !!textStr.trim() },
      'composed turn requested',
    );

    void (async () => {
      await Promise.allSettled([textRuntimePromise, visionRuntimePromise]);
      try {
        await runComposedTurn({
          threadId,
          pngPaths,
          text: textStr,
          deps: getPipelineDeps(),
        });
      } catch (err) {
        log.error({ err: String(err), threadId }, 'composed turn failed');
      }
    })();
    return { ok: true };
  });

  ipcMain.handle('capture:request', async (_e, bbox: CaptureBBox) => {
    closeOverlay(); // dismiss before capturing so it isn't in the frame
    hideMainWindow(); // dashboard out of frame while answer streams
    // Consume the pending-thread state ATOMICALLY so a stale value can't
    // leak into a subsequent fresh ⌘⇧X capture.
    const intoThreadId = pendingCaptureThreadId;
    pendingCaptureThreadId = null;
    try {
      const record = await captureBBox(bbox);
      log.info({ id: record.id, intoThreadId }, 'capture complete');
      // Defensive: if anything kept the overlay alive across the screenshot
      // (HMR stale handler, alwaysOnTop stickiness), tear it down again now
      // that the capture is in hand. Idempotent — no-op if already gone.
      closeOverlay();
      const streamId = startStream();
      // Wait for BOTH runtime spawns before dispatching — the router doesn't
      // know yet whether this capture goes text or vision. First-launch
      // warmup can take ~25s per model; the response window's empty state
      // shows the reading-the-capture animation until tokens arrive.
      void (async () => {
        await Promise.allSettled([textRuntimePromise, visionRuntimePromise]);
        return runPipeline(record, streamId, getPipelineDeps(), intoThreadId);
      })();
      return { ok: true, id: record.id, streamId };
    } catch (err) {
      log.error({ err: String(err) }, 'capture failed');
      closeOverlay(); // even on failure — never leave the marquee on screen
      restoreOverlayHiddenWindows(); // bring back the UI we hid for the shot
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('history:list', () => mapHistory(listRecent(200)));

  ipcMain.handle('history:search', (_e, query: unknown) =>
    mapHistory(searchKeyword(typeof query === 'string' ? query : '')),
  );

  ipcMain.handle('history:listChats', () => listChatThreads(200));

  ipcMain.handle('history:searchChats', (_e, query: unknown) =>
    searchChatThreads(typeof query === 'string' ? query : '', 200),
  );

  ipcMain.handle('history:openThread', (_e, payload: unknown) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    if (typeof threadId !== 'string') return { ok: false, error: 'invalid threadId' };
    hideMainWindow();
    // Same replay flow as history:open but for capture-less chat threads.
    // The chat- prefix tells the response window's URL parser this is a
    // sentinel, not a real stream id, AND distinguishes chat threads from
    // capture replay in case future logic wants to branch on it.
    const win = openResponse(`chat-${threadId}`);
    const fire = () => {
      win.webContents.send('response:set-thread', { threadId });
      win.webContents.send('response:replay', { threadId });
    };
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', fire);
    } else {
      fire();
    }
    return { ok: true, threadId };
  });

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
 * Decode a `data:image/...;base64,...` URL, normalize through nativeImage
 * (so JPEG/HEIC/WebP all become PNG), write it to the captures dir under a
 * fresh UUID, and return the saved path + image size. Hard 25MB cap to
 * match desktopCapturer's MAX_PNG_BYTES posture.
 *
 * Used by both capture:attachImage (single-image-as-capture flow) and
 * chat:sendComposed (multi-image bundle).
 */
async function decodeAndWriteImage(
  dataUrl: string,
): Promise<
  | { id: string; pngPath: string; size: { width: number; height: number }; bytes: number }
  | { error: string }
> {
  if (!dataUrl.startsWith('data:image/')) return { error: 'invalid dataUrl' };
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  if (!base64) return { error: 'malformed dataUrl' };
  let pngBuffer: Buffer;
  let size: { width: number; height: number };
  try {
    const raw = Buffer.from(base64, 'base64');
    if (raw.byteLength > 25 * 1024 * 1024) return { error: 'image too large' };
    const native = nativeImage.createFromBuffer(raw);
    if (native.isEmpty()) return { error: 'unrecognized image' };
    size = native.getSize();
    pngBuffer = native.toPNG();
  } catch (err) {
    return { error: `decode failed: ${String(err)}` };
  }
  const id = randomUUID();
  const dir = resolveCapturesDir();
  await fsp.mkdir(dir, { recursive: true });
  const pngPath = path.join(dir, `${id}.png`);
  await fsp.writeFile(pngPath, pngBuffer);
  return { id, pngPath, size, bytes: pngBuffer.byteLength };
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
  setSettingsPath(path.join(os.homedir(), 'Library', 'Application Support', 'Glint', 'settings.json'));
  await loadSettings();
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
    onDashboard: () => {
      // Close the chat (hide response window) and surface the dashboard.
      // hideResponseWindow only .hide()s — does not fire onResponseClosed,
      // so showMainWindow must be called explicitly here.
      hideResponseWindow();
      showMainWindow();
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
