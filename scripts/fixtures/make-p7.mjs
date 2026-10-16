#!/usr/bin/env node
// Device-only inputs for the P7 flows (kept out of test/fixtures, which the manifest test requires to be fully described):
//   hexstm.pdf  a real PDF whose metadata sits in an ASCIIHex-encoded object stream, which the engine cannot decode:
//               the honest result is "Could not verify" (never green) — the same file the Jest test builds in memory.
//   empty.jpg   0 bytes.
//   notes.txt   a text file (unsupported).
// Usage: node scripts/fixtures/make-p7.mjs   (scripts/e2e.sh pushes test/fixtures-device/* next to the normal fixtures)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildObjStmPdf } from '../../test/pdf-builder.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures-device');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'hexstm.pdf'), buildObjStmPdf({ hexObjStm: true }));
writeFileSync(join(out, 'empty.jpg'), new Uint8Array(0));
writeFileSync(join(out, 'notes.txt'), 'Shopping list\nmilk\neggs\n');
console.log('wrote hexstm.pdf, empty.jpg, notes.txt');
