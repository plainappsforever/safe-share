// Byte-level fixtures that the Mac's own tools cannot write. Deterministic (no timestamps, no randomness).
// Inputs (made first by make-images.swift / make-video.swift / make-pdf.swift): photo.jpg nometa.jpg photo.png gps.mp4 doc.pdf
// Outputs: exif.webp text.png extras.jpg ultrahdr.jpg motion.jpg revised.pdf corrupt.jpg anim.gif gps-xyz.mp4 flate-xmp.pdf
// Usage: node scripts/fixtures/make-synthetic.mjs [outDir=test/fixtures]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? 'test/fixtures');
const rd = (n) => readFileSync(join(dir, n));
const wr = (n, b) => {
  writeFileSync(join(dir, n), b);
  console.log(`wrote ${n} (${b.length} bytes)`);
};
const u16 = (n, le = false) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
const u32 = (n, le = false) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
const cat = (...p) => Buffer.concat(p.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : x)));

// ---------------------------------------------------------------- JPEG helpers
function parseJpeg(buf) {
  const segs = [];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad jpeg');
    const m = buf[i + 1];
    if (m === 0xda) return { segs, scan: buf.subarray(i) };
    const len = buf.readUInt16BE(i + 2);
    segs.push({ m, data: buf.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  throw new Error('no SOS');
}
const seg = (m, payload) => cat(Buffer.from([0xff, m]), u16(payload.length + 2), payload);
const buildJpeg = (segs, scan) => cat(Buffer.from([0xff, 0xd8]), ...segs.map((s) => seg(s.m, s.data)), scan);
const isExif = (s) => s.m === 0xe1 && s.data.subarray(0, 6).toString('latin1') === 'Exif\0\0';
const isXmp = (s) => s.m === 0xe1 && s.data.subarray(0, 29).toString('latin1') === 'http://ns.adobe.com/xap/1.0/\0';

// ---------------------------------------------------------------- XMP
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:fixture="http://safeshare.test/fixture/1.0/"';
function xmpPacket(inner, extraNs = '', attrs = '') {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" ${NS} ${extraNs} ${attrs}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>\n` +
    '<?xpacket end="w"?>'
  );
}
const dcCreator = (name) => `<dc:creator><rdf:Seq><rdf:li>${name}</rdf:li></rdf:Seq></dc:creator>`;
const xmpSeg = (xml) => ({ m: 0xe1, data: cat('http://ns.adobe.com/xap/1.0/\0', Buffer.from(xml, 'utf8')) });

// ---------------------------------------------------------------- TIFF / Exif builder
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
function valueBytes(e, le) {
  switch (e.type) {
    case 2: return cat(e.value, '\0');
    case 7: return e.value;
    case 1: return Buffer.from(e.value);
    case 3: return cat(...[].concat(e.value).map((v) => u16(v, le)));
    case 4: return cat(...[].concat(e.value).map((v) => u32(v, le)));
    case 5: return cat(...e.value.map(([n, d]) => cat(u32(n, le), u32(d, le))));
  }
}
const count = (e, vb) => (e.type === 2 || e.type === 7 || e.type === 1 ? vb.length : vb.length / TYPE_SIZE[e.type]);
const pad2 = (n) => n + (n & 1);
function ifdSize(entries, le) {
  let s = 2 + 12 * entries.length + 4;
  for (const e of entries) { const l = valueBytes(e, le).length; if (l > 4) s += pad2(l); }
  return s;
}
function writeIfd(entries, start, next, le) {
  entries = [...entries].sort((a, b) => a.tag - b.tag);
  const head = [u16(entries.length, le)];
  const data = [];
  let dataPos = start + 2 + 12 * entries.length + 4;
  for (const e of entries) {
    const vb = valueBytes(e, le);
    let field;
    if (vb.length <= 4) field = cat(vb, Buffer.alloc(4 - vb.length));
    else { field = u32(dataPos, le); const p = vb.length & 1 ? cat(vb, Buffer.alloc(1)) : vb; data.push(p); dataPos += p.length; }
    head.push(cat(u16(e.tag, le), u16(e.type, le), u32(count(e, vb), le), field));
  }
  head.push(u32(next, le));
  return cat(...head, ...data);
}
/** ifd0/exif/gps/ifd1 = entry arrays; thumb = Buffer for IFD1. Returns the TIFF bytes (no "Exif\0\0"). */
function buildTiff({ le, ifd0, exif, gps, ifd1, thumb }) {
  const p = { exif: 0, gps: 0 };
  const ifd0All = [...ifd0];
  if (exif) ifd0All.push({ tag: 0x8769, type: 4, value: 0 });
  if (gps) ifd0All.push({ tag: 0x8825, type: 4, value: 0 });
  const ifd1All = ifd1 ? [...ifd1, { tag: 0x0201, type: 4, value: 0 }, { tag: 0x0202, type: 4, value: thumb.length }] : null;
  let pos = 8;
  const at0 = pos; pos += ifdSize(ifd0All, le);
  const atE = exif ? pos : 0; if (exif) pos += ifdSize(exif, le);
  const atG = gps ? pos : 0; if (gps) pos += ifdSize(gps, le);
  const at1 = ifd1All ? pos : 0; if (ifd1All) pos += ifdSize(ifd1All, le);
  const atT = pos;
  const fix = (arr) => arr.map((e) => (e.tag === 0x8769 ? { ...e, value: atE } : e.tag === 0x8825 ? { ...e, value: atG } : e.tag === 0x0201 ? { ...e, value: atT } : e));
  return cat(
    le ? 'II*\0' : 'MM\0*', u32(8, le),
    writeIfd(fix(ifd0All), at0, at1, le),
    exif ? writeIfd(exif, atE, 0, le) : Buffer.alloc(0),
    gps ? writeIfd(gps, atG, 0, le) : Buffer.alloc(0),
    ifd1All ? writeIfd(fix(ifd1All), at1, 0, le) : Buffer.alloc(0),
    thumb ?? Buffer.alloc(0)
  );
}
const ascii = (tag, s) => ({ tag, type: 2, value: s });
const rat = (tag, pairs) => ({ tag, type: 5, value: pairs });
const short = (tag, v) => ({ tag, type: 3, value: v });

// ---------------------------------------------------------------- IPTC (APP13 Photoshop 3.0)
function iptcSegment(fields) {
  const ds = (rec, n, data) => cat(Buffer.from([0x1c, rec, n]), u16(data.length), data);
  const iim = cat(ds(1, 90, Buffer.from([0x1b, 0x25, 0x47])), ds(2, 0, Buffer.from([0, 2])),
    ...fields.map(([n, v]) => ds(2, n, Buffer.from(v, 'utf8'))));
  const res = cat('8BIM', u16(0x0404), Buffer.from([0, 0]), u32(iim.length), iim, iim.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0));
  return { m: 0xed, data: cat('Photoshop 3.0\0', res) };
}

// ---------------------------------------------------------------- read inputs
const photo = parseJpeg(rd('photo.jpg'));
const nometa = parseJpeg(rd('nometa.jpg'));
const gpsMp4 = rd('gps.mp4');
const photoExifTiff = photo.segs.find(isExif).data.subarray(6);
const iccSeg = photo.segs.find((s) => s.m === 0xe2 && s.data.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0');
const iccProfile = iccSeg.data.subarray(14); // after "ICC_PROFILE\0" + seq + count

// A tiny JPEG thumbnail (no metadata) for IFD1, made with sips then stripped of APPn segments.
const tmp = mkdtempSync(join(tmpdir(), 'thumb-'));
execFileSync('sips', ['-z', '30', '40', join(dir, 'nometa.jpg'), '--out', join(tmp, 't.jpg')], { stdio: 'ignore' });
const th = parseJpeg(readFileSync(join(tmp, 't.jpg')));
// Grayscale JPEG (one component) as the gain-map image of the Ultra HDR fixture.
execFileSync('sips', ['--matchTo', '/System/Library/ColorSync/Profiles/Generic Gray Profile.icc', join(dir, 'nometa.jpg'), '--out', join(tmp, 'g.jpg')], { stdio: 'ignore' });
const gray = parseJpeg(readFileSync(join(tmp, 'g.jpg')));
rmSync(tmp, { recursive: true, force: true });
const thumbJpeg = buildJpeg(th.segs.filter((s) => s.m < 0xe0 || s.m > 0xef), th.scan);

// ---------------------------------------------------------------- 1. exif.webp
{
  const tinyVp8l = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64').subarray(12); // 1x1 lossless image chunk
  const chunk = (id, data) => cat(id, u32(data.length, true), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0));
  const xmp = xmpPacket(dcCreator('Jane Fixture XMP') + '<xmp:CreatorTool>FixtureSoft XMP 2.0</xmp:CreatorTool><fixture:OwnerEmail>jane@fixture.test</fixture:OwnerEmail>');
  const vp8x = cat(Buffer.from([0x20 | 0x08 | 0x04, 0, 0, 0]), Buffer.from([0, 0, 0]), Buffer.from([0, 0, 0])); // ICC+EXIF+XMP, canvas 1x1
  const body = cat('WEBP', chunk('VP8X', vp8x), chunk('ICCP', iccProfile), tinyVp8l, chunk('EXIF', photoExifTiff), chunk('XMP ', Buffer.from(xmp, 'utf8')));
  wr('exif.webp', cat('RIFF', u32(body.length, true), body));
}

// ---------------------------------------------------------------- 2. text.png
{
  const png = rd('photo.png');
  const chunks = [];
  for (let i = 8; i < png.length;) {
    const len = png.readUInt32BE(i);
    chunks.push({ type: png.toString('latin1', i + 4, i + 8), data: png.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  const mk = (type, data) => cat(u32(data.length), type, data, u32(crc32(cat(type, data))));
  const get = (t) => chunks.filter((c) => c.type === t);
  const xmp = xmpPacket(dcCreator('Text Fixture XMP') + '<fixture:OwnerEmail>text@fixture.test</fixture:OwnerEmail>');
  const iTXt = cat('XML:com.adobe.xmp\0', Buffer.from([0, 0]), '\0', '\0', Buffer.from(xmp, 'utf8'));
  const zTXt = cat('Comment\0', Buffer.from([0]), deflateSync(Buffer.from('Fixture zTXt secret comment', 'latin1'), { level: 9 }));
  const tIME = cat(u16(2025), Buffer.from([6, 14, 9, 30, 15]));
  wr('text.png', cat(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mk('IHDR', get('IHDR')[0].data), ...get('iCCP').map((c) => mk('iCCP', c.data)),
    mk('tIME', tIME), mk('tEXt', cat('Author\0Jane Fixture Text')), mk('tEXt', cat('Software\0FixtureSoft PNG 3.0')),
    mk('zTXt', zTXt), mk('iTXt', iTXt), mk('eXIf', photoExifTiff),
    ...get('IDAT').map((c) => mk('IDAT', c.data)), mk('IEND', Buffer.alloc(0))
  ));
}

// ---------------------------------------------------------------- 3. extras.jpg
{
  const le = true;
  const exifTiff = buildTiff({
    le,
    ifd0: [ascii(0x010f, 'ExtrasCam'), ascii(0x0110, 'EX-2'), short(0x0112, 8), ascii(0x013b, 'Extras Artist'), ascii(0x0131, 'ExtrasSoft 2.0')],
    exif: [ascii(0x9003, '2024:12:24 18:00:00'), ascii(0xa431, 'SN-EXTRAS-789'),
      { tag: 0x927c, type: 7, value: cat('FIXTURE-MAKERNOTE-SECRET', Buffer.alloc(8, 0x11)) }],
    gps: [{ tag: 0, type: 1, value: [2, 3, 0, 0] }, ascii(1, 'N'), rat(2, [[48, 1], [51, 1], [3000, 100]]), ascii(3, 'E'), rat(4, [[2, 1], [17, 1], [4000, 100]])],
    ifd1: [{ tag: 0x0103, type: 3, value: 6 }],
    thumb: thumbJpeg,
  });
  const xmpExtBody = xmpPacket('<fixture:ExtendedSecret>extended-xmp-secret-value</fixture:ExtendedSecret>');
  const guid = createHash('md5').update(xmpExtBody).digest('hex').toUpperCase();
  const xmpMain = xmpPacket(dcCreator('Extras XMP Creator') + '<fixture:OwnerEmail>extras@fixture.test</fixture:OwnerEmail>', 'xmlns:xmpNote="http://ns.adobe.com/xmp/note/"', `xmpNote:HasExtendedXMP="${guid}"`);
  const extXmp = { m: 0xe1, data: cat('http://ns.adobe.com/xmp/extension/\0', guid, u32(Buffer.byteLength(xmpExtBody)), u32(0), Buffer.from(xmpExtBody, 'utf8')) };
  const iptc = iptcSegment([[80, 'Extras Byline'], [90, 'Hamburg'], [120, 'Extras caption']]);
  const com = { m: 0xfe, data: Buffer.from('Fixture COM secret comment', 'latin1') };
  const [jfif, ...rest] = nometa.segs;
  wr('extras.jpg', buildJpeg([jfif, { m: 0xe1, data: cat('Exif\0\0', exifTiff) }, xmpSeg(xmpMain), extXmp, iptc, com, ...rest], nometa.scan));
}

// ---------------------------------------------------------------- 4. ultrahdr.jpg
{
  const HDRGM = 'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"';
  // Secondary (gain map) JPEG with its own Exif and hdrgm XMP.
  const secExif = buildTiff({ le: true, ifd0: [ascii(0x013b, 'Gainmap Artist'), ascii(0x0110, 'GM-1')], exif: [ascii(0xa431, 'SN-GAINMAP-555')] });
  const secXmp = xmpPacket('<fixture:OwnerEmail>gainmap@fixture.test</fixture:OwnerEmail>', HDRGM, 'hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="2.3" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.3" hdrgm:BaseRenditionIsHDR="False"');
  const sRest = gray.segs.filter((s) => s.m < 0xe0 || s.m > 0xef);
  const secondary = buildJpeg([{ m: 0xe1, data: cat('Exif\0\0', secExif) }, xmpSeg(secXmp), ...sRest], gray.scan);
  const mpf = (primaryLen, secondaryOffset) => {
    const le = false; // MPF is big-endian in Ultra HDR files
    const entry = (attr, size, off) => cat(u32(attr, le), u32(size, le), u32(off, le), u16(0, le), u16(0, le));
    const entries = cat(entry(0x030000, primaryLen, 0), entry(0, secondary.length, secondaryOffset));
    const ifd = [
      { tag: 0xb000, type: 7, value: Buffer.from('0100', 'latin1') },
      { tag: 0xb001, type: 4, value: 2 },
      { tag: 0xb002, type: 7, value: entries },
    ];
    const base = 8;
    return { m: 0xe2, data: cat('MPF\0', le ? 'II*\0' : 'MM\0*', u32(8, le), writeIfd(ifd, base, 0, le)) };
  };
  const primaryXmp = xmpPacket(dcCreator('Ultra Fixture XMP') + '<fixture:OwnerEmail>ultra@fixture.test</fixture:OwnerEmail>',
    HDRGM + ' xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"',
    'hdrgm:Version="1.0"')
    .replace('</rdf:Description>', `<Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${secondary.length}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description>`);
  const base = photo.segs.filter((s) => !isXmp(s));
  const exifIdx = base.findIndex(isExif);
  const withXmp = [...base.slice(0, exifIdx + 1), xmpSeg(primaryXmp), ...base.slice(exifIdx + 1)];
  const draft = buildJpeg([...withXmp.slice(0, exifIdx + 2), mpf(0, 0), ...withXmp.slice(exifIdx + 2)], photo.scan);
  const primaryLen = draft.length; // MPF segment size does not depend on its values
  // Offsets in MPF entries are relative to the "MM" byte order mark inside the MPF segment.
  const mpfSegStart = 2 + withXmp.slice(0, exifIdx + 2).reduce((n, s) => n + 4 + s.data.length, 0);
  const tiffStart = mpfSegStart + 4 /*marker+len*/ + 4 /*"MPF\0"*/;
  const primary = buildJpeg([...withXmp.slice(0, exifIdx + 2), mpf(primaryLen, primaryLen - tiffStart), ...withXmp.slice(exifIdx + 2)], photo.scan);
  wr('ultrahdr.jpg', cat(primary, secondary));
}

// ---------------------------------------------------------------- 5. motion.jpg
{
  const xmp = xmpPacket(dcCreator('Motion Fixture XMP') + '<fixture:OwnerEmail>motion@fixture.test</fixture:OwnerEmail>',
    'xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"',
    'GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1" GCamera:MotionPhotoPresentationTimestampUs="1000000"')
    .replace('</rdf:Description>', `<Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${gpsMp4.length}" Item:Padding="0"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description>`);
  const base = photo.segs.filter((s) => !isXmp(s));
  const exifIdx = base.findIndex(isExif);
  wr('motion.jpg', cat(buildJpeg([...base.slice(0, exifIdx + 1), xmpSeg(xmp), ...base.slice(exifIdx + 1)], photo.scan), gpsMp4));
}

// ---------------------------------------------------------------- 6. revised.pdf (incremental update)
{
  const orig = rd('doc.pdf');
  const text = orig.toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
  const root = Number(/\/Root (\d+) 0 R/.exec(text)[1]);
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const catalog = new RegExp(`(?:^|\\n)${root} 0 obj\\s*(<<[\\s\\S]*?>>)\\s*endobj`).exec(text)[1];
  const infoNo = size, xmpNo = size + 1;
  const xmp = xmpPacket(dcCreator('Revised XMP Creator') + '<xmp:CreatorTool>RevisedTool 9.9</xmp:CreatorTool>');
  const parts = [];
  let off = orig.length;
  const offsets = {};
  const add = (no, body) => { offsets[no] = off; const b = Buffer.from(`${no} 0 obj\n${body}\nendobj\n`, 'latin1'); parts.push(b); off += b.length; };
  add(infoNo, '<< /Author (Second Author) /Title (Revised Secret Title) /Creator (RevisedWriter 2.0) >>');
  parts.push(Buffer.from(`${xmpNo} 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp)} >>\nstream\n`, 'latin1'), Buffer.from(xmp, 'utf8'), Buffer.from('\nendstream\nendobj\n', 'latin1'));
  offsets[xmpNo] = off; off += parts.slice(-3).reduce((n, b) => n + b.length, 0);
  add(root, catalog.replace(/>>\s*$/, `/Metadata ${xmpNo} 0 R >>`));
  const xrefPos = off;
  const row = (o) => `${String(o).padStart(10, '0')} 00000 n \n`;
  const nums = Object.keys(offsets).map(Number).sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length;) { // contiguous subsections
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n` + nums.slice(i, j + 1).map((n) => row(offsets[n])).join('');
    i = j + 1;
  }
  xref += `trailer\n<< /Size ${size + 2} /Root ${root} 0 R /Info ${infoNo} 0 R /Prev ${prev} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  wr('revised.pdf', cat(orig, ...parts, xref));
}

// ---------------------------------------------------------------- 7. corrupt.jpg (truncated mid-scan)
{
  const full = rd('photo.jpg');
  wr('corrupt.jpg', full.subarray(0, Math.floor(full.length * 0.6)));
}

// ---------------------------------------------------------------- 8. anim.gif (unsupported format, still carries a comment)
{
  const frame = (delay) => cat(Buffer.from([0x21, 0xf9, 4, 0]), u16(delay, true), Buffer.from([0, 0]), Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]));
  const comment = Buffer.from('Fixture GIF secret comment', 'latin1');
  wr('anim.gif', cat('GIF89a', Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xff, 11]), 'NETSCAPE2.0', Buffer.from([3, 1, 0, 0, 0]),
    Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0]),
    frame(10), frame(10), Buffer.from([0x3b])));
}

// ---------------------------------------------------------------- 9. gps-xyz.mp4 (Android-style ©xyz location atom in udta)
// AVAssetWriter's MP4 muxer writes 3GPP `loci` + `date` but not ©xyz, which Android cameras use. Add it byte-wise.
{
  const src = gpsMp4;
  const boxes = (buf, s, e) => {
    const out = [];
    for (let i = s; i + 8 <= e;) { let size = buf.readUInt32BE(i); if (size === 1) size = Number(buf.readBigUInt64BE(i + 8)); out.push({ type: buf.toString('latin1', i + 4, i + 8), start: i, size }); i += size; }
    return out;
  };
  const moov = boxes(src, 0, src.length).find((b) => b.type === 'moov');
  if (moov.start + moov.size !== src.length) throw new Error('moov is not the last box');
  const udta = boxes(src, moov.start + 8, moov.start + moov.size).find((b) => b.type === 'udta');
  const text = Buffer.from('+52.5200+013.4049+034.000/', 'latin1');
  const xyz = cat(u32(8 + 4 + text.length), Buffer.from([0xa9, 0x78, 0x79, 0x7a]), u16(text.length), u16(0x15c7), text);
  const head = Buffer.from(src.subarray(0, moov.start + 8 + (udta.start - moov.start - 8)));
  head.writeUInt32BE(moov.size + xyz.length, moov.start);
  const udtaBuf = cat(src.subarray(udta.start, udta.start + udta.size), xyz);
  udtaBuf.writeUInt32BE(udta.size + xyz.length, 0);
  wr('gps-xyz.mp4', cat(head.subarray(0, udta.start), udtaBuf, src.subarray(udta.start + udta.size)));
}

// ---------------------------------------------------------------- 10. flate-xmp.pdf (P3: Flate-compressed XMP, indirect /Length)
// doc.pdf + an incremental update whose catalog points to a FlateDecode XMP stream; its /Length is an indirect
// object written after the stream (a common writer pattern). Location (photoshop:City) sits only in the XMP.
{
  const orig = rd('doc.pdf');
  const text = orig.toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1]);
  const root = Number(/\/Root (\d+) 0 R/.exec(text)[1]);
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const catalog = new RegExp(`(?:^|\\n)${root} 0 obj\\s*(<<[\\s\\S]*?>>)\\s*endobj`).exec(text)[1];
  const infoNo = size, xmpNo = size + 1, lenNo = size + 2;
  const xmp = xmpPacket(
    dcCreator('Flate XMP Creator') + '<xmp:CreatorTool>FlateTool 4.2</xmp:CreatorTool><photoshop:City>Flate City</photoshop:City>' +
      '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Flate Secret Title</rdf:li></rdf:Alt></dc:title>',
    'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
  ).replace('<?xpacket end', ' '.repeat(1024) + '\n<?xpacket end'); // real writers pad XMP packets
  const z = deflateSync(Buffer.from(xmp, 'utf8'), { level: 6 });
  const parts = [];
  let off = orig.length;
  const offsets = {};
  const push = (no, bufs) => { offsets[no] = off; for (const b of bufs) { parts.push(b); off += b.length; } };
  push(infoNo, [Buffer.from(`${infoNo} 0 obj\n<< /Author (Flate Author) /Producer (FlateProducer 3.0) >>\nendobj\n`, 'latin1')]);
  push(xmpNo, [Buffer.from(`${xmpNo} 0 obj\n<< /Type /Metadata /Subtype /XML /Filter /FlateDecode /Length ${lenNo} 0 R >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  push(lenNo, [Buffer.from(`${lenNo} 0 obj\n${z.length}\nendobj\n`, 'latin1')]);
  push(root, [Buffer.from(`${root} 0 obj\n${catalog.replace(/>>\s*$/, `/Metadata ${xmpNo} 0 R >>`)}\nendobj\n`, 'latin1')]);
  const xrefPos = off;
  const row = (o) => `${String(o).padStart(10, '0')} 00000 n \n`;
  const nums = Object.keys(offsets).map(Number).sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length;) {
    let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n` + nums.slice(i, j + 1).map((n) => row(offsets[n])).join('');
    i = j + 1;
  }
  xref += `trailer\n<< /Size ${size + 3} /Root ${root} 0 R /Info ${infoNo} 0 R /Prev ${prev} >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  wr('flate-xmp.pdf', cat(orig, ...parts, xref));
}
