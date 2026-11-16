import * as s from './store.ts';
import { objects, filesAt, makeTree, commit, tree } from './objects.ts';

export function rest(method: string, path: string, q: URLSearchParams, body: any, origin: string): { status: number; body?: any; headers?: Record<string, string> } {
  const ok = (body: any, status = 200, headers = {}) => ({ status, body, headers });
  const paginate = (list: any[]) => {
    const size = Math.max(1, Math.min(100, Number(q.get('per_page') ?? 30))), page = Math.max(1, Number(q.get('page') ?? 1));
    const headers: Record<string, string> = {};
    if (list.length > size * page) { const next = new URL(path, origin); next.search = q.toString(); next.searchParams.set('page', String(page + 1)); headers.link = `<${next}>; rel="next"`; }
    return ok(list.slice((page - 1) * size, page * size), 200, headers);
  };
  if (method === 'GET' && /^\/api\/v3\/?$/.test(path)) return ok({ current_user_url: '/api/v3/user' }, 200, { 'x-oauth-scopes': 'repo, read:org' });
  if (method === 'GET' && path === '/api/v3/meta') return ok({ installed_version: 'memory-forge-1.0' });
  if (method === 'GET' && path === '/api/v3/user') return ok(s.viewer);
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') return ok(s.repoView(s.createRepo(body)), 201);
    if (method === 'GET') return paginate([...s.repos.values()].map(s.repoView));
  }
  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) throw new s.ApiError(404, 'Not Found');
  const r = s.getRepo(m[1], m[2]), tail = m[3] ?? '';
  if (!tail) {
    if (method === 'GET') return ok(s.repoView(r));
    if (method === 'DELETE') { s.repos.delete(r.name); return { status: 204 }; }
    if (method === 'PATCH') {
      if (body.name !== undefined && body.name !== r.name) { if (s.repos.has(body.name)) throw new s.ApiError(422, 'Repository already exists'); s.repos.delete(r.name); r.name = body.name; s.repos.set(r.name, r); }
      for (const key of ['description', 'private', 'default_branch']) if (body[key] !== undefined) r[key] = body[key];
      r.updated_at = s.stamp(); return ok(s.repoView(r));
    }
  }
  if (tail === 'git/refs' && method === 'POST') {
    s.requireValue(typeof body.ref === 'string' && body.ref.startsWith('refs/') && objects.has(body.sha) && !r.refs.has(body.ref), 422, 'Invalid ref or SHA');
    r.refs.set(body.ref, body.sha); return ok({ ref: body.ref, object: { sha: body.sha, type: objects.get(body.sha)!.type } }, 201);
  }
  if (tail.startsWith('git/refs/') && method === 'GET') {
    const ref = tail.slice(9), sha = s.requireValue(r.refs.get(ref)); return ok({ ref, object: { sha } });
  }
  if (tail === 'branches' && method === 'GET') return paginate([...r.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } })));
  if (tail.startsWith('branches/') && method === 'GET') { const name = tail.slice(9), sha = s.requireValue(s.tip(r, name)); return ok({ name, commit: { sha } }); }
  if (tail === 'commits' && method === 'GET') {
    const todo = [s.tip(r, q.get('sha') ?? undefined)], seen = new Set<string>(), list = [];
    while (todo.length) { const sha = todo.shift()!; if (!sha || seen.has(sha)) continue; seen.add(sha); list.push(s.commitView(sha)); todo.push(...commit(sha).parents); }
    return paginate(list);
  }
  if (tail === 'contents' || tail.startsWith('contents/')) {
    const file = tail.slice(9).replace(/\/$/, '');
    if (method === 'PUT' || method === 'DELETE') { const reply = s.writeContent(r, file, body, method === 'DELETE'); return ok(reply.body, method === 'DELETE' ? 200 : reply.status); }
    if (method === 'GET') {
      const tip = s.tip(r, q.get('ref') ?? undefined), files = filesAt(tip), oid = files.get(file);
      if (oid) return ok(s.contentView(file, oid));
      let dir = commit(tip).tree;
      for (const part of file.split('/').filter(Boolean)) { const entry = tree(dir).find(e => e.name === part && /0?40000/.test(e.mode)); dir = s.requireValue(entry?.oid); }
      s.requireValue(dir);
      return ok(tree(dir).map(e => ({ type: /0?40000/.test(e.mode) ? 'dir' : 'file', name: e.name, path: file ? `${file}/${e.name}` : e.name, sha: e.oid })));
    }
  }
  if (tail === 'labels') {
    if (method === 'POST') { s.requireValue(body.name, 422, 'Name is required'); const label = { name: body.name, color: body.color ?? 'ededed', description: body.description ?? '' }; r.labels.set(label.name, label); return ok(label, 201); }
    if (method === 'GET') return ok([...r.labels.values()]);
  }
  if (tail === 'issues' || tail === 'pulls') {
    const pull = tail === 'pulls';
    if (method === 'POST') return ok(pull ? s.createPull(r, body) : s.createIssue(r, body), 201);
    if (method === 'GET') {
      const state = q.get('state') ?? 'open', direction = q.get('direction') === 'asc' ? 1 : -1;
      const list = [...(pull ? r.pulls : r.issues).values()].filter(i => state === 'all' || i.state === state).sort((a, b) => direction * (a.number - b.number));
      return paginate(list);
    }
  }
  const item = /^(issues|pulls)\/(\d+)(?:\/(comments|files|merge))?$/.exec(tail);
  if (item) {
    const pull = item[1] === 'pulls', n = Number(item[2]), value = s.requireValue((pull ? r.pulls : r.issues).get(n));
    if (!item[3]) {
      if (method === 'GET') return ok(value);
      if (method === 'PATCH') return ok(s.patchIssue(value, body));
    }
    if (item[3] === 'comments') {
      if (method === 'POST') return ok(s.addComment(r, n, body.body), 201);
      if (method === 'GET') return ok(r.comments.get(n) ?? []);
    }
    if (pull && item[3] === 'files' && method === 'GET') return ok(s.pullDiff(r, value));
    if (pull && item[3] === 'merge' && method === 'PUT') return ok(s.mergePull(r, value));
  }
  throw new s.ApiError(404, 'Not Found');
}
