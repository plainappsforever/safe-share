/** EXIF/TIFF IFD parser: IFD0, Exif IFD, GPS IFD, Interop IFD, IFD1 (thumbnail), MakerNote presence. */
import { ascii, u16, u32, i32, utf16, utf8, type Endian } from './binary';
import { describeExif, makeField, type Field } from './catalog';

export type IfdName = 'IFD0' | 'ExifIFD' | 'GPS' | 'Interop' | 'IFD1';

export interface TiffEntry {
  ifd: IfdName;
  tag: number;
  type: number;
  count: number;
  /** Value bytes in the file's byte order (inline or out-of-line). */
  raw: Uint8Array;
}

export interface Tiff {
  endian: Endian;
  entries: TiffEntry[];
  /** Offset/length of the IFD1 JPEG thumbnail inside the TIFF block, if any. */
  thumbnail?: { offset: number; length: number };
  errors: string[];
}

export const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
export const POINTER_TAGS: Record<number, IfdName> = { 0x8769: 'ExifIFD', 0x8825: 'GPS', 0xa005: 'Interop' };
export const TAG_ORIENTATION = 0x0112;

/** Parses a TIFF block (starting at "II*\0" / "MM\0*"). Tolerant: bad offsets are recorded in `errors`. */
export function parseTiff(b: Uint8Array): Tiff | null {
  if (b.length < 8) return null;
  const endian: Endian | null = b[0] === 0x49 && b[1] === 0x49 ? 'LE' : b[0] === 0x4d && b[1] === 0x4d ? 'BE' : null;
  if (!endian || u16(b, 2, endian) !== 42) return null;
  const t: Tiff = { endian, entries: [], errors: [] };
  const visited = new Set<number>();

  const readIfd = (offset: number, ifd: IfdName): number => {
    if (offset < 8 || offset + 2 > b.length || visited.has(offset)) {
      if (offset !== 0) t.errors.push(`${ifd}: bad offset ${offset}`);
      return 0;
    }
    visited.add(offset);
    const n = u16(b, offset, endian);
    if (offset + 2 + n * 12 > b.length) {
      t.errors.push(`${ifd}: truncated`);
      return 0;
    }
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(b, e, endian);
      const type = u16(b, e + 2, endian);
      const count = u32(b, e + 4, endian);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      let raw: Uint8Array;
      if (size <= 4) raw = b.slice(e + 8, e + 8 + size);
      else {
        const vo = u32(b, e + 8, endian);
        if (vo + size > b.length) {
          t.errors.push(`${ifd}: tag 0x${tag.toString(16)} value outside block`);
          raw = new Uint8Array(0);
        } else raw = b.slice(vo, vo + size);
      }
      const sub = ifd === 'IFD1' ? undefined : POINTER_TAGS[tag];
      if (sub && (ifd === 'IFD0' || (ifd === 'ExifIFD' && sub === 'Interop'))) {
        readIfd(u32(b, e + 8, endian), sub);
        continue;
      }
      t.entries.push({ ifd, tag, type, count, raw });
    }
    const nextAt = offset + 2 + n * 12;
    return nextAt + 4 <= b.length ? u32(b, nextAt, endian) : 0;
  };

  const next = readIfd(u32(b, 4, endian), 'IFD0');
  if (next) readIfd(next, 'IFD1');
  const tOff = t.entries.find((e) => e.ifd === 'IFD1' && e.tag === 0x0201);
  const tLen = t.entries.find((e) => e.ifd === 'IFD1' && e.tag === 0x0202);
  if (tOff && tLen) t.thumbnail = { offset: numberAt(tOff, endian, 0), length: numberAt(tLen, endian, 0) };
  return t;
}

/** Numeric value #i of an integer/rational entry. */
export function numberAt(e: TiffEntry, en: Endian, i: number): number {
  const s = TYPE_SIZE[e.type] ?? 1;
  const o = i * s;
  if (o + s > e.raw.length) return NaN;
  switch (e.type) {
    case 1: case 7: return e.raw[o];
    case 6: return (e.raw[o] << 24) >> 24;
    case 3: return u16(e.raw, o, en);
    case 8: return (u16(e.raw, o, en) << 16) >> 16;
    case 4: case 13: return u32(e.raw, o, en);
    case 9: return i32(e.raw, o, en);
    case 5: { const d = u32(e.raw, o + 4, en); return d ? u32(e.raw, o, en) / d : NaN; }
    case 10: { const d = i32(e.raw, o + 4, en); return d ? i32(e.raw, o, en) / d : NaN; }
    default: return NaN;
  }
}

function rationalText(e: TiffEntry, en: Endian, i: number): string {
  const o = i * 8;
  const n = e.type === 10 ? i32(e.raw, o, en) : u32(e.raw, o, en);
  const d = e.type === 10 ? i32(e.raw, o + 4, en) : u32(e.raw, o + 4, en);
  if (d === 0) return 'undefined';
  if (n % d === 0) return String(n / d);
  if (n === 1 || Math.abs(n / d) < 0.1) return `${n}/${d}`;
  return String(Math.round((n / d) * 1e6) / 1e6);
}

function trimNul(s: string): string {
  const i = s.indexOf('\0');
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

/** Human-readable value + text needles (exact stored strings) for the signature scan. */
export function entryValue(e: TiffEntry, en: Endian): { value: string; needles: string[] } {
  const count = e.raw.length / (TYPE_SIZE[e.type] ?? 1);
  if (e.type === 2) {
    const s = trimNul(utf8(e.raw));
    return { value: s, needles: s.length >= 3 ? [s] : [] };
  }
  if (e.ifd !== 'GPS' && e.tag >= 0x9c9b && e.tag <= 0x9c9f) {
    const s = utf16(e.raw, 0, e.raw.length, 'LE');
    return { value: s, needles: [] };
  }
  if (e.tag === 0x9286 && e.raw.length >= 8) {
    const code = ascii(e.raw, 0, 8);
    const s = code.startsWith('UNICODE') ? utf16(e.raw, 8, e.raw.length - 8, en) : trimNul(utf8(e.raw, 8));
    return { value: s, needles: s.length >= 3 && !code.startsWith('UNICODE') ? [s] : [] };
  }
  if (e.tag === 0x927c) return { value: `${e.raw.length} bytes`, needles: [] };
  if (e.type === 7) {
    const printable = e.raw.length <= 64 && e.raw.every((c) => c === 0 || (c >= 0x20 && c < 0x7f));
    return { value: printable ? trimNul(ascii(e.raw)) : `${e.raw.length} bytes`, needles: [] };
  }
  if (e.type === 5 || e.type === 10) {
    const parts: string[] = [];
    for (let i = 0; i < Math.min(count, 8); i++) parts.push(rationalText(e, en, i));
    if (e.ifd === 'GPS' && (e.tag === 2 || e.tag === 4) && count === 3) {
      const [d, m, s] = [0, 1, 2].map((i) => numberAt(e, en, i));
      return { value: `${d}° ${m}' ${Math.round(s * 100) / 100}"`, needles: [] };
    }
    return { value: parts.join(' '), needles: [] };
  }
  if (e.type === 1 && e.ifd === 'GPS' && e.tag === 0) return { value: [...e.raw].join('.'), needles: [] };
  const parts: string[] = [];
  for (let i = 0; i < Math.min(count, 16); i++) parts.push(String(numberAt(e, en, i)));
  return { value: parts.join(' ') + (count > 16 ? ' …' : ''), needles: [] };
}

/** The catalogue field of one (non-IFD1) entry. */
export function entryField(e: TiffEntry, en: Endian): Field {
  const d = describeExif(e.ifd, e.tag);
  const { value, needles } = entryValue(e, en);
  // Binary needles: location rationals are distinctive enough to search for byte-for-byte.
  const bin = e.ifd === 'GPS' && e.raw.length >= 16 ? [e.raw] : undefined;
  return makeField('exif', d.key, d, value, needles, bin);
}

/**
 * Review S8 (P7.5): on phones the lens name names the phone (Apple: "iPhone 15 Pro back triple camera 6.765mm f/1.78").
 * When LensMake/LensModel contains the camera's Make or Model (or an iPhone/iPad name), it is a Device field, not a camera
 * setting, so "Keep camera settings" removes it like the phone model. Used by the inspection and by the writer alike.
 */
export function fieldsOfTiff(t: Tiff): (e: TiffEntry) => Field {
  const names = t.entries
    .filter((e) => e.ifd === 'IFD0' && (e.tag === 0x010f || e.tag === 0x0110))
    .map((e) => entryField(e, t.endian).value.trim().toLowerCase())
    .filter((v) => v.length >= 3);
  return (e) => {
    const f = entryField(e, t.endian);
    if (f.id !== 'exif:LensModel' && f.id !== 'exif:LensMake') return f;
    const v = f.value.toLowerCase();
    if (!names.some((n) => v.includes(n)) && !/\b(iphone|ipad)\b/.test(v)) return f;
    return { ...f, group: 'device', sensitivity: 'medium', name: f.id === 'exif:LensModel' ? 'Lens model (names the phone)' : 'Lens make (names the phone)' };
  };
}

export const THUMBNAIL_FIELD_KEY = 'IFD1:ThumbnailImage';

/** Catalogue fields for every entry (IFD1 entries collapse into one "Hidden preview image" field). */
export function tiffFields(t: Tiff): Field[] {
  const out: Field[] = [];
  let thumbDone = false;
  const fieldOf = fieldsOfTiff(t);
  for (const e of t.entries) {
    if (e.ifd !== 'IFD1') out.push(fieldOf(e));
    else if (!thumbDone) {
      thumbDone = true;
      const len = t.thumbnail?.length;
      out.push(makeField('exif', THUMBNAIL_FIELD_KEY, { name: 'Hidden preview image', group: 'extras', sensitivity: 'medium', known: true }, len ? `${len} bytes` : 'present'));
    }
  }
  return out;
}

export function orientationOf(t: Tiff | null): number | undefined {
  const e = t?.entries.find((x) => x.ifd === 'IFD0' && x.tag === TAG_ORIENTATION);
  return e ? numberAt(e, t!.endian, 0) : undefined;
}
