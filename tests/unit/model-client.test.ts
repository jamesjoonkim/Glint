import { describe, it, expect } from 'vitest';
import { parseSseLine } from '../../src/core/models/client.js';

describe('parseSseLine', () => {
  it('extracts content delta from a normal SSE line', () => {
    const line = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    expect(parseSseLine(line)).toBe('hello');
  });

  it('returns [DONE] sentinel', () => {
    expect(parseSseLine('data: [DONE]')).toBe('[DONE]');
  });

  it('returns null for non-data lines', () => {
    expect(parseSseLine(': keepalive')).toBeNull();
    expect(parseSseLine('event: ping')).toBeNull();
    expect(parseSseLine('')).toBeNull();
  });

  it('returns null when delta has no content (role-only opener)', () => {
    const line = 'data: {"choices":[{"delta":{"role":"assistant"}}]}';
    expect(parseSseLine(line)).toBeNull();
  });

  it('returns null for malformed JSON instead of throwing', () => {
    expect(parseSseLine('data: {not json')).toBeNull();
  });
});
