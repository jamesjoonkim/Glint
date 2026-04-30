import { BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:first-run');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let firstRun: BrowserWindow | null = null;

export function openFirstRun(): BrowserWindow {
  if (firstRun && !firstRun.isDestroyed()) {
    firstRun.focus();
    return firstRun;
  }
  firstRun = new BrowserWindow({
    width: 640,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
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
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=first-run`
      : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}?view=first-run`;
  void firstRun.loadURL(url);
  firstRun.once('ready-to-show', () => firstRun?.show());
  firstRun.on('closed', () => (firstRun = null));
  log.info('first-run window opened');
  return firstRun;
}

export function closeFirstRun(): void {
  if (firstRun && !firstRun.isDestroyed()) firstRun.close();
}

export function getFirstRunWindow(): BrowserWindow | null {
  return firstRun;
}
