import path from 'node:path';
import { existsSync, watch as fsWatch } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';

export interface WatchEvent {
  kind: 'changed' | 'added' | 'removed';
  fileId: string;
}

export type WatchListener = (event: WatchEvent) => void;

export interface ProjectWatcher {
  subscribe: (listener: WatchListener) => () => void;
  close: () => void;
}

// Directories no analyzer/watcher/discovery pass should ever descend into.
// Shared with server/discovery.ts so the project picker skips the same trees
// the watcher ignores.
export const EXCLUDE_DIR_RE =
  /(?:^|[\\/])(?:node_modules|dist|build|\.git|venv|\.venv|env|__pycache__|\.mypy_cache|\.pytest_cache|\.tox|\.eggs|site-packages)(?:[\\/]|$)/;

// How long a file must stay quiet after an fs event before we emit — absorbs
// editor write bursts and atomic saves (write-temp-then-rename) so consumers
// see one settled event per save. Mirrors chokidar's awaitWriteFinish.
const SETTLE_MS = 150;

// macOS and Windows support recursive fs.watch natively (FSEvents /
// ReadDirectoryChangesW): ONE descriptor per project. Chokidar 5 has no
// fsevents backend and opens a descriptor PER DIRECTORY, which blows the
// process fd limit (EMFILE) on large trees — so only Linux, where recursive
// watching is inotify-per-dir regardless, keeps chokidar's battle-tested
// handling.
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

// `watches(absPath)` is the analyzer's source-file predicate — it decides
// which files this project cares about (extension + excluded dirs), so the
// watcher stays language-agnostic.
export function createProjectWatcher(
  rootPath: string,
  watches: (absPath: string) => boolean,
): ProjectWatcher {
  const listeners = new Set<WatchListener>();

  function emit(kind: WatchEvent['kind'], absPath: string) {
    const fileId = path.relative(rootPath, absPath).replace(/\\/g, '/');
    if (!fileId || fileId.startsWith('..')) return;
    for (const l of listeners) l({ kind, fileId });
  }

  // Watcher failures (EMFILE, a vanished root, …) must degrade — stale
  // watching — never crash the server: an FSWatcher 'error' with no listener
  // takes down the whole process.
  function onWatchError(err: unknown) {
    console.error(`[watcher] error watching ${rootPath} (file watching degraded):`, err);
  }

  let close: () => void;

  if (NATIVE_RECURSIVE) {
    // Per-file settle timers: emit only after SETTLE_MS of quiet, then stat to
    // classify. Existence decides changed-vs-removed; added collapses into
    // 'changed', which shares the added pipeline everywhere downstream.
    const pending = new Map<string, NodeJS.Timeout>();
    const native = fsWatch(rootPath, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const absPath = path.join(rootPath, filename.toString());
      if (EXCLUDE_DIR_RE.test(absPath) || !watches(absPath)) return;
      clearTimeout(pending.get(absPath));
      pending.set(
        absPath,
        setTimeout(() => {
          pending.delete(absPath);
          emit(existsSync(absPath) ? 'changed' : 'removed', absPath);
        }, SETTLE_MS),
      );
    });
    native.on('error', onWatchError);
    close = () => {
      native.close();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  } else {
    // Chokidar 5 dropped glob support — pass the directory and filter via the
    // `ignored` predicate instead. The predicate is consulted with and without
    // a `stats` argument; when stats is absent (e.g. before chokidar has
    // stat'd the entry) we must NOT treat the path as a file, or we'd reject
    // entire directories whose names don't end in a source extension.
    const watcher: FSWatcher = chokidar.watch(rootPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: SETTLE_MS, pollInterval: 60 },
      ignored: (filePath, stats) => {
        if (EXCLUDE_DIR_RE.test(filePath)) return true;
        // Only apply the file predicate when we know it's a file. Without
        // stats, allow — chokidar will revisit with stats or hand us the file
        // events directly.
        if (stats?.isFile()) {
          return !watches(filePath);
        }
        return false;
      },
    });
    watcher.on('error', onWatchError);
    watcher.on('change', (p) => emit('changed', p));
    watcher.on('add', (p) => emit('added', p));
    watcher.on('unlink', (p) => emit('removed', p));
    close = () => {
      void watcher.close();
    };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      close();
      listeners.clear();
    },
  };
}
