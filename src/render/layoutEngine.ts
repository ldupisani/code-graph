import type {ProjectResponse} from "../api/types";
import {layoutSettingsFor} from "../graph/config/layout";
import type {GraphConfig, LayoutSettings} from "../graph/config/types";
import type {FileLayoutResult} from "../graph/layout";
import {getPattern} from "../graph/patterns/registry";
import type {LayoutPattern, PatternBuildContext, PositionMap} from "../graph/patterns/types";
import type {SimFileNode} from "../graph/types";

// ---------------------------------------------------------------------------
// Layout selection + crossfade.
//
// One pattern arranges the files at a time. When the user picks a different one
// we don't cut to it — we hold the OUTGOING pattern's positions alongside the
// incoming one and crossfade over TRANSITION_MS, so files visibly travel to
// their new places and you can follow where a given box went.
//
// This crossfade is the same machinery that used to run off camera zoom (the
// old tier system: N zoom-banded tiers, adjacent bands overlapping, blend
// weight = smoothstep of log-zoom within the band). Only the DRIVER changed —
// from "how far you've zoomed" to "how long since you switched". That's the
// whole point: the arrangement now changes when you ask it to, and holds still
// when you don't.
//
// The render loop computes each node's position as:
//     pos = b == null ? slotPos[a]
//                     : lerp(slotPos[a], slotPos[b], w)
// ---------------------------------------------------------------------------

// Slot indices into SimFileNode.blendX / blendY. Two slots is all we need: a
// switch mid-transition retargets the incoming slot and restarts the tween
// (see sync), so there is never a third layout in flight.
export const SLOT_OUT = 0;
export const SLOT_ACTIVE = 1;

// Crossfade duration. Long enough to read as motion rather than a cut, short
// enough that switching layouts twice in a row doesn't feel sticky.
const TRANSITION_MS = 450;

export interface LayoutSelection {
    // Slot index of the primary (outgoing, or settled) layout.
    a: number;
    // Slot we're crossfading TOWARD, or null when settled (no blend this frame).
    b: number | null;
    // Crossfade weight in [0, 1]: 0 = pure slot a, 1 = fully slot b.
    w: number;
    // Whether each slot holds a STATIC pattern. The renderer needs this to
    // split the blend into its static part and its live/force part, and the
    // engine is the only thing that knows which pattern is in which slot — so
    // it reports it here rather than making the caller reconstruct it.
    aStatic: boolean;
    bStatic: boolean;
}

// Smoothstep ease. Keeps the switch eased in/out instead of ramping linearly.
export function smoothstep(t: number): number {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return c * c * (3 - 2 * c);
}

// ---------------------------------------------------------------------------
// LayoutEngine — links the configured layout to the renderer's per-node buffers.
//
// For each of the (at most two) patterns in flight it holds the pattern's raw
// positions — recomputed only when that pattern's params change — and, each
// frame, re-centres them onto the connectivity centroid into
// node.blendX[slot] / node.blendY[slot]. LIVE (force) patterns are not
// buffered; the renderer's own sim owns those positions, so the slot simply
// mirrors connX/connY. The active static pattern's raw also feeds
// layout.rigidRaw, the force sim's project-scale proxy for its containment
// force.
// ---------------------------------------------------------------------------
export interface LayoutEngine {
    // Pick up a pattern switch or a param edit. Starts the crossfade when the
    // active pattern changed. Cheap no-op otherwise; safe to call every frame.
    sync(config: GraphConfig): void;
    // Advance the crossfade clock. Call once per frame with the frame delta.
    advance(dtMs: number): void;
    // Which slot(s) are live this frame, and the blend weight between them.
    selection(): LayoutSelection;
    // Re-centre each in-flight pattern's positions onto `centre` and write them
    // into node.blendX[slot] / node.blendY[slot] (live patterns mirror
    // connX/connY). Call each frame after the centroid is updated, before
    // reading the buffers to render.
    fillBuffers(config: GraphConfig, centre: {x: number; y: number}, nodes: SimFileNode[]): void;
    // True once after a pattern switch has finished CROSSFADING, so the
    // renderer can re-fit the camera to the arrangement that just arrived.
    // Param tweaks deliberately don't trigger it.
    //
    // Fires at the END of the transition, not the start, for two reasons: the
    // camera holding still while the files travel reads far better than a jump
    // followed by motion, and — the substantive one — only once the blend has
    // settled do the rendered positions belong to the new layout, so only then
    // can the fit measure what's actually on screen (see fitProjectToViewport's
    // `useRendered`).
    takeRefit(): boolean;
    // Tell the engine that the switch it is about to notice comes with a camera
    // the caller has already chosen, so it must NOT re-fit when that switch
    // finishes crossfading.
    //
    // Restoring a snapshot is the case that needs this: it writes a new config
    // (possibly a different pattern) AND the camera the view was saved with. The
    // camera tween is 320ms, the crossfade 450ms — so without this the refit
    // lands after the tween has finished and nulled itself, and silently throws
    // away the zoom the snapshot existed to preserve.
    //
    // Scoped to the NEXT sync() only, not "until a switch happens": a snapshot
    // whose layout matches the current one starts no crossfade at all, and a
    // flag waiting for one would sit armed and swallow the refit from the user's
    // next LayoutBar click instead.
    suppressNextSwitchRefit(): void;
    // DEV-only introspection for the crossfade state machine, surfaced on
    // window.__codegraph. This subsystem is time-dependent and invisible in a
    // screenshot — without it the only way to tell "no refit was queued" from
    // "a refit fired and agreed with the current camera" is to guess.
    debug(): {activeId: string; outgoingId: string | null; elapsedMs: number; pendingRefit: boolean; refitWhenSettled: boolean; suppressArmed: boolean};
}

interface StaticBuf {
    key: string; // pattern id + params signature, to detect changes
    raw: PositionMap; // pattern output, un-centred
    cx: number; // raw bbox centre
    cy: number;
}

export function createLayoutEngine(project: ProjectResponse, layout: FileLayoutResult): LayoutEngine {
    const shared: PatternBuildContext = {nodes: layout.nodes, links: layout.links, byId: layout.byId};
    // Static position buffers, keyed by pattern id. Holds at most the active
    // and outgoing patterns; everything else is dropped in sync().
    const bufs = new Map<string, StaticBuf>();

    let activeId = "";
    let outgoingId: string | null = null;
    let elapsedMs = 0;
    let firstSync = true;
    let pendingRefit = false;
    // Set by suppressNextSwitchRefit, consumed by the very next sync().
    let suppressRefitOnNextSync = false;
    // Whether the crossfade currently in flight should re-fit when it lands.
    let refitWhenSettled = false;

    function computeBuf(patternId: string, settings: LayoutSettings, pattern: LayoutPattern): StaticBuf | null {
        const result = pattern.compute(project, settings.params, shared);
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
            key: `${patternId}|${JSON.stringify(settings.params)}`,
            raw: result.positions,
            cx: Number.isFinite(minX) ? (minX + maxX) / 2 : 0,
            cy: Number.isFinite(minY) ? (minY + maxY) / 2 : 0,
        };
    }

    // Ensure `patternId` has a current buffer (static patterns only), rebuilding
    // it when its params changed. Returns the buffer, or null for live patterns.
    function ensureBuf(config: GraphConfig, patternId: string): StaticBuf | null {
        const pattern = getPattern(patternId);
        if (pattern.kind !== "static") return null;
        const settings = layoutSettingsFor(config.layout, patternId);
        const key = `${patternId}|${JSON.stringify(settings.params)}`;
        const existing = bufs.get(patternId);
        if (existing && existing.key === key) return existing;
        const next = computeBuf(patternId, settings, pattern);
        if (next) bufs.set(patternId, next);
        return next ?? existing ?? null;
    }

    // Write one pattern's centred positions into `slot`. Live patterns (and any
    // pattern with no buffer yet) fall through to the connectivity positions, so
    // the blend can treat every slot uniformly.
    function fillSlot(config: GraphConfig, patternId: string | null, slot: number, centre: {x: number; y: number}, nodes: SimFileNode[]): void {
        const buf = patternId != null && getPattern(patternId).kind === "static" ? bufs.get(patternId) : null;
        if (!buf) {
            for (const n of nodes) {
                n.blendX![slot] = n.connX;
                n.blendY![slot] = n.connY;
            }
            return;
        }
        const settings = layoutSettingsFor(config.layout, patternId!);
        const sx = settings.flipX ? -1 : 1;
        const sy = settings.flipY ? -1 : 1;
        for (const n of nodes) {
            const p = buf.raw.get(n.id);
            if (p) {
                n.blendX![slot] = (p.x - buf.cx) * sx + centre.x;
                n.blendY![slot] = (p.y - buf.cy) * sy + centre.y;
            } else {
                // A file the pattern didn't place (added since it was computed):
                // park it at its connectivity position rather than at the origin.
                n.blendX![slot] = n.connX;
                n.blendY![slot] = n.connY;
            }
        }
    }

    return {
        sync(config) {
            const want = config.layout.patternId;
            // Applies to this call only — see suppressNextSwitchRefit.
            const suppressRefit = suppressRefitOnNextSync;
            suppressRefitOnNextSync = false;

            if (want !== activeId) {
                // A switch. The pattern we were showing becomes the outgoing
                // slot and the tween restarts from 0 — including mid-transition,
                // where the previous outgoing is simply dropped. That's a small
                // visual shortcut (files jump from wherever the interrupted
                // blend had them to the new outgoing's positions) in exchange
                // for never needing a third slot; switching twice inside 450ms
                // is rare enough not to warrant the extra buffer.
                if (!firstSync) {
                    outgoingId = activeId;
                    elapsedMs = 0;
                    refitWhenSettled = !suppressRefit;
                }
                activeId = want;
            }

            ensureBuf(config, activeId);
            if (outgoingId != null) ensureBuf(config, outgoingId);

            // Drop buffers for patterns no longer in flight, so switching
            // between all four doesn't retain four full position maps.
            for (const id of [...bufs.keys()]) if (id !== activeId && id !== outgoingId) bufs.delete(id);

            // Feed the active static layout's raw to rigidRaw, the sim's
            // containment-force scale. When the active pattern is LIVE there is
            // no static buffer to feed it — rigidRaw keeps its last value, which
            // is what the old all-force tier setup did too.
            const activeBuf = bufs.get(activeId);
            if (activeBuf) layout.rigidRaw = activeBuf.raw;

            firstSync = false;
        },
        advance(dtMs) {
            if (outgoingId == null) return;
            elapsedMs += dtMs;
            if (elapsedMs >= TRANSITION_MS) {
                outgoingId = null;
                elapsedMs = 0;
                // The new arrangement has fully arrived — a different pattern
                // has a different extent, so re-frame it now, unless the switch
                // came with a camera of its own (a snapshot restore).
                if (refitWhenSettled) pendingRefit = true;
                refitWhenSettled = false;
            }
        },
        selection() {
            const activeStatic = getPattern(activeId).kind === "static";
            if (outgoingId == null) return {a: SLOT_ACTIVE, b: null, w: 0, aStatic: activeStatic, bStatic: false};
            return {
                a: SLOT_OUT,
                b: SLOT_ACTIVE,
                w: smoothstep(elapsedMs / TRANSITION_MS),
                aStatic: getPattern(outgoingId).kind === "static",
                bStatic: activeStatic,
            };
        },
        fillBuffers(config, centre, nodes) {
            for (const n of nodes) {
                if (!n.blendX) n.blendX = [0, 0];
                if (!n.blendY) n.blendY = [0, 0];
            }
            fillSlot(config, activeId, SLOT_ACTIVE, centre, nodes);
            // Only fill the outgoing slot while it's actually blending —
            // otherwise it's dead work over every node, every frame.
            if (outgoingId != null) fillSlot(config, outgoingId, SLOT_OUT, centre, nodes);
        },
        takeRefit() {
            const r = pendingRefit;
            pendingRefit = false;
            return r;
        },
        debug: () => ({activeId, outgoingId, elapsedMs, pendingRefit, refitWhenSettled, suppressArmed: suppressRefitOnNextSync}),
        suppressNextSwitchRefit() {
            suppressRefitOnNextSync = true;
            // Also drop a refit already queued or in flight: the caller's camera
            // is the newer intent, whatever the engine decided a moment ago.
            pendingRefit = false;
            refitWhenSettled = false;
        },
    };
}
