#!/usr/bin/env bash
# Record one arm of the side-by-side demo: a real JevCode session in a real pseudo-terminal.
#
#   scripts/demo/side-by-side/record.sh <arm> <outdir> [extra jevcode flags...]
#
#   <arm>      left | right   (left = the default mode, right = --mode jev-off)
#   <outdir>   a fresh directory; everything the run produced is written there
#
# The run gets its own HOME and its own copy of the task workspace, so neither arm can read
# the other's cache, history or session store. Keys are never passed on the command line:
# node reads them from the .env file named by ENV_FILE.
#
# Environment (all optional):
#   ENV_FILE   .env with OPENROUTER_API_KEY (default: <repo>/.env)
#   TASK       QuixBugs program to fix (default: detect_cycle)
#   VENV       a Python environment with pytest, copied into the workspace as .venv
#              (default: $HOME/.jevcode/runs/ladder-venv, built by the benchmark runner)
#   PTY_ROWS / PTY_COLS   terminal geometry (default 30x100)
#   MAX_STEPS / MAX_WALL / SPEND_CAP   run limits (default 12 / 8m / 0.06)
#   TIMEOUT_MS the recorder's own patience (default 660000)
set -euo pipefail

arm=${1:?usage: record.sh <left|right> <outdir> [extra flags...]}
outdir=${2:?usage: record.sh <left|right> <outdir> [extra flags...]}
shift 2 || true

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
env_file=${ENV_FILE:-$repo/.env}
task=${TASK:-detect_cycle}
venv=${VENV:-$HOME/.jevcode/runs/ladder-venv}
rows=${PTY_ROWS:-30}
cols=${PTY_COLS:-100}
max_steps=${MAX_STEPS:-12}
max_wall=${MAX_WALL:-8m}
spend_cap=${SPEND_CAP:-0.06}
timeout_ms=${TIMEOUT_MS:-660000}

case "$arm" in
  left)  mode_args=(--mode llm-jev) ; label=llm-jev ;;
  right) mode_args=(--mode jev-off) ; label=jev-off ;;
  *) echo "record.sh: arm must be left or right" >&2; exit 2 ;;
esac

[ -f "$env_file" ] || { echo "record.sh: no env file at $env_file" >&2; exit 2; }
[ -f "$repo/bin/jevcode.js" ] || { echo "record.sh: run 'npm run build' first" >&2; exit 2; }

data=$repo/bench/data/quixbugs
[ -f "$data/programs/$task.py" ] || { echo "record.sh: no QuixBugs program $task" >&2; exit 2; }
[ -f "$data/tests/${task}_test.py" ] || { echo "record.sh: $task has JSON test cases; this script only handles module tests" >&2; exit 2; }

# A shared machine may ask for quiet: wait for the window to close before spending wall time.
while [ -e /tmp/jevcode-perf-window-open ]; do sleep 5; done

mkdir -p "$outdir"
outdir=$(cd -- "$outdir" && pwd)
# The session header shows basename(cwd), so the working directory is named after the task.
ws=$outdir/$task
home=$outdir/home
rm -rf "$ws" "$home"
mkdir -p "$ws/tests" "$home"

# The same workspace the benchmark builds: the buggy program, its tests, a pytest layout and
# one git commit (src/bench/quixbugs/loader.ts, src/bench/ladder/pyworkspace.ts).
cp "$data/programs/$task.py" "$ws/$task.py"
# The graph programs take Node objects built by their test module (src/bench/quixbugs/tasks.ts usesNode).
if grep -qE '^[[:space:]]*(from[[:space:]]+node[[:space:]]+import|import[[:space:]]+node)\b' \
     "$data/programs/$task.py" "$data/tests/${task}_test.py"; then
  cp "$data/programs/node.py" "$ws/node.py"
fi
cp "$data/tests/${task}_test.py" "$ws/tests/${task}_test.py"
cat > "$ws/pytest.ini" <<'INI'
[pytest]
testpaths = tests
pythonpath = .
addopts = -p no:cacheprovider
INI
cat > "$ws/conftest.py" <<'PY'
"""Puts the workspace root on sys.path so the tests import the code under test (pytest < 7 lacks the pythonpath ini option)."""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
PY
(
  cd "$ws"
  git -c init.defaultBranch=main init -q
  printf '.jevcode*\n__pycache__/\n*.pyc\n.pytest_cache/\n.venv/\n.venv\n' >> .git/info/exclude
  git add -A
  git -c user.name=jevcode-demo -c user.email=demo@jevcode.invalid commit -q -m "quixbugs $task: buggy program and tests"
)
# pytest has to be importable inside the sandbox, and the sandbox puts <workspace>/.venv on PATH.
[ -d "$venv/bin" ] || { echo "record.sh: no python environment with pytest at $venv" >&2; exit 2; }
cp -R "$venv" "$ws/.venv"

# The task text the benchmark hands the engine (src/bench/quixbugs/loader.ts taskText).
prompt="The function \`$task\` in \`$task.py\` has a bug that makes some tests in tests/ fail. Fix it without changing the tests."

cat > "$outdir/steps.json" <<JSON
[
  {"op":"mark","label":"spawned"},
  {"op":"expect","pattern":"finished .{1,4} [a-z_]+ .{1,4} [0-9]+ steps","timeoutMs":$timeout_ms},
  {"op":"mark","label":"run-end"},
  {"op":"sleep","ms":2500},
  {"op":"send","text":"/exit\\r"},
  {"op":"eof","timeoutMs":30000}
]
JSON

sysctl -n vm.loadavg > "$outdir/loadavg-before.txt"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

set +e
(
cd "$ws"
PTY_ROWS=$rows PTY_COLS=$cols TERM=xterm-256color \
python3 "$repo/perf/drivers/pty_type.py" \
  "$outdir/steps.json" "$outdir/capture.bin" "$outdir/timing.jsonl" -- \
  env -u ANTHROPIC_API_KEY -u JEVCODE_WARM -u JEVCODE_MODE -u JEVCODE_MODEL -u JEVCODE_PROVIDER \
      "HOME=$home" "TERM=xterm-256color" \
  node "--env-file=$env_file" "$repo/bin/jevcode.js" run "$prompt" \
    "${mode_args[@]}" \
    --workspace "$ws" \
    --trust-workspace \
    --max-steps "$max_steps" --max-wall "$max_wall" --spend-cap "$spend_cap" \
    "$@"
)
code=$?
set -e

sysctl -n vm.loadavg > "$outdir/loadavg-after.txt"

# The run's own record: a fresh HOME holds exactly one.
run_dir=$(ls -1d "$home"/.jevcode/runs/*/ 2>/dev/null | head -1 || true)
if [ -n "$run_dir" ]; then
  mkdir -p "$outdir/run"
  for f in run.json decisions.jsonl jev.jsonl generator.jsonl transcript.log; do
    if [ -f "$run_dir$f" ]; then cp "$run_dir$f" "$outdir/run/$f"; fi
  done
fi
if [ -f "$home/.jevcode/sessions/index.jsonl" ]; then cp "$home/.jevcode/sessions/index.jsonl" "$outdir/session-index.jsonl"; fi

# The task's own oracle decides whether the run really fixed the bug - not the stop reason.
python3 "$data/run_tests.py" "$task" "$ws/$task.py" > "$outdir/oracle.json" 2>/dev/null || true

python3 - "$outdir" "$arm" "$label" "$task" "$code" "$started" "$rows" "$cols" <<'PY'
import json, os, sys
out, arm, label, task, code, started, rows, cols = sys.argv[1:9]
meta = {"arm": arm, "mode": label, "task": task, "exitCode": int(code), "startedAt": started,
        "rows": int(rows), "columns": int(cols)}
for name, key in (("loadavg-before.txt", "loadavgBefore"), ("loadavg-after.txt", "loadavgAfter")):
    p = os.path.join(out, name)
    if os.path.exists(p):
        meta[key] = [float(x) for x in open(p).read().replace("{", " ").replace("}", " ").split()[:3]]
idx = os.path.join(out, "session-index.jsonl")
if os.path.exists(idx):
    for line in open(idx):
        r = json.loads(line)
        if r.get("kind") == "run:end":
            meta["runId"] = r.get("runId")
            meta["stopReason"] = r.get("stopReason")
            meta["steps"] = r.get("steps")
            meta["wallMs"] = r.get("wallMs")
            meta["costUsd"] = r.get("costUsd")
            meta["changedFiles"] = r.get("changedFiles")
for name, key in (("jev.jsonl", "jevRequests"), ("generator.jsonl", "generatorCalls")):
    p = os.path.join(out, "run", name)
    meta[key] = sum(1 for _ in open(p)) if os.path.exists(p) else 0
oracle = os.path.join(out, "oracle.json")
if os.path.exists(oracle):
    try:
        r = json.loads(open(oracle).read().strip().splitlines()[-1])
        meta["oracle"] = r
        meta["oraclePassed"] = r.get("total", 0) > 0 and r.get("failed") == 0 and r.get("errors") == 0 and r.get("timeouts") == 0
    except (ValueError, IndexError):
        pass
json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
print(json.dumps(meta))
PY

# Nothing that looks like a key may reach the rendered frames.
for pattern in 'sk-' 'sk_' 'OPENROUTER_API_KEY' 'ANTHROPIC_API_KEY'; do
  if LC_ALL=C grep -aqF "$pattern" "$outdir/capture.bin"; then
    echo "record.sh: REFUSING - the capture contains '$pattern'; inspect it before rendering" >&2
    exit 3
  fi
done
echo "record.sh: $arm ($label) exit $code -> $outdir"
