import { BrowserWindow } from 'electron';
import path from 'node:path';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('window:tutor');

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

let tutor: BrowserWindow | null = null;

/**
 * Subscribers notified when the Lens window closes. Used by ipc.ts to
 * tear down active watch (kill tail, abort streams) without polling.
 *
 * Replaces a 5s setInterval that checked getTutorWindow() — event-driven
 * over time-driven, same idea as fs.watch vs polling.
 */
const closeSubscribers = new Set<() => void>();

export function onTutorClosed(fn: () => void): () => void {
  closeSubscribers.add(fn);
  return () => closeSubscribers.delete(fn);
}

/**
 * Open the Lens window. If `initialJsonlPath` is set, the renderer skips
 * the picker and goes straight to the feed for that session — used when
 * the user clicks a row from the dashboard's LENS tab.
 *
 * Param is passed via URL to avoid the load-race that bites IPC pushes
 * sent before the renderer has mounted.
 */
export function openTutor(initialJsonlPath?: string): BrowserWindow {
  if (tutor && !tutor.isDestroyed()) {
    // Already open — just signal a deep-link instead of recreating.
    if (initialJsonlPath) {
      tutor.webContents.send('tutor:deep-link', { jsonlPath: initialJsonlPath });
    }
    tutor.focus();
    return tutor;
  }
  tutor = new BrowserWindow({
    width: 760,
    height: 760,
    backgroundColor: '#0a0b0f',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'api.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const params = new URLSearchParams({ view: 'tutor' });
  if (initialJsonlPath) params.set('jsonl', initialJsonlPath);
  const query = params.toString();

  const url =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
      ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${query}`
      : `file://${path.join(__dirname, '..', 'renderer', 'index.html')}?${query}`;
  void tutor.loadURL(url);
  tutor.once('ready-to-show', () => tutor?.show());
  tutor.on('closed', () => {
    tutor = null;
    for (const fn of closeSubscribers) {
      try {
        fn();
      } catch (err) {
        log.warn({ err: String(err) }, 'close subscriber threw');
      }
    }
  });
  log.info({ initialJsonlPath: initialJsonlPath ?? null }, 'tutor window opened');
  return tutor;
}

export function getTutorWindow(): BrowserWindow | null {
  return tutor;
}
