import {COLORS} from "./theme";

// Friendly short labels for non-named AST kinds. Keeps the on-screen label
// concise (e.g. `ReturnStatement` -> "return") so even narrow rects can host
// it without crowding the layout.
export const SYNTAX_KIND_LABELS: Record<string, string> = {
    // Statements. Most control-flow / jump statements now render via
    // SYNTAX_TEMPLATES below — their keyword is drawn as an inline glyph
    // INTERLEAVED with the operand boxes so the rect reads like the source
    // (`for [x] of [items]`, `if [cond] … else …`, `return [expr]`). Those
    // kinds intentionally have NO static prefix label here. Break / continue
    // carry no operands, so a plain keyword label is still the clearest
    // treatment.
    BreakStatement: "break",
    ContinueStatement: "continue",
    EmptyStatement: ";",
    // Expressions
    CallExpression: "call",
    NewExpression: "new",
    PropertyAccessExpression: "access",
    ElementAccessExpression: "index",
    PrefixUnaryExpression: "unary",
    PostfixUnaryExpression: "unary",
    // ConditionalExpression intentionally has NO static label: the
    // treemap lays it out as `[cond] ? [whenTrue] : [whenFalse]` with
    // the `?` and `:` drawn inline as operator glyphs between the
    // operand boxes (same render path as BinaryExpression's op).
    // Showing `?:` as a top-of-box label too would just duplicate
    // information that the glyphs already convey.
    // A single fat-arrow glyph (not the two-char `=>`), in keyword-blue (see
    // SYNTAX_CATEGORY) — matching the `ƒ` definition icon and the `▷` call
    // marker so all three function markers read as one family.
    ArrowFunction: "⇒",
    FunctionExpression: "fn",
    // AwaitExpression / YieldExpression / SpreadElement / AsExpression now
    // render via SYNTAX_TEMPLATES (`await [expr]`, `...[arr]`, `[x] as [T]`).
    TemplateExpression: "`...`",
    // The braces stand in for the object literal itself; non-empty
    // objects show their members as kids INSIDE the rect, reading as
    // `{ a: 1, b: 2 }` with the braces at top-left.
    ObjectLiteralExpression: "{}",
    // Code blocks read with the same `{}` braces as an object literal — a
    // collapsed Block now shows `{}` centered instead of a bare square, so it's
    // identifiable as a brace-delimited scope at a glance. The PINK kind
    // outline (KIND_OUTLINE.Block) is what still distinguishes a code block
    // from a yellow-outlined object/type literal.
    Block: "{}",
    // `[]` reads as the array literal itself in both empty and
    // non-empty cases: an empty rect shows '[]', a non-empty rect
    // shows '[]' at top-left with the elements as kids inside it,
    // visually reading as `[a, b, c]`.
    ArrayLiteralExpression: "[]",
    NonNullExpression: "non-null",
    // Other
    HeritageClause: "extends",
    TypeReference: "type",
    // Type literal — the inline `{ a: string; b: number }` that
    // appears as a property's type. Rendered as `{}` and treated as
    // expandable, mirroring ObjectLiteralExpression so the user can
    // drill into its member signatures.
    TypeLiteral: "{}",
    // Array type — only labelled when synthesizeFlatTypeLabel bailed
    // out (because it contains an inline TypeLiteral). Plain
    // `Pulse[]` keeps its flattened text label.
    ArrayType: "[]",
    // Destructured object pattern — `({ a, b }: T)`, the typical React props
    // shape. Renders as a brace cell that drills into its bindings the same
    // way ObjectLiteralExpression / TypeLiteral do (expandable).
    ObjectBindingPattern: "{}",
    // ArrayBindingPattern (`const [x, y] = …`) intentionally has NO text label
    // — it renders as a literal square-bracket OUTLINE around its bindings (see
    // BRACKET_KINDS / KIND_OUTLINE), so the box itself reads as `[ x  y ]`
    // instead of a "[]"-labelled container with an empty band on top.
    // ImportDeclaration intentionally has NO label here — the imported
    // names already convey "this is an import" visually, and the
    // background tint (see KIND_FILL_TINT below) signals the kind.
    // Adding "import" as a header just duplicates information.
    ExportDeclaration: "export",
    ImportClause: "imports",
    NamedImports: "named",
    Parameter: "param",
};

// Names ALWAYS take precedence. Unnamed nodes get a label only if their kind
// is in the curated meaningful set above — pure syntactic scaffolding
// (Block, ExpressionStatement, BinaryExpression, parens, var statements, and
// anything not curated) returns null, so it neither competes with a real
// name nor reserves a label band. Such single-child wrappers are then
// flattened away entirely by the layout (see layoutAst).
export function labelFor(node: {name: string | null; syntaxKind: string; extendsName?: string; static?: boolean; readonly?: boolean; accessibility?: "private" | "protected"}): string | null {
    if (node.name) {
        // Compose the full header text: "[private] [static] [readonly] name [extends Base]".
        // labelScreenBox measures THIS composite (single source of truth);
        // drawHeaderSegments below colours each part. Modifiers are tokens
        // separated by single spaces, source order matching how you'd write
        // them in TypeScript.
        const modifiers = composeModifierPrefix(node);
        const head = modifiers ? `${modifiers} ${node.name}` : node.name;
        if (node.extendsName) return `${head} extends ${node.extendsName}`;
        // An object-literal property key carries its `:` so it reads like the
        // source (`velocity:` not `velocity`). The colon is part of the label
        // text, so it inherits the key's operator/default colour (see
        // SYNTAX_CATEGORY.PropertyAssignment) — exactly the colon's own colour.
        if (node.syntaxKind === "PropertyAssignment") return `${head}:`;
        return head;
    }
    return SYNTAX_KIND_LABELS[node.syntaxKind] ?? null;
}

// Split a leading declaration keyword (`const` / `let` / `var`) off a label so
// the renderer can colour it like an editor — the keyword in keyword-blue, the
// declared name(s) in the variable colour — instead of one flat colour. The
// server prepends the keyword in rawFriendlyName's VariableStatement branch
// (so it survives the simplified tier in the collapsed cell); this splits it
// back out for two-tone rendering. Returns null when there's no such prefix.
const DECLARATION_KEYWORD = /^(const|let|var) (.+)$/;
export function splitDeclarationKeyword(label: string): {keyword: string; rest: string} | null {
    const m = DECLARATION_KEYWORD.exec(label);
    return m ? {keyword: m[1], rest: m[2]} : null;
}

// Join the modifier keywords in TypeScript source order. Returns an
// empty string when none apply so labelFor / drawHeaderSegments can
// detect "no modifiers" cheaply (string.length === 0 vs null).
export function composeModifierPrefix(node: {static?: boolean; readonly?: boolean; accessibility?: "private" | "protected"}): string {
    const parts: string[] = [];
    if (node.accessibility) parts.push(node.accessibility);
    if (node.static) parts.push("static");
    if (node.readonly) parts.push("readonly");
    return parts.join(" ");
}

// Kinds whose label is treated like a real name for LOD: it survives the
// simplified tier and only drops when it no longer fits on screen (rather
// than disappearing early with the other generic kind labels).
// Control-flow keywords (if/for/while/…) are name-like because they're
// what tells the user "this is a branch / loop / catch" — without them
// the kind-outline alone identifies the rect's COLOUR but not its WORD,
// and an `if` reads completely differently from a `while` even though
// both wear the same pink. ThrowStatement / BreakStatement / etc.
// belong here for the same reason: a `throw` rect with no `throw` label
// is just an unlabelled box around an Error constructor.
export const NAME_LIKE_KINDS = new Set([
    "ImportDeclaration",
    "ReturnStatement",
    "IfStatement",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "WhileStatement",
    "DoStatement",
    "SwitchStatement",
    "CaseClause",
    "DefaultClause",
    "TryStatement",
    "CatchClause",
    "ThrowStatement",
    "BreakStatement",
    "ContinueStatement",
    // `=>` (ArrowFunction) is the only signal that a rect IS a
    // function when the arrow is anonymous — there's no name to
    // hold the simplified-tier survivability the way a named
    // FunctionDeclaration / MethodDeclaration does. Keep it
    // name-like so it shows up alongside its parameters even at
    // lower zooms.
    "ArrowFunction",
]);

// Kinds shown as a colored outline instead of a text label. They carry no
// label (decluttered) but stay visually identifiable by border color.
export const KIND_OUTLINE: Record<string, number> = {
    Block: COLORS.astOutlineBlock,
    ObjectLiteralExpression: COLORS.astOutlineObject,
    // Same outline as ObjectLiteralExpression — TypeLiteral reads as
    // an "object shape" too, just in type position.
    TypeLiteral: COLORS.astOutlineObject,
    // Destructured parameter pattern (`({ id, size }: Props)`) — the
    // React component prop-definition shape. Same yellow as
    // ObjectLiteralExpression / TypeLiteral so the brace cells across
    // value, type, and binding positions all read as one visual idiom.
    ObjectBindingPattern: COLORS.astOutlineObject,
    // Destructured ARRAY pattern (`const [x, y] = …`). Same yellow as the
    // object-pattern braces — both are destructuring containers — but drawn
    // as square-bracket strokes rather than a full rect (see BRACKET_KINDS and
    // the bracket branch in PixiCanvas.drawAstNode). Listed here so the node
    // stays significant (never collapses as a pass-through) and the bracket
    // strokes inherit this colour.
    ArrayBindingPattern: COLORS.astOutlineObject,
    Parameter: COLORS.astOutlineParam,
    // Type definitions (interfaces, type aliases). They used to render
    // as a dashed green circle with every member visible; now they're
    // collapsed cells (see EXPANDABLE_KINDS) with this same green for
    // continuity. Click to drill into members.
    InterfaceDeclaration: COLORS.astOutlineAbstract,
    TypeAliasDeclaration: COLORS.astOutlineAbstract,
    // Classes share the green with interfaces / type aliases — same
    // colour the EXPANDED class circle uses (see `classOutline` below
    // in drawAstNode). Visual continuity across the collapsed-cell ↔
    // expanded-circle toggle.
    ClassDeclaration: COLORS.astOutlineAbstract,
    // Top-level `const/let/var x = ...` statements collapse to a
    // single labelled cell. Yellow matches the object/array brace
    // colour since most non-trivial top-level vars are object or
    // array initializers — the colour signals "value-bearing
    // container, click to drill in" the same way the brace cells do.
    VariableStatement: COLORS.astOutlineObject,
    // JSX wrappers — `<Foo>…</Foo>` and `<>…</>`. The expandable cell
    // shows the tag in its collapsed leaf; clicking spawns an overlay
    // with the opening tag (and its attributes), children, and closing
    // tag as separate rects.
    JsxElement: COLORS.astOutlineJsx,
    JsxFragment: COLORS.astOutlineJsx,
    // Control-flow statements — pink border matches the `control`
    // syntax category used for their labels (if/for/while/etc.). The
    // border makes the statement's rect boundary unambiguous even at
    // zooms where the small `if` / `for` text label would be easy to
    // miss inside a larger surrounding Block.
    IfStatement: COLORS.astOutlineControl,
    ForStatement: COLORS.astOutlineControl,
    ForInStatement: COLORS.astOutlineControl,
    ForOfStatement: COLORS.astOutlineControl,
    WhileStatement: COLORS.astOutlineControl,
    DoStatement: COLORS.astOutlineControl,
    SwitchStatement: COLORS.astOutlineControl,
    TryStatement: COLORS.astOutlineControl,
};

// Kinds whose box is stroked as a literal pair of square brackets — solid
// left/right verticals with short serifs at each corner — instead of a full
// rectangle, so the container itself reads as `[ … ]`. Used for array
// destructuring (`const [a, b] = …`), where the brackets ARE the syntax and a
// "[]" text label over an empty band just duplicated them. The stroke colour
// comes from KIND_OUTLINE above.
export const BRACKET_KINDS = new Set(["ArrayBindingPattern"]);
export function isBracketKind(kind: string): boolean {
    return BRACKET_KINDS.has(kind);
}

// Container literals whose `{}` / `[]` label is the syntax itself. When the
// node is COLLAPSED (or empty) the braces show as its centered cell label;
// when it's EXPANDED inline (e.g. an object literal sitting in a ternary
// branch), the braces are redundant with the kind-coloured outline, so the
// label is dropped and no header band is reserved — otherwise the spread /
// members sit under an empty band (a wasted gap). The expanded overlay ROOT is
// exempt (it keeps the band for its top-left collapse handle); see the
// `node.id !== ast.rootId` guard in treemap and that drawOverlay never draws
// the root's own header.
export const BRACE_LABEL_KINDS = new Set([
    "ObjectLiteralExpression",
    "ObjectBindingPattern",
    "TypeLiteral",
    "ArrayLiteralExpression",
    "Block",
]);
export function isBraceLabelKind(kind: string): boolean {
    return BRACE_LABEL_KINDS.has(kind);
}

// Per-kind background tint applied to the AST cell's fill. Each entry
// gets BLENDED with the normal depth-derived fill so the kind reads at
// a glance from the background hue alone — no extra label needed. The
// number is a target colour; `blend` is the proportion (0–1) mixed
// with the base fill.
export const KIND_FILL_TINT: Record<string, {color: number; blend: number}> = {
    // Imports get a slight blue wash — same hue family as the
    // edgeImported blue used for incoming-import lines, so a block
    // labelled with imported names + a blue background reads as
    // "this brings stuff in" at a glance, replacing the previous
    // explicit "import" header label.
    ImportDeclaration: {color: 0x4a6ac5, blend: 0.35},
};

// A node is "significant" — worth its own box, never collapsed as a
// pass-through — if it shows a label OR carries a kind outline. (A magenta
// `block` or yellow `object` must survive even as a single-child wrapper,
// otherwise its outline would never be drawn.)
export function isSignificant(node: {name: string | null; syntaxKind: string}): boolean {
    return (
        labelFor(node) !== null ||
        // Templated constructs (control flow, return/throw, await, `as`, …) no
        // longer carry a static label — their keyword is an inline glyph — so
        // labelFor() returns null for them. They must still survive as their
        // own box (never collapse as a single-child pass-through) or the
        // template would have nothing to render against.
        hasSyntaxTemplate(node.syntaxKind) ||
        KIND_OUTLINE[node.syntaxKind] !== undefined ||
        // Constructor has no label but its own box (white outline + wrench
        // badge), so it must never collapse as a single-child pass-through.
        node.syntaxKind === "Constructor" ||
        // Nodes carrying a kind-specific fill tint (e.g. the blue
        // background for ImportDeclaration) are significant for the
        // SAME reason kind-outlined nodes are — the visual treatment
        // IS the kind signal, so the rect must survive even as a
        // single-child wrapper.
        KIND_FILL_TINT[node.syntaxKind] !== undefined
    );
}

// The collapse predicate now lives at the call site
// (`buildPerFileLayout` in the useEffect closure) because it needs to
// close over the per-file slice of the store's `expandedAstNodes`.

// Nodes that participate in the click-to-expand-as-overlay model.
// Each defaults to a small kind-outlined collapsed cell in the
// main layout; clicking spawns an overlay with the node's full
// content. Today: code blocks (`Block`) and object literals
// (`ObjectLiteralExpression`). Sharing the predicate keeps the
// main layout, overlay layout, click handler and hover affordances
// in sync.
export const EXPANDABLE_KINDS = new Set([
    "Block",
    "ObjectLiteralExpression",
    "TypeLiteral",
    // React component prop definitions: a destructured object
    // parameter pattern. Drills the same way Block / Object literal
    // do — collapsed brace cell, click to spawn an overlay of the
    // bindings inside. (Array binding patterns are labelled but
    // not expandable — they're rare and the bracket cell is small
    // enough to read inline.)
    "ObjectBindingPattern",
    // Type definitions — `interface Props { ... }`, `type Props = { ... }`.
    // Previously interfaces rendered as a prominent dashed circle
    // with every member visible, which doubled up against the
    // destructured-prop cell next to them. Now they're a labelled
    // green cell (the interface / alias name) you drill into to
    // see members — same affordance as the {} cells, applied to
    // the things that DEFINE the props rather than just consume
    // them.
    "InterfaceDeclaration",
    "TypeAliasDeclaration",
    // Classes — same expand-circle treatment as interfaces. When
    // collapsed the class is a labelled green cell (the class name);
    // clicking spawns the overlay with the class's solid green
    // circle around its members. Especially useful for big classes
    // like Angular pages / services where the member list dominates
    // an expanded file even though the user often just wants to see
    // "yes this file defines class Foo" without drilling into Foo's
    // members.
    "ClassDeclaration",
    // Top-level `const/let/var x = ...` statements. Collapsing the
    // whole statement to a single labelled cell (the variable name,
    // provided by the server's rawFriendlyName for VariableStatement)
    // gives a compact summary for files that define large object
    // literals or arrays as module-level constants — without this
    // the const's initializer renders inline as a big content block
    // that dominates the file's interior. Click drills into the
    // statement to see the value.
    "VariableStatement",
    // JSX wrapper — `<Foo>…</Foo>` and `<>…</>`. Collapses by default
    // so a render method full of nested JSX doesn't dominate the
    // expanded function body; clicking drills into the element and
    // shows the opening tag (with its attributes inside it),
    // children, and closing tag as their own rects.
    "JsxElement",
    "JsxFragment",
]);
export function isExpandableKind(kind: string): boolean {
    return EXPANDABLE_KINDS.has(kind);
}

// Label text colored like the code editor (Monaco `vs-dark` / Dark+ family,
// matching EditorPane's theme): types teal, functions yellow, control-flow
// pink, other keywords blue, strings salmon, numbers green, everything
// identifier-ish light blue, fallback default foreground.
export const SYNTAX = {
    type: 0x4ec9b0,
    func: 0xdcdcaa,
    variable: 0x9cdcfe,
    control: 0xc586c0,
    keyword: 0x569cd6,
    string: 0xce9178,
    number: 0xb5cea8,
    default: 0xd4d4d4,
} as const;

// --- Construct templates: make a node read like its source ----------------
// Each entry maps a syntaxKind to a function that, given the node's
// (collapsed, pruned) children in source order, returns an ordered flow of
// inline keyword glyphs and child references. The treemap interprets it (see
// AstLayoutOpts.syntaxTokens → constructLayout): a `{ child: i }` token
// consumes the i-th child inline at that position so the keywords draw
// BETWEEN the operand boxes; any child NOT referenced is appended after the
// template (a loop / catch body), wrapping below the keyword header. This is
// what turns the old `[for…of [x][arr][{}]]` (a prefix label over anonymous
// boxes) into `for [x] of [arr] { … }`. Colours come from SYNTAX above.
export type SyntaxToken = { kw: string; color: number; size?: number } | { child: number };
export type SyntaxTemplate = (
    kids: { syntaxKind: string; role?: string }[],
    node: { syntaxKind: string; name: string | null; returnType?: string },
) => SyntaxToken[];

const C = SYNTAX.control; // control-flow keywords — pink
const K = SYNTAX.keyword; // other keywords (typeof / as / void / delete) — blue
const P = SYNTAX.default; // punctuation (`; : ...`) — default foreground

export const SYNTAX_TEMPLATES: Record<string, SyntaxTemplate> = {
    // --- Loops ---
    // `for [item] of [iterable]` — item and iterable are always children 0 and
    // 1; the body (child 2) isn't referenced, so it auto-appends below.
    ForOfStatement: () => [{kw: "for", color: C}, {child: 0}, {kw: "of", color: C}, {child: 1}],
    ForInStatement: () => [{kw: "for", color: C}, {child: 0}, {kw: "in", color: C}, {child: 1}],
    WhileStatement: () => [{kw: "while", color: C}, {child: 0}],
    // `do { body } while [cond]` — body is child 0, condition child 1.
    DoStatement: (kids) =>
        kids.length >= 2
            ? [{kw: "do", color: C}, {child: 0}, {kw: "while", color: C}, {child: 1}]
            : [{kw: "do", color: C}],
    // `for [init] ; [cond] ; [update]` — clauses are role-tagged by the server
    // because any can be omitted (`for (;;)`). Reference every role-bearing
    // child (there can be several `init`s, as in `for (let i=0, j=1; …)`); the
    // single roleless child (the body) auto-appends below.
    ForStatement: (kids) => {
        const t: SyntaxToken[] = [{kw: "for", color: C}];
        const pushRole = (r: string) =>
            kids.forEach((k, i) => { if (k.role === r) t.push({child: i}); });
        pushRole("init");
        t.push({kw: ";", color: P});
        pushRole("cond");
        t.push({kw: ";", color: P});
        pushRole("update");
        return t;
    },
    // --- Conditionals & switch ---
    // `if [cond] { then } else { else }` — the `else` glyph sits before the
    // else branch (child 2), which may itself be another `if` (else-if chain).
    IfStatement: (kids) =>
        kids.length >= 3
            ? [{kw: "if", color: C}, {child: 0}, {child: 1}, {kw: "else", color: C}, {child: 2}]
            : [{kw: "if", color: C}, {child: 0}],
    SwitchStatement: () => [{kw: "switch", color: C}, {child: 0}],
    CaseClause: () => [{kw: "case", color: C}, {child: 0}, {kw: ":", color: P}],
    DefaultClause: () => [{kw: "default", color: C}, {kw: ":", color: P}],
    // --- Jumps & error handling ---
    // `return` shows as a prominent pink return glyph (↩) rather than the word,
    // then the returned expression: `↩ [expr]`. Drawn at 2× the normal 11px
    // label size (it still scales with zoom like all labels, via labelScale).
    ReturnStatement: () => [{kw: "↩", color: C, size: 22}],
    ThrowStatement: () => [{kw: "throw", color: C}],
    // `try { } catch (e) { } finally { }`. Children: try-block (0), an optional
    // CatchClause, an optional finally Block. Reference them in order so the
    // `finally` keyword lands before its block; the CatchClause draws its own
    // `catch [param]` via its own template.
    TryStatement: (kids) => {
        const t: SyntaxToken[] = [{kw: "try", color: C}, {child: 0}];
        let i = 1;
        if (kids[i]?.syntaxKind === "CatchClause") { t.push({child: i}); i++; }
        if (kids[i]?.syntaxKind === "Block") { t.push({kw: "finally", color: C}, {child: i}); }
        return t;
    },
    // `catch [param] { body }` — a param is present unless it's a bare `catch {}`.
    CatchClause: (kids) =>
        kids.length >= 2 ? [{kw: "catch", color: C}, {child: 0}] : [{kw: "catch", color: C}],
    // --- Inline keyword-expressions ---
    AwaitExpression: () => [{kw: "await", color: C}],
    YieldExpression: () => [{kw: "yield", color: C}],
    TypeOfExpression: () => [{kw: "typeof", color: K}],
    VoidExpression: () => [{kw: "void", color: K}],
    DeleteExpression: () => [{kw: "delete", color: K}],
    // Spread `...expr` in every position: arrays / calls (SpreadElement),
    // object literals (SpreadAssignment), and JSX (`<C {...props} />`). All
    // render the `...` as an inline prefix glyph in front of the spread
    // expression instead of a `...`-labelled box, so `{ ...entity.velocity }`
    // reads as `... entity.velocity` rather than dropping the `...` entirely
    // (these collapse to a bare pass-through without a template).
    SpreadElement: () => [{kw: "...", color: P}],
    SpreadAssignment: () => [{kw: "...", color: P}],
    JsxSpreadAttribute: () => [{kw: "...", color: P}],
    // `[expr] as [Type]` — both operands present (expression 0, type 1).
    AsExpression: () => [{child: 0}, {kw: "as", color: K}, {child: 1}],
    // NOTE: function definitions are NOT templated here — they use the
    // two-column functionLayout in treemap.ts (params bracketed on the left,
    // return type + body on the right). See isFunctionSignatureKind below,
    // wired in as AstLayoutOpts.groupedSignature.
};

export function hasSyntaxTemplate(kind: string): boolean {
    return SYNTAX_TEMPLATES[kind] !== undefined;
}

// Named function-likes rendered with the signature template + a name band. The
// renderer prepends a keyword-blue `ƒ` marker to the band for these so a
// function definition is unmistakable. Widen alongside the templates above.
export const FUNCTION_SIGNATURE_KINDS = new Set(["FunctionDeclaration", "MethodDeclaration", "ArrowFunction"]);
export function isFunctionSignatureKind(kind: string): boolean {
    return FUNCTION_SIGNATURE_KINDS.has(kind);
}

// Adapter passed to layoutAst (AstLayoutOpts.syntaxTokens): resolve a kind's
// template and run it against the node's children, or null for untemplated
// kinds so the layout falls back to the label + wrapped-packing path.
export function syntaxTokens(
    kind: string,
    kids: {syntaxKind: string; role?: string}[],
    node: {syntaxKind: string; name: string | null; returnType?: string},
): SyntaxToken[] | null {
    const t = SYNTAX_TEMPLATES[kind];
    return t ? t(kids, node) : null;
}

// Split a `name: Type` chip (a parameter's baked label) into its name and type
// so the renderer can two-tone it — name in the variable colour, type in teal,
// matching an editor. Returns null when there's no `: ` annotation (so a plain
// param name renders single-colour). Gate callers on the Parameter kind, since
// other labels can contain `: ` incidentally.
const TYPE_ANNOTATION = /^(.+?): (.+)$/;
export function splitTypeAnnotation(label: string): {name: string; type: string} | null {
    const m = TYPE_ANNOTATION.exec(label);
    return m ? {name: m[1], type: m[2]} : null;
}

// The marker the server prepends to a CallExpression label (`▷ foo`). Split it
// out so the renderer can paint the triangle keyword-blue — matching the `ƒ`
// definition icon — while the callee keeps its own (function-yellow) colour.
export const CALL_MARKER = "▷ ";
export function splitCallMarker(label: string): {marker: string; rest: string} | null {
    return label.startsWith(CALL_MARKER)
        ? {marker: CALL_MARKER, rest: label.slice(CALL_MARKER.length)}
        : null;
}

// AST kind → syntax category. Anything unmapped falls back to `default`,
// which also covers operator glyphs (operators are default fg in vs-dark).
export const SYNTAX_CATEGORY: Record<string, keyof typeof SYNTAX> = {
    ClassDeclaration: "type",
    ClassExpression: "type",
    InterfaceDeclaration: "type",
    EnumDeclaration: "type",
    EnumMember: "type",
    TypeAliasDeclaration: "type",
    TypeReference: "type",
    ArrayType: "type",
    ExpressionWithTypeArguments: "type",
    FunctionDeclaration: "func",
    FunctionExpression: "func",
    // The arrow glyph `⇒` is a function MARKER, not a name — colour it keyword-
    // blue like the `ƒ` icon and `▷` call triangle, not function-yellow.
    ArrowFunction: "keyword",
    MethodDeclaration: "func",
    MethodSignature: "func",
    Constructor: "func",
    GetAccessor: "func",
    SetAccessor: "func",
    CallExpression: "func",
    NewExpression: "func",
    VariableDeclaration: "variable",
    Parameter: "variable",
    PropertyDeclaration: "variable",
    PropertySignature: "variable",
    // Object-literal property KEYS are definitions, not references — the name
    // is being introduced (`velocity:`, `x:`, `y:`), not read. Colour them with
    // the neutral operator/default foreground (the same colour the `:` / `=`
    // glyphs use) so a defined key reads distinctly from a light-blue variable
    // reference like `entity.velocity` sitting next to it.
    PropertyAssignment: "default",
    ShorthandPropertyAssignment: "default",
    BindingElement: "variable",
    PropertyAccessExpression: "variable",
    ElementAccessExpression: "variable",
    Identifier: "variable",
    ReturnStatement: "control",
    IfStatement: "control",
    ForStatement: "control",
    ForInStatement: "control",
    ForOfStatement: "control",
    WhileStatement: "control",
    DoStatement: "control",
    SwitchStatement: "control",
    CaseClause: "control",
    DefaultClause: "control",
    BreakStatement: "control",
    ContinueStatement: "control",
    ThrowStatement: "control",
    TryStatement: "control",
    CatchClause: "control",
    AwaitExpression: "control",
    YieldExpression: "control",
    ImportDeclaration: "keyword",
    ExportDeclaration: "keyword",
    ExportAssignment: "keyword",
    ImportClause: "keyword",
    NamedImports: "keyword",
    NamedExports: "keyword",
    // The `import` / `export` *statements* read as keywords (above), but the
    // bound names INSIDE them read as identifier references: an import is
    // bringing a value into scope, and the local binding sits in code the
    // same way a variable identifier does. Match how the editor colours an
    // identifier reference (light blue) rather than how it colours the
    // `import` keyword (medium blue). Type / class imports override this
    // via `isType` in syntaxColor() and land on green instead.
    ImportSpecifier: "variable",
    ExportSpecifier: "variable",
    HeritageClause: "keyword",
    AsExpression: "keyword",
    NonNullExpression: "keyword",
    SpreadElement: "keyword",
    StringLiteral: "string",
    NoSubstitutionTemplateLiteral: "string",
    TemplateExpression: "string",
    TemplateHead: "string",
    TemplateMiddle: "string",
    TemplateTail: "string",
    NumericLiteral: "number",
    BigIntLiteral: "number",
};

export function syntaxColor(node: {syntaxKind: string; isType?: boolean}): number {
    // `isType` is set by the server for nodes that ARE types in the user's
    // source even though their syntaxKind isn't a type-category kind —
    // currently the bindings inside an `import type { ... }` (kind
    // ImportSpecifier or Identifier, default-category 'keyword'). Map them
    // to the same green the editor uses for type names regardless of kind.
    if (node.isType) return SYNTAX.type;
    return SYNTAX[SYNTAX_CATEGORY[node.syntaxKind] ?? "default"];
}

// "Higher-level construct": a type-level declaration or anything exported.
// When zoomed out far enough that labels no longer fit their boxes, only
// these keep their text (everything else — calls, ifs, property keys,
// operands — drops out). Classes/interfaces/enums/type-aliases by kind,
// plus exported declarations regardless of kind.
export const HIGH_LEVEL_KINDS = new Set(["ClassDeclaration", "ClassExpression", "InterfaceDeclaration", "EnumDeclaration", "TypeAliasDeclaration"]);
export function isHighLevel(node: {syntaxKind: string; exported?: boolean}): boolean {
    return node.exported === true || HIGH_LEVEL_KINDS.has(node.syntaxKind);
}
