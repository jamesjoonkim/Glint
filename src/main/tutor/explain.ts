/**
 * Run the EXPLAIN prompt against the local MLX server with streaming.
 *
 * Reuses Glint's `streamCompletion` so we get the same fake-mode short-
 * circuit, abort plumbing, and SSE parser used by the rest of the app.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { streamCompletion, type ClientConfig } from '../../core/models/client.js';
import { createLogger } from '../../core/logger/index.js';
import { getActivePrompt } from './prompt_override.js';
import type { TurnSummary } from './parseTurn.js';

const log = createLogger('tutor:explain');

const TEXT_BASE = 'http://127.0.0.1:8765';
let cachedModel: string | null = null;

/** Cache CLAUDE.md per cwd so we don't re-read on every turn. */
const claudeMdCache = new Map<string, string | null>();
const CLAUDE_MD_MAX = 6_000;
const FILE_CONTEXT_MAX_LINES = 60;
const FILE_CONTEXT_MAX_BYTES = 8_000;

async function readClaudeMd(cwd: string): Promise<string | null> {
  if (claudeMdCache.has(cwd)) return claudeMdCache.get(cwd) ?? null;
  // Conventional locations: root first, then .claude/ subdir.
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '.claude', 'CLAUDE.md'),
  ];
  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, 'utf8');
      const trimmed =
        text.length > CLAUDE_MD_MAX
          ? text.slice(0, CLAUDE_MD_MAX) + '\n…(truncated)'
          : text;
      claudeMdCache.set(cwd, trimmed);
      return trimmed;
    } catch {
      // try next
    }
  }
  claudeMdCache.set(cwd, null);
  return null;
}

/**
 * Read up to N lines of a file. Used to give Qwen surrounding context
 * around an Edit — without this it sees only the old/new strings, which
 * isn't enough to reason about why this file matters in the codebase.
 */
async function readFileExcerpt(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length === 0) return null;
    const text = buf.toString('utf8');
    if (text.length <= FILE_CONTEXT_MAX_BYTES) return text;
    const lines = text.split('\n').slice(0, FILE_CONTEXT_MAX_LINES);
    return lines.join('\n') + '\n…(truncated)';
  } catch {
    return null;
  }
}

async function resolveModel(): Promise<string> {
  if (cachedModel) return cachedModel;
  const res = await fetch(`${TEXT_BASE}/v1/models`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`models lookup ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const id = data.data?.[0]?.id;
  if (!id) throw new Error('no model id in /v1/models');
  cachedModel = id;
  return id;
}

function trim(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export async function formatTurnForPrompt(
  s: TurnSummary,
  cwd: string | null,
): Promise<string> {
  const parts: string[] = [];

  // Codebase context — CLAUDE.md is the project's own self-description.
  // Tells Qwen "this is a TS Electron app", "Firebase rules go here", etc.
  if (cwd) {
    const md = await readClaudeMd(cwd);
    if (md) {
      parts.push(`PROJECT CONTEXT (CLAUDE.md):\n${md}`);
    }
  }

  if (s.userPrompt) parts.push(`USER ASKED:\n${trim(s.userPrompt, 500)}`);
  if (s.reasoning) parts.push(`REASONING:\n${trim(s.reasoning, 1500)}`);

  if (s.tools.length > 0) {
    const lines = s.tools.map((t) => {
      const inp = trim(JSON.stringify(t.input), 300);
      const head = `- ${t.name}(${inp})`;
      if (typeof t.result === 'string' && t.result.length > 0) {
        const tag = t.resultError ? 'ERROR' : 'RESULT';
        return `${head}\n  ${tag}: ${trim(t.result, 800).replace(/\n/g, '\n  ')}`;
      }
      return head;
    });
    parts.push(`TOOL CALLS + RESULTS:\n${lines.join('\n')}`);
  }

  if (s.diffs.length > 0) {
    // Read each touched file so Qwen sees what surrounds the edit.
    const blocks: string[] = [];
    for (const d of s.diffs) {
      const fileExcerpt = await readFileExcerpt(d.file);
      const blockParts = [
        `--- ${d.file}`,
        `OLD:\n${trim(d.old, 500)}`,
        `NEW:\n${trim(d.new, 500)}`,
      ];
      if (fileExcerpt) {
        blockParts.push(`CURRENT FILE CONTENT:\n${fileExcerpt}`);
      }
      blocks.push(blockParts.join('\n'));
    }
    parts.push(`DIFFS:\n${blocks.join('\n\n')}`);
  }

  return parts.join('\n\n');
}

export async function* explainTurn(
  summary: TurnSummary,
  cwd: string | null,
  signal?: AbortSignal,
): AsyncIterable<string> {
  let model: string;
  try {
    model = await resolveModel();
  } catch (err) {
    log.warn({ err: String(err) }, 'model resolve failed; falling back');
    yield `[mlx unavailable: ${String(err)}]`;
    return;
  }

  const cfg: ClientConfig = { baseUrl: TEXT_BASE };
  const [userMsg, systemPrompt] = await Promise.all([
    formatTurnForPrompt(summary, cwd),
    getActivePrompt(),
  ]);

  try {
    const stream = streamCompletion(
      cfg,
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 300,
        temperature: 0.4,
      },
      signal,
    );
    for await (const tok of stream) yield tok;
  } catch (err) {
    log.warn({ err: String(err) }, 'explain stream failed');
    yield `\n[explain error: ${String(err)}]`;
  }
}
