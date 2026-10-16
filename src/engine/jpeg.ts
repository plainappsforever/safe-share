/**
 * JPEG: segment walker, inspection and streaming clean. Everything from the first SOS to EOI (minus
 * APPn/COM segments between scans) is image data and is copied byte-for-byte (A2); metadata segments
 * before it are dropped or rebuilt per profile; everything after EOI (Ultra HDR gain map, Motion
 * Photo video, other trailers) is removed (R1).
 */
import { ascii, asciiBytes, concat, put16, startsWith, u16, utf8, utf8Bytes } from './binary';
import { makeField, type Field } from './catalog';
import type { ByteFile } from './byte-file';
import { iccField } from './icc';
import type { Container, FormatReport } from './inspect';
import { readExact, SeqWriter, type Range } from './io';
import { irbFields, parseIrb, PHOTOSHOP_ID, rebuildIrb } from './iptc';
import { parseTiff, tiffFields } from './tiff';
import { rebuildTiff } from './tiff-writer';
import { parseXmp, rebuildXmp, XMP_EXT_ID, XMP_JPEG_ID, xmpFields, type XmpProp } from './xmp';

const CHUNK = 1024 * 1024;
const EXIF_ID = 'Exif\0\0';
const ICC_ID = 'ICC_PROFILE\0';

type Kind = 'jfif' | 'jfxx' | 'exif' | 'xmp' | 'xmp-ext' | 'icc' | 'mpf' | 'iptc' | 'adobe' | 'com' | 'app-other' | 'structure';

interface Segment {
  marker: number;
  offset: number;
  /** Total bytes including the 2-byte marker. */
  length: number;
  kind: Kind;
  payload?: Uint8Array;
}

export interface JpegLayout {
  segments: Segment[];
  /** Image data: first SOS .. EOI inclusive, minus APPn/COM between scans. */
  dataRanges: Range[];
  /** APPn/COM segments found between scans (removed on clean). */
  inScan: Segment[];
  eoiEnd: number;
  width?: number;
  height?: number;
}

export class CorruptError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CorruptError';
  }
}

function kindOf(marker: number, p: Uint8Array): Kind {
  if (marker === 0xfe) return 'com';
  if (marker < 0xe0 || marker > 0xef) return 'structure';
  const app = marker - 0xe0;
  if (app === 0 && startsWith(p, 'JFIF\0')) return 'jfif';
  if (app === 0 && startsWith(p, 'JFXX\0')) return 'jfxx';
  if (app === 1 && startsWith(p, EXIF_ID)) return 'exif';
  if (app === 1 && startsWith(p, XMP_JPEG_ID)) return 'xmp';
  if (app === 1 && startsWith(p, XMP_EXT_ID)) return 'xmp-ext';
  if (app === 2 && startsWith(p, ICC_ID)) return 'icc';
  if (app === 2 && startsWith(p, 'MPF\0')) return 'mpf';
  if (app === 13 && startsWith(p, PHOTOSHOP_ID)) return 'iptc';
  if (app === 14 && startsWith(p, 'Adobe')) return 'adobe';
  return 'app-other';
}

const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Walks the file with reads of at most 1 MB. Throws CorruptError when the structure is broken or truncated. */
export function parseJpeg(f: ByteFile): JpegLayout {
  const size = f.size;
  const segments: Segment[] = [];
  const inScan: Segment[] = [];
  const dataRanges: Range[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let pos = 2;
  let dataStart = -1;

  const marker = (at: number): { m: number; at: number } => {
    // Skips fill bytes (0xFF 0xFF ...).
    let p = at;
    for (;;) {
      const b = f.read(p, 2);
      if (b.length < 2) throw new CorruptError('file ends inside the headers');
      if (b[0] !== 0xff) throw new CorruptError(`expected a marker at ${p}`);
      if (b[1] !== 0xff) return { m: b[1], at: p };
      p++;
    }
  };

  // Headers up to the first SOS.
  for (;;) {
    const { m, at } = marker(pos);
    if (m === 0xd9) throw new CorruptError('image ends before any picture data');
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      pos = at + 2;
      continue;
    }
    const lenB = f.read(at + 2, 2);
    if (lenB.length < 2) throw new CorruptError('truncated segment');
    const len = u16(lenB, 0);
    if (len < 2 || at + 2 + len > size) throw new CorruptError('segment runs past the end of the file');
    if (m === 0xda) {
      dataStart = at;
      pos = at + 2 + len;
      break;
    }
    const isMeta = (m >= 0xe0 && m <= 0xef) || m === 0xfe || isSof(m);
    const payload = isMeta ? readExact(f, at + 4, len - 2) : undefined;
    const seg: Segment = { marker: m, offset: at, length: len + 2, kind: payload ? kindOf(m, payload) : 'structure', payload };
    if (isSof(m) && payload && payload.length >= 5) {
      height = u16(payload, 1);
      width = u16(payload, 3);
      seg.payload = undefined;
    }
    segments.push(seg);
    pos = at + 2 + len;
  }

  // Entropy-coded data and inter-scan segments until EOI.
  let rangeStart = dataStart;
  let eoiEnd = -1;
  let p = pos;
  while (eoiEnd < 0) {
    const buf = f.read(p, CHUNK);
    if (buf.length < 2) throw new CorruptError('picture data is cut off (no end marker)');
    let i = 0;
    let advanced = false;
    while (i < buf.length - 1) {
      const k = buf.indexOf(0xff, i);
      if (k < 0 || k >= buf.length - 1) {
        i = k < 0 ? buf.length : k;
        break;
      }
      const n = buf[k + 1];
      if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
        i = k + 1;
        continue;
      }
      const at = p + k;
      if (n === 0xd9) {
        eoiEnd = at + 2;
        advanced = true;
        break;
      }
      // A marker segment between scans (DHT, DQT, DRI, SOS, or APPn/COM).
      const lenB = f.read(at + 2, 2);
      if (lenB.length < 2) throw new CorruptError('picture data is cut off');
      const len = u16(lenB, 0);
      if (len < 2 || at + 2 + len > size) throw new CorruptError('segment runs past the end of the file');
      if ((n >= 0xe0 && n <= 0xef) || n === 0xfe) {
        const payload = readExact(f, at + 4, len - 2);
        inScan.push({ marker: n, offset: at, length: len + 2, kind: kindOf(n, payload), payload });
        if (at > rangeStart) dataRanges.push({ offset: rangeStart, length: at - rangeStart });
        rangeStart = at + 2 + len;
      }
      p = at + 2 + len;
      advanced = true;
      break;
    }
    if (eoiEnd >= 0) break;
    if (!advanced) p += Math.max(1, i);
  }
  dataRanges.push({ offset: rangeStart, length: eoiEnd - rangeStart });
  return { segments, dataRanges, inScan, eoiEnd, width, height };
}

function jfifThumbnail(p: Uint8Array): number {
  return p.length >= 14 ? p[12] * p[13] * 3 : 0;
}

interface ExtendedXmp {
  guid: string;
  total: number;
  parts: { at: number; data: Uint8Array }[];
}

function joinExtended(segs: Segment[]): string | null {
  const byGuid = new Map<string, ExtendedXmp>();
  for (const s of segs) {
    const p = s.payload!;
    const base = XMP_EXT_ID.length;
    if (p.length < base + 40) continue;
    const guid = ascii(p, base, 32);
    const total = (p[base + 32] << 24) | (p[base + 33] << 16) | (p[base + 34] << 8) | p[base + 35];
    const at = (p[base + 36] << 24) | (p[base + 37] << 16) | (p[base + 38] << 8) | p[base + 39];
    const e = byGuid.get(guid) ?? { guid, total, parts: [] };
    e.parts.push({ at, data: p.slice(base + 40) });
    byGuid.set(guid, e);
  }
  const texts: string[] = [];
  for (const e of byGuid.values()) {
    e.parts.sort((a, b) => a.at - b.at);
    texts.push(utf8(concat(e.parts.map((x) => x.data))));
  }
  return texts.length ? texts.join('\n') : null;
}

export interface JpegModel {
  layout: JpegLayout;
  report: FormatReport;
  xmpProps: XmpProp[];
}

export function inspectJpeg(f: ByteFile): JpegModel {
  const layout = parseJpeg(f);
  const fields: Field[] = [];
  const containers: Container[] = [];
  const notes: string[] = [];
  const xmpProps: XmpProp[] = [];
  const all = [...layout.segments, ...layout.inScan];
  const icc: Uint8Array[] = [];
  for (const s of all) {
    const p = s.payload;
    const range = { offset: s.offset, length: s.length };
    switch (s.kind) {
      case 'jfif':
        if (p && jfifThumbnail(p) > 0) {
          fields.push(makeField('jpeg', 'JFIFThumbnail', { name: 'Hidden preview image', group: 'extras', sensitivity: 'medium', known: true }, `${jfifThumbnail(p)} bytes`));
        }
        break;
      case 'jfxx':
        fields.push(makeField('jpeg', 'JFXXThumbnail', { name: 'Hidden preview image', group: 'extras', sensitivity: 'medium', known: true }, `${s.length} bytes`));
        break;
      case 'exif': {
        containers.push({ kind: 'exif', ...range });
        const t = parseTiff(p!.slice(EXIF_ID.length));
        if (t) fields.push(...tiffFields(t));
        else fields.push(makeField('exif', 'Unreadable', { name: 'Unreadable Exif block', group: 'other', sensitivity: 'medium', known: false }, `${s.length} bytes`));
        break;
      }
      case 'xmp': {
        containers.push({ kind: 'xmp', ...range });
        const x = parseXmp(utf8(p!, XMP_JPEG_ID.length));
        xmpProps.push(...x.props);
        fields.push(...xmpFields(x));
        if (!x.ok) fields.push(makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${s.length} bytes`));
        break;
      }
      case 'xmp-ext':
        containers.push({ kind: 'xmp', ...range });
        break;
      case 'icc':
        icc.push(p!.slice(ICC_ID.length + 2));
        break;
      case 'mpf':
        containers.push({ kind: 'mpf', ...range });
        fields.push(makeField('jpeg', 'MPF', { name: 'Multi-picture index (HDR or depth image)', group: 'extras', sensitivity: 'medium', known: true }, `${s.length} bytes`));
        break;
      case 'iptc': {
        containers.push({ kind: 'iptc', ...range });
        fields.push(...irbFields(parseIrb(p!.slice(PHOTOSHOP_ID.length))));
        break;
      }
      case 'com': {
        // An all-zero comment is what a neutralised metadata segment looks like (PDF-embedded photos, P7.5): nothing to report.
        if (p!.every((b) => b === 0)) break;
        const text = utf8(p!).replace(/\0+$/, '');
        fields.push(makeField('jpeg', 'Comment', { name: 'Comment', group: 'people', sensitivity: 'high', known: true }, text, text.length >= 3 ? [text] : []));
        break;
      }
      case 'app-other': {
        const label = ascii(p!, 0, Math.min(16, p!.length)).replace(/[^\x20-\x7e][\s\S]*$/, '');
        fields.push(
          makeField('jpeg', `APP${s.marker - 0xe0}${label ? `:${label}` : ''}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, `${s.length} bytes`),
        );
        break;
      }
      default:
        break;
    }
  }
  const ext = joinExtended(all.filter((s) => s.kind === 'xmp-ext'));
  if (ext !== null) {
    const x = parseXmp(ext);
    xmpProps.push(...x.props);
    fields.push(...xmpFields(x));
  }
  if (icc.length) fields.push(iccField(concat(icc)));
  if (layout.inScan.length) notes.push(`${layout.inScan.length} metadata block(s) between picture scans`);

  const trailer = f.size - layout.eoiEnd;
  if (trailer > 0) {
    const head = f.read(layout.eoiEnd, 16);
    const motion = xmpProps.some((p) => p.prefix === 'GCamera' && /^(MotionPhoto$|MicroVideo$)/.test(p.local)) || ascii(head, 4, 4) === 'ftyp';
    const gain = !motion && head[0] === 0xff && head[1] === 0xd8;
    const key = motion ? 'MotionPhoto' : gain ? 'GainMap' : 'Data';
    const name = motion ? 'Motion-photo video' : gain ? 'Second image (HDR gain map or depth)' : 'Data after the end of the picture';
    fields.push(makeField('trailer', key, { name, group: 'extras', sensitivity: motion ? 'high' : 'medium', known: true }, `${trailer} bytes`));
    containers.push({ kind: 'trailer', offset: layout.eoiEnd, length: trailer });
  }
  const scanRanges: Range[] = [];
  let pos = 0;
  for (const r of layout.dataRanges) {
    if (r.offset > pos) scanRanges.push({ offset: pos, length: r.offset - pos });
    pos = r.offset + r.length;
  }
  if (pos < f.size) scanRanges.push({ offset: pos, length: f.size - pos });
  return {
    layout,
    xmpProps,
    report: { fields, containers, dataRanges: layout.dataRanges, scanRanges, width: layout.width, height: layout.height, notes },
  };
}

function segmentBytes(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) throw new RangeError('segment too large');
  const h = Uint8Array.from([0xff, marker, 0, 0]);
  put16(h, 2, payload.length + 2);
  return concat([h, payload]);
}

/** Writes the cleaned JPEG to `dst` (empty, writable). Returns the fields actually written. */
export function cleanJpeg(src: ByteFile, model: JpegModel, dst: ByteFile, keep: (f: Field) => boolean): { kept: Field[]; notes: string[] } {
  const w = new SeqWriter(dst);
  const kept: Field[] = [];
  const notes: string[] = [];
  const { layout } = model;
  let exifDone = false;
  let xmpDone = false;
  let iptcDone = false;
  w.write(Uint8Array.from([0xff, 0xd8]));
  for (const s of layout.segments) {
    const p = s.payload;
    switch (s.kind) {
      case 'structure':
      case 'adobe':
      case 'icc':
        // Review S4 (V1.5-1): APP2 blocks that only claim to be a colour profile are dropped, not kept as colour.
        if (s.kind === 'icc' && !model.report.fields.some((x) => x.id === 'icc:ICC_Profile')) break;
        w.copy(src, s.offset, s.length);
        if (s.kind === 'icc' && !kept.some((k) => k.id === 'icc:ICC_Profile')) {
          const iccFieldKept = model.report.fields.find((x) => x.id === 'icc:ICC_Profile');
          if (iccFieldKept) kept.push(iccFieldKept);
        }
        break;
      case 'jfif':
        if (jfifThumbnail(p!) > 0) {
          const q = p!.slice(0, 14);
          q[12] = 0;
          q[13] = 0;
          w.write(segmentBytes(0xe0, q));
        } else w.copy(src, s.offset, s.length);
        break;
      case 'exif': {
        if (exifDone) break;
        exifDone = true;
        const t = parseTiff(p!.slice(EXIF_ID.length));
        if (!t) break;
        const r = rebuildTiff(t, keep);
        if (r.bytes) {
          w.write(segmentBytes(0xe1, concat([asciiBytes(EXIF_ID), r.bytes])));
          kept.push(...r.kept);
        }
        break;
      }
      case 'xmp': {
        if (xmpDone) break;
        xmpDone = true;
        const r = rebuildXmp(model.xmpProps, keep);
        if (r.packet) {
          const payload = concat([asciiBytes(XMP_JPEG_ID), utf8Bytes(r.packet)]);
          if (payload.length + 2 <= 0xffff) {
            w.write(segmentBytes(0xe1, payload));
            kept.push(...r.kept);
          } else notes.push('Kept XMP was too large for one block and was removed');
        }
        break;
      }
      case 'iptc': {
        if (iptcDone) break;
        iptcDone = true;
        const irb = parseIrb(p!.slice(PHOTOSHOP_ID.length));
        const r = rebuildIrb(irb, keep);
        if (r.bytes) {
          w.write(segmentBytes(0xed, r.bytes));
          kept.push(...r.kept);
        }
        break;
      }
      default:
        break; // jfxx, xmp-ext, mpf, com, app-other: removed
    }
  }
  for (const r of layout.dataRanges) w.copy(src, r.offset, r.length);
  return { kept, notes };
}

