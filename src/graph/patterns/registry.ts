import {folderGridPattern} from "./folderGrid";
import {forceConnectivityPattern} from "./forceConnectivity";
import {hubSpokePattern} from "./hubSpoke";
import {treemapPattern} from "./treemap";
import type {LayoutPattern} from "./types";

// Registry of available layout patterns, keyed by stable id (the id persisted
// in configs/templates).
export const PATTERN_REGISTRY: Record<string, LayoutPattern> = {
    [folderGridPattern.id]: folderGridPattern,
    [hubSpokePattern.id]: hubSpokePattern,
    [treemapPattern.id]: treemapPattern,
    [forceConnectivityPattern.id]: forceConnectivityPattern,
};

// The id used when a config/template references a pattern that isn't registered
// (e.g. an old or hand-edited template). Degrades gracefully instead of crashing.
export const FALLBACK_PATTERN_ID = folderGridPattern.id;

export function getPattern(id: string): LayoutPattern {
    return PATTERN_REGISTRY[id] ?? PATTERN_REGISTRY[FALLBACK_PATTERN_ID];
}

export function listPatterns(): LayoutPattern[] {
    return Object.values(PATTERN_REGISTRY);
}
