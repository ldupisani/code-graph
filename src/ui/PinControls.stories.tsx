import type {Meta, StoryObj} from "@storybook/react-vite";
import {PinControls} from "./PinControls";
import {SnapshotBar} from "./SnapshotBar";
import {DEMO_ROOT, demoSnapshots, mockCameraRef} from "../stories/fixtures";

// HUD overlay, absolutely positioned bottom-left (above the hints
// footer). Pin buttons call the camera api — spied in the Actions
// panel.
const meta = {
    title: "HUD/PinControls",
    component: PinControls,
    args: {api: mockCameraRef()},
    parameters: {frame: {width: 700, height: 200}},
} satisfies Meta<typeof PinControls>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Alone: Story = {};

// The app composition: SnapshotBar flows after the pin buttons inside
// the same pill row (it has no positioning of its own).
export const WithSnapshotBar: Story = {
    args: {
        children: <SnapshotBar api={mockCameraRef()} rootPath={DEMO_ROOT} />,
    },
    parameters: {
        stores: {
            snapshots: {
                byProject: {[DEMO_ROOT]: demoSnapshots(2)},
                activeByProject: {[DEMO_ROOT]: "snap-a"},
            },
        },
    },
};
