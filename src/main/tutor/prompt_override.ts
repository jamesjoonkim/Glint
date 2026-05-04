/**
 * Persisted override for the EXPLAIN prompt. Lives under Glint's
 * Application Support dir so it survives reinstalls. When unset (or
 * empty), the default from prompts.ts is used.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../core/logger/index.js';
import { EXPLAIN_SYSTEM_DRAFT } from './prompts.js';

const log = createLogger('tutor:prompt-override');

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Glint');
const OVERRIDE_PATH = path.join(APP_SUPPORT, 'lens-explain-prompt.txt');

export async function getActivePrompt(): Promise<string> {
  try {
    const text = await fs.readFile(OVERRIDE_PATH, 'utf8');
    if (text.trim().length === 0) return EXPLAIN_SYSTEM_DRAFT;
    return text;
  } catch {
    return EXPLAIN_SYSTEM_DRAFT;
  }
}

export async function getPromptOverride(): Promise<{
  active: string;
  defaultText: string;
  isCustom: boolean;
}> {
  let isCustom = false;
  let active = EXPLAIN_SYSTEM_DRAFT;
  try {
    const text = await fs.readFile(OVERRIDE_PATH, 'utf8');
    if (text.trim().length > 0) {
      active = text;
      isCustom = true;
    }
  } catch {
    // no override
  }
  return { active, defaultText: EXPLAIN_SYSTEM_DRAFT, isCustom };
}

export async function setPromptOverride(text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fs.mkdir(APP_SUPPORT, { recursive: true });
    await fs.writeFile(OVERRIDE_PATH, text);
    log.info({ bytes: text.length }, 'prompt override saved');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function clearPromptOverride(): Promise<{ ok: boolean; error?: string }> {
  try {
    await fs.unlink(OVERRIDE_PATH);
    log.info('prompt override cleared');
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
    return { ok: false, error: String(err) };
  }
}
