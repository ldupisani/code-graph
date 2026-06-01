import type React from "react";
import {Pill} from "../Pill";

// Small shared form fields for the settings sub-panels (LOD / behavioral /
// theme). Each is a labelled row wired to a value + onChange.

const LABEL_COLOR = "#b0b0b8";
const VALUE_COLOR = "#dcdcaa";

export function NumberField({label, value, min, max, step, onChange, help}: {label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; help?: string}) {
    const clamp = (raw: string): number => {
        let n = Number(raw);
        if (!Number.isFinite(n)) n = value;
        if (min != null && n < min) n = min;
        if (max != null && n > max) n = max;
        return n;
    };
    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.15rem"}} title={help}>
            <div style={rowStyle}>
                <span style={{color: LABEL_COLOR}}>{label}</span>
                <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(clamp(e.target.value))} style={numStyle} />
            </div>
            {min != null && max != null ? (
                <input type="range" value={value} min={min} max={max} step={step ?? (max - min) / 100} onChange={(e) => onChange(clamp(e.target.value))} style={{width: "100%", accentColor: VALUE_COLOR}} />
            ) : null}
        </div>
    );
}

export function ToggleField({label, value, onChange, help}: {label: string; value: boolean; onChange: (v: boolean) => void; help?: string}) {
    return (
        <div style={rowStyle} title={help}>
            <span style={{color: LABEL_COLOR}}>{label}</span>
            <Pill label={value ? "on" : "off"} on={value} color={{bg: "#4ec9b0", text: "#06201b"}} onToggle={() => onChange(!value)} />
        </div>
    );
}

export function ColorField({label, value, onChange}: {label: string; value: number; onChange: (v: number) => void}) {
    return (
        <div style={rowStyle}>
            <span style={{color: LABEL_COLOR}}>{label}</span>
            <input type="color" value={numToHex(value)} onChange={(e) => onChange(hexToNum(e.target.value))} style={{width: "2.2rem", height: "1.3rem", padding: 0, border: "1px solid rgba(120,120,130,0.4)", borderRadius: 4, background: "transparent", cursor: "pointer"}} />
        </div>
    );
}

// 0xRRGGBB <-> "#rrggbb" for <input type=color>.
export function numToHex(n: number): string {
    return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}
export function hexToNum(hex: string): number {
    return parseInt(hex.replace(/^#/, ""), 16) || 0;
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
    width: "4.5rem",
    background: "rgba(20,20,24,0.9)",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 4,
    color: VALUE_COLOR,
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.15rem 0.35rem",
};
