import type { Message } from '../models/client.js';
import type { TurnRow } from '../history/store.js';

const SUMMARY_THRESHOLD = 12; // turns before we start compressing

/**
 * Assemble messages for a continuing thread. Older turns get summarized
 * lazily once the thread grows long; for v2.0 we hard-cap turn count and
 * leave summarization for v2.1 (per spec).
 */
export function buildContext(args: {
  systemPrompt: string;
  ocrPreface: string;
  turns: TurnRow[];
  newUserMessage: string;
}): Message[] {
  const out: Message[] = [{ role: 'system', content: args.systemPrompt }];

  // First user turn anchors the conversation in the OCR text.
  out.push({ role: 'user', content: args.ocrPreface });

  const recent = args.turns.length > SUMMARY_THRESHOLD
    ? args.turns.slice(-SUMMARY_THRESHOLD)
    : args.turns;

  for (const t of recent) {
    out.push({ role: t.role, content: t.content });
  }

  out.push({ role: 'user', content: args.newUserMessage });
  return out;
}

export const __SUMMARY_THRESHOLD = SUMMARY_THRESHOLD;
