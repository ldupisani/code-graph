import type {Application, Container, FederatedPointerEvent} from "pixi.js";
import type {SimFileNode} from "../graph/types";
import type {HitRect} from "./hitTest";

export interface CameraDeps {
    app: Application;
    world: Container;
    container: HTMLDivElement;
    getCameraScale: () => number;
    setCameraScale: (s: number) => void;
    hitTest: (wx: number, wy: number) => HitRect | null;
    // `shiftKey` is the modifier state read straight off the pointer-down event
    // that began this click (see `shiftDown`), NOT a separately key-tracked
    // flag — so it can't get stuck true when a Shift keyup is missed (window
    // blur / focus steal), which would otherwise turn every plain click into an
    // additive multi-select.
    onClick: (target: HitRect | null, shiftKey: boolean) => void;
    // Called whenever the (non-dragging) cursor moves over a new target.
    // `null` means the cursor moved off any hit-tested rect. Used by the
    // renderer to highlight collapsed Block cells under the cursor and to
    // flip container.style.cursor between 'grab' and 'pointer'.
    onHover: (target: HitRect | null) => void;
    // Called when the user takes manual camera control (drag-pan or zoom) so an
    // in-progress auto-pan/follow can bow out.
    onUserCameraMove: () => void;
    // World point the next wheel-zoom should keep ANCHORED at the
    // cursor's screen position. Returning a point makes that point
    // stay centred under the cursor as the user scrolls — instead of
    // the default 'whatever world point was currently under the
    // cursor stays under the cursor'. Returning null falls back to
    // the cursor-pivot behaviour. The cursor's current world position
    // is passed in so the host can pick a sensible pivot (e.g. the
    // nearest file) when the cursor isn't on anything specific.
    getZoomPivot?: (cursorWorld: {x: number; y: number}) => {worldX: number; worldY: number} | null;
    // File-drag protocol. Called the moment the user crosses the
    // DRAG_DEADZONE while pointer-down is on a file HitRect. If
    // `onFileDragStart` returns a SimFileNode, wireCamera switches
    // to file-drag mode for the rest of the gesture (no camera pan,
    // no click on release). Returning null falls through to the
    // normal camera-pan behaviour.
    //
    // `onFileDragMove` is called every pointermove with the desired
    // world position of the file (computed delta-style so the
    // file's grab-point under the cursor is preserved). The host
    // mutates sim.x / sim.y / sim.connX / sim.connY / sim.fx /
    // sim.fy / sim.offX / sim.offY and may bump simulation alpha.
    //
    // `onFileDragEnd` fires on pointerup; the host marks the file
    // userPinned and reheats so neighbours settle.
    onFileDragStart?: (id: string) => SimFileNode | null;
    onFileDragMove?: (sim: SimFileNode, worldX: number, worldY: number) => void;
    onFileDragEnd?: (sim: SimFileNode) => void;
    // Folder-drag protocol. Called when the user moves past the
    // drag deadzone while pointer-down on a 'folder' HitRect
    // (a directory-hull label). The host resolves the folder dir
    // → file list and returns it; wireCamera then translates every
    // member by the same delta on each pointermove (via the
    // per-file onFileDragMove) and finalises every pin on
    // pointerup (via onFileDragEnd). Returning null falls through
    // to camera pan.
    onFolderDragStart?: (folderId: string) => SimFileNode[] | null;
    // Overlay-drag protocol. Called when the user moves past the deadzone while
    // pointer-down on an 'ast-toggle' HitRect (an expanded block's close handle).
    // `onOverlayDragStart` returns true to take over the gesture as an overlay
    // move (no camera pan, no click/collapse on release). `onOverlayDragMove`
    // gets the cumulative world-space delta from the grab point each pointermove;
    // the host repositions the overlay relative to its origin. `onOverlayDragEnd`
    // fires on release.
    onOverlayDragStart?: (id: string) => boolean;
    onOverlayDragMove?: (id: string, dx: number, dy: number) => void;
    onOverlayDragEnd?: (id: string) => void;
    // Selection-group drag. When SHIFT+drag STARTS on a file HitRect, the host
    // returns the sims of every currently-selected file (plus the grabbed one);
    // wireCamera then moves them all by the same delta and pins each on release
    // — reusing the folder-drag fan-out. Returning null/empty falls through to
    // the marquee. This is what makes a shift+drag on a file move the whole
    // selected group rather than draw a box.
    onSelectionDragStart?: (fileId: string) => SimFileNode[] | null;
    // Marquee (shift+drag on empty space / non-file) protocol. The gesture
    // becomes a rubber-band selection. `onMarqueeMove` fires every pointermove
    // with the current box in SCREEN coords (the host draws it); `onMarqueeEnd`
    // fires on release with the final box (the host selects the files inside it,
    // additively). No click fires on release.
    onMarqueeMove?: (rect: {x: number; y: number; w: number; h: number}) => void;
    onMarqueeEnd?: (rect: {x: number; y: number; w: number; h: number}) => void;
}

export function wireCamera(deps: CameraDeps): () => void {
    const {app, world, container, setCameraScale, hitTest, onClick, onHover} = deps;
    const {onUserCameraMove} = deps;
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;

    const DRAG_DEADZONE = 4;
    let dragging = false;
    let pointerStart = {x: 0, y: 0};
    let worldStart = {x: 0, y: 0};
    let movedDistance = 0;
    let pendingTarget: HitRect | null = null;
    // File-drag state. When the pointer crosses DRAG_DEADZONE on a
    // file HitRect and the host accepts via onFileDragStart, the
    // gesture stops being a camera pan and becomes a file move.
    // draggingFile non-null = we're in file-drag mode; the camera
    // pan branch in onMove is skipped, and the click branch in onUp
    // is skipped.
    let draggingFile: SimFileNode | null = null;
    // World coords where the pointer was when this gesture began.
    // Combined with the file's sim position at down (dragFileStart),
    // we move the file by the same delta the cursor has travelled —
    // so whatever point on the icon the user grabbed stays under the
    // cursor (no snap-to-center jitter).
    let downWorld = {x: 0, y: 0};
    let dragFileStart = {x: 0, y: 0};
    // Folder-drag state. When the user crosses the deadzone on a
    // 'folder' HitRect and the host returns a non-empty member
    // list, we drag every member by the same world-space delta.
    // The per-file START positions are snapshotted at drag-start so
    // the move math stays delta-based (file's grab-point under the
    // cursor) instead of accumulating per-frame jitter.
    let draggingFolder: {sim: SimFileNode; startX: number; startY: number}[] | null = null;
    // Overlay-drag state. Non-null = we're moving an expanded block's overlay
    // (its id). The camera-pan branch and the click/collapse branch are skipped.
    let draggingOverlay: string | null = null;
    // Marquee state. True once a shift+drag crosses the deadzone; the pan /
    // file-drag / click branches are all skipped. `shiftDown` snapshots the
    // modifier at pointer-down so the gesture's intent is fixed at its start.
    let draggingMarquee = false;
    let shiftDown = false;
    let marqueeRect = {x: 0, y: 0, w: 0, h: 0};

    const screenToWorld = (sx: number, sy: number) => ({
        x: (sx - world.x) / world.scale.x,
        y: (sy - world.y) / world.scale.y,
    });

    // Normalised box (positive w/h) from the pointer-down origin to the
    // current screen position.
    const marqueeFrom = (gx: number, gy: number) => ({
        x: Math.min(pointerStart.x, gx),
        y: Math.min(pointerStart.y, gy),
        w: Math.abs(gx - pointerStart.x),
        h: Math.abs(gy - pointerStart.y),
    });

    const onDown = (e: FederatedPointerEvent) => {
        const w = screenToWorld(e.global.x, e.global.y);
        pendingTarget = hitTest(w.x, w.y);
        dragging = true;
        movedDistance = 0;
        pointerStart = {x: e.global.x, y: e.global.y};
        worldStart = {x: world.x, y: world.y};
        downWorld = {x: w.x, y: w.y};
        draggingFile = null;
        draggingFolder = null;
        draggingOverlay = null;
        draggingMarquee = false;
        shiftDown = e.shiftKey === true;
        container.style.cursor = "grabbing";
    };

    let lastHoverId: string | null = null;
    const onMove = (e: FederatedPointerEvent) => {
        if (dragging) {
            const dx = e.global.x - pointerStart.x;
            const dy = e.global.y - pointerStart.y;
            movedDistance = Math.max(movedDistance, Math.hypot(dx, dy));

            // Shift+drag is decided before everything else so it wins over the
            // normal file/folder/overlay/pan paths. Starting on a FILE moves the
            // whole selected group (and pins it); starting anywhere else draws a
            // marquee. Engages once past the deadzone.
            if (
                movedDistance > DRAG_DEADZONE &&
                !draggingMarquee &&
                draggingFile === null &&
                draggingFolder === null &&
                draggingOverlay === null &&
                shiftDown
            ) {
                if (pendingTarget?.kind === "file" && deps.onSelectionDragStart) {
                    const sims = deps.onSelectionDragStart(pendingTarget.fileId);
                    if (sims && sims.length > 0) {
                        // Snapshot starts so the move math stays delta-based —
                        // exactly the folder-drag group path.
                        draggingFolder = sims.map((sim) => ({sim, startX: sim.x, startY: sim.y}));
                        onUserCameraMove();
                        pendingTarget = null;
                    }
                }
                if (!draggingFolder && deps.onMarqueeEnd) {
                    draggingMarquee = true;
                    pendingTarget = null; // no click/collapse on release
                    onUserCameraMove();
                    container.style.cursor = "crosshair";
                }
            }

            // Past the deadzone for the first time: decide what kind
            // of drag this is. If the pointer-down landed on a FILE
            // or FOLDER HitRect and the host accepts the drag-start
            // callback, we switch to that drag mode for the rest of
            // the gesture. Otherwise it's a camera pan (existing
            // path).
            if (
                movedDistance > DRAG_DEADZONE &&
                !draggingMarquee &&
                draggingFile === null &&
                draggingFolder === null &&
                draggingOverlay === null &&
                pendingTarget !== null
            ) {
                if (pendingTarget.kind === "ast-toggle" && deps.onOverlayDragStart) {
                    // Grabbed an expanded block's close handle and moved — take
                    // over as an overlay move (so the click branch won't collapse).
                    if (deps.onOverlayDragStart(pendingTarget.id)) {
                        draggingOverlay = pendingTarget.id;
                        onUserCameraMove();
                        pendingTarget = null;
                    }
                } else if (pendingTarget.kind === "file" && deps.onFileDragStart) {
                    const sim = deps.onFileDragStart(pendingTarget.fileId);
                    if (sim) {
                        draggingFile = sim;
                        dragFileStart = {x: sim.x, y: sim.y};
                        onUserCameraMove();
                        pendingTarget = null;
                    }
                } else if (pendingTarget.kind === "folder" && deps.onFolderDragStart) {
                    const sims = deps.onFolderDragStart(pendingTarget.id);
                    if (sims && sims.length > 0) {
                        // Snapshot each member's start position so
                        // the per-pointermove math is purely
                        // delta-based — none of "the file is now
                        // wherever it ended up last frame, plus the
                        // delta" jitter that would accumulate if we
                        // recomputed from current sim positions.
                        draggingFolder = sims.map((sim) => ({
                            sim,
                            startX: sim.x,
                            startY: sim.y,
                        }));
                        onUserCameraMove();
                        pendingTarget = null;
                    }
                }
                if (!draggingFile && !draggingFolder && !draggingOverlay) {
                    // Not a file/folder/overlay drag — commit to camera pan
                    // and forget the pending click target so onUp
                    // won't mis-fire onClick at the end of the
                    // gesture.
                    pendingTarget = null;
                    onUserCameraMove();
                }
            }

            if (draggingMarquee) {
                marqueeRect = marqueeFrom(e.global.x, e.global.y);
                deps.onMarqueeMove?.(marqueeRect);
            } else if (draggingOverlay) {
                // Move the overlay by the cumulative world-space delta from the
                // grab point; the host adds it to the overlay's origin.
                const w = screenToWorld(e.global.x, e.global.y);
                deps.onOverlayDragMove?.(draggingOverlay, w.x - downWorld.x, w.y - downWorld.y);
            } else if (draggingFile) {
                // Move the file by the same world-space delta the
                // cursor has travelled — preserves the grab point.
                const w = screenToWorld(e.global.x, e.global.y);
                const nx = dragFileStart.x + (w.x - downWorld.x);
                const ny = dragFileStart.y + (w.y - downWorld.y);
                deps.onFileDragMove?.(draggingFile, nx, ny);
            } else if (draggingFolder) {
                // Translate every member by the same world-space
                // delta. Reuses the existing per-file move callback
                // — folder drag is just a fan-out, the host's
                // file-move logic is unchanged.
                const w = screenToWorld(e.global.x, e.global.y);
                const dxw = w.x - downWorld.x;
                const dyw = w.y - downWorld.y;
                for (const m of draggingFolder) {
                    deps.onFileDragMove?.(m.sim, m.startX + dxw, m.startY + dyw);
                }
            } else if (movedDistance > DRAG_DEADZONE) {
                world.x = worldStart.x + dx;
                world.y = worldStart.y + dy;
            }
            return;
        }
        // Hover tracking: only when NOT dragging — during drag the rect under
        // the cursor is moving, so hover is meaningless. Sub-pixel changes
        // would re-hit-test every frame; we de-dupe per HitRect id so the
        // callback only fires when the cursor crosses into / out of a rect.
        const w = screenToWorld(e.global.x, e.global.y);
        const hit = hitTest(w.x, w.y);
        const hitId = hit?.id ?? null;
        if (hitId !== lastHoverId) {
            lastHoverId = hitId;
            onHover(hit);
        }
    };

    const onUp = () => {
        if (draggingMarquee) {
            // Commit the rubber-band selection (host adds the files inside the
            // box). No click fires — this was a selection gesture, not a click.
            deps.onMarqueeEnd?.(marqueeRect);
            draggingMarquee = false;
        } else if (draggingOverlay) {
            // Overlay-drag end: the overlay keeps its new offset; no click, so
            // the close handle isn't triggered (a plain click still collapses).
            deps.onOverlayDragEnd?.(draggingOverlay);
            draggingOverlay = null;
        } else if (draggingFile) {
            // File-drag end: finalise the pin on the host side.
            // Skip the click path entirely — the user repositioned
            // a file, they didn't click it.
            deps.onFileDragEnd?.(draggingFile);
            draggingFile = null;
        } else if (draggingFolder) {
            // Folder-drag end: fan out the per-file finalise across
            // every member. onFileDragEnd marks userPinned and bumps
            // sim alpha once per call; alpha-bumping is idempotent
            // (it max-clamps to 0.6) so the redundant calls are
            // harmless.
            for (const m of draggingFolder) {
                deps.onFileDragEnd?.(m.sim);
            }
            draggingFolder = null;
        } else if (dragging && movedDistance < DRAG_DEADZONE) {
            onClick(pendingTarget, shiftDown);
        }
        dragging = false;
        pendingTarget = null;
        container.style.cursor = "grab";
    };

    app.stage.on("pointerdown", onDown);
    app.stage.on("pointermove", onMove);
    app.stage.on("pointerup", onUp);
    app.stage.on("pointerupoutside", onUp);

    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        onUserCameraMove();
        const rect = container.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        // Normalise the delta across devices: some report LINES (deltaMode 1)
        // or PAGES (2) instead of pixels, which would make zoom crawl. Convert
        // to a pixel-equivalent first.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? container.clientHeight || 800 : 1;
        const factor = Math.exp(-e.deltaY * unit * 0.0015);
        const next = clamp(world.scale.x * factor, 0.05, 32);
        const cursorWorld = screenToWorld(px, py);
        const pivot = deps.getZoomPivot?.(cursorWorld) ?? null;
        if (pivot) {
            // Map this world point to the cursor's screen position at
            // the new scale — the hovered file (or whatever the host
            // chose) ends up centred under the cursor and stays there
            // across the zoom.
            world.x = px - pivot.worldX * next;
            world.y = py - pivot.worldY * next;
        } else {
            // Default: keep whatever world point is currently under the
            // cursor at that same screen position.
            const k = next / world.scale.x;
            world.x = px - (px - world.x) * k;
            world.y = py - (py - world.y) * k;
        }
        world.scale.set(next);
        setCameraScale(next);
    };
    container.addEventListener("wheel", onWheel, {passive: false});

    return () => {
        app.stage.off("pointerdown", onDown);
        app.stage.off("pointermove", onMove);
        app.stage.off("pointerup", onUp);
        app.stage.off("pointerupoutside", onUp);
        container.removeEventListener("wheel", onWheel);
    };
}

export function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}
