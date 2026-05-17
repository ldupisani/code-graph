// Wire types shared between the React client (src/) and the Node helper (server/).
// The server's tsconfig.server.json explicitly includes this file so both sides
// reference one definition without a re-export indirection.

export type NodeKind =
  | 'project'
  | 'file'
  | 'class'
  | 'interface'
  | 'enum'
  | 'typeAlias'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'astNode';

export type EdgeKind =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'references'
  | 'instantiates';

export interface FileNode {
  id: string;
  kind: 'file';
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  lineCount: number;
}

export interface ImportEdge {
  id: string;
  kind: 'imports';
  fromId: string;
  toId: string;
}

export interface ProjectRequest {
  path: string;
}

export type SemanticEdgeKind = 'calls' | 'extends' | 'implements';

// Edge between AST node IDs (`${fileId}#${seq}`). Computed once at project
// open time; client lifts to visible ancestors when an endpoint is inside a
// collapsed file (or culled by LOD).
export interface SemanticEdge {
  id: string;
  kind: SemanticEdgeKind;
  fromId: string;
  toId: string;
}

export interface ProjectResponse {
  projectId: string;
  rootPath: string;
  tsConfigPath: string;
  files: FileNode[];
  edges: ImportEdge[]; // file-level imports
  semanticEdges: SemanticEdge[]; // AST-level: calls, extends, implements
}

export interface ApiError {
  error: string;
}

// AST node returned by GET /api/project/:projectId/ast?fileId=...
// Flat list keyed by stable id (fileId#start-end). The root is the SourceFile
// itself; its `parentId` is `null`.
export interface AstNode {
  id: string;
  parentId: string | null;
  syntaxKind: string;     // ts.SyntaxKind name (e.g. "ClassDeclaration")
  name: string | null;    // friendly identifier text when present
  start: number;          // char offset in source, inclusive
  end: number;            // char offset, exclusive
}

export interface FileAstResponse {
  fileId: string;
  rootId: string;
  nodes: AstNode[];
}
