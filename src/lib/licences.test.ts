import { JS_LICENCES, NATIVE_LICENCES } from './licences.generated';
import pkg from '../../package.json';

describe('generated licence list (scripts/gen-licences.mjs)', () => {
  it('lists every direct dependency', () => {
    const names = new Set(JS_LICENCES.map((e) => e.name));
    for (const dep of Object.keys(pkg.dependencies)) expect({ dep, listed: names.has(dep) }).toEqual({ dep, listed: true });
  });

  it('every entry has a known licence, and none is copyleft-only', () => {
    for (const e of [...JS_LICENCES, ...NATIVE_LICENCES]) {
      expect({ name: e.name, licence: e.licence }).not.toEqual({ name: e.name, licence: 'UNKNOWN' });
      expect(e.licence).not.toMatch(/^(A?GPL|LGPL)/);
    }
  });

  it('names the native libraries the module adds', () => {
    expect(NATIVE_LICENCES.map((e) => e.name).join(' ')).toMatch(/metadata-extractor/);
  });

  it('dev tools are not listed (they are not in the app)', () => {
    const names = JS_LICENCES.map((e) => e.name);
    for (const dev of ['jest', 'typescript', 'eslint', 'exiftool-vendored.pl']) expect(names).not.toContain(dev);
  });
});
