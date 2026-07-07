import { Editor, type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConflictError,
  getSourceForEdit,
  validateSource,
  writeSource,
} from '../api/client';
import type {
  AstNode,
  ConflictResponse,
  Diagnostic,
  FileAstResponse,
  ProjectResponse,
} from '../api/types';
import { usePresenceStore } from '../graph/presence';
import { selfSavedFileIds, useGraphStore } from '../graph/store';
import { useSourceStore } from '../graph/sourceStore';

// The live (unsaved) edit buffer, exposed for the presence reporter in
// App.tsx: while this session is in edit mode, other sessions following it
// see these keystrokes streamed as PresenceState.bufferText. A plain module
// object (not store state) — it changes on every keystroke and nothing
// should re-render off it; the reporter samples it on its own clock.
export const liveEditBuffer: { text: string | null; dirty: boolean } = {
  text: null,
  dirty: false,
};

interface EditorPaneProps {
  project: ProjectResponse;
  // App registers our dirty-guarded exit handler here so the global Esc key can
  // trigger it. Optional so the component still renders standalone (Storybook).
  exitRef?: React.MutableRefObject<(() => void) | null>;
}

// One-time (per app, not per mount) configuration of Monaco's TS worker.
// Two decisions:
//   1. Semantic validation OFF. Monaco can never see npm packages' .d.ts or
//      the project's real tsconfig, so its semantic squiggles are false
//      positives by construction ("cannot find module 'zustand'", JSX
//      intrinsics, strictness mismatches). The save gate is the server's
//      syntax-only validate; semantic truth is the analysis graph itself.
//      Syntax validation stays ON for instant local feedback while typing.
//   2. Compiler options that make RELATIVE imports resolve across the
//      sibling models we feed it (see the closure-sync effect below), so
//      completions / hover / inherited members work cross-file.
// Runs via beforeMount with the LOADER's monaco instance — importing
// 'monaco-editor' directly would configure a different copy of Monaco than
// the one the Editor component actually uses.
let monacoConfigured = false;
function configureMonaco(mon: Monaco): void {
  if (monacoConfigured) return;
  monacoConfigured = true;
  const ts = mon.languages.typescript;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    defaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowJs: true,
      allowNonTsExtensions: true,
    });
  }
}

// Sibling models cap. The import closure of one file is usually small, but a
// hub file in a big project could pull in hundreds; past this many the worker
// gets the nearest N files (BFS order = closest hops first) and the rest
// simply don't resolve — degraded IntelliSense, never an error the user sees.
const MAX_SIBLING_MODELS = 75;

// Monaco syntax mode from the file extension. Monaco ships Python and
// TS/JS grammars; anything else falls back to plain text.
function languageForFile(fileId: string | null): string {
  if (!fileId) return 'plaintext';
  if (/\.(py|pyi)$/.test(fileId)) return 'python';
  if (/\.(ts|mts|cts)$/.test(fileId)) return 'typescript';
  if (/\.(tsx)$/.test(fileId)) return 'typescript';
  if (/\.(jsx?|mjs|cjs)$/.test(fileId)) return 'javascript';
  return 'plaintext';
}

interface ResolvedSelection {
  fileId: string;
  node: AstNode | null; // null when selection is the file itself
}

export function EditorPane({ project, exitRef }: EditorPaneProps) {
  const selection = useGraphStore((s) => s.selection);
  const asts = useGraphStore((s) => s.asts);
  const setSelection = useGraphStore((s) => s.setSelection);
  const editMode = useGraphStore((s) => s.editMode);
  const editFileId = useGraphStore((s) => s.editFileId);

  // Followed session's live edit, when there is one: while we're following a
  // session that is in edit mode, the pane mirrors their unsaved buffer
  // read-only instead of our own view (see the render branch below).
  const followedEdit = usePresenceStore((s) => {
    if (!s.followingId) return null;
    const p = s.presence.get(s.followingId);
    return p && p.editFileId != null && p.bufferText != null ? p : null;
  });
  const followedSession = usePresenceStore((s) =>
    s.followingId ? s.sessions.find((x) => x.id === s.followingId) ?? null : null,
  );

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // When we apply selection-to-editor we suppress the cursor handler so it
  // doesn't bounce back into setSelection on the same id.
  const applyingRemoteRef = useRef(false);
  // Guards onChange against our own programmatic setValue (discard / reload) so
  // it isn't mistaken for a user edit.
  const applyingProgrammaticRef = useRef(false);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);

  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // --- Edit state ----------------------------------------------------------
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [conflict, setConflict] = useState<ConflictResponse | null>(null);

  // The buffer the user is typing (kept in a ref so Monaco commands / debounced
  // callbacks read the latest without re-registering), the last-saved baseline
  // (dirty = current !== baseline), and the disk baseline for conflict checks.
  const currentTextRef = useRef('');
  const baselineTextRef = useRef('');
  const baseMtimeMsRef = useRef<number | null>(null);
  const baseHashRef = useRef<string | null>(null);
  // Monotonic token so a stale (slow) validate response can't overwrite a newer
  // one's diagnostics.
  const validateSeqRef = useRef(0);
  const validateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live mirrors read by the once-registered Cmd-S command / save().
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const hasErrorRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);
  const hasError = diagnostics.some((d) => d.severity === 'error');
  useEffect(() => {
    hasErrorRef.current = hasError;
  }, [hasError]);

  // Mirror of activeFileId that the cursor handler reads. The handler is
  // registered inside Monaco's onMount (which only fires once per editor
  // instance), so capturing activeFileId in its closure would freeze it to
  // whatever value it had the first time Editor rendered — and any cursor
  // change after a file swap would call setSelection with an AST node id
  // belonging to the *previous* file, causing the editor to revert.
  const activeFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);

  // The loader's monaco instance as STATE (monacoRef exists too, but a ref
  // change doesn't re-run effects) so the sibling-model sync below can begin
  // once the editor has mounted.
  const [monacoInst, setMonacoInst] = useState<Monaco | null>(null);

  // --- Monaco project context ------------------------------------------------
  // Transitive import closure of the active file: the sibling files Monaco
  // needs as models for relative imports and inherited members to resolve.
  // BFS over the file-level import graph (already on the client), nearest
  // hops first so the cap keeps the most relevant files. TS-only — Monaco
  // has no Python language service to feed.
  const closureFileIds = useMemo(() => {
    if (!activeFileId || project.language === 'python') return [];
    const importsOf = new Map<string, string[]>();
    for (const e of project.edges) {
      let targets = importsOf.get(e.fromId);
      if (!targets) importsOf.set(e.fromId, (targets = []));
      targets.push(e.toId);
    }
    const seen = new Set<string>([activeFileId]);
    const queue = [activeFileId];
    const result: string[] = [];
    while (queue.length > 0 && result.length < MAX_SIBLING_MODELS) {
      const cur = queue.shift();
      if (cur == null) break;
      for (const next of importsOf.get(cur) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        result.push(next);
        queue.push(next);
        if (result.length >= MAX_SIBLING_MODELS) break;
      }
    }
    return result;
  }, [activeFileId, project.edges, project.language]);

  // Mirror closure sources into Monaco models. sourceStore fetches and caches
  // each file (idempotent, fire-and-forget); when a fetch lands, `sources`
  // gets a new identity and this effect re-runs to create/refresh the model.
  // Deltas invalidate the changed file's entry (App.tsx flush), so an external
  // edit to a sibling re-fetches and re-syncs here. The ACTIVE file's model is
  // never touched — <Editor> owns it via the `path` prop.
  const sources = useSourceStore((s) => s.sources);
  useEffect(() => {
    if (!monacoInst || closureFileIds.length === 0) return;
    const { ensure } = useSourceStore.getState();
    for (const fileId of closureFileIds) {
      ensure(project.projectId, fileId);
      if (fileId === activeFileId) continue;
      const text = sources.get(fileId);
      if (text == null) continue; // fetch in flight; effect re-runs when it lands
      const uri = monacoInst.Uri.file('/' + fileId);
      const model = monacoInst.editor.getModel(uri);
      if (!model) monacoInst.editor.createModel(text, undefined, uri);
      else if (model.getValue() !== text) model.setValue(text);
    }
  }, [monacoInst, closureFileIds, sources, project.projectId, activeFileId]);

  // Project switch: dispose every file:// model except the one attached to
  // the editor (its lifecycle belongs to <Editor>). Two projects can share
  // relative paths ('src/index.ts'), so a stale model would otherwise leak
  // the old project's content into the new one's IntelliSense.
  useEffect(() => {
    if (!monacoInst) return;
    return () => {
      const attached = editorRef.current?.getModel() ?? null;
      for (const m of monacoInst.editor.getModels()) {
        if (m.uri.scheme === 'file' && m !== attached) m.dispose();
      }
    };
  }, [monacoInst, project.projectId]);

  const resolvedFromSelection = resolveSelection(selection, project, asts);

  // Which file to load. While editing, PIN to the edited file so clicking a
  // node in another file (or an auto-select from a delta) can't swap the buffer
  // out from under unsaved edits. Otherwise follow the selection.
  const targetFileId =
    editMode && editFileId ? editFileId : resolvedFromSelection?.fileId ?? null;

  const isEditing = editMode && editFileId === activeFileId;

  // --- Markers -------------------------------------------------------------
  const applyMarkers = useCallback((diags: Diagnostic[]) => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;
    const model = ed.getModel();
    if (!model) return;
    mon.editor.setModelMarkers(
      model,
      'codegraph',
      diags.map((d) => ({
        severity:
          d.severity === 'error'
            ? mon.MarkerSeverity.Error
            : mon.MarkerSeverity.Warning,
        message: d.message,
        startLineNumber: d.startLineNumber,
        startColumn: d.startColumn,
        endLineNumber: d.endLineNumber,
        endColumn: d.endColumn,
      })),
    );
  }, []);

  const clearMarkers = useCallback(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    const model = ed?.getModel();
    if (mon && model) mon.editor.setModelMarkers(model, 'codegraph', []);
  }, []);

  // Debounced validate — the save gate. Drops stale responses via a seq token.
  const scheduleValidate = useCallback(
    (text: string) => {
      if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
      validateTimerRef.current = setTimeout(() => {
        const seq = ++validateSeqRef.current;
        const forFile = activeFileIdRef.current;
        if (!forFile) return;
        validateSource(project.projectId, forFile, text)
          .then((res) => {
            if (seq !== validateSeqRef.current) return; // superseded
            if (activeFileIdRef.current !== forFile) return; // file swapped
            setDiagnostics(res.diagnostics);
            applyMarkers(res.diagnostics);
          })
          .catch(() => {
            // Validation endpoint hiccup: don't fabricate diagnostics (which
            // would wrongly block save); leave the last known state.
          });
      }, 300);
    },
    [project.projectId, applyMarkers],
  );

  // --- Load (disk-truth source + baseline) ---------------------------------
  useEffect(() => {
    if (!targetFileId) return;
    if (targetFileId === activeFileId) return;
    let cancelled = false;
    setError(null);
    getSourceForEdit(project.projectId, targetFileId)
      .then((res) => {
        if (cancelled) return;
        baselineTextRef.current = res.text;
        currentTextRef.current = res.text;
        baseHashRef.current = res.hash;
        baseMtimeMsRef.current = res.mtimeMs;
        setSource(res.text);
        setActiveFileId(targetFileId);
        setDirty(false);
        setDiagnostics([]);
        setConflict(null);
        clearMarkers();
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [targetFileId, activeFileId, project.projectId, clearMarkers]);

  // Reload the buffer when the ACTIVE file changes ON DISK. The load effect
  // above only fires on file SWAPS (targetFileId !== activeFileId), so an
  // in-place change — another session's save, an external editor — left the
  // pane showing stale text even while the graph (which gets a fresh AST via
  // the delta) had already updated. The delta replaces the file's entry in
  // `asts`, so that object's identity is our change signal. Never fires while
  // the user is editing: unsaved local work must not be clobbered — the save
  // path's conflict detection owns that case.
  const activeAst = activeFileId ? asts.get(activeFileId) : undefined;
  useEffect(() => {
    if (!activeFileId || !activeAst) return;
    if (useGraphStore.getState().editMode) return;
    let cancelled = false;
    getSourceForEdit(project.projectId, activeFileId)
      .then((res) => {
        if (cancelled) return;
        if (activeFileIdRef.current !== activeFileId) return; // swapped meanwhile
        if (res.text === baselineTextRef.current) return; // no content change
        baselineTextRef.current = res.text;
        currentTextRef.current = res.text;
        baseHashRef.current = res.hash;
        baseMtimeMsRef.current = res.mtimeMs;
        setSource(res.text);
        setDirty(false);
      })
      .catch(() => {
        // Transient fetch failure: keep showing the last-loaded text; the
        // next delta (or file swap) retries.
      });
    return () => {
      cancelled = true;
    };
  }, [activeAst, activeFileId, project.projectId]);

  // Focus the editor when entering edit mode so the user can just start typing.
  useEffect(() => {
    if (isEditing) editorRef.current?.focus();
  }, [isEditing]);

  // Selection -> editor: scroll to range + highlight.
  useEffect(() => {
    const ed = editorRef.current;
    const mon = monacoRef.current;
    if (!ed || !mon) return;
    if (!resolvedFromSelection) {
      decorationsRef.current?.clear();
      return;
    }
    if (resolvedFromSelection.fileId !== activeFileId) return; // wait for file to load
    const node = resolvedFromSelection.node;
    if (!node) {
      decorationsRef.current?.clear();
      return;
    }
    const model = ed.getModel();
    if (!model) return;
    const startPos = model.getPositionAt(node.start);
    const endPos = model.getPositionAt(node.end);
    const range = new mon.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);

    // Don't touch the caret while the user is typing in this file. This effect
    // re-runs on every render (resolvedFromSelection is a fresh object each
    // time), so during editing every keystroke would otherwise call setPosition
    // and yank the cursor back to the node's start.
    if (!isEditing) {
      applyingRemoteRef.current = true;
      ed.revealRangeInCenterIfOutsideViewport(range, mon.editor.ScrollType.Smooth);
      ed.setPosition(startPos);
      applyingRemoteRef.current = false;

      decorationsRef.current?.set([
        {
          range,
          options: {
            isWholeLine: false,
            className: 'codegraph-ast-highlight',
            inlineClassName: 'codegraph-ast-highlight-inline',
          },
        },
      ]);
    }
  }, [resolvedFromSelection, activeFileId, isEditing]);

  const onChange = useCallback(
    (value: string | undefined) => {
      // Ignore our own programmatic content swaps (discard / reload).
      if (applyingProgrammaticRef.current) return;
      if (!useGraphStore.getState().editMode) return;
      const v = value ?? '';
      currentTextRef.current = v;
      liveEditBuffer.text = v;
      liveEditBuffer.dirty = v !== baselineTextRef.current;
      setDirty(v !== baselineTextRef.current);
      scheduleValidate(v);
    },
    [scheduleValidate],
  );

  // Keep the exported live buffer in sync with edit-mode boundaries: entering
  // edit seeds it with the loaded text (so followers see the buffer before the
  // first keystroke), leaving edit clears it.
  useEffect(() => {
    if (isEditing) {
      liveEditBuffer.text = currentTextRef.current;
      liveEditBuffer.dirty = dirtyRef.current;
    } else {
      liveEditBuffer.text = null;
      liveEditBuffer.dirty = false;
    }
  }, [isEditing]);

  // --- Save ----------------------------------------------------------------
  const save = useCallback(async () => {
    const fileId = activeFileIdRef.current;
    if (!fileId) return;
    if (!useGraphStore.getState().editMode) return;
    if (!dirtyRef.current || savingRef.current || hasErrorRef.current) return;
    setSaving(true);
    // Also flip the ref SYNCHRONOUSLY — the mirror effect only updates it
    // after the next render, so two same-tick invocations (Monaco's Cmd-S
    // command and the window-level fallback below can both match one
    // keydown) would otherwise both pass the guard and double-write.
    savingRef.current = true;
    try {
      const res = await writeSource(project.projectId, fileId, {
        text: currentTextRef.current,
        baseMtimeMs: baseMtimeMsRef.current,
        baseHash: baseHashRef.current,
      });
      baselineTextRef.current = currentTextRef.current;
      baseHashRef.current = res.newHash;
      baseMtimeMsRef.current = res.newMtimeMs;
      setDirty(false);
      setConflict(null);
      useSourceStore.getState().invalidate(fileId);
      // Mark as a self-save so the watcher echo doesn't jerk the view once we
      // leave edit mode below (App.tsx flush consults selfSavedFileIds).
      selfSavedFileIds.add(fileId);
      window.setTimeout(() => selfSavedFileIds.delete(fileId), 2000);
      // Merge immediately for snappiness; the SSE echo re-applies idempotently.
      if (res.delta) useGraphStore.getState().applyDelta(res.delta);
      // Save & exit: leave edit mode after a successful commit.
      clearMarkers();
      setDiagnostics([]);
      useGraphStore.getState().exitEditMode();
    } catch (e) {
      if (e instanceof ConflictError) setConflict(e.conflict);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [project.projectId, clearMarkers]);

  // Cmd-S is registered once in onMount; route it through a ref to the latest
  // save closure.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Window-level Cmd/Ctrl-S fallback. Monaco's own Cmd-S command only fires
  // while the EDITOR has focus; mid-edit the user is often focused on the
  // canvas (clicking nodes, panning), where the browser's save-page dialog
  // would win. While edit mode is on, swallow the shortcut everywhere and
  // route it to save — even when there's nothing to save (not dirty / has
  // errors), the browser dialog should never appear over an edit session.
  // When Monaco DID handle it, the event arrives here with defaultPrevented
  // set (and save() is reentrancy-guarded via savingRef regardless).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 's') return;
      if (!useGraphStore.getState().editMode) return;
      if (e.defaultPrevented) return; // Monaco's command already took it
      e.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- Conflict resolution -------------------------------------------------
  const reloadFromDisk = useCallback(() => {
    if (!conflict) return;
    baselineTextRef.current = conflict.currentText;
    currentTextRef.current = conflict.currentText;
    baseHashRef.current = conflict.currentHash;
    baseMtimeMsRef.current = conflict.currentMtimeMs;
    // Imperative setValue, not setSource: `source` state may still equal the
    // stale value, so the value-prop diff wouldn't push the new text in.
    applyingProgrammaticRef.current = true;
    editorRef.current?.setValue(conflict.currentText);
    applyingProgrammaticRef.current = false;
    setSource(conflict.currentText);
    setDirty(false);
    setConflict(null);
    scheduleValidate(conflict.currentText);
  }, [conflict, scheduleValidate]);

  const overwrite = useCallback(async () => {
    const fileId = activeFileIdRef.current;
    if (!fileId || !conflict) return;
    setSaving(true);
    try {
      const res = await writeSource(project.projectId, fileId, {
        text: currentTextRef.current,
        baseMtimeMs: conflict.currentMtimeMs,
        baseHash: conflict.currentHash,
        force: true,
      });
      baselineTextRef.current = currentTextRef.current;
      baseHashRef.current = res.newHash;
      baseMtimeMsRef.current = res.newMtimeMs;
      setDirty(false);
      setConflict(null);
      useSourceStore.getState().invalidate(fileId);
      selfSavedFileIds.add(fileId);
      window.setTimeout(() => selfSavedFileIds.delete(fileId), 2000);
      if (res.delta) useGraphStore.getState().applyDelta(res.delta);
      // Save & exit, same as the normal save path.
      clearMarkers();
      setDiagnostics([]);
      useGraphStore.getState().exitEditMode();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [project.projectId, conflict, clearMarkers]);

  // --- Enter / exit --------------------------------------------------------
  const enterEdit = useCallback(() => {
    if (activeFileId) useGraphStore.getState().enterEditMode(activeFileId);
  }, [activeFileId]);

  const handleExit = useCallback(() => {
    if (dirtyRef.current) {
      if (!window.confirm('Discard unsaved edits?')) return;
      // Discard: restore the last-saved baseline into the editor. Must be an
      // imperative setValue — `source` state still holds the loaded baseline
      // (keystrokes only update currentTextRef), so setSource(baseline) is a
      // no-op and Monaco would keep showing the typed text.
      currentTextRef.current = baselineTextRef.current;
      applyingProgrammaticRef.current = true;
      editorRef.current?.setValue(baselineTextRef.current);
      applyingProgrammaticRef.current = false;
      setDirty(false);
    }
    clearMarkers();
    setDiagnostics([]);
    setConflict(null);
    useGraphStore.getState().exitEditMode();
  }, [clearMarkers]);

  // Register the exit handler so App's global Esc can reach it.
  useEffect(() => {
    if (!exitRef) return;
    exitRef.current = handleExit;
    return () => {
      if (exitRef.current === handleExit) exitRef.current = null;
    };
  }, [exitRef, handleExit]);

  const onMount = useCallback<OnMount>(
    (ed, mon) => {
      editorRef.current = ed;
      monacoRef.current = mon;
      setMonacoInst(mon);
      decorationsRef.current = ed.createDecorationsCollection();

      // Cmd/Ctrl-S saves (and preventDefaults the browser's save dialog while
      // the editor is focused).
      ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.KeyS, () => {
        void saveRef.current();
      });

      // Cursor change in editor -> select the smallest enclosing AST node.
      // Skipped entirely while editing: every keystroke moves the cursor, and
      // we don't want typing to churn the global selection / edit frame.
      // Two other filters remain critical:
      //   1. e.source: only user-initiated moves ('mouse'/'keyboard') should
      //      propagate. Monaco fires this same event for programmatic moves.
      //   2. activeFileIdRef (not the captured activeFileId variable):
      //      onMount is invoked once, so a captured variable would forever
      //      reference the file that was active at first mount.
      ed.onDidChangeCursorPosition((e) => {
        if (useGraphStore.getState().editMode) return;
        if (applyingRemoteRef.current) return;
        if (e.source !== 'mouse' && e.source !== 'keyboard') return;
        const fileId = activeFileIdRef.current;
        if (!fileId) return;
        const ast = useGraphStore.getState().asts.get(fileId);
        if (!ast) return;
        const model = ed.getModel();
        if (!model) return;
        const offset = model.getOffsetAt(e.position);
        const node = smallestEnclosing(ast.nodes, offset);
        if (node) setSelection(node.id);
      });
    },
    [setSelection],
  );

  // Following a session that's editing: mirror their live buffer read-only.
  // Takes precedence over the local view — the whole point of following is
  // watching THEIR edits. Local edit mode can't collide: entering it breaks
  // follow (App.tsx), so the two states are mutually exclusive.
  if (followedEdit && followedSession) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.3rem 0.6rem',
            height: 30,
            boxSizing: 'border-box',
            fontSize: '0.8rem',
            background: '#1d1d20',
            borderBottom: `2px solid ${followedSession.color}`,
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: followedSession.color,
              flexShrink: 0,
            }}
          />
          <span style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {followedSession.name} editing {followedEdit.editFileId}
            {followedEdit.dirty ? <span style={{ color: '#e0b050' }}> ●</span> : null}
          </span>
        </div>
        <div style={{ position: 'absolute', top: 30, bottom: 0, left: 0, right: 0 }}>
          <Editor
            theme="vs-dark"
            language={languageForFile(followedEdit.editFileId)}
            // Distinct scheme so this model can't collide with the file:///
            // sibling models the IntelliSense closure feeds.
            path={`follow:///${followedEdit.editFileId}`}
            value={followedEdit.bufferText ?? ''}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              scrollBeyondLastLine: false,
              renderWhitespace: 'none',
              wordWrap: 'on',
              automaticLayout: true,
            }}
          />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={EMPTY_STYLE}>
        <p style={{ color: '#ff8080' }}>{error}</p>
      </div>
    );
  }

  // Empty hint only when nothing has ever been loaded into the editor. Once
  // a file has been opened, we keep it visible even if the user clicks an
  // empty area on the canvas — clearing decorations, but not the file.
  if (!activeFileId) {
    return (
      <div style={EMPTY_STYLE}>
        <p>Click a file or AST node on the canvas to view its source.</p>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        // A clear "you are editing" affordance without needing global CSS.
        boxShadow: isEditing ? 'inset 0 2px 0 0 #4a9eff' : 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.3rem 0.6rem',
          height: 30,
          boxSizing: 'border-box',
          fontSize: '0.8rem',
          background: '#1d1d20',
          borderBottom: '1px solid #2c2c30',
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        <span style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeFileId}
          {isEditing && dirty ? <span style={{ color: '#e0b050' }}> ●</span> : null}
        </span>
        <span style={{ flex: 1 }} />
        {isEditing ? (
          <>
            {diagnostics.length > 0 && (
              <span style={{ color: hasError ? '#ff8080' : '#e0b050', fontSize: '0.72rem' }}>
                {diagnostics.length} {hasError ? 'error' : 'warning'}
                {diagnostics.length > 1 ? 's' : ''}
              </span>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || hasError}
              title={hasError ? 'Fix errors before saving' : 'Save (⌘S)'}
              style={buttonStyle(!dirty || saving || hasError)}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={handleExit} style={buttonStyle(false)}>
              Done
            </button>
          </>
        ) : (
          <button type="button" onClick={enterEdit} style={buttonStyle(false)}>
            Edit
          </button>
        )}
      </div>

      {conflict && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            padding: '0.4rem 0.6rem',
            background: '#3a2a10',
            borderBottom: '1px solid #6a4a20',
            color: '#f0d0a0',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.76rem',
          }}
        >
          <span>{conflict.error}</span>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={reloadFromDisk} style={buttonStyle(false)}>
            Reload
          </button>
          <button type="button" onClick={() => void overwrite()} style={buttonStyle(false)}>
            Overwrite
          </button>
        </div>
      )}

      <div style={{ position: 'absolute', top: conflict ? 60 : 30, bottom: 0, left: 0, right: 0 }}>
        <Editor
          theme="vs-dark"
          language={languageForFile(activeFileId)}
          // Real per-file URI (file:///src/Dog.ts) instead of the default
          // anonymous inmemory model — relative-import resolution keys off
          // model URIs, so this is what lets './Animal' find the sibling
          // model at file:///src/Animal.ts.
          path={`file:///${activeFileId}`}
          value={source}
          beforeMount={configureMonaco}
          onMount={onMount}
          onChange={onChange}
          options={{
            readOnly: !isEditing,
            minimap: { enabled: false },
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '0.1rem 0.55rem',
    fontSize: '0.74rem',
    fontFamily: 'ui-monospace, monospace',
    borderRadius: 4,
    border: '1px solid #3a3a40',
    background: disabled ? '#232327' : '#2c2c33',
    color: disabled ? '#666' : '#e0e0e0',
    cursor: disabled ? 'default' : 'pointer',
  };
}

const EMPTY_STYLE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  background: '#1d1d20',
  opacity: 0.6,
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.85rem',
};

function resolveSelection(
  id: string | null,
  project: ProjectResponse,
  asts: ReadonlyMap<string, FileAstResponse>,
): ResolvedSelection | null {
  if (!id) return null;
  if (project.files.some((f) => f.id === id)) {
    return { fileId: id, node: null };
  }
  const hashIdx = id.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const fileId = id.slice(0, hashIdx);
  const ast = asts.get(fileId);
  if (!ast) return { fileId, node: null };
  const node = ast.nodes.find((n) => n.id === id);
  return { fileId, node: node ?? null };
}

function smallestEnclosing(nodes: readonly AstNode[], offset: number): AstNode | null {
  let best: AstNode | null = null;
  let bestSpan = Infinity;
  for (const n of nodes) {
    if (n.start <= offset && offset < n.end) {
      const span = n.end - n.start;
      if (span < bestSpan) {
        bestSpan = span;
        best = n;
      }
    }
  }
  return best;
}
