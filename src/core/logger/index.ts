/**
 * Pino-based logger with PII scrubbing for Glint v2.
 *
 * Privacy promise: OCR text, PNG paths, and tag arrays must never reach disk
 * logs. The redact list below is enforced at log-call time.
 */
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PII_KEYS = [
  'ocr_text',
  'ocrText',
  'png_path',
  'pngPath',
  'tags',
  'content', // turn content can contain sensitive answer text
];

const logDir = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Glint',
  'logs',
);

const isDebug = process.env.GLINT_DEBUG === '1';

// Build the daily log path lazily so vitest (no electron app dir) doesn't fail.
function dailyLogPath(): string {
  return path.join(logDir, `glint-${new Date().toISOString().slice(0, 10)}.log`);
}

export type Logger = pino.Logger;

/**
 * Logger writes ONE place: a rolling daily file. We deliberately avoid
 * pino-pretty's worker-thread transport because Vite + Electron can't
 * resolve the worker module path at runtime (Cannot find module
 * '.vite/build/lib/worker.js'). Tail the file in dev:
 *
 *   tail -f ~/Library/Application\ Support/Glint/logs/glint-*.log
 */
export function createLogger(name: string): Logger {
  let stream: pino.DestinationStream | undefined;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    stream = pino.destination({ dest: dailyLogPath(), sync: false, mkdir: true });
  } catch {
    // Tests / sandboxed contexts: fall back to stdout.
    stream = undefined;
  }
  return pino(
    {
      name,
      level: isDebug ? 'debug' : 'info',
      redact: { paths: PII_KEYS, censor: '<redacted>' },
    },
    stream,
  );
}

/** Default app-wide logger. Modules should prefer createLogger('module'). */
export const log = createLogger('glint');

/** Internal: exposed for tests so PII scrubbing can be verified deterministically. */
export const __piiKeys = PII_KEYS;
