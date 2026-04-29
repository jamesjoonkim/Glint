import type { ModelRoute } from '../../shared/types.js';

export type DensityInput = {
  charCount: number;
  ocrConfidence: number; // 0-100
  imagePixels: number; // width × height (after de-scaling)
};

export type DensityDecision = {
  route: ModelRoute;
  density: number; // chars per kilopixel
  reason: string;
};

/** chars/kpx threshold above which we route to the text-LLM path. */
export const DENSITY_THRESHOLD = 0.5;

/** Below this OCR confidence we don't trust the text and fall to vision. */
export const MIN_CONFIDENCE = 30;

/** Below this char count even a high density doesn't help — too little signal. */
export const MIN_CHAR_COUNT = 20;

/**
 * Decide text vs vision route from OCR output + image size.
 * Pure function — exported for unit tests.
 */
export function classify(input: DensityInput): DensityDecision {
  const kpx = Math.max(1, input.imagePixels / 1000);
  const density = input.charCount / kpx;

  if (input.charCount < MIN_CHAR_COUNT) {
    return { route: 'vision', density, reason: 'too few chars' };
  }
  if (input.ocrConfidence < MIN_CONFIDENCE) {
    return { route: 'vision', density, reason: 'low ocr confidence' };
  }
  if (density < DENSITY_THRESHOLD) {
    return { route: 'vision', density, reason: 'low char density' };
  }
  return { route: 'text', density, reason: 'text-heavy capture' };
}
