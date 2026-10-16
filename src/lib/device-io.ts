import { Directory, File } from 'expo-file-system';

import { openExpoByteFile } from '@/engine/expo-byte-file';

import { native } from './native';
import type { FileIo } from './pipeline';

function ensureParent(f: File) {
  f.parentDirectory.create({ intermediates: true, idempotent: true });
}

/** `FileIo` over expo-file-system (device only). Same contract as `test/node-file-io.ts`. */
export const deviceIo: FileIo = {
  openRead: (path) => openExpoByteFile(path, false),
  createEmpty(path) {
    const f = new File(path);
    ensureParent(f);
    if (f.exists) f.delete();
    f.create();
    return openExpoByteFile(f.uri, true);
  },
  // Async on purpose: a 1 GB copy runs natively off the JS thread, so the screen stays responsive (P7).
  // iOS (P7.5, review S6): a fresh data-only copy, because File.copy (FileManager.copyItem) keeps the original's dates and
  // extended attributes on the cleaned copy. Android's File.copy already writes a new file (Kotlin copyTo; no xattrs).
  async copyFile(from, to) {
    const dst = new File(to);
    ensureParent(dst);
    if (dst.exists) dst.delete();
    if (native?.copyFresh) await native.copyFresh(from, dst.uri);
    else await new File(from).copy(dst);
  },
  openReadWrite: (path) => openExpoByteFile(path, true),
  remove(path) {
    try {
      const f = new File(path);
      if (f.exists) {
        f.delete();
        return;
      }
      const d = new Directory(path);
      if (d.exists) d.delete();
    } catch {
      // a leftover file is removed at the next launch (A14)
    }
  },
  writeText(path, text) {
    const f = new File(path);
    ensureParent(f);
    if (f.exists) f.delete();
    f.create();
    f.write(text);
  },
  now: () => Date.now(),
  // Reader 3: ImageIO/AVFoundation/PDFKit (iOS) or metadata-extractor/MediaMetadataRetriever (Android), off the JS thread.
  ...(native ? { readPlatform: (path: string, kind) => native!.readPlatformMetadata(path, kind) } : {}),
};
