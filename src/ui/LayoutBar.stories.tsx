import type {Meta, StoryObj} from "@storybook/react-vite";
import {userEvent, within} from "storybook/test";
import type {ProjectResponse} from "../api/types";
import {LayoutBar} from "./LayoutBar";
import {TopHudRow} from "./TopHudRow";

// The layout switcher, top-right of the canvas: four patterns, one active, and
// the ▾ that opens the settings panel. Needs a project in the graph store —
// with none open there's nothing to arrange, so the bar renders null.
const PROJECT = {
    projectId: "proj-story",
    rootPath: "/tmp/demo",
    language: "typescript",
    files: [],
    edges: [],
    semanticEdges: [],
} as unknown as ProjectResponse;

const meta = {
    title: "HUD/LayoutBar",
    component: LayoutBar,
    parameters: {
        frame: {width: 720, height: 420},
        stores: {graph: {project: PROJECT}},
    },
    // Wrapped as the app wraps it: TopHudRow owns the canvas's top strip and
    // pins this group right. Bare, it would sit flush in the corner.
    render: () => (
        <TopHudRow>
            <LayoutBar />
        </TopHudRow>
    ),
} satisfies Meta<typeof LayoutBar>;
export default meta;

type Story = StoryObj<typeof meta>;

// The resting state: pills only, panel closed.
export const Default: Story = {};

export const ForceActive: Story = {
    parameters: {
        stores: {graph: {project: PROJECT}, config: {layout: {patternId: "force-connectivity", byPattern: {}}}},
    },
};

// The ▾ open — the single entry point to layout configuration, and the only
// place the settings panel can be reached from.
export const SettingsOpen: Story = {
    parameters: {frame: {width: 720, height: 640}, stores: {graph: {project: PROJECT}}},
    play: async ({canvasElement}) => {
        await userEvent.click(within(canvasElement).getByLabelText("Layout settings"));
    },
};
