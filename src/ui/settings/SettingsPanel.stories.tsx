import type {Meta, StoryObj} from "@storybook/react-vite";
import {userEvent, within} from "storybook/test";
import {SettingsPanel} from "./SettingsPanel";

// Self-contained overlay: gear button (top-right) toggling the docked
// settings panel. The Open story exercises the full panel including
// the TemplateManager and TierListEditor sections, live against the
// seeded default config.
const meta = {
    title: "Settings/SettingsPanel",
    component: SettingsPanel,
    parameters: {frame: {width: 900, height: 640}},
} satisfies Meta<typeof SettingsPanel>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
    play: async ({canvasElement}) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByTitle("Layout settings"));
    },
};
