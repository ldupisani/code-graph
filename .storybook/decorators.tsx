import {useEffect, useMemo, useRef} from "react";
import type {Decorator} from "@storybook/react-vite";
import {useGraphStore} from "../src/graph/store";
import {useConfigStore} from "../src/graph/config/store";
import {useSnapshotStore} from "../src/graph/snapshots/store";
import {useSourceStore} from "../src/graph/sourceStore";
import {makeDefaultConfig} from "../src/graph/config/defaults";
import type {GraphStore} from "../src/graph/store";
import type {SnapshotStore} from "../src/graph/snapshots/store";

// Per-story store seeds, passed via `parameters.stores` in a story or
// meta. Each section is a partial applied on top of a deterministic
// baseline — see withStores below.
export interface StoreSeeds {
    graph?: Partial<GraphStore>;
    config?: Parameters<
        ReturnType<(typeof useConfigStore)["getState"]>["setConfig"]
    >[0];
    snapshots?: Partial<Pick<SnapshotStore, "byProject" | "activeByProject">>;
    // fileId -> raw source text (for the JSX wireframe previews).
    sources?: Record<string, string>;
}

// Every DATA field of useGraphStore (no actions). setState with this
// object resets state without touching the action functions.
function graphBaseline(): Partial<GraphStore> {
    return {
        project: null,
        selection: null,
        selectionSet: new Set<string>(),
        expandedFiles: new Set<string>(),
        expandedAstNodes: new Set<string>(),
        previewedAstNodes: new Set<string>(),
        asts: new Map(),
        edgeFilter: {imports: true, calls: true, extends: true},
        hoveredId: null,
        hoveredScreenRect: null,
        focusId: null,
        focusHops: 1,
        focusDirection: "both",
        tracedPath: null,
        showSupportFiles: false,
    };
}

// Reset the three Zustand singletons to a known baseline, then apply
// the story's seeds — synchronously during the decorator's render,
// BEFORE the story mounts, so the story's first read already sees the
// seeded state (zustand stores live outside React, so this is safe:
// nothing is subscribed yet). Keyed on the story id so it runs once
// per story, not on every controls-driven re-render — otherwise
// interacting with a settings story would be fought by the reset.
export const withStores: Decorator = (Story, context) => {
    const seeds = (context.parameters.stores ?? {}) as StoreSeeds;
    useMemo(() => {
        // The config + snapshot stores persist to localStorage and the
        // Storybook iframe accumulates writes across stories — clear
        // the blobs so a hard reload of any story is deterministic too.
        localStorage.removeItem("code-graph:config");
        localStorage.removeItem("code-graph:snapshots");

        useGraphStore.setState(graphBaseline());
        useConfigStore.setState({
            config: makeDefaultConfig(),
            activeTemplateId: null,
        });
        useSnapshotStore.setState({byProject: {}, activeByProject: {}});
        useSourceStore.setState({sources: new Map()});

        if (seeds.graph) useGraphStore.setState(seeds.graph);
        // Reuse the store's own deep-merge for config patches.
        if (seeds.config) useConfigStore.getState().setConfig(seeds.config);
        if (seeds.snapshots) useSnapshotStore.setState(seeds.snapshots);
        if (seeds.sources) useSourceStore.setState({sources: new Map(Object.entries(seeds.sources))});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [context.id]);

    // Key on the story id so component-local useState (SnapshotBar's
    // rename buffer, SettingsPanel's open flag, …) remounts per story.
    return (
        <div key={context.id} style={{display: "contents"}}>
            <Story />
        </div>
    );
};

// The app renders HUD components as absolutely-positioned overlays
// inside the canvas panel (ZoomControls bottom-right, EdgeFilterPills
// top-left, …). This frame stands in for that panel: positioned,
// fixed-size, dark — and a stable viewport for visual-regression
// screenshots. Override per story with `parameters.frame`.
export const withCanvasFrame: Decorator = (Story, context) => {
    const frame = (context.parameters.frame ?? {}) as {
        width?: number;
        height?: number;
    };
    const width = frame.width ?? 900;
    const height = frame.height ?? 480;

    // When this preview runs inside the code-graph app's in-canvas
    // story embed (src/render/storybookOverlay.ts), the embedder wants
    // to size the file's expanded rect to the story's actual frame —
    // post it up. Harmless anywhere else (no listener, '*' target,
    // non-sensitive payload).
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (window.parent === window) return;
        const el = ref.current;
        const post = (): void => {
            const r = el?.getBoundingClientRect();
            window.parent.postMessage(
                {
                    type: "code-graph:story-size",
                    width: r?.width ?? width,
                    height: r?.height ?? height,
                },
                "*",
            );
        };
        post();
        const ro = el ? new ResizeObserver(post) : null;
        if (el && ro) ro.observe(el);
        return () => ro?.disconnect();
    }, [width, height]);

    return (
        <div
            ref={ref}
            style={{
                position: "relative",
                width,
                height,
                background: "#1a1a1a",
                overflow: "hidden",
            }}
        >
            <Story />
        </div>
    );
};
