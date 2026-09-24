#!/usr/bin/env bash
# Publish the release tarball to npm, idempotently (release.yml, job publish-npm).
#
# Env: VERSION, DIST_TAG, TARBALL; NPM_BOOTSTRAP_TOKEN only for the very first publish (package absent).
# Once the package exists it is published with OIDC trusted publishing and the token is never used.
set -euo pipefail

: "${VERSION:?}" "${DIST_TAG:?}" "${TARBALL:?}"
PKG=jevcode
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY=https://registry.npmjs.org
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stderr}"
BOOTSTRAP="${NPM_BOOTSTRAP_TOKEN:-}"

err() { echo "::error::$*" >&2; }
note() { printf '%s\n' "$*" >> "$SUMMARY"; }

[ -f "$TARBALL" ] || { err "tarball $TARBALL not found"; exit 1; }
case "$DIST_TAG" in latest | next | backport) ;; *) err "unexpected dist-tag $DIST_TAG"; exit 1 ;; esac

# 1. A stray token would make npm skip OIDC (the ENEEDAUTH pitfall). npm prints "(protected)", never the value.
if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  err "NODE_AUTH_TOKEN is set; trusted publishing must run without it (remove registry-url from setup-node)"
  exit 1
fi
if npm config list 2>/dev/null | grep -Eq '_authToken|:_auth ='; then
  err "an npm auth token is configured; trusted publishing must run without one"
  exit 1
fi

# 2. The integrity npm will record for these bytes.
LOCAL_INTEGRITY="$(node -e '
  const c = require("node:crypto"), fs = require("node:fs");
  process.stdout.write("sha512-" + c.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"));
' "$TARBALL")"

# 3. Registry state, unauthenticated. Prints: absent | missing | same | different
# ?write=true is the uncached read npm itself does before a write; the plain URL is CDN-cached for 300 s, 404s included.
registry_state() {
  local code
  code="$(curl -sS --retry 3 -o "$TMP/packument.json" -w '%{http_code}' "$REGISTRY/$PKG?write=true")" || return 1
  case "$code" in
    404) echo absent ;;
    200)
      node -e '
        const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        const v = p.versions && p.versions[process.argv[2]];
        process.stdout.write(!v ? "missing" : v.dist && v.dist.integrity === process.argv[3] ? "same" : "different");
      ' "$TMP/packument.json" "$VERSION" "$LOCAL_INTEGRITY"
      ;;
    *) echo "::error::GET $REGISTRY/$PKG?write=true returned HTTP $code" >&2; return 1 ;;
  esac
}

STATE="$(registry_state)"
echo "registry state for $PKG@$VERSION: $STATE"

if [ "$STATE" != absent ] && [ -n "$BOOTSTRAP" ]; then
  echo "::warning::NPM_BOOTSTRAP_TOKEN is set but ignored once the package exists; delete it from environment release"
  note "npm: NPM_BOOTSTRAP_TOKEN is still set in environment release — ignored; delete it"
fi

# validate chose DIST_TAG before the approval wait, and "Re-run failed jobs" reuses that choice: refuse to move
# latest or next back to this version when a newer one holds it now.
if [ "$STATE" != absent ] && { [ "$DIST_TAG" = latest ] || [ "$DIST_TAG" = next ]; }; then
  HOLDER="$(node -e '
    const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String((p["dist-tags"] || {})[process.argv[2]] || ""));
  ' "$TMP/packument.json" "$DIST_TAG")"
  if [ -n "$HOLDER" ] && [ "$(node "$ROOT/scripts/release/version.mjs" compare "$VERSION" "$HOLDER")" = -1 ]; then
    err "npm dist-tag $DIST_TAG is $HOLDER now, newer than $VERSION; dispatch release.yml on tag v$VERSION so validate recomputes (it picks backport)"
    exit 1
  fi
fi

# 4. Already there.
if [ "$STATE" = same ]; then
  note "npm: $PKG@$VERSION already published (identical bytes) — skipped"
  exit 0
fi
if [ "$STATE" = different ]; then
  err "registry holds different bytes for $VERSION; cut a new patch version"
  exit 1
fi

trusted_publisher_help() {
  cat >&2 <<'EOF'
::error::npm rejected the trusted publish. Check the trusted publisher on https://www.npmjs.com/package/jevcode/access :
  - Organization or user: coasty-ai, Repository: JevCode (case-sensitive)
  - Workflow filename: release.yml
  - Environment name: release
  - npm >= 11.5.1 in this job (asserted above)
Then re-run the failed jobs.
EOF
}

LOG="$TMP/npm-publish.log"
if [ "$STATE" = absent ]; then
  # 5. First publish: only with the one-time bootstrap token. npm expands ${NPM_BOOTSTRAP_TOKEN} itself.
  if [ -z "$BOOTSTRAP" ]; then
    cat >&2 <<'EOF'
::error::jevcode is not on the npm registry yet and trusted publishing cannot create a package. Nothing was published. Either:
  A) add a 7-day granular token as secret NPM_BOOTSTRAP_TOKEN in environment "release" and re-run the failed jobs, or
  B) download the release artifact, check it with `shasum -a 256 -c SHA256SUMS`, run `npm login` and
     `CI=true npm publish ./jevcode-<version>.tgz --access public --provenance=false`, then re-run the failed jobs.
See docs/RELEASE.md, one-time setup, step 5.
EOF
    exit 1
  fi
  NPMRC="$TMP/bootstrap.npmrc"
  trap 'rm -f "$NPMRC"' EXIT
  # shellcheck disable=SC2016
  printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_BOOTSTRAP_TOKEN}' > "$NPMRC"
  set +e
  npm publish "$TARBALL" --userconfig "$NPMRC" --provenance --access public --tag "$DIST_TAG" 2>&1 | tee "$LOG"
  rc="${PIPESTATUS[0]}"
  set -e
  rm -f "$NPMRC"
  if [ "$rc" -ne 0 ]; then
    err "bootstrap publish failed (exit $rc); if npm asked for a one-time password, the token needs 2FA bypass, or use path B"
    exit 1
  fi
  {
    echo "### Bootstrap publish done — do these 4 things now"
    echo
    echo "1. Configure the trusted publisher: https://www.npmjs.com/package/jevcode/access → Trusted Publisher → GitHub Actions: coasty-ai / JevCode / release.yml / environment release."
    echo "2. Revoke the bootstrap token: https://www.npmjs.com/settings/<you>/tokens"
    echo "3. Delete the NPM_BOOTSTRAP_TOKEN secret from environment release."
    echo "4. On the package access page: Require two-factor authentication and disallow tokens."
  } >> "$SUMMARY"
else
  # 6. The package exists: OIDC trusted publishing only.
  set +e
  env -u NPM_BOOTSTRAP_TOKEN npm publish "$TARBALL" --provenance --access public --tag "$DIST_TAG" 2>&1 | tee "$LOG"
  rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'E404|ENEEDAUTH|E403' "$LOG"; then trusted_publisher_help; fi
    err "npm publish failed (exit $rc)"
    exit 1
  fi
fi

# 7. Wait until the registry serves these exact bytes; a rerun then skips cleanly.
for i in $(seq 1 12); do
  STATE="$(registry_state || echo error)"
  if [ "$STATE" = same ]; then
    note "npm: published $PKG@$VERSION under dist-tag $DIST_TAG ($LOCAL_INTEGRITY)"
    exit 0
  fi
  echo "registry does not serve $PKG@$VERSION yet ($STATE, attempt $i/12)"
  sleep 10
done
err "the registry did not serve $PKG@$VERSION with integrity $LOCAL_INTEGRITY within 120 s; re-run the failed jobs"
exit 1
