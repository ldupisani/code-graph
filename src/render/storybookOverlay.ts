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

        const spacer = document.createElement("span");
        spacer.style.flex = "1";
        o.header.appendChild(spacer);

        const interact = document.createElement("button");
        interact.type = "button";
        interact.textContent = "interact";
        interact.title = "Let the mouse work INSIDE the story (graph pan/zoom won't pass through it while on)";
        Object.assign(interact.style, {
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
        interact.onclick = () => {
            o.interactive = !o.interactive;
            if (o.iframe) o.iframe.style.pointerEvents = o.interactive ? "auto" : "none";
            interact.style.background = o.interactive ? "rgba(78, 201, 176, 0.25)" : "rgba(44, 44, 52, 0.9)";
            interact.style.color = o.interactive ? "#4ec9b0" : "#a8a8b2";
        };
        o.header.appendChild(interact);

        if (opts.onClose) {
            const close = document.createElement("button");
            close.type = "button";
            close.textContent = "✕";
            close.title = "Collapse this file (deselects it)";
            Object.assign(close.style, {
                appearance: "none",
                border: "0",
                borderRadius: "999px",
                width: "16px",
                height: "16px",
                padding: "0",
                lineHeight: "16px",
                fontFamily: "inherit",
                fontSize: "10px",
                cursor: "pointer",
                background: "rgba(70, 40, 44, 0.95)",
                color: "#f0c8c8",
                flexShrink: "0",
            } satisfies Partial<CSSStyleDeclaration>);
            close.onclick = () => opts.onClose?.(fileId);
            o.header.appendChild(close);
        }
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
                    // the panel, and fade it up as the aspects converge,
                    // so the transition reads as a settle rather than
                    // content stuck misaligned in a corner.
                    const sx = w / Math.max(1, o.worldW);
                    const sy = h / Math.max(1, o.worldH);
                    const s = Math.min(sx, sy);
                    const offX = (w - o.worldW * s) / 2;
                    const offY = (h - o.worldH * s) / 2;
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
