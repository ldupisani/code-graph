import {useConfigStore} from "../../graph/config/store";
import type {SemanticEdgeKind} from "../../api/types";
import type {ThemeColors} from "../../graph/config/types";
import {ColorField} from "./fields";

// Curated themeable colors. The AST-kind outline palette is intentionally left
// out of the v1 UI (it's captured at module load in the renderer).
const COLOR_FIELDS: {key: keyof ThemeColors; label: string}[] = [
    {key: "bg", label: "Background"},
    {key: "file", label: "File"},
    {key: "fileExpanded", label: "File (expanded)"},
    {key: "fileSelected", label: "File (selected)"},
    {key: "fileBorder", label: "File border"},
    {key: "edge", label: "Import edge"},
    {key: "edgeImporting", label: "Edge: importing"},
    {key: "edgeImported", label: "Edge: imported"},
    {key: "edgeBidirectional", label: "Edge: both"},
    {key: "text", label: "Text"},
    {key: "textDim", label: "Text (dim)"},
];

const EDGE_KINDS: SemanticEdgeKind[] = ["calls", "extends", "implements"];

const EDGE_STYLES = ["straight", "curved", "square", "semi-square"] as const;

export function ThemeControls() {
    const colors = useConfigStore((s) => s.config.theme.colors);
    const semanticEdge = useConfigStore((s) => s.config.theme.semanticEdge);
    const edgeStyle = useConfigStore((s) => s.config.theme.edgeStyle);
    const setConfig = useConfigStore((s) => s.setConfig);
    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.45rem"}}>
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.72rem", color: "#b0b0b8"}} title="How import connection lines are routed">
                <span>Connection lines</span>
                <select value={edgeStyle} onChange={(e) => setConfig({theme: {edgeStyle: e.target.value as typeof edgeStyle}})} style={{background: "rgba(20,20,24,0.9)", border: "1px solid rgba(120,120,130,0.4)", borderRadius: 4, color: "#dcdcaa", fontFamily: "inherit", fontSize: "0.72rem", padding: "0.15rem 0.35rem"}}>
                    {EDGE_STYLES.map((s) => (
                        <option key={s} value={s}>
                            {s}
                        </option>
                    ))}
                </select>
            </div>
            <div style={{borderTop: "1px solid rgba(120,120,130,0.2)", margin: "0.2rem 0"}} />
            {COLOR_FIELDS.map((f) => (
                <ColorField key={f.key} label={f.label} value={colors[f.key]} onChange={(v) => setConfig({theme: {colors: {[f.key]: v}}})} />
            ))}
            <div style={{borderTop: "1px solid rgba(120,120,130,0.2)", margin: "0.2rem 0"}} />
            {EDGE_KINDS.map((kind) => (
                <ColorField
                    key={kind}
                    label={`Semantic: ${kind}`}
                    value={semanticEdge[kind].color}
                    onChange={(v) => setConfig({theme: {semanticEdge: {...semanticEdge, [kind]: {...semanticEdge[kind], color: v}}}})}
                />
            ))}
        </div>
    );
}
