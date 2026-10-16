import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname, useRouter } from 'expo-router';
import { SQLiteProvider, type SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useRef } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { migrate } from '@/db/migrations';
import { getThemePreference } from '@/db/settings';
import { hasPendingShares, isTakingShares, sweepInbox } from '@/lib/share-in';
import { strings } from '@/lib/strings';
import { applyThemePreference } from '@/lib/theme-preference';
import { cleanWorkFolderAtLaunch } from '@/lib/work-fs';

// A14: received and cleaned copies never survive a restart. Shared files the iOS extension saved and the app has not
// picked up yet are NOT deleted: they are the D16 R2 fallback (sweepInbox only removes leftovers without a payload).
cleanWorkFolderAtLaunch();
sweepInbox();

// A deep link straight to a screen (debug/open) still has Home underneath it.
export const unstable_settings = { initialRouteName: 'index' };

async function initDatabase(db: SQLiteDatabase) {
  await migrate(db);
  applyThemePreference(await getThemePreference(db));
}

export default function RootLayout() {
  return (
    <SQLiteProvider databaseName="app.db" onInit={initDatabase}>
      <Navigator />
    </SQLiteProvider>
  );
}

/**
 * D16 R2 fallback: files shared while the app could not be opened (iOS extension without auto-open, or an Android share
 * that arrived before a restart) are picked up at launch and whenever the app comes to the foreground.
 */
function usePendingSharePickup() {
  const router = useRouter();
  const pathname = usePathname();
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);
  useEffect(() => {
    const check = () => {
      if (path.current !== '/expo-sharing' && !isTakingShares() && hasPendingShares()) router.push('/expo-sharing' as never);
    };
    const first = setTimeout(check, 300); // after a deep link at launch has been routed
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => {
      clearTimeout(first);
      sub.remove();
    };
  }, [router]);
}

function Navigator() {
  const scheme = useColorScheme();
  usePendingSharePickup();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="index" options={{ title: strings.home.title }} />
        <Stack.Screen name="inspect" options={{ title: strings.inspect.title }} />
        <Stack.Screen name="result" options={{ title: strings.result.title }} />
        <Stack.Screen name="batch" options={{ title: strings.batch.title }} />
        <Stack.Screen name="settings" options={{ title: strings.settings.title }} />
        <Stack.Screen name="info" options={{ title: strings.settings.about }} />
        <Stack.Screen name="debug/open" options={{ headerShown: false }} />
        <Stack.Screen name="expo-sharing" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}
