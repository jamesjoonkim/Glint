import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:overlay');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let overlay: BrowserWindow | null = null;

/**
 * Open the marquee overlay covering the active display. Idempotent — calling
 * while already open focuses the existing window.
 */
export function openOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) {
    overlay.focus();
    return overlay;
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
      preload: path.join(__dirname, '../preload/api.js'),
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
      : `file://${path.join(
          __dirname,
          `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
        )}?view=overlay`;

  void overlay.loadURL(url);

  overlay.once('ready-to-show', () => overlay?.show());
  overlay.on('closed', () => {
    overlay = null;
    log.info('overlay closed');
  });

  log.info({ display: display.id, width, height }, 'overlay opened');
  return overlay;
}

export function closeOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.close();
}
