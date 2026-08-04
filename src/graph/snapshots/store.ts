import {create} from "zustand";
import {persist} from "zustand/middleware";
import type {GraphConfig} from "../config/types";

// ---------------------------------------------------------------------------
// useSnapshotStore — saved "views" the user can jump between. A snapshot
// captures the full view state (camera transform + the snapshot-worthy fields
// of useGraphStore) so restoring one reproduces where you were looking AND
// what was expanded / selected / filtered.
//
// Persisted to localStorage, keyed by project rootPath so each project keeps
// its own independent set. Mirrors useConfigStore's persist+merge idioms
// (src/graph/config/store.ts) — including a defensive merge so a corrupt blob
// can't crash hydrate.
//
// Kept SEPARATE from useGraphStore (the hot project/selection store): the
// capture/apply logic lives in ./capture.ts and reads/writes useGraphStore via
// getState()/setState(), so this store only ever holds plain serializable data.
// ---------------------------------------------------------------------------

// The view state a snapshot reproduces. Sets from useGraphStore are stored as
// arrays so the whole thing is JSON-serializable for persistence.
export interface SnapshotView {
    selection: string | null;
    selectionSet: string[];
    expandedFiles: string[];
    expandedAstNodes: string[];
    edgeFilter: {imports: boolean; calls: boolean; extends: boolean};
    focusId: string | null;
    focusHops: number;
    focusDirection: "both" | "in" | "out";
    tracedPath: string[] | null;
    showSupportFiles: boolean;
}

export interface Snapshot {
    id: string;
    // Custom label only. When unset, the UI shows a POSITIONAL default
    // ("View <slot>") computed from the snapshot's current index — so default
    // names always match the number badge / hotkey, and renumber automatically
    // when an earlier view is deleted. A user rename sets this; clearing it
    // reverts to the positional default.
    name?: string;
    view: SnapshotView;
    // Camera transform + content anchor (the file nearest the viewport centre
    // and its screen position). The anchor lets restore re-frame relative to
    // content — the force layout settles to different absolute coords each load,
    // so raw x/y alone would frame the wrong region after a reload.
    camera: {
        x: number;
        y: number;
        scale: number;
        anchorId?: string | null;
        anchorScreenX?: number;
        anchorScreenY?: number;
    };
    // User-pinned files (held in place against the force layout) and where they
    // sat. Optional: snapshots saved before pin capture existed simply omit it,
    // and applying one leaves the current pins untouched.
    pins?: {id: string; x: number; y: number}[];
    // The full GraphConfig in force when this view was saved — layout choice and
    // its params, theme, LOD, behavioral. A snapshot is meant to reproduce
    // EXACTLY what you were looking at, and half of "what it looked like" lives
    // in the config store rather than the graph store, so capturing only `view`
    // would restore the right selection into the wrong-looking graph.
    //
    // Sits beside `camera`/`pins` rather than inside `view` because `view` is
    // specifically the snapshot-worthy fields of useGraphStore; this comes from
    // useConfigStore. Optional for the same reason `pins` is: a snapshot saved
    // before this existed omits it, and applying one leaves the config alone.
    config?: GraphConfig;
}

export interface SnapshotStore {
    // rootPath -> ordered snapshots. The bar renders byProject[currentRootPath].
    byProject: Record<string, Snapshot[]>;
    // rootPath -> id of the view most recently jumped to or overwritten. The
    // bar highlights it ("the view you're on") and the overwrite hotkey
    // targets it. Saving a NEW snapshot clears it (see captureSnapshot) —
    // a fresh save isn't a view you navigated to, and the marker would go
    // stale as soon as the camera moves on. Persisted so the highlight
    // survives a reload.
    activeByProject: Record<string, string | null>;
    // Save a NEW snapshot for a project (no name unless given). Returns the id.
    add: (
        rootPath: string,
        snap: {view: SnapshotView; camera: Snapshot["camera"]; pins?: Snapshot["pins"]; config?: Snapshot["config"]; name?: string},
    ) => string;
    // Overwrite an existing snapshot's captured state (view/camera/pins/config)
    // in place, keeping its id and name.
    update: (
        rootPath: string,
        id: string,
        snap: {view: SnapshotView; camera: Snapshot["camera"]; pins?: Snapshot["pins"]; config?: Snapshot["config"]},
    ) => void;
    // Mark which snapshot is "active" (last saved / applied). null clears it.
    setActive: (rootPath: string, id: string | null) => void;
    remove: (rootPath: string, id: string) => void;
    rename: (rootPath: string, id: string, name: string) => void;
    // Move a snapshot one slot earlier (-1) or later (+1) in its project list.
    reorder: (rootPath: string, id: string, dir: -1 | 1) => void;
}

// Ids must be unique across SESSIONS, not just within one: snapshots persist
// to localStorage but a module counter resets on reload, so a counter-only id
// eventually collides with a persisted snapshot — and two chips sharing an id
// BOTH render as "active". Time + random needs no cross-session coordination.
function uid(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSnapshotStore = create<SnapshotStore>()(
    persist(
        (set) => ({
            byProject: {},
            activeByProject: {},

            add: (rootPath, snap) => {
                const id = uid("snap");
                set((s) => {
                    const list = s.byProject[rootPath] ?? [];
                    // No auto "View N" stored — the UI derives a positional
                    // default so it stays correct after deletions. Only a
                    // caller-supplied custom name is persisted.
                    const name = snap.name?.trim() || undefined;
                    return {
                        byProject: {
                            ...s.byProject,
                            [rootPath]: [...list, {id, name, view: snap.view, camera: snap.camera, pins: snap.pins, config: snap.config}],
                        },
                    };
                });
                return id;
            },
            update: (rootPath, id, snap) =>
                set((s) => {
                    const list = s.byProject[rootPath];
                    if (!list) return s;
                    return {
                        byProject: {
                            ...s.byProject,
                            [rootPath]: list.map((x) => (x.id === id ? {...x, view: snap.view, camera: snap.camera, pins: snap.pins, config: snap.config} : x)),
                        },
                    };
                }),
            setActive: (rootPath, id) => set((s) => ({activeByProject: {...s.activeByProject, [rootPath]: id}})),
            remove: (rootPath, id) =>
                set((s) => {
                    const list = s.byProject[rootPath];
                    if (!list) return s;
                    const active = s.activeByProject[rootPath];
                    return {
                        byProject: {...s.byProject, [rootPath]: list.filter((x) => x.id !== id)},
                        // Drop the active marker when the active view is deleted.
                        activeByProject: active === id ? {...s.activeByProject, [rootPath]: null} : s.activeByProject,
                    };
                }),
            rename: (rootPath, id, name) =>
                set((s) => {
                    const list = s.byProject[rootPath];
                    if (!list) return s;
                    return {
                        byProject: {
                            ...s.byProject,
                            // Empty name reverts to the positional default.
                            [rootPath]: list.map((x) => (x.id === id ? {...x, name: name.trim() || undefined} : x)),
                        },
                    };
                }),
            reorder: (rootPath, id, dir) =>
                set((s) => {
                    const list = s.byProject[rootPath];
                    if (!list) return s;
                    const next = list.slice();
                    const i = next.findIndex((x) => x.id === id);
                    const j = i + dir;
                    if (i < 0 || j < 0 || j >= next.length) return s;
                    [next[i], next[j]] = [next[j], next[i]];
                    return {byProject: {...s.byProject, [rootPath]: next}};
                }),
        }),
        {
            name: "code-graph:snapshots",
            version: 1,
            partialize: (s) => ({byProject: s.byProject, activeByProject: s.activeByProject}),
            // Tolerate a corrupt / foreign persisted blob: coerce the maps to
            // plain objects so a bad value can't crash hydrate (mirrors the
            // defensive merge in useConfigStore).
            merge: (persisted, current) => {
                const p = (persisted ?? {}) as Partial<SnapshotStore>;
                const byProject = p.byProject && typeof p.byProject === "object" ? p.byProject : {};
                const activeByProject = p.activeByProject && typeof p.activeByProject === "object" ? p.activeByProject : {};
                // Heal duplicate ids minted by the old counter-based uid()
                // (the counter reset on reload, so a later session could
                // re-mint an existing id): the FIRST occurrence keeps the
                // id — and any active marker pointing at it — later
                // duplicates get fresh ids.
                for (const [root, list] of Object.entries(byProject)) {
                    if (!Array.isArray(list)) continue;
                    const seen = new Set<string>();
                    byProject[root] = list.map((snap) => {
                        if (!seen.has(snap.id)) {
                            seen.add(snap.id);
                            return snap;
                        }
                        return {...snap, id: uid("snap")};
                    });
                }
                return {...current, byProject, activeByProject};
            },
        },
    ),
);

// Dev-only console hook, mirroring useGraphStore / useConfigStore.
if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as {useSnapshotStore: typeof useSnapshotStore}).useSnapshotStore = useSnapshotStore;
}
