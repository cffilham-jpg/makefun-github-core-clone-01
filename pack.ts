import { inflateSync, deflateSync } from 'node:zlib';
import { digest, objects, put, type GitObject } from './objects.ts';

const types = ['', 'commit', 'tree', 'blob', 'tag'];
const compressed = new Map<string, Buffer>();
export function pack(oids: Iterable<string>): Buffer {
  const list = [...oids], header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  const parts = [header];
  for (const oid of list) {
    let entry = compressed.get(oid);
    if (!entry) {
      const obj = objects.get(oid)!;
      let size = obj.data.length, byte = (types.indexOf(obj.type) << 4) | (size & 15);
      size = Math.floor(size / 16);
      const bytes = [];
      while (size) { bytes.push(byte | 128); byte = size & 127; size = Math.floor(size / 128); }
      bytes.push(byte);
      entry = Buffer.concat([Buffer.from(bytes), deflateSync(obj.data, { level: 1 })]); compressed.set(oid, entry);
    }
    parts.push(entry);
  }
  const data = Buffer.concat(parts); return Buffer.concat([data, digest(data)]);
}
function delta(base: Buffer, instructions: Buffer): Buffer {
  let i = 0;
  const integer = () => { let n = 0, shift = 0, byte; do { if (i >= instructions.length) throw new Error('Truncated delta'); byte = instructions[i++]; n += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128); return n; };
  if (integer() !== base.length) throw new Error('Wrong delta base size');
  const size = integer(), out = Buffer.alloc(size); let cursor = 0;
  while (i < instructions.length) {
    const op = instructions[i++];
    if (op & 128) {
      let offset = 0, length = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) offset += instructions[i++] * 2 ** (b * 8);
      for (let b = 0; b < 3; b++) if (op & (16 << b)) length += instructions[i++] * 2 ** (b * 8);
      if (!length) length = 65536;
      if (offset + length > base.length || cursor + length > size) throw new Error('Delta copy out of range');
      base.copy(out, cursor, offset, offset + length); cursor += length;
    } else {
      if (!op || i + op > instructions.length || cursor + op > size) throw new Error('Invalid delta insert');
      instructions.copy(out, cursor, i, i + op); i += op; cursor += op;
    }
  }
  if (cursor !== size) throw new Error('Wrong delta target size');
  return out;
}
export function unpack(data: Buffer) {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(data.readUInt32BE(4))) throw new Error('Invalid pack header');
  if (!digest(data.subarray(0, -20)).equals(data.subarray(-20))) throw new Error('Pack checksum mismatch');
  const count = data.readUInt32BE(8), entries: any[] = [], offsets = new Map<number, any>();
  let i = 12;
  for (let n = 0; n < count; n++) {
    const offset = i, first = data[i++], code = (first >> 4) & 7;
    let byte = first, size = first & 15, shift = 4;
    while (byte & 128) { byte = data[i++]; size += (byte & 127) * 2 ** shift; shift += 7; }
    const e: any = { code, offset };
    if (code === 6) {
      byte = data[i++]; let distance = byte & 127;
      while (byte & 128) { byte = data[i++]; distance = (distance + 1) * 128 + (byte & 127); }
      e.baseOffset = offset - distance;
    } else if (code === 7) { e.baseOid = data.subarray(i, i + 20).toString('hex'); i += 20; }
    else if (!types[code]) throw new Error('Unknown pack type');
    const result: any = inflateSync(data.subarray(i, -20), { info: true });
    e.data = result.buffer; i += result.engine.bytesWritten;
    if (e.data.length !== size) throw new Error('Pack object length mismatch');
    entries.push(e); offsets.set(offset, e);
  }
  if (i !== data.length - 20) throw new Error('Pack trailing bytes');
  const staged = new Map<string, GitObject>();
  const resolve = (e: any): GitObject | undefined => {
    if (e.object) return e.object;
    let obj: GitObject;
    if (e.code < 5) obj = { type: types[e.code], data: e.data };
    else {
      const base = e.code === 6 ? (offsets.has(e.baseOffset) ? resolve(offsets.get(e.baseOffset)) : undefined) : staged.get(e.baseOid) ?? objects.get(e.baseOid);
      if (!base) return undefined;
      obj = { type: base.type, data: delta(base.data, e.data) };
    }
    // Compute ids without mutating the live object store until every entry resolves.
    const oid = digest(Buffer.concat([Buffer.from(`${obj.type} ${obj.data.length}\0`), obj.data])).toString('hex');
    e.object = obj; staged.set(oid, obj); return obj;
  };
  let pending = entries;
  while (pending.length) {
    const remaining = pending.filter(e => !resolve(e));
    if (remaining.length === pending.length) throw new Error('Missing delta base');
    pending = remaining;
  }
  for (const [oid, obj] of staged) objects.set(oid, obj);
}
