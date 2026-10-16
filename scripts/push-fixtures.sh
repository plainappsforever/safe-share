#!/usr/bin/env bash
# Puts files where the dev-only debug deep link finds them: <app cache>/debug-in/ (V1_PLAN, Architecture).
# Usage: scripts/push-fixtures.sh <ios|android> <file...>
#   then open them with: safeshare-dev://debug/open?names=photo.jpg,gps.mov
# Only OUR simulator (SafeShare iPhone, by UDID) and emulator (serial from boot.sh) are used.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

platform=${1:?Usage: push-fixtures.sh <ios|android> <file...>}
shift
[[ $# -gt 0 ]] || { echo "No files given" >&2; exit 1; }
app_id=${APP_ID:-com.tim.safeshare.dev}
device=$(scripts/boot.sh "$platform")

case "$platform" in
  ios)
    data=$(xcrun simctl get_app_container "$device" "$app_id" data)
    mkdir -p "$data/Library/Caches/debug-in"
    for f in "$@"; do cp -f "$f" "$data/Library/Caches/debug-in/$(basename "$f")"; done
    ;;
  android)
    adb -s "$device" shell run-as "$app_id" mkdir -p cache/debug-in
    for f in "$@"; do
      n=$(basename "$f")
      adb -s "$device" push "$f" "/data/local/tmp/ss-$n" >/dev/null
      adb -s "$device" shell run-as "$app_id" cp "/data/local/tmp/ss-$n" "cache/debug-in/$n"
      adb -s "$device" shell rm -f "/data/local/tmp/ss-$n"
    done
    ;;
  *) echo "Usage: push-fixtures.sh <ios|android> <file...>" >&2; exit 1 ;;
esac
echo "pushed $# file(s) to $platform ($device)"
