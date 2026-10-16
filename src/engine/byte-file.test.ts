/** @jest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openNodeByteFile } from '../../test/node-byte-file';

import { MAX_READ_BYTES } from './byte-file';
import { FS_SELFTEST_OK, runFsSelfTest } from './fs-selftest';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'byte-file-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeFile(bytes: number[]) {
  const p = join(dir, 'f.bin');
  writeFileSync(p, Uint8Array.from(bytes));
  return p;
}

describe('node ByteFile', () => {
  it('reads ranges, short at end of file, empty past the end', () => {
    const f = openNodeByteFile(makeFile([1, 2, 3, 4, 5]));
    expect(f.size).toBe(5);
    expect([...f.read(1, 3)]).toEqual([2, 3, 4]);
    expect([...f.read(3, 10)]).toEqual([4, 5]);
    expect(f.read(5, 4).length).toBe(0);
    f.close();
  });

  it('writes in the middle and at the end (extending), and the bytes reach the disk', () => {
    const p = makeFile([0, 0, 0, 0]);
    const f = openNodeByteFile(p, true);
    f.write(1, Uint8Array.from([9, 9]));
    f.write(4, Uint8Array.from([7]));
    expect(f.size).toBe(5);
    f.close();
    expect([...readFileSync(p)]).toEqual([0, 9, 9, 0, 7]);
  });

  it('refuses writes on read-only files, writes past the end, and oversized reads', () => {
    const p = makeFile([1, 2, 3]);
    const ro = openNodeByteFile(p);
    expect(() => ro.write(0, Uint8Array.from([1]))).toThrow();
    ro.close();
    const rw = openNodeByteFile(p, true);
    expect(() => rw.write(9, Uint8Array.from([1]))).toThrow(RangeError);
    expect(() => rw.read(0, MAX_READ_BYTES + 1)).toThrow(RangeError);
    expect(() => rw.read(-1, 1)).toThrow(RangeError);
    rw.close();
  });
});

describe('FS self-test logic', () => {
  it('passes on the Node implementation', () => {
    const p = join(dir, 'self.bin');
    expect(
      runFsSelfTest((initial) => {
        writeFileSync(p, initial);
        return openNodeByteFile(p, true);
      })
    ).toBe(FS_SELFTEST_OK);
    const disk = readFileSync(p);
    expect(disk.length).toBe(20);
    expect([...disk.subarray(5, 15)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reports a failure instead of throwing when writes do not land', () => {
    const p = join(dir, 'self.bin');
    const result = runFsSelfTest((initial) => {
      writeFileSync(p, initial);
      const real = openNodeByteFile(p, true);
      return { ...real, size: 20, read: real.read, write: () => undefined, close: real.close };
    });
    expect(result).toMatch(/^FS FAIL: byte 5 is 170, expected 1/);
  });
});
