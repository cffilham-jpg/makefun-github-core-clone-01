import * as s from './store.ts';
const toolSpec = [
  ['create_repo', 'Create a repository owned by the viewer.', ['name'], ['name', 'description', 'private']],
  ['get_repo', 'Read a repository.', ['owner', 'repo'], ['owner', 'repo', 'full_name']],
  ['create_issue', 'Open an issue in a repository.', ['owner', 'repo', 'title'], ['owner', 'repo', 'full_name', 'title', 'body']],
  ['list_issues', 'List repository issues by state.', ['owner', 'repo'], ['owner', 'repo', 'full_name', 'state']],
  ['create_pull_request', 'Open a pull request between existing branches.', ['owner', 'repo', 'title', 'head', 'base'], ['owner', 'repo', 'full_name', 'title', 'body', 'head', 'base']],
  ['merge_pull_request', 'Squash merge a clean pull request.', ['owner', 'repo', 'pull_number'], ['owner', 'repo', 'full_name', 'pull_number']],
] as const;
const tools = toolSpec.map(([name, description, required, fields]) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(fields.map(key => [key, { type: key === 'private' ? 'boolean' : key === 'pull_number' ? 'integer' : 'string' }])), required: [...required] } }));
const identity = { name: 'Memory Forge', version: '1.0.0' };
export function mcp(body: any) {
  const reply: any = { jsonrpc: '2.0', id: body.id ?? null };
  const error = (code: number, message: string) => ({ ...reply, error: { code, message } });
  if (body.method === 'initialize') return { ...reply, result: { protocolVersion: body.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: identity } };
  if (body.method === 'server/discover') return { ...reply, result: { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, serverInfo: identity } };
  if (body.method === 'tools/list') return { ...reply, result: { tools } };
  if (body.method === 'ping') return { ...reply, result: {} };
  if (body.method !== 'tools/call') return error(-32601, 'Method not found');
  const name = body.params?.name, args = { ...(body.params?.arguments ?? {}) };
  const tool = tools.find(t => t.name === name);
  if (!tool) return error(-32602, 'Unknown tool');
  if (args.full_name) { const [owner, repo] = args.full_name.split('/'); args.owner ??= owner; args.repo ??= repo; }
  for (const key of tool.inputSchema.required) if (args[key] === undefined || args[key] === '') return error(-32602, `Missing required argument: ${key}`);
  try {
    let result: any;
    if (name === 'create_repo') result = s.repoView(s.createRepo(args));
    else {
      const repo = s.getRepo(args.owner, args.repo);
      if (name === 'get_repo') result = s.repoView(repo);
      if (name === 'create_issue') result = s.createIssue(repo, args);
      if (name === 'list_issues') result = [...repo.issues.values()].filter(i => args.state === 'all' || i.state === (args.state ?? 'open'));
      if (name === 'create_pull_request') result = s.createPull(repo, args);
      if (name === 'merge_pull_request') result = s.mergePull(repo, s.requireValue(repo.pulls.get(Number(args.pull_number))));
    }
    return { ...reply, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
  } catch (err) { return { ...reply, result: { isError: true, content: [{ type: 'text', text: (err as Error).message }] } }; }
}
