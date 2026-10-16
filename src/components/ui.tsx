import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';

import { Spacing } from '@/constants/theme';
import type { Field, Finding } from '@/engine/catalog';
import { useTheme } from '@/hooks/use-theme';
import { displayValue } from '@/lib/location';
import { strings } from '@/lib/strings';
import { groupFields } from '@/lib/summary';

import { ThemedText } from './themed-text';

/** Finding colours: red / orange / grey, no score (SPEC F2). Text stays the theme colour, so contrast holds in both themes. */
const LEVEL_BG = {
  red: { light: '#FDE3E1', dark: '#4A1F1F', dot: '#D93025' },
  orange: { light: '#FFEBD1', dark: '#4A3315', dot: '#E37400' },
  grey: { light: '#E6E7EA', dark: '#2E3135', dot: '#80868B' },
} as const;

export function Chip({ level, label, testID }: { level: Finding['level']; label: string; testID?: string }) {
  const theme = useTheme();
  const dark = theme.background === '#000000';
  const c = LEVEL_BG[level];
  return (
    <View testID={testID} accessible accessibilityLabel={label} accessibilityHint={strings.a11y.level[level]} style={[styles.chip, { backgroundColor: dark ? c.dark : c.light }]}>
      <View style={[styles.dot, { backgroundColor: c.dot }]} />
      <ThemedText type="small" style={styles.chipText}>
        {label}
      </ThemedText>
    </View>
  );
}

export function ChipRow({ findings, testIDPrefix }: { findings: Finding[]; testIDPrefix?: string }) {
  return (
    <View style={styles.chipRow}>
      {findings.map((f) => (
        <Chip key={f.id} level={f.level} label={f.label} testID={testIDPrefix ? `${testIDPrefix}-${f.id}` : undefined} />
      ))}
    </View>
  );
}

export function Section({ title, children, testID }: { title: string; children: React.ReactNode; testID?: string } & ViewProps) {
  return (
    <View testID={testID} style={styles.section}>
      <ThemedText type="smallBold" accessibilityRole="header">
        {title}
      </ThemedText>
      {children}
    </View>
  );
}

export function Card({ children, testID, color }: { children: React.ReactNode; testID?: string; color?: string }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[styles.card, { backgroundColor: color ?? theme.backgroundElement }]}>
      {children}
    </View>
  );
}

/** One radio row: used for profiles. */
export function RadioRow({ selected, title, description, onPress, testID }: { selected: boolean; title: string; description: string; onPress: () => void; testID: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={`${title}. ${description}`}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={[styles.radio, { backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement, borderColor: selected ? theme.tint : 'transparent' }]}>
      <View style={[styles.radioDot, { borderColor: theme.tint }]}>{selected ? <View style={[styles.radioDotFill, { backgroundColor: theme.tint }]} /> : null}</View>
      <View style={styles.radioText}>
        <ThemedText type="smallBold">{title}</ThemedText>
        {/* Secondary text grows with the system font up to 2x: at the very largest sizes a profile row would otherwise be taller than the screen. */}
        <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={2}>
          {description}
        </ThemedText>
      </View>
    </Pressable>
  );
}

/** Every value found, grouped (SPEC F2 "Details"): human name, value, raw tag small underneath. */
export function FieldDetails({ fields }: { fields: Field[] }) {
  return (
    <View style={styles.details}>
      {groupFields(fields).map((g) => (
        <View key={g.group} style={styles.group}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            {g.label}
          </ThemedText>
          {g.fields.map((f, i) => (
            <View key={`${f.id}-${i}`} style={styles.fieldRow} accessible accessibilityLabel={`${f.name}: ${displayValue(f)}`}>
              <ThemedText type="small">{f.name}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {displayValue(f)}
              </ThemedText>
              <ThemedText type="code" themeColor="textSecondary">
                {f.key}
              </ThemedText>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  chip: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, maxWidth: '100%', borderRadius: 16, paddingVertical: Spacing.one, paddingHorizontal: Spacing.two + 2 },
  chipText: { flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  section: { gap: Spacing.two },
  card: { borderRadius: 12, padding: Spacing.three, gap: Spacing.two },
  radio: { flexDirection: 'row', gap: Spacing.two, borderRadius: 12, borderWidth: 2, padding: Spacing.two + 4, alignItems: 'flex-start' },
  radioText: { flex: 1, gap: Spacing.one },
  radioDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  radioDotFill: { width: 10, height: 10, borderRadius: 5 },
  details: { gap: Spacing.three },
  group: { gap: Spacing.two },
  fieldRow: { gap: 0, paddingLeft: Spacing.two },
});
