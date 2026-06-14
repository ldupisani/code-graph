import {forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation} from "d3-force";
import type {FileNode, ProjectResponse, SemanticEdge} from "../api/types";
import type {SimFileNode, SimImportLink} from "./types";
import {fileLabel, measureMono} from "./labels";

// Width tolerance the shape-check below uses to detect "still
// circular but width is finishing its ease back to collapsedW". Must
// be >= the renderer's WIDTH_SNAP (PixiCanvas.tsx) so the two never
// disagree about when an animation has finished.
const SHAPE_WIDTH_TOLERANCE = 0.5;

// Is this file currently drawn (and treated by physics) as a circle?
// True when:
//   * currently expanded (drawn as a circle, AST contents inside), OR
//   * animating TOWARD expanded (`targetExpanded` flipped before width
//     reaches the expanded size), OR
//   * animating AWAY FROM expanded (`expanded` and `targetExpanded`
//     have both gone false but `width` is still in flight — the
//     visible shape is still a shrinking circle).
// The width tolerance catches the third case without needing yet
// another boolean.
export function isCircular(d: SimFileNode): boolean {
    return (
        d.expanded === true ||
        d.targetExpanded === true ||
        d.width > d.collapsedW + SHAPE_WIDTH_TOLERANCE
    );
}

// Collision radius for a file rectangle. Uses ~half the diagonal plus a
// constant padding so adjacent rects keep visible whitespace between them.
function collisionRadius(d: SimFileNode): number {
    // Files that are drawn as circles (expanded steady-state OR mid-
    // animation in either direction) use the true circular radius —
    // matches the visible shape. Truly-collapsed files use the
    // bounding-circle of their rectangular icon, which is snugger
    // along the long axis (typical file icons are taller than wide).
    if (isCircular(d)) return d.width / 2 + 14;
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
// Around each EXPANDED file, arrange the import neighbourhood
// along the file's visible border:
//   * dependencies (files the expanded file imports) are
//     distributed evenly along the TOP HALF of the boundary
//     (9 o'clock through 12 o'clock to 3 o'clock);
//   * consumers (files that import the expanded file) are
//     distributed evenly along the BOTTOM HALF (9 o'clock through
//     6 o'clock to 3 o'clock).
// Each file's centre is pulled toward an explicit slot ON the
// visible circle — not just "the upper half" — so the result reads
// as beads on a string rather than a loose cluster. Files unrelated
// to this expanded file get no force from this and settle on the
// sides via the other forces (charge / link / collide).
// Implemented as a position-attraction force per slot: each tick,
// for each (expanded file, neighbour-on-arc) pair, nudge the
// neighbour's velocity toward its assigned slot.
const IMPORT_POLARITY_STRENGTH = 0.15;
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

// d3-force custom force: distribute the import neighbourhood of
// each EXPANDED file along the visible boundary of its circle.
// Pre-computes two per-file adjacency lists at initialize time:
//
//   outBy[E] = files E imports (its DEPENDENCIES)
//   inBy[E]  = files that import E (its CONSUMERS)
//
// Each tick, for every expanded file E, walks its dependency list
// and nudges each dependency toward an evenly-spaced SLOT on the
// top arc of E's boundary; same for consumers on the bottom arc.
// The list order is sorted by id at init time so slot assignment
// is stable across ticks — files don't oscillate between angular
// positions as their x-coords drift around.
//
// Slot maths:
//   Visible radius r = E.width / 2 (the perimeter the user sees).
//   Parametric position on E's circle: (E.x + r·cos(t), E.y + r·sin(t))
//     with t = 0 at 3 o'clock, t = π/2 at 6 o'clock (bottom in
//     screen coords where +y is down), t = π at 9 o'clock,
//     t = 3π/2 at 12 o'clock (top).
//   Top arc (deps): t ∈ (π, 2π), evenly distributed with margins
//     from both endpoints so files don't crowd the side cluster.
//   Bottom arc (consumers): t ∈ (0, π), same convention.
//   The horizontal ordering (slot 0 on the left, slot N-1 on the
//   right) is the same on both arcs so the user can read a
//   dependency and its symmetric-positioned consumer pair across
//   the file.
//
// Files unrelated to any expanded file get zero force from this
// pass and settle on the horizontal sides via the other forces.
function importPolarityForce(links: readonly SimImportLink[], strength: number) {
    let lookup = new Map<string, SimFileNode>();
    // E.id → files E imports (dependencies). Each file is the
    // target of an import edge whose source is E.
    let depsByExpanded = new Map<string, SimFileNode[]>();
    // E.id → files that import E (consumers). Each file is the
    // source of an import edge whose target is E.
    let consumersByExpanded = new Map<string, SimFileNode[]>();

    function force(alpha: number): void {
        for (const E of lookup.values()) {
            if (!E.expanded) continue;
            const r = E.width / 2;

            const deps = depsByExpanded.get(E.id);
            if (deps && deps.length > 0) {
                const N = deps.length;
                for (let i = 0; i < N; i++) {
                    // Top arc — slot k of N at angle π + (k+1)/(N+1)·π.
                    // Margins from the side ports keep dependencies
                    // from sitting where the side-cluster (unrelated
                    // files) wants to gather.
                    const t = Math.PI + ((i + 1) / (N + 1)) * Math.PI;
                    const tx = E.x + r * Math.cos(t);
                    const ty = E.y + r * Math.sin(t);
                    const F = deps[i];
                    F.vx = (F.vx ?? 0) + (tx - F.x) * alpha * strength;
                    F.vy = (F.vy ?? 0) + (ty - F.y) * alpha * strength;
                }
            }

            const consumers = consumersByExpanded.get(E.id);
            if (consumers && consumers.length > 0) {
                const N = consumers.length;
                for (let i = 0; i < N; i++) {
                    // Bottom arc — same left-to-right convention as
                    // the top arc. t decreases from near-π (left) to
                    // near-0 (right) so increasing i puts the slot
                    // further right, matching the top arc's ordering.
                    const t = Math.PI * (N - i) / (N + 1);
                    const tx = E.x + r * Math.cos(t);
                    const ty = E.y + r * Math.sin(t);
                    const F = consumers[i];
                    F.vx = (F.vx ?? 0) + (tx - F.x) * alpha * strength;
                    F.vy = (F.vy ?? 0) + (ty - F.y) * alpha * strength;
                }
            }
        }
    }
    force.initialize = (nodes: SimFileNode[]): void => {
        lookup = new Map(nodes.map((n) => [n.id, n]));
        depsByExpanded = new Map();
        consumersByExpanded = new Map();
        // Dedupe by (fromId, toId) so multiple import statements
        // between the same pair of files don't produce duplicate
        // slots — slot count must match the visible UNIQUE-neighbour
        // count.
        const seen = new Set<string>();
        for (const link of links) {
            const fromId = typeof link.source === "string" ? link.source : link.source.id;
            const toId = typeof link.target === "string" ? link.target : link.target.id;
            const key = `${fromId}>${toId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const fromNode = lookup.get(fromId);
            const toNode = lookup.get(toId);
            if (!fromNode || !toNode) continue;
            let deps = depsByExpanded.get(fromId);
            if (!deps) {
                deps = [];
                depsByExpanded.set(fromId, deps);
            }
            deps.push(toNode);
            let cons = consumersByExpanded.get(toId);
            if (!cons) {
                cons = [];
                consumersByExpanded.set(toId, cons);
            }
            cons.push(fromNode);
        }
        // Stable slot assignment: sort by id so the angular position
        // of each file is deterministic across ticks. Other orderings
        // (by current x-position) would be more visually pleasing but
        // would cause oscillation as files drift past one another.
        for (const list of depsByExpanded.values()) list.sort((a, b) => a.id.localeCompare(b.id));
        for (const list of consumersByExpanded.values()) list.sort((a, b) => a.id.localeCompare(b.id));
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
export const ROOT_CLUSTER = "<root>";
export function dirnameOf(relativePath: string): string {
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
        // Treat both fully-expanded files AND files mid-expand-or-
        // collapse animation as obstacles, so import lines keep
        // routing around a circle that's still visibly present.
        const obstacles = nodes.filter((n) => isCircular(n));
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

// Radial containment: soft quadratic pull outside `softR`, plus a
// hard backstop clamp at 3× softR. Replaces the constant-pull
// leashX/leashY: those exerted a force on every file regardless of
// position, which compressed the layout for well-connected
// projects, and were too weak (strength 0.004) to stop a
// disconnected file from drifting under unbounded many-body
// repulsion. The piecewise design here has ZERO effect on files
// inside softR — only outliers feel the pull — and grows
// quadratically with excess so a file that's drifted far feels a
// proportionally stronger correction.
//
// The hard cap is a backstop: a strong reheat can briefly fling
// something past 3× softR, and we want a known finite maximum
// extent for the project (helps camera-fit, hit-testing, and the
// user's "where did my file go" intuition). Clamping `n.x`/`n.y`
// from a force callback is the same pattern the userPinned drag
// uses (`sim.x = nx` in onFileDragMove) — d3-force picks up
// post-callback positions before the next force in the same tick.
//
// Pinned files (userPinned, or transiently fx-set during
// expansion) are skipped: their position is user/expansion-
// controlled, and d3 would clamp x to fx at end-of-tick anyway.
function radialContainmentForce(getSoftR: () => number, strength: number) {
    let nodes: SimFileNode[] = [];
    function force(alpha: number): void {
        const softR = getSoftR();
        if (softR <= 0) return;
        const softR2 = softR * softR;
        const hardR = softR * 3;
        const hardR2 = hardR * hardR;
        for (const n of nodes) {
            if (n.userPinned || n.fx != null) continue;
            const r2 = n.x * n.x + n.y * n.y;
            if (r2 <= softR2) continue;
            const r = Math.sqrt(r2);
            // Soft pull: quadratic in excess past softR. Multiplied
            // by alpha so the force fades as the sim cools.
            const excess = r - softR;
            const mag = strength * alpha * excess * excess;
            const ux = n.x / r;
            const uy = n.y / r;
            n.vx = (n.vx ?? 0) - ux * mag;
            n.vy = (n.vy ?? 0) - uy * mag;
            // Hard backstop: nothing past 3× softR. Clamp position
            // back to the boundary and zero the outward component
            // of velocity so the next tick doesn't immediately
            // push it back out.
            if (r2 > hardR2) {
                const k = hardR / r;
                n.x *= k;
                n.y *= k;
                // After scaling, (n.x, n.y) lies on the hardR
                // circle. Recompute the unit direction from the
                // clamped position.
                const ux2 = n.x / hardR;
                const uy2 = n.y / hardR;
                const dot = (n.vx ?? 0) * ux2 + (n.vy ?? 0) * uy2;
                if (dot > 0) {
                    n.vx = (n.vx ?? 0) - dot * ux2;
                    n.vy = (n.vy ?? 0) - dot * uy2;
                }
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
    // Half the diagonal of the rigid layout's bounding box. Used by
    // the radial-containment force to size its soft boundary so
    // larger projects get a larger boundary automatically.
    // Updated by assignRigidPositions every time the rigid layout
    // is recomputed. 0 until assignRigidPositions has run at least
    // once — the containment force early-exits in that case.
    rigidHalfDiag: number;
}

// --- Rigid folder-outline layout -----------------------------------------
// A fully deterministic layout: each folder's files fill a wide grid
// (its "block"); blocks are ordered by lexicographic path (an
// alphabetical tree pre-order) and FLOW top→bottom down a column,
// wrapping into a new column to the right once a column reaches its
// height budget — like a multi-column index. Within a column, depth
// indents a folder left→right. The column count is chosen to make
// the whole layout land near targetAspect (wider than tall),
// so when zoomed out files spread horizontally rather than into one
// tall ribbon. The renderer interpolates toward this as the
// zoomed-OUT layout and away from it (toward the force-directed
// connectivity layout) as the user zooms in.
//
// Coordinates are in connectivity-layout world units — cells are
// sized to comfortably hold a collapsed file box (~140×28) so the
// rigid grid is overlap-free on its own; assignRigidPositions only
// TRANSLATES it (no scaling), so these are real sizes, not ratios.
// Tunable parameters for the folder-grid layout (exposed as a configurable
// pattern via patterns/folderGrid.ts). Defaults reproduce the original layout.
export interface FolderGridParams {
    colW: number; // left→right depth indent within a column
    cellW: number; // file-cell width within a folder grid
    cellH: number; // file-cell height within a folder grid
    bandGap: number; // vertical gap between folders in a column
    columnGap: number; // horizontal gap between folder columns
    targetAspect: number; // desired width : height of the layout
}

export const FOLDER_GRID_DEFAULTS: FolderGridParams = {
    colW: 360,
    cellW: 230,
    cellH: 76,
    bandGap: 120,
    columnGap: 440,
    targetAspect: 1.7,
};

export function computeRigidLayout(
    project: ProjectResponse,
    params: FolderGridParams = FOLDER_GRID_DEFAULTS,
): Map<string, {x: number; y: number}> {
    const {colW, cellW, cellH, bandGap, columnGap, targetAspect} = params;
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
    // siblings sort alphabetically.
    const dirs = [...byDir.keys()].sort();

    // 1. Build each folder's block: its files in a wide grid, plus
    //    the block's own width/height and its depth indent.
    interface Block {
        depth: number;
        w: number;
        h: number;
        files: {id: string; dx: number; dy: number}[];
    }
    const blocks: Block[] = [];
    for (const dir of dirs) {
        const depth = dir === ROOT_CLUSTER ? 0 : dir.split("/").length;
        const members = byDir
            .get(dir)!
            .slice()
            .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
        // Wide grid (3× the columns of a square) so each folder
        // reads as a short horizontal strip.
        const cols = Math.max(1, Math.round(Math.sqrt(members.length) * 3));
        const rows = Math.ceil(members.length / cols);
        blocks.push({
            depth,
            w: cols * cellW,
            h: rows * cellH,
            files: members.map((f, i) => ({
                id: f.id,
                dx: (i % cols) * cellW,
                dy: Math.floor(i / cols) * cellH,
            })),
        });
    }

    // 2. Total single-column height, and the widest column slot (a
    //    folder's depth indent + its block width).
    let totalStackH = 0;
    let maxSlotW = 1;
    for (const b of blocks) {
        totalStackH += b.h + bandGap;
        const slotW = b.depth * colW + b.w;
        if (slotW > maxSlotW) maxSlotW = slotW;
    }

    // 3. Pick the column count that lands the layout near the
    //    target aspect. With K columns the layout is ~K·colSlotW
    //    wide and ~totalStackH/K tall, so width/height = K²·colSlotW
    //    / totalStackH; solving for the target gives K below.
    const colSlotW = maxSlotW + columnGap;
    const columns = Math.max(
        1,
        Math.round(Math.sqrt((targetAspect * totalStackH) / colSlotW)),
    );
    const budget = totalStackH / columns;

    // 4. Flow folders top→bottom down a column; once a column passes
    //    its height budget, wrap to the next (the last column takes
    //    whatever remains).
    const out = new Map<string, {x: number; y: number}>();
    let col = 0;
    let cursorY = 0;
    for (const b of blocks) {
        if (cursorY > 0 && cursorY + b.h > budget && col < columns - 1) {
            col++;
            cursorY = 0;
        }
        const x0 = col * colSlotW + b.depth * colW;
        for (const f of b.files) {
            out.set(f.id, {x: x0 + f.dx, y: cursorY + f.dy});
        }
        cursorY += b.h + bandGap;
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
    // Remember the rigid bbox's half-diagonal as a project-scale
    // proxy. The radial containment force reads `2 × rigidHalfDiag`
    // as its soft boundary so the boundary auto-scales with project
    // size — small projects get a tight boundary, big monorepos
    // get a wide one. Guard against degenerate (empty / 1-file)
    // layouts where the bbox is undefined.
    if (Number.isFinite(rMinX) && Number.isFinite(rMinY)) {
        const dx = rMaxX - rMinX;
        const dy = rMaxY - rMinY;
        layout.rigidHalfDiag = 0.5 * Math.hypot(dx, dy);
    } else {
        layout.rigidHalfDiag = 0;
    }
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
            // Animation targets — start aligned with width/height so
            // there's nothing to ease toward at init. The renderer's
            // per-frame size-ease step picks these up after the first
            // applyExpansion mutates them.
            targetExpanded: false,
            targetW: cs.w,
            targetH: cs.h,
            // Safe fallback so the collapse animation has a sensible
            // "from" radius even if a file is collapsed without ever
            // having opened (degenerate path that shouldn't happen in
            // practice). First expand overwrites with the real value.
            lastExpandedTargetW: cs.w,
            // User-drag pin marker. False by default; set true on
            // pointer-up after a file-drag in PixiCanvas. Pin-release
            // paths skip nodes with this flag set.
            userPinned: false,
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

    // Assemble the result up-front so the radial-containment force
    // can close over `result.rigidHalfDiag`. assignRigidPositions
    // (the caller's responsibility, runs after build) mutates that
    // field in-place on the SAME object reference; the closure
    // reads the current value every tick, so it picks up the
    // post-build value automatically without re-creating the force.
    const result: FileLayoutResult = {
        nodes,
        links,
        byId,
        rigidRaw,
        rigidHalfDiag: 0,
        // Filled in immediately below — the cast lets us defer
        // simulation construction one statement so the containment
        // force can take a closure over `result` itself.
        simulation: null as never,
    };

    result.simulation = forceSimulation<SimFileNode>(nodes)
        .force(
            "link",
            forceLink<SimFileNode, SimImportLink>(links)
                .id((d) => d.id)
                .distance(linkDistance)
                .strength(0.3),
        )
        // distanceMin caps the inverse-square repulsion at close range:
        // without it, two files that drift within ~10–20 px would feel a
        // force several hundred times what they feel at the equilibrium
        // separation, blowing them apart faster than velocityDecay can
        // damp — the visible "jitter" in dense clusters. Capping at 40
        // (well below typical collision radii, ~55–65) means the force
        // is bounded inside the no-overlap shell the collide pass
        // enforces anyway. The equilibrium positions don't change; the
        // ringing around them does.
        // distanceMax bounds the inverse-square tail. Beyond ~3×
        // the typical link distance (200) the per-pair repulsion
        // is small but accumulating, and on a low-connectivity
        // outlier it becomes the dominant outward force. Capping
        // at 600 confines repulsion to the cluster zone — distant
        // pairs no longer push each other further apart, which is
        // what allowed lone files to drift in the first place.
        .force("charge", forceManyBody<SimFileNode>().strength(-650).distanceMin(40).distanceMax(600))
        .force("center", forceCenter(0, 0))
        .force("collide", forceCollide<SimFileNode>().radius(collisionRadius).strength(0.95).iterations(2))
        .force("callsX", directionalForce(callEdges, "x", CALLS_X_STRENGTH))
        .force("callsY", directionalForce(callEdges, "y", CALLS_Y_STRENGTH))
        .force("inheritY", directionalForce(inheritEdges, "y", INHERIT_Y_STRENGTH))
        // Polarises the neighbourhood of an expanded file vertically:
        // its dependencies drift to the TOP half of its boundary,
        // its consumers to the BOTTOM half. No-op for pairs where
        // neither end is expanded.
        .force("importPolarity", importPolarityForce(links, IMPORT_POLARITY_STRENGTH))
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
        // Radial containment: zero-force inside a soft boundary
        // sized at 2× the rigid (folder-grid) layout's half-
        // diagonal; quadratic pull-back past the boundary; hard
        // clamp at 3× softR as a backstop. Replaces the constant
        // forceX/forceY "leash" — that pulled every file every
        // tick (compressing legitimate spread for big projects)
        // and was too weak (0.004) to stop drift on a
        // disconnected file. The piecewise design only acts on
        // OUTLIERS and grows quadratically with how far they've
        // drifted, so the response is proportional to the problem.
        //
        // Closure reads `result.rigidHalfDiag` each tick — picked
        // up automatically when assignRigidPositions mutates it
        // post-build (and on subsequent project rebuilds).
        .force(
            "containment",
            radialContainmentForce(() => 2 * result.rigidHalfDiag, 0.0008),
        )
        .alpha(1)
        .alphaDecay(0.035)
        // Heavier damping than the d3 default of 0.4. In tight clusters
        // — where many small-magnitude forces interact each tick — the
        // default lets velocity accumulate just enough to overshoot the
        // equilibrium, producing a visible per-frame jitter. 0.55 means
        // velocity is multiplied by 0.45 each tick (vs the default
        // 0.60), which reaches equilibrium faster AND with less ringing.
        // Conservatively below 0.7 so the layout still settles in a
        // reasonable number of frames after a reheat.
        .velocityDecay(0.55);
    // Created stopped: the renderer drives .tick() manually so it
    // can restore connectivity positions before each tick and
    // interpolate toward the rigid layout after. With alphaTarget
    // at its default 0, alpha decays to alphaMin and the renderer
    // stops ticking — the sim does NOT run indefinitely.
    result.simulation.stop();
    return result;
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
        sim.targetExpanded = wantExpanded;
        // Expanded → its solved exact-fit size (or, while the AST is still
        // loading, fall back to the collapsed size). Collapsed → content size.
        const expanded = wantExpanded ? expandedSizeFor(sim.id) : null;
        const targetW = expanded ? expanded.w : sim.collapsedW;
        const targetH = expanded ? expanded.h : sim.collapsedH;
        // Set TARGETS only — the renderer's per-frame size-ease step
        // (in stepLayout) animates the actual width/height toward
        // these and refreshes the d3-force collide/link forces while
        // sizes are in flight. This keeps the physical (collision)
        // radius in lock-step with the visual radius, eliminating the
        // jumpy "neighbours rush in through a still-visible
        // shrinking circle" effect that the old instantaneous width
        // mutation produced.
        if (sim.targetW !== targetW || sim.targetH !== targetH) {
            sim.targetW = targetW;
            sim.targetH = targetH;
            // Remember the expanded target so the collapse animation
            // has a sensible "from" anchor after targetW resets to
            // collapsedW. Only update on an actual expand (with a
            // known expanded size — null while AST is loading).
            if (wantExpanded && expanded) {
                sim.lastExpandedTargetW = targetW;
            }
            changed = true;
        }
    }
    if (!changed) return false;

    // No force-recreate here. The renderer's stepLayout watches for
    // width/height changes each frame and refreshes forceCollide and
    // forceLink while any size is still animating — they have to be
    // refreshed every animating frame anyway, not just at the toggle
    // moment.
    //
    // High alpha so the rebalance is visibly animated rather than a
    // teleport. No .restart() — the sim is driven manually by the
    // renderer's ticker; restart() would re-enable d3's internal
    // timer and double-drive it. Bumping alpha is enough: the
    // renderer's per-frame stepLayout sees alpha > alphaMin and
    // resumes ticking.
    layout.simulation.alpha(0.9);
    return true;
}

/**
 * Refresh the d3-force `collide` and `link` forces so they re-read each
 * node's current `width` / `height`. d3-force caches per-node radii and
 * link distances when a force is initialized, so any change to the
 * underlying sizes requires REPLACING the force (which triggers a fresh
 * init). The renderer's per-frame size-ease loop calls this whenever
 * any node's size moved this frame.
 */
export function refreshSizeForces(layout: FileLayoutResult): void {
    layout.simulation.force(
        "collide",
        forceCollide<SimFileNode>().radius(collisionRadius).strength(0.95).iterations(2),
    );
    layout.simulation.force(
        "link",
        forceLink<SimFileNode, SimImportLink>(layout.links)
            .id((d) => d.id)
            .distance(linkDistance)
            .strength(0.3),
    );
}

// A node's settled connectivity position, snapshotted before a rebuild so an
// incremental graph update (a filesystem delta) can restore the view instead
// of re-settling from scratch. See seedFromSaved.
export interface SavedNodePos {
    x: number;
    y: number;
    userPinned: boolean;
}

// Seed a freshly built layout from a previous run's settled positions so an
// incremental update keeps the user's view stable. Files that existed before
// snap back to exactly where they were (and re-pin if they were pinned);
// brand-new files are placed by placeNewFile near their graph neighbours so
// they animate in beside related code rather than flying in from the origin.
// The caller follows this with a COOL reheat (low alpha, few ticks) so settled
// nodes stay put and only the new arrivals migrate into place.
export function seedFromSaved(
    layout: FileLayoutResult,
    saved: ReadonlyMap<string, SavedNodePos>,
    project: ProjectResponse,
): void {
    const neighbours = buildNeighbourIndex(project);
    for (const n of layout.nodes) {
        const p = saved.get(n.id);
        if (p) {
            n.x = n.connX = p.x;
            n.y = n.connY = p.y;
            n.userPinned = p.userPinned;
            // Re-pin so a user-held file keeps its exact spot through the update.
            if (p.userPinned) {
                n.fx = p.x;
                n.fy = p.y;
            }
        } else {
            placeNewFile(n, neighbours.get(n.id) ?? [], saved);
        }
    }
}

// File-level adjacency (imports + collapsed semantic edges, undirected) used to
// place new files near related ones.
function buildNeighbourIndex(project: ProjectResponse): Map<string, string[]> {
    const nbr = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
        if (a === b) return;
        (nbr.get(a) ?? nbr.set(a, []).get(a)!).push(b);
        (nbr.get(b) ?? nbr.set(b, []).get(b)!).push(a);
    };
    for (const e of project.edges) link(e.fromId, e.toId);
    for (const e of project.semanticEdges) link(fileIdOf(e.fromId), fileIdOf(e.toId));
    return nbr;
}

// Decide where a brand-new file (no saved position) starts. This is a layout
// quality choice with real trade-offs, so it's factored out:
//   * Neighbour-centroid (below): the file appears next to the code it's wired
//     to, reading as "this belongs here" — but a file with many spread-out
//     neighbours lands in a crowded middle the reheat must untangle.
//   * Alternatives worth trying: seed at the nearest single neighbour, at the
//     file's folder-grid (rigid) slot, or just keep the ring seed and let the
//     forces decide.
// Mutates the node's x/y/connX/connY in place. Falls back to the ring seed
// (already set by buildFileLayout) when no neighbour has a known position.
function placeNewFile(
    node: SimFileNode,
    neighbourIds: readonly string[],
    saved: ReadonlyMap<string, SavedNodePos>,
): void {
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (const id of neighbourIds) {
        const p = saved.get(id);
        if (p) {
            sx += p.x;
            sy += p.y;
            k++;
        }
    }
    if (k === 0) return; // no placed neighbour — keep buildFileLayout's ring seed
    // Deterministic per-file offset so several new files sharing the same
    // neighbours don't stack on one pixel (no Math.random — keeps tests stable).
    const jitter = ((node.id.length * 37) % 80) - 40;
    node.x = node.connX = sx / k + jitter;
    node.y = node.connY = sy / k + jitter;
}
