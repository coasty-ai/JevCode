#!/bin/bash
# Clone each SWE-bench instance's repo shallowly (blobless) and check out base_commit
# under /tmp/jevonly/repos/<instance_id>. One bare blobless clone per repo, one worktree per instance.
set -u
PLAN=${1:-/tmp/jevonly_plan.txt}
BASE=/tmp/jevonly/repos
mkdir -p "$BASE/.bare"
while read -r iid repo commit; do
  name=${repo//\//__}
  bare="$BASE/.bare/$name.git"
  if [ ! -d "$bare" ]; then
    git clone --quiet --bare --filter=blob:none "https://github.com/$repo" "$bare" || { echo "CLONE FAIL $repo"; continue; }
  fi
  if [ ! -d "$BASE/$iid" ]; then
    (cd "$bare" && git fetch --quiet origin "$commit" 2>/dev/null; git worktree add --quiet --detach "$BASE/$iid" "$commit") || echo "WORKTREE FAIL $iid"
  fi
  echo "OK $iid"
done < "$PLAN"
echo CLONE_DONE
