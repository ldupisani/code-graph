import type React from 'react';
import { useGraphStore, type EdgeFilter } from '../graph/store';

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

  // Hide when no project is open — there are no edges to filter.
  if (!project) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: '0.6rem',
        left: '0.8rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
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
      {focusId && (
        <span
          style={{
            opacity: 0.75,
            color: '#cfcfd6',
            paddingLeft: '0.4rem',
            borderLeft: '1px solid rgba(120, 120, 130, 0.35)',
          }}
        >
          focus {focusHops} hop{focusHops === 1 ? '' : 's'} ·{' '}
          <Kbd>+</Kbd>/<Kbd>-</Kbd> · <Kbd>Esc</Kbd>
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

function Pill({
  label,
  on,
  color,
  onToggle,
}: {
  label: string;
  on: boolean;
  color: { bg: string; text: string };
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      style={{
        appearance: 'none',
        border: 0,
        padding: '0.25rem 0.65rem',
        borderRadius: 999,
        background: on ? color.bg : 'rgba(40, 40, 46, 0.85)',
        color: on ? color.text : '#888892',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        // Subtle border at all times — readable on the dark canvas
        // whether the pill is on or off — opacity does the on/off
        // signalling within the bg colour.
        boxShadow: 'inset 0 0 0 1px rgba(120, 120, 130, 0.35)',
        cursor: 'pointer',
        opacity: on ? 1 : 0.55,
        transition: 'opacity 120ms ease, background-color 120ms ease',
        backdropFilter: 'blur(6px)',
      }}
    >
      {label}
    </button>
  );
}
