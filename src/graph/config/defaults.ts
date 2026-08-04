import type {BehavioralConfig, GraphConfig, LayoutConfig, LodConfig, ThemeConfig} from "./types";

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
    // On by default: pinned files stay on screen through focus mode (the
    // original behaviour — a pin is a "keep this visible" anchor). Turn off to
    // let pins hide with everything else and see only the active focus.
    showAllPinnedInDetail: true,
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
        flowRibbon: 0x8fa3c0,
        pinBadge: 0xe8c84a,
        // Same blue as EditorPane's "you are editing" bar, so the two
        // affordances read as one state.
        editRing: 0x4a9eff,
    },
    semanticEdge: {
        calls: {color: 0xdcdcaa, width: 1.2, alpha: 0.85, arrowSize: 7},
        extends: {color: 0x9aa3ff, width: 1.8, alpha: 0.9, arrowSize: 9},
        implements: {color: 0x60d0c0, width: 1.4, alpha: 0.85, arrowSize: 8},
    },
    // Import connection line routing (straight = original).
    edgeStyle: "straight",
    // Monaco vs-dark / Dark+ family, matching EditorPane's theme: types teal,
    // functions yellow, control-flow pink, other keywords blue, strings salmon,
    // numbers green, identifiers light blue.
    syntax: {
        type: 0x4ec9b0,
        func: 0xdcdcaa,
        variable: 0x9cdcfe,
        control: 0xc586c0,
        keyword: 0x569cd6,
        string: 0xce9178,
        number: 0xb5cea8,
        mutation: 0xffa657,
        default: 0xd4d4d4,
    },
    // Hue comes from a hash of the directory path; these set the intensity.
    // Strong = the file-icon body (unambiguously the folder's colour); dim =
    // file-name labels, a tier below their containing folder's label.
    folder: {
        saturation: 38,
        lightness: 52,
        strongSaturation: 65,
        strongLightness: 58,
        dimSaturation: 38,
        dimLightness: 42,
    },
    fill: {
        depthStep: 5,
        defaultAlpha: 0.92,
        // Amber for exports, matching the directional language: imports come
        // IN (blue), exports go OUT (amber). The lower alpha lets the file's
        // boundary show through a cell that straddles it.
        exportColor: 0xc59a4a,
        exportBlend: 0.35,
        exportAlpha: 0.6,
        importTintColor: 0x4a6ac5,
        importTintBlend: 0.35,
    },
};

// Default layout: the folder grid. It's the arrangement that maps most directly
// onto how you already think about the project, so it's the right thing to land
// on at open; the other three are one click away in the LayoutBar.
//
// `byPattern` starts EMPTY rather than pre-seeded — defaults.ts deliberately
// doesn't import the pattern registry (see config/layout.ts), so per-pattern
// params are filled from each pattern's defaults() on first read.
const DEFAULT_LAYOUT: LayoutConfig = {
    patternId: "folder-grid",
    byPattern: {},
};

// 2: `tiers` (a zoom-banded list of patterns, crossfaded by camera zoom)
// collapsed to `layout` (one explicitly-chosen pattern + per-pattern tuning).
// sanitizeConfig migrates an old persisted blob forward.
// 3: theme gained `syntax`, `folder` and `fill` — the palettes that decide how
// the INSIDE of a file paints. sanitizeConfig fills them from defaults, so a v2
// blob needs no migration beyond that.
export const CONFIG_VERSION = 3;

export function makeDefaultConfig(): GraphConfig {
    // Deep-cloned so callers can freely mutate without touching the template.
    return {
        version: CONFIG_VERSION,
        layout: {patternId: DEFAULT_LAYOUT.patternId, byPattern: {}},
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
