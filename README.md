# Safe Share

Remove hidden data from photos, videos and PDFs. Offline, no ads, no account.

Before you send a photo, a video or a PDF, Safe Share shows you what the file secretly says about you, removes it, and reads the copy again to check. Then it hands the clean copy to the app you wanted to send it with.

**Get it:** [App Store](https://plainapps.dfdsfdsfsdf.workers.dev/apps/safe-share/) · [Google Play](https://plainapps.dfdsfdsfsdf.workers.dev/apps/safe-share/) · [GitHub Releases](https://github.com/plainappsforever/safe-share/releases) ·
[Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/plainappsforever/safe-share)

**Status:** first store release pending.

## Our promise

**Free, no ads, no tracking, no accounts.** This app keeps your data on your phone. It has no analytics, no crash
reporter, no advertising SDK and no sign-in. The Android release build has no INTERNET permission at all. We will not sell this app or this project to a company
that changes any of this.

Why we write it down: in 2023 a popular open-source Android suite was sold to an ad-funded app company and its store
listings started saying "Contains ads"; its community had to fork it to keep a clean version. The source code of
Safe Share is published under GPL-3.0, so if this promise were ever broken, anyone could continue the last
version that kept it.

## What it does

No account. No ads. No subscription. Works offline: the app has no internet permission.

HOW IT WORKS
1. Share a file into Safe Share from another app's Share menu, or pick files inside Safe Share. One file or many.
2. See what it says about you: exact location, phone model and serial number, when it was taken, your name or copyright, the editing app, hidden preview images. Plain names, technical names underneath.
3. Tap "Clean & share". Safe Share writes a new copy, checks it and, if the checks pass, opens the share sheet.
Your original is never changed. Safe Share only reads it and writes a new copy.

WHAT IT HANDLES
Photos: JPEG, PNG, WebP, HEIC/HEIF and AVIF. Videos: MP4, M4V and MOV. Documents: PDF. Anything else is listed as "Not supported yet — not changed" and is never called clean.
The picture, the video and sound, and the PDF pages are copied as they were: nothing is recompressed, resized or redrawn. Three profiles: "Remove everything" (default), "Location only" and "Keep camera settings".

CHECKED, NOT JUST CLAIMED
After cleaning, Safe Share reads the copy again, up to four ways: it reads the file structure, searches the copy byte by byte for every value it removed, runs a separate scan for known kinds of hidden data, and asks the phone's own reader. On Android the phone's own reader covers photos and videos but not PDFs, and the result says so. The result says "Verified clean" only when none of the checks found anything left. If something is left it says "Not fully clean" and names it. If a check cannot run it says "Could not verify". Nothing is called clean without proof.

MANY FILES AT ONCE
Clean a whole batch with a progress bar and a Cancel button. One bad file never stops the rest, and a summary tells you how many were verified clean, not fully clean or not supported.

SAVE OR SHARE
Share the clean copy straight from the result. On Android 10 and newer you can also save it: photos to Pictures/Safe Share, videos to Movies/Safe Share, PDFs to Download/Safe Share. By default copies get a neutral name (photo-4K7Q.jpg) because camera file names contain the date and time; Settings can keep the original names.

GOOD TO KNOW
- Safe Share cleans what is stored next to the picture. It cannot change what the picture shows: faces, house numbers, number plates, reflections. It does not look for invisible watermarks.
- Photos with HDR brightness data (Ultra HDR) lose that data and may look slightly less bright. Motion Photos lose their short video. The result tells you when this applies.
- In videos, hidden data is overwritten with zeros and the file keeps its size. Data inside the video and sound streams themselves, such as a time code, is not inspected.
- In PDFs, earlier saved versions of the file can stay inside; the result says so. Comment authors, attached files, form fields and signatures are reported, not removed, so such a file is shown as "Not fully clean".
- Photos chosen with Android's photo picker arrive without their location, an Android rule. Safe Share offers to open the file from Files instead.
- The clean copy is a new file with today's date.
- Some apps remove some hidden data themselves when you send a picture, but you cannot rely on it. Settings explains what to expect.

PRIVACY
Files are read, cleaned and checked on your phone. Nothing is uploaded. No account, no ads, no analytics, no crash reports, no tracking. Clean copies are temporary: they are deleted when you leave the result and every time the app starts. Safe Share keeps no history of your files, only your settings. "Show on map" opens your maps app with the coordinates when you tap it; Share hands the copy to the app you choose, which then follows its own rules.

Needs Android 7.0 or newer. The app is in English.

## Privacy

- All data is stored locally (SQLite in the app's private storage). Nothing is uploaded.
- Files leave the phone only when you share or export them yourself.
- Privacy policy: https://plainapps.dfdsfdsfsdf.workers.dev/apps/safe-share/privacy

## Build from source

The app identifier `com.tim.safeshare` is a placeholder: the identifier changes before the first store release.

You need: **Node.js 22 LTS** (the React Native version used here accepts `^20.19.4 || ^22.13.0 || ^24.3.0`), npm,
and git. The app is an [Expo](https://expo.dev) (SDK 57) / React Native app; the native `android/` and `ios/` folders
are generated from `app.config.ts` and are not in the repository.

```sh
git clone https://github.com/plainappsforever/safe-share.git
cd safe-share
npm ci
npm run verify          # typecheck + lint + all unit tests
```

### Android (Linux, macOS or Windows)

Needs JDK 17 and the Android SDK (Android Studio installs both; set `ANDROID_HOME`).

```sh
export APP_VARIANT=production
npx expo prebuild --platform android
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# APK: android/app/build/outputs/apk/release/ (signed with the debug key unless you configure your own key)
```

`APP_VARIANT` selects the app id and name (`development`, `preview`, `production`; see `app.config.ts`).
Builds made this way are signed with your key, not ours, so they cannot update an installed store version.

### iOS (macOS only)

Needs Xcode (26 or newer) and CocoaPods.

```sh
export APP_VARIANT=production
npx expo prebuild --platform ios
npx expo run:ios --configuration Release        # runs on the iOS Simulator
```

For a real iPhone, open `ios/*.xcworkspace` in Xcode, choose your own team under *Signing & Capabilities*
and change the bundle identifier. There is no sideloading store for iOS; the App Store build is ours.

## Verifying a release

Every GitHub release lists SHA-256 checksums (`SHA256SUMS.txt`) and the APKs are signed with one key per app.
Certificate SHA-256 fingerprint: `not yet published on Android`

## How this app was made

Safe Share was written with substantial help from an AI coding assistant (Claude Code), directed, reviewed and
tested by the maintainer. We say this openly because some stores and users care about it.

## Licence

Copyright (C) 2026 Farija Retkoceri

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, version 3 (GPL-3.0-only). See [LICENSE](LICENSE).
Third-party components keep their own licences (see `LICENSES/` and the app's licences screen where present).
Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
