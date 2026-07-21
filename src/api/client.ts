import type {
  ApiError,
  ConflictResponse,
  FileAstResponse,
  GraphDelta,
  PresenceEvent,
  PresenceState,
  ProjectRequest,
  ProjectResponse,
  ProjectsResponse,
  SessionInfo,
  SourceForEditResponse,
  ValidateResponse,
  WriteRequest,
  WriteResponse,
} from './types';

// Session token, read once from this window's URL (the server prints the
// tokened URL at startup). Sent as a header on fetches and as a query param on
// the EventSource (which cannot set headers). An empty token just means every
// API call 401s → the AuthError screen.
const token = (() => {
  try {
    return new URLSearchParams(window.location.search).get('token') ?? '';
  } catch {
    return '';
  }
})();

const AUTH_HEADER = { 'x-code-graph-token': token };

// Thrown on 401 so App can show the "open the URL from the terminal" screen
// instead of a generic error string.
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

async function request<TResp>(path: string, init: RequestInit): Promise<TResp> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER, ...(init.headers ?? {}) },
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
    if (res.status === 401) throw new AuthError(msg);
    throw new Error(msg);
  }
  return body as TResp;
}

// Projects discovered under the server's configured workspace roots — what
// the ProjectPicker lists.
export function listProjects(): Promise<ProjectsResponse> {
  return request<ProjectsResponse>('/api/projects', { method: 'GET' });
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
export interface SubscribeOptions {
  // Presence identity announced on the watch connection. When present the
  // server registers this client as a session and streams roster + presence
  // updates back as named SSE events.
  identity?: { id: string; name: string; color: string };
  onSessions?: (sessions: SessionInfo[]) => void;
  onPresence?: (event: PresenceEvent) => void;
  onError?: (e: Event) => void;
}

export function subscribeToDeltas(
  projectId: string,
  onDelta: (delta: GraphDelta) => void,
  opts?: SubscribeOptions,
): () => void {
  // Token always rides the query string here — EventSource cannot set
  // headers, and reconnects reuse the same URL so auth survives them.
  const q = new URLSearchParams({ token });
  if (opts?.identity) {
    q.set('sessionId', opts.identity.id);
    q.set('name', opts.identity.name);
    q.set('color', opts.identity.color);
  }
  const url = `/api/project/${encodeURIComponent(projectId)}/watch?${q}`;
  const es = new EventSource(url);
  // Deltas stay on the default (unnamed) event; presence rides NAMED events
  // ('sessions' / 'presence') so the two streams can't be confused.
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as GraphDelta;
      onDelta(data);
    } catch {
      // ignore malformed payloads
    }
  };
  if (opts?.onSessions) {
    es.addEventListener('sessions', (e) => {
      try {
        opts.onSessions?.(JSON.parse((e as MessageEvent).data) as SessionInfo[]);
      } catch {
        // ignore malformed payloads
      }
    });
  }
  if (opts?.onPresence) {
    es.addEventListener('presence', (e) => {
      try {
        opts.onPresence?.(JSON.parse((e as MessageEvent).data) as PresenceEvent);
      } catch {
        // ignore malformed payloads
      }
    });
  }
  if (opts?.onError) es.onerror = opts.onError;
  return () => es.close();
}

// Throttled presence report (see App.tsx). Fire-and-forget: a failed update
// is superseded by the next tick anyway.
export function postPresence(
  projectId: string,
  sessionId: string,
  state: PresenceState,
): void {
  const url = `/api/project/${encodeURIComponent(projectId)}/presence`;
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
    body: JSON.stringify({ sessionId, state }),
  }).catch(() => {
    // Server restarting / connection blip — the next report retries.
  });
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
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
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
    if (res.status === 401) throw new AuthError(msg);
    throw new Error(msg);
  }
  return body as WriteResponse;
}

export async function getFileSource(projectId: string, fileId: string): Promise<string> {
  const url = `/api/project/${encodeURIComponent(projectId)}/source?fileId=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, { headers: AUTH_HEADER });
  if (!res.ok) {
    const text = await res.text();
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      if (text) msg = text;
    }
    if (res.status === 401) throw new AuthError(msg);
    throw new Error(msg);
  }
  return res.text();
}
