import type { ConfigContext, ExpoConfig } from 'expo/config';

// One codebase, three installable variants that can sit side by side on a device.
// Select with APP_VARIANT (set by scripts/native.sh and eas.json).
const VARIANTS = {
  development: { name: 'Safe Share Dev', id: 'com.tim.safeshare.dev', scheme: 'safeshare-dev' },
  preview: { name: 'Safe Share Preview', id: 'com.tim.safeshare.preview', scheme: 'safeshare-preview' },
  production: { name: 'Safe Share', id: 'com.tim.safeshare', scheme: 'safeshare' },
} as const;

type Variant = keyof typeof VARIANTS;

const variant = (process.env.APP_VARIANT ?? 'development') as Variant;
if (!(variant in VARIANTS)) {
  throw new Error(`Unknown APP_VARIANT "${variant}". Use development, preview or production.`);
}
const { name, id, scheme } = VARIANTS[variant];

// Owner step at store time: set APPLE_TEAM_ID (not a secret) so device builds can sign the share extension's App Group.
// Simulator builds need no team id (extension targets are signed ad hoc, D16 / eye-app P6).
const appleTeamId = process.env.APPLE_TEAM_ID || undefined;
// iOS share extension (SPEC F1, D16). On by default; SHARE_EXTENSION=0 builds the app without the extension target.
const shareExtensionEnabled = process.env.SHARE_EXTENSION !== '0';
// R2 (D41): the extension opens Safe Share right after saving the files (Apple does not officially support this).
// SHARE_OPEN_APP=0 builds the review-safe variant: the extension only saves and says "open Safe Share"; the app picks
// the files up at launch. The pickup path is always built and is also used whenever opening the app fails at run time.
const shareOpensApp = process.env.SHARE_OPEN_APP !== '0';
const SHARE_MIME_TYPES = ['image/*', 'video/*', 'application/pdf'];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: 'safe-share',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: id,
    icon: './assets/expo.icon',
    ...(appleTeamId ? { appleTeamId } : {}),
    // N9 (P7.5): no encryption beyond what iOS itself provides (export compliance, asked on every TestFlight upload otherwise).
    config: { usesNonExemptEncryption: false },
    // B2 (P7.5): required-reason APIs, merged into Expo's default app manifest (UserDefaults CA92.1, boot time 35F9.1,
    // file timestamp C617.1). 1C8F.1: the app reads the share extension's App Group defaults through expo-sharing.
    // 3B52.1: sizes/dates of files the user picks in the document picker. The extension's own manifest:
    // plugins/with-privacy-manifests.js.
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1', '3B52.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
      ],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyTracking: false,
    },
  },
  android: {
    package: id,
    adaptiveIcon: {
      backgroundColor: '#1B78DD',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // N8 (P7.5): no Google Auto Backup of the settings database ("Nothing leaves your phone").
    allowBackup: false,
    // D17: the only runtime permission. Asked only when the user taps "Show the original location" (after one sentence).
    permissions: ['android.permission.ACCESS_MEDIA_LOCATION'],
    // D17: never broad storage/media/camera/microphone permissions. The pickers, share-in and saving (MediaStore, API 30+) need none.
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      // Pulled in by the dev tooling (expo-dev-menu); only development builds need the overlay (P7: found in the release manifest).
      ...(variant === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW']),
    ],
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#1B78DD', image: './assets/images/splash-icon.png', imageWidth: 200 }],
    'expo-sqlite',
    // Zero-prompt rule (A13): Safe Share never asks for photos, camera or microphone access.
    ['expo-image-picker', { photosPermission: false, cameraPermission: false, microphonePermission: false }],
    // Save (SPEC F5): iOS add-only Photos access, asked at the first Save after one sentence; never read access.
    [
      'expo-media-library',
      {
        photosPermission: false,
        savePhotosPermission: 'Safe Share adds the cleaned copy to your photos. It cannot see your other photos.',
        isAccessMediaLocationEnabled: true,
        granularPermissions: [],
      },
    ],
    // B2 (P7.5): the share extension's PrivacyInfo.xcprivacy. Must stay ABOVE expo-sharing (Xcode-project mods run in
    // reverse order, so the extension target exists when this one runs).
    './plugins/with-privacy-manifests.js',
    // Share into Safe Share (SPEC F1, D16): Android intent filters; iOS share extension that copies the files into the
    // App Group and hands them to the app. plugins/with-share-extension.js replaces the extension's view controller.
    [
      'expo-sharing',
      {
        android: { enabled: true, singleShareMimeTypes: SHARE_MIME_TYPES, multipleShareMimeTypes: SHARE_MIME_TYPES },
        ios: {
          enabled: shareExtensionEnabled,
          appGroupId: `group.${id}`,
          activationRule: { supportsImageWithMaxCount: 50, supportsMovieWithMaxCount: 50, supportsFileWithMaxCount: 50 },
        },
      },
    ],
    ...(shareExtensionEnabled ? [['./plugins/with-share-extension.js', { displayName: name, opensApp: shareOpensApp }] as [string, object]] : []),
    // P8: store-bound builds carry no dev-tooling Info.plist keys (local-network text, Bonjour). Must stay ABOVE expo-dev-client
    // (mods run in reverse order, so it runs after the dev client has added its keys).
    ...(variant === 'development' ? [] : ['./plugins/with-release-plist-clean.js']),
    // Dev builds reopen the last Metro server directly, so Maestro can launch them unattended.
    ['expo-dev-client', { launchMode: 'most-recent' }],
    './plugins/with-dev-menu-defaults.js',
    // A12 / D13: the Android release manifest has no INTERNET permission (development builds need it to reach Metro).
    ...(variant === 'development' ? [] : ['./plugins/with-no-internet.js']),
    // Xcode 27 / iOS 27 SDK: apps without the UIScene lifecycle trap at launch. SDK 57 opt-in (expo >= 57.0.23,
    // expo-build-properties >= 57.0.20); SDK 58+ has it by default, then remove this line. See docs/DECISIONS.md.
    ['expo-build-properties', { ios: { enableSceneSupport: true } }],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appVariant: variant,
  },
});
