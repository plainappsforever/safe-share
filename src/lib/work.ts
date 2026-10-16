/** Work folder on the device (A14): received copies in `<cache>/work/<job>/in`, cleaned copies in `…/out`. Device only. */
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';

import { cleanWorkFolder, joinPath, workFolderPath } from './files';
import { addJobs, clearJobs, newJobId, type Job } from './jobs';
import { expoWorkFs } from './work-fs';

export const IS_DEV_BUILD = Constants.expoConfig?.extra?.appVariant === 'development';

export interface Incoming {
  uri: string;
  name?: string;
  /** Android photo picker: the content URI, kept so the photo can be read again with its original location. */
  sourceUri?: string;
}

export function nameFromUri(uri: string): string {
  const last = uri.split('?')[0].split('/').filter(Boolean).pop() ?? 'file';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

/** A new job id and its folder: `<cache>/work/<id>/in/<name>` (the folder is created). */
export function newJobFolder(name: string): { id: string; dir: string; inputPath: string } {
  const id = newJobId();
  const dir = joinPath(workFolderPath(Paths.cache.uri), id);
  const inputPath = joinPath(dir, 'in', safeName(name));
  new File(inputPath).parentDirectory.create({ intermediates: true, idempotent: true });
  return { id, dir, inputPath };
}

/**
 * Brings files into the work folder as new jobs. `move` (picker copies in our cache) avoids a second copy of a
 * large video; otherwise the file is copied. The original the user picked is never written to (D18).
 */
export function importIntoWork(items: Incoming[], move: boolean, origin: Job['origin']): Job[] {
  const created: Job[] = [];
  for (const it of items) {
    const name = it.name ?? nameFromUri(it.uri);
    const { id, dir, inputPath } = newJobFolder(name);
    const dst = new File(inputPath);
    const src = new File(it.uri);
    if (move) {
      try {
        src.moveSync(dst);
      } catch {
        src.copySync(dst);
      }
    } else src.copySync(dst);
    created.push({ id, name, dir, inputPath, size: dst.size, state: 'new', origin, sourceUri: it.sourceUri });
  }
  addJobs(created);
  return created;
}

/** Deletes every job folder and forgets the jobs (Done, leaving the result, launch). */
export function wipeWork(): void {
  clearJobs();
  cleanWorkFolder(expoWorkFs, Paths.cache.uri);
}

export function countWorkFiles(): number {
  const walk = (d: Directory): number => {
    let n = 0;
    for (const e of d.list()) n += e instanceof Directory ? walk(e) : 1;
    return n;
  };
  const dir = new Directory(workFolderPath(Paths.cache.uri));
  return dir.exists ? walk(dir) : 0;
}

/** Dev builds: where `scripts/push-fixtures.sh` puts files for the debug deep link. */
export function debugInFolder(): Directory {
  return new Directory(Paths.cache, 'debug-in');
}
