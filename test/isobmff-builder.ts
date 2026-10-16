// Test helper (P3): builds synthetic MP4 files from gps.mp4 for cases this Mac cannot record — a CAMM
// motion/GPS track with a 64-bit chunk-offset table (co64), a GoPro-style gpmd track with stco, a `meta`
// box inside a `trak`, and an XMP `uuid` box. Independent of the engine (own box code on Buffers).
export const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
export const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
const full = (type: string, version: number, ...payload: Buffer[]) => box(type, Buffer.from([version, 0, 0, 0]), ...payload);

export interface TopBox {
  type: string;
  start: number;
  size: number;
  header: number;
}

export function topBoxes(buf: Buffer, s = 0, e = buf.length): TopBox[] {
  const out: TopBox[] = [];
  for (let i = s; i + 8 <= e; ) {
    let size = buf.readUInt32BE(i);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    }
    out.push({ type: buf.toString('latin1', i + 4, i + 8), start: i, size, header });
    i += size;
  }
  return out;
}

export const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');

/** QuickTime-style (no version word) `meta` with mdta keys + ilst UTF-8 values. */
export function mdtaMeta(entries: [string, string][]): Buffer {
  const hdlr = full('hdlr', 0, u32(0), Buffer.from('mdta'), Buffer.alloc(12), Buffer.from([0]));
  // Each key entry is [size][namespace 'mdta'][name] — the same layout as a box.
  const keys = full('keys', 0, u32(entries.length), ...entries.map(([k]) => box('mdta', Buffer.from(k, 'latin1'))));
  const items = entries.map(([, v], i) => Buffer.concat([u32(8 + 16 + Buffer.byteLength(v)), u32(i + 1), box('data', u32(1), u32(0), Buffer.from(v, 'utf8'))]));
  return box('meta', hdlr, keys, box('ilst', ...items));
}

function metadataTrak(id: number, handler: string, entry: string, sizes: number[], chunks: { offset: number; count: number }[], use64: boolean): Buffer {
  const tkhd = full('tkhd', 0, u32(0xe0000000), u32(0xe0000000), u32(id), u32(0), u32(600), Buffer.alloc(8), Buffer.alloc(8), u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000), u32(0), u32(0));
  const mdhd = full('mdhd', 0, u32(0xe0000000), u32(0xe0000000), u32(600), u32(1200), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, u32(0), Buffer.from(handler), Buffer.alloc(12), Buffer.from('Telemetry\0'));
  const stsd = full('stsd', 0, u32(1), box(entry, Buffer.alloc(6), u16(1)));
  const stts = full('stts', 0, u32(1), u32(sizes.length), u32(600));
  const stsc = full('stsc', 0, u32(chunks.length), ...chunks.flatMap((c, i) => [u32(i + 1), u32(c.count), u32(1)]));
  const stsz = full('stsz', 0, u32(0), u32(sizes.length), ...sizes.map(u32));
  const offs = use64 ? full('co64', 0, u32(chunks.length), ...chunks.map((c) => u64(c.offset))) : full('stco', 0, u32(chunks.length), ...chunks.map((c) => u32(c.offset)));
  const stbl = box('stbl', stsd, stts, stsc, stsz, offs);
  const minf = box('minf', full('nmhd', 0), box('dinf', full('dref', 0, u32(1), box('url ', Buffer.from([0, 0, 0, 1])))), stbl);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}

/** CAMM type-5 sample: reserved u16, type u16, latitude/longitude/altitude doubles (little-endian). */
function cammSample(lat: number, lon: number, alt: number): Buffer {
  const b = Buffer.alloc(28);
  b.writeUInt16LE(0, 0);
  b.writeUInt16LE(5, 2);
  b.writeDoubleLE(lat, 4);
  b.writeDoubleLE(lon, 12);
  b.writeDoubleLE(alt, 20);
  return b;
}

/** Minimal GPMF KLV sample carrying a device name with a serial-like value (visible to a byte scan). */
function gpmfSample(i: number): Buffer {
  const klv = (key: string, type: string, size: number, repeat: number, data: Buffer) => {
    const pad = Buffer.alloc((4 - (data.length % 4)) % 4);
    return Buffer.concat([Buffer.from(key), Buffer.from(type), Buffer.from([size]), u16(repeat), data, pad]);
  };
  const name = Buffer.from(`GoFixture SN-GOPRO-77${i}`);
  const gps = Buffer.concat([u32(525200000), u32(134049000), u32(34000), u32(0), u32(0)]);
  const strm = klv('STRM', '\0', 1, 0, Buffer.concat([klv('GPS5', 'l', 20, 1, gps)]));
  strm.writeUInt16BE(strm.length - 8, 6);
  const devc = Buffer.concat([Buffer.from('DEVC'), Buffer.from([0, 1]), u16(0), klv('DVNM', 'c', 1, name.length, name), strm]);
  devc.writeUInt16BE(devc.length - 8, 6);
  return devc;
}

export interface SyntheticVideo {
  bytes: Buffer;
  /** Absolute ranges of the telemetry samples (must be zero after cleaning). */
  telemetry: { offset: number; length: number }[];
  /** Absolute range of the original mdat payload (must be byte-identical after cleaning). */
  mdat: { offset: number; length: number };
}

/**
 * gps.mp4 + (1) `meta` with location/make keys inside the video trak, (2) CAMM track (co64, 3 samples in
 * 2 chunks), (3) gpmd track (stco, 2 samples in 1 chunk), (4) top-level XMP uuid box, (5) a second mdat
 * at the end holding the telemetry samples. The first mdat (audio/video) keeps its offsets.
 */
export function buildTelemetryMp4(src: Buffer): SyntheticVideo {
  const top = topBoxes(src);
  const moov = top.find((b) => b.type === 'moov')!;
  const mdat = top.find((b) => b.type === 'mdat')!;
  if (moov.start + moov.size !== src.length) throw new Error('moov must be last');
  const kids = topBoxes(src, moov.start + 8, moov.start + moov.size);
  const trak1 = kids.find((k) => k.type === 'trak')!;
  const trakMeta = mdtaMeta([
    ['com.apple.quicktime.location.ISO6709', '+48.8584+002.2945+035.000/'],
    ['com.apple.quicktime.make', 'TrakCam'],
  ]);
  const trak1New = Buffer.concat([src.subarray(trak1.start, trak1.start + trak1.size), trakMeta]);
  trak1New.writeUInt32BE(trak1.size + trakMeta.length, 0);
  const camm = [cammSample(48.8584, 2.2945, 35), cammSample(48.8585, 2.2946, 36), cammSample(48.8586, 2.2947, 37)];
  const gpmd = [gpmfSample(1), gpmfSample(2)];
  const xmp = Buffer.from(
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" photoshop:City="Video City" xmp:CreatorTool="VideoTool 7.1">' +
      '<dc:creator><rdf:Seq><rdf:li>Video XMP Author</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>' +
      ' '.repeat(200) +
      '<?xpacket end="w"?>',
    'utf8',
  );
  const uuid = box('uuid', XMP_UUID, xmp);
  // Two passes: the telemetry tracks' offsets depend on the final moov size.
  const build = (base: number) => {
    const c1 = base + 8;
    const c2 = c1 + camm[0].length + camm[1].length;
    const g1 = c2 + camm[2].length;
    const trak3 = metadataTrak(3, 'camm', 'camm', camm.map((x) => x.length), [{ offset: c1, count: 2 }, { offset: c2, count: 1 }], true);
    const trak4 = metadataTrak(4, 'meta', 'gpmd', gpmd.map((x) => x.length), [{ offset: g1, count: 2 }], false);
    const moovBody = Buffer.concat([...kids.map((k) => (k === trak1 ? trak1New : src.subarray(k.start, k.start + k.size))), trak3, trak4]);
    const moovNew = box('moov', moovBody);
    return { moovNew, trak3, trak4 };
  };
  const first = build(0);
  const base = moov.start + first.moovNew.length + uuid.length;
  const { moovNew } = build(base);
  const payload = Buffer.concat([...camm, ...gpmd]);
  const mdat2 = box('mdat', payload);
  const bytes = Buffer.concat([src.subarray(0, moov.start), moovNew, uuid, mdat2]);
  const p = base + 8;
  return {
    bytes,
    telemetry: [
      { offset: p, length: camm[0].length * 3 },
      { offset: p + camm[0].length * 3, length: gpmd[0].length + gpmd[1].length },
    ],
    mdat: { offset: mdat.start + mdat.header, length: mdat.size - mdat.header },
  };
}

