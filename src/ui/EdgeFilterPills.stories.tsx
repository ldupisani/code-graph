import type {Meta, StoryObj} from "@storybook/react-vite";
import {EdgeFilterPills} from "./EdgeFilterPills";
import {miniProject} from "../stories/fixtures";

// Store-coupled HUD: reads useGraphStore (project, edgeFilter, focus,
// traced path) and useConfigStore (isolate toggles). Stories seed the
// stores via parameters.stores — see .storybook/decorators.tsx.
const meta = {
    title: "HUD/EdgeFilterPills",
    component: EdgeFilterPills,
    parameters: {stores: {graph: {project: miniProject}}},
} satisfies Meta<typeof EdgeFilterPills>;
export default meta;

type Story = StoryObj<typeof meta>;

export const AllOn: Story = {};

export const SomeOff: Story = {
    parameters: {
        stores: {
            graph: {
                project: miniProject,
                edgeFilter: {imports: true, calls: false, extends: false},
            },
        },
    },
};

// Focus mode adds the hop counter + hotkey legend on the right.
export const FocusMode: Story = {
    parameters: {
        stores: {
            graph: {project: miniProject, focusId: "src/App.tsx", focusHops: 2},
        },
    },
};

export const TracedPath: Story = {
    parameters: {
        stores: {
            graph: {
                project: miniProject,
                tracedPath: ["src/App.tsx", "src/api/client.ts", "src/graph/layout.ts"],
            },
        },
    },
};

// Isolate direction toggles live in the CONFIG store (persisted with
// layout templates), not the graph store.
export const IsolateOn: Story = {
    parameters: {
        stores: {
            graph: {project: miniProject},
            config: {behavioral: {isolateImports: true, isolateExports: true}},
        },
    },
};

// Without a project the component renders nothing — there are no
// edges to filter. Kept as a story to document the contract. Note the
// explicit null: story parameters DEEP-MERGE over meta parameters, so
// an empty seed object would not clear the meta-level project.
export const HiddenWithoutProject: Story = {
    parameters: {stores: {graph: {project: null}}},
};
