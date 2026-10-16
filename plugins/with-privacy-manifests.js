// iOS privacy manifests (review B2, P7.5). Apple refuses uploads whose app or app-extension bundles use a
// "required reason" API without declaring why (ITMS-91053, enforced since 1 May 2024):
// https://developer.apple.com/documentation/bundleresources/privacy-manifest-files/describing-use-of-required-reason-api
//
// The share extension (expo-sharing's target running our plugins/share-extension/ShareIntoViewController.swift) uses:
//   - UserDefaults(suiteName: <App Group>)     -> NSPrivacyAccessedAPICategoryUserDefaults, reason 1C8F.1
//     ("access user defaults ... only accessible to the apps, app extensions, and App Clips in the same App Group");
//   - FileManager.attributesOfItem (file size) -> NSPrivacyAccessedAPICategoryFileTimestamp, reason C617.1
//     ("timestamps, size, or other metadata of files inside the app container, app group container ...").
// The app's own manifest (Expo's, merged with ios.privacyManifests in app.config.ts) gets 1C8F.1 as well, because the app
// reads the same App Group defaults through expo-sharing (SharingModule.swift), which ships no manifest of its own.
//
// ORDER MATTERS: list this plugin BEFORE 'expo-sharing' in app.config.ts. Xcode-project mods run in reverse order of
// registration, so the extension target that expo-sharing adds exists by the time this action runs.
const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withXcodeProject } = require('expo/config-plugins');

const TARGET = 'expo-sharing-extension';
const FILE = 'PrivacyInfo.xcprivacy';

const EXTENSION_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] },
    { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
  ],
};

/** The extension target's own PBXResourcesBuildPhase (expo-sharing names all its phases "Embed Foundation Extensions"). */
function resourcesPhaseOf(project, targetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const phases = project.hash.project.objects.PBXResourcesBuildPhase ?? {};
  const ref = (target?.buildPhases ?? []).find((p) => phases[p.value]);
  return ref ? phases[ref.value] : null;
}

function withPrivacyManifests(config) {
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const targetUuid = project.findTargetKey(TARGET) ?? project.findTargetKey(`"${TARGET}"`);
    if (!targetUuid) return mod; // SHARE_EXTENSION=0: no extension target, nothing to declare
    const dir = path.join(mod.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), plist.build(EXTENSION_MANIFEST));
    const group = Object.values(project.hash.project.objects.PBXGroup).find((g) => typeof g === 'object' && (g.path === TARGET || g.name === TARGET));
    const phase = resourcesPhaseOf(project, targetUuid);
    if (!group || !phase) throw new Error(`[safe-share] ${TARGET}: group or resources phase not found; is this plugin listed before expo-sharing?`);
    const fileRefs = project.hash.project.objects.PBXFileReference;
    if (Object.values(fileRefs).some((f) => typeof f === 'object' && f.path === FILE && group.children.some((c) => fileRefs[c.value] === f))) return mod;
    // Same shape as expo-sharing's own file references: a path relative to the extension group.
    const fileRef = project.generateUuid();
    const buildFile = project.generateUuid();
    fileRefs[fileRef] = { isa: 'PBXFileReference', name: FILE, path: FILE, sourceTree: '"<group>"', lastKnownFileType: 'text.xml', includeInIndex: 0 };
    fileRefs[`${fileRef}_comment`] = FILE;
    const buildFiles = project.hash.project.objects.PBXBuildFile;
    buildFiles[buildFile] = { isa: 'PBXBuildFile', fileRef, fileRef_comment: FILE };
    buildFiles[`${buildFile}_comment`] = `${FILE} in Resources`;
    group.children.push({ value: fileRef, comment: FILE });
    phase.files.push({ value: buildFile, comment: `${FILE} in Resources` });
    return mod;
  });
}

module.exports = withPrivacyManifests;
module.exports.EXTENSION_MANIFEST = EXTENSION_MANIFEST;
