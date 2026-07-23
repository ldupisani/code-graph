import type { AstNode, FileAstResponse } from '../api/types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// An inline syntax glyph drawn BETWEEN / around a node's child boxes: the
// operators of a BinaryExpression (`[i] = [j]`) and ternary (`? :`), and the
// keywords/punctuation of a templated construct (`for [x] of [items]`,
// `case [v] :`). Drawn centered at `anchor`, counter-scaled to a constant
// on-screen size and gated only on fitting — so glyphs survive the simplified
// zoom tier the way operators always have. `color` overrides the default
// operator grey (control-flow keywords render pink; see SYNTAX_TEMPLATES).
export interface SyntaxGlyph {
  text: string;
  color?: number;
  // Font size in px (defaults to the normal label size when omitted). The
  // return glyph, for instance, renders at 2× to stand out. Still counter-
  // scaled by labelScale at render time, so it scales with the other labels.
  size?: number;
  anchor: { x: number; y: number };
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
  // The resolved local implementation of a merged default export (see
  // AstNode.defaultExport) — renderer prefixes the label with `export default`.
  defaultExport?: boolean;
  abstract?: boolean;
  static?: boolean;
  readonly?: boolean;
  accessibility?: 'private' | 'protected';
  extendsName?: string;
  // True for nodes that should render in the type colour regardless of
  // their syntaxKind's normal category — currently set by the server
  // for type-only import bindings (see AstNode.isType in api/types.ts).
  isType?: boolean;
  // Variable-ish role (see AstNode.decl in api/types.ts): drives the ◇ /
  // keyword label prefix and the mutation-coloured operator glyph.
  decl?: AstNode['decl'];
  // Inline syntax glyphs drawn between/around this node's child boxes — see
  // SyntaxGlyph. Holds a BinaryExpression's single operator, a ternary's
  // `?`/`:` pair, or a templated construct's full keyword sequence.
  glyphs?: SyntaxGlyph[];
  // For the `let i = j` shape the left operand is the node's own name, drawn
  // centered in this chip instead of as the usual top-of-box label.
  labelChip?: Rect;
  // For a function definition: the rect of the parameter GROUP (the left
  // column). The renderer strokes it as a rounded bracket — open at the
  // top/bottom middle like an array block — around the borderless param chips,
  // so the whole parameter list reads as one delimited block. See functionLayout.
  groupRect?: Rect;
  // True when this node was forced to a placeholder leaf by the layout
  // (children dropped from the tree). The renderer paints just the
  // kind outline — no label, no recursion. Today this is set only for
  // function/method bodies that meet `collapseChildren`'s predicate
  // (see `AstLayoutOpts.collapseChildren`), used to give a coarse-zoom
  // overview that omits the body's interior detail.
  collapsed?: boolean;
  // Set when this cell was stretched taller than its natural size to match the
  // tallest cell in its wrapped row (see the row-equalisation pass in `size`).
  // The renderer pins the label to the top band instead of centring it, so a
  // stretched leaf's label lines up with its taller siblings' headers.
  labelTop?: boolean;
  // Present when this CallExpression is a flattened method-call chain (see
  // AstNode.chain). The renderer reads it to suppress the yellow call bracket —
  // the chain renders as a flat fluent flow of glyphs + child boxes instead.
  chain?: { marker: string; argCount: number }[];
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
// Function-signature layout (see functionLayout): horizontal room inside the
// parameter bracket (so the param chips clear the left/right strokes), vertical
// room for the bracket's top/bottom serifs, and the gap between the parameter
// group and the return-type/body column.
const GROUP_INSET = 10;
const GROUP_VPAD = 6;
// Tight: the `): ReturnType` should read as a continuation of the signature,
// so the return column hugs the parameter bracket rather than floating off it.
const COL_GAP = 5;
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
  // Construct templating: given a node's kind and its (collapsed, pruned)
  // children, returns an ordered flow of inline keyword/punctuation glyphs and
  // child references so the node reads like source — `for [x] of [items]`,
  // `case [v] :`, `return [expr]`. A `{ child: i }` token consumes the i-th
  // child inline at that position; any children NOT referenced are appended
  // after the template (e.g. a loop body), packed in wrapped rows below the
  // header. Returns null/absent for kinds with no template (normal label +
  // packing path). The colours come from the caller's syntax theme.
  syntaxTokens?: (
    kind: string,
    kids: { syntaxKind: string; role?: string }[],
    node: {
      syntaxKind: string;
      name: string | null;
      returnType?: string;
      chain?: { marker: string; argCount: number }[];
    },
  ) =>
    | Array<{ kw: string; color: number; size?: number; glue?: boolean; breakBefore?: boolean } | { child: number; glue?: boolean; breakBefore?: boolean }>
    | null;
  // Kinds whose label must NOT reserve a top header band when the node is
  // expanded (has children) — e.g. an object literal `{ … }` shown inline in a
  // ternary branch, where the `{}` is redundant with the kind outline and the
  // band just leaves an empty gap above the members. The label still sizes a
  // childless / collapsed node (so an empty `{}` or a collapsed cell keeps its
  // braces). The layout root is exempt so an expanded overlay keeps the band
  // its top-left collapse handle sits in. The renderer must likewise suppress
  // the header for these kinds (see PixiCanvas.drawAstNode).
  labelBandless?: (kind: string) => boolean;
  // Kinds laid out with the two-column function-definition shape (see
  // functionLayout): parameters grouped into a bracketed block on the left,
  // the return type + body stacked on the right, name in a band on top.
  groupedSignature?: (kind: string) => boolean;
  // Kinds laid out with the JSX variant of the two-column shape (see
  // jsxLayout): the tag name in a band on top (`<Foo />`), attributes bracketed
  // on the left, child elements stacked on the right.
  jsxSignature?: (kind: string) => boolean;
  // Colour for the return-type glyph in a grouped function signature (the
  // editor's type teal). Injected so treemap stays free of the syntax theme.
  returnTypeColor?: number;
  // Per-kind vertical gap BETWEEN wrapped rows (defaults to GAP). Used to widen
  // the gap inside code blocks so the renderer can draw a row-separator line.
  rowGap?: (kind: string) => number | undefined;
  // Per-kind extra horizontal inset on each side, beyond PAD (defaults to 0).
  // Gives a code block's statements breathing room from the left/right edges.
  sidePad?: (kind: string) => number | undefined;
  // Tight text measure (no label inset) for positioning inline glyphs snugly,
  // e.g. the `: ReturnType` after a function's parameter bracket. `measure`
  // (labelScreenBox) bakes in a generous inset for cell sizing, which would
  // leave the `:` and type floating; this is the bare font metric. Falls back
  // to `measure` when absent. Takes an optional font size so a larger glyph
  // (e.g. the 2× return symbol) reserves a correctly-sized footprint; defaults
  // to the normal label size.
  measureGlyph?: (text: string, size?: number) => { w: number; h: number };
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
  // Optional predicate on a CONTAINER node: when it returns false, the wrapped-
  // row height-equalisation is skipped for that container's children — each
  // child keeps its natural height rather than stretching to its row's tallest
  // sibling. Defaults to always-equalise. Set false for top-level file
  // statements (SourceFile / Module): those are a sequence of independent logic,
  // not a table of members, so stretching a one-liner to match a giant sibling
  // (e.g. a multi-line call) just leaves a mostly-empty cell.
  equaliseRows?: (node: { syntaxKind: string; id: string }) => boolean;
}

interface Sized {
  node: AstNode;
  labelH: number;
  w: number;
  h: number;
  // Child placements relative to this node's children-block origin.
  kids: { sized: Sized; x: number; y: number }[];
  // Inline glyph placements relative to the children-block origin (operators
  // and templated construct keywords). Flow to TreemapNode.glyphs in assign().
  glyphs?: { text: string; color?: number; size?: number; rel: { x: number; y: number } }[];
  // `labelChip` present only for the `let i = j` shape where the left operand
  // is this node's own name.
  labelChip?: Rect;
  // Parameter-group rect (relative to the children-block origin) for a function
  // definition — flows to TreemapNode.groupRect in assign(). See functionLayout.
  groupRect?: Rect;
  // Set when `opts.collapseChildren(node)` fired. The node was sized as
  // a small kind-outlined leaf and its actual children are not in
  // `kids`. Flag flows to TreemapNode.collapsed during assign.
  collapsed?: boolean;
  // Set by the row-equalisation pass when this cell was stretched to its row's
  // height. Flows to TreemapNode.labelTop during assign.
  labelTop?: boolean;
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
  const equaliseRows = opts.equaliseRows ?? (() => true);
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
      glyphs: [{ text: op, rel: { x: lw + GAP + ob.w / 2, y: rowH / 2 } }],
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
      glyphs: [
        { text: op1, rel: { x: x_op1 + ob1.w / 2, y: rowH / 2 } },
        { text: op2, rel: { x: x_op2 + ob2.w / 2, y: rowH / 2 } },
      ],
    };
  };

  // One item in a templated construct's flow: either an inline keyword/punct
  // glyph (carrying its own measured box) or an already-sized child box.
  type FlowItem =
    | { glyph: { text: string; color?: number; size?: number; w: number; h: number }; glue?: boolean; breakBefore?: boolean }
    | { sized: Sized; glue?: boolean; breakBefore?: boolean };

  // Pack an interleaved sequence of glyphs and child boxes into wrapped rows
  // (same wrap width / gap as the generic packer). Glyphs get a centered
  // rel-anchor; child boxes are vertically centered within their row so a
  // keyword sits level with the operand beside it. A wide child (a loop body
  // block) simply wraps to its own row, leaving the keyword header on top.
  const packFlow = (
    items: FlowItem[],
  ): {
    kids: { sized: Sized; x: number; y: number }[];
    glyphs: { text: string; color?: number; size?: number; rel: { x: number; y: number } }[];
    w: number;
    h: number;
  } => {
    const widthOf = (it: FlowItem) => ('glyph' in it ? it.glyph.w : it.sized.w);
    const heightOf = (it: FlowItem) =>
      'glyph' in it ? it.glyph.h : it.sized.h;
    // Phase A: assign each item an x and a row, breaking rows on wrap width.
    const placed: { it: FlowItem; x: number; row: number }[] = [];
    const rowH: number[] = [];
    let rowX = 0;
    let row = 0;
    for (const it of items) {
      const w = widthOf(it);
      // `breakBefore` items ALWAYS start a new row (the `else` keyword, so a
      // conditional reads line by line). Otherwise, `glue` items must stay on
      // the same row as their predecessor (a chain segment's `method ( args )`
      // glued to its `▷`), so a break is only legal before a NON-glued item that
      // overflows the wrap width — keeps matching parens from splitting rows.
      if (rowX > 0 && (it.breakBefore || (!it.glue && rowX + w > wrapWidth))) {
        row++;
        rowX = 0;
      }
      placed.push({ it, x: rowX, row });
      rowX += w + GAP;
      rowH[row] = Math.max(rowH[row] ?? 0, heightOf(it));
    }
    // Phase B: row Y offsets from accumulated row heights.
    const rowY: number[] = [];
    let y = 0;
    for (let r = 0; r < rowH.length; r++) {
      rowY[r] = y;
      y += rowH[r] + GAP;
    }
    const blockH = rowH.length ? y - GAP : 0;
    // Phase C: emit children (v-centered in their row) and glyph anchors.
    const kids: { sized: Sized; x: number; y: number }[] = [];
    const glyphs: {
      text: string;
      color?: number;
      size?: number;
      rel: { x: number; y: number };
    }[] = [];
    let blockW = 0;
    for (const p of placed) {
      const h = heightOf(p.it);
      blockW = Math.max(blockW, p.x + widthOf(p.it));
      if ('glyph' in p.it) {
        glyphs.push({
          text: p.it.glyph.text,
          color: p.it.glyph.color,
          size: p.it.glyph.size,
          rel: { x: p.x + p.it.glyph.w / 2, y: rowY[p.row] + rowH[p.row] / 2 },
        });
      } else {
        kids.push({
          sized: p.it.sized,
          x: p.x,
          y: rowY[p.row] + (rowH[p.row] - h) / 2,
        });
      }
    }
    return { kids, glyphs, w: blockW, h: blockH };
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
    // Children in source order, each collapsed through pass-through wrappers.
    // Keep them paired with the ROLE the server tagged on the original direct
    // child (only ForStatement clauses carry one today) — collapse can swap a
    // child for a descendant that lacks the field, so we read it from the raw
    // child by index. Pruned children drop out; the pairing stays aligned.
    const rawKids = kidsOf.get(node.id) ?? [];
    const kidEntries = rawKids
      .map((k) => ({ ast: collapse(k), role: k.role }))
      .filter((e) => !isPruned(e.ast));
    const kids = kidEntries.map((e) => e.ast);

    // Function definition → two-column shape: parameters bracketed on the left,
    // return type + body on the right, name in the band on top.
    if (opts.groupedSignature?.(node.syntaxKind)) {
      return functionLayout(node, kids, lb);
    }

    // JSX element → two-column shape: attributes bracketed on the left, child
    // elements stacked on the right, tag name in the band on top (`<Foo />`).
    if (opts.jsxSignature?.(node.syntaxKind)) {
      return jsxLayout(node, kids, lb);
    }

    // Templated construct → flow of keyword glyphs + child boxes that reads
    // like source (`for [x] of [items]`, `return [expr]`). Runs before the
    // empty / op / generic branches so even a childless `return;` still shows
    // its keyword. Templated kinds carry no op and aren't ConditionalExpression,
    // so this never shadows those shapes.
    const tokens = opts.syntaxTokens?.(
      node.syntaxKind,
      kidEntries.map((e) => ({ syntaxKind: e.ast.syntaxKind, role: e.role })),
      node,
    );
    if (tokens && tokens.length > 0) {
      // `lb` (computed above from the node's label) lets constructLayout
      // reserve a name band for labeled templated nodes (functions read
      // `name ( params ) : RT`); it's empty for nameless control flow.
      return constructLayout(node, tokens, kids, lb);
    }

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
        sizeOrCollapse(kids[0], node.syntaxKind),
        '?',
        sizeOrCollapse(kids[1], node.syntaxKind),
        ':',
        sizeOrCollapse(kids[2], node.syntaxKind),
      );
    }

    if (node.op) {
      // BinaryExpression: unlabeled, exactly two operands → [l] op [r].
      // Also covers operator-bearing types: UnionType `A | B` /
      // IntersectionType `A & B` (no label, op set by server, 2 kids).
      if (!label && kids.length === 2) {
        return relational(
          node,
          node.op,
          sizeOrCollapse(kids[0], node.syntaxKind),
          null,
          sizeOrCollapse(kids[1], node.syntaxKind),
        );
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
        const right = sizeOrCollapse(kids[0], node.syntaxKind);
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
          glyphs: [{ text: node.op, rel: { x: ob.w / 2, y: rowH / 2 } }],
        };
      }
      // Typed-and-initialized declaration: `let i: T = v`, or a class
      // property `tickInterval: T | null = null`. Label band on top
      // (the declaration's name), then [k0] op [k1] below — k0 is the
      // type annotation, k1 is the initializer, op is `=`.
      if (label && kids.length === 2) {
        const left = sizeOrCollapse(kids[0], node.syntaxKind);
        const right = sizeOrCollapse(kids[1], node.syntaxKind);
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
          glyphs: [
            { text: node.op, rel: { x: left.w + GAP + ob.w / 2, y: rowH / 2 } },
          ],
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
    // Vertical gap BETWEEN wrapped rows. Wider for code blocks so the renderer
    // can draw a spacer line between statement rows with breathing room (the
    // left→right, line-by-line cue); defaults to the normal sibling GAP.
    const rowAdvanceGap = opts.rowGap?.(node.syntaxKind) ?? GAP;
    // Extra horizontal inset on each side (beyond PAD) — e.g. so a code block's
    // statements have breathing room from the box edges.
    const sidePad = opts.sidePad?.(node.syntaxKind) ?? 0;
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
        rowY += rowH + rowAdvanceGap;
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
    // Equalise cell heights within each wrapped row: every cell grows to its
    // row's tallest, so a row reads as a clean band even when one member (e.g.
    // a property whose value is a nested object) is far taller than its
    // siblings. Items in a row share the same `y` (the row top), so group by it.
    // The row already reserved `rowH` for vertical advance, so this only fills
    // already-reserved space — blockH is unchanged. Stretched cells are flagged
    // so the renderer pins their label to the top band (aligned with the tall
    // sibling's header) rather than centring it in the now-taller box.
    if (equaliseRows(node)) {
      const rowMaxH = new Map<number, number>();
      for (const p of placed) rowMaxH.set(p.y, Math.max(rowMaxH.get(p.y) ?? 0, p.sized.h));
      for (const p of placed) {
        const target = rowMaxH.get(p.y)!;
        if (target > p.sized.h) {
          p.sized.h = target;
          p.sized.labelTop = true;
        }
      }
    }
    // Inset the packed children by the side padding so the block has symmetric
    // left/right margins (the content is widened to match below).
    if (sidePad > 0) for (const p of placed) p.x += sidePad;

    // Brace-label containers (object/array literals, type literals, blocks)
    // drop their header band when expanded inline — the kind outline conveys
    // the braces, so the members sit at the top with no empty gap above them.
    // The layout ROOT is exempt (an expanded overlay keeps the band for its
    // collapse handle); the renderer suppresses the matching header text.
    const band =
      opts.labelBandless?.(node.syntaxKind) && node.id !== ast.rootId
        ? { w: 0, h: 0 }
        : lb;
    const contentW = Math.max(band.w, blockW + sidePad * 2);
    // When rows are spaced wider than normal (code blocks), reserve a matching
    // margin below the last row too, so the bottom stays balanced with the
    // inter-row gaps instead of the last row hugging the edge.
    const bottomExtra = rowAdvanceGap > GAP ? rowAdvanceGap - GAP : 0;
    const contentH = band.h + (band.h > 0 ? GAP : 0) + blockH + bottomExtra;
    return {
      node,
      labelH: band.h,
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

  // Lay a templated construct (control flow, return/throw, await, `as`, …)
  // out as a flow of keyword glyphs and child boxes so it reads like source.
  // `{ child: i }` tokens consume kids[i] inline at that position; any child
  // NOT referenced by a token is appended afterward (e.g. a loop / catch
  // body), wrapping to its own row below the header. When `lb` is non-empty the
  // node ALSO keeps a top label band (its name) above the flow — functions read
  // `name ( params ) : RT`; nameless control flow passes lb {0,0}, so the
  // glyphs ARE the header exactly as before (band-less, like the relational
  // shapes). `assign()` offsets the flow below the band via `labelH`.
  const constructLayout = (
    node: AstNode,
    tokens: Array<{ kw: string; color: number; size?: number; glue?: boolean; breakBefore?: boolean } | { child: number; glue?: boolean; breakBefore?: boolean }>,
    kids: AstNode[],
    lb: { w: number; h: number },
  ): Sized => {
    const referenced = new Set<number>();
    for (const t of tokens) if ('child' in t) referenced.add(t.child);
    const items: FlowItem[] = [];
    for (const t of tokens) {
      if ('child' in t) {
        const child = kids[t.child];
        if (child) items.push({ sized: sizeOrCollapse(child, node.syntaxKind), glue: t.glue, breakBefore: t.breakBefore });
      } else {
        // A sized glyph (e.g. the 2× return symbol) reserves a footprint at its
        // own size via the tight glyph measure; normal-size glyphs keep the
        // inset label measure for their usual breathing room.
        const gb =
          t.size != null && opts.measureGlyph
            ? opts.measureGlyph(t.kw, t.size)
            : opts.measure(t.kw);
        // A large symbol glyph (the return arrow) often renders WIDER than the
        // monospace advance measureGlyph assumes — reserve at least a square
        // (~1em) so it can't overflow its slot and overlap the next item when
        // scaled out to full size (it's drawn centered in this footprint).
        const gw = t.size != null ? Math.max(gb.w, t.size) : gb.w;
        items.push({ glyph: { text: t.kw, color: t.color, size: t.size, w: gw, h: gb.h }, glue: t.glue, breakBefore: t.breakBefore });
      }
    }
    kids.forEach((k, i) => {
      if (!referenced.has(i)) {
        items.push({ sized: sizeOrCollapse(k, node.syntaxKind) });
      }
    });
    const packed = packFlow(items);
    const contentW = Math.max(lb.w, packed.w);
    const contentH = lb.h + (lb.h > 0 ? GAP : 0) + packed.h;
    return {
      node,
      labelH: lb.h,
      w: contentW + PAD * 2,
      h: contentH + PAD * 2,
      kids: packed.kids,
      glyphs: packed.glyphs,
    };
  };

  // Two-column layout for a function definition (see AstLayoutOpts.
  // groupedSignature). The name sits in the band on top (lb); below it, the
  // parameters stack into a bracketed group on the LEFT (each a borderless
  // `name: Type` chip; the renderer strokes the groupRect as an open-topped
  // rounded bracket), and the RIGHT column holds the return type (a teal glyph
  // from node.returnType, since primitive returns emit no child) above the
  // body block (`{}`).
  const functionLayout = (
    node: AstNode,
    kids: AstNode[],
    lb: { w: number; h: number },
  ): Sized => {
    const params = kids.filter((k) => k.syntaxKind === 'Parameter');
    // The body is the last non-parameter child: a `{}` Block for named
    // functions / block-body arrows, or an EXPRESSION for an expression-body
    // arrow (`(x) => x + 1`). Taking the last child also steps past any leading
    // type-parameter nodes of a generic. (The return type is inlined server-side.)
    const nonParams = kids.filter((k) => k.syntaxKind !== 'Parameter');
    const body = nonParams.length ? nonParams[nonParams.length - 1] : undefined;

    // LEFT: parameters stacked vertically inside the bracket group.
    let py = GROUP_VPAD;
    let innerW = 0;
    const placed: { sized: Sized; x: number; y: number }[] = [];
    for (const p of params) {
      const sp = size(p);
      placed.push({ sized: sp, x: GROUP_INSET, y: py });
      py += sp.h + GAP;
      innerW = Math.max(innerW, sp.w);
    }
    const groupW = params.length ? innerW + GROUP_INSET * 2 : 0;
    const groupH = params.length ? py - GAP + GROUP_VPAD : 0;

    // RIGHT: return-type glyph on top, body block below. With no params there's
    // no left group, so the column starts at the left edge.
    const rightX = params.length ? groupW + COL_GAP : 0;
    const rt = node.returnType;
    // Return type reads `: ReturnType` — a grey `:` then the type in teal, like
    // the editor and the param chips. Positioned with the TIGHT glyph measure
    // (no label inset) so the `:` hugs the bracket and the type sits ~1 char
    // after it, rather than floating in the inset air `measure` reserves.
    const gm = opts.measureGlyph ?? opts.measure;
    const RT_COLON = ': ';
    const colonW = rt ? gm(RT_COLON).w : 0;
    const rtTextBox = rt ? gm(rt) : { w: 0, h: 0 };
    const rtBox = { w: colonW + rtTextBox.w, h: rtTextBox.h };
    const sizedBody = body ? sizeOrCollapse(body, node.syntaxKind) : null;
    let ry = rt ? rtBox.h : 0;
    let bodyPlace: { sized: Sized; x: number; y: number } | null = null;
    if (sizedBody) {
      const by = rt ? ry + GAP : 0;
      bodyPlace = { sized: sizedBody, x: rightX, y: by };
      ry = by + sizedBody.h;
    }
    const rightW = Math.max(rtBox.w, sizedBody?.w ?? 0);

    // The children block (params group + return/body column) sits BELOW the
    // name band — assign() offsets it by labelH + GAP — so the box must
    // reserve that band height too, or the group's bottom bracket overflows.
    const blockH = Math.max(groupH, ry);
    const contentW = Math.max(lb.w, rightX + rightW);
    const contentH = lb.h + (lb.h > 0 ? GAP : 0) + blockH;

    return {
      node,
      labelH: lb.h,
      w: contentW + PAD * 2,
      h: contentH + PAD * 2,
      kids: [...placed, ...(bodyPlace ? [bodyPlace] : [])],
      glyphs: rt
        ? [
            { text: RT_COLON, rel: { x: rightX + colonW / 2, y: rtBox.h / 2 } },
            { text: rt, color: opts.returnTypeColor, rel: { x: rightX + colonW + rtTextBox.w / 2, y: rtBox.h / 2 } },
          ]
        : [],
      groupRect: params.length ? { x: 0, y: 0, w: groupW, h: groupH } : undefined,
    };
  };

  // Two-column layout for a JSX element (see AstLayoutOpts.jsxSignature),
  // mirroring functionLayout: the tag name sits in the band on top (lb, e.g.
  // `<Foo />`); below it the ATTRIBUTES stack into a bracketed group on the
  // LEFT (each a borderless chip; the renderer strokes groupRect as the same
  // open-topped rounded bracket as a param list), and the RIGHT column stacks
  // the element's CHILD nodes (nested elements / expressions). A self-closing
  // element has attributes only — no right column.
  const jsxLayout = (
    node: AstNode,
    kids: AstNode[],
    lb: { w: number; h: number },
  ): Sized => {
    const isAttr = (k: AstNode) =>
      k.syntaxKind === 'JsxAttribute' || k.syntaxKind === 'JsxSpreadAttribute';
    const attrs = kids.filter(isAttr);
    const children = kids.filter((k) => !isAttr(k));

    // LEFT: attributes stacked vertically inside the bracket group.
    let py = GROUP_VPAD;
    let innerW = 0;
    const placed: { sized: Sized; x: number; y: number }[] = [];
    for (const a of attrs) {
      const sa = size(a);
      placed.push({ sized: sa, x: GROUP_INSET, y: py });
      py += sa.h + GAP;
      innerW = Math.max(innerW, sa.w);
    }
    const groupW = attrs.length ? innerW + GROUP_INSET * 2 : 0;
    const groupH = attrs.length ? py - GAP + GROUP_VPAD : 0;

    // RIGHT: child elements stacked vertically (reads like nested JSX). With no
    // attributes there's no left group, so the column starts at the left edge.
    const rightX = attrs.length ? groupW + COL_GAP : 0;
    let ry = 0;
    let rightW = 0;
    for (const c of children) {
      const sc = sizeOrCollapse(c, node.syntaxKind);
      placed.push({ sized: sc, x: rightX, y: ry });
      ry += sc.h + GAP;
      rightW = Math.max(rightW, sc.w);
    }
    const rightH = children.length ? ry - GAP : 0;

    const blockH = Math.max(groupH, rightH);
    const contentW = Math.max(lb.w, rightX + rightW);
    const contentH = lb.h + (lb.h > 0 ? GAP : 0) + blockH;
    return {
      node,
      labelH: lb.h,
      w: contentW + PAD * 2,
      h: contentH + PAD * 2,
      kids: placed,
      groupRect: attrs.length ? { x: 0, y: 0, w: groupW, h: groupH } : undefined,
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
      defaultExport: s.node.defaultExport,
      abstract: s.node.abstract,
      static: s.node.static,
      readonly: s.node.readonly,
      accessibility: s.node.accessibility,
      extendsName: s.node.extendsName,
      isType: s.node.isType,
      decl: s.node.decl,
      rect: { x, y, w: s.w, h: s.h },
      depth,
      collapsed: s.collapsed,
      labelTop: s.labelTop,
      chain: s.node.chain,
    };
    if (s.glyphs && s.glyphs.length > 0) {
      tn.glyphs = s.glyphs.map((g) => ({
        text: g.text,
        color: g.color,
        size: g.size,
        anchor: { x: cx + g.rel.x, y: cy + g.rel.y },
      }));
    }
    if (s.labelChip) {
      tn.labelChip = {
        x: cx + s.labelChip.x,
        y: cy + s.labelChip.y,
        w: s.labelChip.w,
        h: s.labelChip.h,
      };
    }
    if (s.groupRect) {
      tn.groupRect = {
        x: cx + s.groupRect.x,
        y: cy + s.groupRect.y,
        w: s.groupRect.w,
        h: s.groupRect.h,
      };
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
