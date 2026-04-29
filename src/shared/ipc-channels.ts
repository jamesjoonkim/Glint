/**
 * Typed IPC channel names. Imported by main, preload, and renderer.
 * Renderer can ONLY invoke channels listed here (preload allowlist).
 */
export const IPC = {
  // capture pipeline (P1)
  capture: {
    request: 'capture:request',
    cancel: 'capture:cancel',
    result: 'capture:result',
  },
  // model runtime (P1+)
  model: {
    port: 'model:port',
    health: 'model:health',
    stream: 'model:stream',
  },
  // history (P3+)
  history: {
    list: 'history:list',
    search: 'history:search',
    open: 'history:open',
  },
  // threads (P4+)
  thread: {
    get: 'thread:get',
    appendTurn: 'thread:appendTurn',
  },
  // settings (P5)
  settings: {
    open: 'settings:open',
    get: 'settings:get',
    set: 'settings:set',
  },
} as const;

export type IpcChannelName =
  (typeof IPC)[keyof typeof IPC][keyof (typeof IPC)[keyof typeof IPC]];
