import type {StorybookConfig} from "@storybook/react-vite";
import {mergeConfig} from "vite";

const config: StorybookConfig = {
    stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
    addons: ["@storybook/addon-a11y", "@storybook/addon-docs"],
    framework: "@storybook/react-vite",
    async viteFinal(cfg) {
        // Stories must never depend on the Fastify backend. The app's
        // vite.config.ts is inherited here, including its /api proxy —
        // drop it so a story that accidentally fetches /api fails
        // loudly instead of silently hitting a live server.
        return mergeConfig(cfg, {
            server: {proxy: undefined, strictPort: false},
        });
    },
};
export default config;
