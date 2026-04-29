import { _electron as electron } from 'playwright';
const app = await electron.launch({
  executablePath: '/Users/jameskim/Documents/GitHub/Glint/out/Glint-darwin-arm64/Glint.app/Contents/MacOS/Glint',
  args: [],
});
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');
console.log('main url:', main.url());
console.log('main title:', await main.title());

// Wait for runtime to spawn
console.log('waiting 30s for runtime warmup...');
await new Promise(r => setTimeout(r, 30000));

console.log('triggering capture via IPC...');
const result = await main.evaluate(async () => {
  return window.glint.invoke('capture:request', { x: 0, y: 0, width: 200, height: 200, displayId: 0 });
});
console.log('capture:', result);

const response = await app.waitForEvent('window', { timeout: 5000 }).catch(() => null);
if (!response) { console.log('NO RESPONSE WINDOW'); await app.close(); process.exit(1); }

const errors = [];
response.on('console', m => m.type()==='error' && errors.push(m.text()));
response.on('pageerror', e => errors.push('PAGE: '+e.message));
await response.waitForLoadState('domcontentloaded');

// Wait for streaming to complete (text route ≈ 3-8s + post-save async).
console.log('waiting 35s for stream completion...');
await new Promise(r => setTimeout(r, 35000));

const text = await response.evaluate(() => document.body.innerText.slice(0, 1500));
console.log('\nresponse window text (35s after capture):');
console.log(text);
console.log('\nerrors:', errors);

import fs from 'node:fs';
fs.mkdirSync('.diag', { recursive: true });
await response.screenshot({ path: '.diag/packaged-response.png' });
console.log('saved .diag/packaged-response.png');
await app.close();
