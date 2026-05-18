// Shared text/label helpers used by BOTH the layout engine (to size nodes to
// their text) and the renderer (to draw that text). Keeping them here is what
// guarantees a box is sized to exactly the string that gets drawn in it.

// Monospace glyph advance as a fraction of font size. The label font stack is
// `ui-monospace, SFMono-Regular, Menlo, monospace`; SF Mono / Menlo advance is
// ~0.6em. Accurate enough to size boxes without a canvas measure pass — and it
// keeps sizing usable from the pure (non-DOM) graph modules. Tune if a future
// font change makes boxes feel loose or tight.
export const MONO_ADVANCE = 0.6;
// Full line box (ascent + descent + leading) as a fraction of font size.
export const LINE_HEIGHT = 1.3;

// What a collapsed file node shows: just the basename (e.g. `PixiCanvas.tsx`).
// The full path is still surfaced elsewhere (selection / editor pane).
export function fileLabel(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
}

// Bounding box (world px) of one un-wrapped line of monospace text.
export function measureMono(text: string, fontSize: number): { w: number; h: number } {
  return { w: text.length * fontSize * MONO_ADVANCE, h: fontSize * LINE_HEIGHT };
}

// AST label font + the screen-px inset the renderer draws it at (top-left).
export const AST_LABEL_FONT = 11;
// Generous inset so the names we keep get breathing room and adjacent
// labels don't visually collide.
export const LABEL_INSET_X = 9;
// Container labels are pinned to the top of their box, so this inset is
// almost entirely the empty band *under* the label before the inner tree
// items. Kept small (≈⅓ less than the prior value) so children sit close
// beneath the title rather than after a tall gap.
export const LABEL_INSET_Y = 4;

// The box (screen px) a node's cell must have for its label to fit: the text
// plus the inset on both sides. THE single source of truth — used identically
// by the exact-fit sizer (cell must be this big at 1:1) and the renderer's
// LOD gate (draw the label only while the container is at least this big on
// screen). No artificial minimum: a cell is sized to its text, nothing more,
// and a label is hidden the instant it would no longer fit rather than
// spilling past its container.
export function labelScreenBox(text: string): { w: number; h: number } {
  const m = measureMono(text, AST_LABEL_FONT);
  return { w: m.w + LABEL_INSET_X * 2, h: m.h + LABEL_INSET_Y * 2 };
}
