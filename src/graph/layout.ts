import {forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation} from "d3-force";
import type {FileNode, ProjectResponse, SemanticEdge} from "../api/types";
import type {SimFileNode, SimImportLink} from "./types";
import {fileLabel, measureMono} from "./labels";

// Collision radius for a file rectangle. Uses ~half the diagonal plus a
// constant padding so adjacent rects keep visible whitespace between them.
function collisionRadius(d: SimFileNode): number {
    // Expanded files render as a CIRCLE (see drawFile in PixiCanvas), with
    // width === height === diameter. Use the true circular radius rather
    // than the diagonal-derived value, which would over-allocate by ~55%
    // and push files unnecessarily far apart.
    if (d.expanded) return d.width / 2 + 14;
    return Math.hypot(d.width, d.height) * 0.55 + 14;
}

// Preferred link distance scales with the involved nodes' radii. Without
// this, an import edge between an expanded file and a collapsed file would
// pull them inside each other's collision circles and produce overlap.
function linkDistance(link: SimImportLink): number {
    const s = typeof link.source === "string" ? null : link.source;
    const t = typeof link.target === "string" ? null : link.target;
    if (!s || !t) return 200;
    return Math.max(200, collisionRadius(s) + collisionRadius(t) + 24);
}

// A collapsed node is just its basename label at this size plus padding —
// nothing fixed, so widths vary by name length and there's no wasted space.
const COLLAPSED_FONT = 12;
const COLLAPSED_PAD_X = 10;
const COLLAPSED_PAD_Y = 7;
const COLLAPSED_MIN_W = 48; // floor so 1–2 char names still read as a node

// The expanded interior is solved per-file to exactly fit its AST labels
// (see fitInterior). These bound that solve so a trivial file stays small and
// a pathological one can't explode the canvas.
// The expanded interior is sized bottom-up to its content (see layoutAst /
// fitInterior). These only bound that result: a tiny absolute floor, and a
// cap so a pathological file can't produce an enormous canvas.
export const EXPANDED_MIN = {w: 48, h: 32};
// Loose ceiling. Member-heavy classes (e.g. lightspeed's Game with ~14 deep
// methods) settle at clusters in the tens of thousands of world-px until
// methods themselves also get the fractal force layout. Clamping below
// the natural cluster size would visually shrink the FILE circle below
// its own contents and the cluster would overflow the boundary.
export const EXPANDED_MAX = {w: 50000, h: 50000};

// The minimized box for a file: its drawn basename + symmetric padding.
function collapsedSize(relativePath: string): {w: number; h: number} {
    const m = measureMono(fileLabel(relativePath), COLLAPSED_FONT);
    return {
        w: Math.max(COLLAPSED_MIN_W, Math.ceil(m.w + COLLAPSED_PAD_X * 2)),
        h: Math.ceil(m.h + COLLAPSED_PAD_Y * 2),
    };
}

// --- Directional layout bias ---------------------------------------------
// Gentle nudges layered on the physics so the graph *tends* to read in a
// consistent direction without overriding import-driven clustering:
//   - `calls`               : caller drifts LEFT of callee        (x axis)
//                              and callee drifts BELOW the caller  (y axis)
//   - `extends`/`implements` : subclass/implementer drifts BELOW
//                              the superclass/interface            (y axis)
// Strengths are deliberately small relative to charge (-650) / link (0.3);
// these are the knobs to tune if the bias feels too weak or too rigid. The
// calls Y pull is kept below its X pull so call chains still read primarily
// left→right, with a gentler downward drift toward what gets called.
const CALLS_X_STRENGTH = 0.16;
const CALLS_Y_STRENGTH = 0.12;
const INHERIT_Y_STRENGTH = 0.22;
// More calls between two files → a firmer pull, but sub-linear and capped so
// one hot pair can't dominate the whole layout.
const WEIGHT_CAP = 3;

// When an import line passes through an *open* (expanded) file's box, the
// relationship is hidden behind it. This force slides the line's endpoints
// (and the obstructing box) apart until the line clears. Gentle, and a
// no-op once clear — like the directional forces.
const LINK_CLEARANCE_STRENGTH = 0.18;
const LINK_CLEARANCE_PAD = 24; // world px the line should clear the box edge by

interface DirectionalEdge {
    aId: string; // tends toward the LOWER coordinate along the axis
    bId: string; // tends toward the HIGHER coordinate along the axis
    weight: number;
}

// AST node ids are `${fileId}#${seq}`; file ids are '#'-free relative paths,
// so the last '#' splits an endpoint back to its owning file.
function fileIdOf(astId: string): string {
    const i = astId.lastIndexOf("#");
    return i <= 0 ? astId : astId.slice(0, i);
}

// Collapse AST-level semantic edges to weighted file-level directional edges.
// `pick` chooses which endpoint should end up "before" (a) vs "after" (b)
// along the axis; same-file and dangling edges are dropped.
function directionalEdges(
    project: ProjectResponse,
    byId: Map<string, SimFileNode>,
    kinds: ReadonlySet<SemanticEdge["kind"]>,
    pick: (e: SemanticEdge) => {aId: string; bId: string},
): DirectionalEdge[] {
    const byPair = new Map<string, DirectionalEdge>();
    for (const e of project.semanticEdges) {
        if (!kinds.has(e.kind)) continue;
        const sel = pick(e);
        const a = fileIdOf(sel.aId);
        const b = fileIdOf(sel.bId);
        if (a === b || !byId.has(a) || !byId.has(b)) continue;
        const key = `${a} ${b}`;
        const existing = byPair.get(key);
        if (existing) existing.weight += 1;
        else byPair.set(key, {aId: a, bId: b, weight: 1});
    }
    return [...byPair.values()];
}

// d3-force custom force: for each directional edge, if `a` is not yet at
// least `separation` *before* `b` along `axis`, apply equal-and-opposite
// nudges to push them into order. A no-op once satisfied, so it never fights
// a layout that already reads correctly — that is the "gentle" behavior.
function directionalForce(edges: readonly DirectionalEdge[], axis: "x" | "y", strength: number) {
    let lookup = new Map<string, SimFileNode>();
    function force(alpha: number): void {
        for (const e of edges) {
            const a = lookup.get(e.aId);
            const b = lookup.get(e.bId);
            if (!a || !b) continue;
            // Live separation target: grows when either file expands.
            const separation = collisionRadius(a) + collisionRadius(b);
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
    force.initialize = (nodes: SimFileNode[]): void => {
        lookup = new Map(nodes.map((n) => [n.id, n]));
    };
    return force;
}

// d3-force custom force: pull each file toward the centroid of its
// directory's other members. The cluster is soft — files don't snap
// rigidly, they just settle near siblings — so the d3 collide /
// charge / link / directional forces still dominate the layout's
// large-scale arrangement. The user sees `shared/`, `client/`,
// `server/` form recognisable neighbourhoods without losing the
// cross-cutting wiring those neighbourhoods participate in.
//
// Root-level files (no directory component) are assigned to a
// virtual '<root>' cluster so they cluster together rather than
// being skipped. Without this, root files feel manyBody repulsion
// from every other file with no restoring force — over many ticks
// they accumulate outward drift and end up flung far from the
// rest of the project.
const ROOT_CLUSTER = "<root>";
function dirnameOf(relativePath: string): string {
    const i = relativePath.lastIndexOf("/");
    return i < 0 ? ROOT_CLUSTER : relativePath.slice(0, i);
}

// First `depth` components of a path. 'src/components/data-display/foo.ts'
// at depth=2 -> 'src/components'. Root-level files (no '/') return
// the '<root>' virtual subsystem so they participate in inter-subsystem
// repulsion rather than floating free — same reasoning as dirnameOf.
function clusterDirAt(relativePath: string, depth: number): string {
    const parts = relativePath.split("/");
    if (parts.length < 2) return ROOT_CLUSTER;
    const take = Math.min(depth, parts.length - 1);
    return parts.slice(0, take).join("/");
}

// d3-force custom force: REPEL between cluster centroids at a fixed
// depth (2 = project subsystems like 'src/components', 'src/partials',
// 'src/libs'). Inverse-square magnitude so dense areas — where
// multiple subsystems sit close together — feel proportionally
// stronger push than already-spread regions. Files within the same
// subsystem don't see this force; they're held together by the
// existing directoryClusterForce pull.
//
// Sized by sqrt(|a| * |b|): larger subsystems push harder, so a
// 100-file directory carves more space than a 5-file one.
// Softening: at distances closer than SUBSYSTEM_SOFTEN the force
// stops growing (inverse-square would diverge). Without this, the
// initial-seeded ring of files (d ≈ 80) experiences impulses that
// fling everything to far coordinates during the 50-tick warm-up.
const SUBSYSTEM_SOFTEN = 60;
const SUBSYSTEM_SOFTEN_SQ = SUBSYSTEM_SOFTEN * SUBSYSTEM_SOFTEN;

function directorySubsystemRepulsion(strength: number, depth: number) {
    let members = new Map<string, SimFileNode[]>();
    function force(alpha: number): void {
        if (members.size < 2) return;
        const groups: {cx: number; cy: number; mems: SimFileNode[]}[] = [];
        for (const mems of members.values()) {
            let sx = 0;
            let sy = 0;
            for (const m of mems) {
                sx += m.x;
                sy += m.y;
            }
            groups.push({cx: sx / mems.length, cy: sy / mems.length, mems});
        }
        for (let i = 0; i < groups.length; i++) {
            const a = groups[i];
            for (let j = i + 1; j < groups.length; j++) {
                const b = groups[j];
                const dx = b.cx - a.cx;
                const dy = b.cy - a.cy;
                const rawD2 = dx * dx + dy * dy;
                // Floor the squared distance to SUBSYSTEM_SOFTEN² so
                // the inverse-square stays bounded at close range.
                const d2 = Math.max(SUBSYSTEM_SOFTEN_SQ, rawD2);
                const d = Math.sqrt(d2);
                const weight = Math.sqrt(a.mems.length * b.mems.length);
                const f = (strength * alpha * weight) / d2;
                // Direction: away from a → b. When the two centroids
                // coincide, use an arbitrary unit vector so we still
                // push them apart (rather than 0/0 stall).
                let nx: number;
                let ny: number;
                if (d > 0.001) {
                    nx = dx / d;
                    ny = dy / d;
                } else {
                    // Use the pair-index as a deterministic
                    // tie-breaker so the same coincidence always
                    // resolves in the same direction.
                    nx = ((i + j) & 1) === 0 ? 1 : -1;
                    ny = 0;
                }
                const fx = nx * f;
                const fy = ny * f;
                for (const m of a.mems) {
                    m.vx = (m.vx ?? 0) - fx;
                    m.vy = (m.vy ?? 0) - fy;
                }
                for (const m of b.mems) {
                    m.vx = (m.vx ?? 0) + fx;
                    m.vy = (m.vy ?? 0) + fy;
                }
            }
        }
    }
    force.initialize = (n: SimFileNode[]): void => {
        members = new Map();
        for (const node of n) {
            const c = clusterDirAt(node.relativePath, depth);
            if (!c) continue;
            let mems = members.get(c);
            if (!mems) {
                mems = [];
                members.set(c, mems);
            }
            mems.push(node);
        }
    };
    return force;
}

function directoryClusterForce(strength: number) {
    let allNodes: SimFileNode[] = [];
    let directoryOf = new Map<string, string>();
    let members = new Map<string, SimFileNode[]>();

    function force(alpha: number): void {
        const centroid = new Map<string, {x: number; y: number}>();
        for (const [dir, mems] of members) {
            let sx = 0;
            let sy = 0;
            for (const m of mems) {
                sx += m.x;
                sy += m.y;
            }
            centroid.set(dir, {x: sx / mems.length, y: sy / mems.length});
        }
        for (const node of allNodes) {
            const dir = directoryOf.get(node.id);
            if (!dir) continue;
            const c = centroid.get(dir);
            if (!c) continue;
            node.vx = (node.vx ?? 0) + (c.x - node.x) * alpha * strength;
            node.vy = (node.vy ?? 0) + (c.y - node.y) * alpha * strength;
        }
    }
    force.initialize = (n: SimFileNode[]): void => {
        allNodes = n;
        directoryOf = new Map();
        members = new Map();
        for (const node of n) {
            const dir = dirnameOf(node.relativePath);
            if (!dir) continue;
            directoryOf.set(node.id, dir);
            let mems = members.get(dir);
            if (!mems) {
                mems = [];
                members.set(dir, mems);
            }
            mems.push(node);
        }
    };
    return force;
}

// d3-force custom force: keep import lines from being swallowed by open
// (expanded) file boxes. For each link whose segment passes within an open
// box's clearance radius — and not merely near an endpoint — nudge the two
// endpoints away from that box (and the box the other way) along the segment
// normal. No-op when every line already clears every open box.
function linkClearanceForce(links: readonly SimImportLink[], strength: number) {
    let nodes: SimFileNode[] = [];
    function force(alpha: number): void {
        const obstacles = nodes.filter((n) => n.expanded);
        if (obstacles.length === 0) return;
        for (const link of links) {
            const s = typeof link.source === "string" ? null : link.source;
            const t = typeof link.target === "string" ? null : link.target;
            if (!s || !t) continue;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const segLen2 = dx * dx + dy * dy;
            if (segLen2 < 1e-6) continue;
            for (const e of obstacles) {
                if (e === s || e === t) continue; // line legitimately ends here
                // Closest point on the segment to the box centre.
                const u = ((e.x - s.x) * dx + (e.y - s.y) * dy) / segLen2;
                // Only mid-line obstructions: near an endpoint the line is
                // just terminating at/under its own node.
                if (u <= 0.12 || u >= 0.88) continue;
                const cx = s.x + u * dx;
                const cy = s.y + u * dy;
                let nx = cx - e.x;
                let ny = cy - e.y;
                let d = Math.hypot(nx, ny);
                // Circumscribe the box + pad: the line should pass outside.
                const r = 0.5 * Math.hypot(e.width, e.height) + LINK_CLEARANCE_PAD;
                if (d >= r) continue; // already clears it
                if (d < 1e-3) {
                    // Dead through the centre — push along the segment normal.
                    nx = -dy;
                    ny = dx;
                    d = Math.hypot(nx, ny) || 1;
                }
                const inv = 1 / d;
                nx *= inv;
                ny *= inv;
                const f = strength * alpha * (r - d) * 0.5;
                s.vx = (s.vx ?? 0) + nx * f;
                s.vy = (s.vy ?? 0) + ny * f;
                t.vx = (t.vx ?? 0) + nx * f;
                t.vy = (t.vy ?? 0) + ny * f;
                e.vx = (e.vx ?? 0) - nx * f;
                e.vy = (e.vy ?? 0) - ny * f;
            }
        }
    }
    force.initialize = (n: SimFileNode[]): void => {
        nodes = n;
    };
    return force;
}

export interface FileLayoutResult {
    nodes: SimFileNode[];
    links: SimImportLink[];
    byId: Map<string, SimFileNode>;
    simulation: Simulation<SimFileNode, SimImportLink>;
    // Raw (un-normalised) target positions for the deterministic
    // folder-outline layout, keyed by file id. The renderer
    // normalises these into the connectivity layout's bounding box
    // via assignRigidPositions, then interpolates toward them as
    // the user zooms out.
    rigidRaw: Map<string, {x: number; y: number}>;
}

// --- Rigid folder-outline layout -----------------------------------------
// A fully deterministic layout: folders ordered top→bottom by their
// lexicographic path (which equals an alphabetical tree pre-order)
// and shifted left→right by path depth; a folder's files fill a
// compact grid inside that folder's horizontal band. The shape is
// the same indented tree a file explorer draws. The renderer
// interpolates toward this as the zoomed-OUT layout and away from
// it (toward the force-directed connectivity layout) as the user
// zooms in.
//
// Coordinates are in connectivity-layout world units — cells are
// sized to comfortably hold a collapsed file box (~140×28) so the
// rigid grid is overlap-free on its own; assignRigidPositions only
// TRANSLATES it (no scaling), so these are real sizes, not ratios.
const RIGID_COL_W = 560; // left→right shift per path-depth level
const RIGID_CELL_W = 230; // file-cell width within a folder grid
const RIGID_CELL_H = 76; // file-cell height within a folder grid
const RIGID_BAND_GAP = 130; // vertical gap between folder bands

export function computeRigidLayout(project: ProjectResponse): Map<string, {x: number; y: number}> {
    // Group files by parent directory ('<root>' for files with no
    // directory component — see dirnameOf).
    const byDir = new Map<string, FileNode[]>();
    for (const f of project.files) {
        const dir = dirnameOf(f.relativePath);
        let arr = byDir.get(dir);
        if (!arr) {
            arr = [];
            byDir.set(dir, arr);
        }
        arr.push(f);
    }
    // Lexicographic sort of directory paths == alphabetical tree
    // pre-order: a parent sorts immediately before its children,
    // siblings sort alphabetically. That ordering IS the top→bottom
    // row order the user asked for.
    const dirs = [...byDir.keys()].sort();
    const out = new Map<string, {x: number; y: number}>();
    let cursorY = 0;
    for (const dir of dirs) {
        // depth → X column: '<root>' is 0, 'src' is 1,
        // 'src/components' is 2, ...
        const depth = dir === ROOT_CLUSTER ? 0 : dir.split("/").length;
        const x0 = depth * RIGID_COL_W;
        const members = byDir
            .get(dir)!
            .slice()
            .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
        // Wide grid (3× the columns of a square) so each folder
        // reads as a short horizontal strip and the vertical
        // folder ordering dominates the read.
        const cols = Math.max(1, Math.round(Math.sqrt(members.length) * 3));
        members.forEach((f, i) => {
            out.set(f.id, {
                x: x0 + (i % cols) * RIGID_CELL_W,
                y: cursorY + Math.floor(i / cols) * RIGID_CELL_H,
            });
        });
        const rows = Math.ceil(members.length / cols);
        cursorY += rows * RIGID_CELL_H + RIGID_BAND_GAP;
    }
    return out;
}

// Positions the rigid folder layout by TRANSLATING it so its
// centroid sits on `centre` (the connectivity layout's centroid).
// No scaling — the rigid layout's cells are already sized in
// connectivity-world units to hold a file box, so the grid is
// overlap-free as-is. Centring both layouts on the same point
// keeps the render-time interpolation between them a short travel
// rather than a fly-across. Writes every node's rigidX / rigidY.
export function assignRigidPositions(
    layout: FileLayoutResult,
    centre: {x: number; y: number},
): void {
    let rMinX = Infinity;
    let rMinY = Infinity;
    let rMaxX = -Infinity;
    let rMaxY = -Infinity;
    for (const p of layout.rigidRaw.values()) {
        if (p.x < rMinX) rMinX = p.x;
        if (p.y < rMinY) rMinY = p.y;
        if (p.x > rMaxX) rMaxX = p.x;
        if (p.y > rMaxY) rMaxY = p.y;
    }
    const rCx = (rMinX + rMaxX) / 2;
    const rCy = (rMinY + rMaxY) / 2;
    for (const n of layout.nodes) {
        const p = layout.rigidRaw.get(n.id);
        if (!p) {
            n.rigidX = centre.x;
            n.rigidY = centre.y;
            continue;
        }
        n.rigidX = centre.x + (p.x - rCx);
        n.rigidY = centre.y + (p.y - rCy);
    }
}

// Builds simulation nodes/links from a project. The simulation is
// created STOPPED — the renderer drives it tick-by-tick (see
// PixiCanvas) so it can restore connectivity positions before each
// tick and interpolate toward the rigid layout after. Caller is
// responsible for cleanup.
export function buildFileLayout(project: ProjectResponse): FileLayoutResult {
    const rigidRaw = computeRigidLayout(project);
    const nodes: SimFileNode[] = project.files.map((f, i) => {
        const cs = collapsedSize(f.relativePath);
        // Seed in a small ring so the force simulation has something
        // to spread out from.
        const seedX = Math.cos(i * 2.4) * 80;
        const seedY = Math.sin(i * 2.4) * 80;
        return {
            id: f.id,
            relativePath: f.relativePath,
            width: cs.w,
            height: cs.h,
            collapsedW: cs.w,
            collapsedH: cs.h,
            expanded: false,
            x: seedX,
            y: seedY,
            connX: seedX,
            connY: seedY,
            // Placeholder — assignRigidPositions overwrites these
            // once the connectivity layout's centroid is known.
            rigidX: seedX,
            rigidY: seedY,
            offX: 0,
            offY: 0,
        };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const links: SimImportLink[] = [];
    for (const e of project.edges) {
        if (!byId.has(e.fromId) || !byId.has(e.toId)) continue;
        links.push({id: e.id, source: e.fromId, target: e.toId});
    }

    // Caller (edge.fromId) should settle LEFT of callee (edge.toId).
    const callEdges = directionalEdges(project, byId, new Set(["calls"]), (e) => ({
        aId: e.fromId,
        bId: e.toId,
    }));
    // Superclass/interface (edge.toId) should settle ABOVE the subclass/
    // implementer (edge.fromId), so the extender drifts toward the bottom.
    const inheritEdges = directionalEdges(project, byId, new Set(["extends", "implements"]), (e) => ({aId: e.toId, bId: e.fromId}));

    const simulation = forceSimulation<SimFileNode>(nodes)
        .force(
            "link",
            forceLink<SimFileNode, SimImportLink>(links)
                .id((d) => d.id)
                .distance(linkDistance)
                .strength(0.3),
        )
        .force("charge", forceManyBody<SimFileNode>().strength(-650))
        .force("center", forceCenter(0, 0))
        .force("collide", forceCollide<SimFileNode>().radius(collisionRadius).strength(0.95).iterations(2))
        .force("callsX", directionalForce(callEdges, "x", CALLS_X_STRENGTH))
        .force("callsY", directionalForce(callEdges, "y", CALLS_Y_STRENGTH))
        .force("inheritY", directionalForce(inheritEdges, "y", INHERIT_Y_STRENGTH))
        // Modest directory cohesion for the CONNECTIVITY layout —
        // the one the user reads when zoomed IN, where connectivity
        // should dominate but a little folder grouping still aids
        // orientation. The deterministic rigid layout
        // (computeRigidLayout) does the strong folder organisation
        // at the zoomed-out end, so these no longer need to be
        // strong or zoom-modulated.
        .force("directoryCluster", directoryClusterForce(0.09))
        .force("directorySubsystemRepulsion", directorySubsystemRepulsion(120, 2))
        .force("clearance", linkClearanceForce(links, LINK_CLEARANCE_STRENGTH))
        // Defensive per-file soft leash toward origin. forceCenter
        // only constrains the global CENTROID — it can't stop a
        // single low-connectivity file from accumulating outward
        // drift while the rest of the cluster slides the other way
        // to balance. For a file with no siblings it's the only
        // restoring force keeping it from sailing off as manyBody
        // slowly pushes it outward.
        .force("leashX", forceX<SimFileNode>(0).strength(0.004))
        .force("leashY", forceY<SimFileNode>(0).strength(0.004))
        .alpha(1)
        .alphaDecay(0.035);
    // Created stopped: the renderer drives .tick() manually so it
    // can restore connectivity positions before each tick and
    // interpolate toward the rigid layout after. With alphaTarget
    // at its default 0, alpha decays to alphaMin and the renderer
    // stops ticking — the sim does NOT run indefinitely.
    simulation.stop();

    return {nodes, links, byId, simulation, rigidRaw};
}

/**
 * Push the simulation to reflect the current set of expanded files. This:
 *  1. Updates each `SimFileNode.width/height` to match its expanded state.
 *  2. Re-creates the collide and link forces so their radius accessors are
 *     re-evaluated against the new sizes (d3-force caches these at init time
 *     and won't pick up width/height mutations on its own).
 *  3. Reheats the simulation so other files visibly move out of the way.
 *
 * Returns `true` if anything actually changed.
 */
export function applyExpansion(layout: FileLayoutResult, expandedFiles: ReadonlySet<string>, expandedSizeFor: (fileId: string) => {w: number; h: number} | null): boolean {
    let changed = false;
    for (const sim of layout.nodes) {
        const wantExpanded = expandedFiles.has(sim.id);
        sim.expanded = wantExpanded; // obstacle flag for the clearance force
        // Expanded → its solved exact-fit size (or, while the AST is still
        // loading, fall back to the collapsed size). Collapsed → content size.
        const expanded = wantExpanded ? expandedSizeFor(sim.id) : null;
        const targetW = expanded ? expanded.w : sim.collapsedW;
        const targetH = expanded ? expanded.h : sim.collapsedH;
        if (sim.width !== targetW || sim.height !== targetH) {
            sim.width = targetW;
            sim.height = targetH;
            changed = true;
        }
    }
    if (!changed) return false;

    layout.simulation.force("collide", forceCollide<SimFileNode>().radius(collisionRadius).strength(0.95).iterations(2));
    layout.simulation.force(
        "link",
        forceLink<SimFileNode, SimImportLink>(layout.links)
            .id((d) => d.id)
            .distance(linkDistance)
            .strength(0.3),
    );
    // High alpha so the rebalance is visibly animated rather than a
    // teleport. No .restart() — the sim is driven manually by the
    // renderer's ticker; restart() would re-enable d3's internal
    // timer and double-drive it. Bumping alpha is enough: the
    // renderer's per-frame stepLayout sees alpha > alphaMin and
    // resumes ticking.
    layout.simulation.alpha(0.9);
    return true;
}
