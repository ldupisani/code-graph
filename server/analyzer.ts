import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type {
  Diagnostic,
  FileAstResponse,
  FileNode,
  ImportEdge,
  SemanticEdge,
} from '../src/api/types';

export type Language = 'typescript' | 'python';

// One file's incremental re-analysis result. Edges are NOT here — they are
// recomputed at the project level over the affected set (mirroring the old
// recomputeEdges), so a single analyzer call stays cheap and the
// {file} ∪ importers bound is owned by the orchestrator.
export interface FileUpdate {
  file?: FileNode; // fresh size/lineCount; absent for 'removed'
  ast?: FileAstResponse; // fresh AST; absent for 'removed'
}

export interface AnalyzerOpenResult {
  files: FileNode[];
  asts: Map<string, FileAstResponse>;
  importEdges: ImportEdge[];
  semanticEdges: SemanticEdge[];
}

// Warm-start seed for a cache-backed reopen. The analyzer still constructs its
// engine and extracts ASTs for ALL files (so cross-file resolution and live
// edits keep working), but builds import/semantic edges ONLY for `affected`
// (= changed ∪ added ∪ their importers ∪ importers of removed). The orchestrator
// merges those fresh edges with the cached edges for everything else. With
// `affected` empty (nothing changed), no edge resolution runs at all — the
// expensive ts-morph symbol / Jedi / pyright work is skipped entirely.
export interface WarmSeed {
  affected: ReadonlySet<string>;
}

// One file's identity for the reopen diff (no parsing).
export interface FileStat {
  fileId: string;
  mtimeMs: number;
  sizeBytes: number;
}

// A per-project façade over a language-specific engine (in-process ts-morph
// `Project`, or an out-of-process Python helper). The orchestrator in
// project.ts holds one of these and delegates all language-specific work to
// it; everything the orchestrator does on top (caches, the watcher, the
// incremental GraphDelta splicing) operates purely on the generic wire types
// and is shared across languages.
//
// All `fileId`s are unix relative paths from the project root (never contain
// `#`); all AST ids are `${fileId}#${seq}` with `seq` reset per file and
// assigned in a deterministic depth-first pre-order. Methods are async so an
// out-of-process analyzer fits; the in-process ts-morph analyzer simply
// resolves immediately.
export interface LanguageAnalyzer {
  readonly language: Language;
  readonly rootPath: string;

  // Full project walk: files + per-file ASTs + all edges. With a `seed`
  // (cache-backed reopen), edges are built only for the affected set; without
  // it, all edges are built (cold open). Either way `asts`/`files` cover every
  // file. Called once per load.
  open(seed?: WarmSeed): Promise<AnalyzerOpenResult>;

  // List the analyzer's source files with mtime/size, WITHOUT parsing — used to
  // diff against the cache and compute the affected set for a warm reopen.
  listFiles(): Promise<FileStat[]>;

  // Tool/config fingerprint contribution — a cache is reused only if this
  // matches (e.g. ts-morph/typescript or python/jedi/pyright versions, tsconfig
  // mtime, exclude rule). Cheap to compute.
  fingerprint(): Promise<Record<string, unknown>>;

  // One file's fresh AST — the cache-miss fallback for GET /ast on a file
  // added after open. Returns undefined when the file isn't known.
  extract(fileId: string): Promise<FileAstResponse | undefined>;

  // Raw source text for GET /source.
  readSource(fileId: string): Promise<string | undefined>;

  // Dry-run the parse → AST-extract pipeline on a PROPOSED buffer WITHOUT
  // mutating any live engine state (the write gate for editing). ok=false when
  // the buffer would break graph analysis — a syntax error, or our AST walk
  // throwing on it. Diagnostics are Monaco-ready (1-based line/col). Cross-file
  // edge resolution is intentionally NOT part of this check: an edit that
  // changes which symbols resolve produces *different* edges, not *broken*
  // analysis, and the authoritative edges are recomputed after the write.
  validate(
    fileId: string,
    text: string,
  ): Promise<{ ok: boolean; diagnostics: Diagnostic[] }>;

  // Apply a single filesystem change, re-parsing ONLY this file. Edge
  // recomputation is driven separately by the orchestrator via buildEdges
  // over the affected set.
  applyChange(
    kind: 'changed' | 'added' | 'removed',
    fileId: string,
  ): Promise<FileUpdate>;

  // Recompute the edges ORIGINATING from exactly `fromFileIds`. The
  // orchestrator handles dropping stale edges (including, on removal, edges
  // pointing INTO the dead file) before splicing these in.
  buildEdges(
    fromFileIds: ReadonlySet<string>,
  ): Promise<{ imports: ImportEdge[]; semanticEdges: SemanticEdge[] }>;

  // Files that import `fileId` (its consumers) — drives the `affected` set.
  importersOf(fileId: string): Promise<string[]>;

  // Whether the watcher should react to this absolute path (replaces the
  // watcher's previously hard-coded extension regex).
  watches(absPath: string): boolean;

  close(): Promise<void>;
}

// Directories never worth walking for source files, for either language.
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.eggs',
  'site-packages',
]);

export function isExcludedDir(name: string): boolean {
  return EXCLUDE_DIRS.has(name);
}

// A fingerprint of the exclude-dir rule, so changing it invalidates caches
// (the file set would differ).
export function excludeDirsFingerprint(): string {
  return [...EXCLUDE_DIRS].sort().join(',');
}

// Walk a project for source files (mtime/size, NO parsing), applying the
// analyzer's `watches` predicate + the shared exclude-dir rule. Used by
// analyzers whose file set is a plain directory walk (Python) to diff against
// the cache. TypeScript instead lists files from its ts-morph Project.
export function walkSourceFiles(
  rootPath: string,
  watches: (absPath: string) => boolean,
): FileStat[] {
  const out: FileStat[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isExcludedDir(e.name) && !e.name.startsWith('.')) walk(abs);
      } else if (e.isFile() && watches(abs)) {
        try {
          const s = statSync(abs);
          out.push({
            fileId: path.relative(rootPath, abs).replace(/\\/g, '/'),
            mtimeMs: s.mtimeMs,
            sizeBytes: s.size,
          });
        } catch {
          // skip unreadable
        }
      }
    }
  };
  walk(rootPath);
  return out;
}

// Pick the analyzer for a project root. tsconfig.json wins (a repo may have a
// few build scripts in Python but still be a TS project); otherwise any of the
// usual Python markers — or a `.py` file found in a bounded shallow scan —
// selects Python. Throws an actionable error when neither matches.
export function detectLanguage(rootPath: string): Language {
  if (existsSync(path.join(rootPath, 'tsconfig.json'))) return 'typescript';
  if (
    existsSync(path.join(rootPath, 'pyproject.toml')) ||
    existsSync(path.join(rootPath, 'setup.py')) ||
    existsSync(path.join(rootPath, 'setup.cfg')) ||
    hasPythonFile(rootPath, 2)
  ) {
    return 'python';
  }
  throw new Error(
    `Could not detect a supported project at ${rootPath}. Expected a tsconfig.json ` +
      `(TypeScript) or pyproject.toml / setup.py / setup.cfg / a .py file (Python).`,
  );
}

// Bounded breadth-limited search for any `.py` file, up to `maxDepth` levels
// deep, skipping excluded dirs. Cheap probe used only when no explicit Python
// marker file exists at the root.
function hasPythonFile(dir: string, maxDepth: number): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.isFile() && (e.name.endsWith('.py') || e.name.endsWith('.pyi'))) return true;
    if (e.isDirectory() && !isExcludedDir(e.name) && !e.name.startsWith('.')) {
      subdirs.push(path.join(dir, e.name));
    }
  }
  if (maxDepth <= 0) return false;
  for (const sub of subdirs) {
    if (hasPythonFile(sub, maxDepth - 1)) return true;
  }
  return false;
}
