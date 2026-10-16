/** @jest-environment node */
// P7.5 regression: the review's (docs/REVIEW_V1.md) synthetic files that P7 called "Verified clean" while personal
// data survived. Each is cleaned the way the app does it (in-place formats from a byte copy), verified by the engine,
// and then judged by checks written here: the planted secret bytes, ExifTool 13.59, and our own re-read of the picture.
// On the P7 engine every test below fails (secrets survive under a green verdict) — see V1_LOG P7.5.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { exifDump, ROOT } from '../scripts/lib/referee';
import { clean } from '../src/engine/clean';
import { cleanHeif } from '../src/engine/heif';
import { IN_PLACE_FORMATS, inspect, model } from '../src/engine/inspect';
import { runToEnd } from '../src/engine/io';
import type { Profile } from '../src/engine/profiles';
import type { Format } from '../src/engine/sniff';
import { sweepSteps } from '../src/engine/sweep';
import { verify, type Verdict } from '../src/engine/verify';

import { box } from './isobmff-builder';
import { openNodeByteFile } from './node-byte-file';
import { heicWithBoxBeforeMdat, heicWithMpvd, heicWithXmlAndUdes, mp4WithBigBoxAndFree, pdfPieceInfo, pdfWithPhoto, read, SECRET } from './review-fixtures';

const OUT = join(ROOT, 'artifacts', 'review-v1');

/** Cleans like src/lib/pipeline.ts: in-place formats start from a byte copy. */
function run(name: string, input: Buffer, profile: Profile = 'all'): { out: Buffer; verdict: Verdict; path: string; before: ReturnType<typeof inspect> } {
  mkdirSync(join(OUT, 'in'), { recursive: true });
  const inP = join(OUT, 'in', name);
  const outP = join(OUT, `${profile}-${name}`);
  writeFileSync(inP, input);
  const src = openNodeByteFile(inP);
  const before = inspect(src);
  const inPlace = IN_PLACE_FORMATS.includes(before.format);
  if (inPlace) copyFileSync(inP, outP);
  else writeFileSync(outP, new Uint8Array(0));
  const dst = openNodeByteFile(outP, true);
  try {
    const r = clean(src, dst, profile, { dstIsCopy: inPlace });
    const verdict = verify({ src, dst, before: r.before, profile });
    return { out: readFileSync(outP), verdict, path: outP, before };
  } finally {
    src.close();
    dst.close();
  }
}

const has = (b: Buffer, s: string | Buffer) => b.includes(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);

beforeAll(() => rmSync(OUT, { recursive: true, force: true }));

describe('B1 HEIC: top-level boxes are an allow-list', () => {
  it('a Samsung-style mpvd Motion-Photo box is listed, dropped, and ExifTool no longer sees a Motion Photo video', () => {
    const input = heicWithMpvd();
    const { out, verdict, path, before } = run('mpvd.heic', input);
    expect(before.findings.map((f) => f.id)).toContain('motion');
    expect(has(out, read('gps.mp4'))).toBe(false);
    expect(has(out, 'mpvd')).toBe(false);
    expect(out.length).toBe(read('photo.heic').length);
    expect(verdict.status).toBe('clean');
    const tags = exifDump([path])[path];
    expect(Object.keys(tags).filter((k) => /MotionPhoto|GPS/i.test(k))).toEqual([]);
  });

  for (const name of ['photo.heic', 'photo.avif']) {
    it(`${name}: an unknown box before mdat is dropped and the item offsets are fixed (picture bytes identical)`, () => {
      const input = heicWithBoxBeforeMdat(name);
      const { out, verdict } = run(`xyzz-${name}`, input);
      expect(has(out, SECRET.heicBox)).toBe(false);
      expect(has(out, 'xyzz')).toBe(false);
      expect(verdict.status).toBe('clean');
      expect(verdict.pictureUnchanged).toBe(true);
      // The cleaned file is what cleaning the plain fixture gives (same picture, same layout).
      const plain = run(`plain-${name}`, read(name)).out;
      expect(out.equals(plain)).toBe(true);
    });
  }
});

describe('S1 MP4: unknown boxes of any size and stale free space', () => {
  it('a 5 MB unknown top-level box and a free box with old location text are zeroed', () => {
    const { out, verdict, before } = run('bigbox.mp4', mp4WithBigBoxAndFree());
    expect(before.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['Other embedded data', 'Leftover data in free space']));
    expect(has(out, SECRET.mp4Big)).toBe(false);
    expect(has(out, SECRET.mp4Free)).toBe(false);
    expect(verdict.status).toBe('clean');
  });
});

describe('S3 PDF: page dates, PieceInfo and the document ID', () => {
  it('/LastModified and /PieceInfo (inline and referenced) are blanked, /ID is regenerated', () => {
    const { out, verdict, before } = run('pieceinfo.pdf', pdfPieceInfo());
    expect(before.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['LastModified', 'PieceInfo', 'ID']));
    expect(has(out, SECRET.pdfPiece)).toBe(false);
    expect(has(out, 'Referenced private data')).toBe(false);
    expect(has(out, SECRET.pdfDate)).toBe(false);
    expect(has(out, 'D:20240101120000Z')).toBe(false);
    expect(has(out, SECRET.pdfId)).toBe(false);
    expect(out.toString('latin1')).toMatch(/\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/);
    expect(verdict.status).toBe('clean');
  });

  it('"Location only" keeps the page dates (not location) and still verifies clean', () => {
    const { verdict } = run('pieceinfo.pdf', pdfPieceInfo(), 'location');
    expect(verdict.status).toBe('clean');
  });
});

describe('S4 PDF: photos inside the PDF', () => {
  it('a /DCTDecode photo loses its Exif, GPS and XMP in place; the picture data is unchanged', () => {
    const { out, verdict, before } = run('photo.pdf', pdfWithPhoto(false));
    expect(before.fields.some((f) => f.group === 'location' && /embedded photo/.test(f.name))).toBe(true);
    expect(before.findings.map((f) => f.id)).toContain('location');
    expect(has(out, 'Exif\0\0')).toBe(false);
    expect(has(out, 'http://ns.adobe.com/xap/1.0/')).toBe(false);
    expect(has(out, 'Photoshop 3.0')).toBe(false);
    expect(out.length).toBe(pdfWithPhoto(false).length);
    expect(verdict.status).toBe('clean');
    expect(verdict.pictureUnchanged).toBe(true);
    // The embedded JPEG still starts and ends like a JPEG and keeps its scan data.
    const jpg = read('photo.jpg');
    const eoi = jpg.length;
    const sos = jpg.indexOf(Buffer.from([0xff, 0xda]));
    expect(has(out, jpg.subarray(sos, eoi))).toBe(true);
  });

  it('a photo wrapped in Flate before DCT is never green: "Could not verify", and it says why', () => {
    const { out, verdict } = run('photo-flate.pdf', pdfWithPhoto(true));
    expect(verdict.status).not.toBe('clean');
    expect(verdict.problems.join(' ')).toMatch(/photo inside/i);
    // (The Exif really is still in there, which is why it cannot be green.)
    const start = out.indexOf(Buffer.from('stream\n', 'latin1'), out.indexOf(Buffer.from('/Subtype /Image'))) + 7;
    const end = out.indexOf(Buffer.from('\nendstream'), start);
    expect(inflateSync(out.subarray(start, end)).includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(true);
  });
});

describe('B1/N10 HEIC: inside meta', () => {
  it('an xml box in meta and a udes description are listed, emptied, and the copy verifies clean', () => {
    const { out, verdict, before } = run('xml-udes.heic', heicWithXmlAndUdes());
    expect(before.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['XML metadata', 'Description']));
    expect(has(out, 'Jane Secret')).toBe(false);
    expect(has(out, 'Birthday')).toBe(false);
    expect(verdict.status).toBe('clean');
    expect(verdict.pictureUnchanged).toBe(true);
  });

  it('"Location only" keeps the description (it is not location)', () => {
    const { out, verdict } = run('xml-udes.heic', heicWithXmlAndUdes(), 'location');
    expect(has(out, 'Birthday')).toBe(true);
    expect(has(out, '<desc>')).toBe(false);
    expect(verdict.status).toBe('clean');
  });

  it('when iloc cannot express a move, the box stays in place as zeros (never left with its data)', () => {
    const input = heicWithBoxBeforeMdat();
    mkdirSync(join(OUT, 'in'), { recursive: true });
    const inP = join(OUT, 'in', 'fallback.heic');
    const outP = join(OUT, 'fallback.heic');
    writeFileSync(inP, input);
    writeFileSync(outP, new Uint8Array(0));
    const src = openNodeByteFile(inP);
    const dst = openNodeByteFile(outP, true);
    const m = model(src, 'heic')!;
    if (m.format !== 'heic') throw new Error('not heic');
    m.model.iloc!.offSize = 0; // pretend the offsets cannot be rewritten
    m.model.iloc!.baseSize = 0;
    cleanHeif(src, m.model, dst, () => false);
    const verdict = verify({ src, dst, before: inspect(src), profile: 'all' });
    src.close();
    dst.close();
    const out = readFileSync(outP);
    expect(out.length).toBe(input.length);
    expect(has(out, SECRET.heicBox)).toBe(false);
    expect(has(out, 'xyzz')).toBe(false);
    expect(verdict.status).toBe('clean');
  });
});

describe('S2: the separate scan (src/engine/sweep.ts) finds the review cases on its own', () => {
  const sweepOf = (b: Buffer, format: Format, profile: Profile = 'all') => {
    mkdirSync(join(OUT, 'in'), { recursive: true });
    const p = join(OUT, 'in', `sweep.${format}`);
    writeFileSync(p, b);
    const f = openNodeByteFile(p);
    try {
      return runToEnd(sweepSteps(f, format, profile)).map((h) => h.name);
    } finally {
      f.close();
    }
  };

  it('the P7 outputs of the review files (they kept the data) are flagged', () => {
    expect(sweepOf(heicWithMpvd(), 'heic')).toEqual(['Motion-photo video']);
    expect(sweepOf(heicWithBoxBeforeMdat(), 'heic')).toEqual(['Unknown data block']);
    expect(sweepOf(mp4WithBigBoxAndFree(), 'mp4')).toEqual(['Unknown data block', 'Leftover data in free space', 'Location']); // V1.5-1 fix round: the ©xyz box of gps.mp4 too (S9)
    expect(sweepOf(pdfPieceInfo(), 'pdf')).toEqual(expect.arrayContaining(['Private data of the editing app', 'Page last modified', 'Document ID']));
    expect(sweepOf(pdfPieceInfo(), 'pdf', 'location')).toEqual(['Private data of the editing app']);
    expect(sweepOf(pdfWithPhoto(false), 'pdf')).toContain('Photo data inside the PDF');
  });

  it('camera extras and trailers are flagged in originals', () => {
    expect(sweepOf(read('motion.jpg'), 'jpeg')).toEqual(expect.arrayContaining(['Motion-photo data', 'Data after the end of the picture']));
    expect(sweepOf(read('ultrahdr.jpg'), 'jpeg')).toEqual(expect.arrayContaining(['HDR gain-map data', 'Multi-picture index']));
    expect(sweepOf(Buffer.concat([read('photo.jpg'), Buffer.from('xxxxSEFT')]), 'jpeg')).toEqual(['Data after the end of the picture', 'Samsung trailer']);
    expect(sweepOf(Buffer.concat([read('photo.png'), Buffer.from('tail')]), 'png')).toEqual(['Data after the end of the picture', 'Location']);
  });

  it('the cleaned review files pass it, and a verify() result names it as a reader', () => {
    expect(sweepOf(run('mpvd.heic', heicWithMpvd()).out, 'heic')).toEqual([]);
    expect(sweepOf(run('bigbox.mp4', mp4WithBigBoxAndFree()).out, 'mp4')).toEqual([]);
    expect(sweepOf(run('pieceinfo.pdf', pdfPieceInfo()).out, 'pdf')).toEqual([]);
    // A writer that forgot the Motion-Photo box: the separate scan says so next to the structure reader.
    const clean = run('plain.heic', read('photo.heic'));
    const dirtyP = join(OUT, 'dirty-mpvd.heic');
    writeFileSync(dirtyP, Buffer.concat([clean.out, box('mpvd', read('gps.mp4'))]));
    const src = openNodeByteFile(join(OUT, 'in', 'plain.heic'));
    const dst = openNodeByteFile(dirtyP);
    const v = verify({ src, dst, before: clean.before, profile: 'all' });
    src.close();
    dst.close();
    expect(v.status).toBe('dirty');
    expect(v.survivors).toContainEqual({ id: 'sweep:Motion-photo video', name: 'Motion-photo video', reader: 'sweep' });
    expect(v.readers).toBe(3);
  });
});

describe('S8 "Keep camera settings": a lens name that names the phone', () => {
  it('is a Device field and is removed with the phone model; exposure settings stay', () => {
    mkdirSync(join(OUT, 'in'), { recursive: true });
    const p = join(OUT, 'in', 'iphone-lens.jpg');
    writeFileSync(p, read('photo.jpg'));
    execFileSync('/usr/bin/perl', [join(ROOT, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool'), '-q', '-overwrite_original', '-Make=Apple', '-Model=iPhone 15 Pro', '-LensModel=iPhone 15 Pro back triple camera 6.765mm f/1.78', p]);
    const { out, verdict, path, before } = run('iphone-lens.jpg', readFileSync(p), 'camera');
    expect(before.fields.find((f) => f.id === 'exif:LensModel')).toMatchObject({ group: 'device', name: 'Lens model (names the phone)' });
    expect(has(out, 'iPhone')).toBe(false);
    expect(verdict.status).toBe('clean');
    const tags = exifDump([path])[path];
    expect(tags['ExifIFD:LensModel']).toBeUndefined();
    expect(tags['ExifIFD:FNumber']).toBeDefined();
  });
});

describe('S9 HEIC: other pictures in the file are listed, not hidden', () => {
  it('an ImageIO HEIC with a preview item: "Preview image" is kept, with the reason, and the copy verifies clean', () => {
    const input = readFileSync(join(__dirname, 'fixtures-review', 'thumb.heic'));
    const { verdict, before } = run('thumb.heic', input);
    expect(before.fields.find((f) => f.id === 'heif:Image:thumbnail')).toMatchObject({ name: 'Preview image', value: 'kept unchanged' });
    expect(verdict.status).toBe('clean');
    expect(verdict.after.fields.map((f) => f.id)).toContain('heif:Image:thumbnail');
  });
});
