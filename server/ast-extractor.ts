import { Node, SourceFile, ts } from 'ts-morph';
import type { AstNode, FileAstResponse } from '../src/api/types';

// Wrapper kinds whose only structural purpose is to group meaningful
// children. Their generic kind labels — "imports", "named",
// "variableDeclarationList" — add visual noise without conveying anything
// the children don't already say. visit() elides them: their children
// re-attach to the grandparent and their own rect is never emitted. Safe
// because no semantic edge anchors to these kinds (semantic-edges.ts
// targets only ClassDeclaration / InterfaceDeclaration / Call / New).
//
// Hoisted to module-top so tsx-watch's hot-reload always has it in scope
// when visit() runs — placement deeper in the file produced a TDZ error
// after some edit cycles.
const PASSTHROUGH_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamedImports,
  ts.SyntaxKind.NamedExports,
  ts.SyntaxKind.VariableDeclarationList,
  // JsxAttributes is just a syntactic wrapper around the list of JSX
  // attributes; treat it as transparent so each JsxAttribute becomes a
  // direct child of its JsxOpeningElement / JsxSelfClosingElement. The
  // attributes then render INSIDE the `<div>` opening-tag rect, which
  // is how the user reads the source.
  ts.SyntaxKind.JsxAttributes,
  // JsxOpeningElement is the `<Foo …>` tag of a JsxElement. We elide it so its
  // attributes reparent directly onto the JsxElement — the element then lays
  // out like a function definition (tag name in the header band, attributes
  // bracketed on the left, children on the right; see jsxLayout). The tag-name
  // identifier and the matching JsxClosingElement are inlined when the
  // JsxElement's label is synthesised, so neither re-emits as a stray child.
  ts.SyntaxKind.JsxOpeningElement,
  // JsxExpression is the `{…}` braces wrapping an attribute value or
  // JSX child expression — purely syntactic, the EXPRESSION inside is
  // what the user cares about. Without this, `ref={ref}` rendered as a
  // JsxAttribute ('ref' header) containing a JsxExpression (empty
  // rect) containing the Identifier ('ref') — three nested rects for
  // one piece of information. Skipping the JsxExpression collapses to
  // `[ref [ref]]`, matching how the source reads.
  ts.SyntaxKind.JsxExpression,
  // CaseBlock is the `{ … }` wrapper around a switch's clauses — purely
  // structural. Eliding it reparents the CaseClause / DefaultClause nodes
  // directly onto the SwitchStatement, so the client's `switch [expr]`
  // template can flow the cases right below the header instead of inside an
  // extra anonymous box.
  ts.SyntaxKind.CaseBlock,
]);

export interface ExtractAstOptions {
  // When true (default), pure punctuation/keyword tokens are not emitted. They
  // bloat the tree without adding navigational value at any zoom level.
  skipTrivialTokens?: boolean;
}

export interface ExtractAstResult {
  response: FileAstResponse;
  // Reverse-lookup used by the semantic-edge pass: ts-morph wraps each
  // ts.Node with a stable Node instance for the lifetime of the Project, so a
  // Map keyed by Node is safe.
  idByNode: Map<Node, string>;
}

export function extractAst(
  sf: SourceFile,
  fileId: string,
  opts: ExtractAstOptions = {},
): ExtractAstResult {
  const skipTrivialTokens = opts.skipTrivialTokens ?? true;
  const nodes: AstNode[] = [];
  const idByNode = new Map<Node, string>();
  // Nodes whose textual contribution was already captured by an ancestor's
  // synthesised label (e.g. the callee Identifier of `foo()` or every
  // identifier in the access chain `a.b.c` of `a.b.c()`). Populated as a side
  // effect of friendlyName / synthesizeCallLabel / synthesizeAccessLabel and
  // consulted in visit() to skip the redundant child rect.
  const inlined = new Set<Node>();
  // Method-call-chain flattening (`a.f(x).g(y)` → one flat `[a] ▷f (x) ▷g (y)`
  // flow). `chainReparent` holds the intermediate CallExpression / access nodes
  // whose children reparent onto the outermost call (consulted in visit() like
  // PASSTHROUGH_KINDS); `chainData` maps each chain ROOT to its ordered segments
  // (read in pushAndRecurse to stamp `chain` on the emitted node). See
  // flattenCallChain / synthesizeCallLabel.
  const chainReparent = new Set<Node>();
  const chainData = new Map<Node, ChainSegmentInfo[]>();
  // id → emitted AstNode, so a later node (e.g. `export default X`) can flag an
  // ALREADY-emitted node (the `const X` it re-exports) — see tryMergeDefaultExport.
  const astById = new Map<string, AstNode>();
  let seq = 0;

  // IDs are sequential within a file walk because parent and child can share a
  // source range (e.g. an ImportClause whose only child NamedImports spans the
  // same characters). Range alone is not unique. Position info still lives on
  // the AstNode itself via start/end.
  const rootId = nextId();
  pushAndRecurse(sf, rootId, null);

  return {
    response: { fileId, rootId, nodes },
    idByNode,
  };

  function pushAndRecurse(node: Node, id: string, parentId: string | null): void {
    idByNode.set(node, id);
    const typeFlag = isTypeImportBinding(node) || undefined;
    const ast: AstNode = {
      id,
      parentId,
      syntaxKind: syntaxKindName(node.getKind()),
      name: friendlyName(node, inlined, chainReparent, chainData),
      op: operatorOf(node),
      role: forClauseRole(node),
      exported: exportedOf(node),
      abstract: abstractOf(node),
      static: staticOf(node),
      readonly: readonlyOf(node),
      accessibility: accessibilityOf(node),
      extendsName: extendsNameOf(node),
      isType: typeFlag,
      decl: declOf(node),
      signature: signatureOf(node) ?? callSignatureOf(node) ?? propertyTypeOf(node),
      preview: previewOf(node) ?? importPreviewOf(node),
      returnType: returnTypeOf(node),
      // friendlyName (above) ran synthesizeCallLabel, which populates chainData
      // for a method-chain root — read it back here. Object props evaluate
      // top-to-bottom, so `name` is computed before this.
      chain: chainData.get(node),
      start: node.getStart(),
      end: node.getEnd(),
    };
    nodes.push(ast);
    astById.set(id, ast);
    node.forEachChild((child) => visit(child, id));
  }

  function visit(node: Node, parentId: string | null): void {
    const kind = node.getKind();
    if (skipTrivialTokens && isTrivialToken(kind)) return;
    // Whitespace-only JsxText — the newlines/indentation between tags — carries
    // no information; skip it so it doesn't litter a JSX element with empty
    // boxes. Text with actual content (`<p>Hello</p>`) still emits.
    if (kind === ts.SyntaxKind.JsxText && node.getText().trim() === '') return;
    // Empty template-literal text chunk — the `` `${variant}` `` tail (nothing
    // between `}` and the closing backtick) or a head like `` `${x}…` ``. It
    // carries no content; skip it so an interpolation doesn't trail a stray
    // empty box. Non-empty chunks (the `button-` head) still emit.
    if (
      (kind === ts.SyntaxKind.TemplateHead ||
        kind === ts.SyntaxKind.TemplateMiddle ||
        kind === ts.SyntaxKind.TemplateTail) &&
      !(node.compilerNode as ts.LiteralLikeNode).text
    ) {
      return;
    }
    // Already captured by an ancestor's synthesised label (the callee of a
    // collapsed Call/New, or any segment of a flattened access chain).
    if (inlined.has(node)) return;
    // Method-chain intermediate (an inner CallExpression or its callee access):
    // elide it and reparent its children onto the chain ROOT, so the base
    // receiver and every argument bubble up as direct children of the one
    // flattened call node (see flattenCallChain). The method-name identifiers
    // are in `inlined`, so only the base + args survive.
    if (chainReparent.has(node)) {
      node.forEachChild((child) => visit(child, parentId));
      return;
    }
    // Skip the Identifier (or BindingPattern) that occupies the .name slot of
    // a named declaration — the declaration itself already carries that name
    // as its label, so emitting a separate block adds visual noise without
    // information.
    if (isParentsNameSlot(node)) return;
    // Pure-wrapper kinds (ImportClause, NamedImports, VariableDeclarationList…)
    // contribute no info beyond "the next layer of structure exists." Elide
    // them and reparent their children so the user sees `import` > `Dog` /
    // `'./Dog'` instead of `import` > `imports` > `named` > `Dog`.
    if (PASSTHROUGH_KINDS.has(kind)) {
      node.forEachChild((child) => visit(child, parentId));
      return;
    }
    // `export default <localName>` — fold this re-export INTO the local
    // declaration it names (flag it as the default export) and skip emitting the
    // separate export node, so a `const X = …; export default X;` reads as ONE
    // node `export default const X` rather than two unrelated boxes.
    if (tryMergeDefaultExport(node)) return;
    pushAndRecurse(node, nextId(), parentId);
  }

  // Returns true (and mutates the target's already-emitted AstNode) when `node`
  // is `export default <Identifier>` re-exporting a LOCAL declaration — the
  // caller then skips emitting this export node entirely. The local decl was
  // emitted earlier (source order), so it's already in idByNode/astById.
  function tryMergeDefaultExport(node: Node): boolean {
    if (node.getKind() !== ts.SyntaxKind.ExportAssignment) return false;
    const ea = node.asKindOrThrow(ts.SyntaxKind.ExportAssignment);
    if (ea.isExportEquals()) return false; // TS `export = x`, not `export default`
    let expr: Node;
    try {
      expr = ea.getExpression();
    } catch {
      return false;
    }
    if (expr.getKind() !== ts.SyntaxKind.Identifier) return false; // inline value, not a name ref
    let symbol: ReturnType<Node['getSymbol']>;
    try {
      symbol = expr.getSymbol();
    } catch {
      return false;
    }
    if (!symbol) return false;
    // Local same-file decl only — do NOT follow getAliasedSymbol (that would jump
    // to an imported decl in another file). Map each declaration to its DISPLAYED
    // node (a VariableDeclaration shows as its VariableStatement; a fn/class shows
    // directly), then to the already-emitted AstNode.
    for (const decl of symbol.getDeclarations()) {
      const displayed =
        decl.getKind() === ts.SyntaxKind.VariableDeclaration
          ? decl.getFirstAncestorByKind(ts.SyntaxKind.VariableStatement)
          : decl.getKind() === ts.SyntaxKind.FunctionDeclaration ||
              decl.getKind() === ts.SyntaxKind.ClassDeclaration
            ? decl
            : undefined;
      if (!displayed) continue;
      const id = idByNode.get(displayed);
      if (!id) continue;
      const targetAst = astById.get(id);
      if (!targetAst) continue;
      targetAst.defaultExport = true;
      // The const/fn/class itself wasn't `isExported()` (only the ExportAssignment
      // was), so mark it exported now: amber fill + zoom-out landmark via the
      // existing `exported`/isHighLevel machinery.
      targetAst.exported = true;
      return true;
    }
    return false;
  }

  function nextId(): string {
    return `${fileId}#${seq++}`;
  }
}

// Tag the three clauses of a C-style `for (init; cond; update)` with their
// role so the client can render the loop as `for [init] ; [cond] ; [update]`
// even when a clause is omitted — positional inference alone can't tell
// `for (;cond;)` from `for (init;;)`. Climbs through pass-through wrappers
// first: the initializer is usually a VariableDeclarationList, which visit()
// elides while reparenting its VariableDeclaration(s) onto the ForStatement,
// so we compare the ForStatement's own initializer / condition / incrementor
// against the emitted node's nearest non-pass-through ancestor. Returns
// undefined for every node that isn't a direct for-clause.
function forClauseRole(node: Node): 'init' | 'cond' | 'update' | undefined {
  let child: Node = node;
  let parent = node.getParent();
  while (parent && PASSTHROUGH_KINDS.has(parent.getKind())) {
    child = parent;
    parent = parent.getParent();
  }
  if (!parent || parent.getKind() !== ts.SyntaxKind.ForStatement) return undefined;
  const f = parent.asKindOrThrow(ts.SyntaxKind.ForStatement);
  if (f.getInitializer() === child) return 'init';
  if (f.getCondition() === child) return 'cond';
  if (f.getIncrementor() === child) return 'update';
  return undefined;
}

// One segment of a flattened method-call chain: the method/property name (the
// `▷ marker` glyph) and how many arguments that call took (so the client can
// interleave `( arg, … )` glyph/child tokens). Matches AstNode.chain.
export interface ChainSegmentInfo {
  marker: string;
  argCount: number;
}

// Flatten a method-call chain rooted at `outerCall` into ordered segments
// (LEFT-TO-RIGHT) for the flat fluent-chain layout. Walks outer→inner: at each
// level the callee must be a `recv.method`(or `recv[lit]`) access — record the
// method as a segment, mark the access node into `chainReparent` (so its
// receiver reparents onto the call) and inline the method-name node; if the
// receiver is itself a CallExpression, mark IT into chainReparent and continue.
// The first non-call receiver is the BASE — it emits normally as the head box.
// Returns segments (L→R) or null if any callee isn't a clean method access
// (e.g. a bare-identifier call, or an element access with a non-literal key) —
// the caller then leaves the node to its existing generic rendering.
function flattenCallChain(
  outerCall: Node,
  inlined: Set<Node>,
  chainReparent: Set<Node>,
): ChainSegmentInfo[] | null {
  const segments: ChainSegmentInfo[] = [];
  let cur: Node = outerCall;
  for (;;) {
    const callee = getCalleeExpression(cur);
    if (!callee) return null;
    const ck = callee.getKind();
    let marker: string;
    let nameNode: Node;
    let receiver: Node;
    if (ck === ts.SyntaxKind.PropertyAccessExpression) {
      const a = callee as unknown as { getNameNode: () => Node; getExpression: () => Node };
      try {
        nameNode = a.getNameNode();
        receiver = a.getExpression();
      } catch {
        return null;
      }
      marker = nameNode.getText();
    } else if (ck === ts.SyntaxKind.ElementAccessExpression) {
      const a = callee as unknown as {
        getArgumentExpression: () => Node | undefined;
        getExpression: () => Node;
      };
      let arg: Node | undefined;
      try {
        arg = a.getArgumentExpression();
        receiver = a.getExpression();
      } catch {
        return null;
      }
      if (!arg) return null;
      const ak = arg.getKind();
      const isLiteralKey =
        ak === ts.SyntaxKind.StringLiteral ||
        ak === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        ak === ts.SyntaxKind.NumericLiteral;
      if (!isLiteralKey) return null;
      marker = `[${arg.getText()}]`;
      nameNode = arg;
    } else {
      return null;
    }
    const argCount =
      (cur as unknown as { getArguments?: () => Node[] }).getArguments?.().length ?? 0;
    // Prepend: we walk outer→inner but want source (L→R) order.
    segments.unshift({ marker, argCount });
    chainReparent.add(callee);
    inlined.add(nameNode);
    for (const d of nameNode.getDescendants()) inlined.add(d);
    if (receiver.getKind() === ts.SyntaxKind.CallExpression) {
      // Another call in the chain — reparent its children up and keep walking.
      chainReparent.add(receiver);
      cur = receiver;
      continue;
    }
    // Reached the base receiver — it renders as the head box. Done.
    return segments.length > 0 ? segments : null;
  }
}

// Synthesised labels for `CallExpression` / `NewExpression`. When the callee
// is collapsible — a bare Identifier (`foo()`) or a member-access chain
// (`a.b.c()`, `this.foo()`, `obj["k"].bar()`) — emit a single label like
// `▷ foo` / `new a.b.c` and add every node whose text contributed to it
// to `inlined`, so the visit pass skips the entire callee subtree.
//
// CallExpressions get a leading `▷` (U+25B7 WHITE RIGHT-POINTING TRIANGLE)
// so the triangle reads as part of the label itself — the renderer treats
// the whole string as one labelPool.put, no special-case polygon.
// `new` keeps its keyword prefix.
//
// Returns null when the callee can't be cleanly captured (e.g. mixed
// call+access chains like `a.b().c()`); the client then falls back to the
// generic "call"/"new" kind label and the access subtree renders normally.
function synthesizeCallLabel(
  node: Node,
  inlined: Set<Node>,
  chainReparent: Set<Node>,
  chainData: Map<Node, ChainSegmentInfo[]>,
): string | null {
  const kind = node.getKind();
  if (kind !== ts.SyntaxKind.NewExpression && kind !== ts.SyntaxKind.CallExpression) {
    return null;
  }
  const callee = getCalleeExpression(node);
  if (!callee) return null;
  const prefix = kind === ts.SyntaxKind.NewExpression ? 'new ' : '▷ ';

  // Build the call's HEAD (callee text only). Type arguments append below.
  let head: string | null = null;

  if (callee.getKind() === ts.SyntaxKind.Identifier) {
    // Bare identifier callee: inline the single Identifier child.
    inlined.add(callee);
    head = callee.getText();
  } else {
    // Member-access chain callee: walk it, then inline every captured node so
    // none of them re-emit as their own rect. Inlining the immediate callee
    // child alone would suffice (forEachChild won't recurse past a skipped
    // node), but tracking all of them is cheap and defensive against future
    // traversal changes.
    const ck = callee.getKind();
    if (
      ck === ts.SyntaxKind.PropertyAccessExpression ||
      ck === ts.SyntaxKind.ElementAccessExpression
    ) {
      const segments: ChainSegment[] = [];
      const captured: Node[] = [];
      if (collectAccessChain(callee, segments, captured)) {
        for (const n of captured) inlined.add(n);
        head = formatChain(segments);
      }
    }
  }
  if (head === null) {
    // The callee didn't collapse to a single label — it's a method call on a
    // complex receiver (`[arr].filter(x)`) or a multi-call chain
    // (`a.f(x).g(y)`). Flatten the whole chain into one node laid out as a flat
    // fluent flow (`[base] ▷f (x) ▷g (y)`); the segments are stamped onto the
    // node via chainData and the intermediate nodes reparent via chainReparent.
    if (kind === ts.SyntaxKind.CallExpression) {
      const segments = flattenCallChain(node, inlined, chainReparent);
      if (segments) chainData.set(node, segments);
    }
    return null;
  }

  // Type arguments fold into the head: `forwardRef<HTMLInputElement,
  // Props>` reads as one label instead of three separate rects (the
  // callee + two wide type-arg boxes). We inline the type-arg subtrees
  // so they don't emit. The bail-out mirrors synthesizeFlatTypeLabel:
  // if any type arg contains an inline TypeLiteral (`<{a: string}>`),
  // we'd lose the ability to drill into it — keep those as separate
  // rects.
  const argsHost = node as unknown as { getTypeArguments?: () => Node[] };
  if (typeof argsHost.getTypeArguments === 'function') {
    const typeArgs = argsHost.getTypeArguments();
    if (typeArgs.length > 0) {
      let canInline = true;
      for (const t of typeArgs) {
        for (const d of t.getDescendants()) {
          if (d.getKind() === ts.SyntaxKind.TypeLiteral) {
            canInline = false;
            break;
          }
        }
        if (!canInline) break;
      }
      if (canInline) {
        head += `<${typeArgs.map((t) => t.getText()).join(', ')}>`;
        for (const t of typeArgs) {
          inlined.add(t);
          for (const d of t.getDescendants()) inlined.add(d);
        }
      }
    }
  }

  return prefix + head;
}

// True when the node is an import binding for a type — covers three
// independent signals:
//   1. `import type { Foo }` / `import type Default from ...`: the
//      enclosing ImportClause's isTypeOnly is set.
//   2. `import { type Foo }`: the ImportSpecifier itself has isTypeOnly.
//   3. `import { Foo } from './types'` where the imported symbol's
//      declarations are exclusively type-level (interface / type
//      alias). The user didn't write `type` but the binding is
//      semantically a type, and the editor highlights it as one.
//
// All three apply to the same set of nodes: ImportSpecifier (named
// imports), or Identifier inside an ImportClause (default imports —
// the Identifier reparents to ImportDeclaration after the elision in
// visit(), so we still recognise it via the ancestry check).
function isTypeImportBinding(node: Node): boolean {
  const k = node.getKind();
  if (
    k !== ts.SyntaxKind.ImportSpecifier &&
    k !== ts.SyntaxKind.Identifier
  ) {
    return false;
  }

  // Confirm we're in an import position by finding the closest
  // ImportClause (bounded by ImportDeclaration / SourceFile). If we
  // don't see one, this is an Identifier somewhere else in the code
  // — bail out so we don't paint every type-named variable green.
  let importClause: Node | null = null;
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const ck = cur.getKind();
    if (ck === ts.SyntaxKind.ImportClause) {
      importClause = cur;
      break;
    }
    if (
      ck === ts.SyntaxKind.SourceFile ||
      ck === ts.SyntaxKind.ImportDeclaration
    ) {
      break;
    }
    cur = cur.getParent();
  }
  if (!importClause) return false;

  // 1. & 2. Syntactic `type` markers — check the ImportSpecifier
  //    itself and the enclosing ImportClause.
  if (k === ts.SyntaxKind.ImportSpecifier) {
    const spec = node as unknown as { isTypeOnly?: () => boolean };
    if (typeof spec.isTypeOnly === 'function') {
      try {
        if (spec.isTypeOnly()) return true;
      } catch {
        /* defensive — fall through */
      }
    }
  }
  const clauseTyped = importClause as unknown as {
    isTypeOnly?: () => boolean;
  };
  if (typeof clauseTyped.isTypeOnly === 'function') {
    try {
      if (clauseTyped.isTypeOnly()) return true;
    } catch {
      /* defensive — fall through */
    }
  }

  // 3. Semantic check: resolve the binding's aliased symbol and look
  //    at its declarations. An import gets the type colour if EVERY
  //    declaration is type-relevant — interface, type alias, OR class.
  //    Classes occupy both the value and type namespaces, and the user
  //    wants them grouped with types here: an `import { Game }` reads
  //    "Game is a class/type from elsewhere," which is the same mental
  //    model as `import { ServerMessage }` (an interface).
  let symbol = node.getSymbol();
  if (!symbol) return false;
  const aliased = symbol.getAliasedSymbol?.();
  if (aliased) symbol = aliased;
  const decls = symbol.getDeclarations();
  if (decls.length === 0) return false;
  return decls.every((d) => {
    const dk = d.getKind();
    return (
      dk === ts.SyntaxKind.InterfaceDeclaration ||
      dk === ts.SyntaxKind.TypeAliasDeclaration ||
      dk === ts.SyntaxKind.ClassDeclaration ||
      dk === ts.SyntaxKind.ClassExpression
    );
  });
}

// Type-position constructs that render as a single labelled rect
// carrying their source text. The wrapping "type" / "array" rect with
// children inside was visual noise — the text IS the type, the
// syntaxKind routes the colour through SYNTAX.type, and inlining
// every descendant suppresses the inner Identifier / inner
// TypeReference / etc. from re-emitting as its own rect.
//
// Covers:
//   * TypeReference: `Player`, `Map<string, Foo>`, `MyNs.Inner`
//   * ArrayType:     `Pulse[]`, `string[][]`
//   * UnionType / IntersectionType: `string | number | readonly string[] | undefined`
//
// Unions/intersections flatten to their full source text because their bare
// keyword members (`string`, `number`, `undefined`, …) are trivial KEYWORD
// tokens that visit() drops — so the old "render members as `A | B` boxes"
// path collapsed `string | number | undefined` down to whichever single member
// happened to be non-trivial (e.g. just `string[]`). Flat text keeps the whole
// union readable, exactly as written.
function synthesizeFlatTypeLabel(node: Node, inlined: Set<Node>): string | null {
  const k = node.getKind();
  const isUnionish =
    k === ts.SyntaxKind.UnionType || k === ts.SyntaxKind.IntersectionType;
  if (k !== ts.SyntaxKind.TypeReference && k !== ts.SyntaxKind.ArrayType && !isUnionish) {
    return null;
  }
  // TypeReference / ArrayType bail out if an inline object type literal `{...}`
  // sits anywhere inside — flattening would inline the TypeLiteral and its
  // members away, but the user wants to drill into those members like an
  // ObjectLiteralExpression. Letting the type emit as its own container keeps
  // the TypeLiteral reachable as a child rect. Unions/intersections ALWAYS
  // flatten (a union must read completely, even with an object-type member).
  if (!isUnionish) {
    for (const d of node.getDescendants()) {
      if (d.getKind() === ts.SyntaxKind.TypeLiteral) return null;
    }
  }
  // Use the array form so every descendant — type-argument identifiers,
  // TypeQuery exprNames, qualified-name segments, the inner element
  // type of an ArrayType, every union member — is unambiguously included
  // before visit() reaches them via forEachChild.
  for (const d of node.getDescendants()) inlined.add(d);
  return oneLineType(node);
}

// Collapse all whitespace (including newlines) in a type's source text to
// single spaces, so a multi-line type baked into a label stays ONE line — a
// multi-line label is MEASURED as a single wide line but RENDERS as several,
// overflowing its box.
function oneLineType(typeNode: Node): string {
  return typeNode.getText().replace(/\s+/g, ' ').trim();
}

// Build a `name: Type` chip label, baking the type into the name and inlining
// the type node — EXCEPT when the type is an inline object `{ … }`
// (`TypeLiteral`): then leave it as a drillable `{}` child (return just
// `name:`), so a big object type doesn't overflow the chip as flat,
// un-highlightable, multi-line text. Used for both Parameters and interface /
// type-literal members.
function bakeNamedType(base: string, typeNode: Node | undefined, inlined: Set<Node>): string | null {
  if (!typeNode) return base || null;
  if (typeNode.getKind() === ts.SyntaxKind.TypeLiteral) {
    return `${base}:`; // drillable `{}` child emits below the `name:` chip
  }
  inlined.add(typeNode);
  for (const d of typeNode.getDescendants()) inlined.add(d);
  return `${base}: ${oneLineType(typeNode)}`;
}

// Synthesised label for prefix / postfix unary expressions: `!id`,
// `-x`, `++i`, `i--`. Without this every unary became a container
// labelled `unary` with the operand as a single child rect — the
// operator (`!` vs `-` vs `++`) was invisible AND a tiny one-name
// unary doubled in size for no information gain. The inlined form
// reads exactly like source.
//
// We only inline the operand when it's atomic enough that the
// `${op}${text}` concatenation makes sense:
//   * Identifier (`id`, `simulated`)
//   * Literals (string / number / true / false / null)
//   * `this` / `super`
//   * Member-access chains (`obj.x`, `arr[0]`) — these already
//     synthesise as a single dotted label, so prefixing with the
//     operator keeps the one-rect read.
// For anything else (a call, a binary, a nested expression) we keep
// just the operator as the label and let the operand render as a
// child — `! [▷ isValid]` reads better than `!▷ isValid()`.
function synthesizeUnaryLabel(node: Node, inlined: Set<Node>): string | null {
  const kind = node.getKind();
  if (
    kind !== ts.SyntaxKind.PrefixUnaryExpression &&
    kind !== ts.SyntaxKind.PostfixUnaryExpression
  ) {
    return null;
  }
  const u = node as unknown as {
    getOperatorToken: () => ts.SyntaxKind;
    getOperand: () => Node | undefined;
  };
  const opText = ts.tokenToString(u.getOperatorToken());
  if (!opText) return null;
  const operand = u.getOperand();
  if (!operand) return opText;
  if (isInlinableUnaryOperand(operand)) {
    inlined.add(operand);
    for (const d of operand.getDescendants()) inlined.add(d);
    const text = operand.getText();
    return kind === ts.SyntaxKind.PrefixUnaryExpression
      ? `${opText}${text}`
      : `${text}${opText}`;
  }
  // Complex operand stays as a child rect; the operator alone is the
  // label so the user can still see whether this is `!`, `-`, `++`…
  return opText;
}

function isInlinableUnaryOperand(node: Node): boolean {
  const k = node.getKind();
  return (
    k === ts.SyntaxKind.Identifier ||
    k === ts.SyntaxKind.StringLiteral ||
    k === ts.SyntaxKind.NumericLiteral ||
    k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    k === ts.SyntaxKind.TrueKeyword ||
    k === ts.SyntaxKind.FalseKeyword ||
    k === ts.SyntaxKind.NullKeyword ||
    k === ts.SyntaxKind.ThisKeyword ||
    k === ts.SyntaxKind.SuperKeyword ||
    k === ts.SyntaxKind.PropertyAccessExpression ||
    k === ts.SyntaxKind.ElementAccessExpression
  );
}

// Synthesised label for JSX opening / closing / self-closing elements
// and fragments. Surfaces the angle brackets so the diagram reads as
// JSX source:
//   * `<Foo>`     for the opening tag of a non-self-closing element
//   * `</Foo>`    for the closing tag
//   * `<Foo />`   for a self-closing element
//   * `<>` / `</>`for fragment open / close
// Without this, ts-morph's getName() would return just `Foo` for all
// three element forms, so a JsxElement like `<Foo>...</Foo>` rendered
// as two indistinguishable rects both labelled `Foo` — losing the
// open/close distinction the user reads at a glance in source.
//
// The tag name node (Identifier, or PropertyAccessExpression for
// `<Foo.Bar>`) is inlined so it doesn't surface as its own child rect
// inside the opening/closing element's box. Attributes stay as kids:
// they're separate JsxAttribute children of JsxOpeningElement /
// JsxSelfClosingElement and aren't part of the tag-name subtree.
function synthesizeJsxLabel(node: Node, inlined: Set<Node>): string | null {
  const kind = node.getKind();
  if (kind === ts.SyntaxKind.JsxOpeningFragment) return '<>';
  if (kind === ts.SyntaxKind.JsxClosingFragment) return '</>';
  if (kind === ts.SyntaxKind.JsxFragment) return '<>…</>';
  // JsxElement is the wrapper around `<Foo>…</Foo>` (opening tag,
  // children, closing tag). The wrapper itself is expandable on the
  // client (see EXPANDABLE_KINDS) — collapsed it reads as `<Foo>…</Foo>`
  // so the tag is still identifiable; expanded, the inner opening /
  // children / closing emit as their own rects.
  if (kind === ts.SyntaxKind.JsxElement) {
    const elementHost = node as unknown as {
      getOpeningElement?: () => Node | undefined;
      getClosingElement?: () => Node | undefined;
    };
    const opening = elementHost.getOpeningElement?.();
    if (!opening) return null;
    const openingTagHost = opening as unknown as {
      getTagNameNode?: () => Node | undefined;
    };
    const tagNode = openingTagHost.getTagNameNode?.();
    if (!tagNode) return null;
    // The opening element is a pass-through (its attributes reparent onto this
    // JsxElement), so inline its tag-name subtree here — otherwise the bare
    // `Foo` identifier would surface as a stray child once the wrapper is
    // elided. Inline the WHOLE closing element too (`</Foo>`): it's redundant
    // with this header and the user doesn't want a separate closing block.
    inlined.add(tagNode);
    for (const d of tagNode.getDescendants()) inlined.add(d);
    const closing = elementHost.getClosingElement?.();
    if (closing) {
      inlined.add(closing);
      for (const d of closing.getDescendants()) inlined.add(d);
    }
    // Header reads `<Foo />` — the component identity, like `ƒ name` for a
    // function. Children render to the right (see jsxLayout), so the tag is a
    // marker, not literal self-closing syntax.
    return `<${tagNode.getText()} />`;
  }
  if (
    kind !== ts.SyntaxKind.JsxOpeningElement &&
    kind !== ts.SyntaxKind.JsxClosingElement &&
    kind !== ts.SyntaxKind.JsxSelfClosingElement
  ) {
    return null;
  }
  // ts-morph exposes getTagNameNode() on all three; duck-type to keep
  // this code independent of which exact ts-morph subclass we're on.
  const tagHost = node as unknown as { getTagNameNode?: () => Node | undefined };
  const tagNode = tagHost.getTagNameNode?.();
  if (!tagNode) return null;
  inlined.add(tagNode);
  for (const d of tagNode.getDescendants()) inlined.add(d);
  const tag = tagNode.getText();
  if (kind === ts.SyntaxKind.JsxClosingElement) return `</${tag}>`;
  if (kind === ts.SyntaxKind.JsxSelfClosingElement) return `<${tag} />`;
  return `<${tag}>`;
}

// Synthesised label for a standalone PropertyAccess/ElementAccess — one that
// is *not* the callee of a Call/New whose label already inlined it (or one
// whose Call couldn't be collapsed). Renders the dotted path as a single
// rect label and inlines every captured *child* so they don't re-emit. The
// node itself stays — it's the rect being labeled.
function synthesizeAccessLabel(node: Node, inlined: Set<Node>): string | null {
  const segments: ChainSegment[] = [];
  const captured: Node[] = [];
  if (!collectAccessChain(node, segments, captured)) return null;
  for (const n of captured) {
    if (n !== node) inlined.add(n);
  }
  return formatChain(segments);
}

interface ChainSegment {
  text: string;
  // True when the segment is an element-access key (rendered `[key]` rather
  // than `.name`). Element access only contributes when the key is a literal
  // — non-literal keys would pull arbitrary expressions into the label.
  bracket: boolean;
}

// Walks a PropertyAccess / ElementAccess chain right-to-left (the AST is
// left-recursive — `a.b.c` is `(a.b).c`) and pushes the segments into
// `segments` in left-to-right (source) order. `captured` accumulates every
// node whose text was consumed, including the access nodes themselves and
// every Identifier / ThisKeyword / SuperKeyword / literal element-access key.
//
// Returns false when the chain contains anything other than access nodes and
// identifier-like leaves (e.g. a CallExpression mid-chain or an
// ElementAccessExpression with a non-literal key). The caller treats this as
// "not collapsible" and bails out — the inner expression will render its own
// labelled rect.
function collectAccessChain(
  node: Node,
  segments: ChainSegment[],
  captured: Node[],
): boolean {
  const reverse: ChainSegment[] = [];
  let cursor: Node = node;
  while (true) {
    const k = cursor.getKind();
    if (k === ts.SyntaxKind.PropertyAccessExpression) {
      const access = cursor as unknown as {
        getNameNode: () => Node;
        getExpression: () => Node;
      };
      let nameNode: Node;
      let expr: Node;
      try {
        nameNode = access.getNameNode();
        expr = access.getExpression();
      } catch {
        return false;
      }
      reverse.push({ text: nameNode.getText(), bracket: false });
      captured.push(cursor, nameNode);
      cursor = expr;
    } else if (k === ts.SyntaxKind.ElementAccessExpression) {
      const access = cursor as unknown as {
        getArgumentExpression: () => Node | undefined;
        getExpression: () => Node;
      };
      let arg: Node | undefined;
      let expr: Node;
      try {
        arg = access.getArgumentExpression();
        expr = access.getExpression();
      } catch {
        return false;
      }
      if (!arg) return false;
      const ak = arg.getKind();
      const isLiteralKey =
        ak === ts.SyntaxKind.StringLiteral ||
        ak === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        ak === ts.SyntaxKind.NumericLiteral;
      if (!isLiteralKey) return false;
      reverse.push({ text: arg.getText(), bracket: true });
      captured.push(cursor, arg);
      cursor = expr;
    } else if (
      k === ts.SyntaxKind.Identifier ||
      k === ts.SyntaxKind.ThisKeyword ||
      k === ts.SyntaxKind.SuperKeyword ||
      // `import.meta` / `new.target` — a single MetaProperty node whose text
      // already reads as the dotted base, so it's an atomic chain leaf. Without
      // this, `import.meta.env.DEV` bails out of synthesis and renders as
      // nested "access" boxes instead of one dotted-path rect.
      k === ts.SyntaxKind.MetaProperty
    ) {
      reverse.push({ text: cursor.getText(), bracket: false });
      captured.push(cursor);
      for (let i = reverse.length - 1; i >= 0; i--) segments.push(reverse[i]);
      return true;
    } else {
      return false;
    }
  }
}

// Caps for chain labels. 3 segments / 40 chars keeps the label legible inside
// a typical rect while still preserving the head ("where it lives") and the
// tail ("what it is"). Chains beyond this collapse to `head.…tail`.
const MAX_CHAIN_SEGMENTS = 3;
const MAX_CHAIN_CHARS = 40;

// Joins access-chain segments into a single label, applying head+tail
// elision when the chain is too long. Examples:
//   ["console", "log"]                          → "console.log"
//   ["a", "b", "c", "d", "foo"]                 → "a.…foo"
//   ["this", "user", "profile", "address","zip"]→ "this.…zip"
//   ["obj", "key" {bracket}, "bar"]             → "obj[key].bar"
function formatChain(segments: ChainSegment[]): string {
  const join = (segs: ChainSegment[]): string => {
    let out = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.bracket) out += `[${seg.text}]`;
      else if (i === 0) out += seg.text;
      else out += '.' + seg.text;
    }
    return out;
  };

  const full = join(segments);
  const tooManySegments = segments.length > MAX_CHAIN_SEGMENTS;
  const tooLong = full.length > MAX_CHAIN_CHARS;
  if (!tooManySegments && !tooLong) return full;

  if (segments.length >= 2) {
    const first = segments[0];
    const last = segments[segments.length - 1];
    const firstText = first.bracket ? `[${first.text}]` : first.text;
    const lastText = last.bracket ? `[${last.text}]` : '.' + last.text;
    const elided = firstText + '.…' + lastText;
    if (elided.length <= MAX_CHAIN_CHARS) return elided;
    return elided.slice(0, MAX_CHAIN_CHARS - 1) + '…';
  }
  return full.slice(0, MAX_CHAIN_CHARS - 1) + '…';
}

function getCalleeExpression(node: Node): Node | undefined {
  const candidate = node as unknown as { getExpression?: () => Node | undefined };
  if (typeof candidate.getExpression !== 'function') return undefined;
  try {
    return candidate.getExpression();
  } catch {
    return undefined;
  }
}

// Returns true when `node` is the .name slot of its parent declaration AND the
// parent's name is something we'd actually display (i.e. the parent isn't a
// reference-kind whose name we suppress in friendlyName — those have a
// meaningful Identifier child that we keep, unless it's already inlined into a
// synthesised label, which the inlined-set check in visit() handles).
function isParentsNameSlot(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (REFERENCE_KINDS_TO_SKIP.has(parent.getKind())) return false;
  // When the parent is elided as a passthrough wrapper, its name slot must
  // surface as a child of the grandparent — otherwise default imports like
  // `Dog` in `import Dog from './x'` would vanish entirely (the ImportClause
  // declaring the name is gone, and so would be its name Identifier).
  if (PASSTHROUGH_KINDS.has(parent.getKind())) return false;
  // Binding patterns ({ a, b } or [a, b]) are STRUCTURED names, not
  // plain identifiers. ts-morph's getName() helpfully returns the
  // pattern's source text on the parent (Parameter / VariableDeclaration),
  // which would normally tell us to absorb the pattern into the parent's
  // label and drop it. But a React component's props parameter IS the
  // pattern — the user wants to drill into it like a code block. Keep
  // the pattern as its own emitted rect; the client treats it as an
  // expandable cell (see EXPANDABLE_KINDS in PixiCanvas.tsx).
  const k = node.getKind();
  if (
    k === ts.SyntaxKind.ObjectBindingPattern ||
    k === ts.SyntaxKind.ArrayBindingPattern
  ) {
    return false;
  }
  const candidate = parent as unknown as {
    getNameNode?: () => Node | undefined;
    getName?: () => string | undefined;
  };
  if (typeof candidate.getNameNode !== 'function') return false;
  let parentName: string | undefined;
  try {
    parentName = candidate.getName?.();
  } catch {
    return false;
  }
  if (!parentName) return false;
  let nameNode: Node | undefined;
  try {
    nameNode = candidate.getNameNode();
  } catch {
    return false;
  }
  return nameNode === node;
}

// TypeScript's SyntaxKind enum defines several "FirstX" / "LastX" aliases
// (e.g. FirstStatement = VariableStatement). Because the aliases share the
// same numeric value with the canonical name, the reverse string lookup
// `ts.SyntaxKind[kind]` can return either form depending on enum
// declaration order — usually the alias. We map known collisions back to
// the canonical name so the wire shows "VariableStatement", not
// "FirstStatement".
const KIND_ALIAS_OVERRIDES: Record<string, string> = {
  FirstStatement: 'VariableStatement',
  LastStatement: 'DebuggerStatement',
  FirstNode: 'QualifiedName',
};

function syntaxKindName(kind: ts.SyntaxKind): string {
  const name = ts.SyntaxKind[kind];
  return KIND_ALIAS_OVERRIDES[name] ?? name;
}

// Operator glyph for "relational" nodes the client renders as
// [left] op [right]:
//   * a BinaryExpression's actual operator (covers `=`, `+`,
//     `===`, `&&`, `+=`, …)
//   * the implicit `=` of an initialized variable declaration
//     (`let i = j`) or class property (`tickInterval = null`)
//   * the `|` / `&` between members of a TypeScript Union /
//     Intersection type (`A | B`, `A & B`).
// Undefined for everything else.
function operatorOf(node: Node): string | undefined {
  if (Node.isBinaryExpression(node)) {
    return node.getOperatorToken().getText();
  }
  if (Node.isVariableDeclaration(node) && node.getInitializer()) {
    return '=';
  }
  if (Node.isPropertyDeclaration(node) && node.getInitializer()) {
    return '=';
  }
  const k = node.getKind();
  if (k === ts.SyntaxKind.UnionType) return '|';
  if (k === ts.SyntaxKind.IntersectionType) return '&';
  return undefined;
}

// Variable-ish role for the client's decl styling (see AstNode.decl):
// the declaration keyword for VariableStatement / VariableDeclaration
// ('using' / 'await using' get none — no visual language for them yet),
// 'field' for class properties, 'mutation' for assignment operators on
// existing bindings.
function declOf(node: Node): AstNode['decl'] {
  const classic = (k: string): AstNode['decl'] =>
    k === 'const' || k === 'let' || k === 'var' ? (k as AstNode['decl']) : undefined;
  if (Node.isVariableStatement(node)) {
    return classic(node.getDeclarationList().getDeclarationKind());
  }
  if (Node.isVariableDeclaration(node)) {
    const parent = node.getParent();
    return Node.isVariableDeclarationList(parent) ? classic(parent.getDeclarationKind()) : undefined;
  }
  if (Node.isPropertyDeclaration(node)) return 'field';
  if (Node.isBinaryExpression(node)) {
    const k = node.getOperatorToken().getKind();
    // FirstAssignment (`=`) .. LastAssignment covers every compound form
    // (`+=` … `??=`) — all mutations of an existing binding.
    if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) return 'mutation';
  }
  return undefined;
}

// Part of the module's public surface? Exportable declarations carry an
// `isExported()` (covers `export class/fn/const/...`, and `class X {}; export
// { X }`); `export ...` / `export default ...` statements count too. Returns
// undefined (omitted from the wire) when not exported, to keep payloads lean.
function exportedOf(node: Node): true | undefined {
  if (Node.isExportable(node) && node.isExported()) return true;
  const k = node.getKind();
  if (
    k === ts.SyntaxKind.ExportDeclaration ||
    k === ts.SyntaxKind.ExportAssignment
  ) {
    return true;
  }
  return undefined;
}

// `abstract` class / method / property / accessor. Undefined (omitted from
// the wire) otherwise, to keep payloads lean.
function abstractOf(node: Node): true | undefined {
  return Node.isAbstractable(node) && node.isAbstract() ? true : undefined;
}

// `static` method / property / accessor / block. Same omit-when-false
// convention.
function staticOf(node: Node): true | undefined {
  return Node.isStaticable(node) && node.isStatic() ? true : undefined;
}

// `readonly` property / parameter. ts-morph's Readonlyable surface covers
// PropertyDeclaration, PropertySignature, ParameterDeclaration,
// IndexSignatureDeclaration.
function readonlyOf(node: Node): true | undefined {
  return Node.isReadonlyable(node) && node.isReadonly() ? true : undefined;
}

// Source-text signature for a function-like or a typed declaration.
// Returned text:
//   * function/method/arrow/constructor/getter/setter:
//       `(p: T, q: U): R`
//     Built from each parameter's getText() and the explicit return
//     type's getText(). Missing return type → omit the `: R`.
//   * property / variable / parameter with an explicit type:
//       `: T`
//     Pulled from getTypeNode().getText(). No annotation → undefined.
// Hover tooltip renders this. Cheap textual snapshot — no checker
// involvement.
// Return-type text of a function-like (`VisibleEntityState[]`, `boolean`, …),
// independent of whether the type is emitted as a child node — primitive
// returns (`boolean`) are trivial keywords and emit no child, so this string
// is the uniform source the client renders inline after the `:` in the
// signature. Today scoped to the named function kinds the client templates;
// widen alongside SYNTAX_TEMPLATES if more are added.
function returnTypeOf(node: Node): string | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node)
  ) {
    return node.getReturnTypeNode()?.getText();
  }
  return undefined;
}

// SyntaxKind names the renderer collapses into a click-to-expand cell.
// MUST mirror EXPANDABLE_KINDS in src/render/astStyle.ts — only these
// kinds get a `preview`, since the tooltip's "peek at the collapsed
// content" affordance is meaningless for nodes that already render in
// full. Kept as a name set (not ts.SyntaxKind) so it reads identically
// to the client list it shadows.
const PREVIEW_KINDS = new Set<string>([
  'Block',
  'ObjectLiteralExpression',
  'TypeLiteral',
  'ObjectBindingPattern',
  'InterfaceDeclaration',
  'TypeAliasDeclaration',
  'ClassDeclaration',
  'VariableStatement',
  'JsxElement',
  'JsxFragment',
]);

// First source line of an expandable block's CONTENT, for the hover tooltip.
// The structural wrapping braces are stripped — a leading `{` (a block/object
// open) and any trailing `{`/`}` (a body opener like `class Foo {`, or a lone
// closing brace) — so the peek reads as code, not delimiters: `const y = 2; …`
// not `{ const y = 2; …`, `class Foo extends Bar` not `class Foo extends Bar {`.
// We scan to the first line with content after stripping, since a block opens
// on a bare `{` line. A trailing "…" signals more content lines follow.
function previewOf(node: Node): string | undefined {
  if (!PREVIEW_KINDS.has(syntaxKindName(node.getKind()))) return undefined;
  const lines = node
    .getSourceFile()
    .getFullText()
    .slice(node.getStart(), node.getEnd())
    .split('\n');
  const clean = (l: string) => l.replace(/^\s*\{\s*/, '').replace(/[\s{}]+$/, '').trim();
  let idx = 0;
  let firstLine = '';
  for (; idx < lines.length; idx++) {
    firstLine = clean(lines[idx]);
    if (firstLine) break;
  }
  if (!firstLine) return undefined;
  const more = lines.slice(idx + 1).some((l) => clean(l) !== '');
  return more ? `${firstLine} …` : firstLine;
}

// Full import statement for an imported NAME box — a named specifier
// (`Foo` / `Foo as F` / `type Foo`), a default binding (`Dog`), or a namespace
// (`* as ns`) — so hovering it shows `import { Foo } from './x'`. The TS
// analogue of the per-name import preview the Python analyzer builds: only the
// name that box represents is reconstructed, not the whole (possibly multi-name)
// statement, so each box's tooltip names its own origin. Quote style of the
// module specifier is preserved from source.
function importPreviewOf(node: Node): string | undefined {
  const k = node.getKind();
  const eligible =
    k === ts.SyntaxKind.ImportSpecifier ||
    k === ts.SyntaxKind.NamespaceImport ||
    // A default-import binding is a plain Identifier under the ImportClause.
    k === ts.SyntaxKind.Identifier;
  if (!eligible) return undefined;
  // Walk up to the ImportDeclaration through ONLY import-internal wrappers, so a
  // plain identifier (or a specifier's inner identifier) elsewhere never
  // qualifies — the first non-import parent disqualifies the node.
  let decl: Node | undefined;
  let cur: Node | undefined = node.getParent();
  for (let hops = 0; cur && hops < 6; hops++) {
    const ck = cur.getKind();
    if (ck === ts.SyntaxKind.ImportDeclaration) {
      decl = cur;
      break;
    }
    if (ck !== ts.SyntaxKind.ImportClause && ck !== ts.SyntaxKind.NamedImports) return undefined;
    cur = cur.getParent();
  }
  const impDecl = decl?.asKind(ts.SyntaxKind.ImportDeclaration);
  if (!impDecl) return undefined;
  const modText = impDecl.getModuleSpecifier().getText(); // includes original quotes
  const typeKw = impDecl.getImportClause()?.isTypeOnly() ? 'type ' : '';
  const nameText = node.getText().replace(/\s+/g, ' ').trim();
  const inner = k === ts.SyntaxKind.ImportSpecifier ? `{ ${nameText} }` : nameText;
  return `import ${typeKw}${inner} from ${modText}`;
}

function signatureOf(node: Node): string | undefined {
  // Function-likes: parenthesised parameter list + optional return.
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    const params = node.getParameters().map((p) => p.getText());
    const rt = node.getReturnTypeNode()?.getText();
    return rt
      ? `(${params.join(', ')}): ${rt}`
      : `(${params.join(', ')})`;
  }
  // Typed declarations: just the `: T` slot. Parameters AND PropertySignatures
  // are EXCLUDED — their type is already baked into the name (`hull: ShipHull`,
  // `disabled?: boolean`, see friendlyName/bakeNamedType), so a `: T` signature
  // would duplicate it in the hover tooltip.
  if (Node.isPropertyDeclaration(node) || Node.isVariableDeclaration(node)) {
    const tn = node.getTypeNode();
    return tn ? `: ${tn.getText()}` : undefined;
  }
  return undefined;
}

// Signature of the function/constructor being CALLED, surfaced in the hover
// tooltip for a `CallExpression` / `NewExpression`.
//
// PERF — this must NOT materialise types. An earlier version called
// `callee.getType().getCallSignatures()`, which forces the checker to expand
// full type information for the callee; doing that per call site across a
// large solution-style project exhausted memory and crashed the server.
// Instead we resolve the callee's SYMBOL to its declaration — the same bounded
// operation semantic-edges.ts already performs for every call — and read the
// declaration's SOURCE TEXT via signatureOf (pure getText, no type work). The
// trade-off vs. the old approach: no overload selection, no generic
// instantiation, and un-annotated returns aren't inferred — the tooltip shows
// exactly what the author wrote at the declaration, which is also what hovering
// the definition shows.
//
// Defensive throughout: symbol resolution can throw on unresolved/malformed
// nodes, and a missing signature simply means "no tooltip for this call."
function callSignatureOf(node: Node): string | undefined {
  if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return undefined;
  const callee = getCalleeExpression(node);
  if (!callee) return undefined;
  const isNew = Node.isNewExpression(node);
  try {
    let symbol = callee.getSymbol();
    if (!symbol) return undefined;
    const aliased = symbol.getAliasedSymbol?.();
    if (aliased) symbol = aliased;
    for (const decl of symbol.getDeclarations()) {
      const sig = declarationCallSignature(decl, isNew);
      if (sig) return sig;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Source-text call signature for the DECLARATION a callee symbol resolves to.
// Pure getText() — never materialises a type. Handles the shapes a callee
// commonly points at:
//   * function-likes directly (function / method / arrow / ctor / get / set /
//     call-signature member) via signatureOf
//   * a const / property / parameter whose initializer is a function or arrow
//   * a class (only for `new`) -> its constructor's parameter list, or `()`
function declarationCallSignature(decl: Node, isNew: boolean): string | undefined {
  // signatureOf yields `(...)`/`(...): R` for function-likes and `: T` for
  // typed value declarations — only the parenthesised form is a call signature.
  const direct = signatureOf(decl);
  if (direct && direct.startsWith('(')) return direct;

  const init = (decl as { getInitializer?: () => Node | undefined }).getInitializer?.();
  if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
    const s = signatureOf(init);
    if (s) return s;
  }

  if (isNew && Node.isClassDeclaration(decl)) {
    const ctor = decl.getConstructors()[0];
    const s = ctor ? signatureOf(ctor) : undefined;
    return s ?? '()';
  }
  return undefined;
}

// Type hint for a destructured property — the `: T` shown in the hover tooltip
// for a `BindingElement` like `name` in `({ name, id }: Props) => …`. The type
// isn't written at the element; it lives on the PATTERN's annotation (`: Props`
// / `: { … }`). We resolve it the same SAFE way as call signatures — symbol
// resolution + source text, never `getType()` materialisation (which OOM'd a
// large project). Best-effort: returns undefined for shapes it can't read from
// source (intersections, mapped types, inherited members), per "if possible".
function propertyTypeOf(node: Node): string | undefined {
  if (!Node.isBindingElement(node)) return undefined;
  // The property being destructured: the rename source (`{ a: b }` -> `a`) when
  // present, else the bound name itself (`{ name }` -> `name`).
  const propName = (node.getPropertyNameNode() ?? node.getNameNode())?.getText();
  if (!propName) return undefined;
  const pattern = node.getParent();
  if (!pattern || !Node.isObjectBindingPattern(pattern)) return undefined;
  // The pattern's typed declaration (Parameter / VariableDeclaration).
  const typeNode = (
    pattern.getParent() as { getTypeNode?: () => Node | undefined } | undefined
  )?.getTypeNode?.();
  if (!typeNode) return undefined;
  try {
    const t = memberTypeText(typeNode, propName);
    return t ? `: ${t}` : undefined;
  } catch {
    return undefined;
  }
}

// Source text of property `name`'s type as declared in `typeNode` — an inline
// object type (`{ name: string }`) or a reference to an interface / type alias.
// `getProperty` lives on TypeElementMemberedNode, shared by both TypeLiteral
// and InterfaceDeclaration. Pure getText — no type materialisation.
function memberTypeText(typeNode: Node, name: string): string | undefined {
  if (Node.isTypeLiteral(typeNode)) {
    return typeNode.getProperty(name)?.getTypeNode()?.getText();
  }
  if (Node.isTypeReference(typeNode)) {
    let symbol = typeNode.getTypeName().getSymbol();
    if (!symbol) return undefined;
    const aliased = symbol.getAliasedSymbol?.();
    if (aliased) symbol = aliased;
    for (const decl of symbol.getDeclarations()) {
      if (Node.isInterfaceDeclaration(decl)) {
        const t = decl.getProperty(name)?.getTypeNode()?.getText();
        if (t) return t;
      } else if (Node.isTypeAliasDeclaration(decl)) {
        const tn = decl.getTypeNode();
        if (tn && Node.isTypeLiteral(tn)) {
          const t = tn.getProperty(name)?.getTypeNode()?.getText();
          if (t) return t;
        }
      }
    }
  }
  return undefined;
}

// Accessibility scope: 'private' / 'protected' / undefined (public).
// ts-morph's Scopeable is on the class-member declarations + parameter
// properties; getScope() returns 'public' for the absence of any
// modifier, which we map back to undefined so the wire stays lean.
function accessibilityOf(node: Node): 'private' | 'protected' | undefined {
  if (!Node.isScopeable(node)) return undefined;
  const s = node.getScope();
  return s === 'private' || s === 'protected' ? s : undefined;
}

// Base type text of a class/interface `extends` clause, rendered inline on
// the header. A class has at most one; an interface may extend several.
function extendsNameOf(node: Node): string | undefined {
  if (Node.isClassDeclaration(node)) {
    return node.getExtends()?.getText() || undefined;
  }
  if (Node.isInterfaceDeclaration(node)) {
    const exts = node.getExtends();
    return exts.length ? exts.map((e) => e.getText()).join(', ') : undefined;
  }
  return undefined;
}

function isTrivialToken(kind: ts.SyntaxKind): boolean {
  // SyntaxKind enum is laid out so punctuation and keyword tokens occupy
  // contiguous ranges (FirstPunctuation..LastPunctuation, FirstKeyword..LastKeyword).
  // Skip those plus the "Unknown" / "EndOfFileToken" sentinels.
  if (kind === ts.SyntaxKind.EndOfFileToken) return true;
  // Value-literal keywords are NOT trivial — their identity (which keyword)
  // carries real information that the user expects to see. `null`, `true`,
  // and `false` appear as initializers (`= null`), operands, and union
  // members (`Foo | null`); collapsing them with other punctuation would
  // leave those positions visibly empty.
  if (
    kind === ts.SyntaxKind.NullKeyword ||
    kind === ts.SyntaxKind.TrueKeyword ||
    kind === ts.SyntaxKind.FalseKeyword
  ) {
    return false;
  }
  if (kind >= ts.SyntaxKind.FirstPunctuation && kind <= ts.SyntaxKind.LastPunctuation) return true;
  if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) return true;
  return false;
}

// Reference-like expression / clause kinds whose `getName()` returns the
// *target* of a reference (the property being accessed, the type being
// referenced, the class being extended). friendlyName suppresses getName for
// these so the referenced symbol doesn't appear *inside* the rect of the
// surrounding scope — semantic edges already convey the relationship.
//
// PropertyAccess and ElementAccess are handled specially earlier in
// friendlyName via synthesizeAccessLabel; they're kept in this set so
// `isParentsNameSlot` opts out for them — when chain synthesis fails (a
// mixed call+access chain), the .name Identifier should still render as its
// own child rect instead of vanishing.
const REFERENCE_KINDS_TO_SKIP = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.TypeReference,
  ts.SyntaxKind.HeritageClause,
  ts.SyntaxKind.ExpressionWithTypeArguments,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
]);

// Compact, single-line summary of a binding pattern for a collapsed-cell
// label: `{ first, second, … }` (or `[a, b, … ]`). The full list of bindings
// is visible when the declaration is expanded — a collapsed
// `const { … } = useHook()` cell only needs to identify itself. Inlining every
// destructured name VERBATIM (via getName(), which returns the pattern's source
// text complete with the developer's newlines/indentation) produced a giant
// multi-line label, and the layout couldn't place that huge cell sensibly — it
// floated in open space. We cap the shown names by a small character budget.
function compactBindingPattern(pattern: Node): string {
  const isArray = pattern.getKind() === ts.SyntaxKind.ArrayBindingPattern;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const elements = (pattern as unknown as {getElements(): Node[]}).getElements();
  const names: string[] = [];
  for (const el of elements) {
    if (Node.isBindingElement(el)) {
      names.push((el.getDotDotDotToken() ? '...' : '') + el.getName());
    }
    // ArrayBindingPattern holes (OmittedExpression) contribute no name.
  }
  if (names.length === 0) return `${open}${close}`;
  const BUDGET = 32;
  let acc = '';
  let shown = 0;
  for (const nm of names) {
    const next = acc ? `${acc}, ${nm}` : nm;
    if (shown > 0 && next.length > BUDGET) break;
    acc = next;
    shown++;
  }
  const tail = shown < names.length ? ', …' : '';
  return `${open} ${acc}${tail} ${close}`;
}

// Public entry point. Suppresses the Decorator wrapper itself and
// rewrites its expression's label with an `@` prefix — turning the
// previously redundant `[Decorator(name=Component)] > [▷ Component(...)]`
// nesting into a single rect labelled `@Component(...)`. The prefix
// rewrite applies to every label-source (synthesizeCallLabel,
// Identifier, synthesizeAccessLabel, getName fallback) by sitting at
// the wrapper level rather than inside each branch. A final whitespace
// normalization collapses any newlines/indentation that leaked in from
// source text (e.g. a multi-line type annotation) so EVERY label is a
// single line — a label is a compact summary, never a verbatim excerpt.
function friendlyName(
  node: Node,
  inlined: Set<Node>,
  chainReparent: Set<Node>,
  chainData: Map<Node, ChainSegmentInfo[]>,
): string | null {
  if (node.getKind() === ts.SyntaxKind.Decorator) {
    // The Decorator wrapper has no label; its child (the call /
    // identifier / member access) becomes the rect via the single-
    // child non-significant collapse, with the `@` prefix attached
    // there.
    return null;
  }
  const rawText = rawFriendlyName(node, inlined, chainReparent, chainData);
  // Collapse any source whitespace (newlines/indentation) to single spaces so
  // a label is always one line — see compactBindingPattern's note.
  const raw = rawText == null ? rawText : rawText.replace(/\s+/g, ' ').trim();
  // If THIS node is the immediate expression of a Decorator, prefix
  // with `@` (matching the source syntax). Strip our common label
  // prefixes so we don't end up with `@▷ Foo`.
  const parent = node.getParent();
  if (parent && parent.getKind() === ts.SyntaxKind.Decorator) {
    if (!raw) return null;
    let stripped = raw;
    if (stripped.startsWith('▷ ')) stripped = stripped.slice(2);
    else if (stripped.startsWith('new ')) stripped = stripped.slice(4);
    return '@' + stripped;
  }
  return raw;
}

function rawFriendlyName(
  node: Node,
  inlined: Set<Node>,
  chainReparent: Set<Node>,
  chainData: Map<Node, ChainSegmentInfo[]>,
): string | null {
  const kind = node.getKind();

  // Synthesised "new Foo" / "call bar" / "call a.b.c" labels for Call/New.
  // On success the callee subtree is added to `inlined`. A method chain that
  // doesn't collapse to one label returns null here but stamps chainData.
  const synthesised = synthesizeCallLabel(node, inlined, chainReparent, chainData);
  if (synthesised !== null) return synthesised;

  // Type-position nodes (TypeReference, ArrayType, …) render as a
  // single labelled rect carrying their source text. Inlines every
  // descendant so the inner Identifier / element-type doesn't emit
  // its own rect. The client paints these in SYNTAX.type because
  // their syntaxKind is type-categorised.
  const flatTypeLabel = synthesizeFlatTypeLabel(node, inlined);
  if (flatTypeLabel !== null) return flatTypeLabel;

  // Standalone PropertyAccess/ElementAccess (not the callee of a Call/New, or
  // a callee whose surrounding Call couldn't be collapsed). Render the dotted
  // path as a single rect label and inline its identifier descendants.
  if (
    kind === ts.SyntaxKind.PropertyAccessExpression ||
    kind === ts.SyntaxKind.ElementAccessExpression
  ) {
    const label = synthesizeAccessLabel(node, inlined);
    if (label !== null) return label;
    return null;
  }

  if (REFERENCE_KINDS_TO_SKIP.has(kind)) return null;

  // Prefix / postfix unary expressions — render `!id`, `-x`, `i++`
  // inline as a single rect when the operand is simple. Must run
  // before the generic getName() block (unary doesn't have getName(),
  // so it'd otherwise fall through to the static `unary` label from
  // SYNTAX_KIND_LABELS on the client, hiding which operator it is).
  const unaryLabel = synthesizeUnaryLabel(node, inlined);
  if (unaryLabel !== null) return unaryLabel;

  // JSX opening / closing / self-closing element labels — `<Foo>`,
  // `</Foo>`, `<Foo />`. Must run BEFORE the generic getName() block
  // below: ts-morph returns just `Foo` from getName() on all three,
  // which would render open and close as visually identical rects.
  const jsxLabel = synthesizeJsxLabel(node, inlined);
  if (jsxLabel !== null) return jsxLabel;

  // JSX attribute (`ref={…}`, `className="…"`, namespaced `a:b`).
  // ts-morph's JsxAttribute exposes getNameNode() but NOT getName()
  // — its base class is plain Node, not NamedNode — so the generic
  // getName() duck-type below misses it. Without this the attribute
  // ends up nameless, is treated as insignificant, and gets
  // collapsed away entirely, so `ref` / `fill` / `width` never
  // appear in the diagram. Pull the name node's text directly.
  //
  // Inline the name node so it doesn't emit as its own child rect
  // under the attribute. Otherwise `type="radio"` rendered as
  // `[type [type] ["radio"]]` — and because the inner Identifier
  // shared its parent's "type" label, the duplicate-label suppression
  // rule blanked it out, leaving an empty rect: `[type [] ["radio"]]`.
  // The attribute's label already carries the name; the Identifier
  // adds no information.
  if (Node.isJsxAttribute(node)) {
    const nameNode = node.getNameNode();
    inlined.add(nameNode);
    for (const d of nameNode.getDescendants()) inlined.add(d);
    return nameNode.getText();
  }

  // VariableStatement — `const/let/var x = ...`. The statement itself
  // has no `getName()` (it's not a NamedDeclaration), but the variable
  // it declares does. Use the first declaration's name (or join with
  // commas for multi-decl statements like `const x = 1, y = 2`) so
  // the statement renders with a meaningful label when collapsed
  // (EXPANDABLE_KINDS turns the whole statement into a single
  // labelled cell on the client). Without this the collapsed cell
  // would be unnamed and indistinguishable from any other.
  if (Node.isVariableStatement(node)) {
    const declList = node.getDeclarationList();
    const decls = declList.getDeclarations();
    if (decls.length > 0) {
      const names: string[] = [];
      for (const d of decls) {
        const nameNode = d.getNameNode();
        const nk = nameNode.getKind();
        // Destructuring decl (`const { a, b } = …`): summarise the pattern
        // compactly instead of inlining its full multi-line source text.
        if (
          nk === ts.SyntaxKind.ObjectBindingPattern ||
          nk === ts.SyntaxKind.ArrayBindingPattern
        ) {
          names.push(compactBindingPattern(nameNode));
        } else {
          const n = d.getName();
          if (n) names.push(n);
        }
      }
      if (names.length > 0) {
        // Bare names only — the declaration keyword travels as the
        // structured `decl` field (declOf) and the client's labelFor
        // re-attaches it in keyword colour, so it's no longer baked into
        // the name string (which forced regex-parsing client-side).
        return names.join(', ');
      }
    }
    return null;
  }

  // Function-likes (named functions/methods AND arrow functions): inline the
  // return-type node (it renders inline after the `:` from the `returnType`
  // field, not as its own child box). Named ones return their name for the
  // header band; an arrow is anonymous, so the client shows the `⇒` marker.
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node)
  ) {
    const rt = node.getReturnTypeNode();
    if (rt) {
      inlined.add(rt);
      for (const d of rt.getDescendants()) inlined.add(d);
    }
    if (Node.isArrowFunction(node)) return null;
    return node.getName() || null;
  }

  // Parameters render as compact `name: Type` chips: bake the type annotation
  // into the label and inline the type node so it doesn't also emit as a
  // nested box. Destructured params (binding-pattern name) fall through to the
  // pattern handling below, which renders the pattern as its own cell.
  if (Node.isParameterDeclaration(node)) {
    const nameNode = node.getNameNode();
    const nk = nameNode.getKind();
    if (
      nk !== ts.SyntaxKind.ObjectBindingPattern &&
      nk !== ts.SyntaxKind.ArrayBindingPattern
    ) {
      return bakeNamedType(nameNode.getText(), node.getTypeNode(), inlined);
    }
  }

  // Interface / type-literal members read as `name?: Type` chips, same as
  // parameters — so the type is visible AND two-tone-highlightable, and an
  // inline object member becomes a drillable `{}` instead of flat text.
  if (Node.isPropertySignature(node)) {
    const q = node.hasQuestionToken() ? '?' : '';
    return bakeNamedType(node.getNameNode().getText() + q, node.getTypeNode(), inlined);
  }

  // ts-morph uses structural typing for "named" nodes — many declarations
  // expose a getName() method but it's not part of the base Node API. We
  // duck-type and fall back gracefully.
  const candidate = node as unknown as {
    getName?: () => string | undefined;
    getNameNode?: () => Node | undefined;
  };
  // If the node's own name slot is a binding pattern (`{ a, b }` or `[a, b]`),
  // ts-morph's getName() returns the pattern's full source text — but we also
  // emit that pattern as a separate child rect (see isParentsNameSlot above),
  // so using the pattern as this node's label too would render every binding
  // twice: once flattened into a wide Parameter label, once inside the small
  // expandable `{}` cell. Suppress the label here; the child pattern carries
  // the visible representation.
  if (typeof candidate.getNameNode === 'function') {
    try {
      const nameNode = candidate.getNameNode();
      if (
        nameNode &&
        (nameNode.getKind() === ts.SyntaxKind.ObjectBindingPattern ||
          nameNode.getKind() === ts.SyntaxKind.ArrayBindingPattern)
      ) {
        return null;
      }
    } catch {
      // Some node types throw if no name node is present — fall through.
    }
  }
  if (typeof candidate.getName === 'function') {
    try {
      const n = candidate.getName();
      if (n) return n;
    } catch {
      // Some declaration kinds throw if no name is present (e.g. anon functions).
    }
  }

  // A bare Identifier reference (e.g. `x` in `if (x)` or `arr` in `for (… of arr)`).
  // ts-morph's Identifier doesn't expose getName(), but its source text *is*
  // the name — surface it so the rect shows "x" rather than the generic
  // "identifier" client fallback.
  if (kind === ts.SyntaxKind.Identifier) {
    return node.getText();
  }

  // Value keywords used as expressions / initializers / union members:
  // they aren't Identifiers but their source text is the label the user
  // expects. `null`, `true`, `false`.
  if (
    kind === ts.SyntaxKind.NullKeyword ||
    kind === ts.SyntaxKind.TrueKeyword ||
    kind === ts.SyntaxKind.FalseKeyword
  ) {
    return node.getText();
  }

  // JSX text content (`<title>A right pointing chevron</title>`). Without this
  // the text child gets no label and renders as an empty box inside the
  // element. Collapse internal whitespace/newlines so multi-line JSX text reads
  // as one line. (Whitespace-only JsxText is already filtered out in visit().)
  if (kind === ts.SyntaxKind.JsxText) {
    const text = node.getText().trim().replace(/\s+/g, ' ');
    if (!text) return null;
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
  }

  // Literals carry useful content not visible from edges, so we still label
  // them. Reference Identifiers used to be intentionally omitted here for the
  // same reason as the reference kinds above; that turned out to make the
  // rects undescriptive ("identifier"), so we now surface their text above.
  if (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.NumericLiteral
  ) {
    const text = node.getText();
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
  }

  // The static text chunks of a substitution template (`...${x}...`): show
  // their cooked content (the `${...}` expressions are separate child nodes).
  // Backtick-quoted so leading/trailing spaces are visible; empty chunks
  // (e.g. the head of `${x}...`) get no label.
  if (
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail
  ) {
    const text = (node.compilerNode as ts.LiteralLikeNode).text;
    if (!text) return null;
    const body = text.length > 58 ? text.slice(0, 55) + '…' : text;
    return '`' + body + '`';
  }
  return null;
}
