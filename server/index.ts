import Fastify from 'fastify';
import type {
  ApiError,
  ConflictResponse,
  FileAstResponse,
  PresenceState,
  PresenceUpdateRequest,
  ProjectRequest,
  ProjectResponse,
  SessionInfo,
  SourceForEditResponse,
  ValidateRequest,
  ValidateResponse,
  WriteRequest,
  WriteResponse,
} from '../src/api/types';
import {
  applyFileEvent,
  getCachedAst,
  getLoadedProject,
  openProject,
  noteWatchClose,
  noteWatchOpen,
  readSourceForEdit,
  validateSource,
  writeSource,
} from './project';
import { getOrCreateToken, registerAuth } from './auth';
import { isPathAllowed, loadConfig, resolveFileIdWithinRoot } from './config';
import { discoverProjects } from './discovery';

const PORT = 5174;
const HOST = '127.0.0.1';

const app = Fastify({ logger: true });

const token = getOrCreateToken();
registerAuth(app, token);

// --- Presence: connected sessions per project --------------------------------
// One entry per open SSE /watch connection. The server is a pure relay:
// identity is minted client-side (per tab) and carried on the /watch query
// string; presence state arrives via POST /presence and is fanned out to the
// other sessions on the same project as SSE `presence` events. Named events
// keep the default (unnamed) delta stream untouched for old clients.
interface PresenceSession extends SessionInfo {
  state: PresenceState | null;
  write: (chunk: string) => void;
}
const sessionsByProject = new Map<string, Map<string, PresenceSession>>();

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcastToProject(
  projectId: string,
  payload: string,
  excludeId?: string,
): void {
  const sessions = sessionsByProject.get(projectId);
  if (!sessions) return;
  for (const s of sessions.values()) {
    if (s.id === excludeId) continue;
    try {
      s.write(payload);
    } catch {
      // A torn-down socket races its own close handler; drop silently.
    }
  }
}

function rosterOf(projectId: string): SessionInfo[] {
  const sessions = sessionsByProject.get(projectId);
  if (!sessions) return [];
  return [...sessions.values()].map(({ id, name, color, connectedAt }) => ({
    id,
    name,
    color,
    connectedAt,
  }));
}

// Openable projects discovered under the configured workspace roots — what
// the UI picker lists instead of accepting a free-text path.
app.get('/api/projects', async () => {
  const config = loadConfig();
  const projects = await discoverProjects(config.workspaces);
  return {
    workspaces: config.workspaces,
    projects,
    configMissing: config.configMissing,
  };
});

app.post<{ Body: ProjectRequest; Reply: ProjectResponse | ApiError }>(
  '/api/project',
  async (req, reply) => {
    const { path } = req.body;
    if (!path || typeof path !== 'string') {
      reply.code(400);
      return { error: 'Missing required body field: path (string).' };
    }
    const allowed = isPathAllowed(path);
    if (!allowed.ok) {
      reply.code(403);
      return {
        error:
          'Path is not inside a configured workspace root. Edit code-graph.config.json and restart the server.',
      };
    }
    try {
      // Open by realpath so a symlinked spelling and its target share one
      // projectId / analyzer / watcher.
      const result = await openProject(allowed.realPath);
      app.log.info(
        `Loaded ${result.files.length} source files, ${result.edges.length} imports from ${result.rootPath}`,
      );
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.warn({ err: msg }, 'openProject failed');
      reply.code(400);
      return { error: msg };
    }
  },
);

app.get<{
  Params: { projectId: string };
  Querystring: { fileId?: string };
  Reply: FileAstResponse | ApiError;
}>('/api/project/:projectId/ast', async (req, reply) => {
  const { projectId } = req.params;
  const fileId = req.query.fileId;
  if (!fileId) {
    reply.code(400);
    return { error: 'Missing required query param: fileId' };
  }
  const loaded = getLoadedProject(projectId);
  if (!loaded) {
    reply.code(404);
    return { error: `Unknown projectId: ${projectId}. Re-open the project.` };
  }
  if (!resolveFileIdWithinRoot(loaded.rootPath, fileId)) {
    reply.code(400);
    return { error: `Invalid fileId: ${fileId}` };
  }
  // Prefer the cached walk computed at openProject time. IDs across the
  // cached AST and the project's semanticEdges must match exactly, so we
  // never re-walk the file on demand.
  const cached = getCachedAst(loaded, fileId);
  if (cached) return cached;

  // Fallback if a file was added after open.
  const ast = await loaded.analyzer.extract(fileId);
  if (!ast) {
    reply.code(404);
    return { error: `Unknown fileId: ${fileId}` };
  }
  app.log.info(`AST for ${fileId}: ${ast.nodes.length} nodes (uncached)`);
  return ast;
});

app.get<{
  Params: { projectId: string };
  Querystring: { fileId?: string };
}>('/api/project/:projectId/source', async (req, reply) => {
  const { projectId } = req.params;
  const fileId = req.query.fileId;
  if (!fileId) {
    reply.code(400);
    return { error: 'Missing required query param: fileId' };
  }
  const loaded = getLoadedProject(projectId);
  if (!loaded) {
    reply.code(404);
    return { error: `Unknown projectId: ${projectId}. Re-open the project.` };
  }
  if (!resolveFileIdWithinRoot(loaded.rootPath, fileId)) {
    reply.code(400);
    return { error: `Invalid fileId: ${fileId}` };
  }
  const source = await loaded.analyzer.readSource(fileId);
  if (source == null) {
    reply.code(404);
    return { error: `Unknown fileId: ${fileId}` };
  }
  reply.type('text/plain; charset=utf-8');
  return source;
});

// Editor load: disk-truth source + the baseline (mtime + hash) the client
// echoes back on save so we can detect a concurrent on-disk change. Distinct
// from GET /source (in-memory text for previews) so that contract stays intact.
app.get<{
  Params: { projectId: string };
  Querystring: { fileId?: string };
  Reply: SourceForEditResponse | ApiError;
}>('/api/project/:projectId/source-for-edit', async (req, reply) => {
  const { projectId } = req.params;
  const fileId = req.query.fileId;
  if (!fileId) {
    reply.code(400);
    return { error: 'Missing required query param: fileId' };
  }
  const loaded = getLoadedProject(projectId);
  if (!loaded) {
    reply.code(404);
    return { error: `Unknown projectId: ${projectId}. Re-open the project.` };
  }
  if (!resolveFileIdWithinRoot(loaded.rootPath, fileId)) {
    reply.code(400);
    return { error: `Invalid fileId: ${fileId}` };
  }
  const res = readSourceForEdit(loaded, fileId);
  if (!res) {
    reply.code(404);
    return { error: `Unknown fileId: ${fileId}` };
  }
  return res;
});

// Dry-run the analysis on a proposed buffer WITHOUT writing — the save gate.
app.post<{
  Params: { projectId: string };
  Querystring: { fileId?: string };
  Body: ValidateRequest;
  Reply: ValidateResponse | ApiError;
}>('/api/project/:projectId/validate', async (req, reply) => {
  const { projectId } = req.params;
  const fileId = req.query.fileId;
  if (!fileId) {
    reply.code(400);
    return { error: 'Missing required query param: fileId' };
  }
  if (typeof req.body?.text !== 'string') {
    reply.code(400);
    return { error: 'Missing required body field: text (string).' };
  }
  const loaded = getLoadedProject(projectId);
  if (!loaded) {
    reply.code(404);
    return { error: `Unknown projectId: ${projectId}. Re-open the project.` };
  }
  if (!resolveFileIdWithinRoot(loaded.rootPath, fileId)) {
    reply.code(400);
    return { error: `Invalid fileId: ${fileId}` };
  }
  return validateSource(loaded, fileId, req.body.text);
});

// Write the buffer to disk (baseline-guarded) and return the resulting delta.
// 409 with the current disk content when the baseline no longer matches.
app.post<{
  Params: { projectId: string };
  Querystring: { fileId?: string };
  Body: WriteRequest;
  Reply: WriteResponse | ConflictResponse | ApiError;
}>('/api/project/:projectId/source', async (req, reply) => {
  const { projectId } = req.params;
  const fileId = req.query.fileId;
  if (!fileId) {
    reply.code(400);
    return { error: 'Missing required query param: fileId' };
  }
  if (typeof req.body?.text !== 'string') {
    reply.code(400);
    return { error: 'Missing required body field: text (string).' };
  }
  const loaded = getLoadedProject(projectId);
  if (!loaded) {
    reply.code(404);
    return { error: `Unknown projectId: ${projectId}. Re-open the project.` };
  }
  if (!resolveFileIdWithinRoot(loaded.rootPath, fileId)) {
    reply.code(400);
    return { error: `Invalid fileId: ${fileId}` };
  }
  try {
    const result = await writeSource(loaded, fileId, {
      text: req.body.text,
      baseHash: req.body.baseHash ?? null,
      force: req.body.force,
    });
    if ('conflict' in result) {
      reply.code(409);
      return {
        error: result.conflict.error,
        conflict: true,
        currentText: result.conflict.currentText,
        currentMtimeMs: result.conflict.currentMtimeMs,
        currentHash: result.conflict.currentHash,
      };
    }
    app.log.info(`wrote ${fileId} (${req.body.text.length} chars)`);
    return {
      ok: true,
      newMtimeMs: result.newMtimeMs,
      newHash: result.newHash,
      delta: result.delta ?? undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    app.log.warn({ err: msg }, `writeSource failed for ${fileId}`);
    reply.code(400);
    return { error: msg };
  }
});

// SSE endpoint that streams filesystem events for a project. Connection is
// kept open until the client closes the EventSource. A keep-alive comment
// is sent every 25s in case a proxy expects periodic traffic.
app.get<{
  Params: { projectId: string };
  Querystring: { sessionId?: string; name?: string; color?: string };
}>(
  '/api/project/:projectId/watch',
  async (req, reply) => {
    const { projectId } = req.params;
    const loaded = getLoadedProject(projectId);
    if (!loaded) {
      reply.code(404);
      return { error: `Unknown projectId: ${projectId}` };
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(`: connected to ${projectId}\n\n`);

    // Mark this project as actively watched so eviction leaves it alone while a
    // window is connected; decremented in cleanup.
    noteWatchOpen(loaded);

    // Register this connection as a presence session (when the client sent an
    // identity — old clients without one still get deltas, just no presence).
    const { sessionId, name, color } = req.query;
    let session: PresenceSession | null = null;
    if (sessionId) {
      session = {
        id: sessionId,
        name: name || 'Anonymous',
        color: color || '#888888',
        connectedAt: Date.now(),
        state: null,
        write: (chunk) => raw.write(chunk),
      };
      let sessions = sessionsByProject.get(projectId);
      if (!sessions) sessionsByProject.set(projectId, (sessions = new Map()));
      sessions.set(sessionId, session);
      // Everyone (including the newcomer) gets the fresh roster; the newcomer
      // additionally gets a replay of each existing session's last presence so
      // a late joiner immediately sees who's where without waiting a tick.
      broadcastToProject(projectId, sseEvent('sessions', rosterOf(projectId)));
      for (const other of sessions.values()) {
        if (other.id === sessionId || !other.state) continue;
        raw.write(sseEvent('presence', { sessionId: other.id, state: other.state }));
      }
      app.log.info(`session ${name} (${sessionId}) joined ${projectId}`);
    }

    const unsubscribe = loaded.watcher.subscribe((event) => {
      // Translate the raw filesystem event into an incremental GraphDelta:
      // re-walk only the changed file, recompute only the edges that can touch
      // it, and stream that diff. The client merges it without rebuilding the
      // renderer, so the view/config survive the edit.
      void (async () => {
        try {
          const delta = await applyFileEvent(loaded, event);
          if (delta) {
            raw.write(`data: ${JSON.stringify(delta)}\n\n`);
            app.log.info(
              `delta ${delta.kind} ${delta.fileId}: ${delta.affectedFromFiles.length} src files, ${delta.imports.length} imports, ${delta.semanticEdges.length} semantic`,
            );
          }
        } catch (e) {
          app.log.warn(
            { err: e instanceof Error ? e.message : String(e) },
            `applyFileEvent failed for ${event.fileId}`,
          );
        }
      })();
    });

    const heartbeat = setInterval(() => {
      raw.write(': ping\n\n');
    }, 25_000);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
      noteWatchClose(loaded);
      if (session) {
        const sessions = sessionsByProject.get(projectId);
        sessions?.delete(session.id);
        if (sessions && sessions.size === 0) sessionsByProject.delete(projectId);
        broadcastToProject(projectId, sseEvent('sessions', rosterOf(projectId)));
        app.log.info(`session ${session.name} (${session.id}) left ${projectId}`);
      }
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  },
);

// Presence update: store the session's latest state and fan it out to every
// OTHER session on the project. Fire-and-forget from the client's point of
// view — an unknown session (SSE still connecting, or just dropped) is not an
// error, the next update after the stream lands will register.
app.post<{
  Params: { projectId: string };
  Body: PresenceUpdateRequest;
  Reply: { ok: boolean } | ApiError;
}>('/api/project/:projectId/presence', async (req, reply) => {
  const { projectId } = req.params;
  const { sessionId, state } = req.body ?? {};
  if (!sessionId || !state) {
    reply.code(400);
    return { error: 'Missing sessionId or state.' };
  }
  const session = sessionsByProject.get(projectId)?.get(sessionId);
  if (!session) return { ok: false };
  session.state = state;
  broadcastToProject(projectId, sseEvent('presence', { sessionId, state }), sessionId);
  return { ok: true };
});

app.get('/api/health', async () => ({ ok: true }));

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`code-graph helper listening on http://${HOST}:${PORT}`);
    // Plain console.log (not pino) so the URL is copy-pasteable from the
    // concurrently-prefixed dev output.
    console.log(`\n  Open: http://localhost:5173/?token=${token}\n`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
