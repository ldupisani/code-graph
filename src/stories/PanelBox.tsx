import type React from "react";

// Stand-in for the SettingsPanel body that hosts the settings section
// components in the app — same width and dark chrome, so sections
// render at their designed proportions when storied standalone.
export function PanelBox({children}: {children: React.ReactNode}) {
    return (
        <div
            style={{
                width: 300,
                margin: "1rem",
                padding: "0.75rem",
                background: "rgba(28, 28, 33, 0.97)",
                borderRadius: 8,
                boxShadow: "inset 0 0 0 1px rgba(120, 120, 130, 0.35)",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: "#d4d4d4",
            }}
        >
            {children}
        </div>
    );
}
