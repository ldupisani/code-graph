import { existsSync } from 'node:fs';
import path from 'node:path';
import { Project, ts, type Node, type SourceFile } from 'ts-morph';
import type {
  FileAstResponse,
  FileNode,
  GraphDelta,
  ImportEdge,
  ProjectResponse,
  SemanticEdge,
} from '../src/api/types';
import { extractAst } from './ast-extractor';
import { buildSemanticEdges } from './semantic-edges';
import { createProjectWatcher, type ProjectWatcher, type WatchEvent } from './watcher';

export interface LoadedProject {
  rootPath: string;
  tsConfigPath: string;
  project: Project;
  // AST-level data computed eagerly at open time and patched per-file by
  // applyFileEvent on filesystem changes.
  asts: Map<string, FileAstResponse>;
  semanticEdges: SemanticEdge[];
  watcher: ProjectWatcher;
  // --- Incremental-update bookkeeping ------------------------------------
  // The current file nodes, keyed by fileId, kept in sync so a delta can
  // hand the client the changed file's fresh size/lineCount.
  files: Map<string, FileNode>;
  // File-level import edges, persisted so a delta can splice rather than
  // recompute the whole set.
  importEdges: ImportEdge[];
  // Global Node→AST-id map, shared across files so cross-file edge
  // resolution (a call in A → a decl in B) can look up B's ids. Patched
  // per-file: a file's entries are purged (via nodesByFile) and rebuilt
  // when that file is re-walked.
  idByNode: Map<Node, string>;
  // fileId → the Node objects that contributed idByNode entries, so a
  // re-walk can purge exactly that file's stale entries.
  nodesByFile: Map<string, Node[]>;
}

const projects = new Map<string, LoadedProject>();

export async function openProject(rawPath: string): Promise<ProjectResponse> {
  const rootPath = path.resolve(rawPath);
  if (!existsSync(rootPath)) {
    throw new Error(`Path does not exist: ${rootPath}`);
  }

  const tsConfigPath = path.join(rootPath, 'tsconfig.json');
  if (!existsSync(tsConfigPath)) {
    throw new Error(
      `No tsconfig.json found at ${tsConfigPath}. Only TypeScript projects with a tsconfig at the root are supported.`,
    );
  }

  const project = new Project({ tsConfigFilePath: tsConfigPath });
  let sourceFiles = project.getSourceFiles();
  // Solution-style tsconfig (e.g. { "files": [], "references": [...] }):
  // ts-morph doesn't follow project references, so the root config yields no
  // files. Pull sources from each referenced config directly. ts.readConfigFile
  // tolerates comments (JSONC) in the tsconfig.
  if (sourceFiles.length === 0) {
    const parsed = ts.readConfigFile(tsConfigPath, ts.sys.readFile).config as
      | { references?: { path?: string }[] }
      | undefined;
    for (const ref of parsed?.references ?? []) {
      if (typeof ref.path !== 'string') continue;
      const refResolved = path.resolve(rootPath, ref.path);
      const refTsConfig = refResolved.endsWith('.json')
        ? refResolved
        : path.join(refResolved, 'tsconfig.json');
      if (!existsSync(refTsConfig)) continue;
      try {
        project.addSourceFilesFromTsConfig(refTsConfig);
      } catch {
        // Skip a malformed/unreadable referenced config rather than failing.
      }
    }
    sourceFiles = project.getSourceFiles();
  }

  const files: FileNode[] = sourceFiles.map((sf) => buildFileNode(sf, rootPath));
  const fileIdByAbs = new Map(files.map((f) => [f.absolutePath, f.id]));

  // Walk every source file once. The map of (ts-morph Node → AstNode id) is
  // shared across files so the semantic-edge pass can resolve cross-file
  // declarations to the right id — and so the import-edge pass below can
  // tag each edge with its owning ImportDeclaration AST node.
  const asts = new Map<string, FileAstResponse>();
  const idByNode = new Map<Node, string>();
  const nodesByFile = new Map<string, Node[]>();
  for (const sf of sourceFiles) {
    const fileId = fileIdByAbs.get(sf.getFilePath());
    if (!fileId) continue;
    const result = extractAst(sf, fileId);
    asts.set(fileId, result.response);
    const fileNodes: Node[] = [];
    for (const [node, id] of result.idByNode) {
      idByNode.set(node, id);
      fileNodes.push(node);
    }
    nodesByFile.set(fileId, fileNodes);
  }

  // Import edges are built AFTER AST extraction so each can be stamped with
  // the AST id of the ImportDeclaration it originated from. That id lets the
  // renderer anchor import lines on the specific block when the source file
  // is expanded.
  const edges = buildImportEdges(sourceFiles, fileIdByAbs, idByNode);

  const semanticEdges = buildSemanticEdges(sourceFiles, idByNode);

  // Reopening the same path retires the previous LoadedProject — closes the
  // chokidar watcher and drops references so memory doesn't grow per click.
  for (const [id, prior] of projects) {
    if (prior.rootPath === rootPath) {
      prior.watcher.close();
      projects.delete(id);
    }
  }

  const watcher = createProjectWatcher(rootPath);
  const projectId = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  projects.set(projectId, {
    rootPath,
    tsConfigPath,
    project,
    asts,
    semanticEdges,
    watcher,
    files: new Map(files.map((f) => [f.id, f])),
    importEdges: edges,
    idByNode,
    nodesByFile,
  });

  return {
    projectId,
    rootPath,
    tsConfigPath,
    files,
    edges,
    semanticEdges,
  };
}

export function getLoadedProject(projectId: string): LoadedProject | undefined {
  return projects.get(projectId);
}

export function findSourceFile(loaded: LoadedProject, fileId: string): SourceFile | undefined {
  for (const sf of loaded.project.getSourceFiles()) {
    if (relativeFileId(sf, loaded.rootPath) === fileId) return sf;
  }
  return undefined;
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
export function applyFileEvent(
  loaded: LoadedProject,
  event: WatchEvent,
): GraphDelta | null {
  const { kind, fileId } = event;
  const absPath = path.join(loaded.rootPath, fileId);

  // Importers known from the CURRENT graph (before any mutation). For a
  // removed file this is the only chance to learn who pointed at it.
  const affected = new Set<string>([fileId]);
  for (const id of importersOf(loaded, fileId)) affected.add(id);

  if (kind === 'removed') {
    const sf = findSourceFile(loaded, fileId);
    if (sf) loaded.project.removeSourceFile(sf);
    purgeFile(loaded, fileId);
    loaded.files.delete(fileId);
    // The file's own outgoing edges go away with it; recompute the importers'
    // edges (which drops their now-dangling edges into the file). Pass the
    // removed id so any stragglers pointing INTO it are swept too.
    affected.delete(fileId);
    const recomputed = recomputeEdges(loaded, affected, fileId);
    return {
      kind,
      fileId,
      affectedFromFiles: [...affected, fileId],
      imports: recomputed.imports,
      semanticEdges: recomputed.semanticEdges,
    };
  }

  // changed | added
  let sf = findSourceFile(loaded, fileId);
  if (!sf) {
    if (!existsSync(absPath)) return null;
    sf = loaded.project.addSourceFileAtPath(absPath);
    // A brand-new file may satisfy import specifiers in existing files that
    // previously didn't resolve — re-scan importers now that it exists.
    for (const id of importersOf(loaded, fileId)) affected.add(id);
  } else {
    sf.refreshFromFileSystemSync();
  }

  walkFile(loaded, sf, fileId);
  const file = buildFileNode(sf, loaded.rootPath);
  loaded.files.set(fileId, file);
  const recomputed = recomputeEdges(loaded, affected, null);
  return {
    kind,
    fileId,
    file,
    // Ship the fresh AST inline so an expanded file updates in place rather
    // than collapsing while the client re-fetches it (walkFile just cached it).
    ast: loaded.asts.get(fileId),
    affectedFromFiles: [...affected],
    imports: recomputed.imports,
    semanticEdges: recomputed.semanticEdges,
  };
}

// Re-extract a single file's AST and refresh its slice of the shared idByNode
// map (stale entries purged first, fresh ones merged in).
function walkFile(loaded: LoadedProject, sf: SourceFile, fileId: string): void {
  purgeFile(loaded, fileId);
  const result = extractAst(sf, fileId);
  loaded.asts.set(fileId, result.response);
  const fileNodes: Node[] = [];
  for (const [node, id] of result.idByNode) {
    loaded.idByNode.set(node, id);
    fileNodes.push(node);
  }
  loaded.nodesByFile.set(fileId, fileNodes);
}

// Drop everything the shared maps hold for one file: its idByNode entries
// (keyed by the now-dead Node objects) and its cached AST.
function purgeFile(loaded: LoadedProject, fileId: string): void {
  const nodes = loaded.nodesByFile.get(fileId);
  if (nodes) for (const n of nodes) loaded.idByNode.delete(n);
  loaded.nodesByFile.delete(fileId);
  loaded.asts.delete(fileId);
}

// Replace the edges originating from `affected` source files (and, for a
// removal, any edge still pointing into `removedFileId`) with freshly computed
// ones. Mutates loaded.importEdges / loaded.semanticEdges and returns just the
// newly computed edges for the delta payload.
function recomputeEdges(
  loaded: LoadedProject,
  affected: ReadonlySet<string>,
  removedFileId: string | null,
): { imports: ImportEdge[]; semanticEdges: SemanticEdge[] } {
  loaded.importEdges = loaded.importEdges.filter(
    (e) => !affected.has(e.fromId) && e.toId !== removedFileId,
  );
  loaded.semanticEdges = loaded.semanticEdges.filter(
    (e) =>
      !affected.has(astFileId(e.fromId)) &&
      (removedFileId == null || astFileId(e.toId) !== removedFileId),
  );

  const fileIdByAbs = currentFileIdByAbs(loaded);
  const affectedSf = loaded.project.getSourceFiles().filter((sf) => {
    const id = fileIdByAbs.get(sf.getFilePath());
    return id != null && affected.has(id);
  });
  const imports = buildImportEdges(affectedSf, fileIdByAbs, loaded.idByNode);
  const semanticEdges = buildSemanticEdges(affectedSf, loaded.idByNode);
  loaded.importEdges.push(...imports);
  loaded.semanticEdges.push(...semanticEdges);
  return { imports, semanticEdges };
}

// Files that import `fileId` (its consumers). Computed by scanning every
// source file's import declarations and resolving their module specifiers —
// this catches both existing importers and ones whose specifier only resolves
// once a newly-added file exists.
function importersOf(loaded: LoadedProject, fileId: string): string[] {
  const fileIdByAbs = currentFileIdByAbs(loaded);
  const out: string[] = [];
  for (const sf of loaded.project.getSourceFiles()) {
    const fromId = fileIdByAbs.get(sf.getFilePath());
    if (!fromId || fromId === fileId) continue;
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (target && fileIdByAbs.get(target.getFilePath()) === fileId) {
        out.push(fromId);
        break;
      }
    }
  }
  return out;
}

function currentFileIdByAbs(loaded: LoadedProject): Map<string, string> {
  const m = new Map<string, string>();
  for (const sf of loaded.project.getSourceFiles()) {
    m.set(sf.getFilePath(), relativeFileId(sf, loaded.rootPath));
  }
  return m;
}

// AST ids are `${fileId}#${seq}`; file ids are '#'-free relative paths, so the
// last '#' splits an endpoint back to its owning file.
function astFileId(astId: string): string {
  const i = astId.lastIndexOf('#');
  return i <= 0 ? astId : astId.slice(0, i);
}

function relativeFileId(sf: SourceFile, rootPath: string): string {
  return path.relative(rootPath, sf.getFilePath()).replace(/\\/g, '/');
}

function buildFileNode(sf: SourceFile, rootPath: string): FileNode {
  const absolutePath = sf.getFilePath();
  const text = sf.getFullText();
  return {
    id: fileIdFromPath(absolutePath, rootPath),
    kind: 'file',
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, '/'),
    absolutePath,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    lineCount: countLines(text),
  };
}

function buildImportEdges(
  sourceFiles: readonly SourceFile[],
  fileIdByAbs: Map<string, string>,
  idByNode: ReadonlyMap<Node, string>,
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const sf of sourceFiles) {
    const fromId = fileIdByAbs.get(sf.getFilePath());
    if (!fromId) continue;
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue;
      const toId = fileIdByAbs.get(target.getFilePath());
      if (!toId) continue;
      edges.push({
        id: `${fromId}->${toId}@${imp.getStart()}`,
        kind: 'imports',
        fromId,
        toId,
        fromAstNodeId: idByNode.get(imp),
      });
    }
  }
  return edges;
}

function fileIdFromPath(absPath: string, rootPath: string): string {
  return path.relative(rootPath, absPath).replace(/\\/g, '/');
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
