/**
 * PDF (ISO 32000-1): finds every document-information dictionary of every revision (classic trailers and
 * cross-reference streams, incl. objects inside compressed object streams), every `/Type /Metadata` XMP
 * stream, and reports annotation authors, attached files, forms, JavaScript and signatures.
 * Cleans IN PLACE on a byte copy (RESEARCH §2, D10): removed entries are overwritten with spaces, XMP streams
 * are rewritten; Flate streams are inflated with pako, changed, deflated, and written with a /Length padded
 * to the same digit count and `endstream endobj` moved up — every later offset stays valid, the file keeps
 * its length and page content is never touched (A2).
 *
 * Objects are found by a linear scan of the whole file (so orphaned older versions are found too), in
 * windows of at most 4 MB; stream data is skipped by /Length.
 */
import { deflate, inflate } from 'pako';

import { ascii, asciiBytes, utf16, utf8, utf8Bytes } from './binary';
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import { describePdfInfo, makeField, type Field } from './catalog';
import type { Container, FormatReport } from './inspect';
import { outside, readExact, SeqWriter, type Range } from './io';
import { CorruptError, inspectJpeg } from './jpeg';
import { EMPTY_XMP, padPacket, parseXmp, rebuildXmp, xmpFields, type XmpProp } from './xmp';

export class UnsupportedPdfError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UnsupportedPdfError';
  }
}

// ---------------------------------------------------------------- tokenizer / parser

type Val =
  | { k: 'dict'; entries: Entry[]; start: number; end: number }
  | { k: 'arr'; items: Val[]; start: number; end: number }
  | { k: 'str'; bytes: Uint8Array; start: number; end: number }
  | { k: 'name'; v: string; start: number; end: number }
  | { k: 'num'; v: number; start: number; end: number }
  | { k: 'ref'; num: number; gen: number; start: number; end: number }
  | { k: 'kw'; v: string; start: number; end: number };

interface Entry {
  key: string;
  keyStart: number;
  val: Val;
}

class NeedMore extends Error {}
class Bad extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

class Parser {
  constructor(
    readonly b: Uint8Array,
    public i: number,
    /** True when the buffer ends where the file (or decoded stream) ends. */
    readonly atEnd: boolean,
  ) {}

  more(): never {
    if (this.atEnd) throw new Bad('unexpected end');
    throw new NeedMore();
  }

  ws(): void {
    const b = this.b;
    for (;;) {
      if (this.i >= b.length) return;
      const c = b[this.i];
      if (WS.has(c)) this.i++;
      else if (c === 0x25) {
        while (this.i < b.length && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++;
      } else return;
    }
  }

  peekWord(): string {
    let j = this.i;
    while (j < this.b.length && !WS.has(this.b[j]) && !DELIM.has(this.b[j])) j++;
    if (j >= this.b.length && !this.atEnd) this.more();
    return ascii(this.b, this.i, j - this.i);
  }

  value(depth = 0): Val {
    if (depth > 64) throw new Bad('nesting too deep');
    this.ws();
    const b = this.b;
    if (this.i >= b.length) this.more();
    const start = this.i;
    const c = b[this.i];
    if (c === 0x3c && b[this.i + 1] === 0x3c) {
      this.i += 2;
      const entries: Entry[] = [];
      for (;;) {
        this.ws();
        if (this.i + 1 >= b.length) this.more();
        if (b[this.i] === 0x3e && b[this.i + 1] === 0x3e) {
          this.i += 2;
          return { k: 'dict', entries, start, end: this.i };
        }
        const keyStart = this.i;
        const key = this.value(depth + 1);
        if (key.k !== 'name') throw new Bad('dictionary key is not a name');
        const val = this.value(depth + 1);
        entries.push({ key: key.v, keyStart, val });
      }
    }
    if (c === 0x3c) return this.hex(start);
    if (c === 0x28) return this.literal(start);
    if (c === 0x2f) {
      this.i++;
      const w = this.peekWord();
      this.i += w.length;
      return { k: 'name', v: w.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), start, end: this.i };
    }
    if (c === 0x5b) {
      this.i++;
      const items: Val[] = [];
      for (;;) {
        this.ws();
        if (this.i >= b.length) this.more();
        if (b[this.i] === 0x5d) {
          this.i++;
          return { k: 'arr', items, start, end: this.i };
        }
        items.push(this.value(depth + 1));
      }
    }
    const w = this.peekWord();
    if (!w) throw new Bad(`unexpected byte ${c}`);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      this.i += w.length;
      const num = Number(w);
      if (/^\d+$/.test(w)) {
        // Possibly "num gen R".
        const save = this.i;
        this.ws();
        const g = this.i < b.length && isDigit(b[this.i]) ? this.peekWord() : '';
        if (/^\d+$/.test(g)) {
          this.i += g.length;
          this.ws();
          if (this.i < b.length && b[this.i] === 0x52 && (this.i + 1 >= b.length || WS.has(b[this.i + 1]) || DELIM.has(b[this.i + 1]))) {
            this.i++;
            return { k: 'ref', num, gen: Number(g), start, end: this.i };
          }
        }
        this.i = save;
      }
      return { k: 'num', v: num, start, end: this.i };
    }
    this.i += w.length;
    return { k: 'kw', v: w, start, end: this.i };
  }

  hex(start: number): Val {
    const b = this.b;
    this.i++;
    const digits: number[] = [];
    for (;;) {
      if (this.i >= b.length) this.more();
      const c = b[this.i++];
      if (c === 0x3e) break;
      if (WS.has(c)) continue;
      const v = parseInt(String.fromCharCode(c), 16);
      if (Number.isNaN(v)) throw new Bad('bad hex string');
      digits.push(v);
    }
    if (digits.length & 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = (digits[2 * k] << 4) | digits[2 * k + 1];
    return { k: 'str', bytes: out, start, end: this.i };
  }

  literal(start: number): Val {
    const b = this.b;
    this.i++;
    const out: number[] = [];
    let depth = 1;
    for (;;) {
      if (this.i >= b.length) this.more();
      const c = b[this.i++];
      if (c === 0x5c) {
        if (this.i >= b.length) this.more();
        const e = b[this.i++];
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (e in map) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let n = 0; n < 2 && this.i < b.length && b[this.i] >= 0x30 && b[this.i] <= 0x37; n++) v = v * 8 + (b[this.i++] - 0x30);
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (b[this.i] === 0x0a) this.i++;
        } else if (e !== 0x0a) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { k: 'str', bytes: Uint8Array.from(out), start, end: this.i };
  }
}

/** PDF text string -> JS string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding ≈ Latin-1). */
function text(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes, 2, bytes.length - 2, 'BE');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8(bytes, 3);
  return ascii(bytes);
}

const get = (d: Val | undefined, key: string): Val | undefined => (d && d.k === 'dict' ? d.entries.find((e) => e.key === key)?.val : undefined);
const nameOf = (v: Val | undefined): string | undefined => (v && v.k === 'name' ? v.v : undefined);

// ---------------------------------------------------------------- object model

/** Where an object's bytes live: directly in the file, or inside a decoded object stream. */
interface Home {
  /** Object stream container (absent = directly in the file). */
  objStm?: PdfObject;
}

interface PdfObject extends Home {
  num: number;
  gen: number;
  /** Absolute file offset of "num gen obj" (or, for objects in a stream, the offset inside the decoded stream). */
  start: number;
  /** End of `endobj` (file objects) or of the value (stream objects). */
  end: number;
  val: Val;
  /** Offset of `val` coordinates: file offset of the buffer the value was parsed from (0 inside object streams). */
  base: number;
  stream?: { dataStart: number; length: number; lengthRef?: { num: number; gen: number } };
}

interface Trailer {
  dict: Val;
  offset: number;
}

interface Scan {
  objects: PdfObject[];
  trailers: Trailer[];
  /** Decoded object streams, by container object. */
  decoded: Map<PdfObject, Uint8Array>;
  opaque: string[];
}

const CHUNK = MAX_READ_BYTES;
const OBJ_RE = /(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b|trailer\b/g;

/**
 * Runs `fn` on a parser positioned at file offset `abs`: first inside the current window (when given),
 * then on fresh reads of growing size. Returns the result and the end offset (absolute), or null.
 */
function parseAt<T>(f: ByteFile, abs: number, fn: (p: Parser) => T, win?: { buf: Uint8Array; pos: number }): { val: T; end: number; base: number } | null {
  if (win && abs >= win.pos && abs < win.pos + win.buf.length) {
    const p = new Parser(win.buf, abs - win.pos, win.pos + win.buf.length >= f.size);
    try {
      const val = fn(p);
      return { val, end: win.pos + p.i, base: win.pos };
    } catch (e) {
      if (e instanceof Bad) return null;
      if (!(e instanceof NeedMore)) throw e;
    }
  }
  for (const n of [64 * 1024, 1024 * 1024, CHUNK]) {
    const len = Math.min(n, f.size - abs);
    const buf = f.read(abs, len);
    const p = new Parser(buf, 0, abs + len >= f.size);
    try {
      const val = fn(p);
      return { val, end: abs + p.i, base: abs };
    } catch (e) {
      if (e instanceof NeedMore && len < f.size - abs && n !== CHUNK) continue;
      if (e instanceof NeedMore || e instanceof Bad) return null;
      throw e;
    }
  }
  return null;
}

function findBytes(f: ByteFile, needle: string, from: number, limit = f.size): number {
  const nb = asciiBytes(needle);
  for (let pos = from; pos < limit; pos += CHUNK - nb.length) {
    const buf = f.read(pos, Math.min(CHUNK, limit - pos));
    const s = ascii(buf);
    const i = s.indexOf(needle);
    if (i >= 0) return pos + i;
    if (buf.length < CHUNK) break;
  }
  return -1;
}

function scanFile(f: ByteFile): Scan {
  const objects: PdfObject[] = [];
  const trailers: Trailer[] = [];
  const size = f.size;
  let pos = 0;
  let done = 0; // everything before this offset has been handled
  while (pos < size) {
    const win = f.read(pos, Math.min(CHUNK, size - pos));
    const s = ascii(win);
    OBJ_RE.lastIndex = Math.max(0, done - pos);
    let jumped = false;
    for (let m = OBJ_RE.exec(s); m; m = OBJ_RE.exec(s)) {
      const abs = pos + m.index;
      if (abs < done) continue;
      if (m.index > 0 && !WS.has(win[m.index - 1]) && !DELIM.has(win[m.index - 1])) continue; // "12 0 obj" must start a token
      if (m[0] === 'trailer') {
        const r = parseAt(f, abs + 7, (p) => p.value(), { buf: win, pos });
        if (r) {
          trailers.push({ dict: shift(r.val, r.base), offset: abs });
          done = r.end;
        } else done = abs + 7;
      } else {
        const o = parseObject(f, abs, Number(m[1]), Number(m[2]), { buf: win, pos });
        if (!o) {
          done = abs + m[0].length;
        } else {
          objects.push(o);
          done = o.end;
          if (nameOf(get(o.val, 'Type')) === 'XRef') trailers.push({ dict: o.val, offset: abs });
        }
      }
      if (done > pos + win.length - 64 && done < size) {
        jumped = true;
        break;
      }
      OBJ_RE.lastIndex = done - pos;
    }
    if (jumped) pos = done;
    else if (pos + win.length >= size) break;
    else pos = Math.max(done, pos + win.length - 64);
  }
  const decoded = new Map<PdfObject, Uint8Array>();
  const opaque: string[] = [];
  const byKey = indexObjects(objects);
  // Stream lengths given as references.
  for (const o of objects) {
    const lr = o.stream?.lengthRef;
    if (!lr) continue;
    const target = latest(byKey, lr.num, lr.gen);
    if (target && target.val.k === 'num') o.stream!.length = target.val.v;
  }
  // Compressed object streams.
  for (const o of [...objects]) {
    if (nameOf(get(o.val, 'Type')) !== 'ObjStm' || !o.stream) continue;
    const data = decodeStream(f, o);
    if (!data) {
      opaque.push('compressed object stream');
      continue;
    }
    decoded.set(o, data);
    const n = numOf(get(o.val, 'N'));
    const first = numOf(get(o.val, 'First'));
    if (n === undefined || first === undefined) {
      opaque.push('compressed object stream');
      continue;
    }
    const head = new Parser(data, 0, true);
    const pairs: [number, number][] = [];
    try {
      for (let k = 0; k < n; k++) {
        const a = head.value();
        const b = head.value();
        if (a.k !== 'num' || b.k !== 'num') throw new Bad('bad object stream header');
        pairs.push([a.v, b.v]);
      }
    } catch {
      opaque.push('compressed object stream');
      continue;
    }
    pairs.forEach(([num, off], idx) => {
      const at = first + off;
      const next = idx + 1 < pairs.length ? first + pairs[idx + 1][1] : data.length;
      try {
        const p = new Parser(data.subarray(0, next), at, true);
        const val = p.value();
        objects.push({ num, gen: 0, start: at, end: p.i, val, base: 0, objStm: o });
      } catch {
        opaque.push('object inside a compressed object stream');
      }
    });
  }
  return { objects, trailers, decoded, opaque };
}

/** Moves every position of a parsed value by `by` (buffer-relative -> file-absolute). */
function shift(v: Val, by: number): Val {
  const s = { ...v, start: v.start + by, end: v.end + by } as Val;
  if (s.k === 'dict') s.entries = s.entries.map((e) => ({ key: e.key, keyStart: e.keyStart + by, val: shift(e.val, by) }));
  if (s.k === 'arr') s.items = s.items.map((x) => shift(x, by));
  return s;
}

function numOf(v: Val | undefined): number | undefined {
  return v && v.k === 'num' ? v.v : undefined;
}

function parseObject(f: ByteFile, abs: number, num: number, gen: number, win?: { buf: Uint8Array; pos: number }): PdfObject | null {
  const r = parseAt(
    f,
    abs,
    (p) => {
      p.value(); // num
      p.value(); // gen
      p.ws();
      if (p.peekWord() !== 'obj') throw new Bad('no obj');
      p.i += 3;
      const val = p.value();
      p.ws();
      const w = p.i < p.b.length ? p.peekWord() : 'endobj';
      let isStream = false;
      if (w === 'stream') {
        p.i += 6;
        if (p.b[p.i] === 0x0d) p.i++;
        if (p.i >= p.b.length) p.more();
        if (p.b[p.i] === 0x0a) p.i++;
        isStream = true;
      } else if (w === 'endobj') p.i += 6;
      return { val, isStream };
    },
    win,
  );
  if (!r) return null;
  const v = shift(r.val.val, r.base);
  const o: PdfObject = { num, gen, start: abs, end: r.end, val: v, base: r.base };
  if (r.val.isStream) {
    const lenVal = get(v, 'Length');
    const ds = r.end;
    let length = lenVal && lenVal.k === 'num' ? lenVal.v : -1;
    const lengthRef = lenVal && lenVal.k === 'ref' ? { num: lenVal.num, gen: lenVal.gen } : undefined;
    // Trust /Length only when "endstream" follows it; otherwise search for "endstream".
    const tail = length >= 0 && ds + length <= f.size ? ascii(f.read(ds + length, 16)) : '';
    if (!/^\s*endstream/.test(tail)) {
      const e = findBytes(f, 'endstream', ds);
      if (e < 0) return null;
      length = e - ds;
      const back = f.read(Math.max(ds, e - 2), Math.min(2, e - ds));
      if (back.length === 2 && back[0] === 0x0d && back[1] === 0x0a) length -= 2;
      else if (back.length && (back[back.length - 1] === 0x0a || back[back.length - 1] === 0x0d)) length -= 1;
    }
    const es = findBytes(f, 'endstream', ds + length, Math.min(f.size, ds + length + 64));
    const eo = es >= 0 ? findBytes(f, 'endobj', es, Math.min(f.size, es + 64)) : -1;
    o.stream = { dataStart: ds, length, lengthRef };
    o.end = eo >= 0 ? eo + 6 : es >= 0 ? es + 9 : ds + length;
  }
  return o;
}

const key = (num: number, gen: number) => `${num} ${gen}`;

function indexObjects(objects: PdfObject[]): Map<string, PdfObject[]> {
  const m = new Map<string, PdfObject[]>();
  for (const o of objects) {
    const k = key(o.num, o.gen);
    const list = m.get(k) ?? [];
    list.push(o);
    m.set(k, list);
  }
  return m;
}

/** The newest version of an object: the one that appears last in the file (incremental updates append). */
function latest(byKey: Map<string, PdfObject[]>, num: number, gen: number): PdfObject | undefined {
  const list = byKey.get(key(num, gen));
  if (!list?.length) return undefined;
  const pos = (o: PdfObject) => (o.objStm ? o.objStm.start : o.start);
  return list.reduce((a, b) => (pos(b) >= pos(a) ? b : a));
}

/** Decoded stream data (no filter or FlateDecode without predictor), or null. Stream data must be ≤ 4 MB. */
function decodeStream(f: ByteFile, o: PdfObject): Uint8Array | null {
  const s = o.stream!;
  if (s.length < 0 || s.length > MAX_READ_BYTES || s.dataStart + s.length > f.size) return null;
  const raw = readExact(f, s.dataStart, s.length);
  const filter = get(o.val, 'Filter');
  const filters = !filter ? [] : filter.k === 'name' ? [filter.v] : filter.k === 'arr' ? filter.items.map(nameOf) : [undefined];
  if (filters.length === 0) return raw;
  if (filters.length !== 1 || (filters[0] !== 'FlateDecode' && filters[0] !== 'Fl')) return null;
  const parms = get(o.val, 'DecodeParms');
  if (parms && numOf(get(parms, 'Predictor')) !== undefined && numOf(get(parms, 'Predictor'))! > 1) return null;
  try {
    const out = inflate(raw);
    return out instanceof Uint8Array ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- inspect

/** A place the cleaner may change: blank ranges live in the file or in a decoded object stream. */
interface Blank {
  field: Field;
  home: Home;
  ranges: Range[];
  /** Byte written over the ranges (default: space). The document ID is written as '0' digits. */
  fill?: number;
}

/** A metadata segment of a photo inside the PDF (absolute file offset of its 0xFF marker): neutralised in place. */
interface PhotoEdit {
  at: number;
  length: number;
  /** true: the segment becomes an all-zero COM (marker kept); false: plain zeros (bytes after the picture's end). */
  segment: boolean;
}

interface XmpStream {
  obj: PdfObject;
  props: XmpProp[];
  fields: Field[];
  text: Uint8Array;
}

export interface PdfModel {
  report: FormatReport;
  blanks: Blank[];
  photoEdits: PhotoEdit[];
  xmp: XmpStream[];
  scan: Scan;
}

const ANNOT_SKIP = new Set(['Widget', 'Link', 'Popup']);

export function inspectPdf(f: ByteFile): PdfModel {
  const head = ascii(f.read(0, 8));
  if (!head.startsWith('%PDF-')) throw new CorruptError('not a PDF');
  const tail = ascii(f.read(Math.max(0, f.size - 2048), Math.min(2048, f.size)));
  if (!tail.includes('%%EOF') && !tail.includes('startxref')) throw new CorruptError('PDF ends early');
  const scan = scanFile(f);
  if (scan.objects.length === 0) throw new CorruptError('no PDF objects found');
  if (scan.trailers.some((t) => get(t.dict, 'Encrypt'))) throw new UnsupportedPdfError('Encrypted PDFs are not supported yet');
  const byKey = indexObjects(scan.objects);
  const fields: Field[] = [];
  const blanks: Blank[] = [];
  const containers: Container[] = [];
  const notes: string[] = [];
  const derived: Uint8Array[] = [];
  const changeable: Range[] = [];
  const opaque = [...scan.opaque];
  const extraFindings: FormatReport['extraFindings'] = [];

  /** File span of an object (its container object stream when compressed). */
  const spanOf = (o: PdfObject): Range => (o.objStm ? { offset: o.objStm.start, length: o.objStm.end - o.objStm.start } : { offset: o.start, length: o.end - o.start });
  /** Range of a value in its home coordinates. */

  // Document information dictionaries of every revision (newest trailer last in file order).
  const trailers = [...scan.trailers].sort((a, b) => a.offset - b.offset);
  const infoRefs: { num: number; gen: number }[] = [];
  const direct: { dict: Val; newest: boolean }[] = [];
  trailers.forEach((t, i) => {
    const v = get(t.dict, 'Info');
    if (v?.k === 'ref' && !infoRefs.some((r) => r.num === v.num && r.gen === v.gen)) infoRefs.push({ num: v.num, gen: v.gen });
    else if (v?.k === 'dict') direct.push({ dict: v, newest: i === trailers.length - 1 });
  });
  const newestInfo = (() => {
    for (let i = trailers.length - 1; i >= 0; i--) {
      const v = get(trailers[i].dict, 'Info');
      if (v?.k === 'ref') return latest(byKey, v.num, v.gen);
    }
    return undefined;
  })();
  const infoObjects = new Set<PdfObject>();
  for (const r of infoRefs) for (const o of byKey.get(key(r.num, r.gen)) ?? []) if (o.val.k === 'dict') infoObjects.add(o);
  // Orphaned information dictionaries (no trailer points to them any more): same keys, no /Type, no outline links.
  for (const o of scan.objects) {
    if (infoObjects.has(o) || o.val.k !== 'dict' || o.stream) continue;
    const keys = o.val.entries.map((e) => e.key);
    // Not document info: typed objects, annotations (whose /Type is optional), outline items, form fields.
    if (['Type', 'Subtype', 'Rect', 'P', 'Parent', 'Kids', 'Dest', 'A', 'First', 'Next', 'FT', 'Fields'].some((k) => keys.includes(k))) continue;
    if (keys.some((k) => ['Author', 'Creator', 'Producer', 'CreationDate', 'ModDate'].includes(k))) infoObjects.add(o);
  }

  const infoFields = (o: PdfObject | null, dict: Val, earlier: boolean) => {
    if (dict.k !== 'dict') return;
    const home: Home = o?.objStm ? { objStm: o.objStm } : {};
    for (const e of dict.entries) {
      const d = describePdfInfo(e.key);
      const name = earlier ? `${d.name} (earlier version)` : d.name;
      const ranges: Range[] = [{ offset: e.keyStart, length: e.val.end - e.keyStart }];
      const values: { bytes: Uint8Array; raw?: Uint8Array }[] = [];
      const collect = (v: Val, owner: PdfObject | null) => {
        if (v.k === 'str') values.push({ bytes: v.bytes, raw: rawOf(f, scan, owner, v) });
        else if (v.k === 'arr') v.items.forEach((x) => collect(x, owner));
        else if (v.k === 'name') values.push({ bytes: asciiBytes(v.v) });
        else if (v.k === 'num') values.push({ bytes: asciiBytes(String(v.v)) });
        else if (v.k === 'ref') {
          for (const t of byKey.get(key(v.num, v.gen)) ?? []) {
            if (t.val.k !== 'str' && t.val.k !== 'arr') continue;
            collect(t.val, t);
            // The referenced value object is blanked too (its string contents).
            const strs = t.val.k === 'str' ? [t.val] : t.val.items.filter((x) => x.k === 'str');
            for (const s of strs) blanks.push({ field: null as unknown as Field, home: t.objStm ? { objStm: t.objStm } : {}, ranges: [{ offset: s.start + 1, length: s.end - s.start - 2 }] });
            changeable.push(spanOf(t));
          }
        }
      };
      collect(e.val, o);
      const shown = values.map((x) => text(x.bytes).trim()).filter(Boolean);
      const needles = shown.filter((x) => x.length >= 4);
      const bin = values.map((x) => x.raw).filter((x): x is Uint8Array => !!x && x.length >= 4);
      const field = makeField('pdf', `${earlier ? 'Earlier:' : ''}${e.key}`, { ...d, name }, shown.join(', ').slice(0, 200), needles, bin);
      fields.push(field);
      // Blanks created for referenced objects above belong to this field.
      for (const b of blanks) if (b.field === null) b.field = field;
      blanks.push({ field, home, ranges });
    }
    if (o) changeable.push(spanOf(o));
    else changeable.push({ offset: dict.start, length: dict.end - dict.start });
  };
  for (const o of infoObjects) infoFields(o, o.val, o !== newestInfo);
  for (const d of direct) infoFields(null, d.dict, !d.newest);

  // Page-level dates and application private data (review S3): /LastModified anywhere, /PieceInfo dictionaries and
  // every object they reference (Illustrator and Photoshop keep whole private documents there).
  const homeOf = (o: PdfObject): Home => (o.objStm ? { objStm: o.objStm } : {});
  const dateFields = new Map<string, Field>();
  const pieceFields: Field[] = [];
  const reached = new Set<PdfObject>();
  const KEEP_TYPES = new Set(['Page', 'Pages', 'Catalog', 'Font', 'XRef', 'ObjStm']);
  /** Blanks everything a PieceInfo value references (depth-first, each object once), collecting its text. */
  const reach = (v: Val, texts: string[], depth: number) => {
    if (depth > 16) return;
    if (v.k === 'str') texts.push(text(v.bytes).trim());
    else if (v.k === 'arr') v.items.forEach((x) => reach(x, texts, depth + 1));
    else if (v.k === 'dict') v.entries.forEach((e) => reach(e.val, texts, depth + 1));
    else if (v.k === 'ref') {
      for (const t of byKey.get(key(v.num, v.gen)) ?? []) {
        if (reached.has(t) || KEEP_TYPES.has(nameOf(get(t.val, 'Type')) ?? '')) continue;
        reached.add(t);
        reach(t.val, texts, depth + 1);
        const inner = t.val.k === 'dict' || t.val.k === 'arr' ? { offset: t.val.start + (t.val.k === 'dict' ? 2 : 1), length: t.val.end - t.val.start - (t.val.k === 'dict' ? 4 : 2) } : { offset: t.val.start, length: t.val.end - t.val.start };
        const ranges: Range[] = [];
        if (t.stream) ranges.push({ offset: t.stream.dataStart, length: Math.max(0, t.stream.length) });
        else ranges.push(inner);
        pending.push({ home: homeOf(t), ranges });
        changeable.push(spanOf(t));
      }
    }
  };
  const pending: { home: Home; ranges: Range[] }[] = [];
  const pageData = (o: PdfObject, v: Val, depth: number) => {
    if (v.k === 'arr') v.items.forEach((x) => pageData(o, x, depth + 1));
    if (v.k !== 'dict' || depth > 8) return;
    for (const e of v.entries) {
      if (e.key === 'LastModified' && e.val.k === 'str') {
        const shown = text(e.val.bytes).trim();
        const field = dateFields.get(shown) ?? makeField('pdf', 'LastModified', { name: 'Page last modified', group: 'datetime', sensitivity: 'medium', known: true }, shown, shown.length >= 4 ? [shown] : []);
        dateFields.set(shown, field);
        blanks.push({ field, home: homeOf(o), ranges: [{ offset: e.keyStart, length: e.val.end - e.keyStart }] });
        changeable.push(spanOf(o));
      } else if (e.key === 'PieceInfo') {
        const texts: string[] = [];
        pending.length = 0;
        reach(e.val, texts, 0);
        const needles = [...new Set(texts.filter((x) => x.length >= 4))];
        const field = makeField('pdf', 'PieceInfo', { name: 'Private data of the editing app', group: 'other', sensitivity: 'medium', known: false }, needles.join(', ').slice(0, 200) || 'private data', needles);
        pieceFields.push(field);
        blanks.push({ field, home: homeOf(o), ranges: [{ offset: e.keyStart, length: e.val.end - e.keyStart }] });
        for (const p of pending) blanks.push({ field, ...p });
        changeable.push(spanOf(o));
      } else pageData(o, e.val, depth + 1);
    }
  };
  for (const o of scan.objects) if (!infoObjects.has(o) && !reached.has(o)) pageData(o, o.val, 0);
  fields.push(...dateFields.values(), ...pieceFields);

  // The document ID (trailer /ID): a fingerprint that links the copy to the original. Rewritten as '0' digits of the same
  // length; an all-zero ID is what a cleaned copy has, so it is not reported.
  for (const t of trailers) {
    const id = get(t.dict, 'ID');
    if (id?.k !== 'arr') continue;
    const strs = id.items.filter((x): x is Extract<Val, { k: 'str' }> => x.k === 'str');
    const raw = strs.map((x) => ascii(f.read(x.start + 1, Math.min(512, x.end - x.start - 2))));
    if (strs.every((x, i) => x.bytes.every((b) => b === 0 || b === 0x30) && /^[0\s]*$/.test(raw[i]))) continue;
    const shown = strs.map((x) => [...x.bytes].map((b) => b.toString(16).padStart(2, '0')).join('')).join(' ');
    const field = makeField('pdf', 'ID', { name: 'Document ID (links copies of this file)', group: 'device', sensitivity: 'medium', known: true }, shown.slice(0, 200), raw.filter((x) => x.length >= 8));
    fields.push(field);
    blanks.push({ field, home: {}, ranges: strs.map((x) => ({ offset: x.start + 1, length: x.end - x.start - 2 })), fill: 0x30 });
    changeable.push({ offset: id.start, length: id.end - id.start });
  }

  // Photos inside the PDF (review S4): a /DCTDecode stream IS a JPEG file. Its Exif/XMP/IPTC/comment segments are
  // neutralised in place (marker -> COM, payload -> zeros; same length, the picture data is untouched). A JPEG behind
  // another filter cannot be read here: "Could not verify".
  const photoEdits: PhotoEdit[] = [];
  const photoFields = new Map<string, Field>();
  for (const o of scan.objects) {
    if (!o.stream || o.objStm) continue;
    const filter = get(o.val, 'Filter');
    const filters = !filter ? [] : filter.k === 'name' ? [filter.v] : filter.k === 'arr' ? filter.items.map((x) => nameOf(x) ?? '?') : ['?'];
    if (!filters.some((x) => x === 'DCTDecode' || x === 'DCT')) continue;
    if (filters.length !== 1) {
      opaque.push('photo inside the PDF behind a second compression');
      continue;
    }
    const s0 = o.stream;
    if (s0.length <= 0 || s0.dataStart + s0.length > f.size) continue;
    const win: ByteFile = {
      size: s0.length,
      read: (at, n) => f.read(s0.dataStart + at, Math.max(0, Math.min(n, s0.length - at))),
      write: () => {
        throw new Error('read-only');
      },
      close: () => {},
    };
    let jm: ReturnType<typeof inspectJpeg>;
    try {
      jm = inspectJpeg(win);
    } catch {
      opaque.push('photo inside the PDF that could not be read');
      continue;
    }
    const segs = [...jm.layout.segments, ...jm.layout.inScan];
    const thumb = jm.report.fields.some((x) => x.id === 'jpeg:JFIFThumbnail');
    for (const sg of segs) {
      const drop = ['exif', 'xmp', 'xmp-ext', 'iptc', 'mpf', 'jfxx', 'app-other'].includes(sg.kind) || (sg.kind === 'com' && sg.payload?.some((b) => b !== 0)) || (sg.kind === 'jfif' && thumb);
      if (!drop) continue;
      photoEdits.push({ at: s0.dataStart + sg.offset, length: sg.length, segment: true });
      changeable.push({ offset: s0.dataStart + sg.offset, length: sg.length });
    }
    const after = s0.length - jm.layout.eoiEnd;
    if (after > 0) {
      const tail = f.read(s0.dataStart + jm.layout.eoiEnd, Math.min(after, MAX_READ_BYTES));
      if (tail.some((b) => !WS.has(b))) {
        photoEdits.push({ at: s0.dataStart + jm.layout.eoiEnd, length: after, segment: false });
        changeable.push({ offset: s0.dataStart + jm.layout.eoiEnd, length: after });
      }
    }
    for (const x of jm.report.fields) {
      if (x.id === 'icc:ICC_Profile' || x.group === 'technical' || (x.source === 'trailer' && !photoEdits.some((e) => !e.segment && e.at === s0.dataStart + jm.layout.eoiEnd))) continue;
      const k = `${x.id}\u0000${x.value}`;
      if (photoFields.has(k)) continue;
      photoFields.set(
        k,
        makeField('pdf', `Photo:${x.id}`, { name: `${x.name} (in an embedded photo)`, group: x.group === 'location' ? 'location' : 'extras', sensitivity: x.sensitivity, known: true }, x.value, x.needles, x.binNeedles),
      );
    }
  }
  fields.push(...photoFields.values());

  // XMP metadata streams (document, page and image level).
  const xmp: XmpStream[] = [];
  for (const o of scan.objects) {
    if (!o.stream || nameOf(get(o.val, 'Type')) !== 'Metadata') continue;
    const data = decodeStream(f, o);
    changeable.push(spanOf(o));
    if (!data) {
      opaque.push('compressed XMP metadata');
      continue;
    }
    const x = parseXmp(utf8(data));
    const unreadable = x.ok || data.every((b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0) ? [] : [makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${data.length} bytes`)];
    const fs = [...xmpFields(x), ...unreadable];
    fields.push(...fs);
    xmp.push({ obj: o, props: x.props, fields: fs, text: data });
    derived.push(data);
    containers.push({ kind: 'xmp', offset: o.stream.dataStart, length: o.stream.length });
    const lr = o.stream.lengthRef;
    if (lr) for (const t of byKey.get(key(lr.num, lr.gen)) ?? []) changeable.push(spanOf(t));
  }
  for (const [, data] of scan.decoded) derived.push(data);

  // Reported, not removed: annotation authors, attached files; notes for forms, JavaScript, signatures.
  let signed = false;
  let js = false;
  let form = false;
  for (const o of scan.objects) {
    const v = o.val;
    if (v.k !== 'dict') continue;
    const type = nameOf(get(v, 'Type'));
    const sub = nameOf(get(v, 'Subtype'));
    const t = get(v, 'T');
    if (t?.k === 'str' && (type === 'Annot' || (sub && get(v, 'Rect'))) && !ANNOT_SKIP.has(sub ?? '') && !get(v, 'FT')) {
      const who = text(t.bytes).trim();
      if (who) fields.push(makeField('pdf', 'AnnotationAuthor', { name: 'Comment author', group: 'people', sensitivity: 'high', known: true }, who, who.length >= 4 ? [who] : []));
    }
    if (type === 'Filespec' && get(v, 'EF')) {
      const n = get(v, 'UF') ?? get(v, 'F');
      fields.push(makeField('pdf', 'EmbeddedFile', { name: 'Attached file', group: 'extras', sensitivity: 'medium', known: true }, n?.k === 'str' ? text(n.bytes) : 'attached file'));
    }
    if (type === 'Sig' || get(v, 'ByteRange')) signed = true;
    if (get(v, 'JS') || nameOf(get(v, 'S')) === 'JavaScript') js = true;
    if (get(v, 'AcroForm')) form = true;
  }
  if (form) notes.push('Contains form fields (not changed)');
  if (js) notes.push('Contains JavaScript (not changed)');
  if (signed) {
    notes.push('Digitally signed: cleaning will invalidate the signature');
    extraFindings.push({ id: 'signature', label: 'Digital signature (cleaning will invalidate it)', level: 'orange' });
  }

  // Revisions: incremental updates append a new trailer each; a linearized file has one extra.
  const linearized = scan.objects.length > 0 && !!get(scan.objects[0].val, 'Linearized');
  const revisions = trailers.length - (linearized ? 1 : 0);
  if (revisions > 1) {
    extraFindings.push({ id: 'revisions', label: 'Earlier versions of this PDF', level: 'orange' });
    notes.push(`${revisions} saved versions: the metadata of every version is removed; earlier page content stays in the file`);
  }

  // Page count from the newest catalog's page tree.
  let pages: number | undefined;
  for (let i = trailers.length - 1; i >= 0 && pages === undefined; i--) {
    const root = get(trailers[i].dict, 'Root');
    const cat = root?.k === 'ref' ? latest(byKey, root.num, root.gen) : undefined;
    const pr = get(cat?.val, 'Pages');
    const tree = pr?.k === 'ref' ? latest(byKey, pr.num, pr.gen) : undefined;
    pages = numOf(get(tree?.val, 'Count'));
  }

  return {
    blanks: blanks.filter((b) => b.field),
    photoEdits,
    xmp,
    scan,
    report: {
      fields,
      containers,
      dataRanges: outside(f.size, changeable),
      scanRanges: [{ offset: 0, length: f.size }],
      inPlace: true,
      pages,
      notes,
      derived,
      opaque: [...new Set(opaque)],
      extraFindings,
    },
  };
}

/** The raw (as stored) bytes of a string's contents, for the byte scan. */
function rawOf(f: ByteFile, scan: Scan, owner: PdfObject | null, v: Val): Uint8Array | undefined {
  const len = v.end - v.start - 2;
  if (len < 4 || len > 4096) return undefined;
  if (owner?.objStm) return scan.decoded.get(owner.objStm)?.slice(v.start + 1, v.end - 1);
  return f.read(v.start + 1, len);
}

// ---------------------------------------------------------------- clean

const SPACE = 0x20;

function spaces(n: number): Uint8Array {
  return new Uint8Array(n).fill(SPACE);
}

/** Writes `byte` over a range in writes of at most 1 MiB (stream data can be large). */
function fill(dst: ByteFile, r: Range, byte: number): void {
  const chunk = new Uint8Array(Math.min(r.length, 1024 * 1024)).fill(byte);
  for (let done = 0; done < r.length; done += chunk.length) dst.write(r.offset + done, chunk.subarray(0, Math.min(chunk.length, r.length - done)));
}

/**
 * Rewrites a stream's data in place. Unfiltered streams: `content` padded with spaces to the same length.
 * Flate streams: deflate, write, /Length rewritten with the same number of characters, `endstream endobj`
 * moved up and the gap filled with spaces (every later offset unchanged). False when it cannot fit.
 */
function rewriteStream(dst: ByteFile, byKey: Map<string, PdfObject[]>, o: PdfObject, content: Uint8Array): boolean {
  const s = o.stream!;
  if (!hasFilter(o)) {
    if (content.length > s.length) return false;
    const out = spaces(s.length);
    out.set(content);
    dst.write(s.dataStart, out);
    return true;
  }
  const c = deflate(content, { level: 9 });
  const tailText = '\nendstream\nendobj';
  const room = o.end - s.dataStart;
  if (c.length >= s.length || c.length + tailText.length > room) return false;
  // New /Length with the same number of characters (right-padded with spaces).
  const lenVal = get(o.val, 'Length')!;
  const digits = String(c.length);
  if (lenVal.k === 'num') {
    const width = lenVal.end - lenVal.start;
    if (digits.length > width) return false;
    dst.write(lenVal.start, asciiBytes(digits.padEnd(width, ' ')));
  } else if (lenVal.k === 'ref') {
    const targets = byKey.get(key(lenVal.num, lenVal.gen)) ?? [];
    for (const t of targets) {
      if (t.objStm || t.val.k !== 'num') return false;
      const width = t.val.end - t.val.start;
      if (digits.length > width) return false;
    }
    for (const t of targets) dst.write(t.val.start, asciiBytes(digits.padEnd(t.val.end - t.val.start, ' ')));
  } else return false;
  const out = spaces(room);
  out.set(c, 0);
  out.set(asciiBytes(tailText), c.length);
  dst.write(s.dataStart, out);
  return true;
}

/** Streams we decoded have either no filter or FlateDecode (decodeStream refuses anything else). */
const hasFilter = (o: PdfObject) => !!get(o.val, 'Filter');

export function cleanPdf(src: ByteFile, model: PdfModel, dst: ByteFile, keep: (f: Field) => boolean, dstIsCopy = false): { kept: Field[]; notes: string[] } {
  if (!dstIsCopy) new SeqWriter(dst).copy(src, 0, src.size);
  const kept: Field[] = [];
  const notes: string[] = [];
  const byKey = indexObjects(model.scan.objects);
  const stmEdits = new Map<PdfObject, Uint8Array>();
  for (const b of model.blanks) {
    if (keep(b.field)) continue;
    for (const r of b.ranges) {
      if (b.home.objStm) {
        const container = b.home.objStm;
        const buf = stmEdits.get(container) ?? model.scan.decoded.get(container)!.slice();
        buf.fill(b.fill ?? SPACE, r.offset, r.offset + r.length);
        stmEdits.set(container, buf);
      } else fill(dst, r, b.fill ?? SPACE);
    }
  }
  // Photos inside the PDF: metadata segments -> all-zero COM segments of the same length, data after the picture -> zeros.
  for (const e of model.photoEdits) {
    if (e.segment) {
      dst.write(e.at + 1, Uint8Array.of(0xfe));
      fill(dst, { offset: e.at + 4, length: e.length - 4 }, 0);
    } else fill(dst, { offset: e.at, length: e.length }, 0);
  }
  // Fields that were not blanked stay (counted once, not per range).
  for (const f of new Set(model.blanks.map((b) => b.field))) if (keep(f)) kept.push(f);
  for (const [container, buf] of stmEdits) {
    if (!rewriteStream(dst, byKey, container, buf)) notes.push('A compressed object stream could not be rewritten in place; its metadata was not removed');
  }
  for (const x of model.xmp) {
    if (x.fields.every(keep)) {
      kept.push(...x.fields);
      continue;
    }
    const r = rebuildXmp(x.props, keep);
    const attempt = (packet: string): boolean => {
      if (hasFilter(x.obj)) return rewriteStream(dst, byKey, x.obj, utf8Bytes(packet));
      const padded = padPacket(packet, x.obj.stream!.length);
      return padded !== null && rewriteStream(dst, byKey, x.obj, utf8Bytes(padded));
    };
    if (r.packet && attempt(r.packet)) kept.push(...r.kept);
    else if (attempt(EMPTY_XMP) || rewriteStream(dst, byKey, x.obj, new Uint8Array(0))) {
      if (r.packet) notes.push('Kept XMP did not fit in place and was removed');
    } else {
      notes.push('An XMP metadata stream could not be rewritten in place');
      kept.push(...x.fields);
    }
  }
  kept.push(...model.report.fields.filter((f) => f.key === 'AnnotationAuthor' || f.key === 'EmbeddedFile'));
  return { kept, notes: notes.filter(Boolean) };
}
