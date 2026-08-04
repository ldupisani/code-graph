import type {Meta, StoryObj} from "@storybook/react-vite";
import {PanelBox} from "../../stories/PanelBox";
import {ParamControls} from "./ParamControls";

// Schema-driven controls for the ACTIVE layout pattern's params.
//
// ParamControls takes no props — it reads the active pattern from
// useConfigStore — so each story seeds `layout.patternId` through the
// withStores decorator rather than passing an arg. That's also why there's a
// story per pattern instead of one side-by-side render: only one pattern is
// ever active at a time.
const meta = {
    title: "Settings/ParamControls",
    component: ParamControls,
    parameters: {frame: {width: 460, height: 640}},
    render: () => (
        <PanelBox>
            <ParamControls />
        </PanelBox>
    ),
} satisfies Meta<typeof ParamControls>;
export default meta;

type Story = StoryObj<typeof meta>;

function withPattern(patternId: string) {
    return {stores: {config: {layout: {patternId, byPattern: {}}}}};
}

// byPattern is left empty, so every control shows its spec default — the state
// a pattern is in until you first tune it.
export const FolderGrid: Story = {parameters: withPattern("folder-grid")};
export const HubSpoke: Story = {parameters: withPattern("hub-spoke")};
export const Treemap: Story = {parameters: withPattern("treemap")};
export const ForceConnectivity: Story = {parameters: withPattern("force-connectivity")};

// Unknown pattern ids degrade to the fallback pattern's schema instead of
// crashing — a snapshot from a build that had a pattern this one doesn't, or a
// hand-edited localStorage blob, stays loadable.
export const UnknownPatternFallsBack: Story = {parameters: withPattern("no-such-pattern")};
