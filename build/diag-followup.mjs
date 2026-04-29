import { _electron as electron } from 'playwright';
const app = await electron.launch({
  executablePath: '/Users/jameskim/Documents/GitHub/Glint/out/Glint-darwin-arm64/Glint.app/Contents/MacOS/Glint',
  args: [],
});
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');
console.log('waiting 30s for runtime...');
await new Promise(r => setTimeout(r, 30000));

const cap = await main.evaluate(() =>
  window.glint.invoke('capture:request', { x:0,y:0,width:200,height:200,displayId:0 })
);
console.log('capture:', cap);
const response = await app.waitForEvent('window', { timeout: 5000 });
await response.waitForLoadState('domcontentloaded');

console.log('waiting 25s for first answer...');
await new Promise(r => setTimeout(r, 25000));

const first = await response.evaluate(() => document.body.innerText.length);
console.log('text length after first answer:', first);

console.log('typing follow-up...');
const replyOk = await response.evaluate(async () => {
  const input = document.querySelector('input[type=text]');
  if (!input || input.disabled) return { ok: false, reason: 'input not enabled' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'in two words, what was your previous answer about?');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // Submit form
  const form = input.closest('form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return { ok: true };
});
console.log('reply submit:', replyOk);

console.log('waiting 25s for follow-up answer...');
await new Promise(r => setTimeout(r, 25000));

const final = await response.evaluate(() => document.body.innerText.slice(0, 1500));
console.log('\nfinal text:');
console.log(final);

import fs from 'node:fs';
await response.screenshot({ path: '.diag/followup.png' });
await app.close();
