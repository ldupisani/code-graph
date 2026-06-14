import type {Meta, StoryObj} from "@storybook/react-vite";
import {ZoomControls} from "./ZoomControls";
import {mockCameraRef} from "../stories/fixtures";

// HUD overlay, absolutely positioned bottom-right of the canvas frame.
// The camera api is a ref of spies — clicking −/⊡/+ logs zoomBy /
// fitView calls to the Actions panel.
const meta = {
    title: "HUD/ZoomControls",
    component: ZoomControls,
    args: {api: mockCameraRef()},
    parameters: {frame: {width: 420, height: 240}},
} satisfies Meta<typeof ZoomControls>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
