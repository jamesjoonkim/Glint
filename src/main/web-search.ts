import { createLogger } from '../core/logger/index.js';

const log = createLogger('web-search');

export type SearchResult = {
  title: string;
  url: string;
  content: string;
};

export type SearchResponse = {
  results: SearchResult[];
  images: string[];
};

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * Detect a Qwen-style tool call in a model response. Format:
 *   <tool_call>
 *   {"name": "web_search", "arguments": {"query": "..."}}
 *   </tool_call>
 *
 * Returns null when the response is normal prose. Tolerates whitespace,
 * leading prose before the tag (rare but possible), and either a single
 * tool_call block or just the JSON body in cases where the model omits the
 * wrapping tags.
 */
export function parseToolCall(answer: string): ToolCall | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;

  // Primary: <tool_call>...</tool_call>
  const tagMatch = trimmed.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (tagMatch && tagMatch[1]) {
    return parseJson(tagMatch[1]);
  }

  // Fallback: bare JSON object as the entire response (some Qwen variants).
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseJson(trimmed);
  }

  return null;
}

function parseJson(body: string): ToolCall | null {
  try {
    const obj = JSON.parse(body.trim()) as Partial<ToolCall>;
    if (typeof obj.name !== 'string') return null;
    return {
      name: obj.name,
      arguments: (obj.arguments && typeof obj.arguments === 'object'
        ? obj.arguments
        : {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/**
 * Execute a Tavily search. Returns text results AND image URLs (when
 * include_images is requested). Caller decides what to do with the images
 * — the pipeline downloads top N for vision-route follow-ups.
 */
export async function tavilySearch(
  query: string,
  apiKey: string,
  options: { maxResults?: number; includeImages?: boolean; signal?: AbortSignal } = {},
): Promise<SearchResponse> {
  const maxResults = options.maxResults ?? 5;
  const includeImages = options.includeImages ?? true;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_images: includeImages,
    }),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tavily ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    results?: Array<Partial<SearchResult>>;
    images?: Array<string | { url?: string }>;
  };
  const results = (data.results ?? [])
    .filter((r) => typeof r.title === 'string' && typeof r.url === 'string')
    .map((r) => ({
      title: r.title as string,
      url: r.url as string,
      content: typeof r.content === 'string' ? r.content : '',
    }))
    .slice(0, maxResults);
  // Tavily images can be either string[] or {url}[] depending on plan/version.
  const images = (data.images ?? [])
    .map((i) => (typeof i === 'string' ? i : i?.url))
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  log.info(
    { query, results: results.length, images: images.length },
    'tavily search complete',
  );
  return { results, images };
}

/**
 * Download an image URL and return its raw bytes. Caps at 10MB per image,
 * 8s timeout. Returns null on any failure — caller continues without that
 * image rather than aborting the whole tool loop.
 */
export async function fetchImageBytes(
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  // Combine caller's abort with our timeout.
  const onParentAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onParentAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 10 * 1024 * 1024) return null;
    return { bytes: Buffer.from(ab), contentType: ct };
  } catch (err) {
    log.warn({ err: String(err), url }, 'image fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/** System-prompt fragment that teaches the model the tool format. */
export const WEB_SEARCH_TOOL_PROMPT = `You have access to one tool: \`web_search\`.

When you need information from the live web — current events, prices, recent papers, breaking news, OR pictures/images of something the user asked to see — call the tool by outputting EXACTLY this format on its own:

<tool_call>
{"name": "web_search", "arguments": {"query": "<short focused query>"}}
</tool_call>

Rules:
- Output the tool_call ALONE — no prose before or after.
- Use the tool only when truly needed; for general knowledge questions answer from your training data.
- For "show me a picture/photo/image of X" requests, ALWAYS call web_search with X as the query — the tool returns image results that the user will see.
- Keep queries short (under 10 words).
- After the tool returns results in a \`<tool_response>\` block (and any attached images), answer the user's question using them. Cite source titles inline like (TechCrunch). When images came back, briefly describe what they show.`;
