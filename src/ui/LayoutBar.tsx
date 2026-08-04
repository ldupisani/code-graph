import type React from "react";
import {useState} from "react";
import {useConfigStore} from "../graph/config/store";
import {listPatterns} from "../graph/patterns/registry";
import {useGraphStore} from "../graph/store";
import {SettingsPanelBody} from "./settings/SettingsPanel";
import {Pill} from "./Pill";

// HUD overlay, top-right of the canvas: pick which layout arranges the files,
// and open the settings panel to tune it.
//
// This is the control that replaced the zoom-tier system. Layout used to be a
// function of camera zoom — the arrangement reorganised itself as you zoomed in,
// which you never asked for and couldn't hold still. Now it's one explicit
// choice, one click away, and it stays put until you change it. Switching
// crossfades (see render/layoutEngine) so you can follow where a file went.
//
// The ▾ is the ONLY way into layout configuration. It sits where the settings
// gear used to, and opens the same panel the gear opened — the difference is
// that there is now a single button instead of a gear and a separate in-bar
// disclosure showing an overlapping subset of the same controls.
//
// Short labels, not the patterns' full names ("Folder hierarchy grid"): this bar
// sits over the canvas and four long names would crowd out the graph.
const SHORT_LABEL: Record<string, string> = {
    "folder-grid": "folders",
    "hub-spoke": "hub",
    treemap: "treemap",
    "force-connectivity": "force",
};

const ACTIVE_COLOR = {bg: "#4ec9b0", text: "#06201b"};

export function LayoutBar() {
    const project = useGraphStore((s) => s.project);
    const patternId = useConfigStore((s) => s.config.layout.patternId);
    const setLayoutPattern = useConfigStore((s) => s.setLayoutPattern);
    const [open, setOpen] = useState(false);

    // Nothing to arrange until a project is open.
    if (!project) return null;

    return (
        <>
            <div style={rowStyle}>
                <span style={{color: "#80808a"}}>layout</span>
                {listPatterns().map((p) => (
                    <Pill
                        key={p.id}
                        label={SHORT_LABEL[p.id] ?? p.name}
                        on={p.id === patternId}
                        color={ACTIVE_COLOR}
                        onToggle={() => setLayoutPattern(p.id)}
                    />
                ))}
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    title={open ? "Hide layout settings" : "Show layout settings"}
                    aria-expanded={open}
                    aria-label="Layout settings"
                    style={discloseStyle(open)}
                >
                    {open ? "▴" : "▾"}
                </button>
            </div>
            {open ? <SettingsPanelBody onClose={() => setOpen(false)} /> : null}
        </>
    );
}

// Positioned by App's top HUD row (TopHudRow), which pins this group to the
// right and the edge filters to the left. Not absolute on its own: two
// independently-positioned rows overlapped as soon as the canvas got narrow.
const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    // Stay hard right even after wrapping onto its own line — space-between on
    // the parent only right-aligns this group while both groups share a line.
    marginLeft: "auto",
    pointerEvents: "auto",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.75rem",
    userSelect: "none",
};

function discloseStyle(open: boolean): React.CSSProperties {
    return {
        appearance: "none",
        border: 0,
        borderRadius: 999,
        // Flex-centre the glyph: a fixed-size button won't centre a single
        // character on its own.
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        width: "1.5rem",
        height: "1.5rem",
        padding: 0,
        background: open ? "#3a6fb0" : "rgba(40, 40, 46, 0.85)",
        color: open ? "#fff" : "#b0b0b8",
        boxShadow: "inset 0 0 0 1px rgba(120, 120, 130, 0.35)",
        fontFamily: "inherit",
        fontSize: "0.7rem",
        cursor: "pointer",
        backdropFilter: "blur(6px)",
    };
}
