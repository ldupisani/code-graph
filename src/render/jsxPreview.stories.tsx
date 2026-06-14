import type {Meta, StoryObj} from "@storybook/react-vite";
import {buildJsxPreviewModel, JsxWireframePreview, wireframeSrcdoc} from "./jsxPreview";
import {cardJsxAst, cardJsxRootId, cardJsxSource} from "../stories/fixtures";

// The structural "wireframe" renderer behind JSX previews in the graph
// (hover tooltip + the toggleable node overlay). These stories exercise
// the pure model builder + both renderers against the cardJsx fixture:
// nested elements, a component placeholder (<Pill>), attribute chips
// with and without source-recovered values, expression chips, text
// children, and budget truncation.
const meta = {
    title: "Primitives/JsxWireframePreview",
    component: JsxWireframePreview,
    parameters: {frame: {width: 560, height: 420}},
} satisfies Meta<typeof JsxWireframePreview>;
export default meta;

type Story = StoryObj<typeof meta>;

const withSource = buildJsxPreviewModel(cardJsxAst.nodes, cardJsxRootId, cardJsxSource)!;
const withoutSource = buildJsxPreviewModel(cardJsxAst.nodes, cardJsxRootId)!;
const truncated = buildJsxPreviewModel(cardJsxAst.nodes, cardJsxRootId, cardJsxSource, {maxDepth: 1, maxNodes: 6})!;

// Full fidelity: attribute values + expression text recovered from the
// raw source slice.
export const WithSource: Story = {
    args: {model: withSource},
};

// Before the file's source has been fetched: attrs fall back to bare
// names, expressions to the extractor's preview/name.
export const WithoutSource: Story = {
    args: {model: withoutSource},
};

// Depth/node budgets exhausted → explicit … markers, not silent loss.
export const Truncated: Story = {
    args: {model: truncated},
};

// The overlay path: same model serialized to an escaped HTML document
// and rendered in a fully sandboxed iframe (no scripts, no network).
export const SrcdocIframe: Story = {
    args: {model: withSource},
    render: (args) => (
        <iframe
            title="wireframe"
            sandbox=""
            srcDoc={wireframeSrcdoc(args.model)}
            style={{
                width: 500,
                height: 340,
                margin: "1rem",
                border: "1px solid rgba(120, 120, 130, 0.45)",
                borderRadius: 8,
                background: "rgba(22, 22, 27, 0.97)",
            }}
        />
    ),
};
