import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { engineNotes, honestyNotes, NotesCard } from '@/components/notes';
import { KeptList, RemovedList } from '@/components/plan-lists';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getKeepOutputs } from '@/db/settings';
import { useTheme } from '@/hooks/use-theme';
import { getJobs, useJob, type Job } from '@/lib/jobs';
import { coordinatesBlanked } from '@/lib/location';
import { nameHasDate } from '@/lib/pipeline';
import { formatBytes, strings } from '@/lib/strings';
import { declineMessage, isVideo, mimeFor } from '@/lib/summary';
import { saveKind, saveLabel, saveToLibrary } from '@/lib/save';
import { IS_DEV_BUILD, wipeWork } from '@/lib/work';

const GREEN = { light: '#DDF3E1', dark: '#17351E', edge: '#1E8E3E' };
const RED = { light: '#FDE3E1', dark: '#4A1F1F', edge: '#D93025' };
const AMBER = { light: '#FFEBD1', dark: '#4A3315', edge: '#E37400' };

function warningFor(job: Job): string | null {
  const o = job.outcome;
  if (!o || o.status === 'clean') return null;
  if (o.status === 'dirty') return strings.result.warnStill([...new Set(o.verdict?.survivors.map((s) => s.name) ?? [])].join(', '));
  if (o.status === 'unverified') return strings.result.warnUnverified;
  return null;
}

export default function ResultScreen() {
  const { id, share } = useLocalSearchParams<{ id: string; share?: string }>();
  const router = useRouter();
  const db = useSQLiteContext();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const job = useJob(id);
  const [shareState, setShareState] = useState<'idle' | 'opened' | 'failed'>('idle');
  const [saveState, setSaveState] = useState<{ busy: boolean; message?: string; ok?: boolean }>({ busy: false });
  const autoShared = useRef(false);
  const dark = theme.background === '#000000';

  const outcome = job?.outcome;
  const report = outcome?.result?.before ?? job?.report;

  async function doShare() {
    if (!outcome?.outputPath) return;
    const { mimeType, UTI } = mimeFor(report?.format ?? 'unknown');
    try {
      setShareState('opened');
      await Sharing.shareAsync(outcome.outputPath, { mimeType, UTI, dialogTitle: strings.result.share });
    } catch {
      setShareState('failed');
    }
  }

  function shareWithWarning() {
    if (!job) return;
    const warn = warningFor(job);
    if (!warn) {
      void doShare();
      return;
    }
    Alert.alert(strings.result.warnTitle, warn, [
      { text: strings.result.warnCancel, style: 'cancel' },
      { text: strings.result.warnShare, onPress: () => void doShare() },
    ]);
  }

  async function doSave() {
    if (!outcome?.outputPath || !report) return;
    const kind = saveKind(report.format);
    if (kind === 'share') {
      // PDFs (both platforms) and Android 8–10: "Save to Files" is the share sheet's job.
      await doShare();
      return;
    }
    setSaveState({ busy: true });
    const res = await saveToLibrary(outcome.outputPath, kind, report.format, outcome.outputName ?? 'file');
    setSaveState(res ? { busy: false, message: res.message, ok: res.ok } : { busy: false });
  }

  function saveWithWarning() {
    if (!job) return;
    const o = job.outcome;
    const warn =
      !o || o.status === 'clean' ? null
      : o.status === 'dirty' ? strings.result.saveWarnStill([...new Set(o.verdict?.survivors.map((s) => s.name) ?? [])].join(', '))
      : strings.result.saveWarnUnverified;
    if (!warn) {
      void doSave();
      return;
    }
    Alert.alert(strings.result.saveWarnTitle, warn, [
      { text: strings.result.warnCancel, style: 'cancel' },
      { text: strings.result.saveWarnSave, onPress: () => void doSave() },
    ]);
  }

  // A9: "Clean & share" goes straight to the share sheet when (and only when) verification passed.
  useEffect(() => {
    if (share === '1' && outcome?.status === 'clean' && !autoShared.current) {
      autoShared.current = true;
      void doShare();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share, outcome?.status]);

  // Inside a batch the other results are still needed: Done goes back to the list; the folder is wiped when the list is left.
  const inBatch = getJobs().length > 1;
  async function done() {
    if (inBatch) {
      router.back();
      return;
    }
    if (!(IS_DEV_BUILD && (await getKeepOutputs(db)))) wipeWork();
    router.dismissAll();
  }

  if (!job || !outcome || !report) {
    return (
      <View style={[styles.flex, styles.center, { backgroundColor: theme.background }]}>
        <ThemedText themeColor="textSecondary">{strings.common.working}</ThemedText>
      </View>
    );
  }

  const st = outcome.status;
  const declined = st === 'unsupported' || st === 'corrupt' || st === 'failed';
  const palette = st === 'clean' ? GREEN : st === 'dirty' ? RED : AMBER;
  const title =
    st === 'clean' ? strings.result.verifiedClean
    : st === 'dirty' ? strings.result.notFullyClean
    : st === 'unverified' ? strings.result.couldNotVerify
    : st === 'unsupported' ? strings.result.notSupported
    : st === 'corrupt' ? strings.result.couldNotRead
    : strings.result.failed;
  const result = outcome.result;
  const verdict = outcome.verdict;
  const unchanged = report.format === 'pdf' ? strings.result.pagesUnchanged : isVideo(report.format) ? strings.result.videoUnchanged : strings.result.pictureUnchanged;
  const notes = [
    ...honestyNotes(report, job.profile ?? 'all'),
    ...engineNotes(result),
    ...(coordinatesBlanked(report.fields) ? [strings.location.emptyRemoved] : []),
    ...(outcome.outputName && nameHasDate(outcome.outputName) ? [strings.result.nameHasDate] : []),
  ];
  const survivors = [...new Set(verdict?.survivors.map((s) => s.name) ?? [])];
  // D11/D44/P7.5: say how many checks ran and which of them found each survivor.
  const platformName = outcome.platform?.reader;
  const readerLabel = (r: string) => (r === 'platform' && platformName ? `${strings.result.readerNames.platform} (${platformName})` : strings.result.readerNames[r] ?? r);
  const survivorLines = survivors.map((name) =>
    strings.result.survivorLine(name, [...new Set(verdict!.survivors.filter((s) => s.name === name).map((s) => s.reader))].map(readerLabel).join(', '))
  );
  const readersFound = new Set(verdict?.survivors.map((s) => s.reader) ?? []).size;
  const readersNote =
    outcome.platform?.status === 'none' && report.format === 'pdf' ? strings.result.noPdfReaderAndroid
    : outcome.platform?.status === 'cannot-read' ? strings.result.platformCannotRead(outcome.platform.reader)
    : null;
  const checkedText =
    verdict && verdict.readers === 4 && platformName ? strings.result.checkedAll(platformName)
    : [strings.result.checkedBy(verdict?.readers ?? 3), readersNote].filter(Boolean).join(' ');

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <ScrollView testID="result-screen" style={styles.flex} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <View testID="verdict" accessibilityRole="summary" style={[styles.banner, { backgroundColor: dark ? palette.dark : palette.light, borderColor: palette.edge }]}>
          <ThemedText type="subtitle" testID="verdict-title" style={styles.bannerTitle}>
            {title}
          </ThemedText>
          {declined ? (
            <ThemedText testID="verdict-detail">{declineMessage(st, outcome.message)}</ThemedText>
          ) : null}
          {st === 'clean' && verdict ? (
            <>
              <ThemedText testID="verdict-summary">
                {strings.result.removedCount(result!.removed.length)}, {strings.result.keptCount(result!.kept.length)}
              </ThemedText>
              {verdict.pictureUnchanged ? <ThemedText testID="unchanged">{unchanged}</ThemedText> : null}
              <ThemedText type="small" testID="readers">
                {checkedText}
              </ThemedText>
            </>
          ) : null}
          {st === 'dirty' ? (
            <View testID="survivors" style={{ gap: Spacing.one }}>
              <ThemedText>{strings.result.stillContains}</ThemedText>
              {survivorLines.map((s) => (
                <ThemedText key={s} type="smallBold">
                  • {s}
                </ThemedText>
              ))}
              <ThemedText type="small" testID="readers-found">
                {strings.result.foundBy(readersFound, verdict?.readers ?? 3)}
              </ThemedText>
            </View>
          ) : null}
          {st === 'unverified' && verdict ? (
            <View testID="problems" style={{ gap: Spacing.one }}>
              <ThemedText>{strings.result.couldNotCheck}</ThemedText>
              {[...verdict.problems, ...survivors].map((p) => (
                <ThemedText key={p} type="smallBold">
                  • {p}
                </ThemedText>
              ))}
            </View>
          ) : null}
        </View>

        {st === 'dirty' || st === 'unverified' ? (
          <ThemedText type="small" testID="verdict-summary">
            {strings.result.removedCount(result!.removed.length)}, {strings.result.keptCount(result!.kept.length)}. {verdict?.pictureUnchanged ? unchanged + '.' : strings.result.dataChanged}
          </ThemedText>
        ) : null}

        {result ? (
          <>
            <ThemedText type="small" themeColor="textSecondary" testID="sizes">
              {strings.result.sizeChange(formatBytes(result.bytesIn), formatBytes(result.bytesOut))}
            </ThemedText>
            <NotesCard testID="result-notes" notes={notes} />
            <RemovedList testID="removed" fields={result.removed} title={strings.result.removed(result.removed.length)} empty={strings.result.nothingRemoved} />
            <KeptList testID="kept" kept={result.kept} title={strings.result.kept(result.kept.length)} empty={strings.result.nothingKept} />
          </>
        ) : null}

        <ThemedText type="small" themeColor="textSecondary">
          {strings.result.originalUntouched} {result ? strings.result.deletedOnDone : ''}
        </ThemedText>
        {shareState === 'failed' ? <ThemedText testID="share-failed">{strings.result.shareFailed}</ThemedText> : null}
        {IS_DEV_BUILD ? (
          <>
            {shareState === 'opened' ? <ThemedText testID="share-status">{strings.result.shareOpened}</ThemedText> : null}
            <ThemedText type="code" themeColor="textSecondary" testID="timing">
              {`output ${outcome.outputName ?? '-'} · inspect ${job.inspectMs ?? '-'} ms · clean ${outcome.ms.clean} ms · verify ${outcome.ms.verify} ms · total ${outcome.ms.total} ms · longest slice ${outcome.ms.longestSlice ?? '-'} ms · UI lag ${outcome.ms.maxLag ?? '-'} ms`}
            </ThemedText>
          </>
        ) : null}
      </ScrollView>

      <View style={[styles.bar, { backgroundColor: theme.background, borderTopColor: theme.backgroundSelected, paddingBottom: Spacing.three + insets.bottom }]}>
        {saveState.message ? (
          <ThemedText testID={saveState.ok ? 'save-done' : 'save-failed'} type="smallBold" accessibilityLiveRegion="polite">
            {saveState.message}
          </ThemedText>
        ) : null}
        {!declined && outcome.outputPath ? (
          <>
            <Button testID="share" label={st === 'clean' ? strings.result.share : strings.result.shareAnyway} onPress={shareWithWarning} />
            <Button
              testID="save"
              variant="secondary"
              label={saveState.busy ? strings.result.saving : saveLabel(saveKind(report.format))}
              disabled={saveState.busy}
              onPress={saveWithWarning}
            />
          </>
        ) : null}
        <Button testID="done" variant="secondary" label={inBatch ? strings.batch.backToList : strings.result.done} onPress={done} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: Spacing.three, gap: Spacing.three },
  banner: { borderRadius: 12, borderLeftWidth: 6, padding: Spacing.three, gap: Spacing.two },
  bannerTitle: { fontSize: 26, lineHeight: 32 },
  bar: { gap: Spacing.two, padding: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth },
});
