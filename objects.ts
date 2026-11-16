import { createHash } from 'node:crypto';

export type GitObject = { type: string; data: Buffer };
export const objects = new Map<string, GitObject>();
export const zero = '0'.repeat(40);
export const digest = (data: Buffer) => createHash('sha1').update(data).digest();
export function put(type: string, value: Buffer | string): string {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const oid = createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  objects.set(oid, { type, data });
  return oid;
}
export function commit(oid: string) {
  const text = objects.get(oid)?.data.toString() ?? '';
  const split = text.indexOf('\n\n');
  const lines = text.slice(0, split).split('\n');
  return {
    tree: lines.find(l => l.startsWith('tree '))?.slice(5) ?? '',
    parents: lines.filter(l => l.startsWith('parent ')).map(l => l.slice(7)),
    author: lines.find(l => l.startsWith('author '))?.slice(7) ?? '',
    committer: lines.find(l => l.startsWith('committer '))?.slice(10) ?? '',
    message: split < 0 ? '' : text.slice(split + 2),
  };
}
export function tree(oid: string): { mode: string; name: string; oid: string }[] {
  const data = objects.get(oid)?.data ?? Buffer.alloc(0);
  const entries = [];
  for (let i = 0; i < data.length;) {
    const space = data.indexOf(32, i), nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('Invalid tree');
    entries.push({ mode: data.toString('ascii', i, space), name: data.toString('utf8', space + 1, nul), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return entries;
}
export function makeTree(files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const direct: any[] = [], dirs = new Set<string>();
    for (const [path, oid] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length), slash = rest.indexOf('/');
      if (slash < 0) direct.push({ name: rest, oid, mode: '100644' });
      else dirs.add(rest.slice(0, slash));
    }
    for (const name of dirs) direct.push({ name, mode: '40000', oid: build(`${prefix}${name}/`) });
    direct.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return put('tree', Buffer.concat(direct.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]))));
  };
  return build('');
}
export function filesAt(tip: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (oid: string, prefix: string) => {
    for (const e of tree(oid)) {
      if (e.mode === '40000' || e.mode === '040000') walk(e.oid, `${prefix}${e.name}/`);
      else files.set(prefix + e.name, e.oid);
    }
  };
  if (tip) walk(commit(tip).tree, '');
  return files;
}
export function ancestors(tip: string): Set<string> {
  const found = new Set<string>(), todo = [tip];
  while (todo.length) {
    const oid = todo.pop()!;
    if (!oid || found.has(oid)) continue;
    found.add(oid);
    if (objects.get(oid)?.type === 'commit') todo.push(...commit(oid).parents);
  }
  return found;
}
export function mergeBase(a: string, b: string): string {
  const left = ancestors(a), todo = [b], seen = new Set<string>();
  while (todo.length) {
    const oid = todo.shift()!;
    if (left.has(oid)) return oid;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid); todo.push(...commit(oid).parents);
  }
  return '';
}
export function reachable(roots: string[], depth = Infinity, boundaries = new Set<string>()) {
  const found = new Set<string>(), shallow = new Set<string>();
  const visit = (oid: string, level: number) => {
    if (!oid || found.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    found.add(oid);
    if (obj.type === 'commit') {
      const c = commit(oid); visit(c.tree, level);
      if (level >= depth || boundaries.has(oid)) { if (c.parents.length) shallow.add(oid); }
      else for (const parent of c.parents) visit(parent, level + 1);
    } else if (obj.type === 'tree') for (const e of tree(oid)) { if (e.mode !== '160000') visit(e.oid, level); }
    else if (obj.type === 'tag') visit(obj.data.toString().match(/^object ([0-9a-f]{40})/)?.[1] ?? '', level);
  };
  for (const root of roots) visit(root, 1);
  return { found, shallow };
}
