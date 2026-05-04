import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('tutor:sessions');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const CWD_PROBE_LINES = 30;

export interface Session {
  jsonlPath: string;
  cwd: string;
  primary: string;
  secondary?: string;
  sessionUuid: string;
  mtimeMs: number;
  sizeBytes: number;
  active: boolean;
}

async function readCwdFromJsonl(jsonlPath: string): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(jsonlPath, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n').slice(0, CWD_PROBE_LINES);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { cwd?: unknown };
        if (typeof ev.cwd === 'string' && ev.cwd.length > 0) return ev.cwd;
      } catch {
        // partial last line or malformed - skip
      }
    }
    return null;
  } catch (err) {
    log.warn({ jsonlPath, err: String(err) }, 'cwd probe failed');
    return null;
  } finally {
    await handle?.close();
  }
}

function decodeCwdFallback(encoded: string): string {
  return encoded.replace(/-/g, '/');
}

export function deriveDisplayName(cwd: string): { primary: string; secondary?: string } {
  const home = os.homedir();
  let p = cwd;
  if (p === home) return { primary: '~' };
  if (p.startsWith(home + '/')) p = p.slice(home.length + 1);
  else if (p.startsWith('/')) p = p.slice(1);

  if (!p) return { primary: '~' };

  const gh = /^Documents\/GitHub\/([^/]+)(?:\/(.+))?$/.exec(p);
  if (gh) {
    const repo = gh[1];
    if (!repo) return { primary: p };
    const rest = (gh[2] ?? '').replace(/^\.claude\//, '');
    return rest ? { primary: repo, secondary: rest } : { primary: repo };
  }

  const dot = /^\.([^/]+)(?:\/(.+))?$/.exec(p);
  if (dot) {
    const root = dot[1];
    if (!root) return { primary: p };
    const rest = dot[2];
    return rest ? { primary: root, secondary: rest } : { primary: root };
  }

  const parts = p.split('/').filter(Boolean);
  if (parts.length === 0) return { primary: '~' };
  if (parts.length === 1) return { primary: parts[0] ?? p };
  const last = parts[parts.length - 1];
  const parent = parts.slice(0, -1).join('/');
  return last ? { primary: last, secondary: parent } : { primary: p };
}

export async function listSessions(): Promise<Session[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROJECTS_DIR);
  } catch (err) {
    log.warn({ err: String(err), dir: PROJECTS_DIR }, 'projects dir unreadable');
    return [];
  }

  const now = Date.now();
  const out: Session[] = [];

  for (const dirName of entries) {
    if (!dirName.startsWith('-')) continue;

    const projectDir = path.join(PROJECTS_DIR, dirName);
    let files: string[];
    try {
      files = await fs.readdir(projectDir);
    } catch {
      continue;
    }

    const jsonls = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonls.length === 0) continue;

    let best: { name: string; mtime: number; size: number } | null = null;
    for (const j of jsonls) {
      try {
        const st = await fs.stat(path.join(projectDir, j));
        if (!best || st.mtimeMs > best.mtime) {
          best = { name: j, mtime: st.mtimeMs, size: st.size };
        }
      } catch {
        continue;
      }
    }
    if (!best) continue;

    const jsonlPath = path.join(projectDir, best.name);
    const cwdFromFile = await readCwdFromJsonl(jsonlPath);
    const cwd = cwdFromFile ?? decodeCwdFallback(dirName);
    const display = deriveDisplayName(cwd);

    out.push({
      jsonlPath,
      cwd,
      primary: display.primary,
      secondary: display.secondary,
      sessionUuid: best.name.replace(/\.jsonl$/, ''),
      mtimeMs: best.mtime,
      sizeBytes: best.size,
      active: now - best.mtime < ACTIVE_WINDOW_MS,
    });
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
