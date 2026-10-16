/** @jest-environment node */
// [slow] Speed baseline (P3; A11 is measured on devices later). Runs only when BIG_MP4 points to a file made by
// `node scripts/fixtures/make-big-mp4.mjs <file>` (≥ 1 GB, kept out of the repo), e.g.
//   BIG_MP4=<scratch>/big.mp4 npx jest test/engine-speed.test.ts --runInBand
// Cleans it through the Node ByteFile twice — (a) engine copy (SeqWriter, 4 MB reads) and (b) native byte copy
// (copyFileSync, like File.copy on device) + in-place patch — verifies both, and prints time and peak RSS.
import { copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { MAX_READ_BYTES, type ByteFile } from '../src/engine/byte-file';
import { clean } from '../src/engine/clean';
import { verify } from '../src/engine/verify';

import { openNodeByteFile } from './node-byte-file';

const BIG = process.env.BIG_MP4;

/** Wraps a ByteFile and records the largest single read. */
function counting(f: ByteFile, stats: { maxRead: number; reads: number; bytes: number }): ByteFile {
  return {
    get size() {
      return f.size;
    },
    read(o, n) {
      stats.maxRead = Math.max(stats.maxRead, n);
      stats.reads++;
      stats.bytes += n;
      return f.read(o, n);
    },
    write: (o, b) => f.write(o, b),
    close: () => f.close(),
  };
}

const mb = (n: number) => Math.round(n / 1024 / 1024);

(BIG ? describe : describe.skip)('[slow] speed baseline on a ≥ 1 GB MP4', () => {
  it('cleans and verifies with bounded reads; prints time and peak memory', () => {
    const size = statSync(BIG!).size;
    expect(size).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
    const outA = `${BIG}.clean-a.mp4`;
    const outB = `${BIG}.clean-b.mp4`;
    const rssStart = process.memoryUsage().rss;
    const stats = { maxRead: 0, reads: 0, bytes: 0 };
    const res: Record<string, number | string> = { sizeMiB: mb(size) };
    try {
      // (a) engine copy path
      writeFileSync(outA, new Uint8Array(0));
      let src = counting(openNodeByteFile(BIG!), stats);
      let dst = counting(openNodeByteFile(outA, true), stats);
      let t = Date.now();
      const ra = clean(src, dst, 'all');
      res.a_cleanMs = Date.now() - t;
      t = Date.now();
      const va = verify({ src, dst, before: ra.before, profile: 'all' });
      res.a_verifyMs = Date.now() - t;
      res.a_status = va.status;
      src.close();
      dst.close();
      // (b) native copy + in-place patch
      t = Date.now();
      copyFileSync(BIG!, outB);
      res.b_copyMs = Date.now() - t;
      src = counting(openNodeByteFile(BIG!), stats);
      dst = counting(openNodeByteFile(outB, true), stats);
      t = Date.now();
      const rb = clean(src, dst, 'all', { dstIsCopy: true });
      res.b_patchMs = Date.now() - t;
      t = Date.now();
      const vb = verify({ src, dst, before: rb.before, profile: 'all' });
      res.b_verifyMs = Date.now() - t;
      res.b_status = vb.status;
      src.close();
      dst.close();
      res.removed = ra.removed.length;
      res.maxReadMiB = stats.maxRead / 1024 / 1024;
      res.rssStartMiB = mb(rssStart);
      res.rssEndMiB = mb(process.memoryUsage().rss);
      // maxRSS is in kilobytes (Node docs) and covers the whole process incl. Jest.
      res.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
      console.log(`SPEED ${JSON.stringify(res)}`);
      expect(va.status).toBe('clean');
      expect(vb.status).toBe('clean');
      expect(stats.maxRead).toBeLessThanOrEqual(MAX_READ_BYTES);
    } finally {
      rmSync(outA, { force: true });
      rmSync(outB, { force: true });
    }
  }, 900000);
});
