/**
 * Byte helpers for the engine: endian readers/writers, ASCII/UTF-8/UTF-16 helpers and CRC-32.
 * Own implementations on purpose (no TextDecoder/TextEncoder dependency in Hermes).
 */

export type Endian = 'BE' | 'LE';

export function u16(b: Uint8Array, o: number, e: Endian = 'BE'): number {
  return e === 'BE' ? (b[o] << 8) | b[o + 1] : b[o] | (b[o + 1] << 8);
}

export function u32(b: Uint8Array, o: number, e: Endian = 'BE'): number {
  return e === 'BE'
    ? ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
    : ((b[o + 3] << 24) >>> 0) + (b[o + 2] << 16) + (b[o + 1] << 8) + b[o];
}

export function i32(b: Uint8Array, o: number, e: Endian = 'BE'): number {
  return u32(b, o, e) | 0;
}

/** 64-bit big-endian unsigned as a JS number (exact up to 2^53). */
export function u64(b: Uint8Array, o: number): number {
  return u32(b, o) * 0x100000000 + u32(b, o + 4);
}

/** Reads an unsigned big-endian integer of 0, 4 or 8 bytes (ISOBMFF variable-size fields). */
export function uintN(b: Uint8Array, o: number, size: number): number {
  if (size === 0) return 0;
  if (size === 2) return u16(b, o);
  if (size === 4) return u32(b, o);
  if (size === 8) return u64(b, o);
  throw new RangeError(`unsupported integer size ${size}`);
}

export function put16(b: Uint8Array, o: number, v: number, e: Endian = 'BE'): void {
  if (e === 'BE') {
    b[o] = (v >>> 8) & 0xff;
    b[o + 1] = v & 0xff;
  } else {
    b[o] = v & 0xff;
    b[o + 1] = (v >>> 8) & 0xff;
  }
}

export function put32(b: Uint8Array, o: number, v: number, e: Endian = 'BE'): void {
  if (e === 'BE') {
    b[o] = (v >>> 24) & 0xff;
    b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff;
    b[o + 3] = v & 0xff;
  } else {
    b[o] = v & 0xff;
    b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff;
    b[o + 3] = (v >>> 24) & 0xff;
  }
}

/** Latin-1/ASCII bytes -> string (every byte one char). */
export function ascii(b: Uint8Array, o = 0, len = b.length - o): string {
  const end = Math.min(b.length, o + len);
  if (end - o <= 64) {
    let s = '';
    for (let i = o; i < end; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  // Large windows (PDF scan, 4 MB): 8 KB slices keep this fast in Hermes and V8.
  const parts: string[] = [];
  for (let i = o; i < end; i += 8192) parts.push(String.fromCharCode.apply(null, b.subarray(i, Math.min(end, i + 8192)) as unknown as number[]));
  return parts.join('');
}

/** ASCII string -> bytes (chars above 0xff are replaced by '?'). */
export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 0xff ? 0x3f : c;
  }
  return out;
}

/** Tolerant UTF-8 decoder: invalid sequences become U+FFFD. */
export function utf8(b: Uint8Array, o = 0, len = b.length - o): string {
  let s = '';
  const end = Math.min(b.length, o + len);
  let i = o;
  while (i < end) {
    const c = b[i];
    let cp = 0xfffd;
    let n = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i + 1 < end && (b[i + 1] & 0xc0) === 0x80) {
      cp = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f);
      n = 2;
    } else if (c >= 0xe0 && c < 0xf0 && i + 2 < end && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
      cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      n = 3;
    } else if (
      c >= 0xf0 && c < 0xf5 && i + 3 < end &&
      (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80
    ) {
      cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      n = 4;
    }
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

/** UTF-16 (for Exif XP* tags and ICC mluc) -> string. */
export function utf16(b: Uint8Array, o: number, len: number, e: Endian): string {
  let s = '';
  for (let i = o; i + 1 < o + len && i + 1 < b.length; i += 2) {
    const c = u16(b, i, e);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) put16(out, i * 2, s.charCodeAt(i), 'LE');
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function startsWith(b: Uint8Array, prefix: Uint8Array | string, at = 0): boolean {
  const p = typeof prefix === 'string' ? asciiBytes(prefix) : prefix;
  if (at + p.length > b.length) return false;
  for (let i = 0; i < p.length; i++) if (b[at + i] !== p[i]) return false;
  return true;
}

/** First index of `needle` in `hay` at or after `from`, or -1. */
export function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const n = needle.length;
  if (n === 0) return from <= hay.length ? from : -1;
  const first = needle[0];
  outer: for (let i = Math.max(0, from); i <= hay.length - n; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let crcTable: Uint32Array | null = null;
/** CRC-32 as used by PNG (and zlib). */
export function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) crc = crcTable[(crc ^ p[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Incremental CRC-32 (same polynomial as `crc32`): `crc32Done(parts.reduce(crc32Add, CRC32_START))` equals `crc32(parts)`. */
export const CRC32_START = 0xffffffff;
export function crc32Add(crc: number, p: Uint8Array): number {
  if (!crcTable) crc32([]);
  for (let i = 0; i < p.length; i++) crc = crcTable![(crc ^ p[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}
export function crc32Done(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

/** Printable ASCII runs of at least `min` chars (needles for binary blocks). */
export function textRuns(b: Uint8Array, min = 6): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i] : 0;
    if (c >= 0x20 && c < 0x7f) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= min) out.push(ascii(b, start, i - start).trim());
      start = -1;
    }
  }
  return out.filter((s) => s.length >= min).slice(0, 50);
}
