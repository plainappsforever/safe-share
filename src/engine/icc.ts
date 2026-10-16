/** ICC colour profile reader (display only): profile description from the `desc` tag (v2 desc / v4 mluc). */
import { ascii, u32, utf16 } from './binary';
import { makeField, type Field } from './catalog';

export function iccDescription(b: Uint8Array): string | undefined {
  if (b.length < 132 || ascii(b, 36, 4) !== 'acsp') return undefined;
  const n = u32(b, 128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= b.length; i++) {
    const e = 132 + i * 12;
    if (ascii(b, e, 4) !== 'desc') continue;
    const off = u32(b, e + 4);
    const size = u32(b, e + 8);
    if (off + size > b.length || size < 12) return undefined;
    const type = ascii(b, off, 4);
    if (type === 'desc') {
      const len = u32(b, off + 8);
      return ascii(b, off + 12, Math.max(0, Math.min(len, size - 12))).replace(/\0[\s\S]*$/, '');
    }
    if (type === 'mluc' && size >= 28) {
      const len = u32(b, off + 20);
      const at = u32(b, off + 24);
      return utf16(b, off + at, len, 'BE');
    }
    return undefined;
  }
  return undefined;
}

/**
 * True when `b` is an ICC profile (ICC.1:2022 §7.2: the header's size field at byte 0 and the 'acsp' signature at byte 36).
 * Review S4 (V1.5-1): a block that only claims to be a colour profile is not kept as one. Up to 3 zero bytes of padding
 * after the declared size are allowed (TIFF/RIFF word alignment).
 */
export function isIccProfile(b: Uint8Array): boolean {
  if (b.length < 132 || ascii(b, 36, 4) !== 'acsp') return false;
  const declared = u32(b, 0);
  if (declared < 132 || declared > b.length || b.length - declared > 3) return false;
  for (let i = declared; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/** The catalogue field of an embedded colour profile; a block that is not a real ICC profile is "Other" and removed (S4). */
export function iccField(b: Uint8Array): Field {
  if (!isIccProfile(b)) return makeField('icc', 'Invalid', { name: 'Block that claims to be a colour profile', group: 'other', sensitivity: 'medium', known: false }, `${b.length} bytes`);
  const desc = iccDescription(b);
  return makeField('icc', 'ICC_Profile', { name: 'Colour profile', group: 'technical', sensitivity: 'none', known: true }, desc ?? `${b.length} bytes`);
}
