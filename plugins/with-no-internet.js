// Removes android.permission.INTERNET from the Android manifest (D43). Applied to preview and
// production only: development builds need it to reach Metro. Release JS is embedded and the app
// uses no network; links open in the browser, which is another app with its own permission.
// Two parts: drop the permission Expo's prebuild template declares in the app manifest, and add a
// tools:node="remove" marker so a library manifest cannot bring it back during the manifest merge.
const { withAndroidManifest } = require('expo/config-plugins');

const INTERNET = 'android.permission.INTERNET';

module.exports = function withNoInternet(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const others = (manifest['uses-permission'] ?? []).filter((p) => p.$['android:name'] !== INTERNET);
    others.push({ $: { 'android:name': INTERNET, 'tools:node': 'remove' } });
    manifest['uses-permission'] = others;
    return mod;
  });
};
