import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type {
  Diagnostic,
  FileAstResponse,
  FileNode,
  ImportEdge,
  SemanticEdge,
} from '../src/api/types';
import {
  excludeDirsFingerprint,
  isExcludedDir,
  walkSourceFiles,
  type AnalyzerOpenResult,
  type FileStat,
  type FileUpdate,
  type Language,
  type LanguageAnalyzer,
  type WarmSeed,
} from './analyzer';

// The Python engine. Drives a long-lived Python helper process (stdlib `ast`
// for the node tree + Jedi for cross-symbol resolution) over newline-delimited
// JSON on stdio. The process stays warm so Jedi's module cache survives across
// incremental edits, mirroring how the ts-morph `Project` stays in memory.
//
// Protocol: every request is one JSON object per line on the helper's stdin
// carrying a monotonic `id` and an `op`; the helper replies with one JSON
// object per line on stdout echoing the `id`. stdout is reserved for protocol
// frames; all diagnostics go to stderr (piped to our logger).
export class PythonAnalyzer implements LanguageAnalyzer {
  readonly language: Language = 'python';
  readonly rootPath: string;

  private readonly interpreter: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private stdoutBuf = '';
  private closed = false;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.interpreter = findInterpreter();
    ensureJedi(this.interpreter);
  }

  async open(seed?: WarmSeed): Promise<AnalyzerOpenResult> {
    this.spawnHelper();
    // Hand the helper an argv for pyright's language server (if available) so
    // it can resolve calls/inheritance with a real type checker, falling back
    // to Jedi per-query. null → Jedi-only (unchanged behaviour).
    // `affected` (warm reopen) scopes edge resolution — the helper still parses
    // every file but only runs Jedi/pyright for the affected set; the
    // orchestrator splices cached edges for the rest. null → resolve all (cold).
    const res = (await this.request('open', {
      root: this.rootPath,
      pyright: resolvePyrightArgv(),
      affected: seed ? [...seed.affected] : null,
    })) as {
      files: FileNode[];
      asts: Record<string, FileAstResponse>;
      importEdges: ImportEdge[];
      semanticEdges: SemanticEdge[];
    };
    return {
      files: res.files,
      asts: new Map(Object.entries(res.asts)),
      importEdges: res.importEdges,
      semanticEdges: res.semanticEdges,
    };
  }

  async listFiles(): Promise<FileStat[]> {
    // Plain directory walk (no parse) — matches the helper's discover() set.
    return walkSourceFiles(this.rootPath, (p) => this.watches(p));
  }

  async fingerprint(): Promise<Record<string, unknown>> {
    let python = '?';
    let jedi = '?';
    try {
      const v = spawnSync(this.interpreter, ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8' });
      if (v.status === 0) python = (v.stdout || '').trim();
    } catch {
      // leave '?'
    }
    try {
      const v = spawnSync(this.interpreter, ['-c', 'import jedi;print(jedi.__version__)'], { encoding: 'utf8' });
      if (v.status === 0) jedi = (v.stdout || '').trim();
    } catch {
      // leave '?'
    }
    return {
      python,
      jedi,
      pyright: resolvePyrightArgv() !== null,
      excludeDirs: excludeDirsFingerprint(),
    };
  }

  async extract(fileId: string): Promise<FileAstResponse | undefined> {
    const res = (await this.request('extract', { fileId })) as {
      ast: FileAstResponse | null;
    };
    return res.ast ?? undefined;
  }

  async readSource(fileId: string): Promise<string | undefined> {
    const res = (await this.request('source', { fileId })) as {
      source: string | null;
    };
    return res.source ?? undefined;
  }

  async validate(
    fileId: string,
    text: string,
  ): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    // The helper returns `valid` (not `ok`) — the RPC layer reserves `ok` for
    // transport success and overwrites it on the way out.
    const res = (await this.request('validate', { fileId, text })) as {
      valid: boolean;
      diagnostics: Diagnostic[];
    };
    return { ok: res.valid, diagnostics: res.diagnostics };
  }

  async applyChange(
    kind: 'changed' | 'added' | 'removed',
    fileId: string,
  ): Promise<FileUpdate> {
    const res = (await this.request('applyChange', { kind, fileId })) as {
      file: FileNode | null;
      ast: FileAstResponse | null;
    };
    return { file: res.file ?? undefined, ast: res.ast ?? undefined };
  }

  async buildEdges(
    fromFileIds: ReadonlySet<string>,
  ): Promise<{ imports: ImportEdge[]; semanticEdges: SemanticEdge[] }> {
    const res = (await this.request('buildEdges', {
      fromFileIds: [...fromFileIds],
    })) as { imports: ImportEdge[]; semanticEdges: SemanticEdge[] };
    return { imports: res.imports, semanticEdges: res.semanticEdges };
  }

  async importersOf(fileId: string): Promise<string[]> {
    const res = (await this.request('importersOf', { fileId })) as {
      importers: string[];
    };
    return res.importers;
  }

  watches(absPath: string): boolean {
    if (absPath.split(/[\\/]/).some((seg) => isExcludedDir(seg))) return false;
    return /\.(py|pyi)$/.test(absPath);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.write(JSON.stringify({ id: this.nextId++, op: 'close' }) + '\n');
    } catch {
      // stdin may already be gone; fall through to kill.
    }
    this.rejectAllPending(new Error('Python analyzer closed'));
    // Give the helper a beat to exit cleanly, then force it.
    proc.kill();
  }

  // --- internals ---------------------------------------------------------

  private spawnHelper(): void {
    if (this.proc) return;
    const helperPath = fileURLToPath(
      new URL('./python/analyzer_helper.py', import.meta.url),
    );
    const proc = spawn(this.interpreter, [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      // Helper diagnostics — surface them but don't treat as protocol.
      process.stderr.write(`[python-helper] ${chunk}`);
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (!this.closed) {
        this.rejectAllPending(
          new Error(`Python helper exited unexpectedly (code ${code ?? 'null'})`),
        );
      }
    });
    proc.on('error', (err) => {
      this.rejectAllPending(
        new Error(`Failed to run Python helper: ${err.message}`),
      );
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; ok?: boolean; error?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[python-helper] non-JSON stdout: ${line}\n`);
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (msg.ok === false) {
        entry.reject(new Error(msg.error ?? 'Python helper error'));
      } else {
        entry.resolve(msg);
      }
    }
  }

  private request(op: string, payload: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc || this.closed) {
      return Promise.reject(new Error('Python helper is not running'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

// Resolve a usable Python interpreter: an explicit override, then python3,
// then python (Windows often only has the latter). Requires >=3.9 for
// ast.unparse.
function findInterpreter(): string {
  const candidates = [process.env.CODE_GRAPH_PYTHON, 'python3', 'python'].filter(
    (c): c is string => !!c,
  );
  for (const cmd of candidates) {
    const probe = spawnSync(
      cmd,
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 3)'],
      { stdio: 'ignore' },
    );
    if (probe.status === 0) return cmd;
  }
  throw new Error(
    'Python project detected, but no usable Python 3.9+ interpreter was found. ' +
      'Install Python 3.9+ or set CODE_GRAPH_PYTHON to its path.',
  );
}

// Argv to launch pyright's language server over stdio, or null when pyright
// isn't resolvable (the helper then uses Jedi only). Honors a
// CODE_GRAPH_PYRIGHT override (a langserver command), else resolves the bundled
// `pyright` npm package and runs it with this process's Node.
function resolvePyrightArgv(): string[] | null {
  const override = process.env.CODE_GRAPH_PYRIGHT;
  if (override) return [override, '--stdio'];
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('pyright/langserver.index.js');
    return [process.execPath, entry, '--stdio'];
  } catch {
    return null;
  }
}

function ensureJedi(interpreter: string): void {
  const probe = spawnSync(interpreter, ['-c', 'import jedi'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    throw new Error(
      `Python project detected, but '${interpreter}' cannot import jedi. ` +
        "Install it with 'pip install jedi', or set CODE_GRAPH_PYTHON to an interpreter that has it.",
    );
  }
}
