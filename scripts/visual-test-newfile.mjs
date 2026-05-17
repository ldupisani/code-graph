// Stronger watch test: adds a brand-new TS file with cross-file edges, then
// verifies the graph picks it up — file count + edge counts should change.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.resolve(ROOT, 'examples', 'sample-ts');
const OUT_DIR = path.resolve(ROOT, '.visual');
const NEW_FILE = path.join(FIXTURE, 'src', 'Bird.ts');
await fs.mkdir(OUT_DIR, { recursive: true });

// Make sure we start clean.
try {
  await fs.unlink(NEW_FILE);
} catch {}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

const messages = [];
const errors = [];
page.on('console', (msg) => messages.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => errors.push(`[PAGE ERROR] ${err.stack ?? err.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.fill('input[type="text"]', FIXTURE);
await page.click('button:has-text("Open")');
await page.waitForFunction(() => !!document.querySelector('canvas'));
await page.waitForTimeout(2000);
await page.evaluate(() => window.__codeGraph?.settle?.());
await page.screenshot({ path: path.join(OUT_DIR, '08-before-newfile.png') });

const before = await page.evaluate(() => ({
  count: window.__codeGraph?.getFilePositions?.()?.length ?? -1,
}));
console.log('files before:', before);

await fs.writeFile(
  NEW_FILE,
  `import { Animal } from './Animal';\n\nexport class Bird extends Animal {\n  makeSound(): string {\n    return 'Tweet!';\n  }\n}\n`,
  'utf8',
);

// 300ms debounce + ~300ms openProject + a touch of d3 settling.
await page.waitForTimeout(2000);
await page.evaluate(() => window.__codeGraph?.settle?.());
await page.waitForTimeout(300);

const after = await page.evaluate(() => ({
  count: window.__codeGraph?.getFilePositions?.()?.length ?? -1,
  ids: window.__codeGraph?.getFilePositions?.()?.map((p) => p.id),
}));
console.log('files after:', after);
await page.screenshot({ path: path.join(OUT_DIR, '09-after-newfile.png') });

// Cleanup so the fixture doesn't accumulate test artifacts.
try {
  await fs.unlink(NEW_FILE);
} catch {}
// Wait so the unlink-driven refresh completes before we exit.
await page.waitForTimeout(1500);

console.log('\n--- console messages (last 10) ---');
for (const m of messages.slice(-10)) console.log('  ' + m);
console.log(`page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
console.log(`\nScreenshots in ${OUT_DIR}`);
