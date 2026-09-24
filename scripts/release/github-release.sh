#!/usr/bin/env bash
# Create or update the GitHub Release for v$VERSION with the tarball, SHA256SUMS and the CHANGELOG notes.
#
# Env: GH_TOKEN, VERSION, PRERELEASE (true|false), IS_LATEST (true|false). Run from the directory that holds
# jevcode-$VERSION.tgz, SHA256SUMS and release-notes.md (the release-<V> artifact).
set -euo pipefail

: "${GH_TOKEN:?}" "${VERSION:?}" "${PRERELEASE:?}" "${IS_LATEST:?}"
TAG="v$VERSION"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stderr}"
ASSETS=("jevcode-$VERSION.tgz" SHA256SUMS)
for f in "${ASSETS[@]}" release-notes.md; do
  [ -f "$f" ] || { echo "::error::$f is missing from the release artifact" >&2; exit 1; }
done

case "$PRERELEASE/$IS_LATEST" in true/* | false/true | false/false) ;; *) echo "::error::PRERELEASE and IS_LATEST must be true or false" >&2; exit 1 ;; esac
if [ "$PRERELEASE" = true ]; then
  FLAGS=(--prerelease --latest=false)
elif [ "$IS_LATEST" = true ]; then
  FLAGS=(--prerelease=false --latest)
else
  FLAGS=(--prerelease=false --latest=false) # a backport below the registry's latest
fi

if gh release view "$TAG" > /dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
  gh release edit "$TAG" --notes-file release-notes.md "${FLAGS[@]}"
  action=updated
else
  gh release create "$TAG" "${ASSETS[@]}" --verify-tag --title "jevcode $VERSION" --notes-file release-notes.md "${FLAGS[@]}"
  action=created
fi

URL="$(gh release view "$TAG" --json url --jq .url)"
echo "GitHub Release: $action $URL" >> "$SUMMARY"
