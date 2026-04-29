#!/usr/bin/env node
/**
 * Drive the packaged app via Playwright Electron and inspect what
 * actually appears in the response window after a capture.
 */
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const ENTRY = path.join(ROOT, '.vite', 'build', 'index.js');

const out = path.join(ROOT, '.diag');
fs.mkdirSync(out, { recursive: true });

console.log('launching packaged main entry:', ENTRY);
const app = await electron.launch({
  args: [ENTRY],
  env: { ...process.env, GLINT_LLM: 'fake', GLINT_OCR: 'fake', NODE_ENV: 'test' },
});

const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');
console.log('main window url:', main.url());
console.log('main title:', await main.title());

// Trigger a capture via IPC — simulates ⌘⇧X
const result = await app.evaluate(async ({ ipcMain }) => {
  // Synthesize a capture:request handler call.
  // The handler returns { ok, id, streamId } and opens the response window.
  // We can't call ipcMain.handle directly; instead we invoke the bridge
  // by injecting into the main window which has window.glint.invoke.
  return null; // we'll call from the renderer side
});

// From the main window, ask main process to start a capture:
console.log('triggering capture from main window...');
const capture = await main.evaluate(async () => {
  return window.glint.invoke('capture:request', { x: 0, y: 0, width: 200, height: 200, displayId: 0 });
});
console.log('capture result:', capture);

// Wait for response window to open
console.log('waiting for response window...');
const response = await app.waitForEvent('window', { timeout: 5000 }).catch(() => null);

if (!response) {
  console.log('NO RESPONSE WINDOW OPENED');
  await app.close();
  process.exit(1);
}

// Subscribe to errors BEFORE load completes.
const consoleMsgs = [];
const pageErrors = [];
response.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
response.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));

await response.waitForLoadState('domcontentloaded');
console.log('response url:', response.url());
console.log('response title:', await response.title());

// Wait a beat for React + useEffect subscriptions
await new Promise((r) => setTimeout(r, 1500));

// Dump DOM
const html = await response.evaluate(() => document.body?.innerHTML ?? '<no body>');
fs.writeFileSync(path.join(out, 'response-body.html'), html);
console.log('saved response-body.html (' + html.length + ' chars)');

const fullPage = await response.content();
fs.writeFileSync(path.join(out, 'response-full.html'), fullPage);

const mainPage = await main.content();
fs.writeFileSync(path.join(out, 'main-full.html'), mainPage);

// Network + script details
const responseResources = await response.evaluate(() => {
  return {
    scripts: Array.from(document.scripts).map((s) => ({ src: s.src, type: s.type, hasContent: !!s.text })),
    links: Array.from(document.querySelectorAll('link')).map((l) => ({ rel: l.rel, href: l.href })),
    location: { href: location.href, origin: location.origin, search: location.search },
  };
});
console.log('\nresponse window resources:', JSON.stringify(responseResources, null, 2));

const mainResources = await main.evaluate(() => {
  return {
    scripts: Array.from(document.scripts).map((s) => ({ src: s.src })),
    rootChildren: document.getElementById('root')?.children.length ?? 0,
  };
});
console.log('\nmain window resources:', JSON.stringify(mainResources, null, 2));

// Save screenshot
await response.screenshot({ path: path.join(out, 'response.png') });
console.log('saved response.png');

// Dump key DOM facts
const facts = await response.evaluate(() => {
  const root = document.getElementById('root');
  return {
    rootChildCount: root?.children.length ?? 0,
    rootInnerLength: root?.innerHTML.length ?? 0,
    bodyClass: document.body.className,
    rootClass: root?.className,
    hasHeader: !!document.querySelector('header'),
    hasMain: !!document.querySelector('main'),
    hasReplyInput: !!document.querySelector('input'),
    visibleText: (document.body.innerText || '').slice(0, 500),
  };
});
console.log('DOM facts:', JSON.stringify(facts, null, 2));

console.log('\nCONSOLE MESSAGES (' + consoleMsgs.length + '):');
for (const m of consoleMsgs) console.log('  ' + m);

console.log('\nPAGE ERRORS (' + pageErrors.length + '):');
for (const e of pageErrors) console.log('  ' + e);

await app.close();
console.log('done. inspect .diag/');
