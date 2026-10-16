import { Link, Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getKeepOutputs } from '@/db/settings';
import { runDeviceEngineSmokeTest, runDeviceFsSelfTest } from '@/engine/expo-byte-file';
import { useTheme } from '@/hooks/use-theme';
import { pickFiles, pickPhotosAndVideos } from '@/lib/intake';
import type { Job } from '@/lib/jobs';
import { strings } from '@/lib/strings';
import { countWorkFiles, IS_DEV_BUILD, wipeWork } from '@/lib/work';


export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const db = useSQLiteContext();
  const [fsResult, setFsResult] = useState<string | null>(null);
  const [engineResult, setEngineResult] = useState<string | null>(null);
  const [workCount, setWorkCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // A14: arriving on Home means nothing is in flight, so no copy may stay behind (unless a dev build keeps outputs for scripts).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        if (!(IS_DEV_BUILD && (await getKeepOutputs(db)))) wipeWork();
        if (IS_DEV_BUILD && alive) setWorkCount(countWorkFiles());
      })();
      return () => {
        alive = false;
      };
    }, [db])
  );

  async function open(pick: () => Promise<Job[]>) {
    if (busy) return;
    setBusy(true);
    try {
      const jobs = await pick();
      if (jobs.length === 1) router.push({ pathname: '/inspect', params: { id: jobs[0].id } });
      else if (jobs.length > 1) router.push('/batch');
    } catch {
      Alert.alert(strings.appName, strings.home.pickFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable testID="open-settings" accessibilityLabel={strings.home.settings} hitSlop={8}>
                <ThemedText themeColor="tint">{strings.home.settings}</ThemedText>
              </Pressable>
            </Link>
          ),
        }}
      />
      <ScrollView
        testID="home-screen"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic">
        <Button testID="pick-photos" label={strings.home.photosAndVideos} disabled={busy} onPress={() => open(pickPhotosAndVideos)} style={styles.big} />
        <Button testID="pick-files" label={strings.home.files} disabled={busy} onPress={() => open(pickFiles)} style={styles.big} />
        <ThemedText testID="privacy-line" themeColor="textSecondary" style={styles.privacy}>
          {strings.home.privacyLine}
        </ThemedText>
        {/* Only where it is true (P1a row 5): the Android release manifest has no INTERNET permission (plugins/with-no-internet.js,
            checked with aapt on the preview build). Development builds need the internet to reach Metro, so they do not say it. */}
        {Platform.OS === 'android' && !IS_DEV_BUILD ? (
          <ThemedText testID="privacy-line-android" themeColor="textSecondary" style={styles.privacyAndroid}>
            {strings.home.privacyLineAndroid}
          </ThemedText>
        ) : null}
        {IS_DEV_BUILD ? (
          <>
            <Button
              testID="fs-selftest"
              variant="secondary"
              label={strings.home.fsSelfTest}
              onPress={() => {
                setFsResult(runDeviceFsSelfTest());
                setEngineResult(runDeviceEngineSmokeTest());
              }}
            />
            {fsResult ? <ThemedText testID="fs-selftest-result">{fsResult}</ThemedText> : null}
            {engineResult ? <ThemedText testID="engine-selftest-result">{engineResult}</ThemedText> : null}
            {workCount !== null ? (
              <ThemedText testID="work-count" themeColor="textSecondary" type="small">
                {strings.home.workCount(workCount)}
              </ThemedText>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.three,
    gap: Spacing.three,
  },
  big: {
    minHeight: 96,
  },
  privacy: {
    textAlign: 'center',
    marginTop: Spacing.two,
  },
  privacyAndroid: {
    textAlign: 'center',
  },
});
