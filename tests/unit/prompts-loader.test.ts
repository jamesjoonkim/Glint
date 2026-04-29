import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadPrompt,
  setPromptsDir,
  __resetCache,
} from '../../src/core/models/prompts.js';

let dir: string;

beforeEach(async () => {
  __resetCache();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glint-prompts-'));
  await fs.writeFile(path.join(dir, 'answer-text.md'), 'TEXT PROMPT v1');
  setPromptsDir(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('prompts loader', () => {
  it('loads a prompt from disk', async () => {
    const p = await loadPrompt('answer-text');
    expect(p).toBe('TEXT PROMPT v1');
  });

  it('caches between rapid calls', async () => {
    const a = await loadPrompt('answer-text');
    await fs.writeFile(path.join(dir, 'answer-text.md'), 'TEXT PROMPT v2');
    const b = await loadPrompt('answer-text');
    expect(a).toBe(b); // cache hit; ttl is 1s in dev
  });

  it('throws when promptsDir not set', async () => {
    __resetCache();
    await expect(loadPrompt('answer-text')).rejects.toThrow(/promptsDir/);
  });

  it('throws when prompt file missing', async () => {
    await expect(loadPrompt('classify')).rejects.toThrow();
  });
});
