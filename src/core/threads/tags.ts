import type { Tag } from '../../shared/types.js';
import { streamCompletion, type ClientConfig } from '../models/client.js';
import { loadPrompt } from '../models/prompts.js';

const ALLOWED: ReadonlySet<Tag> = new Set([
  'code', 'error', 'article', 'ui', 'diagram', 'photo', 'chart', 'table', 'text', 'other',
]);

/** Parse the LLM's tag output. Returns ['other'] on any failure. */
export function parseTags(raw: string): Tag[] {
  const trimmed = raw.trim().replace(/^```(?:json)?|```$/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return ['other'];
  }
  if (!Array.isArray(parsed)) return ['other'];
  const accepted = parsed
    .filter((x): x is string => typeof x === 'string')
    .filter((s): s is Tag => ALLOWED.has(s as Tag))
    .slice(0, 3);
  return accepted.length > 0 ? accepted : ['other'];
}

export type ClassifyArgs = {
  ocrText: string;
  client: ClientConfig;
  model: string;
};

/** Run the LLM tag classifier. Output is constrained to the closed Tag set. */
export async function classifyTags(args: ClassifyArgs): Promise<Tag[]> {
  const system = await loadPrompt('classify');
  const stream = streamCompletion(args.client, {
    model: args.model,
    temperature: 0,
    max_tokens: 64,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `OCR text:\n\n${args.ocrText.slice(0, 1500)}` },
    ],
  });
  let buf = '';
  for await (const tok of stream) buf += tok;
  return parseTags(buf);
}
