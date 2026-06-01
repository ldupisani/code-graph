import type React from "react";
import type {CameraApi} from "../render/PixiCanvas";

// Device-independent zoom control (bottom-right of the canvas): −, fit, +.
// A reliable way to zoom out regardless of mouse/trackpad delta quirks.
export function ZoomControls({api}: {api: {current: CameraApi | null}}) {
    return (
        <div style={wrapStyle}>
            <button type="button" title="Zoom out" style={btnStyle} onClick={() => api.current?.zoomBy(0.8)}>
                −
            </button>
            <button type="button" title="Fit to view" style={btnStyle} onClick={() => api.current?.fitView()}>
                ⊡
            </button>
            <button type="button" title="Zoom in" style={btnStyle} onClick={() => api.current?.zoomBy(1.25)}>
                +
            </button>
        </div>
    );
}

const wrapStyle: React.CSSProperties = {
    position: "absolute",
    bottom: "0.8rem",
    right: "0.8rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    fontFamily: "ui-monospace, monospace",
    userSelect: "none",
};

const btnStyle: React.CSSProperties = {
    appearance: "none",
    border: 0,
    padding: 0,
    width: "2rem",
    height: "2rem",
    borderRadius: 6,
    // Flex-centre the glyph in the fixed-size box.
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    background: "rgba(40,40,46,0.85)",
    color: "#cfcfd6",
    fontSize: "1.1rem",
    cursor: "pointer",
    boxShadow: "inset 0 0 0 1px rgba(120,120,130,0.4)",
    backdropFilter: "blur(6px)",
};
