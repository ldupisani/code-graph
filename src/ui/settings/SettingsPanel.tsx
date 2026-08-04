import {useState} from "react";
import type React from "react";
import {BehavioralControls} from "./BehavioralControls";
import {LodControls} from "./LodControls";
import {ParamControls} from "./ParamControls";
import {ThemeControls} from "./ThemeControls";

// The settings panel body: a docked, scrollable list of config sections. All
// edits flow through useConfigStore and reach the renderer live via its config
// ref — no canvas rebuild.
//
// This used to own its own trigger, a gear pinned to the canvas's top-right
// corner, and "Layout parameters" appeared BOTH here and in the LayoutBar's own
// disclosure. Two buttons, two panels, one set of settings. Now the LayoutBar
// owns the single trigger (see ui/LayoutBar) and renders this body — so the ▾
// beside the layout pills is the only way in, and it lands you on the params
// for the pill you just pressed.
//
// There's no template manager either: saving/loading whole configs is what
// snapshots do now, since a snapshot carries the full GraphConfig alongside the
// camera and view it belongs to.
export function SettingsPanelBody({onClose}: {onClose: () => void}) {
    return (
        <div style={panelStyle}>
            <div style={headerStyle}>
                <span style={{fontWeight: 700, letterSpacing: 0.4}}>Layout settings</span>
                <button type="button" onClick={onClose} style={closeStyle} title="Close">
                    ✕
                </button>
            </div>
            <div style={bodyStyle}>
                <Section title="Layout parameters" defaultOpen>
                    <ParamControls />
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

// Anchored to App's TopHudRow (the LayoutBar renders this, and that row is the
// nearest positioned ancestor), so `right: 0` already sits 0.8rem in from the
// canvas edge and `top` only needs to clear the row itself.
//
// maxHeight is viewport-relative, NOT `calc(100% - …)`: a percentage resolves
// against TopHudRow, which is one pill tall, and collapsed this panel to a
// sliver. pointerEvents must be restored because that row sets `none` so its
// empty middle doesn't eat canvas drags.
const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: "2.4rem",
    right: 0,
    zIndex: 6,
    width: "20rem",
    maxHeight: "calc(100vh - 8rem)",
    overflowY: "auto",
    pointerEvents: "auto",
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
