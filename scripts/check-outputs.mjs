// Compares ExifTool's view of CLEANED files with test/fixtures/manifest.json (used for files pulled off devices).
// Usage: node scripts/check-outputs.mjs [--keep-camera] <dir> [--map cleanedName=fixtureName ...]
// A cleaned file is matched to its manifest entry by identical file name, or by --map.
// Fails (exit 1) when a sensitive value/raw string survives or a `keep` value (orientation, ICC) is lost.
// --keep-camera: profile "Keep camera settings" (cameraSettings may stay, and `keep` is not required).
// --location: profile "Location only": only location values (GPS, city, video location keys) must be gone; dates, make/model may stay.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { exifDump, survivors, lostKept, loadManifest } = require('./lib/referee.js');

const args = process.argv.slice(2);
const keepCamera = args.includes('--keep-camera');
const locationOnly = args.includes('--location');
const LOCATION_KEY = /GPS|Location|City|Coordinates|xyz/i;
const maps = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--map') { const [a, b] = args[++i].split('='); maps.set(a, b); } else if (args[i] !== '--keep-camera' && args[i] !== '--location') positional.push(args[i]);
}
if (positional.length !== 1) { console.error('Usage: check-outputs.mjs [--keep-camera|--location] <dir> [--map cleaned=fixture ...]'); process.exit(2); }
const dir = resolve(positional[0]);
const manifest = loadManifest();
const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
const dumps = exifDump(files.map((f) => join(dir, f)));

let bad = 0, checked = 0;
for (const f of files) {
  const key = maps.get(f) ?? f;
  let entry = manifest.files[key];
  if (entry && locationOnly) {
    entry = { ...entry, sensitive: Object.fromEntries(Object.entries(entry.sensitive).filter(([k]) => LOCATION_KEY.test(k))), cameraSettings: {}, rawStrings: [] };
  }
  if (!entry) { console.log(`SKIP ${f} (no manifest entry; use --map ${f}=<fixture>)`); continue; }
  const tags = dumps[join(dir, f)];
  const left = survivors(entry, tags, readFileSync(join(dir, f)), { includeCameraSettings: !keepCamera });
  const lost = keepCamera || locationOnly ? [] : lostKept(entry, tags);
  checked++;
  if (left.length || lost.length) {
    bad++;
    console.log(`FAIL ${f}${left.length ? ` still contains: ${left.join(', ')}` : ''}${lost.length ? ` lost: ${lost.join(', ')}` : ''}`);
  } else console.log(`OK   ${f}`);
}
console.log(`${checked} checked, ${bad} failed`);
process.exit(bad ? 1 : 0);
