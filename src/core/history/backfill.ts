import { createLogger } from '../logger/index.js';
import { getDb, setThumbnail } from './store.js';
import { makeThumbnail } from './thumbnails.js';

const log = createLogger('history:backfill');

type Row = { id: string; png_path: string };

/**
 * Generate thumbnails for any captures still missing one. Sequential — Jimp
 * is sync-heavy and parallelism just thrashes the CPU. Safe to fire-and-
 * forget on app launch; runs in the background while the UI is interactive.
 */
export async function backfillThumbnails(): Promise<{
  processed: number;
  failed: number;
}> {
  const rows = getDb()
    .prepare<unknown[], Row>(
      `SELECT id, png_path FROM captures WHERE thumb_path IS NULL ORDER BY created_at DESC`,
    )
    .all() as Row[];

  if (rows.length === 0) return { processed: 0, failed: 0 };
  log.info({ count: rows.length }, 'starting thumbnail backfill');

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const thumbPath = await makeThumbnail(row.png_path);
      setThumbnail(row.id, thumbPath);
      processed += 1;
    } catch (err) {
      failed += 1;
      log.warn({ err: String(err), id: row.id }, 'backfill thumb failed');
    }
  }
  log.info({ processed, failed }, 'backfill complete');
  return { processed, failed };
}
