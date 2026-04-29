/**
 * Window-attached API exposed by preload via contextBridge.
 * Keep in sync with src/preload/api.ts.
 */
interface GlintWindowApi {
  ping: () => Promise<'pong'>;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

interface Window {
  glint?: GlintWindowApi;
}
