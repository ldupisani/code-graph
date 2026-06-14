import type {Meta, StoryObj} from "@storybook/react-vite";
import {expect, userEvent, within} from "storybook/test";
import {SnapshotBar} from "./SnapshotBar";
import {DEMO_ROOT, demoSnapshots, mockCameraRef} from "../stories/fixtures";

// Saved-view chip bar. In the app it flows inside the PinControls
// pill row (bottom-left); standalone it needs a positioned host row.
// State comes from useSnapshotStore, seeded per story. Snapshot
// fixtures use explicit ids — the store's own add() has a module
// counter that would make ids depend on story execution order.
const meta = {
    title: "HUD/SnapshotBar",
    component: SnapshotBar,
    args: {api: mockCameraRef(), rootPath: DEMO_ROOT},
    decorators: [
        (Story) => (
            <div
                style={{
                    position: "absolute",
                    bottom: "1rem",
                    left: "0.8rem",
                    display: "flex",
                    alignItems: "center",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "0.72rem",
                    color: "#cfcfd6",
                }}
            >
                <Story />
            </div>
        ),
    ],
    parameters: {frame: {width: 700, height: 160}},
} satisfies Meta<typeof SnapshotBar>;
export default meta;

type Story = StoryObj<typeof meta>;

// No saved views: just the + chip and the "S = save view" hint.
export const Empty: Story = {};

export const ThreeViews: Story = {
    parameters: {
        stores: {
            snapshots: {byProject: {[DEMO_ROOT]: demoSnapshots(3)}},
        },
    },
};

// "snap-b" (the custom-named one) is the active view — accent ring.
export const WithActive: Story = {
    parameters: {
        stores: {
            snapshots: {
                byProject: {[DEMO_ROOT]: demoSnapshots(3)},
                activeByProject: {[DEMO_ROOT]: "snap-b"},
            },
        },
    },
};

// Only the first 9 chips get a number badge (keyboard-addressable).
export const TenViews: Story = {
    parameters: {
        frame: {width: 900, height: 160},
        stores: {
            snapshots: {byProject: {[DEMO_ROOT]: demoSnapshots(10)}},
        },
    },
};

// Double-click a chip → inline rename input.
export const Renaming: Story = {
    parameters: {
        stores: {
            snapshots: {byProject: {[DEMO_ROOT]: demoSnapshots(3)}},
        },
    },
    play: async ({canvasElement}) => {
        const canvas = within(canvasElement);
        await userEvent.dblClick(await canvas.findByText("API surface"));
        await expect(canvas.getByRole("textbox")).toHaveFocus();
    },
};
