import type {ProjectResponse} from "../../api/types";
import {dirnameOf} from "../layout";
import {defaultsFromSpecs, type LayoutPattern, type ParamSpec, type PatternBuildContext, type PatternParams, type PositionMap} from "./types";

// Treemap / packed folders: the folder tree squarified into nested rectangles,
// each file sized by its weight (lines / bytes / equal). A file's center is the
// center of its rectangle. A STATIC pattern (positions depend on tree + params).

const PARAMS: readonly ParamSpec[] = [
    {key: "weightBy", label: "Size files by", type: "enum", default: "lines", options: ["lines", "bytes", "equal"], help: "What determines each file's rectangle area"},
    {key: "gap", label: "File spacing", type: "number", default: 28, min: 0, max: 160, step: 4, help: "Clear space kept around every file box"},
    {key: "sizeContrast", label: "Size contrast", type: "number", default: 8, min: 1, max: 40, step: 1, help: "How much bigger the largest file's cell may be than the smallest"},
    {key: "padding", label: "Folder padding", type: "number", default: 8, min: 0, max: 40, step: 1, help: "Inner padding around each nested folder"},
    {key: "aspectTarget", label: "Aspect ratio", type: "number", default: 1.6, min: 0.5, max: 4, step: 0.1, help: "Width : height of the whole treemap"},
];

export const treemapPattern: LayoutPattern = {
    id: "treemap",
    name: "Treemap / packed folders",
    description: "Folder tree squarified into nested rectangles; files sized by lines/bytes.",
    kind: "static",
    params: PARAMS,
    defaults: () => defaultsFromSpecs(PARAMS),
    compute(project, params, shared) {
        return {kind: "static", positions: build(project, params, shared)};
    },
};

interface Node {
    fileId?: string; // set on leaves
    weight: number;
    children: Map<string, Node>;
}

function build(project: ProjectResponse, params: PatternParams, shared: PatternBuildContext): PositionMap {
    const weightBy = typeof params.weightBy === "string" ? params.weightBy : "lines";
    const padding = num(params.padding, 8);
    const aspect = num(params.aspectTarget, 1.6);
    const gap = num(params.gap, 28);
    const contrast = Math.max(1, num(params.sizeContrast, 8));

    const rawWeightOf = (lines: number, bytes: number): number =>
        weightBy === "bytes" ? Math.max(1, bytes) : weightBy === "equal" ? 1 : Math.max(1, lines);

    // Bound the heaviest:lightest area ratio.
    //
    // A treemap's whole idea is area ∝ weight, but a file's DRAWN box is
    // roughly constant — it's a name plus padding — so raw line counts put a
    // 3-line file in a cell several times smaller than its own label while a
    // 3000-line neighbour gets acres. That's what made this layout read as a
    // pile of overlapping boxes. Flooring the weights keeps the ordering and
    // most of the proportionality while stopping the tail from collapsing.
    const rawWeights = project.files.map((f) => rawWeightOf(f.lineCount, f.sizeBytes));
    const heaviest = rawWeights.length > 0 ? Math.max(...rawWeights) : 1;
    const weightFloor = heaviest / contrast;
    const weightOf = (lines: number, bytes: number): number => Math.max(weightFloor, rawWeightOf(lines, bytes));

    // Build the folder tree. Each path segment becomes a folder node; the file
    // is a leaf carrying its weight.
    const root: Node = {weight: 0, children: new Map()};
    for (const f of project.files) {
        const dir = dirnameOf(f.relativePath);
        const segments = dir === "<root>" ? [] : dir.split("/");
        let cur = root;
        for (const seg of segments) {
            let next = cur.children.get(seg);
            if (!next) {
                next = {weight: 0, children: new Map()};
                cur.children.set(seg, next);
            }
            cur = next;
        }
        cur.children.set(f.id, {fileId: f.id, weight: weightOf(f.lineCount, f.sizeBytes), children: new Map()});
    }
    sumWeights(root);

    // Root rectangle sized so EVERY file's cell can hold that file's drawn box
    // plus `gap` of clear space. assignRigidPositions translates (no scaling)
    // onto the connectivity centroid afterwards.
    //
    // This used to be a flat `fileCount * 26000`, a guess with no knowledge of
    // how big a file actually renders. squarify hands each leaf an area of
    // `area * weight/total`, so the requirement per file is a minimum cell
    // area, and the root area is the largest of those solved for `area`.
    //
    // The minimum is `CELL_ASPECT_ALLOWANCE * longestSide²`, not `boxW * boxH`.
    // Enough AREA is not enough ROOM: squarify aims for square-ish cells but
    // still emits elongated ones, and a 300x20 cell has ample area for a 96x32
    // box while having nowhere to put it. Budgeting for the box's longest side
    // in either orientation is what actually stops neighbours touching —
    // area-only sizing still left overlapping pairs on this project.
    //
    // Files the sim hasn't measured yet fall back to a typical collapsed box.
    const CELL_ASPECT_ALLOWANCE = 2.5;
    const fileCount = Math.max(1, project.files.length);
    const totalWeight = project.files.reduce((s, f) => s + weightOf(f.lineCount, f.sizeBytes), 0) || 1;
    let area = fileCount * 26000;
    for (const f of project.files) {
        const n = shared.byId.get(f.id);
        const longest = Math.max((n?.collapsedW ?? 96) + gap, (n?.collapsedH ?? 32) + gap);
        const share = weightOf(f.lineCount, f.sizeBytes) / totalWeight;
        area = Math.max(area, (CELL_ASPECT_ALLOWANCE * longest * longest) / share);
    }
    const W = Math.sqrt(area * aspect);
    const H = area / W;

    const out: PositionMap = new Map();
    squarify(root, 0, 0, W, H, padding, out);
    return out;
}

function sumWeights(node: Node): number {
    if (node.fileId) return node.weight;
    let s = 0;
    for (const c of node.children.values()) s += sumWeights(c);
    node.weight = s;
    return s;
}

// Lay a node's children into [x,y,w,h] using the squarify heuristic (rows that
// keep cell aspect ratios near 1), then recurse into folder children.
function squarify(node: Node, x: number, y: number, w: number, h: number, pad: number, out: PositionMap): void {
    if (node.fileId) {
        out.set(node.fileId, {x: x + w / 2, y: y + h / 2});
        return;
    }
    const children = [...node.children.values()].filter((c) => c.weight > 0);
    if (children.length === 0) return;
    // Inner box after padding (folders only; the root pad applies too).
    const ix = x + pad;
    const iy = y + pad;
    const iw = Math.max(1, w - pad * 2);
    const ih = Math.max(1, h - pad * 2);

    const total = children.reduce((s, c) => s + c.weight, 0);
    const scale = (iw * ih) / total; // world-area per unit weight in this box
    // Sort big→small for better squarification.
    const items = children
        .map((c) => ({node: c, area: c.weight * scale}))
        .sort((a, b) => b.area - a.area);

    // Greedy squarify: fill rows along the SHORTER side of the remaining rect.
    let rx = ix;
    let ry = iy;
    let rw = iw;
    let rh = ih;
    let i = 0;
    while (i < items.length) {
        // Wide rect → stack this row's items DOWN the height (the shorter side),
        // the row's thickness consumed from the width. Tall rect → the mirror.
        const stackVertically = rw >= rh;
        const side = Math.max(1e-6, stackVertically ? rh : rw); // length items span
        // Grow the row while it improves the worst aspect ratio (always take the
        // first item; only later items can break the row).
        let rowEnd = i;
        let rowArea = 0;
        let bestWorst = Infinity;
        while (rowEnd < items.length) {
            const tryArea = rowArea + items[rowEnd].area;
            const worst = worstAspect(items, i, rowEnd + 1, tryArea, side);
            if (rowEnd > i && worst > bestWorst) break;
            bestWorst = worst;
            rowArea = tryArea;
            rowEnd++;
        }
        // Row thickness consumed from the longer side; items distributed over `side`.
        const thickness = rowArea / side;
        let off = 0;
        for (let k = i; k < rowEnd; k++) {
            const len = (items[k].area / rowArea) * side;
            let cx: number;
            let cy: number;
            let cw: number;
            let ch: number;
            if (stackVertically) {
                cx = rx;
                cy = ry + off;
                cw = thickness;
                ch = len;
            } else {
                cx = rx + off;
                cy = ry;
                cw = len;
                ch = thickness;
            }
            squarify(items[k].node, cx, cy, cw, ch, pad, out);
            off += len;
        }
        // Shrink the remaining rect by the row thickness along the longer side.
        if (stackVertically) {
            rx += thickness;
            rw -= thickness;
        } else {
            ry += thickness;
            rh -= thickness;
        }
        i = rowEnd;
    }
}

// Worst (max) aspect ratio of a candidate row of items[start..end) laid across
// `side`, given the row's total area. Lower is better (closer to squares).
function worstAspect(items: {area: number}[], start: number, end: number, rowArea: number, side: number): number {
    const thickness = rowArea / side;
    let worst = 1;
    for (let k = start; k < end; k++) {
        const len = (items[k].area / rowArea) * side;
        const ratio = Math.max(len / thickness, thickness / len);
        if (ratio > worst) worst = ratio;
    }
    return worst;
}

function num(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
