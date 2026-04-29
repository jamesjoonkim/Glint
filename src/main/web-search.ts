import { createLogger } from '../core/logger/index.js';

const log = createLogger('web-search');

export type SearchResult = {
  title: string;
  url: string;
  content: string;
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
 * Execute a Tavily search. Returns a list of results suitable for feeding
 * back to the model as a `<tool_response>` user turn.
 */
export async function tavilySearch(
  query: string,
  apiKey: string,
  maxResults: number = 5,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tavily ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: Array<Partial<SearchResult>> };
  const results = (data.results ?? [])
    .filter((r) => typeof r.title === 'string' && typeof r.url === 'string')
    .map((r) => ({
      title: r.title as string,
      url: r.url as string,
      content: typeof r.content === 'string' ? r.content : '',
    }))
    .slice(0, maxResults);
  log.info({ query, count: results.length }, 'tavily search complete');
  return results;
}

/** System-prompt fragment that teaches the model the tool format. */
export const WEB_SEARCH_TOOL_PROMPT = `You have access to one tool: \`web_search\`.

When you need information that may have changed since training, or facts you don't reliably know (current events, prices, recent papers, breaking news), call the tool by outputting EXACTLY this format on its own:

<tool_call>
{"name": "web_search", "arguments": {"query": "<short focused query>"}}
</tool_call>

Rules:
- Output the tool_call ALONE — no prose before or after.
- Use the tool only when truly needed; for general knowledge questions answer from your training data.
- Keep queries short (under 10 words).
- After the tool returns results in a \`<tool_response>\` block, answer the user's question using those results, citing source titles inline like (TechCrunch).`;
