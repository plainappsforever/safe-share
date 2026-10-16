// Speed baseline input (P3, A11 preparation): a ≥ 1 GB MP4 with a real moov (from test/fixtures/gps.mov:
// QuickTime keys incl. location, two tracks) placed BEFORE a large mdat with a 64-bit size header ("fast start").
// The real audio/video samples sit at the start of mdat (chunk offsets rewritten), the rest is filler.
// Never committed: write it to a scratch folder and delete it after the run.
// Usage: node scripts/fixtures/make-big-mp4.mjs <out.mp4> [sizeMiB=1100]
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('Usage: make-big-mp4.mjs <out.mp4> [sizeMiB]');
  process.exit(2);
}
const target = Number(process.argv[3] ?? 1100) * 1024 * 1024;
const src = readFileSync(resolve('test/fixtures/gps.mov'));

const boxes = (b, s, e) => {
  const list = [];
  for (let i = s; i + 8 <= e; ) {
    let size = b.readUInt32BE(i);
    let header = 8;
    if (size === 1) {
      size = Number(b.readBigUInt64BE(i + 8));
      header = 16;
    }
    list.push({ type: b.toString('latin1', i + 4, i + 8), start: i, size, header });
    i += size;
  }
  return list;
};
const top = boxes(src, 0, src.length);
const ftyp = top.find((b) => b.type === 'ftyp');
const mdat = top.find((b) => b.type === 'mdat');
const moovBox = top.find((b) => b.type === 'moov');
const moov = Buffer.from(src.subarray(moovBox.start, moovBox.start + moovBox.size));
const media = src.subarray(mdat.start + mdat.header, mdat.start + mdat.size);
const oldStart = mdat.start + mdat.header;
const newStart = ftyp.size + moov.length + 16;
const delta = newStart - oldStart;

// Rewrite every stco entry (the fixture uses 32-bit offsets) inside moov.
let patched = 0;
const walk = (s, e) => {
  for (const b of boxes(moov, s, e)) {
    if (['trak', 'mdia', 'minf', 'stbl'].includes(b.type)) walk(b.start + b.header, b.start + b.size);
    if (b.type === 'stco') {
      const n = moov.readUInt32BE(b.start + 12);
      for (let k = 0; k < n; k++) {
        const at = b.start + 16 + k * 4;
        moov.writeUInt32BE(moov.readUInt32BE(at) + delta, at);
        patched++;
      }
    }
  }
};
walk(8, moov.length);

const fd = openSync(out, 'w');
let pos = 0;
const put = (b) => {
  writeSync(fd, b, 0, b.length, pos);
  pos += b.length;
};
put(src.subarray(ftyp.start, ftyp.start + ftyp.size));
put(moov);
const total = Math.max(target - pos, media.length + 16);
const head = Buffer.alloc(16);
head.writeUInt32BE(1, 0);
head.write('mdat', 4, 'latin1');
head.writeBigUInt64BE(BigInt(total), 8);
put(head);
put(media);
// Deterministic filler (xorshift) so the lossless compare really reads different bytes everywhere.
const block = Buffer.alloc(8 * 1024 * 1024);
let x = 0x9e3779b9;
for (let i = 0; i < block.length; i += 4) {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  block.writeUInt32LE(x >>> 0, i);
}
let left = total - 16 - media.length;
while (left > 0) {
  const n = Math.min(block.length, left);
  put(n === block.length ? block : block.subarray(0, n));
  left -= n;
}
closeSync(fd);
console.log(`wrote ${out}: ${(pos / 1024 / 1024).toFixed(0)} MiB, ${patched} chunk offsets moved by ${delta}`);
