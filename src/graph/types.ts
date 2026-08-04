export type {
  EdgeKind,
  FileNode,
  ImportEdge,
  NodeKind,
  ProjectResponse,
} from '../api/types';

// Mutable simulation node — d3-force reads/writes x, y, vx, vy directly.
export interface SimFileNode {
  id: string;
  // x / y are the RENDER position: each frame the renderer sets them
  // to lerp(connectivity, rigid) by the zoom-derived rigidness. The
  // force sim must never see these — it works off connX / connY.
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  // Pure connectivity-layout position — what the d3-force sim
  // actually produces. The renderer restores x/y from these before
  // each manual tick, then re-snapshots them after, so the forces
  // always compute from connectivity positions regardless of how
  // far x/y have been interpolated toward the rigid layout.
  connX: number;
  connY: number;
  // Target position in the deterministic folder-outline layout,
  // translated so the layout is centred on the connectivity
  // layout's centroid (see assignRigidPositions). The renderer
  // lerps x/y toward these as the user zooms out.
  rigidX: number;
  rigidY: number;
  // Two-slot render buffers for the layout crossfade: slot 0 = the OUTGOING
  // layout (only filled while a switch is animating), slot 1 = the ACTIVE one.
  // For a STATIC pattern these hold that pattern's position for this node,
  // re-centred on the connectivity centroid each frame (rigidX/rigidY
  // generalised to a blend). A LIVE (force) pattern has no buffer of its own —
  // its slot mirrors connX/connY, so the blend can read every slot the same
  // way. Filled by the LayoutEngine; lazily allocated, so may be undefined
  // before the first fillBuffers().
  blendX?: number[];
  blendY?: number[];
  // Collision-relaxation offset. The render position is
  // lerp(connectivity, rigid) PLUS this offset; the offset is what
  // a per-frame overlap-relaxation pass produces to keep file
  // boxes from intersecting (the naive lerp can overlap them, and
  // the rigid grid doesn't account for expanded file sizes). It
  // decays toward zero each frame so files ease back to their
  // intended position once the overlap clears.
  offX: number;
  offY: number;
  width: number;
  height: number;
  // The minimized box, sized to this file's basename label + padding. Stored
  // so collapsing restores the content size rather than a global constant.
  collapsedW: number;
  collapsedH: number;
  // True while this file is open (drawn as a big box) — used by the
  // link-clearance force to treat it as an obstacle. Resolved CURRENT
  // state: flips immediately when the user clicks, gates AST-content
  // drawing, overlay hit-testing, and the linkClearanceForce obstacle
  // filter.
  expanded?: boolean;
  // What `expanded` is BECOMING. Stays in sync with `expanded` after
  // any transition has been REQUESTED — used by the shape-check
  // helpers so a file that is animating its width can still be
  // treated as a circle by the force / overlap-relaxation passes.
  // Conceptually: `expanded` answers "what does the user see right
  // now?" while `targetExpanded` answers "what is the geometry
  // animating toward?". On collapse the two agree (both false) but
  // `width` is still in flight, so the width-tolerance fallback in
  // the isCircular helper catches that case too.
  targetExpanded?: boolean;
  // The size `width` / `height` are easing toward. `applyExpansion`
  // sets these; `stepLayout` in the renderer eases the actual
  // `width` / `height` each frame and refreshes the d3-force
  // `collide` / `link` forces while sizes are still in flight.
  targetW: number;
  targetH: number;
  // The expanded-state target width the LAST time this file was open.
  // The collapse animation interpolates from this value back down to
  // `collapsedW`, so the visual `t` (alpha crossfade, animated
  // radius) needs a "from" anchor that survives `targetW` being
  // reset to `collapsedW` on collapse. Initialised to `collapsedW`
  // as a safe fallback.
  lastExpandedTargetW: number;
  // True when the user has manually dragged this file to a position.
  // Disambiguates from the transient `fx`/`fy` pin that
  // `expandFileForSelection` sets during the post-expand rebalance:
  // every pin-release site (stepLayout sim-settle, syncExpansion
  // collapse, expandFileForSelection's other-file release) skips
  // nodes with `userPinned` so the position survives every internal
  // re-layout. Cleared only by the `U` (hover) or `R` (all) keys.
  userPinned?: boolean;
  relativePath: string;
}

// d3-force will replace `source`/`target` strings with SimFileNode references after init.
export interface SimImportLink {
  id: string;
  source: string | SimFileNode;
  target: string | SimFileNode;
}
