import { put, objects, commit, filesAt, makeTree, mergeBase } from './objects.ts';

export const viewer = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const repos = new Map<string, Repo>();
let repoId = 5000, itemId = 10000, clock = 0;
const epoch = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T00:00:00Z');
export const stamp = () => new Date(epoch + clock++ * 1000).toISOString();
export const globalId = (type: string, ...parts: (string | number)[]) => Buffer.from([type, ...parts].join(':')).toString('base64');
export class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export function requireValue(value: any, status = 404, message = 'Not Found'): any { if (!value) throw new ApiError(status, message); return value; }
export type Repo = { id: number; name: string; private: boolean; description: string; default_branch: string; created_at: string; updated_at: string; refs: Map<string, string>; issues: Map<number, any>; pulls: Map<number, any>; labels: Map<string, any>; comments: Map<number, any[]>; next: number };
export function createRepo(input: any): Repo {
  requireValue(typeof input.name === 'string' && /^[\w.-]+$/.test(input.name), 422, 'Invalid repository name');
  if (repos.has(input.name)) throw new ApiError(422, 'Repository already exists');
  const now = stamp();
  const r: Repo = { id: repoId++, name: input.name, private: !!input.private, description: input.description ?? '', default_branch: input.default_branch ?? 'main', created_at: now, updated_at: now, refs: new Map(), issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(), next: 1 };
  repos.set(r.name, r); return r;
}
export function getRepo(owner: string, name: string): Repo { return requireValue(owner === viewer.login && repos.get(name)); }
export function repoView(r: Repo) {
  return { id: r.id, node_id: globalId('Repository', r.id), name: r.name, full_name: `${viewer.login}/${r.name}`, owner: viewer, private: r.private, description: r.description, default_branch: r.default_branch, created_at: r.created_at, updated_at: r.updated_at, has_issues: true, fork: false, visibility: r.private ? 'private' : 'public' };
}
export function tip(r: Repo, branch?: string) { const ref = branch ?? r.default_branch; return r.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? (objects.has(ref) ? ref : ''); }
export function newCommit(r: Repo, branch: string, tree: string, message: string, parents?: string[]): string {
  const time = Math.floor(Date.parse(stamp()) / 1000), who = `${viewer.name} <${viewer.email}> ${time} +0000`;
  const old = tip(r, branch);
  const list = parents ?? (old ? [old] : []);
  const sha = put('commit', `tree ${tree}\n${list.map(p => `parent ${p}\n`).join('')}author ${who}\ncommitter ${who}\n\n${message}`);
  r.refs.set(`refs/heads/${branch}`, sha); return sha;
}
export function contentView(path: string, sha: string) {
  const data = objects.get(sha)?.data ?? Buffer.alloc(0);
  return { type: 'file', name: path.split('/').pop(), path, sha, size: data.length, encoding: 'base64', content: data.toString('base64') };
}
export function writeContent(r: Repo, path: string, input: any, remove = false) {
  const branch = input.branch ?? r.default_branch, old = tip(r, branch);
  if (!old && branch !== r.default_branch) throw new ApiError(404, 'Branch not found');
  const files = filesAt(old), previous = files.get(path);
  if (remove && !previous) throw new ApiError(404, 'Not Found');
  if ((previous && previous !== input.sha) || (!previous && input.sha)) throw new ApiError(409, 'Content SHA does not match');
  let sha = '';
  if (remove) files.delete(path);
  else { requireValue(typeof input.content === 'string', 422, 'Content is required'); sha = put('blob', Buffer.from(input.content, 'base64')); files.set(path, sha); }
  const commitSha = newCommit(r, branch, makeTree(files), input.message ?? 'Update contents');
  return { status: previous ? 200 : 201, body: { content: remove ? null : contentView(path, sha), commit: { sha: commitSha } } };
}
export function createIssue(r: Repo, input: any) {
  requireValue(typeof input.title === 'string' && input.title.length, 422, 'Title is required');
  const labels = (input.labels ?? []).map((name: any) => requireValue(r.labels.get(typeof name === 'string' ? name : name.name), 422, 'Unknown label'));
  const now = stamp(), number = r.next++, id = itemId++;
  const issue = { id, node_id: globalId('Issue', r.id, number), number, title: input.title, body: input.body ?? '', state: 'open', labels, user: viewer, created_at: now, updated_at: now, closed_at: null, comments: 0 };
  r.issues.set(number, issue); return issue;
}
export function patchIssue(issue: any, input: any) {
  for (const key of ['title', 'body', 'state']) if (input[key] !== undefined) issue[key] = input[key];
  issue.updated_at = stamp(); issue.closed_at = issue.state === 'closed' ? issue.updated_at : null; return issue;
}
export function addComment(r: Repo, number: number, body: string) {
  const issue = requireValue(r.issues.get(number) ?? r.pulls.get(number));
  requireValue(typeof body === 'string', 422, 'Body is required');
  const id = itemId++, now = stamp();
  const comment = { id, node_id: globalId('IssueComment', id), body, user: viewer, created_at: now, updated_at: now };
  if (!r.comments.has(number)) r.comments.set(number, []);
  r.comments.get(number)!.push(comment); issue.comments++; return comment;
}
export function createPull(r: Repo, input: any) {
  requireValue(input.title && input.head && input.base, 422, 'Title, head and base are required');
  const head = input.head.split(':').pop(), base = input.base;
  const headSha = requireValue(tip(r, head), 422, 'Head branch not found'), baseSha = requireValue(tip(r, base), 422, 'Base branch not found');
  const number = r.next++, now = stamp();
  const p = { id: itemId++, node_id: globalId('PullRequest', r.id, number), number, title: input.title, body: input.body ?? '', state: 'open', head: { ref: head, sha: headSha, label: `${viewer.login}:${head}` }, base: { ref: base, sha: baseSha, label: `${viewer.login}:${base}` }, merged: false, mergeable: true, merged_at: null, merge_commit_sha: null, user: viewer, created_at: now, updated_at: now, comments: 0 };
  r.pulls.set(number, p); return p;
}
export function pullDiff(r: Repo, p: any) {
  const head = tip(r, p.head.ref), base = tip(r, p.base.ref), ancestor = mergeBase(head, base);
  const before = filesAt(ancestor), after = filesAt(head);
  const lines = (oid?: string) => { const text = oid ? objects.get(oid)?.data.toString() ?? '' : ''; return text ? text.replace(/\n$/, '').split('\n').length : 0; };
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path) !== after.get(path)).map(path => {
    const a = before.get(path), b = after.get(path), additions = lines(b), deletions = lines(a);
    return { filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', additions, deletions, changes: additions + deletions };
  });
}
export function mergePull(r: Repo, p: any) {
  requireValue(p, 404);
  const head = tip(r, p.head.ref), base = tip(r, p.base.ref), common = filesAt(mergeBase(head, base));
  const left = filesAt(base), right = filesAt(head);
  for (const path of new Set([...common.keys(), ...left.keys(), ...right.keys()])) {
    const original = common.get(path), a = left.get(path), b = right.get(path);
    if (a !== original && b !== original && a !== b) { p.mergeable = false; throw new ApiError(405, 'Pull request has merge conflicts'); }
  }
  const sha = newCommit(r, p.base.ref, commit(head).tree, p.title, [base]);
  p.state = 'closed'; p.merged = true; p.merged_at = stamp(); p.updated_at = p.merged_at; p.merge_commit_sha = sha;
  return { sha, merged: true, message: 'Pull request successfully merged' };
}
export function commitView(sha: string) {
  const c = commit(sha);
  const person = (line: string) => {
    const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    return { name: m?.[1] ?? '', email: m?.[2] ?? '', date: new Date(Number(m?.[3] ?? 0) * 1000).toISOString() };
  };
  return { sha, commit: { message: c.message, author: person(c.author), committer: person(c.committer), tree: { sha: c.tree } }, parents: c.parents.map(sha => ({ sha })) };
}
