// P7.5 regression fixtures: the synthetic files of docs/REVIEW_V1.md that the P7 engine called "Verified clean" while
// they still held personal data (B1 HEIC Motion-Photo box, S1 MP4 big unknown box + stale `free` text, S3 PDF page dates
// and PieceInfo, S4 PDF with an embedded camera photo). Built from the committed fixtures with code that shares nothing
// with the engine (plain Buffers, own box/iloc walkers), so the files are the same on every run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { box } from './isobmff-builder';

const FIX = join(__dirname, 'fixtures');
export const read = (n: string) => readFileSync(join(FIX, n));

/** Secrets planted in the fixtures: none of them may be in a cleaned copy. */
export const SECRET = {
  heicBox: 'OWNER=Jane Secret HEIC box +52.5200+013.4049/',
  mp4Big: 'OWNER=Jane Secret; +52.5200+013.4049/',
  mp4Free: 'stale +48.8584+002.2945/ Alice Example',
  pdfPiece: 'Owner Jane Secret, Berlin studio',
  pdfDate: 'D:20250314093000',
  pdfId: '0123456789abcdef0123456789abcdef',
};

interface TopBox {
  type: string;
  start: number;
  size: number;
  header: number;
}

function boxes(b: Buffer, s: number, e: number): TopBox[] {
  const out: TopBox[] = [];
  for (let i = s; i + 8 <= e; ) {
    let size = b.readUInt32BE(i);
    let header = 8;
    if (size === 1) {
      size = Number(b.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = e - i;
    out.push({ type: b.toString('latin1', i + 4, i + 8), start: i, size, header });
    i += size;
  }
  return out;
}

const readN = (b: Buffer, at: number, n: number) => (n === 0 ? 0 : n === 4 ? b.readUInt32BE(at) : n === 8 ? Number(b.readBigUInt64BE(at)) : NaN);
const writeN = (b: Buffer, at: number, n: number, v: number) => (n === 4 ? b.writeUInt32BE(v, at) : n === 8 ? b.writeBigUInt64BE(BigInt(v), at) : 0);

/** Adds `delta` to every file offset of a HEIF `iloc` (construction method 0) in a copy of `heif`. */
export function shiftIloc(heif: Buffer, delta: number): Buffer {
  const b = Buffer.from(heif);
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta')!;
  const iloc = boxes(b, meta.start + meta.header + 4, meta.start + meta.size).find((x) => x.type === 'iloc')!;
  let p = iloc.start + iloc.header;
  const version = b[p];
  p += 4;
  const offSize = b[p] >> 4;
  const lenSize = b[p] & 15;
  const baseSize = b[p + 1] >> 4;
  const idxSize = version >= 1 ? b[p + 1] & 15 : 0;
  p += 2;
  const count = version < 2 ? b.readUInt16BE(p) : b.readUInt32BE(p);
  p += version < 2 ? 2 : 4;
  for (let i = 0; i < count; i++) {
    p += version < 2 ? 2 : 4;
    const construction = version >= 1 ? b.readUInt16BE(p) & 15 : 0;
    if (version >= 1) p += 2;
    p += 2;
    const baseAt = p;
    p += baseSize;
    const n = b.readUInt16BE(p);
    p += 2;
    const ext: number[] = [];
    for (let k = 0; k < n; k++) {
      p += idxSize;
      ext.push(p);
      p += offSize + lenSize;
    }
    if (construction !== 0) continue;
    if (baseSize) writeN(b, baseAt, baseSize, readN(b, baseAt, baseSize) + delta);
    else for (const at of ext) writeN(b, at, offSize, readN(b, at, offSize) + delta);
  }
  return b;
}

/** B1: photo.heic + Samsung's top-level `mpvd` Motion-Photo box holding gps.mp4 (with its GPS). */
export function heicWithMpvd(): Buffer {
  return Buffer.concat([read('photo.heic'), box('mpvd', read('gps.mp4'))]);
}

/** B1 variant: an unknown top-level box between `meta` and `mdat` (so dropping it moves the picture data). */
export function heicWithBoxBeforeMdat(name = 'photo.heic'): Buffer {
  const src = read(name);
  const meta = boxes(src, 0, src.length).find((x) => x.type === 'meta')!;
  const extra = box('xyzz', Buffer.from(SECRET.heicBox, 'latin1'));
  const at = meta.start + meta.size;
  return shiftIloc(Buffer.concat([src.subarray(0, at), extra, src.subarray(at)]), extra.length);
}

/** S1: gps.mp4 + a 5 MB unknown top-level box + a `free` box with stale location text. */
export function mp4WithBigBoxAndFree(): Buffer {
  const big = Buffer.alloc(5 * 1024 * 1024, 0x20);
  big.write(SECRET.mp4Big, 100, 'latin1');
  return Buffer.concat([read('gps.mp4'), box('xtra', big), box('free', Buffer.from(SECRET.mp4Free, 'latin1'))]);
}

function pdf(objs: string[] | Buffer[], trailerExtra: string): Buffer {
  let out = Buffer.from('%PDF-1.4\n');
  const offs: number[] = [];
  for (const o of objs) {
    offs.push(out.length);
    out = Buffer.concat([out, Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1')]);
  }
  const xref = out.length;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(x, 'latin1')]);
}

/** S3: a page with /LastModified and Illustrator-style /PieceInfo private data (inline and in a referenced object), plus a trailer /ID. */
export function pdfPieceInfo(): Buffer {
  return pdf(
    [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /LastModified (${SECRET.pdfDate}+01'00') /PieceInfo << /Illustrator << /Private (${SECRET.pdfPiece}) /LastModified (${SECRET.pdfDate}+01'00') >> /Other 6 0 R >> /Contents 4 0 R >>\nendobj\n`,
      '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
      '5 0 obj\n<< /Author (Jane Fixture) /CreationDate (D:20250101000000Z) >>\nendobj\n',
      '6 0 obj\n<< /Private (Referenced private data Jane Secret) /LastModified (D:20240101120000Z) >>\nendobj\n',
    ],
    `/Info 5 0 R /ID [<${SECRET.pdfId}> <${SECRET.pdfId}>]`,
  );
}

/** S4: a one-page PDF showing photo.jpg (Exif with GPS) as a /DCTDecode image, optionally wrapped in Flate first. */
export function pdfWithPhoto(flate: boolean): Buffer {
  const jpg = read('photo.jpg');
  const data = flate ? deflateSync(jpg) : jpg;
  const filter = flate ? '[/FlateDecode /DCTDecode]' : '/DCTDecode';
  const content = 'q 100 0 0 100 0 0 cm /Im1 Do Q';
  return pdf(
    [
      Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
      Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'),
      Buffer.concat([
        Buffer.from(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${data.length} >>\nstream\n`),
        data,
        Buffer.from('\nendstream\nendobj\n'),
      ]),
      Buffer.from(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`),
      Buffer.from('6 0 obj\n<< /Author (Jane Fixture PDF) /Producer (ProbeMaker) >>\nendobj\n'),
    ],
    '/Info 6 0 R',
  );
}

/** Inserts `extra` at `at` inside the boxes starting at `parents` (32-bit sizes grow), then fixes the iloc offsets. */
function insertInside(src: Buffer, parents: number[], at: number, extra: Buffer): Buffer {
  const out = Buffer.concat([src.subarray(0, at), extra, src.subarray(at)]);
  for (const p of parents) out.writeUInt32BE(out.readUInt32BE(p) + extra.length, p);
  return shiftIloc(out, extra.length);
}

/** N10: an `xml ` box inside `meta` and a `udes` (user description) property in `ipco`. */
export function heicWithXmlAndUdes(): Buffer {
  let b: Buffer = read('photo.heic');
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta')!;
  const xml = box('xml ', Buffer.from([0, 0, 0, 0]), Buffer.from('<desc>Taken at Jane Secret house</desc>', 'latin1'));
  b = insertInside(b, [meta.start], meta.start + meta.size, xml);
  const meta2 = boxes(b, 0, b.length).find((x) => x.type === 'meta')!;
  const iprp = boxes(b, meta2.start + meta2.header + 4, meta2.start + meta2.size).find((x) => x.type === 'iprp')!;
  const ipco = boxes(b, iprp.start + 8, iprp.start + iprp.size).find((x) => x.type === 'ipco')!;
  const udes = box('udes', Buffer.from([0, 0, 0, 0]), Buffer.from('en\0Birthday\0Party at Jane Secret house\0family\0', 'latin1'));
  return insertInside(b, [meta2.start, iprp.start, ipco.start], ipco.start + ipco.size, udes);
}
