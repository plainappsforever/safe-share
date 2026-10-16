/** Getting files in with the pickers (SPEC F1; share-in: `share-in.ts`). Device only. */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Directory, Paths } from 'expo-file-system';

import { joinPath, workFolderPath } from './files';
import type { Job } from './jobs';
import { native } from './native';
import { importIntoWork, nameFromUri, type Incoming } from './work';

/**
 * Opens the system photo picker (multi-select, originals, no permission prompt). Returns the new jobs or [] when cancelled.
 * P6 (D17, D45): the local module's picker — iOS PHPicker with `.current` (HEIC stays HEIC, videos are not transcoded);
 * Android's photo picker (its copies always have the GPS blanked: Android refuses setRequireOriginal on picker URIs,
 * measured in P6; the Inspect card then offers the Files picker, which hands over the original). Without the module (or an Android without the photo picker):
 * expo-image-picker as in P4.
 */
export async function pickPhotosAndVideos(): Promise<Job[]> {
  if (native?.isPhotoPickerAvailable()) {
    const staging = joinPath(workFolderPath(Paths.cache.uri), `pick-${Date.now()}`);
    try {
      const picked = await native.pickMedia(0, staging, false); // requireOriginal: refused by Android for picker URIs
      const ok = picked.filter((p) => p.path);
      if (picked.length > 0 && ok.length === 0) throw new Error(picked[0].error ?? 'picker copy failed');
      return importIntoWork(ok.map((p) => ({ uri: p.path!, name: p.name, sourceUri: p.uri })), true, 'picker');
    } finally {
      try {
        const d = new Directory(staging);
        if (d.exists) d.delete();
      } catch {
        // wiped with the work folder
      }
    }
  }
  return pickWithImagePicker();
}

async function pickWithImagePicker(): Promise<Job[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    allowsEditing: false,
    quality: 1,
    exif: false,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
  });
  if (res.canceled) return [];
  const items: Incoming[] = res.assets.map((a) => ({ uri: a.uri, name: a.fileName ?? nameFromUri(a.uri) }));
  return importIntoWork(items, true, 'picker');
}

/**
 * Opens the document picker (any file, so that unsupported ones are declined honestly instead of greyed out).
 * `mediaOnly`: photos and videos only — Android's Files picker hands over the original bytes with the GPS position,
 * which the photo picker never does (D45).
 */
export async function pickFiles(mediaOnly = false): Promise<Job[]> {
  const res = await DocumentPicker.getDocumentAsync({ type: mediaOnly ? ['image/*', 'video/*'] : '*/*', multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return importIntoWork(res.assets.map((a) => ({ uri: a.uri, name: a.name })), true, 'files');
}
