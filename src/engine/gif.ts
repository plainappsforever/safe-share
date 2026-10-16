/**
 * GIF (V1.5-1, X2; rebuilt from parsed fields in the V1.5-1 fix round, review M4/S4/S6). The header, screen descriptor, colour
 * tables and every frame (image descriptor, local colour table, LZW data) are copied byte for byte. Every other block is
 * REBUILT from what was parsed, never copied whole:
 *  - frame timing (graphic control): exactly `21 F9 04 <4 bytes> 00`; any extra sub-block is hidden data (listed, removed);
 *  - loop/buffering (NETSCAPE2.0, ANIMEXTS1.0): only sub-block 1 (loop count) and 2 (buffer size); anything else is removed;
 *  - plain-text blocks (text drawn on the picture; browsers do not draw it, so in practice it is hidden text): listed as a
 *    hidden extra and removed by every profile;
 *  - comments, XMP (with its 257-byte magic trailer), ImageMagick IPTC (per dataset) and 8BIM blocks follow the profile;
 *  - an ICC block is kept as colour only when it is a real ICC profile (review S4);
 *  - unknown application/extension blocks and anything after the trailer are always removed.
 */
import { ascii, asciiBytes, concat, utf8, utf8Bytes, textRuns } from './binary';
import { MAX_READ_BYTES, type ByteFile } from './byte-file';
import { makeField, type Field } from './catalog';
import { iccField } from './icc';
import type { Container, FormatReport } from './inspect';
import { outside, SeqWriter, type Range } from './io';
import { iptcFields, irbFields, parseIptc, parseIrb, PHOTOSHOP_ID, rebuildIrb, writeIptc, type IptcDataset, type IrbBlock } from './iptc';
import { CorruptError } from './jpeg';
import { parseXmp, rebuildXmp, xmpFields, type XmpProp } from './xmp';

type BlockKind = 'head' | 'image' | 'timing' | 'loop' | 'comment' | 'xmp' | 'icc' | 'iptc' | 'irb' | 'hidden';

interface Block {
  kind: BlockKind;
  offset: number;
  length: number;
  fields: Field[];
  props?: XmpProp[];
  /** timing: the 4 parsed bytes; loop: the application id; comment/icc: the payload. */
  data?: Uint8Array | null;
  id?: string;
  /** loop: the kept sub-blocks (loop count, buffer size). */
  subs?: Uint8Array[];
  ds?: IptcDataset[];
  irb?: IrbBlock[];
}

export interface GifModel {
  blocks: Block[];
  /** Offset of the 0x3B trailer. */
  trailerAt: number;
  report: FormatReport;
}

const XMP_ID = 'XMP DataXMP';
const LOOP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);
/** Metadata blocks larger than this are not decoded (display only; they are still removed). */
const MAX_META = 4 * 1024 * 1024;

/** Data sub-blocks (≤ 255 bytes each) and the terminator. */
function subBlocks(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const c = data.subarray(i, Math.min(data.length, i + 255));
    parts.push(Uint8Array.from([c.length]), c);
  }
  parts.push(Uint8Array.from([0]));
  return concat(parts);
}

const hiddenField = (where: string, data: Uint8Array) =>
  makeField('gif', `HiddenData:${where}`, { name: `Hidden data in a ${where} block`, group: 'other', sensitivity: 'medium', known: false }, `${data.length} bytes`, textRuns(data, 4));

/** Buffered forward reader over a ByteFile (GIF data comes in sub-blocks of at most 255 bytes). */
class Cursor {
  private buf: Uint8Array = new Uint8Array(0);
  private bufAt = 0;
  constructor(private f: ByteFile, public pos: number) {}
  byte(): number {
    if (this.pos < this.bufAt || this.pos >= this.bufAt + this.buf.length) {
      this.bufAt = this.pos;
      this.buf = this.f.read(this.pos, Math.min(MAX_READ_BYTES, 256 * 1024));
      if (this.buf.length === 0) throw new CorruptError('GIF ends early');
    }
    return this.buf[this.pos++ - this.bufAt];
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.byte();
    return out;
  }
  skip(n: number): void {
    if (this.pos + n > this.f.size) throw new CorruptError('GIF ends early');
    this.pos += n;
  }
  /** Reads data sub-blocks up to the terminator as a list (each ≤ 255 bytes; null when larger than MAX_META in total). */
  subList(): Uint8Array[] | null {
    const out: Uint8Array[] = [];
    let total = 0;
    let ok = true;
    for (;;) {
      const n = this.byte();
      if (n === 0) break;
      total += n;
      if (ok && total <= MAX_META) out.push(this.bytes(n));
      else {
        ok = false;
        this.skip(n);
      }
    }
    return ok ? out : null;
  }
  /** Skips data sub-blocks up to and including the zero terminator; returns their payload when `collect` (bounded). */
  subBlocks(collect = false): Uint8Array | null {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const n = this.byte();
      if (n === 0) break;
      if (collect && total + n <= MAX_META) {
        parts.push(this.bytes(n));
        total += n;
      } else {
        if (collect) collect = false;
        this.skip(n);
      }
    }
    return collect ? concat(parts) : null;
  }
}

const MAGIC_TRAILER = (() => {
  const b = new Uint8Array(257);
  b[0] = 1;
  for (let i = 0; i < 256; i++) b[1 + i] = 255 - i;
  return b;
})();

export function inspectGif(f: ByteFile): GifModel {
  const h = f.read(0, 13);
  if (h.length < 13 || !/^GIF8[79]a$/.test(ascii(h, 0, 6))) throw new CorruptError('not a GIF');
  const width = h[6] | (h[7] << 8);
  const height = h[8] | (h[9] << 8);
  const gct = h[10] & 0x80 ? 3 * (1 << ((h[10] & 7) + 1)) : 0;
  const headEnd = 13 + gct;
  if (headEnd > f.size) throw new CorruptError('GIF ends early');
  const blocks: Block[] = [{ kind: 'head', offset: 0, length: headEnd, fields: [] }];
  const c = new Cursor(f, headEnd);
  const containers: Container[] = [];
  const opaque: string[] = [];
  let frames = 0;
  let trailerAt = -1;
  while (trailerAt < 0) {
    const at = c.pos;
    const kind = c.byte();
    if (kind === 0x3b) {
      trailerAt = at;
      break;
    }
    if (kind === 0x2c) {
      const d = c.bytes(9);
      if (d[8] & 0x80) c.skip(3 * (1 << ((d[8] & 7) + 1)));
      c.skip(1); // LZW minimum code size
      c.subBlocks();
      frames++;
      blocks.push({ kind: 'image', offset: at, length: c.pos - at, fields: [] });
      continue;
    }
    if (kind !== 0x21) throw new CorruptError(`unknown GIF block 0x${kind.toString(16)} at ${at}`);
    const label = c.byte();
    const push = (k: BlockKind, fields: Field[] = [], extra: Partial<Block> = {}) => blocks.push({ kind: k, offset: at, length: c.pos - at, fields, ...extra });
    if (label === 0xf9) {
      // Frame timing: one 4-byte sub-block. Anything more is hidden data; a shorter block cannot be rebuilt and is removed.
      const subs = c.subList();
      const first = subs?.[0];
      const extra = subs ? concat(subs.slice(first?.length === 4 ? 1 : 0)) : null;
      const fields = extra === null ? [hiddenField('frame-timing', new Uint8Array(0))] : extra.length ? [hiddenField('frame-timing', extra)] : [];
      push('timing', fields, { data: first?.length === 4 ? first : null });
    } else if (label === 0x01) {
      // Plain text drawn on the picture (GIF89a §25). Browsers do not draw it; it is removed by every profile (review M4).
      const subs = c.subList();
      const text = subs ? ascii(concat(subs.slice(1))).replace(/\0+$/, '').trim() : '(too long to show)';
      push('hidden', [makeField('gif', 'PlainText', { name: 'Hidden text block (not shown by browsers)', group: 'extras', sensitivity: 'high', known: true }, text, text.length >= 3 && subs ? [text] : [])]);
    } else if (label === 0xfe) {
      const data = c.subBlocks(true);
      const text = data ? ascii(data).replace(/\0+$/, '').trim() : null;
      push('comment', [makeField('gif', 'Comment', { name: 'Comment', group: 'people', sensitivity: 'high', known: true }, text ?? '(too long to show)', text && text.length >= 3 ? [text] : [])], { data });
    } else if (label === 0xff) {
      const len = c.byte();
      const id = ascii(c.bytes(len));
      if (id === XMP_ID) {
        // XMP: raw packet bytes, then the 257-byte magic trailer and the terminator; walking it as sub-blocks lands on the end.
        const start = c.pos;
        c.subBlocks();
        const end = c.pos - 1; // before the terminator
        const n = end - start;
        const raw = n <= MAX_META ? f.read(start, n) : null;
        const tail = raw && n >= 257 ? raw.subarray(n - 257) : null;
        const ok = !!tail && tail.every((b, i) => b === MAGIC_TRAILER[i]);
        const x = raw && ok ? parseXmp(utf8(raw.subarray(0, n - 257))) : null;
        if (raw && ok) containers.push({ kind: 'xmp', offset: start, length: n - 257 });
        if (x?.ok) push('xmp', xmpFields(x), { props: x.props });
        else push('xmp', [makeField('xmp', 'Unreadable', { name: 'Unreadable XMP block', group: 'other', sensitivity: 'medium', known: false }, `${n} bytes`)], { props: [] });
      } else if (LOOP_APPS.has(id)) {
        // Loop count (sub-block id 1, 3 bytes) and buffer size (id 2, 5 bytes); every other sub-block is hidden data (M4).
        const list = c.subList();
        const keepSubs = (list ?? []).filter((b) => (b[0] === 1 && b.length === 3) || (b[0] === 2 && b.length === 5));
        const rest = list ? list.filter((b) => !keepSubs.includes(b)) : null;
        const fields = rest === null ? [hiddenField('loop', new Uint8Array(0))] : rest.length ? [hiddenField('loop', concat(rest))] : [];
        push('loop', fields, { id, subs: keepSubs.slice(0, 2) });
      } else if (id === 'ICCRGBG1012') {
        const data = c.subBlocks(true);
        push('icc', [data ? iccField(data) : makeField('icc', 'Invalid', { name: 'Block that claims to be a colour profile', group: 'other', sensitivity: 'medium', known: false }, 'too large')], { data });
      } else if (id === 'MGKIPTC0000') {
        const data = c.subBlocks(true);
        const ds = data ? parseIptc(data) : [];
        push('iptc', ds.length ? iptcFields(ds) : [makeField('gif', `App:${id}`, { name: 'IPTC block', group: 'other', sensitivity: 'medium', known: false }, 'unreadable')], { ds });
      } else if (id === 'MGK8BIM0000') {
        const data = c.subBlocks(true);
        const irb = data ? parseIrb(data) : [];
        const fields = irb.length ? irbFields(irb) : [];
        push('irb', fields.length ? fields : [makeField('gif', `App:${id}`, { name: 'IPTC block', group: 'other', sensitivity: 'medium', known: false }, 'unreadable')], { irb });
      } else {
        const data = c.subBlocks(true);
        push('hidden', [makeField('gif', `App:${id.replace(/[^\x20-\x7e]/g, '?')}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, data ? `${data.length} bytes` : 'large')]);
      }
    } else {
      c.subBlocks();
      push('hidden', [makeField('gif', `Extension:0x${label.toString(16)}`, { name: 'Other embedded data', group: 'other', sensitivity: 'medium', known: false }, 'present')]);
    }
  }
  if (frames === 0) throw new CorruptError('GIF has no picture');
  const fields = blocks.flatMap((b) => b.fields);
  const end = trailerAt + 1;
  if (end < f.size) {
    fields.push(makeField('trailer', 'Data', { name: 'Data after the end of the picture', group: 'extras', sensitivity: 'medium', known: true }, `${f.size - end} bytes`));
    containers.push({ kind: 'trailer', offset: end, length: f.size - end });
  }
  const dataRanges: Range[] = blocks.filter((b) => b.kind === 'head' || b.kind === 'image').map((b) => ({ offset: b.offset, length: b.length }));
  return {
    blocks,
    trailerAt,
    report: { fields, containers, dataRanges, scanRanges: outside(f.size, dataRanges), width, height, notes: frames > 1 ? [`${frames} frames`] : [], opaque },
  };
}

export function cleanGif(src: ByteFile, model: GifModel, dst: ByteFile, keep: (f: Field) => boolean): { kept: Field[]; notes: string[] } {
  const w = new SeqWriter(dst);
  const kept: Field[] = [];
  const app = (id: string, payload: Uint8Array) => concat([Uint8Array.from([0x21, 0xff, id.length]), asciiBytes(id), payload]);
  for (const b of model.blocks) {
    switch (b.kind) {
      case 'head':
      case 'image':
        w.copy(src, b.offset, b.length);
        break;
      case 'timing':
        if (b.data) w.write(concat([Uint8Array.from([0x21, 0xf9, 4]), b.data, Uint8Array.from([0])]));
        break;
      case 'loop':
        if (b.subs?.length) w.write(app(b.id!, concat([...b.subs.flatMap((x) => [Uint8Array.from([x.length]), x]), Uint8Array.from([0])])));
        break;
      case 'xmp': {
        const r = rebuildXmp(b.props ?? [], keep);
        if (r.packet) {
          w.write(concat([app(XMP_ID, utf8Bytes(r.packet)), MAGIC_TRAILER, Uint8Array.from([0])]));
          kept.push(...r.kept);
        }
        break;
      }
      case 'comment':
        if (b.fields.every((f) => keep(f))) {
          if (b.data) w.write(concat([Uint8Array.from([0x21, 0xfe]), subBlocks(b.data)]));
          else w.copy(src, b.offset, b.length);
          kept.push(...b.fields);
        }
        break;
      case 'icc':
        if (b.data && b.fields.every((f) => keep(f))) {
          w.write(app('ICCRGBG1012', subBlocks(b.data)));
          kept.push(...b.fields);
        }
        break;
      case 'iptc': {
        // Review S6: one IPTC dataset at a time ("Location only" keeps the author and drops the city).
        const ds: IptcDataset[] = [];
        const ks: Field[] = [];
        (b.ds ?? []).forEach((d, i) => {
          if (b.fields[i] && keep(b.fields[i])) {
            ds.push(d);
            ks.push(b.fields[i]);
          }
        });
        if (ks.some((f) => f.group !== 'technical')) {
          w.write(app('MGKIPTC0000', subBlocks(writeIptc(ds))));
          kept.push(...ks);
        }
        break;
      }
      case 'irb': {
        const r = rebuildIrb(b.irb ?? [], keep);
        if (r.bytes) {
          w.write(app('MGK8BIM0000', subBlocks(r.bytes.subarray(PHOTOSHOP_ID.length))));
          kept.push(...r.kept);
        }
        break;
      }
      case 'hidden':
        break;
    }
  }
  w.write(Uint8Array.from([0x3b]));
  return { kept, notes: [] };
}
