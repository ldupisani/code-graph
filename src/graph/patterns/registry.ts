import {folderGridPattern} from "./folderGrid";
import {forceConnectivityPattern} from "./forceConnectivity";
import {hubSpokePattern} from "./hubSpoke";
import {treemapPattern} from "./treemap";
import type {LayoutPattern} from "./types";

// Registry of available layout patterns, keyed by stable id (the id persisted
// in the config, and in every snapshot's copy of it).
export const PATTERN_REGISTRY: Record<string, LayoutPattern> = {
    [folderGridPattern.id]: folderGridPattern,
    [hubSpokePattern.id]: hubSpokePattern,
    [treemapPattern.id]: treemapPattern,
    [forceConnectivityPattern.id]: forceConnectivityPattern,
};

// The id used when a config references a pattern that isn't registered (e.g. a
// snapshot from a build that had one this doesn't, or a hand-edited localStorage
// blob). Degrades gracefully instead of crashing.
export const FALLBACK_PATTERN_ID = folderGridPattern.id;

export function getPattern(id: string): LayoutPattern {
    return PATTERN_REGISTRY[id] ?? PATTERN_REGISTRY[FALLBACK_PATTERN_ID];
}

export function listPatterns(): LayoutPattern[] {
    return Object.values(PATTERN_REGISTRY);
}
