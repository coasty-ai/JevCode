#!/usr/bin/env bash
# Render Formula/jevcode.rb for v$VERSION, validate it with brew, then push it to the tap (release.yml, job homebrew).
#
# Env: VERSION, TAP_TOKEN (fine-grained PAT, Contents read/write on the tap only), TAP_REPO (owner/homebrew-jevcode),
# PACKAGING_REF (the ref this checkout came from; anything but v$VERSION allows repackaging the same version).
# Run on macOS from the repository checkout with SHA256SUMS in the working directory.
# Writes status=published|unchanged|newer to $GITHUB_OUTPUT.
set -euo pipefail

: "${VERSION:?}" "${TAP_TOKEN:?}" "${TAP_REPO:?}"
PACKAGING_REF="${PACKAGING_REF:-v$VERSION}"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stderr}"
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
URL="https://registry.npmjs.org/@coasty/jevcode/-/jevcode-$VERSION.tgz"
LOCAL_TAP=local/jevcode-release

err() { echo "::error::$*" >&2; }
finish() {
  echo "status=$1" >> "$OUTPUT"
  echo "Homebrew: $2" >> "$SUMMARY"
  exit 0
}

[[ "$TAP_REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || { err "TAP_REPO must be owner/repo; got $TAP_REPO"; exit 1; }

# 1. The registry must serve the bytes this release built.
SHA="$(cut -d' ' -f1 SHA256SUMS)"
GOT="$(curl -fsSL --retry 5 "$URL" | shasum -a 256 | cut -d' ' -f1)"
if [ "$GOT" != "$SHA" ]; then
  err "the registry tarball for $VERSION hashes to $GOT, the release built $SHA"
  exit 1
fi

# 2. Auth through a masked header; the token never goes into a URL or onto disk.
B64="$(printf 'x-access-token:%s' "$TAP_TOKEN" | base64 | tr -d '\n')"
echo "::add-mask::$B64"
tgit() { git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $B64" "$@"; }

# 3. Clone the tap. The secret is set, so a failure here is a misconfiguration and fails the job.
TAP_DIR="$TMP/tap"
rm -rf "$TAP_DIR"
if ! tgit clone -q "https://github.com/$TAP_REPO" "$TAP_DIR"; then
  err "cannot clone $TAP_REPO: the tap repository is missing, HOMEBREW_TAP_TOKEN has expired, or the org has not approved the token (docs/RELEASE.md, one-time step 6)"
  exit 1
fi

# 4. Never move the tap backwards. The same version is repackaged only from an explicit packaging_ref.
if [ -f "$TAP_DIR/Formula/jevcode.rb" ]; then
  EXISTING="$(sed -nE 's|^  url ".*/jevcode-([^"/]+)\.tgz".*|\1|p' "$TAP_DIR/Formula/jevcode.rb" | head -n1)"
  if [ -n "$EXISTING" ]; then
    CMP="$(node "$ROOT/scripts/release/version.mjs" compare "$EXISTING" "$VERSION")"
    [ "$CMP" = 1 ] && finish newer "tap has newer $EXISTING — skipped $VERSION"
    [ "$CMP" = 0 ] && [ "$PACKAGING_REF" = "v$VERSION" ] &&
      finish unchanged "tap already at $VERSION; dispatch with packaging_ref=main to repackage"
  fi
fi

# 5. Render.
RENDERED="$TMP/jevcode.rb"
node "$ROOT/scripts/release/render-packaging.mjs" formula --version "$VERSION" --sha256 "$SHA" > "$RENDERED"

# 6. Validate in a scratch tap before the real tap is touched.
brew untap "$LOCAL_TAP" > /dev/null 2>&1 || true
brew tap-new --no-git "$LOCAL_TAP"
cp "$RENDERED" "$(brew --repository "$LOCAL_TAP")/Formula/jevcode.rb"
brew install --build-from-source "$LOCAL_TAP/jevcode"
brew test "$LOCAL_TAP/jevcode"
brew audit --strict --online "$LOCAL_TAP/jevcode"
brew style "$LOCAL_TAP/jevcode"
"$(brew --prefix)/bin/jevcode" --version | grep -Fx "jevcode $VERSION"

cd "$TAP_DIR"
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git rev-parse -q --verify HEAD > /dev/null || git checkout -q -B main
mkdir -p Formula
if [ ! -f README.md ]; then
  cat > README.md <<EOF
# coasty-ai/jevcode

Homebrew tap for [jevcode](https://github.com/coasty-ai/JevCode).

\`\`\`sh
brew install coasty-ai/jevcode/jevcode
\`\`\`

This tap is updated by coasty-ai/JevCode's release workflow. Edit Formula/jevcode.rb there, not here.
EOF
fi

# 7. Nothing to do when the tap already has this exact file.
cp "$RENDERED" Formula/jevcode.rb
git add Formula/jevcode.rb README.md
if git diff --cached --quiet; then
  finish unchanged "tap already at $VERSION"
fi

# 8. Commit and push, rebasing over a concurrent change.
git commit -q -m "jevcode $VERSION"
for attempt in 1 2 3; do
  if tgit push -q origin HEAD:main; then
    COMMIT="$(git rev-parse HEAD)"
    finish published "pushed jevcode $VERSION — https://github.com/$TAP_REPO/commit/$COMMIT"
  fi
  [ "$attempt" = 3 ] && break
  sleep $((attempt * 5))
  tgit pull -q --rebase origin main || true
done
err "could not push to $TAP_REPO after 3 attempts"
exit 1
