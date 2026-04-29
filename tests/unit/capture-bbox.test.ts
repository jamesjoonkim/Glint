import { describe, it, expect } from 'vitest';
import {
  isCaptureSizeAcceptable,
  __MAX_PNG_BYTES,
} from '../../src/main/capture.js';

describe('capture size guard', () => {
  it('accepts non-empty captures within limit', () => {
    expect(isCaptureSizeAcceptable(1)).toBe(true);
    expect(isCaptureSizeAcceptable(__MAX_PNG_BYTES)).toBe(true);
    expect(isCaptureSizeAcceptable(__MAX_PNG_BYTES - 1)).toBe(true);
  });

  it('rejects zero-byte captures', () => {
    expect(isCaptureSizeAcceptable(0)).toBe(false);
  });

  it('rejects captures over the DoS guard', () => {
    expect(isCaptureSizeAcceptable(__MAX_PNG_BYTES + 1)).toBe(false);
    expect(isCaptureSizeAcceptable(100 * 1024 * 1024)).toBe(false);
  });
});
