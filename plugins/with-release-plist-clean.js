// P8 (N9 follow-up): the iOS Info.plist of a preview/production build must carry no dev-tooling keys. expo-dev-client's
// config plugin adds them to every variant; found in the built Release .app: NSBonjourServices (_expo._tcp), a local-network
// usage description ("Expo Dev Launcher uses the local network ...") and NSAllowsLocalNetworking. Safe Share makes no network
// requests (D13), so a store build must not even mention the local network. Development builds keep them (Metro).
// Mods run in reverse order of the plugin list: this plugin must stay ABOVE 'expo-dev-client' so it runs after it.
const { withInfoPlist } = require('expo/config-plugins');

const KEYS = ['NSBonjourServices', 'NSLocalNetworkUsageDescription', 'EXDevMenuShowFloatingActionButton', 'EXDevMenuIsOnboardingFinished', 'EXDevMenuShowsAtLaunch'];

module.exports = function withReleasePlistClean(config) {
  return withInfoPlist(config, (mod) => {
    for (const k of KEYS) delete mod.modResults[k];
    const ats = mod.modResults.NSAppTransportSecurity;
    if (ats) {
      delete ats.NSAllowsLocalNetworking;
      if (Object.keys(ats).length === 0) delete mod.modResults.NSAppTransportSecurity;
    }
    return mod;
  });
};
