import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createLogger } from '../core/logger/index.js';
import { runOcr } from '../core/ocr/tesseract.js';
import { classify } from '../core/router/density.js';
import { loadPrompt } from '../core/models/prompts.js';
import {
  buildVisionMessage,
  streamCompletion,
  type ClientConfig,
  type ImagePart,
  type Message,
  type TextPart,
} from '../core/models/client.js';
import type { CaptureRecord } from './capture.js';
import { openResponse, getResponseWindow } from './windows/response.js';
import {
  appendTurn,
  createCaptureWithThread,
  getTurns,
  listRecent,
  setTags,
  setThreadTitle,
  setThumbnail,
} from '../core/history/store.js';
import { makeThumbnail } from '../core/history/thumbnails.js';
import { classifyTags } from '../core/threads/tags.js';
import { generateTitle } from '../core/threads/titles.js';
import { getSettings } from './settings.js';
import {
  fetchImageBytes,
  parseToolCall,
  tavilySearch,
  WEB_SEARCH_TOOL_PROMPT,
  type SearchResult,
} from './web-search.js';

const log = createLogger('pipeline');

export type PipelineDeps = {
  /** runtime URL for text model — null when GLINT_LLM=fake. */
  textUrl: string | null;
  /** runtime URL for vision model — null when not installed or fake. */
  visionUrl: string | null;
  /** model id used by the text route. */
  textModel: string;
  /** model id used by the vision route. */
  visionModel: string;
};

// mlx_lm.server uses 'default_model' to refer to whatever was passed via
// --model on the CLI. Each runtime process serves exactly one model, and we
// run separate processes for text + vision (different ports). The HF repo id
// stays in package.json#glint.models as the human-readable identifier; this
// constant is the wire-protocol value sent to the server.
const TEXT_MODEL_DEFAULT = 'default_model';
const VISION_MODEL_DEFAULT = 'default_model';

const DEFAULT_DEPS: PipelineDeps = {
  textUrl: null,
  visionUrl: null,
  textModel: TEXT_MODEL_DEFAULT,
  visionModel: VISION_MODEL_DEFAULT,
};

/** Produce a fresh stream id; opens the response window for it. */
export function startStream(): string {
  const streamId = randomUUID();
  openResponse(streamId);
  return streamId;
}

/**
 * Active AbortControllers, keyed by streamId. The IPC handler for
 * stream:cancel looks up the controller and calls abort(). pipeline
 * code path is the only writer; both runPipeline and continueThread
 * register on entry and clean up in the finally block.
 */
const activeControllers = new Map<string, AbortController>();

export function cancelStream(streamId: string): boolean {
  const controller = activeControllers.get(streamId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Continue an existing thread with a new user message. Streams the
 * assistant's reply back to the response window via the same IPC events
 * the initial answer uses, persists both turns to history.
 */
export async function continueThread(
  threadId: string,
  userMessage: string,
  deps: PipelineDeps = DEFAULT_DEPS,
): Promise<void> {
  const win = () => getResponseWindow();
  const send = (channel: string, payload: unknown) => {
    win()?.webContents.send(channel, payload);
  };
  const streamId = randomUUID();
  send('response:set-stream', { streamId });

  const controller = new AbortController();
  activeControllers.set(streamId, controller);

  try {
    appendTurn(threadId, 'user', userMessage);
  } catch (err) {
    log.warn({ err: String(err) }, 'append user turn failed');
  }

  try {
    const turns = getTurns(threadId);
    const capture = findCapturesForThread(threadId);
    const useVision =
      capture?.route === 'vision' &&
      !!deps.visionUrl &&
      capture.png_path;

    const { cfg, model, messages } = useVision
      ? await buildVisionFollowupRequest(capture!, turns, deps)
      : await buildTextFollowupRequest(capture, turns, deps);

    // Tool-call loop: stream once, look for <tool_call>, optionally execute
    // and re-stream with the tool result appended. Capped at maxIterations
    // (default 2) to prevent runaway loops.
    const finalAnswer = await streamWithToolLoop({
      cfg,
      model,
      messages,
      streamId,
      controller,
      send,
      deps,
    });

    const aborted = controller.signal.aborted;
    const final = aborted && finalAnswer ? `${finalAnswer}\n\n_[stopped]_` : finalAnswer;
    if (final) {
      appendTurn(threadId, 'assistant', final, useVision ? deps.visionModel : deps.textModel);
    }
    send('model:stream:done', { id: streamId });
  } catch (err) {
    log.error({ err: String(err), threadId }, 'continue thread failed');
    send('model:stream:error', { id: streamId, error: String(err) });
  } finally {
    activeControllers.delete(streamId);
  }
}

/**
 * Build the message array for a text-route follow-up. The original screenshot's
 * OCR transcription stands in for visual context when present. When the thread
 * was started via ⌘⇧Z (direct chat, no capture), we swap in the chat-only
 * system prompt so the model doesn't reference a non-existent screenshot.
 */
export async function buildTextFollowupRequest(
  capture: { ocr_text: string | null } | null,
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  deps: PipelineDeps,
): Promise<{ cfg: ClientConfig; model: string; messages: Message[] }> {
  const isChatOnly = !capture;
  const systemPrompt = await loadPrompt(isChatOnly ? 'answer-chat' : 'answer-text');
  const cfg: ClientConfig = { baseUrl: deps.textUrl ?? 'http://127.0.0.1:8765' };
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  if (capture?.ocr_text) {
    messages.push({
      role: 'user',
      content: `Original capture (${capture.ocr_text.length} chars OCR):\n\n${capture.ocr_text}`,
    });
  }
  for (const t of turns) messages.push({ role: t.role, content: t.content });
  return { cfg, model: deps.textModel, messages };
}

/**
 * Build the message array for a vision-route follow-up. Mirrors what
 * `runVisionRoute` sent for the initial answer: same system prompt, same
 * framing question, same image. The assistant's first response and any
 * subsequent exchanges follow as plain text turns.
 *
 * Per Qwen3-VL upstream guidance, the image is attached only on the first
 * user turn; the processor's chat template keeps visual tokens in the prompt
 * for every subsequent generation.
 */
export async function buildVisionFollowupRequest(
  capture: { png_path: string },
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  deps: PipelineDeps,
): Promise<{ cfg: ClientConfig; model: string; messages: Message[] }> {
  const systemPrompt = await loadPrompt('answer-vision');
  const cfg: ClientConfig = { baseUrl: deps.visionUrl ?? 'http://127.0.0.1:8766' };
  const initialUserMsg = await buildVisionMessage(
    capture.png_path,
    'What is on screen? Lead with one sentence describing the image, then explain anything actionable.',
  );
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    initialUserMsg,
  ];
  for (const t of turns) messages.push({ role: t.role, content: t.content });
  return { cfg, model: deps.visionModel, messages };
}

function findCapturesForThread(threadId: string) {
  // Most-recent capture for a thread (one per thread until v2.1).
  return listRecent(500).find((c) => c.thread_id === threadId) ?? null;
}

/**
 * Stream a completion. Detect `<tool_call>` in the response. If found AND
 * web search is enabled in settings, execute the tool and re-prompt with
 * the result. Repeat until the model returns a normal answer or we hit
 * maxIterations (settings, default 2).
 *
 * The first tokens are buffered while we decide whether the response is a
 * tool call: if `<tool_call>` appears within the first N chars, we suppress
 * emission; otherwise we flush and continue streaming normally.
 */
async function streamWithToolLoop(args: {
  cfg: ClientConfig;
  model: string;
  messages: Message[];
  streamId: string;
  controller: AbortController;
  send: (channel: string, payload: unknown) => void;
  /** Pipeline deps so the tool-loop can hot-swap to the vision endpoint
   *  when search returns images. */
  deps: PipelineDeps;
}): Promise<string> {
  const settings = getSettings();
  const webSearchOn =
    settings.webSearch.enabled && !!settings.webSearch.tavilyApiKey;
  const maxIterations = Math.max(1, settings.webSearch.maxIterations);

  const messages: Message[] = webSearchOn
    ? injectToolPrompt(args.messages)
    : args.messages;

  // Active client/model can flip from text → vision mid-loop when an
  // image-bearing search result arrives.
  let activeCfg = args.cfg;
  let activeModel = args.model;

  let lastVisibleAnswer = '';
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const { answer, suppressed } = await streamWithToolDetection(
      activeCfg,
      { model: activeModel, messages },
      args.controller.signal,
      args.streamId,
      args.send,
      webSearchOn,
    );

    if (args.controller.signal.aborted) return suppressed ? '' : answer;
    if (!suppressed) return answer;

    const tc = parseToolCall(answer);
    if (!tc || tc.name !== 'web_search') {
      args.send('model:stream:token', { id: args.streamId, chunk: answer });
      return answer;
    }
    const query = String((tc.arguments as { query?: unknown }).query ?? '').slice(0, 500);
    if (!query) {
      args.send('model:stream:token', {
        id: args.streamId,
        chunk: '_[web_search tool call had no query]_',
      });
      return '';
    }

    args.send('model:tool:web-search', { id: args.streamId, query });
    log.info({ query, iteration }, 'web_search tool dispatch');

    let results: SearchResult[];
    let imageUrls: string[];
    try {
      const resp = await tavilySearch(query, settings.webSearch.tavilyApiKey!, {
        maxResults: 5,
        includeImages: true,
        signal: args.controller.signal,
      });
      results = resp.results;
      imageUrls = resp.images.slice(0, 3);
    } catch (err) {
      log.warn({ err: String(err), query }, 'tavily search failed');
      const failureNote = `_[web search failed: ${String(err).slice(0, 120)}]_`;
      args.send('model:stream:token', { id: args.streamId, chunk: failureNote });
      return failureNote;
    }

    // Download top images concurrently. Failures are skipped — we feed back
    // whichever ones came down successfully.
    const imageParts: ImagePart[] = [];
    if (imageUrls.length > 0 && args.deps.visionUrl) {
      const downloaded = await Promise.all(
        imageUrls.map((u) => fetchImageBytes(u, args.controller.signal)),
      );
      for (const d of downloaded) {
        if (!d) continue;
        const b64 = d.bytes.toString('base64');
        imageParts.push({
          type: 'image_url',
          image_url: { url: `data:${d.contentType};base64,${b64}` },
        });
      }
      if (imageParts.length > 0) {
        log.info({ count: imageParts.length }, 'attached search images');
        // Hot-swap to vision so the model can see what came back.
        activeCfg = { baseUrl: args.deps.visionUrl ?? args.cfg.baseUrl };
        activeModel = args.deps.visionModel;
      }
    }

    // Append the model's tool call response, then the tool result. When
    // we have images, the user turn is multimodal: text JSON + image_urls.
    messages.push({ role: 'assistant', content: answer });
    const responseText = `<tool_response>\n${JSON.stringify(results, null, 2)}\n</tool_response>`;
    if (imageParts.length > 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: responseText }, ...imageParts],
      });
    } else {
      messages.push({ role: 'user', content: responseText });
    }
    lastVisibleAnswer = '';
  }

  const note = '\n\n_[hit web_search iteration cap; answering from what we have]_';
  args.send('model:stream:token', { id: args.streamId, chunk: note });
  return lastVisibleAnswer + note;
}

/**
 * Stream a single completion. Buffer the first ~120 chars to decide whether
 * this is a tool call (starts with optional whitespace then `<tool_call>`).
 * If it IS a tool call, suppress emission (the user shouldn't see the raw
 * tag). Otherwise flush the buffer and stream the rest normally.
 */
async function streamWithToolDetection(
  cfg: ClientConfig,
  req: { model: string; messages: Message[] },
  signal: AbortSignal,
  streamId: string,
  send: (channel: string, payload: unknown) => void,
  toolsEnabled: boolean,
): Promise<{ answer: string; suppressed: boolean }> {
  const stream = streamCompletion(cfg, req, signal);
  let answer = '';
  let buffer = '';
  let decided = false;
  let suppressed = false;

  for await (const tok of stream) {
    answer += tok;

    if (!toolsEnabled) {
      // Tools off → straight passthrough. No buffering needed.
      send('model:stream:token', { id: streamId, chunk: tok });
      continue;
    }

    if (!decided) {
      buffer += tok;
      if (buffer.length >= 120 || buffer.includes('>')) {
        const trimmed = buffer.trimStart();
        if (trimmed.startsWith('<tool_call>')) {
          suppressed = true;
        } else {
          send('model:stream:token', { id: streamId, chunk: buffer });
        }
        decided = true;
      }
      continue;
    }

    if (suppressed) continue; // accumulate into `answer`, don't emit
    send('model:stream:token', { id: streamId, chunk: tok });
  }

  // Stream ended before we decided (very short response).
  if (!decided && !suppressed && buffer) {
    send('model:stream:token', { id: streamId, chunk: buffer });
  }

  return { answer, suppressed };
}

function injectToolPrompt(messages: Message[]): Message[] {
  // Concatenate the tool prompt onto the first system message so we don't
  // emit two consecutive system roles (some chat-template implementations
  // collapse those, others duplicate them — concatenation sidesteps both).
  let injected = false;
  return messages.map((m) => {
    if (!injected && m.role === 'system' && typeof m.content === 'string') {
      injected = true;
      return { role: 'system', content: `${m.content}\n\n${WEB_SEARCH_TOOL_PROMPT}` };
    }
    return m;
  });
}

/**
 * Run a "composed turn" — a single user message that bundles N attached
 * images plus optional text, producing ONE assistant response that sees all
 * images at once. Used by the chat input's deferred-attachments flow.
 *
 * Compared to runPipeline (per-capture) and continueThread (text-only):
 * - Multiple images go into the SAME user-turn content array as image_url
 *   parts, so Qwen3-VL gets all of them in a single attention pass and can
 *   compare/contrast.
 * - The user-visible text turn (saved in DB) is the user's actual prompt
 *   (or a placeholder if image-only), keeping the conversation log readable.
 * - Prior turns are included as text-only context — image-stickiness is
 *   handled by previously composed turns having their images encoded in
 *   their assistant responses (the "image only on first turn" rule applies
 *   per turn-cluster, not per thread).
 */
export async function runComposedTurn(args: {
  threadId: string;
  pngPaths: string[];
  text: string;
  deps?: PipelineDeps;
}): Promise<{ streamId: string }> {
  const deps = args.deps ?? DEFAULT_DEPS;
  const win = () => getResponseWindow();
  const send = (channel: string, payload: unknown) => {
    win()?.webContents.send(channel, payload);
  };

  const streamId = randomUUID();
  send('response:set-stream', { streamId });

  const controller = new AbortController();
  activeControllers.set(streamId, controller);

  try {
    // Save the user-visible text turn. Image-only sends use a placeholder
    // so the turn list shows something for the user bubble.
    const userVisible = args.text.trim()
      ? args.text
      : `[${args.pngPaths.length} image${args.pngPaths.length === 1 ? '' : 's'} attached]`;
    appendTurn(args.threadId, 'user', userVisible);

    const hasImages = args.pngPaths.length > 0;
    const useVision = hasImages && !!deps.visionUrl;
    const allTurns = getTurns(args.threadId);
    // Exclude the user turn we just appended — we'll add it as a multimodal
    // message below for the vision path, or as a text user turn for text path.
    const priorTurns = allTurns.slice(0, -1);

    let cfg: ClientConfig;
    let model: string;
    let messages: Message[];

    if (useVision) {
      const systemPrompt = await loadPrompt('answer-vision');
      cfg = { baseUrl: deps.visionUrl ?? 'http://127.0.0.1:8766' };
      model = deps.visionModel;

      const userParts: Array<TextPart | ImagePart> = [];
      for (const pngPath of args.pngPaths) {
        const bytes = await fs.readFile(pngPath);
        const b64 = bytes.toString('base64');
        userParts.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${b64}` },
        });
      }
      userParts.push({
        type: 'text',
        text: args.text.trim() || 'Describe and analyze the attached image(s).',
      });

      messages = [
        { role: 'system', content: systemPrompt },
        ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userParts },
      ];
    } else {
      // No images, or vision runtime unavailable → fall back to text path.
      const systemPrompt = await loadPrompt('answer-chat');
      cfg = { baseUrl: deps.textUrl ?? 'http://127.0.0.1:8765' };
      model = deps.textModel;

      messages = [
        { role: 'system', content: systemPrompt },
        ...allTurns.map((t) => ({ role: t.role, content: t.content })),
      ];
    }

    log.info(
      { threadId: args.threadId, images: args.pngPaths.length, hasText: !!args.text, useVision },
      'composed turn dispatch',
    );

    const finalAnswer = await streamWithToolLoop({
      cfg,
      model,
      messages,
      streamId,
      controller,
      send,
      deps,
    });

    const aborted = controller.signal.aborted;
    const final = aborted && finalAnswer ? `${finalAnswer}\n\n_[stopped]_` : finalAnswer;
    if (final) appendTurn(args.threadId, 'assistant', final, model);
    send('model:stream:done', { id: streamId });
  } catch (err) {
    log.error({ err: String(err), threadId: args.threadId }, 'composed turn failed');
    send('model:stream:error', { id: streamId, error: String(err) });
  } finally {
    activeControllers.delete(streamId);
  }

  return { streamId };
}

/**
 * Run the full text-route pipeline for a single capture.
 * Streams tokens to the response window via IPC events.
 */
export async function runPipeline(
  capture: CaptureRecord,
  streamId: string,
  deps: PipelineDeps = DEFAULT_DEPS,
  /** When set, attach the capture row to this existing thread instead of
   *  minting a new one. Used by the in-chat `+` button via
   *  capture:openForThread → capture:request. */
  intoThreadId: string | null = null,
): Promise<void> {
  const win = () => getResponseWindow();
  const send = (channel: string, payload: unknown) => {
    win()?.webContents.send(channel, payload);
  };

  const controller = new AbortController();
  activeControllers.set(streamId, controller);

  try {
    const ocr = await runOcr(capture.pngPath);
    const wPx = capture.bbox.width;
    const hPx = capture.bbox.height;
    const decision = classify({
      charCount: ocr.charCount,
      ocrConfidence: ocr.confidence,
      imagePixels: wPx * hPx,
    });

    log.info(
      { id: capture.id, route: decision.route, density: decision.density.toFixed(3), reason: decision.reason, intoThreadId },
      'router decision',
    );

    // Persist capture (and a new thread if intoThreadId is null).
    // createCaptureWithThread skips the thread INSERT when threadId is
    // passed, so the same call covers both flows.
    let dbCaptureId: string | null = null;
    let dbThreadId: string | null = null;
    try {
      const { capture: row, thread } = createCaptureWithThread({
        pngPath: capture.pngPath,
        ocrText: ocr.text,
        ocrConfidence: ocr.confidence,
        textDensity: decision.density,
        route: decision.route,
        threadId: intoThreadId ?? undefined,
      });
      dbCaptureId = row.id;
      dbThreadId = thread.id;
      send('response:set-thread', { threadId: thread.id });
    } catch (err) {
      log.error({ err: String(err) }, 'history persist failed');
    }

    let answer = '';
    const onTok = (chunk: string) => {
      answer += chunk;
      send('model:stream:token', { id: streamId, chunk });
    };

    // Vision-route fallback: if vision runtime isn't available (most common
    // case until first-run wizard wires up mlx_vlm), the text-LLM still does
    // a useful job describing the OCR'd text + any visible structure. That
    // beats showing 'Vision model not installed' to a user who just wanted
    // their screenshot explained.
    const canVision = !!deps.visionUrl || process.env.GLINT_LLM === 'fake';
    if (decision.route === 'vision' && canVision) {
      await runVisionRoute(capture, streamId, deps, onTok, controller.signal);
    } else {
      if (decision.route === 'vision') {
        log.info({ id: capture.id }, 'vision unavailable — falling through to text route');
      }
      await runTextRoute(capture, ocr, streamId, deps, onTok, controller.signal);
    }

    // Persist the assistant turn BEFORE notifying done.
    if (dbCaptureId && dbThreadId) {
      const aborted = controller.signal.aborted;
      const final = aborted && answer ? `${answer}\n\n_[stopped]_` : answer;
      if (final) {
        try {
          appendTurn(dbThreadId, 'assistant', final, deps.textModel);
        } catch (err) {
          log.warn({ err: String(err) }, 'append assistant turn failed');
        }
      }
    }
    send('model:stream:done', { id: streamId });

    if (dbCaptureId && dbThreadId) {
      // Async post-save: thumbnail, tags, title. None block the user.
      void postSaveBackground({
        captureId: dbCaptureId,
        threadId: dbThreadId,
        pngPath: capture.pngPath,
        ocrText: ocr.text,
        answer,
        deps,
      });
    }
  } catch (err) {
    log.error({ err: String(err), id: capture.id }, 'pipeline failed');
    send('model:stream:error', { id: streamId, error: String(err) });
  } finally {
    activeControllers.delete(streamId);
  }
}

type PostSaveArgs = {
  captureId: string;
  threadId: string;
  pngPath: string;
  ocrText: string;
  answer: string;
  deps: PipelineDeps;
};

async function postSaveBackground(args: PostSaveArgs): Promise<void> {
  const cfg: ClientConfig = { baseUrl: args.deps.textUrl ?? 'http://127.0.0.1:8765' };

  await Promise.allSettled([
    makeThumbnail(args.pngPath)
      .then((thumb) => setThumbnail(args.captureId, thumb))
      .catch((err) => log.warn({ err: String(err) }, 'thumbnail failed')),

    classifyTags({ ocrText: args.ocrText, client: cfg, model: args.deps.textModel })
      .then((tags) => setTags(args.captureId, tags))
      .catch((err) => log.warn({ err: String(err) }, 'tag classify failed')),

    generateTitle({
      ocrText: args.ocrText,
      answerText: args.answer,
      client: cfg,
      model: args.deps.textModel,
    })
      .then((title) => setThreadTitle(args.threadId, title))
      .catch((err) => log.warn({ err: String(err) }, 'title gen failed')),
  ]);
}

async function runTextRoute(
  capture: CaptureRecord,
  ocr: Awaited<ReturnType<typeof runOcr>>,
  _streamId: string,
  deps: PipelineDeps,
  onTok: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const systemPrompt = await loadPrompt('answer-text');
  const cfg: ClientConfig = { baseUrl: deps.textUrl ?? 'http://127.0.0.1:8765' };

  const lowConfidence = ocr.confidence < 50 || ocr.charCount < 20;
  const userMessage = lowConfidence
    ? `The user captured a region of their screen (${capture.bbox.width}×${capture.bbox.height}px). OCR was uncertain (${ocr.charCount} chars, conf ${ocr.confidence.toFixed(0)}). Best-effort extracted text follows — explain what the screenshot is likely about, including any visible UI elements or structure suggested by the text.\n\n---\n${ocr.text || '(no text recognized)'}`
    : `OCR (${ocr.charCount} chars, conf ${ocr.confidence.toFixed(0)}):\n\n${ocr.text}`;

  const stream = streamCompletion(cfg, {
    model: deps.textModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  }, signal);
  for await (const tok of stream) onTok(tok);
}

async function runVisionRoute(
  capture: CaptureRecord,
  _streamId: string,
  deps: PipelineDeps,
  onTok: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!deps.visionUrl && process.env.GLINT_LLM !== 'fake') {
    onTok(
      '**Vision model not installed.**\n\nThis capture was routed to the vision path (low text density) but the Qwen2-VL model isn\'t available. Install it from Settings → Models, or rerun the capture on a text-heavy region.',
    );
    return;
  }

  const systemPrompt = await loadPrompt('answer-vision');
  const userMsg = await buildVisionMessage(
    capture.pngPath,
    'What is on screen? Lead with one sentence describing the image, then explain anything actionable.',
  );

  const cfg: ClientConfig = { baseUrl: deps.visionUrl ?? 'http://127.0.0.1:8766' };
  const stream = streamCompletion(cfg, {
    model: deps.visionModel,
    messages: [{ role: 'system', content: systemPrompt }, userMsg],
  }, signal);
  for await (const tok of stream) onTok(tok);
}

// keep randomUUID import used (avoid unused-warning when scope shifts)
void randomUUID;
