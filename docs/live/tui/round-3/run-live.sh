#!/bin/sh
# TUI-DESIGN-2 §8.3 S6 — drive the built bundle (bin/jevcode.js) in a real pty against live Jev and keep the artefacts here.
#   sh docs/live/tui/round-3/run-live.sh <name> <rows> <cols> <steps-file> [typesafe|openrouter]
# Run from the repository root: its ./.env supplies TYPESAFE_API_KEY / OPENROUTER_API_KEY (the dotenv layer of resolveConfig);
# ANTHROPIC_API_KEY, JEV_API_KEY, JEVCODE_MODE, JEVCODE_CONFIG and JEV_PROVIDER are unset in the child (the fifth argument
# sets JEV_PROVIDER); JEVCODE_HOME is a fresh temp dir; the workspace is a fresh copy of the demo template
# (/tmp/jevcode-r2-demo-template = examples/demo-py + git init + notes.txt + .venv with pytest; examples/demo-py/README.md).
# The command is `node bin/jevcode.js --workspace <ws>` — no command word (a leading flag = chat, §1.1). Reviews are answered by
# the driver (PTY_AUTO_REVIEW=y). Afterwards: <name>.cap (raw pty bytes), <name>.jsonl (timing), <name>.txt (SGR-stripped),
# <name>.driver.out, <name>-runs/<run-id>/{transcript.log,state.json,run.json,jevcode.log} (decisions.jsonl is 2.3 MB per run and is not kept); every artefact is
# checked for the .env key values (counts only, never the bytes) and the run's generator usage is read from state.json.
set -u
ROOT=$(pwd); OUT="$ROOT/docs/live/tui/round-3"; T=/tmp/jevcode-r2-demo-template
name=$1; rows=$2; cols=$3; steps=$4; prov=${5:-}
[ -d "$T/.venv" ] || { echo "template $T missing (see the header)"; exit 1; }
WS=$(mktemp -d /tmp/jevcode-r2-ws-XXXXXX); cp -R "$T/." "$WS/"
H=$(mktemp -d /tmp/jevcode-r2-home-XXXXXX)
rm -f "$OUT/$name.cap" "$OUT/$name.jsonl"
if [ -n "$prov" ]; then
  env -u CI -u CONTINUOUS_INTEGRATION -u ANTHROPIC_API_KEY -u JEV_API_KEY -u JEVCODE_MODE -u JEVCODE_CONFIG JEV_PROVIDER="$prov" \
    JEVCODE_HOME="$H" JEVCODE_EXTRA_ENV_FILE="$H/no-extra-env" PTY_ROWS="$rows" PTY_COLS="$cols" PTY_AUTO_REVIEW=y \
    "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$steps" "$OUT/$name.cap" "$OUT/$name.jsonl" 600 -- node "$ROOT/bin/jevcode.js" --workspace "$WS" --spend-cap 0.30 >"$OUT/$name.driver.out" 2>&1
else
  env -u CI -u CONTINUOUS_INTEGRATION -u ANTHROPIC_API_KEY -u JEV_API_KEY -u JEVCODE_MODE -u JEVCODE_CONFIG -u JEV_PROVIDER \
    JEVCODE_HOME="$H" JEVCODE_EXTRA_ENV_FILE="$H/no-extra-env" PTY_ROWS="$rows" PTY_COLS="$cols" PTY_AUTO_REVIEW=y \
    "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$steps" "$OUT/$name.cap" "$OUT/$name.jsonl" 600 -- node "$ROOT/bin/jevcode.js" --workspace "$WS" --spend-cap 0.30 >"$OUT/$name.driver.out" 2>&1
fi
code=$?
# the run directories (redacted by the harness at write time; checked again below)
rm -rf "$OUT/$name-runs"; mkdir -p "$OUT/$name-runs"
for d in "$H"/runs/*/; do
  [ -d "$d" ] || continue
  id=$(basename "$d"); mkdir -p "$OUT/$name-runs/$id"
  for f in transcript.log state.json run.json jevcode.log; do [ -f "$d/$f" ] && cp "$d/$f" "$OUT/$name-runs/$id/$f"; done
done
[ -f "$H/sessions/index.jsonl" ] && cp "$H/sessions/index.jsonl" "$OUT/$name-runs/index.jsonl"
python3 "$OUT/summarize.py" "$OUT" "$name" "$code" "$rows" "$cols" "${prov:-auto}" "$WS" "$H"
rm -rf "$WS" "$H"
exit $code
