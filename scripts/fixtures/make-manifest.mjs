// Writes test/fixtures/manifest.json: for every input fixture, the hidden values ExifTool must find
// (and that a cleaner must remove). Values are typed here, not copied from ExifTool, EXCEPT the few
// timestamps the OS writes at creation time (video mvhd/tkhd/mdhd times, PDF CreateDate); those are read once.
// Run after make-images / make-video / make-pdf / make-synthetic.  Usage: node scripts/fixtures/make-manifest.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { exifDump } = require('../lib/referee.js');
const dir = resolve('test/fixtures');

const LAT = "52 deg 31' 12.00\"", LON = "13 deg 24' 17.64\"";
// Written by make-images.swift into Exif (JPEG, HEIC, PNG, and reused byte-wise for WebP/PNG synthetics).
const EXIF_IDENTIFYING = {
  'IFD0:Make': 'FixtureCam', 'IFD0:Model': 'FC-1', 'IFD0:Software': 'FixtureSoft 1.0', 'IFD0:Artist': 'Jane Fixture',
  'IFD0:Copyright': '(c) Jane Fixture 2025',
  'ExifIFD:DateTimeOriginal': '2025:06:14 09:30:15', 'ExifIFD:CreateDate': '2025:06:14 09:30:15', 'ExifIFD:OffsetTimeOriginal': '+02:00',
  'ExifIFD:SerialNumber': 'SN-FIXTURE-123', 'ExifIFD:LensSerialNumber': 'LSN-FIXTURE-456',
};
const GPS = { 'GPS:GPSLatitude': LAT, 'GPS:GPSLongitude': LON, 'GPS:GPSAltitude': '34 m', 'GPS:GPSDateStamp': '2025:06:14', 'GPS:GPSTimeStamp': '07:30:15' };
const CAMERA = { 'ExifIFD:ExposureTime': '1/125', 'ExifIFD:FNumber': 1.8, 'ExifIFD:ISO': 200, 'ExifIFD:FocalLength': '24.0 mm', 'ExifIFD:LensModel': 'Fixture Lens 24mm f/1.8' };
const KEEP_ICC = { 'ICC_Profile:ProfileDescription': 'Display P3' };
const KEEP_ORIENT = { 'IFD0:Orientation': 'Rotate 90 CW' };
const IPTC = { 'IPTC:By-line': 'Jane Fixture XMP', 'IPTC:City': 'Berlin', 'IPTC:Caption-Abstract': 'Fixture caption' }; // ImageIO folds dc:creator into By-line
const XMP = { 'XMP-dc:Creator': 'Jane Fixture XMP', 'XMP-xmp:CreatorTool': 'FixtureSoft XMP 2.0', 'XMP-fixture:OwnerEmail': 'jane@fixture.test' };
const location = (o) => Object.keys(o).filter((k) => k.startsWith('GPS:') || k.includes('GPSLat') || k.includes('GPSLong') || k.includes('GPSAlt') || k.includes('GPSDate') || k.includes('GPSTime') || k.includes('GPSCoordinates') || k.includes('LocationInformation'));

const entry = (format, lossless, sensitive, extra = {}) => ({
  format, supported: true, sensitive, location: location(sensitive), cameraSettings: {}, keep: {}, rawStrings: [], lossless, ...extra,
});

const files = {};
// Embedded-trailer markers print their byte length; read them from the file rather than hard-coding.
const trailerDump = exifDump(['ultrahdr.jpg', 'motion.jpg'].map((f) => join(dir, f)));
const trailer = (f, key) => trailerDump[join(dir, f)][key];
files['photo.jpg'] = entry('jpeg', 'jpeg-scan', { ...EXIF_IDENTIFYING, ...GPS, ...IPTC, ...XMP }, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC },
  notes: 'ImageIO: Exif (big-endian), GPS, IPTC, XMP, ICC Display P3, Orientation 6' });
files['progressive.jpg'] = entry('jpeg', 'jpeg-scan', { ...EXIF_IDENTIFYING, ...GPS, ...IPTC, ...XMP }, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC },
  notes: 'ImageIO progressive JPEG (P2): several SOS scans with DHT segments between them; same metadata as photo.jpg' });
files['photo.avif'] = entry('avif', 'heic-outside-metadata-items', { ...EXIF_IDENTIFYING, ...GPS, ...XMP }, {
  cameraSettings: CAMERA, keep: { 'QuickTime:Rotation': 'Horizontal (normal)', ...KEEP_ICC },
  notes: 'ImageIO AVIF (P3): Exif + XMP items, ICC; irot = 0 while Exif says Orientation 6 — ImageIO displays it unrotated (irot wins), so the Exif copy is removed as in HEIC (D31)' });
files['nometa.jpg'] = entry('jpeg', 'jpeg-scan', {}, { keep: KEEP_ICC, notes: 'Nothing sensitive: ICC only' });
files['photo.heic'] = entry('heic', 'heic-outside-metadata-items', { ...EXIF_IDENTIFYING, ...GPS, ...XMP }, {
  cameraSettings: CAMERA, keep: { 'QuickTime:Rotation': 'Rotate 90 CW', ...KEEP_ICC }, notes: 'ImageIO HEIC; rotation lives in irot (kept) and in the Exif item (removed)' });
const PNG_XMP = {
  ...XMP, 'XMP-exif:GPSLatitude': LAT + ' N', 'XMP-exif:GPSLongitude': LON + ' E', 'XMP-exif:GPSAltitude': '34 m', 'XMP-exif:GPSDateTime': '2025:06:14 07:30:15',
  'XMP-exifEX:SerialNumber': 'SN-FIXTURE-123', 'XMP-exifEX:LensSerialNumber': 'LSN-FIXTURE-456', 'XMP-tiff:Make': 'FixtureCam', 'XMP-tiff:Model': 'FC-1',
  'XMP-photoshop:City': 'Berlin', 'XMP-dc:Description': 'Fixture caption', 'XMP-dc:Rights': '(c) Jane Fixture 2025',
};
files['photo.png'] = entry('png', 'png-idat', { ...EXIF_IDENTIFYING, ...GPS, ...PNG_XMP }, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC },
  notes: 'ImageIO PNG: eXIf chunk plus XMP iTXt mirror of the Exif values' });
files['text.png'] = entry('png', 'png-idat', {
  ...EXIF_IDENTIFYING, ...GPS, 'PNG:Author': 'Jane Fixture Text', 'PNG:Software': 'FixtureSoft PNG 3.0', 'PNG:Comment': 'Fixture zTXt secret comment',
  'PNG:ModifyDate': '2025:06:14 09:30:15', 'XMP-dc:Creator': 'Text Fixture XMP', 'XMP-fixture:OwnerEmail': 'text@fixture.test',
}, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC }, notes: 'tEXt, zTXt, iTXt XMP, eXIf, tIME, iCCP (byte-wise)' });
files['exif.webp'] = entry('webp', 'webp-chunks', { ...EXIF_IDENTIFYING, ...GPS, ...XMP }, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC, 'RIFF:ImageWidth': 1 },
  notes: 'VP8X + ICCP + 1x1 VP8L + EXIF + XMP (byte-wise; no WebP encoder on this Mac)' });
files['extras.jpg'] = entry('jpeg', 'jpeg-scan', {
  'IFD0:Make': 'ExtrasCam', 'IFD0:Model': 'EX-2', 'IFD0:Software': 'ExtrasSoft 2.0', 'IFD0:Artist': 'Extras Artist',
  'ExifIFD:DateTimeOriginal': '2024:12:24 18:00:00', 'ExifIFD:SerialNumber': 'SN-EXTRAS-789',
  'GPS:GPSLatitude': "48 deg 51' 30.00\"", 'GPS:GPSLongitude': "2 deg 17' 40.00\"",
  'IFD1:ThumbnailLength': 1293, 'File:Comment': 'Fixture COM secret comment',
  'XMP-dc:Creator': 'Extras XMP Creator', 'XMP-fixture:OwnerEmail': 'extras@fixture.test', 'XMP-fixture:ExtendedSecret': 'extended-xmp-secret-value',
  'IPTC:By-line': 'Extras Byline', 'IPTC:City': 'Hamburg', 'IPTC:Caption-Abstract': 'Extras caption',
}, { keep: { 'IFD0:Orientation': 'Rotate 270 CW', ...KEEP_ICC }, rawStrings: ['FIXTURE-MAKERNOTE-SECRET'],
  notes: 'Little-endian Exif with IFD1 thumbnail + MakerNote, COM, XMP + ExtendedXMP, APP13 IPTC' });
files['ultrahdr.jpg'] = entry('jpeg', 'jpeg-scan', {
  ...EXIF_IDENTIFYING, ...GPS, ...IPTC, 'XMP-dc:Creator': 'Ultra Fixture XMP', 'XMP-fixture:OwnerEmail': 'ultra@fixture.test',
  'Google:GainMapImage': trailer('ultrahdr.jpg', 'Google:GainMapImage'),
}, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC }, rawStrings: ['Gainmap Artist', 'SN-GAINMAP-555', 'gainmap@fixture.test'],
  notes: 'Primary + APP2 MPF + hdrgm XMP + appended grayscale gain-map JPEG with its own Exif/XMP (trailer removed, R1); gain-map values are only visible to a byte scan' });
files['motion.jpg'] = entry('jpeg', 'jpeg-scan', {
  ...EXIF_IDENTIFYING, ...GPS, ...IPTC, 'XMP-dc:Creator': 'Motion Fixture XMP', 'XMP-fixture:OwnerEmail': 'motion@fixture.test',
  'Google:MotionPhotoVideo': trailer('motion.jpg', 'Google:MotionPhotoVideo'),
}, { cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC },
  notes: 'GCamera MotionPhoto XMP + gps.mp4 appended after EOI (trailer removed, R1)' });
files['corrupt.jpg'] = entry('jpeg', 'none', { ...EXIF_IDENTIFYING, ...GPS, ...IPTC, ...XMP }, { supported: false, notes: 'photo.jpg truncated at 60 %: ExifTool still reads the header; the app must say "could not read", never "clean"' });
files['anim.gif'] = entry('gif', 'gif-frames', { 'File:Comment': 'Fixture GIF secret comment' }, { keep: { 'GIF:FrameCount': 2, 'GIF:AnimationIterations': 'Infinite' },
  notes: 'v1: unsupported (D21). V1.5-1 (X2): supported; the comment is removed, frames and loop block stay' });

// ---------------------------------------------------------------- V1.5-1 (scripts/fixtures/make-v15.mjs): TIFF, DNG, camera RAW, GIF, audio
files['photo.tiff'] = entry('tiff', 'tiff-picture-data', {
  ...EXIF_IDENTIFYING, ...GPS, ...IPTC, ...XMP, 'IFD0:ImageDescription': 'Fixture TIFF secret description', 'IFD0:HostComputer': "Jane's MacBook Pro",
}, { location: [...Object.keys(GPS), 'IPTC:City'], cameraSettings: CAMERA, keep: { ...KEEP_ORIENT, ...KEEP_ICC },
  notes: 'ImageIO TIFF (LZW, big-endian; Exif IFD stored before IFD0): Exif, GPS, IPTC, XMP, ICC Display P3, Orientation 6' });
files['pages.tiff'] = entry('tiff', 'tiff-picture-data', {
  ...EXIF_IDENTIFYING, ...GPS, 'IFD0:ImageDescription': 'Fixture page one secret', 'IFD1:ImageDescription': 'Fixture page two secret', 'IFD0:HostComputer': "Jane's MacBook Pro",
  'IPTC:By-line': 'Jane Fixture', 'IPTC:City': 'Berlin', 'IPTC:Caption-Abstract': 'Fixture caption',
  'XMP-dc:Creator': 'Jane Fixture', 'XMP-dc:Rights': '(c) Jane Fixture 2025', 'XMP-photoshop:City': 'Berlin', 'XMP-xmp:CreatorTool': 'FixtureSoft 1.0',
}, { location: [...Object.keys(GPS), 'IPTC:City', 'XMP-photoshop:City'], cameraSettings: CAMERA, keep: KEEP_ICC,
  notes: 'ImageIO two-page TIFF; page 2 is tiled (64x64, uncompressed) and has its own Exif/GPS/IPTC (ExifTool lists only the first Exif/GPS)' });
const DNG_GPS = { 'GPS:GPSLatitude': "48 deg 8' 30.00\"", 'GPS:GPSLongitude': "11 deg 34' 12.00\"", 'GPS:GPSAltitude': '520 m', 'GPS:GPSDateStamp': '2025:06:14' };
files['photo.dng'] = entry('dng', 'tiff-picture-data', {
  'IFD0:Make': 'Apple', 'IFD0:Model': 'iPhone 15 Pro', 'IFD0:Software': 17.1, 'IFD0:ModifyDate': '2025:06:14 09:30:15', 'IFD0:UniqueCameraModel': 'iPhone 15 Pro',
  'IFD0:CameraSerialNumber': 'SN-DNG-777', 'IFD0:RawDataUniqueID': 'C0FFEE00112233445566778899AABBCC', 'IFD0:OriginalRawFileName': 'IMG_20250614_093015.DNG',
  'IFD0:PreviewApplicationName': 'FixtureRAW Preview', 'IFD0:PreviewDateTime': '2025:06:14 09:30:15+02:00', 'SubIFD:ImageDescription': 'Fixture raw IFD secret description',
  'XMP-dc:Creator': 'Jane Fixture DNG', 'XMP-xmp:CreatorTool': 'FixtureRAW 1.0', 'XMP-photoshop:City': 'Munich',
  'XMP-exif:GPSLatitude': "48 deg 8' 30.00\" N", 'XMP-exif:GPSLongitude': "11 deg 34' 12.00\" E", 'IPTC:By-line': 'Jane Fixture IPTC', 'IPTC:City': 'Munich',
  'ExifIFD:DateTimeOriginal': '2025:06:14 09:30:15', 'ExifIFD:OffsetTimeOriginal': '+02:00', 'ExifIFD:ImageUniqueID': 'F1X7URE0D1A9C0FFEE00UNIQUE1D0001',
  'ExifIFD:SerialNumber': 'SN-DNG-BODY-888', 'ExifIFD:LensModel': 'iPhone 15 Pro back triple camera 6.86mm f/1.78', ...DNG_GPS,
}, {
  location: [...Object.keys(DNG_GPS), 'XMP-exif:GPSLatitude', 'XMP-exif:GPSLongitude', 'XMP-photoshop:City', 'IPTC:City'],
  cameraSettings: { 'ExifIFD:ExposureTime': '1/125', 'ExifIFD:FNumber': 1.8, 'ExifIFD:ISO': 64, 'ExifIFD:FocalLength': '6.9 mm' },
  keep: { 'IFD0:Orientation': 'Rotate 90 CW', 'IFD0:DNGVersion': '1.4.0.0', 'IFD0:ColorMatrix1': '1 -0.2 -0.1 -0.3 1.2 0.1 -0.05 0.15 0.7', 'SubIFD:CFAPattern2': '0 1 1 2', 'SubIFD:WhiteLevel': 4095 },
  rawStrings: ['FIXTURE-DNG-MAKERNOTE-SECRET', 'FIXTURE-DNG-PRIVATE-SECRET'],
  notes: 'Byte-wise DNG 1.4 (iPhone-ProRAW-like layout): IFD0 = 64x48 RGB preview with the identifying tags, SubIFD = 128x96 16-bit Bayer raw; MakerNote and DNGPrivateData carry secrets only a byte scan sees. ImageIO decodes the preview (not the raw) — held-out real ProRAW/Pixel DNGs are owner QA' });
files['camera.nef'] = entry('raw', 'none', {
  'IFD0:Make': 'NIKON CORPORATION', 'IFD0:Model': 'NIKON Z 6', 'IFD0:Artist': 'Jane Fixture NEF', 'IFD0:Copyright': '(c) Jane Fixture NEF',
  'ExifIFD:SerialNumber': 'SN-NEF-321', 'ExifIFD:DateTimeOriginal': '2024:12:24 18:00:00', 'GPS:GPSLatitude': "48 deg 8' 30.00\"", 'GPS:GPSLongitude': "11 deg 34' 12.00\"",
}, { supported: false, rawStrings: ['FIXTURE-NEF-MAKERNOTE-SECRET'],
  notes: 'Byte-wise Nikon-style NEF (CFA SubIFD, Nikon compression 34713, Nikon maker note). Camera RAW from a maker is inspected only (V15_PLAN #10): never cleaned, never called clean' });
files['meta.gif'] = entry('gif', 'gif-frames', {
  'File:Comment': 'Fixture GIF meta secret comment', 'XMP-xmp:CreatorTool': 'FixtureGIF 5.0', 'XMP-photoshop:City': 'Vienna', 'XMP-dc:Creator': 'Jane Fixture GIF',
  'XMP-exif:GPSLatitude': "48 deg 12' 30.00\" N", 'XMP-exif:GPSLongitude': "16 deg 22' 12.00\" E",
}, { location: ['XMP-photoshop:City', 'XMP-exif:GPSLatitude', 'XMP-exif:GPSLongitude'], keep: { ...KEEP_ICC, 'GIF:FrameCount': 2, 'GIF:AnimationIterations': 'Infinite' },
  rawStrings: ['Jane Fixture GIF IPTC', 'GIF-TRAILER-SECRET-DATA'],
  notes: 'ImageIO 2-frame GIF + byte-wise comment, XMP (magic trailer), ImageMagick IPTC block, ICC block, data after the trailer' });
files['voice.m4a'] = entry('unknown', 'none', {}, { supported: false, notes: 'afconvert AAC audio (M4A brand): audio is not supported (V15_PLAN #12 NICHE-SKIP); the app must decline it. Replaces anim.gif as the "not supported" example' });

// Video / PDF: values that depend on creation time are read from ExifTool once, everything else is typed.
const videoTimes = (tags) => Object.fromEntries(Object.entries(tags).filter(([k]) => /^(QuickTime:(Create|Modify)Date|Track\d:(Track|Media)(Create|Modify)Date)$/.test(k)));
const dump = exifDump(['gps.mov', 'gps.mp4', 'gps-xyz.mp4', 'doc.pdf', 'video.3gp'].map((f) => join(dir, f)));
const dumpOf = (f) => dump[join(dir, f)];
const KEEP_VIDEO = { 'Track1:ImageWidth': 320, 'Track1:ImageHeight': 240, 'QuickTime:Duration': '2.00 s' };
files['gps.mov'] = entry('mov', 'mp4-mdat', {
  'Keys:GPSCoordinates': "52 deg 31' 12.00\" N, 13 deg 24' 17.64\" E, 34 m Above Sea Level", 'Keys:Make': 'FixtureCam', 'Keys:Model': 'FC-1',
  'Keys:Software': 'FixtureSoft 1.0', 'Keys:CreationDate': '2025:06:14 09:30:15+02:00', ...videoTimes(dumpOf('gps.mov')),
}, { keep: KEEP_VIDEO, notes: 'QuickTime metadata (mdta keys + ilst) written by AVAssetWriter, 2 s H.264 + AAC' });
const MP4_UDTA = { 'UserData:LocationInformation': '(none) Role=shooting Lat=52.51999 Lon=13.40489 Alt=34.00 Body=earth Notes=', 'UserData:DateTimeOriginal': '2025:06:14 09:30:15+02:00' };
files['gps.mp4'] = entry('mp4', 'mp4-mdat', { ...MP4_UDTA, ...videoTimes(dumpOf('gps.mp4')) }, { keep: KEEP_VIDEO,
  notes: 'AVAssetWriter MP4: udta loci + date (no (c)xyz, no mdta Make/Model: the MP4 muxer drops them); mdat uses a 64-bit size' });
files['gps-xyz.mp4'] = entry('mp4', 'mp4-mdat', { ...MP4_UDTA, 'UserData:GPSCoordinates': "52 deg 31' 12.00\" N, 13 deg 24' 17.64\" E, 34 m Above Sea Level", ...videoTimes(dumpOf('gps-xyz.mp4')) },
  { keep: KEEP_VIDEO, notes: 'gps.mp4 plus an Android-style (c)xyz atom in udta, added byte-wise' });
files['video.3gp'] = entry('mp4', 'mp4-mdat', {
  'UserData:Title': 'Fixture 3GP secret title', 'UserData:Author': 'Jane Fixture 3GP', 'UserData:Copyright': '(c) Jane Fixture 3GP', 'UserData:Description': 'Fixture 3GP description',
  'UserData:LocationInformation': '(none) Role=shooting Lat=48.85840 Lon=2.29449 Alt=35.00 Body=earth Notes=', 'UserData:DateTimeOriginal': '2025:06:14 09:30:15+02:00',
  ...videoTimes(dumpOf('video.3gp')),
}, { keep: KEEP_VIDEO, notes: 'AVAssetWriter 3GPP (brand 3gp6, video only: the 3GPP writer waits for interleaved audio): udta titl/auth/cprt/dscp/loci/date (X3)' });
const pdfDates = Object.fromEntries(['PDF:CreateDate', 'PDF:ModifyDate'].map((k) => [k, dumpOf('doc.pdf')[k]]));
files['doc.pdf'] = entry('pdf', 'pdf-blanked-ranges', {
  'PDF:Title': 'Fixture Secret Report', 'PDF:Author': 'Jane Fixture', 'PDF:Subject': 'Fixture subject', 'PDF:Creator': 'FixtureWriter 1.0',
  'PDF:Keywords': ['fixture', 'secret'], 'PDF:Producer': dumpOf('doc.pdf')['PDF:Producer'], ...pdfDates,
}, { keep: { 'PDF:PageCount': 1 }, notes: 'CoreGraphics PDF 1.3, classic xref, Info dictionary only' });
files['revised.pdf'] = entry('pdf', 'pdf-blanked-ranges', {
  'PDF:Author': 'Second Author', 'PDF:Title': 'Revised Secret Title', 'PDF:Creator': 'RevisedWriter 2.0',
  'XMP-dc:Creator': 'Revised XMP Creator', 'XMP-xmp:CreatorTool': 'RevisedTool 9.9',
}, { keep: { 'PDF:PageCount': 1 }, rawStrings: ['Jane Fixture', 'Fixture Secret Report', 'FixtureWriter 1.0', 'Fixture subject', 'Quartz PDFContext'],
  notes: 'doc.pdf + incremental update (2nd Info dict, XMP stream, new catalog). ExifTool only reports the newest Info dict; the first revision values are only visible to a byte scan' });

files['flate-xmp.pdf'] = entry('pdf', 'pdf-blanked-ranges', {
  'PDF:Author': 'Flate Author', 'PDF:Producer': 'FlateProducer 3.0',
  'XMP-dc:Creator': 'Flate XMP Creator', 'XMP-dc:Title': 'Flate Secret Title', 'XMP-xmp:CreatorTool': 'FlateTool 4.2', 'XMP-photoshop:City': 'Flate City',
}, { location: ['XMP-photoshop:City'], keep: { 'PDF:PageCount': 1 }, rawStrings: ['Jane Fixture', 'Fixture Secret Report', 'FixtureWriter 1.0', 'Fixture subject', 'Quartz PDFContext'],
  notes: 'doc.pdf + incremental update: new Info + FlateDecode XMP stream with an indirect /Length (P3); first-revision values only visible to a byte scan' });

// P4: report.pdf is doc.pdf + annotation author, attachment, form, JavaScript, signature (reported, NOT removed: the copy is "Not fully clean").
files['report.pdf'] = entry('pdf', 'pdf-blanked-ranges', {
  'PDF:Title': 'Fixture Secret Report', 'PDF:Author': 'Jane Fixture', 'PDF:Subject': 'Fixture subject', 'PDF:Creator': 'FixtureWriter 1.0',
  'PDF:Keywords': ['fixture', 'secret'], 'PDF:Producer': dumpOf('doc.pdf')['PDF:Producer'], ...pdfDates,
}, { keep: { 'PDF:PageCount': 1 }, notes: 'doc.pdf + incremental update with a comment author (Reviewer Fixture), an attached file, AcroForm, JavaScript and a signature dictionary. The cleaner reports the author and the attachment and does not remove them, so the result is never "clean" (P3-2)' });
files['encrypted.pdf'] = entry('pdf', 'none', {}, { supported: false, notes: 'Real password-protected PDF (CoreGraphics, user password "fixture"): must be declined, never called clean' });

writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
  referee: 'ExifTool 13.59 via exiftool-vendored.pl 13.59.3: exiftool -a -G1 -ee3 -u -j (scripts/exif-check.sh)',
  note: 'Generated by scripts/fixtures/make-manifest.mjs. Keys are ExifTool "Group:Tag"; values are exactly what ExifTool prints for the INPUT file.',
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
}, null, 2) + '\n');
console.log(`wrote manifest.json (${Object.keys(files).length} files)`);
