import path from 'node:path';
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

// `watches(absPath)` is the analyzer's source-file predicate — it decides
// which files this project cares about (extension + excluded dirs), so the
// watcher stays language-agnostic.
export function createProjectWatcher(
  rootPath: string,
  watches: (absPath: string) => boolean,
): ProjectWatcher {
  const listeners = new Set<WatchListener>();

  // Chokidar 5 dropped glob support — pass the directory and filter via the
  // `ignored` predicate instead. The predicate is consulted with and without
  // a `stats` argument; when stats is absent (e.g. before chokidar has
  // stat'd the entry) we must NOT treat the path as a file, or we'd reject
  // entire directories whose names don't end in a source extension.
  const watcher: FSWatcher = chokidar.watch(rootPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 60 },
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

  function emit(kind: WatchEvent['kind'], absPath: string) {
    const fileId = path.relative(rootPath, absPath).replace(/\\/g, '/');
    if (!fileId || fileId.startsWith('..')) return;
    for (const l of listeners) l({ kind, fileId });
  }

  watcher.on('change', (p) => emit('changed', p));
  watcher.on('add', (p) => emit('added', p));
  watcher.on('unlink', (p) => emit('removed', p));

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      void watcher.close();
      listeners.clear();
    },
  };
}
