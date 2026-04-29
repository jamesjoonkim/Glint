import fs from 'node:fs/promises';
import path from 'node:path';

const cache = new Map<string, { text: string; loadedAt: number }>();
const CACHE_TTL_DEV = 1_000; // dev: re-read every second so edits hot-reload
const CACHE_TTL_PROD = Infinity;

const ttl = process.env.NODE_ENV === 'production' ? CACHE_TTL_PROD : CACHE_TTL_DEV;

export type PromptName =
  | 'answer-text'
  | 'answer-vision'
  | 'answer-chat'
  | 'classify'
  | 'title';

let promptsDir: string | null = null;

/** Set the directory containing prompts/. Called once from main bootstrap. */
export function setPromptsDir(dir: string): void {
  promptsDir = dir;
  cache.clear();
}

export function getPromptsDir(): string {
  if (!promptsDir) throw new Error('promptsDir not set; call setPromptsDir at boot');
  return promptsDir;
}

export async function loadPrompt(name: PromptName): Promise<string> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.loadedAt < ttl) return cached.text;

  const file = path.join(getPromptsDir(), `${name}.md`);
  const text = await fs.readFile(file, 'utf8');
  cache.set(name, { text, loadedAt: Date.now() });
  return text;
}

/** Test helper. */
export function __resetCache(): void {
  cache.clear();
  promptsDir = null;
}
