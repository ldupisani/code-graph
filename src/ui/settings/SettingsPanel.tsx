import {useState} from "react";
import type React from "react";
import {BehavioralControls} from "./BehavioralControls";
import {LodControls} from "./LodControls";
import {TemplateManager} from "./TemplateManager";
import {ThemeControls} from "./ThemeControls";
import {TierListEditor} from "./TierListEditor";

// Settings overlay: a gear button (top-right of the canvas) that toggles a
// docked, scrollable panel. Section-based so later phases slot in (templates,
// behavioral, LOD, theme). All config edits flow through useConfigStore and
// reach the renderer live via its config ref — no canvas rebuild.
export function SettingsPanel() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-pressed={open}
                title="Layout settings"
                style={gearStyle(open)}
            >
                ⚙
            </button>
            {open ? (
                <div style={panelStyle}>
                    <div style={headerStyle}>
                        <span style={{fontWeight: 700, letterSpacing: 0.4}}>Layout settings</span>
                        <button type="button" onClick={() => setOpen(false)} style={closeStyle} title="Close">
                            ✕
                        </button>
                    </div>
                    <div style={bodyStyle}>
                        <Section title="Templates" defaultOpen>
                            <TemplateManager />
                        </Section>
                        <Section title="Zoom tiers" defaultOpen>
                            <TierListEditor />
                        </Section>
                        <Section title="Behavior">
                            <BehavioralControls />
                        </Section>
                        <Section title="Detail thresholds (LOD)">
                            <LodControls />
                        </Section>
                        <Section title="Theme">
                            <ThemeControls />
                        </Section>
                    </div>
                </div>
            ) : null}
        </>
    );
}

export function Section({title, defaultOpen, children}: {title: string; defaultOpen?: boolean; children: React.ReactNode}) {
    const [open, setOpen] = useState(!!defaultOpen);
    return (
        <div style={{borderTop: "1px solid rgba(120,120,130,0.2)", paddingTop: "0.5rem"}}>
            <button type="button" onClick={() => setOpen((v) => !v)} style={sectionHeaderStyle}>
                <span style={{opacity: 0.7, width: "0.9rem", display: "inline-block"}}>{open ? "▾" : "▸"}</span>
                {title}
            </button>
            {open ? <div style={{paddingTop: "0.5rem"}}>{children}</div> : null}
        </div>
    );
}

function gearStyle(open: boolean): React.CSSProperties {
    return {
        position: "absolute",
        top: "0.6rem",
        right: "0.8rem",
        zIndex: 6,
        width: "2rem",
        height: "2rem",
        borderRadius: 999,
        border: 0,
        padding: 0,
        // Flex-centre the glyph: a fixed-size button won't centre a single
        // character on its own.
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        boxShadow: "inset 0 0 0 1px rgba(120,120,130,0.4)",
        background: open ? "#3a6fb0" : "rgba(40,40,46,0.85)",
        color: open ? "#fff" : "#cfcfd6",
        fontSize: "1rem",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
    };
}

const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: "3rem",
    right: "0.8rem",
    zIndex: 6,
    width: "20rem",
    maxHeight: "calc(100% - 4rem)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    borderRadius: 8,
    background: "rgba(24,24,28,0.94)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(120,120,130,0.3)",
    backdropFilter: "blur(10px)",
    fontFamily: "ui-monospace, monospace",
    color: "#e6e6e6",
};

const headerStyle: React.CSSProperties = {
    position: "sticky",
    top: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.6rem 0.75rem",
    background: "rgba(24,24,28,0.98)",
    borderBottom: "1px solid rgba(120,120,130,0.25)",
    fontSize: "0.8rem",
};

const bodyStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.6rem 0.75rem 0.9rem",
};

const closeStyle: React.CSSProperties = {
    appearance: "none",
    border: 0,
    background: "transparent",
    color: "#9aa0a6",
    cursor: "pointer",
    fontSize: "0.85rem",
};

const sectionHeaderStyle: React.CSSProperties = {
    appearance: "none",
    border: 0,
    background: "transparent",
    color: "#e6e6e6",
    fontFamily: "inherit",
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
    width: "100%",
    textAlign: "left",
};
