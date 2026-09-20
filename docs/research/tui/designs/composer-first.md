# Composer-first design for the JevCode interactive TUI

Written 2026-09-20 against `docs/research/tui/00-SUMMARY.md` (1,152 lines) and research files 01–17, 19, and the code
as of commit `3b9cbc1` (`src/tui/*`, `src/cli/*`, `src/core/types.ts`, `src/loop/engine.ts`, `src/provider/prompts.ts`,
`src/loop/state.ts`, `src/checkpoint/*`, `src/config/resolve.ts`, `src/spend/meter.ts`, `src/core/redact.ts`,
`docs/DESIGN.md` §6, §9–§12, `node_modules/ink/build/*.d.ts` 7.1.1). Citations: `A12`/`R3`/`C17`/`P44`/`Q8`/`D1` are
rows of the summary; `NN §x` is a research file section; `F1`–`F18` are the product owner's fixed decisions. Where a
sentence deviates from an ADOPT row it says so in §22. Angle: composer-first, opencode / Claude Code fidelity.

Contents: 0 thesis · 1 entry points · 2 layout · 3 keys · 4 composer · 5 palette and slash grammar · 6 review prompt ·
7 Jev pane and status line · 8 sessions · 9 money · 10 secrets · 11 onboarding · 12 git/undo/diff · 13 errors ·
14 terminal posture · 15 contract additions · 16 config · 17 packaging · 18 performance · 19 testing · 20 module map ·
21 docs · 22 deviations and deferrals.

---

## 0. Thesis and how the fixed decisions are honoured

**Thesis.** The composer is the one element that exists in every frame after the first, always sits directly above the
status line, and owns key focus unless a *box* (review, wizard, follow-up budget confirm, blocking pane, secret gate,
undo prompt) takes it. Everything else — the live tail, the tabbed Jev pane, the review preview, the queued-steer
preview — is allocated around the composer by one `computeLayout()` whose yield order is `pane → live → preview →
queue → composer-to-1` (A109, 19 §5). Jev-native views are tabs on the rule row that never take focus and never grow
(A44, A13). The engine changes only through additive, versioned hooks (`steer`/`unsteer`/`pause`, a seed, a human
directive slot, new events, §15); `transcript.log`, `--plain` and the `<Static>` transcript stay line-identical
(DESIGN §10, A49). The input model is a pure reducer over a grapheme-indexed `TextBuffer` (A1, 08 §8) with readline
bindings exactly as bash/Node/helix/bubbles/Claude Code agree (A8, 06 §4), so a user arriving from opencode or Claude
Code types without relearning anything: `/` at column 0 opens the palette, `@` mentions a file, Enter submits, Ctrl+J
newlines, Up from the first row reaches history or takes the queue back, Esc is never destructive on its own.

| Fixed | Honoured in | One-line how |
| --- | --- | --- |
| F1 entry points | §1 | `jevcode`/`jevcode chat` → session TUI; `run "<task>"` one-shot; `--plain` TTY readline composer over the same dispatcher; `--json` versioned stream; first frame = composer frame under the 300 ms gate |
| F2 rendering | §2, §14 | `<Static>` scrollback, one dynamic region ≤ rows − 2, `render({ exitOnCtrlC: false, patchConsole: false, maxFps, kittyKeyboard: { mode: 'disabled' } })`, no alt screen, no mouse, themes without detection, ANSI-16 + marker, `NO_COLOR` shim in `bin/jevcode.js` |
| F3 caps | §2 | `computeLayout()` implements the A109 cap set and yield order; frames at rows 8/12/24/40/50 × 80/120 |
| F4 keys | §3, §4 | A8 readline set verbatim; Tab completion, no `useFocus`; Ctrl+O appends; Ctrl+G via `suspendTerminal`; Ctrl+Z; Ctrl+L erase-lines; Up/Down row rule; Ctrl+R; no `!`, no `/compact` |
| F5 Ctrl-C/Esc/Ctrl-D | §3.2 | 19 §4 matrix with the owner's choices as one state machine; 1.5 s / 2 s / 800 ms windows; 30 ms Esc re-buffer |
| F6 review | §6 | `y n Esc d e w+digit Ctrl-C`; keys line row 2; per-dimension gauges + `matches_intent`; ~1 s idle deferral; never Enter/default/always/timeout |
| F7 sessions | §8 | index.jsonl schemas, picker, seeding algorithm, steer consumption in `runStep`, `human_pause`, history.jsonl, `planAfter`, `/export`, `/theme` new-items-only, pending `/budget` in memory |
| F8 money | §9 | parent `SpendMeter`, child clamp, 50/80/95 %, `y/r/n` box, `/budget` scopes, unpriced fails closed, no pre-emption |
| F9 secrets | §10 | `detectSecrets` gate, `addSecret` on `y`, raw provider turn + `secret-ack` count, `useRef` chips, 12,000-char notice, `@` denylist, clipboard, trace classes |
| F10 onboarding | §11 | `missingSecrets` probe, ≤ 4-row wizard, masked field, XDG write 0600, optional verify, trust gate, sandbox line, `--no-input` |
| F11 git/undo/diff | §12 | two spawns → `GitState`, banner, `fs.watch` zone, pre/post images, verify-before-write table, `git restore --source=HEAD --worktree`, `/diff` formats |
| F12 errors | §13 | `retry` events + 1 Hz row, `PaneBoundary`, re-ordered `fatalExit`, epilogue, disk pause, 401 → onboarding, `jevcode.log`, `/report`, exit-code table |
| F13 contract | §15 | one ordered list of additive signatures with insertion points; jev-only checklist |
| F14 config | §16 | one `ui.*`/limits table with flag/env/file/default/sources |
| F15 packaging | §17 | zero-dependency tarball, `files`, minify, launcher guard, completions, man page, tap, trusted publishing |
| F16 views | §7 | tabs `d p t s`, `[`/`]`, bars, sparkline, banner, three-zone status, `/why`, `/calibration`, toasts, twins |
| F17 fuzzy | §5.5 | prefix-then-subsequence scorer with word-boundary bonuses, ≤ 8 rows, ≤ 16 ms per keystroke at 5,000 candidates |
| F18 constraints | §15, §19, §20 | no runtime deps, strict TS, offline unit tests, pty suite via `expect`, perf gates extended |

---

## 1. Entry points and modes

### 1.1 Commands (`src/cli/args.ts`)

`COMMANDS` becomes `['chat', 'run', 'config', 'bench', 'perf', 'login', 'logout', 'sessions', 'report', 'completion',
'upgrade', 'doctor', 'calibration', 'keys']`. `parseCliArgs([])` returns `{ command: 'chat' }` (today it throws
"missing command"); a first token that starts with `-` is parsed as flags of `chat` (so `jevcode --theme light` works);
`--version` and `--help` are answered before any import of Ink (A65; today they already are, `main.tsx:268-275`);
`--version --json` prints `{ "name": "jevcode", "version": "…", "node": "…", "bundle": "<path>" }`.

### 1.2 Renderer and mode selection (`src/cli/main.tsx`)

```ts
const tty = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);            // A82: isTTY is undefined on a pipe
const interactive = tty && !flags.plain && !flags.json && !process.env['CI'] && process.env['TERM'] !== 'dumb' && !flags.noInput;
```

| Invocation | Composer | Renderer | Exits after the run | index / history written | Review prompt | Secret gate | Follow-up confirm | Wizard |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `jevcode`, `jevcode chat` (TTY) | Ink composer, no run yet | `createSessionRenderer` (§20 `tui/Session.tsx`) | no (`/exit`, Ctrl-D, Ctrl-C ×2) | yes / yes | deferred box | row | box | after first frame |
| `jevcode run "<task>"` (TTY) | Ink composer (steer only) | same App, `policy: 'oneshot'` | yes, `exitCodeFor` | yes / steers only | box | row (steers) | never (no follow-up) | after first frame |
| `jevcode run` no task (TTY) | Ink composer for the one task | same, `policy: 'oneshot'` | yes, after that one run | yes / yes | box | row | never | after first frame |
| `jevcode run --resume <id\|title>`, `-c/--continue` | Ink composer (steer; follow-up if session) | `oneshot` for `run`, `session` for `chat --resume` | per command | yes / yes | box | row | box (session) | no (keys must resolve) |
| `--plain` on a TTY | readline line composer (`tui/plain-composer.ts`), same slash dispatcher | plain | per command | yes / yes | readline `y/n/d` | readline `y/N` | readline `y/r/n` | raw-mode masked prompt (13 §5.9) |
| `--plain` on a pipe | none: task from argv, `--task-file`, stdin | plain | yes | index yes / history no | declines after `confirmTimeoutMs` | cancels (exit 2) | clamp silently + `budget:clamp` | fix block, exit 2 |
| `--json` (implies `--plain`) | none | JSONL stream (§8.9) | yes | index yes / history no | declines | cancels | clamp + event | fix block, exit 2 |
| `--no-input` | none accepted | either | per command | per command | declines | cancels | clamp | fix block, exit 2 |
| `bench`, `perf` | none | none / plain | n/a | never (`source !== 'cli'`) | `alwaysDecline` | n/a | n/a | n/a |

Rules: `run` always exits after its one run (today's monitor behaviour, F1); `chat` never exits on `run:end`. The
composer frame is the first frame in every TTY mode: `render(<App … />)` happens before `resolveConfig()` exactly as
today (`main.tsx:93-101`), so the 300 ms gate covers the composer (F1, 10 §18 Q8). `chat` reads `~/.jevcode/sessions/
index.jsonl` after `firstFrame()` to fill the one-row `recent: <title> · <time ago> (Enter continues, /resume browses)`
hint (A56). Bare `jevcode` on a pipe with no task prints the usage line and exits 2 (nothing to do).

### 1.3 The session controller (`src/cli/session.ts`, new)

```ts
export interface SessionController {
  readonly sessionId: string | null;          // first run id; null until the first run starts
  readonly meter: SpendMeter;                 // parent meter (A129), cap from ui.session-spend-cap (§9)
  startRun(task: string, seed: RunSeed | null): Promise<RunHandle>;   // builds EngineOptions, child meter, index run:start
  resumeRun(runId: string): Promise<RunHandle>;
  steer(text: string): { queued: number; index: number };            // engine.steer + index 'steer' line + history 'steer'
  unsteer(): string[];
  pause(): void;                              // engine.pause()
  abort(): void;                              // engine.abort('human_abort')
  exit(code?: number): never;                 // /exit: 0 always unless ui.exit-code=last-run (17 §4.9)
  readonly last: RunResult | null;            // seeds the follow-up (§8.5)
}
```

One engine is live at a time; `startRun` while `live` is a programming error (the composer routes Enter to `steer`
while `state.done === null`, §4.9). Bench and perf never construct a `SessionController`.

---

## 2. Layout: `computeLayout(rows, columns, state)`

### 2.1 Order of the dynamic region (top → bottom)

`rule+tabs (1) · live (≤ 2, retry row inside) · loop banner (≤ 1) · pane (≤ 12) · box (review header 8 | wizard ≤ 4 |
budget 5 | blocking ≤ 5 | undo 2 | help ≤ 12 | picker ≤ 14) · review preview (≤ 8, `e` = rest) · queue (≤ 2) · Ctrl-R
search row (≤ 1) · secret row (≤ 1) · composer (1–6, 8 at rows ≥ 40) · palette (≤ 8) · status (1)`. Everything above
the rule is `<Static>`. The rule row *is* the pane's tab header (11 §4a "it is the existing rule row with text"), so
tabs cost no row. The composer is allocated its floor before every box and its growth before every other optional
pane, which is what makes the yield order `pane → live → preview → queue → composer-to-1` fall out of a single
priority-ordered `take()` loop (A109, C47, D1).

### 2.2 The function (`src/tui/layout.ts`, pure, unit-tested without Ink)

```ts
export const MIN_ROWS = 8; export const MIN_COLUMNS = 40;                  // A100, 12 §4
export const PANE_MAX = 12; export const LIVE_MAX = 2; export const QUEUE_MAX = 2; export const PALETTE_MAX = 8;
export const REVIEW_HEADER = 8; export const PREVIEW_MAX = 8; export const PICKER_MAX = 14; export const HELP_MAX = 12;
export type BoxKind = 'none' | 'review' | 'wizard' | 'budget' | 'blocking' | 'undo' | 'help' | 'picker';
export interface LayoutInput {
  rows: number; columns: number;                 // from useWindowSize() only (A93, 19 §3), never process.stdout.*
  live: boolean;                                 // a run is live (runId !== null && done === null)
  streaming: boolean;                            // live buffer or synth line non-empty
  retry: boolean;                                // a retry countdown row is active (17 §4.3)
  composerRows: number;                          // visual rows of the draft, ≥ 1 (layout() of the TextBuffer)
  queue: number;                                 // pending directives not yet applied (0..8)
  box: BoxKind; boxWant: number;                 // rows the box asks for (review 8, wizard 2–4, budget 5, blocking ≤ 5, undo 2, help/picker = content)
  previewLines: number; expanded: boolean;       // review only
  search: boolean; secretRow: boolean;           // Ctrl-R row, `Send anyway? y/N` row
  palette: number;                               // suggestion rows wanted incl. the footer row, 0 = closed
  paneContent: number;                           // rows the active tab has to show (0 when no run yet)
  loopBanner: boolean;
}
export interface Layout {
  readonly budget: number; readonly notice: number; readonly status: number; readonly rule: number;
  readonly live: number; readonly banner: number; readonly pane: number; readonly box: number; readonly preview: number;
  readonly queue: number; readonly search: number; readonly secret: number; readonly composer: number;
  readonly palette: number; readonly total: number; readonly degraded: 'none' | 'tiny' | 'status-only';
}
export function computeLayout(i: LayoutInput): Layout {
  const budget = Math.max(0, Math.floor(i.rows) - 2);
  let rem = budget;
  const take = (want: number): number => { const got = Math.max(0, Math.min(Math.floor(want), rem)); rem -= got; return got; };
  const zero: Layout = { budget, notice: 0, status: 0, rule: 0, live: 0, banner: 0, pane: 0, box: 0, preview: 0, queue: 0, search: 0, secret: 0, composer: 0, palette: 0, total: 0, degraded: 'none' };
  if (i.rows < 3) return { ...zero, status: take(1), total: budget - rem, degraded: 'status-only' };           // A10 status-only below 3
  if (i.rows < MIN_ROWS || i.columns < MIN_COLUMNS) {                                                          // A100 two-line degradation
    const status = take(1), notice = take(1), composer = take(1);
    return { ...zero, status, notice, composer, total: budget - rem, degraded: 'tiny' };
  }
  const status = take(1);
  const rule = take(1);
  const hidesComposer = i.box === 'wizard' || i.box === 'picker' || i.box === 'help';                          // these boxes carry their own input row
  const collapsesComposer = i.box === 'review' || i.box === 'budget' || i.box === 'blocking' || i.box === 'undo'; // F3: a pending review collapses the composer to one row
  let composer = hidesComposer ? 0 : take(1);
  const box = i.box === 'none' ? 0 : take(i.box === 'review' ? REVIEW_HEADER : i.box === 'help' ? Math.min(HELP_MAX, i.boxWant) : i.box === 'picker' ? Math.min(PICKER_MAX, i.boxWant) : i.boxWant);
  const secret = i.secretRow && !hidesComposer ? take(1) : 0;
  const search = i.search && !hidesComposer && !collapsesComposer ? take(1) : 0;
  const cap = i.rows >= 40 ? 8 : 6;                                                                            // A10: 8 only at rows ≥ 40
  if (!hidesComposer && !collapsesComposer) composer += take(Math.min(i.composerRows, cap) - 1);
  const palette = i.box === 'none' ? take(Math.min(i.palette, PALETTE_MAX)) : 0;
  const queue = take(Math.min(i.queue, QUEUE_MAX));
  const preview = i.box === 'review' ? take(i.expanded ? i.previewLines : Math.min(i.previewLines, PREVIEW_MAX)) : 0;
  const liveWant = i.box === 'review' ? 0 : i.live ? (i.streaming || i.retry ? LIVE_MAX : 0) : 0;              // A42: review reclaims the live rows
  const live = take(Math.max(liveWant, i.retry && i.box !== 'review' ? 1 : 0));
  const banner = take(i.loopBanner ? 1 : 0);
  const pane = i.box === 'picker' || i.box === 'help' ? 0 : take(Math.min(PANE_MAX, i.paneContent));
  return { budget, notice: 0, status, rule, live, banner, pane, box, preview, queue, search, secret, composer, palette, total: budget - rem, degraded: 'none' };
}
```

Invariants (property-tested, §19): `total ≤ budget`; `composer ≥ 1` unless hidden or `rows < 3`; a review box always
receives ≥ 3 rows at `rows ≥ 8` (title, keys, dominant dimension); `live === 0` while a review is pending; `pane` is the
first field to reach 0 under pressure; `queue ≤ 2`; `palette ≤ 8`; `composer ≤ 6` below rows 40 and `≤ 8` from 40.
The pane's `paneContent` is `min(12, rows the active tab has)`, so an idle composer with no run costs 3 rows (rule,
composer, status) — the compact idle frame opencode and Claude Code users expect.

### 2.3 Allocation table (rows; columns only matter for the tiny gate)

Vector = `status/rule/live/banner/pane/box/preview/queue/search/secret/composer/palette` (total). Pane content 12 unless
stated. `—` = 0.

| State | rows 8 (budget 6) | rows 12 (10) | rows 24 (22) | rows 40 (38) | rows 50 (48) |
| --- | --- | --- | --- | --- | --- |
| idle, no run, 1-row draft | 1/1/—/—/—/—/—/—/—/—/1/— (3) | same (3) | same (3) | same (3) | same (3) |
| idle after a run, 1-row draft | 1/1/—/—/3/…/1/— (6) | pane 7 (10) | pane 12 (15) | pane 12 (15) | pane 12 (15) |
| idle, 6-row draft | composer 4, pane 0 (6) | composer 6, pane 2 (10) | composer 6, pane 12 (20) | composer 6, pane 12 (20) | same (20) |
| idle, 9-row draft (rows ≥ 40 cap 8) | composer 4 (6) | composer 6 (10) | composer 6 ↑3 marker (20) | composer 8, pane 12 (22) | composer 8 (22) |
| live, streaming, empty composer | live 2, pane 1 (6) | live 2, pane 5 (10) | live 2, pane 12 (17) | (17) | (17) |
| live, 2 queued, 3-row draft | composer 3, queue 1, live 0, pane 0 (6) | composer 3, queue 2, live 2, pane 1 (10) | composer 3, queue 2, live 2, pane 12 (21) | (21) | (21) |
| review pending, preview 12 | box 3 (6) | box 7 (10) | box 8, preview 8, pane 3, composer 1 (22) | box 8, preview 8, pane 12 (31) | (31) |
| review + `e` expanded | box 3 (6) | box 7 (10) | box 8, preview 11, pane 0 (22) | box 8, preview 12, pane 12 (35) | (35) |
| palette open (5 rows + footer), 1-row draft | palette 3 (6) | palette 6, pane 1 (10) | palette 6, pane 12 (21) | (21) | (21) |
| picker open (composer hidden) | box 4 (6) | box 8 (10) | box 14 (16) | box 14 (16) | (16) |
| wizard (composer hidden) | box 4 (6) | box 4 (6) | box 4 (+ pane 12 if `/login` mid-run) (6/18) | (6/18) | (6/18) |
| follow-up budget confirm (5), composer 1 | box 3 (6) | box 5, pane 2 (10) | box 5, pane 12 (20) | (20) | (20) |
| retry row, live, empty composer | live 2 (retry row 1 + tail 1), pane 1 (6) | live 2, pane 5 (10) | live 2, pane 12 (17) | (17) | (17) |
| secret gate row, 2-row draft | secret 1, composer 2, pane 0 (6) | secret 1, composer 2, pane 6 (10) | secret 1, composer 2, pane 12 (17) | (17) | (17) |
| tiny (rows < 8 or cols < 40) | notice 1 + composer 1 + status 1 (3) | n/a | n/a | n/a | n/a |

At rows 50 nothing but the composer cap (8) changes versus rows 40 (A109); §2.4 K covers both.

### 2.4 Worked frames

Legend: `›` composer prompt (`>` under `--ascii`); `·` bar track; `⠹` spinner; `⎇` git zone (`br` in ASCII). Frames
show the dynamic region and the last scrollback rows; no row exceeds the frame's 80 or 120 cells. Colour is not shown; every
coloured token carries its word or marker (A97).

**A. Idle composer, session mode, no run yet — 80×24** (3 dynamic rows; scrollback holds the header and the recent hint)

```
[run] jevcode chat · ~/proj · recent "fix parse_date tz" 2h ago (Enter resumes)
── decisions ─────────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
› Fix a TODO in the codebase…
step 0/–  idle  ⎇ main · 3~ 1?  run $0.00/2.00 ok  sess $0.00/10.00 ok
```

**A′. Same at 120×24** (right zone gains the 10-cell meters and the `? help · / commands` short help; A46, 14 §5.1)

```
── decisions ─────────────────────────────────────────────────────── [d] decisions  [p] plan  [t] timeline  [s] synth ──
› Fix a TODO in the codebase…  ("What is the tech stack?" · "Fix broken tests")
step 0/–  idle  ⎇ main · 3~ 1?  run $0.00/$2.00 ·········· ok  session $0.00/$10.00 ·········· ok   ? help · / commands
```

**B. Live run, generator streaming — 80×24** (live 2, pane 12 of decisions, composer 1 empty; 17 rows)

```
[step 7] intent=edit p=0.64 c=0.55
[step 7] context 3 files 9.1kB of 212 candidates: src/a.py, tests/test_a.py
── decisions  s7 ─────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
I'll make parse_date timezone-aware by replacing the naive strptime call with
streaming… 1.2k chars
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
… 8 more decision rows (s7 context, s6 risk ×4, s6 judge ×2) …
› steer the run… (Enter queues for the next step)
step 7/40  ⠹ propose 6s  ⎇ main · 3~ 1?  run $0.31/2.00 ok  sess $4.11/10.00 ok
```

**C. Live run with 2 queued steers and a 3-row draft — 80×12** (budget 10: composer 3, queue 2, live 2, pane 1)

```
── decisions  s7 ─────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
def parse_date(s: str) -> datetime:
streaming… 2.4k chars
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
↑ 1  also update the CHANGELOG entry for 0.4.2                            step 8
↑ 2  skip the flaky test_network case                                     step 8
› and please keep the public signature of parse_date unchanged; I will
  handle the callers in a follow-up. Also mention it in the docstring of
  the module so the next person knows the tz assumption.                    ↓1
step 7/40  ⠹ propose 6s  run $0.31/2.00 ok  sess $4.11/10.00 ok  Up takes back
```

**D. Review pending — 80×24** (live 0, pane 3, header 8, preview 8, composer collapsed; 22 rows)

```
── decisions  s7 ─────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     destructive      L1     ██▌·······  0.25  c 0.93   [ok]
s7 risk     matches_intent   noul   ████████▊·  0.88  c 0.76~
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]+1-5 why [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous cont…
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable …
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what `plan.remainin…
matches_intent     ████████▊·  0.88 noul 0.76~ the action is an instance of the…
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)



  …[3 more preview lines · e expands]
› review pending — y / n / d note / e / w+digit · Esc declines · Ctrl-C aborts
step 7/40  review 12s  ⎇ main · 3~ 1?  run $0.31/2.00 ok  sess $4.11/10.00 ok
```

**D′. Review pending — 80×12** (budget 10: header 7 — the `matches_intent` row is the one cut; keys stay on row 2)

```
── decisions  s7 ─────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]+1-5 why [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous cont…
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable …
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what `plan.remainin…
› review pending — y / n / d note / e / w+digit · Esc declines · Ctrl-C aborts
step 7/40  review 12s  run $0.31/2.00 ok  sess $4.11/10.00 ok
```

**D″. Review pending — 120×40** (budget 38: header 8 with P(l)/E[k]/tail columns per 11 §4b, preview 8, pane 12, queue 0; 31 rows)

```
── decisions  s7 ─────────────────────────────────────────────────── [d] decisions  [p] plan  [t] timeline  [s] synth ──
… 12 decision rows as in B (120-column form with latency and option text) …
review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py "make parse_date timezone-aware"           jev 244ms
[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]+1-5 why  [esc] decline  [ctrl-c] abort run
dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)
plan_mismatch  L2  ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step
destructive    L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverable…
irreversible   L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git comma…
out_of_scope   L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]` or `task` as…
matches_intent     ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent `edit`
  --- old / +++ new preview as in D, 8 rows
› review pending — y / n / d note / e / w+digit · Esc declines · Ctrl-C aborts the run
step 7/40  review 12s  ⎇ main · 3~ 1?  run $0.31/$2.00 █▌········ ok  sess $4.11/$10.00 ████······ ok  jev ▂▃▂▅▂▂▇▃▂▁▂▃
```

**E. Palette open — 80×24** (composer `› /re`, 4 matches + footer = 5 palette rows below the composer; pane 12)

```
── decisions ─────────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
… pane rows …
› /re
  /resume [id|title]      open the session picker; with an argument continue it
  /rename <title>         set the session title (default: first 60 chars of the…
  /report                 bundle this run's artefacts under ~/.jevcode/reports/…
  /rewind [step] [what]   undo steps last…N; seed next run (files|plan|both)
  (1/4)  Tab completes · Enter runs an exact match · Esc closes
step 0/–  idle  run $0.00/2.00 ok  sess $4.11/10.00 ok
```

**F. Session picker — 120×24** (box 14 rows replaces pane and composer; rows per A56)

```
── sessions · ~/proj (7 of 41) · sort updated · type filters · Ctrl-A all · Space preview · Ctrl-R rename · x delete ───
› fix                                                                                                         (filter)
  2h ago  12 steps  complete    $1.53   fix parse_date tz handling                              20260920-061350-u3gx4e34
▌ 5h ago   4 steps  human_pause $0.21   fix flaky test_network                                  20260920-031102-k7q2m6xa
  1d ago  25 steps  max_steps   $0.54   Fix the failing tests in tests/test_core.py without…    20260919-142301-k7q2m9xa
  3d ago   9 steps  spend_cap   $2.03   fix CHANGELOG generation                                20260917-101010-a3f9k2mq
  — preview (Space) —
  plan done 2 / remaining 3 · spend $0.21 of $2.00 · stopped human_pause at step 4 · interrupted: none
  [step 4] outcome executed: ran pytest -q (exit 1, 3.2s) changed=0
  [step 4] judge succeeded=0.31 error_present=0.88 new_info=0.72 tests=39p/2f/0e fail claims=0/0 completion=0.12
  [run] stop: human_pause at step 4
  (4 blank rows)
  Enter resumes (follow-up composer opens) · Esc closes
step 0/–  idle  ⎇ main · 3~ 1?  run $0.00/$2.00 ·········· ok  session $0.00/$10.00 ·········· ok   ? help · / commands
```

**G. Onboarding wizard, key step — 80×8** (budget 6: wizard 4, composer hidden; 13 §5.2 frames)

```
[run] jevcode chat · ~/proj
────────────────────────────────────────────────────────────────────────────────
Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)
› ••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
108 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back
Keys are never shown, logged or echoed · Ctrl-C quits (prints the env/file fix)
step 0/–  setup
```

**H. Follow-up budget confirm — 80×12** (box 5, composer collapsed, pane 2; keys on row 2; 14 §5.3)

```
── decisions  s12 ────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
s12 judge   task_complete    noul   ████████▌·  0.85  c 0.70~
s12 risk    plan_mismatch    L0     █████████·  0.90  c 0.88   [ok]
┌ follow-up would exceed the session cap ──────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │
└──────────────────────────────────────────────────────────────────────────────┘
› now add the CHANGELOG entry                                          (kept)
step 12/40  done complete  run $0.71/2.00 ok  sess $9.58/10.00 critical
```

**I. Retry row — 80×24** (live row 1 is the countdown, row 2 the last tail line; 17 §4.3)

```
── decisions  s7 ─────────────── [d] decisions  [p] plan  [t] time  [s] synth ──
jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now
last: HTTP 429 · request-id req_01HX…
… pane rows (12) …
›
step 7/40  retrying 2/3  ⎇ main · 3~ 1?  run $0.31/2.00 ok  sess $4.11/10.00 ok
```

**J. Minimum-size notice — 38×7** (below 40×8: notice + composer + status; the transcript keeps flowing in `<Static>`)

```
[step 7] outcome executed: pytest -q
terminal 38x7 < 40x8 minimum; enlarge
› steer or type…
step 7/40  ⠹ risk  run $0.31/2.00 ok
```

**K. Rows 50 (and 40), 80 columns, idle after a run with a 9-row draft** — identical to rows 40: rule 1 + pane 12 +
composer 8 (`↓1` gutter marker on the last row) + status 1 = 22 dynamic rows; the remaining 26 rows are scrollback.
At 120 columns the composer wraps later so the same draft needs 6 rows and the pane keeps 12.

### 2.5 Resize and repaint

`useWindowSize()` (A15, A93) drives `computeLayout` on every render; the App debounces nothing itself — Ink already
coalesces frames at `maxFps` — but the reducer applies a 50 ms trailing debounce to the *composer re-wrap* so a 30-event
SIGWINCH storm (07 §3.2) costs one `layout()` (A30; C23 resolved to 50 ms). Scrollback is never rewritten (stale wrap
accepted, A30). Ctrl+L = Ink `eraseLines(frameHeight)` + full re-render of the dynamic region, never `ESC[2J` (A8, R29).

---

## 3. Keymap and key contexts

### 3.1 Contexts

One `useInput` (`{ isActive: Boolean(isRawModeSupported) }`, A14) and one `usePaste` in `<App>`; no `useFocus`
anywhere (A13). The dispatcher (`src/tui/keys/dispatch.ts`) routes by the reducer's `focus`:

| Context | Active when | Consumes | Falls through to |
| --- | --- | --- | --- |
| `global` | always | Ctrl-C, Ctrl-D, Ctrl-Z (`0x1a`), Ctrl-L, F1, Ctrl-O, `[`/`]` (only when the composer is empty), SIGTSTP/SIGCONT | — |
| `composer` | default | every key of §3.3 and §4 | `global` |
| `palette` | `/` at column 0 or `/` after a space with ≥ 1 char, while the token is unchanged | ↑/↓, Ctrl-P/N, PgUp/PgDn, Tab, Enter, Esc, printable | `composer` (printable edits the token and re-filters) |
| `mention` | `@` token under the cursor | same as palette over files | `composer` |
| `history-search` | Ctrl-R | printable (query), Ctrl-R (older), Ctrl-S (newer), Tab/→ (accept, keep editing), Enter (accept + submit), Esc/Ctrl-C (restore draft), Backspace on empty query (cancel) | — |
| `secret-gate` | `Send anyway? y/N` row | `y`/`Y` sends; every other key dismisses the row and is then handled by `composer` (16 §4.1) | `composer` |
| `review` | `pendingConfirm !== null` and the deferral elapsed | `y n d e w+digit Esc Ctrl-C`; digits after `w` for 1.5 s | `global` (Ctrl-C only) |
| `note` | after `d` | single-line composer editing keys; Enter sends decline+note; Esc cancels the note (back to `review`) | — |
| `budget` | follow-up confirm box | `y r n Esc`; Enter inert | `global` |
| `blocking` | 401/402/429-cap/disk/drift/sandbox panes (17 §4.5–4.7) | `r c q p` as the pane lists | `global` |
| `undo` | per-file `/undo` question | `y n a s Esc`; Enter = `n` | `global` |
| `picker` | `/resume`, `/sessions`, `/rewind` list | ↑/↓, Ctrl-P/N, PgUp/PgDn, Enter, Space, `/` or printable = filter, Ctrl-A, Ctrl-R, `x` (then `y` confirms), Esc | `global` |
| `wizard` | onboarding / `/login` masked field | printable + paste (into a `useRef` buffer), Backspace, Ctrl-U, Enter, Esc, `1`/`2` on choice steps, `y`/`n` on verify | Ctrl-C prints the fix block, exit 2 (13 §5.2) |
| `help` | `?` on an empty composer or F1 | `?`/Esc/`q` close; ↑/↓/PgUp/PgDn scroll; `/` filters | — |
| `pager` | `/diff --full`, `/transcript`, Ctrl-G | none: the terminal belongs to the child (`suspendTerminal`) | — |

### 3.2 Ctrl-C / Esc / Ctrl-D matrix (F5; 19 §4 as the base, the owner's choices applied)

| State | Mode | Ctrl-C (1st) | Ctrl-C (2nd, ≤ 1.5 s) | Esc | Esc Esc (≤ 2 s) | Ctrl-D (1st) | Ctrl-D (2nd, ≤ 800 ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle, composer empty | session | status hint `press Ctrl-C again to exit` | exit **0** | no-op (30 ms re-buffer, then nothing) | rewind/steer menu (`/rewind` picker when a run exists, else hint) | hint `press Ctrl-D again to exit` | exit 0 |
| idle, composer empty | one-shot (`run` with no task, before the run) | same | exit 0 | no-op | same | same | exit 0 |
| idle, composer has text | either | clear draft → history (`kind: 'prompt'`, draft marker) | as idle-empty | first Esc arms only | clear draft → history | delete-forward | delete-forward |
| live run, composer empty | one-shot | `shutdown('human_abort')` → checkpoint → exit 130 | `process.exit(130)` immediately (DESIGN §11 invariant) | `engine.pause()` → stop at the next step boundary, `human_pause`, exit 4 | `engine.abort('human_abort')` → 130 | hint `run live — Ctrl-D again exits after abort` | abort + exit 130 |
| live run, composer empty | session | `engine.abort('human_abort')` → checkpoint → `run:end` item, composer reopens, **no exit** | `process.exit(130)` if still `aborting`; else (run already ended) exit 0 | `engine.pause()`; `run:end human_pause` item; composer reopens | `engine.abort('human_abort')`; no exit | hint | abort, then exit 0 after the `run:end` item |
| live run, composer has text | either | clear draft → history (never aborts while text is present) | as live-empty | first Esc arms only | clear draft → history | delete-forward | delete-forward |
| review pending | either | decline **and** abort (`confirmer.resolve(id,false)` then `engine.abort`) | `process.exit(130)` | decline (safe-no) | n/a (first Esc already declined) | hint | as live-empty |
| `aborting` set (any) | either | `process.exit` immediately after `writeStateSync` (`engine.ts:492-495`, kept) | — | ignored | ignored | ignored | ignored |
| palette / mention / picker / help open | either | close the overlay (draft kept) | as the underlying state | close the overlay | — | close | — |
| history-search | either | cancel, restore draft | — | cancel, restore draft | — | — | — |
| wizard | either | print the env/file fix block to stderr, exit 2 (13 §5.2) | — | clear field / step back | — | ignored | — |
| budget confirm | either | cancel (text kept) | as idle | cancel | — | ignored | — |
| blocking pane | either | as live-empty | — | pause at the next boundary if the run is live | abort | — | — |

Windows: Ctrl-C 1.5 s (A18: between Codex 1 s and Gemini 3 s), Esc Esc 2 s (A54), Ctrl-D 800 ms (A19). The Esc
re-buffer is 30 ms above Ink's 20 ms flush: a lone `ESC` is held for 30 ms before it counts, and an `ESC` followed within
that window by a printable is Alt+char (07 §1.5, A20). A single Esc is never destructive (A20); `human_pause` is exit
family 4 and resumable like `null` (A54, §15 C2).

### 3.3 State machine (one reducer, `src/tui/keys/interrupts.ts`, pure over `(state, key, nowMs)`)

```
Interrupt = { ctrlCArmedAt: number | null; escArmedAt: number | null; ctrlDArmedAt: number | null }
on Ctrl-C:  text ≠ '' → CLEAR_DRAFT;  aborting → EXIT_NOW(130);  review → DECLINE_AND_ABORT;
            live && policy=oneshot → ABORT(130);  live && policy=session → armed? EXIT_NOW(130) : ABORT_STAY, arm 1.5 s;
            idle → armed && now−armedAt ≤ 1500 ? EXIT(0) : HINT('press Ctrl-C again to exit'), arm
on Esc:     (after 30 ms re-buffer, and not consumed as Alt) overlay → CLOSE;  review → DECLINE;
            text ≠ '' → armed ≤ 2000 ? CLEAR_DRAFT : arm;  live → armed ≤ 2000 ? ABORT : (PAUSE, arm);
            idle → armed ≤ 2000 ? OPEN_REWIND_MENU : arm
on Ctrl-D:  text ≠ '' → DELETE_FORWARD;  else armed ≤ 800 ? (live ? ABORT_THEN_EXIT(130) : EXIT(0)) : (HINT, arm)
any other key: clear all three arms
```

Every hint is a 2 s toast in the status line's left zone (A37) and, for Ctrl-C and Ctrl-D, also a `<Static>` item only
when the second press follows (so scrollback records "exited on Ctrl-C ×2", never idle hints).

### 3.4 Composer bindings (A8 verbatim, plus the fixed additions)

| Key(s) | Ink match | Action |
| --- | --- | --- |
| Enter | `key.return && !shift && !meta && !ctrl && input === '\r'`, `eventType !== 'release'\|'repeat'` | submit (§4.9); re-entrancy guard (A9) |
| Ctrl+J, `\`+Enter, Alt+Enter, Shift/Ctrl+Enter (kitty), `ESC CR` | `input === '\n'`; trailing `\` + Enter; `return && meta`; `return && (shift \|\| ctrl)`; `/^\[27;[2-8];13~$/` swallowed | newline (A6, C28) |
| Ctrl+A / Home, Ctrl+E / End; Ctrl+B / ←, Ctrl+F / → | `ctrl && 'a'`, `key.home`, `leftArrow`, … | logical line start / end; grapheme left / right (→ at the end of the text accepts the ghost completion, 06 §6) |
| Alt+B / Ctrl+←, Alt+F / Ctrl+→ | `meta && 'b'`, `leftArrow && (ctrl \|\| meta)` | word left / right (`Intl.Segmenter` word granularity, `isWordLike`; punctuation `_ . /` separates words as in Claude Code 02 §3.2) |
| Ctrl+K / Ctrl+U; Ctrl+W / Alt+Backspace; Alt+D / Alt+Delete / Ctrl+Delete | `ctrl && 'k'`, `ctrl && 'w'`, `backspace && meta`, `meta && 'd'` | kill to end / start of the logical line; kill word back (`unix-word-rubout`, whitespace-delimited: one press removes a whole path); kill word forward — all into the kill ring |
| Ctrl+Y / Alt+Y | | yank newest kill / rotate the ring (only right after a yank) |
| Ctrl+T | | transpose the two graphemes around the cursor |
| Ctrl+_ (`0x1f`) / Ctrl+^ (`0x1e`) | `input === '\u001f'` / `'\u001e'` (raw C0 bytes, 08 §2.3) | undo / redo |
| Backspace (also Ctrl+H), Delete, Ctrl+D with text | | delete back / forward; a chip is removed whole |
| ↑ / ↓ | | move by visual row; on the first/last row (or cursor 0 / untouched buffer): history prev/next; ↑ on the first row with a non-empty queue takes the queue back (`unsteer`, A53, C22) |
| Ctrl+P / Ctrl+N; Ctrl+R | | history prev / next always; reverse-incremental history search (A7) |
| Tab / Shift+Tab | `key.tab`, `tab && shift` | accept ghost / next completion; previous completion |
| `/` at column 0 | | open the palette pre-filled (A34) |
| `@` | | open file mention (A35) |
| `?` on an empty composer, F1 | | help overlay (A21) |
| Ctrl+O; Ctrl+G; Ctrl+L | | append detail items to `<Static>` (A22); external editor via `suspendTerminal` (A11); erase-lines repaint (A8) |
| Ctrl+Z | `input === '\u001a'` | SIGTSTP self after restore; SIGCONT re-raws and repaints (A23) |
| Paste | `usePaste` | §4.5 |
| anything else printable | passes the §4.7 filter | insert |

Reserved and never rebindable (A24): Ctrl+C, Ctrl+D, Ctrl+M (= Enter), Ctrl+[ (= Esc), Ctrl+I (= Tab). Not bound in
v1: Ctrl+S (no stash), Ctrl+V (no image paste), Ctrl+P/Ctrl+K as palette (R8), a leader key (C16), `!` (C7).

### 3.5 Keybindings file

`${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` (P21 resolved to XDG with the config file):
`{ "bindings": [{ "context": "composer", "bindings": { "ctrl+g": "composer:externalEditor", "ctrl+t": "none" } }] }`.
Action ids are `namespace:action` from the registry (§5.1); values `"none"`/`null` unbind; chords are space-separated
keystrokes within 3 s (A24); unknown contexts/actions are warnings in `jevcode.log`, never fatal; reserved keys are
refused with a warning. Read once at start and on `/keys reload`.

---

## 4. Composer

### 4.1 TextBuffer model (`src/tui/composer/buffer.ts`, pure)

```ts
export interface Snapshot { readonly text: string; readonly cursor: number }
export interface ChipRef { readonly n: number; readonly lines: number; readonly bytes: number; readonly label: string } // label = `[Pasted #n, k lines]`
export interface TextBuffer {
  readonly text: string;                 // logical text; only `\n` and `\t` below 0x20; chips appear as their label text
  readonly cursor: number;               // UTF-16 code-unit index, always on a grapheme boundary and never inside a chip label
  readonly preferredX: number | null;    // sticky visual column for ↑/↓
  readonly undo: readonly Snapshot[];    // ≤ 100 (A1)
  readonly redo: readonly Snapshot[];
  readonly killRing: readonly string[];  // ≤ 16, newest first; survives submit for the process lifetime (A8)
  readonly yankIndex: number | null;     // set right after a yank so Alt+Y rotates; cleared by any other action
  readonly lastKill: 'append' | 'prepend' | null;  // consecutive kills concatenate (rluserman, 06 §4)
  readonly coalescing: boolean;          // consecutive printable inserts share one undo snapshot until whitespace/newline/motion
  readonly chips: readonly ChipRef[];    // bodies live outside (§4.5), never here
}
export type Motion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'wordLeft' | 'wordRight' | 'start' | 'finish';
export type BufferAction =
  | { type: 'insert'; text: string; paste?: boolean }        // text already filtered (§4.7); paste = one undo step, no coalescing
  | { type: 'newline' }
  | { type: 'backspace' } | { type: 'delete' }
  | { type: 'move'; to: Motion; columns: number }            // up/down need the wrap width
  | { type: 'kill'; what: 'toEnd' | 'toStart' | 'wordBack' | 'wordForward' }
  | { type: 'yank' } | { type: 'yankPop' } | { type: 'transpose' }
  | { type: 'undo' } | { type: 'redo' }
  | { type: 'setText'; text: string; cursor?: number; pushUndo: boolean }   // history recall, external editor, unsteer
  | { type: 'clear' }                                        // Ctrl-C / Esc Esc: snapshot pushed so C-_ brings it back
  | { type: 'chip'; chip: ChipRef };                         // insert a chip label as one atomic token
export function reduceBuffer(b: TextBuffer, a: BufferAction): TextBuffer;
export function graphemeBoundaries(text: string): Uint32Array;              // cached per text via one Intl.Segmenter (251 ns/grapheme, 12 §7)
export function wordBoundary(text: string, from: number, dir: -1 | 1): number; // Intl.Segmenter word granularity, isWordLike
```

Rules: `cursor` is moved only through `graphemeBoundaries` (invariant tested by the fuzzer, §19); chips are atomic — motions skip them,
Backspace/Delete/kill remove them whole and drop the `ChipRef`; `undo` pushes at most one snapshot per coalesced run; `kill` with `lastKill ===
'append'` appends to `killRing[0]`, `'prepend'` prepends, else unshifts a new entry; `yankPop` after `yank` replaces the yanked span with the next
older entry; `transpose` at the end of a line acts on the two preceding graphemes (readline).

### 4.2 `cellWidth` (`src/tui/composer/width.ts`, A2, 08 §8)

Replicates `string-width@8.2.2` for one grapheme cluster: (1) zero if the cluster matches
`/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v`; (2) 2 if
`/^\p{RGI_Emoji}$/v`; (3) 2 for keycap `^[\d#*]⃣$` and ZWJ sequences with ≥ 2 `\p{Extended_Pictographic}`; (4) 2 for Hangul L+V(+T); (5) else
EastAsianWidth of the first visible scalar with **ambiguous = narrow**, using a checked-in `eaw-table.ts` (125 Wide + 3 Fullwidth ranges, binary
search) generated by `scripts/gen-eaw.mjs` from the devDependency-visible `get-east-asian-width`; `\t` is expanded to spaces on insert (Ink ignores
tabs in width). `textWidth(s)` sums clusters; a fixture test compares 200 strings against `string-width` (A108). Cost: 18.9 µs per `stringWidth` call
today (11 §3.1) → the composer measures only the current visual row per keystroke.

### 4.3 Layout, viewport and cursor (`src/tui/composer/layout.ts`)

```ts
export interface Row { start: number; end: number; hard: boolean; cells: number }
export function layoutRows(text: string, columns: number, gutter = 2): Row[];   // split on \n, soft-wrap by summed cellWidth, break after spaces when possible, never inside a grapheme or a chip
export function cursorToRowX(rows: Row[], text: string, cursor: number): { row: number; x: number };
export function viewport(rows: number, cursorRow: number, height: number, scrollTop: number): number; // clamp(scrollTop, cursorRow − height + 1, cursorRow)
```

The composer box is `<Box height={layout.composer} overflow="hidden" flexDirection="column">` with exactly `height` `<Text wrap="truncate">` rows of
pre-sliced text (Ink never re-wraps them, A33); row 0 is prefixed `› ` and continuation rows `  `; gutter markers `↑N`/`↓N` right-aligned on the
first/last row when rows are hidden (A10). Cursor: `useCursor().setCursorPosition({ x: gutter + cursorX, y: composerTop + cursorRow − scrollTop })`
**during render**, where `composerTop` = rule + live + banner + pane + box + preview + queue + search + secret rows from the same `Layout` (A3, 08
§3); no inverse-block fake cursor (R10). `setCursorPosition(undefined)` while a box has focus, so the terminal cursor never sits in a field that is
not accepting text. DECSCUSR steady bar (`CSI 6 SP q`) once at start, reset to `CSI 0 SP q` in the exit string (A3, A80).

### 4.4 Composer state (outer reducer, `src/tui/composer/state.ts`)

```ts
export type ComposerFocus = 'composer' | 'palette' | 'mention' | 'history-search' | 'secret-gate' | 'note';
export interface ComposerState {
  readonly buffer: TextBuffer;
  readonly focus: ComposerFocus;
  readonly scrollTop: number;
  readonly history: { level: number; drafts: Map<number, Snapshot>; entries: readonly HistoryEntry[] };   // level −1 = live draft (03 §4)
  readonly search: { query: string; index: number; matches: readonly number[] } | null;
  readonly palette: { token: string; results: readonly ScoredCommand[]; selected: number; dismissedToken: string | null } | null;
  readonly mention: { start: number; query: string; results: readonly ScoredPath[]; selected: number; session: number } | null;
  readonly gate: { hits: readonly SecretHit[]; text: string } | null;   // §10.1
  readonly placeholder: string;           // rotates per submit among 3 examples (A9)
  readonly submitting: boolean;           // re-entrancy guard (A9)
  readonly interrupts: Interrupt;         // §3.3
}
```

Paste bodies (`Map<number, PasteBlob>`) and the wizard's key buffer are `useRef`s in the component, never in this state (A4, A114). `ui.json`
(`<runDir>/ui.json` or `~/.jevcode/sessions/ui-<pid>.json` before a run exists) persists `{ text: redactedDraft, cursor, chips: [{ n, lines, bytes,
sha256 }], theme, tab }` at checkpoint boundaries and on exit — never per keystroke (16 §4.3).

### 4.5 Paste lifecycle (A4, 16 §4.3, C10)

1. `usePaste(text)` (bracketed) or a multi-character `useInput` chunk without modifiers (paste-like, no timers, C21).
2. Normalise `\r\n` then `\r` → `\n`; `sanitizeStream` minus `\n\t`; strip bidi controls U+202A–202E and U+2066–2069; U+2028/U+2029 → `\n` (A88).
3. `> 1 MiB` → toast `paste of 3.2 MB refused (limit 1 MiB); write it to a file and @-mention it`; nothing inserted.
4. `> 3 lines || > 800 chars` → `chips.set(n, { text, lines, bytes, sha256 })` in the ref and `{ type: 'chip', chip }`; else `{ type: 'insert', text, paste: true }`. Below rows 12 the line threshold drops to 2 (02 §3.3).
5. At submit: `expandChips(text, ref)` in label order; a label whose blob is missing (after `--resume`) cancels with `remove [Pasted #1] or paste again` (16 §4.3); the `<Static>` `you:` item and history carry labels only.
6. A submission whose expanded text exceeds `PROMPT_LIMITS.taskChars` (12,000) appends the item `notice: only the first 12,000 characters reach the generator; @-mention a file for more` (P44 resolved per F9).

### 4.6 History (A7, A60, 06 §5)

- File `~/.jevcode/history.jsonl`, one line `{ t, workspace, kind: 'prompt' | 'steer' | 'command', text }` written through `redactor.redact` after
  `addSecret` (§10.2), chip labels only, 4 KiB per entry, 1,000 entries (atomic rewrite when compacting), consecutive duplicates dropped; off with
  `--no-history` / `JEVCODE_NO_HISTORY=1` / `ui.noHistory`; never written by bench/perf or by the wizard.
- In memory: entries filtered by `workspace` realpath; Ctrl-A in `history-search` widens to all workspaces.
- Navigation: `level −1` is the live draft; Up on the first visual row (or Ctrl-P) goes to `level + 1`, saving the current text/cursor in `drafts` so
  returning restores it (03 §4); Down past `−1` is a no-op; the cursor lands at the end.
- Ctrl-R: `search` row `(reverse-i-search)'que': 3 matches` above the composer; the composer shows the current match as a preview (dim); Ctrl-R older,
  Ctrl-S newer, Tab/→ accept and keep editing, Enter accept and submit, Esc/Ctrl-C restore the draft, Backspace on an empty query cancels (A7, 02
  §3.6).
- `/history clear` truncates the file after a `y/N` question.

### 4.7 Input filter (A5; applied before `insert`)

Drop when `key.ctrl || key.meta || key.super || key.hyper` (after the binding table consumed its keys), when `eventType === 'release' | 'repeat'`,
when any code unit `< 0x20` except `\t` (newline keys are handled before the filter) or `=== 0x7f`, and when the string matches
`/^\[(?:I|O|\?\d+[uc]|\d+;\d+R|27;\d+;\d+~|<\d+;\d+;\d+[Mm]|\?62;\d+c)$/` (focus, kitty reply, CPR, xterm modifyOtherKeys, SGR mouse, DA1
leak-through). A dropped CSI body increments a `key.filtered` counter in the trace (class only, §10.6). IME text (any multi-code-point chunk without
ESC) inserts verbatim (A92).

### 4.8 External editor (A11)

Ctrl+G / `/editor`: write the draft (chip labels kept) to `<runDir>/tmp/edit-<seq>.md` (or `os.tmpdir()/jevcode-edit-<pid>/` before a run) with mode
0600; `await useApp().suspendTerminal(() => spawnWait($VISUAL ?? $EDITOR ?? 'vi', [file], { stdio: 'inherit' }))`; engine events arriving during the
suspension are queued in the renderer and dispatched after `resume()` (08 §5, A11); on exit 0 read back, normalise, re-collapse unchanged chip labels,
`setText { pushUndo: true }`; non-zero exit → toast `editor exited 1; draft kept`; always `unlink`. Not available while a box has focus.

### 4.9 Submit routing (`src/tui/composer/submit.ts`)

```
onEnter():
  if submitting → return                                   // A9
  if focus = palette and results[selected] is an exact match → runCommand(...)          // A34
  if text starts with '/' (col 0) → dispatchSlash(text) ; unknown → item `error: unknown command /foo; type / to list commands` ; draft kept
  if text starts with '//' → text = text.slice(1)          // literal slash-leading prompt
  if text.trim() = '' → return
  if /^(exit|quit|:q)$/.test(text.trim()) → /exit           // A9
  full = expandChips(text) ; if missing chip → cancel
  hits = detectSecrets(full, redactor) ; if hits ≠ [] → focus = 'secret-gate' ; return   // §10.1
  send(full)
send(full):
  if state.live      → session.steer(full)  → item `steer queued (#2 for step 8): …` ; history 'steer' ; buffer cleared (undoable)
  else if session.last → followUp(full)     → §9.3 confirm may intercept ; else session.startRun(full, seedFrom(last))
  else               → session.startRun(full, null)
  history 'prompt' ; placeholder rotates ; submitting = false
```

While `state.live`, the composer's placeholder reads `steer the run… (Enter queues for the next step)`; while a review is pending the composer is
collapsed and inactive (row text in §2.4 D) — steering during a review requires `d` (note) or `n` first (item 19 of 00 §8 decided: no typing into a
collapsed composer, so a stray `y` can never approve).

### 4.10 Secret-gate row

`Looks like this contains a secret (sk-…). Send anyway? y/N` (yellow, `wrap="truncate"`, 1 row above the composer). Only `y`/`Y` sends; Enter, Esc,
`n`, `N` and any other key dismiss the row, keep the draft and are then processed normally (so a typist who keeps typing is not confirming, 16 §4.1).
Dismiss shows a one-frame tip `Tip: put it in .env and refer to it by name`. No timeout, no default-yes, never remembered (R38). Plain twin: readline
`jevcode: looks like this contains a secret (sk-…); type y to send, anything else to cancel:`; non-TTY cancels (exit 2).

---

## 5. Palette, slash-command grammar, `@` mention, fuzzy scorer

### 5.1 Registry (`src/tui/commands/registry.ts`, A16)

```ts
export type Availability = 'idle' | 'live' | 'any';           // idle = no run live; live = only while a run is live; review always blocks non-review keys
export interface ArgSpec { name: string; kind: 'run' | 'step' | 'setting' | 'usd' | 'int' | 'duration' | 'enum' | 'path' | 'text' | 'rest'; values?: readonly string[]; optional?: boolean }
export interface Command {
  id: string;                    // namespace:action, e.g. 'session:resume'
  name: string;                  // slash name without '/'
  aliases?: readonly string[];   // hidden from the list, matched on typing (A34)
  title: string;                 // one-line description shown in the palette
  category: 'session' | 'run' | 'jev' | 'files' | 'money' | 'config' | 'app';
  args: readonly ArgSpec[];
  available: Availability;
  keys?: readonly string[];      // bindings shown per row and in `?`
  hidden?: boolean;              // appears only when typed in full
  run(ctx: CommandContext, args: ParsedArgs): Promise<void>;
}
```

The same table feeds the dispatcher, the palette, the `?` overlay, the status-line ShortHelp, `jevcode keys`, the
`--plain` readline composer (`tui/plain-composer.ts`) and the generated `docs/KEYS.md` (sync test, §19).

### 5.2 Tokeniser and argument grammar (`src/tui/commands/parse.ts`)

- Input `/name arg…`; `name` = `[a-z][a-z0-9-]*`; aliases resolve first (`/quit` → `exit`, `/sessions` → `resume`).
- Tokens: whitespace-separated; `"…"` and `'…'` quote (no interpolation), `\` escapes the next char inside double quotes
  and at top level; `--flag` and `--flag=value` become options; `key=value` also becomes an option; everything else is
  positional. Commands with a `rest` argument (`/rename`, `/steer`, `/why`) take the raw remainder after the name,
  unparsed, trimmed, ≤ 600 chars.
- Validation per `ArgSpec.kind`: `run` = `RUN_ID_RE` **or** a unique title/prefix match in the index (ambiguous → list
  candidates); `step` = integer `1..state.step`; `setting` = one of the `/budget` names; `usd` = `> 0` number or `none`
  (session cap only); `int` = positive integer; `duration` = `parseDuration`; `enum` = one of `values`; `path` =
  workspace-relative, denylist checked; `text`/`rest` = free.
- Errors are transcript items, never a run: `error: /budget spend-cap: expected a positive number, got "abc"`,
  `error: /undo is idle-only (a run is live); Esc pauses first`, `error: unknown command /foo; type / to list commands`.
  The draft stays in the composer with the cursor at the end so a typo is one edit away.
- `availableDuringTask`: the dispatcher checks `available` against `state.live` before parsing arguments; `live`-only
  commands (`/pause`, `/abort`, `/unsteer`, `/steer`) error when idle; `idle`-only (`/undo`, `/rewind`, `/resume`,
  `/new`, `/model`, `/provider`, `/mode`, `/login`, `/logout`, `/history clear`) error when live; `any` run immediately.

### 5.3 Command table (one-line semantics; `avail` = idle | live | any)

| Command | Arguments | avail | Semantics | Source |
| --- | --- | --- | --- | --- |
| `/help`, `/?`; `/keys` | `[command]`; `[reload]` | any | help overlay (or one command's help as an item); keymap of the current context as an item, `reload` re-reads `keybindings.json` | A21, A16 |
| `/new` | — | idle | end the session; the next prompt starts a new session in this workspace; item shows the old session's total | A58, P48 |
| `/resume`, `/sessions`, `/continue` | `[id\|title]` | idle | picker (§8.4); with an argument continue that run (follow-up composer opens); `/continue` = most recently used run here | A56 |
| `/rename` | `<rest>` | any | set the session title (≤ 60 chars); index `rename` line; centre status zone | A64 |
| `/steer` | `<rest>` | live | explicit steer (same as Enter while live) | A53 |
| `/unsteer` | — | live | take the queue back into the composer (same as Up from row 0) | A53 |
| `/pause` | — | live | `engine.pause()`; status `pausing after step N` | A54 |
| `/abort` | — | live | `engine.abort('human_abort')` | A54 |
| `/undo` | `[n]` | idle | verify-before-write revert of the last committed step with `changedFiles` (§12.4) | A145 |
| `/rewind` | `[step] [files\|plan\|both]` | idle | undo steps last…N in reverse, or seed the next run with `planAfter`/window at N (§12.4) | A57 |
| `/diff` | `[step] [--full] [--all]` | any (`--full` idle) | inline numstat block; `--full` through the pager (§12.5) | A148 |
| `/plan`; `/decisions`; `/jev` | —; `[n] [stage]`; — | any | `<Static>` blocks: the ledger `[x] [ ] [?] [!]` with evidence; the last n Decision rows; decider id, resolved/drift, questions, latency p50/p95, Jev cost | A44, A58 |
| `/why` | `<sel>` (`s7.risk.plan_mismatch` or a digit) | any | `<Static>` block from `decisions.jsonl` (§7.4) | A47 |
| `/calibration` | `[--since <dur>]` | any | reliability table block (§7.4) | A47 |
| `/cost` | — | any | 12-row cost block (14 §5.4) | A137 |
| `/budget` | `[spend-cap\|session-spend-cap\|max-steps\|max-wall\|max-replans <v>]` | any | show or set; `spend-cap` → next `/resume` or next run; `session-spend-cap` immediate (§9.4) | A134 |
| `/model`, `/provider`, `/mode` | `<id>` / `anthropic\|openrouter` / `jev-on\|jev-off\|jev-only` | idle | apply to the next run only; recorded in the index as `budget`-style `override` lines | A58 |
| `/config` | — | any | `jevcode config` table as an item (fingerprints, sources, sandbox footer) | A126 |
| `/login`, `/logout` | `[--generator\|--jev]` | any | wizard re-entry at the missing field / atomic removal (§11.4) | A125–A126 |
| `/trust` | — | idle | reopen the trust gate | A122 |
| `/doctor` | `[--terminal]` | any | status block: keys, sandbox, Node, config path, terminal caps | A75 |
| `/export` | `[file]` | any | concatenated `transcript.log`s with run headers to `<file>` or `~/.jevcode/exports/<session>.log` | A61 |
| `/copy` | `[last\|proposal\|diff\|draft]` | any | redacted clipboard write (§10.5) | A86 |
| `/status` | — | any | run id, session id, step/max, stage, sandbox, workspace, git, stop reason | A58 |
| `/errors` | — | any | expand recent warnings/errors as items; clears the `!n` counter | A168 |
| `/report` | `[--include-requests]` | any | write `~/.jevcode/reports/<run-id>/` (§13.6) | A169 |
| `/theme` | `dark\|light\|daltonized\|ansi` | any | applies to new items and the dynamic region only (P20 resolved) | A97 |
| `/history` | `clear` | any | truncate `history.jsonl` after `y/N` | A60 |
| `/editor`; `/transcript` | — | any; idle | same as Ctrl+G; open the run's `transcript.log` in `$PAGER` via `suspendTerminal` | A11, A25 |
| `/exit`, `/quit`, `/q` | — | any | exit 0 (confirm if a run is live: `y` aborts first) | 17 §4.9 |

Not in v1: `/compact` (R21), `!cmd` (R22), `/share` (R23), `/model` mid-run (R21), `/redo` (F11), project command
files `.jevcode/commands/*.md` (A63, deferred to v1.x §22).

### 5.4 Palette behaviour (A34, 02 §3.5, 04 §5)

- Opens when `/` is typed at column 0 of an empty composer, or after a space mid-prompt when followed by ≥ 1 letter
  (mid-prompt commands are *not* executed — only the ghost completion of the name is offered; commands run only from
  column 0, as Claude Code documents).
- Empty query lists every available command in category order with its title and key alias; typing filters with the
  §5.5 scorer over `name` + `aliases` (aliases never displayed); `availableDuringTask` filtering hides unavailable
  commands; `hidden` commands appear only when typed in full.
- Rows: `≤ 8` including the footer `(i/N)  Tab completes · Enter runs an exact match · Esc closes`; `▲`/`▼` markers when
  scrolled; label column `≤ 50 %` of the width; description `wrap="truncate"`.
- Ghost text: the rest of the top match is rendered dim after the cursor with `+N` when more match; Tab inserts the
  only match or opens the list; → accepts the ghost. Enter runs the command only when the typed token equals a name or
  alias exactly (after Tab or when fully typed); otherwise Enter **keeps the draft** and reports `unknown command`
  (deviation from A34's "submits the typed text": §22 D1).
- Esc dismisses and remembers the token; the palette stays closed while that token is unchanged (Codex rule).
- Argument completion after the name: `run` → index rows (title + id), `step` → `1..N` with the action summary from the
  reducer's timeline, `setting`/`enum` → values, `path` → the mention list; Tab cycles, Shift+Tab back.

### 5.5 Fuzzy scorer (`src/tui/fuzzy.ts`, dependency-free, F17)

```ts
export interface Scored<T> { item: T; score: number; positions: readonly number[] }
export function scoreMatch(query: string, candidate: string): { score: number; positions: number[] } | null;
export function rank<T>(query: string, items: readonly T[], key: (t: T) => string, limit = 8): Scored<T>[];
```

Algorithm (case-insensitive, ASCII-fold of `_ - : /` to word boundaries): (1) empty query → all items, original order;
(2) exact name match → +1000; (3) prefix of the candidate → +500 − candidate.length; (4) prefix of a word inside the
candidate (after `_ - : / .` or a camelCase boundary) → +300 − wordIndex·10; (5) otherwise a greedy left-to-right
subsequence match; each matched char scores +10, +25 when it starts a word, +15 when adjacent to the previous match,
−1 per skipped char, −0.1 per candidate length; no match → null. Paths add a basename bonus (+40 when the query matches
inside the basename). Ties break by shorter candidate, then original order. Complexity O(|query| · |candidate|) per item;
the unit test ranks a 5,000-path fixture for 12 queries and asserts p95 ≤ 16 ms per query on the CI runner (Q30) and a
fixed expected ordering for `res`, `sess`, `bud`, `parse_date`, `tst/a` (word-boundary and separator cases).

### 5.6 `@` file mention (A35, A157)

- `@` opens `mention` at the token start; the query is the text after `@` up to whitespace; candidates =
  `engine.workspace.listCandidates()` when a run is live or a cached listing taken once per session after the first frame
  (the engine's candidate cache, C35), filtered by `isSecretPath` (never offered) and ranked by §5.5 with the basename
  bonus; one async search session per query with `AbortController` + 5 s timeout, stale results dropped (`session` id
  compared), a `waiting` state keeps the previous rows visible (04 §5).
- Enter/Tab inserts `@<rel>` (spaces escaped `\ `) followed by a space; the token stays in the text and is submitted as
  is: the context stage already counts `mentionsInTask` for candidate ranking (`CandidateView.mentionsInTask`,
  `prefilterCandidates`), so a mention raises the file's chance of selection with zero engine change (P8 resolved:
  score-and-boost, no bypass of the `p ≥ 0.5` selection).
- A fully typed denied path shows `.env is on the secret denylist; JevCode never reads it. Start with
  --allow-secret-mention to override.` and the mention token is dropped (the literal word stays); with the flag, a
  per-mention `Attach anyway? y/N` row and `workspace.readSecretForMention(rel)` (§10.4).

---

## 6. Review prompt

### 6.1 Rows (header 8; `lines()` shared with `--plain`; 11 §4b)

Row 1 title: `review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"` (120 columns add `(tail on plan_mismatch)`, the
quoted goal untruncated and `jev 244ms`). Row 2 keys (always row 2 so it survives truncation at rows 12, A39): `[y] approve  [n] decline  [d]
decline+note  [e] expand  [w]+1-5 why  [esc] decline` (120: `[e] expand preview … [ctrl-c] abort run`). Row 3 ruler: `dimension     lvl 0  ┆   ┆ 1
risk bnd  conf  Jev's dominant level (why)` — `┆` in bar cells 3 and 7 marks the 0.3/0.7 bands under `NO_COLOR`; with colour the track is dim (cells
0–2), yellow (3–6), red (7–9). Rows 4–7: the four dimensions **sorted by risk descending** so truncation at rows 8/12 keeps the dominant one
(deviation from 11 §4b's fixed order, §22 D2): `plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step`. Row 8:
`matches_intent    ████████▊·  0.88 noul 0.76~ the action is an instance of the intent`. At 120 columns rows 3–8 add `P(l)  E[k]  tail` columns (11
§4b). Preview rows (≤ 8, `e` = the rest of the budget with pane → 0) are today's `confirmPreviewLines` indented two spaces, last row `…[N more preview
lines · e expands]`.

Bars: 10 cells, eighth blocks `▏▎▍▌▋▊▉█` over a `·` track (`#`/`-` under `--ascii`, A90); the digit after `w` picks a row 1–5 in the displayed
(sorted) order. Numbers two-decimal; `~` marks derived Noul confidence (A43).

### 6.2 Keys and invariants (F6, A39–A41)

| Key | Effect |
| --- | --- |
| `y` | `confirmer.resolve(id, true)`; item `confirm <id> approved` (existing) |
| `n`, Esc | `resolve(id, false)`; outcome `declined by reviewer: <risk reason>` (existing engine text) |
| `d` | focus `note`: the composer row becomes `note › ` (single line, ≤ 600 chars, chips disabled); Enter → `resolveDetailed(id, { approved: false, note })`; Esc → back to `review` |
| `e` | toggle `expanded` (preview takes the pane's rows; `e` again collapses) |
| `w` then `1`–`5` (≤ 1.5 s) | append the `/why` block for that gauge row to `<Static>` (§7.4); the box stays |
| Ctrl-C | decline **and** abort (§3.2) |
| anything else | ignored; status toast `review pending: y n d e w · Esc declines` |

Invariants: no Enter default, no highlighted default, no remembered/always/session approval, no approve-on-timeout, no `--auto-decline` flag (F6, R17,
P5 rejected); the non-TTY confirmer still declines after `confirmTimeoutMs`; the bench's `alwaysDecline` is untouched; a second `confirm:request`
while one is pending declines the first (`createTuiConfirmer`, kept); the spinner is frozen while a review is pending (A50); a typed-ahead `y` cannot
approve because the box is **deferred**: it renders (and `review` takes focus) only after `now − lastKeyAt ≥ 1000 ms` **and** Ink's pending-input
buffer is drained (a `setTimeout(0)` after the last `useInput` call); until then the status zone shows `review pending…` and keys go to the composer
as usual (A41, 04 §8). The composer collapses to one row for the box's lifetime (F3).

### 6.3 Decline-note path to Jev and the generator

`TuiConfirmer` gains `resolveDetailed(id, outcome: ConfirmOutcome)`; the engine calls `confirmer.confirmDetailed?.(req, opts) ??
confirmer.confirm(req, opts)` (§15 C18). On `{ approved: false, note }`: `note` is `clip(redact(oneLine(note)), 600)`; the declined reason becomes
`declined by reviewer: <risk reason>; reviewer note: <note>` (window `reason`, ≤ 600 after clipping the risk text first) **and**
`draft.notes.push(\`reviewer note: ${note}\`)` so `WindowEntry.notes` carries it into `recent[i].notes` of every later Jev state (`recentJson`) and
into the prompt's `note:` lines (P6 resolved: 600 chars, Jev sees it). The item reads `confirm <id> declined with note: <note>`; `confirm:resolved`
gains `note?: string` (redacted).

### 6.4 Plain and screen-reader twins

`--plain` TTY: header lines one per dimension `[step 7] confirm … plan_mismatch L2 risk=0.44 tail c=0.61 "skips a planned verification step"`, preview
≤ 20 rows, prompt `[step 7] [y] approve  [n] decline  [d] decline+note > `; `d <note>` on the same line; `yes`/`no` accepted; five invalid answers
decline (`READLINE_MAX_PROMPTS`, kept). Non-TTY: declines after the timeout. Screen reader: numbered list `1 approve 2 decline 3 decline with note` +
`Enter selection (1-3):` as `<Static>` lines, one BEL, no gauge rows (bars → `aria-label="risk 0.44 of 1"`), announced once (A95).

---

## 7. Jev-native pane and status line

### 7.1 Tabs (A44, 11 §4a–4f)

The rule row: `── decisions  s7 ─────────── [d] decisions  [p] plan  [t] time  [s] synth ──` (active tab bold; `[` / `]` cycle; the letter keys switch
only when the composer is empty and no box has focus — otherwise they are text). Content rows ≤ 12, `<Text wrap="truncate">`, built by `lines(state,
columns, theme)` functions shared with `--plain` (`--plain --decisions`, `--plain --plan`, `--plain --timing`) (A49).

| Tab | Row format (80 columns) | 120-column additions | Data |
| --- | --- | --- | --- |
| `d` decisions | `s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]` — stage 8, id 16, answer 6, bar 10, `p` two-decimal, `c` two-decimal with `~` for derived Noul confidence, verdict marker | `244ms` latency and the chosen option / level text truncated | `decision` events, last 12 (`DECISIONS_KEPT`) |
| `p` plan | header `plan  done 2  remaining 3  unverified 1  problems 2  (accept ≥ .7, reject < .3)`, then `[x] add failing test for parse_date   s4  done_0 0.91`, `[?] update CHANGELOG   s7  done_1 0.52  unverified`, `[ ] run full suite`, `[!] replan s6 change_approach: …`, `[!] human s8: also update the CHANGELOG` | evidence column `tests 41p/0f/0e`, `openProblems` right column | `plan` events |
| `t` timeline | two rows per step, newest first: `time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s` / `      s7  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 8.2s  h 31ms` (letters sized `round(ms/total·40)`) | one row per step with `gen 5.4k  $0.032` | `stage:end`, `step:end.record.timing/usage` |
| `s` synth | `synth  goal 2/3 test_kth kth.py  site kth.py:12  SEEDS mutation d1 → templates` / `sieve  verify  tested 37/137 ██▋·······  27%  t_run 0.9s x8 lanes  runs 41 jev 3` | ledger `fixed 1 open 2 parked 0`, queue key, test command | `synth` events; structured fields are an additive extension coordinated with the synth team (A48) — until then rows render `detail` verbatim and the one `synth <phase>: <detail>` transcript line per event is unchanged |

Under 80 columns probabilities and confidence are hidden, verdict words kept (A100). Every bar cell is width 1 (11 §3.1); under `--ascii` the bar is
`#` on `-`; under `--screen-reader` rows are the plain twins with `aria-role`.

### 7.2 Loop banner (A45)

One row between live and pane, only while a signature count is ≥ 2 or a replan directive is active: `loop  run:pytest
-q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12`; counts come from `step:end.record.loopSignatures` in the reducer (reset on `replan`),
`maxReplans` from the extended `run:ready` (§15 C10).

### 7.3 Status line (A46, 14 §5.1, 15 §6.2, 17 §4.1)

Three zones, helix layout, `<Spacer>`, `truncate-middle` on the centre: **left** `step 7/40  ⠹ risk 12s` (sentinel first, always; the spinner is the
stage verb + elapsed, `still waiting` after 45 s, frozen while a review is pending, `•`/`◦` in reduced motion, `working` in SR mode) then words/badges
in order `retrying 2/3` · `offline` · `paused: <reason>` · `disk ×N` · `!n` · `sandbox: none`/`no-net`; **centre** run title (or run id) in session
mode; **right** `wall 4m12s/30m` (≥ 100 cols) · `run $1.60/2.00 high` · `sess $4.11/10.00 ok` (level words `ok`/`half`/`high`/`critical`/`over`
/`uncapped`, never colour alone) · git zone `⎇ main ↑2 · 3~ 1?` (≤ 24 cells at ≥ 100, ≤ 14 below, hidden < 60) · Jev sparkline `jev ▂▃▂▅▂▂▇▃▂▁▂▃` (≥ 100 cols, `p50 237ms` label at ≥ 130, last 12 requests, fixed 0–1000 ms scale, blank for a failed attempt) · 10-cell meters at ≥ 120 · tokens `gen 5.5k jev 28k`
at ≥ 140 · `? help` (`? help · / commands` at ≥ 120). Toasts replace the left zone for 2 s (4 s errors) with `!`/`✓` markers and also land as items
(A37). The idle redraw is 1 Hz; reduced motion keeps that functional tick (A96).

### 7.4 `/why` and `/calibration` blocks (A47, 11 §4h–4i)

`/why s7.risk.plan_mismatch` (or `w`+digit) appends one item with a multi-line `detail` (≤ 60 lines): header `[step 7] why risk.plan_mismatch  request
a1b2c3d4  244ms  jev-1.13-20260917`, the question text, one bar row per level `L2 █▏········  0.10  skips a planned verification step`, then `argmax
L0 p=0.62  E[k]=0.56→0.14  P(k≥3)=0.04  bound=tail risk=0.04 [ok]`, the confidence formula line, and the rule consumed. Nouls show
`criteria.true/false` definitions and `|2p−1|`; Choices one bar per option with the paired Noul and the resolution rule
(`chosen`/`overridden`/`fallback`). `/calibration` reads `~/.jevcode/runs/*/decisions.jsonl` + `steps.jsonl` (+ bench `tasks.jsonl`) and appends the
reliability table of 11 §4i (bins, `n`, mean p, observed, ECE, near-threshold counts, sharpness); `jevcode calibration` prints the same block offline.
Both are pure functions over records — zero engine change.

### 7.5 Ctrl+O detail appends (A22)

Ctrl+O appends, as items: the last decision's full probabilities/criteria (one block), then the recent warnings/errors (clearing `!n`). Never resizes
or remounts the pane.

---

## 8. Sessions, steering, pause, history, export, `--json`

### 8.1 Data model (A52, 10 §15.1)

Run = today's run (one task, one run dir, one `CheckpointState`). Session = ordered runs in one workspace realpath + human events; `sessionId` = first
run id. `RunMeta` gains `sessionId`, `parentRunId`, `source`, `title?`, `git`, `instructions[]` (§15 C7). A follow-up is a **new** run seeded from the
parent; a finished run's checkpoint is never mutated (R21).

### 8.2 `~/.jevcode/sessions/index.jsonl` (A55; append-only, ≤ 512-byte lines, `O_APPEND`, torn last line skipped)

```ts
export type IndexLine =
  | { t: string; kind: 'run:start'; sessionId: string; runId: string; parentRunId: string | null; workspace: string; task60: string; mode: EngineMode; source: 'cli' }
  | { t: string; kind: 'run:end'; sessionId: string; runId: string; stopReason: StopReason; steps: number; costUsd: { generator: number; jev: number }; wallMs: number; changedFiles: number; exitCode: number }
  | { t: string; kind: 'rename'; sessionId: string; title: string }
  | { t: string; kind: 'steer' | 'undo' | 'pause'; sessionId: string; runId: string; step: number; text60?: string; files?: number }
  | { t: string; kind: 'budget'; sessionId: string; setting: 'session.spendCapUsd'; from: number; to: number }   // A134
  | { t: string; kind: 'override'; sessionId: string; setting: 'generator.model' | 'generator.provider' | 'mode' | 'limits.spendCapUsd' | 'limits.maxSteps' | 'limits.maxWall' | 'limits.maxReplans'; to: string };
export function foldIndex(lines: readonly IndexLine[]): Map<string /* runId */, RunRow>;   // last wins per runId; sessions grouped by sessionId
```

Written only for `source === 'cli'`; `text60` passes `redact`; `jevcode sessions reindex` rebuilds it from `run.json` + `stat(state.json).mtime`;
`jevcode sessions prune --older-than 30d` is explicit; `run.lock` (`<runDir>/run.lock` with pid + start time, stale if the pid is dead) refuses a
second resume with `run <id> is open in pid 4242 (started 2h ago); pass --force-lock if that process is gone`. Folded once per session open, `run:end`
and `budget:override`, kept in memory (A139). Concurrency (P11): lines ≤ 512 B under `O_APPEND` are atomic on POSIX; no lock file.

### 8.3 Picker (A56, 10 §15.6)

Data: the fold only; `state.json` of the selected row parsed on `Space` (preview: plan counts, spend, stop, interrupted) plus a 4 KB tail of
`transcript.log`; never `steps.jsonl`. Row: `time ago │ steps │ stop (verdict colours + word) │ $cost │ title-or-task60 │ run id (≥ 100 cols) │
workspace basename when widened`. Keys: `↑/↓` `Ctrl-P/N`, `PgUp/PgDn`, Enter (continue: `resumeRun` when `stopReason` is resumable and the head
matches, else follow-up composer over the seed), Space preview, `/` or typing filters (title, task, id), Ctrl-A all workspaces, Ctrl-R rename, `x`
then `y` delete (moves the run dir to `~/.jevcode/trash/`; never for `source !== 'cli'`), Esc. Sort: updated (default) / created (`s` toggles).
`-c/--continue` = most recently *used* run in this workspace (last `run:end` or `steer`/`pause` line). `--resume <id|title>` accepts a run id or a
unique title/prefix; on a different `git.head` it warns (P52: warn).

### 8.4 Follow-up seeding algorithm (A52, 10 §15.2; `src/cli/seed.ts`)

```
seedFrom(parent: { meta: RunMeta; state: CheckpointState }, followUp: string, reverted: UndoLogEntry[]): { seed: RunSeed; humanDirective: string }
  plan  = { done: state.plan.done, remaining: state.plan.remaining, unverified: state.plan.unverified }   // openProblems dropped (generator-owned)
  window = state.window.slice(-4).map(e => ({ ...e, notes: [...e.notes, `from run ${meta.runId}`] }))
  createdThisRun = state.createdThisRun ; lastTestRun = state.lastTestRun       // engine sets lastChangeStep = null → testsCurrent recomputed honestly
  humanDirective = `follow-up of run ${meta.runId} ("${clip(meta.task, 200)}"): ${followUp}` + (reverted.length ? ` — human reverted step(s) ${…}: <files>` : '')
  seed = { parentRunId: meta.runId, plan, window, createdThisRun, lastTestRun, reverted }
```

Engine at init with `opts.seed`: `plan = { ...seed.plan, openProblems: [], harnessProblems: [{ kind: 'human', text: humanDirective, step: 0 }] }`;
step 1 treats the human problem as "a replan directive was issued this step" for Plan rule (b) so obsolete `remaining` items may be dropped; the run's
`task` is the follow-up text; the completion Noul judges the new task (F7; P7 resolved: follow-up alone, the seed carries the history). Spend, wall,
loop detector and `resolvedJevModel` start fresh.

### 8.5 Steering: engine consumption algorithm (A53, 10 §15.3; exact insertion in `engine.ts`)

```
steer(text):  // Engine method, called from the renderer thread between events
  if lastResult !== null → throw StateError('run finished')            // the CLI routes to followUp instead
  t = clip(redact(oneLine(text)), 600); if pendingDirectives.length ≥ 8 → return { queued: 8, index: -1 } + emit transcript warn 'steer queue full (8)'
  pendingDirectives.push({ text: t, at: nowIso(), index: ++seq }); emit { type: 'steer:queued', step: this.step + 1, index, text: t }
  // the queue is persisted with the next checkpoint (commit) and by writeStateSync on exit; no extra write here
  return { queued: pendingDirectives.length, index }
unsteer(): texts = pendingDirectives.map(d => d.text); pendingDirectives = []; emit transcript info `steer queue taken back (${n})`; return texts
pause(): pauseRequested = true; emit transcript info 'pause requested: stopping after the current step'; emitStatus()

main() loop (engine.ts:559-571), after `checkBudgets` returned null and BEFORE `runStep()`:
  if (this.pauseRequested) return this.finish('human_pause');
  if (this.pendingDirectives.length > 0) this.applyPendingDirectives(this.step + 1);
applyPendingDirectives(step):
  const texts = this.pendingDirectives.map(d => d.text); this.pendingDirectives = [];
  this.plan = { ...this.plan, harnessProblems: [...this.plan.harnessProblems.filter(h => h.kind !== 'human'), ...texts.map(text => ({ kind: 'human', text, step }))].slice(-PLAN_MAX_HARNESS_PROBLEMS) };
  this.activeHumanDirective = texts.join('\n');          // consumed by promptInput(), commonState(), synthesisContext() of this step, then cleared at commit
  this.detector.resetCounts();                           // new LoopDetector method: counts = {}, lastSignature = null, tripped = false; trips history kept
  this.emit({ type: 'steer:applied', step, count: texts.length });
```

Where the directive reaches each consumer: `promptInput()` (`engine.ts:1176`) sets `humanDirective: this.activeHumanDirective` → `hintsSection`
renders `Human directive (from the reviewer; it takes precedence over the plan's order): <text>` after the replan line; `commonState()`
(`engine.ts:1148`) passes `humanDirective` → `buildCommonState` emits `humanDirective` (present only when non-null) so the intent/risk/judge states
see it (P1: yes, Jev sees it); `synthesisContext()` (`engine.ts:861`) sets `directive: [draft.directive?.text,
this.activeHumanDirective].filter(Boolean).join('\n') || null`. This is the one plan mutation outside `commit()`; it happens at a rule-1 point with
`draft === null`, so a checkpoint written by `finish()` afterwards is whole (§9.1). `y`/`n` during a review and slash commands are never steers.

### 8.6 Pause (A54)

`human_pause` is a `StopReason` of the exit-4 family; `storedStopBlocks` treats it like `null` (resumes normally); the status zone shows `pausing
after step N` until the boundary; the `run:end` item says `end human_pause steps=N …` and the composer reopens; `--resume`/picker continue it without
`--force`.

### 8.7 `history.jsonl`, `planAfter`, `/export`, `/theme`

History per §4.6. `StepRecord.planAfter` (bounded 20 × 200 per list) is written at commit so `/rewind N plan` can seed from step N without replaying
drafts (P10 resolved: record it, ~4–8 KB per step). `/export [file]` concatenates the session's runs' `transcript.log` in order with `==== run <id> ·
<task60> · <stopReason> ====` headers (already redacted). `/theme` changes the theme object used by new items and the dynamic region; committed items
keep their colours (P20). Pending `/budget spend-cap` values live in memory only (P46: die with the session).

### 8.8 `--json` stream (A61, A138, A158, A170; `src/cli/json-stream.ts`)

First line `{"type":"stream:start","schema":1,"jevcode":"<version>","redaction":"every string passed config.redact; secrets, Send-anyway values and
recognised formats appear as [REDACTED:<name>]; no keystrokes, drafts or paste bodies"}`. Then `session:start { sessionId, runId, parentRunId,
workspace }`, one `user { text }` per submitted human turn (redacted, chip labels), every `EngineEvent` (already redacted at `emit`),
`steer:queued`/`steer:applied`, `budget:*`, `retry`, `retry:settled`, `notice`, `workspace`, `secret-ack { count }` (count only, P59), `run:end` with
`exitCode`, `paths`, `resumable`, and `session:end { reason, exitCode }`. Consumers ignore unknown `type`s; `schema` increments only on a breaking
field change; no countdown ticks (the `retry` line carries `waitMs`).

---

## 9. Money

### 9.1 Meter tree (A129–A130)

`session.meter = createSpendMeter(sessionCapUsd)` once per session (`none` = `+Infinity`); every run gets `session.meter.child(min(runCapUsd,
remaining))` where `remaining = sessionCap − sessionSpent` (folded from the index at session open, then kept in memory);
`SpendSnapshot.parentExceeded` (§15 C11) distinguishes a run stopped by its own cap from one stopped by the session cap (`by: 'session'` in the
epilogue). Default session cap = 5 × run cap: $10.00 for the $2.00 default, $1.25 for jev-only's $0.25 run default (mode-keyed in `resolveConfig`
after `--mode` is known, P45). On `/resume`: fold the index for the `sessionId`, add the resumed run's `state.json.spend`, then `restore()` the child.
Bench/perf keep their own root meters.

### 9.2 Thresholds (A131)

`budget:warn { scope: 'run' | 'session'; pct: 50 | 80 | 95; spentUsd; capUsd; stepsLeftEstimate }` once per threshold per scope, highest only when one
`add()` crosses two, re-emitted with ` (restored)` on resume, never for `+Infinity`. Surfaces: item `[run] budget: run spend $1.600 is 80 % of the
$2.000 run cap — about 10 steps left at $0.040/step` (+ ` — Jev is the larger share ($0.031 vs $0.020); see /jev` when it is), 2 s toast (4 s at 95
%), meter word `half`/`high`/`critical`, opt-in BEL/OSC 9 only at 95 % and `budget:stop` when notifications are on. `ui.budgetWarnings=false` mutes
toast and bell only. No 95 % pre-emption (F8, P47 rejected).

### 9.3 Follow-up confirm (A132)

At `send()` when `state.done !== null`: `remaining ≥ runCap` → start; `0 < remaining < runCap` → box (frame §2.4 H): `y` start with the child cap
clamped to `remaining` (item + `budget:clamp`), `r` prefill the composer with `/budget session-spend-cap <sessionCap + runCap>`, `n`/Esc cancel (draft
kept), Enter inert; `remaining ≤ 0` → refuse with the item `[run] session cap reached ($10.31 of $10.00). Raise it with /budget session-spend-cap
<usd>, or /new for a fresh session with its own cap.` + 4 s toast. `--plain`/`--json`/`--no-input`: clamp silently + `budget:clamp`, or exit 4 +
`budget:stop { scope: 'session', at: 'follow-up' }`.

### 9.4 `/budget` (A134, C45)

`/budget` alone prints run cap, session cap, spends, pending values. `/budget spend-cap <v>` (must exceed the target run's spend) applies to whichever
comes first: the next `/resume` of the stopped run (through `reconcileResumeConfig`, recorded in `run.json.overrides[]`) or the next new run (`source:
'session:/budget'`), never a live run. `/budget session-spend-cap <v|none>` applies to the root meter immediately and appends a `budget` index line.
`max-steps`, `max-wall`, `max-replans` follow the `spend-cap` rule. The `spend_cap` epilogue in session mode adds `continue this run: /budget
spend-cap 3.00 then /resume` and `or start a follow-up run with a fresh $1.500 cap` (A133).

### 9.5 Unknown pricing fails closed (A135–A137)

`validateGenerator` returns `priced: boolean`; `provider === 'anthropic' && !priced` refuses to start (exit 2, `ConfigError` on `generator.model`)
with `generator.model "x" has no pricing entry; set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M, or pass --allow-unpriced to run under a token
cap` — the flag is named in the refusal (item 32 of 00 §8). `--allow-unpriced` → `limits.maxGeneratorTokens` (default `spendCapUsd / 15 × 1e6`, Q40
conservative), budget kind `token_cap` after `spend_cap`, `StopReason 'token_cap'`, figures `$?`. OpenRouter/Jev `usage.cost` null or non-finite →
`budget:unpriced` and stop `error unpriced_usage` after the step commits unless `--allow-unpriced`. `config.warnings` are printed (item in the TUI,
stderr line in plain) (A136). `~` marks table-priced figures; `jevcode config` prints `session.spendCapUsd  $10.000 (default: 5 × run cap)`.

---

## 10. Secrets

### 10.1 `detectSecrets` (A153; `src/core/redact.ts`)

```ts
export interface SecretHit { family: string; label: string; start: number; end: number; exactName?: string }
export const WARN_ONLY_PATTERNS: readonly { family: string; re: RegExp }[];   // AWS, Slack token + webhook, PEM `PRIVATE KEY`, JWT, Stripe, npm_, hf_, glpat-
export function detectSecrets(s: string, exact?: Pick<Redactor, 'redact'>): readonly SecretHit[];
```

Families: the six `FORMAT_PATTERNS` (redacting) + warn-only families (C44 staging); `HEADER_PATTERN` excluded (9/9 FP); `exact` present and
`exact.redact(s) !== s` → a hit labelled `your <NAME>`. Labels ≤ 6 secret characters: `sk-…`, `sk-proj-…` labelled **OpenAI** (`sk-proj-… (OpenAI)`,
P55 resolved), `sk-ant-…`, `AIza…`, `ghp_…`, `github_pat_…`, `AKIA…`, `xoxb-…`, `-----BEGIN…`, `eyJ…`, `npm_…`, `glpat-…`. Runs on every buffer change
(dim `⚠ secret?` at the end of the status row; < 0.001 ms at 2 KB) and at Enter to gate (§4.10); also on steers and on `/steer`, `/rename` text.

### 10.2 `addSecret` on `y` (A155–A156)

Before the text leaves the composer: for each hit span ≥ 8 chars, `redactor.addSecret(\`composer#${n}\`, span)` (PEM: the whole block via the
end-anchored form); markers `[REDACTED:composer#1]`; cap 64 composer entries (oldest evicted with `dropSecret`). The provider request stays raw by
design (`PromptInput.task` is not redacted, kept); the audit record is the item `[turn n] sent 1 secret (sk-…) to the generator on request` and the
`secret-ack { count }` event. Scope = process; documented as not surviving `--resume` (P56: accept and document).

### 10.3 Chips, history, `ui.json`

§4.5 and §4.6; chip bodies exist only in the `useRef` Map (never state, reducer, events, logs, `ui.json`); history and `ui.json` store labels `[Pasted
#1, 120 lines, sha256:9f86d081]` — the history chip label is the redacted first line clipped to 40 chars plus the line count (`[Pasted #1: "GET
/api/v1/key HTTP/1.1…", 120 lines]`, P58 resolved).

### 10.4 `@` denylist (A157)

`isSecretPath()` gains `/credential/i` on the basename, `.npmrc`, `.pypirc`, `/\.(p12|pfx|jks)$/i`, and an `@`-only `rel.startsWith('.git/')` rule;
completion never offers a denied path; `--allow-secret-mention` / `JEVCODE_ALLOW_SECRET_MENTION=1` enables the per-mention `Attach anyway? y/N` row
and `workspace.readSecretForMention(rel, 16_384)`, `addSecret`ing every `SECRET_NAME_RE` line as `mention:<KEY>` and PEM bodies whole; the generator's
own `read` keeps `SecretPathError`.

### 10.5 Clipboard (A86)

`/copy [last|proposal|diff|draft]`: payload = `redact(sanitizeStream(x))`, 64 KiB cap; native tool first (`pbcopy`, `wl-copy`, `xclip -selection
clipboard`, `xsel --clipboard --input`), OSC 52 **write** only behind `--osc52`/`ui.osc52` (tmux DCS wrapper), never OSC 52 read; `/copy draft`
reports `copied with 1 secret masked`.

### 10.6 Trace and logs (A12, A168)

The `JEVCODE_TRACE` keystroke line becomes `key kind=<return|backspace|ctrl|escape|text|paste|filtered> len=<n> masked=<bool>` unconditionally, folded
into the per-run `jevcode.log` at level `trace`; `usePaste` logs `len` only; the wizard field logs `key masked len=1`.

---

## 11. Onboarding, credentials, trust, `AGENTS.md`

### 11.1 Probe and wizard (A113–A121, A128; `src/tui/onboarding/*`)

After the first frame `config.missingSecrets(mode)` (non-throwing, §15 C13) returns `['generator.apiKey']`, `['decider.apiKey']`, both or `[]`; skips
the generator key under `--mode jev-only` or `--mock*`. Non-empty → the wizard box (≤ 4 rows) with focus `wizard`, composer hidden:

```
detect ─missing=[]─▶ trust? ─▶ sandbox line ─▶ composer
  │ missing≠[]
  ▼
provider (1 anthropic · 2 openrouter; skipped when the generator key resolves or mode=jev-only; pre-selected from --provider/JEVCODE_PROVIDER)
  ▼ generatorKey (masked; ≥ 8 chars; prefix hint sk-ant-/sk-or-v1- warns, never blocks)
  ▼ jevKey (masked; provider=openrouter and a key was just entered → "Enter = reuse it for Jev")
  ▼ save → addSecret FIRST → items `[setup] generator key: entered (sha256:e31150e9) source=wizard`, `[setup] saved ~/.config/jevcode/config.json (mode 0600, dir 0700)` → clear the ref
  ▼ verify? ([y] GET openrouter.ai/api/v1/key ($0) · GET api.anthropic.com/v1/models ($0) · 1 Jev decision (~$0.0001) using decider.model; [n]/Enter skip; 5 s AbortSignal.timeout chained to Ctrl-C; a rejected key returns to its field)
  ▼ trust (§11.3) ▼ sandbox (one item, bold on first run) ▼ composer (or the argv task)
```

Masked field: `<Text>` bullets `'•'.repeat(min(len, columns − 3))` (`*` under `--ascii`) + `useCursor` + `usePaste` + the one `useInput`; buffer in a
`useRef<string>`; reducer state holds `{ field, length }` only; a multi-character chunk is a paste; `sanitize` = `sanitizeStream` + strip all
whitespace + NFC; paste never submits; Backspace/Delete drop one code point; Ctrl-U clears; Esc clears or steps back; Ctrl-C prints the fix block and
exits 2. Persistence: `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`, read + merge (`provider`, `apiKey?`, `jevApiKey?` only),
`writeFileAtomic(…, { mode: 0o600, mkdir: true })`, `chmod` file 0600 / dir 0700; both the legacy `~/.config/jevcode` path and `$XDG_CONFIG_HOME` are
checked, XDG preferred, one warning when both exist (P30); `./jevcode.json` present → warn that it wins for non-secret keys; `resolveConfig` re-runs
after `saved`; Windows prints the ACL note instead of chmod (P41). Never writes `./.env` or `./jevcode.json` (A118). Frames: §2.4 G and 13 §5.2.

### 11.2 Shadowing, non-TTY, CLI twins (A120, A124–A125)

One item at every start when a secret resolves from env/dotenv and the file holds a different fingerprint: `[config] generator.apiKey: env
ANTHROPIC_API_KEY (sha256:…) overrides file … (sha256:…) — unset the variable to use the saved key`; `set but empty — treated as unset`. Non-TTY /
`--plain` on a pipe / `CI` / `--no-input`: today's `ConfigError` line then the four-line fix block (`export ANTHROPIC_API_KEY=…`, `export
JEV_API_KEY=…`, `printenv … | jevcode login
--jev-key-stdin`, `jevcode login`) and `Keys are never accepted as command-line arguments in the interactive flow`, exit 2. `jevcode login
[--provider] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]` (raw-mode masked byte loop on a TTY, one line per flag on a pipe),
`jevcode logout [--generator] [--jev]`, `jevcode config set <non-secret>`. `--no-input` also suppresses the trust gate, the follow-up confirm (clamp),
the secret gate (cancel) and review prompts (decline) (C46).

### 11.3 Trust gate (A122; D6)

First interactive run per git root (realpath of the git root, else the workspace; `$HOME` never persisted): `Do you trust the files in /Users/x/repo?
(git root; decision stored per repository)` listing `AGENTS.md (2.1 KiB) → generator system prompt`, `./.env (3 vars, 2 secret-looking) → config`,
`jevcode.json (none)` by size/count, never values; `1 trust · 2 this session only · 3 don't trust`. Stored in `~/.jevcode/trust.json` (0600; P39:
inside the seatbelt-protected tree) as `{ "<gitRoot>": { decision, agentsSha256, at } }`; a changed `AGENTS.md` sha256 re-prompts; `3` → instruction
files ignored and `run.json.instructions = []`, `./.env` still read with the `dotenv: <path>` source line shown in the item stream (P38: keep reading,
show the source); `--trust-workspace` for scripts; `/trust` reopens.

### 11.4 `AGENTS.md` (A59) and `/login` rotation (A126)

First match walking up from the workspace realpath to the workspace root, `CLAUDE.md` fallback, then `~/.config/jevcode/AGENTS.md`; 32 KiB cap; `{
path, sha256, bytes }` recorded in `run.json.instructions[]`; redacted and injected into the generator **system** prompt as `## Project instructions`
(never into Jev state); read once per run after the first frame. `/login` re-enters the wizard at the missing field while a run may be live behind it
(the box takes the pane's rows first); on `saved` → `addSecret` immediately, toast `saved — applies to the next run (this run keeps its key)`;
`/logout` rewrites atomically and reports env-sourced keys without touching them.

---

## 12. Git, undo, rewind, diff

### 12.1 `GitState` at run start (A140; `src/workspace/git.ts`)

Two spawns replace four: `git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir
--show-toplevel` and `git status --porcelain=v2 --branch --untracked-files=all -z` (`statusPorcelainV2()` keeps `sub`, `xy`, `hH`, `hI` per entry).
Type in §15 C8; `reason: 'not-a-repo' | 'git-missing' | 'bare' | 'timeout'`; never `rev-parse --abbrev-ref HEAD`. `WorkspaceInfo.gitState?: GitState`
(additive) so `createEngine` can record `RunMeta.git` (bounded, no paths) and emit the banner.

### 12.2 Banner (A141) and status zone (A142)

`{ type: 'workspace'; git: GitMeta }` emitted right after `run:ready` (the bus buffers until attach); one item, level `info` (`warn` only for unmerged
paths): `[run] git main ↑2 · 3 modified · 1 staged · 1 untracked`, `git detached 7d731c0e · clean`, `git wtbranch (linked worktree of …) · clean`,
`git main (unborn, no commits yet) · 2 untracked`, `git main · in subdirectory pkg/api/ of the repository`, `git none · not a git repository: changes
made by commands are not recoverable, /diff compares against step pre-images only`, `git none · git not found on PATH: …`, `git main · 412 modified ·
working tree has unmerged paths (u) — commands may fail on conflict markers`; ASCII `^2 v1`; notice only, never a gate. Zone: `src/tui/useGitHead.ts`
= `fs.watch(gitDir, { persistent: false })` filtered on `!filename || filename === 'HEAD'`, 100 ms debounce, read `<gitDir>/HEAD` in-process; dirty
counts from the run-start snapshot and the `invalidateCandidates()` refresh after each `run` outcome; re-probe (one 14 ms spawn) at `run:end` so the
epilogue and the next banner are current (P51); watcher error → stale value; render `⎇ main ↑2 · 3~ 1?` / `⎇ 7d731c0e†` / `⎇ main (wt)`, branch
truncated by grapheme keeping the tail after the last `/`. `--resume` on a different `head` warns.

### 12.3 Pre/post images (A143–A144)

Before `edit|write|patch`: `pre/<step>/<sha256(relpath)>` written atomically (skip > 1 MiB, noted). Before `execute` of a `run`: copy every path in
`snapshotDirty ∪ statusEntries ∪ touched` into `pre/<step>/` (cap 200 files / 16 MiB, overflow recorded as `skipped: cap`); clean tracked files need
no copy. After commit: `post/<step>.json` = `{ files: { <rel>: { sha256, bytes, mode, source: 'edit'|'write'|'patch'|'run', preImage?, deleted?,
created? } }, skipped: [{ path, reason, bytes }] }` hashed with `node:crypto`, written **before** the step's `state.json`; `state.undoLog` (≤ 20).

### 12.4 `/undo [n]` and `/rewind [step] [files|plan|both]` decision table (A145–A146; idle-only, all checks before the first write)

| Current file vs `post[N].files[path].sha256` | Decision |
| --- | --- |
| equal | restore |
| missing and `deleted: true` | restore |
| differs and equals a later step M's post-image | **refuse**: `src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together` |
| differs otherwise | ask per file, default `n`: `src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]` (`a` all, `s` skip rest, Esc abort; box `undo`, 2 rows) |
| symlink / hardlink | skip `link` |
| resolves outside `<ws>` or into `.git` | skip `escape` |
| submodule entry (`sub[0] === 'S'`) | skip `submodule` |

Restore source order: pre-image (`writeFileAtomic` with the recorded mode) → `unlink` for `created` (+ empty dirs the step created) → `git restore
--source=HEAD --worktree -- <path>` through `runGit` for tracked files a `run` step changed while they had no status entry (never `checkout --`,
`--staged`, `stash`, `reset`, `clean`) → skip `not-recoverable`. Output item + `--plain` twin + index `undo` line: `undo step 7: restored 3 files
(src/a.py, src/b.py, tests/test_a.py), skipped 1 (build/out.txt: not recoverable — changed by a command, not tracked by git)`; `post/<N>.json` →
`post/<N>.undone.json`; `undoLog` appended; the next run's seed gets `HarnessProblem { kind: 'human', text: 'human reverted step 7: …' }`. `/rewind n`
undoes last…n in reverse, stopping at the first refusal; `plan`/`both` seed the next run from `StepRecord.planAfter` at n and the window ≤ n. No
`/redo` (P54 rejected for v1). Non-git workspaces: rules 1–2 only with `not recoverable — no git repository`.

### 12.5 `/diff` (A147–A148, A151)

`/diff` = one appended item: header `diff (run <id> · 12 files · +184 −37 · 2 untracked · 1 binary · 1 skipped)`, rows ` M src/a.py            +120
−12  ++++++++--` with letters `M/A/D/R/?/B/S`, `+n −m`, a ≤ 10-cell `+`/`-` bar scaled to the largest row, `†` for paths dirty before the run (legend
`† also modified before this run`), one row per submodule (`--ignore-submodules=dirty`), unborn repos against the empty tree `4b825dc…`, row cap 40
(`--all` lifts), path left-truncated by grapheme to `columns − 32`; data from `git diff --numstat -z HEAD -- <changedFiles>` plus `git diff
--no-index --numstat -z -- /dev/null <f>` per untracked file (first 20; exit 1 = success, A151). `/diff <step>` = pre → post from the images with
`(changed since)` rows. `/diff --full [step]` = unified text (`--color=always -c core.quotePath=false --no-ext-diff --no-textconv --submodule=short
--ignore-submodules=dirty`, files > 1 MiB excluded) written to `<run>/tmp/diff-<seq>.patch` and shown via `suspendTerminal(spawn(pager))`, pager
`$GIT_PAGER` → `$PAGER` → `less`, `LESS=FRX` only when unset, `LESSCHARSET=utf-8`, `core.pager` never consulted; `cat`/no TTY → inline block ≤ 400
lines; engine items queued during the suspension and flushed after `resume()`. `/diff` is human-only (P53). Seatbelt:
`ProfileOptions.gitDir/gitCommonDir` allow `file-write*` under realpath'd `<gitDir>`/`<commonDir>` outside `<ws>` with the deny set `(literal
<commonDir>/config) (subpath <commonDir>/hooks) (literal <gitDir>/config.worktree)` + regexes for `modules/*/config|hooks` (A149).

---

## 13. Errors, retry, crash, logs, epilogue, exit codes

### 13.1 Severity → surface (17 §4.1)

| severity | status-zone word | toast | `<Static>` item | live region | blocking pane | log |
| --- | --- | --- | --- | --- | --- | --- |
| info | — | — | dim item | — | — | info |
| notice (self-healing) | `retrying 2/3`, `offline`, `reconnecting` | 2 s `✓ jev back` | only if the chain failed or lasted > 10 s | retry row | — | info/warn |
| warning | `!n` until Ctrl+O or `/errors` (P65: acknowledgement only) | 2 s `! <short>` | yellow `warning: …` | — | — | warn |
| error | `!n` | 4 s `! <code>: <short>` | red `error <code>: …` + `request-id` | — | — | error |
| blocking | `paused: <reason>` | — | red on entry, dim on resolve | — | yes (box `blocking`, ≤ 5 rows) | error |
| fatal | `done error` | — | `[run] end error …` | cleared | — | error + epilogue |

### 13.2 Retry events and row (A160)

`AskOptions.onRetry`/`GenerateOptions.onRetry` (consumed at `client.ts:352-353` before `sleep(waitMs, signal)` and in `withRetry` `sse.ts:301-302`
before `deps.sleep(delay, signal)`) → `retry` / `retry:settled` events (§15 C12). Row (live row 1, 1 Hz tick owned by the reducer hook, cleared in the
same action as `retry:settled`): `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now`; second row `last: HTTP 529
overloaded · request-id req_…` only when the cause changed. `[r]` = a waker: `sleep(ms, signal, wake?: EventTarget)` in `core/time.ts` gains an
optional third argument that resolves the sleep early; the engine exposes `engine.wakeRetry()` (internal to the renderer hook, not part of the frozen
`Engine` surface — passed through `RendererOptions.session`) (P60: ship in v1, the client change is one optional parameter). Auto-retry pacing for
`paused: jev unreachable`: session mode only, 30 s doubling to 5 min; bench/plain never pause (three failures → exit 5) (P61). Failed attempts are
**not** persisted in `jev.jsonl` (P64).

### 13.3 Blocking panes (A163–A167)

401/403 on the first call → exit 2 (one-shot) or the pane `jev: key rejected (HTTP 401 — "User not found.") / Set the decider key and retry.
Consulted: <sources> / The key is never printed or logged. / [r] retry with the current key  [l] /login  [q] stop (exit 2)`; a later 401 pauses
instead of burning three steps. Spend-cap 429 / OpenRouter 402 → `provider: spend limit reached — "<message>" · this keeps failing until access
resumes · [q] stop (exit 5)`, no auto-retry. Disk errors on the run dir (`ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE`) → `notice checkpoint:degraded` once
per (file, code), `disk ×N` word, pause at the boundary with `[r] retry the write  [c] continue without checkpoints  [q] stop now (exit 3)`; `[c]`
sets `checkpointDegraded` so a later `complete` exits **3**. Network causes map to `offline: DNS lookup failed for <host>` / `cannot reach <host>` /
`no response from <host> in 10 s` (host only); `✓ network back` on recovery; never a probe. `run:ready.sandbox/noNetwork` feed the `sandbox:
seatbelt|none|no-net` badge and the `[sandbox] …` item (A123).

### 13.4 `PaneBoundary` and `fatalExit` (A161–A162)

`class PaneBoundary extends React.Component` wraps `live`, `Pane`, `Box` (review/wizard/…), `Composer`, `StatusLine` and the `<Static>` child renderer
separately; fallback one row `ui: decisions pane failed to render (TypeError) — run continues; details in <log>`; `componentDidCatch` logs the
redacted stack + `componentStack` to `jevcode.log` and dispatches a renderer-only error item; a failed `Confirm` declines the pending request; a
failed `StatusLine` falls back to `formatStatusLine`; `JEVCODE_FAULT=render:<pane>` throws once for tests. `fatalExit(e)` order: (1) `process.exitCode
= err.exitCode`, idempotent guard; (2) synchronous restore **before anything is printed**: `stdin.setRawMode(false)`; `fs.writeSync(1, EXIT_STRING)`
where `EXIT_STRING = '\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m'` (+ `'\x1b[<u'` only if kitty was ever pushed, `'\x1b[>4m'` if tmux extended
keys were set) and `\r\n` when mid-line; (3) `engine?.abort('error')` so the `'exit'` handler writes `state.json` synchronously, then
`renderer.unmount()` raced with 2 s; (4) the epilogue via `fs.writeSync(2, …)`, then `process.exit(process.exitCode)`; `JEVCODE_DEBUG=1` appends the
stack after the block. `stdin/stdout/stderr` `'error'` listeners are installed before any SIGHUP logic; SIGHUP / stdin `'end'` → checkpoint, no
terminal writes, exit 129 (A81).

### 13.5 Epilogue (A62) and exit codes (17 §4.9)

On every `run:end` and fatal path: `jevcode: stopped — <code>: <msg> (exit N)` / `run <id>` / `dir <runDir> (transcript.log, state.json, jevcode.log)`
/ `resume: jevcode run --resume <id>` (or `state.json missing — not resumable`) / `report: jevcode report <id>`; printed to stderr after unmount in
one-shot mode, rendered as a `<Static>` item in session mode; skipped on SIGHUP/EIO.

| situation | one-shot | session (`run:end` item carries the code) |
| --- | --- | --- |
| complete | 0 | item `exit 0`, process continues |
| budget / directive / `human_pause` / `token_cap` | 4 | item `exit 4`, composer reopens |
| ConfigError / usage at launch | 2 | 2 |
| 401/403 first call, first-call drift | **2** | pane → `[q]` = item `exit 2` |
| API failure after retries (3 failed steps, cap `[q]`) | 5 | item `exit 5` |
| checkpoint degraded and stopped | **3** | item `exit 3` + not-resumable notice |
| sandbox/path abort | 6 | item `exit 6` |
| Ctrl-C ×2 / SIGINT | 130 | 130 |
| SIGTERM / SIGHUP-EIO | 143 / 129 | 143 / 129 |
| render fault escalated / uncaught | 1 | 1 |
| `/exit`, Ctrl-D ×2 on an empty composer | — | **0 always** (`--exit-code=last-run` opt-in) |

`exitCodeFor(stop, error, degraded)` becomes the one pure function (`loop/stop.ts`) both `main.tsx` and the engine use; `human_pause` and `token_cap`
→ 4.

### 13.6 Logs and `jevcode report` (A168–A169)

`<runDir>/jevcode.log` (`JEVCODE_LOG`), pre-run/session events in `~/.jevcode/logs/jevcode-<pid>-<stamp>.log` (newest 10; also the fallback when the
run dir is unwritable, P63); levels `error|warn|info|debug|trace`, default `info`; `--verbose` / `JEVCODE_LOG_LEVEL=debug` to the file only (Ctrl+O /
`/errors` are the in-frame twin); `JEVCODE_TRACE=<file>` = alias for `JEVCODE_LOG=<file>` at `trace`; key=value lines ≤ 512 chars through `redact`;
`warn`+ `appendFileSync`, `info`− via a 250 ms buffer flushed synchronously in `'exit'`; 8 MiB cap with one rotation; never stdout/stderr while Ink is
mounted. `jevcode report <id>` / `/report` writes `~/.jevcode/reports/<id>/` (`run.json`, `transcript.log`, `jevcode.log`, last 20 `steps.jsonl` rows,
`jevcode config --json`, `versions.txt`, `README.txt`; `jev.jsonl` bodies only with `--include-requests`); nothing is sent.

---

## 14. Terminal posture and hygiene

- **Colour**: `bin/jevcode.js` already maps `NO_COLOR` → `FORCE_COLOR=0` (kept) and a first-position side-effect import in `main.tsx` repeats it so
  `ink-testing-library` tests agree (Q14); `--no-color` joins `FLAGS`; one `colorEnabled()` (flag > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` >
  `hasColors?.(16)`); ANSI-16 named colours only; 16 colours inside tmux; themes `dark|light|daltonized|ansi` (daltonized swaps red↔cyan/yellow↔blue
  pairs), no OSC 11 (A83, A97, R15).
- **Protocols**: `kittyKeyboard: { mode: 'disabled' }`; no query before the first frame; no OSC 11/XTVERSION; inside tmux (`TMUX` set) `CSI > 4 ; 2 m`
  on start and `CSI > 4 m` in the exit string with both `CSI 27;m;k~` and `CSI k;m u` decoded for Enter only (A78); DEC 2026 is Ink's own per-frame
  BSU/ESU (C4); focus events, mouse, alt screen off (R1, R2).
- **Exit string** (A80): `CSI < u` (if pushed) · `CSI > 4 m` (if set) · `?2004l` · `?2026l` · `CSI 0 SP q` · `?25h` · `SGR 0` · `\r\n` if mid-line,
  then `setRawMode(false)`, synchronously in the `'exit'` handler and in `fatal()`, SIGTSTP, SIGHUP and unmount; never `ESC c` or `ESC[2J`.
- **Ctrl+Z** (A23): byte `0x1a` → erase the frame, exit string, raw off, `process.kill(process.pid, 'SIGTSTP')`; on `SIGCONT` re-enable raw mode and
  bracketed paste and force a repaint through `suspendTerminal`'s resume path.
- **Resize**: `useWindowSize()`; 50 ms composer re-wrap debounce; scrollback never rewritten (§2.5).
- **Screen reader** (A94–A95): `--screen-reader` > `JEVCODE_SCREEN_READER` > `ui.screenReader` (also `INK_SCREEN_READER`); first item `[screen reader
  mode: on via flag|env|config]`; `aria-hidden` spinner; status changes only on stage transitions; announcements as `you:`/`steer:` items; live region
  off; review as a numbered list; roles `textbox`/`multiline`, `list`/`listitem`; notifications default on in this mode.
- **Reduced motion** (A96): `--no-animation` / `JEVCODE_REDUCED_MOTION` / `ui.reducedMotion`: static marker, 1 Hz functional tick, `LIVE_FLUSH_MS`
  250; a unit test greps `src/tui/**` for `setInterval(` outside `spinner.ts` and the retry tick.
- **ASCII** (A90): `--ascii` / `JEVCODE_ASCII=1` / auto when `TERM=dumb` or non-UTF-8 locale or `TERM=linux`: glyph table (`─`→`-`, `›`→`>`, `✓ ✗`→`+
  x`, `↑↓`→`^ v`, `⎇`→`br`, bars `#` on `-`, spinner `|/-\`), `[x] [ ] [?] [!]` ledger stays ASCII everywhere; never `⚠️` with VS16.
- **Tiny terminals**: §2.2; 0×0 pty renders Ink's 80×24 fallback and a unit test asserts the rule width is 80 (A93).
- **Slow links**: `SSH_TTY`/`SSH_CONNECTION` → `maxFps` 15 (F2); the 50 ms coalescer stays; ≥ 1 s query budgets (none in v1); mosh treated as
  unsupported for OSC 52 (A91).
- **Notifications** (A85, C48): default off; on in SR mode; BEL, OSC 9 (iTerm2/Ghostty/WezTerm/foot), OSC 99 (kitty), DCS passthrough in tmux; payload
  a redacted one-liner never starting `<digit>;`; review timer starts when the *deferred* box appears, restarts on keystrokes, fires at ~6 s; run-end
  timer 60 s; also 95 % and `budget:stop`.
- **Title** opt-in `--title` (`OSC 2 ; jevcode: <task head> ST`, controls/bidi stripped, cleared on exit); **OSC 8** only for self-resolved `file://`
  paths on adoption-list terminals (A87, A89).
- **Untrusted text**: `sanitizeStream` is the single choke point (C0 minus `\t\n\r`, DEL, C1, bidi controls, U+2028/2029 → `\n`) for items, live
  region, pastes, clipboard (A88).

---

## 15. Engine and core contract additions (ordered, additive, versioned)

Version tag: `CONTRACT_ADDITIONS = 'tui-1'` exported from `src/core/types.ts` (a comment block lists C1–C24 with dates). Every item is additive
against the current file: new union members, optional fields, or new members on interfaces the repo alone implements (`Engine`: `loop/engine.ts`,
`loop/generator-only.ts`, `test/fixtures/tui/fixtures.ts`).

| # | Addition (exact TypeScript against `src/core/types.ts`) | Insertion point / consumers |
| --- | --- | --- |
| C1 | `export type HarnessProblemKind = 'replan' \| 'rejected_claim' \| 'stale_plan' \| 'human';` | types.ts:82; `planSection` (prompts.ts:134) already renders `[human, step N]` |
| C2 | `StopReason` gains `\| 'human_pause' \| 'token_cap'`; `BenchStopReason = StopReason \| 'not_run'` follows; `exitCodeFor` (stop.ts:15) default branch already returns 4; `storedStopBlocks` (engine.ts:446) returns null for both | types.ts:219; stop.ts; engine.ts:446; main.tsx:15 replaced by the `stop.ts` function |
| C3 | `interface Engine { …; steer(text: string): { queued: number; index: number }; unsteer(): string[]; pause(): void; }` | types.ts:874; engine.ts after `abort()` (:510); generator-only.ts mirrors (steer → prompt hints only); fixtures.ts fake |
| C4 | `export interface RunSeed { parentRunId: string; plan: Pick<Plan, 'done' \| 'remaining' \| 'unverified'>; window: WindowEntry[]; createdThisRun: string[]; lastTestRun: LastTestRun \| null; reverted?: { step: number; files: string[] }[] }` and `EngineOptions.seed?: RunSeed; EngineOptions.humanDirective?: string; EngineOptions.session?: { sessionId: string \| null; parentRunId: string \| null; source: 'cli' \| 'bench' \| 'perf' }; EngineOptions.gitDir?: string; EngineOptions.gitCommonDir?: string` | types.ts:746; engine.ts constructor else-branch (:440) applies the seed; createEngine (:1605) fills RunMeta and passes `gitDir`/`gitCommonDir` to `createSandbox` |
| C5 | `export interface PendingDirective { text: string; at: string; index: number }`, `export interface UndoLogEntry { at: string; step: number; restored: string[]; skipped: { path: string; reason: string }[] }`, `CheckpointState.pendingDirectives?: PendingDirective[]; CheckpointState.undoLog?: UndoLogEntry[]; CheckpointState.checkpointDegraded?: boolean` | types.ts:627; `buildCheckpointState` (engine.ts:637); `isCheckpointState` unchanged (optional) |
| C6 | `StepRecord.planAfter?: Plan` (bounded 20 × 200) | types.ts:302; `commit()` record (engine.ts:1419) |
| C7 | `RunMeta.sessionId?: string; parentRunId?: string \| null; source?: 'cli' \| 'bench' \| 'perf'; title?: string; git?: GitMeta; instructions?: InstructionRecord[]` with `export interface InstructionRecord { path: string; sha256: string; bytes: number }` | types.ts:678; createEngine (:1605); `isRunMeta` unchanged; `updateMeta` patch type gains `'title' \| 'instructions'` |
| C8 | `export interface GitState { repo: boolean; reason?: 'not-a-repo' \| 'git-missing' \| 'bare' \| 'timeout'; gitDir: string \| null; commonDir: string \| null; topLevel: string \| null; prefix: string; linkedWorktree: boolean; head: { kind: 'branch'; name: string } \| { kind: 'detached'; oid: string } \| { kind: 'unborn'; name: string }; upstream: string \| null; ahead: number \| null; behind: number \| null; dirty: { modified: number; staged: number; untracked: number; renamed: number; unmerged: number; submodules: number; entries: StatusEntryV2[] }; probedAt: string; probeMs: number }`, `export interface StatusEntryV2 { xy: string; sub: string; path: string; from?: string; hH?: string; hI?: string; mode?: string }`, `export type GitMeta = Pick<GitState, 'repo' \| 'reason' \| 'head' \| 'upstream' \| 'linkedWorktree' \| 'prefix'> & { dirtyAtStart: { modified: number; staged: number; untracked: number } }`; `WorkspaceInfo.gitState?: GitState` | types.ts after WorkspaceInfo (:523); workspace/files.ts `info()`; workspace/git.ts `probeGit()`, `statusPorcelainV2()` |
| C9 | `SpendSnapshot.parentExceeded?: boolean` | types.ts:470; meter.ts `snapshot()` |
| C10 | `EngineEvent` gains: `{ type: 'steer:queued'; step: number; index: number; text: string }` · `{ type: 'steer:applied'; step: number; count: number }` · `{ type: 'budget:warn'; scope: 'run' \| 'session'; pct: 50 \| 80 \| 95; spentUsd: number; capUsd: number; stepsLeftEstimate: number \| null; restored?: boolean }` · `{ type: 'budget:stop'; scope: 'run' \| 'session'; by: 'run' \| 'session'; spentUsd: number; capUsd: number; step: number; stoppedAt: StoppedAt \| 'follow-up'; raise: { command: string; flag: string; minimum: number } }` · `{ type: 'budget:clamp'; runCapUsd: number; clampedTo: number }` · `{ type: 'budget:override'; setting: string; from: string; to: string; appliesTo: 'resume' \| 'next-run' \| 'session' }` · `{ type: 'budget:unpriced'; side: 'generator' \| 'jev'; model: string }` · `{ type: 'retry'; side: 'jev' \| 'generator'; step: number \| null; stage: StageName \| null; attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: { kind: 'http' \| 'network' \| 'timeout' \| 'invalid' \| 'stream'; status: number \| null; code: string \| null; message: string } }` · `{ type: 'retry:settled'; side: 'jev' \| 'generator'; step: number \| null; attempts: number; ok: boolean; totalWaitMs: number }` · `{ type: 'notice'; step: number \| null; kind: 'offline' \| 'online' \| 'checkpoint:degraded' \| 'checkpoint:restored' \| 'sandbox' \| 'drift' \| 'pause'; text: string; detail?: Json }` · `{ type: 'workspace'; git: GitMeta }` · `{ type: 'secret-ack'; step: number \| null; count: number }`; **extended** `run:ready` adds `sessionId?: string; parentRunId?: string \| null; sandbox?: SandboxLevel; noNetwork?: boolean; maxReplans?: number`; `run:end` adds `exitCode?: number; paths?: { runDir: string; transcript: string; log: string }; resumable?: boolean`; `confirm:resolved` adds `note?: string` | types.ts:833; `itemsFromEvent` (plain.ts:206) gains one line per new item kind (`steer`, `budget`, `notice`, `workspace`, `secret-ack`, `retry` only when settled-failed) so `transcript.log`, `--plain` and `<Static>` stay identical; `TranscriptKind` extended accordingly |
| C11 | `export interface RetryInfo { side: 'jev' \| 'generator'; attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: EngineEvent extends { type: 'retry'; cause: infer C } ? C : never }`; `AskOptions.onRetry?: (r: RetryInfo) => void; GenerateOptions.onRetry?: (r: RetryInfo) => void` | types.ts:410, :427; client.ts:352 and sse.ts:301 call it before the sleep; engine `ask()`/`generate()` forward as `retry` events |
| C12 | `core/time.ts`: `export function sleep(ms: number, signal?: AbortSignal, wake?: EventTarget): Promise<void>` (resolves early on `wake` `'wake'` event); `JevDeciderDeps.wake?` / `ProviderDeps.wake?` plumbed | time.ts:44; jev/client.ts:199; provider/sse.ts:312 |
| C13 | `ResolvedConfig.missingSecrets(mode: EngineMode): readonly ('generator.apiKey' \| 'decider.apiKey')[]`; `GeneratorConfig.priced: boolean`; `RunLimits.maxGeneratorTokens?: number`; `ConfigSource` gains `'wizard'` | types.ts:943, :923, :734, :916; resolve.ts:310 return object; validate.ts:96 |
| C14 | `core/redact.ts`: `Redactor.dropSecret(name: string): boolean`; `export interface SecretHit …`; `export const WARN_ONLY_PATTERNS`; `export function detectSecrets(s, exact?)` | redact.ts:17, :42 |
| C15 | `Workspace.readSecretForMention?(rel: string, maxBytes: number): Promise<FileView>`; `sandbox/paths.ts` `isSecretPath` extended (basename rules) + `export function isMentionDenied(ws, rel, secretPaths): boolean` | types.ts:531; paths.ts:125 |
| C16 | `sandbox/seatbelt.ts`: `ProfileOptions.gitDir?: string; ProfileOptions.gitCommonDir?: string`; `SandboxCreateOptions.gitDir?: string; gitCommonDir?: string` | seatbelt.ts:18; types.ts:1077; run.ts passes through |
| C17 | `PromptInput.humanDirective?: string \| null` rendered in `hintsSection` after the replan line (prompts.ts:168): `Human directive (from the reviewer; it takes precedence over the plan's order): ${clip(text, 600)}`; `CommonStateInput.humanDirective?: string \| null` → `state.humanDirective` present only when non-null (state.ts:113-133); `SynthesisContext.directive` carries the joined replan + human text (no type change) | prompts.ts:51, :155; state.ts:66, :113; engine.ts:1148, :1176, :861 |
| C18 | `export interface ConfirmOutcome { approved: boolean; note?: string }`; `Confirmer.confirmDetailed?(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<ConfirmOutcome>`; `TuiConfirmer.resolveDetailed(id: string, outcome: ConfirmOutcome): boolean` | types.ts:458; engine.ts `confirm()` (:1123) prefers `confirmDetailed`; useEngine.tsx; bench `alwaysDecline` untouched |
| C19 | `EngineStatus.pauseRequested?: boolean; pendingDirectives?: number; retrying?: { side: 'jev' \| 'generator'; attempt: number; maxAttempts: number; untilMs: number } \| null` | types.ts:823; engine.ts `status()` (:467) |
| C20 | `SerializedError.status?: number; retryable?: boolean; side?: 'jev' \| 'generator'; requestId?: string` | types.ts:337; errors.ts `toJSON()` of `JevHttpError`/`ProviderHttpError`; stop.ts `serializeError` |
| C21 | `RendererOptions.ui?: UiSettings` (`export interface UiSettings { theme: 'dark' \| 'light' \| 'daltonized' \| 'ansi'; fps: number; renderMode: 'standard' \| 'incremental'; ascii: boolean; screenReader: boolean; reducedMotion: boolean; notify: boolean; title: boolean; osc52: boolean; noHistory: boolean; noInput: boolean }`); `RendererOptions.policy?: 'oneshot' \| 'session'`; `RendererOptions.session?: SessionRendererHooks` (steer/unsteer/pause/abort/startRun/wakeRetry/budget/undo callbacks, defined in `tui/session-hooks.ts`) | types.ts:892; main.tsx passes them; `createTuiRenderer` keeps its signature |
| C22 | `LoopDetector.resetCounts(): void` (loopdetect.ts) | used by `applyPendingDirectives` |
| C23 | `checkpoint/store.ts`: `CheckpointStore.writeUi?(ui: Json): Promise<void>` (ui.json) and `writePostImages?(step: number, post: Json): Promise<void>`; `CHECKPOINT_FILES` gains `ui: 'ui.json'`, `log: 'jevcode.log'`, `pre: 'pre'`, `post: 'post'` | store.ts:28; optional so injected fakes still type-check |
| C24 | Reserved for the synth team: `synth` event optional structured fields (`mode?`, `goal?`, `site?`, `source?`, `runs?`, `tRunMs?`, `lanes?`, `jevRequests?`) — **not** added here; the `s` tab renders `detail` until they land (A48, F16) | types.ts:834 (untouched by this work) |

### 15.1 Insertion points outside `types.ts`

- `engine.ts`: fields `pendingDirectives`, `pauseRequested`, `activeHumanDirective`, `undoLog`, `checkpointDegraded` (after :346); resume restore
  (after :423); seed application (:440); `steer/unsteer/pause` (after :510); the two lines in `main()` (:562-567); `applyPendingDirectives`;
  `run:ready` extension (:551); `workspace` event after `run:ready`; `retry` forwarding in `askRecorded` (:784) and `generate` (:920) via `onRetry`;
  `humanDirective` in `commonState` (:1148) and `promptInput` (:1176); `synthesisContext.directive` (:861); `planAfter` + `undoLog` +
  `pendingDirectives` in `commit()`/`buildCheckpointState()`; `confirmDetailed` (:1128); pre/post images in `runExecuteStage`'s caller (:1054) through
  a new `loop/images.ts`; `run:end` extension and `exitCodeFor(reason, error, degraded)` in `finish()` (:1476-1479); `activeHumanDirective = null` at
  commit.
- `prompts.ts`: `PromptInput.humanDirective?` (:51), one `lines.push` in `hintsSection` (:168); system prompt gains `## Project instructions` when
  `SystemPromptOptions.instructions?: string` is set (:82).
- `state.ts`: `CommonStateInput.humanDirective?` (:66), `state.humanDirective` (:131).
- `main.tsx`: `commandChat`, `commandRun` → `runOnce(flags, session, task, seed)`; `interactive` predicate (§1.2); `missingSecrets` probe after
  `firstFrame()`; session meter and index; `AGENTS.md` load; `GitState` via `createWorkspace`; `--json` writer; `fatalExit` re-ordered;
  `printWarnings(config.warnings)`; `exitCodeFor` import from `loop/stop.ts`;
  `login/logout/sessions/report/completion/upgrade/doctor/calibration/keys` commands as dynamic imports.
- `args.ts`: `COMMANDS` (§1.1); new flags (§16); `parseCliArgs([])` → `chat`; `--resume <id|title>` validation relaxed (title allowed when the index
  resolves it; `RUN_ID_RE` still enforced for `run --resume` in non-TTY mode).

### 15.2 jev-only preservation checklist (F13)

- [ ] `synth` events still yield exactly one transcript line each (`itemsFromEvent` case unchanged; the `s` tab reads the same event).
- [ ] `propose [synth]` marker in the status line unchanged (`SYNTH_MARKER`, StatusLine.tsx:23).
- [ ] `main.tsx` jev-only path: `createNullProvider()`, `createSynthesizer({ decider, redact })`, `config.generator()` never called (`buildProvider`,
  :53-57; `gen` fallback :162) — the session controller reuses `buildProvider`/`buildDecider` verbatim.
- [ ] `SynthesisContext.directive` type unchanged (`string | null`); the human text is joined into it (C17).
- [ ] `SYNTH_STATE_MAX_BYTES`, `setSynthState` untouched; `CheckpointState.synthState` untouched.
- [ ] `src/synth/**` not modified; the structured `synth` fields (C24) are a separate PR by the synth team.
- [ ] `transcript.log`, `--plain` output and the TUI transcript remain line-identical: every new item kind is produced by `itemsFromEvent` and nowhere
  else; `headerItem` unchanged; a fixture test replays `run-events.json` + the new events through all three renderers and diffs the lines.
- [ ] Bench: `alwaysDecline` untouched; `source: 'bench'` never writes the index or history; `BenchStopReason` compiles with the two new reasons.

---

## 16. Configuration schema (precedence flag > env > `./.env` > `<OPEN_ASSIST_PATH>/.env` > file > default; sources shown by `jevcode config`)

| Setting | Flag | Env | File key | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `ui.theme` | `--theme dark\|light\|daltonized\|ansi` | `JEVCODE_THEME` | `theme` | `dark` | no auto-detect (C15); `/theme` runtime |
| `ui.fps` | `--fps <n>` | `JEVCODE_FPS` | `fps` | `30` (`15` under `SSH_TTY`/`SSH_CONNECTION`) | A32, F2 |
| `ui.renderMode` | `--render-mode standard\|incremental` | `JEVCODE_RENDER_MODE` | `renderMode` | `standard` | A31 |
| `ui.ascii` | `--ascii` | `JEVCODE_ASCII` | `ascii` | auto (`TERM=dumb`, non-UTF-8, `TERM=linux`) | A90 |
| `ui.title` | `--title` | `JEVCODE_TITLE` | `title` | `false` | A89 |
| `ui.screenReader` | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | `screenReader` | `false` | `=0` overrides |
| `ui.reducedMotion` | `--no-animation` | `JEVCODE_REDUCED_MOTION` | `reducedMotion` | `false` (true in SR) | A96 |
| `ui.notify` | `--notify` | `JEVCODE_NOTIFY` | `notify` | `false` (true in SR) | A85 |
| `ui.osc52` | `--osc52` | `JEVCODE_OSC52` | `osc52` | `false` | A86 |
| `ui.noHistory` | `--no-history` | `JEVCODE_NO_HISTORY` | `noHistory` | `false` | A60 |
| `ui.noInput` | `--no-input` | `JEVCODE_NO_INPUT` | `noInput` | `false` | C46 |
| `ui.noColor` | `--no-color` | `NO_COLOR` (→ `FORCE_COLOR=0`) | — | — | A83 |
| `ui.trustWorkspace` | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | — | `false` | scripts only |
| `ui.exitCode` | `--exit-code last-run\|zero` | `JEVCODE_EXIT_CODE` | `exitCode` | `zero` | 17 §4.9 |
| `ui.budgetWarnings` | `--no-budget-warnings` | `JEVCODE_BUDGET_WARNINGS` | `budgetWarnings` | `true` | mutes toast + bell only |
| `ui.replayLimit` | `--replay-limit <n>` | `JEVCODE_REPLAY_LIMIT` | `replayLimit` | `200` | A29 |
| `ui.keybindings` | — | — | — | `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` | A24 |
| `session.spendCapUsd` | `--session-spend-cap <usd\|none>` | `JEVCODE_SESSION_SPEND_CAP_USD` | `sessionSpendCapUsd` | `5 × limits.spendCapUsd` (derived, shown as such) | A130 |
| `limits.spendCapUsd` (jev-only default) | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `spendCapUsd` | `2.00`; `0.25` when `--mode jev-only` | P45 |
| `limits.allowUnpriced` | `--allow-unpriced` | `JEVCODE_ALLOW_UNPRICED` | `allowUnpriced` | `false` | A135 |
| `limits.maxGeneratorTokens` | `--max-generator-tokens <n>` | `JEVCODE_MAX_GENERATOR_TOKENS` | `maxGeneratorTokens` | `spendCapUsd / 15 × 1e6` | token cap |
| `generator.priceCacheReadPerM` / `…WritePerM` | — | `JEVCODE_PRICE_CACHE_READ_PER_M` / `_WRITE_PER_M` | `priceCacheReadPerM` … | `0.1 ×` / `1.25 ×` input | source column says "derived" |
| `secrets.allowSecretMention` | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | `allowSecretMention` | `false` | A157 |
| `log.file` | `--log <file>` | `JEVCODE_LOG` (`JEVCODE_TRACE` alias → trace) | `log` | `<runDir>/jevcode.log` | A168 |
| `log.level` | `--log-level`, `--verbose` (= debug) | `JEVCODE_LOG_LEVEL` | `logLevel` | `info` | file only |
| `update.notify` | `--update-notify` | `JEVCODE_UPDATE_NOTIFY`, `NO_UPDATE_NOTIFIER` | `updateNotify` | `false` | A70 |
| `session.continue` | `-c`, `--continue` | — | — | — | most recently used run here |
| `session.list` | `--list-sessions` | — | — | — | prints picker rows and exits |
| `run.resume` | `--resume <id\|title>` | — | — | — | title allowed on a TTY |

`jevcode config` prints every row with its source; `jevcode config set <key> <value>` writes non-secret keys to the XDG file (refuses
`apiKey`/`jevApiKey`); `--json` includes the derived session cap with `source: 'default (5 × run cap)'`.

---

## 17. Packaging and release (prepared, not published; A65–A72, D14)

- `package.json`: remove `"private": true`; `"license": "MIT"` + a committed `LICENSE`; `ink` and `react` move to `devDependencies` (inlined by
  esbuild; P26 decided: zero install-time dependencies); `files: ["bin", "dist/jevcode.mjs", "THIRD_PARTY_LICENSES.txt", "man/jevcode.1", "README.md",
  "LICENSE"]` (no `.map`, `meta.json`, `docs/`); `engines` unchanged; `publishConfig: { provenance: true, access: 'public' }`; `prepublishOnly` guard
  refusing a direct publish outside CI.
- `scripts/build.mjs`: `minify: true` + `keepNames: true` (P27), `define: { __JEVCODE_VERSION__: JSON.stringify(pkg.version) }` (main.tsx reads it;
  `--version` and `--help` answered before importing Ink, already true), `sourcemap: false` for the published bundle (kept for `npm run dev`),
  `THIRD_PARTY_LICENSES.txt` generated from `result.metafile` inputs' package `license`/`LICENSE*` files because `legalComments: 'none'`;
  `man/jevcode.1` and `completions/jevcode.{bash,zsh,fish}` generated from `FLAGS` + `COMMANDS` by `scripts/gen-docs.mjs`; smoke step unchanged plus
  `node bin/jevcode.js --version`.
- `bin/jevcode.js`: Node ≥ 22.12 guard, `NO_COLOR` shim, compile cache, no-network assert — all already present; add `TERM=dumb`/`CI` → plain hint env
  for the bundle.
- Commands: `jevcode completion bash|zsh|fish` prints a **static** script (run-id completion by shell-side `ls $JEVCODE_HOME/runs`); `jevcode upgrade
  [<version>|latest|next] [--check] [--method]` delegates to the detected package manager (npx → nothing; brew; bun; pnpm; yarn; else `npm install -g
  jevcode@<v>`), 2 s registry timeout; update notifier off by default, post-run detached `--check --write-cache` to
  `$XDG_CACHE_HOME/jevcode/update-check.json`, suppressed under `CI`, `NO_UPDATE_NOTIFIER`, npx, non-TTY, < 24 h; `jevcode doctor [--terminal]`
  read-only.
- Release: GitHub Actions on tags, trusted publishing (`id-token: write`) on a **Node 24 (≥ 24.5.0)** publish job (P69: bundles npm ≥ 11.5.1; `.nvmrc`
  stays 22.23.2 for tests), `npm --version` asserted ≥ 11.5.1, GitHub Release with tarball + `SHA256SUMS`, dist-tags `latest`/`next` (P31), CHANGELOG
  per version, `Formula/jevcode.rb` tap text in the Node-formula shape (`depends_on "node"`, `std_npm_args`, `bin.install_symlink`,
  `generate_completions_from_executable`, `man1.install`) rewritten by the release job.
- CI gates: `test "$(npm pkg get private)" = "{}"`, `npm pack --dry-run` file list equals the `files` allowlist and the tarball is < 1.5 MB,
  `--version` smoke, `THIRD_PARTY_LICENSES.txt` non-empty, `docs/KEYS.md` regenerated cleanly.

## 18. Performance plan (F18, A103–A108)

| Gate | Threshold | How measured | Script change |
| --- | --- | --- | --- |
| First frame (composer frame) | cold p95 < 300 ms, zero network | `perf/first-frame.ts` unchanged method; sentinel `step 0/` still first; add a second series with `jevcode chat --perf-exit-after-first-frame` | `first-frame.ts` gains the `chat` series |
| Render lag under a live mocked run | loop lag p95 < 5 ms, max < 50 ms; `renderTime` p95 < 5 ms; **0 clears** (`ESC[2J`, `ESC[3J`, `ESC c`, `?1049h`) at rows 40 and 12 | `perf/render-lag.ts` at the A109 region: the driver types a 4-row draft and two steers through the pty while the mock streams 500 deltas/s; frame count = `ESC[?2026h` occurrences ≤ 20/s + 1; exactly one `?25l` and a final `?25h` | extend the regex, add the typing driver (`expect`), add the frame-count and cursor assertions |
| Composer keystroke → frame | p95 < 16 ms in a real pty at the A109 region (rows 24, pane 12, composer 6, queue 2) | `perf/composer-latency.ts` (new): `pty.fork` driver writes 200 keystrokes with timestamps, frames detected by `ESC[?2026h`; also measured with a review pending | new script + `latest.json` fields |
| Lag while typing | p95 < 5 ms during typing + streaming | same run as render-lag with `--perf-lag-probe` | reuse |
| Fuzzy scorer | p95 ≤ 16 ms per query over 5,000 candidates | vitest unit benchmark (§5.5) | new test |
| Layout | `computeLayout` ≤ 5 µs; `layoutRows` of a 12,000-char draft ≤ 2 ms | unit benchmarks | new tests |
| `<Static>` append at the A109 region | ≤ 1,600 B per keystroke at 24×80 (08 §11 measured 1,436 at dyn 22) | `bench2.mjs`-style probe added as `perf/static-bytes.ts`, informational (A107) | new script |
| Index fold | ≤ 2 ms at 1,000 runs, folded once per open (A139) | unit benchmark | new test |
| Reduced motion | ≤ 4 frames/s idle | pty capture | render-lag variant |

`npm run perf` writes all series to `perf/results/latest.json`; the README table gains the composer rows.

## 19. Testing plan (A102–A108, 12 §12, 13 §6, 14, 15 §7, 16 §4.9, 17 §4.13)

- **Pure units** (vitest, no Ink): `reduceBuffer`, `graphemeBoundaries`, `wordBoundary`, `cellWidth` fixture table vs `string-width`, `layoutRows`,
  `computeLayout` (allocation table of §2.3 as `it.each`), `interrupts` state machine (§3.3 matrix as a table test), slash tokeniser/validators,
  `rank`/`scoreMatch`, `detectSecrets` FP fixtures + a 256 KB backtracking guard (< 5 ms), `foldIndex`, `seedFrom`, `statusPorcelainV2` (ten line
  kinds, torn output), the undo decision table, `exitCodeFor(stop, error, degraded)`, `formatStatusLine` zones at 60/80/100/120/140 columns, every
  `lines()` twin (TUI vs `--plain` vs `transcript.log` line identity over `run-events.json` + the new events).
- **Property tests** (seeded mulberry32, 1,000–5,000 iterations, < 2 s per file): buffer invariants (cursor on a grapheme boundary, `text ===
  graphemes.join('')`, no control chars, insert/backspace and kill/undo identities, chips atomic, paste = one undo step, `width(row) ≤ columns`,
  cursor `(x, y)` equals the summed widths under the same wrap, rendering a pure function of `(text, cursor, columns)`); `computeLayout` invariants of
  §2.2 over random inputs; `scoreMatch(q, c) !== null ⇔ q is a subsequence of c` (case-folded).
- **ink-testing-library** with a stdout that has `rows`/`columns` (A15): composer typing/paste/newline keys, the `y/N` secret gate contract, review
  deferral (a typed-ahead `y` does not approve), `d` note path, palette open/close, picker keys, wizard masked field (zero key bytes in every frame,
  no `<Static>` item with the key), `PaneBoundary` fallback (`JEVCODE_FAULT=render:<pane>`), retry row + 1 Hz tick cleared on `retry:settled`, budget
  confirm keys with Enter inert, `lastFrame().split('\n').length ≤ rows − 2` at rows 3/5/8/12/24/40 × columns 20/40/80/120/400, 0×0 stdout → rule
  width 80. Snapshots: normalised, dynamic region only, inline when ≤ 6 lines.
- **Engine units** (fakes via `EngineDeps`): `steer` → `pendingDirectives` in the next checkpoint; `applyPendingDirectives` moves them into
  `plan.harnessProblems` and the prompt/state slots and resets loop counts; `pause` → `human_pause` at the boundary, resumable; seed application;
  `planAfter` recorded; `confirmDetailed` note reaches `WindowEntry.notes` and the declined reason; `retry` events forwarded; `workspace` event after
  `run:ready`; jev-only checklist (§15.2).
- **Artefact sweep**: a canary secret pasted and sent with `y` never appears in `transcript.log`, `steps.jsonl`, `run.json`, `state.json`,
  `state.prev.json`, `decisions.jsonl`, `jev.jsonl`, `generator.jsonl`, `history.jsonl`, `ui.json`, `jevcode.log`, `--plain` stdout, `--json` stdout
  or any frame, while the mocked provider received it raw.
- **pty suite** (`test/pty/*.exp`, vitest project `pty`, macOS, `CI` unset, `stty` geometry first, never `kill -WINCH`): first frame is the composer;
  typing during a live mocked run keeps `ESC[2J` = 0 at rows 12 and 40; a 20 KB bracketed paste holding a `ghp_` token echoes the chip label only;
  Esc/Esc Esc/Ctrl-C/Ctrl-D matrix cells; Ctrl-Z through `bash -i` + `fg`; `$EDITOR`/`$PAGER` round trips with items queued during suspension; resize
  storm; `NO_COLOR=1` and `--ascii` frames; fatal path leaves `stty -a` with `icanon echo` and the epilogue after the last frame bytes;
  `JEVCODE_FAULT=persist:ENOSPC` pane and exit 3; optional `hdiutil` 1 MiB image behind `JEVCODE_TEST_RAMDISK=1`.
- **Fault injection**: `JEVCODE_FAULT=render:<pane> | persist:ENOSPC | jev:429:12 | jev:401 | disk:EIO` in the mock decider/store/panes.
- **CI without a TTY**: unit + ink-testing-library projects run everywhere; the pty project is `darwin`-only and skipped when `/usr/bin/expect` is
  absent; perf gates run on the macOS runner nightly.

## 20. Module map for parallel implementation (disjoint files per owner slot)

| Slot | Files (new unless noted) | Exports | Depends on | Wave |
| --- | --- | --- | --- | --- |
| S1 contract | `src/core/types.ts` (edit), `src/errors.ts` (edit), `src/loop/stop.ts` (edit) | C1–C11, C13, C18–C21; `exitCodeFor(stop, error, degraded)` | — | 0 |
| S2 composer core | `src/tui/composer/{buffer,width,eaw-table,layout,state,submit,history,killring}.ts`, `scripts/gen-eaw.mjs` | `reduceBuffer`, `cellWidth`, `layoutRows`, `composerReducer`, `HistoryStore` | S1 types only | 1 |
| S3 layout + panes | `src/tui/layout.ts`, `src/tui/panes/{Pane,Decisions,Plan,Timeline,Synth,LoopBanner,Live,RetryRow}.tsx`, `src/tui/lines/*.ts`, `src/tui/bars.ts`, `src/tui/theme.ts`, `src/tui/PaneBoundary.tsx` | `computeLayout`, `lines()` twins, `bar()`, `sparkline()`, `theme` | S1 | 1 |
| S4 keys + palette | `src/tui/keys/{dispatch,interrupts,bindings,keybindings-file}.ts`, `src/tui/commands/{registry,parse,table}.ts`, `src/tui/fuzzy.ts`, `src/tui/Palette.tsx`, `src/tui/Mention.tsx`, `src/tui/Help.tsx` | `dispatchKey`, `reduceInterrupts`, `REGISTRY`, `parseSlash`, `rank` | S1, S2 types | 1 |
| S5 review + status | `src/tui/Review.tsx` (replaces Confirm.tsx), `src/tui/StatusLine.tsx` (edit), `src/tui/Toasts.ts`, `src/tui/why.ts`, `src/tui/calibration.ts`, `src/tui/useGitHead.ts` | `Review`, `formatStatusLine` zones, `whyBlock`, `calibrationBlock` | S1, S3 lines | 1 |
| S6 engine | `src/loop/engine.ts` (edit), `src/loop/generator-only.ts` (edit), `src/loop/loopdetect.ts` (edit), `src/loop/images.ts`, `src/provider/prompts.ts` (edit), `src/loop/state.ts` (edit), `src/jev/client.ts` + `src/provider/sse.ts` (onRetry/wake), `src/core/time.ts` (edit) | steer/unsteer/pause, seed, directives, planAfter, pre/post images, retry events, workspace event | S1 | 1 |
| S7 sessions + money | `src/cli/session.ts`, `src/cli/seed.ts`, `src/sessions/{index,history,lock,export}.ts`, `src/spend/session.ts`, `src/tui/Picker.tsx`, `src/tui/BudgetConfirm.tsx`, `src/cli/json-stream.ts` | `SessionController`, `IndexLine`, `foldIndex`, `seedFrom`, `budgetPolicy` | S1, S6 surface | 2 |
| S8 secrets + onboarding + trust | `src/core/redact.ts` (edit), `src/sandbox/paths.ts` (edit), `src/tui/onboarding/{reducer,Wizard,MaskedField,trust}.tsx`, `src/config/{secrets-file,instructions,trust}.ts`, `src/config/resolve.ts` + `validate.ts` (edit: `missingSecrets`, `priced`, XDG, ui settings), `src/tui/SecretGate.tsx`, `src/tui/clipboard.ts` | `detectSecrets`, `dropSecret`, `missingSecrets`, wizard reducer, `loadInstructions`, `trustStore` | S1 | 1 |
| S9 git + undo + diff + errors | `src/workspace/git.ts` (edit), `src/workspace/files.ts` (edit), `src/sandbox/seatbelt.ts` (edit), `src/undo/{undo,rewind,diff,pager}.ts`, `src/tui/Blocking.tsx`, `src/log/logger.ts`, `src/cli/report.ts`, `src/cli/epilogue.ts` | `probeGit`, `statusPorcelainV2`, `undoStep`, `diffBlock`, `Logger`, `epilogue()` | S1 | 1 |
| S10 CLI + packaging + tests | `src/cli/{main.tsx,args.ts}` (edit), `src/cli/{chat,login,completion,upgrade,doctor}.ts`, `src/tui/{App,Session}.tsx`, `src/tui/plain-composer.ts`, `bin/jevcode.js` (edit), `scripts/{build,gen-docs}.mjs`, `test/pty/*`, `src/perf/composer-latency.ts`, `src/perf/render-lag.ts` (edit) | wiring, renderer factories, pty harness | everything | 2–3 |

Integration waves: **0** S1 lands the types (compiles with stubs in fixtures); **1** S2–S6, S8, S9 in parallel against S1 with unit tests only; **2**
S7 (needs S6's `Engine` surface) and S10's `App.tsx`/`Session.tsx` composition against S2–S5; **3** S10 wires `main.tsx`, the pty suite and perf; the
synth team's C24 lands independently afterwards. `src/synth/**` is read-only for every slot.

## 21. Documentation deliverables

`docs/KEYS.md` (generated from the registry, sync test), `man/jevcode.1` and `completions/*` (generated from `FLAGS`), `docs/TUI.md` (this design's
§1–§14 condensed for users: modes, keys, sessions, money, secrets), `docs/DESIGN.md` §10–§12 amendments (composer, session mode, exit-code table,
`--json` redaction guarantee wording per A158, pre/post images), README updates (chat mode, exit codes, history, install-time zero dependencies, "or
in prompt history, clipboard payloads and the `--json` stream"), `docs/research/tui/terminal-matrix.md` checklist for `jevcode doctor --terminal`,
`CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_LICENSES.txt` (generated).

## 22. Deviations from ADOPT rows and items deferred to v1.x

| # | Row | Deviation / deferral | Why (one sentence) |
| --- | --- | --- | --- |
| D1 | A34 (Enter on a non-matching `/` token "submits the typed text and reports Unknown command") | Enter keeps the draft and reports the error; the text is never submitted | in JevCode a submitted line starts a paid run, so a typo must not become a task. |
| D2 | 11 §4b fixed dimension order in the review header | dimensions sorted by risk descending | at rows 8/12 the header is truncated and the dominant dimension must survive. |
| D3 | A24 keybindings file under `~/.config/jevcode` vs P21 | XDG dir (`${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json`) | it sits beside `config.json` and is not a secret. |
| D4 | 06 §6 "≤ 6 suggestion rows" | ≤ 8 rows incl. footer | A34/04 §5 `MAX_POPUP_ROWS = 8` is the cross-tool constant and the budget table shows it fits at rows ≥ 12. |
| D5 | A60 chip label `[Pasted #n, k lines, sha256:…]` in history | redacted first line clipped to 40 chars + line count (F9/P58) | a hash means nothing to a human recalling "that log I pasted". |
| D6 | 10 §15.3 "slash commands deferred to run end otherwise" | idle-only commands error immediately while live instead of queueing | queued side-effecting commands are a second, invisible queue; the error names `Esc` to pause. |
| D7 | A160 "`[r] retry now` … may stay out of v1" | shipped in v1 via an optional `wake` parameter on `sleep` | one optional parameter in `core/time.ts` and the two callers is cheaper than explaining a dead key. |
| Deferred | A63 project command files `.jevcode/commands/*.md` | v1.x | the registry is designed for it (`category: 'project'`), no v1 user story. |
| Deferred | A77 owned kitty handshake, A31 incremental default, C15 `--theme auto` | v1.x after the pty suite and soak tests | F2 fixes the v1 posture. |
| Deferred | P54 `/redo`, P50 "restore to HEAD" option, P8 `EngineOptions.pins` bypass, `/cd` workspace switching (00 §8 item 12), `run.lock` PID liveness beyond dead-pid detection (item 13) | v1.x | each adds a state the design does not need for the fixed decisions. |
| Deferred | C44 promotion of AWS/JWT to redacting families | after one week of real `history.jsonl` FP scans (Q35) | staged per 16 §4.1. |
| Deferred | Windows/ConPTY validation, NVDA/VoiceOver sessions, Terminal.app/mosh matrix cells (Q19, Q20, Q22, item 17) | v1.x | not measurable on this machine. |
| Deferred | Markdown/prose rendering of generator text (00 §8 item 8), localisation (item 24) | v1.x / never | R24, A99. |
