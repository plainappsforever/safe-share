/** @jest-environment node */
// Proves the fixtures are real: ExifTool 13.59 (independent referee) FINDS every value the manifest
// promises in every input fixture, and a raw byte scan finds the strings ExifTool cannot see.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { exifDump, loadManifest, missingInInput, ROOT, survivors } from '../scripts/lib/referee';

const dir = join(ROOT, 'test', 'fixtures');
const manifest = loadManifest();
const names = Object.keys(manifest.files);
const dumps = exifDump(names.map((n) => join(dir, n)));

describe('fixture manifest', () => {
  it('lists exactly the fixture files on disk (every entry exists, every fixture has an entry)', () => {
    const onDisk = readdirSync(dir).filter((f) => f !== 'manifest.json' && !f.startsWith('.'));
    expect(onDisk.sort()).toEqual([...names].sort());
  });

  it('covers every format v1 supports (D21), the V1.5-1 formats, plus the unsupported cases', () => {
    const formats = new Set(Object.values(manifest.files).map((e) => e.format));
    for (const f of ['jpeg', 'png', 'webp', 'heic', 'avif', 'mp4', 'mov', 'pdf', 'gif', 'tiff', 'dng', 'raw', 'unknown']) expect(formats).toContain(f);
    expect(manifest.files['corrupt.jpg'].supported).toBe(false);
    // V1.5-1: GIF is supported now; audio stays declined and camera RAW is inspected only.
    expect(manifest.files['anim.gif'].supported).toBe(true);
    expect(manifest.files['voice.m4a'].supported).toBe(false);
    expect(manifest.files['camera.nef'].supported).toBe(false);
  });

  it('every entry with sensitive values names its location subset correctly', () => {
    for (const [name, entry] of Object.entries(manifest.files)) {
      for (const key of entry.location) expect({ name, key, listed: key in entry.sensitive }).toEqual({ name, key, listed: true });
    }
    expect(manifest.files['photo.jpg'].location.length).toBeGreaterThanOrEqual(5);
    expect(manifest.files['nometa.jpg'].sensitive).toEqual({});
  });
});

describe('ExifTool finds the manifest values in every input fixture', () => {
  it.each(names)('%s', (name) => {
    const entry = manifest.files[name];
    const path = join(dir, name);
    expect(existsSync(path)).toBe(true);
    const tags = dumps[path];
    expect(tags).toBeDefined();
    const missing = missingInInput(entry, tags, readFileSync(path));
    expect(missing).toEqual([]);
  });

  it('the referee sees something in every fixture that promises sensitive values', () => {
    for (const name of names) {
      const entry = manifest.files[name];
      const found = survivors(entry, dumps[join(dir, name)], readFileSync(join(dir, name)));
      expect({ name, count: found.length }).toEqual({ name, count: Object.keys(entry.sensitive).length + Object.keys(entry.cameraSettings).length + entry.rawStrings.length });
    }
  });
});

describe('the referee can fail', () => {
  it('reports missing values when a file has none, and no survivors in a metadata-free file', () => {
    const empty = dumps[join(dir, 'nometa.jpg')];
    const bytes = readFileSync(join(dir, 'nometa.jpg'));
    expect(missingInInput(manifest.files['photo.jpg'], empty, bytes).length).toBeGreaterThan(10);
    expect(survivors(manifest.files['photo.jpg'], empty, bytes)).toEqual([]);
    expect(survivors(manifest.files['revised.pdf'], empty, bytes)).toEqual([]);
  });

  it('scripts/check-outputs.mjs fails on a dirty file and passes on a clean one', () => {
    const { mkdtempSync, copyFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const tmp = mkdtempSync(join(tmpdir(), 'check-outputs-'));
    try {
      copyFileSync(join(dir, 'nometa.jpg'), join(tmp, 'nometa.jpg'));
      const script = join(ROOT, 'scripts', 'check-outputs.mjs');
      expect(spawnSync('node', [script, tmp], { encoding: 'utf8' }).status).toBe(0);
      copyFileSync(join(dir, 'photo.jpg'), join(tmp, 'photo.jpg'));
      const dirty = spawnSync('node', [script, tmp], { encoding: 'utf8' });
      expect(dirty.status).toBe(1);
      expect(dirty.stdout).toContain('FAIL photo.jpg still contains');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
