# 20 — Findings from the generic pty driver (measured 2026-09-20, macOS 26, Node 22.23.2, Ink 7.1.1)

`scripts/pty/drive.exp` (committed 946f8a1) drives any command in a real pseudo-TTY with a step
file (`expect | send | sleep | resize | mark | eof`), records a timing JSONL and propagates the
child's exit code (signal deaths as 128+n). Probing today's TUI with it surfaced three facts the
implementation and the test plan must account for.

## 1. A shrink resize costs exactly one `ESC[2J`; a grow costs none

Steps: `expect step 0/ · sleep 0.6 · resize 12 60 · sleep 0.8 · send \x03 · eof` against
`jevcode run "probe task" --mock --mock-steps 40` at 24×80.

| resize | `ESC[2J` after the first frame | rule widths seen |
| --- | --- | --- |
| none | 0 | 80 |
| 24×80 → 12×60 (shrink) | 1 (2 in one run under load) | 80 then 59/60 |
| 24×80 → 40×120 (grow) | 0 | 80 |

Mechanism: the frame drawn for the old geometry (up to 22 dynamic rows) is taller than the new
terminal (12 rows), so Ink's log-update cannot erase it line by line and falls back to
`clearTerminal` once (research 07 §3.2, 08 §1.1). The App already recomputes the budget from the
new `rows`, so the *next* frame is inside the budget again. Consequence: the zero-clears gate
must be asserted per geometry segment (between resizes), and a resize test should expect at most
one clear per shrink and zero per grow. The count of 2 in one run happened at load average 53
and was not reproduced when the machine was quieter.

## 2. Ctrl-C before raw mode is a default SIGINT death with no epilogue

Under a load average above 50 (the reference machine while ~20 agents ran), `\x03` sent 1.4 s after the
first frame sometimes arrived while the pty was still in cooked mode (the byte was echoed as
`^C`). The kernel delivered SIGINT, Node's default handler killed the process (expect's `wait`
reports `CHILDKILLED SIGINT` with exit status 0), the cursor was restored by Ink's exit hook but
nothing else was printed. Cause: `src/cli/main.tsx` installs `process.on('SIGINT'|'SIGTERM')` only
after `createEngine()` resolves; between the first frame and that point a signal is unhandled.
Fix for the implementation: install the SIGINT/SIGTERM handlers before the first frame (they
call the same `onAbort` and, with no engine yet, unmount the renderer and exit 130 with the
epilogue). Not reproduced when the machine was quiet, so it is a robustness item, not a bug in
normal use.

## 3. `step 0/` is not a unique first-frame sentinel

The header row `[run] jevcode task: … | step 0/– starting` (a `<Static>` item) contains the same
text as the status row `step 0/–  ⠋ starting`, so `expect step 0/` matches the header, which
is written in the same frame but before the dynamic region. Tests that must wait for the dynamic
frame should expect Ink's cursor-hide `\x1b[?25l` (emitted at the start of the first dynamic
frame) or a status-row pattern anchored after a newline. `perf/first-frame.ts` is unaffected: the
header and the status row are flushed in one write, so its timing is the same.

## 4. Driver usage notes

- expect needs no controlling tty: with the driver's own stdin/stdout/stderr all redirected to
  files or pipes, the spawned child still sees `isTTY` true on all three fds with the requested
  geometry (verified with a Node probe). A test runner can spawn it with `stdio: 'ignore'`.
- `send x` to a shell `read` never completes without `\r`; step files must send the carriage
  return explicitly (`send x\r`), as a terminal would.
- Signal deaths: `sh -c 'kill -TERM $$'` → driver exit 143; `exit 7` → 7; an `expect` step that
  never matches → Ctrl-C twice, then exit 124 with `{"op":"timeout"}` in the timing file.

## 5. A non-draining pause in the driver starves the child's React effects (found 2026-09-21, live attempts 1–3)

Symptom: with `PTY_AUTO_REVIEW=y` the first `y` sent one second after the review box appeared never approved
(attempt 2: it ended up as composer text; attempt 3, after the resolver guard: it drew the `review pending` toast);
a second `y` twenty seconds later approved at once. `JEVCODE_TRACE` on a live probe showed the order inside the
TUI: the key was resolved against `overlay=review overlayArmed=false`, and only *then* did React run the passive
effect that arms the box — 0.7 s after the frame that drew it.

Cause: the auto-review action paused with Tcl `sleep 1`, which stops reading the pty master. Node writes to a TTY
**synchronously**, so Ink's next frame (the 1 Hz tick) blocked the child's whole event loop on the full pty buffer
(macOS ptys hold about 1 KB) until the driver read again; React's scheduled passive effects could not run, the `y`
byte queued in stdin, and when the loop resumed the input callback ran before the starved effect. A real terminal
always reads, so this cannot happen there; it can happen with any stopped reader (a frozen tmux pane, a paused
`script(1)`), which is inherent to Node's TTY writes and not something the TUI can avoid.

Fix in the driver: the pause is `drainSleep` (25 ms reads), the same helper the `sleep` step uses. Two TUI changes
were kept anyway: the box arms on a 150 ms timer after its commit (the stdout-flush promise is only an accelerator),
and once the box is drawn, printable keys and pastes are ignored with the pending toast instead of reaching the
composer.
