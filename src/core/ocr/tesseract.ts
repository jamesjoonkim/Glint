import { createWorker, type Worker } from 'tesseract.js';

export type OcrResult = {
  text: string;
  confidence: number; // 0-100, average across blocks
  charCount: number;
  durationMs: number;
};

let worker: Worker | null = null;

/**
 * Initialize tesseract worker once. Subsequent calls reuse.
 * Returns the live worker.
 */
export async function ensureWorker(lang: string = 'eng'): Promise<Worker> {
  if (worker) return worker;
  worker = await createWorker(lang);
  return worker;
}

/**
 * Run OCR on a PNG file path. Throws on tesseract errors — caller decides
 * whether to fall through to the vision route.
 */
export async function runOcr(pngPath: string, lang: string = 'eng'): Promise<OcrResult> {
  const w = await ensureWorker(lang);
  const start = performance.now();
  const { data } = await w.recognize(pngPath);
  const durationMs = Math.round(performance.now() - start);

  const text = (data.text ?? '').trim();
  return {
    text,
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    charCount: text.length,
    durationMs,
  };
}

export async function destroyWorker(): Promise<void> {
  if (!worker) return;
  await worker.terminate();
  worker = null;
}
