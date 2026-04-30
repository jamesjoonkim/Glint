import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logger/index.js';
import type { ModelSpec } from '../shared/models.js';

const log = createLogger('first-run');

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Glint');
const FLAG_FILE = path.join(APP_SUPPORT, '.first-run-complete');
const MODELS_DIR = path.join(APP_SUPPORT, 'models');

export function getModelsRoot(): string {
  return MODELS_DIR;
}

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

/**
 * Returns the subset of the manifest whose local directory is missing or
 * empty of weight files. A weight file is anything matching `*.safetensors`
 * — partial downloads (e.g. interrupted by the user) leave only `.incomplete`
 * files behind, which we rightly treat as not-yet-installed.
 *
 * Intentionally synchronous — called once at boot before any window opens,
 * so blocking the main process briefly here is acceptable and simpler than
 * coordinating an async boot gate.
 */
export function getMissingModels(
  modelsRoot: string,
  manifest: readonly ModelSpec[],
): ModelSpec[] {
  return manifest.filter((m) => {
    const dir = path.join(modelsRoot, m.localDir);
    if (!fsSync.existsSync(dir)) return true;
    const entries = fsSync.readdirSync(dir);
    return !entries.some((f) => f.endsWith('.safetensors'));
  });
}
