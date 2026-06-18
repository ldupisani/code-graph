// Storybook-on-a-JSX-node: when the user toggles the eye handle on an
// expanded JsxElement/JsxFragment overlay whose enclosing component has
// stories, a live Storybook iframe covers the node's rect — the
// component rendered in place of its markup. (The structural wireframe
// preview of the same markup lives in the hover tooltip — see
// jsxPreview.tsx — so this overlay is storybook-only and the eye handle
// is only drawn when stories exist.)
//
// A deliberate SIBLING of storybookOverlay.ts (the file-level embed)
// rather than a shared base: the positioning core (container-space
// translate, geometry diffing, scale-to-fit + centring + aspect fade)
// is copied from there (storybookOverlay.ts update(), ~lines 380–409),
// but this layer keys by AST NODE id (fileId#seq), resolves its stories
// through the caller (component-aware filtering over the story file's
// AST — see storiesForJsxNode in PixiCanvas), has no postMessage
// measuring, and closes via togglePreview rather than deselection.
//
// Interactivity mirrors the story layer: the iframe defaults to
// pointer-events:none so graph pan/zoom/click pass through; the header
// floats above the rect (wrapping upward when chips outrun the panel)
// and is always clickable; "interact" arms the iframe for real mouse
// work inside the story.

import {
    createControlGroup,
    createIconHandle,
    ICON_CODE,
    ICON_COLLAPSE,
    ICON_INTERACT,
    storyIframeUrl,
    wireDragCollapse,
    type StoryEntry,
} from "./storybookOverlay";

const HEADER_H = 24;
// Top inset (screen px) the story content is pushed down by, leaving a
// clear strip for the interact/close handles (see storybookOverlay).
const CONTROL_STRIP_H = 28;

// Story chosen per AST node, surviving collapse/re-expand and layer
// rebuilds (same idiom as selectedStoryByFile in the story layer).
const selectedStoryByNode = new Map<string, string>();

export interface JsxStoryOverlayItem {
    // AST node id (`fileId#seq`) of the previewed JSX overlay.
    nodeId: string;
    fileId: string;
    // The overlay body's rect, container space, this frame.
    x: number;
    y: number;
    w: number;
    h: number;
    // The rect's size at camera scale 1 — the iframe's CSS layout size,
    // kept FIXED while zooming so the story never reflows; only the
    // scale transform changes per frame.
    worldW: number;
    worldH: number;
}

export interface JsxStoryOverlayOpts {
    // Stories belonging to THIS node's enclosing component (the caller
    // resolves the Storybook index + story-file ASTs and memoizes).
    // null = still resolving — the layer retries every frame; [] = no
    // stories (the caller normally gates items on this, so the layer
    // just keeps its placeholder header).
    getStories: (nodeId: string) => StoryEntry[] | null;
    // "</>" handle — switch the story back to the code view (the caller
    // wires this to togglePreview(nodeId)).
    onClose?: (nodeId: string) => void;
    // Top-left drag|collapse handle, mirroring the code block's: a plain
    // click collapses the block (onCollapse); a drag repositions it by
    // feeding SCREEN-px deltas into the same overlay-drag-offset
    // mechanism the canvas handle uses (so the connector line is free).
    onCollapse?: (nodeId: string) => void;
    onDragStart?: (nodeId: string) => boolean;
    onDragMove?: (nodeId: string, dx: number, dy: number) => void;
    onDragEnd?: (nodeId: string) => void;
}

export interface JsxStoryOverlayLayer {
    update: (items: readonly JsxStoryOverlayItem[]) => void;
    destroy: () => void;
}

interface Overlay {
    el: HTMLDivElement;
    header: HTMLDivElement;
    frameBox: HTMLDivElement;
    iframe: HTMLIFrameElement | null;
    stories: StoryEntry[] | null;
    interactive: boolean;
    worldW: number;
    worldH: number;
    lastX: number;
    lastY: number;
    lastW: number;
    lastH: number;
}

export function createJsxStoryOverlayLayer(container: HTMLElement, opts: JsxStoryOverlayOpts): JsxStoryOverlayLayer {
    const host = document.createElement("div");
    Object.assign(host.style, {
        position: "absolute",
        inset: "0",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: "4",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(host);

    const overlays = new Map<string, Overlay>();

    function createOverlay(): Overlay {
        const el = document.createElement("div");
        Object.assign(el.style, {
            position: "absolute",
            left: "0",
            top: "0",
            pointerEvents: "none",
        } satisfies Partial<CSSStyleDeclaration>);

        const frameBox = document.createElement("div");
        Object.assign(frameBox.style, {
            position: "absolute",
            inset: "0",
            background: "rgba(22, 22, 27, 0.97)",
            borderRadius: "8px",
            boxShadow: "inset 0 0 0 1px rgba(120, 140, 200, 0.45)",
            overflow: "hidden",
            pointerEvents: "none",
        } satisfies Partial<CSSStyleDeclaration>);
        el.appendChild(frameBox);

        const header = document.createElement("div");
        Object.assign(header.style, {
            position: "absolute",
            // Anchored to the panel's TOP edge and growing UPWARD: story
            // chips + interact + ✕ can outrun a narrow panel, and a
            // clipped row makes the ✕ unreachable — wrap into extra rows
            // above instead.
            bottom: "calc(100% + 4px)",
            left: "0",
            right: "0",
            minHeight: `${HEADER_H}px`,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "4px",
            whiteSpace: "nowrap",
            color: "#8b8b94",
            fontFamily: "ui-monospace, monospace",
            fontSize: "11px",
            pointerEvents: "auto",
            userSelect: "none",
        } satisfies Partial<CSSStyleDeclaration>);
        header.textContent = "storybook…";
        el.appendChild(header);
        host.appendChild(el);

        return {
            el,
            header,
            frameBox,
            iframe: null,
            stories: null,
            interactive: false,
            worldW: 0,
            worldH: 0,
            lastX: NaN,
            lastY: NaN,
            lastW: NaN,
            lastH: NaN,
        };
    }

    function chip(label: string, title: string): HTMLButtonElement {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        Object.assign(b.style, {
            appearance: "none",
            border: "0",
            borderRadius: "999px",
            padding: "1px 8px",
            fontFamily: "inherit",
            fontSize: "10px",
            cursor: "pointer",
            background: "rgba(44, 44, 52, 0.9)",
            color: "#a8a8b2",
            flexShrink: "0",
        } satisfies Partial<CSSStyleDeclaration>);
        return b;
    }

    // Build the iframe + header once the caller's lookup resolves this
    // node's stories.
    function populate(o: Overlay, nodeId: string, stories: StoryEntry[]): void {
        o.stories = stories;
        const known = stories.some((s) => s.id === selectedStoryByNode.get(nodeId));
        const selected = known ? selectedStoryByNode.get(nodeId)! : stories[0].id;
        selectedStoryByNode.set(nodeId, selected);

        const iframe = document.createElement("iframe");
        Object.assign(iframe.style, {
            position: "absolute",
            top: "0",
            left: "0",
            border: "0",
            background: "rgba(22, 22, 27, 1)",
            transformOrigin: "0 0",
            pointerEvents: "none",
        } satisfies Partial<CSSStyleDeclaration>);
        iframe.src = storyIframeUrl(selected);
        o.frameBox.appendChild(iframe);
        o.iframe = iframe;
        o.worldW = 0; // force the size/scale write in this frame's pass

        o.header.textContent = "";
        if (stories.length > 1) {
            const chips: HTMLButtonElement[] = [];
            const syncChips = (): void => {
                const cur = selectedStoryByNode.get(nodeId);
                for (const c of chips) {
                    const on = c.dataset.storyId === cur;
                    c.style.background = on ? "rgba(48, 72, 108, 0.95)" : "rgba(44, 44, 52, 0.9)";
                    c.style.color = on ? "#eaf2ff" : "#a8a8b2";
                }
            };
            for (const s of stories) {
                const c = chip(s.name, `Show story "${s.name}"`);
                c.dataset.storyId = s.id;
                c.onclick = () => {
                    selectedStoryByNode.set(nodeId, s.id);
                    if (o.iframe) o.iframe.src = storyIframeUrl(s.id);
                    syncChips();
                };
                chips.push(c);
                o.header.appendChild(c);
            }
            syncChips();
        }

        // Controls as icon handles floating inside the panel's top
        // corners, instead of text controls in the header above the block:
        //   top-LEFT  — drag|collapse handle (drag to move, click to
        //               collapse), mirroring the code block's handle;
        //   top-RIGHT — "</>" switch-to-code, then interact.
        const left = createControlGroup("left");
        const collapse = createIconHandle(ICON_COLLAPSE, "Drag to move · click to collapse");
        wireDragCollapse(collapse, {
            onCollapse: () => opts.onCollapse?.(nodeId),
            onDragStart: () => opts.onDragStart?.(nodeId) ?? false,
            onDragMove: (dx, dy) => opts.onDragMove?.(nodeId, dx, dy),
            onDragEnd: () => opts.onDragEnd?.(nodeId),
        });
        left.appendChild(collapse);
        o.frameBox.appendChild(left);

        const right = createControlGroup("right");
        if (opts.onClose) {
            const code = createIconHandle(ICON_CODE, "Switch to code view");
            code.onclick = () => opts.onClose?.(nodeId);
            right.appendChild(code);
        }
        const interact = createIconHandle(
            ICON_INTERACT,
            "Let the mouse work INSIDE the story (graph pan/zoom won't pass through it while on)",
        );
        const syncInteract = (): void => {
            interact.style.background = o.interactive ? "rgba(78, 201, 176, 0.22)" : "rgba(20, 20, 26, 0.72)";
            interact.style.color = o.interactive ? "#4ec9b0" : "#c2c2cc";
        };
        interact.onclick = () => {
            o.interactive = !o.interactive;
            if (o.iframe) o.iframe.style.pointerEvents = o.interactive ? "auto" : "none";
            syncInteract();
        };
        syncInteract();
        right.appendChild(interact);
        o.frameBox.appendChild(right);

        // The header now holds only the story chips (when >1 story); with
        // a single story it's empty, so drop the bar above the panel.
        o.header.style.display = o.header.childElementCount > 0 ? "flex" : "none";
        // Invalidate cached geometry so this frame's update pass writes
        // the scale transform onto the just-created iframe.
        o.lastX = NaN;
    }

    function update(items: readonly JsxStoryOverlayItem[]): void {
        const seen = new Set<string>();
        for (const item of items) {
            seen.add(item.nodeId);
            let o = overlays.get(item.nodeId);
            if (!o) {
                o = createOverlay();
                overlays.set(item.nodeId, o);
            }

            // Stories resolve whenever the caller's lookup settles
            // (Storybook index fetch + story-file AST fetches, both
            // retried lazily inside getStories).
            if (!o.stories) {
                const found = opts.getStories(item.nodeId);
                if (found && found.length > 0) populate(o, item.nodeId, found);
            }

            // The iframe's layout size follows the overlay's settled
            // size so a resize re-rasterizes the story once, not per
            // frame.
            if (o.iframe && (Math.abs(item.worldW - o.worldW) > 2 || Math.abs(item.worldH - o.worldH) > 2)) {
                o.worldW = item.worldW;
                o.worldH = item.worldH;
                o.iframe.style.width = `${Math.round(item.worldW)}px`;
                o.iframe.style.height = `${Math.round(item.worldH)}px`;
                o.lastX = NaN;
            }

            // Geometry pass — copied from storybookOverlay.ts (see
            // module comment): translate the overlay, then uniformly
            // scale-to-fit + centre the iframe and fade it up as the
            // rect's aspect converges on the story's during the
            // expand/settle animation.
            const x = Math.round(item.x * 10) / 10;
            const y = Math.round(item.y * 10) / 10;
            const w = Math.round(item.w * 10) / 10;
            const h = Math.round(item.h * 10) / 10;
            if (x !== o.lastX || y !== o.lastY || w !== o.lastW || h !== o.lastH) {
                o.lastX = x;
                o.lastY = y;
                o.lastW = w;
                o.lastH = h;
                o.el.style.transform = `translate(${x}px, ${y}px)`;
                o.el.style.width = `${w}px`;
                o.el.style.height = `${h}px`;
                if (o.iframe) {
                    // Reserve a strip at the top for the control handles
                    // so the story sits below them, not under them.
                    const availH = Math.max(1, h - CONTROL_STRIP_H);
                    const sx = w / Math.max(1, o.worldW);
                    const sy = availH / Math.max(1, o.worldH);
                    const s = Math.min(sx, sy);
                    const offX = (w - o.worldW * s) / 2;
                    const offY = CONTROL_STRIP_H + (availH - o.worldH * s) / 2;
                    o.iframe.style.transform = `translate(${offX}px, ${offY}px) scale(${s})`;
                    const ratio = Math.min(sx, sy) / Math.max(sx, sy);
                    o.iframe.style.opacity = String(Math.min(1, ratio * ratio * 1.2));
                }
            }
        }

        for (const [nodeId, o] of overlays) {
            if (seen.has(nodeId)) continue;
            o.el.remove();
            overlays.delete(nodeId);
        }
    }

    function destroy(): void {
        overlays.clear();
        host.remove();
    }

    return {update, destroy};
}
