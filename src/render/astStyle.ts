import {liveTheme} from "./theme";
import type {SyntaxColors, ThemeColors} from "../graph/config/types";

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
    // ElementAccessExpression renders via SYNTAX_TEMPLATES as `base[index]`
    // (inline brackets), so it carries no static label — see the template.
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
    TemplateExpression: "`${}`",
    // The braces stand in for the object literal itself. These container kinds
    // are EXPANDABLE (drill into an overlay), and they only ever draw this label
    // when COLLAPSED — so the `…` reads as "there's content inside, click to
    // expand" (the familiar collapsed-object affordance) rather than an empty
    // `{}`. Expanded inline, the band is dropped (the outline conveys the braces).
    ObjectLiteralExpression: "{…}",
    // Code blocks read with the same braces as an object literal — a collapsed
    // Block shows `{…}` so it's identifiable as an expandable brace-delimited
    // scope. The PINK kind outline (KIND_OUTLINE.Block) is what still
    // distinguishes a code block from a yellow-outlined object/type literal.
    Block: "{…}",
    // `[]` reads as the array literal itself in both empty and
    // non-empty cases: an empty rect shows '[]', a non-empty rect
    // shows '[]' at top-left with the elements as kids inside it,
    // visually reading as `[a, b, c]`.
    ArrayLiteralExpression: "[]",
    NonNullExpression: "non-null",
    // Other
    HeritageClause: "extends",
    TypeReference: "type",
    // Type literal — the inline `{ a: string; b: number }` that appears as a
    // property's / parameter's type. Expandable; collapsed it shows `{…}` (drill
    // to see its member signatures), mirroring ObjectLiteralExpression.
    TypeLiteral: "{…}",
    // Array type — only labelled when synthesizeFlatTypeLabel bailed
    // out (because it contains an inline TypeLiteral). Plain
    // `Pulse[]` keeps its flattened text label.
    ArrayType: "[]",
    // Destructured object pattern — `({ a, b }: T)`, the typical React props
    // shape. Expandable; collapsed it shows `{…}` and drills into its bindings
    // the same way ObjectLiteralExpression / TypeLiteral do.
    ObjectBindingPattern: "{…}",
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
    // No generic "param" label: a named parameter bakes its `name: Type` into
    // the label (see bakeNamedType), and a destructured one renders as
    // `{…} : Type` via syntaxTokens — so a label-less Parameter needs no
    // stand-in text (it would just read as a noisy "param" wrapper).

    // --- Python (stdlib `ast` node names) ---
    // Jumps / simple statements with no operands → a plain keyword label.
    Pass: "pass",
    Break: "break",
    Continue: "continue",
    Global: "global",
    Nonlocal: "nonlocal",
    Delete: "del",
    Lambda: "λ",
    // Expressions (mirror the TS Call/access/index labels; usually the
    // synthesized name wins, these are fallbacks).
    Call: "call",
    Attribute: "access",
    // Subscript renders via SYNTAX_TEMPLATES as `base[index]` (inline brackets),
    // so it carries no static label — see the template.
    // Container literals — `{…}` collapsed object/dict, `[]`/`()` for
    // list/tuple. Like their TS counterparts the label drops when expanded
    // inline (see BRACE_LABEL_KINDS / BRACKET_KINDS).
    Dict: "{…}",
    Set: "{…}",
    List: "[]",
    Tuple: "()",
};

// Names ALWAYS take precedence. Unnamed nodes get a label only if their kind
// is in the curated meaningful set above — pure syntactic scaffolding
// (Block, ExpressionStatement, BinaryExpression, parens, var statements, and
// anything not curated) returns null, so it neither competes with a real
// name nor reserves a label band. Such single-child wrappers are then
// flattened away entirely by the layout (see layoutAst).
export function labelFor(node: {name: string | null; syntaxKind: string; extendsName?: string; static?: boolean; readonly?: boolean; accessibility?: "private" | "protected"; defaultExport?: boolean; decl?: "const" | "let" | "var" | "field" | "mutation"}): string | null {
    if (node.name) {
        // Compose the full header text: "[◇ ][export default] [const] [private]
        // [static] [readonly] name [extends Base]".
        // labelScreenBox measures THIS composite (single source of truth);
        // drawHeaderSegments below colours each part. Modifiers are tokens
        // separated by single spaces, source order matching how you'd write
        // them in TypeScript. The `export default` prefix marks a default export
        // that was merged onto its local implementation (see AstNode.defaultExport).
        // The decl prefix (declPrefixOf) is baked in HERE so measurement and
        // drawing agree: the const/let/var keyword sits inside any `export
        // default` wrap (source order), while the ◇ field marker leads
        // everything — mirroring how the ƒ function marker precedes modifiers.
        const modifiers = composeModifierPrefix(node);
        const withMods = modifiers ? `${modifiers} ${node.name}` : node.name;
        const pfx = declPrefixOf(node);
        const isField = node.decl === "field";
        const withKeyword = pfx && !isField ? `${pfx}${withMods}` : withMods;
        const wrapped = node.defaultExport ? `export default ${withKeyword}` : withKeyword;
        const head = pfx && isField ? `${pfx}${wrapped}` : wrapped;
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

// The keyword-coloured prefix a decl-carrying node's label starts with —
// "◇ " for a class field, "const " / "let " / "var " for a declaration
// (statement AND each declaration under it). labelFor bakes it into the
// measured label; the renderer splits it back off for two-tone colouring
// (keyword-blue prefix, variable-blue name). Null for mutation/none —
// mutations colour their operator GLYPH instead (see SYNTAX.mutation),
// since a `x = y` cell has no label band to prefix.
export function declPrefixOf(node: {decl?: "const" | "let" | "var" | "field" | "mutation"}): string | null {
    if (!node.decl || node.decl === "mutation") return null;
    return node.decl === "field" ? "◇ " : `${node.decl} `;
}

// Split the leading `export default ` off a label (see labelFor / AstNode.
// defaultExport) so the renderer can colour it keyword-blue, then two-tone the
// remainder (e.g. the `const X` keyword split) independently. Returns null when
// there's no such prefix.
const DEFAULT_EXPORT_PREFIX = /^(export default) (.+)$/;
export function splitDefaultExportPrefix(label: string): {prefix: string; rest: string} | null {
    const m = DEFAULT_EXPORT_PREFIX.exec(label);
    return m ? {prefix: m[1], rest: m[2]} : null;
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
    // `${}` is the title for the spans laid out inside a template
    // literal; like the arrow, it has no name, so keep it name-like so
    // the header survives the simplified tier alongside its contents.
    "TemplateExpression",
    // --- Python control flow / keyword statements (their inline keyword
    // glyph is the only signal of what the rect IS, so keep it at low zoom). ---
    "If",
    "For",
    "AsyncFor",
    "While",
    "With",
    "AsyncWith",
    "Try",
    "ExceptHandler",
    "Return",
    "Raise",
    "Assert",
    "Pass",
    "Break",
    "Continue",
    "Lambda",
    "Import",
    "ImportFrom",
    "Global",
    "Nonlocal",
    "Delete",
    // A tuple's `()` label (e.g. a `known, path = …` unpacking target) has no
    // name, like the arrow glyph — keep it name-like so it survives the
    // simplified tier instead of vanishing early when zoomed out.
    "Tuple",
]);

// Kinds shown as a colored outline instead of a text label. They carry no
// label (decluttered) but stay visually identifiable by border color.
//
// Maps to a ThemeColors KEY, not a colour. It used to hold values read from the
// static COLORS palette at module load, so the seven astOutline* entries were
// themeable on paper and inert in practice — editing them changed the config
// and nothing on screen. Resolve through outlineColorFor() to read live.
export const KIND_OUTLINE: Record<string, keyof ThemeColors> = {
    Block: "astOutlineBlock",
    ObjectLiteralExpression: "astOutlineObject",
    // Same outline as ObjectLiteralExpression — TypeLiteral reads as
    // an "object shape" too, just in type position.
    TypeLiteral: "astOutlineObject",
    // Destructured parameter pattern (`({ id, size }: Props)`) — the
    // React component prop-definition shape. Same yellow as
    // ObjectLiteralExpression / TypeLiteral so the brace cells across
    // value, type, and binding positions all read as one visual idiom.
    ObjectBindingPattern: "astOutlineObject",
    // Destructured ARRAY pattern (`const [x, y] = …`). Same yellow as the
    // object-pattern braces — both are destructuring containers — but drawn
    // as square-bracket strokes rather than a full rect (see BRACKET_KINDS and
    // the bracket branch in PixiCanvas.drawAstNode). Listed here so the node
    // stays significant (never collapses as a pass-through) and the bracket
    // strokes inherit this colour.
    ArrayBindingPattern: "astOutlineObject",
    // Array literals (`[x, y]`) read as `[ … ]` square brackets too — same
    // yellow as the destructuring pattern and object braces, so every bracket/
    // brace container shares one visual idiom. See BRACKET_KINDS.
    ArrayLiteralExpression: "astOutlineObject",
    Parameter: "astOutlineParam",
    // Type definitions (interfaces, type aliases). They used to render
    // as a dashed green circle with every member visible; now they're
    // collapsed cells (see EXPANDABLE_KINDS) with this same green for
    // continuity. Click to drill into members.
    InterfaceDeclaration: "astOutlineAbstract",
    TypeAliasDeclaration: "astOutlineAbstract",
    // Classes share the green with interfaces / type aliases — same
    // colour the EXPANDED class circle uses (see `classOutline` below
    // in drawAstNode). Visual continuity across the collapsed-cell ↔
    // expanded-circle toggle.
    ClassDeclaration: "astOutlineAbstract",
    // Top-level `const/let/var x = ...` statements collapse to a
    // single labelled cell. Yellow matches the object/array brace
    // colour since most non-trivial top-level vars are object or
    // array initializers — the colour signals "value-bearing
    // container, click to drill in" the same way the brace cells do.
    VariableStatement: "astOutlineObject",
    // JSX wrappers — `<Foo>…</Foo>` and `<>…</>`. The expandable cell
    // shows the tag in its collapsed leaf; clicking spawns an overlay
    // with the opening tag (and its attributes), children, and closing
    // tag as separate rects.
    JsxElement: "astOutlineJsx",
    JsxFragment: "astOutlineJsx",
    // Control-flow statements — pink border matches the `control`
    // syntax category used for their labels (if/for/while/etc.). The
    // border makes the statement's rect boundary unambiguous even at
    // zooms where the small `if` / `for` text label would be easy to
    // miss inside a larger surrounding Block.
    IfStatement: "astOutlineControl",
    ForStatement: "astOutlineControl",
    ForInStatement: "astOutlineControl",
    ForOfStatement: "astOutlineControl",
    WhileStatement: "astOutlineControl",
    DoStatement: "astOutlineControl",
    SwitchStatement: "astOutlineControl",
    TryStatement: "astOutlineControl",
    // --- Python ---
    ClassDef: "astOutlineAbstract",
    If: "astOutlineControl",
    For: "astOutlineControl",
    AsyncFor: "astOutlineControl",
    While: "astOutlineControl",
    With: "astOutlineControl",
    AsyncWith: "astOutlineControl",
    Try: "astOutlineControl",
    ExceptHandler: "astOutlineControl",
    Match: "astOutlineControl",
    comprehension: "astOutlineControl",
    AsyncComprehension: "astOutlineControl",
    Dict: "astOutlineObject",
    Set: "astOutlineObject",
    List: "astOutlineObject",
    Tuple: "astOutlineObject",
    // Comprehensions produce a container, so they wear the same object-yellow
    // outline as the matching literal: `[ … ]` brackets for a list comp (via
    // BRACKET_KINDS), a plain yellow box for set / dict comps — signalling the
    // `for … in …` clause inside builds a list / set / dict.
    ListComp: "astOutlineObject",
    SetComp: "astOutlineObject",
    DictComp: "astOutlineObject",
};

// Kinds whose box is stroked as a literal pair of square brackets — solid
// left/right verticals with short serifs at each corner — instead of a full
// rectangle, so the container itself reads as `[ … ]`. Covers array
// destructuring (`const [a, b] = …`) AND array literals (`[x, y]`), where the
// brackets ARE the syntax and a "[]" text label over the band just duplicates
// them. The stroke colour comes from KIND_OUTLINE above.
export const BRACKET_KINDS = new Set(["ArrayBindingPattern", "ArrayLiteralExpression", "List", "ListComp"]);
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
    // Python brace literals — `{…}` drops when expanded inline.
    "Dict",
    "Set",
    "List",
    // Comprehensions render always-expanded (the `for … in …` clause shows),
    // so — like the literals above — they reserve no label band; the bracket /
    // box outline carries the container signal.
    "ListComp",
    "SetComp",
    "DictComp",
]);
export function isBraceLabelKind(kind: string): boolean {
    return BRACE_LABEL_KINDS.has(kind);
}

// Per-kind background tint applied to the AST cell's fill. Each entry
// gets BLENDED with the normal depth-derived fill so the kind reads at
// a glance from the background hue alone — no extra label needed. The
// number is a target colour; `blend` is the proportion (0–1) mixed
// with the base fill.
// Which kinds carry a background wash. The wash's colour and strength live in
// the theme (fill.importTintColor / importTintBlend) — this only records that
// the kind gets one, so the set stays a rendering decision while the palette
// stays a themeable one. Resolve with fillTintFor().
export const KIND_FILL_TINT: Record<string, "import"> = {
    // Imports get a slight blue wash — same hue family as the
    // edgeImported blue used for incoming-import lines, so a block
    // labelled with imported names + a blue background reads as
    // "this brings stuff in" at a glance, replacing the previous
    // explicit "import" header label.
    ImportDeclaration: "import",
    // Python imports get the same blue wash.
    Import: "import",
    ImportFrom: "import",
};

// The live colour for a kind's outline, or undefined when the kind has none.
// Always prefer this over indexing KIND_OUTLINE directly — the map holds theme
// KEYS, and resolving them here is what keeps the outlines themeable.
export function outlineColorFor(kind: string): number | undefined {
    const key = KIND_OUTLINE[kind];
    return key === undefined ? undefined : liveTheme.colors[key];
}

// The live background wash for a kind, or undefined when it has none.
export function fillTintFor(kind: string): {color: number; blend: number} | undefined {
    return KIND_FILL_TINT[kind] === undefined ? undefined : {color: liveTheme.fill.importTintColor, blend: liveTheme.fill.importTintBlend};
}

// A node is "significant" — worth its own box, never collapsed as a
// pass-through — if it shows a label OR carries a kind outline. (A magenta
// `block` or yellow `object` must survive even as a single-child wrapper,
// otherwise its outline would never be drawn.)
export function isSignificant(node: {name: string | null; syntaxKind: string; chain?: unknown[]}): boolean {
    return (
        labelFor(node) !== null ||
        // A flattened method-call chain has no single label (its flow is built
        // from chain tokens), so it must be kept significant explicitly — else a
        // single-child chain (`[arr].pop()`) would collapse into its base.
        (node.chain != null && node.chain.length > 0) ||
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
    // --- Python ---
    // A class drills into its members (like ClassDeclaration); a dict literal
    // drills into its entries (like ObjectLiteralExpression). Function bodies
    // are wrapped in a synthetic `Block` server-side, so they collapse via the
    // `Block` entry above rather than needing FunctionDef here.
    "ClassDef",
    "Dict",
]);
export function isExpandableKind(kind: string): boolean {
    return EXPANDABLE_KINDS.has(kind);
}

// Label text colored like the code editor (Monaco `vs-dark` / Dark+ family,
// matching EditorPane's theme): types teal, functions yellow, control-flow
// pink, other keywords blue, strings salmon, numbers green, everything
// identifier-ish light blue, fallback default foreground.
export const SYNTAX: SyntaxColors = {
    type: 0x4ec9b0,
    func: 0xdcdcaa,
    variable: 0x9cdcfe,
    control: 0xc586c0,
    keyword: 0x569cd6,
    string: 0xce9178,
    number: 0xb5cea8,
    // Assignment-to-existing-binding operator (`=`, `+=`, …) — warm orange,
    // deliberately apart from string-salmon and number-green so a mutating
    // `=` reads differently from a declaration's neutral `=` at a glance.
    // See AstNode.decl === 'mutation'.
    mutation: 0xffa657,
    default: 0xd4d4d4,
};

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
// `glue: true` means "do NOT allow a row break BEFORE this token" — the flow
// packer keeps it on the same row as the preceding token. Used to keep a
// method-call segment's `method ( args )` together so matching parens never
// split across a wrap (only the leading `▷` marker is a legal break point).
// `breakBefore: true` is the opposite — ALWAYS start a new row at this token,
// regardless of remaining width. Used for the `else` / `else if` keyword so a
// conditional reads `if [cond] [then]` / `else [elseBranch]` on separate lines.
export type SyntaxToken =
    | { kw: string; color: number; size?: number; glue?: boolean; breakBefore?: boolean }
    | { child: number; glue?: boolean; breakBefore?: boolean };
export type SyntaxTemplate = (
    kids: { syntaxKind: string; role?: string }[],
    node: { syntaxKind: string; name: string | null; returnType?: string },
) => SyntaxToken[];

// Template bodies reference SYNTAX.* directly rather than capturing the values
// in module-level consts (`C`/`K`/`P` previously): the templates are functions
// invoked per node at layout time, so a property read inside them picks up the
// live palette, while a captured number would pin every keyword glyph to the
// colours that happened to be loaded at import.

export const SYNTAX_TEMPLATES: Record<string, SyntaxTemplate> = {
    // --- Loops ---
    // `for [item] of [iterable]` — item and iterable are always children 0 and
    // 1; the body (child 2) isn't referenced, so it auto-appends below.
    ForOfStatement: () => [{kw: "for", color: SYNTAX.control}, {child: 0}, {kw: "of", color: SYNTAX.control}, {child: 1}],
    ForInStatement: () => [{kw: "for", color: SYNTAX.control}, {child: 0}, {kw: "in", color: SYNTAX.control}, {child: 1}],
    WhileStatement: () => [{kw: "while", color: SYNTAX.control}, {child: 0}],
    // `do { body } while [cond]` — body is child 0, condition child 1.
    DoStatement: (kids) =>
        kids.length >= 2
            ? [{kw: "do", color: SYNTAX.control}, {child: 0}, {kw: "while", color: SYNTAX.control}, {child: 1}]
            : [{kw: "do", color: SYNTAX.control}],
    // `for [init] ; [cond] ; [update]` — clauses are role-tagged by the server
    // because any can be omitted (`for (;;)`). Reference every role-bearing
    // child (there can be several `init`s, as in `for (let i=0, j=1; …)`); the
    // single roleless child (the body) auto-appends below.
    ForStatement: (kids) => {
        const t: SyntaxToken[] = [{kw: "for", color: SYNTAX.control}];
        const pushRole = (r: string) =>
            kids.forEach((k, i) => { if (k.role === r) t.push({child: i}); });
        pushRole("init");
        t.push({kw: ";", color: SYNTAX.default});
        pushRole("cond");
        t.push({kw: ";", color: SYNTAX.default});
        pushRole("update");
        return t;
    },
    // --- Conditionals & switch ---
    // `if [cond] { then } else { else }` — the `else` glyph sits before the
    // else branch (child 2), which may itself be another `if` (else-if chain).
    // `breakBefore` forces the `else` onto its own line so the conditional reads
    // `if [cond] [then]` / `else [elseBranch]` (and `else if …`) line by line,
    // rather than the `else` trailing the then-branch on the same row.
    IfStatement: (kids) =>
        kids.length >= 3
            ? [{kw: "if", color: SYNTAX.control}, {child: 0}, {child: 1}, {kw: "else", color: SYNTAX.control, breakBefore: true}, {child: 2}]
            : [{kw: "if", color: SYNTAX.control}, {child: 0}],
    SwitchStatement: () => [{kw: "switch", color: SYNTAX.control}, {child: 0}],
    CaseClause: () => [{kw: "case", color: SYNTAX.control}, {child: 0}, {kw: ":", color: SYNTAX.default}],
    DefaultClause: () => [{kw: "default", color: SYNTAX.control}, {kw: ":", color: SYNTAX.default}],
    // --- Jumps & error handling ---
    // `return` shows as a prominent pink return glyph (↩) rather than the word,
    // then the returned expression: `↩ [expr]`. Drawn at 2× the normal 11px
    // label size (it still scales with zoom like all labels, via labelScale).
    ReturnStatement: () => [{kw: "↩", color: SYNTAX.control, size: 22}],
    ThrowStatement: () => [{kw: "throw", color: SYNTAX.control}],
    // `try { } catch (e) { } finally { }`. Children: try-block (0), an optional
    // CatchClause, an optional finally Block. Reference them in order so the
    // `finally` keyword lands before its block; the CatchClause draws its own
    // `catch [param]` via its own template.
    TryStatement: (kids) => {
        const t: SyntaxToken[] = [{kw: "try", color: SYNTAX.control}, {child: 0}];
        let i = 1;
        if (kids[i]?.syntaxKind === "CatchClause") { t.push({child: i}); i++; }
        if (kids[i]?.syntaxKind === "Block") { t.push({kw: "finally", color: SYNTAX.control}, {child: i}); }
        return t;
    },
    // `catch [param] { body }` — a param is present unless it's a bare `catch {}`.
    CatchClause: (kids) =>
        kids.length >= 2 ? [{kw: "catch", color: SYNTAX.control}, {child: 0}] : [{kw: "catch", color: SYNTAX.control}],
    // --- Inline keyword-expressions ---
    AwaitExpression: () => [{kw: "await", color: SYNTAX.control}],
    YieldExpression: () => [{kw: "yield", color: SYNTAX.control}],
    TypeOfExpression: () => [{kw: "typeof", color: SYNTAX.keyword}],
    VoidExpression: () => [{kw: "void", color: SYNTAX.keyword}],
    DeleteExpression: () => [{kw: "delete", color: SYNTAX.keyword}],
    // Spread `...expr` in every position: arrays / calls (SpreadElement),
    // object literals (SpreadAssignment), and JSX (`<C {...props} />`). All
    // render the `...` as an inline prefix glyph in front of the spread
    // expression instead of a `...`-labelled box, so `{ ...entity.velocity }`
    // reads as `... entity.velocity` rather than dropping the `...` entirely
    // (these collapse to a bare pass-through without a template).
    SpreadElement: () => [{kw: "...", color: SYNTAX.default}],
    SpreadAssignment: () => [{kw: "...", color: SYNTAX.default}],
    JsxSpreadAttribute: () => [{kw: "...", color: SYNTAX.default}],
    // A template-literal interpolation `${expr}`: render a `$` prefix glyph in
    // front of the expression (child 0), so `` `button-${variant}` `` reads as
    // `` `button-` `` then `$ [variant]`. The trailing literal chunk (child 1, a
    // TemplateMiddle/Tail) auto-appends after when non-empty; empty chunks are
    // dropped server-side so there's no stray empty box.
    TemplateSpan: () => [{kw: "$", color: SYNTAX.default}, {child: 0}],
    // `[expr] as [Type]` — both operands present (expression 0, type 1).
    AsExpression: () => [{child: 0}, {kw: "as", color: SYNTAX.keyword}, {child: 1}],
    // Subscript / element access `base[index]` — the base box followed by the
    // index box glued to it (child 0 = base, child 1 = index). The `[ ]` are NOT
    // flow glyphs: the renderer strokes the INDEX box itself as a white square
    // bracket (see `isSubscriptIndex` in drawAstNode), so `ctx.query["item"]`
    // reads with the brace ON the indexed value rather than two loose bracket
    // chips. Covers TS `arr[i]` and Python `d["k"]`.
    ElementAccessExpression: () => [{child: 0}, {child: 1, glue: true}],
    Subscript: () => [{child: 0}, {child: 1, glue: true}],

    // --- Python control flow / keyword-expressions ---
    // Bodies are bare statement lists (no Block wrapper for control flow), so
    // each template references only its header operand(s); the body statements
    // auto-append below the keyword header. `elif` arrives as a nested `If` in
    // the parent's orelse, which simply renders as another `if [test]` row.
    If: () => [{kw: "if", color: SYNTAX.control}, {child: 0}],
    While: () => [{kw: "while", color: SYNTAX.control}, {child: 0}],
    For: () => [{kw: "for", color: SYNTAX.control}, {child: 0}, {kw: "in", color: SYNTAX.control}, {child: 1}],
    AsyncFor: () => [{kw: "async for", color: SYNTAX.control}, {child: 0}, {kw: "in", color: SYNTAX.control}, {child: 1}],
    // Comprehension clause `for [target] in [iter] if [cond]…` — the server
    // emits one `comprehension` box per generator with children in
    // target (0), iter (1), ifs (2+) order. Each trailing `if` renders its own
    // keyword so a filtered comprehension reads in full; nested comprehensions
    // (`[x for a in A for b in B]`) surface as sibling comprehension boxes.
    comprehension: (kids) => {
        const t: SyntaxToken[] = [{kw: "for", color: SYNTAX.control}, {child: 0}, {kw: "in", color: SYNTAX.control}, {child: 1}];
        for (let i = 2; i < kids.length; i++) t.push({kw: "if", color: SYNTAX.control}, {child: i});
        return t;
    },
    AsyncComprehension: (kids) => {
        const t: SyntaxToken[] = [{kw: "async for", color: SYNTAX.control}, {child: 0}, {kw: "in", color: SYNTAX.control}, {child: 1}];
        for (let i = 2; i < kids.length; i++) t.push({kw: "if", color: SYNTAX.control}, {child: i});
        return t;
    },
    With: () => [{kw: "with", color: SYNTAX.control}, {child: 0}],
    AsyncWith: () => [{kw: "async with", color: SYNTAX.control}, {child: 0}],
    Return: () => [{kw: "↩", color: SYNTAX.control, size: 22}],
    Raise: () => [{kw: "raise", color: SYNTAX.control}],
    Assert: () => [{kw: "assert", color: SYNTAX.control}, {child: 0}],
    Await: () => [{kw: "await", color: SYNTAX.control}],
    Yield: () => [{kw: "yield", color: SYNTAX.control}],
    YieldFrom: () => [{kw: "yield from", color: SYNTAX.control}],
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
export const FUNCTION_SIGNATURE_KINDS = new Set([
    "FunctionDeclaration",
    "MethodDeclaration",
    "ArrowFunction",
    // Python — `def` / `async def` (params bracketed left, body right).
    "FunctionDef",
    "AsyncFunctionDef",
]);
export function isFunctionSignatureKind(kind: string): boolean {
    return FUNCTION_SIGNATURE_KINDS.has(kind);
}

// JSX elements rendered with the same two-column signature shape as functions
// (see jsxLayout in treemap.ts): the tag name in a header band (`<Foo />`),
// attributes bracketed on the LEFT, child elements stacked on the RIGHT. The
// opening/closing tags are folded away server-side, so a `<Foo>…</Foo>` reads
// as one element instead of three blocks. Covers both the wrapper element and
// the self-closing form (`<Bar … />`, attributes only, no children).
export const JSX_SIGNATURE_KINDS = new Set(["JsxElement", "JsxSelfClosingElement"]);
export function isJsxSignatureKind(kind: string): boolean {
    return JSX_SIGNATURE_KINDS.has(kind);
}

// Adapter passed to layoutAst (AstLayoutOpts.syntaxTokens): resolve a kind's
// template and run it against the node's children, or null for untemplated
// kinds so the layout falls back to the label + wrapped-packing path.
export function syntaxTokens(
    kind: string,
    kids: {syntaxKind: string; role?: string}[],
    node: {syntaxKind: string; name: string | null; returnType?: string; chain?: {marker: string; argCount: number}[]},
): SyntaxToken[] | null {
    // Flattened method-call chain → a flat fluent flow that reads like source:
    // `[base] ▷ filter ( arg ) ▷ join ( arg )`. The node's children are
    // `[base, ...args]` in order; each segment contributes a keyword-blue `▷`
    // marker + func-yellow method name + grey `( … )` around its arg child
    // boxes. Built dynamically (the markers/arg-counts vary per node), unlike
    // the static SYNTAX_TEMPLATES below.
    if (node.chain && node.chain.length > 0) {
        const tokens: SyntaxToken[] = [{child: 0}]; // base receiver = head box
        let idx = 1;
        for (const seg of node.chain) {
            // The `▷` marker is the ONLY legal wrap point in a segment; glue
            // everything after it so `method ( … )` stays on one row and the
            // parens never split across a wrap.
            tokens.push({kw: "▷ ", color: SYNTAX.keyword});
            tokens.push({kw: seg.marker, color: SYNTAX.func, glue: true});
            tokens.push({kw: "(", color: SYNTAX.default, glue: true});
            for (let a = 0; a < seg.argCount; a++) {
                if (a > 0) tokens.push({kw: ",", color: SYNTAX.default, glue: true});
                tokens.push({child: idx++, glue: true});
            }
            tokens.push({kw: ")", color: SYNTAX.default, glue: true});
        }
        return tokens;
    }
    // Destructured parameter `({ … }: Type)` — render it as `{…} : Type`: the
    // binding pattern collapses to a drillable `{…}` (via constructLayout's
    // sizeOrCollapse), and the type annotation reads clearly as the object's
    // type (a TypeReference, painted teal). Replaces the generic "param" box
    // that wrapped the pattern + type. A baked `name: Type` param has its type
    // folded into the name and NO children, so it never matches here.
    if (
        kind === "Parameter" &&
        kids.length === 2 &&
        (kids[0].syntaxKind === "ObjectBindingPattern" || kids[0].syntaxKind === "ArrayBindingPattern")
    ) {
        return [{child: 0}, {kw: ": ", color: SYNTAX.default}, {child: 1}];
    }
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

    // --- Python (stdlib `ast` node names) ---
    ClassDef: "type",
    FunctionDef: "func",
    AsyncFunctionDef: "func",
    Lambda: "keyword",
    Call: "func",
    Attribute: "variable",
    Subscript: "variable",
    Name: "variable",
    alias: "variable",
    Decorator: "keyword",
    Import: "keyword",
    ImportFrom: "keyword",
    Global: "keyword",
    Nonlocal: "keyword",
    Delete: "keyword",
    If: "control",
    For: "control",
    AsyncFor: "control",
    While: "control",
    With: "control",
    AsyncWith: "control",
    Try: "control",
    ExceptHandler: "control",
    Return: "control",
    Raise: "control",
    Assert: "control",
    Pass: "control",
    Break: "control",
    Continue: "control",
    Await: "control",
    Yield: "control",
    YieldFrom: "control",
    Match: "control",
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
export const HIGH_LEVEL_KINDS = new Set(["ClassDeclaration", "ClassExpression", "InterfaceDeclaration", "EnumDeclaration", "TypeAliasDeclaration", "ClassDef"]);
export function isHighLevel(node: {syntaxKind: string; exported?: boolean}): boolean {
    return node.exported === true || HIGH_LEVEL_KINDS.has(node.syntaxKind);
}
