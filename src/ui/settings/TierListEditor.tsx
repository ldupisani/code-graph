import type React from "react";
import {useConfigStore} from "../../graph/config/store";
import type {LayoutTier} from "../../graph/config/types";
import {getPattern, listPatterns} from "../../graph/patterns/registry";
import {Pill} from "../Pill";
import {ParamControls} from "./ParamControls";

const LABEL_COLOR = "#b0b0b8";

// Editor for the ordered tier list. Tiers run coarse (top) → fine (bottom);
// each owns a zoom range (×fitScale), a pattern, and that pattern's params.
export function TierListEditor() {
    const tiers = useConfigStore((s) => s.config.tiers);
    const addTier = useConfigStore((s) => s.addTier);

    return (
        <div style={{display: "flex", flexDirection: "column", gap: "0.5rem"}}>
            <div style={{color: LABEL_COLOR, fontSize: "0.68rem", opacity: 0.7}}>
                Coarse (zoomed out) → fine (zoomed in). Zoom ranges are multiples of the auto-fit zoom; adjacent ranges overlap to crossfade.
            </div>
            {tiers.map((tier, i) => (
                <TierCard key={tier.id} tier={tier} index={i} count={tiers.length} />
            ))}
            <button type="button" onClick={addTier} style={addBtnStyle}>
                + Add tier
            </button>
        </div>
    );
}

function TierCard({tier, index, count}: {tier: LayoutTier; index: number; count: number}) {
    const updateTier = useConfigStore((s) => s.updateTier);
    const removeTier = useConfigStore((s) => s.removeTier);
    const moveTier = useConfigStore((s) => s.moveTier);
    const setTierPattern = useConfigStore((s) => s.setTierPattern);
    const patterns = listPatterns();

    return (
        <div style={cardStyle}>
            <div style={{display: "flex", alignItems: "center", gap: "0.4rem"}}>
                <input
                    value={tier.name}
                    onChange={(e) => updateTier(tier.id, {name: e.target.value})}
                    style={{...inputStyle, flex: 1, fontWeight: 600}}
                />
                <IconBtn label="▲" disabled={index === 0} onClick={() => moveTier(tier.id, -1)} />
                <IconBtn label="▼" disabled={index === count - 1} onClick={() => moveTier(tier.id, 1)} />
                <IconBtn label="✕" disabled={count <= 1} onClick={() => removeTier(tier.id)} />
            </div>

            <div style={{display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.7rem", color: LABEL_COLOR}}>
                <span>zoom ×</span>
                <input
                    type="number"
                    value={tier.zoomFromMul}
                    min={0}
                    step={0.1}
                    onChange={(e) => updateTier(tier.id, {zoomFromMul: Math.max(0, Number(e.target.value) || 0)})}
                    style={{...inputStyle, width: "3.4rem"}}
                    title="Active from this multiple of the auto-fit zoom"
                />
                <span>→</span>
                <input
                    type="number"
                    value={Number.isFinite(tier.zoomToMul) ? tier.zoomToMul : ""}
                    min={0}
                    step={0.1}
                    placeholder="∞"
                    onChange={(e) => updateTier(tier.id, {zoomToMul: e.target.value === "" ? Infinity : Number(e.target.value) || 0})}
                    style={{...inputStyle, width: "3.4rem"}}
                    title="Active up to this multiple of the auto-fit zoom (blank = ∞)"
                />
            </div>

            <select value={tier.patternId} onChange={(e) => setTierPattern(tier.id, e.target.value)} style={{...inputStyle, width: "100%"}}>
                {patterns.map((p) => (
                    <option key={p.id} value={p.id}>
                        {p.name}
                        {p.kind === "live" ? " (live)" : ""}
                    </option>
                ))}
            </select>

            {/* Flip is meaningful for static layouts; the live force tier ignores it. */}
            {getPattern(tier.patternId).kind === "static" ? (
                <div style={{display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.7rem", color: LABEL_COLOR}}>
                    <span>flip</span>
                    <Pill label="↔ X" on={!!tier.flipX} color={{bg: "#9aa3ff", text: "#0e1230"}} onToggle={() => updateTier(tier.id, {flipX: !tier.flipX})} />
                    <Pill label="↕ Y" on={!!tier.flipY} color={{bg: "#9aa3ff", text: "#0e1230"}} onToggle={() => updateTier(tier.id, {flipY: !tier.flipY})} />
                </div>
            ) : null}

            <ParamControls tierId={tier.id} patternId={tier.patternId} params={tier.params} />
        </div>
    );
}

function IconBtn({label, onClick, disabled}: {label: string; onClick: () => void; disabled?: boolean}) {
    return (
        <button type="button" onClick={onClick} disabled={disabled} style={{...iconBtnStyle, opacity: disabled ? 0.3 : 0.85, cursor: disabled ? "default" : "pointer"}}>
            {label}
        </button>
    );
}

const cardStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "0.45rem",
    padding: "0.5rem",
    borderRadius: 6,
    background: "rgba(28,28,33,0.7)",
    boxShadow: "inset 0 0 0 1px rgba(120,120,130,0.25)",
};

const inputStyle: React.CSSProperties = {
    appearance: "none",
    background: "rgba(20,20,24,0.9)",
    border: "1px solid rgba(120,120,130,0.4)",
    borderRadius: 4,
    color: "#e6e6e6",
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.2rem 0.4rem",
};

const iconBtnStyle: React.CSSProperties = {
    appearance: "none",
    border: "1px solid rgba(120,120,130,0.35)",
    borderRadius: 4,
    background: "rgba(40,40,46,0.85)",
    color: "#cfcfd6",
    fontFamily: "inherit",
    fontSize: "0.7rem",
    width: "1.5rem",
    height: "1.5rem",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
};

const addBtnStyle: React.CSSProperties = {
    appearance: "none",
    border: "1px dashed rgba(120,120,130,0.5)",
    borderRadius: 6,
    background: "transparent",
    color: "#9aa3ff",
    fontFamily: "inherit",
    fontSize: "0.72rem",
    padding: "0.35rem",
    cursor: "pointer",
};
