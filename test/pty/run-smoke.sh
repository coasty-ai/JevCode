#!/bin/sh
# TUI-DESIGN §19.5 / TUI-DESIGN-2 §8.2 real-pty smoke over the built bundle (bin/jevcode.js): every scenario runs
# scripts/pty/drive.exp with a fresh JEVCODE_HOME and workspace (the child's cwd is the workspace, so the repository's
# ./.env is never read, JEVCODE_EXTRA_ENV_FILE points at a path that does not exist so no second dotenv can supply
# keys even if the variable is already set in the developer's shell — and every key variable is unset; a scenario that
# needs a key sets a fake one), then reports the
# exit code, the clear count after the first dynamic frame (§18 CLEAR_RE, with one Ink clearTerminal `ESC[2J ESC[3J
# ESC[H` counted once: must be 0 in every scenario without a shrink in rows; research 20 item 1 allows one per shrink —
# `resize`, `resize-live` and `chrome-tiers` shrink once or twice, so their gates are 1 / 2 / 1), the count of the exit
# string RESTORE (`ESC[?2004l ESC[?2026l ESC[0 SP q ESC[?25h ESC[0m`, §14.2: written exactly once per exit in every
# scenario — the one process-wide restoreTerminal() is shared by the Ink unmount, fatalExit, the engine's exit hook, the
# controller's finishSession and process 'exit'; a --plain TTY exit writes it once too), expect timeouts and the
# scenario's own checks.
#
# Round 2 (TUI-DESIGN-2) / round 3 (TUI-DESIGN-3 §1.10): every scenario that needs the scripted `--mock` trajectory says
# `--mode jev-on` explicitly (the trajectory is a generator trajectory whatever the default is; under jev-only `--mock` would run
# the real synthesizer); the zero-argument scenarios start without a mode and expect the DEFAULT badge (`jev+llm` since round 3,
# read from src/config/defaults.ts by `default_badge`). Round 3 adds: wordmark-* (the persistent mark, TUI-DESIGN-3 §3), theme-*
# (the TypeSafe pink, §2), polish (the §9 hero-frame checklist through scripts/pty/polish-check.mjs), r3-* / ts-only-* (the one-key
# wizard, §1), commands-* / trust-esc / keybindings (the §4 audit). Round-2 scenarios: chat-hi (a greeting → a [jevcode] reply, no run,
# wall time recorded), chat-facts, chat-task (today's chat-run-exit; compact transcript), chat-ambiguous(-y) (the intake
# card; -flat at 12x60), mode-switch(-keyed) (/mode jev-on without / with a generator key), splash, splash-wide,
# wordmark-reduced (was splash-reduced), splash-settle (no key: the splash settles by itself), panel, chrome-tiers, zero-arg-chat, zero-arg-run,
# zero-arg-wizard.
# Hermetic child environment (§8.2; docs/STATUS.md "Round 2" finding 2): HOME, XDG_CONFIG_HOME and JEVCODE_HOME inside
# the scenario's temp home — `resolveConfig` falls back to the legacy $HOME/.config/jevcode/config.json when the XDG
# file is absent (src/config/resolve.ts), so a developer's saved login must never be a candidate — JEVCODE_CONFIG and
# every key variable unset, JEVCODE_EXTRA_ENV_FILE at a path that does not exist. `run-smoke.sh --hermetic` proves it:
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
# the default mode's badge word, read from the one table (TUI-DESIGN-3 §1.1 D-N: no literal names the default here)
default_badge() {
  python3 - "$ROOT/src/config/defaults.ts" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
m=re.search(r"DEFAULT_MODE: EngineMode = '([a-z-]+)'", t)
w=re.search(r"MODE_BADGE_WORD[^=]*=\s*\{([^}]*)\}", t)
tbl=dict(re.findall(r"'([^']+)': '([^']+)'", w.group(1)))
print(tbl[m.group(1)])
PY
}
BADGE=$(default_badge)
BADGE_RE=$(printf '%s' "$BADGE" | sed 's/[+.]/\\&/g')
# the variables every child loses (see the header); `env -u` takes them one by one
UNSET="-u CI -u CONTINUOUS_INTEGRATION -u JEV_API_KEY -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY -u ANTHROPIC_API_KEY -u JEVCODE_API_KEY -u JEVCODE_MODE -u JEV_PROVIDER -u JEVCODE_CONFIG -u JEVCODE_MOCK_INTAKE -u JEVCODE_MOCK_REVIEW_AT -u JEVCODE_MOCK_JEV_MS -u JEVCODE_ASSERT_NO_NETWORK -u JEVCODE_TRACE -u JEVCODE_FAULT -u JEVCODE_SUBMIT_WATCHDOG_MS -u JEVCODE_ASSERT_HEIGHT"
# the isolated home of one child: `hermetic_env <home>` prints the VAR=value words every scenario gets
hermetic_env() { echo "HOME=$1 XDG_CONFIG_HOME=$1/xdg JEVCODE_HOME=$1 JEVCODE_EXTRA_ENV_FILE=$1/no-extra-env"; }
# TUI-DESIGN-4 §7.1 / §11: the frame count of a capture (every Ink frame of the App opens with ESC[?2026h).
# A latched pane must not raise it: an unlatched persistent throw was one UNTHROTTLED frame per iteration.
frames_in() {
  python3 - "$1" <<'PYF'
import sys
b = open(sys.argv[1], 'rb').read()
print(max(0, b.count(b'\x1b[?2026h')))
PYF
}
# TUI-DESIGN-4 §11 / §1.4: `ESC[3J` deletes the USER's scrollback and must never be written — not by Ink's
# `clearTerminal`, not at unmount, not at any geometry. `guardStdout` (src/tui/scrollback-guard.ts) drops it;
# this counts it in the raw capture so the guard cannot regress silently. Zero in EVERY scenario, always.
three_j() {
  python3 - "$1" <<'PYJ'
import re, sys
print(len(re.findall(rb'\x1b\[[0-9;]*3J', open(sys.argv[1], 'rb').read())))
PYJ
}
# TUI-DESIGN-4 §11 (new row): NO FRAME TALLER THAN THE TERMINAL. The dynamic region starts at the rule row; a
# frame that paints more than `rows` rows below it scrolls the scrollback away. Counted per frame over the whole
# capture; the first frame after each `resize` is skipped (it is laid out for the geometry that just left —
# §2.0: a terminal receives that frame whatever the renderer does).
tall_frames() {
  python3 - "$1" "$2" <<'PYT'
import re, sys
b = open(sys.argv[1], 'rb').read()
rows = int(sys.argv[2])
frames = b.split(b'\x1b[?2026h')[1:]
strip = lambda f: re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f)
# EXACTLY `src/perf/pty.ts`'s RULE_ROW_RE and paintedRows(): the LAST rule row opens the region (a frame may
# carry two rule-shaped rows), and the three dashes must be followed by a space, a dash, a rule byte or the end
# of the row — `^-{3}` alone matched any scrollback row beginning `---` and measured a healthy frame as tall.
RULE = re.compile(rb'^(?:(?:\xe2\x94\x80){3}|-{3})(?:[ -]|\xe2|$)')
bad = 0
for f in frames:
    ls = [l.rstrip(b'\r') for l in strip(f).split(b'\n')]
    while ls and ls[-1] == b'': ls.pop()
    i = next((k for k in range(len(ls) - 1, -1, -1) if RULE.match(ls[k])), None)
    if i is None: continue
    if len(ls) - i > rows: bad += 1
print(bad)
PYT
}
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
m=re.search(rb'(?:\xe2\x80\xba|>)(?:\x1b\[[0-9;]*m)* (?:\x1b\[[0-9;]*m)*h', b)  # the pink prompt closes an SGR before the echo
if m:
    cut=b.rfind(b'\x1b[?25l', 0, m.start())
    if cut < 0: cut=m.start()
else:
    cut=len(b)
print(b[:cut].count(b'\xe2\x96\x88\xe2\x96\x88'), b[cut:].count(b'\xe2\x96\x88\xe2\x96\x88'))
PY
}
# round 3 (TUI-DESIGN-3 §3): frames = synchronized-output brackets; the settle frame is the first carrying the caption `◆ <version>`
# (the brand row `◆ jevcode` in the frames that hide the mark). `wm_frames_between <cap> <after_re> <before_re>` prints the count
# of frames strictly between the first frame matching <after_re> and the first later frame matching <before_re>, plus the largest
# frame in bytes, the count of those carrying a sweep-band SGR (38;5;224 / 38;2;251;208;220) and whether every one keeps the mark's
# letters equal to the settle frame's (stripped): "<frames> <max_bytes> <band_frames> <letters_ok>"
wm_frames_between() {
  python3 - "$1" "$2" "$3" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
frames=b.split(b'\x1b[?2026h')[1:]
strip=lambda f: re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f)
after=re.compile(sys.argv[2].encode()); before=re.compile(sys.argv[3].encode())
i0=next((i for i,f in enumerate(frames) if after.search(strip(f))), None)
if i0 is None: print('-1 0 0 0'); sys.exit()
i1=next((i for i in range(i0+1,len(frames)) if before.search(strip(frames[i]))), len(frames))
mid=frames[i0+1:i1]
letters=lambda f: [l for l in strip(f).split(b'\r\n') if b'\xe2\x96\x88\xe2\x96\x88' in l]
ref=letters(frames[i0])
ok=all(letters(f)==ref for f in mid) if mid else True
band=sum(1 for f in mid if re.search(rb'38;5;224m|38;2;251;208;220m', f))
print(len(mid), max([len(f) for f in mid] or [0]), band, 1 if ok else 0)
PY
}
# "<head_frames> <mark_frames> <markless_frames> <frames>": frames carrying the sweep head `▓▒░` (the reveal), frames carrying the resting
# mark (≥ 5 `██` rows), frames with a rule row but no `██` cell, all frames
wm_shape() {
  python3 - "$1" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
frames=b.split(b'\x1b[?2026h')[1:]
strip=lambda f: re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f)
head=sum(1 for f in frames if b'\xe2\x96\x93\xe2\x96\x92\xe2\x96\x91' in strip(f))
mark=sum(1 for f in frames if sum(1 for l in strip(f).split(b'\r\n') if b'\xe2\x96\x88\xe2\x96\x88' in l) >= 5)
none=sum(1 for f in frames if b'\xe2\x96\x88\xe2\x96\x88' not in strip(f) and re.search(rb'(?:\xe2\x94\x80){3}', strip(f)))
print(head, mark, none, len(frames))
PY
}
# the dynamic-region row count of the frame that first matches <re> (rule row → last row), or -1
wm_rows_at() {
  python3 - "$1" "$2" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
frames=b.split(b'\x1b[?2026h')[1:]
strip=lambda f: re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f)
pat=re.compile(sys.argv[2].encode())
for f in frames:
    t=strip(f)
    if pat.search(t):
        rows=t.split(b'\r\n')
        while rows and rows[-1].strip()==b'': rows.pop()
        idx=next((i for i,l in enumerate(rows) if re.match(rb'^(?:\xe2\x94\x80){3}|^-{3}', l)), None)
        print(-1 if idx is None else len(rows)-idx); sys.exit()
print(-1)
PY
}
# frames from the first that matches <from_re> on (stripped): 0 when none of them carries ≥ 5 `██` rows, else 1
wm_mark_after() {
  python3 - "$1" "$2" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
frames=[re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f) for f in b.split(b'\x1b[?2026h')[1:]]
pat=re.compile(sys.argv[2].encode())
i=next((i for i,f in enumerate(frames) if pat.search(f)), None)
mark=lambda f: sum(1 for l in f.split(b'\r\n') if b'\xe2\x96\x88\xe2\x96\x88' in l)>=5
print(-1 if i is None else (1 if any(mark(f) for f in frames[i:]) else 0))
PY
}
# the wordmark-handoff / wordmark-22-postrun / wordmark-21 structural checks: prints "ok" or the failing rule
wm_handoff() {
  python3 - "$1" "$2" <<'PY'
import re,sys
b=open(sys.argv[1],'rb').read()
frames=[re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]', b'', f) for f in b.split(b'\x1b[?2026h')[1:]]
mark=lambda f: sum(1 for l in f.split(b'\r\n') if b'\xe2\x96\x88\xe2\x96\x88' in l)>=5
which=sys.argv[2]
if which=='handoff':
    start=next((i for i,f in enumerate(frames) if re.search(rb'\[run\] started (?:\xc2\xb7|-) ', f)), None)
    end=next((i for i,f in enumerate(frames) if re.search(rb'\] finished (?:\xc2\xb7|-) (complete|max_steps|generator_done)', f)), None)
    if start is None or end is None: print('no-run'); sys.exit()
    # the mark is hidden for the whole run; the frame that commits `[run] end` also commits the state change, so it may already
    # carry the mark back (TUI-DESIGN-3 §3.2 "run:end -> idle": one frame earlier than the prose's "the frame after end")
    if any(mark(f) for f in frames[start:end]): print('mark-while-live'); sys.exit()
    after=frames[end:]
    back=next((i for i,f in enumerate(after) if mark(f) and b'\xe2\x96\xb8 jev' in f), None)
    if back is None: print('no-return-under-strip'); sys.exit()
    panel=next((i for i,f in enumerate(after) if b'\xe2\x96\xbe decisions' in f), None)
    if panel is None or mark(after[panel]): print('panel-did-not-hide'); sys.exit()
    off=next((i for i in range(panel+1,len(after)) if b'\xe2\x96\xb8 jev' in after[i] and mark(after[i])), None)
    print('ok' if off is not None else 'no-return-after-panel-off')
elif which=='postrun22':
    end=next((i for i,f in enumerate(frames) if re.search(rb'\] finished (?:\xc2\xb7|-) (complete|max_steps|generator_done)', f)), None)
    echo=next((i for i,f in enumerate(frames) if re.search(rb'(?:\xe2\x80\xba|>) h', f)), None)
    if end is None or echo is None: print('no-run-or-echo'); sys.exit()
    if any(mark(f) for f in frames[end:echo]): print('mark-before-first-key'); sys.exit()
    print('ok' if mark(frames[echo]) else 'no-mark-on-first-key')
elif which=='palette21':
    pal=[f for f in frames if b'Tab' in f and b'commands' in f]
    print('ok' if pal and all(mark(f) for f in pal) else 'palette-handoff')
elif which=='flat-no-mark':
    # TUI-DESIGN-2 §1.5: the flat tier's badge prefix is the FIRST thing dropped when the row runs short, and the
    # `llm-jev` default badge is 18 cells — a 60-column flat status row cannot carry it. A flat frame is one with
    # a status row at column 0 and no rounded box edge.
    flat=[f for f in frames if re.search(rb'\r\nidle {2,}step 0/', f) and b'\xe2\x95\xad' not in f]
    print('ok' if flat and not any(b'\xe2\x96\x88\xe2\x96\x88' in f for f in flat) else 'mark-in-flat-tier')
elif which=='head-after-echo':
    echo=next((i for i,f in enumerate(frames) if re.search(rb'(?:\xe2\x80\xba|>) h', f)), None)
    print('ok' if echo is not None and all(b'\xe2\x96\x93\xe2\x96\x92\xe2\x96\x91' not in f for f in frames[echo:]) else 'head-after-echo')
PY
}
# the wall time (ms) between the first `send h` and the first `expect` that matched it, or -1
echo_wait() {
  python3 - "$1" <<'PY'
import json,sys
s=r=None
for line in open(sys.argv[1]):
    try: x=json.loads(line)
    except Exception: continue
    if x.get('op')=='send' and x.get('arg')=='h' and s is None: s=x['t']
    if x.get('op')=='expect' and s is not None and r is None and x.get('arg','').endswith('h'): r=x['t']
print(-1 if s is None or r is None else r-s)
PY
}
# the bytes of the first dynamic frame (cursor hide → cursor show)
first_frame() {
  python3 -c 'import sys; b=open(sys.argv[1],"rb").read(); i=b.find(b"\x1b[?25l"); j=b.find(b"\x1b[?25h", i); sys.stdout.buffer.write(b[i:j] if i>=0 else b"")' "$1"
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
  ctrl=$(cd "$ws" && HOME="$fake_home" env $UNSET -u XDG_CONFIG_HOME JEVCODE_HOME="$home" JEVCODE_EXTRA_ENV_FILE="$home/no-extra-env" node "$BIN" config --workspace "$ws" 2>&1)
  ok=1; checks=""
  # TUI-DESIGN-4 §3.3: `config-table.ts` renders the source as a `(file)` note row now, not a `file:<path>` column
  echo "$out" | grep -qE '\(file\)|file:' && { ok=0; checks="$checks LEAK:file-source"; } || checks="$checks no-file-source"
  echo "$out" | grep -q "$FAKE_KEY" && { ok=0; checks="$checks LEAK:key-bytes"; } || checks="$checks no-key-bytes"
  echo "$out" | grep -q 'legacy' && { ok=0; checks="$checks LEAK:legacy-warning"; } || checks="$checks no-legacy-warning"
  echo "$ctrl" | grep -qE '\(file\)|file:' && checks="$checks control:legacy-file-read" || { ok=0; checks="$checks CONTROL-DID-NOT-READ-LEGACY-FILE"; }
  [ "$ok" = "1" ] && verdict=PASS || { verdict=FAIL; fail=1; }
  echo "hermetic: $verdict exit=$code (jevcode config under the smoke's env with a legacy credentials file in HOME)$checks"
  rm -rf "$fake_home" "$home" "$ws"
}
case "$1" in
  --wordmark) wordmark "$2"; exit 0;;
  --hermetic) hermetic_check; exit $fail;;
esac
# TUI-DESIGN-4 §7.4 / §10 S6: the launch failure with stdout and stderr in SEPARATE files. A read-only $HOME
# used to print `[ui] error: EACCES: permission denied, mkdir '<home>/runs'` on **stdout**, with an empty stderr,
# no epilogue and exit 1. The gate: stdout empty, stderr carries the sentence AND its fix row, exit 2.
readonly_home_nopty() {
  h=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-rohome-XXXXXX"); w=$(mktemp -d "${TMPDIR:-/tmp}/jevcode-pty-rows-XXXXXX")
  mkdir -p "$h/xdg"; chmod 500 "$h"
  o="$OUT/readonly-home.nopty.out"; e="$OUT/readonly-home.nopty.err"
  # shellcheck disable=SC2086
  (cd "$w" && env $UNSET $(hermetic_env "$h") node "$BIN" run "say hi" --mode jev-on --mock --mock-steps 1 --workspace "$w" >"$o" 2>"$e" </dev/null)
  rc=$?
  chmod -R u+rwx "$h" 2>/dev/null || true; rm -rf "$h" "$w"
  [ "$rc" = "2" ] || { echo "exit=$rc(want 2)"; return 0; }
  [ -s "$o" ] && { echo "stdout-not-empty"; return 0; }
  grep -q 'cannot create the runs directory' "$e" || { echo "no-explain-on-stderr"; return 0; }
  grep -q 'set JEVCODE_HOME to a writable directory' "$e" || { echo "no-fix-on-stderr"; return 0; }
  echo ok
}
run() {
  name=$1; expected=$2; rows=$3; cols=$4; shift 4
  steps_name=$name
  case "$name" in polish-wide) steps_name=polish;; wordmark-idle-wide) steps_name=wordmark-idle;; esac
  # TUI-DESIGN-4 §10 S6: the eight `fault-<pane>` scenarios share three steps files — the boundaries that only
  # render during a run, the ones in the idle frame, and the two with a shape of their own — and each runs at
  # BOTH 24×80 (boxed) and 12×60 (flat), which is the tier where a fallback's height is hardest to get right.
  case "$name" in
    fault-pane|fault-overlay) steps_name=fault-run;;
    fault-composer|fault-static|fault-transcript) steps_name=fault-idle;;
    fault-persistent-flat) steps_name=fault-persistent;;
    fault-wordmark-flat) steps_name=fault-wordmark;;
    fault-status-flat) steps_name=fault-status;;
    # TUI-DESIGN-5 §10: the two `--ascii` twins share their sibling's .steps file — the glyph set is chosen at
    # LAUNCH, so the twin cannot be a resize and has to be a second scenario (§12's twin rule).
    r5-who-ascii) steps_name=r5-who;;
    r5-model-picker-ascii) steps_name=r5-model-picker;;
    r5-import-overlay-ascii) steps_name=r5-import-overlay;;
  esac
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
    zero-arg-wizard|r3-options-ctrlc|r3-key-paste-newline|r3-wizard-resize|r3-wizard-masked-key|r3-wizard-sr|r3-plain-wizard) extra_env="$extra_env JEVCODE_ASSERT_NO_NETWORK=1";;
    ts-only-start) extra_env="$extra_env TYPESAFE_API_KEY=$FAKE_KEY JEVCODE_ASSERT_NO_NETWORK=1"; TS_HOME="$home";;
    # the restart reuses ts-only-start's HOME (its config.json carries `mode: jev-only`)
    ts-only-restart) if [ -n "$TS_HOME" ]; then rm -rf "$home"; home="$TS_HOME"; extra_env="$(hermetic_env "$home") TYPESAFE_API_KEY=$FAKE_KEY JEVCODE_ASSERT_NO_NETWORK=1"; fi;;
    r3-env-jev-only) extra_env="$extra_env OPENROUTER_API_KEY=$FAKE_KEY JEVCODE_MODE=jev-only JEVCODE_ASSERT_NO_NETWORK=1";;
    commands-thinking) extra_env="$extra_env JEVCODE_MOCK_JEV_MS=1500";;
    trust-esc) printf '# instructions\nBe careful.\n' > "$ws/AGENTS.md";;
    keybindings) printf '{ "global:help": "none" }\n' > "$ws/kb.json"; set -- chat --mock --keybindings "$ws/kb.json";;
    taskfile-header) printf 'create one scratch file and stop\n' > "$ws/todo.md"; set -- run --task-file "$ws/todo.md" --mode jev-on --mock --mock-steps 3;;
    # --- TUI-DESIGN-4 §7 (round 4): the fault scenarios. One typed JEVCODE_FAULT per row (§7.11's grammar).
    # NOTE: the pre-mount rejection of an unknown value (`readFaultEnv` -> stderr -> exit 2) is NOT wired yet —
    # its call site is `src/cli/main.tsx`, another slot's file — so a typo here is a silent no-op at run time
    # and the scenario fails on its own `expect` instead. `test/unit/tui/faults.test.ts` is what holds the
    # grammar honest until the §9.2 request lands.
    fault-persistent|fault-persistent-flat) extra_env="$extra_env JEVCODE_FAULT=render:transcript:lines:sticky";;
    fault-wordmark|fault-wordmark-flat) extra_env="$extra_env JEVCODE_FAULT=render:wordmark";;
    fault-status|fault-status-flat) extra_env="$extra_env JEVCODE_FAULT=render:status";;
    fault-live) extra_env="$extra_env JEVCODE_FAULT=render:live";;
    fault-pane) extra_env="$extra_env JEVCODE_FAULT=render:pane";;
    fault-overlay) extra_env="$extra_env JEVCODE_FAULT=render:overlay JEVCODE_MOCK_REVIEW_AT=2";;
    fault-composer) extra_env="$extra_env JEVCODE_FAULT=render:composer";;
    fault-static) extra_env="$extra_env JEVCODE_FAULT=render:static";;
    fault-transcript) extra_env="$extra_env JEVCODE_FAULT=render:transcript";;
    rundir-vanishes) extra_env="$extra_env JEVCODE_FAULT=rundir:rm:after=3";;
    stuck-submit) extra_env="$extra_env JEVCODE_FAULT=submit:hang JEVCODE_SUBMIT_WATCHDOG_MS=1500";;
    peers) extra_env="$extra_env JEVCODE_FAULT=peer:2";;
    # --- TUI-DESIGN-5 §10: the five round-5 scenarios (verbatim from each .steps header) -------------------------
    # fix pass, finding 19: `JEVCODE_FAULT=peer:5` is parsed and validated by src/tui/faults.ts and read by
    # NOTHING (`grep -rn "kind === 'peer'" src/` is empty), so it was a dead pointer that made a reader believe
    # the rows in this capture came from an injected fault. The rows are real: step 0 runs a `--mock` task, which
    # opens the ledger and starts the heartbeat writer, and step 1 renders this session's own row off the fold.
    r5-who|r5-who-ascii) extra_env="$extra_env JEVCODE_ASSERT_NO_NETWORK=1";;
    r5-message) extra_env="$extra_env JEVCODE_FAULT=peer:3";;
    r5-context) extra_env="$extra_env JEVCODE_CONTEXT_COMPACTION=code";;
    r5-model-picker|r5-model-picker-ascii) extra_env="$extra_env OPENROUTER_API_KEY=$FAKE_KEY JEVCODE_ASSERT_NO_NETWORK=1";;
    # §5.2: the hermetic $HOME has nothing to import, so the overlay would be §12.4 S92's one row. One memory file
    # is seeded so the five-group view is the thing under test; the key is exported so gate G-R5-9 has a target.
    r5-import-overlay|r5-import-overlay-ascii)
      extra_env="$extra_env OPENROUTER_API_KEY=$FAKE_KEY JEVCODE_ASSERT_NO_NETWORK=1"
      mkdir -p "$home/.claude"
      printf '# notes\n\nAlways run the tests before proposing a patch.\n' > "$home/.claude/CLAUDE.md"
      ;;
    # §7.4: a read-only $HOME is the measured launch failure — chmod AFTER the hermetic dirs exist
    readonly-home) mkdir -p "$home/xdg"; chmod 500 "$home";;
  esac
  cap="$OUT/$name.cap"; tim="$OUT/$name.jsonl"; rm -f "$cap" "$tim"
  # shellcheck disable=SC2086
  (cd "$ws" && env $UNSET PTY_ROWS="$rows" PTY_COLS="$cols" $extra_env \
    "$ROOT/scripts/pty/drive.exp" --kill-on-timeout "$STEPS/$steps_name.steps" "$cap" "$tim" 60 -- node "$BIN" "$@" --workspace "$ws" >"$OUT/$name.stdout" 2>&1)
  code=$?
  txt="$OUT/$name.txt"; strip_cap "$cap" > "$txt"
  c=$(clears "$cap"); t=$(grep -c '"op":"timeout"' "$tim"); r=$(restores "$cap"); checks=""; ok=1
  # TUI-DESIGN-4 §11 (new row): no `ESC[3J` ever, in every capture, at every geometry
  j=$(three_j "$cap"); [ "$j" = "0" ] && checks="$checks no-3j" || { ok=0; checks="$checks ESC-3J=$j"; }
  # TUI-DESIGN-4 §11 (new row): NO FRAME TALLER THAN THE TERMINAL — `paintedRows <= rows`, every frame, every
  # capture. A capture has ONE geometry here, so the gate is exact and zero is the only allowance. A capture with
  # a `resize` step has several, and telling a stale-geometry frame from an over-tall one needs the SIGWINCH byte
  # offset that only the typist records — `src/perf/states.ts` gates those per geometry segment (`regionMax`,
  # `stalePaints`, `budgetOk`), so this leg SKIPS them instead of judging every frame at the smallest geometry.
  if grep -qE '^resize ' "$STEPS/$steps_name.steps" 2>/dev/null; then
    checks="$checks tall-frames=(states.ts, per segment)"
  else
    tf=$(tall_frames "$cap" "$rows")
    [ "$tf" = "0" ] && checks="$checks no-tall-frame" || { ok=0; checks="$checks TALL-FRAMES=$tf(>${rows}rows)"; }
  fi
  [ "$code" = "$expected" ] || ok=0
  [ "$t" = "0" ] || ok=0
  # §14.2: the exit string exactly once per exit in every scenario (the process-wide restoreTerminal is shared by
  # unmount, fatalExit, the engine's exit hook, finishSession and process 'exit'). A scenario that never enters
  # the alternate screen has nothing to restore and must NOT emit it: `doctor` prints rows and exits, it takes no
  # raw mode, no bracketed paste and no cursor hiding, so writing RESTORE would be a stray escape in a pipe.
  case "$name" in
    doctor) [ "$r" = "0" ] || { ok=0; checks="$checks UNEXPECTED-RESTORE=$r"; };;
    *) [ "$r" = "1" ] || ok=0;;
  esac
  case "$name" in
    # TUI-DESIGN-5 §5.8 / §7 row 85: `r5-import-overlay` drives 24x80 -> 12x60 -> 40x120 with the overlay up, so
    # it has exactly ONE shrink segment and research 20 item 1's one-clear-per-shrink allowance applies to it.
    resize|chrome-tiers|r3-wizard-resize|r5-import-overlay|r5-import-overlay-ascii) [ "$c" -le 1 ] || ok=0; checks="$checks clears<=1(one shrink segment)";;
    resize-live) [ "$c" -le 2 ] || ok=0; checks="$checks clears<=2(two shrink segments)"
      grep -qE 'finished (·|-) human_abort' "$txt" && checks="$checks run:human_abort" || { ok=0; checks="$checks MISSING:human_abort"; };;
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
    exitlast) grep -qE 'finished (·|-) max_steps' "$txt" && checks="$checks run:max_steps";;
    # TUI-DESIGN-2 §8.2 chat-task gates "run dir + jevcode.log": a scenario that must run fails without them
    chat-task|review-y|review-d|s2-esc-pause|s2-ctrlc-abort|chat-ambiguous-y|panel|wordmark-handoff|wordmark-22-postrun|theme-pink|polish|polish-wide) [ -f "$home/runs/$(ls "$home/runs" 2>/dev/null | head -1)/jevcode.log" ] && checks="$checks run-dir:jevcode.log" || { ok=0; checks="$checks MISSING:run-dir-jevcode.log"; };;
  esac
  case "$name" in
    # TUI-DESIGN-2 §4.5: the compact transcript shows one `[step N]` summary line per step and hides the stage lines
    chat-task) grep -q '^ *\[step 1\] ' "$txt" && checks="$checks step-line" || { ok=0; checks="$checks MISSING:step-line"; }
      grep -qE '^ *\[step [0-9]+\] (intent (·|-)|context (·|-)|proposal (·|-)|risk [0-9]|done (·|-)|judge [0-9]|plan (·|-))' "$txt" && { ok=0; checks="$checks STAGE-LINES-VISIBLE"; } || checks="$checks compact:no-stage-lines"
      grep -qE '^ *\[run\] ready' "$txt" && { ok=0; checks="$checks RUN-READY-VISIBLE"; } || checks="$checks compact:no-run-ready";;
    # TUI-DESIGN-2 §3.1 rows 6–7, §8.2: a reply and no run; the wall time Enter → [jevcode] from the mark pair (gate 1.5 s, the live round-2 gate of §9; the mock answers at once)
    chat-hi|chat-facts|chat-ambiguous|chat-ambiguous-flat|mode-switch|mode-switch-keyed|zero-arg-chat|zero-arg-run|splash|splash-wide|wordmark-reduced|splash-settle|chrome-tiers|wordmark-idle|wordmark-idle-wide|wordmark-key-during-pass|wordmark-21|wordmark-20|wordmark-nocolor|theme-light|theme-ansi|r3-env-jev-only|ts-only-restart|commands-idle|commands-thinking|keybindings)
      grep -qE '^ *\[run\] started (·|-) ' "$txt" && { ok=0; checks="$checks RUN-STARTED"; } || checks="$checks no-run"
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
    # §9 review invariants: Enter on the armed card is inert and only `y` approves — exactly one `review approved`
    # row in transcript.log (TUI-DESIGN-4 §3.6 G5 renamed `confirm c-2 approved`), the typed `y` never an echo
    review-y) n_ok=$(grep -c 'review approved' "$home/runs/$(ls "$home/runs" 2>/dev/null | head -1)/transcript.log" 2>/dev/null); [ "$n_ok" = "1" ] && checks="$checks one-approval" || { ok=0; checks="$checks APPROVALS=$n_ok"; }
      grep -q '› y' "$txt" && { ok=0; checks="$checks Y-TYPED-AS-TEXT"; } || checks="$checks enter-inert:no-y-echo";;
    mode-switch) grep -q 'Pick the generator provider' "$txt" && { ok=0; checks="$checks STARTUP-WIZARD"; } || checks="$checks in-place-wizard";;
    mode-switch-keyed) grep -q 'jev+llm · next run' "$txt" && checks="$checks badge:next-run" || { ok=0; checks="$checks MISSING:badge"; };;
    # TUI-DESIGN-3 §3.3: a key completes the reveal — wordmark cells before AND after the echo frame; no `▓▒░` head after the echo frame; the idle frame is 11 rows
    splash|splash-wide) set -- $(wordmark "$cap"); checks="$checks wordmark_before_key=$1 after_key=$2"; [ "$1" -gt 0 ] && [ "$2" -gt 0 ] || ok=0
      h=$(wm_handoff "$cap" head-after-echo); [ "$h" = "ok" ] && checks="$checks no-head-after-echo" || { ok=0; checks="$checks $h"; }
      rows=$(wm_rows_at "$cap" 'Say hi'); [ "$rows" = "11" ] && checks="$checks idle-rows=11" || { ok=0; checks="$checks IDLE-ROWS=$rows"; }
      ff=$(expect_t "$tim" 'step 0/'); checks="$checks first_frame_t=${ff}ms";;
    # TUI-DESIGN-3 §3.2 twins: the static resting mark from frame 0, never the head, 11 rows
    wordmark-reduced) set -- $(wm_shape "$cap"); checks="$checks head_frames=$1 mark_frames=$2 frames=$4"; [ "$1" = "0" ] && [ "$2" -ge 1 ] && [ "$2" = "$4" ] || ok=0
      rows=$(wm_rows_at "$cap" 'step 0/'); [ "$rows" = "11" ] && checks="$checks rows=11" || { ok=0; checks="$checks ROWS=$rows"; };;
    # TUI-DESIGN-3 §3.4 / §3.5: no key — ≤ 15 reveal frames before the caption frame, every frame after it carries the mark, 0 frames in the 5 s after the settle
    splash-settle) set -- $(wm_shape "$cap"); checks="$checks head_frames=$1 mark_frames=$2 markless_frames=$3"; [ "$1" -ge 1 ] && [ "$1" -le 15 ] && [ "$3" = "0" ] || ok=0
      set -- $(wm_frames_between "$cap" '\xe2\x97\x86(?:\x1b\[[0-9;]*m)* (?:\x1b\[[0-9;]*m)*[0-9]+\.[0-9]+\.[0-9]+' '(?:\xe2\x80\xba|>) (?:\x1b\[[0-9;]*m)*h'); checks="$checks frames_after_settle_before_key=$1"; [ "$1" = "0" ] || ok=0
      ff=$(expect_t "$tim" 'step 0/'); st=$(expect_t "$tim" '\d+\.\d+\.\d+'); checks="$checks settle_t=$(( st - ff ))ms";;
    # TUI-DESIGN-3 §3.4 / §3.9: 12 s alone = one pass — 14–18 frames between the settle and the marker key, each ≤ 3 KB, band cells in the sweep SGR, letters unchanged, 11 rows
    wordmark-idle|wordmark-idle-wide) set -- $(wm_frames_between "$cap" '\xe2\x97\x86(?:\x1b\[[0-9;]*m)* (?:\x1b\[[0-9;]*m)*[0-9]+\.[0-9]+\.[0-9]+' '(?:\xe2\x80\xba|>) (?:\x1b\[[0-9;]*m)*h'); checks="$checks pass_frames=$1 max_bytes=$2 band_frames=$3 letters_ok=$4"
      [ "$1" -ge 14 ] && [ "$1" -le 18 ] && [ "$2" -le 3072 ] && [ "$3" -ge 14 ] && [ "$4" = "1" ] || ok=0
      rows=$(wm_rows_at "$cap" 'Say hi'); [ "$rows" = "11" ] && checks="$checks rows=11" || { ok=0; checks="$checks ROWS=$rows"; };;
    # TUI-DESIGN-3 §3.6: the key lands mid-pass — the echo within 50 ms of the send, band frames continue after it
    wordmark-key-during-pass) k=$(echo_wait "$tim"); checks="$checks echo_wait=${k}ms"; [ "$k" -ge 0 ] && [ "$k" -le 50 ] || ok=0
      set -- $(wm_frames_between "$cap" '(?:\xe2\x80\xba|>) (?:\x1b\[[0-9;]*m)*h' 'Say hi'); checks="$checks band_frames_after_echo=$3"; [ "$3" -ge 1 ] || ok=0;;
    # TUI-DESIGN-3 §3.2: hidden for the whole run, back under the strip after `end` (24 rows), gone with the panel, back with /panel off
    wordmark-handoff) h=$(wm_handoff "$cap" handoff); [ "$h" = "ok" ] && checks="$checks handoff:run-hidden,strip+mark,panel-hides,off-restores" || { ok=0; checks="$checks HANDOFF:$h"; };;
    # TUI-DESIGN-3 §3.1: the mark shows at 21 rows and the palette never hands it off; the brand row at 20 rows; the post-run return on the first key at 22 rows
    wordmark-21) set -- $(wm_shape "$cap"); [ "$2" -ge 1 ] && checks="$checks mark_frames=$2" || { ok=0; checks="$checks NO-MARK"; }
      h=$(wm_handoff "$cap" palette21); [ "$h" = "ok" ] && checks="$checks palette-keeps-mark" || { ok=0; checks="$checks $h"; };;
    # §3.2 row "16–20 rows": the reveal still runs (its frames carry the mark), then `splash:done` collapses to the brand row — so the
    # gate is "no resting mark from the brand-row frame on", measured there (6 dynamic rows), never "no mark in the whole capture"
    wordmark-20) set -- $(wm_shape "$cap"); checks="$checks head_frames=$1 reveal_mark_frames=$2"; { [ "$1" -ge 1 ] && grep -q '◆ jevcode' "$txt"; } || { ok=0; checks="$checks MISSING:reveal-or-brand-row"; }
      m=$(wm_mark_after "$cap" '\xe2\x97\x86 jevcode'); [ "$m" = "0" ] && checks="$checks no-mark-after-brand-row" || { ok=0; checks="$checks MARK-AFTER-BRAND-ROW:$m"; }
      rows=$(wm_rows_at "$cap" '\xe2\x97\x86 jevcode'); [ "$rows" = "6" ] && checks="$checks rows=6" || { ok=0; checks="$checks ROWS=$rows"; };;  # measured at the brand-row frame, after the reveal
    wordmark-22-postrun) h=$(wm_handoff "$cap" postrun22); [ "$h" = "ok" ] && checks="$checks post-run:mark-on-first-key" || { ok=0; checks="$checks POST-RUN:$h"; };;
    wordmark-nocolor) set -- $(wm_frames_between "$cap" '\xe2\x97\x86(?:\x1b\[[0-9;]*m)* (?:\x1b\[[0-9;]*m)*[0-9]+\.[0-9]+\.[0-9]+' '(?:\xe2\x80\xba|>) h'); checks="$checks idle_frames=$1"; [ "$1" = "0" ] || ok=0
      set -- $(wm_shape "$cap"); [ "$1" -ge 1 ] && checks="$checks reveal-ran" || { ok=0; checks="$checks NO-REVEAL"; }
      grep -q $'\x1b\[38;' "$cap" && { ok=0; checks="$checks SGR-COLOUR"; } || checks="$checks no-colour-sgr";;
    # TUI-DESIGN-3 §2 (D-H): the pinks by depth
    theme-pink) first_frame "$cap" > "$OUT/$name.first"
      grep -q '38;5;211' "$OUT/$name.first" && checks="$checks first-frame:211" || { ok=0; checks="$checks MISSING:211-in-first-frame"; }
      grep -q '38;5;117' "$OUT/$name.first" && { ok=0; checks="$checks CYAN-117"; } || checks="$checks no-117"
      grep -q '38;5;169' "$cap" && checks="$checks live:169" || { ok=0; checks="$checks MISSING:169"; }
      grep -q '38;5;74' "$cap" && { ok=0; checks="$checks CYAN-74"; } || checks="$checks no-74";;
    theme-light) grep -q '38;5;125' "$cap" && checks="$checks light:125" || { ok=0; checks="$checks MISSING:125"; }
      grep -q '38;5;211' "$cap" && { ok=0; checks="$checks DARK-211"; } || checks="$checks no-211";;
    theme-ansi) grep -q $'\x1b\[95m' "$cap" && checks="$checks ansi:95" || { ok=0; checks="$checks MISSING:95"; }
      grep -q '38;5;' "$cap" && { ok=0; checks="$checks 256-CELL"; } || checks="$checks no-256";;
    # TUI-DESIGN-3 §9: the hero-frame checklist over the .cap/.txt pair (the timing file gives V19 its intake wait)
    polish|polish-wide) pc=$(node "$ROOT/scripts/pty/polish-check.mjs" "$cap" --txt "$txt" --timing "$tim" --rows "$rows" --cols "$cols" 2>&1); pcc=$?
      printf '%s\n' "$pc" > "$OUT/$name.polish.txt"
      [ "$pcc" = "0" ] && checks="$checks polish-check:pass($(printf '%s\n' "$pc" | grep -c ' pass '))" || { ok=0; checks="$checks POLISH-CHECK:$(printf '%s\n' "$pc" | grep ' FAIL ' | cut -c1-4 | tr '\n' ',')"; };;
    # TUI-DESIGN-3 §4 (D-K): the alias run, the ghost arrow, the App-local /p toggle, the kept draft; the live availability error clears the draft
    commands-idle) grep -q '→ /status' "$txt" && checks="$checks ghost-arrow" || { ok=0; checks="$checks MISSING:ghost-arrow"; }
      grep -q '\[ui\] status' "$txt" && checks="$checks alias-ran" || { ok=0; checks="$checks MISSING:status-block"; }
      grep -q '▾ decisions' "$txt" && checks="$checks /p-d-opened" || { ok=0; checks="$checks MISSING:panel"; };;
    commands-live) grep -q '/undo/pause' "$txt" && { ok=0; checks="$checks DRAFT-KEPT"; } || checks="$checks draft-cleared";;
    commands-thinking) grep -q '\[ui\] status' "$txt" && grep -q '\[jevcode\] Hi\.' "$txt" && checks="$checks status-while-thinking+reply" || { ok=0; checks="$checks MISSING:status-or-reply"; };;
    trust-esc) grep -q 'trust unchanged' "$txt" && checks="$checks trust-unchanged" || { ok=0; checks="$checks MISSING:trust-unchanged"; };;
    keybindings) grep -q '› ?' "$txt" && checks="$checks ?-inserted" || { ok=0; checks="$checks MISSING:?-as-text"; }
      grep -q 'Tab picks' "$txt" && { ok=0; checks="$checks HELP-OPENED"; } || checks="$checks no-help";;
    # TUI-DESIGN-3 §3.2: no wordmark at 12×60 (the flat frame carries no `██` row), the mark back at 24×80
    # the flat tier's anchor is its SHAPE (a status row at column 0), not the badge prefix: TUI-DESIGN-2 §1.5
    # drops that prefix first when short, and the `llm-jev` default badge (18 cells) cannot fit 60 columns
    chrome-tiers) grep -q "╭─ $BADGE" "$txt" && grep -qE '^idle {2,}step 0/' "$txt" && checks="$checks boxed+flat" || { ok=0; checks="$checks MISSING:tier-rows"; }
      flat_rows=$(wm_rows_at "$cap" "\r\nidle {2,}step 0/"); [ "$flat_rows" -ge 1 ] && [ "$flat_rows" -le 10 ] && checks="$checks flat-rows=$flat_rows" || { ok=0; checks="$checks FLAT-ROWS=$flat_rows"; }
      w=$(wm_handoff "$cap" flat-no-mark); [ "$w" = "ok" ] && checks="$checks no-mark-in-flat" || { ok=0; checks="$checks $w"; }
      m=$(wm_mark_after "$cap" "(?:\xe2\x80\xba|>) (?:\x1b\[[0-9;]*m)*Z"); [ "$m" = "1" ] && checks="$checks mark-back-at-24x80" || { ok=0; checks="$checks MARK-NOT-BACK"; };;
    zero-arg-chat|zero-arg-run) grep -q "╭─ $BADGE" "$txt" && checks="$checks badge:default($BADGE)" || { ok=0; checks="$checks MISSING:badge"; }
      grep -q 'OpenRouter API key\|Where do you reach Jev\|Pick the generator provider' "$txt" && { ok=0; checks="$checks WIZARD"; } || checks="$checks no-wizard";;
    # TUI-DESIGN-3 §1.4 / §1.6: the one-key field under `setup · key` beneath the mark, never the round-2 provider questions; Ctrl-C → the jev-on fix block
    zero-arg-wizard|r3-options-ctrlc) grep -q 'OpenRouter API key' "$txt" && checks="$checks wizard:one-key" || { ok=0; checks="$checks MISSING:one-key-field"; }
      grep -q '╭─ setup · key' "$txt" && checks="$checks title:setup-key" || { ok=0; checks="$checks MISSING:setup-key-title"; }
      grep -q 'Where do you reach Jev\|Pick the generator provider' "$txt" && { ok=0; checks="$checks ROUND-2-STEP"; } || checks="$checks no-round-2-step"
      grep -q 'export OPENROUTER_API_KEY=' "$txt" && checks="$checks fix-block:openrouter" || { ok=0; checks="$checks MISSING:fix-block"; }
      set -- $(wm_shape "$cap"); [ "$2" -ge 1 ] && checks="$checks mark-under-wizard" || { ok=0; checks="$checks MISSING:mark"; }
      if [ "$name" = "r3-options-ctrlc" ]; then grep -q 'Other ways to start' "$txt" && grep -q '╭─ setup · options' "$txt" && checks="$checks options-step" || { ok=0; checks="$checks MISSING:options"; }; fi;;
    r3-key-paste-newline) cfg="$home/xdg/jevcode/config.json"; [ -f "$cfg" ] && checks="$checks config-written" || { ok=0; checks="$checks MISSING:config"; }
      if [ -f "$cfg" ]; then grep -q '"apiKey": *"sk-or-v1-fakefakefakefakefakefakefakefakefake"' "$cfg" && grep -q '"jevApiKey"' "$cfg" && grep -q '"jevProvider": *"openrouter"' "$cfg" && checks="$checks four-keys:clean" || { ok=0; checks="$checks KEY-NOT-CLEAN-OR-INCOMPLETE"; }
        [ "$(stat -f '%Lp' "$cfg")" = "600" ] && checks="$checks mode:0600" || { ok=0; checks="$checks MODE:$(stat -f '%Lp' "$cfg")"; }; fi
      grep -q '\[setup\] spend caps' "$txt" && checks="$checks caps-item" || { ok=0; checks="$checks MISSING:caps-item"; }
      grep -q 'fakefakefake' "$txt" && { ok=0; checks="$checks KEY-IN-FRAME"; } || checks="$checks no-key-bytes";;
    r3-wizard-resize) grep -q 'OpenRouter API key' "$txt" && checks="$checks wizard" || ok=0;;
    r3-wizard-masked-key) grep -q 'zzzzzzzz' "$cap" && { ok=0; checks="$checks KEY-IN-FRAME"; } || checks="$checks no-key-bytes"
      grep -rq 'zzzzzzzz' "$home" 2>/dev/null && { ok=0; checks="$checks KEY-IN-FILE"; } || checks="$checks no-key-file"
      grep -q '│ › •' "$txt" && checks="$checks masked-row" || { ok=0; checks="$checks MISSING:masked-row"; };;
    r3-wizard-sr) grep -q 'API key field, 0 characters entered, hidden' "$txt" && grep -q 'Enter selection (1-4)' "$txt" && checks="$checks sr-rows" || { ok=0; checks="$checks MISSING:sr-rows"; };;
    r3-plain-wizard) grep -q 'other ways: \[t\] TypeSafe Jev' "$txt" && grep -q 'export OPENROUTER_API_KEY=' "$txt" && checks="$checks plain-wizard+fix" || { ok=0; checks="$checks MISSING:plain-rows"; };;
    ts-only-start) grep -q 'TypeSafe key found' "$txt" && checks="$checks found-title" || { ok=0; checks="$checks MISSING:found-title"; }
      grep -q 'mode jev-only saved to' "$txt" && checks="$checks mode-saved" || { ok=0; checks="$checks MISSING:mode-saved"; }
      grep -q '"mode": *"jev-only"' "$home/xdg/jevcode/config.json" 2>/dev/null && checks="$checks file:mode-row" || { ok=0; checks="$checks MISSING:file-mode-row"; }
      grep -q '"apiKey"\|"jevApiKey"' "$home/xdg/jevcode/config.json" 2>/dev/null && { ok=0; checks="$checks KEY-SAVED"; } || checks="$checks no-key-saved";;
    ts-only-restart) grep -q 'OpenRouter API key\|Other ways to start' "$txt" && { ok=0; checks="$checks WIZARD-REOPENED"; } || checks="$checks no-wizard"
      grep -q '╭─ jev-only' "$txt" && checks="$checks badge:jev-only" || { ok=0; checks="$checks MISSING:badge"; };;
    r3-env-jev-only) grep -q '╭─ jev-only' "$txt" && checks="$checks badge:jev-only" || { ok=0; checks="$checks MISSING:badge"; }
      grep -q 'OpenRouter API key\|Where do you reach Jev' "$txt" && { ok=0; checks="$checks WIZARD"; } || checks="$checks no-wizard";;
    panel) grep -q '▾ decisions' "$txt" && grep -q 'more rows' "$txt" && checks="$checks panel:open+more-row" || { ok=0; checks="$checks MISSING:panel-rows"; };;
    # --- TUI-DESIGN-4 §7 / §10 (S6): the hardening gates
    # §7.1: a builder throwing on EVERY render degrades EXACTLY ONCE. More than one row means the latch is not holding.
    # the notice is `ui: <pane> failed (<Error.name>)` (§7.12); the App-level `[ui]` item still carries round 3's
    # `ui: <pane> pane failed to render (…)` until §9.2's App.tsx row lands, so the anchor accepts both spellings
    fault-persistent|fault-persistent-flat) n=$(grep -cE 'ui: [a-z]+ (pane failed to render|failed) \(' "$txt"); [ "$n" = "1" ] && checks="$checks latch:one-notice" || { ok=0; checks="$checks LATCH:$n-notices"; }
      f=$(frames_in "$cap"); checks="$checks frames=$f"; [ "$f" -le 400 ] || { ok=0; checks="$checks FRAME-FLOOD"; };;
    # §7.3 item 2 / §1.2 P-H3: the wordmark's fallback is BLANK rows of the same height, never a notice row
    fault-wordmark|fault-wordmark-flat) grep -qE 'ui: wordmark (pane failed to render|failed) \(' "$txt" && checks="$checks wordmark:boundary-caught" || { ok=0; checks="$checks MISSING:wordmark-boundary"; }
      grep -q '\[jevcode\]' "$txt" && checks="$checks reply-still-arrived" || { ok=0; checks="$checks REPLY-LOST"; };;
    # §7.3 item 4: ONE ROW degrades, not the box — the four border characters survive the throw
    fault-status) grep -qE 'ui: status (pane failed to render|failed) \(' "$txt" && checks="$checks status:boundary-caught" || { ok=0; checks="$checks MISSING:status-boundary"; }
      grep -q '╭─' "$txt" && grep -q '╰' "$txt" && checks="$checks console:box-intact" || { ok=0; checks="$checks BOX-GONE"; };;
    # §7.3 item 4 at the FLAT tier: 12×60 draws no box, so the gate is that the row degrades and the composer
    # still answers — the box check above would be vacuous here (§2.4: `boxed` needs rows ≥ 16 and cols ≥ 40)
    fault-status-flat) grep -qE 'ui: status (pane failed to render|failed) \(' "$txt" && checks="$checks status:boundary-caught" || { ok=0; checks="$checks MISSING:status-boundary"; }
      grep -q '╭─' "$txt" && { ok=0; checks="$checks BOX-IN-FLAT-TIER"; } || checks="$checks flat:no-box";;
    # §7.3 items 1/2/5 / §10 S6: the boundary catches, the frame stays usable, and the session still exits 0
    fault-live|fault-pane|fault-overlay|fault-composer|fault-static|fault-transcript) \
      grep -qE 'ui: [a-z]+ (pane failed to render|failed) \(' "$txt" && checks="$checks boundary:caught" || { ok=0; checks="$checks MISSING:boundary-notice"; };;
    # §2.5 / §11: the narrow ladder — every row fits, and the `no frame taller than the terminal` row above is
    # the gate that matters here (the draft is longer than the terminal is wide)
    narrow) grep -q 'Say hi' "$txt" && checks="$checks narrow:placeholder" || { ok=0; checks="$checks MISSING:placeholder"; };;
    # §7.2: loud degradation, an epilogue that does not lie, exit 3
    rundir-vanishes) grep -q 'checkpoint degraded' "$txt" && checks="$checks degraded:item" || { ok=0; checks="$checks MISSING:degraded-item"; }
      grep -q 'not resumable' "$txt" && checks="$checks epilogue:not-resumable" || { ok=0; checks="$checks MISSING:not-resumable"; }
      grep -q 'jevcode run --resume' "$txt" && { ok=0; checks="$checks RESUME-ADVERTISED"; } || checks="$checks no-resume-row";;
    # §7.8: the watchdog fires on the MONOTONIC clock, Esc cancels, and a second Ctrl-C always ends the process
    stuck-submit) grep -q 'has not answered in' "$txt" && checks="$checks watchdog:line" || { ok=0; checks="$checks MISSING:watchdog-line"; };;
    # §7.4: the sentence AND its fix reach the terminal with the epilogue, and the code is 2.
    # `$OUT/<name>.stdout` holds expect's own diagnostics, NOT the child's output — `drive.exp` sets `log_user 0`
    # and routes the child through `log_file -a $capture`, so the capture (`$txt`) is the only place it lands.
    readonly-home) grep -q 'cannot create the runs directory' "$txt" && checks="$checks explain:line" || { ok=0; checks="$checks MISSING:explain-line"; }
      grep -q 'set JEVCODE_HOME to a writable directory' "$txt" && checks="$checks explain:fix" || { ok=0; checks="$checks MISSING:explain-fix"; }
      # …and the half a pty cannot see: "it reached **stderr**, not stdout" is the whole point of §7.4, and the
      # harness merges both into one file. A second, non-pty leg with separate redirects is what proves it.
      s=$(readonly_home_nopty); [ "$s" = "ok" ] && checks="$checks stderr-only:exit2" || { ok=0; checks="$checks NO-PTY:$s"; };;
    # §7.10: counts only — a pid or a path in the frame is a leak
    peers) grep -q 'another jevcode is working in this workspace' "$txt" && checks="$checks peers:open-item" || { ok=0; checks="$checks MISSING:peers-item"; }
      grep -qE 'pid [0-9]+' "$txt" && { ok=0; checks="$checks PID-LEAK"; } || checks="$checks no-pid";;
    ui-reset) grep -q 'nothing was latched' "$txt" && checks="$checks ui-reset:empty-state" || { ok=0; checks="$checks MISSING:ui-reset"; };;
    # --- TUI-DESIGN-5 §10 / gate G-R5-9: each scenario's own check, then the key-byte scan every one of them runs
    r5-who|r5-who-ascii) grep -q 'who [·-] ' "$txt" && checks="$checks r5-who:block" || { ok=0; checks="$checks MISSING:r5-who-block"; }
      # §2.14 consequence 3: `assertNoKeyBytes` over the BEAT FILE this session wrote, not only over the frames
      if [ -d "$home/coordination" ]; then
        grep -rqI "$FAKE_KEY" "$home/coordination" && { ok=0; checks="$checks LEAK:beat-key-bytes"; } || checks="$checks beat-no-key-bytes"
        grep -rqIE '"hostKey"[^,}]*[0-9a-f]{32}' "$home/coordination" && { ok=0; checks="$checks LEAK:beat-hostkey"; } || checks="$checks beat-no-long-hostkey"
      else checks="$checks beat-absent"; fi;;
    r5-message) grep -q 'looks like it contains a key' "$txt" && checks="$checks r5-message:s34a" || { ok=0; checks="$checks MISSING:r5-message-s34a"; };;
    # round-5 finishing wave: the scenario runs under the SHIPPED DEFAULT (no --mode), and R13 put `llm-jev`
    # inside `contextEnabled`, so BOTH the block and the §3.1 `ctx` status cell must appear for an ordinary user
    r5-context) grep -q 'context [·-] ' "$txt" && checks="$checks r5-context:block" || { ok=0; checks="$checks MISSING:r5-context-block"; }
      grep -qE 'ctx [0-9]+%' "$txt" && checks="$checks r5-context:ctx-cell" || { ok=0; checks="$checks MISSING:r5-context-ctx-cell"; }
      grep -q 'ctx —%' "$txt" && { ok=0; checks="$checks r5-context:PLACEHOLDER"; } || checks="$checks r5-context:no-placeholder";;
    # round-5 finishing wave: `jevcode doctor` with NO key — every provider row is a warn that NAMES the
    # variable to export, and the board's own key-byte scan below is the point of the row
    doctor) grep -q 'export OPENROUTER_API_KEY' "$txt" && checks="$checks doctor:names-var" || { ok=0; checks="$checks MISSING:doctor-names-var"; }
      grep -qE '^(pass|warn|fail)  node' "$txt" && checks="$checks doctor:node-row" || { ok=0; checks="$checks MISSING:doctor-node-row"; }
      grep -q 'checks:' "$txt" && checks="$checks doctor:summary" || { ok=0; checks="$checks MISSING:doctor-summary"; };;
    r5-pause-end) grep -q 'needs a live run' "$txt" && checks="$checks r5-pause-end:s45a" || { ok=0; checks="$checks MISSING:r5-pause-end-s45a"; };;
    r5-model-picker) grep -qE 'models [·-] [0-9]+ of [0-9]+ providers' "$txt" && checks="$checks r5-model-picker:rule" || { ok=0; checks="$checks MISSING:r5-model-picker-rule"; };;
    r5-model-picker-ascii) grep -qE '[·→▌↑↓─]' "$txt" && { ok=0; checks="$checks ASCII-GLYPH-LEAK"; } || checks="$checks r5-model-picker:ascii";;
    # §5.2 / §5.8: a POSITIVE probe. `$home/.claude/CLAUDE.md` is seeded above precisely so the overlay has rows,
    # so `nothing to import` is no longer an acceptable outcome here — accepting it made the resize matrix and the
    # `clears<=1` gate pass vacuously on a run where the overlay never mounted. The keys row is the anchor
    # (`importRendered`'s `protectTail: 1` keeps it at every width) and a group row proves the body is there.
    r5-import-overlay)
      grep -qE '\[y\] import all [0-9]+|y all [0-9]+' "$txt" && checks="$checks r5-import-overlay:keys" || { ok=0; checks="$checks MISSING:r5-import-keys"; }
      grep -qE '(memory|rules|commands|mcp|config|review) +[0-9]+' "$txt" && checks="$checks r5-import-overlay:rows" || { ok=0; checks="$checks MISSING:r5-import-rows"; }
      grep -qE 'Import [-·—]' "$txt" && checks="$checks r5-import-overlay:head" || { ok=0; checks="$checks MISSING:r5-import-head"; };;
    r5-import-overlay-ascii)
      grep -qE '[·→▌↑↓─]' "$txt" && { ok=0; checks="$checks ASCII-GLYPH-LEAK"; } || checks="$checks r5-import-overlay:ascii"
      grep -qE '\[y\] import all [0-9]+|y all [0-9]+' "$txt" && checks="$checks r5-import-overlay-ascii:keys" || { ok=0; checks="$checks MISSING:r5-import-ascii-keys"; };;
  esac
  # TUI-DESIGN-5 gate G-R5-9: EVERY round-5 scenario scans its capture for key bytes — the frames as well as the
  # files. `$FAKE_KEY` is only exported for two of them; the scan is unconditional so a leak from any source fails.
  case "$name" in
    r5-*) grep -qI "$FAKE_KEY" "$cap" && { ok=0; checks="$checks LEAK:key-bytes"; } || checks="$checks no-key-bytes";;
  esac
  [ "$ok" = "1" ] && verdict=PASS || { verdict=FAIL; fail=1; }
  echo "$name: $verdict exit=$code (expected $expected) clears_after_first_frame=$c restores=$r timeouts=$t$checks"
  # TUI-DESIGN-4 §7.4: `readonly-home` sets the home 0500 on purpose; `rm -rf` cannot unlink inside a directory
  # with no owner write bit, so without this the tree (and its `xdg` child) leaks on EVERY invocation.
  case "$name" in readonly-home) chmod -R u+rwx "$home" 2>/dev/null || true;; esac
  # ts-only-start keeps its HOME for ts-only-restart
  [ "$name" = "ts-only-start" ] || rm -rf "$home"
  rm -rf "$ws"
}
want="$*"
sel() { [ -z "$want" ] || echo " $want " | grep -q " $1 "; }
# TUI-DESIGN-4 §7 / §9.2: the fault scenarios exercise wiring that lands in `src/tui/App.tsx` (S1's file: the
# `guard()` latch, the boundary catalogue, `abortRun` + the watchdog) and in `src/loop/engine.ts` (the
# `checkpoint:degraded` emit). Until those rows land they run BY NAME only, so the default smoke board is not
# red for the other five slots:  test/pty/run-smoke.sh fault-persistent rundir-vanishes …
sel_named() { [ -n "$want" ] && echo " $want " | grep -q " $1 "; }
MOCK_RUN="--mode jev-on --mock"
sel hermetic && hermetic_check
sel firstframe && run firstframe 0 24 80 chat --mock --perf-exit-after-first-frame
sel chat-task && run chat-task 0 24 80 chat $MOCK_RUN --mock-steps 4
sel chat-hi && run chat-hi 0 24 80 chat --mock
sel chat-facts && run chat-facts 0 24 80 chat --mock
sel chat-ambiguous && run chat-ambiguous 0 24 80 chat --mock
sel chat-ambiguous-y && run chat-ambiguous-y 0 24 80 chat $MOCK_RUN --mock-steps 3
sel chat-ambiguous-flat && run chat-ambiguous-flat 0 12 60 chat --mock
# TUI-DESIGN-3 §1.10: jev+llm is the default, so the switch scenarios start in jev-only explicitly
sel mode-switch && run mode-switch 0 24 80 chat --mode jev-only
sel mode-switch-keyed && run mode-switch-keyed 0 24 80 chat --mode jev-only
sel splash && run splash 0 24 80 chat --mock
sel splash-wide && run splash-wide 0 40 120 chat --mock
sel wordmark-reduced && run wordmark-reduced 0 24 80 chat --mock --no-animation
sel splash-settle && run splash-settle 0 24 80 chat --mock
# round 3 (TUI-DESIGN-3 §3): the persistent wordmark and its idle sweep
sel wordmark-idle && run wordmark-idle 0 24 80 chat --mock
sel wordmark-idle-wide && run wordmark-idle-wide 0 40 120 chat --mock
sel wordmark-key-during-pass && run wordmark-key-during-pass 0 24 80 chat --mock
sel wordmark-handoff && run wordmark-handoff 0 24 80 chat $MOCK_RUN --mock-steps 3
sel wordmark-21 && run wordmark-21 0 21 80 chat --mock
sel wordmark-20 && run wordmark-20 0 20 80 chat --mock
sel wordmark-22-postrun && run wordmark-22-postrun 0 22 80 chat $MOCK_RUN --mock-steps 3
sel wordmark-nocolor && run wordmark-nocolor 0 24 80 chat --mock --no-color
# round 3 (TUI-DESIGN-3 §2): the TypeSafe pink theme by depth
sel theme-pink && run theme-pink 0 24 80 chat $MOCK_RUN --mock-steps 3
sel theme-light && run theme-light 0 24 80 chat --mock --theme light
sel theme-ansi && run theme-ansi 0 24 80 chat --mock --theme ansi
# round 3 (TUI-DESIGN-3 §9): the hero-frame checklist
sel polish && run polish 0 24 80 chat $MOCK_RUN --mock-steps 4
sel polish-wide && run polish-wide 0 40 120 chat $MOCK_RUN --mock-steps 4
# round 3 (TUI-DESIGN-3 §1): the one-key wizard and the mode edges
sel r3-options-ctrlc && run r3-options-ctrlc 2 24 80
sel r3-key-paste-newline && run r3-key-paste-newline 0 24 80
sel r3-wizard-resize && run r3-wizard-resize 2 24 80
sel r3-wizard-masked-key && run r3-wizard-masked-key 2 24 80
sel r3-wizard-sr && run r3-wizard-sr 2 24 80 --screen-reader
sel r3-plain-wizard && run r3-plain-wizard 2 24 80 chat --plain
sel ts-only-start && run ts-only-start 0 24 80
sel ts-only-restart && run ts-only-restart 0 24 80
sel r3-env-jev-only && run r3-env-jev-only 0 24 80 chat
# round 3 (TUI-DESIGN-3 §4): commands, trust, keybindings
sel commands-idle && run commands-idle 0 24 80 chat $MOCK_RUN --mock-steps 3
sel commands-live && run commands-live 0 24 80 chat $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
sel commands-thinking && run commands-thinking 0 24 80 chat --mock
sel trust-esc && run trust-esc 0 24 80 chat --mock
sel keybindings && run keybindings 0 24 80 chat --mock
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
# round 4 (TUI-DESIGN-4 §7, D-AA): hardening and the typed fault injector — by name until S1's App.tsx rows land
sel_named fault-persistent && run fault-persistent 0 24 80 chat --mock
sel_named fault-wordmark && run fault-wordmark 0 24 80 chat --mock
sel_named fault-status && run fault-status 0 24 80 chat --mock
# …and the same three at the flat tier (12×60), where a fallback's height is hardest to get right
sel_named fault-persistent-flat && run fault-persistent-flat 0 12 60 chat --mock
sel_named fault-wordmark-flat && run fault-wordmark-flat 0 12 60 chat --mock
sel_named fault-status-flat && run fault-status-flat 0 12 60 chat --mock
# the five remaining boundaries of §7.3's catalogue that this tree mounts, each at both tiers
# MEASURED 2026-09-22: `render:live` still does not fire at 24x80, with or without the panel open — the shipped
# `--mock` trajectory produces no STREAMING text, so `layout.live` stays 0 and the boundary never renders. §7.3
# item 6's other half needs a streaming mock (`src/cli/mock-trajectory.ts`, S5's file): §9.2 request row.
sel_named fault-live && run fault-live 0 24 80 chat $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
sel_named fault-pane && run fault-pane 0 24 80 chat $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
sel_named fault-overlay && run fault-overlay 0 24 80 chat $MOCK_RUN --mock-steps 200 --max-steps 200 --max-replans 50
sel_named fault-composer && run fault-composer 0 24 80 chat --mock
sel_named fault-static && run fault-static 0 24 80 chat --mock
sel_named fault-transcript && run fault-transcript 0 24 80 chat --mock
sel_named narrow && run narrow 0 12 40 chat --mock
sel_named rundir-vanishes && run rundir-vanishes 3 24 80 chat $MOCK_RUN --mock-steps 40 --max-steps 40
sel_named stuck-submit && run stuck-submit 130 24 80 chat --mock
sel_named readonly-home && run readonly-home 2 24 80 chat --mock
sel_named peers && run peers 0 24 80 chat --mock
sel_named ui-reset && run ui-reset 0 24 80 chat --mock
# --- TUI-DESIGN-5 §10: round 5's five surfaces, one scenario each plus the two `--ascii` twins. BY NAME only ----
# Several of them assert rows that need a store this build does not have (the mailbox write, `AgentSupervisor`,
# the models arm of `Picker.tsx`) — each .steps header says exactly which, so the default board stays green and
# the scenario is in hand the day the dependency lands: `sh test/pty/run-smoke.sh r5-who r5-context …`
sel_named r5-who && run r5-who 0 24 80 chat --mock
sel_named r5-who-ascii && run r5-who-ascii 0 24 80 chat --mock --ascii
sel_named r5-message && run r5-message 0 24 80 chat --mock --mode jev-on
sel_named r5-context && run r5-context 0 40 120 chat --mock
sel_named r5-pause-end && run r5-pause-end 0 24 80 chat --mock --mode jev-on
sel_named r5-model-picker && run r5-model-picker 0 40 120 chat --mock
sel_named r5-model-picker-ascii && run r5-model-picker-ascii 0 40 120 chat --mock --ascii
sel_named r5-import-overlay && run r5-import-overlay 0 24 80 chat --mock
sel_named r5-import-overlay-ascii && run r5-import-overlay-ascii 0 24 80 chat --mock --ascii
sel_named doctor && run doctor 0 24 80 doctor
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
