import { BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:history');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let history: BrowserWindow | null = null;

export function openHistory(): BrowserWindow {
  if (history && !history.isDestroyed()) {
    history.focus();
    return history;
  }
  history = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 600,
    minHeight: 480,
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
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?view=history`
      : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}?view=history`;
  void history.loadURL(url);
  history.once('ready-to-show', () => history?.show());
  history.on('closed', () => (history = null));
  log.info('history window opened');
  return history;
}
