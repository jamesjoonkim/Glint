#!/usr/bin/env node
/**
 * Render resources/icon.svg into a macOS .icns at all required sizes.
 * Uses Playwright's bundled Chromium so we don't need a separate
 * SVG-to-PNG dep. Run via: node build/gen-icon.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SVG = path.join(ROOT, 'resources', 'icon.svg');
const ICONSET = path.join(ROOT, 'resources', 'icon.iconset');
const ICNS = path.join(ROOT, 'resources', 'icon.icns');

// macOS iconset spec — each entry: filename, raster pixel size.
const SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const svg = fs.readFileSync(SVG, 'utf8');

fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1024 } });
const page = await ctx.newPage();

for (const [name, size] of SIZES) {
  // Each size gets a fresh page so the device-pixel-ratio is exact.
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html>
<html><body style="margin:0;padding:0;background:transparent">
<div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>
</body></html>`,
  );
  const buf = await page.screenshot({
    omitBackground: true,
    type: 'png',
    clip: { x: 0, y: 0, width: size, height: size },
  });
  fs.writeFileSync(path.join(ICONSET, name), buf);
  console.log(`  ✓ ${name.padEnd(28)} ${size}×${size}`);
}

await browser.close();

console.log('  → packing icns…');
execFileSync('iconutil', ['-c', 'icns', '-o', ICNS, ICONSET], { stdio: 'inherit' });
const stat = fs.statSync(ICNS);
console.log(`  ✓ ${ICNS}  (${(stat.size / 1024).toFixed(1)} KB)`);
