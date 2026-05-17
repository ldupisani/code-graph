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

export function createProjectWatcher(rootPath: string): ProjectWatcher {
  const listeners = new Set<WatchListener>();

  // Chokidar 5 dropped glob support — pass the directory and filter via the
  // `ignored` predicate instead. The predicate is consulted with and without
  // a `stats` argument; when stats is absent (e.g. before chokidar has
  // stat'd the entry) we must NOT treat the path as a file, or we'd reject
  // entire directories whose names don't end in .ts.
  const EXCLUDE_DIR_RE = /(?:^|[\\/])(?:node_modules|dist|\.git)(?:[\\/]|$)/;
  const watcher: FSWatcher = chokidar.watch(rootPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 60 },
    ignored: (filePath, stats) => {
      if (EXCLUDE_DIR_RE.test(filePath)) return true;
      // Only apply the extension filter when we know it's a file. Without
      // stats, allow — chokidar will revisit with stats or hand us the file
      // events directly.
      if (stats?.isFile()) {
        return !/\.(ts|tsx)$/.test(filePath);
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
