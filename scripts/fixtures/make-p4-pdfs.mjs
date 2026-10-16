// P4 fixtures for the honesty flows: report.pdf (comment author, attachment, form, JavaScript, signature — reported, not removed)
// and encrypted.pdf (a real password-protected PDF written by CoreGraphics — must be declined). Usage: node make-p4-pdfs.mjs <outdir>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test/fixtures';
const { buildReportPdf } = await import('../../test/pdf-builder.ts');
writeFileSync(join(out, 'report.pdf'), buildReportPdf(readFileSync(join(out, 'doc.pdf'))));

const dir = mkdtempSync(join(tmpdir(), 'ss-enc-'));
const swift = join(dir, 'enc.swift');
writeFileSync(swift, `import CoreGraphics
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
var box = CGRect(x: 0, y: 0, width: 200, height: 200)
let info: [CFString: Any] = [kCGPDFContextUserPassword: "fixture" as CFString, kCGPDFContextOwnerPassword: "owner" as CFString, kCGPDFContextAuthor: "Encrypted Author" as CFString]
let ctx = CGContext(url, mediaBox: &box, info as CFDictionary)!
ctx.beginPDFPage(nil)
ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 1))
ctx.fill(CGRect(x: 20, y: 20, width: 100, height: 100))
ctx.endPDFPage()
ctx.closePDF()
`);
execFileSync('swift', [swift, join(out, 'encrypted.pdf')], { stdio: 'inherit' });
console.log('wrote report.pdf and encrypted.pdf');
