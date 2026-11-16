import { createServer } from 'node:http';
import { rest } from './rest.ts';
import { ApiError } from './store.ts';
import { gitHttp } from './git-http.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';

export function createApp() {
  let requests = 0;
  // Cache complete wire replies, including pack framing and checksums. Only
  // read-only git exchanges enter this cache; all possible writes clear it.
  const gitReplies = new Map<string, { type: string; data: Buffer }>();
  const restReplies = new Map<string, { data: string; headers: Record<string, string | number> }>();
  let gitBytes = 0;
  let restBytes = 0;
  return createServer((req, res) => {
    res.setHeader('x-github-request-id', `req-${++requests}`);
    const json = (status: number, body: any, headers = {}) => {
      const data = status === 204 ? '' : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers }); res.end(data);
    };
    try {
      const method = req.method ?? 'GET';
      const hasBody = !!req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0;
      // Authentication and request ids remain per-request, even on cache hits.
      const restKey = method === 'GET' && !hasBody ? JSON.stringify([req.headers.host, req.url]) : '';
      const authorized = !!process.env.MAKEFUN_SHOP_TOKEN && req.headers.authorization === `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`;
      const cachedRest = authorized && restKey && restReplies.get(restKey);
      if (cachedRest) {
        req.resume();
        res.writeHead(200, cachedRest.headers);
        return res.end(cachedRest.data);
      }
      const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
      const path = decodeURIComponent(url.pathname);
      if (method === 'GET' && path === '/healthz') return json(200, { ok: true });
      if (!process.env.MAKEFUN_SHOP_TOKEN || req.headers.authorization !== `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`) return json(401, { message: 'Bad credentials' });
      const dispatch = (raw: Buffer) => {
      try {
      const gitRead = /\.git\/git-upload-pack$/.test(path) && method === 'POST';
      if (method !== 'GET' && method !== 'HEAD' && !gitRead) {
        gitReplies.clear(); gitBytes = 0;
        restReplies.clear(); restBytes = 0;
      }
      if (/\.git\//.test(path)) {
        const cacheKey = (method === 'GET' || gitRead) && raw.length <= 65536
          ? JSON.stringify([method, req.url, req.headers['git-protocol'], raw.toString('base64')]) : '';
        const cached = cacheKey && gitReplies.get(cacheKey);
        if (cached) {
          res.writeHead(200, { 'content-type': cached.type, 'content-length': cached.data.length });
          return res.end(cached.data);
        }
        const reply = gitHttp(method, path, url.searchParams, raw, req.headers['git-protocol'] === 'version=2');
        if (cacheKey && reply.data.length <= 4 * 1024 * 1024) {
          if (gitReplies.size >= 128 || gitBytes + reply.data.length > 8 * 1024 * 1024) { gitReplies.clear(); gitBytes = 0; }
          gitReplies.set(cacheKey, reply); gitBytes += reply.data.length;
        }
        res.writeHead(200, { 'content-type': reply.type, 'content-length': reply.data.length });
        return res.end(reply.data);
      }
      let body: any = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString()); }
        catch { return json(400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Malformed JSON' }); }
      }
      if (path === '/api/graphql' && method === 'POST') return json(200, graphql(body));
      if (path === '/mcp' && method === 'POST') {
        if (req.headers['mcp-session-id']) res.setHeader('mcp-session-id', req.headers['mcp-session-id']);
        if (body.id === undefined) { res.writeHead(202); return res.end(); }
        return json(200, mcp(body));
      }
      const reply = rest(method, path, url.searchParams, body, url.origin);
      if (restKey && reply.status === 200) {
        const data = JSON.stringify(reply.body), length = Buffer.byteLength(data);
        const headers = { 'content-type': 'application/json', 'content-length': length, ...reply.headers };
        if (length <= 1024 * 1024) {
          if (restReplies.size >= 256 || restBytes + length > 4 * 1024 * 1024) { restReplies.clear(); restBytes = 0; }
          restReplies.set(restKey, { data, headers }); restBytes += length;
        }
        res.writeHead(200, headers); return res.end(data);
      }
      json(reply.status, reply.body, reply.headers);
      } catch (error) {
        json(error instanceof ApiError ? error.status : 400, { message: error instanceof Error ? error.message : 'Bad Request' });
      }
      };
      if (!hasBody) { req.resume(); return dispatch(Buffer.alloc(0)); }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => dispatch(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
      req.on('error', () => res.destroy());
      req.on('aborted', () => res.destroy());
    } catch (error) {
      json(error instanceof ApiError ? error.status : 400, { message: error instanceof Error ? error.message : 'Bad Request' });
    }
  });
}
