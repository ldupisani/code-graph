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
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
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
