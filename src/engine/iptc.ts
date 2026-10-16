/** Photoshop image resource blocks (JPEG APP13 "Photoshop 3.0") and the IPTC IIM records inside them. */
import { ascii, asciiBytes, concat, put16, put32, u16, u32, utf8 } from './binary';
import { describeIptc, makeField, type Field } from './catalog';

export const PHOTOSHOP_ID = 'Photoshop 3.0\0';

export interface IrbBlock {
  sig: string;
  id: number;
  /** Raw Pascal name field including its padding. */
  name: Uint8Array;
  data: Uint8Array;
}

export interface IptcDataset {
  record: number;
  dataset: number;
  data: Uint8Array;
}

export const IRB_IPTC = 0x0404;

export function parseIrb(b: Uint8Array): IrbBlock[] {
  const out: IrbBlock[] = [];
  let o = 0;
  while (o + 12 <= b.length) {
    const sig = ascii(b, o, 4);
    if (!['8BIM', 'MeSa', 'PHUT', 'AgHg', 'DCSR'].includes(sig)) break;
    const id = u16(b, o + 4);
    const nameLen = b[o + 6];
    const nameField = (nameLen + 2) & ~1; // length byte + chars, padded to even
    const sizeAt = o + 6 + nameField;
    if (sizeAt + 4 > b.length) break;
    const size = u32(b, sizeAt);
    const dataAt = sizeAt + 4;
    if (dataAt + size > b.length) break;
    out.push({ sig, id, name: b.slice(o + 6, o + 6 + nameField), data: b.slice(dataAt, dataAt + size) });
    o = dataAt + size + (size & 1);
  }
  return out;
}

export function writeIrb(blocks: IrbBlock[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const k of blocks) {
    const head = new Uint8Array(6);
    head.set(asciiBytes(k.sig), 0);
    put16(head, 4, k.id);
    const size = new Uint8Array(4);
    put32(size, 0, k.data.length);
    parts.push(head, k.name, size, k.data);
    if (k.data.length & 1) parts.push(new Uint8Array(1));
  }
  return concat(parts);
}

export function parseIptc(b: Uint8Array): IptcDataset[] {
  const out: IptcDataset[] = [];
  let o = 0;
  while (o + 5 <= b.length && b[o] === 0x1c) {
    const record = b[o + 1];
    const dataset = b[o + 2];
    let len = u16(b, o + 3);
    let at = o + 5;
    if (len & 0x8000) {
      const n = len & 0x7fff;
      if (n > 4 || at + n > b.length) break;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[at + i];
      at += n;
    }
    if (at + len > b.length) break;
    out.push({ record, dataset, data: b.slice(at, at + len) });
    o = at + len;
  }
  return out;
}

export function writeIptc(ds: IptcDataset[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const d of ds) {
    if (d.data.length < 0x8000) {
      const h = Uint8Array.from([0x1c, d.record, d.dataset, 0, 0]);
      put16(h, 3, d.data.length);
      parts.push(h, d.data);
    } else {
      const h = Uint8Array.from([0x1c, d.record, d.dataset, 0x80, 4, 0, 0, 0, 0]);
      put32(h, 5, d.data.length);
      parts.push(h, d.data);
    }
  }
  return concat(parts);
}

export function iptcFields(ds: IptcDataset[]): Field[] {
  const isUtf8 = ds.some((d) => d.record === 1 && d.dataset === 90 && ascii(d.data).includes('%G'));
  return ds.map((d) => {
    const desc = describeIptc(d.record, d.dataset);
    const text = isUtf8 ? utf8(d.data) : ascii(d.data);
    const printable = /^[^\0-\x08\x0e-\x1f]*$/.test(text);
    const value = printable ? text.trim() : `${d.data.length} bytes`;
    return makeField('iptc', desc.key, desc, value, printable && value.length >= 3 ? [value] : []);
  });
}

/** Photoshop resources other than IPTC, as fields (they are removed by every profile). */
export function irbFields(blocks: IrbBlock[]): Field[] {
  const out: Field[] = [];
  for (const k of blocks) {
    if (k.id === IRB_IPTC) out.push(...iptcFields(parseIptc(k.data)));
    else if (k.id === 0x0409 || k.id === 0x040c)
      out.push(makeField('iptc', 'PhotoshopThumbnail', { name: 'Hidden preview image', group: 'extras', sensitivity: 'medium', known: true }, `${k.data.length} bytes`));
    else if (k.id === 0x0425)
      out.push(makeField('iptc', 'IPTCDigest', { name: 'IPTC checksum', group: 'technical', sensitivity: 'none', known: true }, `${k.data.length} bytes`));
    else
      out.push(
        makeField('iptc', `Photoshop0x${k.id.toString(16).padStart(4, '0')}`, { name: 'Photoshop data', group: 'other', sensitivity: 'medium', known: false }, `${k.data.length} bytes`),
      );
  }
  return out;
}

/**
 * Rebuilds an APP13 payload with only the kept IPTC datasets (other Photoshop resources are always
 * removed). Null when nothing but technical datasets would remain.
 */
export function rebuildIrb(blocks: IrbBlock[], keep: (f: Field) => boolean): { bytes: Uint8Array | null; kept: Field[] } {
  const ds: IptcDataset[] = [];
  const kept: Field[] = [];
  for (const k of blocks) {
    if (k.id !== IRB_IPTC) continue;
    const list = parseIptc(k.data);
    const fields = iptcFields(list);
    list.forEach((d, i) => {
      if (keep(fields[i])) {
        ds.push(d);
        kept.push(fields[i]);
      }
    });
  }
  if (!kept.some((f) => f.group !== 'technical')) return { bytes: null, kept: [] };
  const block: IrbBlock = { sig: '8BIM', id: IRB_IPTC, name: new Uint8Array(2), data: writeIptc(ds) };
  return { bytes: concat([asciiBytes(PHOTOSHOP_ID), writeIrb([block])]), kept };
}
