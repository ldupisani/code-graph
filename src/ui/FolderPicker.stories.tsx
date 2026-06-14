import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";
import {FolderPicker} from "./FolderPicker";

// Pure props-driven form (lives in the app header). The submit handler
// logs to the Actions panel.
const meta = {
    title: "Primitives/FolderPicker",
    component: FolderPicker,
    args: {onSubmit: fn(), loading: false, error: null},
    decorators: [
        (Story) => (
            <div style={{padding: "1rem"}}>
                <Story />
            </div>
        ),
    ],
    parameters: {frame: {width: 900, height: 100}},
} satisfies Meta<typeof FolderPicker>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const WithInitialPath: Story = {
    args: {initialPath: "/Users/dev/projects/my-app"},
};

export const Loading: Story = {
    args: {initialPath: "/Users/dev/projects/my-app", loading: true},
};

export const ErrorState: Story = {
    args: {
        initialPath: "/Users/dev/projects/missing",
        error: "ENOENT: no tsconfig.json found under this path",
    },
};
