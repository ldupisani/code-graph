import { useEffect, useMemo, useRef, useState } from 'react';
import { AuthError, listProjects } from '../api/client';
import type { ProjectsResponse } from '../api/types';
import { getRecentPaths } from './recentPaths';

// Replaces the old free-text FolderPicker: the server only opens projects
// found under its configured workspace roots (GET /api/projects), so the UI
// offers exactly that list — pick, don't type. Recently-opened projects sort
// first (localStorage, convenience only; per-window identity stays the URL).

interface ProjectPickerProps {
  onSubmit: (path: string) => void;
  loading: boolean;
  error: string | null;
  // Absolute path of the project this window currently shows (button label).
  currentPath?: string;
  // A 401 from the projects list means this window has no valid token.
  onAuthError?: () => void;
}

export function ProjectPicker({
  onSubmit,
  loading,
  error,
  currentPath,
  onAuthError,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fetch on mount and refetch on every open, so a rescan is one click away.
  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setFetchError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof AuthError) onAuthError?.();
        else setFetchError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const projects = useMemo(() => {
    const list = data?.projects ?? [];
    const recents = getRecentPaths();
    const rank = new Map(recents.map((p, i) => [p, i]));
    const q = filter.trim().toLowerCase();
    return list
      .filter(
        (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const ra = rank.get(a.path) ?? Infinity;
        const rb = rank.get(b.path) ?? Infinity;
        return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
      });
  }, [data, filter]);

  function choose(path: string) {
    setOpen(false);
    setFilter('');
    onSubmit(path);
  }

  const label = loading
    ? 'Analyzing…'
    : currentPath
      ? (currentPath.split('/').filter(Boolean).pop() ?? currentPath)
      : 'Open project…';

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={loading}
        title={currentPath ?? 'Pick a project from the configured workspaces'}
      >
        {label} ▾
      </button>
      {error ? <span style={{ color: '#ff8080', marginLeft: '0.5rem' }}>{error}</span> : null}
      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 50,
            minWidth: '28rem',
            maxHeight: '60vh',
            overflowY: 'auto',
            background: '#1d1d20',
            border: '1px solid #2c2c30',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            padding: '0.4rem',
          }}
        >
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && projects[0]) choose(projects[0].path);
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Filter projects…"
            autoFocus
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: '0.4rem' }}
          />
          {fetchError ? (
            <p style={{ color: '#ff8080', margin: '0.4rem' }}>{fetchError}</p>
          ) : data?.configMissing ? (
            <p style={{ opacity: 0.7, margin: '0.4rem' }}>
              No workspaces configured. Copy <code>code-graph.config.example.json</code> to{' '}
              <code>code-graph.config.json</code>, list your workspace roots, and restart the
              server.
            </p>
          ) : projects.length === 0 ? (
            <p style={{ opacity: 0.7, margin: '0.4rem' }}>
              {data
                ? `No projects found under: ${data.workspaces.join(', ') || '(none)'}`
                : 'Loading…'}
            </p>
          ) : (
            projects.map((p) => (
              <button
                key={p.path}
                type="button"
                onClick={() => choose(p.path)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: p.path === currentPath ? '#2c2c30' : 'transparent',
                  border: 'none',
                  borderRadius: 4,
                  padding: '0.35rem 0.5rem',
                  cursor: 'pointer',
                }}
              >
                <div>{p.name}</div>
                <div style={{ fontSize: '0.72rem', opacity: 0.55 }}>{p.path}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
