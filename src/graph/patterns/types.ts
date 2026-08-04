import type {ProjectResponse} from "../../api/types";
import type {PatternParams} from "../config/types";
import type {SimFileNode, SimImportLink} from "../types";

// Re-exported so pattern modules can import it alongside the pattern types.
export type {PatternParams} from "../config/types";

// ---------------------------------------------------------------------------
// LayoutPattern — a pluggable file-layout strategy.
//
// A pattern turns the project (files + edges) into per-file world positions.
// Patterns come in two flavors, unified by PatternResult so the tier engine can
// treat them uniformly:
//
//   * STATIC  — positions computed once (folder-grid, hub-and-spoke, treemap).
//               Recomputed only when the project or the pattern's params change.
//   * LIVE    — a running simulation that ticks per frame (force-connectivity).
//               The tier engine ticks it only while its tier is active or in a
//               crossfade band, and freezes it otherwise.
// ---------------------------------------------------------------------------

// UI/validation metadata for one tunable parameter. ParamControls renders one
// control per ParamSpec; sanitizeConfig clamps values to [min, max] whenever a
// config comes back from storage.
export interface ParamSpec {
    key: string;
    label: string;
    type: "number" | "boolean" | "enum";
    default: number | boolean | string;
    min?: number;
    max?: number;
    step?: number;
    options?: readonly string[];
    help?: string;
}

// Positions are world-space file centers, keyed by fileId.
export type PositionMap = Map<string, {x: number; y: number}>;

export interface StaticPositions {
    kind: "static";
    positions: PositionMap;
}

export interface LiveLayout {
    kind: "live";
    // Advance the simulation one step. Called by the tier engine only when this
    // pattern's tier is active or crossfading (perf contract).
    tick(): void;
    settled(): boolean;
    reheat(alpha?: number): void;
    // Read-only snapshot the tier engine copies into the tier's buffer each
    // ticked frame. The pattern keeps its own internal working positions.
    positions: PositionMap;
    // Optional hooks the renderer calls when file expansion / sizes change, so
    // a live force layout can re-balance (only force-connectivity implements).
    onExpansionChanged?(expanded: ReadonlySet<string>): void;
    onSizesChanged?(): void;
    dispose(): void;
}

export type PatternResult = StaticPositions | LiveLayout;

// Shared, already-built graph objects handed to every pattern so live patterns
// reuse the SAME SimFileNode instances (expansion / width / pin state lives on
// the node) instead of constructing their own.
export interface PatternBuildContext {
    nodes: SimFileNode[];
    links: SimImportLink[];
    byId: Map<string, SimFileNode>;
}

export interface LayoutPattern {
    id: string;
    name: string;
    description: string;
    // Whether compute() yields a static position map or a live (tickable)
    // simulation. Lets the tier engine route patterns without calling compute().
    kind: "static" | "live";
    params: readonly ParamSpec[];
    // Param defaults derived from `params` (key -> default).
    defaults(): PatternParams;
    compute(project: ProjectResponse, params: PatternParams, shared: PatternBuildContext): PatternResult;
}

// Helper: build a PatternParams object of every spec's default value.
export function defaultsFromSpecs(specs: readonly ParamSpec[]): PatternParams {
    const out: PatternParams = {};
    for (const s of specs) out[s.key] = s.default;
    return out;
}
