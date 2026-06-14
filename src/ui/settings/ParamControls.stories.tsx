import type {Meta, StoryObj} from "@storybook/react-vite";
import {ParamControls} from "./ParamControls";
import {listPatterns} from "../../graph/patterns/registry";
import {PanelBox} from "../../stories/PanelBox";

// Schema-driven controls: one input per ParamSpec of a tier pattern.
// Empty params = every control shows its spec default (the common
// state for a freshly-assigned pattern). tierId references the
// default config's overview tier so setTierParam writes land.
const meta = {
    title: "Settings/ParamControls",
    component: ParamControls,
    args: {tierId: "tier-overview", patternId: "folder-grid", params: {}},
    parameters: {frame: {width: 460, height: 640}},
} satisfies Meta<typeof ParamControls>;
export default meta;

type Story = StoryObj<typeof meta>;

// Every registered pattern's parameter schema, side by side — also
// covers the zero-params case ("No parameters." placeholder) if any
// pattern has an empty schema.
export const AllPatterns: Story = {
    parameters: {frame: {width: 900, height: 640}},
    render: (args) => (
        <div style={{display: "flex", flexWrap: "wrap", alignItems: "flex-start"}}>
            {listPatterns().map((p) => (
                <PanelBox key={p.id}>
                    <div style={{fontWeight: 700, marginBottom: "0.4rem", color: "#dcdcaa"}}>{p.name}</div>
                    <ParamControls {...args} patternId={p.id} />
                </PanelBox>
            ))}
        </div>
    ),
};

export const FolderGrid: Story = {
    render: (args) => (
        <PanelBox>
            <ParamControls {...args} />
        </PanelBox>
    ),
};

// Unknown pattern ids degrade to the fallback pattern's schema
// instead of crashing — old/hand-edited templates stay loadable.
export const UnknownPatternFallsBack: Story = {
    args: {patternId: "no-such-pattern"},
    render: (args) => (
        <PanelBox>
            <ParamControls {...args} />
        </PanelBox>
    ),
};
