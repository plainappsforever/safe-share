/**
 * TIFF files (V1.5-1, ledger #5/#9/#10): plain TIFF, DNG and camera RAW files that are TIFF structures (NEF, ARW, CR2, PEF,
 * SRW …, plus ORF/RW2 with their own magic numbers).
 *
 * Cleaning is an ALLOW-LIST REBUILD into an empty file (V1.5-1 fix round, review M1–M3, D61). The copy gets, and only gets:
 *  - a new 8-byte header in the original byte order;
 *  - one rebuilt directory per picture directory (IFD0 chain = pages and previews, SubIFDs = the DNG raw image and its
 *    chain), holding only the tags in `TIFF_DECODE_TAGS` (written from the TIFF 6.0, TIFF/EP and DNG 1.7 tag tables) plus
 *    the catalogue fields the profile keeps; rebuilt Exif/GPS/Interop directories only where TIFF puts them (Exif/GPS
 *    under a picture directory, Interop under its Exif directory) and only when the profile keeps something there;
 *  - XMP, IPTC and Photoshop blocks rebuilt from their parsed items (no size limit, so "Location only" keeps per item);
 *  - DNG's required UniqueCameraModel, with the neutral value "Camera" when the profile removes the real one (D59);
 *  - the picture data (strips, tiles, old-style JPEG interchange streams) copied byte for byte, with every offset table
 *    rewritten to the new positions.
 * Nothing else is copied: no maker note, no unknown tag, no directory in an unexpected place, no byte that no allow-listed
 * structure points at (orphaned values, earlier tools' leftovers, free space). Unknown and unexpected structures are still
 * WALKED, so the inspection lists what they hold (a GPS directory inside the Exif directory is location, review M2).
 *
 * Camera RAW files from camera makers (`kind: 'raw'`) are inspected only: their maker notes can hold data the decoder needs,
 * so removing them could break the picture, and keeping them keeps serial numbers (V15_PLAN #10). DNG and TIFF are cleaned.
 */
import { ascii, CRC32_START, crc32Add, crc32Done, put16, put32, u16, u32, utf8, utf8Bytes, type Endian } from './binary';
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import { makeField, type Field } from './catalog';
import { iccField, isIccProfile } from './icc';
import type { Container, FormatReport } from './inspect';
import { outside, readExact, SeqWriter, TruncatedError, type Range } from './io';
import { iptcFields, irbFields, parseIptc, parseIrb, PHOTOSHOP_ID, rebuildIrb, writeIptc, type IptcDataset, type IrbBlock } from './iptc';
import { CorruptError } from './jpeg';
import { fieldsOfTiff, TYPE_SIZE, type IfdName, type TiffEntry } from './tiff';
import { parseXmp, rebuildXmp, xmpFields, type XmpProp } from './xmp';

export type TiffKind = 'tiff' | 'dng' | 'raw';
/** `private`: a directory reached through a private IFD-type entry or a pointer in an unexpected place (listed, never copied). */
type Role = 'image' | 'exif' | 'gps' | 'interop' | 'private';

interface TEntry {
  tag: number;
  type: number;
  count: number;
  /** Value size in bytes (0 for an unknown type). */
  size: number;
  /** The 12 entry bytes as stored. */
  bytes: Uint8Array;
  /** Absolute position of the value bytes (inside the entry when `inline`). */
  valueAt: number;
  inline: boolean;
  /** The type is one of TIFF's 13 (classic TIFF; LONG8 and friends are BigTIFF only). */
  validType: boolean;
}

interface TIfd {
  name: string;
  role: Role;
  offset: number;
  entries: TEntry[];
  next: number;
  /** In a place TIFF defines for its role (IFD0 chain, SubIFDs and their chains, Exif/GPS under a picture, Interop under Exif). */
  standard: boolean;
  /** The next picture directory of the chain (standard picture directories only). */
  chainNext?: TIfd;
}

type Use =
  | { kind: 'decode' }
  | { kind: 'neutral-camera' }
  | { kind: 'pointer'; targets: TIfd[]; standard: boolean }
  | { kind: 'field'; fields: Field[] }
  | { kind: 'xmp'; fields: Field[]; props: XmpProp[] }
  | { kind: 'iptc'; fields: Field[]; ds: IptcDataset[] }
  | { kind: 'irb'; fields: Field[]; blocks: IrbBlock[] }
  | { kind: 'camera-name'; fields: Field[] };

export interface TiffFileModel {
  kind: TiffKind;
  endian: Endian;
  ifds: TIfd[];
  uses: Map<TEntry, Use>;
  /** Source ranges of every offset entry of the picture data (null for a zero-length part). */
  pictureParts: Map<TEntry, (Range | null)[]>;
  /** `tiff:Image:*` fields: the other pictures in the file (previews, pages), kept byte for byte. */
  imageFields: Field[];
  /** Camera RAW made by a camera maker (`kind: 'raw'`): which one, for the message. */
  vendor?: string;
  /** DNG: the camera calibration matrices are applied (both calibration names equal, an absent name counting as empty). */
  calibrationApplies: boolean;
  report: FormatReport;
}

/** The value DNG's required UniqueCameraModel gets instead of the real model (D59). */
export const NEUTRAL_CAMERA = 'Camera';
/** Metadata values larger than this are not read (display only; they are never copied unless kept). */
const MAX_META = 4 * 1024 * 1024;
const MAX_IFDS = 512;
const MAX_ENTRIES = 4096;
/** Picture directories with more SubIFDs than this are not supported. */
const MAX_POINTERS = 64;

// Value types (TIFF 6.0 §2 "Types"): BYTE 1, ASCII 2, SHORT 3, LONG 4, RATIONAL 5, SBYTE 6, UNDEFINED 7, SSHORT 8, SLONG 9,
// SRATIONAL 10, FLOAT 11, DOUBLE 12, IFD 13.
const I = [3, 4];
const S = [3];
const L = [4];
const R = [5];
const SR = [10];
const B = [1];
const U = [7];
const BU = [1, 7];
const F = [11];
const D = [12];
const IR = [3, 4, 5];
const NUM = [1, 3, 4, 5, 6, 8, 9, 10, 11, 12];
const ANY = Number.POSITIVE_INFINITY;

/**
 * The decode allow-list (review M1, D61): the tags a reader needs to decode a picture directory and show it the same.
 * [name, allowed types, maximum count]. Kept by every profile and never listed as fields. A listed tag with another type or
 * more values than allowed makes the file "could not read" (a wrong type could carry text into the copy).
 * Sources: TIFF 6.0 (Adobe 1992) Part 1 baseline + Part 2 extensions; TIFF/EP (ISO 12234-2) CFA tags; DNG 1.7.1.0 (Adobe
 * 2023) chapter 4 tag list; names as in ExifTool 13.59's Exif::Main table. NOT on the list (they are catalogue fields or
 * unknown, so removed by "Remove everything"): Orientation and ICC (catalogue, kept as orientation/colour), UniqueCameraModel
 * (handled on its own), every text, name, ID, signature and copyright tag (ProfileName, ProfileCopyright, AsShotProfileName,
 * calibration signatures, InkNames, ImageSequenceInfo, SemanticInstanceID, SEAL 0xCEA1, C2PA 0xCD41), ExtraCameraProfiles,
 * old-style JPEG table offsets (0x207–0x209: refused), Free offsets, maker notes and private data.
 */
export const TIFF_DECODE_TAGS: ReadonlyMap<number, readonly [string, readonly number[], number]> = new Map([
  // TIFF 6.0
  [0x00fe, ['NewSubfileType', I, 1]],
  [0x00ff, ['SubfileType', S, 1]],
  [0x0100, ['ImageWidth', I, 1]],
  [0x0101, ['ImageLength', I, 1]],
  [0x0102, ['BitsPerSample', I, 32]],
  [0x0103, ['Compression', I, 1]],
  [0x0106, ['PhotometricInterpretation', I, 1]],
  [0x0107, ['Threshholding', S, 1]],
  [0x0108, ['CellWidth', S, 1]],
  [0x0109, ['CellLength', S, 1]],
  [0x010a, ['FillOrder', S, 1]],
  [0x0111, ['StripOffsets', I, ANY]],
  [0x0115, ['SamplesPerPixel', I, 1]],
  [0x0116, ['RowsPerStrip', I, 1]],
  [0x0117, ['StripByteCounts', I, ANY]],
  [0x0118, ['MinSampleValue', S, 32]],
  [0x0119, ['MaxSampleValue', S, 32]],
  [0x011a, ['XResolution', R, 1]],
  [0x011b, ['YResolution', R, 1]],
  [0x011c, ['PlanarConfiguration', S, 1]],
  [0x0122, ['GrayResponseUnit', S, 1]],
  [0x0123, ['GrayResponseCurve', S, ANY]],
  [0x0124, ['T4Options', L, 1]],
  [0x0125, ['T6Options', L, 1]],
  [0x0128, ['ResolutionUnit', S, 1]],
  [0x012d, ['TransferFunction', S, ANY]],
  [0x013d, ['Predictor', S, 1]],
  [0x013e, ['WhitePoint', R, 2]],
  [0x013f, ['PrimaryChromaticities', R, 6]],
  [0x0140, ['ColorMap', S, ANY]],
  [0x0141, ['HalftoneHints', S, 2]],
  [0x0142, ['TileWidth', I, 1]],
  [0x0143, ['TileLength', I, 1]],
  [0x0144, ['TileOffsets', I, ANY]],
  [0x0145, ['TileByteCounts', I, ANY]],
  [0x014c, ['InkSet', S, 1]],
  [0x014e, ['NumberOfInks', S, 1]],
  [0x0150, ['DotRange', [1, 3], 64]],
  [0x0152, ['ExtraSamples', S, 32]],
  [0x0153, ['SampleFormat', S, 32]],
  [0x0154, ['SMinSampleValue', NUM, 32]],
  [0x0155, ['SMaxSampleValue', NUM, 32]],
  [0x0156, ['TransferRange', S, 6]],
  [0x015b, ['JPEGTables', U, ANY]],
  [0x0200, ['JPEGProc', S, 1]],
  [0x0201, ['JPEGInterchangeFormat', L, 1]],
  [0x0202, ['JPEGInterchangeFormatLength', L, 1]],
  [0x0203, ['JPEGRestartInterval', S, 1]],
  [0x0205, ['JPEGLosslessPredictors', S, 32]],
  [0x0206, ['JPEGPointTransforms', S, 32]],
  [0x0211, ['YCbCrCoefficients', R, 3]],
  [0x0212, ['YCbCrSubSampling', S, 2]],
  [0x0213, ['YCbCrPositioning', S, 1]],
  [0x0214, ['ReferenceBlackWhite', IR, 6]],
  // TIFF/EP (the raw image of a DNG)
  [0x828d, ['CFARepeatPatternDim', S, 2]],
  [0x828e, ['CFAPattern', B, 256]],
  // DNG 1.7
  [0xc612, ['DNGVersion', B, 4]],
  [0xc613, ['DNGBackwardVersion', B, 4]],
  [0xc616, ['CFAPlaneColor', B, 16]],
  [0xc617, ['CFALayout', S, 1]],
  [0xc618, ['LinearizationTable', S, ANY]],
  [0xc619, ['BlackLevelRepeatDim', S, 2]],
  [0xc61a, ['BlackLevel', IR, ANY]],
  [0xc61b, ['BlackLevelDeltaH', SR, ANY]],
  [0xc61c, ['BlackLevelDeltaV', SR, ANY]],
  [0xc61d, ['WhiteLevel', I, 32]],
  [0xc61e, ['DefaultScale', R, 2]],
  [0xc61f, ['DefaultCropOrigin', IR, 2]],
  [0xc620, ['DefaultCropSize', IR, 2]],
  [0xc621, ['ColorMatrix1', SR, 64]],
  [0xc622, ['ColorMatrix2', SR, 64]],
  [0xc623, ['CameraCalibration1', SR, 64]],
  [0xc624, ['CameraCalibration2', SR, 64]],
  [0xc625, ['ReductionMatrix1', SR, 64]],
  [0xc626, ['ReductionMatrix2', SR, 64]],
  [0xc627, ['AnalogBalance', R, 16]],
  [0xc628, ['AsShotNeutral', [3, 5], 16]],
  [0xc629, ['AsShotWhiteXY', R, 2]],
  [0xc62a, ['BaselineExposure', SR, 1]],
  [0xc62b, ['BaselineNoise', R, 1]],
  [0xc62c, ['BaselineSharpness', R, 1]],
  [0xc62d, ['BayerGreenSplit', L, 1]],
  [0xc62e, ['LinearResponseLimit', R, 1]],
  [0xc631, ['ChromaBlurRadius', R, 1]],
  [0xc632, ['AntiAliasStrength', R, 1]],
  [0xc633, ['ShadowScale', R, 1]],
  [0xc65a, ['CalibrationIlluminant1', S, 1]],
  [0xc65b, ['CalibrationIlluminant2', S, 1]],
  [0xc65c, ['BestQualityScale', R, 1]],
  [0xc68d, ['ActiveArea', I, 4]],
  [0xc68e, ['MaskedAreas', I, ANY]],
  [0xc68f, ['AsShotICCProfile', U, ANY]],
  [0xc690, ['AsShotPreProfileMatrix', SR, 64]],
  [0xc691, ['CurrentICCProfile', U, ANY]],
  [0xc692, ['CurrentPreProfileMatrix', SR, 64]],
  [0xc6bf, ['ColorimetricReference', S, 1]],
  [0xc6f7, ['NoiseReductionApplied', R, 1]],
  [0xc6f9, ['ProfileHueSatMapDims', L, 3]],
  [0xc6fa, ['ProfileHueSatMapData1', F, ANY]],
  [0xc6fb, ['ProfileHueSatMapData2', F, ANY]],
  [0xc6fc, ['ProfileToneCurve', F, ANY]],
  [0xc6fd, ['ProfileEmbedPolicy', L, 1]],
  [0xc714, ['ForwardMatrix1', SR, 64]],
  [0xc715, ['ForwardMatrix2', SR, 64]],
  [0xc71a, ['PreviewColorSpace', L, 1]],
  [0xc71c, ['RawImageDigest', BU, 16]],
  [0xc71e, ['SubTileBlockSize', I, 2]],
  [0xc71f, ['RowInterleaveFactor', I, 1]],
  [0xc725, ['ProfileLookTableDims', L, 3]],
  [0xc726, ['ProfileLookTableData', F, ANY]],
  [0xc740, ['OpcodeList1', U, ANY]],
  [0xc741, ['OpcodeList2', U, ANY]],
  [0xc74e, ['OpcodeList3', U, ANY]],
  [0xc761, ['NoiseProfile', D, 64]],
  [0xc791, ['OriginalDefaultFinalSize', I, 2]],
  [0xc792, ['OriginalBestQualitySize', I, 2]],
  [0xc793, ['OriginalDefaultCropSize', IR, 2]],
  [0xc7a3, ['ProfileHueSatMapEncoding', L, 1]],
  [0xc7a4, ['ProfileLookTableEncoding', L, 1]],
  [0xc7a5, ['BaselineExposureOffset', SR, 1]],
  [0xc7a6, ['DefaultBlackRender', L, 1]],
  [0xc7a7, ['NewRawImageDigest', BU, 16]],
  [0xc7a8, ['RawToPreviewGain', D, 1]],
  [0xc7b5, ['DefaultUserCrop', R, 4]],
  [0xc7e9, ['DepthFormat', S, 1]],
  [0xc7ea, ['DepthNear', R, 1]],
  [0xc7eb, ['DepthFar', R, 1]],
  [0xc7ec, ['DepthUnits', S, 1]],
  [0xc7ed, ['DepthMeasureType', S, 1]],
  [0xcd2d, ['ProfileGainTableMap', U, ANY]],
  // SemanticName: the kind of a semantic mask layer ("Sky", "Skin"); the per-instance ID (0xCD30) is not kept.
  [0xcd2e, ['SemanticName', [1, 2], 64]],
  [0xcd31, ['CalibrationIlluminant3', S, 1]],
  [0xcd32, ['CameraCalibration3', SR, 64]],
  [0xcd33, ['ColorMatrix3', SR, 64]],
  [0xcd34, ['ForwardMatrix3', SR, 64]],
  [0xcd35, ['IlluminantData1', BU, 4096]],
  [0xcd36, ['IlluminantData2', BU, 4096]],
  [0xcd37, ['IlluminantData3', BU, 4096]],
  [0xcd38, ['MaskSubArea', L, 4]],
  [0xcd39, ['ProfileHueSatMapData3', F, ANY]],
  [0xcd3a, ['ReductionMatrix3', SR, 64]],
  [0xcd3f, ['RGBTables', BU, ANY]],
  [0xcd40, ['ProfileGainTableMap2', BU, ANY]],
  [0xcd43, ['ColumnInterleaveFactor', I, 1]],
  [0xcd46, ['ImageStats', BU, ANY]],
  [0xcd47, ['ProfileDynamicRange', BU, 64]],
  [0xcd49, ['JXLDistance', F, 1]],
  [0xcd4a, ['JXLEffort', L, 1]],
  [0xcd4b, ['JXLDecodeSpeed', L, 1]],
] as [number, readonly [string, readonly number[], number]][]);

/** Offset tags of the picture data and their length tags (TIFF 6.0 strips, tiles; old-style JPEG interchange format). */
const PICTURE_PAIRS: [offsets: number, lengths: number][] = [
  [0x0111, 0x0117],
  [0x0144, 0x0145],
  [0x0201, 0x0202],
];
const OFFSET_TAGS = new Set(PICTURE_PAIRS.map(([o]) => o));
/** Camera calibration matrices: DNG applies them only when the camera and profile calibration names match (DNG 1.7 §6). */
const CALIBRATION_TAGS = new Set([0xc623, 0xc624, 0xcd32]);
const TAG_SUBIFDS = 0x014a;
const TAG_EXIF = 0x8769;
const TAG_GPS = 0x8825;
const TAG_INTEROP = 0xa005;
const POINTER_ROLE: Record<number, Role> = { [TAG_SUBIFDS]: 'image', [TAG_EXIF]: 'exif', [TAG_GPS]: 'gps', [TAG_INTEROP]: 'interop' };
const TAG_XMP = 0x02bc;
const TAG_IPTC = 0x83bb;
const TAG_IRB = 0x8649;
const TAG_ICC = 0x8773;
const TAG_UNIQUE_CAMERA = 0xc614;
const ICC_TAGS = new Set([0xc68f, 0xc691]);
/** Old-style JPEG table offsets (TIFF 6.0 §22): pointers into the file that the rebuild does not relocate. */
const OLD_JPEG_TABLES = [0x0207, 0x0208, 0x0209];
/** Compression values of TIFF 6.0, Adobe, libtiff and DNG; anything else is a camera maker's own (vendor RAW). */
const STANDARD_COMPRESSION = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 32773, 32946, 34712, 34887, 34892, 34925, 34926, 34927, 50000, 50001, 50002, 52546]);
const JPEG_COMPRESSION = new Set([6, 7, 34892]);
const JXL_COMPRESSION = 52546;
const VENDOR_MAKES: [RegExp, string][] = [
  [/nikon/i, 'Nikon'], [/sony/i, 'Sony'], [/canon/i, 'Canon'], [/olympus|om digital/i, 'Olympus'], [/panasonic|leica/i, 'Panasonic/Leica'],
  [/pentax|ricoh/i, 'Pentax'], [/samsung/i, 'Samsung'], [/fujifilm/i, 'Fujifilm'], [/hasselblad/i, 'Hasselblad'], [/phase one/i, 'Phase One'],
  [/kodak/i, 'Kodak'], [/sigma/i, 'Sigma'], [/minolta|konica/i, 'Minolta'],
];

const ROLE_IFD: Record<Role, IfdName> = { image: 'IFD0', exif: 'ExifIFD', gps: 'GPS', interop: 'Interop', private: 'IFD0' };

export class UnsupportedTiffError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UnsupportedTiffError';
  }
}

function numbers(b: Uint8Array, type: number, count: number, en: Endian): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (type === 3) out.push(u16(b, i * 2, en));
    else if (type === 4 || type === 13) out.push(u32(b, i * 4, en));
    else if (type === 1) out.push(b[i]);
    else return out;
  }
  return out;
}

const hex = (t: number) => `0x${t.toString(16).padStart(4, '0')}`;

/** How far into an embedded JPEG stream the header segments are read: 4 KB first, then up to 64 KB when they go on. */
const JPEG_HEAD_FIRST = 4 * 1024;
const JPEG_HEAD_LIMIT = 64 * 1024;

/**
 * Scans the header segments of an embedded JPEG stream (a preview strip, a tile, JPEGTables): 'meta' when it carries its own
 * metadata segments (Exif, XMP, IPTC, comments, MPF, JFIF thumbnails: review N8), 'none' when the scan (or the end) starts
 * without any, 'unknown' when the bytes ran out first.
 */
function jpegScan(head: Uint8Array): 'meta' | 'none' | 'unknown' {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return 'none';
  let p = 2;
  while (p + 4 <= head.length) {
    if (head[p] !== 0xff) return 'none';
    const m = head[p + 1];
    if (m === 0xd8 || m === 0x01 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) {
      p += m === 0xff ? 1 : 2;
      continue;
    }
    if (m === 0xda || m === 0xd9) return 'none';
    const len = (head[p + 2] << 8) | head[p + 3];
    if (m === 0xe0) {
      // JFIF APP0 is 16 bytes without a thumbnail; a thumbnail, JFXX or any other APP0 is metadata (N8).
      if (!(len === 16 && ascii(head, p + 4, 5) === 'JFIF\0')) return 'meta';
    } else if (m === 0xfe || (m >= 0xe1 && m <= 0xef && m !== 0xee)) {
      if (m !== 0xe2 || ascii(head, p + 4, 12) !== 'ICC_PROFILE\0') return 'meta';
    }
    p += 2 + len;
  }
  return 'unknown';
}

/** True when a JPEG part may carry metadata (review S3: every part is checked, header segments only, bounded). */
function jpegPartHasMetadata(f: ByteFile, r: Range): boolean {
  let n = Math.min(r.length, JPEG_HEAD_FIRST);
  let res = jpegScan(f.read(r.offset, n));
  if (res === 'unknown' && r.length > n) {
    n = Math.min(r.length, JPEG_HEAD_LIMIT);
    res = jpegScan(f.read(r.offset, n));
  }
  // Ran out of bytes: a stream that ends there without a scan holds nothing else; a longer one cannot be told.
  return res === 'meta' || (res === 'unknown' && r.length > n);
}

/** True when a JPEG XL preview (DNG 1.7, compression 52546) is an ISO container with anything beyond the codestream (S3). */
function jxlHasMetadata(f: ByteFile, r: Range): boolean {
  const head = f.read(r.offset, Math.min(r.length, 12));
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0x0a) return false; // bare codestream: no boxes
  if (!(head.length === 12 && u32(head, 0) === 12 && ascii(head, 4, 4) === 'JXL ')) return true;
  const allowed = new Set(['JXL ', 'ftyp', 'jxll', 'jxlc', 'jxlp', 'jxli']);
  let p = r.offset;
  const end = r.offset + r.length;
  for (let n = 0; p + 8 <= end && n < 4096; n++) {
    const h = f.read(p, 16);
    let size = u32(h, 0);
    if (size === 1 && h.length >= 16) size = u32(h, 8) * 0x100000000 + u32(h, 12);
    else if (size === 0) size = end - p;
    if (!allowed.has(ascii(h, 4, 4))) return true;
    if (size < 8 || p + size > end) return true;
    p += size;
  }
  return p !== end;
}

/** Ascending by offset, then length (both the original and the copy list their picture parts in this order). */
const byPosition = (a: Range, b: Range) => a.offset - b.offset || a.length - b.length;

export function inspectTiffFile(f: ByteFile): TiffFileModel {
  const h = readExact(f, 0, 8);
  const endian: Endian | null = h[0] === 0x49 && h[1] === 0x49 ? 'LE' : h[0] === 0x4d && h[1] === 0x4d ? 'BE' : null;
  if (!endian) throw new CorruptError('not a TIFF file');
  const magic = u16(h, 2, endian);
  let vendor: string | undefined;
  if (magic === 0x4f52 || magic === 0x5352) vendor = 'Olympus';
  else if (magic === 0x0055) vendor = 'Panasonic';
  else if (magic !== 42) throw new CorruptError('not a TIFF file');
  if (magic === 42 && f.size >= 10) {
    const c = f.read(8, 2);
    if (c[0] === 0x43 && c[1] === 0x52) vendor = 'Canon';
  }

  const ifds: TIfd[] = [];
  const byOffset = new Map<number, TIfd>();
  /** Directories whose walk has started but not finished: reaching one again is a loop. */
  const open = new Set<number>();
  const uses = new Map<TEntry, Use>();
  const read = (e: TEntry): Uint8Array | null => (e.inline ? e.bytes.subarray(8, 8 + e.size) : e.size <= MAX_META ? readExact(f, e.valueAt, e.size) : null);
  const nums = (e: TEntry | undefined): number[] => {
    if (!e) return [];
    if (e.size > MAX_READ_BYTES) throw new UnsupportedTiffError('This TIFF file has too many picture parts');
    return numbers(read(e)!, e.type, e.count, endian);
  };
  const unreadableField = (what: string, why: string) =>
    makeField('tiff', `Unreadable:${what}`, { name: 'Part of the file that could not be read', group: 'other', sensitivity: 'medium', known: false }, why);
  const unreadable: Field[] = [];

  const readIfd = (offset: number, role: Role, name: string, standard: boolean): TIfd => {
    if (offset < 8 || offset + 2 > f.size) throw new CorruptError(`${name}: directory outside the file`);
    if (ifds.length >= MAX_IFDS) throw new UnsupportedTiffError('This TIFF file has too many parts');
    const n = u16(readExact(f, offset, 2), 0, endian);
    if (n === 0 || n > MAX_ENTRIES) throw new CorruptError(`${name}: ${n} entries`);
    const table = readExact(f, offset + 2, n * 12 + 4);
    const entries: TEntry[] = [];
    for (let i = 0; i < n; i++) {
      const bytes = table.slice(i * 12, i * 12 + 12);
      const tag = u16(bytes, 0, endian);
      const type = u16(bytes, 2, endian);
      const count = u32(bytes, 4, endian);
      const validType = TYPE_SIZE[type] !== undefined;
      const size = validType ? TYPE_SIZE[type] * count : 0;
      const inline = size <= 4;
      const valueAt = inline ? offset + 2 + i * 12 + 8 : u32(bytes, 8, endian);
      if (!inline && (valueAt < 8 || valueAt + size > f.size)) throw new CorruptError(`${name}: value of tag ${hex(tag)} outside the file`);
      entries.push({ tag, type, count, size, bytes, valueAt, inline, validType });
    }
    // Review S2: readers disagree on which of two equal picture tags counts, so a duplicate makes the file unreadable.
    if (standard) {
      const seen = new Set<number>();
      for (const e of entries) {
        if (seen.has(e.tag) && (TIFF_DECODE_TAGS.has(e.tag) || POINTER_ROLE[e.tag] || e.tag === TAG_UNIQUE_CAMERA)) throw new CorruptError(`${name}: tag ${hex(e.tag)} twice`);
        seen.add(e.tag);
      }
    }
    const ifd: TIfd = { name, role, offset, entries, next: u32(table, n * 12, endian), standard };
    ifds.push(ifd);
    return ifd;
  };

  /**
   * Walks one directory and everything it points at. Pointers are followed in EVERY directory, with the role their tag implies
   * (review M2, like ExifTool): SubIFDs, Exif, GPS, Interop, and any entry of type IFD (13). Only the places TIFF defines are
   * `standard`; the rest is listed but never copied. A directory reached twice is walked once (review N1); only reaching an
   * ancestor again is a loop.
   */
  const visit = (offset: number, role: Role, name: string, standard: boolean, chainLink = false): TIfd => {
    const seen = byOffset.get(offset);
    if (seen) {
      if (chainLink || open.has(offset)) throw new CorruptError(`${name}: loop in the TIFF structure`);
      if (seen.role !== role || seen.standard !== standard) throw new UnsupportedTiffError('One part of this TIFF file is used in two different places');
      return seen;
    }
    const ifd = readIfd(offset, role, name, standard);
    byOffset.set(offset, ifd);
    open.add(offset);
    try {
      for (const e of ifd.entries) {
        const pointerRole = POINTER_ROLE[e.tag] ?? (e.type === 13 ? 'private' : null);
        if (!pointerRole) continue;
        const std = ifd.standard && ((ifd.role === 'image' && (e.tag === TAG_SUBIFDS || e.tag === TAG_EXIF || e.tag === TAG_GPS)) || (ifd.role === 'exif' && e.tag === TAG_INTEROP));
        const childRole: Role = std ? pointerRole : pointerRole === 'image' ? 'private' : pointerRole;
        try {
          if (e.type !== 4 && e.type !== 13) throw new CorruptError(`${ifd.name}: pointer tag ${hex(e.tag)} of type ${e.type}`);
          if (e.count === 0 || e.count > MAX_POINTERS) throw new CorruptError(`${ifd.name}: pointer tag ${hex(e.tag)} with ${e.count} values`);
          const targets = nums(e).map((o, k) => {
            const label = childRole === 'image' ? `${ifd.name}.Sub${k}` : `${ifd.name}/${childRole}${hex(e.tag)}${e.count > 1 ? `.${k}` : ''}`;
            return visit(o, childRole, label, std);
          });
          uses.set(e, { kind: 'pointer', targets, standard: std });
        } catch (err) {
          // A pointer in an unexpected place that leads nowhere: shown as unreadable, and never copied.
          if (std || !(err instanceof CorruptError || err instanceof TruncatedError)) throw err;
          const fld = unreadableField(hex(e.tag), `${ifd.name}: ${(err as Error).message}`);
          unreadable.push(fld);
          uses.set(e, { kind: 'field', fields: [fld] });
        }
      }
    } finally {
      open.delete(offset);
    }
    if (ifd.next) {
      if (role === 'image' && standard) {
        const base = name.replace(/\+\d+$/, '');
        const k = Number(/\+(\d+)$/.exec(name)?.[1] ?? 0) + 1;
        ifd.chainNext = visit(ifd.next, 'image', `${base}+${k}`, true, true);
      } else {
        // An Exif/GPS/private directory has no `next` in TIFF; walk it anyway so its contents are listed (review P8).
        try {
          visit(ifd.next, role === 'image' ? 'private' : role, `${name}+`, false, true);
        } catch (err) {
          if (!(err instanceof CorruptError || err instanceof TruncatedError)) throw err;
          unreadable.push(unreadableField(`${name}+`, `${name}: ${(err as Error).message}`));
        }
      }
    }
    return ifd;
  };
  const ifd0 = visit(u32(h, 4, endian), 'image', 'IFD0', true);
  const pictures = ifds.filter((x) => x.role === 'image' && x.standard);

  const find = (ifd: TIfd, tag: number) => ifd.entries.find((e) => e.tag === tag);
  const isDng = !!find(ifd0, 0xc612);
  // Vendor RAW: a maker's magic number, Bayer/linear raw data outside DNG, or a maker's own compression.
  for (const ifd of pictures) {
    const comp = nums(find(ifd, 0x103))[0] ?? 1;
    const photometric = nums(find(ifd, 0x106))[0];
    if (!isDng && (photometric === 32803 || photometric === 34892 || !STANDARD_COMPRESSION.has(comp))) vendor ??= 'camera';
  }
  const kind: TiffKind = vendor ? 'raw' : isDng ? 'dng' : 'tiff';
  if (vendor === 'camera') {
    const makeEntry = find(ifd0, 0x10f);
    const make = makeEntry ? read(makeEntry) : null;
    const s = make ? utf8(make) : '';
    vendor = VENDOR_MAKES.find(([re]) => re.test(s))?.[1] ?? 'camera';
  }
  const cleanable = kind !== 'raw';
  const sigOf = (tag: number) => {
    const e = find(ifd0, tag);
    return e && e.validType && e.size <= MAX_META ? ascii(read(e)!).replace(/\0[\s\S]*$/, '') : '';
  };
  // DNG 1.7 (CameraCalibrationSignature): the camera calibration matrices are used only when it equals the profile's
  // ProfileCalibrationSignature.
  const calibrationApplies = sigOf(0xc6f3) === sigOf(0xc6f4);

  // The decode tags of every picture directory (strict form check, review M1/N2; camera RAW is only shown, so it is lenient).
  for (const ifd of pictures) {
    for (const e of ifd.entries) {
      if (uses.has(e)) continue;
      const rule = TIFF_DECODE_TAGS.get(e.tag);
      if (rule) {
        const [name, types, max] = rule;
        const ok = e.validType && types.includes(e.type) && e.count > 0 && e.count <= max && (!ICC_TAGS.has(e.tag) || (e.size <= MAX_META && isIccProfile(read(e)!)));
        if (ok) {
          uses.set(e, { kind: 'decode' });
          continue;
        }
        if (cleanable) throw new CorruptError(`${ifd.name}: picture tag ${name} has an unexpected form`);
      }
      if (cleanable && OLD_JPEG_TABLES.includes(e.tag)) throw new UnsupportedTiffError('TIFF files with old-style JPEG tables are not supported yet');
      if (e.tag === TAG_UNIQUE_CAMERA && ifd === ifd0 && isDng && e.type === 2 && read(e) && utf8(read(e)!).replace(/\0+$/, '') === NEUTRAL_CAMERA) uses.set(e, { kind: 'neutral-camera' });
    }
  }

  // Picture data of every picture directory (strips, tiles, old-style JPEG) and its size.
  const dataRanges: Range[] = [];
  const pictureParts = new Map<TEntry, (Range | null)[]>();
  const opaque: string[] = [];
  const structureProblems: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let mainArea = -1;
  const kinds = new Map<string, number>();
  let mainSeen = false;
  const signature: string[] = [];
  const crcOf = (e: TEntry): string => {
    if (e.inline) return crc32Done(crc32Add(CRC32_START, e.bytes.subarray(8, 8 + e.size))).toString(16);
    let c = CRC32_START;
    for (let done = 0; done < e.size; ) {
      const n = Math.min(MAX_READ_BYTES, e.size - done);
      c = crc32Add(c, readExact(f, e.valueAt + done, n));
      done += n;
    }
    return crc32Done(c).toString(16);
  };
  const flag = (what: string) => {
    if (!opaque.includes(what)) opaque.push(what);
  };
  for (const ifd of pictures) {
    const ranges: Range[] = [];
    for (const [oTag, lTag] of PICTURE_PAIRS) {
      const oe = find(ifd, oTag);
      const le = find(ifd, lTag);
      if (!oe && !le) continue;
      if (!oe || !le || (oe.type !== 3 && oe.type !== 4) || (le.type !== 3 && le.type !== 4)) throw new CorruptError(`${ifd.name}: picture offsets of an unexpected form`);
      const offs = nums(oe);
      const lens = nums(le);
      if (offs.length !== lens.length) throw new CorruptError(`${ifd.name}: picture offsets and sizes do not match`);
      const parts: (Range | null)[] = [];
      offs.forEach((o, i) => {
        if (lens[i] === 0) {
          parts.push(null);
          return;
        }
        if (o < 8 || o + lens[i] > f.size) throw new CorruptError(`${ifd.name}: picture data outside the file`);
        const r = { offset: o, length: lens[i] };
        ranges.push(r);
        parts.push(r);
      });
      pictureParts.set(oe, parts);
    }
    if (!ranges.length) throw new CorruptError(`${ifd.name}: a picture without picture data`);
    dataRanges.push(...ranges);
    const comp = nums(find(ifd, 0x103))[0] ?? 1;
    // Review S3: every JPEG part (header segments only, bounded) and every JPEG XL container, wherever it is.
    const jpegParts = [...(JPEG_COMPRESSION.has(comp) ? ranges : []), ...(find(ifd, 0x201) ? (pictureParts.get(find(ifd, 0x201)!) ?? []).filter((r): r is Range => !!r) : [])];
    if (jpegParts.some((r) => jpegPartHasMetadata(f, r))) flag('metadata inside an embedded preview picture');
    const tables = find(ifd, 0x015b);
    if (tables && uses.get(tables)?.kind === 'decode' && (tables.size > MAX_META || jpegScan(read(tables)!) === 'meta')) flag('metadata inside an embedded preview picture');
    if (comp === JXL_COMPRESSION && ranges.some((r) => jxlHasMetadata(f, r))) flag('metadata inside an embedded preview picture');
    const w = nums(find(ifd, 0x100))[0];
    const hh = nums(find(ifd, 0x101))[0];
    const sub = nums(find(ifd, 0xfe))[0] ?? 0;
    if (w && hh && (sub & 1) === 0 && w * hh > mainArea) {
      mainArea = w * hh;
      width = w;
      height = hh;
    }
    // The other pictures, listed so the result says they were kept (like HEIC previews, S9).
    const label = sub & 4 ? 'mask' : sub & 1 ? 'preview' : mainSeen ? 'page' : null;
    if (label) kinds.set(label, (kinds.get(label) ?? 0) + 1);
    else mainSeen = true;
    // What the lossless check compares besides the bytes (review S1c): every decode tag but the offsets, and the part sizes.
    if (cleanable) {
      const dec = ifd.entries.filter((e) => uses.get(e)?.kind === 'decode' && !OFFSET_TAGS.has(e.tag) && (calibrationApplies || !CALIBRATION_TAGS.has(e.tag))).sort((a, b) => a.tag - b.tag);
      signature.push(`${ifd.name}|${dec.map((e) => `${e.tag}:${e.type}:${e.count}:${crcOf(e)}`).join(',')}|${ranges.map((r) => r.length).join(',')}`);
    }
  }
  if (kind === 'raw') opaque.push(`camera maker data (${vendor} RAW files are read, not cleaned)`);
  if (kind === 'dng' && find(ifd0, TAG_UNIQUE_CAMERA)?.type !== 2) structureProblems.push('DNG copy without its required camera model tag');

  // Fields.
  const fields: Field[] = [];
  const containers: Container[] = [];
  const pseudo: TiffEntry[] = [];
  const pseudoOf = new Map<TEntry, TiffEntry>();
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      if (uses.has(e)) continue;
      const raw = e.validType ? (read(e) ?? new Uint8Array(0)) : new Uint8Array(0);
      const te: TiffEntry = { ifd: ROLE_IFD[ifd.role], tag: e.tag, type: e.type, count: e.count, raw };
      pseudo.push(te);
      pseudoOf.set(e, te);
    }
  }
  const fieldOf = fieldsOfTiff({ endian, entries: pseudo, errors: [] });
  const meta = (ifd: TIfd) => ifd.standard && ifd.role === 'image';
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      const te = pseudoOf.get(e);
      if (!te) continue;
      const big = !e.inline && e.size > MAX_META;
      let u: Use;
      if (!e.validType) {
        // Review N2: a value of a type classic TIFF does not have cannot be read (and is never copied).
        u = { kind: 'field', fields: [{ ...fieldOf(te), value: `unreadable value (type ${e.type})`, needles: [], known: false }] };
      } else if (meta(ifd) && e.tag === TAG_ICC) {
        u = { kind: 'field', fields: [big ? makeField('icc', 'ICC_Profile', { name: 'Colour profile', group: 'technical', sensitivity: 'none', known: true }, `${e.size} bytes`) : iccField(te.raw)] };
      } else if (meta(ifd) && e.tag === TAG_XMP && !big && [1, 2, 7].includes(e.type)) {
        const x = parseXmp(utf8(te.raw));
        containers.push({ kind: 'xmp', offset: e.valueAt, length: e.size });
        const bad = x.ok ? [] : [makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${e.size} bytes`)];
        u = { kind: 'xmp', props: x.ok ? x.props : [], fields: [...(x.ok ? xmpFields(x) : []), ...bad] };
      } else if (meta(ifd) && e.tag === TAG_IPTC && !big && [1, 4, 7].includes(e.type)) {
        const ds = parseIptc(te.raw);
        containers.push({ kind: 'iptc', offset: e.valueAt, length: e.size });
        u = { kind: 'iptc', ds, fields: ds.length ? iptcFields(ds) : [makeField('iptc', 'Unreadable', { name: 'Unreadable IPTC block', group: 'other', sensitivity: 'medium', known: false }, `${e.size} bytes`)] };
      } else if (meta(ifd) && e.tag === TAG_IRB && !big && [1, 7].includes(e.type)) {
        const blocks = parseIrb(te.raw);
        containers.push({ kind: 'iptc', offset: e.valueAt, length: e.size });
        u = { kind: 'irb', blocks, fields: blocks.length ? irbFields(blocks) : [fieldOf(te)] };
      } else {
        let f0 = fieldOf(te);
        // Review N3: a camera model stored as bytes is still a name.
        if (e.tag === TAG_UNIQUE_CAMERA && (e.type === 1 || e.type === 7) && !big) {
          const s = utf8(te.raw).replace(/\0[\s\S]*$/, '').trim();
          f0 = { ...f0, value: s, needles: s.length >= 3 ? [s] : [] };
        }
        // Binary blobs (maker data, private DNG data, IDs stored as bytes) show their size, not a list of numbers.
        const blob = big || ((e.type === 1 || e.type === 7) && e.size > 8 && !/[A-Za-z]{3}/.test(f0.value));
        const fld = blob ? { ...f0, value: `${e.size} bytes`, needles: big ? [] : f0.needles } : f0;
        u = { kind: meta(ifd) && ifd === ifd0 && e.tag === TAG_UNIQUE_CAMERA && isDng ? 'camera-name' : 'field', fields: [fld] };
      }
      // A field in a place TIFF does not define (review M2) is shown but cannot be kept: it is not part of the rebuilt file.
      if (!ifd.standard && 'fields' in u) u = { ...u, fields: u.fields.map((x) => ({ ...x, known: false })) } as Use;
      uses.set(e, u);
    }
  }
  for (const ifd of ifds) for (const e of ifd.entries) {
    const u = uses.get(e)!;
    if ('fields' in u && !unreadable.includes(u.fields[0])) fields.push(...u.fields);
  }
  fields.push(...unreadable);
  const NAMES: Record<string, string> = { preview: 'Preview image', page: 'Additional page', mask: 'Transparency mask' };
  const imageFields = [...kinds].map(([k, n]) =>
    makeField('tiff', `Image:${k}`, { name: NAMES[k], group: 'technical', sensitivity: 'none', known: true }, n === 1 ? 'kept unchanged' : `${n} pictures, kept unchanged`),
  );
  fields.push(...imageFields);

  // Review S5: a value or directory stored inside the picture data (or inside a decode table, which is always copied) goes
  // into the copy with those bytes. Whatever removes it cannot be proven gone: verify says "Could not check".
  const alwaysCopied: Range[] = [...dataRanges];
  for (const ifd of pictures) for (const e of ifd.entries) if (uses.get(e)?.kind === 'decode' && !e.inline) alwaysCopied.push({ offset: e.valueAt, length: e.size });
  const overlapsCopied = (r: Range) => r.length > 0 && alwaysCopied.some((p) => r.offset < p.offset + p.length && p.offset < r.offset + r.length);
  const insidePicture: Field[] = [];
  for (const ifd of ifds) {
    const tableIn = overlapsCopied({ offset: ifd.offset, length: 2 + 12 * ifd.entries.length + 4 });
    for (const e of ifd.entries) {
      const u = uses.get(e)!;
      if (!('fields' in u)) continue;
      if (tableIn || (!e.inline && overlapsCopied({ offset: e.valueAt, length: e.size }))) insidePicture.push(...u.fields);
    }
  }

  // Every byte the structure accounts for (verify: nothing else may be in a copy, review M3).
  const coverage: Range[] = [{ offset: 0, length: 8 }, ...dataRanges];
  for (const ifd of ifds) {
    coverage.push({ offset: ifd.offset, length: 2 + 12 * ifd.entries.length + 4 });
    for (const e of ifd.entries) if (!e.inline && e.size > 0) coverage.push({ offset: e.valueAt, length: e.size });
  }

  dataRanges.sort(byPosition);
  const notes = kind === 'raw' ? [`${vendor} RAW`] : kind === 'dng' ? ['DNG'] : [];
  return {
    kind,
    endian,
    ifds,
    uses,
    pictureParts,
    imageFields,
    vendor,
    calibrationApplies,
    report: {
      fields,
      containers,
      dataRanges,
      scanRanges: outside(f.size, dataRanges),
      width,
      height,
      notes,
      opaque,
      coverage,
      insidePicture,
      pictureSignature: signature.sort().join('\n'),
      structureProblems,
    },
  };
}

/** Message for a camera RAW that is inspected but not cleaned. */
export function rawNotCleanable(m: TiffFileModel): string {
  return `${m.vendor && m.vendor !== 'camera' ? `${m.vendor} ` : ''}camera RAW files can be inspected but not cleaned yet`;
}

/** A value of the rebuilt file. */
type Val =
  | { kind: 'bytes'; bytes: Uint8Array }
  /** Copied from the source as it is (out-of-line values; streamed). */
  | { kind: 'copy'; from: number; length: number }
  /** Picture-data offsets, rewritten to the copy's positions (written as LONG). */
  | { kind: 'reloc'; parts: (Range | null)[] }
  /** Directory pointers (written as LONG/IFD). */
  | { kind: 'dirs'; dirs: OutDir[] };
interface OutEntry {
  tag: number;
  type: number;
  count: number;
  val: Val;
  /** Where the value goes in the copy when it does not fit in the entry. */
  at?: number;
}
interface OutDir {
  src: TIfd;
  entries: OutEntry[];
  next: OutDir | null;
  at: number;
}

const valueSize = (e: OutEntry) => TYPE_SIZE[e.type] * e.count;
const align = (n: number, a: number) => n + ((a - (n % a)) % a);

/**
 * Writes a fresh copy of `src` into the empty `dst`: only the allow-listed structures (see the file comment). Returns the
 * fields that remain.
 */
export function cleanTiffFile(src: ByteFile, model: TiffFileModel, dst: ByteFile, keep: (f: Field) => boolean): { kept: Field[]; notes: string[] } {
  if (model.kind === 'raw') throw new UnsupportedTiffError(rawNotCleanable(model));
  if (dst.size !== 0) throw new Error('destination must be empty');
  const en = model.endian;
  const notes: string[] = [];
  const kept: Field[] = [...model.imageFields.filter((f) => keep(f))];
  const ifd0 = model.ifds[0];
  const raw = (e: TEntry): OutEntry => ({
    tag: e.tag,
    type: e.type,
    count: e.count,
    val: e.inline ? { kind: 'bytes', bytes: e.bytes.slice(8, 8 + e.size) } : { kind: 'copy', from: e.valueAt, length: e.size },
  });
  const bytesEntry = (tag: number, type: number, b: Uint8Array): OutEntry => ({ tag, type, count: b.length / TYPE_SIZE[type], val: { kind: 'bytes', bytes: b } });
  const neutral = () => bytesEntry(TAG_UNIQUE_CAMERA, 2, utf8Bytes(`${NEUTRAL_CAMERA}\0`));
  // DNG applies the camera calibration matrices only when both calibration names match. When the profile removes the names,
  // the copy's (absent) names always match, so matrices DNG did not apply in the original are dropped (the picture renders
  // as before); in every other case they stay.
  const nameKept = (tag: number) => {
    const e = ifd0.entries.find((x) => x.tag === tag);
    const u = e && model.uses.get(e);
    return !!u && u.kind === 'field' && u.fields.every((x) => keep(x));
  };
  const sigText = (tag: number) => {
    const e = ifd0.entries.find((x) => x.tag === tag);
    if (!e || !e.validType || !nameKept(tag)) return '';
    return ascii(e.inline ? e.bytes.subarray(8, 8 + e.size) : readExact(src, e.valueAt, Math.min(e.size, 4096))).replace(/\0[\s\S]*$/, '');
  };
  const calibrationApplies = model.calibrationApplies || sigText(0xc6f3) !== sigText(0xc6f4);

  const built = new Map<TIfd, OutDir | null>();
  const build = (ifd: TIfd): OutDir | null => {
    if (built.has(ifd)) return built.get(ifd) ?? null;
    built.set(ifd, null);
    const cands: { e: OutEntry; fields: Field[] }[] = [];
    for (const e of ifd.entries) {
      const u = model.uses.get(e)!;
      switch (u.kind) {
        case 'decode':
          if (OFFSET_TAGS.has(e.tag)) cands.push({ e: { tag: e.tag, type: 4, count: e.count, val: { kind: 'reloc', parts: model.pictureParts.get(e)! } }, fields: [] });
          else if (!CALIBRATION_TAGS.has(e.tag) || calibrationApplies) cands.push({ e: raw(e), fields: [] });
          break;
        case 'neutral-camera':
          cands.push({ e: neutral(), fields: [] });
          break;
        case 'pointer': {
          if (!u.standard) break;
          const kids = u.targets.map(build);
          if (kids.length && kids.every((k) => k)) cands.push({ e: { tag: e.tag, type: e.type, count: kids.length, val: { kind: 'dirs', dirs: kids as OutDir[] } }, fields: [] });
          else if (u.targets.some((t) => t.role === 'image')) throw new Error('picture directory not rebuilt');
          break;
        }
        case 'field':
          if (e.validType && e.size > 0 && u.fields.every((x) => keep(x))) cands.push({ e: raw(e), fields: u.fields });
          break;
        case 'camera-name':
          // Review S8: always a valid ASCII value (a model stored as bytes is written as text when kept).
          if (!keep(u.fields[0])) cands.push({ e: neutral(), fields: [] });
          else cands.push({ e: e.type === 2 ? raw(e) : bytesEntry(TAG_UNIQUE_CAMERA, 2, utf8Bytes(`${u.fields[0].value}\0`)), fields: u.fields });
          break;
        case 'xmp': {
          const r = rebuildXmp(u.props, keep);
          if (r.packet) cands.push({ e: bytesEntry(e.tag, e.type === 7 ? 7 : 1, utf8Bytes(r.packet)), fields: r.kept });
          break;
        }
        case 'iptc': {
          const ds: IptcDataset[] = [];
          const ks: Field[] = [];
          u.ds.forEach((d, i) => {
            if (keep(u.fields[i])) {
              ds.push(d);
              ks.push(u.fields[i]);
            }
          });
          if (ks.some((x) => x.group !== 'technical')) {
            let b = writeIptc(ds);
            if (e.type === 4 && b.length % 4) b = Uint8Array.from([...b, ...new Uint8Array(4 - (b.length % 4))]);
            cands.push({ e: bytesEntry(e.tag, e.type, b), fields: ks });
          }
          break;
        }
        case 'irb': {
          const r = rebuildIrb(u.blocks, keep);
          if (r.bytes) cands.push({ e: bytesEntry(e.tag, e.type, r.bytes.slice(PHOTOSHOP_ID.length)), fields: r.kept });
          break;
        }
      }
    }
    // One entry per tag (the first), ascending by tag (TIFF 6.0 §2).
    cands.sort((a, b) => a.e.tag - b.e.tag);
    const chosen = cands.filter((c, i) => i === 0 || cands[i - 1].e.tag !== c.e.tag);
    if (model.kind === 'dng' && ifd === ifd0 && !chosen.some((c) => c.e.tag === TAG_UNIQUE_CAMERA)) {
      chosen.push({ e: neutral(), fields: [] });
      chosen.sort((a, b) => a.e.tag - b.e.tag);
    }
    if (ifd.role !== 'image' && !chosen.length) return null;
    for (const c of chosen) kept.push(...c.fields);
    const out: OutDir = { src: ifd, entries: chosen.map((c) => c.e), next: null, at: 0 };
    built.set(ifd, out);
    if (ifd.chainNext) out.next = build(ifd.chainNext);
    return out;
  };
  const root = build(ifd0)!;

  // Layout: header, every directory followed by its values (word aligned, TIFF 6.0 §2), then the picture data.
  const dirs: OutDir[] = [];
  const placed = new Set<OutDir>();
  const order = (d: OutDir) => {
    if (placed.has(d)) return;
    placed.add(d);
    dirs.push(d);
    for (const e of d.entries) if (e.val.kind === 'dirs') e.val.dirs.forEach(order);
    if (d.next) order(d.next);
  };
  order(root);
  let pos = 8;
  for (const d of dirs) {
    pos = align(pos, 2);
    d.at = pos;
    pos += 2 + 12 * d.entries.length + 4;
    for (const e of d.entries) {
      if (valueSize(e) <= 4) continue;
      pos = align(pos, 2);
      e.at = pos;
      pos += valueSize(e);
    }
  }
  // Picture parts that overlap or touch are copied once, as one span.
  const spans: { offset: number; length: number; at: number }[] = [];
  for (const r of [...model.report.dataRanges].sort(byPosition)) {
    const last = spans[spans.length - 1];
    if (last && r.offset <= last.offset + last.length) last.length = Math.max(last.length, r.offset + r.length - last.offset);
    else spans.push({ ...r, at: 0 });
  }
  for (const s of spans) {
    pos = align(pos, 4);
    s.at = pos;
    pos += s.length;
  }
  const relocate = (r: Range | null): number => {
    if (!r) return 0;
    let lo = 0;
    let hi = spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (spans[mid].offset <= r.offset) lo = mid;
      else hi = mid - 1;
    }
    return spans[lo].at + (r.offset - spans[lo].offset);
  };

  const w = new SeqWriter(dst);
  const padTo = (p: number) => {
    if (p > w.pos) w.write(new Uint8Array(p - w.pos));
  };
  const head = new Uint8Array(8);
  head.set(en === 'LE' ? [0x49, 0x49] : [0x4d, 0x4d]);
  put16(head, 2, 42, en);
  put32(head, 4, root.at, en);
  w.write(head);
  const longs = (vals: number[]) => {
    const b = new Uint8Array(4 * vals.length);
    vals.forEach((v, i) => put32(b, 4 * i, v, en));
    return b;
  };
  const valueBytes = (e: OutEntry): Uint8Array | null => {
    switch (e.val.kind) {
      case 'bytes':
        return e.val.bytes;
      case 'reloc':
        return longs(e.val.parts.map(relocate));
      case 'dirs':
        return longs(e.val.dirs.map((d) => d.at));
      case 'copy':
        return null;
    }
  };
  for (const d of dirs) {
    padTo(d.at);
    const table = new Uint8Array(2 + 12 * d.entries.length + 4);
    put16(table, 0, d.entries.length, en);
    d.entries.forEach((e, i) => {
      const o = 2 + 12 * i;
      put16(table, o, e.tag, en);
      put16(table, o + 2, e.type, en);
      put32(table, o + 4, e.count, en);
      if (e.at !== undefined) put32(table, o + 8, e.at, en);
      else table.set(valueBytes(e) ?? new Uint8Array(0), o + 8);
    });
    put32(table, 2 + 12 * d.entries.length, d.next ? d.next.at : 0, en);
    w.write(table);
    for (const e of d.entries) {
      if (e.at === undefined) continue;
      padTo(e.at);
      const b = valueBytes(e);
      if (b) w.write(b);
      else if (e.val.kind === 'copy') w.copy(src, e.val.from, e.val.length);
    }
  }
  for (const s of spans) {
    padTo(s.at);
    w.copy(src, s.offset, s.length);
  }
  return { kept, notes };
}
