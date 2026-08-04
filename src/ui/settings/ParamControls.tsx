import type React from "react";
import {layoutSettingsFor} from "../../graph/config/layout";
import {useConfigStore} from "../../graph/config/store";
import {getPattern} from "../../graph/patterns/registry";
import type {ParamSpec} from "../../graph/patterns/types";
import {Pill} from "../Pill";

const LABEL_COLOR = "#b0b0b8";
const VALUE_COLOR = "#dcdcaa";

// Everything tunable about the ACTIVE layout: the flip toggles, then one input
// per ParamSpec (number → slider+value, boolean → pill, enum → select), wired to
// setLayoutFlip / setLayoutParam. Works for any pattern; the schema (with
// min/max/step/options) fully describes the params UI.
//
// Takes no props deliberately — it reads the active pattern straight from the
// config store. Flip lives here rather than in the LayoutBar because it's a
// per-pattern layout setting exactly like a param is; splitting them meant the
// bar and the panel each showed half the story.
export function ParamControls() {
    const layout = useConfigStore((s) => s.config.layout);
    const setLayoutParam = useConfigStore((s) => s.setLayoutParam);
    const setLayoutFlip = useConfigStore((s) => s.setLayoutFlip);
    const pattern = getPattern(layout.patternId);
    const specs = pattern.params;
    const settings = layoutSettingsFor(layout);
    // Flip mirrors a computed position map; the live force layout has none to
    // mirror, so the toggles would be dead controls there.
    const flippable = pattern.kind === "static";
    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.45rem", paddingTop: "0.2rem"}}>
            {flippable ? (
                <div style={{...rowStyle, justifyContent: "flex-start", gap: "0.4rem"}}>
                    <span style={{color: LABEL_COLOR}}>flip</span>
                    <Pill label="↔ X" on={settings.flipX} color={FLIP_COLOR} onToggle={() => setLayoutFlip({flipX: !settings.flipX})} />
                    <Pill label="↕ Y" on={settings.flipY} color={FLIP_COLOR} onToggle={() => setLayoutFlip({flipY: !settings.flipY})} />
                </div>
            ) : null}
            {specs.length === 0 ? (
                <div style={{color: LABEL_COLOR, opacity: 0.6, fontSize: "0.7rem", padding: "0.2rem 0"}}>No parameters.</div>
            ) : (
                specs.map((spec) => (
                    <Control key={spec.key} spec={spec} value={settings.params[spec.key]} onChange={(v) => setLayoutParam(spec.key, v)} />
                ))
            )}
        </div>
    );
}

const FLIP_COLOR = {bg: "#9aa3ff", text: "#0e1230"};

function Control({spec, value, onChange}: {spec: ParamSpec; value: number | boolean | string | undefined; onChange: (v: number | boolean | string) => void}) {
    const v = value ?? spec.default;
    if (spec.type === "boolean") {
        return (
            <div style={rowStyle} title={spec.help}>
                <span style={{color: LABEL_COLOR}}>{spec.label}</span>
                <Pill label={v ? "on" : "off"} on={!!v} color={{bg: "#4ec9b0", text: "#06201b"}} onToggle={() => onChange(!v)} />
            </div>
        );
    }
    if (spec.type === "enum") {
        return (
            <div style={rowStyle} title={spec.help}>
                <span style={{color: LABEL_COLOR}}>{spec.label}</span>
                <select value={String(v)} onChange={(e) => onChange(e.target.value)} style={selectStyle}>
                    {(spec.options ?? []).map((o) => (
                        <option key={o} value={o}>
                            {o}
                        </option>
                    ))}
                </select>
            </div>
        );
    }
    // number
    const n = typeof v === "number" ? v : Number(v);
    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.15rem"}} title={spec.help}>
            <div style={rowStyle}>
                <span style={{color: LABEL_COLOR}}>{spec.label}</span>
                <input
                    type="number"
                    value={Number.isFinite(n) ? n : ""}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    onChange={(e) => onChange(clampNum(e.target.value, spec))}
                    style={{...numStyle, width: "4.5rem"}}
                />
            </div>
            {spec.min != null && spec.max != null ? (
                <input
                    type="range"
                    value={Number.isFinite(n) ? n : spec.min}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step ?? (spec.max - spec.min) / 100}
                    onChange={(e) => onChange(clampNum(e.target.value, spec))}
                    style={{width: "100%", accentColor: VALUE_COLOR}}
                />
            ) : null}
        </div>
    );
}

function clampNum(raw: string, spec: ParamSpec): number {
    let n = Number(raw);
    if (!Number.isFinite(n)) n = typeof spec.default === "number" ? spec.default : 0;
    if (spec.min != null && n < spec.min) n = spec.min;
    if (spec.max != null && n > spec.max) n = spec.max;
    return n;
}

const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.6rem",
    fontSize: "0.72rem",
};

const numStyle: React.CSSProperties = {
    appearance: "textfield",
    background: "rgba(20,20,24,0.9)",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 4,
    color: VALUE_COLOR,
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.15rem 0.35rem",
};

const selectStyle: React.CSSProperties = {
    background: "rgba(20,20,24,0.9)",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 4,
    color: VALUE_COLOR,
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.15rem 0.35rem",
};
