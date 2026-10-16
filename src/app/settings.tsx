import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ProfilePicker } from '@/components/profile-picker';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  getFileNamePolicy,
  getKeepOutputs,
  getProfileSetting,
  getThemePreference,
  setFileNamePolicy,
  setKeepOutputs,
  setProfileSetting,
  setThemePreference,
  type FileNamePolicy,
  type ThemePreference,
} from '@/db/settings';
import type { Profile } from '@/engine/profiles';
import { useTheme } from '@/hooks/use-theme';
import { getInjectPlatformError, getInjectPlatformOriginal, getInjectSlow, setInjectPlatformError, setInjectPlatformOriginal, setInjectSlow } from '@/lib/run';
import { strings } from '@/lib/strings';
import { applyThemePreference } from '@/lib/theme-preference';
import { IS_DEV_BUILD } from '@/lib/work';

/** A row of exclusive choices (selected state is announced; the label is the text). */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testIDPrefix: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: theme.backgroundElement }]} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testIDPrefix}-${option.value}`}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, checked: selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type={selected ? 'smallBold' : 'small'} style={styles.segmentText}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: strings.settings.themeSystem },
  { value: 'light', label: strings.settings.themeLight },
  { value: 'dark', label: strings.settings.themeDark },
];
const NAME_OPTIONS: { value: FileNamePolicy; label: string }[] = [
  { value: 'neutral', label: strings.settings.fileNamesNeutral },
  { value: 'original', label: strings.settings.fileNamesOriginal },
];
const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
  { value: 'on', label: strings.settings.on },
  { value: 'off', label: strings.settings.off },
];

const INFO_ROWS = [
  { topic: 'removes', label: strings.settings.removes },
  { topic: 'apps', label: strings.settings.apps },
  { topic: 'privacy', label: strings.settings.privacy },
  { topic: 'licences', label: strings.settings.licences },
] as const;

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const theme = useTheme();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>('all');
  const [names, setNames] = useState<FileNamePolicy>('neutral');
  const [themePreference, setThemeState] = useState<ThemePreference>('system');
  const [keepOutputs, setKeepState] = useState(false);
  const [inject, setInject] = useState(getInjectPlatformOriginal());
  const [slow, setSlow] = useState(getInjectSlow());
  const [readError, setReadError] = useState(getInjectPlatformError());

  useEffect(() => {
    getProfileSetting(db).then(setProfile);
    getFileNamePolicy(db).then(setNames);
    getThemePreference(db).then(setThemeState);
    getKeepOutputs(db).then(setKeepState);
  }, [db]);

  async function chooseProfile(p: Profile) {
    setProfile(p);
    await setProfileSetting(db, p);
  }

  async function chooseNames(value: FileNamePolicy) {
    setNames(value);
    await setFileNamePolicy(db, value);
  }

  async function chooseTheme(value: ThemePreference) {
    setThemeState(value);
    applyThemePreference(value);
    await setThemePreference(db, value);
  }

  async function chooseKeep(value: boolean) {
    setKeepState(value);
    await setKeepOutputs(db, value);
  }

  return (
    <ScrollView
      testID="settings-screen"
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <ThemedText type="smallBold" accessibilityRole="header">
        {strings.settings.defaultProfile}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {strings.settings.defaultProfileHint}
      </ThemedText>
      <ProfilePicker value={profile} onChange={chooseProfile} />

      <ThemedText type="smallBold" accessibilityRole="header" style={styles.section}>
        {strings.settings.fileNames}
      </ThemedText>
      <Segmented options={NAME_OPTIONS} value={names} onChange={chooseNames} testIDPrefix="names" />
      <ThemedText type="small" themeColor="textSecondary">
        {strings.settings.fileNamesHint}
      </ThemedText>

      <ThemedText type="smallBold" accessibilityRole="header" style={styles.section}>
        {strings.settings.appearance}
      </ThemedText>
      <Segmented options={THEME_OPTIONS} value={themePreference} onChange={chooseTheme} testIDPrefix="theme" />

      <ThemedText type="smallBold" accessibilityRole="header" style={styles.section}>
        {strings.settings.about}
      </ThemedText>
      <View style={[styles.list, { backgroundColor: theme.backgroundElement }]}>
        {INFO_ROWS.map((row) => (
          <Pressable
            key={row.topic}
            testID={`info-${row.topic}`}
            accessibilityRole="button"
            accessibilityLabel={row.label}
            onPress={() => router.push({ pathname: '/info', params: { topic: row.topic } })}
            style={styles.listRow}>
            <ThemedText style={styles.listLabel}>{row.label}</ThemedText>
            <ThemedText themeColor="textSecondary" accessibilityElementsHidden importantForAccessibility="no">
              ›
            </ThemedText>
          </Pressable>
        ))}
      </View>

      {IS_DEV_BUILD ? (
        <>
          <ThemedText type="smallBold" style={styles.section}>
            {strings.settings.keepOutputs}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {strings.settings.keepOutputsHint}
          </ThemedText>
          <Segmented options={ON_OFF} value={keepOutputs ? 'on' : 'off'} onChange={(v) => chooseKeep(v === 'on')} testIDPrefix="keep-outputs" />
          <ThemedText type="smallBold" style={styles.section}>
            {strings.settings.injectPlatform}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {strings.settings.injectPlatformHint}
          </ThemedText>
          <Segmented
            options={ON_OFF}
            value={inject ? 'on' : 'off'}
            onChange={(v) => {
              setInjectPlatformOriginal(v === 'on');
              setInject(v === 'on');
            }}
            testIDPrefix="inject-platform"
          />
          <ThemedText type="smallBold" style={styles.section}>
            {strings.settings.injectError}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {strings.settings.injectErrorHint}
          </ThemedText>
          <Segmented
            options={ON_OFF}
            value={readError ? 'on' : 'off'}
            onChange={(v) => {
              setInjectPlatformError(v === 'on');
              setReadError(v === 'on');
            }}
            testIDPrefix="inject-error"
          />
          <ThemedText type="smallBold" style={styles.section}>
            {strings.settings.injectSlow}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {strings.settings.injectSlowHint}
          </ThemedText>
          <Segmented
            options={ON_OFF}
            value={slow ? 'on' : 'off'}
            onChange={(v) => {
              setInjectSlow(v === 'on');
              setSlow(v === 'on');
            }}
            testIDPrefix="inject-slow"
          />
        </>
      ) : null}

      <ThemedText type="small" themeColor="textSecondary" style={styles.section} testID="version">
        {strings.settings.version} {Constants.expoConfig?.version} ({String(Constants.expoConfig?.extra?.appVariant)})
      </ThemedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.three,
    gap: Spacing.two,
  },
  section: {
    marginTop: Spacing.four,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: Spacing.one,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    borderRadius: 9,
    paddingHorizontal: Spacing.one,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { textAlign: 'center' },
  list: { borderRadius: 12, overflow: 'hidden' },
  listRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  listLabel: { flex: 1 },
});
