// Quick test that expands src/index.ts (which contains the `new Cat('Whiskers')`
// the user pointed at) so the resulting screenshot shows the new "new Cat"
// label with the StringLiteral as its only child.

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

const positions = await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? []);
const idx = positions.find((p) => p.id === 'src/index.ts');
await page.mouse.click(idx.screenX, idx.screenY);
await page.waitForTimeout(3500);
await page.evaluate(() => window.__codeGraph?.settle?.());

// Pan so the expanded index.ts lands roughly centred in the viewport.
const settled = (await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? [])).find(
  (p) => p.id === 'src/index.ts',
);
if (settled) {
  const target = { x: 700, y: 380 };
  const dx = target.x - settled.screenX;
  const dy = target.y - settled.screenY;
  await page.mouse.move(700, 700);
  await page.mouse.down();
  await page.mouse.move(700 + dx, 700 + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}
await page.screenshot({ path: path.join(OUT_DIR, '15-index-expanded.png') });

console.log(`page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
console.log('Screenshot: 15-index-expanded.png');
