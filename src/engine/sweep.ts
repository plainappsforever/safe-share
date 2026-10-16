/**
 * The separate scan (P7.5, review S2). A reader that shares NO code with the cleaners or with the inspection parser
 * (it imports only the ByteFile interface and types): it does not ask the engine where the metadata or the picture
 * data is, so a structure the engine does not model cannot hide from it the way the review's B1/S1 cases hid from
 * readers 1 and 2. It looks for:
 *  - known metadata signatures anywhere in the file (long byte strings, so compressed picture data does not match by
 *    chance): Motion-Photo / HDR gain-map / Extended-XMP markers, XMP location properties, Apple video location keys,
 *    content credentials (C2PA), Samsung's SEFT trailer;
 *  - its own minimal walk of the outer structure: ISO boxes (HEIC/AVIF/MP4/MOV) must be on an allow-list and any free
 *    space must be zeros; a JPEG must end at its end marker, a PNG at IEND, a WebP at its RIFF size;
 *  - for PDF: page dates (/LastModified, unless dates are kept), /PieceInfo, a non-zero document /ID, and photo
 *    metadata (Exif/XMP/IPTC headers), which no cleaned PDF may contain;
 *  - for TIFF/DNG (V1.5-1): its own walk of the directories (no GPS directory, maker notes, private DNG data, embedded
 *    original RAW, GeoTIFF position, Photoshop layers) and JPEG/PNG metadata headers anywhere (they would sit in a preview);
 *  - for GIF (V1.5-1): its own block walk (no comment unless "Location only", only known application blocks, nothing
 *    after the trailer).
 * For videos it skips the payload of `mdat` (its own walk), which is the picture and sound data; everything else of
 * every file is read. It can only add survivors.
 */
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import type { StepProgress } from './io';
import type { Profile } from './profiles';
import type { Format } from './sniff';

export interface SweepHit {
  id: string;
  name: string;
}

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Never left by any profile. */
const ALWAYS: [name: string, sig: string][] = [
  ['Motion-photo data', 'GCamera:MotionPhoto'],
  ['Motion-photo data', 'GCamera:MicroVideo'],
  ['Motion-photo data', 'Camera:MotionPhoto'],
  ['Motion-photo data', 'MotionPhoto_Data'],
  ['HDR gain-map data', 'hdrgm:Version'],
  ['Extended XMP block', 'http://ns.adobe.com/xmp/extension/'],
  ['Location', 'exif:GPSLatitude'],
  ['Location', 'exif:GPSLongitude'],
  ['Location', 'com.apple.quicktime.location'],
  ['Location', 'Iptc4xmpCore:Location'],
  ['Location', 'Iptc4xmpExt:LocationShown'],
  ['Location', 'Iptc4xmpExt:LocationCreated'],
  ['Location', 'photoshop:City'],
  ['Content credentials (C2PA)', 'c2pa.claim'],
];

/**
 * Only in TIFF/DNG (V1.5-1): these headers belong to JPEG/PNG metadata blocks and never appear in a clean TIFF file; inside a
 * preview strip they are metadata the cleaner cannot remove (it says "Could not check").
 */
const TIFF_ALWAYS: [string, string][] = [
  ['Photo metadata inside a preview picture', 'Exif\0\0'],
  ['Photo metadata inside a preview picture', 'http://ns.adobe.com/xap/1.0/\0'],
  ['Photo metadata inside a preview picture', 'Photoshop 3.0\0'],
];

/** Only in a PDF: a cleaned PDF never contains photo metadata (photos inside it are cleaned too). */
const PDF_ALWAYS: [string, string][] = [
  ['Photo data inside the PDF', 'Exif\0\0'],
  ['Photo data inside the PDF', 'http://ns.adobe.com/xap/1.0/\0'],
  ['Photo data inside the PDF', 'Photoshop 3.0\0'],
  ['Private data of the editing app', '/PieceInfo'],
];

const ISO_TOP: Partial<Record<Format, string[]>> = {
  heic: ['ftyp', 'meta', 'mdat', 'free', 'skip'],
  avif: ['ftyp', 'meta', 'mdat', 'free', 'skip'],
  mp4: ['ftyp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', 'styp', 'pdin', 'prft', 'emsg', 'ssix', 'pnot', 'free', 'skip', 'wide', 'uuid'],
  mov: ['ftyp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', 'styp', 'pdin', 'prft', 'emsg', 'ssix', 'pnot', 'free', 'skip', 'wide', 'uuid'],
};
/**
 * uuid boxes allowed at the top: the ones needed for playback (PIFF/CENC), and XMP (kept by "Location only"; its text is
 * covered by the signature search). Anything else in a uuid box is unknown data.
 */
const ALLOWED_UUIDS = ['a2394f525a9b4f14a2446c427c648df4', 'd08a4f1810f34a82b6c832d8aba183d3', '8974dbce7be74c5184f97148f9882554', 'be7acfcb97a942e89c71999491e3afac'];
const FREE = ['free', 'skip', 'wide'];

function find(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function str(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = o; i < o + n; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(o + n, i + 8192)));
  return s;
}

function zero(f: ByteFile, offset: number, length: number): boolean {
  for (let done = 0; done < length; ) {
    const n = Math.min(MAX_READ_BYTES, length - done);
    const b = f.read(offset + done, n);
    if (b.length < n) return false;
    for (let i = 0; i < n; i++) if (b[i] !== 0) return false;
    done += n;
  }
  return true;
}

interface Box {
  type: string;
  offset: number;
  size: number;
  header: number;
}

/** Its own box walk (sizes and types only). Null when the boxes do not tile the range exactly. */
function walk(f: ByteFile, start: number, end: number): Box[] | null {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const h = f.read(pos, 16);
    let size = be32(h, 0);
    let header = 8;
    if (size === 1 && h.length >= 16) {
      size = be32(h, 8) * 0x100000000 + be32(h, 12);
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return null;
    out.push({ type: str(h, 4, 4), offset: pos, size, header });
    pos += size;
  }
  return pos === end ? out : null;
}

const rd16 = (b: Uint8Array, o: number, le: boolean) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const rd32 = (b: Uint8Array, o: number, le: boolean) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : be32(b, o));

/** Tags no profile keeps in a TIFF/DNG (own list, not the engine's catalogue). */
const TIFF_NEVER: Record<number, string> = {
  0x8825: 'Location', 0x830e: 'Location', 0x8482: 'Location', 0x85d8: 'Location', 0x87af: 'Location', 0x87b0: 'Location', 0x87b1: 'Location',
  0x927c: 'Maker notes', 0xc634: 'Private camera data', 0xc68c: 'Embedded original RAW file', 0x935c: 'Photoshop layer data',
  0xcea1: 'Content signature (SEAL)', 0xcd41: 'Content credentials (C2PA)', 0xc6f5: 'Extra camera colour profiles',
};

/**
 * What "Remove everything" may leave in a TIFF/DNG directory (its own list, typed from the decode tags of TIFF 6.0, TIFF/EP
 * and DNG 1.7, not imported from the cleaner): picture layout and colour tags, SubIFDs, Orientation, the ICC profile and DNG's
 * camera-model tag (which must then say "Camera"). Anything else under "Remove everything" is a hit (review S1b).
 */
const TIFF_ALL_OK = new Set([
  0x00fe, 0x00ff, 0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a, 0x0111, 0x0112, 0x0115, 0x0116,
  0x0117, 0x0118, 0x0119, 0x011a, 0x011b, 0x011c, 0x0122, 0x0123, 0x0124, 0x0125, 0x0128, 0x012d, 0x013d, 0x013e, 0x013f,
  0x0140, 0x0141, 0x0142, 0x0143, 0x0144, 0x0145, 0x014a, 0x014c, 0x014e, 0x0150, 0x0152, 0x0153, 0x0154, 0x0155, 0x0156,
  0x015b, 0x0200, 0x0201, 0x0202, 0x0203, 0x0205, 0x0206, 0x0211, 0x0212, 0x0213, 0x0214, 0x828d, 0x828e, 0x8773,
  0xc612, 0xc613, 0xc614, 0xc616, 0xc617, 0xc618, 0xc619, 0xc61a, 0xc61b, 0xc61c, 0xc61d, 0xc61e, 0xc61f, 0xc620, 0xc621,
  0xc622, 0xc623, 0xc624, 0xc625, 0xc626, 0xc627, 0xc628, 0xc629, 0xc62a, 0xc62b, 0xc62c, 0xc62d, 0xc62e, 0xc631, 0xc632,
  0xc633, 0xc65a, 0xc65b, 0xc65c, 0xc68d, 0xc68e, 0xc68f, 0xc690, 0xc691, 0xc692, 0xc6bf, 0xc6f7, 0xc6f9, 0xc6fa, 0xc6fb,
  0xc6fc, 0xc6fd, 0xc714, 0xc715, 0xc71a, 0xc71c, 0xc71e, 0xc71f, 0xc725, 0xc726, 0xc740, 0xc741, 0xc74e, 0xc761, 0xc791,
  0xc792, 0xc793, 0xc7a3, 0xc7a4, 0xc7a5, 0xc7a6, 0xc7a7, 0xc7a8, 0xc7b5, 0xc7e9, 0xc7ea, 0xc7eb, 0xc7ec, 0xc7ed, 0xcd2d,
  0xcd2e, 0xcd31, 0xcd32, 0xcd33, 0xcd34, 0xcd35, 0xcd36, 0xcd37, 0xcd38, 0xcd39, 0xcd3a, 0xcd3f, 0xcd40, 0xcd43, 0xcd46,
  0xcd47, 0xcd49, 0xcd4a, 0xcd4b,
]);
/** Bytes per value of each TIFF type (index = type number, 0 = no such type). */
const TIFF_TYPE_BYTES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
/** Tags whose values are directories, with the kind of directory (anywhere in the file, like ExifTool; review M2/S1a). */
const TIFF_DIR_TAGS: Record<number, 'image' | 'exif' | 'gps' | 'interop'> = { 0x014a: 'image', 0x8769: 'exif', 0x8825: 'gps', 0xa005: 'interop' };
const TIFF_PARTS: [number, number][] = [[0x0111, 0x0117], [0x0144, 0x0145], [0x0201, 0x0202]];

/**
 * Its own walk of a TIFF/DNG: every directory any pointer reaches (the IFD chain, SubIFDs, Exif, GPS, Interop and IFD-type
 * entries, wherever they are, and every `next` link), every value and every picture part. Hits for tags no profile keeps,
 * for anything but the decode tags under "Remove everything", and for bytes that nothing points at (review M3: a rebuilt
 * copy has only alignment padding, at most 3 zero bytes per gap).
 */
function tiffHits(f: ByteFile, profile: Profile, hit: (name: string) => void): void {
  const h = f.read(0, 8);
  if (h.length < 8 || !((h[0] === 0x49 && h[1] === 0x49) || (h[0] === 0x4d && h[1] === 0x4d))) return hit('Unreadable file structure');
  const le = h[0] === 0x49;
  if (rd16(h, 2, le) !== 42) return hit('Unreadable file structure');
  const covered: { offset: number; length: number }[] = [{ offset: 0, length: 8 }];
  const seen = new Set<number>();
  const queue: [number, string][] = [[rd32(h, 4, le), 'image']];
  const size = f.size;
  while (queue.length) {
    const [at, role] = queue.shift()!;
    if (seen.has(at)) continue;
    if (seen.size >= 512 || at < 8 || at + 2 > size) return hit('Unreadable file structure');
    seen.add(at);
    const n = rd16(f.read(at, 2), 0, le);
    const t = f.read(at + 2, n * 12 + 4);
    if (n === 0 || t.length < n * 12 + 4) return hit('Unreadable file structure');
    covered.push({ offset: at, length: 2 + n * 12 + 4 });
    if (role !== 'image' && profile === 'all') hit('Metadata directory');
    const values = new Map<number, { type: number; count: number; at: number }>();
    for (let i = 0; i < n; i++) {
      const tag = rd16(t, i * 12, le);
      const type = rd16(t, i * 12 + 2, le);
      const count = rd32(t, i * 12 + 4, le);
      const bytes = (TIFF_TYPE_BYTES[type] ?? 0) * count;
      if (!TIFF_TYPE_BYTES[type]) {
        hit('Unreadable file structure');
        continue;
      }
      const vAt = bytes <= 4 ? at + 2 + i * 12 + 8 : rd32(t, i * 12 + 8, le);
      if (bytes > 4) {
        if (vAt + bytes > size) return hit('Unreadable file structure');
        covered.push({ offset: vAt, length: bytes });
      }
      if (!values.has(tag)) values.set(tag, { type, count, at: vAt });
      if (role === 'gps') hit('Location');
      if (TIFF_NEVER[tag]) hit(TIFF_NEVER[tag]);
      if (profile === 'all' && role === 'image' && !TIFF_ALL_OK.has(tag)) hit('Other metadata tag');
      if (profile === 'all' && tag === 0xc614 && str(f.read(vAt, Math.min(bytes, 64)), 0, Math.min(bytes, 64)) !== 'Camera\0') hit('Camera or phone model');
      const dir = TIFF_DIR_TAGS[tag] ?? (type === 13 ? 'private' : null);
      if (dir && (type === 4 || type === 13) && count <= 64) {
        const v = f.read(vAt, count * 4);
        for (let k = 0; k < count && k * 4 + 4 <= v.length; k++) queue.push([rd32(v, k * 4, le), dir]);
      }
    }
    for (const [oTag, lTag] of TIFF_PARTS) {
      const o = values.get(oTag);
      const l = values.get(lTag);
      if (!o || !l) continue;
      const width = (x: { type: number }) => (x.type === 3 ? 2 : 4);
      if (o.count !== l.count || o.count * 4 > MAX_READ_BYTES || ![3, 4].includes(o.type) || ![3, 4].includes(l.type)) return hit('Unreadable file structure');
      const ob = f.read(o.at, o.count * width(o));
      const lb = f.read(l.at, l.count * width(l));
      for (let k = 0; k < o.count; k++) {
        const off = width(o) === 2 ? rd16(ob, k * 2, le) : rd32(ob, k * 4, le);
        const len = width(l) === 2 ? rd16(lb, k * 2, le) : rd32(lb, k * 4, le);
        if (len) covered.push({ offset: off, length: len });
      }
    }
    const next = rd32(t, n * 12, le);
    if (next) queue.push([next, role]);
  }
  covered.sort((a, b) => a.offset - b.offset);
  let pos = 0;
  for (const c of [...covered, { offset: size, length: 0 }]) {
    if (c.offset > pos && (c.offset - pos > 3 || !zero(f, pos, Math.min(c.offset, size) - pos))) return hit('Data outside the file structure');
    pos = Math.max(pos, c.offset + c.length);
  }
}

/**
 * Its own walk of the GIF blocks: what a profile may not leave. Kept control blocks must have exactly their defined
 * sub-blocks (frame timing: one of 4 bytes; loop: id 1 of 3 bytes, id 2 of 5 bytes), plain text is never left, and an ICC
 * block must look like an ICC profile (review M4/S4).
 */
function gifHits(f: ByteFile, profile: Profile, hit: (name: string) => void): void {
  const size = f.size;
  let pos = 0;
  let buf: Uint8Array = new Uint8Array(0);
  let bufAt = 0;
  const byte = (): number => {
    if (pos >= size) throw new Error('end');
    if (pos < bufAt || pos >= bufAt + buf.length) {
      bufAt = pos;
      buf = f.read(pos, 256 * 1024);
    }
    return buf[pos++ - bufAt];
  };
  /** The sub-blocks: their lengths and their first up to 132 bytes of payload. */
  const blocks = (): { lens: number[]; first: number[]; head: number[] } => {
    const lens: number[] = [];
    const first: number[] = [];
    const head: number[] = [];
    for (let n = byte(); n; n = byte()) {
      lens.push(n);
      for (let i = 0; i < n; i++) {
        const b = byte();
        if (i === 0) first.push(b);
        if (head.length < 132) head.push(b);
      }
    }
    return { lens, first, head };
  };
  try {
    const h = f.read(0, 13);
    if (str(h, 0, 3) !== 'GIF') throw new Error('header');
    pos = 13 + (h[10] & 0x80 ? 3 * (1 << ((h[10] & 7) + 1)) : 0);
    for (;;) {
      const k = byte();
      if (k === 0x3b) break;
      if (k === 0x2c) {
        pos += 8;
        const packed = byte();
        if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1));
        pos += 1;
        blocks();
      } else if (k === 0x21) {
        const label = byte();
        if (label === 0xff) {
          const n = byte();
          let id = '';
          for (let i = 0; i < n; i++) id += String.fromCharCode(byte());
          const b = blocks();
          if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
            if (b.lens.some((l, i) => !((l === 3 && b.first[i] === 1) || (l === 5 && b.first[i] === 2)))) hit('Hidden data in a control block');
          } else if (id === 'ICCRGBG1012') {
            const total = b.lens.reduce((a, x) => a + x, 0);
            const head = Uint8Array.from(b.head);
            if (head.length < 132 || str(head, 36, 4) !== 'acsp' || be32(head, 0) > total || total - be32(head, 0) > 3) hit('Unknown data block');
          } else if (!((id === 'XMP DataXMP' && profile !== 'all') || ((id === 'MGKIPTC0000' || id === 'MGK8BIM0000') && profile === 'location'))) hit('Unknown data block');
        } else if (label === 0xfe) {
          if (profile !== 'location') hit('Comment');
          blocks();
        } else if (label === 0xf9) {
          const b = blocks();
          if (b.lens.length !== 1 || b.lens[0] !== 4) hit('Hidden data in a control block');
        } else if (label === 0x01) {
          hit('Hidden text block');
          blocks();
        } else {
          hit('Unknown data block');
          blocks();
        }
      } else throw new Error('block');
    }
    if (pos < size) hit('Data after the end of the picture');
  } catch {
    hit('Unreadable file structure');
  }
}

/**
 * Runs the separate scan over `f` (the cleaned copy) of `format`, cleaned with the effective `profile`.
 * Yields progress in bytes read.
 */
export function* sweepSteps(f: ByteFile, format: Format, profile: Profile): Generator<StepProgress, SweepHit[], void> {
  const hits: SweepHit[] = [];
  const hit = (name: string) => {
    if (!hits.some((h) => h.name === name)) hits.push({ id: `sweep:${name}`, name });
  };
  const size = f.size;
  // Ranges to search for signatures: the whole file, minus the media payload of videos.
  let ranges: { offset: number; length: number }[] = [{ offset: 0, length: size }];

  const allowed = ISO_TOP[format];
  if (allowed) {
    const top = walk(f, 0, size);
    if (!top) hit('Data outside the file structure');
    else {
      for (const b of top) {
        if (b.type === 'mpvd') hit('Motion-photo video');
        else if (!allowed.includes(b.type)) hit('Unknown data block');
        else if (b.type === 'uuid' && !ALLOWED_UUIDS.includes([...f.read(b.offset + b.header, 16)].map((x) => x.toString(16).padStart(2, '0')).join(''))) hit('Unknown data block');
        else if (FREE.includes(b.type) && !zero(f, b.offset + b.header, b.size - b.header)) hit('Leftover data in free space');
      }
      const moov = top.find((b) => b.type === 'moov');
      for (const c of (moov && walk(f, moov.offset + moov.header, moov.offset + moov.size)) ?? []) {
        if (FREE.includes(c.type) && !zero(f, c.offset + c.header, c.size - c.header)) hit('Leftover data in free space');
      }
      if (format === 'mp4' || format === 'mov') {
        ranges = [];
        let pos = 0;
        for (const b of top.filter((x) => x.type === 'mdat')) {
          ranges.push({ offset: pos, length: b.offset + b.header - pos });
          pos = b.offset + b.size;
        }
        ranges.push({ offset: pos, length: size - pos });
      }
    }
  } else if (format === 'jpeg') {
    const t = f.read(Math.max(0, size - 2), 2);
    if (!(t[0] === 0xff && t[1] === 0xd9)) hit('Data after the end of the picture');
  } else if (format === 'png') {
    const t = f.read(Math.max(0, size - 12), 12);
    if (str(t, 4, 4) !== 'IEND' || be32(t, 0) !== 0) hit('Data after the end of the picture');
  } else if (format === 'tiff' || format === 'dng') {
    tiffHits(f, profile, hit);
  } else if (format === 'gif') {
    gifHits(f, profile, hit);
  } else if (format === 'webp') {
    const h = f.read(0, 8);
    if (((h[4] | (h[5] << 8) | (h[6] << 16)) + h[7] * 0x1000000) + 8 !== size) hit('Data after the end of the picture');
  }

  const sigs = [...ALWAYS, ...(format === 'pdf' ? PDF_ALWAYS : []), ...(format === 'tiff' || format === 'dng' ? TIFF_ALWAYS : []), ...(format === 'pdf' && profile !== 'location' ? [['Page last modified', '/LastModified'] as [string, string]] : [])].map(
    ([name, s]) => ({ name, bytes: enc(s) }),
  );
  if (format === 'jpeg') sigs.push({ name: 'Multi-picture index', bytes: enc('MPF\0') });
  // Review S9: 3GPP/QuickTime location boxes anywhere outside the media data (a box header: 4-byte size, then the type).
  if (format === 'mp4' || format === 'mov') sigs.push({ name: 'Location', bytes: enc('loci') }, { name: 'Location', bytes: enc('\xa9xyz') });
  const longest = Math.max(...sigs.map((s) => s.bytes.length), 64);
  const total = ranges.reduce((s, r) => s + r.length, 0);
  let done = 0;
  for (const r of ranges) {
    const step = MAX_READ_BYTES - longest;
    for (let start = r.offset; start < r.offset + r.length; start += step) {
      const len = Math.min(MAX_READ_BYTES, r.offset + r.length - start);
      const buf = f.read(start, len);
      for (const s of sigs) {
        for (let i = find(buf, s.bytes); i >= 0; i = find(buf, s.bytes, i + 1)) {
          // MPF only as an APP2 segment header (FF E2 len len 'MPF\0').
          if (s.name === 'Multi-picture index' && !(i >= 4 && buf[i - 4] === 0xff && buf[i - 3] === 0xe2)) continue;
          if (s.bytes.length === 4 && s.name === 'Location' && !(i >= 4 && be32(buf, i - 4) >= 8 && be32(buf, i - 4) < 1 << 24)) continue;
          hit(s.name);
          break;
        }
      }
      if (format === 'pdf' && profile === 'all') {
        // The document ID must be all zeros after cleaning (any other digit links the copy to the original).
        const text = str(buf, 0, buf.length);
        for (const m of text.matchAll(/\/ID\s*\[\s*<([0-9A-Fa-f\s]*)>/g)) if (/[1-9A-Fa-f]/.test(m[1])) hit('Document ID');
      }
      done += Math.min(step, len);
      yield { done: Math.min(done, total), total };
      if (len < MAX_READ_BYTES) break;
    }
  }
  if (format === 'jpeg' && size >= 4 && str(f.read(size - 4, 4), 0, 4) === 'SEFT') hit('Samsung trailer');
  return hits;
}
