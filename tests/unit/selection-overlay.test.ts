import { describe, it, expect } from 'vitest';
import { rectFromPoints } from '../../src/renderer/components/SelectionOverlay/index.js';

describe('rectFromPoints', () => {
  it('handles drag from top-left to bottom-right', () => {
    const r = rectFromPoints({ x: 10, y: 20 }, { x: 110, y: 220 });
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it('normalizes a reverse drag (bottom-right to top-left)', () => {
    const r = rectFromPoints({ x: 110, y: 220 }, { x: 10, y: 20 });
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it('returns zero-size rect when points coincide', () => {
    const r = rectFromPoints({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(r).toEqual({ x: 50, y: 50, width: 0, height: 0 });
  });

  it('handles negative coordinates (multi-display layouts)', () => {
    const r = rectFromPoints({ x: -100, y: -50 }, { x: 200, y: 100 });
    expect(r).toEqual({ x: -100, y: -50, width: 300, height: 150 });
  });
});
