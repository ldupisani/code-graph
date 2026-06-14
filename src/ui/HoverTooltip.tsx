import { Component, useEffect, type ReactNode } from 'react';
import { useGraphStore } from '../graph/store';
import { useSourceStore } from '../graph/sourceStore';
import { buildJsxPreviewModel, JsxWireframePreview } from '../render/jsxPreview';

// JSX kinds get a structural wireframe preview instead of (above) the
// plain source-line peek — see src/render/jsxPreview.tsx.
const JSX_KINDS = new Set(['JsxElement', 'JsxSelfClosingElement', 'JsxFragment']);

// The tooltip hangs off App's React tree, so an exception while
// rendering a wireframe for arbitrary analyzed JSX would unmount the
// ENTIRE app (observed: a real <input> instantiated with children —
// blank page). Contain it: a failed preview falls back to whatever
// plain-text rendering the caller provides. Keyed by hoveredId at the
// call site so the next hover gets a fresh try.
class PreviewBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Subscribes to the store's hoveredId + hoveredScreenRect (set by
// PixiCanvas's onHover callback). Shows a tooltip anchored just below
// the rect when the hovered AST node carries either:
//   * a `preview` — the first source line of an expandable block (set
//     by the server's previewOf), letting the user peek inside a
//     collapsed `{…}` cell. Takes priority when present.
//   * a `signature` (set by signatureOf — function-likes get
//     `(p: T): R`, typed declarations get `: T`).
// JSX nodes additionally render a wireframe mock of their markup.
//
// The screen rect is captured once at hover-start; the tooltip
// doesn't track per-frame canvas motion. That's intentional — a
// React component listening to every camera tick would be wasteful,
// and the rect is mostly static while the user is reading the
// tooltip (they're hovering, not panning). If you pan during a hover
// the tooltip stays where it was; moving the mouse back into the
// canvas re-captures.
export function HoverTooltip() {
  const hoveredId = useGraphStore((s) => s.hoveredId);
  const hoveredScreenRect = useGraphStore((s) => s.hoveredScreenRect);
  const asts = useGraphStore((s) => s.asts);
  const projectId = useGraphStore((s) => s.project?.projectId);

  // Resolve the AST node from the file's flat node list BEFORE any
  // early return — the hooks below must run unconditionally. The
  // hoveredId is either a fileId (no '#') or an AST node id
  // (`${fileId}#${seq}`); files don't carry a signature so we only
  // look up AST nodes.
  const i = hoveredId ? hoveredId.lastIndexOf('#') : -1;
  const fileId = hoveredId && i >= 0 ? hoveredId.slice(0, i) : null;
  const ast = fileId ? asts.get(fileId) : undefined;
  const node = ast ? ast.nodes.find((n) => n.id === hoveredId) : undefined;
  const isJsx = node != null && JSX_KINDS.has(node.syntaxKind);

  // Raw source unlocks attribute values / expression text in the
  // wireframe; the preview renders immediately without it and
  // re-renders (via the store subscription) when the fetch lands.
  const source = useSourceStore((s) => (fileId ? s.sources.get(fileId) : undefined));
  const ensure = useSourceStore((s) => s.ensure);
  useEffect(() => {
    if (isJsx && projectId && fileId) ensure(projectId, fileId);
  }, [isJsx, projectId, fileId, ensure]);

  if (!hoveredId || !hoveredScreenRect || !ast || !node) return null;
  if (!isJsx && !node.signature && !node.preview) return null;

  const jsxModel = isJsx
    ? buildJsxPreviewModel(ast.nodes, node.id, source, { maxDepth: 4, maxNodes: 60 })
    : null;
  if (isJsx && !jsxModel && !node.signature && !node.preview) return null;

  // Anchor: just below the rect, left edge aligned. Capped to the
  // viewport so the tooltip doesn't fall off the right edge of the
  // screen for rects near the canvas's right side. The box grows to fit
  // its (one-line) signature up to `maxWidth`; longer ones wrap rather
  // than overflow the background. The right-edge clamp uses that same
  // maxWidth so a worst-case-width box still fits on screen.
  const PAD = 6;
  const maxWidth = Math.min(window.innerWidth - 2 * PAD, 760);
  const top = hoveredScreenRect.y + hoveredScreenRect.h + PAD;
  const left = Math.max(
    PAD,
    Math.min(window.innerWidth - maxWidth - PAD, hoveredScreenRect.x),
  );

  return (
    <div
      style={{
        position: 'fixed',
        top,
        left,
        width: 'fit-content',
        maxWidth,
        padding: '0.35rem 0.6rem',
        background: 'rgba(28, 28, 32, 0.95)',
        color: '#d4d4d4',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.78rem',
        lineHeight: 1.35,
        borderRadius: 4,
        boxShadow: 'inset 0 0 0 1px rgba(120,120,130,0.35), 0 6px 24px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(6px)',
        // Pointer-events: none so the tooltip can't itself steal
        // hover from the canvas underneath — which would create a
        // flicker loop (hover canvas → show tooltip → tooltip eats
        // pointer → hoveredId clears → tooltip hides → repeat).
        pointerEvents: 'none',
        zIndex: 50,
        // pre-wrap (not pre): keep the signature on one line while it fits the
        // box, but WRAP rather than overflow the background when it's longer
        // than maxWidth. overflowWrap handles a single long token (no spaces).
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        userSelect: 'none',
      }}
    >
      {jsxModel ? (
        // JSX subtree: the structural wireframe mock IS the preview —
        // it already shows the whole layout, so no source-line caption.
        <PreviewBoundary
          key={hoveredId}
          fallback={<span style={{ color: '#d4d4d4' }}>{node.preview ?? node.name ?? node.syntaxKind}</span>}
        >
          <JsxWireframePreview model={jsxModel} maxWidth={360} maxHeight={260} />
        </PreviewBoundary>
      ) : node.preview ? (
        // Expandable block: show its first source line verbatim (server's
        // previewOf already appended "…" when the block spans more lines)
        // so the user can peek inside a collapsed `{…}` cell without drilling.
        <span style={{ color: '#d4d4d4' }}>{node.preview}</span>
      ) : (
        <>
          <span style={{ color: '#9cdcfe' }}>{node.name ?? node.syntaxKind}</span>
          <span style={{ color: '#888892' }}>{node.signature}</span>
        </>
      )}
    </div>
  );
}
