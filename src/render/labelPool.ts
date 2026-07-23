import {Text, type Container} from "pixi.js";

export interface LabelRequest {
    text: string;
    worldX: number;
    worldY: number;
    color: number;
    size: number;
    anchorX?: number;
    anchorY?: number;
    // Multiplier applied to the label's own scale. Pass `1/cameraScale` to
    // counteract the world container's zoom and keep the rasterized text
    // constant on screen regardless of how far in/out the user has zoomed.
    scale?: number;
    // Optional outline color + width (Pixi Text stroke). Lets a label
    // read against a busy backdrop — e.g. a file-name floating above
    // a cluster of file icons — by drawing a dark halo around each
    // glyph. Width is in canvas pixels (not screen px); a value of
    // ~3 px gives a visible halo at typical font sizes.
    stroke?: {color: number; width: number};
    // Optional per-instance opacity (default 1). Unlike `color`, this is
    // NOT part of the pool key — it's a display-object property (like
    // position / scale / visibility) that's safe to mutate per frame, so
    // the same text/size/color can render at different alphas without
    // fragmenting the pool. Used to sink focus-dimmed file names behind
    // the live scene instead of keeping every label at full weight.
    alpha?: number;
}

// Per-key POOL of Text instances. Each key owns an array; each put()
// during a frame consumes the next entry, creating one on demand. At
// endFrame, any entry not consumed this frame is hidden.
//
// Why a pool per key, not a single Text per key: the same string is
// often drawn at MANY rect positions in a single frame (e.g. nine
// `''` string-literal values in a constructor, or every `i` /
// `value` / `id` identifier). A one-Text-per-key cache made all of
// them fight over the same instance — only the LAST put per key
// survived, leaving the rest invisible.
//
// Style mutation is still avoided (Pixi v8 bug — see the original
// returnTexture note below). Each Text in the pool is created with
// its style at construction time; only position / scale / visibility
// are touched per frame. New keys allocate a new pool array; growth
// within an existing pool also allocates a fresh Text per entry.
//
// We don't LRU-evict pool entries individually — they're cheap to
// hold onto, and freeing one mid-pool would just be re-allocated
// next time the same string appears that many times. The whole pool
// for a key can be dropped if the key hasn't been seen for many
// frames (TODO if memory becomes a real concern).
export class LabelPool {
    private parent: Container;
    // Per-key list of all Text instances ever created for that key.
    private pool: Map<string, Text[]> = new Map();
    // Per-key index of the next slot to consume THIS frame. Reset at
    // beginFrame. A put() reads the index, grabs (or creates) that
    // slot, and bumps the index.
    private cursor: Map<string, number> = new Map();

    constructor(parent: Container) {
        this.parent = parent;
    }

    beginFrame(): void {
        this.cursor.clear();
    }

    put(req: LabelRequest): void {
        // Key on text + size + color + stroke so any combination of
        // those gets its OWN Text class (style mutations after
        // construction hit Pixi v8's broken returnTexture path).
        const strokeKey = req.stroke ? `${req.stroke.color.toString(16)}/${req.stroke.width}` : "";
        const key = `${req.text}|${req.size}|${req.color.toString(16)}|${strokeKey}`;
        let bucket = this.pool.get(key);
        if (!bucket) {
            bucket = [];
            this.pool.set(key, bucket);
        }
        const i = this.cursor.get(key) ?? 0;
        let label = bucket[i];
        if (!label) {
            label = new Text({
                text: req.text,
                style: {
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: req.size,
                    fill: req.color,
                    ...(req.stroke
                        ? {
                              stroke: {
                                  color: req.stroke.color,
                                  width: req.stroke.width,
                                  join: "round" as const,
                              },
                          }
                        : {}),
                },
            });
            label.eventMode = "none";
            this.parent.addChild(label);
            bucket.push(label);
        }
        this.cursor.set(key, i + 1);
        label.anchor.set(req.anchorX ?? 0.5, req.anchorY ?? 0.5);
        label.position.set(req.worldX, req.worldY);
        const s = req.scale ?? 1;
        label.scale.set(s);
        label.alpha = req.alpha ?? 1;
        label.visible = true;
    }

    endFrame(): void {
        // Hide every Text past the per-key consumed cursor — those are
        // pool entries that existed but weren't claimed by any put()
        // this frame, e.g. a key whose count dropped from 9 to 5.
        for (const [key, bucket] of this.pool) {
            const used = this.cursor.get(key) ?? 0;
            for (let i = used; i < bucket.length; i++) {
                bucket[i].visible = false;
            }
        }
    }

    destroy(): void {
        // Same workaround as before: don't call Text.destroy explicitly.
        // The caller is always tearing down the whole Pixi app right
        // after this (app.destroy(true, { children: true, texture: true
        // })), which recursively destroys our parent container and every
        // Text in it through a different code path that doesn't trip the
        // v8 returnTexture pool bug.
        this.pool.clear();
        this.cursor.clear();
    }
}
