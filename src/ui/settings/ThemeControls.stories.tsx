import type {Meta, StoryObj} from "@storybook/react-vite";
import {ThemeControls} from "./ThemeControls";
import {PanelBox} from "../../stories/PanelBox";

// Every themed value, grouped by what it paints: canvas, AST cells, kind
// outlines, syntax tokens, import/export washes, folder hues, edges.
//
// NOTE on VR coverage: the panel is now far taller than the 1000x700 viewport
// the visual-regression run screenshots, and toHaveScreenshot captures the
// VIEWPORT, not this frame — so the baseline only covers down to about the
// start of "Kind outlines". Everything below it is unguarded. Raising the frame
// height does nothing; the fix would be fullPage screenshots in
// tests/storybook-vr.spec.ts, which would regenerate all 48 baselines.
const meta = {
    title: "Settings/ThemeControls",
    component: ThemeControls,
    decorators: [
        (Story) => (
            <PanelBox>
                <Story />
            </PanelBox>
        ),
    ],
    parameters: {frame: {width: 420, height: 640}},
} satisfies Meta<typeof ThemeControls>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
