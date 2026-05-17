// Reproduces the "Monaco gets stuck on one code file" bug. Without the
// fixes, the cursor handler captures a stale activeFileId via closure, so
// when Monaco resets the cursor on a model swap (file change), the handler
// calls setSelection with a node from the *previous* file — and the editor
// dutifully reverts.
//
// Procedure: open Dog.ts, then in turn click Cat.ts, util.ts, Animal.ts,
// pausing briefly each time. The editor's title strip should show whatever
// file we *last* clicked, never reverting to Dog.ts (the first one).

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.resolve(ROOT, 'examples', 'sample-ts');
const OUT_DIR = path.resolve(ROOT, '.visual');
await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(`[PAGE ERROR] ${err.stack ?? err.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.fill('input[type="text"]', FIXTURE);
await page.click('button:has-text("Open")');
await page.waitForFunction(() => !!document.querySelector('canvas'));
await page.waitForTimeout(2000);
await page.evaluate(() => window.__codeGraph?.settle?.());

async function getEditorTitle() {
  return await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('div'));
    const candidate = all.find(
      (d) => d.textContent && /^src\/.+\.ts$/.test(d.textContent.trim()) && d.children.length === 0,
    );
    return candidate?.textContent?.trim() ?? null;
  });
}

async function clickFile(fileId) {
  const positions = await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? []);
  const pos = positions.find((p) => p.id === fileId);
  if (!pos) throw new Error(`No position for ${fileId}`);
  await page.mouse.click(pos.screenX, pos.screenY);
}

const sequence = ['src/Dog.ts', 'src/Cat.ts', 'src/util.ts', 'src/Animal.ts', 'src/index.ts'];
let failures = 0;

for (const target of sequence) {
  await clickFile(target);
  // Give Monaco enough time to swap model + emit any spurious cursor events,
  // and (crucially) for the bug's revert loop to fire if the closure is stale.
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__codeGraph?.settle?.());
  await page.waitForTimeout(200);
  const title = await getEditorTitle();
  const ok = title === target;
  console.log(`  click ${target.padEnd(20)} editor shows: ${title}${ok ? '' : '  ✗ REVERTED'}`);
  if (!ok) failures++;
}

await page.screenshot({ path: path.join(OUT_DIR, '14-after-no-revert-test.png') });

console.log(`\nresult: ${failures === 0 ? 'OK' : `${failures} reverts`}`);
console.log(`page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
