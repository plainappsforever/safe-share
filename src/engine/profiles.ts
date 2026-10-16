/**
 * Cleaning profiles (SPEC F3, D12). One rule decides for every field in every format, and the same
 * rule is used by the writer (what to copy) and by the verifier (what may remain).
 *  - all:      remove everything; keep only what the picture needs to look the same (orientation ≠ 1, colour profile).
 *  - location: remove location; keep every catalogued non-location field. Unknown ("Other") fields,
 *              hidden extras (thumbnails, maker notes, trailers) are removed too: they cannot be proven location-free (D29).
 *  - camera:   keep camera settings (exposure, aperture, ISO, lens, focal length) and technical fields; remove the rest.
 */
import type { Field } from './catalog';
import type { Format } from './sniff';

export type Profile = 'all' | 'location' | 'camera';
export const PROFILES: Profile[] = ['all', 'location', 'camera'];

export type KeepReason = 'orientation' | 'colour' | 'picture' | 'profile';

/**
 * SPEC F3: for video and PDF, "Location only" removes only location keys and the other two profiles remove
 * all metadata (video keeps its rotation matrix). The writer, the verifier and the Inspect plan use this.
 */
export function profileFor(format: Format, profile: Profile): Profile {
  return profile === 'camera' && (format === 'mp4' || format === 'mov' || format === 'pdf') ? 'all' : profile;
}

/** Fields that are rebuilt, not copied, so they are never "kept" as data. */
const NEVER_KEEP = new Set(['iptc:IPTCDigest', 'xmp:xmpNote:HasExtendedXMP']);

/** Returns why a field survives `profile`, or null when it must be removed. */
export function keepReason(f: Field, profile: Profile): KeepReason | null {
  if (f.id === 'icc:ICC_Profile') return 'colour';
  if (f.id === 'heif:Rotation' || f.id === 'heif:Mirror') return 'orientation';
  // S9 (P7.5): the other pictures inside a HEIC (preview, depth map, HDR gain map) are picture data, kept byte for byte.
  if (f.source === 'heif' && f.key.startsWith('Image:')) return 'picture';
  // V1.5-1: previews and extra pages inside a TIFF/DNG are picture data too, kept byte for byte.
  if (f.source === 'tiff' && f.key.startsWith('Image:')) return 'picture';
  if (f.source === 'qt' && /^Track\d+:Rotation$/.test(f.key)) return 'orientation';
  if (f.id === 'exif:Orientation') return profile === 'all' ? (f.value.trim() !== '1' ? 'orientation' : null) : 'orientation';
  if (profile === 'all' || !f.known || NEVER_KEEP.has(f.id)) return null;
  if (f.group === 'extras' || f.group === 'other') return null;
  if (profile === 'location') return f.group === 'location' ? null : 'profile';
  return f.group === 'camera' || f.group === 'technical' ? 'profile' : null;
}

export function keeps(f: Field, profile: Profile): boolean {
  return keepReason(f, profile) !== null;
}

/** "Will remove (N)" / "Will keep (M) — why" for the Inspect screen. */
export function planFor(fields: Field[], profile: Profile): { remove: Field[]; keep: { field: Field; reason: KeepReason }[] } {
  const remove: Field[] = [];
  const keep: { field: Field; reason: KeepReason }[] = [];
  for (const f of fields) {
    const r = keepReason(f, profile);
    if (r) keep.push({ field: f, reason: r });
    else remove.push(f);
  }
  return { remove, keep };
}
