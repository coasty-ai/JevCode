#!/usr/bin/env bash
# Record one take of the README demo: a live, interactive JevCode session in a real pseudo-terminal.
#
#   scripts/demo/session/record.sh <outdir>
#
#   <outdir>   a directory that does not exist yet (or is empty); the take is written there
#
# The scene is typed by scripts/demo/session/steps.py into an interactive bash at a `demo-py $ `
# prompt: `jevcode`, then `hi`, then `fix the failing tests`, then `/exit`. The workspace is a
# fresh copy of examples/demo-py with one git commit and a .venv holding pytest, as its README
# says. Keys are never passed on a command line: node reads them from ENV_FILE.
#
# Isolation: HOME is left alone. Everything JevCode keeps under it is moved into the take instead:
# JEVCODE_HOME (runs, sessions, trust, coordination, the model cache), JEVCODE_CONFIG (an empty
# config file, so no saved login or setting is read), and JEVCODE_NO_IMPORT / JEVCODE_NO_MEMORY /
# JEVCODE_NO_HISTORY (no import offer, no user memory file, no composer history). bash runs with
# no profile or rc file and keeps its history in the take.
#
# Environment (all optional):
#   ENV_FILE    .env with OPENROUTER_API_KEY (default: <repo>/.env)
#   PTY_ROWS / PTY_COLS   terminal geometry (default 28x100)
#   SEED        the typist's seed (default 7)
# The waits for the program (a reply, a run) are the expect timeouts in steps.py.
set -euo pipefail

outdir=${1:?usage: record.sh <outdir>}
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
env_file=${ENV_FILE:-$repo/.env}
rows=${PTY_ROWS:-28}
cols=${PTY_COLS:-100}
seed=${SEED:-7}

[ -f "$env_file" ] || { echo "record.sh: no env file at $env_file" >&2; exit 2; }
[ -f "$repo/dist/jevcode.mjs" ] || { echo "record.sh: run 'npm run build' first" >&2; exit 2; }
if [ -e "$outdir" ] && [ -n "$(ls -A "$outdir" 2>/dev/null)" ]; then
  echo "record.sh: $outdir is not empty; every take starts from nothing" >&2; exit 2
fi

# A shared machine may ask for quiet: wait for the window to close before spending wall time.
while [ -e /tmp/jevcode-perf-window-open ]; do sleep 5; done

mkdir -p "$outdir"
outdir=$(cd -- "$outdir" && pwd)
ws=$outdir/demo-py          # the prompt and the console header show basename(cwd)
jhome=$outdir/.jevcode      # JEVCODE_HOME: runs, sessions, trust, coordination
bin=$outdir/bin

# The workspace, exactly as examples/demo-py/README.md builds it.
cp -R "$repo/examples/demo-py" "$ws"
(
  cd "$ws"
  git -c init.defaultBranch=main init -q
  printf '.venv/\n__pycache__/\n*.pyc\n.pytest_cache/\n' >> .git/info/exclude
  git add -A
  git -c user.name=jevcode-demo -c user.email=demo@jevcode.invalid commit -q -m init
)
python3 -m venv "$ws/.venv"
"$ws/.venv/bin/pip" -q install --disable-pip-version-check pytest

# An empty config file: JEVCODE_CONFIG points at it, so no saved login or setting of the machine's
# user is read (src/config/resolve.ts, src/config/credentials.ts).
printf '{}\n' > "$outdir/config.json"
mkdir -p "$jhome" "$bin"

# The command the viewer sees typed: `jevcode`, this checkout's build, keys from ENV_FILE.
cat > "$bin/jevcode" <<SH
#!/bin/sh
exec node --env-file="$env_file" "$repo/bin/jevcode.js" "\$@"
SH
chmod +x "$bin/jevcode"

python3 "$repo/scripts/demo/session/steps.py" --seed "$seed" > "$outdir/steps.json"

sysctl -n vm.loadavg > "$outdir/loadavg-before.txt" 2>/dev/null || cat /proc/loadavg > "$outdir/loadavg-before.txt"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

set +e
(
cd "$ws"
PTY_ROWS=$rows PTY_COLS=$cols TERM=xterm-256color \
python3 "$repo/perf/drivers/pty_type.py" \
  "$outdir/steps.json" "$outdir/capture.bin" "$outdir/timing.jsonl" -- \
  env -u ANTHROPIC_API_KEY -u CI -u CONTINUOUS_INTEGRATION -u NO_COLOR -u FORCE_COLOR \
      -u JEVCODE_WARM -u JEVCODE_MODE -u JEVCODE_MODEL -u JEVCODE_PROVIDER -u JEVCODE_AUTONOMY \
      -u JEVCODE_VERIFY -u JEV_PROVIDER -u JEVCODE_TRACE -u JEVCODE_EXTRA_ENV_FILE \
      "JEVCODE_HOME=$jhome" "JEVCODE_CONFIG=$outdir/config.json" \
      JEVCODE_NO_IMPORT=1 JEVCODE_NO_MEMORY=1 JEVCODE_NO_HISTORY=1 \
      TERM=xterm-256color COLORTERM=truecolor LANG=en_US.UTF-8 \
      BASH_SILENCE_DEPRECATION_WARNING=1 "HISTFILE=$outdir/.bash_history" "PATH=$bin:$PATH" 'PS1=\W $ ' \
  /bin/bash --noprofile --norc -i
)
code=$?
set -e

sysctl -n vm.loadavg > "$outdir/loadavg-after.txt" 2>/dev/null || cat /proc/loadavg > "$outdir/loadavg-after.txt"

# The workspace's own tests decide whether the fix worked, not the run's opinion of itself.
(cd "$ws" && .venv/bin/python -m pytest -p no:cacheprovider 2>&1 | tail -3) > "$outdir/oracle.txt" || true
(cd "$ws" && git diff --stat && git diff) > "$outdir/fix.diff" || true

python3 "$repo/scripts/demo/session/meta.py" "$outdir" "$code" "$started" "$rows" "$cols" "$seed"

# Nothing that looks like a key may reach a rendered frame.
for pattern in 'sk-' 'sk_' 'OPENROUTER_API_KEY' 'TYPESAFE_API_KEY' 'ANTHROPIC_API_KEY' 'Bearer '; do
  if LC_ALL=C grep -aqF "$pattern" "$outdir/capture.bin"; then
    echo "record.sh: REFUSING - the capture contains '$pattern'; inspect it before rendering" >&2
    exit 3
  fi
done
echo "record.sh: exit $code -> $outdir"
exit "$code"
