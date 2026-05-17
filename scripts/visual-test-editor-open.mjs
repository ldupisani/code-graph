// Verifies the click-to-open-code flow:
//   1. Click a collapsed file rect → editor shows that file's source quickly,
//      WITHOUT waiting for the AST/expansion work to finish.
//   2. Click an AST sub-rect → editor scrolls + highlights that range.
//   3. Click empty canvas → selection clears but editor keeps the last file
//      visible (a humane "deselect, don't un-show" behaviour).

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
    // The header strip in EditorPane shows the active fileId.
    const all = Array.from(document.querySelectorAll('div'));
    const candidate = all.find(
      (d) => d.textContent && /^src\//.test(d.textContent.trim()) && d.children.length === 0,
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

console.log('--- 1. Click collapsed Dog.ts, measure editor-open latency ---');
const t0 = Date.now();
await clickFile('src/Dog.ts');
// Poll for the editor showing src/Dog.ts as the open file.
let openedAt = null;
for (let i = 0; i < 50; i++) {
  const title = await getEditorTitle();
  if (title === 'src/Dog.ts') {
    openedAt = Date.now() - t0;
    break;
  }
  await page.waitForTimeout(20);
}
console.log(`  editor showed src/Dog.ts after ${openedAt}ms`);
await page.waitForTimeout(2500);
await page.evaluate(() => window.__codeGraph?.settle?.());
await page.screenshot({ path: path.join(OUT_DIR, '11-after-file-click.png') });

console.log('\n--- 2. Click an AST rect inside Dog.ts ---');
const dogRects = await page.evaluate(() =>
  (window.__codeGraph?.getHitRects?.() ?? []).filter(
    (r) => r.kind === 'ast' && r.fileId === 'src/Dog.ts' && r.screenW > 50 && r.screenH > 25,
  ),
);
const target = dogRects.sort((a, b) => a.screenW * a.screenH - b.screenW * b.screenH)[0];
if (!target) {
  console.log('  no qualifying AST rect found');
} else {
  console.log(`  clicking ${target.id} at (${target.screenX.toFixed(0)},${target.screenY.toFixed(0)})`);
  await page.mouse.click(target.screenX + target.screenW / 2, target.screenY + target.screenH / 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, '12-after-ast-click.png') });
  // Verify a Monaco decoration was applied (the highlight class).
  const hasHighlight = await page.evaluate(() => {
    return document.querySelectorAll('.codegraph-ast-highlight, .codegraph-ast-highlight-inline').length > 0;
  });
  console.log(`  highlight decoration present: ${hasHighlight}`);
}

console.log('\n--- 3. Click empty canvas, editor should keep last file visible ---');
// Click a definitely-empty spot far from the centre of the layout.
await page.mouse.click(50, 500);
await page.waitForTimeout(300);
const titleAfterEmpty = await getEditorTitle();
console.log(`  editor title after empty click: ${titleAfterEmpty}`);
await page.screenshot({ path: path.join(OUT_DIR, '13-after-empty-click.png') });

console.log(`\npage errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
console.log(`\nScreenshots in ${OUT_DIR}`);
