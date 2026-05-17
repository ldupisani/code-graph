import { create } from 'zustand';
import type { FileAstResponse, ProjectResponse } from '../api/types';

export interface GraphStore {
  project: ProjectResponse | null;
  selection: string | null; // node id (file or AST node)
  expandedFiles: ReadonlySet<string>;
  asts: ReadonlyMap<string, FileAstResponse>;
  setProject: (p: ProjectResponse | null) => void;
  refreshProject: (p: ProjectResponse) => void;
  setSelection: (id: string | null) => void;
  setFileAst: (fileId: string, ast: FileAstResponse) => void;
  expandFile: (fileId: string) => void;
  collapseFile: (fileId: string) => void;
}

export const useGraphStore = create<GraphStore>((set) => ({
  project: null,
  selection: null,
  expandedFiles: new Set<string>(),
  asts: new Map<string, FileAstResponse>(),
  setProject: (project) =>
    set({
      project,
      selection: null,
      expandedFiles: new Set(),
      asts: new Map(),
    }),
  // Used after a filesystem-driven re-walk: file-level identity is stable so
  // we keep expansion state, but AST node IDs may have shifted (sequential
  // walk) so we drop ASTs and selection — they'll be re-fetched on demand.
  refreshProject: (project) =>
    set((s) => ({
      project,
      selection: null,
      asts: new Map(),
      expandedFiles: filterToKnownFiles(s.expandedFiles, project),
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
}));

function filterToKnownFiles(
  expanded: ReadonlySet<string>,
  project: ProjectResponse,
): Set<string> {
  const known = new Set(project.files.map((f) => f.id));
  const next = new Set<string>();
  for (const id of expanded) if (known.has(id)) next.add(id);
  return next;
}
