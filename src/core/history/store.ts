import Database, { type Database as DB } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger/index.js';
import { applyMigrations } from './migrations.js';
import type { ModelRoute, Tag } from '../../shared/types.js';

const log = createLogger('history:store');

export type CaptureRow = {
  id: string;
  created_at: number;
  png_path: string;
  thumb_path: string | null;
  ocr_text: string | null;
  ocr_conf: number | null;
  text_density: number | null;
  route: ModelRoute;
  tags: string | null; // json string
  thread_id: string;
  embed_pending: number;
};

export type ThreadRow = {
  id: string;
  created_at: number;
  title: string | null;
  pinned: number;
};

export type TurnRow = {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  model: string | null;
};

let db: DB | null = null;

export type OpenStoreOptions = {
  /**
   * Absolute path to the better_sqlite3.node binding. When omitted,
   * better-sqlite3's bundled `bindings`-style resolver walks up from the
   * module dir and CAN drift out of the .app into the project's node_modules
   * on dev machines that have both source + packaged installs. Always pass
   * this from main/index.ts so the binding is pinned to the build we
   * shipped (or to the dev binding in non-packaged runs).
   */
  nativeBinding?: string;
};

export async function openStore(
  dbPath: string,
  opts: OpenStoreOptions = {},
): Promise<DB> {
  if (db) return db;
  db = new Database(dbPath, opts.nativeBinding ? { nativeBinding: opts.nativeBinding } : {});
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const res = await applyMigrations(db);
  log.info(
    { dbPath, version: res.current, applied: res.applied, nativeBinding: opts.nativeBinding ?? '<auto>' },
    'store opened',
  );
  return db;
}

export function closeStore(): void {
  if (!db) return;
  db.close();
  db = null;
}

export function getDb(): DB {
  if (!db) throw new Error('store not opened; call openStore first');
  return db;
}

// ---- writes ----

export type CreateCaptureInput = {
  pngPath: string;
  ocrText: string;
  ocrConfidence: number;
  textDensity: number;
  route: ModelRoute;
  thumbPath?: string | null;
  tags?: Tag[];
  threadId?: string; // if omitted, a new thread is created
  threadTitle?: string;
};

export function createCaptureWithThread(input: CreateCaptureInput): {
  capture: CaptureRow;
  thread: ThreadRow;
} {
  const d = getDb();
  const now = Date.now();
  const threadId = input.threadId ?? randomUUID();
  const captureId = randomUUID();

  const tx = d.transaction(() => {
    if (!input.threadId) {
      d.prepare(
        `INSERT INTO threads(id, created_at, title, pinned) VALUES (?, ?, ?, 0)`,
      ).run(threadId, now, input.threadTitle ?? null);
    }

    d.prepare(
      `INSERT INTO captures(
        id, created_at, png_path, thumb_path, ocr_text, ocr_conf, text_density,
        route, tags, thread_id, embed_pending
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      captureId,
      now,
      input.pngPath,
      input.thumbPath ?? null,
      input.ocrText,
      input.ocrConfidence,
      input.textDensity,
      input.route,
      input.tags ? JSON.stringify(input.tags) : null,
      threadId,
    );
  });
  tx();

  const capture = d
    .prepare<unknown[], CaptureRow>(`SELECT * FROM captures WHERE id = ? `)
    .get(captureId) as CaptureRow;
  const thread = d
    .prepare<unknown[], ThreadRow>(`SELECT * FROM threads WHERE id = ?`)
    .get(threadId) as ThreadRow;
  return { capture, thread };
}

/**
 * Create a thread with no capture attached. Used by the ⌘⇧Z chat hotkey
 * when the user wants to talk to the local model directly, without first
 * grabbing a screenshot. continueThread() handles the no-capture case by
 * skipping the OCR-preface user turn and using the chat-text system prompt.
 */
export function createThread(title: string | null = null): ThreadRow {
  const d = getDb();
  const id = randomUUID();
  const now = Date.now();
  d.prepare(
    `INSERT INTO threads(id, created_at, title, pinned) VALUES (?, ?, ?, 0)`,
  ).run(id, now, title);
  return d
    .prepare<unknown[], ThreadRow>(`SELECT * FROM threads WHERE id = ?`)
    .get(id) as ThreadRow;
}

export function appendTurn(
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  model: string | null = null,
): TurnRow {
  const d = getDb();
  const id = randomUUID();
  const now = Date.now();
  d.prepare(
    `INSERT INTO turns(id, thread_id, role, content, created_at, model) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, threadId, role, content, now, model);
  return d.prepare<unknown[], TurnRow>(`SELECT * FROM turns WHERE id = ?`).get(id) as TurnRow;
}

export function setThumbnail(captureId: string, thumbPath: string): void {
  getDb().prepare(`UPDATE captures SET thumb_path = ? WHERE id = ?`).run(thumbPath, captureId);
}

export function setTags(captureId: string, tags: Tag[]): void {
  getDb()
    .prepare(`UPDATE captures SET tags = ? WHERE id = ?`)
    .run(JSON.stringify(tags), captureId);
}

export function setThreadTitle(threadId: string, title: string): void {
  getDb().prepare(`UPDATE threads SET title = ? WHERE id = ?`).run(title, threadId);
}

// ---- reads ----

export function listRecent(limit: number = 50): CaptureRow[] {
  return getDb()
    .prepare<unknown[], CaptureRow>(
      `SELECT * FROM captures ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as CaptureRow[];
}

export function getCapture(id: string): CaptureRow | null {
  return (
    (getDb()
      .prepare<unknown[], CaptureRow>(`SELECT * FROM captures WHERE id = ?`)
      .get(id) as CaptureRow | undefined) ?? null
  );
}

export function getThread(id: string): ThreadRow | null {
  return (
    (getDb()
      .prepare<unknown[], ThreadRow>(`SELECT * FROM threads WHERE id = ?`)
      .get(id) as ThreadRow | undefined) ?? null
  );
}

export function getTurns(threadId: string): TurnRow[] {
  return getDb()
    .prepare<unknown[], TurnRow>(
      `SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at ASC`,
    )
    .all(threadId) as TurnRow[];
}

/**
 * FTS5 keyword search over captures.ocr_text + captures.tags + turns.content.
 * Vector search ships when sqlite-vss is wired.
 */
export function searchKeyword(
  query: string,
  limit: number = 50,
): CaptureRow[] {
  const safe = query.replace(/["*]/g, '').trim();
  if (!safe) return listRecent(limit);

  return getDb()
    .prepare<unknown[], CaptureRow>(
      `SELECT c.* FROM captures c
       JOIN captures_fts f ON f.rowid = c.rowid
       WHERE captures_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(safe, limit) as CaptureRow[];
}
