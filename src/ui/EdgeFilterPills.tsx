import type React from 'react';
import { useGraphStore, type EdgeFilter } from '../graph/store';
import { useConfigStore } from '../graph/config/store';
import { Pill } from './Pill';

// HUD overlay: three pill toggles for the user's edge-type lens.
// imports = the grey import lines drawn by drawEdges.
// calls   = the orange call connectors drawn by drawSemanticEdges
//           (caller→callee with the selection-gated outline).
// extends = the blue / teal extends and implements connectors. Treated
//           as one toggle because they share a "structural" reading
//           (subclass / impl points at the thing it's built from).
//
// Toggle off → the corresponding renderer pass / branch early-returns
// next frame; no state to clear, no animation.
//
// Pill colours match the legend in Hints exactly, so toggling one off
// makes it visually obvious WHICH edge type just went dark.
const PILL_COLORS: Record<keyof EdgeFilter, { bg: string; text: string }> = {
  imports: { bg: '#666670', text: '#cfcfd6' },
  calls: { bg: '#ff8b3d', text: '#1c1108' },
  extends: { bg: '#9aa3ff', text: '#0e1230' },
};

export function EdgeFilterPills() {
  const project = useGraphStore((s) => s.project);
  const edgeFilter = useGraphStore((s) => s.edgeFilter);
  const setEdgeFilter = useGraphStore((s) => s.setEdgeFilter);
  const focusId = useGraphStore((s) => s.focusId);
  const focusHops = useGraphStore((s) => s.focusHops);
  const tracedPath = useGraphStore((s) => s.tracedPath);
  const showSupportFiles = useGraphStore((s) => s.showSupportFiles);
  const setShowSupportFiles = useGraphStore((s) => s.setShowSupportFiles);
  // Isolate direction toggles now live in the config (persisted / templated).
  const isolateImports = useConfigStore((s) => s.config.behavioral.isolateImports);
  const isolateExports = useConfigStore((s) => s.config.behavioral.isolateExports);
  const setConfig = useConfigStore((s) => s.setConfig);
  const setIsolateImports = (on: boolean) => setConfig({ behavioral: { isolateImports: on } });
  const setIsolateExports = (on: boolean) => setConfig({ behavioral: { isolateExports: on } });

  // Hide when no project is open — there are no edges to filter.
  if (!project) return null;

  return (
    // Positioned by App's top HUD row (TopHudRow), not by this component: it
    // shares that row with the LayoutBar, and two independently-absolute rows
    // overlapped each other as soon as the canvas panel got narrow.
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        flexWrap: 'wrap',
        pointerEvents: 'auto',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '0.75rem',
        userSelect: 'none',
      }}
    >
      {(Object.keys(PILL_COLORS) as (keyof EdgeFilter)[]).map((kind) => (
        <Pill
          key={kind}
          label={kind === 'extends' ? 'extends / impl' : kind}
          on={edgeFilter[kind]}
          color={PILL_COLORS[kind]}
          onToggle={() => setEdgeFilter({ [kind]: !edgeFilter[kind] })}
        />
      ))}
      {/* The support-file toggle lives next to the edge pills but
          uses a different colour palette so it reads as a separate
          axis (FILE filter vs EDGE filter). 'tests' is the shortest
          label that captures the .test / .stories / .spec / __tests__
          / __mocks__ family without listing them all. */}
      <Pill
        label="tests"
        on={showSupportFiles}
        color={{ bg: '#9aa3a8', text: '#0e1216' }}
        onToggle={() => setShowSupportFiles(!showSupportFiles)}
      />
      {/* Isolate-mode direction toggles. When EITHER is on AND the
          zoom has crossed the file-expand threshold AND there's a
          selection, files outside the BFS neighbourhood are HIDDEN
          (not just dimmed). The two toggles independently gate the
          BFS direction:
            ↓ imports — follow outgoing edges (this depends on…)
            ↑ exports — follow incoming edges (…depends on this)
          Colours match the directional EDGE colours from
          COLORS.edgeImporting (yellow) / COLORS.edgeImported (blue)
          in PixiCanvas.tsx so the pill that includes "files this
          imports" reads in the same hue as the import lines drawn
          OUT of a selected file, and likewise for exports/imported-
          by lines. Arrow prefixes differentiate visually from the
          "imports" edge-kind pill earlier in the row (which controls
          whether import LINES are drawn at all). */}
      <Pill
        label="↓ imports"
        on={isolateImports}
        color={{ bg: '#e8c84a', text: '#1c1c08' }}
        onToggle={() => setIsolateImports(!isolateImports)}
      />
      <Pill
        label="↑ exports"
        on={isolateExports}
        color={{ bg: '#6cb6ff', text: '#0e1a30' }}
        onToggle={() => setIsolateExports(!isolateExports)}
      />
      {focusId && (
        <span
          style={{
            opacity: 0.75,
            color: '#cfcfd6',
            paddingLeft: '0.4rem',
            borderLeft: '1px solid rgba(120, 120, 130, 0.35)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.45rem',
          }}
        >
          <span>
            focus {focusHops} hop{focusHops === 1 ? '' : 's'}
          </span>
          <span>
            <Kbd>[</Kbd>/<Kbd>]</Kbd> · <Kbd>⇧</Kbd>+click multi · <Kbd>Esc</Kbd>
          </span>
        </span>
      )}
      {tracedPath && tracedPath.length > 0 && (
        <span
          style={{
            opacity: 0.85,
            color: '#dcdcaa',
            paddingLeft: '0.4rem',
            borderLeft: '1px solid rgba(120, 120, 130, 0.35)',
          }}
        >
          path: {tracedPath.length} file{tracedPath.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        padding: '0.05rem 0.3rem',
        border: '1px solid rgba(120,120,130,0.45)',
        borderRadius: 3,
        fontSize: '0.7rem',
        color: '#d4d4d4',
        background: 'rgba(40,40,46,0.55)',
      }}
    >
      {children}
    </span>
  );
}

