import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Project, ts, type Node, type SourceFile } from 'ts-morph';
import type {
  FileAstResponse,
  FileNode,
  ImportEdge,
  SemanticEdge,
} from '../src/api/types';
import { extractAst } from './ast-extractor';
import { buildSemanticEdges } from './semantic-edges';
import {
  excludeDirsFingerprint,
  isExcludedDir,
  type AnalyzerOpenResult,
  type FileStat,
  type FileUpdate,
  type Language,
  type LanguageAnalyzer,
  type WarmSeed,
} from './analyzer';
import { packageVersion } from './cache';

// The TypeScript engine, wrapping ts-morph behind the LanguageAnalyzer façade.
// This is the project.ts ts-morph code lifted essentially verbatim — only the
// orchestration (caches, watcher, GraphDelta splicing) moved out to the
// generic orchestrator. Behaviour for TS projects is unchanged.
export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly language: Language = 'typescript';
  readonly rootPath: string;
  readonly tsConfigPath: string;

  private readonly project: Project;
  // Global Node→AST-id map, shared across files so cross-file edge resolution
  // (a call in A → a decl in B) can look up B's ids. Patched per file: a
  // file's entries are purged (via nodesByFile) and rebuilt on re-walk.
  private readonly idByNode = new Map<Node, string>();
  // fileId → the Node objects that contributed idByNode entries, so a re-walk
  // can purge exactly that file's stale entries.
  private readonly nodesByFile = new Map<string, Node[]>();

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    const tsConfigPath = path.join(rootPath, 'tsconfig.json');
    if (!existsSync(tsConfigPath)) {
      throw new Error(
        `No tsconfig.json found at ${tsConfigPath}. Only TypeScript projects with a tsconfig at the root are supported.`,
      );
    }
    this.tsConfigPath = tsConfigPath;

    const project = new Project({ tsConfigFilePath: tsConfigPath });
    let sourceFiles = project.getSourceFiles();
    // Solution-style tsconfig (e.g. { "files": [], "references": [...] }):
    // ts-morph doesn't follow project references, so the root config yields no
    // files. Pull sources from each referenced config directly.
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
    }
    this.project = project;
  }

  async open(seed?: WarmSeed): Promise<AnalyzerOpenResult> {
    const sourceFiles = this.project.getSourceFiles();
    const files: FileNode[] = sourceFiles.map((sf) => this.buildFileNode(sf));
    const fileIdByAbs = new Map(files.map((f) => [f.absolutePath, f.id]));

    // Extract every file's AST. This runs even on a warm reopen — it's needed
    // to populate idByNode for ALL files so a changed file's edges can resolve
    // into unchanged ones. (ts-morph's parse, in the constructor, is the
    // dominant unavoidable cost; what the cache skips is edge resolution.)
    const asts = new Map<string, FileAstResponse>();
    for (const sf of sourceFiles) {
      const fileId = fileIdByAbs.get(sf.getFilePath());
      if (!fileId) continue;
      const result = extractAst(sf, fileId);
      asts.set(fileId, result.response);
      const fileNodes: Node[] = [];
      for (const [node, id] of result.idByNode) {
        this.idByNode.set(node, id);
        fileNodes.push(node);
      }
      this.nodesByFile.set(fileId, fileNodes);
    }

    // Edge sources: only the affected files on a warm reopen (the orchestrator
    // splices in the cached edges for everything else); all files on a cold
    // open. Building semantic edges is the expensive symbol-resolution pass
    // the cache exists to skip.
    const edgeSources = seed
      ? sourceFiles.filter((sf) => {
          const id = fileIdByAbs.get(sf.getFilePath());
          return id != null && seed.affected.has(id);
        })
      : sourceFiles;
    const importEdges = this.buildImportEdges(edgeSources, fileIdByAbs);
    const semanticEdges = buildSemanticEdges(edgeSources, this.idByNode);

    return { files, asts, importEdges, semanticEdges };
  }

  async listFiles(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    for (const sf of this.project.getSourceFiles()) {
      try {
        const s = statSync(sf.getFilePath());
        out.push({ fileId: this.relativeFileId(sf), mtimeMs: s.mtimeMs, sizeBytes: s.size });
      } catch {
        // skip unreadable
      }
    }
    return out;
  }

  // Cache fingerprint — cheap. Changing tsconfig, ts-morph, typescript, or the
  // exclude rule invalidates the cached graph.
  async fingerprint(): Promise<Record<string, unknown>> {
    const require = createRequire(import.meta.url);
    let tsConfigMtimeMs = 0;
    try {
      tsConfigMtimeMs = statSync(this.tsConfigPath).mtimeMs;
    } catch {
      // no tsconfig stat — leave 0
    }
    return {
      tsConfigMtimeMs,
      tsMorph: packageVersion(require, 'ts-morph'),
      typescript: packageVersion(require, 'typescript'),
      excludeDirs: excludeDirsFingerprint(),
    };
  }

  async extract(fileId: string): Promise<FileAstResponse | undefined> {
    const sf = this.findSourceFile(fileId);
    if (!sf) return undefined;
    return extractAst(sf, fileId).response;
  }

  async readSource(fileId: string): Promise<string | undefined> {
    const sf = this.findSourceFile(fileId);
    return sf?.getFullText();
  }

  async applyChange(
    kind: 'changed' | 'added' | 'removed',
    fileId: string,
  ): Promise<FileUpdate> {
    const absPath = path.join(this.rootPath, fileId);

    if (kind === 'removed') {
      const sf = this.findSourceFile(fileId);
      if (sf) this.project.removeSourceFile(sf);
      this.purgeFile(fileId);
      return {};
    }

    // changed | added
    let sf = this.findSourceFile(fileId);
    if (!sf) {
      if (!existsSync(absPath)) return {};
      sf = this.project.addSourceFileAtPath(absPath);
    } else {
      sf.refreshFromFileSystemSync();
    }
    this.walkFile(sf, fileId);
    return { file: this.buildFileNode(sf), ast: this.cachedAst(fileId) };
  }

  async buildEdges(
    fromFileIds: ReadonlySet<string>,
  ): Promise<{ imports: ImportEdge[]; semanticEdges: SemanticEdge[] }> {
    const fileIdByAbs = this.currentFileIdByAbs();
    const affectedSf = this.project.getSourceFiles().filter((sf) => {
      const id = fileIdByAbs.get(sf.getFilePath());
      return id != null && fromFileIds.has(id);
    });
    const imports = this.buildImportEdges(affectedSf, fileIdByAbs);
    const semanticEdges = buildSemanticEdges(affectedSf, this.idByNode);
    return { imports, semanticEdges };
  }

  async importersOf(fileId: string): Promise<string[]> {
    const fileIdByAbs = this.currentFileIdByAbs();
    const out: string[] = [];
    for (const sf of this.project.getSourceFiles()) {
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

  watches(absPath: string): boolean {
    if (absPath.split(/[\\/]/).some((seg) => isExcludedDir(seg))) return false;
    return /\.(ts|tsx)$/.test(absPath);
  }

  async close(): Promise<void> {
    // ts-morph holds no external resources; nothing to release.
  }

  // --- internals (lifted from the old project.ts) ------------------------

  // The extract() fallback re-walks fresh; this captures the ast cache after a
  // walkFile so applyChange can hand it back inline.
  private lastWalkedAst = new Map<string, FileAstResponse>();
  private cachedAst(fileId: string): FileAstResponse | undefined {
    return this.lastWalkedAst.get(fileId);
  }

  private walkFile(sf: SourceFile, fileId: string): void {
    this.purgeFile(fileId);
    const result = extractAst(sf, fileId);
    this.lastWalkedAst.set(fileId, result.response);
    const fileNodes: Node[] = [];
    for (const [node, id] of result.idByNode) {
      this.idByNode.set(node, id);
      fileNodes.push(node);
    }
    this.nodesByFile.set(fileId, fileNodes);
  }

  private purgeFile(fileId: string): void {
    const nodes = this.nodesByFile.get(fileId);
    if (nodes) for (const n of nodes) this.idByNode.delete(n);
    this.nodesByFile.delete(fileId);
    this.lastWalkedAst.delete(fileId);
  }

  private findSourceFile(fileId: string): SourceFile | undefined {
    for (const sf of this.project.getSourceFiles()) {
      if (this.relativeFileId(sf) === fileId) return sf;
    }
    return undefined;
  }

  private currentFileIdByAbs(): Map<string, string> {
    const m = new Map<string, string>();
    for (const sf of this.project.getSourceFiles()) {
      m.set(sf.getFilePath(), this.relativeFileId(sf));
    }
    return m;
  }

  private relativeFileId(sf: SourceFile): string {
    return path.relative(this.rootPath, sf.getFilePath()).replace(/\\/g, '/');
  }

  private buildFileNode(sf: SourceFile): FileNode {
    const absolutePath = sf.getFilePath();
    const text = sf.getFullText();
    return {
      id: this.relativeFileId(sf),
      kind: 'file',
      relativePath: path.relative(this.rootPath, absolutePath).replace(/\\/g, '/'),
      absolutePath,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      lineCount: countLines(text),
    };
  }

  private buildImportEdges(
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
          fromAstNodeId: this.idByNode.get(imp),
        });
      }
    }
    return edges;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
