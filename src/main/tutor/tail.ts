/**
 * Tail a Claude Code JSONL transcript and emit each completed turn.
 *
 * Strategy:
 *   - Track read offset. On every fs.watch event, read from offset → EOF.
 *   - Append to a leftover buffer (handles writes that split mid-line).
 *   - Parse newline-delimited events.
 *   - Buffer events into the current turn.
 *   - A turn is "complete" when the NEXT user-prompt event arrives (so we
 *     emit the previous turn) OR after a debounce of N seconds with no new
 *     events (so the live in-progress turn finishes once Claude stops).
 */
import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs';
import { createLogger } from '../../core/logger/index.js';
import { groupTurns, parseChunk, summarizeTurn, type RawEvent, type TurnSummary } from './parseTurn.js';

const log = createLogger('tutor:tail');
const DEBOUNCE_MS = 2_500;
const HISTORY_TURN_COUNT = 5;
const HISTORY_READ_BYTES = 512 * 1024;

/**
 * Tools that constitute a "code action" worth surfacing. Pure-conversation
 * turns (no tool use) and noise-only turns (TodoWrite, Read-only) get
 * filtered out — the user is already aware of those because they wrote
 * the prompt; Lens is for what Claude DID with the codebase.
 */
const CODE_ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Grep',
  'Glob',
  'Task',
  'WebFetch',
  'WebSearch',
]);

function hasCodeAction(tools: { name: string }[]): boolean {
  return tools.some((t) => CODE_ACTION_TOOLS.has(t.name));
}

export type TurnKind = 'history' | 'live';

export interface TailHandle {
  close: () => void;
}

/**
 * Begin tailing `jsonlPath`. Calls `onTurn(summary, kind)` per turn.
 *
 *   kind='history' fires once at start for the last N completed turns.
 *                  Caller should render context but NOT run explain (those
 *                  already happened — explaining them retroactively would
 *                  jam the MLX queue and isn't useful).
 *   kind='live'    fires for every turn observed after start.
 */
export async function tailSession(
  jsonlPath: string,
  onTurn: (summary: TurnSummary, kind: TurnKind) => void,
): Promise<TailHandle> {
  let offset = 0;
  let leftover = '';
  let pending: RawEvent[] = [];
  let turnCounter = 0;
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function clearDebounce(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function flushPending(reason: 'boundary' | 'debounce'): void {
    if (pending.length === 0) return;
    const turns = groupTurns(pending);
    pending = [];

    // For 'boundary' flush we keep the LAST turn (the new prompt that
    // triggered the boundary) — it goes back into pending. For 'debounce'
    // we emit everything (no new prompt is coming).
    const emitAll = reason === 'debounce';
    const emitCount = emitAll ? turns.length : Math.max(0, turns.length - 1);

    for (let i = 0; i < emitCount; i++) {
      const t = turns[i];
      if (!t) continue;
      turnCounter += 1;
      const summary = summarizeTurn(t, turnCounter);
      if (summary.isSidechain) continue;
      if (!hasCodeAction(summary.tools)) continue; // skip pure conversation
      try {
        onTurn(summary, 'live');
      } catch (err) {
        log.warn({ err: String(err) }, 'onTurn handler threw');
      }
    }

    if (!emitAll) {
      const carry = turns[turns.length - 1];
      if (carry) pending = carry;
    }
  }

  function scheduleDebounce(): void {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      flushPending('debounce');
    }, DEBOUNCE_MS);
  }

  async function readNew(): Promise<void> {
    if (closed) return;
    let handle;
    try {
      handle = await fs.open(jsonlPath, 'r');
      const stat = await handle.stat();
      if (stat.size < offset) {
        // file truncated/rotated — restart
        offset = 0;
        leftover = '';
        pending = [];
      }
      if (stat.size === offset) return;
      const len = stat.size - offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, offset);
      offset += bytesRead;
      const chunk = leftover + buf.subarray(0, bytesRead).toString('utf8');
      const parsed = parseChunk(chunk);
      leftover = parsed.leftover;

      // Append events — and check for boundary as we add them.
      for (const ev of parsed.events) {
        pending.push(ev);
        // Boundary detection: if THIS event is a real user prompt and
        // there's preceding content, flush.
        if (ev.type === 'user' && !isToolResultUser(ev) && pending.length > 1) {
          flushPending('boundary');
        }
      }
      scheduleDebounce();
    } catch (err) {
      log.warn({ err: String(err), path: jsonlPath }, 'tail read failed');
    } finally {
      await handle?.close();
    }
  }

  // Bounded historical replay: emit the last N turns as context cards
  // (kind='history'), then advance the offset to EOF so live watching
  // only sees genuinely new content. We don't explain historical turns —
  // they already happened, and queueing them up would jam the MLX server
  // before any live turn could get explained.
  try {
    let handle = await fs.open(jsonlPath, 'r');
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - HISTORY_READ_BYTES);
    const len = stat.size - start;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      let text = buf.toString('utf8');
      // Drop a partial first line if we mid-read.
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      const parsed = parseChunk(text + '\n');
      const turns = groupTurns(parsed.events);
      // Filter to code-action turns first so we get LAST N useful turns,
      // not N random turns that might all be conversation.
      const useful = turns
        .map((t) => summarizeTurn(t, ++turnCounter))
        .filter((s) => !s.isSidechain && hasCodeAction(s.tools));
      for (const summary of useful.slice(-HISTORY_TURN_COUNT)) {
        try {
          onTurn(summary, 'history');
        } catch (err) {
          log.warn({ err: String(err) }, 'history onTurn handler threw');
        }
      }
    }
    offset = stat.size;
    await handle.close();
  } catch (err) {
    log.warn({ err: String(err), jsonlPath }, 'history replay failed');
  }

  watcher = fsWatch(jsonlPath, () => {
    void readNew();
  });
  watcher.on('error', (err) => {
    log.warn({ err: String(err) }, 'fs.watch error');
  });

  log.info({ jsonlPath }, 'tail started');

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearDebounce();
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      flushPending('debounce');
      log.info({ jsonlPath }, 'tail closed');
    },
  };
}

// Inlined helper — keeping isToolResultUser local to tail.ts so it can use
// the same shape as parseTurn without circular import issues.
function isToolResultUser(ev: RawEvent): boolean {
  const c = ev.message?.content;
  if (!Array.isArray(c)) return false;
  for (const block of c) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>)['type'] === 'tool_result'
    ) {
      return true;
    }
  }
  return false;
}
