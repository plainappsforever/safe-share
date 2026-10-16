/**
 * Files shared into Safe Share (SPEC F1, D16, D41). Device only.
 * Android: ACTION_SEND / SEND_MULTIPLE content URIs, copied into the work folder at once (URI grants end with the task).
 * iOS: the share extension saved the files in the App Group inbox; they are moved into the work folder and the inbox
 * is emptied. Both platforms use expo-sharing's `getSharedPayloads()` (the unresolved list: no network, no extra copy).
 */
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { addJobs, type Job } from './jobs';
import { hasMediaLocation } from './media-location';
import { native } from './native';
import { filePayloads, inboxFolderOf, isMediaStoreUri, requireOriginalUri, sharedFileName, type IncomingPayload } from './share-payloads';
import { newJobFolder, safeName } from './work';

function payloads(): IncomingPayload[] {
  try {
    return filePayloads(Sharing.getSharedPayloads());
  } catch {
    return []; // iOS build without the share extension (SHARE_EXTENSION=0): no App Group to read
  }
}

let taking = false;

/** True while the incoming-share screen is taking files in (the launch/foreground check must not open it twice). */
export function isTakingShares(): boolean {
  return taking;
}

export function setTakingShares(v: boolean): void {
  taking = v;
}

/** Files waiting to be picked up (a share that just arrived, or one the iOS extension saved earlier). */
export function hasPendingShares(): boolean {
  return payloads().length > 0;
}

function remove(uri: string) {
  try {
    const d = new Directory(uri);
    if (d.exists) d.delete();
  } catch {
    // swept again next time
  }
}

/** iOS: the App Group inbox of this variant's extension, if the build has one. */
function inbox(): Directory | null {
  if (Platform.OS !== 'ios') return null;
  const group = `group.${Constants.expoConfig?.ios?.bundleIdentifier ?? ''}`;
  const container = Paths.appleSharedContainers?.[group];
  return container ? new Directory(container, 'SafeShareInbox') : null;
}

/** Deletes everything left in the iOS inbox. Only called when no payload is pending (launch) or after all were taken. */
export function sweepInbox(): void {
  if (hasPendingShares()) return;
  const dir = inbox();
  try {
    if (dir?.exists) dir.delete();
  } catch {
    // next launch
  }
}

async function copyInto(uri: string, dst: File, original: boolean): Promise<void> {
  if (original && isMediaStoreUri(uri)) {
    try {
      await new File(requireOriginalUri(uri)).copy(dst);
      return;
    } catch {
      if (dst.exists) dst.delete();
      // not allowed for this URI: fall back to the copy Android hands out by default
    }
  }
  await new File(uri).copy(dst);
}

/** Copies (Android) or moves (iOS) one shared file into a new job folder. */
async function importOne(p: IncomingPayload, original: boolean): Promise<Job> {
  const android = Platform.OS === 'android';
  // Android: the provider's display name (P6 native, P5-5); the id + MIME extension only when the provider has none.
  let shown: string | null = null;
  if (android && native?.displayName) {
    try {
      shown = native.displayName(p.value);
    } catch {
      shown = null;
    }
  }
  const name = shown ? safeName(shown) : sharedFileName(p.value, p.mimeType);
  const { id, dir, inputPath } = newJobFolder(name);
  const dst = new File(inputPath);
  try {
    if (android) await copyInto(p.value, dst, original);
    else {
      const src = new File(p.value);
      try {
        src.moveSync(dst);
      } catch {
        await src.copy(dst);
      }
      const folder = inboxFolderOf(p.value);
      if (folder) remove(folder);
    }
  } catch (e) {
    remove(dir);
    throw e;
  }
  return { id, name, dir, inputPath, size: dst.size, state: 'new', origin: 'share', sourceUri: android ? p.value : undefined };
}

/**
 * Takes every pending shared file into the work folder as new jobs and forgets the payloads.
 * Returns the jobs and how many files could not be read (e.g. an expired Android URI grant).
 */
export async function takeIncomingShares(): Promise<{ jobs: Job[]; failed: number }> {
  const list = payloads();
  const original = await hasMediaLocation();
  const jobs: Job[] = [];
  let failed = 0;
  for (const p of list) {
    try {
      jobs.push(await importOne(p, original));
    } catch (e) {
      if (__DEV__) console.warn('[share-in] could not import', p.value, String(e));
      failed++;
    }
  }
  try {
    Sharing.clearSharedPayloads();
  } catch {
    // nothing to clear
  }
  sweepInbox();
  addJobs(jobs);
  return { jobs, failed };
}

/**
 * Android, after the user allowed media location: reads the shared file again from its content URI, this time asking
 * MediaStore for the original bytes. The job starts over (Inspect reads the new copy). False if it cannot be re-read.
 */
export async function rereadOriginal(job: Job): Promise<boolean> {
  if (Platform.OS !== 'android' || !job.sourceUri) return false;
  const tmp = new File(job.inputPath + '.orig');
  try {
    if (tmp.exists) tmp.delete();
    await copyInto(job.sourceUri, tmp, true);
    const dst = new File(job.inputPath);
    if (dst.exists) dst.delete();
    tmp.moveSync(dst);
    return true;
  } catch {
    try {
      if (tmp.exists) tmp.delete();
    } catch {
      // launch cleanup
    }
    return false;
  }
}
