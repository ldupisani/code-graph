import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  FileAstResponse,
  FileNode,
  GraphDelta,
  ImportEdge,
  ProjectResponse,
  SemanticEdge,
} from '../src/api/types';
import { detectLanguage, type Language, type LanguageAnalyzer } from './analyzer';
import { TypeScriptAnalyzer } from './typescript-analyzer';
import { PythonAnalyzer } from './python-analyzer';
import { createProjectWatcher, type ProjectWatcher, type WatchEvent } from './watcher';

export interface LoadedProject {
  rootPath: string;
  language: Language;
  // The tsconfig used — TypeScript projects only.
  tsConfigPath?: string;
  // The language engine; all parsing/edge work delegates here.
  analyzer: LanguageAnalyzer;
  watcher: ProjectWatcher;
  // --- Authoritative caches served to the client + spliced by deltas ------
  asts: Map<string, FileAstResponse>;
  files: Map<string, FileNode>;
  importEdges: ImportEdge[];
  semanticEdges: SemanticEdge[];
}

const projects = new Map<string, LoadedProject>();

export async function openProject(rawPath: string): Promise<ProjectResponse> {
  const rootPath = path.resolve(rawPath);
  if (!existsSync(rootPath)) {
    throw new Error(`Path does not exist: ${rootPath}`);
  }

  const language = detectLanguage(rootPath);
  const analyzer: LanguageAnalyzer =
    language === 'python'
      ? new PythonAnalyzer(rootPath)
      : new TypeScriptAnalyzer(rootPath);

  let opened;
  try {
    opened = await analyzer.open();
  } catch (e) {
    await analyzer.close();
    throw e;
  }
  const { files, asts, importEdges, semanticEdges } = opened;

  // Reopening the same path retires the previous LoadedProject — closes the
  // analyzer (and any subprocess) + the watcher so memory/processes don't grow
  // per click.
  for (const [id, prior] of projects) {
    if (prior.rootPath === rootPath) {
      await prior.analyzer.close();
      prior.watcher.close();
      projects.delete(id);
    }
  }

  const tsConfigPath =
    analyzer instanceof TypeScriptAnalyzer ? analyzer.tsConfigPath : undefined;
  const watcher = createProjectWatcher(rootPath, (p) => analyzer.watches(p));
  const projectId = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  projects.set(projectId, {
    rootPath,
    language,
    tsConfigPath,
    analyzer,
    watcher,
    asts,
    files: new Map(files.map((f) => [f.id, f])),
    importEdges,
    semanticEdges,
  });

  return {
    projectId,
    rootPath,
    language,
    tsConfigPath,
    files,
    edges: importEdges,
    semanticEdges,
  };
}

export function getLoadedProject(projectId: string): LoadedProject | undefined {
  return projects.get(projectId);
}

export function getCachedAst(
  loaded: LoadedProject,
  fileId: string,
): FileAstResponse | undefined {
  return loaded.asts.get(fileId);
}

// Apply a single filesystem event to a loaded project IN PLACE, re-walking
// only the changed file and recomputing only the edges that can touch it, and
// return the GraphDelta the client merges. Returns null when there's nothing
// to send (e.g. an 'added' event for a path that already vanished).
//
// Why the edge work stays bounded: an edge can only involve the changed file
// if it ORIGINATES from that file or from a file that imports it (cross-file
// references require an import). So we recompute outgoing edges for exactly
// `affected = {fileId} ∪ importers(fileId)` and leave every other file's edges
// untouched. See GraphDelta in src/api/types.ts.
export async function applyFileEvent(
  loaded: LoadedProject,
  event: WatchEvent,
): Promise<GraphDelta | null> {
  const { kind, fileId } = event;

  // Importers known from the CURRENT graph (before any mutation). For a
  // removed file this is the only chance to learn who pointed at it.
  const affected = new Set<string>([fileId]);
  for (const id of await loaded.analyzer.importersOf(fileId)) affected.add(id);

  if (kind === 'removed') {
    await loaded.analyzer.applyChange('removed', fileId);
    loaded.asts.delete(fileId);
    loaded.files.delete(fileId);
    // The file's own outgoing edges go away with it; recompute the importers'
    // edges (which drops their now-dangling edges into the file). Pass the
    // removed id so any stragglers pointing INTO it are swept too.
    affected.delete(fileId);
    const recomputed = await recomputeEdges(loaded, affected, fileId);
    return {
      kind,
      fileId,
      affectedFromFiles: [...affected, fileId],
      imports: recomputed.imports,
      semanticEdges: recomputed.semanticEdges,
    };
  }

  // changed | added
  const update = await loaded.analyzer.applyChange(kind, fileId);
  if (!update.file || !update.ast) return null; // vanished / untracked

  loaded.files.set(fileId, update.file);
  loaded.asts.set(fileId, update.ast);
  // A brand-new file may satisfy import specifiers in existing files that
  // previously didn't resolve — re-scan importers now that it exists.
  for (const id of await loaded.analyzer.importersOf(fileId)) affected.add(id);
  const recomputed = await recomputeEdges(loaded, affected, null);
  return {
    kind,
    fileId,
    file: update.file,
    // Ship the fresh AST inline so an expanded file updates in place rather
    // than collapsing while the client re-fetches it.
    ast: update.ast,
    affectedFromFiles: [...affected],
    imports: recomputed.imports,
    semanticEdges: recomputed.semanticEdges,
  };
}

// Replace the edges originating from `affected` source files (and, for a
// removal, any edge still pointing into `removedFileId`) with freshly computed
// ones. Mutates loaded.importEdges / loaded.semanticEdges and returns just the
// newly computed edges for the delta payload.
async function recomputeEdges(
  loaded: LoadedProject,
  affected: ReadonlySet<string>,
  removedFileId: string | null,
): Promise<{ imports: ImportEdge[]; semanticEdges: SemanticEdge[] }> {
  loaded.importEdges = loaded.importEdges.filter(
    (e) => !affected.has(e.fromId) && e.toId !== removedFileId,
  );
  loaded.semanticEdges = loaded.semanticEdges.filter(
    (e) =>
      !affected.has(astFileId(e.fromId)) &&
      (removedFileId == null || astFileId(e.toId) !== removedFileId),
  );

  const { imports, semanticEdges } = await loaded.analyzer.buildEdges(affected);
  loaded.importEdges.push(...imports);
  loaded.semanticEdges.push(...semanticEdges);
  return { imports, semanticEdges };
}

// AST ids are `${fileId}#${seq}`; file ids are '#'-free relative paths, so the
// last '#' splits an endpoint back to its owning file.
function astFileId(astId: string): string {
  const i = astId.lastIndexOf('#');
  return i <= 0 ? astId : astId.slice(0, i);
}
