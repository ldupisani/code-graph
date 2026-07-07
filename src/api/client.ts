import type {
  ApiError,
  ConflictResponse,
  FileAstResponse,
  GraphDelta,
  ProjectRequest,
  ProjectResponse,
  SourceForEditResponse,
  ValidateResponse,
  WriteRequest,
  WriteResponse,
} from './types';

async function request<TResp>(path: string, init: RequestInit): Promise<TResp> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (body as ApiError | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as TResp;
}

export function openProject(req: ProjectRequest): Promise<ProjectResponse> {
  return request<ProjectResponse>('/api/project', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function getFileAst(projectId: string, fileId: string): Promise<FileAstResponse> {
  const url = `/api/project/${encodeURIComponent(projectId)}/ast?fileId=${encodeURIComponent(fileId)}`;
  return request<FileAstResponse>(url, { method: 'GET' });
}

// Streams incremental graph deltas for a project via Server-Sent Events: each
// filesystem change the server detects is re-walked (changed file only) and
// emitted as a GraphDelta the caller merges into the live graph. The browser
// reconnects automatically; we just close on cleanup.
export function subscribeToDeltas(
  projectId: string,
  onDelta: (delta: GraphDelta) => void,
  onError?: (e: Event) => void,
): () => void {
  const url = `/api/project/${encodeURIComponent(projectId)}/watch`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as GraphDelta;
      onDelta(data);
    } catch {
      // ignore malformed payloads
    }
  };
  if (onError) es.onerror = onError;
  return () => es.close();
}

// --- Editing (write path) --------------------------------------------------

// Disk-truth source + baseline for the editor. Distinct from getFileSource
// (in-memory text for previews); this one carries the conflict baseline.
export function getSourceForEdit(
  projectId: string,
  fileId: string,
): Promise<SourceForEditResponse> {
  const url = `/api/project/${encodeURIComponent(projectId)}/source-for-edit?fileId=${encodeURIComponent(fileId)}`;
  return request<SourceForEditResponse>(url, { method: 'GET' });
}

// Dry-run the analysis on a proposed buffer (the save gate). Never writes.
export function validateSource(
  projectId: string,
  fileId: string,
  text: string,
): Promise<ValidateResponse> {
  const url = `/api/project/${encodeURIComponent(projectId)}/validate?fileId=${encodeURIComponent(fileId)}`;
  return request<ValidateResponse>(url, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

// Thrown by writeSource on a 409 so callers can offer reload-or-overwrite
// with the current on-disk content in hand.
export class ConflictError extends Error {
  readonly conflict: ConflictResponse;
  constructor(conflict: ConflictResponse) {
    super(conflict.error);
    this.name = 'ConflictError';
    this.conflict = conflict;
  }
}

// Write the buffer to disk. Resolves with the delta on success; throws
// ConflictError on 409, or a plain Error otherwise.
export async function writeSource(
  projectId: string,
  fileId: string,
  req: WriteRequest,
): Promise<WriteResponse> {
  const url = `/api/project/${encodeURIComponent(projectId)}/source?fileId=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  if (res.status === 409) throw new ConflictError(body as ConflictResponse);
  if (!res.ok) {
    const msg = (body as ApiError | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as WriteResponse;
}

export async function getFileSource(projectId: string, fileId: string): Promise<string> {
  const url = `/api/project/${encodeURIComponent(projectId)}/source?fileId=${encodeURIComponent(fileId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  return res.text();
}
