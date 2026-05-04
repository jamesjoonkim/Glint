/**
 * Load all code-action turns from a JSONL transcript. Used by F7
 * (explain-past) when the user clicks "explain this turn" or runs the
 * bulk "explain last N unexplained" action — we need the full turn
 * payload again, but tail.ts only emits live + last-N history.
 */
import { promises as fs } from 'node:fs';
import { groupTurns, parseChunk, summarizeTurn, type TurnSummary } from './parseTurn.js';

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

function hasCodeAction(s: TurnSummary): boolean {
  return s.tools.some((t) => CODE_ACTION_TOOLS.has(t.name));
}

export async function loadAllCodeActionTurns(jsonlPath: string): Promise<TurnSummary[]> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf8');
  } catch {
    return [];
  }
  const parsed = parseChunk(content + '\n');
  const turns = groupTurns(parsed.events);
  const out: TurnSummary[] = [];
  let counter = 0;
  for (const t of turns) {
    counter += 1;
    const summary = summarizeTurn(t, counter);
    if (summary.isSidechain) continue;
    if (!hasCodeAction(summary)) continue;
    out.push(summary);
  }
  return out;
}

/**
 * Load up to N turns immediately preceding the given `currentTurnId`.
 * Used as session-context input to the explain prompt so Qwen sees the
 * trajectory (what the user has been working on, recent decisions,
 * files already touched).
 */
export async function loadPrecedingTurns(
  jsonlPath: string,
  currentTurnId: string,
  n: number,
): Promise<TurnSummary[]> {
  const all = await loadAllCodeActionTurns(jsonlPath);
  const idx = all.findIndex((t) => t.turnId === currentTurnId);
  if (idx < 0) return [];
  return all.slice(Math.max(0, idx - n), idx);
}
