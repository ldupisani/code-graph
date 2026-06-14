import type {TreemapLayout} from "../graph/treemap";

export interface HitRect {
    id: string;
    fileId: string;
    // 'ast-toggle' marks the small top-right handle drawn on every
    // expanded Block. It's a reliable click target for COLLAPSING the
    // Block — children inside the Block can otherwise fill the body
    // and steal every click. handleClick treats 'ast-toggle' the same
    // as clicking an empty Block area (toggles), and the cursor flips
    // to 'pointer' over it.
    //
    // 'folder' marks the directory-hull label (the `[src/components]`
    // text shown at the centre of each cluster). Carries the cluster
    // directory in `id`; `fileId` is unused for this kind. Used by
    // the drag-fork to grab every file under a folder at once.
    //
    // 'ast-preview' marks the eye handle drawn at the top-right of
    // expanded JSX overlays whose component has stories — clicking it
    // toggles the live Storybook view (see jsxStoryOverlay.ts). A
    // click router like 'ast-toggle': never a semantic anchor.
    kind: "file" | "ast" | "ast-toggle" | "ast-preview" | "folder";
    x: number;
    y: number;
    w: number;
    h: number;
    area: number;
}

export function smallestContaining(rects: HitRect[], wx: number, wy: number): HitRect | null {
    let best: HitRect | null = null;
    for (const r of rects) {
        if (wx < r.x || wx > r.x + r.w || wy < r.y || wy > r.y + r.h) continue;
        if (!best || r.area < best.area) best = r;
    }
    return best;
}

export function findVisibleAnchor(id: string, visibleById: Map<string, HitRect>, treeLookup: (fileId: string) => TreemapLayout | undefined): HitRect | null {
    const direct = visibleById.get(id);
    if (direct) return direct;
    const hashIdx = id.lastIndexOf("#");
    if (hashIdx <= 0) {
        // The id is a fileId already (no # suffix).
        return visibleById.get(id) ?? null;
    }
    const fileId = id.slice(0, hashIdx);
    const tree = treeLookup(fileId);
    if (tree) {
        let cur: string | null = id;
        // Walk the AST parent chain looking for a visible (LOD-survived) ancestor.
        while (cur) {
            const r = visibleById.get(cur);
            if (r) return r;
            cur = tree.byId.get(cur)?.parentId ?? null;
        }
    }
    // File not expanded, or no visible ancestor in the tree — anchor on the
    // collapsed file rect, which always renders.
    return visibleById.get(fileId) ?? null;
}
