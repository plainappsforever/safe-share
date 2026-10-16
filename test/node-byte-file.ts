import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';

import { assertReadArgs, assertWriteArgs, type ByteFile } from '@/engine/byte-file';

/** ByteFile over a Node file descriptor, for Jest. Same contract as the device implementation. */
export function openNodeByteFile(path: string, writable = false): ByteFile {
  const fd = openSync(path, writable ? 'r+' : 'r');
  let closed = false;
  const currentSize = () => fstatSync(fd).size;
  return {
    get size() {
      return currentSize();
    },
    read(offset, length) {
      assertReadArgs(offset, length);
      const buf = new Uint8Array(length);
      const n = length === 0 ? 0 : readSync(fd, buf, 0, length, offset);
      return n === length ? buf : buf.slice(0, n);
    },
    write(offset, bytes) {
      assertWriteArgs(offset, currentSize());
      let done = 0;
      while (done < bytes.length) {
        done += writeSync(fd, bytes, done, bytes.length - done, offset + done);
      }
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
