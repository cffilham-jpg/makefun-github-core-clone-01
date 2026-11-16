import { createServer } from 'node:http';
import { rest } from './rest.ts';
import { ApiError } from './store.ts';
import { gitHttp } from './git-http.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';

export function createApp() {
  let requests = 0;
  return createServer(async (req, res) => {
    res.setHeader('x-github-request-id', `req-${++requests}`);
    const json = (status: number, body: any, headers = {}) => {
      const data = status === 204 ? '' : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers }); res.end(data);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
      const path = decodeURIComponent(url.pathname), method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') return json(200, { ok: true });
      if (!process.env.MAKEFUN_SHOP_TOKEN || req.headers.authorization !== `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`) return json(401, { message: 'Bad credentials' });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      if (/\.git\//.test(path)) {
        const reply = gitHttp(method, path, url.searchParams, raw, req.headers['git-protocol'] === 'version=2');
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
      json(reply.status, reply.body, reply.headers);
    } catch (error) {
      json(error instanceof ApiError ? error.status : 400, { message: error instanceof Error ? error.message : 'Bad Request' });
    }
  });
}
