import { useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { openProject, subscribeToWatch, type WatchEvent } from './api/client';
import { useGraphStore } from './graph/store';
import { PixiCanvas, type CameraApi } from './render/PixiCanvas';
import { ZoomControls } from './ui/ZoomControls';
import { PinControls } from './ui/PinControls';
import { SnapshotBar } from './ui/SnapshotBar';
import { applySnapshot, captureSnapshot, overwriteSnapshot } from './graph/snapshots/capture';
import { useSnapshotStore } from './graph/snapshots/store';
import { EdgeFilterPills } from './ui/EdgeFilterPills';
import { HoverTooltip } from './ui/HoverTooltip';
import { SearchPalette } from './ui/SearchPalette';
import { EditorPane } from './ui/EditorPane';
import { FolderPicker } from './ui/FolderPicker';
import { SettingsPanel } from './ui/settings/SettingsPanel';
import type { AstNode, FileNode, ProjectResponse } from './api/types';

export function App() {
  const project = useGraphStore((s) => s.project);
  const setProject = useGraphStore((s) => s.setProject);
  const refreshProject = useGraphStore((s) => s.refreshProject);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Imperative camera handle the PixiCanvas fills in; drives the zoom buttons.
  const cameraApiRef = useRef<CameraApi | null>(null);

  // Imperative handle for the right-hand editor Panel so a header button can
  // collapse / expand it. `editorCollapsed` mirrors its state to flip the
  // button label; kept in sync via the Panel's onResize. The PixiCanvas
  // observes its own container, so collapsing/expanding auto-resizes the canvas.
  const editorPanelRef = usePanelRef();
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  function toggleEditor() {
    const p = editorPanelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }

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

  // Cmd-K / Ctrl-K opens the symbol search palette. Kept in App
  // state so we can flip it from anywhere (keybinding here +
  // optional close from inside the palette).
  const [searchOpen, setSearchOpen] = useState(false);

  // Global keyboard shortcuts for the focus / navigation HUD + the
  // search palette.
  //   Cmd/Ctrl-K   — open symbol search.
  //   Esc          — clear selection AND focus (return to overview).
  //   +/= / -      — widen / narrow the focus neighbourhood (hops).
  //                  '=' is included so it works without holding shift
  //                  on a US keyboard (where shift+= produces '+').
  //   R / [ / ]    — focus-direction shortcuts (reverse-call query).
  // Ignored while the user is typing in an input / textarea (so we
  // don't hijack typing in the FolderPicker or the search palette).
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      // Cmd-K is the ONE binding that's allowed to interrupt typing —
      // standard 'jump to' affordance, users expect it even from
      // inside another text field.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (isTypingTarget(e.target)) return;
      const st = useGraphStore.getState();
      // View snapshots — only meaningful with a project open. Read project
      // from the store (not a stale closure) so this []-deps effect needn't
      // re-register. Modifier combos are left alone (Cmd-S = browser save).
      if (st.project && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          if (e.shiftKey) {
            // ⇧S overwrites the active view with the current one; if nothing's
            // active yet, fall back to saving a new view.
            const active = useSnapshotStore.getState().activeByProject[st.project.rootPath];
            if (active) overwriteSnapshot(active, cameraApiRef.current);
            else captureSnapshot(cameraApiRef.current);
          } else {
            captureSnapshot(cameraApiRef.current);
          }
          return;
        }
        if (e.key >= '1' && e.key <= '9') {
          const snap = (useSnapshotStore.getState().byProject[st.project.rootPath] ?? [])[
            e.key.charCodeAt(0) - 49 // '1' -> 0
          ];
          if (snap) {
            e.preventDefault();
            applySnapshot(snap, cameraApiRef.current);
          }
          return;
        }
      }
      if (e.key === 'Escape') {
        st.setSelection(null);
        st.setFocus(null);
        st.setTracedPath(null);
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
      // (Direction toggles for the reverse-call query — R / [ / ] —
      // were removed when import-direction was moved to per-edge
      // COLOUR: yellow = outgoing from selection, blue = incoming
      // to selection. The focusDirection store field is dormant; if
      // a future feature needs direction back, those keys are free.)
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
        {project ? (
          <button
            type="button"
            onClick={toggleEditor}
            title={editorCollapsed ? 'Show code editor' : 'Hide code editor'}
            style={{
              marginLeft: 'auto',
              appearance: 'none',
              border: '1px solid #3a3a40',
              borderRadius: 6,
              background: '#26262b',
              color: '#cfcfd6',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '0.75rem',
              padding: '0.25rem 0.6rem',
              cursor: 'pointer',
            }}
          >
            {editorCollapsed ? '‹ editor' : 'editor ›'}
          </button>
        ) : null}
      </header>

      <main style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {project ? (
          <Group orientation="horizontal" style={{ width: '100%', height: '100%' }}>
            <Panel defaultSize="62%" minSize="30%">
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <PixiCanvas project={project} cameraApiRef={cameraApiRef} />
                <SelectionPanel />
                <EdgeFilterPills />
                <SettingsPanel />
                <ZoomControls api={cameraApiRef} />
                <PinControls api={cameraApiRef}>
                  <SnapshotBar api={cameraApiRef} rootPath={project.rootPath} />
                </PinControls>
                <HoverTooltip />
                <SearchPalette
                  open={searchOpen}
                  onClose={() => setSearchOpen(false)}
                />
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
            <Panel
              defaultSize="38%"
              minSize="20%"
              collapsible
              collapsedSize={0}
              panelRef={editorPanelRef}
              onResize={(size) => setEditorCollapsed(size.asPercentage === 0)}
            >
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
        drag bg = pan · drag file/folder = pin · wheel = zoom · click file = expand/collapse · click AST rect = select
      </div>
      <div style={{ opacity: 0.7 }}>
        U = unpin hovered · R = reset all pins · P = pin visible · ⇧P = pin all
      </div>
      <div style={{ opacity: 0.7 }}>
        S = save view · ⇧S = overwrite active view · 1–9 = jump to view
      </div>
    </div>
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
  // Sits below the settings gear (top-right) so the gear stays clickable.
  top: '3.2rem',
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
  const inCount = project.edges.reduce(
    (n, e) => (e.toId === file.id ? n + 1 : n),
    0,
  );
  const outCount = project.edges.reduce(
    (n, e) => (e.fromId === file.id ? n + 1 : n),
    0,
  );
  return (
    <aside style={PANEL_STYLE}>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem', wordBreak: 'break-all' }}>
        {file.relativePath}
      </div>
      <div style={{ opacity: 0.7, marginBottom: '0.5rem' }}>
        {file.lineCount} lines · {file.sizeBytes} bytes
      </div>
      <div style={{ display: 'flex', gap: '1rem', opacity: 0.8 }}>
        {/* Counts only — the full lists of imported / importing files
            crowded the panel without adding navigational value (the
            files themselves are visible on the canvas; the panel is
            for at-a-glance metadata). */}
        <span>imports → {outCount}</span>
        <span>imported by ← {inCount}</span>
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
