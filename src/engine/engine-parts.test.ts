/** @jest-environment node */
// Unit tests of the engine's building blocks (the fixture-level acceptance tests are in test/engine-images.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openNodeByteFile } from '../../test/node-byte-file';

import { ascii, crc32, utf8, utf8Bytes } from './binary';
import type { Field } from './catalog';
import { summarize } from './catalog';
import { inspect } from './inspect';
import { outside, rangesEqual } from './io';
import { CorruptError, parseJpeg } from './jpeg';
import { keepReason, profileFor } from './profiles';
import { sniff } from './sniff';
import { entryField, numberAt, parseTiff, TAG_ORIENTATION } from './tiff';
import { writeTiff } from './tiff-writer';
import { EMPTY_XMP, padPacket, parseXmp, serializeXmp } from './xmp';

const FIX = join(__dirname, '..', '..', 'test', 'fixtures');

describe('binary', () => {
  it('UTF-8 round trip incl. 4-byte characters; invalid bytes become U+FFFD', () => {
    const s = 'Zoë — 東京 🙂';
    expect(utf8(utf8Bytes(s))).toBe(s);
    expect(utf8(Uint8Array.from([0x41, 0xff, 0x42]))).toBe('A�B');
  });
  it('CRC-32 matches the PNG IEND constant', () => {
    expect(crc32([Uint8Array.from([0x49, 0x45, 0x4e, 0x44])])).toBe(0xae426082);
  });
});

describe('sniff (magic bytes only)', () => {
  it.each([
    ['photo.jpg', 'jpeg'], ['photo.png', 'png'], ['exif.webp', 'webp'], ['photo.heic', 'heic'],
    ['gps.mov', 'mov'], ['gps.mp4', 'mp4'], ['doc.pdf', 'pdf'], ['anim.gif', 'gif'], ['photo.avif', 'avif'],
  ])('%s -> %s', (name, format) => {
    const f = openNodeByteFile(join(FIX, name));
    expect(sniff(f)).toBe(format);
    f.close();
  });

  // N1 (P7.5): only video brands go down the video path.
  const ftyp = (major: string, ...compat: string[]) => {
    const body = Buffer.concat([Buffer.from(major, 'latin1'), Buffer.alloc(4), ...compat.map((c) => Buffer.from(c, 'latin1'))]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write('ftyp', 4, 'latin1');
    const b = new Uint8Array(Buffer.concat([head, body, Buffer.alloc(32)]));
    return { size: b.length, read: (o: number, n: number) => b.slice(o, o + n), write: () => {}, close: () => {} };
  };
  it.each([
    [['crx ', 'crx ', 'isom'], 'unknown'], [['M4A ', 'M4A ', 'mp42', 'isom'], 'unknown'], [['jp2 ', 'jp2 '], 'unknown'], [['abcd', 'abcd'], 'unknown'],
    [['isom', 'isom', 'avc1'], 'mp4'], [['mp42', 'mp41'], 'mp4'], [['3gp4', '3gp4'], 'mp4'], [['M4V ', 'M4V ', 'M4A '], 'mp4'], [['XAVC', 'XAVC'], 'mp4'],
  ])('ftyp %j -> %s', (brands, format) => {
    const [major, ...compat] = brands as string[];
    expect(sniff(ftyp(major, ...compat))).toBe(format);
  });
});

describe('TIFF parser and writer', () => {
  const exifOf = (name: string) => {
    const b = readFileSync(join(FIX, name));
    const at = b.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    return parseTiff(new Uint8Array(b.subarray(at + 6)))!;
  };

  it.each(['photo.jpg', 'extras.jpg'])('%s: rewriting all entries round-trips values (both byte orders)', (name) => {
    const t = exifOf(name);
    const plain = t.entries.filter((e) => e.ifd !== 'IFD1' && e.tag !== 0x927c);
    const again = parseTiff(writeTiff(t.endian, plain))!;
    expect(again.errors).toEqual([]);
    expect(again.endian).toBe(t.endian);
    const key = (e: (typeof plain)[number]) => `${e.ifd}:${e.tag}:${e.type}:${e.count}:${Buffer.from(e.raw).toString('hex')}`;
    expect(again.entries.map(key).sort()).toEqual(plain.map(key).sort());
  });

  it('extras.jpg is little-endian with a thumbnail and a MakerNote', () => {
    const t = exifOf('extras.jpg');
    expect(t.endian).toBe('LE');
    expect(t.thumbnail?.length).toBe(1293);
    expect(t.entries.some((e) => e.tag === 0x927c)).toBe(true);
  });

  it('an Orientation-only block is 26 bytes and reads back as 6', () => {
    const t = exifOf('photo.jpg');
    const o = t.entries.find((e) => e.ifd === 'IFD0' && e.tag === TAG_ORIENTATION)!;
    const b = writeTiff(t.endian, [o]);
    expect(b.length).toBe(8 + 2 + 12 + 4);
    const back = parseTiff(b)!;
    expect(numberAt(back.entries[0], back.endian, 0)).toBe(6);
  });

  it('survives hostile input: loops and out-of-range offsets are reported, not followed', () => {
    const b = new Uint8Array(32);
    b.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x87, 0x69, 0, 4, 0, 0, 0, 1, 0, 0, 0, 8, 0, 0, 0, 8]); // Exif pointer back to IFD0, next IFD = itself
    const t = parseTiff(b)!;
    expect(t.errors.length).toBeGreaterThan(0);
    expect(parseTiff(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it('catalogue: GPS entries are location/high, serials device/high', () => {
    const t = exifOf('photo.jpg');
    const f = t.entries.map((e) => entryField(e, t.endian));
    expect(f.find((x) => x.key === 'GPSLatitude')).toMatchObject({ group: 'location', sensitivity: 'high', known: true });
    expect(f.find((x) => x.key === 'SerialNumber')).toMatchObject({ group: 'device', sensitivity: 'high' });
    expect(f.find((x) => x.key === 'LensModel')).toMatchObject({ group: 'camera' });
  });
});

describe('XMP', () => {
  const sample = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:d="http://purl.org/dc/elements/1.1/" xmlns:e="http://ns.adobe.com/exif/1.0/" xmlns:q="http://example.test/q/"
       e:GPSLatitude="52,31.2N" q:Secret="a &amp; b">
      <d:creator><rdf:Seq><rdf:li>Jane &lt;J&gt;</rdf:li></rdf:Seq></d:creator>
      <d:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) Jane</rdf:li></rdf:Alt></d:rights>
      <e:Flash rdf:parseType="Resource"><e:Fired>False</e:Fired></e:Flash>
    </rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

  it('resolves namespaces to canonical prefixes, decodes entities, recognises arrays and structures', () => {
    const x = parseXmp(sample);
    expect(x.ok).toBe(true);
    const by = (k: string) => x.props.find((p) => `${p.prefix}:${p.local}` === k);
    expect(by('exif:GPSLatitude')).toMatchObject({ kind: 'simple', values: ['52,31.2N'] });
    expect(by('dc:creator')).toMatchObject({ kind: 'array', arrayType: 'Seq', values: ['Jane <J>'] });
    expect(by('dc:rights')).toMatchObject({ kind: 'array', arrayType: 'Alt', langs: ['x-default'] });
    expect(by('exif:Flash')).toMatchObject({ kind: 'struct', values: ['Fired=False'] });
    expect(by('q:Secret')?.values).toEqual(['a & b']);
  });

  it('serialises simple and array properties and reads them back; structures are dropped', () => {
    const x = parseXmp(sample);
    const back = parseXmp(serializeXmp(x.props));
    const keys = (p: typeof x.props) => p.filter((q) => q.kind !== 'struct').map((q) => `${q.prefix}:${q.local}=${q.values.join('|')}`).sort();
    expect(keys(back.props)).toEqual(keys(x.props));
    expect(back.props.some((p) => p.kind === 'struct')).toBe(false);
  });

  it('empty packet has no properties; padding keeps the exact size', () => {
    expect(parseXmp(EMPTY_XMP)).toEqual({ props: [], ok: true });
    const padded = padPacket(EMPTY_XMP, 400)!;
    expect(utf8Bytes(padded).length).toBe(400);
    expect(padPacket(EMPTY_XMP, 10)).toBeNull();
  });

  it('garbage is not XMP', () => {
    expect(parseXmp('hello <b>world').ok).toBe(false);
  });
});

describe('profiles', () => {
  const field = (id: string, group: Field['group'], value = 'x', known = true): Field => ({
    id, source: 'exif', key: id.split(':').pop()!, name: id, group, sensitivity: 'medium', known, value, needles: [],
  });
  it('Remove everything keeps only orientation ≠ 1 and the colour profile', () => {
    expect(keepReason(field('exif:Orientation', 'technical', '6'), 'all')).toBe('orientation');
    expect(keepReason(field('exif:Orientation', 'technical', '1'), 'all')).toBeNull();
    expect(keepReason(field('icc:ICC_Profile', 'technical'), 'all')).toBe('colour');
    expect(keepReason(field('exif:XResolution', 'technical'), 'all')).toBeNull();
  });
  it('Location only removes location, unknown fields and hidden extras; keeps the rest', () => {
    expect(keepReason(field('exif:GPSLatitude', 'location'), 'location')).toBeNull();
    expect(keepReason(field('exif:DateTimeOriginal', 'datetime'), 'location')).toBe('profile');
    expect(keepReason(field('exif:Make', 'device'), 'location')).toBe('profile');
    expect(keepReason(field('xmp:q:Secret', 'other', 'x', false), 'location')).toBeNull();
    expect(keepReason(field('exif:IFD1:ThumbnailImage', 'extras'), 'location')).toBeNull();
  });
  it('Keep camera settings keeps camera + technical only', () => {
    expect(keepReason(field('exif:FNumber', 'camera'), 'camera')).toBe('profile');
    expect(keepReason(field('exif:Model', 'device'), 'camera')).toBeNull();
    expect(keepReason(field('exif:DateTimeOriginal', 'datetime'), 'camera')).toBeNull();
  });
});

describe('findings and io helpers', () => {
  it('no sensitive field -> "No personal data found"', () => {
    expect(summarize([]).map((f) => f.label)).toEqual(['No personal data found']);
  });
  it('outside() complements holes; rangesEqual compares across different layouts', () => {
    expect(outside(10, [{ offset: 2, length: 3 }, { offset: 8, length: 5 }])).toEqual([{ offset: 0, length: 2 }, { offset: 5, length: 3 }]);
    const f = openNodeByteFile(join(FIX, 'photo.jpg'));
    expect(rangesEqual(f, [{ offset: 0, length: 4 }, { offset: 4, length: 6 }], f, [{ offset: 0, length: 10 }])).toBe(true);
    expect(rangesEqual(f, [{ offset: 0, length: 10 }], f, [{ offset: 1, length: 10 }])).toBe(false);
    expect(ascii(f.read(6, 4))).toBe('JFIF');
    f.close();
  });
});

describe('JPEG scan walker (synthetic layouts)', () => {
  const memFile = (bytes: number[]) => {
    const b = Uint8Array.from(bytes);
    return { size: b.length, read: (o: number, n: number) => b.slice(o, o + n), write() {}, close() {} };
  };
  const seg = (m: number, payload: number[]) => [0xff, m, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it('skips stuffed bytes and restart markers, keeps inter-scan tables, cuts APPn/COM between scans, finds the trailer', () => {
    const head = [0xff, 0xd8, ...seg(0xfe, text('hello')), ...seg(0xc0, [8, 0, 2, 0, 3, 1, 1, 0x11, 0])];
    const scan1 = [...seg(0xda, [1, 1, 0, 0, 63, 0]), 1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4, 0xff, 0xd7, 5];
    const between = seg(0xc4, [0, 1, 2]);
    const app = seg(0xe1, text('Exif\0\0junk'));
    const scan2 = [...seg(0xda, [1, 1, 0, 0, 63, 0]), 6, 7, 0xff, 0xff, 0xd9];
    const bytes = [...head, ...scan1, ...between, ...app, ...scan2, 0xde, 0xad];
    const l = parseJpeg(memFile(bytes));
    expect([l.width, l.height]).toEqual([3, 2]);
    const sos = head.length;
    const appAt = sos + scan1.length + between.length;
    expect(l.dataRanges).toEqual([
      { offset: sos, length: appAt - sos },
      { offset: appAt + app.length, length: scan2.length },
    ]);
    expect(l.inScan.map((s) => s.kind)).toEqual(['exif']);
    expect(l.eoiEnd).toBe(bytes.length - 2);
  });

  it('a JPEG without an end marker is corrupt', () => {
    const bytes = [0xff, 0xd8, ...seg(0xda, [1, 1, 0, 0, 63, 0]), 1, 2, 3];
    expect(() => parseJpeg(memFile(bytes))).toThrow(CorruptError);
  });
});

/** In-memory ByteFile for robustness cases. */
function mem(b: Uint8Array) {
  return { size: b.length, read: (o: number, n: number) => b.slice(o, Math.min(b.length, o + n)), write() {}, close() {} };
}

describe('video and PDF robustness: damaged or unsupported input is reported, never cleaned', () => {
  const fix = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));

  it('a truncated video is "corrupt"', () => {
    const b = fix('gps.mov');
    expect(inspect(mem(b.slice(0, b.length - 100)))).toMatchObject({ supported: false, problem: 'corrupt' });
  });

  it('a video without moov is "corrupt"', () => {
    const b = fix('gps.mov');
    const cut = b.slice(0, 24875); // ftyp + wide + mdat only
    expect(inspect(mem(cut))).toMatchObject({ supported: false, problem: 'corrupt' });
  });

  it('a PDF cut before its trailer is "corrupt"; an encrypted PDF is "not supported yet"', () => {
    const b = fix('doc.pdf');
    expect(inspect(mem(b.slice(0, 3000)))).toMatchObject({ supported: false, problem: 'corrupt' });
    const withEncrypt = ascii(b).replace(/trailer\s*<</, 'trailer\n<< /Encrypt 99 0 R ');
    const e2 = new Uint8Array(withEncrypt.length);
    for (let i = 0; i < withEncrypt.length; i++) e2[i] = withEncrypt.charCodeAt(i);
    expect(inspect(mem(e2))).toMatchObject({ supported: false, problem: 'unsupported', detail: 'Encrypted PDFs are not supported yet' });
  });

  it('video profile rule: "Keep camera settings" means "Remove everything" for video and PDF only', () => {
    const cam: Field = { id: 'qt:com.apple.quicktime.camera.lens_model', source: 'qt', key: 'com.apple.quicktime.camera.lens_model', name: 'Lens model', group: 'camera', sensitivity: 'low', known: true, value: 'x', needles: [] };
    expect(keepReason(cam, 'camera')).toBe('profile');
    expect(keepReason(cam, profileFor('mov', 'camera'))).toBeNull();
    expect(profileFor('jpeg', 'camera')).toBe('camera');
    expect(profileFor('pdf', 'location')).toBe('location');
  });
});
