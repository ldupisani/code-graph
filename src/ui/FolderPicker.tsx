import { useState, type FormEvent } from 'react';

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
        autoFocus
      />
      <button type="submit" disabled={loading || !path.trim()}>
        {loading ? 'Analyzing…' : 'Open'}
      </button>
      {error ? <span style={{ color: '#ff8080' }}>{error}</span> : null}
    </form>
  );
}
