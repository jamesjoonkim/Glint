import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMissingModels, getModelsRoot } from '../../src/main/first-run.js';
import { MODEL_MANIFEST } from '../../src/shared/models.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'glint-models-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('getMissingModels', () => {
  it('returns the full manifest when models dir is empty', () => {
    const missing = getMissingModels(root, MODEL_MANIFEST);
    expect(missing).toHaveLength(MODEL_MANIFEST.length);
  });

  it('treats a present dir without safetensors as missing', () => {
    const firstModel = MODEL_MANIFEST[0];
    if (!firstModel) throw new Error('MODEL_MANIFEST is empty');
    mkdirSync(path.join(root, firstModel.localDir), { recursive: true });
    const missing = getMissingModels(root, MODEL_MANIFEST);
    expect(missing.map((m) => m.localDir)).toContain(firstModel.localDir);
  });

  it('treats a dir with at least one safetensors as present', () => {
    const firstModel = MODEL_MANIFEST[0];
    if (!firstModel) throw new Error('MODEL_MANIFEST is empty');
    const dir = path.join(root, firstModel.localDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'model.safetensors'), 'stub');
    const missing = getMissingModels(root, MODEL_MANIFEST);
    expect(missing.map((m) => m.localDir)).not.toContain(firstModel.localDir);
  });

  it('returns empty when all models present', () => {
    for (const m of MODEL_MANIFEST) {
      const dir = path.join(root, m.localDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'model.safetensors'), 'stub');
    }
    expect(getMissingModels(root, MODEL_MANIFEST)).toEqual([]);
  });
});

describe('getModelsRoot', () => {
  it('returns the expected app-support path', () => {
    const root = getModelsRoot();
    expect(root).toContain(path.join('Application Support', 'Glint', 'models'));
  });
});
