import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import {
  buildFingerprint,
  fingerprintEqual,
  hashPath,
  readManifest,
  writeManifest,
} from './cache';
import { createProjectWatcher, type ProjectWatcher, type WatchEvent } from './watcher';

export interface LoadedProject {
  // Deterministic id = hashPath(rootPath), so reopening a path (or opening it
  // in a second browser window) resolves to the SAME loaded project rather
  // than spawning a duplicate analyzer/watcher.
  projectId: string;
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
  // Tool/config fingerprint this graph was built under, persisted to the cache.
  fingerprint: Record<string, unknown>;
  // --- Multi-window lifecycle ---------------------------------------------
  // Count of live /watch (SSE) connections. A project with >0 subscribers is
  // in active use by at least one window and is never evicted.
  subscribers: number;
  // ms timestamp of the last open / lookup / watch event — drives LRU eviction.
  lastAccess: number;
}

const projects = new Map<string, LoadedProject>();
// In-flight opens, keyed by projectId, so two windows opening the same (not-yet-
// loaded) path concurrently share one analyzer build instead of racing to make
// two.
const opening = new Map<string, Promise<ProjectResponse>>();

// Keep at most this many projects resident; beyond it, evict the least-recently-
// accessed one that has no live subscribers. Each project is heavy (a ts-morph
// Project in memory, or a live Python subprocess + Jedi/pyright).
const MAX_LOADED = 4;
// A project idle (no subscribers) longer than this is eligible for the periodic
// sweep regardless of the cap.
const IDLE_TTL_MS = 15 * 60_000;
// Don't evict a project accessed within this window even at 0 subscribers — it
// may be a just-opened project whose /watch hasn't connected yet (the POST
// /api/project and the EventSource connect are separate round-trips).
const GRACE_MS = 30_000;

function projectIdFor(rootPath: string): string {
  return 'proj-' + hashPath(rootPath);
}

function responseFrom(loaded: LoadedProject): ProjectResponse {
  return {
    projectId: loaded.projectId,
    rootPath: loaded.rootPath,
    language: loaded.language,
    tsConfigPath: loaded.tsConfigPath,
    files: [...loaded.files.values()],
    edges: loaded.importEdges,
    semanticEdges: loaded.semanticEdges,
  };
}

export async function openProject(rawPath: string): Promise<ProjectResponse> {
  const rootPath = path.resolve(rawPath);
  if (!existsSync(rootPath)) {
    throw new Error(`Path does not exist: ${rootPath}`);
  }
  const projectId = projectIdFor(rootPath);

  // Already loaded → reuse (this is what lets N windows on the same path share
  // one analyzer + watcher + caches).
  const existing = projects.get(projectId);
  if (existing) {
    existing.lastAccess = Date.now();
    return responseFrom(existing);
  }
  // A concurrent open of the same path is already in flight — join it.
  const pending = opening.get(projectId);
  if (pending) return pending;

  const p = buildProject(projectId, rootPath);
  opening.set(projectId, p);
  try {
    return await p;
  } finally {
    opening.delete(projectId);
  }
}

async function buildProject(projectId: string, rootPath: string): Promise<ProjectResponse> {
  const language = detectLanguage(rootPath);
  const analyzer: LanguageAnalyzer =
    language === 'python'
      ? new PythonAnalyzer(rootPath)
      : new TypeScriptAnalyzer(rootPath);

  let files: FileNode[];
  let asts: Map<string, FileAstResponse>;
  let importEdges: ImportEdge[];
  let semanticEdges: SemanticEdge[];
  let fingerprint: Record<string, unknown>;
  let fileMeta: Record<string, { mtimeMs: number; sizeBytes: number }>;
  try {
    fingerprint = buildFingerprint(language, await analyzer.fingerprint());
    const cache = readManifest(rootPath);

    if (cache && fingerprintEqual(cache.fingerprint, fingerprint)) {
      // --- Warm reopen: diff current files vs the cache, re-analyze only the
      // affected set, splice cached edges for the rest. ---
      const current = await analyzer.listFiles();
      fileMeta = {};
      const currentIds = new Set<string>();
      for (const f of current) {
        currentIds.add(f.fileId);
        fileMeta[f.fileId] = { mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes };
      }
      const affected = new Set<string>();
      const removed = new Set<string>();
      for (const f of current) {
        const prev = cache.fileMeta[f.fileId];
        if (!prev || prev.mtimeMs !== f.mtimeMs || prev.sizeBytes !== f.sizeBytes) {
          affected.add(f.fileId); // changed or added
        }
      }
      for (const id of Object.keys(cache.fileMeta)) if (!currentIds.has(id)) removed.add(id);
      // Importers of any changed/added/removed file must also re-resolve their
      // edges — computed from the CACHED import edges (no engine needed).
      const touched = new Set<string>([...affected, ...removed]);
      for (const e of cache.importEdges) if (touched.has(e.toId)) affected.add(e.fromId);

      const opened = await analyzer.open({ affected });
      console.error(
        `[cache] warm reopen ${rootPath}: ${affected.size} reanalyzed, ${removed.size} removed, ` +
          `${Object.keys(cache.fileMeta).length - removed.size} reused`,
      );
      files = opened.files;
      asts = opened.asts;
      // Merge: keep cached edges except those originating from an affected file
      // or touching a removed file; add the freshly-resolved affected edges.
      importEdges = cache.importEdges
        .filter((e) => !affected.has(e.fromId) && !removed.has(e.fromId) && !removed.has(e.toId))
        .concat(opened.importEdges);
      semanticEdges = cache.semanticEdges
        .filter(
          (e) =>
            !affected.has(astFileId(e.fromId)) &&
            !removed.has(astFileId(e.fromId)) &&
            !removed.has(astFileId(e.toId)),
        )
        .concat(opened.semanticEdges);
    } else {
      // --- Cold open: full analysis. ---
      console.error(`[cache] cold open ${rootPath}`);
      const opened = await analyzer.open();
      files = opened.files;
      asts = opened.asts;
      importEdges = opened.importEdges;
      semanticEdges = opened.semanticEdges;
      fileMeta = {};
      for (const f of await analyzer.listFiles()) {
        fileMeta[f.fileId] = { mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes };
      }
    }
  } catch (e) {
    await analyzer.close();
    throw e;
  }

  const tsConfigPath =
    analyzer instanceof TypeScriptAnalyzer ? analyzer.tsConfigPath : undefined;
  const watcher = createProjectWatcher(rootPath, (pth) => analyzer.watches(pth));
  const loaded: LoadedProject = {
    projectId,
    rootPath,
    language,
    tsConfigPath,
    analyzer,
    watcher,
    asts,
    files: new Map(files.map((f) => [f.id, f])),
    importEdges,
    semanticEdges,
    fingerprint,
    subscribers: 0,
    lastAccess: Date.now(),
  };
  projects.set(projectId, loaded);
  // Persist the freshly-assembled graph so the NEXT open is a warm reopen.
  writeManifest(rootPath, {
    language,
    tsConfigPath,
    fingerprint,
    files,
    fileMeta,
    importEdges,
    semanticEdges,
  });
  void evictIfNeeded();
  return responseFrom(loaded);
}

export function getLoadedProject(projectId: string): LoadedProject | undefined {
  const p = projects.get(projectId);
  if (p) p.lastAccess = Date.now();
  return p;
}

// --- Multi-window lifecycle: subscriber refcount + eviction ---------------

export function noteWatchOpen(loaded: LoadedProject): void {
  loaded.subscribers++;
  loaded.lastAccess = Date.now();
}

export function noteWatchClose(loaded: LoadedProject): void {
  loaded.subscribers = Math.max(0, loaded.subscribers - 1);
  loaded.lastAccess = Date.now();
}

async function evict(loaded: LoadedProject): Promise<void> {
  projects.delete(loaded.projectId);
  try {
    await loaded.analyzer.close();
  } catch {
    // best-effort teardown
  }
  loaded.watcher.close();
}

// Over the cap: evict least-recently-accessed projects that have no live
// subscribers and are past the grace window. Never touches a project a window
// is actively watching.
async function evictIfNeeded(): Promise<void> {
  if (projects.size <= MAX_LOADED) return;
  const now = Date.now();
  const candidates = [...projects.values()]
    .filter((p) => p.subscribers === 0 && now - p.lastAccess > GRACE_MS)
    .sort((a, b) => a.lastAccess - b.lastAccess);
  for (const c of candidates) {
    if (projects.size <= MAX_LOADED) break;
    await evict(c);
  }
}

// Periodic idle sweep: drop projects no window has watched for a while so a
// long-running server doesn't hold dead analyzers forever. Unref'd so it never
// keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const p of [...projects.values()]) {
    if (p.subscribers === 0 && now - p.lastAccess > IDLE_TTL_MS) void evict(p);
  }
}, 60_000).unref();

// --- Keep the disk cache fresh as files change ----------------------------
// Debounced so a burst of saves writes the manifest once. Re-stats the file
// set (cheap) so the next reopen's diff is accurate.
const persistTimers = new Map<string, NodeJS.Timeout>();

function schedulePersist(loaded: LoadedProject): void {
  const existing = persistTimers.get(loaded.projectId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    persistTimers.delete(loaded.projectId);
    void persistNow(loaded);
  }, 1500);
  t.unref();
  persistTimers.set(loaded.projectId, t);
}

async function persistNow(loaded: LoadedProject): Promise<void> {
  if (!projects.has(loaded.projectId)) return; // evicted meanwhile
  const fileMeta: Record<string, { mtimeMs: number; sizeBytes: number }> = {};
  try {
    for (const f of await loaded.analyzer.listFiles()) {
      fileMeta[f.fileId] = { mtimeMs: f.mtimeMs, sizeBytes: f.sizeBytes };
    }
  } catch {
    return; // analyzer gone; skip
  }
  writeManifest(loaded.rootPath, {
    language: loaded.language,
    tsConfigPath: loaded.tsConfigPath,
    fingerprint: loaded.fingerprint,
    files: [...loaded.files.values()],
    fileMeta,
    importEdges: loaded.importEdges,
    semanticEdges: loaded.semanticEdges,
  });
}

export function getCachedAst(
  loaded: LoadedProject,
  fileId: string,
): FileAstResponse | undefined {
  return loaded.asts.get(fileId);
}

// --- Editing (write path) --------------------------------------------------

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface SourceForEdit {
  text: string;
  mtimeMs: number;
  hash: string;
}

// Read a file's source straight from DISK (not the analyzer's in-memory buffer,
// which can lag disk for ts-morph). Returned to the editor as both the content
// and the conflict baseline, so text and hash are always coherent.
export function readSourceForEdit(
  loaded: LoadedProject,
  fileId: string,
): SourceForEdit | undefined {
  const abs = path.join(loaded.rootPath, fileId);
  try {
    const text = readFileSync(abs, 'utf8');
    return { text, mtimeMs: statSync(abs).mtimeMs, hash: hashText(text) };
  } catch {
    return undefined;
  }
}

export function validateSource(
  loaded: LoadedProject,
  fileId: string,
  text: string,
) {
  return loaded.analyzer.validate(fileId, text);
}

export interface WriteResult {
  delta: GraphDelta | null;
  newMtimeMs: number;
  newHash: string;
}
export interface WriteConflict {
  conflict: {
    error: string;
    currentText: string;
    currentMtimeMs: number;
    currentHash: string;
  };
}

// Conflict-checked write, then reuse the SAME incremental pipeline as an
// external edit (applyFileEvent) to re-analyze the file and recompute the edges
// over {fileId} ∪ importers, returning the delta. The write also fires a
// chokidar 'change' event that fans out over SSE to every window (including
// this one) — applyDelta is idempotent, so the echo re-applying the same delta
// is a no-op, and NOT suppressing it is what keeps other windows in sync.
export async function writeSource(
  loaded: LoadedProject,
  fileId: string,
  req: { text: string; baseHash: string | null; force?: boolean },
): Promise<WriteResult | WriteConflict> {
  const abs = path.join(loaded.rootPath, fileId);
  const exists = existsSync(abs);

  if (!req.force) {
    if (exists) {
      const cur = readFileSync(abs, 'utf8');
      const curHash = hashText(cur);
      if (req.baseHash !== curHash) {
        return {
          conflict: {
            error: 'File changed on disk since you started editing.',
            currentText: cur,
            currentMtimeMs: statSync(abs).mtimeMs,
            currentHash: curHash,
          },
        };
      }
    } else if (req.baseHash !== null) {
      // The client edited an existing file, but it's gone from disk now.
      return {
        conflict: {
          error: 'File no longer exists on disk.',
          currentText: '',
          currentMtimeMs: 0,
          currentHash: '',
        },
      };
    }
  }

  writeFileSync(abs, req.text, 'utf8');
  const delta = await applyFileEvent(loaded, {
    kind: exists ? 'changed' : 'added',
    fileId,
  });
  return { delta, newMtimeMs: statSync(abs).mtimeMs, newHash: hashText(req.text) };
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
    schedulePersist(loaded);
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
  schedulePersist(loaded);
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
