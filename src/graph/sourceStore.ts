import {create} from "zustand";
import {getFileSource} from "../api/client";

// ---------------------------------------------------------------------------
// useSourceStore — shared cache of raw file source text, keyed by fileId
// (= relative path). The JSX wireframe previews (HoverTooltip + the
// node overlay layer) slice AstNode.start/end out of it to recover what
// the AST payload doesn't carry: attribute values and full expression
// text. Kept OUTSIDE useGraphStore so the hot selection/project store
// isn't churned by fetches, and as a store (not a module map) so React
// surfaces re-render when a fetch lands while imperative consumers read
// getState() per frame.
//
// `ensure` is fire-and-forget and idempotent: cached or in-flight files
// are no-ops, and a failed fetch is dropped silently — previews simply
// degrade to value-less attrs rather than erroring. Not persisted; the
// source of truth is one HTTP call away and goes stale with every edit.
// ---------------------------------------------------------------------------

interface SourceStore {
    sources: ReadonlyMap<string, string>;
    ensure: (projectId: string, fileId: string) => void;
    // Drop one file's cached source — called after a save so previews re-fetch
    // the new content instead of slicing offsets out of stale text.
    invalidate: (fileId: string) => void;
    // Drop everything — called on project switch / re-walk, where file
    // contents (and the offsets pointing into them) may have changed.
    clear: () => void;
}

const inFlight = new Set<string>();

export const useSourceStore = create<SourceStore>()((set, get) => ({
    sources: new Map(),

    ensure: (projectId, fileId) => {
        if (get().sources.has(fileId) || inFlight.has(fileId)) return;
        inFlight.add(fileId);
        void getFileSource(projectId, fileId)
            .then((text) => {
                set((s) => {
                    const next = new Map(s.sources);
                    next.set(fileId, text);
                    return {sources: next};
                });
            })
            .catch(() => {
                // Server gone / file vanished — stay silent; a later
                // ensure() may retry once this attempt is forgotten.
            })
            .finally(() => {
                inFlight.delete(fileId);
            });
    },

    invalidate: (fileId) =>
        set((s) => {
            if (!s.sources.has(fileId)) return s;
            const next = new Map(s.sources);
            next.delete(fileId);
            return {sources: next};
        }),

    clear: () => set({sources: new Map()}),
}));

// Dev-only console hook, mirroring useGraphStore / useConfigStore.
if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as {useSourceStore: typeof useSourceStore}).useSourceStore = useSourceStore;
}
