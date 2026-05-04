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
    attachImage: 'capture:attachImage',
  },
  // model runtime (P1+)
  model: {
    port: 'model:port',
    health: 'model:health',
    stream: 'model:stream',
    streamCancel: 'model:stream:cancel',
  },
  // history (P3+)
  history: {
    list: 'history:list',
    search: 'history:search',
    open: 'history:open',
    listChats: 'history:listChats',
    searchChats: 'history:searchChats',
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
    sendComposed: 'chat:sendComposed',
  },
  // settings (P5)
  settings: {
    open: 'settings:open',
    get: 'settings:get',
    set: 'settings:set',
  },
  // first-run wizard
  firstRun: {
    getStatus: 'firstRun:getStatus',
    start: 'firstRun:start',
    cancel: 'firstRun:cancel',
    retry: 'firstRun:retry',
    complete: 'firstRun:complete',
  },
  // tutor mode (CC session observer)
  tutor: {
    open: 'tutor:open',
    listSessions: 'tutor:list-sessions',
    watchSession: 'tutor:watch-session',
    stopWatching: 'tutor:stop-watching',
    listCalib: 'tutor:list-calib',
    labelBlock: 'tutor:label-block',
    getPrompt: 'tutor:get-prompt',
    setPrompt: 'tutor:set-prompt',
    resetPrompt: 'tutor:reset-prompt',
  },
} as const;

export type IpcChannelName =
  (typeof IPC)[keyof typeof IPC][keyof (typeof IPC)[keyof typeof IPC]];
