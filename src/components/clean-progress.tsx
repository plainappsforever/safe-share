import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Progress } from '@/lib/pipeline';
import { strings } from '@/lib/strings';

import { Button } from './button';
import { ThemedText } from './themed-text';

/**
 * What a running clean looks like (P7, P4-6): a progress bar that moves while the readers check the copy, and a Cancel
 * button that works at any moment. The bar is a real progressbar for screen readers.
 */
export function CleanProgress({ progress, onCancel, testID = 'cleaning' }: { progress?: Progress; onCancel: () => void; testID?: string }) {
  const theme = useTheme();
  const [cancelling, setCancelling] = useState(false);
  const pct = progress?.stage === 'checking' ? Math.min(100, Math.max(0, Math.round(progress.fraction * 100))) : 0;
  const text = cancelling
    ? strings.progress.cancelling
    : progress?.stage === 'checking'
      ? strings.progress.checking(pct)
      : progress?.stage === 'cleaning'
        ? strings.progress.cleaning
        : strings.progress.copying;
  return (
    <View testID={testID} style={styles.box}>
      <View style={styles.line}>
        {progress?.stage === 'checking' ? null : <ActivityIndicator />}
        <ThemedText testID="clean-progress-text" style={styles.text} accessibilityLiveRegion="polite">
          {text}
        </ThemedText>
      </View>
      <View
        testID="clean-progress"
        accessibilityRole="progressbar"
        accessibilityLabel={strings.progress.label}
        accessibilityValue={{ min: 0, max: 100, now: pct }}
        style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: theme.tint }]} />
      </View>
      <Button
        testID="cancel-clean"
        variant="secondary"
        label={strings.progress.cancel}
        disabled={cancelling}
        onPress={() => {
          setCancelling(true);
          onCancel();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: Spacing.two },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  text: { flex: 1 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
});
