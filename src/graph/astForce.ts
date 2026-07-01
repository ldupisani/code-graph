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
const MEMBER_CONTAINER_KINDS = new Set(["ClassDeclaration", "InterfaceDeclaration", "ClassDef"]);

function isMemberContainer(tn: TreemapNode): boolean {
    return MEMBER_CONTAINER_KINDS.has(tn.syntaxKind);
}

// Import-statement kinds, arranged along the file's TOP arc when expanded.
// TS: ImportDeclaration. Python: Import (`import x`) / ImportFrom (`from x
// import y`). Keeping them in one predicate means a Python file's imports band
// across the top exactly like a TypeScript file's.
const IMPORT_KINDS = new Set(["ImportDeclaration", "Import", "ImportFrom"]);

function isImportKind(kind: string): boolean {
    return IMPORT_KINDS.has(kind);
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
// Slot assignment is by WIDTH, not source order: wide items sit near
// the apex where the arc runs flat enough to host them, narrow items
// tuck into the steep ends where only short footprints fit. Stable
// across ticks because the width sort is deterministic (ties keep
// source order) and the list doesn't change during a simulation run.
// Plan for one half (top or bottom): the outer radius R plus explicit
// slot placements — (ring index, fraction along the half-arc) per
// item. Ring k sits at radius R − k · ringSpacing; the OUTERMOST ring
// (index 0) is the file's drawn boundary. Plans are computed in the
// TOP-half frame (negative y above the centre); a bottom-half plan is
// the same thing mirrored y → −y, so callers mirror their obstacle
// rects rather than the plan.
interface ArcSlot {
    node: SimAstNode;
    ring: number;
    frac: number;
}

interface ArcRingPlan {
    radius: number;
    slots: ArcSlot[];
    // Half the height of the half's shortest item: how far past its
    // ring radius a node's outer edge may poke. A single-row import
    // straddles the arc exactly as before; taller multi-specifier
    // panels are pushed inward so they overhang the boundary by the
    // same visual margin instead of escaping by their full half
    // height.
    overhang: number;
}

// Axis-aligned rect by centre + half-extents, used for the planner's
// exact overlap tests.
interface PlanRect {
    cx: number;
    cy: number;
    hw: number;
    hh: number;
}

// Centre of a node placed at `frac` along the half-arc of ring radius
// ringR inside boundary radius R, in the TOP-half frame. The node is
// pulled inward off the ring just enough that its outer extent pokes
// past the ring by `overhang` — so a tall panel at the apex or a wide
// box at a steep side tucks INSIDE the boundary instead of straddling
// it by its own half extent.
function slotCenter(
    n: {rect: {w: number; h: number}},
    frac: number,
    ringR: number,
    R: number,
    overhang: number,
): {x: number; y: number} {
    const t = Math.PI + frac * Math.PI;
    const ux = Math.cos(t);
    const uy = Math.sin(t);
    const radialHalf = (n.rect.w * Math.abs(ux) + n.rect.h * Math.abs(uy)) / 2;
    const rEff = Math.max(0, Math.min(ringR, R - radialHalf + overhang));
    return {x: rEff * ux, y: rEff * uy};
}

function rectAtSlot(
    n: {rect: {w: number; h: number}},
    frac: number,
    ringR: number,
    R: number,
    overhang: number,
): PlanRect {
    const c = slotCenter(n, frac, ringR, R, overhang);
    return {cx: c.x, cy: c.y, hw: n.rect.w / 2, hh: n.rect.h / 2};
}

function rectsClear(a: PlanRect, b: PlanRect, pad: number): boolean {
    return (
        Math.abs(a.cx - b.cx) >= a.hw + b.hw + pad ||
        Math.abs(a.cy - b.cy) >= a.hh + b.hh + pad
    );
}

function nodeRects(nodes: readonly SimAstNode[]): PlanRect[] {
    return nodes.map((m) => ({
        cx: m.x,
        cy: m.y,
        hw: m.rect.w / 2,
        hh: m.rect.h / 2,
    }));
}

function mirrorRects(rects: readonly PlanRect[]): PlanRect[] {
    return rects.map((r) => ({...r, cy: -r.cy}));
}

// Greedy exact 2-D placement: items go widest-first; each takes the
// outermost ring with a free slot, sweeping from the apex outward
// (alternating sides) in ~12px arc steps until its rect clears every
// previously placed rect AND every obstacle (the middle content, and
// for the bottom half the already-planned top half). Exact AABB tests
// replace the 1-D arc-length models tried before, all of which had a
// systematic bias somewhere on the arc: charging width everywhere
// overbilled the steep sides ~4–10× (vertical voids beside React /
// Pill), the tangent projection let wide boxes jut inward through the
// middle content (collide then scattered them), and the bounding
// wedge blocked whole quadrants per item. Widest-first means wide
// items get the flat apex while narrow ones tuck into the steep ends.
// Returns null when some item fits on no ring at this R.
function tryPlaceAll(
    items: SimAstNode[],
    R: number,
    slotPad: number,
    ringSpacing: number,
    overhang: number,
    obstacles: readonly PlanRect[],
): ArcSlot[] | null {
    // Stable sort: equal widths keep source order, so re-plans are
    // deterministic.
    const desc = [...items].sort((a, b) => b.rect.w - a.rect.w);
    const placed: PlanRect[] = [];
    const slots: ArcSlot[] = [];
    for (const n of desc) {
        let done = false;
        for (let k = 0; !done; k++) {
            const r = R - k * ringSpacing;
            if (r <= 0) break;
            const df = Math.max(0.002, 12 / (Math.PI * r));
            for (let off = 0; off <= 0.5 + 1e-9 && !done; off += df) {
                for (const frac of off === 0 ? [0.5] : [0.5 - off, 0.5 + off]) {
                    if (frac < 0 || frac > 1) continue;
                    const rect = rectAtSlot(n, frac, r, R, overhang);
                    if (!placed.every((p) => rectsClear(rect, p, slotPad))) continue;
                    if (!obstacles.every((o) => rectsClear(rect, o, slotPad))) continue;
                    placed.push(rect);
                    slots.push({node: n, ring: k, frac});
                    done = true;
                    break;
                }
            }
        }
        if (!done) return null;
    }
    return slots;
}

// Find a feasible outer radius + slot placement for one half's items.
// R starts tangent to the middle content and grows 10% per attempt
// until everything fits — file size adapts to the BIGGER of the
// middle's natural extent or the items' packing requirement.
function planArcRings(
    items: SimAstNode[],
    slotPad: number,
    ringSpacing: number,
    middleR: number,
    outerPad: number,
    obstacles: readonly PlanRect[],
): ArcRingPlan {
    if (items.length === 0) return {radius: 0, slots: [], overhang: 0};

    let maxW = 0;
    let minH = Infinity;
    for (const n of items) {
        if (n.rect.w > maxW) maxW = n.rect.w;
        if (n.rect.h < minH) minH = n.rect.h;
    }
    const overhang = minH / 2;
    let R = Math.max(middleR + outerPad, (maxW + slotPad) / Math.PI + 1);

    for (let attempt = 0; attempt < 50; attempt++) {
        const slots = tryPlaceAll(items, R, slotPad, ringSpacing, overhang, obstacles);
        if (slots) return {radius: R, slots, overhang};
        R *= 1.1;
        if (R > 1e6) break;
    }

    // Fallback: uniform spacing on the outer ring; overlaps are the
    // collide force's problem.
    return {
        radius: R,
        slots: items.map((n, j) => ({
            node: n,
            ring: 0,
            frac: (j + 1) / (items.length + 1),
        })),
        overhang,
    };
}

// A plan's placed rects, mirrored into the OTHER half's frame — so the
// bottom-half (exports) plan can treat the top half (imports) as
// obstacles where the two halves meet at the circle's sides.
function planRectsMirrored(plan: ArcRingPlan, ringSpacing: number): PlanRect[] {
    const out: PlanRect[] = [];
    for (const s of plan.slots) {
        const r = plan.radius - s.ring * ringSpacing;
        if (r <= 0) continue;
        const rect = rectAtSlot(s.node, s.frac, r, plan.radius, plan.overhang);
        out.push({...rect, cy: -rect.cy});
    }
    return out;
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
            if (isImportKind(k)) continue;
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
    let importsPlan: ArcRingPlan = {radius: 0, slots: [], overhang: 0};
    let exportsPlan: ArcRingPlan = {radius: 0, slots: [], overhang: 0};
    let importNodes: SimAstNode[] = [];
    let exportNodes: SimAstNode[] = [];
    let middleNodes: SimAstNode[] = [];

    function force(alpha: number): void {
        if (importsPlan.slots.length === 0 && exportsPlan.slots.length === 0) return;

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

        // Re-plan both halves when the live middle has outgrown the
        // radius the plans were packed for (the planned slots were
        // squeezed around a SMALLER middle — keeping them while the
        // drawn arc grows leaves the outer arc half empty), using the
        // middle's LIVE rects as obstacles so wide items never get
        // planned through actual content. Both halves go together
        // because exports treat the planned imports as obstacles. The
        // 1.02 hysteresis avoids re-packing every tick while the
        // middle jitters around its settled size.
        const grown = (plan: ArcRingPlan): boolean =>
            plan.slots.length > 0 && middleR + outerPad > plan.radius * 1.02;
        if (grown(importsPlan) || grown(exportsPlan)) {
            const middleRects = nodeRects(middleNodes);
            importsPlan = planArcRings(
                importNodes, slotPad, ringSpacing, middleR, outerPad, middleRects,
            );
            exportsPlan = planArcRings(
                exportNodes, slotPad, ringSpacing, middleR, outerPad,
                mirrorRects(middleRects).concat(planRectsMirrored(importsPlan, ringSpacing)),
            );
        }

        const applyHalf = (plan: ArcRingPlan, top: boolean): void => {
            if (plan.slots.length === 0) return;
            // R is the larger of (the plan's radius) and (whatever the
            // live middle requires). The plan already considered
            // middleR_estimate; this just protects against the middle
            // settling larger than the estimate.
            const R = Math.max(plan.radius, middleR + outerPad);

            for (const slot of plan.slots) {
                const r = R - slot.ring * ringSpacing;
                if (r <= 0) continue;
                const c = slotCenter(slot.node, slot.frac, r, R, plan.overhang);
                const tx = c.x;
                const ty = top ? c.y : -c.y;
                const n = slot.node;
                n.vx = (n.vx ?? 0) + (tx - n.x) * alpha * strength;
                n.vy = (n.vy ?? 0) + (ty - n.y) * alpha * strength;
            }
        };

        applyHalf(importsPlan, true);
        applyHalf(exportsPlan, false);
    }

    force.initialize = (n: SimAstNode[]): void => {
        importNodes = [];
        exportNodes = [];
        middleNodes = [];
        for (const x of n) {
            if (isImportKind(x.tree.syntaxKind)) {
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
        // reasonable target the plan can compress around. Obstacle
        // rects use the seed positions — rough, but the live re-plan
        // in force() corrects against real positions as they settle.
        let middleArea = 0;
        for (const mn of middleNodes) middleArea += mn.rect.w * mn.rect.h;
        const middleREstimate = middleArea > 0 ? Math.sqrt(middleArea / Math.PI) : 0;
        const middleRects = nodeRects(middleNodes);
        importsPlan = planArcRings(
            importNodes, slotPad, ringSpacing, middleREstimate, outerPad, middleRects,
        );
        exportsPlan = planArcRings(
            exportNodes, slotPad, ringSpacing, middleREstimate, outerPad,
            mirrorRects(middleRects).concat(planRectsMirrored(importsPlan, ringSpacing)),
        );
    };
    return force;
}

// Equalize the cluster's x and y ranges toward their geometric mean: pull
// the wider axis inward (toward 0, the cluster center) and the narrower
// axis outward. forceCenter(0,0) cooperates by holding the cluster
// centered, so "toward 0" reads as "toward the centroid."
//
// Deliberately NOT scaled by `alpha`: this is a shape constraint, not a
// settling force, and it competes every tick against `aabbCollideForce`
// (also alpha-independent — see its comment). For wide-short leaf boxes,
// collide's min-overlap-axis heuristic resolves along y far more often
// than x, so a growing file (50+ top-level members) keeps stacking
// vertically tick after tick. If this force faded with alpha like the
// rest of the stack, it could only counteract that stacking during the
// first few ticks — by mid-settle collide would win outright and the
// cluster would end up a tall column with empty space on both sides.
function squareBiasForce(strength: number) {
    let nodes: SimAstNode[] = [];
    function force(): void {
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
        const kx = (rx / target - 1) * strength;
        const ky = (ry / target - 1) * strength;
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
        if (isImportKind(tn.syntaxKind)) importMembers.push(tn);
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

    // Middle seeds first — a small ring near origin so charge spreads
    // them without an initial pile-up — because the arc plans need
    // them as obstacle rects.
    const middleSeedById = new Map<string, {x: number; y: number}>();
    const middleSeedRects: PlanRect[] = [];
    middleMembers.forEach((tn, i) => {
        const angle = i * 2.4;
        const x = Math.cos(angle) * (spread * 0.4);
        const y = Math.sin(angle) * (spread * 0.4);
        middleSeedById.set(tn.id, {x, y});
        middleSeedRects.push({cx: x, cy: y, hw: tn.rect.w / 2, hh: tn.rect.h / 2});
    });

    // Seed plan uses the same packing algorithm the force runs at
    // initialize. Treat each TreemapNode as if it were a SimAstNode
    // for the purpose of reading rect.w — the packer only needs
    // .rect from each item.
    const toSim = (tn: TreemapNode): SimAstNode => ({
        id: tn.id,
        rect: tn.rect,
        x: 0,
        y: 0,
        tree: tn,
    });
    const seedImports = planArcRings(
        importMembers.map(toSim),
        IMPORT_EXPORT_ARC_SLOT_PAD,
        IMPORT_EXPORT_ARC_RING_SPACING,
        seedMiddleR,
        IMPORT_EXPORT_ARC_OUTER_PAD,
        middleSeedRects,
    );
    const seedExports = planArcRings(
        exportMembers.map(toSim),
        IMPORT_EXPORT_ARC_SLOT_PAD,
        IMPORT_EXPORT_ARC_RING_SPACING,
        seedMiddleR,
        IMPORT_EXPORT_ARC_OUTER_PAD,
        mirrorRects(middleSeedRects).concat(
            planRectsMirrored(seedImports, IMPORT_EXPORT_ARC_RING_SPACING),
        ),
    );

    // Build id → (x, y) seed map from each plan's slots.
    const seedPosById = new Map<string, {x: number; y: number}>();
    const seedHalf = (plan: ArcRingPlan, top: boolean): void => {
        for (const slot of plan.slots) {
            const r = plan.radius - slot.ring * IMPORT_EXPORT_ARC_RING_SPACING;
            if (r <= 0) continue;
            const c = slotCenter(slot.node, slot.frac, r, plan.radius, plan.overhang);
            seedPosById.set(slot.node.id, {x: c.x, y: top ? c.y : -c.y});
        }
    };
    seedHalf(seedImports, true);
    seedHalf(seedExports, false);

    const nodes: SimAstNode[] = members.map((tn) => {
        const seeded = seedPosById.get(tn.id) ?? middleSeedById.get(tn.id);
        return {
            id: tn.id,
            x: seeded?.x ?? 0,
            y: seeded?.y ?? 0,
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

    // Final snap: re-plan both arcs against the SETTLED middle and
    // set arc nodes directly onto their slots. During the settle,
    // plans are built from in-flight middle positions and only
    // refresh when the middle's radius GROWS — a plan locked against
    // a transient sprawl never heals, leaving items parked on inner
    // rings while the outer arc has free room. The post-settle plan
    // sees the real obstacle geometry, and its slots are
    // collision-free by construction, so direct assignment is safe.
    const importIdSet = new Set(importMembers.map((tn) => tn.id));
    const exportIdSet = new Set(exportMembers.map((tn) => tn.id));
    const importSim = nodes.filter((n) => importIdSet.has(n.id));
    const exportSim = nodes.filter((n) => exportIdSet.has(n.id));
    const middleSim = nodes.filter(
        (n) => !importIdSet.has(n.id) && !exportIdSet.has(n.id),
    );
    let settledMiddleR = 0;
    for (const m of middleSim) {
        const d = Math.hypot(
            Math.abs(m.x) + m.rect.w / 2,
            Math.abs(m.y) + m.rect.h / 2,
        );
        if (d > settledMiddleR) settledMiddleR = d;
    }
    const settledMiddleRects = nodeRects(middleSim);
    // Both halves must lie on ONE circle — the drawn boundary is a
    // single circle through the arc slots. Planning each half at its
    // own feasible radius (imports usually need a bigger R than the
    // lone default export) shifted the bbox-derived boundary off the
    // cluster's origin, which read as all content sagging downward
    // inside the circle. So: plan imports, start exports at the
    // imports' radius, and if exports still needed more room re-plan
    // both at the larger radius.
    let snapImports = planArcRings(
        importSim,
        IMPORT_EXPORT_ARC_SLOT_PAD,
        IMPORT_EXPORT_ARC_RING_SPACING,
        settledMiddleR,
        IMPORT_EXPORT_ARC_OUTER_PAD,
        settledMiddleRects,
    );
    const snapExportsAt = (floorR: number): ArcRingPlan =>
        planArcRings(
            exportSim,
            IMPORT_EXPORT_ARC_SLOT_PAD,
            IMPORT_EXPORT_ARC_RING_SPACING,
            Math.max(settledMiddleR, floorR - IMPORT_EXPORT_ARC_OUTER_PAD),
            IMPORT_EXPORT_ARC_OUTER_PAD,
            mirrorRects(settledMiddleRects).concat(
                planRectsMirrored(snapImports, IMPORT_EXPORT_ARC_RING_SPACING),
            ),
        );
    let snapExports = snapExportsAt(snapImports.radius);
    if (snapExports.radius > snapImports.radius && importSim.length > 0) {
        snapImports = planArcRings(
            importSim,
            IMPORT_EXPORT_ARC_SLOT_PAD,
            IMPORT_EXPORT_ARC_RING_SPACING,
            snapExports.radius - IMPORT_EXPORT_ARC_OUTER_PAD,
            IMPORT_EXPORT_ARC_OUTER_PAD,
            settledMiddleRects,
        );
        snapExports = snapExportsAt(snapImports.radius);
    }
    const snapHalf = (plan: ArcRingPlan, top: boolean): void => {
        for (const slot of plan.slots) {
            const r = plan.radius - slot.ring * IMPORT_EXPORT_ARC_RING_SPACING;
            if (r <= 0) continue;
            const c = slotCenter(slot.node, slot.frac, r, plan.radius, plan.overhang);
            slot.node.x = c.x;
            slot.node.y = top ? c.y : -c.y;
        }
    };
    snapHalf(snapImports, true);
    snapHalf(snapExports, false);

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

    // The cluster's true centre is the ORIGIN: middleCenterForce
    // pulls the middle there and both arc halves are planned around
    // it on a shared radius. Deriving the circle centre from the
    // bbox let any asymmetry — one-sided arcs, content hanging low —
    // shift the drawn boundary off the cluster, reading as a uniform
    // y-offset of everything inside it. The radius is the shared arc
    // circle, or for arc-less containers (classes) whatever covers
    // the middle's corners.
    const cx = 0;
    const cy = 0;
    let radius = Math.max(snapImports.radius, snapExports.radius);
    if (settledMiddleR > radius) radius = settledMiddleR;

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
