import { describe, it, expect } from 'vitest';
import { __piiKeys, createLogger } from '../../src/core/logger/index.js';

describe('logger', () => {
  it('declares the expected PII redact list', () => {
    // Privacy contract: changing this list requires a security review.
    expect(__piiKeys).toEqual([
      'ocr_text',
      'ocrText',
      'png_path',
      'pngPath',
      'tags',
      'content',
    ]);
  });

  it('creates a named child logger', () => {
    const log = createLogger('test');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });
});
