#!/usr/bin/env bash
# Bump, promote the CHANGELOG, commit, regenerate docs, gate, tag, push and start release.yml
# (prepare-release.yml), in two phases so that dependency code never runs with the token in reach:
#   prepare.sh build   env VERSION (already validated by version.mjs next), DRY_RUN (true|false); no token
#   prepare.sh push    env VERSION, DRY_RUN, GH_TOKEN; runs no npm code
set -euo pipefail

PHASE="${1:-}"
: "${VERSION:?}"
DRY_RUN="${DRY_RUN:-false}"
case "$DRY_RUN" in true | false) ;; *) echo "::error::dry_run must be true or false; got $DRY_RUN" >&2; exit 1 ;; esac
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] ||
  { echo "::error::bad version $VERSION" >&2; exit 1; }
TAG="v$VERSION"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stderr}"

case "$PHASE" in
  build)
    if [ -n "${GH_TOKEN:-}" ]; then echo "::error::the build phase runs npm code and must not hold GH_TOKEN" >&2; exit 1; fi
    ;;
  push)
    : "${GH_TOKEN:?}"
    ;;
  *) echo "::error::usage: prepare.sh build|push" >&2; exit 1 ;;
esac

if [ "$PHASE" = build ]; then
  # 1. Identity for the release commits and the tag.
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

  # 2. Version and CHANGELOG.
  npm version "$VERSION" --no-git-tag-version --allow-same-version > /dev/null
  node scripts/release/changelog.mjs promote "$VERSION"
  git add package.json package-lock.json CHANGELOG.md
  if ! git diff --cached --quiet; then
    git commit -q -m "release: $TAG"
  fi

  # 3. Generated docs date from package.json's commit, so they are regenerated after it.
  node scripts/gen-docs.mjs
  if [ -n "$(git status --porcelain -- man completions docs/KEYS.md docs/COMMANDS.md)" ]; then
    git add -A man completions docs/KEYS.md docs/COMMANDS.md
    git commit -q -m "docs: regenerate for $TAG"
  fi

  # 4. The release gates that depend on the new version.
  npm run build
  npm run pack:check
  node scripts/gen-docs.mjs --check

  # 5. Annotated tag.
  git tag -a "$TAG" -m "jevcode $VERSION"

  # 6. Dry run: show what would be pushed.
  if [ "$DRY_RUN" = true ]; then
    {
      echo "### prepare-release dry run: $TAG (nothing pushed)"
      echo
      echo '```'
      git log --stat origin/main..HEAD
      echo
      git show --no-patch "$TAG"
      echo '```'
    } >> "$SUMMARY"
  fi
  exit 0
fi

# push phase
[ "$DRY_RUN" = true ] && exit 0
git rev-parse -q --verify "refs/tags/$TAG" > /dev/null || { echo "::error::no local tag $TAG; the build phase did not finish" >&2; exit 1; }

# The token reaches git through a masked header, never through .git/config or a URL; hooks are off.
B64="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
echo "::add-mask::$B64"
pgit() { git -c core.hooksPath=/dev/null -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $B64" "$@"; }

# A push made with GITHUB_TOKEN starts no workflow, but a dispatch does: give every bot commit a ci.yml run, so
# require-green-ci.sh (and a required status check on a PR) can find one.
dispatch_ci() {
  gh workflow run ci.yml --ref "$1" || echo "::warning::could not start ci.yml on $1; start it from Actions → ci → Run workflow" >&2
}

# 7. Push main and the tag together, or neither.
LOG="$(mktemp)"
if ! pgit push --atomic origin HEAD:refs/heads/main "refs/tags/$TAG" 2> "$LOG"; then
  cat "$LOG" >&2
  # an atomic push rejects both refs when only the tag is blocked; GH013 names the ref that broke the rule
  if grep -Eqi 'rule violations found for refs/tags/' "$LOG"; then
    echo "::error::a tag ruleset blocks creating $TAG: add GitHub Actions as a bypass actor (docs/RELEASE.md, one-time step 4) or release with the manual path" >&2
    exit 1
  fi
  if grep -Eqi 'GH006|protected branch|rule violations found for refs/heads/main' "$LOG"; then
    BRANCH="release/$TAG"
    pgit push -f origin "HEAD:refs/heads/$BRANCH"
    PR="$(gh pr create --base main --head "$BRANCH" --title "release: $TAG" \
      --body "Opened by prepare-release because main is protected. Merge it with **Create a merge commit** (a squash or rebase merge re-dates the release commit, and the man page date with it), then run prepare-release again with bump=current: that run commits nothing and only tags $TAG.")"
    dispatch_ci "$BRANCH"
    {
      echo "### main is protected: $PR"
      echo
      echo "ci.yml was started on $BRANCH (a PR opened with GITHUB_TOKEN starts no CI of its own)."
      echo "Merge the PR with **Create a merge commit**, then run prepare-release again with bump=current."
    } >> "$SUMMARY"
    exit 0
  fi
  if grep -Eqi 'non-fast-forward|fetch first|stale info' "$LOG"; then
    echo "::error::main moved while preparing $TAG; run prepare-release again" >&2
  else
    echo "::error::git push of main and $TAG failed (log above)" >&2
  fi
  exit 1
fi
dispatch_ci main

# 8. A push made with GITHUB_TOKEN does not trigger workflows, so start release.yml on the tag.
gh workflow run release.yml --ref "$TAG"
URL=""
for _ in $(seq 1 10); do
  sleep 3
  URL="$(gh run list --workflow release.yml --branch "$TAG" --limit 1 --json url --jq '.[0].url // ""')"
  [ -n "$URL" ] && break
done
{
  echo "### $TAG pushed"
  echo
  if [ -n "$URL" ]; then
    echo "**Release run: $URL — open it and click Review deployments → release → Approve**"
  else
    echo "**Release run started; open Actions → release (ref $TAG), then Review deployments → release → Approve**"
  fi
} >> "$SUMMARY"
