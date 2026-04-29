import { globalShortcut } from 'electron';
import { createLogger } from '../core/logger/index.js';

const log = createLogger('hotkey');

export const DEFAULT_BINDINGS = {
  capture: 'CommandOrControl+Shift+X',
  chat:    'CommandOrControl+Shift+Z',
  history: 'CommandOrControl+Shift+H',
  settings: 'CommandOrControl+,',
} as const;

export type HotkeyBindings = typeof DEFAULT_BINDINGS;

export type HotkeyHandlers = {
  onCapture: () => void;
  onChat: () => void;
  onHistory: () => void;
  onSettings: () => void;
};

let registered: string[] = [];

/**
 * Register all global shortcuts. Returns the list of accelerators that were
 * actually registered (some may fail if another app holds them).
 */
export function registerHotkeys(
  bindings: HotkeyBindings,
  handlers: HotkeyHandlers,
): string[] {
  unregisterHotkeys();

  const pairs: Array<[string, () => void]> = [
    [bindings.capture, handlers.onCapture],
    [bindings.chat, handlers.onChat],
    [bindings.history, handlers.onHistory],
    [bindings.settings, handlers.onSettings],
  ];

  for (const [accel, fn] of pairs) {
    const ok = globalShortcut.register(accel, fn);
    if (ok) {
      registered.push(accel);
      log.info({ accelerator: accel }, 'hotkey registered');
    } else {
      log.warn({ accelerator: accel }, 'hotkey registration failed (in use?)');
    }
  }

  return [...registered];
}

export function unregisterHotkeys(): void {
  if (registered.length === 0) return;
  globalShortcut.unregisterAll();
  log.info({ count: registered.length }, 'hotkeys unregistered');
  registered = [];
}
