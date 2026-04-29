import { desktopCapturer, screen } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../core/logger/index.js';
import type { CaptureBBox } from '../shared/types.js';

const log = createLogger('capture');

const MAX_PNG_BYTES = 50 * 1024 * 1024; // 50 MB DoS guard
const CAPTURE_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Glint',
  'captures',
);

export type CaptureRecord = {
  id: string;
  pngPath: string;
  bbox: CaptureBBox;
  displayId: number;
  byteSize: number;
};

/**
 * Resolve which display contains the given screen-space point.
 * Pure for testability when wrapped — exposes screen API behavior.
 */
export function resolveDisplay(point: { x: number; y: number }) {
  return screen.getDisplayNearestPoint(point);
}

/**
 * Capture the given bbox to a PNG on disk. Returns metadata.
 *
 * For now (P1) we save to ~/Library/Application Support/Glint/captures/<uuid>.png
 * directly — P3 will move this under HistoryStore management.
 */
export async function captureBBox(bbox: CaptureBBox): Promise<CaptureRecord> {
  const display = resolveDisplay({ x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 });
  const scale = display.scaleFactor || 1;

  // desktopCapturer thumbnailSize uses scaled pixels.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });

  const source = sources.find((s) => Number(s.display_id) === display.id) ?? sources[0];
  if (!source) throw new Error('no display source available');

  const fullImage = source.thumbnail;
  // Translate bbox from screen coords to display-local coords, then to scaled pixels.
  const localX = Math.round((bbox.x - display.bounds.x) * scale);
  const localY = Math.round((bbox.y - display.bounds.y) * scale);
  const localW = Math.round(bbox.width * scale);
  const localH = Math.round(bbox.height * scale);

  const cropped = fullImage.crop({ x: localX, y: localY, width: localW, height: localH });
  if (cropped.isEmpty()) throw new Error('cropped image is empty');

  const png = cropped.toPNG();
  if (png.byteLength > MAX_PNG_BYTES) {
    throw new Error(`png ${png.byteLength} exceeds DoS guard ${MAX_PNG_BYTES}`);
  }

  await fs.mkdir(CAPTURE_DIR, { recursive: true });
  const id = randomUUID();
  const pngPath = path.join(CAPTURE_DIR, `${id}.png`);
  await fs.writeFile(pngPath, png);

  log.info(
    { id, displayId: display.id, byteSize: png.byteLength, w: localW, h: localH },
    'capture saved',
  );

  return { id, pngPath, bbox, displayId: display.id, byteSize: png.byteLength };
}

// Exposed for tests (pure validation, no Electron needed).
export function isCaptureSizeAcceptable(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_PNG_BYTES;
}

export const __MAX_PNG_BYTES = MAX_PNG_BYTES;
