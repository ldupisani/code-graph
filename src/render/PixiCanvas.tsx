import { useEffect, useRef } from 'react';
import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Text,
} from 'pixi.js';
import { getFileAst } from '../api/client';
import {
  applyExpansion,
  buildFileLayout,
  EXPANDED_MAX,
  EXPANDED_MIN,
  type FileLayoutResult,
} from '../graph/layout';
import { AST_LABEL_FONT, fileLabel, labelScreenBox, measureMono } from '../graph/labels';
import { useGraphStore } from '../graph/store';
import {
  layoutAst,
  type TreemapLayout,
  type TreemapNode,
} from '../graph/treemap';
import {
  buildAstForceLayout,
  type AstForceLayout,
  type ContainerForceLayout,
} from '../graph/astForce';
import type {
  FileAstResponse,
  ImportEdge,
  ProjectResponse,
  SemanticEdge,
  SemanticEdgeKind,
} from '../api/types';
import type { SimFileNode } from '../graph/types';

const COLORS = {
  bg: 0x161618,
  file: 0x2a2a2e,
  fileExpanded: 0x1f1f24,
  fileSelected: 0x3a6fb0,
  fileBorder: 0x44444a,
  fileBorderSelected: 0xffffff,
  ast: 0x222229,
  astBorder: 0x33333a,
  astSelected: 0x3a6fb0,
  astSelectedBorder: 0xffffff,
  // Per-kind outlines: structural kinds get a colored border instead of a
  // text label, so they're identifiable without crowding the layout.
  astOutlineBlock: 0xe06cff, // magenta — Block
  astOutlineObject: 0xe8c84a, // yellow — ObjectLiteralExpression
  astOutlineParam: 0x6cb6ff, // light blue — Parameter
  astOutlineAbstract: 0x4ec9b0, // dashed — abstract/interface (editor type color)
  astOutlineAbstractFn: 0x808080, // dotted — abstract function (≈50% white)
  text: 0xeeeeee,
  textDim: 0xb0b0b8,
  edge: 0x565a63, // import links: subdued but always visible
} as const;

const SEMANTIC_EDGE_STYLE: Record<
  SemanticEdgeKind,
  { color: number; width: number; alpha: number; arrowSize: number }
> = {
  // 0xdcdcaa == SYNTAX.func — same yellow as the call labels/triangle.
  calls: { color: 0xdcdcaa, width: 1.2, alpha: 0.85, arrowSize: 7 },
  extends: { color: 0x9aa3ff, width: 1.8, alpha: 0.9, arrowSize: 9 },
  implements: { color: 0x60d0c0, width: 1.4, alpha: 0.85, arrowSize: 8 },
};

// LOD: rects whose smaller side is below this many screen pixels are not drawn.
const CULL_PX = 4;
// Below this camera zoom the view "simplifies": operator glyphs and generic
// kind labels (type/if/arrow fn…) drop out, leaving only real names. Zoom in
// past it for full detail.
const SIMPLIFY_BELOW = 1.5;
// Block/object kind outlines are cheap structural cues (just a colored
// border, no text), so they come back much earlier when zooming in than the
// rest of the detail — at this lower zoom threshold.
const OUTLINE_BELOW = 0.5;
// Call links only render when their caller node is on screen anyway (its
// file must be expanded), so they can come back early too — otherwise
// they're invisible until an expanded node fills the whole viewport.
const CALLS_BELOW = 0.5;
// Every Block (the magenta sequential-code cells — function bodies,
// if/for/while/try bodies, standalone braced scopes) defaults to a
// COLLAPSED single-cell rendering: just the kind outline, no
// children. Clicking a collapsed Block toggles it in the store's
// `expandedAstNodes` set; the layout rebuilds and the Block's
// statements appear. Clicking it again re-collapses. State lives in
// the Zustand store so it survives across re-renders but resets on
// project open / AST re-walk.
// Labels appear only while their container is at least the label's own box
// (text + insets) on screen — see labelScreenBox / the gate in drawAstNode.

// Friendly short labels for non-named AST kinds. Keeps the on-screen label
// concise (e.g. `ReturnStatement` -> "return") so even narrow rects can host
// it without crowding the layout.
const SYNTAX_KIND_LABELS: Record<string, string> = {
  // Statements
  ReturnStatement: 'return',
  IfStatement: 'if',
  ForStatement: 'for',
  ForInStatement: 'for…in',
  ForOfStatement: 'for…of',
  WhileStatement: 'while',
  DoStatement: 'do',
  TryStatement: 'try',
  CatchClause: 'catch',
  SwitchStatement: 'switch',
  CaseClause: 'case',
  DefaultClause: 'default',
  BreakStatement: 'break',
  ContinueStatement: 'continue',
  ThrowStatement: 'throw',
  EmptyStatement: ';',
  // Expressions
  CallExpression: 'call',
  NewExpression: 'new',
  PropertyAccessExpression: 'access',
  ElementAccessExpression: 'index',
  PrefixUnaryExpression: 'unary',
  PostfixUnaryExpression: 'unary',
  ConditionalExpression: 'ternary',
  ArrowFunction: 'arrow fn',
  FunctionExpression: 'fn',
  AwaitExpression: 'await',
  YieldExpression: 'yield',
  SpreadElement: 'spread',
  TemplateExpression: 'template',
  ArrayLiteralExpression: 'array',
  AsExpression: 'as',
  NonNullExpression: 'non-null',
  // Other
  HeritageClause: 'extends',
  TypeReference: 'type',
  ImportDeclaration: 'import',
  ExportDeclaration: 'export',
  ImportClause: 'imports',
  NamedImports: 'named',
  Parameter: 'param',
};

// Names ALWAYS take precedence. Unnamed nodes get a label only if their kind
// is in the curated meaningful set above — pure syntactic scaffolding
// (Block, ExpressionStatement, BinaryExpression, parens, var statements, and
// anything not curated) returns null, so it neither competes with a real
// name nor reserves a label band. Such single-child wrappers are then
// flattened away entirely by the layout (see layoutAst).
function labelFor(node: {
  name: string | null;
  syntaxKind: string;
  extendsName?: string;
}): string | null {
  if (node.name) {
    // Inline the extends clause on the header: "Dog extends Animal". The
    // sizer measures this composite (single source of truth), the renderer
    // draws it as colored segments.
    return node.extendsName
      ? `${node.name} extends ${node.extendsName}`
      : node.name;
  }
  return SYNTAX_KIND_LABELS[node.syntaxKind] ?? null;
}

// Kinds whose label is treated like a real name for LOD: it survives the
// simplified tier and only drops when it no longer fits on screen (rather
// than disappearing early with the other generic kind labels).
const NAME_LIKE_KINDS = new Set(['ImportDeclaration', 'ReturnStatement']);

// Kinds shown as a colored outline instead of a text label. They carry no
// label (decluttered) but stay visually identifiable by border color.
const KIND_OUTLINE: Record<string, number> = {
  Block: COLORS.astOutlineBlock,
  ObjectLiteralExpression: COLORS.astOutlineObject,
  Parameter: COLORS.astOutlineParam,
};

// A node is "significant" — worth its own box, never collapsed as a
// pass-through — if it shows a label OR carries a kind outline. (A magenta
// `block` or yellow `object` must survive even as a single-child wrapper,
// otherwise its outline would never be drawn.)
function isSignificant(node: { name: string | null; syntaxKind: string }): boolean {
  return (
    labelFor(node) !== null ||
    KIND_OUTLINE[node.syntaxKind] !== undefined ||
    // Constructor has no label but its own box (white outline + wrench
    // badge), so it must never collapse as a single-child pass-through.
    node.syntaxKind === 'Constructor'
  );
}

// The collapse predicate now lives at the call site
// (`buildPerFileLayout` in the useEffect closure) because it needs to
// close over the per-file slice of the store's `expandedAstNodes`.

// Label text colored like the code editor (Monaco `vs-dark` / Dark+ family,
// matching EditorPane's theme): types teal, functions yellow, control-flow
// pink, other keywords blue, strings salmon, numbers green, everything
// identifier-ish light blue, fallback default foreground.
const SYNTAX = {
  type: 0x4ec9b0,
  func: 0xdcdcaa,
  variable: 0x9cdcfe,
  control: 0xc586c0,
  keyword: 0x569cd6,
  string: 0xce9178,
  number: 0xb5cea8,
  default: 0xd4d4d4,
} as const;

// AST kind → syntax category. Anything unmapped falls back to `default`,
// which also covers operator glyphs (operators are default fg in vs-dark).
const SYNTAX_CATEGORY: Record<string, keyof typeof SYNTAX> = {
  ClassDeclaration: 'type',
  ClassExpression: 'type',
  InterfaceDeclaration: 'type',
  EnumDeclaration: 'type',
  EnumMember: 'type',
  TypeAliasDeclaration: 'type',
  TypeReference: 'type',
  ExpressionWithTypeArguments: 'type',
  FunctionDeclaration: 'func',
  FunctionExpression: 'func',
  ArrowFunction: 'func',
  MethodDeclaration: 'func',
  MethodSignature: 'func',
  Constructor: 'func',
  GetAccessor: 'func',
  SetAccessor: 'func',
  CallExpression: 'func',
  NewExpression: 'func',
  VariableDeclaration: 'variable',
  Parameter: 'variable',
  PropertyDeclaration: 'variable',
  PropertySignature: 'variable',
  PropertyAssignment: 'variable',
  ShorthandPropertyAssignment: 'variable',
  BindingElement: 'variable',
  PropertyAccessExpression: 'variable',
  ElementAccessExpression: 'variable',
  Identifier: 'variable',
  ReturnStatement: 'control',
  IfStatement: 'control',
  ForStatement: 'control',
  ForInStatement: 'control',
  ForOfStatement: 'control',
  WhileStatement: 'control',
  DoStatement: 'control',
  SwitchStatement: 'control',
  CaseClause: 'control',
  DefaultClause: 'control',
  BreakStatement: 'control',
  ContinueStatement: 'control',
  ThrowStatement: 'control',
  TryStatement: 'control',
  CatchClause: 'control',
  AwaitExpression: 'control',
  YieldExpression: 'control',
  ImportDeclaration: 'keyword',
  ExportDeclaration: 'keyword',
  ExportAssignment: 'keyword',
  ImportClause: 'keyword',
  NamedImports: 'keyword',
  NamedExports: 'keyword',
  ImportSpecifier: 'keyword',
  ExportSpecifier: 'keyword',
  HeritageClause: 'keyword',
  AsExpression: 'keyword',
  NonNullExpression: 'keyword',
  SpreadElement: 'keyword',
  StringLiteral: 'string',
  NoSubstitutionTemplateLiteral: 'string',
  TemplateExpression: 'string',
  TemplateHead: 'string',
  TemplateMiddle: 'string',
  TemplateTail: 'string',
  NumericLiteral: 'number',
  BigIntLiteral: 'number',
};

function syntaxColor(node: { syntaxKind: string }): number {
  return SYNTAX[SYNTAX_CATEGORY[node.syntaxKind] ?? 'default'];
}

// "Higher-level construct": a type-level declaration or anything exported.
// When zoomed out far enough that labels no longer fit their boxes, only
// these keep their text (everything else — calls, ifs, property keys,
// operands — drops out). Classes/interfaces/enums/type-aliases by kind,
// plus exported declarations regardless of kind.
const HIGH_LEVEL_KINDS = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'InterfaceDeclaration',
  'EnumDeclaration',
  'TypeAliasDeclaration',
]);
function isHighLevel(node: { syntaxKind: string; exported?: boolean }): boolean {
  return node.exported === true || HIGH_LEVEL_KINDS.has(node.syntaxKind);
}

// Camera state persisted across PixiCanvas rebuilds (e.g. when a filesystem
// refresh swaps the project payload). Keyed by rootPath so opening a *different*
// project starts at the default centered view.
let savedCamera: { rootPath: string; x: number; y: number; scale: number } | null = null;

interface CanvasProps {
  project: ProjectResponse;
}

interface HitRect {
  id: string;
  fileId: string;
  // 'ast-toggle' marks the small top-right handle drawn on every
  // expanded Block. It's a reliable click target for COLLAPSING the
  // Block — children inside the Block can otherwise fill the body
  // and steal every click. handleClick treats 'ast-toggle' the same
  // as clicking an empty Block area (toggles), and the cursor flips
  // to 'pointer' over it.
  kind: 'file' | 'ast' | 'ast-toggle';
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

// Force-graph tunables live as module-level `const`s in astForce.ts and
// layout.ts. React Fast Refresh re-evaluates those modules on save but the
// effect below only re-runs when `project` changes — so the *running*
// simulation and the AST layout cache keep referencing the old constants.
// Accepting the hot-update here and forcing a full reload restores the
// "edit constant → see it" iteration loop.
if (import.meta.hot) {
  import.meta.hot.accept(['../graph/astForce', '../graph/layout'], () => {
    location.reload();
  });
}

export function PixiCanvas({ project }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const app = new Application();
      await app.init({
        background: COLORS.bg,
        resizeTo: container,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      if (disposed) {
        app.destroy(true, { children: true });
        return;
      }
      container.appendChild(app.canvas);
      app.canvas.style.display = 'block';
      app.canvas.style.touchAction = 'none';

      const layout = buildFileLayout(project);
      const world = new Container();
      app.stage.addChild(world);
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        (window as unknown as { __codegraph: unknown }).__codegraph = {
          layout, world,
          getFileSize: (id: string) => {
            const n = layout.byId.get(id);
            return n ? { w: n.width, h: n.height, x: n.x, y: n.y } : null;
          },
          // Layouts now live in `layoutsByFileId` (single per-file
          // entry that the user's manual Block expansions feed into).
          getAstForce: (id: string) => activeForce(id),
          getAstTree: (id: string) => activeTree(id),
          ensureExpandedLayout,
          applyExpansionToSim: () => applyExpansionToSim(),
          getCameraScale: () => world.scale.x,
          // Headless helper: drive a click via the production
          // `handleClick` path (including the animation hook in the
          // Block-toggle branch) without having to dispatch synthetic
          // canvas pointer events. Pass an AST node id; if found in
          // the active layout, builds the HitRect handleClick expects.
          simulateClick: (astNodeId: string) => {
            const fileId = astNodeId.includes('#')
              ? astNodeId.slice(0, astNodeId.lastIndexOf('#'))
              : astNodeId;
            const tree = activeTree(fileId);
            const tn = tree?.byId.get(astNodeId);
            if (!tn) return false;
            handleClick({
              id: astNodeId,
              fileId,
              kind: 'ast',
              x: tn.rect.x,
              y: tn.rect.y,
              w: tn.rect.w,
              h: tn.rect.h,
              area: tn.rect.w * tn.rect.h,
            });
            return true;
          },
          // Read the per-file circle-grow animation state for tests.
          getBlockAnim: (id: string) => blockAnims.get(id),
        };
      }
      // Restore camera if we're rebuilding the same project (filesystem
      // refresh); otherwise center.
      if (savedCamera && savedCamera.rootPath === project.rootPath) {
        world.position.set(savedCamera.x, savedCamera.y);
        world.scale.set(savedCamera.scale);
      } else {
        world.position.set(app.screen.width / 2, app.screen.height / 2);
      }

      // Scene graph layering, bottom-up:
      //   worldGfx       — rects (file + AST) AND expanded-Block
      //                    overlays. Pixi Graphics renders draw calls
      //                    in order, so the overlay pass — which runs
      //                    AFTER the main scene — naturally lands on
      //                    top of it without needing a separate
      //                    Graphics layer. (Hit priority for overlays
      //                    is handled by a separate HitRect list, not
      //                    by Graphics z-order.)
      //   labelLayer     — Pixi Text labels (on top of rects so they're legible)
      //   semanticEdgeGfx — semantic edges + arrowheads (on top of labels so
      //                     no call/extends arrow can be hidden by a label or rect)
      const worldGfx = new Graphics();
      world.addChild(worldGfx);

      const labelLayer = new Container();
      world.addChild(labelLayer);

      const semanticEdgeGfx = new Graphics();
      world.addChild(semanticEdgeGfx);

      // Visual rim between the cluster's bounding-circle radius and the file
      // boundary actually drawn. Pure breathing room — the file's name is
      // drawn outside (above) the boundary, not inside it.
      const FILE_RIM = 10;

      // Per-file AST layouts now live in `layoutsByFileId` (declared
      // below) — keyed by fileId and holding BOTH the `full` and
      // `collapsed` modes. Use `activeTree(fileId)` / `activeForce(fileId)`
      // to read the entry for the currently active LOD mode.
      // In-flight AST fetches we track to avoid double-firing on rapid clicks.
      const fetching = new Set<string>();

      // Hit rects rebuilt every frame in world coords. Two layers:
      // overlay rects (expanded-Block overlays + their interior) take
      // priority during hit-test, then the main scene below. Without
      // the priority split a click on an overlay child would fall
      // through to the underlying main-layout cell because the cell
      // has the smallest area there.
      const hitRects: HitRect[] = [];
      const overlayHitRects: HitRect[] = [];
      // Same data keyed by id for O(1) anchor lookup during edge rendering.
      const visibleById = new Map<string, HitRect>();
      // Renderer flips this to `overlayHitRects` while drawing an
      // overlay so `pushRect` routes hits to the right layer
      // automatically.
      let currentHitTarget: HitRect[] = hitRects;
      const pushRect = (r: HitRect): void => {
        currentHitTarget.push(r);
        // The handle is a click router only — don't let it overwrite
        // the visibleById entry for the Block id, otherwise camera
        // follow / edge anchoring would resolve to the small 12px
        // handle rect instead of the full overlay or cell.
        if (r.kind !== 'ast-toggle') {
          visibleById.set(r.id, r);
        }
      };

      // Track each Block cell's WORLD rect as it's rendered in the
      // main scene. Overlays read this to anchor their top-left to
      // the cell the user clicked.
      const blockCellsThisFrame = new Map<
        string,
        { x: number; y: number; w: number; h: number }
      >();

      // When a node is selected the camera eases toward a fixed world
      // point so it lands centered on what the user just clicked, even
      // if the sim is still settling. `followStartAt` defers the start
      // (used for Block toggles: we wait until the Block-grow
      // animation completes before panning, otherwise the camera
      // chases a target whose own rect is being lerped). null = not
      // following. `followAt` is captured on the first frame the
      // follow becomes active, so the camera eases toward a STILL
      // point instead of bouncing as the d3-force sim continues to
      // settle in the background.
      let followId: string | null = null;
      let followStartAt = 0;
      let followAt: { x: number; y: number } | null = null;

      // Directional `${fromFileId} ${toFileId}` keys for semantic edges
      // (calls/extends/implements) actually drawn this frame. drawSemanticEdges
      // rebuilds it; drawEdges (which runs earlier in the frame) reads the
      // previous frame's set to suppress now-redundant import lines — a
      // 1-frame lag that's imperceptible at 60fps.
      const visibleSemanticPairs = new Set<string>();

      // Pool of Pixi Text objects re-used across frames. `visible` is toggled
      // for unused entries, avoiding GC churn.
      const labelPool = new LabelPool(labelLayer);

      // Camera (mirrors world.scale.x; held in a ref so handlers can read
      // and write without a closure stale-read.)
      let cameraScale = world.scale.x;

      // ----- expansion handling -----

      // Single per-file layout. The treemap's `collapseChildren`
      // predicate consults `store.expandedAstNodes` so every Block
      // starts collapsed and the user can selectively expand
      // individual ones via click. The cache keeps a snapshot of the
      // file's expanded-block set so we can detect when a toggle
      // requires a rebuild.
      interface PerFileLayout {
        tree: TreemapLayout;
        force: AstForceLayout;
        size: { w: number; h: number };
      }
      const layoutsByFileId = new Map<
        string,
        {
          ast: FileAstResponse;
          layout: PerFileLayout;
        }
      >();

      function buildPerFileLayout(ast: FileAstResponse): PerFileLayout {
        const tree = layoutAst(ast, {
          originX: 0,
          originY: 0,
          labelOf: labelFor,
          significant: isSignificant,
          pruneEmpty: (n) => n.syntaxKind === 'Block', // drop empty `{}`
          // extends/implements clauses are inlined on the class header.
          prune: (n) => n.syntaxKind === 'HeritageClause',
          // Constructor reserves a label-height band for its wrench badge.
          reserveBand: (n) => n.syntaxKind === 'Constructor',
          rowGroup: (n) =>
            n.syntaxKind === 'HeritageClause' ? 'extends' : 'n',
          // Exactly the box the renderer's LOD gate checks below, so a
          // cell sized here shows its label at 1:1 and nothing larger.
          measure: labelScreenBox,
          // Every Block is ALWAYS collapsed in the main layout — the
          // file's footprint never grows when a user expands a Block.
          // Expanded Blocks are rendered as OVERLAYS on top of the
          // main scene (anchored at the cell's world position), so
          // the main layout dimensions stay stable across toggles.
          collapseChildren: (n) => n.syntaxKind === 'Block',
        });
        const force = buildAstForceLayout({
          fileId: ast.fileId,
          ast,
          tree,
          semanticEdges: project.semanticEdges,
        });
        // File is drawn as a circle of (cluster-radius + FILE_RIM). Its
        // SimFileNode footprint is the bounding *square* of that circle
        // so the existing edge-port logic — which probes top/bottom/
        // left/right midpoints of the hit rect — naturally lands on the
        // circle boundary. Width === height ⇒ collisionRadius in
        // layout.ts uses r = w/2 + pad (see the expanded branch there).
        const minSide = Math.max(EXPANDED_MIN.w, EXPANDED_MIN.h);
        const maxSide = Math.min(EXPANDED_MAX.w, EXPANDED_MAX.h);
        const diameter = Math.min(
          maxSide,
          Math.max(minSide, Math.ceil(2 * (force.bounds.radius + FILE_RIM))),
        );
        const size = { w: diameter, h: diameter };
        return { tree, force, size };
      }

      // Overlay layouts — one TreemapLayout per expanded Block, with
      // the Block itself as the root and its descendants laid out
      // normally (other nested Blocks stay collapsed within the
      // overlay). Built lazily the first time the user toggles a
      // Block, cached keyed by `${fileId}:${blockId}` and invalidated
      // when the file's AST identity changes.
      const overlayLayouts = new Map<
        string,
        { ast: FileAstResponse; layout: TreemapLayout }
      >();

      function fileIdOfAstId(astId: string): string {
        const i = astId.lastIndexOf('#');
        return i > 0 ? astId.slice(0, i) : astId;
      }

      function getOverlayLayout(blockId: string): TreemapLayout | null {
        const fileId = fileIdOfAstId(blockId);
        const state = useGraphStore.getState();
        const ast = state.asts.get(fileId);
        if (!ast) return null;
        const cached = overlayLayouts.get(blockId);
        if (cached && cached.ast === ast) return cached.layout;
        // Build a layout where the Block is the synthetic root. Other
        // nested Blocks stay collapsed (clicking them would create
        // their own overlays — same cell-anchored model).
        const layout = layoutAst(
          { fileId, rootId: blockId, nodes: ast.nodes },
          {
            originX: 0,
            originY: 0,
            labelOf: labelFor,
            significant: isSignificant,
            pruneEmpty: (n) => n.syntaxKind === 'Block',
            prune: (n) => n.syntaxKind === 'HeritageClause',
            reserveBand: (n) => n.syntaxKind === 'Constructor',
            rowGroup: (n) =>
              n.syntaxKind === 'HeritageClause' ? 'extends' : 'n',
            measure: labelScreenBox,
            collapseChildren: (n) =>
              n.syntaxKind === 'Block' && n.id !== blockId,
          },
        );
        overlayLayouts.set(blockId, { ast, layout });
        return layout;
      }

      // Idempotent builder. Rebuilds only when the file's AST identity
      // changes (file-watcher driven re-walk) — Block expansions don't
      // affect the main layout anymore; they spawn separate overlays.
      function ensureExpandedLayout(fileId: string): PerFileLayout | null {
        const state = useGraphStore.getState();
        const ast = state.asts.get(fileId);
        if (!ast) return null;
        const cached = layoutsByFileId.get(fileId);
        if (cached && cached.ast === ast) return cached.layout;
        const layout = buildPerFileLayout(ast);
        layoutsByFileId.set(fileId, { ast, layout });
        return layout;
      }

      function expandedSizeFor(fileId: string): { w: number; h: number } | null {
        return ensureExpandedLayout(fileId)?.size ?? null;
      }

      // Accessors used throughout draw + edge anchoring code.
      function activeTree(fileId: string): TreemapLayout | undefined {
        return ensureExpandedLayout(fileId)?.tree;
      }
      function activeForce(fileId: string): AstForceLayout | undefined {
        return ensureExpandedLayout(fileId)?.force;
      }

      function applyExpansionToSim() {
        applyExpansion(
          layout,
          useGraphStore.getState().expandedFiles,
          expandedSizeFor,
        );
      }

      // Per-Block overlay-rect animation. When the user toggles a
      // Block, the OVERLAY's rendered width/height lerps from `prev`
      // (the cell's footprint on expand; the current overlay size on
      // collapse) toward the target on each frame for `duration` ms.
      // The overlay's TOP-LEFT is always anchored at the underlying
      // cell — only width and height animate, so the overlay
      // visibly grows out of / shrinks back to the cell.
      interface BlockAnim {
        startedAt: number;
        duration: number;
        prevW: number;
        prevH: number;
      }
      const blockAnims = new Map<string, BlockAnim>();
      const BLOCK_ANIM_DURATION = 250;

      function startBlockAnim(astId: string, prevW: number, prevH: number) {
        blockAnims.set(astId, {
          startedAt: performance.now(),
          duration: BLOCK_ANIM_DURATION,
          prevW,
          prevH,
        });
      }


      function buildSubtreeLayout(fileId: string): void {
        ensureExpandedLayout(fileId);
      }

      function dropSubtreeLayout(fileId: string): void {
        layoutsByFileId.delete(fileId);
        // Drop any cached overlay layouts that belong to this file —
        // when the file collapses or its AST is re-walked the overlay
        // ids may no longer exist.
        const prefix = `${fileId}#`;
        for (const id of [...overlayLayouts.keys()]) {
          if (id.startsWith(prefix)) overlayLayouts.delete(id);
        }
      }

      // ----- per-frame draw -----

      function draw(): void {
        const state = useGraphStore.getState();
        const selection = state.selection;

        worldGfx.clear();
        semanticEdgeGfx.clear();
        hitRects.length = 0;
        overlayHitRects.length = 0;
        currentHitTarget = hitRects;
        visibleById.clear();
        blockCellsThisFrame.clear();
        labelPool.beginFrame();

        // 1. Import edges (under rects). Now anchored to the specific
        //    `import` AST node on the source side when that file is
        //    expanded, and clipped to the file's circle on the target
        //    side — see drawEdges for the geometry.
        drawEdges(
          layout,
          project.edges,
          activeForce,
          worldGfx,
          cameraScale,
          visibleSemanticPairs,
        );

        // 2. Files + AST subtrees on `worldGfx`. pushRect keeps visibleById
        //    in sync so the edge pass below can find precise anchors.
        for (const sim of layout.nodes) {
          drawFile(sim, selection);
        }

        // 3. Overlays for expanded Blocks. Iterate multiple passes so
        //    nested overlays (Block expanded inside another overlay)
        //    can render after their parent has registered the cell
        //    they anchor to. Stops once no new overlay drew this pass.
        currentHitTarget = overlayHitRects;
        const renderedOverlays = new Set<string>();
        const overlaysToDraw = new Set<string>(state.expandedAstNodes);
        // Include any block in a currently-animating shrink, even if
        // it's no longer in expandedAstNodes (the user just toggled
        // it off but the rect is still lerping back to cell size).
        for (const id of blockAnims.keys()) overlaysToDraw.add(id);
        let progress = true;
        let safety = 8; // bound nesting depth — degenerate cases bail out
        while (progress && safety-- > 0) {
          progress = false;
          for (const blockId of overlaysToDraw) {
            if (renderedOverlays.has(blockId)) continue;
            const cell = blockCellsThisFrame.get(blockId);
            if (!cell) continue; // anchor not on this frame yet — wait
            drawOverlay(blockId, cell, selection);
            renderedOverlays.add(blockId);
            progress = true;
          }
        }
        currentHitTarget = hitRects;

        // 4. Labels (above rects + overlays).
        labelPool.endFrame();

        // 5. Semantic edges, drawn last on a dedicated graphics layered above
        //    labels. Border-clipped + arrowheaded so they're always visible.
        drawSemanticEdges(
          project.semanticEdges,
          semanticEdgeGfx,
          visibleById,
          activeTree,
          cameraScale,
          selection,
          state.expandedFiles,
          visibleSemanticPairs,
        );
      }

      function drawFile(sim: SimFileNode, selection: string | null): void {
        const x = sim.x - sim.width / 2;
        const y = sim.y - sim.height / 2;
        const expanded = useGraphStore.getState().expandedFiles.has(sim.id);
        const isSelected = selection === sim.id;

        // The filename is ALWAYS drawn above the node (centered, counter-
        // scaled to constant size) — never inside it — so it can't overlap
        // the box content or the dot at any zoom.
        const labelScale = 1 / cameraScale;
        const aboveGap = 8 / cameraScale; // screen-constant gap above the node
        const putName = (topY: number): void => {
          labelPool.put({
            text: fileLabel(sim.relativePath),
            worldX: sim.x,
            worldY: topY - aboveGap,
            color: COLORS.text,
            size: 12,
            anchorX: 0.5,
            anchorY: 1, // text's bottom sits `aboveGap` above the node
            scale: labelScale,
          });
        };

        // Collapsed files are ALWAYS a small, constant-size "closed file"
        // icon (a dog-eared page) at every zoom level — never a sized box or
        // a dot. The filename floats above it.
        if (!expanded) {
          const iw = 16 / cameraScale; // screen-constant page size
          const ih = 20 / cameraScale;
          const fold = 6 / cameraScale; // folded top-right corner
          const ix = sim.x - iw / 2;
          const iy = sim.y - ih / 2;
          const body = isSelected ? COLORS.fileSelected : COLORS.file;
          const line = isSelected
            ? COLORS.fileBorderSelected
            : COLORS.fileBorder;
          worldGfx
            .poly([
              ix, iy,
              ix + iw - fold, iy,
              ix + iw, iy + fold,
              ix + iw, iy + ih,
              ix, iy + ih,
            ])
            .fill({ color: body })
            .stroke({ color: line, width: 1 / cameraScale });
          // The folded corner, slightly distinct so it reads as a page.
          worldGfx
            .poly([
              ix + iw - fold, iy,
              ix + iw, iy + fold,
              ix + iw - fold, iy + fold,
            ])
            .fill({ color: line, alpha: 0.6 });
          // Anchor to the ICON's bounds, not the (invisible) sim footprint —
          // otherwise connectors terminate in empty space far from the icon,
          // and the click target wouldn't match what's drawn.
          pushRect({
            id: sim.id,
            fileId: sim.id,
            kind: 'file',
            x: ix,
            y: iy,
            w: iw,
            h: ih,
            area: iw * ih,
          });
          putName(iy);
          return;
        }

        // Expanded files: a translucent CIRCLE encompassing the cluster.
        // sim.width === sim.height by construction (see ensureExpandedLayout)
        // so radius = half the footprint. Selection thickens the stroke.
        const fileRadius = sim.width / 2;
        worldGfx
          .circle(sim.x, sim.y, fileRadius)
          .fill({ color: COLORS.fileExpanded, alpha: 0.7 });
        if (isSelected) {
          worldGfx
            .circle(sim.x, sim.y, fileRadius)
            .stroke({ color: COLORS.fileSelected, width: FILE_RIM / 2 });
        }

        // Hit rect is the bounding square of the circle. Two reasons:
        //   (1) HitRect is an AABB by design — the smallest-area containing
        //       rect wins, which is the same answer for clicks anywhere on
        //       the visible circle (and the four "corner" pixels outside the
        //       circle but inside the square are visually empty, so a click
        //       there is unambiguously about this file).
        //   (2) The edge-port logic (callConnector) probes the four edge-
        //       midpoints of this rect — which sit exactly on the circle
        //       boundary, so semantic connectors land cleanly.
        pushRect({
          id: sim.id,
          fileId: sim.id,
          kind: 'file',
          x,
          y,
          w: sim.width,
          h: sim.height,
          area: sim.width * sim.height,
        });

        putName(y);

        if (expanded) {
          let tree = activeTree(sim.id);
          if (!tree) {
            buildSubtreeLayout(sim.id);
            tree = activeTree(sim.id);
          }
          if (tree) drawSubtree(tree, x, y, sim.id, selection);
        }
      }

      function drawSubtree(
        tree: TreemapLayout,
        _baseX: number,
        _baseY: number,
        fileId: string,
        selection: string | null,
      ): void {
        // Top-level statements are positioned by the per-file fractal force
        // layout, not the treemap's wrapped-row defaults. Each top-level
        // subtree translates as a rigid body — descendants render unchanged
        // because drawAstNode uses (baseX + node.rect.x, baseY + node.rect.y)
        // and we adjust baseX/baseY per top-level by the delta from its
        // treemap position to its sim-decided position.
        const force = activeForce(fileId);
        if (!force) return;
        const sim = layout.byId.get(fileId);
        if (!sim) return;
        // Anchor the cluster's centroid on the file's world position so the
        // surrounding circle (centered on sim.x/y) genuinely encloses every
        // node. Baking the centroid offset into the per-subtree translation
        // — instead of computing a file-box top-left — means we no longer
        // depend on the file having a rectangular content area at all.
        const offsetX = sim.x - force.bounds.cx;
        const offsetY = sim.y - force.bounds.cy;
        for (const sn of force.nodes) {
          const tn = sn.tree;
          // sn.{x,y} is the sim node's center; tn.rect.{x,y} is the
          // treemap-relative top-left of the subtree root. The delta maps
          // the (untransformed) drawAstNode recursion back onto the sim.
          const dx = sn.x - tn.rect.w / 2 - tn.rect.x;
          const dy = sn.y - tn.rect.h / 2 - tn.rect.y;
          drawAstNode(
            tn,
            offsetX + dx,
            offsetY + dy,
            fileId,
            tree,
            selection,
          );
        }
      }

      // Draw a class / interface as a translucent circle around its
      // members (instead of the bottom-up wrapped-row rect the treemap
      // would have built). Members render at their force-decided
      // positions via a per-child baseX/baseY adjustment passed to the
      // recursive drawAstNode call — treemap rects stay file-absolute
      // (so descendants of each member still translate correctly with
      // the member as a rigid body).
      function drawAstContainer(
        node: TreemapNode,
        x: number,
        y: number,
        container: ContainerForceLayout,
        fileId: string,
        tree: TreemapLayout,
        selection: string | null,
      ): void {
        const cx = x + node.rect.w / 2;
        const cy = y + node.rect.h / 2;
        const radius = node.rect.w / 2;

        const isSelected = selection === node.id;
        // Interface = always dashed green (TypeScript interfaces are
        // abstract by nature, no `abstract` keyword needed). Abstract
        // class = dashed; concrete class = solid. Same colour grammar
        // as the rect path further down.
        const isInterface = node.syntaxKind === 'InterfaceDeclaration';
        const isAbstract = !!node.abstract;
        const dashed = isInterface || isAbstract;
        const strokeColor = isSelected
          ? COLORS.fileSelected
          : isInterface || isAbstract
            ? COLORS.astOutlineAbstract
            : SYNTAX.type;
        const strokeWidth = (isSelected ? FILE_RIM / 2 : 1) / cameraScale;
        const strokeAlpha = 1;

        // Circle fill: same translucent dark as the file circle, so a
        // class reads as a "smaller file" of related members.
        worldGfx.circle(cx, cy, radius).fill({ color: COLORS.fileExpanded, alpha: 0.55 });

        if (dashed) {
          // Sample the perimeter and dash it. Step count scales with
          // radius so big circles stay smooth.
          const N = Math.max(48, Math.round(radius * 0.6));
          const path: { x: number; y: number }[] = [];
          for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            path.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
          }
          emitDashed(worldGfx, path, 3.5 / cameraScale, 2.5 / cameraScale);
          worldGfx.stroke({ color: strokeColor, width: strokeWidth, alpha: strokeAlpha });
        } else {
          worldGfx
            .circle(cx, cy, radius)
            .stroke({ color: strokeColor, width: strokeWidth, alpha: strokeAlpha });
        }

        // Hit rect: bounding square of the circle (same trade-off as
        // file circles — the four corner regions are visually empty so
        // a click there is unambiguously about this container).
        pushRect({
          id: node.id,
          fileId,
          kind: 'ast',
          x,
          y,
          w: node.rect.w,
          h: node.rect.h,
          area: node.rect.w * node.rect.h,
        });

        // Class/interface name above the circle, like the file label.
        const labelText = labelFor(node);
        if (labelText) {
          const aboveGap = 4 / cameraScale; // screen-constant gap
          labelPool.put({
            text: labelText,
            worldX: cx,
            worldY: y - aboveGap,
            color: isInterface ? COLORS.astOutlineAbstract : SYNTAX.type,
            size: AST_LABEL_FONT,
            anchorX: 0.5,
            anchorY: 1,
            scale: 1 / cameraScale,
          });
        }

        // Recurse into members with a per-member baseX/baseY computed
        // so that the member's rect (whose treemap coords are absolute
        // in the file's frame) lands at its force-decided position
        // relative to this container's CENTRE. Descendants of each
        // member then translate as a rigid body via their own treemap
        // offsets — no descendant-rect mutation needed.
        const kids = tree.childrenByParent.get(node.id);
        if (!kids) return;
        for (const k of kids) {
          const sn = container.byId.get(k.id);
          if (!sn) continue;
          const memberCx = cx + (sn.x - container.bounds.cx);
          const memberCy = cy + (sn.y - container.bounds.cy);
          // drawAstNode draws k at (baseX' + k.rect.x, baseY' + k.rect.y).
          // We want that top-left to equal (memberCx - k.rect.w/2, memberCy - k.rect.h/2).
          const baseXk = memberCx - k.rect.w / 2 - k.rect.x;
          const baseYk = memberCy - k.rect.h / 2 - k.rect.y;
          drawAstNode(k, baseXk, baseYk, fileId, tree, selection);
        }
      }

      // Render the expanded-Block overlay for `blockId`, anchored at
      // the world position of its underlying collapsed cell. The
      // overlay reads from a dedicated TreemapLayout in `getOverlayLayout`
      // whose synthetic root IS the Block; that layout's interior
      // mirrors the file's normal AST below the Block, with any deeper
      // nested Blocks staying collapsed (clicking one creates its own
      // overlay).
      //
      // While drawing, `currentHitTarget` is `overlayHitRects` (set by
      // the caller) so all rects pushed by the recursive drawAstNode
      // calls land in the priority hit list. The collapse handle in
      // the top-left lives on this list too — re-clicking it (or
      // anywhere in the overlay's chrome) toggles the block off.
      function drawOverlay(
        blockId: string,
        cell: { x: number; y: number; w: number; h: number },
        selection: string | null,
      ): void {
        const overlayTree = getOverlayLayout(blockId);
        if (!overlayTree) return;
        const blockNode = overlayTree.byId.get(blockId);
        if (!blockNode) return;
        const fileId = fileIdOfAstId(blockId);

        // Overlay sizing. The full overlay rect anchors at the cell's
        // top-left and extends right/down by the block layout's
        // intrinsic dimensions. Block-anim (if active) lerps from the
        // cell's footprint toward this full size so the overlay
        // visibly grows out of the underlying cell — see the
        // animation tracking near startBlockAnim above.
        const targetW = blockNode.rect.w;
        const targetH = blockNode.rect.h;
        const anim = blockAnims.get(blockId);
        let w = targetW;
        let h = targetH;
        if (anim) {
          const elapsed = performance.now() - anim.startedAt;
          if (elapsed < anim.duration) {
            const t = elapsed / anim.duration;
            const eased = 1 - Math.pow(1 - t, 3);
            w = anim.prevW + (targetW - anim.prevW) * eased;
            h = anim.prevH + (targetH - anim.prevH) * eased;
          } else {
            blockAnims.delete(blockId);
          }
        }

        const x = cell.x;
        const y = cell.y;

        // Overlay background + outline. Slightly darker fill than
        // file-expanded so the overlay reads as a layer above the
        // file's content; same kind colour for the outline so the
        // user keeps the "this is a Block" association.
        const stroke = KIND_OUTLINE['Block'] ?? COLORS.astBorder;
        worldGfx
          .rect(x, y, w, h)
          .fill({ color: COLORS.fileExpanded, alpha: 0.95 })
          .stroke({ color: stroke, width: 1.5 / cameraScale, alpha: 1 });

        pushRect({
          id: blockId,
          fileId,
          kind: 'ast',
          x,
          y,
          w,
          h,
          area: w * h,
        });

        // Only render the overlay's children once the lerp has
        // finished — during the grow they'd be drawn at full layout
        // positions inside a smaller rect and would visually spill.
        if (!anim) {
          const kids = overlayTree.childrenByParent.get(blockId);
          if (kids) {
            for (const k of kids) {
              drawAstNode(k, x, y, fileId, overlayTree, selection);
            }
          }
        }

        // Collapse handle: top-LEFT of the overlay (per the user's
        // request to move it). Smaller-area HitRect with kind
        // 'ast-toggle' takes priority over the overlay body for
        // clicks in this region.
        if (!anim && cameraScale >= OUTLINE_BELOW) {
          const handleSize = 12 / cameraScale;
          const handleInset = 4 / cameraScale;
          const hx = x + handleInset;
          const hy = y + handleInset;
          const isHandleHovered =
            hoveredHit?.kind === 'ast-toggle' && hoveredHit.id === blockId;
          const lineW = (isHandleHovered ? 1.6 : 1) / cameraScale;
          worldGfx
            .rect(hx, hy, handleSize, handleSize)
            .fill({ color: stroke, alpha: isHandleHovered ? 0.5 : 0.25 })
            .stroke({ color: stroke, width: lineW, alpha: 1 });
          worldGfx
            .moveTo(hx + handleSize * 0.25, hy + handleSize / 2)
            .lineTo(hx + handleSize * 0.75, hy + handleSize / 2)
            .stroke({ color: stroke, width: lineW * 1.2, alpha: 1 });
          pushRect({
            id: blockId,
            fileId,
            kind: 'ast-toggle',
            x: hx,
            y: hy,
            w: handleSize,
            h: handleSize,
            area: handleSize * handleSize,
          });
        }
      }

      function drawAstNode(
        node: TreemapNode,
        baseX: number,
        baseY: number,
        fileId: string,
        tree: TreemapLayout,
        selection: string | null,
      ): void {
        const x = baseX + node.rect.x;
        const y = baseY + node.rect.y;
        const wOnScreen = node.rect.w * cameraScale;
        const hOnScreen = node.rect.h * cameraScale;
        const minScreen = Math.min(wOnScreen, hOnScreen);
        if (minScreen < CULL_PX) return;

        // (The Block grow/shrink animation now lives in drawOverlay —
        // the underlying main-scene cell stays at its layout size and
        // the overlay animates above it.)

        // Member-container path: classes / interfaces whose members were
        // arranged by their own fractal force layout (see astForce.ts's
        // containers map). Draw a circle around the members instead of
        // the wrapped-row rect that the treemap built, label above the
        // circle (like a file label), and recurse into each member with
        // a per-member baseX/baseY adjustment so it draws at its
        // force-decided spot relative to the circle's centre.
        const force = activeForce(fileId);
        const container = force?.containers.get(node.id);
        if (container) {
          drawAstContainer(node, x, y, container, fileId, tree, selection);
          return;
        }

        // Collapsed-leaf path: layoutAst's `collapseChildren` predicate
        // fired on this node (so its children were dropped at layout
        // time). Paint just the parent kind's outline — no label band,
        // no fill, no recursion. Hovering the cell brightens the outline
        // (alpha 1 + thicker stroke) so the user sees it's interactive;
        // clicking toggles it via handleClick.
        if (node.collapsed) {
          const stroke = KIND_OUTLINE[node.syntaxKind] ?? COLORS.astBorder;
          const isSelectedLeaf = selection === node.id;
          const isHovered = hoveredHit?.id === node.id;
          worldGfx
            .rect(x, y, node.rect.w, node.rect.h)
            .fill({
              color: stroke,
              // Hover gets a soft tint of the outline color so the cell
              // reads as a button without changing the visual grammar.
              alpha: isHovered ? 0.18 : 0,
            })
            .stroke({
              color: isSelectedLeaf ? COLORS.astSelected : stroke,
              width: (isHovered ? 2 : 1) / cameraScale,
              alpha: 1,
            });
          pushRect({
            id: node.id,
            fileId,
            kind: 'ast',
            x,
            y,
            w: node.rect.w,
            h: node.rect.h,
            area: node.rect.w * node.rect.h,
          });
          // Record the cell's world rect so any overlay built for this
          // Block can anchor its top-left here. Only Block kinds: other
          // collapsed leaves don't get overlays.
          if (node.syntaxKind === 'Block') {
            blockCellsThisFrame.set(node.id, {
              x,
              y,
              w: node.rect.w,
              h: node.rect.h,
            });
          }
          return;
        }

        // Zoomed-out "simplified" tier: drop operators and generic kind
        // labels — keep only real names.
        const simplified = cameraScale < SIMPLIFY_BELOW;

        const isSelected = selection === node.id;
        const tint = depthTint(node.depth);
        const fillColor = tint; // selection is shown via the outline, not fill
        // A call/new argument is a "parameter block for a call" — style it
        // like a function `Parameter` (light-blue outline + rounded).
        const argParent = node.parentId
          ? tree.byId.get(node.parentId)
          : undefined;
        const isCallArg =
          argParent?.syntaxKind === 'CallExpression' ||
          argParent?.syntaxKind === 'NewExpression';
        const paramLike = node.syntaxKind === 'Parameter' || isCallArg;
        // Kind outlines have their own (much lower) zoom threshold so they
        // reappear well before the rest of the detail does. A call argument
        // with no outline of its own gets the parameter light-blue.
        const kindOutline =
          cameraScale < OUTLINE_BELOW
            ? undefined
            : (KIND_OUTLINE[node.syntaxKind] ??
              (isCallArg ? COLORS.astOutlineParam : undefined));
        // Abstract definitions AND interfaces get a green dashed outline
        // (TS interfaces aren't flagged `abstract` but are abstract by
        // nature). Same zoom gate as the kind outlines.
        const abstractOutline =
          (!!node.abstract || node.syntaxKind === 'InterfaceDeclaration') &&
          cameraScale >= OUTLINE_BELOW;
        // An abstract *function* (method/accessor) reads differently from an
        // abstract class/interface: grey + dotted instead of green + dashed.
        const abstractFn =
          !!node.abstract &&
          (node.syntaxKind === 'MethodDeclaration' ||
            node.syntaxKind === 'GetAccessor' ||
            node.syntaxKind === 'SetAccessor');
        // A concrete class gets the same green, but SOLID (abstract classes
        // hit the dashed branch above first, so this is non-abstract only).
        const classOutline =
          (node.syntaxKind === 'ClassDeclaration' ||
            node.syntaxKind === 'ClassExpression') &&
          cameraScale >= OUTLINE_BELOW;
        // A concrete function definition gets the same grey, but SOLID
        // (abstract functions hit the dotted branch above first).
        const fnOutline =
          (node.syntaxKind === 'FunctionDeclaration' ||
            node.syntaxKind === 'FunctionExpression' ||
            node.syntaxKind === 'ArrowFunction' ||
            node.syntaxKind === 'MethodDeclaration' ||
            node.syntaxKind === 'GetAccessor' ||
            node.syntaxKind === 'SetAccessor') &&
          cameraScale >= OUTLINE_BELOW;
        // Constructor: white box outline + a white wrench badge inside, on
        // the same cheap-cue zoom gate as the kind outlines.
        const isCtor =
          node.syntaxKind === 'Constructor' && cameraScale >= OUTLINE_BELOW;
        let borderColor: number = COLORS.astBorder;
        let borderWidth = 0.5;
        let borderAlpha = 0.9;
        if (isSelected) {
          // Selection blue as a thick outline, not a background recolor.
          borderColor = COLORS.astSelected;
          borderWidth = FILE_RIM / 2;
          borderAlpha = 1;
        } else if (kindOutline !== undefined) {
          // Selection still overrides the kind color so the active node
          // reads unambiguously. Counter-scale the width by 1/cameraScale so
          // the block/object outline stays a constant ~1px on screen and
          // doesn't thicken as you zoom in.
          borderColor = kindOutline;
          borderWidth = 1 / cameraScale;
          borderAlpha = 1;
        } else if (abstractOutline) {
          // Visible even when unselected — its own color/width, not the
          // faint default border (the dashing is applied below). Abstract
          // functions are grey; abstract classes/interfaces are green.
          borderColor = abstractFn
            ? COLORS.astOutlineAbstractFn
            : COLORS.astOutlineAbstract;
          borderWidth = 1 / cameraScale;
          borderAlpha = 1;
        } else if (classOutline) {
          // Solid green — same color as the class name, not dashed.
          borderColor = SYNTAX.type;
          borderWidth = 1 / cameraScale;
          borderAlpha = 1;
        } else if (isCtor) {
          borderColor = COLORS.astSelectedBorder; // white
          borderWidth = 1 / cameraScale;
          borderAlpha = 1;
        } else if (fnOutline) {
          // Solid grey — same color as an abstract function, but not dotted.
          borderColor = COLORS.astOutlineAbstractFn;
          borderWidth = 1 / cameraScale;
          borderAlpha = 1;
        }
        // Parameters (and call arguments — parameter blocks for a call) get
        // just-slightly-rounded corners, a subtle nod to the round brackets
        // a parameter list lives in — small enough the label stays inside.
        if (paramLike) {
          const radius = Math.min(
            4 / cameraScale, // ~4px on screen — a gentle curve, not a pill
            Math.min(node.rect.w, node.rect.h) / 2,
          );
          worldGfx
            .roundRect(x, y, node.rect.w, node.rect.h, radius)
            .fill({ color: fillColor, alpha: 0.92 })
            .stroke({ color: borderColor, width: borderWidth, alpha: borderAlpha });
        } else if (abstractOutline) {
          // Abstract definition: dashed/dotted box outline. Abstract
          // functions get a fine dotted pattern; abstract classes/interfaces
          // the extends-style dash. Fill first, then stroke the perimeter.
          const w = node.rect.w;
          const h = node.rect.h;
          worldGfx
            .rect(x, y, w, h)
            .fill({ color: fillColor, alpha: 0.92 });
          const dash = (abstractFn ? 1.2 : 3.5) / cameraScale;
          const dgap = (abstractFn ? 2.4 : 2.5) / cameraScale;
          emitDashed(
            worldGfx,
            [
              { x, y },
              { x: x + w, y },
              { x: x + w, y: y + h },
              { x, y: y + h },
              { x, y },
            ],
            dash,
            dgap,
          );
          worldGfx.stroke({
            color: borderColor,
            width: borderWidth,
            alpha: borderAlpha,
          });
        } else {
          worldGfx
            .rect(x, y, node.rect.w, node.rect.h)
            .fill({ color: fillColor, alpha: 0.92 })
            .stroke({ color: borderColor, width: borderWidth, alpha: borderAlpha });
        }

        pushRect({
          id: node.id,
          fileId,
          kind: 'ast',
          x,
          y,
          w: node.rect.w,
          h: node.rect.h,
          area: node.rect.w * node.rect.h,
        });

        // Constructor badge: a small white outlined wrench centered at the
        // top of the box (in the reserved label band), so a constructor is
        // recognizable even though it has no name label.
        if (isCtor) {
          const s = 11 / cameraScale; // glyph footprint, screen-constant
          // Centered horizontally; vertically centered in the reserved top
          // band (same height the treemap reserved for it).
          const bandH = labelScreenBox('').h;
          const gx = x + node.rect.w / 2 - s / 2;
          const gy = y + bandH / 2 - s / 2;
          const lw = 1.2 / cameraScale; // outline stroke, ~constant on screen
          const col = COLORS.astSelectedBorder; // white
          // Handle: lower-left → up toward the head.
          worldGfx
            .moveTo(gx + s * 0.12, gy + s * 0.9)
            .lineTo(gx + s * 0.58, gy + s * 0.44)
            .stroke({ color: col, width: lw, alpha: 1 });
          // Open-ring head (a spanner jaw): ~300° arc with a gap.
          const hcx = gx + s * 0.68;
          const hcy = gy + s * 0.32;
          const hr = s * 0.26;
          const a0 = -0.15 * Math.PI;
          const a1 = 1.55 * Math.PI;
          worldGfx
            .moveTo(hcx + hr * Math.cos(a0), hcy + hr * Math.sin(a0))
            .arc(hcx, hcy, hr, a0, a1)
            .stroke({ color: col, width: lw, alpha: 1 });
        }

        // Label every node that has room for one. Use the resolved name when
        // present (declarations, literals, import specifiers); otherwise fall
        // back to a friendly kind label like "return" or "if" so unnamed
        // statements/expressions are still identifiable. Suppress when the
        // parent's label is identical, to avoid stacking in cases like an
        // ImportSpecifier whose Identifier child shares the same text.
        // Show the label only while it actually fits its container ON SCREEN.
        // The label is counter-scaled (constant screen size), so as you zoom
        // out the container shrinks under it — gate on the same box the sizer
        // used so the label is hidden the moment it would spill out, instead
        // of overflowing.
        // Draw the header as colored segments: name (type) + " extends "
        // (keyword) + base (type), preserving syntax highlighting. Used in
        // place of the single-color put when the node has an extends clause.
        const segScale = 1 / cameraScale;
        const drawHeaderSegments = (
          startX: number,
          midY: number,
          centered: boolean,
        ): void => {
          const segs = [
            { t: node.name ?? '', c: syntaxColor(node) },
            { t: ' extends ', c: SYNTAX.keyword },
            { t: node.extendsName ?? '', c: SYNTAX.type },
          ];
          let total = 0;
          for (const s of segs) total += measureMono(s.t, 11).w;
          let cx = centered ? startX - (total * segScale) / 2 : startX;
          for (const s of segs) {
            if (!s.t) continue;
            labelPool.put({
              text: s.t,
              worldX: cx,
              worldY: midY,
              color: s.c,
              size: 11,
              anchorX: 0,
              anchorY: centered ? 0.5 : 0,
              scale: segScale,
            });
            cx += measureMono(s.t, 11).w * segScale;
          }
        };
        const composite = node.extendsName != null && node.name != null;
        // The " extends Base" suffix is a non-name detail, so it drops in the
        // simplified tier along with operators/kind labels — just the name.
        const showExtends = composite && !simplified;
        const labelText = labelFor(node);
        const labelBox = labelText ? labelScreenBox(labelText) : null;
        // A call site: the "call" word becomes a right-pointing triangle
        // outline; the callee text (if any) follows in the node's color.
        const isCall = node.syntaxKind === 'CallExpression';
        const callee =
          isCall && labelText && labelText.startsWith('call ')
            ? labelText.slice(5)
            : '';
        const drawCallGlyph = (
          startX: number,
          refY: number,
          centered: boolean,
        ): void => {
          const gs = 1 / cameraScale;
          // One line-box tall; triangle and text are both anchored on its
          // vertical center so they always read as centered with each other.
          const lineH = measureMono('x', 11).h * gs; // line-box, for centering
          const triH = 11 * gs; // same height as the label font
          const triW = triH * 0.85;
          const gap = 7 * gs; // breathing room between the glyph and the text
          const calleeW = callee ? measureMono(callee, 11).w * gs : 0;
          const totalW = triW + (callee ? gap + calleeW : 0);
          const sx = centered ? startX - totalW / 2 : startX;
          // `refY` is the line top for container labels, the line center for
          // centered (leaf) labels — normalize to a center either way.
          const cy = centered ? refY : refY + lineH / 2;
          worldGfx
            .poly([sx, cy - triH / 2, sx, cy + triH / 2, sx + triW, cy])
            .stroke({ color: syntaxColor(node), width: gs, alpha: 1 });
          if (callee) {
            labelPool.put({
              text: callee,
              worldX: sx + triW + gap,
              worldY: cy,
              color: syntaxColor(node),
              size: 11,
              anchorX: 0,
              anchorY: 0.5,
              scale: gs,
            });
          }
        };
        // In the simplified tier only real names (and name-like kinds such
        // as import/return) survive — other generic kind labels (type / if /
        // arrow fn / call / access …) drop out.
        const nameOk =
          !simplified ||
          node.name != null ||
          NAME_LIKE_KINDS.has(node.syntaxKind);
        if (node.labelChip && labelText && labelBox && nameOk) {
          // Relational left operand (e.g. `i` in `let i = j`): the name is
          // drawn centered in its reserved chip, not as a top-of-box label.
          const chip = node.labelChip;
          if (
            chip.w * cameraScale >= labelBox.w &&
            chip.h * cameraScale >= labelBox.h
          ) {
            labelPool.put({
              text: labelText,
              worldX: baseX + chip.x + chip.w / 2,
              worldY: baseY + chip.y + chip.h / 2,
              color: syntaxColor(node),
              size: 11,
              anchorX: 0.5,
              anchorY: 0.5,
              scale: 1 / cameraScale,
            });
          }
        } else if (
          labelText &&
          labelBox &&
          nameOk &&
          // Normally gated on fitting its box on screen; but high-level
          // constructs (classes/interfaces/exports) keep their label even
          // when zoomed out past the point it fits, so the structure stays
          // readable while lower-level semantics drop out.
          (isHighLevel(node) ||
            (wOnScreen >= labelBox.w && hOnScreen >= labelBox.h))
        ) {
          const parent = node.parentId ? tree.byId.get(node.parentId) : null;
          const parentLabel = parent ? labelFor(parent) : null;
          if (parentLabel !== labelText) {
            // In the simplified tier a composite header collapses to just
            // the name (labelText is a narrowed string in this block).
            const headerText =
              composite && simplified && node.name ? node.name : labelText;
            const hasKids = !!tree.childrenByParent.get(node.id)?.length;
            if (hasKids) {
              // Container: the label titles the children, top-left.
              if (showExtends) {
                drawHeaderSegments(
                  x + 4 / cameraScale,
                  y + 3 / cameraScale,
                  false,
                );
              } else if (isCall) {
                drawCallGlyph(
                  x + 4 / cameraScale,
                  y + 3 / cameraScale,
                  false,
                );
              } else {
                labelPool.put({
                  text: headerText,
                  worldX: x + 4 / cameraScale,
                  worldY: y + 3 / cameraScale,
                  color: syntaxColor(node),
                  size: 11,
                  anchorX: 0,
                  anchorY: 0,
                  scale: 1 / cameraScale,
                });
              }
            } else if (showExtends) {
              // Leaf class (empty body): centered composite header.
              drawHeaderSegments(
                x + node.rect.w / 2,
                y + node.rect.h / 2,
                true,
              );
            } else if (isCall) {
              drawCallGlyph(
                x + node.rect.w / 2,
                y + node.rect.h / 2,
                true,
              );
            } else {
              // Leaf / value (an operand like `20`, `i`, `j`): center it in
              // its box, symmetric with the left chip and the operator glyph.
              labelPool.put({
                text: headerText,
                worldX: x + node.rect.w / 2,
                worldY: y + node.rect.h / 2,
                color: syntaxColor(node),
                size: 11,
                anchorX: 0.5,
                anchorY: 0.5,
                scale: 1 / cameraScale,
              });
            }
          }
        }

        // The operator glyph, drawn centered between the two operand boxes
        // (`[i] = [j]`, `[[i] + [1]] + [j]`). Same constant-on-screen
        // counter-scaling and fits-on-screen gate as labels.
        if (node.op && node.opAnchor && !simplified) {
          const opBox = labelScreenBox(node.op);
          if (wOnScreen >= opBox.w && hOnScreen >= opBox.h) {
            labelPool.put({
              text: node.op,
              worldX: baseX + node.opAnchor.x,
              worldY: baseY + node.opAnchor.y,
              color: SYNTAX.default,
              size: 11,
              anchorX: 0.5,
              anchorY: 0.5,
              scale: 1 / cameraScale,
            });
          }
        }

        const kids = tree.childrenByParent.get(node.id);
        if (!kids) return;
        for (const k of kids) {
          drawAstNode(k, baseX, baseY, fileId, tree, selection);
        }
        // (Expanded-Block collapse handle now lives on the overlay,
        // top-left — see drawOverlay above. Main-scene Block cells
        // are always rendered as the small collapsed magenta square.)
      }

      // Ease the camera so the followed node sits at screen center. Runs
      // after draw() so visibleById reflects this frame. Snapshots the
      // node's position on the FIRST tick after `followStartAt` (so a
      // Block-toggle's delay lets the rect-grow animation finish first),
      // then eases toward that fixed point. The snapshot means the
      // camera doesn't chase the node if the d3-force sim is still
      // ticking in the background — it lands smoothly even when the
      // target's "true" position is still drifting by a few pixels per
      // frame.
      function updateFollow(): void {
        if (followId === null) return;
        if (performance.now() < followStartAt) return;
        if (followAt === null) {
          // First active frame — capture the current world position of
          // the target as the camera's fixed destination.
          const simNode = layout.byId.get(followId);
          if (simNode) {
            followAt = { x: simNode.x, y: simNode.y };
          } else {
            const r =
              visibleById.get(followId) ??
              findVisibleAnchor(followId, visibleById, activeTree);
            if (!r) return; // not resolvable yet — try again next frame
            followAt = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
          }
        }
        const targetX = app.screen.width / 2 - followAt.x * cameraScale;
        const targetY = app.screen.height / 2 - followAt.y * cameraScale;
        // Slightly gentler ease than before (was 0.18) so the post-
        // animation pan reads as a separate, deliberate motion rather
        // than an extension of the grow animation. easeOut shape:
        // bigger steps early, smaller as we approach.
        world.x += (targetX - world.x) * 0.12;
        world.y += (targetY - world.y) * 0.12;
        if (
          Math.abs(targetX - world.x) < 0.5 &&
          Math.abs(targetY - world.y) < 0.5
        ) {
          world.x = targetX;
          world.y = targetY;
          followId = null; // centered & settled — release the camera
          followAt = null;
        }
      }

      const tickerCb = () => {
        draw();
        updateFollow();
      };
      app.ticker.add(tickerCb);

      // Dev-only debug hook for headless visual testing. Lets a Playwright
      // script ask "where on screen is file X right now?" so it can dispatch
      // accurate mouse clicks. No-op in production builds.
      if (import.meta.env.DEV) {
        const wnd = window as unknown as { __codeGraph?: unknown };
        wnd.__codeGraph = {
          getFilePositions: () => {
            const rect = app.canvas.getBoundingClientRect();
            return layout.nodes.map((n) => {
              const wx = world.x + n.x * world.scale.x;
              const wy = world.y + n.y * world.scale.y;
              return {
                id: n.id,
                screenX: rect.left + wx,
                screenY: rect.top + wy,
                screenW: n.width * world.scale.x,
                screenH: n.height * world.scale.y,
              };
            });
          },
          getHitRects: () => {
            const rect = app.canvas.getBoundingClientRect();
            return hitRects.map((r) => ({
              id: r.id,
              kind: r.kind,
              fileId: r.fileId,
              screenX: rect.left + world.x + r.x * world.scale.x,
              screenY: rect.top + world.y + r.y * world.scale.y,
              screenW: r.w * world.scale.x,
              screenH: r.h * world.scale.y,
            }));
          },
          getCameraScale: () => world.scale.x,
          settle: () => layout.simulation.alpha(0).stop(),
        };
      }

      // Camera & input

      // Hover state: the HitRect currently under the cursor when the
      // user isn't dragging. drawAstNode uses it for:
      //   * brightening the outline of a hovered collapsed Block, and
      //   * brightening the top-right handle on a hovered expanded Block.
      // Stored as the full HitRect (not just id) so we can distinguish
      // an 'ast-toggle' handle hit from an 'ast' body hit — both carry
      // the same id (the Block's) but signal different intent.
      let hoveredHit: HitRect | null = null;

      const detachCamera = wireCamera({
        app,
        world,
        container,
        getCameraScale: () => cameraScale,
        setCameraScale: (s: number) => {
          cameraScale = s;
        },
        hitTest: (worldX: number, worldY: number) => {
          // Overlays first: an expanded Block's overlay sits on top of
          // the main scene, so its contents (and the underlying cell)
          // should win clicks within their bounds. Fall through to
          // the main scene's rects only when no overlay contains the
          // point.
          const overlay = smallestContaining(
            overlayHitRects,
            worldX,
            worldY,
          );
          if (overlay) return overlay;
          return smallestContaining(hitRects, worldX, worldY);
        },
        onClick: handleClick,
        onHover: (target) => {
          hoveredHit = target;
          // Pointer cursor when the click would TOGGLE a Block — that's
          // a collapsed Block (its rect IS the toggle target) or an
          // expanded Block's top-right handle ('ast-toggle' kind).
          // Clicking the empty body of an expanded Block also toggles,
          // but the body is mostly covered by children, so we don't
          // promise toggleability there with the cursor.
          let isToggleable = false;
          if (target?.kind === 'ast-toggle') {
            isToggleable = true;
          } else if (target?.kind === 'ast') {
            const tree = activeTree(target.fileId);
            const tn = tree?.byId.get(target.id);
            if (tn?.syntaxKind === 'Block' && tn.collapsed) isToggleable = true;
          }
          container.style.cursor = isToggleable ? 'pointer' : 'grab';
        },
        onUserCameraMove: () => {
          followId = null;
          followAt = null;
        },
      });

      function handleClick(target: HitRect | null) {
        if (!target) {
          useGraphStore.getState().setSelection(null);
          followId = null;
          followAt = null;
          return;
        }
        // Default: follow this node immediately. The Block-toggle path
        // below overrides `followStartAt` so the pan waits until the
        // grow/shrink animation completes — otherwise the camera
        // chases a target whose rect is being lerped. Handle clicks
        // (kind 'ast-toggle') are COLLAPSE actions: leave the camera
        // alone so the user's current view doesn't drift just because
        // they tucked away a block.
        if (target.kind === 'ast-toggle') {
          followId = null;
          followAt = null;
        } else {
          followId = target.id;
          followStartAt = 0;
          followAt = null;
        }
        if (target.kind === 'file') {
          void onFileClick(target.fileId);
          return;
        }
        const state = useGraphStore.getState();
        // Don't reset selection when the click was on a Block's
        // top-right handle — the user is collapsing the block, not
        // selecting it; preserving the existing selection means an
        // accidental handle click doesn't jump the editor pane.
        if (target.kind !== 'ast-toggle') {
          state.setSelection(target.id);
        }
        // Block toggle: clicking the magenta cell (in the main scene)
        // or an overlay's handle (kind 'ast-toggle') flips this Block
        // in expandedAstNodes. The MAIN layout doesn't change — the
        // file's footprint is stable across toggles — so we don't
        // call applyExpansionToSim. drawOverlay reads the new
        // expandedAstNodes set on the next frame and renders the
        // overlay; startBlockAnim primes the rect-grow animation.
        const mainTree = activeTree(target.fileId);
        const tn = mainTree?.byId.get(target.id);
        const isBlock =
          tn?.syntaxKind === 'Block' || target.kind === 'ast-toggle';
        if (isBlock) {
          // Two cases for the prev-rect snapshot:
          //   * Expanding: target is the cell HitRect (kind 'ast'); its
          //     w/h are the cell's small size.
          //   * Collapsing: target is the overlay handle (kind
          //     'ast-toggle'). prev is the OVERLAY's current rendered
          //     size — read the overlay layout root's rect for that.
          let prevW: number;
          let prevH: number;
          if (target.kind === 'ast-toggle') {
            const overlayTree = getOverlayLayout(target.id);
            const root = overlayTree?.byId.get(target.id);
            prevW = root?.rect.w ?? target.w;
            prevH = root?.rect.h ?? target.h;
          } else {
            prevW = target.w;
            prevH = target.h;
          }
          state.toggleAstNode(target.id);
          startBlockAnim(target.id, prevW, prevH);
          // Defer the camera pan until the overlay-grow animation is
          // done. updateFollow honours this AND snapshots the target's
          // position on its first active frame so the camera eases
          // toward a fixed point rather than chasing the sim, which
          // is what produced the "bouncing around" perception.
          followStartAt = performance.now() + BLOCK_ANIM_DURATION;
        }
      }

      async function onFileClick(fileId: string): Promise<void> {
        const state = useGraphStore.getState();
        // Selection updates synchronously so the editor pane starts loading
        // this file's source immediately. The AST/expansion work below can
        // run in the background — it doesn't block the editor.
        state.setSelection(fileId);

        if (state.expandedFiles.has(fileId)) {
          state.collapseFile(fileId);
          dropSubtreeLayout(fileId);
          applyExpansionToSim();
          return;
        }
        if (!state.asts.has(fileId) && !fetching.has(fileId)) {
          fetching.add(fileId);
          try {
            const ast = await getFileAst(project.projectId, fileId);
            state.setFileAst(fileId, ast);
          } catch (err) {
            console.error('[code-graph] AST fetch failed', err);
            fetching.delete(fileId);
            return;
          }
          fetching.delete(fileId);
        }
        useGraphStore.getState().expandFile(fileId);
        applyExpansionToSim();
        buildSubtreeLayout(fileId);
      }

      cleanup = () => {
        // Snapshot camera so a rebuild for the same rootPath can restore it.
        savedCamera = {
          rootPath: project.rootPath,
          x: world.x,
          y: world.y,
          scale: world.scale.x,
        };
        layout.simulation.stop();
        detachCamera();
        labelPool.destroy();
        app.ticker.remove(tickerCb);
        app.destroy(true, { children: true, texture: true });
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [project]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', cursor: 'grab' }}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers (out of the React component to keep the hook body smaller)
// ---------------------------------------------------------------------------

// Pixi v8 Graphics has no native line dash, so a dashed stroke is just each
// "on" span emitted as its own moveTo/lineTo subpath; the caller strokes them
// all with one .stroke(). Lengths are world units (callers pass screen-
// constant values via 1/cameraScale where the layer is counter-scaled).
function emitDashed(
  gfx: Graphics,
  pts: { x: number; y: number }[],
  dash: number,
  gap: number,
): void {
  if (pts.length < 2) return;
  let on = true;
  let left = dash;
  let ax = pts[0].x;
  let ay = pts[0].y;
  gfx.moveTo(ax, ay);
  for (let i = 1; i < pts.length; i++) {
    const bx = pts[i].x;
    const by = pts[i].y;
    let segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-6) continue;
    const dx = (bx - ax) / segLen;
    const dy = (by - ay) / segLen;
    while (segLen > 1e-6) {
      const step = Math.min(left, segLen);
      ax += dx * step;
      ay += dy * step;
      if (on) gfx.lineTo(ax, ay);
      segLen -= step;
      left -= step;
      if (left <= 1e-6) {
        on = !on;
        left = on ? dash : gap;
        gfx.moveTo(ax, ay);
      }
    }
  }
}

// Flatten a cubic bezier to a polyline so it can be dashed.
function cubicPath(
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p3: { x: number; y: number },
  steps: number,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    pts.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
    });
  }
  return pts;
}

function drawEdges(
  layout: FileLayoutResult,
  edges: readonly ImportEdge[],
  forceLookup: (fileId: string) => AstForceLayout | undefined,
  gfx: Graphics,
  cameraScale: number,
  visibleSemanticPairs: ReadonlySet<string>,
): void {
  // Import links: a quiet subdued background layer. Suppressed when a
  // calls/extends/implements link is already visible between the same two
  // files — that semantic relationship makes the import implicit.
  //
  // Endpoints:
  //   - Source: when the importing file is expanded and we know the AST id
  //     of the `import` statement, anchor at that block's CENTER in world
  //     coords (cluster centroid → file center mapping). The line visibly
  //     emerges from the specific statement that owns it.
  //   - Target: when the imported file is expanded, clip the line to the
  //     file's circle boundary along the source→target direction so it
  //     doesn't plunge through the AST contents to a phantom centre point.
  for (const edge of edges) {
    const s = layout.byId.get(edge.fromId);
    const t = layout.byId.get(edge.toId);
    if (!s || !t) continue;
    if (visibleSemanticPairs.has(`${edge.fromId} ${edge.toId}`)) continue;

    // Source point: import-block center if available, else file center.
    let sx = s.x;
    let sy = s.y;
    if (s.expanded && edge.fromAstNodeId) {
      const force = forceLookup(edge.fromId);
      const sn = force?.byId.get(edge.fromAstNodeId);
      if (force && sn) {
        sx = s.x - force.bounds.cx + sn.x;
        sy = s.y - force.bounds.cy + sn.y;
      }
    }

    // Target point: clip to circle if expanded.
    let tx = t.x;
    let ty = t.y;
    if (t.expanded) {
      const r = t.width / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const dist = Math.hypot(dx, dy);
      if (dist > r) {
        tx -= (dx / dist) * r;
        ty -= (dy / dist) * r;
      }
    }

    gfx
      .moveTo(sx, sy)
      .lineTo(tx, ty)
      .stroke({
        color: COLORS.edge,
        width: 1.5 / cameraScale, // ~1.5px on screen, zoom-stable
        alpha: 0.7,
      });
  }
}

// Call/implements connector. Picks the closest pair of edge-midpoint ports
// (top/bottom/left/right center) on the caller and callee rects so the two
// nodes connect over the shortest span, and bows the curve out perpendicular
// to each chosen face (handle length scales with the gap, clamped).
function callConnector(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): {
  startPort: { x: number; y: number };
  endPort: { x: number; y: number };
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
} {
  const ports = (r: { x: number; y: number; w: number; h: number }) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return [
      { x: cx, y: r.y, nx: 0, ny: -1 }, // top
      { x: cx, y: r.y + r.h, nx: 0, ny: 1 }, // bottom
      { x: r.x, y: cy, nx: -1, ny: 0 }, // left
      { x: r.x + r.w, y: cy, nx: 1, ny: 0 }, // right
    ];
  };
  const fps = ports(from);
  const tps = ports(to);
  let best = { d: Infinity, a: fps[0], b: tps[0] };
  for (const a of fps) {
    for (const b of tps) {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < best.d) best = { d, a, b };
    }
  }
  const { a, b, d } = best;
  // Handle out of each face so the curve enters/exits perpendicular; scales
  // with the span, with a floor (short hops still bow) and a cap.
  const h = Math.min(Math.max(d * 0.5, 36), 260);
  return {
    startPort: { x: a.x, y: a.y },
    endPort: { x: b.x, y: b.y },
    cp1: { x: a.x + a.nx * h, y: a.y + a.ny * h },
    cp2: { x: b.x + b.nx * h, y: b.y + b.ny * h },
  };
}

// Pick a pair of OPPOSITE face midpoints on `via` to terminate the two
// halves of a via-routed connector. The pair is always (top, bottom) or
// (left, right) — never adjacent faces — so the two curves emerge from
// genuinely opposite sides and leave a visible gap across the import
// binding (the dashed-outlined rect that sits between them reads as a
// "portal" the connector passes through).
//
// Within a pair, the orientation (which face is entry vs exit) is chosen
// to minimise total `dist(entry, FROM) + dist(exit, TO)`. The axis itself
// (horizontal vs vertical) is chosen by comparing both arrangements'
// totals, so when FROM is below and TO is above we get (bottom, top); when
// FROM is to the right and TO to the left we get (right, left); etc.
function viaPortsOpposite(
  from: { x: number; y: number; w: number; h: number },
  via: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): {
  entry: { x: number; y: number; nx: number; ny: number };
  exit: { x: number; y: number; nx: number; ny: number };
} {
  const cf = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const ct = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const cv = { x: via.x + via.w / 2, y: via.y + via.h / 2 };
  const top = { x: cv.x, y: via.y, nx: 0, ny: -1 };
  const bottom = { x: cv.x, y: via.y + via.h, nx: 0, ny: 1 };
  const left = { x: via.x, y: cv.y, nx: -1, ny: 0 };
  const right = { x: via.x + via.w, y: cv.y, nx: 1, ny: 0 };
  const pairs: [
    { x: number; y: number; nx: number; ny: number },
    { x: number; y: number; nx: number; ny: number },
  ][] = [
    [top, bottom],
    [left, right],
  ];
  type Choice = {
    entry: { x: number; y: number; nx: number; ny: number };
    exit: { x: number; y: number; nx: number; ny: number };
    score: number;
  };
  let best: Choice = { entry: pairs[0][0], exit: pairs[0][1], score: Infinity };
  for (const [a, b] of pairs) {
    const o1 = Math.hypot(a.x - cf.x, a.y - cf.y) + Math.hypot(b.x - ct.x, b.y - ct.y);
    const o2 = Math.hypot(b.x - cf.x, b.y - cf.y) + Math.hypot(a.x - ct.x, a.y - ct.y);
    if (o1 < best.score) best = { entry: a, exit: b, score: o1 };
    if (o2 < best.score) best = { entry: b, exit: a, score: o2 };
  }
  return { entry: best.entry, exit: best.exit };
}

// Cubic curve from an arbitrary fixed start port (with its outward normal)
// to the closest face midpoint on `to`. Mirror of callConnector but with
// one endpoint pinned — used to anchor both halves of a via-routed edge
// at the same point on the via-binding.
function curveFromPortToRect(
  start: { x: number; y: number; nx: number; ny: number },
  to: { x: number; y: number; w: number; h: number },
): {
  startPort: { x: number; y: number };
  endPort: { x: number; y: number };
  cp1: { x: number; y: number };
  cp2: { x: number; y: number };
} {
  const cx = to.x + to.w / 2;
  const cy = to.y + to.h / 2;
  const candidates = [
    { x: cx, y: to.y, nx: 0, ny: -1 },
    { x: cx, y: to.y + to.h, nx: 0, ny: 1 },
    { x: to.x, y: cy, nx: -1, ny: 0 },
    { x: to.x + to.w, y: cy, nx: 1, ny: 0 },
  ];
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - start.x, c.y - start.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const h = Math.min(Math.max(bestD * 0.5, 36), 260);
  return {
    startPort: { x: start.x, y: start.y },
    endPort: { x: best.x, y: best.y },
    cp1: { x: start.x + start.nx * h, y: start.y + start.ny * h },
    cp2: { x: best.x + best.nx * h, y: best.y + best.ny * h },
  };
}

// Control points for the inheritance connector: BOTTOM of the superclass
// (`start`, the thing being extended) → TOP of the subclass (`end`, the thing
// that extends it). Fixed vertical class-hierarchy geometry:
//  (a) leave the bottom port going DOWN so it clears the superclass body;
//  (b) arrive at the top port VERTICALLY so the arrowhead reads as entering
//      the top edge — `cp2.x === end.x` is the invariant the tangent math
//      depends on;
//  (c) clamp reach so it stays sane across the rect-size range.
function inheritanceBezierControls(
  start: { x: number; y: number },
  end: { x: number; y: number },
): { cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Back-travel: the subclass top sitting *above* the superclass bottom is
  // the cusp case (curve exits downward then has to climb back up). Feed it
  // into the reach so that loop rounds out instead of kinking.
  const back = Math.max(0, -dy);
  const reach = clamp(0.5 * Math.abs(dy) + 0.7 * back + 40, 64, 320);
  const bias = clamp(0.3 * Math.abs(dx) + 18, 24, 150) * Math.sign(dx || 1);
  return {
    cp1: { x: start.x + bias, y: start.y + reach },
    cp2: { x: end.x, y: end.y - reach },
  };
}

function drawSemanticEdges(
  edges: readonly SemanticEdge[],
  gfx: Graphics,
  visibleById: Map<string, HitRect>,
  treeLookup: (fileId: string) => TreemapLayout | undefined,
  cameraScale: number,
  selection: string | null,
  expandedFiles: ReadonlySet<string>,
  // Rebuilt here each frame: directional `${fromFile} ${toFile}` keys for
  // every edge actually drawn, so drawEdges can suppress redundant imports.
  visibleSemanticPairs: Set<string>,
): void {
  visibleSemanticPairs.clear();
  const fileOf = (id: string): string => {
    const i = id.lastIndexOf('#');
    return i > 0 ? id.slice(0, i) : id;
  };
  // Connector geometry (curve path, port/outline positions) stays in world
  // space so it tracks the nodes, but every *size* — line width, outline
  // width, port radius, arrowhead — is multiplied by 1/cameraScale so it
  // renders at a constant screen size and doesn't thicken as you zoom in.
  // Same technique the labels use (see labelScale = 1 / cameraScale).
  const invScale = 1 / cameraScale;
  // Many AST-level edges may lift to the same pair of visible anchors —
  // dedupe per (kind, fromAnchor.id, toAnchor.id) so we draw one thick edge
  // instead of N stacked translucent ones.
  const seen = new Set<string>();
  // Many edges can share one resolved port (N callers → one callee). Filled
  // circles with alpha < 1 would additively darken into a blob, so dedupe the
  // markers independently of the edge dedupe above.
  const drawnPorts = new Set<string>();
  // The called element gets a thin outline in the edge color; dedupe per
  // (kind, rect) so overlapping calls don't stack the stroke into a blob.
  const drawnOutlines = new Set<string>();
  for (const edge of edges) {
    // Call links come back early (CALLS_BELOW), well before full detail —
    // otherwise they'd be invisible until an expanded node fills the screen.
    // They're still only meaningful when you can see who's calling: if the
    // caller's own node isn't on screen (its file is collapsed, or it was
    // LOD-culled) the edge would just dangle from a lifted ancestor, so
    // require the calling node itself to be directly visible.
    // (`extends`/`implements` still lift to a visible ancestor.)
    if (
      edge.kind === 'calls' &&
      (cameraScale < CALLS_BELOW || !visibleById.has(edge.fromId))
    ) {
      continue;
    }
    const from = findVisibleAnchor(edge.fromId, visibleById, treeLookup);
    const to = findVisibleAnchor(edge.toId, visibleById, treeLookup);
    if (!from || !to || from.id === to.id) continue;
    // Call links are dimmed to 50% until you select one of their ends, then
    // shown at full strength. Match the raw endpoints and the resolved
    // visible anchors (the callee may have lifted to an ancestor/file you'd
    // actually click).
    const callerSelected =
      selection !== null &&
      (selection === edge.fromId || selection === from.id);
    const calleeSelected =
      selection !== null &&
      (selection === edge.toId || selection === to.id);
    // "Caller or callee selected" — drives the 50%↔full dim and the callee
    // outline.
    const callSelected = callerSelected || calleeSelected;
    const key = `${edge.kind}|${from.id}|${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // This edge is committed to being drawn — record its file pair so the
    // (now-implicit) import line between these two files is suppressed.
    const fromFile = fileOf(edge.fromId);
    const toFile = fileOf(edge.toId);
    if (fromFile !== toFile) {
      visibleSemanticPairs.add(`${fromFile} ${toFile}`);
    }

    // Each kind has its own port geometry. `calls`/`implements` read as
    // dataflow: out of the caller's bottom-right, into the callee's top-left
    // corner (where its label sits, so the call lands on the named thing).
    // `extends` reads as a class hierarchy: out of the BOTTOM of the thing
    // being extended (the superclass, `to`), into the TOP of the thing that
    // extends it (the subclass, `from`). A cubic bezier joins the two ports
    // so the line bows into open space, and the arrowhead is oriented along
    // the curve's end tangent. The called element also gets a thin outline
    // in the edge color so the reference target is easy to spot.
    const style = SEMANTIC_EDGE_STYLE[edge.kind];
    let edgeAlpha = style.alpha;
    let dashed = false;
    if (edge.kind === 'calls') {
      // 30% until the caller/callee is selected, then full strength.
      edgeAlpha = callSelected ? style.alpha : 0.3;
    } else {
      // extends / implements: dashed + 50% by default; fully opaque when the
      // implementing/extending node's file is expanded; solid (and opaque)
      // when that node itself is selected.
      const h = edge.fromId.lastIndexOf('#');
      const srcFile = h > 0 ? edge.fromId.slice(0, h) : edge.fromId;
      const srcSelected =
        selection === edge.fromId || selection === from.id;
      dashed = !srcSelected;
      edgeAlpha = srcSelected || expandedFiles.has(srcFile) ? 1 : 0.5;
    }
    // Routing the extends/implements line THROUGH the import binding when
    // the source file is expanded: subclass → local imported name → real
    // superclass (which lives in another file). The import binding itself
    // gets the dashed outline below so it visually stands in for the
    // external symbol it represents.
    let via: HitRect | null = null;
    if (
      (edge.kind === 'extends' || edge.kind === 'implements') &&
      edge.viaImportNodeId
    ) {
      const srcFile = fromFile;
      if (expandedFiles.has(srcFile)) {
        const v = findVisibleAnchor(
          edge.viaImportNodeId,
          visibleById,
          treeLookup,
        );
        // Only honor the via-binding when it resolves to something INSIDE
        // the source file's AST (not the fallback file rect). If LOD has
        // culled it down to the file itself, the routed path would
        // degenerate, so we draw the direct connector instead.
        if (v && v.id !== from.id && v.id !== to.id && v.id !== srcFile) {
          via = v;
        }
      }
    }

    let startPort: { x: number; y: number };
    let endPort: { x: number; y: number };
    let cp1: { x: number; y: number };
    let cp2: { x: number; y: number };
    // For the via-routed path we also need a second curve's controls.
    let cp1b: { x: number; y: number } | null = null;
    let cp2b: { x: number; y: number } | null = null;
    let midPortIn: { x: number; y: number } | null = null;
    let midPortOut: { x: number; y: number } | null = null;
    if (via) {
      // Two distinct curve segments terminating on OPPOSITE faces of the
      // via rect — entry face is closest to FROM, exit face is its
      // direct opposite (and lands closest to TO). The dashed-outlined
      // via box sits between the two curves like a portal: the connector
      // visibly passes through the import binding rather than around it.
      const ports = viaPortsOpposite(from, via, to);
      // Curve A: FROM → via.entry. Build it as port→rect and then swap
      // start/end so cubicPath orders the points from→via.
      const segA = curveFromPortToRect(ports.entry, from);
      startPort = segA.endPort;
      cp1 = segA.cp2;
      cp2 = segA.cp1;
      midPortIn = segA.startPort;
      // Curve B: via.exit → TO. As-is.
      const segB = curveFromPortToRect(ports.exit, to);
      midPortOut = segB.startPort;
      cp1b = segB.cp1;
      cp2b = segB.cp2;
      endPort = segB.endPort;
    } else if (edge.kind === 'extends') {
      startPort = { x: to.x + to.w / 2, y: to.y + to.h }; // bottom of superclass
      endPort = { x: from.x + from.w / 2, y: from.y };    // top of subclass
      ({ cp1, cp2 } = inheritanceBezierControls(startPort, endPort));
    } else {
      // Closest top/bottom/left/right edge-center ports on both rects.
      ({ startPort, endPort, cp1, cp2 } = callConnector(from, to));
    }

    if (dashed) {
      // First segment. When the line is routed via an import binding the
      // FROM→via.entry hop is always intra-file (the binding lives in the
      // source file's own cluster) and short — a curve there reads as
      // decorative noise, so we draw a straight dashed line. The
      // second segment (via.exit → TO) stays curved because it generally
      // crosses to another file.
      if (via && midPortIn) {
        emitDashed(gfx, [startPort, midPortIn], 3.5 * invScale, 2.5 * invScale);
      } else {
        emitDashed(
          gfx,
          cubicPath(startPort, cp1, cp2, endPort, 48),
          3.5 * invScale, // fine dash, screen-constant
          2.5 * invScale,
        );
      }
      gfx.stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
      if (via && midPortOut && cp1b && cp2b) {
        // Second curve: via.exit → to. Same dash so the two segments
        // read as one routed connector. The gap between midPortIn and
        // midPortOut is the dashed-outlined import binding.
        emitDashed(
          gfx,
          cubicPath(midPortOut, cp1b, cp2b, endPort, 48),
          3.5 * invScale,
          2.5 * invScale,
        );
        gfx.stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
        // Dashed outline around the import-binding rect: marks it as the
        // local stand-in for the external superclass/interface.
        const rectPath = [
          { x: via.x, y: via.y },
          { x: via.x + via.w, y: via.y },
          { x: via.x + via.w, y: via.y + via.h },
          { x: via.x, y: via.y + via.h },
          { x: via.x, y: via.y },
        ];
        emitDashed(gfx, rectPath, 3.5 * invScale, 2.5 * invScale);
        gfx.stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
      }
    } else {
      // Same straight-vs-curved split for the selected/solid edge style.
      if (via && midPortIn) {
        gfx
          .moveTo(startPort.x, startPort.y)
          .lineTo(midPortIn.x, midPortIn.y)
          .stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
      } else {
        gfx
          .moveTo(startPort.x, startPort.y)
          .bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endPort.x, endPort.y)
          .stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
      }
      if (via && midPortOut && cp1b && cp2b) {
        gfx
          .moveTo(midPortOut.x, midPortOut.y)
          .bezierCurveTo(cp1b.x, cp1b.y, cp2b.x, cp2b.y, endPort.x, endPort.y)
          .stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
        gfx
          .rect(via.x, via.y, via.w, via.h)
          .stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
      }
    }

    // Counter-scaled radius so the port stays a constant size on screen,
    // matching the (also counter-scaled) line, arrowhead and outline.
    const portR = style.arrowSize * 0.35 * invScale;
    for (const p of [startPort, endPort]) {
      const portKey = `${edge.kind}|${Math.round(p.x)},${Math.round(p.y)}`;
      if (drawnPorts.has(portKey)) continue;
      drawnPorts.add(portKey);
      gfx.circle(p.x, p.y, portR).fill({ color: style.color, alpha: edgeAlpha });
    }

    // Selection-gated outlines in the edge color (orange for calls), width
    // matching the connecting line. The callee is outlined when it or its
    // caller is selected; the caller is outlined only when it itself is
    // selected. (calls/implements only — `extends` has its own treatment.)
    if (edge.kind !== 'extends') {
      const outline = (rect: HitRect, role: string): void => {
        const k = `${edge.kind}|${role}|${rect.id}`;
        if (drawnOutlines.has(k)) return;
        drawnOutlines.add(k);
        gfx
          .rect(rect.x, rect.y, rect.w, rect.h)
          .stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
      };
      if (callSelected) outline(to, 'callee');
      if (callerSelected) outline(from, 'caller');
    }

    // A cubic's end derivative is proportional to (P3 - P2), so the incoming
    // direction at the target port is (endPort - lastCp). When the line is
    // routed via the import binding, the LAST curve's control is cp2b.
    const lastCp = cp2b ?? cp2;
    drawArrowhead(
      gfx,
      endPort.x,
      endPort.y,
      Math.atan2(endPort.y - lastCp.y, endPort.x - lastCp.x),
      style.arrowSize * invScale,
      style.color,
      edgeAlpha,
    );
  }
}

function findVisibleAnchor(
  id: string,
  visibleById: Map<string, HitRect>,
  treeLookup: (fileId: string) => TreemapLayout | undefined,
): HitRect | null {
  const direct = visibleById.get(id);
  if (direct) return direct;
  const hashIdx = id.lastIndexOf('#');
  if (hashIdx <= 0) {
    // The id is a fileId already (no # suffix).
    return visibleById.get(id) ?? null;
  }
  const fileId = id.slice(0, hashIdx);
  const tree = treeLookup(fileId);
  if (tree) {
    let cur: string | null = id;
    // Walk the AST parent chain looking for a visible (LOD-survived) ancestor.
    while (cur) {
      const r = visibleById.get(cur);
      if (r) return r;
      cur = tree.byId.get(cur)?.parentId ?? null;
    }
  }
  // File not expanded, or no visible ancestor in the tree — anchor on the
  // collapsed file rect, which always renders.
  return visibleById.get(fileId) ?? null;
}

function drawArrowhead(
  gfx: Graphics,
  tipX: number,
  tipY: number,
  angle: number,
  size: number,
  color: number,
  alpha: number,
): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const baseX = tipX - dx * size;
  const baseY = tipY - dy * size;
  const half = size * 0.45;
  // perpendicular
  const px = -dy;
  const py = dx;
  gfx
    .poly([
      tipX,
      tipY,
      baseX + px * half,
      baseY + py * half,
      baseX - px * half,
      baseY - py * half,
    ])
    .fill({ color, alpha });
}

function smallestContaining(rects: HitRect[], wx: number, wy: number): HitRect | null {
  let best: HitRect | null = null;
  for (const r of rects) {
    if (wx < r.x || wx > r.x + r.w || wy < r.y || wy > r.y + r.h) continue;
    if (!best || r.area < best.area) best = r;
  }
  return best;
}

function depthTint(depth: number): number {
  // Slightly lighten with depth so nesting is visible without hard borders.
  const base = 0x222229;
  const stepped = Math.min(8, depth) * 5;
  const r = ((base >> 16) & 0xff) + stepped;
  const g = ((base >> 8) & 0xff) + stepped;
  const b = (base & 0xff) + stepped;
  return (r << 16) | (g << 8) | b;
}


interface CameraDeps {
  app: Application;
  world: Container;
  container: HTMLDivElement;
  getCameraScale: () => number;
  setCameraScale: (s: number) => void;
  hitTest: (wx: number, wy: number) => HitRect | null;
  onClick: (target: HitRect | null) => void;
  // Called whenever the (non-dragging) cursor moves over a new target.
  // `null` means the cursor moved off any hit-tested rect. Used by the
  // renderer to highlight collapsed Block cells under the cursor and to
  // flip container.style.cursor between 'grab' and 'pointer'.
  onHover: (target: HitRect | null) => void;
  // Called when the user takes manual camera control (drag-pan or zoom) so an
  // in-progress auto-pan/follow can bow out.
  onUserCameraMove: () => void;
}

function wireCamera(deps: CameraDeps): () => void {
  const { app, world, container, setCameraScale, hitTest, onClick, onHover } = deps;
  const { onUserCameraMove } = deps;
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;

  const DRAG_DEADZONE = 4;
  let dragging = false;
  let pointerStart = { x: 0, y: 0 };
  let worldStart = { x: 0, y: 0 };
  let movedDistance = 0;
  let pendingTarget: HitRect | null = null;

  const screenToWorld = (sx: number, sy: number) => ({
    x: (sx - world.x) / world.scale.x,
    y: (sy - world.y) / world.scale.y,
  });

  const onDown = (e: FederatedPointerEvent) => {
    const w = screenToWorld(e.global.x, e.global.y);
    pendingTarget = hitTest(w.x, w.y);
    dragging = true;
    movedDistance = 0;
    pointerStart = { x: e.global.x, y: e.global.y };
    worldStart = { x: world.x, y: world.y };
    container.style.cursor = 'grabbing';
  };

  let lastHoverId: string | null = null;
  const onMove = (e: FederatedPointerEvent) => {
    if (dragging) {
      const dx = e.global.x - pointerStart.x;
      const dy = e.global.y - pointerStart.y;
      movedDistance = Math.max(movedDistance, Math.hypot(dx, dy));
      if (movedDistance > DRAG_DEADZONE) {
        pendingTarget = null;
        onUserCameraMove();
        world.x = worldStart.x + dx;
        world.y = worldStart.y + dy;
      }
      return;
    }
    // Hover tracking: only when NOT dragging — during drag the rect under
    // the cursor is moving, so hover is meaningless. Sub-pixel changes
    // would re-hit-test every frame; we de-dupe per HitRect id so the
    // callback only fires when the cursor crosses into / out of a rect.
    const w = screenToWorld(e.global.x, e.global.y);
    const hit = hitTest(w.x, w.y);
    const hitId = hit?.id ?? null;
    if (hitId !== lastHoverId) {
      lastHoverId = hitId;
      onHover(hit);
    }
  };

  const onUp = () => {
    if (dragging && movedDistance < DRAG_DEADZONE) {
      onClick(pendingTarget);
    }
    dragging = false;
    pendingTarget = null;
    container.style.cursor = 'grab';
  };

  app.stage.on('pointerdown', onDown);
  app.stage.on('pointermove', onMove);
  app.stage.on('pointerup', onUp);
  app.stage.on('pointerupoutside', onUp);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    onUserCameraMove();
    const rect = container.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = clamp(world.scale.x * factor, 0.05, 32);
    const k = next / world.scale.x;
    world.x = px - (px - world.x) * k;
    world.y = py - (py - world.y) * k;
    world.scale.set(next);
    setCameraScale(next);
  };
  container.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    app.stage.off('pointerdown', onDown);
    app.stage.off('pointermove', onMove);
    app.stage.off('pointerup', onUp);
    app.stage.off('pointerupoutside', onUp);
    container.removeEventListener('wheel', onWheel);
  };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// ---------------------------------------------------------------------------
// Label pool — reuses Pixi Text instances across frames.
// ---------------------------------------------------------------------------

interface LabelRequest {
  text: string;
  worldX: number;
  worldY: number;
  color: number;
  size: number;
  anchorX?: number;
  anchorY?: number;
  // Multiplier applied to the label's own scale. Pass `1/cameraScale` to
  // counteract the world container's zoom and keep the rasterized text
  // constant on screen regardless of how far in/out the user has zoomed.
  scale?: number;
}

class LabelPool {
  private parent: Container;
  private labels: Text[] = [];
  private cursor = 0;

  constructor(parent: Container) {
    this.parent = parent;
  }

  beginFrame(): void {
    this.cursor = 0;
  }

  put(req: LabelRequest): void {
    let label = this.labels[this.cursor];
    if (!label) {
      label = new Text({
        text: req.text,
        style: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: req.size,
          fill: req.color,
        },
      });
      label.eventMode = 'none';
      this.parent.addChild(label);
      this.labels.push(label);
    } else {
      // Only update text/style when changed; Pixi's Text is dirty-checked
      // internally but setting equal strings is still cheap.
      if (label.text !== req.text) label.text = req.text;
      if (label.style.fontSize !== req.size) label.style.fontSize = req.size;
      if (label.style.fill !== req.color) label.style.fill = req.color;
    }
    label.anchor.set(req.anchorX ?? 0.5, req.anchorY ?? 0.5);
    label.position.set(req.worldX, req.worldY);
    const s = req.scale ?? 1;
    label.scale.set(s);
    label.visible = true;
    this.cursor++;
  }

  endFrame(): void {
    for (let i = this.cursor; i < this.labels.length; i++) {
      this.labels[i].visible = false;
    }
  }

  destroy(): void {
    for (const l of this.labels) l.destroy();
    this.labels = [];
  }
}
