// Storybook-in-the-graph: when an expanded file is a *.stories.* file
// and a Storybook dev server is reachable on :6006, a live story
// iframe fills the file's expanded rect — the component rendered where
// its stories live in the graph. The layer is plain imperative DOM
// (like the rest of the renderer): PixiCanvas calls update() from its
// ticker with this frame's screen rects, and the layer reconciles a
// host <div> of per-file overlays without involving React at 60fps.
//
// Coordinates: PixiCanvas hands us rects in CONTAINER space (the div
// hosting the canvas — world.x + worldPos·scale, no client offsets),
// and the host div is appended to that same container, so positioning
// is a straight translate().
//
// Sizing: the embedded preview's withCanvasFrame decorator
// (.storybook/decorators.tsx) posts its story frame size up via
// postMessage ("code-graph:story-size"); the layer matches the event
// to an overlay's iframe and forwards it through opts.onMeasure so
// PixiCanvas can shrink/grow the file's expanded rect to the story's
// real content. Foreign storybooks that don't post simply keep the
// default size.
//
// Interactivity: the iframe defaults to pointer-events:none so the
// graph's pan / zoom / click still work straight through the story.
// The header bar (story-variant chips + "interact" toggle + ✕) floats
// just above the panel and is always clickable; toggling "interact"
// arms the iframe for real mouse work inside the component at the
// cost of the graph not seeing those events until toggled back.

export function isStoryFile(relativePath: string): boolean {
    return /\.stories\.[jt]sx?$/.test(relativePath);
}

export interface StoryEntry {
    id: string;
    name: string;
}

// Where the story iframes load from. The index fetch goes through the
// vite proxy (/sb-index) instead so it dodges CORS.
const SB_ORIGIN = "http://localhost:6006";
const INDEX_RETRY_MS = 10_000;
const HEADER_H = 24;
// Top inset (screen px) the story content is pushed down by, leaving a
// clear strip for the interact/close handles so they don't sit over the
// story. The strip stays part of the pointer-transparent frameBox, so
// grabbing it still drags the block through to the canvas.
const CONTROL_STRIP_H = 28;
// Don't bother below this on-screen size — the story would be a stamp.
export const STORY_OVERLAY_MIN_SIDE_PX = 90;

// relativePath -> stories, from Storybook's index.json importPath
// entries ('./src/ui/Pill.stories.tsx'). null until a fetch succeeds.
let indexByPath: Map<string, StoryEntry[]> | null = null;
let indexFetchInFlight = false;
let lastIndexAttempt = 0;
// True once an index fetch has FAILED and no later one has succeeded —
// i.e. the Storybook dev server is (still) unreachable. Consumers use
// this to fall back to the normal AST visualization instead of an
// empty embed; the throttled retry keeps probing so the embed comes
// back when the server does.
let indexFetchFailed = false;

export function storybookIndexDown(): boolean {
    return indexByPath === null && indexFetchFailed;
}

// Story chosen per file, surviving collapse/re-expand and rebuilds.
const selectedStoryByFile = new Map<string, string>();

// null = index not loaded (Storybook down or first fetch in flight);
// [] = index loaded, no stories registered for this path.
function storiesFor(relativePath: string): StoryEntry[] | null {
    if (!indexByPath) {
        ensureIndex();
        return null;
    }
    return indexByPath.get(relativePath) ?? [];
}

// Shared lookups for the JSX preview overlay's story-aware mode (see
// htmlPreviewOverlay.ts) — same index cache, same lazy fetch/retry.
export function storiesForPath(relativePath: string): StoryEntry[] | null {
    return storiesFor(relativePath);
}

export function storyIframeUrl(storyId: string): string {
    return `${SB_ORIGIN}/iframe.html?viewMode=story&id=${encodeURIComponent(storyId)}`;
}

// Inline glyphs for the in-panel control handles. stroke=currentColor
// so the wrapping button's `color` drives them — same thin-outline feel
// as the Pixi eye handle, kept crisp at any size since they're SVG.
export const ICON_INTERACT =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>';
// A minus, matching the app's collapse handle (the ast-toggle handle on
// expanded blocks is a square with a horizontal minus line).
export const ICON_COLLAPSE =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>';
// "</>" — switch the live story back to the code view.
export const ICON_CODE =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>';

// A small square icon handle that floats INSIDE the story panel's
// top-right corner — the DOM counterpart of the eye handle drawn on a
// JSX block (PixiCanvas), replacing the old text controls that sat in
// the header above the panel.
export function createIconHandle(svg: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.innerHTML = svg;
    Object.assign(b.style, {
        appearance: "none",
        border: "0",
        borderRadius: "6px",
        width: "20px",
        height: "20px",
        padding: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        background: "rgba(20, 20, 26, 0.72)",
        color: "#c2c2cc",
        flexShrink: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    return b;
}

// Wires a handle so a DRAG repositions the panel and a plain CLICK
// collapses it — exactly the dual role of the code block's collapse
// handle. Deltas are reported in SCREEN px from the gesture start; the
// caller converts to world space and feeds the same drag-offset
// mechanism the canvas handle uses (so the connector line back to the
// origin comes for free). onDragStart returning false vetoes the drag
// (e.g. the block isn't expanded), leaving the gesture a click.
export interface DragCollapseHandlers {
    onDragStart?: () => boolean;
    onDragMove?: (dx: number, dy: number) => void;
    onDragEnd?: () => void;
    onCollapse?: () => void;
}
export function wireDragCollapse(handle: HTMLElement, h: DragCollapseHandlers): void {
    let startX = 0;
    let startY = 0;
    let dragging = false;
    handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startY = e.clientY;
        dragging = false;
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 3) dragging = h.onDragStart?.() ?? true;
        if (dragging) h.onDragMove?.(dx, dy);
    });
    const end = (e: PointerEvent): void => {
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        if (dragging) h.onDragEnd?.();
        else h.onCollapse?.();
        dragging = false;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
}

// Holds the icon handles, pinned to a top corner inside the frameBox
// (which clips and is pointer-transparent; the group opts its pointer
// events back in). Collapse sits top-LEFT (the app's convention for the
// collapse handle); interact sits top-RIGHT (where the eye/preview
// handle lives). The space between stays pointer-transparent so dragging
// the panel still moves the file through to the canvas.
export function createControlGroup(side: "left" | "right" = "right"): HTMLDivElement {
    const g = document.createElement("div");
    Object.assign(g.style, {
        position: "absolute",
        top: "4px",
        [side]: "4px",
        display: "flex",
        gap: "4px",
        pointerEvents: "auto",
        zIndex: "2",
    } satisfies Partial<CSSStyleDeclaration>);
    return g;
}

function ensureIndex(): void {
    if (indexFetchInFlight) return;
    const now = Date.now();
    if (now - lastIndexAttempt < INDEX_RETRY_MS) return;
    lastIndexAttempt = now;
    indexFetchInFlight = true;
    void fetch("/sb-index")
        .then(async (res) => {
            if (!res.ok) throw new Error(`index ${res.status}`);
            const idx = (await res.json()) as {
                entries: Record<string, {id: string; name: string; type: string; importPath: string}>;
            };
            const map = new Map<string, StoryEntry[]>();
            for (const e of Object.values(idx.entries)) {
                if (e.type !== "story") continue;
                const p = e.importPath.replace(/^\.\//, "");
                let list = map.get(p);
                if (!list) {
                    list = [];
                    map.set(p, list);
                }
                list.push({id: e.id, name: e.name});
            }
            indexByPath = map;
            indexFetchFailed = false;
        })
        .catch(() => {
            // Storybook not running (or no stories) — stay silent and
            // let the throttle retry while a story file is expanded.
            indexFetchFailed = true;
        })
        .finally(() => {
            indexFetchInFlight = false;
        });
}

export interface StoryOverlayItem {
    fileId: string;
    relativePath: string;
    // The file's expanded rect, container space.
    x: number;
    y: number;
    w: number;
    h: number;
    // The rect's size at camera scale 1 — the iframe's CSS layout
    // size, kept FIXED while zooming so the story never reflows; only
    // the scale transform changes per frame.
    worldW: number;
    worldH: number;
}

interface Overlay {
    el: HTMLDivElement;
    header: HTMLDivElement;
    frameBox: HTMLDivElement;
    iframe: HTMLIFrameElement | null;
    stories: StoryEntry[] | null;
    worldW: number;
    worldH: number;
    interactive: boolean;
    // Last-applied geometry, to skip redundant style writes.
    lastX: number;
    lastY: number;
    lastW: number;
    lastH: number;
}

export interface StoryOverlayOpts {
    // Wired to "deselect this file" — selection drives expansion, so
    // dropping the file from the selection collapses it next frame.
    onClose?: (fileId: string) => void;
    // The embedded story reported its real frame size (world px, i.e.
    // story CSS px). PixiCanvas resizes the file's expanded target.
    onMeasure?: (fileId: string, size: {w: number; h: number}) => void;
}

export interface StoryOverlayLayer {
    update: (items: readonly StoryOverlayItem[]) => void;
    destroy: () => void;
}

export function createStoryOverlayLayer(container: HTMLElement, opts: StoryOverlayOpts = {}): StoryOverlayLayer {
    const host = document.createElement("div");
    // The host itself never intercepts events; each overlay's header
    // (and an armed iframe) opts back in.
    Object.assign(host.style, {
        position: "absolute",
        inset: "0",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: "4",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(host);

    const overlays = new Map<string, Overlay>();

    // Size reports from the embedded previews (see module comment).
    const onMessage = (ev: MessageEvent): void => {
        const data = ev.data as {type?: string; width?: number; height?: number} | null;
        if (!data || data.type !== "code-graph:story-size") return;
        if (typeof data.width !== "number" || typeof data.height !== "number") return;
        for (const [fileId, o] of overlays) {
            if (o.iframe && o.iframe.contentWindow === ev.source) {
                opts.onMeasure?.(fileId, {w: data.width, h: data.height});
                return;
            }
        }
    };
    window.addEventListener("message", onMessage);

    function createOverlay(): Overlay {
        const el = document.createElement("div");
        Object.assign(el.style, {
            position: "absolute",
            left: "0",
            top: "0",
            pointerEvents: "none",
        } satisfies Partial<CSSStyleDeclaration>);

        // The story panel itself: the file's rectangular border. Clips
        // the scaled iframe; the header floats above it.
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
            // Anchored to the panel's TOP edge and growing UPWARD: a
            // file with many stories outruns a narrow panel, and a
            // clipped single row makes interact / ✕ unreachable — wrap
            // into extra rows above instead.
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
            worldW: 0,
            worldH: 0,
            interactive: false,
            lastX: NaN,
            lastY: NaN,
            lastW: NaN,
            lastH: NaN,
        };
    }

    function storyUrl(storyId: string): string {
        return `${SB_ORIGIN}/iframe.html?viewMode=story&id=${encodeURIComponent(storyId)}`;
    }

    // Build the chips + iframe once the index knows this file's stories.
    function populate(o: Overlay, fileId: string, stories: StoryEntry[]): void {
        o.stories = stories;
        const selected = selectedStoryByFile.get(fileId) ?? stories[0].id;
        selectedStoryByFile.set(fileId, selected);

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
        iframe.src = storyUrl(selected);
        o.frameBox.appendChild(iframe);
        o.iframe = iframe;
        o.worldW = 0; // force the size/scale write below

        o.header.textContent = "";
        const chips: HTMLButtonElement[] = [];
        const syncChips = (): void => {
            const cur = selectedStoryByFile.get(fileId);
            for (const c of chips) {
                const on = c.dataset.storyId === cur;
                c.style.background = on ? "rgba(48, 72, 108, 0.95)" : "rgba(44, 44, 52, 0.9)";
                c.style.color = on ? "#eaf2ff" : "#a8a8b2";
            }
        };
        for (const s of stories) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.textContent = s.name;
            chip.dataset.storyId = s.id;
            chip.title = `Show story "${s.name}"`;
            Object.assign(chip.style, {
                appearance: "none",
                border: "0",
                borderRadius: "999px",
                padding: "1px 8px",
                fontFamily: "inherit",
                fontSize: "10px",
                cursor: "pointer",
                flexShrink: "0",
            } satisfies Partial<CSSStyleDeclaration>);
            chip.onclick = () => {
                selectedStoryByFile.set(fileId, s.id);
                if (o.iframe) o.iframe.src = storyUrl(s.id);
                syncChips();
            };
            chips.push(chip);
            o.header.appendChild(chip);
        }

        // Controls as icon handles floating inside the panel's top
        // corners (instead of text controls in the header above the
        // block): collapse [-] top-LEFT, interact top-RIGHT. The header
        // now carries only the story chips.
        if (opts.onClose) {
            const left = createControlGroup("left");
            const collapse = createIconHandle(ICON_COLLAPSE, "Collapse this file (or drag the panel to move it)");
            collapse.onclick = () => opts.onClose?.(fileId);
            left.appendChild(collapse);
            o.frameBox.appendChild(left);
        }

        const right = createControlGroup("right");
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
        syncChips();
        // Invalidate cached geometry so this frame's update pass writes
        // the scale transform onto the just-created iframe even if the
        // camera hasn't moved.
        o.lastX = NaN;
    }

    function update(items: readonly StoryOverlayItem[]): void {
        const seen = new Set<string>();
        for (const item of items) {
            seen.add(item.fileId);
            let o = overlays.get(item.fileId);
            if (!o) {
                o = createOverlay();
                overlays.set(item.fileId, o);
            }

            // Stories arrive whenever the index fetch lands; until then
            // the overlay is just the "storybook…" header. A file whose
            // path has no stories registered keeps the dim header — an
            // honest "nothing to embed" rather than vanishing.
            if (!o.stories) {
                const stories = storiesFor(item.relativePath);
                if (stories && stories.length > 0) populate(o, item.fileId, stories);
            }

            // The iframe's layout size follows the story's measured /
            // target size so a resize re-rasterizes the story once,
            // not per frame.
            if (o.iframe && (Math.abs(item.worldW - o.worldW) > 2 || Math.abs(item.worldH - o.worldH) > 2)) {
                o.worldW = item.worldW;
                o.worldH = item.worldH;
                o.iframe.style.width = `${Math.round(item.worldW)}px`;
                o.iframe.style.height = `${Math.round(item.worldH)}px`;
                o.lastX = NaN;
            }

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
                    // While the rect is easing toward the story's size
                    // (expand animation, snapshot restore) its aspect
                    // doesn't match the story's — width and height ease
                    // at the same rate from different starting points.
                    // Scale uniformly to fit, CENTER the scaled story in
                    // the panel (below the control strip), and fade it up
                    // as the aspects converge, so the transition reads as
                    // a settle rather than content stuck in a corner.
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

        for (const [fileId, o] of overlays) {
            if (seen.has(fileId)) continue;
            o.el.remove();
            overlays.delete(fileId);
        }
    }

    function destroy(): void {
        window.removeEventListener("message", onMessage);
        overlays.clear();
        host.remove();
    }

    return {update, destroy};
}
