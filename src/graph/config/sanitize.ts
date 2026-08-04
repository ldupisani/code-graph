import {getPattern, PATTERN_REGISTRY} from "../patterns/registry";
import type {ParamSpec} from "../patterns/types";
import {CONFIG_VERSION, makeDefaultConfig} from "./defaults";
import type {GraphConfig, LayoutConfig, LayoutSettings, PatternParams} from "./types";

// Validate + coerce an arbitrary object into a well-formed GraphConfig. Fills
// any missing field from the defaults, drops unknown extras, repoints unknown
// pattern ids to the fallback, and clamps each pattern's params to their spec.
//
// The two callers are the two places an OLD config can re-enter the app:
// persistence rehydrate, and snapshot restore. Both can hand us a blob written
// by a build that predates fields this one requires, so neither may skip it.
export function sanitizeConfig(raw: unknown): GraphConfig {
    const base = makeDefaultConfig();
    if (!raw || typeof raw !== "object") return base;
    const r = raw as Record<string, unknown>;

    return {
        version: CONFIG_VERSION,
        layout: sanitizeLayout(r.layout, r.tiers, base.layout),
        behavioral: mergeNumbersBooleans(base.behavioral, r.behavioral),
        lod: mergeNumbersBooleans(base.lod, r.lod),
        theme: sanitizeTheme(base.theme, r.theme),
    };
}

// Coerce a LayoutConfig, MIGRATING from the pre-v2 `tiers` array when needed.
//
// Old shape: an ordered list of zoom-banded tiers, coarse → fine, where the
// coarsest was what you saw at rest (fully zoomed out) and the finest was
// usually the live force layout you only reached by zooming in. So the honest
// translation of "what layout was this user actually looking at" is the first
// STATIC tier — picking tiers[0] blindly would strand anyone whose overview was
// force-connectivity, and picking the last would hand almost everyone force.
// Every tier's params carry over into byPattern, so tuning survives the move.
function sanitizeLayout(raw: unknown, legacyTiers: unknown, base: LayoutConfig): LayoutConfig {
    const byPattern: Record<string, LayoutSettings> = {};
    let patternId: string | null = null;

    if (raw && typeof raw === "object") {
        const l = raw as Record<string, unknown>;
        if (typeof l.patternId === "string" && PATTERN_REGISTRY[l.patternId]) patternId = l.patternId;
        if (l.byPattern && typeof l.byPattern === "object") {
            for (const [id, v] of Object.entries(l.byPattern as Record<string, unknown>)) {
                if (PATTERN_REGISTRY[id]) byPattern[id] = sanitizeSettings(id, v);
            }
        }
    } else if (Array.isArray(legacyTiers)) {
        for (const t of legacyTiers) {
            if (!t || typeof t !== "object") continue;
            const tier = t as Record<string, unknown>;
            const id = typeof tier.patternId === "string" && PATTERN_REGISTRY[tier.patternId] ? tier.patternId : null;
            if (!id) continue;
            // First tier wins per pattern — coarse tiers come first, and a
            // duplicated pattern across tiers is the overview's tuning we want.
            if (!byPattern[id]) byPattern[id] = sanitizeSettings(id, tier);
            if (patternId == null && getPattern(id).kind === "static") patternId = id;
        }
        // All tiers were live (the old "All force (no overview)" preset).
        if (patternId == null && Object.keys(byPattern).length > 0) patternId = Object.keys(byPattern)[0];
    }

    return {patternId: patternId ?? base.patternId, byPattern};
}

// `raw` is either a LayoutSettings or (during migration) a legacy tier — both
// carry `params` / `flipX` / `flipY` at the same keys, so one reader serves both.
function sanitizeSettings(patternId: string, raw: unknown): LayoutSettings {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
        params: clampParams(getPattern(patternId).params, s.params),
        flipX: s.flipX === true,
        flipY: s.flipY === true,
    };
}

// Keep only known param keys, coerce/clamp to each spec.
function clampParams(specs: readonly ParamSpec[], raw: unknown): PatternParams {
    const out: PatternParams = {};
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    for (const spec of specs) {
        const v = r[spec.key];
        if (spec.type === "boolean") out[spec.key] = typeof v === "boolean" ? v : !!spec.default;
        else if (spec.type === "enum") out[spec.key] = typeof v === "string" && (spec.options ?? []).includes(v) ? v : String(spec.default);
        else {
            let n = typeof v === "number" && Number.isFinite(v) ? v : Number(spec.default);
            if (spec.min != null && n < spec.min) n = spec.min;
            if (spec.max != null && n > spec.max) n = spec.max;
            out[spec.key] = n;
        }
    }
    return out;
}

// Shallow merge: keep base, override only with same-typed primitive values.
function mergeNumbersBooleans<T extends object>(base: T, raw: unknown): T {
    if (!raw || typeof raw !== "object") return base;
    const r = raw as Record<string, unknown>;
    const b = base as Record<string, unknown>;
    const out: Record<string, unknown> = {...b};
    for (const k of Object.keys(b)) {
        const v = r[k];
        if (typeof v === typeof b[k] && (typeof v === "number" ? Number.isFinite(v) : true)) out[k] = v;
    }
    return out as T;
}

function sanitizeTheme(base: GraphConfig["theme"], raw: unknown): GraphConfig["theme"] {
    if (!raw || typeof raw !== "object") return base;
    const r = raw as Record<string, unknown>;
    const styles = ["straight", "curved", "square", "semi-square"];
    return {
        colors: mergeNumbersBooleans(base.colors, r.colors),
        semanticEdge: sanitizeSemanticEdge(base.semanticEdge, r.semanticEdge),
        edgeStyle: typeof r.edgeStyle === "string" && styles.includes(r.edgeStyle) ? (r.edgeStyle as GraphConfig["theme"]["edgeStyle"]) : base.edgeStyle,
        // Groups added after theming was extended past bg/file/edge/text. Any
        // config written before them simply has no such key, and
        // mergeNumbersBooleans fills the whole group from defaults.
        syntax: mergeNumbersBooleans(base.syntax, r.syntax),
        folder: mergeNumbersBooleans(base.folder, r.folder),
        fill: mergeNumbersBooleans(base.fill, r.fill),
    };
}

function sanitizeSemanticEdge(base: GraphConfig["theme"]["semanticEdge"], raw: unknown): GraphConfig["theme"]["semanticEdge"] {
    if (!raw || typeof raw !== "object") return base;
    const r = raw as Record<string, unknown>;
    const out = {...base};
    for (const kind of Object.keys(base) as (keyof typeof base)[]) {
        out[kind] = mergeNumbersBooleans(base[kind], r[kind]);
    }
    return out;
}
