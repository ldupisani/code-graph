// Per-installation session token + request gate. The token is minted once and
// persisted (mode 0600) so `tsx watch` restarts don't rotate it mid-session;
// deleting .code-graph/token mints a fresh one on the next start. Every /api
// request except GET /api/health must present it — via header for fetches, or
// `?token=` for EventSource, which cannot set headers.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TOKEN_DIR = path.resolve(process.cwd(), '.code-graph');
const TOKEN_FILE = path.join(TOKEN_DIR, 'token');

export function getOrCreateToken(): string {
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable — mint a new one below.
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

// Only same-host browser origins may talk to us. Blocks DNS-rebinding pages,
// whose requests arrive with the attacker's hostname in Host. The Vite proxy
// forwards the browser's Host (localhost:5173, changeOrigin: false); direct
// tools send 127.0.0.1:5174 — both must pass.
const HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// Hash both sides first: timingSafeEqual throws on length mismatch, and the
// throw itself would leak length. Hashing makes the inputs fixed-width.
function tokensMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function registerAuth(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!HOST_RE.test(host)) {
      return reply.code(403).send({ error: 'Forbidden host.' });
    }
    // Parse the query from the raw URL: request.query isn't populated yet in
    // onRequest (query/body parsing happens later in the lifecycle).
    const url = new URL(req.raw.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') return;
    const supplied = req.headers['x-code-graph-token'] ?? url.searchParams.get('token');
    if (typeof supplied !== 'string' || !tokensMatch(supplied, token)) {
      return reply.code(401).send({
        error: 'Missing or invalid token. Open the URL printed in the server terminal.',
      });
    }
  });
}
