import { existsSync } from 'node:fs';
import path from 'node:path';
import { Project, type Node, type SourceFile } from 'ts-morph';
import type {
  FileAstResponse,
  FileNode,
  ImportEdge,
  ProjectResponse,
  SemanticEdge,
} from '../src/api/types';
import { extractAst } from './ast-extractor';
import { buildSemanticEdges } from './semantic-edges';
import { createProjectWatcher, type ProjectWatcher } from './watcher';

export interface LoadedProject {
  rootPath: string;
  tsConfigPath: string;
  project: Project;
  // AST-level data computed eagerly at open time.
  asts: Map<string, FileAstResponse>;
  semanticEdges: SemanticEdge[];
  watcher: ProjectWatcher;
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
  const sourceFiles = project.getSourceFiles();

  const files: FileNode[] = sourceFiles.map((sf) => buildFileNode(sf, rootPath));
  const fileIdByAbs = new Map(files.map((f) => [f.absolutePath, f.id]));
  const edges = buildImportEdges(sourceFiles, fileIdByAbs);

  // Walk every source file once. The map of (ts-morph Node → AstNode id) is
  // shared across files so the semantic-edge pass can resolve cross-file
  // declarations to the right id.
  const asts = new Map<string, FileAstResponse>();
  const idByNode = new Map<Node, string>();
  for (const sf of sourceFiles) {
    const fileId = fileIdByAbs.get(sf.getFilePath());
    if (!fileId) continue;
    const result = extractAst(sf, fileId);
    asts.set(fileId, result.response);
    for (const [node, id] of result.idByNode) idByNode.set(node, id);
  }

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
