import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendTurn,
  closeStore,
  createCaptureWithThread,
  getCapture,
  getThread,
  getTurns,
  listRecent,
  openStore,
  searchKeyword,
} from '../../src/core/history/store.js';
import { setMigrationsDir } from '../../src/core/history/migrations.js';

let dbPath: string;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glint-store-'));
  dbPath = path.join(dir, 'glint.db');
  setMigrationsDir(path.resolve('migrations'));
  await openStore(dbPath);
});

afterEach(async () => {
  closeStore();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('history store', () => {
  it('creates capture + thread atomically', () => {
    const { capture, thread } = createCaptureWithThread({
      pngPath: '/tmp/x.png',
      ocrText: 'hello world',
      ocrConfidence: 90,
      textDensity: 0.8,
      route: 'text',
    });
    expect(capture.id).toBeTruthy();
    expect(capture.thread_id).toBe(thread.id);
    expect(getCapture(capture.id)).not.toBeNull();
    expect(getThread(thread.id)).not.toBeNull();
  });

  it('appends turns ordered by created_at', async () => {
    const { thread } = createCaptureWithThread({
      pngPath: '/tmp/y.png',
      ocrText: 'q',
      ocrConfidence: 80,
      textDensity: 0.6,
      route: 'text',
    });
    appendTurn(thread.id, 'user', 'first');
    await new Promise((r) => setTimeout(r, 5));
    appendTurn(thread.id, 'assistant', 'second');
    const turns = getTurns(thread.id);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.content).toBe('first');
    expect(turns[1]?.content).toBe('second');
  });

  it('listRecent orders by created_at DESC and respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      createCaptureWithThread({
        pngPath: `/tmp/${i}.png`,
        ocrText: `cap ${i}`,
        ocrConfidence: 90,
        textDensity: 0.9,
        route: 'text',
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const items = listRecent(3);
    expect(items).toHaveLength(3);
    // newest first
    expect(items[0]?.ocr_text).toBe('cap 4');
  });

  it('searchKeyword finds rows via FTS5 over ocr_text', () => {
    createCaptureWithThread({
      pngPath: '/tmp/a.png',
      ocrText: 'TypeError cannot read property foo of undefined',
      ocrConfidence: 88,
      textDensity: 0.9,
      route: 'text',
    });
    createCaptureWithThread({
      pngPath: '/tmp/b.png',
      ocrText: 'a beautiful sunset over mountains',
      ocrConfidence: 88,
      textDensity: 0.9,
      route: 'text',
    });
    const hits = searchKeyword('TypeError');
    expect(hits.length).toBe(1);
    expect(hits[0]?.ocr_text).toMatch(/TypeError/);
  });

  it('searchKeyword falls back to recent when query is empty', () => {
    createCaptureWithThread({
      pngPath: '/tmp/c.png',
      ocrText: 'hi',
      ocrConfidence: 88,
      textDensity: 0.9,
      route: 'text',
    });
    const hits = searchKeyword('   ');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('searchKeyword strips FTS5-special chars to avoid parse errors', () => {
    createCaptureWithThread({
      pngPath: '/tmp/d.png',
      ocrText: 'webhook',
      ocrConfidence: 88,
      textDensity: 0.9,
      route: 'text',
    });
    expect(() => searchKeyword('"webhook*')).not.toThrow();
    const hits = searchKeyword('"webhook*');
    expect(hits.length).toBe(1);
  });
});
