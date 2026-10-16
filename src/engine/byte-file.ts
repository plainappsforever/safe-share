/**
 * Random-access file used by the whole engine. Pure interface: the engine never imports
 * React Native. Implementations: `test/node-byte-file.ts` (Jest/Node) and
 * `expo-byte-file.ts` (device, over expo-file-system FileHandle).
 */

/** No single read may be larger than this (A10: bounded memory on 1 GB files). */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface ByteFile {
  /** Current length in bytes (grows when `write` extends the file). */
  readonly size: number;
  /**
   * Reads up to `length` bytes starting at `offset`. Returns fewer bytes only at end of file
   * (an empty array when `offset >= size`). Throws RangeError if `length > MAX_READ_BYTES`.
   */
  read(offset: number, length: number): Uint8Array;
  /** Writes `bytes` at `offset` (0 <= offset <= size); extends the file if needed. Read-only files throw. */
  write(offset: number, bytes: Uint8Array): void;
  close(): void;
}

export function assertReadArgs(offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`bad offset ${offset}`);
  if (!Number.isInteger(length) || length < 0) throw new RangeError(`bad length ${length}`);
  if (length > MAX_READ_BYTES) throw new RangeError(`read of ${length} bytes exceeds ${MAX_READ_BYTES}`);
}

export function assertWriteArgs(offset: number, size: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > size) {
    throw new RangeError(`write offset ${offset} outside 0..${size}`);
  }
}
