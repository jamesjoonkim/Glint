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
    openForThread: 'capture:openForThread',
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
    listChats: 'history:listChats',
    openThread: 'history:openThread',
  },
  // threads (P4+)
  thread: {
    get: 'thread:get',
    getCapture: 'thread:getCapture',
    appendTurn: 'thread:appendTurn',
    getTurns: 'thread:getTurns',
  },
  // direct-chat (no capture)
  chat: {
    start: 'chat:start',
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
