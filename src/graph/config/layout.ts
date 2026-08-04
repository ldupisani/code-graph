import {getPattern} from "../patterns/registry";
import type {LayoutConfig, LayoutSettings} from "./types";

// Accessors for LayoutConfig.byPattern.
//
// Kept OUT of defaults.ts deliberately: defaults.ts must not import the pattern
// registry (registry → folderGrid → graph/layout is a fat dependency chain, and
// defaults.ts is imported by sanitize.ts which the registry side already pulls
// in). So a default config ships `byPattern: {}` and every read goes through
// here, filling from the pattern's own defaults() on demand.

export function defaultSettingsFor(patternId: string): LayoutSettings {
    return {params: getPattern(patternId).defaults(), flipX: false, flipY: false};
}

// The active pattern's settings, materialised. Never returns undefined — an
// untuned pattern reads as its defaults.
export function layoutSettingsFor(layout: LayoutConfig, patternId: string = layout.patternId): LayoutSettings {
    return layout.byPattern[patternId] ?? defaultSettingsFor(patternId);
}
