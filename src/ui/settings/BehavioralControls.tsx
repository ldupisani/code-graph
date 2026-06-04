import {useConfigStore} from "../../graph/config/store";
import {NumberField, ToggleField} from "./fields";

// Behavioral settings: expansion master toggle, isolate-mode directions, the
// open-layout bias (how far the layout leans toward the live/force tier while a
// file is open), and the fit-relative expand/isolate thresholds.
const NUMS: {key: "openLayoutBias" | "expandAtMul" | "collapseBelowMul" | "isolateAtMul" | "isolateBelowMul"; label: string; min: number; max: number; step: number; help: string}[] = [
    {key: "openLayoutBias", label: "Open layout bias", min: 0, max: 1, step: 0.05, help: "While a file is open: 0 = fully force, 1 = keep the overview layout"},
    {key: "expandAtMul", label: "Expand at ×fit", min: 0.5, max: 6, step: 0.1, help: "Files auto-expand at this multiple of the fit zoom"},
    {key: "collapseBelowMul", label: "Collapse below ×fit", min: 0.3, max: 6, step: 0.1, help: "Expanded files collapse below this multiple (hysteresis)"},
    {key: "isolateAtMul", label: "Isolate at ×fit", min: 0.5, max: 6, step: 0.1, help: "Isolate mode engages at this multiple of the fit zoom"},
    {key: "isolateBelowMul", label: "Isolate off below ×fit", min: 0.3, max: 6, step: 0.1, help: "Isolate mode releases below this multiple (hysteresis)"},
];

export function BehavioralControls() {
    const b = useConfigStore((s) => s.config.behavioral);
    const setConfig = useConfigStore((s) => s.setConfig);
    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.45rem"}}>
            <ToggleField label="Selection expands files" value={b.selectionExpands} help="Auto-expand a selected file once zoomed in" onChange={(v) => setConfig({behavioral: {selectionExpands: v}})} />
            <ToggleField label="Detail view: keep pinned files visible" value={b.showAllPinnedInDetail} help="On: pinned files stay on screen in focus mode (dimmed, not expanded). Off: pins hide with everything else, so you see only the active focus." onChange={(v) => setConfig({behavioral: {showAllPinnedInDetail: v}})} />
            <ToggleField label="Highlight pin icons on dim files" value={b.highlightPins} help="Keep the pin icon bright when its file box is dimmed by focus (off = the icon dims with the box)" onChange={(v) => setConfig({behavioral: {highlightPins: v}})} />
            <ToggleField label="Isolate: imports (↓)" value={b.isolateImports} help="Isolate follows outgoing edges (what this depends on)" onChange={(v) => setConfig({behavioral: {isolateImports: v}})} />
            <ToggleField label="Isolate: exports (↑)" value={b.isolateExports} help="Isolate follows incoming edges (what depends on this)" onChange={(v) => setConfig({behavioral: {isolateExports: v}})} />
            {NUMS.map((f) => (
                <NumberField key={f.key} label={f.label} value={b[f.key]} min={f.min} max={f.max} step={f.step} help={f.help} onChange={(v) => setConfig({behavioral: {[f.key]: v}})} />
            ))}
        </div>
    );
}
