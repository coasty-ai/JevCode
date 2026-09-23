#!/usr/bin/env bash
# Render packaging/aur/PKGBUILD for v$VERSION, build and namcap it, then push PKGBUILD + .SRCINFO to the AUR
# (release.yml, job aur). Runs as root in archlinux:base-devel from the repository checkout, with SHA256SUMS in
# the working directory.
#
# Env: VERSION, AUR_SSH_PRIVATE_KEY (unencrypted), optional AUR_COMMIT_NAME, AUR_COMMIT_EMAIL, AUR_MAINTAINER,
# PACKAGING_REF (the ref this checkout came from; anything but v$VERSION allows repackaging the same version).
# The AUR repository is the PKGBUILD's pkgname. Writes status=published|unchanged|newer to $GITHUB_OUTPUT.
set -euo pipefail

: "${VERSION:?}" "${AUR_SSH_PRIVATE_KEY:?}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGING_REF="${PACKAGING_REF:-v$VERSION}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stderr}"
OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
FINGERPRINTS="$ROOT/scripts/release/aur-host-fingerprints"
COMMIT_NAME="${AUR_COMMIT_NAME:-coasty-ai release bot}"
COMMIT_EMAIL="${AUR_COMMIT_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

err() { echo "::error::$*" >&2; }
finish() {
  echo "status=$1" >> "$OUTPUT"
  echo "AUR: $2" >> "$SUMMARY"
  exit 0
}

# the AUR refuses a push whose pkgbase differs from the repository name
AUR_PACKAGE="$(sed -n 's/^pkgname=//p' "$ROOT/packaging/aur/PKGBUILD" | head -n1)"
[[ "$AUR_PACKAGE" =~ ^[a-z0-9][a-z0-9@._+-]*$ ]] || { err "packaging/aur/PKGBUILD has no valid pkgname: $AUR_PACKAGE"; exit 1; }
SHA="$(cut -d' ' -f1 SHA256SUMS)"
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || { err "SHA256SUMS does not start with a sha256"; exit 1; }
render() { node "$ROOT/scripts/release/render-packaging.mjs" pkgbuild --version "$VERSION" --sha256 "$SHA" --pkgrel "$1"; }

WORK="$(mktemp -d)"
KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT
id builder > /dev/null 2>&1 || useradd -m builder

# 1. The key: written with umask 077, checked without printing it.
(
  umask 077
  printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "$KEYDIR/aur"
)
if ! ssh-keygen -y -f "$KEYDIR/aur" > /dev/null 2>&1; then
  err "AUR_SSH_PRIVATE_KEY is not a usable private key (encrypted with a passphrase, or garbled when pasted)"
  exit 1
fi

# 2. Host key pinned to scripts/release/aur-host-fingerprints, never trusted on first use.
EXPECTED="$(awk '$1 == "ed25519" { print $2 }' "$FINGERPRINTS")"
[ -n "$EXPECTED" ] || { err "no ed25519 line in scripts/release/aur-host-fingerprints"; exit 1; }
for attempt in 1 2 3; do
  ssh-keyscan -t ed25519 aur.archlinux.org > "$KEYDIR/known_hosts" 2> /dev/null && [ -s "$KEYDIR/known_hosts" ] && break
  [ "$attempt" = 3 ] && { err "ssh-keyscan aur.archlinux.org failed"; exit 1; }
  sleep 5
done
GOT="$(ssh-keygen -lf "$KEYDIR/known_hosts" | awk '{ print $2 }')"
if [ "$GOT" != "$EXPECTED" ]; then
  err "aur.archlinux.org ed25519 host key is $GOT, expected $EXPECTED (scripts/release/aur-host-fingerprints); verify it against the Arch Linux announcement before updating that file"
  exit 1
fi
export GIT_SSH_COMMAND="ssh -i $KEYDIR/aur -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KEYDIR/known_hosts -o HostKeyAlgorithms=ssh-ed25519"

# 3. Clone; an empty clone means this is the first publish.
git config --global --add safe.directory '*'
AUR="$WORK/aur"
git -c init.defaultBranch=master clone -q "ssh://aur@aur.archlinux.org/$AUR_PACKAGE.git" "$AUR"
cd "$AUR"
git config user.name "$COMMIT_NAME"
git config user.email "$COMMIT_EMAIL"

# 4. Never move backwards; bump pkgrel only when the file for this version changes.
PKGREL=1
if [ -f PKGBUILD ]; then
  OLD_VER="$(sed -n 's/^_npmver=//p' PKGBUILD | head -n1)"
  [ -n "$OLD_VER" ] || OLD_VER="$(sed -n 's/^pkgver=//p' PKGBUILD | head -n1 | tr '_' '-')"
  OLD_REL="$(sed -n 's/^pkgrel=//p' PKGBUILD | head -n1)"
  if [ -n "$OLD_VER" ]; then
    CMP="$(node "$ROOT/scripts/release/version.mjs" compare "$OLD_VER" "$VERSION")"
    [ "$CMP" = 1 ] && finish newer "AUR has newer $OLD_VER — skipped $VERSION"
    if [ "$CMP" = 0 ]; then
      [ "$PACKAGING_REF" = "v$VERSION" ] && finish unchanged "AUR already at $VERSION-$OLD_REL; dispatch with packaging_ref=main to repackage"
      [[ "$OLD_REL" =~ ^[1-9][0-9]*$ ]] || { err "existing PKGBUILD has pkgrel '$OLD_REL'"; exit 1; }
      if render "$OLD_REL" | cmp -s - PKGBUILD; then
        finish unchanged "AUR already at $VERSION-$OLD_REL"
      fi
      PKGREL=$((OLD_REL + 1))
    fi
  fi
fi
render "$PKGREL" > PKGBUILD
chown -R builder "$WORK"

# 5. Build against the real registry tarball (makepkg verifies the sha256), then namcap.
su builder -c "cd '$AUR' && makepkg --printsrcinfo > .SRCINFO"
su builder -c "cd '$AUR' && makepkg --cleanbuild --noconfirm --nodeps"
NAMCAP="$WORK/namcap.txt"
namcap PKGBUILD | tee "$NAMCAP"
namcap ./*.pkg.tar.zst | tee -a "$NAMCAP"
if grep -q ' E: ' "$NAMCAP"; then
  err "namcap reported errors (above)"
  exit 1
fi

# 6. Stage only PKGBUILD and .SRCINFO, drop the build products, push.
git add PKGBUILD .SRCINFO
git clean -fdxq
if git diff --cached --quiet; then
  finish unchanged "AUR already at $VERSION"
fi
git commit -q -m "jevcode $VERSION"
for attempt in 1 2 3; do
  if git push -q origin HEAD:master; then
    finish published "pushed $AUR_PACKAGE $VERSION-$PKGREL — https://aur.archlinux.org/packages/$AUR_PACKAGE"
  fi
  [ "$attempt" = 3 ] && break
  sleep $((attempt * 5))
done
err "could not push to the AUR after 3 attempts"
exit 1
