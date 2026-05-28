// Per-file fractal d3-force layout for an expanded file's top-level AST
// statements. Mirrors the project-level force graph at AST-internal scale:
// nodes are the post-prune/post-collapse children of the SourceFile root,
// sized by their content-sized TreemapNode rects; links are intra-file
// `calls`/`extends`/`implements` semantic edges, each endpoint lifted to its
// top-level ancestor. A `squareBiasForce` equalizes the cluster's x/y
// ranges so the resulting bounding box is close to square — the file box
// is then padded to exact square in the renderer.
//
// The sim is settled synchronously (a fixed number of ticks then stopped)
// so the outer file-level simulation sees a stable size for each expanded
// file (no AST-sim ↔ file-sim feedback loop).

import {forceLink, forceManyBody, forceSimulation, forceX, forceY} from "d3-force";
import type {FileAstResponse, SemanticEdge} from "../api/types";
import type {Rect, TreemapLayout, TreemapNode} from "./treemap";

export interface SimAstNode {
    id: string;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    rect: Rect;
    tree: TreemapNode;
}

export interface SimAstLink {
    id: string;
    source: string | SimAstNode;
    target: string | SimAstNode;
}

// Settled bounds shared by every container's force layout — file root
// AND nested containers (classes / interfaces). The renderer reads this
// to draw the container as a circle and to translate sim coords into
// world coords.
export interface ContainerBounds {
    minX: number;
    minY: number;
    bboxW: number;
    bboxH: number;
    // Cluster centroid (the bbox center). The renderer maps this to the
    // container's world position when drawing.
    cx: number;
    cy: number;
    // Smallest radius around the centroid that encloses every member rect
    // corner. The container is drawn as a circle of (radius + rim).
    radius: number;
}

// A single force-laid-out container. The same shape powers both the file
// root (whose members are top-level statements) and nested containers
// (classes / interfaces, whose members are properties / methods /
// constructors). Nesting is currently one level deep (only top-level
// classes get their own layout); deeper nesting would just need the
// recursion to keep going.
export interface ContainerForceLayout {
    // AST id of the container — `tree.rootId` for the file root, the
    // class/interface node id for nested containers.
    containerId: string;
    nodes: SimAstNode[];
    links: SimAstLink[];
    byId: Map<string, SimAstNode>;
    bounds: ContainerBounds;
}

export interface AstForceLayout {
    // The file-root layout — equivalent to the previous flat shape,
    // kept at the top level for backward compatibility with the
    // renderer.
    nodes: SimAstNode[];
    links: SimAstLink[];
    byId: Map<string, SimAstNode>;
    bounds: ContainerBounds;
    // Nested force layouts keyed by AST container id. Currently
    // populated for top-level ClassDeclaration / InterfaceDeclaration
    // nodes whose members are arranged as their own fractal force
    // graph (instead of the bottom-up wrapped-row treemap that would
    // otherwise produce a tall vertical column for member-heavy
    // classes like lightspeed's Game).
    containers: Map<string, ContainerForceLayout>;
}

// Member-container kinds whose direct children get their OWN force
// layout (rather than the default treemap stacking). Each gets drawn
// as a circle, like the file circle but smaller.
const MEMBER_CONTAINER_KINDS = new Set(["ClassDeclaration", "InterfaceDeclaration"]);

function isMemberContainer(tn: TreemapNode): boolean {
    return MEMBER_CONTAINER_KINDS.has(tn.syntaxKind);
}

// Visual rim added between a nested container's member cluster radius
// and the drawn circle. The file's analogous constant FILE_RIM is owned
// by PixiCanvas; this one stays here because it factors into rect.w/h
// (mutated below) which the file-level force layout consumes.
const INNER_RIM = 8;

interface DirAstEdge {
    aId: string;
    bId: string;
    weight: number;
}

// --- tunables ----------------------------------------------------------
// AST-internal scale: nodes are small relative to the file-level sim, so
// charge, link distance, and collide pad are all considerably lower than
// the project-level defaults. Tune these for tighter or looser clusters.
const LINK_STRENGTH = 0.5;
const LINK_DISTANCE_FLOOR = 16;
const LINK_PAD = 2;
const CHARGE_STRENGTH = -10;
// AABB collide: padding on each side of the rect (effectively expands the
// box) before overlap resolution. Larger = more visual breathing room.
const COLLIDE_PAD = 4;
const COLLIDE_ITERS = 2;
const CALLS_X_STRENGTH = 0.16;
const CALLS_Y_STRENGTH = 0.12;
const INHERIT_Y_STRENGTH = 0.22;
// Actual compression toward (0, 0). forceCenter only TRANSLATES the centroid
// each tick — it doesn't size the cluster. Without an attractive force, the
// cluster sat at whatever the seed-ring spread + collide allowed (e.g.
// Dog.ts: 740x655 of mostly empty space). forceX/Y do attract per-node, so
// the cluster settles to the tightest packing collide permits.
const COMPRESS_STRENGTH = 0.05;
const SQUARE_STRENGTH = 0.06;
// Imports along the TOP arc of the file's boundary, exports along
// the BOTTOM arc. The arc radius is the LARGER of two constraints:
//   (a) "middleR + outerPad" — tight tangent to the middle content
//       so the file's boundary hugs whatever local stuff lives in
//       the middle.
//   (b) "(arc-length needed to fit N items) / π" — the floor
//       imposed by having to fit N items on the half-arc; if the
//       middle is tiny but imports are many and wide, the items
//       themselves force a bigger radius.
// When the items can't all fit at the outer ring, they spill INWARD
// onto concentric rings at radii (R - k·ringSpacing). The file's
// drawn boundary sits at the outermost ring; inner rings live
// inside it. There's no hard ring cap — for very wide files (50+
// imports) the rings stack as many deep as needed.
const IMPORT_EXPORT_ARC_STRENGTH = 0.45;
// Per-slot padding added to each node's rect width when computing
// arc length needed. Visual whitespace between slots within a ring.
const IMPORT_EXPORT_ARC_SLOT_PAD = 24;
// Radial distance between concentric rings. Slightly larger than a
// typical AST-node label height so successive rings have a clear
// gap rather than overlapping vertically.
const IMPORT_EXPORT_ARC_RING_SPACING = 80;
// Outward padding from the "middle radius" (the natural extent of
// non-arc nodes) before placing the OUTER ring. Kept small: the
// arc IS the file's visible boundary, so a fat gap between middle
// and arcs just bloats the file with empty space the user can see.
const IMPORT_EXPORT_ARC_OUTER_PAD = 10;
// Strength of the per-node "pull middle items to origin" force.
// MUST be stronger than the global compression / charge so a single
// dominant middle node (e.g. a file's one `contextBridge.expose...`
// call expression) actually parks at the centre rather than being
// shoved off by forceCenter's centroid-of-all-nodes adjustment —
// which previously pushed the middle UP when most other nodes were
// on the top arc, making the file's bounding circle balloon to
// accommodate the off-centre middle's corners.
const MIDDLE_CENTER_STRENGTH = 0.4;
const WEIGHT_CAP = 3;
const SETTLE_TICKS = 300;

function astCollideRadius(n: SimAstNode): number {
    return Math.hypot(n.rect.w, n.rect.h) * 0.55 + COLLIDE_PAD;
}

// AABB (rect-rect) collide. d3-force's stock forceCollide circumscribes each
// rect in a circle, which wastes the corner regions for boxy AST nodes — for
// Dog.ts that's roughly 56% of cluster area. This force resolves overlaps
// directly on the padded bounding boxes, pushing apart along the
// minimum-overlap axis so edges align cleanly rather than tangenting on
// circle perimeters. O(N²) but N here is per-file top-level statement count
// (typically <30), and we settle once offline per file.
function aabbCollideForce(pad: number, iterations: number) {
    let nodes: SimAstNode[] = [];
    function force(): void {
        for (let iter = 0; iter < iterations; iter++) {
            for (let i = 0; i < nodes.length; i++) {
                const a = nodes[i];
                for (let j = i + 1; j < nodes.length; j++) {
                    const b = nodes[j];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const minDx = (a.rect.w + b.rect.w) / 2 + pad;
                    const minDy = (a.rect.h + b.rect.h) / 2 + pad;
                    const ox = minDx - Math.abs(dx);
                    const oy = minDy - Math.abs(dy);
                    if (ox <= 0 || oy <= 0) continue;
                    // Resolve along the axis with smaller overlap so rects
                    // slide past each other on the short edge — yields aligned
                    // edges instead of corner-to-corner tangents.
                    if (ox < oy) {
                        const push = (ox * 0.5) * (dx >= 0 ? 1 : -1);
                        a.x -= push;
                        b.x += push;
                    } else {
                        const push = (oy * 0.5) * (dy >= 0 ? 1 : -1);
                        a.y -= push;
                        b.y += push;
                    }
                }
            }
        }
    }
    force.initialize = (n: SimAstNode[]): void => {
        nodes = n;
    };
    return force;
}

function fileIdOf(astId: string): string {
    const i = astId.lastIndexOf("#");
    return i <= 0 ? astId : astId.slice(0, i);
}

// Walk up `tree.byId.parentId` until we hit a direct child of
// `containerId` — that's the member containing this AST id. With
// `containerId = tree.rootId` this is the previous "lift to top-level
// statement" behaviour; with a class id it returns the property /
// method / constructor that owns the reference. Returns null if the id
// was pruned, doesn't exist, IS the container, or sits in a different
// container's subtree.
function liftToContainerChild(
    astId: string,
    containerId: string,
    tree: TreemapLayout,
): string | null {
    let cur: string | null = astId;
    for (let guard = 0; guard < 1024; guard++) {
        if (!cur) return null;
        const node = tree.byId.get(cur);
        if (!node) return null;
        if (node.parentId === containerId) return node.id;
        if (node.parentId == null) return null;
        cur = node.parentId;
    }
    return null;
}

// Same shape as `directionalForce` in layout.ts, retyped for SimAstNode
// (which carries `rect` instead of `width/height`). Equal/opposite nudges,
// only acts when ordering is violated — gentle by design.
function directionalAstForce(edges: readonly DirAstEdge[], axis: "x" | "y", strength: number) {
    let lookup = new Map<string, SimAstNode>();
    function force(alpha: number): void {
        for (const e of edges) {
            const a = lookup.get(e.aId);
            const b = lookup.get(e.bId);
            if (!a || !b) continue;
            const separation = astCollideRadius(a) + astCollideRadius(b);
            const aPos = axis === "x" ? a.x : a.y;
            const bPos = axis === "x" ? b.x : b.y;
            const deficit = separation - (bPos - aPos);
            if (deficit <= 0) continue; // already ordered with room to spare
            const w = Math.min(Math.sqrt(e.weight), WEIGHT_CAP);
            const push = strength * alpha * deficit * w * 0.5;
            if (axis === "x") {
                a.vx = (a.vx ?? 0) - push;
                b.vx = (b.vx ?? 0) + push;
            } else {
                a.vy = (a.vy ?? 0) - push;
                b.vy = (b.vy ?? 0) + push;
            }
        }
    }
    force.initialize = (nodes: SimAstNode[]): void => {
        lookup = new Map(nodes.map((n) => [n.id, n]));
    };
    return force;
}

// Arrange ImportDeclaration nodes along the TOP arc of the file's
// natural cluster boundary, and exported nodes (ExportDeclaration,
// ExportAssignment, or any node with `exported = true`) along the
// BOTTOM arc. Non-arc nodes — local helpers, statements, anything
// that's neither an import nor an export — settle in the middle via
// the existing forceCenter / forceX / forceY / charge stack.
//
// The arc radius adapts each tick to the spread of the non-arc
// "middle" nodes (so the arc sits just outside the natural middle
// cluster). When the middle is sparse — e.g. a barrel re-export
// file whose body is nothing but imports + exports — the radius
// is just big enough to fit the items on a half-arc.
//
// Slot assignment is by source order: the first import in the file
// goes to the leftmost slot of the top arc, the last import to the
// rightmost. Same for exports on the bottom. Stable across ticks
// because the underlying list order doesn't change during a
// simulation run.
// Plan for one half (top or bottom): the outer radius R, plus a
// list of rings each holding a slice of items. The OUTERMOST ring
// (index 0) sits at radius R; ring k sits at R − k · ringSpacing.
// The file's boundary radius is determined by the larger of the
// two halves' R.
interface ArcRingPlan {
    radius: number;
    rings: SimAstNode[][];
}

// Pack N items into concentric half-rings AROUND A TARGET MIDDLE.
// Algorithm:
//   1. The OUTER ring sits at max(middleR + outerPad, slotW / π).
//      The first term keeps the arc hugging the middle content; the
//      second guarantees the ring is big enough for at least one
//      item.
//   2. Items fill the outer ring first, then spill INWARD onto
//      ring k = 1 (radius R - ringSpacing), ring k = 2, etc. Each
//      inner ring fits fewer items as the radius shrinks.
//   3. If items don't fit even with all rings down to r = 0, bump
//      the outer radius by 10% and retry.
// The result: file size adapts to the BIGGER of the middle's
// natural extent or the items' minimum packing requirement —
// whichever dominates. For middle-dominated files (typical), the
// boundary hugs the middle tightly and items stack inward.
function planArcRings(
    items: SimAstNode[],
    slotPad: number,
    ringSpacing: number,
    middleR: number,
    outerPad: number,
): ArcRingPlan {
    const N = items.length;
    if (N === 0) return {radius: 0, rings: []};

    let maxW = 0;
    for (const n of items) {
        if (n.rect.w > maxW) maxW = n.rect.w;
    }
    const slotW = maxW + slotPad;

    // Outer radius starts at the tighter of "middle + small pad" or
    // "small enough to barely fit one slot at full half-arc".
    // Math: π·R >= slotW ⇒ R >= slotW / π for one slot to fit on a
    // half-arc.
    let R = Math.max(middleR + outerPad, slotW / Math.PI + 1);

    let rings: SimAstNode[][] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
        rings = [];
        let i = 0;
        let k = 0;
        while (i < N) {
            const r = R - k * ringSpacing;
            if (r <= 0) break;
            const cap = Math.floor((Math.PI * r) / slotW);
            if (cap <= 0) break;
            const take = Math.min(cap, N - i);
            rings.push(items.slice(i, i + take));
            i += take;
            k++;
        }
        if (i >= N) return {radius: R, rings};
        // Didn't fit — bump and retry. Bigger bump than before
        // because each retry is "find a feasible R", not "find the
        // optimum K".
        R *= 1.1;
        if (R > 1e6) break;
    }

    // Fallback: dump everything into a single oversized ring.
    let maxWFinal = 0;
    for (const n of items) {
        if (n.rect.w > maxWFinal) maxWFinal = n.rect.w;
    }
    const slotWFinal = maxWFinal + slotPad;
    return {radius: Math.max(R, (N * slotWFinal) / Math.PI), rings: [items.slice()]};
}

// Pulls every non-arc (middle) node directly to (0, 0) at strong
// strength. Replaces the global forceCenter(0, 0) for middle nodes:
// forceCenter pins the CENTROID of all nodes at origin, which means
// when most nodes live on a top arc (e.g. preload.ts: one middle
// expression + five imports), the centroid sits well below the
// middle node and forceCenter shifts everything UP to compensate —
// pushing the middle node off-centre and ballooning the file's
// bounding circle to reach around its now-off-axis corners. By
// pulling each middle node toward origin directly (and skipping
// arc nodes), the middle settles AT origin regardless of how the
// arcs are distributed.
function middleCenterForce(strength: number) {
    let middleNodes: SimAstNode[] = [];
    function force(alpha: number): void {
        for (const n of middleNodes) {
            n.vx = (n.vx ?? 0) + (-n.x) * alpha * strength;
            n.vy = (n.vy ?? 0) + (-n.y) * alpha * strength;
        }
    }
    force.initialize = (nodes: SimAstNode[]): void => {
        middleNodes = [];
        for (const n of nodes) {
            const k = n.tree.syntaxKind;
            if (k === "ImportDeclaration") continue;
            if (k === "ExportDeclaration" || k === "ExportAssignment") continue;
            if (n.tree.exported === true) continue;
            middleNodes.push(n);
        }
    };
    return force;
}

function importExportArcForce(
    strength: number,
    slotPad: number,
    ringSpacing: number,
    outerPad: number,
) {
    let importsPlan: ArcRingPlan = {radius: 0, rings: []};
    let exportsPlan: ArcRingPlan = {radius: 0, rings: []};
    let middleNodes: SimAstNode[] = [];

    function force(alpha: number): void {
        if (importsPlan.rings.length === 0 && exportsPlan.rings.length === 0) return;

        // Live middle radius — re-planning per tick adapts the arcs
        // outward if the middle has spread beyond the seed estimate.
        // Held to its starting size if smaller, since the plan
        // already accommodated that.
        let middleR = 0;
        for (const n of middleNodes) {
            const hw = n.rect.w / 2;
            const hh = n.rect.h / 2;
            const dx = Math.abs(n.x) + hw;
            const dy = Math.abs(n.y) + hh;
            const d = Math.hypot(dx, dy);
            if (d > middleR) middleR = d;
        }

        const applyHalf = (plan: ArcRingPlan, top: boolean): void => {
            if (plan.rings.length === 0) return;
            const K = plan.rings.length;
            // R is the larger of (the plan's radius) and (whatever the
            // live middle requires). The plan already considered
            // middleR_estimate; this just protects against the middle
            // settling larger than the estimate.
            const R = Math.max(plan.radius, middleR + outerPad);

            for (let k = 0; k < K; k++) {
                const r = R - k * ringSpacing;
                if (r <= 0) break;
                const ring = plan.rings[k];
                const N_k = ring.length;
                for (let j = 0; j < N_k; j++) {
                    const t = top
                        ? Math.PI + ((j + 1) / (N_k + 1)) * Math.PI
                        : (Math.PI * (N_k - j)) / (N_k + 1);
                    const tx = r * Math.cos(t);
                    const ty = r * Math.sin(t);
                    const n = ring[j];
                    n.vx = (n.vx ?? 0) + (tx - n.x) * alpha * strength;
                    n.vy = (n.vy ?? 0) + (ty - n.y) * alpha * strength;
                }
            }
        };

        applyHalf(importsPlan, true);
        applyHalf(exportsPlan, false);
    }

    force.initialize = (n: SimAstNode[]): void => {
        const importNodes: SimAstNode[] = [];
        const exportNodes: SimAstNode[] = [];
        middleNodes = [];
        for (const x of n) {
            if (x.tree.syntaxKind === "ImportDeclaration") {
                importNodes.push(x);
                continue;
            }
            const isExported =
                x.tree.syntaxKind === "ExportDeclaration" ||
                x.tree.syntaxKind === "ExportAssignment" ||
                x.tree.exported === true;
            if (isExported) {
                exportNodes.push(x);
                continue;
            }
            middleNodes.push(x);
        }
        // Estimate middleR from rect SIZES (positions haven't settled
        // at force-init time): treat middle nodes as a single
        // equivalent disc that contains all their area. This gives a
        // reasonable target the plan can compress around.
        let middleArea = 0;
        for (const mn of middleNodes) middleArea += mn.rect.w * mn.rect.h;
        const middleREstimate = middleArea > 0 ? Math.sqrt(middleArea / Math.PI) : 0;
        importsPlan = planArcRings(importNodes, slotPad, ringSpacing, middleREstimate, outerPad);
        exportsPlan = planArcRings(exportNodes, slotPad, ringSpacing, middleREstimate, outerPad);
    };
    return force;
}

// Equalize the cluster's x and y ranges toward their geometric mean: pull
// the wider axis inward (toward 0, the cluster center) and the narrower
// axis outward. forceCenter(0,0) cooperates by holding the cluster
// centered, so "toward 0" reads as "toward the centroid."
function squareBiasForce(strength: number) {
    let nodes: SimAstNode[] = [];
    function force(alpha: number): void {
        if (nodes.length < 2) return;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const n of nodes) {
            const hw = n.rect.w / 2;
            const hh = n.rect.h / 2;
            if (n.x - hw < minX) minX = n.x - hw;
            if (n.x + hw > maxX) maxX = n.x + hw;
            if (n.y - hh < minY) minY = n.y - hh;
            if (n.y + hh > maxY) maxY = n.y + hh;
        }
        const rx = maxX - minX;
        const ry = maxY - minY;
        if (rx <= 0 || ry <= 0) return;
        const target = Math.sqrt(rx * ry);
        const kx = (rx / target - 1) * strength * alpha;
        const ky = (ry / target - 1) * strength * alpha;
        for (const n of nodes) {
            n.vx = (n.vx ?? 0) - n.x * kx;
            n.vy = (n.vy ?? 0) - n.y * ky;
        }
    }
    force.initialize = (n: SimAstNode[]): void => {
        nodes = n;
    };
    return force;
}

function linkDistance(link: SimAstLink): number {
    const s = typeof link.source === "string" ? null : link.source;
    const t = typeof link.target === "string" ? null : link.target;
    if (!s || !t) return LINK_DISTANCE_FLOOR;
    return Math.max(LINK_DISTANCE_FLOOR, astCollideRadius(s) + astCollideRadius(t) + LINK_PAD);
}

function buildDirEdges(
    edges: readonly SemanticEdge[],
    fileId: string,
    containerId: string,
    tree: TreemapLayout,
    kinds: ReadonlySet<SemanticEdge["kind"]>,
    pick: (e: SemanticEdge) => {aId: string; bId: string},
    byId: ReadonlyMap<string, SimAstNode>,
): DirAstEdge[] {
    const byPair = new Map<string, DirAstEdge>();
    for (const e of edges) {
        if (!kinds.has(e.kind)) continue;
        if (fileIdOf(e.fromId) !== fileId || fileIdOf(e.toId) !== fileId) continue;
        const sel = pick(e);
        const a = liftToContainerChild(sel.aId, containerId, tree);
        const b = liftToContainerChild(sel.bId, containerId, tree);
        if (!a || !b || a === b) continue;
        if (!byId.has(a) || !byId.has(b)) continue;
        const key = `${a} ${b}`;
        const existing = byPair.get(key);
        if (existing) existing.weight += 1;
        else byPair.set(key, {aId: a, bId: b, weight: 1});
    }
    return [...byPair.values()];
}

export interface BuildAstForceOpts {
    fileId: string;
    ast: FileAstResponse;
    tree: TreemapLayout;
    semanticEdges: readonly SemanticEdge[];
}

// Settle a force layout for the direct children of `containerId`. Used
// at two scales:
//   - containerId = tree.rootId, members = top-level statements → the
//     file-root layout (file is drawn as a big circle).
//   - containerId = class/interface id, members = properties / methods
//     / constructor → a nested layout (class drawn as a smaller circle).
// At the inner scale most of the "import bias" plumbing is just a no-op
// (members aren't ImportDeclarations) — we keep the same force chain
// rather than fork it.
function buildContainerForceLayout(
    containerId: string,
    members: readonly TreemapNode[],
    tree: TreemapLayout,
    semanticEdges: readonly SemanticEdge[],
    fileId: string,
): ContainerForceLayout {
    // Seed in a small ring so the sim has something to spread out;
    // spread scales with the largest member's diagonal so neighbours
    // aren't on top of each other before the first tick.
    let maxDiag = 0;
    for (const tn of members) {
        const d = Math.hypot(tn.rect.w, tn.rect.h);
        if (d > maxDiag) maxDiag = d;
    }
    const spread = Math.max(60, maxDiag * 0.8);

    // Pre-seed positions matching where each node will be PULLED to.
    // For imports / exports this means computing the multi-ring plan
    // up-front and seeding each item at its assigned (ring, slot)
    // target — otherwise the force has to drag wide items through
    // the middle cluster against collide, distending the layout
    // before it settles into its planned arrangement.
    const isExportedTopLevel = (tn: TreemapNode): boolean =>
        tn.syntaxKind === "ExportDeclaration" ||
        tn.syntaxKind === "ExportAssignment" ||
        tn.exported === true;
    const importMembers: TreemapNode[] = [];
    const exportMembers: TreemapNode[] = [];
    const middleMembers: TreemapNode[] = [];
    for (const tn of members) {
        if (tn.syntaxKind === "ImportDeclaration") importMembers.push(tn);
        else if (isExportedTopLevel(tn)) exportMembers.push(tn);
        else middleMembers.push(tn);
    }

    // Estimate middle's natural extent from rect SIZES so the seed
    // plan can place arcs at the right radius from the start — same
    // formula the force uses at initialize time. Equivalent-disc
    // area: a single circle that contains the same area as all
    // middle nodes' rects combined. For two 800×800 const objects +
    // a small interface that's ~640.
    let seedMiddleArea = 0;
    for (const tn of middleMembers) seedMiddleArea += tn.rect.w * tn.rect.h;
    const seedMiddleR = seedMiddleArea > 0 ? Math.sqrt(seedMiddleArea / Math.PI) : 0;

    // Seed plan uses the same packing algorithm the force runs at
    // initialize. Treat each TreemapNode as if it were a SimAstNode
    // for the purpose of reading rect.w — the packer only needs
    // .rect.w from each item.
    const seedImports = planArcRings(
        importMembers.map((tn) => ({id: tn.id, rect: tn.rect, x: 0, y: 0, tree: tn})),
        IMPORT_EXPORT_ARC_SLOT_PAD,
        IMPORT_EXPORT_ARC_RING_SPACING,
        seedMiddleR,
        IMPORT_EXPORT_ARC_OUTER_PAD,
    );
    const seedExports = planArcRings(
        exportMembers.map((tn) => ({id: tn.id, rect: tn.rect, x: 0, y: 0, tree: tn})),
        IMPORT_EXPORT_ARC_SLOT_PAD,
        IMPORT_EXPORT_ARC_RING_SPACING,
        seedMiddleR,
        IMPORT_EXPORT_ARC_OUTER_PAD,
    );

    // Build id → (x, y) seed map by walking each plan's rings.
    const seedPosById = new Map<string, {x: number; y: number}>();
    const seedHalf = (plan: ArcRingPlan, top: boolean): void => {
        const R = plan.radius;
        for (let k = 0; k < plan.rings.length; k++) {
            const r = R - k * IMPORT_EXPORT_ARC_RING_SPACING;
            const ring = plan.rings[k];
            const N_k = ring.length;
            for (let j = 0; j < N_k; j++) {
                const t = top
                    ? Math.PI + ((j + 1) / (N_k + 1)) * Math.PI
                    : (Math.PI * (N_k - j)) / (N_k + 1);
                seedPosById.set(ring[j].id, {x: r * Math.cos(t), y: r * Math.sin(t)});
            }
        }
    };
    seedHalf(seedImports, true);
    seedHalf(seedExports, false);

    let mi = 0;
    const nodes: SimAstNode[] = members.map((tn) => {
        const seeded = seedPosById.get(tn.id);
        if (seeded) {
            return {id: tn.id, x: seeded.x, y: seeded.y, rect: tn.rect, tree: tn};
        }
        // Middle nodes — small ring near origin so charge spreads
        // them without an initial pile-up.
        const angle = mi * 2.4;
        mi++;
        return {
            id: tn.id,
            x: Math.cos(angle) * (spread * 0.4),
            y: Math.sin(angle) * (spread * 0.4),
            rect: tn.rect,
            tree: tn,
        };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Sim links: every intra-file calls/extends/implements edge whose
    // lifted endpoints are two distinct DIRECT CHILDREN of this
    // container. Deduped per (kind, a, b).
    const links: SimAstLink[] = [];
    const seen = new Set<string>();
    let linkSeq = 0;
    for (const e of semanticEdges) {
        if (e.kind !== "calls" && e.kind !== "extends" && e.kind !== "implements") {
            continue;
        }
        if (fileIdOf(e.fromId) !== fileId || fileIdOf(e.toId) !== fileId) continue;
        const a = liftToContainerChild(e.fromId, containerId, tree);
        const b = liftToContainerChild(e.toId, containerId, tree);
        if (!a || !b || a === b) continue;
        if (!byId.has(a) || !byId.has(b)) continue;
        const key = `${e.kind}|${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({id: `astl-${linkSeq++}`, source: a, target: b});
    }

    const callEdges = buildDirEdges(semanticEdges, fileId, containerId, tree, new Set(["calls"]), (e) => ({aId: e.fromId, bId: e.toId}), byId);
    const inheritEdges = buildDirEdges(semanticEdges, fileId, containerId, tree, new Set(["extends", "implements"]), (e) => ({aId: e.toId, bId: e.fromId}), byId);

    const simulation = forceSimulation<SimAstNode>(nodes)
        .force(
            "link",
            forceLink<SimAstNode, SimAstLink>(links)
                .id((d) => d.id)
                .distance(linkDistance)
                .strength(LINK_STRENGTH),
        )
        .force("charge", forceManyBody<SimAstNode>().strength(CHARGE_STRENGTH))
        // No forceCenter — it would pull the CENTROID of all nodes
        // (middle + arc) to origin, which means a file with a
        // top-heavy distribution (lots of imports, few middle
        // statements) pushes the middle UP to compensate. We use
        // `middleCenter` below to pull the MIDDLE NODES specifically
        // to origin so they stay centred regardless of the arc
        // distribution.
        .force("middleCenter", middleCenterForce(MIDDLE_CENTER_STRENGTH))
        .force("x", forceX<SimAstNode>(0).strength(COMPRESS_STRENGTH))
        .force("y", forceY<SimAstNode>(0).strength(COMPRESS_STRENGTH))
        .force("importExportArc", importExportArcForce(
            IMPORT_EXPORT_ARC_STRENGTH,
            IMPORT_EXPORT_ARC_SLOT_PAD,
            IMPORT_EXPORT_ARC_RING_SPACING,
            IMPORT_EXPORT_ARC_OUTER_PAD,
        ))
        .force("collide", aabbCollideForce(COLLIDE_PAD, COLLIDE_ITERS))
        .force("callsX", directionalAstForce(callEdges, "x", CALLS_X_STRENGTH))
        .force("callsY", directionalAstForce(callEdges, "y", CALLS_Y_STRENGTH))
        .force("inheritY", directionalAstForce(inheritEdges, "y", INHERIT_Y_STRENGTH))
        .force("square", squareBiasForce(SQUARE_STRENGTH))
        .alpha(1)
        .alphaDecay(0.035)
        .stop();

    for (let i = 0; i < SETTLE_TICKS; i++) simulation.tick();
    simulation.stop();

    // Cluster bounding box from settled positions + rect extents.
    // Middle nodes contribute their full footprint (corners are
    // inside the file). Arc nodes (imports / exports) contribute
    // only their CENTRE — their visual position is on the file's
    // boundary, and their corners are allowed to extend past the
    // drawn border (the user's "centres on border" requirement).
    const arcIdSet = new Set<string>();
    for (const tn of importMembers) arcIdSet.add(tn.id);
    for (const tn of exportMembers) arcIdSet.add(tn.id);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
        if (arcIdSet.has(n.id)) {
            // Centre-only for arc nodes.
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        } else {
            const hw = n.rect.w / 2;
            const hh = n.rect.h / 2;
            if (n.x - hw < minX) minX = n.x - hw;
            if (n.x + hw > maxX) maxX = n.x + hw;
            if (n.y - hh < minY) minY = n.y - hh;
            if (n.y + hh > maxY) maxY = n.y + hh;
        }
    }
    if (!Number.isFinite(minX)) {
        minX = 0;
        maxX = 0;
        minY = 0;
        maxY = 0;
    }
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const cx = minX + bboxW / 2;
    const cy = minY + bboxH / 2;

    let radius = 0;
    for (const n of nodes) {
        if (arcIdSet.has(n.id)) {
            // Arc node: distance to its CENTRE defines the boundary
            // it sits on. Corners are allowed past this.
            const d = Math.hypot(n.x - cx, n.y - cy);
            if (d > radius) radius = d;
        } else {
            const hw = n.rect.w / 2;
            const hh = n.rect.h / 2;
            const dxAbs = Math.abs(n.x - cx) + hw;
            const dyAbs = Math.abs(n.y - cy) + hh;
            const d = Math.hypot(dxAbs, dyAbs);
            if (d > radius) radius = d;
        }
    }

    return {
        containerId,
        nodes,
        links,
        byId,
        bounds: {minX, minY, bboxW, bboxH, cx, cy, radius},
    };
}

export function buildAstForceLayout(opts: BuildAstForceOpts): AstForceLayout {
    const {fileId, tree, semanticEdges} = opts;
    const topLevel = tree.childrenByParent.get(tree.rootId) ?? [];
    const containers = new Map<string, ContainerForceLayout>();

    // FIRST: nested containers (top-level classes / interfaces). We
    // build each one's member force layout, then MUTATE the container's
    // treemap rect to fit a circle around the cluster — so the
    // file-root layout below sees the correctly-sized container rect
    // rather than the bottom-up wrapped-row treemap size. Member
    // rect.x/y is also overridden to the force-decided position
    // relative to the container's top-left, so drawAstNode's existing
    // (baseX + node.rect.x, baseY + node.rect.y) recursion just works.
    for (const tn of topLevel) {
        if (!isMemberContainer(tn)) continue;
        const memberNodes = tree.childrenByParent.get(tn.id) ?? [];
        if (memberNodes.length === 0) continue;

        const sub = buildContainerForceLayout(
            tn.id,
            memberNodes,
            tree,
            semanticEdges,
            fileId,
        );
        containers.set(tn.id, sub);

        // Resize the container's treemap rect to encompass the cluster
        // circle (plus visual rim). The file-root force layout below
        // sees this updated rect and treats the class as the compact
        // square node it now draws as, instead of the 18:1-tall column
        // the wrapped-row treemap produced for member-heavy classes
        // like Game. Members' rect.x/y are NOT mutated — treemap rects
        // are file-absolute and mutating a member position would
        // strand its descendants. drawAstNode reads sub.byId at render
        // time and applies a per-member translation via the recursion
        // baseX/baseY instead.
        const diameter = 2 * (sub.bounds.radius + INNER_RIM);
        tn.rect.w = diameter;
        tn.rect.h = diameter;
    }

    // THEN: file-root layout. Uses the (possibly updated) top-level
    // rects so a member-heavy class is treated as a compact ~square
    // node rather than a 18:1-tall vertical column.
    const root = buildContainerForceLayout(
        tree.rootId,
        topLevel,
        tree,
        semanticEdges,
        fileId,
    );

    return {
        nodes: root.nodes,
        links: root.links,
        byId: root.byId,
        bounds: root.bounds,
        containers,
    };
}
