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
  exported?: boolean;
  abstract?: boolean;
  extendsName?: string;
  // Relational rendering: when set, the renderer draws `op` centered at
  // `opAnchor` between this node's two operand boxes. For the `let i = j`
  // case the left operand is the node's own name, drawn in `labelChip`
  // instead of as the usual top-of-box label.
  op?: string;
  opAnchor?: { x: number; y: number };
  labelChip?: Rect;
}

export interface TreemapLayout {
  byId: Map<string, TreemapNode>;
  childrenByParent: Map<string | null, TreemapNode[]>;
  rootId: string;
}

// --- Content-sized nested layout -----------------------------------------
// The old squarified treemap sized cells by source character span, which
// produced giant boxes holding a single short label. Instead every node is
// sized BOTTOM-UP to exactly its own label plus its children, packed into
// wrapped rows — so a box is never bigger than the text it contains.

// Inner padding on every side of a node. Kept small: the label box already
// carries its own text inset (see labelScreenBox), this is just breathing
// room so nested borders don't touch.
const PAD = 4;
// Gap between the label band and the children block, and between siblings.
const GAP = 4;
// Children flow left→right and wrap to a new row once the row would exceed
// this content width. A single child wider than this still gets its own row
// (a node is never split). Tune for wider/narrower expanded files.
const DEFAULT_WRAP_WIDTH = 480;

export interface AstLayoutOpts {
  originX: number;
  originY: number;
  // Mirrors the renderer's label resolution so a node is sized to exactly
  // the text it will show (and unlabeled nodes stay tiny).
  labelOf: (n: { name: string | null; syntaxKind: string }) => string | null;
  // Whether a node is worth its own box and must NOT be collapsed as a
  // single-child pass-through — true if it has a label OR a kind outline.
  // (Defaults to "has a label" when omitted.)
  significant?: (n: { name: string | null; syntaxKind: string }) => boolean;
  // Kinds that are noise when they have no children (e.g. an empty `{}`
  // Block). Such nodes are dropped from the layout entirely so they don't
  // reserve a tiny empty box.
  pruneEmpty?: (n: { name: string | null; syntaxKind: string }) => boolean;
  // Nodes dropped from the layout entirely (with their subtree) — e.g. an
  // `extends` clause now rendered inline on the class header.
  prune?: (n: { name: string | null; syntaxKind: string }) => boolean;
  // Unlabeled nodes that should still reserve a top label-height band, so a
  // badge (e.g. the constructor wrench) can sit there without overlapping
  // children — same vertical space a named class header takes.
  reserveBand?: (n: { name: string | null; syntaxKind: string }) => boolean;
  // Row-grouping key. Consecutive siblings in different groups never share a
  // wrapped row (e.g. `extends` clauses get their own row, though multiple
  // extends can share one). Defaults to a single group (no effect).
  rowGroup?: (n: { name: string | null; syntaxKind: string }) => string;
  // Box (w,h) a label needs in its cell — the SAME function the renderer's
  // LOD gate checks, so a node is exactly big enough for its own label.
  measure: (text: string) => { w: number; h: number };
  wrapWidth?: number;
}

interface Sized {
  node: AstNode;
  labelH: number;
  w: number;
  h: number;
  // Child placements relative to this node's children-block origin.
  kids: { sized: Sized; x: number; y: number }[];
  // Relational layout (op between operands), all relative to the
  // children-block origin. `labelChip` present only for the `let i = j`
  // shape where the left operand is this node's own name.
  op?: string;
  opRel?: { x: number; y: number };
  labelChip?: Rect;
}

// Lay every AstNode out as a nested box sized bottom-up to its own label and
// its children packed into wrapped rows. No area heuristic, no fixed outer
// box: each node is exactly large enough for its content plus padding, so
// there is never a giant box with a lone label at the top.
export function layoutAst(
  ast: FileAstResponse,
  opts: AstLayoutOpts,
): TreemapLayout {
  const wrapWidth = opts.wrapWidth ?? DEFAULT_WRAP_WIDTH;

  const kidsOf = new Map<string | null, AstNode[]>();
  for (const n of ast.nodes) {
    const arr = kidsOf.get(n.parentId) ?? [];
    arr.push(n);
    kidsOf.set(n.parentId, arr);
  }
  // Stable source order so the layout reads the way the code does.
  for (const arr of kidsOf.values()) arr.sort((a, b) => a.start - b.start);

  const byId = new Map<string, TreemapNode>();
  const out = new Map<string | null, TreemapNode[]>();
  const rootAst = ast.nodes.find((n) => n.id === ast.rootId);
  if (!rootAst) return { byId, childrenByParent: out, rootId: ast.rootId };

  // Collapse pure syntactic scaffolding: an unlabeled node with exactly one
  // child is just a pass-through wrapper (block → expr → binary → …). Skip
  // it and hoist its child, repeating down the chain, so these don't stack
  // into a tower of empty boxes and a real name ends up next to its content.
  // Collapsed nodes are absent from the layout (not drawn/selectable);
  // semantic-edge anchoring already lifts to the nearest visible ancestor.
  const significant =
    opts.significant ?? ((n) => opts.labelOf(n) !== null);
  const rowGroup = opts.rowGroup ?? (() => 'n');
  const pruneEmpty = opts.pruneEmpty ?? (() => false);
  const prune = opts.prune ?? (() => false);
  const reserveBand = opts.reserveBand ?? (() => false);
  const isPruned = (n: AstNode): boolean =>
    prune(n) || (pruneEmpty(n) && (kidsOf.get(n.id)?.length ?? 0) === 0);
  const collapse = (n: AstNode): AstNode => {
    let cur = n;
    for (;;) {
      if (significant(cur)) return cur;
      const k = kidsOf.get(cur.id);
      if (!k || k.length !== 1) return cur;
      cur = k[0];
    }
  };

  // A relational [left] op [right] block: operands side by side with a gap
  // for the operator glyph (drawn by the renderer at `opRel`). `leftSized`
  // xor `leftLabel` — a BinaryExpression's left box is its first operand; a
  // `let i = j` declaration's left box is its own name (a label chip).
  const relational = (
    node: AstNode,
    op: string,
    leftSized: Sized | null,
    leftLabel: { w: number; h: number } | null,
    right: Sized,
  ): Sized => {
    const ob = opts.measure(op);
    const lw = leftSized ? leftSized.w : leftLabel!.w;
    const lh = leftSized ? leftSized.h : leftLabel!.h;
    const rowH = Math.max(lh, right.h, ob.h);
    const rightX = lw + GAP + ob.w + GAP;
    const kids: { sized: Sized; x: number; y: number }[] = [];
    if (leftSized) kids.push({ sized: leftSized, x: 0, y: (rowH - lh) / 2 });
    kids.push({ sized: right, x: rightX, y: (rowH - right.h) / 2 });
    return {
      node,
      labelH: 0, // operator nodes never reserve a top label band
      w: rightX + right.w + PAD * 2,
      h: rowH + PAD * 2,
      kids,
      op,
      opRel: { x: lw + GAP + ob.w / 2, y: rowH / 2 },
      labelChip: leftSized ? undefined : { x: 0, y: (rowH - lh) / 2, w: lw, h: lh },
    };
  };

  // ---- Phase 1: bottom-up intrinsic sizing ------------------------------
  const size = (node: AstNode): Sized => {
    const label = opts.labelOf(node);
    const lb = label
      ? opts.measure(label)
      : reserveBand(node)
        ? // No text, but reserve a label-height band (square, so a childless
          // node is still big enough for the badge that lives in it).
          { w: opts.measure('').h, h: opts.measure('').h }
        : { w: 0, h: 0 };
    const kids = (kidsOf.get(node.id) ?? [])
      .map(collapse)
      .filter((k) => !isPruned(k));

    if (node.op) {
      // BinaryExpression: unlabeled, exactly two operands → [l] op [r].
      if (!label && kids.length === 2) {
        return relational(node, node.op, size(kids[0]), null, size(kids[1]));
      }
      // `let i = j`: the name is the left operand, drawn as a chip.
      if (label && kids.length === 1) {
        return relational(node, node.op, null, lb, size(kids[0]));
      }
      // Anything else (typed decl, destructuring, …) → normal packing.
    }

    if (kids.length === 0) {
      return {
        node,
        labelH: lb.h,
        w: lb.w + PAD * 2,
        h: lb.h + PAD * 2,
        kids: [],
      };
    }

    const sizedKids = kids.map(size);
    // Wrapped-row packing, source order preserved.
    const placed: { sized: Sized; x: number; y: number }[] = [];
    let rowX = 0;
    let rowY = 0;
    let rowH = 0;
    let blockW = 0;
    let rowGroupId: string | null = null; // group of the current row's items
    for (const k of sizedKids) {
      const g = rowGroup(k.node);
      // Wrap when the row is full OR the group changes — so e.g. `extends`
      // clauses never share a row with ordinary members.
      if (rowX > 0 && (g !== rowGroupId || rowX + k.w > wrapWidth)) {
        blockW = Math.max(blockW, rowX - GAP); // drop trailing gap
        rowY += rowH + GAP;
        rowX = 0;
        rowH = 0;
      }
      if (rowX === 0) rowGroupId = g; // first item fixes the row's group
      placed.push({ sized: k, x: rowX, y: rowY });
      rowX += k.w + GAP;
      rowH = Math.max(rowH, k.h);
    }
    blockW = Math.max(blockW, rowX - GAP);
    const blockH = rowY + rowH;

    const contentW = Math.max(lb.w, blockW);
    const contentH = lb.h + (lb.h > 0 ? GAP : 0) + blockH;
    return {
      node,
      labelH: lb.h,
      w: contentW + PAD * 2,
      h: contentH + PAD * 2,
      kids: placed,
    };
  };

  const rootSized = size(rootAst);

  // ---- Phase 2: translate the sized tree to absolute rects --------------
  const assign = (s: Sized, x: number, y: number, depth: number): void => {
    // Children block sits inside the padding, below this node's label band
    // (operator nodes have labelH 0, so it sits directly inside the padding).
    const cx = x + PAD;
    const cy = y + PAD + s.labelH + (s.labelH > 0 ? GAP : 0);
    const tn: TreemapNode = {
      id: s.node.id,
      parentId: s.node.parentId,
      syntaxKind: s.node.syntaxKind,
      name: s.node.name,
      start: s.node.start,
      end: s.node.end,
      exported: s.node.exported,
      abstract: s.node.abstract,
      extendsName: s.node.extendsName,
      rect: { x, y, w: s.w, h: s.h },
      depth,
    };
    if (s.op && s.opRel) {
      tn.op = s.op;
      tn.opAnchor = { x: cx + s.opRel.x, y: cy + s.opRel.y };
      if (s.labelChip) {
        tn.labelChip = {
          x: cx + s.labelChip.x,
          y: cy + s.labelChip.y,
          w: s.labelChip.w,
          h: s.labelChip.h,
        };
      }
    }
    byId.set(s.node.id, tn);
    if (s.kids.length === 0) return;
    const tmKids: TreemapNode[] = [];
    for (const p of s.kids) {
      assign(p.sized, cx + p.x, cy + p.y, depth + 1);
      tmKids.push(byId.get(p.sized.node.id)!);
    }
    out.set(s.node.id, tmKids);
  };
  assign(rootSized, opts.originX, opts.originY, 0);
  out.set(null, [byId.get(rootSized.node.id)!]);

  return { byId, childrenByParent: out, rootId: ast.rootId };
}

// Intrinsic size of the whole AST = the root's content-sized box, clamped to
// a sane maximum (and an absolute floor). Because sizing is bottom-up there
// is no fixpoint: lay out once at the origin and read the root's size.
export interface FitInteriorOpts {
  labelOf: (n: { name: string | null; syntaxKind: string }) => string | null;
  significant?: (n: { name: string | null; syntaxKind: string }) => boolean;
  pruneEmpty?: (n: { name: string | null; syntaxKind: string }) => boolean;
  prune?: (n: { name: string | null; syntaxKind: string }) => boolean;
  reserveBand?: (n: { name: string | null; syntaxKind: string }) => boolean;
  rowGroup?: (n: { name: string | null; syntaxKind: string }) => string;
  measure: (text: string) => { w: number; h: number };
  min: { w: number; h: number };
  max: { w: number; h: number };
  wrapWidth?: number;
}

export function fitInterior(
  ast: FileAstResponse,
  opts: FitInteriorOpts,
): { w: number; h: number } {
  const layout = layoutAst(ast, {
    originX: 0,
    originY: 0,
    labelOf: opts.labelOf,
    significant: opts.significant,
    pruneEmpty: opts.pruneEmpty,
    prune: opts.prune,
    reserveBand: opts.reserveBand,
    rowGroup: opts.rowGroup,
    measure: opts.measure,
    wrapWidth: opts.wrapWidth,
  });
  const root = layout.byId.get(layout.rootId)?.rect;
  if (!root) return { w: opts.min.w, h: opts.min.h };
  return {
    w: Math.ceil(clamp(root.w, opts.min.w, opts.max.w)),
    h: Math.ceil(clamp(root.h, opts.min.h, opts.max.h)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
