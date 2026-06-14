import type {Meta, StoryObj} from "@storybook/react-vite";
import {LodControls} from "./LodControls";
import {PanelBox} from "../../stories/PanelBox";

// Level-of-detail threshold sliders over useConfigStore's config.lod.
const meta = {
    title: "Settings/LodControls",
    component: LodControls,
    decorators: [
        (Story) => (
            <PanelBox>
                <Story />
            </PanelBox>
        ),
    ],
    parameters: {frame: {width: 420, height: 560}},
} satisfies Meta<typeof LodControls>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
