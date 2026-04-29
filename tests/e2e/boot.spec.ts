import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';

/**
 * Boot smoke test — exists specifically to catch packaging regressions like
 * the better-sqlite3 native-module bug from the v2 alpha. If this fails, the
 * packaged DMG won't run; do not ship.
 *
 * Runs against the prepared .vite/build output. Use GLINT_LLM=fake so the
 * suite never spawns a real Python runtime.
 */

test.describe('boot smoke', () => {
  test('packaged main process loads without missing native modules', async () => {
    const app = await electron.launch({
      args: [path.resolve(__dirname, '../../.vite/build/index.js')],
      env: {
        ...process.env,
        GLINT_LLM: 'fake',
        GLINT_OCR: 'fake',
        NODE_ENV: 'test',
      },
    });

    // First window must appear within the default timeout. If the main
    // process throws on a missing module, this hangs and fails — exactly
    // the failure mode of the better-sqlite3 packaging bug.
    const mainWindow = await app.firstWindow();

    const errors: string[] = [];
    mainWindow.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    // Wait for the renderer to actually load (DOM ready). The bug we're
    // protecting against is "main process exits before window paints" —
    // if that happens, this wait throws.
    await mainWindow.waitForLoadState('domcontentloaded');

    // Diagnostic: surface the URL + inner HTML in the failure message so
    // future regressions tell us which window we got, not just an empty
    // title we have to guess at.
    const url = mainWindow.url();
    const head = await mainWindow.evaluate(() => document.head?.innerHTML?.slice(0, 200) ?? '<no head>');
    test.info().attach('main-window-url', { body: url, contentType: 'text/plain' });
    test.info().attach('main-window-head', { body: head, contentType: 'text/plain' });

    // Title is set in src/renderer/index.html. Use polling toHaveTitle
    // with a generous timeout — the renderer window can take a beat to
    // execute the head.
    await expect(mainWindow, `url=${url}\nhead=${head}`).toHaveTitle('Glint', { timeout: 15_000 });

    // Sanity: the contextBridge exposed our typed IPC. This is the bit
    // that proves preload ran successfully (which itself requires main
    // to be alive past whenReady).
    const hasGlintApi = await mainWindow.evaluate(
      () => typeof (window as unknown as { glint?: unknown }).glint === 'object',
    );
    expect(hasGlintApi).toBe(true);

    // ping round-trips through IPC (proves preload + main wiring).
    const pong = await mainWindow.evaluate(() =>
      (window as unknown as { glint: { ping: () => Promise<string> } }).glint.ping(),
    );
    expect(pong).toBe('pong');

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);

    await app.close();
  });

  test('better-sqlite3 native binding is present in app.asar.unpacked', async () => {
    // Direct file-system check — kept separate from the launch test so it
    // fails fast with a clear message before paying the Electron startup cost.
    const fs = await import('node:fs');
    const candidates = [
      // dev: lives in the project's node_modules
      path.resolve(
        __dirname,
        '../../node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      ),
      // packaged: forge afterCopy hook drops it here
      path.resolve(
        __dirname,
        '../../out/Glint-darwin-arm64/Glint.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      ),
    ];

    const present = candidates.filter((p) => fs.existsSync(p));
    expect(
      present.length,
      `better_sqlite3.node missing — checked:\n${candidates.join('\n')}`,
    ).toBeGreaterThan(0);
  });
});
