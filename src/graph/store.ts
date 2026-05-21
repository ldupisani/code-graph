import { create } from 'zustand';
import type { FileAstResponse, ProjectResponse } from '../api/types';

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
  selection: string | null; // node id (file or AST node)
  expandedFiles: ReadonlySet<string>;
  // AST node IDs the user has manually expanded. Today these are Block
  // nodes (the magenta sequential-code cells): a Block defaults to a
  // single collapsed cell, and clicking it adds the id here so the next
  // layout rebuild expands its contents. Clicking again removes the id
  // and re-collapses. See PixiCanvas.tsx — the layout's
  // `collapseChildren` predicate consults this set.
  expandedAstNodes: ReadonlySet<string>;
  asts: ReadonlyMap<string, FileAstResponse>;
  edgeFilter: EdgeFilter;
  setProject: (p: ProjectResponse | null) => void;
  refreshProject: (p: ProjectResponse) => void;
  setSelection: (id: string | null) => void;
  setFileAst: (fileId: string, ast: FileAstResponse) => void;
  expandFile: (fileId: string) => void;
  collapseFile: (fileId: string) => void;
  toggleAstNode: (id: string) => void;
  setEdgeFilter: (next: Partial<EdgeFilter>) => void;
}

const ALL_EDGES_ON: EdgeFilter = { imports: true, calls: true, extends: true };

export const useGraphStore = create<GraphStore>((set) => ({
  project: null,
  selection: null,
  expandedFiles: new Set<string>(),
  expandedAstNodes: new Set<string>(),
  asts: new Map<string, FileAstResponse>(),
  edgeFilter: { ...ALL_EDGES_ON },
  setProject: (project) =>
    set({
      project,
      selection: null,
      expandedFiles: new Set(),
      expandedAstNodes: new Set(),
      asts: new Map(),
      edgeFilter: { ...ALL_EDGES_ON },
    }),
  // Used after a filesystem-driven re-walk: file-level identity is stable so
  // we keep expansion state, but AST node IDs may have shifted (sequential
  // walk) so we drop ASTs and selection — they'll be re-fetched on demand.
  // Likewise drop any per-block expansion state because the AST `#seq`
  // suffixes are no longer guaranteed to refer to the same nodes.
  refreshProject: (project) =>
    set((s) => ({
      project,
      selection: null,
      asts: new Map(),
      expandedFiles: filterToKnownFiles(s.expandedFiles, project),
      expandedAstNodes: new Set(),
    })),
  setSelection: (selection) => set({ selection }),
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
  setEdgeFilter: (next) =>
    set((s) => ({ edgeFilter: { ...s.edgeFilter, ...next } })),
}));

// Dev-only escape hatch: lets the chrome-devtools-mcp / browser console drive
// the app (e.g. `useGraphStore.getState().expandFile('src/index.ts')`) when a
// canvas-only click would be awkward. Stripped in production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { useGraphStore: typeof useGraphStore }).useGraphStore =
    useGraphStore;
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
