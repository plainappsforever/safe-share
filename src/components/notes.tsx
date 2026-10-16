import { View } from 'react-native';

import type { CleanResult } from '@/engine/clean';
import type { MetadataReport } from '@/engine/inspect';
import { profileFor, type Profile } from '@/engine/profiles';
import { isImage, isVideo, pdfFlags } from '@/lib/summary';
import { strings } from '@/lib/strings';

import { Card } from './ui';
import { ThemedText } from './themed-text';
import { Spacing } from '@/constants/theme';

/** What the file contains that Safe Share does not remove, or removes more broadly than the name of the profile suggests. */
export function honestyNotes(report: MetadataReport, profile: Profile): string[] {
  const out: string[] = [];
  const eff = profileFor(report.format, profile);
  if (eff !== 'all' && (isImage(report.format) || isVideo(report.format))) out.push(strings.result.alsoRemoved);
  if (report.findings.some((f) => f.id === 'hdr' || f.id === 'motion')) out.push(strings.result.hdrRemoved);
  if (report.fields.some((f) => f.id === 'heif:Image:hdr')) out.push(strings.result.heicHdr);
  if (report.format === 'pdf') {
    const p = pdfFlags(report);
    if (p.revisions) out.push(strings.result.pdfRevisions);
    if (p.commentAuthors || p.attachments || p.forms || p.script || p.signed) out.push(strings.result.pdfNotRemoved);
    if (p.forms) out.push(strings.result.pdfForms);
    if (p.script) out.push(strings.result.pdfScript);
    if (p.signed) out.push(strings.result.pdfSigned);
  }
  return out;
}

export function NotesCard({ notes, testID }: { notes: string[]; testID: string }) {
  if (notes.length === 0) return null;
  return (
    <Card testID={testID}>
      {notes.map((n, i) => (
        <View key={i} style={{ paddingBottom: i < notes.length - 1 ? Spacing.one : 0 }}>
          <ThemedText type="small">{n}</ThemedText>
        </View>
      ))}
    </Card>
  );
}

export function engineNotes(result: CleanResult | undefined): string[] {
  return (result?.notes ?? []).filter(Boolean);
}
