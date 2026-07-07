import { useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { openProject, subscribeToDeltas } from './api/client';
import { selfSavedFileIds, useGraphStore } from './graph/store';
import { PixiCanvas, requestSelectionFrame, type CameraApi } from './render/PixiCanvas';
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
import { addRecentPath } from './ui/recentPaths';
import { SettingsPanel } from './ui/settings/SettingsPanel';
import type { AstNode, FileNode, GraphDelta, ProjectResponse } from './api/types';

// Membership equality for two string sets — used to detect whether a delta
// actually changed the selected-file set (and thus warrants a camera re-frame).
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export function App() {
  const project = useGraphStore((s) => s.project);
  const setProject = useGraphStore((s) => s.setProject);
  const applyDelta = useGraphStore((s) => s.applyDelta);
  const setSelection = useGraphStore((s) => s.setSelection);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Imperative camera handle the PixiCanvas fills in; drives the zoom buttons.
  const cameraApiRef = useRef<CameraApi | null>(null);
  // EditorPane registers its dirty-guarded edit-mode exit here so the global
  // Esc handler can trigger it (with a "discard unsaved edits?" confirm).
  const editExitRef = useRef<(() => void) | null>(null);

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

  // Per-window project identity lives in the URL (`?path=…`). Different browser
  // windows therefore hold different projects independently, a reload reopens
  // THIS window's project (and survives the dev-server reload the PixiCanvas HMR
  // hook triggers), and the URL is shareable. localStorage is NOT used as the
  // source of truth — it's shared across windows, so it would let one window's
  // open clobber another's. Read once via useState's initializer.
  const [initialPath] = useState<string>(() => {
    try { return new URLSearchParams(window.location.search).get('path') ?? ''; } catch { return ''; }
  });

  async function handleOpen(path: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await openProject({ path });
      setProject(data);
      // Reflect the open project in THIS window's URL so a reload reopens it.
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('path', path);
        window.history.replaceState(null, '', u);
      } catch {}
      addRecentPath(path);
      console.log('[code-graph] project loaded', data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProject(null);
    } finally {
      setLoading(false);
    }
  }

  // On mount, auto-reopen this window's project from its URL `?path=`. Runs
  // once; if it fails the error surfaces in the FolderPicker. Windows with no
  // `?path=` just show the picker.
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
      // Edit mode owns the keyboard: every canvas single-key hotkey yields to
      // typing. Only Esc is handled here — routed to EditorPane's dirty-guarded
      // exit. (Cmd-S is a Monaco command registered in EditorPane, not here.)
      if (useGraphStore.getState().editMode) {
        if (e.key === 'Escape') {
          e.preventDefault();
          (editExitRef.current ?? useGraphStore.getState().exitEditMode)();
        }
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
        // 'e' enters edit mode on the file owning the current selection (a file
        // id, or the file half of a `${fileId}#seq` AST-node id). EditorPane
        // becomes editable and the panel auto-expands (effect below).
        if (e.key === 'e' || e.key === 'E') {
          const sel = st.selection;
          if (sel) {
            const fileId = sel.includes('#') ? sel.slice(0, sel.lastIndexOf('#')) : sel;
            if (st.project.files.some((f) => f.id === fileId)) {
              e.preventDefault();
              st.enterEditMode(fileId);
            }
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

  // Subscribe to incremental graph deltas for the current project. Each
  // filesystem change streams a GraphDelta (changed file + recomputed edges
  // only) that we merge in place — no full re-walk, no renderer rebuild, so
  // camera, layout positions, selection, and config all survive the edit.
  useEffect(() => {
    if (!project) return;
    // Coalesce bursts of deltas (a formatter or `git checkout` can touch many
    // files at once) into a single flush so the renderer rebuilds once, not
    // once per file. Each merge preserves view/positions, but back-to-back
    // rebuilds would still thrash. A short trailing timer keeps single-save
    // latency low while batching multi-file storms.
    const buffer: GraphDelta[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let clearFlash: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      // Snapshot the selected-file set BEFORE merging so we can tell whether the
      // SET actually changes (a file enters/leaves the selection) vs just an
      // edit to an already-selected file.
      const before = new Set(useGraphStore.getState().selectionSet);
      // If every buffered delta is for the file the user is actively editing,
      // this is the echo of their own save (or an external edit to that same
      // file). Don't auto-select the file or re-frame — that would clobber the
      // user's AST-node selection and jump the camera mid-edit. Just merge.
      const st = useGraphStore.getState();
      const editGuard =
        st.editMode &&
        st.editFileId != null &&
        buffer.length > 0 &&
        buffer.every((d) => d.fileId === st.editFileId);
      // Echo of the user's own save: suppress auto-select/re-frame even after
      // "Save & exit" has left edit mode. Consume the markers as we go.
      const selfGuard =
        buffer.length > 0 && buffer.every((d) => selfSavedFileIds.has(d.fileId));
      for (const d of buffer) selfSavedFileIds.delete(d.fileId);
      const viewGuard = editGuard || selfGuard;
      const touched: string[] = [];
      for (const d of buffer) {
        applyDelta(d);
        if (d.kind !== 'removed') touched.push(d.fileId);
      }
      buffer.length = 0;
      if (!viewGuard) {
        // Auto-select ONLY the most-recently changed file (last delta in arrival
        // order), REPLACING any prior selection rather than accumulating. During a
        // rapid update burst the selection set would otherwise grow unboundedly and
        // the camera would lurch to re-frame an ever-wider spread of files. Tracking
        // just the latest file keeps the view pinned to one small target.
        const latest = touched.length > 0 ? touched[touched.length - 1] : null;
        if (latest && useGraphStore.getState().selection !== latest) setSelection(latest);
        // Re-frame the camera ONLY when the set of selected files changed — the
        // latest changed file became the (new) selection, or a selected file was
        // removed and pruned. Re-saving the file that's ALREADY the sole selection
        // leaves the set unchanged, so the camera stays exactly where it is.
        const after = useGraphStore.getState().selectionSet;
        if (!sameStringSet(before, after)) requestSelectionFrame();
      }
      setRefreshing(true);
      if (clearFlash) clearTimeout(clearFlash);
      clearFlash = setTimeout(() => setRefreshing(false), 400);
    };
    const unsub = subscribeToDeltas(project.projectId, (delta) => {
      console.log(
        `[code-graph] delta ${delta.kind} ${delta.fileId}: ${delta.imports.length} imports, ${delta.semanticEdges.length} semantic`,
      );
      buffer.push(delta);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 120);
    });
    return () => {
      unsub();
      if (flushTimer) clearTimeout(flushTimer);
      if (clearFlash) clearTimeout(clearFlash);
    };
  }, [project?.projectId, applyDelta, setSelection]);

  // Entering edit mode (e.g. via the 'e' hotkey while the canvas is focused)
  // auto-expands the editor panel so the user can actually see what they're
  // editing.
  const editMode = useGraphStore((s) => s.editMode);
  useEffect(() => {
    if (!editMode) return;
    const p = editorPanelRef.current;
    if (p && p.isCollapsed()) p.expand();
  }, [editMode]);

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
              <EditorPane project={project} exitRef={editExitRef} />
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
