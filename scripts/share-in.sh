#!/usr/bin/env bash
# P5 device checks that need shell steps Maestro cannot do (development build, Metro running):
#   share  - Android: puts ss-photo.jpg / ss-photo.heic / ss-extras.jpg in the emulator's shared Pictures folder, then runs
#            .maestro/share-in/android-*.yaml (real shares from the Files app, SEND and SEND_MULTIPLE; the photo picker).
#            iOS: adds photo.heic to the simulator's Photos and runs .maestro/share-in/ios-*.yaml.
#   saved  - after .maestro/save.yaml: pulls what Save put in Pictures/Safe Share (Android) or the Photos library (iOS) and
#            compares every saved file byte for byte with the cleaned copies in the work folder, then runs the ExifTool
#            referee on the cleaned copies (scripts/pull-outputs.sh).
# Usage: scripts/share-in.sh <ios|android> <share|saved>
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
platform=${1:?Usage: share-in.sh <ios|android> <share|saved>}
what=${2:?Usage: share-in.sh <ios|android> <share|saved>}
app_id=${APP_ID:-com.tim.safeshare.dev}
device=$(scripts/boot.sh "$platform")
out="artifacts/share-in/$platform"
mkdir -p "$out"

if [[ $what == share ]]; then
  if [[ $platform == android ]]; then
    adb -s "$device" shell 'rm -f /sdcard/Pictures/ss-*'
    for f in photo.jpg photo.heic extras.jpg; do
      adb -s "$device" push "test/fixtures/$f" "/sdcard/Pictures/ss-$f" >/dev/null 2>&1
      adb -s "$device" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file:///sdcard/Pictures/ss-$f" >/dev/null
    done
    sleep 2
    flows=(.maestro/share-in/android-*.yaml)
  else
    xcrun simctl addmedia "$device" test/fixtures/photo.heic test/fixtures/gps.mov
    flows=(.maestro/share-in/ios-*.yaml)
  fi
  # The Android flows expect no media-location permission (the picker flow proves the Files route needs none).
  [[ $platform == android ]] && adb -s "$device" shell pm revoke "$app_id" android.permission.ACCESS_MEDIA_LOCATION >/dev/null 2>&1 || true
  maestro --device "$device" test -e APP_ID="$app_id" --test-output-dir "$out/maestro" "${flows[@]}"
  if [[ $platform == ios ]]; then
    # A7 (P6): ios-picker.yaml runs last and leaves its two PHPicker copies in the work folder: they must be the
    # fixtures byte for byte (HEIC not converted, video not transcoded).
    data=$(xcrun simctl get_app_container "$device" "$app_id" data)
    n=0
    for f in "$data"/Library/Caches/work/*/in/*; do
      [[ -f $f ]] || continue
      b=$(basename "$f")
      if [[ -f test/fixtures/$b ]] && cmp -s "$f" "test/fixtures/$b"; then echo "PICKED IDENTICAL  $b"; n=$((n + 1)); else echo "PICKED DIFFERENT  $b"; fi
    done
    [[ $n -eq 2 ]] || { echo "expected 2 identical picker copies, got $n" >&2; exit 1; }
  fi
  exit 0
fi

# saved: byte comparison of saved files against the cleaned copies
scripts/pull-outputs.sh "$platform" | tail -5
saved="$out/saved-$(date +%Y%m%d-%H%M%S)"   # fresh folder per run; nothing is deleted
mkdir -p "$saved"
# Only the newest saves are compared (.maestro/save.yaml saves a photo and a video, and on Android a PDF too); run
# this right after it.
count=${SAVED_COUNT:-$([[ $platform == android ]] && echo 3 || echo 2)}
if [[ $platform == android ]]; then
  adb -s "$device" shell content query --uri content://media/external/file --projection _display_name:relative_path:mime_type |
    grep 'Safe Share/' || true
  # P6: photos in Pictures, videos in Movies, PDFs in Download (each "Safe Share"); newest first across all three.
  adb -s "$device" shell 'ls -t /sdcard/Pictures/Safe\ Share/* /sdcard/Movies/Safe\ Share/* /sdcard/Download/Safe\ Share/* 2>/dev/null' |
    tr -d '\r' | head -n "$count" | while IFS= read -r n; do adb -s "$device" pull "$n" "$saved/" >/dev/null 2>&1; done
else
  dcim="$HOME/Library/Developer/CoreSimulator/Devices/$device/data/Media/DCIM"
  find "$dcim" -type f -print0 | xargs -0 ls -t | head -n "$count" | while read -r f; do cp "$f" "$saved/"; done
fi
status=0
for f in "$saved"/*; do
  [[ -f $f ]] || continue
  match=""
  for o in $(find "artifacts/outputs/$platform/raw" -path '*/out/*' -type f); do
    if cmp -s "$f" "$o"; then match=$o; break; fi
  done
  if [[ -n $match ]]; then
    echo "IDENTICAL  $(basename "$f")  ==  ${match#artifacts/outputs/$platform/raw/}"
  else
    echo "DIFFERENT  $(basename "$f")  (no cleaned copy has these bytes)"
    status=1
  fi
done
exit $status
