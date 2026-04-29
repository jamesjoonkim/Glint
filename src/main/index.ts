import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { createLogger } from '../core/logger/index.js';
import { DEFAULT_BINDINGS, registerHotkeys, unregisterHotkeys } from './hotkey.js';
import { closeOverlay, openOverlay } from './windows/overlay.js';
import { captureBBox } from './capture.js';
import { ensureScreenRecording } from './permissions.js';
import type { CaptureBBox } from '../shared/types.js';

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

  ipcMain.handle('capture:request', async (_e, bbox: CaptureBBox) => {
    closeOverlay(); // dismiss before capturing so it isn't in the frame
    try {
      const record = await captureBBox(bbox);
      log.info({ id: record.id }, 'capture complete');
      // OCR + router + model dispatch wired in P1 D5+D6+D7
      return { ok: true, id: record.id, pngPath: record.pngPath };
    } catch (err) {
      log.error({ err: String(err) }, 'capture failed');
      return { ok: false, error: String(err) };
    }
  });
}

app.whenReady().then(() => {
  log.info('app ready');
  wireIpc();
  createMainWindow();

  registerHotkeys(DEFAULT_BINDINGS, {
    onCapture: async () => {
      const { granted } = await ensureScreenRecording();
      if (!granted) return;
      openOverlay();
    },
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
