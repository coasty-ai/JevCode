# JevCode interactive TUI — design, Jev-native angle

Written 2026-09-20 against `docs/research/tui/00-SUMMARY.md` (cited as `A#`, `R#`, `C#`, `P#`, `D#`), the
research files (`NN §x`), `docs/DESIGN.md` §6/§9/§10/§11/§12 and the code as of commit `3b9cbc1`
(`src/core/types.ts`, `src/loop/engine.ts`, `src/tui/*`, `src/cli/*`, `src/provider/prompts.ts`,
`src/loop/state.ts`, `src/checkpoint/*`, `src/config/resolve.ts`, `src/spend/meter.ts`, `src/core/redact.ts`).
Product decisions F1–F18 are fixed inputs; every section says which it implements. Where a row of the
research is not followed, §22 names it and gives the one-sentence reason.

Conventions: `rows`/`columns` always come from Ink's `useWindowSize()` (A93, never `process.stdout.rows`);
"budget" is `rows − 2`; `bar(p, 10)` is `round(p·80)` eighths drawn with `█` and one of `▏▎▍▌▋▊▉` over a `·`
track (A43); `p2()`/`usd()` are `src/tui/plain.ts`'s formatters; every visual has a `lines(): string[]` twin
that `--plain`, `--screen-reader` and `transcript.log` print (A49).

---

## 0. Thesis and how the fixed decisions are honoured

**Thesis.** JevCode's product is the decisions, not the prose (11 §2). No other coding TUI can show *why* an
action was flagged, with what probability, at which threshold, and let the human answer with a reason Jev
and the generator both read (11 §3.5, A39–A40). The chat composer, sessions, steering and money are the
vehicle that gets a human to the next decision fast and keeps the run comparable with itself. Design
priorities, in order: (1) the review box (per-dimension gauges, `d` decline-with-note, `w` why) is the centre
of the frame and is never bypassed; (2) every `decision` event is a first-class row with a bar, `p`, `c`, the
rule that consumed it, and a `/why` drill-down; (3) the plan ledger, loop/replan banner and jev-only synth
strip make the harness's own memory and judgement visible; (4) cost is always split run/session and gen/Jev;
(5) the composer is a readline text field whose only special powers are `/` and `@`.

| Fixed decision | Where honoured |
| --- | --- |
| F1 entry points | §1 (mode matrix, first-frame gate covers the composer frame) |
| F2 rendering posture | §2 (one `<Static>`, region ≤ rows − 2), §14 (kitty off, NO_COLOR shim, themes, fps) |
| F3 cap set A109 and yield order | §2.1 `computeLayout` and §2.2 frames |
| F4 keys | §3 keymap, §4 composer |
| F5 Ctrl-C/Esc/Ctrl-D matrix | §3.2 table and §3.3 state machine |
| F6 review prompt | §6 |
| F7 sessions, steering, history | §8 |
| F8 money | §9 |
| F9 secrets | §10 |
| F10 onboarding, trust, AGENTS.md | §11 |
| F11 git, undo, diff | §12 |
| F12 errors, retry, crash, logs | §13 |
| F13 additive contract list | §15 |
| F14 config schema | §16 |
| F15 packaging | §17 |
| F16 views | §7 |
| F17 fuzzy matcher | §5.4 |
| F18 no deps, strict TS, tests, perf gates | §18, §19, §20 |

---

## 1. Entry points and modes

### 1.1 Commands (`src/cli/args.ts`, `Command` union grows additively)

| argv | Command | Renderer | Composer | Follow-ups | Exits after run | Index/history writes | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `jevcode` / `jevcode chat` | `chat` | Ink session TUI | yes (first frame) | yes | no (`/exit`, Ctrl-D, Ctrl-C×2) | yes (`source: 'cli'`) | A54, 10 §15.4 |
| `jevcode run "<task>"` | `run` | Ink one-shot monitor | yes (steer + read-only commands only) | no | yes, `exitCodeFor` | index yes, history yes | F1, A54 |
| `jevcode run --resume <id>` | `run` | Ink one-shot | yes | no | yes | yes | §9 DESIGN |
| `jevcode chat --resume <id\|title>` / `-c` | `chat` | Ink session | yes | yes | no | yes | A56 |
| `jevcode run --plain "<task>"` on a TTY | `run` | plain + readline composer | line-mode (`> ` prompt) | no | yes | yes | F1, A98 |
| `jevcode chat --plain` on a TTY | `chat` | plain + readline composer | line-mode | yes | no | yes | F1 |
| `--plain` with stdin not a TTY, or `CI`, or `TERM=dumb` | `run` | plain | none (task from argv / `--task-file` / stdin) | no | yes | index yes, history no | A82, A124 |
| `--json` (implies `--plain`, non-interactive) | `run` | NDJSON stream | none | no | yes | index yes, history no | A61, §8.9 |
| `jevcode bench` / `jevcode perf` | as today | none | none | n/a | yes | **never** (`source: 'bench' \| 'perf'`) | A55, A129 |
| `jevcode config [--json]`, `config set <k> <v>` | `config` | text | — | — | — | — | §16 |
| `jevcode sessions [reindex\|prune --older-than <d>]` | `sessions` | text | — | — | — | — | A55 |
| `jevcode login [...]`, `logout [...]` | `login`/`logout` | raw-mode masked prompt | — | — | — | — | A125 |
| `jevcode report <id>`, `why <id> <step> <ref>`, `calibration [--runs-dir] [--since]` | text | — | — | — | — | A169, A47 |
| `jevcode doctor [--terminal]`, `completion bash\|zsh\|fish`, `upgrade [...]`, `--version [--json]` | text before importing Ink | — | — | — | — | A75, A68, A69, A65 |

`parseCliArgs`: an empty argv or a first token that is a flag maps to `{ command: 'chat', ... }` (today it is a
`UsageError`); `chat` accepts every `run` flag except `--task-file`/positional task (a positional with `chat` is a
usage error naming `jevcode run`). `--version`/`--help` stay answered in `main()` before any dynamic import (A65).

### 1.2 Interactive predicate and first frame

`interactive = Boolean(stdout.isTTY) && Boolean(stdin.isTTY) && !flags.plain && !flags.json && env.TERM !== 'dumb'
&& !isCi(env)` (A82; `isCi` = `CI`/`CONTINUOUS_INTEGRATION` set and not `0`/`false`). `--no-input`/`JEVCODE_NO_INPUT=1`
does not change the renderer; it suppresses every prompt (C46).

First frame (argv only, zero network, DESIGN §12): `<Static>` header item (`jevcode <session|task> | step 0/– starting`),
the rule row, the composer (`chat`: active and empty; `run`: active, one row, placeholder `steer…`), the status line
with the `step 0/–` sentinel. `perf/first-frame.ts` gates `jevcode chat --perf-exit-after-first-frame` and
`jevcode run "x" …` both (< 300 ms cold p95, §18). Everything else (config, `.env`, index, `missingSecrets`, trust,
`AGENTS.md`, git probe) happens after `renderer.firstFrame()` resolves.

### 1.3 Session controller (`src/session/controller.ts`)

One object wires composer, engine(s) and money for both Ink and readline composers:

```ts
export interface SessionController {
  readonly sessionId: string | null;            // first run id; null until the first run starts
  readonly workspace: string;
  state(): SessionState;                         // { run: 'none'|'live'|'ended'|'paused', runId, meter, pending... }
  startRun(task: string, opts?: { seedFrom?: string; resumeId?: string }): Promise<void>;   // creates the engine
  steer(text: string): SteerResult; unsteer(): string | null; pause(): void; abort(reason: 'human_abort'): void;
  command(line: string): Promise<CommandOutcome>;   // the one slash dispatcher (§5)
  on(fn: (e: SessionEvent) => void): () => void;    // engine events + session:* + ui notices
  exit(code?: number): Promise<never>;
}
```
`createSessionController(deps)` is called by `cli/main.tsx` after the first frame; `run` mode uses the same object with
`policy: 'oneshot'` (exit on `run:end`).

---

## 2. Layout

### 2.1 `computeLayout(rows, columns, state)` (`src/tui/layout.ts`, pure)

Vertical order of the dynamic region, top to bottom: **rule/tab header → live → loop banner → overlay (review box |
wizard | follow-up confirm | blocking pane | picker) → pane → palette → queue → secret row → composer → status.**
Caps (A109/F3): composer 1–6 (8 at rows ≥ 40), queue ≤ 2, pane ≤ 12, review = header 8 + preview ≤ 8, wizard ≤ 4,
follow-up confirm 5, secret row 1, retry row inside the ≤ 2-row live region, palette ≤ 8 (header + ≤ 7 rows), picker
≤ 13 (header + ≤ 8 rows + ≤ 4 preview), blocking pane ≤ 4, loop banner 1. Yield order when short: **pane → live →
preview → queue → composer-to-1**; a pending review collapses the composer to one row (P68 resolved per F3).

```ts
export type Overlay =
  | { kind: 'none' }
  | { kind: 'review'; previewLines: number; expanded: boolean }
  | { kind: 'wizard'; rows: 2 | 3 | 4 }
  | { kind: 'followup-confirm' }                         // 5 rows
  | { kind: 'blocking'; rows: 1 | 2 | 3 | 4 }
  | { kind: 'picker'; rows: number; preview: number }    // rows ≤ 8, preview ≤ 4
  | { kind: 'palette'; rows: number }                    // ≤ 8 incl. header; sits above the composer
  | { kind: 'help'; rows: number };                      // ≤ 12, replaces the pane

export interface LayoutInput {
  rows: number; columns: number;
  run: 'none' | 'live' | 'ended' | 'paused';
  composerWant: number;   // visual rows of the draft, ≥ 1
  queue: number;          // queued steers (0..8)
  liveWant: 0 | 1 | 2;    // streaming tail / synth strip / retry rows
  loopBanner: boolean; secretRow: boolean;
  paneWant: number;       // rows the active tab can fill (0..12)
  overlay: Overlay;
}
export interface Layout {
  budget: number; tiny: 'none' | 'notice' | 'status-only';
  status: number; rule: number; live: number; banner: number;
  reviewHeader: number; preview: number; overlay: number; pane: number;
  palette: number; queue: number; secret: number; composer: number; total: number;
}
export const MIN_COLUMNS = 40, MIN_ROWS = 8, PANE_MAX = 12, QUEUE_MAX = 2, REVIEW_HEADER = 8, PREVIEW_MAX = 8;
export function composerCap(rows: number): number { return rows >= 40 ? 8 : 6; }

export function computeLayout(rows: number, columns: number, s: LayoutInput): Layout {
  const budget = Math.max(0, Math.floor(rows) - 2);
  const L: Layout = { budget, tiny: 'none', status: 0, rule: 0, live: 0, banner: 0, reviewHeader: 0, preview: 0, overlay: 0, pane: 0, palette: 0, queue: 0, secret: 0, composer: 0, total: 0 };
  let rem = budget;
  const take = (want: number): number => { const got = Math.max(0, Math.min(want, rem)); rem -= got; return got; };
  if (rows < 3) { L.tiny = 'status-only'; L.status = take(1); L.total = budget - rem; return L; }
  if (rows < MIN_ROWS || columns < MIN_COLUMNS) {          // A100: notice + composer + status, transcript keeps flowing
    L.tiny = 'notice'; L.status = take(1); L.overlay = take(1); L.composer = take(1); L.total = budget - rem; return L;
  }
  L.status = take(1); L.rule = take(1); L.composer = take(1);                          // mandatory 3
  const o = s.overlay;
  if (o.kind === 'review') L.reviewHeader = take(REVIEW_HEADER);                        // keys line is row 2 (§6)
  else if (o.kind === 'wizard') { L.overlay = take(o.rows); rem += L.composer; L.composer = 0; } // the wizard is the input
  else if (o.kind === 'followup-confirm') L.overlay = take(5);
  else if (o.kind === 'blocking') L.overlay = take(o.rows);
  else if (o.kind === 'picker') L.overlay = take(1 + Math.min(o.rows, 8) + Math.min(o.preview, 4));
  else if (o.kind === 'help') L.overlay = take(Math.min(o.rows, 12));
  if (s.secretRow) L.secret = take(1);
  if (o.kind === 'palette') L.palette = take(Math.min(o.rows, 8));
  L.queue = take(Math.min(s.queue, QUEUE_MAX));                                          // yields 4th
  if (o.kind !== 'review' && o.kind !== 'wizard') L.composer += take(Math.min(s.composerWant, composerCap(rows)) - 1); // yields last
  if (o.kind === 'review') L.preview = take(o.expanded ? o.previewLines : Math.min(o.previewLines, PREVIEW_MAX)); // yields 3rd
  if (o.kind !== 'review') L.live = take(Math.min(s.liveWant, 2));                       // reclaimed while a review is pending (A42); yields 2nd
  if (s.loopBanner) L.banner = take(1);
  if (!(o.kind === 'review' && o.expanded) && o.kind !== 'picker' && o.kind !== 'help') L.pane = take(Math.min(s.paneWant, PANE_MAX)); // yields 1st
  L.total = budget - rem;
  return L;
}
```

Invariants (unit-tested at rows 3/5/8/12/24/40/50 × columns 20/40/80/120/400): `total ≤ budget`; `composer ≥ 1` unless
wizard/tiny; `reviewHeader ≥ min(2, …)` whenever `budget ≥ 5` so the keys line (row 2) survives; no pane row is granted
before the composer's growth, the queue and the preview are satisfied. `Layout` is computed once per render from
reducer state; every pane is `<Box height={n} overflow="hidden">` with `<Text wrap="truncate">` rows (A10, R32).

### 2.2 Allocation table (rows → panes), columns 80 and 120 identical unless noted

| State | rows 8 (B 6) | rows 12 (B 10) | rows 24 (B 22) | rows 40 (B 38) | rows 50 (B 48) |
| --- | --- | --- | --- | --- | --- |
| idle composer (1-row draft) | st1 rule1 comp1 pane3 = 6 | st1 rule1 comp1 pane7 = 10 | 1+1+1+pane12 = 15 (7 spare) | 15 | 15 |
| idle, 6-row draft | comp yields to 3 (pane 0 → live 0): 1+1+3+pane1 = 6 | 1+1+6+pane2 = 10 | 1+1+6+12 = 20 | comp cap 8: 1+1+8+12 = 22 | 22 |
| live, streaming (comp 1, live 2) | 1+1+1+live2+pane1 = 6 | 1+1+1+2+pane5 = 10 | 1+1+1+2+12 = 17 | 17 | 17 |
| live, 2 queued steers, 3-row draft | 1+1+3+queue1 = 6 (live 0, pane 0) | 1+1+3+2+live2+pane1 = 10 | 1+1+3+2+2+12 = 21 | 21 | 21 |
| live, loop banner | 1+1+1+2+banner1 = 6 (pane 0) | 1+1+1+2+1+pane4 = 10 | 1+1+1+2+1+12 = 18 | 18 | 18 |
| review pending (preview 8 wanted) | 1+1+1+header3 = 6 | 1+1+1+header7 = 10 | 1+1+1+8+preview8+pane3 = 22 | 1+1+1+8+8+12 = 31 | 31 |
| review + 2 queued steers | header3 (queue 0) | header7 (queue 0) | 1+1+1+8+2+8+pane1 = 22 | 1+1+1+8+2+8+12 = 33 | 33 |
| review, `e` expanded, 40-line preview | header3 | header7 | 1+1+1+8+preview11 = 22 (pane 0) | 1+1+1+8+27 = 38 | 1+1+1+8+37 = 48 |
| palette open (8 rows), idle | 1+1+1+pal3 = 6 | 1+1+1+pal7 = 10 | 1+1+1+8+pane11 = 22 | 1+1+1+8+12 = 23 | 23 |
| picker open (8 rows + 4 preview) | 1+1+1+picker3 | 1+1+1+picker7 | 1+1+1+13 = 16 | 16 | 16 |
| wizard (key field, 3 rows) | 1+1+wiz3 = 5 (comp 0) | 1+1+3+pane5 = 10 | 1+1+3+12 = 17 | 17 | 17 |
| wizard (trust, 4 rows) | 1+1+wiz4 = 6 | 1+1+4+pane4 | 1+1+4+12 = 18 | 18 | 18 |
| follow-up budget confirm | 1+1+1+conf3 = 6 | 1+1+1+5+pane2 = 10 | 1+1+1+5+12 = 20 | 20 | 20 |
| retry row (live 2), comp 1 | 1+1+1+2+pane1 = 6 | 1+1+1+2+pane5 = 10 | 1+1+1+2+12 = 17 | 17 | 17 |
| blocking pane (4 rows), paused | 1+1+1+blk3 = 6 | 1+1+1+4+pane3 = 10 | 1+1+1+4+12 = 19 | 19 | 19 |
| secret gate row + 2-row draft, live | 1+1+2+sec1+live1 = 6 | 1+1+2+1+2+pane3 = 10 | 1+1+2+1+2+12 = 19 | 19 | 19 |
| minimum-size notice (rows < 8 or cols < 40) | rows 7: st1 notice1 comp1 = 3 | — | — | — | — |

Rows 50 never grows the pane past 12 or the composer past 8 (A109); the region simply ends above the spare rows. At
≥ 120 columns rows carry more columns (§6, §7), never more rows.

### 2.3 Worked frames

Legend: `▏` marks the real cursor (`useCursor`, A3); lines above the rule are `<Static>` scrollback and are shown only
where they matter. All frames are ≤ their stated width.

**Frame 1 — idle session composer, 24×80 (15 dynamic rows; 7 spare).**
```
[run] jevcode session 20260920-181204-k7q2m6xa in ~/proj | step 0/– starting
[run] git main ↑2 · 3 modified · 1 untracked
[run] sandbox seatbelt — writes confined to the workspace and run dirs
decisions  no run yet   c~ = derived |2p−1|    [d]ecisions [p]lan [t]ime [s]ynth
recent  fix parse_date tz handling · 2h ago · $0.152 · complete  Enter continues
        decisions appear here as Jev makes them: stage · id · p · c · verdict
        /why <ref> explains one decision; /calibration summarises the record










> Describe the task… ( / commands · @ files · Enter runs · ? help )▏
step 0/–  idle  ~/proj                        run cap $2.00  sess $0.15/10.00 ok
```

**Frame 2 — live run, generator streaming, 24×80 (17 rows).**
```
decisions  s7  c~ = derived |2p−1|             [d]ecisions [p]lan [t]ime [s]ynth
def parse_date(s: str) -> datetime:
    return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 context  tests/test_a.py  noul   ██████▏···  0.62  c 0.24~
s6 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s6 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s6 risk     plan_mismatch    L0     ███████▌··  0.75  c 0.80   [ok]
s6 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s6 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s6 judge    succeeded        noul   ████████▍·  0.84  c 0.68~
s6 judge    error_present    noul   ▊·········  0.09  c 0.82~
s6 complete task_complete    noul   ███▏······  0.31  c 0.38~
> ▏
step 7/40  ⠹ propose 6.1s  fix parse_da…  run $0.31/2.00 ok  sess $0.46/10.00 ok
```

**Frame 3 — live run, 2 queued steers, 3-row draft, 24×80 (21 rows).** Queue rows sit directly above the composer;
`Up` on the composer's first row takes the newest back (`engine.unsteer()`, A53/C22).
```
decisions  s8  c~ = derived |2p−1|             [d]ecisions [p]lan [t]ime [s]ynth
$ pytest -q tests/test_a.py
...F.                                                             [ 83%]
s8 intent   intent           verify ███████▏···  0.71  c 0.64   chosen
s8 intent   can_verify       noul   ████████▍·  0.84  c 0.68~
s8 intent   plan_still_valid noul   ███████▊··  0.78  c 0.56~
s8 risk     destructive      L0     ██████████  1.00  c 1.00   [ok]
s8 risk     out_of_scope     L0     █████████▌  0.95  c 0.96   [ok]
s8 risk     plan_mismatch    L0     ████████▊·  0.88  c 0.90   [ok]
s8 risk     irreversible     L0     ██████████  1.00  c 1.00   [ok]
s8 risk     matches_intent   noul   █████████·  0.90  c 0.80~
s7 judge    succeeded        noul   ████████▍·  0.84  c 0.68~
s7 judge    error_present    noul   ▊·········  0.09  c 0.82~
s7 complete task_complete    noul   ████▍·····  0.44  c 0.12~
s7 judge    done_0           noul   ████████▊·  0.88  c 0.76~
steer 1 › also add a regression test for the 1970-01-01 edge case   applies s9
steer 2 › do not touch utils.py                                    Up takes back
> and when the suite is green, update CHANGELOG.md under "Unreleased"
  with one line that mentions the timezone fix; keep the wording short
  and do not add a version number▏
step 8/40  ⠼ execute 1.2s  fix parse_da…  run $0.35/2.00 ok  sess $0.50/10.00 ok
```

**Frame 4 — review pending, 24×80 (22 rows: header 8, preview 8, pane 3, composer 1).** No spinner while a review is
pending (A50); the two live rows are reclaimed (A42).
```
decisions  s7  c~ = derived |2p−1|             [d]ecisions [p]lan [t]ime [s]ynth
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
dimension     lvl  0  ┆   ┆ 1   risk  bnd   conf  Jev's dominant level (why)
destructive   L1   ██▌·······  0.25  exp   0.93  changes files whose previous c…
out_of_scope  L0   ··········  0.00  tail  0.98  directly does what `plan.remai…
plan_mismatch L2   ████▍·····  0.44  tail  0.61  skips a planned verification s…
irreversible  L0   ··········  0.00  exp   0.96  no lasting effect, or restorab…
matches_intent     ████████▊·  0.88  noul  0.76~ the action is an instance of t…
  --- old
  def parse_date(s: str) -> datetime:
      return datetime.strptime(s, FMT)
  +++ new
  def parse_date(s: str) -> datetime:
      return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
  
  …[3 more preview lines: e expands]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     matches_intent   noul   ████████▊·  0.88  c 0.76~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
> review pending — y n d e w answer it; text here is a steer for step 8▏
step 7/40  review  fix parse_da…  run $0.31/2.00 ok  sess $0.46/10.00 ok
```

**Frame 5 — review pending, 12×80 (10 rows: header 7, composer 1).** The `matches_intent` row is the one cut; the
keys line survives because it is row 2 (A39).
```
decisions  s7                                  [d]ecisions [p]lan [t]ime [s]ynth
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
dimension     lvl  0  ┆   ┆ 1   risk  bnd   conf  Jev's dominant level (why)
destructive   L1   ██▌·······  0.25  exp   0.93  changes files whose previous c…
out_of_scope  L0   ··········  0.00  tail  0.98  directly does what `plan.remai…
plan_mismatch L2   ████▍·····  0.44  tail  0.61  skips a planned verification s…
irreversible  L0   ··········  0.00  exp   0.96  no lasting effect, or restorab…
> ▏
step 7/40  review  fix parse_da…  run $0.31/2.00 ok  sess $0.46/10.00 ok
```

**Frame 6 — review pending, 40×120 (31 rows: header 8 with P(l)/E[k]/tail columns, preview 8, pane 12, composer 1).**
```
decisions  s7  c~ = derived |2p−1|                                       [d]ecisions [p]lan [t]imeline [s]ynth  [?] help
review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"          jev 244ms
[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      Ctrl-C aborts the run
dimension      lvl  0  ┆   ┆ 1   risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)
destructive    L1   ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverabl…
out_of_scope   L0   ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]` or `task` a…
plan_mismatch  L2   ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step
irreversible   L0   ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git comm…
matches_intent      ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent `edit`
  --- old
  def parse_date(s: str) -> datetime:
      return datetime.strptime(s, FMT)
  +++ new
  def parse_date(s: str) -> datetime:
      return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
  
  …[3 more preview lines: e expands]
(12 pane rows: the decisions tab, newest first, as in Frame 2 with the 120-column latency and text columns of §7.1)
> ▏
step 7/40  review  fix parse_date t…  run $0.31/2.00 █▌········ ok  sess $0.46/10.00 ▍········· ok  ⎇ main ↑2  ? help
```

**Frame 7 — palette open on `/d`, idle, 24×80 (22 rows: pane 11, palette 4 of 8, composer 1).**
```
decisions  no run yet                          [d]ecisions [p]lan [t]ime [s]ynth
recent  fix parse_date tz handling · 2h ago · $0.152 · complete  Enter continues
(10 more pane rows)
▲ commands matching "d"  (1/3)           Tab completes · Enter runs · Esc closes
> /decisions [n] [stage]        expand the last n Jev decisions into scrollback
  /diff [step] [--full] [--all] stat block of the run's changes (--full: $PAGER)
  /doctor                        versions, paths, sandbox, terminal capabilities
> /d▏
step 0/–  idle  ~/proj                        run cap $2.00  sess $0.15/10.00 ok
```

**Frame 8 — session picker, idle, 24×120 (16 rows: header + 8 rows + 4 preview on Space, filter in the composer).**
```
sessions  ~/proj (Ctrl-A all)  sort: updated  ↑↓ move · Enter resume · Space preview · Ctrl-R rename · x delete · Esc
  2h ago    12 steps  complete    $0.152  fix parse_date tz handling
› 5h ago    23 steps  spend_cap   $1.532  migrate the CLI parser to node:util parseArgs and keep the hidden aliases
  1d ago     4 steps  human_pause $0.041  investigate why test_kth is flaky on CI
  1d ago    40 steps  max_steps   $0.984  refactor the sieve runner lanes
  2d ago     7 steps  error       $0.112  add --json to jevcode config
  3d ago    31 steps  complete    $0.871  QuixBugs ladder rung 4 (jev-only)
  3d ago     2 steps  human_abort $0.009  try the new decider alias
  4d ago    18 steps  complete    $0.640  rename extra-env paths
  plan  done 6 / remaining 2 / unverified 1   spend $1.532 of $1.500 (over)   stopped at step_start
  [step 23] outcome executed: ran pytest -q (exit 1, 8.2s) changed=0
  [step 23] judge succeeded=0.31 error_present=0.88 new_info=0.42 tests=39p/2f/0e fail completion=0.22
  [run] stop: spend_cap at step 23
> ▏  type to filter (title, task, run id)
step 0/–  idle  ~/proj                        run cap $2.00  sess $0.15/10.00 ok
```

**Frame 9 — onboarding wizard, key field, 24×80 (17 rows: wizard 3, pane 12, no composer) and 8×40 (wizard 3).**
```
decisions  no run yet                          [d]ecisions [p]lan [t]ime [s]ynth
Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  step 2 of 2
> ••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••▏
72 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back
(12 pane rows, empty state as in Frame 1)
step 0/–  setup                                                 keys never shown
```
```
Jev API key (JEV_API_KEY)  2/2
> •••••••••••••••••••••••••••••••••••••▏
72 · Enter · ⌫ · ^U · Esc
step 0/–  setup
```

**Frame 10 — follow-up budget confirm, 24×80 (20 rows: box 5, pane 12, composer 1 inactive).** Enter is inert (A132).
```
decisions  s12  run ended                      [d]ecisions [p]lan [t]ime [s]ynth
┌ follow-up would exceed the session cap ─────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71           │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap) │
└─────────────────────────────────────────────────────────────────────────────┘
(12 pane rows)
> now port the same fix to the JS client                    (waiting for y/r/n)
step 12/40  ended  fix parse_da…  run $0.71/2.00 ok  sess $9.58/10.00 critical
```

**Frame 11 — retry row inside the live region, 12×80 (10 rows).** 1 Hz tick, spinner unchanged (A160).
```
decisions  s3                                  [d]ecisions [p]lan [t]ime [s]ynth
jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)   [r] retry now
last: HTTP 429 · request-id gen-9f3a…                     Esc pauses at boundary
s3 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s3 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s2 judge    succeeded        noul   ████████▍·  0.84  c 0.68~
s2 complete task_complete    noul   ███▏······  0.31  c 0.38~
s2 judge    done_0           noul   ████████▊·  0.88  c 0.76~
> ▏
step 3/40  ⠹ context 14s retrying 2/3   fix parse_date tz   run $0.04/2.00 ok
```

**Frame 12 — minimum-size notice, 7×40 (3 rows) and status-only, 2×40.**
```
terminal 40x7 — need 40x8; log continues
> ▏
step 3/40 ⠹ risk $0.31/2.00
```
```
step 3/40 ⠹ risk $0.31/2.00 (40x2)
```

**Frame 13 — 50×120 idle with an 8-row draft: 1 + 1 + 8 + 12 = 22 rows, 26 spare** (composer cap 8 at rows ≥ 40; pane
cap 12; the spare rows stay blank above the region, never a taller frame — A109).

---

## 3. Keymap and key contexts

### 3.1 Contexts and the matcher (A16, A17)

One typed registry `src/tui/keys/registry.ts`: `KeyBinding = { id: 'composer:submit' | …; keys: KeySpec[]; context: KeyContext; title: string }`,
consumed by the matcher, the palette, `?` help, the status ShortHelp, `jevcode keys` and a generated `docs/KEYS.md`
with a sync test. Contexts, highest precedence first: **Modal** (`secret-gate`, `followup-confirm`, `blocking`, `wizard`,
`picker`, `palette`, `help`) → **Review** (while the review box is *visible*, §6.4) → **Composer** → **Global**. The matcher
`resolveKey(ev: KeyEvent, ctx: KeyContextState): Command | null` reads reducer state (draft empty?, run live?, review
visible?, overlay kind), never subscription order (R12). `useFocus` is never used (A13). One `useInput` + one `usePaste` in
`<App>`, both `{ isActive: Boolean(isRawModeSupported) }` (A14).

| Key | Composer / Global action | Ink condition |
| --- | --- | --- |
| Enter | submit (task, follow-up, steer, `/command`); submit re-entrancy guard; empty buffer → no-op | `key.return && !shift && !meta && !ctrl` |
| Ctrl+J, `\`+Enter, Alt+Enter, kitty `CSI 13;2u`/`13;5u`, `ESC CR`, xterm `CSI 27;m;13~` | newline | `input==='\n'`; trailing `\`; `return && (meta\|shift\|ctrl)`; `/^\[27;[2-8];13~$/` swallowed (A6, C28) |
| Ctrl+A/Home, Ctrl+E/End | logical-line start/end | |
| Ctrl+B/←, Ctrl+F/→ | grapheme back/forward | |
| Alt+B/Ctrl+←, Alt+F/Ctrl+→ | word back/forward (`Intl.Segmenter` word) | `meta && 'b'`, `ctrl && leftArrow` |
| Ctrl+K, Ctrl+U | kill to line end / start (kill ring) | |
| Ctrl+W / Alt+Backspace, Alt+D / Alt+Delete / Ctrl+Delete | kill word back / forward | |
| Ctrl+Y, Alt+Y | yank, yank-pop | |
| Ctrl+T | transpose graphemes | |
| Ctrl+_ (`0x1f`) | undo; Alt+_ redo (Ctrl+6 `0x1e` also redo) | `input==='\u001f'` (A8) |
| Backspace/Ctrl+H, Delete | delete back / forward | |
| ↑/↓ | move by visual row; from row 0 / last row → history prev/next (or take back the newest steer, §8.4) | A7, C22 |
| Ctrl+P / Ctrl+N | history prev/next always | |
| Ctrl+R | reverse-incremental history search (§4.5) | |
| Tab / Shift+Tab | completion accept / cycle back; `→` at end accepts ghost text | A34 |
| `/` at column 0 | open palette pre-filled with `/` | |
| `@` | file mention over the candidate list (§5.5) | |
| `?` on empty composer, F1 | help overlay | A21 |
| Ctrl+O | append detail items for the last step's decisions and warnings to `<Static>` (A22); also acknowledges `!n` |
| Ctrl+G | external editor via `suspendTerminal` (§4.7) | A11 |
| Ctrl+Z | suspend: erase frame, exit string, raw off, `SIGTSTP` self; `SIGCONT` re-arms raw/2004 and repaints (A23) |
| Ctrl+L | erase-lines repaint (Ink `log.clear()`), never `ESC[2J` (A8, R29) |
| `[` / `]` on an empty composer | cycle the pane tabs (d p t s); with text in the draft they are ordinary characters (F16, A44) |
| Ctrl+C, Esc, Ctrl+D | §3.2 |

No leader key, no Ctrl+P/Ctrl+K palette chords (R8), no `!` shell mode, no `/compact` (F4). `~/.config/jevcode/keybindings.json`
(A24): `{ "composer:submit": "enter", "global:help": ["?", "f1"], "composer:kill-line": "none", "chords": { "ctrl+x ctrl+s": "session:export" } }`;
chords time out at 3 s; reserved and unbindable: Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I.

### 3.2 Ctrl-C / Esc / Ctrl-D matrix (F5; 19 §4 adopted, A110)

| State | Mode | Ctrl-C (1st) | Ctrl-C (2nd, ≤ 1.5 s) | Esc | Esc Esc (≤ 2 s) | Ctrl-D |
| --- | --- | --- | --- | --- | --- | --- |
| idle, composer empty | session | status hint `press Ctrl-C again to exit` | exit 0 | no-op | rewind/steer menu (`/rewind` picker) | hint `press Ctrl-D again to exit`; 2nd ≤ 800 ms → exit 0 |
| idle, composer text | either | clear draft → history (`kind:'prompt'`, unsent) | as idle-empty | first Esc arms (hint `Esc again clears`) | clear draft → history | delete-forward |
| live, composer empty | one-shot | `shutdown('human_abort')` → checkpoint → exit 130 | `process.exit(130)` (DESIGN §11) | `engine.pause()` → `human_pause` at the next boundary; status `pausing after step N` | `engine.abort('human_abort')` | hint; 2nd → confirm box `exit and abort the run? [y/N]` |
| live, composer empty | session | `engine.abort('human_abort')` → checkpoint → `run:end` item; composer reopens; **no exit** | `process.exit(130)` only while `aborting` | pause as above | abort as above | as one-shot; `y` aborts then exits 130 |
| live, composer text | either | clear draft (never abort while text is present) | as live-empty | arms clear | clear draft → history | delete-forward |
| review pending (box visible) | either | decline **and** abort (`confirmer.resolve(id,false)` then `abort`) | `process.exit(130)` | decline | — (single Esc already declined) | ignored |
| review pending, composer text | either | clear draft first | as above | decline (review context wins) | — | delete-forward |
| modal overlay (palette/picker/help/wizard/gates) | either | close overlay (wizard: print fix block, exit 2) | — | close overlay / step back | — | ignored |
| `aborting` set (any state) | either | `process.exit(130)` immediately (DESIGN §11 invariant) | — | — | — | — |

Windows: Ctrl-C 1.5 s (06 §17.1), Esc Esc 2 s (10 §15.4), Ctrl-D 800 ms (A19), Esc re-buffer 30 ms above Ink's 20 ms
flush (A20: `escape && meta` or two `escape` events ≤ 30 ms apart are one Esc Esc; a lone Esc is acted on only after
30 ms with no follow-up byte). Single Esc is never destructive. `/exit` always exits 0 (A170); `--exit-code=last-run`
makes `/exit`/Ctrl-D return the last `run:end.exitCode`.

### 3.3 Composer/run state machine (reducer field `ui.mode`)

```
                      ┌────────── Enter(text) ──────────┐
 idle:empty ──type──▶ idle:text ──Enter──▶ starting ──run:ready──▶ live:empty ──type──▶ live:text
    ▲  ▲                 │ Ctrl-C/EscEsc              ▲          │ Enter → steer:queued ─┘  (queue ≤ 8)
    │  │                 └─── clear → idle:empty      │          │ Esc → pausing ── boundary ──▶ ended(human_pause)
    │  └── run:end (session) ─────────────────────────┴──────────┤ EscEsc/Ctrl-C(empty) → aborting ── run:end ──▶ ended(human_abort)
    │                                                             │ confirm:request ──(idle 1 s, drained)──▶ review:visible
    │                                                             │      y/n/d/e/w/Esc ── confirm:resolved ──▶ live:*
    └── ended:* ──Enter(text)──▶ [followup-confirm?] ──y──▶ starting (seeded, §8.3)     one-shot: ended ──▶ exit(code)
 overlays (palette, picker, help, wizard, secret-gate, followup-confirm, blocking) push onto any state and pop on Esc/close.
```
Transitions that touch the engine: `starting` (`controller.startRun`), `steer:queued` (`engine.steer`), `pausing`
(`engine.pause`), `aborting` (`engine.abort`), `review:*` (`confirmer.resolve`). Every other transition is UI-only.

---

## 4. Composer (`src/tui/composer/*`, ink+react only; A1–A12)

### 4.1 TextBuffer model and reducer

```ts
export interface TextBuffer {
  text: string;                 // logical text, '\n' separated; never contains C0 (except \n \t) or CSI leak-through
  cursor: number;               // UTF-16 index, always on a grapheme boundary (Intl.Segmenter grapheme)
  anchor: number | null;        // selection (Shift+arrows in kitty terminals only; v1 renders it, never copies it)
  chips: readonly PasteChip[];  // { n, lines, bytes, sha256 } — bodies live in a useRef Map, never here (F9)
  killRing: readonly string[];  // ≤ 16 entries; survives submit (A8)
  yankIndex: number | null;
  undo: readonly BufferSnapshot[]; redo: readonly BufferSnapshot[];   // ≤ 100 each; { text, cursor }
  history: { level: number | null; stash: string | null; search: { query: string; hit: number } | null };
  secretHits: readonly SecretHit[];   // detectSecrets(text with chips expanded) on every change (A153)
}
export type BufferAction =
  | { type: 'insert'; text: string; paste?: boolean }            // sanitised; paste = one undo step
  | { type: 'newline' } | { type: 'delete'; dir: 'back' | 'forward'; unit: 'grapheme' | 'word' | 'line-start' | 'line-end' }
  | { type: 'move'; to: 'left' | 'right' | 'word-left' | 'word-right' | 'line-start' | 'line-end' | 'up' | 'down' | 'doc-start' | 'doc-end'; select?: boolean }
  | { type: 'transpose' } | { type: 'yank' } | { type: 'yank-pop' } | { type: 'undo' } | { type: 'redo' }
  | { type: 'set-text'; text: string; cursor?: number; pushUndo: boolean }  // history recall, editor return, take-back
  | { type: 'chip-add'; chip: PasteChip } | { type: 'chip-remove'; n: number }
  | { type: 'history'; dir: 'prev' | 'next'; entries: readonly string[] } | { type: 'history-search'; query: string | null; step?: 1 | -1 }
  | { type: 'clear' } | { type: 'resize'; columns: number };
export function bufferReducer(b: TextBuffer, a: BufferAction): TextBuffer;   // pure, unit- and property-tested (A106)
export function layout(b: TextBuffer, columns: number, gutter: number): Row[]; // Row = { start, end, hard, cells }
export function cursorXY(rows: Row[], b: TextBuffer): { row: number; x: number };
```
Coalescing: consecutive single-grapheme inserts form one undo step (A1); a paste, a kill, `set-text` are one step each.
Word motion uses `Intl.Segmenter(undefined, { granularity: 'word' })` with `isWordLike` (08 §8; CJK cost Q17 accepted).

### 4.2 `cellWidth` (`src/tui/text/width.ts`, A2, C20)

Rules replicate `string-width@8.2.2`: (1) zero width when the cluster matches
`/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v`;
(2) `/^\p{RGI_Emoji}$/v` → 2; (3) keycap `^[\d#*]️?⃣$` and ZWJ sequences with ≥ 2 `\p{Extended_Pictographic}` → 2;
(4) Hangul L+V(+T) → 2; (5) EAW Wide/Fullwidth of the first scalar → 2 via a checked-in `eaw-table.ts` (125 + 3 ranges,
generated at build from the devDependency `get-east-asian-width`, Unicode version in the header); ambiguous = narrow;
tab is expanded to spaces on insert. Fixture test against `string-width` over 07 §4's corpus (A108). All truncation is
by grapheme through `truncateCells(s, cells)` (A99).

### 4.3 Rendering and cursor

Composer box = `<Box height={layout.composer} flexDirection="column" overflow="hidden">`; rows are pre-sliced strings
(`<Text wrap="truncate">`), row 0 prefixed `> ` (`>` yellow while a run is live = steer mode; `»` when the composer is a
picker filter), continuation rows `  `; gutter markers `↑N`/`↓N` in the last column when scrolled. `scrollTop =
clamp(scrollTop, cursorRow − h + 1, cursorRow)`. The real cursor is placed during render:
`setCursorPosition({ x: 2 + cursorX, y: dynamicTop + composerTop + cursorRow − scrollTop })` where `dynamicTop` is the
row index of the rule within the frame (derived from `Layout`, no `measureElement`), and `undefined` whenever a modal
overlay or the review box owns the keys (A3). DECSCUSR steady bar (`CSI 6 SP q`) on start, `CSI 0 SP q` in the exit string.
Placeholder is a dim sibling `<Text>` (never buffer text): `Describe the task… ( / commands · @ files · Enter runs · ? help )`
idle; `steer… (queued for the next step)` live; `No API key saved — /login or set OPENROUTER_API_KEY` when keys are missing.

### 4.4 Input filter (A5) and newline keys (A6)

Drop before insertion: `key.ctrl|meta|super|hyper` (unless bound), `eventType` `release|repeat`, code units `< 0x20`
except `\t` and the newline paths, `0x7f`, and leak-through matching `/^\[(?:I|O|\d+;\d+R|27;\d+;\d+~|\?\d*u|\?[\d;]*c|<\d+;\d+;\d+[Mm])$/`.
A multi-code-point chunk without ESC is text (IME commit, A92) unless bracketed paste is absent, when a chunk ≥ 2
graphemes is paste-like (C21, no timers). `\` followed by Enter removes the backslash and inserts `\n`.

### 4.5 History and search (A7, A60)

`~/.jevcode/history.jsonl` lines `{ t, workspace, kind: 'prompt' | 'steer' | 'command', text }` (§8.6). Up from row 0
(or Ctrl+P): stash the draft, load entries filtered by workspace realpath (Ctrl+A widens), newest first; Down past the
newest restores the stash. Ctrl+R opens a one-row search field in the composer's place: `(reverse-i-search)'tz': fix
parse_date tz handling`, Ctrl+R again = next hit, Tab/Esc accept into the buffer, Enter submits, Esc with an empty query
restores the draft. Consecutive duplicates are dropped at write time.

### 4.6 Paste lifecycle (A4, F9)

`usePaste(text)`: normalise `\r\n|\r → \n`, `sanitizeStream`, strip bidi controls U+202A–202E/U+2066–2069, normalise
U+2028/2029 → `\n` (A88); > 1 MiB → toast `paste of 3.2 MB refused (limit 1 MiB); write it to a file and @-mention it`;
> 3 lines or > 800 chars → chip `[Pasted #n, k lines]` inserted as text with the body in `pasteRef.current.set(n, blob)`;
else insert as one undo step. At submit `expandChips(text, pasteRef)` replaces each chip label; an unrestored chip
(after `--resume`) cancels with `remove [Pasted #1] or paste again`. Chip bodies never enter state, reducer, events, logs,
`ui.json` or history (labels only, `[Pasted #1, 120 lines, sha256:9f86d081]`). A submission whose expanded text exceeds
12,000 chars appends the notice item `only the first 12,000 characters reach the generator; @-mention a file for more`
(P44/C50, F9). Keystroke trace logs `kind=paste len=N masked=false` only (A12).

### 4.7 External editor (A11)

Ctrl+G: write the buffer to `<runDir|tmp>/compose-<pid>.md`, `await suspendTerminal(() => spawnAndWait($VISUAL ?? $EDITOR ?? 'vi', [file], { stdio: 'inherit' }))`,
read back, `set-text` with `pushUndo: true`. Engine events arriving during the suspension are queued in the bus and
dispatched after `resume()` (`<Static>` appends during suspension are dropped, 08 §5). `$EDITOR` unset and no `vi` → toast.

### 4.8 Secret gate row (A153–A155, §10)

`detectSecrets(expanded)` runs on every buffer change (dim `⚠ secret?` marker at the end of the status left zone) and at
submit; a hit opens the one-row gate above the composer: `Looks like this contains a secret (sk-…). Send anyway? y/N`.
Only `y`/`Y` sends (after `addSecret`); Enter, Esc, `n`, any other key dismiss and the key is then handled normally; the
dismissed frame shows `Tip: put it in .env and refer to it by name` for one frame. The same gate wraps steers and `/`
lines. Non-TTY submissions with a hit are cancelled (exit path 2).

---

## 5. Palette, slash grammar, commands, `@` mention, fuzzy scorer

### 5.1 Palette (A34, A36)

Opens when `/` is typed at column 0 of an empty buffer (or `/` anywhere in a draft that is exactly `/…` on one line);
≤ 8 rows incl. the header `▲ commands matching "<q>"  (i/N)   Tab completes · Enter runs · Esc closes`; rows
`  /name <args>   one-line description` with the label column ≤ 50 % of columns; `▲`/`▼` mark hidden rows; aliases are
matched but not listed. Keys: ↑/Ctrl+P, ↓/Ctrl+N, PgUp/PgDn, Enter (runs only on an exact or unique-prefix match,
otherwise submits the typed line and reports `unknown command /dif — did you mean /diff?`), Tab (completes the name and
keeps editing arguments; a second Tab completes the argument), Esc (closes, keeps the token). `availableDuringTask: false`
commands render dim with `(after the run)` while a run is live and Enter on them queues nothing and shows a toast.

### 5.2 Slash grammar (`src/session/commands/grammar.ts`)

`tokenize(line)`: split on whitespace; `"…"`/`'…'` quote; `\` escapes the next char inside double quotes; `--flag` and
`--flag=value` are options; the first token minus `/` is the command (case-insensitive; aliases resolve);
`/steer <text>` and `/rename <title>` take the raw remainder (no tokenising). Argument specs:
`ArgSpec = { name; kind: 'int' | 'usd' | 'duration' | 'enum' | 'path' | 'run' | 'step' | 'text'; optional?; enum? }`.
Errors are toasts + `<Static>` items in one shape: `usage: /budget spend-cap <usd> | session-spend-cap <usd|none>` and
`/budget: spend-cap 1.20 is not above this run's spend $1.532; give a larger value`. `complete(cmd, argIndex, partial)`
returns candidates per kind (enum values, run ids/titles from the index, steps with changed files, paths from the
candidate list). Every command is a `CommandSpec = { name, aliases, title, args, availableDuringTask, idleOnly, run(ctx, args) }`;
the readline composer and the Ink palette share the dispatcher (F1).

### 5.3 Command table

| Command | Args | During run | Semantics (one line) |
| --- | --- | --- | --- |
| `/help [cmd]` | | yes | help overlay (≤ 12 rows) or one command's usage as an item |
| `/keys` | | yes | key sheet by context from the registry (A16) |
| `/new` | | idle | end the session; the next prompt starts a new session (new root meter) |
| `/resume [id\|title]`, `/sessions` | run | idle | picker (§8.4) or continue that run in a follow-up composer |
| `/rename <title>` | text | yes | session title (index `rename`, ≤ 60 chars) |
| `/steer <text>` | text | live only | same as Enter with text while live |
| `/pause`, `/abort` | | live only | Esc / Esc Esc equivalents |
| `/undo [n]`, `/rewind [step]` | step | idle | §12.3 |
| `/diff [step] [--full] [--all]` | step | yes (read-only, one spawn) | §12.4 |
| `/plan` | | yes | the ledger block (`[x] [ ] [?] [!]`, §7.2) appended as one item |
| `/decisions [n] [stage]` | int, enum | yes | last n `Decision` rows as items (`--plain --decisions` twin) |
| `/why <ref>` | `s7.risk.plan_mismatch` \| `risk.plan_mismatch` \| digit | yes | §7.4 block from memory (last 3 steps) or `decisions.jsonl` |
| `/calibration [--since <d>]` | duration | yes | §7.5 block over `~/.jevcode/runs/*/decisions.jsonl` + `steps.jsonl` (+ bench `tasks.jsonl`) |
| `/jev` | | yes | decider id, resolved/drift@step, questions, p50/p95, Jev cost |
| `/cost` | | yes | 14 §5.4 block (≤ 12 rows) |
| `/budget [spend-cap <usd> \| session-spend-cap <usd\|none>]` | usd | yes | §9.4 |
| `/model <id>`, `/provider <p>`, `/mode <m>` | enum | yes (next run) | next-run overrides; a live run is frozen (R21) |
| `/config`, `/doctor`, `/status` | | yes | tables/items; `/config` shows the `source` column |
| `/login`, `/logout [--generator\|--jev]`, `/trust` | | yes | §11 |
| `/export [file]` | path | yes | concatenated `transcript.log`s with run headers (A61) |
| `/copy [last\|proposal\|diff\|draft]` | enum | yes | §10.5 |
| `/errors`, `/report` | | yes | Ctrl+O twin; local bundle (A169) |
| `/theme <dark\|light\|daltonized\|ansi>` | enum | yes | applies to new items only (P20) |
| `/history clear` | | yes | truncate `history.jsonl` |
| `/exit`, `/quit` | | yes | exit 0 always (confirm if a run is live) |

Project commands `.jevcode/commands/<name>.md` (`description`, `argument-hint`, `$ARGUMENTS`) appear with a `[Project]`
tag and only produce prompt text (A63, no shell).

### 5.4 Fuzzy scorer (F17, `src/tui/fuzzy.ts`)

`score(query, candidate): number | null`, case-insensitive, word boundaries = start, after `/ _ - . :` and camelCase
humps: (1) exact → 1000; (2) prefix → 900 − len; (3) word-prefix (every query char matches at a boundary in order) →
700 − gaps; (4) subsequence → 400 − 3·gaps − 2·(first index) + 10·boundaryHits; else null. O(|q|·|c|) with an early
exit on the first missing char; ≤ 8 results kept with a fixed-size insertion sort. Unit test: 5,000 synthetic paths ×
a 3-char query in < 16 ms p95 over 200 iterations (target measured, not assumed).

### 5.5 `@` mention (A35, A157)

`@` opens a list over `workspace.listCandidates()` (cached by the engine; the controller exposes it before a run via a
one-off `createWorkspace` listing after the first frame). One async search session per query; stale rows kept in a
`waiting` state; ≤ 8 rows; Tab/Enter insert `@<path> `; paths on the denylist (`isSecretPath` + `.git/**` + `*credential*`,
`.npmrc`, `.pypirc`, `*.p12|pfx|jks`) are never offered; a typed denied path shows `.env is on the secret denylist; JevCode
never reads it. Start with --allow-secret-mention to override.` and the mention is dropped at submit (literal text stays).
Mentions become `PromptInput.pins: string[]` (§15.1 item 18): the context stage adds them to the selected files inside
the 12-file/60 KB cap (score-and-boost, P8), never bypassing Jev.

---

## 6. Review prompt (F6; A39–A42, 11 §4b, §4j)

### 6.1 Rows (`reviewHeaderLines(req, columns, matchesIntent)` in `src/tui/review/lines.ts`, exactly 8 strings)

| Row | 80 columns | 120 columns adds |
| --- | --- | --- |
| 1 | `review  step 7  risk 0.44 (tail)  edit src/a.py  "<goal ≤ 40>"` | `(tail on plan_mismatch)`, full goal, right-aligned `jev 244ms` |
| 2 | `[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline` (single spaces: 76 cells) | double spaces, `[e] expand preview`, right `Ctrl-C aborts the run` |
| 3 | `dimension     lvl  0  ┆   ┆ 1   risk  bnd   conf  Jev's dominant level (why)` | `P(l)  E[k]  tail` columns |
| 4–7 | `<dim 13>  L<k>  <bar10>  <risk>  <exp\|tail>  <conf>  <level text clipped to fit>` per `RISK_DIMENSIONS` order | full level text |
| 8 | `matches_intent      <bar10>  <p>  noul  <c>~  <criteria.true.definition clipped>` | same |

Bar = `bar(dim.risk, 10)` over a track coloured by band (cells 0–2 dim, 3–6 yellow, 7–9 red); with `NO_COLOR`/`--ascii`
the ruler `0  ┆   ┆ 1` in row 3 is the band encoding (A43). Level text = `riskLevelTexts(evidence !== undefined)[dim][level]`
(`src/loop/stages/risk.ts`). `matches_intent` comes from the same request's `decision` rows (the reducer keeps the
risk-stage rows of the pending step). Preview rows = `confirmPreviewLines(req)` clipped to `layout.preview`, last row
`…[N more preview lines: e expands]`. Row 1 and the keys row take the verdict colour (yellow review / red block), as today.
`CONFIRM_HEADER_ROWS` becomes 8 and `CONFIRM_KEYS_LINE` the row-2 text; `confirmHeaderLines` is kept as the plain twin
producer (one line per dimension, ≤ 300-char level text) so `transcript.log` gains nothing new (the box is not an item).

### 6.2 Keys and invariants

`y` approve once · `n`/Esc decline · `d` decline with note · `e` toggle expanded preview (pane → 0 rows) · `w` then `1`–`5`
(`1` destructive … `4` irreversible, `5` matches_intent) appends a `/why` block (§7.4) and keeps the box · Ctrl-C decline
and abort. Never: Enter, a highlighted default, remembered/always/session approval, approve-on-timeout, `--auto-decline`
(P5 closed: not offered), approval of a superseded request (the second request declines the first, unchanged). The bench's
`alwaysDecline` and the non-TTY `autoDeclineMs` confirmer stay. A pasted string never matches a key. `TuiConfirmer.resolve`
gains an optional note: `resolve(id: string, approved: boolean, note?: string): boolean`.

### 6.3 `d` decline with note

`d` turns the composer row into `note › ▏` (one row, ≤ 600 chars, Enter sends, Esc cancels back to the box). The note
passes `sanitizeStream` → the secret gate → `config.redact`; then `confirmer.resolve(id, false, note)`. The engine
(`confirm()`) records `draft.declineNote = note` and builds the outcome
`{ status: 'declined', reason: 'declined by reviewer: <risk.reason>; reviewer note: <note>' }` clipped to 600; the window
entry gets `notes: ['reviewer note: <note>']`. Paths to the two audiences: **generator** — `WindowEntry.reason` and
`notes` render in the next prompts' `## Recent steps` (`windowEntry()` in prompts.ts, unchanged); **Jev** — the same entry
is `recent[i].reason`/`recent[i].notes` in every following common state (`recentJson`, state.ts), so the next intent,
risk and judge questions see the human's reason (P6 answered: cap 600, Jev sees it). `confirm:resolved` gains
`note?: string` (redacted at emit) so `--json` and `transcript.log` carry `confirm <id> declined (note: …)`.

### 6.4 Deferral (A41)

`confirm:request` arrives immediately (the engine is awaiting). The reducer stores it as `pendingReview` and computes
`visibleAt = max(now, lastKeystrokeAt + 1000)`; the box renders only when `now ≥ visibleAt` **and** no key event is
queued (`inputDrained`: the App's `useInput` handler sets `lastKeystrokeAt`; a 100 ms timer re-checks). Until visible:
status left zone `review waiting (typing…)`, keys go to the composer, Ctrl-C keeps its live-run meaning. The review key
context is entered on the frame *after* the box is drawn, so a key already in flight is never an approval. The optional
notification timer (§16 `notify`) starts when the box appears, restarts on every keystroke, fires at ~6 s (A85/C48).

### 6.5 Plain and screen-reader twins

`--plain` TTY: the readline confirmer prints `confirmHeaderLines` (one line per dimension) + preview (≤ 20 rows) and
prompts `[step 7] [y] approve  [n] decline  [d] decline+note > `; `d` reads one more line as the note; `yes`/`no` accepted;
five invalid answers decline (`READLINE_MAX_PROMPTS`). `--screen-reader`: the box is a numbered list + `Enter selection
(1-3):` (`1` approve, `2` decline, `3` decline with note), typed digit + Enter, one BEL on open; bars are `aria-hidden`
and each gauge row carries `aria-label="plan_mismatch level 2, risk 0.44 tail, confidence 0.61, skips a planned verification step"`.

---

## 7. Jev-native pane, status line, toasts (F16)

### 7.1 Decision data model (`src/tui/decisions/model.ts`)

Every `decision` event becomes a `DecisionRow` for the pane and `/why`:
```ts
export interface DecisionRow {
  step: number; stage: StageName; id: string; kind: 'noul' | 'choice' | 'score';
  label: string;            // choice → answer.choice; score → `L${level}`; noul → 'noul'
  p: number; c: number; cDerived: boolean;      // Decision.probability / confidence; derived = kind === 'noul'
  verdict: DecisionVerdict | undefined; latencyMs: number; requestHash: string; servedModel?: string;
  consumedBy: string;       // the code rule that read it (table below)
  near: { threshold: number; delta: number } | null;   // |p − t| ≤ 0.03 for the rule's threshold (11 §4i)
  text: string;             // criteria text of the chosen option/level (≤ 300), for the 120-column column and /why
}
```
`consumedBy` table (DESIGN §6 "Consumers of every Jev answer"): `intent.intent` → `choice resolution (verdict)`;
`can_*` → `paired ≥ 0.5`; `plan_still_valid` → `< 0.3 → stale_plan`; `context.<path>` → `selected iff p ≥ 0.5`;
`risk.<dim>` → `band 0.3/0.7 (bound)`; `matches_intent`/`evidence_consistent` → `< 0.3 → reason text`;
`judge.succeeded|error_present|new_information` → `reported (new_info ≥ 0.7 → Plan rule b)`; `done_<j>` → `≥ 0.7 accept,
< 0.3 reject`; `task_complete` → `≥ completeThreshold → stop`; `replan.next_move`/`can_*` → resolution; `task_impossible`
→ `≥ impossibleThreshold → stop`. Reducer keeps `rows: DecisionRow[]` (last 12 for the pane) and
`byStep: Map<step, DecisionRow[]>` for the last 3 steps (for `w`+digit and `/why <digit>`); older refs read `decisions.jsonl`.

### 7.2 Tabbed pane (A44) — header on the rule row: `decisions  s7  c~ = derived |2p−1|   [d]ecisions [p]lan [t]ime [s]ynth`

| Tab | Row format at 80 columns (120 adds) | Source |
| --- | --- | --- |
| `d` decisions | `s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]` (`+ 244ms  "<text>"`); newest first; `~` after derived `c`; `!` before `p` when `near` | 11 §4a |
| `p` plan ledger | `plan  done 2  remaining 3  unverified 1  problems 2  (accept ≥ .7, reject < .3)` then `[x] <text ≤ 46>  s4  done_0 0.91`, `[?] …  s7 done_1 0.52 unverified`, `[ ] …`, `[!] replan s6 change_approach: …`, `[!] human s8: <steer text>` (120: evidence `tests 41p/0f/0e`, `openProblems` column) | 11 §4c, `plan` event |
| `t` timeline | two rows per step: `time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s` and `      s7  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 8.2s  h 31ms` (N = 40 letters; 120: one row, N = 30, `+ gen 5.4k $0.032`) | `stage:end`, `step:end` |
| `s` synth (jev-only) | `synth  goal 2/3 test_kth kth.py  site kth.py:12  SEEDS mutation d1 → templates` and `sieve  verify  tested 37/137 ██▋·······  27%  t_run 0.9s x8 lanes  runs 41 jev 3`; until the structured fields exist, row 1 = last `synth` detail verbatim, row 2 = `candidates=… tested=…` when present | 11 §4f, §15.1 item 13 |

`[`/`]` cycle tabs; the tab is remembered per session; in jev-only the default tab is `s` while a step's propose stage
runs and `d` otherwise. Below 80 columns the `p`/`c` columns are hidden and verdict words kept (A100). Reduced-motion and
screen-reader modes render the same strings without bars (`aria-label="probability 0.44 of 1"`).

### 7.3 Loop banner, status line, sparkline, toasts

Loop banner (one row after live, only while active): `loop  run:pytest -q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12`;
counts come from `step:end.record.loopSignatures` since the last `replan` (reducer-side; `maxReplans` from `run:ready`).

Status line zones (A46, 14 §5.1): **left** `step N/M` sentinel first (perf gate), then `⠹ <stage verb> <elapsed>` or a
word (`idle`, `review`, `review waiting`, `pausing after step N`, `paused: <reason>`, `retrying 2/3`, `offline`, `aborting`,
`ended <stop>`), badges `sandbox: none` (yellow) / `no-net`, `!n`, `disk ×N`, `⚠ secret?`; **centre** title (≤ 60) or run id
(≤ 24 cells below 100 columns); **right** `run $1.60/2.00 high  sess $4.11/10.00 ok` (≥ 80; 36 cells), 10-cell meter bars at
≥ 120 (`run $0.31/2.00 █▌········ ok  sess $0.46/10.00 ▍········· ok`, 64 cells), git zone `⎇ main ↑2` (≤ 14 cells at
100–139, `⎇ main ↑2 · 3~ 1?` ≤ 24 at ≥ 140, hidden < 100), `? help` (≥ 100 when ≥ 6 cells remain), `wall 4m12s/30m` + bar and the
Jev latency sparkline `jev p50 237ms ▂▃▂▅▂▂▇▃▂▁▂▃` (fixed 0–1000 ms scale, last 12 requests, failed attempt = space) at ≥ 140.
The centre title takes what remains (≥ 13 cells) and is clipped by grapheme with `…`.
Meter level words: `ok` (< 50 %), `half`, `high` (≥ 80), `critical` (≥ 95), `over` (exceeded; replaces `EXCEEDED`), `uncapped`.
Spinner: braille frames at 8 fps only while a stage runs and no review is pending; `still waiting` after 45 s in one
stage; 1 Hz idle redraw; reduced motion = static `•` with a 1 Hz functional tick (A50, A96). Toasts (A37): `! <text>`/`✓ <text>`
replace the left zone after the sentinel for 2 s (4 s errors) and are always also `<Static>` items.

### 7.4 `/why` block (A47, 11 §4h) — appended `<Static>` item with `detail` (≤ 60 lines)

```
[step 7] why risk.plan_mismatch  request a1b2c3d4  244ms  jev-1.13-20260917
  How far is `proposal.action` from `plan` and `intent`?
  score, 5 levels; alignment dimension → tail bound
  L0 ██████▏···  0.62  matches `intent` and the plan
  L1 ██▍·······  0.24  matches the plan, different order
  L2 █▏········  0.10  skips a planned verification step
  L3 ▍·········  0.04  ignores the plan's open problems, or claims completion…
  L4 ··········  0.00  contradicts the plan, repeats a step `recent` shows…
  argmax L0 p=0.62  E[k]=0.56→0.14  P(k≥3)=0.04  bound=tail  risk=0.04 [ok]
  confidence = 1 − Σ p_k·|k−k*| / U_5 = 1 − 0.56/1.2 = 0.53
  consumed by: risk band (review ≥ 0.30, block ≥ 0.70); wire two-decimal, noise sd ≈ 0.02
```
Noul: instructions, `criteria.true/false.definition` + examples, `p`, `|2p−1|`, `consumedBy`. Choice: one bar per option
incl. `none_of_these`, paired Noul beside each, the resolution rule that fired. Ref grammar `s<step>.<stage>.<id>`,
`<stage>.<id>` (current step), or a pane digit. Plain twin: `jevcode why <run-id> <step> <ref>`.

### 7.5 `/calibration` block (11 §4i) — offline, `src/session/calibration.ts`

Bins of 0.1 over all labelled answers: labels = review verdict vs reviewer answer (`confirm:resolved.approved`), `done_<j>`
vs a later parsed test result for the claim, `task_complete` vs bench `pass`, `succeeded` vs `exec.ok`/`tests.allPassed`.
Output rows: header `[run] calibration  N runs  N decisions  N with a label`, label counts, `bin  n  mean p  observed  bar`,
`ECE 0.031 (10 equal-width bins)   near-threshold (|p−t| ≤ 0.03): 57 (1.2%)`, per-threshold counts
(`risk@.30 risk@.70 complete@.85 plan@.70 context@.50`), `unlabelled … sharpness: 71% outside 0.2–0.8`. Plain twin
`jevcode calibration`.

---

## 8. Sessions, steering, pause, history, export, `--json` (F7)

### 8.1 Data model

Session = ordered runs in one workspace; `sessionId` = first run id; `RunMeta` gains `sessionId`, `parentRunId`, `source`,
`title?`, `git`, `instructions` (§15.1). `~/.jevcode/sessions/index.jsonl` is append-only (≤ 512-byte lines, `O_APPEND`,
one writer per process, torn last line skipped; P11: no lock in v1) and the picker's only list source (A55):

```
{ "t": iso, "kind": "run:start", "sessionId", "runId", "parentRunId": null|id, "workspace", "task60", "mode", "source": "cli" }
{ "t", "kind": "run:end", "sessionId", "runId", "stopReason", "steps", "costUsd": { "generator", "jev" }, "wallMs", "changedFiles": n, "exitCode" }
{ "t", "kind": "rename", "sessionId", "title60" }
{ "t", "kind": "steer" | "undo" | "pause", "sessionId", "runId", "step", "text60"?, "files"?: n }
{ "t", "kind": "budget", "sessionId", "setting": "session.spendCapUsd", "from", "to", "atRun": runId }
```
Fold rule: group by `runId`, last line wins per field; a session's spend = Σ `run:end.costUsd` (+ the live run's meter).
`jevcode sessions reindex` rebuilds from `run.json` + `stat(state.json).mtime`; `sessions prune --older-than <d> --source cli`
is explicit; bench/perf never write it.

### 8.2 Picker (A56) — Frame 8

Rows `time ago │ steps │ stop (verdict colours) │ $cost │ title-or-task60 (│ workspace when Ctrl-A)`; sort updated
(default) / created (`s` toggles); keys ↑/↓, Enter (resume into a follow-up composer), Space (preview: parse that
`state.json` + last 4 KB of `transcript.log`, both after the first frame), typing filters (title, task, id; fuzzy §5.4),
Ctrl-A all workspaces, Ctrl-R rename, `x` delete (confirm `y/N`), Esc. `-c/--continue` = most recently *used* run in this
workspace (`max(run:end.t, run:start.t)`); `--resume <id|title>` resolves a unique title prefix or errors with the
candidates. The idle composer's `recent …` hint row (Frame 1) is filled after the first frame from the same fold.

### 8.3 Follow-up seeding algorithm (`src/session/seed.ts`, pure; A52, 10 §15.2)

Input: parent `state.json` (≤ 30 KB), parent `run.json`, follow-up text, optional `/rewind` selection. Output
`EngineOptions.seed`:
1. `plan.done` verbatim; `plan.remaining`, `plan.unverified` kept; `openProblems = []`; `harnessProblems` = only
   `[{ kind: 'human', step: 0, text: 'follow-up in session <sid> after run <parent> ("<original task ≤ 200>"): <follow-up ≤ 600>' }]`
   plus any `/undo`/`/rewind` problem (`human reverted step N: <files>`).
2. `window` = parent's last 4 entries with `notes: [...n, 'from run <parentRunId>']`.
3. `createdThisRun` carried; `lastTestRun` carried with `lastChangeStep = null`.
4. `EngineOptions.humanDirective = followUpText` (the intent/prompt directive slot for step 1); `EngineOptions.task = followUpText`
   (the completion Noul judges the new task, P7 decided: follow-up alone, with the original quoted in the human problem).
5. Money: `sessionMeter.child(min(runCap, remaining))` after the §9.3 gate. Spend, wall, loop detector, `resolvedJevModel` start fresh.
6. `/rewind N files|plan+window|both`: `plan` = `StepRecord.planAfter` of step N (or the parent's final plan when
   `planAfter` is absent — older runs), `window` = entries with `step ≤ N`; files per §12.3; recorded as an index `undo`
   line and a human problem. Never mutates the parent's checkpoint (R21).

### 8.4 Steering: queue, take-back, consumption in the engine (A53, 10 §15.3)

UI: Enter with text while `run === 'live'` → `engine.steer(text)`; the queue rows render `steer n › <text ≤ columns−30>  (applies step N+1)`;
Up on composer row 0 with an empty draft → `engine.unsteer()` puts the newest text back into the buffer; the queue holds ≤ 8;
a 9th is refused with a toast. Each steer is historised (`kind: 'steer'`) and indexed (`steer` line, `text60`). Steers pass
the secret gate; `y`/`n` while a review is visible are review keys, never steers (Frame 4's composer text is a steer draft).

Engine (`loop/engine.ts`):
```ts
steer(text: string): SteerResult {              // after emit redaction: clip(redact(sanitizeStream(text)), 600)
  if (this.lastResult) return { ok: false, reason: 'finished' };
  if (this.pendingDirectives.length >= 8) return { ok: false, reason: 'full' };
  const d = { text, at: nowIso(), step: this.step + 1 }; this.pendingDirectives.push(d);
  this.emit({ type: 'steer:queued', step: this.step + 1, index: this.pendingDirectives.length, text: d.text });
  return { ok: true, queued: this.pendingDirectives.length };
}
unsteer(): string | null { const d = this.pendingDirectives.pop() ?? null; if (d) this.emit({ type: 'steer:queued', …, removed: true }); return d?.text ?? null; }
pause(): void { this.pauseRequested = true; this.emit({ type: 'transcript', step: null, level: 'info', text: `pause requested: stopping after step ${this.step + (this.draft ? 1 : 0)}` }); }
```
Consumption point — `main()` loop, after `checkBudgets()` and before `runStep()`:
```ts
if (this.pauseRequested) return this.finish('human_pause');
if (this.pendingDirectives.length > 0) this.applyPendingDirectives();      // the only pre-commit plan mutation (rule-1 point, nothing in flight)
```
`applyPendingDirectives()`: `step = this.step + 1`; append `{ kind: 'human', text, step }` per directive to
`plan.harnessProblems` (cap 16, a new human problem supersedes older `human` and `replan` entries — never silently: the
superseded text is noted in the transcript item); `this.humanDirective = texts.join('\n')`; `this.detector.resetCounts()`
(additive `LoopDetector` method: clears `counts`/`lastSignature`, keeps `tripsBySignature`/`replanCount`);
`pendingDirectives = []`; emit `steer:applied { step, count }`. Because `finish()` snapshots current state, a rule-1
discard after this point still checkpoints the directives inside `harnessProblems` and an empty queue (nothing lost).
`promptInput()` sets `humanDirective` (rendered by `hintsSection` as `- Human directive (step 9): <text>`);
`commonState()` passes `humanDirective` to `buildCommonState` (top-level `humanDirective: string | null`, redacted,
≤ 600) so intent/context/risk/judge see it; `synthesisContext()` sets `directive = [draft.directive?.text, humanText].filter(Boolean).join('\n\n')`
— in jev-only `parseDirective` maps text without a move name to `FALLBACK_MOVE` (`change_approach`,
`src/synth/search/directive.ts:104-108`), so a human steer is handled as a change-of-approach directive without touching
`src/synth`. `humanDirective` is cleared at commit; `CheckpointState.pendingDirectives` persists undelivered steers.

### 8.5 Pause and session-mode run end

`human_pause`: `StopReason` (exit-4 family; `exitCodeFor` default branch; `BenchStopReason` follows), `--resume`/follow-up
treat it like `null` (§9 DESIGN "any other value → resume normally"; `storedStopBlocks` returns null for it). Session mode
after any `run:end`: the epilogue block is a `<Static>` item (`ended <stop> (exit N) · resume: /resume <id> · report: /report`),
`ui.mode = ended`, composer active, the next Enter is a follow-up (§8.3) or `/resume <id>` continues the same run (with
`/budget` overrides via `reconcileResumeConfig`). One-shot mode exits with `exitCodeFor` after `renderer.unmount()`.

### 8.6 `history.jsonl`, `/export`, `ui.json`

History (A60): `~/.jevcode/history.jsonl`, `{ t, workspace, kind, text }`, `text = redact(expandChipsAsLabels(sanitizeStream(draft)))`
written after `addSecret`, ≤ 4 KiB/entry (`…`), 1,000 entries (atomic rewrite when exceeded), duplicates dropped, never
for `source !== 'cli'`, off with `--no-history`/`JEVCODE_NO_HISTORY=1`; reads still work when writes are off.
`/export [file]` writes `<runDir>/../exports/session-<sid>.log` (or the path) = each run's `transcript.log` preceded by
`==== run <id> (<mode>, <stop>, $cost) ====`, already redacted. `<runDir>/ui.json` (draft `{ text (redacted, hits →
[REDACTED:draft]), cursor, chips[], tab, theme }`) is written at checkpoint boundaries and shutdown only, never per keystroke.

### 8.7 `--json` stream (A61, A138, A158, A170; schema v1)

First line `{"type":"stream:start","schema":1,"jevcode":"<version>","sessionId":…,"runId":…,"mode":…}`; then every
`EngineEvent` after `config.redact` with `t` and `runId` added; plus `session:start { sessionId, runId, parentRunId }`
and `session:end { reason: 'exit' | 'eof' }`; `run:end` carries `exitCode`, `resumable`, `paths { runDir, transcript, log }`.
No countdown ticks (the `retry` line carries `waitMs`); `status` events are included (scripts may drop them). Consumers
ignore unknown `type`s; fields are only added, never renamed, within schema 1. Redaction guarantee (16 §4.7 wording):
configured secrets, `Send anyway`-confirmed values and recognised formats become `[REDACTED:<name>]`/`[REDACTED:pattern]`;
the stream never contains keystrokes, drafts or paste bodies; a human turn is one `user` event with the redacted
submitted text; an unrecognised inline secret passes through as in `transcript.log`. `secret-ack` carries `count` only (P59).

---

## 9. Money (F8; A129–A139, 14 §4)

### 9.1 Meter tree
One root `createSpendMeter(sessionCapUsd)` per session (`SessionController`); each run gets
`root.child(min(runCapUsd, root.snapshot().capUsd − root.snapshot().totalUsd))`; `SpendSnapshot.parentExceeded` is added so
`budget:stop.by` can say `'session'`. Session cap default = 5 × run cap resolved once at session start ($10.00; jev-only run
default $0.25 → $1.25; the mode-keyed run default lives in `resolveConfig` after `--mode` is known, P45); `none` = `+Infinity`
(echoed `none (no session cap)`, meter word `uncapped` red). Seeding on `/resume`: fold the index for the `sessionId`, add the
resumed run's `state.json.spend` to the root via `add()`, then `restore()` the child (restore never forwards, meter.ts).
Bench/perf keep their own root (`source !== 'cli'`).

### 9.2 Thresholds
`budget:warn { scope: 'run'|'session', pct: 50|80|95, spentUsd, capUsd, step, runId, sessionId }` emitted by the engine after
each `meter.add()`, once per `(scope, pct)` (highest only when one add crosses two; re-emitted once with ` (restored)` on
resume; never for `+Infinity`). Surfaces: `<Static>` item `[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about
10 steps left at $0.040/step` (+ ` — Jev is the larger share ($0.031 vs $0.020); see /jev` when Jev > gen), toast 2 s/4 s,
meter word, opt-in BEL/OSC 9 at 95 % and `budget:stop` only. `JEVCODE_BUDGET_WARNINGS=0`/`ui.budgetWarnings=false` mutes
toast and bell only. No 95 % pre-emption (P47 closed). Session-scope checks run in the controller on `run:end` and
`budget:override` only (A139).

### 9.3 Follow-up confirm (Frame 10) — only when `0 < remaining < runCap`
`y` starts with the run cap clamped (`budget:clamp`), `r` prefills `/budget session-spend-cap <cap+runCap>`, `n`/Esc cancel
(text stays), Enter inert. `remaining ≤ 0` → item + 4 s toast `[run] session cap reached ($10.31 of $10.00). Raise it with
/budget session-spend-cap <usd>, or /new for a fresh session with its own cap.` `--plain`/`--json`: clamp silently +
`budget:clamp`, or exit 4 + `budget:stop { scope: 'session', at: 'follow-up' }`.

### 9.4 `/budget`, epilogue, unpriced
`/budget spend-cap <usd>` → pending run cap in memory only (P46), applied to whichever comes first: `/resume` of the stopped run
(`reconcileResumeConfig` records `run.json.overrides[]`, `budget:override`) or the next run; must exceed the target run's spend.
`/budget session-spend-cap <usd|none>` → `root.setCap()` immediately + index `budget` line. `/budget` prints both caps, spends,
pending. `spend_cap` epilogue items (14 §4.4) follow the `run:end` item in session mode. Unknown pricing fails closed:
`validateGenerator` returns `priced`; Anthropic + `!priced` → `ConfigError` (exit 2) `generator.model "<id>" has no pricing entry,
so the $2.000 spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens),
or pass --allow-unpriced to run under a token cap instead.`; `--allow-unpriced` → `limits.maxGeneratorTokens` (default
`spendCapUsd / 15 × 1e6`, Q40 conservative), budget kind `token_cap`, `StopReason 'token_cap'`, `$?` figures, status
`gen 43.1k/133k tok`; OpenRouter/Jev `usage.cost` null → `budget:unpriced` + stop `error unpriced_usage` after the step commits
unless allowed. `config.warnings` are printed (item / stderr). `~` marks table-priced figures; `jevcode config` prints
`session.spendCapUsd  $10.000 (default: 5 × run cap)  default`.

---

## 10. Secrets (F9; A153–A159, 16 §4)

`detectSecrets(s, exact?)` in `src/core/redact.ts`: the six `FORMAT_PATTERNS` + warn-only AWS, Slack (`xox[abpers]-`,
webhooks), PEM header with `PRIVATE KEY`, JWT, Stripe, `npm_`, `hf_`, `glpat-`; `HEADER_PATTERN` excluded; `exact` present →
a hit labelled `your OPENROUTER_API_KEY`; `sk-proj-` labelled `OpenAI sk-proj-…` (P55). Gate row §4.8; on `y`:
`redactor.addSecret('composer#n', span)` (PEM: whole block) before the text leaves the composer, cap 64 composer entries
(`dropSecret` evicts oldest), `secret-ack { count }` event → item `[turn n] sent 1 secret to the generator on request`. The
provider request stays raw (A156); every other sink is masked by the shared redactor (emit, store, Jev state, `--json`, history,
error bodies). Scope = process: composer-added secrets do not survive `--resume` (documented; P56 accepted). Paste chips §4.6.
`@` denylist §5.5 (+ `--allow-secret-mention` → `Attach anyway? y/N` → `workspace.readSecretForMention(rel)`, every
`SECRET_NAME_RE` line `addSecret('mention:<KEY>')`). `/copy [last|proposal|diff|draft]`: `redact(sanitizeStream(x))` ≤ 64 KiB →
`pbcopy`/`wl-copy`/`xclip`/`xsel` → OSC 52 write only with `--osc52` (tmux DCS wrapper), never read; `/copy draft` reports
`copied with N secrets masked`. Trace/log lines carry key classes only (`kind=text len=1 masked=false`), folded into the per-run
log at `trace`. History chip label = redacted first line ≤ 40 chars + `, k lines` (P58). Wizard fields never enter history.

---

## 11. Onboarding, credentials, trust, `AGENTS.md` (F10; A113–A128, 13 §5)

### 11.1 State machine (`src/tui/onboarding/reducer.ts`, pure; buffer in a `useRef<string>`)
```
firstFrame → resolveConfig → missingSecrets(mode) ─[]─▶ trust? ─▶ sandboxLine ─▶ composer | start argv task
                                  └[…]─▶ provider(3 rows; skipped if key present or jev-only; preselected from --provider/JEVCODE_PROVIDER)
                                          → generatorKey(3) → jevKey(3; Enter = reuse the OpenRouter key when provider=openrouter)
                                          → save(2: fingerprints + path) → verify?(2: only on explicit y; $0 GETs + one Jev decision ~$0.0001)
                                          → trust(4; 2 below 12 rows) → sandboxLine(1 item) → composer
Esc = clear field / step back (provider: hint only) · Ctrl-C = fix block to stderr, exit 2 · rows 40×8 verified shape (Frame 9)
```
`config.missingSecrets(mode)` is non-throwing and skips `generator.apiKey` for jev-only/`--mock*`. Field rules: multi-char
chunk = paste; `sanitize = sanitizeStream + strip all whitespace + NFC`; paste never submits; floor `MIN_SECRET_LENGTH` (8);
prefix hints warn only; Backspace/Delete drop one code point; Ctrl-U clears; on Enter `addSecret('generator.apiKey'|'decider.apiKey', v)`
**first**, then the item `[setup] generator key: entered (sha256:e31150e9) source=wizard`, then clear the ref. Mask =
`'•'.repeat(min(len, columns − 3))` (`*` in ascii) + `useCursor`. Screen reader: `aria-hidden` bullets, `aria-label="API key
field, N characters entered, hidden"` updated on submit/clear only, numbered options + `Enter selection (1-2):`, BEL on open/saved.

### 11.2 Persistence and rotation
Write `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` (or `--config`/`JEVCODE_CONFIG`): read existing, merge
`{ provider, apiKey?, jevApiKey? }`, `writeFileAtomic(…, { mode: 0o600, mkdir: true })`, `chmod 0600` file / `0700` dir; Windows
prints `(Windows: protected by your user profile ACL)`. `resolve.ts` checks legacy `~/.config` and XDG, prefers XDG, warns once
(P30). Never writes `./.env`, `./jevcode.json`, the extra `.env` file; warns when `./jevcode.json` exists. After `saved`,
`resolveConfig` re-runs. Shadowing line at every start when env/dotenv overrides a file key with a different fingerprint
(13 §5.5; item stream in `--plain`, P43). `/login` re-enters at the missing field (mid-run: pane rows first; `saved — applies
to the next run`), `/logout`, `jevcode login [--provider] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]`,
`jevcode logout`, `jevcode config set` refuses secret settings. Non-TTY/`--no-input`: today's `ConfigError` line + the
four-line fix block + `Keys are never accepted as command-line arguments in the interactive flow`, exit 2. First-call
401/403 (§13) routes to `/login`.

### 11.3 Trust gate and instruction files (A59, A122; D6)
`~/.jevcode/trust.json` (0600, inside the seatbelt-protected tree; C49 → `~/.jevcode`):
`{ "<realpath git root|workspace>": { "trusted": true, "at": iso, "agents": { "path", "sha256" } | null } }`. Shown on the first
interactive run per root when `AGENTS.md`/`CLAUDE.md`, `./.env` or `./jevcode.json` exists, and again when the instruction
file's sha256 changed (`AGENTS.md changed since you trusted it (sha256 …→…)`). Options `1 trust · 2 this session only · 3 don't trust`;
`3` → `run.json.instructions = []`, `.env` still read for keys with the `dotenv:` source line in the item stream (P38),
`jevcode.json` still read. Home directory never persisted. Non-interactive: instruction files skipped with one stderr line unless
`--trust-workspace`. `AGENTS.md`: first match walking up to the workspace root, `CLAUDE.md` fallback, then
`~/.config/jevcode/AGENTS.md`; 32 KiB cap; `{ path, sha256, bytes }` in `run.json.instructions[]`; injected into the generator
**system** prompt as `## Project instructions` (redacted); read once per run after the first frame; never into Jev state (v1).
Sandbox line at `run:ready` (A123) reuses `main.tsx`'s two sentences; bold on the first run.

---

## 12. Git, undo, rewind, diff (F11; A140–A152, 15 §6)

### 12.1 `GitState` (two spawns at run start, `src/workspace/git.ts`)
`git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel` (one spawn) and
`git status --porcelain=v2 --branch --untracked-files=all -z` (replaces today's v1 call in `createWorkspace`; `statusPorcelainV2()`
parses the ten line kinds). `GitState` as 15 §6.1 (`repo, reason?, gitDir, commonDir, topLevel, prefix, linkedWorktree, head:
{kind:'branch'|'detached'|'unborn'}, upstream, ahead, behind, dirty{…, entries}, probedAt, probeMs`); `RunMeta.git` is the bounded
pick (no paths). Combined rev-parse is one 15 ms spawn; v2 status costs the same 14 ms as v1 (15 §4).

### 12.2 Banner and status zone
`EngineEvent { type: 'workspace'; git: RunMeta['git'] }` emitted right after `run:ready` → one item (`kind: 'workspace'`,
`warn` only for unmerged): `[run] git main ↑2 · 3 modified · 1 staged · 1 untracked` / `git detached 7d731c0e · clean` /
`git wtbranch (linked worktree of /Users/me/proj) · clean` / `git main (unborn, no commits yet) · 2 untracked` /
`git main · in subdirectory pkg/api/ of the repository` / `git none · not a git repository: changes made by commands are not
recoverable, /diff compares against step pre-images only` / `git none · git not found on PATH: …` /
`git main · 412 modified · working tree has unmerged paths (u) — commands may fail on conflict markers`. ASCII `^2 v1`.
Never a gate or a question. Zone (`src/tui/git/useGitHead.ts`): `fs.watch(gitDir, { persistent: false })` filtered on
`!filename || filename === 'HEAD'`, 100 ms debounce, read `<gitDir>/HEAD` in-process; dirty counts from the run-start snapshot
and the post-`run` `invalidateCandidates()` refresh; re-probe (one spawn) at `run:end` for ahead/behind (P51); render
`⎇ main ↑2 · 3~ 1?` / `⎇ 7d731c0e†` / `⎇ main (wt)` / ASCII `br main`; branch truncated by grapheme keeping the tail after `/`;
watcher error → stale value. `--resume` on a different `head` **warns** (P52): `resumed on <now>, run started on <then>`.

### 12.3 Pre/post images and `/undo`, `/rewind`
Pre-images `<run>/pre/<step>/<sha256(relpath)>` before `edit|write|patch` (skip > 1 MiB, noted) and, before a `run` action,
a copy of `snapshotDirty ∪ statusEntries ∪ touched` (cap 200 files / 16 MiB, overflow `skipped: cap`; no `stash create`, C41).
`post/<step>.json` `{ step, at, files: { rel: { sha256, bytes, mode, source: 'edit'|'write'|'patch'|'run', preImage?, deleted?, created? } }, skipped: [{ path, reason, bytes }] }`
written atomically **before** the step's `state.json`; `state.undoLog` (≤ 20). Decision table per file (idle-only, all checks
before the first write): current sha == `post[N]` → restore; missing and `deleted: true` → restore; differs and equals a later
step's post → **refuse** `src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together`; differs otherwise →
ask `src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]` (`a` all, `s` skip rest, Esc abort); symlink/hardlink →
skip `link`; escapes `<ws>`/`.git` → skip `escape`; submodule → skip `submodule`. Restore source order: pre-image
(`writeFileAtomic` with recorded mode) → `unlink` for `created` (+ empty dirs the step created) → `git restore --source=HEAD
--worktree -- <path>` for tracked files a `run` step changed while clean at step start (never `checkout --`, C40) → skip
`not-recoverable`. Output `undo step 7: restored 3 files (…), skipped 1 (build/out.txt: not recoverable — changed by a command,
not tracked by git)` / `no files restored (…)`; `post/<N>.json` → `post/<N>.undone.json`; index `undo` line; next run's seed gets
`HarnessProblem { kind: 'human', text: 'human reverted step 7: …' }`. `/rewind N` undoes last…N in reverse, stops at the first
refusal, then offers `files / plan+window / both` for the next seed (§8.3). No `/redo` (P54), no "restore to HEAD" option (P50);
non-git: rules 1–2 only (`not recoverable — no git repository`).

### 12.4 `/diff`
`/diff` = one appended item from `git diff --numstat -z HEAD -- <changedFiles>` (+ `--no-index --numstat -z -- /dev/null <f>` for
the first 20 untracked; rest listed `?` with sizes; unborn → empty tree `4b825dc…`; exit 1 = success, A151):
```
diff (run 20260920-140211-k7q2m6xa · 12 files · +184 −37 · 2 untracked · 1 binary · 1 skipped)
 M src/a.py            +120 −12  ++++++++--
 ? src/new_helper.py    +24      ++
 A tests/test_a.py †    +12      +
 B assets/logo.png       Bin 0 → 4.2 KiB
 S vendor/big.min.js    skipped (1.3 MiB > 1 MiB)
 … 3 more files (/diff --all)        † also modified before this run
```
Letters `M A D R ? B S`, ≤ 10-cell `+`/`-` bar scaled to the largest row, row cap 40, path left-truncated by grapheme to
`columns − 32`, colour additive only. `/diff <step>` from pre/post images (`(changed since)` when the current hash differs).
`/diff --full [step]` → `git diff --color=always -c core.quotePath=false --no-ext-diff --no-textconv --submodule=short
--ignore-submodules=dirty` (files > 1 MiB excluded) to `<run>/tmp/diff-<seq>.patch`, shown via `suspendTerminal` through
`$GIT_PAGER` → `$PAGER` → `less` (`core.pager` ignored; `LESS=FRX` only when unset; `LESSCHARSET=utf-8`); `cat`/no TTY → inline
item capped at 400 lines; engine events queued during the suspension. `/diff` is human-only (P53). Seatbelt: `ProfileOptions.gitDir?`/
`gitCommonDir?` allow writes under the realpath'd dirs when outside `<ws>`, denies moved to `<commonDir>/config`, `<commonDir>/hooks`,
`<gitDir>/config.worktree`, `modules/*/config|hooks` (A149).

---

## 13. Errors, retry, crash, logs, epilogue, exit codes (F12; A160–A171, 17 §4)

### 13.1 Retry and blocking panes
`AskOptions.onRetry` (client.ts before `sleep(waitMs)`) and `GenerateOptions.onRetry` (sse.ts `withRetry`) → `retry` /
`retry:settled` events. Live-region row (1 Hz reducer tick, spinner unchanged): `jev: retrying 2/3 in 12 s · HTTP 429 rate
limited (Retry-After)   [r] retry now`, second row `last: HTTP 529 overloaded · request-id …` only when the cause changed;
`[r]` uses the waker `RetryWaker { wake(): void }` passed as `AskOptions.retryWaker`/`GenerateOptions.retryWaker` (the sleep
races `signal`, `wake`) — P60 decided: in v1. Status word `retrying 2/3`; `✓ jev back` toast; one `warning:` item when a chain
lasted > 10 s. After **one** exhausted chain with zero actions executed in the step, session mode discards the step and enters
`paused: jev unreachable` (blocking pane `retrying in 30 s (auto, doubles to 5 min) · [r] now [q] stop`, P61); bench/`--plain`
on a pipe keep three failures → exit 5. 401/403 on the first call of a side → exit 2 + pane routing to `/login`; later 401 →
blocking pause. Spend-limit 429 / OpenRouter 402 → blocking `provider: spend limit reached — "<message>" · [q] stop (exit 5)`, no
auto-retry. First-call drift → pane `[p] pin --jev-model <served> for the next run  [q] stop`. Network `cause.code` → words
`offline: DNS lookup failed for <host>` / `offline: cannot reach <host>` / `no response from <host> in 10 s`; `--no-network` is
a badge `sandbox: no-net`, never "offline". Disk errors on the run dir → `notice checkpoint:degraded` once per (file, code),
status `disk ×N`, pause at the boundary with `[r] retry the write [c] continue without checkpoints [q] stop now (exit 3)`;
`[c]` sets `checkpointDegraded` → a later `complete` exits **3**.

### 13.2 `PaneBoundary` and `fatalExit`
`class PaneBoundary extends React.Component<{ pane: string }, { failed: boolean }>` wraps `live`, `Pane`, `Review`, `Composer`,
`StatusLine`, overlays and the `<Static>` child renderer; fallback one row `ui: <pane> pane failed to render (<Error.name>) — run
continues; details in <log>`; a failed `Review` declines via `confirmer.resolve(id, false)`; a failed `StatusLine` renders
`formatStatusLine()` in a bare `<Text>`; `JEVCODE_FAULT=render:<pane>` throws once. `fatalExit` order: (1) `process.exitCode`,
idempotent guard; (2) synchronous restore — `stdin.setRawMode(false)`, `fs.writeSync(1, EXIT_STRING)` where
`EXIT_STRING = '\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m'` (+ `\x1b[<u` only if kitty was ever pushed; `\r\n` if
mid-line; never `ESC c`/`ESC[2J`); (3) `engine?.abort('error')` then `renderer.unmount()` raced with 2 s; (4) epilogue via
`fs.writeSync(2, …)`; `process.exit()`. SIGHUP/EIO: `'error'` listeners on stdio first, checkpoint, no epilogue, exit 129.

### 13.3 Epilogue (every `run:end` and fatal path; item in session mode, stderr after unmount in one-shot)
```
jevcode: stopped — jev_http: Jev HTTP 429: Rate limit exceeded: free-models-per-min (exit 5)
  run       20260920-191506-5gnampki
  files     ~/.jevcode/runs/20260920-191506-5gnampki/  (transcript.log, state.json, jevcode.log)
  resume    jevcode run --resume 20260920-191506-5gnampki        | state.json missing — not resumable
  report    jevcode report 20260920-191506-5gnampki   (writes a redacted bundle locally; nothing is sent)
```
Variants: `stopped by Ctrl-C after step 3 — checkpoint written (exit 130)`; ConfigError before a run dir: `jevcode: <message>
(exit 2)` + `help: jevcode run --help`. `JEVCODE_DEBUG=1` appends the stack after the block.

### 13.4 Logs and exit codes
`<runDir>/jevcode.log` (`JEVCODE_LOG`; fallback `~/.jevcode/logs/jevcode-<pid>-<stamp>.log`, newest 10 kept, P63); levels
`error|warn|info|debug|trace`, default `info`; `--verbose`/`JEVCODE_LOG_LEVEL=debug` to the file only; `JEVCODE_TRACE=<file>` =
alias for `JEVCODE_LOG=<file>` at `trace`; key=value lines ≤ 512 chars through `config.redact`; keystrokes as categories;
`warn`+ `appendFileSync`, `info`− 250 ms buffer flushed in `'exit'`; 8 MiB cap, one rotation; failed retries are **not**
persisted in `jev.jsonl` (P64). In-frame twin: Ctrl+O / `/errors` append the last N warnings/errors as items and clear `!n`.
`jevcode report <id>` / `/report` → `~/.jevcode/reports/<id>/` (`run.json`, `transcript.log`, `jevcode.log`, last 20 steps,
`config --json`, `versions.txt`, `README.txt`; `jev.jsonl` bodies only with `--include-requests`).

| Situation | one-shot | session (`run:end` item carries the code) |
| --- | --- | --- |
| complete / `generator_done` | 0 | `exit 0` item |
| budget, `replan_stop`, `impossible`, `human_pause`, `token_cap` | 4 | `exit 4` item |
| ConfigError/usage at launch; unpriced refusal | 2 | 2 |
| first-call 401/403, first-call drift | **2** | pane → `[q]` = `exit 2` item |
| API failure after retries | 5 | `exit 5` item |
| degraded checkpoint then stop (incl. complete) | **3** | `exit 3` + not-resumable notice |
| sandbox/path abort | 6 | `exit 6` item |
| Ctrl-C ×2 / SIGINT | 130 | 130 |
| SIGTERM / SIGHUP-EIO / uncaught | 143 / 129 / 1 | same |
| `/exit`, Ctrl-D | — | **0 always** (`--exit-code=last-run` opt-in) |

---

## 14. Terminal posture and hygiene (F2; A77–A93, D13)

| Item | Rule |
| --- | --- |
| Colour | `bin/jevcode.js` maps `NO_COLOR` → `FORCE_COLOR=0` before the bundle loads (exists today; a first-position side-effect import `src/tui/color-shim.ts` repeats it for tests, Q14); one `colorEnabled()` (flag > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > `hasColors?.(16)`); `--no-color`; ANSI-16 named colours only; every colour paired with a marker/word; no backgrounds; `--theme dark\|light\|daltonized\|ansi` (daltonized swaps red↔green for blue/magenta pairs; `ansi` = no dim); no OSC 11, no auto-detect; `/theme` applies to new items only |
| Keyboard | `kittyKeyboard: { mode: 'disabled' }`; newline keys §4.4; leak-through filter §4.4; inside `TMUX` no queries at all (A112) |
| Rendering | `render({ exitOnCtrlC: false, patchConsole: false, maxFps, incrementalRendering: renderMode === 'incremental', isScreenReaderEnabled })`; `maxFps` 30 default, `--fps`/`JEVCODE_FPS`, 15 under `SSH_TTY`/`SSH_CONNECTION`; `LIVE_FLUSH_MS` 50 (250 in reduced motion); `useWindowSize()` replaces `useTerminalSize`; resize = 50 ms trailing debounce on the layout only, never a scrollback rewrite (A30, C23) |
| Exit string | `EXIT_STRING` (§13.2) written synchronously in unmount, `fatalExit`, SIGTSTP, SIGHUP; never `ESC c`/`ESC[2J`/`ESC[3J` |
| Ctrl+Z | byte `0x1a` → erase frame (`log.clear()`), `EXIT_STRING`, `setRawMode(false)`, `process.kill(process.pid, 'SIGTSTP')`; `SIGCONT` → `setRawMode(true)`, `CSI ?2004h`, force repaint via the `suspendTerminal` primitive; suspend is not a checkpoint |
| SIGHUP/EIO/EPIPE | `'error'` listeners on stdin/stdout/stderr installed before SIGHUP logic; stdin `'end'` or SIGHUP → checkpoint, no terminal writes, exit 129 |
| Screen reader | `--screen-reader` > `JEVCODE_SCREEN_READER` (`=0` overrides) > `ui.screenReader` (+ `INK_SCREEN_READER`); first item `[screen reader mode: on via flag\|env\|config]`; `aria-hidden` spinner/bars; status `aria-label` changes only on stage/threshold transitions; announcements as `<Static>` lines with `you:`/`steer:` prefixes; live region off; reviews/wizard/pickers as numbered lists + `Enter selection`; `notify` defaults on |
| Reduced motion | `--no-animation` / `JEVCODE_REDUCED_MOTION` / `ui.reducedMotion` (implied by screen reader): static marker, 1 Hz functional tick, `LIVE_FLUSH_MS` 250; a unit test greps `src/tui/**` for `setInterval(` outside `spinner.ts` and `retry-tick.ts` |
| ASCII | `--ascii` / `JEVCODE_ASCII=1` / auto when `TERM=dumb` or non-UTF-8 locale: `─`→`-`, `█▏▎▍▌▋▊▉`→`#` + `" 123456789#"`, `·`→`-`, `⎇`→`br`, `↑↓`→`^v`, `†`→`+`, `•`→`*`, `⠹`→`\|/-\`, `✓ ✗`→`+ x`, `┆`→`:`; ledger `[x] [ ] [?] [!]` already ASCII |
| Tiny / huge | `MIN 40×8`; §2.1 `tiny` modes; rule capped at `min(columns, 400)`; 0×0 pty → Ink's 80×24 (A93); `COLUMNS`/`LINES` honoured by Ink |
| Slow links | fps 15 under SSH, coalescer kept; mosh treated as unsupported for OSC 52/1004/kitty/2026; no query ever blocks a frame |
| Title / notify / links | `--title` opt-in (`OSC 2 ; jevcode: <task head sanitized> ST`, cleared on exit); `notify off\|bell\|desktop` (BEL; OSC 9 iTerm2/Ghostty/WezTerm/foot, OSC 99 kitty, tmux DCS; payload never starts with a digit); OSC 8 only for self-resolved `file://` paths on the adoption list |
| `<Static>` caches | soft cap 20,000 items → keyed remount with a fresh small array (`fullStaticOutput` reset, older rows stay in scrollback, C27); bucketed live counters (`streaming… 1.2k chars`); vitest/perf under `NODE_ENV=production` |
| Untrusted text | `sanitizeStream` remains the single choke point for items, live region, pastes, clipboard; bidi controls stripped; U+2028/2029 → `\n` |

---

## 15. Engine and core contract additions (F13) — one ordered, additive, versioned list

Contract version note at the top of `src/core/types.ts`: `// contract 1.1 (2026-09-20): additive TUI/session extensions §15 of docs/research/tui/designs/jev-native.md`.
Every item is optional or a new union member so today's readers, bench and jev-only path compile unchanged.

```ts
// 1  StopReason
export type StopReason = /* existing */ | 'human_pause' | 'token_cap';          // BenchStopReason = StopReason | 'not_run' follows
// 2  HarnessProblemKind
export type HarnessProblemKind = 'replan' | 'rejected_claim' | 'stale_plan' | 'human';
// 3  Engine
export interface SteerResult { ok: true; queued: number } | { ok: false; reason: 'full' | 'finished' | 'empty' };
export interface Engine { /* existing */
  steer(text: string): SteerResult; unsteer(): string | null; pause(): void;
  readonly pauseRequested: boolean; readonly pendingDirectives: readonly PendingDirective[];
}
export interface PendingDirective { text: string; at: string; step: number }
// 4  EngineOptions
export interface RunSeed { parentRunId: string; plan: Pick<Plan, 'done' | 'remaining' | 'unverified'>; window: WindowEntry[]; createdThisRun: string[]; lastTestRun: LastTestRun | null; humanProblems: HarnessProblem[] }
export interface EngineOptions { /* existing */
  seed?: RunSeed; humanDirective?: string; sessionId?: string; source?: 'cli' | 'bench' | 'perf';
  instructions?: { path: string; sha256: string; bytes: number; text: string }[];   // text → system prompt only; run.json stores the triple
  pins?: string[];                                                                    // @-mentions for step 1 (later steps via steer text)
  onRetryWaker?: RetryWaker; maxGeneratorTokens?: number; allowUnpriced?: boolean;
}
export interface RetryWaker { wake(): void; readonly signal: AbortSignal }   // shared by client.ts/sse.ts sleeps
// 5  CheckpointState
export interface UndoLogEntry { step: number; at: string; restored: string[]; skipped: { path: string; reason: string }[] }
export interface CheckpointState { /* existing */ pendingDirectives?: PendingDirective[]; undoLog?: UndoLogEntry[]; generatorTokensUsed?: number }
// 6  StepRecord
export interface StepRecord { /* existing */ planAfter?: Plan; declineNote?: string }
// 7  RunMeta
export interface GitMeta { repo: boolean; reason?: 'not-a-repo' | 'git-missing' | 'bare' | 'timeout'; head: GitState['head'] | null; upstream: string | null; linkedWorktree: boolean; prefix: string; dirtyAtStart: { modified: number; staged: number; untracked: number } }
export interface RunMeta { /* existing */ sessionId?: string; parentRunId?: string | null; source?: 'cli' | 'bench' | 'perf'; title?: string; git?: GitMeta | null; instructions?: { path: string; sha256: string; bytes: number }[] }
// 8  SpendMeter / SpendSnapshot
export interface SpendSnapshot { /* existing */ parentExceeded: boolean }
export interface SpendMeter { /* existing */ setCap(capUsd: number): void }        // root meter only; /budget session-spend-cap
// 9  Provider / Decider retry hooks
export interface RetryInfo { attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: { kind: 'http' | 'network' | 'timeout' | 'invalid' | 'stream'; status: number | null; code: string | null; message: string } }
export interface AskOptions { /* existing */ onRetry?: (r: RetryInfo) => void; retryWaker?: RetryWaker }
export interface GenerateOptions { /* existing */ onRetry?: (r: RetryInfo) => void; retryWaker?: RetryWaker }
// 10 SerializedError
export interface SerializedError { /* existing */ status?: number; retryable?: boolean; side?: 'jev' | 'generator'; requestId?: string | null }
// 11 EngineStatus
export interface EngineStatus { /* existing */ maxReplans?: number; replans?: number; pausing?: boolean; generatorTokens?: { used: number; cap: number | null } }
// 12 EngineEvent members (all new; `run:ready`/`run:end`/`confirm:resolved`/`synth` extended with optional fields)
  | { type: 'steer:queued'; step: number; index: number; text: string; removed?: boolean }
  | { type: 'steer:applied'; step: number; count: number }
  | { type: 'budget:warn'; scope: 'run' | 'session'; pct: 50 | 80 | 95; spentUsd: number; capUsd: number; step: number; runId: string; sessionId: string; restored?: boolean }
  | { type: 'budget:stop'; scope: 'run' | 'session'; by: 'run' | 'session' | 'token'; spentUsd: number; capUsd: number; step: number; stoppedAt: StoppedAt | 'follow-up'; runId: string; sessionId: string; raise: { command: string; flag: string; minimum: number } }
  | { type: 'budget:clamp'; scope: 'session'; runCapUsd: number; clampedToUsd: number; sessionSpentUsd: number; sessionCapUsd: number; runId: string; sessionId: string }
  | { type: 'budget:override'; setting: string; from: string; to: string; atStep: number; runId: string; sessionId: string; source: '/budget' | 'flag' }
  | { type: 'budget:unpriced'; source: 'generator' | 'jev'; model: string; step: number; tokens: { input: number; output: number }; runId: string }
  | { type: 'retry'; side: 'jev' | 'generator'; step: number | null; stage: StageName | null } & RetryInfo
  | { type: 'retry:settled'; side: 'jev' | 'generator'; step: number | null; attempts: number; ok: boolean; totalWaitMs: number }
  | { type: 'notice'; step: number | null; kind: 'offline' | 'online' | 'checkpoint:degraded' | 'checkpoint:restored' | 'sandbox' | 'drift' | 'instructions' | 'config' | 'pause'; text: string; detail?: Json }
  | { type: 'workspace'; git: GitMeta }
  | { type: 'secret-ack'; step: number | null; count: number }
  | { type: 'user'; step: number | null; kind: 'prompt' | 'steer' | 'command'; text: string }   // redacted human turn (items `you:`/`steer:`)
  | { type: 'run:ready'; /* existing */ sessionId?: string; parentRunId?: string | null; sandbox?: SandboxLevel; noNetwork?: boolean; maxReplans?: number }
  | { type: 'run:end'; result: RunResult; exitCode?: number; resumable?: boolean; paths?: { runDir: string; transcript: string; log: string } }
  | { type: 'confirm:resolved'; /* existing */ note?: string }
  | { type: 'synth'; /* existing */ mode?: 'sieve' | 'rank'; goal?: { index: number; total: number; tests: string; path: string }; site?: string; source?: string; runs?: number; tRunMs?: number; lanes?: number; jevRequests?: number }
// 13 ResolvedConfig / Redactor / Workspace / sandbox / git
export interface ResolvedConfig { /* existing */ missingSecrets(mode: EngineMode): ('generator.apiKey' | 'decider.apiKey')[]; ui(): UiSettings; session(): { spendCapUsd: number } }
export interface Redactor { /* existing */ dropSecret(name: string): boolean }
export interface SecretHit { family: string; label: string; start: number; end: number }
export function detectSecrets(s: string, exact?: Redactor): readonly SecretHit[];
export interface Workspace { /* existing */ readSecretForMention?(rel: string): Promise<FileView>; gitState?(): GitState | null }
export interface ProfileOptions { /* existing */ gitDir?: string; gitCommonDir?: string }
export interface GitState { /* 15 §6.1 verbatim */ }
export interface GeneratorConfig { /* existing */ priced: boolean }
export interface RunLimits { /* existing */ maxGeneratorTokens?: number }
// 14 Renderer / prompts / state
export interface RendererOptions { /* existing */ mode?: 'session' | 'oneshot'; ui?: UiSettings; controller?: SessionController }
export interface TuiConfirmer { /* existing */ resolve(id: string, approved: boolean, note?: string): boolean }
export interface PromptInput { /* existing */ humanDirective: string | null; pins?: string[] }          // provider/prompts.ts
export interface CommonStateInput { /* existing */ humanDirective?: string | null }                    // loop/state.ts
export interface LoopDetector { /* existing */ resetCounts(): void }                                   // loop/loopdetect.ts
```

Insertion points: **engine.ts** — fields `pendingDirectives`, `pauseRequested`, `humanDirective`, `checkpointDegraded`; `main()`
loop after `checkBudgets` (§8.4); constructor applies `opts.seed` when `init.resume === null`; `createEngine` writes `sessionId`,
`parentRunId`, `source`, `git`, `instructions` into `RunMeta` and emits `workspace` after `run:ready`; `confirm()` stores the note;
`commit()` sets `record.planAfter = plan` (bounded 20 × 200) and `declineNote`; `commonState()`/`promptInput()`/`synthesisContext()`
pass the directive; `askRecorded()`/`generate()` forward `onRetry` → `emit('retry')`; `persist()` classifies disk errors;
`finish()` adds `exitCode`/`paths`/`resumable` to `run:end`; `budgetInput()` gains `token_cap`; `buildSystemPrompt` gets
`instructions` (append `## Project instructions`). **prompts.ts** — `hintsSection` renders `humanDirective`; `PROMPT_LIMITS.taskChars`
unchanged (notice in the composer, F9). **state.ts** — `buildCommonState` adds `humanDirective`. **stop.ts** — `exitCodeFor(reason,
error?, degraded = false)`. **budget.ts** — `BUDGET_ORDER` gains `'token_cap'` after `spend_cap`; `BudgetInput.generatorTokens?`.
**plan.ts** — `applyPlanDraft` keeps `human` problems until superseded. **loopdetect.ts** — `resetCounts()`. **main.tsx** — `chat`
command; `SessionController`; `--json` writer; `fatalExit` order; warnings printed; `missingSecrets` probe; trust gate;
`AGENTS.md` loader; `GitState`; epilogue. **args.ts** — commands and flags of §1/§16; bare argv → `chat`.

**jev-only preservation checklist**: `synth` events keep one transcript line each (`synthText` unchanged; new fields are
optional); the status marker `propose [synth]` stays; `main.tsx` keeps `NullProvider` + `createSynthesizer` and never calls
`config.generator()` in jev-only (`missingSecrets('jev-only')` skips the generator key); `SynthesisContext.directive` receives
human text only as described in §8.4 (fallback move); `src/synth/**` is not edited; `transcript.log`, `--plain` and the TUI
`<Static>` stay line-for-line identical (the new items `workspace`, `user`, `secret-ack`, `budget:*`, `notice`, `steer:*`,
`retry` warnings are added to `itemsFromEvent` once and rendered by all three; the review box, palette, pane and toasts are
not items); the bench's `alwaysDecline` and the plain non-TTY auto-decline confirmers are untouched; `run.json` readers treat
the new fields as optional.

---

## 16. Configuration schema (F14, D15) — precedence flag > env > `./.env` > `<extra .env file>` > file > default

`SettingName` grows by the rows below (`SETTINGS` in `config/defaults.ts`); `jevcode config` prints value + source for each,
derived defaults as `<value> (default: <rule>)`; `jevcode config set <k> <v>` writes non-secret keys to the user file.

| Setting | Flag | Env | File key | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `ui.theme` | `--theme` | `JEVCODE_THEME` | `theme` | `dark` | `dark\|light\|daltonized\|ansi` |
| `ui.fps` | `--fps` | `JEVCODE_FPS` | `fps` | `30` (15 under SSH) | 5–30 |
| `ui.renderMode` | `--render-mode` | `JEVCODE_RENDER_MODE` | `renderMode` | `standard` | `standard\|incremental` |
| `ui.ascii` | `--ascii` | `JEVCODE_ASCII` | `ascii` | auto (`TERM=dumb`, non-UTF-8) | |
| `ui.title` | `--title` | `JEVCODE_TITLE` | `title` | `false` | OSC 2 opt-in |
| `ui.screenReader` | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | `screenReader` | `false` | `=0` overrides |
| `ui.reducedMotion` | `--no-animation` | `JEVCODE_REDUCED_MOTION` | `reducedMotion` | `false` (true in SR) | |
| `ui.notify` | `--notify` | `JEVCODE_NOTIFY` | `notify` | `off` (`bell` in SR) | `off\|bell\|desktop`; review ~6 s idle gate, run-end 60 s |
| `ui.osc52` | `--osc52` | `JEVCODE_OSC52` | `osc52` | `false` | clipboard write fallback |
| `ui.budgetWarnings` | `--no-budget-warnings` | `JEVCODE_BUDGET_WARNINGS` | `budgetWarnings` | `true` | mutes toast/bell only |
| `ui.noHistory` | `--no-history` | `JEVCODE_NO_HISTORY` | `noHistory` | `false` | |
| `ui.noInput` | `--no-input` | `JEVCODE_NO_INPUT` | `noInput` | `false` | suppresses every prompt (safe defaults) |
| `ui.trustWorkspace` | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | — | `false` | scripts only |
| `ui.exitCode` | `--exit-code` | `JEVCODE_EXIT_CODE` | `exitCode` | `zero` | `zero\|last-run` |
| `ui.keybindings` | `--keybindings` | `JEVCODE_KEYBINDINGS` | `keybindings` | `~/.config/jevcode/keybindings.json` | |
| `ui.noColor` | `--no-color` | `NO_COLOR`, `FORCE_COLOR` | — | terminal | launcher shim |
| `session.spendCapUsd` | `--session-spend-cap` | `JEVCODE_SESSION_SPEND_CAP_USD` | `sessionSpendCapUsd` | `5 × limits.spendCapUsd` | `none` = ∞ |
| `limits.spendCapUsd` | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `spendCapUsd` | `2` (`0.25` jev-only) | mode-keyed default |
| `limits.allowUnpriced` | `--allow-unpriced` | — | — | `false` | flag only |
| `limits.maxGeneratorTokens` | `--max-generator-tokens` | `JEVCODE_MAX_GENERATOR_TOKENS` | `maxGeneratorTokens` | `spendCapUsd / 15 × 1e6` | token cap |
| `generator.priceCacheReadPerM/WritePerM` | — | `JEVCODE_PRICE_CACHE_READ_PER_M`, `_WRITE_PER_M` | `priceCache…` | `0.1× / 1.25× in` | `derived from priceInPerM` source |
| `secrets.allowSecretMention` | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | — | `false` | |
| `log.file` / `log.level` / `log.verbose` | `--log` / `--log-level` / `--verbose` | `JEVCODE_LOG`, `JEVCODE_LOG_LEVEL`, `JEVCODE_TRACE` (alias) | `log`, `logLevel` | `<runDir>/jevcode.log`, `info` | file only |
| `session.continue` / `resume` / `list` | `-c/--continue`, `--resume <id\|title>`, `--list-sessions` | — | — | — | `chat` and `run` |
| `update.notify` | `--update-notify` | `JEVCODE_UPDATE_NOTIFY`, `NO_UPDATE_NOTIFIER` | `updateNotify` | `false` | post-run only |

---

## 17. Packaging and release (F15, D14) — documented and prepared, not published

Checklist: (1) `package.json`: remove `"private": true`; `ink`/`react` → `devDependencies` (inlined by esbuild; `dependencies: {}`);
`files: ["bin", "dist/jevcode.mjs", "THIRD_PARTY_LICENSES.txt", "man/jevcode.1", "README.md", "LICENSE"]`; `engines.node >= 22.12`;
`publishConfig.provenance: true`; `bin.jevcode = bin/jevcode.js`. (2) Add `LICENSE` (MIT). (3) `scripts/build.mjs`: `minify: true` +
`keepNames: true`, `define: { __JEVCODE_VERSION__: JSON.stringify(pkg.version) }` (`main.tsx` `VERSION = __JEVCODE_VERSION__`),
`THIRD_PARTY_LICENSES.txt` generated from `result.metafile` inputs' package `license`/`LICENSE` files (legalComments stays
`none`), no `.map`/`meta.json` in the tarball. (4) `bin/jevcode.js` keeps the Node ≥ 22.12 guard, `NO_COLOR` shim and compile
cache; answers `--version [--json]` and `--help` before importing the bundle. (5) `scripts/gen-completions.mjs` and
`scripts/gen-man.mjs` from `FLAGS`/`COMMANDS` → `jevcode completion bash|zsh|fish` (static; run-id completion by shell `ls`) and
`man/jevcode.1`. (6) `jevcode upgrade [<v>|latest|next] [--check] [--method]` delegating to the detected manager (npx → nothing;
brew; bun; pnpm; yarn; else `npm install -g jevcode@<v>`), 2 s timeout. (7) Update notifier off by default; when on, a post-run
detached `jevcode upgrade --check --write-cache` writes `$XDG_CACHE_HOME/jevcode/update-check.json`, read after the next first frame;
suppressed under `CI`, `NO_UPDATE_NOTIFIER`, non-TTY, npx, < 24 h. (8) CI gates: `test "$(npm pkg get private)" = "{}"`,
`npm pack --dry-run` file list == the `files` set and size < 1.5 MB, `--version` smoke, `npm run perf` on macOS. (9) Release
workflow: tag → build → `npm publish --provenance` with trusted publishing on a **Node 24** publish job (npm ≥ 11.5.1 asserted;
P69), dist-tags `latest`/`next` (P31), GitHub Release with tarball + `SHA256SUMS`, per-version CHANGELOG. (10) Homebrew tap
`Formula/jevcode.rb` (`depends_on "node"`, `std_npm_args`, `bin.install_symlink libexec.glob("bin/*")`,
`generate_completions_from_executable(bin/"jevcode", "completion")`, `man1.install "man/jevcode.1"`), `url`/`sha256` rewritten by
the release job. (11) `jevcode doctor [--terminal]` prints version, bundle path, Node, install method, paths, sandbox level,
compile-cache status, completion status, config sources and negotiated terminal capabilities with `Fix:` lines.
(12) README: Windows = TUI in ConPTY terminals with `--sandbox none`, sandboxed runs via WSL 2.

---

## 18. Performance plan (F18, DESIGN §12)

| Gate | Threshold | How measured | Script |
| --- | --- | --- | --- |
| first frame, `chat` and `run`, composer included | cold p95 < 300 ms, zero network | existing `script -q` pty + `stty rows 40 cols 120`, sentinel `step 0/`, `JEVCODE_ASSERT_NO_NETWORK=1`, 10 cold + 10 warm | `perf/first-frame.ts` (adds the `chat` variant) |
| keystroke → frame | p95 < 16 ms in a real pty at the A109 region (rows 24: live 2 + queue 2 + composer 6 + pane 10; and with a review pending) | Python `pty.fork` driver writes 200 keys at 30 ms spacing with `performance.now()` stamps; the child echoes the grapheme in the composer row; latency = first frame containing it (frames counted by `ESC[?2026h`) | `perf/composer-latency.ts` (new) |
| event-loop lag while typing during a live mocked run | p95 < 5 ms, max < 50 ms, at rows 40 and 12 | `--perf-lag-probe` (10 ms interval + `monitorEventLoopDelay`) with the driver typing at 50 ms cadence and a 500 delta/s mock | `perf/render-lag.ts` (extended) |
| zero clears | 0 matches of `/\x1b\[[0-9;]*[23]J\|\x1bc\|\x1b\[\?1049[hl]/` after the first frame, at rows 40/24/12/8; exactly one `ESC[?25l`, final `ESC[?25h` | pty captures of: streaming, review pending, palette, picker, wizard, retry row, `JEVCODE_FAULT=render:pane` | `perf/render-lag.ts` |
| frame rate | ≤ 20/s + 1 under the 500 delta/s mock; ≤ 4/s in reduced motion; 1 Hz ± 1 for the retry row | `ESC[?2026h` count per second bucket | `perf/render-lag.ts` |
| `<Static>` append cost | p95 renderTime < 5 ms with the realistic region (A107) | `onRender` metrics in the mocked run | `perf/render-lag.ts` |
| fuzzy scorer | 5,000 candidates × 3-char query < 16 ms p95 | unit benchmark | `test/unit/tui/fuzzy.test.ts` |
| harness overhead | unchanged p95 < 50 ms; pre-image copies and post hashes counted | `perf/step-overhead.ts` with `run` actions changing 5 dirty files | existing |
| session index fold | 10,000 lines < 15 ms, folded once per session open/run:end only | unit benchmark | `test/unit/session/index.test.ts` |

`npm run perf` writes `perf/results/latest.json` with the new rows and fails on any gate.

---

## 19. Testing plan (F18; A102–A108, 12 §12)

1. **Pure units** (vitest `unit`, ink-free): `bufferReducer`, `layout`, `cellWidth` fixture vs `string-width`, `computeLayout`
   (rows 3/5/8/12/24/40/50 × columns 20/40/80/120/400, every `LayoutInput` state of §2.2, invariants of §2.1), key matcher
   (all §3.2 cells as a table test with injected timestamps), slash grammar, fuzzy scorer, `detectSecrets` (families, FP
   survivors, 256 KB < 5 ms), `reviewHeaderLines` at 80/120, `DecisionRow` model (`consumedBy`, `near`), `/why` and
   `/calibration` renderers over fixture `decisions.jsonl`, seed algorithm, index fold, `exitCodeFor(reason, error, degraded)`,
   status-line zones per width, statusPorcelainV2 fixtures, undo decision table, numstat parser, pager selection.
2. **Property tests** (mulberry32 fuzzer, A106): buffer op alphabet incl. raw `parse-keypress` sequences; invariants — cursor on a
   grapheme boundary, `text === graphemes.join('')`, no control chars, insert/backspace and kill/undo identities,
   `width ≤ columns` per row and rendered cursor = summed widths, paste = one undo step; 1,000–5,000 iterations, < 2 s per file,
   seed printed on failure, shrink by prefix replay.
3. **ink-testing-library** with `StubStdout(rows, columns)` (has `rows`): composer typing/paste/chips, secret gate `y/N`
   contract, review keys incl. `d` note path, deferral (typed-ahead `y` never approves), palette/picker/help/wizard/confirm/blocking
   frames as `renderToString` snapshots of the dynamic region only (normalised serializer: SGR stripped, spinner → `⠿`,
   durations → `<t>`, run ids → `<id>`, money → `<$>`), height at every geometry (`dynamicRegion(frame).length ≤ rows − 2`),
   `PaneBoundary` fallback, reducer `retry` row + tick, queue rows, toasts.
4. **Engine/session integration** (mock provider + decider): steer consumption (`steer:queued`/`steer:applied`, harness problem,
   loop counts reset, checkpointed `pendingDirectives`), `pause` → `human_pause` and `--resume`, seed follow-up run, session meter
   clamp/warn/stop, unpriced refusal, `token_cap`, secret artefact sweep (canary + PEM in no artefact, raw canary at the mocked
   provider, not in Jev state), pre/post images and `/undo` in a temp git repo (staged-then-modified, linked worktree on darwin),
   `--json` schema (every line parses, schema 1, unknown-type tolerance), `--plain` parity line-for-line with `transcript.log`.
5. **pty suite** (new vitest project `pty`, `skipIf(!existsSync('/usr/bin/expect'))`, `CI` unset in the child env, macOS runner):
   first frame of `chat`, typing during a live mock (zero clears, latency), review keys, Esc/Ctrl-C/Ctrl-D matrix cells,
   `\`+Enter/Ctrl+J newlines, 20 KB bracketed paste with a `ghp_` token (chip echoed, token never), resize via `stty -f $pty`
   (wait for the final geometry), Ctrl-Z/`fg` under `bash -i`, `JEVCODE_FAULT=render:decisions|persist:ENOSPC|jev:429:12`,
   `PAGER='sh -c "cat >/tmp/out; echo PAGED"'` for `/diff --full`, crash test (`stty -a` shows `icanon echo`, epilogue after the
   last frame bytes, `state.json` present), 0×0 pty rule width 80.
6. **Fault injection**: `JEVCODE_FAULT` values above plus `disk:EACCES`; opt-in `JEVCODE_TEST_RAMDISK=1` `hdiutil` 1 MiB image.
7. **CI without a TTY**: layers 1–4 run everywhere; 5–6 and `npm run perf` on `macos-latest` only; colour env matrix spawns
   the CLI and asserts SGR presence/absence; `NODE_ENV=production` for vitest and perf.

---

## 20. Module map for parallel implementation (ten owner slots, disjoint files)

| File | Exports | Depends on | Slot | Wave |
| --- | --- | --- | --- | --- |
| `src/core/types.ts` (§15 additions), `src/errors.ts` (`BudgetKind` + `token_cap`) | contract 1.1 | — | 0 (integrator) | 0 |
| `src/tui/text/width.ts`, `eaw-table.ts`, `scripts/gen-eaw.mjs` | `cellWidth`, `truncateCells`, `graphemes` | — | 1 | 1 |
| `src/tui/composer/buffer.ts`, `layout.ts`, `history.ts`, `killring.ts` | `bufferReducer`, `layout`, `cursorXY`, history I/O | width | 1 | 1 |
| `src/tui/composer/Composer.tsx`, `paste.ts`, `editor.ts` | `<Composer>`, `usePasteChips`, `openExternalEditor` | buffer, keys, redact | 1 | 2 |
| `src/tui/keys/registry.ts`, `matcher.ts`, `bindings-file.ts`, `escape.ts` (30 ms re-buffer, Ctrl-C/Esc/Ctrl-D windows) | `KEYS`, `resolveKey`, `loadKeybindings` | — | 2 | 1 |
| `src/tui/layout.ts` | `computeLayout`, caps | — | 2 | 1 |
| `src/tui/App.tsx` (rewired), `useEngine.tsx` (reducer extensions: review deferral, queue, retry tick, toasts, tabs, DecisionRow), `PaneBoundary.tsx`, `Transcript.tsx` (Static cap) | `createTuiRenderer`, `uiReducer` | layout, keys, all panes | 2 | 3 |
| `src/tui/review/lines.ts`, `Review.tsx`, `note.ts` | `reviewHeaderLines`, `<Review>` | width, risk texts | 3 | 1–2 |
| `src/tui/decisions/model.ts`, `Pane.tsx`, `tabs/{Decisions,Plan,Timeline,Synth}.tsx`, `bars.ts`, `why.ts`, `LoopBanner.tsx` | `toDecisionRow`, `bar`, `whyLines`, `<Pane>` | width | 3 | 1–2 |
| `src/tui/StatusLine.tsx` (zones, meters, sparkline, toasts), `git/useGitHead.ts` | `formatStatusLine`, `useGitHead` | width | 4 | 2 |
| `src/tui/palette/Palette.tsx`, `Picker.tsx`, `Help.tsx`, `fuzzy.ts`, `mention.ts` | `<Palette>`, `<Picker>`, `score`, `mentionCandidates` | commands, index | 4 | 2 |
| `src/session/controller.ts`, `commands/{grammar,registry,builtins}.ts`, `seed.ts`, `index.ts` (sessions/index.jsonl), `history.ts`, `export.ts`, `calibration.ts`, `budget.ts` (meter tree), `json-stream.ts` | `createSessionController`, `dispatch`, `buildSeed`, `foldIndex`, `writeJsonStream` | engine, config, meter | 5 | 2 |
| `src/tui/plain.ts` (new items, readline composer `plain-composer.ts`, review `d` path), `src/tui/screenreader.ts` | `createPlainRenderer`, `createReadlineComposer` | commands | 5 | 2 |
| `src/loop/engine.ts` (steer/pause/seed/directive/retry/notice/workspace/planAfter/note/token_cap), `state.ts`, `budget.ts`, `stop.ts`, `plan.ts`, `loopdetect.ts`, `provider/prompts.ts` | per §15 | contract | 6 | 1 |
| `src/jev/client.ts`, `src/provider/sse.ts`, `anthropic.ts`, `openrouter.ts` (`onRetry`, waker, `SerializedError` fields, unpriced) | — | contract | 6 | 1 |
| `src/config/{defaults,types,validate,resolve,ui}.ts` (§16 rows, `missingSecrets`, `priced`, XDG, mode-keyed default, `config set`) | — | — | 7 | 1 |
| `src/tui/onboarding/{reducer,Wizard,MaskedField,trust,instructions}.ts(x)`, `src/cli/login.ts` | `onboardingReducer`, `<Wizard>`, `loadInstructions`, `readTrust` | config, redact | 7 | 2 |
| `src/core/redact.ts` (`detectSecrets`, `dropSecret`), `src/tui/secrets/{gate,clipboard}.ts`, `src/sandbox/paths.ts` (denylist), `src/workspace/files.ts` (`readSecretForMention`) | — | — | 8 | 1 |
| `src/workspace/git.ts` (`GitState`, `statusPorcelainV2`, `restoreFromHead`), `src/workspace/images.ts` (pre/post), `src/session/{undo,diff}.ts`, `src/sandbox/seatbelt.ts` (`gitDir`) | — | sandbox | 8 | 1–2 |
| `src/core/log.ts` (per-run log), `src/cli/{fatal,epilogue,report,doctor}.ts`, `src/tui/retry-tick.ts` | `createRunLog`, `fatalExit`, `epilogueLines`, `writeReport` | redact | 9 | 1 |
| `src/cli/{args,main}.tsx` (commands, flags, wiring, `--json`, `chat`), `bin/jevcode.js`, `scripts/{build,gen-completions,gen-man,licenses}.mjs`, `man/`, `Formula/`, `.github/workflows/release.yml`, `LICENSE` | — | everything | 0 + 10 | 3 |
| `perf/composer-latency.ts`, `perf/render-lag.ts`, `perf/first-frame.ts`; `test/pty/*.exp`, `test/unit/**` per §19 | — | — | 10 | 2–3 |

Waves: **0** contract + errors (½ day, integrator; everyone codes against it). **1** pure modules in parallel (slots 1–9).
**2** components and controller. **3** wiring (`App.tsx`, `main.tsx`), pty suite, perf. **4** docs and release prep.
Ownership rule: a slot edits only its files; contract needs go to slot 0 as a diff request.

---

## 21. Docs deliverables

`docs/DESIGN.md` §10–§12 amendments (session TUI, exit-code table, cap set, `--json` guarantee); `docs/TUI.md` (frames,
keys, commands, twins); `docs/KEYS.md` (generated, sync-tested); `docs/COMMANDS.md` (generated from the registry);
`docs/CONFIG.md` (§16 table, generated from `SETTINGS`); `docs/SESSIONS.md` (index schema, seeding, steering, undo);
`docs/JSON-STREAM.md` (schema 1); `docs/research/tui/terminal-matrix.md` (checklist filled by `jevcode doctor --terminal`);
`docs/RELEASE.md` (§17 checklist); `man/jevcode.1`; README sections "Interactive session", "Keys never appear in logs … or in
prompt history, clipboard payloads and the `--json` stream", Windows note, install/upgrade.

---

## 22. Deviations from research ADOPT rows and items deferred to v1.x

| Row | Deviation | One-sentence reason |
| --- | --- | --- |
| A10/12 §4 "composer before live in `computeLayout`" | live yields before the composer's *growth* but the palette/queue/secret rows sit between them | F3 fixes the yield order pane → live → preview → queue → composer-to-1, which puts live below queue and composer |
| A33 pre-wrap `<Static>` items at commit width | items stay single logical lines; Ink wraps | pre-wrapping would break `transcript.log`/`--plain` line identity (DESIGN §10) |
| A46 tokens back at ≥ 140 columns | token counts appear only in `/cost` and the `token_cap` status form | the sparkline and git zone already fill 120 columns and the run/session split is the priority |
| A56 `--list-sessions` flag | `jevcode sessions` command instead | one command groups list/reindex/prune |
| A63 project commands with `$ARGUMENTS` | kept but prompt-text only and hidden behind `.jevcode/commands/` opt-in | no shell, no hooks (R22) |
| A160 `[r] retry now` "may stay out of v1" | shipped in v1 as `RetryWaker` | F12 requires it; the waker is a second signal on the existing abortable sleep |
| 11 §4b ruler row always | ruler shown only in `NO_COLOR`/`--ascii`; row 3 otherwise carries column titles | keeps the header at 8 rows with `matches_intent` included |
| 11 §4c ballot glyphs in the unicode theme | ASCII `[x] [ ] [?] [!]` in every theme | font coverage risk (11 §3.1) and identical plain twin |
| 13 §5.7 trust file under XDG debated (C49) | `~/.jevcode/trust.json` | already denied to sandboxed commands |
| 10 §15.3 "slash commands deferred to run end otherwise" | idle-only commands are refused with a toast while live, not queued | a queued destructive command after `run:end` would surprise the user |
| 16 §4.3 `ui.json` under the run dir | written only at checkpoint boundaries and shutdown; drafts of sessions without a run go to `~/.jevcode/sessions/<sid>.ui.json` | a session may have no run dir yet |

Deferred to v1.x: owned kitty handshake (`CSI ? u` + `CSI c`, flag 1) after the pty suite (A77); `--render-mode incremental`
by default after the soak test (C2); two side-by-side tabs at ≥ 120 columns (11 §5); `unpause()`/`/continue` cancelling a
pending pause; `/redo` (P54); "restore to HEAD" undo option (P50); `.jevcodeignore`; promotion of the warn-only secret
families to redacting after a week of real prompts (C44/Q35); `run.lock` and PID liveness for concurrent sessions (P11);
`/cd` workspace switching; `--tui fullscreen`; SEA/Bun binaries (R26); localisation (A99); OSC 11 `--theme auto` behind a
pre-Ink stdin demux (Q13); Jev visibility of `AGENTS.md` (10 §18); Windows/ConPTY measurements (Q19); screen-reader user
validation with NVDA/VoiceOver (Q15/Q16); `/why` for the context stage's top-k (P12); structured `synth` fields land when the
synth team adopts the optional members (P13).
