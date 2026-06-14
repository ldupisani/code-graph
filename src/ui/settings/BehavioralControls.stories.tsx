import type {Meta, StoryObj} from "@storybook/react-vite";
import {BehavioralControls} from "./BehavioralControls";
import {PanelBox} from "../../stories/PanelBox";

// Reads/writes useConfigStore (config.behavioral). The Default story
// shows makeDefaultConfig() values; toggles are live against the
// seeded store.
const meta = {
    title: "Settings/BehavioralControls",
    component: BehavioralControls,
    decorators: [
        (Story) => (
            <PanelBox>
                <Story />
            </PanelBox>
        ),
    ],
    parameters: {frame: {width: 420, height: 560}},
} satisfies Meta<typeof BehavioralControls>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Customized: Story = {
    parameters: {
        stores: {
            config: {
                behavioral: {
                    selectionExpands: false,
                    isolateImports: true,
                    openLayoutBias: 0.8,
                    expandAtMul: 3.5,
                },
            },
        },
    },
};
