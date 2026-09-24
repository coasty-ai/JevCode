#!/bin/sh
D=/tmp/jevcode-r4-header/proto
runo() { # mode over rows cols tag steps keys
  OUT=$D/out-$5.json; rm -f "$OUT"
  PROTO_MODE=$1 PROTO_ALT=0 PROTO_INC=0 PROTO_OVER=$2 PROTO_ITEMS=200 PROTO_KEYS=$7 PROTO_OUT=$OUT \
  PTY_ROWS=$3 PTY_COLS=$4 \
    $D/../scripts/pty/drive.exp --kill-on-timeout "$D/$6" "$D/cap-$5.log" "$D/tim-$5.jsonl" 40 -- node "$D/proto.mjs" >/dev/null 2>&1
  echo "--- $5 exit=$?"; cat "$OUT" 2>/dev/null; echo
}
runo full   1 24 80 A-full-over1 keys.steps 60
runo full   0 24 80 A-full-resize resize.steps 99
runo hybrid 0 24 80 B-hyb-resize resize.steps 99
