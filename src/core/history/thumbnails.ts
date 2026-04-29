import { Jimp } from 'jimp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createLogger } from '../logger/index.js';

const log = createLogger('history:thumbnails');

// 512px on the long edge — large enough for retina at 256-280px card width,
// small enough that 1k captures stay under ~80MB on disk.
const SIZE = 512;

/**
 * Generate a PNG thumbnail from a source PNG. Returns the thumb path.
 *
 * Jimp 1.x ships PNG/JPEG/GIF/BMP/TIFF only — WebP requires a separate
 * plugin that doesn't bundle cleanly through electron-forge.
 */
export async function makeThumbnail(pngPath: string): Promise<string> {
  const dir = path.join(path.dirname(pngPath), 'thumbs');
  await fs.mkdir(dir, { recursive: true });
  const base = path.basename(pngPath, path.extname(pngPath));
  const thumbPath = path.join(dir, `${base}.png`);

  const img = await Jimp.read(pngPath);
  img.scaleToFit({ w: SIZE, h: SIZE });

  await img.write(thumbPath as `${string}.png`);
  log.debug({ pngPath, thumbPath }, 'thumbnail written');
  return thumbPath;
}
