import { ascii, startsWith, u32 } from './binary';
import type { ByteFile } from './byte-file';

/** `dng` and `raw` are never returned by `sniff` for "II*"/"MM*" files: the TIFF parser tells them apart (inspect.ts). */
export type Format = 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'mp4' | 'mov' | 'pdf' | 'gif' | 'tiff' | 'dng' | 'raw' | 'unknown';

const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'mif2'];
/**
 * N1 (P7.5): only these brands are video. Canon CR3 RAW (`crx `), M4A/M4B audio, JPEG 2000 and anything else in an
 * ISO box file is "not supported yet" instead of going through the video path (D21).
 */
const VIDEO_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71', 'avc1', 'hvc1', 'M4V ', 'M4VH', 'M4VP',
  '3gp4', '3gp5', '3gp6', '3gp7', '3gp8', '3gp9', '3g2a', '3g2b', '3g2c', 'MSNV', 'mmp4', 'dash', 'f4v ', 'XAVC', 'qt  ',
]);
const NOT_VIDEO = new Set(['crx ', 'M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ', 'jp2 ', 'jpx ', 'jpm ']);

/** Detects the format from magic bytes only (never from the file name or MIME type). */
export function sniff(f: ByteFile): Format {
  const h = f.read(0, 64);
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
  if (startsWith(h, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (startsWith(h, 'RIFF') && startsWith(h, 'WEBP', 8)) return 'webp';
  if (startsWith(h, 'GIF87a') || startsWith(h, 'GIF89a')) return 'gif';
  if (startsWith(h, '%PDF-')) return 'pdf';
  if (startsWith(h, 'II*\0') || startsWith(h, 'MM\0*')) return 'tiff';
  // Olympus ORF and Panasonic RW2 are TIFF structures with their own magic number (V1.5-1, #9): camera RAW, read only.
  if (startsWith(h, 'IIRO') || startsWith(h, 'IIRS') || startsWith(h, 'MMOR') || startsWith(h, 'IIU\0')) return 'raw';
  if (h.length >= 16 && ascii(h, 4, 4) === 'ftyp') {
    const size = Math.min(u32(h, 0), h.length);
    const brands = [ascii(h, 8, 4)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(ascii(h, o, 4));
    // AVIF is reported as its own format but cleaned through the HEIF path (P3, D33).
    if (brands[0] === 'avif' || brands[0] === 'avis') return 'avif';
    if (brands.some((b) => HEIF_BRANDS.includes(b)) && !brands.includes('avif')) return 'heic';
    if (brands[0] === 'qt  ') return 'mov';
    if (brands.includes('avif')) return 'avif';
    return !NOT_VIDEO.has(brands[0]) && brands.some((b) => VIDEO_BRANDS.has(b)) ? 'mp4' : 'unknown';
  }
  return 'unknown';
}
