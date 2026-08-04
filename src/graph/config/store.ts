import {create} from "zustand";
import {persist} from "zustand/middleware";
import {PATTERN_REGISTRY} from "../patterns/registry";
import {CONFIG_VERSION, makeDefaultConfig} from "./defaults";
import {defaultSettingsFor, layoutSettingsFor} from "./layout";
import {sanitizeConfig} from "./sanitize";
import type {DeepPartial, GraphConfig} from "./types";

// ---------------------------------------------------------------------------
// useConfigStore — holds the LIVE GraphConfig the renderer reads each frame.
// Persisted to localStorage.
//
// This store used to ALSO keep named "templates": whole saved GraphConfigs you
// could load, delete, and export/import as JSON, plus a few built-in presets.
// They're gone — snapshots carry a full GraphConfig now, so a saved view IS a
// saved config, and keeping both meant two ways to store the same thing with
// only one of them tied to what you were actually looking at.
//
// Kept SEPARATE from useGraphStore (the hot project/selection store) so config
// edits don't churn the project store and persistence is isolated. The renderer
// subscribes here and mirrors `config` into a ref, so edits update the canvas
// live without a rebuild.
// ---------------------------------------------------------------------------

export interface ConfigStore {
    config: GraphConfig;

    setConfig: (patch: DeepPartial<GraphConfig>) => void;
    replaceConfig: (config: GraphConfig) => void;

    // Layout operations (LayoutBar + settings UI). Param/flip edits always
    // target the ACTIVE pattern — switching pattern never discards tuning,
    // it just changes which entry of byPattern is in play.
    setLayoutPattern: (patternId: string) => void;
    setLayoutParam: (key: string, value: number | boolean | string) => void;
    setLayoutFlip: (patch: {flipX?: boolean; flipY?: boolean}) => void;
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set) => ({
            config: makeDefaultConfig(),

            setConfig: (patch) => set((s) => ({config: mergeConfig(s.config, patch)})),
            // Swap the whole config (snapshot restore). `version` counts EDITS,
            // so it continues from the store's current value — taking it from
            // the incoming config instead would rewind the counter, and after
            // sanitizeConfig (which stamps the SCHEMA version) it would pin to
            // the same number on every restore.
            replaceConfig: (config) => set((s) => ({config: {...config, version: s.config.version + 1}})),

            setLayoutPattern: (patternId) =>
                set((s) => {
                    if (!PATTERN_REGISTRY[patternId] || patternId === s.config.layout.patternId) return s;
                    // Materialise the incoming pattern's settings if it's never
                    // been tuned, so byPattern is a complete record of what the
                    // user has actually visited (and so a snapshot taken right
                    // after a switch carries real values, not an absent key).
                    const byPattern = {...s.config.layout.byPattern};
                    if (!byPattern[patternId]) byPattern[patternId] = defaultSettingsFor(patternId);
                    return {config: bump(s.config, {layout: {patternId, byPattern}})};
                }),
            setLayoutParam: (key, value) =>
                set((s) => {
                    const {patternId} = s.config.layout;
                    const cur = layoutSettingsFor(s.config.layout);
                    const byPattern = {...s.config.layout.byPattern, [patternId]: {...cur, params: {...cur.params, [key]: value}}};
                    return {config: bump(s.config, {layout: {patternId, byPattern}})};
                }),
            setLayoutFlip: (patch) =>
                set((s) => {
                    const {patternId} = s.config.layout;
                    const cur = layoutSettingsFor(s.config.layout);
                    const byPattern = {...s.config.layout.byPattern, [patternId]: {...cur, ...patch}};
                    return {config: bump(s.config, {layout: {patternId, byPattern}})};
                }),

        }),
        {
            name: "code-graph:config",
            version: CONFIG_VERSION,
            // Only the live config persists. Any `templates` / `activeTemplateId`
            // left in an older blob is simply not read, and drops out of storage
            // the first time this writes.
            partialize: (s) => ({config: s.config}),
            // Old/foreign persisted state passes through to merge, which
            // sanitizes the config (fills missing fields, repoints unknown
            // patterns) so a stale schema can't crash the renderer.
            migrate: (persisted) => persisted as never,
            merge: (persisted, current) => {
                const p = (persisted ?? {}) as Partial<ConfigStore>;
                return {...current, config: p.config ? sanitizeConfig(p.config) : current.config};
            },
        },
    ),
);

// --- merge helpers ---------------------------------------------------------

function mergeConfig(cur: GraphConfig, patch: DeepPartial<GraphConfig>): GraphConfig {
    const theme = patch.theme
        ? {
              ...cur.theme,
              ...patch.theme,
              colors: patch.theme.colors ? {...cur.theme.colors, ...patch.theme.colors} : cur.theme.colors,
              semanticEdge: patch.theme.semanticEdge ? {...cur.theme.semanticEdge, ...patch.theme.semanticEdge} : cur.theme.semanticEdge,
          }
        : cur.theme;
    return {
        ...cur,
        ...patch,
        version: cur.version + 1,
        behavioral: patch.behavioral ? {...cur.behavioral, ...patch.behavioral} : cur.behavioral,
        lod: patch.lod ? {...cur.lod, ...patch.lod} : cur.lod,
        theme: theme as GraphConfig["theme"],
        layout: (patch.layout as GraphConfig["layout"]) ?? cur.layout,
    };
}

function bump(cur: GraphConfig, patch: Partial<GraphConfig>): GraphConfig {
    return {...cur, ...patch, version: cur.version + 1};
}

// Dev-only console hook (mirrors useGraphStore): e.g.
//   useConfigStore.getState().setConfig({lod: {cullPx: 20}})
if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as {useConfigStore: typeof useConfigStore}).useConfigStore = useConfigStore;
}
