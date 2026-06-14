import type {Meta, StoryObj} from "@storybook/react-vite";
import {HoverTooltip} from "./HoverTooltip";
import {cardJsxAst, cardJsxRootId, cardJsxSource, dogAst} from "../stories/fixtures";

// Tooltip anchored below the hovered AST node's screen rect. Reads
// hoveredId + hoveredScreenRect + asts from useGraphStore — all
// seeded here. It renders position:fixed, so the anchor rect
// coordinates are iframe-viewport coordinates.
const anchorRect = {x: 24, y: 24, w: 160, h: 36};

// Ghost box marking where the hovered node would be, so the tooltip's
// anchoring reads visually in the story.
function AnchorMarker() {
    return (
        <div
            style={{
                position: "fixed",
                left: anchorRect.x,
                top: anchorRect.y,
                width: anchorRect.w,
                height: anchorRect.h,
                border: "1px dashed rgba(120, 140, 200, 0.6)",
                borderRadius: 4,
                color: "rgba(120, 140, 200, 0.8)",
                fontSize: "0.65rem",
                fontFamily: "ui-monospace, monospace",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            hovered node
        </div>
    );
}

const meta = {
    title: "HUD/HoverTooltip",
    component: HoverTooltip,
    decorators: [
        (Story) => (
            <>
                <AnchorMarker />
                <Story />
            </>
        ),
    ],
    parameters: {
        frame: {width: 820, height: 220},
        stores: {
            graph: {
                asts: new Map([["src/dog.ts", dogAst]]),
                hoveredScreenRect: anchorRect,
            },
        },
    },
} satisfies Meta<typeof HoverTooltip>;
export default meta;

type Story = StoryObj<typeof meta>;

// Function-like node → `(p: T): R` signature.
export const Signature: Story = {
    parameters: {stores: {graph: {hoveredId: "src/dog.ts#1"}}},
};

// Expandable block → first-source-line peek with trailing ….
export const BlockPreview: Story = {
    parameters: {stores: {graph: {hoveredId: "src/dog.ts#2"}}},
};

// A ~230-char signature wraps inside maxWidth instead of overflowing.
export const LongSignatureWrap: Story = {
    parameters: {stores: {graph: {hoveredId: "src/dog.ts#3"}}},
};

// Nothing hovered → renders null (only the anchor marker shows).
export const NoHover: Story = {
    parameters: {stores: {graph: {hoveredId: null}}},
};

// JSX node → structural wireframe mock instead of the source-line peek.
// Seeds BOTH the AST and the raw source (story-level parameters replace
// the meta's Map wholesale, so the map carries both fixture files), so
// attribute values and expression text render at full fidelity.
export const JsxWireframe: Story = {
    parameters: {
        frame: {width: 820, height: 430},
        stores: {
            graph: {
                asts: new Map([
                    ["src/dog.ts", dogAst],
                    [cardJsxAst.fileId, cardJsxAst],
                ]),
                hoveredScreenRect: anchorRect,
                hoveredId: cardJsxRootId,
            },
            sources: {[cardJsxAst.fileId]: cardJsxSource},
        },
    },
};
