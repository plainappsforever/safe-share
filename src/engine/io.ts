import { MAX_READ_BYTES, type ByteFile } from './byte-file';

/** Reads exactly `length` bytes (≤ MAX_READ_BYTES) or throws if the file is shorter (truncated input). */
export function readExact(f: ByteFile, offset: number, length: number): Uint8Array {
  const b = f.read(offset, length);
  if (b.length !== length) throw new TruncatedError(offset, length, b.length);
  return b;
}

export class TruncatedError extends Error {
  constructor(offset: number, want: number, got: number) {
    super(`file ends early: wanted ${want} bytes at ${offset}, got ${got}`);
    this.name = 'TruncatedError';
  }
}

/** A byte range [offset, offset + length). */
export interface Range {
  offset: number;
  length: number;
}

/** Appends to a destination ByteFile sequentially. */
export class SeqWriter {
  pos = 0;
  constructor(readonly dst: ByteFile) {}
  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.dst.write(this.pos, bytes);
    this.pos += bytes.length;
  }
  /** Copies a source range in chunks of at most MAX_READ_BYTES. */
  copy(src: ByteFile, offset: number, length: number): void {
    let done = 0;
    while (done < length) {
      const n = Math.min(MAX_READ_BYTES, length - done);
      this.write(readExact(src, offset + done, n));
      done += n;
    }
  }
}

/** Progress of a long step: `done` of `total` bytes handled so far. */
export interface StepProgress {
  done: number;
  total: number;
}

/** Runs a step generator to its end without pausing (the synchronous engine path and Jest). */
export function runToEnd<T>(g: Generator<StepProgress, T, void>): T {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/**
 * True when the concatenated bytes of `ra` in `a` equal those of `rb` in `b` (streamed, ≤ 4 MB reads).
 * A generator that yields its progress after every 1 MiB chunk, so the app can run it in slices that let the screen
 * breathe (P7, P4-6); `rangesEqual` runs the very same code to the end.
 */
export function* rangesEqualSteps(a: ByteFile, ra: Range[], b: ByteFile, rb: Range[]): Generator<StepProgress, boolean, void> {
  const total = (rs: Range[]) => rs.reduce((s, r) => s + r.length, 0);
  if (total(ra) !== total(rb)) return false;
  const chunk = 1024 * 1024;
  const cursor = (f: ByteFile, rs: Range[]) => {
    let i = 0;
    let off = 0;
    return (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      let filled = 0;
      while (filled < n && i < rs.length) {
        const take = Math.min(n - filled, rs[i].length - off);
        out.set(readExact(f, rs[i].offset + off, take), filled);
        filled += take;
        off += take;
        if (off === rs[i].length) {
          i++;
          off = 0;
        }
      }
      return out;
    };
  };
  const ca = cursor(a, ra);
  const cb = cursor(b, rb);
  const all = total(ra);
  let left = all;
  while (left > 0) {
    const n = Math.min(chunk, left);
    const x = ca(n);
    const y = cb(n);
    for (let k = 0; k < n; k++) if (x[k] !== y[k]) return false;
    left -= n;
    yield { done: all - left, total: all };
  }
  return true;
}

/** True when the concatenated bytes of `ra` in `a` equal those of `rb` in `b` (streamed, ≤ 4 MB reads). */
export function rangesEqual(a: ByteFile, ra: Range[], b: ByteFile, rb: Range[]): boolean {
  return runToEnd(rangesEqualSteps(a, ra, b, rb));
}

/** Complement of `holes` inside [0, size): the ranges NOT covered by any hole. */
export function outside(size: number, holes: Range[]): Range[] {
  const sorted = [...holes].sort((x, y) => x.offset - y.offset);
  const out: Range[] = [];
  let pos = 0;
  for (const h of sorted) {
    if (h.offset > pos) out.push({ offset: pos, length: h.offset - pos });
    pos = Math.max(pos, h.offset + h.length);
  }
  if (pos < size) out.push({ offset: pos, length: size - pos });
  return out;
}

/** [ranges] minus [holes] (both sorted or not). */
export function subtract(ranges: Range[], holes: Range[]): Range[] {
  const out: Range[] = [];
  const hs = [...holes].sort((a, b) => a.offset - b.offset);
  for (const r of ranges) {
    let pos = r.offset;
    const end = r.offset + r.length;
    for (const h of hs) {
      if (h.offset + h.length <= pos || h.offset >= end) continue;
      if (h.offset > pos) out.push({ offset: pos, length: h.offset - pos });
      pos = Math.max(pos, h.offset + h.length);
    }
    if (pos < end) out.push({ offset: pos, length: end - pos });
  }
  return out;
}
