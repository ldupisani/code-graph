import {useState} from "react";
import type {Meta, StoryObj} from "@storybook/react-vite";
import {ColorField, NumberField, ToggleField} from "./fields";
import {PanelBox} from "../../stories/PanelBox";

// Reusable settings form fields. Each demo is stateful so sliders,
// toggles and the color swatch respond in the sandbox.
const meta = {
    title: "Settings/Fields",
    component: NumberField,
    parameters: {frame: {width: 420, height: 220}},
} satisfies Meta<typeof NumberField>;
export default meta;

// Render-only demos (each hosts its own state); no args flow through,
// so the untyped StoryObj avoids requiring NumberField's props.
type Story = StoryObj;

function NumberDemo(props: {label: string; min?: number; max?: number; step?: number; help?: string; initial: number}) {
    const [v, setV] = useState(props.initial);
    return <NumberField label={props.label} value={v} min={props.min} max={props.max} step={props.step} help={props.help} onChange={setV} />;
}

// min+max present → slider row appears under the number input.
export const NumberWithSlider: Story = {
    render: () => (
        <PanelBox>
            <NumberDemo label="Expand at ×fit" initial={2.2} min={0.5} max={6} step={0.1} help="Files auto-expand at this multiple of the fit zoom" />
        </PanelBox>
    ),
};

// Unbounded → plain number input, no slider.
export const NumberPlain: Story = {
    render: () => (
        <PanelBox>
            <NumberDemo label="Seed" initial={42} />
        </PanelBox>
    ),
};

export const Toggle: Story = {
    render: function ToggleStory() {
        const [v, setV] = useState(true);
        return (
            <PanelBox>
                <ToggleField label="Selection expands files" value={v} onChange={setV} help="Auto-expand a selected file once zoomed in" />
            </PanelBox>
        );
    },
};

export const Color: Story = {
    render: function ColorStory() {
        const [v, setV] = useState(0x4ec9b0);
        return (
            <PanelBox>
                <ColorField label="Selection outline" value={v} onChange={setV} />
            </PanelBox>
        );
    },
};
