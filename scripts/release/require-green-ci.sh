#!/usr/bin/env bash
# Exit 0 only when ci.yml has a successful run on commit $1 (prepare-release.yml). Env: GH_TOKEN.
set -euo pipefail

SHA="${1:?usage: require-green-ci.sh <sha>}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::not a commit sha: $SHA" >&2; exit 1; }
RUNS="$(gh run list --workflow ci.yml --commit "$SHA" --json status,conclusion --limit 5 \
  --jq '.[] | "\(.status)/\(.conclusion)"')"
echo "ci.yml runs on $SHA: ${RUNS:-none}"
if grep -qx 'completed/success' <<< "$RUNS"; then
  exit 0
fi
if [ -z "$RUNS" ]; then
  echo "::error::no ci.yml run on $SHA yet; wait for CI on $SHA" >&2
elif grep -qv '^completed/' <<< "$RUNS"; then
  echo "::error::ci.yml is still running on $SHA; wait for CI on $SHA, then run prepare-release again" >&2
else
  echo "::error::CI failed on $SHA; fix main before releasing" >&2
fi
exit 1
