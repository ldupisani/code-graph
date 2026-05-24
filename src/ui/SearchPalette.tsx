import { useEffect, useMemo, useRef, useState } from 'react';
import { getFileAst } from '../api/client';
import { useGraphStore } from '../graph/store';
import type { AstNode, FileNode, ProjectResponse } from '../api/types';

// Modal "jump to symbol" palette. Opened by Cmd/Ctrl-K (wired in
// App.tsx), closed by Esc / click outside / Enter on a result.
// Indexes file names + every NAMED AST node across the project.
// First open pre-fetches all ASTs (lazy — no work until the user
// asks for it); subsequent opens reuse the index until the project
// changes.
//
// Inline-styled per the existing HUD pattern (SelectionPanel /
// EdgeFilterPills / Hints). No portal — the <dialog> element places
// itself on the top layer automatically via showModal().

interface SearchEntry {
  id: string;            // hit id: file id, or AST node id
  name: string;          // searchable text
  display: string;       // what to show as the primary line
  context: string;       // secondary line (file path / breadcrumb)
  kind: 'file' | string; // 'file' or an AST syntaxKind
}

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useGraphStore((s) => s.project);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [indexState, setIndexState] = useState<'idle' | 'indexing' | 'ready'>(
    'idle',
  );
  // The index is kept in a ref so re-renders during typing don't
  // recompute it; we mutate it once at indexing time and read it on
  // every keystroke via useMemo (query -> sorted results).
  const indexRef = useRef<SearchEntry[]>([]);

  // Show / hide the native modal in sync with `open`. <dialog> is the
  // simplest path to a centred overlay with built-in Esc handling and
  // backdrop dimming; no portal infra needed.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
      setQuery('');
      setCursor(0);
      // Autofocus the input — showModal puts focus on the dialog
      // itself, so we lift it onto the search field on next tick.
      queueMicrotask(() => inputRef.current?.focus());
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Build the index once per project, lazily on first open. Re-builds
  // when project identity changes (setProject / refreshProject reset
  // asts to a new Map, which we read as a project boundary).
  const projectId = project?.projectId ?? null;
  const builtForProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !project) return;
    if (builtForProjectIdRef.current === projectId && indexState === 'ready') {
      return;
    }
    let cancelled = false;
    setIndexState('indexing');
    void (async () => {
      // Fetch any missing ASTs in parallel. We respect the existing
      // store cache so repeat opens don't refetch.
      const cached = useGraphStore.getState().asts;
      const missing = project.files.filter((f) => !cached.has(f.id));
      try {
        const fetched = await Promise.all(
          missing.map((f) => getFileAst(project.projectId, f.id)),
        );
        if (cancelled) return;
        // Push everything into the store in one go so future searches
        // hit cache.
        const store = useGraphStore.getState();
        for (let i = 0; i < missing.length; i++) {
          store.setFileAst(missing[i].id, fetched[i]);
        }
        const allAsts = useGraphStore.getState().asts;
        indexRef.current = buildIndex(project, allAsts);
        builtForProjectIdRef.current = projectId;
        if (!cancelled) setIndexState('ready');
      } catch {
        if (!cancelled) setIndexState('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  // Filter + sort on every query change. Caps at 80 results so the
  // list stays scrollable + fast.
  const results = useMemo(() => {
    if (indexState !== 'ready') return [];
    const q = query.trim();
    if (q.length === 0) {
      // Empty query: show files first (they're the user's primary
      // landmarks), then a sample of top-level symbols.
      return indexRef.current
        .filter((e) => e.kind === 'file')
        .slice(0, 60);
    }
    const scored: { e: SearchEntry; s: number }[] = [];
    for (const e of indexRef.current) {
      const s = fuzzyScore(e.name, q);
      if (s > 0) scored.push({ e, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 80).map(({ e }) => e);
  }, [query, indexState]);

  function selectResult(e: SearchEntry): void {
    const state = useGraphStore.getState();
    // File expansion is now zoom-driven (see PixiCanvas's
    // syncExpansion): a selected file expands when the user zooms
    // past the connectivity transition. The palette no longer
    // toggles expandFile itself — it would just get undone on the
    // next frame at the current zoom. The user zooms in to reveal.
    state.setSelection(e.id);
    state.setFocus(e.id);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[cursor];
      if (r) selectResult(r);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // Click on the backdrop (dialog itself, not its inner box)
        // closes the palette. Inner box clicks bubble up; we use
        // the target check to distinguish.
        if (e.target === dialogRef.current) onClose();
      }}
      style={{
        padding: 0,
        border: 0,
        background: 'transparent',
        marginTop: '12vh',
        maxWidth: '60vw',
      }}
    >
      <div
        onKeyDown={onKeyDown}
        style={{
          background: 'rgba(24, 24, 28, 0.96)',
          color: '#d4d4d4',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.85rem',
          border: '1px solid #38383c',
          borderRadius: 8,
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(12px)',
          width: '60vw',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={
            indexState === 'indexing'
              ? 'Indexing project…'
              : 'Search files, classes, functions, types…'
          }
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          style={{
            display: 'block',
            width: '100%',
            border: 0,
            background: 'transparent',
            outline: 'none',
            padding: '0.85rem 1rem',
            fontFamily: 'inherit',
            fontSize: '1rem',
            color: '#eeeeee',
            borderBottom: '1px solid #2c2c30',
          }}
        />
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            maxHeight: '50vh',
            overflowY: 'auto',
          }}
        >
          {results.map((e, i) => (
            <li
              key={e.id}
              onMouseEnter={() => setCursor(i)}
              onClick={() => selectResult(e)}
              style={{
                padding: '0.45rem 1rem',
                background: i === cursor ? 'rgba(58,111,176,0.22)' : 'transparent',
                display: 'flex',
                alignItems: 'baseline',
                gap: '0.6rem',
                cursor: 'pointer',
                borderLeft:
                  i === cursor
                    ? '2px solid #3a6fb0'
                    : '2px solid transparent',
              }}
            >
              <KindIcon kind={e.kind} />
              <span style={{ color: '#dcdcaa', flexShrink: 0 }}>{e.display}</span>
              <span
                style={{
                  opacity: 0.55,
                  fontSize: '0.78rem',
                  marginLeft: 'auto',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {e.context}
              </span>
            </li>
          ))}
          {results.length === 0 && indexState === 'ready' && (
            <li
              style={{
                padding: '0.7rem 1rem',
                opacity: 0.5,
                fontStyle: 'italic',
              }}
            >
              No matches.
            </li>
          )}
        </ul>
      </div>
    </dialog>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const glyph =
    kind === 'file'
      ? '📄'
      : kind === 'ClassDeclaration'
        ? 'C'
        : kind === 'InterfaceDeclaration'
          ? 'I'
          : kind === 'TypeAliasDeclaration'
            ? 'T'
            : kind === 'FunctionDeclaration' || kind === 'MethodDeclaration'
              ? 'ƒ'
              : kind === 'PropertyDeclaration' || kind === 'VariableDeclaration'
                ? 'v'
                : kind === 'EnumDeclaration'
                  ? 'E'
                  : '·';
  return (
    <span
      style={{
        display: 'inline-block',
        width: '1.1rem',
        textAlign: 'center',
        opacity: 0.7,
        color: kind === 'file' ? '#9cdcfe' : '#4ec9b0',
        fontSize: '0.85rem',
      }}
    >
      {glyph}
    </span>
  );
}

// Build the flat list of searchable entries for a project. Files
// always appear; AST nodes get an entry when they have a usable
// .name (declarations / typed members). Anonymous nodes are skipped
// — searching for them by name isn't useful.
function buildIndex(
  project: ProjectResponse,
  asts: ReadonlyMap<string, { nodes: AstNode[] }>,
): SearchEntry[] {
  const out: SearchEntry[] = [];
  // Files first — they're the most likely jump destination.
  for (const f of project.files) {
    out.push({
      id: f.id,
      name: shortName(f),
      display: shortName(f),
      context: f.relativePath,
      kind: 'file',
    });
  }
  // AST nodes — only declarations / structural kinds the user would
  // jump to. Anonymous expressions don't carry a useful name.
  for (const f of project.files) {
    const ast = asts.get(f.id);
    if (!ast) continue;
    const byId = new Map(ast.nodes.map((n) => [n.id, n]));
    for (const n of ast.nodes) {
      if (!n.name) continue;
      if (!INDEXED_KINDS.has(n.syntaxKind)) continue;
      out.push({
        id: n.id,
        name: n.name,
        display: n.name,
        context: `${breadcrumb(n, byId)} · ${f.relativePath}`,
        kind: n.syntaxKind,
      });
    }
  }
  return out;
}

const INDEXED_KINDS = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'InterfaceDeclaration',
  'EnumDeclaration',
  'TypeAliasDeclaration',
  'FunctionDeclaration',
  'MethodDeclaration',
  'PropertyDeclaration',
  'VariableDeclaration',
  'GetAccessor',
  'SetAccessor',
  'Constructor',
]);

function shortName(f: FileNode): string {
  const i = f.relativePath.lastIndexOf('/');
  return i < 0 ? f.relativePath : f.relativePath.slice(i + 1);
}

// "ClassName.methodName" / "Namespace.Type" — built by walking up
// parentIds and collecting any node with a non-null name.
function breadcrumb(
  node: AstNode,
  byId: Map<string, AstNode>,
): string {
  const parts: string[] = [];
  let cur: AstNode | undefined = node.parentId
    ? byId.get(node.parentId)
    : undefined;
  while (cur) {
    if (cur.name && cur.name !== node.name) parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join('.');
}

// Lightweight fuzzy match: case-insensitive subsequence + bonuses
// for prefix / contiguous run / case-match. Returns 0 when query
// chars can't be matched in order. ~80 lines, no dependencies.
function fuzzyScore(name: string, query: string): number {
  if (query.length === 0) return 1;
  if (query.length > name.length) return 0;
  const nameL = name.toLowerCase();
  const queryL = query.toLowerCase();
  // Quick exact-prefix bonus.
  if (nameL === queryL) return 1000;
  if (nameL.startsWith(queryL)) return 500 + (50 - Math.min(50, name.length));
  if (nameL.includes(queryL)) return 200 + (50 - Math.min(50, name.length));
  // Subsequence with contiguous-run bonus.
  let score = 0;
  let qi = 0;
  let lastIdx = -2;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (nameL[i] === queryL[qi]) {
      let bonus = 1;
      if (i === lastIdx + 1) bonus += 5; // contiguous run
      if (i === 0) bonus += 5; // matches first char
      if (name[i] === query[qi]) bonus += 1; // case match
      score += bonus;
      lastIdx = i;
      qi++;
    }
  }
  if (qi < query.length) return 0; // didn't match all chars
  // Penalty for long names so shorter matches surface first.
  return score + Math.max(0, 30 - name.length);
}
