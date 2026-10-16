/**
 * JS side of the local native module (V1_PLAN P6). `null` where the native module is not linked (Jest, web, an old dev
 * build): callers then keep their P4/P5 behaviour and say honestly that no platform reader ran.
 */
import { requireOptionalNativeModule } from 'expo';

export type PlatformKind = 'image' | 'video' | 'pdf' | 'other';

export interface PickedFile {
  /** file:// URI of the copy inside the destination folder. */
  path?: string;
  name?: string;
  /** Android: the picker's content URI (readable again while the app runs). */
  uri?: string;
  mimeType?: string | null;
  /** Android: true when the copy was read with setRequireOriginal (location not blanked). */
  original?: boolean;
  error?: string;
}

export interface SafeShareNativeModuleType {
  /** JSON: {reader, supported, entries: [{d, t, i?, v}], error?} — see src/lib/platform-reader.ts. */
  readPlatformMetadata(path: string, kind: PlatformKind): Promise<string>;
  isPhotoPickerAvailable(): boolean;
  /** Opens the system photo picker (iOS PHPicker; Android photo picker). `limit` 0 = no limit. [] when cancelled. */
  pickMedia(limit: number, destDir: string, requireOriginal: boolean): Promise<PickedFile[]>;
  /** One share sheet / chooser for several files. iOS: file URIs; Android: content URIs. */
  shareFiles(uris: string[], mimeTypes: string[], title: string): Promise<boolean>;
  /** iOS only (P7.5, S6): copies the bytes into a NEW file (no source dates, no extended attributes). */
  copyFresh?(from: string, to: string): Promise<void>;
  /** Android only. */
  requireOriginal?(uri: string): string;
  displayName?(uri: string): string | null;
  saveToMediaStore?(path: string, name: string, mimeType: string, collection: 'images' | 'video' | 'downloads', folder: string): Promise<string>;
}

export default requireOptionalNativeModule<SafeShareNativeModuleType>('SafeShareNative');
