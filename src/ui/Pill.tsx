// Shared toggle pill used by the edge-filter HUD and the settings panel.
// `on` controls the filled/dim state; `color` is the filled palette.
export function Pill({
    label,
    on,
    color,
    onToggle,
}: {
    label: string;
    on: boolean;
    color: {bg: string; text: string};
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={on}
            style={{
                appearance: "none",
                border: 0,
                padding: "0.25rem 0.65rem",
                borderRadius: 999,
                background: on ? color.bg : "rgba(40, 40, 46, 0.85)",
                color: on ? color.text : "#888892",
                fontFamily: "inherit",
                fontSize: "inherit",
                boxShadow: "inset 0 0 0 1px rgba(120, 120, 130, 0.35)",
                cursor: "pointer",
                opacity: on ? 1 : 0.55,
                transition: "opacity 120ms ease, background-color 120ms ease",
                backdropFilter: "blur(6px)",
            }}
        >
            {label}
        </button>
    );
}
