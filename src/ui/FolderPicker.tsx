import { useState, type FormEvent } from 'react';
import { getRecentPaths } from './recentPaths';

interface FolderPickerProps {
  onSubmit: (path: string) => void;
  loading: boolean;
  error: string | null;
  // Optional seed value (e.g. the last opened path, restored after a
  // dev-server reload). Only used as the initial input state — the picker
  // remains the source of truth from there on.
  initialPath?: string;
}

export function FolderPicker({ onSubmit, loading, error, initialPath }: FolderPickerProps) {
  const [path, setPath] = useState(initialPath ?? '');
  // Recently-opened paths (convenience only; per-window identity is the URL).
  // Read once on render — the list rarely changes within a session.
  const [recents] = useState<string[]>(() => getRecentPaths());

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = path.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <input
        type="text"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/absolute/path/to/a TypeScript or Python project"
        style={{ flex: 1, minWidth: '24rem' }}
        list="code-graph-recent-paths"
        autoFocus
      />
      {recents.length > 0 ? (
        <datalist id="code-graph-recent-paths">
          {recents.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      ) : null}
      <button type="submit" disabled={loading || !path.trim()}>
        {loading ? 'Analyzing…' : 'Open'}
      </button>
      {error ? <span style={{ color: '#ff8080' }}>{error}</span> : null}
    </form>
  );
}
