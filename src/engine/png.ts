/**
 * PNG: chunk filter. Pixel, palette, colour and animation chunks are copied unchanged (CRCs stay
 * valid); eXIf and XMP (iTXt "XML:com.adobe.xmp") are rebuilt per profile; text chunks are kept or
 * dropped whole by keyword; unknown ancillary chunks are removed.
 */
import { inflate } from 'pako';

import { ascii, asciiBytes, concat, crc32, put32, u32, utf8, utf8Bytes } from './binary';
import { describePngText, makeField, type Field } from './catalog';
import type { ByteFile } from './byte-file';
import type { Container, FormatReport } from './inspect';
import { readExact, SeqWriter, type Range } from './io';
import { CorruptError } from './jpeg';
import { parseTiff, tiffFields } from './tiff';
import { rebuildTiff } from './tiff-writer';
import { parseXmp, rebuildXmp, xmpFields, type XmpProp } from './xmp';

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const XMP_KEYWORD = 'XML:com.adobe.xmp';
/** Chunks copied unchanged: image data, palette, transparency, colour, physical size, animation. */
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'hIST', 'pHYs', 'acTL', 'fcTL', 'fdAT']);
const DATA = new Set(['IDAT', 'fdAT']);
/** Metadata payloads larger than this are not parsed (display only; removal still works). */
const MAX_META = 4 * 1024 * 1024;

interface Chunk {
  type: string;
  offset: number;
  /** Payload length. */
  length: number;
}

export interface PngModel {
  chunks: Chunk[];
  report: FormatReport;
  /** Field(s) per chunk index, for per-chunk keep decisions. */
  chunkFields: Map<number, Field[]>;
  xmpProps: XmpProp[];
  width?: number;
  height?: number;
}

export function parsePng(f: ByteFile): Chunk[] {
  const sig = f.read(0, 8);
  if (sig.length < 8 || !sig.every((b, i) => b === SIG[i])) throw new CorruptError('not a PNG');
  const chunks: Chunk[] = [];
  let pos = 8;
  const size = f.size;
  for (;;) {
    const h = f.read(pos, 8);
    if (h.length < 8) throw new CorruptError('PNG ends without IEND');
    const length = u32(h, 0);
    const type = ascii(h, 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type) || pos + 12 + length > size) throw new CorruptError(`broken chunk at ${pos}`);
    chunks.push({ type, offset: pos, length });
    pos += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** zlib data -> bytes, or null when it cannot be inflated (never throws). */
function unzip(b: Uint8Array): Uint8Array | null {
  try {
    const out = inflate(b);
    return out instanceof Uint8Array ? out : null;
  } catch {
    return null;
  }
}

/** Text chunk -> keyword + text (compressed zTXt/iTXt are inflated with pako; null text when that fails). */
function textChunk(type: string, b: Uint8Array): { keyword: string; text: string | null; inflated?: Uint8Array } {
  const z = b.indexOf(0);
  const keyword = ascii(b, 0, z < 0 ? b.length : z);
  if (z < 0) return { keyword, text: '' };
  if (type === 'tEXt') return { keyword, text: ascii(b, z + 1) };
  if (type === 'zTXt') {
    const raw = b[z + 1] === 0 ? unzip(b.subarray(z + 2)) : null;
    return { keyword, text: raw ? ascii(raw) : null, inflated: raw ?? undefined };
  }
  // iTXt: keyword\0 flag method lang\0 translated\0 text
  const compressed = b[z + 1] === 1;
  let p = z + 3;
  const l = b.indexOf(0, p);
  p = l < 0 ? b.length : l + 1;
  const t = b.indexOf(0, p);
  p = t < 0 ? b.length : t + 1;
  if (!compressed) return { keyword, text: utf8(b, p) };
  const raw = b[z + 2] === 0 ? unzip(b.subarray(p)) : null;
  return { keyword, text: raw ? utf8(raw) : null, inflated: raw ?? undefined };
}

export function inspectPng(f: ByteFile): PngModel {
  const chunks = parsePng(f);
  const fields: Field[] = [];
  const containers: Container[] = [];
  const dataRanges: Range[] = [];
  const scanRanges: Range[] = [];
  const chunkFields = new Map<number, Field[]>();
  const xmpProps: XmpProp[] = [];
  const derived: Uint8Array[] = [];
  const opaque: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let pos = 0;
  chunks.forEach((c, i) => {
    const whole = { offset: c.offset, length: c.length + 12 };
    const add = (fs: Field[]) => {
      chunkFields.set(i, fs);
      fields.push(...fs);
    };
    if (DATA.has(c.type)) {
      // Payload is pixel data; the 8-byte header and CRC are scanned.
      if (c.offset + 8 > pos) scanRanges.push({ offset: pos, length: c.offset + 8 - pos });
      dataRanges.push({ offset: c.offset + 8, length: c.length });
      pos = c.offset + 8 + c.length;
      return;
    }
    const readPayload = () => (c.length <= MAX_META ? readExact(f, c.offset + 8, c.length) : null);
    if (c.type === 'IHDR') {
      const p = readExact(f, c.offset + 8, 8);
      width = u32(p, 0);
      height = u32(p, 4);
    } else if (c.type === 'iCCP') {
      // The profile itself is zlib-compressed; its name (keyword) is enough for display.
      const p = f.read(c.offset + 8, Math.min(80, c.length));
      const z = p.indexOf(0);
      add([makeField('icc', 'ICC_Profile', { name: 'Colour profile', group: 'technical', sensitivity: 'none', known: true }, ascii(p, 0, z < 0 ? 0 : z) || 'embedded')]);
    } else if (c.type === 'eXIf') {
      containers.push({ kind: 'exif', ...whole });
      const p = readPayload();
      const t = p ? parseTiff(p[0] === 0x45 ? p.slice(6) : p) : null; // tolerate an "Exif\0\0" prefix
      add(t ? tiffFields(t) : [makeField('exif', 'Unreadable', { name: 'Unreadable Exif block', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`)]);
    } else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const p = readPayload();
      const { keyword, text, inflated } = p ? textChunk(c.type, p) : { keyword: '?', text: null, inflated: undefined };
      if (inflated) derived.push(inflated);
      if (p && text === null && c.type !== 'tEXt') opaque.push(`compressed text "${keyword}"`);
      if (keyword === XMP_KEYWORD && text !== null) {
        containers.push({ kind: 'xmp', ...whole });
        const x = parseXmp(text);
        xmpProps.push(...x.props);
        const unreadable = x.ok ? [] : [makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`)];
        add([...xmpFields(x), ...unreadable]);
      } else if (keyword === XMP_KEYWORD) {
        add([makeField('png', 'XMP', { name: 'Compressed XMP block', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`)]);
      } else {
        containers.push({ kind: 'png-text', ...whole });
        // Unreadable compressed text cannot be proven harmless: it is "Other" and removed by every profile.
        const d = text === null ? { name: `Unreadable compressed text "${keyword}"`, group: 'other' as const, sensitivity: 'medium' as const, known: false } : describePngText(keyword);
        const value = text === null ? '(compressed, unreadable)' : text.trim();
        add([makeField('png', keyword, d, value.length > 200 ? `${value.slice(0, 200)}…` : value, text !== null && value.length >= 3 ? [value] : [])]);
      }
    } else if (c.type === 'tIME') {
      const p = readExact(f, c.offset + 8, Math.min(7, c.length));
      const pad = (n: number) => String(n).padStart(2, '0');
      const v = p.length === 7 ? `${(p[0] << 8) | p[1]}:${pad(p[2])}:${pad(p[3])} ${pad(p[4])}:${pad(p[5])}:${pad(p[6])}` : 'present';
      add([makeField('png', 'ModifyDate', { name: 'Date modified', group: 'datetime', sensitivity: 'medium', known: true }, v)]);
    } else if (!KEEP.has(c.type) && (c.type.charCodeAt(0) & 0x20) !== 0) {
      add([makeField('png', `chunk:${c.type}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, `${c.length} bytes`)]);
    }
  });
  if (pos < f.size) scanRanges.push({ offset: pos, length: f.size - pos });
  const last = chunks[chunks.length - 1];
  const end = last.offset + last.length + 12;
  if (end < f.size) {
    // Bytes after IEND are never copied; list them so the user sees they existed.
    fields.push(makeField('trailer', 'Data', { name: 'Data after the end of the picture', group: 'extras', sensitivity: 'medium', known: true }, `${f.size - end} bytes`));
    containers.push({ kind: 'trailer', offset: end, length: f.size - end });
  }
  return { chunks, chunkFields, xmpProps, width, height, report: { fields, containers, dataRanges, scanRanges, width, height, notes: [], derived, opaque } };
}

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  put32(head, 0, data.length);
  head.set(asciiBytes(type), 4);
  const t = asciiBytes(type);
  const crc = new Uint8Array(4);
  put32(crc, 0, crc32([t, data]));
  return concat([head, data, crc]);
}

export function cleanPng(src: ByteFile, model: PngModel, dst: ByteFile, keep: (f: Field) => boolean): { kept: Field[]; notes: string[] } {
  const w = new SeqWriter(dst);
  const kept: Field[] = [];
  const notes: string[] = [];
  let xmpDone = false;
  w.write(SIG);
  model.chunks.forEach((c, i) => {
    const fs = model.chunkFields.get(i);
    if (c.type === 'eXIf') {
      const p = c.length <= MAX_META ? readExact(src, c.offset + 8, c.length) : null;
      const t = p ? parseTiff(p[0] === 0x45 ? p.slice(6) : p) : null;
      if (!t) return;
      const r = rebuildTiff(t, keep);
      if (r.bytes) {
        w.write(chunkBytes('eXIf', r.bytes));
        kept.push(...r.kept);
      }
      return;
    }
    if (fs && fs.some((f) => f.source === 'xmp')) {
      if (xmpDone) return;
      xmpDone = true;
      const r = rebuildXmp(model.xmpProps, keep);
      if (r.packet) {
        // iTXt: keyword\0, compression flag 0, method 0, empty language\0, empty translated keyword\0, text.
        const data = concat([asciiBytes(XMP_KEYWORD), Uint8Array.from([0, 0, 0, 0, 0]), utf8Bytes(r.packet)]);
        w.write(chunkBytes('iTXt', data));
        kept.push(...r.kept);
      }
      return;
    }
    const critical = (c.type.charCodeAt(0) & 0x20) === 0;
    // Known pixel/colour chunks and unknown critical chunks are copied; field chunks only when every field is kept.
    const copy = KEEP.has(c.type) || (fs ? fs.every((f) => keep(f)) : critical);
    if (copy) {
      w.copy(src, c.offset, c.length + 12);
      if (fs) kept.push(...fs);
    }
  });
  return { kept, notes };
}
