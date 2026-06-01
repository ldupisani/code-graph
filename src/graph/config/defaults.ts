import type {BehavioralConfig, GraphConfig, LayoutTier, LodConfig, ThemeConfig} from "./types";

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG — every value lifted VERBATIM from the constants that used to
// live in PixiCanvas.tsx, so the default config reproduces today's app exactly.
// Keep these in sync with any behavioral retuning; this file is now the home of
// record for the tunable values + the rationale behind them.
// ---------------------------------------------------------------------------

const DEFAULT_LOD: LodConfig = {
    // Rects whose smaller side is below this many screen px are not drawn.
    cullPx: 4,
    // Below this zoom the view simplifies: generic kind labels drop, names stay.
    simplifyBelow: 1.5,
    // Block/object kind outlines (cheap structural cues) return at this lower zoom.
    outlineBelow: 0.5,
    // Call links return early (their caller's file must be expanded to matter).
    callsBelow: 0.5,
    // Below this zoom, same-directory imports/calls/extends are hidden as plumbing.
    intraDirBelow: 0.6,
    // Edge-length alpha ramp (screen px): full alpha at brightPx, minAlpha at dimPx.
    edgeLengthDimPx: 50,
    edgeLengthBrightPx: 180,
    edgeLengthMinAlpha: 0.18,
    // File names appear at this multiple of the fit zoom (2 matches the isolate
    // regime that used to gate them, so behaviour is unchanged by default).
    fileNamesAtMul: 2,
};

const DEFAULT_BEHAVIORAL: BehavioralConfig = {
    // Master toggle for zoom-driven file expansion: when true, a selected file
    // auto-expands once zoom crosses the expand threshold.
    selectionExpands: true,
    // Keep the pin icon bright on dimmed files (a clear anchor); the file box
    // itself still dims normally.
    highlightPins: true,
    // Both default true = bidirectional isolate reach (original behaviour).
    isolateImports: true,
    isolateExports: true,
    // How far the layout leans toward the live/force tier while any file is open
    // (was RIGID_OPEN_BLEND === RIGID_FLOOR === 0.5).
    openLayoutBias: 0.5,
    // Expansion/isolate regime thresholds as multiples of fitScale, with the
    // hysteresis band between expand/collapse (and isolate-on/off). Isolate fires
    // BEFORE expansion (2 vs 3) so the cluster fades before files grow.
    expandAtMul: 3,
    collapseBelowMul: 2.5,
    isolateAtMul: 2,
    isolateBelowMul: 1.7,
    // Absolute cameraScale ceilings: for small projects fitScale saturates at 2,
    // making the ratio thresholds unreachable — these floors fire once file icons
    // have clearly saturated (past cameraScale ≈ 1). Effective threshold is
    // min(ratio × fitScale, ceiling).
    expandAbsCeiling: 0.8,
    collapseAbsCeiling: 0.65,
    isolateAbsCeiling: 0.55,
    isolateBelowAbsCeiling: 0.45,
};

const DEFAULT_THEME: ThemeConfig = {
    colors: {
        bg: 0x161618,
        file: 0x2a2a2e,
        fileExpanded: 0x1f1f24,
        fileSelected: 0x3a6fb0,
        fileBorder: 0x44444a,
        fileBorderSelected: 0xffffff,
        ast: 0x222229,
        astBorder: 0x33333a,
        astSelected: 0x3a6fb0,
        astSelectedBorder: 0xffffff,
        astOutlineBlock: 0xe06cff,
        astOutlineObject: 0xe8c84a,
        astOutlineParam: 0x6cb6ff,
        astOutlineAbstract: 0x4ec9b0,
        astOutlineAbstractFn: 0x808080,
        astOutlineJsx: 0xff9466,
        astOutlineControl: 0xc586c0,
        text: 0xeeeeee,
        textDim: 0xb0b0b8,
        edge: 0x565a63,
        edgeImporting: 0xe8c84a,
        edgeImported: 0x6cb6ff,
        edgeBidirectional: 0x6acf6a,
    },
    semanticEdge: {
        calls: {color: 0xdcdcaa, width: 1.2, alpha: 0.85, arrowSize: 7},
        extends: {color: 0x9aa3ff, width: 1.8, alpha: 0.9, arrowSize: 9},
        implements: {color: 0x60d0c0, width: 1.4, alpha: 0.85, arrowSize: 8},
    },
    // Import connection line routing (straight = original).
    edgeStyle: "straight",
};

// Default 2-tier layout — reproduces today's folder-grid ↔ force-connectivity
// crossfade. Tier ranges mirror the old rigidness() band: folder-grid is the
// base layer (active from fully zoomed out), the force tier overlaps it across
// [1.5×, 4.5×] fitScale (RIGID_FULL_MUL .. RIGID_NONE_MUL), where the renderer
// crossfades. Pattern ids are registered in Phase 2; params default to {} and
// are filled from each pattern's defaults() then.
const DEFAULT_TIERS: LayoutTier[] = [
    {
        id: "tier-overview",
        name: "Overview",
        zoomFromMul: 0,
        zoomToMul: 4.5,
        patternId: "folder-grid",
        params: {},
    },
    {
        id: "tier-detail",
        name: "Detail",
        zoomFromMul: 1.5,
        zoomToMul: Infinity,
        patternId: "force-connectivity",
        params: {},
    },
];

export const CONFIG_VERSION = 1;

export function makeDefaultConfig(): GraphConfig {
    // Deep-cloned so callers can freely mutate without touching the template.
    return {
        version: CONFIG_VERSION,
        tiers: DEFAULT_TIERS.map((t) => ({...t, params: {...t.params}})),
        behavioral: {...DEFAULT_BEHAVIORAL},
        lod: {...DEFAULT_LOD},
        theme: {
            ...DEFAULT_THEME,
            colors: {...DEFAULT_THEME.colors},
            semanticEdge: {
                calls: {...DEFAULT_THEME.semanticEdge.calls},
                extends: {...DEFAULT_THEME.semanticEdge.extends},
                implements: {...DEFAULT_THEME.semanticEdge.implements},
            },
        },
    };
}
