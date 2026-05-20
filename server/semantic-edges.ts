import { Node, type SourceFile } from 'ts-morph';
import type { SemanticEdge } from '../src/api/types';

/**
 * Walk every source file and emit AST-level edges:
 *   - `extends`     : a class/interface extends another class/interface
 *   - `implements`  : a class implements an interface
 *   - `calls`       : a call expression invokes a function/method declared in this project
 *
 * Endpoints are AST node IDs ("${fileId}#${seq}") looked up via `idByNode`,
 * which the AST-extractor populated during the walk. Calls whose target lives
 * outside the project (e.g. `console.log`, npm packages) are skipped — they
 * resolve to declarations whose source file isn't in `idByNode`.
 */
type EmitFn = (
  kind: SemanticEdge['kind'],
  fromId: string,
  toId: string,
  viaImportNodeId?: string,
) => void;

export function buildSemanticEdges(
  sourceFiles: readonly SourceFile[],
  idByNode: Map<Node, string>,
): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  let seq = 0;
  const emit: EmitFn = (kind, fromId, toId, viaImportNodeId) => {
    if (fromId === toId) return; // skip self-loops
    edges.push({ id: `e${seq++}`, kind, fromId, toId, viaImportNodeId });
  };

  for (const sf of sourceFiles) {
    sf.forEachDescendant((node) => {
      if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
        emitInheritance(node, idByNode, emit);
      } else if (Node.isInterfaceDeclaration(node)) {
        emitInterfaceExtends(node, idByNode, emit);
      } else if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
        emitCall(node, idByNode, emit);
      }
    });
  }

  return edges;
}

function emitInheritance(
  cls: Node,
  idByNode: Map<Node, string>,
  emit: EmitFn,
): void {
  const fromId = idByNode.get(cls);
  if (!fromId) return;

  if (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) {
    const ext = cls.getExtends();
    if (ext) {
      const res = resolveDeclaration(ext.getExpression(), idByNode);
      if (res.targetId) emit('extends', fromId, res.targetId, res.viaImportNodeId);
    }
    for (const impl of cls.getImplements()) {
      const res = resolveDeclaration(impl.getExpression(), idByNode);
      if (res.targetId) emit('implements', fromId, res.targetId, res.viaImportNodeId);
    }
  }
}

function emitInterfaceExtends(
  iface: Node,
  idByNode: Map<Node, string>,
  emit: EmitFn,
): void {
  if (!Node.isInterfaceDeclaration(iface)) return;
  const fromId = idByNode.get(iface);
  if (!fromId) return;
  for (const ext of iface.getExtends()) {
    const res = resolveDeclaration(ext.getExpression(), idByNode);
    if (res.targetId) emit('extends', fromId, res.targetId, res.viaImportNodeId);
  }
}

function emitCall(
  call: Node,
  idByNode: Map<Node, string>,
  emit: EmitFn,
): void {
  if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) return;
  const res = resolveDeclaration(call.getExpression(), idByNode);
  if (!res.targetId) return;
  // Anchor the edge at the call site itself, not the enclosing function.
  // findVisibleAnchor on the client lifts up the parent chain when the call
  // rect isn't visible (low zoom or collapsed file), so zoomed-out views
  // still aggregate to the containing function or file naturally — but when
  // the call site IS visible, the edge clearly emanates from the specific
  // call rather than from the entire scope's border.
  const fromId = idByNode.get(call);
  if (!fromId) return;
  emit('calls', fromId, res.targetId, res.viaImportNodeId);
}

// Resolve an expression (the callee or the base type) to BOTH the local
// binding's AST id (an ImportSpecifier / default-import Identifier when the
// reference goes via an import; the target itself for same-file refs) and
// the target declaration's AST id (the actual class/function being extended
// or called, possibly in another file).
//
// Returning both lets the client choose: by default it draws a direct
// edge to the target; when the source file is expanded it can route the
// connector THROUGH the local binding to show *which* import statement
// brought the symbol into scope.
function resolveDeclaration(
  expr: Node,
  idByNode: Map<Node, string>,
): { targetId?: string; viaImportNodeId?: string } {
  let symbol = expr.getSymbol();
  if (!symbol) return {};

  // Pre-alias-resolution declarations: for an imported reference, these are
  // the ImportSpecifier / default-import-Identifier nodes inside the source
  // file. For a same-file reference, this is the original declaration.
  let viaImportNodeId: string | undefined;
  for (const decl of symbol.getDeclarations()) {
    const id = idByNode.get(decl);
    if (id) {
      viaImportNodeId = id;
      break;
    }
  }

  const aliased = symbol.getAliasedSymbol?.();
  if (aliased) symbol = aliased;

  let targetId: string | undefined;
  for (const decl of symbol.getDeclarations()) {
    const id = idByNode.get(decl);
    if (id) {
      targetId = id;
      break;
    }
  }

  // Same-file reference: local-binding == target. The renderer never has
  // anything to route through, so don't emit the redundant via id.
  if (viaImportNodeId === targetId) viaImportNodeId = undefined;

  return { targetId, viaImportNodeId };
}
