#!/usr/bin/env bash
# Independent referee: dump every metadata field ExifTool can find (13.59 via exiftool-vendored.pl).
# Usage: scripts/exif-check.sh <file...>   (JSON array on stdout)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exiftool="$root/node_modules/exiftool-vendored.pl/bin/exiftool"
[[ -x "$exiftool" ]] || { echo "ExifTool missing: run npm install" >&2; exit 2; }
exec /usr/bin/perl "$exiftool" -a -G1 -ee3 -u -j "$@"
