// Drives the watch/refresh flow end-to-end. Opens the fixture in the browser,
// pans the camera, then edits a file on disk and verifies the graph re-loads
// without losing the camera position.

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

// Pan the canvas with a manual drag so we can see whether the camera stays.
const canvas = await page.$('canvas');
const box = await canvas.boundingBox();
const startX = box.x + box.width * 0.5;
const startY = box.y + box.height * 0.5;
await page.mouse.move(startX, startY);
await page.mouse.down();
await page.mouse.move(startX - 250, startY - 100, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);

const beforeCam = await page.evaluate(() => {
  const layout = window.__codeGraph;
  return { scale: layout?.getCameraScale?.() };
});
console.log('camera before edit:', beforeCam);
await page.screenshot({ path: path.join(OUT_DIR, '06-watch-before.png') });

// Edit a file on disk. The watcher should fire, the client should debounce
// 300ms, refetch the project, and apply via refreshProject.
const target = path.join(FIXTURE, 'src', 'util.ts');
const before = await fs.readFile(target, 'utf8');
await fs.writeFile(target, before + `\n// edited by visual-test-watch ${Date.now()}\n`, 'utf8');

// Wait for the refresh round-trip
await page.waitForTimeout(1500);
await page.evaluate(() => window.__codeGraph?.settle?.());
await page.waitForTimeout(300);

const afterCam = await page.evaluate(() => {
  const layout = window.__codeGraph;
  return { scale: layout?.getCameraScale?.() };
});
console.log('camera after edit:', afterCam);
await page.screenshot({ path: path.join(OUT_DIR, '07-watch-after.png') });

console.log('\n--- console messages (last 20) ---');
for (const m of messages.slice(-20)) console.log('  ' + m);
console.log(`page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
console.log(`\nScreenshots in ${OUT_DIR}`);
