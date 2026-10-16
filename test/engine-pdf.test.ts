/** @jest-environment node */
// P3 acceptance for PDF (A1, A2, A3, A5): doc.pdf, revised.pdf (both revisions), flate-xmp.pdf and a synthetic
// PDF 1.5 with the Info dictionary inside a compressed object stream (test/pdf-builder.ts) are cleaned by the
// engine and judged by ExifTool 13.59 + the raw scan (first-revision values), by an independent same-length /
// changed-bytes check written here, and by the engine's own verify(). Outputs stay in
// artifacts/engine-out-pdf/<profile>/ for scripts/decode-check.swift (A4: page count unchanged).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { exifDump, loadManifest, lostKept, ROOT, survivors, valueEquals, type ManifestEntry, type Tags } from '../scripts/lib/referee';
import { clean, type CleanOptions } from '../src/engine/clean';
import { inspect } from '../src/engine/inspect';
import { PROFILES, type Profile } from '../src/engine/profiles';
import { verify } from '../src/engine/verify';

import { openNodeByteFile } from './node-byte-file';
import { buildObjStmPdf, buildReportPdf } from './pdf-builder';

const FIX = join(ROOT, 'test', 'fixtures');
const OUT = join(ROOT, 'artifacts', 'engine-out-pdf');
const IN = join(OUT, 'input');
const manifest = loadManifest();
const fixtures = Object.entries(manifest.files)
  // report.pdf (built in memory below, also committed as a P4 device fixture) and the declined encrypted.pdf are not engine-clean fixtures
  .filter(([n, e]) => e.format === 'pdf' && e.supported !== false && n !== 'report.pdf')
  .map(([n]) => n);
const OBJSTM = 'objstm.pdf';
const pdfs = [...fixtures, OBJSTM];
const synthetic = new Set([OBJSTM, 'hexstm.pdf', 'report.pdf']);
const inputOf = (n: string) => (synthetic.has(n) ? join(IN, n) : join(FIX, n));
const outPath = (p: Profile, n: string) => join(OUT, p, n);
const entries: Record<string, ManifestEntry> = {};

function cleanTo(name: string, profile: Profile, out: string, opts: CleanOptions = {}) {
  const src = openNodeByteFile(inputOf(name));
  writeFileSync(out, new Uint8Array(0));
  const dst = openNodeByteFile(out, true);
  try {
    const result = clean(src, dst, profile, opts);
    const verdict = verify({ src, dst, before: result.before, profile });
    return { result, verdict };
  } finally {
    src.close();
    dst.close();
  }
}

function verifyFile(name: string, file: string, profile: Profile) {
  const src = openNodeByteFile(inputOf(name));
  const dst = openNodeByteFile(file);
  try {
    return verify({ src, dst, before: inspect(src), profile });
  } finally {
    src.close();
    dst.close();
  }
}

type Run = ReturnType<typeof cleanTo>;
const runs: Record<Profile, Record<string, Run>> = { all: {}, location: {}, camera: {} };
let dumps: Record<string, Tags> = {};

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(IN, { recursive: true });
  writeFileSync(join(IN, OBJSTM), buildObjStmPdf());
  writeFileSync(join(IN, 'hexstm.pdf'), buildObjStmPdf({ hexObjStm: true }));
  writeFileSync(join(IN, 'report.pdf'), buildReportPdf(readFileSync(join(FIX, 'doc.pdf'))));
  for (const n of fixtures) entries[n] = manifest.files[n];
  entries[OBJSTM] = {
    format: 'pdf',
    supported: true,
    sensitive: { 'PDF:Author': 'ObjStm Author', 'PDF:Title': 'ObjStm Secret Title', 'PDF:Producer': 'ObjStmProducer 1.0', 'PDF:CreateDate': '2025:06:14 09:30:15+02:00' },
    location: [],
    cameraSettings: {},
    keep: { 'PDF:PageCount': 1 },
    rawStrings: [],
    lossless: 'pdf-blanked-ranges',
  };
  for (const p of PROFILES) {
    mkdirSync(join(OUT, p), { recursive: true });
    for (const n of pdfs) runs[p][n] = cleanTo(n, p, outPath(p, n));
  }
  dumps = exifDump([...PROFILES.flatMap((p) => pdfs.map((n) => outPath(p, n))), join(IN, OBJSTM)]);
});

const cases = PROFILES.flatMap((p) => pdfs.map((n) => [p, n] as [Profile, string]));

describe('synthetic input is real', () => {
  it('ExifTool reads the Info dictionary from the compressed object stream of objstm.pdf', () => {
    const t = dumps[join(IN, OBJSTM)];
    for (const [k, v] of Object.entries(entries[OBJSTM].sensitive)) expect({ k, v: t[k] }).toEqual({ k, v });
  });
});

describe('engine verdict', () => {
  it.each(cases)('%s / %s: verify() says clean, page content unchanged', (p, n) => {
    const { verdict } = runs[p][n];
    expect({ status: verdict.status, survivors: verdict.survivors, problems: verdict.problems }).toEqual({ status: 'clean', survivors: [], problems: [] });
    expect(verdict.pictureUnchanged).toBe(true);
  });
});

describe('A1 referee: "Remove everything" leaves no value of any revision, keeps the page count', () => {
  it.each(pdfs)('%s', (n) => {
    const file = outPath('all', n);
    const tags = dumps[file];
    expect(survivors(entries[n], tags, readFileSync(file))).toEqual([]);
    expect(lostKept(entries[n], tags)).toEqual([]);
  });

  it('revised.pdf: the first revision (only visible to a byte scan) is gone too', () => {
    const b = readFileSync(outPath('all', 'revised.pdf'));
    for (const s of ['Jane Fixture', 'Fixture Secret Report', 'Quartz PDFContext', 'Second Author', 'Revised XMP Creator']) expect(b.includes(Buffer.from(s))).toBe(false);
  });
});

describe('A3: "Location only" removes only location; PDFs without location stay byte-identical', () => {
  it('flate-xmp.pdf: the XMP city is gone, everything else stays (Flate stream re-deflated in place)', () => {
    const e = entries['flate-xmp.pdf'];
    const tags = dumps[outPath('location', 'flate-xmp.pdf')];
    expect(tags['XMP-photoshop:City']).toBeUndefined();
    for (const k of Object.keys(e.sensitive).filter((x) => !e.location.includes(x))) expect({ k, v: tags[k] }).toEqual({ k, v: e.sensitive[k] });
  });

  it.each(['doc.pdf', 'revised.pdf', OBJSTM])('%s: nothing to remove, output = input', (n) => {
    expect(readFileSync(outPath('location', n)).equals(readFileSync(inputOf(n)))).toBe(true);
  });

  it.each(pdfs)('%s: "Keep camera settings" = "Remove everything" for PDF (SPEC F3)', (n) => {
    expect(readFileSync(outPath('camera', n)).equals(readFileSync(outPath('all', n)))).toBe(true);
    const tags = dumps[outPath('camera', n)];
    expect(valueEquals(tags['PDF:PageCount'], 1)).toBe(true);
  });
});

// ---- A2: independent check (own regex walker, not the engine's parser) ----

interface Obj {
  start: number;
  end: number;
  body: string;
}
function objects(b: Buffer): Obj[] {
  const s = b.toString('latin1');
  const out: Obj[] = [];
  for (const m of s.matchAll(/(\d+) (\d+) obj([\s\S]*?)endobj/g)) out.push({ start: m.index!, end: m.index! + m[0].length, body: m[3] });
  return out;
}
/** Objects the cleaner may touch: Info dictionaries, strings/numbers they point to, XMP and object streams. */
const metadataObject = (o: Obj) => /\/Author|\/Producer|\/Creator|\/Type \/Metadata|\/Type \/ObjStm|^\s*\(|^\s*\d+\s*$/.test(o.body);

describe('A2 same length, only metadata objects differ, page content identical (independent check)', () => {
  it.each(cases)('%s / %s', (p, n) => {
    const src = readFileSync(inputOf(n));
    const dst = readFileSync(outPath(p, n));
    expect(dst.length).toBe(src.length);
    const allowed = objects(src).filter(metadataObject);
    // P7.5 (review S3): the trailer's document ID is rewritten as '0' digits, never anything else of the trailer.
    for (const m of src.toString('latin1').matchAll(/\/ID\s*\[[^\]]*\]/g)) allowed.push({ start: m.index!, end: m.index! + m[0].length } as (typeof allowed)[number]);
    let changed = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === dst[i]) continue;
      changed++;
      if (!allowed.some((o) => i >= o.start && i < o.end)) throw new Error(`byte ${i} changed outside the metadata objects`);
    }
    if (p !== 'location' || n === 'flate-xmp.pdf') expect(changed).toBeGreaterThan(0);
    // Every page content stream decodes to the same drawing commands.
    const contents = (b: Buffer) =>
      objects(b)
        .filter((o) => /\/Filter \/FlateDecode/.test(o.body) && !/\/Type \/(Metadata|ObjStm|XRef)/.test(o.body) && /stream\r?\n/.test(o.body))
        .map((o) => {
          const at = b.indexOf('stream', o.start) + 7;
          return inflateSync(b.subarray(at, b.indexOf('endstream', at)), { finishFlush: 2 }).toString('latin1');
        });
    expect(contents(dst)).toEqual(contents(src));
  });
});

describe('inspection (F2)', () => {
  const report = (n: string) => {
    const f = openNodeByteFile(inputOf(n));
    const r = inspect(f);
    f.close();
    return r;
  };

  it('findings name the document author and earlier versions; page count read', () => {
    expect(report('doc.pdf').findings.map((x) => x.label)).toEqual(expect.arrayContaining(['Document author', 'Date and time taken', 'Editing app']));
    const r = report('revised.pdf');
    expect(r.findings.map((x) => x.label)).toContain('Earlier versions of this PDF');
    expect(r.fields.find((x) => x.id === 'pdf:Earlier:Author')).toMatchObject({ name: 'Document author (earlier version)', value: 'Jane Fixture' });
    expect(r.fields.find((x) => x.id === 'pdf:Author')?.value).toBe('Second Author');
    expect(r.pages).toBe(1);
    expect(report('doc.pdf').fields.find((x) => x.id === 'pdf:Keywords')?.value).toBe('fixture, secret');
    expect(report('flate-xmp.pdf').fields.find((x) => x.id === 'xmp:photoshop:City')).toMatchObject({ group: 'location', value: 'Flate City' });
    expect(report(OBJSTM).fields.find((x) => x.id === 'pdf:Author')?.value).toBe('ObjStm Author');
  });

  it('annotation authors and attached files are reported (not removed); forms, JavaScript and signatures are noted', () => {
    const r = report('report.pdf');
    expect(r.fields.find((x) => x.id === 'pdf:AnnotationAuthor')).toMatchObject({ name: 'Comment author', value: 'Reviewer Fixture' });
    expect(r.fields.find((x) => x.id === 'pdf:EmbeddedFile')).toMatchObject({ name: 'Attached file', value: 'notes.txt' });
    expect(r.notes).toEqual(expect.arrayContaining(['Contains form fields (not changed)', 'Contains JavaScript (not changed)', 'Digitally signed: cleaning will invalidate the signature']));
    expect(r.findings.map((x) => x.label)).toContain('Digital signature (cleaning will invalidate it)');
  });

  it('the original is never written to (D18); a native copy cleaned in place gives the same bytes; cleaning again changes nothing', () => {
    for (const n of pdfs) {
      const before = readFileSync(inputOf(n));
      const file = join(OUT, `copy-${n}`);
      copyFileSync(inputOf(n), file);
      const src = openNodeByteFile(inputOf(n));
      const dst = openNodeByteFile(file, true);
      clean(src, dst, 'all', { dstIsCopy: true });
      src.close();
      dst.close();
      expect(readFileSync(inputOf(n)).equals(before)).toBe(true);
      expect(readFileSync(file).equals(readFileSync(outPath('all', n)))).toBe(true);
      const again = join(OUT, `again-${n}`);
      const s2 = openNodeByteFile(outPath('all', n));
      writeFileSync(again, new Uint8Array(0));
      const d2 = openNodeByteFile(again, true);
      clean(s2, d2, 'all');
      s2.close();
      d2.close();
      expect(readFileSync(again).equals(readFileSync(outPath('all', n)))).toBe(true);
      rmSync(file);
      rmSync(again);
    }
  });
});

// ---- A5: injected failures ----

describe('A5 verification honesty (injected failures)', () => {
  const inj = join(OUT, 'injected');
  beforeAll(() => mkdirSync(inj, { recursive: true }));
  const faulty = (name: string, profile: Profile, ids: string[]) => {
    const out = join(inj, `${ids[0].replace(/[^a-z0-9]/gi, '_')}-${name}`);
    return { ...cleanTo(name, profile, out, { faultyKeep: ids }), out };
  };

  it('a writer that leaves the PDF Author -> dirty "Document author" (and ExifTool agrees)', () => {
    const { verdict, out } = faulty('doc.pdf', 'all', ['pdf:Author']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'pdf:Author', name: 'Document author', reader: 'structure' }, { id: 'pdf:Author', name: 'Document author', reader: 'signature' }]));
    expect(exifDump([out])[out]['PDF:Author']).toBe('Jane Fixture');
  });

  it('a writer that leaves the author of the EARLIER revision -> dirty (ExifTool cannot see it; the byte scan can)', () => {
    const { verdict, out } = faulty('revised.pdf', 'all', ['pdf:Earlier:Author']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'pdf:Earlier:Author', name: 'Document author (earlier version)', reader: 'signature' }]));
    expect(exifDump([out])[out]['PDF:Author']).toBeUndefined();
    expect(readFileSync(out).includes(Buffer.from('Jane Fixture'))).toBe(true);
  });

  it('a writer that leaves the creator inside the Flate-compressed XMP -> dirty (structure + decoded-block scan)', () => {
    const { verdict, out } = faulty('flate-xmp.pdf', 'all', ['xmp:dc:creator']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'xmp:dc:creator', name: 'Creator / author', reader: 'structure' }, { id: 'xmp:dc:creator', name: 'Creator / author', reader: 'signature' }]));
    expect(exifDump([out])[out]['XMP-dc:Creator']).toBe('Flate XMP Creator');
  });

  it('a writer that leaves the Author inside the compressed object stream -> dirty', () => {
    const { verdict, out } = faulty(OBJSTM, 'all', ['pdf:Author']);
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors).toEqual(expect.arrayContaining([{ id: 'pdf:Author', name: 'Document author', reader: 'structure' }, { id: 'pdf:Author', name: 'Document author', reader: 'signature' }]));
    expect(exifDump([out])[out]['PDF:Author']).toBe('ObjStm Author');
  });

  it('an object stream the engine cannot decode -> "Could not verify", never clean', () => {
    const { verdict, result } = cleanTo('hexstm.pdf', 'all', join(inj, 'hexstm.pdf'));
    expect(verdict.status).toBe('unverified');
    expect(verdict.problems).toEqual(['Could not check: compressed object stream']);
    expect(result.before.findings.map((x) => x.label)).toContain('Parts of this file could not be read');
    // The value is still in the copy, hex-encoded where neither the engine nor ExifTool 13.59 decodes it.
    expect(readFileSync(join(inj, 'hexstm.pdf')).includes(Buffer.from(Buffer.from('ObjStm Author').toString('hex')))).toBe(true);
    expect(exifDump([join(inj, 'hexstm.pdf')])[join(inj, 'hexstm.pdf')]['PDF:Author']).toBeUndefined();
  });

  it('reported-not-removed items keep the copy "Not fully clean", naming them', () => {
    const { verdict } = cleanTo('report.pdf', 'all', join(inj, 'report.pdf'));
    expect(verdict.status).toBe('dirty');
    expect(verdict.survivors.map((s) => s.name)).toEqual(expect.arrayContaining(['Comment author', 'Attached file']));
    expect(verdict.survivors.map((s) => s.id)).not.toContain('pdf:Author');
  });

  it('a value written back into a blanked range is caught; a changed page byte is never "clean"', () => {
    const clean1 = readFileSync(outPath('all', 'doc.pdf'));
    const src = readFileSync(join(FIX, 'doc.pdf'));
    const at = src.indexOf('/Author (Jane Fixture)');
    const hidden = Buffer.from(clean1);
    hidden.write('(Jane Fixture)', at + 8, 'latin1');
    const file = join(inj, 'author.pdf');
    writeFileSync(file, hidden);
    const v = verifyFile('doc.pdf', file, 'all');
    expect(v.status).toBe('dirty');
    expect(v.survivors).toContainEqual({ id: 'pdf:Author', name: 'Document author', reader: 'signature' });

    const page = Buffer.from(clean1);
    const content = page.indexOf('stream\n') + 7 + 10;
    page[content] ^= 0x01;
    writeFileSync(file, page);
    const v2 = verifyFile('doc.pdf', file, 'all');
    expect(v2.status).toBe('unverified');
    expect(v2.pictureUnchanged).toBe(false);
  });
});

describe('PDF text encodings', () => {
  it('a UTF-16 hex Author and an escaped literal Title are decoded, removed and verified', () => {
    const doc = readFileSync(join(FIX, 'doc.pdf'));
    const text = doc.toString('latin1');
    const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
    const root = Number(/\/Root (\d+) 0 R/.exec(text)![1]);
    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const utf16 = Buffer.from('﻿Jürgen Beispiel', 'utf16le').swap16().toString('hex').toUpperCase();
    const obj = Buffer.from(`${size} 0 obj\n<< /Author <${utf16}> /Title (Line\\nTwo \\(draft\\) \\101BC) >>\nendobj\n`, 'latin1');
    const xref = `xref\n${size} 1\n${String(doc.length).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root} 0 R /Info ${size} 0 R /Prev ${prev} >>\nstartxref\n${doc.length + obj.length}\n%%EOF\n`;
    const input = join(IN, 'utf16.pdf');
    writeFileSync(input, Buffer.concat([doc, obj, Buffer.from(xref, 'latin1')]));
    expect(exifDump([input])[input]['PDF:Author']).toBe('Jürgen Beispiel');
    const src = openNodeByteFile(input);
    const r = inspect(src);
    expect(r.fields.find((x) => x.id === 'pdf:Author')?.value).toBe('Jürgen Beispiel');
    expect(r.fields.find((x) => x.id === 'pdf:Title')?.value).toBe('Line\nTwo (draft) ABC');
    const out = join(OUT, 'utf16-clean.pdf');
    writeFileSync(out, new Uint8Array(0));
    const dst = openNodeByteFile(out, true);
    const c = clean(src, dst, 'all');
    const v = verify({ src, dst, before: c.before, profile: 'all' });
    src.close();
    dst.close();
    expect(v.status).toBe('clean');
    const b = readFileSync(out);
    expect(b.includes(Buffer.from(utf16))).toBe(false);
    expect(exifDump([out])[out]['PDF:Author']).toBeUndefined();
  });
});
