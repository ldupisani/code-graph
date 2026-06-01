import {getPattern, PATTERN_REGISTRY} from "../patterns/registry";
import type {ParamSpec} from "../patterns/types";
import {CONFIG_VERSION, makeDefaultConfig} from "./defaults";
import type {GraphConfig, LayoutTier, PatternParams} from "./types";

// A saved template is a named, full GraphConfig. `builtin` marks shipped presets
// (not persisted, not deletable).
export interface Template {
    id: string;
    name: string;
    builtin?: boolean;
    config: GraphConfig;
}

// The on-disk JSON envelope for export/import.
interface TemplateFile {
    version: number;
    name: string;
    config: unknown;
}

// Validate + coerce an arbitrary object into a well-formed GraphConfig. Fills
// any missing field from the defaults, drops unknown extras, repoints unknown
// pattern ids to the fallback, and clamps each tier's params to their spec.
// Used by both persistence migration and JSON import so neither can crash the
// renderer with a malformed config.
export function sanitizeConfig(raw: unknown): GraphConfig {
    const base = makeDefaultConfig();
    if (!raw || typeof raw !== "object") return base;
    const r = raw as Record<string, unknown>;

    const tiers = Array.isArray(r.tiers) ? r.tiers.map(sanitizeTier).filter(Boolean) as LayoutTier[] : base.tiers;
    return {
        version: CONFIG_VERSION,
        tiers: tiers.length > 0 ? tiers : base.tiers,
        behavioral: mergeNumbersBooleans(base.behavioral, r.behavioral),
        lod: mergeNumbersBooleans(base.lod, r.lod),
        theme: sanitizeTheme(base.theme, r.theme),
    };
}

function sanitizeTier(raw: unknown, i: number): LayoutTier | null {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    const patternId = typeof t.patternId === "string" && PATTERN_REGISTRY[t.patternId] ? t.patternId : getPattern("").id;
    const pattern = getPattern(patternId);
    return {
        id: typeof t.id === "string" ? t.id : `tier-${i}`,
        name: typeof t.name === "string" ? t.name : `Tier ${i + 1}`,
        zoomFromMul: numOr(t.zoomFromMul, 0),
        zoomToMul: t.zoomToMul === null ? Infinity : numOr(t.zoomToMul, Infinity),
        patternId,
        params: clampParams(pattern.params, t.params),
        flipX: t.flipX === true,
        flipY: t.flipY === true,
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

function numOr(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function serializeTemplate(t: Template): string {
    const file: TemplateFile = {version: CONFIG_VERSION, name: t.name, config: t.config};
    return JSON.stringify(file, null, 2);
}

// Parse an exported template JSON into a sanitized config + name. Tolerant:
// returns an error string instead of throwing on bad input.
export function parseTemplateFile(json: string): {ok: true; name: string; config: GraphConfig} | {ok: false; error: string} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return {ok: false, error: "Not valid JSON"};
    }
    if (!parsed || typeof parsed !== "object") return {ok: false, error: "Expected a JSON object"};
    const f = parsed as Record<string, unknown>;
    // Accept either the {version,name,config} envelope or a bare config.
    const rawConfig = "config" in f ? f.config : f;
    const name = typeof f.name === "string" && f.name.trim() ? f.name : "Imported";
    return {ok: true, name, config: sanitizeConfig(rawConfig)};
}
