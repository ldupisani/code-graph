import type {ProjectResponse} from "../api/types";
import type {GraphConfig, LayoutTier} from "../graph/config/types";
import type {FileLayoutResult} from "../graph/layout";
import {getPattern} from "../graph/patterns/registry";
import type {LayoutPattern, PatternBuildContext, PositionMap} from "../graph/patterns/types";
import type {SimFileNode} from "../graph/types";

// ---------------------------------------------------------------------------
// Tier selection + crossfade.
//
// Replaces the old two-pole rigidness() scalar (PixiCanvas.tsx). Given the
// current camera zoom and the configured tiers, decide which tier is showing
// and — when we're inside the overlap band between two adjacent tiers — how far
// to crossfade toward the next one.
//
// The render loop will then compute each node's position as:
//     pos = b == null ? tierPos[a]
//                     : lerp(tierPos[a], tierPos[b], w)
// ---------------------------------------------------------------------------

export interface TierSelection {
    // Index of the primary (coarser / lower-zoom) active tier.
    a: number;
    // Index of the tier we're crossfading TOWARD, or null when we're squarely
    // inside a single tier's exclusive range (no blend this frame).
    b: number | null;
    // Crossfade weight in [0, 1]: 0 = pure tier a, 1 = fully tier b.
    w: number;
}

// Smoothstep ease (matches the old rigidness() curve: t*t*(3-2t)). Use this so
// the crossfade eases in/out instead of ramping linearly.
export function smoothstep(t: number): number {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return c * c * (3 - 2 * c);
}

// === CONTRIBUTION SLOT ======================================================
// TODO(you): implement tier selection + crossfade.
//
// Model:
//   * `tiers` are ordered from coarsest (index 0, zoomed out) to finest
//     (last index, zoomed in).
//   * Each tier is active for the ratio r = cameraScale / fitScale within
//     [tier.zoomFromMul, tier.zoomToMul]. By construction the first tier starts
//     at 0 and the last ends at Infinity.
//   * ADJACENT TIERS OVERLAP. The overlap band between tier i and tier i+1 is
//     [tiers[i+1].zoomFromMul, tiers[i].zoomToMul] (in ratio units). Inside that
//     band we crossfade from i to i+1; outside any band a single tier owns the
//     zoom exclusively.
//
// Return:
//   * Below the first overlap  -> { a: 0, b: null, w: 0 }            (pure tier 0)
//   * Inside band between i,i+1 -> { a: i, b: i+1, w: <0..1> }
//   * Between two bands         -> { a: that tier, b: null, w: 0 }
//   * Above the last overlap    -> { a: last, b: null, w: 0 }        (pure last)
//
// Crossfade weight: zoom is multiplicative, so interpolate in LOG space, then
// ease with smoothstep(). For the band between i and i+1:
//   lo = log(fitScale * tiers[i+1].zoomFromMul)
//   hi = log(fitScale * tiers[i].zoomToMul)
//   w  = smoothstep((log(cameraScale) - lo) / (hi - lo))
//
// (Reference: the old code used lo = log(fitScale*1.5), hi = log(fitScale*4.5),
//  s = smoothstep(...), and a rigid weight of 1 - s. With folder-grid as tier 0
//  and force as tier 1, this function should reproduce that exactly: w == s.)
//
// Edge cases to consider: a single tier (return {0, null, 0}); a degenerate
// zero-width band (hi <= lo) — avoid divide-by-zero; clamp w to [0,1].
export function activeTiers(cameraScale: number, fitScale: number, tiers: LayoutTier[]): TierSelection {
    const n = tiers.length;
    if (n <= 1) return {a: 0, b: null, w: 0};
    const fit = Math.max(fitScale, 1e-4);
    const r = cameraScale / fit; // zoom expressed as a multiple of fitScale

    // Walk adjacent pairs from coarse → fine. The overlap band between tier i
    // and tier i+1 is [tiers[i+1].zoomFromMul, tiers[i].zoomToMul]. Below the
    // first band we're in pure tier 0; inside a band we crossfade i → i+1;
    // once past a band's top we fall through to test the next pair, so the
    // "between bands" and "above last band" cases naturally resolve to a single
    // active tier with b = null.
    for (let i = 0; i < n - 1; i++) {
        const bandLo = tiers[i + 1].zoomFromMul; // crossfade starts here
        const bandHi = tiers[i].zoomToMul; // ...and ends here
        if (r < bandLo) {
            // Below this band — tier i owns the zoom exclusively.
            return {a: i, b: null, w: 0};
        }
        if (r < bandHi) {
            // Inside the overlap band: crossfade i → i+1 in log space. Floor each
            // band edge to 1e-4 BEFORE the log — a zoomFromMul (or zoomToMul) of 0
            // is otherwise Math.log(0) = -Infinity, which makes `w` = smoothstep(
            // Infinity/Infinity) = NaN. That NaN poisons the tier blend weights and
            // every node's x/y downstream, so the whole graph vanishes and can't
            // recover (NaN is sticky frame-to-frame). Mirrors the existing
            // Math.max(1e-4, cameraScale) floor on the numerator.
            const lo = Math.log(Math.max(1e-4, fit * bandLo));
            const hi = Math.log(Math.max(1e-4, fit * bandHi));
            const w = hi <= lo ? 1 : smoothstep((Math.log(Math.max(1e-4, cameraScale)) - lo) / (hi - lo));
            return {a: i, b: i + 1, w};
        }
        // r >= bandHi: past this band, keep walking to test the next pair.
    }
    // Above the last band — the finest tier owns the zoom exclusively.
    return {a: n - 1, b: null, w: 0};
}

// ---------------------------------------------------------------------------
// TierEngine — links the configured tiers to the renderer's per-node buffers.
//
// For EACH static tier it holds the pattern's raw positions (recomputed only
// when that tier's pattern/params change) and, each frame, re-centres them onto
// the connectivity centroid into node.tierX[t]/tierY[t] — the generalisation of
// the old single rigidX/rigidY to N tiers, so adjacent static tiers (e.g.
// treemap → hub-and-spoke) can actually crossfade. LIVE (force) tiers are not
// buffered; the renderer reads connX/connY for those. The coarsest static
// tier's raw also feeds layout.rigidRaw so the force sim's containment force
// keeps a project-scale proxy.
// ---------------------------------------------------------------------------
export interface TierEngine {
    // Recompute any static tier whose pattern/params changed. Cheap no-op
    // otherwise; safe to call every frame.
    sync(config: GraphConfig): void;
    // Re-centre every static tier's positions onto `centre` and write them into
    // node.tierX[t]/tierY[t] (live tiers mirror connX/connY). Call each frame
    // after the centroid is updated, before reading the buffers to render.
    fillBuffers(config: GraphConfig, centre: {x: number; y: number}, nodes: SimFileNode[]): void;
    // True once after any static tier's PATTERN changed (not just params), so
    // the renderer can re-fit the camera. Param tweaks deliberately don't.
    takeRefit(): boolean;
}

interface StaticTierBuf {
    key: string; // pattern id + params signature, to detect changes
    raw: PositionMap; // pattern output, un-centred
    cx: number; // raw bbox centre
    cy: number;
}

export function createTierEngine(project: ProjectResponse, layout: FileLayoutResult): TierEngine {
    const shared: PatternBuildContext = {nodes: layout.nodes, links: layout.links, byId: layout.byId};
    // Per-tier static buffers, keyed by tier id (survives reorders).
    const bufs = new Map<string, StaticTierBuf>();
    // Signature of all static tiers' pattern ids, to detect pattern swaps.
    let lastPatternSig = "";
    let firstSync = true;
    let pendingRefit = false;

    function computeBuf(tier: LayoutTier, pattern: LayoutPattern): StaticTierBuf | null {
        const result = pattern.compute(project, tier.params, shared);
        if (result.kind !== "static") return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of result.positions.values()) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return {
            key: "",
            raw: result.positions,
            cx: Number.isFinite(minX) ? (minX + maxX) / 2 : 0,
            cy: Number.isFinite(minY) ? (minY + maxY) / 2 : 0,
        };
    }

    return {
        sync(config) {
            const seen = new Set<string>();
            const patternIds: string[] = [];
            let firstStaticBuf: StaticTierBuf | null = null;
            for (const tier of config.tiers) {
                const pattern = getPattern(tier.patternId);
                if (pattern.kind !== "static") continue;
                patternIds.push(pattern.id);
                seen.add(tier.id);
                const key = `${pattern.id}|${JSON.stringify(tier.params)}`;
                let buf = bufs.get(tier.id);
                if (!buf || buf.key !== key) {
                    const next = computeBuf(tier, pattern);
                    if (next) {
                        next.key = key;
                        bufs.set(tier.id, next);
                        buf = next;
                    }
                }
                if (!firstStaticBuf && buf) firstStaticBuf = buf;
            }
            // Drop buffers for tiers that no longer exist or are no longer static.
            for (const id of [...bufs.keys()]) if (!seen.has(id)) bufs.delete(id);
            // Feed the coarsest static tier's raw to rigidRaw for the sim's
            // containment-force scale (a project-size proxy).
            if (firstStaticBuf) layout.rigidRaw = firstStaticBuf.raw;
            // Refit when the set of static patterns changes (a pattern swap),
            // but not on the very first sync (camera was fit at project open).
            const sig = patternIds.join("|");
            if (!firstSync && sig !== lastPatternSig) pendingRefit = true;
            lastPatternSig = sig;
            firstSync = false;
        },
        fillBuffers(config, centre, nodes) {
            const tiers = config.tiers;
            for (const n of nodes) {
                if (!n.tierX || n.tierX.length < tiers.length) n.tierX = new Array(tiers.length).fill(0);
                if (!n.tierY || n.tierY.length < tiers.length) n.tierY = new Array(tiers.length).fill(0);
            }
            for (let t = 0; t < tiers.length; t++) {
                const pattern = getPattern(tiers[t].patternId);
                if (pattern.kind === "static") {
                    const buf = bufs.get(tiers[t].id);
                    if (!buf) continue;
                    // Centre the raw layout on `centre`, optionally mirroring it
                    // across the vertical (flipX) / horizontal (flipY) axis.
                    const sx = tiers[t].flipX ? -1 : 1;
                    const sy = tiers[t].flipY ? -1 : 1;
                    for (const n of nodes) {
                        const p = buf.raw.get(n.id);
                        if (p) {
                            n.tierX![t] = (p.x - buf.cx) * sx + centre.x;
                            n.tierY![t] = (p.y - buf.cy) * sy + centre.y;
                        } else {
                            n.tierX![t] = n.connX;
                            n.tierY![t] = n.connY;
                        }
                    }
                } else {
                    // Live (force) tier: mirror the connectivity positions so the
                    // crossfade can treat every tier uniformly.
                    for (const n of nodes) {
                        n.tierX![t] = n.connX;
                        n.tierY![t] = n.connY;
                    }
                }
            }
        },
        takeRefit() {
            const r = pendingRefit;
            pendingRefit = false;
            return r;
        },
    };
}
