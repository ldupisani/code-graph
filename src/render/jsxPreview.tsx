// JSX → wireframe preview: turns a JSX subtree from the analyzed
// project's AST into a structural HTML mock — real (allowlisted) tags
// for lowercase elements, labeled placeholder boxes for components,
// chips for {expressions}. It deliberately renders STRUCTURE, not
// appearance: the analyzed project's CSS/build is unavailable, and
// expressions/props can't be evaluated, so a neutral dark "wireframe"
// styling is the honest ceiling. (A faithful render is what the
// Storybook embed provides — see storybookOverlay.ts / the story-aware
// switch in htmlPreviewOverlay.ts.)
//
// Three layers, all pure:
//   buildJsxPreviewModel — flat AstNode[] + root id (+ optional raw
//     source) → a small JsxPreviewNode tree. The optional source text
//     recovers what the extractor doesn't ship: attribute VALUES and
//     full expression text (the extractor elides JsxExpression braces,
//     so any non-attr/non-text/non-element child IS an expression).
//   JsxWireframePreview — React renderer for the hover tooltip. Builds
//     elements directly from the model (no innerHTML) and NEVER applies
//     project attrs to the DOM (they render as label chips), so
//     analyzed markup like <img onerror=…> is inert by construction.
//   wireframeSrcdoc — HTML-string serializer for the full-size overlay
//     iframe. Every interpolated string is escaped; pair it with
//     sandbox="" (the document also carries a default-src 'none' CSP
//     as belt-and-braces).

import type {CSSProperties, ReactNode} from "react";
import type {AstNode} from "../api/types";

export type JsxPreviewNode =
    | {kind: "element"; tag: string; attrs: JsxPreviewAttr[]; children: JsxPreviewNode[]}
    | {kind: "component"; name: string; attrs: JsxPreviewAttr[]; children: JsxPreviewNode[]}
    | {kind: "fragment"; children: JsxPreviewNode[]}
    | {kind: "text"; text: string}
    | {kind: "expression"; text: string}
    | {kind: "truncated"};

// value is null for boolean attrs ({disabled}), spreads, and whenever
// the raw source isn't available to slice the value out of.
export interface JsxPreviewAttr {
    name: string;
    value: string | null;
}

export interface JsxPreviewOpts {
    maxDepth?: number;
    maxNodes?: number;
}

const JSX_ROOT_KINDS = new Set(["JsxElement", "JsxSelfClosingElement", "JsxFragment"]);
const EXPR_TEXT_MAX = 40;

// Collapse runs of whitespace (JSX source slices keep the author's
// indentation) and cap with a visible ellipsis.
function squash(text: string, max: number): string {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Tag from the extractor's element label (`<Foo />`, `<div>…</div>`).
function tagOf(node: AstNode): string {
    return (node.name ?? "").replace(/[<>/\s…]/g, "");
}

function isComponentTag(tag: string): boolean {
    return /^[A-Z]/.test(tag) || tag.includes(".");
}

// Attribute value, recovered from the raw source: the slice is
// `name={expr}` / `name="str"` / `name` — split on the first `=`.
function attrOf(node: AstNode, source: string | undefined): JsxPreviewAttr {
    if (node.syntaxKind === "JsxSpreadAttribute") {
        const text = source ? squash(source.slice(node.start, node.end), EXPR_TEXT_MAX) : `{...${node.name ?? ""}}`;
        return {name: text, value: null};
    }
    const name = node.name ?? "?";
    if (!source) return {name, value: null};
    const slice = source.slice(node.start, node.end);
    const eq = slice.indexOf("=");
    if (eq < 0) return {name, value: null};
    let value = slice.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    return {name, value: squash(value, EXPR_TEXT_MAX)};
}

// Build the wireframe model for the subtree rooted at `rootId`.
// Returns null when that node isn't a JSX root kind. Depth and node
// budgets are enforced HERE (not in the renderers) so both surfaces —
// tooltip and overlay — get the same safety valve against render-method
// roots with hundreds of descendants; exhausted budgets surface as
// explicit `truncated` markers rather than silent omission.
export function buildJsxPreviewModel(
    nodes: readonly AstNode[],
    rootId: string,
    source?: string,
    opts: JsxPreviewOpts = {},
): JsxPreviewNode | null {
    const maxDepth = opts.maxDepth ?? 5;
    const budget = {left: opts.maxNodes ?? 80};

    const byId = new Map<string, AstNode>();
    const childrenByParent = new Map<string, AstNode[]>();
    for (const n of nodes) {
        byId.set(n.id, n);
        if (n.parentId === null) continue;
        let list = childrenByParent.get(n.parentId);
        if (!list) {
            list = [];
            childrenByParent.set(n.parentId, list);
        }
        list.push(n);
    }
    // Source order — the flat list isn't guaranteed to be, and child
    // order IS the markup.
    for (const list of childrenByParent.values()) list.sort((a, b) => a.start - b.start);

    const root = byId.get(rootId);
    if (!root || !JSX_ROOT_KINDS.has(root.syntaxKind)) return null;

    const isAttr = (n: AstNode): boolean => n.syntaxKind === "JsxAttribute" || n.syntaxKind === "JsxSpreadAttribute";

    const convert = (node: AstNode, depth: number): JsxPreviewNode => {
        budget.left--;

        if (node.syntaxKind === "JsxText") {
            const text = source ? source.slice(node.start, node.end) : (node.name ?? "");
            return {kind: "text", text: squash(text, 200)};
        }

        if (!JSX_ROOT_KINDS.has(node.syntaxKind)) {
            // Anything else under an element is an elided-brace
            // {expression} (CallExpression, ConditionalExpression,
            // Identifier, …). One chip — a {items.map(…)} body is a
            // single chip by design, not N boxes.
            const text = source ? source.slice(node.start, node.end) : (node.preview ?? node.name ?? node.syntaxKind);
            return {kind: "expression", text: squash(text, EXPR_TEXT_MAX)};
        }

        const kids = childrenByParent.get(node.id) ?? [];
        const attrs = kids.filter(isAttr).map((a) => attrOf(a, source));
        const childNodes = kids.filter((k) => !isAttr(k));

        const children: JsxPreviewNode[] = [];
        for (const c of childNodes) {
            if (budget.left <= 0 || depth + 1 > maxDepth) {
                children.push({kind: "truncated"});
                break;
            }
            children.push(convert(c, depth + 1));
        }

        if (node.syntaxKind === "JsxFragment") return {kind: "fragment", children};
        const tag = tagOf(node);
        return isComponentTag(tag) ? {kind: "component", name: tag, attrs, children} : {kind: "element", tag, attrs, children};
    };

    return convert(root, 0);
}

// ---------------------------------------------------------------------------
// Shared wireframe visual language (both renderers)
// ---------------------------------------------------------------------------

// Lowercase tags rendered as REAL HTML elements. Everything else (and
// anything risky — script, iframe, object, embed, link, style…) becomes
// a generic box that still shows its tag badge. The allowlist is about
// what we'll instantiate, not what we'll display.
//
// CONTAINERS ONLY: both renderers place the tag badge + attribute chips
// INSIDE the element, so void elements (input, img, br, …) must never
// be instantiated — React throws ("input is a void element tag and must
// neither have children…"), which without a boundary unmounts the whole
// app — and text-only elements (textarea, option, select's non-option
// children) misbehave similarly. Those tags render as a generic box
// with their badge, like components do.
const ELEMENT_ALLOWLIST = new Set([
    "div", "span", "p", "button", "a", "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "tr", "td", "th",
    "label", "section", "header", "footer", "nav", "form",
]);

const C_TEXT = "#d4d4d4";
const C_DIM = "#8b8b94";
const C_COMPONENT = "#4ec9b0";
const C_CHIP_BG = "rgba(44, 44, 52, 0.9)";
const C_BORDER = "rgba(120, 120, 130, 0.45)";
const C_COMPONENT_BG = "rgba(78, 201, 176, 0.08)";
const C_COMPONENT_BORDER = "rgba(78, 201, 176, 0.45)";

// ---------------------------------------------------------------------------
// (a) React renderer — hover tooltip. Inert by construction: project
// attrs never reach the DOM, non-allowlisted tags render as <div>.
// ---------------------------------------------------------------------------

// Applied to REAL instantiated tags too (button, a, …), so it must
// override their user-agent chrome — without an explicit background
// and font, a native <button> renders as a light-grey UA pill that
// breaks the dark wireframe.
const elementBoxStyle: CSSProperties = {
    display: "block",
    border: `1px dashed ${C_BORDER}`,
    borderRadius: 4,
    padding: "4px 6px",
    margin: "2px 0",
    color: C_TEXT,
    background: "transparent",
    font: "inherit",
    textAlign: "left",
    width: "auto",
};
const componentBoxStyle: CSSProperties = {
    display: "block",
    border: `1px solid ${C_COMPONENT_BORDER}`,
    background: C_COMPONENT_BG,
    borderRadius: 4,
    padding: "4px 6px",
    margin: "2px 0",
    color: C_COMPONENT,
};
const badgeStyle: CSSProperties = {
    color: C_DIM,
    fontSize: "0.85em",
    marginRight: 6,
};
const chipStyle: CSSProperties = {
    display: "inline-block",
    background: C_CHIP_BG,
    color: C_DIM,
    borderRadius: 999,
    padding: "0 6px",
    margin: "1px 3px 1px 0",
    fontSize: "0.85em",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

function attrChips(attrs: JsxPreviewAttr[]): ReactNode {
    if (attrs.length === 0) return null;
    return attrs.map((a, i) => (
        <span key={i} style={chipStyle}>
            {a.value === null ? a.name : `${a.name}=${a.value}`}
        </span>
    ));
}

function renderModelNode(node: JsxPreviewNode, key: number): ReactNode {
    switch (node.kind) {
        case "element": {
            const Tag = (ELEMENT_ALLOWLIST.has(node.tag) ? node.tag : "div") as "div";
            return (
                <Tag key={key} style={elementBoxStyle}>
                    <span style={badgeStyle}>{node.tag}</span>
                    {attrChips(node.attrs)}
                    {node.children.map(renderModelNode)}
                </Tag>
            );
        }
        case "component":
            return (
                <div key={key} style={componentBoxStyle}>
                    <span>{`<${node.name}>`}</span>
                    {attrChips(node.attrs)}
                    {node.children.map(renderModelNode)}
                </div>
            );
        case "fragment":
            return <div key={key}>{node.children.map(renderModelNode)}</div>;
        case "text":
            return <span key={key}>{node.text}</span>;
        case "expression":
            return (
                <span key={key} style={chipStyle}>{`{${node.text}}`}</span>
            );
        case "truncated":
            return (
                <span key={key} style={chipStyle}>
                    …
                </span>
            );
    }
}

export function JsxWireframePreview({model, maxWidth, maxHeight}: {model: JsxPreviewNode; maxWidth?: number; maxHeight?: number}) {
    return (
        <div
            style={{
                maxWidth,
                maxHeight,
                overflow: "hidden",
                fontFamily: "system-ui, sans-serif",
                fontSize: "0.78rem",
                lineHeight: 1.4,
                color: C_TEXT,
            }}
        >
            {renderModelNode(model, 0)}
        </div>
    );
}

// ---------------------------------------------------------------------------
// (b) HTML serializer — full-size overlay iframe. Escapes everything;
// host must still set sandbox="" BEFORE assigning srcdoc.
// ---------------------------------------------------------------------------

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const WIREFRAME_CSS = `
  :root { color-scheme: dark; }
  body { margin: 10px; background: transparent; color: ${C_TEXT};
         font-family: system-ui, sans-serif; font-size: 13px; line-height: 1.45; }
  /* .el lands on REAL tags (button, a, …) too — neutralize their
     user-agent chrome (light-grey button fill, link colors, button
     font) so everything keeps the dark wireframe look. */
  .el  { display: block; border: 1px dashed ${C_BORDER}; border-radius: 4px;
         padding: 4px 7px; margin: 3px 0; background: transparent;
         color: ${C_TEXT}; font: inherit; text-align: left; width: auto; }
  .cmp { display: block; border: 1px solid ${C_COMPONENT_BORDER}; background: ${C_COMPONENT_BG};
         border-radius: 4px; padding: 4px 7px; margin: 3px 0; color: ${C_COMPONENT}; }
  .badge { color: ${C_DIM}; font-size: 11px; margin-right: 6px; }
  .chip  { display: inline-block; background: ${C_CHIP_BG}; color: ${C_DIM};
           border-radius: 999px; padding: 0 7px; margin: 1px 3px 1px 0; font-size: 11px;
           font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

function serializeAttrs(attrs: JsxPreviewAttr[]): string {
    return attrs.map((a) => `<span class="chip">${esc(a.value === null ? a.name : `${a.name}=${a.value}`)}</span>`).join("");
}

function serializeNode(node: JsxPreviewNode): string {
    switch (node.kind) {
        case "element": {
            const tag = ELEMENT_ALLOWLIST.has(node.tag) ? node.tag : "div";
            const kids = node.children.map(serializeNode).join("");
            return `<${tag} class="el"><span class="badge">${esc(node.tag)}</span>${serializeAttrs(node.attrs)}${kids}</${tag}>`;
        }
        case "component": {
            const kids = node.children.map(serializeNode).join("");
            return `<div class="cmp"><span>${esc(`<${node.name}>`)}</span>${serializeAttrs(node.attrs)}${kids}</div>`;
        }
        case "fragment":
            return `<div>${node.children.map(serializeNode).join("")}</div>`;
        case "text":
            return esc(node.text);
        case "expression":
            return `<span class="chip">${esc(`{${node.text}}`)}</span>`;
        case "truncated":
            return `<span class="chip">…</span>`;
    }
}

export function wireframeSrcdoc(model: JsxPreviewNode): string {
    return (
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
        `<style>${WIREFRAME_CSS}</style></head><body>${serializeNode(model)}</body></html>`
    );
}
