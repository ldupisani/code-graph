import type {Meta, StoryObj} from "@storybook/react-vite";
import {ThemeControls} from "./ThemeControls";
import {PanelBox} from "../../stories/PanelBox";

// Color pickers + edge style controls over useConfigStore's theme.
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
