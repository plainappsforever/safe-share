/** @jest-environment node */
// P3 acceptance for video (A1, A2, A3, A5): every video fixture × profile, plus a synthetic MP4 with a CAMM
// track (co64), a GoPro gpmd track (stco), a `meta` inside a `trak` and an XMP `uuid` box
// (test/isobmff-builder.ts), is cleaned by the engine and judged by the independent referee (ExifTool 13.59
// + raw scan), by an independent mdat check written here, and by the engine's own verify().
// Outputs stay in artifacts/engine-out-video/<profile>/ for scripts/decode-check.swift (A4).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { exifDump, loadManifest, lostKept, ROOT, survivors, valueEquals, type ManifestEntry, type Tags } from '../scripts/lib/referee';
import { clean, type CleanOptions } from '../src/engine/clean';
import { inspect } from '../src/engine/inspect';
import { PROFILES, type Profile } from '../src/engine/profiles';
import { verify } from '../src/engine/verify';

import { buildTelemetryMp4, topBoxes, type SyntheticVideo } from './isobmff-builder';
import { openNodeByteFile } from './node-byte-file';

const FIX = join(ROOT, 'test', 'fixtures');
const OUT = join(ROOT, 'artifacts', 'engine-out-video');
const IN = join(OUT, 'input');
const manifest = loadManifest();
const fixtures = Object.entries(manifest.files)
  .filter(([, e]) => (e.format === 'mp4' || e.format === 'mov') && e.supported)
  .map(([n]) => n);
const TELE = 'tele.mp4';
const videos = [...fixtures, TELE];
const inputOf = (n: string) => (n === TELE ? join(IN, n) : join(FIX, n));
const outPath = (p: Profile, n: string) => join(OUT, p, n);

let tele: SyntheticVideo;
const entries: Record<string, ManifestEntry> = {};

function cleanTo(name: string, profile: Profile, out: string, opts: CleanOptions = {}) {
  const src = openNodeByteFile(inputOf(name));
  writeFileSync(out, new Uint8Array(0));
  const dst = openNodeByteFile(out, true);
  try {
    const result = clean(src, dst, profile, opts);
    const verdict = verify({ src, dst, before: result.before, profile });
    return { result, verdict };
  } finally {
    src.close();
    dst.close();
  }
}

function verifyFile(name: string, file: string, profile: Profile) {
  const src = openNodeByteFile(inputOf(name));
  const dst = openNodeByteFile(file);
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

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(IN, { recursive: true });
  tele = buildTelemetryMp4(readFileSync(join(FIX, 'gps.mp4')));
  writeFileSync(join(IN, TELE), tele.bytes);
  // Manifest-style entry for the synthetic file, from what ExifTool finds in it (proves the input is real).
  const t = exifDump([join(IN, TELE)])[join(IN, TELE)];
  const sensitive = Object.fromEntries(
    Object.entries(t).filter(([k]) => /GPS(Latitude|Longitude|Altitude|Coordinates)$|^VideoKeys:|^XMP-(dc|photoshop|xmp):|^UserData:|DeviceName|^QuickTime:(Create|Modify)Date|^Track\d:(Track|Media)(Create|Modify)Date/.test(k)),
  ) as Tags;
  entries[TELE] = {
    format: 'mp4',
    supported: true,
    sensitive,
    location: Object.keys(sensitive).filter((k) => /GPS|Location|City|ISO6709/.test(k)),
    cameraSettings: {},
    keep: { 'Track1:ImageWidth': 320, 'Track1:ImageHeight': 240, 'QuickTime:Duration': '2.00 s' },
    rawStrings: ['SN-GOPRO-771', 'SN-GOPRO-772', '+48.8584+002.2945'],
    lossless: 'mp4-mdat',
  };
  for (const n of fixtures) entries[n] = manifest.files[n];
  for (const p of PROFILES) {
    mkdirSync(join(OUT, p), { recursive: true });
    for (const n of videos) runs[p][n] = cleanTo(n, p, outPath(p, n));
  }
  dumps = exifDump(PROFILES.flatMap((p) => videos.map((n) => outPath(p, n))));
});

const cases = PROFILES.flatMap((p) => videos.map((n) => [p, n] as [Profile, string]));

describe('synthetic input is real', () => {
  it('ExifTool sees the CAMM GPS, the GoPro device name, the trak-level keys and the XMP in tele.mp4', () => {
    const k = Object.keys(entries[TELE].sensitive);
    for (const want of ['Track3:GPSLatitude', 'Track4:DeviceName', 'VideoKeys:LocationISO6709', 'XMP-photoshop:City', 'UserData:LocationInformation']) expect(k).toContain(want);
    const b = tele.bytes;
    for (const s of entries[TELE].rawStrings) expect(b.includes(Buffer.from(s))).toBe(true);
  });
});

describe('engine verdict', () => {
  it.each(cases)('%s / %s: verify() says clean, media unchanged', (p, n) => {
    const { verdict } = runs[p][n];
    expect({ status: verdict.status, survivors: verdict.survivors, problems: verdict.problems }).toEqual({ status: 'clean', survivors: [], problems: [] });
    expect(verdict.pictureUnchanged).toBe(true);
  });
});

describe('A1 referee: "Remove everything" leaves none of the sensitive values, keeps size and duration', () => {
  it.each(videos)('%s', (n) => {
    const file = outPath('all', n);
    const tags = dumps[file];
    expect(survivors(entries[n], tags, readFileSync(file))).toEqual([]);
    expect(lostKept(entries[n], tags)).toEqual([]);
    // Times are zeroed, not faked.
    expect(tags['QuickTime:CreateDate']).toBe('0000:00:00 00:00:00');
  });
});

describe('A3 referee: "Location only" removes every location value and keeps dates, make and model', () => {
  it.each(videos)('%s', (n) => {
    const e = entries[n];
    const file = outPath('location', n);
    const tags = dumps[file];
    const locOnly: ManifestEntry = { ...e, sensitive: Object.fromEntries(e.location.map((k) => [k, e.sensitive[k]])), cameraSettings: {}, rawStrings: n === TELE ? e.rawStrings : [] };
    expect(survivors(locOnly, tags, readFileSync(file))).toEqual([]);
    const mustStay = Object.keys(e.sensitive).filter((k) => !e.location.includes(k) && !/^Track[34]:/.test(k));
    const lost = [...mustStay, ...Object.keys(e.keep)].filter((k) => !(k in tags) || !valueEquals(tags[k], e.sensitive[k] ?? e.keep[k]));
    expect(lost).toEqual([]);
    expect(mustStay.length).toBeGreaterThan(0);
  });
});

describe('"Keep camera settings" on video removes all metadata (SPEC F3)', () => {
  it.each(videos)('%s: same bytes as "Remove everything"', (n) => {
    expect(readFileSync(outPath('camera', n)).equals(readFileSync(outPath('all', n)))).toBe(true);
  });
});

// ---- A2: independent check (own box walker, not the engine's) ----

describe('A2 media data unchanged (independent check)', () => {
  it.each(cases)('%s / %s', (p, n) => {
    const src = readFileSync(inputOf(n));
    const dst = readFileSync(outPath(p, n));
    expect(dst.length).toBe(src.length);
    const mdats = topBoxes(src).filter((b) => b.type === 'mdat');
    expect(topBoxes(dst).filter((b) => b.type === 'mdat').map((b) => [b.start, b.size])).toEqual(mdats.map((b) => [b.start, b.size]));
    const holes = n === TELE ? tele.telemetry : [];
    for (const m of mdats) {
      for (let i = m.start + m.header; i < m.start + m.size; i++) {
        if (holes.some((h) => i >= h.offset && i < h.offset + h.length)) {
          if (dst[i] !== 0) throw new Error(`telemetry byte ${i} not zeroed`);
        } else if (src[i] !== dst[i]) throw new Error(`media byte ${i} changed`);
      }
    }
    if (n === TELE) {
      // The audio/video mdat is untouched, the telemetry samples are all zero.
      expect(dst.subarray(tele.mdat.offset, tele.mdat.offset + tele.mdat.length).equals(src.subarray(tele.mdat.offset, tele.mdat.offset + tele.mdat.length))).toBe(true);
      for (const h of tele.telemetry) expect(dst.subarray(h.offset, h.offset + h.length).every((x) => x === 0)).toBe(true);
    }
    // Every changed byte lies in moov or a top-level metadata box, never in ftyp.
    const ftyp = topBoxes(src).find((b) => b.type === 'ftyp')!;
    expect(dst.subarray(0, ftyp.size).equals(src.subarray(0, ftyp.size))).toBe(true);
  });
});

describe('inspection (F2)', () => {
  const report = (n: string) => {
    const f = openNodeByteFile(inputOf(n));
    const r = inspect(f);
    f.close();
    return r;
  };

  it('every field has a human name, group and sensitivity; nothing in the fixtures is "Other"', () => {
    for (const n of videos) {
      const r = report(n);
      expect(r.supported).toBe(true);
      for (const x of r.fields) {
        expect(x.name.length).toBeGreaterThan(0);
        expect(x.known).toBe(true);
      }
    }
  });

  it('findings, duration and size in plain words', () => {
    const mov = report('gps.mov');
    expect(mov.findings.map((x) => x.label)).toEqual(expect.arrayContaining(['Exact location', 'Phone or camera model', 'Date and time taken', 'Editing app']));
    expect([mov.width, mov.height, mov.duration]).toEqual([320, 240, 2]);
    expect(mov.fields.find((x) => x.id === 'qt:com.apple.quicktime.location.ISO6709')).toMatchObject({ name: 'Location (coordinates)', group: 'location', value: '+52.5200+013.4049+034.000/' });
    const t = report(TELE);
    expect(t.fields.map((x) => x.name)).toEqual(expect.arrayContaining(['Camera motion and GPS track (CAMM)', 'GoPro telemetry track (GPS and sensors)', 'City', 'Location']));
    expect(t.fields.find((x) => x.id === 'qt:loci')?.value).toBe('52.51999, 13.40489, 34.0 m');
  });

  it('the original is never written to (D18)', () => {
    for (const n of videos) {
      const before = readFileSync(inputOf(n));
      cleanTo(n, 'all', join(OUT, 'd18.tmp'));
      expect(readFileSync(inputOf(n)).equals(before)).toBe(true);
    }
    rmSync(join(OUT, 'd18.tmp'));
  });

  it('cleaning a native byte copy in place (dstIsCopy) gives the same bytes; cleaning again changes nothing', () => {
    for (const n of videos) {
      const file = join(OUT, `copy-${n}`);
      copyFileSync(inputOf(n), file);
      const src = openNodeByteFile(inputOf(n));
      const dst = openNodeByteFile(file, true);
      clean(src, dst, 'all', { dstIsCopy: true });
      src.close();
      dst.close();
      expect(readFileSync(file).equals(readFileSync(outPath('all', n)))).toBe(true);
      const again = join(OUT, `again-${n}`);
      const s2 = openNodeByteFile(outPath('all', n));
      writeFileSync(again, new Uint8Array(0));
      const d2 = openNodeByteFile(again, true);
      clean(s2, d2, 'all');
      s2.close();
      d2.close();
      expect(readFileSync(again).equals(readFileSync(outPath('all', n)))).toBe(true);
      rmSync(file);
      rmSync(again);
    }
  });
});

// ---- A5: injected failures ----

describe('A5 verification honesty (injected failures)', () => {
  const inj = join(OUT, 'injected');
  beforeAll(() => mkdirSync(inj, { recursive: true }));
  const faulty = (name: string, profile: Profile, ids: string[]) => {
    const out = join(inj, `${ids[0].replace(/[^a-z0-9]/gi, '_')}-${name}`);
    return { ...cleanTo(name, profile, out, { faultyKeep: ids }), out };
  };

  it('MOV: a writer that keeps the location key -> dirty "Location (coordinates)" (and ExifTool agrees)', () => {
    const { verdict, out } = faulty('gps.mov', 'all', ['qt:com.apple.quicktime.location.ISO6709']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(
      expect.arrayContaining([
        { id: 'qt:com.apple.quicktime.location.ISO6709', name: 'Location (coordinates)', reader: 'structure' },
        { id: 'qt:com.apple.quicktime.location.ISO6709', name: 'Location (coordinates)', reader: 'signature' },
      ]),
    );
    expect(exifDump([out])[out]['Keys:GPSCoordinates']).toBe(manifest.files['gps.mov'].sensitive['Keys:GPSCoordinates']);
  });

  it('MP4 "Location only": a writer that keeps the 3GPP loci atom -> dirty "Location"', () => {
    const { verdict, out } = faulty('gps.mp4', 'location', ['qt:loci']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'qt:loci', name: 'Location', reader: 'structure' }, { id: 'qt:loci', name: 'Location', reader: 'signature' }]));
    expect(exifDump([out])[out]['UserData:LocationInformation']).toBe(manifest.files['gps.mp4'].sensitive['UserData:LocationInformation']);
  });

  it('a writer that keeps the CAMM track -> dirty naming it (ExifTool still reads the GPS samples)', () => {
    // The track is one unit (its times go with it), so the faulty writer has to keep all of it.
    const ids = ['qt:Track3:MetadataTrack:camm', ...['Track', 'Media'].flatMap((w) => ['Create', 'Modify'].map((c) => `qt:Track3:${w}${c}Date`))];
    const { verdict, out } = faulty(TELE, 'all', ids);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toContainEqual({ id: 'qt:Track3:MetadataTrack:camm', name: 'Camera motion and GPS track (CAMM)', reader: 'structure' });
    // Its samples were not zeroed either: the byte check names the track too.
    expect(verdict.survivors).toContainEqual({ id: 'qt:Track3:MetadataTrack:camm', name: 'Camera motion and GPS track (CAMM)', reader: 'signature' });
    expect(exifDump([out])[out]['Track3:GPSLatitude']).toBe(entries[TELE].sensitive['Track3:GPSLatitude']);
  });

  it('a writer that keeps the recording date -> dirty "Date created"', () => {
    const { verdict } = faulty('gps.mp4', 'all', ['qt:CreateDate']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual([{ id: 'qt:CreateDate', name: 'Date created', reader: 'structure' }]);
  });

  it('"Location only": a writer that keeps the XMP city -> dirty "City"', () => {
    const { verdict } = faulty(TELE, 'location', ['xmp:photoshop:City']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'xmp:photoshop:City', name: 'City', reader: 'structure' }, { id: 'xmp:photoshop:City', name: 'City', reader: 'signature' }]));
  });

  it('telemetry samples that were not zeroed are caught by the byte check alone', () => {
    const b = Buffer.from(readFileSync(outPath('all', TELE)));
    const h = tele.telemetry[1];
    b.write('SN-GOPRO-771', h.offset + 20, 'latin1');
    const file = join(inj, 'samples.mp4');
    writeFileSync(file, b);
    const v = verifyFile(TELE, file, 'all');
    expect(v.status).toBe('dirty');
    expect(v.survivors).toEqual([{ id: 'qt:Track4:MetadataTrack:gpmd', name: 'GoPro telemetry track (GPS and sensors)', reader: 'signature' }]);
  });

  it('a changed media byte is never "clean"', () => {
    const b = Buffer.from(readFileSync(outPath('all', 'gps.mov')));
    const mdat = topBoxes(b).find((x) => x.type === 'mdat')!;
    b[mdat.start + mdat.header + 1000] ^= 0x01;
    const file = join(inj, 'media.mov');
    writeFileSync(file, b);
    const v = verifyFile('gps.mov', file, 'all');
    expect(v.status).toBe('unverified');
    expect(v.pictureUnchanged).toBe(false);
  });

  it('a location key name left in free space is caught by the marker scan (and, since P7.5, by the structure reader and the separate scan)', () => {
    const b = Buffer.from(readFileSync(outPath('all', 'gps.mov')));
    const free = b.indexOf(Buffer.from('free'), topBoxes(b).find((x) => x.type === 'moov')!.start);
    b.write('com.apple.quicktime.location.ISO6709', free + 12, 'latin1');
    const file = join(inj, 'marker.mov');
    writeFileSync(file, b);
    expect(verifyFile('gps.mov', file, 'all').survivors).toEqual([
      { id: 'qt:box:free', name: 'Leftover data in free space', reader: 'structure' },
      { id: 'marker:Video location key', name: 'Video location key', reader: 'signature' },
      { id: 'sweep:Leftover data in free space', name: 'Leftover data in free space', reader: 'sweep' },
      { id: 'sweep:Location', name: 'Location', reader: 'sweep' },
    ]);
  });
});
