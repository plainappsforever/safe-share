/** (src ByteFile, dst ByteFile, profile) -> CleanResult. The source is only ever read (D18). */
import type { ByteFile } from './byte-file';
import type { Field } from './catalog';
import { cleanGif } from './gif';
import { cleanHeif } from './heif';
import { inspect, IN_PLACE_FORMATS, model, type MetadataReport, type Problem } from './inspect';
import { cleanJpeg } from './jpeg';
import { cleanMp4 } from './mp4';
import { cleanPdf } from './pdf';
import { cleanPng } from './png';
import { cleanTiffFile } from './tiff-file';
import { keepReason, profileFor, type KeepReason, type Profile } from './profiles';
import { cleanWebp } from './webp';

export interface CleanOptions {
  /** `dst` already holds a byte copy of `src` (made natively); video and PDF are then patched in place. HEIF/AVIF, TIFF and DNG are rebuilt into an empty `dst` (P7.5, D61). */
  dstIsCopy?: boolean;
  /**
   * TEST ONLY — simulates a faulty writer that wrongly keeps these field ids, so tests can prove that
   * verification catches a writer bug (A5). Never set by app code.
   */
  faultyKeep?: string[];
}

export interface CleanResult {
  format: MetadataReport['format'];
  profile: Profile;
  removed: Field[];
  kept: { field: Field; reason: KeepReason }[];
  bytesIn: number;
  bytesOut: number;
  notes: string[];
  /** The inspection of the source this clean was based on (verify needs the values found before). */
  before: MetadataReport;
}

export class CleanError extends Error {
  constructor(readonly problem: Problem, msg: string) {
    super(msg);
    this.name = 'CleanError';
  }
}

export function clean(src: ByteFile, dst: ByteFile, profile: Profile, opts: CleanOptions = {}): CleanResult {
  const before = inspect(src);
  if (!before.supported) throw new CleanError(before.problem ?? 'unsupported', before.detail ?? 'not supported');
  if (before.notCleanable) throw new CleanError('unsupported', before.notCleanable);
  const m = model(src, before.format)!;
  const inPlace = IN_PLACE_FORMATS.includes(m.format) && !!opts.dstIsCopy;
  if (!inPlace && dst.size !== 0) throw new Error('destination must be empty');
  if (inPlace && dst.size !== src.size) throw new Error('destination is not a copy of the source');
  const faulty = new Set(opts.faultyKeep ?? []);
  const eff = profileFor(m.format, profile);
  const keep = (f: Field) => keepReason(f, eff) !== null || faulty.has(f.id);

  let out: { kept: Field[]; notes: string[] };
  switch (m.format) {
    case 'jpeg':
      out = cleanJpeg(src, m.model, dst, keep);
      break;
    case 'png':
      out = cleanPng(src, m.model, dst, keep);
      break;
    case 'webp':
      out = cleanWebp(src, m.model, dst, keep);
      break;
    case 'heic':
    case 'avif':
      out = cleanHeif(src, m.model, dst, keep);
      break;
    case 'mp4':
    case 'mov':
      out = cleanMp4(src, m.model, dst, keep, inPlace);
      break;
    case 'pdf':
      out = cleanPdf(src, m.model, dst, keep, inPlace);
      break;
    case 'tiff':
    case 'dng':
    case 'raw':
      out = cleanTiffFile(src, m.model, dst, keep);
      break;
    case 'gif':
      out = cleanGif(src, m.model, dst, keep);
      break;
  }

  // removed = fields found before minus the ones written (matched by id and value).
  const pool = [...out.kept];
  const removed: Field[] = [];
  const kept: { field: Field; reason: KeepReason }[] = [];
  for (const f of before.fields) {
    const i = pool.findIndex((k) => k.id === f.id && k.value === f.value);
    if (i >= 0) {
      pool.splice(i, 1);
      kept.push({ field: f, reason: keepReason(f, eff) ?? 'profile' });
    } else removed.push(f);
  }
  return { format: before.format, profile, removed, kept, bytesIn: src.size, bytesOut: dst.size, notes: out.notes, before };
}
