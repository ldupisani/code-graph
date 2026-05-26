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
  static?: boolean;
  readonly?: boolean;
  accessibility?: 'private' | 'protected';
  extendsName?: string;
  // True for nodes that should render in the type colour regardless of
  // their syntaxKind's normal category — currently set by the server
  // for type-only import bindings (see AstNode.isType in api/types.ts).
  isType?: boolean;
  // Relational rendering: when set, the renderer draws `op` centered at
  // `opAnchor` between this node's two operand boxes. For the `let i = j`
  // case the left operand is the node's own name, drawn in `labelChip`
  // instead of as the usual top-of-box label.
  op?: string;
  opAnchor?: { x: number; y: number };
  // Second operator for the ternary `?:` case — drawn at `opAnchor2`
  // between operands 1 and 2 the same way `op` is drawn between
  // operands 0 and 1. Unused for plain BinaryExpression / typed-decl
  // (op only) and unset on every other layout.
  op2?: string;
  opAnchor2?: { x: number; y: number };
  labelChip?: Rect;
  // True when this node was forced to a placeholder leaf by the layout
  // (children dropped from the tree). The renderer paints just the
  // kind outline — no label, no recursion. Today this is set only for
  // function/method bodies that meet `collapseChildren`'s predicate
  // (see `AstLayoutOpts.collapseChildren`), used to give a coarse-zoom
  // overview that omits the body's interior detail.
  collapsed?: boolean;
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
// Footprint of a `collapsed` placeholder leaf (see TreemapNode.collapsed):
// a small kind-outlined cell with no label, used to represent a function
// body whose interior detail was dropped at layout time.
const COLLAPSED_LEAF_W = 24;
const COLLAPSED_LEAF_H = 16;

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
  // Optional predicate: when truthy for a node, the node's children are
  // DROPPED from the layout entirely and the node itself is sized as a
  // small kind-outlined placeholder leaf (TreemapNode.collapsed = true).
  // The renderer then paints just the outline so the parent stays
  // identifiable but the interior detail is omitted.
  //
  // Used by the zoom-driven detail switch: a "collapsed" layout is built
  // with `collapseChildren = (n, parentKind) => isFunctionBody(n,
  // parentKind) && !hasNamedDescendant(n)` so function bodies without
  // any nested named entities reduce to a single magenta block,
  // dramatically shrinking the file circle at low zoom. The "full"
  // layout uses no `collapseChildren` and so behaves exactly as before.
  collapseChildren?: (
    n: { name: string | null; syntaxKind: string; id: string },
    parentKind: string,
  ) => boolean;
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
  // Second operator (ternary `?:`) — see TreemapNode.op2.
  op2?: string;
  opRel2?: { x: number; y: number };
  labelChip?: Rect;
  // Set when `opts.collapseChildren(node)` fired. The node was sized as
  // a small kind-outlined leaf and its actual children are not in
  // `kids`. Flag flows to TreemapNode.collapsed during assign.
  collapsed?: boolean;
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
  const collapseChildren = opts.collapseChildren;
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

  // Ternary `[cond] ? [whenTrue] : [whenFalse]` — same shape as
  // `relational` but with TWO operator gaps. Used for
  // ConditionalExpression so a ternary reads like the source instead
  // of `?: [cond] [whenTrue] [whenFalse]` stacked under a header.
  const ternary = (
    node: AstNode,
    k0: Sized,
    op1: string,
    k1: Sized,
    op2: string,
    k2: Sized,
  ): Sized => {
    const ob1 = opts.measure(op1);
    const ob2 = opts.measure(op2);
    const rowH = Math.max(k0.h, k1.h, k2.h, ob1.h, ob2.h);
    const x_op1 = k0.w + GAP;
    const x1 = x_op1 + ob1.w + GAP;
    const x_op2 = x1 + k1.w + GAP;
    const x2 = x_op2 + ob2.w + GAP;
    return {
      node,
      labelH: 0,
      w: x2 + k2.w + PAD * 2,
      h: rowH + PAD * 2,
      kids: [
        { sized: k0, x: 0, y: (rowH - k0.h) / 2 },
        { sized: k1, x: x1, y: (rowH - k1.h) / 2 },
        { sized: k2, x: x2, y: (rowH - k2.h) / 2 },
      ],
      op: op1,
      opRel: { x: x_op1 + ob1.w / 2, y: rowH / 2 },
      op2,
      opRel2: { x: x_op2 + ob2.w / 2, y: rowH / 2 },
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

    // ConditionalExpression `[cond] ? [whenTrue] : [whenFalse]` — laid
    // out before the generic node.op branches because it doesn't carry
    // a single operator from the server (the `?` and `:` are part of
    // the grammar, not an `operatorToken`).
    if (
      node.syntaxKind === 'ConditionalExpression' &&
      !label &&
      kids.length === 3
    ) {
      return ternary(
        node,
        size(kids[0]),
        '?',
        size(kids[1]),
        ':',
        size(kids[2]),
      );
    }

    if (node.op) {
      // BinaryExpression: unlabeled, exactly two operands → [l] op [r].
      // Also covers operator-bearing types: UnionType `A | B` /
      // IntersectionType `A & B` (no label, op set by server, 2 kids).
      if (!label && kids.length === 2) {
        return relational(node, node.op, size(kids[0]), null, size(kids[1]));
      }
      // `let i = j` / `const Icon = forwardRef(...)`: name as a top
      // label BAND, then `op [init]` in a row below. A top band —
      // not an inline name-chip — because a chip is sized exactly to
      // its label and so only fits at 1:1 zoom, making the name
      // vanish at every lower zoom. A band gets the same robust
      // container-header LOD every other named container uses (the
      // header shows while the whole node — initializer included —
      // is wide enough on screen, which happens far below 1:1).
      if (label && kids.length === 1) {
        const right = size(kids[0]);
        const ob = opts.measure(node.op);
        const rowH = Math.max(right.h, ob.h);
        const rightX = ob.w + GAP;
        const rowW = rightX + right.w;
        const contentW = Math.max(lb.w, rowW);
        const contentH = lb.h + GAP + rowH;
        return {
          node,
          labelH: lb.h,
          w: contentW + PAD * 2,
          h: contentH + PAD * 2,
          kids: [{ sized: right, x: rightX, y: (rowH - right.h) / 2 }],
          op: node.op,
          opRel: { x: ob.w / 2, y: rowH / 2 },
        };
      }
      // Typed-and-initialized declaration: `let i: T = v`, or a class
      // property `tickInterval: T | null = null`. Label band on top
      // (the declaration's name), then [k0] op [k1] below — k0 is the
      // type annotation, k1 is the initializer, op is `=`.
      if (label && kids.length === 2) {
        const left = size(kids[0]);
        const right = size(kids[1]);
        const ob = opts.measure(node.op);
        const rowH = Math.max(left.h, right.h, ob.h);
        const rightX = left.w + GAP + ob.w + GAP;
        const rowW = rightX + right.w;
        const contentW = Math.max(lb.w, rowW);
        const contentH = lb.h + GAP + rowH;
        return {
          node,
          labelH: lb.h,
          w: contentW + PAD * 2,
          h: contentH + PAD * 2,
          kids: [
            { sized: left, x: 0, y: (rowH - left.h) / 2 },
            { sized: right, x: rightX, y: (rowH - right.h) / 2 },
          ],
          op: node.op,
          opRel: { x: left.w + GAP + ob.w / 2, y: rowH / 2 },
        };
      }
      // Anything else (destructuring, 3+ union members, …) → normal packing.
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

    const sizedKids = kids.map((k) => sizeOrCollapse(k, node.syntaxKind));
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

  // Wrapper consulted by `size`'s wrapped-row pass before recursing into
  // each child. When `opts.collapseChildren(node, parentKind)` fires the
  // child sizes as a small kind-outlined leaf (no recursion, kids
  // dropped from the layout entirely). Used by the zoom-driven detail
  // switch to shrink function bodies that contain no named descendants.
  //
  // Cell is sized to fit its label so a NAMED collapsible (e.g.
  // `InterfaceDeclaration IUserPreferences`, `TypeAliasDeclaration`,
  // `JsxElement <SomeComponent>…</SomeComponent>`) doesn't render as
  // a blank box that loses its identity at-a-glance. Unnamed
  // collapsibles (`Block`, ObjectBindingPattern's `{}`,
  // ObjectLiteralExpression's `{}`) still land at the COLLAPSED_LEAF
  // minimum because their labels are short enough to fit it.
  const sizeOrCollapse = (n: AstNode, parentKind: string): Sized => {
    if (
      collapseChildren &&
      collapseChildren(
        { name: n.name, syntaxKind: n.syntaxKind, id: n.id },
        parentKind,
      )
    ) {
      const label = opts.labelOf(n);
      const lb = label ? opts.measure(label) : { w: 0, h: 0 };
      return {
        node: n,
        labelH: 0,
        w: Math.max(COLLAPSED_LEAF_W, lb.w),
        h: Math.max(COLLAPSED_LEAF_H, lb.h),
        kids: [],
        collapsed: true,
      };
    }
    return size(n);
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
      static: s.node.static,
      readonly: s.node.readonly,
      accessibility: s.node.accessibility,
      extendsName: s.node.extendsName,
      isType: s.node.isType,
      rect: { x, y, w: s.w, h: s.h },
      depth,
      collapsed: s.collapsed,
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
    if (s.op2 && s.opRel2) {
      tn.op2 = s.op2;
      tn.opAnchor2 = { x: cx + s.opRel2.x, y: cy + s.opRel2.y };
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
