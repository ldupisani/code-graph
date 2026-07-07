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
  // AST id of the specific `ImportDeclaration` inside fromId that owns this
  // edge. The renderer uses it to anchor the import line on the exact
  // statement block when the source file is expanded — otherwise the line
  // would always start at the file's centroid and pass through unrelated AST
  // content. Falls back to the file rect when the AST isn't loaded yet.
  fromAstNodeId?: string;
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
  // For cross-file edges where the source references the target via an
  // import: the AST id of the local binding inside the source file (the
  // ImportSpecifier for `import { X }`, or the default-import Identifier
  // for `import X`). The renderer routes extends/implements connectors
  // THROUGH this binding when the source file is expanded — visually
  // showing the chain `subclass → imported name → external superclass`.
  viaImportNodeId?: string;
}

export interface ProjectResponse {
  projectId: string;
  rootPath: string;
  // Which analyzer produced this graph. Drives the editor's syntax mode and
  // any language-specific UI affordances.
  language: 'typescript' | 'python';
  // The tsconfig used — TypeScript projects only; absent for Python.
  tsConfigPath?: string;
  files: FileNode[];
  edges: ImportEdge[]; // file-level imports
  semanticEdges: SemanticEdge[]; // AST-level: calls, extends, implements
}

export interface ApiError {
  error: string;
}

// Incremental update streamed over the watch SSE channel when a single file
// changes on disk, replacing the old "re-open the whole project" round-trip.
// The client merges it into the live graph WITHOUT rebuilding the renderer, so
// camera, layout positions, selection, and config all survive an edit.
//
// Edge replacement is keyed by SOURCE file. Because AST ids are
// `${fileId}#${seq}` with `seq` reset per file, an edge can only touch the
// changed file if it ORIGINATES from that file or from a file that imports it
// (you must import a symbol to call/extend it across files). So the server
// recomputes edges for exactly `affectedFromFiles = {fileId} ∪ importers(fileId)`
// and the client drops every existing edge whose source file is in that set
// before splicing in `imports` / `semanticEdges`. Edges among untouched files
// are never sent and never disturbed.
export interface GraphDelta {
  kind: 'changed' | 'added' | 'removed';
  // The file the filesystem event fired for (relative-path id).
  fileId: string;
  // The file's fresh node (size/lines may have changed). Present for
  // 'changed' and 'added'; absent for 'removed'.
  file?: FileNode;
  // The changed file's freshly-walked AST, shipped inline so the client can
  // replace its cached AST synchronously and update an EXPANDED file in place
  // — without dropping it to collapsed size while a separate fetch round-trips.
  // Present for 'changed' and 'added'; absent for 'removed'.
  ast?: FileAstResponse;
  // Source files whose outgoing edges were recomputed and are fully
  // represented by `imports` + `semanticEdges` below. The client removes all
  // prior edges originating from any of these files, then adds the new ones.
  // For 'removed' this also drives dropping edges that pointed INTO the file.
  affectedFromFiles: string[];
  // Recomputed import edges originating from `affectedFromFiles`.
  imports: ImportEdge[];
  // Recomputed semantic edges originating from `affectedFromFiles`.
  semanticEdges: SemanticEdge[];
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
  // Semantic role of this node within its parent construct, when positional
  // inference alone is ambiguous. Only set today for the three clauses of a
  // C-style `for (init; cond; update)`, whose clauses can each be omitted —
  // the layout reads it to place the `;` separators correctly (the loop
  // variable / iterable of for-of/for-in, by contrast, are always present so
  // their templates infer roles from position; see SYNTAX_TEMPLATES).
  role?: 'init' | 'cond' | 'update';
  // True when this node is part of the module's public surface (an exported
  // declaration, `export`/`export default`). Used for zoomed-out LOD: only
  // high-level constructs keep their label when text no longer fits.
  exported?: boolean;
  // True when this node IS the resolved local implementation of a default
  // export — i.e. a `export default X` statement re-exported this declaration
  // by name, and that statement was merged away. The renderer prefixes the
  // label with `export default` (keyword colour). Set alongside `exported`.
  defaultExport?: boolean;
  // True for an `abstract` declaration (class/method/property/accessor).
  // The renderer gives it a dashed box outline.
  abstract?: boolean;
  // `static` member of a class. Renderer prepends "static" to the
  // name in keyword colour, matching how the editor highlights it.
  static?: boolean;
  // `readonly` property / parameter. Same keyword-colour prefix
  // treatment as `static`.
  readonly?: boolean;
  // Access modifier when not the default (public). Renders as the
  // corresponding keyword in keyword colour preceding the name.
  accessibility?: 'private' | 'protected';
  // For a class/interface, the base type text from its `extends` clause
  // (e.g. "Animal", or "A, B" for an interface). Rendered inline on the
  // header ("Dog extends Animal") instead of as a separate block.
  extendsName?: string;
  // True when the node is a type in the user's source code: a
  // TypeReference (always), or an import binding whose closest
  // ImportClause has `isTypeOnly` (the `import type { Foo }` form),
  // or an ImportSpecifier with its own `isTypeOnly` (the
  // `import { type Foo }` form). The renderer paints these in the
  // SYNTAX.type colour regardless of their syntaxKind's normal
  // category, matching how the editor highlights types.
  isType?: boolean;
  // Source-text signature: `(p: T, q: U): R` for function-likes,
  // `: T` for typed declarations (property / variable / parameter
  // with an explicit type annotation). The hover tooltip in
  // src/ui/HoverTooltip.tsx renders this so a user can survey a
  // class's API by mousing across its members without expanding
  // each one.
  signature?: string;
  // First source line of an EXPANDABLE block (a Block, object/type
  // literal, class/interface, JSX element, …) — a "peek" the hover
  // tooltip shows so the user can read what a collapsed `{…}` cell
  // contains without drilling into it. A trailing "…" marks that the
  // block spans more than this one line. Only set for the kinds the
  // renderer collapses (see EXPANDABLE_KINDS / previewOf). Unset for
  // everything else, so the tooltip falls back to name + signature.
  preview?: string;
  // Return-type text of a function-like (`VisibleEntityState[]`, `boolean`, …).
  // Set independently of whether the return type is emitted as a child node
  // (primitive returns emit none), so the client can render it inline after the
  // `:` in the function's signature flow. See returnTypeOf in ast-extractor.ts.
  returnType?: string;
  // Method-call chain flattened into one node, in left-to-right order: e.g.
  // `[arr].filter(Boolean).join(' ')` becomes a single CallExpression with
  // chain `[{marker:'filter',argCount:1},{marker:'join',argCount:1}]`, children
  // `[base, …filterArgs, …joinArgs]`. The client renders it as a flat fluent
  // flow `[base] ▷ filter ( … ) ▷ join ( … )` (see syntaxTokens / constructLayout).
  // `argCount` per segment lets the client interleave the arg child boxes.
  chain?: { marker: string; argCount: number }[];
  start: number;          // char offset in source, inclusive
  end: number;            // char offset, exclusive
}

export interface FileAstResponse {
  fileId: string;
  rootId: string;
  nodes: AstNode[];
}

// --- Editing (write path) --------------------------------------------------
// Everything below drives "edit the codebase from the app": the editor loads
// disk-truth source + a baseline, validates a proposed buffer WITHOUT writing
// (the save gate — a save is only allowed when the edit won't break graph
// analysis), then writes with a conflict check. After a successful write the
// existing watcher→SSE→applyDelta pipeline re-analyzes and re-renders in place.

// A parse/analysis diagnostic, pre-converted to Monaco's 1-based line/column
// coordinates so the client can push it straight into setModelMarkers.
export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

// GET /source-for-edit — disk-truth source plus the baseline the client echoes
// back on save so the server can detect a concurrent on-disk change. Read from
// disk (not the analyzer's in-memory buffer) so text and baseline are coherent.
export interface SourceForEditResponse {
  text: string;
  mtimeMs: number;
  hash: string; // sha256 hex of the exact bytes returned
}

// POST /validate — dry-run parse → AST-extract on a proposed buffer, no write.
export interface ValidateRequest {
  text: string;
}
export interface ValidateResponse {
  ok: boolean; // false when the buffer would break graph analysis
  diagnostics: Diagnostic[];
}

// POST /source — write the buffer to disk (guarded by the baseline).
export interface WriteRequest {
  text: string;
  // Baseline the edit was based on, from SourceForEditResponse. null asserts
  // the file did NOT exist when editing began (future new-file scaffolding).
  baseMtimeMs: number | null;
  baseHash: string | null;
  // Set by the "overwrite" path after a 409 to bypass the conflict check.
  force?: boolean;
}
export interface WriteResponse {
  ok: true;
  newMtimeMs: number;
  newHash: string;
  // The same GraphDelta the SSE watcher will also emit — an optional latency
  // shortcut so the client can merge immediately. Safe to ignore: applyDelta
  // is idempotent and the watcher echo re-applies it.
  delta?: GraphDelta;
}

// 409 body when the on-disk file changed under the edit (external editor or
// another window sharing this project's analyzer). Carries the current disk
// content so the client can offer reload-or-overwrite.
export interface ConflictResponse {
  error: string;
  conflict: true;
  currentText: string;
  currentMtimeMs: number;
  currentHash: string;
}

// --- Presence / sessions -----------------------------------------------------

// One connected window on a project's SSE stream. Identity is generated
// client-side (per browser tab) and carried on the /watch query string; the
// server only relays it.
export interface SessionInfo {
  id: string;
  name: string; // human-readable, e.g. "Amber Fox"
  color: string; // css hex, stable per session
  connectedAt: number;
}

// Camera transform + content anchor, structurally matching the renderer's
// CameraState. The anchor matters across windows: two windows' force layouts
// place files differently, so a follower re-frames relative to the anchor
// FILE rather than trusting raw world coordinates.
export interface PresenceCamera {
  x: number;
  y: number;
  scale: number;
  anchorId?: string | null;
  anchorScreenX?: number;
  anchorScreenY?: number;
}

// What a session broadcasts about itself (throttled). Followers mirror this.
export interface PresenceState {
  selection: string | null;
  selectionSet: readonly string[];
  // User-toggled drill-down state: expanded Block/AST nodes and toggled-on
  // story previews. File expansion itself is deliberately NOT here — it's
  // DERIVED state (the renderer's syncExpansion recomputes it every frame
  // from selectionSet × zoom), so mirroring selectionSet + camera reproduces
  // it on the follower, and mirroring it directly would fight the renderer.
  expandedAstNodes: readonly string[];
  previewedAstNodes: readonly string[];
  // User-pinned file positions (drag-to-pin IS the manual arrangement
  // mechanism). World coordinates transfer as-is: pins FIX positions, so
  // applying them reproduces the arranger's spatial layout on the follower
  // regardless of how each window's force sim had settled.
  pins: readonly { id: string; x: number; y: number }[];
  camera: PresenceCamera | null;
  // Non-null while the session is in edit mode: the file being edited and the
  // LIVE (unsaved) buffer, so followers see keystrokes before any save.
  editFileId: string | null;
  bufferText: string | null;
  dirty: boolean;
}

// POST /presence request body; the server stores it per-session and fans it
// out to every OTHER session as an SSE `presence` event.
export interface PresenceUpdateRequest {
  sessionId: string;
  state: PresenceState;
}

// SSE `presence` event payload.
export interface PresenceEvent {
  sessionId: string;
  state: PresenceState;
}
