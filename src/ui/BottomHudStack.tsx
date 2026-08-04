import type React from "react";

// The canvas's bottom-left HUD column: pin actions + saved views on top, the
// shortcuts footer beneath.
//
// One shared stack rather than two absolutely-positioned components, for the
// same reason as TopHudRow. PinControls used to hardcode `bottom: 4.6rem` to
// clear a footer that was always three lines tall; now the footer collapses to
// a single icon, so any fixed offset is wrong in one state or the other. Here
// the column just reflows.
//
// Anchored at the BOTTOM, so the last child keeps its position and anything
// that grows pushes the rest upward — the shortcuts toggle stays put under the
// cursor while its panel opens above it.
//
// pointerEvents: none on the column, auto on each group (see their styles), so
// the gaps between them don't swallow drags meant for the graph underneath.
export function BottomHudStack({children}: {children: React.ReactNode}) {
    return <div style={stackStyle}>{children}</div>;
}

const stackStyle: React.CSSProperties = {
    position: "absolute",
    bottom: "0.6rem",
    left: "0.8rem",
    // Spans to the right edge so children can cap their width against the
    // CANVAS rather than the viewport — the canvas panel is resizable and is
    // routinely half the window with the editor open. Harmless to the layout:
    // alignItems keeps each child at its own content width.
    right: "0.8rem",
    zIndex: 5,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "0.5rem",
    pointerEvents: "none",
};
