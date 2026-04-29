import { describe, it, expect } from 'vitest';
import {
  classify,
  DENSITY_THRESHOLD,
  MIN_CHAR_COUNT,
  MIN_CONFIDENCE,
} from '../../src/core/router/density.js';

describe('density router', () => {
  const HD = 1920 * 1080; // ~2.07M pixels

  it('routes a code screenshot to text', () => {
    // ~1500 chars on 1920x1080 → density ≈ 0.72
    const decision = classify({ charCount: 1500, ocrConfidence: 88, imagePixels: HD });
    expect(decision.route).toBe('text');
    expect(decision.density).toBeGreaterThan(DENSITY_THRESHOLD);
  });

  it('routes a UI screenshot to vision (low char count)', () => {
    const decision = classify({ charCount: 8, ocrConfidence: 92, imagePixels: HD });
    expect(decision.route).toBe('vision');
    expect(decision.reason).toMatch(/too few/i);
  });

  it('routes to vision when OCR confidence is low', () => {
    const decision = classify({ charCount: 1500, ocrConfidence: 12, imagePixels: HD });
    expect(decision.route).toBe('vision');
    expect(decision.reason).toMatch(/confidence/i);
  });

  it('routes to vision when density falls below threshold', () => {
    // 100 chars on full HD → density ≈ 0.048
    const decision = classify({ charCount: 100, ocrConfidence: 80, imagePixels: HD });
    expect(decision.route).toBe('vision');
    expect(decision.reason).toMatch(/density/i);
  });

  it('boundary: just above char-count minimum + density threshold → text', () => {
    // density 0.6 on a small 100k-pixel capture: 0.6 * (100000/1000) = 60 chars
    const decision = classify({ charCount: 60, ocrConfidence: 80, imagePixels: 100000 });
    expect(decision.route).toBe('text');
  });

  it('boundary: equal to MIN_CHAR_COUNT routes to vision (strictly less)', () => {
    const decision = classify({
      charCount: MIN_CHAR_COUNT,
      ocrConfidence: 80,
      imagePixels: 100000,
    });
    // 20 chars / 100kpx = 0.2 density → still under threshold → vision
    expect(decision.route).toBe('vision');
  });

  it('exposes constants for documentation', () => {
    expect(DENSITY_THRESHOLD).toBe(0.5);
    expect(MIN_CONFIDENCE).toBe(30);
    expect(MIN_CHAR_COUNT).toBe(20);
  });
});
