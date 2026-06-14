import {Graphics} from "pixi.js";
import type {EdgeLineStyle, LodConfig} from "../graph/config/types";
import {isCircular, type FileLayoutResult} from "../graph/layout";
import type {ImportEdge, SemanticEdge} from "../api/types";
import type {AstForceLayout} from "../graph/astForce";
import type {TreemapLayout} from "../graph/treemap";
import {liveTheme} from "./theme";
import {SYNTAX} from "./astStyle";
import {findVisibleAnchor, type HitRect} from "./hitTest";
import {isStoryFile} from "./storybookOverlay";

// Edge-length LOD: maps the on-screen length of an edge segment to an
// alpha multiplier. Short edges (local intra-cluster plumbing) get
// progressively muted to ~MIN_ALPHA; long edges (cross-cluster
// architectural connections) keep full strength. Linear ramp between
// the two thresholds.
export function edgeLengthAlphaMultiplier(sx: number, sy: number, tx: number, ty: number, cameraScale: number, lod: LodConfig): number {
    // Convert world distance to screen pixels.
    const screenLen = Math.hypot(tx - sx, ty - sy) * cameraScale;
    if (screenLen >= lod.edgeLengthBrightPx) return 1;
    if (screenLen <= lod.edgeLengthDimPx) return lod.edgeLengthMinAlpha;
    const t = (screenLen - lod.edgeLengthDimPx) / (lod.edgeLengthBrightPx - lod.edgeLengthDimPx);
    return lod.edgeLengthMinAlpha + (1 - lod.edgeLengthMinAlpha) * t;
}

// Pixi v8 Graphics has no native line dash, so a dashed stroke is just each
// "on" span emitted as its own moveTo/lineTo subpath; the caller strokes them
// all with one .stroke(). Lengths are world units (callers pass screen-
// constant values via 1/cameraScale where the layer is counter-scaled).
// Lay down an import-edge path from (sx,sy) to (tx,ty) in the chosen style,
// leaving it ready for the caller to .stroke(). straight = direct line;
// curved = a gentle perpendicular-bowed quadratic arc (reads well at any
// orientation); square = orthogonal steps (horizontal → vertical → horizontal
// through the midpoint x).
export function traceEdge(gfx: Graphics, sx: number, sy: number, tx: number, ty: number, style: EdgeLineStyle): void {
    gfx.moveTo(sx, sy);
    if (style === "curved") {
        const dx = tx - sx;
        const dy = ty - sy;
        const len = Math.hypot(dx, dy) || 1;
        const bow = len * 0.18;
        const mx = (sx + tx) / 2 + (-dy / len) * bow;
        const my = (sy + ty) / 2 + (dx / len) * bow;
        gfx.quadraticCurveTo(mx, my, tx, ty);
    } else if (style === "square") {
        const mx = (sx + tx) / 2;
        gfx.lineTo(mx, sy).lineTo(mx, ty).lineTo(tx, ty);
    } else if (style === "semi-square") {
        // Orthogonal steps, but each corner rounded with an arc. Radius is half
        // the shorter leg (capped by geometry so segments stay straight between
        // corners) — reads as "square with rounded corners".
        const mx = (sx + tx) / 2;
        const r = Math.min(Math.abs(mx - sx), Math.abs(ty - sy) / 2) * 0.5;
        gfx.arcTo(mx, sy, mx, ty, r);
        gfx.arcTo(mx, ty, tx, ty, r);
        gfx.lineTo(tx, ty);
    } else {
        gfx.lineTo(tx, ty);
    }
}

export function emitDashed(gfx: Graphics, pts: {x: number; y: number}[], dash: number, gap: number): void {
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
export function cubicPath(p0: {x: number; y: number}, c1: {x: number; y: number}, c2: {x: number; y: number}, p3: {x: number; y: number}, steps: number): {x: number; y: number}[] {
    const pts: {x: number; y: number}[] = [];
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

export function drawEdges(
    layout: FileLayoutResult,
    edges: readonly ImportEdge[],
    forceLookup: (fileId: string) => AstForceLayout | undefined,
    gfx: Graphics,
    cameraScale: number,
    visibleSemanticPairs: ReadonlySet<string>,
    // Currently-selected ids. Drives directional COLOUR of an
    // import line that touches a selected file: yellow when the
    // selected file is the importer (line goes FROM it), blue when
    // the selected file is the imported (line points TO it). Edges
    // not touching the selection stay liveTheme.colors.edge (grey).
    selectionSet: ReadonlySet<string>,
    // Focus-mode live set: import edges with at least one endpoint
    // outside it dim down to ~18% so they recede into the background.
    // null = focus off, render all edges at full strength.
    liveFiles: ReadonlySet<string> | null,
    // Path-trace edge keys: `${a}|${b}` (both directions) for every
    // edge that's part of the user's current path. Path edges are
    // drawn an extra time on top of the normal stroke, thicker and
    // in the func / yellow colour, so they read as one continuous
    // highlighted run regardless of dimming.
    pathEdgeKeys: ReadonlySet<string>,
    // Set of file IDs to suppress entirely (because they're hidden
    // support files). Skips any edge with either endpoint in this
    // set. null = render everything.
    hiddenFileIds: ReadonlySet<string> | null,
    // file id → containing directory. Used by the intra-directory
    // edge LOD: when cameraScale is below INTRA_DIR_BELOW and both
    // endpoints share a directory, skip the edge so the diagram
    // shows only cross-cluster connections at low zoom.
    fileToDir: ReadonlyMap<string, string>,
    // When set (the caller passes it only while NOTHING is selected),
    // edges take the hull colour of the IMPORTED file's folder
    // grouping — "this line feeds into THAT cluster" — instead of the
    // uniform grey. With a selection active this is null and the
    // directional yellow/blue/green colouring below stays the only
    // signal, with non-selection edges quiet grey behind it.
    clusterColorOf: ((dir: string) => number) | null,
    // LOD thresholds (intra-dir gate + edge-length alpha ramp).
    lod: LodConfig,
    // How to route each connection line (straight / curved / square).
    edgeStyle: EdgeLineStyle,
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
        if (hiddenFileIds && (hiddenFileIds.has(edge.fromId) || hiddenFileIds.has(edge.toId))) {
            continue;
        }
        // Intra-directory LOD: at low zoom, suppress sibling edges so
        // the architectural cross-cluster lines stand out.
        if (cameraScale < lod.intraDirBelow) {
            const dirFrom = fileToDir.get(edge.fromId);
            const dirTo = fileToDir.get(edge.toId);
            if (dirFrom != null && dirFrom === dirTo) continue;
        }
        // An EXPANDED story file's link to its component(s) is the
        // story embed's headline relationship — "this panel renders
        // THAT file" — so it bypasses everything that would normally
        // quiet a short local import: the semantic-pair suppression,
        // the focus-mode dim, and the edge-length muting below.
        const storyLink = (s.expanded === true && isStoryFile(s.relativePath)) || (t.expanded === true && isStoryFile(t.relativePath));
        if (!storyLink && visibleSemanticPairs.has(`${edge.fromId} ${edge.toId}`)) continue;

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

        // Target point: clip to the circle whenever the target is
        // currently drawn as one (expanded OR animating). Using
        // `isCircular` instead of just `expanded` keeps the line end
        // pinned to the visible boundary throughout a collapse — without
        // this, the line would un-clip the moment `expanded` flips and
        // shoot to the (still off-centre) sim coords inside the
        // still-visible shrinking circle.
        let tx = t.x;
        let ty = t.y;
        if (isCircular(t)) {
            const r = t.width / 2;
            const dx = tx - sx;
            const dy = ty - sy;
            const dist = Math.hypot(dx, dy);
            if (dist > r) {
                tx -= (dx / dist) * r;
                ty -= (dy / dist) * r;
            }
        }

        let edgeAlpha = 0.7;
        const onPath = pathEdgeKeys.has(`${edge.fromId}|${edge.toId}`);
        if (liveFiles && !onPath && !storyLink && (!liveFiles.has(edge.fromId) || !liveFiles.has(edge.toId))) {
            edgeAlpha *= 0.18;
        }
        // Edge-length LOD: short edges (within-cluster local imports)
        // get progressively muted; long edges (cross-cluster
        // architectural links) stay bright. Path-traced edges always
        // stay bright — they ARE the user's question. Likewise an
        // expanded story's component links: short and same-directory
        // by nature, but exactly what the user is looking at.
        if (!onPath && !storyLink) {
            edgeAlpha *= edgeLengthAlphaMultiplier(sx, sy, tx, ty, cameraScale, lod);
        }
        // Directional colour. If the IMPORTING file (edge.fromId) is
        // selected the line goes OUT from it → yellow. If the
        // IMPORTED file (edge.toId) is selected the line points IN to
        // it → blue. If BOTH endpoints are selected the relationship
        // is bidirectional from the user's perspective → green.
        // Edges that don't touch any selection keep the default grey.
        const fromSel = selectionSet.has(edge.fromId);
        const toSel = selectionSet.has(edge.toId);
        // No-selection base colour: the imported file's cluster hue
        // (see clusterColorOf above), falling back to the theme grey
        // for files outside any grouping.
        let restColor = liveTheme.colors.edge;
        if (clusterColorOf) {
            const targetDir = fileToDir.get(edge.toId);
            if (targetDir != null) restColor = clusterColorOf(targetDir);
        }
        const edgeColor = fromSel && toSel ? liveTheme.colors.edgeBidirectional : fromSel ? liveTheme.colors.edgeImporting : toSel ? liveTheme.colors.edgeImported : restColor;
        traceEdge(gfx, sx, sy, tx, ty, edgeStyle);
        gfx.stroke({
            color: edgeColor,
            width: 1.5 / cameraScale, // ~1.5px on screen, zoom-stable
            alpha: edgeAlpha,
        });
        if (onPath) {
            // Re-stroke in func / yellow on top of the normal stroke so the
            // path overlay is consistent across import + semantic edges.
            traceEdge(gfx, sx, sy, tx, ty, edgeStyle);
            gfx.stroke({
                color: SYNTAX.func,
                width: 3.5 / cameraScale,
                alpha: 0.85,
            });
        }
    }
}

// Call/implements connector. Picks the closest pair of edge-midpoint ports
// (top/bottom/left/right center) on the caller and callee rects so the two
// nodes connect over the shortest span, and bows the curve out perpendicular
// to each chosen face (handle length scales with the gap, clamped).
export function callConnector(
    from: {x: number; y: number; w: number; h: number},
    to: {x: number; y: number; w: number; h: number},
): {
    startPort: {x: number; y: number};
    endPort: {x: number; y: number};
    cp1: {x: number; y: number};
    cp2: {x: number; y: number};
} {
    const ports = (r: {x: number; y: number; w: number; h: number}) => {
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        return [
            {x: cx, y: r.y, nx: 0, ny: -1}, // top
            {x: cx, y: r.y + r.h, nx: 0, ny: 1}, // bottom
            {x: r.x, y: cy, nx: -1, ny: 0}, // left
            {x: r.x + r.w, y: cy, nx: 1, ny: 0}, // right
        ];
    };
    const fps = ports(from);
    const tps = ports(to);
    let best = {d: Infinity, a: fps[0], b: tps[0]};
    for (const a of fps) {
        for (const b of tps) {
            const d = Math.hypot(b.x - a.x, b.y - a.y);
            if (d < best.d) best = {d, a, b};
        }
    }
    const {a, b, d} = best;
    // Handle out of each face so the curve enters/exits perpendicular; scales
    // with the span, with a floor (short hops still bow) and a cap.
    const h = Math.min(Math.max(d * 0.5, 36), 260);
    return {
        startPort: {x: a.x, y: a.y},
        endPort: {x: b.x, y: b.y},
        cp1: {x: a.x + a.nx * h, y: a.y + a.ny * h},
        cp2: {x: b.x + b.nx * h, y: b.y + b.ny * h},
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
export function viaPortsOpposite(
    from: {x: number; y: number; w: number; h: number},
    via: {x: number; y: number; w: number; h: number},
    to: {x: number; y: number; w: number; h: number},
): {
    entry: {x: number; y: number; nx: number; ny: number};
    exit: {x: number; y: number; nx: number; ny: number};
} {
    const cf = {x: from.x + from.w / 2, y: from.y + from.h / 2};
    const ct = {x: to.x + to.w / 2, y: to.y + to.h / 2};
    const cv = {x: via.x + via.w / 2, y: via.y + via.h / 2};
    const top = {x: cv.x, y: via.y, nx: 0, ny: -1};
    const bottom = {x: cv.x, y: via.y + via.h, nx: 0, ny: 1};
    const left = {x: via.x, y: cv.y, nx: -1, ny: 0};
    const right = {x: via.x + via.w, y: cv.y, nx: 1, ny: 0};
    const pairs: [{x: number; y: number; nx: number; ny: number}, {x: number; y: number; nx: number; ny: number}][] = [
        [top, bottom],
        [left, right],
    ];
    type Choice = {
        entry: {x: number; y: number; nx: number; ny: number};
        exit: {x: number; y: number; nx: number; ny: number};
        score: number;
    };
    let best: Choice = {entry: pairs[0][0], exit: pairs[0][1], score: Infinity};
    for (const [a, b] of pairs) {
        const o1 = Math.hypot(a.x - cf.x, a.y - cf.y) + Math.hypot(b.x - ct.x, b.y - ct.y);
        const o2 = Math.hypot(b.x - cf.x, b.y - cf.y) + Math.hypot(a.x - ct.x, a.y - ct.y);
        if (o1 < best.score) best = {entry: a, exit: b, score: o1};
        if (o2 < best.score) best = {entry: b, exit: a, score: o2};
    }
    return {entry: best.entry, exit: best.exit};
}

// Cubic curve from an arbitrary fixed start port (with its outward normal)
// to the closest face midpoint on `to`. Mirror of callConnector but with
// one endpoint pinned — used to anchor both halves of a via-routed edge
// at the same point on the via-binding.
export function curveFromPortToRect(
    start: {x: number; y: number; nx: number; ny: number},
    to: {x: number; y: number; w: number; h: number},
): {
    startPort: {x: number; y: number};
    endPort: {x: number; y: number};
    cp1: {x: number; y: number};
    cp2: {x: number; y: number};
} {
    const cx = to.x + to.w / 2;
    const cy = to.y + to.h / 2;
    const candidates = [
        {x: cx, y: to.y, nx: 0, ny: -1},
        {x: cx, y: to.y + to.h, nx: 0, ny: 1},
        {x: to.x, y: cy, nx: -1, ny: 0},
        {x: to.x + to.w, y: cy, nx: 1, ny: 0},
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
        startPort: {x: start.x, y: start.y},
        endPort: {x: best.x, y: best.y},
        cp1: {x: start.x + start.nx * h, y: start.y + start.ny * h},
        cp2: {x: best.x + best.nx * h, y: best.y + best.ny * h},
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
export function inheritanceBezierControls(start: {x: number; y: number}, end: {x: number; y: number}): {cp1: {x: number; y: number}; cp2: {x: number; y: number}} {
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    // Back-travel: the subclass top sitting *above* the superclass bottom is
    // the cusp case (curve exits downward then has to climb back up). Feed it
    // into the reach so that loop rounds out instead of kinking.
    const back = Math.max(0, -dy);
    const reach = clamp(0.5 * Math.abs(dy) + 0.7 * back + 40, 64, 320);
    const bias = clamp(0.3 * Math.abs(dx) + 18, 24, 150) * Math.sign(dx || 1);
    return {
        cp1: {x: start.x + bias, y: start.y + reach},
        cp2: {x: end.x, y: end.y - reach},
    };
}

export function drawSemanticEdges(
    edges: readonly SemanticEdge[],
    // Bottom-layer gfx (below the overlay panes). Pass-through edges
    // that don't touch any overlay land here so overlays correctly
    // obscure them where they cross.
    gfxBelow: Graphics,
    // Top-layer gfx (above all overlay panes). Connectors whose
    // source or target rect was rendered by an overlay this frame
    // land here so the user can see the connector originating from
    // (or terminating at) its overlay-resident node, instead of the
    // overlay swallowing one end of it.
    gfxAbove: Graphics,
    // AST ids the overlay pass actually rendered. Used to decide
    // which gfx layer each edge belongs on.
    overlayAstSet: ReadonlySet<string>,
    visibleById: Map<string, HitRect>,
    treeLookup: (fileId: string) => TreemapLayout | undefined,
    cameraScale: number,
    selectionSet: ReadonlySet<string>,
    expandedFiles: ReadonlySet<string>,
    // Rebuilt here each frame: directional `${fromFile} ${toFile}` keys for
    // every edge actually drawn, so drawEdges can suppress redundant imports.
    visibleSemanticPairs: Set<string>,
    // User's HUD toggle for which edge kinds to draw. We still RECORD
    // visibleSemanticPairs for hidden edges so suppressed import lines
    // don't reappear when calls are merely toggled off — toggling
    // imports back ON shouldn't make redundant import lines flicker
    // back in.
    edgeFilter: {calls: boolean; extends: boolean},
    // Focus-mode live set: files inside the current neighbourhood.
    // Edges with at least one endpoint NOT in this set are dimmed.
    // null means focus mode is off (everything renders at full strength).
    liveFiles: ReadonlySet<string> | null,
    // Path-trace edge keys: `${fromFile}|${toFile}` (both directions)
    // for every edge that's part of the user's current path. Path
    // edges skip the focus-dimming multiplier so they stay bright.
    pathEdgeKeys: ReadonlySet<string>,
    // File IDs to suppress entirely (because they're hidden support
    // files). Edges whose endpoint resolves to one of these files are
    // skipped wholesale. null = render everything.
    hiddenFileIds: ReadonlySet<string> | null,
    // file id → containing directory, for the intra-directory LOD
    // gate (see drawEdges).
    fileToDir: ReadonlyMap<string, string>,
    // LOD thresholds (intra-dir gate + edge-length alpha ramp).
    lod: LodConfig,
): void {
    visibleSemanticPairs.clear();
    const fileOf = (id: string): string => {
        const i = id.lastIndexOf("#");
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
        // User-driven kind filter. 'extends' covers both 'extends' and
        // 'implements' semantic edges (they're structurally the same
        // "this thing is built from that thing" relationship and toggle
        // together).
        if (edge.kind === "calls" && !edgeFilter.calls) continue;
        if ((edge.kind === "extends" || edge.kind === "implements") && !edgeFilter.extends) {
            continue;
        }
        // Hidden-files filter: same suppression as drawEdges. Endpoint
        // file id is the part of the AST id before '#'; if either side
        // resolves to a hidden file, skip the edge entirely.
        if (hiddenFileIds || cameraScale < lod.intraDirBelow) {
            const fromF = fileOf(edge.fromId);
            const toF = fileOf(edge.toId);
            if (hiddenFileIds && (hiddenFileIds.has(fromF) || hiddenFileIds.has(toF))) {
                continue;
            }
            if (cameraScale < lod.intraDirBelow) {
                const dirFrom = fileToDir.get(fromF);
                const dirTo = fileToDir.get(toF);
                if (dirFrom != null && dirFrom === dirTo) continue;
            }
        }
        // Per-edge layer choice: above the overlay panes if either
        // endpoint resolves to an overlay-rendered rect; else below
        // (so an overlay still obscures pass-through connectors that
        // don't relate to it).
        const gfx = overlayAstSet.has(edge.fromId) || overlayAstSet.has(edge.toId) ? gfxAbove : gfxBelow;
        // Call links come back early (CALLS_BELOW), well before full detail —
        // otherwise they'd be invisible until an expanded node fills the screen.
        // They're still only meaningful when you can see who's calling: if the
        // caller's own node isn't on screen (its file is collapsed, or it was
        // LOD-culled) the edge would just dangle from a lifted ancestor, so
        // require the calling node itself to be directly visible.
        // (`extends`/`implements` still lift to a visible ancestor.)
        if (edge.kind === "calls" && (cameraScale < lod.callsBelow || !visibleById.has(edge.fromId))) {
            continue;
        }
        const from = findVisibleAnchor(edge.fromId, visibleById, treeLookup);
        const to = findVisibleAnchor(edge.toId, visibleById, treeLookup);
        if (!from || !to || from.id === to.id) continue;
        // Call links are dimmed to 50% until you select one of their ends, then
        // shown at full strength. Match the raw endpoints and the resolved
        // visible anchors (the callee may have lifted to an ancestor/file you'd
        // actually click).
        const callerSelected = selectionSet.has(edge.fromId) || selectionSet.has(from.id);
        const calleeSelected = selectionSet.has(edge.toId) || selectionSet.has(to.id);
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
        const style = liveTheme.semanticEdge[edge.kind];
        let edgeAlpha = style.alpha;
        let dashed = false;
        if (edge.kind === "calls") {
            // 30% until the caller/callee is selected, then full strength.
            edgeAlpha = callSelected ? style.alpha : 0.3;
        } else {
            // extends / implements: dashed + 50% by default; fully opaque when the
            // implementing/extending node's file is expanded; solid (and opaque)
            // when that node itself is selected.
            const h = edge.fromId.lastIndexOf("#");
            const srcFile = h > 0 ? edge.fromId.slice(0, h) : edge.fromId;
            const srcSelected = selectionSet.has(edge.fromId) || selectionSet.has(from.id);
            dashed = !srcSelected;
            edgeAlpha = srcSelected || expandedFiles.has(srcFile) ? 1 : 0.5;
        }
        // Focus-mode dim + path-trace exemption: an edge that's part of
        // the user's traced path always renders at full strength
        // regardless of focus dimming, since the path IS the user's
        // current question. Otherwise, if either endpoint's file is
        // outside the live set, dim the edge. `fromFile` / `toFile` were
        // computed above for the visibleSemanticPairs bookkeeping —
        // reuse them.
        const onPath = pathEdgeKeys.has(`${fromFile}|${toFile}`);
        if (liveFiles && !onPath && (!liveFiles.has(fromFile) || !liveFiles.has(toFile))) {
            edgeAlpha *= 0.18;
        }
        // Edge-length LOD (centre-to-centre as a length proxy — the
        // actual bezier is curved but its endpoints' separation is what
        // determines whether it reads as 'local' or 'cross-cluster').
        if (!onPath) {
            const fcx = from.x + from.w / 2;
            const fcy = from.y + from.h / 2;
            const tcx = to.x + to.w / 2;
            const tcy = to.y + to.h / 2;
            edgeAlpha *= edgeLengthAlphaMultiplier(fcx, fcy, tcx, tcy, cameraScale, lod);
        }
        // Routing the extends/implements line THROUGH the import binding when
        // the source file is expanded: subclass → local imported name → real
        // superclass (which lives in another file). The import binding itself
        // gets the dashed outline below so it visually stands in for the
        // external symbol it represents.
        let via: HitRect | null = null;
        if ((edge.kind === "extends" || edge.kind === "implements") && edge.viaImportNodeId) {
            const srcFile = fromFile;
            if (expandedFiles.has(srcFile)) {
                const v = findVisibleAnchor(edge.viaImportNodeId, visibleById, treeLookup);
                // Only honor the via-binding when it resolves to something INSIDE
                // the source file's AST (not the fallback file rect). If LOD has
                // culled it down to the file itself, the routed path would
                // degenerate, so we draw the direct connector instead.
                if (v && v.id !== from.id && v.id !== to.id && v.id !== srcFile) {
                    via = v;
                }
            }
        }

        let startPort: {x: number; y: number};
        let endPort: {x: number; y: number};
        let cp1: {x: number; y: number};
        let cp2: {x: number; y: number};
        // For the via-routed path we also need a second curve's controls.
        let cp1b: {x: number; y: number} | null = null;
        let cp2b: {x: number; y: number} | null = null;
        let midPortIn: {x: number; y: number} | null = null;
        let midPortOut: {x: number; y: number} | null = null;
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
        } else if (edge.kind === "extends") {
            startPort = {x: to.x + to.w / 2, y: to.y + to.h}; // bottom of superclass
            endPort = {x: from.x + from.w / 2, y: from.y}; // top of subclass
            ({cp1, cp2} = inheritanceBezierControls(startPort, endPort));
        } else {
            // Closest top/bottom/left/right edge-center ports on both rects.
            ({startPort, endPort, cp1, cp2} = callConnector(from, to));
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
            gfx.stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
            if (via && midPortOut && cp1b && cp2b) {
                // Second curve: via.exit → to. Same dash so the two segments
                // read as one routed connector. The gap between midPortIn and
                // midPortOut is the dashed-outlined import binding.
                emitDashed(gfx, cubicPath(midPortOut, cp1b, cp2b, endPort, 48), 3.5 * invScale, 2.5 * invScale);
                gfx.stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
                // Dashed outline around the import-binding rect: marks it as the
                // local stand-in for the external superclass/interface.
                const rectPath = [
                    {x: via.x, y: via.y},
                    {x: via.x + via.w, y: via.y},
                    {x: via.x + via.w, y: via.y + via.h},
                    {x: via.x, y: via.y + via.h},
                    {x: via.x, y: via.y},
                ];
                emitDashed(gfx, rectPath, 3.5 * invScale, 2.5 * invScale);
                gfx.stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
            }
        } else {
            // Same straight-vs-curved split for the selected/solid edge style.
            if (via && midPortIn) {
                gfx.moveTo(startPort.x, startPort.y)
                    .lineTo(midPortIn.x, midPortIn.y)
                    .stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
            } else {
                gfx.moveTo(startPort.x, startPort.y)
                    .bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endPort.x, endPort.y)
                    .stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
            }
            if (via && midPortOut && cp1b && cp2b) {
                gfx.moveTo(midPortOut.x, midPortOut.y)
                    .bezierCurveTo(cp1b.x, cp1b.y, cp2b.x, cp2b.y, endPort.x, endPort.y)
                    .stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
                gfx.rect(via.x, via.y, via.w, via.h).stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
            }
        }

        // Counter-scaled radius so the port stays a constant size on screen,
        // matching the (also counter-scaled) line, arrowhead and outline.
        const portR = style.arrowSize * 0.35 * invScale;
        for (const p of [startPort, endPort]) {
            const portKey = `${edge.kind}|${Math.round(p.x)},${Math.round(p.y)}`;
            if (drawnPorts.has(portKey)) continue;
            drawnPorts.add(portKey);
            gfx.circle(p.x, p.y, portR).fill({color: style.color, alpha: edgeAlpha});
        }

        // Selection-gated outlines in the edge color (orange for calls), width
        // matching the connecting line. The callee is outlined when it or its
        // caller is selected; the caller is outlined only when it itself is
        // selected. (calls/implements only — `extends` has its own treatment.)
        if (edge.kind !== "extends") {
            const outline = (rect: HitRect, role: string): void => {
                const k = `${edge.kind}|${role}|${rect.id}`;
                if (drawnOutlines.has(k)) return;
                drawnOutlines.add(k);
                gfx.rect(rect.x, rect.y, rect.w, rect.h).stroke({color: style.color, width: style.width * invScale, alpha: edgeAlpha});
            };
            if (callSelected) outline(to, "callee");
            if (callerSelected) outline(from, "caller");
        }

        // A cubic's end derivative is proportional to (P3 - P2), so the incoming
        // direction at the target port is (endPort - lastCp). When the line is
        // routed via the import binding, the LAST curve's control is cp2b.
        const lastCp = cp2b ?? cp2;
        drawArrowhead(gfx, endPort.x, endPort.y, Math.atan2(endPort.y - lastCp.y, endPort.x - lastCp.x), style.arrowSize * invScale, style.color, edgeAlpha);

        // Path-trace overlay: re-stroke the connector in func / yellow on
        // top of the normal curve so the path overlay reads consistently
        // with the import edges' path stroke. Skip when this edge isn't
        // part of the path.
        if (onPath) {
            if (via && midPortOut && cp1b && cp2b) {
                // Two-segment routed path.
                gfx.moveTo(startPort.x, startPort.y)
                    .quadraticCurveTo(cp1.x, cp1.y, midPortIn!.x, midPortIn!.y)
                    .stroke({color: SYNTAX.func, width: 3.5 * invScale, alpha: 0.85});
                gfx.moveTo(midPortOut.x, midPortOut.y)
                    .bezierCurveTo(cp1b.x, cp1b.y, cp2b.x, cp2b.y, endPort.x, endPort.y)
                    .stroke({color: SYNTAX.func, width: 3.5 * invScale, alpha: 0.85});
            } else {
                gfx.moveTo(startPort.x, startPort.y)
                    .bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endPort.x, endPort.y)
                    .stroke({color: SYNTAX.func, width: 3.5 * invScale, alpha: 0.85});
            }
        }
    }
}

export function drawArrowhead(gfx: Graphics, tipX: number, tipY: number, angle: number, size: number, color: number, alpha: number): void {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const baseX = tipX - dx * size;
    const baseY = tipY - dy * size;
    const half = size * 0.45;
    // perpendicular
    const px = -dy;
    const py = dx;
    gfx.poly([tipX, tipY, baseX + px * half, baseY + py * half, baseX - px * half, baseY - py * half]).fill({color, alpha});
}
