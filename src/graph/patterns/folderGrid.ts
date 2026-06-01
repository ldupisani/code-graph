import {computeRigidLayout, FOLDER_GRID_DEFAULTS, type FolderGridParams} from "../layout";
import {defaultsFromSpecs, type LayoutPattern, type ParamSpec} from "./types";

// Folder-hierarchy grid — the original deterministic layout. Each folder fills
// a wide grid; folders flow top→bottom down columns (a multi-column index),
// depth indents left→right, column count chosen to hit a target aspect ratio.
// A STATIC pattern: positions depend only on the file tree + params.

const PARAMS: readonly ParamSpec[] = [
    {key: "cellW", label: "Cell width", type: "number", default: FOLDER_GRID_DEFAULTS.cellW, min: 80, max: 600, step: 10, help: "File-cell width within a folder grid"},
    {key: "cellH", label: "Cell height", type: "number", default: FOLDER_GRID_DEFAULTS.cellH, min: 30, max: 240, step: 4, help: "File-cell height within a folder grid"},
    {key: "colW", label: "Depth indent", type: "number", default: FOLDER_GRID_DEFAULTS.colW, min: 0, max: 800, step: 20, help: "Left→right indent per folder-depth level"},
    {key: "bandGap", label: "Folder gap", type: "number", default: FOLDER_GRID_DEFAULTS.bandGap, min: 0, max: 400, step: 10, help: "Vertical gap between folders in a column"},
    {key: "columnGap", label: "Column gap", type: "number", default: FOLDER_GRID_DEFAULTS.columnGap, min: 0, max: 1200, step: 20, help: "Horizontal gap between folder columns"},
    {key: "targetAspect", label: "Aspect ratio", type: "number", default: FOLDER_GRID_DEFAULTS.targetAspect, min: 0.5, max: 4, step: 0.1, help: "Desired width : height of the whole layout"},
];

export const folderGridPattern: LayoutPattern = {
    id: "folder-grid",
    name: "Folder hierarchy grid",
    description: "Deterministic folder-outline grid; folders flow down columns, depth indents right.",
    kind: "static",
    params: PARAMS,
    defaults: () => defaultsFromSpecs(PARAMS),
    compute(project, params) {
        const p: FolderGridParams = {
            colW: num(params.colW, FOLDER_GRID_DEFAULTS.colW),
            cellW: num(params.cellW, FOLDER_GRID_DEFAULTS.cellW),
            cellH: num(params.cellH, FOLDER_GRID_DEFAULTS.cellH),
            bandGap: num(params.bandGap, FOLDER_GRID_DEFAULTS.bandGap),
            columnGap: num(params.columnGap, FOLDER_GRID_DEFAULTS.columnGap),
            targetAspect: num(params.targetAspect, FOLDER_GRID_DEFAULTS.targetAspect),
        };
        return {kind: "static", positions: computeRigidLayout(project, p)};
    },
};

function num(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
