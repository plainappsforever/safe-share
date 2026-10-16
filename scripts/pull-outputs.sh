#!/usr/bin/env bash
# Pulls cleaned copies (and their job.json) out of the app's work folder into artifacts/outputs/<platform>/ and
# checks them with the ExifTool referee (check-outputs.mjs). Needs the app to have kept them: Settings -> "Keep outputs"
# on, or simply do not press Done (the folder is only wiped on Done, on Home and at launch). Dev build only.
# Usage: scripts/pull-outputs.sh <ios|android>
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

platform=${1:?Usage: pull-outputs.sh <ios|android>}
app_id=${APP_ID:-com.tim.safeshare.dev}
device=$(scripts/boot.sh "$platform")
stamp=$(date +%Y%m%d-%H%M%S)
raw="artifacts/outputs/$platform/$stamp/raw"   # one folder per pull; nothing is deleted
mkdir -p "$raw"
ln -sfn "$stamp" "artifacts/outputs/$platform/latest"

case "$platform" in
  ios)
    data=$(xcrun simctl get_app_container "$device" "$app_id" data)
    [[ -d "$data/Library/Caches/work" ]] && cp -R "$data/Library/Caches/work/." "$raw/" || true
    ;;
  android)
    # run-as cannot write to shared storage: tar the work folder to stdout.
    adb -s "$device" exec-out run-as "$app_id" tar -C cache/work -cf - . 2>/dev/null | tar -C "$raw" -xf - || true
    ;;
  *) echo "Usage: pull-outputs.sh <ios|android>" >&2; exit 1 ;;
esac

node scripts/lib/sort-outputs.mjs "artifacts/outputs/$platform"
