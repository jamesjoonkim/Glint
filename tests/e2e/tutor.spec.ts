import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Tutor mode smoke — verifies day-1 wiring:
 *   1. tutor:list-sessions IPC channel is registered in main + allowlisted in preload
 *   2. sessions.ts scans ~/.claude/projects/ without throwing
 *   3. returned shape matches the Session interface
 *
 * Does NOT verify the renderer UI (picker layout, click handlers) — those
 * are covered by visual inspection during dev. This test guards the IPC
 * pipeline since that's the regression-prone surface.
 */

interface Session {
  jsonlPath: string;
  cwd: string;
  primary: string;
  secondary?: string;
  sessionUuid: string;
  mtimeMs: number;
  sizeBytes: number;
  active: boolean;
}

async function launchGlint(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [path.resolve(__dirname, '../../.vite/build/index.js')],
    env: {
      ...process.env,
      GLINT_LLM: 'fake',
      GLINT_OCR: 'fake',
      NODE_ENV: 'test',
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

test.describe('tutor mode', () => {
  test('tutor:list-sessions returns array via IPC', async () => {
    const { app, win } = await launchGlint();

    const sessions = await win.evaluate(async () => {
      const api = (window as unknown as { glint?: { invoke: (c: string) => Promise<unknown> } }).glint;
      if (!api) throw new Error('glint preload not available');
      return (await api.invoke('tutor:list-sessions')) as unknown[];
    });

    expect(Array.isArray(sessions)).toBe(true);

    await app.close();
  });

  test('returned sessions match Session shape', async () => {
    const { app, win } = await launchGlint();

    const sessions = (await win.evaluate(async () => {
      const api = (window as unknown as { glint?: { invoke: (c: string) => Promise<unknown> } }).glint;
      if (!api) throw new Error('glint preload not available');
      return await api.invoke('tutor:list-sessions');
    })) as Session[];

    // Skip shape check if the host has no CC sessions — test still passes
    // the IPC roundtrip in that case.
    if (sessions.length === 0) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: 'no CC sessions on host; IPC roundtrip verified, shape skipped',
      });
      await app.close();
      return;
    }

    for (const s of sessions.slice(0, 3)) {
      expect(typeof s.jsonlPath, `jsonlPath: ${JSON.stringify(s)}`).toBe('string');
      expect(typeof s.cwd).toBe('string');
      expect(typeof s.primary).toBe('string');
      expect(typeof s.sessionUuid).toBe('string');
      expect(typeof s.mtimeMs).toBe('number');
      expect(typeof s.sizeBytes).toBe('number');
      expect(typeof s.active).toBe('boolean');
      expect(s.primary.length).toBeGreaterThan(0);
      // primary must NOT contain a slash (that's what secondary is for)
      expect(s.primary.includes('/')).toBe(false);
    }

    await app.close();
  });

  test('tutor:list-sessions sorts newest first', async () => {
    const { app, win } = await launchGlint();

    const sessions = (await win.evaluate(async () => {
      const api = (window as unknown as { glint?: { invoke: (c: string) => Promise<unknown> } }).glint;
      if (!api) throw new Error('glint preload not available');
      return await api.invoke('tutor:list-sessions');
    })) as Session[];

    if (sessions.length < 2) {
      await app.close();
      return;
    }

    for (let i = 1; i < sessions.length; i++) {
      const curr = sessions[i];
      const prev = sessions[i - 1];
      if (!curr || !prev) continue;
      expect(curr.mtimeMs).toBeLessThanOrEqual(prev.mtimeMs);
    }

    await app.close();
  });

  test('tutor:open spawns picker window and renders sessions', async () => {
    const { app, win } = await launchGlint();

    // Trigger tutor:open via IPC. Main process opens a fresh BrowserWindow.
    await win.evaluate(async () => {
      const api = (window as unknown as { glint?: { invoke: (c: string) => Promise<unknown> } }).glint;
      if (!api) throw new Error('glint preload not available');
      await api.invoke('tutor:open');
    });

    // Wait for the second window (the tutor) to appear.
    const tutorWin = await app.waitForEvent('window', {
      predicate: (p) => p.url().includes('view=tutor'),
      timeout: 5_000,
    });
    await tutorWin.waitForLoadState('domcontentloaded');

    // The picker heading must render.
    await expect(tutorWin.getByText('Sessions', { exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await expect(tutorWin.getByText('Lens', { exact: true })).toBeVisible();

    // Wait for the IPC roundtrip + render. At least one row should appear
    // if the host has any CC sessions; otherwise the empty state shows.
    await tutorWin.waitForFunction(
      () =>
        document.querySelector('[class*="empty"]') !== null ||
        document.querySelectorAll('button[class*="row"]').length > 0,
      { timeout: 5_000 },
    );

    // Capture screenshot for visual verification.
    await tutorWin.screenshot({
      path: 'test-results/tutor-picker.png',
      fullPage: false,
    });

    await app.close();
  });
});
