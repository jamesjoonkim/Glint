import { BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:response');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let response: BrowserWindow | null = null;
const closeListeners = new Set<() => void>();

/** Subscribe to response-window-closed events (used to restore main window). */
export function onResponseClosed(fn: () => void): () => void {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}

/**
 * Open (or focus) the floating response window for a given stream id.
 * Idempotent — calling with a new streamId reuses the existing window and
 * sends `response:set-stream` so it switches to the new stream.
 */
export function openResponse(streamId: string): BrowserWindow {
  if (response && !response.isDestroyed()) {
    response.webContents.send('response:set-stream', { streamId });
    // Reuse path: show() before focus() — focus alone won't unhide a window
    // we hid earlier (e.g., before opening the marquee overlay so the chat
    // wasn't in the screenshot frame).
    if (!response.isVisible()) response.show();
    response.focus();
    return response;
  }

  response = new BrowserWindow({
    width: 540,
    height: 480,
    frame: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0b0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'api.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const url =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=response&streamId=${streamId}`
      : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}?view=response&streamId=${streamId}`;

  void response.loadURL(url);
  response.once('ready-to-show', () => {
    if (!response) return;
    response.show();
    // Without an explicit focus call, macOS sometimes opens the window in
    // background depending on which app last had keyboard focus. .focus()
    // makes ⌘⇧Z reliably land in a typeable state.
    response.focus();
  });
  response.on('closed', () => {
    response = null;
    for (const fn of closeListeners) {
      try {
        fn();
      } catch (err) {
        log.warn({ err: String(err) }, 'closeListener threw');
      }
    }
  });

  log.info({ streamId }, 'response window opened');
  return response;
}

export function getResponseWindow(): BrowserWindow | null {
  return response && !response.isDestroyed() ? response : null;
}

/**
 * Hide the response window without destroying it — used during in-chat
 * screenshot capture so the chat isn't visible in the captured frame.
 * The window is shown again automatically when openResponse is next
 * called for any stream id (see show() in the reuse branch above).
 */
export function hideResponseWindow(): void {
  if (response && !response.isDestroyed() && response.isVisible()) {
    response.hide();
  }
}
