/**
 * OpenAI-compatible HTTP client to the bundled MLX server (localhost only).
 *
 * Privacy: hardcoded http://127.0.0.1, never reachable from LAN. The only
 * file in core/ permitted to use fetch (see .eslintrc override).
 *
 * Streaming via SSE — yields tokens as an async iterable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type Message =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'user'; content: Array<TextPart | ImagePart> };

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string } };

export type CompletionRequest = {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
};

export type ClientConfig = {
  baseUrl: string; // http://127.0.0.1:<port>
  fakeResponsesDir?: string; // when set, fixtures replace real calls
};

const FAKE = process.env.GLINT_LLM === 'fake';

/**
 * Stream a chat completion as an async iterable of token deltas.
 * Caller `for await (const tok of stream)` to consume.
 */
export async function* streamCompletion(
  cfg: ClientConfig,
  req: CompletionRequest,
  /** Abort the SSE read mid-stream when this signal fires. The HTTP fetch
   *  is also tied to it, so the request to mlx_lm.server is closed cleanly
   *  rather than left hanging on the server side. */
  signal?: AbortSignal,
): AsyncIterable<string> {
  if (FAKE || cfg.fakeResponsesDir) {
    yield* fakeStream(cfg.fakeResponsesDir);
    return;
  }

  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...req, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`mlx server returned ${res.status} ${res.statusText}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          // ignore — already closed
        }
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        const tok = parseSseLine(line);
        if (tok === '[DONE]') return;
        if (tok) yield tok;
      }
    }
  } catch (err) {
    // AbortError surfaces from fetch when the signal aborts during read.
    // Treat as clean stream end — caller can inspect signal.aborted.
    if (signal?.aborted) return;
    throw err;
  }
}

/** Parse a single SSE `data: ...` line, return delta content or null. */
export function parseSseLine(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const body = line.slice(5).trim();
  if (!body) return null;
  if (body === '[DONE]') return '[DONE]';
  try {
    const obj = JSON.parse(body) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return obj.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

async function* fakeStream(dir: string | undefined): AsyncIterable<string> {
  const fixture = dir
    ? path.join(dir, 'response.txt')
    : 'Local Glint runtime is not configured. Set GLINT_LLM=real after the first-run wizard completes, or supply tests/fixtures/responses/response.txt for the fake stream.';
  let text: string;
  try {
    text = await fs.readFile(fixture, 'utf8');
  } catch {
    text = String(fixture);
  }
  // Yield word-by-word for a realistic stream feel in tests/dev.
  for (const word of text.split(/(\s+)/)) {
    if (word) yield word;
  }
}

/** Build a vision-capable message from a PNG file path + question. */
export async function buildVisionMessage(
  pngPath: string,
  question: string,
): Promise<Message> {
  const bytes = await fs.readFile(pngPath);
  const b64 = bytes.toString('base64');
  return {
    role: 'user',
    content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    ],
  };
}
