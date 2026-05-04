/**
 * JSONL → structured "turn" model.
 *
 * A CC turn is one user prompt → assistant chain (text + tool_use blocks)
 * → matching tool_results. Boundary markers are user events whose content
 * is a real prompt (not a wrapped tool_result).
 *
 * Ports the logic from cc-tutor/parse_turn.py to TS so the pipeline stays
 * in-process with Glint's main.
 */

export interface RawEvent {
  type?: string;
  message?: { content?: unknown };
  isSidechain?: boolean;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  // CC adds plenty of other fields — we only depend on the above.
}

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  /** id used to pair with the matching tool_result block. */
  id?: string;
  /** matching tool_result content if found, truncated. null if no result. */
  result?: string | null;
  /** true if the tool_result reported is_error. */
  resultError?: boolean;
}

export interface DiffBlock {
  file: string;
  old: string;
  new: string;
}

export interface TurnSummary {
  turnIdx: number;
  timestamp: string;
  userPrompt: string;
  reasoning: string;
  tools: ToolUse[];
  diffs: DiffBlock[];
  isSidechain: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * True when a `user`-typed event is actually wrapping a tool_result (these
 * are NOT turn boundaries).
 */
function isToolResultUser(ev: RawEvent): boolean {
  const c = ev.message?.content;
  if (!Array.isArray(c)) return false;
  for (const block of c) {
    if (isRecord(block) && block['type'] === 'tool_result') return true;
  }
  return false;
}

function userPromptText(ev: RawEvent): string {
  const c = ev.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => isRecord(b) && b['type'] === 'text')
      .map((b) => getString((b as Record<string, unknown>)['text']))
      .join('\n');
  }
  return '';
}

/**
 * Walk events and group into turns. A "turn" runs from a user prompt
 * (not a tool_result) up to (but not including) the next user prompt.
 */
export function groupTurns(events: RawEvent[]): RawEvent[][] {
  const turns: RawEvent[][] = [];
  let current: RawEvent[] = [];

  for (const ev of events) {
    const isPromptBoundary =
      ev.type === 'user' && !isToolResultUser(ev);
    if (isPromptBoundary) {
      if (current.length > 0) turns.push(current);
      current = [ev];
    } else if (
      ev.type === 'user' ||
      ev.type === 'assistant' ||
      ev.type === 'attachment'
    ) {
      current.push(ev);
    }
    // skip other meta types (last-prompt, permission-mode, summary)
  }

  if (current.length > 0) turns.push(current);
  return turns;
}

const TOOL_RESULT_MAX = 1200;

function extractToolResultText(block: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  const isError = block['is_error'] === true;
  const content = block['content'];
  if (typeof content === 'string') return { text: content, isError };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (isRecord(c) && c['type'] === 'text') {
        parts.push(getString(c['text']));
      }
    }
    return { text: parts.join('\n'), isError };
  }
  return { text: '', isError };
}

export function summarizeTurn(turn: RawEvent[], turnIdx: number): TurnSummary {
  let userPrompt = '';
  const reasoningChunks: string[] = [];
  const tools: ToolUse[] = [];
  const diffs: DiffBlock[] = [];
  let timestamp = '';
  let isSidechain = false;

  // First pass: collect tool_use blocks AND build an id→result map from
  // the tool_result events that appear later in the turn.
  const resultsById = new Map<string, { text: string; isError: boolean }>();
  for (const ev of turn) {
    if (ev.type === 'user' && isToolResultUser(ev) && isRecord(ev.message)) {
      const content = ev.message['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block['type'] === 'tool_result') {
            const id = getString(block['tool_use_id']);
            if (id) resultsById.set(id, extractToolResultText(block));
          }
        }
      }
    }
  }

  for (const ev of turn) {
    if (ev.timestamp && !timestamp) timestamp = ev.timestamp;
    if (ev.isSidechain === true) isSidechain = true;

    if (ev.type === 'user' && !isToolResultUser(ev) && !userPrompt) {
      userPrompt = userPromptText(ev);
    }

    if (ev.type === 'assistant' && isRecord(ev.message)) {
      const content = ev.message['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          const bt = block['type'];
          if (bt === 'text') {
            reasoningChunks.push(getString(block['text']));
          } else if (bt === 'tool_use') {
            const name = getString(block['name']) || '?';
            const id = getString(block['id']) || undefined;
            const input = isRecord(block['input']) ? block['input'] : {};
            const matched = id ? resultsById.get(id) : undefined;
            const tool: ToolUse = { name, input, id };
            if (matched) {
              const trimmed =
                matched.text.length > TOOL_RESULT_MAX
                  ? matched.text.slice(0, TOOL_RESULT_MAX) + '\n…(truncated)'
                  : matched.text;
              tool.result = trimmed;
              tool.resultError = matched.isError;
            } else {
              tool.result = null;
            }
            tools.push(tool);
            if (name === 'Edit') {
              diffs.push({
                file: getString(input['file_path']),
                old: getString(input['old_string']),
                new: getString(input['new_string']),
              });
            } else if (name === 'Write') {
              diffs.push({
                file: getString(input['file_path']),
                old: '',
                new: getString(input['content']),
              });
            }
          }
        }
      }
    }
  }

  return {
    turnIdx,
    timestamp,
    userPrompt: userPrompt.slice(0, 1000),
    reasoning: reasoningChunks.join('\n'),
    tools,
    diffs,
    isSidechain,
  };
}

/**
 * Parse a chunk of newline-delimited JSON. Returns successfully parsed
 * events plus the leftover (incomplete final line) for the caller to
 * carry into the next chunk.
 */
export function parseChunk(chunk: string): { events: RawEvent[]; leftover: string } {
  const events: RawEvent[] = [];
  const lines = chunk.split('\n');
  const leftover = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as RawEvent);
    } catch {
      // skip malformed (rare; usually a partial write race we'll re-read)
    }
  }
  return { events, leftover };
}
