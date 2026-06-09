import type React from "react";
import {useState} from "react";
import {applySnapshot, captureSnapshot, overwriteSnapshot} from "../graph/snapshots/capture";
import {useSnapshotStore} from "../graph/snapshots/store";
import type {CameraApi} from "../render/PixiCanvas";

// Module-level stable empty fallback so an empty project doesn't allocate a new
// array each render (which would defeat the selector's referential stability).
const EMPTY: never[] = [];

// Pill bar of saved views (snapshots) for the open project. Click a chip — or
// press its number (1–9) — to jump to that view; the `+` chip (or `S`) saves
// the current view. Hover a chip for a delete `×`; double-click to rename.
// Mirrors PinControls' translucent rounded-pill styling.
export function SnapshotBar({api, rootPath}: {api: {current: CameraApi | null}; rootPath: string}) {
    // Select the raw (possibly undefined) array — a STABLE reference — and
    // default to [] outside the selector. Returning `?? []` from the selector
    // itself would hand back a fresh array every call, which Zustand's Object.is
    // equality reads as a change → infinite re-render loop.
    const list = useSnapshotStore((s) => s.byProject[rootPath]);
    const snapshots = list ?? EMPTY;
    const activeId = useSnapshotStore((s) => s.activeByProject[rootPath] ?? null);
    const remove = useSnapshotStore((s) => s.remove);
    const rename = useSnapshotStore((s) => s.rename);

    // Which chip shows its delete affordance (hover), and which is mid-rename.
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    function startRename(id: string, name: string) {
        setRenamingId(id);
        setDraft(name);
    }
    function commitRename() {
        if (renamingId) rename(rootPath, renamingId, draft);
        setRenamingId(null);
    }

    return (
        <div style={wrapStyle}>
            {/* Thin divider separating the pin buttons (to our left) from saved views. */}
            <span style={dividerStyle} aria-hidden>
                │
            </span>
            {snapshots.map((snap, i) => {
                // Positional default so the label always matches the badge /
                // hotkey, even after earlier views are deleted. A custom name
                // (from rename) overrides it.
                const label = snap.name || `View ${i + 1}`;
                const isActive = snap.id === activeId;
                const isRenaming = renamingId === snap.id;
                if (isRenaming) {
                    return (
                        <input
                            key={snap.id}
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename();
                                else if (e.key === "Escape") setRenamingId(null);
                                e.stopPropagation();
                            }}
                            style={inputStyle}
                        />
                    );
                }
                return (
                    <div
                        key={snap.id}
                        style={chipWrapStyle}
                        onMouseEnter={() => setHoveredId(snap.id)}
                        onMouseLeave={() => setHoveredId((h) => (h === snap.id ? null : h))}
                    >
                        <button
                            type="button"
                            style={isActive ? activeChipStyle : chipStyle}
                            title={`Jump to "${label}"${i < 9 ? ` (press ${i + 1})` : ""} — double-click to rename`}
                            onClick={() => applySnapshot(snap, api.current)}
                            onDoubleClick={() => startRename(snap.id, snap.name ?? "")}
                        >
                            {/* Number hint only for the first 9 — those are the keyboard-addressable ones. */}
                            {i < 9 ? <span style={badgeStyle}>{i + 1}</span> : null}
                            <span>{label}</span>
                        </button>
                        {hoveredId === snap.id ? (
                            <>
                                <button
                                    type="button"
                                    style={overwriteStyle}
                                    title={`Overwrite "${label}" with the current view${isActive ? " (⇧S)" : ""}`}
                                    onClick={() => overwriteSnapshot(snap.id, api.current)}
                                >
                                    ↻
                                </button>
                                <button
                                    type="button"
                                    style={delStyle}
                                    title={`Delete "${label}"`}
                                    onClick={() => remove(rootPath, snap.id)}
                                >
                                    ×
                                </button>
                            </>
                        ) : null}
                    </div>
                );
            })}
            <button type="button" style={addStyle} title="Save current view (S)" onClick={() => captureSnapshot(api.current)}>
                +
            </button>
            {snapshots.length === 0 ? <span style={{opacity: 0.45}}>S = save view</span> : null}
        </div>
    );
}

// Inline group: rendered as part of the PinControls pill row (bottom-left), so
// no absolute positioning of its own — it just flows after the pin buttons.
const wrapStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.72rem",
    color: "#cfcfd6",
    userSelect: "none",
};

const dividerStyle: React.CSSProperties = {opacity: 0.3, margin: "0 0.1rem"};

const chipWrapStyle: React.CSSProperties = {position: "relative", display: "inline-flex"};

const chipStyle: React.CSSProperties = {
    appearance: "none",
    border: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.2rem 0.6rem",
    borderRadius: 999,
    background: "rgba(40,40,46,0.85)",
    color: "#cfcfd6",
    fontFamily: "inherit",
    fontSize: "inherit",
    cursor: "pointer",
    boxShadow: "inset 0 0 0 1px rgba(120,120,130,0.4)",
    backdropFilter: "blur(6px)",
};

// The view you're currently "on" (last saved / jumped to): an accent border +
// tint so it stands out from the rest of the row.
const activeChipStyle: React.CSSProperties = {
    ...chipStyle,
    background: "rgba(48,72,108,0.9)",
    color: "#eaf2ff",
    boxShadow: "inset 0 0 0 1px rgba(120,170,230,0.95)",
};

const badgeStyle: React.CSSProperties = {
    opacity: 0.55,
    fontVariantNumeric: "tabular-nums",
    fontSize: "0.66rem",
};

const addStyle: React.CSSProperties = {
    ...chipStyle,
    padding: "0.2rem 0.55rem",
    fontWeight: 600,
};

// Small delete affordance hugging the chip's top-right; only shown on hover.
const delStyle: React.CSSProperties = {
    position: "absolute",
    top: "-0.35rem",
    right: "-0.35rem",
    width: "1.05rem",
    height: "1.05rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: 0,
    borderRadius: 999,
    background: "rgba(70,40,44,0.95)",
    color: "#f0c8c8",
    fontSize: "0.8rem",
    lineHeight: 1,
    cursor: "pointer",
    boxShadow: "inset 0 0 0 1px rgba(150,90,90,0.5)",
};

// Overwrite-with-current-view affordance hugging the chip's top-LEFT (opposite
// the delete ×); only shown on hover.
const overwriteStyle: React.CSSProperties = {
    position: "absolute",
    top: "-0.35rem",
    left: "-0.35rem",
    width: "1.05rem",
    height: "1.05rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: 0,
    borderRadius: 999,
    background: "rgba(40,56,82,0.95)",
    color: "#bcd6ff",
    fontSize: "0.72rem",
    lineHeight: 1,
    cursor: "pointer",
    boxShadow: "inset 0 0 0 1px rgba(110,150,210,0.6)",
};

const inputStyle: React.CSSProperties = {
    padding: "0.2rem 0.5rem",
    borderRadius: 999,
    background: "rgba(30,30,36,0.95)",
    color: "#fff",
    border: 0,
    boxShadow: "inset 0 0 0 1px rgba(120,140,200,0.7)",
    fontFamily: "inherit",
    fontSize: "inherit",
    width: "7rem",
};
