import { useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { openProject, subscribeToWatch, type WatchEvent } from './api/client';
import { useGraphStore } from './graph/store';
import { PixiCanvas } from './render/PixiCanvas';
import { EdgeFilterPills } from './ui/EdgeFilterPills';
import { HoverTooltip } from './ui/HoverTooltip';
import { EditorPane } from './ui/EditorPane';
import { FolderPicker } from './ui/FolderPicker';
import type { AstNode, FileNode, ProjectResponse } from './api/types';

export function App() {
  const project = useGraphStore((s) => s.project);
  const setProject = useGraphStore((s) => s.setProject);
  const refreshProject = useGraphStore((s) => s.refreshProject);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Last-opened path is restored from localStorage so a dev-server reload
  // (triggered by editing force-graph tunables — see the HMR hook in
  // PixiCanvas.tsx) lands back where we left off instead of on the empty
  // form. Read once via useState's initializer so it's available on first
  // render — both for auto-reopen and for seeding the FolderPicker input.
  const [initialPath] = useState<string>(() => {
    try { return localStorage.getItem('code-graph:lastPath') ?? ''; } catch { return ''; }
  });

  async function handleOpen(path: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await openProject({ path });
      setProject(data);
      // Only stored on success so a bad path can't trap us across reloads.
      try { localStorage.setItem('code-graph:lastPath', path); } catch {}
      console.log('[code-graph] project loaded', data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProject(null);
    } finally {
      setLoading(false);
    }
  }

  // On mount, auto-reopen the saved path. Runs once; if it fails the error
  // surfaces in the FolderPicker and the user can pick a new path.
  useEffect(() => {
    if (initialPath) void handleOpen(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts for the focus / navigation HUD.
  //   Esc          — clear selection AND focus (return to overview).
  //   +/= / -      — widen / narrow the focus neighbourhood (hops).
  //                  '=' is included so it works without holding shift
  //                  on a US keyboard (where shift+= produces '+').
  // Ignored while the user is typing in an input / textarea (so we
  // don't hijack typing in the FolderPicker or the search palette).
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const st = useGraphStore.getState();
      if (e.key === 'Escape') {
        st.setSelection(null);
        st.setFocus(null);
        return;
      }
      if (e.key === '+' || e.key === '=') {
        if (st.focusId == null) return;
        e.preventDefault();
        st.setFocus(st.focusId, Math.min(8, st.focusHops + 1));
        return;
      }
      if (e.key === '-' || e.key === '_') {
        if (st.focusId == null) return;
        e.preventDefault();
        st.setFocus(st.focusId, Math.max(1, st.focusHops - 1));
        return;
      }
      // Direction toggles for the reverse-call query. 'R' is the
      // VS Code 'find references' instinct (incoming edges). The
      // arrow-like '[' / ']' cycle through both → out → in → both.
      if (st.focusId != null) {
        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          st.setFocusDirection(st.focusDirection === 'in' ? 'both' : 'in');
          return;
        }
        if (e.key === ']') {
          e.preventDefault();
          const next: 'both' | 'in' | 'out' =
            st.focusDirection === 'both'
              ? 'out'
              : st.focusDirection === 'out'
                ? 'in'
                : 'both';
          st.setFocusDirection(next);
          return;
        }
        if (e.key === '[') {
          e.preventDefault();
          const next: 'both' | 'in' | 'out' =
            st.focusDirection === 'both'
              ? 'in'
              : st.focusDirection === 'in'
                ? 'out'
                : 'both';
          st.setFocusDirection(next);
          return;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Subscribe to filesystem events for the current project; on any event,
  // re-run openProject (debounced) and update via refreshProject. Camera +
  // expansion state are preserved across the swap (see store + PixiCanvas).
  useEffect(() => {
    if (!project) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = async (rootPath: string) => {
      setRefreshing(true);
      try {
        const data = await openProject({ path: rootPath });
        refreshProject(data);
        console.log(
          `[code-graph] refreshed: ${data.files.length} files, ${data.edges.length} imports, ${data.semanticEdges.length} semantic`,
        );
      } catch (e) {
        console.error('[code-graph] refresh failed', e);
      } finally {
        setRefreshing(false);
      }
    };
    const unsub = subscribeToWatch(project.projectId, (event: WatchEvent) => {
      console.log('[code-graph] fs event', event);
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        void refresh(project.rootPath);
      }, 300);
    });
    return () => {
      unsub();
      if (pending) clearTimeout(pending);
    };
  }, [project?.projectId, project?.rootPath, refreshProject]);

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: '0.5rem 1rem',
          borderBottom: '1px solid #2c2c30',
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
          background: '#1d1d20',
        }}
      >
        <strong style={{ letterSpacing: 0.5 }}>code-graph</strong>
        <FolderPicker
          onSubmit={handleOpen}
          loading={loading}
          error={error}
          initialPath={initialPath}
        />
        {project ? <ProjectStats project={project} refreshing={refreshing} /> : null}
      </header>

      <main style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {project ? (
          <Group orientation="horizontal" style={{ width: '100%', height: '100%' }}>
            <Panel defaultSize="62%" minSize="30%">
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <PixiCanvas project={project} />
                <SelectionPanel />
                <EdgeFilterPills />
                <HoverTooltip />
                <Hints />
              </div>
            </Panel>
            <Separator
              style={{
                width: 4,
                background: '#2c2c30',
                cursor: 'col-resize',
              }}
            />
            <Panel defaultSize="38%" minSize="20%">
              <EditorPane project={project} />
            </Panel>
          </Group>
        ) : (
          <EmptyHint />
        )}
      </main>
    </div>
  );
}

function ProjectStats({
  project,
  refreshing,
}: {
  project: ProjectResponse;
  refreshing: boolean;
}) {
  return (
    <span style={{ marginLeft: 'auto', opacity: 0.7, fontSize: '0.85rem' }}>
      {refreshing ? 'syncing… · ' : ''}
      {project.files.length} files · {project.edges.length} imports ·{' '}
      {project.semanticEdges.length} semantic
    </span>
  );
}

function EmptyHint() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        opacity: 0.6,
        pointerEvents: 'none',
      }}
    >
      <p>Paste an absolute path to a TypeScript project (with a tsconfig.json) above.</p>
    </div>
  );
}

function Hints() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: '0.6rem',
        left: '0.8rem',
        fontSize: '0.75rem',
        opacity: 0.7,
        pointerEvents: 'none',
        fontFamily: 'ui-monospace, monospace',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
      }}
    >
      <div style={{ opacity: 0.7 }}>
        drag = pan · wheel = zoom · click file = expand/collapse · click AST rect = select
      </div>
      <div style={{ display: 'flex', gap: '0.9rem' }}>
        <LegendDot color="#666670" label="imports" />
        <LegendDot color="#ff8b3d" label="calls" />
        <LegendDot color="#9aa3ff" label="extends" />
        <LegendDot color="#60d0c0" label="implements" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 18,
          height: 2,
          background: color,
          borderRadius: 1,
        }}
      />
      {label}
    </span>
  );
}

function SelectionPanel() {
  const project = useGraphStore((s) => s.project);
  const selection = useGraphStore((s) => s.selection);
  const asts = useGraphStore((s) => s.asts);
  if (!project || !selection) return null;

  const fileMatch = project.files.find((f) => f.id === selection);
  if (fileMatch) {
    return <FilePanel file={fileMatch} project={project} />;
  }
  const astMatch = findAstNode(asts, selection);
  if (astMatch) {
    return <AstPanel node={astMatch.node} fileId={astMatch.fileId} />;
  }
  return null;
}

function findAstNode(
  asts: ReadonlyMap<string, { nodes: AstNode[] }>,
  id: string,
): { fileId: string; node: AstNode } | null {
  // The id format is `${fileId}#${seq}` so we can short-circuit by fileId.
  const hash = id.lastIndexOf('#');
  if (hash > 0) {
    const fileId = id.slice(0, hash);
    const ast = asts.get(fileId);
    if (ast) {
      const node = ast.nodes.find((n) => n.id === id);
      if (node) return { fileId, node };
    }
  }
  for (const [fileId, ast] of asts) {
    const node = ast.nodes.find((n) => n.id === id);
    if (node) return { fileId, node };
  }
  return null;
}

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: '1rem',
  right: '1rem',
  background: 'rgba(28,28,32,0.92)',
  border: '1px solid #38383c',
  borderRadius: 6,
  padding: '0.75rem 0.9rem',
  minWidth: '18rem',
  maxWidth: '24rem',
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.8rem',
  backdropFilter: 'blur(6px)',
};

function FilePanel({ file, project }: { file: FileNode; project: ProjectResponse }) {
  const inEdges = project.edges.filter((e) => e.toId === file.id);
  const outEdges = project.edges.filter((e) => e.fromId === file.id);
  return (
    <aside style={PANEL_STYLE}>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem', wordBreak: 'break-all' }}>
        {file.relativePath}
      </div>
      <div style={{ opacity: 0.7, marginBottom: '0.5rem' }}>
        {file.lineCount} lines · {file.sizeBytes} bytes
      </div>
      <div>
        <div style={{ opacity: 0.7 }}>imports → ({outEdges.length})</div>
        <ul style={{ margin: '0.15rem 0 0.4rem 1rem', padding: 0 }}>
          {outEdges.map((e) => (
            <li key={e.id}>{e.toId}</li>
          ))}
        </ul>
        <div style={{ opacity: 0.7 }}>imported by ← ({inEdges.length})</div>
        <ul style={{ margin: '0.15rem 0 0 1rem', padding: 0 }}>
          {inEdges.map((e) => (
            <li key={e.id}>{e.fromId}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function AstPanel({ node, fileId }: { node: AstNode; fileId: string }) {
  return (
    <aside style={PANEL_STYLE}>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{node.syntaxKind}</div>
      {node.name ? (
        <div style={{ marginBottom: '0.25rem' }}>
          <span style={{ opacity: 0.6 }}>name: </span>
          <span>{node.name}</span>
        </div>
      ) : null}
      <div style={{ opacity: 0.7 }}>
        {fileId} · chars [{node.start}, {node.end})
      </div>
    </aside>
  );
}
