import { systemPreferences, shell, dialog } from 'electron';
import { createLogger } from '../core/logger/index.js';

const log = createLogger('permissions');

const SCREEN_REC_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export type ScreenAccess = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export function getScreenAccess(): ScreenAccess {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen') as ScreenAccess;
}

/**
 * Ensure the user has granted Screen Recording. If not, surface a modal with
 * a "Open System Settings" deep-link. macOS will not re-prompt automatically
 * — the user must enable manually, then quit/relaunch Glint.
 */
export async function ensureScreenRecording(): Promise<{ granted: boolean }> {
  const status = getScreenAccess();
  log.info({ status }, 'screen recording access check');

  if (status === 'granted') return { granted: true };

  const choice = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Screen Recording permission required',
    message: 'Glint captures portions of your screen on demand.',
    detail:
      'macOS requires explicit permission for screen capture. Please enable Glint in System Settings → Privacy & Security → Screen Recording, then quit and relaunch Glint.',
  });

  if (choice.response === 0) {
    void shell.openExternal(SCREEN_REC_DEEP_LINK);
  }
  return { granted: false };
}
