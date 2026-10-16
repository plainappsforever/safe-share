import { View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { PROFILES, type Profile } from '@/engine/profiles';
import { strings } from '@/lib/strings';

import { RadioRow } from './ui';

/** F3: three profiles, last choice remembered by the caller. The descriptions say what else is removed (L11 P2-1). */
export function ProfilePicker({ value, onChange }: { value: Profile; onChange: (p: Profile) => void }) {
  return (
    <View style={{ gap: Spacing.two }} accessibilityRole="radiogroup">
      {PROFILES.map((p) => (
        <RadioRow key={p} testID={`profile-${p}`} selected={value === p} title={strings.profiles[p].title} description={strings.profiles[p].description} onPress={() => onChange(p)} />
      ))}
    </View>
  );
}
