import type { ByteFile } from './byte-file';

export const FS_SELFTEST_OK = 'FS OK';

/**
 * Proves a ByteFile can overwrite bytes in the middle of a file and read them back:
 * writes 10 bytes at offset 5 of a 20-byte file (P1 check of the FileHandle `offset` setter).
 * `open` must return a writable ByteFile over a file that holds exactly `initial`.
 * Returns "FS OK" or "FS FAIL: <reason>"; never throws.
 */
export function runFsSelfTest(open: (initial: Uint8Array) => ByteFile): string {
  let file: ByteFile | undefined;
  try {
    const initial = new Uint8Array(20).fill(0xaa);
    file = open(initial);
    if (file.size !== 20) return `FS FAIL: size ${file.size}, expected 20`;

    const patch = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
    file.write(5, patch);
    if (file.size !== 20) return `FS FAIL: size ${file.size} after write, expected 20`;

    const back = file.read(0, 20);
    const expected = new Uint8Array(20).fill(0xaa);
    expected.set(patch, 5);
    if (back.length !== 20) return `FS FAIL: read ${back.length} bytes, expected 20`;
    for (let i = 0; i < 20; i++) {
      if (back[i] !== expected[i]) return `FS FAIL: byte ${i} is ${back[i]}, expected ${expected[i]}`;
    }
    // Random-access read after the write (offset moved backwards and forwards).
    const mid = file.read(5, 10);
    if (mid.length !== 10 || mid[0] !== 1 || mid[9] !== 10) return 'FS FAIL: read at offset 5';
    if (file.read(20, 4).length !== 0) return 'FS FAIL: read past end returned data';
    return FS_SELFTEST_OK;
  } catch (e) {
    return `FS FAIL: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      file?.close();
    } catch {
      // ignore close errors in a diagnostic
    }
  }
}
