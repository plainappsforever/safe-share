import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Card, Section } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { JS_LICENCES, NATIVE_LICENCES, type LicenceEntry } from '@/lib/licences.generated';
import { strings } from '@/lib/strings';

type Topic = 'removes' | 'apps' | 'privacy' | 'licences';

const TITLES: Record<Topic, string> = {
  removes: strings.settings.removes,
  apps: strings.settings.apps,
  privacy: strings.settings.privacy,
  licences: strings.settings.licences,
};

function Paragraph({ title, children, testID }: { title?: string; children: string; testID?: string }) {
  return (
    <View style={styles.paragraph} testID={testID}>
      {title ? (
        <ThemedText type="smallBold" accessibilityRole="header">
          {title}
        </ThemedText>
      ) : null}
      <ThemedText type="small">{children}</ThemedText>
    </View>
  );
}

function Removes() {
  const t = strings.info.removes;
  return (
    <>
      <ThemedText>{t.intro}</ThemedText>
      {t.groups.map(([title, text]) => (
        <Paragraph key={title} title={title}>
          {text}
        </Paragraph>
      ))}
      <Paragraph title={t.keptTitle}>{t.kept}</Paragraph>
      <Paragraph title={t.videoTitle}>{t.video}</Paragraph>
      <Paragraph title={t.pdfTitle}>{t.pdf}</Paragraph>
      <Card>
        <Paragraph title={t.limitsTitle}>{t.limits}</Paragraph>
      </Card>
    </>
  );
}

function Apps() {
  const t = strings.info.apps;
  return (
    <>
      <ThemedText type="smallBold">{t.intro}</ThemedText>
      <Paragraph>{t.some}</Paragraph>
      <Section title={t.notTitle}>
        {t.not.map((line) => (
          <ThemedText key={line} type="small">
            • {line}
          </ThemedText>
        ))}
      </Section>
      <Card>
        <ThemedText type="small">{t.advice}</ThemedText>
      </Card>
    </>
  );
}

function Privacy() {
  return (
    <>
      {strings.info.privacy.items.map(([title, text]) => (
        <Paragraph key={title} title={title}>
          {text}
        </Paragraph>
      ))}
    </>
  );
}

function LicenceRow({ e }: { e: LicenceEntry }) {
  return (
    <View style={styles.licence} accessible accessibilityLabel={`${e.name} ${e.version}, ${e.licence}${e.copyright ? `. ${e.copyright}` : ''}`}>
      <ThemedText type="small">
        {e.name} <ThemedText type="small" themeColor="textSecondary">{e.version}</ThemedText>
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {e.licence}
        {e.copyright ? ` · ${e.copyright}` : ''}
      </ThemedText>
    </View>
  );
}

function Licences() {
  return (
    <>
      <ThemedText>{strings.info.licencesIntro}</ThemedText>
      <Section title={strings.info.licencesNative}>
        {NATIVE_LICENCES.map((e) => (
          <LicenceRow key={e.name} e={e} />
        ))}
      </Section>
      <Section title={`${strings.info.licencesJs} — ${strings.info.licencesCount(JS_LICENCES.length)}`}>
        {JS_LICENCES.map((e) => (
          <LicenceRow key={`${e.name}@${e.version}`} e={e} />
        ))}
      </Section>
    </>
  );
}

/** Settings → About: one screen for the four information pages (SPEC F7). Plain text that scrolls at any font size. */
export default function InfoScreen() {
  const { topic } = useLocalSearchParams<{ topic?: string }>();
  const theme = useTheme();
  const t: Topic = topic === 'apps' || topic === 'privacy' || topic === 'licences' ? topic : 'removes';
  return (
    <>
      <Stack.Screen options={{ title: TITLES[t] }} />
      <ScrollView testID={`info-${t}-screen`} style={{ backgroundColor: theme.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {t === 'removes' ? <Removes /> : t === 'apps' ? <Apps /> : t === 'privacy' ? <Privacy /> : <Licences />}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.three, gap: Spacing.three },
  paragraph: { gap: Spacing.one },
  licence: { gap: 0, paddingVertical: Spacing.one },
});
