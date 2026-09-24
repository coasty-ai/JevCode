# JevCode interactive TUI — design from the sessions / long-horizon angle

Written 2026-09-20 against `src/core/types.ts` (contract v1, last change `5c42925`), `src/loop/engine.ts` (1,637
lines), `src/tui/*`, `src/cli/*`, `src/checkpoint/*`, `src/config/*`, `src/spend/meter.ts`, `src/core/redact.ts`,
`docs/DESIGN.md` §6/§9/§10/§11/§12 and `docs/research/tui/00-SUMMARY.md` (cited as `A<n>`, `R<n>`, `C<n>`, `P<n>`,
`D<n>`) plus the research files (cited as `NN §x`). Line numbers are those of the working tree read today.
The angle: a user who works with JevCode on one repository for hours and tens of runs. Depth goes to §8 (sessions),
§9 (money), §12 (git/undo/diff), §15 (contract). Fixed product decisions F1–F18 are honoured verbatim and are not
reopened; every deviation from an ADOPT row is listed in §22 with one sentence.

## 0. Thesis and how the fixed decisions are honoured

**Thesis.** A session is a *ledger of runs*, never a mutable conversation. Every human act is either the task of a
new run (follow-up), a directive queued for a live run (steer), a request to stop at a safe point (pause), or an
audited change to the workspace between runs (undo/rewind). Nothing a human does ever rewrites a committed
checkpoint: `run.json`/`state.json`/`steps.jsonl` of a finished run stay byte-identical (DESIGN §9 "a run must stay
comparable with itself"; R21), the bench keeps reading the same files, and everything the TUI needs about the past
(title, cost, branch, stop reason, reverts) lives in one append-only `~/.jevcode/sessions/index.jsonl` folded in
0.26 ms (A55, A139, 14 §2.2). Money is a meter tree (session parent, run child), not a new stop reason (A129). The
composer is a hand-rolled buffer inside a fixed `rows − 2` budget with one cap set and one yield order (A109), so
ten hours of `<Static>` scrollback cost nothing per keystroke (A10, 08 §11).

| Fixed | Where honoured |
| --- | --- |
| F1 entry points, first-frame gate covers the composer | §1; `perf/first-frame.ts` gains the `chat` variant (§18) |
| F2 rendering posture | §2 (budget), §14 (posture); `render({ maxFps, incrementalRendering, kittyKeyboard: { mode: 'disabled' } })` |
| F3 cap set A109, worked frames | §2 `computeLayout` + allocation table + frames at 8/12/24/40/50 × 80/120 |
| F4 keys | §3 keymap, §4 composer, §5 palette |
| F5 Ctrl-C/Esc/Ctrl-D matrix | §3.2 table + state machine |
| F6 review prompt | §6 |
| F7 sessions, steering, index, history, planAfter, /export, /theme, pending /budget in memory | §8, §15 |
| F8 money | §9 |
| F9 secrets | §10 |
| F10 onboarding, credentials, trust, AGENTS.md | §11 |
| F11 git, undo, diff | §12 |
| F12 errors, retry, crash, logs | §13 |
| F13 additive contract list with signatures and insertion points; jev-only preserved | §15 |
| F14 config schema | §16 |
| F15 packaging | §17 |
| F16 views | §7 |
| F17 fuzzy matcher | §5.4 |
| F18 no deps, strict TS, tests, perf gates | §18, §19, §20 |

## 1. Entry points and modes

| Invocation | Renderer | Composer | Run | Exit | Notes |
| --- | --- | --- | --- | --- | --- |
| `jevcode` / `jevcode chat` (TTY) | Ink `<App mode="session">` | yes, first frame | none until Enter | `/exit`, Ctrl-D ×2, Ctrl-C ×2 idle → 0 | A54, F1; bare argv → `command: 'chat'` (§15 args.ts) |
| `jevcode run "<task>"` (TTY) | Ink `<App mode="one-shot">` | yes (steer only while live; no follow-up) | starts after first frame | `exitCodeFor(stop)` (§13.5) | today's monitor + steering; Esc pause → exit 4 |
| `jevcode run --resume <id|title>` | as above | as above | resume | as above | title resolved through the index fold (§8.3) |
| `jevcode -c` / `jevcode chat -c` | session | yes | picks the most recently *used* run in this workspace (A56, C37) and opens the follow-up composer | 0 | no run → `no session in /path yet` hint row |
| `jevcode --plain` (TTY) | plain lines + `node:readline` line composer | readline `› ` prompt; same slash dispatcher | per line | 0 on `/exit` | F1; confirm via readline `y/n/d <note>` |
| `jevcode run --plain "<task>"` (TTY or pipe) | plain | none | one run | `exitCodeFor` | today's behaviour, byte-identical `transcript.log` |
| `jevcode run --plain` non-TTY, task from argv / `--task-file` / stdin | plain | none | one run | `exitCodeFor` | reviews decline after `confirmTimeoutMs`; wizard → fix block + exit 2 (§11.5) |
| `jevcode run --plain --json …` | JSONL writer (§8.9) | none | one run | `exitCodeFor`; `run:end.exitCode` in stream | implies `--no-input`; no ticks |
| `jevcode bench … / perf …` | bench log / perf | none | many | unchanged | `source: 'bench'|'perf'`: no index lines, no history, no session meter (A55, A60, A129) |
| `jevcode login/logout/config [set]/sessions/report/completion/upgrade/doctor/calibration/why` | none (stdout) | — | — | 0/1/2/5 | §11, §13, §17 |

Mode router (`src/cli/main.tsx` `commandChat`/`commandRun`): `interactive = Boolean(stdout.isTTY) && Boolean(stdin.isTTY) && !flags.plain && !flags.json && !CI && TERM !== 'dumb'` (A82). `noInput = flags.noInput || env.JEVCODE_NO_INPUT === '1' || !interactive` suppresses wizard, trust gate, follow-up confirm (silent clamp), secret gate (cancel) and reviews (decline) (C46). The first frame of `chat` is rendered from argv, `process.env`, `isTTY` and `process.cwd()` only: header item `jevcode <version> · <basename(cwd)> · session new`, rule, composer with placeholder, status `step 0/–  idle`. Everything else (index fold, `missingSecrets`, trust, git probe) runs after `waitUntilRenderFlush()` (DESIGN §12 ordering contract).

## 2. Layout: `computeLayout(rows, columns, state)`

### 2.1 Function (`src/tui/layout.ts`, pure, unit-tested)

```ts
export interface LayoutInput {
  mode: 'session' | 'one-shot';
  /** rows the buffer needs to show all visual lines (>= 1) */
  composerLines: number;
  queued: number;                         // pending steers, 0..8
  liveWanted: 0 | 1 | 2;                  // streaming tail / retry row / synth strip
  loopBanner: boolean;
  paneWanted: number;                     // rows the active tab would fill, 0..12
  review: null | { previewLines: number; expanded: boolean };
  overlay: null | { kind: 'palette' | 'mention' | 'history' | 'picker' | 'help' | 'wizard' | 'trust' | 'budget-confirm' | 'blocking' | 'undo-prompt'; rows: number };
  secretGate: boolean;
}
export interface Layout {
  rows: number; columns: number; budget: number;
  degraded: 'ok' | 'composer-only' | 'status-only' | 'none';
  status: number; rule: number; live: number; loop: number; topOverlay: number; pane: number;
  reviewHeader: number; preview: number; bottomOverlay: number; queue: number; secret: number; composer: number;
  total: number;
}
export const CAPS = { composer: 6, composerTall: 8, composerTallRows: 40, queue: 2, pane: 12, reviewHeader: 8, preview: 8, wizard: 4, trust: 4, budgetConfirm: 5, blocking: 8, palette: 8, mention: 8, history: 8, picker: 12, pickerTall: 16, help: 12, live: 2 } as const;
export const MIN_COLUMNS = 40;
export const MIN_ROWS = 8;

export function computeLayout(rows: number, columns: number, s: LayoutInput): Layout {
  const budget = Math.max(0, Math.floor(rows) - 2);
  const L: Layout = { rows, columns, budget, degraded: 'ok', status: 0, rule: 0, live: 0, loop: 0, topOverlay: 0, pane: 0, reviewHeader: 0, preview: 0, bottomOverlay: 0, queue: 0, secret: 0, composer: 0, total: 0 };
  let rem = budget;
  const take = (n: number): number => { const got = Math.max(0, Math.min(n, rem)); rem -= got; return got; };
  if (rows < 3) { L.degraded = 'none'; return L; }                       // Static only
  L.status = take(1);
  if (rows < MIN_ROWS || columns < MIN_COLUMNS) {                          // notice in the rule row, composer 1, nothing else
    L.degraded = rows < 5 ? 'status-only' : 'composer-only';
    L.rule = take(1); L.composer = take(1); L.total = budget - rem; return L;
  }
  L.rule = take(1);
  // mandatory rows (never yield): composer floor, secret row, review header, overlays
  L.composer = take(1);
  if (s.secretGate) L.secret = take(1);
  if (s.review) L.reviewHeader = take(CAPS.reviewHeader);                  // keys line is row 2, safe under truncation
  if (s.overlay) {
    const top = s.overlay.kind === 'wizard' || s.overlay.kind === 'trust' || s.overlay.kind === 'blocking';
    const got = take(Math.min(s.overlay.rows, capFor(s.overlay.kind, rows)));
    if (top) L.topOverlay = got; else L.bottomOverlay = got;
  }
  // protected growth, in yield order reversed: composer growth → queue → preview → live → loop → pane
  const composerCap = rows >= CAPS.composerTallRows ? CAPS.composerTall : CAPS.composer;
  const composerWant = s.review || s.overlay?.kind === 'budget-confirm' || s.overlay?.kind === 'blocking' ? 1 : Math.min(composerCap, Math.max(1, s.composerLines));
  L.composer += take(composerWant - 1);
  L.queue = take(Math.min(CAPS.queue, s.queued));
  if (s.review) L.preview = take(s.review.expanded ? rem : Math.min(CAPS.preview, s.review.previewLines));
  L.live = s.review ? 0 : take(Math.min(CAPS.live, s.liveWanted));       // 11 §4b: live rows reclaimed by the box
  L.loop = s.loopBanner && !s.review ? take(1) : 0;
  L.pane = s.overlay?.kind === 'picker' || s.overlay?.kind === 'help' || s.review?.expanded ? 0 : take(Math.min(CAPS.pane, s.paneWanted));
  L.total = budget - rem;
  return L;
}
function capFor(kind: NonNullable<LayoutInput['overlay']>['kind'], rows: number): number {
  switch (kind) {
    case 'wizard': return rows < 12 ? 2 : CAPS.wizard;
    case 'trust': return rows < 12 ? 2 : CAPS.trust;
    case 'budget-confirm': return CAPS.budgetConfirm;
    case 'blocking': return CAPS.blocking;
    case 'picker': return rows >= 40 ? CAPS.pickerTall : CAPS.picker;
    case 'help': return CAPS.help;
    case 'undo-prompt': return 2;
    default: return CAPS.palette;                                           // palette | mention | history
  }
}
```

Visual order, top to bottom (the rule row is also the pane's tab header, 11 §4a): `<Static>` · rule · live · loop
banner · top overlay (wizard / trust / blocking) · pane · review header · preview · bottom overlay (palette /
mention / history / picker / help / budget-confirm / undo-prompt) · queue · secret row · composer · status. Every
row is a fixed-height `<Box overflow="hidden">` with `<Text wrap="truncate">` (A10, A33). `rows`/`columns` come from
`useWindowSize()` only (A15, A93); resize is a 50 ms trailing debounce (A30, C23).

### 2.2 Allocation table (rows used of budget; `c` = composer rows, `p` = pane rows)

| State | rows 8 (6) | rows 12 (10) | rows 24 (22) | rows 40 (38) | rows 50 (48) |
| --- | --- | --- | --- | --- | --- |
| idle composer (empty) | rule 1 c1 p2 st1 = 5 | rule 1 c1 p7 st1 = 10 | 1+1+12+1 = 15 | 1+1+12+1 = 15 | 15 (two tabs side by side at ≥ 120 cols) |
| live, streaming | rule 1 live 2 c1 p1 st1 = 6 | 1+2+1+5+1 = 10 | 1+2+12+1+1 = 17 | 17 (+1 loop) | 17 |
| live, 2 queued, 3-line draft | 1+2+q2+c1(floor) +st1 = 7 > 6 → live yields to 1 | 1+2+q2+c3+p1+1 = 10 | 1+2+q2+c3+p12+1 = 21 | 1+2+q2+c3+p12+1 = 21 | 21 |
| review pending (preview 8) | 1+hdr4+c1+st1 = 7 > 6 → hdr 3 (title, keys, ruler) | 1+hdr7+c1+1 = 10, preview 0, p0 | 1+hdr8+prev8+c1+p3+1 = 22 | 1+8+8+1+12+1 = 31 | 31 |
| palette open (8 rows) | 1+c1+pal3+st1 = 6 | 1+c1+pal7+1 = 10 | 1+live2+c1+pal8+p9+1 = 22 | 1+2+1+8+12+1 = 25 | 25 |
| picker open | 1+c1+pick3+st1 = 6 | 1+c1+pick7+1 = 10 | 1+c1+pick12+1 = 15, p0 | 1+1+16+1 = 19 | 19 |
| onboarding wizard | 1+wiz2+st1... composer absent → 1+2+1 = 4 | 1+4+1 = 6 | 6 | 6 | 6 |
| follow-up budget confirm | 1+c1+conf3+st1 = 6 | 1+c1+conf5+p2+1 = 10 | 1+c1+conf5+p12+1 = 20 | 20 | 20 |
| retry row (live = 1–2 retry rows) | as live | as live | as live | as live | as live |
| minimum-size notice (rows < 8 or cols < 40) | rows 7: rule(notice)1 + c1 + st1 = 3 | — | — | — | — |

### 2.3 Worked frames (dynamic region shown from the rule down; one or two `<Static>` lines above for context)

**A. Idle composer, first launch, 24×80** (rule 1 · pane 1 · composer 1 · status 1 = 4 of 22)

```
jevcode 0.2.0 · proj · session new
[setup] sandbox seatbelt — writes confined to the workspace and run dirs
── [d] decisions  [p] plan  [t] time  [s] synth ────────────────────────────────
recent: fix parse_date tz handling · 2 h ago · $0.115 complete   Enter=continue
› Describe the task…  ( / commands · @ files · Enter runs · ? help )
step 0/–  idle  jev-on  run $0.00/2.00 ok  sess $0.00/10.00 ok  ⎇ main 3~ 1?
```

**B. Live run, streaming, 24×80** (rule 1 · live 2 · pane 12 · composer 1 · status 1 = 17)

```
[step 7] intent=edit p=0.82 c=0.71
[step 7] context 3 files 12.4kB of 41 candidates: src/a.py, tests/test_a.py
── [d] decisions  [p] plan  [t] time  [s] synth ────────────── s7 · c~ derived ─
  def parse_date(s: str) -> datetime:
      return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   can_verify       noul   ███▎······  0.33  c 0.34~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 context  tests/test_a.py  noul   ██████▏···  0.62  c 0.24~
s7 context  src/utils.py     noul   ██▍·······  0.24  c 0.52~
s6 judge    succeeded        noul   █████████·  0.90  c 0.80~
s6 judge    error_present    noul   ▌·········  0.05  c 0.90~
s6 judge    new_information  noul   ██████▏···  0.62  c 0.24~
s6 judge    done_0           noul   ███████▊··  0.78  c 0.56~
s6 complete task_complete    noul   ████▍·····  0.44  c 0.12~
› Type to steer this run (queued for step 8) · Esc pauses · / commands
step 7/40  ⠹ propose  jev-on  4m12s/30m  run $0.31/2.00 ok  sess $1.42/10.00 ok
```

**C. Live run, 2 queued steers, 3-line draft, 24×80** (1 · 2 · 12 · q2 · c3 · 1 = 21)

```
── [d] decisions  [p] plan  [t] time  [s] synth ────────────── s7 · c~ derived ─
  running: pytest -q tests/test_a.py
  ....F.                                                          [ 6/41 ]
s7 intent   intent           verify ████████▏·  0.81  c 0.72   chosen
  (11 more pane rows)
queued 1/2 (step 8) › also update CHANGELOG.md when the tests pass
queued 2/2 (step 8) › do not touch src/legacy/
› after that, run the full suite with
  pytest -q --maxfail=1
  and stop if anything outside tests/ fails
step 7/40  ⠹ execute  jev-on  4m40s/30m  run $0.33/2.00 ok  sess $1.44/10.00 ok
```

**D. Review pending, 24×80** (rule 1 · pane 3 · header 8 · preview 8 · composer 1 · status 1 = 22)

```
── [d] decisions  [p] plan  [t] time  [s] synth ────────────────────── review ──
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date tz-aware"
[y] approve  [n] decline  [d] decline+note  [e] expand  [w] why  [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what…
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable…
matches_intent    ████████▊·  0.88 noul 0.76~ the action is an instance of the…
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
  (4 more preview lines)
  
  
  …[e] expands
› review pending — composer collapsed; y/n/d/e/w answer the box
step 7/40  review  jev-on  4m41s/30m  run $0.33/2.00 ok  sess $1.44/10.00 ok
```

**E. Palette open, 24×80** (rule 1 · live 2 · pane 9 · palette 8 · composer 1 · status 1 = 22)

```
── [d] decisions  [p] plan  [t] time  [s] synth ────────────── s7 · c~ derived ─
  streaming… 1.2k chars
  
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
  (8 more pane rows)
  /budget        show caps, spends and pending values                 ▲ 1/6
▸ /budget spend-cap <usd>         run cap for the next /resume or run
  /budget session-spend-cap <usd> session cap, applies now
  /bu… no other matches
  
  
  
                                                                     ▼ 3/6
› /bu
step 7/40  ⠹ propose  jev-on  4m12s/30m  run $0.31/2.00 ok  sess $1.42/10.00 ok
```

**F. Picker open, 24×80** (rule 1 · picker 12 · composer 1 · status 1 = 15; pane 0)

```
── sessions in proj (Ctrl-A all) · sort updated · Space preview · x delete ─────
  2 h ago   9    complete    $0.115  fix parse_date tz handling
▸ 3 h ago  23    spend_cap   $1.532  refactor date helpers · then docs
  1 d ago   4    human_pause $0.041  investigate flaky test_utils
  2 d ago  40    max_steps   $0.847  migrate config loader to TOML
  preview: plan done 4 remaining 2 · interrupted at step 24 execute
  [step 23] outcome executed: pytest -q (exit 1, 3.1s) changed=0
  [run] budget spend_cap reached at step start
  [run] end spend_cap steps=23 wall=3m47s cost=$1.532 (gen $1.475, jev $0.056)
  
  
  
  ↑↓ move · Enter resume · Space preview · Ctrl-R rename · Esc close    2/4
› filter…
step 0/–  idle  jev-on  run $0.00/2.00 ok  sess $4.11/10.00 ok  ⎇ main 3~ 1?
```

**G. Onboarding wizard (key field), 24×80** (rule 1 · wizard 4 · status 1 = 6; composer absent)

```
jevcode 0.2.0 · proj · session new
────────────────────────────────────────────────────────────────────────────────
No API key found · provider anthropic (ANTHROPIC_API_KEY)
Anthropic API key
› ••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
108 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back
step 0/–  setup
```

**H. Follow-up budget confirm, 24×80** (rule 1 · pane 12 · confirm 5 · composer 1 · status 1 = 20)

```
── [d] decisions  [p] plan  [t] time  [s] synth ────────────────── last run s9 ─
  (12 pane rows from the last run)
┌ follow-up would exceed the session cap ──────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │
└──────────────────────────────────────────────────────────────────────────────┘
› now add the CHANGELOG entry and bump the version           (draft, inactive)
step 0/–  idle  jev-on  run $0.00/2.00 ok  sess $9.58/10.00 critical  ⎇ main
```

**I. Retry row inside the live region, 24×80** (as B; live 2 = retry rows)

```
── [d] decisions  [p] plan  [t] time  [s] synth ────────────── s7 · c~ derived ─
jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)   [r] retry now
last: HTTP 429 · request-id gen-01J8…
  (12 pane rows)
› Type to steer this run (queued for step 8) · Esc pauses · / commands
step 7/40  retrying 2/3  jev-on  4m52s/30m  run $0.31/2.00 ok  sess $1.42/10.00
```

**J. Minimum size: 7×80** (rule 1 as notice · composer 1 · status 1 = 3 of 5) and **8×80** live (rule 1 · live 2 ·
composer 2 · status 1 = 6 of 6, pane 0)

```
MIN 40×8 — terminal is 80×7: panes hidden, transcript keeps flowing above
› Describe the task…
step 0/–  idle  jev-on
```
```
── s7 propose ─────────────────────────────────────────────────── [d][p][t][s] ─
  def parse_date(s: str) -> datetime:
      return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
› after that, run the full suite with
  pytest -q --maxfail=1                                                     ↓1
step 7/40  ⠹ propose  jev-on  4m12s/30m  run $0.31/2.00 ok
```

**K. Review pending, 12×80** (rule 1 · header 7 · composer 1 · status 1 = 10; preview 0, pane 0; row 8 `matches_intent` cut)

```
── review ──────────────────────────────────────────────────────────────────────
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date tz-aware"
[y] approve  [n] decline  [d] decline+note  [e] expand  [w] why  [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what…
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable…
› review pending
step 7/40  review  jev-on  4m41s/30m  run $0.33/2.00 ok
```

**L. Live, 2 queued, loop banner, 40×120** (rule 1 · live 2 · loop 1 · pane 12 · queue 2 · composer 3 · status 1 = 22 of 38)

```
── [d] decisions  [p] plan  [t] timeline  [s] synth ───────────────────────────────────────── s9 · c~ = derived |2p−1| ─
  running: pytest -q tests/test_a.py
  ....F.                                                                                                       [ 6/41 ]
loop  run:pytest -q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12   can_change_approach 0.72
s9 intent   intent           verify ████████▏·  0.81  c 0.72   chosen     231ms  "run tests, a build, or a script"
s9 risk     destructive      L0     ██████████  1.00  c 0.99   [ok]       244ms  no file is written
  (10 more pane rows)
queued 1/2 (step 10) › also update CHANGELOG.md when the tests pass
queued 2/2 (step 10) › do not touch src/legacy/
› after that, run the full suite with
  pytest -q --maxfail=1
  and stop if anything outside tests/ fails
step 9/40  ⠹ execute  tz fixes  6m02s/30m  run $0.61/2.00 ████······ ok  sess $1.72/10.00 ██········ ok  ⎇ main ↑2 3~
```

**M. Review pending, 24×120** (rule 1 · pane 3 · header 8 · preview 8 · composer 1 · status 1 = 22): identical row
plan to D; the 120-column header rows are the 11 §4b wide form (`P(l)  E[k]  tail` columns added, level text not
truncated, `jev 244ms` at the right edge of row 1).

**N. Picker, 40×120** (rule 1 · picker 16 · composer 1 · status 1 = 19): header row, 11 list rows with the workspace
column (`proj`, `../tools`) when widened by Ctrl-A, 4 preview rows, footer row. Columns: `time ago │ steps │ stop │
$cost │ title-or-task60 │ workspace │ ⎇ branch` (A56, A150).

**O. Idle, 50×120, two tabs side by side** (rule 1 · pane 12 · composer 1 · status 1 = 15 of 48): the 12 pane rows
render `[d] decisions` in columns 0–58 and `[p] plan` in columns 61–119 (11 §5 rows-40 note); a third tab needs `]`.

## 3. Keymap, key contexts, Ctrl-C / Esc / Ctrl-D

### 3.1 Contexts (resolved by one matcher from `{ uiMode, composer, engine }` state, never subscription order; A17)

Precedence, highest first: `blocking` (401/disk/spend pane) → `review` → `secret-gate` → `budget-confirm` →
`undo-prompt` → `wizard`/`trust` → `picker`/`palette`/`mention`/`history`/`help` (modal, consume every key) →
`composer` → `global`. The one `useInput` (`{ isActive: Boolean(isRawModeSupported) }`, A14) and the one
`usePaste` live in `<App>`; there is no `useFocus` anywhere (A13). `key.eventType === 'release' | 'repeat'` returns
early. Every key is first passed through the input filter (§4.9).

| Context | Keys (F4, A8) |
| --- | --- |
| global | Ctrl-C / Ctrl-D / Esc per §3.2; `Ctrl-L` erase-lines repaint (`log.clear()`-style redraw, never `ESC[2J`); `Ctrl-O` append detail items for the last step (A22); `Ctrl-Z` suspend (§14.4); `F1` help; `[`/`]` cycle pane tabs; `Ctrl-G` external editor (composer non-modal) |
| composer | Enter submit; Ctrl-J, `\`+Enter, Alt+Enter, `CSI 13;2u`, `ESC CR`, `CSI 27;m;13~` newline (A6, C28); C-a/e Home/End; C-b/f ←/→ by grapheme; M-b/f C-←/→ by word; C-k/C-u kill to end/start; C-w M-Backspace kill word back; M-d M-Delete C-Delete kill word forward; C-y yank, M-y cycle ring; C-t transpose; C-_ (`0x1f`) undo, M-_ redo; Backspace/Delete; ↑/↓ within rows, history at first/last row (A7); C-p/C-n history always; C-r history search; Tab completion; `/` at column 0 palette; `@` mention; `?` on empty composer help; Up on first row with a queue → take back last steer (A53, C22) |
| review | `y` `n` `Esc` `d` `e` `w`+digit `Ctrl-C` (F6); everything else ignored; a multi-char paste matches nothing |
| secret-gate | `y`/`Y` send; any other key dismisses and is then handled by the composer (A154) |
| budget-confirm | `y` `r` `n` `Esc`; Enter inert (A132) |
| blocking | `r` `c` `q` `p` per pane (§13) |
| undo-prompt | `y` `n` `a` `s` Esc (A145); Enter = `n` |
| palette / mention / history / picker / help | ↑/C-p, ↓/C-n, PgUp/PgDn, Enter accept, Tab accept-and-keep-editing, Esc/C-c close, printable = filter; picker extra: Space preview, Ctrl-A all workspaces, Ctrl-R rename, `x` delete (A36, A56) |
| wizard / trust | digits select, Enter submit/reuse, Backspace/Delete, Ctrl-U clear, Esc clear/back, Ctrl-C fix block + exit 2 (A115) |

### 3.2 Ctrl-C / Esc / Ctrl-D matrix (F5; windows: Ctrl-C 1.5 s, Esc Esc 2 s, Ctrl-D 800 ms, Esc re-buffer 30 ms)

| State × mode | Ctrl-C (1st) | Ctrl-C (2nd in window) | Esc | Esc Esc (2 s) | Ctrl-D (1st) | Ctrl-D (2nd, 800 ms) |
| --- | --- | --- | --- | --- | --- | --- |
| idle, empty, session | status hint `press Ctrl-C again to exit` | exit 0 | no-op | rewind/steer menu (`/rewind` picker) | hint `press Ctrl-D again to exit` | exit 0 |
| idle, empty, one-shot (after run:end, only during the epilogue frame) | exit with the run's code | — | no-op | — | exit | — |
| idle, text (either) | clear draft → history (`kind:'prompt'`, unsent) | as idle-empty | no-op (single Esc never destructive) | clear draft → history | delete-forward | — |
| live, empty, one-shot | `shutdown('human_abort')` → checkpoint → exit 130 | `process.exit(130)` while `aborting` (DESIGN §11) | `engine.pause()` → `human_pause` at the next boundary → exit 4 | `engine.abort('human_abort')` → exit 130 | hint `run is live — Ctrl-D again exits after aborting` | abort → exit 130 |
| live, empty, session | `engine.abort('human_abort')` → checkpoint → `run:end` item (exit 130 shown), composer reopens, **no exit** | `process.exit(130)` if still `aborting`; else (run already ended) exit 0 | `engine.pause()`; status `pausing after step N`; `run:end human_pause` item | abort as Ctrl-C | hint | abort, then exit 0 |
| live, text (either) | clear draft → history; never aborts while text is present | as live-empty | Esc Esc clears the draft (first Esc arms) | clear draft → history | delete-forward | — |
| review pending (either) | decline the review **and** `engine.abort('human_abort')` (A110) | `process.exit` | decline (`n`) | — | ignored | — |
| palette / picker / help / history open | close the overlay (draft kept) | as idle | close | — | ignored | — |
| secret gate | dismiss gate + clear draft → history | as idle | dismiss (draft kept) | — | dismiss | — |
| budget confirm | cancel (draft kept) | as idle | cancel | — | ignored | — |
| blocking pane | `[q]` semantics of that pane | `process.exit` | no-op | — | ignored | — |
| wizard / trust | fix block to stderr, exit 2 | — | clear field / step back | — | ignored | — |
| `aborting` set (any) | `process.exit(130)` immediately, sync `state.json` (DESIGN §11) | — | ignored | — | ignored | — |

`--no-input`: every prompt takes its safe default; keys are never read (C46).

### 3.3 Session state machine (`SessionController`, §20 slot S2)

```
            ┌────────────────────────── /exit · Ctrl-D×2 · Ctrl-C×2(idle) ───────────────────────────┐
            ▼                                                                                          │
 [boot] → first frame → probe(missingSecrets, trust, index fold, git) ─┬─ wizard → trust → sandbox ─┐  │
                                                                       └───────────(nothing missing)─┴─▶ IDLE ──Enter(text)──▶ STARTING ──run:ready──▶ LIVE
   IDLE: composer active; /resume, /undo, /rewind, /diff, /budget, picker, help allowed              ▲        (budget-confirm may interpose: y → clamp, r → /budget, n → IDLE)
   LIVE: Enter = steer (queue ≤ 8); Esc = pause request; Ctrl-C = abort; review/secret/blocking panes nest │
   LIVE ──run:end (any StopReason)──▶ ENDED(item: exit code, epilogue block) ──(automatic)──▶ IDLE          │
   IDLE ──/resume <id>──▶ STARTING(resume) ; IDLE ──/new──▶ IDLE(new sessionId, meter reset)                │
   any ── fatalExit ──▶ restore terminal → epilogue → exit                                                    │
```

Invariants: at most one live engine per process; the composer is never disabled except under `review`,
`budget-confirm`, `blocking`, `wizard`; `<Static key={sessionId}>` remounts (small array) only on `/new` and at the
20,000-item soft cap (A25, A28, C27).

## 4. Composer

### 4.1 `TextBuffer` (`src/tui/composer/buffer.ts`, pure)

```ts
export interface TextBuffer {
  text: string;          // logical text, '\n' separated; never contains C0 except '\n' and '\t'
  cursor: number;        // UTF-16 index, always on a grapheme boundary (Intl.Segmenter oracle)
  anchor: number | null; // selection anchor (shift-arrows in kitty terminals only; v1 keeps it null)
  killRing: string[];    // <= 16 entries, newest first; survives submit
  yankIndex: number;     // for M-y cycling
  undo: { text: string; cursor: number }[];   // <= 100 snapshots (A1)
  redo: { text: string; cursor: number }[];
  coalescing: boolean;   // consecutive single-grapheme inserts share one undo step
  history: { index: number | null; draft: string | null; filter: string };  // index into the history list; draft = text before browsing
  chips: number;         // count of [Pasted #n, k lines] chips present (bodies live in a useRef Map, §10.3)
}
export type BufferAction =
  | { type: 'insert'; text: string; pushToUndo?: boolean }      // already filtered (§4.9); graphemes inserted at cursor
  | { type: 'newline' } | { type: 'backspace' } | { type: 'delete' }
  | { type: 'move'; unit: 'grapheme' | 'word' | 'line-start' | 'line-end' | 'row-up' | 'row-down' | 'buffer-start' | 'buffer-end'; dir: -1 | 1; columns: number }
  | { type: 'kill'; what: 'to-line-end' | 'to-line-start' | 'word-back' | 'word-forward' }
  | { type: 'yank' } | { type: 'yank-cycle' } | { type: 'transpose' }
  | { type: 'undo' } | { type: 'redo' }
  | { type: 'set-text'; text: string; cursor?: number; pushToUndo: boolean }   // history recall, external editor, take-back
  | { type: 'clear' }                                                          // Ctrl-C / Esc Esc: saves the draft to history first (caller)
  | { type: 'paste'; text: string; chip: { n: number; lines: number } | null } // one undo step
  | { type: 'history'; dir: -1 | 1; entries: readonly string[] }
  | { type: 'submit' };                                                        // returns text; resets undo/redo, keeps killRing
export function reduce(b: TextBuffer, a: BufferAction): TextBuffer;
```

Grapheme motion uses one module-level `new Intl.Segmenter(undefined, { granularity: 'grapheme' })` (constructor
5.58 ms once, 251 ns/grapheme; 12 §7); word motion uses `granularity: 'word'` with `isWordLike`, whitespace-delimited
for Ctrl-W (readline `unix-word-rubout`). Tabs are expanded to spaces on insert (Ink ignores tabs in width, 08 §8).

### 4.2 `cellWidth` (`src/tui/composer/width.ts`) — replicates `string-width@8.2.2` (A2, C20)

Rules in order: (1) zero if the cluster matches `/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v`; (2) `/^\p{RGI_Emoji}$/v` → 2; (3) keycap `^[\d#*]️?⃣$` and ZWJ sequences with ≥ 2 `\p{Extended_Pictographic}` → 2; (4) Hangul L+V(+T) → 2; (5) East Asian Width of the first visible scalar, Wide/Fullwidth → 2 from a generated `eaw-table.ts` (125 + 3 ranges, binary search, Unicode version in a comment), ambiguous → 1. `displayWidth(s)` sums clusters; a fixture test compares 400 strings against `string-width` (devDependency-visible) (A108). Never `string-width` at runtime (R27).

### 4.3 Layout, viewport and cursor

`layoutRows(buffer, width): Row[]` with `Row = { start, end, hard, cells }`: split on `\n`, soft-wrap by
accumulated `cellWidth` at `columns − gutter(2)`, break after spaces when possible, never inside a grapheme. The
composer box is `height={layout.composer}`, `overflow="hidden"`; `scrollTop = clamp(scrollTop, cursorRow − h + 1,
cursorRow)`; rows are pre-sliced strings in `<Text wrap="truncate">` (never re-wrapped by Ink); gutter shows `› ` on
the first visual row, two spaces on continuation rows, `↑N`/`↓N` markers at the right edge when rows are hidden.
Real cursor: `useCursor().setCursorPosition({ x: 2 + cursorX, y: composerTop + cursorRow − scrollTop })` computed
during render from summed widths; `undefined` while a modal overlay owns input; `DECSCUSR` steady bar (`CSI 6 SP q`)
once at mount, reset in the exit string (A3, A80).

### 4.4 Paste lifecycle (A4, F9)

`usePaste(text)`: normalise `\r\n`/`\r` → `\n`; strip C0/ESC except `\n\t` and CSI bodies; hard cap 1 MiB (toast
`paste of 3.2 MB refused (limit 1 MiB); write it to a file and @-mention it`); if `> 3 lines || > 800 chars` →
insert the chip `[Pasted #n, k lines]` and store `{ text, lines, bytes, sha256 }` in `pasteRef: useRef<Map<number,
PasteBlob>>` (never state, reducer, events, logs); else insert inline; one undo step; never submits. A multi-char
`useInput` chunk without ESC is paste-like (C21). At submit chips expand in order; a chip without a body (after
`--resume` of a `ui.json` draft) cancels the submission with `remove [Pasted #1] or paste again`. When the expanded
text exceeds 12,000 chars the notice `only the first 12,000 characters reach the generator; @-mention a file for more`
is appended as a `notice` item (P44/C50). `ui.json` (`<runDir>/ui.json`, written at checkpoint boundaries and
shutdown only) stores `{ text: redacted, cursor, chips: [{ n, lines, bytes, sha256 }] }`.

### 4.5 History (A60, F7)

`~/.jevcode/history.jsonl` lines `{ t, workspace, kind: 'prompt' | 'steer' | 'command', text }`; `text` =
`config.redact(expandChipsAsLabels(sanitizeStream(draft)))` written after `addSecret` (§10.2); chip label
`[Pasted #1, 120 lines]` + first redacted line clipped to 40 chars (P58 decision: label + first line, no hash);
4 KiB/entry; 1,000 entries with atomic rewrite; consecutive duplicates dropped; off for `source !== 'cli'`,
`--no-history`, `JEVCODE_NO_HISTORY=1`; `/history clear`. Recall: Up at the first row / Down at the last row / C-p /
C-n over the workspace-filtered list (Ctrl-A widens); the current draft is kept in `history.draft` and restored on
Down past the newest. `Ctrl-R`: 8-row overlay (`history` kind), reverse-incremental, live preview in the composer,
Esc restores the draft, Tab/Esc accept, Enter submits.

### 4.6 Kill ring, undo/redo, external editor

Kill ring ≤ 16, `C-y` yank, `M-y` cycle (replaces the last yank), survives submit. Undo ≤ 100 snapshots, coalesced
single-grapheme inserts, `set-text` pushes one snapshot; `C-_` undo, `M-_` redo. `Ctrl-G`: write the buffer to
`<runDir or ~/.jevcode/tmp>/compose-<pid>.md`, `await useApp().suspendTerminal(() => spawn($VISUAL ?? $EDITOR ?? 'vi', [file], { stdio: 'inherit' }))`, read back, `set-text` with one undo snapshot; engine events arriving
during the suspension are queued by the bus and dispatched after `resume()` (A11, 08 §5).

### 4.7 Newline keys and submit

Newline: `input === '\n'` (Ctrl-J), `key.return && key.meta` (Alt+Enter / `ESC CR`), `key.return && (key.shift ||
key.ctrl)` (kitty `CSI 13;2u`/`13;5u`), trailing `\` + Enter (the backslash is removed), and the xterm leak
`/^\[27;[2-8];13~$/` swallowed as newline (A6). Submit: `key.return` with no modifiers and a non-empty buffer;
re-entrancy guard (A9); `exit`/`quit`/`:q` typed alone exit like `/exit`.

### 4.8 Submit pipeline (session mode)

```
text = expandChips(buffer.text)          → sanitizeStream → detectSecrets (§10.1) → [secret gate row: only 'y' continues]
  → starts with '/' at column 0 → slash dispatcher (§5.2)
  → engine live?  yes → engine.steer(text) → 'steer:queued' item + history kind 'steer'
                  no  → follow-up / first run: budget check (§9.3) → controller.startRun({ task: text, seed }) → history kind 'prompt'
  → buffer 'submit' (clears text; keeps killRing; pushes nothing to undo)
```

### 4.9 Input filter (A5)

Drop when `key.ctrl || key.meta || key.super || key.hyper` and the key is not a bound chord; drop
`eventType` release/repeat; drop code units `< 0x20` except `\t` and the newline keys; drop `0x7f`; drop CSI leak
strings matching `/^\[(?:I|O|\?\d+u|\d+;\d+R|27;\d;\d+~|\?\d+;\d+c|<\d+;\d+;\d+[Mm])$/`; drop OSC fragments
`/^\]\d+;/` and `\\`; strip bidi controls U+202A–202E, U+2066–2069, normalise U+2028/2029 → `\n` (A88). The
30 ms Esc re-buffer: a lone `escape` is held 30 ms; if a printable follows within 30 ms it is `Alt+<char>` (07 §1.5).

### 4.10 Secret gate row (F9, A154)

One row above the composer: `Looks like this contains a secret (sk-…). Send anyway? y/N` (plural / `your
OPENROUTER_API_KEY` variants). `y`/`Y` → §10.2 `addSecret` then continue the pipeline; any other key dismisses,
keeps the draft, is handled normally; dismiss shows a one-frame tip `Tip: put it in .env and refer to it by name`.

## 5. Palette, slash grammar, commands, `@` mention, fuzzy scorer

### 5.1 Palette (A34)

`/` typed at column 0 of an empty composer opens the palette pre-filled; the composer keeps the text and drives the
filter. ≤ 8 rows, fzf reverse layout (rows above the prompt), `▸` marks the selection, `▲ i/N`/`▼ i/N` on the first
and last visible rows, label column ≤ 50 % width, dim ghost text `+N` for the completed token. Tab completes the
command name (and cycles argument enumerations); Enter runs only on an exact match, otherwise submits the typed text
and reports `unknown command /bu — Tab completes, ? lists` as a `notice` item (R18). Esc closes and remembers the
typed token. Rows are hidden when `availableDuringTask` excludes them for the current state (dim with `(idle only)`).
Project commands `.jevcode/commands/<name>.md` (`description`, `argument-hint`, `$ARGUMENTS`) appear with `[Project]`
(A63); they expand to composer text and never run shell.

### 5.2 Slash grammar (`src/commands/parse.ts`)

```
line      := '/' name (WS arg)* WS?
name      := [a-z][a-z0-9-]*            // aliases resolved by the registry
arg       := bare | '"' (escaped | [^"])* '"' | "'" [^']* "'"
bare      := [^\s"']+                    // `--flag` and `--flag=value` are ordinary args parsed by the command
escaped   := '\\' ["\\]
```

Tokeniser errors (unterminated quote) → `notice` item `unterminated quote in /rename "tz …` and the line stays in
the composer. Each command declares `args: ArgSpec[]` with `{ name, kind: 'enum' | 'number' | 'usd' | 'step' |
'run-id-or-title' | 'path' | 'text' | 'flag'; values?: string[]; optional?: boolean; rest?: boolean }`; the
dispatcher validates before calling `run`, and rejects with the command's own one-line message (e.g. `/budget
spend-cap 1.20 is not above this run's spend $1.532; give a larger value`, 14 §4.4). Argument completion: enum values
on Tab, run ids/titles from the index fold, paths from the mention candidate list, steps from the last run's
`steps.jsonl` step numbers (never read for this — the reducer already holds `step:end` records). Unknown args →
`usage: /diff [step] [--full] [--all]`.

### 5.3 Command table (`availableDuringTask`: idle = no live engine in this process; live = engine live; both)

| Command | Args | Semantics (one line) | Avail. | Plain |
| --- | --- | --- | --- | --- |
| `/help [topic]`, `/keys` | topic? | help overlay / key sheet from the registry (A16, A21) | both | yes |
| `/new` | — | end the session; new `sessionId` on the next run; new session meter; `<Static key>` remount with a header only | idle | yes |
| `/resume [id\|title]`, `/sessions` | run-id-or-title? | picker (§8.5) or resume that run; `--force` semantics as the flag when `complete` | idle | `/resume <id>` only |
| `/rename <title>` | text | index `rename` line; status centre zone | both | yes |
| `/pause` | — | `engine.pause()` = Esc | live | yes |
| `/abort` | — | `engine.abort('human_abort')` | live | yes |
| `/steer <text>` | rest text | same as Enter while live (for `--plain`) | live | yes |
| `/unsteer` | — | pop the last queued directive (= Up on the first row) | live | yes |
| `/undo [n]` | step? | verify-before-write revert of the last step with changes (§12.4) | idle | yes (y/N prompts via readline) |
| `/rewind [n]` | step? | undo steps last…n; then offer files / plan+window / both for the next seed (§12.5) | idle | yes |
| `/diff [step] [--full] [--all]` | step?, flags | inline numstat block; step view; pager (§12.6) | both (`--full` idle) | yes (inline only) |
| `/plan` | — | `<Static>` block: done/remaining/unverified/problems with bands (11 §4c twin) | both | yes |
| `/decisions [n] [stage]` | number?, enum? | last n decision rows as items | both | yes |
| `/why <id>` | `s7.risk.plan_mismatch` \| digit | `/why` block (§7.5) | both | yes |
| `/calibration` | — | reliability block over `decisions.jsonl` of this session's runs (§7.5) | idle | yes |
| `/jev` | — | decider id, resolved/drift, questions, latency p50/p95, cost | both | yes |
| `/cost` | — | 12-row block (14 §5.4) | both | yes |
| `/budget [spend-cap\|session-spend-cap\|max-steps\|max-wall\|max-replans <v>]` | enum, usd/number | show or set (§9.4) | both (run caps pending while live) | yes |
| `/model <id>`, `/provider <p>`, `/mode <m>` | text/enum | pending for the next run only (A58); stored in memory | both | yes |
| `/config` | — | read-only `maskEntries` table with sources + sandbox footer as items | both | yes |
| `/login`, `/logout [generator\|jev]`, `/trust`, `/doctor` | enum? | §11 | both (`/login` overlay) | `/login` raw-mode prompt |
| `/status` | — | run id, session id, step/max, stage, sandbox, workspace, branch, stop reason | both | yes |
| `/export [file]` | path? | concatenated `transcript.log`s with run headers (§8.8) | idle | yes |
| `/copy [last\|proposal\|diff\|draft]` | enum | redacted clipboard (§10.5) | both | no |
| `/errors` | — | expand recent warnings/errors as items; clears `!n` | both | yes |
| `/report` | — | `~/.jevcode/reports/<run-id>/` bundle (§13.6) | idle | yes |
| `/theme <dark\|light\|daltonized\|ansi>` | enum | new items only (P20 decision) | both | no |
| `/history clear` | enum | truncate `history.jsonl` | both | yes |
| `/exit`, `/quit` | — | exit 0 always (`--exit-code=last-run` opt-in) | both | yes |
| `@<path>` | path | pin a file for the next step's context (P8 decision: scored and boosted by +0.5 on the context Noul, still under the 12-file/60 KB cap) | both | yes |

Not in v1: `!cmd` (C7), `/compact` (C36), `/share`, `/model` mid-run (R21).

### 5.4 `@` mention and the fuzzy scorer (A35, F17)

`@` opens an 8-row overlay over `engine.workspace.listCandidates()` (cached in the controller between runs; in idle
state the last run's list, refreshed by one `listCandidates()` when a run starts). One async search session per
query; stale results dropped; denylist §10.4. `src/commands/fuzzy.ts`:

```ts
export function score(query: string, candidate: string): number | null;   // null = not a subsequence
// prefix match: 1000 − candidate.length; else subsequence: Σ(bonus) − gaps − 0.1·candidate.length
// bonus per matched char: +10 at a word boundary (after / _ - . or lower→Upper), +5 consecutive to the previous match, +1 otherwise; query and candidate lower-cased once; ':', '_', '-' ignored for word-prefix matching (A34)
export function rank(query: string, candidates: readonly string[], limit = 8): { candidate: string; score: number }[];
```

O(|q|·|c|) with an early-out on the first missing character and a precomputed lower-cased candidate array; the unit
test measures `rank('cmpsr', 5000 paths)` × 50 queries and asserts p95 ≤ 16 ms (F17).

## 6. Review prompt (F6)

Header 8 rows (title · keys · ruler · 4 gauges · `matches_intent`), preview ≤ 8, keys on row 2 (A39, A42).
80-column rows are frame D above; 120-column rows are 11 §4b's wide form. `confirmHeaderLines()` in `plain.ts` is
rewritten to return exactly these 8 lines (`CONFIRM_HEADER_ROWS = 8`); the plain/readline confirmer prints the same
lines and the keys line becomes `[y] approve  [n] decline  [d] decline+note > ` with the note on the same line
(`d make it a unit test first`). Gauge row: `dimension(13) L<k>  bar10(risk, band track ·/yellow/red)  risk  bnd
conf[~]  level text (truncated)`; bar cells = `round(risk × 80) / 8` eighth blocks over `·`.

Invariants: never `always`/session approval, no Enter default, no highlighted option, no approve-on-timeout, no
`--auto-decline` (A40, R17). Deferral: the box renders only after the composer has been idle ≥ 1,000 ms **and** Ink's
input queue is drained (a `pendingConfirm` arriving during typing shows `review waiting for you to finish typing` in
the status left zone; the engine keeps waiting on `confirmer.confirm`) (A41). `e` toggles `review.expanded` (pane → 0,
preview takes the rest). `w` + `1`–`5` appends the `/why` block for that gauge row. `d` turns the composer row into
`note › ` (≤ 600 chars, one line, same input filter); Enter sends `{ approved: false, note }`.

Decline note path: `Confirmer.confirm()` resolves `{ approved: false, note }` (§15 item 22); the engine builds
`reason = 'declined by reviewer: <risk reason> — note: <redacted note>'`, sets `draft.outcome = { status: 'declined',
reason }` and pushes `human note: <note>` into `draft.notes` so the window entry's `notes[]` carries it; the
generator sees both through the window (`reason:` and `note:` lines, prompts.ts 192–194) and Jev sees it in
`recent[i].notes` (P6 decision: yes, ≤ 600 chars). Bench: `alwaysDecline` returns `false` unchanged.

Twins: `--plain` prints the 8 header lines + preview then the readline prompt; `--screen-reader` renders a numbered
list `1 approve 2 decline 3 decline with note 4 expand 5 why` and `Enter selection (1-5):` with typed `y`/`n` still
accepted, one BEL when the box appears (A95).

## 7. Jev-native pane and status line (F16)

Tabs `d` `p` `t` `s`, `[`/`]` cycle; the rule row is the tab header (frame B). Rows per 11 §4a/4c/4d/4f:
decisions `s7 stage id answer bar10 p c[~] [verdict]` (+ latency and text at ≥ 120); plan `[x] [ ] [?] [!]` with
step and `done_j` probability; timeline two rows per step at 80 (`I C P R X J` letters, N = 40), one row at 120
(N = 30, tokens, cost); synth strip renders `detail` verbatim until the structured `synth` fields land (A48; the
structured extension stays owned by the synth team and is *not* in §15). Loop banner row (A45) while a signature is
at x2/3 or a `replan` problem is active. Status line zones: left `step N/M` sentinel (kept first for
`perf/first-frame.ts`; deviation §22) then stage word + spinner/`retrying 2/3`/`offline`/`paused: <reason>`/`disk ×N`
/`!n`/`sandbox: none`; centre run id or title; right wall, `run $x/y word`, `sess $x/y word`, git zone (≤ 24 cells),
`jev p50 <ms> ▂▃…` sparkline (12 requests, fixed 0–1000 ms), `? help`. Column tiers: < 80 sentinel + stage + run
meter word; 80–99 + session meter (76 cells); 100–119 + title, git zone, sparkline, `? help`; 120–139 + 10-cell bars
(title clipped to 12 cells, sparkline and `? help` dropped to make room); ≥ 140 everything plus tokens (A46, A131). Toasts replace the left zone for 2 s (4 s errors) and are also items (A37).
Spinner: stage verb + elapsed, `still waiting` after 45 s, frozen while a review is pending, 1 Hz idle tick,
`|/-\` under `--ascii`, static marker under reduced motion (A50, A96).

`/why` block (≤ 60 lines detail, 11 §4h) and `/calibration` block (11 §4i) are `<Static>` items computed from the
in-memory decision rows (this run) or from `decisions.jsonl` of the session's runs (idle), zero engine change (A47).

## 8. Sessions

### 8.1 Data model

```
~/.jevcode/runs/<run-id>/                      unchanged files, plus:
  run.json          RunMeta + sessionId, parentRunId, source, title?, git, instructions[]  (all optional → v1 readers unaffected)
  state.json        CheckpointState + pendingDirectives?, undoLog?, checkpointDegraded?   (envelope version stays 1: additive)
  steps.jsonl       StepRecord + planAfter?                                               (bench readers ignore unknown keys)
  pre/<step>/<sha256(relpath)>   pre-images (edit|write|patch targets; dirty set before `run`)
  post/<step>.json  post-image hashes (§12.3); post/<step>.undone.json after /undo
  ui.json           redacted draft + chips (§4.4)
  jevcode.log       per-run log (§13.6)
  run.lock          { pid, startedAt, host } while an engine holds the run (§8.4)
~/.jevcode/sessions/index.jsonl                append-only, ≤ 512-byte lines, v:1 (§8.2)
~/.jevcode/history.jsonl                       §4.5
~/.jevcode/trust.json                          §11.4
~/.jevcode/logs/jevcode-<pid>-<stamp>.log      pre-run logs (newest 10)
~/.jevcode/reports/<run-id>/                   §13.6
```

`sessionId` = the first run's id; a follow-up run has `parentRunId` = previous run of the session (any stop reason);
`/resume` of a run keeps its `sessionId`. Legacy runs (no `sessionId`) read as one-run sessions with `sessionId =
runId`, `source = workspace.includes('/bench-work/') ? 'bench' : 'cli'` (A52).

### 8.2 `sessions/index.jsonl` line schemas (every line `≤ 512` bytes after redaction; torn last line skipped)

```jsonc
{"v":1,"t":"2026-09-20T14:02:11.123Z","kind":"run:start","sessionId":"20260920-140211-k7q2m6xa","runId":"20260920-140211-k7q2m6xa","parentRunId":null,"workspace":"/Users/me/proj","task60":"fix parse_date tz handling","mode":"jev-on","source":"cli","branch":"main","resumeOf":null}
{"v":1,"t":"…","kind":"run:end","sessionId":"…","runId":"…","stopReason":"complete","steps":9,"costUsd":{"generator":0.104,"jev":0.011},"wallMs":183000,"changedFiles":3,"exitCode":0,"resumable":true,"degraded":false}
{"v":1,"t":"…","kind":"rename","sessionId":"…","title":"tz fixes"}
{"v":1,"t":"…","kind":"steer","sessionId":"…","runId":"…","step":4,"text60":"also update the docs"}
{"v":1,"t":"…","kind":"undo","sessionId":"…","runId":"…","step":7,"by":"undo","files":3,"skipped":1}
{"v":1,"t":"…","kind":"pause","sessionId":"…","runId":"…","step":5}
{"v":1,"t":"…","kind":"budget","sessionId":"…","runId":"…","setting":"session.spendCapUsd","from":"10","to":"15"}
```

Writer: `appendFileSync(path, line + '\n')` with `O_APPEND` (one syscall per line; ≤ 512 B keeps the append
practically atomic on APFS/ext4; P11 decision: no lock file, `jevcode sessions reindex` is the repair path). Written
only when `source === 'cli'`. `run:start` is appended right after `store.create(meta)` (fresh run) or after a
successful resume load (`resumeOf: <previousStop>`); `run:end` after `finish()`'s final `writeState`.

Fold (`src/session/index.ts`):

```ts
export interface SessionRow { sessionId; workspace; title: string; task60; runs: RunRow[]; lastUsed: string; createdAt: string; totalUsd: number; mode; branch: string | null }
export interface RunRow { runId; parentRunId; startedAt; endedAt: string | null; stopReason: StopReason | null; steps: number | null; costUsd: { generator: number; jev: number } | null; exitCode: number | null; resumable: boolean | null; resumes: number }
export function foldIndex(lines: readonly string[]): { sessions: Map<string, SessionRow>; skipped: number }   // group by sessionId; per runId last run:start/run:end win; title = last rename else first task60; lastUsed = max t over all kinds
export function readIndex(path: string): Promise<{ sessions: SessionRow[]; skipped: number }>               // one readFile; 0.26 ms @141 runs (14 §2.2)
export function appendIndexLine(path: string, line: IndexLine, redact: Redact): void                          // sync O_APPEND, clip text60/task60, drop if > 512 B after JSON.stringify
export function reindex(runsDir: string, out: string): Promise<{ runs: number }>                              // run.json + stat(state.json).mtime (9.5 ms/141)
```

The fold runs at session open, `/resume`, `run:end` and `budget:override` only; the in-memory `SessionRow` is
authoritative between (A139).

### 8.3 Picker (A55, A56)

Rows `time ago │ steps │ stop │ $cost │ title-or-task60 [│ workspace] [│ ⎇ branch]`, default scope = `workspace`
realpath, Ctrl-A widens, sort updated (default) / created (`/resume --sort created`). Colours: complete green +
word, budget stops yellow, error red, `human_pause` dim — every cell carries its word (A97). Space parses that run's
`state.json` (≤ 30 KB) and tails 4 KB of `transcript.log` (0.71 ms) into 4 preview rows after the first frame; Enter
resumes (opens the follow-up composer on that session with the resumed run as `parentRunId`; a `complete` run
resumes only with `/resume <id> --force`, otherwise Enter starts a follow-up seeded from it); Ctrl-R rename; `x`
delete = move `<run-id>/` to `~/.jevcode/trash/` (never `rm -rf`) after `delete run <id>? y/N`; `-c/--continue` =
the row with the greatest `lastUsed` in this workspace. `--resume <title>` matches `title` exactly, then case-insensitively,
then as a unique prefix; ambiguity → `ConfigError` listing the candidates. `--list-sessions` prints the rows.

### 8.4 `run.lock`

`{ "pid": 4242, "startedAt": "…", "host": "mbp.local" }` written by `createEngine` after `store.create`/load, removed
in `finish()`. On resume: a lock whose `pid` is alive (`process.kill(pid, 0)` succeeds and `host` matches) → refuse
with `ConfigError` `run <id> is in use by pid 4242 since <t> (another jevcode?); jevcode sessions unlock <id> if that
process is gone` (exit 2); dead pid → replaced. The picker shows `● live` on such rows (item 13 of 00 §8 closed).

### 8.5 Follow-up seeding algorithm (`src/session/seed.ts`, pure; A52, 10 §15.2)

```ts
export function buildSeed(parent: { meta: RunMeta; state: CheckpointState }, opts: { humanNotes: string[] }): RunSeed {
  const plan: Plan = {
    done: parent.state.plan.done,                                          // verbatim, with evidence
    remaining: parent.state.plan.remaining, unverified: parent.state.plan.unverified,
    openProblems: [],                                                      // generator-owned, replaced each step
    harnessProblems: [
      { kind: 'human', step: 0, text: `follow-up in session ${meta.sessionId ?? meta.runId}: continues run ${meta.runId} (stopped: ${state.stopReason ?? 'in progress'}) whose task was "${clip(meta.task, 200)}"; the task above is the human's next instruction` },
      ...opts.humanNotes.map((t) => ({ kind: 'human' as const, step: 0, text: clip(t, 600) })),   // 'human reverted step 7: …' from /undo, '/rewind plan+window to step N'
    ],
  };
  const window = parent.state.window.slice(-4).map((e) => ({ ...e, notes: [...e.notes, `from run ${meta.runId}`].slice(0, 12) }));
  return { parentRunId: meta.runId, plan, window, createdThisRun: parent.state.createdThisRun, lastTestRun: parent.state.lastTestRun, undoLog: parent.state.undoLog ?? [] };
}
```

Engine side (constructor, `init.resume === null && opts.seed`): `this.plan = seed.plan; this.window = seed.window;
createdThisRun ← seed; lastTestRun ← seed; lastChangeStep = null` (so `testsCurrent` is recomputed honestly);
spend, wall, loop detector, `resolvedJevModel` start fresh. Step 1 Plan rule (b): `applyPlanDraft({ …, humanDirective:
true })` lets the generator drop `remaining` items the follow-up made obsolete (10 §15.2 rule 2; `plan.ts` gains the
optional flag, no `replan` problem is recorded). Transcript: `[run] seeded from run <id>: plan done=4 remaining=2
unverified=1 · window 4 entries · 3 created files` (`notice kind:'seeded'`). The completion Noul judges the new task
alone (P7 decision: follow-up text; the parent task is visible through the `human` problem).

`/rewind` `plan+window` to step N changes the seed source: `plan = steps[N].planAfter` (or the checkpoint plan when
`planAfter` is absent, with a notice) and `window = entries with step ≤ N` from the parent's `state.window`.

### 8.6 Steering: consumption algorithm in the engine (A53, 10 §15.3)

```ts
// Engine
steer(text) {
  if (this.lastResult !== null) return { ok: false, reason: 'finished', queued: this.pendingDirectives.length };
  const t = this.redact(clip(text.trim(), 600));
  if (t.length === 0) return { ok: false, reason: 'empty', queued: … };
  if (this.pendingDirectives.length >= 8) return { ok: false, reason: 'full', queued: 8 };
  const d = { text: t, at: nowIso(), index: ++this.steerSeq };
  this.pendingDirectives.push(d);
  this.emit({ type: 'steer:queued', step: this.step + 1, index: d.index, text: t, queued: this.pendingDirectives.length });   // transcript item `steer queued (1) for step 8: …`
  return { ok: true, index: d.index, queued: this.pendingDirectives.length };
}
unsteer() { const d = this.pendingDirectives.pop() ?? null; if (d) this.emit({ type: 'steer:withdrawn', step: this.step + 1, index: d.index }); return d; }
pause() { if (this.lastResult || this.pauseRequested) return; this.pauseRequested = true; this.emit({ type: 'pause:requested', step: this.step + 1 }); }

// main() loop — the only consumption point: a §9.1 rule-1 boundary, after checkBudgets(), before runStep()
for (;;) {
  if (this.signal.aborted) return this.finish(classifyAbort(this.signal.reason).stop);
  if (this.pauseRequested) return this.finish('human_pause');
  const budget = checkBudgets(this.budgetInput()); if (budget !== null) { …; return this.finish(budget); }
  this.applyPendingDirectives();                                          // NEW
  const result = await this.runStep(); …
}
private applyPendingDirectives(): void {
  if (this.pendingDirectives.length === 0) return;
  const step = this.step + 1;
  const texts = this.pendingDirectives.map((d) => d.text);
  const text = clip(texts.join('\n'), 600);
  // plan mutation at a boundary (no step in flight; the previous checkpoint is pending or written): replace the previous human problem
  this.plan = { ...this.plan, harnessProblems: [...this.plan.harnessProblems.filter((h) => h.kind !== 'human'), { kind: 'human', text, step }] };
  this.activeHuman = { text, step };                                        // prompt hint + Jev state for THIS step only (§15 item 17)
  this.detector.resetCounts();                                              // counts and `tripped` cleared; trips history and replanCount kept
  this.pendingDirectives = [];
  this.emit({ type: 'steer:applied', step, count: texts.length, chars: text.length });   // item `steer applied to step 8 (2 directives)`
}
```

`buildCheckpointState()` includes `pendingDirectives` (so a steer queued before a crash survives `--resume`) and the
plan already carries the applied directive. `promptInput()` renders `activeHuman` when `activeHuman.step === draft.step`
as `- Instruction from the human (step 8): <text>` in the hints section; `commonState()` passes `human: activeHuman`
(same step rule); `synthesisContext()` sets `directive: [draft.directive?.text, activeHuman?.text].filter(Boolean).join('\n\n') || null`.
`y`/`n` while a review is pending and slash commands never steer.

### 8.7 Pause (A54, F5)

`human_pause` = `finish('human_pause')` at the loop top: the in-flight step commits whole first (Esc is checked
only at the boundary), `state.stopReason = 'human_pause'`, exit-4 family, `storedStopBlocks()` and `BUDGET_STOPS`
exclude it so `/resume` proceeds normally, `run:end` item `end human_pause steps=5 … (exit 4) · /resume continues,
or type a follow-up`. Status left zone reads `pausing after step N` between Esc and `run:end`. Index line `pause`.

### 8.8 `/export`, `--json` stream

`/export [file]` writes `<file | ~/.jevcode/exports/<sessionId>.txt>`: for each run in order `=== run <id> · <t> ·
<task60> · <stopReason> · $<cost> ===` then the run's `transcript.log` verbatim (already redacted), then `--- undo/
rewind/steer events from the index ---`. `--json` (`src/cli/json-stream.ts`): NDJSON, one line per `EngineEvent`
plus envelope `{ v: 1, t, runId, sessionId }`; extra lines `session:start { sessionId, runId, parentRunId, workspace }`
and `session:end { reason: 'exit' | 'error', runs }`; `run:end` carries `exitCode`, `resumable`, `paths`; `user`
lines carry the redacted human text (A158); `secret-ack` carries `count` only (P59); no countdown ticks; `v` bumps
only when an existing field changes meaning; consumers ignore unknown `type`s. Redaction guarantee wording = 16 §4.7
verbatim in DESIGN §10 and `--help`.

### 8.9 A ten-run session, state by state (workspace `proj`, session `S = 20260920-140211-k7q2m6xa`)

| # | Human act | Run / engine effect | `state.json` | index lines | seed of next run | meter (run / session, cap $2 / $10) | item exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Enter "fix parse_date tz handling" | fresh run R1, `sessionId=S`, `parentRunId=null` | `stopReason: complete` step 9 | `run:start`, `run:end complete` | — | $0.115 / $0.115 | 0 |
| 2 | Enter "now update the docs"; at step 3 types "keep CHANGELOG format" Enter | R2 seeded from R1 (`plan.done` 4, window 4 `from run R1`); `steer:queued` (step 4) → `steer:applied` at step 4 start, `plan.harnessProblems[human]`, loop counts reset | `complete` | `run:start parent=R1`, `steer step 4`, `run:end` | — | $0.30 / $0.415 | 0 |
| 3 | Enter "add tests for edge cases"; Esc at step 5 | R3; `pause:requested`; step 5 commits; `finish('human_pause')` | `human_pause` step 5, `pendingDirectives: []` | `run:start`, `pause step 5`, `run:end human_pause exit 4` | — | $0.41 / $0.83 | 4 |
| 3b | `/resume` | R3 resumed (`resumes: 1`, `stopReason` cleared); `run:start resumeOf=human_pause` | `complete` step 12 | `run:start resumeOf`, `run:end complete` | — | $0.88 / $1.30 | 0 |
| 4 | Enter "refactor date helpers"; cap fires | R4 stops `spend_cap` at step 23 (`stoppedAt: step_start`); epilogue block names `/budget spend-cap 3.00 then /resume` | `spend_cap` | `run:start`, `run:end spend_cap exit 4` | — | $2.03 / $3.33 (over) | 4 |
| 4b | `/budget spend-cap 3` then `/resume` | pending run cap → `reconcileResumeConfig` override `{ limits.spendCapUsd 2 → 3, atStep 23 }` in `run.json.overrides[]`; `budget:override` | `complete` step 31 | `run:start resumeOf=spend_cap`, `run:end` | — | $2.71 / $4.01 | 0 |
| 5 | Enter "migrate loader to TOML"; Ctrl-C during propose at step 6 | rule 1: step 6 discarded, `state.interrupted = { step 6, propose, proposal }`, `human_abort`; composer reopens (no exit) | `human_abort` step 5 | `run:start`, `run:end human_abort exit 130` | — | $0.52 / $4.53 | 130 |
| 6 | Enter "finish the TOML migration but skip legacy/" | R6 seeded from R5's checkpoint (step 5 plan; the discarded proposal is not in the seed) | `complete` step 14 | … | — | $0.98 / $5.51 | 0 |
| 6b | `/undo` (idle) | last step with changes = R6 step 13: hashes equal → 3 restored, 1 skipped (`run`-changed untracked) → `post/13.undone.json`, `undoLog` entry in the *next* seed, index `undo` | R6 unchanged (immutable) | `undo step 13 files 3 skipped 1` | `humanNotes: ['human reverted step 13: src/a.py, …']` | — | — |
| 7 | Enter "rerun the suite"; the key was revoked | first Jev call 401 → blocking pane; `[q]` → `run:end error` exit 2 item; composer reopens with `/login` hint | `error` step 0 | `run:start`, `run:end error exit 2` | seed carries R6's plan + the undo note | $0 / $5.51 | 2 |
| 7b | `/login` → new Jev key | `addSecret` immediately; `saved — applies to the next run`; `resolveConfig` re-run | — | — | — | — | — |
| 8 | Enter (same text) | R8 seeded from R6 (R7 had step 0; seed source = the latest run with `step > 0`, rule below) | `complete` | … | — | $0.64 / $6.15 | 0 |
| 9 | Enter "polish error messages" | `remaining = 10 − 6.15 = 3.85 ≥ 2` → no confirm; R9 `complete` | … | … | — | $1.71 / $7.86 | 0 |
| 10 | Enter "final cleanup pass" | `remaining = 2.14 ≥ 2` → no confirm; at step 19 the session cap trips through the child clamp (`parentExceeded`) → `spend_cap by session`; epilogue names `/budget session-spend-cap` | `spend_cap` | `run:end spend_cap` | — | $2.14 / $10.00 over | 4 |
| 10b | Enter "one more" | `remaining ≤ 0` → refusal item + toast; `/budget session-spend-cap 15` → index `budget`, root cap raised; Enter again → R11 starts clamped to `min(2, 5)`; `/export`; `/exit` | — | `budget 10 → 15`, `run:start` | — | — | `/exit` → 0 |

Seed source rule: the most recent run of the session with `state.step > 0`, else the most recent run; a run stopped
at step 0 (config/401) contributes nothing but is still the `parentRunId`.

### 8.10 Backward compatibility

`isCheckpointState`/`isRunMeta` (store.ts 108–146) check only v1 fields; every addition is optional, so old
`state.json`/`run.json` load unchanged and new ones load under the current binary. Envelope `version` stays `1`.
`foldStepsIntoState` and the bench's `steps.jsonl` readers destructure known keys and ignore `planAfter`. `BenchStopReason
= StopReason | 'not_run'` widens automatically; `bench/metrics.ts` treats `human_pause`/`token_cap` as non-pass
stops like every non-`complete` reason. `--resume` of a run whose `git.head` differs from the current HEAD warns
(A150, P52 decision: warn). Legacy `history`-less and `index`-less homes: the picker offers `jevcode sessions
reindex` when `sessions/index.jsonl` is absent and `runs/` is not empty.

## 9. Money (F8)

### 9.1 Meter tree

`main.tsx` (`commandChat`/`commandRun`) creates one `sessionMeter = createSpendMeter(sessionCapUsd)` per process
(`+Infinity` for `none`) and per run `runMeter = sessionMeter.child(Math.min(runCapUsd, remaining))` where
`remaining = sessionCap − sessionMeter.snapshot().totalUsd`. Seeding on `/resume`/`-c`: fold the index for `sessionId`,
`sessionMeter.add(source, usage)` per finished run's `run:end` costs, then add the resumed run's `state.json.spend`,
**then** `runMeter.restore(state.spend)` (A130; `restore()` never forwards). `SpendSnapshot.parentExceeded` and
`SpendSnapshot.parent = { totalUsd, capUsd }` (§15 item 7) let the engine emit session-scope warnings without
knowing the parent object. Bench/perf keep their own root.

### 9.2 Thresholds (A131)

After every `meter.add()` in `ask()`/`generate()` the engine computes `pct = floor(100 × total / cap)` per scope and
emits `budget:warn` once per `(scope, pct ∈ {50, 80, 95})` per run (run scope) / per session (session scope, tracked
in the controller by `sessionId`), highest only when one add crosses two, re-emitted once with `restored: true` after
a resume, never for `+Infinity`. Item text = 14 §4.2 verbatim (`[run] budget: run spend $1.600 is 80 % of the $2.000
run cap — about 10 steps left at $0.040/step`; session variant names `/budget session-spend-cap <usd>`); toast 2 s
(4 s at 95 %); meter word `half`/`high`/`critical`, `over` replaces `EXCEEDED`, `uncapped` (red) for `none`; BEL/OSC 9
only at 95 % and `budget:stop` when `ui.notify !== 'off'` and the terminal is unfocused; `JEVCODE_BUDGET_WARNINGS=0`
mutes toast and bell only. Jev-share suffix when `jev.costUsd > generator.costUsd` at a crossing.

### 9.3 Follow-up confirm (A132, frame H)

At Enter in `IDLE`: `remaining ≥ runCap` → start; `0 < remaining < runCap` → 5-row box (`y` start clamped, `r` opens
`/budget session-spend-cap <sessionCap + runCap>` prefilled in the composer, `n`/Esc cancel, Enter inert);
`remaining ≤ 0` → refusal item `[run] session cap reached ($10.31 of $10.00). Raise it with /budget session-spend-cap
<usd>, or /new for a fresh session with its own cap.` + 4 s toast. `--plain`/`--json`/`--no-input`: clamp silently
+ `budget:clamp`, or exit 4 + `budget:stop { scope: 'session', at: 'follow-up' }`.

### 9.4 `/budget` (A134)

`/budget` prints both caps, spends, pending values. `/budget spend-cap <v>`: `v` must exceed the target run's spend;
stored in memory as `pendingRunCap` (F7); applied to whichever comes first — the next `/resume` (through
`reconcileResumeConfig` as an augmented `--spend-cap` flag → `run.json.overrides[]`, `budget:override source:'/budget'`)
or the next new run (config value with source `session:/budget`); never a live run. `/budget session-spend-cap <v>`:
`sessionMeter` cap replaced immediately (`createSpendMeter` gains `setCap(usd)`? — no: the root meter is recreated
with the new cap and `restore()`d from its own snapshot, keeping `SpendMeter` frozen), index `budget` line,
`budget:override`. `/budget max-steps|max-wall|max-replans <v>`: pending run limits, same two routes.

### 9.5 Unpriced policy (A135–A137)

`validateGenerator` returns `priced: boolean` (`PRICING_TABLE` hit or all four `JEVCODE_PRICE_*` overrides;
cache rates derived 0.1×/1.25× in when absent, source column says `derived from priceInPerM`). `provider ===
'anthropic' && !priced && !allowUnpriced` → `ConfigError` on `generator.model` (exit 2) whose message ends with `or
pass --allow-unpriced to run under a token cap instead.` (the flag is named; item 32 of 00 §8 closed). With
`--allow-unpriced`: `RunLimits.maxGeneratorTokens` (default `spendCapUsd / 15 × 1e6`, Q40 decision: conservative
2:1 tier), `BUDGET_ORDER` gains `token_cap` after `spend_cap` (`checkBudgets` input `generatorTokens`), `StopReason
'token_cap'`, figures render `$?`, status `gen 43.1k/133k tok`. OpenRouter/Jev `usage.cost` null → `budget:unpriced`
and stop `error unpriced_usage` after the step commits unless `--allow-unpriced`. `~` marks table-priced figures.
`config.warnings` are printed (`jevcode: <warning>` in plain, a `notice kind:'config'` item in the TUI) (A136).
`jevcode config` prints `session.spendCapUsd  $10.000 (default: 5 × run cap)` when derived (P48).

### 9.6 Status meters and `/cost`

Right zone: `run $1.60/2.00 high  sess $4.11/10.00 ok` at ≥ 80 columns; bars at ≥ 120; tokens at ≥ 140 (A46).
`/cost` = 14 §5.4's 12-row block with `basis:` and `pending:` rows; jev-only copy drops `gen`.

## 10. Secrets (F9)

### 10.1 `detectSecrets` (A153) — `src/core/redact.ts`

`export interface SecretHit { family: string; label: string; start: number; end: number; warnOnly: boolean }`,
`export function detectSecrets(s: string, exact?: Pick<Redactor, 'redact'>): readonly SecretHit[]`: the six
`FORMAT_PATTERNS` (redacting) plus warn-only AWS, Slack token/webhook, PEM with the `PRIVATE KEY` literal, JWT,
Stripe, `npm_`, `hf_`, `glpat-`, `xox[abpers]-` (C44 staging); `HEADER_PATTERN` excluded; `exact` present → a hit
labelled `your <NAME>` when `exact.redact(s) !== s`. Labels ≤ 6 secret chars; `sk-proj-` labelled `OpenAI (sk-proj-…)`
(P55). Runs on every buffer change for the dim `⚠ secret?` marker and at Enter for the gate; `--plain` asks through
readline; non-TTY cancels (exit path 2).

### 10.2 `addSecret` on `y` (A155, A156)

For each hit span ≥ 8 chars: `redactor.addSecret('composer#' + n, span)` (PEM: whole block) before the text leaves
the composer; cap 64 composer entries with `dropSecret(name)` eviction; `secret-ack` event `{ count }` → item
`[turn n] sent 1 secret to the generator on request`; the provider request stays raw (the `task` is not redacted,
prompts.ts 247); scope = process, documented as not surviving `--resume` (P56 decision: accept and document).

### 10.3 Paste chips — §4.4. 10.4 `@` denylist — `isSecretPath()` extended (`/credential/i`, `.npmrc`, `.pypirc`,
`/\.(p12|pfx|jks)$/i`, `@`-only `.git/**`); typed denied path → row `.env is on the secret denylist; JevCode never
reads it. Start with --allow-secret-mention to override.` and the mention is dropped; with the flag → `Attach anyway?
y/N`, `workspace.readSecretForMention(rel, maxBytes)`, every `SECRET_NAME_RE` line `addSecret`'ed as `mention:<KEY>` (A157).
10.5 `/copy`: `config.redact(sanitizeStream(x))`, 64 KiB cap, `pbcopy`/`wl-copy`/`xclip`/`xsel` first, OSC 52 write
only with `--osc52`/`ui.osc52` (tmux DCS wrapper), never read; `/copy draft` reports `copied with 1 secret masked`
(A86). 10.6 Trace: `App.tsx:126` becomes `key kind=<return|backspace|ctrl|escape|text|paste> len=<n> masked=<bool>`
at log level `trace` (A12). 10.7 History: §4.5.

## 11. Onboarding, credentials, trust, AGENTS.md (F10)

### 11.1 State machine (`src/tui/onboarding/reducer.ts`, pure; 13 §5.2)

```
probe(missingSecrets(mode)) ──[]──▶ trust? ──▶ sandbox line ──▶ composer
   │ non-empty
   ▼
provider (1 anthropic · 2 openrouter; skipped if generator key present or mode jev-only; preselect --provider/JEVCODE_PROVIDER)
   ▼
generatorKey (masked; Enter ≥ 8 chars; prefix hint warns only)
   ▼
jevKey (masked; openrouter + fresh generator key → "Enter = reuse it for Jev"; skipped if JEV_API_KEY/OPENROUTER_API_KEY resolve)
   ▼
save (addSecret → <Static> fingerprint lines → atomic 0600 write to ${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json; legacy ~/.config path checked too, XDG preferred, warn once) → resolveConfig again
   ▼
verify? (explicit y only; GET openrouter.ai/api/v1/key $0 · GET api.anthropic.com/v1/models $0 · one Jev decision ~$0.0001 with the configured decider.model; 5 s timeouts; rejected key → back to its field)
   ▼
trust (per git-root gate, §11.4) ──▶ sandbox line ──▶ composer (or the argv task)
```

Reducer state holds `{ step, field: { name, length } }` only; the key bytes live in a `useRef<string>` (A114).
Frames: G above (rows 24) and the 40×8 stacked variant of 13 §5.2. Esc = clear / step back; Ctrl-C = fix block +
exit 2 (13 §5.8 text verbatim). Windows prints the ACL note instead of `chmod` (P41).

### 11.2 Credentials CLI

`jevcode login [--provider …] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]` (raw-mode masked
byte loop on a TTY; one line per `*-stdin` flag on a pipe), `jevcode logout [--generator] [--jev]`, `jevcode config
set <setting> <value>` (secret names refused: `secret settings are set with 'jevcode login' (stdin or masked prompt),
never as an argument`) (A125). In-session `/login` re-enters the wizard as a top overlay (rows from the pane first);
on `saved` → `addSecret` immediately, toast `saved — applies to the next run (this run keeps its key)` (A126).
Shadowing line at every start when env/dotenv and file disagree (A120). A composer never accepts a credential: a
pasted key is text under §10's gate (C43).

### 11.3 Non-TTY / `--no-input`

No prompt; today's `ConfigError` line then the four-line fix block of 13 §5.8 verbatim; exit 2 (A124).

### 11.4 Trust (A122, D6 decisions)

`~/.jevcode/trust.json` (0600): `{ "<realpath git root | workspace>": { "trusted": true | "session", "at": "<iso>",
"files": ["AGENTS.md@sha256:<64 hex>"] } }` (P39: `~/.jevcode`, inside the seatbelt-protected tree). Gate shown on
the first interactive run per root when any untrusted input exists (`AGENTS.md`/`CLAUDE.md`, `./.env`, `./jevcode.json`),
listing sizes and secret-looking counts, never values; options `1 trust · 2 this session only · 3 don't trust`; `3`
→ `run.json.instructions = []`, `.env` still read (P38: keep) with a `dotenv: ./.env` source line in the item
stream; a changed `AGENTS.md` sha256 re-prompts (`AGENTS.md changed since you trusted it (sha256 …→…)`); `$HOME` as
workspace never persisted; non-interactive: instruction files skipped with one stderr line unless
`--trust-workspace`/`JEVCODE_TRUST_WORKSPACE=1`; `/trust` reopens.

### 11.5 `AGENTS.md` (A59)

`src/session/instructions.ts` `loadInstructions(workspaceRoot, gitRoot, home): Promise<{ files: InstructionFile[];
text: string }>`: first match of `AGENTS.md` walking up from the workspace to the workspace root (never above it),
`CLAUDE.md` fallback name, then `${XDG_CONFIG_HOME:-~/.config}/jevcode/AGENTS.md`; 32 KiB cap per file (truncated with a
notice); read once per run after the first frame; `redact`ed; recorded as `run.json.instructions[]`; injected into
`buildSystemPrompt` as `## Project instructions (from <path>, sha256 <8>)` **only** (never Jev state; P1 open);
`workspace` event lists them; the risk stage is unchanged (instructions are prompt text, every action still goes
through risk).

## 12. Git, undo, rewind, diff (F11)

### 12.1 `GitState` at run start (A140)

`createWorkspace()` (files.ts 100–130) replaces `isRepo`→`showPrefix`→`gitDir`→`statusPorcelain` (four spawns) with
(a) `git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel` and (b)
`git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all -z` (`statusPorcelainV2()` in
`git.ts`, ten line kinds, `(initial)`, `(detached)`, `S…` submodules, NUL-separated renames). `Workspace.gitState()`
returns the `GitState` of §15 item 6; `RunMeta.git` = the bounded `RunGitMeta`; the engine emits `workspace { git,
instructions, sandbox }` right after `run:ready` (buffered by the bus until `attach`, so the first-frame gate is
untouched). Banner strings = 15 §6.1 verbatim (`[run] git main ↑2 · 3 modified · 1 staged · 1 untracked`, …, ASCII
`^2 v1`); `warn` only for unmerged paths; never a gate (R36).

### 12.2 Status-line git zone (A142)

`src/tui/useGitHead.ts`: `fs.watch(gitDir, { persistent: false })` filtered on `!filename || filename === 'HEAD'`,
100 ms debounce, read `<gitDir>/HEAD` (+ ref file / `packed-refs`) in-process; dirty counts from the run-start
snapshot and the `invalidateCandidates()` refresh after each `run` outcome (the engine forwards them in `status`
events? — no: the controller reads `workspace.gitState()` after `outcome` events of kind `run`; zero spawns); re-probe
once at `run:end` for ahead/behind (P51 decision: `run:end` re-probe; one 15 ms spawn off the loop). Render `⎇ main
↑2 · 3~ 1?` / `⎇ 7d731c0e†` / `⎇ main (wt)` / ASCII `br main`; grapheme-tail truncation; ≤ 24 cells at ≥ 100
columns, ≤ 14 below, hidden < 60; watcher error → frozen value.

### 12.3 Pre/post images (A57, A143, A144) — `src/checkpoint/images.ts`

```
pre/<step>/<sha256(relpath)>            bytes of the file before the step (mode preserved in post json); files > 1 MiB skipped and recorded
pre/<step>/dirs.json                    ["src/new/"]  directories the step created (for unlink of created files)
post/<step>.json
{ "v": 1, "step": 7, "at": "…", "source": "edit" | "write" | "patch" | "run",
  "files": { "src/a.py": { "sha256": "…", "bytes": 812, "mode": 420, "source": "edit", "preImage": true },
             "build/out.txt": { "sha256": "…", "bytes": 91, "source": "run", "preImage": false, "cleanAtStart": false },
             "src/new.py": { "sha256": "…", "bytes": 40, "source": "write", "created": true },
             "old.txt": { "deleted": true, "preImage": true } },
  "skipped": [ { "path": "big.bin", "reason": "size", "bytes": 3145728 }, { "path": "…", "reason": "cap" } ] }
```

Engine insertion: in `runStep()` right before `runExecuteStage` (engine.ts 1054): for `edit|write|patch` →
`writePreImages(runDir, step, targets)` from `draft.patchTargets`/`action.path` (0.1 ms per small file); for `run` →
copy `snapshotDirty ∪ statusEntries ∪ touched` (from `workspace.dirtySet()`, additive helper) capped at 200 files /
16 MiB, overflow `reason: 'cap'`. After execute (1062): `writePostImages(runDir, step, changedFiles, { cleanAtStart })`
hashing the bytes on disk (0.6 ms/MiB; per-step hashing cap 64 MiB → `hashSkipped`, Q33), awaited before
`store.writeState` in `commit()`. Non-git: only `touched` paths; `/undo` rules 1–2.

### 12.4 `/undo [n]` decision table (A145, A146) — `src/session/undo.ts`, idle-only, all checks before the first write

| Current file vs `post[N].files[p].sha256` | Decision |
| --- | --- |
| equal | restore |
| missing and `deleted: true` | restore |
| differs and some later step M has `post[M].files[p].sha256 === current` | refuse: `src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together` |
| differs otherwise | ask (2-row `undo-prompt` overlay): `src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort` — default `n`, Enter = `n` |
| symlink / hardlink (`lstat`, `nlink > 1`) | skip `link` |
| escapes `<ws>` or enters `.git` | skip `escape` |
| submodule (`sub[0] === 'S'`) | skip `submodule` |

Restore source order: pre-image (`writeFileAtomic(abs, bytes, { mode })`) → `created` and no pre-image → `unlink` +
remove recorded empty dirs → `source === 'run'` and `cleanAtStart` and tracked → `git restore --source=HEAD --worktree
-- <path>` via `runGit` (never `checkout --`, never `--staged`) → skip `not-recoverable`. Output item `undo step 7:
restored 3 files (…), skipped 1 (build/out.txt: not recoverable — changed by a command, not tracked by git)` / `no files
restored (…)`; rename `post/7.json` → `post/7.undone.json`; index `undo` line; `humanNotes` for the next seed; no
`/redo` (P54: none in v1). The finished run's `state.json` is never rewritten (see §22 deviation on `undoLog`).

### 12.5 `/rewind [step]`

Picker of steps with changed files (from the reducer's `step:end` records of the last run); Enter → `undo` steps
`last…n` in reverse, stopping at the first refusal; then a 3-option row `files (done) · plan+window · both` →
`plan+window` sets the next seed to `planAfter` of step `n` and the window to entries `≤ n` (§8.5). Esc Esc on an
empty idle composer opens the same picker (F5).

### 12.6 `/diff` (A148, A151)

`/diff` = one item: header `diff (run <id> · 12 files · +184 −37 · 2 untracked · 1 binary · 1 skipped)` then rows
` M src/a.py            +120 −12  ++++++++--` with letters `M/A/D/R/?/B/S`, ≤ 10-cell `+`/`-` bar scaled to the
largest row, `†` for paths dirty before the run (legend row), row cap 40 (`--all`), path left-truncated by grapheme
to `columns − 32`; data from `git diff --numstat -z HEAD -- <changedFiles>` (one spawn) plus `git diff --no-index
--numstat -z -- /dev/null <f>` for the first 20 untracked files (exit 1 = success); unborn → empty tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`. `/diff <step>` = pre → post from the images, `(changed since)` rows when
the current hash differs. `/diff --full [step]` = unified text (`--color=always -c core.quotePath=false
--submodule=short --ignore-submodules=dirty`, files > 1 MiB excluded) written to `<run>/tmp/diff-<seq>.patch` and shown
via `suspendTerminal(spawn('/bin/sh', ['-c', pager + ' "$0"', file]))` with `$GIT_PAGER` → `$PAGER` → `less`,
`LESS=FRX` only when unset, `LESSCHARSET=utf-8`, events queued and flushed after resume; `cat`/no TTY → inline block
capped at 400 lines. Non-git: per-file `--no-index` with header rewrite, or in-process LCS counts when git is missing.
Human-only (P53). Seatbelt: `ProfileOptions.gitDir/gitCommonDir` allow-list with the `config`/`hooks`/`config.worktree`/
`modules/*/{config,hooks}` denies (A149).

## 13. Errors, retry, crash, logs, epilogue, exit codes (F12)

13.1 Severity → surface map = 17 §4.1 verbatim. 13.2 `retry`/`retry:settled` events from `AskOptions.onRetry`
(client.ts 388–391) and `GenerateOptions.onRetry` (sse.ts 299–301); the 1 Hz live row `jev: retrying 2/3 in 12 s ·
HTTP 429 rate limited (Retry-After)   [r] retry now` (`RetryInfo.wake()` ends the sleep early — P60 decision: ship
the waker; `sleep(ms, signal)` in `core/time.ts` gains an optional `wake: EventTarget`), second row only when the cause
changed; status word `retrying 2/3`; `✓ jev back` toast; `warning:` item when a chain lasted > 10 s; Esc = pause at
the next boundary. 13.3 `paused: jev unreachable` after one exhausted chain with zero actions (session mode only;
30 s doubling to 5 min, `[r] now [q] stop`); bench/plain keep three failures → exit 5 (A165). 13.4 Blocking panes
(≤ 8 rows, top overlay, take pane rows first): 401/403 first call → exit-2 pane routing `/login` (A164); spend-limit
429/402 → `[q] stop (exit 5)` (A166); disk `ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE` → `notice checkpoint:degraded` once
per (file, code), `disk ×N`, pane `[r] retry the write [c] continue without checkpoints [q] stop now (exit 3)`,
`checkpointDegraded` → a later `complete` exits 3 (A163); first-call drift → `[p] pin --jev-model <served>` (A166).
13.5 `PaneBoundary` (class component) around `live`, pane, review, status, overlays and the `<Static>` child renderer;
one-row fallback; a failed `Review` declines via `confirmer.resolve(id, false)`; `JEVCODE_FAULT=render:<pane>` (A161).

Exit codes (17 §4.9):

| Situation | one-shot | session item |
| --- | --- | --- |
| complete | 0 | `exit 0` |
| budget / directive / `human_pause` / `token_cap` | 4 | `exit 4` |
| `ConfigError`/usage at launch | 2 | 2 (process exits) |
| 401/403 first call, first-call drift | 2 (today 5) | pane `[q]` → `exit 2` |
| API failure after retries | 5 | `exit 5` |
| checkpoint degraded then stop | 3 (today 0) | `exit 3` + not-resumable notice |
| sandbox / path abort | 6 | `exit 6` |
| Ctrl-C ×2 / SIGINT | 130 | 130 |
| SIGTERM | 143 | 143 |
| SIGHUP / EIO | 129 | 129 |
| uncaught / render fault escalated | 1 | 1 |
| `/exit`, Ctrl-D ×2 idle | — | 0 always (`--exit-code=last-run` opt-in) |

`stop.ts`: `exitCodeFor(reason, error?, degraded = false)` returns 3 when `degraded && reason === 'complete'`.

13.6 `fatalExit` order (A162): `process.exitCode`; sync restore `stdin.setRawMode(false)`, `fs.writeSync(1,
'\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m')`; `engine?.abort('error')`; `renderer.unmount()` raced with 2 s;
epilogue via `fs.writeSync(2, …)` (17 §4.8 block: `jevcode: stopped — <code>: <msg> (exit N)`, `run`, `files`,
`resume`/`state.json missing — not resumable`, `report`); `process.exit`. Session mode renders the same block as an
item on every `run:end`. Logs: `<runDir>/jevcode.log` (`JEVCODE_LOG`, levels, `--verbose` file-only, `warn`+ sync,
250 ms buffer flushed in `'exit'`, 8 MiB + one rotation, `~/.jevcode/logs/` fallback, keystroke categories only,
`JEVCODE_TRACE` = alias for level `trace`) (A168); Ctrl-O/`/errors` are the in-frame twin and acknowledge `!n`
(P65: Ctrl-O/`/errors` only); `jevcode report <id>` / `/report` bundle (A169); failed retries not persisted in
`jev.jsonl` (P64: no).

## 14. Terminal posture and hygiene (F2, A77–A93)

`bin/jevcode.js`: Node ≥ 22.12 guard, `NO_COLOR` → `FORCE_COLOR=0` (already present), `enableCompileCache`,
`JEVCODE_ASSERT_NO_NETWORK` shim; `render({ exitOnCtrlC: false, patchConsole: false, maxFps: ui.fps (30; 15 under
SSH_TTY/SSH_CONNECTION), incrementalRendering: ui.renderMode === 'incremental', kittyKeyboard: { mode: 'disabled' },
isScreenReaderEnabled: ui.screenReader })`; no alternate screen, no mouse, no OSC 11/XTVERSION, no queries before the
first frame; inside tmux `CSI > 4 ; 2 m` on start and `CSI > 4 m` on exit only (A78). Themes `dark|light|daltonized|
ansi`, ANSI-16 named colours, marker/word beside every colour, no backgrounds (A97); `--ascii` glyph table (A90).
One idempotent exit string (`CSI > 4 m` if set · `?2004l` · `?2026l` · `CSI 0 SP q` · `?25h` · `SGR 0` · `\r\n` if
mid-line) then `setRawMode(false)` in `'exit'`, `fatalExit`, SIGTSTP, SIGHUP and unmount (A80). `stdin/stdout/stderr
'error'` listeners before SIGHUP logic; SIGHUP/`'end'` → checkpoint, no terminal writes, exit 129 (A81). Ctrl-Z:
byte `0x1a` → exit string + raw off → `process.kill(process.pid, 'SIGTSTP')`; `SIGCONT` → raw on, `?2004h`, forced
repaint via `suspendTerminal` (A23). Resize 50 ms trailing debounce; never rewrite scrollback. Screen-reader mode:
Ink SR, `aria-hidden` spinner, status `aria-label` on stage transitions only, `you:`/`steer:` prefixed items,
numbered review, one BEL (A94–A95). Reduced motion: 1 Hz functional tick, `LIVE_FLUSH_MS` 250 (A96). Tiny terminals:
§2 `degraded`. Slow links: fps 15, ≥ 1 s query budgets, mosh treated as unsupported for OSC 52/1004/2026 (A91).
Notifications default off (on in SR): BEL / OSC 9 / OSC 99 per terminal table; review timer starts when the deferred
box appears, restarts on keystrokes, fires at 6 s; run-end timer 60 s (A85, C48).

## 15. Engine and core contract additions (additive; one ordered list = implementation order)

```ts
// src/core/types.ts — contract v1 + these additions (envelope/format versions unchanged)

// 1 stop reasons
export type StopReason = /* existing 11 members */ | 'human_pause' | 'token_cap';

// 2 harness problem kinds
export type HarnessProblemKind = 'replan' | 'rejected_claim' | 'stale_plan' | 'human';

// 3 checkpoint additions
export interface PendingDirective { text: string; at: string; index: number }
export type UndoSkipReason = 'link' | 'escape' | 'submodule' | 'not-recoverable' | 'refused' | 'declined' | 'cap' | 'size';
export interface UndoLogEntry { runId: string; step: number; at: string; by: 'undo' | 'rewind'; restored: string[]; skipped: { path: string; reason: UndoSkipReason }[] }
export interface CheckpointState { /* existing */ pendingDirectives?: PendingDirective[]; undoLog?: UndoLogEntry[]; checkpointDegraded?: boolean }

// 4 plan snapshot per step (for /rewind)
export interface PlanSnapshot { done: { text: string; step: number; judged: number }[]; remaining: string[]; unverified: { text: string; step: number; judged: number }[]; harnessProblems: HarnessProblem[] }
export interface StepRecord { /* existing */ planAfter?: PlanSnapshot }   // each list <= 20 items × 200 chars

// 5 run meta
export type RunSource = 'cli' | 'bench' | 'perf';
export interface InstructionFile { path: string; sha256: string; bytes: number }
export interface RunMeta { /* existing */ sessionId?: string; parentRunId?: string | null; source?: RunSource; title?: string; git?: RunGitMeta; instructions?: InstructionFile[] }

// 6 git
export interface StatusEntryV2 { xy: string; sub: string; path: string; from?: string; hH?: string; hI?: string; mode?: string }
export type GitHead = { kind: 'branch'; name: string } | { kind: 'detached'; oid: string } | { kind: 'unborn'; name: string };
export interface GitState {
  repo: boolean; reason?: 'not-a-repo' | 'git-missing' | 'bare' | 'timeout';
  gitDir: string | null; commonDir: string | null; topLevel: string | null; prefix: string; linkedWorktree: boolean;
  head: GitHead | null; upstream: string | null; ahead: number | null; behind: number | null;
  dirty: { modified: number; staged: number; untracked: number; renamed: number; unmerged: number; submodules: number; entries: StatusEntryV2[] };
  probedAt: string; probeMs: number;
}
export type RunGitMeta = Pick<GitState, 'repo' | 'reason' | 'head' | 'upstream' | 'linkedWorktree' | 'prefix'> & { dirtyAtStart: { modified: number; staged: number; untracked: number } };

// 7 spend
export interface SpendSnapshot { /* existing */ parentExceeded: boolean; parent?: { totalUsd: number; capUsd: number } }
// SpendMeter interface unchanged; createSpendMeter(capUsd, parent?) fills parentExceeded/parent from parent.snapshot()

// 8 limits and engine options
export interface RunLimits { /* existing */ maxGeneratorTokens?: number }
export interface RunSeed { parentRunId: string; plan: Plan; window: WindowEntry[]; createdThisRun: string[]; lastTestRun: LastTestRun | null; undoLog?: UndoLogEntry[] }
export interface SessionRef { sessionId: string | null; parentRunId: string | null; source: RunSource; title?: string }
export interface EngineOptions {
  /* existing */
  seed?: RunSeed;                       // follow-up: plan/window/created/lastTestRun from the parent run (§8.5)
  humanDirective?: string;              // initial pending directive consumed at step 1 (e.g. /rewind notes); redacted, <= 600
  session?: SessionRef;                 // written into run.json; default { sessionId: null → runId, parentRunId: null, source: 'cli' }
  instructions?: { files: InstructionFile[]; text: string };   // AGENTS.md → system prompt + run.json.instructions[]
  budgetWarnings?: boolean;             // emit budget:warn events (default true; renderers mute toasts, never the event)
  allowUnpriced?: boolean;              // token cap instead of refusing; renders $?
}

// 9 engine surface
export type SteerResult = { ok: true; index: number; queued: number } | { ok: false; reason: 'empty' | 'full' | 'finished'; queued: number };
export interface Engine {
  /* existing */
  steer(text: string): SteerResult;
  unsteer(): PendingDirective | null;
  pause(): void;                        // stop with 'human_pause' at the next §9.1 rule-1 point; idempotent
  pending(): readonly PendingDirective[];
}

// 10 events (new members and extensions)
export interface RetryCause { kind: 'http' | 'network' | 'timeout' | 'invalid' | 'stream'; status: number | null; code: string | null; message: string }
export type NoticeKind = 'offline' | 'online' | 'checkpoint:degraded' | 'checkpoint:restored' | 'sandbox' | 'drift' | 'seeded' | 'instructions' | 'config' | 'session';
export type EngineEvent = /* existing members, with run:ready and run:end extended as below */
  | { type: 'run:ready'; runId: string; step: number; maxSteps: number; task: string; resumed: boolean; sessionId: string; parentRunId: string | null; sandbox: SandboxLevel; noNetwork: boolean; maxReplans: number }
  | { type: 'run:end'; result: RunResult; exitCode: number; resumable: boolean; paths: { runDir: string; transcript: string; log: string } }
  | { type: 'user'; step: number | null; kind: 'prompt' | 'steer' | 'command'; text: string }
  | { type: 'steer:queued'; step: number; index: number; text: string; queued: number }
  | { type: 'steer:applied'; step: number; count: number; chars: number }
  | { type: 'steer:withdrawn'; step: number; index: number }
  | { type: 'pause:requested'; step: number }
  | { type: 'budget:warn'; scope: 'run' | 'session'; pct: 50 | 80 | 95; spentUsd: number; capUsd: number; step: number; runId: string; sessionId: string; restored?: boolean; jevShare?: { jevUsd: number; generatorUsd: number } }
  | { type: 'budget:stop'; scope: 'run' | 'session'; by: 'run' | 'session' | 'tokens'; spentUsd: number; capUsd: number; step: number; stoppedAt: StoppedAt | 'follow-up'; runId: string; sessionId: string; raise: { command: string; flag: string; minimum: number } }
  | { type: 'budget:clamp'; scope: 'session'; runCapUsd: number; clampedToUsd: number; sessionSpentUsd: number; sessionCapUsd: number; runId: string; sessionId: string }
  | { type: 'budget:override'; setting: string; from: string; to: string; atStep: number; runId: string; sessionId: string; source: '/budget' | 'flag' }
  | { type: 'budget:unpriced'; source: SpendSource; model: string; step: number; tokens: { input: number; output: number }; runId: string }
  | { type: 'retry'; side: 'jev' | 'generator'; step: number | null; stage: StageName | null; attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: RetryCause }
  | { type: 'retry:settled'; side: 'jev' | 'generator'; step: number | null; attempts: number; ok: boolean; totalWaitMs: number }
  | { type: 'notice'; step: number | null; kind: NoticeKind; text: string; detail?: Json }
  | { type: 'workspace'; git: RunGitMeta; instructions: InstructionFile[]; sandbox: SandboxLevel }
  | { type: 'secret-ack'; step: number | null; count: number };

// 11 retry plumbing
export interface RetryInfo { attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: RetryCause; wake: () => void }
export interface AskOptions { /* existing */ onRetry?: (r: RetryInfo) => void }
export interface GenerateOptions { /* existing */ onRetry?: (r: RetryInfo) => void }

// 12 errors
export interface SerializedError { /* existing */ status?: number; retryable?: boolean; side?: 'jev' | 'generator'; requestId?: string | null }

// 13 config
export interface UiConfig { theme: 'dark' | 'light' | 'daltonized' | 'ansi'; fps: number; renderMode: 'standard' | 'incremental'; ascii: boolean; title: boolean; screenReader: boolean; reducedMotion: boolean; notify: 'off' | 'bell' | 'desktop'; osc52: boolean; history: boolean; noInput: boolean; trustWorkspace: boolean; budgetWarnings: boolean; allowSecretMention: boolean; allowUnpriced: boolean; exitCode: 'zero' | 'last-run'; logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace'; logPath: string | null; verbose: boolean; keybindingsFile: string | null }
export interface ResolvedConfig {
  /* existing */
  missingSecrets(mode: EngineMode): readonly ('generator.apiKey' | 'decider.apiKey')[];   // non-throwing
  ui(): UiConfig;
  sessionSpendCap(mode: EngineMode): { value: number; source: ConfigSource; derived: boolean };   // 'none' → +Infinity
}

// 14 redaction (src/core/redact.ts)
export interface Redactor { /* existing */ dropSecret(name: string): boolean }
export interface SecretHit { family: string; label: string; start: number; end: number; warnOnly: boolean }
export function detectSecrets(s: string, exact?: Pick<Redactor, 'redact'>): readonly SecretHit[];

// 15 workspace
export interface Workspace { /* existing */ gitState?(): GitState; dirtySet?(): ReadonlySet<string>; readSecretForMention?(rel: string, maxBytes: number): Promise<FileView> }

// 16 sandbox (src/sandbox/seatbelt.ts)
export interface ProfileOptions { /* existing */ gitDir?: string; gitCommonDir?: string }

// 17 prompts / state (src/provider/prompts.ts, src/loop/state.ts)
export interface PromptInput { /* existing */ humanDirective: { text: string; step: number } | null; instructions?: string }
export interface CommonStateInput { /* existing */ human?: { directive: string; step: number } | null }   // → state.human

// 18 renderer wiring
export interface SessionHost { submit(text: string): Promise<void>; command(line: string): Promise<void>; steer(text: string): SteerResult; unsteer(): PendingDirective | null; pause(): void; abort(reason: 'human_abort'): void; exit(code: number): void }
export interface RendererOptions { /* existing */ mode?: 'one-shot' | 'session'; host?: SessionHost; ui?: UiConfig }
export interface Renderer { /* existing */ notify?(e: EngineEvent): void }   // renderer-only items (undo/diff/why/notices) through the same item model

// 19 confirmer verdict with a note (bench alwaysDecline unchanged: Promise<boolean> is assignable)
export interface ConfirmVerdict { approved: boolean; note?: string }
export interface Confirmer { confirm(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<boolean | ConfirmVerdict>; readonly identity: string }

// 20 stop helpers (src/loop/stop.ts)
export function exitCodeFor(reason: StopReason, error?: SerializedError, degraded?: boolean): number;

// 21 JSON stream (src/cli/json-stream.ts)
export type JsonStreamLine = ({ v: 1; t: string; runId: string | null; sessionId: string | null } & EngineEvent)
  | { v: 1; t: string; type: 'session:start'; sessionId: string; runId: string; parentRunId: string | null; workspace: string }
  | { v: 1; t: string; type: 'session:end'; reason: 'exit' | 'error'; runs: number };

// 22 loop detector (src/loop/loopdetect.ts)
export interface LoopDetector { /* existing */ resetCounts(): void }   // human directive: counts and tripped cleared, history and replanCount kept
```

Insertion points (line numbers of today's files):

| File | Where | Change |
| --- | --- | --- |
| `engine.ts` 298–370 | fields | `pendingDirectives: PendingDirective[] = []`, `steerSeq = 0`, `pauseRequested = false`, `activeHuman`, `sessionRef`, `warned: Set<'run50'|…>`, `checkpointDegraded` |
| 372–443 constructor | after the resume branch | `else if (init.opts.seed) { plan/window/created/lastTestRun ← seed; lastChangeStep = null }`; `pendingDirectives ← s.pendingDirectives ?? []` on resume; `opts.humanDirective` → push as pending |
| 487–510 `abort` | unchanged | — |
| 523–571 `main()` | loop top | `pauseRequested` check after `signal.aborted`; `applyPendingDirectives()` after `checkBudgets` (§8.6); after `run:ready` emit `workspace` |
| 551 `run:ready` | payload | `sessionId, parentRunId, sandbox: this.sandbox.level, noNetwork, maxReplans` |
| 637–670 `buildCheckpointState` | fields | `pendingDirectives`, `undoLog` (from seed), `checkpointDegraded` |
| 600–612 `persist` | catch | classify `e.code` → `notice checkpoint:degraded` once per (file, code) |
| 774–828 `ask` | after `meter.add` (790) | `this.checkBudgetWarnings(draft.step)`; `onRetry` forwarded from `decider.ask(...)` opts |
| 913–945 `generate` | after `meter.add` (928) | same; token counting for `token_cap`; `onRetry` |
| 951–1105 `runStep` | 1054 before execute / 1062 after | `writePreImages` / `writePostImages` (§12.3); `planAfter` recorded in `commit()` 1419–1439 |
| 1123–1139 `confirm` | resolve | normalise `boolean | ConfirmVerdict`; note → reason suffix + `draft.notes` |
| 1141–1166 `commonState` | `buildCommonState` input | `human: this.activeHuman?.step === (draft?.step ?? this.step + 1) ? { directive, step } : null` |
| 1168–1191 `promptInput` | return | `humanDirective`, `instructions` |
| 837–875 `synthesisContext` | 861 `directive` | concatenation with `activeHuman.text` |
| 1300–1457 `commit` | after plan update | `record.planAfter = planSnapshot(plan)`; `stoppedAt` unchanged |
| 1463–1526 `finish` | before `run:end` | `budget:stop` when reason is `spend_cap`/`token_cap`; `run:end` gains `exitCode = exitCodeFor(reason, error, this.checkpointDegraded)`, `resumable`, `paths`; release `run.lock`; `human_pause` in `isPlainStopBudget`? no — excluded |
| 1580–1634 `createEngine` | 1605 `meta` | `sessionId`, `parentRunId`, `source`, `title`, `git: workspace.gitState()`, `instructions`; `run.lock` write; `buildSystemPrompt({ …, instructions })` |
| `prompts.ts` 51–70, 155–172 | `PromptInput`, `hintsSection` | `- Instruction from the human (step N): …`; `buildSystemPrompt` appends `## Project instructions` |
| `state.ts` 66–83, 113–134 | `CommonStateInput`, `buildCommonState` | `human` field (clipped 600, redacted) |
| `plan.ts` `applyPlanDraft` | input | `humanDirective?: boolean` unlocks rule (b) without a `replan` problem |
| `budget.ts` | `BUDGET_ORDER`, `BudgetInput` | `token_cap` after `spend_cap`; `generatorTokens?`, `maxGeneratorTokens?` |
| `stop.ts` | `exitCodeFor`, `BUDGET_STOP_REASONS` | `degraded` param; `human_pause`/`token_cap` → 4 |
| `resolve.ts` 208 | config path | XDG branch; `missingSecrets`, `ui()`, `sessionSpendCap()`; `BUDGET_STOPS` unchanged (excludes `human_pause`) |
| `main.tsx` 15–29 | `exitCodeFor` | delete local copy; use `stop.ts`'s |
| `main.tsx` 81–210 | `commandRun` | session meter, `source`, seed/session wiring, `--json` writer, `config.warnings`, unpriced refusal, epilogue; new `commandChat` sharing `startRun(opts)` |
| `main.tsx` 276–285 | `switch` | `chat`, `login`, `logout`, `sessions`, `report`, `completion`, `upgrade`, `doctor`, `calibration`, `why`; `config set` |
| `main.tsx` 288–296 | `fatalExit` | re-ordered (§13.6) |
| `args.ts` 10–11, 171–178 | `COMMANDS`, first token | `chat` default when argv is empty or starts with `-` (except `--help/--version`); `config` positionals `set <name> <value>`; `sessions` positionals `list|reindex|prune|unlock` |
| `args.ts` 78–124 | `FLAGS` | §16 flags; `--version --json`; `--no-color`; hidden `--perf-*` for the new gates |
| `plain.ts` 287–308 | `CONFIRM_HEADER_ROWS = 8`, `confirmHeaderLines` | gauge rows; `itemsFromEvent` gains `user`, `steer:*`, `budget:*`, `retry` (plain only, one line per attempt), `notice`, `workspace`, `secret-ack`, extended `run:end` (one line each, so `transcript.log` = `--plain` = TUI) |
| `useEngine.tsx` | reducer | `retry` row + 1 Hz tick, `steer` queue, `budget` state, `pane` tabs, `toasts`; unchanged live coalescer |

Jev-only preservation checklist: (1) `buildProvider` returns `createNullProvider()` for `jev-only` and
`config.generator()` is never called (main.tsx 54–57, 162) — the session wiring keeps the same branch; (2)
`createSynthesizer({ decider, redact })` unchanged (165–168); (3) `synth` events keep one transcript line each
(plain.ts 229–231) and the live region shows the last synth line / the strip renders `detail` verbatim; (4) the
`propose [synth]` status marker (StatusLine.tsx 26, 37) stays in the left zone; (5) `SynthesisContext.directive`
is the only synth-facing change (a string concatenation); (6) `src/synth/**` untouched; (7) `transcript.log`,
`--plain` and the TUI transcript stay line-identical because every new line kind goes through `itemsFromEvent`;
(8) jev-only run cap default $0.25 / session $1.25 resolved after `--mode` is known (P45: in `resolveConfig`).

## 16. Config schema (F14; precedence flag > env > `./.env` > `<extra .env file>` > file > default)

| Setting | Flag | Env | File key | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `ui.theme` | `--theme` | `JEVCODE_THEME` | `theme` | `dark` | `dark|light|daltonized|ansi`; `/theme` new items only |
| `ui.fps` | `--fps` | `JEVCODE_FPS` | `fps` | `30` (`15` under SSH) | 5–30 |
| `ui.renderMode` | `--render-mode` | `JEVCODE_RENDER_MODE` | `renderMode` | `standard` | `incremental` opt-in |
| `ui.ascii` | `--ascii` | `JEVCODE_ASCII` | `ascii` | `false` (auto under `TERM=dumb`) | |
| `ui.title` | `--title` | `JEVCODE_TITLE` | `title` | `false` | OSC 2 opt-in |
| `ui.screenReader` | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | `screenReader` | `false` | `=0` overrides |
| `ui.reducedMotion` | `--no-animation` | `JEVCODE_REDUCED_MOTION` | `reducedMotion` | `false` (true under SR) | |
| `ui.notify` | `--notify` | `JEVCODE_NOTIFY` | `notify` | `off` (`bell` under SR) | `off|bell|desktop` |
| `ui.osc52` | `--osc52` | `JEVCODE_OSC52` | `osc52` | `false` | write only |
| `ui.history` | `--no-history` | `JEVCODE_NO_HISTORY` | `history` | `true` | never for bench/perf |
| `ui.noInput` | `--no-input` | `JEVCODE_NO_INPUT` | `noInput` | `false` | implied by non-TTY/`--json` |
| `ui.trustWorkspace` | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | — | `false` | scripts |
| `session.spendCapUsd` | `--session-spend-cap` | `JEVCODE_SESSION_SPEND_CAP_USD` | `sessionSpendCapUsd` | `5 × limits.spendCapUsd` (derived) | `none` = +∞ |
| `limits.spendCapUsd` | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `spendCapUsd` | `2.00` (`0.25` jev-only) | mode-keyed default |
| `limits.allowUnpriced` | `--allow-unpriced` | — | — | `false` | flag only |
| `limits.maxGeneratorTokens` | `--max-generator-tokens` | `JEVCODE_MAX_GENERATOR_TOKENS` | `maxGeneratorTokens` | `spendCapUsd / 15 × 1e6` | with `--allow-unpriced` |
| `generator.priceCacheReadPerM` / `…WritePerM` | — | `JEVCODE_PRICE_CACHE_READ_PER_M` / `_CACHE_WRITE_PER_M` | `priceCacheReadPerM` / `priceCacheWritePerM` | derived 0.1× / 1.25× in | source column says so |
| `ui.budgetWarnings` | — | `JEVCODE_BUDGET_WARNINGS` | `budgetWarnings` | `true` | mutes toast/bell only |
| `ui.allowSecretMention` | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | — | `false` | |
| `log.path` / `log.level` / `log.verbose` | `--log`, `--log-level`, `--verbose` | `JEVCODE_LOG`, `JEVCODE_LOG_LEVEL`, (`JEVCODE_TRACE` alias) | `log`, `logLevel` | `<runDir>/jevcode.log`, `info`, `false` | file only |
| `ui.exitCode` | `--exit-code` | `JEVCODE_EXIT_CODE` | `exitCode` | `zero` | `zero|last-run` |
| `ui.keybindingsFile` | `--keybindings` | `JEVCODE_KEYBINDINGS` | — | `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` | `namespace:action` ids, `"none"` unbinds, chords 3 s, reserved Ctrl+C/D/M/[/I (A24) |
| `updateNotify` | — | `JEVCODE_UPDATE_NOTIFY` | `updateNotify` | `false` | post-run only (A70) |
| `configFile` | `--config` | `JEVCODE_CONFIG` | — | `./jevcode.json`, else `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`, legacy `~/.config` checked | XDG preferred, warn once (P30) |

`jevcode config` prints every row with its source (`flag` / `env` / `dotenv:<path>` / `file:<path>` / `default` /
`derived`); `jevcode config set <setting> <value>` writes non-secret keys to the user config file atomically.

## 17. Packaging and release (F15; documented and prepared, not published)

`package.json`: remove `"private": true`; `"dependencies": {}` with `ink`/`react` in `devDependencies` (inlined);
`"files": ["bin/jevcode.js", "dist/jevcode.mjs", "dist/THIRD_PARTY_LICENSES.txt", "man/jevcode.1", "README.md", "LICENSE"]`;
`"man"`, `"publishConfig": { "access": "public", "provenance": true }`; MIT `LICENSE` committed (A65). Build:
`minify: true` + `keepNames: true`, `define: { 'process.env.JEVCODE_VERSION': JSON.stringify(pkg.version) }` replacing
the `VERSION` literal (main.tsx 13), `THIRD_PARTY_LICENSES.txt` generated from `result.metafile.inputs` (package name,
version, license text from each `node_modules/<pkg>/LICENSE*`), `.map` kept locally but excluded from `files`; smoke
step kept plus `chat --perf-exit-after-first-frame` (A67). Launcher unchanged (guard already present) (A66).
`--version` / `--help` answered before importing Ink (already: `parseCliArgs` runs first; the Ink import is dynamic
inside `commandRun`/`commandChat`); `--version --json` → `{ "name": "jevcode", "version": "0.2.0", "node": "…", "ink": "7.1.1" }`.
`jevcode completion bash|zsh|fish` static scripts from `FLAGS` (09 §11.4), `man/jevcode.1` generated by
`scripts/man.mjs` from the same table; `jevcode upgrade [<v>|latest|next] [--check] [--method]` (09 §11.5, 2 s timeout,
never `npm update -g`); notifier off by default, post-run detached check writing `${XDG_CACHE_HOME:-~/.cache}/jevcode/update-check.json`
(A70); Homebrew tap formula text = 09 §11.3 verbatim (`depends_on "node"`, P28); CI gates `test "$(npm pkg get private)" = "{}"`,
`npm pack --dry-run --json` file list and size < 1.5 MB, `tar tzf` shows no `.map`/`.env`/`docs/`; `release.yml` on
tags with `id-token: write`, **Node 24 publish job** (P69 decision; asserts `npm --version ≥ 11.5.1`), `.nvmrc` stays
22.23.2 for tests; dist-tags `next` for pre-releases, `latest` after bench/perf gates (A72). Checklist = 09 §11.7
items 1–8 plus: `jevcode --version --json` smoke, `jevcode completion zsh | head -1` = `#compdef jevcode`.

## 18. Performance plan (F18)

| Gate | Value | How measured | Script |
| --- | --- | --- | --- |
| first frame, `jevcode` (composer frame) and `jevcode run` | cold p95 < 300 ms, zero network | `script -q /dev/null sh -c 'stty rows 40 cols 120; exec node bin/jevcode.js chat --perf-exit-after-first-frame'`, sentinel `step 0/–`, `JEVCODE_ASSERT_NO_NETWORK=1`, `JEVCODE_HOME` non-existent (the index fold must not run before the frame) | `perf/first-frame.ts` (+ `chat` variant) |
| keystroke → frame | p95 < 16 ms in a real pty at the A109 region (rows 24: live 2 + queue 2 + composer 6 + pane 10) | Python `pty.fork` driver types 200 chars at 20 ms spacing during a `--mock` run with 500 deltas/s; latency = write timestamp → first `ESC[?2026h` frame containing the char | new `perf/composer-latency.ts` |
| event-loop lag while typing during a live mocked run | p95 < 5 ms, max < 50 ms | existing 10 ms probe + `monitorEventLoopDelay` behind `--perf-lag-probe` | `perf/render-lag.ts` (typing driver added) |
| zero clears | 0 matches of `/\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?1049[hl]/` after the first frame at rows 12, 24, 40; exactly one `ESC[?25l`, final `?25h` | pty capture | `perf/render-lag.ts` |
| frames | ≤ 20/s + 1 under 500 deltas/s; ≤ 4/s reduced motion; 1/s retry row | count `ESC[?2026h` | `perf/render-lag.ts` |
| harness overhead incl. pre/post images | p95 < 50 ms per step (50 steps, 5,000-file repo, `run` actions) | `harnessMs` from `step:end` | `perf/step-overhead.ts` (adds 2 edits + 1 created file per step) |
| fuzzy rank | p95 ≤ 16 ms over 5,000 candidates | unit test, 50 queries | `test/unit/commands/fuzzy.test.ts` |
| index fold | < 5 ms at 10,000 lines | unit micro-benchmark | `test/unit/session/index.test.ts` |
| `<Static>` growth | soft cap 20,000 items → keyed remount | unit | `test/unit/tui/static-cap.test.tsx` |

## 19. Testing plan

1. **Pure units** (vitest `unit`): `TextBuffer` reducer, `cellWidth` fixtures vs `string-width`, `layoutRows`,
   `computeLayout` (every cell of §2.2 asserted), slash tokeniser and arg validation, `fuzzy`, key matcher with the
   full §3.2 matrix as a table test, `foldIndex` (torn line, duplicate `run:end`, rename after end, legacy runs),
   `buildSeed`, `applyPendingDirectives` (via engine fakes), `undo` decision table (fixtures with real `git init` as
   `test/unit/workspace/git.test.ts` does), `statusPorcelainV2` parser, `detectSecrets` families + FP fixtures +
   256 KB < 5 ms, onboarding reducer never holding a secret, `missingSecrets`, `sessionSpendCap` derivation,
   `exitCodeFor(…, degraded)`, `JsonStreamLine` envelope, `checkBudgets` with `token_cap`.
2. **Property tests** (12 §12.4): mulberry32-seeded op alphabet over the buffer with `Intl.Segmenter` as the oracle;
   invariants: cursor on a boundary, `text === graphemes.join('')`, no control chars, insert/backspace and kill/undo
   identities, `width ≤ columns` per row, paste = one undo step; 1,000–5,000 iterations, < 2 s per file; index-line
   property: any redacted line `≤ 512` bytes or dropped.
3. **ink-testing-library** with `StubStdout(rows, columns)`: frames at rows 8/12/24/40/50 × columns 40/80/120 for the
   ten states of §2.2 assert `lastFrame().split('\n').length ≤ rows − 2` after the last rule; normalised snapshots of
   the dynamic region only; review deferral (typed-ahead `y` never approves); secret gate contract; budget confirm
   Enter inert; steer queue take-back; picker keys; `PaneBoundary` fallback via `JEVCODE_FAULT`.
4. **Engine integration** (`test/unit/loop/engine-session.test.ts` with the existing fakes): steer → `steer:applied`
   at the next step start with the plan problem and prompt hint present; pause → `human_pause` after the in-flight
   step commits; seed → step-1 prompt shows `## Session so far`/human problem and rule (b) drop; `budget:warn` once
   per threshold, highest only, `restored` on resume; `token_cap`; pre/post images written before `state.json` (spy
   order); `run.lock` refusal; `run:end` extension fields.
5. **Fault injection**: `JEVCODE_FAULT=render:<pane>|persist:ENOSPC|jev:429:12|jev:401` (A171).
6. **pty suite** (vitest project `pty`, `skipIf(!existsSync('/usr/bin/expect'))`, macOS runner, `CI` unset in the
   child env): first frame sentinel for `chat`; typing during a mocked run with `ESC[2J` = 0 at rows 12 and 40; Esc →
   `human_pause` exit 4 in one-shot; Ctrl-C matrix cells (idle hint, live abort + reopen, review decline+abort);
   Ctrl-Z/fg through `bash -i`; resize 24 → 12 → 40 with the draft intact; `/diff --full` with
   `PAGER='sh -c "cat >/tmp/out; echo PAGED"'`; `/undo` bare Enter declines; wizard paste leaves zero key bytes in the
   capture, trace, `history.jsonl`, run dir; ENOSPC on an `hdiutil` image behind `JEVCODE_TEST_RAMDISK=1`; `stty -a`
   shows `icanon echo` after a crash and the epilogue follows the last frame bytes.
7. **CI without a TTY**: units, ink-testing-library and `--plain`/`--json` smoke run everywhere; pty/perf on
   `macos-latest` only (12 §12.8).

## 20. Module map for parallel implementation (10 owner slots, disjoint files)

| File | Exports | Depends on | Slot |
| --- | --- | --- | --- |
| `src/core/types.ts` | §15 items 1–21 | — | S1 (wave 0, then frozen) |
| `src/loop/engine.ts`, `stop.ts`, `budget.ts`, `plan.ts`, `loopdetect.ts` (`resetCounts`), `state.ts`, `provider/prompts.ts` | steer/unsteer/pause/pending, seed, budget events, images hooks, `planAfter`, `human` slot, `token_cap`, `exitCodeFor(degraded)` | types, `checkpoint/images.ts` | S1 |
| `src/jev/client.ts`, `src/provider/sse.ts`, `core/time.ts` `sleep(wake)` | `onRetry`, `RetryInfo.wake` | types | S1 |
| `src/session/index.ts`, `seed.ts`, `lock.ts`, `history.ts`, `controller.ts`, `export.ts`, `instructions.ts`, `trust.ts` | `foldIndex`, `appendIndexLine`, `reindex`, `buildSeed`, `acquireLock`, `History`, `SessionController` (`startRun`, `resume`, `steer`, `pause`, `abort`, `newSession`, `budget`), `exportSession`, `loadInstructions`, `readTrust/writeTrust` | types, checkpoint store/resume, spend | S2 |
| `src/tui/composer/buffer.ts`, `width.ts`, `eaw-table.ts` (generated), `layout.ts` (rows), `keys.ts`, `paste.ts`, `search.ts`, `editor.ts`, `Composer.tsx` | `reduce`, `cellWidth`, `displayWidth`, `layoutRows`, `mapKey`, `pasteChip`, `historySearch`, `openEditor`, `<Composer>` | ink hooks only | S3 |
| `src/tui/layout.ts`, `App.tsx` (rewrite), `PaneBoundary.tsx`, `StatusLine.tsx` (zones), `toasts.ts`, `theme.ts`, `glyphs.ts`, `useGitHead.ts`, `suspend.ts`, `terminal.ts` (exit string, Ctrl-Z, SIGHUP, resize debounce), `notify.ts` | `computeLayout`, `<App>`, `<PaneBoundary>`, `formatStatusLine(zones)`, `useToasts`, `theme`, `glyphs`, `useGitHead`, `withSuspension`, `installTerminalHygiene`, `notify` | S3 composer, S5/S6 panes (props only) | S4 |
| `src/commands/registry.ts`, `parse.ts`, `fuzzy.ts`, `mention.ts`, `Palette.tsx`, `Picker.tsx`, `Help.tsx`, `project-commands.ts`, `docs/KEYS.md` generator | `COMMANDS` registry (`availableDuringTask`, `args`, `run(host)`), `tokenize`, `rank`, `mentionCandidates`, `<Palette>`, `<Picker>`, `<Help>` | S2 controller interface (types) | S5 |
| `src/tui/Review.tsx`, `Decisions.tsx` (tabs), `PlanLedger.tsx`, `Timeline.tsx`, `SynthStrip.tsx`, `LoopBanner.tsx`, `bars.ts`, `sparkline.ts`, `why.ts`, `calibration.ts`; `plain.ts` gauge lines | `<Review>`, `<PaneTabs>`, `bar10`, `sparkline`, `whyBlock`, `calibrationBlock`, `confirmHeaderLines` (8 rows) | types, reducer state | S6 |
| `src/spend/session.ts`, `config/validate.ts` (`priced`), `defaults.ts` (mode-keyed cap), `provider/openrouter.ts` `anthropic.ts` (unpriced), `tui/BudgetConfirm.tsx`, `commands/budget.ts`, `commands/cost.ts` | `createSessionMeter`, `deriveSessionCap`, `<BudgetConfirm>`, `/budget`, `/cost` | S1 events | S7 |
| `src/core/redact.ts` (`detectSecrets`, `dropSecret`), `tui/SecretGate.tsx`, `tui/onboarding/{reducer,Wizard.tsx,Trust.tsx,credentials.ts}`, `cli/login.ts`, `sandbox/paths.ts` (denylist), `workspace/files.ts` (`readSecretForMention`), `tui/clipboard.ts` | `detectSecrets`, `<SecretGate>`, `onboardingReducer`, `<Wizard>`, `<Trust>`, `writeConfigSecrets`, `commandLogin/Logout/ConfigSet`, `copyRedacted` | types, config | S8 |
| `src/workspace/git.ts` (v2 + `GitState`), `files.ts` (two spawns, `gitState`, `dirtySet`), `checkpoint/images.ts`, `session/undo.ts`, `session/diff.ts`, `sandbox/seatbelt.ts` (`gitDir/gitCommonDir`) | `statusPorcelainV2`, `probeGitState`, `writePreImages/writePostImages/readPostImages`, `undoSteps`, `diffBlock/diffFull` | types, sandbox | S9 |
| `src/core/log.ts`, `tui/RetryRow.tsx`, `tui/Blocking.tsx`, `cli/epilogue.ts`, `cli/report.ts`, `cli/json-stream.ts`, `cli/args.ts` (commands/flags), `cli/main.tsx` (`commandChat`, wiring, `fatalExit`), `cli/completion.ts`, `cli/upgrade.ts`, `cli/doctor.ts`, `tui/plain-composer.ts`, `scripts/build.mjs`, `scripts/man.mjs`, `scripts/licenses.mjs`, `LICENSE`, `.github/workflows/release.yml`, `Formula/jevcode.rb` | `createLog`, `<RetryRow>`, `<Blocking>`, `epilogue`, `writeReport`, `jsonStream`, args, main, static completions, upgrade, doctor, readline composer | everything (integration) | S10 |

Waves: **0** S1 lands `types.ts` (one PR, frozen) → **1** leaf modules in parallel (S2 index/seed/lock/history,
S3 buffer/width/layout, S4 layout/theme/terminal, S5 parse/fuzzy/registry, S6 bars/why/lines, S7 session meter/
validate, S8 redact/onboarding reducer, S9 git v2/images/undo/diff, S10 log/json-stream/args) → **2** engine changes
(S1), composer + App shell (S3+S4), panes (S5–S8 components), `plain.ts` line kinds (S6) → **3** integration in
`main.tsx`/`controller.ts` (S10 + S2), pty suite, perf scripts → **4** packaging (S10). Shared test helpers:
`test/unit/tui/stub-stdout.ts` (exists as `StubStdout` in `height.test.tsx`; extracted by S4 in wave 1).

## 21. Docs deliverables

`docs/DESIGN.md` §4 (contract v1 + §15 additions, marked), §9 (index, lock, images, seed, `human_pause`), §10
(composer, budget, `--json` redaction wording), §11 (exit-code table incl. session mode), §12 (new gates); `docs/KEYS.md`
generated from the registry with a sync test; `docs/SESSIONS.md` (this file's §8 as user docs: follow-ups, steering,
pause/resume, undo/rewind/diff, export); `docs/COST.md` (§9); `docs/SECURITY.md` addendum (§10, trust, `AGENTS.md`);
`man/jevcode.1` (generated); README: Install (zero deps, brew tap), Sessions, Keys, Cost, "Keys never appear in
logs … or in prompt history, clipboard payloads and the `--json` stream"; `docs/research/tui/terminal-matrix.md`
checklist filled by `jevcode doctor --terminal`; CHANGELOG entry per version.

## 22. Deviations from research ADOPT rows, and items deferred to v1.x

| Row | Deviation | Why (one sentence) |
| --- | --- | --- |
| A46 (helix zone order) | `step N/M` stays the first token of the status line, before the left-zone words | `perf/first-frame.ts` and DESIGN §12 gate on that sentinel appearing first. |
| A143 / 15 §6.3 (`state.undoLog` on the finished run) | `undoLog` is carried in the *next* run's `CheckpointState` via the seed; the finished run gets `post/<N>.undone.json` and an index line | Rewriting a finished run's `state.json` would violate DESIGN §9 / R21 "never mutate a committed checkpoint". |
| A57 (pre-images written by `edit|write|patch` only) | run steps also get dirty-set pre-images, as A144 | A144 supersedes A57 by measurement (15 §3–4). |
| A4 / 16 §4.3 (history chip label with `sha256:`) | label = `[Pasted #n, k lines]` + redacted first line clipped to 40 chars | P58 decision: a hash is not human-recognisable; the first line is. |
| A85 (notify payload table) | unchanged | — |
| A160 (`[r] retry now` "may stay out of v1") | shipped: `RetryInfo.wake()` | F12 fixes it in v1; the change is one optional field on the sleep. |
| 10 §15.9 (`/diff` = `git diff --stat`) | `--numstat -z` rendered in-process | A148 supersedes by measurement. |
| 06 §17.3 review keys (`a`, `s`, Enter default) | 11 §4j set only | C8/C9 resolution; F6. |
| A56 (`x` delete) | delete = move to `~/.jevcode/trash/`, never `rm -rf` | Bench evidence lives in the same tree (R20); a move is reversible. |
| A130 (`session-spend-cap` `none` red `uncapped`) | unchanged | — |

Deferred to v1.x: owned kitty handshake after the pty suite (A77, C1); `--render-mode incremental` default after the
soak test (C2); `--theme auto` (C15); focus tracking 1004 (C25); `!cmd` as a human-authored `run` step (C7); `/redo`
(P54); `.jevcodeignore` (A157); persisting composer-added secrets across `--resume` (P56); `@` pins bypassing the
context Noul (P8); structured `synth` fields (A48, owned by the synth team); Windows/ConPTY validation (Q19);
screen-reader user testing (Q15/Q16); `run.lock` for concurrent index appends (P11); `jevcode sessions prune`
retention policy defaults; promotion of warn-only secret families to redacting after a week of real prompts (Q35).
