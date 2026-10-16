/** @jest-environment node */
// P2 acceptance for images (A1–A5, A10): every image fixture × profile is cleaned by the engine, then
// judged by the independent referee (ExifTool 13.59 + raw scan, scripts/lib/referee.js), by an
// independent lossless check written here (not the engine's parser), and by the engine's own verify().
// Outputs stay in artifacts/engine-out/<profile>/ for scripts/decode-check.swift (A4).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { exifDump, loadManifest, lostKept, ROOT, survivors, valueEquals, type ManifestEntry, type Tags } from '../scripts/lib/referee';
import { MAX_READ_BYTES, type ByteFile } from '../src/engine/byte-file';
import { clean, CleanError, type CleanOptions } from '../src/engine/clean';
import { inspect } from '../src/engine/inspect';
import { PROFILES, type Profile } from '../src/engine/profiles';
import { verify } from '../src/engine/verify';

import { openNodeByteFile } from './node-byte-file';

const FIX = join(ROOT, 'test', 'fixtures');
const OUT = join(ROOT, 'artifacts', 'engine-out');
const manifest = loadManifest();
const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'heic', 'avif'];
const images = Object.entries(manifest.files)
  .filter(([, e]) => IMAGE_FORMATS.includes(e.format) && e.supported)
  .map(([n]) => n);

function cleanTo(name: string, profile: Profile, outPath: string, opts: CleanOptions = {}) {
  const src = openNodeByteFile(join(FIX, name));
  writeFileSync(outPath, new Uint8Array(0));
  const dst = openNodeByteFile(outPath, true);
  try {
    const result = clean(src, dst, profile, opts);
    const verdict = verify({ src, dst, before: result.before, profile });
    return { result, verdict };
  } finally {
    src.close();
    dst.close();
  }
}

function verifyFile(name: string, outPath: string, profile: Profile) {
  const src = openNodeByteFile(join(FIX, name));
  const dst = openNodeByteFile(outPath);
  try {
    return verify({ src, dst, before: inspect(src), profile });
  } finally {
    src.close();
    dst.close();
  }
}

type Run = ReturnType<typeof cleanTo>;
const runs: Record<Profile, Record<string, Run>> = { all: {}, location: {}, camera: {} };
let dumps: Record<string, Tags> = {};
const outPath = (p: Profile, n: string) => join(OUT, p, n);

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  for (const p of PROFILES) {
    mkdirSync(join(OUT, p), { recursive: true });
    for (const n of images) runs[p][n] = cleanTo(n, p, outPath(p, n));
  }
  dumps = exifDump(PROFILES.flatMap((p) => images.map((n) => outPath(p, n))));
});

const cases = PROFILES.flatMap((p) => images.map((n) => [p, n] as [Profile, string]));

describe('engine verdict', () => {
  it.each(cases)('%s / %s: verify() says clean, picture unchanged', (p, n) => {
    const { verdict } = runs[p][n];
    expect({ status: verdict.status, survivors: verdict.survivors, problems: verdict.problems }).toEqual({ status: 'clean', survivors: [], problems: [] });
    expect(verdict.pictureUnchanged).toBe(true);
    expect(verdict.readers).toBe(3);
  });
});

describe('A1 referee: "Remove everything" leaves none of the sensitive values and keeps orientation + ICC', () => {
  it.each(images)('%s', (n) => {
    const e = manifest.files[n];
    const file = outPath('all', n);
    const tags = dumps[file];
    expect(survivors(e, tags, readFileSync(file))).toEqual([]);
    expect(lostKept(e, tags)).toEqual([]);
  });
});

describe('A3 referee: "Location only" removes every location field, keeps the rest', () => {
  it.each(images)('%s', (n) => {
    const e = manifest.files[n];
    const file = outPath('location', n);
    const tags = dumps[file];
    const locOnly: ManifestEntry = { ...e, sensitive: Object.fromEntries(e.location.map((k) => [k, e.sensitive[k]])), cameraSettings: {}, rawStrings: [] };
    // The GPS date "2025:06:14" is also the first half of the kept DateTimeOriginal. A hit "under another
    // tag" is accepted only when every tag showing the value is a date/time tag this profile keeps.
    const left = survivors(locOnly, tags, readFileSync(file)).filter((hit) => {
      const m = /^(.*) \(under another tag\)$/.exec(hit);
      if (!m) return true;
      const value = String(locOnly.sensitive[m[1]]);
      const carriers = Object.entries(tags).filter(([k, v]) => !k.startsWith('System:') && !k.startsWith('ExifTool:') && String(v).includes(value)).map(([k]) => k);
      return !carriers.every((k) => !e.location.includes(k) && /(DateTimeOriginal|CreateDate|DateCreated|ModifyDate)$/.test(k));
    });
    expect(left).toEqual([]);
    const mustStay = ['ExifIFD:DateTimeOriginal', 'IFD0:Make', 'IFD0:Model'].filter((k) => k in e.sensitive);
    const lost = [...mustStay, ...Object.keys(e.cameraSettings), ...Object.keys(e.keep)].filter((k) => {
      const want = e.sensitive[k] ?? e.cameraSettings[k] ?? e.keep[k];
      return !(k in tags) || !valueEquals(tags[k], want);
    });
    expect(lost).toEqual([]);
  });
});

describe('A3 referee: "Keep camera settings" keeps exposure/aperture/ISO/focal length/lens, removes the rest', () => {
  it.each(images)('%s', (n) => {
    const e = manifest.files[n];
    const file = outPath('camera', n);
    const tags = dumps[file];
    expect(survivors(e, tags, readFileSync(file), { includeCameraSettings: false })).toEqual([]);
    const lost = Object.entries({ ...e.cameraSettings, ...e.keep }).filter(([k, v]) => !(k in tags) || !valueEquals(tags[k], v)).map(([k]) => k);
    expect(lost).toEqual([]);
  });
});

// ---- A2: independent lossless checks (own minimal walkers, not the engine's parsers) ----

function jpegScanStart(b: Buffer): number {
  let p = 2;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new Error('bad marker');
    const m = b[p + 1];
    if (m === 0xda) return p;
    p += 2 + b.readUInt16BE(p + 2);
  }
  throw new Error('no SOS');
}

function pngChunks(b: Buffer, types: string[]): Buffer {
  const parts: Buffer[] = [];
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (types.includes(type)) parts.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  return Buffer.concat(parts);
}

function riffChunks(b: Buffer, types: string[]): Buffer {
  const parts: Buffer[] = [];
  for (let p = 12; p + 8 <= b.length; ) {
    const len = b.readUInt32LE(p + 4);
    const type = b.toString('latin1', p, p + 4);
    if (types.includes(type)) parts.push(b.subarray(p, p + 8 + len));
    p += 8 + len + (len & 1);
  }
  return Buffer.concat(parts);
}

/** Exif/XMP item payload ranges as ExifTool's verbose iloc listing reports them (independent of the engine). */
function heifMetadataExtents(file: string): { offset: number; length: number }[] {
  const out = execFileSync('/usr/bin/perl', [join(ROOT, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool'), '-v2', file], { encoding: 'utf8' });
  const types = new Map<string, string>();
  for (const m of out.matchAll(/Item (\d+): Type=(\w+)/g)) types.set(m[1], m[2]);
  const holes: { offset: number; length: number }[] = [];
  for (const m of out.matchAll(/Item (\d+): const_meth=\S* base=0x([0-9a-f]+) offset=0x([0-9a-f]+) len=0x([0-9a-f]+)/g)) {
    if (types.get(m[1]) === 'Exif' || types.get(m[1]) === 'mime') holes.push({ offset: parseInt(m[2], 16) + parseInt(m[3], 16), length: parseInt(m[4], 16) });
  }
  return holes;
}

describe('A2 lossless (independent check)', () => {
  it.each(cases)('%s / %s', (p, n) => {
    const src = readFileSync(join(FIX, n));
    const dst = readFileSync(outPath(p, n));
    const fmt = manifest.files[n].format;
    if (fmt === 'jpeg') {
      // SOS..EOI of the output must be exactly the source's SOS..EOI, and the output ends there.
      const a = jpegScanStart(src);
      const b = jpegScanStart(dst);
      const scan = dst.subarray(b);
      expect(scan.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
      expect(src.subarray(a, a + scan.length).equals(scan)).toBe(true);
      expect(dst.length).toBeLessThan(src.length);
    } else if (fmt === 'png') {
      expect(pngChunks(dst, ['IDAT']).equals(pngChunks(src, ['IDAT']))).toBe(true);
      expect(pngChunks(dst, ['IHDR', 'PLTE', 'tRNS', 'iCCP']).equals(pngChunks(src, ['IHDR', 'PLTE', 'tRNS', 'iCCP']))).toBe(true);
    } else if (fmt === 'webp') {
      const t = ['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP'];
      expect(riffChunks(dst, t).equals(riffChunks(src, t))).toBe(true);
      expect(dst.readUInt32LE(4)).toBe(dst.length - 8);
    } else {
      // HEIC: same length; every differing byte lies inside the Exif/XMP item payloads.
      expect(dst.length).toBe(src.length);
      const holes = heifMetadataExtents(join(FIX, n));
      expect(holes.length).toBe(2);
      let changed = 0;
      for (let i = 0; i < src.length; i++) {
        if (src[i] === dst[i]) continue;
        changed++;
        expect({ i, inside: holes.some((h) => i >= h.offset && i < h.offset + h.length) }).toEqual({ i, inside: true });
      }
      expect(changed).toBeGreaterThan(0);
    }
  });
});

describe('inspection (F2)', () => {
  it('every field in every image fixture has a human name, a group and a sensitivity; unknown ones are "Other"', () => {
    const unknown: string[] = [];
    for (const n of images) {
      const f = openNodeByteFile(join(FIX, n));
      const r = inspect(f);
      f.close();
      expect(r.supported).toBe(true);
      for (const x of r.fields) {
        expect(x.name.length).toBeGreaterThan(0);
        expect(x.group).toBeTruthy();
        expect(x.sensitivity).toBeTruthy();
        if (!x.known) unknown.push(`${n} ${x.id}`);
      }
      const others = r.fields.filter((x) => !x.known).length;
      if (others) expect(r.findings.map((x) => x.label)).toContain(`Other (${others} fields)`);
    }
    // Only the fixtures' deliberately private namespace (XMP-fixture) is unknown to the catalogue.
    expect(unknown.filter((u) => !u.includes('xmp:fixture:'))).toEqual([]);
  });

  it('findings name the dangerous things in plain words; a metadata-free photo says so', () => {
    const labels = (n: string) => {
      const f = openNodeByteFile(join(FIX, n));
      const r = inspect(f);
      f.close();
      return r.findings.map((x) => x.label);
    };
    expect(labels('photo.jpg')).toEqual(expect.arrayContaining(['Exact location', 'Phone model and serial number', 'Date and time taken', 'Your name / copyright', 'Editing app']));
    expect(labels('extras.jpg')).toEqual(expect.arrayContaining(['Hidden preview image', 'Maker notes (camera-specific data)']));
    expect(labels('motion.jpg')).toContain('Motion-photo video');
    expect(labels('ultrahdr.jpg')).toContain('HDR brightness data');
    expect(labels('nometa.jpg')).toEqual(['No personal data found']);
  });

  it('reads location, serial and dimensions with human names', () => {
    const f = openNodeByteFile(join(FIX, 'photo.jpg'));
    const r = inspect(f);
    f.close();
    const by = (id: string) => r.fields.find((x) => x.id === id);
    expect(by('exif:GPSLatitude')).toMatchObject({ name: 'Latitude', group: 'location', value: `52° 31' 12"` });
    expect(by('exif:SerialNumber')).toMatchObject({ name: 'Camera serial number', group: 'device', value: 'SN-FIXTURE-123' });
    expect(by('iptc:City')).toMatchObject({ name: 'City', group: 'location', value: 'Berlin' });
    expect(by('icc:ICC_Profile')?.value).toBe('Display P3');
    expect([r.width, r.height]).toEqual([320, 240]); // ExifTool File:ImageWidth/Height of the fixture
  });

  it('corrupt and unsupported files are reported, never cleaned', () => {
    for (const [n, problem] of [['corrupt.jpg', 'corrupt'], ['voice.m4a', 'unsupported']] as const) {
      const f = openNodeByteFile(join(FIX, n));
      expect(inspect(f)).toMatchObject({ supported: false, problem });
      const outFile = join(OUT, `x-${n}`);
      writeFileSync(outFile, new Uint8Array(0));
      const d = openNodeByteFile(outFile, true);
      expect(() => clean(f, d, 'all')).toThrow(CleanError);
      expect(d.size).toBe(0);
      f.close();
      d.close();
      rmSync(outFile);
    }
  });

  it('the original is never written to (D18)', () => {
    for (const n of images) {
      const before = readFileSync(join(FIX, n));
      cleanTo(n, 'all', join(OUT, 'd18.tmp'));
      expect(readFileSync(join(FIX, n)).equals(before)).toBe(true);
    }
    rmSync(join(OUT, 'd18.tmp'));
  });
});

// ---- A5: injected failures must turn the verdict to "dirty" naming the field ----

describe('A5 verification honesty (injected failures)', () => {
  const inj = join(OUT, 'injected');
  beforeAll(() => mkdirSync(inj, { recursive: true }));

  const faulty = (name: string, profile: Profile, ids: string[]) => {
    const out = join(inj, `${ids[0].replace(/[^a-z0-9]/gi, '_')}-${name}`);
    const run = cleanTo(name, profile, out, { faultyKeep: ids });
    return { ...run, out };
  };

  it('a writer that leaves one GPS tag -> dirty "Latitude" (and ExifTool agrees)', () => {
    const { verdict, out } = faulty('photo.jpg', 'all', ['exif:GPSLatitude']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'exif:GPSLatitude', name: 'Latitude', reader: 'structure' }, { id: 'exif:GPSLatitude', name: 'Latitude', reader: 'signature' }]));
    expect(Object.keys(exifDump([out])[out])).toContain('GPS:GPSLatitude');
  });

  it('a writer that leaves the serial number in XMP -> dirty "Camera serial number"', () => {
    const { verdict, out } = faulty('photo.png', 'all', ['xmp:exifEX:BodySerialNumber']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'xmp:exifEX:BodySerialNumber', name: 'Camera serial number', reader: 'structure' }]));
    expect(verdict.survivors.map((s) => s.reader)).toContain('signature');
    expect(exifDump([out])[out]['XMP-exifEX:SerialNumber']).toBe('SN-FIXTURE-123');
  });

  it('a writer that leaves the IPTC city -> dirty "City" (Location only)', () => {
    const { verdict, out } = faulty('photo.jpg', 'location', ['iptc:City']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'iptc:City', name: 'City', reader: 'structure' }, { id: 'iptc:City', name: 'City', reader: 'signature' }]));
    expect(exifDump([out])[out]['IPTC:City']).toBe('Berlin');
  });

  it('HEIC: a writer that leaves the GPS latitude in the Exif item -> dirty', () => {
    const { verdict } = faulty('photo.heic', 'all', ['exif:GPSLatitude']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors.map((s) => s.id)).toContain('exif:GPSLatitude');
  });

  it('the signature scan alone catches a value hidden where the parser does not look (inside the kept ICC profile)', () => {
    const clean1 = readFileSync(outPath('all', 'photo.jpg'));
    const at = clean1.indexOf(Buffer.from('ICC_PROFILE\0', 'latin1')) + 14 + 200;
    const hidden = Buffer.from(clean1);
    hidden.write('SN-FIXTURE-123', at, 'latin1');
    const file = join(inj, 'icc-serial.jpg');
    writeFileSync(file, hidden);
    const v = verifyFile('photo.jpg', file, 'all');
    expect(v.status).toBe('dirty');
    expect(v.survivors).toEqual([{ id: 'exif:SerialNumber', name: 'Camera serial number', reader: 'signature' }]);

    const marker = Buffer.from(clean1);
    marker.write('<x:xmpmeta', at, 'latin1');
    writeFileSync(file, marker);
    expect(verifyFile('photo.jpg', file, 'all').survivors).toEqual([{ id: 'marker:XMP block', name: 'XMP block', reader: 'signature' }]);
  });

  it('a changed picture byte is never "clean"', () => {
    const b = Buffer.from(readFileSync(outPath('all', 'photo.jpg')));
    b[b.length - 100] ^= 0x01;
    const file = join(inj, 'pixel.jpg');
    writeFileSync(file, b);
    const v = verifyFile('photo.jpg', file, 'all');
    expect(v.status).toBe('unverified');
    expect(v.pictureUnchanged).toBe(false);
  });

  it('a platform reader that still sees GPS makes it dirty (reader 3)', () => {
    const src = openNodeByteFile(join(FIX, 'photo.jpg'));
    const dst = openNodeByteFile(outPath('all', 'photo.jpg'));
    const before = inspect(src);
    const gps = before.fields.find((f) => f.id === 'exif:GPSLatitude')!;
    const v = verify({ src, dst, before, profile: 'all', platform: { fields: [gps] } });
    expect(v.readers).toBe(4);
    expect(v.survivors).toEqual([{ id: 'exif:GPSLatitude', name: 'Latitude', reader: 'platform' }]);
    expect(verify({ src, dst, before, profile: 'all', platform: { fields: [] } }).status).toBe('clean');
    src.close();
    dst.close();
  });

  it('HEIC is rebuilt from an allow-list (P7.5), never patched on a native copy: a filled destination is refused', () => {
    const file = join(inj, 'copy.heic');
    copyFileSync(join(FIX, 'photo.heic'), file);
    const src = openNodeByteFile(join(FIX, 'photo.heic'));
    const dst = openNodeByteFile(file, true);
    expect(() => clean(src, dst, 'all', { dstIsCopy: true })).toThrow('destination must be empty');
    src.close();
    dst.close();
  });
});

// ---- A10: bounded reads on a 50 MB JPEG ----

/** In-memory ByteFile that records the largest single read and refuses reads above the cap. */
function memFile(initial: Uint8Array, capacity = initial.length) {
  let buf = new Uint8Array(Math.max(capacity, initial.length));
  buf.set(initial);
  let size = initial.length;
  const stats = { maxRead: 0, reads: 0 };
  const f: ByteFile = {
    get size() {
      return size;
    },
    read(offset, length) {
      if (length > MAX_READ_BYTES) throw new RangeError(`read of ${length}`);
      stats.maxRead = Math.max(stats.maxRead, length);
      stats.reads++;
      return buf.slice(offset, Math.min(size, offset + length));
    },
    write(offset, bytes) {
      if (offset + bytes.length > buf.length) {
        const nb = new Uint8Array(Math.max(buf.length * 2, offset + bytes.length));
        nb.set(buf);
        buf = nb;
      }
      buf.set(bytes, offset);
      size = Math.max(size, offset + bytes.length);
    },
    close() {},
  };
  return { f, stats, bytes: () => buf.subarray(0, size) };
}

describe('A10 bounded memory', () => {
  it('cleans and verifies a 50 MB JPEG without any read above 4 MB', () => {
    const photo = readFileSync(join(FIX, 'photo.jpg'));
    const sos = jpegScanStart(photo);
    const sosLen = 2 + photo.readUInt16BE(sos + 2);
    const big = new Uint8Array(50 * 1024 * 1024);
    big.set(photo.subarray(0, sos + sosLen));
    for (let i = sos + sosLen; i < big.length - 2; i++) big[i] = (i * 7) & 0x7f; // entropy-like, no 0xFF
    big.set([0xff, 0xd9], big.length - 2);
    const src = memFile(big);
    const dst = memFile(new Uint8Array(0), 64 * 1024 * 1024);
    const r = clean(src.f, dst.f, 'all');
    const v = verify({ src: src.f, dst: dst.f, before: r.before, profile: 'all' });
    expect(v.status).toBe('clean');
    expect(src.stats.maxRead).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(dst.stats.maxRead).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(r.bytesOut).toBeGreaterThan(50 * 1024 * 1024 - 20000);
    expect(r.removed.map((x) => x.id)).toContain('exif:GPSLatitude');
  });
});

// ---- WebP animation (plan fallback case: frames kept untouched, same chunk filter) ----

describe('animated WebP', () => {
  const dir = join(OUT, 'synthetic');
  /** Builds a real 2-frame animated WebP from exif.webp's VP8L frame, ICCP, EXIF and XMP chunks. */
  function buildAnimated(): Buffer {
    const src = readFileSync(join(FIX, 'exif.webp'));
    const chunk = (t: string) => riffChunks(src, [t]);
    const le24 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
    const riff = (t: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(t, 0, 'latin1');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, Buffer.alloc(data.length & 1)]);
    };
    const vp8x = Buffer.from(chunk('VP8X').subarray(8));
    vp8x[0] |= 0x02; // animation
    const frame = (ms: number) => riff('ANMF', Buffer.concat([le24(0), le24(0), le24(0), le24(0), le24(ms), Buffer.from([0]), chunk('VP8L')]));
    const body = Buffer.concat([Buffer.from('WEBP'), riff('VP8X', vp8x), chunk('ICCP'), riff('ANIM', Buffer.from([0, 0, 0, 0, 0, 0])), frame(100), frame(200), chunk('EXIF'), chunk('XMP ')]);
    const head = Buffer.alloc(8);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  }

  it('keeps ANIM/ANMF frames byte-identical, removes EXIF/XMP values, fixes flags; verify says clean', () => {
    mkdirSync(dir, { recursive: true });
    const input = join(dir, 'anim.webp');
    const output = join(dir, 'anim-clean.webp');
    writeFileSync(input, buildAnimated());
    writeFileSync(output, new Uint8Array(0));
    const s = openNodeByteFile(input);
    const d = openNodeByteFile(output, true);
    const r = clean(s, d, 'all');
    const v = verify({ src: s, dst: d, before: r.before, profile: 'all' });
    s.close();
    d.close();
    expect(v.status).toBe('clean');
    const a = readFileSync(input);
    const b = readFileSync(output);
    expect(riffChunks(b, ['ANIM', 'ANMF', 'ICCP']).equals(riffChunks(a, ['ANIM', 'ANMF', 'ICCP']))).toBe(true);
    expect(riffChunks(b, ['XMP ']).length).toBe(0);
    const flags = riffChunks(b, ['VP8X'])[8];
    expect(flags & 0x02).toBe(0x02); // still animated
    expect(flags & 0x04).toBe(0); // no XMP
    expect(flags & 0x08).toBe(0x08); // Orientation-only EXIF
    const e = manifest.files['exif.webp'];
    const tags = exifDump([output])[output];
    expect(survivors(e, tags, b)).toEqual([]);
    expect(tags['IFD0:Orientation']).toBe(e.keep['IFD0:Orientation']);
    expect(tags['ICC_Profile:ProfileDescription']).toBe(e.keep['ICC_Profile:ProfileDescription']);
  });
});

describe('cleaning is idempotent', () => {
  it.each(images)('%s: cleaning the "Remove everything" output again gives identical bytes', (n) => {
    const first = outPath('all', n);
    const again = join(OUT, `again-${n}`);
    writeFileSync(again, new Uint8Array(0));
    const s = openNodeByteFile(first);
    const d = openNodeByteFile(again, true);
    clean(s, d, 'all');
    s.close();
    d.close();
    expect(readFileSync(again).equals(readFileSync(first))).toBe(true);
    rmSync(again);
  });
});

describe('hidden data outside the usual blocks', () => {
  it('PNG: an unknown private chunk and bytes after IEND are listed, removed, and the result verifies clean', () => {
    const dir = join(OUT, 'synthetic');
    mkdirSync(dir, { recursive: true });
    const src = readFileSync(join(FIX, 'text.png'));
    const iend = src.length - 12;
    const priv = Buffer.alloc(12 + 14);
    priv.writeUInt32BE(14, 0);
    priv.write('prVt', 4, 'latin1');
    priv.write('private-secret', 8, 'latin1'); // CRC left zero: the chunk is dropped anyway
    const input = join(dir, 'hidden.png');
    writeFileSync(input, Buffer.concat([src.subarray(0, iend), priv, src.subarray(iend), Buffer.from('AFTER-IEND-SECRET')]));
    const output = join(dir, 'hidden-clean.png');
    writeFileSync(output, new Uint8Array(0));
    const s = openNodeByteFile(input);
    const d = openNodeByteFile(output, true);
    const r = clean(s, d, 'location');
    const v = verify({ src: s, dst: d, before: r.before, profile: 'location' });
    s.close();
    d.close();
    expect(r.removed.map((f) => f.id)).toEqual(expect.arrayContaining(['png:chunk:prVt', 'trailer:Data']));
    expect(v.status).toBe('clean');
    const out = readFileSync(output);
    expect(out.includes(Buffer.from('private-secret'))).toBe(false);
    expect(out.includes(Buffer.from('AFTER-IEND'))).toBe(false);
    expect(out.subarray(-12).toString('latin1', 4, 8)).toBe('IEND');
  });
});

// ---- P2-3 (resolved in P3): compressed PNG text is inflated with pako, shown, scanned and removed ----

describe('compressed PNG text (zTXt, compressed iTXt)', () => {
  const dir = join(OUT, 'synthetic');

  /** text.png with its XMP iTXt chunk re-written COMPRESSED (flag 1, method 0). */
  function compressedXmpPng(): Buffer {
    const src = readFileSync(join(FIX, 'text.png'));
    const parts: Buffer[] = [src.subarray(0, 8)];
    for (let p = 8; p < src.length; ) {
      const len = src.readUInt32BE(p);
      const type = src.toString('latin1', p + 4, p + 8);
      const data = src.subarray(p + 8, p + 8 + len);
      if (type === 'iTXt' && data.toString('latin1', 0, 17) === 'XML:com.adobe.xmp') {
        let q = 18 + 2; // keyword\0 flag method
        q = data.indexOf(0, q) + 1; // language
        q = data.indexOf(0, q) + 1; // translated keyword
        const body = Buffer.concat([Buffer.from('XML:com.adobe.xmp\0', 'latin1'), Buffer.from([1, 0, 0, 0]), deflateSync(data.subarray(q))]);
        const head = Buffer.alloc(8);
        head.writeUInt32BE(body.length, 0);
        head.write('iTXt', 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('iTXt'), body])) >>> 0);
        parts.push(head, body, crc);
      } else parts.push(src.subarray(p, p + 12 + len));
      p += 12 + len;
    }
    return Buffer.concat(parts);
  }

  it('text.png: the zTXt comment is read (not "(compressed)")', () => {
    const f = openNodeByteFile(join(FIX, 'text.png'));
    const r = inspect(f);
    f.close();
    expect(r.fields.find((x) => x.id === 'png:Comment')).toMatchObject({ name: 'Comment', group: 'people', value: 'Fixture zTXt secret comment', known: true });
    expect(r.opaque).toEqual([]);
  });

  it('compressed XMP iTXt is parsed, removed and verified; a faulty writer keeping the zTXt is caught by both readers', () => {
    mkdirSync(dir, { recursive: true });
    const input = join(dir, 'ztxt-xmp.png');
    writeFileSync(input, compressedXmpPng());
    const tagsIn = exifDump([input])[input];
    expect(tagsIn['XMP-dc:Creator']).toBe('Text Fixture XMP'); // ExifTool reads the compressed packet too
    const s = openNodeByteFile(input);
    expect(inspect(s).fields.find((x) => x.id === 'xmp:dc:creator')?.value).toBe('Text Fixture XMP');
    const out = join(dir, 'ztxt-xmp-clean.png');
    writeFileSync(out, new Uint8Array(0));
    const d = openNodeByteFile(out, true);
    const r = clean(s, d, 'all');
    const v = verify({ src: s, dst: d, before: r.before, profile: 'all' });
    d.close();
    expect(v.status).toBe('clean');
    const tags = exifDump([out])[out];
    expect(survivors(manifest.files['text.png'], tags, readFileSync(out))).toEqual([]);

    const bad = join(dir, 'ztxt-faulty.png');
    writeFileSync(bad, new Uint8Array(0));
    const d2 = openNodeByteFile(bad, true);
    const r2 = clean(s, d2, 'all', { faultyKeep: ['png:Comment'] });
    const v2 = verify({ src: s, dst: d2, before: r2.before, profile: 'all' });
    d2.close();
    s.close();
    expect(v2.status).toBe('dirty');
    expect(v2.survivors).toEqual([
      { id: 'png:Comment', name: 'Comment', reader: 'structure' },
      { id: 'png:Comment', name: 'Comment', reader: 'signature' },
    ]);
  });
});
