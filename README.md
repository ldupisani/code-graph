# code-graph

An interactive, zoomable map of a codebase. Point it at a TypeScript or Python
project and it draws every source file as a node, with import, call and
inheritance edges between them. Click into a file and it unfolds into its
syntax tree, laid out so it still reads roughly like the source. You can edit
code from the graph. The view updates live as files change on disk, and
several browser windows can watch the same project together.

The goal is to make a codebase's *shape* legible. You see which files cluster
together, what depends on what, and where calls cross folder boundaries. You
can move from that overview down to a single expression without leaving one
continuous canvas.

## Features

- **Project graph.** Files are nodes, and imports, calls and
  `extends`/`implements` are edges. You can toggle each edge kind on or off
  as a lens.
- **Four file layouts, switchable live.** Folder grid, hub-and-spoke, treemap
  (files weighted by size) and a force-directed connectivity layout.
  Switching crossfades, so you can follow where each file moved.
- **Fractal AST view.** An expanded file shows its top-level statements as a
  force graph of content-sized boxes. Blocks expand into nested overlays.
  Syntax templates draw constructs inline (`for [x] of [items]`,
  `cond ? a : b`, `base[index]`, JSX as attrs | children).
- **Level of detail.** Labels, outlines and edges fade in and out with zoom
  and on-screen edge length, so dense projects stay readable at every scale.
- **Selection and focus.** Multi-select and marquee select, a focus mode that
  narrows or widens by import hops (`[` / `]`), pinning, and ⌘K symbol search.
- **Saved views.** Snapshots store the camera, expansion, selection, filters
  and the full layout/theme config. Press `S` to save one and `1`–`9` to jump
  back.
- **Editing.** A Monaco editor pane opens the selected file. Before a save is
  written, it is dry-run through the analyzer, and a buffer that would break
  analysis is rejected. Writes are guarded by a baseline hash, so a
  concurrent on-disk change surfaces as a conflict instead of being
  overwritten.
- **Live updates.** A file watcher streams incremental `GraphDelta`s over
  SSE. The camera, layout and expansion survive every edit.
- **Presence.** Each window is a session. You can see who else has the
  project open, and follow someone's selection, camera and unsaved edit
  buffer.
- **Storybook integration.** Expanding a `*.stories.*` file (or a JSX node
  whose component has stories) embeds the live story in place when Storybook
  is running on `:6006`. JSX also gets a structural wireframe preview on
  hover.
- **Themeable.** Everything that paints a pixel can be tuned in the settings
  panel, along with LOD thresholds and per-layout parameters.

## Quick start

Requirements: Node 20+. Python projects also need Python 3 with
[Jedi](https://github.com/davidhalter/jedi) installed (`pip install jedi`).
Pyright is bundled as an npm dependency and is used for definitions when it
is available.

```bash
npm install

# Allow the server to open projects under one or more workspace roots
cp code-graph.config.example.json code-graph.config.json
#   { "workspaces": ["~/Development/experiments"] }

npm run dev
```

`npm run dev` starts the Vite client on `:5173` and the Fastify helper on
`:5174`. The server prints a tokened URL:

```
  Open: http://localhost:5173/?token=…
```

Open that exact URL, because API calls without the token are rejected. Pick a
project from the picker. Any directory under a workspace root that has a
`tsconfig.json`, `pyproject.toml` or `setup.py`, or a `package.json` at a git
repo root, is listed. `examples/sample-ts` is a small fixture project to try
it on.

Press `?` in the bottom-left corner of the canvas for the full shortcut list.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Client + server with hot reload (`vite` + `tsx watch`) |
| `npm run build` | Type-check and build the client to `dist/` |
| `npm run typecheck` | `tsc -b --noEmit` across client and server projects |
| `npm run storybook` | Storybook for the app's own UI components on `:6006` |
| `npm run test:vr` | Build Storybook, then screenshot every story with Playwright |
| `npm run test:vr:update` | Same, regenerating the baselines in `tests/__screenshots__/` |

### Configuration

| Setting | Purpose |
| --- | --- |
| `code-graph.config.json` | `workspaces`: the allowlist of roots projects may be opened from. Without it, nothing can be opened. Not committed. |
| `.code-graph/token` | The persisted session token (mode 0600). Delete it to mint a new one. Not committed. |
| `CODE_GRAPH_PYTHON` | Python interpreter for the analyzer helper (default `python3`, then `python`) |
| `CODE_GRAPH_PYRIGHT` | Override the pyright language-server command |
| `CODE_GRAPH_CACHE_DIR` | Where analyzed graphs are cached (default `$XDG_CACHE_HOME/code-graph` or `~/.cache/code-graph`) |
| `CODE_GRAPH_NO_CACHE=1` | Disable the analysis cache |

## Architecture

```
┌──────────────────────────── Browser (:5173) ─────────────────────────────┐
│                                                                          │
│  App.tsx ── HUD (React) ─ ProjectPicker · LayoutBar · EdgeFilterPills    │
│     │                     SnapshotBar · SearchPalette · SessionsPill     │
│     │                     EditorPane (Monaco)                            │
│     ▼                                                                    │
│  zustand stores                       PixiCanvas (imperative, 60fps)     │
│   useGraphStore   project+selection ─► layoutEngine ─ patterns/*         │
│   useConfigStore  tunables (persisted)  astForce · treemap (AST layout)  │
│   useSnapshotStore saved views          edges · labelPool · hitTest      │
│   usePresenceStore other sessions       storybook / JSX DOM overlays     │
│     ▲                                                                    │
│  api/client.ts ── fetch (token header) + EventSource (?token=)           │
└─────┼────────────────────────────────────────────────────────────────────┘
      │ /api  (Vite proxy)                      SSE: deltas, sessions, presence
┌─────▼──────────────────────── Fastify helper (:5174) ────────────────────┐
│  index.ts    routes · auth gate · presence relay                         │
│  config.ts   workspace allowlist · fileId containment                    │
│  discovery   project picker scan                                         │
│  project.ts  orchestrator: loaded-project LRU · caches · GraphDelta      │
│     │                                                                    │
│     ├── watcher.ts  (recursive fs.watch / chokidar, debounced)           │
│     ├── cache.ts    (on-disk edge cache, fingerprinted)                  │
│     └── LanguageAnalyzer ──┬── TypeScriptAnalyzer  (ts-morph, in-proc)   │
│                            │     ast-extractor · semantic-edges          │
│                            └── PythonAnalyzer ── stdio JSON ──►          │
│                                  python/analyzer_helper.py               │
│                                  (stdlib ast + Jedi, pyright LSP)        │
└──────────────────────────────────────────────────────────────────────────┘
```

The client and server share one set of wire types, `src/api/types.ts`, which
`tsconfig.server.json` includes directly.

### Server (`server/`)

**Analyzers.** `LanguageAnalyzer` (`analyzer.ts`) is the façade over a
language engine. It covers open, list files, extract, validate, apply a
change, build edges, and importers-of. `detectLanguage` picks one per
project: `tsconfig.json` wins, otherwise Python markers or a shallow `.py`
scan.

- `TypeScriptAnalyzer` wraps a ts-morph `Project`. `ast-extractor.ts` walks
  each file into a flat `AstNode[]`. It elides purely structural wrappers and
  annotates nodes with names, operators, roles and export flags.
  `semantic-edges.ts` resolves `calls` / `extends` / `implements` to
  declarations inside the project. External targets are dropped.
- `PythonAnalyzer` keeps a long-lived Python subprocess warm, talking
  newline-delimited JSON over stdio. That keeps Jedi's module cache alive
  across edits. The helper emits exactly the same shapes as the TS side, so
  the client renders Python identically.

Both follow the same identity rules, and everything incremental depends on
them:

- `fileId` is the POSIX path relative to the project root and never contains
  `#`.
- AST ids are `${fileId}#${seq}`. `seq` restarts per file and is assigned in
  depth-first pre-order, so ids are stable across re-walks of an unchanged
  file.
- Import edge ids are `from->to@pos`. Semantic edge ids are `from~kind~to`.

**Orchestrator.** `project.ts` holds the authoritative `files`, `asts`,
`importEdges` and `semanticEdges` for each loaded project. It is
language-agnostic.

- *Project identity.* A project is keyed by a hash of its realpath. Reopening
  the same path, from any window, reuses one analyzer and one watcher, and
  concurrent opens share one in-flight build.
- *Lifecycle.* At most four projects are resident. Idle ones are LRU-evicted
  unless an SSE subscriber is connected.
- *Incremental deltas.* When a file event arrives, only that file is
  re-parsed. Edges are recomputed for `affected = {file} ∪ importers(file)`.
  This is sufficient because a cross-file edge can only exist if its source
  file imports the target. The result ships as a `GraphDelta`. The client
  drops every edge originating in `affectedFromFiles` and splices in the new
  ones. Edges between untouched files are never resent.
- *Warm reopen.* `cache.ts` persists file metadata and edges to a central
  cache directory, never inside the analyzed project. On reopen, files are
  diffed by mtime and size, and only the affected set goes through the
  expensive symbol resolution (ts-morph, Jedi or pyright). ASTs are always
  re-extracted, which is cheap and keeps cached edge ids consistent.
  Changing the tool versions, `tsconfig` or the exclude rules changes the
  fingerprint and discards the cache entry. Bump `SCHEMA_VERSION` whenever id
  assignment or edge shape changes.

**Editing.** Saving goes through three endpoints:

1. `GET /source-for-edit` returns the source as it is on disk plus a
   baseline (mtime and hash).
2. `POST /validate` dry-runs parse plus AST extraction on the proposed buffer
   without touching live state. It returns Monaco-ready diagnostics.
3. `POST /source` writes only if the baseline still matches. Otherwise it
   returns `409` with the current disk content. A successful write returns
   the resulting delta directly.

**Watching and presence.** `watcher.ts` uses recursive `fs.watch` on macOS
and Windows, which needs one file descriptor per project, and chokidar on
Linux. It debounces editor write bursts into one event per save.
`GET /watch` is an SSE stream:

- Unnamed events carry `GraphDelta`s.
- Named `sessions` and `presence` events carry the roster and each other
  session's selection, camera and live edit buffer.

The server is a pure relay for presence. Identity is minted per browser tab,
and state is posted to `POST /presence`.

**Security model.** The server binds to `127.0.0.1` only.

- Every `/api` route except `/health` requires the per-install token.
  Fetches send it as the `x-code-graph-token` header, and the EventSource
  sends it as `?token=`, because EventSource can't set headers.
- Projects can only be opened inside a configured workspace root, compared
  by realpath.
- Each file-level request's `fileId` is resolved and checked for containment
  within the project root.

Every check fails closed: no config means no workspaces, and a fileId that
can't be resolved is rejected.

### Client (`src/`)

**State** lives in separate zustand stores, so hot paths don't churn each
other:

- `graph/store.ts` holds the project, primary selection and multi-selection,
  expansion, pins, focus and edge filters. `applyDelta` merges server deltas
  in place.
- `graph/config/` is the single `GraphConfig` of every tunable: LOD
  thresholds, behaviours, theme, and per-layout parameters. It is persisted
  and sanitized on rehydrate and on snapshot restore, so configs written by
  older builds load safely.
- `graph/snapshots/` holds saved views per project root.
- `graph/presence.ts` holds other sessions and the follow target.
- `graph/sourceStore.ts` caches raw source for previews.

**Layout.** Layout happens at two levels.

- *File level.* `graph/patterns/` holds pluggable `LayoutPattern`s, either
  *static* (folder grid, hub-and-spoke, treemap) or *live* (the d3-force
  connectivity simulation in `graph/layout.ts`). `render/layoutEngine.ts`
  runs one pattern at a time. On a switch it holds both position sets and
  crossfades between them over a fixed duration. A collision/overlap
  relaxation pass keeps expanded files from overlapping.
- *Inside a file.* `graph/astForce.ts` settles a small force graph of
  top-level statements synchronously, linked by intra-file semantic edges and
  biased toward a square. That way the outer simulation sees a stable size.
  `graph/treemap.ts` sizes every nested node to its content and places
  inline syntax glyphs between child boxes. `graph/labels.ts` is shared by
  layout and rendering, so a box is always sized to exactly the text drawn
  in it.

**Rendering.** `render/PixiCanvas.tsx` is a PixiJS v8 scene driven by its own
ticker. React mounts it, but the per-frame work is imperative. It reads the
live config through a ref, so settings edits apply without rebuilding the
canvas.

- Expanded Blocks render as stacked overlay panes that hide what's beneath
  them.
- `edges.ts` draws import and semantic connectors, with alpha set by
  on-screen length.
- `astStyle.ts` holds the visual grammar: kind labels, outlines, and syntax
  templates.
- `labelPool.ts` pools and counter-scales text.
- `cameraInput.ts` and `hitTest.ts` handle pan, zoom, drag-to-pin and
  selection.
- The Storybook and JSX story layers (`storybookOverlay.ts`,
  `jsxStoryOverlay.ts`) are plain DOM iframes that the ticker positions each
  frame.

**UI** (`src/ui/`) is the React HUD around the canvas. It includes the
project picker, layout bar and settings panel, edge filters, snapshot bar,
pin and zoom controls, search palette, hover tooltip (with the JSX wireframe
from `render/jsxPreview.tsx`), sessions roster and Monaco editor pane. The
HUD components have their own Storybook stories, which also feed the
visual-regression suite.

### Data flow at a glance

1. **Open.** The picker POSTs `/api/project`. The server opens the project
   (from cache when possible) and returns files and edges.
2. **Expand.** Expanding a file fetches its AST once with `GET /ast` and
   lays it out client-side.
3. **Change.** When a file changes on disk (or in another editor), the
   watcher fires. The server builds a `GraphDelta` and pushes it over SSE,
   `applyDelta` merges it, and the canvas updates in place.
4. **Edit.** Editing in the pane goes through validate, then a guarded
   write. The write's delta is applied immediately. When the watcher later
   echoes the same save, it doesn't re-select the file or move the camera.

## Repository layout

```
server/            Fastify helper: routes, auth, analyzers, orchestrator, cache, watcher
  python/          Python analyzer helper (stdlib ast + Jedi)
src/
  api/             Shared wire types + HTTP/SSE client
  graph/           Stores, layout patterns, AST layout, config, snapshots, presence
  render/          PixiJS renderer, edges, labels, input, overlays, theme
  ui/              React HUD components (+ settings/)
  stories/         Storybook intro + fixtures
examples/sample-ts Small fixture project
tests/             Playwright visual-regression spec + baselines
```
