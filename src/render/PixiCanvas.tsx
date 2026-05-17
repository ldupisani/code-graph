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
  type FileLayoutResult,
} from '../graph/layout';
import { useGraphStore } from '../graph/store';
import { layoutAst, type Rect, type TreemapLayout, type TreemapNode } from '../graph/treemap';
import type { ProjectResponse, SemanticEdge, SemanticEdgeKind } from '../api/types';
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
  text: 0xeeeeee,
  textDim: 0xb0b0b8,
  edge: 0x666670,
  edgeFaded: 0x2c2c30,
  edgeHighlight: 0x6db1ff,
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
// Labels only appear when a rect is at least this many screen pixels in each
// dimension. Tuned so a 4-letter kind label like "if" or "return" is legible.
const LABEL_MIN_W_PX = 40;
const LABEL_MIN_H_PX = 14;

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
  Block: 'block',
  VariableStatement: 'var',
  ExpressionStatement: 'expr',
  // Expressions
  CallExpression: 'call',
  NewExpression: 'new',
  PropertyAccessExpression: 'access',
  ElementAccessExpression: 'index',
  BinaryExpression: 'binary',
  PrefixUnaryExpression: 'unary',
  PostfixUnaryExpression: 'unary',
  ConditionalExpression: 'ternary',
  ArrowFunction: 'arrow fn',
  FunctionExpression: 'fn',
  AwaitExpression: 'await',
  YieldExpression: 'yield',
  SpreadElement: 'spread',
  TemplateExpression: 'template',
  ObjectLiteralExpression: 'object',
  ArrayLiteralExpression: 'array',
  ParenthesizedExpression: '(...)',
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

function labelFor(node: { name: string | null; syntaxKind: string }): string | null {
  if (node.name) return node.name;
  const explicit = SYNTAX_KIND_LABELS[node.syntaxKind];
  if (explicit) return explicit;
  // Fallback: trim suffix, lowercase first letter (e.g. "TaggedTemplateExpression" -> "taggedTemplate").
  const trimmed = node.syntaxKind
    .replace(/Declaration$/, '')
    .replace(/Statement$/, '')
    .replace(/Expression$/, '')
    .replace(/Clause$/, '');
  if (!trimmed) return null;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
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

      // Vertical band reserved at the top of an expanded file for its name.
      const TITLE_STRIP = 24;

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

      // Pool of Pixi Text objects re-used across frames. `visible` is toggled
      // for unused entries, avoiding GC churn.
      const labelPool = new LabelPool(labelLayer);

      // Camera (mirrors world.scale.x; held in a ref so handlers can read
      // and write without a closure stale-read.)
      let cameraScale = world.scale.x;

      // ----- expansion handling -----

      function applyExpansionToSim() {
        applyExpansion(layout, useGraphStore.getState().expandedFiles);
      }

      function buildSubtreeLayout(fileId: string): void {
        const ast = useGraphStore.getState().asts.get(fileId);
        if (!ast) return;
        const sim = layout.byId.get(fileId);
        if (!sim) return;
        // Lay out into the file's interior below the title strip so the AST
        // doesn't overlap the file's name.
        const rect: Rect = {
          x: 0,
          y: TITLE_STRIP,
          w: sim.width,
          h: Math.max(0, sim.height - TITLE_STRIP),
        };
        subtreeByFileId.set(fileId, layoutAst(ast, rect));
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
        drawEdges(layout, worldGfx, selection);

        // 2. Files + AST subtrees on `worldGfx`. pushRect keeps visibleById
        //    in sync so the edge pass below can find precise anchors.
        for (const sim of layout.nodes) {
          drawFile(sim, selection);
        }

        // 3. Labels (above rects).
        labelPool.endFrame();

        // 4. Semantic edges, drawn last on a dedicated graphics layered above
        //    labels. Border-clipped + arrowheaded so they're always visible.
        drawSemanticEdges(project.semanticEdges, semanticEdgeGfx, visibleById, subtreeByFileId);
      }

      function drawFile(sim: SimFileNode, selection: string | null): void {
        const x = sim.x - sim.width / 2;
        const y = sim.y - sim.height / 2;
        const expanded = useGraphStore.getState().expandedFiles.has(sim.id);
        const isSelected = selection === sim.id;

        const fill = isSelected
          ? COLORS.fileSelected
          : expanded
          ? COLORS.fileExpanded
          : COLORS.file;
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

        // File label — always drawn for file rects. Counter-scale so the
        // text stays constant on screen even as the user zooms.
        const labelScale = 1 / cameraScale;
        labelPool.put({
          text: shortenPath(sim.relativePath),
          worldX: sim.x,
          // Centre vertically in the title strip when expanded; centre on
          // the rect when collapsed. Both positions are world coords so the
          // label tracks the rect under zoom.
          worldY: expanded ? y + TITLE_STRIP / 2 : sim.y,
          color: COLORS.text,
          size: 12,
          anchorY: 0.5,
          scale: labelScale,
        });

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

        const isSelected = selection === node.id;
        const tint = depthTint(node.depth);
        const fillColor = isSelected ? COLORS.astSelected : tint;
        const borderColor = isSelected ? COLORS.astSelectedBorder : COLORS.astBorder;
        worldGfx
          .rect(x, y, node.rect.w, node.rect.h)
          .fill({ color: fillColor, alpha: isSelected ? 1 : 0.92 })
          .stroke({ color: borderColor, width: isSelected ? 1.5 : 0.5, alpha: 0.9 });

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

        // Label every node that has room for one. Use the resolved name when
        // present (declarations, literals, import specifiers); otherwise fall
        // back to a friendly kind label like "return" or "if" so unnamed
        // statements/expressions are still identifiable. Suppress when the
        // parent's label is identical, to avoid stacking in cases like an
        // ImportSpecifier whose Identifier child shares the same text.
        const labelText = labelFor(node);
        if (
          labelText &&
          wOnScreen >= LABEL_MIN_W_PX &&
          hOnScreen >= LABEL_MIN_H_PX
        ) {
          const parent = node.parentId ? tree.byId.get(node.parentId) : null;
          const parentLabel = parent ? labelFor(parent) : null;
          if (parentLabel !== labelText) {
            // Margins are in screen pixels: divide by cameraScale to convert
            // to world units so the label sits the same distance from the
            // rect's corner regardless of zoom level.
            const marginX = 4 / cameraScale;
            const marginY = 3 / cameraScale;
            labelPool.put({
              text: labelText,
              worldX: x + marginX,
              worldY: y + marginY,
              color: COLORS.textDim,
              size: 11,
              anchorX: 0,
              anchorY: 0,
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

      const tickerCb = () => draw();
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
      });

      function handleClick(target: HitRect | null) {
        if (!target) {
          useGraphStore.getState().setSelection(null);
          return;
        }
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

function drawEdges(layout: FileLayoutResult, gfx: Graphics, selection: string | null): void {
  // Edges connect files; only file selections influence the highlight/fade
  // pattern. Selecting an AST node leaves all edges in their default style.
  const selectedFileId = selection !== null && layout.byId.has(selection) ? selection : null;
  for (const link of layout.links) {
    const s = typeof link.source === 'string' ? layout.byId.get(link.source) : link.source;
    const t = typeof link.target === 'string' ? layout.byId.get(link.target) : link.target;
    if (!s || !t) continue;
    const adjacent = selectedFileId !== null && (s.id === selectedFileId || t.id === selectedFileId);
    const faded = selectedFileId !== null && !adjacent;
    const color = adjacent ? COLORS.edgeHighlight : faded ? COLORS.edgeFaded : COLORS.edge;
    gfx
      .moveTo(s.x, s.y)
      .lineTo(t.x, t.y)
      .stroke({ color, width: adjacent ? 2 : 1, alpha: faded ? 0.35 : 0.95 });
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
  // Horizontal reach: proportional to span, floored so tiny/adjacent rects
  // still get a visible bow, capped so huge spans don't overshoot.
  const h = clamp(0.4 * Math.abs(dx) + 24, 40, 240);
  // Vertical bias: walk the curve down out of the bottom-right corner first
  // so it clears the source rect's body before arcing toward the callee.
  const v = clamp(0.25 * Math.abs(dy) + 16, 24, 120);
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
  const reach = clamp(0.4 * Math.abs(dy) + 24, 40, 240);
  const bias = clamp(0.25 * Math.abs(dx) + 16, 24, 120) * Math.sign(dx || 1);
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
): void {
  // Many AST-level edges may lift to the same pair of visible anchors —
  // dedupe per (kind, fromAnchor.id, toAnchor.id) so we draw one thick edge
  // instead of N stacked translucent ones.
  const seen = new Set<string>();
  // Many edges can share one resolved port (N callers → one callee). Filled
  // circles with alpha < 1 would additively darken into a blob, so dedupe the
  // markers independently of the edge dedupe above.
  const drawnPorts = new Set<string>();
  for (const edge of edges) {
    const from = findVisibleAnchor(edge.fromId, visibleById, subtreeByFileId);
    const to = findVisibleAnchor(edge.toId, visibleById, subtreeByFileId);
    if (!from || !to || from.id === to.id) continue;
    const key = `${edge.kind}|${from.id}|${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Each kind has its own port geometry. `calls`/`implements` read as
    // dataflow: out of the caller's bottom-right, into the callee's left edge
    // (clear of the top-left label). `extends` reads as a class hierarchy:
    // out of the BOTTOM of the thing being extended (the superclass, `to`),
    // into the TOP of the thing that extends it (the subclass, `from`). A
    // cubic bezier joins the two ports so the line bows into open space, and
    // the arrowhead is oriented along the curve's end tangent.
    const style = SEMANTIC_EDGE_STYLE[edge.kind];
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
      endPort = { x: to.x, y: to.y + to.h / 2 };              // left-mid of callee
      ({ cp1, cp2 } = semanticBezierControls(startPort, endPort));
    }

    gfx
      .moveTo(startPort.x, startPort.y)
      .bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endPort.x, endPort.y)
      .stroke({ color: style.color, width: style.width, alpha: style.alpha });

    // World-space radius (this layer is not counter-scaled, unlike labels) so
    // the port scales with the line/arrowhead through zoom and LOD lifting.
    const portR = style.arrowSize * 0.35;
    for (const p of [startPort, endPort]) {
      const portKey = `${edge.kind}|${Math.round(p.x)},${Math.round(p.y)}`;
      if (drawnPorts.has(portKey)) continue;
      drawnPorts.add(portKey);
      gfx.circle(p.x, p.y, portR).fill({ color: style.color, alpha: style.alpha });
    }

    // A cubic's end derivative is proportional to (P3 - P2), so the incoming
    // direction at the target port is (endPort - cp2).
    drawArrowhead(
      gfx,
      endPort.x,
      endPort.y,
      Math.atan2(endPort.y - cp2.y, endPort.x - cp2.x),
      style.arrowSize,
      style.color,
      style.alpha,
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

function shortenPath(p: string, max = 32): string {
  return p.length <= max ? p : '…' + p.slice(-(max - 1));
}

interface CameraDeps {
  app: Application;
  world: Container;
  container: HTMLDivElement;
  getCameraScale: () => number;
  setCameraScale: (s: number) => void;
  hitTest: (wx: number, wy: number) => HitRect | null;
  onClick: (target: HitRect | null) => void;
}

function wireCamera(deps: CameraDeps): () => void {
  const { app, world, container, setCameraScale, hitTest, onClick } = deps;
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
