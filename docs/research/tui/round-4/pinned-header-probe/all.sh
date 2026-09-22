#!/bin/sh
D=/tmp/jevcode-r4-header/proto
run() { # mode alt inc rows cols items tag
  OUT=$D/out-$7.json; rm -f "$OUT" "$OUT.err"
  PROTO_MODE=$1 PROTO_ALT=$2 PROTO_INC=$3 PROTO_ITEMS=$6 PROTO_KEYS=60 PROTO_OUT=$OUT \
  PTY_ROWS=$4 PTY_COLS=$5 \
    $D/../scripts/pty/drive.exp --kill-on-timeout "$D/keys.steps" "$D/cap-$7.log" "$D/tim-$7.jsonl" 40 -- \
    node "$D/proto.mjs" >/dev/null 2>&1
  echo "--- $7 exit=$?"
  cat "$OUT" 2>/dev/null || echo "NO OUTPUT"; echo
  cat "$OUT.err" 2>/dev/null
}
run full   0 0 24 80  200 A-full-24x80-std
run full   0 1 24 80  200 A-full-24x80-inc
run full   0 0 60 200 200 A-full-60x200-std
run full   0 1 60 200 200 A-full-60x200-inc
run full   1 0 24 80  200 A-full-24x80-alt
run hybrid 0 0 24 80  200 B-hyb-24x80-std
run hybrid 0 1 24 80  200 B-hyb-24x80-inc
run hybrid 0 0 60 200 200 B-hyb-60x200-std
