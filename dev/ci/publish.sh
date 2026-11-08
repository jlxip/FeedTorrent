#!/bin/sh
set -eu
: "${RELEASE_TAG:?Release tag is required}"
case "$RELEASE_TAG" in v?*) ;; *) echo 'Invalid release tag' >&2; exit 1;; esac
case "$RELEASE_TAG" in *[!a-zA-Z0-9._-]*) echo 'Invalid release tag' >&2; exit 1;; esac
test "$(find . -maxdepth 1 -name '*.tar.gz' | wc -l)" -eq 3
test "$(find . -maxdepth 1 -name '*.sha256' | wc -l)" -eq 3
for target in macos-arm64 linux-amd64 openbsd-8.0-amd64; do
  test -f "feedtorrent-${RELEASE_TAG}-${target}.tar.gz"
done
sha256sum -c -- *.sha256
# Keep an interrupted upload hidden; publish only the complete set.
if gh release view "$RELEASE_TAG" --json isDraft --jq .isDraft >draft-status; then
  test "$(cat draft-status)" = true || { echo 'Release already published; refusing to replace it.' >&2; exit 1; }
else
  gh release create "$RELEASE_TAG" --verify-tag --draft --title "$RELEASE_TAG" --generate-notes
fi
gh release upload "$RELEASE_TAG" --clobber -- *.tar.gz *.sha256
prerelease=false
case "$RELEASE_TAG" in *-*) prerelease=true;; esac
gh release edit "$RELEASE_TAG" --draft=false --prerelease="$prerelease"
