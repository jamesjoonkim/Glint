import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger/index.js';
import { runOcr } from '../core/ocr/tesseract.js';
import { classify } from '../core/router/density.js';
import { loadPrompt } from '../core/models/prompts.js';
import {
  buildVisionMessage,
  streamCompletion,
  type ClientConfig,
  type Message,
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

  try {
    appendTurn(threadId, 'user', userMessage);
  } catch (err) {
    log.warn({ err: String(err) }, 'append user turn failed');
  }

  let answer = '';
  const onTok = (chunk: string) => {
    answer += chunk;
    send('model:stream:token', { id: streamId, chunk });
  };

  try {
    const turns = getTurns(threadId);
    const capture = findCapturesForThread(threadId);
    // Vision-route follow-ups need the actual image, not just OCR. Per Qwen3-VL
    // guidance the image goes on the FIRST user turn only — the model retains
    // visual context through the conversation history without re-attachment.
    const useVision =
      capture?.route === 'vision' &&
      !!deps.visionUrl &&
      capture.png_path;

    const { cfg, model, messages } = useVision
      ? await buildVisionFollowupRequest(capture!, turns, deps)
      : await buildTextFollowupRequest(capture, turns, deps);

    const stream = streamCompletion(cfg, { model, messages });
    for await (const tok of stream) onTok(tok);

    // Persist the assistant turn BEFORE notifying done — see runPipeline for
    // the race-condition rationale.
    appendTurn(threadId, 'assistant', answer, useVision ? deps.visionModel : deps.textModel);
    send('model:stream:done', { id: streamId });
  } catch (err) {
    log.error({ err: String(err), threadId }, 'continue thread failed');
    send('model:stream:error', { id: streamId, error: String(err) });
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
      await runVisionRoute(capture, streamId, deps, onTok);
    } else {
      if (decision.route === 'vision') {
        log.info({ id: capture.id }, 'vision unavailable — falling through to text route');
      }
      await runTextRoute(capture, ocr, streamId, deps, onTok);
    }

    // Persist the assistant turn BEFORE notifying done — the renderer reacts
    // to done by refetching turns, and we don't want that fetch to race the
    // DB write. better-sqlite3 is synchronous so this is microseconds.
    if (dbCaptureId && dbThreadId) {
      try {
        appendTurn(dbThreadId, 'assistant', answer, deps.textModel);
      } catch (err) {
        log.warn({ err: String(err) }, 'append assistant turn failed');
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
): Promise<void> {
  const systemPrompt = await loadPrompt('answer-text');
  const cfg: ClientConfig = { baseUrl: deps.textUrl ?? 'http://127.0.0.1:8765' };

  // For low-confidence OCR (vision-route fallback), tell the model what we
  // know about the capture so it can explain context the text alone misses.
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
  });
  for await (const tok of stream) onTok(tok);
}

async function runVisionRoute(
  capture: CaptureRecord,
  _streamId: string,
  deps: PipelineDeps,
  onTok: (chunk: string) => void,
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
  });
  for await (const tok of stream) onTok(tok);
}

// keep randomUUID import used (avoid unused-warning when scope shifts)
void randomUUID;
