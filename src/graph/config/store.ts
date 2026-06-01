import {create} from "zustand";
import {persist} from "zustand/middleware";
import {getPattern} from "../patterns/registry";
import {CONFIG_VERSION, makeDefaultConfig} from "./defaults";
import {BUILTIN_PRESETS} from "./presets";
import {parseTemplateFile, sanitizeConfig, serializeTemplate, type Template} from "./templates";
import type {DeepPartial, GraphConfig, LayoutTier} from "./types";

// ---------------------------------------------------------------------------
// useConfigStore — holds the LIVE GraphConfig the renderer reads each frame,
// plus saved templates. Persisted to localStorage (config + user templates);
// built-in presets are injected at hydrate, never persisted.
//
// Kept SEPARATE from useGraphStore (the hot project/selection store) so config
// edits don't churn the project store and persistence is isolated. The renderer
// subscribes here and mirrors `config` into a ref, so edits update the canvas
// live without a rebuild.
// ---------------------------------------------------------------------------

export interface ConfigStore {
    config: GraphConfig;
    templates: Template[];
    activeTemplateId: string | null;

    setConfig: (patch: DeepPartial<GraphConfig>) => void;
    replaceConfig: (config: GraphConfig) => void;

    // Tier operations (settings UI).
    addTier: () => void;
    removeTier: (id: string) => void;
    moveTier: (id: string, dir: -1 | 1) => void;
    updateTier: (id: string, patch: Partial<Pick<LayoutTier, "name" | "zoomFromMul" | "zoomToMul" | "flipX" | "flipY">>) => void;
    setTierPattern: (id: string, patternId: string) => void;
    setTierParam: (id: string, key: string, value: number | boolean | string) => void;

    // Template operations.
    saveTemplate: (name: string) => void;
    loadTemplate: (id: string) => void;
    deleteTemplate: (id: string) => void;
    exportTemplate: (id: string) => string | null;
    importTemplate: (json: string) => {ok: boolean; error?: string};
}

let seq = 0;
function uid(prefix: string): string {
    seq += 1;
    return `${prefix}-${seq}-${(seq * 2654435761) % 1000000}`;
}

// structuredClone preserves Infinity (zoomToMul); JSON would turn it to null.
function clone<T>(v: T): T {
    return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

function builtinTemplates(): Template[] {
    return BUILTIN_PRESETS.map((p) => ({id: p.id, name: p.name, builtin: true, config: p.build()}));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: makeDefaultConfig(),
            templates: builtinTemplates(),
            activeTemplateId: null,

            setConfig: (patch) => set((s) => ({config: mergeConfig(s.config, patch), activeTemplateId: null})),
            replaceConfig: (config) => set(() => ({config: {...config, version: config.version + 1}})),

            addTier: () =>
                set((s) => {
                    const tiers = s.config.tiers.slice();
                    const finest = tiers[tiers.length - 1];
                    tiers.push({
                        id: uid("tier"),
                        name: `Tier ${tiers.length + 1}`,
                        zoomFromMul: finest ? finest.zoomFromMul : 1,
                        zoomToMul: finest ? finest.zoomToMul : Infinity,
                        patternId: "folder-grid",
                        params: getPattern("folder-grid").defaults(),
                    });
                    return {config: bump(s.config, {tiers}), activeTemplateId: null};
                }),
            removeTier: (id) =>
                set((s) => {
                    if (s.config.tiers.length <= 1) return s;
                    return {config: bump(s.config, {tiers: s.config.tiers.filter((t) => t.id !== id)}), activeTemplateId: null};
                }),
            moveTier: (id, dir) =>
                set((s) => {
                    const tiers = s.config.tiers.slice();
                    const i = tiers.findIndex((t) => t.id === id);
                    const j = i + dir;
                    if (i < 0 || j < 0 || j >= tiers.length) return s;
                    [tiers[i], tiers[j]] = [tiers[j], tiers[i]];
                    return {config: bump(s.config, {tiers}), activeTemplateId: null};
                }),
            updateTier: (id, patch) =>
                set((s) => ({config: bump(s.config, {tiers: s.config.tiers.map((t) => (t.id === id ? {...t, ...patch} : t))}), activeTemplateId: null})),
            setTierPattern: (id, patternId) =>
                set((s) => ({
                    config: bump(s.config, {
                        tiers: s.config.tiers.map((t) => (t.id === id ? {...t, patternId, params: getPattern(patternId).defaults()} : t)),
                    }),
                    activeTemplateId: null,
                })),
            setTierParam: (id, key, value) =>
                set((s) => ({
                    config: bump(s.config, {
                        tiers: s.config.tiers.map((t) => (t.id === id ? {...t, params: {...t.params, [key]: value}} : t)),
                    }),
                    activeTemplateId: null,
                })),

            saveTemplate: (name) =>
                set((s) => {
                    const id = uid("tmpl");
                    const template: Template = {id, name: name.trim() || "Untitled", config: clone(s.config)};
                    return {templates: [...s.templates, template], activeTemplateId: id};
                }),
            loadTemplate: (id) =>
                set((s) => {
                    const t = s.templates.find((x) => x.id === id);
                    if (!t) return s;
                    // Normalize so a template saved before a config field existed
                    // (e.g. theme.edgeStyle) gets that field filled from defaults
                    // rather than dropping it from the live config.
                    return {config: {...sanitizeConfig(t.config), version: s.config.version + 1}, activeTemplateId: id};
                }),
            deleteTemplate: (id) =>
                set((s) => {
                    const t = s.templates.find((x) => x.id === id);
                    if (!t || t.builtin) return s;
                    return {
                        templates: s.templates.filter((x) => x.id !== id),
                        activeTemplateId: s.activeTemplateId === id ? null : s.activeTemplateId,
                    };
                }),
            exportTemplate: (id) => {
                const t = get().templates.find((x) => x.id === id);
                return t ? serializeTemplate(t) : null;
            },
            importTemplate: (json) => {
                const parsed = parseTemplateFile(json);
                if (!parsed.ok) return {ok: false, error: parsed.error};
                const id = uid("tmpl");
                set((s) => ({
                    templates: [...s.templates, {id, name: parsed.name, config: parsed.config}],
                    config: {...parsed.config, version: s.config.version + 1},
                    activeTemplateId: id,
                }));
                return {ok: true};
            },
        }),
        {
            name: "code-graph:config",
            version: CONFIG_VERSION,
            // Persist only the live config + USER templates; built-ins are
            // injected fresh on hydrate so preset updates ship in code.
            partialize: (s) => ({
                config: s.config,
                templates: s.templates.filter((t) => !t.builtin),
                activeTemplateId: s.activeTemplateId,
            }),
            // Old/foreign persisted state passes through to merge, which
            // sanitizes the config (fills missing fields, repoints unknown
            // patterns) so a stale schema can't crash the renderer.
            migrate: (persisted) => persisted as never,
            merge: (persisted, current) => {
                const p = (persisted ?? {}) as Partial<ConfigStore>;
                // Normalize each saved template's config too, so fields added
                // after a template was saved are filled in (and re-persisted).
                const userTemplates = Array.isArray(p.templates)
                    ? p.templates.filter((t) => t && !t.builtin).map((t) => ({...t, config: sanitizeConfig(t.config)}))
                    : [];
                return {
                    ...current,
                    config: p.config ? sanitizeConfig(p.config) : current.config,
                    templates: [...builtinTemplates(), ...userTemplates],
                    activeTemplateId: typeof p.activeTemplateId === "string" ? p.activeTemplateId : null,
                };
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
        tiers: (patch.tiers as GraphConfig["tiers"]) ?? cur.tiers,
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
