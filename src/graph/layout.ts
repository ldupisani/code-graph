import {forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation} from "d3-force";
import type {ProjectResponse, SemanticEdge} from "../api/types";
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

// Zoom-modulated strength curves. Folder forces (cluster +
// subsystem repulsion) get stronger at low zoom so the overview
// reads as 'organised by folder.' Link-loosening counter-force
// also strengthens at low zoom — see linkLooseningForce.
//
// folderMul:
//   cameraScale 0.1 → ~2.4   (strong folder pull, overview view)
//   cameraScale 0.5 → ~1.5
//   cameraScale 1.0 → 1.0    (baseline)
//   cameraScale 2.0 → ~0.3   (folder fades, connectivity wins)
function folderMul(cameraScale: number): number {
    return Math.max(0.3, Math.min(2.5, 2.5 - cameraScale * 1.5));
}
// linkLoosenMul:
//   cameraScale 0.1 → 1.0    (counter-force at full strength)
//   cameraScale 0.5 → ~0.5
//   cameraScale 1.0 → 0      (no-op — forceLink unopposed)
//   cameraScale ≥ 1   → 0
function linkLoosenMul(cameraScale: number): number {
    return Math.max(0, Math.min(1, 1.1 - cameraScale * 1.1));
}

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
// Root-level files (no directory component) are skipped — they have
// no siblings to cluster with.
function dirnameOf(relativePath: string): string {
    const i = relativePath.lastIndexOf("/");
    return i < 0 ? "" : relativePath.slice(0, i);
}

// First `depth` components of a path. 'src/components/data-display/foo.ts'
// at depth=2 -> 'src/components'. Returns '' for root-level files.
function clusterDirAt(relativePath: string, depth: number): string {
    const parts = relativePath.split("/");
    if (parts.length < 2) return "";
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

function directorySubsystemRepulsion(strength: number, depth: number, getMul: () => number = () => 1) {
    let members = new Map<string, SimFileNode[]>();
    function force(alpha: number): void {
        if (members.size < 2) return;
        const mul = getMul();
        if (mul === 0) return;
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
                const f = (strength * mul * alpha * weight) / d2;
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

function directoryClusterForce(strength: number, getMul: () => number = () => 1) {
    let allNodes: SimFileNode[] = [];
    let directoryOf = new Map<string, string>();
    let members = new Map<string, SimFileNode[]>();

    function force(alpha: number): void {
        const mul = getMul();
        if (mul === 0) return;
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
            node.vx = (node.vx ?? 0) + (c.x - node.x) * alpha * strength * mul;
            node.vy = (node.vy ?? 0) + (c.y - node.y) * alpha * strength * mul;
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

// d3-force custom force: a small repulsion between LINKED file
// pairs, modulated by the camera zoom. forceLink's per-link
// strength is cached at .strength() init time so we can't cheaply
// vary it per tick; instead we add a counter force here that
// PUSHES linked pairs apart, scaled up at low zoom. Net effect at
// low zoom: link attraction effectively weakens (the counter
// cancels it more); at high zoom: counter ≈ 0, so forceLink
// dominates.
//
// Direction is *toward each endpoint's away vector* with magnitude
// proportional to (linkDistance / distance) — so once links sit
// near their preferred distance the counter is mild, but if forceLink
// has pulled them very close at low zoom, the counter pushes
// proportionally back.
function linkLooseningForce(
    links: readonly SimImportLink[],
    baseStrength: number,
    getMul: () => number,
) {
    function force(alpha: number): void {
        const mul = getMul();
        if (mul === 0) return;
        for (const link of links) {
            const s = typeof link.source === "string" ? null : link.source;
            const t = typeof link.target === "string" ? null : link.target;
            if (!s || !t) continue;
            const dx = t.x - s.x;
            const dy = t.y - s.y;
            const d2 = dx * dx + dy * dy + 1;
            const d = Math.sqrt(d2);
            const target = linkDistance(link);
            // Only push if currently closer than target — never pull
            // farther than the link's preferred distance.
            if (d >= target) continue;
            const deficit = target - d;
            const f = baseStrength * mul * alpha * (deficit / target);
            const nx = dx / d;
            const ny = dy / d;
            s.vx = (s.vx ?? 0) - nx * f;
            s.vy = (s.vy ?? 0) - ny * f;
            t.vx = (t.vx ?? 0) + nx * f;
            t.vy = (t.vy ?? 0) + ny * f;
        }
    }
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
}

// Builds simulation nodes/links from a project and starts a force simulation.
// Caller is responsible for calling simulation.stop() on cleanup.
export function buildFileLayout(
    project: ProjectResponse,
    // Caller-supplied getter for the current camera zoom. Used by
    // the zoom-modulated forces below: at low zoom we strengthen
    // directory clustering + subsystem repulsion AND apply a
    // link-loosening counter-force, so the layout reads as
    // 'organized by folder' when overview-zoomed. At high zoom
    // these all relax and forceLink + the directional forces
    // dominate, so the layout reads as 'organized by what calls
    // what'. Default getter returns 1 (no modulation) — keeps the
    // function backwards-callable.
    getCameraScale: () => number = () => 1,
): FileLayoutResult {
    const nodes: SimFileNode[] = project.files.map((f, i) => {
        const cs = collapsedSize(f.relativePath);
        return {
            id: f.id,
            relativePath: f.relativePath,
            width: cs.w,
            height: cs.h,
            collapsedW: cs.w,
            collapsedH: cs.h,
            expanded: false,
            // Seed in a small ring so the force simulation has something to spread out.
            x: Math.cos(i * 2.4) * 80,
            y: Math.sin(i * 2.4) * 80,
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
        // Stronger directory pull (was 0.04) so large React-style
        // projects with hundreds of files per directory still settle
        // into visibly distinct clusters rather than interleaving.
        // Multiplier scales UP at low zoom so folder structure
        // dominates the overview view, and DOWN at high zoom so
        // connectivity (forceLink + directional) wins where the
        // user wants to read 'what calls what'.
        .force("directoryCluster", directoryClusterForce(0.13, () => folderMul(getCameraScale())))
        // Inter-subsystem repulsion — same zoom modulation as the
        // cluster force. At low zoom, subsystems push apart hard;
        // at high zoom, the repulsion fades and the link / call /
        // inherit forces take over.
        .force("directorySubsystemRepulsion", directorySubsystemRepulsion(150, 2, () => folderMul(getCameraScale())))
        // Link-loosening counter-force: at low zoom, applies a small
        // repulsion between linked file pairs that's closer than
        // their preferred link distance. Effectively weakens
        // forceLink's pull-together at overview zoom. At high zoom
        // the multiplier is 0 → no-op, forceLink dominates.
        .force("linkLoosen", linkLooseningForce(links, 0.6, () => linkLoosenMul(getCameraScale())))
        .force("clearance", linkClearanceForce(links, LINK_CLEARANCE_STRENGTH))
        .alpha(1)
        .alphaDecay(0.035);

    return {nodes, links, byId, simulation};
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
    // High alpha so the rebalance is visibly animated rather than a teleport.
    layout.simulation.alpha(0.9).restart();
    return true;
}
