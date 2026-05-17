import { Editor, type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getFileSource } from '../api/client';
import type { AstNode, FileAstResponse, ProjectResponse } from '../api/types';
import { useGraphStore } from '../graph/store';

interface EditorPaneProps {
  project: ProjectResponse;
}

interface ResolvedSelection {
  fileId: string;
  node: AstNode | null; // null when selection is the file itself
}

export function EditorPane({ project }: EditorPaneProps) {
  const selection = useGraphStore((s) => s.selection);
  const asts = useGraphStore((s) => s.asts);
  const setSelection = useGraphStore((s) => s.setSelection);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // When we apply selection-to-editor we suppress the cursor handler so it
  // doesn't bounce back into setSelection on the same id.
  const applyingRemoteRef = useRef(false);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null);

  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

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

  const resolvedFromSelection = resolveSelection(selection, project, asts);

  // Selection -> figure out which file's source to load.
  const targetFileId = resolvedFromSelection?.fileId ?? null;

  useEffect(() => {
    if (!targetFileId) return;
    if (targetFileId === activeFileId) return;
    let cancelled = false;
    setError(null);
    getFileSource(project.projectId, targetFileId)
      .then((text) => {
        if (cancelled) return;
        setSource(text);
        setActiveFileId(targetFileId);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [targetFileId, activeFileId, project.projectId]);

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
  }, [resolvedFromSelection, activeFileId]);

  const onMount = useCallback<OnMount>(
    (ed, mon) => {
      editorRef.current = ed;
      monacoRef.current = mon;
      decorationsRef.current = ed.createDecorationsCollection();

      // Cursor change in editor -> select the smallest enclosing AST node.
      // Two filters are critical here:
      //   1. e.source: only user-initiated moves ('mouse'/'keyboard') should
      //      propagate. Monaco fires this same event for programmatic moves
      //      (model swap on file change, our own setPosition), and we must
      //      not interpret those as the user clicking somewhere new.
      //   2. activeFileIdRef (not the captured activeFileId variable):
      //      onMount is invoked once, so a captured variable would forever
      //      reference the file that was active at first mount.
      ed.onDidChangeCursorPosition((e) => {
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
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        style={{
          padding: '0.4rem 0.8rem',
          fontSize: '0.8rem',
          background: '#1d1d20',
          borderBottom: '1px solid #2c2c30',
          fontFamily: 'ui-monospace, monospace',
          opacity: 0.85,
        }}
      >
        {activeFileId}
      </div>
      <div style={{ position: 'absolute', top: 30, bottom: 0, left: 0, right: 0 }}>
        <Editor
          theme="vs-dark"
          language="typescript"
          value={source}
          onMount={onMount}
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
