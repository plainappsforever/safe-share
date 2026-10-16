/** @jest-environment node */
// V1.5-1 acceptance ("More files in", Devices: none): TIFF, DNG, GIF and 3GP are cleaned and verified, camera RAW is
// inspected only, audio stays declined. Every cleaned file × profile is judged by
//  - the engine's own verify() (3 readers: structure, signature scan, the separate scan),
//  - ExifTool 13.59 against the manifest (scripts/lib/referee.js),
//  - the independent Python structure reader (scripts/referee/structure.py, stdlib only, no engine code): picture data
//    hash, directories and blocks left,
//  - ImageIO via `sips` (decoded pixels identical).
// libtiff's `tiffcmp` was tried and dropped: it returns 0 without comparing the picture data as soon as a tag differs
// (checked with a deliberately changed strip, 2026-10-16), so it cannot referee a cleaned copy (WORKFLOW L14).
// Outputs stay in artifacts/engine-out-v15/<profile>/ (overwritten each run).
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { exifDump, loadManifest, lostKept, ROOT, survivors, valueEquals, type ManifestEntry, type Tags } from '../scripts/lib/referee';
import { nodeFileIo } from './node-file-io';
import { openNodeByteFile } from './node-byte-file';

import { MAX_READ_BYTES, type ByteFile } from '@/engine/byte-file';
import { clean, CleanError, type CleanOptions } from '@/engine/clean';
import { IN_PLACE_FORMATS, inspect } from '@/engine/inspect';
import { runToEnd } from '@/engine/io';
import { PROFILES, type Profile } from '@/engine/profiles';
import { sniff } from '@/engine/sniff';
import { sweepSteps } from '@/engine/sweep';
import { verify } from '@/engine/verify';
import { cleanFile } from '@/lib/pipeline';
import { strings } from '@/lib/strings';
import { declineMessage } from '@/lib/summary';

const FIX = join(ROOT, 'test', 'fixtures');
const OUT = join(ROOT, 'artifacts', 'engine-out-v15');
const manifest = loadManifest();
const V15 = ['photo.tiff', 'pages.tiff', 'photo.dng', 'meta.gif', 'anim.gif', 'video.3gp'];
const outPath = (p: Profile, n: string) => join(OUT, p, n);

function cleanTo(name: string, profile: Profile, out: string, opts: CleanOptions = {}) {
  const src = openNodeByteFile(join(FIX, name));
  const inPlace = IN_PLACE_FORMATS.includes(sniff(src));
  if (inPlace) copyFileSync(join(FIX, name), out);
  else writeFileSync(out, new Uint8Array(0));
  const dst = openNodeByteFile(out, true);
  try {
    const result = clean(src, dst, profile, { ...opts, dstIsCopy: inPlace });
    const verdict = verify({ src, dst, before: result.before, profile });
    return { result, verdict };
  } finally {
    src.close();
    dst.close();
  }
}

function verifyFile(name: string, file: string, profile: Profile) {
  const src = openNodeByteFile(join(FIX, name));
  const dst = openNodeByteFile(file);
  try {
    return verify({ src, dst, before: inspect(src), profile });
  } finally {
    src.close();
    dst.close();
  }
}

interface PyTiff {
  format: 'tiff';
  dirs: { name: string; role: string; tags: { tag: number }[] }[];
  dataSha256: string;
  decodeSha256: string;
  extraTags: number[];
  ascii: string[];
  errors: string[];
  unreferencedNonZero: number;
  largestGap: number;
  uniqueCameraModel: string[];
}
interface PyGif {
  format: 'gif';
  pictureSha256: string;
  blocks: { label: number; app?: string; length: number; subBlocks: number[]; payloadSha256?: string }[];
  comments: string[];
  plainText: string[];
  afterTrailer: number;
  frames: number;
  errors: string[];
}
function python(files: string[]): Record<string, PyTiff | PyGif> {
  const r = spawnSync('python3', ['-I', join(ROOT, 'scripts', 'referee', 'structure.py'), ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`structure.py failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Decoded pixels via ImageIO (sips → BMP: no metadata in the output, so originals and copies compare byte for byte). */
function pixels(file: string, tag: string): Buffer {
  const bmp = join(OUT, 'decoded', `${tag}.bmp`);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'bmp', file, '--out', bmp], { stdio: 'ignore' });
  const b = readFileSync(bmp);
  return b.subarray(b.readUInt32LE(10));
}

type Run = ReturnType<typeof cleanTo>;
const runs: Record<Profile, Record<string, Run>> = { all: {}, location: {}, camera: {} };
let dumps: Record<string, Tags> = {};
let py: Record<string, PyTiff | PyGif> = {};
const cases = PROFILES.flatMap((p) => V15.map((n) => [p, n] as [Profile, string]));

beforeAll(() => {
  mkdirSync(join(OUT, 'decoded'), { recursive: true });
  mkdirSync(join(OUT, 'injected'), { recursive: true });
  for (const p of PROFILES) {
    mkdirSync(join(OUT, p), { recursive: true });
    for (const n of V15) runs[p][n] = cleanTo(n, p, outPath(p, n));
  }
  dumps = exifDump(PROFILES.flatMap((p) => V15.map((n) => outPath(p, n))));
  const pyFiles = V15.filter((n) => manifest.files[n].format !== 'mp4');
  py = python([...pyFiles.map((n) => join(FIX, n)), ...PROFILES.flatMap((p) => pyFiles.map((n) => outPath(p, n)))]);
});

describe('engine verdict (3 readers)', () => {
  it.each(cases)('%s / %s: verified clean, picture unchanged', (p, n) => {
    const { verdict } = runs[p][n];
    expect({ status: verdict.status, survivors: verdict.survivors, problems: verdict.problems }).toEqual({ status: 'clean', survivors: [], problems: [] });
    expect(verdict.pictureUnchanged).toBe(true);
    expect(verdict.readers).toBe(3);
  });
});

describe('ExifTool referee: "Remove everything" leaves none of the sensitive values and keeps what the picture needs', () => {
  it.each(V15)('%s', (n) => {
    const e = manifest.files[n];
    const file = outPath('all', n);
    expect(survivors(e, dumps[file], readFileSync(file))).toEqual([]);
    expect(lostKept(e, dumps[file])).toEqual([]);
  });
});

describe('ExifTool referee: "Location only" removes every location value and keeps the rest', () => {
  it.each(V15)('%s', (n) => {
    const e = manifest.files[n];
    const file = outPath('location', n);
    const tags = dumps[file];
    const locOnly: ManifestEntry = { ...e, sensitive: Object.fromEntries(e.location.map((k) => [k, e.sensitive[k]])), cameraSettings: {}, rawStrings: [] };
    // The GPS date "2025:06:14" is also the first half of the kept DateTimeOriginal (same rule as engine-images.test.ts).
    const left = survivors(locOnly, tags, readFileSync(file)).filter((hit) => {
      const m = /^(.*) \(under another tag\)$/.exec(hit);
      if (!m) return true;
      const value = String(locOnly.sensitive[m[1]]);
      const carriers = Object.entries(tags).filter(([k, v]) => !k.startsWith('System:') && !k.startsWith('ExifTool:') && String(v).includes(value)).map(([k]) => k);
      return !carriers.every((k) => !e.location.includes(k) && /(DateTimeOriginal|CreateDate|DateCreated|ModifyDate|PreviewDateTime)$/.test(k));
    });
    expect(left).toEqual([]);
    const mustStay = ['ExifIFD:DateTimeOriginal', 'IFD0:Make', 'IFD0:Model', 'IFD0:Artist', 'File:Comment', 'UserData:Author', 'XMP-dc:Creator'].filter(
      (k) => k in e.sensitive && !e.location.includes(k),
    );
    const lost = [...mustStay, ...Object.keys(e.cameraSettings), ...Object.keys(e.keep)].filter((k) => {
      const want = e.sensitive[k] ?? e.cameraSettings[k] ?? e.keep[k];
      return !(k in tags) || !valueEquals(tags[k], want);
    });
    expect(lost).toEqual([]);
  });
});

describe('ExifTool referee: "Keep camera settings" keeps exposure, aperture, ISO, focal length and removes the rest', () => {
  it.each(V15)('%s', (n) => {
    const e = manifest.files[n];
    const file = outPath('camera', n);
    const tags = dumps[file];
    expect(survivors(e, tags, readFileSync(file), { includeCameraSettings: false })).toEqual([]);
    // Video keeps no camera settings: "Keep camera settings" is "Remove everything" there (SPEC F3).
    const lost = Object.entries({ ...(e.format === 'mp4' ? {} : e.cameraSettings), ...e.keep })
      .filter(([k, v]) => !(k in tags) || !valueEquals(tags[k], v))
      .map(([k]) => k);
    expect(lost).toEqual([]);
  });
});

describe('independent Python structure referee', () => {
  const pyCases = cases.filter(([, n]) => manifest.files[n].format !== 'mp4');
  it.each(pyCases)('%s / %s: same picture data, nothing forbidden left', (p, n) => {
    const a = py[join(FIX, n)];
    const b = py[outPath(p, n)];
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    const e = manifest.files[n];
    const sensitiveText = Object.entries(e.sensitive)
      .filter(([k]) => p === 'all' || (p === 'location' ? e.location.includes(k) : !/Make|Model|Software|Date|Time/.test(k)))
      .map(([, v]) => String(v))
      .filter((v) => v.length >= 6);
    // "Location only" keeps the dates; the GPS date "2025:06:14" is part of the kept date taken.
    const keptText = p === 'location' ? Object.entries(e.sensitive).filter(([k]) => !e.location.includes(k)).map(([, v]) => String(v)) : [];
    const mustBeGone = sensitiveText.filter((s) => !keptText.some((k) => k.includes(s)));
    if (a.format === 'tiff' && b.format === 'tiff') {
      expect(b.dataSha256).toBe(a.dataSha256);
      // The decode tags of every picture (DNG colour matrices, black/white levels, CFA layout …) are byte-identical (S1c).
      expect(b.decodeSha256).toBe(a.decodeSha256);
      // Same picture directories (pages, previews, the raw image); Exif/GPS directories may go.
      expect(b.dirs.filter((d) => d.role === 'image').map((d) => d.name)).toEqual(a.dirs.filter((d) => d.role === 'image').map((d) => d.name));
      expect(b.dirs.filter((d) => d.role === 'gps' || d.role === 'private')).toEqual([]);
      // Rebuilt (D61): nothing in the copy that no structure points at, only alignment padding (S1d / M3).
      expect({ n, nonZero: b.unreferencedNonZero, gapOk: b.largestGap <= 3 }).toEqual({ n, nonZero: 0, gapOk: true });
      const tags = new Set(b.dirs.flatMap((d) => d.tags.map((t) => t.tag)));
      for (const forbidden of [0x8825, 0x927c, 0xc634, 0xc68c, 0xcea1, 0xcd41, 0xc6f5]) expect({ n, forbidden, present: tags.has(forbidden) }).toEqual({ n, forbidden, present: false });
      if (p === 'all') {
        expect(b.dirs.filter((d) => d.role !== 'image')).toEqual([]);
        // The referee's own allow-list (S1b): only decode tags, Orientation, the ICC profile and DNG's camera tag ("Camera").
        expect({ n, extra: [...new Set(b.extraTags)].filter((t) => ![0x0112, 0x8773, 0xc614].includes(t)) }).toEqual({ n, extra: [] });
        expect(b.uniqueCameraModel.filter((v) => v !== 'Camera')).toEqual([]);
      }
      for (const s of mustBeGone) expect({ n, s, inAscii: b.ascii.some((x) => x.includes(s)) }).toEqual({ n, s, inAscii: false });
    } else if (a.format === 'gif' && b.format === 'gif') {
      expect(b.pictureSha256).toBe(a.pictureSha256);
      expect(b.frames).toBe(a.frames);
      expect(b.afterTrailer).toBe(0);
      expect(b.plainText).toEqual([]);
      const apps = b.blocks.filter((x) => x.label === 0xff).map((x) => x.app);
      for (const app of apps) expect(['NETSCAPE2.0', 'ICCRGBG1012', ...(p === 'all' ? [] : ['XMP DataXMP']), ...(p === 'location' ? ['MGKIPTC0000', 'MGK8BIM0000'] : [])]).toContain(app);
      // Control blocks hold exactly their defined sub-blocks (M4); the colour profile is the original's, byte for byte.
      for (const x of b.blocks.filter((k) => k.label === 0xf9)) expect(x.subBlocks).toEqual([4]);
      for (const x of b.blocks.filter((k) => k.app === 'NETSCAPE2.0' || k.app === 'ANIMEXTS1.0')) for (const l of x.subBlocks) expect([3, 5]).toContain(l);
      const icc = (r: PyGif) => r.blocks.find((k) => k.app === 'ICCRGBG1012')?.payloadSha256;
      expect(icc(b)).toBe(icc(a));
      if (p !== 'location') expect(b.comments).toEqual([]);
    } else throw new Error(`unexpected formats ${a.format}/${b.format}`);
  });
});

describe('decoded pictures are identical (ImageIO via sips)', () => {
  const decodable = cases.filter(([, n]) => manifest.files[n].format !== 'mp4');
  it.each(decodable)('%s / %s', (p, n) => {
    const a = pixels(join(FIX, n), `orig-${n}`);
    const b = pixels(outPath(p, n), `${p}-${n}`);
    expect(b.length).toBeGreaterThan(0);
    expect(b.equals(a)).toBe(true);
  });
});

describe('inspection of the new formats', () => {
  const report = (n: string) => {
    const f = openNodeByteFile(join(FIX, n));
    try {
      return inspect(f);
    } finally {
      f.close();
    }
  };

  it('formats are told apart by their bytes: TIFF, DNG, camera RAW, GIF; 3GP goes through the MP4 path; audio stays unknown', () => {
    expect(['photo.tiff', 'pages.tiff', 'photo.dng', 'camera.nef', 'meta.gif', 'video.3gp', 'voice.m4a'].map((n) => report(n).format)).toEqual(['tiff', 'tiff', 'dng', 'raw', 'gif', 'mp4', 'unknown']);
    expect(report('voice.m4a')).toMatchObject({ supported: false, problem: 'unsupported' });
  });

  it('a DNG lists what identifies the phone and the person, in plain words', () => {
    const r = report('photo.dng');
    const by = (id: string) => r.fields.find((x) => x.id === id);
    expect(by('exif:CameraSerialNumber')).toMatchObject({ group: 'device', sensitivity: 'high', value: 'SN-DNG-777' });
    expect(by('exif:UniqueCameraModel')).toMatchObject({ group: 'device', value: 'iPhone 15 Pro' });
    expect(by('exif:OriginalRawFileName')?.value).toBe('IMG_20250614_093015.DNG');
    expect(by('exif:DNGPrivateData')).toMatchObject({ group: 'extras', value: '54 bytes' });
    expect(by('exif:LensModel')).toMatchObject({ group: 'device', name: 'Lens model (names the phone)' });
    expect(by('exif:ImageDescription')?.value).toBe('Fixture raw IFD secret description'); // inside the raw SubIFD
    expect(by('tiff:Image:preview')).toMatchObject({ name: 'Preview image', value: 'kept unchanged' });
    expect(r.findings.map((x) => x.label)).toEqual(expect.arrayContaining(['Exact location', 'Phone model and serial number', 'Maker notes (camera-specific data)']));
    expect([r.width, r.height]).toEqual([128, 96]); // the raw image, not the preview
    expect(r.inPlace).toBeUndefined(); // rebuilt into an empty file since the V1.5-1 fix round (D61)
  });

  it('a camera RAW from a camera maker is shown but never cleaned (and says why)', () => {
    const r = report('camera.nef');
    expect(r.supported).toBe(true);
    expect(r.notCleanable).toBe('Nikon camera RAW files can be inspected but not cleaned yet');
    expect(r.findings.map((x) => x.id)).toEqual(expect.arrayContaining(['location', 'device-serial', 'makernote', 'opaque']));
    const src = openNodeByteFile(join(FIX, 'camera.nef'));
    const out = join(OUT, 'injected', 'x-camera.nef');
    copyFileSync(join(FIX, 'camera.nef'), out);
    const dst = openNodeByteFile(out, true);
    expect(() => clean(src, dst, 'all', { dstIsCopy: true })).toThrow(CleanError);
    src.close();
    dst.close();
    expect(readFileSync(out).equals(readFileSync(join(FIX, 'camera.nef')))).toBe(true);
    expect(declineMessage('unsupported', r.notCleanable)).toBe(strings.result.declinedRaw);
  });

  it('ORF and RW2 magic numbers are camera RAW', () => {
    for (const magic of ['IIRO', 'IIRS', 'MMOR', 'IIU\0']) {
      const b = Buffer.alloc(64);
      b.write(magic, 0, 'latin1');
      const file = join(OUT, 'injected', 'magic.raw');
      writeFileSync(file, b);
      const f = openNodeByteFile(file);
      expect(sniff(f)).toBe('raw');
      f.close();
    }
  });

  it('GIF: comment, XMP, IPTC and data after the end are found; frames are not fields', () => {
    const r = report('meta.gif');
    expect(r.fields.map((x) => x.id)).toEqual(expect.arrayContaining(['gif:Comment', 'xmp:photoshop:City', 'xmp:dc:creator', 'iptc:By-line', 'trailer:Data', 'icc:ICC_Profile']));
    expect(r.notes).toEqual(['2 frames']);
    expect([r.width, r.height]).toEqual([64, 48]);
  });

  it('#13: hidden HEIC pictures are listed as kept, and an uncatalogued XMP name says so (P4-9)', () => {
    const f = openNodeByteFile(join(ROOT, 'test', 'fixtures-review', 'thumb.heic'));
    const heic = inspect(f);
    f.close();
    expect(heic.fields.find((x) => x.id === 'heif:Image:thumbnail')).toMatchObject({ name: 'Preview image', value: 'kept unchanged' });
    expect(report('photo.tiff').fields.find((x) => x.id === 'xmp:fixture:OwnerEmail')).toMatchObject({ name: 'Unknown field "OwnerEmail"', group: 'people', known: false });
  });

  it('3GP: the 3GPP user-data atoms have human names', () => {
    const r = report('video.3gp');
    const by = (id: string) => r.fields.find((x) => x.id === id);
    expect(by('qt:titl')).toMatchObject({ name: 'Title', value: 'Fixture 3GP secret title' });
    expect(by('qt:auth')).toMatchObject({ name: 'Author', group: 'people' });
    expect(by('qt:loci')).toMatchObject({ group: 'location', value: '48.85840, 2.29449, 35.0 m' });
    expect(r.findings.map((x) => x.label)).toEqual(expect.arrayContaining(['Exact location', 'Your name / copyright']));
  });

  it('a cleaned DNG keeps its required camera-model tag, with the neutral value "Camera" (D59), which is not listed', () => {
    const f = openNodeByteFile(outPath('all', 'photo.dng'));
    const r = inspect(f);
    f.close();
    expect(r.fields.some((x) => x.id === 'exif:UniqueCameraModel')).toBe(false);
    expect(dumps[outPath('all', 'photo.dng')]['IFD0:UniqueCameraModel']).toBe('Camera');
    expect(dumps[outPath('location', 'photo.dng')]['IFD0:UniqueCameraModel']).toBe('iPhone 15 Pro');
  });

  it('TIFF, DNG and GIF copies are rebuilt: smaller than the original, nothing zero-filled left behind (D61)', () => {
    for (const n of ['photo.tiff', 'pages.tiff', 'photo.dng', 'meta.gif']) expect({ n, smaller: readFileSync(outPath('all', n)).length < readFileSync(join(FIX, n)).length }).toEqual({ n, smaller: true });
  });

  it('the separate scan sees the metadata in the ORIGINALS (it can fail)', () => {
    const hits = (n: string, fmt: Parameters<typeof sweepSteps>[1]) => {
      const f = openNodeByteFile(join(FIX, n));
      try {
        return runToEnd(sweepSteps(f, fmt, 'all')).map((h) => h.name);
      } finally {
        f.close();
      }
    };
    expect(hits('photo.dng', 'dng')).toEqual(expect.arrayContaining(['Location', 'Maker notes', 'Private camera data']));
    expect(hits('photo.tiff', 'tiff')).toEqual(expect.arrayContaining(['Location']));
    expect(hits('meta.gif', 'gif')).toEqual(expect.arrayContaining(['Comment', 'Unknown data block', 'Data after the end of the picture', 'Location']));
  });
});

// ---- injected failures: every one must turn the verdict away from "clean" and name what is left ----

describe('verification honesty (injected failures)', () => {
  const inj = (name: string) => join(OUT, 'injected', name);

  it('TIFF: a writer that keeps the GPS latitude -> dirty "Latitude" (ExifTool agrees)', () => {
    const out = inj('gps-photo.tiff');
    const { verdict } = cleanTo('photo.tiff', 'all', out, { faultyKeep: ['exif:GPSLatitude'] });
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'exif:GPSLatitude', name: 'Latitude', reader: 'structure' }, { id: 'sweep:Location', name: 'Location', reader: 'sweep' }]));
    expect(exifDump([out])[out]['GPS:GPSLatitude']).toBe("52 deg 31' 12.00\"");
  });

  it('DNG: a writer that keeps the camera serial number -> dirty "Camera serial number"', () => {
    const { verdict } = cleanTo('photo.dng', 'all', inj('serial-photo.dng'), { faultyKeep: ['exif:CameraSerialNumber'] });
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors.map((s) => s.id)).toContain('exif:CameraSerialNumber');
  });

  it('DNG: a writer that keeps the maker note -> dirty, and the separate scan names it on its own', () => {
    const { verdict } = cleanTo('photo.dng', 'all', inj('makernote-photo.dng'), { faultyKeep: ['exif:MakerNote'] });
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'sweep:Maker notes', name: 'Maker notes', reader: 'sweep' }]));
  });

  it('GIF: a writer that keeps the comment -> dirty "Comment" from the structure and the separate scan', () => {
    const { verdict } = cleanTo('meta.gif', 'all', inj('comment-meta.gif'), { faultyKeep: ['gif:Comment'] });
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'gif:Comment', name: 'Comment', reader: 'structure' }, { id: 'sweep:Comment', name: 'Comment', reader: 'sweep' }]));
  });

  it('3GP: a writer that keeps loci -> dirty "Location"', () => {
    const { verdict } = cleanTo('video.3gp', 'all', inj('loci-video.3gp'), { faultyKeep: ['qt:loci'] });
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors.map((s) => s.id)).toContain('qt:loci');
  });

  it('DNG: a copy whose directory lost the raw image (SubIFD pointer dropped) is never "clean" (bug found by the Python referee)', () => {
    const b = Buffer.from(readFileSync(outPath('all', 'photo.dng')));
    const ifd0 = b.readUInt32LE(4);
    const n = b.readUInt16LE(ifd0);
    const entries: Buffer[] = [];
    for (let i = 0; i < n; i++) if (b.readUInt16LE(ifd0 + 2 + 12 * i) !== 0x14a) entries.push(Buffer.from(b.subarray(ifd0 + 2 + 12 * i, ifd0 + 14 + 12 * i)));
    const next = b.readUInt32LE(ifd0 + 2 + 12 * n);
    b.writeUInt16LE(entries.length, ifd0);
    entries.forEach((e, i) => e.copy(b, ifd0 + 2 + 12 * i));
    b.writeUInt32LE(next, ifd0 + 2 + 12 * entries.length);
    b.fill(0, ifd0 + 6 + 12 * entries.length, ifd0 + 6 + 12 * n);
    const file = inj('nosub-photo.dng');
    writeFileSync(file, b);
    const v = verifyFile('photo.dng', file, 'all');
    expect(v.status).not.toBe('clean');
    expect(v.problems).toContain('Picture data changed');
    expect((python([file])[file] as PyTiff).dataSha256).not.toBe((py[join(FIX, 'photo.dng')] as PyTiff).dataSha256);
  });

  it('DNG: a removed value appended after the rebuilt structure -> dirty (signature scan, unaccounted bytes, separate scan)', () => {
    const file = inj('hidden-photo.dng');
    writeFileSync(file, Buffer.concat([readFileSync(outPath('all', 'photo.dng')), Buffer.from('SN-DNG-777', 'latin1')]));
    const v = verifyFile('photo.dng', file, 'all');
    expect(v.status).toBe('dirty');
    expect(v.survivors).toEqual(
      expect.arrayContaining([
        { id: 'exif:CameraSerialNumber', name: 'Camera serial number', reader: 'signature' },
        { id: 'marker:Data outside the file structure', name: 'Data outside the file structure', reader: 'structure' },
        { id: 'sweep:Data outside the file structure', name: 'Data outside the file structure', reader: 'sweep' },
      ]),
    );
  });

  it('TIFF: Exif inside a picture strip is caught by the separate scan; the picture-data check fails too', () => {
    const b = Buffer.from(readFileSync(outPath('all', 'photo.tiff')));
    const copy = openNodeByteFile(outPath('all', 'photo.tiff'));
    const strip = inspect(copy).dataRanges[0];
    copy.close();
    expect(strip.length).toBeGreaterThan(200);
    b.write('Exif\0\0', strip.offset + 100, 'latin1'); // inside the first LZW strip of the copy
    const file = inj('exif-strip-photo.tiff');
    writeFileSync(file, b);
    const v = verifyFile('photo.tiff', file, 'all');
    expect(v.status).toBe('dirty');
    expect(v.survivors).toEqual(
      expect.arrayContaining([{ id: 'sweep:Photo metadata inside a preview picture', name: 'Photo metadata inside a preview picture', reader: 'sweep' }]),
    );
    expect(v.pictureUnchanged).toBe(false);
  });

  it('a DNG preview stored as JPEG with its own Exif is "Could not check", never "clean"', () => {
    // photo.dng with its 64x48 preview strip replaced by a tiny JPEG that carries an APP1 Exif segment.
    const b = Buffer.from(readFileSync(join(FIX, 'photo.dng')));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 16]), Buffer.from('Exif\0\0SECRETS!', 'latin1').subarray(0, 14), Buffer.from([0xff, 0xd9])]);
    const ifd0 = b.readUInt32LE(4);
    const n = b.readUInt16LE(ifd0);
    let stripAt = 0;
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + 12 * i;
      const tag = b.readUInt16LE(e);
      if (tag === 0x103) b.writeUInt16LE(7, e + 8); // Compression = JPEG
      if (tag === 0x111) stripAt = b.readUInt32LE(e + 8);
    }
    jpeg.copy(b, stripAt);
    const file = inj('jpegpreview.dng');
    writeFileSync(file, b);
    const f = openNodeByteFile(file);
    const r = inspect(f);
    f.close();
    expect(r.opaque).toContain('metadata inside an embedded preview picture');
    const out = inj('jpegpreview-clean.dng');
    writeFileSync(out, new Uint8Array(0));
    const src = openNodeByteFile(file);
    const dst = openNodeByteFile(out, true);
    const res = clean(src, dst, 'all');
    const v = verify({ src, dst, before: res.before, profile: 'all' });
    src.close();
    dst.close();
    expect(v.status).not.toBe('clean');
    expect(v.problems).toContain('Could not check: metadata inside an embedded preview picture');
  });
});

// ---- hostile and damaged files: never a crash, never "clean" for something unreadable ----

describe('hostile and damaged files', () => {
  const inspectBytes = (b: Buffer, name: string) => {
    const file = join(OUT, 'injected', name);
    writeFileSync(file, b);
    const f = openNodeByteFile(file);
    try {
      return inspect(f);
    } finally {
      f.close();
    }
  };

  it('truncated TIFF, DNG and GIF files are "could not read" (or still fully readable), never a crash', () => {
    for (const n of ['photo.tiff', 'pages.tiff', 'photo.dng', 'meta.gif', 'camera.nef']) {
      const full = readFileSync(join(FIX, n));
      for (const frac of [0.02, 0.1, 0.3, 0.5, 0.75, 0.9, 0.99]) {
        const r = inspectBytes(full.subarray(0, Math.floor(full.length * frac)), `trunc-${n}`);
        expect({ n, frac, ok: r.supported || r.problem === 'corrupt' }).toEqual({ n, frac, ok: true });
      }
    }
  });

  it('a directory that points to itself, a huge entry count, values and picture data outside the file are "could not read"', () => {
    const base = readFileSync(join(FIX, 'photo.dng'));
    const ifd0 = base.readUInt32LE(4);
    const n = base.readUInt16LE(ifd0);
    const at = (b: Buffer, tag: number) => {
      for (let i = 0; i < n; i++) if (b.readUInt16LE(ifd0 + 2 + 12 * i) === tag) return ifd0 + 2 + 12 * i;
      throw new Error(`no tag ${tag}`);
    };
    const loop = Buffer.from(base);
    loop.writeUInt32LE(ifd0, ifd0 + 2 + 12 * n); // next IFD = itself
    expect(inspectBytes(loop, 'loop.dng')).toMatchObject({ supported: false, problem: 'corrupt' });

    const huge = Buffer.from(base);
    huge.writeUInt16LE(0xffff, ifd0);
    expect(inspectBytes(huge, 'huge.dng')).toMatchObject({ supported: false, problem: 'corrupt' });

    const value = Buffer.from(base);
    value.writeUInt32LE(0x7fffffff, at(value, 0x10f) + 4); // Make count far beyond the file
    expect(inspectBytes(value, 'value.dng')).toMatchObject({ supported: false, problem: 'corrupt' });

    const strip = Buffer.from(base);
    strip.writeUInt32LE(base.length - 10, at(strip, 0x111) + 8);
    expect(inspectBytes(strip, 'strip.dng')).toMatchObject({ supported: false, problem: 'corrupt' });

    const sub = Buffer.from(base);
    sub.writeUInt32LE(base.length + 100, at(sub, 0x14a) + 8);
    expect(inspectBytes(sub, 'sub.dng')).toMatchObject({ supported: false, problem: 'corrupt' });
  });

  it('BigTIFF is not supported yet (declined, not misread)', () => {
    const b = Buffer.alloc(64);
    b.write('II+\0', 0, 'latin1');
    expect(inspectBytes(b, 'big.tif')).toMatchObject({ supported: false, problem: 'unsupported' });
  });

  it('GIF without a trailer, with an unknown block, or with XMP lacking its magic trailer', () => {
    const g = readFileSync(join(FIX, 'meta.gif'));
    const end = g.length - 'GIF-TRAILER-SECRET-DATA'.length - 1;
    expect(g[end]).toBe(0x3b);
    expect(inspectBytes(g.subarray(0, end), 'notrailer.gif')).toMatchObject({ supported: false, problem: 'corrupt' });
    const bad = Buffer.from(g);
    bad[bad.indexOf(Buffer.from([0x21, 0xff, 0x0b]))] = 0x99;
    expect(inspectBytes(bad, 'badblock.gif')).toMatchObject({ supported: false, problem: 'corrupt' });
    // XMP packet followed directly by the terminator (no magic trailer): unreadable, "Other", removed by every profile.
    const xmpAt = g.indexOf(Buffer.from('XMP DataXMP', 'latin1'));
    const head = g.subarray(0, xmpAt + 11);
    const pkt = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', 'latin1');
    const body = Buffer.concat([Buffer.from([pkt.length]), pkt, Buffer.from([0])]);
    const rest = g.subarray(g.indexOf(Buffer.from('MGKIPTC0000', 'latin1')) - 3);
    const r = inspectBytes(Buffer.concat([head, body, rest]), 'nomagic.gif');
    expect(r.supported).toBe(true);
    expect(r.fields.find((x) => x.id === 'xmp:Unreadable')).toMatchObject({ known: false, group: 'other' });
  });

  it('random damage to directory and block bytes never crashes the engine', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const statuses = new Set<string>();
    for (const n of ['photo.dng', 'photo.tiff', 'meta.gif']) {
      const base = readFileSync(join(FIX, n));
      const start = n.endsWith('.gif') ? 13 : base[0] === 0x49 ? base.readUInt32LE(4) : base.readUInt32BE(4);
      for (let k = 0; k < 60; k++) {
        const b = Buffer.from(base);
        for (let j = 0; j < 3; j++) b[Math.min(b.length - 1, start + Math.floor(rnd() * 400))] = Math.floor(rnd() * 256);
        const file = join(OUT, 'injected', `fuzz-${n}`);
        writeFileSync(file, b);
        const src = openNodeByteFile(file);
        const r = inspect(src);
        if (r.supported && !r.notCleanable) {
          const out = join(OUT, 'injected', `fuzz-out-${n}`);
          const inPlace = IN_PLACE_FORMATS.includes(sniff(src));
          if (inPlace) copyFileSync(file, out);
          else writeFileSync(out, new Uint8Array(0));
          const dst = openNodeByteFile(out, true);
          try {
            const res = clean(src, dst, 'all', { dstIsCopy: inPlace });
            statuses.add(verify({ src, dst, before: res.before, profile: 'all' }).status);
          } catch (e) {
            if (!(e instanceof CleanError)) throw e;
            statuses.add('declined');
          } finally {
            dst.close();
          }
        } else statuses.add(r.problem ?? 'not-cleanable');
        src.close();
      }
    }
    expect(statuses.size).toBeGreaterThan(1);
  });

  it('reads stay bounded on a TIFF with many strips, and inspection reads no picture data (A10)', () => {
    const strips = 2000;
    const head = Buffer.alloc(8 + 2 + 12 * 8 + 4);
    head.write('II', 0, 'latin1');
    head.writeUInt16LE(42, 2);
    head.writeUInt32LE(8, 4);
    head.writeUInt16LE(8, 8);
    const offsAt = head.length;
    const countsAt = offsAt + 4 * strips;
    const dataAt = countsAt + 4 * strips;
    const entries: [number, number, number, number][] = [
      [0x100, 3, 1, 1024], [0x101, 3, 1, strips], [0x102, 3, 1, 8], [0x103, 3, 1, 1], [0x106, 3, 1, 1], [0x111, 4, strips, offsAt], [0x116, 3, 1, 1], [0x117, 4, strips, countsAt],
    ];
    entries.forEach(([tag, type, count, v], i) => {
      const o = 10 + 12 * i;
      head.writeUInt16LE(tag, o);
      head.writeUInt16LE(type, o + 2);
      head.writeUInt32LE(count, o + 4);
      head.writeUInt32LE(v, o + 8);
    });
    const tables = Buffer.alloc(8 * strips);
    for (let i = 0; i < strips; i++) {
      tables.writeUInt32LE(dataAt + 1024 * i, 4 * i);
      tables.writeUInt32LE(1024, 4 * strips + 4 * i);
    }
    const file = join(OUT, 'injected', 'strips.tif');
    writeFileSync(file, Buffer.concat([head, tables, Buffer.alloc(1024 * strips, 7)]));
    const real = openNodeByteFile(file);
    let biggest = 0;
    let pictureBytesRead = 0;
    const spy: ByteFile = {
      get size() {
        return real.size;
      },
      read(o, l) {
        biggest = Math.max(biggest, l);
        if (o >= dataAt) pictureBytesRead += l;
        return real.read(o, l);
      },
      write: () => {
        throw new Error('read only');
      },
      close: () => real.close(),
    };
    const r = inspect(spy);
    spy.close();
    expect(r).toMatchObject({ supported: true, format: 'tiff' });
    expect(r.dataRanges).toHaveLength(strips);
    expect(biggest).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(pictureBytesRead).toBe(0);
  });
});

// ---- the app pipeline over Node files ----

describe('pipeline (Node FileIo)', () => {
  const dir = join(OUT, 'pipeline');
  it.each([
    ['photo.tiff', 'photo-TEST.tiff'],
    ['photo.dng', 'photo-TEST.dng'],
    ['meta.gif', 'photo-TEST.gif'],
    ['video.3gp', 'video-TEST.3gp'],
  ])('%s is verified clean under a neutral name', async (name, outName) => {
    const o = await cleanFile(nodeFileIo, { inputPath: join(FIX, name), originalName: name, outDir: dir, profile: 'all', code: 'TEST' });
    expect(o.status).toBe('clean');
    expect(o.outputName).toBe(outName);
    expect(existsSync(join(dir, outName))).toBe(true);
  });

  it('camera RAW and audio are declined before any copy is made', async () => {
    for (const [name, msg] of [
      ['camera.nef', 'Nikon camera RAW files can be inspected but not cleaned yet'],
      ['voice.m4a', 'Not supported yet'],
    ] as const) {
      const o = await cleanFile(nodeFileIo, { inputPath: join(FIX, name), originalName: name, outDir: dir, profile: 'all', code: 'NONE' });
      expect(o).toMatchObject({ status: 'unsupported', message: msg });
      expect(o.outputPath).toBeUndefined();
    }
  });
});
