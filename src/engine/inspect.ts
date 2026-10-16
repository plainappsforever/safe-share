/** ByteFile -> MetadataReport (SPEC F2): what the file contains, in catalogue terms. */
import type { ByteFile } from './byte-file';
import { summarize, type Field, type Finding } from './catalog';
import { inspectHeif, UnsupportedHeifError, type HeifModel } from './heif';
import { TruncatedError, type Range } from './io';
import { inspectGif, type GifModel } from './gif';
import { CorruptError, inspectJpeg, type JpegModel } from './jpeg';
import { inspectMp4, UnsupportedVideoError, type Mp4Model } from './mp4';
import { inspectPdf, UnsupportedPdfError, type PdfModel } from './pdf';
import { inspectPng, type PngModel } from './png';
import { sniff, type Format } from './sniff';
import { inspectTiffFile, rawNotCleanable, UnsupportedTiffError, type TiffFileModel } from './tiff-file';
import { inspectWebp, type WebpModel } from './webp';

/** A metadata block the parser understood (the signature scan accepts markers only inside these). */
export interface Container {
  kind: 'exif' | 'xmp' | 'iptc' | 'mpf' | 'png-text' | 'trailer';
  offset: number;
  length: number;
}

export interface FormatReport {
  fields: Field[];
  containers: Container[];
  /** Image data that must stay byte-identical when cleaned (A2). */
  dataRanges: Range[];
  /** Every byte outside the image data (signature scan). */
  scanRanges: Range[];
  width?: number;
  height?: number;
  /** Video duration in seconds. */
  duration?: number;
  /** PDF page count (from the page tree). */
  pages?: number;
  notes: string[];
  /**
   * Cleaned in place on a byte copy (video, PDF): the file keeps its length and every data range
   * keeps its offset, so verify compares the SOURCE's data ranges at the same offsets in the output.
   */
  inPlace?: boolean;
  /** Ranges the cleaner must fill with zeros (video metadata-track samples inside mdat); verify checks them. */
  wipeRanges?: (Range & { fieldId: string })[];
  /** Decoded metadata blocks (inflated PDF XMP / object streams) that the signature scan also searches. */
  derived?: Uint8Array[];
  /** Structures that may hold metadata but could not be decoded: the result can never be "clean". */
  opaque?: string[];
  /** Findings that are not fields (e.g. "Earlier versions of this PDF"). */
  extraFindings?: Finding[];
  /**
   * Set when the file can be inspected but not cleaned (camera RAW from a camera maker, V1.5-1 #9/#10): the reason in
   * plain words. `clean()` refuses such a file and the app never offers to clean it.
   */
  notCleanable?: string;
  /**
   * TIFF/DNG (V1.5-1 fix round): every byte range the parsed structure accounts for (header, directories, values, picture
   * data). verify: in a copy, everything outside these ranges must be alignment padding (zeros, at most 3 bytes per gap).
   */
  coverage?: Range[];
  /** Fields whose stored bytes lie inside the picture data, which is copied as it is: removing them cannot be proven (S5). */
  insidePicture?: Field[];
  /** TIFF/DNG: the decode tags (except offsets) and part sizes of every picture, per directory; must be equal in the copy. */
  pictureSignature?: string;
  /** Structural rules the file breaks (e.g. a DNG without its required camera model); a copy with any of them is not clean. */
  structureProblems?: string[];
}

export type Problem = 'unsupported' | 'corrupt';

export interface MetadataReport extends FormatReport {
  format: Format;
  supported: boolean;
  problem?: Problem;
  /** Why it is unsupported/corrupt, in plain words (engine-level; the UI maps `problem`). */
  detail?: string;
  size: number;
  findings: Finding[];
  /** Hidden extras in plain words (preview images, trailers, maker notes). */
  extras: string[];
}

export type Model =
  | { format: 'jpeg'; model: JpegModel }
  | { format: 'png'; model: PngModel }
  | { format: 'webp'; model: WebpModel }
  | { format: 'heic' | 'avif'; model: HeifModel }
  | { format: 'mp4' | 'mov'; model: Mp4Model }
  | { format: 'pdf'; model: PdfModel }
  | { format: 'tiff' | 'dng' | 'raw'; model: TiffFileModel }
  | { format: 'gif'; model: GifModel };

/**
 * Formats cleaned in place on a byte copy (`CleanOptions.dstIsCopy`). HEIF/AVIF is rebuilt from an allow-list instead (P7.5, B1),
 * and so are TIFF/DNG since the V1.5-1 fix round (D61; camera RAW is refused before anything is written, `notCleanable`).
 */
export const IN_PLACE_FORMATS: Format[] = ['mp4', 'mov', 'pdf'];

const EMPTY: FormatReport = { fields: [], containers: [], dataRanges: [], scanRanges: [], notes: [] };

/** Parses a supported image; throws CorruptError/TruncatedError/UnsupportedHeifError. */
export function model(f: ByteFile, format: Format): Model | null {
  switch (format) {
    case 'jpeg':
      return { format, model: inspectJpeg(f) };
    case 'png':
      return { format, model: inspectPng(f) };
    case 'webp':
      return { format, model: inspectWebp(f) };
    case 'heic':
    case 'avif':
      return { format, model: inspectHeif(f) };
    case 'mp4':
    case 'mov':
      return { format, model: inspectMp4(f) };
    case 'pdf':
      return { format, model: inspectPdf(f) };
    case 'tiff':
    case 'dng':
    case 'raw': {
      const m = inspectTiffFile(f);
      return { format: m.kind, model: m };
    }
    case 'gif':
      return { format, model: inspectGif(f) };
    default:
      return null;
  }
}

export function reportOf(format: Format, size: number, r: FormatReport): MetadataReport {
  let findings = [...summarize(r.fields), ...(r.extraFindings ?? [])];
  if (r.opaque?.length) findings.push({ id: 'opaque', label: 'Parts of this file could not be read', level: 'orange' });
  if (findings.some((x) => x.level !== 'grey')) findings = findings.filter((x) => x.id !== 'none');
  return {
    ...r,
    format,
    size,
    supported: true,
    findings,
    extras: [...new Set(r.fields.filter((x) => x.group === 'extras').map((x) => x.name))],
  };
}

export function inspect(f: ByteFile): MetadataReport {
  const size = f.size;
  let format: Format = 'unknown';
  try {
    format = sniff(f);
    const m = model(f, format);
    if (!m) return { ...EMPTY, format, size, supported: false, problem: 'unsupported', detail: 'Not supported yet', findings: [], extras: [] };
    const r = reportOf(m.format, size, m.model.report);
    return m.format === 'raw' ? { ...r, notCleanable: rawNotCleanable(m.model as TiffFileModel) } : r;
  } catch (e) {
    if (e instanceof CorruptError || e instanceof TruncatedError || e instanceof RangeError)
      return { ...EMPTY, format, size, supported: false, problem: 'corrupt', detail: (e as Error).message, findings: [], extras: [] };
    if (e instanceof UnsupportedHeifError || e instanceof UnsupportedVideoError || e instanceof UnsupportedPdfError || e instanceof UnsupportedTiffError) return { ...EMPTY, format, size, supported: false, problem: 'unsupported', detail: e.message, findings: [], extras: [] };
    throw e;
  }
}
