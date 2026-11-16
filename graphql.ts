import * as s from './store.ts';

type Field = { name: string; alias: string; args: Record<string, any>; fields: Field[] };
function parse(source: string, variables: any): Field[] {
  const tokens = source.match(/\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|[^\s,#]/g) ?? [];
  let i = 0;
  const expect = (value: string) => { if (tokens[i++] !== value) throw new Error(`Expected ${value}`); };
  function value(): any {
    const token = tokens[i++];
    if (token === '$') return variables[tokens[i++]];
    if (token === '{') {
      const obj: any = {}; while (tokens[i] !== '}') { const key = tokens[i++]; expect(':'); obj[key] = value(); } i++; return obj;
    }
    if (token === '[') { const list = []; while (tokens[i] !== ']') list.push(value()); i++; return list; }
    if (token?.startsWith('"')) return JSON.parse(token);
    if (token === 'true' || token === 'false' || token === 'null') return JSON.parse(token);
    if (/^-?\d/.test(token ?? '')) return Number(token);
    return token;
  }
  function selection(): Field[] {
    expect('{'); const out: Field[] = [];
    while (i < tokens.length && tokens[i] !== '}') {
      if (tokens[i] === '...') { i++; if (tokens[i] === 'on') { i += 2; out.push(...selection()); } else throw new Error('Named fragments are unsupported'); continue; }
      let name = tokens[i++], alias = name;
      if (tokens[i] === ':') { i++; name = tokens[i++]; }
      const args: any = {};
      if (tokens[i] === '(') { i++; while (i < tokens.length && tokens[i] !== ')') { const key = tokens[i++]; expect(':'); args[key] = value(); } expect(')'); }
      while (tokens[i] === '@') { i += 2; if (tokens[i] === '(') { let level = 0; do { const t = tokens[i++]; if (t === '(') level++; if (t === ')') level--; } while (level && i < tokens.length); } }
      const fields = tokens[i] === '{' ? selection() : [];
      out.push({ name, alias, args, fields });
    }
    expect('}'); return out;
  }
  if (tokens[0] === 'query' || tokens[0] === 'mutation') {
    i++;
    if (tokens[i] !== '(' && tokens[i] !== '{') i++;
    if (tokens[i] === '(') { let depth = 0; do { const t = tokens[i++]; if (t === '(') depth++; if (t === ')') depth--; } while (depth && i < tokens.length); }
  }
  return selection();
}
const schema: Record<string, string[]> = {
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
};
type Entity = { kind: string; value: any; repo?: s.Repo };
const entity = (kind: string, value: any, repo?: s.Repo): Entity | null => value == null ? null : ({ kind, value, repo });
function byId(id: string): Entity | null {
  const [kind, idText, number] = Buffer.from(id ?? '', 'base64').toString().split(':');
  const repo = [...s.repos.values()].find(r => r.id === Number(idText));
  if (!repo) return null;
  if (kind === 'Repository') return entity(kind, repo, repo);
  return entity(kind, (kind === 'Issue' ? repo.issues : repo.pulls).get(Number(number)), repo);
}
function connection(nodes: Entity[], args: any) {
  let offset = 0;
  if (args.after) { const decoded = Buffer.from(args.after, 'base64').toString(); offset = Number(decoded.split(':')[1] ?? 0); }
  const size = Math.max(0, Math.min(100, args.first ?? 30)), page = nodes.slice(offset, offset + size);
  const cursor = (index: number) => Buffer.from(`cursor:${index}`).toString('base64');
  return entity('Plain', { nodes: page, edges: page.map((node, i) => entity('Plain', { node, cursor: cursor(offset + i + 1) })), totalCount: nodes.length, pageInfo: entity('Plain', { hasNextPage: offset + size < nodes.length, endCursor: page.length ? cursor(offset + page.length) : null, hasPreviousPage: offset > 0, startCursor: page.length ? cursor(offset + 1) : null }) });
}
function resolve(parent: Entity, f: Field): any {
  const { kind, value: v, repo: r } = parent, a = f.args, name = f.name;
  if (name === '__typename') return kind;
  if (kind === 'Root') {
    if (name === 'viewer') return entity('User', s.viewer);
    if (name === '__type') return entity('Plain', { name: a.name, fields: (schema[a.name] ?? []).map(name => entity('Plain', { name })), enumValues: (a.name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER'] : []).map(name => entity('Plain', { name })) });
    if (name === 'repository') { const repo = a.owner === s.viewer.login ? s.repos.get(a.name) : null; return entity('Repository', repo, repo ?? undefined); }
    if (name === 'node') return byId(a.id);
    const input = a.input ?? {};
    if (name === 'createIssue') { const target = s.requireValue(byId(input.repositoryId)); const issue = s.createIssue(target.value, input); return entity('Plain', { issue: entity('Issue', issue, target.value) }); }
    if (name === 'closeIssue') { const target = s.requireValue(byId(input.issueId)); return entity('Plain', { issue: entity('Issue', s.patchIssue(target.value, { state: 'closed' }), target.repo) }); }
    if (name === 'createPullRequest') { const target = s.requireValue(byId(input.repositoryId)); const p = s.createPull(target.value, { ...input, head: input.headRefName, base: input.baseRefName }); return entity('Plain', { pullRequest: entity('PullRequest', p, target.value) }); }
    if (name === 'mergePullRequest') { const target = s.requireValue(byId(input.pullRequestId)); s.mergePull(target.repo, target.value); return entity('Plain', { pullRequest: target }); }
    if (name === 'addComment') { const target = s.requireValue(byId(input.subjectId)); const c = s.addComment(target.repo, target.value.number, input.body); return entity('Plain', { commentEdge: entity('Plain', { node: entity('Plain', { id: c.node_id, body: c.body }) }) }); }
  }
  if (kind === 'Repository') {
    if (name === 'id') return s.globalId('Repository', v.id);
    if (name === 'databaseId') return v.id;
    if (name === 'nameWithOwner') return `${s.viewer.login}/${v.name}`;
    if (name === 'owner') return entity('User', s.viewer);
    if (name === 'defaultBranchRef') return s.tip(v) ? entity('Plain', { name: v.default_branch }) : null;
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') return entity('Issue', v.issues.get(a.number), v);
    if (name === 'pullRequest') return entity('PullRequest', v.pulls.get(a.number), v);
    if (name === 'issues' || name === 'pullRequests') {
      const pull = name === 'pullRequests';
      const list = [...(pull ? v.pulls : v.issues).values()].filter(item => !a.states || a.states.includes(item.merged ? 'MERGED' : item.state.toUpperCase()));
      list.sort((x, y) => (a.orderBy?.direction === 'ASC' ? 1 : -1) * (x.number - y.number));
      return connection(list.map(item => entity(pull ? 'PullRequest' : 'Issue', item, v)!), a);
    }
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    if (name === 'id') return v.node_id;
    if (name === 'databaseId') return v.id;
    if (name === 'state') return v.merged ? 'MERGED' : v.state.toUpperCase();
    if (name === 'headRefName') return v.head.ref;
    if (name === 'baseRefName') return v.base.ref;
    if (name === 'mergeable') return v.mergeable ? 'MERGEABLE' : 'CONFLICTING';
    if (name === 'files') return connection(s.pullDiff(r!, v).map(file => entity('Plain', { path: file.filename, additions: file.additions, deletions: file.deletions })!), a);
    if (name === 'author') return entity('User', s.viewer);
  }
  if (Object.hasOwn(v, name)) return v[name];
  throw new Error(`Cannot query field "${name}" on type "${kind}"`);
}
function execute(parent: Entity, fields: Field[]): any {
  const output: any = {};
  const project = (value: any, fields: Field[]): any => {
    if (value == null) return null;
    if (Array.isArray(value)) return value.map(item => project(item, fields));
    if (!fields.length) return value;
    return execute(value.kind ? value : { kind: 'Plain', value }, fields);
  };
  for (const field of fields) output[field.alias] = project(resolve(parent, field), field.fields);
  return output;
}
export function graphql(body: any): any {
  if (Array.isArray(body)) return body.map(graphql);
  try { return { data: execute({ kind: 'Root', value: {} }, parse(body.query ?? '', body.variables ?? {})) }; }
  catch (error) { return { data: null, errors: [{ message: (error as Error).message }] }; }
}
