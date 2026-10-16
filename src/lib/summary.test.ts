/** @jest-environment node */
import { inspect } from '@/engine/inspect';
import { openNodeByteFile } from '../../test/node-byte-file';

import { batchAutoShare, batchShareItems, batchSummary, countOutcomes, declineMessage, groupFields, mimeFor, pdfFlags, uniqueNames } from './summary';
import { strings } from './strings';

const report = (n: string) => inspect(openNodeByteFile(`test/fixtures/${n}`));

describe('summary helpers', () => {
  it('groups fields in the order of SPEC F2', () => {
    const groups = groupFields(report('photo.jpg').fields).map((g) => g.label);
    expect(groups.indexOf('Location')).toBe(0);
    expect(groups.indexOf('Date & time')).toBeLessThan(groups.indexOf('Device'));
  });
  it('lists repeated names once with a count', () => {
    const f = report('photo.jpg').fields;
    const names = uniqueNames([...f, ...f]);
    expect(new Set(names.map((n) => n.name)).size).toBe(names.length);
    expect(names.every((n) => n.count >= 2)).toBe(true);
  });
  it('flags an incrementally saved PDF, and nothing for a single-version one', () => {
    expect(pdfFlags(report('revised.pdf')).revisions).toBe(true);
    expect(pdfFlags(report('doc.pdf')).revisions).toBe(false);
  });
  it('declines with plain messages', () => {
    expect(declineMessage('unsupported', 'Encrypted PDFs are not supported yet')).toBe(strings.result.declinedEncrypted);
    expect(declineMessage('unsupported', 'x')).toBe(strings.result.declinedUnsupported);
    expect(declineMessage('corrupt')).toBe(strings.result.declinedCorrupt);
    expect(declineMessage('failed')).toBe(strings.result.declinedFailed);
  });
  it('knows the share types', () => {
    expect(mimeFor('jpeg').mimeType).toBe('image/jpeg');
    expect(mimeFor('mov').UTI).toBe('com.apple.quicktime-movie');
    expect([mimeFor('tiff').mimeType, mimeFor('dng').mimeType, mimeFor('gif').mimeType]).toEqual(['image/tiff', 'image/x-adobe-dng', 'image/gif']);
  });

  it('batch summary leaves zero categories out (F6)', () => {
    const jobs = [
      ...Array.from({ length: 10 }, () => ({ state: 'done', outcome: { status: 'clean' } })),
      { state: 'done', outcome: { status: 'unsupported' } },
      { state: 'done', outcome: { status: 'corrupt' } },
    ];
    expect(batchSummary(countOutcomes(jobs))).toBe('10 verified clean · 1 not supported · 1 failed');
    expect(batchSummary(countOutcomes([{ state: 'done', outcome: { status: 'dirty' } }, { state: 'ready' }]))).toBe('1 not fully clean · 1 not cleaned');
  });
});

describe('batch share (F6, P6)', () => {
  const job = (status: string, format = 'jpeg', outputPath: string | undefined = `/w/${status}-${format}`) => ({
    state: 'done', outcome: { status, outputPath, result: { before: { format } } },
  });
  it('shares only verified clean copies, with their MIME types', () => {
    expect(batchShareItems([job('clean'), job('dirty'), job('clean', 'mov'), job('unverified'), job('unsupported', 'gif', undefined)])).toEqual([
      { path: '/w/clean-jpeg', mimeType: 'image/jpeg' },
      { path: '/w/clean-mov', mimeType: 'video/quicktime' },
    ]);
  });
  it('"Clean all & share" opens the sheet by itself only when every file ended verified clean', () => {
    expect(batchAutoShare(countOutcomes([job('clean'), job('clean', 'mov')]))).toBe(true);
    expect(batchAutoShare(countOutcomes([job('clean'), job('dirty')]))).toBe(false);
    expect(batchAutoShare(countOutcomes([job('clean'), job('unsupported', 'gif', undefined)]))).toBe(false);
    expect(batchAutoShare(countOutcomes([job('clean'), { state: 'ready' }]))).toBe(false);
    expect(batchAutoShare(countOutcomes([]))).toBe(false);
  });
});
