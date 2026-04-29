import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.js';

const log = createLogger('history:migrations');

let migrationsDir: string | null = null;

export function setMigrationsDir(dir: string): void {
  migrationsDir = dir;
}

export function getMigrationsDir(): string {
  if (!migrationsDir) throw new Error('migrationsDir not set');
  return migrationsDir;
}

/**
 * Apply any migration whose numeric prefix exceeds the DB's user_version.
 * Files are named NNNN_*.sql; e.g. 0001_init.sql.
 *
 * Idempotent: re-running with no new files is a no-op.
 */
export async function applyMigrations(db: Database): Promise<{ applied: number[]; current: number }> {
  const dir = getMigrationsDir();
  const files = (await fs.readdir(dir))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const runSql = db.exec.bind(db);
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  const applied: number[] = [];

  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 4), 10);
    if (version <= current) continue;

    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    runSql('BEGIN');
    try {
      runSql(sql);
      db.pragma(`user_version = ${version}`);
      runSql('COMMIT');
      applied.push(version);
      log.info({ version, file }, 'migration applied');
    } catch (err) {
      runSql('ROLLBACK');
      log.error({ version, file, err: String(err) }, 'migration failed');
      throw err;
    }
  }

  const finalVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  return { applied, current: finalVersion };
}
