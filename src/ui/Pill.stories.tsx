import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";
import {Pill} from "./Pill";

// The palettes the app actually uses (EdgeFilterPills + settings).
const PALETTES = {
    imports: {bg: "#666670", text: "#cfcfd6"},
    calls: {bg: "#ff8b3d", text: "#1c1108"},
    extends: {bg: "#9aa3ff", text: "#0e1230"},
    tests: {bg: "#9aa3a8", text: "#0e1216"},
    isolateImports: {bg: "#e8c84a", text: "#1c1c08"},
    isolateExports: {bg: "#6cb6ff", text: "#0e1a30"},
} as const;

const meta = {
    title: "Primitives/Pill",
    component: Pill,
    args: {onToggle: fn()},
    parameters: {layout: "centered", frame: {width: 600, height: 120}},
} satisfies Meta<typeof Pill>;
export default meta;

type Story = StoryObj<typeof meta>;

export const On: Story = {
    args: {label: "calls", on: true, color: PALETTES.calls},
};

export const Off: Story = {
    args: {label: "calls", on: false, color: PALETTES.calls},
};

// Every palette used in the app, side by side.
export const AllPalettes: Story = {
    args: {label: "unused", on: true, color: PALETTES.imports},
    render: () => (
        <div style={{display: "flex", gap: "0.6rem", padding: "1rem", fontFamily: "ui-monospace, monospace", fontSize: "0.75rem"}}>
            {Object.entries(PALETTES).map(([name, color]) => (
                <Pill key={name} label={name} on color={color} onToggle={fn()} />
            ))}
        </div>
    ),
};
