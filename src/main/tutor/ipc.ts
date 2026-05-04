import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels.js';
import { createLogger } from '../../core/logger/index.js';
import { listSessions } from './sessions.js';
import { openTutor, getTutorWindow, onTutorClosed } from '../windows/tutor.js';
import { tailSession, type TailHandle, type TurnKind } from './tail.js';
import { explainTurn } from './explain.js';
import { appendCalibBlock } from './calib.js';
import { listCalibFiles, setBlockLabel, type Label } from './calib_read.js';
import { getPromptOverride, setPromptOverride, clearPromptOverride } from './prompt_override.js';
import { detectMess, type MessFlag } from './mess.js';
import { getCache, putCache } from './cache.js';
import { loadAllCodeActionTurns, loadPrecedingTurns } from './loadTurns.js';
import { promises as fs } from 'node:fs';
import type { TurnSummary } from './parseTurn.js';

const log = createLogger('tutor:ipc');

interface ActiveWatch {
  jsonlPath: string;
  sessionUuid: string;
  /** cwd of the watched session — passed to explain.ts so it can load
   *  CLAUDE.md and read edited files for codebase context. */
  cwd: string | null;
  tail: TailHandle;
  abortControllers: Set<AbortController>;
  /** Serial queue. New explain calls chain after the previous one so MLX
   *  never receives concurrent requests (single-GPU server can't handle
   *  parallel streams; subsequent ones hang). */
  queue: Promise<void>;
}

let active: ActiveWatch | null = null;

function uuidFromJsonl(jsonlPath: string): string {
  const m = /([0-9a-f-]+)\.jsonl$/.exec(jsonlPath);
  return m?.[1] ?? '?';
}

function pushToWindow(channel: string, payload: unknown): void {
  const win = getTutorWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

async function readFileContents(s: TurnSummary): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const d of s.diffs) {
    if (!d.file || map.has(d.file)) continue;
    try {
      const text = await fs.readFile(d.file, 'utf8');
      map.set(d.file, text);
    } catch {
      // file may not exist (deleted) — skip
    }
  }
  return map;
}

function emitTurnStart(
  summary: TurnSummary,
  kind: TurnKind,
  mess: MessFlag[] = [],
): void {
  pushToWindow('tutor:event', {
    kind: 'turn-start',
    historical: kind === 'history',
    turn: {
      turnIdx: summary.turnIdx,
      timestamp: summary.timestamp,
      userPrompt: summary.userPrompt,
      reasoning: summary.reasoning,
      tools: summary.tools.map((t) => ({
        name: t.name,
        input: t.input,
        id: t.id,
        result: t.result,
        resultError: t.resultError,
      })),
      diffs: summary.diffs,
      mess,
    },
  });
}

async function pumpExplain(
  summary: TurnSummary,
  sessionUuid: string,
  cwd: string | null,
  jsonlPath: string,
): Promise<void> {
  const ac = new AbortController();
  active?.abortControllers.add(ac);

  // Mess detection runs first so chips render before MLX takes its time.
  const fileContents = await readFileContents(summary);
  const mess = detectMess(summary, fileContents);
  emitTurnStart(summary, 'live', mess);

  // Session trajectory: load up to 30 preceding turns. Loaded fresh per
  // call so live and re-explain both see current state. Cheap (~50ms
  // for a 5MB JSONL).
  const preceding = await loadPrecedingTurns(jsonlPath, summary.turnId, 30);

  let acc = '';
  try {
    for await (const tok of explainTurn(summary, cwd, preceding, ac.signal)) {
      if (ac.signal.aborted) break;
      acc += tok;
      pushToWindow('tutor:explain:chunk', {
        turnIdx: summary.turnIdx,
        chunk: tok,
      });
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'explain pump failed');
  } finally {
    active?.abortControllers.delete(ac);
  }

  pushToWindow('tutor:explain:done', {
    turnIdx: summary.turnIdx,
    full: acc,
  });

  // Persist BOTH: human-labelable markdown calibration log + machine
  // cache for replay. Calib skips SKIP responses. Cache also skips SKIP.
  await Promise.all([
    appendCalibBlock(summary, acc, sessionUuid),
    putCache(sessionUuid, summary.turnId, acc),
  ]);
}

function stopActive(): void {
  if (!active) return;
  for (const ac of active.abortControllers) {
    try { ac.abort(); } catch { /* ignore */ }
  }
  active.abortControllers.clear();
  try { active.tail.close(); } catch { /* ignore */ }
  active = null;
}

export function registerTutorIpc(): void {
  ipcMain.handle(IPC.tutor.open, (_e, payload?: { jsonlPath?: string }) => {
    openTutor(payload?.jsonlPath);
    return { ok: true };
  });

  ipcMain.handle(IPC.tutor.listSessions, async () => {
    return await listSessions();
  });

  ipcMain.handle(IPC.tutor.watchSession, async (_e, payload?: { jsonlPath?: unknown; cwd?: unknown }) => {
    const jsonlPath = typeof payload?.jsonlPath === 'string' ? payload.jsonlPath : null;
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
    if (!jsonlPath) return { ok: false, error: 'missing jsonlPath' };

    stopActive();

    const sessionUuid = uuidFromJsonl(jsonlPath);
    const cache = await getCache(sessionUuid);
    const handle = await tailSession(jsonlPath, (summary, kind) => {
      if (kind === 'history') {
        const cached = cache.get(summary.turnId) ?? '';
        emitTurnStart(summary, 'history', []);
        pushToWindow('tutor:explain:done', {
          turnIdx: summary.turnIdx,
          turnId: summary.turnId,
          full: cached,
          historical: true,
          fromCache: cached.length > 0,
        });
        return;
      }
      if (!active) return;
      active.queue = active.queue.then(() => pumpExplain(summary, sessionUuid, cwd, jsonlPath));
    });

    active = {
      jsonlPath,
      sessionUuid,
      cwd,
      tail: handle,
      abortControllers: new Set(),
      queue: Promise.resolve(),
    };

    log.info({ jsonlPath, sessionUuid }, 'watch started');
    return { ok: true };
  });

  ipcMain.handle(IPC.tutor.stopWatching, () => {
    stopActive();
    return { ok: true };
  });

  ipcMain.handle(IPC.tutor.listCalib, async () => {
    return await listCalibFiles();
  });

  ipcMain.handle(IPC.tutor.labelBlock, async (_e, payload?: {
    filePath?: unknown;
    blockId?: unknown;
    label?: unknown;
  }) => {
    const filePath = typeof payload?.filePath === 'string' ? payload.filePath : null;
    const blockId = typeof payload?.blockId === 'string' ? payload.blockId : null;
    const label = (
      payload?.label === 'TEACHABLE' ||
      payload?.label === 'SKIP' ||
      payload?.label === 'BORDERLINE' ||
      payload?.label === null
    ) ? (payload.label as Label) : null;
    if (!filePath || !blockId) return { ok: false, error: 'missing args' };
    return await setBlockLabel(filePath, blockId, label);
  });

  ipcMain.handle(IPC.tutor.getPrompt, async () => {
    return await getPromptOverride();
  });

  ipcMain.handle(IPC.tutor.setPrompt, async (_e, payload?: { text?: unknown }) => {
    const text = typeof payload?.text === 'string' ? payload.text : null;
    if (text === null) return { ok: false, error: 'missing text' };
    return await setPromptOverride(text);
  });

  ipcMain.handle(IPC.tutor.resetPrompt, async () => {
    return await clearPromptOverride();
  });

  ipcMain.handle(IPC.tutor.explainPastTurn, async (_e, payload?: {
    turnId?: unknown;
  }) => {
    if (!active) return { ok: false, error: 'no active session' };
    const turnId = typeof payload?.turnId === 'string' ? payload.turnId : null;
    if (!turnId) return { ok: false, error: 'missing turnId' };

    const all = await loadAllCodeActionTurns(active.jsonlPath);
    const summary = all.find((t) => t.turnId === turnId);
    if (!summary) return { ok: false, error: 'turn not found' };

    const cwd = active.cwd;
    const sessionUuid = active.sessionUuid;
    const jsonlPath = active.jsonlPath;
    if (!active) return { ok: false, error: 'session went away' };
    active.queue = active.queue.then(() => pumpExplain(summary, sessionUuid, cwd, jsonlPath));
    return { ok: true };
  });

  ipcMain.handle(IPC.tutor.explainBulk, async (_e, payload?: {
    count?: unknown;
  }) => {
    if (!active) return { ok: false, error: 'no active session' };
    const count = typeof payload?.count === 'number' && payload.count > 0
      ? Math.min(50, Math.floor(payload.count))
      : 10;

    const all = await loadAllCodeActionTurns(active.jsonlPath);
    const cache = await getCache(active.sessionUuid);
    // Take last N unexplained
    const unexplained = all
      .filter((t) => !cache.has(t.turnId))
      .slice(-count);

    if (unexplained.length === 0) {
      return { ok: true, queued: 0 };
    }

    const cwd = active.cwd;
    const sessionUuid = active.sessionUuid;
    const jsonlPath = active.jsonlPath;
    const a = active;
    for (const summary of unexplained) {
      a.queue = a.queue.then(() => pumpExplain(summary, sessionUuid, cwd, jsonlPath));
    }
    return { ok: true, queued: unexplained.length };
  });

  // Stop the active watch the moment the Lens window closes — no polling.
  onTutorClosed(() => {
    if (active) stopActive();
  });
}
