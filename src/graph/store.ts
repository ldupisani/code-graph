import { create } from 'zustand';
import type { FileAstResponse, GraphDelta, ProjectResponse } from '../api/types';

// Files the client just wrote itself (populated by EditorPane on save). The SSE
// delta flush in App.tsx consults this so a save's OWN watcher echo doesn't
// auto-select the file and re-frame the camera — which the edit-mode guard can
// no longer cover once "Save & exit" has left edit mode before the echo lands.
// Consumed (deleted) by the flush; a timeout sweeps any entry whose echo never
// arrives. A plain module Set, not store state — nothing renders off it.
export const selfSavedFileIds = new Set<string>();

// Which edge kinds the renderer should draw. The user toggles these
// via the EdgeFilterPills HUD; the renderer consults this set each
// frame and skips passes / individual edges accordingly. Default is
// "all on" — toggling off is a *lens* the user opts into.
export interface EdgeFilter {
  imports: boolean;
  calls: boolean;
  extends: boolean; // covers both 'extends' and 'implements' semantic edges
}

export interface GraphStore {
  project: ProjectResponse | null;
  // PRIMARY selection — the last-clicked id (file or AST node).
  // Drives single-target UI (source pane, focus mode, camera follow).
  selection: string | null;
  // Every currently-selected id. Always includes `selection` when
  // non-null. Plain click resets to {id}; Shift-click toggles a
  // single id. Drives the selection outline on every selected node;
  // `selection` is just "the last one." Selection-driven file
  // expansion (see PixiCanvas's syncExpansion) reads this set.
  selectionSet: ReadonlySet<string>;
  expandedFiles: ReadonlySet<string>;
  // AST node IDs the user has manually expanded. Today these are Block
  // nodes (the magenta sequential-code cells): a Block defaults to a
  // single collapsed cell, and clicking it adds the id here so the next
  // layout rebuild expands its contents. Clicking again removes the id
  // and re-collapses. See PixiCanvas.tsx — the layout's
  // `collapseChildren` predicate consults this set.
  expandedAstNodes: ReadonlySet<string>;
  // AST node IDs (JsxElement / JsxFragment overlays) whose live
  // Storybook view is toggled on — the eye handle (drawn only when the
  // enclosing component has stories) flips membership, and the
  // renderer's jsxStoryOverlay layer covers the node's rect with the
  // story iframe while the id is here AND the node is expanded.
  previewedAstNodes: ReadonlySet<string>;
  asts: ReadonlyMap<string, FileAstResponse>;
  edgeFilter: EdgeFilter;
  // Id of the rect under the cursor. React HUD components (e.g.
  // HoverTooltip) subscribe to this to know what to show. The
  // PixiCanvas renderer keeps its own closure-scoped copy too, so
  // per-frame label / outline brightening reads it cheaply without
  // going through React.
  hoveredId: string | null;
  // Screen-space rect of the hovered HitRect at the moment hover
  // began. Lets HoverTooltip anchor itself to the rect without
  // subscribing to per-frame camera updates. Stale if the user pans
  // while hovering — small UX cost, big complexity saving.
  hoveredScreenRect: { x: number; y: number; w: number; h: number } | null;
  // "Focus mode": when set, the renderer dims every file outside the
  // N-hop neighbourhood of the focused file (computed over the
  // currently-visible edges per edgeFilter). null = no focus, full
  // brightness everywhere. focusId follows selection by default but
  // is kept separate so future features (path tracing, multi-focus)
  // can drive it independently.
  focusId: string | null;
  focusHops: number;
  // BFS direction for focus mode:
  //   'both' — undirected (treat every edge both ways).
  //   'in'   — only follow edges INTO the focused node ('who calls
  //            this' / 'who imports this'). Answers the reverse-call
  //            question without the user needing to know the
  //            terminology — they just press R.
  //   'out'  — only follow edges OUT of the focused node ('what does
  //            this call / import').
  focusDirection: 'both' | 'in' | 'out';
  // Ordered list of file IDs that form a connecting path between
  // two user-selected nodes (via Shift-click). null means no path
  // is being traced. Renderer highlights every file in this list
  // and every edge whose endpoints are consecutive entries — even
  // through focus-mode dimming, since the path IS the user's
  // current question and should never disappear.
  tracedPath: readonly string[] | null;
  // When false, files matching the support-file pattern (.test /
  // .spec / .stories / __tests__/* / __mocks__/* for JS/TS, and
  // test_*.py / *_test.py / conftest.py / tests/* for Python) and
  // edges touching them aren't rendered. They're typically the
  // majority by count and dominate the visual without adding to the
  // architectural story.
  showSupportFiles: boolean;
  // Edit mode: when true, the Monaco pane for `editFileId` is editable and the
  // canvas single-key hotkeys yield to typing (see App.tsx onKey). Lives in the
  // graph store because both the global keydown handler and the SSE-delta flush
  // guard need to read it — the flush must NOT auto-select/re-frame when the
  // delta is the echo of the user's own save on the file they're editing.
  editMode: boolean;
  editFileId: string | null;
  // NOTE: the "isolate" direction toggles moved to useConfigStore
  // (config.behavioral.isolateImports / isolateExports) so they persist and
  // are captured by snapshots. The renderer reads them from there.
  setProject: (p: ProjectResponse | null) => void;
  refreshProject: (p: ProjectResponse) => void;
  // Merge an incremental filesystem delta (see GraphDelta) WITHOUT replacing
  // the whole project: patches only the changed file's node, the edges that
  // originate from the affected file set, and drops only the stale per-file
  // AST/selection state. projectId/rootPath are unchanged so the renderer
  // recognises it as the same project and reconciles in place.
  applyDelta: (delta: GraphDelta) => void;
  setSelection: (id: string | null) => void;
  // Multi-select: toggle a single id in selectionSet. If id is
  // already selected → remove it (primary clears when it was the
  // removed one). Otherwise → add it and make it the new primary.
  toggleSelection: (id: string) => void;
  // Additively select ids (no toggling-off): each id is added to the
  // selection set and the last becomes primary. Used when filesystem deltas
  // auto-select changed/added files — re-selecting an already-selected file
  // must keep it selected, which toggleSelection wouldn't.
  addSelection: (ids: readonly string[]) => void;
  // Plain-click on an AST node — like setSelection, but PRESERVES
  // any currently-selected FILES so a multi-file shift-select
  // survives drilling into one of those files. Replaces the AST
  // half of the selection (every id containing '#') with just
  // this id. File IDs are paths (no '#'); AST nodes are emitted
  // as `<fileId>#<n>`.
  selectAstNode: (id: string) => void;
  setFileAst: (fileId: string, ast: FileAstResponse) => void;
  expandFile: (fileId: string) => void;
  collapseFile: (fileId: string) => void;
  toggleAstNode: (id: string) => void;
  togglePreview: (id: string) => void;
  setEdgeFilter: (next: Partial<EdgeFilter>) => void;
  setHover: (
    id: string | null,
    screenRect: { x: number; y: number; w: number; h: number } | null,
  ) => void;
  setFocus: (id: string | null, hops?: number) => void;
  setFocusDirection: (d: 'both' | 'in' | 'out') => void;
  setTracedPath: (ids: readonly string[] | null) => void;
  setShowSupportFiles: (show: boolean) => void;
  enterEditMode: (fileId: string) => void;
  exitEditMode: () => void;
}

const ALL_EDGES_ON: EdgeFilter = { imports: true, calls: true, extends: true };

export const useGraphStore = create<GraphStore>((set) => ({
  project: null,
  selection: null,
  selectionSet: new Set<string>(),
  expandedFiles: new Set<string>(),
  expandedAstNodes: new Set<string>(),
  previewedAstNodes: new Set<string>(),
  asts: new Map<string, FileAstResponse>(),
  edgeFilter: { ...ALL_EDGES_ON },
  hoveredId: null,
  hoveredScreenRect: null,
  focusId: null,
  focusHops: 1,
  focusDirection: 'both',
  tracedPath: null,
  showSupportFiles: false,
  editMode: false,
  editFileId: null,
  setProject: (project) =>
    set((s) => ({
      project,
      selection: null,
      selectionSet: new Set(),
      expandedFiles: new Set(),
      expandedAstNodes: new Set(),
      previewedAstNodes: new Set(),
      asts: new Map(),
      edgeFilter: { ...ALL_EDGES_ON },
      focusId: null,
      focusHops: 1,
      focusDirection: 'both',
      tracedPath: null,
      // Keep the user's support-file preference across project
      // switches — it's a "how I like to look at code" setting,
      // not a per-project one.
      showSupportFiles: s.showSupportFiles,
      // A new project can't inherit an edit session from the old one.
      editMode: false,
      editFileId: null,
    })),
  // Used after a filesystem-driven re-walk: file-level identity is stable so
  // we keep expansion state, but AST node IDs may have shifted (sequential
  // walk) so we drop ASTs and selection — they'll be re-fetched on demand.
  // Likewise drop any per-block expansion state because the AST `#seq`
  // suffixes are no longer guaranteed to refer to the same nodes.
  refreshProject: (project) =>
    set((s) => ({
      project,
      selection: null,
      selectionSet: new Set(),
      asts: new Map(),
      expandedFiles: filterToKnownFiles(s.expandedFiles, project),
      expandedAstNodes: new Set(),
      previewedAstNodes: new Set(),
    })),
  applyDelta: (delta) =>
    set((s) => {
      if (!s.project) return s;
      const affected = new Set(delta.affectedFromFiles);
      const removedId = delta.kind === 'removed' ? delta.fileId : null;

      // --- Files ---------------------------------------------------------
      let files = s.project.files;
      if (removedId) {
        files = files.filter((f) => f.id !== removedId);
      } else if (delta.file) {
        const idx = files.findIndex((f) => f.id === delta.fileId);
        if (idx >= 0) {
          files = files.slice();
          files[idx] = delta.file;
        } else {
          files = [...files, delta.file];
        }
      }

      // --- Edges ---------------------------------------------------------
      // Drop every edge that ORIGINATES from an affected file (the server
      // recomputed those and sent replacements) plus, on removal, any edge
      // still pointing INTO the gone file. Then splice the new ones in.
      const edges = s.project.edges
        .filter((e) => !affected.has(e.fromId) && e.toId !== removedId)
        .concat(delta.imports);
      const semanticEdges = s.project.semanticEdges
        .filter(
          (e) =>
            !affected.has(astFileId(e.fromId)) &&
            (removedId == null || astFileId(e.toId) !== removedId),
        )
        .concat(delta.semanticEdges);

      // New object identity (same projectId/rootPath) so React subscribers
      // refresh; the renderer reconciles in place rather than rebuilding.
      const project = { ...s.project, files, edges, semanticEdges };

      // --- Per-file state invalidation -----------------------------------
      // Replace the changed file's cached AST with the fresh one shipped in the
      // delta (or drop it on removal). Replacing — rather than deleting and
      // re-fetching — lets an EXPANDED file update its contents in place,
      // staying expanded at its new size instead of collapsing while a fetch
      // round-trips.
      const asts = new Map(s.asts);
      if (delta.ast) asts.set(delta.fileId, delta.ast);
      else asts.delete(delta.fileId);

      // Only ids belonging to a REMOVED file are truly stale. We deliberately
      // KEEP the changed file's AST-node ids (block expansions, previews,
      // selections): node ids are `fileId#seq` (walk order), so for edits that
      // don't change the node COUNT they still point at the same nodes and the
      // user's expanded blocks stay open. An id that no longer matches simply
      // expands nothing — no crash, self-heals on the next edit/click. Pruning
      // them all (the old behaviour) made every block collapse on every save.
      const isStale = (id: string): boolean =>
        removedId != null && (id === removedId || astFileId(id) === removedId);
      const pruneSet = (set: ReadonlySet<string>): Set<string> => {
        const next = new Set<string>();
        for (const id of set) if (!isStale(id)) next.add(id);
        return next;
      };

      const selectionSet = pruneSet(s.selectionSet);
      const selection = s.selection && !isStale(s.selection) ? s.selection : null;
      const tracedPath = s.tracedPath?.some(isStale) ? null : s.tracedPath;

      // Keep the changed file EXPANDED (just drop a removed file). Because the
      // fresh AST is already in `asts` above, the renderer rebuilds its subtree
      // from new content on the next draw without ever collapsing it. (The
      // file's stale block-expansion / AST-node selection is pruned below — only
      // its inner drill-down resets, the file itself stays open.)
      return {
        project,
        asts,
        selection,
        selectionSet,
        expandedFiles: filterToKnownFiles(s.expandedFiles, project),
        expandedAstNodes: pruneSet(s.expandedAstNodes),
        previewedAstNodes: pruneSet(s.previewedAstNodes),
        tracedPath,
        focusId: s.focusId && isStale(s.focusId) ? null : s.focusId,
      };
    }),
  // Plain click: selection becomes JUST this id (or empty when null).
  setSelection: (selection) =>
    set({
      selection,
      selectionSet: selection ? new Set([selection]) : new Set(),
    }),
  toggleSelection: (id) =>
    set((s) => {
      const next = new Set(s.selectionSet);
      if (next.has(id)) {
        next.delete(id);
        // If the removed id was the primary, primary clears — the
        // remaining selected ids don't get auto-promoted (the user's
        // pointer of attention was the one they removed).
        return {
          selectionSet: next,
          selection: s.selection === id ? null : s.selection,
        };
      }
      next.add(id);
      return { selectionSet: next, selection: id };
    }),
  addSelection: (ids) =>
    set((s) => {
      if (ids.length === 0) return s;
      const next = new Set(s.selectionSet);
      for (const id of ids) next.add(id);
      return { selectionSet: next, selection: ids[ids.length - 1] };
    }),
  selectAstNode: (id) =>
    set((s) => {
      // Keep file selections, drop existing AST selections, add this one.
      const next = new Set<string>();
      for (const existing of s.selectionSet) {
        if (!existing.includes('#')) next.add(existing);
      }
      next.add(id);
      return { selectionSet: next, selection: id };
    }),
  setFileAst: (fileId, ast) =>
    set((s) => {
      const next = new Map(s.asts);
      next.set(fileId, ast);
      return { asts: next };
    }),
  expandFile: (fileId) =>
    set((s) => {
      if (s.expandedFiles.has(fileId)) return s;
      const next = new Set(s.expandedFiles);
      next.add(fileId);
      return { expandedFiles: next };
    }),
  collapseFile: (fileId) =>
    set((s) => {
      if (!s.expandedFiles.has(fileId)) return s;
      const next = new Set(s.expandedFiles);
      next.delete(fileId);
      return { expandedFiles: next };
    }),
  toggleAstNode: (id) =>
    set((s) => {
      const next = new Set(s.expandedAstNodes);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedAstNodes: next };
    }),
  togglePreview: (id) =>
    set((s) => {
      const next = new Set(s.previewedAstNodes);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { previewedAstNodes: next };
    }),
  setEdgeFilter: (next) =>
    set((s) => ({ edgeFilter: { ...s.edgeFilter, ...next } })),
  setHover: (hoveredId, hoveredScreenRect) =>
    set({ hoveredId, hoveredScreenRect }),
  setFocus: (focusId, hops) =>
    set((s) => ({
      focusId,
      // hops only updates when explicitly passed; clears to 1 on
      // focus-clear so the next focus starts from the default.
      focusHops: hops != null ? hops : focusId ? s.focusHops : 1,
      // Direction resets to 'both' when focus clears, so the next
      // click doesn't inherit a confusing direction setting from
      // before.
      focusDirection: focusId ? s.focusDirection : 'both',
    })),
  setFocusDirection: (focusDirection) => set({ focusDirection }),
  setTracedPath: (tracedPath) => set({ tracedPath }),
  setShowSupportFiles: (showSupportFiles) => set({ showSupportFiles }),
  enterEditMode: (editFileId) => set({ editMode: true, editFileId }),
  exitEditMode: () => set({ editMode: false, editFileId: null }),
}));

// Test / story / spec / __tests__ / __mocks__: typically the majority
// of files by count in a React project, but architecturally peripheral.
// Hidden by default; the EdgeFilterPills HUD has a toggle to surface
// them.
export function isSupportFile(relativePath: string): boolean {
  // JS/TS: .test / .spec / .stories files, __tests__ / __mocks__ dirs.
  if (/\.(test|spec|stories)\.[jt]sx?$/.test(relativePath)) return true;
  if (/(^|\/)__(tests|mocks)__\//.test(relativePath)) return true;
  // Python: pytest/unittest use a test_ prefix or _test suffix, a plain
  // tests/ (or test/) dir, and conftest.py for shared fixtures.
  if (/(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/.test(relativePath))
    return true;
  if (/(^|\/)tests?\//.test(relativePath)) return true;
  return false;
}

// Dev-only escape hatch: lets the chrome-devtools-mcp / browser console drive
// the app (e.g. `useGraphStore.getState().expandFile('src/index.ts')`) when a
// canvas-only click would be awkward. Stripped in production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { useGraphStore: typeof useGraphStore }).useGraphStore =
    useGraphStore;
}

// AST ids are `${fileId}#${seq}`; file ids are '#'-free relative paths, so the
// last '#' splits an endpoint back to its owning file. Mirrors the same helper
// on the server (server/project.ts) and in layout.ts.
function astFileId(astId: string): string {
  const i = astId.lastIndexOf('#');
  return i <= 0 ? astId : astId.slice(0, i);
}

function filterToKnownFiles(
  expanded: ReadonlySet<string>,
  project: ProjectResponse,
): Set<string> {
  const known = new Set(project.files.map((f) => f.id));
  const next = new Set<string>();
  for (const id of expanded) if (known.has(id)) next.add(id);
  return next;
}
