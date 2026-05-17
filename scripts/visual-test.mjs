// Visual smoke test driven by Playwright. Boots a Chromium instance against
// a running dev server, opens the fixture project, and captures screenshots
// at meaningful interaction points. Console + page errors are streamed to
// stdout so a failing render is loud rather than silent.
//
// Usage: assume `npm run dev` is already running on :5173, then
//   node scripts/visual-test.mjs
// Outputs to .visual/*.png and prints a summary at the end.

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
page.on('requestfailed', (req) => errors.push(`[REQ FAILED] ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`));

async function step(name, fn) {
  console.log(`\n--- ${name} ---`);
  await fn();
  if (errors.length) {
    console.log(`  errors so far: ${errors.length}`);
    for (const e of errors.slice(-3)) console.log('  ' + e);
  }
}

await step('navigate', async () => {
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT_DIR, '01-initial.png'), fullPage: false });
});

await step('open fixture', async () => {
  await page.fill('input[type="text"]', FIXTURE);
  await page.click('button:has-text("Open")');
  // wait for canvas + a moment for force layout to settle
  await page.waitForFunction(() => !!document.querySelector('canvas'));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.__codeGraph?.settle?.());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '02-loaded.png') });
});

const positions = await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? []);
console.log('  file positions:', JSON.stringify(positions, null, 2));

await step('click Dog.ts to expand', async () => {
  const dog = positions.find((p) => p.id === 'src/Dog.ts');
  if (!dog) throw new Error('No file position for src/Dog.ts; is the debug hook present?');
  await page.mouse.click(dog.screenX, dog.screenY);
  // Give the simulation time to spread other files away from the expanded
  // rect. Forces re-init + alpha=0.9 takes ~3s of real-time animation.
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.__codeGraph?.settle?.());
  await page.waitForTimeout(300);

  // Pan so the expanded Dog.ts rect lands roughly in the centre of the
  // viewport — otherwise the simulation might place it off-screen and the
  // screenshot wouldn't show the whole layout.
  const settled = (
    await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? [])
  ).find((p) => p.id === 'src/Dog.ts');
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
  await page.screenshot({ path: path.join(OUT_DIR, '03-dog-expanded.png') });

  // Verify no other file rect overlaps the expanded Dog.ts rect.
  const rects = await page.evaluate(() => window.__codeGraph?.getHitRects?.() ?? []);
  const dogRect = rects.find((r) => r.id === 'src/Dog.ts' && r.kind === 'file');
  if (dogRect) {
    const overlapping = rects
      .filter((r) => r.kind === 'file' && r.id !== 'src/Dog.ts')
      .filter(
        (r) =>
          r.screenX < dogRect.screenX + dogRect.screenW &&
          r.screenX + r.screenW > dogRect.screenX &&
          r.screenY < dogRect.screenY + dogRect.screenH &&
          r.screenY + r.screenH > dogRect.screenY,
      );
    console.log(`  files overlapping expanded Dog.ts: ${overlapping.length}`);
    for (const o of overlapping) console.log('    ' + o.id);
  }
});

await step('zoom in on expanded Dog', async () => {
  const dog = (await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? [])).find(
    (p) => p.id === 'src/Dog.ts',
  );
  if (!dog) return;
  // Zoom around Dog rect center
  const cx = dog.screenX;
  const cy = dog.screenY;
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -120); // zoom in
    await page.waitForTimeout(60);
  }
  await page.screenshot({ path: path.join(OUT_DIR, '04-zoomed-in.png') });
});

await step('click an inner AST rect', async () => {
  const hits = await page.evaluate(() => window.__codeGraph?.getHitRects?.() ?? []);
  // Pick a small AST rect with sensible screen size
  const target = hits
    .filter((r) => r.kind === 'ast' && r.screenW > 30 && r.screenH > 18)
    .sort((a, b) => a.screenW * a.screenH - b.screenW * b.screenH)[0];
  if (!target) {
    console.log('  no AST hit-rect found');
    return;
  }
  const cx = target.screenX + target.screenW / 2;
  const cy = target.screenY + target.screenH / 2;
  console.log('  clicking ast', target.id, 'at', cx.toFixed(1), cy.toFixed(1));
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '05-ast-selected.png') });
});

console.log('\n--- summary ---');
console.log(`console messages: ${messages.length}`);
for (const m of messages) console.log('  ' + m);
console.log(`page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
console.log(`\nScreenshots in ${OUT_DIR}`);
