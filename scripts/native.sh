#!/usr/bin/env bash
# Build, install and launch the app on the default simulator/emulator.
# Usage: scripts/native.sh <ios|android> [development|preview|production]
#   development: Debug build that loads JavaScript from Metro (start it with `npm run dev`).
#   preview/production: Release build with JavaScript embedded; runs without Metro.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

platform=${1:?Usage: native.sh <ios|android> [development|preview|production]}
variant=${2:-development}
export APP_VARIANT=$variant

# ios/ and android/ are generated from app.config.ts (never edit them by hand).
# Regenerate when the variant, app config or native dependencies change.
shopt -s nullglob # no modules/ yet (P6 adds it): the glob must expand to nothing, not fail
marker="$platform/.generated-for"
# A new local module (modules/*/expo-module.config.json, P6) also needs a fresh prebuild + pod install.
# The share-extension sources and the build flags read by app.config.ts (P5) change the native project too.
stamp="$variant $( (cat app.config.ts package.json package-lock.json plugins/*.js plugins/*/* modules/*/expo-module.config.json
  echo "SHARE_EXTENSION=${SHARE_EXTENSION:-} SHARE_OPEN_APP=${SHARE_OPEN_APP:-} APPLE_TEAM_ID=${APPLE_TEAM_ID:-}") | shasum | cut -c1-12)"
if [[ ! -f $marker || "$(cat "$marker")" != "$stamp" ]]; then
  # macOS 27 host + Xcode 26.6: the bare `clang` in CocoaPods' stub-xcframework step picks the Command Line Tools
  # SDK 27, whose .tbd Xcode 26's ld cannot read ("tapi error: malformed file"). Pin the SDK shipped with Xcode.
  # PREBUILD_FLAGS= (empty) regenerates in place without --clean (nothing is deleted).
  SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" npx expo prebuild ${PREBUILD_FLAGS:---no-clean} --platform "$platform"
  echo "$stamp" >"$marker"
fi

device=$(scripts/boot.sh "$platform")

if [[ $platform == ios ]]; then
  args=(--device "$device")
  # --no-bundler and --port are mutually exclusive on this Expo CLI: development attaches to the
  # already-running Metro (npm run dev) on our dedicated port; release builds embed JS and need no bundler.
  if [[ $variant == development ]]; then
    args+=(--port "$METRO_PORT")
  else
    args+=(--no-bundler --configuration Release)
  fi
  mkdir -p artifacts
  set +e
  npx expo run:ios "${args[@]}" 2>&1 | tee artifacts/run-ios.log
  status=${PIPESTATUS[0]}
  set -e
  # Expo's final "focus Simulator window" step needs macOS Automation permission; the app is already launched.
  if [[ $status -ne 0 ]] && grep -q "› Opening on" artifacts/run-ios.log && grep -q "System Events" artifacts/run-ios.log; then
    echo "App installed and opened (ignored Simulator window-focus error)."
    status=0
  fi
  exit "$status"
else
  args=(--device "$ANDROID_AVD")
  if [[ $variant == development ]]; then
    args+=(--port "$METRO_PORT")
  else
    args+=(--no-bundler --variant release)
  fi
  npx expo run:android "${args[@]}"
fi

# Dev builds: point the dev client at THIS app's Metro port (other apps run Metro on 8081, 8091, 8095).
if [[ $variant == development ]]; then
  scheme=$(npx expo config --json --type public | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).scheme)')
  url="$scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$METRO_PORT"
  if [[ $platform == ios ]]; then
    xcrun simctl openurl "$device" "$url" >/dev/null 2>&1 || true
  else
    adb -s "$device" shell am start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1 || true
  fi
fi
