import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { CleanProgress } from '@/components/clean-progress';
import { ProfilePicker } from '@/components/profile-picker';
import { ThemedText } from '@/components/themed-text';
import { Card, ChipRow, Section } from '@/components/ui';
import { displayFindings } from '@/lib/location';
import { Spacing } from '@/constants/theme';
import { getJobs, useJobs, type Job } from '@/lib/jobs';
import { getFileNamePolicy, getKeepOutputs, getProfileSetting, setProfileSetting } from '@/db/settings';
import type { Profile } from '@/engine/profiles';
import { useTheme } from '@/hooks/use-theme';
import { cancelClean, runClean, runInspect } from '@/lib/run';
import { formatBytes, strings } from '@/lib/strings';
import { shareMany } from '@/lib/share-out';
import { batchAutoShare, batchShareItems, batchSummary, countOutcomes } from '@/lib/summary';
import { IS_DEV_BUILD, wipeWork } from '@/lib/work';

function rowStatus(job: Job): string {
  const s = strings.batch.row;
  if (job.state === 'new') return s.waiting;
  if (job.state === 'reading') return s.reading;
  if (job.state === 'cleaning') return s.cleaning;
  if (job.state === 'done') {
    switch (job.outcome?.status) {
      case 'clean':
        return s.verifiedClean;
      case 'dirty':
        return s.notFullyClean;
      case 'unverified':
        return s.couldNotVerify;
      case 'unsupported':
        return s.notSupported;
      default:
        return s.failed;
    }
  }
  return job.report && !job.report.supported ? s.notSupported : '';
}

export default function BatchScreen() {
  const router = useRouter();
  const db = useSQLiteContext();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const jobs = useJobs();
  const [profile, setProfile] = useState<Profile>('all');
  const [phase, setPhase] = useState<'reading' | 'ready' | 'cleaning' | 'finished'>('reading');
  const [position, setPosition] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'opened' | 'failed'>('idle');
  const cancelRef = useRef(false);
  const started = useRef(false);
  const currentId = useRef<string | null>(null);

  useEffect(() => {
    getProfileSetting(db).then(setProfile);
  }, [db]);

  // Read every file once, one at a time (D22), so each row can show its findings.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const all = getJobs();
      for (let i = 0; i < all.length; i++) {
        setPosition(i + 1);
        await runInspect(all[i].id);
      }
      setPhase('ready');
    })();
  }, []);

  async function shareAll() {
    try {
      setShareState('opened');
      await shareMany(batchShareItems(getJobs()));
    } catch {
      setShareState('failed');
    }
  }

  // Leaving the list while files are being cleaned stops the run (the current file is cancelled within one slice).
  useEffect(
    () => () => {
      cancelRef.current = true;
      if (currentId.current) cancelClean(currentId.current);
    },
    []
  );

  async function cleanAll(thenShare: boolean) {
    cancelRef.current = false;
    setCancelled(false);
    setPhase('cleaning');
    const keepName = (await getFileNamePolicy(db)) === 'original';
    const all = getJobs();
    for (let i = 0; i < all.length; i++) {
      if (cancelRef.current) break;
      setPosition(i + 1);
      currentId.current = all[i].id;
      await runClean(all[i].id, profile, { keepName });
      currentId.current = null;
    }
    setPhase('finished');
    // F6: "Clean all & share" opens one share sheet only when every file ended verified clean (like Clean & share, A9).
    if (thenShare && !cancelRef.current && batchAutoShare(countOutcomes(getJobs()))) await shareAll();
  }

  async function choose(p: Profile) {
    setProfile(p);
    await setProfileSetting(db, p);
  }

  async function done() {
    if (!(IS_DEV_BUILD && (await getKeepOutputs(db)))) wipeWork();
    router.dismissAll();
  }

  const counts = countOutcomes(jobs);
  const total = jobs.length;

  return (
    <View style={[styles.flex, { backgroundColor: theme.background }]}>
      <ScrollView testID="batch-screen" style={styles.flex} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {phase === 'reading' ? (
          <View testID="batch-reading" style={styles.working}>
            <ActivityIndicator />
            <ThemedText themeColor="textSecondary">{strings.batch.inspecting(position, total)}</ThemedText>
          </View>
        ) : null}

        {phase === 'cleaning' ? (
          <View style={styles.progress}>
            <ThemedText testID="batch-progress" type="smallBold" accessibilityLiveRegion="polite">
              {strings.batch.progress(position, total)}
            </ThemedText>
          </View>
        ) : null}

        {phase === 'finished' ? (
          <Card testID="batch-summary-card">
            <ThemedText type="smallBold" testID="batch-summary">
              {batchSummary(counts)}
            </ThemedText>
            {cancelled ? <ThemedText type="small">{strings.batch.cancelled}</ThemedText> : null}
            <ThemedText type="small" themeColor="textSecondary">
              {strings.batch.tapForResult}
            </ThemedText>
            {counts.clean > 0 && counts.clean < total ? (
              <ThemedText type="small" themeColor="textSecondary" testID="share-left-out">
                {strings.batch.shareLeftOut}
              </ThemedText>
            ) : null}
            {shareState === 'failed' ? <ThemedText testID="share-failed">{strings.batch.shareFailed}</ThemedText> : null}
            {IS_DEV_BUILD && shareState === 'opened' ? <ThemedText testID="share-status">{strings.result.shareOpened}</ThemedText> : null}
          </Card>
        ) : null}

        {phase === 'ready' ? (
          <Section title={strings.inspect.profile}>
            <ProfilePicker value={profile} onChange={choose} />
          </Section>
        ) : null}

        <View style={styles.rows}>
          {jobs.map((job) => {
            const target = job.state === 'done' ? '/result' : '/inspect';
            return (
              <Pressable
                key={job.id}
                testID={`row-${job.name}`}
                accessibilityRole="button"
                accessibilityLabel={`${job.name}, ${rowStatus(job)}`}
                disabled={job.state === 'new' || job.state === 'reading' || job.state === 'cleaning'}
                onPress={() => router.push({ pathname: target, params: { id: job.id, share: '0' } })}
                style={[styles.row, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="smallBold">{job.name}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {[formatBytes(job.size), rowStatus(job)].filter(Boolean).join(' · ')}
                </ThemedText>
                {job.state === 'ready' && job.report?.supported ? <ChipRow findings={displayFindings(job.report)} /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <View style={[styles.bar, { backgroundColor: theme.background, borderTopColor: theme.backgroundSelected, paddingBottom: Spacing.three + insets.bottom }]}>
        {phase === 'ready' ? (
          <>
            <Button testID="clean-all-share" label={strings.batch.cleanAllShare} onPress={() => cleanAll(true)} />
            <Button testID="clean-all" variant="secondary" label={strings.batch.cleanAll} onPress={() => cleanAll(false)} />
          </>
        ) : null}
        {phase === 'cleaning' ? (
          <CleanProgress
            progress={jobs.find((j) => j.state === 'cleaning')?.progress}
            onCancel={() => {
              cancelRef.current = true;
              setCancelled(true);
              if (currentId.current) cancelClean(currentId.current);
            }}
          />
        ) : null}
        {phase === 'finished' && counts.clean > 0 ? (
          <Button testID="share-all" label={strings.batch.shareAll(counts.clean)} onPress={() => void shareAll()} />
        ) : null}
        {phase === 'finished' ? <Button testID="batch-done" variant={counts.clean > 0 ? 'secondary' : 'primary'} label={strings.result.done} onPress={done} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.three },
  working: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  progress: { gap: Spacing.two },
  rows: { gap: Spacing.two },
  row: { borderRadius: 12, padding: Spacing.three, gap: Spacing.one },
  bar: { gap: Spacing.two, padding: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 64 },
});
