import Fastify from 'fastify';
import type {
  ApiError,
  ConflictResponse,
  FileAstResponse,
  ProjectRequest,
  ProjectResponse,
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
  noteWatchClose,
  noteWatchOpen,
  openProject,
  readSourceForEdit,
  validateSource,
  writeSource,
} from './project';

const PORT = 5174;
const HOST = '127.0.0.1';

const app = Fastify({ logger: true });

app.post<{ Body: ProjectRequest; Reply: ProjectResponse | ApiError }>(
  '/api/project',
  async (req, reply) => {
    const { path } = req.body;
    if (!path || typeof path !== 'string') {
      reply.code(400);
      return { error: 'Missing required body field: path (string).' };
    }
    try {
      const result = await openProject(path);
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
app.get<{ Params: { projectId: string } }>(
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
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  },
);

app.get('/api/health', async () => ({ ok: true }));

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`code-graph helper listening on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
