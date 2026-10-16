/**
 * HEIF/HEIC/AVIF: parses meta (iinf, iloc, iref, iprp, idat) and cleans by REBUILDING the file from an allow-list
 * (P7.5, review B1):
 *  - top level: only `ftyp`, `meta` and the boxes that hold item data (`mdat`) are written. Everything else (Samsung's
 *    `mpvd` Motion-Photo video, `free`/`skip`, `uuid`, any unknown box) is dropped, and the `iloc` offsets are fixed
 *    for the bytes that moved. Where `iloc` cannot express the move, a dropped box before the picture data is kept
 *    as a zero-filled `free` box instead (no byte of it survives);
 *  - inside `meta`: only the boxes a decoder needs (hdlr, pitm, iloc, iinf, iref, iprp, idat, dinf, grpl, ipro);
 *    anything else (`xml `, `bxml`, vendor boxes) becomes a zero-filled `free` box of the same size;
 *  - bytes inside `mdat` that no item uses are zeroed; the `udes` (user description) property is blanked;
 *  - the Exif and XMP item payloads are rewritten in place (same length), as before.
 * Every byte of every picture item and every decoding property stays identical (A2); orientation lives in the
 * irot/imir properties and is untouched.
 */
import { ascii, concat, put32, textRuns, u16, u32, uintN, utf8, utf8Bytes } from './binary';
import { makeField, type Field } from './catalog';
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import { iccField } from './icc';
import type { Container, FormatReport } from './inspect';
import { outside, readExact, SeqWriter, subtract, type Range } from './io';
import { childBoxes, topLevelBoxes, type Box } from './isobmff';
import { CorruptError } from './jpeg';
import { parseTiff, tiffFields } from './tiff';
import { rebuildTiff, writeTiff } from './tiff-writer';
import { EMPTY_XMP, padPacket, parseXmp, rebuildXmp, xmpFields } from './xmp';

export interface HeifItem {
  id: number;
  type: string;
  contentType?: string;
  contentEncoding?: string;
  /** Absolute file ranges of the item payload (construction method 0 or 1). */
  extents: Range[];
  construction: number;
  /** Absolute range of the item's `infe` declaration box. */
  infe: Range;
}

/** Positions (relative to the `meta` box) of one `iloc` entry's numbers, so the cleaner can move offsets. */
interface IlocEntry {
  id: number;
  construction: number;
  baseAt: number;
  base: number;
  extents: { offAt: number; off: number; len: number }[];
}

interface Iloc {
  offSize: number;
  baseSize: number;
  entries: IlocEntry[];
}

export interface HeifModel {
  items: HeifItem[];
  primary?: number;
  report: FormatReport;
  /** Exif and XMP items (their payloads are rewritten in place). */
  metaItems: HeifItem[];
  /** Top-level boxes in file order. */
  top: Box[];
  /** Top-level boxes that are not written (absolute). */
  drop: Box[];
  meta: Box;
  iloc: Iloc | null;
  /** Children of `meta` that become zero-filled `free` boxes (offsets relative to the `meta` box). */
  metaZero: Box[];
  /** `udes` property payloads (relative to the `meta` box) and their field. */
  udes: { range: Range; field: Field }[];
  /** Bytes inside kept data boxes that no item uses (absolute): zeroed. */
  gaps: Range[];
  /** End of the last byte any item uses (absolute). */
  referencedEnd: number;
}

function fullBoxBody(b: Uint8Array, box: Box): { version: number; flags: number; at: number; end: number } {
  const at = box.offset + box.header;
  return { version: b[at], flags: (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3], at: at + 4, end: box.offset + box.size };
}

function cstr(b: Uint8Array, at: number, end: number): { s: string; next: number } {
  let z = at;
  while (z < end && b[z] !== 0) z++;
  return { s: utf8(b, at, z - at), next: Math.min(end, z + 1) };
}

const isXmpItem = (it: HeifItem) => it.type === 'mime' && /rdf\+xml|xmp/i.test(it.contentType ?? '');

/** Top-level boxes that are written; anything else is dropped. */
const KEEP_TOP = new Set(['ftyp', 'meta', 'mdat']);
/** Children of `meta` a decoder needs; anything else is zero-filled. */
const KEEP_META = new Set(['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat', 'dinf', 'grpl', 'ipro']);

const other = (key: string, name: string, bytes: number, needles: string[] = []) =>
  makeField('heif', key, { name, group: 'other', sensitivity: 'medium', known: false }, `${bytes} bytes`, needles);

function parseIloc(m: Uint8Array, iloc: Box): Iloc {
  const fb = fullBoxBody(m, iloc);
  let p = fb.at;
  const offSize = m[p] >> 4;
  const lenSize = m[p] & 15;
  const baseSize = m[p + 1] >> 4;
  const idxSize = fb.version === 1 || fb.version === 2 ? m[p + 1] & 15 : 0;
  p += 2;
  const count = fb.version < 2 ? u16(m, p) : u32(m, p);
  p += fb.version < 2 ? 2 : 4;
  const entries: IlocEntry[] = [];
  for (let i = 0; i < count; i++) {
    const id = fb.version < 2 ? u16(m, p) : u32(m, p);
    p += fb.version < 2 ? 2 : 4;
    let construction = 0;
    if (fb.version === 1 || fb.version === 2) {
      construction = u16(m, p) & 15;
      p += 2;
    }
    p += 2; // data reference index
    const baseAt = p;
    const base = uintN(m, p, baseSize);
    p += baseSize;
    const extentCount = u16(m, p);
    p += 2;
    const extents: IlocEntry['extents'] = [];
    for (let k = 0; k < extentCount; k++) {
      p += idxSize;
      const offAt = p;
      const off = uintN(m, p, offSize);
      p += offSize;
      const len = uintN(m, p, lenSize);
      p += lenSize;
      extents.push({ offAt, off, len });
    }
    if (p > fb.end) throw new CorruptError('iloc runs past its box');
    entries.push({ id, construction, baseAt, base, extents });
  }
  return { offSize, baseSize, entries };
}

/** Item references (`iref`): type, from item, to items. */
function parseIref(m: Uint8Array, iref: Box | undefined): { type: string; from: number; to: number[] }[] {
  if (!iref) return [];
  const fb = fullBoxBody(m, iref);
  const w = fb.version === 0 ? 2 : 4;
  const id = (at: number) => (w === 2 ? u16(m, at) : u32(m, at));
  const out: { type: string; from: number; to: number[] }[] = [];
  for (const r of childBoxes(m, fb.at, fb.end)) {
    let p = r.offset + r.header;
    const from = id(p);
    p += w;
    const n = u16(m, p);
    p += 2;
    const to: number[] = [];
    for (let k = 0; k < n && p + w <= r.offset + r.size; k++, p += w) to.push(id(p));
    out.push({ type: r.type, from, to });
  }
  return out;
}

/** True when every byte of the range is zero (chunked reads). */
function allZero(f: ByteFile, r: Range): boolean {
  for (let done = 0; done < r.length; ) {
    const n = Math.min(MAX_READ_BYTES, r.length - done);
    const b = readExact(f, r.offset + done, n);
    for (let i = 0; i < n; i++) if (b[i] !== 0) return false;
    done += n;
  }
  return true;
}

const head = (f: ByteFile, b: Box) => f.read(b.offset + b.header, Math.min(64 * 1024, b.size - b.header));

export function inspectHeif(f: ByteFile): HeifModel {
  const top = topLevelBoxes(f);
  const metaBox = top.find((b) => b.type === 'meta');
  if (!metaBox) throw new CorruptError('HEIF without meta box');
  if (metaBox.size > MAX_READ_BYTES) throw new UnsupportedHeifError('HEIF meta box larger than 4 MB');
  if (top.some((b) => b.type === 'moov')) throw new UnsupportedHeifError('HEIF image sequences are not supported yet');
  if (top.filter((b) => b.type === 'meta').length > 1) throw new UnsupportedHeifError('HEIF with two meta boxes is not supported yet');
  const m = readExact(f, metaBox.offset, metaBox.size);
  const local: Box = { ...metaBox, offset: 0 };
  const body = fullBoxBody(m, local);
  const kids = childBoxes(m, body.at, body.end);
  const find = (t: string) => kids.find((k) => k.type === t);
  const abs = (b: Box): Range => ({ offset: metaBox.offset + b.offset, length: b.size });

  // iinf
  const items: HeifItem[] = [];
  const iinf = find('iinf');
  if (iinf) {
    const fb = fullBoxBody(m, iinf);
    const countSize = fb.version === 0 ? 2 : 4;
    for (const infe of childBoxes(m, fb.at + countSize, fb.end)) {
      if (infe.type !== 'infe') continue;
      const e = fullBoxBody(m, infe);
      if (e.version < 2) continue;
      let p = e.at;
      const id = e.version === 2 ? u16(m, p) : u32(m, p);
      p += e.version === 2 ? 2 : 4;
      p += 2; // protection index
      const type = ascii(m, p, 4);
      p += 4;
      const name = cstr(m, p, e.end);
      p = name.next;
      const item: HeifItem = { id, type, extents: [], construction: 0, infe: { offset: metaBox.offset + infe.offset, length: infe.size } };
      if (type === 'mime') {
        const ct = cstr(m, p, e.end);
        item.contentType = ct.s;
        if (ct.next < e.end) item.contentEncoding = cstr(m, ct.next, e.end).s || undefined;
      }
      items.push(item);
    }
  }
  // idat (construction method 1 offsets are relative to its payload)
  const idat = find('idat');
  const idatStart = idat ? metaBox.offset + idat.offset + idat.header : 0;
  // iloc
  const ilocBox = find('iloc');
  const iloc = ilocBox ? parseIloc(m, ilocBox) : null;
  for (const e of iloc?.entries ?? []) {
    const extents = e.extents.map((x) => {
      const at = e.construction === 1 ? idatStart + e.base + x.off : e.base + x.off;
      return { offset: at, length: x.len === 0 ? f.size - at : x.len };
    });
    const item = items.find((x) => x.id === e.id);
    if (item) {
      item.extents = extents;
      item.construction = e.construction;
    }
  }
  const pitm = find('pitm');
  const primary = pitm ? (fullBoxBody(m, pitm).version === 0 ? u16(m, fullBoxBody(m, pitm).at) : u32(m, fullBoxBody(m, pitm).at)) : undefined;

  const fields: Field[] = [];
  const containers: Container[] = [];
  const notes: string[] = [];
  const udes: HeifModel['udes'] = [];
  /** Every udes payload, blank or not: not part of the lossless comparison (a blanked one must compare equal). */
  const udesRanges: Range[] = [];
  // Properties of the primary item: rotation, mirror, colour profile; `udes` of any item.
  const iprp = find('iprp');
  if (iprp) {
    const pk = childBoxes(m, iprp.offset + iprp.header, iprp.offset + iprp.size);
    const ipco = pk.find((k) => k.type === 'ipco');
    const props = ipco ? childBoxes(m, ipco.offset + ipco.header, ipco.offset + ipco.size) : [];
    const assoc = new Map<number, number[]>();
    for (const ipma of pk.filter((k) => k.type === 'ipma')) {
      const fb = fullBoxBody(m, ipma);
      let p = fb.at;
      const n = u32(m, p);
      p += 4;
      for (let i = 0; i < n; i++) {
        const id = fb.version < 1 ? u16(m, p) : u32(m, p);
        p += fb.version < 1 ? 2 : 4;
        const c = m[p++];
        const list: number[] = [];
        for (let k = 0; k < c; k++) {
          if (fb.flags & 1) {
            list.push(u16(m, p) & 0x7fff);
            p += 2;
          } else list.push(m[p++] & 0x7f);
        }
        assoc.set(id, list);
      }
    }
    for (const idx of primary !== undefined ? assoc.get(primary) ?? [] : []) {
      const prop = props[idx - 1];
      if (!prop) continue;
      const at = prop.offset + prop.header;
      if (prop.type === 'irot') fields.push(makeField('heif', 'Rotation', { name: 'Rotation', group: 'technical', sensitivity: 'none', known: true }, `${(m[at] & 3) * 90}° anticlockwise`));
      if (prop.type === 'imir') fields.push(makeField('heif', 'Mirror', { name: 'Mirror', group: 'technical', sensitivity: 'none', known: true }, m[at] & 1 ? 'horizontal axis' : 'vertical axis'));
      if (prop.type === 'colr' && (ascii(m, at, 4) === 'prof' || ascii(m, at, 4) === 'rICC')) fields.push(iccField(m.slice(at + 4, prop.offset + prop.size)));
      if (prop.type === 'ispe') {
        const fb = fullBoxBody(m, prop);
        notes.push(`${u32(m, fb.at)}x${u32(m, fb.at + 4)}`);
      }
    }
    // S9 (P7.5): the other pictures in the file (preview, depth map, portrait mask, HDR gain map) are kept byte for byte;
    // they are listed so the result says so. Grid tiles of the primary image are part of it and not listed.
    const refs = parseIref(m, find('iref'));
    const tiles = new Set(refs.filter((r) => r.type === 'dimg').flatMap((r) => r.to));
    const auxType = (id: number) => {
      for (const idx of assoc.get(id) ?? []) {
        const prop = props[idx - 1];
        if (prop?.type === 'auxC') return cstr(m, prop.offset + prop.header + 4, prop.offset + prop.size).s;
      }
      return '';
    };
    const kinds = new Map<string, number>();
    for (const it of items) {
      if (it.id === primary || tiles.has(it.id) || it.type === 'Exif' || it.type === 'mime' || it.type === 'uri ') continue;
      const aux = auxType(it.id);
      const kind = refs.some((r) => r.type === 'thmb' && r.from === it.id) ? 'thumbnail'
        : /hdrgainmap/i.test(aux) ? 'hdr'
        : /depth|disparity/i.test(aux) ? 'depth'
        : /matte|alpha/i.test(aux) ? 'matte'
        : 'image';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    const KIND_NAMES: Record<string, string> = { thumbnail: 'Preview image', hdr: 'HDR brightness map', depth: 'Depth map', matte: 'Portrait or transparency mask', image: 'Additional image' };
    for (const [kind, n] of kinds) fields.push(makeField('heif', `Image:${kind}`, { name: KIND_NAMES[kind], group: 'technical', sensitivity: 'none', known: true }, n === 1 ? 'kept unchanged' : `${n} images, kept unchanged`));

    // N10: the user-description property (language, name, description, tags as C strings) of any item.
    for (const prop of props) {
      if (prop.type !== 'udes') continue;
      const range = { offset: prop.offset + prop.header + 4, length: prop.size - prop.header - 4 };
      udesRanges.push({ offset: metaBox.offset + range.offset, length: range.length });
      const strings = utf8(m.subarray(range.offset, range.offset + range.length))
        .split('\0')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!strings.length) continue;
      const field = makeField('heif', 'Description', { name: 'Description', group: 'people', sensitivity: 'high', known: true }, strings.join(', ').slice(0, 200), strings.filter((x) => x.length >= 4));
      fields.push(field);
      udes.push({ range, field });
    }
  }

  const metaItems: HeifItem[] = [];
  for (const it of items) {
    const isExif = it.type === 'Exif';
    const isMime = it.type === 'mime';
    if (!isExif && !isMime) continue;
    if (it.construction > 1 || it.extents.length === 0) throw new UnsupportedHeifError(`metadata item ${it.id} uses an unsupported storage method`);
    metaItems.push(it);
    // The payload and its declaration (the infe box reads "Exif\0\0…") are the only places markers may appear.
    for (const e of [...it.extents, it.infe]) containers.push({ kind: isExif ? 'exif' : 'xmp', offset: e.offset, length: e.length });
    const payload = readItem(f, it);
    if (isExif) {
      const off = payload.length >= 4 ? u32(payload, 0) : 0;
      const t = parseTiff(payload.slice(4 + off));
      if (t) fields.push(...tiffFields(t));
      else if (payload.some((b) => b !== 0)) fields.push(makeField('exif', 'Unreadable', { name: 'Unreadable Exif block', group: 'other', sensitivity: 'medium', known: false }, `${payload.length} bytes`));
    } else if (isXmpItem(it) && !it.contentEncoding) {
      const x = parseXmp(utf8(payload));
      fields.push(...xmpFields(x));
    } else if (payload.some((b) => b !== 0 && b !== 0x20)) {
      fields.push(makeField('heif', `mime:${it.contentType ?? '?'}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, `${payload.length} bytes`));
    }
  }

  // Allow-list of top-level boxes (B1). A box that holds item data is kept whatever its name.
  const fileExtents = items.flatMap((i) => (i.construction === 0 ? i.extents : []));
  const holdsData = (b: Box) => fileExtents.some((e) => e.offset < b.offset + b.size && e.offset + e.length > b.offset);
  const drop: Box[] = [];
  const dataBoxes: Box[] = [];
  for (const b of top) {
    if (b === metaBox || b.type === 'ftyp') continue;
    if (KEEP_TOP.has(b.type) || holdsData(b)) {
      dataBoxes.push(b);
      continue;
    }
    drop.push(b);
    const payload = { offset: b.offset + b.header, length: b.size - b.header };
    if (b.type === 'mpvd') fields.push(makeField('trailer', 'MotionPhoto', { name: 'Motion-photo video', group: 'extras', sensitivity: 'high', known: true }, `${payload.length} bytes`));
    else if (b.type === 'free' || b.type === 'skip') {
      if (!allZero(f, payload)) fields.push(other(`box:${b.type}`, 'Leftover data in free space', payload.length, textRuns(head(f, b))));
    } else fields.push(other(`box:${b.type}`, 'Other embedded data', payload.length, textRuns(head(f, b))));
  }
  // Allow-list inside meta: anything else becomes a zero-filled `free` box.
  const metaZero: Box[] = [];
  for (const k of kids) {
    if (KEEP_META.has(k.type)) continue;
    metaZero.push(k);
    const payload = m.subarray(k.offset + k.header, k.offset + k.size);
    if (payload.every((x) => x === 0)) continue;
    const name = k.type === 'xml ' || k.type === 'bxml' ? 'XML metadata' : k.type === 'free' || k.type === 'skip' ? 'Leftover data in free space' : 'Other embedded data';
    fields.push(other(`meta:${k.type}`, name, payload.length, textRuns(payload)));
  }
  // Bytes inside the data boxes that no item uses.
  const gaps = subtract(
    dataBoxes.map((b) => ({ offset: b.offset + b.header, length: b.size - b.header })),
    fileExtents,
  );
  const unused = gaps.filter((g) => !allZero(f, g));
  if (unused.length) fields.push(other('UnusedData', 'Unused data inside the picture file', unused.reduce((s, g) => s + g.length, 0)));

  const pictureItems = items.filter((i) => !metaItems.includes(i));
  const imageExtents = pictureItems.flatMap((i) => (i.construction === 0 ? i.extents : []));
  const dims = notes.shift();
  const [width, height] = dims ? dims.split('x').map(Number) : [undefined, undefined];
  // A2: what the decoder reads must stay identical: ftyp, the item declarations and references, every decoding property
  // (minus a blanked description), and the bytes of every picture item, wherever the rebuild put them.
  const structure = ['hdlr', 'pitm', 'iinf', 'iref', 'dinf', 'grpl'].map(find).filter((x): x is Box => !!x).map(abs);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const dataRanges: Range[] = [
    ...(ftyp ? [{ offset: ftyp.offset, length: ftyp.size }] : []),
    ...structure,
    ...(iprp ? subtract([abs(iprp)], udesRanges) : []),
    ...pictureItems.flatMap((i) => i.extents),
  ].filter((r) => r.length > 0);
  return {
    items,
    primary,
    metaItems,
    top,
    drop,
    meta: metaBox,
    iloc,
    metaZero,
    udes,
    gaps,
    referencedEnd: Math.max(metaBox.offset + metaBox.size, ...fileExtents.map((e) => e.offset + e.length)),
    report: {
      fields,
      containers,
      dataRanges,
      scanRanges: outside(f.size, imageExtents),
      width,
      height,
      notes,
    },
  };
}

export class UnsupportedHeifError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UnsupportedHeifError';
  }
}

function readItem(f: ByteFile, it: HeifItem): Uint8Array {
  const total = it.extents.reduce((s, e) => s + e.length, 0);
  if (total > MAX_READ_BYTES) throw new UnsupportedHeifError('metadata item larger than 4 MB');
  return concat(it.extents.map((e) => readExact(f, e.offset, e.length)));
}

function putN(b: Uint8Array, at: number, size: number, v: number): void {
  if (size === 4) put32(b, at, v);
  else {
    put32(b, at, Math.floor(v / 0x100000000));
    put32(b, at + 4, v >>> 0);
  }
}

/**
 * Moves every file offset in the `iloc` of the meta copy `m` by `-shift(offset)`. False when `iloc` cannot express it
 * (no offset fields, or an item whose extents move by different amounts without per-extent offsets).
 */
function patchIloc(m: Uint8Array, iloc: Iloc, shift: (x: number) => number): boolean {
  for (const e of iloc.entries) {
    if (e.construction !== 0) continue;
    const moves = e.extents.map((x) => shift(e.base + x.off));
    if (moves.every((d) => d === 0)) continue;
    if (iloc.baseSize && moves.every((d) => d === moves[0]) && e.base >= moves[0]) putN(m, e.baseAt, iloc.baseSize, e.base - moves[0]);
    else if (iloc.offSize && e.extents.every((x, k) => x.off >= moves[k])) e.extents.forEach((x, k) => putN(m, x.offAt, iloc.offSize, x.off - moves[k]));
    else return false;
  }
  return true;
}

const ZERO = new Uint8Array(1024 * 1024);

/**
 * Cleans a HEIF file into the empty `dst`: writes the allow-listed boxes (B1), then rewrites the Exif/XMP payloads
 * (same length) and zeroes the unused bytes, at their new offsets.
 */
export function cleanHeif(src: ByteFile, model: HeifModel, dst: ByteFile, keep: (f: Field) => boolean): { kept: Field[]; notes: string[] } {
  const kept: Field[] = model.report.fields.filter((f) => f.source === 'heif' && keep(f));
  const icc = model.report.fields.find((f) => f.id === 'icc:ICC_Profile');
  if (icc) kept.push(icc);
  const notes: string[] = [];

  // meta: unknown children -> zero-filled `free`; description blanked unless kept; iloc offsets moved.
  const base = readExact(src, model.meta.offset, model.meta.size);
  const plan = (drop: Box[]) => {
    const m = base.slice();
    const shift = (x: number) => drop.reduce((s, b) => (b.offset + b.size <= x ? s + b.size : s), 0);
    for (const k of model.metaZero) {
      m.set(utf8Bytes('free'), k.offset + 4);
      m.fill(0, k.offset + k.header, k.offset + k.size);
    }
    for (const u of model.udes) if (!keep(u.field)) m.fill(0, u.range.offset, u.range.offset + u.range.length);
    return model.iloc && !patchIloc(m, model.iloc, shift) ? null : { m, shift };
  };
  let drop = model.drop;
  let p = plan(drop);
  if (!p) {
    // iloc cannot follow the move: boxes before the picture data stay in place as zero-filled `free` boxes.
    drop = model.drop.filter((b) => b.offset >= model.referencedEnd);
    p = plan(drop)!;
  }
  const { m, shift } = p;
  const at = (x: number) => x - shift(x);

  const w = new SeqWriter(dst);
  for (const b of model.top) {
    if (drop.includes(b)) continue;
    if (b === model.meta) w.write(m);
    else if (model.drop.includes(b)) {
      // Kept in place (see above) but emptied.
      const h = readExact(src, b.offset, b.header).slice();
      h.set(utf8Bytes('free'), 4);
      w.write(h);
      for (let left = b.size - b.header; left > 0; left -= Math.min(left, ZERO.length)) w.write(ZERO.subarray(0, Math.min(left, ZERO.length)));
    } else w.copy(src, b.offset, b.size);
  }
  for (const g of model.gaps) for (let done = 0; done < g.length; done += ZERO.length) dst.write(at(g.offset + done), ZERO.subarray(0, Math.min(ZERO.length, g.length - done)));

  for (const it of model.metaItems) {
    const payload = readItem(src, it);
    const out = new Uint8Array(payload.length); // zero-filled
    if (it.type === 'Exif') {
      const off = payload.length >= 4 ? u32(payload, 0) : 0;
      const prefix = payload.slice(0, Math.min(payload.length, 4 + off));
      const t = parseTiff(payload.slice(4 + off));
      out.set(prefix, 0);
      if (t) {
        // Orientation in HEIF is the irot property; the Exif copy of it is removed (plan P2).
        const r = rebuildTiff(t, (f) => f.id !== 'exif:Orientation' && keep(f));
        let tiff = r.bytes ?? writeTiff(t.endian, []);
        if (prefix.length + tiff.length > payload.length) {
          notes.push('Kept Exif did not fit in place and was removed');
          tiff = writeTiff(t.endian, []);
        } else kept.push(...r.kept);
        if (prefix.length + tiff.length <= payload.length) out.set(tiff, prefix.length);
      }
    } else if (isXmpItem(it) && !it.contentEncoding) {
      const r = rebuildXmp(parseXmp(utf8(payload)).props, keep);
      let text = padPacket(r.packet ?? EMPTY_XMP, payload.length);
      if (text === null && r.packet) {
        notes.push('Kept XMP did not fit in place and was removed');
        text = padPacket(EMPTY_XMP, payload.length);
      } else if (r.packet) kept.push(...r.kept);
      if (text !== null) out.set(utf8Bytes(text), 0);
      else out.fill(0x20);
    }
    let o = 0;
    for (const e of it.extents) {
      dst.write(at(e.offset), out.slice(o, o + e.length));
      o += e.length;
    }
  }
  return { kept, notes };
}
