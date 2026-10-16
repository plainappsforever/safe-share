/** The local native module (V1_PLAN P6), or null when this build does not contain it (callers keep the P4/P5 paths). */
import SafeShareNative from '../../modules/safe-share-native';

export const native = SafeShareNative;
export type { PickedFile } from '../../modules/safe-share-native';
