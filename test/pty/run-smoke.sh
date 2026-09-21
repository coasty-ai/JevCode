#!/bin/sh
# TUI-DESIGN §19.5 / TUI-DESIGN-2 §8.2 real-pty smoke over the built bundle (bin/jevcode.js): every scenario runs
# scripts/pty/drive.exp with a fresh JEVCODE_HOME and workspace (the child's cwd is the workspace, so the repository's
# ./.env is never read, OPEN_ASSIST_PATH points at a directory that does not exist — the default is the package root's
# sibling ../open-assist, whose .env would otherwise supply keys — and every key variable is unset; a scenario that
# needs a key sets a fake one), then reports the
# exit code, the clear count after the first dynamic frame (§18 CLEAR_RE, with one Ink clearTerminal `ESC[2J ESC[3J
# ESC[H` counted once: must be 0 in every scenario without a shrink in rows; research 20 item 1 allows one per shrink —
# `resize`, `resize-live` and `chrome-tiers` shrink once or twice, so their gates are 1 / 2 / 1), the count of the exit
# string RESTORE (`ESC[?2004l ESC[?2026l ESC[0 SP q ESC[?25h ESC[0m`, §14.2: written exactly once per exit in every
# scenario — the one process-wide restoreTerminal() is shared by the Ink unmount, fatalExit, the engine's exit hook, the
# controller's finishSession and process 'exit'; a --plain TTY exit writes it once too), expect timeouts and the
# scenario's own checks.
#
# Round 2 (TUI-DESIGN-2): the default mode is jev-only (§1.1), so every scenario that needs the scripted `--mock`
# trajectory says `--mode jev-on` (under jev-only `--mock` would run the real synthesizer); the zero-argument scenarios
# start without a mode and expect the `jev-only` badge. New scenarios: chat-hi (a greeting → a [jevcode] reply, no run,
# wall time recorded), chat-facts, chat-task (today's chat-run-exit; compact transcript), chat-ambiguous(-y) (the intake
# card; -flat at 12x60), mode-switch(-keyed) (/mode jev-on without / with a generator key), splash, splash-wide,
# splash-reduced, splash-settle (no key: the splash settles by itself), panel, chrome-tiers, zero-arg-chat, zero-arg-run,
# zero-arg-wizard.
# Hermetic child environment (§8.2; docs/STATUS.md "Round 2" finding 2): HOME, XDG_CONFIG_HOME and JEVCODE_HOME inside
# the scenario's temp home — `resolveConfig` falls back to the legacy $HOME/.config/jevcode/config.json when the XDG
# file is absent (src/config/resolve.ts), so a developer's saved login must never be a candidate — JEVCODE_CONFIG and
# every key variable unset, OPEN_ASSIST_PATH at a directory that does not exist. `run-smoke.sh --hermetic` proves it:
# a fake HOME holding a legacy credentials file, the same env construction, `jevcode config` must show no `file:` source
# (and the control without the isolation must).
# Usage: test/pty/run-smoke.sh [scenario...]   (default: all). Output dir: .scratch/pty-smoke/.
#        test/pty/run-smoke.sh --wordmark <capture>   print "<before> <after>" wordmark cells around the `› h` echo frame
#        test/pty/run-smoke.sh --hermetic             the environment self-check alone (exit 1 when a key leaks)
cd "$(dirname "$0")/../.." || exit 1
ROOT=$(pwd)
OUT="$ROOT/.scratch/pty-smoke"; mkdir -p "$OUT"
STEPS="$ROOT/test/pty/smoke"
BIN="$ROOT/bin/jevcode.js"
# a fake key never leaves the machine: JEVCODE_ASSERT_NO_NETWORK=1 makes any http(s) fetch throw (bin/jevcode.js)
FAKE_KEY="sk-fake-$(printf 'x%.0s' $(seq 1 40))"
# the variables every child loses (see the header); `env -u` takes them one by one
UNSET="-u CI -u CONTINUOUS_INTEGRATION -u JEV_API_KEY -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY -u ANTHROPIC_API_KEY -u JEVCODE_API_KEY -u JEVCODE_MODE -u JEV_PROVIDER -u JEVCODE_CONFIG -u JEVCODE_MOCK_INTAKE -u JEVCODE_MOCK_REVIEW_AT -u JEVCODE_MOCK_JEV_MS -u JEVCODE_ASSERT_NO_NETWORK -u JEVCODE_TRACE -u JEVCODE_FAULT"
# the isolated home of one child: `hermetic_env <home>` prints the VAR=value words every scenario gets
hermetic_env() { echo "HOME=$1 XDG_CONFIG_HOME=$1/xdg JEVCODE_HOME=$1 OPEN_ASSIST_PATH=$1/no-open-assist"; }
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
# wall time (ms) between the `mark <from>` and `mark <to>` records of a timing file, or -1
wall() {
  python3 - "$1" "$2" "$3" <<'PY'
import json,sys
a=b=None
for line in open(sys.argv[1]):
    try: r=json.loads(line)
    except Exception: continue
    if r.get('op')=='mark' and r.get('arg')==sys.argv[2] and a is None: a=r['t']
    if r.get('op')=='mark' and r.get('arg')==sys.argv[3] and a is not None and b is None: b=r['t']
print(-1 if a is None or b is None else b-a)
PY
}
# wordmark cells (`██`) before / after the frame that first echoes `<prompt> h` in a capture: "<before> <after>". The cut
# is the start of the echo's frame unit (the cursor hide `ESC[?25l` that opens every Ink frame, research 20 §3), not the
# echo's own byte offset: the wordmark rows of that frame sit above the composer row, so a frame that still drew the
# wordmark together with the character must count as "after" (TUI-DESIGN-2 §5.3: the frame that shows the key shows no
# wordmark row). Falls back to the echo offset when no frame opener precedes it.
wordmark() {
  python3 - "$1" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
m=re.search(rb'(?:\xe2\x80\xba|>) h', b)
if m:
    cut=b.rfind(b'\x1b[?25l', 0, m.start())
    if cut < 0: cut=m.start()
else:
    cut=len(b)
print(b[:cut].count(b'\xe2\x96\x88\xe2\x96\x88'), b[cut:].count(b'\xe2\x96\x88\xe2\x96\x88'))
PY
}
# the splash settling by itself (splash-settle): "<wordmark_frames> <wordmark_after_brand> <frames_before_brand>" — frames are
# the synchronized-output brackets (BSU `ESC[?2026h` opens every frame; the cursor hide does not — a frame drawn while the
# cursor is already hidden, e.g. under a card, writes none); the brand row `◆ jevcode` marks the settled frame (§5.2 t ≥ 700 → §5.4)
splash_settle() {
  python3 - "$1" <<'PY'
import sys
b=open(sys.argv[1],'rb').read()
frames=b.split(b'\x1b[?2026h')[1:]
wm=[i for i,f in enumerate(frames) if b'\xe2\x96\x88\xe2\x96\x88' in f]
brand=[i for i,f in enumerate(frames) if '◆ jevcode'.encode() in f]
first_brand=brand[0] if brand else len(frames)
after=sum(1 for i in wm if i>=first_brand)
print(len(wm), after, first_brand)
PY
}
# the intake card must stay open until `n` (chat-ambiguous: Enter before the arm is inert, TUI-DESIGN-2 §3.7): the frames
# carrying the card title form one contiguous run, the first `[jevcode]` reply frame comes after it, and the kept-text
# reply (`Okay — edit it`, the Esc/Ctrl-C outcome) never appears; prints "ok" or the reason
intake_card_check() {
  python3 - "$1" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
frames=[re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f) for f in b.split(b'\x1b[?2026h')[1:]]
card=[i for i,f in enumerate(frames) if b'run this as a task?' in f]
if not card: print('no-card'); sys.exit()
if card != list(range(card[0], card[-1]+1)): print('card-closed-and-reopened:%s' % card); sys.exit()
reply=[i for i,f in enumerate(frames) if b'[jevcode] ' in f and i > card[0]]
if not reply: print('no-reply'); sys.exit()
if reply[0] < card[-1]: print('reply-before-card-closed:%d<%d' % (reply[0], card[-1])); sys.exit()
if any('Okay — edit it'.encode() in f for f in frames): print('kept-text-reply'); sys.exit()
print('ok')
PY
}
# an SGR-stripped, CR-free copy of a capture for the text checks (every transcript label is its own dim span, so a
# `grep` on the raw bytes would miss `[step 1] …` and `╭─ jev-only`)
strip_cap() {
  python3 -c 'import re,sys
b=open(sys.argv[1],"rb").read().decode("utf8","replace")
sys.stdout.write(re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\)","",b).replace("\r",""))' "$1"
}
# the `expect` record's time (ms since spawn) for a pattern, or -1
expect_t() {
  python3 - "$1" "$2" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    try: r=json.loads(line)
    except Exception: continue
    if r.get('op')=='expect' and sys.argv[2] in r.get('arg',''):
        print(r['t']); break
else: print(-1)
PY
}
# The environment self-check (see the header): exit 1 when the smoke's env would let a legacy credentials file through.
hermetic_check() {
  fake_home=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-fakehome-XXXXXX"); home=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-home-XXXXXX"); ws=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-ws-XXXXXX")
  mkdir -p "$fake_home/.config/jevcode"; printf '{"provider":"openrouter","apiKey":"%s","jevApiKey":"%s"}\n' "$FAKE_KEY" "$FAKE_KEY" > "$fake_home/.config/jevcode/config.json"
  # shellcheck disable=SC2086
  out=$(cd "$ws" && HOME="$fake_home" env $UNSET $(hermetic_env "$home") node "$BIN" config --workspace "$ws" 2>&1); code=$?
  # the control: the same fake HOME without the smoke's isolation reads the legacy file (so this check is live, not vacuous)
  # shellcheck disable=SC2086
  ctrl=$(cd "$ws" && HOME="$fake_home" env $UNSET -u XDG_CONFIG_HOME JEVCODE_HOME="$home" OPEN_ASSIST_PATH="$home/no-open-assist" node "$BIN" config --workspace "$ws" 2>&1)
  ok=1; checks=""
  echo "$out" | grep -q 'file:' && { ok=0; checks="$checks LEAK:file-source"; } || checks="$checks no-file-source"
  echo "$out" | grep -q "$FAKE_KEY" && { ok=0; checks="$checks LEAK:key-bytes"; } || checks="$checks no-key-bytes"
  echo "$out" | grep -q 'legacy' && { ok=0; checks="$checks LEAK:legacy-warning"; } || checks="$checks no-legacy-warning"
  echo "$ctrl" | grep -q 'file:' && checks="$checks control:legacy-file-read" || { ok=0; checks="$checks CONTROL-DID-NOT-READ-LEGACY-FILE"; }
  [ "$ok" = "1" ] && verdict=PASS || { verdict=FAIL; fail=1; }
  echo "hermetic: $verdict exit=$code (jevcode config under the smoke's env with a legacy credentials file in HOME)$checks"
  rm -rf "$fake_home" "$home" "$ws"
}
case "$1" in
  --wordmark) wordmark "$2"; exit 0;;
  --hermetic) hermetic_check; exit $fail;;
esac
run() {
  name=$1; expected=$2; rows=$3; cols=$4; shift 4
  home=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-home-XXXXXX"); ws=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-ws-XXXXXX")
  extra_env=$(hermetic_env "$home")
  case "$name" in
    sigmid-trust) printf '# instructions\nBe careful.\n' > "$ws/AGENTS.md";;
    plainwarn) mkdir -p "$home/xdg/jevcode"; printf '{"notASetting": 1}\n' > "$home/xdg/jevcode/config.json";;
    review-y|review-d) extra_env="$extra_env JEVCODE_MOCK_REVIEW_AT=2";;
    chat-ambiguous|chat-ambiguous-y|chat-ambiguous-flat) extra_env="$extra_env JEVCODE_MOCK_INTAKE=ambiguous";;
    mode-switch) extra_env="$extra_env TYPESAFE_API_KEY=$FAKE_KEY JEVCODE_ASSERT_NO_NETWORK=1";;
    mode-switch-keyed) extra_env="$extra_env OPENROUTER_API_KEY=$FAKE_KEY JEVCODE_ASSERT_NO_NETWORK=1";;
    # no key anywhere: the isolated HOME holds no credentials file, the workspace has no .env, every key variable is unset
    zero-arg-wizard) extra_env="$extra_env JEVCODE_ASSERT_NO_NETWORK=1";;
    taskfile-header) printf 'create one scratch file and stop\n' > "$ws/todo.md"; set -- run --task-file "$ws/todo.md" --mode jev-on --mock --mock-steps 3;;
  esac
  cap="$OUT/$name.cap"; tim="$OUT/$name.jsonl"; rm -f "$cap" "$tim"
  # shellcheck disable=SC2086
  (cd "$ws" && env $UNSET PTY_ROWS="$rows" PTY_COLS="$cols" $extra_env \
    "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$STEPS/$name.steps" "$cap" "$tim" 60 -- node "$BIN" "$@" --workspace "$ws" >"$OUT/$name.stdout" 2>&1)
  code=$?
  txt="$OUT/$name.txt"; strip_cap "$cap" > "$txt"
  c=$(clears "$cap"); t=$(grep -c '"op":"timeout"' "$tim"); r=$(restores "$cap"); checks=""; ok=1
  [ "$code" = "$expected" ] || ok=0
  [ "$t" = "0" ] || ok=0
  # §14.2: the exit string exactly once per exit in every scenario (the process-wide restoreTerminal is shared by unmount, fatalExit, the engine's exit hook, finishSession and process 'exit')
  [ "$r" = "1" ] || ok=0
  case "$name" in
    resize|chrome-tiers) [ "$c" -le 1 ] || ok=0; checks=" clears<=1(one shrink segment)";;
    resize-live) [ "$c" -le 2 ] || ok=0; checks=" clears<=2(two shrink segments)"
      grep -q 'end human_abort' "$txt" && checks="$checks run:human_abort" || { ok=0; checks="$checks MISSING:human_abort"; };;
    plainwarn|taskfile-missing|firstframe) ;;
    *) [ "$c" = "0" ] || ok=0;;
  esac
  case "$name" in
    firstframe) ff=$(grep -ao 'FIRST_FRAME_MS=[0-9.]*' "$cap" | head -1); checks="$checks $ff";;
    s0-ctrlc) grep -q 'exited on Ctrl-C ×2' "$txt" && checks="$checks scrollback:exited-on-ctrl-c" || { ok=0; checks="$checks MISSING:exited-on-ctrl-c"; };;
    ctrld2) grep -q 'exited on Ctrl-D ×2' "$txt" && checks="$checks scrollback:exited-on-ctrl-d" || { ok=0; checks="$checks MISSING:exited-on-ctrl-d"; };;
    budgetfirst) grep -q '"kind":"budget"' "$home/sessions/index.jsonl" 2>/dev/null && checks="$checks index:budget-line" || { ok=0; checks="$checks MISSING:index-budget-line"; }
      grep -q 'sess \$0.00/15.00' "$txt" && checks="$checks status:sess/15.00" || checks="$checks (status sess/15.00 not seen)";;
    sigmid-trust|sigmid-early) grep -q 'stopped — signal: SIGINT (exit 130)' "$txt" && checks="$checks epilogue:130" || { ok=0; checks="$checks MISSING:epilogue"; };;
    taskfile-missing) grep -q -- '--task-file: cannot read .*ENOENT' "$txt" && checks="$checks usage-line" || { ok=0; checks="$checks MISSING:usage-line"; };;
    oneshot-ctrlc) grep -q 'stopped — human_abort (exit 130)' "$txt" && checks="$checks epilogue:130" || { ok=0; checks="$checks MISSING:epilogue"; };;
    exitlast) grep -q 'end max_steps' "$txt" && checks="$checks run:max_steps";;
    # TUI-DESIGN-2 §8.2 chat-task gates "run dir + jevcode.log": a scenario that must run fails without them
    chat-task|review-y|review-d|s2-esc-pause|s2-ctrlc-abort|chat-ambiguous-y|panel) [ -f "$home/runs/$(ls "$home/runs" 2>/dev/null | head -1)/jevcode.log" ] && checks="$checks run-dir:jevcode.log" || { ok=0; checks="$checks MISSING:run-dir-jevcode.log"; };;
  esac
  case "$name" in
    # TUI-DESIGN-2 §4.5: the compact transcript shows one `[step N]` summary line per step and hides the stage lines
    chat-task) grep -q '^\[step 1\] ' "$txt" && checks="$checks step-line" || { ok=0; checks="$checks MISSING:step-line"; }
      grep -qE '^\[step [0-9]+\] (intent=|context [0-9]+ files|proposal (edit|write|patch|run|read|done) |risk |outcome |judge succeeded=)' "$txt" && { ok=0; checks="$checks STAGE-LINES-VISIBLE"; } || checks="$checks compact:no-stage-lines"
      grep -q '^\[run\] ready' "$txt" && { ok=0; checks="$checks RUN-READY-VISIBLE"; } || checks="$checks compact:no-run-ready";;
    # TUI-DESIGN-2 §3.1 rows 6–7, §8.2: a reply and no run; the wall time Enter → [jevcode] from the mark pair (gate 1.5 s, the live round-2 gate of §9; the mock answers at once)
    chat-hi|chat-facts|chat-ambiguous|chat-ambiguous-flat|mode-switch|mode-switch-keyed|zero-arg-chat|zero-arg-run|splash|splash-wide|splash-reduced|splash-settle|chrome-tiers)
      grep -q '^\[run\] start' "$txt" && { ok=0; checks="$checks RUN-STARTED"; } || checks="$checks no-run"
      [ -d "$home/runs" ] && [ -n "$(ls "$home/runs" 2>/dev/null)" ] && { ok=0; checks="$checks RUN-DIR"; };;
  esac
  case "$name" in
    chat-hi) w=$(wall "$tim" hi-sent hi-reply); checks="$checks wall_enter_to_reply=${w}ms"; [ "$w" -ge 0 ] && [ "$w" -le 1500 ] || ok=0;;
    # §3.7: the card stays open through the pre-arm Enter until `n`; the Esc/Ctrl-C outcome (`Okay — edit it`) never appears
    chat-ambiguous) grep -q 'run this as a task?' "$txt" && checks="$checks intake-card" || { ok=0; checks="$checks MISSING:intake-card"; }
      ic=$(intake_card_check "$cap"); [ "$ic" = "ok" ] && checks="$checks enter-inert:card-open-until-n" || { ok=0; checks="$checks ENTER-NOT-INERT:$ic"; };;
    # §3.7 flat tier at 12x60: the 39-cell ladder form, `n` replies, no card edges
    chat-ambiguous-flat) grep -q 'run this as a task?  \[y\] \[n\]  Esc keeps' "$txt" && checks="$checks intake-row:narrow" || { ok=0; checks="$checks MISSING:intake-row"; }
      grep -q '╭─ run this as a task' "$txt" && { ok=0; checks="$checks CARD-IN-FLAT-TIER"; }
      ic=$(intake_card_check "$cap"); [ "$ic" = "ok" ] && checks="$checks enter-inert" || { ok=0; checks="$checks ENTER-NOT-INERT:$ic"; };;
    # §9 review invariants: Enter on the armed card is inert and only `y` approves — exactly one `confirm … approved` in transcript.log, the typed `y` never an echo
    review-y) n_ok=$(grep -c 'confirm [^ ]* approved' "$home/runs/$(ls "$home/runs" 2>/dev/null | head -1)/transcript.log" 2>/dev/null); [ "$n_ok" = "1" ] && checks="$checks one-approval" || { ok=0; checks="$checks APPROVALS=$n_ok"; }
      grep -q '› y' "$txt" && { ok=0; checks="$checks Y-TYPED-AS-TEXT"; } || checks="$checks enter-inert:no-y-echo";;
    mode-switch) grep -q 'Pick the generator provider' "$txt" && { ok=0; checks="$checks STARTUP-WIZARD"; } || checks="$checks in-place-wizard";;
    mode-switch-keyed) grep -q 'jev+llm · next run' "$txt" && checks="$checks badge:next-run" || { ok=0; checks="$checks MISSING:badge"; };;
    splash|splash-wide) set -- $(wordmark "$cap"); checks="$checks wordmark_before_key=$1 after_key=$2"; [ "$1" -gt 0 ] && [ "$2" = "0" ] || ok=0
      ff=$(expect_t "$tim" 'step 0/'); checks="$checks first_frame_t=${ff}ms";;
    splash-reduced) set -- $(wordmark "$cap"); checks="$checks wordmark_cells=$(( $1 + $2 ))"; [ "$(( $1 + $2 ))" = "0" ] || ok=0;;
    # §5.2: no key — ≤ 15 wordmark frames (50 ms ticks over 700 ms), none at or after the brand row's frame; the settle time from the driver's clock
    splash-settle) set -- $(splash_settle "$cap"); checks="$checks wordmark_frames=$1 after_brand=$2"; [ "$1" -ge 1 ] && [ "$1" -le 15 ] && [ "$2" = "0" ] || ok=0
      ff=$(expect_t "$tim" 'step 0/'); st=$(expect_t "$tim" 'jevcode'); checks="$checks settle_t=$(( st - ff ))ms";;
    chrome-tiers) grep -q '╭─ jev-only' "$txt" && grep -q 'jev-only · idle' "$txt" && checks="$checks boxed+flat" || { ok=0; checks="$checks MISSING:tier-rows"; };;
    zero-arg-chat|zero-arg-run) grep -q '╭─ jev-only' "$txt" && checks="$checks badge:jev-only" || { ok=0; checks="$checks MISSING:badge"; }
      grep -q 'Where do you reach Jev\|Pick the generator provider' "$txt" && { ok=0; checks="$checks WIZARD"; } || checks="$checks no-wizard";;
    zero-arg-wizard) grep -q 'Where do you reach Jev' "$txt" && checks="$checks wizard:jev-provider" || { ok=0; checks="$checks MISSING:jev-provider-step"; }
      grep -q 'Pick the generator provider' "$txt" && { ok=0; checks="$checks GENERATOR-STEP"; } || checks="$checks no-generator-step";;
    panel) grep -q '▾ decisions' "$txt" && grep -q 'more rows' "$txt" && checks="$checks panel:open+more-row" || { ok=0; checks="$checks MISSING:panel-rows"; };;
  esac
  [ "$ok" = "1" ] && verdict=PASS || { verdict=FAIL; fail=1; }
  echo "$name: $verdict exit=$code (expected $expected) clears_after_first_frame=$c restores=$r timeouts=$t$checks"
  rm -rf "$home" "$ws"
}
want="$*"
sel() { [ -z "$want" ] || echo " $want " | grep -q " $1 "; }
MOCK_RUN="--mode jev-on --mock"
sel hermetic && hermetic_check
sel firstframe && run firstframe 0 24 80 chat --mock --perf-exit-after-first-frame
sel chat-task && run chat-task 0 24 80 chat $MOCK_RUN --mock-steps 4
sel chat-hi && run chat-hi 0 24 80 chat --mock
sel chat-facts && run chat-facts 0 24 80 chat --mock
sel chat-ambiguous && run chat-ambiguous 0 24 80 chat --mock
sel chat-ambiguous-y && run chat-ambiguous-y 0 24 80 chat $MOCK_RUN --mock-steps 3
sel chat-ambiguous-flat && run chat-ambiguous-flat 0 12 60 chat --mock
sel mode-switch && run mode-switch 0 24 80 chat
sel mode-switch-keyed && run mode-switch-keyed 0 24 80 chat
sel splash && run splash 0 24 80 chat --mock
sel splash-wide && run splash-wide 0 40 120 chat --mock
sel splash-reduced && run splash-reduced 0 24 80 chat --mock --no-animation
sel splash-settle && run splash-settle 0 24 80 chat --mock
sel panel && run panel 0 24 80 chat $MOCK_RUN --mock-steps 4
sel chrome-tiers && run chrome-tiers 0 24 80 chat --mock
sel zero-arg-chat && run zero-arg-chat 0 24 80 --mock
sel zero-arg-run && run zero-arg-run 0 24 80 run --mock
sel zero-arg-wizard && run zero-arg-wizard 2 24 80
sel s0-ctrlc && run s0-ctrlc 0 24 80 chat --mock
sel ctrld2 && run ctrld2 0 24 80 chat --mock
sel s1-clear && run s1-clear 0 24 80 chat --mock
# 200 mocked steps (~4 s at ~20 ms/step): the key must land while the run is live (a 40-step run ends in ~0.8 s)
sel s2-ctrlc-abort && run s2-ctrlc-abort 0 24 80 chat $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
sel s2-esc-pause && run s2-esc-pause 0 24 80 chat $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
sel review-y && run review-y 0 24 80 chat $MOCK_RUN --mock-steps 5
sel review-d && run review-d 0 24 80 chat $MOCK_RUN --mock-steps 5
sel resize && run resize 0 24 80 chat --mock
sel resize-grow && run resize-grow 0 12 60 chat --mock
sel resize-live && run resize-live 0 40 100 chat $MOCK_RUN --mock-steps 400 --max-steps 400 --max-replans 100
sel exitlast && run exitlast 4 24 80 chat $MOCK_RUN --mock-steps 6 --max-steps 2 --exit-code last-run
sel budgetfirst && run budgetfirst 0 24 80 chat $MOCK_RUN --mock-steps 4
sel sigmid-trust && run sigmid-trust 130 24 80 chat --mock
sel sigmid-early && run sigmid-early 130 24 80 chat --mock
sel plainwarn && run plainwarn 0 24 80 chat --plain --mock
sel taskfile-missing && run taskfile-missing 2 24 80 run --task-file /nonexistent/dir/todo.md --mock
sel taskfile-header && run taskfile-header 0 24 80 run --task-file WS_TODO --mode jev-on --mock --mock-steps 3
sel oneshot-ctrlc && run oneshot-ctrlc 130 24 80 run "probe task" $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
exit $fail
