import { protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../core/logger/index.js';
import { getCapture } from '../core/history/store.js';

const log = createLogger('main:asset-protocol');

export const ASSET_SCHEME = 'glint-asset';

/**
 * Schemes must be registered as privileged BEFORE app.whenReady so they
 * bypass CSP and can serve binary content. Call once at module top of main.
 */
export function registerAssetSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        bypassCSP: false, // we whitelist explicitly in CSP instead
        stream: true,
      },
    },
  ]);
}

/**
 * Resolve a glint-asset:// URL to an absolute file path on disk.
 * URL shape: glint-asset://capture/<id>?kind=thumb|full
 *
 * Returns null if the request is malformed, the capture doesn't exist, or
 * (defense in depth) the resolved path escapes the captures directory.
 */
export function resolveAssetUrl(
  rawUrl: string,
  capturesRoot: string,
): { absPath: string; mime: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${ASSET_SCHEME}:`) return null;
  if (url.hostname !== 'capture') return null;

  const id = url.pathname.replace(/^\/+/, '');
  if (!id || !/^[a-f0-9-]{8,}$/i.test(id)) return null;

  const kind = url.searchParams.get('kind') ?? 'full';
  if (kind !== 'full' && kind !== 'thumb') return null;

  const row = getCapture(id);
  if (!row) return null;
  const target = kind === 'thumb' ? row.thumb_path : row.png_path;
  if (!target) return null;

  // Defense in depth: target must live under capturesRoot.
  const normalized = path.resolve(target);
  const root = path.resolve(capturesRoot);
  if (!normalized.startsWith(root + path.sep) && normalized !== root) {
    return null;
  }

  return { absPath: normalized, mime: 'image/png' };
}

export function registerAssetProtocolHandler(capturesRoot: string): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const resolved = resolveAssetUrl(request.url, capturesRoot);
    if (!resolved) {
      log.warn({ url: request.url }, 'rejected asset request');
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved.absPath).toString());
  });
  log.info({ scheme: ASSET_SCHEME, root: capturesRoot }, 'asset protocol live');
}
