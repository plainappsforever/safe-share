/**
 * Share several cleaned copies at once (SPEC F5/F6, P6). Device only.
 * One system share sheet for all files: iOS UIActivityViewController with the file URLs; Android ACTION_SEND_MULTIPLE
 * with expo-file-system content URIs (`File.contentUri`) and a read grant, through the local module. A single file keeps
 * expo-sharing's `shareAsync` (unchanged since P4).
 */
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { native } from './native';
import { strings } from './strings';

export async function shareMany(items: { path: string; mimeType: string }[]): Promise<void> {
  if (items.length === 0) return;
  if (items.length === 1 || !native) {
    await Sharing.shareAsync(items[0].path, { mimeType: items[0].mimeType, dialogTitle: strings.result.share });
    return;
  }
  const uris = Platform.OS === 'android' ? items.map((i) => new File(i.path).contentUri) : items.map((i) => i.path);
  await native.shareFiles(uris, items.map((i) => i.mimeType), strings.result.share);
}
