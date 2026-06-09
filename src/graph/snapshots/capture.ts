import type {CameraApi} from "../../render/PixiCanvas";
import {type GraphStore, useGraphStore} from "../store";
import {type Snapshot, type SnapshotView, useSnapshotStore} from "./store";

// Capture/apply bridge the plain-data snapshot store and the live view (the hot
// useGraphStore + the imperative camera). Kept as pure functions so the
// SnapshotBar buttons and the App keyboard shortcuts share one code path.

// Snapshot the snapshot-worthy fields of the live graph store (Sets → arrays for
// JSON; rebuilt with `new Set(...)` on apply).
function buildView(st: GraphStore): SnapshotView {
    return {
        selection: st.selection,
        selectionSet: [...st.selectionSet],
        expandedFiles: [...st.expandedFiles],
        expandedAstNodes: [...st.expandedAstNodes],
        edgeFilter: {...st.edgeFilter},
        focusId: st.focusId,
        focusHops: st.focusHops,
        focusDirection: st.focusDirection,
        tracedPath: st.tracedPath ? [...st.tracedPath] : null,
        showSupportFiles: st.showSupportFiles,
    };
}

// Save the current view as a NEW snapshot and make it the active one. No-op
// (returns null) when there's no project or the camera handle isn't ready yet.
export function captureSnapshot(api: CameraApi | null): string | null {
    const st = useGraphStore.getState();
    if (!st.project || !api) return null;
    const ss = useSnapshotStore.getState();
    const id = ss.add(st.project.rootPath, {view: buildView(st), camera: api.getCamera(), pins: api.getPins()});
    ss.setActive(st.project.rootPath, id);
    return id;
}

// Overwrite an existing snapshot with the current view (keeps id + name) and
// make it active. Used to "update the view you're on."
export function overwriteSnapshot(id: string, api: CameraApi | null): void {
    const st = useGraphStore.getState();
    if (!st.project || !api) return;
    const ss = useSnapshotStore.getState();
    ss.update(st.project.rootPath, id, {view: buildView(st), camera: api.getCamera(), pins: api.getPins()});
    ss.setActive(st.project.rootPath, id);
}

// Restore a snapshot: write the view state, then move the camera.
//
// We write via setState (not the individual store actions) deliberately: the
// store has no bulk setters for expandedFiles / expandedAstNodes / selectionSet,
// and setFocus carries reset logic that would drop a saved focusDirection.
// setState is the same idiom those actions use internally.
//
// Order doesn't matter for correctness — the renderer's per-frame syncExpansion
// picks up the new expanded sets next tick, and camera coords are world-space
// stable (independent of what's expanded). Stale ids from an older persisted
// snapshot are harmless: the layout simply never matches an absent id and the
// SelectionPanel renders nothing for an unknown selection.
export function applySnapshot(snap: Snapshot, api: CameraApi | null): void {
    const v = snap.view;
    useGraphStore.setState({
        selection: v.selection,
        selectionSet: new Set(v.selectionSet),
        // NOTE: expandedFiles is deliberately NOT restored. It's entirely
        // derived from selectionSet × zoom by the renderer's syncExpansion (the
        // only thing that mutates it). Restoring it directly to the value
        // syncExpansion would compute makes syncExpansion's want===current
        // early-return fire, so it never runs expandFileForSelection — the AST
        // is never fetched and the file never visually expands. Leaving the live
        // expandedFiles in place lets syncExpansion diff it against the restored
        // selection and do the real collapse-old / expand-new work.
        expandedAstNodes: new Set(v.expandedAstNodes),
        edgeFilter: {...v.edgeFilter},
        focusId: v.focusId,
        focusHops: v.focusHops,
        focusDirection: v.focusDirection,
        tracedPath: v.tracedPath ? [...v.tracedPath] : null,
        showSupportFiles: v.showSupportFiles,
    });
    // Restore pins only when the snapshot recorded them — an older snapshot
    // without the field leaves the current pins untouched rather than clearing.
    if (snap.pins) api?.setPins(snap.pins);
    api?.setCamera(snap.camera, {animate: true});
    // This is now the view we're "on" — highlight it in the bar.
    const root = useGraphStore.getState().project?.rootPath;
    if (root) useSnapshotStore.getState().setActive(root, snap.id);
}
