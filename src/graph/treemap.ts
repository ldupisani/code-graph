import type { AstNode, FileAstResponse } from '../api/types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Output of layoutAst: every AstNode, with a rect in file-local coordinates
// (origin at top-left of the file's interior). Children rects are strictly
// contained in their parent's rect minus padding.
export interface TreemapNode {
  id: string;
  parentId: string | null;
  syntaxKind: string;
  name: string | null;
  start: number;
  end: number;
  rect: Rect;
  depth: number;
}

export interface TreemapLayout {
  byId: Map<string, TreemapNode>;
  childrenByParent: Map<string | null, TreemapNode[]>;
  rootId: string;
}

// Side / bottom padding around children — cosmetic gap so adjacent siblings
// don't share borders.
const PADDING = 4;
// Top padding reserves a label band so the parent's name/kind label doesn't
// overlap the children laid out inside. Sized for the 11pt monospace label
// plus a couple of pixels.
const TOP_LABEL_PADDING = 16;
// Smallest inner padding when a rect gets too tight for the regular padding to
// be sensible. Keeps tiny leaves visually distinct without overflowing.
const MIN_PADDING = 0.5;

export function layoutAst(ast: FileAstResponse, outerRect: Rect): TreemapLayout {
  const childrenByParent = new Map<string | null, AstNode[]>();
  for (const n of ast.nodes) {
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentId, arr);
  }
  // Stable sibling order: by source position (start). The walk produces them
  // in order anyway, but explicit sort makes layout deterministic if a future
  // walker batches nodes differently.
  for (const arr of childrenByParent.values()) arr.sort((a, b) => a.start - b.start);

  const byId = new Map<string, TreemapNode>();
  const out = new Map<string | null, TreemapNode[]>();
  const rootAst = ast.nodes.find((n) => n.id === ast.rootId);
  if (!rootAst) {
    return { byId, childrenByParent: out, rootId: ast.rootId };
  }

  const rootNode: TreemapNode = {
    id: rootAst.id,
    parentId: null,
    syntaxKind: rootAst.syntaxKind,
    name: rootAst.name,
    start: rootAst.start,
    end: rootAst.end,
    rect: outerRect,
    depth: 0,
  };
  byId.set(rootNode.id, rootNode);
  out.set(null, [rootNode]);

  layoutChildrenOf(rootAst, rootNode.rect, 1);

  return { byId, childrenByParent: out, rootId: ast.rootId };

  function layoutChildrenOf(parent: AstNode, parentRect: Rect, depth: number): void {
    const kids = childrenByParent.get(parent.id);
    if (!kids || kids.length === 0) return;

    // Asymmetric padding: a tall band on top reserves space for the parent's
    // label; thin sides/bottom keep siblings visually separated. Both are
    // capped against the parent rect so tiny parents don't request more
    // padding than they can give (which would yield a zero-area inner rect).
    const minSide = Math.min(parentRect.w, parentRect.h);
    const sidePad = Math.min(PADDING, Math.max(MIN_PADDING, minSide * 0.04));
    const topPad = Math.min(TOP_LABEL_PADDING, Math.max(MIN_PADDING, minSide * 0.18));
    const inner: Rect = {
      x: parentRect.x + sidePad,
      y: parentRect.y + topPad,
      w: Math.max(0, parentRect.w - sidePad * 2),
      h: Math.max(0, parentRect.h - topPad - sidePad),
    };

    const slices = sliceAndDice(kids, inner);
    const treemapKids: TreemapNode[] = [];
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      const node: TreemapNode = {
        id: kid.id,
        parentId: kid.parentId,
        syntaxKind: kid.syntaxKind,
        name: kid.name,
        start: kid.start,
        end: kid.end,
        rect: slices[i],
        depth,
      };
      byId.set(node.id, node);
      treemapKids.push(node);
      layoutChildrenOf(kid, node.rect, depth + 1);
    }
    out.set(parent.id, treemapKids);
  }
}

// Squarified treemap (Bruls, Huijberts & van Wijk, 2000). Produces cells with
// aspect ratios close to 1 instead of the long strips slice-and-dice gave us
// — important because AST roots typically have one large child (the class /
// function body) and several tiny ones (imports, identifiers), and slicing
// always-along-the-longer-axis assigned full-height strips to those tiny
// imports, wasting vertical space and squashing the big child horizontally.
//
// The algorithm:
//   1. Compute each child's area (proportional to character span).
//   2. Sort children by area, descending — required for the worst-aspect
//      heuristic to be monotone.
//   3. Greedily add items to the current "row" while the worst aspect ratio
//      improves; when adding the next item would worsen it, commit the row
//      and start a new row in what's left of the rect.
function sliceAndDice(items: AstNode[], rect: Rect): Rect[] {
  if (items.length === 0) return [];
  if (rect.w <= 0 || rect.h <= 0) {
    return items.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  }

  const weights = items.map((n) => Math.max(1, n.end - n.start));
  const totalWeight = weights.reduce((s, v) => s + v, 0);
  const totalArea = rect.w * rect.h;

  // Walk children IN SOURCE ORDER. The earlier squarified version sorted by
  // area descending, which scrambled top-to-bottom reading order — the
  // largest item (the class body) ended up leftmost while the imports that
  // come first in source were pushed right. Keeping input order makes the
  // visual layout match the way the code reads.
  const decorated = items.map((_, i) => ({
    idx: i,
    area: (weights[i] / totalWeight) * totalArea,
  }));

  const out: Rect[] = new Array(items.length);
  let remainingRect = rect;
  let row: typeof decorated = [];
  let i = 0;

  while (i < decorated.length) {
    const next = decorated[i];
    // Run the row along the LONGER side; subsequent rows stack along the
    // SHORTER side. For a wide rect this means rows go top-to-bottom, items
    // within a row left-to-right, which matches source order reading.
    const span = Math.max(remainingRect.w, remainingRect.h);
    const tryRow = row.length === 0 ? [next] : row.concat(next);

    if (row.length === 0 || worstAspect(tryRow, span) <= worstAspect(row, span)) {
      row = tryRow;
      i++;
    } else {
      remainingRect = commitRow(row, remainingRect, out);
      row = [];
    }
  }
  if (row.length > 0) commitRow(row, remainingRect, out);

  return out;
}

function worstAspect(row: { area: number }[], span: number): number {
  if (row.length === 0 || span <= 0) return Infinity;
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const r of row) {
    sum += r.area;
    if (r.area > max) max = r.area;
    if (r.area < min) min = r.area;
  }
  if (sum === 0 || min === 0) return Infinity;
  // Items run along `span`. Each item's slice = (area_i/sum)*span; depth
  // across the row = sum/span. Worst aspect is dominated by the item with
  // the most extreme area relative to the others.
  const s2 = span * span;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

// Place a committed row inside `rect` (writing into `out`) and return the
// rect remaining for subsequent rows.
function commitRow(
  row: { idx: number; area: number }[],
  rect: Rect,
  out: Rect[],
): Rect {
  if (row.length === 0) return rect;
  const sumArea = row.reduce((s, r) => s + r.area, 0);
  if (sumArea === 0) {
    for (const r of row) out[r.idx] = { x: rect.x, y: rect.y, w: 0, h: 0 };
    return rect;
  }

  // Lay the row along the LONGER side; the next row sits on the OTHER
  // side. For a wider-than-tall rect the row sits along the top spanning
  // full width with items left-to-right, and the next row falls below it.
  // For a taller rect the row sits at the left spanning full height with
  // items top-to-bottom, and the next row sits to the right.
  // Either way, the first item lands at the rect's origin (top-left) and
  // subsequent items extend along the natural reading direction.
  const horizontal = rect.w >= rect.h;
  const span = horizontal ? rect.w : rect.h;
  const depth = sumArea / span;

  let offset = 0;
  for (const r of row) {
    const slice = (r.area / sumArea) * span;
    if (horizontal) {
      out[r.idx] = { x: rect.x + offset, y: rect.y, w: slice, h: depth };
    } else {
      out[r.idx] = { x: rect.x, y: rect.y + offset, w: depth, h: slice };
    }
    offset += slice;
  }

  return horizontal
    ? { x: rect.x, y: rect.y + depth, w: rect.w, h: Math.max(0, rect.h - depth) }
    : { x: rect.x + depth, y: rect.y, w: Math.max(0, rect.w - depth), h: rect.h };
}
