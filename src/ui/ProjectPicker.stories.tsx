import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";
import {ProjectPicker} from "./ProjectPicker";

// Dropdown picker over the server's discovered projects (lives in the app
// header). Storybook has no backend, so the open dropdown shows the fetch
// error state; the closed-button states render as in the app.
const meta = {
    title: "Primitives/ProjectPicker",
    component: ProjectPicker,
    args: {onSubmit: fn(), loading: false, error: null},
    decorators: [
        (Story) => (
            <div style={{padding: "1rem"}}>
                <Story />
            </div>
        ),
    ],
    parameters: {frame: {width: 900, height: 400}},
} satisfies Meta<typeof ProjectPicker>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const WithCurrentProject: Story = {
    args: {currentPath: "/Users/dev/projects/my-app"},
};

export const Loading: Story = {
    args: {currentPath: "/Users/dev/projects/my-app", loading: true},
};

export const ErrorState: Story = {
    args: {
        currentPath: "/Users/dev/projects/missing",
        error: "Path is not inside a configured workspace root.",
    },
};
