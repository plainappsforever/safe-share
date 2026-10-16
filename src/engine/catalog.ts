/**
 * Field catalogue: raw tag -> human name, group and sensitivity (SPEC F2). Anything not listed here
 * is an "Other" field (known = false): shown as "Other (N fields)" and removed by every profile
 * except where noted in profiles.ts.
 */

export type Group = 'location' | 'datetime' | 'device' | 'camera' | 'people' | 'software' | 'technical' | 'extras' | 'other';
export type Sensitivity = 'high' | 'medium' | 'low' | 'none';
export type Source = 'exif' | 'xmp' | 'iptc' | 'png' | 'jpeg' | 'icc' | 'heif' | 'webp' | 'trailer' | 'qt' | 'pdf' | 'tiff' | 'gif';

export interface Field {
  /** `${source}:${key}`, e.g. `exif:GPSLatitude`, `xmp:dc:creator`, `iptc:City`, `png:Author`. */
  id: string;
  source: Source;
  /** Raw tag name shown small under the human name. */
  key: string;
  name: string;
  group: Group;
  sensitivity: Sensitivity;
  /** In the catalogue (false = "Other"). */
  known: boolean;
  /** Display value (may be shortened). */
  value: string;
  /** Exact text values as stored in the file, used by the signature scan after cleaning. */
  needles: string[];
  /** Exact binary values (e.g. GPS rationals) used by the signature scan. */
  binNeedles?: Uint8Array[];
}

type Entry = [name: string, group: Group, sensitivity?: Sensitivity];

const DEFAULT_SENS: Record<Group, Sensitivity> = {
  location: 'high',
  datetime: 'medium',
  device: 'medium',
  camera: 'low',
  people: 'high',
  software: 'medium',
  technical: 'none',
  extras: 'medium',
  other: 'medium',
};

/** Exif/TIFF tags of IFD0, the Exif IFD and the Interop IFD by number: [key, name, group, sensitivity]. */
export const EXIF_TAGS: Record<number, [string, ...Entry]> = {
  0x000b: ['ProcessingSoftware', 'Processing software', 'software'],
  0x0100: ['ImageWidth', 'Image width', 'technical'],
  0x0101: ['ImageHeight', 'Image height', 'technical'],
  0x0102: ['BitsPerSample', 'Bits per sample', 'technical'],
  0x0103: ['Compression', 'Compression', 'technical'],
  0x0106: ['PhotometricInterpretation', 'Colour model', 'technical'],
  0x010d: ['DocumentName', 'Document name', 'people'],
  0x010e: ['ImageDescription', 'Description', 'people'],
  0x010f: ['Make', 'Camera or phone make', 'device'],
  0x0110: ['Model', 'Camera or phone model', 'device'],
  0x0112: ['Orientation', 'Orientation', 'technical'],
  0x0115: ['SamplesPerPixel', 'Samples per pixel', 'technical'],
  0x011a: ['XResolution', 'Horizontal resolution', 'technical'],
  0x011b: ['YResolution', 'Vertical resolution', 'technical'],
  0x011c: ['PlanarConfiguration', 'Planar configuration', 'technical'],
  0x011d: ['PageName', 'Page name', 'people'],
  0x0128: ['ResolutionUnit', 'Resolution unit', 'technical'],
  0x0131: ['Software', 'Software', 'software'],
  0x0132: ['ModifyDate', 'Date modified', 'datetime'],
  0x013b: ['Artist', 'Artist / author', 'people'],
  0x013c: ['HostComputer', 'Computer name', 'device', 'high'],
  0x013e: ['WhitePoint', 'White point', 'technical'],
  0x013f: ['PrimaryChromaticities', 'Primary chromaticities', 'technical'],
  0x0201: ['ThumbnailOffset', 'Preview image', 'extras'],
  0x0202: ['ThumbnailLength', 'Preview image size', 'extras'],
  0x0211: ['YCbCrCoefficients', 'YCbCr coefficients', 'technical'],
  0x0212: ['YCbCrSubSampling', 'YCbCr subsampling', 'technical'],
  0x0213: ['YCbCrPositioning', 'YCbCr positioning', 'technical'],
  0x0214: ['ReferenceBlackWhite', 'Reference black/white', 'technical'],
  0x02bc: ['ApplicationNotes', 'Embedded XMP', 'other'],
  0x4746: ['Rating', 'Rating', 'people', 'low'],
  0x4749: ['RatingPercent', 'Rating', 'people', 'low'],
  0x8298: ['Copyright', 'Copyright', 'people'],
  0x829a: ['ExposureTime', 'Exposure time', 'camera'],
  0x829d: ['FNumber', 'Aperture (f-number)', 'camera'],
  0x83bb: ['IPTC-NAA', 'Embedded IPTC', 'other'],
  0x8773: ['ICC_Profile', 'Colour profile', 'technical'],
  0x8822: ['ExposureProgram', 'Exposure program', 'camera'],
  0x8824: ['SpectralSensitivity', 'Spectral sensitivity', 'camera'],
  0x8827: ['ISO', 'ISO', 'camera'],
  0x8830: ['SensitivityType', 'Sensitivity type', 'camera'],
  0x8831: ['StandardOutputSensitivity', 'Standard output sensitivity', 'camera'],
  0x8832: ['RecommendedExposureIndex', 'Recommended exposure index', 'camera'],
  0x9000: ['ExifVersion', 'Exif version', 'technical'],
  0x9003: ['DateTimeOriginal', 'Date and time taken', 'datetime'],
  0x9004: ['CreateDate', 'Date and time digitised', 'datetime'],
  0x9010: ['OffsetTime', 'Time zone (modified)', 'datetime'],
  0x9011: ['OffsetTimeOriginal', 'Time zone (taken)', 'datetime'],
  0x9012: ['OffsetTimeDigitized', 'Time zone (digitised)', 'datetime'],
  0x9101: ['ComponentsConfiguration', 'Components configuration', 'technical'],
  0x9102: ['CompressedBitsPerPixel', 'Compressed bits per pixel', 'technical'],
  0x9201: ['ShutterSpeedValue', 'Shutter speed', 'camera'],
  0x9202: ['ApertureValue', 'Aperture', 'camera'],
  0x9203: ['BrightnessValue', 'Brightness', 'camera'],
  0x9204: ['ExposureCompensation', 'Exposure compensation', 'camera'],
  0x9205: ['MaxApertureValue', 'Maximum aperture', 'camera'],
  0x9206: ['SubjectDistance', 'Subject distance', 'camera'],
  0x9207: ['MeteringMode', 'Metering mode', 'camera'],
  0x9208: ['LightSource', 'Light source', 'camera'],
  0x9209: ['Flash', 'Flash', 'camera'],
  0x920a: ['FocalLength', 'Focal length', 'camera'],
  0x9214: ['SubjectArea', 'Subject area', 'camera'],
  0x927c: ['MakerNote', 'Maker notes (camera-specific data)', 'extras', 'high'],
  0x9286: ['UserComment', 'User comment', 'people'],
  0x9290: ['SubSecTime', 'Sub-second time (modified)', 'datetime', 'low'],
  0x9291: ['SubSecTimeOriginal', 'Sub-second time (taken)', 'datetime', 'low'],
  0x9292: ['SubSecTimeDigitized', 'Sub-second time (digitised)', 'datetime', 'low'],
  0x9400: ['AmbientTemperature', 'Temperature', 'camera'],
  0x9401: ['Humidity', 'Humidity', 'camera'],
  0x9402: ['Pressure', 'Air pressure', 'camera'],
  0x9403: ['WaterDepth', 'Water depth', 'location'],
  0x9404: ['Acceleration', 'Acceleration', 'camera'],
  0x9405: ['CameraElevationAngle', 'Camera elevation angle', 'camera'],
  0x9c9b: ['XPTitle', 'Title (Windows)', 'people'],
  0x9c9c: ['XPComment', 'Comment (Windows)', 'people'],
  0x9c9d: ['XPAuthor', 'Author (Windows)', 'people'],
  0x9c9e: ['XPKeywords', 'Keywords (Windows)', 'people'],
  0x9c9f: ['XPSubject', 'Subject (Windows)', 'people'],
  0xa000: ['FlashpixVersion', 'Flashpix version', 'technical'],
  0xa001: ['ColorSpace', 'Colour space', 'technical'],
  0xa002: ['ExifImageWidth', 'Image width', 'technical'],
  0xa003: ['ExifImageHeight', 'Image height', 'technical'],
  0xa004: ['RelatedSoundFile', 'Related sound file', 'people'],
  0xa20b: ['FlashEnergy', 'Flash energy', 'camera'],
  0xa20e: ['FocalPlaneXResolution', 'Focal plane X resolution', 'camera'],
  0xa20f: ['FocalPlaneYResolution', 'Focal plane Y resolution', 'camera'],
  0xa210: ['FocalPlaneResolutionUnit', 'Focal plane resolution unit', 'camera'],
  0xa214: ['SubjectLocation', 'Subject position in the picture', 'camera'],
  0xa215: ['ExposureIndex', 'Exposure index', 'camera'],
  0xa217: ['SensingMethod', 'Sensing method', 'camera'],
  0xa300: ['FileSource', 'File source', 'technical'],
  0xa301: ['SceneType', 'Scene type', 'camera'],
  0xa302: ['CFAPattern', 'Colour filter pattern', 'camera'],
  0xa401: ['CustomRendered', 'Custom rendered', 'camera'],
  0xa402: ['ExposureMode', 'Exposure mode', 'camera'],
  0xa403: ['WhiteBalance', 'White balance', 'camera'],
  0xa404: ['DigitalZoomRatio', 'Digital zoom', 'camera'],
  0xa405: ['FocalLengthIn35mmFormat', 'Focal length (35 mm equivalent)', 'camera'],
  0xa406: ['SceneCaptureType', 'Scene type', 'camera'],
  0xa407: ['GainControl', 'Gain control', 'camera'],
  0xa408: ['Contrast', 'Contrast', 'camera'],
  0xa409: ['Saturation', 'Saturation', 'camera'],
  0xa40a: ['Sharpness', 'Sharpness', 'camera'],
  0xa40b: ['DeviceSettingDescription', 'Device settings', 'camera'],
  0xa40c: ['SubjectDistanceRange', 'Subject distance range', 'camera'],
  0xa420: ['ImageUniqueID', 'Unique image ID', 'device', 'high'],
  0xa430: ['OwnerName', 'Camera owner name', 'people'],
  0xa431: ['SerialNumber', 'Camera serial number', 'device', 'high'],
  0xa432: ['LensInfo', 'Lens specification', 'camera'],
  0xa433: ['LensMake', 'Lens make', 'camera'],
  0xa434: ['LensModel', 'Lens model', 'camera'],
  0xa435: ['LensSerialNumber', 'Lens serial number', 'device', 'high'],
  0xa436: ['ImageTitle', 'Image title', 'people'],
  0xa437: ['Photographer', 'Photographer', 'people'],
  0xa438: ['ImageEditor', 'Image editor', 'people'],
  0xa439: ['CameraFirmware', 'Camera firmware', 'device'],
  0xa43a: ['RAWDevelopingSoftware', 'RAW developing software', 'software'],
  0xa43b: ['ImageEditingSoftware', 'Image editing software', 'software'],
  0xa43c: ['MetadataEditingSoftware', 'Metadata editing software', 'software'],
  0xa460: ['CompositeImage', 'Composite image', 'technical'],
  0xa461: ['CompositeImageCount', 'Composite image count', 'technical'],
  0xa462: ['CompositeImageExposureTimes', 'Composite exposure times', 'camera'],
  0xa500: ['Gamma', 'Gamma', 'technical'],
  0xc4a5: ['PrintIM', 'Print settings', 'other'],
  0xea1c: ['Padding', 'Padding', 'technical'],
  0xea1d: ['OffsetSchema', 'Offset schema', 'technical'],
  // V1.5-1: TIFF, DNG and GeoTIFF tags that carry personal data (picture tags of a TIFF file are in tiff-file.ts, not here).
  0x0151: ['TargetPrinter', 'Printer name', 'device'],
  0x800d: ['ImageID', 'Image ID', 'other'],
  0x8649: ['PhotoshopSettings', 'Photoshop data', 'other'],
  0x830e: ['ModelPixelScaleTag', 'Map scale (GeoTIFF)', 'location'],
  0x8482: ['ModelTiepointTag', 'Map position (GeoTIFF)', 'location'],
  0x85d8: ['ModelTransformationTag', 'Map position (GeoTIFF)', 'location'],
  0x87af: ['GeoKeyDirectoryTag', 'Map projection (GeoTIFF)', 'location'],
  0x87b0: ['GeoDoubleParamsTag', 'Map projection values (GeoTIFF)', 'location'],
  0x87b1: ['GeoAsciiParamsTag', 'Map projection names (GeoTIFF)', 'location'],
  0x9211: ['ImageNumber', 'Image number', 'device', 'low'],
  0x9213: ['ImageHistory', 'Image history', 'software'],
  0x935c: ['ImageSourceData', 'Photoshop layer data', 'extras'],
  0xa480: ['GDALMetadata', 'GDAL metadata', 'other'],
  0xc614: ['UniqueCameraModel', 'Camera or phone model (DNG)', 'device'],
  0xc615: ['LocalizedCameraModel', 'Camera or phone model (DNG)', 'device'],
  0xc62f: ['CameraSerialNumber', 'Camera serial number', 'device', 'high'],
  0xc630: ['DNGLensInfo', 'Lens specification', 'camera'],
  0xc634: ['DNGPrivateData', 'Private camera data (DNG)', 'extras', 'high'],
  0xc65d: ['RawDataUniqueID', 'Unique RAW ID', 'device', 'high'],
  0xc68b: ['OriginalRawFileName', 'Original file name', 'people'],
  0xc68c: ['OriginalRawFileData', 'Embedded original RAW file', 'extras', 'high'],
  0xc716: ['PreviewApplicationName', 'Preview made by', 'software'],
  0xc717: ['PreviewApplicationVersion', 'Preview app version', 'software'],
  0xc718: ['PreviewSettingsName', 'Preview settings name', 'software'],
  0xc71b: ['PreviewDateTime', 'Preview date', 'datetime'],
  0xc71d: ['OriginalRawFileDigest', 'Original file checksum', 'technical'],
  0xc763: ['TimeCodes', 'Time codes', 'datetime'],
  0xc772: ['TStop', 'T-stop', 'camera'],
  0xc789: ['ReelName', 'Reel name', 'people'],
  0xc7a1: ['CameraLabel', 'Camera label', 'people'],
  // V1.5-1 fix round (review M1): text and IDs that sat on the picture-tag list. None of them is needed to decode the picture.
  0x011e: ['XPosition', 'Position on the page (horizontal)', 'technical'],
  0x011f: ['YPosition', 'Position on the page (vertical)', 'technical'],
  0x0129: ['PageNumber', 'Page number', 'technical'],
  0x014d: ['InkNames', 'Ink names', 'people', 'low'],
  0xc635: ['MakerNoteSafety', 'Maker-note safety flag', 'technical'],
  0xc6f3: ['CameraCalibrationSig', 'Camera calibration name', 'software'],
  0xc6f4: ['ProfileCalibrationSig', 'Colour profile calibration name', 'software'],
  0xc6f5: ['ExtraCameraProfiles', 'Extra camera colour profiles', 'extras'],
  0xc6f6: ['AsShotProfileName', 'Colour profile name (as shot)', 'software'],
  0xc6f8: ['ProfileName', 'Colour profile name', 'software'],
  0xc6fe: ['ProfileCopyright', 'Colour profile copyright', 'people'],
  0xc719: ['PreviewSettingsDigest', 'Preview settings checksum', 'software', 'low'],
  0xc7ee: ['EnhanceParams', 'Enhancement settings', 'software'],
  0xcd41: ['JUMBF', 'Content credentials (C2PA)', 'extras', 'high'],
  0xcd44: ['ImageSequenceInfo', 'Burst / sequence ID', 'device', 'high'],
  0xcd48: ['ProfileGroupName', 'Colour profile group name', 'software'],
  0xcea1: ['SEAL', 'Content signature (SEAL)', 'extras', 'high'],
  // Interop IFD
  0x0001: ['InteropIndex', 'Interoperability index', 'technical'],
  0x0002: ['InteropVersion', 'Interoperability version', 'technical'],
  0x1000: ['RelatedImageFileFormat', 'Related image format', 'technical'],
  0x1001: ['RelatedImageWidth', 'Related image width', 'technical'],
  0x1002: ['RelatedImageHeight', 'Related image height', 'technical'],
};

/** GPS IFD: every tag is location. */
export const GPS_TAGS: Record<number, [string, string]> = {
  0x00: ['GPSVersionID', 'GPS version'],
  0x01: ['GPSLatitudeRef', 'Latitude reference'],
  0x02: ['GPSLatitude', 'Latitude'],
  0x03: ['GPSLongitudeRef', 'Longitude reference'],
  0x04: ['GPSLongitude', 'Longitude'],
  0x05: ['GPSAltitudeRef', 'Altitude reference'],
  0x06: ['GPSAltitude', 'Altitude'],
  0x07: ['GPSTimeStamp', 'GPS time'],
  0x08: ['GPSSatellites', 'GPS satellites'],
  0x09: ['GPSStatus', 'GPS status'],
  0x0a: ['GPSMeasureMode', 'GPS measure mode'],
  0x0b: ['GPSDOP', 'GPS precision'],
  0x0c: ['GPSSpeedRef', 'Speed unit'],
  0x0d: ['GPSSpeed', 'Speed'],
  0x0e: ['GPSTrackRef', 'Direction of travel reference'],
  0x0f: ['GPSTrack', 'Direction of travel'],
  0x10: ['GPSImgDirectionRef', 'Camera direction reference'],
  0x11: ['GPSImgDirection', 'Camera direction'],
  0x12: ['GPSMapDatum', 'Map datum'],
  0x13: ['GPSDestLatitudeRef', 'Destination latitude reference'],
  0x14: ['GPSDestLatitude', 'Destination latitude'],
  0x15: ['GPSDestLongitudeRef', 'Destination longitude reference'],
  0x16: ['GPSDestLongitude', 'Destination longitude'],
  0x17: ['GPSDestBearingRef', 'Destination bearing reference'],
  0x18: ['GPSDestBearing', 'Destination bearing'],
  0x19: ['GPSDestDistanceRef', 'Destination distance unit'],
  0x1a: ['GPSDestDistance', 'Destination distance'],
  0x1b: ['GPSProcessingMethod', 'Location method'],
  0x1c: ['GPSAreaInformation', 'Area information'],
  0x1d: ['GPSDateStamp', 'GPS date'],
  0x1e: ['GPSDifferential', 'GPS differential'],
  0x1f: ['GPSHPositioningError', 'GPS accuracy'],
};

const EXIF_BY_NAME = new Map<string, Entry>();
for (const [, [key, name, group, sens]] of Object.entries(EXIF_TAGS)) EXIF_BY_NAME.set(key, [name, group, sens]);
for (const [, [key, name]] of Object.entries(GPS_TAGS)) EXIF_BY_NAME.set(key, [name, 'location']);
// XMP spellings of the same Exif properties.
const EXIF_ALIASES: Record<string, string> = {
  BodySerialNumber: 'SerialNumber',
  CameraOwnerName: 'OwnerName',
  PhotographicSensitivity: 'ISO',
  ISOSpeedRatings: 'ISO',
  LensSpecification: 'LensInfo',
  DateTimeOriginal: 'DateTimeOriginal',
  DateTimeDigitized: 'CreateDate',
  DateTime: 'ModifyDate',
  PixelXDimension: 'ExifImageWidth',
  PixelYDimension: 'ExifImageHeight',
  ImageLength: 'ImageHeight',
  GPSDateTime: 'GPSTimeStamp',
  Lens: 'LensModel',
  Firmware: 'CameraFirmware',
  ImageNumber: 'ImageUniqueID',
  ExposureBiasValue: 'ExposureCompensation',
  FocalLengthIn35mmFilm: 'FocalLengthIn35mmFormat',
};

/** XMP properties that are not plain Exif mirrors, keyed `prefix:Name` with canonical prefixes. */
const XMP_TABLE: Record<string, Entry> = {
  'dc:creator': ['Creator / author', 'people'],
  'dc:rights': ['Copyright', 'people'],
  'dc:description': ['Description', 'people'],
  'dc:title': ['Title', 'people'],
  'dc:subject': ['Keywords', 'people'],
  'dc:contributor': ['Contributors', 'people'],
  'dc:publisher': ['Publisher', 'people'],
  'dc:format': ['File format', 'technical'],
  'xmp:CreatorTool': ['Editing app', 'software'],
  'xmp:CreateDate': ['Date created', 'datetime'],
  'xmp:ModifyDate': ['Date modified', 'datetime'],
  'xmp:MetadataDate': ['Metadata date', 'datetime'],
  'xmp:Rating': ['Rating', 'people', 'low'],
  'xmp:Label': ['Label', 'people', 'low'],
  'xmpRights:Marked': ['Copyrighted', 'people', 'low'],
  'xmpRights:WebStatement': ['Copyright web page', 'people'],
  'xmpRights:UsageTerms': ['Usage terms', 'people'],
  'xmpRights:Owner': ['Rights owner', 'people'],
  'photoshop:City': ['City', 'location'],
  'photoshop:State': ['State / province', 'location'],
  'photoshop:Country': ['Country', 'location'],
  'photoshop:DateCreated': ['Date created', 'datetime'],
  'photoshop:Credit': ['Credit', 'people'],
  'photoshop:Source': ['Source', 'people'],
  'photoshop:Headline': ['Headline', 'people'],
  'photoshop:Instructions': ['Instructions', 'people'],
  'photoshop:AuthorsPosition': ['Author title', 'people'],
  'photoshop:CaptionWriter': ['Caption writer', 'people'],
  'photoshop:TransmissionReference': ['Job reference', 'people'],
  'photoshop:ColorMode': ['Colour mode', 'technical'],
  'photoshop:ICCProfile': ['Colour profile name', 'technical'],
  'Iptc4xmpCore:Location': ['Sub-location', 'location'],
  'Iptc4xmpCore:CountryCode': ['Country code', 'location'],
  'Iptc4xmpCore:CreatorContactInfo': ['Creator contact details', 'people'],
  'Iptc4xmpCore:IntellectualGenre': ['Genre', 'people', 'low'],
  'Iptc4xmpCore:Scene': ['Scene', 'people', 'low'],
  'Iptc4xmpCore:SubjectCode': ['Subject code', 'people', 'low'],
  'Iptc4xmpExt:LocationCreated': ['Location created', 'location'],
  'Iptc4xmpExt:LocationShown': ['Location shown', 'location'],
  'Iptc4xmpExt:PersonInImage': ['People in the photo', 'people'],
  'aux:SerialNumber': ['Camera serial number', 'device', 'high'],
  'aux:LensSerialNumber': ['Lens serial number', 'device', 'high'],
  'aux:OwnerName': ['Camera owner name', 'people'],
  'aux:LensID': ['Lens ID', 'camera'],
  'aux:ApproximateFocusDistance': ['Focus distance', 'camera'],
  'xmpNote:HasExtendedXMP': ['Extended XMP block', 'extras'],
  'pdf:Producer': ['PDF producer app', 'software'],
  'pdf:Keywords': ['Keywords', 'people'],
  'pdf:PDFVersion': ['PDF version', 'technical'],
  'pdf:Trapped': ['Trapping', 'technical'],
};

/** Namespace URI -> canonical prefix (files may use any prefix). */
export const XMP_NAMESPACES: Record<string, string> = {
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://ns.adobe.com/xap/1.0/': 'xmp',
  'http://ns.adobe.com/xap/1.0/mm/': 'xmpMM',
  'http://ns.adobe.com/xap/1.0/rights/': 'xmpRights',
  'http://ns.adobe.com/xap/1.0/bj/': 'xmpBJ',
  'http://ns.adobe.com/exif/1.0/': 'exif',
  'http://cipa.jp/exif/1.0/': 'exifEX',
  'http://ns.adobe.com/tiff/1.0/': 'tiff',
  'http://ns.adobe.com/exif/1.0/aux/': 'aux',
  'http://ns.adobe.com/photoshop/1.0/': 'photoshop',
  'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/': 'Iptc4xmpCore',
  'http://iptc.org/std/Iptc4xmpExt/2008-02-29/': 'Iptc4xmpExt',
  'http://ns.adobe.com/camera-raw-settings/1.0/': 'crs',
  'http://ns.adobe.com/lightroom/1.0/': 'lr',
  'http://ns.adobe.com/xmp/note/': 'xmpNote',
  'http://ns.google.com/photos/1.0/camera/': 'GCamera',
  'http://ns.google.com/photos/1.0/container/': 'Container',
  'http://ns.google.com/photos/1.0/container/item/': 'Item',
  'http://ns.google.com/photos/1.0/image/': 'GImage',
  'http://ns.google.com/photos/1.0/depthmap/': 'GDepth',
  'http://ns.google.com/photos/1.0/panorama/': 'GPano',
  'http://ns.adobe.com/hdr-gain-map/1.0/': 'hdrgm',
  'http://www.dji.com/drone-dji/1.0/': 'drone-dji',
  'http://ns.microsoft.com/photo/1.0/': 'MicrosoftPhoto',
  'http://ns.adobe.com/pdf/1.3/': 'pdf',
};

const EXTRAS_PREFIXES: Record<string, string> = {
  GCamera: 'Motion-photo / camera app data',
  Container: 'Embedded image or video directory',
  Item: 'Embedded image or video directory',
  GImage: 'Embedded depth or portrait image',
  GDepth: 'Embedded depth map',
  hdrgm: 'HDR brightness data',
};

function heuristicGroup(local: string): Group {
  if (/gps|latitude|longitude|altitude|location|geo|place|city|country/i.test(local)) return 'location';
  // P4-9 (V1.5-1 #13): an e-mail address or phone number is about a person even when the name also says "owner" or "device".
  if (/e-?mail|phone|contact/i.test(local)) return 'people';
  if (/serial|imei|device|owner/i.test(local)) return 'device';
  if (/author|creator|artist|copyright|email|phone|name|person|contact/i.test(local)) return 'people';
  if (/date|time/i.test(local)) return 'datetime';
  return 'other';
}

export interface Described {
  name: string;
  group: Group;
  sensitivity: Sensitivity;
  known: boolean;
}

function described(e: Entry | undefined, fallbackName: string, fallbackGroup: Group = 'other'): Described {
  if (e) return { name: e[0], group: e[1], sensitivity: e[2] ?? DEFAULT_SENS[e[1]], known: true };
  return { name: fallbackName, group: fallbackGroup, sensitivity: DEFAULT_SENS[fallbackGroup], known: false };
}

/** Exif/TIFF tag in a given IFD. */
export function describeExif(ifd: 'IFD0' | 'ExifIFD' | 'GPS' | 'Interop' | 'IFD1', tag: number): Described & { key: string } {
  if (ifd === 'GPS') {
    const g = GPS_TAGS[tag];
    const key = g ? g[0] : `GPSTag0x${tag.toString(16).padStart(4, '0')}`;
    return { key, name: g ? g[1] : 'Other GPS data', group: 'location', sensitivity: 'high', known: !!g };
  }
  if (ifd === 'IFD1') {
    const e = EXIF_TAGS[tag];
    return { key: `IFD1:${e ? e[0] : `Tag0x${tag.toString(16)}`}`, name: 'Hidden preview image', group: 'extras', sensitivity: 'medium', known: true };
  }
  const e = EXIF_TAGS[tag];
  const key = e ? e[0] : `Tag0x${tag.toString(16).padStart(4, '0')}`;
  return { key, ...described(e ? [e[1], e[2], e[3]] : undefined, `Unknown tag 0x${tag.toString(16).padStart(4, '0')}`) };
}

/** XMP property by canonical prefix and local name. */
export function describeXmp(prefix: string, local: string): Described {
  const key = `${prefix}:${local}`;
  const direct = XMP_TABLE[key];
  if (direct) return described(direct, key);
  if (prefix === 'exif' || prefix === 'exifEX' || prefix === 'tiff' || prefix === 'aux') {
    const e = EXIF_BY_NAME.get(EXIF_ALIASES[local] ?? local);
    if (e) return described(e, key);
  }
  if (prefix === 'xmpMM') return { name: 'Editing history', group: 'software', sensitivity: 'medium', known: true };
  if (prefix === 'crs') return { name: 'Photo editing settings', group: 'software', sensitivity: 'low', known: true };
  if (prefix === 'lr') return { name: 'Lightroom keywords', group: 'people', sensitivity: 'medium', known: true };
  if (EXTRAS_PREFIXES[prefix]) return { name: EXTRAS_PREFIXES[prefix], group: 'extras', sensitivity: 'medium', known: true };
  if (prefix === 'drone-dji') {
    const g = heuristicGroup(local);
    return { name: `Drone data (${local})`, group: g === 'other' ? 'device' : g, sensitivity: 'high', known: true };
  }
  // P4-9: a name nobody catalogued is shown as what it is, with the raw name, instead of looking like a known field.
  return described(undefined, `Unknown field "${local}"`, heuristicGroup(local));
}

/** IPTC IIM record 2 datasets. */
export const IPTC_TAGS: Record<number, [string, ...Entry]> = {
  0: ['ApplicationRecordVersion', 'IPTC version', 'technical'],
  5: ['ObjectName', 'Title', 'people'],
  7: ['EditStatus', 'Edit status', 'people', 'low'],
  10: ['Urgency', 'Urgency', 'people', 'low'],
  12: ['SubjectReference', 'Subject reference', 'people', 'low'],
  15: ['Category', 'Category', 'people', 'low'],
  20: ['SupplementalCategories', 'Supplemental categories', 'people', 'low'],
  25: ['Keywords', 'Keywords', 'people'],
  26: ['ContentLocationCode', 'Location code', 'location'],
  27: ['ContentLocationName', 'Location name', 'location'],
  30: ['ReleaseDate', 'Release date', 'datetime'],
  35: ['ReleaseTime', 'Release time', 'datetime'],
  40: ['SpecialInstructions', 'Instructions', 'people'],
  55: ['DateCreated', 'Date created', 'datetime'],
  60: ['TimeCreated', 'Time created', 'datetime'],
  62: ['DigitalCreationDate', 'Digital creation date', 'datetime'],
  63: ['DigitalCreationTime', 'Digital creation time', 'datetime'],
  65: ['OriginatingProgram', 'Program', 'software'],
  70: ['ProgramVersion', 'Program version', 'software'],
  80: ['By-line', 'Author (by-line)', 'people'],
  85: ['By-lineTitle', 'Author title', 'people'],
  90: ['City', 'City', 'location'],
  92: ['Sub-location', 'Sub-location', 'location'],
  95: ['Province-State', 'State / province', 'location'],
  100: ['Country-PrimaryLocationCode', 'Country code', 'location'],
  101: ['Country-PrimaryLocationName', 'Country', 'location'],
  103: ['OriginalTransmissionReference', 'Job reference', 'people'],
  105: ['Headline', 'Headline', 'people'],
  110: ['Credit', 'Credit', 'people'],
  115: ['Source', 'Source', 'people'],
  116: ['CopyrightNotice', 'Copyright', 'people'],
  118: ['Contact', 'Contact', 'people'],
  120: ['Caption-Abstract', 'Caption', 'people'],
  122: ['Writer-Editor', 'Caption writer', 'people'],
};

export function describeIptc(record: number, dataset: number): Described & { key: string } {
  if (record === 1 && dataset === 90) return { key: 'CodedCharacterSet', name: 'Character set', group: 'technical', sensitivity: 'none', known: true };
  if (record === 2) {
    const e = IPTC_TAGS[dataset];
    if (e) return { key: e[0], ...described([e[1], e[2], e[3]], e[0]) };
  }
  const key = `${record}:${dataset}`;
  return { key, ...described(undefined, `IPTC ${key}`) };
}

/** PNG text keywords (tEXt/zTXt/iTXt), PNG 3 §11.3.3.2 plus common extras. */
const PNG_KEYWORDS: Record<string, Entry> = {
  Title: ['Title', 'people'],
  Author: ['Author', 'people'],
  Description: ['Description', 'people'],
  Copyright: ['Copyright', 'people'],
  'Creation Time': ['Date created', 'datetime'],
  Software: ['Software', 'software'],
  Disclaimer: ['Disclaimer', 'people', 'low'],
  Warning: ['Warning', 'people', 'low'],
  Source: ['Source device', 'device'],
  Comment: ['Comment', 'people'],
};

export function describePngText(keyword: string): Described {
  return described(PNG_KEYWORDS[keyword], `Text "${keyword}"`, heuristicGroup(keyword));
}

/** QuickTime metadata keys (`mdta` handler; Apple and Android spellings), by the part after the reverse-DNS prefix. */
const QT_KEYS: Record<string, Entry> = {
  'location.ISO6709': ['Location (coordinates)', 'location'],
  'location.name': ['Place name', 'location'],
  'location.body': ['Location body', 'location', 'low'],
  'location.note': ['Location note', 'location'],
  'location.role': ['Location role', 'location', 'low'],
  'location.date': ['Location date', 'location'],
  'location.accuracy.horizontal': ['Location accuracy', 'location'],
  'location.accuracy.vertical': ['Location accuracy', 'location'],
  make: ['Camera or phone make', 'device'],
  manufacturer: ['Camera or phone make', 'device'],
  model: ['Camera or phone model', 'device'],
  software: ['Software', 'software'],
  version: ['Software version', 'software'],
  creationdate: ['Date and time recorded', 'datetime'],
  author: ['Author', 'people'],
  artist: ['Artist', 'people'],
  displayname: ['Title', 'people'],
  title: ['Title', 'people'],
  description: ['Description', 'people'],
  comment: ['Comment', 'people'],
  keywords: ['Keywords', 'people'],
  copyright: ['Copyright', 'people'],
  information: ['Information', 'people'],
  publisher: ['Publisher', 'people'],
  'content.identifier': ['Live Photo pairing ID', 'device', 'low'],
  'camera.identifier': ['Camera identifier', 'camera'],
  'camera.lens_model': ['Lens model', 'camera'],
  'camera.focal_length.35mm_equivalent': ['Focal length (35 mm)', 'camera'],
  'capture.fps': ['Recording frame rate', 'technical'],
  'full-frame-rate-playback-intent': ['Playback frame rate', 'technical'],
};

export function describeQtKey(key: string): Described {
  const short = key.replace(/^com\.(apple\.quicktime|android)\./, '');
  return described(QT_KEYS[short], `Key "${key}"`, heuristicGroup(short));
}

/** QuickTime/MP4 user-data atoms (udta, iTunes-style ilst), ISO 14496-12 / 3GPP TS 26.244. */
const QT_ATOMS: Record<string, Entry> = {
  '©xyz': ['Location (coordinates)', 'location'],
  loci: ['Location', 'location'],
  '©day': ['Date recorded', 'datetime'],
  date: ['Date recorded', 'datetime'],
  '©mak': ['Camera or phone make', 'device'],
  '©mod': ['Camera or phone model', 'device'],
  '©swr': ['Software', 'software'],
  '©too': ['Encoder app', 'software'],
  '©enc': ['Encoded by', 'software'],
  '©fmt': ['Format', 'technical'],
  '©nam': ['Title', 'people'],
  titl: ['Title', 'people'],
  '©ART': ['Artist', 'people'],
  '©aut': ['Author', 'people'],
  auth: ['Author', 'people'],
  perf: ['Performer', 'people'],
  '©cmt': ['Comment', 'people'],
  '©des': ['Description', 'people'],
  dscp: ['Description', 'people'],
  desc: ['Description', 'people'],
  '©inf': ['Information', 'people'],
  '©cpy': ['Copyright', 'people'],
  cprt: ['Copyright', 'people'],
  '©alb': ['Album', 'people', 'low'],
  albm: ['Album', 'people', 'low'],
  '©gen': ['Genre', 'people', 'low'],
  gnre: ['Genre', 'people', 'low'],
  kywd: ['Keywords', 'people'],
  '©key': ['Keywords', 'people'],
  rtng: ['Rating', 'people', 'low'],
  yrrc: ['Recording year', 'datetime'],
  clsf: ['Classification', 'people', 'low'],
  coll: ['Collection', 'people', 'low'],
  XMP_: ['XMP block', 'other'],
};

export function describeQtAtom(type: string): Described {
  return described(QT_ATOMS[type], `Atom "${type}"`, heuristicGroup(type));
}

/** PDF document information dictionary (ISO 32000-1 §14.3.3). Custom keys are "Other". */
const PDF_INFO: Record<string, Entry> = {
  Title: ['Document title', 'people'],
  Author: ['Document author', 'people'],
  Subject: ['Subject', 'people'],
  Keywords: ['Keywords', 'people'],
  Creator: ['Creating app', 'software'],
  Producer: ['PDF producer app', 'software'],
  CreationDate: ['Date created', 'datetime'],
  ModDate: ['Date modified', 'datetime'],
  Trapped: ['Trapping', 'technical'],
};

export function describePdfInfo(key: string): Described {
  return described(PDF_INFO[key], `Custom "${key}"`, heuristicGroup(key));
}

export function makeField(source: Source, key: string, d: Described, value: string, needles: string[] = [], binNeedles?: Uint8Array[]): Field {
  return { id: `${source}:${key}`, source, key, name: d.name, group: d.group, sensitivity: d.sensitivity, known: d.known, value, needles, binNeedles };
}

/** Plain-language findings summary (SPEC F2); colour: red / orange / grey. No score. */
export interface Finding {
  id: string;
  label: string;
  level: 'red' | 'orange' | 'grey';
}

export function summarize(fields: Field[]): Finding[] {
  const out: Finding[] = [];
  const has = (p: (f: Field) => boolean) => fields.some(p);
  const loc = fields.filter((f) => f.group === 'location');
  if (loc.length) {
    const exact = loc.some((f) => /latitude|longitude|GPSPosition|ISO6709|©xyz|loci|GPSTrack/i.test(f.key));
    out.push({ id: 'location', label: exact ? 'Exact location' : 'Location details', level: 'red' });
  }
  const serial = has((f) => f.group === 'device' && f.sensitivity === 'high');
  const model = has((f) => f.group === 'device');
  if (serial) out.push({ id: 'device-serial', label: 'Phone model and serial number', level: 'red' });
  else if (model) out.push({ id: 'device', label: 'Phone or camera model', level: 'orange' });
  if (has((f) => f.group === 'datetime')) out.push({ id: 'datetime', label: 'Date and time taken', level: 'orange' });
  if (has((f) => f.group === 'people' && f.source === 'pdf' && /^(Rev\d+:)?(Author|Annotation)/.test(f.key))) out.push({ id: 'author', label: 'Document author', level: 'red' });
  if (has((f) => f.group === 'people' && !(f.source === 'pdf' && /^(Rev\d+:)?(Author|Annotation)/.test(f.key)))) out.push({ id: 'people', label: 'Your name / copyright', level: 'red' });
  if (has((f) => f.group === 'software')) out.push({ id: 'software', label: 'Editing app', level: 'grey' });
  if (has((f) => f.id === 'exif:IFD1:ThumbnailOffset' || f.id === 'exif:IFD1:ThumbnailLength' || f.key.startsWith('IFD1:') || f.id === 'jpeg:JFIFThumbnail'))
    out.push({ id: 'thumbnail', label: 'Hidden preview image', level: 'orange' });
  if (has((f) => f.id === 'trailer:MotionPhoto' || f.key.startsWith('GCamera:MotionPhoto') || f.key.startsWith('GCamera:MicroVideo')))
    out.push({ id: 'motion', label: 'Motion-photo video', level: 'red' });
  if (has((f) => f.id === 'trailer:GainMap' || f.key.startsWith('hdrgm:') || f.id === 'jpeg:MPF'))
    out.push({ id: 'hdr', label: 'HDR brightness data', level: 'grey' });
  if (has((f) => f.id === 'exif:MakerNote')) out.push({ id: 'makernote', label: 'Maker notes (camera-specific data)', level: 'orange' });
  if (has((f) => f.id === 'trailer:Data')) out.push({ id: 'trailer', label: 'Hidden data after the picture', level: 'orange' });
  if (has((f) => f.group === 'camera')) out.push({ id: 'camera', label: 'Camera settings', level: 'grey' });
  const other = fields.filter((f) => !f.known).length;
  if (other) out.push({ id: 'other', label: `Other (${other} fields)`, level: 'orange' });
  if (!out.some((f) => f.level !== 'grey')) out.unshift({ id: 'none', label: 'No personal data found', level: 'grey' });
  return out;
}
