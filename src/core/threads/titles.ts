import { streamCompletion, type ClientConfig } from '../models/client.js';
import { loadPrompt } from '../models/prompts.js';

const MAX_LEN = 60;

export function clampTitle(raw: string): string {
  const firstLine = (raw.split('\n')[0] ?? '').replace(/^[\s"']+|[\s"']+$/g, '');
  const collapsed = firstLine.replace(/[ \t]+/g, ' ').trim();
  if (!collapsed) return 'untitled';
  return collapsed.length <= MAX_LEN ? collapsed : `${collapsed.slice(0, MAX_LEN - 1)}…`;
}

/** Fallback title built from OCR alone — used when the LLM call fails. */
export function fallbackTitle(ocrText: string): string {
  return clampTitle(ocrText.replace(/\s+/g, ' ').trim() || 'screenshot');
}

export type TitleArgs = {
  ocrText: string;
  answerText: string;
  client: ClientConfig;
  model: string;
};

export async function generateTitle(args: TitleArgs): Promise<string> {
  try {
    const system = await loadPrompt('title');
    const stream = streamCompletion(args.client, {
      model: args.model,
      temperature: 0.3,
      max_tokens: 30,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `OCR (truncated):\n${args.ocrText.slice(0, 600)}\n\nAnswer (truncated):\n${args.answerText.slice(0, 400)}`,
        },
      ],
    });
    let buf = '';
    for await (const tok of stream) buf += tok;
    return clampTitle(buf);
  } catch {
    return fallbackTitle(args.ocrText);
  }
}
