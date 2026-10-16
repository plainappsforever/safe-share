import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { FileIo } from '@/lib/pipeline';

import { openNodeByteFile } from './node-byte-file';

/** `FileIo` over Node files, for Jest (same contract as `src/lib/device-io.ts`). */
export const nodeFileIo: FileIo = {
  openRead: (path) => openNodeByteFile(path),
  createEmpty(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Uint8Array(0));
    return openNodeByteFile(path, true);
  },
  copyFile(from, to) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  },
  openReadWrite: (path) => openNodeByteFile(path, true),
  remove(path) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  },
  writeText: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  now: () => Date.now(),
};
