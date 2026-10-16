#!/usr/bin/env bash
# Regenerates every fixture in test/fixtures (macOS only: Swift, ImageIO, AVFoundation, CoreGraphics, sips).
# Outputs are committed; run this only when a generator changes, then review `git diff --stat`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
out=test/fixtures
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"
for tool in make-images make-video make-pdf; do
  swiftc -O "scripts/fixtures/$tool.swift" -o "$tmp/$tool" 2>&1 | grep -E "error" || true
  "$tmp/$tool" "$out"
done
node scripts/fixtures/make-synthetic.mjs "$out"
# V1.5-1: TIFF/GIF bases (ImageIO) and the 3GP (AVFoundation) go to $tmp, make-v15.mjs adds DNG, NEF, meta.gif, voice.m4a.
"$tmp/make-images" "$tmp" v15
"$tmp/make-video" "$tmp" v15
node scripts/fixtures/make-v15.mjs "$tmp" "$out"
node scripts/fixtures/make-p4-pdfs.mjs "$out" 2>/dev/null
node scripts/fixtures/make-manifest.mjs
swiftc -O scripts/decode-check.swift -o "$tmp/decode-check" 2>&1 | grep -E "error" || true
(cd "$out" && "$tmp/decode-check" $(ls | grep -v -E "manifest.json|corrupt.jpg"))
