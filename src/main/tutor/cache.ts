/**
 * Persistent explanation cache. Keyed on (sessionUuid, turnId).
 *
 * Lives at ~/Library/Application Support/Glint/lens-cache/<uuid>.jsonl.
 * Append-only — when we re-explain a turn, a newer line overrides the
 * older one (read picks the last entry per turnId).
 *
 * Why a file, not memory: user opens Lens late, picks a session, expects
 * past explanations to still be there. Memory cache disappears on restart.
 *
 * Why not SQLite: schema + migrations + IPC plumbing is overkill for a
 * single append log. JSONL gives "delete file = clear cache" as a bonus.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../core/logger/index.js';

const log = createLogger('tutor:cache');

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Glint');
const CACHE_DIR = path.join(APP_SUPPORT, 'lens-cache');

interface CacheEntry {
  turnId: string;
  explanation: string;
  ts: string;
}

function pathFor(sessionUuid: string): string {
  const safe = sessionUuid.replace(/[^a-zA-Z0-9-]/g, '');
  return path.join(CACHE_DIR, `${safe}.jsonl`);
}

export async function getCache(sessionUuid: string): Promise<Map<string, string>> {
  const fp = pathFor(sessionUuid);
  const map = new Map<string, string>();
  let content: string;
  try {
    content = await fs.readFile(fp, 'utf8');
  } catch {
    return map;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CacheEntry;
      if (typeof entry.turnId === 'string' && typeof entry.explanation === 'string') {
        map.set(entry.turnId, entry.explanation);
      }
    } catch {
      // skip malformed
    }
  }
  return map;
}

export async function putCache(
  sessionUuid: string,
  turnId: string,
  explanation: string,
): Promise<void> {
  if (!explanation || explanation.trim().toUpperCase() === 'SKIP') return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = {
      turnId,
      explanation,
      ts: new Date().toISOString(),
    };
    await fs.appendFile(pathFor(sessionUuid), JSON.stringify(entry) + '\n');
  } catch (err) {
    log.warn({ err: String(err), sessionUuid, turnId }, 'cache put failed');
  }
}

export async function clearCacheFor(sessionUuid: string): Promise<void> {
  try {
    await fs.unlink(pathFor(sessionUuid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: String(err) }, 'cache clear failed');
    }
  }
}
