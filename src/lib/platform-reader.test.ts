/** @jest-environment node */
/**
 * Reader 3 (D11, D44) with outputs RECORDED on the iOS simulator (ImageIO/AVFoundation/PDFKit) and the Android emulator
 * (metadata-extractor 2.21.0 + MediaMetadataRetriever): `test/platform/<ios|android>/clean/<fixture>.json` = the reader's
 * output for the cleaned copy ("Remove everything"), `…/original/<fixture>.json` = for the original file (dev injection).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeFileIo } from '../../test/node-file-io';
import { openNodeByteFile } from '../../test/node-byte-file';

import { clean } from '@/engine/clean';
import { inspect } from '@/engine/inspect';
import { verify } from '@/engine/verify';

import { cleanFile, type FileIo } from './pipeline';
import { isBlank, parseRaw, platformFields, platformKind } from './platform-reader';

const fixture = (n: string) => join(process.cwd(), 'test/fixtures', n);
const sample = (os: string, kind: 'clean' | 'original', name: string) => join(process.cwd(), 'test/platform', os, kind, `${name}.json`);
const out = () => mkdtempSync(join(tmpdir(), 'ss-p6-'));
const read = (p: string) => readFileSync(p, 'utf8');

/** FileIo whose reader 3 answers with a recorded output (for any path). */
const withReader = (json: string | ((path: string) => string)): FileIo => ({
  ...nodeFileIo,
  readPlatform: async (path) => (typeof json === 'string' ? json : json(path)),
});

const CLEANED = ['photo.jpg', 'progressive.jpg', 'extras.jpg', 'photo.png', 'exif.webp', 'photo.heic', 'gps.mov', 'gps.mp4', 'doc.pdf', 'revised.pdf'];

describe.each(['ios', 'android'])('%s platform reader, recorded outputs', (os) => {
  it.each(CLEANED)('%s: the recorded output of the cleaned copy agrees — Verified clean', async (name) => {
    const o = await cleanFile(withReader(read(sample(os, 'clean', name))), { inputPath: fixture(name), originalName: name, outDir: out(), profile: 'all' });
    expect(o.verdict?.survivors).toEqual([]);
    expect(o.status).toBe('clean');
    const pdfOnAndroid = os === 'android' && name.endsWith('.pdf');
    expect(o.verdict?.readers).toBe(pdfOnAndroid ? 3 : 4);
    expect(o.platform?.status).toBe(pdfOnAndroid ? 'none' : 'ran');
  });

  it.each(['photo.jpg', 'photo.heic', 'photo.png', 'exif.webp', 'gps.mov'])(
    '%s: the reader reporting the ORIGINAL (injected failure) makes the copy Not fully clean, found by reader 3 only',
    async (name) => {
      const o = await cleanFile(withReader(read(sample(os, 'original', name))), { inputPath: fixture(name), originalName: name, outDir: out(), profile: 'all' });
      expect(o.status).toBe('dirty');
      expect(new Set(o.verdict!.survivors.map((s) => s.reader))).toEqual(new Set(['platform']));
      const names = o.verdict!.survivors.map((s) => s.name);
      expect(names).toContain(name === 'gps.mov' ? 'Location (coordinates)' : 'Latitude');
      expect(names).toContain(name === 'gps.mov' ? 'Camera or phone make' : 'Camera serial number');
    }
  );

  it('every original with metadata is seen by the reader; the one without is not', () => {
    for (const name of ['photo.jpg', 'photo.heic', 'photo.avif', 'photo.png', 'text.png', 'exif.webp', 'extras.jpg', 'motion.jpg', 'ultrahdr.jpg', 'gps.mov', 'gps.mp4']) {
      const before = inspect(openNodeByteFile(fixture(name)));
      expect([name, platformFields(parseRaw(read(sample(os, 'original', name))), before, 'all').length > 0]).toEqual([name, true]);
    }
    const nometa = inspect(openNodeByteFile(fixture('nometa.jpg')));
    expect(platformFields(parseRaw(read(sample(os, 'original', 'nometa.jpg'))), nometa, 'all')).toEqual([]);
  });

  it('under "Location only" the original fails on what that profile removes, never on what it keeps', async () => {
    const o = await cleanFile(withReader(read(sample(os, 'original', 'photo.jpg'))), { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: out(), profile: 'location' });
    expect(o.status).toBe('dirty');
    const names = o.verdict!.survivors.map((s) => s.name);
    expect(names).toContain('Latitude');
    for (const kept of ['Camera or phone make', 'Camera or phone model', 'Date and time taken', 'Exposure time']) expect(names).not.toContain(kept);
    const keptIds = new Set(o.result!.kept.map((k) => k.field.id));
    for (const s of o.verdict!.survivors) expect(keptIds.has(s.id)).toBe(false);
  });
});

describe('platform reader rules', () => {
  const before = () => inspect(openNodeByteFile(fixture('photo.jpg')));

  it('blank values never count: zero dates of a cleaned video header, zeros, empty', () => {
    for (const v of ['', '  ', '0', '0/1', '0.0, 0.0', '19040101T000000.000Z', 'Fri Jan 01 01:00:00 +01:00 1904', 'Thu Dec 31 19:00:00 EST 1903', '1970-01-01T00:00:00Z', '(null)']) {
      expect([v, isBlank(v)]).toEqual([v, true]);
    }
    for (const v of ['Jane Fixture', '2025-06-14T09:30:15+0200', 'Wed Sep 30 12:59:54 +02:00 2026', '+52.5200+013.4049/', '20260930T105954.000Z']) {
      expect([v, isBlank(v)]).toEqual([v, false]);
    }
  });

  it('a removed value found anywhere in the reader output counts as that field (exact text)', () => {
    const b = before();
    const serial = b.fields.find((f) => f.id === 'exif:SerialNumber' || f.key === 'SerialNumber' || f.key === 'BodySerialNumber')!;
    const raw = { reader: 'metadata-extractor', supported: true, entries: [{ d: 'Some Vendor Directory', t: 'Weird Tag', v: serial.value }] };
    expect(platformFields(raw, b, 'all').map((f) => f.name)).toEqual([serial.name]);
    // A different value, or a directory that only describes the picture, does not count.
    const other = { reader: 'metadata-extractor', supported: true, entries: [{ d: 'JPEG', t: 'Image Height', i: 1, v: '240 pixels' }] };
    expect(platformFields(other, b, 'all')).toEqual([]);
  });

  it('technical values the platforms derive from the picture never count (ImageIO HEIF tiles, sizes, colour model)', () => {
    const b = before();
    const raw = {
      reader: 'ImageIO', supported: true, entries: [
        { d: 'image0', t: 'PixelWidth', v: '320' }, { d: 'image0.{TIFF}', t: 'TileWidth', v: '320' }, { d: 'metadata0', t: 'tiff:TileLength', v: '240' },
        { d: 'image0.{TIFF}', t: 'Orientation', v: '6' }, { d: 'image0.{JFIF}', t: 'XDensity', v: '72' }, { d: 'image0', t: 'ProfileName', v: 'Display P3' },
      ],
    };
    expect(platformFields(raw, b, 'all')).toEqual([]);
  });

  it('kinds', () => {
    expect(['jpeg', 'heic', 'avif', 'webp', 'png', 'mp4', 'mov', 'pdf', 'gif', 'tiff', 'dng', 'raw', 'unknown'].map(platformKind)).toEqual([
      'image', 'image', 'image', 'image', 'image', 'video', 'video', 'pdf', 'image', 'image', 'image', 'other', 'other',
    ]);
    expect(parseRaw('not json').error).toMatch(/unreadable/);
  });

  it('a reader that cannot read the copy but reads the original: Could not verify (never clean)', async () => {
    const dir = out();
    const failCopy = (p: string) =>
      p.includes(dir) ? JSON.stringify({ reader: 'ImageIO', supported: true, entries: [], error: 'ImageIO could not open the file' }) : read(sample('ios', 'clean', 'photo.jpg'));
    const o = await cleanFile(withReader(failCopy), { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: dir, profile: 'all' });
    expect(o.status).toBe('unverified');
    expect(o.verdict!.problems.join(' ')).toMatch(/phone's own reader \(ImageIO\) could not read the copy/);
    expect(o.verdict!.readers).toBe(3);
    expect(o.platform?.status).toBe('error');
  });

  it('a reader that cannot read this file at all (not even the original) adds no third check and changes nothing', async () => {
    const fail = JSON.stringify({ reader: 'metadata-extractor', supported: true, entries: [], error: 'File format could not be determined' });
    const o = await cleanFile(withReader(fail), { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: out(), profile: 'all' });
    expect(o.status).toBe('clean');
    expect(o.verdict!.readers).toBe(3);
    expect(o.platform).toEqual({ status: 'cannot-read', reader: 'metadata-extractor', detail: 'File format could not be determined' });
  });

  it("the reader's silence never upgrades a dirty or unverified verdict", () => {
    const dir = out();
    const silent = { fields: [], reader: 'ImageIO' };
    const src = openNodeByteFile(fixture('photo.jpg'));
    // dirty: a writer that keeps the GPS (engine test hook) — readers 1 and 2 see it, reader 3 says nothing.
    const faulty = join(dir, 'faulty.jpg');
    writeFileSync(faulty, new Uint8Array(0));
    const dst = openNodeByteFile(faulty, true);
    const res = clean(src, dst, 'all', { faultyKeep: ['exif:GPSLatitude'] });
    expect(verify({ src, dst, before: res.before, profile: 'all', platform: silent }).status).toBe('dirty');
    dst.close();
    // unverified: a correct copy with one flipped picture byte.
    const good = join(dir, 'good.jpg');
    writeFileSync(good, new Uint8Array(0));
    const g = openNodeByteFile(good, true);
    const ok = clean(src, g, 'all');
    g.close();
    const b = Buffer.from(readFileSync(good));
    b[b.length - 100] ^= 0x01;
    const flipped = join(dir, 'flipped.jpg');
    writeFileSync(flipped, b);
    const f2 = openNodeByteFile(flipped);
    const v = verify({ src, dst: f2, before: ok.before, profile: 'all', platform: silent });
    expect(v.status).toBe('unverified');
    expect(v.readers).toBe(4);
    src.close();
    f2.close();
  });

  it('without a platform reader (Jest, a build without the module) nothing changes: 3 checks', async () => {
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: out(), profile: 'all' });
    expect(o.status).toBe('clean');
    expect(o.verdict?.readers).toBe(3);
    expect(o.platform).toBeUndefined();
  });

  it('the dev injection points reader 3 at the original', async () => {
    const seen: string[] = [];
    const io = withReader((p) => {
      seen.push(p);
      return read(sample('ios', 'clean', 'photo.jpg'));
    });
    await cleanFile(io, { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: out(), profile: 'all', debugPlatformReadsInput: true });
    expect(seen).toEqual([fixture('photo.jpg')]);
    expect(existsSync(fixture('photo.jpg'))).toBe(true);
  });
});

/**
 * V1.5-1: TIFF, DNG and GIF through reader 3. These outputs are HAND-WRITTEN in the shape the native module emits (entries
 * `{d, t, v, i}`), not recorded on a device: they prove the mapping rules only. Recording real ImageIO / metadata-extractor
 * output for the new fixtures is part of the device half of V1.5-1 (IMPLEMENTED BUT UNVERIFIED until then).
 */
describe('reader 3 mapping for the V1.5-1 formats (hand-written outputs)', () => {
  const raw = (reader: string, entries: { d: string; t: string; v: string; i?: number }[]) => JSON.stringify({ reader, supported: true, entries });
  const cleanedDngIos = raw('ImageIO', [
    { d: 'image0.{DNG}', t: 'UniqueCameraModel', v: 'Camera' },
    { d: 'image0.{DNG}', t: 'DNGVersion', v: '1, 4, 0, 0' },
    { d: 'image0.{DNG}', t: 'ColorMatrix1', v: '1, -0.2, -0.1' },
    { d: 'image0.{TIFF}', t: 'Orientation', v: '6' },
    { d: 'image0.{TIFF}', t: 'Compression', v: '1' },
  ]);
  const cleanedDngAndroid = raw('metadata-extractor', [
    { d: 'Exif IFD0', t: 'Strip Offsets', v: '2274', i: 0x111 },
    { d: 'Exif IFD0', t: 'DNG Version', v: '1.4.0.0', i: 0xc612 },
    { d: 'Exif IFD0', t: 'Unique Camera Model', v: 'Camera', i: 0xc614 },
    { d: 'Exif IFD0', t: 'Color Matrix 1', v: '1 -0.2 -0.1', i: 0xc621 },
    { d: 'Exif IFD0', t: 'CFA Pattern', v: '0 1 1 2', i: 0x828e },
  ]);

  it.each([
    ['ImageIO', cleanedDngIos],
    ['metadata-extractor', cleanedDngAndroid],
  ])('%s: picture layout and the neutral camera name in a cleaned DNG are not survivors', async (_, json) => {
    const o = await cleanFile(withReader(json), { inputPath: fixture('photo.dng'), originalName: 'photo.dng', outDir: out(), profile: 'all' });
    expect(o.verdict?.survivors).toEqual([]);
    expect(o.status).toBe('clean');
    expect(o.verdict?.readers).toBe(4);
  });

  it('ImageIO reporting the camera serial number in {DNG} makes the copy Not fully clean (reader 3 only)', async () => {
    const json = raw('ImageIO', [{ d: 'image0.{DNG}', t: 'CameraSerialNumber', v: 'SN-SOMETHING-ELSE' }]);
    const o = await cleanFile(withReader(json), { inputPath: fixture('photo.dng'), originalName: 'photo.dng', outDir: out(), profile: 'all' });
    expect(o.status).toBe('dirty');
    expect(o.verdict?.survivors).toEqual([{ id: 'exif:CameraSerialNumber', name: 'Camera serial number', reader: 'platform' }]);
  });

  it('metadata-extractor reporting a GIF comment makes the copy Not fully clean; "Location only" keeps comments', async () => {
    const json = raw('metadata-extractor', [{ d: 'GIF Comment', t: 'Comment', v: 'some comment' }]);
    const all = await cleanFile(withReader(json), { inputPath: fixture('meta.gif'), originalName: 'meta.gif', outDir: out(), profile: 'all' });
    expect(all.status).toBe('dirty');
    expect(all.verdict?.survivors.map((s) => s.reader)).toEqual(['platform']);
    const loc = await cleanFile(withReader(json), { inputPath: fixture('meta.gif'), originalName: 'meta.gif', outDir: out(), profile: 'location' });
    expect(loc.status).toBe('clean');
  });
});
