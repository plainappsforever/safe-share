import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { CleanProgress } from '@/components/clean-progress';
import { LocationCard } from '@/components/location-card';
import { KeptList, RemovedList } from '@/components/plan-lists';
import { honestyNotes, NotesCard } from '@/components/notes';
import { ProfilePicker } from '@/components/profile-picker';
import { ThemedText } from '@/components/themed-text';
import { Card, ChipRow, FieldDetails, Section } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { getFileNamePolicy, getProfileSetting, setProfileSetting } from '@/db/settings';
import { planFor, profileFor, type Profile } from '@/engine/profiles';
import { useTheme } from '@/hooks/use-theme';
import { useJob } from '@/lib/jobs';
import { displayFindings, findCoordinates, mapUrl } from '@/lib/location';
import { cancelClean, runClean, runInspect } from '@/lib/run';
import { declineMessage, isImage } from '@/lib/summary';
import { formatBytes, strings } from '@/lib/strings';

export default function InspectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useSQLiteContext();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const job = useJob(id);
  const [profile, setProfile] = useState<Profile>('all');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [cancelledNote, setCancelledNote] = useState(false);

  useEffect(() => {
    getProfileSetting(db).then((p) => {
      setProfile(p);
      setProfileLoaded(true);
    });
  }, [db]);

  useEffect(() => {
    if (id && job?.state === 'new') void runInspect(id);
  }, [id, job?.state]);

  const report = job?.report;
  const effective = report ? profileFor(report.format, profile) : profile;
  const plan = useMemo(() => (report?.supported ? planFor(report.fields, effective) : null), [report, effective]);
  const coords = useMemo(() => (report ? findCoordinates(report.fields) : null), [report]);

  async function choose(p: Profile) {
    setProfile(p);
    await setProfileSetting(db, p);
  }

  // Leaving the screen while a clean runs (back gesture) cancels it instead of leaving it running unseen.
  useEffect(
    () => () => {
      if (id) cancelClean(id);
    },
    [id]
  );

  async function start(share: boolean) {
    if (!id) return;
    setCancelledNote(false);
    const outcome = await runClean(id, profile, { keepName: (await getFileNamePolicy(db)) === 'original' });
    if (!outcome) return;
    if (outcome.status === 'cancelled') {
      setCancelledNote(true); // Cancel: back to this screen, no copy left
      return;
    }
    router.replace({ pathname: '/result', params: { id, share: share ? '1' : '0' } });
  }

  if (!job || !report) {
    return (
      <View testID="inspect-loading" style={[styles.center, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
        <ThemedText themeColor="textSecondary">{strings.inspect.inspecting}</ThemedText>
      </View>
    );
  }

  const busy = job.state === 'cleaning';
  const meta = [
    strings.formats[report.format] ?? strings.formats.unknown,
    formatBytes(report.size),
    report.width && report.height ? strings.inspect.dimensions(report.width, report.height) : null,
    report.duration !== undefined ? strings.inspect.duration(report.duration) : null,
    report.pages !== undefined ? strings.inspect.pages(report.pages) : null,
  ].filter(Boolean);

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
    <ScrollView testID="inspect-screen" style={styles.flex} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.header}>
        {isImage(report.format) ? <Image source={{ uri: job.inputPath }} cachePolicy="none" style={styles.thumb} contentFit="cover" accessibilityLabel={job.name} /> : null}
        <View style={styles.headerText}>
          <ThemedText type="smallBold" testID="inspect-name">
            {job.name}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" testID="inspect-meta">
            {meta.join(' · ')}
          </ThemedText>
        </View>
      </View>

      {!report.supported ? (
        <Card testID="inspect-declined">
          <ThemedText type="smallBold">{report.problem === 'corrupt' ? strings.result.couldNotRead : strings.result.notSupported}</ThemedText>
          <ThemedText type="small">{declineMessage(report.problem ?? 'unsupported', report.detail)}</ThemedText>
          {report.detail ? (
            <ThemedText type="code" themeColor="textSecondary">
              {report.detail}
            </ThemedText>
          ) : null}
        </Card>
      ) : (
        <>
          <Section title={strings.inspect.findings} testID="inspect-findings">
            <ChipRow findings={displayFindings(report)} testIDPrefix="finding" />
            {report.opaque?.length ? (
              <ThemedText type="small" themeColor="textSecondary">
                {strings.inspect.unreadable}
              </ThemedText>
            ) : null}
          </Section>

          <LocationCard job={job} report={report} />

          {report.notCleanable ? (
            <Card testID="inspect-raw-only">
              <ThemedText type="smallBold">{strings.inspect.rawOnlyTitle}</ThemedText>
              <ThemedText type="small">{strings.inspect.rawOnly}</ThemedText>
            </Card>
          ) : (
            <>
              <NotesCard testID="inspect-notes" notes={honestyNotes(report, profile)} />

              <Section title={strings.inspect.profile}>
                <ProfilePicker value={profile} onChange={choose} />
                {report.format === 'mp4' || report.format === 'mov' || report.format === 'pdf' ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    {strings.inspect.videoPdfProfileNote}
                  </ThemedText>
                ) : null}
              </Section>

              {plan ? (
                <View style={styles.plan}>
                  <RemovedList testID="will-remove" fields={plan.remove} title={strings.inspect.willRemove(plan.remove.length)} empty={strings.inspect.nothingToRemove} />
                  <KeptList testID="will-keep" kept={plan.keep} title={strings.inspect.willKeep(plan.keep.length)} empty={strings.inspect.nothingToKeep} />
                </View>
              ) : null}
            </>
          )}

          <Section title={strings.inspect.details} testID="inspect-details">
            {coords ? (
              <Button
                testID="show-on-map"
                variant="secondary"
                label={strings.inspect.showOnMap}
                onPress={() => Linking.openURL(mapUrl(coords, Platform.OS)).catch(() => undefined)}
              />
            ) : null}
            {report.fields.length === 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                {strings.inspect.nothingFound}
              </ThemedText>
            ) : (
              <FieldDetails fields={report.fields} />
            )}
          </Section>
        </>
      )}
    </ScrollView>
    {report.supported && !report.notCleanable ? (
      // Always visible: one tap from Inspect to the share sheet (A9), no scrolling past the details.
      <View style={[styles.actions, { backgroundColor: theme.background, borderTopColor: theme.backgroundSelected, paddingBottom: Spacing.three + insets.bottom }]}>
        {busy ? (
          <CleanProgress progress={job.progress} onCancel={() => cancelClean(job.id)} />
        ) : (
          <>
            {cancelledNote ? (
              <ThemedText testID="cancelled-note" type="smallBold" accessibilityLiveRegion="polite">
                {strings.progress.cancelled}
              </ThemedText>
            ) : null}
            <Button testID="clean-share" label={strings.inspect.cleanAndShare} disabled={!profileLoaded} onPress={() => start(true)} />
            <Button testID="clean" variant="secondary" label={strings.inspect.clean} disabled={!profileLoaded} onPress={() => start(false)} />
          </>
        )}
      </View>
    ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.three, gap: Spacing.three },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.three },
  header: { flexDirection: 'row', gap: Spacing.three, alignItems: 'center' },
  headerText: { flex: 1, gap: Spacing.one },
  thumb: { width: 72, height: 72, borderRadius: 8 },
  plan: { gap: Spacing.three },
  flex: { flex: 1 },
  actions: { gap: Spacing.two, padding: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth },
});
