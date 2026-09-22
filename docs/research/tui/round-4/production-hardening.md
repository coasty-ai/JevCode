# Round 4 · Topic A7 — "heavy production grade and robust"

**Crash, degradation and fault-injection audit of the shipped TUI.**
Measured 2026-09-21 on macOS 26 (Darwin 25.6.0), Node v22.23.2, Ink 7.1.1, React 19.3.0, from a clean worktree of
`ec61170` at `/tmp/jevcode-r4-hardening` (built `dist/jevcode.mjs` 2 241 384 B minified, build smoke first frame 25 ms).
Every pty probe ran `scripts/pty/drive.exp` with a fresh `JEVCODE_HOME`, a fresh copy of `examples/demo-py` as the
workspace, every key variable unset, and `OPEN_ASSIST_PATH` at a directory that does not exist — the `test/pty/run-smoke.sh`
hermetic recipe. Captures live under `/tmp/jr4h/out/*.cap` (referenced below as `<name>.cap`); the worktree is removed
after this report, the captures are not part of the tree.

No file in `/Users/prateekjannu/Documents/vscode/JevCode` was modified. No build, perf or pty suite was run in the main checkout.

---

## 0. Method and what was probed

| Probe class | How | Scenarios |
| --- | --- | --- |
| render faults | `JEVCODE_FAULT=render:<pane>` and `render:<pane>:lines` × 8 panes × 3 geometries × {idle, live, review} | 21 pty runs |
| signals | driver `signal <NAME>` step (a real `kill`, not a key) at 3 phases | SIGTERM early / mid-run, SIGHUP mid-run |
| geometry | `resize` steps 24×80 → 1×20 → 2×8 → 3×200 → 60×400 → 24×80 with a live draft | `tiny2.cap` |
| stuck submission | `JEVCODE_MOCK_JEV_MS=8000`, Enter, then Ctrl-C ×3 and `/exit` | `wedge.cap` |
| filesystem | corrupt / wrong-typed / unreadable config, corrupt + 51 MB `index.jsonl`, read-only `$HOME`, runs dir deleted and chmod'ed **mid-run**, workspace deleted before and mid-run | 12 CLI runs |
| process | EPIPE on stdout (`\| head -2`), two concurrent instances in one workspace, git absent from `PATH`, `LANG=C`/`TZ=Pacific/Kiritimati`, `NO_COLOR`+`TERM=dumb`+`--ascii`, Node guard | 8 runs |
| report bundle | `jevcode report <id>` on a real run and on a bad id | 2 runs |
| memory | RSS sampling of the node child across three 400-step mock runs in one session | `rss2.log` |

---

## 1. What the crash path is today (read, with file:line)

The architecture is already strong. The parts that exist and work:

| Mechanism | Where | State |
| --- | --- | --- |
| `fatalExit` — exit code → **synchronous restore** → `engine.abort('error')` → bounded unmount → redacted epilogue → `process.exit` | `src/cli/fatal.ts:121-169` | correct, every step individually guarded (`:128`, `:135`, `:141`, `:147`, `:153`) |
| idempotence of the fatal path (a second fault returns the first promise) | `src/cli/fatal.ts:161-166` | correct |
| `uncaughtException` + `unhandledRejection` → `fatalExit` | `src/cli/fatal.ts:272-273`, installed at entry `src/cli/main.tsx:508` | correct |
| stdio `'error'` (EIO/EPIPE) listeners installed **before** SIGHUP | `src/cli/fatal.ts:268-276` | correct |
| SIGHUP / stdin `'end'` gated on `stdin.isTTY && stdin.isRaw` → `abort('signal', {SIGHUP})`, exit 129 | `src/cli/fatal.ts:235-250`, `:390` | correct |
| one process-wide `restoreTerminal()` shared by the mount, `unmount()`, `fatalExit`, `'exit'` and SIGTSTP | `src/tui/terminal.ts:88-114`, wired at `src/cli/main.tsx:150` | correct — **measured: exactly 1 `RESTORE` per exit in all 33 pty runs** |
| SIGINT/SIGTERM installed **before** the first frame | `src/cli/main.tsx:196-205` | correct (research 20 item 2 is fixed) |
| `PaneBoundary` per pane, Ink's `InternalErrorBoundary` never fires | `src/tui/PaneBoundary.tsx:84-124` | correct where mounted — see §3.1 |
| `guard()` for the pure line builders that run outside every boundary | `src/tui/App.tsx:1962-1982` | see defect **A7-1** |
| log: 5 levels, escape+control stripping **before** redaction, 512-char clip, 8 MiB rotation, unwritable→`~/.jevcode/logs` fallback with 10-file prune, all failures swallowed | `src/core/log.ts:166-173`, `:286-306`, `:250-271`, `:182-211` | correct |
| `console.*` routed into the log while Ink owns the terminal | `src/core/log.ts:389-404` | correct |
| toast queue capped at 4, text clipped to 400 | `src/tui/toasts.ts:25,31` | correct |
| paste: 1 MiB hard cap, bodies only in the store, never in state/events/logs/history | `src/tui/composer/paste.ts:7,37` | correct |
| `<Static>` soft cap 20 000 items → keyed remount | `src/tui/useEngine.tsx:53`, `:524` | correct |
| `decisionsByStep` bounded to 3 steps | `src/tui/useEngine.tsx:533-539` | correct |
| suspension queue bounded at 10 000 | `src/tui/terminal.ts:24`, `:185` | correct |
| Node ≥ 22.12 guard with a clear message, exit 2, before any import | `bin/jevcode.js:11-15` | correct |
| epilogue + exit-code table | `src/cli/epilogue.ts:88-142` | correct |

## 2. Measured results

### 2.1 Signals (real `kill`, pty, mid-run and pre-run)

| probe | exit | clears after frame 1 | `RESTORE` count | epilogue |
| --- | --- | --- | --- | --- |
| SIGTERM 3 s into a live run (`sigterm.cap`) | **143** | 0 | 1 | yes |
| SIGHUP 3 s into a live run (`sighup.cap`) | **129** | 0 | 1 | none (by design) |
| SIGTERM immediately after the first frame (`sigearly.cap`) | **143** | 0 | 1 | yes |
| Ctrl-C ×2 at a pristine idle (`idleexit.cap`) | **0** | 0 | 1 | `[ui] exited on Ctrl-C ×2` |
| Ctrl-C during a thinking chat request, then `/exit` (`wedge.cap`) | **0** | 0 | 1 | `! stopped thinking` → `idle`, recovers cleanly |

All correct. Raw mode is restored (the driver's `wait` never reports a stuck termios), the cursor is shown, exit codes match
`EXIT_CODE_TABLE` (`src/cli/epilogue.ts:136-140`).

### 2.2 `JEVCODE_FAULT` coverage — **the hook exercises 1 of 6 React boundaries in the default frame**

`FIRED` = the `ui: <pane> pane failed to render …` notice appeared in the capture.

| fault string | 24×80 idle | 12×60 flat | 24×80 with a live run / review |
| --- | --- | --- | --- |
| `render:composer` | **FIRED** | **FIRED** | — |
| `render:status` | not fired | **FIRED** | — |
| `render:overlay` | not fired | — | **FIRED** (review, `f3-ovl.cap`) |
| `render:live` | not fired | — | **not fired** (`f3-live.cap`, 12-step run) |
| `render:pane` | not fired | — | **not fired** (`f3-pane.cap`, 12-step run) |
| `render:transcript` | **never fires** — the boundary has no `fault` prop | — | — |
| `render:static` | **FIRED** | — | — |
| `render:{pane,overlay,live,composer,status,banner,queue}:lines` | **FIRED** (all 7) | — | — |
| `render:transcript:lines` | never fires — there is no `guard('transcript', …)` | — | — |

Every fault run: `clears = 0`, `RESTORE = 1`, exit 0. The boundaries that *do* fire behave exactly as designed.

### 2.3 Geometry stress (`tiny2.cap`, 24×80 → 1×20 → 2×8 → 3×200 → 60×400 → 24×80, draft `abc` alive)

- exit 0, `clears = 1` (two shrink segments, the gate allows ≤ 2), `RESTORE = 1`, no hang, the draft `abc` survives every step.
- **1×20:** the whole dynamic region collapses; two consecutive frames carry **0 rows** (frames 6 and 8 of the capture); one frame is the bare `step 0/–`. Nothing tells the user the composer still accepts keys.
- **2×8:** the `<Static>` item `[sandbox] seatbelt — writes confined to the workspace and run dirs; …` was re-wrapped to
  8 columns and committed as **20 scrollback rows** of one or two words each, several with trailing spaces
  (`'           writes '`, `'          ~/.aws unr'` — the wrap even splits mid-word). `<Static>` is never repainted, so the
  20-row wall is permanent scrollback damage after the terminal widens again.
- **3×200 and 60×400:** correct — full box borders at 200 columns, the status row right-aligns with a dotted leader
  (`sess $0.00/10.00 ·········· ok  ? help`). No defect.

### 2.4 Filesystem and process edges

| scenario | today (measured) | exit |
| --- | --- | --- |
| config is truncated JSON | `jevcode: stopped — config: configFile: <path> is not valid JSON: Unexpected end of JSON input (exit 2)` | 2 |
| config is unreadable (chmod 000) | `config: configFile: cannot read <path>: EACCES: permission denied, open '<path>'` | 2 |
| `maxSteps: "lots"` at run time | `limits.maxSteps: "lots" (from file:<path>) is not an integer >= 1 (consulted: --max-steps (flag), JEVCODE_MAX_STEPS (env), maxSteps (file:…), default 40)` — **excellent** | 2 |
| `maxSteps: "lots"` under `jevcode config` | printed as a plain row, `value lots`, **no marker, no warning, exit 0** | 0 |
| `generator.model: 123`, `ui.theme: "nope"`, `notASetting: 1` | silently ignored; the table shows the defaults, **no warning on stderr or in the record** | 0 |
| `index.jsonl` with garbage + NUL bytes + a 4 000-byte line | `no session in <ws> yet` — **every bad line dropped silently** | 0 |
| `index.jsonl` with 200 000 lines / 51 688 890 B | `jevcode sessions` in 581 ms; whole file read into memory | 0 |
| `$HOME` read-only (chmod 500) | `[ui] error: EACCES: permission denied, mkdir '<home>/runs'` on **stdout**, **stderr empty, no epilogue**, exit **1** | 1 |
| workspace missing before the run | `[ui] error: config: workspace <path> does not exist` | 2 |
| workspace deleted **mid-run** | run continues and reports `complete`, no notice | 0 |
| **runs dir deleted mid-run** | run reports `complete`, **no `checkpoint degraded` item**, and the epilogue prints `files ~/runs/<id>/ (transcript.log, state.json, jevcode.log)` + `resume jevcode run --resume <id>` for a directory that no longer exists | **0** |
| **runs dir chmod 500 mid-run** | identical: `complete`, no degradation, resume advertised | **0** |
| `--plain \| head -2` (EPIPE) | jevcode exits **129**; the pipeline exits 0; stderr silent; no hang | 129 |
| two instances in the same workspace concurrently | both exit 0; **zero mention** of the peer, the lock or the conflict in either transcript | 0, 0 |
| git absent from `PATH` | `[run] git none · git not found on PATH: /undo and /diff use step pre-images only` — **exemplary** | 0 |
| `LANG=C LC_ALL=C TZ=Pacific/Kiritimati` | run completes, epilogue correct | 0 |
| `NO_COLOR=1 TERM=dumb --ascii --plain` | run completes | 0 |
| Node < 22.12 | `bin/jevcode.js:11-15` prints `jevcode: Node 22.12 or newer is required (found …); see .nvmrc`, exit 2, before any import | 2 |
| `jevcode report <bad-id>` | `jevcode report: "nosuchrun" is not a run id (expected YYYYMMDD-HHMMSS-xxxxxxxx). Run 'jevcode report --help' for usage.` then the marketing tagline `JevCode: Jev decides, Claude writes.` | 2 |
| `jevcode report <real-id>` | 7 files: `README.txt config.json jevcode.log run.json steps.tail.jsonl transcript.log versions.txt`; `versions.txt` is 111 B | 0 |

### 2.5 Memory over a long session

RSS of the **node** child sampled every 5 s through three consecutive 400-step mock runs in one chat session
(`storm2.cap`, `rss2.log`; 1 200 mock steps, 3 `run:end`s, 784 frames, 1 070 067 capture bytes over ~120 s, exit 0,
`clears = 0`, `RESTORE = 1`):

| t | 35 s | 40 s | 45 s | 55 s | 65 s | 80 s | 90 s | 105 s | 120 s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RSS | 138.6 MB | 138.7 MB | 127.7 MB | 134.5 MB | 135.4 MB | 135.4 MB | 120.5 MB | 117.9 MB | **117.2 MB** |

**No monotonic growth**: the peak is at the *first* run and RSS is 21 MB lower at the end than at the start. (An earlier
sampler run is discarded — it matched the expect driver's pid, not node's.) The caveat stands that each mock run
completes in well under its 40 s window, so most of the 2 minutes is idle; a true 30-minute storm against a slow
provider is still owed, and the harness is specified in §8 item 6. The static analysis is unambiguous: **every unbounded collection
found in the TUI is already capped** — `<Static>` items (20 000, `useEngine.tsx:524`), decisions (`DECISIONS_KEPT`,
`:628`), per-step decisions (3 steps, `:533`), the steer queue (8, `:701`), Jev latencies (12, `:53`), the live buffer
(`LIVE_BUFFER_MAX` 64 KiB, `:47`), toasts (4), the suspension queue (10 000), the kill ring, `RETIRED_MAX`, the two
line caches (256). The two that are **not** capped are named in §3.7.

---

## 3. Defects

### A7-1 — `guard()` has no latch: a *deterministic* builder throw is an unbounded render loop (severity: highest)

`src/tui/App.tsx:1962-1982`. `guard(pane, fn, fallback)` catches a throw, pushes a `PaneFailure` onto
`renderFaults.current`, and returns the fallback. The dep-less effect at `:1978-1982` then calls `onPaneFail` for each,
and `onPaneFail` (`:1945-1956`) calls `dispatch({ type: 'local', … })`, which appends a `<Static>` item
(`useEngine.tsx:472-479`) and re-renders. On the next render the same builder throws again.

Unlike `PaneBoundary`, which latches in `getDerivedStateFromError` (`PaneBoundary.tsx:87-89`) and never re-renders the
failing child, `guard()` re-executes `fn` on **every** render. A builder that throws for a *persistent* reason — a status
field with an unpaired surrogate reaching `stringWidth`, a `NaN` in `computeLayout`, a malformed `RetryCause` in
`retryLiveLines`, a `Intl.Segmenter` throw on an exotic locale — therefore produces: throw → dispatch → render → throw →
… forever, one `<Static>` item per iteration. Because a committed `<Static>` subtree takes Ink's **immediate** render
path (`isStaticDirty → onImmediateRender`, TUI-DESIGN §18), this is one unthrottled frame per iteration: the terminal
floods, the event loop is pegged, no key is ever read, and the only escape is `kill -9` from another terminal. The
`maxFps` throttle does not apply, `RENDER_FAULTS_FIRED` only latches the *injected* fault (`:1964`), not real throws.

This cannot be reproduced with `JEVCODE_FAULT` today, because the injected fault is once-per-process by construction —
which is exactly why the loop has never been seen. The fix and the fault scenario that would have caught it are
proposal **P1**.

### A7-2 — the runs dir vanishing or turning read-only mid-run is completely silent, and the epilogue then advertises a resume that cannot work (severity: high)

Measured twice (`rd2.err`, `ro2.err`): with `$JEVCODE_HOME/runs` removed (or chmod 500) 0.9 s into a 40-step run, the run
reports `[run] end complete steps=40 … exit 0`, no `checkpoint degraded: <code> on <file>` item appears, and stderr prints

```
jevcode: stopped — complete (exit 0)
  files     ~/runs/20260922-040207-epioqrgg/  (transcript.log, state.json, jevcode.log)
  resume    jevcode run --resume 20260922-040207-epioqrgg
  report    jevcode report 20260922-040207-epioqrgg   (redacted bundle written locally; nothing is sent)
```

`ls` confirms the directory does not exist. The machinery is all present and unused: the degraded classifier
(`src/checkpoint/store.ts:56-117`, `checkpoint degraded: <code> on <file>`), the degraded exit code 3
(`src/cli/epilogue.ts:134`), and the `resumable` flag the `resume` row is gated on (`src/cli/epilogue.ts:79`). The final
`state.json` write failed and nothing observed the failure. Every row the epilogue printed is a lie, and the `report`
row will produce an empty bundle.

### A7-3 — the transcript boundary can never fire and misnames the log (severity: medium)

`src/tui/App.tsx:2159`:

```tsx
<PaneBoundary pane="transcript" onFail={onPaneFail} resetKey={visible.length}>
```

It is the only `PaneBoundary` in the tree without `fault={fault}` and without `log={logName}` (compare `:2168`, `:2193`,
`:2207`, `:2213`, `:2256`, `:2272`). Consequences: `JEVCODE_FAULT=render:transcript` is a no-op (measured, §2.2), so the
last-resort boundary around the whole scrollback is untested at every geometry; and if it *does* catch, its notice reads
`details in jevcode.log` (`PaneBoundary.tsx:45,48`) instead of the real log path.

### A7-4 — the round-3 wordmark renders outside every boundary (severity: medium)

`src/tui/App.tsx:2188-2194`: the `markShown && mark !== null` branch renders `mark.rows.slice(…).map(… <SplashRow …
spans={mark.spans(loop.band).filter(…)} …>)` with **no `PaneBoundary` and no `guard()` around the call**. Only the
producer `wordmarkFrame(...)` is guarded (`:2038`). `mark.spans(loop.band)` and `<SplashRow>` execute bare in the render
body. Round 3 made the wordmark the pane slot's *idle tenant* — i.e. the thing on screen for most of a session's
lifetime — so this is the largest unprotected surface in the tree. A throw there reaches Ink's `InternalErrorBoundary`,
which is measured (research 17 §1.1) to print 42 rows, emit `ESC[2J ESC[3J` (screen **and scrollback** erased) and drop
raw mode: every §18 invariant broken at once. The `RuleRow` (`:2161-2165`), the banner row (`:2184-2190`) and the queue
rows (`:2201-2210`) are unprotected the same way (lower risk: plain pre-built strings).

### A7-5 — the status line is unprotected in the default (boxed) tier (severity: medium)

`src/tui/App.tsx:2270-2275` renders `<PaneBoundary pane="status">` only when `layout.chrome === 0`. In the boxed tier
(the default at ≥ 16 rows, TUI-DESIGN-2 §4.3) the status row is a `status={…}` prop of `<Console>` inside the
**composer** boundary (`:2213-2253`). So a `StatusLine` throw at 24×80 does not degrade the status row, it degrades the
whole console. Measured, `fault-composer.cap` at 24×80 — every frame of the run, from the first, with the box gone:

```
[ui] ui: composer pane failed to render (InjectedRenderFault) — run continues;
     details in jevcode.log
────────────────────────────────────────────────────────────────────────────────   (rule)
                ██ ▓▒░                                                             (wordmark, 5 rows)
            ██  ██ ▓▒░
             ████  ▓▒░
›                                                                                  (fallback input)
idle                                                            step 0/–  ? help   (status)
```

and after the first key, three rows: `rule`, `›`, `idle … step 0/– sess $0.00/10.00 ok  ? help`. Compare the same
geometry without the fault (`f2-status.cap`), which draws `╭─ jev+llm ─… ws-… ─╮ │ › … │ ├─┤ │ idle … │ ╰─…─╯`.
The row budget is respected, but the visual break from "boxed opencode-like console" to "bare rows" is exactly the kind
of jarring degradation round 4 is meant to remove: the box is chrome the fallback could keep.

### A7-6 — every wrong-typed and unknown config key is silent; `jevcode config` never validates (severity: medium)

Measured: `{"generator":{"model":123,"temperature":"hot"},"ui":{"fps":-5,"theme":"nope"},"notASetting":1}` produces
**zero** bytes on stderr and a table of defaults. The one setting that survives verbatim, `limits.maxSteps: "lots"`,
prints as a normal row with `source file:<path>` and is only rejected later, when `validateLimits`
(`src/config/validate.ts:292`) runs at run start. `jevcode config` is the command a user reaches for when something is
wrong, and today it is the one command that will not tell them their config is broken.

### A7-7 — a corrupt or huge `sessions/index.jsonl` is invisible (severity: medium)

`jevcode sessions` over an index containing garbage, NUL bytes and an over-length line prints `no session in <ws> yet` —
identical to a fresh install. The repair path exists (`jevcode sessions reindex`, `src/cli/sessions.ts:4`) and is never
suggested. Separately, the fold reads the whole file: 51 MB / 200 k lines took 581 ms, and the TUI folds it once per
session open, on the post-first-frame path. There is a per-line cap (`INDEX_LINE_MAX_BYTES = 512`,
`src/session/index.ts:20`) but no file-size cap and no automatic compaction.

### A7-8 — a read-only `$HOME` fails with a raw Node errno, no stderr, no epilogue, and exit 1 (severity: medium)

Measured: `[ui] error: EACCES: permission denied, mkdir '/tmp/.../runs'` on **stdout**, nothing on stderr, exit **1**
("uncaught / render fault escalated", `src/cli/epilogue.ts:140`). Every ingredient of a good message exists elsewhere in
the codebase — compare the `maxSteps` error, which names the setting, the source, the constraint and the whole
precedence chain. A read-only or `noexec` `$HOME` is normal in CI images, on locked-down corporate laptops and inside
containers; this is the first thing those users see.

### A7-9 — `run.json` version skew is not checked (severity: medium)

Setting `run.json` `"v": 99` plus an unknown field and resuming produced no version complaint at all (the resume was
refused for an unrelated reason: "already completed"). `isRunMeta` "checks v1 fields only, so old files load unchanged"
(`src/session/index.ts:60-62`) — which is right for *older* files and wrong for *newer* ones. A run written by a future
JevCode will be silently reinterpreted under v1 semantics rather than refused with "upgrade".

### A7-10 — the support bundle omits the files a TUI bug needs, and can OOM on a long session (severity: medium)

`src/cli/report.ts:150-184`. Measured bundle: 7 files, `versions.txt` 111 B.

- Omitted: `state.json` (the epilogue tells the user it is the important file), `jevcode.log.1` (the rotated half — after
  a rotation the bundle contains only the *newest* 8 MiB and loses the crash), `decisions.jsonl`, `sandbox-*.sb`, the
  effective `keybindings.json`, the resolved launch tier.
- `versions.txt` (`:77-89`) carries `TERM`, `TERM_PROGRAM` and `rows×cols` but **not** `LANG`/`LC_ALL`/`TZ`, `COLORTERM`,
  `NO_COLOR`, `SSH_TTY`/`TMUX`/`STY`, `stdout.isTTY`, or the resolved chrome tier / fps / reduced-motion / screen-reader
  / `--ascii` / `--plain` state — i.e. every variable that decides which of round 3's frames you were looking at.
- `put()` does `redact(await readFile(whole file))`. `transcript.log` has no size cap; a multi-hour session produces a
  file of hundreds of MB, read into one string and regex-redacted. That is an OOM or a multi-minute stall at exactly the
  moment the user is trying to file a bug.
- A throw halfway through `writeReportBundle` leaves a bundle directory with no `README.txt` and returns exit 1 from
  `commandReport`'s outer catch (`:242-245`).
- `jevcode report <bad-id>` prints the marketing tagline `JevCode: Jev decides, Claude writes.` after the error.

### A7-11 — the TUI has no peer awareness (severity: medium, TUI side only)

Two instances in the same workspace ran to completion concurrently with zero mention of each other. The round-4 registry
is another slot's design; the **TUI side** — a badge, a status-line segment, and a blocking pane when a second instance
opens a workspace another instance holds — does not exist at all today and needs a design here so the registry has a
surface to drive.

### A7-12 — smaller, confirmed

| # | Defect | Where |
| --- | --- | --- |
| a | `render:live` and `render:pane` never fire at 24×80, even during a 12-step run: those slots stay closed with the shipped `--mock` trajectory, so `states.ts`'s two fault scenarios (`src/perf/states.ts:237,248`) measure the *unfaulted* frame | measured, §2.2 |
| b | The degradation notice is 76 characters and wraps to 2–3 rows below 64 columns (`f3-comp12.cap`: `ui: composer pane failed to render \n (InjectedRenderFault) — run continues; details in \n jevcode.log`) — the very frame where rows are scarcest | `PaneBoundary.tsx:48` |
| c | With no log open, every notice says `details in jevcode.log`, pointing at a file that was never created (`log.file` is `''` → the default name, `App.tsx:1948`) | `App.tsx:1948`, `PaneBoundary.tsx:45` |
| d | `appendItems`' comment says "`UiState.items` keeps every item for `/export`" but line `:524` discards the whole array at the soft cap | `useEngine.tsx:519` vs `:524` |
| e | `keepSteps` bounds the number of *steps* to 3 but not the decisions *within* one step (`:535` appends without a cap) — a steer storm in one step grows unbounded | `useEngine.tsx:533-539` |
| f | `PasteStore` caps each body at 1 MiB but nothing caps the number of live chips; N pastes retain N MiB for the session | `paste.ts:37` |
| g | `rotateIfNeeded` renames to `<file>.1` and never prunes it, so a run dir holds up to 16 MiB of log with no notice | `log.ts:286-294` |
| h | The `files` epilogue row names `(transcript.log, state.json, jevcode.log)` unconditionally, even when the checkpoint was degraded and `state.json` was never written | `epilogue.ts:38,78` |
| i | EPIPE on stdout exits **129** (SIGHUP's code). The Unix convention for a closed pipe is 141 (`128+SIGPIPE`) or 0; 129 will read as "hung up" in CI logs | `fatal.ts:30,218-221` |
| j | At 1 row the dynamic region emits frames with 0 rows and nothing indicates the composer is alive | measured, `tiny2.cap` frames 6, 8 |
| k | `<Static>` items are wrapped at the *current* terminal width with no floor; at 8 columns one notice became 20 permanent scrollback rows with trailing spaces and mid-word splits | measured, `tiny2.cap` frame 7; `Transcript.tsx:112-115` `bodyWidth` clamps only to `>= 1` |

---

## 4. Proposals

Each: **what changes · where · edge cases · tests · perf gate · identity classification.**
Identity classification per the standing rule: *layout/colour* = no change to any string, so `transcript.log`, `--plain`
and the TUI rows stay byte-identical; *text* = the formatter `src/tui/plain.ts` and its `--plain` twin and every pinned
test must change together.

---

### P1 — Latch `guard()` per pane and dedupe the failure notice (fixes A7-1)

**What changes.** `guard()` gains a per-pane latch with the same semantics as `PaneBoundary`:

- a `failedPanes = useRef<Map<string, { name: string; count: number }>>` beside `renderFaults`;
- `guard(pane, fn, fallback)` returns `fallback` **without calling `fn`** while `failedPanes` holds `pane`;
- on a throw the pane is latched and one `PaneFailure` is queued (as today);
- the latch clears on the same `resetKey` the React boundaries already use — `visible.length` for the transcript,
  `state.runId` for the pane, `overlayKind` for the overlay — plus a new explicit `/ui reset` command action and the
  next `run:start`;
- `onPaneFail` becomes idempotent per `(pane, error.name)`: the first failure appends the `[ui]` item, a repeat within
  the same latch only increments a counter and logs at `debug`, and the *unlatch* appends
  `ui: <pane> pane recovered` at `info`.

Add the same latch discipline to the `renderFaults` effect: `splice(0)` stays, but the effect first filters out pairs
already reported under the current latch, so it can never dispatch on a render it itself caused.

**Where.** `src/tui/App.tsx:1945-1982` (the `guard`/`onPaneFail`/effect trio); `src/tui/PaneBoundary.tsx` unchanged.

**Edge cases.** (1) two panes throwing in the same render → two items, two latches, one commit; (2) a throw inside
`onPaneFail` itself (a broken `log`) → wrap the body in try/catch, the latch still holds; (3) a throw in the `overlay`
builder while a review is pending → the existing decline at `:1950-1953` must run exactly **once** per pending id (guard
on `pendingReview.id` already settled); (4) the latch must not survive an unmount/remount (it is a ref, so it does not);
(5) `resetKey` churn — `visible.length` changes on every item, so the transcript latch would clear immediately and
re-loop: the transcript latch must key on the *epoch*, not the length, and the retry must be rate-limited to one attempt
per 5 s per pane; (6) reduced motion / screen reader: the recovery line is an ordinary `[ui]` item, announced like any
other; (7) `--plain`: the plain renderer has no builders, so nothing changes there.

**Tests.**
- unit `test/unit/tui/app-guard.test.tsx`: mount `<App>` with a builder stubbed to throw **every** time; assert the
  component settles within N renders, exactly **one** `[ui]` item is appended, `fn` is called exactly once, and a
  `resetKey` change retries once and re-latches.
- unit: a throw in two panes in one render → two items, one commit (`renderToString` twice, equal output).
- pty `test/pty/smoke/fault-persistent.steps` driven with the **new** fault `JEVCODE_FAULT=render:status:lines:sticky`
  (§5 scenario 1): 10 s of wall time, assert `ESC[?2026h` frame count ≤ `maxFps × seconds + 2`, exactly one
  `pane failed to render` line in the capture, exit 0 on Ctrl-C ×2, `clears = 0`, `RESTORE = 1`.

**Perf gate.** Frame rate: `dynamic ≤ maxFps + 1` **while a pane is latched** (today an unlatched persistent throw is
unbounded). Composer keystroke → frame p95 < 16 ms with one pane latched. First frame unaffected (the latch is a ref
read).

**Identity.** Layout only, *except* the one new string `ui: <pane> pane recovered`, which is a renderer-local `[ui]`
notice: it must be added to `src/tui/plain.ts`'s notice formatter and to the `--plain` twin, and the identity test's
event list extended. Classify as **text (one added line)**.

---

### P2 — Make a failing checkpoint write degrade loudly, and never advertise a resume that does not exist (fixes A7-2, A7-12h)

**What changes.**

1. `src/checkpoint/store.ts`: every write path (`appendLine`, `writeMeta`, `writeState`) already classifies its errno
   (`:56-117`). Route that classification to a new `onDegrade(info)` callback on the store instead of only throwing, and
   have the engine emit `checkpoint:degraded` once per `key` (`<file>:<code>`), which the TUI already knows how to
   render.
2. `exitCodeFor(reason, result, degraded, signal)` already returns 3 for a degraded non-error stop
   (`src/cli/epilogue.ts:134`); the missing link is that `degraded` is never set. Set it from the first
   `checkpoint:degraded`.
3. The epilogue's `resumable` must be computed from a **post-write `stat`** of `state.json`, not from the intent to
   write it: `epilogueRows` (`src/cli/epilogue.ts:75-82`) keeps its shape, the caller passes `resumable: statSync(join(runDir,
   'state.json')).size > 0` inside a try/catch.
4. The `files` row lists only the files that exist: `(transcript.log, jevcode.log)` when `state.json` is absent, and the
   whole row is dropped when the run directory itself is gone, replaced by
   `files     <dir> — gone (the run directory was removed or became unwritable during the run)`.

**Where.** `src/checkpoint/store.ts:56-117, 311-370`; the engine's stop path (`src/loop/stop.ts` `exitCodeFor` callers);
`src/cli/epilogue.ts:38, 75-82`; `src/cli/session.ts:2150` (the `signalExit` abort already carries the context).

**Edge cases.** (1) the dir is deleted and re-created between two writes → the dedupe key is `<file>:<code>`, so a
second, different code degrades again; (2) ENOSPC vs EACCES vs ENOENT → all three are in `DEGRADED_CODES`, EROFS must be
added; (3) the run completes *successfully* but the last write failed → the stop reason stays `complete`, the exit code
becomes **3** (the design's "checkpoint degraded and stopped (incl. complete)" row); (4) a degraded checkpoint during a
**session** run → the item appears, the composer reopens, the session's later runs try again; (5) `--plain` and `--json`
must carry the same `checkpoint:degraded` event; (6) the degraded notice must never print the errno's raw `open '<path>'`
suffix — use `checkpoint degraded: EACCES on state.json — the run directory is not writable; this run cannot be resumed`;
(7) a read-only *parent* (the `$HOME` case) is the same path and must produce the same item rather than the `[ui] error:`
of A7-8.

**Tests.**
- unit `test/unit/checkpoint/degrade.test.ts`: an injected fs whose `writeFileAtomic` throws EACCES/ENOSPC/ENOENT/EROFS →
  one `checkpoint:degraded` per key, `exitCodeFor('complete', …, degraded=true)` → 3.
- unit `test/unit/cli/epilogue.test.ts`: `resumable:false` → `state.json missing — not resumable`; run dir absent → the
  `gone` row; `files` row omits `state.json`.
- pty `test/pty/smoke/rundir-vanishes.steps` with the new fault `JEVCODE_FAULT=persist:ENOSPC` (§5 scenario 3) during a
  live run: the degraded item appears within 2 s, the epilogue says `not resumable`, exit 3, `clears = 0`,
  `RESTORE = 1`.
- a hermetic integration test that `rm -rf`s the runs dir 1 s into a 40-step `--plain --mock` run and asserts exit 3 and
  `not resumable` (this is the probe that produced the defect).

**Perf gate.** None of the hot paths change; the added `stat` runs once, in `finishSession`, after the last frame. First
frame < 300 ms unaffected (nothing new before it).

**Identity.** **Text.** Three strings change or appear: the `checkpoint degraded: <code> on <file> — …` tail, the
conditional `files` suffix, and the `gone` row. All three are already formatted through `epilogueLines`/`epilogueItemLines`
(`src/cli/epilogue.ts:88-98`), which is the single formatter for the stderr epilogue and the `[ui] stopped — …` item, so
one change covers both twins. Pinned tests to update: `test/unit/cli/epilogue.test.ts`, the `--plain` epilogue snapshot,
`test/pty/smoke/*` captures that assert `resume    jevcode run --resume`.

---

### P3 — Close the render-boundary coverage holes (fixes A7-3, A7-4, A7-5, A7-12a)

**What changes.**

1. `App.tsx:2159` — add `fault={fault} log={logName}` to the transcript boundary.
2. Wrap the wordmark branch (`:2188-2194`) in `<PaneBoundary pane="wordmark" onFail={onPaneFail} fault={fault}
   log={logName} resetKey={state.runId ?? ''}>` **and** move `mark.spans(loop.band)` inside a
   `guard('wordmark', …, [])`. Its fallback is the blank pane slot (`layout.pane` empty rows), not a notice row — the
   idle tenant disappearing silently is the correct degradation, with the `[ui]` item carrying the detail.
3. Wrap `RuleRow` (`:2161-2165`), the banner row (`:2184-2190`) and the queue rows (`:2201-2210`) in boundaries named
   `rule`, `banner`, `queue`, each falling back to empty rows of the same height.
4. Give the boxed tier its own `status` boundary: keep `<Console>` under the composer boundary but pass
   `status={<PaneBoundary pane="status" …><StatusLine …/></PaneBoundary>}` so a `StatusLine` throw degrades one row
   rather than the whole console.
5. Change the composer's boxed fallback (`:2219-2224`) to **keep the box**: render the same `╭─ … ─╮ │ › <draft> │ ├─┤ │
   <status> │ ╰─╯` frame from the pure line builders, with only the interactive composer replaced by the masked
   one-line draft. This is the "does not look weird" requirement applied to the degraded state.
6. Add `render:<pane>` scenarios for `live`, `pane`, `overlay` to `src/perf/states.ts` driven from a state where the slot
   is **open** (a `--mock-steps 30` run with the panel forced open and `JEVCODE_MOCK_REVIEW_AT=2`), and assert in the pty
   gate that the notice is present — today `states.ts:237,248` measure frames in which the fault never fired.

**Where.** `src/tui/App.tsx:2155-2276`; `src/tui/Console.tsx` (accept a `status` node); `src/perf/states.ts:230-255`;
`src/tui/PaneBoundary.tsx` unchanged.

**Edge cases.** (1) a boundary whose fallback is "empty rows" must still consume exactly `layout.<slot>` rows or the
budget breaks — assert `dynamicRegion(frame).length ≤ rows − 2` in every fault scenario; (2) nesting a boundary inside
`<Console>` must not re-order Ink's layout — measure the frame count before/after; (3) the wordmark boundary's
`resetKey` must not be the sweep frame counter or it unlatches 15×/s; (4) `staticOnly` (the flat tier's degenerate case)
must not mount boundaries for slots it does not render; (5) with `isScreenReaderEnabled` the fallbacks must still emit
their twins; (6) `--ascii` fallbacks use the ascii glyph set.

**Tests.**
- unit `test/unit/tui/pane-boundary.test.tsx` extended: one case per pane name asserting the fault fires, the fallback
  height equals the slot height, and the sibling panes are untouched.
- unit: a `StatusLine` throw in the boxed tier leaves the box borders intact (`renderToString` snapshot with the four
  border characters present).
- pty: eight scenarios `fault-<pane>` at 24×80 and 12×60, each asserting `FIRED`, `clears = 0`, `RESTORE = 1`, exit 0 and
  the budget. These replace today's two.

**Perf gate.** Adding boundaries adds React components on the render path: **composer keystroke → frame p95 < 16 ms
(D-F)** must be re-measured, and **first frame < 300 ms** re-measured, since `<PaneBoundary>` now wraps the rule and the
wordmark that are present in frame 1. Class components are cheap, but the gate is the check.

**Identity.** **Layout/colour only** for items 1–5 (no string changes; the fallbacks reuse `paneFailedLine`, which
already exists in both twins). Item 6 is test-harness only.

---

### P4 — One narrow-terminal floor for `<Static>` commits (fixes A7-12k, A7-12j)

**What changes.** `bodyRows`/`bodyWidth` (`src/tui/Transcript.tsx:106-118`) clamp only to `>= 1`. Introduce
`STATIC_MIN_COLUMNS = 24`:

- below 24 columns, an item commits as **one truncated row** `<label> <text…>` cut to `columns` cells with the ellipsis,
  instead of being word-wrapped into a wall;
- trailing spaces are stripped from every committed row at every width (they are in the capture today);
- `wrapBody` never splits inside a grapheme cluster or mid-word when a break opportunity exists within the line (the
  capture shows `~/.aws unr` / `eadable;` and `--n` / `o-network`);
- below `STATIC_MIN_COLUMNS` the dynamic region renders a single row `jevcode needs ≥ 24 columns (now <n>)` and nothing
  else, so the 0-row frames of `tiny2.cap` become one informative row;
- at `rows === 1` the single row is the composer prompt with the draft, not the status — the user must always see that
  input is alive.

**Where.** `src/tui/Transcript.tsx:106-118`; `src/tui/transcript/wrap.ts`; `src/tui/layout.ts` (the `minsize` degraded
tier already exists — extend it to a column floor).

**Edge cases.** (1) CJK/emoji at the truncation point — cut on grapheme clusters, never mid-cluster (the `truncateCells`
helper in `glyphs.ts` already does this); (2) a label wider than the terminal (`[step 1000]` at 8 columns) → the label
alone, truncated; (3) resizing *up* from 8 columns must not retroactively fix the committed rows (it cannot — that is
why the floor exists), but the *next* item must use the new width; (4) `--plain` writes to a file or pipe with no
columns: the floor must not apply there (`columns === undefined` → one unwrapped row, as today); (5) `transcript.log`
must stay unwrapped and full-width regardless — the wrap is a TUI-render concern; (6) screen reader mode already emits
unwrapped twins.

**Tests.**
- unit `test/unit/tui/transcript-wrap.test.ts`: at columns 8/16/23 one row per item, truncated with `…`, no trailing
  space, no mid-cluster cut; at 24 and above the current behaviour byte-for-byte.
- unit: `transcript.log` for the same item list is identical at every column count (the identity rule).
- pty `test/pty/smoke/narrow.steps`: 24×80 → 2×8 → 24×80 with a run producing items; assert no committed row exceeds the
  width, no row is blank-only, no trailing spaces, `clears ≤ 2`, exit 0.

**Perf gate.** The truncation path is cheaper than the wrap path, so the `<Static>` commit rate is unchanged; assert
`static` frame class unchanged and `dynamic ≤ maxFps + 1` at 2×8 (today that geometry is untested).

**Identity.** **Layout only** — `transcript.log` and `--plain` are unwrapped and unaffected; the change is the TUI's
render width. The identity test must be extended with a column-sweep case proving that.

---

### P5 — `jevcode config` validates, and every rejected key says so (fixes A7-6)

**What changes.**

1. `resolveConfig` records, per entry, a `problem: { kind: 'unknown-key' | 'wrong-type' | 'out-of-range'; expected:
   string } | null` alongside `{ value, source }`, filled where the file layer already discards a value.
2. `configTableLines` (`src/cli/config-table.ts`) renders a problem row as
   `limits.maxSteps    lots    file:<path>    ✗ expected an integer ≥ 1` (ascii twin `x expected …`), and
   `commandConfig` returns **exit 2** when any problem exists, with a trailing
   `2 settings are invalid; run jevcode config --explain <setting> or fix <path>`.
3. `--json` gains the same `problem` field per entry.
4. Unknown file keys become one warning line naming each with the nearest valid setting
   (`notASetting is not a setting (did you mean maxSteps?)`) — the same fuzzy matcher the palette uses
   (`src/tui/commands/fuzzy.ts`).
5. At session start the same problems are emitted once as `[setup]` items, so the TUI user sees them without running
   `config`.

**Where.** `src/config/resolve.ts:600-700` (the record builder), `src/config/validate.ts` (the constraint strings already
exist in `requireNumber`/`parseBooleanSetting` — export them as data), `src/cli/config-table.ts:1-112`,
`src/cli/main.tsx:318-332`.

**Edge cases.** (1) a *flag* with a bad value already fails at parse — do not double-report; (2) an env var with a bad
value must name the variable, not the file; (3) a value that is valid but *dangerous* (`ui.fps: 240`) is clamped with a
`⚠` row, not an `✗`; (4) `--json` must stay a single JSON document even with problems (problems go in the entries, not
on stderr); (5) `jevcode config` exiting 2 must not break the completion scripts (they call `--json`, which keeps exit 0
when the caller passes `--tolerant`, or simply reads the field); (6) secrets are still masked in problem rows; (7) an
unknown key whose nearest match is farther than the fuzzy threshold gets no suggestion, not a wrong one.

**Tests.**
- unit `test/unit/config/problems.test.ts`: a fixture config with one of each problem kind → the exact rows, exit 2.
- unit: a clean config → zero problems, exit 0, table byte-identical to today (regression).
- unit: the fuzzy suggestion for `notASetting`, `maxstep`, `spendcap`.
- pty: extend the existing `plainwarn` scenario (whose fixture is already `{"notASetting": 1}`,
  `test/pty/run-smoke.sh:310`) to assert the `[setup]` item text.

**Perf gate.** `jevcode config` is not on the first-frame path. The `[setup]` items are emitted **after**
`firstFrame()` resolves (the §1 ordering contract), so **first frame < 300 ms** is preserved — this must be asserted, not
assumed, because the problem list is computed inside `resolveConfig`.

**Identity.** **Text.** New `[setup]` item strings and new `config` table rows. The `[setup]` items go through
`src/tui/plain.ts`'s notice formatter (one change covers the TUI row, `--plain` and `transcript.log`); the `config`
table is a non-TUI command with its own `--json` twin and is outside the identity rule. Pinned tests:
`test/unit/cli/config-table.test.ts`, the `plainwarn` pty capture, `docs/COMMANDS.md` (generated by
`scripts/gen-docs.mjs`).

---

### P6 — Errors that name the fix: one `explain()` layer over errno (fixes A7-8, parts of A7-2/A7-7)

**What changes.** A pure `explainFsError(e, ctx): { line: string; fix: string[] }` in `src/errors.ts` mapping
`(code, syscall, path, role)` to a sentence and a fix block, in the style the codebase already achieves for `maxSteps`
and for git:

| condition | line | fix |
| --- | --- | --- |
| EACCES/EROFS mkdir on the runs dir | `cannot create the runs directory <dir>: permission denied` | `set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>` |
| ENOSPC anywhere under the run dir | `the disk holding <dir> is full` | `free space, or pass --runs-dir <dir> on another volume` |
| ENOENT on the run dir mid-run | `the run directory <dir> disappeared during the run` | `this run cannot be resumed; the transcript above is complete` |
| EACCES on the config file | `cannot read <path>: permission denied` | `chmod u+r <path>, or pass --config <path>` |
| EMFILE/ENFILE | `too many open files` | `raise the file-descriptor limit (ulimit -n)` |
| ETIMEDOUT/ENOTFOUND to a provider | already handled well by `retryCauseText` (`src/tui/retry.ts:44-70`) | — |

Every launch-time failure routes through `fatalExit` so it gets the terminal restore, **stderr**, the epilogue and a
correct exit code (2 for a configuration/permission problem, not 1). The `[ui] error: <raw errno>` fallback stays only
for genuinely unclassified errors, and then carries the full `describe(e)` plus `run with JEVCODE_DEBUG=1 for the stack`.

**Where.** `src/errors.ts` (new pure function + table), `src/cli/session.ts:4005-4018` (the startup catch already prints
`jevcode: <describe>` — add the fix block, which it already does for `ConfigError` missing-key), `src/cli/fatal.ts:36-45`
(`fatalLines` gains the fix lines), `src/tui/App.tsx` (the `[ui] error:` dispatch sites).

**Edge cases.** (1) the path in the message must pass `redact` and `terminalSafeLine` (already the rule,
`epilogue.ts:68`) — a path can contain a token; (2) `~` abbreviation via `abbreviateDir` (`epilogue.ts:43-51`); (3) a
Windows-style errno never appears (macOS/Linux only) but the table must default gracefully; (4) the fix block must be at
most 2 lines so it fits the flat tier; (5) in `--json` the fix lines become a `fix: string[]` field, not prose; (6) the
same explanation must be reachable from the blocking pane (`src/tui/blocking/lines.ts`) so the degraded-checkpoint pane
of P2 shows it.

**Tests.**
- unit `test/unit/errors/explain.test.ts`: one case per row of the table, including a path containing a canary secret
  (assert redacted).
- unit `test/unit/cli/fatal.test.ts`: a thrown EACCES → exit 2, stderr carries the epilogue *and* the fix block, stdout
  empty.
- integration (hermetic, no pty): `chmod 500 $HOME` + `jevcode run --mock --plain` → exit 2, the exact first stderr line.
- pty `test/pty/smoke/readonly-home.steps`: the TUI shows the blocking pane, `[q]` exits 2, `clears = 0`, `RESTORE = 1`.

**Perf gate.** The table is a pure lookup evaluated only on a failure. **First frame < 300 ms**: the new module must be
imported lazily from `session.ts`, or added to `errors.ts`, which is already in the eager bundle — measure
`--perf-exit-after-first-frame` before and after.

**Identity.** **Text.** New error lines and fix blocks. They are `[ui]`/`[setup]` items and epilogue lines, so the twins
are `src/tui/plain.ts`'s notice formatter and `src/cli/epilogue.ts`. Pinned tests: `epilogue.test.ts`, the plain-renderer
identity test's event list, and the `--json` error-shape test.

---

### P7 — The support bundle a TUI bug actually needs (fixes A7-10)

**What changes.**

1. Copy `state.json`, `jevcode.log.1` (as `jevcode.log.1`), `decisions.jsonl` (tail 200) and the effective
   `keybindings.json` when present.
2. Cap every copied file at `REPORT_FILE_MAX = 2 MiB` **head + 2 MiB tail** with a
   `… <n> bytes elided (original <m> bytes) …` marker between them, streamed line-by-line through `redact` rather than
   read whole.
3. `versions.txt` gains `LANG`, `LC_ALL`, `TZ`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `SSH_TTY`/`TMUX`/`STY` presence
   (booleans, never values), `stdout.isTTY`, and a `launch` block with the resolved chrome tier, fps, `renderMode`,
   `ascii`, `screenReader`, `reducedMotion`, `plain`, `theme` — the round-3 facts that decide which frame the user saw.
4. Write `README.txt` **first** with a `(bundle incomplete)` marker, rewrite it last; a mid-way failure therefore leaves a
   self-describing directory.
5. Print the total bundle size and a one-line `tar -czf <id>.tgz -C <parent> <id>` suggestion.
6. Drop the tagline from the error path of `commandReport`.

**Where.** `src/cli/report.ts:23, 77-89, 140-185, 203-246`.

**Edge cases.** (1) a file that is exactly at the cap → no marker; (2) a binary-ish `jev.jsonl` under
`--include-requests` → the same cap and the same redactor; (3) `out` already exists → overwrite files, never delete the
directory; (4) ENOSPC while writing the bundle → `README.txt` already says `(bundle incomplete)`, exit 3 with the P6
explanation; (5) a run dir on a network mount that stalls → each read bounded by a 10 s timeout, listed under `not
available`; (6) the launch block must be recorded in `run.json` at run start (it is not today) so `report` can read it
offline.

**Tests.**
- unit `test/unit/cli/report.test.ts` extended: an injected fs with an 8 MiB `transcript.log` → the head/tail marker and
  ≤ 4 MiB written; a canary secret inside the elided region is never written; a throw mid-bundle leaves
  `(bundle incomplete)`.
- unit: `versionsText` snapshot with every new field.
- integration: `jevcode report <id>` on a real mock run → 11 files, `state.json` present.

**Perf gate.** None (an offline command). Assert the bundle of a 1 GB transcript completes in < 5 s and under 200 MB
RSS — the current whole-file read cannot.

**Identity.** Not TUI text. `README.txt` and `versions.txt` are bundle artefacts with no `--plain` twin. **Layout/none.**

---

### P8 — A session-index health check and a bounded fold (fixes A7-7)

**What changes.**

1. `foldIndex` counts `skipped` lines by reason (`not-json`, `bad-shape`, `over-length`, `unknown-kind`) and returns them.
2. `jevcode sessions` prints `<n> index lines were unreadable and skipped — run jevcode sessions reindex` when `skipped >
   0`, and the picker shows the same as a one-row footer.
3. `readIndex` streams instead of reading whole, and stops after `INDEX_FOLD_MAX_BYTES = 8 MiB` read **from the end**
   (the index is append-only and time-ordered, so the tail is what the picker needs); older history stays on disk and is
   reachable through `reindex`.
4. On session open, if the index exceeds 8 MiB, emit one `[ui]` notice offering `jevcode sessions prune`.

**Where.** `src/session/index.ts:380-460, 550-570`; `src/cli/sessions.ts:21-60`; `src/cli/session.ts:335`.

**Edge cases.** (1) a tail read must not start mid-line — scan forward to the first `\n`; (2) a single line longer than
the window → skipped, counted; (3) an index with only `rename`/`budget` lines for a session whose `run:start` is outside
the window → the session is shown with the fields it has, never a crash; (4) concurrent append while reading (the writer
is `O_APPEND`, no lock) → a torn last line is skipped and counted, not fatal; (5) an empty or absent index is not a
problem and prints nothing; (6) the 581 ms fold measured on 51 MB must drop below 100 ms with the window.

**Tests.**
- unit `test/unit/session/index.test.ts`: a fixture with one of each skip reason → exact counts; a torn final line; a
  200 k-line file with the window → the newest N sessions only, < 100 ms.
- unit: `reindex` over the same corrupt fixture recovers every `run.json`-backed session.
- pty: the picker footer row when `skipped > 0`.

**Perf gate.** The fold happens after `firstFrame()`, so **first frame < 300 ms** is unaffected, but the fold itself is on
the path to the first *usable* composer: gate it at **< 100 ms at 200 k lines**, measured in `src/perf/`.

**Identity.** **Text** — one new `[ui]` notice and one picker footer row. Both go through `src/tui/plain.ts` and need
their `--plain` twins.

---

### P9 — `run.json` forward-version refusal (fixes A7-9)

**What changes.** `isRunMeta` gains a version check: `v > CHECKPOINT_VERSION` → `ConfigError`
`run <id> was written by a newer JevCode (run.json v<n>; this build reads v<m>) — upgrade with jevcode upgrade`, exit 2;
`v < CHECKPOINT_VERSION` and absent `v` keep loading unchanged (the existing legacy rule at `src/session/index.ts:60-62`).
The same check guards `state.json`'s envelope (`parseEnvelope`).

**Where.** `src/checkpoint/store.ts` (`isRunMeta`, `parseEnvelope`), `src/session/index.ts:64-72`.

**Edge cases.** (1) `v` present but not a number → treat as corrupt, not as newer; (2) the sessions picker must show such
runs greyed with `newer version` rather than hiding them; (3) `jevcode report` must still bundle a newer run (a support
bundle for an unreadable run is exactly what you want) — the refusal applies to *resume*, not to *report*; (4) `sessions
reindex` skips and counts them (P8's mechanism).

**Tests.** unit: `v: 99` → the exact message and exit 2; `v` absent → loads; `v: "x"` → corrupt-shape message. pty: the
picker row for a newer run.

**Perf gate.** None (one integer comparison on an already-parsed object).

**Identity.** **Text** — one new error line through the epilogue/`[ui]` formatter, plus one picker row suffix.

---

### P10 — A TUI surface for the peer registry (fixes A7-11; the TUI half only)

**What changes.** The TUI gains three read-only surfaces the round-4 registry can drive, with a stub provider that
reports "unknown" until the registry lands, so the UI ships independently:

1. a status-line segment `2 here` (ascii `2 here`) when another instance holds the same workspace, with the peer count
   only — never a pid, never a path;
2. a `[ui]` item at session open: `another jevcode is working in this workspace (started 4m ago) — /peers lists them`;
3. a **blocking pane** (the existing `src/tui/blocking/lines.ts` machinery) when a peer holds an exclusive lease and this
   instance would write: `[w] wait for it   [r] read-only session   [q] quit`.

**Where.** `src/tui/status/lines.ts` (one segment), `src/tui/App.tsx` (the item), `src/tui/blocking/lines.ts` (one
request kind), `src/tui/commands/registry.ts` (`/peers`), with a `PeerView | null` prop supplied by the controller.

**Edge cases.** (1) a stale registry entry from a killed instance → the count must never block on a dead peer; the TUI
shows `1 stale` and offers `[c] continue`; (2) the segment must be the first thing dropped when the status line runs out
of columns (the existing priority list); (3) reduced motion / screen reader: the item is announced once, the segment is
static text; (4) `--plain` gets the item, not the segment; (5) the pane must be dismissible — a peer problem must never
be able to wedge the composer (see A7-1's lesson); (6) two instances *by the same user in the same terminal multiplexer*
is the common case and must not be alarming — the copy is informational, not a warning colour.

**Tests.** unit: the segment at 40/80/120 columns and its drop order; the blocking pane's three keys; the stale path.
pty `test/pty/smoke/peers.steps`: two instances driven in two ptys against one workspace, the second showing the item
and the pane, `[r]` continuing read-only, `clears = 0`, exit 0.

**Perf gate.** The peer read must be **off the first-frame path** (§1 ordering) and must never do synchronous I/O in the
render body — the controller supplies a snapshot. **First frame < 300 ms** and **status-line render p95** unchanged.

**Identity.** **Text** — one status segment, one item, one pane. Segment and pane already have `--plain` twins in
`status/lines.ts` and `blocking/lines.ts`; the item needs its `plain.ts` twin.

---

### P11 — Shorten and re-target the degradation notice (fixes A7-12b, A7-12c)

**What changes.** `paneFailedLine` (`src/tui/PaneBoundary.tsx:48`) becomes width-aware and shorter:

- ≥ 64 columns: `ui: <pane> failed (<Error.name>) — run continues; see <log>`
- < 64 columns: `ui: <pane> failed (<Error.name>)` with the log named in the item's `detail` line
- when no log file is open, `<log>` becomes `the run log (start with --log <file>)` in the detail, and the headline
  drops the `see …` clause rather than naming a file that does not exist.

**Where.** `src/tui/PaneBoundary.tsx:45-50`; `src/tui/App.tsx:1948`.

**Edge cases.** (1) `Error.name` can be attacker-influenced (a thrown object) — it is already normalised by `toError`
(`PaneBoundary.tsx:57-62`) and must additionally pass `terminalSafeLine` and be clipped to 32 chars; (2) the fallback
`<Text wrap="truncate">` must keep the full line available in `detail` for `transcript.log`; (3) `--ascii` twin.

**Tests.** unit: the three widths and the no-log case; a thrown object with a 10 000-char `name`. pty: the notice fits
one row at 60 columns.

**Perf gate.** None.

**Identity.** **Text** — `paneFailedLine` is used by the TUI fallback *and* the `[ui]` item that reaches
`transcript.log` and `--plain`. One formatter, one change; pinned test
`test/unit/tui/pane-boundary.test.tsx:141` and the fault pty captures.

---

### P12 — A submission watchdog and a guaranteed escape (hardening around `submittingRef`)

**What changes.** Today `submittingRef.current = true` is set at `src/tui/App.tsx:961` and cleared only in the
`.finally()` at `:975`. The Ctrl-C path is sound for a *thinking chat request* — measured in `wedge.cap`: `⠋ thinking` →
`! stopped thinking` → `idle`, recovered, exit 0 via `/exit` — because `host.abort()` sees `thinkingPhase !== null` and
calls `abortChat()` (`src/cli/session.ts:3725-3729`). The residual risk is the window in which `run: 'starting'` is set
by the App but the controller has **not yet** set `thinkingPhase` and no engine exists: there `host.abort()` falls
through all three branches (`session.ts:3717-3733`) and returns having done nothing, while `abortRun()`
(`App.tsx:680-684`) has already dispatched `run:aborting` unconditionally — and the `.finally()` at `:977` only restores
idle when the state is still `'starting'`, not when it is `'aborting'`. The state is then stuck and the next Ctrl-C maps
to `EXIT_NOW_130` (`interrupts.ts:99`), which calls the same no-op `host.abort`.

Three changes:

1. `abortRun()` dispatches `run:aborting` **only if** the host reports that it acted: `host.abort()` returns
   `{ acted: boolean }`; when it did not act, dispatch `run:idle` and toast `nothing to abort`.
2. The `.finally()` at `App.tsx:975-979` restores idle from `'starting'` **or** `'aborting'` when no `run:start` was ever
   seen for this submission (compare a submission token captured before the call).
3. A **watchdog**: `SUBMIT_WATCHDOG_MS = 45_000`. If `submittingRef` is still true and no `run:start`, no `thinking`
   phase change and no stream byte has arrived for that long, append
   `[ui] the request has not answered in 45s — Esc cancels it, or press Ctrl-C twice to leave` and enable an explicit
   `Esc` cancel that rejects the submission promise locally (the engine-side abort is best-effort).
4. `EXIT_NOW_130` becomes a **guaranteed** exit: if `host.abort()` reports it did not act, call `p.onAbort('human_abort')`
   and, failing that, `exit(130)` directly. A second Ctrl-C must *always* end the process.

**Where.** `src/tui/App.tsx:680-684, 955-980, 1272-1283`; `src/cli/session.ts:3717-3733` (return `{ acted }`).

**Edge cases.** (1) the watchdog must not fire during a legitimately slow first token — reset it on any `live` byte, any
`thinking` phase change and any retry row; (2) it must not fire while a retry countdown is visible (that state has its
own copy); (3) reduced motion: the watchdog line is a plain item, no animation; (4) the 45 s clock uses `state.nowMs`
(the 1 Hz tick) so a **clock jump** (NTP) cannot make it fire early or late by more than one tick — compute the deadline
from a monotonic `performance.now()`, not `Date.now()` (`App.tsx:561` uses `Date.now` for `now()`, so the watchdog needs
its own monotonic source); (5) `--plain`'s readline composer has the same window and needs the same watchdog line.

**Tests.**
- unit `test/unit/tui/submit-watchdog.test.tsx`: a submission promise that never settles → the line at 45 s, `Esc`
  cancels, the composer accepts text again, `run` returns to `none`.
- unit: `host.abort()` returning `{ acted: false }` → `run` stays `none`, the toast appears, a second Ctrl-C exits.
- unit `test/unit/cli/session-abort.test.ts`: the `acted` contract for all four branches of `host.abort`.
- pty `test/pty/smoke/stuck-submit.steps` with a new fault `JEVCODE_FAULT=submit:hang` (§5 scenario 5): Enter, wait 50 s,
  assert the watchdog line, `Esc`, type again, Ctrl-C ×2, exit 0, `clears = 0`, `RESTORE = 1`.

**Perf gate.** The watchdog is one `setTimeout` per submission, cleared on any progress: **lag p95 < 5 ms while typing
during a run** must be re-measured (a timer firing mid-typing is the risk). No first-frame impact.

**Identity.** **Text** — two new lines (the watchdog item and the `nothing to abort` toast). The item needs its
`plain.ts` twin; the toast is TUI-only (toasts have no `--plain` twin) and is therefore outside the identity rule, which
must be stated in the design.

---

## 5. Fault-injection scenarios to add (`JEVCODE_FAULT`, dev-only)

Today only `render:<pane>` and `render:<pane>:lines` exist (`README.md:664` says so explicitly). The design already
*names* `jev:429`, `jev:401` and `persist:ENOSPC` (TUI-DESIGN §19.6, `docs/TUI-DESIGN.md:1988-1991`) but they are not
implemented, so the three pty rows that would gate the retry row, the auth pane and the degraded pane are dead. The
scenarios below are what round 4 needs; each names the defect it would have caught.

| # | value | behaviour | catches |
| --- | --- | --- | --- |
| 1 | `render:<pane>:lines:sticky` | the builder throws on **every** render, not once | **A7-1** (the render loop) |
| 2 | `render:wordmark` | throws inside the idle tenant | **A7-4** |
| 3 | `persist:<CODE>[:after=<n>]` | the checkpoint store's write rejects with `CODE` (ENOSPC, EACCES, EROFS, ENOENT) from write `n` on | **A7-2** |
| 4 | `rundir:rm[:after=<n>]` | the run dir is removed after step `n` | **A7-2** |
| 5 | `submit:hang` | `host.submit()` returns a promise that never settles | **P12** |
| 6 | `jev:429[:<retryAfter>]`, `jev:401`, `jev:5xx:<n>` | the mock decider answers the status; `5xx:<n>` storms `n` times | the retry row, the auth pane, 429/5xx storms |
| 7 | `net:ENOTFOUND`, `net:ETIMEDOUT`, `net:ECONNRESET:mid-stream` | the transport fails at DNS, at connect, and mid-SSE | `retryCauseText` (`src/tui/retry.ts:44-70`) is well-written and untested end-to-end |
| 8 | `stdout:EPIPE[:after=<n>]` | `stdout.write` throws EPIPE after frame `n` | **A7-12i** and the hang-up path |
| 9 | `clock:jump:<±seconds>[:at=<n>]` | the injected `now()` jumps | elapsed clocks, toast expiry, the retry countdown, the P12 watchdog |
| 10 | `index:corrupt`, `index:huge:<n>` | the session index fixture | **A7-7** |
| 11 | `config:<kind>` | the config file is truncated / wrong-typed / unreadable | **A7-6** |
| 12 | `loop:hog:<ms>` | a synchronous busy-wait of `<ms>` inside one event handler | event-loop hogs (giant pastes, huge JSON parses) vs the 16 ms / 5 ms gates |
| 13 | `peer:<n>` | `n` fake peers in the registry snapshot | **P10** |

Implementation rule: one parser (`parseFault(env)` → a discriminated union) in a single dev-only module, every consumer
reading a typed field, no string matching scattered across the tree as today (`App.tsx:1957`, `PaneBoundary.tsx:52`,
`Transcript.tsx:41`). The parser must reject unknown values loudly on stderr *before* Ink mounts, so a typo'd fault in CI
fails the test instead of silently passing.

---

## 6. Logging, the report bundle and error clarity — review

**Logging (`src/core/log.ts`).** The best-engineered part of this area. Escape sequences and control bytes are stripped
**before** `redact` runs (`:166-173`) precisely so a key split by an ESC cannot be reassembled after redaction; clipping
happens last so it cannot split a `[REDACTED:…]` marker back into secret bytes. Keystrokes are only ever
`key kind=<class> len=<n> masked=<bool>` (`:176-179`). Write failures are swallowed so the log never becomes a second
error path (`:303-305`). One shared `'exit'` hook for all open logs so Node's MaxListeners warning can never reach stderr
while Ink owns the terminal (`:213-227`). Remaining gaps: `jevcode.log.1` is never pruned (A7-12g) and never bundled
(A7-10); there is no `--log-level` visible in `jevcode config`; and `routeConsole` is installed but nothing asserts in a
test that a stray `console.log` from a dependency cannot reach the frame — add a pty scenario with an injected
`console.log` under `JEVCODE_FAULT=loop:hog` style injection.

**Report bundle.** See A7-10 and P7. The redaction contract is right (every file passes `redact`, nothing is sent
anywhere, `README.txt` says so in the user's own words). The gaps are *completeness* and *size*, not safety.

**Error clarity.** The codebase already contains the target standard, twice:

- `limits.maxSteps: "lots" (from file:<path>) is not an integer >= 1 (consulted: --max-steps (flag), JEVCODE_MAX_STEPS (env), maxSteps (file:<path>), default 40)`
- `git none · git not found on PATH: /undo and /diff use step pre-images only`

Both name the value, the source, the constraint and the consequence. The failures in §2.4 that fall short —
`EACCES: permission denied, mkdir '<path>'`, the silent index, the silent config keys, the silent checkpoint — are all
the same shape: a Node errno or a dropped value with no sentence around it. P5, P6 and P8 close them with one pure
`explain` layer rather than ad-hoc strings.

---

## 7. Priority

| Order | Proposal | Why first |
| --- | --- | --- |
| 1 | **P1** guard latch | the only defect that can hang the product with no escape |
| 2 | **P2** checkpoint degradation | the only defect that silently loses the user's work and then lies about it |
| 3 | **P3** boundary coverage | the wordmark is unprotected and is on screen most of the time |
| 4 | **P12** submission watchdog + guaranteed second-Ctrl-C exit | "a second Ctrl-C always exits" must be unconditional |
| 5 | **P6** + **P5** error clarity | the largest visible quality gap, and cheap |
| 6 | **P4** narrow-terminal floor | the user's explicit "does not look weird when resized" |
| 7 | **P11** notice copy, **P9** version skew, **P8** index health, **P7** bundle | correctness polish |
| 8 | **P10** peer surface | depends on the registry slot |

## 8. Open questions

1. Should a latched pane (P1) auto-retry on a timer, or only on an explicit `resetKey` / `/ui reset`? A timer risks
   re-entering the loop at 1/5 Hz; no timer means a transient throw degrades for the rest of the session.
2. EPIPE's exit code (A7-12i): keep 129, or move to 141/0 for shell convention? 129 is currently load-bearing in
   `EXIT_CODE_TABLE` for SIGHUP and the two conditions are genuinely different.
3. `STATIC_MIN_COLUMNS = 24` (P4) — is the floor a hard truncate, or should items below the floor be **queued** and
   committed when the terminal widens? Queuing preserves information but changes `<Static>` ordering relative to
   `transcript.log`, which the identity rule forbids unless declared as a normaliser.
4. Does the degraded-checkpoint exit code 3 (P2) apply to a **session** that recovered on a later run, or only to the
   process exit? The table (`epilogue.ts:134`) is written for a one-shot.
5. `jevcode config` exiting 2 on an invalid setting (P5) — does any existing script depend on it always exiting 0?
6. The 2-minute / 1 200-step storm shows no growth (§2.5). A 30-minute storm against a *slow* provider
   (`JEVCODE_MOCK_JEV_MS=2000`, 900 steps spread over the window, so the idle path never dominates) is still owed, and
   should be run before P1 lands, since P1's latch changes the item-append rate under fault. Harness: the pty driver with
   `storm2.steps` lengthened, RSS sampled from the **node** child (match `ps -axo comm=` on `node`, not the expect
   driver's argv), plus `--expose-gc` heap snapshots at 0/15/30 min.
