import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';

/**
 * End-to-end smoke for the capture → response pipeline. Drives the bundled
 * .vite/build entry, fires a synthetic capture:request via IPC, waits for the
 * response window, and verifies React actually paints content (not the empty
 * shell that bit us when 'response:set-thread' wasn't on the preload
 * push-channel allowlist).
 *
 * GLINT_LLM=fake → ModelClient yields a fixture stream, no real model needed.
 */

test('capture opens a response window that renders content', async () => {
  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../.vite/build/index.js')],
    env: {
      ...process.env,
      GLINT_LLM: 'fake',
      GLINT_OCR: 'fake',
      NODE_ENV: 'test',
    },
  });

  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await expect(main).toHaveTitle('Glint', { timeout: 10_000 });

  // Synthesize a capture (no real screen recording — IPC handler still runs
  // through capture:request → openResponse → runPipeline).
  const result = await main.evaluate(() =>
    (window as unknown as {
      glint: { invoke: (c: string, p?: unknown) => Promise<unknown> };
    }).glint.invoke('capture:request', {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      displayId: 0,
    }),
  );
  expect(result).toMatchObject({ ok: true });

  // Response window must open within 5s.
  const response = await app.waitForEvent('window', { timeout: 5_000 });

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  response.on('pageerror', (e) => pageErrors.push(e.message));
  response.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await response.waitForLoadState('domcontentloaded');

  // Critical: React must mount. Empty #root means an early throw bricked the
  // render — that's the bug the response:set-thread allowlist mismatch hit.
  await response.waitForFunction(
    () => (document.getElementById('root')?.children.length ?? 0) > 0,
    null,
    { timeout: 5_000 },
  );

  // The Header component should be present (ResponseWindow renders it
  // unconditionally, regardless of stream state).
  const hasHeader = await response.evaluate(
    () => !!document.querySelector('header'),
  );
  expect(hasHeader, 'response window should render <header>').toBe(true);

  // No JS errors before the renderer painted.
  expect(pageErrors, `pageerrors: ${pageErrors.join('; ')}`).toHaveLength(0);
  expect(
    consoleErrors,
    `console errors: ${consoleErrors.join('; ')}`,
  ).toHaveLength(0);

  await app.close();
});
