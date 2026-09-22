#!/bin/bash
# usage: run.sh <name> <rows> <cols> <steps-file> [-- extra jevcode args]
# env: PTY_TERM, EXTRA_ENV (k=v;k=v), TIMEOUT
set -u
WT=/tmp/jevcode-r4-resize
NAME="$1"; ROWS="$2"; COLS="$3"; STEPS="$4"; shift 4
ARGS=("$@")
STEPS_ABS="$(cd "$(dirname "$STEPS")" && pwd)/$(basename "$STEPS")"
OUT="$WT/probe/out/$NAME"
rm -rf "$OUT"; mkdir -p "$OUT"
HOME_D=$(mktemp -d /tmp/jr4-home-XXXX)
WS=$(mktemp -d /tmp/jr4-ws-XXXX)
cp -R "$WT/examples/demo-py/." "$WS/" 2>/dev/null || true
mkdir -p "$HOME_D/xdg"
export HOME="$HOME_D" JEVCODE_HOME="$HOME_D" XDG_CONFIG_HOME="$HOME_D/xdg" OPEN_ASSIST_PATH="$HOME_D/nope"
unset CI CONTINUOUS_INTEGRATION NO_COLOR FORCE_COLOR SSH_TTY SSH_CONNECTION JEVCODE_TRACE JEVCODE_FAULT JEVCODE_MODE JEV_PROVIDER JEV_API_KEY TYPESAFE_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY JEVCODE_API_KEY JEVCODE_CONFIG TERM_PROGRAM TMUX STY
export PTY_ROWS="$ROWS" PTY_COLS="$COLS"
export LANG="${LANG_OVERRIDE:-en_US.UTF-8}"
[ -n "${EXTRA_ENV:-}" ] && eval "export $EXTRA_ENV"
export PTY_KILL_ON_TIMEOUT=1
cd "$WS"
/usr/bin/expect -f "$WT/scripts/pty/drive.exp" --kill-on-timeout "$STEPS_ABS" "$OUT/capture.bin" "$OUT/timing.jsonl" "${TIMEOUT:-20}" -- \
  "$(command -v node)" "$WT/bin/jevcode.js" "${ARGS[@]}" --workspace "$WS" >/dev/null 2>"$OUT/driver.err"
CODE=$?
echo "$CODE" > "$OUT/code.txt"
echo "$HOME_D" > "$OUT/home.txt"; echo "$WS" > "$OUT/ws.txt"
echo "exit=$CODE name=$NAME rows=$ROWS cols=$COLS"
