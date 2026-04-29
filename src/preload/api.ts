import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels.js';

/**
 * Allowlist of IPC channels the renderer is permitted to invoke.
 * Renderer attempts to invoke any other channel name → throw.
 */
const ALLOWED = new Set<string>(
  Object.values(IPC).flatMap((group) => Object.values(group)),
);

const api = Object.freeze({
  ping: (): Promise<'pong'> => ipcRenderer.invoke('ping'),
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!ALLOWED.has(channel)) {
      throw new Error(`ipc channel not allowed: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },
});

contextBridge.exposeInMainWorld('glint', api);

export type GlintApi = typeof api;
