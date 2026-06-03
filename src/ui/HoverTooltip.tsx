import { useGraphStore } from '../graph/store';

// Subscribes to the store's hoveredId + hoveredScreenRect (set by
// PixiCanvas's onHover callback). When a hovered AST node carries a
// signature (set by the server's signatureOf — function-likes get
// `(p: T): R`, typed declarations get `: T`), shows it as a tooltip
// anchored just below the rect.
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

  if (!hoveredId || !hoveredScreenRect) return null;

  // Resolve the AST node from the file's flat node list. The
  // hoveredId is either a fileId (no '#') or an AST node id
  // (`${fileId}#${seq}`); files don't carry a signature so we only
  // look up AST nodes.
  const i = hoveredId.lastIndexOf('#');
  if (i < 0) return null;
  const fileId = hoveredId.slice(0, i);
  const ast = asts.get(fileId);
  if (!ast) return null;
  const node = ast.nodes.find((n) => n.id === hoveredId);
  if (!node?.signature) return null;

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
      <span style={{ color: '#9cdcfe' }}>{node.name ?? node.syntaxKind}</span>
      <span style={{ color: '#888892' }}>{node.signature}</span>
    </div>
  );
}
