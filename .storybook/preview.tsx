import type {Preview} from "@storybook/react-vite";
import {withCanvasFrame, withStores} from "./decorators";
import "../src/index.css";

const preview: Preview = {
    parameters: {
        layout: "fullscreen",
        backgrounds: {
            options: {
                canvas: {name: "Canvas", value: "#1a1a1a"},
                light: {name: "Light", value: "#f5f5f5"},
            },
        },
        controls: {
            matchers: {
                color: /(background|color)$/i,
                date: /Date$/i,
            },
        },
        a11y: {
            test: "todo",
        },
    },
    initialGlobals: {
        backgrounds: {value: "canvas"},
    },
    // Order matters: withStores (innermost) seeds the Zustand
    // singletons before the story renders; withCanvasFrame wraps the
    // result in the dark positioned frame the HUD overlays anchor to.
    decorators: [withStores, withCanvasFrame],
    tags: ["autodocs"],
};

export default preview;
