// Workspace allowlist + path-containment helpers. The config file is the
// single security boundary for WHICH directories the server may analyze;
// resolveFileIdWithinRoot is the boundary for WHICH files inside an open
// project a request may touch. Everything here fails closed: no config means
// no workspaces, an un-contained fileId means null.
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  // Realpath'd, existing workspace roots. Projects may only be opened from
  // inside one of these.
  workspaces: string[];
  configMissing: boolean;
}

export const CONFIG_FILE = path.resolve(process.cwd(), 'code-graph.config.json');

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

let cached: AppConfig | null = null;

// Read once per server process; `tsx watch` restarts on server-file edits but
// NOT on config edits, so changing the config requires a manual restart (or
// touching any server file).
export function loadConfig(): AppConfig {
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    console.warn(
      `[code-graph] No ${path.basename(CONFIG_FILE)} found — no projects can be opened. ` +
        'Copy code-graph.config.example.json to code-graph.config.json and list your workspace roots.',
    );
    return (cached = { workspaces: [], configMissing: true });
  }
  const workspaces: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    for (const entry of Array.isArray(parsed.workspaces) ? parsed.workspaces : []) {
      if (typeof entry !== 'string') continue;
      try {
        workspaces.push(realpathSync(path.resolve(expandHome(entry))));
      } catch {
        console.warn(`[code-graph] Workspace root does not exist, skipping: ${entry}`);
      }
    }
  } catch (e) {
    console.warn(`[code-graph] Failed to parse ${CONFIG_FILE}: ${String(e)}`);
  }
  return (cached = { workspaces, configMissing: false });
}

// Is `candidate` (any user-supplied path) inside a configured workspace root?
// Realpaths the candidate so a symlink into a root and its target unify to one
// canonical path — which also becomes the projectId hash input, so both spell-
// ings share one analyzer/watcher.
export function isPathAllowed(candidate: string): { ok: true; realPath: string } | { ok: false } {
  let real: string;
  try {
    real = realpathSync(path.resolve(candidate));
  } catch {
    return { ok: false };
  }
  for (const root of loadConfig().workspaces) {
    // `root + sep` (not bare startsWith) so /ws/foo-evil can't pass for /ws/foo.
    if (real === root || real.startsWith(root + path.sep)) {
      return { ok: true, realPath: real };
    }
  }
  return { ok: false };
}

// Resolve a client-supplied fileId (a relative path like "src/util.ts")
// against a project root, returning the absolute path ONLY if it stays inside
// the root — otherwise null. This is the guard that stops
// `fileId=../../../../etc/hosts` style traversal on every file endpoint.
// Legit fileIds are always forward-slash relative paths minted by the
// server's own walkers/watcher, so anything else-shaped (empty, absolute,
// backslashes) is rejected outright rather than normalized.
export function resolveFileIdWithinRoot(rootPath: string, fileId: string): string | null {
  if (!fileId || path.isAbsolute(fileId) || fileId.includes('\\')) return null;
  const abs = path.resolve(rootPath, fileId);
  if (!abs.startsWith(rootPath + path.sep)) return null;
  // Lexical containment alone isn't enough: `root/link/x.ts` passes the check
  // above even when `link` is a symlink to /etc, and the read/write would
  // follow it out. Canonicalize and re-check. A file that doesn't exist yet
  // (or was just deleted) has no realpath, so canonicalize its parent dir —
  // that's where a symlink escape would live. Missing parent → reject.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    try {
      real = path.join(realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return null;
    }
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    return null;
  }
  return real.startsWith(realRoot + path.sep) ? real : null;
}
