import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { makeThumbnail } from '../../src/core/history/thumbnails.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glint-thumb-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function makeSourcePng(width: number, height: number): Promise<string> {
  const img = new Jimp({ width, height, color: 0xff8800ff });
  const p = path.join(dir, 'src.png');
  await img.write(p as `${string}.png`);
  return p;
}

describe('makeThumbnail', () => {
  it('writes a .png file (not .webp) under captures/thumbs/', async () => {
    const src = await makeSourcePng(800, 600);
    const out = await makeThumbnail(src);
    expect(out.endsWith('.png')).toBe(true);
    expect(out).toContain(`${path.sep}thumbs${path.sep}`);
    const stat = await fs.stat(out);
    expect(stat.size).toBeGreaterThan(0);
  });
});
