/**
 * Pino-based logger with PII scrubbing for Glint v2.
 *
 * Privacy promise: OCR text, PNG paths, and tag arrays must never reach disk
 * logs. The redact list below is enforced at log-call time.
 */
import pino from 'pino';
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

const isDev = process.env.NODE_ENV !== 'production';
const isDebug = process.env.GLINT_DEBUG === '1';

export type Logger = pino.Logger;

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: isDebug ? 'debug' : 'info',
    redact: {
      paths: PII_KEYS,
      censor: '<redacted>',
    },
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
        }
      : {
          target: 'pino/file',
          options: {
            destination: path.join(
              logDir,
              `glint-${new Date().toISOString().slice(0, 10)}.log`,
            ),
            mkdir: true,
          },
        },
  });
}

/** Default app-wide logger. Modules should prefer createLogger('module'). */
export const log = createLogger('glint');

/** Internal: exposed for tests so PII scrubbing can be verified deterministically. */
export const __piiKeys = PII_KEYS;
