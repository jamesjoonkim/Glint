import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels.js';

const ALLOWED = new Set<string>(
  Object.values(IPC).flatMap((group) => Object.values(group)),
);

// Renderer-side push channels (main → renderer). Allowlisted separately
// so subscribe() can't be used to spy on arbitrary IPC traffic.
const PUSH_CHANNELS = new Set<string>([
  'model:stream:token',
  'model:stream:done',
  'model:stream:error',
  'model:tool:web-search',
  'response:set-stream',
  'response:set-thread',
  'response:replay',
  'firstRun:progress',
  'firstRun:done',
  'firstRun:error',
]);

const api = Object.freeze({
  ping: (): Promise<'pong'> => ipcRenderer.invoke('ping'),

  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!ALLOWED.has(channel)) {
      throw new Error(`ipc channel not allowed: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  subscribe: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): (() => void) => {
    if (!PUSH_CHANNELS.has(channel)) {
      throw new Error(`push channel not allowed: ${channel}`);
    }
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

contextBridge.exposeInMainWorld('glint', api);

export type GlintApi = typeof api;
