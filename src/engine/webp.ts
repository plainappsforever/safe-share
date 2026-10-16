/**
 * WebP (RIFF): chunk filter. VP8/VP8L/ALPH/ANIM/ANMF and ICCP are copied unchanged; EXIF and XMP
 * are rebuilt per profile; unknown chunks are removed; the VP8X flags and RIFF size are fixed.
 */
import { ascii, asciiBytes, concat, put32, u32, utf8, utf8Bytes } from './binary';
import { makeField, type Field } from './catalog';
import type { ByteFile } from './byte-file';
import { iccField } from './icc';
import type { Container, FormatReport } from './inspect';
import { readExact, SeqWriter, type Range } from './io';
import { CorruptError } from './jpeg';
import { parseTiff, tiffFields } from './tiff';
import { rebuildTiff } from './tiff-writer';
import { parseXmp, rebuildXmp, xmpFields, type XmpProp } from './xmp';

const DATA = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);
const FLAG_ICC = 0x20;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;
const MAX_META = 4 * 1024 * 1024;

interface Chunk {
  type: string;
  offset: number;
  length: number;
}

export interface WebpModel {
  chunks: Chunk[];
  report: FormatReport;
  xmpProps: XmpProp[];
}

export function parseWebp(f: ByteFile): Chunk[] {
  const h = f.read(0, 12);
  if (h.length < 12 || ascii(h, 0, 4) !== 'RIFF' || ascii(h, 8, 4) !== 'WEBP') throw new CorruptError('not a WebP file');
  const end = Math.min(f.size, u32(h, 4, 'LE') + 8);
  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos + 8 <= end) {
    const c = f.read(pos, 8);
    const type = ascii(c, 0, 4);
    const length = u32(c, 4, 'LE');
    if (pos + 8 + length > end) throw new CorruptError(`broken chunk ${type} at ${pos}`);
    chunks.push({ type, offset: pos, length });
    pos += 8 + length + (length & 1);
  }
  if (!chunks.some((c) => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) throw new CorruptError('WebP without image data');
  return chunks;
}

function exifTiff(p: Uint8Array) {
  return parseTiff(p[0] === 0x45 && p[1] === 0x78 ? p.slice(6) : p); // tolerate an "Exif\0\0" prefix
}

export function inspectWebp(f: ByteFile): WebpModel {
  const chunks = parseWebp(f);
  const fields: Field[] = [];
  const containers: Container[] = [];
  const dataRanges: Range[] = [];
  const xmpProps: XmpProp[] = [];
  let width: number | undefined;
  let height: number | undefined;
  for (const c of chunks) {
    const whole = { offset: c.offset, length: c.length + 8 };
    if (DATA.has(c.type)) {
      dataRanges.push(whole);
      if (width === undefined && c.type === 'VP8L') {
        const p = readExact(f, c.offset + 8, 5);
        const bits = p[1] | (p[2] << 8) | (p[3] << 16) | (p[4] << 24);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      } else if (width === undefined && c.type === 'VP8 ' && c.length >= 10) {
        const p = readExact(f, c.offset + 8, 10);
        width = (p[6] | (p[7] << 8)) & 0x3fff;
        height = (p[8] | (p[9] << 8)) & 0x3fff;
      }
      continue;
    }
    if (c.type === 'VP8X') {
      const p = readExact(f, c.offset + 8, 10);
      width = 1 + (p[4] | (p[5] << 8) | (p[6] << 16));
      height = 1 + (p[7] | (p[8] << 8) | (p[9] << 16));
      continue;
    }
    const p = c.length <= MAX_META ? readExact(f, c.offset + 8, c.length) : null;
    if (c.type === 'ICCP') {
      if (p) fields.push(iccField(p));
    } else if (c.type === 'EXIF') {
      containers.push({ kind: 'exif', ...whole });
      const t = p ? exifTiff(p) : null;
      if (t) fields.push(...tiffFields(t));
      else fields.push(makeField('exif', 'Unreadable', { name: 'Unreadable Exif block', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`));
    } else if (c.type === 'XMP ') {
      containers.push({ kind: 'xmp', ...whole });
      const x = p ? parseXmp(utf8(p)) : { props: [], ok: false };
      xmpProps.push(...x.props);
      fields.push(...xmpFields(x));
      if (!x.ok) fields.push(makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`));
    } else {
      fields.push(makeField('webp', `chunk:${c.type.trim()}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`));
    }
  }
  const scanRanges: Range[] = [];
  let pos = 0;
  for (const r of dataRanges) {
    if (r.offset > pos) scanRanges.push({ offset: pos, length: r.offset - pos });
    pos = r.offset + r.length;
  }
  if (pos < f.size) scanRanges.push({ offset: pos, length: f.size - pos });
  const riffEnd = Math.min(f.size, u32(f.read(4, 4), 0, 'LE') + 8);
  if (riffEnd < f.size) {
    fields.push(makeField('trailer', 'Data', { name: 'Data after the end of the picture', group: 'extras', sensitivity: 'medium', known: true }, `${f.size - riffEnd} bytes`));
    containers.push({ kind: 'trailer', offset: riffEnd, length: f.size - riffEnd });
  }
  return { chunks, xmpProps, report: { fields, containers, dataRanges, scanRanges, width, height, notes: [] } };
}

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  head.set(asciiBytes(type), 0);
  put32(head, 4, data.length, 'LE');
  return concat([head, data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

export function cleanWebp(src: ByteFile, model: WebpModel, dst: ByteFile, keep: (f: Field) => boolean): { kept: Field[]; notes: string[] } {
  const w = new SeqWriter(dst);
  const kept: Field[] = [];
  let vp8xAt = -1;
  let flags = 0;
  let xmpDone = false;
  w.write(concat([asciiBytes('RIFF'), new Uint8Array(4), asciiBytes('WEBP')]));
  for (const c of model.chunks) {
    const whole = c.length + 8 + (c.length & 1);
    if (c.type === 'VP8X') {
      const p = readExact(src, c.offset + 8, c.length);
      vp8xAt = w.pos + 8;
      flags = p[0] & ~(FLAG_EXIF | FLAG_XMP | FLAG_ICC);
      w.write(chunkBytes('VP8X', p));
    } else if (DATA.has(c.type)) {
      w.copy(src, c.offset, whole);
    } else if (c.type === 'ICCP') {
      // Review S4 (V1.5-1): a chunk that only claims to be a colour profile is dropped.
      const icc = model.report.fields.find((f) => f.id === 'icc:ICC_Profile');
      if (!icc) continue;
      w.copy(src, c.offset, whole);
      kept.push(icc);
      flags |= FLAG_ICC;
    } else if (c.type === 'EXIF') {
      const p = c.length <= MAX_META ? readExact(src, c.offset + 8, c.length) : null;
      const t = p ? exifTiff(p) : null;
      if (!t) continue;
      const r = rebuildTiff(t, keep);
      if (r.bytes) {
        w.write(chunkBytes('EXIF', r.bytes));
        kept.push(...r.kept);
        flags |= FLAG_EXIF;
      }
    } else if (c.type === 'XMP ') {
      if (xmpDone) continue;
      xmpDone = true;
      const r = rebuildXmp(model.xmpProps, keep);
      if (r.packet) {
        w.write(chunkBytes('XMP ', utf8Bytes(r.packet)));
        kept.push(...r.kept);
        flags |= FLAG_XMP;
      }
    }
    // Unknown chunks: removed.
  }
  const size = new Uint8Array(4);
  put32(size, 0, w.pos - 8, 'LE');
  dst.write(4, size);
  if (vp8xAt >= 0) dst.write(vp8xAt, Uint8Array.from([flags]));
  return { kept, notes: [] };
}
