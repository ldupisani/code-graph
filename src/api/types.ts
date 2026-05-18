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
  // Operator glyph for relational nodes — BinaryExpression's operator
  // (`=`, `+`, `===`, …) or `=` for a VariableDeclaration initializer.
  // The renderer draws it between the two related operand boxes.
  op?: string;
  // True when this node is part of the module's public surface (an exported
  // declaration, `export`/`export default`). Used for zoomed-out LOD: only
  // high-level constructs keep their label when text no longer fits.
  exported?: boolean;
  // True for an `abstract` declaration (class/method/property/accessor).
  // The renderer gives it a dashed box outline.
  abstract?: boolean;
  // For a class/interface, the base type text from its `extends` clause
  // (e.g. "Animal", or "A, B" for an interface). Rendered inline on the
  // header ("Dog extends Animal") instead of as a separate block.
  extendsName?: string;
  start: number;          // char offset in source, inclusive
  end: number;            // char offset, exclusive
}

export interface FileAstResponse {
  fileId: string;
  rootId: string;
  nodes: AstNode[];
}
