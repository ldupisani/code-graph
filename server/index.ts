import Fastify from 'fastify';
import type {
  ApiError,
  FileAstResponse,
  ProjectRequest,
  ProjectResponse,
} from '../src/api/types';
import { extractAst } from './ast-extractor';
import {
  findSourceFile,
  getCachedAst,
  getLoadedProject,
  openProject,
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

  // Fallback if a file was added after open (M6 territory).
  const sf = findSourceFile(loaded, fileId);
  if (!sf) {
    reply.code(404);
    return { error: `Unknown fileId: ${fileId}` };
  }
  const result = extractAst(sf, fileId);
  app.log.info(`AST for ${fileId}: ${result.response.nodes.length} nodes (uncached)`);
  return result.response;
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
  const sf = findSourceFile(loaded, fileId);
  if (!sf) {
    reply.code(404);
    return { error: `Unknown fileId: ${fileId}` };
  }
  reply.type('text/plain; charset=utf-8');
  return sf.getFullText();
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

    const unsubscribe = loaded.watcher.subscribe((event) => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      raw.write(': ping\n\n');
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
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
