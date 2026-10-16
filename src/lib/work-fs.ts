import { Directory, Paths } from 'expo-file-system';
import { Image } from 'expo-image';

import { cleanWorkFolder, iosTmpDir, pickerLeftovers, type WorkFs } from './files';

/** `WorkFs` over expo-file-system (device only). */
export const expoWorkFs: WorkFs = {
  exists: (path) => new Directory(path).exists,
  removeDir: (path) => new Directory(path).delete(),
  makeDir: (path) => new Directory(path).create({ intermediates: true, idempotent: true }),
};

/** Call once at app start. Also removes picker leftovers (S10) and the image cache of earlier thumbnails (S5). */
export function cleanWorkFolderAtLaunch() {
  const r = cleanWorkFolder(expoWorkFs, Paths.cache.uri);
  try {
    const tmp = iosTmpDir(Paths.cache.uri);
    const names = tmp && new Directory(tmp).exists ? new Directory(tmp).list().map((e) => e.name) : null;
    for (const d of pickerLeftovers(Paths.cache.uri, names)) if (expoWorkFs.exists(d)) expoWorkFs.removeDir(d);
  } catch {
    // never stop the app from starting; the next launch tries again
  }
  // Thumbnails are drawn with cachePolicy "none" (S5); this removes anything an older build cached.
  void Image.clearDiskCache().catch(() => false);
  return r;
}
