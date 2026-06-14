// Shared fixtures for Storybook stories. Everything here is
// deterministic — explicit ids, no counters, no Date.now() — so
// visual-regression baselines don't depend on story execution order.
import {fn} from "storybook/test";
import type {CameraApi, CameraState} from "../render/PixiCanvas";
import type {FileAstResponse, ProjectResponse} from "../api/types";
import type {Snapshot, SnapshotView} from "../graph/snapshots/store";

export const DEMO_ROOT = "/demo/project";

// Full CameraApi whose mutating methods are storybook `fn()` spies —
// clicks in ZoomControls / PinControls / SnapshotBar stories show up
// in the Actions panel instead of needing a live Pixi canvas.
export function mockCameraApi(): CameraApi {
    const camera: CameraState = {x: 0, y: 0, scale: 1};
    return {
        zoomBy: fn().mockName("zoomBy"),
        fitView: fn().mockName("fitView"),
        frameFiles: fn().mockName("frameFiles"),
        pinAll: fn().mockName("pinAll"),
        pinVisible: fn().mockName("pinVisible"),
        unpinAll: fn().mockName("unpinAll"),
        getCamera: () => camera,
        setCamera: fn().mockName("setCamera"),
        getPins: () => [],
        setPins: fn().mockName("setPins"),
    };
}

// Components take the camera as a React ref object.
export function mockCameraRef(): {current: CameraApi | null} {
    return {current: mockCameraApi()};
}

// A small believable project — enough files/edges that EdgeFilterPills
// renders (it returns null without a project) and labels look real.
export const miniProject: ProjectResponse = {
    projectId: "demo",
    rootPath: DEMO_ROOT,
    tsConfigPath: `${DEMO_ROOT}/tsconfig.json`,
    files: [
        {
            id: "src/App.tsx",
            kind: "file",
            relativePath: "src/App.tsx",
            absolutePath: `${DEMO_ROOT}/src/App.tsx`,
            sizeBytes: 4210,
            lineCount: 138,
        },
        {
            id: "src/ui/Button.tsx",
            kind: "file",
            relativePath: "src/ui/Button.tsx",
            absolutePath: `${DEMO_ROOT}/src/ui/Button.tsx`,
            sizeBytes: 980,
            lineCount: 42,
        },
        {
            id: "src/graph/layout.ts",
            kind: "file",
            relativePath: "src/graph/layout.ts",
            absolutePath: `${DEMO_ROOT}/src/graph/layout.ts`,
            sizeBytes: 12044,
            lineCount: 411,
        },
        {
            id: "src/api/client.ts",
            kind: "file",
            relativePath: "src/api/client.ts",
            absolutePath: `${DEMO_ROOT}/src/api/client.ts`,
            sizeBytes: 2330,
            lineCount: 87,
        },
        {
            id: "src/App.test.tsx",
            kind: "file",
            relativePath: "src/App.test.tsx",
            absolutePath: `${DEMO_ROOT}/src/App.test.tsx`,
            sizeBytes: 1500,
            lineCount: 60,
        },
    ],
    edges: [
        {id: "e1", kind: "imports", fromId: "src/App.tsx", toId: "src/ui/Button.tsx"},
        {id: "e2", kind: "imports", fromId: "src/App.tsx", toId: "src/api/client.ts"},
        {id: "e3", kind: "imports", fromId: "src/graph/layout.ts", toId: "src/api/client.ts"},
    ],
    semanticEdges: [
        {
            id: "s1",
            kind: "calls",
            fromId: "src/App.tsx#4",
            toId: "src/api/client.ts#2",
        },
    ],
};

// AST fixture for HoverTooltip stories: one node per tooltip variant.
export const dogAst: FileAstResponse = {
    fileId: "src/dog.ts",
    rootId: "src/dog.ts#0",
    nodes: [
        {
            id: "src/dog.ts#0",
            parentId: null,
            syntaxKind: "SourceFile",
            name: "dog.ts",
            start: 0,
            end: 400,
        },
        {
            id: "src/dog.ts#1",
            parentId: "src/dog.ts#0",
            syntaxKind: "MethodDeclaration",
            name: "bark",
            signature: "(volume: number): void",
            start: 20,
            end: 80,
        },
        {
            id: "src/dog.ts#2",
            parentId: "src/dog.ts#0",
            syntaxKind: "Block",
            name: null,
            preview: "const sum = items.reduce((a, b) => a + b, 0); …",
            start: 90,
            end: 220,
        },
        {
            id: "src/dog.ts#3",
            parentId: "src/dog.ts#0",
            syntaxKind: "FunctionDeclaration",
            name: "configureEverything",
            signature:
                "(options: {retries: number; backoffMs: number; onError: (err: Error, attempt: number) => void; transports: ReadonlyArray<{kind: 'http' | 'ws'; url: string; headers?: Record<string, string>}>}): Promise<ConfiguredClient>",
            start: 230,
            end: 400,
        },
    ],
};

// JSX fixture for the wireframe-preview stories: REAL source text plus
// a hand-flattened AST whose start/end offsets index into it (computed
// with indexOf so the two can't drift apart). Mirrors the extractor's
// output shape: JsxExpression braces elided (the inner expression is
// the element's direct child), attributes reparented onto the element,
// JsxText whitespace-collapsed into `name`.
export const cardJsxSource = `const card = (
  <div className="card" onClick={() => select(item.id)}>
    <header className="card-head">
      <h3>{item.title}</h3>
      <Pill label="status" active={item.done} />
    </header>
    <p>Last updated {formatDate(item.updatedAt)} by {item.owner}</p>
    {item.tags.map((t) => <span key={t}>{t}</span>)}
    <input value={draft} placeholder="rename" />
    <button disabled>Archive</button>
  </div>
)`;

function jsxSpan(snippet: string): {start: number; end: number} {
    const start = cardJsxSource.indexOf(snippet);
    if (start < 0) throw new Error(`jsx fixture snippet not found: ${snippet}`);
    return {start, end: start + snippet.length};
}

const JSX_FILE = "src/Card.tsx";
const jid = (n: number): string => `${JSX_FILE}#${n}`;

export const cardJsxAst: FileAstResponse = {
    fileId: JSX_FILE,
    rootId: jid(0),
    nodes: [
        {id: jid(0), parentId: null, syntaxKind: "SourceFile", name: "Card.tsx", start: 0, end: cardJsxSource.length},
        {id: jid(1), parentId: jid(0), syntaxKind: "JsxElement", name: "<div>", preview: '<div className="card" …', ...jsxSpan(`<div className="card"`)},
        {id: jid(2), parentId: jid(1), syntaxKind: "JsxAttribute", name: "className", ...jsxSpan(`className="card"`)},
        {id: jid(3), parentId: jid(1), syntaxKind: "JsxAttribute", name: "onClick", ...jsxSpan("onClick={() => select(item.id)}")},
        {id: jid(4), parentId: jid(1), syntaxKind: "JsxElement", name: "<header>", ...jsxSpan(`<header className="card-head">`)},
        {id: jid(5), parentId: jid(4), syntaxKind: "JsxAttribute", name: "className", ...jsxSpan(`className="card-head"`)},
        {id: jid(6), parentId: jid(4), syntaxKind: "JsxElement", name: "<h3>", ...jsxSpan("<h3>{item.title}</h3>")},
        {id: jid(7), parentId: jid(6), syntaxKind: "PropertyAccessExpression", name: "item.title", ...jsxSpan("item.title")},
        {id: jid(8), parentId: jid(4), syntaxKind: "JsxSelfClosingElement", name: "<Pill />", ...jsxSpan(`<Pill label="status" active={item.done} />`)},
        {id: jid(9), parentId: jid(8), syntaxKind: "JsxAttribute", name: "label", ...jsxSpan(`label="status"`)},
        {id: jid(10), parentId: jid(8), syntaxKind: "JsxAttribute", name: "active", ...jsxSpan("active={item.done}")},
        {id: jid(11), parentId: jid(1), syntaxKind: "JsxElement", name: "<p>", ...jsxSpan("<p>Last updated")},
        {id: jid(12), parentId: jid(11), syntaxKind: "JsxText", name: "Last updated", ...jsxSpan("Last updated ")},
        {id: jid(13), parentId: jid(11), syntaxKind: "CallExpression", name: "formatDate", ...jsxSpan("formatDate(item.updatedAt)")},
        {id: jid(14), parentId: jid(11), syntaxKind: "JsxText", name: "by", ...jsxSpan(" by ")},
        {id: jid(15), parentId: jid(11), syntaxKind: "PropertyAccessExpression", name: "item.owner", ...jsxSpan("item.owner")},
        {id: jid(16), parentId: jid(1), syntaxKind: "CallExpression", name: "map", preview: "item.tags.map((t) => <span key={t}>{t}</span>)", ...jsxSpan("item.tags.map((t) => <span key={t}>{t}</span>)")},
        {id: jid(17), parentId: jid(1), syntaxKind: "JsxElement", name: "<button>", ...jsxSpan("<button disabled>Archive</button>")},
        {id: jid(18), parentId: jid(17), syntaxKind: "JsxAttribute", name: "disabled", ...jsxSpan("disabled")},
        {id: jid(19), parentId: jid(17), syntaxKind: "JsxText", name: "Archive", ...jsxSpan("Archive")},
        // A VOID element — regression guard: instantiating a real
        // <input> with badge/chip children crashes React (void elements
        // can't have children), so the renderers must box it instead.
        {id: jid(20), parentId: jid(1), syntaxKind: "JsxSelfClosingElement", name: "<input />", ...jsxSpan(`<input value={draft} placeholder="rename" />`)},
        {id: jid(21), parentId: jid(20), syntaxKind: "JsxAttribute", name: "value", ...jsxSpan("value={draft}")},
        {id: jid(22), parentId: jid(20), syntaxKind: "JsxAttribute", name: "placeholder", ...jsxSpan(`placeholder="rename"`)},
    ],
};
export const cardJsxRootId = jid(1);

const emptyView: SnapshotView = {
    selection: null,
    selectionSet: [],
    expandedFiles: [],
    expandedAstNodes: [],
    edgeFilter: {imports: true, calls: true, extends: true},
    focusId: null,
    focusHops: 1,
    focusDirection: "both",
    tracedPath: null,
    showSupportFiles: false,
};

// Snapshots with EXPLICIT ids — never created via the store's add()
// (its module-level uid counter would make ids depend on how many
// stories ran before this one).
export function demoSnapshots(count: number): Snapshot[] {
    const names: Record<number, string> = {1: "API surface"};
    return Array.from({length: count}, (_, i) => ({
        id: `snap-${String.fromCharCode(97 + i)}`,
        ...(names[i] ? {name: names[i]} : {}),
        view: emptyView,
        camera: {x: 0, y: 0, scale: 1},
    }));
}
