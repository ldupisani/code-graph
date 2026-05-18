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
import { fileLabel, labelScreenBox } from '../graph/labels';
import { useGraphStore } from '../graph/store';
import {
  fitInterior,
  layoutAst,
  type TreemapLayout,
  type TreemapNode,
} from '../graph/treemap';
import type {
  FileAstResponse,
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
  text: 0xeeeeee,
  textDim: 0xb0b0b8,
  edge: 0x565a63, // import links: subdued but always visible
} as const;

const SEMANTIC_EDGE_STYLE: Record<
  SemanticEdgeKind,
  { color: number; width: number; alpha: number; arrowSize: number }
> = {
  calls: { color: 0xff8b3d, width: 1.2, alpha: 0.85, arrowSize: 7 },
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
  ExpressionWithTypeArguments: 'type ref',
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
function labelFor(node: { name: string | null; syntaxKind: string }): string | null {
  if (node.name) return node.name;
  return SYNTAX_KIND_LABELS[node.syntaxKind] ?? null;
}

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
  return labelFor(node) !== null || KIND_OUTLINE[node.syntaxKind] !== undefined;
}

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
  kind: 'file' | 'ast';
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
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
      // Restore camera if we're rebuilding the same project (filesystem
      // refresh); otherwise center.
      if (savedCamera && savedCamera.rootPath === project.rootPath) {
        world.position.set(savedCamera.x, savedCamera.y);
        world.scale.set(savedCamera.scale);
      } else {
        world.position.set(app.screen.width / 2, app.screen.height / 2);
      }

      // Scene graph layering, bottom-up:
      //   worldGfx       — rects (file + AST) + file-level import edges
      //   labelLayer     — Pixi Text labels (on top of rects so they're legible)
      //   semanticEdgeGfx — semantic edges + arrowheads (on top of labels so
      //                     no call/extends arrow can be hidden by a label or rect)
      const worldGfx = new Graphics();
      world.addChild(worldGfx);

      const labelLayer = new Container();
      world.addChild(labelLayer);

      const semanticEdgeGfx = new Graphics();
      world.addChild(semanticEdgeGfx);

      // The filename is now drawn ABOVE the box (outside it), so only a small
      // top inset is kept inside so AST content doesn't touch the border.
      const TITLE_STRIP = 6;

      // Per-file AST treemap layouts, populated when a file is expanded.
      const subtreeByFileId = new Map<string, TreemapLayout>();
      // In-flight AST fetches we track to avoid double-firing on rapid clicks.
      const fetching = new Set<string>();

      // Hit-rects list rebuilt every frame in world coords; smallest area wins.
      const hitRects: HitRect[] = [];
      // Same data keyed by id for O(1) anchor lookup during edge rendering.
      const visibleById = new Map<string, HitRect>();
      const pushRect = (r: HitRect): void => {
        hitRects.push(r);
        visibleById.set(r.id, r);
      };

      // When a node is selected the camera eases to keep it screen-centered
      // (tracking it through any expand re-layout), until it's centered or
      // the user takes manual camera control. null = not following.
      let followId: string | null = null;

      // Directional `${fromFileId} ${toFileId}` keys for semantic edges
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

      // Exact-fit sizing is a few treemap passes — memoize per (file, AST)
      // so expand/collapse toggles don't recompute. Keyed on the AST object
      // identity so a file-watcher AST update invalidates it.
      const expandedSizeCache = new Map<
        string,
        { ast: FileAstResponse; size: { w: number; h: number } }
      >();

      function expandedSizeFor(fileId: string): { w: number; h: number } | null {
        const ast = useGraphStore.getState().asts.get(fileId);
        if (!ast) return null; // AST still loading — fall back to collapsed
        const cached = expandedSizeCache.get(fileId);
        if (cached && cached.ast === ast) return cached.size;
        const interior = fitInterior(ast, {
          labelOf: labelFor,
          significant: isSignificant,
          pruneEmpty: (n) => n.syntaxKind === 'Block', // drop empty `{}`
          // Exactly the box the renderer's LOD gate checks below, so a cell
          // sized here shows its label at 1:1 and nothing larger.
          measure: labelScreenBox,
          min: EXPANDED_MIN,
          max: EXPANDED_MAX,
        });
        // Widen if needed so the file's own basename strip still fits, and
        // add the title strip the AST is laid out beneath.
        const sim = layout.byId.get(fileId);
        const size = {
          w: Math.max(interior.w, sim?.collapsedW ?? 0),
          h: interior.h + TITLE_STRIP,
        };
        expandedSizeCache.set(fileId, { ast, size });
        return size;
      }

      function applyExpansionToSim() {
        applyExpansion(
          layout,
          useGraphStore.getState().expandedFiles,
          expandedSizeFor,
        );
      }

      function buildSubtreeLayout(fileId: string): void {
        const ast = useGraphStore.getState().asts.get(fileId);
        if (!ast) return;
        // Content-sized: the layout sizes itself to its text, so we only pass
        // the origin (below the title strip, so the AST clears the filename).
        subtreeByFileId.set(
          fileId,
          layoutAst(ast, {
            originX: 0,
            originY: TITLE_STRIP,
            labelOf: labelFor,
            significant: isSignificant,
            pruneEmpty: (n) => n.syntaxKind === 'Block', // drop empty `{}`
            measure: labelScreenBox,
          }),
        );
      }

      function dropSubtreeLayout(fileId: string): void {
        subtreeByFileId.delete(fileId);
      }

      // ----- per-frame draw -----

      function draw(): void {
        const state = useGraphStore.getState();
        const selection = state.selection;

        worldGfx.clear();
        semanticEdgeGfx.clear();
        hitRects.length = 0;
        visibleById.clear();
        labelPool.beginFrame();

        // 1. Import edges (under rects — they connect file centers and look
        //    cleanest terminating at the rect borders).
        drawEdges(layout, worldGfx, cameraScale, visibleSemanticPairs);

        // 2. Files + AST subtrees on `worldGfx`. pushRect keeps visibleById
        //    in sync so the edge pass below can find precise anchors.
        for (const sim of layout.nodes) {
          drawFile(sim, selection);
        }

        // 3. Labels (above rects).
        labelPool.endFrame();

        // 4. Semantic edges, drawn last on a dedicated graphics layered above
        //    labels. Border-clipped + arrowheaded so they're always visible.
        drawSemanticEdges(
          project.semanticEdges,
          semanticEdgeGfx,
          visibleById,
          subtreeByFileId,
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

        const fill = isSelected ? COLORS.fileSelected : COLORS.fileExpanded;
        const stroke = isSelected ? COLORS.fileBorderSelected : COLORS.fileBorder;
        worldGfx
          .roundRect(x, y, sim.width, sim.height, 6)
          .fill({ color: fill })
          .stroke({ color: stroke, width: isSelected ? 2 : 1 });

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
          let tree = subtreeByFileId.get(sim.id);
          if (!tree) {
            buildSubtreeLayout(sim.id);
            tree = subtreeByFileId.get(sim.id);
          }
          if (tree) drawSubtree(tree, x, y, sim.id, selection);
        }
      }

      function drawSubtree(
        tree: TreemapLayout,
        baseX: number,
        baseY: number,
        fileId: string,
        selection: string | null,
      ): void {
        const rootChildren = tree.childrenByParent.get(tree.rootId);
        if (!rootChildren) return;
        for (const child of rootChildren) {
          drawAstNode(child, baseX, baseY, fileId, tree, selection);
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

        // Zoomed-out "simplified" tier: drop operators and generic kind
        // labels — keep only real names.
        const simplified = cameraScale < SIMPLIFY_BELOW;

        const isSelected = selection === node.id;
        const tint = depthTint(node.depth);
        const fillColor = isSelected ? COLORS.astSelected : tint;
        // Kind outlines have their own (much lower) zoom threshold so they
        // reappear well before the rest of the detail does.
        const kindOutline =
          cameraScale < OUTLINE_BELOW
            ? undefined
            : KIND_OUTLINE[node.syntaxKind];
        let borderColor: number = COLORS.astBorder;
        let borderWidth = 0.5;
        let borderAlpha = 0.9;
        if (isSelected) {
          borderColor = COLORS.astSelectedBorder;
          borderWidth = 1.5;
          borderAlpha = 1;
        } else if (kindOutline !== undefined) {
          // Selection still overrides the kind color so the active node
          // reads unambiguously. Counter-scale the width by 1/cameraScale so
          // the block/object outline stays a constant ~1px on screen and
          // doesn't thicken as you zoom in.
          borderColor = kindOutline;
          borderWidth = 1 / cameraScale;
          borderAlpha = 1;
        }
        // Parameters get just-slightly-rounded corners as a subtle nod to
        // the round brackets a parameter list lives in — small enough that
        // the label stays well inside the border.
        if (node.syntaxKind === 'Parameter') {
          const radius = Math.min(
            4 / cameraScale, // ~4px on screen — a gentle curve, not a pill
            Math.min(node.rect.w, node.rect.h) / 2,
          );
          worldGfx
            .roundRect(x, y, node.rect.w, node.rect.h, radius)
            .fill({ color: fillColor, alpha: isSelected ? 1 : 0.92 })
            .stroke({ color: borderColor, width: borderWidth, alpha: borderAlpha });
        } else {
          worldGfx
            .rect(x, y, node.rect.w, node.rect.h)
            .fill({ color: fillColor, alpha: isSelected ? 1 : 0.92 })
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

        // Constructor badge: a small outlined wrench in the top-right corner
        // so a constructor is recognizable even though it has no name label.
        // Same cheap-structural-cue zoom gate as the kind outlines.
        if (node.syntaxKind === 'Constructor' && cameraScale >= OUTLINE_BELOW) {
          const s = 11 / cameraScale; // glyph footprint, screen-constant
          const gap = 4 / cameraScale; // clearance between badge and box
          // Float it just ABOVE the box's top-left, outside the interior,
          // so it never overlaps the constructor's child nodes.
          const gx = x; // left-aligned to the box edge
          const gy = y - gap - s; // entirely above the box top
          const lw = 1.2 / cameraScale; // outline stroke, ~constant on screen
          const col = SYNTAX.func; // ties to "this is a (constructor) function"
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
        const labelText = labelFor(node);
        const labelBox = labelText ? labelScreenBox(labelText) : null;
        // In the simplified tier only real names survive — generic kind
        // labels (type / if / arrow fn / call / access …) drop out.
        const nameOk = !simplified || node.name != null;
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
            const hasKids = !!tree.childrenByParent.get(node.id)?.length;
            if (hasKids) {
              // Container: the label titles the children, so it sits at the
              // top-left. Margins are screen px → /cameraScale to world.
              labelPool.put({
                text: labelText,
                worldX: x + 4 / cameraScale,
                worldY: y + 3 / cameraScale,
                color: syntaxColor(node),
                size: 11,
                anchorX: 0,
                anchorY: 0,
                scale: 1 / cameraScale,
              });
            } else {
              // Leaf / value (an operand like `20`, `i`, `j`): center it in
              // its box, symmetric with the left chip and the operator glyph.
              labelPool.put({
                text: labelText,
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
      }

      // Ease the camera so the followed node sits at screen center. Runs
      // after draw() so visibleById reflects this frame. Re-reads the node's
      // live position each tick, so it tracks the node through an expand
      // re-layout and releases once centered.
      function updateFollow(): void {
        if (followId === null) return;
        let cx: number;
        let cy: number;
        const simNode = layout.byId.get(followId);
        if (simNode) {
          cx = simNode.x;
          cy = simNode.y;
        } else {
          const r =
            visibleById.get(followId) ??
            findVisibleAnchor(followId, visibleById, subtreeByFileId);
          if (!r) return; // not resolvable yet — try again next frame
          cx = r.x + r.w / 2;
          cy = r.y + r.h / 2;
        }
        const targetX = app.screen.width / 2 - cx * cameraScale;
        const targetY = app.screen.height / 2 - cy * cameraScale;
        world.x += (targetX - world.x) * 0.18;
        world.y += (targetY - world.y) * 0.18;
        if (
          Math.abs(targetX - world.x) < 0.5 &&
          Math.abs(targetY - world.y) < 0.5
        ) {
          world.x = targetX;
          world.y = targetY;
          followId = null; // centered & settled — release the camera
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

      const detachCamera = wireCamera({
        app,
        world,
        container,
        getCameraScale: () => cameraScale,
        setCameraScale: (s: number) => {
          cameraScale = s;
        },
        hitTest: (worldX: number, worldY: number) => smallestContaining(hitRects, worldX, worldY),
        onClick: handleClick,
        onUserCameraMove: () => {
          followId = null;
        },
      });

      function handleClick(target: HitRect | null) {
        if (!target) {
          useGraphStore.getState().setSelection(null);
          followId = null;
          return;
        }
        // Center the selected node on screen (the ticker eases toward it).
        followId = target.id;
        if (target.kind === 'file') {
          void onFileClick(target.fileId);
        } else {
          useGraphStore.getState().setSelection(target.id);
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
  gfx: Graphics,
  cameraScale: number,
  visibleSemanticPairs: ReadonlySet<string>,
): void {
  // Import links: a quiet subdued background layer. Suppressed when a
  // calls/extends/implements link is already visible between the same two
  // files — that semantic relationship makes the import implicit.
  for (const link of layout.links) {
    const s = typeof link.source === 'string' ? layout.byId.get(link.source) : link.source;
    const t = typeof link.target === 'string' ? layout.byId.get(link.target) : link.target;
    if (!s || !t) continue;
    if (visibleSemanticPairs.has(`${s.id} ${t.id}`)) continue;
    gfx
      .moveTo(s.x, s.y)
      .lineTo(t.x, t.y)
      .stroke({
        color: COLORS.edge,
        width: 1.5 / cameraScale, // ~1.5px on screen, zoom-stable
        alpha: 0.7,
      });
  }
}

// Control points for the connector curve drawn between the caller's
// bottom-right OUTPUT port and the callee's left-edge INPUT port:
//  (a) bow into open space — don't slice through either rect body;
//  (b) arrive at the callee port HORIZONTALLY so the arrowhead reads as
//      entering the left edge — `cp2.y === callee.y` is the invariant the
//      downstream tangent math depends on;
//  (c) stay sane across the ~38px (collapsed file) .. ~380px (expanded)
//      rect-size range and any relative placement of the two ports.
function semanticBezierControls(
  caller: { x: number; y: number },
  callee: { x: number; y: number },
): { cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  const dx = callee.x - caller.x;
  const dy = callee.y - caller.y;
  // How far the callee sits *behind* the caller (to its left). The curve has
  // to double back here, which is exactly when it cusps — feed that back-
  // travel into the handle length so the loop rounds out instead of kinking.
  const back = Math.max(0, -dx);
  // Horizontal reach: proportional to span + back-travel, with a generous
  // floor (short edges still bow smoothly) and a high cap.
  const h = clamp(0.5 * Math.abs(dx) + 0.7 * back + 40, 64, 320);
  // Vertical bias: walk the curve down out of the bottom-right corner first
  // so it clears the source rect's body before arcing toward the callee.
  const v = clamp(0.35 * Math.abs(dy) + 20, 28, 150);
  return {
    cp1: { x: caller.x + h, y: caller.y + v },
    cp2: { x: callee.x - h, y: callee.y },
  };
}

// Control points for the inheritance connector: BOTTOM of the superclass
// (`start`, the thing being extended) → TOP of the subclass (`end`, the thing
// that extends it). The axis-swapped mirror of semanticBezierControls:
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
  subtreeByFileId: Map<string, TreemapLayout>,
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
    const from = findVisibleAnchor(edge.fromId, visibleById, subtreeByFileId);
    const to = findVisibleAnchor(edge.toId, visibleById, subtreeByFileId);
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
    let startPort: { x: number; y: number };
    let endPort: { x: number; y: number };
    let cp1: { x: number; y: number };
    let cp2: { x: number; y: number };
    if (edge.kind === 'extends') {
      startPort = { x: to.x + to.w / 2, y: to.y + to.h }; // bottom of superclass
      endPort = { x: from.x + from.w / 2, y: from.y };    // top of subclass
      ({ cp1, cp2 } = inheritanceBezierControls(startPort, endPort));
    } else {
      startPort = { x: from.x + from.w, y: from.y + from.h }; // bottom-right of caller
      endPort = { x: to.x, y: to.y };                         // top-left of callee
      ({ cp1, cp2 } = semanticBezierControls(startPort, endPort));
    }

    if (dashed) {
      emitDashed(
        gfx,
        cubicPath(startPort, cp1, cp2, endPort, 48),
        3.5 * invScale, // fine dash, screen-constant
        2.5 * invScale,
      );
      gfx.stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
    } else {
      gfx
        .moveTo(startPort.x, startPort.y)
        .bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endPort.x, endPort.y)
        .stroke({ color: style.color, width: style.width * invScale, alpha: edgeAlpha });
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
    // direction at the target port is (endPort - cp2).
    drawArrowhead(
      gfx,
      endPort.x,
      endPort.y,
      Math.atan2(endPort.y - cp2.y, endPort.x - cp2.x),
      style.arrowSize * invScale,
      style.color,
      edgeAlpha,
    );
  }
}

function findVisibleAnchor(
  id: string,
  visibleById: Map<string, HitRect>,
  subtreeByFileId: Map<string, TreemapLayout>,
): HitRect | null {
  const direct = visibleById.get(id);
  if (direct) return direct;
  const hashIdx = id.lastIndexOf('#');
  if (hashIdx <= 0) {
    // The id is a fileId already (no # suffix).
    return visibleById.get(id) ?? null;
  }
  const fileId = id.slice(0, hashIdx);
  const tree = subtreeByFileId.get(fileId);
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
  // Called when the user takes manual camera control (drag-pan or zoom) so an
  // in-progress auto-pan/follow can bow out.
  onUserCameraMove: () => void;
}

function wireCamera(deps: CameraDeps): () => void {
  const { app, world, container, setCameraScale, hitTest, onClick } = deps;
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

  const onMove = (e: FederatedPointerEvent) => {
    if (!dragging) return;
    const dx = e.global.x - pointerStart.x;
    const dy = e.global.y - pointerStart.y;
    movedDistance = Math.max(movedDistance, Math.hypot(dx, dy));
    if (movedDistance > DRAG_DEADZONE) {
      pendingTarget = null;
      onUserCameraMove();
      world.x = worldStart.x + dx;
      world.y = worldStart.y + dy;
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
