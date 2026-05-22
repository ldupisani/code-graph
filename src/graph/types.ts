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
  // link-clearance force to treat it as an obstacle.
  expanded?: boolean;
  relativePath: string;
}

// d3-force will replace `source`/`target` strings with SimFileNode references after init.
export interface SimImportLink {
  id: string;
  source: string | SimFileNode;
  target: string | SimFileNode;
}
