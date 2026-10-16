// V1.5-1 fixtures ("More files in"): TIFF, DNG, a vendor RAW, GIF with metadata, 3GP and an audio file that stays unsupported.
// Inputs: the outputs of `make-images <tmp> v15` (photo.tiff, pages.tiff, base.gif) and `make-video <tmp> v15` (video.3gp) —
// real ImageIO / AVFoundation files. Everything else is built byte-wise here because no tool on this Mac writes DNG, a Nikon
// NEF or GIF metadata blocks.
// Outputs (into outDir): photo.tiff pages.tiff video.3gp (copied unchanged), meta.gif photo.dng camera.nef voice.m4a
// Usage: node scripts/fixtures/make-v15.mjs <swiftOutDir> [outDir=test/fixtures]
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const inDir = resolve(process.argv[2]);
const dir = resolve(process.argv[3] ?? 'test/fixtures');
const wr = (n, b) => {
  writeFileSync(join(dir, n), b);
  console.log(`wrote ${n} (${b.length} bytes)`);
};
const cat = (...p) => Buffer.concat(p.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : x)));

for (const n of ['photo.tiff', 'pages.tiff', 'video.3gp']) {
  copyFileSync(join(inDir, n), join(dir, n));
  console.log(`copied ${n}`);
}

// ---------------------------------------------------------------- a small TIFF writer (two passes: layout, then bytes)
// An IFD is { entries: Entry[], next?: IFD }. Entry: { tag, type, data: Buffer, count } | { tag, sub: IFD[] } (pointer
// tags, type LONG) | { tag: 0x111, strips: Buffer[] } (StripOffsets; StripByteCounts 0x117 is added automatically).
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 13: 4 };
function makeTiff(le, root) {
  const w16 = (b, o, v) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b, o, v) => (le ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o));
  const ifds = [];
  const visit = (ifd) => {
    ifds.push(ifd);
    for (const e of ifd.entries) if (e.sub) e.sub.forEach(visit);
    if (ifd.next) visit(ifd.next);
  };
  visit(root);
  // Expand strips into StripByteCounts.
  for (const ifd of ifds) {
    const s = ifd.entries.find((e) => e.strips);
    if (s && !ifd.entries.some((e) => e.tag === 0x117)) ifd.entries.push({ tag: 0x117, type: 4, count: s.strips.length, data: Buffer.alloc(4 * s.strips.length) });
    for (const e of ifd.entries) {
      if (e.strips) Object.assign(e, { type: 4, count: e.strips.length, data: Buffer.alloc(4 * e.strips.length) });
      if (e.sub) Object.assign(e, { type: 4, count: e.sub.length, data: Buffer.alloc(4 * e.sub.length) });
      if (e.tag === 0x117 && s) s.strips.forEach((b, i) => w32(e.data, 4 * i, b.length));
    }
    ifd.entries.sort((a, b) => a.tag - b.tag);
  }
  // Pass 1: offsets.
  let pos = 8;
  for (const ifd of ifds) {
    ifd.at = pos;
    pos += 2 + 12 * ifd.entries.length + 4;
    for (const e of ifd.entries) if (e.data.length > 4) {
      e.at = pos;
      pos += e.data.length + (e.data.length & 1);
    }
  }
  for (const ifd of ifds) for (const e of ifd.entries) if (e.strips) e.stripAt = e.strips.map((b) => { const at = pos; pos += b.length + (b.length & 1); return at; });
  const out = Buffer.alloc(pos);
  out.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(out, 2, 42);
  w32(out, 4, root.at);
  for (const ifd of ifds) {
    for (const e of ifd.entries) {
      if (e.sub) e.sub.forEach((x, i) => w32(e.data, 4 * i, x.at));
      if (e.strips) e.stripAt.forEach((at, i) => { w32(e.data, 4 * i, at); e.strips[i].copy(out, at); });
    }
    w16(out, ifd.at, ifd.entries.length);
    ifd.entries.forEach((e, i) => {
      const o = ifd.at + 2 + 12 * i;
      w16(out, o, e.tag);
      w16(out, o + 2, e.type);
      w32(out, o + 4, e.count);
      if (e.data.length <= 4) e.data.copy(out, o + 8);
      else {
        w32(out, o + 8, e.at);
        e.data.copy(out, e.at);
      }
    });
    w32(out, ifd.at + 2 + 12 * ifd.entries.length, ifd.next ? ifd.next.at : 0);
  }
  return out;
}

function tagsFor(le) {
  const b16 = (v) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const b32 = (v) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v >>> 0) : b.writeUInt32BE(v >>> 0); return b; };
  const s32 = (v) => { const b = Buffer.alloc(4); le ? b.writeInt32LE(v) : b.writeInt32BE(v); return b; };
  return {
    ascii: (tag, s) => { const data = Buffer.from(s + '\0', 'utf8'); return { tag, type: 2, count: data.length, data }; },
    short: (tag, ...v) => ({ tag, type: 3, count: v.length, data: Buffer.concat(v.map(b16)) }),
    long: (tag, ...v) => ({ tag, type: 4, count: v.length, data: Buffer.concat(v.map(b32)) }),
    byte: (tag, ...v) => ({ tag, type: 1, count: v.length, data: Buffer.from(v) }),
    undef: (tag, data) => ({ tag, type: 7, count: data.length, data: Buffer.from(data) }),
    bytes: (tag, data) => ({ tag, type: 1, count: data.length, data: Buffer.from(data) }),
    rational: (tag, ...v) => ({ tag, type: 5, count: v.length, data: Buffer.concat(v.flatMap(([n, d]) => [b32(n), b32(d)])) }),
    srational: (tag, ...v) => ({ tag, type: 10, count: v.length, data: Buffer.concat(v.flatMap(([n, d]) => [s32(n), s32(d)])) }),
  };
}

const xmpPacket = (body) =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ` +
  `xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const iptc = (...ds) => Buffer.concat(ds.map(([rec, set, s]) => { const v = Buffer.from(s, 'utf8'); const h = Buffer.from([0x1c, rec, set, 0, 0]); h.writeUInt16BE(v.length, 3); return cat(h, v); }));
const LAT_MUC = [[48, 1], [8, 1], [3000, 100]];
const LON_MUC = [[11, 1], [34, 1], [1200, 100]];

// ---------------------------------------------------------------- photo.dng (iPhone-ProRAW-like layout, little-endian)
// IFD0 = 64x48 RGB preview (NewSubfileType 1) with the identifying tags; SubIFD = 128x96 16-bit Bayer raw (RGGB).
{
  const t = tagsFor(true);
  const preview = Buffer.alloc(64 * 48 * 3);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) preview.set([x * 4, y * 5, ((x >> 3) + (y >> 3)) % 2 ? 200 : 60], (y * 64 + x) * 3);
  const raw = Buffer.alloc(128 * 96 * 2);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
    const c = (y & 1) * 2 + (x & 1); // 0 R, 1 G, 2 G, 3 B
    const v = c === 0 ? x * 30 : c === 3 ? y * 40 : 1200 + ((x >> 4) + (y >> 4)) % 2 * 1500;
    raw.writeUInt16LE(Math.min(4095, v), (y * 128 + x) * 2);
  }
  const rawIfd = { entries: [
    t.long(0xfe, 0), t.long(0x100, 128), t.long(0x101, 96), t.short(0x102, 16), t.short(0x103, 1), t.short(0x106, 32803),
    { tag: 0x111, strips: [raw] }, t.short(0x115, 1), t.long(0x116, 96), t.short(0x11c, 1),
    t.short(0x828d, 2, 2), t.byte(0x828e, 0, 1, 1, 2), t.short(0xc61a, 0), t.short(0xc61d, 4095),
    t.ascii(0x10e, 'Fixture raw IFD secret description'),
  ] };
  const exif = { entries: [
    t.rational(0x829a, [1, 125]), t.rational(0x829d, [178, 100]), t.short(0x8827, 64), t.undef(0x9000, '0232'),
    t.ascii(0x9003, '2025:06:14 09:30:15'), t.ascii(0x9011, '+02:00'), t.rational(0x920a, [686, 100]),
    t.undef(0x927c, cat('Apple iOS\0', Buffer.from([0, 1]), 'MM', 'FIXTURE-DNG-MAKERNOTE-SECRET', Buffer.alloc(16))),
    t.ascii(0xa420, 'F1X7URE0D1A9C0FFEE00UNIQUE1D0001'), t.ascii(0xa431, 'SN-DNG-BODY-888'),
    t.ascii(0xa434, 'iPhone 15 Pro back triple camera 6.86mm f/1.78'),
  ] };
  const gps = { entries: [
    t.byte(0, 2, 2, 0, 0), t.ascii(1, 'N'), t.rational(2, ...LAT_MUC), t.ascii(3, 'E'), t.rational(4, ...LON_MUC),
    t.byte(5, 0), t.rational(6, [520, 1]), t.ascii(0x1d, '2025:06:14'),
  ] };
  const xmp = xmpPacket('dc:format="image/dng" xmp:CreatorTool="FixtureRAW 1.0" photoshop:City="Munich" exif:GPSLatitude="48,8.5N" exif:GPSLongitude="11,34.2E" crs:Exposure2012="+0.30">' +
    '<dc:creator><rdf:Seq><rdf:li>Jane Fixture DNG</rdf:li></rdf:Seq></dc:creator>');
  const ifd0 = { entries: [
    t.long(0xfe, 1), t.long(0x100, 64), t.long(0x101, 48), t.short(0x102, 8, 8, 8), t.short(0x103, 1), t.short(0x106, 2),
    t.ascii(0x10f, 'Apple'), t.ascii(0x110, 'iPhone 15 Pro'), { tag: 0x111, strips: [preview] }, t.short(0x112, 6),
    t.short(0x115, 3), t.long(0x116, 48), t.short(0x11c, 1), t.ascii(0x131, '17.1'), t.ascii(0x132, '2025:06:14 09:30:15'),
    { tag: 0x14a, sub: [rawIfd] }, t.bytes(0x2bc, Buffer.from(xmp, 'utf8')),
    t.undef(0x83bb, iptc([2, 80, 'Jane Fixture IPTC'], [2, 90, 'Munich'])),
    { tag: 0x8769, sub: [exif] }, { tag: 0x8825, sub: [gps] },
    t.byte(0xc612, 1, 4, 0, 0), t.byte(0xc613, 1, 3, 0, 0), t.ascii(0xc614, 'iPhone 15 Pro'),
    t.srational(0xc621, [10000, 10000], [-2000, 10000], [-1000, 10000], [-3000, 10000], [12000, 10000], [1000, 10000], [-500, 10000], [1500, 10000], [7000, 10000]),
    t.rational(0xc628, [5, 10], [10, 10], [7, 10]), t.srational(0xc62a, [0, 100]), t.ascii(0xc62f, 'SN-DNG-777'),
    t.bytes(0xc634, cat('Adobe\0', 'MakN', Buffer.from([0, 0, 0, 40]), 'MM', Buffer.from([0, 0, 0, 0]), 'FIXTURE-DNG-PRIVATE-SECRET', Buffer.alloc(8))),
    t.short(0xc65a, 21), t.bytes(0xc65d, Buffer.from('c0ffee00112233445566778899aabbcc', 'hex')),
    t.ascii(0xc68b, 'IMG_20250614_093015.DNG'), t.ascii(0xc6f8, 'Fixture Profile'),
    t.ascii(0xc716, 'FixtureRAW Preview'), t.ascii(0xc71b, '2025-06-14T09:30:15+02:00'),
  ] };
  wr('photo.dng', makeTiff(true, ifd0));
}

// ---------------------------------------------------------------- camera.nef (vendor RAW: Nikon-style, inspect only)
{
  const t = tagsFor(true);
  const preview = Buffer.alloc(32 * 24 * 3, 0x80);
  const raw = Buffer.alloc(64 * 48 * 3 / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) & 0xff; // stands in for Nikon-compressed data (never decoded)
  const rawIfd = { entries: [
    t.long(0xfe, 0), t.long(0x100, 64), t.long(0x101, 48), t.short(0x102, 12), t.short(0x103, 34713), t.short(0x106, 32803),
    { tag: 0x111, strips: [raw] }, t.short(0x115, 1), t.long(0x116, 48), t.short(0x11c, 1), t.short(0x828d, 2, 2), t.byte(0x828e, 0, 1, 1, 2),
  ] };
  const mn = cat('Nikon\0', Buffer.from([2, 0x11, 0, 0]), 'II*\0', Buffer.from([8, 0, 0, 0]), Buffer.from([0, 0, 0, 0, 0, 0]), 'FIXTURE-NEF-MAKERNOTE-SECRET');
  const exif = { entries: [t.rational(0x829a, [1, 250]), t.rational(0x829d, [40, 10]), t.ascii(0x9003, '2024:12:24 18:00:00'), t.undef(0x927c, mn), t.ascii(0xa431, 'SN-NEF-321')] };
  const gps = { entries: [t.byte(0, 2, 3, 0, 0), t.ascii(1, 'N'), t.rational(2, ...LAT_MUC), t.ascii(3, 'E'), t.rational(4, ...LON_MUC)] };
  const ifd0 = { entries: [
    t.long(0xfe, 1), t.long(0x100, 32), t.long(0x101, 24), t.short(0x102, 8, 8, 8), t.short(0x103, 1), t.short(0x106, 2),
    t.ascii(0x10f, 'NIKON CORPORATION'), t.ascii(0x110, 'NIKON Z 6'), { tag: 0x111, strips: [preview] }, t.short(0x115, 3), t.long(0x116, 24),
    t.ascii(0x131, 'Ver.01.00'), t.ascii(0x13b, 'Jane Fixture NEF'), { tag: 0x14a, sub: [rawIfd] }, t.ascii(0x8298, '(c) Jane Fixture NEF'),
    { tag: 0x8769, sub: [exif] }, { tag: 0x8825, sub: [gps] },
  ] };
  wr('camera.nef', makeTiff(true, ifd0));
}

// ---------------------------------------------------------------- meta.gif (ImageIO GIF + metadata blocks byte-wise)
// Comment, XMP application extension (with the 257-byte "magic trailer"), ImageMagick IPTC block, an ICC profile block and
// data after the trailer. ImageIO writes GIF87a; extensions need GIF89a.
{
  const base = readFileSync(join(inDir, 'base.gif'));
  const packed = base[10];
  const gctEnd = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  const subBlocks = (b) => {
    const parts = [];
    for (let i = 0; i < b.length; i += 255) {
      const c = b.subarray(i, i + 255);
      parts.push(Buffer.from([c.length]), c);
    }
    return cat(...parts, Buffer.from([0]));
  };
  const app = (id, data) => cat(Buffer.from([0x21, 0xff, 11]), id, subBlocks(data));
  const comment = cat(Buffer.from([0x21, 0xfe]), subBlocks(Buffer.from('Fixture GIF meta secret comment', 'latin1')));
  const magic = Buffer.alloc(257);
  magic[0] = 1;
  for (let i = 0; i < 256; i++) magic[1 + i] = 255 - i;
  const xmp = xmpPacket('xmp:CreatorTool="FixtureGIF 5.0" photoshop:City="Vienna" exif:GPSLatitude="48,12.5N" exif:GPSLongitude="16,22.2E">' +
    '<dc:creator><rdf:Seq><rdf:li>Jane Fixture GIF</rdf:li></rdf:Seq></dc:creator>');
  const xmpBlock = cat(Buffer.from([0x21, 0xff, 11]), 'XMP DataXMP', Buffer.from(xmp, 'utf8'), magic, Buffer.from([0]));
  const iptcBlock = app('MGKIPTC0000', iptc([2, 80, 'Jane Fixture GIF IPTC'], [2, 101, 'Austria']));
  const tiff = readFileSync(join(inDir, 'photo.tiff'));
  // The Display P3 profile ImageIO wrote into photo.tiff (tag 0x8773), as a GIF ICC block.
  const iccAt = (() => {
    const ifd = tiff.readUInt32BE(4);
    const n = tiff.readUInt16BE(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i;
      if (tiff.readUInt16BE(e) === 0x8773) return [tiff.readUInt32BE(e + 8), tiff.readUInt32BE(e + 4)];
    }
    throw new Error('no ICC in photo.tiff');
  })();
  const iccBlock = app('ICCRGBG1012', tiff.subarray(iccAt[0], iccAt[0] + iccAt[1]));
  const loop = app('NETSCAPE2.0', Buffer.from([1, 0, 0]));
  let rest = base.subarray(gctEnd);
  // Keep ImageIO's own loop block first (where players look for it); add one when it wrote none.
  let first = loop;
  if (rest[0] === 0x21 && rest[1] === 0xff && rest.toString('latin1', 3, 14) === 'NETSCAPE2.0') {
    let i = 14;
    while (rest[i] !== 0) i += rest[i] + 1;
    first = rest.subarray(0, i + 1);
    rest = rest.subarray(i + 1);
  }
  if (rest[rest.length - 1] !== 0x3b) throw new Error('base.gif does not end with a trailer');
  const body = rest.subarray(0, rest.length - 1); // without the 0x3B trailer
  wr('meta.gif', cat('GIF89a', base.subarray(6, gctEnd), first, iccBlock, comment, xmpBlock, iptcBlock, body, Buffer.from([0x3b]), 'GIF-TRAILER-SECRET-DATA'));
}

// ---------------------------------------------------------------- voice.m4a (audio: stays "not supported yet", NICHE-SKIP #12)
{
  const rate = 8000, n = rate; // 1 s mono 16-bit sine
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  const wav = join(inDir, 'voice.wav');
  writeFileSync(wav, cat(h, pcm));
  execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wav, join(dir, 'voice.m4a')]);
  console.log('wrote voice.m4a (afconvert AAC)');
}
