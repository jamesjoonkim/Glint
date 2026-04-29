import { promises as fs } from 'node:fs';
import { createLogger } from '../core/logger/index.js';

const log = createLogger('settings');

export type GlintSettings = {
  /**
   * When true, the model is allowed to invoke web-search via the configured
   * backend. This breaks the "no data leaves your Mac" promise — the search
   * query goes to the backend (Tavily) — so it's OFF by default. Users
   * opt in explicitly by editing settings.json or via a future settings UI.
   */
  webSearch: {
    enabled: boolean;
    /** Tavily API key (https://tavily.com). Free tier ships 1k searches/mo. */
    tavilyApiKey: string | null;
    /** Cap on tool-call iterations per send to prevent runaway loops. */
    maxIterations: number;
  };
};

const DEFAULTS: GlintSettings = {
  webSearch: {
    enabled: false,
    tavilyApiKey: null,
    maxIterations: 2,
  },
};

let settingsPath: string | null = null;
let cached: GlintSettings = DEFAULTS;

export function setSettingsPath(p: string): void {
  settingsPath = p;
}

/** Load settings from disk; falls back to defaults on missing/invalid file. */
export async function loadSettings(): Promise<GlintSettings> {
  if (!settingsPath) return DEFAULTS;
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GlintSettings>;
    cached = mergeDeep(DEFAULTS, parsed);
    log.info(
      { path: settingsPath, webSearch: cached.webSearch.enabled },
      'settings loaded',
    );
    return cached;
  } catch (err) {
    const errMessage = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : String(err);
    if (errMessage === 'ENOENT') {
      log.info({ path: settingsPath }, 'settings file not found, using defaults');
    } else {
      log.warn({ err: String(err), path: settingsPath }, 'settings load failed, using defaults');
    }
    cached = DEFAULTS;
    return cached;
  }
}

/** Synchronous read of cached settings — call after loadSettings has run. */
export function getSettings(): GlintSettings {
  return cached;
}

/** Persist settings to disk. */
export async function saveSettings(patch: Partial<GlintSettings>): Promise<void> {
  if (!settingsPath) return;
  cached = mergeDeep(cached, patch);
  await fs.writeFile(settingsPath, JSON.stringify(cached, null, 2), 'utf-8');
  log.info({ path: settingsPath }, 'settings saved');
}

function mergeDeep<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const existing = (base as Record<string, unknown>)[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = mergeDeep(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as unknown as T;
}
