import type {
  ApiError,
  FileAstResponse,
  ProjectRequest,
  ProjectResponse,
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

export interface WatchEvent {
  kind: 'changed' | 'added' | 'removed';
  fileId: string;
}

// Streams filesystem events for a project via Server-Sent Events. The browser
// reconnects automatically; we just close on cleanup.
export function subscribeToWatch(
  projectId: string,
  onEvent: (event: WatchEvent) => void,
  onError?: (e: Event) => void,
): () => void {
  const url = `/api/project/${encodeURIComponent(projectId)}/watch`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as WatchEvent;
      onEvent(data);
    } catch {
      // ignore malformed payloads
    }
  };
  if (onError) es.onerror = onError;
  return () => es.close();
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
