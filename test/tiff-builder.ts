/**
 * Byte-wise builders for the V1.5-1 review probes (ported from the reviewer's scratchpad `ss-review/probes/lib.ts`,
 * 2026-10-16): a little-endian TIFF assembler with named blobs and directories, GIF block helpers, an in-memory ByteFile.
 * Test-only; no engine code.
 */
import { MAX_READ_BYTES, type ByteFile } from '@/engine/byte-file';

export class MemFile implements ByteFile {
  b: Uint8Array;
  constructor(b: Uint8Array, private readOnly = false) {
    this.b = new Uint8Array(b);
  }
  get size() {
    return this.b.length;
  }
  read(o: number, n: number) {
    if (n > MAX_READ_BYTES) throw new RangeError('too big');
    if (!Number.isInteger(o) || o < 0) throw new RangeError(`bad offset ${o}`);
    return this.b.slice(o, Math.min(this.b.length, o + n));
  }
  write(o: number, d: Uint8Array) {
    if (this.readOnly) throw new Error('read only');
    if (o > this.b.length) throw new RangeError('write past end');
    if (o + d.length > this.b.length) {
      const nb = new Uint8Array(o + d.length);
      nb.set(this.b);
      this.b = nb;
    }
    this.b.set(d, o);
  }
  close() {}
}

export type Val =
  | { t: 1 | 7; b: Uint8Array }
  | { t: 2; s: string }
  | { t: 3; v: number[] }
  | { t: 4 | 13; v: (number | { ref: string })[] }
  | { t: 5; r: [number, number][] };
/** A directory entry; `at` forces the value out of line at a named blob. */
export interface E {
  tag: number;
  val: Val;
  at?: { ref: string };
}
export interface IfdSpec {
  kind: 'ifd';
  name: string;
  entries: E[];
  next?: { ref: string } | number;
}
export interface BlobSpec {
  kind: 'blob';
  name: string;
  bytes: Uint8Array;
}
export type Item = IfdSpec | BlobSpec;

export const txt = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));

function valBytes(v: Val, resolve: (r: { ref: string }) => number): { type: number; count: number; bytes: Uint8Array } {
  switch (v.t) {
    case 1:
    case 7:
      return { type: v.t, count: v.b.length, bytes: v.b };
    case 2: {
      const b = txt(`${v.s}\0`);
      return { type: 2, count: b.length, bytes: b };
    }
    case 3: {
      const b = Buffer.alloc(v.v.length * 2);
      v.v.forEach((x, i) => b.writeUInt16LE(x, i * 2));
      return { type: 3, count: v.v.length, bytes: b };
    }
    case 4:
    case 13: {
      const b = Buffer.alloc(v.v.length * 4);
      v.v.forEach((x, i) => b.writeUInt32LE(typeof x === 'number' ? x : resolve(x), i * 4));
      return { type: v.t, count: v.v.length, bytes: b };
    }
    case 5: {
      const b = Buffer.alloc(v.r.length * 8);
      v.r.forEach(([n, d], i) => {
        b.writeUInt32LE(n, i * 8);
        b.writeUInt32LE(d, i * 8 + 4);
      });
      return { type: 5, count: v.r.length, bytes: b };
    }
  }
}

/** Lays out header + items in order. IFD values > 4 bytes follow their IFD (unless `at` names a blob). */
export function tiff(items: Item[], first = 'IFD0'): Uint8Array {
  let pos = new Map<string, number>();
  let out = Buffer.alloc(0);
  for (let pass = 0; pass < 3; pass++) {
    const resolve = (r: { ref: string }) => pos.get(r.ref) ?? 0;
    const parts: Buffer[] = [];
    let at = 8;
    const np = new Map<string, number>();
    for (const it of items) {
      if (at % 2) {
        parts.push(Buffer.alloc(1));
        at++;
      }
      np.set(it.name, at);
      if (it.kind === 'blob') {
        parts.push(Buffer.from(it.bytes));
        at += it.bytes.length;
        continue;
      }
      const n = it.entries.length;
      const table = Buffer.alloc(2 + 12 * n + 4);
      table.writeUInt16LE(n, 0);
      const extra: Buffer[] = [];
      let xat = at + table.length;
      it.entries.forEach((e, i) => {
        const vb = valBytes(e.val, resolve);
        const o = 2 + 12 * i;
        table.writeUInt16LE(e.tag, o);
        table.writeUInt16LE(vb.type, o + 2);
        table.writeUInt32LE(vb.count, o + 4);
        if (vb.bytes.length <= 4 && !e.at) Buffer.from(vb.bytes).copy(table, o + 8);
        else if (e.at) table.writeUInt32LE(resolve(e.at), o + 8);
        else {
          if (xat % 2) {
            extra.push(Buffer.alloc(1));
            xat++;
          }
          table.writeUInt32LE(xat, o + 8);
          extra.push(Buffer.from(vb.bytes));
          xat += vb.bytes.length;
        }
      });
      const nx = it.next === undefined ? 0 : typeof it.next === 'number' ? it.next : resolve(it.next);
      table.writeUInt32LE(nx, 2 + 12 * n);
      parts.push(table, ...extra);
      at = xat;
    }
    const head = Buffer.from([0x49, 0x49, 42, 0, 0, 0, 0, 0]);
    head.writeUInt32LE(np.get(first) ?? 8, 4);
    out = Buffer.concat([head, ...parts]);
    pos = np;
  }
  return Uint8Array.from(out);
}

/** 8x8 8-bit grey picture tags pointing at blob `strip`. */
export function picTags(strip = 'strip', w = 8, h = 8): E[] {
  return [
    { tag: 0x100, val: { t: 3, v: [w] } },
    { tag: 0x101, val: { t: 3, v: [h] } },
    { tag: 0x102, val: { t: 3, v: [8] } },
    { tag: 0x103, val: { t: 3, v: [1] } },
    { tag: 0x106, val: { t: 3, v: [1] } },
    { tag: 0x111, val: { t: 4, v: [{ ref: strip }] } },
    { tag: 0x115, val: { t: 3, v: [1] } },
    { tag: 0x116, val: { t: 3, v: [h] } },
    { tag: 0x117, val: { t: 4, v: [w * h] } },
  ];
}
export const pixels = (n = 64, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xff);
export const gpsEntries = (area = 'HOME-ADDR-123'): E[] => [
  { tag: 0x0000, val: { t: 1, b: Uint8Array.from([2, 3, 0, 0]) } },
  { tag: 0x0001, val: { t: 2, s: 'N' } },
  { tag: 0x0002, val: { t: 5, r: [[52, 1], [31, 1], [1234, 100]] } },
  { tag: 0x0003, val: { t: 2, s: 'E' } },
  { tag: 0x0004, val: { t: 5, r: [[13, 1], [24, 1], [5678, 100]] } },
  { tag: 0x001c, val: { t: 7, b: txt(`ASCII\0\0\0${area}`) } },
];

/** Concatenates numbers, byte arrays and latin-1 strings. */
export const bytes = (...a: (number[] | Uint8Array | string)[]) =>
  Uint8Array.from(Buffer.concat(a.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x as Uint8Array)))));
/** GIF data sub-blocks with the terminator. */
export function sub(data: Uint8Array | string): Uint8Array {
  const d = typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data);
  const parts: Buffer[] = [];
  for (let i = 0; i < d.length; i += 255) {
    const c = d.subarray(i, i + 255);
    parts.push(Buffer.from([c.length]), c);
  }
  parts.push(Buffer.from([0]));
  return Uint8Array.from(Buffer.concat(parts));
}
/** A 2x2 GIF header with a 2-colour table, one frame. */
export const gifHead = bytes('GIF89a', [2, 0, 2, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255]);
export const gifFrame = bytes([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0], [2], [2, 0x4c, 0x01, 0]);
export const gifApp = (id: string, payload: Uint8Array) => bytes([0x21, 0xff, id.length], id, payload);
