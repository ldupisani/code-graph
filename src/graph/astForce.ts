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

import {forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY} from "d3-force";
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

export interface AstForceLayout {
    nodes: SimAstNode[];
    links: SimAstLink[];
    byId: Map<string, SimAstNode>;
    // Settled cluster bounds in sim coordinates. The renderer translates the
    // cluster so (minX, minY) maps to the file box's content origin.
    bounds: {
        minX: number;
        minY: number;
        bboxW: number;
        bboxH: number;
        side: number; // = max(bboxW, bboxH); the file box is squared to this
    };
}

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

// Walk up `tree.byId.parentId` until we hit the direct child of rootId —
// that's the top-level statement containing this AST id. Returns null if
// the id was pruned away, doesn't exist in the layout, or *is* the root.
function liftToTopLevel(astId: string, tree: TreemapLayout): string | null {
    let cur: string | null = astId;
    for (let guard = 0; guard < 1024; guard++) {
        if (!cur) return null;
        const node = tree.byId.get(cur);
        if (!node) return null;
        if (node.parentId === tree.rootId) return node.id;
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
        const a = liftToTopLevel(sel.aId, tree);
        const b = liftToTopLevel(sel.bId, tree);
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

export function buildAstForceLayout(opts: BuildAstForceOpts): AstForceLayout {
    const {fileId, tree, semanticEdges} = opts;
    const topLevel = tree.childrenByParent.get(tree.rootId) ?? [];

    // Seed in a small ring so the sim has something to spread out; spread
    // scales with the largest node so neighbours aren't on top of each other
    // before the first tick.
    let maxDiag = 0;
    for (const tn of topLevel) {
        const d = Math.hypot(tn.rect.w, tn.rect.h);
        if (d > maxDiag) maxDiag = d;
    }
    const spread = Math.max(60, maxDiag * 0.8);

    const nodes: SimAstNode[] = topLevel.map((tn, i) => ({
        id: tn.id,
        x: Math.cos(i * 2.4) * spread,
        y: Math.sin(i * 2.4) * spread,
        rect: tn.rect,
        tree: tn,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Sim links: every intra-file calls/extends/implements edge whose lifted
    // endpoints are two distinct top-level nodes. Deduped per (kind, a, b).
    const links: SimAstLink[] = [];
    const seen = new Set<string>();
    let linkSeq = 0;
    for (const e of semanticEdges) {
        if (e.kind !== "calls" && e.kind !== "extends" && e.kind !== "implements") {
            continue;
        }
        if (fileIdOf(e.fromId) !== fileId || fileIdOf(e.toId) !== fileId) continue;
        const a = liftToTopLevel(e.fromId, tree);
        const b = liftToTopLevel(e.toId, tree);
        if (!a || !b || a === b) continue;
        if (!byId.has(a) || !byId.has(b)) continue;
        const key = `${e.kind}|${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({id: `astl-${linkSeq++}`, source: a, target: b});
    }

    // Directional bias: caller LEFT of callee (calls), subclass BELOW
    // superclass (extends/implements) — same conventions as the file-level
    // simulation, weighted by edge multiplicity.
    const callEdges = buildDirEdges(semanticEdges, fileId, tree, new Set(["calls"]), (e) => ({aId: e.fromId, bId: e.toId}), byId);
    const inheritEdges = buildDirEdges(semanticEdges, fileId, tree, new Set(["extends", "implements"]), (e) => ({aId: e.toId, bId: e.fromId}), byId);

    const simulation = forceSimulation<SimAstNode>(nodes)
        .force(
            "link",
            forceLink<SimAstNode, SimAstLink>(links)
                .id((d) => d.id)
                .distance(linkDistance)
                .strength(LINK_STRENGTH),
        )
        .force("charge", forceManyBody<SimAstNode>().strength(CHARGE_STRENGTH))
        .force("center", forceCenter(0, 0))
        .force("x", forceX<SimAstNode>(0).strength(COMPRESS_STRENGTH))
        .force("y", forceY<SimAstNode>(0).strength(COMPRESS_STRENGTH))
        .force("collide", aabbCollideForce(COLLIDE_PAD, COLLIDE_ITERS))
        .force("callsX", directionalAstForce(callEdges, "x", CALLS_X_STRENGTH))
        .force("callsY", directionalAstForce(callEdges, "y", CALLS_Y_STRENGTH))
        .force("inheritY", directionalAstForce(inheritEdges, "y", INHERIT_Y_STRENGTH))
        .force("square", squareBiasForce(SQUARE_STRENGTH))
        .alpha(1)
        .alphaDecay(0.035)
        .stop(); // we drive ticks manually for synchronous settle

    for (let i = 0; i < SETTLE_TICKS; i++) simulation.tick();
    simulation.stop();

    // Cluster bounding box from settled positions + rect extents.
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
    if (!Number.isFinite(minX)) {
        minX = 0;
        maxX = 0;
        minY = 0;
        maxY = 0;
    }
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const side = Math.max(bboxW, bboxH);

    return {
        nodes,
        links,
        byId,
        bounds: {minX, minY, bboxW, bboxH, side},
    };
}
