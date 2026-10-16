import { useNavigation, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { getKeepOutputs } from '@/db/settings';
import { useTheme } from '@/hooks/use-theme';
import { clearJobs } from '@/lib/jobs';
import { nextFrame } from '@/lib/run';
import { hasPendingShares, setTakingShares, takeIncomingShares } from '@/lib/share-in';
import { strings } from '@/lib/strings';
import { IS_DEV_BUILD, wipeWork } from '@/lib/work';

/**
 * `<scheme>://expo-sharing` — opened by an Android share (expo-sharing turns ACTION_SEND into this link), by the iOS
 * share extension, and by the launch/foreground pickup in `_layout.tsx` (D16 R2 fallback). Takes the shared files into
 * the work folder and replaces the navigation with Home → Inspect (one file) or Home → Batch (several).
 */
export default function IncomingShare() {
  const router = useRouter();
  const navigation = useNavigation();
  const db = useSQLiteContext();
  const theme = useTheme();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setTakingShares(true);
    (async () => {
      try {
        await nextFrame();
        if (!hasPendingShares()) {
          if (router.canGoBack()) router.back();
          else router.replace('/');
          return;
        }
        // A new share replaces whatever was open: the previous copies are deleted (A14), unless a dev build keeps them.
        if (IS_DEV_BUILD && (await getKeepOutputs(db))) clearJobs();
        else wipeWork();
        const { jobs, failed } = await takeIncomingShares();
        if (failed > 0) Alert.alert(strings.appName, strings.incoming.failed(failed, failed + jobs.length));
        const next =
          jobs.length === 1 ? { name: 'inspect', params: { id: jobs[0].id } }
          : jobs.length > 1 ? { name: 'batch' }
          : null;
        // Home stays underneath and is not focused on the way, so its cleanup cannot race the new files.
        navigation.reset({ index: next ? 1 : 0, routes: next ? [{ name: 'index' }, next] : [{ name: 'index' }] } as never);
      } finally {
        setTakingShares(false);
      }
    })();
  }, [db, navigation, router]);

  return (
    <View testID="incoming-share" style={[styles.center, { backgroundColor: theme.background }]}>
      <ActivityIndicator />
      <ThemedText themeColor="textSecondary">{strings.incoming.opening}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.three },
});
