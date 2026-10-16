import type { Profile } from '@/engine/profiles';

import type { Db } from './types';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'theme';
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
}

export async function getThemePreference(db: Db): Promise<ThemePreference> {
  const value = await getSetting(db, THEME_KEY);
  return THEMES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export function setThemePreference(db: Db, theme: ThemePreference): Promise<void> {
  return setSetting(db, THEME_KEY, theme);
}

const PROFILE_KEY = 'profile';
const KEEP_OUTPUTS_KEY = 'keepOutputs';
const PROFILE_VALUES: readonly Profile[] = ['all', 'location', 'camera'];

/** F3: the last profile chosen is remembered; "Remove everything" is the default. */
export async function getProfileSetting(db: Db): Promise<Profile> {
  const value = await getSetting(db, PROFILE_KEY);
  return PROFILE_VALUES.includes(value as Profile) ? (value as Profile) : 'all';
}

export function setProfileSetting(db: Db, profile: Profile): Promise<void> {
  return setSetting(db, PROFILE_KEY, profile);
}

/** Development builds only (no UI in other variants): Done and leaving the result keep the work folder until the next launch. */
export async function getKeepOutputs(db: Db): Promise<boolean> {
  return (await getSetting(db, KEEP_OUTPUTS_KEY)) === '1';
}

export function setKeepOutputs(db: Db, keep: boolean): Promise<void> {
  return setSetting(db, KEEP_OUTPUTS_KEY, keep ? '1' : '0');
}

export type FileNamePolicy = 'neutral' | 'original';
const FILE_NAMES_KEY = 'fileNames';

/** F5 / D18: neutral names (default) or the original file name. */
export async function getFileNamePolicy(db: Db): Promise<FileNamePolicy> {
  return (await getSetting(db, FILE_NAMES_KEY)) === 'original' ? 'original' : 'neutral';
}

export function setFileNamePolicy(db: Db, policy: FileNamePolicy): Promise<void> {
  return setSetting(db, FILE_NAMES_KEY, policy);
}
