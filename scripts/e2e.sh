#!/usr/bin/env bash
# Run Maestro flows against the build already installed on the simulator/emulator.
# Usage: scripts/e2e.sh <ios|android> [development|preview|production] [flow.yaml ...]
# With no flows, runs every top-level flow in .maestro/.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh

platform=${1:?Usage: e2e.sh <ios|android> [variant] [flows...]}
variant=${2:-development}
shift $(($# >= 2 ? 2 : 1))
flows=("$@")
[[ ${#flows[@]} -gt 0 ]] || flows=(.maestro)

app_id=$(APP_VARIANT=$variant npx expo config --json --type public | node -e \
  'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).ios.bundleIdentifier)')

# curl is blocked on this Mac: check Metro with node's fetch.
if [[ $variant == development ]] && ! node -e 'fetch("http://localhost:"+process.argv[1]+"/status").then((r) => r.text()).then((t) => process.exit(t.includes("running") ? 0 : 1)).catch(() => process.exit(1))' "$METRO_PORT"; then
  echo "Metro is not running. Start it with: npm run dev (port $METRO_PORT)" >&2
  exit 1
fi

device=$(scripts/boot.sh "$platform")
# Maestro cannot run shell commands, so the fixtures the flows open with the debug deep link are pushed here, once per run
# (development variant only; they live in <cache>/debug-in/, which the launch cleanup leaves alone).
if [[ $variant == development ]]; then
  fixtures=()
  # test/fixtures (described by the manifest) + test/fixtures-device (P7: hexstm.pdf, empty.jpg, notes.txt)
  while IFS= read -r f; do fixtures+=("$f"); done < <(find test/fixtures test/fixtures-device -maxdepth 1 -type f ! -name manifest.json ! -name '.*' | sort)
  APP_ID="$app_id" scripts/push-fixtures.sh "$platform" "${fixtures[@]}"
fi
out="artifacts/maestro/$platform-$variant-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
echo "Maestro: $app_id on $platform ($device) -> $out"
# Flows tagged for the other platform are skipped; dev-only flows (FS self-test button) need the development variant.
other=$([[ $platform == ios ]] && echo android || echo ios)
exclude="$other-only"
[[ $variant == development ]] && exclude+=",preview-only" || exclude+=",dev-only"
maestro --device "$device" test -e APP_ID="$app_id" --exclude-tags "$exclude" --test-output-dir "$out" "${flows[@]}"
