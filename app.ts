import { createServer } from 'node:net';
import { rest } from './rest.ts';
import { ApiError } from './store.ts';
import { gitHttp } from './git-http.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';

// Raw TCP transport: one hand-rolled HTTP/1.1 parser over node:net, replacing
// node:http. Same dispatch semantics as the node:http build (same caches, same
// invalidation, same replies); only the transport changes. The kit clients
// (undici fetch) send content-length bodies on keep-alive connections and never
// chunked bodies, HEAD, or pipelining — but chunked decoding, HEAD, and
// pipelined requests are all handled anyway.

const REASONS: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity' };

function decodeChunked(data: Buffer): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let i = 0;
  for (;;) {
    const lineEnd = data.indexOf('\r\n', i);
    if (lineEnd < 0) return null;
    const sizeText = data.toString('ascii', i, lineEnd).split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new Error('bad chunk size');
    const size = parseInt(sizeText, 16);
    i = lineEnd + 2;
    if (size === 0) {
      for (;;) {
        const tEnd = data.indexOf('\r\n', i);
        if (tEnd < 0) return null;
        if (tEnd === i) return { body: Buffer.concat(parts), consumed: i + 2 };
        i = tEnd + 2;
      }
    }
    if (data.length < i + size + 2) return null;
    parts.push(data.subarray(i, i + size));
    i += size;
    if (data[i] !== 13 || data[i + 1] !== 10) throw new Error('bad chunk end');
    i += 2;
  }
}

export function createApp() {
  let requests = 0;
  // Hoisted once: process.env access and the expected header are per-request costs.
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = shopToken ? `Bearer ${shopToken}` : '';
  // Cached tails: everything after the status line + request-id line — the
  // remaining headers, the blank line, and the body — pre-built once, so a
  // cache hit is one Buffer.concat and one socket.write.
  const gitReplies = new Map<string, Buffer>();
  const restReplies = new Map<string, Buffer>();
  let gitBytes = 0;
  let restBytes = 0;

  const jsonTail = (status: number, body: any, extra: Array<[string, string]> = []): { status: number; tail: Buffer } => {
    const data = Buffer.from(status === 204 ? '' : JSON.stringify(body));
    let head = `content-type: application/json\r\ncontent-length: ${data.length}\r\n`;
    for (const [k, v] of extra) head += `${k}: ${v}\r\n`;
    return { status, tail: Buffer.concat([Buffer.from(head + '\r\n'), data]) };
  };

  // One request -> { status, tail }. Same semantics as the node:http dispatch.
  const handle = (method: string, target: string, h: Record<string, string | undefined>, raw: Buffer): { status: number; tail: Buffer } => {
    try {
      const hasBody = !!h['transfer-encoding'] || Number(h['content-length'] ?? 0) > 0;
      const restKey = method === 'GET' && !hasBody ? (h.host ?? '') + ' ' + target : '';
      const authorized = !!expectedAuth && h.authorization === expectedAuth;
      if (authorized && restKey) {
        const cached = restReplies.get(restKey);
        if (cached) return { status: 200, tail: cached };
      }
      const url = new URL(target, 'http://' + (h.host ?? 'localhost'));
      const path = decodeURIComponent(url.pathname);
      if (method === 'GET' && path === '/healthz') return jsonTail(200, { ok: true });
      if (!expectedAuth || h.authorization !== expectedAuth) return jsonTail(401, { message: 'Bad credentials' });
      try {
        const gitRead = /\.git\/git-upload-pack$/.test(path) && method === 'POST';
        if (method !== 'GET' && method !== 'HEAD' && !gitRead) {
          gitReplies.clear(); gitBytes = 0;
          restReplies.clear(); restBytes = 0;
        }
        if (/\.git\//.test(path)) {
          const cacheKey = (method === 'GET' || gitRead) && raw.length <= 65536
            ? JSON.stringify([method, target, h['git-protocol'], raw.toString('base64')]) : '';
          const cached = cacheKey && gitReplies.get(cacheKey);
          if (cached) return { status: 200, tail: cached };
          const reply = gitHttp(method, path, url.searchParams, raw, h['git-protocol'] === 'version=2');
          const tail = Buffer.concat([Buffer.from(`content-type: ${reply.type}\r\ncontent-length: ${reply.data.length}\r\n\r\n`), reply.data]);
          if (cacheKey && reply.data.length <= 4 * 1024 * 1024) {
            if (gitReplies.size >= 128 || gitBytes + reply.data.length > 8 * 1024 * 1024) { gitReplies.clear(); gitBytes = 0; }
            gitReplies.set(cacheKey, tail); gitBytes += reply.data.length;
          }
          return { status: 200, tail };
        }
        let body: any = {};
        if (raw.length) {
          try { body = JSON.parse(raw.toString()); }
          catch { return jsonTail(400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Malformed JSON' }); }
        }
        if (path === '/api/graphql' && method === 'POST') return jsonTail(200, graphql(body));
        if (path === '/mcp' && method === 'POST') {
          const extra: Array<[string, string]> = h['mcp-session-id'] ? [['mcp-session-id', h['mcp-session-id']]] : [];
          if (body.id === undefined) return { status: 202, tail: Buffer.from('content-length: 0\r\n\r\n') };
          return jsonTail(200, mcp(body), extra);
        }
        const reply = rest(method, path, url.searchParams, body, url.origin);
        if (restKey && reply.status === 200) {
          const data = Buffer.from(JSON.stringify(reply.body));
          let head = `content-type: application/json\r\ncontent-length: ${data.length}\r\n`;
          for (const [k, v] of Object.entries(reply.headers ?? {})) head += `${k}: ${v}\r\n`;
          const tail = Buffer.concat([Buffer.from(head + '\r\n'), data]);
          if (data.length <= 1024 * 1024) {
            if (restReplies.size >= 256 || restBytes + data.length > 4 * 1024 * 1024) { restReplies.clear(); restBytes = 0; }
            restReplies.set(restKey, tail); restBytes += data.length;
          }
          return { status: 200, tail };
        }
        return jsonTail(reply.status, reply.body, Object.entries(reply.headers ?? {}) as Array<[string, string]>);
      } catch (error) {
        return jsonTail(error instanceof ApiError ? error.status : 400, { message: error instanceof Error ? error.message : 'Bad Request' });
      }
    } catch (error) {
      return jsonTail(error instanceof ApiError ? error.status : 400, { message: error instanceof Error ? error.message : 'Bad Request' });
    }
  };

  return createServer((socket) => {
    let buf = Buffer.alloc(0);
    const badRequest = () => { try { socket.write(Buffer.from('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')); } catch {} socket.destroy(); };
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd < 0) {
          if (buf.length > 65536) return badRequest();
          return;
        }
        const lines = buf.toString('ascii', 0, headEnd).split('\r\n');
        const firstSpace = lines[0].indexOf(' '), lastSpace = lines[0].lastIndexOf(' ');
        const method = lines[0].slice(0, firstSpace), target = lines[0].slice(firstSpace + 1, lastSpace), version = lines[0].slice(lastSpace + 1);
        if (firstSpace <= 0 || lastSpace <= firstSpace + 1 || !/^HTTP\/\d\.\d$/.test(version)) return badRequest();
        const h: Record<string, string | undefined> = {};
        for (let i = 1; i < lines.length; i++) {
          const colon = lines[i].indexOf(':');
          if (colon <= 0) continue;
          const name = lines[i].slice(0, colon).trim().toLowerCase();
          if (h[name] === undefined) h[name] = lines[i].slice(colon + 1).trim();
        }
        if ((h.expect ?? '').toLowerCase() === '100-continue') socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'));
        const chunked = (h['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
        const contentLength = Number(h['content-length'] ?? 0);
        let bodyStart = headEnd + 4;
        let raw: Buffer;
        try {
          if (chunked) {
            const decoded = decodeChunked(buf.subarray(bodyStart));
            if (!decoded) return;
            raw = decoded.body; bodyStart += decoded.consumed;
          } else if (contentLength > 0) {
            if (!Number.isFinite(contentLength)) return badRequest();
            if (buf.length < bodyStart + contentLength) return;
            raw = buf.subarray(bodyStart, bodyStart + contentLength);
            bodyStart += contentLength;
          } else raw = Buffer.alloc(0);
        } catch { return badRequest(); }
        buf = buf.subarray(bodyStart);
        const conn = (h.connection ?? '').toLowerCase();
        const closeAfter = conn.includes('close') || (version === 'HTTP/1.0' && !conn.includes('keep-alive'));
        const { status, tail } = handle(method, target, h, raw);
        const head = Buffer.from(`HTTP/1.1 ${status} ${REASONS[status] ?? ''}\r\nx-github-request-id: req-${++requests}\r\n`);
        // HEAD answers carry the headers but no body (no kit client sends HEAD).
        const out = method === 'HEAD' ? Buffer.concat([head, tail.subarray(0, tail.indexOf('\r\n\r\n') + 4)]) : Buffer.concat([head, tail]);
        socket.write(out);
        if (closeAfter) { socket.end(); return; }
      }
    });
    socket.on('error', () => socket.destroy());
  });
}
