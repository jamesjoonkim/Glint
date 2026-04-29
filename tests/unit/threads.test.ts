import { describe, it, expect } from 'vitest';
import { parseTags } from '../../src/core/threads/tags.js';
import { clampTitle, fallbackTitle } from '../../src/core/threads/titles.js';
import { buildContext, __SUMMARY_THRESHOLD } from '../../src/core/threads/context.js';

describe('parseTags', () => {
  it('accepts a clean JSON array', () => {
    expect(parseTags('["code"]')).toEqual(['code']);
  });
  it('strips markdown code fences', () => {
    expect(parseTags('```json\n["error","code"]\n```')).toEqual(['error', 'code']);
  });
  it('caps at 3 tags', () => {
    expect(parseTags('["code","error","ui","article","photo"]')).toEqual(['code', 'error', 'ui']);
  });
  it('drops unknown tags', () => {
    expect(parseTags('["zalgo","code","mystery"]')).toEqual(['code']);
  });
  it('falls back to ["other"] on malformed input', () => {
    expect(parseTags('not json at all')).toEqual(['other']);
    expect(parseTags('{"obj":1}')).toEqual(['other']);
    expect(parseTags('["unknown"]')).toEqual(['other']);
  });
});

describe('clampTitle', () => {
  it('preserves short titles', () => {
    expect(clampTitle('TypeError on signup')).toBe('TypeError on signup');
  });
  it('truncates with ellipsis when over 60 chars', () => {
    const long = 'a'.repeat(80);
    const out = clampTitle(long);
    expect(out.length).toBe(60);
    expect(out.endsWith('…')).toBe(true);
  });
  it('strips surrounding quotes', () => {
    expect(clampTitle('"a quoted title"')).toBe('a quoted title');
  });
  it('returns untitled for empty input', () => {
    expect(clampTitle('')).toBe('untitled');
  });
  it('takes only the first line', () => {
    expect(clampTitle('first line\nsecond line')).toBe('first line');
  });
});

describe('fallbackTitle', () => {
  it('uses OCR text', () => {
    expect(fallbackTitle('Some explanatory text from a screenshot')).toMatch(/explanatory/);
  });
  it('handles empty OCR', () => {
    expect(fallbackTitle('')).toBe('screenshot');
  });
});

describe('buildContext', () => {
  const turn = (role: 'user' | 'assistant', content: string) => ({
    id: 't', thread_id: 'th', role, content, created_at: 0, model: null,
  });

  it('emits system + ocr preface + turns + new user message', () => {
    const msgs = buildContext({
      systemPrompt: 'SYS',
      ocrPreface: 'OCR text here',
      turns: [turn('user', 'q1'), turn('assistant', 'a1')],
      newUserMessage: 'follow-up',
    });
    expect(msgs).toHaveLength(5);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[4]?.content).toBe('follow-up');
  });

  it('truncates oldest turns once threshold exceeded', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn('user', `q${i}`));
    const msgs = buildContext({
      systemPrompt: 'SYS',
      ocrPreface: 'OCR',
      turns,
      newUserMessage: 'q-new',
    });
    // 1 system + 1 ocr preface + N truncated + 1 new = 3 + threshold
    expect(msgs.length).toBe(3 + __SUMMARY_THRESHOLD);
    // earliest retained turn should be turn #(20 - threshold)
    const firstRetained = msgs[2]?.content;
    expect(firstRetained).toBe(`q${20 - __SUMMARY_THRESHOLD}`);
  });
});
