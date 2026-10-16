/**
 * Serialises a filtered set of TIFF entries (IFD0 + Exif + GPS + Interop; never IFD1, MakerNote or
 * pointer/thumbnail tags) into a fresh, compact TIFF block. Keeps the original byte order, so raw
 * value bytes are copied unchanged.
 */
import { put16, put32, type Endian } from './binary';
import type { Field } from './catalog';
import { fieldsOfTiff, type IfdName, type Tiff, type TiffEntry } from './tiff';

/** Tags that are never copied: sub-IFD pointers (rebuilt), thumbnail pointers, MakerNote (absolute offsets). */
const NEVER = new Set([0x8769, 0x8825, 0xa005, 0x0201, 0x0202, 0x927c]);

export function writeTiff(endian: Endian, entries: TiffEntry[]): Uint8Array {
  const by = (ifd: IfdName) =>
    entries.filter((e) => e.ifd === ifd && !NEVER.has(e.tag)).sort((a, b) => a.tag - b.tag);
  const interop = by('Interop');
  const gps = by('GPS');
  const exif = by('ExifIFD');
  const ifd0 = by('IFD0');
  const hasExif = exif.length > 0 || interop.length > 0;

  type Plan = { name: IfdName; list: TiffEntry[]; pointers: [number, IfdName][]; at: number; valuesAt: number };
  const plans: Plan[] = [];
  const p0: Plan = { name: 'IFD0', list: ifd0, pointers: [], at: 0, valuesAt: 0 };
  if (hasExif) p0.pointers.push([0x8769, 'ExifIFD']);
  if (gps.length) p0.pointers.push([0x8825, 'GPS']);
  plans.push(p0);
  if (hasExif) plans.push({ name: 'ExifIFD', list: exif, pointers: interop.length ? [[0xa005, 'Interop']] : [], at: 0, valuesAt: 0 });
  if (interop.length) plans.push({ name: 'Interop', list: interop, pointers: [], at: 0, valuesAt: 0 });
  if (gps.length) plans.push({ name: 'GPS', list: gps, pointers: [], at: 0, valuesAt: 0 });

  const even = (n: number) => n + (n & 1);
  const valuesSize = (list: TiffEntry[]) => list.reduce((s, e) => s + (e.raw.length > 4 ? even(e.raw.length) : 0), 0);
  let pos = 8;
  for (const p of plans) {
    p.at = pos;
    const n = p.list.length + p.pointers.length;
    p.valuesAt = pos + 2 + n * 12 + 4;
    pos = p.valuesAt + valuesSize(p.list);
  }
  const out = new Uint8Array(pos);
  if (endian === 'LE') out.set([0x49, 0x49], 0);
  else out.set([0x4d, 0x4d], 0);
  put16(out, 2, 42, endian);
  put32(out, 4, 8, endian);
  const atOf = (name: IfdName) => plans.find((p) => p.name === name)!.at;

  for (const p of plans) {
    type Row = { tag: number; write: (o: number) => void };
    const rows: Row[] = [];
    let vpos = p.valuesAt;
    for (const e of p.list) {
      rows.push({
        tag: e.tag,
        write: (o) => {
          put16(out, o, e.tag, endian);
          put16(out, o + 2, e.type, endian);
          put32(out, o + 4, e.count, endian);
          if (e.raw.length <= 4) out.set(e.raw, o + 8);
          else {
            put32(out, o + 8, vpos, endian);
            out.set(e.raw, vpos);
            vpos += even(e.raw.length);
          }
        },
      });
    }
    for (const [tag, target] of p.pointers) {
      rows.push({
        tag,
        write: (o) => {
          put16(out, o, tag, endian);
          put16(out, o + 2, 4, endian);
          put32(out, o + 4, 1, endian);
          put32(out, o + 8, atOf(target), endian);
        },
      });
    }
    rows.sort((a, b) => a.tag - b.tag);
    put16(out, p.at, rows.length, endian);
    rows.forEach((r, i) => r.write(p.at + 2 + i * 12));
    put32(out, p.at + 2 + rows.length * 12, 0, endian);
  }
  return out;
}

/**
 * Rebuilds an Exif TIFF block keeping only entries for which `keep(field)` is true. Returns null when
 * nothing is kept. IFD1 (thumbnail) and MakerNote are never kept (they cannot be relocated safely).
 */
export function rebuildTiff(t: Tiff, keep: (f: Field) => boolean): { bytes: Uint8Array | null; kept: Field[] } {
  const entries: TiffEntry[] = [];
  const kept: Field[] = [];
  const fieldOf = fieldsOfTiff(t);
  for (const e of t.entries) {
    if (e.ifd === 'IFD1' || NEVER.has(e.tag) || e.raw.length === 0) continue;
    const f = fieldOf(e);
    if (keep(f)) {
      entries.push(e);
      kept.push(f);
    }
  }
  return { bytes: entries.length ? writeTiff(t.endian, entries) : null, kept };
}
