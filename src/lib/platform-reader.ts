/**
 * Reader 3 (SPEC F4, D11): the phone's own metadata reader, used only to VERIFY a cleaned copy. The native module
 * (`modules/safe-share-native`) returns a flat list of entries — iOS: ImageIO / AVFoundation / PDFKit; Android:
 * metadata-extractor 2.21.0 + MediaMetadataRetriever (no PDF reader) — and this file maps them to catalogue fields for
 * `verify()`. Pure logic, no React Native imports: tested in Jest with outputs recorded on the simulator and emulator.
 *
 * Rules (D44):
 *  - a platform entry becomes a field when its directory/tag is a metadata place (Exif, GPS, IPTC, XMP, PNG text,
 *    maker notes, video metadata keys, PDF info); pure picture/stream descriptions the platforms derive from the image
 *    data (size, colour model, resolution, codec) are "technical" and never count;
 *  - blank values (empty, zeros, the 1904/1970 zero dates of a cleaned video header) never count;
 *  - any entry whose value equals a value the engine removed (exact text, ≥ 4 characters) counts as that field, wherever
 *    the platform found it;
 *  - under the partial profiles only precisely identified fields and anything location-like count (the platform's
 *    names cannot always be matched to the engine's "unknown" fields).
 * The verdict can only get worse through this reader: its silence never makes a copy clean (verify.ts).
 */
import { describeExif, describeIptc, describePdfInfo, describePngText, describeQtAtom, describeQtKey, describeXmp, GPS_TAGS, IPTC_TAGS, makeField, type Described, type Field, type Source } from '@/engine/catalog';
import type { MetadataReport } from '@/engine/inspect';
import { keeps, profileFor, type Profile } from '@/engine/profiles';
import type { Format } from '@/engine/sniff';
import { NEUTRAL_CAMERA, TIFF_DECODE_TAGS } from '@/engine/tiff-file';
import type { PlatformResult } from '@/engine/verify';

export type PlatformKind = 'image' | 'video' | 'pdf' | 'other';

export interface RawEntry {
  /** Directory (iOS: `image0.{GPS}`, `metadata0`, `asset:<format>`, `PDF`; Android: metadata-extractor directory name). */
  d: string;
  /** Tag name (iOS XMP: the metadata path, video: the AVMetadataIdentifier). */
  t: string;
  /** Android: metadata-extractor tag number (Exif/IPTC). */
  i?: number;
  v: string;
}

export interface RawPlatform {
  reader: string;
  supported: boolean;
  entries: RawEntry[];
  error?: string;
}

/** What the result screen says about reader 3. */
export interface PlatformInfo {
  /** ran = read the copy · none = no platform reader for this kind of file (Android PDF) · cannot-read = the reader
   *  cannot read this file even in the original · error = it read the original but not the copy (not verified). */
  status: 'ran' | 'none' | 'cannot-read' | 'error';
  reader: string;
  detail?: string;
}

export function platformKind(format: Format | string): PlatformKind {
  switch (format) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'heic':
    case 'avif':
    case 'tiff':
    case 'dng':
    case 'gif':
      return 'image';
    case 'mp4':
    case 'mov':
      return 'video';
    case 'pdf':
      return 'pdf';
    default:
      return 'other';
  }
}

export function parseRaw(json: string): RawPlatform {
  try {
    const o = JSON.parse(json) as Partial<RawPlatform>;
    return {
      reader: typeof o.reader === 'string' ? o.reader : 'unknown',
      supported: o.supported !== false,
      entries: Array.isArray(o.entries) ? o.entries.filter((e) => e && typeof e.d === 'string' && typeof e.t === 'string').map((e) => ({ ...e, v: String(e.v ?? '') })) : [],
      error: typeof o.error === 'string' && o.error ? o.error : undefined,
    };
  } catch (e) {
    return { reader: 'unknown', supported: true, entries: [], error: `unreadable reader output (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** Empty, zero or the zero date of a cleaned video header: not data about anyone. */
export function isBlank(v: string): boolean {
  const s = v.replace(/\u0000/g, '').trim();
  if (!s || /^\(?(null|nil|none|empty)\)?$/i.test(s)) return true;
  if (/^[0\s.,:;/+\-TZ]*$/i.test(s)) return true;
  // Zero rationals as the readers print them: "0/1", "0/1, 0/1, 0/1".
  if (s.split(/[\s,;]+/).every((p) => /^0+(\.0+)?(\/\d+)?$/.test(p))) return true;
  // 1904-01-01 (QuickTime epoch) and 1970-01-01 (Unix epoch) as the platforms print them.
  if (/^(1904|1970)[-:]?01[-:]?01([T\s]00[:]?00[:]?00(\.0+)?Z?)?/.test(s)) return true;
  // Java's Date.toString in the phone's time zone: "Fri Jan 01 02:00:00 +02:00 1904", "Thu Dec 31 19:00:00 EST 1903".
  if (/^\w{3} (Jan 0?1|Dec 31) [\d:]{8} .*\b(1903|1904|1969|1970)$/.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping one entry to a field. `precise` = identified through the catalogue (not by a name heuristic).

interface Mapped {
  source: Source;
  key: string;
  d: Described;
  precise: boolean;
}

/** ImageIO {DNG} keys that name the camera or the person (the rest is colour and layout). */
const DNG_PERSONAL = new Set(['UniqueCameraModel', 'LocalizedCameraModel', 'CameraSerialNumber', 'OriginalRawFileName', 'PrivateData', 'RawDataUniqueID', 'PreviewDateTime', 'PreviewApplicationName']);

const TECHNICAL = (d: Described) => d.group === 'technical' || d.sensitivity === 'none';

/** Picture-layout values the platforms derive from the image data (ImageIO reports HEIF tiles as TIFF tile sizes). */
const DERIVED_NAMES = new Set(['TileWidth', 'TileLength']);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const IPTC_BY_NAME = new Map<string, number>();
for (const [ds, [key]] of Object.entries(IPTC_TAGS)) IPTC_BY_NAME.set(norm(key), Number(ds));
// ImageIO spellings that differ from the IIM names.
const IPTC_IMAGEIO: Record<string, number> = { byline: 80, bylinetitle: 85, supplementalcategory: 20, captionabstract: 120, writereditor: 122 };

const GPS_BY_NAME = new Map<string, number>();
for (const [tag, [key]] of Object.entries(GPS_TAGS)) GPS_BY_NAME.set(key, Number(tag));

const MAKER_NOTES: Mapped = {
  source: 'exif',
  key: 'MakerNote',
  d: { name: 'Maker notes', group: 'extras', sensitivity: 'medium', known: true },
  precise: true,
};

function gps(local: string): Mapped {
  const key = local === 'GPSVersion' ? 'GPSVersionID' : local.startsWith('GPS') ? local : `GPS${local}`;
  const tag = GPS_BY_NAME.get(key);
  const d = tag !== undefined ? describeExif('GPS', tag) : describeExif('GPS', 0xffff);
  return { source: 'exif', key: d.key === 'GPSTag0xffff' ? key : d.key, d, precise: true };
}

function exifByName(prefix: 'exif' | 'tiff' | 'aux', local: string): Mapped | null {
  if (local.startsWith('GPS')) return gps(local);
  if (DERIVED_NAMES.has(local)) return null;
  const d = describeXmp(prefix, local);
  return { source: 'exif', key: local, d, precise: d.known };
}

function iptcByName(name: string): Mapped {
  const n = norm(name);
  const ds = IPTC_IMAGEIO[n] ?? IPTC_BY_NAME.get(n);
  if (ds !== undefined) {
    const d = describeIptc(2, ds);
    return { source: 'iptc', key: d.key, d, precise: true };
  }
  return { source: 'iptc', key: name, d: describeXmp('iptc', name), precise: false };
}

function xmpPath(path: string): Mapped | null {
  // `dc:creator[1]`, `Iptc4xmpCore:CreatorContactInfo/Iptc4xmpCore:CiEmailWork`, `exif:GPSLatitude` → the last property.
  const last = path.split(/[/.]/).filter(Boolean).pop() ?? path;
  // Array items and language alternatives: `dc:creator[1]`, `dc:rights[x-default]`.
  const m = last.replace(/(\[[^\]]*\])+$/, '').replace(/^\?/, '').match(/^([A-Za-z0-9_-]+):(.+)$/);
  if (!m) return null;
  const [, prefix, local] = m;
  if (prefix === 'iio') return null; // ImageIO's own bookkeeping (iio:hasXMP, iio:hasIIM); the values themselves are listed
  if (prefix === 'exif' || prefix === 'exifEX' || prefix === 'tiff' || prefix === 'aux') {
    if (local.startsWith('GPS')) return gps(local);
    if (DERIVED_NAMES.has(local)) return null;
  }
  const d = describeXmp(prefix, local);
  return { source: 'xmp', key: `${prefix}:${local}`, d, precise: d.known };
}

function qtIdentifier(id: string): Mapped {
  // AVMetadataIdentifier `<keySpace>/<key>` with non-ASCII bytes %-escaped (udta/%A9xyz = ©xyz).
  const slash = id.indexOf('/');
  const space = slash > 0 ? id.slice(0, slash) : '';
  let key = slash > 0 ? id.slice(slash + 1) : id;
  try {
    key = decodeURIComponent(key.replace(/%A9/gi, '©'));
  } catch {
    // keep as is
  }
  if (space === 'mdta' || space === 'common' || key.includes('.')) {
    const d = describeQtKey(space === 'common' ? key.toLowerCase() : key);
    return { source: 'qt', key, d, precise: d.known };
  }
  const d = describeQtAtom(key);
  return { source: 'qt', key, d, precise: d.known };
}

function mapIos(e: RawEntry): Mapped | null {
  const dir = e.d;
  // ImageIO property dictionaries: image<i>.{GPS}, image<i>.{Exif}, …
  const sub = dir.match(/^image\d+\.\{(\w+)\}/)?.[1];
  if (sub) {
    if (sub === 'GPS') return gps(e.t);
    if (sub === 'Exif') return exifByName('exif', e.t);
    if (sub === 'TIFF') return exifByName('tiff', e.t);
    if (sub === 'ExifAux') return exifByName('aux', e.t);
    if (sub === 'IPTC') return iptcByName(e.t);
    if (sub.startsWith('Maker')) return MAKER_NOTES;
    if (sub === 'PNG') {
      const d = describePngText(e.t.replace(/([a-z])([A-Z])/g, '$1 $2'));
      return d.known ? { source: 'png', key: e.t, d, precise: true } : null;
    }
    if (sub === 'DNG') {
      // V1.5-1: ImageIO's {DNG} dictionary is mostly colour data; only these name the camera or the person.
      if (!DNG_PERSONAL.has(e.t) || (e.t === 'UniqueCameraModel' && e.v.trim() === NEUTRAL_CAMERA)) return null;
      return exifByName('tiff', e.t === 'PrivateData' ? 'DNGPrivateData' : e.t);
    }
    if (sub === '8BIM') return { source: 'jpeg', key: 'Photoshop', d: { name: 'Photoshop data', group: 'extras', sensitivity: 'medium', known: true }, precise: true };
    return null; // {JFIF}, {HEIF}, {WebP}, {GIF}, … describe the picture
  }
  if (/^metadata\d+$/.test(dir)) return xmpPath(e.t);
  if (dir.startsWith('asset:') || /^track\d+:/.test(dir)) return qtIdentifier(e.t);
  if (dir === 'PDF') {
    const d = describePdfInfo(e.t === 'ModificationDate' ? 'ModDate' : e.t);
    return { source: 'pdf', key: e.t, d, precise: d.known };
  }
  return null; // source, container, image<i> top level (size, colour model, DPI, orientation), document page count
}

const EXIF_DIRS: Record<string, 'IFD0' | 'ExifIFD' | 'GPS' | 'Interop' | 'IFD1'> = {
  'Exif IFD0': 'IFD0',
  'Exif Image': 'IFD0',
  'Exif SubIFD': 'ExifIFD',
  GPS: 'GPS',
  Interoperability: 'Interop',
  'Exif Thumbnail': 'IFD1',
};

function mapAndroid(e: RawEntry): Mapped | null {
  if (e.t === 'error') return null;
  const ifd = EXIF_DIRS[e.d];
  // V1.5-1: in a TIFF/DNG, IFD0 also holds the picture layout (strips, DNG colour tables) and the neutral camera name.
  // (metadata-extractor may file a DNG's raw SubIFD under "Exif SubIFD"; JPEG thumbnails in "Exif Thumbnail" stay survivors.)
  if ((ifd === 'IFD0' || ifd === 'ExifIFD') && typeof e.i === 'number' && (TIFF_DECODE_TAGS.has(e.i) || (e.i === 0xc614 && e.v.trim() === NEUTRAL_CAMERA))) return null;
  if (e.d === 'GIF Comment') return { source: 'gif', key: 'Comment', d: { name: 'Comment', group: 'people', sensitivity: 'high', known: true }, precise: true };
  if (ifd && typeof e.i === 'number') {
    const d = describeExif(ifd, e.i);
    return { source: 'exif', key: d.key, d, precise: d.known };
  }
  if (e.d === 'IPTC' && typeof e.i === 'number') {
    const d = describeIptc(e.i >> 8, e.i & 0xff);
    return { source: 'iptc', key: d.key, d, precise: d.known };
  }
  if (e.d === 'XMP properties') return xmpPath(e.t);
  if (e.d === 'PNG text') {
    const d = describePngText(e.t);
    return { source: 'png', key: e.t, d, precise: d.known };
  }
  if (/makernote/i.test(e.d)) return MAKER_NOTES;
  if (e.d === 'JpegComment') return { source: 'jpeg', key: 'Comment', d: { name: 'Comment', group: 'people', sensitivity: 'high', known: true }, precise: true };
  if (e.d === 'MediaMetadataRetriever') {
    if (e.t === 'location') return { source: 'qt', key: 'location.ISO6709', d: describeQtKey('location.ISO6709'), precise: true };
    if (e.t === 'date' || e.t === 'year') return { source: 'qt', key: 'creationdate', d: describeQtKey('creationdate'), precise: true };
    const d = describeQtKey(e.t);
    return { source: 'qt', key: e.t, d, precise: d.known };
  }
  if (e.d === 'QuickTime Metadata' || e.d === 'QuickTime User Data' || /^MP4 (User Data|Metadata)/.test(e.d)) {
    const name = e.t;
    if (/locat|6709|gps|xyz/i.test(name)) return { source: 'qt', key: name, d: describeQtKey('location.ISO6709'), precise: true };
    const d = describeQtKey(name.toLowerCase().replace(/\s+/g, ''));
    return { source: 'qt', key: name, d, precise: d.known };
  }
  if (/^(QuickTime|MP4)( Video| Sound)?$/.test(e.d) && /^(Creation|Modification) Time$/.test(e.t)) {
    return { source: 'qt', key: e.t, d: { name: e.t === 'Creation Time' ? 'Date recorded' : 'Date modified', group: 'datetime', sensitivity: 'medium', known: true }, precise: true };
  }
  return null; // File, File Type, JPEG, JFIF, Huffman, ICC Profile, PNG-IHDR/-sRGB/…, WebP, HEIF, MP4/QuickTime Video/Sound…
}

/** Maps the reader's output of the CLEANED copy to fields for `verify()`. */
export function platformFields(raw: RawPlatform, before: MetadataReport, profile: Profile): Field[] {
  const ios = /^(ImageIO|AVFoundation|PDFKit)$/.test(raw.reader);
  const effective = profileFor(before.format, profile);
  const out = new Map<string, Field>();
  const add = (f: Field) => {
    if (!out.has(f.id)) out.set(f.id, f);
  };

  // Exact values the engine removed (and no kept field shares), for the "found anywhere" rule.
  const kept = before.fields.filter((f) => keeps(f, effective));
  const keptValues = new Set(kept.flatMap((f) => [f.value, ...f.needles]).map((v) => v.trim()));
  const removedByValue = new Map<string, Field>();
  for (const f of before.fields) {
    if (keeps(f, effective) || f.sensitivity === 'none') continue;
    for (const v of [f.value, ...f.needles]) {
      const t = v.trim();
      if (t.length < 4 || isBlank(t) || keptValues.has(t) || (/^[\d\s/.,:+\-]*$/.test(t) && t.length < 8)) continue;
      if (!removedByValue.has(t)) removedByValue.set(t, f);
    }
  }

  for (const e of raw.entries) {
    if (isBlank(e.v)) continue;
    const byValue = removedByValue.get(e.v.trim());
    if (byValue) add({ ...byValue, value: e.v });
    const m = ios ? mapIos(e) : mapAndroid(e);
    if (!m || TECHNICAL(m.d)) continue;
    if (effective !== 'all' && !m.precise && m.d.group !== 'location') continue;
    add(makeField(m.source, m.key, m.d, e.v));
  }
  return [...out.values()];
}

export interface PlatformCheck {
  /** Input for `verify()`; null when no platform reader applies (the verdict then says 2 readers). */
  result: PlatformResult | null;
  info: PlatformInfo;
  /** The raw output for the copy (dev builds record it for the Jest samples). */
  raw?: string;
}

/**
 * Runs reader 3 on the cleaned copy. If it cannot read the copy, the original is tried: when the original is
 * unreadable too, the reader simply does not handle this file (no third reader, 2 readers); when only the copy is
 * unreadable, the copy is "Could not verify". `readTarget` is the copy (dev builds may point it at the original to
 * inject a failure, D44).
 */
export async function checkWithPlatform(
  read: (path: string, kind: PlatformKind) => Promise<string>,
  args: { readTarget: string; inputPath: string; before: MetadataReport; profile: Profile }
): Promise<PlatformCheck> {
  const kind = platformKind(args.before.format);
  if (kind === 'other') return { result: null, info: { status: 'none', reader: 'none' } };
  const safeRead = async (p: string) => {
    try {
      return await read(p, kind);
    } catch (e) {
      return JSON.stringify({ reader: 'unknown', supported: true, entries: [], error: e instanceof Error ? e.message : String(e) });
    }
  };
  const rawText = await safeRead(args.readTarget);
  const raw = parseRaw(rawText);
  if (!raw.supported) return { result: null, info: { status: 'none', reader: raw.reader }, raw: rawText };
  if (raw.error) {
    const original = parseRaw(await safeRead(args.inputPath));
    if (!original.supported || original.error) {
      return { result: null, info: { status: 'cannot-read', reader: raw.reader, detail: raw.error }, raw: rawText };
    }
    return { result: { fields: [], reader: raw.reader, error: raw.error }, info: { status: 'error', reader: raw.reader, detail: raw.error }, raw: rawText };
  }
  return {
    result: { fields: platformFields(raw, args.before, args.profile), reader: raw.reader },
    info: { status: 'ran', reader: raw.reader },
    raw: rawText,
  };
}
