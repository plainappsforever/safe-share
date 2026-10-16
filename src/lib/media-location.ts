/**
 * Android media location (D17, SPEC F2): without ACCESS_MEDIA_LOCATION, Android blanks where a photo was taken before
 * handing it to Safe Share. Asked only when the user taps "Show the original location", after one sentence, and
 * never again after "Don't allow" (A13). Device only.
 */
import { Alert, PermissionsAndroid, Platform } from 'react-native';

import { getSetting, setSetting } from '@/db/settings';
import type { Db } from '@/db/types';

import { strings } from './strings';

const PERMISSION = 'android.permission.ACCESS_MEDIA_LOCATION' as const;
const ASKED_KEY = 'mediaLocationAsked';

export type MediaLocationState = 'granted' | 'ask' | 'refused' | 'n/a';

/** Android 10+ only; older Android versions and iOS never hide it this way. */
export function mediaLocationApplies(): boolean {
  return Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 29;
}

export async function mediaLocationState(db: Db): Promise<MediaLocationState> {
  if (!mediaLocationApplies()) return 'n/a';
  if (await PermissionsAndroid.check(PERMISSION)) return 'granted';
  return (await getSetting(db, ASKED_KEY)) === '1' ? 'refused' : 'ask';
}

export async function hasMediaLocation(): Promise<boolean> {
  return mediaLocationApplies() && PermissionsAndroid.check(PERMISSION);
}

/** One sentence of explanation, then the system prompt (once). Resolves true when allowed. */
export function explainThen(title: string, message: string, go: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: strings.common.notNow, style: 'cancel', onPress: () => resolve(false) },
      { text: go, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export async function askForMediaLocation(db: Db): Promise<MediaLocationState> {
  const state = await mediaLocationState(db);
  if (state !== 'ask') return state;
  const go = await explainThen(strings.location.askTitle, strings.location.askMessage, strings.location.askContinue);
  if (!go) return 'ask';
  await setSetting(db, ASKED_KEY, '1');
  const res = await PermissionsAndroid.request(PERMISSION);
  return res === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'refused';
}
