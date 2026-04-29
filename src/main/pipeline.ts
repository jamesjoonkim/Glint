import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger/index.js';
import { runOcr } from '../core/ocr/tesseract.js';
import { classify } from '../core/router/density.js';
import { loadPrompt } from '../core/models/prompts.js';
import { streamCompletion, type ClientConfig } from '../core/models/client.js';
import type { CaptureRecord } from './capture.js';
import { openResponse, getResponseWindow } from './windows/response.js';

const log = createLogger('pipeline');

export type PipelineDeps = {
  /** runtime URL — null when GLINT_LLM=fake. */
  modelUrl: string | null;
  /** model id used by the text route. */
  textModel: string;
};

const TEXT_MODEL_DEFAULT = 'mlx-community/Qwen2.5-7B-Instruct-4bit';

/** Produce a fresh stream id; opens the response window for it. */
export function startStream(): string {
  const streamId = randomUUID();
  openResponse(streamId);
  return streamId;
}

/**
 * Run the full text-route pipeline for a single capture.
 * Streams tokens to the response window via IPC events.
 */
export async function runPipeline(
  capture: CaptureRecord,
  streamId: string,
  deps: PipelineDeps = { modelUrl: null, textModel: TEXT_MODEL_DEFAULT },
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
      { id: capture.id, route: decision.route, density: decision.density.toFixed(3), reason: decision.reason },
      'router decision',
    );

    if (decision.route === 'vision') {
      // Vision route lands in P2. For now emit a placeholder.
      send('model:stream:token', {
        id: streamId,
        chunk: 'Vision route detected. (Qwen2-VL integration ships in P2.)\n\n',
      });
      send('model:stream:token', {
        id: streamId,
        chunk: `OCR text density: ${decision.density.toFixed(2)} chars/kpx — ${decision.reason}.`,
      });
      send('model:stream:done', { id: streamId });
      return;
    }

    const systemPrompt = await loadPrompt('answer-text');
    const cfg: ClientConfig = { baseUrl: deps.modelUrl ?? 'http://127.0.0.1:8765' };
    const stream = streamCompletion(cfg, {
      model: deps.textModel,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `OCR (${ocr.charCount} chars, conf ${ocr.confidence.toFixed(0)}):\n\n${ocr.text}`,
        },
      ],
    });

    for await (const tok of stream) {
      send('model:stream:token', { id: streamId, chunk: tok });
    }
    send('model:stream:done', { id: streamId });
  } catch (err) {
    log.error({ err: String(err), id: capture.id }, 'pipeline failed');
    send('model:stream:error', { id: streamId, error: String(err) });
  }
}
