/** Plain-language grouping of engine fields for the Inspect and Result screens (SPEC F2, F4). */
import type { Field, Group } from '@/engine/catalog';
import type { MetadataReport } from '@/engine/inspect';

import { strings } from './strings';

export const GROUP_ORDER: Group[] = ['location', 'datetime', 'device', 'camera', 'people', 'software', 'technical', 'extras', 'other'];

export function groupLabel(g: Group): string {
  return strings.groups[g] ?? g;
}

export function groupFields(fields: Field[]): { group: Group; label: string; fields: Field[] }[] {
  return GROUP_ORDER.map((group) => ({ group, label: groupLabel(group), fields: fields.filter((f) => f.group === group) })).filter((g) => g.fields.length > 0);
}

/** "Latitude, Longitude, Comment author ×3": unique human names with a count when repeated. */
export function uniqueNames(fields: Field[]): { name: string; count: number }[] {
  const seen = new Map<string, number>();
  for (const f of fields) seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
  return [...seen].map(([name, count]) => ({ name, count }));
}

export interface PdfFlags {
  revisions: boolean;
  signed: boolean;
  forms: boolean;
  script: boolean;
  commentAuthors: boolean;
  attachments: boolean;
}

/** What the engine reported about a PDF that it does NOT remove (P3-1, P3-2, D34). */
export function pdfFlags(r: MetadataReport): PdfFlags {
  const notes = r.notes.join(' | ');
  return {
    revisions: (r.extraFindings ?? []).some((f) => f.id === 'revisions'),
    signed: (r.extraFindings ?? []).some((f) => f.id === 'signature'),
    forms: /form fields/i.test(notes),
    script: /JavaScript/i.test(notes),
    commentAuthors: r.fields.some((f) => f.id === 'pdf:AnnotationAuthor'),
    attachments: r.fields.some((f) => f.id === 'pdf:EmbeddedFile'),
  };
}

export function isVideo(format: string): boolean {
  return format === 'mp4' || format === 'mov';
}

/** Formats shown with a thumbnail and read by the phone's image reader (V1.5-1 adds TIFF, DNG and GIF; camera RAW is inspect-only). */
export function isImage(format: string): boolean {
  return ['jpeg', 'png', 'webp', 'heic', 'avif', 'tiff', 'dng', 'gif'].includes(format);
}

/** Why a file was declined, in plain words (never "clean"). */
export function declineMessage(problem: 'unsupported' | 'corrupt' | 'failed', detail?: string): string {
  if (problem === 'corrupt') return /empty/i.test(detail ?? '') ? strings.result.declinedEmpty : strings.result.declinedCorrupt;
  if (problem === 'failed') return strings.result.declinedFailed;
  if (/camera RAW/i.test(detail ?? '')) return strings.result.declinedRaw;
  return /encrypt/i.test(detail ?? '') ? strings.result.declinedEncrypted : strings.result.declinedUnsupported;
}

export function mimeFor(format: string): { mimeType: string; UTI: string } {
  switch (format) {
    case 'jpeg':
      return { mimeType: 'image/jpeg', UTI: 'public.jpeg' };
    case 'png':
      return { mimeType: 'image/png', UTI: 'public.png' };
    case 'webp':
      return { mimeType: 'image/webp', UTI: 'org.webmproject.webp' };
    case 'heic':
      return { mimeType: 'image/heic', UTI: 'public.heic' };
    case 'avif':
      return { mimeType: 'image/avif', UTI: 'public.avif' };
    case 'tiff':
      return { mimeType: 'image/tiff', UTI: 'public.tiff' };
    case 'dng':
      return { mimeType: 'image/x-adobe-dng', UTI: 'com.adobe.raw-image' };
    case 'gif':
      return { mimeType: 'image/gif', UTI: 'com.compuserve.gif' };
    case 'mp4':
      return { mimeType: 'video/mp4', UTI: 'public.mpeg-4' };
    case 'mov':
      return { mimeType: 'video/quicktime', UTI: 'com.apple.quicktime-movie' };
    case 'pdf':
      return { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' };
    default:
      return { mimeType: 'application/octet-stream', UTI: 'public.data' };
  }
}

export interface BatchCounts {
  clean: number;
  dirty: number;
  unverified: number;
  unsupported: number;
  failed: number;
  pending: number;
}

/** "10 verified clean · 1 not supported · 1 failed" (F6): zero categories are left out. */
export function batchSummary(c: BatchCounts): string {
  const s = strings.batch;
  const parts: string[] = [];
  if (c.clean) parts.push(s.summaryClean(c.clean));
  if (c.dirty) parts.push(s.summaryDirty(c.dirty));
  if (c.unverified) parts.push(s.summaryUnverified(c.unverified));
  if (c.unsupported) parts.push(s.summaryUnsupported(c.unsupported));
  if (c.failed) parts.push(s.summaryFailed(c.failed));
  if (c.pending) parts.push(s.summaryPending(c.pending));
  return parts.join(' · ');
}

export function countOutcomes(jobs: readonly { state: string; outcome?: { status: string } }[]): BatchCounts {
  const c: BatchCounts = { clean: 0, dirty: 0, unverified: 0, unsupported: 0, failed: 0, pending: 0 };
  for (const j of jobs) {
    const st = j.state === 'done' ? j.outcome?.status : undefined;
    if (st === 'clean') c.clean++;
    else if (st === 'dirty') c.dirty++;
    else if (st === 'unverified') c.unverified++;
    else if (st === 'unsupported') c.unsupported++;
    else if (st === 'corrupt' || st === 'failed') c.failed++;
    else c.pending++;
  }
  return c;
}

/**
 * Batch share (SPEC F6, P6): only verified-clean copies are ever shared together. "Clean all & share" opens the share
 * sheet by itself only when every file ended verified clean; otherwise the summary stays on screen and "Share N verified
 * clean copies" leaves the others out (they can be opened and shared one by one with the usual warning).
 */
export function batchShareItems(jobs: readonly { state: string; outcome?: { status: string; outputPath?: string; result?: { before: { format: string } } } }[]): { path: string; mimeType: string }[] {
  const items: { path: string; mimeType: string }[] = [];
  for (const j of jobs) {
    const o = j.state === 'done' ? j.outcome : undefined;
    if (o?.status === 'clean' && o.outputPath) items.push({ path: o.outputPath, mimeType: mimeFor(o.result?.before.format ?? 'unknown').mimeType });
  }
  return items;
}

export function batchAutoShare(c: BatchCounts): boolean {
  return c.clean > 0 && c.dirty + c.unverified + c.unsupported + c.failed + c.pending === 0;
}
