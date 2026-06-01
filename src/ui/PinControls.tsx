import type React from "react";
import type {CameraApi} from "../render/PixiCanvas";

// Bulk pin actions (mirrors the P / ⇧P / R keyboard shortcuts): pin the files
// currently on screen, pin every file, or release all pins. A pinned file is
// held in place against the force layout.
export function PinControls({api}: {api: {current: CameraApi | null}}) {
    return (
        <div style={wrapStyle}>
            <span style={{opacity: 0.6, marginRight: "0.1rem"}}>pin:</span>
            <button type="button" style={btnStyle} title="Pin files currently on screen (P)" onClick={() => api.current?.pinVisible()}>
                visible
            </button>
            <button type="button" style={btnStyle} title="Pin every file (⇧P)" onClick={() => api.current?.pinAll()}>
                all
            </button>
            <button type="button" style={btnStyle} title="Release all pins (R)" onClick={() => api.current?.unpinAll()}>
                unpin
            </button>
        </div>
    );
}

const wrapStyle: React.CSSProperties = {
    position: "absolute",
    bottom: "3rem",
    left: "0.8rem",
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.72rem",
    color: "#cfcfd6",
    userSelect: "none",
};

const btnStyle: React.CSSProperties = {
    appearance: "none",
    border: 0,
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
