/**
 * Inspect -> clean -> verify for one file (SPEC F2-F4). Pure logic over a small `FileIo`, so the same code runs
 * in Jest (Node files) and on the device (`device-io.ts`, expo-file-system). The original is only ever read (D18);
 * the copy is written to the job's `out/` folder under a neutral name; nothing is called clean unless `verify` says so.
 */
import type { ByteFile } from '@/engine/byte-file';
import { clean, CleanError, type CleanResult } from '@/engine/clean';
import { IN_PLACE_FORMATS, inspect, type MetadataReport } from '@/engine/inspect';
import type { Profile } from '@/engine/profiles';
import { sniff, type Format } from '@/engine/sniff';
import { verifySteps, type Verdict } from '@/engine/verify';

import { CancelledError, runInSlices, type CancelToken } from './async-steps';
import { joinPath } from './files';
import { checkWithPlatform, type PlatformInfo, type PlatformKind } from './platform-reader';

export interface FileIo {
  /** Read-only ByteFile over an existing file. */
  openRead(path: string): ByteFile;
  /** Creates an empty file (and its folders) and opens it writable. */
  createEmpty(path: string): ByteFile;
  /** Native byte copy (creates the destination's folders); used for formats patched in place. May be asynchronous (off the JS thread). */
  copyFile(from: string, to: string): void | Promise<void>;
  /** Writable ByteFile over an existing file (the copy that is patched in place). */
  openReadWrite(path: string): ByteFile;
  /** Deletes a file or folder; never throws when it is missing. */
  remove(path: string): void;
  writeText(path: string, text: string): void;
  now(): number;
  /** Reader 3 (P6): the phone's own metadata reader as raw JSON (`platform-reader.ts`). Absent in Jest / without the module. */
  readPlatform?(path: string, kind: PlatformKind): Promise<string>;
}

export type Status = 'clean' | 'dirty' | 'unverified' | 'unsupported' | 'corrupt' | 'failed' | 'cancelled';

/** Where a clean is: preparing the copy, writing it, or the readers checking it (`fraction` 0..1 within the stage). */
export interface Progress {
  stage: 'copying' | 'cleaning' | 'checking';
  fraction: number;
}

export interface Outcome {
  status: Status;
  /** Engine detail or error text for unsupported / corrupt / failed. */
  message?: string;
  outputPath?: string;
  outputName?: string;
  result?: CleanResult;
  verdict?: Verdict;
  /** What reader 3 did (absent when no platform reader is available). */
  platform?: PlatformInfo;
  /** Raw reader-3 output for the copy (recorded by dev builds). */
  platformRaw?: string;
  /** `longestSlice`: the longest time the JS thread was held without a pause while checking (P7: stays well under 100 ms). */
  ms: { clean: number; platform?: number; verify: number; total: number; longestSlice?: number; /** dev builds: longest gap between 50 ms timer ticks during the whole clean */ maxLag?: number };
}

export function inspectFile(io: FileIo, path: string): { report: MetadataReport; ms: number } {
  const t0 = io.now();
  const f = io.openRead(path);
  try {
    if (f.size === 0) return { report: emptyReport(), ms: io.now() - t0 };
    return { report: inspect(f), ms: io.now() - t0 };
  } finally {
    f.close();
  }
}

/** A file of 0 bytes: said plainly, never "not supported yet" (P7). The engine is not involved. */
export const EMPTY_FILE = 'The file is empty';
function emptyReport(): MetadataReport {
  return {
    format: 'unknown', size: 0, supported: false, problem: 'corrupt', detail: EMPTY_FILE,
    fields: [], containers: [], dataRanges: [], scanRanges: [], notes: [], findings: [], extras: [],
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** D18: neutral name (`photo-4K7Q.jpg`, `video-…`, `document-…`), because camera file names contain date and time. */
export function neutralName(format: Format, originalName: string, code: string): string {
  const kind = format === 'mp4' || format === 'mov' ? 'video' : format === 'pdf' ? 'document' : 'photo';
  const originalExt = originalName.includes('.') ? originalName.split('.').pop()!.toLowerCase() : '';
  let ext: string;
  switch (format) {
    case 'jpeg':
      ext = 'jpg';
      break;
    case 'mp4':
      // 3GP/3G2 (X3) go through the MP4 path; their extension tells players which kind of file it is.
      ext = ['m4v', '3gp', '3g2'].includes(originalExt) ? originalExt : 'mp4';
      break;
    case 'tiff':
      ext = originalExt === 'tif' ? 'tif' : 'tiff';
      break;
    default:
      ext = format;
  }
  return `${kind}-${code}.${ext}`;
}

/** Settings → "Keep original file names" (D18): the original name without folders or odd characters, with the extension the file really has. */
export function keptName(originalName: string, fallback: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? '';
  const stem = (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base)
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .trim()
    .slice(0, 100);
  if (!stem || stem === '.' || stem === '..') return fallback;
  return `${stem}${fallback.slice(fallback.lastIndexOf('.'))}`;
}

/** N11 (P7.5): a kept file name like IMG_20260930_142233.jpg still tells the date. */
export function nameHasDate(name: string): boolean {
  return /(?:^|\D)(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])(?:\D|$)/.test(name);
}

const ms = (io: FileIo, t0: number) => io.now() - t0;

/**
 * Cleans `inputPath` into `outDir` with `profile` and verifies the copy (readers 1-2 in the engine, reader 3 = the phone's
 * own reader when `io.readPlatform` exists). Never throws. `debugPlatformReadsInput` (dev builds only) points reader 3 at the
 * ORIGINAL to prove on a device that a value only the platform reader sees makes the copy "Not fully clean" (D44).
 */
export async function cleanFile(
  io: FileIo,
  args: {
    inputPath: string;
    originalName: string;
    outDir: string;
    profile: Profile;
    code?: string;
    report?: MetadataReport;
    debugPlatformReadsInput?: boolean;
    /** Dev builds only: reader 3 is pointed at a missing file for the copy, so the result must be "Could not verify". */
    debugPlatformCannotReadCopy?: boolean;
    /** Settings: keep the original file name instead of a neutral one. */
    keepName?: boolean;
    /** Set by the Cancel button; looked at between slices (at most about one 1 MiB chunk of delay). */
    cancel?: CancelToken;
    onProgress?: (p: Progress) => void;
    /** Dev builds only (Settings → "slow down the clean"): wait this long after every chunk, so Cancel can be tried on a small file. */
    slowMs?: number;
  }
): Promise<Outcome> {
  const t0 = io.now();
  const times: Outcome['ms'] = { clean: 0, verify: 0, total: 0 };
  let src: ByteFile | null = null;
  let dst: ByteFile | null = null;
  let outputPath: string | undefined;
  const fail = (status: Status, message: string): Outcome => {
    if (outputPath) io.remove(outputPath);
    return { status, message, ms: { ...times, total: ms(io, t0) } };
  };
  try {
    src = io.openRead(args.inputPath);
    if (src.size === 0) return fail('corrupt', EMPTY_FILE);
    let format = sniff(src);
    // V1.5-1: DNG and camera RAW look like TIFF to `sniff`; the parser tells them apart (name, in-place path, RAW refusal
    // before any copy is made).
    let report = args.report;
    if (format === 'tiff' || format === 'raw') {
      report ??= inspect(src);
      if (report.supported) format = report.format;
      if (report.notCleanable) return fail('unsupported', report.notCleanable);
    }
    const neutral = neutralName(format, args.originalName, args.code ?? randomCode());
    const outputName = args.keepName ? keptName(args.originalName, neutral) : neutral;
    const stop = () => {
      if (args.cancel?.cancelled) throw new CancelledError();
    };
    args.onProgress?.({ stage: 'copying', fraction: 0 });
    outputPath = joinPath(args.outDir, outputName);
    const inPlace = IN_PLACE_FORMATS.includes(format);
    if (inPlace) {
      // A declined file must not leave a copy behind: copy only when the engine will accept it (the caller's inspection is reused).
      const probe = report ?? inspect(src);
      if (!probe.supported) return fail(probe.problem ?? 'unsupported', probe.detail ?? 'not supported');
      await io.copyFile(args.inputPath, outputPath);
      stop();
      dst = io.openReadWrite(outputPath);
    } else {
      dst = io.createEmpty(outputPath);
    }
    args.onProgress?.({ stage: 'cleaning', fraction: 0 });
    const tc = io.now();
    const result = clean(src, dst, args.profile, { dstIsCopy: inPlace });
    times.clean = ms(io, tc);
    stop();
    // The copy is complete: reopen it read-only so everything written is on disk before the platform reader opens it.
    dst.close();
    dst = null;
    dst = io.openRead(outputPath);
    let check: Awaited<ReturnType<typeof checkWithPlatform>> | null = null;
    if (io.readPlatform) {
      const tp = io.now();
      const readTarget = args.debugPlatformReadsInput ? args.inputPath : args.debugPlatformCannotReadCopy ? `${outputPath}.missing` : outputPath;
      check = await checkWithPlatform((p, k) => io.readPlatform!(p, k), { readTarget, inputPath: args.inputPath, before: result.before, profile: args.profile });
      times.platform = ms(io, tp);
    }
    stop();
    // The same verification code as `verify()`, run in slices: a big file no longer freezes the screen (P4-6).
    const tv = io.now();
    const checked = await runInSlices(verifySteps({ src, dst, before: result.before, profile: args.profile, platform: check?.result ?? null }), {
      cancel: args.cancel,
      now: io.now,
      ...(args.slowMs ? { sliceMs: 0, pause: () => new Promise<void>((r) => setTimeout(r, args.slowMs)) } : {}),
      onProgress: (p) => args.onProgress?.({ stage: 'checking', fraction: p.total > 0 ? p.done / p.total : 0 }),
    });
    const verdict = checked.value;
    times.verify = ms(io, tv);
    times.longestSlice = checked.longestSliceMs;
    return { status: verdict.status, outputPath, outputName, result, verdict, platform: check?.info, platformRaw: check?.raw, ms: { ...times, total: ms(io, t0) } };
  } catch (e) {
    if (e instanceof CancelledError) return fail('cancelled', 'Cancelled');
    if (e instanceof CleanError) return fail(e.problem, e.message);
    return fail('failed', e instanceof Error ? e.message : String(e));
  } finally {
    for (const f of [src, dst]) {
      try {
        f?.close();
      } catch {
        // closing a diagnostic handle must never hide the result
      }
    }
  }
}
