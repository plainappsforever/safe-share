/** Coordinates found by Inspect, for "Show on map" (D19: the system maps app is opened only when the user taps). */
import type { Field, Finding } from '@/engine/catalog';
import type { MetadataReport } from '@/engine/inspect';

import { strings } from './strings';

export interface Coordinates {
  lat: number;
  lon: number;
}

/** `52° 31' 12"` + `N` -> 52.52 */
function dms(value: string, ref: string | undefined): number | null {
  const m = value.match(/(-?\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)?\D*(\d+(?:\.\d+)?)?/);
  if (!m) return null;
  const deg = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const sec = m[3] ? Number(m[3]) : 0;
  let v = Math.abs(deg) + min / 60 + sec / 3600;
  if (deg < 0 || ref === 'S' || ref === 'W') v = -v;
  return Number.isFinite(v) ? v : null;
}

function valid(lat: number, lon: number): Coordinates | null {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** EXIF GPS, ISO 6709 (`+52.5200+013.4049+034.000/`) and MP4 `loci` (`52.5, 13.4, 34 m`). */
export function findCoordinates(fields: Field[]): Coordinates | null {
  const val = (id: string) => fields.find((f) => f.id === id)?.value;
  const lat = val('exif:GPSLatitude');
  const lon = val('exif:GPSLongitude');
  if (lat && lon) {
    const a = dms(lat, val('exif:GPSLatitudeRef')?.trim());
    const b = dms(lon, val('exif:GPSLongitudeRef')?.trim());
    if (a !== null && b !== null) return valid(a, b);
  }
  for (const f of fields) {
    if (f.source !== 'qt') continue;
    const iso = f.value.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    if (iso && /ISO6709|xyz/.test(f.key)) return valid(Number(iso[1]), Number(iso[2]));
    const loci = f.value.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (loci && f.key === 'loci') return valid(Number(loci[1]), Number(loci[2]));
  }
  return null;
}

/** Link that opens the system maps app (iOS: Apple Maps, Android: any geo: handler). */
export function mapUrl(c: Coordinates, platform: 'ios' | 'android' | string): string {
  const ll = `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
  return platform === 'ios' ? `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent('Location in the file')}` : `geo:${ll}?q=${ll}`;
}

/**
 * What the copy Safe Share received says about location (SPEC F2, D17):
 * - `found`: at least one real location value;
 * - `empty`: location fields exist but every value is blank — Android zeroes them for apps without ACCESS_MEDIA_LOCATION;
 * - `none`: no location fields at all.
 */
export type LocationState = 'found' | 'empty' | 'none';

/** A value with nothing in it but zeros, separators or the engine's "no number" markers (zeroed rationals -> NaN / undefined). */
export function isBlankValue(value: string): boolean {
  return value.replace(/NaN|undefined|\(empty\)/g, '').replace(/[0\s°'"″′.,:;/+\-]/g, '') === '';
}

/** Reference letters (N/E, "above sea level") and the GPS version say nothing on their own. */
function isCoordinateEvidence(f: Field): boolean {
  return f.group === 'location' && !/Ref$/.test(f.key) && !/GPSVersionID$/.test(f.key);
}

export function locationState(fields: Field[]): LocationState {
  const loc = fields.filter((f) => f.group === 'location');
  if (loc.length === 0) return 'none';
  return loc.some((f) => isCoordinateEvidence(f) && !isBlankValue(f.value)) ? 'found' : 'empty';
}

/** Coordinate fields (same set the engine calls "exact"), without the N/E reference letters. */
function isCoordinate(f: Field): boolean {
  return f.group === 'location' && /latitude|longitude|GPSPosition|ISO6709|©xyz|loci|GPSTrack/i.test(f.key) && !/Ref$/.test(f.key);
}

/** GPS coordinates are present but every value is blank: what Android hands to apps without ACCESS_MEDIA_LOCATION. */
export function coordinatesBlanked(fields: Field[]): boolean {
  const c = fields.filter(isCoordinate);
  return c.length > 0 && c.every((f) => isBlankValue(f.value));
}

/**
 * Findings as shown (P4-4): blank coordinates are never "Exact location". All-blank location reads "Location fields are
 * empty" (grey); blank coordinates next to a real place name (Android keeps XMP/IPTC City) read "Location details".
 */
export function displayFindings(report: Pick<MetadataReport, 'fields' | 'findings'>): Finding[] {
  const loc = report.findings.find((f) => f.id === 'location');
  if (!loc) return report.findings;
  if (locationState(report.fields) === 'empty') {
    const rest = report.findings.filter((f) => f.id !== 'location' && f.id !== 'none');
    const out: Finding[] = [{ id: 'location-empty', label: strings.location.emptyChip, level: 'grey' }, ...rest];
    if (!rest.some((f) => f.level !== 'grey')) out.unshift({ id: 'none', label: strings.inspect.nothingFound, level: 'grey' });
    return out;
  }
  if (!coordinatesBlanked(report.fields)) return report.findings;
  return report.findings.map((f) => (f.id === 'location' ? { ...f, label: strings.location.detailsChip } : f));
}

/** Value as shown in Details: blank location values read "(empty)" instead of "NaN° NaN' NaN"". */
export function displayValue(f: Field): string {
  return f.group === 'location' && isBlankValue(f.value) ? strings.location.emptyValue : f.value;
}
