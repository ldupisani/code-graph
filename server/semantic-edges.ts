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
export function buildSemanticEdges(
  sourceFiles: readonly SourceFile[],
  idByNode: Map<Node, string>,
): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  let seq = 0;
  const emit = (kind: SemanticEdge['kind'], fromId: string, toId: string) => {
    if (fromId === toId) return; // skip self-loops
    edges.push({ id: `e${seq++}`, kind, fromId, toId });
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
  emit: (kind: SemanticEdge['kind'], from: string, to: string) => void,
): void {
  const fromId = idByNode.get(cls);
  if (!fromId) return;

  if (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) {
    const ext = cls.getExtends();
    if (ext) {
      const target = resolveDeclaration(ext.getExpression(), idByNode);
      if (target) emit('extends', fromId, target);
    }
    for (const impl of cls.getImplements()) {
      const target = resolveDeclaration(impl.getExpression(), idByNode);
      if (target) emit('implements', fromId, target);
    }
  }
}

function emitInterfaceExtends(
  iface: Node,
  idByNode: Map<Node, string>,
  emit: (kind: SemanticEdge['kind'], from: string, to: string) => void,
): void {
  if (!Node.isInterfaceDeclaration(iface)) return;
  const fromId = idByNode.get(iface);
  if (!fromId) return;
  for (const ext of iface.getExtends()) {
    const target = resolveDeclaration(ext.getExpression(), idByNode);
    if (target) emit('extends', fromId, target);
  }
}

function emitCall(
  call: Node,
  idByNode: Map<Node, string>,
  emit: (kind: SemanticEdge['kind'], from: string, to: string) => void,
): void {
  if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) return;
  const targetId = resolveDeclaration(call.getExpression(), idByNode);
  if (!targetId) return;
  // Anchor the edge at the call site itself, not the enclosing function.
  // findVisibleAnchor on the client lifts up the parent chain when the call
  // rect isn't visible (low zoom or collapsed file), so zoomed-out views
  // still aggregate to the containing function or file naturally — but when
  // the call site IS visible, the edge clearly emanates from the specific
  // call rather than from the entire scope's border.
  const fromId = idByNode.get(call);
  if (!fromId) return;
  emit('calls', fromId, targetId);
}

// Resolve an expression (the callee or the base type) to the AST id of its
// declaration in this project. Returns undefined if the symbol is external or
// cannot be resolved.
function resolveDeclaration(expr: Node, idByNode: Map<Node, string>): string | undefined {
  let symbol = expr.getSymbol();
  if (symbol) {
    const aliased = symbol.getAliasedSymbol?.();
    if (aliased) symbol = aliased;
  }
  if (!symbol) return undefined;
  for (const decl of symbol.getDeclarations()) {
    const id = idByNode.get(decl);
    if (id) return id;
  }
  return undefined;
}
