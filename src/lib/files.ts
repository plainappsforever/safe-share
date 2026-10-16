/**
 * Work folder handling (A14). Cleaned and received files live in `<cache>/work/<jobId>/…` and are
 * deleted at every launch. Pure logic over a tiny `WorkFs` so it runs in Jest; the device adapter
 * is `work-fs.ts`.
 */
export const WORK_DIR_NAME = 'work';

export interface WorkFs {
  exists(path: string): boolean;
  /** Deletes a directory and everything in it. */
  removeDir(path: string): void;
  /** Creates a directory (and parents); succeeds if it already exists. */
  makeDir(path: string): void;
}

export function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ''), ...parts].join('/');
}

export function workFolderPath(cacheDir: string): string {
  return joinPath(cacheDir, WORK_DIR_NAME);
}

/**
 * Deletes everything left in the work folder from a previous run, then recreates it empty.
 * Only `<cache>/work` is touched; other cache content (e.g. dev-only `debug-in/`) is left alone.
 * Never throws: a failed cleanup must not stop the app from starting.
 */
export function cleanWorkFolder(fs: WorkFs, cacheDir: string): { cleaned: boolean; error?: string } {
  const work = workFolderPath(cacheDir);
  try {
    if (fs.exists(work)) fs.removeDir(work);
    fs.makeDir(work);
    return { cleaned: true };
  } catch (e) {
    return { cleaned: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Review S10 (P7.5): other places where copies of ORIGINALS can outlive the work folder: the pickers' own cache folders
 * (expo-document-picker / expo-image-picker leave a copy there when moving it into `work/` fails) and, on iOS, the
 * document picker's `tmp/<bundle>-Inbox`. `tmpEntries` are the names inside the iOS `tmp` folder (null elsewhere).
 * Shares the extension saved and the app has not picked up are NOT here: they are the R2 fallback (App Group inbox).
 */
export function pickerLeftovers(cacheDir: string, tmpEntries: string[] | null): string[] {
  const out = [joinPath(cacheDir, 'DocumentPicker'), joinPath(cacheDir, 'ImagePicker')];
  const tmp = iosTmpDir(cacheDir);
  if (tmp && tmpEntries) for (const n of tmpEntries) if (n.endsWith('-Inbox')) out.push(joinPath(tmp, n));
  return out;
}

/** iOS: `<container>/Library/Caches` -> `<container>/tmp`; null for any other layout (Android). */
export function iosTmpDir(cacheDir: string): string | null {
  const m = cacheDir.replace(/\/+$/, '').match(/^(.*)\/Library\/Caches$/);
  return m ? `${m[1]}/tmp` : null;
}
