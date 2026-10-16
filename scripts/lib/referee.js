// Independent referee helpers: ExifTool 13.59 (exiftool-vendored.pl) decides what a file still contains.
// Used by test/fixtures.test.ts, later engine tests and scripts/check-outputs.mjs. Host only, never imported by app code.
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXIFTOOL = path.join(ROOT, 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool');
const ARGS = ['-a', '-G1', '-ee3', '-u', '-j']; // same as scripts/exif-check.sh

/** Runs ExifTool on files; returns { [file as given]: { "Group:Tag": value } } (SourceFile removed). */
function exifDump(files) {
  if (files.length === 0) return {};
  const out = execFileSync('/usr/bin/perl', [EXIFTOOL, ...ARGS, ...files], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  const result = {};
  for (const row of JSON.parse(out)) {
    const { SourceFile, ...tags } = row;
    result[SourceFile] = tags;
  }
  return result;
}

/** ExifTool prints numbers as numbers, lists as arrays; the manifest stores exactly that. */
function valueEquals(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function stringify(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Entries of `entry` that must exist in an INPUT fixture: sensitive + cameraSettings + keep (tags) and rawStrings (bytes). */
function expectedTags(entry) {
  return { ...entry.sensitive, ...entry.cameraSettings, ...entry.keep };
}

/** Manifest values ExifTool (tags) or a raw byte scan (bytes) does NOT find in a file. Empty array = all found. */
function missingInInput(entry, tags, bytes) {
  const missing = [];
  for (const [key, value] of Object.entries(expectedTags(entry))) {
    if (!(key in tags)) missing.push(`${key} (absent)`);
    else if (!valueEquals(tags[key], value)) missing.push(`${key} (is ${JSON.stringify(tags[key])}, expected ${JSON.stringify(value)})`);
  }
  for (const s of entry.rawStrings ?? []) if (!bytes.includes(Buffer.from(s, 'utf8'))) missing.push(`raw "${s}" (absent)`);
  return missing;
}

/**
 * Sensitive things still present in a (cleaned) file: the exact manifest tag with its value, any
 * long sensitive value showing up under another tag name, and raw strings found in the bytes.
 * `sensitive` covers identifying fields; cameraSettings are only checked when includeCameraSettings.
 */
function survivors(entry, tags, bytes, { includeCameraSettings = true } = {}) {
  const found = [];
  const groups = includeCameraSettings ? { ...entry.sensitive, ...entry.cameraSettings } : { ...entry.sensitive };
  const visible = Object.entries(tags).filter(([k]) => !k.startsWith('System:') && !k.startsWith('ExifTool:'));
  for (const [key, value] of Object.entries(groups)) {
    if (key in tags && valueEquals(tags[key], value)) found.push(key);
    else if (typeof value === 'string' && value.length >= 6 && visible.some(([, v]) => stringify(v).includes(value))) found.push(`${key} (under another tag)`);
  }
  for (const s of entry.rawStrings ?? []) if (bytes.includes(Buffer.from(s, 'utf8'))) found.push(`raw "${s}"`);
  return found;
}

/** Manifest `keep` values that are gone from a cleaned file. */
function lostKept(entry, tags) {
  return Object.entries(entry.keep ?? {}).filter(([k, v]) => !(k in tags) || !valueEquals(tags[k], v)).map(([k]) => k);
}

function loadManifest(file = path.join(ROOT, 'test', 'fixtures', 'manifest.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

module.exports = { ROOT, exifDump, valueEquals, expectedTags, missingInInput, survivors, lostKept, loadManifest };
