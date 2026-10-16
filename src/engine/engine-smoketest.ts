import { deflate, inflate } from 'pako';

import type { ByteFile } from './byte-file';
import { clean } from './clean';
import { inspect } from './inspect';
import { verify } from './verify';

export const ENGINE_SMOKETEST_OK = 'ENGINE OK';

/** A tiny JPEG with one EXIF tag (Make = "SafeShareCam"). Just enough for inspect, clean and verify. */
export function tinyExifJpeg(): Uint8Array {
  const make = 'SafeShareCam\0'; // 13 bytes
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD0 at 8
    0x01, 0x00, // one entry
    0x0f, 0x01, 0x02, 0x00, make.length, 0x00, 0x00, 0x00, 26, 0x00, 0x00, 0x00, // Make, ASCII, 13, at 26
    0x00, 0x00, 0x00, 0x00, // no next IFD
    ...[...make].map((c) => c.charCodeAt(0)),
  ];
  const app1 = [...'Exif\0\0'].map((c) => c.charCodeAt(0)).concat(tiff);
  const be16 = (n: number) => [n >> 8, n & 0xff];
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, ...be16(app1.length + 2), ...app1,
    0xff, 0xc0, ...be16(11), 8, 0, 1, 0, 1, 1, 1, 0x11, 0, // SOF0 1x1 grey
    0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0, // SOS
    0x00, // one byte of scan data
    0xff, 0xd9,
  ]);
}

/**
 * Dev-only check (P1b): the engine bundle loads and runs in the JS engine of the device (Hermes):
 * pako round trip, then inspect, clean and verify a tiny JPEG through the given ByteFile factory.
 * `open(initial)` must return a writable ByteFile over a fresh file holding exactly `initial`.
 * Returns "ENGINE OK" or "ENGINE FAIL: <reason>"; never throws.
 */
export function runEngineSmokeTest(open: (initial: Uint8Array) => ByteFile): string {
  const opened: ByteFile[] = [];
  const track = (bytes: Uint8Array) => {
    const f = open(bytes);
    opened.push(f);
    return f;
  };
  try {
    const text = Uint8Array.from({ length: 500 }, (_, i) => i % 7);
    const round = inflate(deflate(text));
    if (round.length !== text.length || round.some((b, i) => b !== text[i])) return 'ENGINE FAIL: pako round trip';

    const src = track(tinyExifJpeg());
    const before = inspect(src);
    if (before.format !== 'jpeg') return `ENGINE FAIL: format ${before.format}`;
    if (!before.fields.some((f) => f.id.startsWith('exif:'))) return 'ENGINE FAIL: inspect found no EXIF field';
    const dst = track(new Uint8Array(0));
    clean(src, dst, 'all');
    const verdict = verify({ src, dst, before, profile: 'all' });
    if (verdict.status !== 'clean') return `ENGINE FAIL: verdict ${verdict.status} ${verdict.survivors.map((s) => s.id).join(',')}`;
    return ENGINE_SMOKETEST_OK;
  } catch (e) {
    return `ENGINE FAIL: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    for (const f of opened) {
      try {
        f.close();
      } catch {
        // ignore close errors in a diagnostic
      }
    }
  }
}
