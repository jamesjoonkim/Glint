import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { createLogger } from '../core/logger/index.js';
import { DEFAULT_BINDINGS, registerHotkeys, unregisterHotkeys } from './hotkey.js';
import { closeOverlay, openOverlay } from './windows/overlay.js';

const log = createLogger('main');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/api.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined') {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
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
  // capture:request lands in P1 Day 4 (capture.ts)
}

app.whenReady().then(() => {
  log.info('app ready');
  wireIpc();
  createMainWindow();

  registerHotkeys(DEFAULT_BINDINGS, {
    onCapture: () => openOverlay(),
    onHistory: () => log.info('history hotkey (P3)'),
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

app.on('before-quit', () => {
  log.info('before-quit; future: tear down MLX runtime + DB');
});
