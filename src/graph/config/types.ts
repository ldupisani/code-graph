import type {SemanticEdgeKind} from "../../api/types";

// ---------------------------------------------------------------------------
// GraphConfig — the single source of truth for everything the user can tune.
//
// Historically every tunable lived as a scattered module- or closure-scoped
// `const` inside PixiCanvas.tsx / layout.ts. This object collects them so
// they can be edited live (via useConfigStore), persisted, and captured into
// snapshots. The renderer reads the *current* config each frame through
// a mutable ref (see PixiCanvas's configRef) — config edits never tear down
// the canvas.
//
// ---------------------------------------------------------------------------

// A pattern's tuned parameter values (keyed by ParamSpec.key). The schema
// that describes/validates these lives with each LayoutPattern (patterns/types).
export type PatternParams = Record<string, number | boolean | string>;

// One pattern's tuning. Held per pattern id (see LayoutConfig.byPattern) rather
// than per active layout, so switching away from a pattern and back preserves
// what you tuned instead of resetting it to defaults().
export interface LayoutSettings {
    params: PatternParams;
    // Mirror this (static) layout across the vertical / horizontal axis.
    // Applied by the layout engine to any static pattern (folder-grid,
    // hub-spoke, treemap, …); a no-op for the live force pattern.
    flipX: boolean; // mirror left ↔ right (negate x)
    flipY: boolean; // mirror top ↔ bottom (negate y)
}

// Which layout is arranging the files, and every pattern's saved tuning.
//
// This REPLACED the old zoom-tier list. Tiers bound the choice of pattern to
// the camera zoom — adjacent tiers overlapped in a zoom band and the renderer
// crossfaded between them as you zoomed — so the arrangement reorganised itself
// as a side-effect of zooming in, which you never asked for and couldn't hold
// still. The pattern is now an explicit choice; the crossfade survives, but it
// runs on a short time tween when you SWITCH layouts (see render/layoutEngine).
//
// Zoom still drives level of detail (behavioral.expandAtMul / isolateAtMul and
// the whole lod block) — that part was never the problem.
export interface LayoutConfig {
    patternId: string;
    // Keyed by pattern id. A missing entry means "never tuned" and falls back
    // to the pattern's defaults() — see layoutSettingsFor() in ./layout.
    byPattern: Record<string, LayoutSettings>;
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

// Packed 0xRRGGBB colors mirroring the renderer's COLORS palette. Every entry
// is surfaced in the Theme panel and read live — the astOutline* entries used
// to be neither, baked into astStyle's KIND_OUTLINE at module load.
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
    // Chrome accents that were literals in the renderer: the execution-flow
    // ribbon behind a file's statements, the pin badge, and the ring around the
    // file whose buffer is open in the editor.
    flowRibbon: number;
    pinBadge: number;
    editRing: number;
}

export interface SemanticEdgeStyle {
    color: number;
    width: number;
    alpha: number;
    arrowSize: number;
}

// Editor-style colours for AST label text. Defaults match Monaco's vs-dark /
// Dark+ family so the graph and the editor pane read as one product.
//
// These were module constants in render/astStyle, which is why a light
// background left every label in dark-theme pastels: the palette that decides
// how the code READS wasn't part of the theme at all.
export interface SyntaxColors {
    type: number;
    func: number;
    variable: number;
    control: number;
    keyword: number;
    string: number;
    number: number;
    // Assignment to an existing binding (`=`, `+=`) — deliberately apart from
    // string and number so a mutating `=` reads differently from a
    // declaration's neutral one.
    mutation: number;
    default: number;
}

// Each directory gets a signature hue hashed from its path; these fix the
// saturation/lightness the hue is rendered at. Three intensities of one family:
// the hull outline, the stronger file-icon body, and the dimmer file-name label.
export interface FolderColors {
    saturation: number;
    lightness: number;
    strongSaturation: number;
    strongLightness: number;
    dimSaturation: number;
    dimLightness: number;
}

// How AST cells are filled: the base tint, how much each nesting level
// lightens it, and the export / import washes blended on top.
export interface FillConfig {
    // Lightening applied per nesting depth, in 0-255 channel steps.
    depthStep: number;
    defaultAlpha: number;
    exportColor: number;
    exportBlend: number;
    exportAlpha: number;
    importTintColor: number;
    importTintBlend: number;
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
    syntax: SyntaxColors;
    folder: FolderColors;
    fill: FillConfig;
}

export interface GraphConfig {
    // Bumped on every edit. Doubles as the layout engine's recompute stamp
    // and the persistence migration version.
    version: number;
    layout: LayoutConfig;
    behavioral: BehavioralConfig;
    lod: LodConfig;
    theme: ThemeConfig;
}

// Deep-partial used by setConfig patches.
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
