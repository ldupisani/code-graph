import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileNode, ImportEdge, SemanticEdge } from '../src/api/types';
import type { Language } from './analyzer';

// Disk cache of analyzed graphs, in a CENTRAL dir (never inside the user's
// project). It persists the per-project file list + import/semantic edges so a
// reopen can skip the expensive edge-resolution pass (ts-morph symbol
// resolution / Jedi / pyright) for files that haven't changed. Per-file ASTs
// are NOT cached: open(seed) re-extracts them (cheap relative to edge
// resolution) and that keeps cached edge ids in sync with the live AST.
//
// IMPORTANT: bump SCHEMA_VERSION whenever the AST-id assignment or the edge
// shape changes (e.g. an ast-extractor walk-order change), or a stale cache
// could pair old edge ids with freshly-extracted nodes.
const SCHEMA_VERSION = 1;

// A project's cache entry. `fileMeta` is the identity table for the reopen diff;
// `fingerprint` gates the whole entry (tool/config changes discard it).
export interface CacheManifest {
  schemaVersion: number;
  rootPath: string;
  language: Language;
  tsConfigPath?: string;
  fingerprint: Record<string, unknown>;
  files: FileNode[];
  fileMeta: Record<string, { mtimeMs: number; sizeBytes: number }>;
  importEdges: ImportEdge[];
  semanticEdges: SemanticEdge[];
  writtenAt: number;
}

// Keep the central cache from growing without bound.
const MAX_CACHE_ENTRIES = 64;

export function cacheDisabled(): boolean {
  return process.env.CODE_GRAPH_NO_CACHE === '1' || process.env.CODE_GRAPH_NO_CACHE === 'true';
}

function baseDir(): string {
  if (process.env.CODE_GRAPH_CACHE_DIR) return process.env.CODE_GRAPH_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'code-graph');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'code-graph', 'cache');
  }
  return path.join(os.homedir(), '.cache', 'code-graph');
}

// Stable hash of a resolved root path — shared as the cache key AND (with a
// "proj-" prefix) the projectId, so the two systems line up.
export function hashPath(rootPath: string): string {
  return createHash('sha256').update(rootPath).digest('hex').slice(0, 16);
}

function entryDir(rootPath: string): string {
  return path.join(baseDir(), hashPath(rootPath));
}

function manifestPath(rootPath: string): string {
  return path.join(entryDir(rootPath), 'manifest.json');
}

export function readManifest(rootPath: string): CacheManifest | null {
  if (cacheDisabled()) return null;
  const p = manifestPath(rootPath);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as CacheManifest;
    if (m.schemaVersion !== SCHEMA_VERSION || m.rootPath !== rootPath) return null;
    return m;
  } catch {
    return null;
  }
}

export function writeManifest(
  rootPath: string,
  data: Omit<CacheManifest, 'schemaVersion' | 'rootPath' | 'writtenAt'>,
): void {
  if (cacheDisabled()) return;
  const manifest: CacheManifest = {
    schemaVersion: SCHEMA_VERSION,
    rootPath,
    writtenAt: Date.now(),
    ...data,
  };
  try {
    const dir = entryDir(rootPath);
    mkdirSync(dir, { recursive: true });
    // Atomic: write to a temp file then rename over the manifest.
    const p = manifestPath(rootPath);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(manifest), 'utf8');
    renameSync(tmp, p);
    pruneCacheDir();
  } catch {
    // Cache is best-effort; a write failure must never break analysis.
  }
}

// Deep-ish equality of the two fingerprint records (order-independent over
// keys; values compared by JSON).
export function fingerprintEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

export function buildFingerprint(
  language: Language,
  analyzerPart: Record<string, unknown>,
): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, language, ...analyzerPart };
}

// Drop oldest entries when the cache dir holds too many projects.
function pruneCacheDir(): void {
  try {
    const base = baseDir();
    const entries = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const mp = path.join(base, e.name, 'manifest.json');
        let writtenAt = 0;
        try {
          writtenAt = (JSON.parse(readFileSync(mp, 'utf8')) as CacheManifest).writtenAt ?? 0;
        } catch {
          writtenAt = 0;
        }
        return { dir: path.join(base, e.name), writtenAt };
      })
      .sort((a, b) => b.writtenAt - a.writtenAt);
    for (const stale of entries.slice(MAX_CACHE_ENTRIES)) {
      rmSync(stale.dir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

// Read a package's version from its package.json via this module's resolver —
// used in analyzer fingerprints (ts-morph / typescript). Returns '?' if absent.
export function packageVersion(require: NodeJS.Require, pkg: string): string {
  try {
    const pj = require.resolve(`${pkg}/package.json`);
    return (JSON.parse(readFileSync(pj, 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
}

// stat helper shared by analyzers' listFiles().
export function statMeta(absPath: string): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const s = statSync(absPath);
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size };
  } catch {
    return null;
  }
}
