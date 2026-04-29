/**
 * Embedding via the local MLX server (BGE-small, 384-dim).
 * In fake mode, returns a deterministic seeded vector so tests are stable.
 */

export type EmbedConfig = {
  baseUrl: string; // http://127.0.0.1:<port>
  model: string;
};

export const EMBED_DIM = 384;

const FAKE = process.env.GLINT_LLM === 'fake';

export async function embed(text: string, cfg: EmbedConfig): Promise<number[]> {
  if (FAKE) return fakeEmbed(text);

  const res = await fetch(`${cfg.baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: text }),
  });
  if (!res.ok) throw new Error(`embed: ${res.status} ${res.statusText}`);

  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vec = json.data?.[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(`embed: unexpected dim ${vec?.length ?? 'undefined'} (want ${EMBED_DIM})`);
  }
  return vec;
}

/** Deterministic pseudo-embedding for tests. Never used in production. */
export function fakeEmbed(text: string): number[] {
  const out = new Array<number>(EMBED_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    const idx = i % EMBED_DIM;
    out[idx] = (out[idx] ?? 0) + (text.charCodeAt(i) % 31) / 31;
  }
  // L2 normalize
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag) || 1;
  return out.map((v) => v / mag);
}
