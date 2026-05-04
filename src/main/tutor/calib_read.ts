import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('tutor:calib-read');
const LOG_DIR = path.join(os.homedir(), 'cc-tutor-calib');

export type Label = 'TEACHABLE' | 'SKIP' | 'BORDERLINE' | null;

export interface CalibBlock {
  id: string;
  filePath: string;
  raw: string;
  header: string;
  body: string;
  label: Label;
}

export interface CalibFile {
  filePath: string;
  date: string;
  blocks: CalibBlock[];
}

function detectLabel(block: string): Label {
  const line = /\*\*Label:\*\*\s*(.*)/.exec(block)?.[1] ?? '';
  if (/\[x\]\s*TEACHABLE/i.test(line)) return 'TEACHABLE';
  if (/\[x\]\s*SKIP/i.test(line)) return 'SKIP';
  if (/\[x\]\s*BORDERLINE/i.test(line)) return 'BORDERLINE';
  return null;
}

function parseBlocks(filePath: string, content: string): CalibBlock[] {
  const blocks: CalibBlock[] = [];
  const parts = content.split(/\n---\s*\n/);
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const headerMatch = /^## (Turn\s+\d+.*)/m.exec(trimmed);
    if (!headerMatch) continue;
    const header = headerMatch[1] ?? '';
    blocks.push({
      id: header,
      filePath,
      raw: trimmed,
      header,
      body: trimmed.replace(/^## .*\n/, '').trim(),
      label: detectLabel(trimmed),
    });
  }
  return blocks;
}

export async function listCalibFiles(): Promise<CalibFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(LOG_DIR);
  } catch {
    return [];
  }
  const out: CalibFile[] = [];
  for (const name of entries.sort().reverse()) {
    if (!name.endsWith('.md')) continue;
    const fp = path.join(LOG_DIR, name);
    try {
      const content = await fs.readFile(fp, 'utf8');
      out.push({
        filePath: fp,
        date: name.replace(/\.md$/, ''),
        blocks: parseBlocks(fp, content),
      });
    } catch (err) {
      log.warn({ err: String(err), fp }, 'calib file unreadable');
    }
  }
  return out;
}

export async function setBlockLabel(
  filePath: string,
  blockId: string,
  label: Label,
): Promise<{ ok: boolean; error?: string }> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  const newLabelLine =
    '**Label:** ' +
    `[${label === 'TEACHABLE' ? 'x' : ' '}] TEACHABLE   ` +
    `[${label === 'SKIP' ? 'x' : ' '}] SKIP   ` +
    `[${label === 'BORDERLINE' ? 'x' : ' '}] BORDERLINE`;
  const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `(## ${escaped}[\\s\\S]*?)\\*\\*Label:\\*\\*[^\\n]*`,
  );
  const replaced = content.replace(blockRe, `$1${newLabelLine}`);
  if (replaced === content) {
    return { ok: false, error: 'block not found' };
  }
  try {
    await fs.writeFile(filePath, replaced);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
