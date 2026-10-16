/**
 * Save the cleaned copy (SPEC F5, D18). Device only.
 * iOS: photos and videos go to Photos with add-only access (asked once, after one sentence; never read access); PDFs use
 * the share sheet ("Save to Files").
 * Android 10+ (P6, D46): the local module copies the file byte for byte into MediaStore — photos to Pictures/Safe Share,
 * videos to Movies/Safe Share, PDFs to Download/Safe Share — with no permission (the app's own files). Without the module
 * (older dev builds) Android 11+ falls back to expo-media-library (Pictures/Safe Share for photos and videos, P5).
 * Android 8–9, where saving would need a storage permission Safe Share never asks for, uses the share sheet.
 * Saved bytes are checked with `cmp` + ExifTool on the emulator and simulator (`scripts/share-in.sh <p> saved`).
 */
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

import { explainThen } from './media-location';
import { native } from './native';
import { strings } from './strings';
import { isImage, isVideo, mimeFor } from './summary';

export const ANDROID_ALBUM = 'Safe Share';

export type SaveKind = 'photos' | 'gallery' | 'downloads' | 'share';

const androidVersion = () => (typeof Platform.Version === 'number' ? Platform.Version : 0);
const nativeMediaStore = () => Platform.OS === 'android' && androidVersion() >= 29 && !!native?.saveToMediaStore;

/** How "Save" works for this format on this phone. */
export function saveKind(format: string): SaveKind {
  const media = isImage(format) || isVideo(format);
  if (Platform.OS === 'ios') return media ? 'photos' : 'share';
  if (nativeMediaStore()) return media ? 'gallery' : format === 'pdf' ? 'downloads' : 'share';
  return media && androidVersion() >= 30 ? 'gallery' : 'share';
}

export function saveLabel(kind: SaveKind): string {
  return kind === 'photos' ? strings.result.saveToPhotos
    : kind === 'gallery' ? strings.result.saveToGallery
    : kind === 'downloads' ? strings.result.saveToDownloads
    : strings.result.saveToFiles;
}

export type SaveOutcome = { ok: true; message: string } | { ok: false; message: string };

function fileUrl(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

async function iosAddAllowed(): Promise<boolean | 'refused'> {
  const now = await MediaLibrary.getPermissionsAsync(true);
  if (now.granted) return true;
  if (!now.canAskAgain) return 'refused';
  const go = await explainThen(strings.result.saveAskTitle, strings.result.saveAskMessage, strings.result.saveAskContinue);
  if (!go) return false;
  const res = await MediaLibrary.requestPermissionsAsync(true);
  return res.granted ? true : 'refused';
}

/** Saves a photo, video or (Android) PDF. `share` kinds are handled by the caller with the share sheet. */
export async function saveToLibrary(path: string, kind: SaveKind, format: string, name: string): Promise<SaveOutcome | null> {
  try {
    if (kind === 'photos') {
      const allowed = await iosAddAllowed();
      if (allowed === false) return null;
      if (allowed === 'refused') return { ok: false, message: strings.result.saveRefused };
      await MediaLibrary.Asset.create(fileUrl(path));
      return { ok: true, message: strings.result.savedIos };
    }
    if ((kind === 'gallery' || kind === 'downloads') && nativeMediaStore()) {
      const collection = kind === 'downloads' ? 'downloads' : isVideo(format) ? 'video' : 'images';
      const stored = await native!.saveToMediaStore!(path, name, mimeFor(format).mimeType, collection, ANDROID_ALBUM);
      return { ok: true, message: strings.result.savedAndroid(stored.replace(/\/[^/]*$/, '')) };
    }
    if (kind === 'gallery') {
      const album = await MediaLibrary.Album.get(ANDROID_ALBUM);
      if (album) await MediaLibrary.Asset.create(fileUrl(path), album);
      else await MediaLibrary.Album.create(ANDROID_ALBUM, [fileUrl(path)]);
      return { ok: true, message: strings.result.savedAndroid(`Pictures/${ANDROID_ALBUM}`) };
    }
    return null;
  } catch {
    return { ok: false, message: strings.result.saveFailed };
  }
}
