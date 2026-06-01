import {useConfigStore} from "../../graph/config/store";
import type {LodConfig} from "../../graph/config/types";
import {NumberField} from "./fields";

// Level-of-detail thresholds. Camera-zoom cutoffs at which detail drops/returns,
// plus the edge-length alpha ramp (screen px).
const FIELDS: {key: keyof LodConfig; label: string; min: number; max: number; step: number; help: string}[] = [
    {key: "cullPx", label: "Cull below (px)", min: 0, max: 30, step: 1, help: "Rects smaller than this (screen px) aren't drawn"},
    {key: "simplifyBelow", label: "Simplify below", min: 0, max: 5, step: 0.1, help: "Below this zoom, generic kind labels drop"},
    {key: "outlineBelow", label: "Kind outlines below", min: 0, max: 3, step: 0.05, help: "Kind outlines return at this zoom"},
    {key: "callsBelow", label: "Call links below", min: 0, max: 3, step: 0.05, help: "Call links return at this zoom"},
    {key: "intraDirBelow", label: "Intra-dir edges below", min: 0, max: 3, step: 0.05, help: "Below this zoom, same-folder edges hide"},
    {key: "fileNamesAtMul", label: "File names at (×fit)", min: 0, max: 8, step: 0.1, help: "File names appear once zoom ≥ this × the fit zoom (selected/hovered always show)"},
    {key: "edgeLengthDimPx", label: "Edge dim length", min: 0, max: 300, step: 5, help: "Edges shorter than this (px) dim toward min alpha"},
    {key: "edgeLengthBrightPx", label: "Edge bright length", min: 0, max: 600, step: 10, help: "Edges longer than this (px) stay full alpha"},
    {key: "edgeLengthMinAlpha", label: "Edge min alpha", min: 0, max: 1, step: 0.02, help: "Floor alpha for the shortest edges"},
];

export function LodControls() {
    const lod = useConfigStore((s) => s.config.lod);
    const setConfig = useConfigStore((s) => s.setConfig);
    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.45rem"}}>
            {FIELDS.map((f) => (
                <NumberField key={f.key} label={f.label} value={lod[f.key]} min={f.min} max={f.max} step={f.step} help={f.help} onChange={(v) => setConfig({lod: {[f.key]: v}})} />
            ))}
        </div>
    );
}
