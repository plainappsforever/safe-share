/** @jest-environment node */
import { inspect } from '@/engine/inspect';
import { openNodeByteFile } from '../../test/node-byte-file';

import { coordinatesBlanked, displayFindings, displayValue, findCoordinates, isBlankValue, locationState, mapUrl } from './location';

function coordsOf(name: string) {
  return findCoordinates(inspect(openNodeByteFile(`test/fixtures/${name}`)).fields);
}

describe('findCoordinates', () => {
  it('reads EXIF degrees/minutes/seconds with N/E', () => {
    const c = coordsOf('photo.jpg')!;
    expect(c.lat).toBeCloseTo(52.52, 3);
    expect(c.lon).toBeCloseTo(13.4049, 3);
  });
  it('reads HEIC EXIF, MOV ISO 6709 and MP4 loci', () => {
    expect(coordsOf('photo.heic')!.lat).toBeCloseTo(52.52, 3);
    expect(coordsOf('gps.mov')!.lon).toBeCloseTo(13.4049, 3);
    expect(coordsOf('gps.mp4')!.lat).toBeCloseTo(52.52, 3);
  });
  it('is null when there is no location', () => {
    expect(coordsOf('nometa.jpg')).toBeNull();
    expect(coordsOf('doc.pdf')).toBeNull();
  });
  it('honours S and W', () => {
    const f = (id: string, value: string) => ({ id, value }) as never;
    const c = findCoordinates([f('exif:GPSLatitude', "33° 51' 0\""), f('exif:GPSLatitudeRef', 'S'), f('exif:GPSLongitude', "151° 12' 0\""), f('exif:GPSLongitudeRef', 'W')]);
    expect(c!.lat).toBeCloseTo(-33.85, 3);
    expect(c!.lon).toBeCloseTo(-151.2, 3);
  });
});

describe('mapUrl', () => {
  it('builds platform links', () => {
    expect(mapUrl({ lat: 52.52, lon: 13.4049 }, 'android')).toBe('geo:52.520000,13.404900?q=52.520000,13.404900');
    expect(mapUrl({ lat: 52.52, lon: 13.4049 }, 'ios')).toMatch(/^https:\/\/maps\.apple\.com\/\?ll=52\.520000,13\.404900/);
  });
});

// Real evidence: test/fixtures/photo.jpg as the API 36 emulator's photo picker handed it to Safe Share (expo-image-picker),
// with and without ACCESS_MEDIA_LOCATION (P4/P5): 34 bytes zeroed, all GPS values; XMP/IPTC City "Berlin" untouched.
describe('location honesty (P4-4)', () => {
  const report = (path: string) => inspect(openNodeByteFile(path));

  it('the Android picker copy has blank coordinates but still a city: "Location details", never "Exact location"', () => {
    const r = report('test/android/photo-picker-redacted.jpg');
    expect(coordinatesBlanked(r.fields)).toBe(true);
    expect(locationState(r.fields)).toBe('found');
    expect(r.findings.find((f) => f.id === 'location')?.label).toBe('Exact location'); // the engine's raw view
    const shown = displayFindings(r);
    expect(shown.find((f) => f.id === 'location')?.label).toBe('Location details');
    expect(shown.some((f) => f.label === 'Exact location')).toBe(false);
    expect(findCoordinates(r.fields)).toBeNull();
  });

  it('blank values read "(empty)" in Details', () => {
    const r = report('test/android/photo-picker-redacted.jpg');
    const lat = r.fields.find((f) => f.key === 'GPSLatitude')!;
    expect(displayValue(lat)).toBe('(empty)');
    expect(displayValue(r.fields.find((f) => f.key === 'City')!)).toBe('Berlin');
  });

  it('the original keeps "Exact location" and is not blanked', () => {
    const r = report('test/fixtures/photo.jpg');
    expect(coordinatesBlanked(r.fields)).toBe(false);
    expect(displayFindings(r)).toEqual(r.findings);
  });

  it('only blank location fields: grey "Location fields are empty", no red location chip', () => {
    const r = report('test/android/photo-picker-redacted.jpg');
    const fields = r.fields.filter((f) => f.key !== 'City');
    expect(locationState(fields)).toBe('empty');
    const shown = displayFindings({ fields, findings: r.findings });
    expect(shown[0]).toEqual({ id: 'location-empty', label: 'Location fields are empty', level: 'grey' });
    expect(shown.some((f) => f.id === 'location')).toBe(false);
  });

  it('a file without location fields is "none"', () => {
    expect(locationState(report('test/fixtures/nometa.jpg').fields)).toBe('none');
  });

  it('blank-value rule', () => {
    expect(isBlankValue('NaN° NaN\' NaN"')).toBe(true);
    expect(isBlankValue('undefined undefined undefined')).toBe(true);
    expect(isBlankValue('0')).toBe(true);
    expect(isBlankValue('')).toBe(true);
    expect(isBlankValue('52° 31\' 12"')).toBe(false);
    expect(isBlankValue('N')).toBe(false);
  });
});
