import { useState, type FormEvent } from 'react';

interface FolderPickerProps {
  onSubmit: (path: string) => void;
  loading: boolean;
  error: string | null;
}

export function FolderPicker({ onSubmit, loading, error }: FolderPickerProps) {
  const [path, setPath] = useState('');

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
        placeholder="/absolute/path/to/typescript/project"
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
