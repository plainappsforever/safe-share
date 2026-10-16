/** @jest-environment node */
// V1.5-1 fix round (docs/REVIEW_V15_1.md): the reviewer's probes and fuzz corpus as regression tests (review S10).
//  - 45 constructed files (P1–P13, Q1–Q4, R1–R4, C1, G1–G8, M1–M6), ported from the reviewer's scratchpad probes, through
//    inspect → clean → verify under all three profiles. A "clean" verdict must not leave any planted value that the profile
//    removes; "Location only" must keep the planted values it promises to keep. Every clean TIFF/DNG/GIF copy is then judged
//    by the Python referee (picture hash, decode-tag hash, unreferenced bytes, its own allow-list) and by ExifTool.
//  - 500 seeded mutations of the fixtures (the reviewer's generator and seed 20261016, unchanged): every "clean" verdict is
//    judged by three oracles that share no code with the engine: the Python picture/decode hashes, ExifTool, and a byte
//    search for the original's sensitive values. Expected: 0 crashes, 0 survivors, 0 hash mismatches.
// Outputs: artifacts/review-v15/ (overwritten each run).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../scripts/lib/referee';
import { bytes, gifApp, gifFrame, gifHead, gpsEntries, MemFile, picTags, pixels, sub, tiff, txt, type E, type Item } from './tiff-builder';

import { clean } from '@/engine/clean';
import { inspect, IN_PLACE_FORMATS } from '@/engine/inspect';
import type { Profile } from '@/engine/profiles';
import { sniff } from '@/engine/sniff';
import { verify } from '@/engine/verify';

const OUT = join(ROOT, 'artifacts', 'review-v15');
const FIX = join(ROOT, 'test', 'fixtures');
const EXIFTOOL = join(ROOT, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool');
const PROFILES: Profile[] = ['all', 'location', 'camera'];

/** loc = location (removed by every profile); person = personal but not location ("Location only" keeps it); hidden = data the
 * file hides (orphans, unknown blocks, signatures, values in unexpected places: removed by every profile). */
type Cls = 'loc' | 'person' | 'hidden';
interface Probe {
  file: string;
  bytes: Uint8Array;
  needles: [string | Uint8Array, Cls][];
  /** Expected verdict per profile when it is not "clean" ('unreadable' = inspection refuses the file); default: clean. */
  expect?: Partial<Record<Profile, 'not-clean' | 'unreadable'>> | 'unreadable';
}
const mustGo = (c: Cls, p: Profile) => p !== 'location' || c !== 'person';
const has = (b: Uint8Array, n: string | Uint8Array) => Buffer.from(b).indexOf(typeof n === 'string' ? Buffer.from(n, 'latin1') : Buffer.from(n)) >= 0;
const show = (n: string | Uint8Array) => (typeof n === 'string' ? n : `bin(${n.length})`);

interface Exif {
  [k: string]: unknown;
}
function exif(files: string[]): Record<string, Exif> {
  if (!files.length) return {};
  const r = spawnSync('/usr/bin/perl', [EXIFTOOL, '-a', '-G1', '-ee3', '-u', '-j', ...files], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const o: Record<string, Exif> = {};
  for (const a of JSON.parse(r.stdout || '[]') as Exif[]) o[a.SourceFile as string] = a;
  return o;
}
interface Py {
  format: string;
  errors: string[];
  dataSha256?: string;
  decodeSha256?: string;
  extraTags?: number[];
  unreferencedNonZero?: number;
  largestGap?: number;
  pictureSha256?: string;
  plainText?: string[];
  blocks?: { label: number; app?: string; subBlocks: number[] }[];
}
const python = (files: string[]): Record<string, Py> =>
  files.length ? JSON.parse(execFileSync('python3', ['-I', join(ROOT, 'scripts', 'referee', 'structure.py'), ...files], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) : {};
/**
 * ExifTool tags no "Remove everything"/"Keep camera settings" copy may show: the reviewer's oracle, plus SEAL and the DNG/TIFF
 * text tags of review M1 (in a TIFF directory; the copyright line inside a kept ICC colour profile is part of the colour profile).
 */
const REVIEW_BAD = /^(GPS|XMP|IPTC|MakerNotes|Photoshop)|:(Make|Model|Artist|Copyright|Software|DateTime|DateTimeOriginal|CreateDate|ModifyDate|SerialNumber|CameraSerialNumber|LensSerialNumber|HostComputer|Comment|Text|OwnerName|ImageDescription|OriginalRawFileName|RawDataUniqueID|PreviewApplicationName|PreviewDateTime|City|Creator)$/;
const M1_BAD = /^SEAL|^(IFD\d+|SubIFD\d*|ExifIFD):(ProfileName|ProfileCopyright|AsShotProfileName|InkNames|ProfileCalibrationSig|CameraCalibrationSig|ImageSequenceInfo|ProfileGroupName)$/;
const BAD = { test: (k: string) => REVIEW_BAD.test(k) || M1_BAD.test(k) };

function runOne(bytesIn: Uint8Array, p: Profile) {
  const src = new MemFile(bytesIn, true);
  const inPlace = IN_PLACE_FORMATS.includes(sniff(src));
  const dst = new MemFile(inPlace ? bytesIn : new Uint8Array(0));
  const r = clean(src, dst, p, { dstIsCopy: inPlace });
  return { verdict: verify({ src, dst, before: r.before, profile: p }), out: dst.b };
}

// ---------- the probes ----------
const base = (extra0: E[], more: Item[] = []) =>
  tiff([{ kind: 'ifd', name: 'IFD0', entries: [...picTags(), ...extra0] }, { kind: 'blob', name: 'strip', bytes: pixels() }, ...more]);
const patchEntry = (b: Buffer, tag: number, f: (entryAt: number) => void) => {
  const ifd0 = b.readUInt32LE(4);
  const n = b.readUInt16LE(ifd0);
  for (let i = 0; i < n; i++) if (b.readUInt16LE(ifd0 + 2 + 12 * i) === tag) f(ifd0 + 2 + 12 * i);
};

function probes(): Probe[] {
  const list: Probe[] = [];
  const add = (file: string, b: Uint8Array, needles: [string | Uint8Array, Cls][], expect?: Probe['expect']) => list.push({ file, bytes: b, needles, expect });
  const gpsBin = Uint8Array.from([52, 0, 0, 0, 1, 0, 0, 0, 31, 0, 0, 0]);

  add('p1-gps-in-exif.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x10f, val: { t: 2, s: 'MakerCo' } }, { tag: 0x8769, val: { t: 4, v: [{ ref: 'EXIF' }] } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'EXIF', entries: [{ tag: 0x9003, val: { t: 2, s: '2026:01:02 03:04:05' } }, { tag: 0x8825, val: { t: 4, v: [{ ref: 'GPS' }] } }] },
    { kind: 'ifd', name: 'GPS', entries: gpsEntries() },
  ]), [['HOME-ADDR-123', 'loc'], [gpsBin, 'loc']]);

  add('p2-orphan.tif', base([{ tag: 0x10f, val: { t: 2, s: 'MakerCo' } }], [
    { kind: 'ifd', name: 'OLDGPS', entries: gpsEntries('ORPHAN-HOME-77') },
    { kind: 'blob', name: 'junk', bytes: txt('SerialNumber=SN-ORPHAN-4242;Owner=Tim Example') },
  ]), [['ORPHAN-HOME-77', 'hidden'], ['SN-ORPHAN-4242', 'hidden'], ['Tim Example', 'hidden']]);

  const x1 = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>XMP-ORPHAN-CREATOR</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
  const x2 = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:aux="http://ns.adobe.com/exif/1.0/aux/" aux:SerialNumber="AUX-ORPHAN-SN"/></rdf:RDF>';
  add('p3a-orphan-xmp.tif', base([], [{ kind: 'blob', name: 'x', bytes: txt(x1) }]), [['XMP-ORPHAN-CREATOR', 'hidden']]);
  add('p3b-orphan-rdf.tif', base([], [{ kind: 'blob', name: 'x', bytes: txt(x2) }]), [['AUX-ORPHAN-SN', 'hidden']]);

  add('p4-subchain.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x14a, val: { t: 4, v: [{ ref: 'S0' }] } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'S0', entries: [...picTags('strip2'), { tag: 0xfe, val: { t: 4, v: [1] } }], next: { ref: 'S1' } },
    { kind: 'blob', name: 'strip2', bytes: pixels(64, 9) },
    { kind: 'ifd', name: 'S1', entries: [...picTags('strip3'), { tag: 0xfe, val: { t: 4, v: [1] } }, { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }] },
    { kind: 'blob', name: 'strip3', bytes: pixels(64, 11) },
    { kind: 'ifd', name: 'EX', entries: [{ tag: 0xa431, val: { t: 2, s: 'SUBCHAIN-SERIAL-1' } }, { tag: 0x8825, val: { t: 4, v: [{ ref: 'G' }] } }] },
    { kind: 'ifd', name: 'G', entries: gpsEntries('SUBCHAIN-GPS') },
  ]), [['SUBCHAIN-SERIAL-1', 'person'], ['SUBCHAIN-GPS', 'loc']]);

  add('p5-private.dng', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0xc612, val: { t: 1, b: Uint8Array.from([1, 4, 0, 0]) } }, { tag: 0xc614, val: { t: 2, s: 'Pixel 9 Pro' } },
      { tag: 0xc6f5, val: { t: 4, v: [{ ref: 'PROF' }] } }, { tag: 0xc6fe, val: { t: 2, s: 'Copyright Tim Example' } }, { tag: 0xc6f8, val: { t: 2, s: 'Tims own profile' } },
      { tag: 0xbeef, val: { t: 13, v: [{ ref: 'PRIV' }] } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'PROF', entries: [{ tag: 0xc6f8, val: { t: 2, s: 'PROFILE-NAME-TIM' } }, { tag: 0xc6fe, val: { t: 2, s: 'PROFILE-COPY-TIM' } }] },
    { kind: 'ifd', name: 'PRIV', entries: [{ tag: 0x8825, val: { t: 4, v: [{ ref: 'G' }] } }, { tag: 0x13b, val: { t: 2, s: 'PRIV-ARTIST' } }] },
    { kind: 'ifd', name: 'G', entries: gpsEntries('PRIV-GPS-HOME') },
  ]), [['PROFILE-NAME-TIM', 'hidden'], ['PROFILE-COPY-TIM', 'hidden'], ['Copyright Tim Example', 'person'], ['Tims own profile', 'person'], ['PRIV-ARTIST', 'hidden'], ['PRIV-GPS-HOME', 'loc'], ['Pixel 9 Pro', 'person']]);

  {
    // P6: Artist in the gap between two strips; Copyright stored inside strip 2 (it is pixel bytes too: S5).
    const pix = pixels(32 + 24 + 32);
    pix.set(txt('ARTIST-IN-GAP-XYZ\0'), 32);
    const b = Buffer.from(tiff([
      { kind: 'ifd', name: 'IFD0', entries: [
        { tag: 0x100, val: { t: 3, v: [8] } }, { tag: 0x101, val: { t: 3, v: [8] } }, { tag: 0x102, val: { t: 3, v: [8] } }, { tag: 0x103, val: { t: 3, v: [1] } }, { tag: 0x106, val: { t: 3, v: [1] } },
        { tag: 0x111, val: { t: 4, v: [{ ref: 'S' }, 0] } }, { tag: 0x115, val: { t: 3, v: [1] } }, { tag: 0x116, val: { t: 3, v: [4] } }, { tag: 0x117, val: { t: 4, v: [32, 32] } },
        { tag: 0x13b, val: { t: 2, s: 'ARTIST-IN-GAP-XYZ' }, at: { ref: 'G' } }, { tag: 0x8298, val: { t: 2, s: 'COPY-IN-STRIP' }, at: { ref: 'IN' } },
      ] },
      { kind: 'blob', name: 'S', bytes: pix },
    ]));
    const S = b.indexOf(Buffer.from(pix.subarray(0, 8)));
    b.write('COPY-IN-STRIP\0', S + 60, 'latin1');
    patchEntry(b, 0x111, (e) => {
      const vo = b.readUInt32LE(e + 8);
      b.writeUInt32LE(S, vo);
      b.writeUInt32LE(S + 56, vo + 4);
    });
    patchEntry(b, 0x13b, (e) => b.writeUInt32LE(S + 32, e + 8));
    patchEntry(b, 0x8298, (e) => b.writeUInt32LE(S + 60, e + 8));
    add('p6-strip-gap.tif', Uint8Array.from(b), [['ARTIST-IN-GAP-XYZ', 'person'], ['COPY-IN-STRIP', 'person']], { all: 'not-clean', camera: 'not-clean' });
  }

  add('p7-dup.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x8825, val: { t: 4, v: [{ ref: 'G1' }] } }, { tag: 0x8825, val: { t: 4, v: [{ ref: 'G2' }] } }, { tag: 0x13b, val: { t: 2, s: 'DUP-ARTIST-1' } }, { tag: 0x13b, val: { t: 2, s: 'DUP-ARTIST-2' } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'G1', entries: gpsEntries('DUP-GPS-1') },
    { kind: 'ifd', name: 'G2', entries: gpsEntries('DUP-GPS-2') },
  ]), [['DUP-GPS-1', 'loc'], ['DUP-GPS-2', 'loc']], 'unreadable');
  add('p7b-dup-same.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x8825, val: { t: 4, v: [{ ref: 'G1' }] } }, { tag: 0x8825, val: { t: 4, v: [{ ref: 'G1' }] } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'G1', entries: gpsEntries('DUP-SAME') },
  ]), [['DUP-SAME', 'loc']], 'unreadable');
  add('p7c-dup-artist.tif', base([{ tag: 0x13b, val: { t: 2, s: 'DUP-ARTIST-1' } }, { tag: 0x13b, val: { t: 2, s: 'DUP-ARTIST-2' } }]), [['DUP-ARTIST-1', 'person'], ['DUP-ARTIST-2', 'hidden']]);

  add('p8-exifnext.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }, { tag: 0xa005, val: { t: 4, v: [{ ref: 'IO' }] } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'EX', entries: [{ tag: 0x829a, val: { t: 5, r: [[1, 100]] } }], next: { ref: 'EX2' } },
    { kind: 'ifd', name: 'EX2', entries: [{ tag: 0xa431, val: { t: 2, s: 'EXNEXT-SERIAL' } }] },
    { kind: 'ifd', name: 'IO', entries: [{ tag: 0x0001, val: { t: 2, s: 'R98' } }, { tag: 0x1000, val: { t: 2, s: 'INTEROP-FILEFMT-SECRET' } }] },
  ]), [['EXNEXT-SERIAL', 'hidden'], ['INTEROP-FILEFMT-SECRET', 'hidden']]);

  {
    const b = Buffer.from(tiff([
      { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }] },
      { kind: 'blob', name: 'strip', bytes: pixels() },
      { kind: 'ifd', name: 'EX', entries: [{ tag: 0x927c, val: { t: 7, b: new Uint8Array(18) }, at: { ref: 'MN' } }] },
      { kind: 'blob', name: 'MN', bytes: new Uint8Array(18) },
      { kind: 'blob', name: 'OWNER', bytes: txt('MAKERNOTE-OWNER-OUTSIDE\0') },
    ]));
    let exAt = 0;
    patchEntry(b, 0x8769, (e) => (exAt = b.readUInt32LE(e + 8)));
    const mn = b.readUInt32LE(exAt + 2 + 8);
    const owner = b.indexOf(Buffer.from('MAKERNOTE-OWNER-OUTSIDE'));
    b.writeUInt16LE(1, mn);
    b.writeUInt16LE(0x0002, mn + 2);
    b.writeUInt16LE(2, mn + 4);
    b.writeUInt32LE(24, mn + 6);
    b.writeUInt32LE(owner, mn + 10);
    add('p9-makernote-out.tif', Uint8Array.from(b), [['MAKERNOTE-OWNER-OUTSIDE', 'hidden']]);
  }

  const dng = (e: E) => tiff([{ kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0xc612, val: { t: 1, b: Uint8Array.from([1, 4, 0, 0]) } }, e] }, { kind: 'blob', name: 'strip', bytes: pixels() }]);
  add('p10a-shortmodel.dng', dng({ tag: 0xc614, val: { t: 2, s: 'X1' } }), [['X1\0', 'person']]);
  add('p10b-bytemodel.dng', dng({ tag: 0xc614, val: { t: 1, b: txt('Pixel 8 Pro\0') } }), [['Pixel 8 Pro', 'person']]);
  add('p10c-camera.dng', dng({ tag: 0xc614, val: { t: 2, s: 'Camera' } }), []);
  add('p11-inknames.tif', base([{ tag: 0x14d, val: { t: 2, s: 'INKNAMES-TIM-HOME' } }, { tag: 0x10d, val: { t: 2, s: '/Users/example/Scans/passport.tif' } }, { tag: 0x11d, val: { t: 2, s: 'PAGE-NAME-X' } }]),
    [['INKNAMES-TIM-HOME', 'person'], ['/Users/example/Scans', 'person'], ['PAGE-NAME-X', 'person']]);
  add('p12-shared-exif.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }], next: { ref: 'P2' } },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'P2', entries: [...picTags('strip2'), { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }] },
    { kind: 'blob', name: 'strip2', bytes: pixels(64, 3) },
    { kind: 'ifd', name: 'EX', entries: [{ tag: 0xa431, val: { t: 2, s: 'SHARED-SN' } }] },
  ]), [['SHARED-SN', 'person']]);
  {
    const irb = (id: number, data: Uint8Array) => {
      const h = Buffer.alloc(12);
      h.write('8BIM', 0, 'latin1');
      h.writeUInt16BE(id, 4);
      h.writeUInt32BE(data.length, 8);
      return Buffer.concat([h, Buffer.from(data), data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const iptc = Buffer.concat([Buffer.from([0x1c, 2, 80, 0, 10]), Buffer.from('IPTC-BYLIN', 'latin1'), Buffer.from([0x1c, 2, 90, 0, 9]), Buffer.from('IPTC-CITY', 'latin1')]);
    const data = Buffer.concat([irb(0x0404, iptc), irb(0x0422, txt('MM\0*\0\0\0\x08IRB-EXIF-SECRET')), irb(0x0424, txt('<x:xmpmeta>IRB-XMP-SECRET</x:xmpmeta>'))]);
    add('p13-irb.tif', base([{ tag: 0x8649, val: { t: 7, b: Uint8Array.from(data) } }]), [['IRB-EXIF-SECRET', 'hidden'], ['IRB-XMP-SECRET', 'hidden'], ['IPTC-BYLIN', 'person'], ['IPTC-CITY', 'loc']]);
  }

  const seal = '<seal seal="1" kv="1" ka="rsa" da="sha256" d="example.com" id="tim.owner@example.com" copyright="Tim Example 2026" s="QUJDREVGR0g="/>';
  add('q1-seal.tif', base([{ tag: 0xcea1, val: { t: 2, s: seal } }]), [['tim.owner@example.com', 'hidden'], ['Tim Example 2026', 'hidden']]);
  {
    const jpegWith = (seg: Buffer) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg, Buffer.from([0xff, 0xdb, 0, 4, 0, 0]), Buffer.from([0xff, 0xda, 0, 2]), Buffer.from([1, 2, 3, 4]), Buffer.from([0xff, 0xd9])]);
    const app = (m: number, body: string) => {
      const bb = Buffer.from(body, 'latin1');
      const hh = Buffer.from([0xff, m, 0, 0]);
      hh.writeUInt16BE(bb.length + 2, 2);
      return Buffer.concat([hh, bb]);
    };
    const mk = (last: Buffer, name: string) => {
      const tiles: Buffer[] = Array.from({ length: 64 }, () => jpegWith(Buffer.alloc(0)));
      tiles.push(last);
      const blob = Buffer.concat(tiles);
      const offs: number[] = [];
      const lens: number[] = [];
      let o = 0;
      for (const t of tiles) {
        offs.push(o);
        lens.push(t.length);
        o += t.length;
      }
      const b = Buffer.from(tiff([
        { kind: 'ifd', name: 'IFD0', entries: [
          { tag: 0x100, val: { t: 3, v: [16 * 13] } }, { tag: 0x101, val: { t: 3, v: [16 * 5] } }, { tag: 0x102, val: { t: 3, v: [8, 8, 8] } }, { tag: 0x103, val: { t: 3, v: [7] } }, { tag: 0x106, val: { t: 3, v: [6] } },
          { tag: 0x115, val: { t: 3, v: [3] } }, { tag: 0x142, val: { t: 3, v: [16] } }, { tag: 0x143, val: { t: 3, v: [16] } },
          { tag: 0x144, val: { t: 4, v: offs.map((x) => x + 0x1000000) } }, { tag: 0x145, val: { t: 4, v: lens } },
        ] },
        { kind: 'blob', name: 'tiles', bytes: Uint8Array.from(blob) },
      ]));
      const at = b.indexOf(blob);
      patchEntry(b, 0x144, (e) => {
        const vo = b.readUInt32LE(e + 8);
        offs.forEach((x, k) => b.writeUInt32LE(x + at, vo + 4 * k));
      });
      add(name, Uint8Array.from(b), [['COM-SECRET-IN-TILE-65', 'hidden'], ['APP1-SECRET', 'hidden']], { all: 'not-clean', location: 'not-clean', camera: 'not-clean' });
    };
    mk(jpegWith(app(0xfe, 'COM-SECRET-IN-TILE-65 Tim Example')), 'q2a-tile65-com.tif');
    mk(jpegWith(app(0xe1, 'Exif\0\0MM\0*APP1-SECRET')), 'q2b-tile65-app1.tif');
    mk(jpegWith(app(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>APP1-SECRET</dc:creator></x:xmpmeta>')), 'q2c-tile65-xmp.tif');
  }
  {
    const box = (t: string, p: Buffer) => {
      const hh = Buffer.alloc(8);
      hh.writeUInt32BE(8 + p.length);
      hh.write(t, 4, 'latin1');
      return Buffer.concat([hh, p]);
    };
    const jxl = Buffer.concat([Buffer.from('0000000c4a584c200d0a870a', 'hex'), box('ftyp', Buffer.from('jxl \0\0\0\0jxl ', 'latin1')),
      box('Exif', Buffer.concat([Buffer.alloc(4), Buffer.from('MM\0*\0\0\0\x08JXL-EXIF-SERIAL-77', 'latin1')])),
      box('xml ', Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>JXL-XMP-CREATOR</dc:creator></x:xmpmeta>', 'latin1')), box('jxlc', Buffer.from([0xff, 0x0a, 1, 2, 3]))]);
    add('q3-jxl.dng', tiff([
      { kind: 'ifd', name: 'IFD0', entries: [
        { tag: 0xfe, val: { t: 4, v: [1] } }, { tag: 0x100, val: { t: 3, v: [8] } }, { tag: 0x101, val: { t: 3, v: [8] } }, { tag: 0x102, val: { t: 3, v: [8, 8, 8] } }, { tag: 0x103, val: { t: 3, v: [52546] } }, { tag: 0x106, val: { t: 3, v: [2] } },
        { tag: 0x111, val: { t: 4, v: [{ ref: 'J' }] } }, { tag: 0x115, val: { t: 3, v: [3] } }, { tag: 0x116, val: { t: 3, v: [8] } }, { tag: 0x117, val: { t: 4, v: [jxl.length] } },
        { tag: 0xc612, val: { t: 1, b: Uint8Array.from([1, 7, 0, 0]) } }, { tag: 0xc614, val: { t: 2, s: 'Camera' } }] },
      { kind: 'blob', name: 'J', bytes: Uint8Array.from(jxl) },
    ]), [['JXL-EXIF-SERIAL-77', 'hidden'], ['JXL-XMP-CREATOR', 'hidden']], { all: 'not-clean', location: 'not-clean', camera: 'not-clean' });
  }
  {
    // Q4: the strip-count table and both strips inside the removed maker note. The maker-note text around them must go;
    // the overlapping bytes are picture data, so the verdict may say "Could not check" but never leaves the text.
    const mn = Buffer.alloc(140, 0x41);
    mn.write('MN-SECRET-OWNER', 0, 'latin1');
    mn.write('MN-TAIL-SECRET', 120, 'latin1');
    Buffer.from(pixels()).copy(mn, 40);
    const b = Buffer.from(tiff([
      { kind: 'ifd', name: 'IFD0', entries: [
        { tag: 0x100, val: { t: 3, v: [8] } }, { tag: 0x101, val: { t: 3, v: [8] } }, { tag: 0x102, val: { t: 3, v: [8] } }, { tag: 0x103, val: { t: 3, v: [1] } }, { tag: 0x106, val: { t: 3, v: [1] } },
        { tag: 0x111, val: { t: 4, v: [0, 0] } }, { tag: 0x115, val: { t: 3, v: [1] } }, { tag: 0x116, val: { t: 3, v: [4] } }, { tag: 0x117, val: { t: 4, v: [32, 32] } },
        { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }] },
      { kind: 'ifd', name: 'EX', entries: [{ tag: 0x927c, val: { t: 7, b: Uint8Array.from(mn) } }] },
    ]));
    const mnAt = b.indexOf(Buffer.from('MN-SECRET-OWNER'));
    patchEntry(b, 0x111, (e) => {
      const vo = b.readUInt32LE(e + 8);
      b.writeUInt32LE(mnAt + 40, vo);
      b.writeUInt32LE(mnAt + 72, vo + 4);
    });
    patchEntry(b, 0x117, (e) => {
      b.writeUInt32LE(mnAt + 32, e + 8);
      b.writeUInt32LE(32, mnAt + 32);
      b.writeUInt32LE(32, mnAt + 36);
    });
    // The removed maker note shares bytes with the picture data: "Could not check" (conservative, S5), and its text is gone.
    add('q4-protected.tif', Uint8Array.from(b), [['MN-SECRET-OWNER', 'hidden'], ['MN-TAIL-SECRET', 'hidden']], { all: 'not-clean', location: 'not-clean', camera: 'not-clean' });
  }

  const X = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>PRIVATE-TAG-XMP</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
  add('r1-xmp-private-tag.tif', tiff([
    { kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x9999, val: { t: 7, b: txt(X) } }, { tag: 0x8769, val: { t: 4, v: [{ ref: 'EX' }] } }] },
    { kind: 'blob', name: 'strip', bytes: pixels() },
    { kind: 'ifd', name: 'EX', entries: [{ tag: 0x02bc, val: { t: 7, b: txt(X.replace('PRIVATE-TAG-XMP', 'EXIF-IFD-XMP')) } }] },
  ]), [['PRIVATE-TAG-XMP', 'hidden'], ['EXIF-IFD-XMP', 'hidden']]);
  {
    const b = Buffer.from(tiff([{ kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0x13b, val: { t: 4, v: [{ ref: 'S' }] } }] }, { kind: 'blob', name: 'strip', bytes: pixels() }, { kind: 'blob', name: 'S', bytes: txt('ODD-TYPE-ARTIST-STRING-0123456789ABCDEF\0') }]));
    const c = Buffer.from(b);
    patchEntry(b, 0x13b, (e) => {
      b.writeUInt16LE(99, e + 2);
      b.writeUInt32LE(40, e + 4);
    });
    patchEntry(c, 0x13b, (e) => {
      c.writeUInt16LE(16, e + 2);
      c.writeUInt32LE(5, e + 4);
    });
    add('r2-odd-type.tif', Uint8Array.from(b), [['ODD-TYPE-ARTIST', 'hidden']]);
    add('r3-long8-type.tif', Uint8Array.from(c), [['ODD-TYPE-ARTIST', 'hidden']]);
    const big = Buffer.alloc(64);
    big.write('II+\0', 0, 'latin1');
    add('r4-bigtiff.tif', Uint8Array.from(big), [], 'unreadable');
  }
  const jumbf = txt('\0\0\0\x40jumb\0\0\0\x1ejumdc2pa\0\x11\0\x10\x80\0\0\xaa\0\x38\x9b\x71c2pa\0....jumdc2ma....c2pa.claim....stds.schema-org.CreativeWork author: C2PA-AUTHOR-TIM');
  add('c1-c2pa.dng', tiff([{ kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0xc612, val: { t: 1, b: Uint8Array.from([1, 7, 0, 0]) } }, { tag: 0xc614, val: { t: 2, s: 'LEICA M11-P' } }, { tag: 0xcd41, val: { t: 7, b: jumbf } }] }, { kind: 'blob', name: 'strip', bytes: pixels() }]),
    [['C2PA-AUTHOR-TIM', 'hidden'], ['c2pa.claim', 'hidden'], ['LEICA M11-P', 'person']]);

  // GIF
  const gif = (...blocks: Uint8Array[]) => bytes(gifHead, ...blocks, gifFrame, [0x3b]);
  add('g1-netscape.gif', gif(gifApp('NETSCAPE2.0', bytes([3, 1, 0, 0], sub('SECRET-IN-NETSCAPE gps 52.5200 13.4050 ..')))), [['SECRET-IN-NETSCAPE', 'hidden']]);
  add('g2-gce.gif', gif(bytes([0x21, 0xf9, 4, 0, 0, 0, 0], [30], 'SECRET-IN-GCE-OWNER-TIM-EXAMPL', [0])), [['SECRET-IN-GCE', 'hidden']]);
  add('g3-pte.gif', gif(bytes([0x21, 0x01, 12, 0, 0, 0, 0, 2, 0, 2, 0, 1, 1, 0, 1], sub('SECRET-PLAINTEXT-HOME'))), [['SECRET-PLAINTEXT-HOME', 'hidden']]);
  add('g4-netscape-xmp.gif', gif(gifApp('NETSCAPE2.0', bytes([3, 1, 0, 0], sub('<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>XMP-IN-NETSCAPE</dc:creator></x:xmpmeta>')))), [['XMP-IN-NETSCAPE', 'hidden']]);
  add('g5-fakeicc.gif', gif(gifApp('ICCRGBG1012', sub('NOT-AN-ICC-PROFILE owner Tim Example, Hauptstr. 1'))), [['NOT-AN-ICC-PROFILE', 'hidden']]);
  add('g6-comment-gps.gif', gif(bytes([0x21, 0xfe], sub('Shot at 52.5200N 13.4050E at home'))), [['52.5200N', 'person']]);
  {
    const x = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="52,31.2N" exif:GPSLongitude="13,24.5E"><dc:creator><rdf:Seq><rdf:li>XMP-CREATOR-TIM</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    const trailer = Uint8Array.from([1, ...Array.from({ length: 256 }, (_, i) => 255 - i)]);
    add('g7-xmp.gif', gif(bytes([0x21, 0xff, 11], 'XMP DataXMP', x, trailer, [0])), [['XMP-CREATOR-TIM', 'person'], ['52,31.2N', 'loc']]);
    const iptc = Buffer.concat([Buffer.from([0x1c, 2, 80, 0, 9]), Buffer.from('BYLINE-TM', 'latin1'), Buffer.from([0x1c, 2, 90, 0, 8]), Buffer.from('CITY-BER', 'latin1')]);
    add('g8-iptc.gif', gif(gifApp('MGKIPTC0000', sub(Uint8Array.from(iptc)))), [['BYLINE-TM', 'person'], ['CITY-BER', 'loc']]);
  }

  // 3GP (review S9)
  {
    const box = (type: string, ...p: Buffer[]) => {
      const body = Buffer.concat(p);
      const hh = Buffer.alloc(8);
      hh.writeUInt32BE(8 + body.length);
      hh.write(type, 4, 'latin1');
      return Buffer.concat([hh, body]);
    };
    const full = (type: string, ...p: Buffer[]) => box(type, Buffer.from([0, 0, 0, 0]), ...p);
    const loci = (name: string) => full('loci', Buffer.from([0x15, 0xc7]), Buffer.from(`${name}\0`, 'latin1'), Buffer.from([0]), Buffer.alloc(12, 0x11), Buffer.from('earth\0notes\0', 'latin1'));
    const titl = (s: string) => full('titl', Buffer.from([0x15, 0xc7]), Buffer.from(`${s}\0`, 'latin1'));
    const src = readFileSync(join(FIX, 'video.3gp'));
    const tops = (b: Buffer, s = 0, e = b.length) => {
      const o: { type: string; start: number; size: number }[] = [];
      for (let i = s; i + 8 <= e; ) {
        let size = b.readUInt32BE(i);
        if (size === 1) size = Number(b.readBigUInt64BE(i + 8));
        o.push({ type: b.toString('latin1', i + 4, i + 8), start: i, size });
        if (size < 8) break;
        i += size;
      }
      return o;
    };
    const insert = (b: Buffer, path: string[], child: Buffer): Buffer => {
      let s = 0;
      let e = b.length;
      const chain: number[] = [];
      for (const p of path) {
        const c = tops(b, s, e).find((x) => x.type === p)!;
        chain.push(c.start);
        s = c.start + 8;
        e = c.start + c.size;
      }
      const out = Buffer.concat([b.subarray(0, e), child, b.subarray(e)]);
      for (const at of chain) out.writeUInt32BE(out.readUInt32BE(at) + child.length, at);
      return out;
    };
    const moof = box('moof', full('mfhd', Buffer.from([0, 0, 0, 1])), box('traf', full('tfhd', Buffer.from([0, 0, 0, 1])), box('udta', loci('MOOF-LOCI-HOME'), titl('MOOF-TITLE'))), box('udta', loci('MOOF-ROOT')));
    add('m1-moof-udta.3gp', Uint8Array.from(Buffer.concat([src, moof])), [['MOOF-LOCI-HOME', 'loc'], ['MOOF-TITLE', 'person'], ['MOOF-ROOT', 'loc']]);
    add('m2-mdia-udta.3gp', Uint8Array.from(insert(src, ['moov', 'trak', 'mdia'], box('udta', loci('MDIA-LOCI-HOME')))), [['MDIA-LOCI-HOME', 'loc']]);
    add('m3-minf-udta.3gp', Uint8Array.from(insert(src, ['moov', 'trak', 'mdia', 'minf'], box('udta', titl('MINF-TITLE-SECRET')))), [['MINF-TITLE-SECRET', 'person']]);
    const uu = Buffer.concat([Buffer.from('0123456789abcdef0123456789abcdef', 'hex'), Buffer.from('UUID-IN-UDTA-SECRET', 'latin1')]);
    add('m4-udta-uuid.3gp', Uint8Array.from(insert(src, ['moov', 'udta'], box('uuid', uu))), [['UUID-IN-UDTA-SECRET', 'hidden']]);
    add('m5-stbl-uuid.3gp', Uint8Array.from(insert(src, ['moov', 'trak', 'mdia', 'minf', 'stbl'], box('uuid', uu))), [['UUID-IN-UDTA-SECRET', 'hidden']]);
    add('m6-top-uuid.3gp', Uint8Array.from(Buffer.concat([src, box('uuid', uu)])), [['UUID-IN-UDTA-SECRET', 'hidden']]);
  }
  return list;
}

describe('review probes (REVIEW_V15_1 M1–M4, S2–S6, S9, N1–N4): no "clean" verdict with planted data left', () => {
  const list = probes();
  const copies: { probe: Probe; p: Profile; file: string; orig: string }[] = [];
  const results: Record<string, Record<Profile, { status: string; problems: string[] } | 'unreadable'>> = {};
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    for (const probe of list) {
      const orig = join(OUT, `orig-${probe.file}`);
      writeFileSync(orig, probe.bytes);
      results[probe.file] = {} as Record<Profile, { status: string; problems: string[] }>;
      const r = inspect(new MemFile(probe.bytes, true));
      for (const p of PROFILES) {
        if (!r.supported) {
          results[probe.file][p] = 'unreadable';
          continue;
        }
        const { verdict, out } = runOne(probe.bytes, p);
        const file = join(OUT, `${p}-${probe.file}`);
        writeFileSync(file, out);
        results[probe.file][p] = { status: verdict.status, problems: verdict.problems };
        if (verdict.status === 'clean') copies.push({ probe, p, file, orig });
      }
    }
  });

  it("all 42 of the reviewer's probes (\"about 45\" in the review) plus P7c are here", () => {
    expect(list).toHaveLength(43);
  });

  it.each(probes().map((x) => [x.file] as [string]))('%s', (name) => {
    const probe = list.find((x) => x.file === name)!;
    for (const p of PROFILES) {
      const res = results[name][p];
      const want = probe.expect === 'unreadable' ? 'unreadable' : probe.expect?.[p];
      if (want === 'unreadable') {
        expect({ p, res }).toEqual({ p, res: 'unreadable' });
        continue;
      }
      expect({ p, readable: res !== 'unreadable' }).toEqual({ p, readable: true });
      if (res === 'unreadable') continue;
      // Every probe is cleanable now unless it is an honest "not clean" case (the review: C1 could never be cleaned).
      expect({ p, status: res.status === 'clean' ? 'clean' : 'not clean', problems: res.status === 'clean' ? [] : res.problems }).toMatchObject({ p, status: want === 'not-clean' ? 'not clean' : 'clean' });
      if (res.status !== 'clean') continue;
      const out = readFileSync(join(OUT, `${p}-${name}`));
      const left = probe.needles.filter(([n, c]) => mustGo(c, p) && has(out, n)).map(([n]) => show(n));
      expect({ p, left }).toEqual({ p, left: [] });
      // "Location only" keeps everything that is not location (and that sits where the file format puts it).
      const lost = probe.needles.filter(([n, c]) => p === 'location' && c === 'person' && !has(out, n)).map(([n]) => show(n));
      expect({ p, lost }).toEqual({ p, lost: [] });
    }
  });

  it('every clean TIFF/DNG/GIF copy passes the Python referee (picture and decode hashes, no unreferenced bytes) and ExifTool', () => {
    const judged = copies.filter((c) => !c.file.endsWith('.3gp'));
    const py = python([...new Set(judged.flatMap((c) => [c.orig, c.file]))]);
    const ex = exif(judged.filter((c) => c.p !== 'location').map((c) => c.file));
    const bad: string[] = [];
    for (const c of judged) {
      const a = py[c.orig];
      const b = py[c.file];
      const id = `${c.p}/${c.probe.file}`;
      if (a.format === 'tiff') {
        if (a.dataSha256 !== b.dataSha256) bad.push(`${id}: picture hash`);
        if (a.decodeSha256 !== b.decodeSha256) bad.push(`${id}: decode-tag hash`);
        if (b.unreferencedNonZero !== 0 || (b.largestGap ?? 0) > 3) bad.push(`${id}: unreferenced bytes ${b.unreferencedNonZero}/${b.largestGap}`);
        if (c.p === 'all') for (const t of b.extraTags ?? []) if (![0x0112, 0x8773, 0xc614].includes(t)) bad.push(`${id}: tag 0x${t.toString(16)}`);
      } else if (a.format === 'gif') {
        if (a.pictureSha256 !== b.pictureSha256) bad.push(`${id}: frames hash`);
        if (b.plainText?.length) bad.push(`${id}: plain text`);
        for (const k of b.blocks ?? []) if (k.label === 0xf9 && JSON.stringify(k.subBlocks) !== '[4]') bad.push(`${id}: control block`);
      }
      for (const [k, v] of Object.entries(ex[c.file] ?? {})) if (BAD.test(k) && !(k.endsWith('UniqueCameraModel') && v === 'Camera')) bad.push(`${id}: ExifTool ${k}=${String(v).slice(0, 40)}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------- the reviewer's fuzz corpus (generator and seed unchanged) ----------

describe('500 seeded mutations (reviewer fuzz, seed 20261016): every "clean" verdict survives three outside oracles', () => {
  let seed = 20261016;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (n: number) => Math.floor(rnd() * n);
  const tables = (b: Buffer): { at: number; n: number }[] => {
    const le = b[0] === 0x49;
    const r16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const r32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const out: { at: number; n: number }[] = [];
    const todo = [r32(4)];
    const seen = new Set<number>();
    while (todo.length && out.length < 64) {
      const at = todo.shift()!;
      if (seen.has(at) || at + 2 > b.length) continue;
      seen.add(at);
      const n = r16(at);
      if (at + 6 + 12 * n > b.length) continue;
      out.push({ at, n });
      for (let i = 0; i < n; i++) {
        const e = at + 2 + 12 * i;
        const tag = r16(e);
        const type = r16(e + 2);
        const cnt = r32(e + 4);
        if ([0x14a, 0x8769, 0x8825, 0xa005].includes(tag) && (type === 4 || type === 13)) {
          if (cnt === 1) todo.push(r32(e + 8));
          else if (cnt < 16) for (let k = 0; k < cnt; k++) todo.push(r32(r32(e + 8) + 4 * k));
        }
      }
      const nx = r32(at + 2 + 12 * n);
      if (nx) todo.push(nx);
    }
    return out;
  };
  const mutate = (orig: Buffer, gif: boolean): { b: Buffer; how: string } => {
    const b = Buffer.from(orig);
    const k = ri(6);
    if (gif) {
      const end = Math.min(b.length, 4096);
      if (k === 0) {
        const at = ri(b.length);
        return { b: b.subarray(0, at), how: `truncate@${at}` };
      }
      const n = 1 + ri(4);
      const pos: number[] = [];
      for (let i = 0; i < n; i++) {
        const at = 13 + ri(end - 13);
        b[at] = k === 1 ? 0 : k === 2 ? 0xff : ri(256);
        pos.push(at);
      }
      return { b, how: `gif-bytes k${k} @${pos.join(',')}` };
    }
    const t = tables(b);
    if (k === 0 || !t.length) {
      const at = 8 + ri(b.length - 8);
      return { b: b.subarray(0, at), how: `truncate@${at}` };
    }
    const tb = t[ri(t.length)];
    const i = ri(Math.max(1, tb.n));
    const e = tb.at + 2 + 12 * i;
    const le = b[0] === 0x49;
    const w32 = (o: number, v: number) => (le ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o));
    const w16 = (o: number, v: number) => (le ? b.writeUInt16LE(v & 0xffff, o) : b.writeUInt16BE(v & 0xffff, o));
    const interesting = [0, 1, 4, 8, 0xffff, 0xffffffff, b.length, b.length - 1, b.length - 4, ...t.map((x) => x.at), ri(b.length)];
    if (k === 1) {
      w16(e, [0x8825, 0x8769, 0x14a, 0xa005, 0x111, 0x117, 0x2bc, 0x927c, 0xc614, 0x13b, ri(65536)][ri(11)]);
      return { b, how: `tag@${e}` };
    }
    if (k === 2) {
      w16(e + 2, [0, 1, 2, 3, 4, 7, 13, 16, 99][ri(9)]);
      return { b, how: `type@${e}` };
    }
    if (k === 3) {
      w32(e + 4, interesting[ri(interesting.length)]);
      return { b, how: `count@${e}` };
    }
    if (k === 4) {
      w32(e + 8, interesting[ri(interesting.length)]);
      return { b, how: `value@${e}` };
    }
    const c = ri(3);
    if (c === 0 && tb.n > 1) {
      b.copy(b, tb.at + 2 + 12 * ri(tb.n), e, e + 12);
      return { b, how: `dupentry@${tb.at}` };
    }
    if (c === 1) {
      w16(tb.at, [0, 1, tb.n - 1, tb.n + 1, 4095, 65535][ri(6)]);
      return { b, how: `ifdcount@${tb.at}` };
    }
    w32(tb.at + 2 + 12 * tb.n, interesting[ri(interesting.length)]);
    return { b, how: `next@${tb.at}` };
  };

  it('0 crashes; every clean copy: same Python picture/decode hash, no unreferenced bytes, no ExifTool survivor, no byte survivor', () => {
    const dir = join(OUT, 'fuzz');
    mkdirSync(dir, { recursive: true });
    const per: Record<string, number> = { 'photo.tiff': 130, 'pages.tiff': 110, 'photo.dng': 130, 'meta.gif': 100, 'camera.nef': 30 };
    const rows: { id: string; how: string; status: string; files?: [string, string]; needles: string[]; crash?: string }[] = [];
    for (const name of Object.keys(per)) {
      const orig = readFileSync(join(FIX, name));
      const o = inspect(new MemFile(orig, true));
      const needles = o.fields.filter((f) => f.sensitivity !== 'none').flatMap((f) => f.needles).filter((s) => s.length >= 6 && !/^[\d\s:.,/+-]+$/.test(s));
      for (let j = 0; j < per[name]; j++) {
        const { b, how } = mutate(orig, name.endsWith('.gif'));
        const id = `${name}-${j}`;
        try {
          const r = inspect(new MemFile(b, true));
          if (!r.supported || r.notCleanable) {
            rows.push({ id, how, status: r.notCleanable ? 'raw' : (r.problem ?? 'unsupported'), needles });
            continue;
          }
          const { verdict, out } = runOne(b, 'all');
          const row: (typeof rows)[number] = { id, how, status: verdict.status, needles };
          if (verdict.status === 'clean') {
            const fo = join(dir, `${id}.orig`);
            const fc = join(dir, `${id}.copy`);
            writeFileSync(fo, b);
            writeFileSync(fc, out);
            row.files = [fo, fc];
          }
          rows.push(row);
        } catch (e) {
          rows.push({ id, how, status: 'crash', needles, crash: String(e).slice(0, 200) });
        }
      }
    }
    const cleanRows = rows.filter((r) => r.files);
    const py = python(cleanRows.flatMap((r) => r.files!));
    const ex = exif(cleanRows.map((r) => r.files![1]));
    const bad: string[] = [];
    for (const r of cleanRows) {
      const [fo, fc] = r.files!;
      const a = py[fo];
      const c = py[fc];
      if (a.format === 'tiff' && !a.errors.length) {
        if (a.dataSha256 !== c.dataSha256) bad.push(`${r.id} ${r.how}: picture hash`);
        if (a.decodeSha256 !== c.decodeSha256) bad.push(`${r.id} ${r.how}: decode-tag hash`);
      }
      if (a.format === 'tiff' && (c.unreferencedNonZero !== 0 || (c.largestGap ?? 0) > 3)) bad.push(`${r.id} ${r.how}: unreferenced bytes`);
      if (a.format === 'gif' && !a.errors.length && a.pictureSha256 !== c.pictureSha256) bad.push(`${r.id} ${r.how}: frames hash`);
      for (const [k, v] of Object.entries(ex[fc] ?? {})) if (BAD.test(k) && !(k.endsWith('UniqueCameraModel') && v === 'Camera')) bad.push(`${r.id} ${r.how}: ExifTool ${k}=${String(v).slice(0, 40)}`);
      const copy = readFileSync(fc);
      for (const n of r.needles) if (has(copy, n)) bad.push(`${r.id} ${r.how}: byte survivor ${n}`);
    }
    const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    writeFileSync(join(OUT, 'fuzz-summary.json'), JSON.stringify({ counts, bad, crashes: rows.filter((r) => r.crash) }, null, 1));
    expect(rows).toHaveLength(500);
    expect(rows.filter((r) => r.crash).map((r) => `${r.id} ${r.how} ${r.crash}`)).toEqual([]);
    expect(bad).toEqual([]);
    expect(cleanRows.length).toBeGreaterThan(200); // the corpus still exercises the cleaner (review run: 264 clean)
  }, 300000);
});

// ---------- targeted checks for fixes the probes do not pin down exactly ----------

describe('V1.5-1 fix round: targeted checks', () => {
  const dngWith = (entries: E[]) =>
    tiff([{ kind: 'ifd', name: 'IFD0', entries: [...picTags(), { tag: 0xc612, val: { t: 1, b: Uint8Array.from([1, 4, 0, 0]) } }, ...entries] }, { kind: 'blob', name: 'strip', bytes: pixels() }]);
  const pyOf = (b: Uint8Array, name: string) => {
    const file = join(OUT, name);
    writeFileSync(file, b);
    return python([file])[file] as Py & { uniqueCameraModel: string[]; dirs: { tags: { tag: number; type: number }[] }[] };
  };

  it('S8: the DNG camera-model tag stays a valid ASCII value in every storage form, and verify needs it', () => {
    for (const [model, label] of [[{ t: 2, s: 'X1' }, 'short'], [{ t: 1, b: txt('Pixel 8 Pro\0') }, 'bytes']] as const) {
      const orig = dngWith([{ tag: 0xc614, val: model }]);
      const all = runOne(orig, 'all');
      expect(all.verdict.status).toBe('clean');
      expect(pyOf(all.out, `s8-${label}-all.dng`).uniqueCameraModel).toEqual(['Camera']);
      const loc = runOne(orig, 'location');
      expect(loc.verdict.status).toBe('clean');
      const py = pyOf(loc.out, `s8-${label}-loc.dng`);
      expect(py.uniqueCameraModel).toEqual([label === 'short' ? 'X1' : 'Pixel 8 Pro']);
      expect(py.dirs[0].tags.find((t) => t.tag === 0xc614)?.type).toBe(2);
    }
    // A DNG copy without the tag is never clean (DNG 1.7 requires it).
    const src = new MemFile(dngWith([{ tag: 0xc614, val: { t: 2, s: 'X1' } }]), true);
    const dst = new MemFile(dngWith([]), true);
    const v = verify({ src, dst, before: inspect(src), profile: 'all' });
    expect(v.status).not.toBe('clean');
    expect(v.problems).toContain('DNG copy without its required camera model tag');
  });

  it('DNG camera calibration: kept when both calibration names match, dropped with the names when they do not (rendering unchanged)', () => {
    // CameraCalibration1 is 9 SRATIONAL (type 10) values of 1/1, written as bytes and retyped below.
    const sr = Buffer.alloc(72);
    for (let i = 0; i < 9; i++) {
      sr.writeInt32LE(1, i * 8);
      sr.writeInt32LE(1, i * 8 + 4);
    }
    const withSigs = (cam: string, prof: string) => {
      const b = Buffer.from(dngWith([{ tag: 0xc614, val: { t: 2, s: 'Cam' } }, { tag: 0xc623, val: { t: 7, b: Uint8Array.from(sr) } }, { tag: 0xc6f3, val: { t: 2, s: cam } }, { tag: 0xc6f4, val: { t: 2, s: prof } }]));
      patchEntry(b, 0xc623, (e) => {
        b.writeUInt16LE(10, e + 2);
        b.writeUInt32LE(9, e + 4);
      });
      return Uint8Array.from(b);
    };
    const tagsOf = (b: Uint8Array, n: string) => pyOf(b, n).dirs[0].tags.map((t) => t.tag);
    // "Location only" keeps the names (software fields), so the matrix stays as it was.
    const loc = runOne(withSigs('com.example.cal', 'com.other.profile'), 'location');
    expect(loc.verdict.status).toBe('clean');
    expect(tagsOf(loc.out, 'cal-loc.dng')).toEqual(expect.arrayContaining([0xc623, 0xc6f3, 0xc6f4]));
    const same = runOne(withSigs('com.example.cal', 'com.example.cal'), 'all');
    expect(same.verdict.status).toBe('clean');
    expect(tagsOf(same.out, 'cal-same.dng')).toContain(0xc623);
    const differ = runOne(withSigs('com.example.cal', 'com.other.profile'), 'all');
    expect(differ.verdict.status).toBe('clean'); // the matrix DNG did not apply is dropped: the picture renders as before
    expect(tagsOf(differ.out, 'cal-differ.dng')).not.toContain(0xc623);
    expect(tagsOf(differ.out, 'cal-differ.dng').filter((t) => t === 0xc6f3 || t === 0xc6f4)).toEqual([]);
  });

  it('S4 in the v1 JPEG path (L27(2)): an APP2 block that only claims to be a colour profile is removed, a real one is kept', () => {
    const real = readFileSync(join(FIX, 'photo.jpg'));
    const soi = Buffer.from([0xff, 0xd8]);
    const body = Buffer.from('ICC_PROFILE\0\x01\x01NOT-AN-ICC-PROFILE owner Tim Example', 'latin1');
    const app2 = Buffer.concat([Buffer.from([0xff, 0xe2, 0, 0]), body]);
    app2.writeUInt16BE(body.length + 2, 2);
    const fake = Uint8Array.from(Buffer.concat([soi, app2, real.subarray(2)]));
    const r = inspect(new MemFile(fake, true));
    expect(r.fields.find((f) => f.id === 'icc:Invalid')).toMatchObject({ known: false, group: 'other' });
    for (const p of PROFILES) {
      const { verdict, out } = runOne(fake, p);
      expect({ p, status: verdict.status, left: has(out, 'NOT-AN-ICC-PROFILE') }).toEqual({ p, status: 'clean', left: false });
    }
    const { out } = runOne(Uint8Array.from(real), 'all');
    expect(inspect(new MemFile(out, true)).fields.some((f) => f.id === 'icc:ICC_Profile')).toBe(true);
  });

  it('S4 in the v1 WebP path: an ICCP chunk that is not an ICC profile is dropped and the ICC flag cleared', () => {
    const w = Buffer.from(readFileSync(join(FIX, 'exif.webp')));
    const at = w.indexOf(Buffer.from('ICCP', 'latin1'));
    const n = w.readUInt32LE(at + 4);
    w.fill(0x20, at + 8, at + 8 + n);
    w.write('NOT-AN-ICC-PROFILE owner Tim Example', at + 8, 'latin1');
    const fake = Uint8Array.from(w);
    expect(inspect(new MemFile(fake, true)).fields.find((f) => f.id === 'icc:Invalid')).toBeDefined();
    for (const p of PROFILES) {
      const { verdict, out } = runOne(fake, p);
      const o = Buffer.from(out);
      expect({ p, status: verdict.status, left: has(out, 'NOT-AN-ICC-PROFILE'), iccp: o.indexOf(Buffer.from('ICCP', 'latin1')) >= 0, iccFlag: (o[20] & 0x20) !== 0 }).toEqual({ p, status: 'clean', left: false, iccp: false, iccFlag: false });
    }
  });

  it('S6: "Location only" keeps the GIF IPTC author and removes the city (per dataset)', () => {
    const iptc = Buffer.concat([Buffer.from([0x1c, 2, 80, 0, 9]), Buffer.from('BYLINE-TM', 'latin1'), Buffer.from([0x1c, 2, 90, 0, 8]), Buffer.from('CITY-BER', 'latin1')]);
    const g = bytes(gifHead, gifApp('MGKIPTC0000', sub(Uint8Array.from(iptc))), gifFrame, [0x3b]);
    const { verdict, out } = runOne(g, 'location');
    expect(verdict.status).toBe('clean');
    const after = inspect(new MemFile(out, true));
    expect(after.fields.map((f) => `${f.id}=${f.value}`)).toEqual(expect.arrayContaining(['iptc:By-line=BYLINE-TM']));
    expect(after.fields.some((f) => f.id === 'iptc:City')).toBe(false);
  });
});
