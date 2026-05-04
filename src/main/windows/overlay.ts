import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:overlay');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let overlay: BrowserWindow | null = null;
let hiddenForOverlay: BrowserWindow[] = [];

/**
 * Open the marquee overlay covering the active display. Idempotent — calling
 * while already open focuses the existing window.
 */
export function openOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) {
    overlay.focus();
    return overlay;
  }

  // Hide every other visible Glint window so none appear in the screenshot.
  // Tracked so capture:cancel can restore exactly what we hid.
  hiddenForOverlay = [];
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isVisible()) {
      hiddenForOverlay.push(w);
      try {
        w.hide();
      } catch {
        // window mid-teardown — skip
      }
    }
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;

  overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    fullscreenable: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'api.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const url =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=overlay`
      : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}?view=overlay`;

  void overlay.loadURL(url);

  overlay.once('ready-to-show', () => overlay?.show());
  overlay.on('closed', () => {
    overlay = null;
    log.info('overlay closed');
  });

  log.info({ display: display.id, width, height }, 'overlay opened');
  return overlay;
}

/**
 * Tear the overlay down hard. We use destroy() instead of close() so
 * nothing — Vite HMR-stale event handlers, alwaysOnTop stickiness, OS
 * focus quirks — can keep the window visible. Also hide() first so the
 * visual disappearance is immediate even before destruction completes.
 */
export function closeOverlay(): void {
  if (!overlay) return;
  if (overlay.isDestroyed()) {
    overlay = null;
    return;
  }
  try {
    overlay.hide();
  } catch {
    // ignore — happens if the window is mid-teardown already
  }
  overlay.destroy();
  overlay = null;
}

/**
 * Re-show the windows we hid in openOverlay. Used on cancel — the
 * capture:request path leaves them hidden because the streaming flow
 * (response window opens, main shows on response close) handles
 * visibility on its own schedule.
 */
export function restoreOverlayHiddenWindows(): void {
  for (const w of hiddenForOverlay) {
    if (!w.isDestroyed()) {
      try {
        w.show();
      } catch {
        // ignore — window destroyed between hide and restore
      }
    }
  }
  hiddenForOverlay = [];
}
