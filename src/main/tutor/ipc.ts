import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels.js';
import { createLogger } from '../../core/logger/index.js';
import { listSessions } from './sessions.js';
import { openTutor, getTutorWindow, onTutorClosed } from '../windows/tutor.js';
import { tailSession, type TailHandle, type TurnKind } from './tail.js';
import { explainTurn } from './explain.js';
import { appendCalibBlock } from './calib.js';
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

function emitTurnStart(summary: TurnSummary, kind: TurnKind): void {
  pushToWindow('tutor:event', {
    kind: 'turn-start',
    historical: kind === 'history',
    turn: {
      turnIdx: summary.turnIdx,
      timestamp: summary.timestamp,
      userPrompt: summary.userPrompt,
      reasoning: summary.reasoning,
      tools: summary.tools.map((t) => ({ name: t.name, input: t.input })),
      diffs: summary.diffs,
    },
  });
}

async function pumpExplain(
  summary: TurnSummary,
  sessionUuid: string,
  cwd: string | null,
): Promise<void> {
  const ac = new AbortController();
  active?.abortControllers.add(ac);

  emitTurnStart(summary, 'live');

  let acc = '';
  try {
    for await (const tok of explainTurn(summary, cwd, ac.signal)) {
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

  await appendCalibBlock(summary, acc, sessionUuid);
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
    const handle = await tailSession(jsonlPath, (summary, kind) => {
      if (kind === 'history') {
        // Render the card for context — but skip explain. Mark as done
        // immediately so the renderer doesn't show a thinking spinner.
        emitTurnStart(summary, 'history');
        pushToWindow('tutor:explain:done', {
          turnIdx: summary.turnIdx,
          full: '',
          historical: true,
        });
        return;
      }
      // Live turn: chain onto the queue so MLX gets one request at a time.
      if (!active) return;
      active.queue = active.queue.then(() => pumpExplain(summary, sessionUuid, cwd));
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

  // Stop the active watch the moment the Lens window closes — no polling.
  onTutorClosed(() => {
    if (active) stopActive();
  });
}
