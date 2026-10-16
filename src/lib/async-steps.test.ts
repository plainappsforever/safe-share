/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openNodeByteFile } from '../../test/node-byte-file';

import { rangesEqual, rangesEqualSteps, runToEnd } from '@/engine/io';

import { CancelledError, runInSlices } from './async-steps';

const fixture = (n: string) => join(process.cwd(), 'test/fixtures', n);

function* counting(n: number): Generator<{ done: number; total: number }, string, void> {
  for (let i = 1; i <= n; i++) yield { done: i, total: n };
  return 'finished';
}

describe('runInSlices', () => {
  it('returns the generator result and reports progress', async () => {
    const seen: number[] = [];
    const r = await runInSlices(counting(10), { sliceMs: 0, reportMs: 0, pause: async () => undefined, onProgress: (p) => seen.push(p.done) });
    expect(r.value).toBe('finished');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(10);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('hands the thread back between slices (a fake clock: every step costs 10 ms, slices are 25 ms)', async () => {
    let t = 0;
    let pauses = 0;
    const gen = (function* () {
      for (let i = 1; i <= 100; i++) {
        t += 10;
        yield { done: i, total: 100 };
      }
      return 7;
    })();
    const r = await runInSlices(gen, { sliceMs: 25, now: () => t, pause: async () => void pauses++ });
    expect(r.value).toBe(7);
    expect(pauses).toBeGreaterThanOrEqual(30);
    expect(r.longestSliceMs).toBeLessThanOrEqual(30); // never holds the thread for more than a slice plus one step
  });

  it('Cancel stops at the next step and never runs the rest', async () => {
    const cancel = { cancelled: false };
    let ran = 0;
    const gen = (function* () {
      for (let i = 1; i <= 1000; i++) {
        ran++;
        yield { done: i, total: 1000 };
      }
      return 'never';
    })();
    await expect(
      runInSlices(gen, {
        cancel,
        sliceMs: 0,
        pause: async () => {
          if (ran === 5) cancel.cancelled = true;
        },
      })
    ).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toBeLessThanOrEqual(6);
  });
});

describe('rangesEqualSteps is the same code as rangesEqual', () => {
  const big = readFileSync(fixture('photo.jpg'));
  it('agrees on equal and on different data, and progress reaches the total', () => {
    const a = openNodeByteFile(fixture('photo.jpg'));
    const b = openNodeByteFile(fixture('photo.jpg'));
    const ranges = [{ offset: 0, length: big.length }];
    expect(rangesEqual(a, ranges, b, ranges)).toBe(true);
    const steps = rangesEqualSteps(a, ranges, b, ranges);
    let last = { done: 0, total: 0 };
    let r = steps.next();
    while (!r.done) {
      last = r.value;
      r = steps.next();
    }
    expect(r.value).toBe(true);
    expect(last).toEqual({ done: big.length, total: big.length });
    const other = openNodeByteFile(fixture('photo.png'));
    expect(runToEnd(rangesEqualSteps(a, [{ offset: 0, length: 100 }], other, [{ offset: 0, length: 100 }]))).toBe(false);
    expect(rangesEqual(a, [{ offset: 0, length: 100 }], b, [{ offset: 0, length: 99 }])).toBe(false);
    a.close();
    b.close();
    other.close();
  });
});
