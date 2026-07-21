// Scans the configured workspace roots for openable projects — this is what
// feeds the picker in the UI, replacing the old free-text path input. The walk
// is bounded (depth, shared exclude list) so a wide workspace root stays cheap
// to scan on every GET /api/projects.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EXCLUDE_DIR_RE } from './watcher';

export interface DiscoveredProject {
  // Path relative to its workspace root (or the basename when the root itself
  // is a project) — what the picker displays.
  name: string;
  // Absolute path, what actually gets opened.
  path: string;
}

const MAX_DEPTH = 3;

// Does this directory look like a project the picker should offer?
// `entryNames` is the set of names directly inside the directory. Analyzer
// entry markers (tsconfig.json for TS, pyproject.toml/setup.py for Python)
// count on their own; package.json alone would match every JS scrap folder,
// so it only counts for a directory that is also a repo root (.git).
function isProjectDir(entryNames: ReadonlySet<string>): boolean {
  if (
    entryNames.has('tsconfig.json') ||
    entryNames.has('pyproject.toml') ||
    entryNames.has('setup.py')
  ) {
    return true;
  }
  return entryNames.has('package.json') && entryNames.has('.git');
}

export async function discoverProjects(workspaces: string[]): Promise<DiscoveredProject[]> {
  // Keyed by realpath so a project reachable via symlink and directly only
  // lists once.
  const found = new Map<string, DiscoveredProject>();
  for (const root of workspaces) {
    await scan(root, root, 0, found);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scan(
  root: string,
  dir: string,
  depth: number,
  out: Map<string, DiscoveredProject>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, not fatal
  }
  const names = new Set(entries.map((e) => e.name));
  if (isProjectDir(names)) {
    const real = await fs.realpath(dir).catch(() => dir);
    if (!out.has(real)) {
      const rel = path.relative(root, dir);
      out.set(real, { name: rel === '' ? path.basename(dir) : rel, path: dir });
    }
  }
  if (depth >= MAX_DEPTH) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const child = path.join(dir, e.name);
    if (EXCLUDE_DIR_RE.test(child)) continue;
    await scan(root, child, depth + 1, out);
  }
}
