import type React from "react";
import {useConfigStore} from "../../graph/config/store";
import type {SemanticEdgeKind} from "../../api/types";
import type {FillConfig, FolderColors, SyntaxColors, ThemeColors} from "../../graph/config/types";
import {ColorField, NumberField} from "./fields";

// Everything that paints a pixel, grouped by what it paints.
//
// The panel used to expose eleven colours — background, file boxes, import
// edges, text — which is roughly a third of the palette. The rest was module
// constants in render/theme and render/astStyle: the AST cell fill, the
// per-kind outlines, the syntax token colours, the folder hue intensities and
// the export/import washes. That split is why a light background only
// half-worked: the canvas followed the theme and the inside of every file
// didn't.
const CANVAS_FIELDS: {key: keyof ThemeColors; label: string}[] = [
    {key: "bg", label: "Background"},
    {key: "file", label: "File"},
    {key: "fileExpanded", label: "File (expanded)"},
    {key: "fileSelected", label: "File (selected)"},
    {key: "fileBorder", label: "File border"},
    {key: "fileBorderSelected", label: "File border (selected)"},
    {key: "text", label: "Text"},
    {key: "textDim", label: "Text (dim)"},
    {key: "flowRibbon", label: "Flow ribbon"},
    {key: "pinBadge", label: "Pin badge"},
    {key: "editRing", label: "Editing ring"},
];

// `ast` is the base the per-depth cell fill steps up from (see depthTint).
const AST_FIELDS: {key: keyof ThemeColors; label: string}[] = [
    {key: "ast", label: "Cell fill (base)"},
    {key: "astBorder", label: "Cell border"},
    {key: "astSelected", label: "Cell (selected)"},
    {key: "astSelectedBorder", label: "Cell border (selected)"},
];

const OUTLINE_FIELDS: {key: keyof ThemeColors; label: string}[] = [
    {key: "astOutlineBlock", label: "Block"},
    {key: "astOutlineObject", label: "Object / braces"},
    {key: "astOutlineParam", label: "Parameter"},
    {key: "astOutlineAbstract", label: "Abstract / interface"},
    {key: "astOutlineAbstractFn", label: "Abstract function"},
    {key: "astOutlineJsx", label: "JSX"},
    {key: "astOutlineControl", label: "Control flow"},
];

const EDGE_FIELDS: {key: keyof ThemeColors; label: string}[] = [
    {key: "edge", label: "Import edge"},
    {key: "edgeImporting", label: "Edge: importing"},
    {key: "edgeImported", label: "Edge: imported"},
    {key: "edgeBidirectional", label: "Edge: both"},
];

const SYNTAX_FIELDS: {key: keyof SyntaxColors; label: string}[] = [
    {key: "type", label: "Types"},
    {key: "func", label: "Functions"},
    {key: "variable", label: "Identifiers"},
    {key: "control", label: "Control flow"},
    {key: "keyword", label: "Keywords"},
    {key: "string", label: "Strings"},
    {key: "number", label: "Numbers"},
    {key: "mutation", label: "Mutation ="},
    {key: "default", label: "Punctuation"},
];

const FOLDER_FIELDS: {key: keyof FolderColors; label: string; help: string}[] = [
    {key: "saturation", label: "Hull saturation", help: "Directory boundary + label"},
    {key: "lightness", label: "Hull lightness", help: "Directory boundary + label"},
    {key: "strongSaturation", label: "Icon saturation", help: "File icon body — the folder's signature colour"},
    {key: "strongLightness", label: "Icon lightness", help: "File icon body — the folder's signature colour"},
    {key: "dimSaturation", label: "Filename saturation", help: "File name labels, a tier below the folder label"},
    {key: "dimLightness", label: "Filename lightness", help: "File name labels, a tier below the folder label"},
];

const EDGE_KINDS: SemanticEdgeKind[] = ["calls", "extends", "implements"];
const EDGE_STYLES = ["straight", "curved", "square", "semi-square"] as const;

export function ThemeControls() {
    const theme = useConfigStore((s) => s.config.theme);
    const setConfig = useConfigStore((s) => s.setConfig);
    const {colors, semanticEdge, edgeStyle, syntax, folder, fill} = theme;

    const setColor = (key: keyof ThemeColors, v: number) => setConfig({theme: {colors: {[key]: v}}});
    const setFill = (key: keyof FillConfig, v: number) => setConfig({theme: {fill: {[key]: v}}});

    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.45rem"}}>
            <Row title="How import connection lines are routed" label="Connection lines">
                <select value={edgeStyle} onChange={(e) => setConfig({theme: {edgeStyle: e.target.value as typeof edgeStyle}})} style={selectStyle}>
                    {EDGE_STYLES.map((s) => (
                        <option key={s} value={s}>
                            {s}
                        </option>
                    ))}
                </select>
            </Row>

            <Group label="Canvas" />
            {CANVAS_FIELDS.map((f) => (
                <ColorField key={f.key} label={f.label} value={colors[f.key]} onChange={(v) => setColor(f.key, v)} />
            ))}

            <Group label="AST cells" />
            {AST_FIELDS.map((f) => (
                <ColorField key={f.key} label={f.label} value={colors[f.key]} onChange={(v) => setColor(f.key, v)} />
            ))}
            <NumberField label="Depth step" value={fill.depthStep} min={0} max={24} step={1} onChange={(v) => setFill("depthStep", v)} help="How much each nesting level lightens the cell fill" />
            <NumberField label="Fill opacity" value={fill.defaultAlpha} min={0} max={1} step={0.02} onChange={(v) => setFill("defaultAlpha", v)} />

            <Group label="Kind outlines" />
            {OUTLINE_FIELDS.map((f) => (
                <ColorField key={f.key} label={f.label} value={colors[f.key]} onChange={(v) => setColor(f.key, v)} />
            ))}

            <Group label="Syntax" />
            {SYNTAX_FIELDS.map((f) => (
                <ColorField key={f.key} label={f.label} value={syntax[f.key]} onChange={(v) => setConfig({theme: {syntax: {[f.key]: v}}})} />
            ))}

            <Group label="Imports / exports" />
            <ColorField label="Export wash" value={fill.exportColor} onChange={(v) => setFill("exportColor", v)} />
            <NumberField label="Export blend" value={fill.exportBlend} min={0} max={1} step={0.05} onChange={(v) => setFill("exportBlend", v)} />
            <NumberField label="Export opacity" value={fill.exportAlpha} min={0} max={1} step={0.05} onChange={(v) => setFill("exportAlpha", v)} />
            <ColorField label="Import wash" value={fill.importTintColor} onChange={(v) => setFill("importTintColor", v)} />
            <NumberField label="Import blend" value={fill.importTintBlend} min={0} max={1} step={0.05} onChange={(v) => setFill("importTintBlend", v)} />

            <Group label="Folders" />
            {FOLDER_FIELDS.map((f) => (
                <NumberField key={f.key} label={f.label} value={folder[f.key]} min={0} max={100} step={1} onChange={(v) => setConfig({theme: {folder: {[f.key]: v}}})} help={f.help} />
            ))}

            <Group label="Edges" />
            {EDGE_FIELDS.map((f) => (
                <ColorField key={f.key} label={f.label} value={colors[f.key]} onChange={(v) => setColor(f.key, v)} />
            ))}
            {EDGE_KINDS.map((kind) => (
                <div key={kind} style={{display: "flex", flexDirection: "column", gap: "0.25rem"}}>
                    <ColorField
                        label={`Semantic: ${kind}`}
                        value={semanticEdge[kind].color}
                        onChange={(v) => setConfig({theme: {semanticEdge: {...semanticEdge, [kind]: {...semanticEdge[kind], color: v}}}})}
                    />
                    <NumberField
                        label={`${kind} width`}
                        value={semanticEdge[kind].width}
                        min={0.2}
                        max={8}
                        step={0.2}
                        onChange={(v) => setConfig({theme: {semanticEdge: {...semanticEdge, [kind]: {...semanticEdge[kind], width: v}}}})}
                    />
                    <NumberField
                        label={`${kind} opacity`}
                        value={semanticEdge[kind].alpha}
                        min={0}
                        max={1}
                        step={0.05}
                        onChange={(v) => setConfig({theme: {semanticEdge: {...semanticEdge, [kind]: {...semanticEdge[kind], alpha: v}}}})}
                    />
                    <NumberField
                        label={`${kind} arrow`}
                        value={semanticEdge[kind].arrowSize}
                        min={0}
                        max={24}
                        step={1}
                        onChange={(v) => setConfig({theme: {semanticEdge: {...semanticEdge, [kind]: {...semanticEdge[kind], arrowSize: v}}}})}
                    />
                </div>
            ))}
        </div>
    );
}

function Group({label}: {label: string}) {
    return (
        <div style={{borderTop: "1px solid rgba(120,120,130,0.2)", marginTop: "0.35rem", paddingTop: "0.35rem", fontSize: "0.68rem", color: "#80808a", letterSpacing: 0.3}}>{label}</div>
    );
}

function Row({label, title, children}: {label: string; title?: string; children: React.ReactNode}) {
    return (
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.72rem", color: "#b0b0b8"}} title={title}>
            <span>{label}</span>
            {children}
        </div>
    );
}

const selectStyle: React.CSSProperties = {
    background: "rgba(20,20,24,0.9)",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 4,
    color: "#dcdcaa",
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.15rem 0.35rem",
};
