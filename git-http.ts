import { objects, zero, isAncestor, reachable } from './objects.ts';
import { pack, unpack } from './pack.ts';
import { getRepo, tip, ApiError, type Repo } from './store.ts';

const flush = Buffer.from('0000'), delim = Buffer.from('0001');
export function pkt(value: string | Buffer) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
function packets(data: Buffer, stopAtFlush = false) {
  const lines: string[] = []; let i = 0;
  while (i < data.length) {
    const header = data.toString('ascii', i, i + 4);
    let hex = header.length === 4;
    for (let j = 0; hex && j < 4; j++) { const c = header.charCodeAt(j); hex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70); }
    if (!hex) throw new ApiError(400, 'Invalid packet length');
    const n = parseInt(header, 16); i += 4;
    if (n <= 2) { if (!n && stopAtFlush) break; continue; }
    if (n < 4 || n > 65520 || i + n - 4 > data.length) throw new ApiError(400, 'Invalid packet');
    let line = data.toString('utf8', i, i + n - 4); if (line.endsWith('\n')) line = line.slice(0, -1);
    lines.push(line); i += n - 4;
  }
  return { lines, offset: i };
}
function bands(data: Buffer): Buffer[] {
  const parts = [];
  for (let offset = 0; offset < data.length; offset += 64000) parts.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + 64000)])));
  return parts;
}
function peeled(oid: string) {
  const seen = new Set<string>(); let current = oid;
  while (objects.get(current)?.type === 'tag' && !seen.has(current)) { seen.add(current); current = objects.get(current)!.data.toString().match(/^object ([0-9a-f]{40})/)?.[1] ?? current; }
  return current;
}
function refs(r: Repo) {
  const list = [...r.refs].sort(([a], [b]) => a.localeCompare(b));
  const head = tip(r);
  if (head) list.unshift(['HEAD', head]);
  return list;
}
export function gitHttp(method: string, path: string, q: URLSearchParams, raw: Buffer, v2: boolean) {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!match) throw new ApiError(404, 'Not Found');
  const r = getRepo(match[1], match[2]), suffix = match[3];
  const service = suffix === 'info/refs' ? q.get('service') : suffix;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new ApiError(404, 'Not Found');
  const upload = service === 'git-upload-pack', advertisement = suffix === 'info/refs';
  const parts: Buffer[] = [];
  if (advertisement && method === 'GET') {
    if (upload && v2) parts.push(...['version 2\n', 'agent=memory-forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt), flush);
    else {
      parts.push(pkt(`# service=${service}\n`), flush);
      const capabilities = upload ? `side-band-64k shallow ofs-delta symref=HEAD:refs/heads/${r.default_branch} agent=memory-forge/1` : 'report-status side-band-64k delete-refs ofs-delta agent=memory-forge/1';
      const list = refs(r);
      if (!list.length) list.push(['capabilities^{}', zero]);
      list.forEach(([ref, oid], i) => {
        parts.push(pkt(`${oid} ${ref}${i === 0 ? '\0' + capabilities : ''}\n`));
        if (ref.startsWith('refs/tags/') && peeled(oid) !== oid) parts.push(pkt(`${peeled(oid)} ${ref}^{}\n`));
      });
      parts.push(flush);
    }
  } else if (!advertisement && method === 'POST' && !upload) {
    const { lines, offset } = packets(raw, true);
    let unpackError = '';
    if (raw.length > offset) { try { unpack(raw.subarray(offset)); } catch (err) { unpackError = (err as Error).message; } }
    const report = [pkt(`unpack ${unpackError || 'ok'}\n`)];
    for (const line of lines) {
      const [old, next, ref] = line.split('\0')[0].trim().split(' ');
      if (!/^[0-9a-f]{40}$/.test(old) || !/^[0-9a-f]{40}$/.test(next) || !ref?.startsWith('refs/')) throw new ApiError(400, 'Invalid ref command');
      let reason = unpackError ? 'unpacker error' : '';
      const current = r.refs.get(ref) ?? zero;
      if (!reason && current !== old) reason = 'stale ref';
      if (!reason && next !== zero && !objects.has(next)) reason = 'missing object';
      if (!reason && old !== zero && next !== zero && !isAncestor(old, next)) reason = 'non-fast-forward';
      if (reason) report.push(pkt(`ng ${ref} ${reason}\n`));
      else { if (next === zero) r.refs.delete(ref); else r.refs.set(ref, next); report.push(pkt(`ok ${ref}\n`)); }
    }
    report.push(flush);
    if (lines[0]?.includes('side-band-64k')) parts.push(...bands(Buffer.concat(report)), flush);
    else parts.push(...report);
  } else if (!advertisement && method === 'POST' && upload) {
    const { lines } = packets(raw);
    if (v2 && lines.includes('command=ls-refs')) {
      const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11));
      const keep = (ref: string) => !prefixes.length || prefixes.some(p => ref.startsWith(p));
      for (const [ref, oid] of refs(r)) {
        if (!keep(ref)) continue;
        const attrs = ref === 'HEAD' && lines.includes('symrefs') ? ` symref-target:refs/heads/${r.default_branch}` : ref.startsWith('refs/tags/') && lines.includes('peel') && peeled(oid) !== oid ? ` peeled:${peeled(oid)}` : '';
        parts.push(pkt(`${oid} ${ref}${attrs}\n`));
      }
      if (!tip(r) && lines.includes('unborn') && keep('HEAD')) parts.push(pkt(`unborn HEAD symref-target:refs/heads/${r.default_branch}\n`));
      parts.push(flush);
    } else {
      const values = (prefix: string) => lines.filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length).split(' ')[0]);
      const wants = values('want '), haves = values('have '), oldBoundary = values('shallow ');
      const depth = Number(values('deepen ')[0] ?? Infinity);
      const held = reachable(haves, Infinity, new Set(oldBoundary)).found;
      const wanted = reachable(wants, depth);
      const send = [...wanted.found].filter(oid => !held.has(oid));
      const shallow = [...wanted.shallow], unshallow = oldBoundary.filter(oid => wanted.found.has(oid) && !wanted.shallow.has(oid));
      if (v2) {
        if (shallow.length || unshallow.length) parts.push(pkt('shallow-info\n'), ...shallow.map(oid => pkt(`shallow ${oid}\n`)), ...unshallow.map(oid => pkt(`unshallow ${oid}\n`)), delim);
        parts.push(pkt('packfile\n'));
      } else {
        parts.push(...shallow.map(oid => pkt(`shallow ${oid}\n`)), ...unshallow.map(oid => pkt(`unshallow ${oid}\n`)));
        if (shallow.length || unshallow.length) parts.push(flush);
        parts.push(pkt('NAK\n'));
      }
      parts.push(...bands(pack(send)), flush);
    }
  } else throw new ApiError(404, 'Not Found');
  return { data: Buffer.concat(parts), type: `application/x-${service}-${advertisement ? 'advertisement' : 'result'}` };
}
