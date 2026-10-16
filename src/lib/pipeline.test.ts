/** @jest-environment node */
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeFileIo } from '../../test/node-file-io';

import { honestyNotes } from '@/components/notes';

import { cleanFile, EMPTY_FILE, inspectFile, keptName, nameHasDate, neutralName, randomCode } from './pipeline';
import { strings } from './strings';
import { declineMessage } from './summary';

const fixture = (n: string) => join(process.cwd(), 'test/fixtures', n);
const out = () => mkdtempSync(join(tmpdir(), 'ss-p4-'));

describe('neutral names (D18)', () => {
  it('hides the original name and time stamps', () => {
    expect(neutralName('jpeg', 'IMG_20260930_142233.JPG', 'AB2C')).toBe('photo-AB2C.jpg');
    expect(neutralName('heic', 'IMG_1.HEIC', 'AB2C')).toBe('photo-AB2C.heic');
    expect(neutralName('mov', 'x.mov', 'AB2C')).toBe('video-AB2C.mov');
    expect(neutralName('mp4', 'x.m4v', 'AB2C')).toBe('video-AB2C.m4v');
    expect(neutralName('mp4', 'x.mp4', 'AB2C')).toBe('video-AB2C.mp4');
    expect(neutralName('pdf', 'Tax 2025.pdf', 'AB2C')).toBe('document-AB2C.pdf');
    // V1.5-1
    expect(neutralName('tiff', 'scan.TIF', 'AB2C')).toBe('photo-AB2C.tif');
    expect(neutralName('tiff', 'scan.tiff', 'AB2C')).toBe('photo-AB2C.tiff');
    expect(neutralName('dng', 'IMG_1.DNG', 'AB2C')).toBe('photo-AB2C.dng');
    expect(neutralName('gif', 'funny.gif', 'AB2C')).toBe('photo-AB2C.gif');
    expect(neutralName('mp4', 'VID_2025.3gp', 'AB2C')).toBe('video-AB2C.3gp');
  });
  it('codes are four unambiguous characters', () => {
    for (let i = 0; i < 50; i++) expect(randomCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });
});

describe('cleanFile on real fixtures', () => {
  it.each([
    ['photo.jpg', 'photo-TEST.jpg'],
    ['photo.png', 'photo-TEST.png'],
    ['exif.webp', 'photo-TEST.webp'],
    ['photo.heic', 'photo-TEST.heic'],
    ['photo.avif', 'photo-TEST.avif'],
    ['gps.mov', 'video-TEST.mov'],
    ['gps.mp4', 'video-TEST.mp4'],
    ['doc.pdf', 'document-TEST.pdf'],
    ['flate-xmp.pdf', 'document-TEST.pdf'],
  ])('%s is verified clean under a neutral name', async (name, outName) => {
    const dir = out();
    const o = await cleanFile(nodeFileIo, { inputPath: fixture(name), originalName: name, outDir: dir, profile: 'all', code: 'TEST' });
    expect(o.status).toBe('clean');
    expect(o.outputName).toBe(outName);
    expect(existsSync(join(dir, outName))).toBe(true);
    expect(o.verdict?.pictureUnchanged).toBe(true);
    expect(o.result!.removed.length).toBeGreaterThan(0);
  });

  it('never writes to the original', async () => {
    const before = readFileSync(fixture('photo.jpg'));
    await cleanFile(nodeFileIo, { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: out(), profile: 'all' });
    expect(readFileSync(fixture('photo.jpg')).equals(before)).toBe(true);
  });

  it('a PDF that was saved in several versions is reported honestly', () => {
    const { report } = inspectFile(nodeFileIo, fixture('revised.pdf'));
    expect(report.findings.some((f) => f.id === 'revisions')).toBe(true);
    expect(report.notes.join(' ')).toMatch(/earlier page content stays in the file/);
  });

  it('leaves nothing behind for unsupported, corrupt and unknown files', async () => {
    for (const [name, status] of [['voice.m4a', 'unsupported'], ['corrupt.jpg', 'corrupt']] as const) {
      const dir = out();
      const o = await cleanFile(nodeFileIo, { inputPath: fixture(name), originalName: name, outDir: dir, profile: 'all' });
      expect(o.status).toBe(status);
      expect(o.verdict).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('a missing file fails without throwing', async () => {
    const o = await cleanFile(nodeFileIo, { inputPath: '/nonexistent/x.jpg', originalName: 'x.jpg', outDir: out(), profile: 'all' });
    expect(o.status).toBe('failed');
    expect(o.message).toBeTruthy();
  });

  it('Location only keeps the date and model, and says so through kept fields', async () => {
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('photo.jpg'), originalName: 'photo.jpg', outDir: out(), profile: 'location', code: 'TEST' });
    expect(o.status).toBe('clean');
    expect(o.result!.kept.some((k) => k.field.id === 'exif:DateTimeOriginal')).toBe(true);
    expect(o.result!.removed.some((f) => f.group === 'location')).toBe(true);
  });

  it('a PDF with comment authors and attachments is NOT called clean: the survivors are named', async () => {
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('report.pdf'), originalName: 'report.pdf', outDir: out(), profile: 'all', code: 'TEST' });
    expect(o.status).toBe('dirty');
    const names = o.verdict!.survivors.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Comment author', 'Attached file']));
  });

  it('a password-protected PDF is declined with the encrypted message and leaves no copy', async () => {
    const dir = out();
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('encrypted.pdf'), originalName: 'encrypted.pdf', outDir: dir, profile: 'all' });
    expect(o.status).toBe('unsupported');
    expect(declineMessage(o.status as 'unsupported', o.message)).toBe(strings.result.declinedEncrypted);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a PDF saved in several versions is clean but keeps the earlier-content warning (honesty note)', async () => {
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('revised.pdf'), originalName: 'revised.pdf', outDir: out(), profile: 'all' });
    expect(o.status).toBe('clean');
    expect(honestyNotes(o.result!.before, 'all').join(' ')).toMatch(/pages that were changed or deleted in earlier versions can still be inside the file/);
  });

  it('partial profiles say what else they remove; "all" and PDFs do not need to', () => {
    const jpg = inspectFile(nodeFileIo, fixture('photo.jpg')).report;
    expect(honestyNotes(jpg, 'location').join(' ')).toMatch(/maker notes and HDR \/ Motion-Photo data/);
    expect(honestyNotes(jpg, 'camera').length).toBeGreaterThan(0);
    expect(honestyNotes(jpg, 'all')).toEqual([]);
    const mov = inspectFile(nodeFileIo, fixture('gps.mov')).report;
    expect(honestyNotes(mov, 'camera')).toEqual([]); // for video "Keep camera settings" = "Remove everything"
    expect(honestyNotes(inspectFile(nodeFileIo, fixture('ultrahdr.jpg')).report, 'all').join(' ')).toMatch(/HDR brightness data and the Motion-Photo video were removed/);
  });
});

describe('kept original names (Settings)', () => {
  it('keeps the name, fixes the extension, drops folders and odd characters', () => {
    expect(keptName('IMG_2041.JPEG', 'photo-AB2C.jpg')).toBe('IMG_2041.jpg');
    expect(keptName('Tax 2025.pdf', 'document-AB2C.pdf')).toBe('Tax 2025.pdf');
    expect(keptName('../../evil/name?.mov', 'video-AB2C.mov')).toBe('name.mov');
    expect(keptName('noext', 'photo-AB2C.png')).toBe('noext.png');
    expect(keptName('.jpg', 'photo-AB2C.jpg')).toBe('photo-AB2C.jpg');
    expect(keptName('', 'photo-AB2C.jpg')).toBe('photo-AB2C.jpg');
    expect(keptName('x'.repeat(300) + '.jpg', 'photo-AB2C.jpg').length).toBe(104);
  });

  it('N11: a kept name with a camera date is noticed; neutral names and plain numbers are not', () => {
    for (const n of ['IMG_20260930_142233.jpg', 'PXL_20250614_093015123.jpg', 'Screenshot 2026-09-30 at 14.22.33.png', 'VID-20240101-WA0001.mp4']) expect(nameHasDate(n)).toBe(true);
    for (const n of ['photo-AB2C.jpg', 'IMG_2041.jpg', 'Tax 2025.pdf', 'DSC01234.JPG']) expect(nameHasDate(n)).toBe(false);
  });

  it('cleanFile uses it only when asked', async () => {
    const dir = out();
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('photo.jpg'), originalName: 'IMG_0001.JPG', outDir: dir, profile: 'all', code: 'TEST', keepName: true });
    expect(o.status).toBe('clean');
    expect(o.outputName).toBe('IMG_0001.jpg');
    expect(existsSync(join(dir, 'IMG_0001.jpg'))).toBe(true);
  });
});

describe('cancel, progress and empty files (P7)', () => {
  it('reports copying, cleaning and checking with a growing fraction, and finishes verified clean', async () => {
    const stages: string[] = [];
    let lastChecking = -1;
    const o = await cleanFile(nodeFileIo, {
      inputPath: fixture('gps.mov'), originalName: 'gps.mov', outDir: out(), profile: 'all', code: 'TEST', slowMs: 1,
      onProgress: (p) => {
        if (stages[stages.length - 1] !== p.stage) stages.push(p.stage);
        if (p.stage === 'checking') {
          expect(p.fraction).toBeGreaterThanOrEqual(lastChecking);
          lastChecking = p.fraction;
        }
      },
    });
    expect(o.status).toBe('clean');
    expect(stages).toEqual(['copying', 'cleaning', 'checking']);
  });

  it('Cancel while checking leaves no copy behind and is not a failure', async () => {
    const dir = out();
    const cancel = { cancelled: false };
    const o = await cleanFile(nodeFileIo, {
      inputPath: fixture('gps.mp4'), originalName: 'gps.mp4', outDir: dir, profile: 'all', code: 'TEST', cancel, slowMs: 1,
      onProgress: (p) => {
        if (p.stage === 'checking') cancel.cancelled = true;
      },
    });
    expect(o.status).toBe('cancelled');
    expect(o.outputPath).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('Cancel before the copy stops before anything is written', async () => {
    const dir = out();
    const o = await cleanFile(nodeFileIo, { inputPath: fixture('gps.mov'), originalName: 'gps.mov', outDir: dir, profile: 'all', cancel: { cancelled: true } });
    expect(o.status).toBe('cancelled');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('an empty file is said plainly: nothing to clean, nothing created', async () => {
    const dir = out();
    const empty = join(dir, 'empty.jpg');
    writeFileSync(empty, new Uint8Array(0));
    const inspected = inspectFile(nodeFileIo, empty);
    expect(inspected.report.supported).toBe(false);
    expect(inspected.report.detail).toBe(EMPTY_FILE);
    expect(declineMessage('corrupt', EMPTY_FILE)).toBe(strings.result.declinedEmpty);
    const o = await cleanFile(nodeFileIo, { inputPath: empty, originalName: 'empty.jpg', outDir: join(dir, 'out'), profile: 'all' });
    expect(o.status).toBe('corrupt');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
});

describe('real inputs for "Could not verify" (P7 device fixture)', () => {
  it('hexstm.pdf ends as unverified with the reason named, and a copy exists to share anyway', async () => {
    const dir = out();
    const o = await cleanFile(nodeFileIo, { inputPath: join(process.cwd(), 'test/fixtures-device/hexstm.pdf'), originalName: 'hexstm.pdf', outDir: dir, profile: 'all', code: 'TEST' });
    expect(o.status).toBe('unverified');
    expect(o.verdict?.problems).toEqual(['Could not check: compressed object stream']);
    expect(existsSync(join(dir, 'document-TEST.pdf'))).toBe(true);
  });
});
