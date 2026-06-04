import type {SemanticEdgeKind} from "../../api/types";

// ---------------------------------------------------------------------------
// GraphConfig — the single source of truth for everything the user can tune.
//
// Historically every tunable lived as a scattered module- or closure-scoped
// `const` inside PixiCanvas.tsx / layout.ts. This object collects them so
// they can be edited live (via useConfigStore), persisted, and saved as
// named templates. The renderer reads the *current* config each frame through
// a mutable ref (see PixiCanvas's configRef) — config edits never tear down
// the canvas.
//
// NOTE on phasing: the full shape is defined up-front so later phases don't
// churn the type. In Phase 1 only `lod` and the behavioral *thresholds* are
// actually consumed by the renderer; `tiers`, `theme`, `openLayoutBias`, and
// the isolate flags exist with faithful defaults but are wired in later
// phases (tiers → Phase 2, theme → Phase 6, isolate move → Phase 6).
// ---------------------------------------------------------------------------

// A pattern's tuned parameter values (keyed by ParamSpec.key). The schema
// that describes/validates these lives with each LayoutPattern (patterns/types).
export type PatternParams = Record<string, number | boolean | string>;

// One zoom tier: owns a zoom range (as a MULTIPLE of fitScale, preserving the
// project-fit-relative semantics of the old rigidness() band) and the single
// layout pattern active within it. Adjacent tiers overlap in zoom; the renderer
// crossfades between them in the overlap band. `params` are this tier's values
// for its chosen pattern.
export interface LayoutTier {
    id: string;
    name: string;
    // Tier is active for cameraScale / fitScale in [zoomFromMul, zoomToMul].
    // Use 0 for "down to fully zoomed out" and Infinity for "up to fully in".
    zoomFromMul: number;
    zoomToMul: number;
    patternId: string;
    params: PatternParams;
    // Mirror this tier's (static) layout across the vertical / horizontal axis.
    // Applied by the tier engine to any static pattern (folder-grid, hub-spoke,
    // treemap, …); a no-op for the live force tier. Optional → false.
    flipX?: boolean; // mirror left ↔ right (negate x)
    flipY?: boolean; // mirror top ↔ bottom (negate y)
}

// Behavioral settings: expansion/isolate regime thresholds (multiples of
// fitScale, with absolute cameraScale ceilings for small projects) plus the
// higher-level toggles. `openLayoutBias` generalizes the old RIGID_OPEN_BLEND /
// RIGID_FLOOR (how far the layout leans toward the live/force tier while a file
// is open). isolate flags currently still live in useGraphStore; they move here
// in Phase 6.
export interface BehavioralConfig {
    selectionExpands: boolean;
    // In focus/detail mode (when isolate hides the files outside your focus):
    // true keeps every PINNED file on screen as well — "see all pinned items".
    // False lets pinned files hide along with the rest, so you see only the
    // active focus — "only what is active". Either way the pinned files are NOT
    // force-expanded and still obey the normal isolation dimming and filename
    // zoom-LOD rules — this only governs whether a pin survives isolate-hiding.
    showAllPinnedInDetail: boolean;
    // Keep the pin icon (badge) bright even when its file box is dimmed by
    // focus, so a pin stays a clear anchor on a faded file. When false, the pin
    // icon dims along with its box. (The box itself always dims normally.)
    highlightPins: boolean;
    isolateImports: boolean;
    isolateExports: boolean;
    openLayoutBias: number;
    expandAtMul: number;
    collapseBelowMul: number;
    isolateAtMul: number;
    isolateBelowMul: number;
    expandAbsCeiling: number;
    collapseAbsCeiling: number;
    isolateAbsCeiling: number;
    isolateBelowAbsCeiling: number;
}

// Level-of-detail thresholds — camera-zoom cutoffs at which the renderer drops
// or restores detail. All compared directly against cameraScale (world.scale.x),
// except the edge-length values which are screen-pixel lengths.
export interface LodConfig {
    cullPx: number;
    simplifyBelow: number;
    outlineBelow: number;
    callsBelow: number;
    intraDirBelow: number;
    edgeLengthDimPx: number;
    edgeLengthBrightPx: number;
    edgeLengthMinAlpha: number;
    // Zoom at which individual file names appear, as a MULTIPLE of fitScale (so
    // it stays sensible across project sizes): names show once
    // cameraScale ≥ fileNamesAtMul × fitScale. Selected / hovered files always
    // show their name regardless.
    fileNamesAtMul: number;
}

// Packed 0xRRGGBB colors mirroring the renderer's COLORS palette. The Phase 6
// theme UI surfaces only the file/edge/bg subset; the astOutline* entries are
// kept for completeness but stay out of the v1 theming UI.
export interface ThemeColors {
    bg: number;
    file: number;
    fileExpanded: number;
    fileSelected: number;
    fileBorder: number;
    fileBorderSelected: number;
    ast: number;
    astBorder: number;
    astSelected: number;
    astSelectedBorder: number;
    astOutlineBlock: number;
    astOutlineObject: number;
    astOutlineParam: number;
    astOutlineAbstract: number;
    astOutlineAbstractFn: number;
    astOutlineJsx: number;
    astOutlineControl: number;
    text: number;
    textDim: number;
    edge: number;
    edgeImporting: number;
    edgeImported: number;
    edgeBidirectional: number;
}

export interface SemanticEdgeStyle {
    color: number;
    width: number;
    alpha: number;
    arrowSize: number;
}

// How import connection lines are routed:
//   straight    — direct line
//   curved      — a gentle perpendicular-bowed arc
//   square      — orthogonal right-angle steps
//   semi-square — orthogonal steps with rounded corners
export type EdgeLineStyle = "straight" | "curved" | "square" | "semi-square";

export interface ThemeConfig {
    colors: ThemeColors;
    semanticEdge: Record<SemanticEdgeKind, SemanticEdgeStyle>;
    edgeStyle: EdgeLineStyle;
}

export interface GraphConfig {
    // Bumped on every edit. Doubles as the tierEngine's recompute stamp
    // (Phase 2) and the persistence migration version (Phase 5).
    version: number;
    tiers: LayoutTier[];
    behavioral: BehavioralConfig;
    lod: LodConfig;
    theme: ThemeConfig;
}

// Deep-partial used by setConfig patches.
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
