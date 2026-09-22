#!/bin/sh
# TUI-DESIGN-4 §9.3 W5 / §13 — drive the built bundle (bin/jevcode.js) in a real pty against live Jev and keep the
# artefacts here.
#   sh docs/live/tui/round-4/run-live.sh <name> <rows> <cols> <steps-file> [typesafe|openrouter]
#
# Run from THIS worktree. The two keys come from the repository root's ./.env, read into the child's ENVIRONMENT
# rather than copied into the tree — `resolveConfig` reads the env layer above the dotenv layer, so the effect is
# the round-3 script's and no secret file is ever written next to the source. `ANTHROPIC_API_KEY`, `JEV_API_KEY`,
# `JEVCODE_MODE`, `JEVCODE_CONFIG` and (unless the fifth argument sets it) `JEV_PROVIDER` are unset in the child;
# `JEVCODE_HOME` is a fresh temp dir; the workspace is a fresh copy of the demo template
# (/tmp/jevcode-r2-demo-template = examples/demo-py + git init + notes.txt + .venv with pytest).
# The command is `node bin/jevcode.js --workspace <ws> --spend-cap 0.30` — no command word (a leading flag = chat,
# §1.1) — so the session runs under the shipped default mode. Reviews are answered by the driver
# (PTY_AUTO_REVIEW=y). Afterwards every artefact is checked for the key values (counts only, never the bytes).
set -u
ROOT=$(pwd); OUT="$ROOT/docs/live/tui/round-4"; T=/tmp/jevcode-r2-demo-template
ENVFILE=${JEVCODE_LIVE_ENV:-/Users/prateekjannu/Documents/vscode/JevCode/.env}
name=$1; rows=$2; cols=$3; steps=$4; prov=${5:-}
[ -d "$T/.venv" ] || { echo "template $T missing (see the header)"; exit 1; }
[ -f "$ENVFILE" ] || { echo "no .env at $ENVFILE"; exit 1; }
TS_KEY=$(sed -n 's/^TYPESAFE_API_KEY=//p' "$ENVFILE" | head -1)
OR_KEY=$(sed -n 's/^OPENROUTER_API_KEY=//p' "$ENVFILE" | head -1)
WS=$(mktemp -d /tmp/jevcode-r4-ws-XXXXXX); cp -R "$T/." "$WS/"
H=$(mktemp -d /tmp/jevcode-r4-home-XXXXXX)
rm -f "$OUT/$name.cap" "$OUT/$name.jsonl"
env -u CI -u CONTINUOUS_INTEGRATION -u ANTHROPIC_API_KEY -u JEV_API_KEY -u JEVCODE_MODE -u JEVCODE_CONFIG \
  JEV_PROVIDER="${prov:-auto}" \
  TYPESAFE_API_KEY="$TS_KEY" OPENROUTER_API_KEY="$OR_KEY" \
  JEVCODE_HOME="$H" JEVCODE_EXTRA_ENV_FILE="$H/no-extra-env" PTY_ROWS="$rows" PTY_COLS="$cols" PTY_AUTO_REVIEW=y \
  "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$steps" "$OUT/$name.cap" "$OUT/$name.jsonl" 600 -- \
  node "$ROOT/bin/jevcode.js" --workspace "$WS" --spend-cap 0.30 >"$OUT/$name.driver.out" 2>&1
code=$?
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
