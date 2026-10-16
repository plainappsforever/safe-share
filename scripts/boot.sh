#!/usr/bin/env bash
# Boot the default iOS simulator or Android emulator if needed; print its device id.
# Usage: scripts/boot.sh <ios|android>
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

case "${1:?Usage: boot.sh <ios|android>}" in
  ios)
    # IOS_SIMULATOR on the runtime IOS_RUNTIME selects (env.sh); created on that runtime if missing.
    udid=$(node scripts/ios-simulator.js)
    xcrun simctl bootstatus "$udid" -b >/dev/null
    # The window is optional (simctl booted the device headless). Xcode 27 ships no Simulator.app, so this may fail.
    open -g -a Simulator 2>/dev/null || true
    echo "$udid"
    ;;
  android)
    # Other apps run their own emulators in parallel: pick only the one running OUR AVD (D20, port 5584).
    find_serial() {
      for s in $(adb devices | awk '/^emulator-[0-9]+\tdevice$/ { print $1 }'); do
        if [[ "$(adb -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" == "$ANDROID_AVD" ]]; then echo "$s"; return; fi
      done
    }
    serial=$(find_serial)
    if [[ -z $serial ]]; then
      mkdir -p artifacts
      # -no-audio: host audio can hang the emulator. -crash-report-mode never: after a crash the next
      # boot otherwise waits forever on a "send crash report?" dialog nobody answers unattended.
      nohup emulator -avd "$ANDROID_AVD" -port "$ANDROID_EMULATOR_PORT" -no-boot-anim -no-snapshot-save -no-audio \
        -crash-report-mode never >artifacts/emulator.log 2>&1 &
      for _ in $(seq 1 90); do
        serial=$(find_serial)
        [[ -n $serial ]] && break
        sleep 2
      done
      [[ -n $serial ]] || { echo "Emulator $ANDROID_AVD did not start. See artifacts/emulator.log" >&2; exit 1; }
    fi
    until [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do sleep 2; done
    adb -s "$serial" reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" >/dev/null
    # Test-friendly emulator: no stylus-handwriting tutorial popping over the keyboard, no animations.
    adb -s "$serial" shell settings put secure stylus_handwriting_enabled 0
    for anim in window_animation_scale transition_animation_scale animator_duration_scale; do
      adb -s "$serial" shell settings put global "$anim" 0
    done
    echo "$serial"
    ;;
  *)
    echo "Usage: boot.sh <ios|android>" >&2
    exit 1
    ;;
esac
