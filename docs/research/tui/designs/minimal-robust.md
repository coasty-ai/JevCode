# JevCode interactive TUI — design: minimal surface, robustness first

Written 2026-09-20 against `src/core/types.ts` (frozen contract), `src/loop/engine.ts`, `src/tui/*`, `src/cli/*`, `docs/DESIGN.md` §6/§9–§12 and
`docs/research/tui/00-SUMMARY.md` (rows cited as `Ann`, `Rnn`, `Cnn`, `Pnn`, `Dn`; file sections as `NN §x`). Product decisions F1–F18 are taken as
given. Where this design departs from an ADOPT row the deviation is one sentence in §22.

## 0. Thesis, and how the fixed decisions are honoured

**Thesis.** Everything the fixed feature list needs fits in *nine* kinds of dynamic rows, *one* modal slot, *four* new engine methods and *two* new
engine states. Every modal thing (review box, wizard, follow-up confirm, secret gate, blocking pane, palette, undo prompt, minimum-size notice)
renders in the same slot directly above the composer, so at most one of them exists at a time and `computeLayout` has one allocation order to prove
(§2). Every key is resolved by one pure `resolveKey(state, key)` over an enumerated state machine (§3), never by handler order. Every visual has a
`lines()` function shared with `--plain`, `transcript.log` and the screen-reader twin (A49), so parity is a unit test, not a review. Robustness comes
from treating each failure class the research measured (08 §11 overflow clears, 17 §1 Ink error overlay/ENOSPC/401/429, 07 §3 SIGHUP/SIGTSTP/resize
storms, 13 §4.1 key leak in `JEVCODE_TRACE`, 16 §3 secrets in five sinks, 15 §3.2 `checkout --` from the index) as a state the machine already has a
transition for, with a pty or fault-injection test per class (§19).

| Fixed decision | Where honoured | Notes |
| --- | --- | --- |
| F1 entry points | §1 | `jevcode`/`jevcode chat` → session TUI; `run "<task>"` → one-shot; `--plain` TTY readline composer shares `dispatchCommand()`; non-TTY no composer; `--json` versioned stream (§8.9) |
| F2 rendering | §2, §14 | `<Static>` only writer; one region ≤ rows−2; kitty disabled; no OSC 11; `--theme`; NO_COLOR shim in `bin/jevcode.js` (already present) |
| F3 caps A109 | §2.1 `computeLayout` | composer 1–6 (8 at ≥ 40), queue ≤ 2, pane ≤ 12, review 8+≤8, wizard ≤ 4, follow-up 5, secret 1, retry inside live ≤ 2; yield pane → live → preview → queue → composer-to-1; review collapses composer to 1 |
| F4 keys | §3, §4 | readline set A8; `/` col 0 palette; `@` mention; `?`/F1 help; Tab completion; Ctrl+O; Ctrl+G; Ctrl+Z; Ctrl+L; Ctrl+R; Up/Down rule; no `!`, no `/compact` |
| F5 Ctrl-C/Esc/Ctrl-D | §3.3 | 19 §4 table with F5's choices; `human_pause`; 30 ms Esc re-buffer; DESIGN §11 second-Ctrl-C invariant kept |
| F6 review | §6 | y/n/Esc/d/e/w+digit/Ctrl-C; keys on row 2; gauges; 1 s idle deferral; never always/Enter/timeout/`--auto-decline`; `alwaysDecline` untouched |
| F7 sessions | §8 | sessionId/parentRunId/source; seeded follow-up run; `Engine.steer/unsteer/pause`; `index.jsonl`; `history.jsonl`; `planAfter`; `/export`; `/theme` new items only |
| F8 money | §9 | parent SpendMeter; 50/80/95 %; y/r/n box; `/budget` scopes; unpriced fails closed; `jevcode config` prints derived cap |
| F9 secrets | §10 | `detectSecrets`; `y` → `addSecret`; raw provider turn; paste `useRef` map; 12,000-char notice; `@` denylist; clipboard; trace key classes |
| F10 onboarding | §11 | `missingSecrets(mode)`; ≤ 4-row wizard; masked field; XDG write 0600; trust gate; AGENTS.md; `--no-input` |
| F11 git/undo/diff | §12 | two spawns at run start; banner; `fs.watch` zone; pre/post images; verify-before-write; `git restore --source=HEAD --worktree`; stat block; `$PAGER` |
| F12 errors | §13 | `retry` events + 1 Hz row; pacing; `PaneBoundary`; re-ordered `fatalExit`; epilogue; disk pause exit 3; 401 → 2; `jevcode.log`; `report` |
| F13 contract | §15 | one ordered list; additive; jev-only preservation checklist |
| F14 config | §16 | `ui.*`/`limits` table with precedence and sources |
| F15 packaging | §17 | zero-dependency package, LICENSE, completions, man page, upgrade, tap, trusted publishing |
| F16 views | §7 | tabs d/p/t/s; bars; loop banner; status zones; sparkline; `/why`, `/calibration`; toasts; twins |
| F17 fuzzy | §5.4 | prefix-then-subsequence, ≤ 8 rows, ≤ 16 ms/5,000 measured in a unit test |
| F18 | §18–§20 | no new runtime deps; strict TS; every module unit-tested offline; pty via `expect`; perf gates extended |

**Kept from today, untouched:** `itemsFromEvent`/`formatTranscriptItem` (one line per item), the `synth` event → one transcript line, `propose
[synth]` marker, `NullProvider` + `createSynthesizer` path in `main.tsx`, `alwaysDecline`, `createTuiConfirmer`'s "second request declines the first",
`LIVE_FLUSH_MS = 50`, `DECISIONS_KEPT = 12`.

## 1. Entry points and modes

| Invocation | TTY? | Renderer | Composer | Run starts | Exit |
| --- | --- | --- | --- | --- | --- |
| `jevcode`, `jevcode chat` | yes | Ink session TUI | Ink composer, first frame < 300 ms, no run yet | on first Enter (or `-c`/`--resume` → picker/continue) | `/exit`, Ctrl-D×2, Ctrl-C×2 idle → 0 (`--exit-code=last-run` opt-in) |
| `jevcode run "<task>"`, `--task-file`, `--resume <id>` | yes | Ink one-shot monitor (today's `commandRun`) with the composer mounted for steering only | yes; Enter = steer while live; after `run:end` the process exits | immediately after `run:ready` | `exitCodeFor(stop)` (§13.5) |
| `jevcode [chat] --plain` | yes | `plain.ts` + `node:readline` line composer (`terminal: true`, own history) | readline; same `dispatchCommand()`; Enter while live = steer | on first line | same as session |
| `jevcode run … --plain` | yes | `plain.ts` + readline steering | readline | immediately | one-shot codes |
| `--plain` on a pipe, `CI`, `TERM=dumb`, `--no-input` | no | `plain.ts`, no readline, no queries, no 2004 | none; task from argv/`--task-file`/stdin | immediately | one-shot codes; every prompt takes its safe default (C46) |
| `--json` (implies plain, non-interactive) | any | NDJSON writer (§8.9) | none | immediately | one-shot codes; `run:end.exitCode` on the stream |
| `bench`, `perf` | n/a | none / own | none | n/a | `RunMeta.source` = `bench`/`perf`; never write `sessions/index.jsonl` or `history.jsonl` |

Rules (A82, A93, A124): interactive iff `Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && !isInCi && TERM !== 'dumb' && !flags.plain && !flags.json &&
!flags.noInput`. `jevcode` with no command parses as `chat` (args.ts: bare argv or a first token starting with `-` that is not `--help/--version` →
`command: 'chat'`). `jevcode run` with no task and a TTY → also `chat` (A101). The first frame of `chat` is the composer frame from argv only;
`resolveConfig`, `missingSecrets`, `sessions/index.jsonl`, `trust.json` and `git` are touched only after `firstFrame()` resolves (DESIGN §12 ordering
contract; `perf/first-frame.ts` gains a `chat` geometry, §18).

**Session loop (main.tsx `commandChat`).** One process, N runs:

```
render <App mode="session"> (argv only) → firstFrame()
→ resolveConfig → missingSecrets(mode) → wizard? → trust gate? → sandbox line → recent-session hint
→ loop:
    await composer submit (task | follow-up | /command)
    /command → dispatchCommand (idle-only commands run now; others report "not while a run is live")
    task     → budget check (§9.3) → createEngine({ ...opts, seed?, humanDirective? }) → attach → run()
             → run:end item (+ exit code) → post-run hooks (index run:end line, epilogue item, notifier if enabled)
    Ctrl-C×2 idle | /exit | Ctrl-D×2 → unmount → exit 0
```

The one-shot `run` path is the same function with `mode: 'one-shot'` and `maxRuns = 1`; after `run:end` it unmounts and returns `exitCodeFor`. Both
share `RendererOptions` extended with `mode` and the session hooks (§15 item 20).

## 2. Layout

### 2.1 `computeLayout(rows, columns, state)`

Vertical order, top to bottom: `<Static>` scrollback · **rule** (carries the pane tab header when a pane is shown) · **live** (≤ 2; generator/exec
tail, synth line, or the retry row) · **banner** (≤ 1; loop/replan) · **pane** (≤ 12; tabs d/p/t/s; the session picker renders here too) · **queue**
(≤ 2 queued steers) · **overlay** (the one modal slot: review header 8 + preview ≤ 8, wizard ≤ 4, follow-up confirm 5, secret row 1, blocking pane ≤
4, palette ≤ 8, undo prompt 1, minimum-size notice 1) · **composer** (1–6, 8 at rows ≥ 40) · **status** (1). Allocation order is the priority order
(what receives rows first); the F3 yield order is its reverse.

```ts
// src/tui/layout.ts — pure, unit-tested; replaces App.tsx computeLayout (A10, A107, A109, C47, D1)
export const MIN_ROWS = 8;
export const MIN_COLUMNS = 40;
export const CAP = { live: 2, queue: 2, pane: 12, reviewHeader: 8, preview: 8, wizard: 4, followup: 5, secret: 1,
  blocking: 4, palette: 8, undo: 1, minsize: 1, composer: 6, composerTall: 8, banner: 1 } as const;
export type OverlayKind = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo';
/** Overlays that make the composer collapse to one row (F3: a pending review collapses the composer). */
const COLLAPSING: ReadonlySet<OverlayKind> = new Set(['review', 'wizard', 'followup', 'blocking']);
export interface LayoutInput {
  rows: number; columns: number;          // from useWindowSize() only (A93 rule) — never process.stdout.rows
  overlay: OverlayKind;
  overlayWant: number;                    // review 8 · palette min(results, 8) · wizard 2–4 · followup 5 · secret 1 · blocking 2–4 · undo 1
  previewWant: number;                    // review only: confirmPreviewLines(req).length
  expanded: boolean;                      // review 'e' pressed: the preview may take the pane's rows
  composerWant: number;                   // visual rows of the draft, ≥ 1
  queueWant: number;                      // queued steers, 0..8
  liveWant: number;                       // 0..2 (stream tail, synth line, retry row(s))
  bannerWant: 0 | 1;                      // loop signature at x2/3 or a replan directive active (A45)
  paneWant: number;                       // 0 until run:ready; rows the active tab can fill, ≤ 12; picker rows when open
}
export interface Layout { budget: number; minsize: boolean; status: number; rule: number; live: number; banner: number;
  pane: number; queue: number; overlay: number; preview: number; composer: number; total: number }
export function computeLayout(i: LayoutInput): Layout {
  const budget = Math.max(0, Math.floor(i.rows) - 2);
  let rem = budget;
  const take = (want: number): number => { const got = Math.max(0, Math.min(Math.floor(want), rem)); rem -= got; return got; };
  const z: Layout = { budget, minsize: false, status: 0, rule: 0, live: 0, banner: 0, pane: 0, queue: 0, overlay: 0, preview: 0, composer: 0, total: 0 };
  if (i.rows < MIN_ROWS || i.columns < MIN_COLUMNS) {          // A100 two-line degradation: status · notice · composer
    z.minsize = true; z.status = take(1); z.overlay = take(1); z.composer = take(1); z.total = budget - rem; return z;
  }
  z.status = take(1);                                            // 1 never yields
  z.rule = take(1);                                              // 2 never yields at rows ≥ 8
  z.composer = take(1);                                          // 3 "composer-to-1" is the last yield
  z.overlay = take(i.overlay === 'none' ? 0 : i.overlayWant);    // 4 modal header (review: 8 rows, keys line on row 2)
  const composerCap = COLLAPSING.has(i.overlay) ? 1 : i.rows >= 40 ? CAP.composerTall : CAP.composer;
  z.composer += take(Math.min(i.composerWant, composerCap) - 1); // 5 composer growth
  z.queue = take(Math.min(i.queueWant, CAP.queue));             // 6 queue ≤ 2
  z.preview = i.overlay === 'review' ? take(Math.min(i.previewWant, i.expanded ? rem : CAP.preview)) : 0; // 7
  z.live = i.overlay === 'review' ? 0 : take(Math.min(i.liveWant, CAP.live)); // 8 live is empty while a review is pending (A42)
  z.banner = take(i.bannerWant);                                 // 9
  z.pane = i.expanded ? 0 : take(Math.min(i.paneWant, CAP.pane)); // 10 pane yields first
  z.total = budget - rem;
  return z;
}
```

Invariants (unit-tested for rows 3..60 × columns 20..400 × every `OverlayKind` × wants 0..12): `total ≤ budget`; `status === 1` whenever `rows ≥ 3`;
`composer ≥ 1` whenever `rows ≥ 5`; `overlay === overlayWant` whenever `rows ≥ overlayWant + 3` (the review header is whole at rows ≥ 11); the review
header is truncated by `reviewHeaderLines(req, n)` (§6.3), never by Ink wrapping; every pane is `<Box height={n} overflow="hidden">` with `<Text
wrap="truncate">` rows. Below `MIN_ROWS` the transcript keeps flowing into `<Static>`.

### 2.2 Row allocation per state (rule·live·banner·pane·queue·overlay·preview·composer·status = total / budget)

| State (wants) | rows 8 (b 6) | rows 12 (b 10) | rows 24 (b 22) | rows 40 (b 38) | rows 50 (b 48) |
| --- | --- | --- | --- | --- | --- |
| idle composer, after a run (pane 12, composer 1) | 1·0·0·3·0·0·0·1·1 = 6 | 1·0·0·7·0·0·0·1·1 = 10 | 1·0·0·12·0·0·0·1·1 = 15 | 15 | 15 |
| idle composer, session start (pane 0) | 1·0·0·0·0·0·0·1·1 = 3 | 3 | 3 | 3 | 3 |
| live run, streaming (live 2, pane 12) | 1·2·0·1·0·0·0·1·1 = 6 | 1·2·0·5·0·0·0·1·1 = 10 | 1·2·0·12·0·0·0·1·1 = 17 | 17 | 17 |
| live + 2 queued steers (live 2, queue 2, draft 1) | 1·1·0·0·2·0·0·1·1 = 6 | 1·2·0·3·2·0·0·1·1 = 10 | 1·2·0·12·2·0·0·1·1 = 19 | 19 | 19 |
| live + loop banner (live 2, banner 1) | 1·2·0·1·0·0·0·1·1 = 6 (banner yields) | 1·2·1·4·0·0·0·1·1 = 10 | 1·2·1·12·0·0·0·1·1 = 18 | 18 | 18 |
| review pending (header 8, preview 4, queue 0) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·0·0·7·0·1·1 = 10 | 1·0·0·7·0·8·4·1·1 = 22 | 1·0·0·12·0·8·4·1·1 = 27 | 27 |
| review pending, `e` expanded (preview 30 lines) | as above | as above | 1·0·0·0·0·8·11·1·1 = 22 | 1·0·0·0·0·8·27·1·1 = 38 | 1·0·0·0·0·8·30·1·1 = 41 |
| palette open (8 results, composer 1) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·0·0·7·0·1·1 = 10 | 1·0·0·11·0·8·0·1·1 = 22 | 1·0·0·12·0·8·0·1·1 = 23 | 23 |
| picker open (pane slot, 12 rows incl. header) | 1·0·0·3·0·0·0·1·1 = 6 | 1·0·0·7·0·0·0·1·1 = 10 | 1·0·0·12·0·0·0·1·1 = 15 | 15 | 15 |
| onboarding wizard (4 rows, no run) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·0·0·4·0·1·1 = 7 | 7 | 7 | 7 |
| follow-up budget confirm (5 rows, pane 12) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·2·0·5·0·1·1 = 10 | 1·0·0·12·0·5·0·1·1 = 20 | 20 | 20 |
| retry row (live 1–2, pane 12) | 1·2·0·1·0·0·0·1·1 = 6 | 1·2·0·5·0·0·0·1·1 = 10 | 1·2·0·12·0·0·0·1·1 = 17 | 17 | 17 |
| secret gate row (overlay 1, draft 3 rows) | 1·0·0·0·0·1·0·3·1 = 6 | 1·0·0·4·0·1·0·3·1 = 10 | 1·0·0·12·0·1·0·3·1 = 18 | 18 | 18 |
| minimum size (rows < 8 or columns < 40) | rows 6: notice 1 + composer 1 + status 1 = 3 | — | — | — | — |

A tall composer (want 6, or 8 at ≥ 40 rows) adds its growth before the queue: at rows 24 with a 6-row draft and 2 queued steers the pane gets `22 −
(1+1+6+2+2+1) = 9`. At rows 40 the region never exceeds 27 rows without `e`; the remaining rows are scrollback, which is the point of the design (08
§11: an over-budget frame costs 29,765 B and one `ESC[2J` per keystroke).

### 2.3 Worked frames

Rows above the rule are `<Static>` scrollback and are shown only where they matter. Widths were checked by a script (§19.1 keeps the check as a test
over this file).

**Idle composer, session after run 7, 24×80** (dynamic region 15 rows; tab header lives on the rule row):

```
[step 7] judge succeeded=0.89 error_present=0.04 new_info=0.61 tests=41p/0f/0e…
[run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
[run] stopped — max_steps (exit 4) · raise: /budget max-steps 14, then /resume
─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~
s7 judge    error_present    noul   ▍·········  0.04  c 0.92~
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~
> Follow-up or /command…   Enter runs · ↑ history · Esc Esc menu · ? help
idle exit 4   step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**Idle composer, session start, 8×80** (3 dynamic rows; the rest is scrollback):

```
[run] jevcode | step 0/– starting
[sandbox] seatbelt — writes confined to the workspace and run dirs; …
recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)
────────────────────────────────────────────────────────────────────────────────
> Describe the task…   / commands · @ files · ? help · Enter runs
idle   step 0/–  sess $0.00/10.00 ok  ? help
```

**Live run with streaming, 12×80** (rule 1 + live 2 + pane 5 + composer 1 + status 1 = 10):

```
─── decisions s3 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
streaming… 1,204 chars
  the timezone. I will make parse_date return an aware datetime by replacing
s3 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s3 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s3 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s3 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s3 context  tests/test_a.py  noul   ██████▏···  0.61  c 0.22~
> Type to steer the next step…   Esc pauses · Esc Esc aborts
⠹ propose   step 3/40 1m02s  run $0.09/2.00 ok  sess $0.40/10.00 ok  ? help
```

**Live run with 2 queued steers, 24×80** (live 2 + pane 12 (5 shown) + queue 2 + composer 1 + rule + status = 19):

```
─── decisions s5 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
$ pytest -q tests/test_a.py
....F                                                                    [100%]
s5 intent   intent           verify ███████▏··  0.71  c 0.60   chosen
s5 intent   can_verify       noul   ████████▌·  0.85  c 0.70~
s5 intent   plan_still_valid noul   ████████··  0.80  c 0.60~
s5 context  tests/test_a.py  noul   ████████▍·  0.84  c 0.68~
s5 context  src/a.py         noul   ███████···  0.70  c 0.40~
(… 7 more pane rows)
↑1 queued for step 6: use datetime.fromisoformat instead of strptime
↑2 queued for step 6: also update CHANGELOG.md                    [↑ takes back]
> _
⠼ execute   step 5/40 2m41s  run $0.17/2.00 ok  sess $0.48/10.00 ok  ? help
```

**Review pending, 24×80** (composer collapsed to 1; live 0; header 8 + preview 4; pane 7):

```
─── decisions s7 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s7 risk     matches_intent   noul   ████████▊·  0.88  c 0.76~
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what the task asks
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable
matches_intent    ████████▊·  0.88 noul 0.76~ the action is an instance of the…
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
> (review pending — keys above; d opens a note)
review      step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**Review pending, 12×80** (header cut to 7 by `reviewHeaderLines(req, 7)`: ruler dropped, keys line survives):

```
────────────────────────────────────────────────────────────────────────────────
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what the task asks
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable
matches_intent    ████████▊·  0.88 noul 0.76~ the action is an instance of the…
> (review pending)
review      step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**Review pending, 8×80** (header 3: title, keys, one compact row with the two highest dimensions):

```
────────────────────────────────────────────────────────────────────────────────
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
plan_mismatch L2 r=0.44 tail c=0.61 | destructive L1 r=0.25 exp c=0.93
> (review pending)
review      step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**Review pending, 40×120** (header rows with P(l), E[k], tail; pane 12 of which 6 shown; preview 4; 27 dynamic rows):

```
─── decisions s7 · c~ derived |2p−1| ─────────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  "change source files"
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~             231ms
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~             231ms
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~             198ms
s7 context  tests/test_a.py  noul   ██████▏···  0.61  c 0.22~             198ms
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]   244ms  skips a planned verification step
(… 6 more pane rows)
review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"             jev 244ms
[y] approve [n] decline [d] decline+note [e] expand preview [w]1-5 why [esc] decline
dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)
destructive    L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverable
out_of_scope   L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   does what `plan.remaining[0]` or `task` asks
plan_mismatch  L2  ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step
irreversible   L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git cmd
matches_intent     ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
> (review pending — keys above; d opens a note)
review    step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  ? help
```

**Palette open, 24×80** (8 result rows in the overlay directly above the composer; pane shrinks to 11):

```
─── plan s7 · done 2 rem 3 unv 1 prob 2 ─── [d]ecisions [p]lan [t]ime [s]ynth ──
[x] add failing test for parse_date                 s4  done_0 0.91
[x] fix parse_date tz handling                      s6  done_0 0.78
[?] update CHANGELOG                                s7  done_1 0.52  unverified
[ ] run full suite
[ ] remove debug print in utils.py
[!] replan s6 change_approach: try tz-aware parsing instead of string ops
[!] rejected_claim s5: "tests pass" done_0 0.12
(4 spare pane rows omitted)
▌ /budget  raise a limit for the next run or resume   spend-cap|session-…
  /new     end this session; the next prompt starts a new one
  /why     show a decision's probabilities, criteria and the consuming rule
  /plan    print the plan ledger as a transcript block
  /jev     decider model, drift, questions, latency p50/p95, Jev cost
  /pause   stop at the next step boundary (Esc)
  /export  write the session transcript to a file
  /exit    quit (always exit 0)                                         ▼ (1/23)
> /b_
palette   step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  Tab completes
```

**Picker open, 24×80** (`/resume` with no argument; picker takes the pane slot; composer is the filter):

```
─── sessions · this workspace (Ctrl-A: all) · by updated ─ ↑↓ Enter Space Esc ──
   2 h ago   7   max_steps   $0.31   fix parse_date tz                         ▌
   1 d ago  12   complete    $0.98   add retry to the OpenRouter client
   3 d ago  25   spend_cap   $1.53   migrate tests to pytest
   5 d ago   4   human_pause $0.04   refactor CLI args
   6 d ago   3   error       $0.02   explore repo layout
  preview: plan done 2/5 · remaining 3 · spend $0.310 · stop max_steps @ step 7
  [step 7] judge succeeded=0.89 … completion=0.68
  [run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
  Enter: continue this run as a follow-up · Space: preview · x: n/a in v1
  (3 spare pane rows omitted)
> filter: par_
idle          step 0/–  sess $0.00/10.00 ok  Esc closes
```

**Onboarding wizard, 24×80** (4-row overlay; no run; pane 0; composer inactive):

```
[run] jevcode | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
No API key found. Pick the generator provider:
  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)
Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)
> (setup)
setup         step 0/–
```

**Onboarding wizard, key field, 8×40** (columns 40, rows 8 — the minimum; hint shrinks; 3 wizard rows):

```
────────────────────────────────────────
Jev API key (JEV_API_KEY)
> •••••••••••••••••••••••••••••••••••••
108 · Enter · ⌫ · ^U · Esc
> (setup)
setup   step 0/–
```

**Follow-up budget confirm, 24×80** (5 rows, keys on row 2, Enter inert; pane 12 above it, cut here to 4 for space):

```
─── decisions s7 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~
 (… 9 more pane rows)
┌ follow-up would exceed the session cap ──────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │
└──────────────────────────────────────────────────────────────────────────────┘
> also update the CHANGELOG
idle exit 4   step 7/7 4m12s  run $0.71/2.00 ok  sess $9.58/10.00 critical
```

**Retry row, 12×80** (inside the live region; 1 Hz; spinner frozen while `reducedMotion`):

```
─── decisions s1 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now
last: HTTP 429 free-models-per-min · request-id gen-abc123
(no decisions yet)
(4 spare pane rows omitted)
> _
retrying 2/3  step 0/40 0m26s  run $0.00/2.00 ok  sess $0.00/10.00 ok  ? help
```

**Minimum-size notice, 6×80** (rows < 8: status · notice · composer; transcript keeps flowing above):

```
[step 2] outcome executed: applied edit to src/a.py changed=1: src/a.py
[step 2] judge succeeded=0.91 error_present=0.03 new_info=0.44 tests=none …
[step 3] intent=verify p=0.71 c=0.60
terminal too small (80×6); need 40×8 — transcript continues above
> _
⠹ context   step 3/40 1m02s  run $0.09/2.00 ok
```

**Idle composer with a 6-row draft, 40×80** (composer 6 of 8 allowed; pane 12; 21 dynamic rows):

```
─── timeline s7 ─────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s
      s7  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 8.2s  h 31ms
      s6  ICPPPPPPPPPPPPPPPPPPPPPRXXXXXXXXXXXXXXXJ  total 7.4s  h 24ms
      s5  ICPPPPPPPPPPPPPPPPPPPPPPPPPRRXXXXXXXXXXJ  total 6.9s  h 27ms
      s4  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXJ  total 7.7s  h 29ms
      s3  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXXXXJ  total 7.1s  h 25ms
      s2  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXJ  total 6.4s  h 22ms
      s1  ICCCCCPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 5.9s  h 30ms
(3 spare pane rows omitted)
> Next, make the CLI accept an ISO timestamp with an explicit offset and add
  a regression test for "2026-09-20T12:00:00+02:00". Keep the public signature
  of parse_date unchanged; add a keyword-only argument `assume_utc=True`.
  Update the docstring and CHANGELOG.
  [Pasted #1, 42 lines]
  ↓2
idle exit 4   step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**Live run with streaming, 50×120** (17 dynamic rows, 7 pane rows omitted; status gains the git zone and the Jev sparkline; meter bars need ≥ 140
columns):

```
─── decisions s3 · c~ derived |2p−1| ─────────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
streaming… 1,204 chars
  the timezone. I will make parse_date return an aware datetime by replacing strptime with fromisoformat and
s3 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  "change source files"
s3 intent   can_edit         noul   ████████▏·  0.81  c 0.62~             231ms
s3 intent   can_verify       noul   ███▏······  0.31  c 0.38~             231ms
s3 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~             231ms
s3 context  src/a.py         noul   ███████▊··  0.78  c 0.56~             198ms
s3 context  tests/test_a.py  noul   ██████▏···  0.61  c 0.22~             198ms
(… 7 more pane rows)
> Type to steer the next step…   Esc pauses · Esc Esc aborts · ? help
⠹ propose    step 3/40 1m02s  run $0.09/2.00 ok  sess $0.40/10.00 ok  ⎇ main · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  ? help
```

## 3. Keymap, key contexts and the Ctrl-C / Esc / Ctrl-D state machine

### 3.1 Contexts (A17) and the resolver

One `useInput` + one `usePaste` in `<App>` (A14, A13: no `useFocus`, no `disableFocus` needed because nothing registers). Every key goes through
`resolveKey(ui: KeyState, k: KeyEvent): KeyAction[]` (pure, `src/tui/keys.ts`) where `KeyState = { overlay: OverlayKind; reviewShown: boolean; run:
'none' | 'live' | 'aborting' | 'pausing'; draftEmpty: boolean; cursorRow: 'first' | 'mid' | 'last'; historyOpen: boolean; mode: 'session' |
'one-shot'; armed: { ctrlC?: number; ctrlD?: number; esc?: number; escBuffer?: number } }`. Contexts in precedence order: **Minsize** (rows < 8: only
Ctrl-C/D, Enter, text) · **Overlay** (review, wizard, follow-up, secret, blocking, palette, undo, picker; each consumes its own keys and passes the
rest to the composer only where §3.2 says so) · **Composer** · **Global** (Ctrl-C, Ctrl-D, Ctrl-L, Ctrl-O, Ctrl-Z, F1, `[`/`]` tabs when the composer
is empty). Kitty stays disabled (F2), so `key.super/hyper`, `eventType` never arrive; the resolver still drops `eventType === 'release' | 'repeat'`
for forward compatibility (A5).

### 3.2 Bindings (A8, A6, A7, A11, A19–A24, F4)

| Key(s) as Ink sees them | Composer action | Notes |
| --- | --- | --- |
| `return` (no shift/meta/ctrl, input `\r`) | submit (task, follow-up, steer, `/command`, review note) | re-entrancy guard: ignored while `submitting` (A9); empty draft → no-op |
| `input === '\n'` (Ctrl+J), `return && meta` (Alt+Enter, `ESC \r`), `return && shift` (kitty `13;2u` if ever), trailing `\` + Enter, `input` matching `/^\[27;[2-8];13~$/` | insert newline; the xterm form's text is swallowed | R7; universal set only |
| `ctrl a`/`home`, `ctrl e`/`end` | logical line start/end | |
| `ctrl b`/`leftArrow`, `ctrl f`/`rightArrow` | move by grapheme; `→` at end accepts ghost completion | |
| `meta b`/`ctrl leftArrow`, `meta f`/`ctrl rightArrow` | word back/forward (`Intl.Segmenter` word) | |
| `ctrl k`, `ctrl u` | kill to end / to start of logical line → kill ring | |
| `ctrl w`, `backspace && meta` | kill word back | |
| `meta d`, `delete && meta`, `delete && ctrl` | kill word forward | |
| `ctrl y`, `meta y` | yank, yank-pop | ring 8 entries; survives submit |
| `ctrl t` | transpose graphemes | |
| `input === '\u001f'` (Ctrl+_), `ctrl -` | undo | 100 snapshots; redo `ctrl ^` (`\u001e`) |
| `backspace`, `delete`, `ctrl d` (non-empty) | delete back / forward | Ctrl+H = backspace (indistinguishable) |
| `upArrow`/`downArrow` | move by visual row; on the first/last row: history prev/next; on the first row with steers queued: take the last queued steer back (`engine.unsteer()`) | C22 |
| `ctrl p`/`ctrl n` | history prev/next always | |
| `ctrl r` | reverse-incremental history search in the composer row (`(reverse-i-search) 'par': fix parse_date…`); Ctrl+R again = older; Tab/Right accept; Esc restore draft; Enter submit | A7 |
| `tab`, `tab && shift` | completion: palette/mention accept, else cycle | never focus |
| `/` at column 0 of an empty draft | open palette pre-filled with `/` | A34 |
| `@` anywhere | open mention popup over the engine candidate list | A35 |
| `?` on an empty draft, `f1` | append the help block to `<Static>` (§5.3) | no overlay pane |
| `ctrl o` | append detail items (last decision's full probabilities / recent warnings) to `<Static>`; acknowledges `!n` | A22 |
| `ctrl g` | `$VISUAL`‖`$EDITOR` on a temp file via `suspendTerminal` (§4.8) | A11 |
| `ctrl l` | `instance.clear()` (erase-lines) + re-render; never `ESC[2J` | A8 |
| `ctrl z` (`0x1a`) | suspend (§14.3) | A23 |
| `[`, `]` on an empty draft | cycle pane tabs; `d p t s` on an empty draft select | A44 |
| paste (`usePaste`) | §4.5 | |

### 3.3 Ctrl-C / Esc / Ctrl-D matrix (19 §4 with F5's choices; D2)

States: **S0** idle, draft empty · **S1** idle, draft text · **S2** live, draft empty · **S3** live, draft text · **S4** review shown (`reviewShown`)
· **S5** other overlay (palette, mention, history search, secret gate, undo prompt, follow-up confirm, wizard, blocking pane, picker) · **S6** `run:
'aborting'` (engine `aborting` set) · **S7** `run: 'pausing'` (Esc pressed, waiting for the step boundary). Windows: Ctrl-C 1.5 s, Ctrl-D 800 ms, Esc
Esc 2 s, Esc re-buffer 30 ms (07 §1.5).

| Key | S0 idle·empty | S1 idle·text | S2 live·empty | S3 live·text | S4 review | S5 overlay | S6 aborting | S7 pausing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ctrl-C ×1 | session: toast `press Ctrl-C again to exit`, arm 1.5 s; one-shot: n/a (process already exiting after run:end) | clear draft → history; arm nothing | one-shot: `shutdown('human_abort')` → checkpoint → exit 130; session: `engine.abort('human_abort')` → S6, no exit | clear draft → history (never abort with text present) | decline (`resolve(id,false)`) **and** `engine.abort('human_abort')` → S6 | close overlay (secret gate: cancel; follow-up: cancel; wizard: print fix block, exit 2 when no run exists; picker/palette: close) | `process.exit(130)` immediately after `writeStateSync` (DESIGN §11 invariant, `EngineImpl.abort` second call) | abort now (`engine.abort`) → S6 |
| Ctrl-C ×2 ≤ 1.5 s | unmount → exit 0 | (as S0 after the clear) | (S6 rule) | (S1 rule then S0) | (S6 rule) | — | `process.exit(130)` | (S6) |
| Esc ×1 | no-op (arm Esc Esc 2 s) | arm Esc Esc; no-op otherwise | `engine.pause()` → S7, status `pausing after step N` | arm Esc Esc | decline | close overlay (secret gate: dismiss = cancel send, keep draft; picker/palette/mention/search: close, remember token; wizard: clear field or step back; follow-up: cancel; blocking: no-op) | no-op | no-op (already pausing) |
| Esc ×2 ≤ 2 s (or `escape && meta`) | open the rewind/steer menu (a palette pre-filtered to `/rewind /undo /resume /new`) | clear draft → history | `engine.abort('human_abort')` → S6 | clear draft → history | — | — | — | abort → S6 |
| Ctrl-D | toast `press Ctrl-D again to exit`, arm 800 ms; second press → exit 0 | delete-forward | hint; second press → confirm box `a run is live: [y] abort and exit [n] stay` (Enter inert) | delete-forward | ignored | ignored (palette/mention: close) | ignored | as S2 |
| Enter | submit task/follow-up | submit | no-op | `engine.steer(text)` → queue | ignored (Enter never approves, A40) | overlay-specific (palette: run on perfect match, else submit text + `Unknown command`; secret gate: dismiss; follow-up: inert; wizard: next field) | ignored | steer (queued for the resumed run's seed) |
| `y` | text | text | text (steer draft) | text | approve once | secret gate: send; follow-up: start clamped; blocking: n/a | ignored | text |

Transitions on engine events: `run:start` → S2/S3; `run:end` → S0/S1 (composer reopens, `run: 'none'`); `confirm:request` → `pendingConfirm` set, **S4
only after the 1 s idle deferral with the input queue drained** (A41; keys during the deferral go to the composer as text); `confirm:resolved` → back
to S2/S3. `human_pause` lands as `run:end` (stopReason `human_pause`, exit-4 family) with the epilogue line `paused after step N — Enter a follow-up
or /resume`. Every Ctrl-C while `run: 'aborting'` is `process.exit` (never a hint), so a stuck final checkpoint can always be escaped. One-shot mode
idle states do not exist (the process exits at `run:end`).

**Esc re-buffer.** `key.escape && input === ''` starts a 30 ms timer; a letter/`\r`/arrow arriving inside it is re-dispatched as the Meta chord (`ESC
b`, `ESC \r`, split `ESC [ A` already joined by Ink at ≤ 20 ms); on expiry the Esc action of the current state fires. Cost: a lone Esc acts 50 ms
after the press (07 §1.5 measured 21 ms baseline).

## 4. Composer

### 4.1 TextBuffer model and reducer (A1, 08 §8)

```ts
// src/tui/composer/buffer.ts — pure; ink-free
export interface TextBuffer {
  text: string;                 // logical text; '\n' separates logical lines; tabs already expanded to spaces
  cursor: number;               // UTF-16 index, always on a grapheme boundary (invariant checked in tests)
  killRing: readonly string[];  // ≤ 8, newest last; consecutive kills append (readline)
  killIdx: number | null;       // yank-pop position
  undo: readonly { text: string; cursor: number }[];  // ≤ 100
  redo: readonly { text: string; cursor: number }[];
  coalescing: boolean;          // consecutive single-grapheme inserts share one undo step
  history: { level: number | null; stash: string | null };   // level into history.jsonl view; stash = draft before browsing
  chips: readonly PasteChip[];  // { n, lines, bytes, sha256 }  — bodies live in a useRef Map (§4.5), never here
}
export type BufferAction =
  | { type: 'insert'; text: string; asPaste?: boolean }        // filtered text (§4.6); asPaste = one undo step, one chip
  | { type: 'newline' } | { type: 'backspace' } | { type: 'delete' }
  | { type: 'move'; by: 'grapheme' | 'word' | 'line-start' | 'line-end' | 'row-up' | 'row-down' | 'doc-start' | 'doc-end'; dir: -1 | 1; columns?: number }
  | { type: 'kill'; what: 'to-end' | 'to-start' | 'word-back' | 'word-fwd' }
  | { type: 'yank' } | { type: 'yank-pop' } | { type: 'transpose' }
  | { type: 'undo' } | { type: 'redo' }
  | { type: 'set-text'; text: string; pushUndo: boolean }      // external editor, history recall, unsteer
  | { type: 'clear' }                                          // Ctrl-C / Esc Esc: pushes the draft to history first
  | { type: 'history'; dir: -1 | 1; entries: readonly string[] }
  | { type: 'chip'; chip: PasteChip };
export function reduceBuffer(b: TextBuffer, a: BufferAction): TextBuffer;
export function graphemes(text: string): readonly string[];    // Intl.Segmenter('grapheme'), memoised per logical line
export function wordBoundary(text: string, from: number, dir: -1 | 1): number; // Intl.Segmenter('word') isWordLike
```

Rules: `move`/`backspace`/`delete` are grapheme-wise; word motions use `isWordLike` segments and treat `/`, `-`, `_`, `.` as separators so
`--flag=value` and paths die in one Ctrl+W (06 §4 Claude Code note); `insert` of a single grapheme with `coalescing` extends the last undo entry;
anything else pushes; `set-text` from the external editor pushes once; `clear` pushes the draft into history (`kind: 'prompt'`, unsent) only if
non-empty and not a duplicate of the last entry. Segmenter cost is per logical line, not per document (0.37 ms / 3,240 chars, 08 §8), so a 12,000-char
draft stays under 1 ms per keystroke.

### 4.2 `cellWidth` and layout (A2, C20)

`src/tui/composer/width.ts`: `cellWidth(cluster): 0 | 1 | 2` — (1) zero if every code point matches
`/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v`; (2) `/^\p{RGI_Emoji}$/v` →
2; (3) keycap (`[\d#*]️?⃣`) and ZWJ sequences with ≥ 2 `Extended_Pictographic` → 2; (4) Hangul L+V(+T) → 2; (5) EAW Wide/Fullwidth of the first
visible scalar via `eaw-table.ts` (128 ranges generated at build from `get-east-asian-width@1.7.0`, binary search; ambiguous = narrow).
`stringWidth(s)` = Σ over graphemes. Fixture test against `string-width@8.2.2` over 07 §4's strings plus the fuzzer pool (§19.2). `layoutRows(text,
columns, gutter=2): Row[]` splits on `\n` then soft-wraps by accumulated width, breaking after a space when one exists in the last 20 cells, never
inside a grapheme; `cursorXY(rows, cursor)` returns the row index and the summed width before the cursor. The composer renders exactly
`layout.composer` pre-sliced `<Text wrap="truncate">` rows; `scrollTop = clamp(scrollTop, cursorRow − h + 1, cursorRow)`; gutter `> ` on the first
logical row, ` ` on continuation rows; `↑N`/`↓N` markers replace the gutter of the first/last visible row when rows are hidden (A10).

### 4.3 Cursor (A3)

`useCursor().setCursorPosition({ x: gutter + cursorX, y: frameTop + cursorRow − scrollTop })` is called during render; `frameTop` is the sum of the
dynamic rows above the composer from the same `Layout` object (rule + live + banner + pane + queue + overlay + preview), so cursor and frame can never
disagree. The cursor is hidden (`setCursorPosition(undefined)`) while an overlay collapses the composer, during the review deferral, and in
screen-reader mode Ink keeps it visible by itself. No inverse-block fake cursor. `DECSCUSR` is not sent (07 §2.8: terminal-side preference; avoids one
more thing to restore).

### 4.4 Input filter (A5, A92)

Before `insert`: drop when `key.ctrl || key.meta || key.super || key.hyper` (chords are resolved first, never inserted); drop `eventType`
release/repeat; drop code units `< 0x20` except `\t` (expanded to spaces) and the newline keys; drop `0x7f`; drop CSI-body leak-through matching
`/^\[(\?[\d;]*[a-zA-Z]|[\d;]*[A-Za-z~]|<\d+;\d+;\d+[Mm]|[IO])$/` (`[I`, `[O`, `[24;80R`, `[27;2;13~`, `[?0u`, `[?62;22c`, `[<64;10;5M`); a
multi-code-point chunk with no ESC is text (IME commit) and is inserted whole; `sanitizeStream` (already in `plain.ts`) runs on every insert so C0/C1
never enter the buffer; bidi controls U+202A–202E, U+2066–2069 are stripped, U+2028/2029 become `\n` (A88).

### 4.5 Paste lifecycle (A4, 16 §4.3)

`usePaste(text)` → normalise `\r\n|\r` → `\n`, strip C0/ESC except `\n\t`, NFC → if `lines > 3 || chars > 800` → `chips.set(n, { text, lines, bytes,
sha256 })` in a `useRef<Map<number, PasteBlob>>` and insert the label `[Pasted #n, k lines]` as one grapheme-atomic token (cursor cannot enter it;
Backspace removes it whole and `chips.delete(n)`); else insert as one undo step. Hard cap 1 MiB → toast `paste of 3.2 MB refused (limit 1 MiB); write
it to a file and @-mention it`. A multi-character `useInput` chunk without ESC is paste-like (no timers, C21). At submit: expand chips in order →
`sanitizeStream` → `detectSecrets` gate (§10.2) → if `text.length > 12_000` append the transcript notice `only the first 12,000 characters reach the
generator; @-mention a file for more` (P44/C50) → `engine`/`steer`. Bodies are never in React state, the reducer, an `EngineEvent`, `ui.json`, history
or logs; history stores the label `[Pasted #1, 42 lines]` + redacted first line clipped to 40 chars (F9). An unrestored chip after `--resume` cancels
submission with `remove [Pasted #1] or paste again`.

### 4.6 History (A60)

`~/.jevcode/history.jsonl` lines `{ t, workspace, kind: 'prompt' | 'steer' | 'command', text }` written only through `redactor.redact` after any
`addSecret` of the same submission; 4 KiB/entry; 1,000 entries with atomic rewrite when exceeded; consecutive duplicates dropped; per-workspace view
by default, Ctrl-A in the Ctrl-R search widens; never written for bench/perf, `--no-history`, `JEVCODE_NO_HISTORY=1`, or the wizard's key field.
`/history clear` truncates. Up/Down browse (§3.2) stash the current draft and restore it past the newest entry.

### 4.7 Undo/redo and kill ring

100 snapshots each way; a paste, `set-text`, kill, history recall and external-editor round trip are one step each; consecutive single-grapheme
inserts coalesce until a motion, kill or 2 s idle. Kill ring: 8 entries; consecutive kills (Ctrl+K/Ctrl+U/Ctrl+W/Alt+D with no motion between)
concatenate (readline rule); Alt+Y cycles. The ring survives submit and run boundaries (in-memory only).

### 4.8 External editor (A11)

Ctrl+G: write the draft (chips expanded as their labels) to `<runDir|tmpdir>/jevcode-draft-<pid>.md`, then `await suspendTerminal(() => spawn(editor,
[file], { stdio: 'inherit' }))` where `editor = $VISUAL ?? $EDITOR ?? 'vi'` parsed through `/bin/sh -c` like git does; on return read the file,
`set-text` (one undo step), unlink. Engine events arriving during the suspension are queued by `useEngine` (a `suspended` flag on the bus) and
dispatched after `resume()` because `<Static>` items appended during a suspension are dropped (08 §5). The run keeps going; no back-pressure (Q11
open; a 2-minute edit during a live run is the user's choice).

### 4.9 Secret gate row (A154, §10.2)

Submitting text with a `detectSecrets` hit swaps the overlay to `secret` (1 row): `Looks like this contains a secret (sk-…). Send anyway? y/N`. Only
`y`/`Y` sends; every other key dismisses the row and is handled normally (so Enter cannot send). Dismiss shows the one-frame toast `put it in .env and
refer to it by name`. A dim ` ⚠ secret?` marker sits at the end of the status left zone while the draft has a hit (scan on every change: < 0.001 ms at
2 KB).

## 5. Palette, slash-command grammar, `@` mention and the fuzzy scorer

### 5.1 Grammar (`src/tui/commands/parse.ts`, pure)

```
line     := '/' name (ws arg)* ws?
name     := [a-z][a-z0-9-]*                       // case-insensitive; aliases resolved by the registry
arg      := bare | '"' (esc | [^"\\])* '"' | "'" [^']* "'"
bare     := (esc | [^ \t"'\\])+                    // esc := '\' any
```
Tokeniser errors (`unterminated quote`, `dangling backslash`) are reported as a red toast + `<Static>` item and the draft is kept. After tokenising,
`Command.args` is validated by a per-command `ArgSpec[]` (`{ name, kind: 'enum' | 'number' | 'duration' | 'usd' | 'runId' | 'step' | 'path' | 'text',
values?, optional? }`); a failed spec yields `/budget spend-cap: expected a positive USD amount, got "abc"` and the draft stays. `text` args take the
rest of the line verbatim (`/rename`, `/why`). Argument completion: Tab inside an `enum`/`runId`/`step`/`path` argument runs the same fuzzy scorer
over the spec's candidates (paths → engine candidate list; runIds → folded index; steps → committed steps with `changedFiles`). Enter runs a command
only on an exact name match; otherwise the text is submitted as a prompt and `Unknown command /bx (did you mean /budget?)` is toasted (A34, R18).

### 5.2 Command table (`src/tui/commands/registry.ts`; one typed array feeds dispatcher, palette, help, `docs/COMMANDS.md`)

`during` = allowed while a run is live (`availableDuringTask`); otherwise the palette greys the row and Enter toasts `/undo runs when the run is
idle`.

| Command | Args | during | Semantics (one line) |
| --- | --- | --- | --- |
| `/help [keys\|commands]` | enum? | yes | append the help block (keys grouped by context, commands with one-liners) |
| `/new` | — | no | end the session (index `run:end` already written); next prompt starts a new session in this workspace |
| `/resume [id\|title]`, alias `/sessions` | text? | no | open the picker (§8.4); with an argument continue that run (a stopped run resumes; a finished one seeds a follow-up) |
| `/rename <title>` | text | yes | set the session title (index `rename` line; centre zone) |
| `/pause` | — | yes | `engine.pause()` (= Esc) |
| `/abort` | — | yes | `engine.abort('human_abort')` (= Esc Esc) |
| `/undo [n]` | step? | no | §12.4 |
| `/rewind [step]` | step? | no | §12.4 |
| `/diff [step] [--full] [--all]` | step?, flags | no | §12.5 (human-only) |
| `/plan` | — | yes | append the plan ledger block |
| `/decisions [n] [stage]` | number?, enum? | yes | append the last n decision rows (default 12) |
| `/why <ref\|digit>` | text | yes | append the `/why` block for `s7.risk.plan_mismatch` or a visible pane row digit |
| `/calibration` | — | no | append the reliability block computed from `decisions.jsonl`+`steps.jsonl` of this workspace's runs |
| `/jev` | — | yes | decider model, drift, questions, latency p50/p95, Jev cost |
| `/cost` | — | yes | §9 block |
| `/budget [spend-cap\|session-spend-cap\|max-steps\|max-wall\|max-replans <v>]` | enum, value | yes | §9.4 |
| `/model <id>`, `/provider <name>`, `/mode <m>` | text/enum | yes | apply to the **next** run only; stored in memory; a differing `--model` on `/resume` stays `ConfigError` |
| `/config` | — | yes | append the masked config table with a `source` column and the effective session cap |
| `/login`, `/logout [generator\|jev]` | enum? | yes | wizard field re-entry (§11.4); `saved — applies to the next run` |
| `/trust` | — | no | reopen the trust gate |
| `/theme <dark\|light\|daltonized\|ansi>` | enum | yes | new items only |
| `/copy [last\|proposal\|diff\|draft]` | enum? | yes | §10.5 |
| `/export [file]` | path? | no | §8.7 |
| `/status` | — | yes | run id, session id, step/max, stage, sandbox, workspace, git, stop reason |
| `/errors` | — | yes | append recent warnings/errors as items; acknowledges `!n` |
| `/report` | — | no | write `~/.jevcode/reports/<run-id>/` (§13.6) |
| `/history clear` | enum | yes | truncate `history.jsonl` |
| `/exit`, `/quit` | — | yes (confirms while live) | exit 0 |

Deferred to v1.x with reasons: `/doctor` (CLI `jevcode doctor` first), `/keys` (folded into `/help keys`), `/steer` (Enter already steers), `/cd`
(needs a second trust check), project commands (A63).

### 5.3 Palette and help rendering

Palette rows (≤ 8, in the overlay slot): `▌ /name one-line title arg hint` with the query's matched graphemes bold, `▲/▼ (i/N)` on the last row, label
column ≤ 50 % of the width, "Suggested" (state-relevant: `/resume` after a stop, `/budget` after `spend_cap`, `/login` after 401) first, then score
order; aliases hidden; Esc remembers the token so `/` reopens where it was. `?`/F1/`/help` append a `<Static>` block (≤ 60 lines) grouped by context
with the per-terminal notes (`Shift+Enter needs a keyboard protocol: use Ctrl+J or \ Enter`, `Option as Meta on macOS`) and the ShortHelp for the
current state lives in the status right zone (`? help`, `Tab completes`, `Esc closes`).

### 5.4 `@` mention (A35, A157) and the fuzzy scorer (F17)

`@` opens the mention popup (same overlay rows) over `workspace.listCandidates()` (already in memory; ≤ 5,000 paths typical); results whose query
moved on are dropped; denied paths (`isSecretPath()` + `/credential/i` basename, `.npmrc`, `.pypirc`, `.p12|.pfx|.jks`, `.git/`) are never offered; a
denied path typed in full drops the mention with `.env is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to
override.` Accepted mentions become `@path` tokens; at submit the paths are pinned into the next run's seed as `pinnedFiles` (added to the context
stage's candidates with `mentionsInTask + 1`, still inside the 12-file / 60 KB cap — P8 resolved as "boost, never bypass").

```ts
// src/tui/commands/fuzzy.ts — dependency-free (F17)
export function score(query: string, candidate: string): number | null; // null = no match
// 1. case-fold both; 2. exact prefix → 1000 − len; word-prefix (after / - _ : .) → 900 − len;
// 3. subsequence: +10 per matched char, +15 when the match starts a word, +8 when contiguous with the previous match,
//    −1 per skipped char, −2 per unmatched trailing char; require every query char in order; null otherwise.
export function rank(query: string, candidates: readonly string[], limit = 8): { candidate: string; score: number; spans: [number, number][] }[];
```
Unit test: 5,000 synthetic paths (depth 1–6, 60 % ASCII, 20 % CJK, 20 % emoji-free mixed), 40 queries of 1–12 chars, p95 `rank()` time ≤ 16 ms on the
CI runner; `spans` are grapheme-aligned so bold highlighting cannot split a cluster.

## 6. Review prompt (A39–A42, F6)

### 6.1 Rows

`reviewHeaderLines(req, matchesIntent, n, columns): string[]` in `src/tui/review-lines.ts` (shared by Ink, `--plain`, SR). Full header, 80 columns (8
rows): row 1 title `review step N risk R (bound[ on dim]) <kind> <target> "<goal ≤ 40>"`; row 2 keys `[y] approve [n] decline [d] decline+note [e]
expand [w]1-5 why [esc] decline`; row 3 ruler `dimension lvl 0 ┆ ┆ 1 risk bnd conf Jev's dominant level (why)`; rows 4–7 one gauge per dimension:
`name(13) L<k> <bar10> risk(4) bnd(4) conf(4) level text (truncate)` where the bar is `eighthBlocks(risk × 10)` over a `·` track whose cells 0–2 are
dim, 3–6 yellow, 7–9 red (the ruler `┆` in cells 3 and 7 is the `NO_COLOR` twin); row 8 `matches_intent <bar of p> p noul c~ criteria text`. At 120
columns the ruler gains `P(l) E[k] tail` and each gauge row those three numbers (11 §4b). Truncation order for `n < 8`: 7 → drop the ruler; 6 → drop
`matches_intent`; 5..3 → title, keys, then `n − 2` compact rows carrying two dimensions each (`plan_mismatch L2 r=0.44 tail c=0.61 | destructive L1
r=0.25`), the max dimension first; `n ≤ 2` → title, keys. Preview: `confirmPreviewLines(req)` (today's function) indented two spaces, cut to
`layout.preview` with the last row `…[k more preview lines]`; `e` toggles `expanded` (pane → 0, preview up to the budget) for this request only.

### 6.2 Keys and invariants

`y` approve once · `n`/Esc decline · `d` → overlay stays, the composer row becomes the note field (`note (≤ 600, Enter sends, Esc cancels): _`) →
Enter → `resolve(id, false, note)` · `e` expand/collapse · `w` then `1`–`5` → `/why` block for that dimension (`5` = matches_intent) · Ctrl-C →
decline + abort. Invariants (tests §19): no key other than `y` resolves `true`; Enter is inert on the box; a second `confirm:request` declines the
first (`createTuiConfirmer` today); a non-TTY stdin declines after `confirmTimeoutMs`; `alwaysDecline` unchanged; no remembered approval anywhere;
`--auto-decline` does not exist (P5 closed: no). The box is never shown before the composer has been idle 1 s with the input queue drained (A41);
during the deferral the status left zone reads `review pending…` and typed keys are draft text.

### 6.3 Decline note path

`Confirmer.confirm()` may resolve `boolean | ConfirmVerdict` (§15 item 6). In `EngineImpl.confirm` the result is normalised to `{ approved, note? }`;
in `runStep` the declined reason becomes `declined by reviewer: <risk.reason> — reviewer note: <note>` (note redacted, clipped 600) and
`draft.notes.push( 'reviewer note: <note>')`, so the window entry carries it (`WindowEntry.reason` for the generator, `recent[i].notes` for Jev's next
intent/risk state — P6 resolved: yes, via notes). `confirm:resolved` gains `note?: string` (redacted) so `--plain`/`transcript.log` print `confirm
<id> declined (note: …)` identically (one item, line parity kept).

### 6.4 Plain and screen-reader twins

`--plain` TTY: the readline confirmer prints the header lines (one per dimension) and prompts `[y] approve [n] decline [d] decline+note > `; `d
<note>` on the same line; five invalid answers decline. SR: the box is a numbered list `1 approve 2 decline 3 decline with a note` + `Enter selection
(1-3):` typed digits + Enter, one BEL on open, bars replaced by `risk 0.44 of 1`, no ruler row, no deferral change.

## 7. Jev-native pane, status line, toasts (A43–A50, F16)

### 7.1 Tabs (`src/tui/pane-lines.ts`, `src/tui/Pane.tsx`)

`[`/`]` cycle, `d p t s` select (empty draft only); the active tab and step are on the rule row. Every tab is `lines(state, rows, columns): string[]`
and renders `rows` `<Text wrap="truncate">` rows.

| Tab | Row format at 80 columns | Data |
| --- | --- | --- |
| `d` decisions | `s7 stage(8) id(16) answer(6) bar10 p.pp  c c.cc[~]  [verdict]` — bar = eighth blocks of `probability` on a `·` track; `~` marks derived Noul confidence; 120 columns adds `latencyMs` and the criteria text | `decision` events, last 12 (`DECISIONS_KEPT`) |
| `p` plan ledger | `[x] text(48) sN done_j p.pp` accepted · `[?] … unverified` · `[ ] remaining` · `[!] replan/rejected_claim/stale_plan/human sN: text`; header counts on the rule row | last `plan` event |
| `t` timeline | two rows per step at 80 (`time s7 intent .21s ctx .24s propose 6.1s risk .23s exec 1.2s judge .19s` / `      s7  ICPPPPRXXXJ…  total 8.2s  h 31ms`), one row at 120 with `gen 5.4k $0.032`; letters `I C P R X J` sized `round(ms/total·N)`, N = 40 (80) / 30 (120) | `stage:end`, `step:end.record.timing/usage` |
| `s` synth | two rows: `synth  goal 2/3 test_kth kth.py  site kth.py:12  SEEDS mutation d1 → templates` / `sieve  verify  tested 37/137 ██▋·······  27%  t_run 0.9s x8 lanes  runs 41 jev 3`; until the structured fields exist (A48, coordinated with the synth team) the rows show `phase` and `detail` verbatim plus `candidates`/`tested` | `synth` events |

Below 80 columns probabilities are hidden and verdict words kept (A100). Bars: `eighthBar(p, cells = 10)` = `'█'.repeat(⌊p·cells⌋)` + partial
`[▏▎▍▌▋▊▉]` + `'·'` fill; `--ascii` → `#` and `-`; SR → `aria-label="probability 0.44 of 1"` and the plain row text.

### 7.2 Loop banner (A45)

One row, present only while a signature count ≥ 2 or a replan directive is active: `loop run:pytest -q›exit 1 x2/3 replan 1/5 s6 change_approach p .61
imp .12`; counts are folded in the reducer from `step:end.record.loopSignatures` (reset on `replan` and on `steer:applied`, which resets the
detector). `maxReplans` comes from the extended `run:ready` (§15 item 15).

### 7.3 Status line (A46, 14 §5.1)

Three zones built by `statusLineText(state, columns)`: **left** (≤ 14 cells at 80, ≤ 22 at ≥ 100): mode word (`idle exit 4`, `setup`, `review`,
`pausing`, `paused: jev unreachable`, `retrying 2/3`, `offline`, `disk ×2`, `aborting`), spinner + stage verb while live (`⠹ propose`, `propose
[synth]` kept), `!n` error counter, badges `sandbox: none` (yellow) / `no-net`, ` ⚠ secret?`; **centre** (≥ 100 columns only): run id or `/rename`
title in quotes, only when ≥ 24 cells remain after the right zone; **right**: `step 7/40 4m12s` (the `step N/` sentinel appears on the first frame, so
`perf/first-frame.ts` keeps working) · `run $x/y <word>` · `sess $x/y <word>` · git zone `⎇ main ↑2 · 3~ 1?` at ≥ 100 (≤ 24 cells; ≤ 14 at 80–99;
hidden < 60) · Jev sparkline `jev ▂▃▂▅▂▂▇▃▂▁▂▃` (last 12 requests, fixed 0–1000 ms scale, failed request = space) at ≥ 100 · `? help`/ShortHelp;
10-cell meter bars only at ≥ 140 and tokens `gen 5.5k jev 28k` at ≥ 160 (A46 said 120/140: the F16 git zone and sparkline at ≥ 100 take those cells
first). Drop order when the width is short: help → sparkline → git → session meter → run meter. Level words `ok/half/high/ critical/over/uncapped`
(A131; `EXCEEDED` → `over`). Toasts replace the left zone for 2 s (4 s errors) with `!`/`✓` and are also `<Static>` items (A37). Spinner: braille
frames at 8 fps only while live and no review is pending; `|/-\` under `--ascii`; static `•` under reduced motion with a 1 Hz functional tick; `still
waiting` after 45 s in one stage (A50). 1 Hz idle redraw for the wall clock only.

### 7.4 `/why` and `/calibration` (A47, 11 §4h–4i)

Both are appended `<Static>` items with a multi-line `detail` (≤ 60 lines), computed from `Decision` rows in the reducer (`/why`) or from
`decisions.jsonl` + `steps.jsonl` of this workspace's runs read after the command (`/calibration`, ≤ 200 runs, streamed line by line, never per
frame). `/why` block: header `why <stage>.<id> request <hash> <ms> <model>`, instructions, question type, one bar row per level/option (`L2 █▏········
0.10 skips a planned verification step`), then `argmax`, `E[k]`, `P(k≥3)`, `bound`, `risk`, verdict, confidence formula and the rule that consumed it
(`context: selected (p ≥ 0.5)`). `/calibration` block: label sources, 10 equal-width bins `bin n mean p observed bar`, `ECE`, near-threshold counts
per threshold, sharpness. Plain twins: `jevcode why <run-id> <step> <id>` and `jevcode calibration [--runs-dir]` print the same blocks.

## 8. Sessions, steering, pause, history, export, `--json`

### 8.1 Data model (A52, A55, F7)

`Session = ordered runs in one workspace; sessionId = first run id`. `RunMeta` gains `sessionId`, `parentRunId | null`, `source: 'cli' | 'bench' |
'perf'`, `title?`, `git?`, `instructions: { path, sha256, bytes }[]`. Legacy `run.json` without these fields reads as `{ sessionId: runId,
parentRunId: null, source: 'cli', instructions: [] }` (store `isRunMeta` unchanged; the fields are optional in the type, §15).
`CheckpointEnvelope.version` stays `1`: every new `CheckpointState` field is optional and absent-tolerant (`pendingDirectives`, `undoLog`,
`humanDirective`), exactly like `generatorTokensPerStep` today, so `--resume` of an old run and bench readers are unaffected.

### 8.2 `~/.jevcode/sessions/index.jsonl` (append-only, ≤ 512 B/line, `O_APPEND`, fold by `runId`, torn last line skipped)

```
{ "v":1,"t":iso,"kind":"run:start","sessionId","runId","parentRunId","workspace","task60","mode","source" }
{ "v":1,"t":iso,"kind":"run:end","sessionId","runId","stopReason","steps","costUsd":{"generator","jev"},"wallMs","changedFiles":n,"exitCode" }
{ "v":1,"t":iso,"kind":"rename","sessionId","title60" }
{ "v":1,"t":iso,"kind":"steer"|"undo"|"pause","sessionId","runId","step","text60"?,"files"?:n }
{ "v":1,"t":iso,"kind":"budget","sessionId","setting":"session.spendCapUsd","from","to" }
```
`text60`/`task60`/`title60` pass `redactor.redact` then `clip(oneLine(x), 60)`. Written only for `source === 'cli'`. Concurrency (P11): two
interactive sessions append ≤ 512-byte lines with `O_APPEND` (atomic on POSIX for < PIPE_BUF); no lock file; a torn line is skipped like
`steps.jsonl`. `jevcode sessions reindex` rebuilds from `run.json` + `stat(state.json).mtime`; `jevcode sessions prune --older-than 30d --source cli`
is explicit; no automatic deletion. Folding happens once per session open, `/resume` and `run:end` (A139), never per frame.

### 8.3 Follow-up seeding (10 §15.2; `src/session/seed.ts`, pure)

```ts
export function buildSeed(parent: { runId: string; task: string; state: CheckpointState }, followUp: string, pinned: readonly string[]): EngineSeed {
  const window = parent.state.window.slice(-4).map((e) => ({ ...e, notes: [...e.notes, `from run ${parent.runId}`] }));
  return {
    parentRunId: parent.runId,
    plan: { done: parent.state.plan.done, remaining: parent.state.plan.remaining, unverified: parent.state.plan.unverified, openProblems: [],
            harnessProblems: [{ kind: 'human', step: 0, text: `Follow-up to run ${parent.runId} whose task was "${clip(parent.task, 200)}": ${clip(followUp, 600)}` }] },
    window, createdThisRun: parent.state.createdThisRun, lastTestRun: parent.state.lastTestRun, pinnedFiles: pinned,
  };
}
```
Engine (constructor, non-resume branch): apply the seed (`lastChangeStep = null` so `testsCurrent` recomputes); the new run's `task` is the follow-up
text; the completion Noul judges the new task (P7 resolved: follow-up alone; the original is in the `human` harness problem); Plan rule (b) treats
step 1 of a seeded run as "a directive was issued" (commit: `replan: step === 1 && seeded ? { text: human.text } : …`). Spend, wall, loop detector,
`resolvedJevModel` start fresh. `RunMeta.parentRunId` set; `run:ready` carries `sessionId`/`parentRunId`; the TUI's `<Static>` shows one line `[run]
follow-up of <parentRunId>: plan done 2 · remaining 3 · window 4 entries` (transcript item `transcript`).

### 8.4 Picker (A56, 10 §15.6)

Data: folded index filtered by `workspace` realpath (Ctrl-A widens); `state.json` parsed only for the highlighted row on Space (plan counts, spend,
stop, `interrupted`) plus a 4 KB tail of `transcript.log`; never `steps.jsonl`. Rows `time ago │ steps │ stop (verdict colours + word) │ $cost │
title-or-task60 │ (workspace when widened)`; keys `↑/↓`, `Ctrl-P/N`, PgUp/PgDn, Enter (stopped run → `/resume` flow with the §9 gate; finished run →
follow-up composer seeded from it), Space preview, typing filters (title, task, run id), Ctrl-A, Esc; sort updated (default) / created via `/resume
--sort created`. `-c/--continue` = most recently *used* run (`run:end`/`steer`/`pause` line time) in this workspace; `--resume <id|title>` accepts a
title prefix when unique. The recent-session hint row appears after the first frame. Rename is `/rename`; row delete is deferred (`jevcode sessions
prune`).

### 8.5 Steering: consumption algorithm in the engine (A53, 10 §15.3; exact insertion §15.2)

```
Engine.steer(text): { queued } — text = redact(sanitizeStream(text)).slice(0, 600); if pendingDirectives.length ≥ 8 → { queued: 8, dropped: true } (toast); else push { text, at: nowIso() }; emit steer:queued { step: this.step + 1, index, text }
Engine.unsteer(): string | null — pops the newest pending directive (emits transcript info "steer withdrawn"); null when empty
main() loop, per iteration:  if aborted → finish(classifyAbort)
                             budget = checkBudgets(); if budget → finish(budget)
                             if (this.pauseRequested) → finish('human_pause')                 // rule-1 point, nothing in flight
                             if (this.pendingDirectives.length) applyHumanDirectives(this.step + 1)
                             await runStep()
applyHumanDirectives(step): texts = pendingDirectives.splice(0).map(d => d.text)
   this.plan = { ...this.plan, harnessProblems: [...this.plan.harnessProblems.filter(h => h.kind !== 'human'), ...texts.map(t => ({ kind: 'human', text: t, step }))] }
   this.humanDirective = texts.join('\n')          // consumed by the next draft: promptInput.humanDirective, commonState.human.directive, synthesisContext.directive
   this.detector.resetCounts()                     // a human instruction is a legitimate change of course (10 §15.3)
   emit steer:applied { step, count: texts.length }
newDraft(): draft.humanDirective = this.humanDirective; this.humanDirective = null
commit(): a `human` harness problem expires when superseded (above) or when its step is > 4 steps old
```
This is a second plan mutation point besides commit; it is a §9.1 rule-1 point (no draft exists, the previous commit's snapshot object is immutable),
so DESIGN §11's state-mutation rule is amended to "commit, and step start for human directives". `pendingDirectives` is redacted before it can reach
`state.json` and is checkpointed with the next `writeState`, so a steer typed before a crash survives `--resume`. Jev sees the directive as
`state.human.directive` (600 chars) in every stage's common state for that step (C26/P1 resolved: both Jev and the generator see it; the risk stage
sees it through the same common state). Steering typed while a review box is shown is not possible (composer inactive, §3.3); decline first.

### 8.6 Pause (A54)

`Engine.pause(): void` sets `pauseRequested`; the loop checks it after `checkBudgets` (above), so the in-flight step commits whole (rules 2–3 never
apply: nothing is killed). `StopReason 'human_pause'` (exit-4 family) is resumable exactly like `null` (`storedStopBlocks` returns null for it;
`reconcileResumeConfig` ignores it). Status left zone: `pausing after step N`; `run:end` item `end human_pause steps=N …`; epilogue `paused — /resume
continues, or type a follow-up`. Bench and `--plain` on a pipe never pause (no key can request it).

### 8.7 `/export` and `/theme`

`/export [file]` concatenates the session's runs' `transcript.log` files in order with a header per run (`==== run <id> · <task60> · <stopReason> ·
$cost ====`) to `<file>` or `~/.jevcode/exports/<sessionId>.log`; already redacted at write time; 64 MiB cap with a trailing `… truncated` line.
`/theme` swaps the colour table for new items and the dynamic region only (no `<Static>` remount, R4).

### 8.8 Prompt history and `planAfter`

`history.jsonl`: see §4.6. `StepRecord.planAfter?: Plan` is written at commit (bounded 20 × 200 per list) so `/rewind N` can seed `plan+window` from
step N without replaying drafts (P10 resolved: store it).

### 8.9 `--json` stream (A61, A138, A158, A170, D12)

NDJSON on stdout; first line `{"v":1,"type":"stream:start","schema":"jevcode.events/1","jevcode":"<version>","t":iso}`; every further line is `{
"v":1, "t": iso, "runId": string|null, ...EngineEvent }` — the redacted `EngineEvent` after `config.redact` (configured secrets, `Send
anyway`-confirmed values and recognised formats become `[REDACTED:<name>]` / `[REDACTED:pattern]`), plus `session:start { sessionId, runId,
parentRunId }` and `session:end { reason, exitCode }`. Guarantee wording (DESIGN §10 + `--help`): the stream never contains keystrokes, composer
drafts, pasted payloads or key material; a human turn is one `user` event holding the redacted submitted text; `secret-ack` carries a count only
(P59); an unrecognised-format secret typed inline passes through as in `transcript.log`. Consumers ignore unknown `type`s. `v` increments only on an
incompatible change; additive fields never bump it. No countdown ticks (`retry` carries `waitMs`); no `status` events unless `--json=verbose`.

## 9. Money (A129–A139, F8)

### 9.1 Meter tree

`main.tsx` creates `sessionMeter = createSpendMeter(sessionCapUsd)` once per session (`none` → `+Infinity`, meter word `uncapped` in red); each run
gets `sessionMeter.child(Math.min(runCap, remaining))`; `SpendSnapshot.parentExceeded` and `SpendMeter.parentExceeded()` are added (§15 item 9).
Default session cap = 5 × run cap: $10.00 for the $2.00 default, $1.25 for jev-only's $0.25 run default (resolved in `resolveConfig` after `--mode` is
known; P45). Bench/perf keep their own roots. On `/resume` the session total is folded from the index once, the resumed run's `state.json.spend`
added, then `meter.restore()`.

### 9.2 Thresholds

`budget:warn { scope: 'run' | 'session', pct: 50 | 80 | 95, spentUsd, capUsd, stepsLeftEstimate? }` emitted by the engine (run scope, after
`meter.add`) and by the session layer (session scope), once per threshold per scope, highest only when one `add()` crosses two, re-emitted once with `
(restored)` on resume, never for `+Infinity`. Surfaces: `<Static>` item `[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps
left at $0.040/step`, a 2 s toast (4 s at 95 %), the meter level word, and (opt-in notify) BEL at 95 % / `budget:stop`. `ui.budgetWarnings: false`
mutes toast and BEL only. When Jev outspends the generator at a crossing the item appends ` — Jev is the larger share ($0.031 vs $0.020); see /jev`.

### 9.3 Follow-up confirm and refusal (14 §4.3)

At Enter with `state.done !== null`: `remaining ≥ runCap` → start; `0 < remaining < runCap` → 5-row box (§2.3 frame) with `y` start clamped / `r`
prefill `/budget session-spend-cap <sessionCap + runCap>` / `n` or Esc cancel (draft kept), Enter inert; `remaining ≤ 0` → refuse with the `<Static>`
item + 4 s toast naming `/budget session-spend-cap <usd>` and `/new`. `--plain`/`--json` clamp silently + `budget:clamp`, or exit 4 + `budget:stop {
scope: 'session', at: 'follow-up' }`. `--no-input` clamps silently (C46).

### 9.4 `/budget`

`/budget` alone prints both caps, spends and pending values. `/budget spend-cap <v>` (must exceed the target run's spend) applies to whichever comes
first, the next `/resume` of the stopped run (`run.json.overrides[]` via `reconcileResumeConfig`) or the next new run; never a live run; the pending
value lives in memory only (P46: dies with the process) and `/cost` shows it as `pending`. `/budget session-spend-cap <v>` applies to the root meter
immediately and appends an index `budget` line. `max-steps|max-wall|max-replans` follow the spend-cap rule. The `spend_cap` epilogue in session mode:
`stopped by the run spend cap: $1.532 of $1.500 (over by $0.032, one judge call). Session $4.11/$10.00 ok.` + `continue this run: /budget spend-cap
3.00 then /resume` + `or start a follow-up run with a fresh $1.500 cap`. No 95 % pre-emption (P47: no).

### 9.5 Unpriced pricing fails closed (A135, A136)

`validateGenerator` returns `priced: boolean`; `provider === 'anthropic' && !priced && !allowUnpriced` → refuse to start with `ConfigError` on
`generator.model` (exit 2): `generator.model "<id>" has no pricing entry; set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M, or pass
--allow-unpriced to run under a token cap` (the flag is in the message: gap 32). `--allow-unpriced` → `limits.maxGeneratorTokens` (default
`spendCapUsd / 15 × 1e6`, Q40: conservative), budget kind `token_cap` checked after `spend_cap` in `checkBudgets`, `StopReason 'token_cap'` (exit 4),
figures rendered `$?`; OpenRouter/Jev `null` `usage.cost` → `budget:unpriced` + stop `error unpriced_usage` after the step commits unless
`--allow-unpriced`. `config.warnings` are printed (`jevcode: <warning>` stderr in plain, one `<Static>` item in the TUI). `jevcode config` prints
`session.spendCapUsd $10.000 (default: 5 × limits.spendCapUsd)`. Estimate markers: `~` on table-priced figures, none on provider `usage.cost`, `$?`
under `--allow-unpriced`.

## 10. Secrets at every entry point (A153–A159, F9)

### 10.1 `detectSecrets`

`src/core/redact.ts`: `export interface SecretHit { family: string; label: string; start: number; end: number; warnOnly: boolean }` and `export
function detectSecrets(s: string, exact?: Pick<Redactor, 'redact'>): readonly SecretHit[]` over the six `FORMAT_PATTERNS` (labels `sk-or-…`,
`sk-ant-…`, `sk-proj-…` labelled `OpenAI` (P55), `sk-…`, `AIza…`, `ghp_…`, `github_pat_…`) plus warn-only AWS, Slack, Slack webhook, PEM-with-`PRIVATE
KEY`, JWT, Stripe, `npm_`, `hf_` (regexes of 16 §4.1); `HEADER_PATTERN` excluded; `exact` present and `exact.redact(s) !== s` → a hit labelled `your
<NAME>`. Backtracking guard: 256 KB < 5 ms in a test. Promotion of warn-only families to redacting waits for a week of real `history.jsonl` (C44,
Q35).

### 10.2 Gate and `addSecret`

Every composer submission and steer, in the TUI and the readline composer, passes the gate (§4.9). On `y`: for every non-warn-only hit span ≥
`MIN_SECRET_LENGTH`, `redactor.addSecret('composer#n', span)` **before** the text leaves the composer (PEM: whole block); composer entries capped at
64 with `dropSecret` of the oldest; then the engine receives the raw text (the provider request stays raw by design, A156) and emits `secret-ack {
count }` → transcript item `[turn n] sent 1 secret to the generator on request`. Scope = process: documented as not surviving `--resume` (P56: accept
and document). Non-TTY stdin with a hit → submission cancelled, exit 2. `--no-input` → cancel.

### 10.3 Paste chips and `ui.json`

Chips: §4.5. `ui.json` (checkpoint-adjacent) stores `{ text: redact(draft) with hit spans → [REDACTED:draft], cursor, chips: [{ n, lines, bytes,
sha256 }] }` at checkpoint boundaries and shutdown, never per keystroke; chip bodies never touch disk.

### 10.4 `@` denylist and `--allow-secret-mention`

Denylist: §5.4; `--allow-secret-mention`/`JEVCODE_ALLOW_SECRET_MENTION=1` → per-mention `Attach anyway? y/N`, read through
`Workspace.readSecretForMention` (§15 item 13), every `SECRET_NAME_RE` line `addSecret`'ed as `mention:<KEY>`; the generator's own `read` keeps
`SecretPathError`.

### 10.5 Clipboard (A86)

`/copy [last|proposal|diff|draft]`: payload = `redactor.redact(sanitizeStream(x))`, 64 KiB cap; native tool first (`pbcopy`, `wl-copy`, `xclip
-selection clipboard`, `xsel --clipboard --input`, 2 s timeout), else OSC 52 **write** only behind `--osc52`/`ui.osc52` (tmux DCS wrapper), never OSC
52 read; `/copy draft` reports `copied with 1 secret masked`.

### 10.6 Trace and logs

`JEVCODE_TRACE=<file>` becomes an alias of `JEVCODE_LOG=<file>` at level `trace`; the keystroke line logs `key
kind=<return|backspace|ctrl|escape|arrow|text|paste> len=<n> masked=<bool>` unconditionally — never `input` (13 §4.1 measured a 108-char key
reconstructed from today's line). `usePaste` logs `paste len=<n>` only. Engine `trace()` in `engine.ts` keeps its messages (they carry no key
material) and is routed to the same log.

## 11. Onboarding, credentials, trust, `AGENTS.md` (A113–A128, F10)

### 11.1 Detection

After `firstFrame()`: `config.missingSecrets(mode)` (non-throwing; skips the generator key under `jev-only` and `--mock*`) returns `[]`,
`['generator.apiKey']`, `['decider.apiKey']` or both. Non-TTY/`--plain` pipe/`CI`/ `--no-input`: today's `ConfigError` line + the four-line fix block
(13 §5.8) to stderr, exit 2; the TUI and readline composer open the wizard instead.

### 11.2 Wizard state machine (`src/tui/onboarding/reducer.ts`, pure; the key buffer is a `useRef<string>`)

```
detect ─missing=[]─▶ trust? ─▶ sandbox ─▶ composer
  │ missing≠[]
provider(1 anthropic · 2 openrouter; skipped when the generator key resolves or mode=jev-only)
  ▶ generatorKey(masked; skipped when present)
  ▶ jevKey(masked; "Enter = reuse the OpenRouter key" when provider=openrouter; skipped when present)
  ▶ save(atomic 0600 to ${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json; legacy ~/.config path checked first, XDG preferred, warn once)
  ▶ verify?(explicit y only: OpenRouter GET /api/v1/key $0 · Anthropic GET /v1/models $0 · one Jev decision ~$0.0001 metered; 5 s timeout; n/Enter skips)
  ▶ trust(first interactive run per git root with untrusted inputs) ▶ sandbox(one <Static> line) ▶ composer
```
State holds `{ field: 'generator.apiKey' | 'decider.apiKey', length }` only. Field rules: a multi-char chunk is a paste; `sanitize` = `sanitizeStream`
+ strip all whitespace + NFC; paste never submits, Enter does; `MIN_SECRET_LENGTH` 8 floor; prefix hints warn, never block; Backspace/Delete drop one
code point; Ctrl-U clears; Esc clears or steps back; Ctrl-C prints the fix block and exits 2 when no run exists (else closes the wizard). On submit:
`redactor.addSecret(name, value)` **first**, then `<Static>` `[setup] generator key: entered (sha256:e31150e9) source=wizard`, then clear the ref;
`[setup] saved <path> (mode 0600, dir 0700)`; Windows prints the ACL note instead of chmod (P41). `resolveConfig` re-runs after `saved`. Never
`./.env`, never `./jevcode.json` (A118). The masked field renders `'•'.repeat(min(len, columns − 3))` (`*` under `--ascii`) with `useCursor`; SR:
`aria-label="API key field, N characters entered, hidden"` updated on submit/clear only, one BEL on open and on `saved`.

### 11.3 Trust gate and instruction files (A122, A59, D6)

`~/.jevcode/trust.json` (0600) keyed by the realpath of the git root (or workspace): `{ "<root>": { "trusted": true, "at": iso, "files":
["AGENTS.md@sha256:…"] } }`. Shown when untrusted inputs exist: `AGENTS.md`/`CLAUDE.md` (→ generator system prompt), `./.env` (var count +
secret-looking count), `./jevcode.json` (size); options `1 trust · 2 this session only · 3 don't trust` (`3` = instruction files ignored,
`run.json.instructions = []`, `./.env` still read with a `dotenv: <path>` source line in the item stream — P38/P43 resolved: keep reading, show the
source in the stream). Home directory never persisted. A changed `AGENTS.md` sha256 re-prompts (gap 14). `--trust-workspace` for scripts;
non-interactive: instruction files skipped with one stderr line. `AGENTS.md`: first match walking up from the workspace to the git root, `CLAUDE.md`
fallback, then `~/.config/jevcode/AGENTS.md`; 32 KiB cap; redacted; injected into the generator system prompt only (never Jev state); recorded `{
path, sha256, bytes }`; read once per run after the first frame. `/trust` reopens the gate; `/login` re-enters the wizard at the missing field (the
pane takes rows from the decisions pane first); `jevcode login [--provider …] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]`,
`jevcode logout [--generator] [--jev]`, `jevcode config set <non-secret>`. Shadowing line at every start when env/dotenv holds a different fingerprint
than the file (A120).

### 11.4 Frames — §2.3 (24×80 provider step, 8×40 key field). Trust step at 24×80:

```
────────────────────────────────────────────────────────────────────────────────
Do you trust the files in /Users/x/repo?  (git root; decision stored per repository)
  AGENTS.md (2.1 KiB) → generator system prompt   ./.env (3 vars, 2 secret-looking)
  1  trust   2  this session only   3  don't trust (AGENTS.md ignored; .env still read)
> (setup)
setup         step 0/–
```

## 12. Git state, undo, rewind, diff (A140–A152, F11)

### 12.1 `GitState` and the banner (A140, A141)

Run start: two spawns replace `createWorkspace()`'s four — `git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir
--show-toplevel` and `git status --porcelain=v2 --branch --untracked-files=all -z` (`statusPorcelainV2()` keeps `sub/xy/hH/hI`; never `--abbrev-ref
HEAD`). `GitState` (§15 item 16) lands in `RunMeta.git` (bounded summary, no paths) and in the `workspace` event emitted after
`renderer.attach(engine)` so the bus buffers it. Banner copy (15 §6.1/§6.7, identical in TUI/plain/log): `[run] git main ↑2 · 3 modified · 1 staged ·
1 untracked`, `git detached 7d731c0e · clean`, `git wtbranch (linked worktree of …)`, `git main (unborn, no commits yet) · 2 untracked`, `git main ·
in subdirectory pkg/api/ of the repository`, `git none · not a git repository: changes made by commands are not recoverable, /diff compares against
step pre-images only`, `git none · git not found on PATH`, `… working tree has unmerged paths (u)` (level `warn` only for unmerged). Never a gate,
never a question, never a commit. `--resume` on a different `head` warns (`[run] warning: HEAD was 7d731c0e at run start, now 91ab…`).

### 12.2 Status-line git zone (A142)

`src/tui/useGitHead.ts`: `fs.watch(gitDir, { persistent: false })` filtered on `!filename || filename === 'HEAD'`, 100 ms debounce, then read
`<gitDir>/HEAD` in-process (`ref: refs/heads/x` → branch; 40-hex → 8-char detached; missing ref → unborn). Dirty counts refresh only from the
run-start snapshot and `invalidateCandidates()` after each `run` outcome, plus one re-probe at `run:end` (P51: re-probe at run end, no `/status`
spawn). Watcher error → last value, stop updating. `⎇ main ↑2 · 3~ 1?`, `⎇ 7d731c0e†`, `⎇ main (wt)`, ASCII `br main`; branch truncated by grapheme
keeping the tail after the last `/`.

### 12.3 Pre/post images (A143, A144)

Before `edit|write|patch` execute: `pre/<step>/<sha256(relpath)>` written atomically (skip > 1 MiB, recorded in `skipped`). Before a `run` execute:
copy `snapshotDirty ∪ statusEntries ∪ touched` (in memory, no spawn), cap 200 files / 16 MiB, overflow `skipped: cap`. After commit:
`post/<step>.json` `{ files: { <rel>: { sha256, bytes, mode, source, preImage?, deleted?, created? } }, skipped: [{ path, reason, bytes }] }` hashed
with `node:crypto`, written through `writeFileAtomic` **before** the step's `state.json`; `CheckpointState.undoLog` (≤ 20). Bench readers untouched.

### 12.4 `/undo [n]` and `/rewind <n>` decision table (A145, A146; idle-only, composer idle, all checks before the first write)

| Current file vs `post[N].files[path].sha256` | Decision |
| --- | --- |
| equal | restore |
| missing and `deleted: true` | restore |
| differs and some later step M > N has `post[M].files[path].sha256 === current` | **refuse**: `src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together` |
| differs, no later match | **ask**, default `n`: `src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]` — `y`, `a` all, `s` skip rest, Esc abort (one-row `undo` overlay) |
| symlink / hard link | skip `link` |
| resolves outside `<ws>` or into `.git` | skip `escape` |
| submodule (`sub[0] === 'S'`) | skip `submodule` |

Restore source: pre-image (`writeFileAtomic` with recorded mode) → `unlink` for `created` (+ empty dirs the step created) → `git restore --source=HEAD
--worktree -- <path>` through `runGit` for tracked files a `run` step changed while they had no status entry at step start (never `checkout --`,
`--staged`, `stash`, `reset`, `clean`) → skip `not-recoverable`. Output item `undo step 7: restored 3 files (…), skipped 1 (build/out.txt: not
recoverable — changed by a command, not tracked by git)`; `post/<N>.json` → `post/<N>.undone.json`; `undoLog` appended; index `undo` line; the next
run's seed gets `HarnessProblem { kind: 'human', text: 'human reverted step 7: …' }`. `/rewind <n>` undoes last…n in reverse, stops at the first
refusal, then offers `files / plan+window / both`; `plan+window` seeds the next run from `StepRecord.planAfter` of step n and the window entries `≤
n`. No `/redo` (P54: no), no "restore to HEAD" option (P50: that is `git restore` in the user's shell). Non-git workspace: rules 1–2 only, reason `not
recoverable — no git repository`.

### 12.5 `/diff` (A147, A148, A151)

`/diff` = one appended `<Static>` stat block from `git diff --numstat -z HEAD -- <changedFiles>` (one spawn) plus `git diff --no-index --numstat -z --
/dev/null <f>` per untracked file (first 20; rest listed `?` with sizes); exit 1 from `--no-index` is success; unborn → empty tree `4b825dc…`; letters
`M/A/D/R/?/B/S`, `+n −m`, ≤ 10-cell `+`/`-` bar scaled to the largest row, `†` for paths dirty before the run with the legend `† also modified before
this run`, one row per submodule (`--ignore-submodules=dirty`), row cap 40 (`--all`), path left-truncated by grapheme to `columns − 32`. `/diff
<step>` = pre → post from images with `(changed since)` when the current hash differs. `/diff --full [step]` = unified text (`--color=always -c
core.quotePath=false --no-ext-diff --no-textconv --submodule=short --ignore-submodules=dirty`, > 1 MiB excluded) to `<run>/tmp/diff-<seq>.patch` shown
through `suspendTerminal(spawn( pager))` with `$GIT_PAGER` → `$PAGER` → `less` (`core.pager` never read), `LESS=FRX` only when unset,
`LESSCHARSET=utf-8`; `cat`/no TTY → inline block capped at 400 lines; engine events queued during the suspension and flushed after `resume()`.
Human-only (P53: never feeds the generator). Non-git: per-file `--no-index` when `git` exists, else an in-process LCS line count for files ≤ 1 MiB.
Seatbelt: `ProfileOptions.gitDir/gitCommonDir` allow writes under the realpath'd git dirs when outside `<ws>`; denies move to `<commonDir>/config`,
`<commonDir>/hooks`, `<gitDir>/config.worktree`, `modules/*/config|hooks` (A149).

## 13. Errors, retry, crash, logs, epilogue, exit codes (A160–A171, F12)

### 13.1 Severity → surface (17 §4.1)

| severity | status-zone word | toast | `<Static>` | live region | blocking overlay | log |
| --- | --- | --- | --- | --- | --- | --- |
| info | — | — | dim item | — | — | info |
| notice (self-healing) | `retrying 2/3`, `offline`, `reconnecting` | 2 s `✓ jev back` on heal | only if the chain failed or lasted > 10 s | retry row §13.2 | — | info/warn |
| warning | `!n` until Ctrl+O / `/errors` | 2 s `! <short>` | yellow `warning: …` | — | — | warn |
| error (`fatal:false`) | `!n` | 4 s `! <code>: <short>` | red `error <code>: …` + `request-id` | — | — | error |
| blocking | `paused: <reason>` | — | red on entry, dim on resolve | — | ≤ 4 rows in the overlay slot | error |
| fatal | `done error` | — | `[run] end error …` | cleared | — | error + epilogue |

### 13.2 Retry row and pacing

`AskOptions.onRetry`/`GenerateOptions.onRetry` (consumed at `client.ts` before `sleep(waitMs)` and in `withRetry` before `deps.sleep(delay)`) →
`retry` / `retry:settled` events (§15 item 15). Row (inside live ≤ 2): `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After) [r] retry
now`; second row only when the cause changed. 1 Hz tick owned by the reducer hook, cleared on `retry:settled` in the same action; spinner keeps 8 fps
only while `reducedMotion` is off; `Retry-After` capped at 60 s. `r` → `engine.retryNow()` (§15 item 4) which resolves the current retry sleep early
through `sleepUntil(ms, { signal, wake })` in `core/time.ts`. Esc during a retry = pause at the next boundary. Session mode only: after **one**
exhausted chain with zero actions executed in the step, discard the step and enter `paused: jev unreachable` (blocking overlay `retrying in 30 s
(auto, doubles to 5 min) · [r] now [q] stop`); bench and `--plain` on a pipe keep three failures → exit 5 (A165, P61). Spend-cap 429 / OpenRouter 402
→ blocking `provider: spend limit reached — "<msg>" · [q] stop (exit 5)`, no auto-retry. Network `cause.code` → copy `offline: DNS lookup failed for
<host>` etc. (host only); `notice online` → `✓ network back`; never a probe.

### 13.3 401/403, drift, sandbox, disk

First-call 401/403 on either side → stop with exit 2 and the blocking pane `jev: key rejected (HTTP 401 — "…") / Set the decider key and retry.
Consulted: <sources> / The key is never printed or logged. / [r] retry with the current key [l] /login [q] stop (exit 2)`; a later 401 → blocking
pause. First-call drift → exit 2 with `[p] pin --jev-model <served> for the next run`; later drift → warning + toast. `seatbelt` requested but
unavailable → blocking in session mode (exit 6 one-shot). Disk errors (`ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE`) in `persist()`/commit → `notice
checkpoint:degraded` once per (file, code), `disk ×N` word, pause at the boundary with `checkpoint degraded: ENOSPC on … / state.json could not be
written since step 1 — the run cannot be resumed from here. / [r] retry the write [c] continue without checkpoints [q] stop now (exit 3)`; `[c]` sets
`checkpointDegraded` so a later `complete` exits 3 and the epilogue says `state.json missing — not resumable`. Never `process.exit` from the disk
path.

### 13.4 `PaneBoundary` and `fatalExit`

`class PaneBoundary` wraps each dynamic pane (`live`, `Pane`, `Overlay`, `Composer`, `StatusLine`) and the `<Static>` child renderer; fallback one row
`ui: decisions pane failed to render (TypeError) — run continues; details in <log>`; a failed `Overlay` holding a review **declines** it; a failed
`StatusLine` falls back to `formatStatusLine`; a failed `Composer` falls back to a single-row plain input so keys still work; `componentDidCatch` logs
to `jevcode.log`. `JEVCODE_FAULT=render:<pane>` throws once. `fatalExit` order: (1) `process.exitCode = err.exitCode`, idempotent guard; (2)
synchronous terminal restore `stdin.setRawMode(false)` + `fs.writeSync(1, RESTORE)` (§14.2) before anything is printed; (3) `engine?.abort('error')`
so the `'exit'` handler writes `state.json` synchronously, then `renderer.unmount()` raced with 2 s; (4) epilogue via `fs.writeSync(2, …)`, then
`process.exit(process.exitCode)`; `JEVCODE_DEBUG=1` appends the stack after the block. SIGHUP/EIO/EPIPE: `'error'` listeners on stdin/stdout/stderr
installed first; on `'end'`/SIGHUP write the checkpoint, skip the epilogue, exit 129.

### 13.5 Epilogue and exit codes

Epilogue (one-shot: stderr after unmount; session: a `<Static>` item at every `run:end`, printed to stderr only when the process exits):
```
jevcode: stopped — jev_http: Jev HTTP 429: Rate limit exceeded (exit 5)
  run       20260920-191506-5gnampki
  files     ~/.jevcode/runs/20260920-191506-5gnampki/  (transcript.log, state.json, jevcode.log)
  resume    jevcode run --resume 20260920-191506-5gnampki        | state.json missing — not resumable
  report    jevcode report 20260920-191506-5gnampki   (redacted bundle written locally; nothing is sent)
```

| situation | one-shot | session (process outlives runs) |
| --- | --- | --- |
| complete | 0 | item `exit 0` |
| budget / directive / `human_pause` / `token_cap` | 4 | item `exit 4` |
| ConfigError/usage at launch | 2 | 2 |
| first-call 401/403, first-call drift, unpriced refusal | **2** | pane → `[q]` item `exit 2` |
| API failure after retries, spend-limit `[q]` | 5 | item `exit 5` |
| checkpoint degraded and stop / `--resume` unusable | **3** | item `exit 3` + not-resumable notice |
| sandbox/path abort | 6 | item `exit 6` |
| Ctrl-C ×2 / SIGINT | 130 | 130 |
| SIGTERM | 143 | 143 |
| SIGHUP / EIO | 129 | 129 |
| uncaught / render fault escalated | 1 | 1 |
| `/exit`, Ctrl-D ×2, Ctrl-C ×2 idle | — | **0 always** (`--exit-code=last-run` opt-in) |

`exitCodeFor(stop, error, degraded)` becomes a pure function in `stop.ts` with `degraded → 3`; `main.tsx`'s private copy is deleted.

### 13.6 Logs and `jevcode report`

`<runDir>/jevcode.log` (`JEVCODE_LOG` override; fallback `~/.jevcode/logs/jevcode-<pid>-<stamp>.log`, newest 10 kept) with levels
`error|warn|info|debug|trace`, default `info`; `--verbose`/`JEVCODE_LOG_LEVEL=debug` to the file only; key=value lines ≤ 512 chars through `redact`;
`warn`+ `appendFileSync`, `info`− through a 250 ms buffer flushed synchronously in the `'exit'` handler; 8 MiB cap with one rotation; write failures
swallowed; never stdout/stderr while Ink is mounted (`patchConsole: false` kept, `console.*` routed to the log). Failed retries are not persisted in
`jev.jsonl` (P64: no). `jevcode report <id>` / `/report` writes `~/.jevcode/reports/<id>/` with `run.json`, `transcript.log`, `jevcode.log`, last 20
`steps.jsonl` rows, `jevcode config --json`, `versions.txt`, `README.txt`; request bodies only with `--include-requests`; nothing is sent.

## 14. Terminal posture and hygiene (A77–A97, F2, D13)

### 14.1 Posture table

| Item | v1 |
| --- | --- |
| Keyboard protocol | `kittyKeyboard: { mode: 'disabled' }`; universal newline keys; xterm `CSI 27;m;13~` swallowed as newline; no tmux `CSI > 4 ; 2 m` (deferred with the handshake) |
| Queries | none before or after the first frame (no `CSI ? u`, no DA1, no OSC 11, no XTVERSION); tmux's 500 ms Esc floor never triggered by JevCode (A112) |
| Rendering | standard log-update; `--render-mode incremental` opt-in; `maxFps` 30, `--fps`, 15 under `SSH_TTY`/`SSH_CONNECTION`; 50 ms coalescer kept; `<Static>` soft cap 20,000 items with a keyed remount that drops the array (A28) |
| Colour | `NO_COLOR` → `FORCE_COLOR=0` in `bin/jevcode.js` (present) + a first-position side-effect import in `main.tsx` for tests; ANSI-16 named colours; marker/word beside every colour; no backgrounds; `--theme dark\|light\|daltonized\|ansi` (daltonized swaps red↔blue pairs for review/block); `--no-color` flag |
| Unicode | gate `TERM !== 'linux'` && UTF-8 locale (POSIX) / allow-list (Windows); `--ascii`/`JEVCODE_ASCII=1`/auto on `TERM=dumb`; glyph table `─→-`, `⎇→br`, `✓ ✗ ↑ ↓ → + x ^ v`, eighth blocks → `#`/`-`, spinner `\|/-\` |
| Mouse, alt screen, title, hyperlinks | none, none, `--title` opt-in (`OSC 2 ; jevcode: <task head> ST`, cleared on exit), none (OSC 8 deferred) |
| Notifications | `--notify`/`ui.notify` default off (on in SR); BEL, OSC 9 (iTerm2/Ghostty/WezTerm/foot), OSC 99 (kitty), tmux DCS passthrough; review timer starts when the deferred box appears, restarts on keystrokes, fires at ~6 s; run-end timer 60 s; also 95 % and `budget:stop` |
| Sizes | `useWindowSize()` only; 0×0 pty → Ink's 80×24; `MIN 40×8` notice; resize debounce 50 ms trailing (C23), budget recomputed from the same `rows` Ink uses, scrollback never rewritten |
| Slow links | fps 15, coalescer 50 ms, no queries; mosh treated as unsupported for OSC 52/1004/kitty/2026 |
| IME | multi-code-point chunk without ESC = text; grapheme cursor; no Alt inference from `å`-style text |

### 14.2 Exit/restore string and signal handling (A80, A81, A23)

`RESTORE = '\x1b[?2004l\x1b[?2026l\x1b[?25h\x1b[0m'` (+ `'\x1b[<u'` only if kitty is ever pushed; never `ESC c`, never `ESC[2J`), followed by `\r\n`
when the cursor is mid-line, written once by an idempotent `restoreTerminal()` called from `fatalExit`, SIGTSTP, SIGHUP and after `unmount()`;
`stdin.setRawMode(false)` synchronously in the `'exit'` handler. SIGINT/SIGTERM listeners stay registered (external kills → `shutdown('signal')`,
130/143). **Ctrl+Z:** `0x1a` → `const s = await suspendTerminal(); process.once('SIGCONT', () => void s.resume()); process.kill(process.pid,
'SIGTSTP')`; on `SIGCONT` also re-apply raw mode on the next stdin chunk (Codex's shell race) and force one repaint; a self-sent SIGTSTP that does not
stop the process (orphaned group, 12 §10.1) is detected by a 100 ms timer that simply resumes. **SIGWINCH storms:** 30 events → one layout recompute
after 50 ms; Ink's own per-event render is bounded by `maxFps`. **Screen reader:** `--screen-reader` > `JEVCODE_SCREEN_READER` > `ui.screenReader`
(also `INK_SCREEN_READER`) → `isScreenReaderEnabled`, `[screen reader mode: on via flag]` first line, `aria-hidden` spinner, status label changes only
on stage transitions, live region off, numbered review, one BEL. **Reduced motion:** `--no-animation`/`JEVCODE_REDUCED_MOTION`/`ui.reducedMotion`
(implied by SR): static marker, 1 Hz functional tick, `LIVE_FLUSH_MS` 250; a unit test greps `src/tui/**` for `setInterval(` outside `spinner.ts` and
`retry.ts`. **Tiny terminals:** §2 (`minsize`). **tmux/VS Code/Terminal.app quirks:** 16 named colours inside tmux; `TERM_PROGRAM=vscode` without
`TERM` → colour by `FORCE_COLOR` only; Terminal.app OSC 52 dropped → native `pbcopy` first; VS Code's kitty default (≥ 1.110) is irrelevant while the
protocol is disabled (A111: never gate on versions).

## 15. Engine and core contract additions (ordered, additive, exact signatures against `src/core/types.ts`)

Contract version note in `types.ts` header: `contract 1.1 (2026-09-20): additive TUI/session extensions; every new field optional or defaulted;
CheckpointEnvelope.version stays 1`.

```ts
// 1  StopReason (types.ts ~L202) — two members
export type StopReason = 'complete' | 'max_steps' | 'spend_cap' | 'wall_time' | 'max_replans' | 'human_abort' | 'signal'
  | 'replan_stop' | 'impossible' | 'generator_done' | 'error' | 'human_pause' | 'token_cap';
// BenchStopReason = StopReason | 'not_run' follows automatically; stop.ts BUDGET_STOP_REASONS += both; exitCodeFor → 4 for both.

// 2  HarnessProblemKind (~L80)
export type HarnessProblemKind = 'replan' | 'rejected_claim' | 'stale_plan' | 'human';

// 3  Engine (~L860) — four methods
export interface Engine {
  readonly runId: string; readonly events: EngineEmitter; readonly signal: AbortSignal;
  run(): Promise<RunResult>; abort(reason: 'human_abort' | 'signal'): void; status(): EngineStatus; snapshotState(): CheckpointState | null;
  /** queue a human directive for the next step start (max 8 × 600 chars, redacted); `dropped` when the queue was full */
  steer(text: string): { queued: number; dropped: boolean };
  /** withdraw the newest queued directive; null when none */
  unsteer(): string | null;
  /** stop at the next step boundary with StopReason 'human_pause'; idempotent */
  pause(): void;
  /** end the current retry sleep early (F12 `[r]`); false when no retry sleep is active */
  retryNow(): boolean;
}

// 4  EngineOptions (~L700) — seed and human directive
export interface EngineSeed {
  parentRunId: string;
  plan: Plan;                              // done/remaining/unverified verbatim; openProblems []; harnessProblems = [human]
  window: WindowEntry[];                   // last 4 of the parent, notes += 'from run <id>'
  createdThisRun: string[];
  lastTestRun: LastTestRun | null;
  pinnedFiles?: string[];                  // @-mentions: boosted into the context candidates, never past the caps
}
export interface EngineOptions { /* …existing… */
  seed?: EngineSeed;
  /** a directive present from step 1 (e.g. `/undo` note); consumed like a queued steer */
  humanDirective?: string;
  /** session identity written to run.json (default: sessionId = runId, source 'cli') */
  session?: { sessionId: string; source: 'cli' | 'bench' | 'perf'; title?: string };
  /** run-start git probe result (from workspace/gitstate.ts) for run.json and the `workspace` event */
  git?: GitState;
  instructions?: { path: string; sha256: string; bytes: number; text: string }[];
}

// 5  CheckpointState (~L560) — optional, absent-tolerant
export interface PendingDirective { text: string; at: string }
export interface UndoLogEntry { at: string; step: number; restored: string[]; skipped: { path: string; reason: string }[] }
export interface CheckpointState { /* …existing… */
  pendingDirectives?: PendingDirective[];  // ≤ 8
  humanDirective?: string | null;          // consumed by the next draft after a resume
  undoLog?: UndoLogEntry[];                // ≤ 20
  checkpointDegraded?: boolean;
}

// 6  Confirmer (~L456) — verdict with note (boolean still accepted; alwaysDecline unchanged)
export interface ConfirmVerdict { approved: boolean; note?: string }
export interface Confirmer { confirm(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<boolean | ConfirmVerdict>; readonly identity: string }

// 7  StepRecord (~L296)
export interface StepRecord { /* …existing… */ planAfter?: Plan }

// 8  RunMeta (~L590)
export interface RunMeta { /* …existing… */
  sessionId?: string; parentRunId?: string | null; source?: 'cli' | 'bench' | 'perf'; title?: string;
  git?: GitStateSummary; instructions?: { path: string; sha256: string; bytes: number }[];
}

// 9  Spend (~L468)
export interface SpendSnapshot { /* …existing… */ parentExceeded: boolean }
export interface SpendMeter { /* …existing… */ parentExceeded(): boolean }

// 10 Retry plumbing (~L400, ~L440)
export interface RetryInfo { attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean;
  cause: { kind: 'http' | 'network' | 'timeout' | 'invalid' | 'stream'; status: number | null; code: string | null; message: string } }
export interface AskOptions { signal: AbortSignal; stage: StageName; step: number; onRetry?: (info: RetryInfo) => void; wake?: AbortSignal }
export interface GenerateOptions { /* …existing… */ onRetry?: (info: RetryInfo) => void; wake?: AbortSignal }
export interface SerializedError { name: string; code: string; message: string; exitCode: number; status?: number; retryable?: boolean; side?: 'jev' | 'generator'; requestId?: string | null }

// 11 ResolvedConfig (~L940)
export type SecretSettingName = 'generator.apiKey' | 'decider.apiKey';
export interface ResolvedConfig { /* …existing… */
  missingSecrets(mode: EngineMode): readonly SecretSettingName[];
  addSecret(name: string, value: string): boolean;
  dropSecret(name: string): boolean;
  readonly sessionSpendCapUsd: number;     // +Infinity for 'none'
  readonly ui: UiConfig;                   // §16
}
// core/redact.ts Redactor: + dropSecret(name: string): boolean; + detectSecrets export (§10.1)

// 12 GitState (new)
export interface GitState {
  repo: boolean; reason?: 'not-a-repo' | 'git-missing' | 'bare' | 'timeout';
  head: { branch: string | null; oid: string | null; detached: boolean; unborn: boolean } | null;
  upstream: { name: string; ahead: number; behind: number } | null;
  gitDir: string | null; commonDir: string | null; topLevel: string | null; prefix: string; linkedWorktree: boolean;
  dirtyAtStart: { modified: number; staged: number; untracked: number; unmerged: number; submodules: number };
}
export type GitStateSummary = Omit<GitState, 'gitDir' | 'commonDir' | 'topLevel'>;

// 13 Workspace (~L520) — mention-only read behind --allow-secret-mention
export interface Workspace { /* …existing… */ readSecretForMention?(path: string, maxBytes: number): Promise<FileView> }

// 14 SandboxCreateOptions / ProfileOptions (~L1060; sandbox/seatbelt.ts)
export interface SandboxCreateOptions { /* …existing… */ gitDir?: string; gitCommonDir?: string }

// 15 EngineEvent (~L800) — new members and extended existing ones
  | { type: 'run:ready'; runId: string; step: number; maxSteps: number; maxReplans: number; task: string; resumed: boolean; sessionId: string; parentRunId: string | null; sandbox: SandboxLevel; noNetwork: boolean }
  | { type: 'run:end'; result: RunResult; exitCode: number; resumable: boolean; paths: { runDir: string; transcript: string; log: string } }
  | { type: 'confirm:resolved'; step: number; id: string; approved: boolean; aborted: boolean; note?: string }
  | { type: 'steer:queued'; step: number; index: number; text: string }
  | { type: 'steer:applied'; step: number; count: number }
  | { type: 'budget:warn'; scope: 'run' | 'session'; pct: 50 | 80 | 95; spentUsd: number; capUsd: number; stepsLeftEstimate: number | null; restored: boolean }
  | { type: 'budget:stop'; scope: 'run' | 'session'; by: 'run' | 'session' | 'token'; spentUsd: number; capUsd: number; step: number; at: 'step_start' | 'before_execute' | 'follow-up'; raise: { command: string; flag: string; minimum: number } }
  | { type: 'budget:clamp'; runCapUsd: number; clampedTo: number; remainingUsd: number }
  | { type: 'budget:override'; setting: string; from: string; to: string; appliesTo: 'resume' | 'next-run' | 'session' }
  | { type: 'budget:unpriced'; side: 'generator' | 'jev'; model: string }
  | { type: 'retry'; side: 'jev' | 'generator'; step: number | null; stage: StageName | null; info: RetryInfo }
  | { type: 'retry:settled'; side: 'jev' | 'generator'; step: number | null; attempts: number; ok: boolean; totalWaitMs: number }
  | { type: 'notice'; step: number | null; kind: 'offline' | 'online' | 'checkpoint:degraded' | 'checkpoint:restored' | 'sandbox' | 'drift' | 'paused' | 'pricing'; text: string; detail?: Json }
  | { type: 'workspace'; git: GitState; instructions: { path: string; sha256: string; bytes: number }[] }
  | { type: 'secret-ack'; step: number | null; count: number }
  | { type: 'user'; step: number | null; kind: 'prompt' | 'follow-up' | 'steer'; text: string }   // the redacted human turn, one transcript line `you: …`

// 16 Prompts / state (provider/prompts.ts, loop/state.ts)
export interface PromptInput { /* …existing… */ humanDirective?: string | null; pinnedFiles?: readonly string[] }
export interface CommonStateInput { /* …existing… */ human?: { directive: string | null } }   // → state.human.directive (clip 600)

// 17 Renderer (~L880)
export interface RendererOptions { /* …existing… */
  mode?: 'one-shot' | 'session';
  ui?: UiConfig;
  session?: { onSubmit(text: string, kind: 'prompt' | 'follow-up' | 'command'): void; onExit(code: number): void; index: SessionIndexReader; history: HistoryStore | null };
}
export interface Renderer { /* …existing… */ attach(engine: Engine): void; detach?(): void; notify?(item: TranscriptItem): void }

// 18 TranscriptKind (tui/plain.ts) += 'user' | 'steer:queued' | 'steer:applied' | 'budget' | 'notice' | 'workspace' | 'secret-ack' | 'undo' | 'why' | 'calibration' | 'help' | 'diff' | 'cost' | 'epilogue'
// 19 loop/loopdetect.ts LoopDetector += resetCounts(): void
// 20 core/time.ts += sleepUntil(ms: number, opts: { signal?: AbortSignal; wake?: AbortSignal }): Promise<void>  (resolves on wake, rejects on signal)
```

### 15.2 Insertion points

| File | Where | Change |
| --- | --- | --- |
| `loop/engine.ts` constructor (L372–L445) | non-resume branch | apply `opts.seed` (plan/window/createdThisRun/lastTestRun, `lastChangeStep = null`, `seeded = true`); `pendingDirectives`/`humanDirective`/`undoLog` restored from `s.*` on resume; `opts.humanDirective` → `pendingDirectives.push` |
| `engine.ts main()` (L545–L575) | after `checkBudgets` null, before `runStep()` | `if (this.pauseRequested) return this.finish('human_pause'); if (this.pendingDirectives.length) this.applyHumanDirectives(this.step + 1);` |
| `engine.ts` class body | new methods | `steer/unsteer/pause/retryNow/applyHumanDirectives`; `budgetInput` adds `token_cap` inputs; `emitBudgetWarn()` after each `meter.add` in `askRecorded`/`generate` |
| `engine.ts newDraft()` (L672) | | `humanDirective: this.humanDirective` then `this.humanDirective = null` |
| `engine.ts confirm()` (L1123) | result normalisation | `const v = typeof r === 'boolean' ? { approved: r } : r;` emit `confirm:resolved` with `note`; return `v` |
| `engine.ts runStep()` (L1000–L1012) | declined branch | reason `+ (note ? ` — reviewer note: ${redact(clip(note, 600))}` : '')`; `draft.notes.push(…)` |
| `engine.ts commonState()` (L1141) | `buildCommonState({...})` | `human: { directive: draft?.humanDirective ?? null }` |
| `engine.ts promptInput()` (L1168) | return | `humanDirective: draft.humanDirective, pinnedFiles: this.opts.seed?.pinnedFiles ?? []` |
| `engine.ts synthesisContext()` (L837) | `directive:` | `[draft.directive?.text, draft.humanDirective].filter(Boolean).join('\n') || null` (src/synth untouched) |
| `engine.ts commit()` (L1300) | `applyPlanDraft` | `replan: draft.directive ? {…} : step === 1 && this.seeded ? { text: human.text } : null`; expire `human` problems older than 4 steps; `record.planAfter = plan`; write `post/<step>.json` via `images.ts` before `writeState` |
| `engine.ts askRecorded()`/`generate()` (L779, L913) | `AskOptions`/`GenerateOptions` | `onRetry: (info) => this.emit({ type: 'retry', … })`, `wake: this.retryWake.signal`; settle events in `finally` |
| `engine.ts main()` | after `run:ready` | `emit({ type: 'workspace', git, instructions })` (bus buffers until attach) |
| `engine.ts finish()` (L1463) | `run:end` | `exitCode: exitCodeFor(reason, error, this.checkpointDegraded)`, `resumable`, `paths` |
| `provider/prompts.ts hintsSection()` (L157) | after the replan directive line | `if (input.humanDirective) lines.push(\`Instruction from the human for this step: ${clip(input.humanDirective, 600)}\`)`; `planSection` prints `[human, step N]` items through the existing `harnessProblems` list |
| `loop/state.ts buildCommonState()` (L131) | `state` | `human: { directive: input.human?.directive ? clip(input.human.directive, 600) : null }` |
| `jev/client.ts ask()` (L351–L353) | before `sleep` | `opts.onRetry?.({ attempt: httpAttempts, maxAttempts: JEV_RETRY.attempts, waitMs, retryAfter: err.retryAfterMs !== null, cause })`; `await sleepUntil(waitMs, { signal: opts.signal, wake: opts.wake })` |
| `provider/sse.ts withRetry()` (L299–L302) | before `deps.sleep` | same shape with `MAX_ATTEMPTS`; `deps.sleep` → `sleepUntil` |
| `spend/meter.ts` | snapshot/interface | `parentExceeded` |
| `config/resolve.ts` | return object | `missingSecrets`, `addSecret`/`dropSecret` (delegating to the redactor), `sessionSpendCapUsd`, `ui` (§16); XDG path in the config-file candidates (`${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` before the legacy `~/.config` path) |
| `config/validate.ts validateGenerator()` (L96) | return | `priced` + fail-closed rule (§9.5) |
| `cli/args.ts` | `COMMANDS`, `FLAGS` | commands `chat`, `login`, `logout`, `sessions`, `report`, `completion`, `upgrade`, `why`, `calibration`; flags of §16; `-c/--continue`, `--list-sessions`, `--json`, `--no-input`, `--trust-workspace`, `--allow-unpriced`, `--allow-secret-mention`, `--no-history`, `--theme`, `--fps`, `--render-mode`, `--ascii`, `--title`, `--screen-reader`, `--no-animation`, `--notify`, `--osc52`, `--session-spend-cap`, `--max-generator-tokens`, `--verbose`, `--log`, `--log-level`, `--exit-code`, `--no-color`; bare argv → `chat` |
| `cli/main.tsx` | `commandRun` → `commandChat`/`commandRun` sharing `runOnce()` | session loop (§1); `exitCodeFor` from `stop.ts`; `fatalExit` re-ordered (§13.4); `resolveConfig` after `firstFrame()` (unchanged); jev-only path unchanged |
| `tui/plain.ts` | `createPlainRenderer` | readline composer on a TTY (`terminal: true`, history, `dispatchCommand`), `--json` writer, new item kinds |

### 15.3 jev-only preservation checklist (tested by `engine-jev-only.test.ts` additions)

`synth` event → exactly one transcript line (`synthText`) and the live-region line; `propose [synth]` status marker; `main.tsx`: `NullProvider` +
`createSynthesizer({ decider, redact })`, `config.generator()` never called under `--mode jev-only`; `SynthesisContext.directive` receives the human
directive through the existing field, no other `SynthesisContext` change; `src/synth/**` untouched; `transcript.log`, `--plain` and the TUI `<Static>`
rows stay line-for-line identical (`itemsFromEvent` is the only item source; new kinds are new events, never edits); the `s` synth tab renders
`detail` verbatim until the structured fields land.

## 16. Config schema (`ui.*` and `limits`; precedence flag > env > `./.env` > `<OPEN_ASSIST_PATH>/.env` > file > default; sources shown by `jevcode config`; non-secret `jevcode config set`)

| Setting | Flag | Env | File key | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `ui.theme` | `--theme dark\|light\|daltonized\|ansi` | `JEVCODE_THEME` | `theme` | `dark` | no auto-detect |
| `ui.fps` | `--fps <n>` | `JEVCODE_FPS` | `fps` | `30`; `15` when `SSH_TTY`/`SSH_CONNECTION` | 1..60 |
| `ui.renderMode` | `--render-mode standard\|incremental` | `JEVCODE_RENDER_MODE` | `renderMode` | `standard` | |
| `ui.ascii` | `--ascii` | `JEVCODE_ASCII` | `ascii` | auto (`TERM=dumb`, non-UTF-8 locale) | |
| `ui.title` | `--title` | `JEVCODE_TITLE` | `title` | `false` | |
| `ui.screenReader` | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | `screenReader` | `false` | `=0` overrides |
| `ui.reducedMotion` | `--no-animation` | `JEVCODE_REDUCED_MOTION` | `reducedMotion` | `false`; `true` under SR | |
| `ui.notify` | `--notify` | `JEVCODE_NOTIFY` | `notify` | `false`; `true` under SR | |
| `ui.osc52` | `--osc52` | `JEVCODE_OSC52` | `osc52` | `false` | write only |
| `ui.history` | `--no-history` | `JEVCODE_NO_HISTORY` | `history` | `true` | |
| `ui.noInput` | `--no-input` | `JEVCODE_NO_INPUT` | — | `false` | suppresses wizard, trust, follow-up confirm (clamp), secret gate (cancel), reviews (decline) |
| `ui.trustWorkspace` | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | — | `false` | scripts only |
| `ui.budgetWarnings` | — | `JEVCODE_BUDGET_WARNINGS` | `budgetWarnings` | `true` | mutes toast/BEL only |
| `ui.allowSecretMention` | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | — | `false` | |
| `ui.exitCode` | `--exit-code=last-run\|zero` | `JEVCODE_EXIT_CODE` | `exitCode` | `zero` | session mode |
| `ui.keybindings` | — | — | `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` | none | `namespace:action` ids, `"none"` unbinds, single keys only in v1; reserved Ctrl+C/D/M/[/I |
| `log.file` | `--log <file>` | `JEVCODE_LOG` (`JEVCODE_TRACE` alias → level trace) | `log` | `<runDir>/jevcode.log` | |
| `log.level` | `--log-level`, `--verbose` (= debug) | `JEVCODE_LOG_LEVEL` | `logLevel` | `info` | file only |
| `session.spendCapUsd` | `--session-spend-cap <usd\|none>` | `JEVCODE_SESSION_SPEND_CAP_USD` | `sessionSpendCapUsd` | `5 × limits.spendCapUsd` | shown as derived |
| `limits.spendCapUsd` | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `spendCapUsd` | `2.00`; `0.25` for jev-only | mode-keyed after `--mode` |
| `limits.allowUnpriced` | `--allow-unpriced` | `JEVCODE_ALLOW_UNPRICED` | `allowUnpriced` | `false` | |
| `limits.maxGeneratorTokens` | `--max-generator-tokens <n>` | `JEVCODE_MAX_GENERATOR_TOKENS` | `maxGeneratorTokens` | `spendCapUsd / 15 × 1e6` | only under `allowUnpriced` |
| `generator.priceCacheReadPerM/WritePerM` | — | `JEVCODE_PRICE_CACHE_READ_PER_M`, `_WRITE_PER_M` | `priceCacheReadPerM`… | `0.1 ×` / `1.25 ×` in | source column says derived |
| `updateNotify` | — | `JEVCODE_UPDATE_NOTIFY` | `updateNotify` | `false` | post-run only |

Pending `/budget spend-cap` values are memory-only (not a setting). `jevcode config` renders `setting value source` with derived defaults marked
`(default: 5 × limits.spendCapUsd)`; `--json` includes `sandboxLevel` and `ui`.

## 17. Packaging and release (A65–A72, F15; documented and prepared, not published)

1. `package.json`: remove `"private": true`; `dependencies: {}` (ink/react → devDependencies, inlined by esbuild); `files: ["bin/jevcode.js",
   "dist/jevcode.mjs", "dist/THIRD_PARTY_LICENSES.txt", "man/jevcode.1", "README.md", "LICENSE"]`; `man`, `publishConfig: { access: 'public',
   provenance: true }`, `repository`; commit `LICENSE` (MIT).
2. `scripts/build.mjs`: `minify: true` with `keepNames: true`; `define: { 'process.env.JEVCODE_VERSION': JSON.stringify(pkg.version) }` (`main.tsx`
   `VERSION` reads it); generate `dist/THIRD_PARTY_LICENSES.txt` from the metafile inputs' `LICENSE*` files (esbuild `legalComments: 'none'`);
   generate `man/jevcode.1` and the completion scripts from `FLAGS`; keep `sourcemap: true` locally, exclude `.map`; `npm pack --dry-run --json`
   assertion (< 1.5 MB, exact file list).
3. `bin/jevcode.js`: keep the Node ≥ 22.12 guard, `NO_COLOR` shim, compile cache, no-network interceptor; `--version` and `--help` answered in
   `main.tsx` before any Ink import (already the case: Ink is a dynamic import); `--version --json` → `{ "jevcode": "<v>", "node": "<v>", "ink":
   "7.1.1" }`.
4. `jevcode completion bash|zsh|fish`: static scripts from `FLAGS`; run-id completion by a shell-side `ls`; print destinations only.
5. `jevcode upgrade [<v>|latest|next] [--check] [--method]`: detect npx/brew/bun/pnpm/yarn/npm from `realpath(process.argv[1])`; 2 s registry timeout;
   never `npm update -g`; exit 0/2/5/6.
6. Notifier off by default; when on, a detached `unref()`'d `jevcode upgrade --check --write-cache` after `run:end` writes
   `${XDG_CACHE_HOME:-~/.cache}/jevcode/update-check.json`, read after the first frame next time; suppressed in CI,
   `NO_UPDATE_NOTIFIER`/`JEVCODE_NO_UPDATE_CHECK`, non-TTY, npx, < 24 h.
7. Homebrew tap `Formula/jevcode.rb` (`depends_on "node"`, `std_npm_args`, `bin.install_symlink`, `generate_completions_from_executable`,
   `man1.install`; text in 09 §11.3); release job rewrites `url`/`sha256`.
8. CI gates: `test "$(npm pkg get private)" = "{}"`, `npm pack --dry-run` size/list, `--version` smoke, first-frame perf; publish job on Node 24 (`npm
   ≥ 11.5.1` asserted) with `id-token: write` trusted publishing (P69: Node 24 job); `.nvmrc` stays 22.23.2; dist-tags `latest`/`next`; GitHub Release
   with tarball + `SHA256SUMS`; per-version CHANGELOG.
9. Windows documented: TUI in ConPTY terminals with `--sandbox none`; sandboxed runs via WSL 2; ACL note for 0600.

## 18. Performance plan (F18, A103, A107, DESIGN §12)

| Gate | Threshold | How measured | Script |
| --- | --- | --- | --- |
| First frame, `chat` and `run` | cold p95 < 300 ms incl. the composer frame, zero network | `script -q /dev/null sh -c 'stty rows R cols C; exec node bin/jevcode.js chat --perf-exit-after-first-frame'` at 40×120, 24×80, 8×40; sentinel `step 0/` | `perf/first-frame.ts` gains the `chat` geometry set |
| Composer keystroke → frame | p95 < 16 ms in a real pty at the A109 region (rows 24: pane 12 + live 2 + queue 2 + composer 6) | Python `pty.fork` driver writes one printable byte with a timestamp, waits for the frame's `ESC[?2026l`, 500 keystrokes over a 2,000-char draft; also with a 6-row draft and with the palette open | new `perf/composer-latency.ts` (+ `perf/drivers/pty_type.py`) |
| Event-loop lag while typing during a live mocked run | lag p95 < 5 ms, max < 50 ms; `renderTime` p95 < 5 ms | `render-lag.ts` with a typing driver (10 keys/s) during the 500-delta/s mock at rows 40 and 12 | `perf/render-lag.ts` extended |
| Zero clears | 0 matches of `/\x1b\[[0-9;]*[23]J\|\x1bc\|\x1b\[\?1049[hl]/` after the first frame at every geometry and state (review, palette, picker, wizard, secret row, retry row, resize 40→12→40) | pty captures | `render-lag.ts` regex extended; `perf/states.ts` drives each overlay with `JEVCODE_FAULT`/mock hooks |
| Frame rate | ≤ 20/s + 1 under the 500 delta/s mock; ≤ 4/s in reduced motion; retry row 1 ± 1 fps | count `ESC[?2026h` | `render-lag.ts` |
| Cursor and hide/show | exactly one `ESC[?25l` per run and a final `ESC[?25h`; cursor-position writes only when the composer cursor moved | pty bytes | `render-lag.ts` |
| Static microbenchmark | re-run 08 §11's append benchmark with the A109 region (22 rows) and with a review pending | ink-testing-library fake TTY | new `perf/static-append.ts` (report only) |
| Fuzzy scorer | p95 ≤ 16 ms per keystroke over 5,000 candidates | vitest | `test/unit/tui/fuzzy.test.ts` |
| Harness overhead | unchanged p95 < 50 ms; pre/post images and `planAfter` included | existing | `perf/step-overhead.ts` (adds `run` steps with 50 dirty files) |

All perf runs use `NODE_ENV=production` and an env without `CI`; results go to `perf/results/latest.json`.

## 19. Testing plan (A102–A108, F18)

### 19.1 Unit (vitest `unit`, ink-free, offline)

`computeLayout` invariants (§2.1) exhaustively; `reviewHeaderLines(req, n)` for n = 2..8 at 80/120 columns; `resolveKey` over every cell of §3.3
(states × keys × modes, including armed timers and the 30 ms Esc re-buffer with injected clocks); `reduceBuffer` unit vectors (A105: split CSI,
`ESC`+`x` at 5/25 ms, `\r\n\t` pastes, 64 KB paste, Ctrl+D empty/non-empty, `0x1a`, kitty `13;2u`, xterm `27;2;13~`, `[I`/`[O`, `[?0u`, `[?62c`, OSC
11 replies, SGR mouse); `cellWidth` vs `string-width` fixtures; `parse.ts` grammar (quotes, escapes, errors); `fuzzy.ts` ranking + timing;
`registry.ts` sync test against `docs/COMMANDS.md`/`docs/KEYS.md`; `detectSecrets` FP fixtures + 256 KB backtracking guard; `seed.ts`; index fold with
torn lines and 512-byte cap; `history.ts` cap/dedupe/redaction; `statusLineText` widths 40/60/80/100/120/140; pane `lines()` functions;
`budget-lines.ts` thresholds (34/4/1 fixture); `gitstate.ts` v2 parser fixtures (ten line kinds, `(initial)`, `(detached)`, torn output); `images.ts`
+ undo decision table incl. staged-then-modified; `numstat` parsing; pager selection; `exitCodeFor(stop, error, degraded)`; onboarding reducer (no
secret in state); epilogue text; a source scan asserting no `process.stdout.rows/columns` reads outside `plain.ts`, no `setInterval(` outside
`spinner.ts`/`retry.ts`, no `useFocus`; frame width check over this file's fenced blocks (80/120).

### 19.2 Property tests (A106)

mulberry32 seeded fuzzer over `{ insert(g ∈ pool), paste(\r\n text), move*, kill*, yank, undo, redo, history, raw parse- keypress bytes }` with
`Intl.Segmenter` as the oracle: cursor on a boundary; `text === graphemes.join('')`; no control chars; `insert`+`backspace` identity; `kill`+`undo`
identity; `width(row) ≤ columns` and rendered cursor from widths; paste = one undo step; render is a pure function of `(text, cursor, columns)`;
1,000–5,000 iterations, < 2 s per file, shrink by prefix replay, seed printed on failure.

### 19.3 ink-testing-library (`StubStdout(rows, columns)` from `height.test.tsx`)

Every §2.2 state rendered at rows 8/12/24/40 × columns 40/80/120: `dynamicRegion(frame).length ≤ rows − 2`; review keys (`y` true; `n`/Esc false;
Enter inert; typed-ahead `y` during the deferral lands in the draft; second request declines the first); secret gate (`y` sends and `addSecret` called
first; Enter dismisses); follow-up box (Enter inert; `y` clamps); steer queue (Enter while live → `steer`; Up takes back); resize
(`stdout.emit('resize')` 40 → 12 → 40 keeps draft and cursor); `PaneBoundary` fallback per pane with `JEVCODE_FAULT=render:<pane>` (a failed review
declines); `<Static>` item identity vs `--plain` output for the same event list; screen-reader twins with `isScreenReaderEnabled: true`; snapshots
(`renderToString`, dynamic region only, normalised serializer) at 40/80/120.

### 19.4 pty suite (vitest project `pty`, `expect(1)`/`script(1)`, macOS, `CI` unset, `skipIf(!existsSync('/usr/bin/expect'))`)

| Scenario | Assertion |
| --- | --- |
| `chat` first frame, then type 200 chars + Enter under `--mock` | sentinel < 300 ms; `ESC[2J` = 0; composer echoes text; run starts |
| Ctrl-C matrix walk (S0→hint→exit 0; S1 clear; S2 abort + reopen; S4 decline+abort; S6 second press exits 130) | exit codes and bytes; `state.json` present after abort |
| Esc pause / Esc Esc abort | `human_pause` in `state.json`; resume continues |
| Ctrl-Z through `bash -i` + `fg` | `ps` state `T`; `stty -a` cooked while stopped; raw again after `fg`; repaint; no checkpoint written by suspend |
| SIGHUP (close master) | exit 129; `state.json` written; no epilogue bytes |
| Resize storm 30 × `stty` changes 2 ms apart, 40 → 12 → 40 | one final layout; `ESC[2J` = 0; region ≤ 10 rows at 12 |
| Review at rows 12 and 8 | keys line present; `y` approves; `d` note reaches `transcript.log` |
| 20 KB bracketed paste holding a `ghp_` token | chip label echoed, token bytes absent from the pty and every artefact; `y` at the gate sends; mock provider saw the raw token; `secret-ack` count 1 |
| Wizard: bracketed paste, raw chunk, typing 3 ms/char, split marker 30 ms | 0 key bytes in the pty; file 0600/dir 0700; `saved` |
| `JEVCODE_FAULT=jev:429:12` | retry row at 1 fps ± 1; `[r]` shortens the wait; `ESC[2J` = 0 |
| `JEVCODE_FAULT=persist:ENOSPC` (and opt-in `hdiutil` 1 MiB image with `JEVCODE_TEST_RAMDISK=1`) | degraded pane; `[q]` exit 3; `[r]` then resume works |
| `JEVCODE_FAULT=render:decisions` | fallback row; keys still handled; `ESC[2J ESC[3J` = 0 |
| Crash (`uncaughtException` injected) | `stty -a` shows `icanon echo`; epilogue bytes after the last frame; `state.json` present |
| `/diff --full` with `PAGER='sh -c "cat >/tmp/out; echo PAGED"'` | pager output above the redrawn frame; queued items flushed after resume |
| `--plain` TTY readline composer | same slash dispatcher; steer while live; secret gate via `question` |
| `--json` on a pipe | first line `stream:start`; every line parses; no `status`; `run:end.exitCode` |
| 0×0 pty (no `stty`) | Ink 80×24 fallback; rule width 80 |

### 19.5 Fault injection (`JEVCODE_FAULT`, dev-only)

`render:<pane>`, `persist:ENOSPC`, `jev:429:12`, `jev:401`, `gen:529`, `disk:EACCES-runsdir`, `git:missing`, `watch:EMFILE`; each has a unit test
(reducer/engine) and a pty test where a frame is involved.

### 19.6 CI without a TTY

Unit, property, ink-testing-library and `--plain`/`--json` smoke on ubuntu and macOS; `pty` and perf projects on `macos-latest` only with `CI` removed
from the child env; snapshots fail on missing/obsolete in CI (vitest rule).

## 20. Module map for parallel implementation (10 owner slots, disjoint files, waves)

| Slot | New / changed files | Exports | Depends on |
| --- | --- | --- | --- |
| **O1 contract + engine** | `core/types.ts` (§15), `errors.ts` (`EXIT_CODES` unchanged), `loop/stop.ts` (`exitCodeFor(stop, error?, degraded?)`, BUDGET_STOP_REASONS), `loop/engine.ts` (steer/unsteer/pause/retryNow, seed, human directive, retry/budget/workspace events, planAfter, images hook), `loop/loopdetect.ts` (`resetCounts`), `loop/state.ts` (`human`), `provider/prompts.ts` (`humanDirective`, `pinnedFiles`), `loop/budget.ts` (`token_cap`), `core/time.ts` (`sleepUntil`), `jev/client.ts`, `provider/sse.ts` (`onRetry`, `wake`) | as §15 | — |
| **O2 composer core** | `tui/composer/buffer.ts`, `width.ts`, `eaw-table.ts` (+ `scripts/gen-eaw.mjs`), `layout.ts`, `paste.ts` | `reduceBuffer`, `graphemes`, `wordBoundary`, `cellWidth`, `stringWidth`, `layoutRows`, `cursorXY`, `PasteStore` | none |
| **O3 keys + layout + commands** | `tui/keys.ts`, `tui/layout.ts`, `tui/commands/{parse,registry,fuzzy,dispatch}.ts` | `resolveKey`, `computeLayout`, `parseCommand`, `COMMANDS`, `rank`, `dispatchCommand` | O1 types |
| **O4 review + pane lines** | `tui/review-lines.ts`, `tui/pane-lines.ts`, `tui/why.ts`, `tui/calibration.ts`, `tui/bars.ts` | `reviewHeaderLines`, `decisionRows`, `planRows`, `timelineRows`, `synthRows`, `whyBlock`, `calibrationBlock`, `eighthBar`, `sparkline` | O1 types |
| **O5 status + git zone + toasts** | `tui/status-lines.ts`, `tui/useGitHead.ts`, `tui/toasts.ts`, `workspace/gitstate.ts` (`probeGitState`, `statusPorcelainV2`) | `statusLineText`, `useGitHead`, `toastReducer`, `GitState` probe | O1 |
| **O6 sessions + money** | `session/{index,history,seed,export,picker-lines}.ts`, `spend/meter.ts` (`parentExceeded`), `tui/budget-lines.ts`, `config/resolve.ts` (`sessionSpendCapUsd`, `missingSecrets`, `addSecret`/`dropSecret`, XDG), `config/validate.ts` (`priced`), `config/ui.ts` (§16 schema) | `appendIndexLine`, `foldIndex`, `HistoryStore`, `buildSeed`, `exportSession`, `pickerRows`, `budgetItems`, `costBlock`, `UiConfig` | O1 |
| **O7 secrets + logs + onboarding** | `core/redact.ts` (`detectSecrets`, `dropSecret`), `core/log.ts`, `tui/onboarding/{reducer,lines}.ts`, `config/credentials.ts` (atomic 0600 writer), `config/trust.ts`, `config/instructions.ts` (AGENTS.md), `tui/clipboard.ts` | `detectSecrets`, `createLog`, `onboardingReducer`, `writeCredentials`, `trustStore`, `loadInstructions`, `copyRedacted` | O1 |
| **O8 undo/diff + errors** | `checkpoint/images.ts`, `tui/undo.ts`, `tui/diff.ts`, `sandbox/seatbelt.ts` (`gitDir`/`gitCommonDir`), `cli/epilogue.ts`, `cli/fatal.ts`, `tui/PaneBoundary.tsx` | `writePreImages`, `writePostImage`, `planUndo`, `applyUndo`, `diffStatBlock`, `openFullDiff`, `epilogueLines`, `fatalExit`, `PaneBoundary` | O1, O5 (`GitState`) |
| **O9 Ink components + App** | `tui/App.tsx` (rewired), `tui/useEngine.tsx` (mode router, queue during suspension, retry tick, toasts), `tui/composer/Composer.tsx`, `tui/Overlay.tsx` (review/wizard/followup/secret/blocking/palette/undo/minsize), `tui/Pane.tsx`, `tui/Picker.tsx`, `tui/StatusLine.tsx`, `tui/onboarding/{Wizard,MaskedField}.tsx`, `tui/spinner.ts`, `tui/retry.ts`, `tui/theme.ts` | `createTuiRenderer` | O2–O8 |
| **O10 CLI + plain + packaging + perf/pty** | `cli/main.tsx` (session loop), `cli/args.ts`, `cli/{completion,man,upgrade,login,report}.ts`, `tui/plain.ts` (readline composer, `--json`), `bin/jevcode.js`, `scripts/build.mjs`, `LICENSE`, `perf/{composer-latency,states,static-append}.ts`, `test/pty/**`, `docs/*` | commands | O1, O3, O6, O7 |

Waves: **W0** O1 lands `types.ts` + `stop.ts` first (one PR, ≤ 1 day) so every slot compiles. **W1** (parallel, ink-free, unit-tested): O2, O3, O4,
O5, O6, O7, O8 pure parts. **W2**: O1 engine changes; O10 `args.ts`/`plain.ts`; O8 `PaneBoundary`/`fatalExit`. **W3**: O9 components over W1 outputs;
O10 `main.tsx` session loop. **W4**: pty suite, perf gates, packaging, docs. Integration order inside W3: layout → composer → status → pane →
overlay(review) → palette/mention → picker → wizard → follow-up/secret/blocking → retry row.

## 21. Docs deliverables

`docs/KEYS.md` and `docs/COMMANDS.md` generated from `keys.ts`/`registry.ts` with a sync test; `man/jevcode.1` and completions from `FLAGS`; README
sections "Interactive session", "Sessions and follow-ups", "Money", "Secrets", "Exit codes" (table §13.5), "Windows"; `docs/DESIGN.md` amendments: §10
(composer, layout order, `--json` guarantee wording), §11 (state-mutation rule amendment, exit-code table, `fatalExit` order), §12 (new gates);
`docs/DECISIONS.md` entries D1–D15; `docs/research/tui/terminal-matrix.md` checklist; `CHANGELOG.md`; `LICENSE`; `THIRD_PARTY_LICENSES.txt`.

## 22. Deviations from ADOPT rows and items deferred to v1.x

| Row | Deviation (one sentence) |
| --- | --- |
| A9 | Typing `exit`/`quit`/`:q` does not exit (a task may legitimately be the word "quit"); rotating placeholder examples dropped (a timer for decoration violates the reduced-motion budget). |
| A21 | Help is an appended `<Static>` block plus the status-line ShortHelp, not a two-level overlay pane (one modal slot, zero extra rows). |
| A24 | Keybindings file supports single-key remaps and `"none"` only; chords are deferred (the 3 s chord timer adds a state the matrix would have to enumerate). |
| A26 | No newline-gated per-line commit of generator text: the TUI would gain `<Static>` lines that `transcript.log` does not have, breaking F13's line-for-line identity; the ≤ 2-row live tail + whole proposal item stays. |
| A29 | `--replay-limit` dropped: resume replay is header + plan summary + 4 window entries (≤ 6 items), so batching is moot. |
| A35 | The `@` search is synchronous over the in-memory candidate list (≤ 16 ms measured gate); the async session/abort machinery is deferred. |
| A56 | Picker rename is `/rename`, not Ctrl-R (Ctrl-R is history search everywhere else); row delete deferred to `jevcode sessions prune`. |
| A63 | Project commands `.jevcode/commands/*.md` deferred (not required by F1–F18). |
| A75 | `jevcode doctor` deferred; `/config` + `jevcode config` cover the read-only view. |
| A78 | tmux `CSI > 4 ; 2 m` not sent in v1 (Ink cannot parse `CSI 27;m;k~` and the protocol handshake is deferred with kitty). |
| A87 | OSC 8 hyperlinks deferred. |
| A44 | Side-by-side tabs at ≥ 120 columns deferred; one tab at a time. |
| 11 §4b | `matches_intent` gauge is dropped first when the header is cut to 6 rows, and compact two-per-row dimension rows are used below 6, so all four dimensions survive down to 4 header rows. |
| 06 §17.3 | No `a` approve alias, no `s` steer key, no focus movement on the box (F6: exactly y/n/Esc/d/e/w). |
| 17 §4.3 | `[r] retry now` **is** in v1 via `Engine.retryNow()` (one method beyond F13's named trio, required by F12). |
| 10 §15.3 | `steer` returns `{ queued, dropped }` (the ninth directive is refused with a toast rather than silently evicting). |
| 13 §5.2 | The wizard never runs while the composer draft is non-empty; `/login` mid-run collapses the composer like a review. |

Deferred to v1.x, with the reason: kitty handshake (`CSI ? u` + DA1 after the pty suite exists, C1); incremental rendering as default (soak test, C2);
tmux extended keys (with the handshake); OSC 8; project commands; `doctor`; picker delete; `/redo`; `/cd` workspace switching (second trust check);
structured `synth` fields (synth team); Windows ConPTY tests; NVDA/VoiceOver validation; keybinding chords; vim mode; markdown rendering of generator
text; PEM/JWT promotion to redacting (after real `history.jsonl` data, C44); `w` write-to-.env option (P57, conflicts with A118); persisted
`addSecret` across `--resume` (P56); `!` shell mode and `/compact` (fixed no); 95 % pre-emption (fixed no); `--auto-decline` (fixed no); Static
remount cap tuning beyond 20,000 (Q10).
