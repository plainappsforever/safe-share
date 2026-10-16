/**
 * MP4 / M4V / MOV (ISO 14496-12, QuickTime): inspect and clean IN PLACE on a byte copy (D10, RESEARCH §2).
 *  - metadata boxes (udta atoms, `meta` keys/ilst, XMP `uuid`, unknown top-level boxes) -> renamed `free`, payload zeroed;
 *    partial profiles rebuild a `meta` box in place (filtered keys + ilst, padded with a `free` child);
 *  - mvhd/tkhd/mdhd creation/modification times -> zero;
 *  - telemetry tracks (hdlr `meta`/`camm`: camm, gpmd, mebx …) -> `trak` to `free`, their samples zeroed via
 *    stsz/stsc/stco/co64;
 *  - `mdat` otherwise untouched; the tkhd rotation matrix is never touched.
 * Boxes are walked from the file with small header reads, so a 1 GB file needs no large reads (A10).
 */
import { ascii, asciiBytes, concat, put32, textRuns, u16, u32, u64, utf16, utf8, utf8Bytes } from './binary';
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import { describeQtAtom, describeQtKey, makeField, type Described, type Field } from './catalog';
import type { Container, FormatReport } from './inspect';
import { outside, readExact, SeqWriter, subtract, type Range } from './io';
import { CorruptError } from './jpeg';
import { EMPTY_XMP, padPacket, parseXmp, rebuildXmp, xmpFields, type XmpProp } from './xmp';

export class UnsupportedVideoError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UnsupportedVideoError';
  }
}

export interface FileBox {
  type: string;
  offset: number;
  size: number;
  /** Header length incl. 64-bit size and uuid usertype. */
  header: number;
  /** Length of the size+type part only (8 or 16): payload zeroing for `free` starts here. */
  base: number;
  uuid?: string;
}

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
/** uuid boxes needed for playback of protected/fragmented files; never touched. */
const PLAYBACK_UUIDS = new Set(['a2394f525a9b4f14a2446c427c648df4', 'd08a4f1810f34a82b6c832d8aba183d3', '8974dbce7be74c5184f97148f9882554']);
const KNOWN_TOP = new Set(['ftyp', 'mdat', 'moov', 'moof', 'mfra', 'sidx', 'styp', 'pdin', 'prft', 'emsg', 'ssix', 'pnot']);
/** Free space: kept only when it holds nothing but zeros (editors leave old metadata there, review S1). */
const FREE = new Set(['free', 'skip', 'wide']);
/** Children of `moov` and `trak` that players need or that are parsed below; anything else is zeroed (allow-list, P7.5). */
const KNOWN_MOOV = new Set(['mvhd', 'trak', 'udta', 'meta', 'uuid', 'cmov', 'iods', 'mvex', 'ipmc', 'pssh', 'clip', 'ctab', 'rmra', 'prfl', 'meco', 'auxv']);
const KNOWN_TRAK = new Set(['tkhd', 'mdia', 'edts', 'tref', 'trgr', 'udta', 'meta', 'uuid', 'load', 'imap', 'matt', 'kmat', 'clip', 'txas', 'tapt', 'meco']);
/**
 * Children of `mdia`, `minf`, `stbl` (ISO 14496-12 §8.4–8.7 and QuickTime) and of `moof`/`traf` (§8.8) that players need;
 * udta/meta/uuid/free and anything unknown there are metadata like at the moov level (review S9, V1.5-1 fix round).
 */
const KNOWN_MDIA = new Set(['mdhd', 'hdlr', 'minf', 'elng']);
const KNOWN_MINF = new Set(['vmhd', 'smhd', 'hmhd', 'nmhd', 'sthd', 'gmhd', 'dinf', 'stbl', 'hdlr']);
const KNOWN_STBL = new Set(['stsd', 'stts', 'ctts', 'cslg', 'stss', 'stsh', 'stps', 'sdtp', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'sbgp', 'sgpd', 'subs', 'saiz', 'saio', 'padb', 'stdp', 'csgp']);
const KNOWN_MOOF = new Set(['mfhd', 'traf', 'pssh']);
const KNOWN_TRAF = new Set(['tfhd', 'tfdt', 'trun', 'sbgp', 'sgpd', 'subs', 'saiz', 'saio', 'sdtp', 'senc', 'csgp']);
const TELEMETRY_ENTRIES: Record<string, [name: string, group: 'location' | 'extras']> = {
  camm: ['Camera motion and GPS track (CAMM)', 'location'],
  gpmd: ['GoPro telemetry track (GPS and sensors)', 'location'],
  mebx: ['Timed metadata track', 'extras'],
};
const THREE_GPP_STRINGS = new Set(['titl', 'auth', 'dscp', 'perf', 'gnre', 'cprt', 'albm', 'kywd', 'coll']);

function readHeader(f: ByteFile, at: number, limit: number): FileBox {
  const h = f.read(at, 32);
  if (h.length < 8) throw new CorruptError(`box header at ${at} runs past the file`);
  let size = u32(h, 0);
  const type = ascii(h, 4, 4);
  let header = 8;
  if (size === 1) {
    if (h.length < 16) throw new CorruptError(`box header at ${at} runs past the file`);
    size = u64(h, 8);
    header = 16;
  } else if (size === 0) size = limit - at;
  const base = header;
  let uuid: string | undefined;
  if (type === 'uuid') {
    if (h.length < header + 16) throw new CorruptError(`uuid box at ${at} runs past the file`);
    uuid = [...h.subarray(header, header + 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
    header += 16;
  }
  if (size < header || at + size > limit) throw new CorruptError(`box ${type} at ${at} runs past its parent`);
  return { type, offset: at, size, header, base, uuid };
}

/** Child boxes of [start, end) read from the file. */
function fileChildren(f: ByteFile, start: number, end: number): FileBox[] {
  const out: FileBox[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const b = readHeader(f, pos, end);
    out.push(b);
    pos += b.size;
  }
  return out;
}

/** Boxes of an in-memory buffer (offsets relative to the buffer). */
function bufChildren(b: Uint8Array, start: number, end: number): FileBox[] {
  const out: FileBox[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(b, pos);
    const type = ascii(b, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      size = u64(b, pos + 8);
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) throw new CorruptError(`box ${type} runs past its parent`);
    out.push({ type, offset: pos, size, header, base: header });
    pos += size;
  }
  return out;
}

/** QuickTime `meta` has no version/flags word; ISO `meta` does. Returns where the children start. */
function metaChildStart(first12: Uint8Array, header: number): number {
  if (ascii(first12, header + 4, 4) === 'hdlr') return header;
  return header + 4;
}

/** Seconds since 1904-01-01 -> "YYYY:MM:DD hh:mm:ss" (UTC), the ExifTool spelling. */
function qtDate(secs: number): string {
  const d = new Date((secs - 2082844800) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function short(v: string): string {
  return v.length > 200 ? `${v.slice(0, 200)}…` : v;
}

/** Value of an iTunes/QuickTime `data` atom payload (after the 8-byte header). */
function dataValue(p: Uint8Array): { value: string; needles: string[] } {
  if (p.length < 8) return { value: '', needles: [] };
  const type = u32(p, 0) & 0xffffff;
  const v = p.subarray(8);
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  let value: string;
  if (type === 1) value = utf8(v).replace(/\0+$/, '');
  else if (type === 2) value = utf16(v, 0, v.length, 'BE');
  else if (type === 23 && v.length === 4) value = String(dv.getFloat32(0));
  else if (type === 24 && v.length === 8) value = String(dv.getFloat64(0));
  else if ((type === 21 || type === 22) && v.length > 0 && v.length <= 4) {
    let n = 0;
    for (const x of v) n = n * 256 + x;
    if (type === 21 && v[0] & 0x80) n -= 2 ** (8 * v.length);
    value = String(n);
  } else return { value: `${v.length} bytes`, needles: textRuns(v) };
  return { value: value.trim(), needles: type === 1 || type === 2 ? [value.trim()] : [] };
}

/** One QuickTime user-data atom -> display value + needles. */
function atomValue(type: string, p: Uint8Array): { value: string; needles: string[]; bin?: Uint8Array[] } {
  if (p.length >= 16 && ascii(p, 4, 4) === 'data') {
    const r = dataValue(p.subarray(8, Math.min(p.length, u32(p, 0))));
    return r;
  }
  if (type === 'loci' && p.length >= 18) {
    let q = 6;
    while (q < p.length && p[q] !== 0) q++;
    const name = utf8(p, 6, q - 6);
    q += 2; // terminator + role
    if (q + 12 > p.length) return { value: `${p.length} bytes`, needles: textRuns(p) };
    const fx = (o: number) => (u32(p, o) | 0) / 65536;
    const [lon, lat, alt] = [fx(q), fx(q + 4), fx(q + 8)];
    return { value: `${lat.toFixed(5)}, ${lon.toFixed(5)}, ${alt.toFixed(1)} m${name ? ` (${name})` : ''}`, needles: name ? [name] : [], bin: [p.slice(q, q + 12)] };
  }
  // 3GPP TS 26.244 recording year: version/flags, then a 16-bit year (X3, V1.5-1).
  if (type === 'yrrc' && p.length === 6 && u32(p, 0) === 0) return { value: String(u16(p, 4)), needles: [] };
  if (THREE_GPP_STRINGS.has(type) && p.length >= 6 && u32(p, 0) === 0) {
    const s = p[6] === 0xfe && p[7] === 0xff ? utf16(p, 8, p.length - 8, 'BE') : utf8(p, 6).replace(/\0+$/, '');
    return { value: s.trim(), needles: [s.trim()] };
  }
  if (type.startsWith('©') && p.length >= 4) {
    // QuickTime international text: [u16 length][u16 language][text], possibly repeated.
    const parts: string[] = [];
    let q = 0;
    while (q + 4 <= p.length) {
      const len = u16(p, q);
      if (q + 4 + len > p.length) break;
      parts.push(utf8(p, q + 4, len).replace(/\0+$/, ''));
      q += 4 + len;
    }
    if (parts.length && q === p.length) return { value: parts.join(', ').trim(), needles: parts.map((s) => s.trim()) };
  }
  if (p.length > 0 && p.length <= 256 && p.every((c) => c === 0 || (c >= 0x20 && c < 0x7f))) {
    const s = ascii(p).replace(/\0/g, '').trim();
    return { value: s, needles: [s] };
  }
  return { value: `${p.length} bytes`, needles: textRuns(p) };
}

/** A metadata `meta` box (keys + ilst for `mdta`, four-character ilst for `mdir`). */
interface MetaItem {
  field: Field;
  /** ilst item box relative to the meta buffer. */
  item: FileBox;
  /** 1-based key index for `mdta`. */
  keyIndex?: number;
}

type Unit =
  /** Removed as a whole when any of its fields is not kept (renamed `free`, payload zeroed). */
  | { kind: 'atomic'; box: FileBox; fields: Field[]; wipe?: Range[] }
  /** `meta` box rebuilt in place when only some items are kept. */
  | { kind: 'meta'; box: FileBox; items: MetaItem[]; handler: string; fields: Field[]; other: Field[] }
  /** XMP (uuid / XMP_ atom): rebuilt and padded in place, or removed. */
  | { kind: 'xmp'; box: FileBox; props: XmpProp[]; payload: Range; fields: Field[] }
  /** udta: removed as a whole when nothing in it is kept, else unit by unit. */
  | { kind: 'udta'; box: FileBox; units: Unit[]; fields: Field[] };

interface TimeSlot {
  at: number;
  size: 4 | 8;
  field: Field;
}

export interface Mp4Model {
  report: FormatReport;
  units: Unit[];
  times: TimeSlot[];
}

function timeField(key: string, name: string, secs: number): Field {
  return makeField('qt', key, { name, group: 'datetime', sensitivity: 'medium', known: true }, qtDate(secs));
}

export function inspectMp4(f: ByteFile): Mp4Model {
  const size = f.size;
  const top = fileChildren(f, 0, size);
  if (!top.some((b) => b.type === 'moov')) throw new CorruptError('video without a moov box');
  const units: Unit[] = [];
  const times: TimeSlot[] = [];
  const containers: Container[] = [];
  const notes: string[] = [];
  const mdats: Range[] = [];
  const wipe: (Range & { fieldId: string })[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  const rotationFields: Field[] = [];
  const fragmented = top.some((b) => b.type === 'moof');
  let trackNo = 0;

  const readBox = (b: FileBox, what: string): Uint8Array => {
    if (b.size > MAX_READ_BYTES) throw new UnsupportedVideoError(`${what} larger than 4 MB`);
    return readExact(f, b.offset, b.size);
  };

  const timesOf = (b: FileBox, prefix: string, create: string, modify: string, names: [string, string]) => {
    const p = f.read(b.offset + b.header, 32);
    const v = p[0];
    const sz = v === 1 ? 8 : 4;
    const c = sz === 8 ? u64(p, 4) : u32(p, 4);
    const m = sz === 8 ? u64(p, 4 + sz) : u32(p, 4 + sz);
    const base = b.offset + b.header + 4;
    if (c) times.push({ at: base, size: sz, field: timeField(`${prefix}${create}`, names[0], c) });
    if (m) times.push({ at: base + sz, size: sz, field: timeField(`${prefix}${modify}`, names[1], m) });
    return { p, v };
  };

  const metaUnit = (b: FileBox): Unit => {
    if (b.size > MAX_READ_BYTES) return unknownBox(f, b);
    const m = readExact(f, b.offset, b.size);
    const start = metaChildStart(m, b.header);
    const kids = bufChildren(m, start, m.length);
    const hdlr = kids.find((k) => k.type === 'hdlr');
    const handler = hdlr ? ascii(m, hdlr.offset + hdlr.header + 8, 4) : '';
    const keysBox = kids.find((k) => k.type === 'keys');
    const keys: string[] = [];
    if (keysBox) {
      const n = u32(m, keysBox.offset + 12);
      let q = keysBox.offset + 16;
      for (let i = 0; i < n && q + 8 <= keysBox.offset + keysBox.size; i++) {
        const ks = u32(m, q);
        if (ks < 8) break;
        keys.push(utf8(m, q + 8, ks - 8));
        q += ks;
      }
    }
    const items: MetaItem[] = [];
    const other: Field[] = [];
    for (const k of kids) {
      if (k.type === 'ilst') {
        for (const it of bufChildren(m, k.offset + 8, k.offset + k.size)) {
          const payload = m.subarray(it.offset + it.header, it.offset + it.size);
          const idx = u32(m, it.offset + 4);
          let key: string;
          let d: Described;
          if (handler === 'mdta' && idx >= 1 && idx <= keys.length) {
            key = keys[idx - 1];
            d = describeQtKey(key);
          } else {
            key = it.type;
            d = describeQtAtom(it.type);
          }
          const r = payload.length >= 8 && ascii(payload, 4, 4) === 'data' ? dataValue(payload.subarray(8, Math.min(payload.length, u32(payload, 0)))) : { value: `${payload.length} bytes`, needles: textRuns(payload) };
          const field = makeField('qt', key, d, short(r.value), r.needles);
          items.push({ field, item: it, keyIndex: handler === 'mdta' ? idx : undefined });
        }
      } else if (k.type !== 'hdlr' && k.type !== 'keys') {
        const payload = m.subarray(k.offset + k.header, k.offset + k.size);
        const name = FREE.has(k.type) ? 'Leftover data in free space' : 'Other embedded data';
        if (payload.some((x) => x !== 0)) other.push(makeField('qt', `meta:${k.type}`, { name, group: 'other', sensitivity: 'medium', known: false }, `${payload.length} bytes`, textRuns(payload)));
      }
    }
    const fields = [...items.map((i) => i.field), ...other];
    return { kind: 'meta', box: b, items, handler, fields, other };
  };

  const xmpUnit = (b: FileBox, payloadStart: number): Unit => {
    const payload = { offset: payloadStart, length: b.offset + b.size - payloadStart };
    if (payload.length > MAX_READ_BYTES) return { kind: 'atomic', box: b, fields: [makeField('qt', 'XMP', { name: 'XMP block', group: 'other', sensitivity: 'medium', known: false }, `${payload.length} bytes`)] };
    const x = parseXmp(utf8(readExact(f, payload.offset, payload.length)));
    containers.push({ kind: 'xmp', ...payload });
    const unreadable = x.ok ? [] : [makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${payload.length} bytes`)];
    return { kind: 'xmp', box: b, props: x.props, payload, fields: [...xmpFields(x), ...unreadable] };
  };

  const udtaUnit = (b: FileBox): Unit => {
    const inner: Unit[] = [];
    for (const c of fileChildren(f, b.offset + b.header, b.offset + b.size)) {
      if (FREE.has(c.type)) {
        const u = freeUnit(f, c);
        if (u) inner.push(u);
        continue;
      }
      if (c.type === 'meta') inner.push(metaUnit(c));
      else if (c.type === 'XMP_') inner.push(xmpUnit(c, c.offset + c.header));
      else if (c.type === 'uuid' && c.uuid === XMP_UUID) inner.push(xmpUnit(c, c.offset + c.header));
      else {
        const p = c.size - c.header > 64 * 1024 ? f.read(c.offset + c.header, 64 * 1024) : readExact(f, c.offset + c.header, c.size - c.header);
        if (p.length === 0 || p.every((x) => x === 0)) continue;
        const r = atomValue(c.type, p);
        inner.push({ kind: 'atomic', box: c, fields: [makeField('qt', c.type, describeQtAtom(c.type), short(r.value), r.needles, r.bin)] });
      }
    }
    return { kind: 'udta', box: b, units: inner, fields: inner.flatMap((u) => u.fields) };
  };

  const telemetry = (trak: FileBox, entry: string, stbl: FileBox | undefined, trackPrefix: string): Unit => {
    const known = TELEMETRY_ENTRIES[entry];
    const d: Described = known
      ? { name: known[0], group: known[1], sensitivity: known[1] === 'location' ? 'high' : 'medium', known: true }
      : { name: `Timed metadata track (${entry.trim() || '?'})`, group: 'extras', sensitivity: 'medium', known: true };
    if (fragmented) throw new UnsupportedVideoError('fragmented video with a metadata track is not supported yet');
    if (!stbl) throw new CorruptError('metadata track without sample table');
    const tables = new Map(fileChildren(f, stbl.offset + stbl.header, stbl.offset + stbl.size).map((k) => [k.type, k] as const));
    const load = (t: string) => {
      const b = tables.get(t);
      return b ? readBox(b, `sample table ${t}`).subarray(b.header) : null;
    };
    const stsz = load('stsz');
    const stsc = load('stsc');
    const stco = load('stco');
    const co64 = load('co64');
    if (!stsz || !stsc || (!stco && !co64)) throw new CorruptError('metadata track sample table incomplete');
    const offsets: number[] = [];
    if (co64) for (let i = 0, n = u32(co64, 4); i < n; i++) offsets.push(u64(co64, 8 + i * 8));
    else if (stco) for (let i = 0, n = u32(stco, 4); i < n; i++) offsets.push(u32(stco, 8 + i * 4));
    const constSize = u32(stsz, 4);
    const count = u32(stsz, 8);
    const sampleSize = (i: number) => (constSize ? constSize : u32(stsz, 12 + i * 4));
    const runs: { first: number; per: number }[] = [];
    for (let i = 0, n = u32(stsc, 4); i < n; i++) runs.push({ first: u32(stsc, 8 + i * 12), per: u32(stsc, 12 + i * 12) });
    let sample = 0;
    const ranges: Range[] = [];
    for (let c = 0; c < offsets.length && sample < count; c++) {
      let per = 0;
      for (const r of runs) if (r.first <= c + 1) per = r.per;
      let len = 0;
      for (let k = 0; k < per && sample < count; k++) len += sampleSize(sample++);
      if (len > 0) ranges.push({ offset: offsets[c], length: len });
    }
    for (const r of ranges) {
      if (!mdats.some((m) => r.offset >= m.offset && r.offset + r.length <= m.offset + m.length)) throw new CorruptError('metadata track samples lie outside the media data');
    }
    const field = makeField('qt', `${trackPrefix}MetadataTrack:${entry}`, d, `${count} samples`);
    wipe.push(...ranges.map((r) => ({ ...r, fieldId: field.id })));
    return { kind: 'atomic', box: trak, fields: [field], wipe: ranges };
  };

  for (const b of top) if (b.type === 'mdat') mdats.push({ offset: b.offset + b.header, length: b.size - b.header });

  /** The metadata children of a container below `trak`/`moof` (S9); `own` handles the children it knows itself. */
  const extras = (parent: FileBox, known: Set<string>, into: Unit[], own?: (k: FileBox) => void) => {
    for (const k of fileChildren(f, parent.offset + parent.header, parent.offset + parent.size)) {
      if (k.type === 'udta') into.push(udtaUnit(k));
      else if (k.type === 'meta') into.push(metaUnit(k));
      else if (k.type === 'uuid' && k.uuid === XMP_UUID) into.push(xmpUnit(k, k.offset + k.header));
      else if (k.type === 'uuid' && !PLAYBACK_UUIDS.has(k.uuid ?? '')) into.push(unknownBox(f, k));
      else if (FREE.has(k.type)) {
        const u = freeUnit(f, k);
        if (u) into.push(u);
      } else if (k.type !== 'uuid' && !known.has(k.type)) into.push(unknownBox(f, k));
      else own?.(k);
    }
  };

  const visitTrak = (trak: FileBox) => {
    trackNo++;
    const prefix = `Track${trackNo}:`;
    const kids = fileChildren(f, trak.offset + trak.header, trak.offset + trak.size);
    let handler = '';
    let entry = '';
    let stbl: FileBox | undefined;
    const trakUnits: Unit[] = [];
    const before = times.length;
    for (const k of kids) {
      if (k.type === 'tkhd') {
        const { v } = timesOf(k, prefix, 'TrackCreateDate', 'TrackModifyDate', ['Track created', 'Track modified']);
        const all = f.read(k.offset + k.header, k.size - k.header);
        const mOff = v === 1 ? 52 : 40;
        const matrix = [0, 1, 3, 4].map((i) => u32(all, mOff + i * 4) | 0);
        const w = u32(all, mOff + 36) / 65536;
        const h = u32(all, mOff + 40) / 65536;
        if (w && h && width === undefined) {
          width = Math.round(w);
          height = Math.round(h);
        }
        const [a, bb] = matrix;
        if (w && h && !(a === 0x10000 && bb === 0)) {
          const deg = Math.round((Math.atan2(bb, a) * 180) / Math.PI);
          rotationFields.push(makeField('qt', `${prefix}Rotation`, { name: 'Rotation', group: 'technical', sensitivity: 'none', known: true }, `${(deg + 360) % 360}°`));
        }
      } else if (k.type === 'mdia') {
        extras(k, KNOWN_MDIA, trakUnits, (m) => {
          if (m.type === 'mdhd') timesOf(m, prefix, 'MediaCreateDate', 'MediaModifyDate', ['Media created', 'Media modified']);
          else if (m.type === 'hdlr') handler = ascii(f.read(m.offset + m.header + 8, 4), 0, 4);
          else if (m.type === 'minf') {
            extras(m, KNOWN_MINF, trakUnits, (x) => {
              if (x.type !== 'stbl') return;
              stbl = x;
              extras(x, KNOWN_STBL, trakUnits);
            });
            const stsd = stbl ? fileChildren(f, stbl.offset + stbl.header, stbl.offset + stbl.size).find((x) => x.type === 'stsd') : undefined;
            if (stsd) entry = ascii(f.read(stsd.offset + stsd.header + 12, 4), 0, 4);
          }
        });
      } else if (k.type === 'udta') trakUnits.push(udtaUnit(k));
      else if (k.type === 'meta') trakUnits.push(metaUnit(k));
      else if (k.type === 'uuid' && k.uuid === XMP_UUID) trakUnits.push(xmpUnit(k, k.offset + k.header));
      else if (k.type === 'uuid' && !PLAYBACK_UUIDS.has(k.uuid ?? '')) trakUnits.push(unknownBox(f, k));
      else if (FREE.has(k.type)) {
        const u = freeUnit(f, k);
        if (u) trakUnits.push(u);
      } else if (!KNOWN_TRAK.has(k.type)) trakUnits.push(unknownBox(f, k));
    }
    if (handler === 'meta' || handler === 'camm') {
      // The whole track goes; its times and metadata go with it.
      const moved = times.splice(before);
      const u = telemetry(trak, entry, stbl, prefix) as Extract<Unit, { kind: 'atomic' }>;
      u.fields.push(...moved.map((t) => t.field), ...trakUnits.flatMap((x) => x.fields));
      units.push(u);
      return;
    }
    units.push(...trakUnits);
  };

  for (const b of top) {
    if (b.type === 'moov') {
      for (const k of fileChildren(f, b.offset + b.header, b.offset + b.size)) {
        if (k.type === 'mvhd') {
          const { p, v } = timesOf(k, '', 'CreateDate', 'ModifyDate', ['Date created', 'Date modified']);
          const ts = v === 1 ? u32(p, 20) : u32(p, 12);
          const dur = v === 1 ? u64(p, 24) : u32(p, 16);
          if (ts) duration = dur / ts;
        } else if (k.type === 'trak') visitTrak(k);
        else if (k.type === 'udta') units.push(udtaUnit(k));
        else if (k.type === 'meta') units.push(metaUnit(k));
        else if (k.type === 'uuid' && k.uuid === XMP_UUID) units.push(xmpUnit(k, k.offset + k.header));
        else if (k.type === 'uuid' && !PLAYBACK_UUIDS.has(k.uuid ?? '')) units.push(unknownBox(f, k));
        else if (k.type === 'cmov') throw new UnsupportedVideoError('compressed movie header is not supported yet');
        else if (FREE.has(k.type)) {
          const u = freeUnit(f, k);
          if (u) units.push(u);
        } else if (!KNOWN_MOOV.has(k.type)) units.push(unknownBox(f, k));
      }
    } else if (b.type === 'moof') {
      extras(b, KNOWN_MOOF, units, (k) => {
        if (k.type === 'traf') extras(k, KNOWN_TRAF, units);
      });
    } else if (b.type === 'uuid' && b.uuid === XMP_UUID) units.push(xmpUnit(b, b.offset + b.header));
    else if (b.type === 'meta') units.push(metaUnit(b));
    else if (FREE.has(b.type)) {
      const u = freeUnit(f, b);
      if (u) units.push(u);
    }
    // Any size (S1): removing a box needs no read of it; `freeBox` zeroes it in 1 MiB writes.
    else if (!KNOWN_TOP.has(b.type) && !(b.type === 'uuid' && PLAYBACK_UUIDS.has(b.uuid ?? ''))) units.push(unknownBox(f, b));
  }

  const fields = [...times.map((t) => t.field), ...units.flatMap((u) => u.fields), ...rotationFields];
  if (wipe.length) notes.push(`${wipe.length} metadata sample chunks`);
  const dataRanges = subtract(mdats, wipe);
  return {
    units,
    times,
    report: {
      fields,
      containers,
      dataRanges,
      scanRanges: outside(size, mdats),
      wipeRanges: wipe,
      inPlace: true,
      width,
      height,
      duration,
      notes,
    },
  };
}

/** A `free`/`skip`/`wide` box that is not all zeros (old metadata left by an editor), or null. */
function freeUnit(f: ByteFile, b: FileBox): Unit | null {
  for (let done = 0, len = b.size - b.base; done < len; ) {
    const n = Math.min(MAX_READ_BYTES, len - done);
    const p = readExact(f, b.offset + b.base + done, n);
    if (p.some((x) => x !== 0)) {
      const first = f.read(b.offset + b.base, Math.min(64 * 1024, len));
      return { kind: 'atomic', box: b, fields: [makeField('qt', `box:${b.type}`, { name: 'Leftover data in free space', group: 'other', sensitivity: 'medium', known: false }, `${len} bytes`, textRuns(first))] };
    }
    done += n;
  }
  return null;
}

function unknownBox(f: ByteFile, b: FileBox): Unit {
  const p = f.read(b.offset + b.header, Math.min(MAX_READ_BYTES, b.size - b.header));
  const name = b.type === 'uuid' ? `uuid ${b.uuid}` : b.type;
  return { kind: 'atomic', box: b, fields: [makeField('qt', `box:${name}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, `${b.size - b.header} bytes`, textRuns(p))] };
}

const ZERO = new Uint8Array(Math.min(MAX_READ_BYTES, 1024 * 1024));

function zero(dst: ByteFile, r: Range): void {
  let done = 0;
  while (done < r.length) {
    const n = Math.min(ZERO.length, r.length - done);
    dst.write(r.offset + done, n === ZERO.length ? ZERO : ZERO.subarray(0, n));
    done += n;
  }
}

/** Renames a box to `free` and zeroes everything after its size+type header (incl. a uuid usertype). */
function freeBox(dst: ByteFile, b: FileBox): void {
  dst.write(b.offset + 4, asciiBytes('free'));
  zero(dst, { offset: b.offset + b.base, length: b.size - b.base });
}

function boxBytes(type: string, payload: Uint8Array): Uint8Array {
  const h = new Uint8Array(8);
  put32(h, 0, 8 + payload.length);
  h.set(asciiBytes(type), 4);
  return concat([h, payload]);
}

/** Rebuilds a `meta` box keeping only `keepItems`; same total size, remainder is a `free` child. Null if it cannot fit. */
function rebuildMeta(m: Uint8Array, u: Extract<Unit, { kind: 'meta' }>, keepItems: MetaItem[]): Uint8Array | null {
  const b = u.box;
  const start = metaChildStart(m, b.header);
  const kids = bufChildren(m, start, m.length);
  const parts: Uint8Array[] = [m.slice(0, start)];
  const hdlr = kids.find((k) => k.type === 'hdlr');
  if (hdlr) parts.push(m.slice(hdlr.offset, hdlr.offset + hdlr.size));
  if (u.handler === 'mdta') {
    const keysBox = kids.find((k) => k.type === 'keys');
    if (!keysBox) return null;
    const entries: Uint8Array[] = [];
    let q = keysBox.offset + 16;
    const all: Uint8Array[] = [];
    for (let i = 0, n = u32(m, keysBox.offset + 12); i < n; i++) {
      const ks = u32(m, q);
      all.push(m.slice(q, q + ks));
      q += ks;
    }
    const items: Uint8Array[] = [];
    keepItems.forEach((it, i) => {
      entries.push(all[it.keyIndex! - 1]);
      const copy = m.slice(it.item.offset, it.item.offset + it.item.size);
      put32(copy, 4, i + 1);
      items.push(copy);
    });
    const head = new Uint8Array(8);
    put32(head, 0, 0);
    put32(head, 4, entries.length);
    parts.push(boxBytes('keys', concat([head, ...entries])), boxBytes('ilst', concat(items)));
  } else {
    parts.push(boxBytes('ilst', concat(keepItems.map((it) => m.slice(it.item.offset, it.item.offset + it.item.size)))));
  }
  const body = concat(parts);
  const pad = m.length - body.length;
  if (pad !== 0 && pad < 8) return null;
  const out = new Uint8Array(m.length);
  out.set(body);
  if (pad) {
    put32(out, body.length, pad);
    out.set(asciiBytes('free'), body.length + 4);
  }
  return out;
}

/**
 * Cleans in place: copies src -> dst first unless `dstIsCopy` (a native byte copy), then patches.
 * The file length never changes and no box moves.
 */
export function cleanMp4(src: ByteFile, model: Mp4Model, dst: ByteFile, keep: (f: Field) => boolean, dstIsCopy = false): { kept: Field[]; notes: string[] } {
  if (!dstIsCopy) new SeqWriter(dst).copy(src, 0, src.size);
  const kept: Field[] = [];
  const notes: string[] = [];
  for (const t of model.times) {
    if (keep(t.field)) kept.push(t.field);
    else dst.write(t.at, new Uint8Array(t.size));
  }
  kept.push(...model.report.fields.filter((f) => f.id.endsWith(':Rotation') && f.source === 'qt'));
  const apply = (u: Unit): void => {
    const all = u.fields.every(keep);
    const none = !u.fields.some(keep);
    if (all) {
      kept.push(...u.fields);
      return;
    }
    if (u.kind === 'atomic') {
      freeBox(dst, u.box);
      for (const r of u.wipe ?? []) zero(dst, r);
      return;
    }
    if (u.kind === 'udta') {
      if (u.units.every((x) => !x.fields.some(keep))) freeBox(dst, u.box);
      else u.units.forEach(apply);
      return;
    }
    if (none) {
      freeBox(dst, u.box);
      return;
    }
    if (u.kind === 'meta') {
      const keepItems = u.items.filter((i) => keep(i.field));
      const rebuilt = rebuildMeta(readExact(src, u.box.offset, u.box.size), u, keepItems);
      if (rebuilt) {
        dst.write(u.box.offset, rebuilt);
        kept.push(...keepItems.map((i) => i.field));
      } else {
        notes.push('Kept video keys did not fit in place and were removed');
        freeBox(dst, u.box);
      }
      return;
    }
    // XMP
    const r = rebuildXmp(u.props, keep);
    const text = padPacket(r.packet ?? EMPTY_XMP, u.payload.length);
    if (!r.packet || text === null) {
      if (r.packet) notes.push('Kept XMP did not fit in place and was removed');
      freeBox(dst, u.box);
      return;
    }
    dst.write(u.payload.offset, utf8Bytes(text));
    kept.push(...r.kept);
  };
  model.units.forEach(apply);
  return { kept, notes };
}
