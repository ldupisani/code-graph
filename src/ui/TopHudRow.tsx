import type React from "react";

// The canvas's top HUD strip: edge filters pinned left, layout switcher pinned
// right, on one row spanning the canvas.
//
// One shared row rather than two independently-absolute components, because
// that's what stops them colliding — the canvas panel is resizable and gets
// genuinely narrow next to an open editor, and at that width a left-anchored
// and a right-anchored row will happily draw on top of each other. Here they
// can only ever meet in the middle, and `flexWrap` lets the right group drop to
// its own line before that happens.
//
// pointerEvents: none on the strip, auto on each group (see their styles): the
// strip spans the full canvas width, and without this its empty middle would
// swallow drags meant for the graph underneath.
//
// Its children no longer position themselves, so anything rendering one of them
// — including a Storybook story — has to wrap it in this, or it lands flush in
// the corner.
export function TopHudRow({children}: {children: React.ReactNode}) {
    return <div style={rowStyle}>{children}</div>;
}

const rowStyle: React.CSSProperties = {
    position: "absolute",
    top: "0.6rem",
    left: "0.8rem",
    right: "0.8rem",
    zIndex: 6,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "0.6rem",
    flexWrap: "wrap",
    pointerEvents: "none",
};
