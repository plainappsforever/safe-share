/**
 * Verification (SPEC F4, D11). Up to four checks; only the last two share no code with the cleaners (P7.5, review S2):
 *  1. structural re-read of the output with the inspection parser (the same parser whose model the cleaner used):
 *     every field left must be allowed by the profile;
 *  2. raw signature scan of every byte outside the image data (ranges from that parser): the exact removed values found
 *     before cleaning, plus generic metadata markers outside the blocks reader 1 understood;
 *  3. the separate scan (`sweep.ts`): its own walk and known metadata signatures, no engine parser involved;
 *  4. (optional) the platform reader's result (ImageIO/AVFoundation/PDFKit or metadata-extractor/MediaMetadataRetriever,
 *     mapped to catalogue fields by lib/platform-reader.ts). It can only ADD survivors or problems: its silence never
 *     turns an `unverified` or `dirty` result into `clean`;
 * and the lossless check: the image data of the output equals the source's byte-for-byte (A2).
 * "clean" only when every reader passes.
 */
import { asciiBytes, utf8Bytes } from './binary';
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import type { Field } from './catalog';
import { inspect, type Container, type MetadataReport } from './inspect';
import { outside, rangesEqualSteps, readExact, runToEnd, type StepProgress } from './io';
import { keeps, profileFor, type Profile } from './profiles';
import { sweepSteps } from './sweep';

export type Reader = 'structure' | 'signature' | 'sweep' | 'platform';

export interface Survivor {
  /** Field id (e.g. `exif:GPSLatitude`) or `marker:<name>` for an unrecognised block. */
  id: string;
  /** Human name for "This copy still contains: …". */
  name: string;
  reader: Reader;
}

export interface Verdict {
  status: 'clean' | 'dirty' | 'unverified';
  survivors: Survivor[];
  /** Why the result is not clean beyond survivors (e.g. picture data changed, output unreadable). */
  problems: string[];
  pictureUnchanged: boolean;
  /** Number of checks that ran (3 without a platform reader, 4 with); `sweep` and `platform` share no code with the cleaner. */
  readers: number;
  after: MetadataReport;
}

export interface PlatformResult {
  /** Fields the platform reader found in the output, mapped to catalogue ids (lib/platform-reader.ts). */
  fields: Field[];
  /** The reader's name, e.g. "ImageIO". */
  reader?: string;
  /** Set when the platform reader could not read the copy although it can read this kind of file: not verified. */
  error?: string;
}

export interface VerifyInput {
  src: ByteFile;
  dst: ByteFile;
  before: MetadataReport;
  profile: Profile;
  platform?: PlatformResult | null;
}

/** Markers that mean "a metadata block is here". Allowed only inside blocks the structural reader parsed. */
const MARKERS: { name: string; bytes: Uint8Array; allowedIn: Container['kind'][] }[] = [
  { name: 'Exif block', bytes: asciiBytes('Exif\0\0'), allowedIn: ['exif'] },
  { name: 'XMP block', bytes: asciiBytes('<x:xmpmeta'), allowedIn: ['xmp'] },
  { name: 'XMP block', bytes: asciiBytes('http://ns.adobe.com/xap/1.0/'), allowedIn: ['xmp'] },
  { name: 'Extended XMP block', bytes: asciiBytes('http://ns.adobe.com/xmp/extension/'), allowedIn: [] },
  { name: 'IPTC block', bytes: asciiBytes('Photoshop 3.0'), allowedIn: ['iptc'] },
  { name: 'Multi-picture index', bytes: asciiBytes('MPF\0'), allowedIn: [] },
  { name: 'Motion-photo data', bytes: asciiBytes('GCamera'), allowedIn: [] },
  { name: 'HDR gain-map data', bytes: asciiBytes('hdrgm'), allowedIn: [] },
  { name: 'Video location key', bytes: asciiBytes('quicktime.location.'), allowedIn: [] },
];

/** A needle is specific enough to search for: ≥ 4 chars, and number-like strings need ≥ 8 chars. */
function usable(s: string): boolean {
  if (s.length < 4) return false;
  if (/^[\d\s/.,:+\-]*$/.test(s) && s.length < 8) return false;
  return !/^(true|false|none|null)$/i.test(s);
}

export function verify(input: VerifyInput): Verdict {
  return runToEnd(verifySteps(input));
}

/**
 * `verify` as a generator: the same code, but it yields its progress (bytes scanned and compared so far) after every
 * chunk, so the app can run it in slices between which the screen stays responsive and Cancel works (P7, P4-6).
 * `verify` runs it to the end; nothing else differs.
 */
export function* verifySteps(input: VerifyInput): Generator<StepProgress, Verdict, void> {
  const { src, dst, before } = input;
  const profile = profileFor(before.format, input.profile);
  const after = inspect(dst);
  const survivors: Survivor[] = [];
  const problems: string[] = [];
  if (!after.supported || after.format !== before.format) {
    return { status: 'unverified', survivors, problems: [`Output could not be read back (${after.detail ?? after.format})`], pictureUnchanged: false, readers: 0, after };
  }
  const add = (s: Survivor) => {
    if (!survivors.some((x) => x.id === s.id && x.reader === s.reader)) survivors.push(s);
  };

  // Reader 1: structure.
  for (const f of after.fields) if (!keeps(f, profile)) add({ id: f.id, name: f.name, reader: 'structure' });
  // TIFF/DNG copies are rebuilt from an allow-list (D61): every byte must belong to the parsed structure. A gap is only
  // alignment padding (zeros, at most 3 bytes); anything else is data nothing points at (review M3).
  if (after.coverage) {
    for (const g of outside(dst.size, after.coverage)) {
      if (g.length > 3 || !isZero(dst, g)) {
        add({ id: 'marker:Data outside the file structure', name: 'Data outside the file structure', reader: 'structure' });
        break;
      }
    }
  }

  // Reader 2: signature scan. Removed values that are part of a kept value (e.g. a GPS date inside the kept
  // DateTimeOriginal) cannot be told apart by bytes; reader 1 covers those.
  const keptText = before.fields.filter((f) => keeps(f, profile)).flatMap((f) => [f.value, ...f.needles]);
  const needles: { field: Field; bytes: Uint8Array }[] = [];
  for (const f of before.fields) {
    if (keeps(f, profile) || f.sensitivity === 'none') continue;
    for (const n of new Set(f.needles)) {
      if (!usable(n) || keptText.some((k) => k.includes(n))) continue;
      needles.push({ field: f, bytes: utf8Bytes(n) });
    }
    for (const b of f.binNeedles ?? []) needles.push({ field: f, bytes: b });
  }
  const longest = Math.max(16, ...needles.map((n) => n.bytes.length), ...MARKERS.map((m) => m.bytes.length));
  const inAllowed = (at: number, kinds: Container['kind'][]) =>
    after.containers.some((c) => kinds.includes(c.kind) && at >= c.offset && at < c.offset + c.length);
  const scanBytes = after.scanRanges.reduce((n, r) => n + r.length, 0);
  const compareBytes = before.dataRanges.reduce((n, r) => n + r.length, 0);
  const sweepBytes = dst.size;
  const allBytes = scanBytes + sweepBytes + compareBytes;
  let scanned = 0;
  for (const r of after.scanRanges) {
    // Overlapping windows so a value split across two reads is still found.
    const step = MAX_READ_BYTES - longest;
    for (let start = r.offset; start < r.offset + r.length; start += step) {
      const len = Math.min(MAX_READ_BYTES, r.offset + r.length - start);
      const buf = readExact(dst, start, len);
      for (const n of needles) if (indexOfBytes(buf, n.bytes) >= 0) add({ id: n.field.id, name: n.field.name, reader: 'signature' });
      for (const m of MARKERS) {
        for (let i = indexOfBytes(buf, m.bytes); i >= 0; i = indexOfBytes(buf, m.bytes, i + 1)) {
          if (!inAllowed(start + i, m.allowedIn)) add({ id: `marker:${m.name}`, name: m.name, reader: 'signature' });
        }
      }
      scanned += Math.min(step, len);
      yield { done: Math.min(scanned, scanBytes), total: allBytes };
      if (len < MAX_READ_BYTES) break;
    }
  }

  // Decoded metadata blocks (inflated PDF XMP / object streams): the exact values only.
  for (const buf of after.derived ?? []) {
    for (const n of needles) if (indexOfBytes(buf, n.bytes) >= 0) add({ id: n.field.id, name: n.field.name, reader: 'signature' });
  }

  // Metadata-track samples the cleaner had to zero (video): anything non-zero left there is a survivor.
  for (const r of before.wipeRanges ?? []) {
    if (!isZero(dst, r)) {
      const f = before.fields.find((x) => x.id === r.fieldId);
      add({ id: f?.id ?? 'marker:Metadata track samples', name: f?.name ?? 'Metadata track samples', reader: 'signature' });
    }
  }

  // Reader 3: the separate scan (no engine parser).
  {
    const steps = sweepSteps(dst, before.format, profile);
    let r = steps.next();
    while (!r.done) {
      yield { done: scanBytes + Math.round((r.value.done / Math.max(1, r.value.total)) * sweepBytes), total: allBytes };
      r = steps.next();
    }
    for (const h of r.value) add({ ...h, reader: 'sweep' });
  }

  // Reader 4: platform (optional).
  for (const f of input.platform?.fields ?? []) if (!keeps(f, profile)) add({ id: f.id, name: f.name, reader: 'platform' });
  if (input.platform?.error) problems.push(`The phone's own reader${input.platform.reader ? ` (${input.platform.reader})` : ''} could not read the copy`);

  // Lossless: image data identical. In-place formats keep every offset, so the source's data ranges are
  // compared at the same place in the output (the output's own structure no longer lists removed tracks).
  let pictureUnchanged: boolean;
  {
    const same = before.inPlace ? dst.size === src.size : true;
    const steps = rangesEqualSteps(src, before.dataRanges, dst, before.inPlace ? before.dataRanges : after.dataRanges);
    let r: IteratorResult<StepProgress, boolean> = same ? steps.next() : { done: true, value: false };
    while (!r.done) {
      yield { done: scanBytes + sweepBytes + r.value.done, total: allBytes };
      r = steps.next();
    }
    pictureUnchanged = r.value;
  }
  // TIFF/DNG: the same pictures with the same decode tags (every tag but the offsets) and part sizes, per directory. A dropped
  // SubIFD pointer (the DNG raw image) or a changed colour table is a changed picture even when the bytes are all there (V1.5-1).
  if (pictureUnchanged && before.pictureSignature !== undefined) pictureUnchanged = before.pictureSignature === after.pictureSignature;
  if (!pictureUnchanged) problems.push('Picture data changed');
  for (const o of after.opaque ?? []) problems.push(`Could not check: ${o}`);
  for (const p of after.structureProblems ?? []) problems.push(p);
  // Review S5: a removed value whose bytes lie inside the picture data is still in the copy (as picture bytes).
  if ((before.insidePicture ?? []).some((f) => !keeps(f, profile))) problems.push('Could not check: a removed value is stored inside the picture data');

  const status = survivors.length ? 'dirty' : problems.length ? 'unverified' : 'clean';
  return { status, survivors, problems, pictureUnchanged, readers: input.platform && !input.platform.error ? 4 : 3, after };
}

function isZero(f: ByteFile, r: { offset: number; length: number }): boolean {
  for (let done = 0; done < r.length; ) {
    const n = Math.min(MAX_READ_BYTES, r.length - done);
    const b = readExact(f, r.offset + done, n);
    for (let i = 0; i < n; i++) if (b[i] !== 0) return false;
    done += n;
  }
  return true;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  let i = hay.indexOf(first, from);
  while (i >= 0 && i <= hay.length - needle.length) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = hay.indexOf(first, i + 1);
  }
  return -1;
}
