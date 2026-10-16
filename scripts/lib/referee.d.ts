export type TagValue = string | number | (string | number)[];
export type Tags = Record<string, TagValue>;
export interface ManifestEntry {
  format: string;
  /** Only inputs are listed; false = the app must report it unsupported/corrupt instead of cleaning. */
  supported: boolean;
  /** ExifTool tag -> exact value that must be gone after "Remove everything". */
  sensitive: Tags;
  /** Subset of `sensitive` keys that describe location (removed by "Location only"). */
  location: string[];
  /** Kept by "Keep camera settings"; removed by "Remove everything". */
  cameraSettings: Tags;
  /** ExifTool tag -> value that must survive "Remove everything" (orientation, ICC, dimensions). */
  keep: Tags;
  /** Strings the referee cannot see (older revisions, secondary images) but a byte scan finds. */
  rawStrings: string[];
  /** Which bytes must stay identical (A2). */
  lossless: string;
  notes?: string;
}
export interface Manifest {
  files: Record<string, ManifestEntry>;
}
export const ROOT: string;
export function exifDump(files: string[]): Record<string, Tags>;
export function valueEquals(actual: unknown, expected: unknown): boolean;
export function expectedTags(entry: ManifestEntry): Tags;
export function missingInInput(entry: ManifestEntry, tags: Tags, bytes: Buffer): string[];
export function survivors(entry: ManifestEntry, tags: Tags, bytes: Buffer, opts?: { includeCameraSettings?: boolean }): string[];
export function lostKept(entry: ManifestEntry, tags: Tags): string[];
export function loadManifest(file?: string): Manifest;
