// Safe Share's changes to expo-sharing's iOS share extension (D16, D41). Runs after expo-sharing has written the
// extension target (ios/expo-sharing-extension/) and before the project is built:
//   - replaces the template view controller with plugins/share-extension/ShareIntoViewController.swift
//     (streams files into the App Group inbox, never processes them, keeps unpicked payloads, falls back to
//     "Saved — open Safe Share" whenever opening the app is switched off or fails);
//   - names the extension like the app in the share sheet (the template shows "expo-sharing-extension");
//   - SafeShareOpensApp: whether the extension may try to open the app (SHARE_OPEN_APP, R2).
const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withXcodeProject } = require('expo/config-plugins');

const TARGET = 'expo-sharing-extension';
const SOURCE = path.join(__dirname, 'share-extension', 'ShareIntoViewController.swift');

module.exports = function withShareExtension(config, { displayName, opensApp }) {
  // Dangerous mods (where expo-sharing writes the extension folder) always run before the Xcode-project mod
  // (@expo/config-plugins mod-compiler order), so the folder exists here.
  return withXcodeProject(config, (mod) => {
    const dir = path.join(mod.modRequest.platformProjectRoot, TARGET);
    if (!fs.existsSync(dir)) {
      throw new Error(`[safe-share] ${dir} is missing: expo-sharing did not create the share extension.`);
    }
    fs.copyFileSync(SOURCE, path.join(dir, 'ShareIntoViewController.swift'));
    const infoPath = path.join(dir, 'Info.plist');
    const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
    info.CFBundleDisplayName = displayName;
    info.SafeShareAppName = displayName;
    info.SafeShareOpensApp = Boolean(opensApp);
    fs.writeFileSync(infoPath, plist.build(info));
    return mod;
  });
};
