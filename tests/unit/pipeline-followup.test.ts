import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import {
  buildTextFollowupRequest,
  buildVisionFollowupRequest,
} from '../../src/main/pipeline.js';
import { setPromptsDir } from '../../src/core/models/prompts.js';

let pngPath: string;
let dir: string;

beforeAll(async () => {
  setPromptsDir(path.resolve('prompts'));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glint-followup-'));
  pngPath = path.join(dir, 'shot.png');
  await new Jimp({ width: 64, height: 48, color: 0xff8800ff }).write(
    pngPath as `${string}.png`,
  );
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const deps = {
  textUrl: 'http://127.0.0.1:8765',
  visionUrl: 'http://127.0.0.1:8766',
  textModel: 'default_model',
  visionModel: 'default_model',
};

describe('buildTextFollowupRequest', () => {
  it('routes to textUrl + textModel and inlines OCR as the first user turn', async () => {
    const out = await buildTextFollowupRequest(
      { ocr_text: 'Some captured text from the screen.' },
      [
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'follow-up question' },
      ],
      deps,
    );
    expect(out.cfg.baseUrl).toBe('http://127.0.0.1:8765');
    expect(out.model).toBe('default_model');
    // [system, user(OCR), assistant, user(followup)]
    expect(out.messages).toHaveLength(4);
    expect(out.messages[0]!.role).toBe('system');
    expect(out.messages[1]!.role).toBe('user');
    expect(typeof out.messages[1]!.content).toBe('string');
    expect(out.messages[1]!.content).toContain('Some captured text');
    // No image_url in any message — text route must not send pixels.
    const json = JSON.stringify(out.messages);
    expect(json).not.toContain('image_url');
  });
});

describe('buildVisionFollowupRequest', () => {
  it('routes to visionUrl + visionModel and attaches the image only on the first user turn', async () => {
    const out = await buildVisionFollowupRequest(
      { png_path: pngPath },
      [
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'what color is the bar' },
      ],
      deps,
    );
    expect(out.cfg.baseUrl).toBe('http://127.0.0.1:8766');
    expect(out.model).toBe('default_model');
    // [system, user(image+text), assistant, user(followup)]
    expect(out.messages).toHaveLength(4);
    expect(out.messages[0]!.role).toBe('system');

    // First user turn must be multimodal: array content with image_url + text.
    const firstUser = out.messages[1]!;
    expect(firstUser.role).toBe('user');
    expect(Array.isArray(firstUser.content)).toBe(true);
    const parts = firstUser.content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);

    // Subsequent turns are text-only (no re-attached image).
    expect(typeof out.messages[2]!.content).toBe('string');
    expect(typeof out.messages[3]!.content).toBe('string');

    // Exactly one image in the entire payload.
    const imageOccurrences = JSON.stringify(out.messages).match(/data:image\/png/g) ?? [];
    expect(imageOccurrences).toHaveLength(1);
  });
});
