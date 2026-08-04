import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";
import {SettingsPanelBody} from "./SettingsPanel";

// The docked settings panel — layout parameters, behavior, LOD, theme — live
// against the seeded default config.
//
// The body is storied on its own because it no longer owns a trigger: the
// LayoutBar's ▾ is the single way in (see HUD/LayoutBar → SettingsOpen for the
// button and panel together).
const meta = {
    title: "Settings/SettingsPanel",
    component: SettingsPanelBody,
    args: {onClose: fn().mockName("onClose")},
    parameters: {frame: {width: 900, height: 640}},
} satisfies Meta<typeof SettingsPanelBody>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Force connectivity is the one live pattern: it has no computed position map
// to mirror, so ParamControls drops the flip toggles.
export const ForceConnectivityActive: Story = {
    parameters: {stores: {config: {layout: {patternId: "force-connectivity", byPattern: {}}}}},
};
