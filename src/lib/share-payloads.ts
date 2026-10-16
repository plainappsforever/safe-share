/** Pure logic for files shared into Safe Share (SPEC F1, D16). No React Native imports: tested in Jest. */

/** The fields of expo-sharing's `SharePayload` that Safe Share uses. */
export interface IncomingPayload {
  value: string;
  shareType: string;
  mimeType?: string;
}

const FILE_TYPES = new Set(['image', 'video', 'file', 'audio']);

/**
 * The payloads that are files, in order, without duplicates. Text and web links are ignored (the share targets only
 * accept images, videos and PDFs; anything else that arrives is declined later by the engine, never called clean).
 */
export function filePayloads(payloads: readonly IncomingPayload[]): IncomingPayload[] {
  const seen = new Set<string>();
  const out: IncomingPayload[] = [];
  for (const p of payloads) {
    if (!FILE_TYPES.has(p.shareType) || !p.value || seen.has(p.value)) continue;
    if (!/^(content|file):\/\//i.test(p.value)) continue;
    seen.add(p.value);
    out.push(p);
  }
  return out;
}

/**
 * `content://media/…` (MediaStore) — the only kind of URI Android redacts location in for us and lets us ask again with
 * requireOriginal (D17). Photo-picker URIs (`content://media/picker/…`) are excluded: Android throws "Require Original is
 * not supported for Picker URI" (measured on API 36, P6).
 */
export function isMediaStoreUri(uri: string): boolean {
  return /^content:\/\/media\//i.test(uri) && !/^content:\/\/media\/picker(_get_content)?\//i.test(uri);
}

/**
 * Android `MediaStore.setRequireOriginal(uri)` in plain text: it appends `requireOriginal=1`. With
 * ACCESS_MEDIA_LOCATION this asks MediaStore for the unredacted bytes (location included).
 */
export function requireOriginalUri(uri: string): string {
  if (!isMediaStoreUri(uri) || /[?&]requireOriginal=1\b/.test(uri)) return uri;
  return uri + (uri.includes('?') ? '&' : '?') + 'requireOriginal=1';
}

/** iOS: the extension saves each file in `<App Group>/SafeShareInbox/<uuid>/<name>`; this is that `<uuid>` folder. */
export function inboxFolderOf(fileUri: string): string | null {
  const m = fileUri.match(/^(.*\/SafeShareInbox\/[^/]+)\/[^/]+$/);
  return m ? m[1] : null;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/avif': 'avif', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v',
  'image/tiff': 'tiff', 'image/x-adobe-dng': 'dng', 'image/dng': 'dng', 'video/3gpp': '3gp', 'video/3gpp2': '3g2',
  'application/pdf': 'pdf',
};

/**
 * Name shown for a shared file. expo-file-system cannot read Android's display name, so a MediaStore URI gives its id
 * (`31`), like the photo picker's copies (`18.jpg`); the extension comes from the MIME type. The name is only shown:
 * the cleaned copy always gets a neutral name (D18) and the format is detected from the bytes, never from the name.
 */
export function sharedFileName(uri: string, mimeType?: string): string {
  let last = uri.split('?')[0].split('/').filter(Boolean).pop() ?? 'file';
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep it encoded
  }
  // Document ids: `image:19` (media documents), `primary:Pictures/a.jpg` (storage) -> `19`, `a.jpg`.
  last = (last.split('/').pop() || 'file').replace(/^[a-z_]+:/i, '') || 'file';
  if (/\.[A-Za-z0-9]{2,5}$/.test(last)) return last;
  const ext = mimeType ? EXT[mimeType.toLowerCase()] : undefined;
  return ext ? `${last}.${ext}` : last;
}
