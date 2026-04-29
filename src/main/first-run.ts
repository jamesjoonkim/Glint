import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logger/index.js';

const log = createLogger('first-run');

const FLAG_FILE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Glint',
  '.first-run-complete',
);

export async function isFirstRun(): Promise<boolean> {
  try {
    await fs.access(FLAG_FILE);
    return false;
  } catch {
    return true;
  }
}

export async function markFirstRunComplete(): Promise<void> {
  await fs.mkdir(path.dirname(FLAG_FILE), { recursive: true });
  await fs.writeFile(FLAG_FILE, new Date().toISOString());
  log.info('first-run flag written');
}
