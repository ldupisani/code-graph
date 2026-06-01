import {defaultsFromSpecs, type LayoutPattern, type ParamSpec, type PositionMap} from "./types";

// Force-directed connectivity layout — the d3-force simulation driven by import
// edges + directional (calls/inherit) biases + folder clustering. This is the
// LIVE pattern: its simulation is `layout.simulation`, built by buildFileLayout
// and ticked by the renderer's stepLayout each frame.
//
// Because the host owns the running simulation, the tier engine routes this
// pattern by `kind === "live"` and ticks layout.simulation directly rather than
// calling compute(). The param schema below describes the force strengths so
// the Phase 6 settings UI can surface them; wiring edits back into a running
// sim (or rebuilding it) is handled where the sim is constructed.

const PARAMS: readonly ParamSpec[] = [
    {key: "charge", label: "Repulsion", type: "number", default: -650, min: -2000, max: -50, step: 50, help: "Many-body charge: how strongly files push apart"},
    {key: "linkStrength", label: "Import pull", type: "number", default: 0.3, min: 0, max: 1, step: 0.05, help: "How firmly import edges pull files together"},
    {key: "collide", label: "Collision", type: "number", default: 0.95, min: 0, max: 1, step: 0.05, help: "Collision-avoidance strength between file boxes"},
    {key: "callsX", label: "Call → right", type: "number", default: 0.16, min: 0, max: 1, step: 0.02, help: "Caller drifts left of callee (x axis)"},
    {key: "callsY", label: "Call → down", type: "number", default: 0.12, min: 0, max: 1, step: 0.02, help: "Callee drifts below caller (y axis)"},
    {key: "inheritY", label: "Subclass → down", type: "number", default: 0.22, min: 0, max: 1, step: 0.02, help: "Subclass/implementer drifts below its base"},
    {key: "cluster", label: "Folder clustering", type: "number", default: 0.09, min: 0, max: 1, step: 0.02, help: "Soft pull of each file toward its directory centroid"},
];

const EMPTY: PositionMap = new Map();

export const forceConnectivityPattern: LayoutPattern = {
    id: "force-connectivity",
    name: "Force connectivity",
    description: "Import/call-driven force-directed layout with directional and folder-clustering biases.",
    kind: "live",
    params: PARAMS,
    defaults: () => defaultsFromSpecs(PARAMS),
    // Host-driven: the renderer ticks layout.simulation. Never called by the
    // tier engine for a live pattern; present only to satisfy the interface.
    compute() {
        return {
            kind: "live",
            tick: () => {},
            settled: () => true,
            reheat: () => {},
            positions: EMPTY,
            dispose: () => {},
        };
    },
};
