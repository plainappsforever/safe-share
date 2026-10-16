import { View } from 'react-native';

import { Spacing } from '@/constants/theme';
import type { Field } from '@/engine/catalog';
import type { KeepReason } from '@/engine/profiles';
import { strings } from '@/lib/strings';
import { groupFields, uniqueNames } from '@/lib/summary';

import { ThemedText } from './themed-text';
import { Section } from './ui';

/** Names of the removed fields, grouped ("Location: Latitude, Longitude"). Shared by Inspect (plan) and Result (done). */
export function RemovedList({ fields, title, empty, testID }: { fields: Field[]; title: string; empty: string; testID: string }) {
  return (
    <Section title={title} testID={testID}>
      {fields.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {empty}
        </ThemedText>
      ) : (
        groupFields(fields).map((g) => (
          <View key={g.group} style={{ paddingLeft: Spacing.two }}>
            <ThemedText type="small">
              <ThemedText type="smallBold">{g.label}: </ThemedText>
              {uniqueNames(g.fields)
                .map((n) => (n.count > 1 ? `${n.name} ×${n.count}` : n.name))
                .join(', ')}
            </ThemedText>
          </View>
        ))
      )}
    </Section>
  );
}

/** Kept fields, each with the reason ("Orientation — needed so it is shown the right way up"). */
export function KeptList({ kept, title, empty, testID }: { kept: { field: Field; reason: KeepReason }[]; title: string; empty: string; testID: string }) {
  const rows = new Map<string, { name: string; reason: KeepReason; count: number }>();
  for (const k of kept) {
    const key = `${k.field.name}|${k.reason}`;
    const cur = rows.get(key);
    if (cur) cur.count++;
    else rows.set(key, { name: k.field.name, reason: k.reason, count: 1 });
  }
  return (
    <Section title={title} testID={testID}>
      {rows.size === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {empty}
        </ThemedText>
      ) : (
        [...rows.values()].map((r) => (
          <View key={`${r.name}|${r.reason}`} style={{ paddingLeft: Spacing.two }}>
            <ThemedText type="small">
              <ThemedText type="smallBold">{r.count > 1 ? `${r.name} ×${r.count}` : r.name}</ThemedText>
              {' — '}
              {strings.keepReasons[r.reason]}
            </ThemedText>
          </View>
        ))
      )}
    </Section>
  );
}
