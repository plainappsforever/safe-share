/** ISO base media file format box walker (shared by HEIF now and MP4/MOV in P3). */
import { ascii, u32, u64 } from './binary';
import type { ByteFile } from './byte-file';
import { CorruptError } from './jpeg';

export interface Box {
  type: string;
  /** Offset of the box header (absolute in the file, or relative to the buffer for childBoxes). */
  offset: number;
  /** Total size including the header. */
  size: number;
  /** Header size: 8, or 16 with a 64-bit size (plus 16 for `uuid`). */
  header: number;
}

function parseHeader(b: Uint8Array, at: number, limit: number): Box {
  let size = u32(b, at);
  const type = ascii(b, at + 4, 4);
  let header = 8;
  if (size === 1) {
    size = u64(b, at + 8);
    header = 16;
  } else if (size === 0) size = limit - at;
  if (type === 'uuid') header += 16;
  if (size < header || at + size > limit) throw new CorruptError(`box ${type} at ${at} runs past its parent`);
  return { type, offset: at, size, header };
}

/** Top-level boxes, reading only their headers. */
export function topLevelBoxes(f: ByteFile): Box[] {
  const out: Box[] = [];
  const size = f.size;
  let pos = 0;
  while (pos + 8 <= size) {
    const h = f.read(pos, 16);
    const box = parseHeader(h.length >= 16 ? h : Uint8Array.from([...h, ...new Array(16 - h.length).fill(0)]), 0, size - pos);
    out.push({ ...box, offset: pos });
    pos += box.size;
  }
  if (pos !== size) throw new CorruptError('file ends inside a box');
  return out;
}

/** Child boxes of an in-memory buffer region [start, end). `full` skips a FullBox version/flags word first. */
export function childBoxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const box = parseHeader(b, pos, end);
    out.push(box);
    pos += box.size;
  }
  return out;
}
