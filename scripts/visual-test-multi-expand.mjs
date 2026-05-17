// Verifies that semantic edges anchor on the precise sub-rect (not the file
// rect) when both source and target containing files are expanded.
// Strategy:
//   1. Open fixture, expand src/Dog.ts AND src/util.ts.
//   2. Read the project's semanticEdges + the canvas's visible hit rects.
//   3. For each edge, find which rect would be the anchor and verify it
//      matches the edge's actual fromId/toId — i.e. that we're not
//      anchoring on a file rect when a sub-rect is available.

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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(`[PAGE ERROR] ${err.stack ?? err.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.fill('input[type="text"]', FIXTURE);
await page.click('button:has-text("Open")');
await page.waitForFunction(() => !!document.querySelector('canvas'));
await page.waitForTimeout(2000);
await page.evaluate(() => window.__codeGraph?.settle?.());

async function clickFile(fileId) {
  const positions = await page.evaluate(() => window.__codeGraph?.getFilePositions?.() ?? []);
  const pos = positions.find((p) => p.id === fileId);
  if (!pos) throw new Error(`No position for ${fileId}`);
  await page.mouse.click(pos.screenX, pos.screenY);
}

await clickFile('src/Dog.ts');
await page.waitForTimeout(2500);
await page.evaluate(() => window.__codeGraph?.settle?.());

await clickFile('src/util.ts');
await page.waitForTimeout(2500);
await page.evaluate(() => window.__codeGraph?.settle?.());

await clickFile('src/Animal.ts');
await page.waitForTimeout(3000);
await page.evaluate(() => window.__codeGraph?.settle?.());
await page.waitForTimeout(300);

await page.screenshot({ path: path.join(OUT_DIR, '10-multi-expand.png') });

// Pull the project payload and visible hit-rects, then check each edge's
// anchor would be the precise endpoint (not a file-level lift).
const data = await page.evaluate(async () => {
  const proj = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/Users/louis/Development/experiments/code-graph/examples/sample-ts',
    }),
  }).then((r) => r.json());
  // The canvas was already loaded; we just need its current rects.
  const rects = window.__codeGraph?.getHitRects?.() ?? [];
  return { semanticEdges: proj.semanticEdges, rects };
});

const visibleIds = new Set(data.rects.map((r) => r.id));
let preciselyAnchored = 0;
let liftedToFile = 0;
let unanchored = 0;

console.log('--- Edge anchoring summary ---');
for (const edge of data.semanticEdges) {
  const fromInVisible = visibleIds.has(edge.fromId);
  const toInVisible = visibleIds.has(edge.toId);
  const fromIsFile = !edge.fromId.includes('#');
  const toIsFile = !edge.toId.includes('#');
  // Status decoder: precise if the AST node id itself is visible; lifted if
  // we'd have to walk to a file ancestor; unanchored if neither is reachable.
  const fromStatus = fromInVisible ? 'precise' : fromIsFile ? 'file' : 'lifted';
  const toStatus = toInVisible ? 'precise' : toIsFile ? 'file' : 'lifted';
  if (fromStatus === 'precise' && toStatus === 'precise') preciselyAnchored++;
  else if (fromStatus === 'lifted' || toStatus === 'lifted') liftedToFile++;
  else unanchored++;

  console.log(`  ${edge.kind.padEnd(11)} ${edge.fromId.padEnd(20)} -> ${edge.toId.padEnd(20)}  from:${fromStatus} to:${toStatus}`);
}
console.log(
  `\nprecise=${preciselyAnchored} lifted-to-file=${liftedToFile} unanchored=${unanchored} total=${data.semanticEdges.length}`,
);

console.log(`page errors: ${errors.length}`);
for (const e of errors) console.log('  ' + e);

await browser.close();
console.log(`\nScreenshot in ${OUT_DIR}/10-multi-expand.png`);
