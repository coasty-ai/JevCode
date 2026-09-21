#!/bin/sh
# TUI-DESIGN §19.5 real-pty smoke over the built bundle (bin/jevcode.js): every scenario runs scripts/pty/drive.exp
# with a fresh JEVCODE_HOME and workspace, then reports the exit code, the clear count after the first dynamic frame
# (§18 CLEAR_RE, with one Ink clearTerminal `ESC[2J ESC[3J ESC[H` counted once: must be 0 in every scenario without a
# shrink in rows; research 20 item 1 allows one per shrink, and `resize-live` shrinks a pane taller than the new
# terminal twice, so its gate is 2), the count of the exit
# string RESTORE (`ESC[?2004l ESC[?2026l ESC[0 SP q ESC[?25h ESC[0m`, §14.2: written exactly once per exit in every
# scenario — the one process-wide restoreTerminal() is shared by the Ink unmount, fatalExit, the engine's exit hook, the
# controller's finishSession and process 'exit'; a --plain TTY exit writes it once too), expect timeouts and the scenario's own checks. Usage: test/pty/run-smoke.sh [scenario...]   (default: all). Output dir: .scratch/pty-smoke/.
cd "$(dirname "$0")/../.." || exit 1
ROOT=$(pwd)
OUT="$ROOT/.scratch/pty-smoke"; mkdir -p "$OUT"
STEPS="$ROOT/test/pty/smoke"
BIN="$ROOT/bin/jevcode.js"
fail=0
clears() {
  python3 - "$1" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
i=b.find(b'\x1b[?25l')
tail=b[i:] if i>=0 else b
# one clearTerminal (ESC[2J ESC[3J ESC[H) is one clear; a bare 3J, RIS or an alt-screen switch still counts
print(len(re.findall(rb'\x1b\[[0-9;]*2J(?:\x1b\[[0-9;]*3J)?|\x1b\[[0-9;]*3J|\x1bc|\x1b\[\?1049[hl]', tail)))
PY
}
restores() {
  python3 - "$1" <<'PY'
import sys
b=open(sys.argv[1],'rb').read()
print(b.count(b'\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m'))
PY
}
run() {
  name=$1; expected=$2; rows=$3; cols=$4; shift 4
  home=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-home-XXXXXX"); ws=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-ws-XXXXXX")
  extra_env=""
  case "$name" in
    sigmid-trust) printf '# instructions\nBe careful.\n' > "$ws/AGENTS.md";;
    plainwarn) mkdir -p "$home/xdg/jevcode"; printf '{"notASetting": 1}\n' > "$home/xdg/jevcode/config.json"; extra_env="XDG_CONFIG_HOME=$home/xdg";;
    review-y|review-d) extra_env="JEVCODE_MOCK_REVIEW_AT=2";;
    taskfile-header) printf 'create one scratch file and stop\n' > "$ws/todo.md"; set -- run --task-file "$ws/todo.md" --mock --mock-steps 3;;
  esac
  cap="$OUT/$name.cap"; tim="$OUT/$name.jsonl"; rm -f "$cap" "$tim"
  # shellcheck disable=SC2086
  env -u CI -u CONTINUOUS_INTEGRATION JEVCODE_HOME="$home" PTY_ROWS="$rows" PTY_COLS="$cols" $extra_env \
    "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$STEPS/$name.steps" "$cap" "$tim" 60 -- node "$BIN" "$@" --workspace "$ws" >"$OUT/$name.stdout" 2>&1
  code=$?
  c=$(clears "$cap"); t=$(grep -c '"op":"timeout"' "$tim"); r=$(restores "$cap"); checks=""; ok=1
  [ "$code" = "$expected" ] || ok=0
  [ "$t" = "0" ] || ok=0
  # §14.2: the exit string exactly once per exit in every scenario (the process-wide restoreTerminal is shared by unmount, fatalExit, the engine's exit hook, finishSession and process 'exit')
  [ "$r" = "1" ] || ok=0
  case "$name" in
    resize) [ "$c" -le 1 ] || ok=0; checks=" clears<=1(one shrink segment)";;
    resize-live) [ "$c" -le 2 ] || ok=0; checks=" clears<=2(two shrink segments, live pane taller than 12 rows)"
      grep -aq 'end human_abort' "$cap" && checks="$checks run:human_abort" || { ok=0; checks="$checks MISSING:human_abort"; };;
    plainwarn|taskfile-missing|firstframe) ;;
    *) [ "$c" = "0" ] || ok=0;;
  esac
  case "$name" in
    firstframe) ff=$(grep -ao 'FIRST_FRAME_MS=[0-9.]*' "$cap" | head -1); checks="$checks $ff";;
    s0-ctrlc) grep -aq 'exited on Ctrl-C ×2' "$cap" && checks="$checks scrollback:exited-on-ctrl-c" || { ok=0; checks="$checks MISSING:exited-on-ctrl-c"; };;
    ctrld2) grep -aq 'exited on Ctrl-D ×2' "$cap" && checks="$checks scrollback:exited-on-ctrl-d" || { ok=0; checks="$checks MISSING:exited-on-ctrl-d"; };;
    budgetfirst) grep -q '"kind":"budget"' "$home/sessions/index.jsonl" 2>/dev/null && checks="$checks index:budget-line" || { ok=0; checks="$checks MISSING:index-budget-line"; }
      grep -aq 'sess \$0.00/15.00' "$cap" && checks="$checks status:sess/15.00" || checks="$checks (status sess/15.00 not seen)";;
    sigmid-trust|sigmid-early) grep -aq 'stopped — signal: SIGINT (exit 130)' "$cap" && checks="$checks epilogue:130" || { ok=0; checks="$checks MISSING:epilogue"; };;
    taskfile-missing) grep -aq -- '--task-file: cannot read .*ENOENT' "$cap" && checks="$checks usage-line" || { ok=0; checks="$checks MISSING:usage-line"; };;
    oneshot-ctrlc) grep -aq 'stopped — human_abort (exit 130)' "$cap" && checks="$checks epilogue:130" || { ok=0; checks="$checks MISSING:epilogue"; };;
    exitlast) grep -aq 'end max_steps' "$cap" && checks="$checks run:max_steps";;
    chat-run-exit|review-y|review-d|s2-esc-pause|s2-ctrlc-abort) ls "$home/runs" 2>/dev/null | head -1 | grep -q . && checks="$checks run-dir" ; [ -f "$home/runs/$(ls "$home/runs" 2>/dev/null | head -1)/jevcode.log" ] && checks="$checks run-dir:jevcode.log" || checks="$checks (no run-dir jevcode.log)";;
  esac
  [ "$ok" = "1" ] && verdict=PASS || { verdict=FAIL; fail=1; }
  echo "$name: $verdict exit=$code (expected $expected) clears_after_first_frame=$c restores=$r timeouts=$t$checks"
  rm -rf "$home" "$ws"
}
want="$*"
sel() { [ -z "$want" ] || echo " $want " | grep -q " $1 "; }
sel firstframe && run firstframe 0 24 80 chat --mock --perf-exit-after-first-frame
sel chat-run-exit && run chat-run-exit 0 24 80 chat --mock --mock-steps 4
sel s0-ctrlc && run s0-ctrlc 0 24 80 chat --mock
sel ctrld2 && run ctrld2 0 24 80 chat --mock
sel s1-clear && run s1-clear 0 24 80 chat --mock
sel s2-ctrlc-abort && run s2-ctrlc-abort 0 24 80 chat --mock --mock-steps 40 --max-steps 40
sel s2-esc-pause && run s2-esc-pause 0 24 80 chat --mock --mock-steps 40 --max-steps 40
sel review-y && run review-y 0 24 80 chat --mock --mock-steps 5
sel review-d && run review-d 0 24 80 chat --mock --mock-steps 5
sel resize && run resize 0 24 80 chat --mock
sel resize-grow && run resize-grow 0 12 60 chat --mock
sel resize-live && run resize-live 0 40 100 chat --mock --mock-steps 400 --max-steps 400 --max-replans 100
sel exitlast && run exitlast 4 24 80 chat --mock --mock-steps 6 --max-steps 2 --exit-code last-run
sel budgetfirst && run budgetfirst 0 24 80 chat --mock --mock-steps 4
sel sigmid-trust && run sigmid-trust 130 24 80 chat --mock
sel sigmid-early && run sigmid-early 130 24 80 chat --mock
sel plainwarn && run plainwarn 0 24 80 chat --plain --mock
sel taskfile-missing && run taskfile-missing 2 24 80 run --task-file /nonexistent/dir/todo.md --mock
sel taskfile-header && run taskfile-header 0 24 80 run --task-file WS_TODO --mock --mock-steps 3
sel oneshot-ctrlc && run oneshot-ctrlc 130 24 80 run "probe task" --mock --mock-steps 40 --max-steps 40
exit $fail
