import { useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { AuthError, openProject, postPresence, subscribeToDeltas } from './api/client';
import { useConfigStore } from './graph/config/store';
import { listPatterns } from './graph/patterns/registry';
import { getSessionIdentity, usePresenceStore } from './graph/presence';
import { selfSavedFileIds, useGraphStore, type GraphStore } from './graph/store';
import { useSourceStore } from './graph/sourceStore';
import { PixiCanvas, requestSelectionFrame, type CameraApi } from './render/PixiCanvas';
import { ZoomControls } from './ui/ZoomControls';
import { PinControls } from './ui/PinControls';
import { SnapshotBar } from './ui/SnapshotBar';
import { applySnapshot, captureSnapshot, overwriteSnapshot } from './graph/snapshots/capture';
import { useSnapshotStore } from './graph/snapshots/store';
import { EdgeFilterPills } from './ui/EdgeFilterPills';
import { LayoutBar } from './ui/LayoutBar';
import { TopHudRow } from './ui/TopHudRow';
import { BottomHudStack } from './ui/BottomHudStack';
import { HoverTooltip } from './ui/HoverTooltip';
import { SearchPalette } from './ui/SearchPalette';
import { EditorPane, liveEditBuffer } from './ui/EditorPane';
import { ProjectPicker } from './ui/ProjectPicker';
import { SessionsPill } from './ui/SessionsPill';
import { addRecentPath } from './ui/recentPaths';
import type { FileNode, GraphDelta, PresenceState, ProjectResponse } from './api/types';

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
  // This window presented no/an invalid token — nothing will work until the
  // user opens the tokened URL the server prints, so show a dedicated screen.
  const [authFailed, setAuthFailed] = useState(false);
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
      if (e instanceof AuthError) setAuthFailed(true);
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
  //   +/= / -/_    — zoom the camera in / out (anchored at screen centre).
  //                  '=' is included so it works without holding shift
  //                  on a US keyboard (where shift+= produces '+').
  //   [ / ]        — narrow / widen the focus neighbourhood (hops).
  //   L / ⇧L       — cycle the layout pattern forward / back.
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
      // ] / [ widen / narrow the focus neighbourhood when a focus is active.
      // (These used to live on +/- before those became camera zoom.)
      if (e.key === ']') {
        if (st.focusId == null) return;
        e.preventDefault();
        st.setFocus(st.focusId, Math.min(8, st.focusHops + 1));
        return;
      }
      if (e.key === '[') {
        if (st.focusId == null) return;
        e.preventDefault();
        st.setFocus(st.focusId, Math.max(1, st.focusHops - 1));
        return;
      }
      // L cycles the layout pattern (⇧L goes back). Cycling rather than four
      // separate digit keys: 1-9 already belong to snapshots, and with only
      // four patterns you're never more than two presses from any of them.
      if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const ids = listPatterns().map((p) => p.id);
        const cfg = useConfigStore.getState();
        const i = ids.indexOf(cfg.config.layout.patternId);
        const step = e.shiftKey ? -1 : 1;
        cfg.setLayoutPattern(ids[(i + step + ids.length) % ids.length]);
        return;
      }
      // + / - zoom the camera, anchored at the screen centre (zoomBy →
      // applyZoom). Browser key repeat gives continuous zoom while held.
      // Factors are exact inverses so +,- round-trips to the same scale.
      if (
        st.project &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')
      ) {
        e.preventDefault();
        const zoomIn = e.key === '+' || e.key === '=';
        cameraApiRef.current?.zoomBy(zoomIn ? 1.25 : 1 / 1.25);
        return;
      }
      // Arrow keys pan the graph camera. The arrow points where you want to
      // look: the content slides opposite the camera's motion (ArrowRight ->
      // reveal content to the right -> world shifts left). Screen-space step so
      // it feels the same at any zoom; Shift covers ground faster. Browser key
      // repeat gives continuous panning while a key is held. Cmd/Ctrl/Alt combos
      // are left to the browser/OS. `preventDefault` stops the page scrolling.
      if (
        st.project &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 240 : 80;
        const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        cameraApiRef.current?.panBy(dx, dy);
        return;
      }
      // (Direction toggles for the reverse-call query were removed when
      // import-direction was moved to per-edge COLOUR: yellow = outgoing
      // from selection, blue = incoming to selection. The focusDirection
      // store field is dormant. [ and ] now adjust focus hops; R belongs
      // to the canvas's pin hotkeys.)
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
      // While FOLLOWING another session, deltas must not steal the view
      // either — the followed session's presence drives selection/camera.
      const followGuard = usePresenceStore.getState().followingId != null;
      const viewGuard = editGuard || selfGuard || followGuard;
      const touched: string[] = [];
      for (const d of buffer) {
        applyDelta(d);
        // Drop the changed file's cached source so consumers re-fetch fresh
        // text: JSX previews slice offsets out of it, and EditorPane mirrors
        // it into Monaco sibling models for cross-file IntelliSense.
        useSourceStore.getState().invalidate(d.fileId);
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
    const unsub = subscribeToDeltas(
      project.projectId,
      (delta) => {
        console.log(
          `[code-graph] delta ${delta.kind} ${delta.fileId}: ${delta.imports.length} imports, ${delta.semanticEdges.length} semantic`,
        );
        buffer.push(delta);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 120);
      },
      {
        // Announce this window as a session and mirror the server's roster /
        // presence fan-out into the presence store (HUD + follow read it).
        identity: getSessionIdentity(),
        onSessions: (sessions) =>
          usePresenceStore.getState().setSessions(sessions),
        onPresence: (e) =>
          usePresenceStore.getState().setPresence(e.sessionId, e.state),
      },
    );
    return () => {
      unsub();
      usePresenceStore.getState().clear();
      if (flushTimer) clearTimeout(flushTimer);
      if (clearFlash) clearTimeout(clearFlash);
    };
  }, [project?.projectId, applyDelta, setSelection]);

  // --- Presence: report / follow -------------------------------------------
  // Report this window's state on a 200ms clock, skipping ticks where nothing
  // changed (the JSON snapshot doubles as the change key). Polling — rather
  // than subscribing to every store — keeps one cheap code path that also
  // captures camera pans and edit-buffer keystrokes, which live outside React
  // state entirely.
  useEffect(() => {
    if (!project) return;
    const projectId = project.projectId;
    const identity = getSessionIdentity();
    let lastSent = '';
    const timer = setInterval(() => {
      // Solo? Nothing is listening; skip the wire entirely.
      if (usePresenceStore.getState().sessions.length <= 1) return;
      const st = useGraphStore.getState();
      const editFileId = st.editMode ? st.editFileId : null;
      const state: PresenceState = {
        selection: st.selection,
        selectionSet: [...st.selectionSet],
        expandedAstNodes: [...st.expandedAstNodes],
        previewedAstNodes: [...st.previewedAstNodes],
        pins: cameraApiRef.current?.getPins() ?? [],
        overlayOffsets: cameraApiRef.current?.getOverlayOffsets() ?? [],
        camera: cameraApiRef.current?.getCamera() ?? null,
        editFileId,
        bufferText: editFileId ? liveEditBuffer.text : null,
        dirty: editFileId ? liveEditBuffer.dirty : false,
      };
      const key = JSON.stringify(state);
      if (key === lastSent) return;
      lastSent = key;
      postPresence(projectId, identity.id, state);
    }, 200);
    return () => clearInterval(timer);
  }, [project?.projectId]);

  // Follow: mirror the followed session's presence as it streams in.
  // Selection applies directly; camera goes through setCamera with animate so
  // the 200ms-spaced updates ease into each other, and its anchor field
  // re-frames against a FILE — robust to the two windows' force layouts
  // having placed things differently.
  useEffect(() => {
    let lastCameraKey = '';
    let lastPinsKey = '';
    let lastOverlayKey = '';
    const unsub = usePresenceStore.subscribe((s, prev) => {
      const fid = s.followingId;
      if (!fid) return;
      const p = s.presence.get(fid);
      if (!p) return;
      // Apply on either trigger: their presence changed, OR we JUST started
      // following (their last-known state is already in the store and won't
      // re-fire on its own — an idle session would otherwise never mirror).
      const justStarted = fid !== prev.followingId;
      if (!justStarted && p === prev.presence.get(fid)) return;
      const gs = useGraphStore.getState();
      // Mirror selection + drill-down state wholesale (that's what following
      // means), but only patch the slices whose MEMBERSHIP differs — a new
      // Set identity per presence tick (camera pans arrive every 200ms) would
      // otherwise churn the renderer's expansion effects for nothing. The
      // renderer fetches ASTs for newly-expanded files itself, so mirroring
      // the id sets is sufficient.
      // Partial<GraphStore>, not Partial<Parameters<setState>[0]> — setState's
      // first parameter is a union with the updater-function form, so indexing
      // into it doesn't resolve the store's own fields.
      const patch: Partial<GraphStore> = {};
      const selSet = new Set(p.selectionSet);
      if (p.selection !== gs.selection || !sameStringSet(selSet, gs.selectionSet)) {
        patch.selection = p.selection;
        patch.selectionSet = selSet;
      }
      const mirrorSet = (
        incoming: readonly string[] | undefined,
        current: ReadonlySet<string>,
        key: 'expandedAstNodes' | 'previewedAstNodes',
      ) => {
        const next = new Set(incoming ?? []);
        if (!sameStringSet(next, current)) patch[key] = next;
      };
      mirrorSet(p.expandedAstNodes, gs.expandedAstNodes, 'expandedAstNodes');
      mirrorSet(p.previewedAstNodes, gs.previewedAstNodes, 'previewedAstNodes');
      if (Object.keys(patch).length > 0) useGraphStore.setState(patch);
      // Pins reproduce the followed session's manual arrangement. Key-guarded
      // because setPins is a full replace (unpin-all + re-pin + sim reheat) —
      // it must run only when the pin set actually changed, not on every
      // camera tick.
      if (p.pins) {
        const key = JSON.stringify(p.pins);
        if (key !== lastPinsKey) {
          lastPinsKey = key;
          cameraApiRef.current?.setPins(p.pins as { id: string; x: number; y: number }[]);
        }
      }
      // Dragged-aside block overlays: relative offsets, safe to replace
      // wholesale (the renderer reads the map per frame).
      if (p.overlayOffsets) {
        const key = JSON.stringify(p.overlayOffsets);
        if (key !== lastOverlayKey) {
          lastOverlayKey = key;
          cameraApiRef.current?.setOverlayOffsets(p.overlayOffsets);
        }
      }
      if (p.camera) {
        const key = JSON.stringify(p.camera);
        if (key !== lastCameraKey) {
          lastCameraKey = key;
          cameraApiRef.current?.setCamera(p.camera, { animate: true });
        }
      }
    });
    return unsub;
  }, []);

  // Break follow on any LOCAL interaction (Figma/Live Share convention):
  // pointer or wheel on the canvas half means the user took the controls
  // back. Capture phase so it fires regardless of what the canvas does with
  // the event. (The SessionsPill lives in the header, outside this handler,
  // so clicking unfollow there doesn't double-trigger.)
  const breakFollow = () => {
    if (usePresenceStore.getState().followingId) {
      usePresenceStore.getState().setFollowing(null);
    }
  };

  // Entering edit mode (e.g. via the 'e' hotkey while the canvas is focused)
  // auto-expands the editor panel so the user can actually see what they're
  // editing.
  const editMode = useGraphStore((s) => s.editMode);

  // Local edit mode is also "taking the controls back" — and the editor pane
  // is busy mirroring the followed buffer while following, so the two can't
  // coexist.
  useEffect(() => {
    if (editMode) breakFollow();
  }, [editMode]);
  useEffect(() => {
    if (!editMode) return;
    const p = editorPanelRef.current;
    if (p && p.isCollapsed()) p.expand();
  }, [editMode]);

  if (authFailed) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', maxWidth: '32rem', lineHeight: 1.6 }}>
          <h2>Missing or invalid token</h2>
          <p style={{ opacity: 0.7 }}>
            This window isn&apos;t authorized to talk to the code-graph server. Open the URL
            printed in the <code>npm run dev</code> terminal (it looks like{' '}
            <code>http://localhost:5173/?token=…</code>).
          </p>
        </div>
      </div>
    );
  }

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
        <ProjectPicker
          onSubmit={handleOpen}
          loading={loading}
          error={error}
          currentPath={project?.rootPath ?? (initialPath || undefined)}
          onAuthError={() => setAuthFailed(true)}
        />
        {project ? <ProjectStats project={project} refreshing={refreshing} /> : null}
        {project ? <SessionsPill /> : null}
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
              <div
                style={{ position: 'relative', width: '100%', height: '100%' }}
                onPointerDownCapture={breakFollow}
                onWheelCapture={breakFollow}
              >
                <PixiCanvas project={project} cameraApiRef={cameraApiRef} />
                <SelectionPanel />
                <TopHudRow>
                  <EdgeFilterPills />
                  <LayoutBar />
                </TopHudRow>
                <ZoomControls api={cameraApiRef} />
                <BottomHudStack>
                  <PinControls api={cameraApiRef}>
                    <SnapshotBar api={cameraApiRef} rootPath={project.rootPath} />
                  </PinControls>
                  <Hints />
                </BottomHudStack>
                <HoverTooltip />
                <SearchPalette
                  open={searchOpen}
                  onClose={() => setSearchOpen(false)}
                />
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
      <p>Pick a project from the list above.</p>
    </div>
  );
}

// Every shortcut in one place, behind a `?` toggle and closed by default.
//
// This footer used to sit open permanently, three lines of text across the
// bottom of the canvas — a reference you read once and then look past forever,
// while it keeps covering the graph. The selection/focus keys additionally
// lived somewhere else entirely, inline in EdgeFilterPills, appearing only once
// a focus was active: exactly when you already knew about them, and never when
// you were looking for them. They're folded in here with the rest.
//
// The toggle stays mounted so there's always an affordance saying shortcuts
// exist; only the panel is conditional. Positioned by BottomHudStack, which
// anchors this at the bottom so the panel opens UPWARD and the button doesn't
// move out from under the cursor.
function Hints() {
  const [open, setOpen] = useState(false);
  return (
    <div style={hintsWrapStyle}>
      {open && (
        <div style={hintsPanelStyle}>
          <div>drag bg = pan · drag file/folder = pin · wheel = zoom · click file = expand/collapse · click AST rect = select</div>
          <div>⇧+click = multi-select · ⇧+drag = marquee select · [ / ] = narrow/widen focus · Esc = clear selection + focus</div>
          <div>U = unpin hovered · R = reset all pins · P = pin visible · ⇧P = pin all</div>
          <div>S = save view · ⇧S = overwrite · 1–9 = jump to view · L = cycle layout · +/− = zoom · arrows = pan</div>
          <div>⌘K = search symbols · E = edit selected file</div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide shortcuts' : 'Show shortcuts'}
        aria-label="Shortcuts"
        style={hintsToggleStyle(open)}
      >
        ?
      </button>
    </div>
  );
}

const hintsWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.4rem',
  pointerEvents: 'auto',
  fontFamily: 'ui-monospace, monospace',
};

const hintsPanelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.5rem 0.65rem',
  borderRadius: 8,
  background: 'rgba(22, 22, 26, 0.92)',
  boxShadow: 'inset 0 0 0 1px rgba(120, 120, 130, 0.3)',
  backdropFilter: 'blur(6px)',
  color: '#cfcfd6',
  fontSize: '0.75rem',
  opacity: 0.85,
  // Against the canvas width (BottomHudStack spans it), not the viewport, so
  // the panel never runs under the editor pane.
  maxWidth: '100%',
};

function hintsToggleStyle(open: boolean): React.CSSProperties {
  return {
    appearance: 'none',
    border: 0,
    borderRadius: 999,
    // Flex-centre the glyph: a fixed-size button won't centre a single
    // character on its own.
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    width: '1.5rem',
    height: '1.5rem',
    padding: 0,
    background: open ? '#3a6fb0' : 'rgba(40, 40, 46, 0.85)',
    color: open ? '#fff' : '#b0b0b8',
    boxShadow: 'inset 0 0 0 1px rgba(120, 120, 130, 0.35)',
    fontFamily: 'inherit',
    fontSize: '0.72rem',
    cursor: 'pointer',
    backdropFilter: 'blur(6px)',
  };
}

function SelectionPanel() {
  const project = useGraphStore((s) => s.project);
  const selection = useGraphStore((s) => s.selection);
  if (!project || !selection) return null;

  // Files only. Selected AST nodes used to get a descriptive card here
  // (syntaxKind / name / char range), but the canvas rect + the editor
  // pane's highlight already say everything it did.
  const fileMatch = project.files.find((f) => f.id === selection);
  if (fileMatch) {
    return <FilePanel file={fileMatch} project={project} />;
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

