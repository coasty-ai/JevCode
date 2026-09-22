#!/bin/sh
# usage: p.sh <name> <rows> <cols> <steps-file> [extra env assignments via ENVX] -- args...
ROOT=/tmp/jevcode-r4-conv
OUT=/tmp/r4conv/out; mkdir -p "$OUT"
name=$1; rows=$2; cols=$3; steps=$4; shift 4
home=$(mktemp -d /tmp/r4conv/home-XXXXXX)
ws=$(mktemp -d /tmp/r4conv/ws-XXXXXX)
cp -R "$ROOT/examples/demo-py/." "$ws/" 2>/dev/null
UNSET="-u CI -u CONTINUOUS_INTEGRATION -u JEV_API_KEY -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY -u ANTHROPIC_API_KEY -u JEVCODE_API_KEY -u JEVCODE_MODE -u JEV_PROVIDER -u JEVCODE_CONFIG -u JEVCODE_TRACE -u JEVCODE_FAULT"
cap="$OUT/$name.cap"; tim="$OUT/$name.jsonl"; rm -f "$cap" "$tim"
(cd "$ws" && env $UNSET PTY_ROWS="$rows" PTY_COLS="$cols" HOME="$home" XDG_CONFIG_HOME="$home/xdg" JEVCODE_HOME="$home" JEVCODE_EXTRA_ENV_FILE="$home/nope" $ENVX \
  "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$steps" "$cap" "$tim" 60 -- node "$ROOT/bin/jevcode.js" "$@" --workspace "$ws" >"$OUT/$name.stdout" 2>&1)
code=$?
python3 -c 'import re,sys
b=open(sys.argv[1],"rb").read().decode("utf8","replace")
sys.stdout.write(re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\)","",b).replace("\r",""))' "$cap" > "$OUT/$name.txt"
echo "exit=$code timeouts=$(grep -c '"op":"timeout"' "$tim") ws=$ws home=$home txt=$OUT/$name.txt"
