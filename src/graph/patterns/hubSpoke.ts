import type {ProjectResponse} from "../../api/types";
import {dirnameOf} from "../layout";
import {defaultsFromSpecs, type LayoutPattern, type ParamSpec, type PatternParams, type PositionMap} from "./types";

// Hub-and-spoke (folder-based): each folder is a HUB; its files radiate evenly
// on a circle (the spokes) around it. Folders themselves are arranged on
// concentric rings — by folder depth when enabled, otherwise a single ring.
// A STATIC pattern: positions depend only on the file tree + params.

const PARAMS: readonly ParamSpec[] = [
    {key: "spokeRadius", label: "Spoke radius", type: "number", default: 150, min: 40, max: 600, step: 10, help: "Radius of the file ring around each folder hub"},
    {key: "hubSpacing", label: "Hub spacing", type: "number", default: 1, min: 0.4, max: 4, step: 0.1, help: "Spread multiplier between folder hubs"},
    {key: "ringByDepth", label: "Rings by depth", type: "boolean", default: true, help: "Place deeper folders on outer rings (vs one ring)"},
    {key: "angularJitter", label: "Angle jitter", type: "number", default: 0, min: 0, max: 1, step: 0.05, help: "Randomize file angles a little to break symmetry"},
    {key: "sortWithinFolder", label: "Order files by", type: "enum", default: "name", options: ["name", "size", "connectivity"], help: "How files are ordered around each hub"},
];

export const hubSpokePattern: LayoutPattern = {
    id: "hub-spoke",
    name: "Hub & spoke (folders)",
    description: "Folders as hubs; files radiate on a circle around each. Folders ringed, optionally by depth.",
    kind: "static",
    params: PARAMS,
    defaults: () => defaultsFromSpecs(PARAMS),
    compute(project, params) {
        return {kind: "static", positions: layout(project, params)};
    },
};

function layout(project: ProjectResponse, params: PatternParams): PositionMap {
    const spokeRadius = num(params.spokeRadius, 150);
    const hubSpacing = num(params.hubSpacing, 1);
    const ringByDepth = params.ringByDepth !== false;
    const jitter = num(params.angularJitter, 0);
    const sortBy = typeof params.sortWithinFolder === "string" ? params.sortWithinFolder : "name";

    // Group files by their parent directory.
    const byDir = new Map<string, string[]>();
    for (const f of project.files) {
        const dir = dirnameOf(f.relativePath);
        const arr = byDir.get(dir);
        if (arr) arr.push(f.id);
        else byDir.set(dir, [f.id]);
    }

    const degree = sortBy === "connectivity" ? fileDegrees(project) : null;
    const sizeOf = new Map(project.files.map((f) => [f.id, f.lineCount || f.sizeBytes || 0]));
    const orderKey = (id: string): number => (sortBy === "size" ? sizeOf.get(id)! : sortBy === "connectivity" ? degree!.get(id) ?? 0 : 0);

    const dirs = [...byDir.keys()].sort();
    const depthOf = (dir: string): number => (dir === "<root>" ? 0 : dir.split("/").length);

    // Folder-hub ring radius grows with the per-folder file ring so hubs don't
    // overlap; deterministic, derived from spokeRadius + spacing.
    const maxFiles = Math.max(1, ...dirs.map((d) => byDir.get(d)!.length));
    const fileRingMax = fileRingRadius(maxFiles, spokeRadius);
    // Hub spacing ≈ just enough for the largest folder's file ring plus a small
    // gap. Kept tight (0.6×) so the whole layout stays compact (~2–3× the
    // folder-grid extent); hubSpacing is the user's knob to spread it out.
    const baseRing = (fileRingMax * 0.6 + spokeRadius) * hubSpacing;

    // Bucket folders for ring placement.
    const hubPos = new Map<string, {x: number; y: number}>();
    if (ringByDepth) {
        const byDepth = new Map<number, string[]>();
        for (const dir of dirs) {
            const d = depthOf(dir);
            const arr = byDepth.get(d);
            if (arr) arr.push(dir);
            else byDepth.set(d, [dir]);
        }
        for (const [d, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
            // Soften depth growth: rings step out gently (depth 1 → 1×, 2 → 1.7×,
            // 3 → 2.4× …) instead of linearly (1×, 2×, 3×), so deep trees don't
            // balloon the outer rings.
            const ringR = d === 0 ? 0 : baseRing * (1 + (d - 1) * 0.7);
            placeOnRing(group, ringR, hubPos, baseRing);
        }
    } else {
        placeOnRing(dirs, baseRing * Math.max(1, dirs.length) / (2 * Math.PI), hubPos, baseRing);
    }

    // Place each folder's files on a circle around its hub.
    const out: PositionMap = new Map();
    for (const dir of dirs) {
        const hub = hubPos.get(dir)!;
        const files = byDir.get(dir)!.slice().sort((a, b) => {
            const k = orderKey(b) - orderKey(a);
            return k !== 0 ? k : a < b ? -1 : 1;
        });
        const m = files.length;
        if (m === 1) {
            out.set(files[0], {x: hub.x, y: hub.y});
            continue;
        }
        const r = fileRingRadius(m, spokeRadius);
        for (let j = 0; j < m; j++) {
            // Deterministic pseudo-jitter from index (Math.random is unavailable
            // in some contexts and would make the layout non-reproducible).
            const wobble = jitter === 0 ? 0 : Math.sin(j * 12.9898) * jitter * (Math.PI / m);
            const angle = (2 * Math.PI * j) / m + wobble;
            out.set(files[j], {x: hub.x + Math.cos(angle) * r, y: hub.y + Math.sin(angle) * r});
        }
    }
    return out;
}

// File ring radius: at least spokeRadius, grown so dense folders don't pack
// their files into each other (each file wants ~spokeRadius*0.34 of arc — tight
// so folders stay small and the overall layout compact).
function fileRingRadius(count: number, spokeRadius: number): number {
    const needed = (count * spokeRadius * 0.34) / (2 * Math.PI);
    return Math.max(spokeRadius, needed);
}

function placeOnRing(dirs: string[], ringR: number, out: Map<string, {x: number; y: number}>, baseRing: number): void {
    const n = dirs.length;
    if (n === 1 && ringR === 0) {
        out.set(dirs[0], {x: 0, y: 0});
        return;
    }
    // Ensure neighbouring hubs on this ring are at least baseRing apart.
    const r = Math.max(ringR, (n * baseRing) / (2 * Math.PI));
    for (let i = 0; i < n; i++) {
        const angle = (2 * Math.PI * i) / Math.max(1, n);
        out.set(dirs[i], {x: Math.cos(angle) * r, y: Math.sin(angle) * r});
    }
}

function fileDegrees(project: ProjectResponse): Map<string, number> {
    const deg = new Map<string, number>();
    const bump = (id: string) => deg.set(id, (deg.get(id) ?? 0) + 1);
    for (const e of project.edges) {
        bump(e.fromId);
        bump(e.toId);
    }
    return deg;
}

function num(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
