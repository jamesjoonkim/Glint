/**
 * Side-effect calibration log. Every explained turn (whose final text is
 * not "SKIP") gets appended as a labelable markdown block to
 * ~/cc-tutor-calib/<date>.md. Source of training examples for v0.2 gate.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../core/logger/index.js';
import type { TurnSummary } from './parseTurn.js';

const log = createLogger('tutor:calib');

const LOG_DIR = path.join(os.homedir(), 'cc-tutor-calib');

function trimLine(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function briefInput(name: string, input: Record<string, unknown>): string {
  const sval = (k: string): string =>
    typeof input[k] === 'string' ? (input[k] as string) : '';
  if (name === 'Bash') return trimLine(sval('command'), 60);
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'Read') {
    const fp = sval('file_path');
    return fp ? path.basename(fp) : '?';
  }
  if (name === 'Grep') return `'${trimLine(sval('pattern'), 30)}'`;
  if (name === 'Glob') return trimLine(sval('pattern'), 40);
  return '';
}

function renderBlock(
  s: TurnSummary,
  explanation: string,
  sessionUuid: string,
): string {
  const lines: string[] = [];
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  lines.push(`## Turn ${s.turnIdx}  ·  ${ts}  ·  session ${sessionUuid.slice(0, 8)}`, '');

  if (s.userPrompt) {
    lines.push(`**User asked:** ${trimLine(s.userPrompt.trim(), 300)}`, '');
  }

  if (s.tools.length > 0) {
    const toolSummary = s.tools
      .map((t) => `${t.name}(${briefInput(t.name, t.input)})`)
      .join(', ');
    lines.push(`**Tools:** ${toolSummary}`, '');
  }

  const reasoning = s.reasoning.trim();
  if (reasoning) {
    const excerpt = trimLine(reasoning, 600);
    lines.push('**Reasoning excerpt:**');
    lines.push('> ' + excerpt.replace(/\n/g, '\n> '));
    lines.push('');
  }

  for (const d of s.diffs) {
    lines.push(`**Diff in \`${d.file}\`:**`, '```diff');
    for (const ln of d.old.split('\n')) lines.push(`- ${ln}`);
    for (const ln of d.new.split('\n')) lines.push(`+ ${ln}`);
    lines.push('```', '');
  }

  lines.push('**Lens explanation:**');
  lines.push('> ' + explanation.trim().replace(/\n/g, '\n> '));
  lines.push('', '**Label:** [ ] TEACHABLE   [ ] SKIP   [ ] BORDERLINE', '', '---', '');
  return lines.join('\n');
}

export async function appendCalibBlock(
  s: TurnSummary,
  explanation: string,
  sessionUuid: string,
): Promise<void> {
  if (explanation.trim().toUpperCase() === 'SKIP') return;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(LOG_DIR, `${dateStr}.md`);
    const block = renderBlock(s, explanation, sessionUuid);
    await fs.appendFile(filePath, block);
  } catch (err) {
    log.warn({ err: String(err) }, 'calib append failed');
  }
}
