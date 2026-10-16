import { File, FileMode, Paths } from 'expo-file-system';

import { assertReadArgs, assertWriteArgs, type ByteFile } from './byte-file';
import { runEngineSmokeTest } from './engine-smoketest';
import { runFsSelfTest } from './fs-selftest';

/** ByteFile over an expo-file-system FileHandle (device only; not importable from Jest). */
export function openExpoByteFile(uri: string, writable = false): ByteFile {
  const handle = new File(uri).open(writable ? FileMode.ReadWrite : FileMode.ReadOnly);
  const currentSize = () => handle.size ?? 0;
  return {
    get size() {
      return currentSize();
    },
    read(offset, length) {
      assertReadArgs(offset, length);
      if (length === 0 || offset >= currentSize()) return new Uint8Array(0);
      handle.offset = offset;
      return handle.readBytes(Math.min(length, currentSize() - offset));
    },
    write(offset, bytes) {
      assertWriteArgs(offset, currentSize());
      handle.offset = offset;
      handle.writeBytes(bytes);
    },
    close() {
      handle.close();
    },
  };
}

/** Dev-only diagnostic behind the Home "FS self-test" button. Returns "FS OK" or "FS FAIL: …". */
export function runDeviceFsSelfTest(): string {
  const file = new File(Paths.cache, 'fs-selftest.bin');
  return runFsSelfTest((initial) => {
    if (file.exists) file.delete();
    file.create();
    file.write(initial);
    return openExpoByteFile(file.uri, true);
  });
}

/** Dev-only diagnostic next to the FS self-test: the engine (incl. pako) loads and runs in Hermes. "ENGINE OK" or "ENGINE FAIL: …". */
export function runDeviceEngineSmokeTest(): string {
  let n = 0;
  return runEngineSmokeTest((initial) => {
    const file = new File(Paths.cache, `engine-selftest-${n++}.bin`);
    if (file.exists) file.delete();
    file.create();
    file.write(initial);
    return openExpoByteFile(file.uri, true);
  });
}
