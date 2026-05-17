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
  relativePath: string;
}

// d3-force will replace `source`/`target` strings with SimFileNode references after init.
export interface SimImportLink {
  id: string;
  source: string | SimFileNode;
  target: string | SimFileNode;
}
