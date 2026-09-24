#!/usr/bin/env bash
# verify-install.sh — the fresh-machine install check.
#
# Run it from a clean clone of this repository. It builds the package, packs it, installs the
# tarball into a throwaway project, and exercises the installed binary the way a new user would.
# It prints PASS or FAIL for each step and exits non-zero if any step failed.
#
#   ./scripts/verify-install.sh
#
# It needs no network: the package has zero runtime dependencies, so `npm install <tgz>` never
# reaches the registry. `npm ci` does need the network if node_modules is absent; if node_modules
# is already present and current, that step is skipped.
#
# Everything is written under a temp directory that is removed on exit. Nothing is installed
# globally and nothing outside the repository and that temp directory is touched.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jevcode-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAILURES=0
STEP=0

pass() {
  STEP=$((STEP + 1))
  printf 'PASS  %2d. %s\n' "$STEP" "$1"
}

fail() {
  STEP=$((STEP + 1))
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %2d. %s\n' "$STEP" "$1"
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$2" | sed 's/^/          /'
  fi
}

# run <description> <command...> — PASS when the command exits 0.
run() {
  local desc="$1"
  shift
  local out
  if out="$("$@" 2>&1)"; then
    pass "$desc"
  else
    fail "$desc" "$(printf '%s' "$out" | tail -20)"
  fi
}

# installed_packages <node_modules> — one line per package; a scope directory (@scope) counts the packages inside it
installed_packages() {
  local d s
  for d in "$1"/*; do
    [ -e "$d" ] || continue
    case "${d##*/}" in
      @*)
        for s in "$d"/*; do
          if [ -e "$s" ]; then printf '%s/%s\n' "${d##*/}" "${s##*/}"; fi
        done
        ;;
      *) printf '%s\n' "${d##*/}" ;;
    esac
  done
}

echo "jevcode install verification"
echo "repository: $ROOT"
echo "node:       $(node --version 2>/dev/null || echo 'NOT FOUND')"
echo "npm:        $(npm --version 2>/dev/null || echo 'NOT FOUND')"
echo "scratch:    $TMP"
echo

cd "$ROOT" || exit 1

# 1. Dependencies. A genuinely fresh clone has no node_modules and needs `npm ci`.
if [ -d node_modules ] && [ -x node_modules/.bin/esbuild ]; then
  pass "dependencies already installed (skipping npm ci)"
else
  run "npm ci" npm ci
fi

# 2. Build the bundle and the attribution file.
run "npm run build" npm run build

# 3. The launcher runs from the source tree and reports a version.
VERSION_SRC="$(node "$ROOT/bin/jevcode.js" --version 2>&1)"
PKG_VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null)"
if printf '%s' "$VERSION_SRC" | grep -qF "$PKG_VERSION"; then
  pass "node bin/jevcode.js --version -> $VERSION_SRC"
else
  fail "node bin/jevcode.js --version should contain $PKG_VERSION" "$VERSION_SRC"
fi

# 4. Pack. --ignore-scripts skips the prepack rebuild; step 2 already produced the artefact.
PACKDIR="$TMP/pack"
mkdir -p "$PACKDIR"
if PACK_OUT="$(npm pack --ignore-scripts --pack-destination "$PACKDIR" 2>&1)"; then
  TGZ="$(find "$PACKDIR" -maxdepth 1 -name '*.tgz' | head -1)"
  if [ -n "$TGZ" ]; then
    TGZ_BYTES="$(wc -c <"$TGZ" | tr -d ' ')"
    pass "npm pack -> $(basename "$TGZ") ($TGZ_BYTES bytes)"
  else
    fail "npm pack produced no tarball" "$PACK_OUT"
    TGZ=""
  fi
else
  fail "npm pack" "$(printf '%s' "$PACK_OUT" | tail -20)"
  TGZ=""
fi

# 5. Install the tarball into a clean project. Zero dependencies means zero registry traffic.
PROJ="$TMP/project"
mkdir -p "$PROJ"
cat >"$PROJ/package.json" <<'JSON'
{ "name": "jevcode-verify", "version": "0.0.0", "private": true, "type": "module" }
JSON

if [ -n "$TGZ" ]; then
  if INSTALL_OUT="$(cd "$PROJ" && npm install --no-audit --no-fund --offline "$TGZ" 2>&1)"; then
    INSTALLED="$(installed_packages "$PROJ/node_modules")"
    if [ "$INSTALLED" = "@coasty/jevcode" ]; then
      pass "npm install <tgz> into a clean project -> exactly 1 package (@coasty/jevcode), no network"
    else
      fail "npm install should add exactly 1 package, @coasty/jevcode" "${INSTALLED:-(none)}"
    fi
  else
    fail "npm install <tgz> into a clean project" "$(printf '%s' "$INSTALL_OUT" | tail -20)"
  fi
else
  fail "npm install <tgz> into a clean project (skipped: no tarball)"
fi

BIN="$PROJ/node_modules/.bin/jevcode"

# 6. The installed binary reports its version, reached the way a user reaches it. `npx --no` never
#    falls back to the registry, and the `--` keeps `--version` away from npx's own flag parser.
if [ -x "$BIN" ]; then
  OUT="$(cd "$PROJ" && npx --no -- jevcode --version 2>&1)"
  if printf '%s' "$OUT" | grep -qF "$PKG_VERSION"; then
    pass "npx jevcode --version -> $OUT"
  else
    fail "npx jevcode --version should contain $PKG_VERSION" "$OUT"
  fi
else
  fail "npx jevcode --version (skipped: $BIN is not executable)"
fi

# 7. The installed binary prints usage.
if [ -x "$BIN" ]; then
  OUT="$(cd "$PROJ" && npx --no -- jevcode --help 2>&1)"
  CODE=$?
  if [ "$CODE" -eq 0 ] && printf '%s' "$OUT" | grep -qi 'usage'; then
    pass "npx jevcode --help -> usage block ($(printf '%s\n' "$OUT" | wc -l | tr -d ' ') lines)"
  else
    fail "npx jevcode --help should exit 0 and print a usage block" "$(printf '%s' "$OUT" | tail -10)"
  fi
else
  fail "npx jevcode --help (skipped: $BIN is not executable)"
fi

# 8. A first run with no keys and no terminal must refuse cleanly: exit 2 plus the setup message,
#    not a stack trace and not a hang. `env -i` guarantees no key leaks in from this shell.
if [ -x "$BIN" ]; then
  FAKEHOME="$TMP/home"
  mkdir -p "$FAKEHOME"
  OUT="$(cd "$FAKEHOME" && env -i "HOME=$FAKEHOME" "PATH=$PATH" TERM=dumb "$BIN" run --no-input x 2>&1)"
  CODE=$?
  if [ "$CODE" -eq 2 ] && printf '%s' "$OUT" | grep -q 'apiKey'; then
    pass "first run with no keys -> exit 2 and the setup message"
  else
    fail "first run with no keys should exit 2 with the setup message (got exit $CODE)" "$(printf '%s' "$OUT" | tail -10)"
  fi
else
  fail "first run with no keys (skipped: $BIN is not executable)"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "verify-install: all $STEP steps passed"
  exit 0
fi
echo "verify-install: $FAILURES of $STEP steps failed"
exit 1
