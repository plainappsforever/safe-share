// Test helper (P3): synthetic PDFs for cases the fixtures do not cover. Independent of the engine.
//  - buildObjStmPdf: PDF 1.5 with a cross-reference STREAM and the Info dictionary inside a compressed
//    object stream (what Word/Acrobat write); `hexObjStm` stores the object stream with /ASCIIHexDecode,
//    a filter the engine does not decode (must end as "Could not verify", never "clean").
//  - buildReportPdf: doc.pdf + an incremental update with an annotation author, an attached file, a form,
//    JavaScript and a signature dictionary (reported, not removed).
import { deflateSync } from 'node:zlib';

const lat = (s: string) => Buffer.from(s, 'latin1');

export function buildObjStmPdf(opts: { hexObjStm?: boolean } = {}): Buffer {
  const content = deflateSync(lat('0 0 1 rg 20 20 120 60 re f\n'));
  const inner: [number, string][] = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>'],
    [5, '<< /Author (ObjStm Author) /Title (ObjStm Secret Title) /Producer (ObjStmProducer 1.0) /CreationDate (D:20250614093015+02\'00\') >>'],
  ];
  let body = '';
  const offs: number[] = [];
  for (const [, s] of inner) {
    offs.push(body.length);
    body += `${s}\n`;
  }
  const header = inner.map(([n], i) => `${n} ${offs[i]}`).join(' ') + '\n';
  const plain = lat(header + body);
  const stm = opts.hexObjStm ? lat(plain.toString('hex') + '>') : deflateSync(plain);
  const filter = opts.hexObjStm ? '/ASCIIHexDecode' : '/FlateDecode';
  const parts: Buffer[] = [lat('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')];
  let off = parts[0].length;
  const at: Record<number, number> = {};
  const add = (n: number, b: Buffer) => {
    at[n] = off;
    parts.push(b);
    off += b.length;
  };
  add(4, Buffer.concat([lat(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, lat('\nendstream\nendobj\n')]));
  add(6, Buffer.concat([lat(`6 0 obj\n<< /Type /ObjStm /N ${inner.length} /First ${header.length} /Length ${stm.length} /Filter ${filter} >>\nstream\n`), stm, lat('\nendstream\nendobj\n')]));
  // Cross-reference stream: W [1 4 2]; type 1 = offset, type 2 = (object stream, index).
  const xrefAt = off;
  const row = (t: number, a: number, b: number) => {
    const r = Buffer.alloc(7);
    r[0] = t;
    r.writeUInt32BE(a, 1);
    r.writeUInt16BE(b, 5);
    return r;
  };
  const idx = (n: number) => inner.findIndex(([m]) => m === n);
  const rows = [row(0, 0, 65535)];
  for (let n = 1; n <= 7; n++) {
    if (n === 4 || n === 6) rows.push(row(1, at[n], 0));
    else if (n === 7) rows.push(row(1, xrefAt, 0));
    else rows.push(row(2, 6, idx(n)));
  }
  const xdata = deflateSync(Buffer.concat(rows));
  parts.push(Buffer.concat([lat(`7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Info 5 0 R /Length ${xdata.length} /Filter /FlateDecode >>\nstream\n`), xdata, lat(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`)]));
  return Buffer.concat(parts);
}

export function buildReportPdf(doc: Buffer): Buffer {
  const text = doc.toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)![1]);
  const root = Number(/\/Root (\d+) 0 R/.exec(text)![1]);
  const size = Number(/\/Size (\d+)/.exec(text)![1]);
  const info = Number(/\/Info (\d+) 0 R/.exec(text)![1]);
  const catalog = new RegExp(`(?:^|\\n)${root} 0 obj\\s*(<<[\\s\\S]*?>>)\\s*endobj`).exec(text)![1];
  const n = (k: number) => size + k;
  const objs: [number, string][] = [
    [n(0), '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /T (Reviewer Fixture) /Contents (Please check) >>'],
    [n(1), '<< /Type /EmbeddedFile /Length 11 >>\nstream\nhello world\nendstream'],
    [n(2), `<< /Type /Filespec /F (notes.txt) /UF (notes.txt) /EF << /F ${n(1)} 0 R >> >>`],
    [n(3), '<< /S /JavaScript /JS (app.alert\\(1\\);) >>'],
    [n(4), '<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <00> >>'],
    [root, catalog.replace(/>>\s*$/, `/AcroForm << /Fields [] >> /OpenAction ${n(3)} 0 R >>`)],
  ];
  let off = doc.length;
  const parts: Buffer[] = [];
  const at: Record<number, number> = {};
  for (const [k, body] of objs) {
    at[k] = off;
    const b = lat(`${k} 0 obj\n${body}\nendobj\n`);
    parts.push(b);
    off += b.length;
  }
  const nums = Object.keys(at).map(Number).sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n` + nums.slice(i, j + 1).map((k) => `${String(at[k]).padStart(10, '0')} 00000 n \n`).join('');
    i = j + 1;
  }
  xref += `trailer\n<< /Size ${n(5)} /Root ${root} 0 R /Info ${info} 0 R /Prev ${prev} >>\nstartxref\n${off}\n%%EOF\n`;
  return Buffer.concat([doc, ...parts, lat(xref)]);
}
