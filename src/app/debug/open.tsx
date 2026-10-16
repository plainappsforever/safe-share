import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { clearJobs, getJobs } from '@/lib/jobs';
import { IS_DEV_BUILD, debugInFolder, importIntoWork } from '@/lib/work';

/**
 * Development builds only: `safeshare-dev://debug/open?names=a.jpg,b.mov` opens files that
 * `scripts/push-fixtures.sh` put in `<cache>/debug-in/` exactly as if they had been shared in (V1_PLAN, Architecture).
 * In preview/production the route redirects to Home and never touches a file.
 */
export default function DebugOpen() {
  const { names } = useLocalSearchParams<{ names?: string }>();
  const router = useRouter();
  const done = useRef(false);

  useEffect(() => {
    if (!IS_DEV_BUILD || done.current) return;
    done.current = true;
    clearJobs(); // a new debug open replaces the current jobs (their folders stay when "Keep outputs" is on)
    const list = String(names ?? '').split(',').map((n) => n.trim()).filter(Boolean);
    try {
      const dir = debugInFolder().uri.replace(/\/+$/, '');
      // Copy (not move): the pushed fixtures stay for the next flow.
      importIntoWork(list.map((n) => ({ uri: `${dir}/${n}`, name: n })), false, 'debug');
    } catch {
      // fall through to Home below
    }
    const jobs = getJobs();
    if (jobs.length === 1) router.replace({ pathname: '/inspect', params: { id: jobs[0].id } });
    else if (jobs.length > 1) router.replace('/batch');
    else router.replace('/');
  }, [names, router]);

  if (!IS_DEV_BUILD) return <Redirect href="/" />;
  return (
    <View testID="debug-open">
      <ThemedText>Opening…</ThemedText>
    </View>
  );
}
