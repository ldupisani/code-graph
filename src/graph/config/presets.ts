import {getPattern} from "../patterns/registry";
import {makeDefaultConfig} from "./defaults";
import type {GraphConfig, LayoutTier} from "./types";

// Built-in, read-only templates. Injected into the template list at store
// hydrate (never persisted) so updates ship in code. A "template" is a full
// GraphConfig; these vary the tier/pattern setup.

export interface BuiltinPreset {
    id: string;
    name: string;
    build: () => GraphConfig;
}

function tier(id: string, name: string, from: number, to: number, patternId: string): LayoutTier {
    return {id, name, zoomFromMul: from, zoomToMul: to, patternId, params: getPattern(patternId).defaults()};
}

// Replace just the overview (static) tier's pattern, keeping the force detail.
function overviewPreset(staticPatternId: string): GraphConfig {
    const cfg = makeDefaultConfig();
    cfg.tiers = [
        tier("tier-overview", "Overview", 0, 4.5, staticPatternId),
        tier("tier-detail", "Detail", 1.5, Infinity, "force-connectivity"),
    ];
    return cfg;
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
    {id: "preset-classic", name: "Classic (folder ⇄ force)", build: () => makeDefaultConfig()},
    {id: "preset-hub", name: "Hub & spoke ⇄ force", build: () => overviewPreset("hub-spoke")},
    {id: "preset-treemap", name: "Treemap ⇄ force", build: () => overviewPreset("treemap")},
    {
        id: "preset-all-force",
        name: "All force (no overview)",
        build: () => {
            const cfg = makeDefaultConfig();
            cfg.tiers = [tier("tier-force", "Force", 0, Infinity, "force-connectivity")];
            return cfg;
        },
    },
];
