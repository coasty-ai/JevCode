#!/usr/bin/env bash
# Check the published release from the outside and write the final channel table (release.yml, job verify).
#
# Env: VERSION, DIST_TAG, PRERELEASE, IS_LATEST, RESULT_NPM, RESULT_GITHUB_RELEASE, RESULT_HOMEBREW, RESULT_AUR
# (needs.<job>.result), STATUS_HOMEBREW, STATUS_AUR (the jobs' status outputs). Fails only if npm verification fails.
set -euo pipefail

: "${VERSION:?}" "${DIST_TAG:?}" "${PRERELEASE:?}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stderr}"
SCRATCH="$(mktemp -d)"
PKG=@coasty-ai/jevcode

# npx from an empty directory, so the registry and not this checkout answers.
NPM_OK=false
OUT=""
for i in $(seq 1 10); do
  OUT="$(cd "$SCRATCH" && npx -y "$PKG@$VERSION" --version 2>&1 || true)"
  if [ "$OUT" = "jevcode $VERSION" ]; then
    NPM_OK=true
    break
  fi
  echo "npx $PKG@$VERSION --version: '$OUT' (attempt $i/10)"
  [ "$i" = 10 ] || sleep 15
done

ATTEST="$(cd "$SCRATCH" && npm view "$PKG@$VERSION" dist.attestations --json 2> /dev/null || true)"
if [ -z "$ATTEST" ] || [ "$ATTEST" = "{}" ] || [ "$ATTEST" = "null" ]; then
  echo "::warning::$PKG@$VERSION has no provenance attestation on the registry"
  PROVENANCE="no attestation"
else
  PROVENANCE="provenance attested"
fi
DIST_TAGS="$(cd "$SCRATCH" && npm view "$PKG" dist-tags --json 2> /dev/null | tr -d '\n ' || true)"

# job result + status output -> one table cell
channel() {
  local result="$1" status="$2" secret="$3"
  case "$result" in
    skipped) echo "skipped — stable releases that are the registry's latest only" ;;
    success)
      case "$status" in
        published) echo "done" ;;
        unchanged) echo "done (already at $VERSION)" ;;
        newer) echo "skipped — the channel already has a newer version" ;;
        skipped-no-secret) echo "skipped — secret $secret is not set in environment release-channels" ;;
        *) echo "done" ;;
      esac
      ;;
    *) echo "failed ($result) — see the job log, fix, then re-run failed jobs" ;;
  esac
}

if [ "$NPM_OK" = true ]; then NPM_CELL="done — dist-tag $DIST_TAG, $PROVENANCE"; else NPM_CELL="failed — npx printed '$OUT'"; fi
case "${RESULT_GITHUB_RELEASE:-}" in
  success) GH_CELL="done" ;;
  *) GH_CELL="failed (${RESULT_GITHUB_RELEASE:-unknown}) — re-run failed jobs" ;;
esac
BREW_CELL="$(channel "${RESULT_HOMEBREW:-skipped}" "${STATUS_HOMEBREW:-}" HOMEBREW_TAP_TOKEN)"
AUR_CELL="$(channel "${RESULT_AUR:-skipped}" "${STATUS_AUR:-}" AUR_SSH_PRIVATE_KEY)"
if [ "$PRERELEASE" = true ]; then
  NIX_CELL="works at any ref; pre-releases are not checked"
  NPM_CMD="npm i -g $PKG@next"
else
  NIX_CELL="builds from source at the tag; the verify-nix job checks it"
  NPM_CMD="npm i -g $PKG"
fi
if [ "$NPM_OK" = true ]; then REG_CELL="done (reads the npm registry)"; else REG_CELL="blocked on npm"; fi

{
  echo "### jevcode $VERSION — channels"
  echo
  echo "| Channel | State | Command |"
  echo "| --- | --- | --- |"
  echo "| npm | $NPM_CELL | \`$NPM_CMD\` |"
  echo "| GitHub Release | $GH_CELL | \`gh release view v$VERSION -R coasty-ai/JevCode\` |"
  echo "| Homebrew | $BREW_CELL | \`brew install coasty-ai/jevcode/jevcode\` |"
  echo "| AUR | $AUR_CELL | \`yay -S jevcode\` |"
  echo "| Nix | $NIX_CELL | \`nix run github:coasty-ai/JevCode/v$VERSION\` |"
  echo "| mise | $REG_CELL | \`mise use -g npm:$PKG@$VERSION\` |"
  echo "| bun / pnpm / yarn | $REG_CELL | \`bunx $PKG@$VERSION\` · \`pnpm dlx $PKG@$VERSION\` · \`yarn dlx $PKG@$VERSION\` |"
  echo
  echo "npm dist-tags: \`${DIST_TAGS:-unknown}\`"
} >> "$SUMMARY"

if [ "$NPM_OK" != true ]; then
  echo "::error::npx $PKG@$VERSION --version printed '$OUT', expected 'jevcode $VERSION'" >&2
  exit 1
fi
