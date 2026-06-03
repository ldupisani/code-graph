import {useEffect, useRef} from "react";
import {Application, Container, Graphics} from "pixi.js";
import {getFileAst} from "../api/client";
import {applyExpansion, assignRigidPositions, buildFileLayout, EXPANDED_MAX, EXPANDED_MIN, isCircular, refreshSizeForces} from "../graph/layout";
import {AST_LABEL_FONT, astLabelOnScreenFactor, astLabelScale, fileLabel, labelScreenBox, measureMono} from "../graph/labels";
import {isSupportFile, useGraphStore} from "../graph/store";
import {useConfigStore} from "../graph/config/store";
import type {GraphConfig} from "../graph/config/types";
import {activeTiers, createTierEngine} from "./tierLayout";
import {getPattern} from "../graph/patterns/registry";
import {layoutAst, type TreemapLayout, type TreemapNode} from "../graph/treemap";
import {buildAstForceLayout, type AstForceLayout, type ContainerForceLayout} from "../graph/astForce";
import type {FileAstResponse, ProjectResponse} from "../api/types";
import type {SimFileNode} from "../graph/types";
import {blendColor, DEFAULT_FILL_ALPHA, depthTint, EXPORT_FILL_ALPHA, EXPORT_FILL_BLEND, EXPORT_FILL_COLOR, hslToHex, liveTheme} from "./theme";
import {composeModifierPrefix, isBracketKind, isBraceLabelKind, isExpandableKind, isFunctionSignatureKind, isHighLevel, isSignificant, KIND_FILL_TINT, KIND_OUTLINE, labelFor, NAME_LIKE_KINDS, splitCallMarker, splitDeclarationKeyword, splitTypeAnnotation, SYNTAX, syntaxColor, syntaxTokens} from "./astStyle";
import {findVisibleAnchor, smallestContaining, type HitRect} from "./hitTest";
import {drawEdges, drawSemanticEdges, emitDashed} from "./edges";
import {wireCamera} from "./cameraInput";
import {LabelPool} from "./labelPool";

// Camera state persisted across PixiCanvas rebuilds (e.g. when a filesystem
// refresh swaps the project payload). Keyed by rootPath so opening a *different*
// project starts at the default centered view.
let savedCamera: {rootPath: string; x: number; y: number; scale: number} | null = null;

// Imperative canvas controls exposed to the React HUD (zoom + pin buttons), so
// device-independent actions exist alongside the wheel / keyboard.
export interface CameraApi {
    zoomBy: (factor: number) => void; // factor < 1 zooms out, > 1 zooms in
    fitView: () => void; // re-frame the overview layout
    pinAll: () => void; // pin every file box at its current position
    pinVisible: () => void; // pin only the files currently on screen
    unpinAll: () => void; // release every user pin
}

interface CanvasProps {
    project: ProjectResponse;
    cameraApiRef?: {current: CameraApi | null};
}

// Force-graph tunables live as module-level `const`s in astForce.ts and
// layout.ts. React Fast Refresh re-evaluates those modules on save but the
// effect below only re-runs when `project` changes — so the *running*
// simulation and the AST layout cache keep referencing the old constants.
// Accepting the hot-update here and forcing a full reload restores the
// "edit constant → see it" iteration loop.
if (import.meta.hot) {
    import.meta.hot.accept(["../graph/astForce", "../graph/layout"], () => {
        location.reload();
    });
}

export function PixiCanvas({project, cameraApiRef}: CanvasProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    // Live config bridge: mirror useConfigStore.config into a ref the render
    // loop reads each frame. The canvas effect only re-runs on `project`
    // change, so config edits reach the running renderer through this ref
    // without tearing down / recreating the Pixi app.
    const configRef = useRef<GraphConfig>(useConfigStore.getState().config);
    useEffect(() => {
        configRef.current = useConfigStore.getState().config;
        return useConfigStore.subscribe((s) => {
            configRef.current = s.config;
        });
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let disposed = false;
        let cleanup: (() => void) | null = null;

        void (async () => {
            const app = new Application();
            await app.init({
                background: liveTheme.colors.bg,
                resizeTo: container,
                antialias: true,
                autoDensity: true,
                resolution: window.devicePixelRatio || 1,
            });
            if (disposed) {
                app.destroy(true, {children: true});
                return;
            }
            container.appendChild(app.canvas);
            app.canvas.style.display = "block";
            app.canvas.style.touchAction = "none";

            // cameraScale mirrors world.scale.x; stepLayout reads it each
            // frame to decide the rigid-layout blend (see rigidness()).
            const world = new Container();
            app.stage.addChild(world);
            let cameraScale = world.scale.x;
            // The zoom the auto-fit chose at project open. The rigid ↔
            // connectivity transition band is positioned relative to this
            // (see rigidness) so the transition is always reachable by a
            // moderate zoom-in whatever the project's size.
            let fitScale = 1;

            // Current config snapshot for this frame. Refreshed at the top of
            // the ticker; nested draw/predicate helpers read `cfg.lod.*` /
            // `cfg.behavioral.*` and so pick up live edits (closures resolve
            // this free variable at call time).
            let cfg = configRef.current;

            const layout = buildFileLayout(project);
            // Drives the configured tiers: keeps layout.rigidRaw in sync with
            // the static (overview) tier's pattern, and derives the rigid-blend
            // weight from the tier zoom ranges (replaces the old rigidness()).
            const tierEngine = createTierEngine(project, layout);
            if (import.meta.env.DEV && typeof window !== "undefined") {
                (window as unknown as {__codegraph: unknown}).__codegraph = {
                    layout,
                    world,
                    getFileSize: (id: string) => {
                        const n = layout.byId.get(id);
                        return n ? {w: n.width, h: n.height, x: n.x, y: n.y} : null;
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
                        const fileId = astNodeId.includes("#") ? astNodeId.slice(0, astNodeId.lastIndexOf("#")) : astNodeId;
                        const tree = activeTree(fileId);
                        const tn = tree?.byId.get(astNodeId);
                        if (!tn) return false;
                        handleClick({
                            id: astNodeId,
                            fileId,
                            kind: "ast",
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
            // Warm the sim up synchronously so the connectivity layout is
            // representative — initial node positions are seeded on a tiny
            // ring (see buildFileLayout), so without settling the layout
            // would be coin-sized. 50 ticks puts alpha at
            // (1 - 0.035) ^ 50 ≈ 0.17 — past the major rearrangement.
            // Then snapshot the connectivity positions and anchor the
            // rigid folder layout on the connectivity centroid, so the
            // two layouts overlap and the render-time interpolation
            // between them is a short travel rather than a fly-across.
            layout.simulation.tick(50);
            snapshotConn();
            // Apply the configured overview pattern to rigidRaw BEFORE the
            // initial anchor + fit, so a persisted non-default pattern (e.g. a
            // saved hub-and-spoke template) is framed correctly on open rather
            // than only after the first frame.
            tierEngine.sync(configRef.current);
            assignRigidPositions(layout, connCentre());

            // Always run the auto-fit: besides framing the project it
            // computes fitScale, which the rigidness transition band is
            // positioned relative to. When restoring a saved camera
            // (filesystem refresh) we then overwrite the camera transform
            // but keep the computed fitScale.
            fitProjectToViewport();
            if (savedCamera && savedCamera.rootPath === project.rootPath) {
                world.position.set(savedCamera.x, savedCamera.y);
                world.scale.set(savedCamera.scale);
            }
            // Sync the closure variable to world.scale.x AFTER auto-fit /
            // restore so the first frame's draw + the first rigidness()
            // evaluation reflect the actual on-screen zoom.
            cameraScale = world.scale.x;

            // Frame the project in the viewport with ~6% margin on each
            // side. Caps the zoom at 2 (don't zoom in on tiny projects)
            // and 0.05 (don't disappear pathological ones). Sets
            // cameraScale + world position directly — no animation, since
            // this is the initial framing.
            //
            // Frames the UNION of the connectivity layout and the rigid
            // folder layout: the user lands zoomed-out (rigid view) for a
            // big project, but the zoom may sit anywhere in the transition
            // band, so both layouts must be on screen whatever the blend.
            function fitProjectToViewport(): void {
                const nodes = layout.nodes;
                if (nodes.length === 0) {
                    world.position.set(app.screen.width / 2, app.screen.height / 2);
                    return;
                }
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                // Frame the OVERVIEW (coarsest, index-0) tier — what's shown when
                // fully zoomed out. If it's a live tier, that's the connectivity
                // (connX) layout; otherwise the static buffer (rigidX = the
                // coarsest static tier's centred positions). Framing only the
                // overview keeps the fit matched to what's actually on screen at
                // open — earlier this framed the force sim's (often huge,
                // undisplayed) extent too, which skewed fitScale and pushed the
                // open zoom past the overview tier's range.
                const tiers = configRef.current.tiers;
                const overviewLive = tiers.length > 0 && getPattern(tiers[0].patternId).kind === "live";
                for (const n of nodes) {
                    const halfW = n.width / 2;
                    const halfH = n.height / 2;
                    const px = overviewLive ? n.connX : n.rigidX;
                    const py = overviewLive ? n.connY : n.rigidY;
                    if (px - halfW < minX) minX = px - halfW;
                    if (py - halfH < minY) minY = py - halfH;
                    if (px + halfW > maxX) maxX = px + halfW;
                    if (py + halfH > maxY) maxY = py + halfH;
                }
                const bboxW = maxX - minX;
                const bboxH = maxY - minY;
                const cx = (minX + maxX) / 2;
                const cy = (minY + maxY) / 2;
                const MARGIN = 0.88;
                const fitW = (app.screen.width * MARGIN) / Math.max(1, bboxW);
                const fitH = (app.screen.height * MARGIN) / Math.max(1, bboxH);
                const scale = Math.max(0.05, Math.min(2, Math.min(fitW, fitH)));
                // Record for the rigidness transition band (see rigidness).
                fitScale = scale;
                world.scale.set(scale);
                world.x = app.screen.width / 2 - cx * scale;
                world.y = app.screen.height / 2 - cy * scale;
                // cameraScale picks the new world.scale.x up at the `let
                // cameraScale = world.scale.x` initialiser further down in
                // this same IIFE — runs strictly after this function does.
            }

            // Scene graph layering, bottom-up (Pixi child order = z-order):
            //   worldGfx          — main-scene rects (file circles, AST cells,
            //                       file outlines).
            //   labelLayer        — Pixi Text labels for the main scene.
            //   semanticEdgeGfx   — Semantic edges + arrowheads + selection-
            //                       gated caller/callee outlines. Above
            //                       main labels (so a thin connector isn't
            //                       hidden by a label sitting on its path),
            //                       BUT below the overlay panes — overlays
            //                       are panels on top of the main scene and
            //                       must obscure connector lines AND any
            //                       caller/callee outlines that fall within
            //                       their bounds. (drawSemanticEdges draws
            //                       a rect outline around the selected
            //                       caller/callee in the edge color; that
            //                       outline lives on this layer too.)
            //   overlayPane[0..N) — One *pane* per active expanded-Block overlay.
            //                       Each pane is a Container with TWO ordered
            //                       children: its own Graphics (rects) and its
            //                       own labels-Container (Pixi Text). Stacking
            //                       in world means pane[i+1] (a nested overlay
            //                       on top of pane[i]) fully obscures pane[i]'s
            //                       rects AND labels — which a single shared
            //                       overlayGfx/overlayLabelLayer could not, since
            //                       a parent overlay's labels would otherwise
            //                       always render above the child overlay's rect.
            //                       Unused panes are kept around with .visible
            //                       = false so we don't churn Containers per
            //                       frame.
            //
            // Hit-test priority is independent of Graphics z: a separate
            // `overlayHitRects` list is consulted before `hitRects` so an
            // overlay always wins clicks within its bounds.
            // Directory-boundary backdrop. Below worldGfx so it sits BEHIND
            // every file and edge — pure spatial grouping cue. Stroked + fill
            // are both translucent so the boundary doesn't compete with file
            // content for attention.
            const directoryGfx = new Graphics();
            world.addChild(directoryGfx);

            // Directory-name labels share the SPATIAL story of the
            // boundary hulls and therefore sit at the same z as them —
            // BEHIND worldGfx so expanded file blocks visually cover the
            // cluster label they happen to overlap. Without this, the
            // dim pink `[src/components/feedback]`-style cluster name
            // bleeds across the white contents of any open file in its
            // region (especially noticeable at low zoom where the hull
            // is large but the label is fixed-screen-size).
            const directoryLabelLayer = new Container();
            world.addChild(directoryLabelLayer);

            const worldGfx = new Graphics();
            world.addChild(worldGfx);

            const labelLayer = new Container();
            world.addChild(labelLayer);

            const semanticEdgeGfx = new Graphics();
            world.addChild(semanticEdgeGfx);

            // Bounded — same cap as the multi-pass loop's `safety` counter
            // below, so the pool can serve every overlay the loop is willing
            // to draw. Each pane is created up-front and toggled via
            // .visible per frame.
            const MAX_OVERLAY_PANES = 8;
            interface OverlayPane {
                container: Container;
                gfx: Graphics;
                labels: LabelPool;
            }
            const overlayPanes: OverlayPane[] = [];
            for (let i = 0; i < MAX_OVERLAY_PANES; i++) {
                const container = new Container();
                const gfx = new Graphics();
                const labelsContainer = new Container();
                container.addChild(gfx);
                container.addChild(labelsContainer);
                container.visible = false;
                world.addChild(container);
                overlayPanes.push({
                    container,
                    gfx,
                    labels: new LabelPool(labelsContainer),
                });
            }

            // Top-layer semantic edges, above ALL overlay panes. Used only
            // for connectors that touch an overlay (either endpoint resolves
            // to a rect that the overlay just rendered). Edges that don't
            // touch any overlay use the regular semanticEdgeGfx below the
            // panes — that's still the right z so overlays correctly
            // obscure pass-through connectors. Splitting the two cases
            // keeps both invariants: (1) a connector originating INSIDE
            // an overlay is visible end-to-end so the user can see where
            // it comes from, and (2) an unrelated connector passing
            // through an overlay's bounds is still obscured by it.
            const semanticEdgeOverlayGfx = new Graphics();
            world.addChild(semanticEdgeOverlayGfx);

            // Visual rim between the cluster's bounding-circle radius and the file
            // boundary actually drawn. Pure breathing room — the file's name is
            // drawn outside (above) the boundary, not inside it.
            const FILE_RIM = 10;
            // The arrow-function `⇒` glyph is visually smaller than the ƒ / ▷
            // markers at the standard 11px, so it's drawn a touch larger to match.
            const ARROW_GLYPH_SIZE = 14;
            // Vertical gap between statement rows inside an expanded code Block —
            // wider than the usual sibling gap so a row-separator line (drawn in
            // drawOverlay) sits between rows with breathing room, cueing the
            // left→right, line-by-line reading order. The block also reserves a
            // matching margin below its last row (see the bottomExtra in
            // treemap's packer) so the bottom stays balanced with these gaps.
            const BLOCK_ROW_GAP = 24;
            // Extra horizontal inset on each side of a code block's statements,
            // beyond the normal padding, so they don't hug the box edges.
            const BLOCK_SIDE_PAD = 12;

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
                // 'folder' is the same story: a drag handle, not a
                // semantic anchor for edges or follow.
                if (r.kind !== "ast-toggle" && r.kind !== "folder") {
                    visibleById.set(r.id, r);
                }
            };

            // Track each Block cell's WORLD rect as it's rendered in the
            // main scene. Overlays read this to anchor their top-left to
            // the cell the user clicked.
            const blockCellsThisFrame = new Map<string, {x: number; y: number; w: number; h: number}>();

            // Per-expanded-block drag offset (world units) from its origin cell.
            // The user drags an overlay's close handle to reposition it; the
            // overlay renders at originCell + offset and a connector line is
            // drawn from the handle back to the origin. `overlayDragBase` holds
            // the offset captured at the start of the current drag so movement
            // accumulates from there. Cleared when a block collapses.
            const overlayDragOffsets = new Map<string, {x: number; y: number}>();
            let overlayDragBase = {x: 0, y: 0};

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
            let followAt: {x: number; y: number} | null = null;

            // Zoom-to-fit animation. Set by `fitFileInViewport` when a freshly
            // expanded file is larger than the viewport; cleared once the
            // scale has converged or the user moves the camera themselves.
            // The `pivot` is a fixed world point — usually the file's centre
            // — that we keep at the same SCREEN position throughout the zoom
            // (by compensating world.x/y per tick), so the file appears to
            // shrink in place rather than drift toward the world origin.
            // Centering itself is handled by the existing followId/followAt
            // logic, which runs each tick using the current cameraScale.
            let zoomFit: {
                targetScale: number;
                pivot: {x: number; y: number};
            } | null = null;

            // Directional `${fromFileId} ${toFileId}` keys for semantic edges
            // (calls/extends/implements) actually drawn this frame. drawSemanticEdges
            // rebuilds it; drawEdges (which runs earlier in the frame) reads the
            // previous frame's set to suppress now-redundant import lines — a
            // 1-frame lag that's imperceptible at 60fps.
            const visibleSemanticPairs = new Set<string>();

            // Pool of Pixi Text objects re-used across frames for the main
            // scene. `visible` is toggled for unused entries, avoiding GC
            // churn. Each overlay pane has its OWN LabelPool — see the pane
            // pool above and the multi-pass loop in `draw()`.
            const labelPool = new LabelPool(labelLayer);
            // Separate pool for directory-cluster labels — its container
            // sits BEHIND worldGfx in the scene graph (see
            // `directoryLabelLayer` above), so any expanded file block
            // covers the cluster label it overlaps. Shares the same
            // beginFrame/endFrame lifecycle as the main pool.
            const directoryLabelPool = new LabelPool(directoryLabelLayer);
            // Per-directory eased label position. The raw label centre is
            // recomputed from the file-hull bbox each frame, so any
            // residual file movement (overlap-relaxation nudges, sim
            // ticks below the user's notice) showed up as visible label
            // jitter — labels are screen-locked text on quiet
            // backgrounds, so even sub-pixel motion reads. Easing the
            // rendered position toward the raw bbox centre with the
            // same 10%/frame low-pass we use for rigidCentre filters
            // out the high-frequency wobble while still letting the
            // label track real cluster movement.
            const directoryLabelCentres = new Map<string, {x: number; y: number}>();

            // Active per-pass targets for the SHARED drawing helpers
            // (drawAstNode, drawAstContainer, drawOverlay). The main scene
            // draws to `worldGfx` + `labelPool`; during the overlay pass
            // these are repointed to the active pane's `gfx`/`labels` so
            // every primitive the recursion emits lands in THAT pane (and
            // therefore at THAT z-order in `world`'s child list). Main-only
            // draw functions (drawFile, drawEdges, drawSemanticEdges) keep
            // using their absolute references.
            let currentGfx: Graphics = worldGfx;
            let currentLabelPool: LabelPool = labelPool;

            // (cameraScale moved earlier in the IIFE — it's now hoisted
            // before buildFileLayout so the zoom-modulated forces can
            // read it from their tick callbacks. See the original
            // declaration further up.)

            // ----- focus-mode adjacency + live set -----
            //
            // Per-kind file-to-file adjacency. Built once from project.edges
            // (imports) + project.semanticEdges (calls / extends / implements;
            // 'implements' folds into 'extends' to match the UI's pill
            // grouping). Both directions are stored so phase 6's reverse-call
            // query can pick the right one.
            //
            // Why file-level (not per-AST-node): the user's mental model of
            // "what relates to this" is dominated by file boundaries — they
            // click a thing IN a file and want to see other FILES it touches.
            // AST-level focus could come later if needed.
            type EdgeBucket = {
                out: Map<string, Set<string>>;
                in: Map<string, Set<string>>;
            };
            type AdjKind = "imports" | "calls" | "extends";
            const emptyBucket = (): EdgeBucket => ({out: new Map(), in: new Map()});
            const fileEdgesByKind: Record<AdjKind, EdgeBucket> = {
                imports: emptyBucket(),
                calls: emptyBucket(),
                extends: emptyBucket(),
            };
            // Set of file IDs matching the support-file pattern. Filled
            // once per project; consulted at render time when
            // `showSupportFiles` is off to skip drawing the file AND
            // every edge touching it.
            const supportFileIds = new Set<string>();
            // file id → its containing directory (parent path, '' for root
            // files). Used by the intra-directory edge LOD gate so we can
            // ask "are these two files siblings?" in O(1).
            const fileToDir = new Map<string, string>();
            // Active cluster grouping for the CURRENT frame — rebuilt at
            // the top of draw() using the zoom-adaptive cluster depth.
            // Used by:
            //   * drawDirectoryBoundaries (hull grouping),
            //   * drawEdges / drawSemanticEdges (intra-cluster edge gate),
            //   * drawFile (file-icon body color, so icons match their
            //     hull at the current zoom level).
            // Lifted to IIFE scope so drawFile — defined at IIFE scope,
            // not inside draw() — can read it without parameter threading.
            let fileToActiveCluster = new Map<string, string>();
            for (const f of project.files) {
                if (isSupportFile(f.relativePath)) supportFileIds.add(f.id);
                const i = f.relativePath.lastIndexOf("/");
                fileToDir.set(f.id, i < 0 ? "" : f.relativePath.slice(0, i));
            }
            const addAdjacency = (kind: AdjKind, from: string, to: string): void => {
                if (from === to) return;
                const b = fileEdgesByKind[kind];
                let outSet = b.out.get(from);
                if (!outSet) {
                    outSet = new Set();
                    b.out.set(from, outSet);
                }
                outSet.add(to);
                let inSet = b.in.get(to);
                if (!inSet) {
                    inSet = new Set();
                    b.in.set(to, inSet);
                }
                inSet.add(from);
            };
            for (const e of project.edges) {
                addAdjacency("imports", e.fromId, e.toId);
            }
            for (const e of project.semanticEdges) {
                const fromFile = fileIdOfAstId(e.fromId);
                const toFile = fileIdOfAstId(e.toId);
                const kind: AdjKind = e.kind === "extends" || e.kind === "implements" ? "extends" : "calls";
                addAdjacency(kind, fromFile, toFile);
            }

            // Popularity score per file: how many DISTINCT other files
            // reference it. Combines incoming imports + incoming semantic
            // edges (calls / extends / implements). A file imported by 50
            // others is a "hub" in the architecture and should look
            // proportionally bigger than a leaf utility imported once.
            // The raw score is normalised per-project into a [1, 10] icon
            // scale — see popFactor / minPopularity / maxPopularity below.
            const filePopularity = new Map<string, number>();
            {
                const seen = new Set<string>();
                const bumpInbound = (from: string, to: string): void => {
                    const key = `${from}|${to}`;
                    if (seen.has(key)) return;
                    seen.add(key);
                    filePopularity.set(to, (filePopularity.get(to) ?? 0) + 1);
                };
                for (const e of project.edges) bumpInbound(e.fromId, e.toId);
                for (const e of project.semanticEdges) {
                    bumpInbound(fileIdOfAstId(e.fromId), fileIdOfAstId(e.toId));
                }
            }
            // Project-wide popularity range. drawFile normalises each
            // file's score against this so the LEAST-referenced file's
            // icon is 1× and the MOST-referenced is 10×, whatever the
            // project's absolute reference counts happen to be.
            let minPopularity = Infinity;
            let maxPopularity = 0;
            for (const f of project.files) {
                const p = filePopularity.get(f.id) ?? 0;
                if (p < minPopularity) minPopularity = p;
                if (p > maxPopularity) maxPopularity = p;
            }
            if (!Number.isFinite(minPopularity)) minPopularity = 0;

            // Shift-key tracking for path tracing. wireCamera's onClick
            // doesn't pass modifier state, so we mirror it via window key
            // listeners. Captured on the click, consulted in handleClick.
            let shiftHeld = false;
            const onShiftDown = (e: KeyboardEvent): void => {
                if (e.key === "Shift") shiftHeld = true;
            };
            const onShiftUp = (e: KeyboardEvent): void => {
                if (e.key === "Shift") shiftHeld = false;
            };
            window.addEventListener("keydown", onShiftDown);
            window.addEventListener("keyup", onShiftUp);

            // Cached live set + the inputs that produced it; recomputed in
            // the ticker when any of them change. liveFiles === null means
            // "no focus mode active". draw() promotes this to a non-null
            // empty set when nothing is selected — see AMBIENT_EMPTY_LIVE_SET
            // — so the ambient/default state fades everything by reusing
            // the focus-mode dim path.
            let liveFiles: Set<string> | null = null;
            let liveFilesKey = "";
            // The selectionSet REFERENCE that produced the cached
            // liveFiles. The store returns a fresh Set on every
            // mutation, so identity equality is enough — no need to
            // hash the contents.
            let liveFilesSelectionRef: ReadonlySet<string> | null = null;
            // Shared empty live set for the ambient (no-selection) case —
            // a single allocation so we don't make a new Set each frame.
            const AMBIENT_EMPTY_LIVE_SET: ReadonlySet<string> = new Set();

            // Directory-boundary rendering. Each frame, for every directory
            // with ≥2 files, compute the convex hull of its members' current
            // positions (inflated by FILE_RIM + a tunable padding) and
            // stroke + fill it on directoryGfx. A pale directory label
            // floats at the hull's topmost point.
            //
            // Convex hull uses the monotone-chain algorithm — O(n log n),
            // ~15 lines — which is plenty fast for the typical handful of
            // files per directory.
            type Pt = {x: number; y: number};
            // Larger pad makes the hull "breathe" so adjacent directories
            // visually separate even when their file clusters are close;
            // also keeps file icons + labels comfortably INSIDE the hull
            // rather than clipping its boundary.
            const BOUNDARY_PAD = 48;
            // Stable hue per directory path — both `colourForDirectory`
            // (muted, for hulls) and `colourForDirectoryStrong` (saturated,
            // for file icons) share the same hash so a file icon and its
            // hull are visibly the same colour family, just different
            // intensities. The strong variant is what makes file icons
            // 'belong to a subsystem' visually.
            const hueForDirectory = (dir: string): number => {
                let h = 0;
                for (let i = 0; i < dir.length; i++) {
                    h = (h * 31 + dir.charCodeAt(i)) | 0;
                }
                return ((h % 360) + 360) % 360;
            };
            const colourForDirectory = (dir: string): number => hslToHex(hueForDirectory(dir), 38, 52);
            const colourForDirectoryStrong = (dir: string): number =>
                // Higher saturation + slightly higher lightness so the
                // icon body is unambiguously the directory's signature
                // colour, not a muted variant readable only against the
                // hull behind it.
                hslToHex(hueForDirectory(dir), 65, 58);
            const colourForDirectoryDim = (dir: string): number =>
                // A few stops darker than `colourForDirectory` — used for
                // FILE NAME labels so they read as members of their
                // directory's colour family without competing with the
                // (already-dim) directory-hull labels for visual weight.
                // Same hue and saturation so the family tie is obvious;
                // lower lightness so the file name sits a tier "below"
                // its containing folder name.
                hslToHex(hueForDirectory(dir), 38, 42);
            // Take the first `depth` components of a relative path. Used to
            // group deeply-nested files into a smaller number of meaningful
            // architectural clusters. `src/components/data-display/list/item.tsx`
            // at depth=2 → `src/components`. Returns '' for root-level files
            // (one component or fewer) so they're skipped from clustering.
            function clusterDirOf(rel: string, depth: number): string {
                const parts = rel.split("/");
                if (parts.length < 2) return "";
                const take = Math.min(depth, parts.length - 1);
                return parts.slice(0, take).join("/");
            }

            // Set of file ids the renderer is suppressing this frame —
            // union of support files (when "tests" is off) and isolate-
            // mode outsiders (when "isolate" is on and selection is
            // active past the file-expand zoom). Single source of
            // truth for "this file shouldn't render", consulted by the
            // file-draw loop AND the cluster helpers below so the
            // visible files, directory hulls, and edges all agree on
            // what's on screen. Updated each frame at the top of
            // draw(); read elsewhere via closure.
            let frameHiddenFileIds: ReadonlySet<string> | null = null;

            // Pick the LARGEST cluster depth whose distinct-group count
            // still fits the current zoom's target window. The target
            // widens as the user zooms IN — more detail allowed. At
            // extreme zoom-out we want ~8 groups (architectural blobs);
            // near full zoom we want fine groupings close to leaf-parent.
            //
            // 'Largest acceptable depth' (rather than first acceptable):
            // for a project whose files all live under a single top-level
            // directory like `src/`, depth 1 yields ONE group ('src') with
            // every file in it — useless. Depth 2 typically resolves to the
            // real architectural subdirectories, which is what we want.
            // Stop iterating only when the next depth exceeds the cap.
            //
            // targetMax grows steeply with zoom (slope 280, cap 240) so
            // sub-directories resolve EARLY as the user zooms in: depth 3
            // becomes reachable around cameraScale ~0.14, depth 4 ~0.4 —
            // a typical React project's nested folders appear without
            // having to zoom most of the way in.
            function chooseClusterDepth(): number {
                const targetMax = Math.max(8, Math.min(40, Math.round(12 + cameraScale * 320)));
                let chosen = 1;
                for (let d = 1; d <= 6; d++) {
                    const set = new Set<string>();
                    for (const f of layout.nodes) {
                        if (frameHiddenFileIds && frameHiddenFileIds.has(f.id)) continue;
                        const c = clusterDirOf(f.relativePath, d);
                        if (c) set.add(c);
                    }
                    if (set.size === 0) continue;
                    if (set.size > targetMax) break;
                    chosen = d;
                }
                return chosen;
            }
            const convexHull = (pts: Pt[]): Pt[] => {
                if (pts.length < 3) return pts.slice();
                const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
                const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
                const lower: Pt[] = [];
                for (const p of sorted) {
                    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                        lower.pop();
                    }
                    lower.push(p);
                }
                const upper: Pt[] = [];
                for (let i = sorted.length - 1; i >= 0; i--) {
                    const p = sorted[i];
                    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                        upper.pop();
                    }
                    upper.push(p);
                }
                lower.pop();
                upper.pop();
                return lower.concat(upper);
            };
            const inflateHull = (hull: Pt[], pad: number): Pt[] => {
                if (hull.length === 0) return hull;
                let cx = 0;
                let cy = 0;
                for (const p of hull) {
                    cx += p.x;
                    cy += p.y;
                }
                cx /= hull.length;
                cy /= hull.length;
                return hull.map((p) => {
                    const dx = p.x - cx;
                    const dy = p.y - cy;
                    const d = Math.hypot(dx, dy) || 1;
                    return {x: p.x + (dx / d) * pad, y: p.y + (dy / d) * pad};
                });
            };
            // (The previous directory super-node summary was removed —
            // it was a discrete tier at extreme zoom-out that read as
            // 'just circles, no architecture' and didn't earn its own
            // render mode. The adaptive-depth hulls below do the
            // architectural summarisation continuously as the user
            // zooms, which the user preferred.)

            const drawDirectoryBoundaries = (): void => {
                // Same adaptive depth as the super-nodes — at low zoom we
                // get a small number of broad architectural hulls
                // ('src/components', 'src/partials'); zooming in resolves to
                // finer leaf-directory hulls without ever swamping the
                // scene with 60+ overlapping label strings.
                const depth = chooseClusterDepth();
                const byDir = new Map<string, SimFileNode[]>();
                for (const sim of layout.nodes) {
                    if (frameHiddenFileIds && frameHiddenFileIds.has(sim.id)) continue;
                    const dir = clusterDirOf(sim.relativePath, depth);
                    if (!dir) continue;
                    let list = byDir.get(dir);
                    if (!list) {
                        list = [];
                        byDir.set(dir, list);
                    }
                    list.push(sim);
                }
                for (const [dir, mems] of byDir) {
                    if (mems.length < 2) continue;
                    // Inflate each file's footprint into a small star of corner
                    // points so the hull encloses the file rect, not just its
                    // centre. Cheaper than per-file circle sampling and visually
                    // identical for the convex-hull algorithm.
                    const pts: Pt[] = [];
                    for (const m of mems) {
                        const half = Math.max(m.width, m.height) / 2;
                        pts.push({x: m.x - half, y: m.y - half});
                        pts.push({x: m.x + half, y: m.y - half});
                        pts.push({x: m.x + half, y: m.y + half});
                        pts.push({x: m.x - half, y: m.y + half});
                    }
                    const hull = inflateHull(convexHull(pts), BOUNDARY_PAD);
                    if (hull.length < 3) continue;
                    const colour = colourForDirectory(dir);
                    // Build the path.
                    directoryGfx.moveTo(hull[0].x, hull[0].y);
                    for (let i = 1; i < hull.length; i++) {
                        directoryGfx.lineTo(hull[i].x, hull[i].y);
                    }
                    // Quieter: very low fill alpha + subtler stroke so dense
                    // projects with many overlapping hulls don't read as
                    // chaos. The cluster + label do the spatial work; the
                    // hull is just a hint.
                    //
                    // Hull strokes fade out at the same zoom where file
                    // names start appearing — beyond that point the
                    // individual file labels carry the spatial story
                    // and the hull outline would compete for attention.
                    // Tied to the isolate regime so the cluster
                    // boundary and the per-file labels switch together
                    // with shared hysteresis.
                    const strokeAlpha = isolateRegimeEnabled() ? 0 : 0.28;
                    directoryGfx
                        .closePath()
                        .fill({color: colour, alpha: 0.04})
                        .stroke({
                            color: colour,
                            width: 1 / cameraScale,
                            alpha: strokeAlpha,
                        });
                    // Directory label centred on the hull's bounding box.
                    // Wrapped in [square brackets] to make the cluster
                    // boundary explicit at a glance — the hull stroke alone
                    // is intentionally faint and easy to miss; the brackets
                    // read as the cluster's "label marker" the way
                    // `[scope]` reads as a section header in CLI /
                    // build-tool output.
                    //
                    // When a member file is EXPANDED the centred placement
                    // would sit on top of its (now-large) content, so we
                    // shift the label to the top of the bounding box —
                    // outside the file rects, still inside the hull. With
                    // every file collapsed the bbox is roughly empty space
                    // around small icons, so centred reads as the cluster's
                    // visual centre.
                    let minX = hull[0].x;
                    let maxX = hull[0].x;
                    let minY = hull[0].y;
                    let maxY = hull[0].y;
                    for (let i = 1; i < hull.length; i++) {
                        if (hull[i].x < minX) minX = hull[i].x;
                        if (hull[i].x > maxX) maxX = hull[i].x;
                        if (hull[i].y < minY) minY = hull[i].y;
                        if (hull[i].y > maxY) maxY = hull[i].y;
                    }
                    // Always centred — the directory label lives on its
                    // OWN layer (`directoryLabelPool`) that sits behind
                    // worldGfx in the scene graph, so any expanded file
                    // covers the label where they overlap. Trying to
                    // dodge expanded files by shifting the label's
                    // position never quite worked: at low zoom the
                    // hull's BOUNDARY_PAD wasn't enough to keep the
                    // shifted label outside the file rect.
                    const targetX = (minX + maxX) / 2;
                    const targetY = (minY + maxY) / 2;
                    let eased = directoryLabelCentres.get(dir);
                    if (!eased) {
                        // First time we see this directory (or it just
                        // reappeared after a depth change) — start at
                        // the target so the label doesn't fly in from
                        // wherever the previous eased position was.
                        eased = {x: targetX, y: targetY};
                        directoryLabelCentres.set(dir, eased);
                    } else {
                        eased.x += (targetX - eased.x) * 0.1;
                        eased.y += (targetY - eased.y) * 0.1;
                    }
                    directoryLabelPool.put({
                        text: `[${dir}]`,
                        worldX: eased.x,
                        worldY: eased.y,
                        color: colour,
                        size: 12,
                        anchorX: 0.5,
                        anchorY: 0.5,
                        scale: 1 / cameraScale,
                    });
                    // Hit rect so the drag-fork can grab a folder by
                    // its label. The label is drawn at screen size 12
                    // monospace with a scale of 1 / cameraScale, so
                    // its WORLD-space size is `12 / cameraScale` tall
                    // and `chars × ~7 / cameraScale` wide. The 7 px/
                    // char heuristic over-shoots most monospace UI
                    // fonts slightly, giving a generous grab target
                    // (which is what you want for a small text rect).
                    // The hit rect is centred on the eased label
                    // position to match anchorX/Y = 0.5 in the label
                    // pool.
                    const text = `[${dir}]`;
                    const rectW = (text.length * 7) / cameraScale;
                    const rectH = 14 / cameraScale;
                    pushRect({
                        id: dir,
                        // fileId is unused for folder hits — the
                        // drag-fork keys off `id` (the cluster dir)
                        // and resolves the file list at drag-start.
                        fileId: "",
                        kind: "folder",
                        x: eased.x - rectW / 2,
                        y: eased.y - rectH / 2,
                        w: rectW,
                        h: rectH,
                        area: rectW * rectH,
                    });
                }
            };

            // (Shift-click path-trace was removed when Shift was repurposed
            // for additive multi-select. The shortestPath helper and the
            // tracedPath rendering can come back if path tracing is
            // re-bound to a different gesture.)
            const computeLiveFiles = (): Set<string> | null => {
                const st = useGraphStore.getState();
                if (st.selectionSet.size === 0) return null;
                // BFS seeds from EVERY selected file. With multi-select,
                // each selection contributes its own hop-neighbourhood —
                // shift-selecting two files means BOTH stay bright AND
                // every file within `focusHops` edges of EITHER stays
                // bright. AST node ids fold to their containing file.
                //
                // The hop semantics:
                //   focusHops = 0: just the selected files themselves.
                //   focusHops = 1: + files directly connected to any seed.
                //   focusHops = 2: + their neighbours (children of the
                //                  directly-connected ring).
                //   focusHops = N: + N-step out from the seeds.
                const seeds = new Set<string>();
                for (const id of st.selectionSet) {
                    const fileId = id.includes("#") ? fileIdOfAstId(id) : id;
                    seeds.add(fileId);
                }
                const visited = new Set<string>(seeds);
                let frontier: string[] = [...seeds];
                // BFS direction is gated by the two isolate toggles:
                //   isolateImports → follow OUT edges  ("what does this
                //     depend on?" — outgoing imports/calls/extends).
                //   isolateExports → follow IN edges   ("what depends
                //     on this?" — incoming consumers).
                // Both default ON for the original bidirectional reach.
                // With neither on, the BFS still runs but expands
                // nothing — only the seeds themselves stay live, and
                // (later) the isolate-active check turns isolate off
                // anyway so this branch isn't usually exercised.
                const followOut = cfg.behavioral.isolateImports;
                const followIn = cfg.behavioral.isolateExports;
                for (let hop = 0; hop < st.focusHops; hop++) {
                    const next: string[] = [];
                    for (const node of frontier) {
                        for (const kind of ["imports", "calls", "extends"] as const) {
                            if (!st.edgeFilter[kind]) continue;
                            const b = fileEdgesByKind[kind];
                            const buckets: (Set<string> | undefined)[] = [];
                            if (followIn) buckets.push(b.in.get(node));
                            if (followOut) buckets.push(b.out.get(node));
                            for (const set of buckets) {
                                if (!set) continue;
                                for (const n of set) {
                                    if (!visited.has(n)) {
                                        visited.add(n);
                                        next.push(n);
                                    }
                                }
                            }
                        }
                    }
                    frontier = next;
                    if (frontier.length === 0) break;
                }
                return visited;
            };
            const maybeRecomputeLiveFiles = (): void => {
                const st = useGraphStore.getState();
                const key = `${st.focusHops}|${st.edgeFilter.imports}|${st.edgeFilter.calls}|${st.edgeFilter.extends}|${cfg.behavioral.isolateImports}|${cfg.behavioral.isolateExports}`;
                if (st.selectionSet === liveFilesSelectionRef && key === liveFilesKey) {
                    return;
                }
                liveFilesSelectionRef = st.selectionSet;
                liveFilesKey = key;
                liveFiles = computeLiveFiles();
            };

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
                size: {w: number; h: number};
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
                    pruneEmpty: (n) => n.syntaxKind === "Block", // drop empty `{}`
                    // extends/implements clauses are inlined on the class header.
                    prune: (n) => n.syntaxKind === "HeritageClause",
                    // Constructor reserves a label-height band for its wrench badge.
                    reserveBand: (n) => n.syntaxKind === "Constructor",
                    rowGroup: (n) => (n.syntaxKind === "HeritageClause" ? "extends" : "n"),
                    // Exactly the box the renderer's LOD gate checks below, so a
                    // cell sized here shows its label at 1:1 and nothing larger.
                    measure: labelScreenBox,
                    // Render control flow, return/throw, await, `as`, … as
                    // inline keyword glyphs interleaved with their operand
                    // boxes so the rect reads like source (`for [x] of [a]`).
                    syntaxTokens,
                    // Object/array/type literals shown EXPANDED inline drop
                    // their `{}` / `[]` header band so members sit at the top
                    // (no empty gap); the outline conveys the braces.
                    labelBandless: isBraceLabelKind,
                    // Functions lay out two-column: params bracketed on the
                    // left, return type + body on the right (see functionLayout).
                    groupedSignature: isFunctionSignatureKind,
                    returnTypeColor: SYNTAX.type,
                    measureGlyph: (t, s) => measureMono(t, s ?? AST_LABEL_FONT),
                    rowGap: (kind) => (kind === "Block" ? BLOCK_ROW_GAP : undefined),
                    sidePad: (kind) => (kind === "Block" ? BLOCK_SIDE_PAD : undefined),
                    // Every Block is ALWAYS collapsed in the main layout — the
                    // file's footprint never grows when a user expands a Block.
                    // Expanded Blocks are rendered as OVERLAYS on top of the
                    // main scene (anchored at the cell's world position), so
                    // the main layout dimensions stay stable across toggles.
                    // Every expandable container (Block + ObjectLiteralExpression)
                    // collapses to a small kind-outlined cell in the main layout
                    // — the file's footprint stays stable across toggles. The
                    // user expands one by clicking it, which spawns an overlay
                    // anchored at the cell's world position.
                    collapseChildren: (n) => isExpandableKind(n.syntaxKind),
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
                const diameter = Math.min(maxSide, Math.max(minSide, Math.ceil(2 * (force.bounds.radius + FILE_RIM))));
                const size = {w: diameter, h: diameter};
                return {tree, force, size};
            }

            // Overlay layouts — one TreemapLayout per expanded Block, with
            // the Block itself as the root and its descendants laid out
            // normally (other nested Blocks stay collapsed within the
            // overlay). Built lazily the first time the user toggles a
            // Block, cached keyed by `${fileId}:${blockId}` and invalidated
            // when the file's AST identity changes.
            const overlayLayouts = new Map<string, {ast: FileAstResponse; layout: TreemapLayout}>();

            function fileIdOfAstId(astId: string): string {
                const i = astId.lastIndexOf("#");
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
                    {fileId, rootId: blockId, nodes: ast.nodes},
                    {
                        originX: 0,
                        originY: 0,
                        labelOf: labelFor,
                        significant: isSignificant,
                        pruneEmpty: (n) => n.syntaxKind === "Block",
                        prune: (n) => n.syntaxKind === "HeritageClause",
                        reserveBand: (n) => n.syntaxKind === "Constructor",
                        rowGroup: (n) => (n.syntaxKind === "HeritageClause" ? "extends" : "n"),
                        measure: labelScreenBox,
                        syntaxTokens,
                        labelBandless: isBraceLabelKind,
                        groupedSignature: isFunctionSignatureKind,
                        returnTypeColor: SYNTAX.type,
                        measureGlyph: (t, s) => measureMono(t, s ?? AST_LABEL_FONT),
                        rowGap: (kind) => (kind === "Block" ? BLOCK_ROW_GAP : undefined),
                        sidePad: (kind) => (kind === "Block" ? BLOCK_SIDE_PAD : undefined),
                        // Inside an overlay, nested expandable containers STAY
                        // collapsed so the user can open them as their own
                        // overlay too (same model as nested Blocks). The
                        // synthetic root itself (`blockId`) is exempt — its
                        // own content is the whole point of opening THIS
                        // overlay.
                        collapseChildren: (n) => isExpandableKind(n.syntaxKind) && n.id !== blockId,
                    },
                );
                overlayLayouts.set(blockId, {ast, layout});
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
                layoutsByFileId.set(fileId, {ast, layout});
                return layout;
            }

            function expandedSizeFor(fileId: string): {w: number; h: number} | null {
                const result = ensureExpandedLayout(fileId);
                if (!result) return null;
                // Floor the expanded diameter at "collapsed footprint
                // + ~40 px" so a file with very little content (a
                // single small interface, for example) still visibly
                // EXPANDS rather than shrinking to a circle smaller
                // than its collapsed icon-plus-label footprint —
                // which reads as "nothing happened" and matches the
                // reported "never expands" bug for files like
                // device-settings.ts.
                const sim = layout.byId.get(fileId);
                if (sim) {
                    const collapsedFootprint = Math.max(sim.collapsedW, sim.collapsedH);
                    const minDiameter = collapsedFootprint + 40;
                    if (result.size.w < minDiameter || result.size.h < minDiameter) {
                        const d = Math.max(result.size.w, result.size.h, minDiameter);
                        return {w: d, h: d};
                    }
                }
                return result.size;
            }

            // Accessors used throughout draw + edge anchoring code.
            function activeTree(fileId: string): TreemapLayout | undefined {
                return ensureExpandedLayout(fileId)?.tree;
            }
            function activeForce(fileId: string): AstForceLayout | undefined {
                return ensureExpandedLayout(fileId)?.force;
            }

            function applyExpansionToSim() {
                applyExpansion(layout, useGraphStore.getState().expandedFiles, expandedSizeFor);
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
                // Outlines and edge emphasis read from selectionSet so all
                // Shift-selected siblings highlight together. The primary
                // (last-clicked) lives on as state.selection and is consumed
                // by single-target UI elsewhere (editor pane, focus mode).
                const selectionSet = state.selectionSet;

                worldGfx.clear();
                directoryGfx.clear();
                semanticEdgeGfx.clear();
                semanticEdgeOverlayGfx.clear();
                hitRects.length = 0;
                overlayHitRects.length = 0;
                currentHitTarget = hitRects;
                currentGfx = worldGfx;
                currentLabelPool = labelPool;
                visibleById.clear();
                blockCellsThisFrame.clear();
                labelPool.beginFrame();
                directoryLabelPool.beginFrame();

                // Focus-mode live set — recomputed only when focusId, focusHops
                // or edgeFilter changes. Consumed by the dim overlay below
                // and by drawEdges + drawSemanticEdges via per-edge alpha.
                maybeRecomputeLiveFiles();

                // Ambient / "nothing selected" state: with no selection
                // there's no focal point, so the default is to fade
                // EVERYTHING. We piggyback on the focus-mode dimming
                // machinery — supplying an empty live set means no node is
                // "in focus", so every file + edge passes through the same
                // dim path that non-neighbours already use under focus mode.
                // Selecting a file repopulates the live set and that file
                // (and its neighbourhood) pops back out.
                const ambient = state.selectionSet.size === 0;
                const effectiveLiveFiles: ReadonlySet<string> | null = ambient ? AMBIENT_EMPTY_LIVE_SET : liveFiles;

                // Path-trace lookup: a set of "${a}|${b}" keys for every
                // CONSECUTIVE pair in state.tracedPath (both directions, so
                // edge-direction independence is automatic). drawEdges /
                // drawSemanticEdges check this to thicken and unblock the
                // path overlay even when focus dimming would otherwise apply.
                //
                // Computed BEFORE the hidden-files set so isolate mode can
                // exempt path-traced files from being hidden.
                const pathEdgeKeys: Set<string> = new Set();
                const pathFileSet: Set<string> = new Set();
                if (state.tracedPath && state.tracedPath.length > 0) {
                    for (const f of state.tracedPath) pathFileSet.add(f);
                    for (let i = 0; i < state.tracedPath.length - 1; i++) {
                        const a = state.tracedPath[i];
                        const b = state.tracedPath[i + 1];
                        pathEdgeKeys.add(`${a}|${b}`);
                        pathEdgeKeys.add(`${b}|${a}`);
                    }
                }

                const hideSupport = !state.showSupportFiles;
                // "Isolate" mode: once the zoom crosses the isolate
                // threshold AND a selection exists, hide files outside
                // the focus neighbourhood (selectionSet × focusHops)
                // entirely. The isolate threshold sits BELOW the file-
                // expand threshold (ISOLATE_AT_MUL < FILE_EXPAND_AT_MUL)
                // so the surrounding cluster fades out before the
                // selected files start expanding — staging the two
                // visual changes rather than firing them together.
                // Each regime has its own hysteresis band. Path-traced
                // files override the hide.
                const isolateActive = (cfg.behavioral.isolateImports || cfg.behavioral.isolateExports) && !ambient && liveFiles != null && isolateRegimeEnabled();
                // Set of file ids to suppress completely from rendering
                // this frame — union of support files (when "tests" is
                // off) and isolate-mode outsiders (when isolate is
                // active). Path-traced files are never hidden,
                // regardless of the other flags.
                //
                // Assigned to the IIFE-scoped frameHiddenFileIds so
                // chooseClusterDepth + drawDirectoryBoundaries (defined
                // outside draw) see the same hidden set the file loop
                // and edge passes use. Computed BEFORE chooseClusterDepth
                // is called so the cluster grouping reflects the
                // visible file set.
                frameHiddenFileIds = (() => {
                    if (!hideSupport && !isolateActive) return null;
                    const out = new Set<string>();
                    if (hideSupport) {
                        for (const id of supportFileIds) {
                            // User-pinned files are always visible — a
                            // pin is the user explicitly saying "I
                            // care about THIS file"; respect that
                            // over the broad-strokes tests filter.
                            if (layout.byId.get(id)?.userPinned) continue;
                            out.add(id);
                        }
                    }
                    if (isolateActive && liveFiles) {
                        for (const sim of layout.nodes) {
                            // Same rule applies to isolation hiding:
                            // a pinned file is a persistent "point
                            // of interest" indicator that must stay
                            // on screen regardless of focus mode.
                            if (sim.userPinned) continue;
                            if (!liveFiles.has(sim.id) && !pathFileSet.has(sim.id)) {
                                out.add(sim.id);
                            }
                        }
                    }
                    return out;
                })();
                const hiddenFileIds = frameHiddenFileIds;

                // Active cluster grouping for this frame — drives hulls,
                // intra-cluster edge gate, AND file-icon coloring so they
                // all read consistently. At low zoom this is coarse
                // ('src/components'); at high zoom it approaches the leaf
                // parent. The Map is closure-scoped (IIFE level) so drawFile
                // can read it; rebuilt fresh each frame here.
                const activeClusterDepth = chooseClusterDepth();
                fileToActiveCluster = new Map<string, string>();
                for (const sim of layout.nodes) {
                    const c = clusterDirOf(sim.relativePath, activeClusterDepth);
                    if (c) fileToActiveCluster.set(sim.id, c);
                }

                // Single render path — file icons + adaptive-depth hulls at
                // every zoom level. The hulls themselves do the architectural
                // summarisation as the user zooms out (chooseClusterDepth
                // gives broader groups at lower zoom); the previous
                // super-node "all directories become a circle" mode was too
                // discrete a tier — the user preferred the smooth depth
                // ramp.

                // 1. Import edges (under rects).
                if (state.edgeFilter.imports) {
                    drawEdges(
                        layout,
                        project.edges,
                        activeForce,
                        worldGfx,
                        cameraScale,
                        visibleSemanticPairs,
                        selectionSet,
                        effectiveLiveFiles,
                        pathEdgeKeys,
                        hiddenFileIds,
                        // Use the ACTIVE cluster grouping (zoom-adaptive depth)
                        // so the intra-cluster edge gate matches what the hulls
                        // group into. Otherwise edges between same-cluster but
                        // different-leaf-directory files would still draw.
                        fileToActiveCluster,
                        cfg.lod,
                        cfg.theme.edgeStyle,
                    );
                } else {
                    visibleSemanticPairs.clear();
                }

                // 1b. Directory boundaries (translucent convex hull + label
                //     behind file circles). Drawn AFTER edges so import lines
                //     pass cleanly through, and BEFORE files so file circles
                //     sit on top of the boundary fill.
                drawDirectoryBoundaries();

                // 2. Files + AST subtrees on `worldGfx`. pushRect keeps
                //    visibleById in sync so the edge pass below can find
                //    precise anchors. Support files (.test / .stories /
                //    .spec / __tests__ / __mocks__) are skipped when
                //    state.showSupportFiles is off.
                // Per-file dim factor for focus mode. Non-live files (outside
                // the user's focus neighbourhood) draw their icon / circle /
                // border at 0.22 alpha — quiet, but still visibly present.
                // Path-traced files override and stay bright. Labels are
                // drawn through labelPool on a layer that ignores this
                // multiplier, so file + directory names stay readable.
                for (const sim of layout.nodes) {
                    if (hiddenFileIds && hiddenFileIds.has(sim.id)) continue;
                    // Pinned files dim with focus like any other file (their
                    // box gets no special brightness). Whether the pin ICON
                    // stays bright on a dimmed box is controlled separately by
                    // cfg.behavioral.highlightPins (see drawFile's badge).
                    const dimmed =
                        effectiveLiveFiles != null &&
                        !effectiveLiveFiles.has(sim.id) &&
                        !pathFileSet.has(sim.id);
                    drawFile(sim, selectionSet, dimmed ? 0.22 : 1);
                }
                // 2c. Path overlay: thin yellow outline around every file
                //     in the traced path.
                if (pathFileSet.size > 0) {
                    for (const sim of layout.nodes) {
                        if (!pathFileSet.has(sim.id)) continue;
                        const r = sim.width / 2 + 6 / cameraScale;
                        worldGfx.circle(sim.x, sim.y, r).stroke({
                            color: SYNTAX.func,
                            width: 2.5 / cameraScale,
                            alpha: 0.95,
                        });
                    }
                }

                // 3. Overlays for expanded Blocks. Iterate multiple passes so
                //    nested overlays (Block expanded inside another overlay)
                //    can render after their parent has registered the cell
                //    they anchor to. Stops once no new overlay drew this pass.
                //
                //    Each overlay gets its OWN pane (Container + Graphics +
                //    LabelPool) from `overlayPanes`. Because the panes are
                //    stacked in `world` in fixed order, pane[i+1] renders
                //    above EVERYTHING in pane[i] — both its rects AND its
                //    labels — which is what nested overlays need: a child
                //    overlay's rect must fully obscure its parent's labels
                //    where they overlap. A single shared overlay-rect /
                //    overlay-label tier (the prior design) couldn't do that
                //    because all overlay labels rendered above all overlay
                //    rects regardless of which overlay they belonged to.
                currentHitTarget = overlayHitRects;
                const renderedOverlays = new Set<string>();
                const overlaysToDraw = new Set<string>(state.expandedAstNodes);
                // Include any block in a currently-animating shrink, even if
                // it's no longer in expandedAstNodes (the user just toggled
                // it off but the rect is still lerping back to cell size).
                for (const id of blockAnims.keys()) overlaysToDraw.add(id);
                let paneCursor = 0;
                let progress = true;
                let safety = MAX_OVERLAY_PANES;
                while (progress && safety-- > 0) {
                    progress = false;
                    for (const blockId of overlaysToDraw) {
                        if (renderedOverlays.has(blockId)) continue;
                        const cell = blockCellsThisFrame.get(blockId);
                        if (!cell) continue; // anchor not on this frame yet — wait
                        if (paneCursor >= overlayPanes.length) break; // out of panes
                        const pane = overlayPanes[paneCursor];
                        pane.container.visible = true;
                        pane.gfx.clear();
                        pane.labels.beginFrame();
                        currentGfx = pane.gfx;
                        currentLabelPool = pane.labels;
                        drawOverlay(blockId, cell, selectionSet);
                        pane.labels.endFrame();
                        renderedOverlays.add(blockId);
                        paneCursor++;
                        progress = true;
                    }
                }
                // Hide any panes the frame didn't use, so old rects/labels
                // from a previous frame don't linger.
                for (let i = paneCursor; i < overlayPanes.length; i++) {
                    overlayPanes[i].container.visible = false;
                    overlayPanes[i].gfx.clear();
                    overlayPanes[i].labels.beginFrame();
                    overlayPanes[i].labels.endFrame();
                }
                currentHitTarget = hitRects;
                currentGfx = worldGfx;
                currentLabelPool = labelPool;

                // 4. Hide unused entries in the main-scene label pool. Each
                //    overlay pane's pool was already begin/end-framed per
                //    overlay above.
                labelPool.endFrame();
                directoryLabelPool.endFrame();

                // 5. Semantic edges (calls / extends / implements) on the
                //    dedicated semanticEdgeGfx layer. Scene-graph z puts that
                //    layer ABOVE main labels but BELOW the overlay panes, so a
                //    connector and its selection-gated caller/callee outline
                //    are obscured by any overlay whose bounds they cross. The
                //    draw call's position in this function doesn't matter for
                //    z (Graphics retain their draws across frames until cleared;
                //    z is decided by addChild order in world).
                // AST ids that the overlay pass actually rendered this frame.
                // Connectors with either endpoint in this set get routed to
                // the top-layer semanticEdgeOverlayGfx so their origin /
                // destination inside an overlay is visible. Everything else
                // stays on the below-overlays semanticEdgeGfx.
                const overlayAstSet = new Set<string>();
                for (const r of overlayHitRects) overlayAstSet.add(r.id);

                drawSemanticEdges(
                    project.semanticEdges,
                    semanticEdgeGfx,
                    semanticEdgeOverlayGfx,
                    overlayAstSet,
                    visibleById,
                    activeTree,
                    cameraScale,
                    selectionSet,
                    state.expandedFiles,
                    visibleSemanticPairs,
                    state.edgeFilter,
                    effectiveLiveFiles,
                    pathEdgeKeys,
                    hiddenFileIds,
                    // Same active-cluster grouping as drawEdges (above).
                    fileToActiveCluster,
                    cfg.lod,
                );
            }

            function drawFile(
                sim: SimFileNode,
                selectionSet: ReadonlySet<string>,
                // Alpha multiplier applied to every fill/stroke emitted by
                // this function. Used by focus-mode dimming — non-live
                // files draw at ~0.22, everything else at 1. Labels are NOT
                // multiplied here; they go through labelPool with their own
                // colour and stay readable.
                dimAlpha: number,
            ): void {
                const x = sim.x - sim.width / 2;
                const y = sim.y - sim.height / 2;
                const expanded = useGraphStore.getState().expandedFiles.has(sim.id);
                const isSelected = selectionSet.has(sim.id);
                // Hover reveals the file name even when the LOD gate would
                // otherwise hide it — `hoveredHit` is set by the camera's
                // hit-test pipeline; we just consult it here.
                const isHovered = hoveredHit?.kind === "file" && hoveredHit.id === sim.id;
                // Popularity-based scale factor, normalised across the
                // project into [1, 10]: the least-referenced file's icon is
                // 1× its base size, the most-referenced is 10×. Normalising
                // on sqrt(refs) (rather than raw refs) spreads the scaling
                // across the mid-popular files instead of letting a single
                // mega-hub outlier flatten everyone else toward 1×. The
                // final on-screen size is still clamped by the min(world,
                // screen/zoom) formula below — popularity sets the cap, it
                // doesn't bypass it.
                const popularity = filePopularity.get(sim.id) ?? 0;
                const popSpan = Math.sqrt(maxPopularity) - Math.sqrt(minPopularity);
                const popNorm = popSpan > 0 ? (Math.sqrt(popularity) - Math.sqrt(minPopularity)) / popSpan : 0;
                const popFactor = 1 + 9 * popNorm;

                // The filename is ALWAYS drawn above the node (centered, counter-
                // scaled to constant size) — never inside it — so it can't overlap
                // the box content or the dot at any zoom.
                const labelScale = 1 / cameraScale;
                const aboveGap = 8 / cameraScale; // screen-constant gap above the node
                const putName = (topY: number): void => {
                    // LOD gate: hide individual file names until the camera
                    // reaches the configured file-name zoom (fileNamesAtMul ×
                    // fitScale) so the directory-hull labels carry the spatial
                    // story until then. The SELECTED file AND any currently
                    // HOVERED file are exceptions — they're the user's anchor
                    // and current point of attention; both stay readable.
                    const fileNamesVisible = cameraScale >= cfg.lod.fileNamesAtMul * Math.max(fitScale, 1e-4);
                    if (!fileNamesVisible && !isSelected && !isHovered) {
                        return;
                    }
                    // Expanded files AND hovered files show the FULL
                    // relative path (so the user can see WHERE the file lives
                    // in the project). Collapsed, unhovered files show just
                    // the basename — at typical zooms with many file icons
                    // packed close together, basename keeps the canvas
                    // readable while full path would crowd it.
                    const showFullPath = expanded || isHovered;
                    const text = showFullPath ? sim.relativePath : fileLabel(sim.relativePath);
                    // Basename labels tint to a slightly-darker shade of
                    // their directory's hue, so the file reads as a member
                    // of its folder cluster (and clusters of files are
                    // visually grouped at a glance). Full-path mode
                    // (hover / expanded / selected) and root-level files
                    // (no cluster) keep the default white so the active
                    // attention target stands out against the dimmer rest.
                    const cluster = fileToActiveCluster.get(sim.id);
                    const highlighted = showFullPath || isSelected;
                    const color = highlighted || !cluster ? liveTheme.colors.text : colourForDirectoryDim(cluster);
                    // Default: 75% of the directory-hull label's 12px so
                    // file names sit a tier below their containing folder
                    // name in the visual hierarchy. Highlighted state
                    // (hover / expanded / selected) matches the folder's
                    // 12px so the active attention target reads at the
                    // same weight as its containing folder.
                    const size = highlighted ? 12 : 9;
                    labelPool.put({
                        text,
                        worldX: sim.x,
                        worldY: topY - aboveGap,
                        color,
                        size,
                        anchorX: 0.5,
                        anchorY: 1, // text's bottom sits `aboveGap` above the node
                        scale: labelScale,
                    });
                };

                // Expand/collapse visual progress, DERIVED from the
                // live sim width. 0 = icon, 1 = full circle + AST.
                // Width is the single source of truth — d3-force's
                // collide and link forces use it directly (via
                // refreshSizeForces in stepLayout), and the renderer
                // reads it for the circle radius below — so deriving
                // `t` from the same value guarantees the alpha
                // crossfade can't drift out of sync with the physical
                // collision disc.
                //
                // For an expanding file, denominator is the in-flight
                // target. For a collapsing file (targetExpanded false,
                // width still in flight), denominator is the file's
                // last-known expanded size, recorded by applyExpansion.
                // Robust to expanded < collapsed (degenerate but
                // legal when the file's content is smaller than its
                // icon+label footprint — though expandedSizeFor floors
                // diameter to keep that case rare).
                const refW = sim.targetExpanded ? sim.targetW : sim.lastExpandedTargetW;
                const span = refW - sim.collapsedW;
                const tRaw = Math.abs(span) < 1 ? 0 : (sim.width - sim.collapsedW) / span;
                const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;

                // World-fixed icon size with a screen cap, multiplied by
                // popularity. Icons shrink with the world as you zoom
                // OUT (so dense clusters stop overlapping themselves),
                // but never grow past popFactor × 16×20 screen-px when
                // you zoom IN. Popular files (many incoming references)
                // get a proportionally larger cap, so architectural hubs
                // stand out at every zoom level.
                //
                // Hoisted above the if/else so the icon-radius can serve
                // as the FROM endpoint of the icon→circle radius interp
                // during expansion animation.
                const baseW = 16 * popFactor;
                const baseH = 20 * popFactor;
                const baseFold = 6 * popFactor;
                const iw = Math.min(baseW, baseW / cameraScale);
                const ih = Math.min(baseH, baseH / cameraScale);
                const fold = Math.min(baseFold, baseFold / cameraScale);
                const ix = sim.x - iw / 2;
                const iy = sim.y - ih / 2;

                // The icon's bounding-circle radius — what the expanded
                // circle's radius interpolates UP FROM when t goes 0 → 1
                // (and DOWN TO when collapsing). Picking the larger of
                // half-w / half-h keeps the icon fully inside its
                // bounding circle, so the visual transition is
                // monotonically growing.
                const iconR = Math.max(iw, ih) / 2;
                // `sim.width` is now eased on the sim side itself by
                // stepLayout (was: instantly reset to collapsedW the
                // moment a file collapsed, leaving the renderer's
                // visual ease chasing a dead value via the old
                // lastExpandedRByFile cache). So `sim.width / 2` is
                // always the live, accurate "outer" radius — same
                // value d3-force's collide reads.
                const fullR = sim.width / 2;
                // Linear interp; the eased t already provides the
                // smoothing — adding smoothstep here would compound and
                // feel rubbery.
                const animatedR = iconR + (fullR - iconR) * t;

                // 1. ICON — drawn whenever t < 1, fading out as t → 1.
                //    When the file is fully expanded (t === 1, common case
                //    after the animation has settled) we skip the icon
                //    pass entirely.
                if (t < 1) {
                    const iconAlpha = (1 - t) * dimAlpha;
                    // Colour the page body by the file's current cluster
                    // (zoom-adaptive — same map the hulls and intra-cluster
                    // edge gate use). The 'strong' variant of the directory
                    // hash colour is used so the icon reads as a vivid
                    // signature of its subsystem instead of fading into the
                    // muted hull palette behind it. Selected file keeps its
                    // blue override so the click target stays unambiguously
                    // distinct.
                    const cluster = fileToActiveCluster.get(sim.id);
                    const dirColour = cluster ? colourForDirectoryStrong(cluster) : liveTheme.colors.file;
                    const body = isSelected ? liveTheme.colors.fileSelected : dirColour;
                    const line = isSelected ? liveTheme.colors.fileBorderSelected : cluster ? colourForDirectory(cluster) : liveTheme.colors.fileBorder;
                    const strokeW = Math.min(1, 1 / cameraScale);
                    worldGfx
                        .poly([ix, iy, ix + iw - fold, iy, ix + iw, iy + fold, ix + iw, iy + ih, ix, iy + ih])
                        .fill({color: body, alpha: iconAlpha})
                        .stroke({color: line, width: strokeW, alpha: iconAlpha});
                    // The folded corner, slightly distinct so it reads as a page.
                    worldGfx.poly([ix + iw - fold, iy, ix + iw, iy + fold, ix + iw - fold, iy + fold]).fill({color: line, alpha: 0.6 * iconAlpha});
                }

                // 2. CIRCLE — drawn whenever t > 0, fading in and growing
                //    from icon-radius to fullR. At t === 1 this is the
                //    only thing rendered (icon path above skipped).
                if (t > 0) {
                    const circleAlpha = t * dimAlpha;
                    worldGfx.circle(sim.x, sim.y, animatedR).fill({color: liveTheme.colors.fileExpanded, alpha: 0.7 * circleAlpha});
                    if (isSelected) {
                        worldGfx.circle(sim.x, sim.y, animatedR).stroke({
                            color: liveTheme.colors.fileSelected,
                            width: FILE_RIM / 2,
                            alpha: circleAlpha,
                        });
                    }
                }

                // 3. Hit rect: pick the shape that's currently MORE
                //    visible. The cutover at t = 0.5 matches where the
                //    crossfade also tips over to the circle. The
                //    circle branch uses the ANIMATED radius (not
                //    sim.width) so the hit area shrinks/grows with the
                //    visual during the transition — sim.width has
                //    already been reset to collapsedW when collapsing,
                //    so using it would give a tiny hit rect while the
                //    user still sees a big circle.
                if (t < 0.5) {
                    pushRect({id: sim.id, fileId: sim.id, kind: "file", x: ix, y: iy, w: iw, h: ih, area: iw * ih});
                } else {
                    const r2 = animatedR;
                    pushRect({
                        id: sim.id,
                        fileId: sim.id,
                        kind: "file",
                        x: sim.x - r2,
                        y: sim.y - r2,
                        w: r2 * 2,
                        h: r2 * 2,
                        area: r2 * r2 * 4,
                    });
                }

                // 4. Name label, positioned just above the currently-
                //    visible shape. Top of the animated circle is at
                //    sim.y - animatedR; at t=0 that equals iy, at t=1 it
                //    equals y, so the label slides smoothly upward as
                //    the file grows.
                putName(sim.y - animatedR);

                // 5. AST contents — only when fully expanded (t === 1
                //    after the snap-to-target threshold). Drawing them
                //    during the transition would be misleading: the
                //    treemap is sized for fullR, so at smaller radii the
                //    contents would spill outside the visible circle.
                //    The brief pop-in at the end of the transition is
                //    acceptable because by that point the file's circle
                //    is already at its final size.
                if (sim.expanded && t >= 1) {
                    let tree = activeTree(sim.id);
                    if (!tree) {
                        buildSubtreeLayout(sim.id);
                        tree = activeTree(sim.id);
                    }
                    if (tree) drawSubtree(tree, x, y, sim.id, selectionSet);
                }

                // 6. Pin badge — a small yellow dot at the upper-right
                //    of the file's visible shape when this file has
                //    been manually dragged by the user. Yellow matches
                //    the `↓ imports` pill in the HUD (the existing
                //    "user choice" hue in this UI). Position
                //    interpolates between the icon's top-right corner
                //    (t=0) and the circle's 45°-above-right point
                //    (t=1) so the badge tracks the shape through the
                //    expand/collapse animation without a jump.
                if (sim.userPinned) {
                    // The box dims with focus; the pin ICON can optionally stay
                    // bright so it remains a clear anchor on a dimmed file
                    // (highlightPins). When off, the icon dims with its box.
                    const pinAlpha = cfg.behavioral.highlightPins ? 1 : dimAlpha;
                    const iconPx = ix + iw;
                    const iconPy = iy;
                    const circPx = sim.x + animatedR * 0.7071;
                    const circPy = sim.y - animatedR * 0.7071;
                    const bx = iconPx + (circPx - iconPx) * t;
                    const by = iconPy + (circPy - iconPy) * t;
                    const badgeR = 4 / cameraScale;
                    const badgeStroke = 1 / cameraScale;
                    worldGfx
                        .circle(bx, by, badgeR)
                        .fill({color: 0xe8c84a, alpha: pinAlpha})
                        .stroke({color: 0x1c1c08, width: badgeStroke, alpha: pinAlpha});
                }
            }

            function drawSubtree(tree: TreemapLayout, _baseX: number, _baseY: number, fileId: string, selectionSet: ReadonlySet<string>): void {
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
                    drawAstNode(tn, offsetX + dx, offsetY + dy, fileId, tree, selectionSet);
                }
            }

            // Draw a class / interface as a translucent circle around its
            // members (instead of the bottom-up wrapped-row rect the treemap
            // would have built). Members render at their force-decided
            // positions via a per-child baseX/baseY adjustment passed to the
            // recursive drawAstNode call — treemap rects stay file-absolute
            // (so descendants of each member still translate correctly with
            // the member as a rigid body).
            function drawAstContainer(node: TreemapNode, x: number, y: number, container: ContainerForceLayout, fileId: string, tree: TreemapLayout, selectionSet: ReadonlySet<string>): void {
                const cx = x + node.rect.w / 2;
                const cy = y + node.rect.h / 2;
                const radius = node.rect.w / 2;

                const isSelected = selectionSet.has(node.id);
                // Interface = always dashed green (TypeScript interfaces are
                // abstract by nature, no `abstract` keyword needed). Abstract
                // class = dashed; concrete class = solid. Same colour grammar
                // as the rect path further down.
                const isInterface = node.syntaxKind === "InterfaceDeclaration";
                const isAbstract = !!node.abstract;
                const dashed = isInterface || isAbstract;
                const strokeColor = isSelected ? liveTheme.colors.fileSelected : isInterface || isAbstract ? liveTheme.colors.astOutlineAbstract : SYNTAX.type;
                const strokeWidth = (isSelected ? FILE_RIM / 2 : 1) / cameraScale;
                const strokeAlpha = 1;

                // Per-pass shadowing: when drawAstContainer runs from the overlay
                // pass, `currentGfx`/`currentLabelPool` point at the overlay
                // layer; for the main pass they point at the main layer. Local
                // shadowing keeps every primitive/label call inside this function
                // routed automatically without per-site edits.
                const worldGfx = currentGfx;
                const labelPool = currentLabelPool;

                // Circle fill: same translucent dark as the file circle, so a
                // class reads as a "smaller file" of related members. EXPORTED
                // classes / interfaces get the amber export tint blended in
                // (matching the EXPORT_FILL_COLOR used for rect-shaped exports
                // in drawAstNode below), so the "this is part of the module's
                // public surface" signal carries over to the circle-shaped
                // member-container variants too. Already semi-transparent at
                // 0.55 alpha, so the boundary-overlay behaviour falls out for
                // free.
                const isExportContainer =
                    node.exported === true ||
                    node.syntaxKind === "ExportDeclaration" ||
                    node.syntaxKind === "ExportAssignment";
                const containerFillColor = isExportContainer
                    ? blendColor(liveTheme.colors.fileExpanded, EXPORT_FILL_COLOR, EXPORT_FILL_BLEND)
                    : liveTheme.colors.fileExpanded;
                worldGfx.circle(cx, cy, radius).fill({color: containerFillColor, alpha: 0.55});

                if (dashed) {
                    // Sample the perimeter and dash it. Step count scales with
                    // radius so big circles stay smooth.
                    const N = Math.max(48, Math.round(radius * 0.6));
                    const path: {x: number; y: number}[] = [];
                    for (let i = 0; i <= N; i++) {
                        const a = (i / N) * Math.PI * 2;
                        path.push({x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius});
                    }
                    emitDashed(worldGfx, path, 3.5 / cameraScale, 2.5 / cameraScale);
                    worldGfx.stroke({color: strokeColor, width: strokeWidth, alpha: strokeAlpha});
                } else {
                    worldGfx.circle(cx, cy, radius).stroke({color: strokeColor, width: strokeWidth, alpha: strokeAlpha});
                }

                // Hit rect: bounding square of the circle (same trade-off as
                // file circles — the four corner regions are visually empty so
                // a click there is unambiguously about this container).
                pushRect({
                    id: node.id,
                    fileId,
                    kind: "ast",
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
                        color: isInterface ? liveTheme.colors.astOutlineAbstract : SYNTAX.type,
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
                    drawAstNode(k, baseXk, baseYk, fileId, tree, selectionSet);
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
            function drawOverlay(blockId: string, cell: {x: number; y: number; w: number; h: number}, selectionSet: ReadonlySet<string>): void {
                const overlayTree = getOverlayLayout(blockId);
                if (!overlayTree) return;
                const blockNode = overlayTree.byId.get(blockId);
                if (!blockNode) return;
                const fileId = fileIdOfAstId(blockId);

                // Shadow the closure-scoped graphics with the active per-pass
                // target. The multi-pass loop in draw() points `currentGfx` at
                // THIS overlay's pane Graphics before invoking us, so the
                // background and handle rects land in the right pane — which
                // sits ABOVE every earlier pane in `world`'s child list and
                // therefore obscures any earlier overlay's rects and labels in
                // its bounds. (Labels inside this overlay come from the
                // recursive drawAstNode below, which shadows labelPool the
                // same way.)
                const worldGfx = currentGfx;

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

                // The overlay anchors at its origin cell, plus any drag offset
                // the user applied by dragging the close handle. When offset, a
                // connector line is drawn from the handle back to the origin.
                const dragOff = overlayDragOffsets.get(blockId);
                const x = cell.x + (dragOff?.x ?? 0);
                const y = cell.y + (dragOff?.y ?? 0);

                // Overlay background + outline. FULLY opaque — even a few
                // percent of transparency lets strokes from the layer below
                // (e.g. a Parameter rect's light-blue outline) show through as
                // a faint ghost, which reads as "text peeking through" even
                // when no actual label is leaking. The kind-coloured stroke
                // and the alpha-0.55 file circle behind do enough of the
                // "this is a layer above the file" lift on their own. The
                // stroke colour matches the underlying node's kind outline
                // (magenta for Block, yellow for ObjectLiteralExpression)
                // so the overlay reads as a magnified version of the cell
                // it was spawned from.
                const stroke = KIND_OUTLINE[blockNode.syntaxKind] ?? liveTheme.colors.astBorder;
                worldGfx
                    .rect(x, y, w, h)
                    .fill({color: liveTheme.colors.fileExpanded, alpha: 1})
                    .stroke({color: stroke, width: 1.5 / cameraScale, alpha: 1});

                pushRect({
                    id: blockId,
                    fileId,
                    kind: "ast",
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
                            drawAstNode(k, x, y, fileId, overlayTree, selectionSet);
                        }
                    }
                    // Row separators: a thin line between consecutive statement
                    // rows of a code block (the widened BLOCK_ROW_GAP gives it
                    // breathing room) — a visual cue that code reads left→right,
                    // line by line. Only for Block roots; objects/classes skip.
                    if (kids && kids.length > 1 && blockNode.syntaxKind === "Block") {
                        const rowBottomByTop = new Map<number, number>();
                        let gMinX = Infinity;
                        let gMaxX = -Infinity;
                        for (const k of kids) {
                            const top = Math.round(k.rect.y);
                            const bottom = k.rect.y + k.rect.h;
                            rowBottomByTop.set(top, Math.max(rowBottomByTop.get(top) ?? bottom, bottom));
                            if (k.rect.x < gMinX) gMinX = k.rect.x;
                            if (k.rect.x + k.rect.w > gMaxX) gMaxX = k.rect.x + k.rect.w;
                        }
                        const tops = [...rowBottomByTop.keys()].sort((a, b) => a - b);
                        const lw = 1 / cameraScale;
                        // Brighter than the faint border: blend the border colour
                        // toward white (~2× luminance) at a higher alpha.
                        const sepColor = blendColor(liveTheme.colors.astBorder, 0xffffff, 0.25);
                        for (let i = 1; i < tops.length; i++) {
                            const midY = y + (rowBottomByTop.get(tops[i - 1])! + tops[i]) / 2;
                            worldGfx
                                .moveTo(x + gMinX, midY)
                                .lineTo(x + gMaxX, midY)
                                .stroke({color: sepColor, width: lw, alpha: 0.8});
                        }
                    }
                }

                // Collapse handle: top-LEFT of the overlay (per the user's
                // request to move it). Smaller-area HitRect with kind
                // 'ast-toggle' takes priority over the overlay body for
                // clicks in this region.
                if (!anim && cameraScale >= cfg.lod.outlineBelow) {
                    const handleSize = 12 / cameraScale;
                    const handleInset = 4 / cameraScale;
                    const hx = x + handleInset;
                    const hy = y + handleInset;
                    // Connector line from the close handle back to the origin
                    // cell when the overlay has been dragged away — drawn in the
                    // block's outline colour, so e.g. a code block leads a pink
                    // line to where it was expanded. Drawn before the handle so
                    // the handle sits on top of the line's start.
                    //
                    // BOTH ends terminate at a border, not a centre: cast a ray
                    // along the handle-centre→cell-centre axis and clip it to
                    // each box's edge. For a centred rect of half-extents
                    // (W, H), the exit scale along direction d is
                    // t = 1 / max(|dx|/W, |dy|/H) — the dominant axis hits the
                    // edge exactly. The handle is a square (half-extent
                    // handleSize/2). Only draw when the handle is OUTSIDE the
                    // cell (otherwise the overlay still covers its origin and a
                    // connector is meaningless / would point outward).
                    const hcx = hx + handleSize / 2;
                    const hcy = hy + handleSize / 2;
                    const handleOutsideCell =
                        hcx < cell.x || hcx > cell.x + cell.w || hcy < cell.y || hcy > cell.y + cell.h;
                    if (dragOff && (dragOff.x !== 0 || dragOff.y !== 0) && handleOutsideCell) {
                        const ccx = cell.x + cell.w / 2;
                        const ccy = cell.y + cell.h / 2;
                        // Direction from cell centre to handle centre.
                        const dx = hcx - ccx;
                        const dy = hcy - ccy;
                        // Cell edge, walking out from the cell centre toward the handle.
                        const tCell = 1 / Math.max(Math.abs(dx) / (cell.w / 2), Math.abs(dy) / (cell.h / 2));
                        const endX = ccx + dx * tCell;
                        const endY = ccy + dy * tCell;
                        // Handle edge, walking out from the handle centre toward the cell.
                        const tHandle = handleSize / 2 / Math.max(Math.abs(dx), Math.abs(dy));
                        const startX = hcx - dx * tHandle;
                        const startY = hcy - dy * tHandle;
                        worldGfx
                            .moveTo(startX, startY)
                            .lineTo(endX, endY)
                            .stroke({color: stroke, width: 1.5 / cameraScale, alpha: 0.9});
                    }
                    const isHandleHovered = hoveredHit?.kind === "ast-toggle" && hoveredHit.id === blockId;
                    const lineW = (isHandleHovered ? 1.6 : 1) / cameraScale;
                    worldGfx
                        .rect(hx, hy, handleSize, handleSize)
                        .fill({color: stroke, alpha: isHandleHovered ? 0.5 : 0.25})
                        .stroke({color: stroke, width: lineW, alpha: 1});
                    worldGfx
                        .moveTo(hx + handleSize * 0.25, hy + handleSize / 2)
                        .lineTo(hx + handleSize * 0.75, hy + handleSize / 2)
                        .stroke({color: stroke, width: lineW * 1.2, alpha: 1});
                    pushRect({
                        id: blockId,
                        fileId,
                        kind: "ast-toggle",
                        x: hx,
                        y: hy,
                        w: handleSize,
                        h: handleSize,
                        area: handleSize * handleSize,
                    });
                }
            }

            function drawAstNode(node: TreemapNode, baseX: number, baseY: number, fileId: string, tree: TreemapLayout, selectionSet: ReadonlySet<string>): void {
                // Per-pass target shadowing — see drawAstContainer / drawOverlay
                // for the rationale. Every `worldGfx.*` / `labelPool.put` below
                // routes to the active layer (main during main pass, overlay
                // during overlay pass) automatically.
                const worldGfx = currentGfx;
                const labelPool = currentLabelPool;

                const x = baseX + node.rect.x;
                const y = baseY + node.rect.y;
                const wOnScreen = node.rect.w * cameraScale;
                const hOnScreen = node.rect.h * cameraScale;
                const minScreen = Math.min(wOnScreen, hOnScreen);
                if (minScreen < cfg.lod.cullPx) return;

                // Stroke a box as a rounded BRACKET — solid rounded left & right
                // sides with short serifs at each corner, OPEN at the top/bottom
                // middle. Shared by the function-definition parameter group and
                // the function-call outline (just different colours). Counter-
                // scaled to a constant ~1px on screen.
                const drawRoundedBracket = (gx: number, gy: number, w: number, h: number, color: number): void => {
                    const r = Math.min(7 / cameraScale, h / 3, w / 3);
                    const serif = Math.max(0, Math.min(10 / cameraScale, w / 2 - r - 2 / cameraScale));
                    const lw = 1 / cameraScale;
                    worldGfx
                        .moveTo(gx + r + serif, gy)
                        .lineTo(gx + r, gy)
                        .arcTo(gx, gy, gx, gy + r, r)
                        .lineTo(gx, gy + h - r)
                        .arcTo(gx, gy + h, gx + r, gy + h, r)
                        .lineTo(gx + r + serif, gy + h)
                        .stroke({color, width: lw, alpha: 1});
                    worldGfx
                        .moveTo(gx + w - r - serif, gy)
                        .lineTo(gx + w - r, gy)
                        .arcTo(gx + w, gy, gx + w, gy + r, r)
                        .lineTo(gx + w, gy + h - r)
                        .arcTo(gx + w, gy + h, gx + w - r, gy + h, r)
                        .lineTo(gx + w - r - serif, gy + h)
                        .stroke({color, width: lw, alpha: 1});
                };

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
                    drawAstContainer(node, x, y, container, fileId, tree, selectionSet);
                    return;
                }

                // Collapsed-leaf path: layoutAst's `collapseChildren` predicate
                // fired on this node (so its children were dropped at layout
                // time). Paint just the parent kind's outline — no label band,
                // no fill, no recursion. Hovering the cell brightens the outline
                // (alpha 1 + thicker stroke) so the user sees it's interactive;
                // clicking toggles it via handleClick.
                if (node.collapsed) {
                    const stroke = KIND_OUTLINE[node.syntaxKind] ?? liveTheme.colors.astBorder;
                    const isSelectedLeaf = selectionSet.has(node.id);
                    const isHovered = hoveredHit?.id === node.id;
                    // Collapsed exported cells (e.g. `export class Cat` when
                    // class is in EXPANDABLE_KINDS and renders as a single
                    // labelled cell) get the same amber export tint applied
                    // to regular non-collapsed cells in the default branch
                    // below. Without this, the cell renders with an effectively
                    // transparent fill (the original `stroke × alpha 0`) and
                    // the "this is exported" visual signal is lost.
                    const isCollapsedExport =
                        node.exported === true ||
                        node.syntaxKind === "ExportDeclaration" ||
                        node.syntaxKind === "ExportAssignment";
                    const collapsedFillColor = isCollapsedExport
                        ? blendColor(depthTint(node.depth), EXPORT_FILL_COLOR, EXPORT_FILL_BLEND)
                        : stroke;
                    const collapsedFillAlpha = isCollapsedExport
                        ? EXPORT_FILL_ALPHA
                        : isHovered ? 0.18 : 0;
                    worldGfx
                        .rect(x, y, node.rect.w, node.rect.h)
                        .fill({
                            color: collapsedFillColor,
                            // Hover gets a soft tint of the outline color so the cell
                            // reads as a button without changing the visual grammar.
                            // (Exported cells use the amber background instead — the
                            // hover affordance reads from the thicker outline below.)
                            alpha: collapsedFillAlpha,
                        })
                        .stroke({
                            color: isSelectedLeaf ? liveTheme.colors.astSelected : stroke,
                            width: (isHovered ? 2 : 1) / cameraScale,
                            alpha: 1,
                        });
                    pushRect({
                        id: node.id,
                        fileId,
                        kind: "ast",
                        x,
                        y,
                        w: node.rect.w,
                        h: node.rect.h,
                        area: node.rect.w * node.rect.h,
                    });
                    // Record the cell's world rect so any overlay built for this
                    // node (expanded later by the multi-pass loop) can anchor
                    // its top-left here. Restricted to EXPANDABLE_KINDS — other
                    // collapsed leaves don't get overlays.
                    if (isExpandableKind(node.syntaxKind)) {
                        blockCellsThisFrame.set(node.id, {
                            x,
                            y,
                            w: node.rect.w,
                            h: node.rect.h,
                        });
                    }
                    // If this collapsed cell has a kind label (e.g. '{}' for an
                    // ObjectLiteralExpression or a code Block) AND the cell is
                    // large enough on screen to fit it, draw the label centered.
                    // Both brace-delimited scopes read as `{}`; their KIND_OUTLINE
                    // colour (yellow object vs pink Block) is what tells them
                    // apart. Cells with no label (or too small for it) render as
                    // a bare outline. Same fits-on-screen gate as the regular-cell
                    // label below.
                    const collapsedLabel = labelFor(node);
                    if (collapsedLabel) {
                        const lb = labelScreenBox(collapsedLabel);
                        const f = astLabelOnScreenFactor(cameraScale);
                        if (wOnScreen >= lb.w * f && hOnScreen >= lb.h * f) {
                            const scale = astLabelScale(cameraScale);
                            const cy = y + node.rect.h / 2;
                            // `const entity` reads like an editor: the
                            // declaration keyword in keyword-blue, the declared
                            // name(s) in the variable colour. Drawn as two
                            // left-anchored segments, centered as a group so the
                            // cell still reads centered like the plain case.
                            const decl = node.syntaxKind === "VariableStatement" ? splitDeclarationKeyword(collapsedLabel) : null;
                            if (decl) {
                                const kwText = decl.keyword + " ";
                                const kwW = measureMono(kwText, 11).w;
                                const totalW = kwW + measureMono(decl.rest, 11).w;
                                let cx = x + node.rect.w / 2 - (totalW * scale) / 2;
                                labelPool.put({text: kwText, worldX: cx, worldY: cy, color: SYNTAX.keyword, size: 11, anchorX: 0, anchorY: 0.5, scale});
                                cx += kwW * scale;
                                labelPool.put({text: decl.rest, worldX: cx, worldY: cy, color: SYNTAX.variable, size: 11, anchorX: 0, anchorY: 0.5, scale});
                            } else {
                                labelPool.put({
                                    text: collapsedLabel,
                                    worldX: x + node.rect.w / 2,
                                    worldY: cy,
                                    color: syntaxColor(node),
                                    size: 11,
                                    anchorX: 0.5,
                                    anchorY: 0.5,
                                    scale,
                                });
                            }
                        }
                    }
                    return;
                }

                // Zoomed-out "simplified" tier: drop operators and generic kind
                // labels — keep only real names.
                const simplified = cameraScale < cfg.lod.simplifyBelow;

                // AST label scaling tier. Below the lock zoom, labels render
                // at WORLD scale (shrink as you zoom out, grow as you zoom
                // in); above the lock zoom, the label's on-screen size is
                // capped at AST_LABEL_MAX_SCREEN_SIZE. `labelOnScreenFactor`
                // converts a label's WORLD size (what labelScreenBox returns
                // — they're equal at 1:1 zoom) into its on-screen size at the
                // current zoom, for use in fits-on-screen gates.
                const labelScale = astLabelScale(cameraScale);
                const labelOnScreenFactor = astLabelOnScreenFactor(cameraScale);

                const isSelected = selectionSet.has(node.id);
                const tint = depthTint(node.depth);
                // Per-kind tint blend: gives certain kinds (imports
                // today; could grow over time) a distinct background
                // hue so the kind reads at a glance without needing an
                // explicit text label. Selection is still shown via
                // the outline, not the fill.
                //
                // Exported nodes (the `exported` flag is true for
                // `export class/interface/const/...` and the
                // ExportDeclaration / ExportAssignment statement
                // kinds) get the amber export tint AND a reduced
                // fill alpha — see EXPORT_FILL_* up top. The lower
                // alpha is the "semi-transparent overlay" so the
                // file's circle boundary stays visible THROUGH the
                // part of the rect sitting on the border.
                const kindTint = KIND_FILL_TINT[node.syntaxKind];
                const isExportNode =
                    !kindTint &&
                    (node.exported === true ||
                        node.syntaxKind === "ExportDeclaration" ||
                        node.syntaxKind === "ExportAssignment");
                let fillColor: number;
                if (kindTint) {
                    fillColor = blendColor(tint, kindTint.color, kindTint.blend);
                } else if (isExportNode) {
                    fillColor = blendColor(tint, EXPORT_FILL_COLOR, EXPORT_FILL_BLEND);
                } else {
                    fillColor = tint;
                }
                const fillAlpha = isExportNode ? EXPORT_FILL_ALPHA : DEFAULT_FILL_ALPHA;
                // A call/new argument is a "parameter block for a call" — style it
                // like a function `Parameter` (light-blue outline + rounded).
                const argParent = node.parentId ? tree.byId.get(node.parentId) : undefined;
                const isCallArg = argParent?.syntaxKind === "CallExpression" || argParent?.syntaxKind === "NewExpression";
                const paramLike = node.syntaxKind === "Parameter" || isCallArg;
                // A parameter inside a function definition draws NO box of its
                // own — the function's parameter GROUP carries the (open-topped,
                // rounded) bracket border, so each param is just a borderless
                // `name: Type` text chip inside it (see functionLayout + the
                // groupRect bracket below). Call arguments keep their own box.
                const inFnGroup = node.syntaxKind === "Parameter" && argParent != null && isFunctionSignatureKind(argParent.syntaxKind);
                // Kind outlines have their own (much lower) zoom threshold so they
                // reappear well before the rest of the detail does. A call argument
                // with no outline of its own gets the parameter light-blue.
                const kindOutline = cameraScale < cfg.lod.outlineBelow ? undefined : (KIND_OUTLINE[node.syntaxKind] ?? (isCallArg ? liveTheme.colors.astOutlineParam : undefined));
                // Abstract definitions AND interfaces get a green dashed outline
                // (TS interfaces aren't flagged `abstract` but are abstract by
                // nature). Same zoom gate as the kind outlines.
                const abstractOutline = (!!node.abstract || node.syntaxKind === "InterfaceDeclaration") && cameraScale >= cfg.lod.outlineBelow;
                // An abstract *function* (method/accessor) reads differently from an
                // abstract class/interface: grey + dotted instead of green + dashed.
                const abstractFn = !!node.abstract && (node.syntaxKind === "MethodDeclaration" || node.syntaxKind === "GetAccessor" || node.syntaxKind === "SetAccessor");
                // A concrete class gets the same green, but SOLID (abstract classes
                // hit the dashed branch above first, so this is non-abstract only).
                const classOutline = (node.syntaxKind === "ClassDeclaration" || node.syntaxKind === "ClassExpression") && cameraScale >= cfg.lod.outlineBelow;
                // A concrete function definition gets the same grey, but SOLID
                // (abstract functions hit the dotted branch above first).
                const fnOutline =
                    (node.syntaxKind === "FunctionDeclaration" ||
                        node.syntaxKind === "FunctionExpression" ||
                        node.syntaxKind === "ArrowFunction" ||
                        node.syntaxKind === "MethodDeclaration" ||
                        node.syntaxKind === "GetAccessor" ||
                        node.syntaxKind === "SetAccessor") &&
                    cameraScale >= cfg.lod.outlineBelow;
                // Constructor: white box outline + a white wrench badge inside, on
                // the same cheap-cue zoom gate as the kind outlines.
                const isCtor = node.syntaxKind === "Constructor" && cameraScale >= cfg.lod.outlineBelow;
                // Array destructuring pattern — its box is stroked as a pair of
                // square brackets (left/right verticals + corner serifs) rather
                // than a full rect, so it reads as `[ … ]`. Same zoom gate as the
                // other kind outlines; colour/width come from the KIND_OUTLINE
                // branch below (ArrayBindingPattern is listed there).
                const bracketOutline = isBracketKind(node.syntaxKind) && cameraScale >= cfg.lod.outlineBelow;
                // Function CALL / `new`: frame the box with the same rounded
                // brace as a function definition's parameter group, but YELLOW —
                // the interior (args, nested calls, expandable sections) renders
                // exactly as before; only the border style changes.
                const callBracket = (node.syntaxKind === "CallExpression" || node.syntaxKind === "NewExpression") && cameraScale >= cfg.lod.outlineBelow;
                let borderColor: number = liveTheme.colors.astBorder;
                let borderWidth = 0.5;
                let borderAlpha = 0.9;
                if (isSelected) {
                    // Selection blue as a thick outline, not a background recolor.
                    borderColor = liveTheme.colors.astSelected;
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
                    borderColor = abstractFn ? liveTheme.colors.astOutlineAbstractFn : liveTheme.colors.astOutlineAbstract;
                    borderWidth = 1 / cameraScale;
                    borderAlpha = 1;
                } else if (classOutline) {
                    // Solid green — same color as the class name, not dashed.
                    borderColor = SYNTAX.type;
                    borderWidth = 1 / cameraScale;
                    borderAlpha = 1;
                } else if (isCtor) {
                    borderColor = liveTheme.colors.astSelectedBorder; // white
                    borderWidth = 1 / cameraScale;
                    borderAlpha = 1;
                } else if (fnOutline) {
                    // Solid grey — same color as an abstract function, but not dotted.
                    borderColor = liveTheme.colors.astOutlineAbstractFn;
                    borderWidth = 1 / cameraScale;
                    borderAlpha = 1;
                }
                // Parameters (and call arguments — parameter blocks for a call) get
                // just-slightly-rounded corners, a subtle nod to the round brackets
                // a parameter list lives in — small enough the label stays inside.
                if (callBracket) {
                    // Fill only — NO whole-box border. The yellow brace is drawn
                    // around just the ARGUMENT region below (see the call-args
                    // bracket block after this chain), so the callee label sits
                    // above an open `▷ foo ( args )` brace. Checked first so a
                    // nested call (also a call-arg) gets its own brace, not the
                    // borderless arg treatment below.
                    worldGfx.rect(x, y, node.rect.w, node.rect.h).fill({color: fillColor, alpha: fillAlpha});
                } else if (inFnGroup || isCallArg) {
                    // No box. Function-definition params are framed by the
                    // parameter-group brace; call arguments by the call's yellow
                    // argument brace. Either way each is a borderless chip — no
                    // individual light-blue box around it.
                } else if (paramLike) {
                    // Remaining param-likes: constructor / accessor parameters
                    // (functions not yet laid out as a group). Keep the rounded
                    // light-blue box.
                    const radius = Math.min(
                        4 / cameraScale, // ~4px on screen — a gentle curve, not a pill
                        Math.min(node.rect.w, node.rect.h) / 2,
                    );
                    worldGfx.roundRect(x, y, node.rect.w, node.rect.h, radius).fill({color: fillColor, alpha: fillAlpha});
                    // Same outside-stroke trick as the default branch below —
                    // the thick selection border would otherwise eat the label
                    // inset.
                    const outset = isSelected ? borderWidth / 2 : 0;
                    worldGfx
                        .roundRect(x - outset, y - outset, node.rect.w + outset * 2, node.rect.h + outset * 2, radius + outset)
                        .stroke({color: borderColor, width: borderWidth, alpha: borderAlpha});
                } else if (bracketOutline) {
                    // Fill, then stroke ONLY the square-bracket strokes: full
                    // left & right verticals plus a short serif at each corner,
                    // leaving the middle of the top/bottom edges open so the box
                    // reads as `[ … ]`. Serif is a quarter of the width, capped
                    // so it stays short (bracket-like) on wide boxes.
                    const w = node.rect.w;
                    const h = node.rect.h;
                    worldGfx.rect(x, y, w, h).fill({color: fillColor, alpha: fillAlpha});
                    const serif = Math.min(w / 4, 12 / cameraScale);
                    worldGfx
                        .moveTo(x, y).lineTo(x, y + h) // left vertical
                        .moveTo(x + w, y).lineTo(x + w, y + h) // right vertical
                        .moveTo(x, y).lineTo(x + serif, y) // top-left serif
                        .moveTo(x + w - serif, y).lineTo(x + w, y) // top-right serif
                        .moveTo(x, y + h).lineTo(x + serif, y + h) // bottom-left serif
                        .moveTo(x + w - serif, y + h).lineTo(x + w, y + h) // bottom-right serif
                        .stroke({color: borderColor, width: borderWidth, alpha: borderAlpha});
                } else if (abstractOutline) {
                    // Abstract definition: dashed/dotted box outline. Abstract
                    // functions get a fine dotted pattern; abstract classes/interfaces
                    // the extends-style dash. Fill first, then stroke the perimeter.
                    const w = node.rect.w;
                    const h = node.rect.h;
                    worldGfx.rect(x, y, w, h).fill({color: fillColor, alpha: fillAlpha});
                    const dash = (abstractFn ? 1.2 : 3.5) / cameraScale;
                    const dgap = (abstractFn ? 2.4 : 2.5) / cameraScale;
                    emitDashed(
                        worldGfx,
                        [
                            {x, y},
                            {x: x + w, y},
                            {x: x + w, y: y + h},
                            {x, y: y + h},
                            {x, y},
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
                    worldGfx.rect(x, y, node.rect.w, node.rect.h).fill({color: fillColor, alpha: fillAlpha});
                    // Selection's thick blue border (FILE_RIM/2 ≈ 5 world)
                    // is centered on the edge by default — half outside, half
                    // INSIDE the rect, which covers the label area (3px screen
                    // inset). Outset the stroke so the entire border sits
                    // OUTSIDE the rect, like a CSS `outline`. Other border
                    // styles (kind outline at 1px, function/class etc.) are
                    // thin enough that the centered stroke doesn't reach the
                    // label, so they're drawn on the rect's edge as before.
                    const outset = isSelected ? borderWidth / 2 : 0;
                    worldGfx.rect(x - outset, y - outset, node.rect.w + outset * 2, node.rect.h + outset * 2).stroke({color: borderColor, width: borderWidth, alpha: borderAlpha});
                }

                // Parameter-group bracket (function definitions): a rounded
                // border around the param chips, OPEN at the top/bottom middle
                // — solid rounded left & right sides with short serifs at each
                // corner — so the whole parameter list reads as one block, like
                // an array `[ … ]` but rounded. Drawn from the function's
                // groupRect (world via baseX/baseY); same zoom gate + light-blue
                // param colour as the other kind outlines.
                if (node.groupRect && cameraScale >= cfg.lod.outlineBelow) {
                    const g = node.groupRect;
                    drawRoundedBracket(baseX + g.x, baseY + g.y, g.w, g.h, liveTheme.colors.astOutlineParam);
                }

                // Function-call ARGUMENT bracket: a yellow rounded brace around
                // ONLY the argument region (the call's children bounding box),
                // not the whole call box — so it reads `▷ callee ( args )` with
                // the callee label above an open brace. The interior layout is
                // untouched (calls can hold nested logic / expandable sections).
                if (callBracket) {
                    const argKids = tree.childrenByParent.get(node.id);
                    if (argKids && argKids.length) {
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        for (const k of argKids) {
                            if (k.rect.x < minX) minX = k.rect.x;
                            if (k.rect.y < minY) minY = k.rect.y;
                            if (k.rect.x + k.rect.w > maxX) maxX = k.rect.x + k.rect.w;
                            if (k.rect.y + k.rect.h > maxY) maxY = k.rect.y + k.rect.h;
                        }
                        const pad = 5 / cameraScale;
                        drawRoundedBracket(
                            baseX + minX - pad,
                            baseY + minY - pad,
                            maxX - minX + pad * 2,
                            maxY - minY + pad * 2,
                            isSelected ? liveTheme.colors.astSelected : liveTheme.colors.astOutlineObject,
                        );
                    }
                }

                pushRect({
                    id: node.id,
                    fileId,
                    kind: "ast",
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
                    const bandH = labelScreenBox("").h;
                    const gx = x + node.rect.w / 2 - s / 2;
                    const gy = y + bandH / 2 - s / 2;
                    const lw = 1.2 / cameraScale; // outline stroke, ~constant on screen
                    const col = liveTheme.colors.astSelectedBorder; // white
                    // Handle: lower-left → up toward the head.
                    worldGfx
                        .moveTo(gx + s * 0.12, gy + s * 0.9)
                        .lineTo(gx + s * 0.58, gy + s * 0.44)
                        .stroke({color: col, width: lw, alpha: 1});
                    // Open-ring head (a spanner jaw): ~300° arc with a gap.
                    const hcx = gx + s * 0.68;
                    const hcy = gy + s * 0.32;
                    const hr = s * 0.26;
                    const a0 = -0.15 * Math.PI;
                    const a1 = 1.55 * Math.PI;
                    worldGfx
                        .moveTo(hcx + hr * Math.cos(a0), hcy + hr * Math.sin(a0))
                        .arc(hcx, hcy, hr, a0, a1)
                        .stroke({color: col, width: lw, alpha: 1});
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
                // Draw the header as colored segments — name (type), prefixed by
                // any modifiers in keyword colour, optionally suffixed by
                // " extends Base" (keyword + type). Used in place of the
                // single-color put whenever the label needs more than one
                // colour. Source order: "[private] [static] [readonly] Name
                // [extends Base]".
                const segScale = labelScale;
                const modifierPrefix = composeModifierPrefix(node);
                const drawHeaderSegments = (startX: number, midY: number, centered: boolean): void => {
                    const segs: {t: string; c: number}[] = [];
                    if (modifierPrefix) {
                        segs.push({t: modifierPrefix + " ", c: SYNTAX.keyword});
                    }
                    segs.push({t: node.name ?? "", c: syntaxColor(node)});
                    if (node.extendsName != null) {
                        segs.push({t: " extends ", c: SYNTAX.keyword});
                        segs.push({t: node.extendsName, c: SYNTAX.type});
                    }
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
                // Generic multi-colour label: draw `segs` left-to-right (as a
                // centered group when `centered`). Used for the `▷ callee` call
                // marker (triangle keyword-blue, callee in its own colour) so it
                // matches the `ƒ` definition icon.
                const drawSegments = (segs: {t: string; c: number}[], startX: number, midY: number, centered: boolean): void => {
                    let total = 0;
                    for (const s of segs) total += measureMono(s.t, 11).w;
                    let cx = centered ? startX - (total * segScale) / 2 : startX;
                    for (const s of segs) {
                        if (!s.t) continue;
                        labelPool.put({text: s.t, worldX: cx, worldY: midY, color: s.c, size: 11, anchorX: 0, anchorY: centered ? 0.5 : 0, scale: segScale});
                        cx += measureMono(s.t, 11).w * segScale;
                    }
                };
                const composite = node.extendsName != null && node.name != null;
                // The " extends Base" suffix and the modifier keywords are
                // non-name detail; both drop in the simplified tier along
                // with operators/kind labels — just the name. The multi-colour
                // header path runs whenever EITHER of them is present (and
                // we're above simplified).
                const showExtends = composite && !simplified;
                const showModifiers = modifierPrefix.length > 0 && !simplified;
                const useSegments = showExtends || showModifiers;
                const labelText = labelFor(node);
                const labelBox = labelText ? labelScreenBox(labelText) : null;
                // (CallExpression labels arrive from the server as `▷ <callee>` —
                // the triangle is a literal character in the label, so we don't
                // need a polygon path or a separate callee/glyph split anymore.
                // The standard labelPool.put paths below render the whole thing
                // as one text run in syntaxColor(node).)
                // In the simplified tier only real names (and name-like kinds such
                // as import/return) survive — other generic kind labels (type / if /
                // => / call / access …) drop out.
                const nameOk = !simplified || node.name != null || NAME_LIKE_KINDS.has(node.syntaxKind);
                if (node.labelChip && labelText && labelBox && nameOk) {
                    // Relational left operand (e.g. `i` in `let i = j`): the name is
                    // drawn centered in its reserved chip, not as a top-of-box label.
                    const chip = node.labelChip;
                    if (chip.w * cameraScale >= labelBox.w * labelOnScreenFactor && chip.h * cameraScale >= labelBox.h * labelOnScreenFactor) {
                        labelPool.put({
                            text: labelText,
                            worldX: baseX + chip.x + chip.w / 2,
                            worldY: baseY + chip.y + chip.h / 2,
                            color: syntaxColor(node),
                            size: 11,
                            anchorX: 0.5,
                            anchorY: 0.5,
                            scale: labelScale,
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
                    (isHighLevel(node) || (wOnScreen >= labelBox.w * labelOnScreenFactor && hOnScreen >= labelBox.h * labelOnScreenFactor))
                ) {
                    const parent = node.parentId ? tree.byId.get(node.parentId) : null;
                    const parentLabel = parent ? labelFor(parent) : null;
                    if (parentLabel !== labelText) {
                        // In the simplified tier the multi-colour header collapses
                        // to just the name (labelText is a narrowed string in this
                        // block). Drops the modifier prefix AND the " extends Base"
                        // suffix in one step. A property key keeps its `:` though —
                        // that's part of the definition, not droppable detail — so
                        // mirror labelFor's colon rule here instead of bare name.
                        const headerText =
                            simplified && node.name
                                ? node.syntaxKind === "PropertyAssignment"
                                    ? `${node.name}:`
                                    : node.name
                                : labelText;
                        const hasKids = !!tree.childrenByParent.get(node.id)?.length;
                        if (hasKids) {
                            // Expanded brace-label containers (`{}` object/type
                            // literals, `[]` array literals, blocks) draw NO
                            // header: the kind outline already conveys the braces
                            // and the layout reserved no band for them (see
                            // labelBandless), so members sit at the top of the
                            // box. Drawing the label here would overprint them.
                            if (isBraceLabelKind(node.syntaxKind)) {
                                /* no header — outline conveys the braces */
                            } else if (node.syntaxKind === "ArrowFunction") {
                                // Arrow function: same two-column body as named
                                // functions, but the header is just the `⇒` marker
                                // (keyword-blue, sized to match ƒ/▷) — the binding's
                                // name, if any, lives on the enclosing const.
                                labelPool.put({text: "⇒", worldX: x + 4 / cameraScale, worldY: y + 3 / cameraScale, color: SYNTAX.keyword, size: ARROW_GLYPH_SIZE, anchorX: 0, anchorY: 0, scale: labelScale});
                            } else if (isFunctionSignatureKind(node.syntaxKind)) {
                                // `ƒ [modifiers] name` header for a function /
                                // method definition: the ƒ marker (keyword-blue)
                                // ALWAYS shows so a function is unmistakable in
                                // every zoom tier; modifiers (`static`…) ride along
                                // in keyword-blue when not simplified; the name in
                                // func-yellow. The signature flow —
                                // ( params ) : ReturnType — is the glyph loop below.
                                // Uses node.name (not headerText) for the name so
                                // modifiers aren't doubled (labelFor folds them in).
                                const fsegs: {t: string; c: number}[] = [{t: "ƒ ", c: SYNTAX.keyword}];
                                if (showModifiers && modifierPrefix) fsegs.push({t: modifierPrefix + " ", c: SYNTAX.keyword});
                                if (node.name) fsegs.push({t: node.name, c: syntaxColor(node)});
                                let fcx = x + 4 / cameraScale;
                                const fy = y + 3 / cameraScale;
                                for (const s of fsegs) {
                                    labelPool.put({text: s.t, worldX: fcx, worldY: fy, color: s.c, size: 11, anchorX: 0, anchorY: 0, scale: labelScale});
                                    fcx += measureMono(s.t, 11).w * labelScale;
                                }
                            } else if (useSegments) {
                                // Container: the label titles the children, top-left.
                                drawHeaderSegments(x + 4 / cameraScale, y + 3 / cameraScale, false);
                            } else {
                                // Function CALL (`▷ callee`): the triangle marker
                                // in keyword-blue (matching the ƒ icon), callee in
                                // its own colour. Other labels: single colour.
                                const call = node.syntaxKind === "CallExpression" ? splitCallMarker(headerText) : null;
                                if (call) {
                                    drawSegments([{t: call.marker, c: SYNTAX.keyword}, {t: call.rest, c: syntaxColor(node)}], x + 4 / cameraScale, y + 3 / cameraScale, false);
                                } else {
                                    labelPool.put({
                                        text: headerText,
                                        worldX: x + 4 / cameraScale,
                                        worldY: y + 3 / cameraScale,
                                        color: syntaxColor(node),
                                        // The lone `⇒` arrow-function glyph reads
                                        // smaller than the ƒ / ▷ markers at 11px,
                                        // so bump it to sit at the same visual size.
                                        size: node.syntaxKind === "ArrowFunction" ? ARROW_GLYPH_SIZE : 11,
                                        anchorX: 0,
                                        anchorY: 0,
                                        scale: labelScale,
                                    });
                                }
                            }
                        } else if (useSegments) {
                            // Leaf class (empty body) OR modifier-only leaf:
                            // centered multi-colour header.
                            drawHeaderSegments(x + node.rect.w / 2, y + node.rect.h / 2, true);
                        } else {
                            // Leaf / value. A parameter chip reads `name: Type`
                            // two-toned — name in the variable colour, type in
                            // teal, like an editor (the type was baked into the
                            // name server-side, so it survives the simplified
                            // tier). Everything else is a single-colour centered
                            // label (an operand like `20`, `i`, `j`).
                            const paramSplit = node.syntaxKind === "Parameter" ? splitTypeAnnotation(headerText) : null;
                            if (paramSplit) {
                                const sep = ": ";
                                const nameW = measureMono(paramSplit.name, 11).w;
                                const sepW = measureMono(sep, 11).w;
                                const typeW = measureMono(paramSplit.type, 11).w;
                                const cyc = y + node.rect.h / 2;
                                let cxc = x + node.rect.w / 2 - ((nameW + sepW + typeW) * labelScale) / 2;
                                labelPool.put({text: paramSplit.name, worldX: cxc, worldY: cyc, color: SYNTAX.variable, size: 11, anchorX: 0, anchorY: 0.5, scale: labelScale});
                                cxc += nameW * labelScale;
                                labelPool.put({text: sep, worldX: cxc, worldY: cyc, color: SYNTAX.default, size: 11, anchorX: 0, anchorY: 0.5, scale: labelScale});
                                cxc += sepW * labelScale;
                                labelPool.put({text: paramSplit.type, worldX: cxc, worldY: cyc, color: SYNTAX.type, size: 11, anchorX: 0, anchorY: 0.5, scale: labelScale});
                            } else {
                                // No-arg function CALL (`▷ callee`): triangle in
                                // keyword-blue, callee in its colour, centered.
                                const call = node.syntaxKind === "CallExpression" ? splitCallMarker(headerText) : null;
                                if (call) {
                                    drawSegments([{t: call.marker, c: SYNTAX.keyword}, {t: call.rest, c: syntaxColor(node)}], x + node.rect.w / 2, y + node.rect.h / 2, true);
                                } else {
                                    labelPool.put({
                                        text: headerText,
                                        worldX: x + node.rect.w / 2,
                                        worldY: y + node.rect.h / 2,
                                        color: syntaxColor(node),
                                        size: node.syntaxKind === "ArrowFunction" ? ARROW_GLYPH_SIZE : 11,
                                        anchorX: 0.5,
                                        anchorY: 0.5,
                                        scale: labelScale,
                                    });
                                }
                            }
                        }
                    }
                }

                // Inline syntax glyphs, drawn centered between/around the operand
                // boxes: a BinaryExpression's operator (`[i] = [j]`), a ternary's
                // `?`/`:`, and a templated construct's keyword sequence
                // (`for [x] of [items]`, `case [v] :`). Counter-scaled so each
                // stays a constant on-screen size and gated only on fitting its
                // box — these carry the same semantic weight as the names they sit
                // between (the `=` is what makes `[i] [j]` an assignment; the `for`
                // and `of` are what make the loop a loop), so they survive the
                // simplified-tier drop as long as there's room. A glyph's own
                // `color` wins (control keywords render pink); operators and
                // punctuation fall back to the default foreground.
                if (node.glyphs) {
                    for (const g of node.glyphs) {
                        // A glyph may carry its own size (e.g. the 2× return
                        // symbol); default to the normal label size. It always
                        // counter-scales by labelScale, so it scales WITH the
                        // other labels/blocks at every zoom.
                        const gSize = g.size ?? AST_LABEL_FONT;
                        // Normal glyphs hide when they no longer fit their box on
                        // screen. Explicitly-sized glyphs are important (the
                        // return symbol) — skip that gate so they stay visible as
                        // long as the node is drawn, rather than vanishing at a
                        // zoom-out threshold while surrounding text is still shown.
                        if (g.size == null) {
                            const gBox = labelScreenBox(g.text);
                            if (wOnScreen < gBox.w * labelOnScreenFactor || hOnScreen < gBox.h * labelOnScreenFactor) {
                                continue;
                            }
                        }
                        labelPool.put({
                            text: g.text,
                            worldX: baseX + g.anchor.x,
                            worldY: baseY + g.anchor.y,
                            color: g.color ?? SYNTAX.default,
                            size: gSize,
                            anchorX: 0.5,
                            anchorY: 0.5,
                            scale: labelScale,
                        });
                    }
                }

                const kids = tree.childrenByParent.get(node.id);
                if (!kids) return;
                for (const k of kids) {
                    drawAstNode(k, baseX, baseY, fileId, tree, selectionSet);
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
                // File follows re-capture each frame while the sim is
                // still settling — applyExpansion bumps the sim's alpha
                // to 0.9, so collision forces push the freshly-expanded
                // file around for many frames after the trigger.
                // Snapshotting once would leave the camera lerping to a
                // stale position while the file drifts away (the user
                // saw expansions land bottom-right of centre). AST-node
                // follows still snapshot once because their target's
                // world position doesn't drift after the click.
                const isFileFollow = !followId.includes("#");
                const simSettling = layout.simulation.alpha() > layout.simulation.alphaMin();
                if (followAt === null || (isFileFollow && simSettling)) {
                    const simNode = layout.byId.get(followId);
                    if (simNode) {
                        followAt = {x: simNode.x, y: simNode.y};
                    } else if (followAt === null) {
                        const r = visibleById.get(followId) ?? findVisibleAnchor(followId, visibleById, activeTree);
                        if (!r) return; // not resolvable yet — try again next frame
                        // Code blocks anchor at their TOP-LEFT, not their centre:
                        // an expanded Block overlay reads top-down / left-to-right
                        // (it's a code statement, not a circular node), and the
                        // overlay can be substantially larger than the viewport.
                        // Centering its bounds would push the start of the code
                        // off-screen up-left; anchoring at the top-left puts the
                        // start of the statement at screen centre so the user can
                        // read down from there.
                        const isBlock =
                            followId.includes("#") &&
                            useGraphStore
                                .getState()
                                .asts.get(fileIdOfAstId(followId))
                                ?.nodes.find((n) => n.id === followId)?.syntaxKind === "Block";
                        followAt = isBlock ? {x: r.x, y: r.y} : {x: r.x + r.w / 2, y: r.y + r.h / 2};
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
                if (Math.abs(targetX - world.x) < 0.5 && Math.abs(targetY - world.y) < 0.5) {
                    world.x = targetX;
                    world.y = targetY;
                    followId = null; // centered & settled — release the camera
                    followAt = null;
                }
            }

            // If a file's expanded footprint doesn't fit at the current zoom,
            // schedule a smooth zoom-OUT (never zoom in) so it lands at
            // ~75% of the viewport on its constraining axis — i.e. the
            // file's larger-dimension takes up 75% of the corresponding
            // screen dimension, leaving 12.5% of breathing room on each
            // side. Re-engages the follow on the file so the pan and the
            // zoom converge together; the click handler set followId
            // earlier against the collapsed-size sim node, but the AST
            // fetch's async tail completes well after that pan has already
            // settled and released the camera — so by the time we land
            // here, no follow is in flight.
            // (fitFileInViewport was removed alongside the click-driven
            // expansion path — clicks no longer expand or auto-fit a file.
            // The zoomFit lerp mechanism below is dormant for now; we leave
            // it in place so an "auto-fit selection on Cmd-K navigation" or
            // similar can re-engage it later.)

            // Lerp world.scale toward zoomFit.targetScale, pivoting around
            // zoomFit.pivot (a fixed world point). Compensating world.x/y
            // each tick keeps the pivot at the same SCREEN position so the
            // file appears to shrink in place rather than drift toward the
            // world origin during the animation.
            function updateZoomFit(): void {
                if (zoomFit === null) return;
                const current = world.scale.x;
                const target = zoomFit.targetScale;
                // Where is the pivot on screen right now?
                const pivotScreenX = world.x + zoomFit.pivot.x * current;
                const pivotScreenY = world.y + zoomFit.pivot.y * current;
                const diff = target - current;
                if (Math.abs(diff) < 0.0005) {
                    // Snap final values so the animation ends crisply.
                    world.scale.set(target);
                    cameraScale = target;
                    world.x = pivotScreenX - zoomFit.pivot.x * target;
                    world.y = pivotScreenY - zoomFit.pivot.y * target;
                    zoomFit = null;
                    return;
                }
                const next = current + diff * 0.12;
                world.scale.set(next);
                cameraScale = next;
                world.x = pivotScreenX - zoomFit.pivot.x * next;
                world.y = pivotScreenY - zoomFit.pivot.y * next;
            }

            // --- Layout: connectivity sim ↔ rigid folder outline --------------
            //
            // Two layouts coexist. The d3-force sim produces the
            // CONNECTIVITY layout (stored per node in connX/connY). The
            // deterministic folder outline produces the RIGID layout
            // (rigidX/rigidY, normalised into the connectivity bbox by
            // assignRigidPositions). Each frame, the rendered position
            // node.x/node.y is lerp(connectivity, rigid) by a zoom-derived
            // amount — fully rigid when zoomed out, fully connectivity
            // when zoomed in. Everything downstream (draw, hulls, edges,
            // hit-testing) reads node.x/node.y and so sees the blend for
            // free.

            // Copy the sim's current positions into connX/connY.
            function snapshotConn(): void {
                for (const n of layout.nodes) {
                    n.connX = n.x;
                    n.connY = n.y;
                }
            }

            // Bounding box of the connectivity layout (connX/connY).
            function connBounds(): {
                minX: number;
                minY: number;
                maxX: number;
                maxY: number;
            } {
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (const n of layout.nodes) {
                    if (n.connX < minX) minX = n.connX;
                    if (n.connY < minY) minY = n.connY;
                    if (n.connX > maxX) maxX = n.connX;
                    if (n.connY > maxY) maxY = n.connY;
                }
                if (!Number.isFinite(minX)) {
                    return {minX: 0, minY: 0, maxX: 1, maxY: 1};
                }
                return {minX, minY, maxX, maxY};
            }

            // Centroid of the connectivity layout — where assignRigidPositions
            // anchors the rigid folder layout.
            function connCentre(): {x: number; y: number} {
                const b = connBounds();
                return {x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2};
            }

            // Camera zoom → rigid-layout blend amount. 1 = positions snap
            // fully to the deterministic folder outline; 0 = pure
            // force-directed connectivity layout.
            //
            // The zoom→blend transition is now expressed by the configured
            // tiers' zoom ranges (multiples of fitScale) and computed by the
            // TierEngine (see tierLayout.ts / activeTiers). It is RELATIVE to
            // fitScale — the zoom the auto-fit chose at project open — so a big
            // project (tiny fitScale) and a small one (large fitScale) get the
            // same transition reachable by a moderate zoom-in. The default
            // config reproduces the old 1.5×–4.5× band; log-space + smoothstep
            // for an ease-in-out feel live in activeTiers().

            // --- Overlap relaxation -------------------------------------------
            //
            // lerp(connectivity, rigid) is not overlap-free even though
            // each layout is: at an intermediate blend two files can land
            // on top of each other, and the rigid grid has no knowledge of
            // EXPANDED file sizes so any rigid blend drags neighbours under
            // an open file. relaxOverlaps pushes intersecting file boxes
            // apart along their axis of least penetration; stepLayout runs
            // it for a few iterations each frame and records the net push
            // as a per-node offset that decays back toward zero once the
            // overlap clears. So it costs ~nothing when nothing overlaps,
            // and animates files out of the way when something does.
            const OVERLAP_PAD = 12; // min whitespace kept between file boxes
            const OVERLAP_ITERS = 6; // max relaxation passes per frame
            // Per-frame decay of the offset. 0.9 (not lower): with the
            // rigid layout now kept partly active while a file is open
            // (RIGID_OPEN_BLEND), an open file's neighbours sit under a
            // deeper rigid pull, so the decay must stay gentle enough that
            // the relax pass out-pushes it rather than the offset eroding
            // faster than it can be re-established.
            const OVERLAP_DECAY = 0.9;
            // Per-node, per-iteration push cap. Small overlaps (two
            // collapsed files, penetration < ~500) resolve in one
            // iteration as before; only a pathological deep overlap gets
            // rate-limited, so a file emerging from under a big box
            // animates out over a few frames instead of teleporting.
            const OVERLAP_PUSH_CAP = 250;
            // Under-relaxation factor for the Jacobi solver below: each
            // iteration applies this fraction of the accumulated push.
            // 0.7 is a standard SOR-style choice — fast enough that 6
            // iterations resolve simple overlaps to <0.1% residual,
            // damped enough that infeasible configurations (a small
            // file squeezed between two overlapping expanded blocks,
            // for example) stop oscillating per-iteration. Lower values
            // settle even more smoothly but take longer to push files
            // out of newly-expanded blocks.
            const RELAX_DAMP = 0.7;

            // Buffers for the Jacobi solver — sized to layout.nodes.length
            // at startup. Re-used across frames so we don't allocate in
            // the hot path.
            let relaxPushX: Float64Array = new Float64Array(layout.nodes.length);
            let relaxPushY: Float64Array = new Float64Array(layout.nodes.length);

            // Jacobi-style overlap relaxation. Each iteration:
            //   1. Accumulate the desired push for every node based on
            //      CURRENT positions (no in-place writes during the
            //      sweep).
            //   2. Apply the accumulated push, scaled by RELAX_DAMP.
            // The previous Gauss-Seidel version applied each pair's
            // push immediately, which is fine when overlaps are
            // resolvable but oscillates when a node is squeezed
            // between two-or-more obstacles whose constraints can't
            // all be satisfied: each iteration shoved the node back
            // and forth as pairs were processed in order. Jacobi sums
            // opposing pushes so the net movement reflects the
            // node's REAL escape direction — and is zero (stable!)
            // when constraints are perfectly antisymmetric, instead
            // of order-dependent jitter.
            function relaxOverlaps(nodes: SimFileNode[]): boolean {
                const n = nodes.length;
                // The buffers were sized for the initial node count;
                // re-grow them if the simulation ever adds nodes.
                if (relaxPushX.length < n) {
                    relaxPushX = new Float64Array(n);
                    relaxPushY = new Float64Array(n);
                }
                relaxPushX.fill(0, 0, n);
                relaxPushY.fill(0, 0, n);

                for (let i = 0; i < n; i++) {
                    const a = nodes[i];
                    for (let j = i + 1; j < n; j++) {
                        const b = nodes[j];
                        // Expanded files are IMMOVABLE here: the user is
                        // working INSIDE one, and a shifting expanded file
                        // makes its small interior nodes impossible to
                        // click. The other node in the pair absorbs the
                        // whole separation. Two expanded files: skip — no
                        // push is useful (both are pinned at sim level).
                        //
                        // User-pinned files share the same treatment for
                        // a different reason: the pin coordinate IS the
                        // rendered position (ntFor returns 0, so no
                        // rigid-blend lerp), and letting overlap-relax
                        // push a pinned file off that coordinate would
                        // break the "stays put regardless of zoom"
                        // promise.
                        const aMov = a.expanded || a.userPinned ? 0 : 1;
                        const bMov = b.expanded || b.userPinned ? 0 : 1;
                        const tot = aMov + bMov;
                        if (tot === 0) continue;
                        const aShare = aMov / tot;
                        const bShare = bMov / tot;

                        if (isCircular(a) || isCircular(b)) {
                            // At least one side is currently drawn as a
                            // CIRCLE — either fully expanded OR animating
                            // through an expand/collapse. d3-force's
                            // collide uses circle-vs-circle in the same
                            // condition (see collisionRadius in
                            // layout.ts), so the two systems agree on
                            // where the boundary is.
                            const ra = circleRadiusFor(a);
                            const rb = circleRadiusFor(b);
                            const dx = b.x - a.x;
                            const dy = b.y - a.y;
                            const dist2 = dx * dx + dy * dy;
                            const minD = ra + rb + OVERLAP_PAD;
                            if (dist2 >= minD * minD) continue;
                            // Tiny dist guard so the unit vector is finite
                            // when two circles are exactly concentric.
                            const dist = Math.sqrt(dist2) || 0.001;
                            const sep = minD - dist;
                            const ux = dx / dist;
                            const uy = dy / dist;
                            const am = sep * aShare;
                            const bm = sep * bShare;
                            relaxPushX[i] -= ux * am;
                            relaxPushY[i] -= uy * am;
                            relaxPushX[j] += ux * bm;
                            relaxPushY[j] += uy * bm;
                            continue;
                        }

                        // Both collapsed: AABB collision is the snugger fit
                        // for their rectangular visible shape, lets them
                        // pack tighter than a circular approximation would,
                        // and there's no expanded-circle corner to worry
                        // about.
                        const aHalfW = a.width / 2;
                        const aHalfH = a.height / 2;
                        const dx = b.x - a.x;
                        const padX = aHalfW + b.width / 2 + OVERLAP_PAD;
                        // Cheap early-out: most pairs are far apart on X.
                        if (dx > padX || dx < -padX) continue;
                        const dy = b.y - a.y;
                        const padY = aHalfH + b.height / 2 + OVERLAP_PAD;
                        if (dy > padY || dy < -padY) continue;
                        // Separate along the axis of least penetration so
                        // they part the short way.
                        const ox = padX - Math.abs(dx);
                        const oy = padY - Math.abs(dy);
                        if (ox < oy) {
                            const dir = dx < 0 ? -1 : 1;
                            relaxPushX[i] -= dir * ox * aShare;
                            relaxPushX[j] += dir * ox * bShare;
                        } else {
                            const dir = dy < 0 ? -1 : 1;
                            relaxPushY[i] -= dir * oy * aShare;
                            relaxPushY[j] += dir * oy * bShare;
                        }
                    }
                }

                // Apply accumulated pushes with under-relaxation damping
                // and a magnitude cap so a deep multi-overlap can't
                // teleport. The magnitude cap (not per-axis) keeps the
                // push direction faithful — clipping x and y
                // independently would bend a diagonal escape into an
                // axis-aligned one.
                let moved = false;
                for (let i = 0; i < n; i++) {
                    let dx = relaxPushX[i] * RELAX_DAMP;
                    let dy = relaxPushY[i] * RELAX_DAMP;
                    if (dx === 0 && dy === 0) continue;
                    const mag = Math.hypot(dx, dy);
                    if (mag > OVERLAP_PUSH_CAP) {
                        const k = OVERLAP_PUSH_CAP / mag;
                        dx *= k;
                        dy *= k;
                    }
                    nodes[i].x += dx;
                    nodes[i].y += dy;
                    moved = true;
                }
                return moved;
            }

            // Collision radius mirroring d3-force's collisionRadius() in
            // layout.ts. Kept local because it's only called in the
            // overlap-relaxation hot path and lifting it would mean
            // crossing the module boundary on every pair. The shape
            // branch is shared with layout.ts via the `isCircular`
            // helper so the two systems never disagree about whether a
            // file is currently a circle or a rectangle (the source of
            // a previous "stuck in the corner of an expanded block"
            // jitter bug).
            function circleRadiusFor(d: SimFileNode): number {
                if (isCircular(d)) return d.width / 2 + 14;
                return Math.hypot(d.width, d.height) * 0.55 + 14;
            }

            // Fraction of the zoom-derived rigidness still applied while a
            // file is open. NOT 0 — the user wants to keep "some semblance
            // of the folder structure" rather than fully deforming to the
            // connectivity layout. NOT 1 either — an expanded file is a
            // big box the rigid grid has no concept of, and a full rigid
            // blend would drag its neighbours under it. 0.5 keeps half the
            // folder structure; the overlap-relaxation pass plus the
            // connectivity sim space things out so the open file stays clear.
            // Eased multiplier on rigidness: 1 when nothing is open, eased
            // toward cfg.behavioral.openLayoutBias while any file is open
            // (was the RIGID_OPEN_BLEND/RIGID_FLOOR constant, now configurable).
            let rigidEnable = 1;

            // Centre the rigid folder layout is currently anchored on. The
            // connectivity layout's centroid drifts slowly as the sim
            // settles (forceCenter only soft-pulls the centroid toward
            // 0), so the rigid layout must follow it or the two
            // diverge. Previously this only re-anchored at the instant
            // the sim crossed alphaMin — a single-frame snap of every
            // file's rigidX/rigidY, which (now that t has a floor of
            // 0.5) showed up as a visible "pop" reorienting the whole
            // cluster the moment things stopped. Easing rigidCentre
            // toward connCentre each frame instead distributes that
            // travel over ~30 frames: while the sim ticks the centre
            // chases the drifting centroid; once the sim settles the
            // centre eases the last remaining distance with no abrupt
            // jump anyone can see.
            const initialCentre = connCentre();
            const rigidCentre = {x: initialCentre.x, y: initialCentre.y};

            // Was the sim active (alpha > alphaMin) the previous frame?
            // Lets stepLayout detect the just-settled transition and run
            // one-shot cleanup at that moment — currently used to
            // release any expansion pins once the post-expand rebalance
            // has finished.
            let simWasActive = false;

            // True between onFileDragStart and onFileDragEnd. While
            // set, stepLayout skips the d3-force tick, the overlap
            // relaxation pass, and the rigid-blend lerp — every
            // automatic layout adjustment is frozen so the user can
            // place the dragged file against a stable backdrop. The
            // dragged file's own position is written directly by
            // onFileDragMove every pointermove, so the renderer still
            // draws it under the cursor; everything else holds the
            // pose it had at the moment the drag started.
            let userDragActive = false;

            // How fast each file's actual `width`/`height` ease toward
            // their targets (set by applyExpansion). Asymmetric:
            // expansion is snappy (~500 ms), collapse is slower (~1 s)
            // so the user has more time to register "the thing I was
            // looking at is going away" — common UX pattern (menus
            // open fast, close slowly). Math: residual after N frames
            // is (1 - rate)^N; ~96% complete is residual 0.04, so rate
            // 0.1 hits that at 30 frames (500 ms @ 60fps), rate 0.05
            // at 60 frames (1 s @ 60fps).
            //
            // Width is the SINGLE source of truth — d3-force's collide
            // and link forces read it (via collisionRadius /
            // linkDistance, refreshed each frame by refreshSizeForces
            // while any size is animating), and drawFile reads it
            // directly for the rendered circle radius. The previous
            // design ran a separate per-file `t` map for the visual
            // alone, which let the visible circle drift out of sync
            // with d3's collision disc — the source of the jumpy-
            // collapse complaint. Width-as-truth keeps them aligned.
            const WIDTH_EASE_OPEN = 0.1;
            const WIDTH_EASE_CLOSE = 0.05;
            // Half-pixel snap threshold. Below this difference the
            // animation is below visible resolution at any zoom, and
            // we snap to target so future frames can early-exit the
            // ease step. Must match `SHAPE_WIDTH_TOLERANCE` in
            // layout.ts so the shape-check helpers agree about when
            // the animation has finished.
            const WIDTH_SNAP = 0.5;

            // Drives the sim one tick (while it still has energy), then
            // interpolates every node toward the rigid layout and relaxes
            // any resulting overlaps. The sim's forces must compute from
            // PURE connectivity positions, so connX/connY are restored
            // before the tick and re-snapshotted after; node.x/node.y then
            // carry the interpolated + overlap-relaxed RENDER position.
            // Once alpha decays below alphaMin the sim stops ticking — it
            // does not run indefinitely — but the interpolation and
            // overlap relaxation keep running so zoom changes and file
            // expand/collapse still re-blend cleanly.
            function stepLayout(): void {
                const sim = layout.simulation;
                // Recompute the static (overview) tier's buffer into
                // layout.rigidRaw if its pattern/params changed (cheap no-op
                // otherwise). Must precede assignRigidPositions below.
                tierEngine.sync(cfg);

                // 1. Ease per-file width/height toward their targets.
                //    Runs BEFORE the sim tick so the tick's forces
                //    operate on freshly-eased sizes. d3-force caches
                //    radii / link distances when its forces are
                //    initialized, so any frame where sizes moved we
                //    refresh those forces (refreshSizeForces is just a
                //    pair of `sim.force("collide", ...)` /
                //    `sim.force("link", ...)` assignments that trigger
                //    a fresh init on the next tick). The single boolean
                //    `sizesAnimating` keeps the work O(1) in the steady
                //    state — outside the brief open/close window the
                //    loop is one comparison per node, no force churn.
                let sizesAnimating = false;
                for (const n of layout.nodes) {
                    const rate = n.targetW > n.width ? WIDTH_EASE_OPEN : WIDTH_EASE_CLOSE;
                    if (n.width !== n.targetW) {
                        n.width += (n.targetW - n.width) * rate;
                        if (Math.abs(n.targetW - n.width) < WIDTH_SNAP) {
                            n.width = n.targetW;
                        } else {
                            sizesAnimating = true;
                        }
                    }
                    if (n.height !== n.targetH) {
                        n.height += (n.targetH - n.height) * rate;
                        if (Math.abs(n.targetH - n.height) < WIDTH_SNAP) {
                            n.height = n.targetH;
                        } else {
                            sizesAnimating = true;
                        }
                    }
                }
                if (sizesAnimating) {
                    // Refresh d3's cached radii / link distances even
                    // though we won't tick this frame — applyExpansion's
                    // alpha bump survives the freeze, and the FIRST tick
                    // after sizes settle must see the final widths so
                    // the rebalance pushes neighbours into their new
                    // resting positions. Refreshing every frame during
                    // animation is also the simplest way to guarantee
                    // the snap-frame's tick (which DOES run, since
                    // sizesAnimating goes false that frame) uses fresh
                    // values.
                    refreshSizeForces(layout);
                }

                // FREEZE everything during a manual file drag. While
                // the user holds and moves a file we don't tick the
                // sim, run relaxation, or recompute the rigid-blend
                // lerp — every other node holds the exact pose it had
                // when the drag started, giving the user a stable
                // backdrop to aim against. The dragged file's
                // position is being written directly by
                // onFileDragMove on each pointermove (sim.x / connX /
                // fx all in sync), so the renderer still draws it
                // under the cursor.
                //
                // simWasActive is left in lock-step with simActive so
                // the post-drop frame's "sim just settled" branch
                // fires correctly: the alpha(0.6) reheat in
                // onFileDragEnd flips simActive back true, then it
                // decays naturally over the next ~3 s.
                if (userDragActive) {
                    simWasActive = sim.alpha() > sim.alphaMin();
                    return;
                }

                // FREEZE positions during the size animation. The
                // expand/collapse motion is meant to read as a pure
                // size change in place — letting d3-force's tick and
                // the overlap-relaxation pass move neighbours WHILE
                // the size is changing adds visual noise (files
                // drifting AS the focal file grows / shrinks). Instead
                // we hold every position still during the animation
                // and let the post-animation tick burst (alpha didn't
                // decay during the freeze, so it's still ~0.9) do the
                // rebalance in one clean phase.
                const simActive = sim.alpha() > sim.alphaMin();
                if (simActive && !sizesAnimating) {
                    for (const n of layout.nodes) {
                        n.x = n.connX;
                        n.y = n.connY;
                    }
                    sim.tick();
                    for (const n of layout.nodes) {
                        n.connX = n.x;
                        n.connY = n.y;
                    }
                } else if (simWasActive && !sizesAnimating) {
                    // Sim just settled this frame. Release any pins that
                    // were holding expanded files in place during the
                    // post-expand rebalance — the rebalance has finished,
                    // the file is where it ended up, and keeping it
                    // pinned would block the next expansion / collide
                    // pass from pushing it out of the new file's way.
                    // (See expandFileForSelection — those pins are
                    // designed to be transient.)
                    // EXCEPT user-pinned files: a user drag explicitly
                    // anchors a file's position; that pin must survive
                    // every sim settle, expansion, and collapse until
                    // the user presses U or R to release it.
                    for (const n of layout.nodes) {
                        if (n.expanded && n.fx != null && !n.userPinned) {
                            n.fx = null;
                            n.fy = null;
                        }
                    }
                }
                simWasActive = simActive;

                // (The previous per-file `t` ease was here — replaced
                // by the width-ease step at the top of stepLayout.
                // drawFile now derives its visual `t` from
                // (width - collapsedW) / (lastExpandedTargetW -
                // collapsedW), so width is the single source of truth
                // for both the rendered circle radius and the
                // icon/circle alpha crossfade.)

                // Ease rigidCentre toward the current connectivity centroid
                // and re-anchor the rigid layout each frame. The easing
                // rate is low enough that per-tick centroid jitter (while
                // the sim is settling) is filtered out, and once the sim
                // is settled (centroid static) the centre converges to it
                // in ~30 frames — well within "noticed but not jarring."
                const targetCentre = connCentre();
                rigidCentre.x += (targetCentre.x - rigidCentre.x) * 0.1;
                rigidCentre.y += (targetCentre.y - rigidCentre.y) * 0.1;
                assignRigidPositions(layout, rigidCentre);
                // If the overview tier's pattern just changed, the static
                // layout's extent is different — re-fit the camera so the new
                // arrangement lands in view (rigidX/rigidY are fresh above).
                if (tierEngine.takeRefit()) fitProjectToViewport();
                // Ease rigidEnable toward openLayoutBias while any file is open,
                // back to 1 when none are. 0.08/frame ≈ a ~0.4s fade. Governs
                // the "open a file → neighbours lean toward the live/force layer
                // to reveal connectivity" blend.
                const anyFileOpen = useGraphStore.getState().expandedFiles.size > 0;
                rigidEnable += ((anyFileOpen ? cfg.behavioral.openLayoutBias : 1) - rigidEnable) * 0.08;

                // Fill the per-tier render buffers: each static tier's pattern
                // re-centred on the connectivity centroid into tierX[t]/tierY[t];
                // live tiers mirror connX/connY.
                tierEngine.fillBuffers(cfg, rigidCentre, layout.nodes);

                // Which tier(s) are active at this zoom, and how much of the
                // blend is STATIC vs the live/force layer. Two active static
                // tiers → staticWeight 1 (the live layer drops out, a pure
                // static→static crossfade, e.g. treemap → hub-and-spoke). One
                // static + the live tier → staticWeight = the old folder ⇄ force
                // lean.
                const sel = activeTiers(cameraScale, fitScale, cfg.tiers);
                const aStatic = getPattern(cfg.tiers[sel.a].patternId).kind === "static";
                const bStatic = sel.b != null && getPattern(cfg.tiers[sel.b].patternId).kind === "static";
                const wa = sel.b != null ? 1 - sel.w : 1;
                const wb = sel.w;
                const staticWeight = (aStatic ? wa : 0) + (bStatic ? wb : 0);
                // Static blend weight `t`, eased by rigidEnable and floored by
                // openLayoutBias. The floor only matters when leaning toward the
                // live layer; with two static tiers staticWeight is 1 so it
                // never binds and the crossfade completes fully.
                const t = Math.max(staticWeight * rigidEnable, cfg.behavioral.openLayoutBias);

                // Per-node STATIC position: the crossfade of the active STATIC
                // tiers' buffers (weight-normalised). When no static tier is
                // active it returns the connectivity position, so the
                // lerp(connX, S, nt) below collapses to connX (fully live).
                function staticPos(n: SimFileNode): {x: number; y: number} {
                    let sw = 0;
                    let sx = 0;
                    let sy = 0;
                    if (aStatic) {
                        sx += n.tierX![sel.a] * wa;
                        sy += n.tierY![sel.a] * wa;
                        sw += wa;
                    }
                    if (bStatic && sel.b != null) {
                        sx += n.tierX![sel.b] * wb;
                        sy += n.tierY![sel.b] * wb;
                        sw += wb;
                    }
                    if (sw > 1e-6) return {x: sx / sw, y: sy / sw};
                    return {x: n.connX, y: n.connY};
                }
                // Per-file rigid-blend factor `nt`, by file state:
                //
                //   * Expanded (or animating TOWARD expanded): nt=0.
                //     The file renders at its connectivity position
                //     (connX) so a click on it lands on the right
                //     thing, and so its interior AST nodes are
                //     reliably positioned. expandFileForSelection
                //     aligns connX/offX with the rendered position at
                //     click time, so flipping nt from t to 0 doesn't
                //     move the file — the formula produces sim.x with
                //     or without the rigid term, since connX IS sim.x
                //     at that moment.
                //
                //   * Collapsing (animating AWAY from expanded): the
                //     bias eases from 1 (fully expanded) to 0 (fully
                //     collapsed) over the shrink animation, and we
                //     blend (1 - bias) × t. nt smoothly eases from 0
                //     to t, so the file's position transitions from
                //     connX (its expanded resting place) to connX +
                //     lerp×t (the rigid-blended collapsed position)
                //     — a "going home to the cluster" motion that
                //     reads naturally to the user.
                //
                //   * Collapsed steady state: targetExpanded=false,
                //     bias=0, nt = (1-0)×t = t. Full rigid blend.
                //
                // The asymmetry mirrors UX intent: expanding is "stay
                // where the user is looking", collapsing is "drift
                // back to natural cluster position".
                function biasFor(n: SimFileNode): number {
                    const refW = n.targetExpanded ? n.targetW : n.lastExpandedTargetW;
                    const span = refW - n.collapsedW;
                    // No meaningful span — file's expanded and collapsed
                    // sizes are the same. Treat as fully collapsed (0).
                    if (Math.abs(span) < 1) return 0;
                    // Same formula whether the span is positive (file
                    // grows when expanded) or negative (degenerate case
                    // where the AST is smaller than the icon+label
                    // footprint — see expandedSizeFor's minDiameter
                    // floor, which mostly prevents this, but the
                    // formula stays robust). Both numerator and
                    // denominator share the same sign so the ratio is
                    // positive and reaches 1 when width = refW.
                    const raw = (n.width - n.collapsedW) / span;
                    return raw < 0 ? 0 : raw > 1 ? 1 : raw;
                }

                // Build the polarity-neighbour map for THIS frame: every
                // file that is a direct import or import-consumer of an
                // expanded file gets a "polarity progress" equal to the
                // expansion progress of its anchor (the max across all
                // anchors if the file is connected to several expanded
                // files). The renderer reads this to SUPPRESS the rigid-
                // blend for these files so the layout.ts polarity force
                // — which drives connX onto the arc — actually shows
                // through in the rendered position. Without this
                // suppression the rigid-blend at the RIGID_FLOOR=0.5
                // minimum diluted the arc into a halfway-rigid-grid
                // smear, which is what the user was seeing.
                const polarityProgressByFile = new Map<string, number>();
                for (const E of layout.nodes) {
                    if (!E.expanded && !E.targetExpanded) continue;
                    const eProgress = biasFor(E);
                    if (eProgress <= 0) continue;
                    const deps = fileEdgesByKind.imports.out.get(E.id);
                    if (deps) {
                        for (const id of deps) {
                            const cur = polarityProgressByFile.get(id) ?? 0;
                            if (eProgress > cur) polarityProgressByFile.set(id, eProgress);
                        }
                    }
                    const consumers = fileEdgesByKind.imports.in.get(E.id);
                    if (consumers) {
                        for (const id of consumers) {
                            const cur = polarityProgressByFile.get(id) ?? 0;
                            if (eProgress > cur) polarityProgressByFile.set(id, eProgress);
                        }
                    }
                }

                function ntFor(n: SimFileNode): number {
                    // User-pinned files render at their pin position
                    // regardless of zoom — nt=0 means the rigid-blend
                    // term drops out and n.x = connX (the pin) at
                    // every zoom level. The pin is the user's
                    // explicit "this file lives HERE" statement; the
                    // folder-grid layout shouldn't override that as
                    // they zoom out.
                    if (n.userPinned) return 0;
                    if (n.targetExpanded) return 0;
                    const base = (1 - biasFor(n)) * t;
                    const polarityProgress = polarityProgressByFile.get(n.id);
                    if (polarityProgress !== undefined && polarityProgress > 0) {
                        // Scale down rigid blend by the anchor's expansion
                        // progress: fully-expanded anchor → nt = 0 →
                        // rendered position = connX (where the polarity
                        // force put it). Easing in lock-step with the
                        // anchor's width animation means the rendered
                        // position transitions smoothly from rigid-blended
                        // (pre-expansion) to arc-on-boundary (post-
                        // expansion), no jump at animation end.
                        return base * (1 - polarityProgress);
                    }
                    return base;
                }

                // 1. Tentative render position = interpolated base + the
                //    decayed collision offset carried from last frame.
                for (const n of layout.nodes) {
                    n.offX *= OVERLAP_DECAY;
                    n.offY *= OVERLAP_DECAY;
                    const nt = ntFor(n);
                    const s = staticPos(n);
                    n.x = n.connX + (s.x - n.connX) * nt + n.offX;
                    n.y = n.connY + (s.y - n.connY) * nt + n.offY;
                }
                // 2. Relax overlaps — early-exit once a pass moves
                //    nothing. Skipped while sizes are animating: the
                //    expanding file's growing radius would otherwise
                //    push neighbours out during the animation, while
                //    we want the freeze to read as a pure-in-place
                //    size change. Brief visual overlap is acceptable;
                //    the post-animation sim tick (alpha didn't decay
                //    during the freeze) immediately resolves it.
                if (!sizesAnimating) {
                    for (let i = 0; i < OVERLAP_ITERS; i++) {
                        if (!relaxOverlaps(layout.nodes)) break;
                    }
                }
                // 3. Record net displacement from the interpolated base as
                //    the new offset (carried, decayed, into the next frame).
                //    Same per-file `ntFor` as step 1 so the offset is
                //    measured against the same blend the renderer
                //    produced — keeps relaxation pushes from being
                //    mis-recorded against the "wrong" base when a file
                //    is mid-collapse animation.
                for (const n of layout.nodes) {
                    const nt = ntFor(n);
                    const s = staticPos(n);
                    n.offX = n.x - (n.connX + (s.x - n.connX) * nt);
                    n.offY = n.y - (n.connY + (s.y - n.connY) * nt);
                }
            }

            const tickerCb = () => {
                // Refresh the per-frame config snapshot first so every helper
                // below reads this frame's (possibly just-edited) config.
                cfg = configRef.current;
                // Live theme: point the renderer's color bindings at the current
                // config and keep the Pixi clear color in sync.
                liveTheme.colors = cfg.theme.colors;
                liveTheme.semanticEdge = cfg.theme.semanticEdge;
                if (app.renderer) app.renderer.background.color = liveTheme.colors.bg;
                // updateZoomFit BEFORE syncExpansion so the latter sees the
                // zoom we're heading to (a zoom-fit in progress shouldn't be
                // ignored when deciding whether to expand). syncExpansion
                // BEFORE stepLayout so any expand/collapse that bumped sim
                // alpha takes effect this frame. stepLayout BEFORE draw so
                // draw sees the interpolated positions. updateFollow AFTER
                // draw so it can read visibleById.
                updateZoomFit();
                syncExpansion();
                stepLayout();
                draw();
                updateFollow();
            };
            app.ticker.add(tickerCb);

            // Dev-only debug hook for headless visual testing. Lets a Playwright
            // script ask "where on screen is file X right now?" so it can dispatch
            // accurate mouse clicks. No-op in production builds.
            if (import.meta.env.DEV) {
                const wnd = window as unknown as {__codeGraph?: unknown};
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

            // Bulk pin/unpin (HUD buttons + P / ⇧P keys). Pinning a file fixes
            // it at its CURRENT rendered position against the layout — same
            // recipe as a drag-drop (connX/connY + fx/fy at the spot, clear the
            // relax offset, mark userPinned). A pinned file renders at connX
            // (ntFor returns 0), so this holds it exactly where it sits now.
            function pinNodes(nodes: Iterable<SimFileNode>): void {
                let any = false;
                for (const n of nodes) {
                    n.connX = n.x;
                    n.connY = n.y;
                    n.fx = n.x;
                    n.fy = n.y;
                    n.offX = 0;
                    n.offY = 0;
                    n.userPinned = true;
                    any = true;
                }
                if (any) layout.simulation.alpha(0.6);
            }
            function pinAllFiles(): void {
                pinNodes(layout.nodes);
            }
            function pinVisibleFiles(): void {
                // "Visible" = files the renderer actually drew this frame
                // (on-screen, not culled, not hidden by support/isolate filters).
                const seen = new Set<string>();
                const out: SimFileNode[] = [];
                for (const r of visibleById.values()) {
                    if (r.kind !== "file" || seen.has(r.fileId)) continue;
                    seen.add(r.fileId);
                    const sim = layout.byId.get(r.fileId);
                    if (sim) out.push(sim);
                }
                pinNodes(out);
            }
            function unpinAllFiles(): void {
                let any = false;
                for (const n of layout.nodes) {
                    if (!n.userPinned) continue;
                    n.userPinned = false;
                    n.fx = null;
                    n.fy = null;
                    any = true;
                }
                if (any) layout.simulation.alpha(0.8);
            }

            // Imperative zoom for the HUD buttons: pivot on the viewport centre
            // and clear any follow / zoom-fit so they don't fight the input.
            // Mirrors the wheel handler's math but is device-independent.
            function applyZoom(next: number): void {
                const clamped = Math.min(32, Math.max(0.05, next));
                const px = app.screen.width / 2;
                const py = app.screen.height / 2;
                const k = clamped / world.scale.x;
                world.x = px - (px - world.x) * k;
                world.y = py - (py - world.y) * k;
                world.scale.set(clamped);
                cameraScale = clamped;
                followId = null;
                zoomFit = null;
            }
            if (cameraApiRef) {
                cameraApiRef.current = {
                    zoomBy: (factor) => applyZoom(world.scale.x * factor),
                    fitView: () => {
                        followId = null;
                        zoomFit = null;
                        fitProjectToViewport();
                        cameraScale = world.scale.x;
                    },
                    pinAll: pinAllFiles,
                    pinVisible: pinVisibleFiles,
                    unpinAll: unpinAllFiles,
                };
            }

            const detachCamera = wireCamera({
                app,
                world,
                container,
                getCameraScale: () => cameraScale,
                setCameraScale: (s: number) => {
                    // Zoom no longer reheats the sim. The connectivity layout
                    // is static once settled; zoom only changes rigidness(),
                    // which stepLayout re-applies as a render-time
                    // interpolation every frame regardless of sim alpha.
                    cameraScale = s;
                },
                hitTest: (worldX: number, worldY: number) => {
                    // Overlays first: an expanded Block's overlay sits on top of
                    // the main scene, so its contents (and the underlying cell)
                    // should win clicks within their bounds. Fall through to
                    // the main scene's rects only when no overlay contains the
                    // point.
                    const overlay = smallestContaining(overlayHitRects, worldX, worldY);
                    if (overlay) return overlay;
                    const direct = smallestContaining(hitRects, worldX, worldY);
                    if (direct) return direct;
                    // Low-zoom proximity fallback for FILE rects. When
                    // zoomed out, file icons render as 2-3 screen px
                    // squares; the cursor lands in the gaps between
                    // them more often than on one, and hover / drag
                    // become near-impossible. If no direct rect won,
                    // pick the file whose centre is within a screen-
                    // constant radius of the cursor. Threshold of 24
                    // screen px (= 24/cameraScale world units) is
                    // ~1.5× a default touch target — generous enough
                    // to reliably catch tiny icons without swallowing
                    // intentional empty-space clicks (the user has to
                    // be visibly near a file). Closest centre wins
                    // when several are inside the radius.
                    const r = 24 / cameraScale;
                    const r2 = r * r;
                    let best: HitRect | null = null;
                    let bestDist2 = Infinity;
                    for (const rect of visibleById.values()) {
                        if (rect.kind !== "file") continue;
                        const cx = rect.x + rect.w / 2;
                        const cy = rect.y + rect.h / 2;
                        const dx = cx - worldX;
                        const dy = cy - worldY;
                        const d2 = dx * dx + dy * dy;
                        if (d2 < r2 && d2 < bestDist2) {
                            bestDist2 = d2;
                            best = rect;
                        }
                    }
                    return best;
                },
                onClick: handleClick,
                onHover: (target) => {
                    hoveredHit = target;
                    // Mirror to the store so React HUD components (HoverTooltip)
                    // can subscribe. The closure copy above stays the source of
                    // truth for cheap per-frame label brightening. Screen-rect
                    // snapshot taken HERE means the tooltip anchors to the rect
                    // at hover-start; if the user pans while hovering the
                    // tooltip stays put — acceptable trade-off vs subscribing
                    // React to every animation frame.
                    const nextHoveredId = target?.id ?? null;
                    const cur = useGraphStore.getState();
                    if (cur.hoveredId !== nextHoveredId) {
                        let screenRect: {
                            x: number;
                            y: number;
                            w: number;
                            h: number;
                        } | null = null;
                        if (target) {
                            const canvasRect = container.getBoundingClientRect();
                            const s = world.scale.x;
                            screenRect = {
                                x: canvasRect.left + world.x + target.x * s,
                                y: canvasRect.top + world.y + target.y * s,
                                w: target.w * s,
                                h: target.h * s,
                            };
                        }
                        cur.setHover(nextHoveredId, screenRect);
                    }
                    // Pointer cursor when the click would TOGGLE a Block — that's
                    // a collapsed Block (its rect IS the toggle target) or an
                    // expanded Block's top-right handle ('ast-toggle' kind).
                    // Clicking the empty body of an expanded Block also toggles,
                    // but the body is mostly covered by children, so we don't
                    // promise toggleability there with the cursor.
                    let isToggleable = false;
                    if (target?.kind === "ast-toggle") {
                        isToggleable = true;
                    } else if (target?.kind === "ast") {
                        const tree = activeTree(target.fileId);
                        const tn = tree?.byId.get(target.id);
                        if (tn?.syntaxKind != null && isExpandableKind(tn.syntaxKind) && tn.collapsed) {
                            isToggleable = true;
                        }
                    }
                    container.style.cursor = isToggleable ? "pointer" : "grab";
                },
                onUserCameraMove: () => {
                    followId = null;
                    followAt = null;
                    // User scrolled or dragged — drop any in-flight zoom-to-fit
                    // so we don't fight their input.
                    zoomFit = null;
                },
                // Pivot policy for wheel-zoom, by what the cursor is on:
                //   * COLLAPSED file → anchor on the icon's centre so the
                //     small icon doesn't wander out from under the cursor
                //     as the user zooms in.
                //   * EXPANDED file → cursor pivot (return null). The user
                //     is reaching INTO the file toward specific content;
                //     anchoring on the file centre would slide their
                //     actual target off screen.
                //   * AST hit inside an open file → same as expanded file:
                //     cursor pivot so the specific content stays put.
                //   * Empty space → anchor on the CLOSEST file's centre.
                //     Zooming in over nothing in particular would otherwise
                //     just amplify the surrounding emptiness; gravitating
                //     to the nearest file means a wheel scroll always
                //     heads somewhere useful.
                getZoomPivot: (cursorWorld) => {
                    if (hoveredHit) {
                        if (hoveredHit.kind !== "file") return null;
                        const expanded = useGraphStore.getState().expandedFiles.has(hoveredHit.fileId);
                        if (expanded) return null;
                        const sim = layout.byId.get(hoveredHit.fileId);
                        if (!sim) return null;
                        return {worldX: sim.x, worldY: sim.y};
                    }
                    // Empty space — pivot toward the closest file. Cheap
                    // linear scan over layout.nodes; a project has on the
                    // order of hundreds of files at most, and this runs
                    // once per wheel event.
                    let bestNode: SimFileNode | null = null;
                    let bestDist2 = Infinity;
                    for (const n of layout.nodes) {
                        const dx = n.x - cursorWorld.x;
                        const dy = n.y - cursorWorld.y;
                        const d2 = dx * dx + dy * dy;
                        if (d2 < bestDist2) {
                            bestDist2 = d2;
                            bestNode = n;
                        }
                    }
                    if (!bestNode) return null;
                    return {worldX: bestNode.x, worldY: bestNode.y};
                },
                // Drag-to-pin: when wireCamera detects the user has
                // moved past DRAG_DEADZONE while pointer-down on a
                // file, it asks us to start a file-drag. We resolve
                // the SimFileNode by id; returning it commits to
                // file-drag mode. Returning null falls through to
                // camera-pan.
                onFileDragStart: (id) => {
                    const sim = layout.byId.get(id);
                    if (!sim) return null;
                    // Freeze automatic layout adjustment so other
                    // files don't drift while the user is placing
                    // this one. The flag is consulted at the top of
                    // stepLayout; cleared in onFileDragEnd.
                    userDragActive = true;
                    return sim;
                },
                // During a file-drag we update every position field
                // the renderer / sim might read:
                //   * sim.x / sim.y     — what drawFile reads
                //   * connX / connY     — the d3-force authoritative
                //                         position; the renderer
                //                         restores x/y from these
                //                         before each manual tick
                //   * fx / fy           — d3-force fixed-coordinate
                //                         pin; freezes the node in
                //                         place against the next tick
                //   * offX / offY = 0   — clear any in-flight relax-
                //                         overlap offset so the file
                //                         lands exactly under the
                //                         cursor, not at cursor+offset
                // Then bump alpha so neighbours start redistributing
                // live as the user drags — not all at once on drop.
                onFileDragMove: (sim, nx, ny) => {
                    sim.x = nx; sim.y = ny;
                    sim.connX = nx; sim.connY = ny;
                    sim.fx = nx; sim.fy = ny;
                    sim.offX = 0; sim.offY = 0;
                    // No alpha bump here — stepLayout is frozen by
                    // userDragActive, so heating the sim wouldn't
                    // achieve anything. The single alpha(0.6) in
                    // onFileDragEnd does the post-drop redistribute.
                },
                // Drop: mark the pin user-set (this is the bit that
                // makes it survive sim-settle, expansion, collapse,
                // and reheats — every release site checks userPinned)
                // and reheat one last time so the surrounding files
                // converge into the new arrangement.
                onFileDragEnd: (sim) => {
                    sim.userPinned = true;
                    // Release the freeze BEFORE the alpha bump so the
                    // first post-drop frame's stepLayout actually
                    // ticks the sim with the freshly heated alpha.
                    userDragActive = false;
                    layout.simulation.alpha(0.6);
                },
                // Folder-drag start: resolve the directory id to the
                // list of files whose cluster (at the CURRENT zoom-
                // adaptive depth) matches. Snapshotting at the start
                // of the gesture means a depth change mid-drag (e.g.
                // from zoom-out) doesn't reshape the moving group;
                // the user keeps moving the same set of files they
                // grabbed. Returning null/empty falls through to a
                // camera pan, matching the single-file callback.
                onFolderDragStart: (folderId) => {
                    const depth = chooseClusterDepth();
                    const sims: SimFileNode[] = [];
                    for (const n of layout.nodes) {
                        if (clusterDirOf(n.relativePath, depth) === folderId) {
                            sims.push(n);
                        }
                    }
                    if (sims.length === 0) return null;
                    userDragActive = true;
                    return sims;
                },
                onOverlayDragStart: (id) => {
                    // Only accept the drag if the block is actually expanded
                    // (the handle is only drawn for overlays anyway). Capture the
                    // current offset so this drag accumulates from where it sat.
                    if (!useGraphStore.getState().expandedAstNodes.has(id)) return false;
                    overlayDragBase = overlayDragOffsets.get(id) ?? {x: 0, y: 0};
                    return true;
                },
                onOverlayDragMove: (id, dx, dy) => {
                    overlayDragOffsets.set(id, {x: overlayDragBase.x + dx, y: overlayDragBase.y + dy});
                },
                onOverlayDragEnd: () => {
                    // Offset persists (the overlay stays where dropped) until the
                    // block is collapsed; nothing to finalize here.
                },
            });

            // Pin-release shortcuts. U unpins the file currently
            // under the cursor (if any); R releases every user pin
            // in one shot. Both bump the sim alpha so the freed
            // file(s) drift back into the layout instead of just
            // sitting where they were.
            //
            // Guarded against text-input focus so the keys don't
            // hijack the URL bar / search box.
            const onPinKey = (e: KeyboardEvent) => {
                const ae = document.activeElement;
                if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return;
                if (e.key === "u" || e.key === "U") {
                    if (hoveredHit?.kind === "file") {
                        const sim = layout.byId.get(hoveredHit.fileId);
                        if (sim?.userPinned) {
                            sim.userPinned = false;
                            sim.fx = null;
                            sim.fy = null;
                            layout.simulation.alpha(0.6);
                        }
                    } else if (hoveredHit?.kind === "folder") {
                        // Folder unpin: release every pinned file
                        // whose cluster (at the current zoom-adaptive
                        // depth) matches the hovered folder label.
                        // Mirrors the resolution policy in
                        // onFolderDragStart so the same folder click
                        // target consistently pins on drag / unpins
                        // on U.
                        const depth = chooseClusterDepth();
                        let any = false;
                        for (const n of layout.nodes) {
                            if (!n.userPinned) continue;
                            if (clusterDirOf(n.relativePath, depth) !== hoveredHit.id) continue;
                            n.userPinned = false;
                            n.fx = null;
                            n.fy = null;
                            any = true;
                        }
                        if (any) layout.simulation.alpha(0.6);
                    }
                } else if (e.key === "r" || e.key === "R") {
                    unpinAllFiles();
                } else if (e.key === "p" || e.key === "P") {
                    // P pins the files currently on screen; ⇧P pins every file.
                    if (e.shiftKey) pinAllFiles();
                    else pinVisibleFiles();
                }
            };
            window.addEventListener("keydown", onPinKey);

            function handleClick(target: HitRect | null) {
                if (!target) {
                    const st = useGraphStore.getState();
                    st.setSelection(null);
                    st.setFocus(null);
                    st.setTracedPath(null);
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
                if (target.kind === "ast-toggle") {
                    followId = null;
                    followAt = null;
                } else {
                    followId = target.id;
                    followStartAt = 0;
                    followAt = null;
                }

                const state = useGraphStore.getState();
                // Don't change selection when the click is on a Block's
                // top-right collapse handle — preserve whatever was selected.
                if (target.kind !== "ast-toggle") {
                    // Shift-click toggles the target in the multi-select
                    // set (additive). Plain click replaces the set with
                    // just this target, EXCEPT when the target is an AST
                    // node — those drill into the currently-selected
                    // file(s), so a shift-selected file group should
                    // survive the click rather than collapse to a single
                    // block. File expansion is no longer a click action
                    // — it's zoom-driven (see syncExpansion).
                    if (shiftHeld) {
                        state.toggleSelection(target.id);
                    } else if (target.kind === "ast") {
                        state.selectAstNode(target.id);
                    } else {
                        state.setSelection(target.id);
                    }
                    // Focus mode follows selection: clicking a thing makes
                    // its file's neighbourhood the "live set" and dims the
                    // rest. Hops are preserved across clicks so the user can
                    // settle on a comfortable view depth and then explore.
                    state.setFocus(target.id);
                }
                // Expandable-container toggle: clicking the collapsed cell
                // (Block or ObjectLiteralExpression, in the main scene or
                // inside an overlay) or an overlay's handle (kind
                // 'ast-toggle') flips this node in expandedAstNodes. The
                // MAIN layout doesn't change — the file's footprint is stable
                // across toggles — so we don't call applyExpansionToSim.
                // drawOverlay reads the new expandedAstNodes set on the next
                // frame and renders the overlay; startBlockAnim primes the
                // rect-grow animation.
                //
                // Resolve syntaxKind via the file's flat AST (not via
                // mainTree.byId): the main layout's `collapseChildren`
                // predicate stops recursion on EVERY expandable kind, so an
                // expandable nested inside another isn't in the main tree at
                // all. The flat ast.nodes list has every node regardless of
                // any layout's collapse decisions, so this works at any
                // nesting depth.
                const astKind = ((): string | undefined => {
                    const ast = state.asts.get(target.fileId);
                    return ast?.nodes.find((n) => n.id === target.id)?.syntaxKind;
                })();
                const isExpandable = (astKind != null && isExpandableKind(astKind)) || target.kind === "ast-toggle";
                if (isExpandable) {
                    // Two cases for the prev-rect snapshot:
                    //   * Expanding: target is the cell HitRect (kind 'ast'); its
                    //     w/h are the cell's small size.
                    //   * Collapsing: target is the overlay handle (kind
                    //     'ast-toggle'). prev is the OVERLAY's current rendered
                    //     size — read the overlay layout root's rect for that.
                    let prevW: number;
                    let prevH: number;
                    if (target.kind === "ast-toggle") {
                        const overlayTree = getOverlayLayout(target.id);
                        const root = overlayTree?.byId.get(target.id);
                        prevW = root?.rect.w ?? target.w;
                        prevH = root?.rect.h ?? target.h;
                    } else {
                        prevW = target.w;
                        prevH = target.h;
                    }
                    // NB: the drag offset is intentionally KEPT in
                    // overlayDragOffsets across a collapse, so re-expanding the
                    // same block restores it to wherever the user last dragged
                    // it rather than snapping back to the origin.
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

            // --- Selection-driven, zoom-driven file expansion ----------------
            //
            // The user's mental model: clicking a file SELECTS it; the file
            // expands when you zoom in past the connectivity transition (and
            // collapses again when you zoom back out). No click action toggles
            // expansion. syncExpansion runs each frame from the ticker and
            // diffs the desired expansion set against the store.
            //
            // Multipliers on fitScale — selected files expand at fitScale ×
            // FILE_EXPAND_AT_MUL and collapse at fitScale × FILE_COLLAPSE_BELOW_MUL.
            // The band between them is the hysteresis zone: a file that's
            // already expanded only collapses when zoom drops past the LOWER
            // bound, and vice versa. Stops the file flickering open/closed when
            // the user pauses near the threshold.
            // Isolation kicks in BEFORE expansion (lower zoom) so the cluster
            // fades before files grow. The threshold multipliers and their
            // absolute cameraScale ceilings (for small projects whose fitScale
            // saturates at 2) now live in config — see DEFAULT_BEHAVIORAL in
            // graph/config/defaults.ts for the values and the full rationale.
            // Effective threshold is min(ratio × fitScale, absoluteCeiling).
            //
            // Per-frame state of each regime, holding through its hysteresis band.
            let expansionRegimeOn = false;
            let isolateRegimeOn = false;

            function selectionExpansionEnabled(): boolean {
                const b = cfg.behavioral;
                // Master toggle: when off, files never auto-expand on zoom.
                if (!b.selectionExpands) return false;
                const fit = Math.max(fitScale, 1e-4);
                const expandAt = Math.min(b.expandAtMul * fit, b.expandAbsCeiling);
                const collapseBelow = Math.min(b.collapseBelowMul * fit, b.collapseAbsCeiling);
                if (cameraScale >= expandAt) expansionRegimeOn = true;
                else if (cameraScale < collapseBelow) expansionRegimeOn = false;
                return expansionRegimeOn;
            }

            function isolateRegimeEnabled(): boolean {
                const fit = Math.max(fitScale, 1e-4);
                const b = cfg.behavioral;
                const onAt = Math.min(b.isolateAtMul * fit, b.isolateAbsCeiling);
                const offBelow = Math.min(b.isolateBelowMul * fit, b.isolateBelowAbsCeiling);
                if (cameraScale >= onAt) isolateRegimeOn = true;
                else if (cameraScale < offBelow) isolateRegimeOn = false;
                return isolateRegimeOn;
            }

            // Expand a single file: fetch its AST if we don't have it, then
            // expand in the store and rebuild its subtree layout.
            //
            // syncExpansion re-fires this every frame until the store reflects
            // the expansion; the in-flight guard at the top prevents a second
            // call from racing past the (still-pending) fetch and trying to
            // build a subtree layout before the AST has arrived.
            async function expandFileForSelection(fileId: string): Promise<void> {
                if (fetching.has(fileId)) return;
                const state = useGraphStore.getState();
                if (!state.asts.has(fileId)) {
                    fetching.add(fileId);
                    try {
                        const ast = await getFileAst(project.projectId, fileId);
                        state.setFileAst(fileId, ast);
                    } catch (err) {
                        console.error("[code-graph] AST fetch failed", err);
                        fetching.delete(fileId);
                        return;
                    }
                    fetching.delete(fileId);
                }
                const cur = useGraphStore.getState();
                if (cur.expandedFiles.has(fileId)) return;
                cur.expandFile(fileId);
                // RELEASE any pins on previously-expanded files. Pins
                // are a transient "hold this file still during the
                // post-expand alpha rebalance" device — leaving them
                // set across multiple expansions stops d3-force from
                // separating expanded circles that overlap, so the
                // user sees two-or-three big blue rings stacked on top
                // of each other. Releasing the prior pins lets the
                // freshly-expanded file's alpha=0.9 reheat push the
                // older ones out of its way as it claims its position.
                for (const n of layout.nodes) {
                    if (n.id !== fileId && n.expanded && !n.userPinned) {
                        n.fx = null;
                        n.fy = null;
                    }
                }
                applyExpansionToSim();
                buildSubtreeLayout(fileId);
                // Re-centre the camera on the freshly expanded file.
                // SNAP (not lerp) so a wheel-driven expansion doesn't
                // get clobbered by the wheel handler's onUserCameraMove,
                // which fires on EVERY wheel event and clears followId.
                //
                // Additionally PIN the file's sim position so the d3
                // alpha=0.9 rebalance can't push it around — without
                // this, even a perfectly-centred snap drifts off-screen
                // over the next few frames as collision forces
                // reposition the (now-larger) file. Other files still
                // re-balance freely around the pinned one, which is
                // exactly what we want: the user's focal point stays
                // put while neighbours move out of its way. The pin is
                // released when the sim next settles (see stepLayout)
                // or when the file is collapsed (see syncExpansion).
                const sim = layout.byId.get(fileId);
                if (sim && !sim.userPinned) {
                    sim.fx = sim.x;
                    sim.fy = sim.y;
                    // Critical: align connX/connY (and zero offX/offY)
                    // with the pinned position. The pin (sim.fx) only
                    // takes effect when d3-force ticks — which is
                    // PRECISELY what's skipped during the size
                    // animation freeze. The per-frame interpolation
                    // formula reads `connX`, not `fx`. Without this
                    // alignment, `connX` stays at its pre-click value
                    // (the pure connectivity position, NOT the
                    // user's focal point); as the per-file bias eases
                    // from 0 → 1 the formula `n.x = connX + lerp ×
                    // (1−bias) × t + offX` drifts the file from P
                    // (rendered position) toward connX over the
                    // animation, and the first post-animation tick
                    // then yanks it back to fx — the visible "file
                    // hops to a different spot during expansion, then
                    // pops back when the animation ends" effect.
                    // Snapping connX = sim.x means the formula
                    // produces sim.x throughout the animation, with
                    // or without bias.
                    sim.connX = sim.x;
                    sim.connY = sim.y;
                    sim.offX = 0;
                    sim.offY = 0;
                }
                // User-pinned files: fx/fy/connX/connY are already at
                // the user's chosen position from the original drag
                // (and were preserved across collapse / sim-settle by
                // the gated release sites). Overwriting them here
                // with the CURRENT sim.x — which during a re-expand
                // triggered mid zoom-in is a lerped position between
                // the pin and the folder-grid rigidX — would replace
                // the user's pin with whatever happened to be on
                // screen at the moment of expansion. So we skip the
                // alignment for user-pinned files. The rendered
                // position will snap back to the pin within one
                // frame: targetExpanded=true forces nt=0, and
                // step 3's offX recompute zeros the carried offset
                // since n.x ends up at connX after the first tick.
                followId = fileId;
                followStartAt = 0;
                followAt = null;
            }

            // Reconcile expandedFiles with (selectionSet × zoom). Called each
            // frame from the ticker; cheap when nothing changed (set compare
            // + an early-return).
            function syncExpansion(): void {
                const state = useGraphStore.getState();
                const enabled = selectionExpansionEnabled();
                const want = new Set<string>();
                if (enabled) {
                    for (const id of state.selectionSet) {
                        const fileId = id.includes("#") ? fileIdOfAstId(id) : id;
                        // Only file ids that exist in the layout (skip stale
                        // ids from a previous project).
                        if (layout.byId.has(fileId)) want.add(fileId);
                    }
                }
                const current = state.expandedFiles;
                // Cheap shortcut: same membership → no diff to apply.
                if (want.size === current.size) {
                    let same = true;
                    for (const id of want) {
                        if (!current.has(id)) {
                            same = false;
                            break;
                        }
                    }
                    if (same) return;
                }
                // Collapse first (frees layout space the new expansions may
                // want), then expand. applyExpansionToSim once at the end
                // covers both sides.
                let touched = false;
                for (const id of current) {
                    if (!want.has(id)) {
                        useGraphStore.getState().collapseFile(id);
                        dropSubtreeLayout(id);
                        // Release the sim pin set when this file was
                        // expanded — it's a small icon again and the
                        // layout should treat it like any other.
                        // EXCEPT user-pinned files: a user-drag pin
                        // is independent of expansion state and must
                        // outlive collapse.
                        const sim = layout.byId.get(id);
                        if (sim && !sim.userPinned) {
                            sim.fx = null;
                            sim.fy = null;
                        }
                        touched = true;
                    }
                }
                for (const id of want) {
                    if (!current.has(id)) {
                        void expandFileForSelection(id);
                        touched = true;
                    }
                }
                if (touched) applyExpansionToSim();
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
                window.removeEventListener("keydown", onShiftDown);
                window.removeEventListener("keyup", onShiftUp);
                window.removeEventListener("keydown", onPinKey);
                labelPool.destroy();
                directoryLabelPool.destroy();
                for (const pane of overlayPanes) pane.labels.destroy();
                app.ticker.remove(tickerCb);
                app.destroy(true, {children: true, texture: true});
                if (cameraApiRef) cameraApiRef.current = null;
            };
        })();

        return () => {
            disposed = true;
            cleanup?.();
        };
    }, [project]);

    return <div ref={containerRef} style={{position: "absolute", inset: 0, overflow: "hidden", cursor: "grab"}} />;
}

