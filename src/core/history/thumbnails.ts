import { Jimp } from 'jimp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createLogger } from '../logger/index.js';

const log = createLogger('history:thumbnails');

const SIZE = 256;

/**
 * Generate a 256x256 webp thumbnail from a source PNG. Returns the thumb path.
 *
 * For images smaller than SIZE×SIZE, the original aspect ratio is preserved
 * with letterboxing. For larger, scaled-down to fit while preserving aspect.
 */
export async function makeThumbnail(pngPath: string): Promise<string> {
  const dir = path.join(path.dirname(pngPath), 'thumbs');
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(pngPath, path.extname(pngPath));
  const thumbPath = path.join(dir, `${base}.webp`);

  const img = await Jimp.read(pngPath);
  img.scaleToFit({ w: SIZE, h: SIZE });

  await img.write(thumbPath as `${string}.webp`);
  log.debug({ pngPath, thumbPath }, 'thumbnail written');
  return thumbPath;
}
