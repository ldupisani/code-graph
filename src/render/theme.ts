import type {ThemeColors} from "../graph/config/types";
import type {SemanticEdgeKind} from "../api/types";

export const COLORS = {
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
    // Per-kind outlines: structural kinds get a colored border instead of a
    // text label, so they're identifiable without crowding the layout.
    astOutlineBlock: 0xe06cff, // magenta — Block
    astOutlineObject: 0xe8c84a, // yellow — ObjectLiteralExpression
    astOutlineParam: 0x6cb6ff, // light blue — Parameter
    astOutlineAbstract: 0x4ec9b0, // dashed — abstract/interface (editor type color)
    astOutlineAbstractFn: 0x808080, // dotted — abstract function (≈50% white)
    astOutlineJsx: 0xff9466, // salmon — JsxElement / JsxFragment (HTML-like)
    astOutlineControl: 0xc586c0, // pink — control-flow (if/for/while/switch/...)
    text: 0xeeeeee,
    textDim: 0xb0b0b8,
    edge: 0x565a63, // import links: subdued but always visible
    // Directional colours for import links that TOUCH a selected file.
    // Reads as: 'this file imports those' = yellow (outgoing from
    // selection), 'this file is imported by those' = blue (incoming
    // into selection). An edge whose BOTH endpoints are selected is
    // green — the relationship is meaningful in both directions and
    // shouldn't have to pick a side. Edges that don't touch any
    // selected file fall back to the plain `edge` grey.
    edgeImporting: 0xe8c84a, // yellow — outgoing import from a selected file
    edgeImported: 0x6cb6ff, // light blue — incoming import to a selected file
    edgeBidirectional: 0x6acf6a, // green — both endpoints selected
} as const;

export const SEMANTIC_EDGE_STYLE: Record<SemanticEdgeKind, {color: number; width: number; alpha: number; arrowSize: number}> = {
    // 0xdcdcaa == SYNTAX.func — same yellow as the call labels/triangle.
    calls: {color: 0xdcdcaa, width: 1.2, alpha: 0.85, arrowSize: 7},
    extends: {color: 0x9aa3ff, width: 1.8, alpha: 0.9, arrowSize: 9},
    implements: {color: 0x60d0c0, width: 1.4, alpha: 0.85, arrowSize: 8},
};

// Live theme: the renderer reads colors / semantic-edge styles through these
// module-level bindings, refreshed each frame from cfg.theme in the ticker. The
// `as const` palette above is the default + fallback. (KIND_OUTLINE /
// KIND_FILL_TINT below capture the defaults at module load — the AST-kind
// palette is intentionally not user-themed in v1.)
export const liveTheme: {colors: ThemeColors; semanticEdge: Record<SemanticEdgeKind, {color: number; width: number; alpha: number; arrowSize: number}>} = {
    colors: COLORS,
    semanticEdge: SEMANTIC_EDGE_STYLE,
};

// Exported nodes (anything carrying `exported = true`, plus the
// dedicated ExportDeclaration / ExportAssignment statements) get a
// SEMI-TRANSPARENT amber-tinted background. Three reasons:
//
//   * Amber matches the directional language: imports are blue
//     (something coming IN to this file), exports are amber
//     (something going OUT from this file).
//   * The tint signals "this rect is part of the module's public
//     surface" without an explicit text label.
//   * The reduced alpha (vs DEFAULT_FILL_ALPHA) lets the file's
//     circle boundary show THROUGH the part of the rect that sits
//     on the boundary — so the user can see the rect IS on the
//     boundary instead of the rect's opaque fill hiding that
//     geometry. Makes "exports sit on the boundary" visible at a
//     glance even when the cell straddles the edge.
export const EXPORT_FILL_COLOR = 0xc59a4a;
export const EXPORT_FILL_BLEND = 0.35;
export const EXPORT_FILL_ALPHA = 0.6;
export const DEFAULT_FILL_ALPHA = 0.92;

// Mix `base` with `tint` by `t` (0 = base, 1 = tint). Used to apply
// KIND_FILL_TINT entries on top of the depth-derived fill.
export function blendColor(base: number, tint: number, t: number): number {
    const br = (base >> 16) & 0xff;
    const bg = (base >> 8) & 0xff;
    const bb = base & 0xff;
    const tr = (tint >> 16) & 0xff;
    const tg = (tint >> 8) & 0xff;
    const tb = tint & 0xff;
    const r = Math.round(br * (1 - t) + tr * t);
    const g = Math.round(bg * (1 - t) + tg * t);
    const b = Math.round(bb * (1 - t) + tb * t);
    return (r << 16) | (g << 8) | b;
}

// HSL → packed 0xRRGGBB. Saturation / lightness are percentages 0-100;
// hue is 0-360. Used by the directory-boundary palette so each
// folder gets a stable colour derived from a hash of its path.
export function hslToHex(h: number, s: number, l: number): number {
    const sNorm = s / 100;
    const lNorm = l / 100;
    const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (hp < 1) {
        r1 = c;
        g1 = x;
    } else if (hp < 2) {
        r1 = x;
        g1 = c;
    } else if (hp < 3) {
        g1 = c;
        b1 = x;
    } else if (hp < 4) {
        g1 = x;
        b1 = c;
    } else if (hp < 5) {
        r1 = x;
        b1 = c;
    } else {
        r1 = c;
        b1 = x;
    }
    const m = lNorm - c / 2;
    const r = Math.round((r1 + m) * 255);
    const g = Math.round((g1 + m) * 255);
    const b = Math.round((b1 + m) * 255);
    return (r << 16) | (g << 8) | b;
}

export function depthTint(depth: number): number {
    // Slightly lighten with depth so nesting is visible without hard borders.
    const base = 0x222229;
    const stepped = Math.min(8, depth) * 5;
    const r = ((base >> 16) & 0xff) + stepped;
    const g = ((base >> 8) & 0xff) + stepped;
    const b = (base & 0xff) + stepped;
    return (r << 16) | (g << 8) | b;
}
