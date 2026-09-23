# JevCode interactive TUI — the design (synthesis)

Written 2026-09-20 by the synthesizing architect from the four candidate designs under
`docs/research/tui/designs/` (spine: `minimal-robust.md`, ranked first by the judges; grafts from
`composer-first.md`, `jev-native.md`, `sessions-long-horizon.md` as listed by `judge-ux.md`,
`judge-engineering.md`, `judge-safety.md`), against `docs/research/tui/00-SUMMARY.md` (rows cited as
`Ann` ADOPT, `Rnn` REJECT, `Cnn` conflict, `Pnn`/`Qnn` open item, `Dn` decision; research sections as
`NN §x`), `docs/DESIGN.md` §6/§9–§12 and the working tree read today: `src/core/types.ts` (1,115 lines),
`src/loop/engine.ts` (1,637), `src/tui/*`, `src/cli/*`, `src/provider/prompts.ts`, `src/loop/state.ts`,
`src/checkpoint/*`, `src/config/*`, `src/spend/meter.ts`, `src/core/redact.ts`,
`node_modules/ink/build/*.d.ts` (7.1.1). Every line number below is from that tree; `types.ts` anchors are written `types.ts:<line>` beside the symbol name (regenerated against HEAD after review finding 59), so a drifted line is found by name. Product decisions
F1–F18 are fixed inputs and are not reopened. Where the four designs disagreed, the choice and its
one-sentence reason are given inline; deviations from ADOPT rows are collected in §22.

This document is the single input for ten parallel implementers (§20). §15 (contract), §19 (tests) and
§20 (module map) are written to be implemented without questions; §24 fixes every user-facing string so
the TUI, `--plain`, `--screen-reader` and `--ascii` twins agree.

## The fifteen decisions (00 §9)

| # | Decision | Choice | Informing rows |
| --- | --- | --- | --- |
| D1 | Layout cap set and yield order | minimal-robust's one-modal-slot `computeLayout` (§2.1) with the A109 caps; allocation order status → rule → composer floor → overlay → composer growth → queue → preview → live → banner → pane (yield is the reverse: pane → live → preview → queue → composer-to-1); the wizard refunds the composer floor (jev-native graft); rows < 3 render nothing dynamic; a pending review collapses the composer to one inactive row (P68: collapse, not hide-queue) | A10, A107, A109, C47, 08 §11, 19 §5, 11 §5, 13 §5.12, 14 §4.3, 16 §3.3, 17 §4.1 |
| D2 | Key and exit semantics | 19 §4's table with F5's choices as a pure `reduceInterrupts(state, key, nowMs)` over states S0–S7 plus per-overlay sub-rows (§3.3); windows Ctrl-C 1.5 s, Esc Esc 2 s, Ctrl-D 800 ms, Esc re-buffer 30 ms; Ctrl-D with a live run opens an explicit `[y] abort and exit  [n] stay` row and `/exit` while live confirms first — both `[y]` paths `engine.abort('human_abort')` and exit **0** after `run:end` (the `run:end` item carries 130); Ctrl-C on a visible review with an empty draft is `engine.abort('human_abort')` alone (the engine's rejected `confirm()` is the decline: rule-1 discard, never a committed `declined` step) and with a draft clears the draft (F5's text rule outranks); wizard Ctrl-C exits 2 only when no run exists; blocking-pane Ctrl-C = that pane's `[q]`; `--no-input` selects the plain renderer (C46); exit-code table §13.5 | A18–A20, A54, A110, C17, C18, C42, P25, P62, P67, 17 §4.9 |
| D3 | Session model and money | follow-up = new seeded run; parent `SpendMeter` with `setCap?()` (jev-native) and `SpendSnapshot.parent?` (sessions) so mid-run session-scope `budget:warn` needs no controller hook; 50/80/95 %; `y/r/n` box only when `0 < remaining < runCap`; `/budget spend-cap` = next `/resume` or next run; `/budget session-spend-cap` immediate through `setCap`; unpriced Anthropic model refuses to start unless `--allow-unpriced` (token cap); `/resume` fold excludes the resumed run (E11); mode-keyed run default resolved after `--mode`; pending values memory-only; no 95 % pre-emption | A52, A58, A129–A139, C45, C51, P45–P48, 14 §4 |
| D4 | Secrets at every entry point | `detectSecrets` with the six redacting families plus warn-only AWS/Slack/PEM-`PRIVATE KEY`/JWT/Stripe/`npm_`/`hf_`/`glpat-`; `sk-proj-` labelled OpenAI; `y` → `addSecret` first for **every** hit span ≥ 8 chars, warn-only families included (process scope, documented as not surviving `--resume`); raw provider turn — steers stored raw too — + `secret-ack { count }`; detected spans render as `•` cells in the composer; paste bodies in a `useRef` Map, 1 MiB cap, 12,000-char notice; chip label = redacted first line ≤ 40 + line count; cleared drafts, `ui.json` and the `d` note pass `detectSecrets` with spans → `[REDACTED:draft]` (E6/E9, new rule) | A4, A12, A60, A86, A153–A159, C19, C44, C50, P44, P55–P59 |
| D5 | First-run and credentials | non-throwing `missingSecrets(mode)` after the first frame; ≤ 4-row wizard (provider → generator key → Jev key, Enter = reuse OpenRouter → atomic 0600 XDG write, legacy path checked, warn once → optional priced verification with the configured `decider.model` on explicit `y` → trust → sandbox line → composer); shadowing line in the item stream (P43); Windows ACL note; non-TTY/`--no-input` fix block exit 2 | A113–A128, C43, C46, P30, P40–P43, 13 §5 |
| D6 | Workspace trust and instruction files | `~/.jevcode/trust.json` (0600) keyed by git-root realpath with `AGENTS.md@sha256`; a changed sha256 re-prompts; `3 don't trust` still reads `./.env` and shows `dotenv: <path>`; `--trust-workspace` for scripts; `AGENTS.md` → generator system prompt only, 32 KiB, recorded `{ path, sha256, bytes }` | A59, A122, C49, P38, P39 |
| D7 | Git state | two **unsandboxed** spawns in `createEngine` before the sandbox exists → `GitState` handed to `createSandbox` and `createWorkspace` (zero further spawns at run start; `RunMeta.git` bounded and carrying the HEAD oid); notice-only banner via the `workspace` event; `fs.watch(gitDir)` zone filtered on `HEAD`; re-probe at `run:end` (P51); `--resume` on a different HEAD warns (P52); seatbelt `gitDir`/`gitCommonDir` | A140–A142, A149, A150, 15 §6 |
| D8 | Undo and rewind | `post/<step>.json` with per-file `sha256`, `cleanAtStart` and the step's `headOid`; dirty-set pre-images before `run` (200 files / 16 MiB), 1 MiB per file, 16 MiB streamed hashing cap per step with `imagesMs` recorded inside `harnessMs`; verify-before-write table + a HEAD-moved rule (E10); `git restore --source=HEAD --worktree`; `undoLog` carried in the next run's seed, the finished run's `state.json` never rewritten (R21); `/rewind` as a step picker; no `/redo`, no restore-to-HEAD option | A57, A143–A147, C5, C40, C41, P9, P50, P54, Q33 |
| D9 | `/diff` | inline `--numstat -z` block (letters M/A/D/R/?/B/S, `†` legend, row cap 40); `/diff <step>` from images; `/diff --full` through `$GIT_PAGER`→`$PAGER`→`less` under `suspendTerminal` (idle-only); the inline block is allowed while live (one sandbox spawn, off-thread); human-only | A148, A151, C24, P53 |
| D10 | Error, retry and crash UX | severity → surface map; `retry`/`retry:settled` + 1 Hz row; `[r]` through `Engine.retryNow()` and `sleep(ms, signal?, wake?)`; `paused: jev unreachable` 30 s → 5 min in session mode only, every blocking pause awaited at the loop top through `EngineOptions.blocker`; `PaneBoundary` per pane incl. the composer; re-ordered `fatalExit`; disk pause exit 3; first-call 401/403 → exit 2 pane → `/login`; `!n` acknowledged by Ctrl+O or `/errors` only | A62, A80, A81, A160–A167, A170, A171, P60–P62, P65, P66 |
| D11 | Logs and support bundles | `<runDir>/jevcode.log`, levels, `--verbose` file-only, `JEVCODE_TRACE` = `trace` alias, warn+ synchronous, fallback `~/.jevcode/logs/`, failed retries not in `jev.jsonl`, `jevcode report` bundle | A12, A168, A169, P63, P64 |
| D12 | Engine contract and `--json` | one ordered additive list (§15): optional fields on existing events, `Confirmer.confirmDetailed?`, required `Engine.steer/unsteer/pause` + `retryNow`; stream `{"v":1,"schema":"jevcode.events/1"}`; renderer-originated lines during a live run go through `Engine.annotate()` → `notice { kind: 'ui', label }` so `transcript.log`, `--plain` and the TUI stay line-identical for the whole run (F13 kept, not narrowed); idle-time `[ui]` items have no run to record them; `secret-ack` count only | A53, A61, A138, A158, A170, P59 |
| D13 | Terminal posture for v1 | kitty disabled, universal newline keys, no queries ever (no `CSI ? u`, DA1, OSC 11, XTVERSION, tmux `CSI > 4;2 m`), standard log-update, `--render-mode incremental` opt-in, DECSCUSR steady bar once at start and reset in the exit string (A3 kept), runtime feature detection only | A6, A31, A77–A79, A83, A111, A112, C1, C2, C4, C15 |
| D14 | Packaging and release | one zero-dependency npm package, `"private"` removed, MIT `LICENSE`, `files` allowlist, `minify` + `keepNames`, static completions, man page, `jevcode upgrade`, opt-in post-run notifier, Homebrew tap text, trusted publishing on a Node 24 publish job, dist-tags `latest`/`next` | A65–A72, C13, P26–P28, P31, P69 |
| D15 | One `ui.*`/limits schema | §16 table: flag > env > `./.env` > `<JEVCODE_EXTRA_ENV_FILE>` > file > default; sources printed by `jevcode config`; non-secret `config set`; keybindings file with chords (3 s) as F14 fixes | A24, A73, A83, A94, A96, A97, A130, A135, A168, P21, P48 |

Standing rules inherited by every section: `<Static>` is the only scrollback writer; the dynamic region
never exceeds `rows − 2`; zero network before the first frame; zero terminal clears after it; rendering
never blocks the loop; keys never appear in logs; every visual has `--plain`, `--screen-reader` and
`--ascii` twins built from shared `lines()` functions (A25, A49, A80, A90, A94–A98).

## 0. Thesis, and how the fixed decisions are honoured

**Thesis (minimal-robust, kept).** Every modal thing — review box, wizard, follow-up confirm, secret gate
row, blocking pane, palette, undo prompt, exit confirm, minimum-size notice — renders in one slot directly
above the composer, so at most one exists at a time and `computeLayout` has a single allocation order to
prove (§2). Every key is resolved by one pure function over an enumerated state machine (§3), never by
handler order. Every visual has a `lines()` function shared by the four twins, so parity is a unit test.
Robustness is treating each failure class the research measured (08 §11 overflow clears; 17 §1 error
overlay, ENOSPC, 401, 429; 07 §3 SIGHUP, SIGTSTP, resize storms; 13 §4.1 key leak in `JEVCODE_TRACE`;
16 §3 secrets in five sinks; 15 §3.2 `checkout --` from the index) as a state the machine already has a
transition for, with a pty or fault-injection test per class (§19).

**What the grafts add.** jev-native's `DecisionRow` (the code rule that consumed each answer, `!` when a
probability sat within 0.03 of its threshold) and its worked `/why` block make the pane Jev-native rather
than a log (§7); sessions' `run.lock`, seed-source rule, `v:1` index/stream envelopes, seed-carried
`undoLog`, `post/<step>.json` with `cleanAtStart`, and the ten-run walkthrough close 00 §8 items 6 and 13
(§8, §19.7); composer-first's additive contract shape (`confirmDetailed?`, optional event fields), its
pure interrupt reducer and its rule that a slash typo never becomes a paid run (§3, §5, §15).

| Fixed | Honoured in | How |
| --- | --- | --- |
| F1 | §1 | bare `jevcode`/`chat` → session TUI; `run "<task>"` one-shot; `--plain` TTY readline composer over the same `dispatchCommand()`; non-TTY no composer; `--json` versioned stream; the first-frame gate covers the composer frame |
| F2 | §2, §14 | scrollback-native `<Static>`; region ≤ rows − 2; zero clears; no alt screen/mouse; standard log-update, `--render-mode incremental` opt-in; `maxFps` 30/`--fps`/SSH 15; kitty disabled; universal newline keys; no OSC 11; `--theme dark\|light\|daltonized\|ansi`; `NO_COLOR` shim in `bin/jevcode.js`; ANSI-16 + marker; no backgrounds |
| F3 | §2.1–2.3 | the A109 cap set, the yield order, review collapses the composer, frames at rows 8/12/24/40/50 × 80/120 |
| F4 | §3, §4 | A8 readline set; Enter submits; `/` at column 0; `@`; `?`/F1; Tab completion, no `useFocus`; Ctrl+O appends; Ctrl+G `suspendTerminal`; Ctrl+Z; Ctrl+L = `useStdout().write('')` (erase-lines + repaint, never `instance.clear()`); no leader/Ctrl+P/Ctrl+K palette; Up/Down row rule; Ctrl+R; no `!`, no `/compact` |
| F5 | §3.3 | the matrix with F5's cells; `human_pause`; 30 ms re-buffer; DESIGN §11's second-Ctrl-C invariant |
| F6 | §6 | `y n Esc d e w+digit Ctrl-C`; keys on row 2; gauge rows + `matches_intent`; ~1 s idle deferral with drained input; never always/Enter/default/timeout/`--auto-decline`; `alwaysDecline` untouched |
| F7 | §8 | `sessionId`/`parentRunId`/`source`; seeded follow-up; `Engine.steer/unsteer/pause`; `pendingDirectives`; `index.jsonl`; picker keys per A56; `-c`; `--resume <id\|title>`; title = 60 chars + `/rename`; `history.jsonl`; `StepRecord.planAfter`; `/export`; `/theme` new items only; pending `/budget` in memory |
| F8 | §9 | parent meter, child `min(runCap, remaining)`, default 5 × run cap, `none`, 50/80/95 %, `y/r/n` Enter inert, `/budget` scopes, unpriced fails closed naming `--allow-unpriced`, `jevcode config` prints the derived cap, no pre-emption |
| F9 | §10 | `detectSecrets` gate on every submission and steer; `addSecret` on `y`; raw provider request + count-only ack; `useRef` paste map, 1 MiB, 12,000-char notice; `@` denylist via `isSecretPath()`; redacted clipboard, OSC 52 write only; key-class trace; chip label; `sk-proj-` = OpenAI |
| F10 | §11 | `missingSecrets(mode)` probe; ≤ 4-row wizard; masked field rules; XDG 0600 write; optional verification; trust gate; sandbox line; `/login`; composer never a credential; `--no-input` fix block exit 2; `trust.json` sha256; `AGENTS.md` rules; Windows ACL note |
| F11 | §12 | two spawns; banner; `fs.watch` zone; pre/post images; verify-before-write `/undo`; `git restore --source=HEAD --worktree`; `/rewind`; `/diff` formats; seatbelt `gitDir`/`gitCommonDir` |
| F12 | §13 | `retry` events + 1 Hz row + `[r]`; pacing; `PaneBoundary`; `fatalExit` order; epilogue; disk pause exit 3; 401 → 2 + `/login`; `jevcode.log`; `report`; `!n`; failed retries not persisted; exit codes |
| F13 | §15 | one ordered additive list with exact signatures and insertion points; jev-only preservation checklist; `src/synth/**` untouched; the three-way line identity kept for the whole run through `Engine.annotate()` (§15.1) |
| F14 | §16 | one schema table with precedence and sources (the launch rows fps/render-mode/screen-reader/ascii resolve flag > env > default and are fixed at mount, forced by F1's zero-file first frame — §16, §22); keybindings file with `namespace:action`, `"none"`, chords 3 s, reserved keys |
| F15 | §17 | zero-dependency package, `THIRD_PARTY_LICENSES.txt`, `files`, minify+keepNames, version define, Node ≥ 22.12 guard, LICENSE, CI gates, completions, man page, upgrade, notifier, dist-tags, tap, trusted publishing, `--version --json` |
| F16 | §7 | tabs d/p/t/s with `[`/`]`; bars; timeline letters; synth strip (free text until the structured fields land); loop banner; three-zone status line; sparkline at ≥ 100; `/why`, `/calibration`; Ctrl+O; toasts; twins; spinner rules |
| F17 | §5.4 | dependency-free prefix-then-subsequence scorer, ≤ 8 rows, ≤ 16 ms per keystroke over 5,000 candidates measured in a unit test |
| F18 | §15–§20 | no new runtime deps; strict TS, no `any`, ESM, Node 22; offline unit tests per module; pty via `expect(1)`/`script(1)`; perf gates kept and extended |

**Kept from today, untouched:** `itemsFromEvent`/`formatTranscriptItem` as the one item source (`plain.ts:206`, `:278`), the `synth` event → one transcript line (`plain.ts:229–231`), the `propose [synth]` status marker (`StatusLine.tsx:23`), the `NullProvider` + `createSynthesizer` path and the fact that `config.generator()` is never called under `--mode jev-only` (`main.tsx:53–57`, `:162`), `alwaysDecline`, `createTuiConfirmer`'s "a second request declines the first" (`useEngine.tsx:192`), `LIVE_FLUSH_MS = 50`, `DECISIONS_KEPT = 12`, `UNMOUNT_TIMEOUT_MS = 2000`.

## 1. Entry points and modes

| Invocation | TTY? | Renderer | Composer | Run starts | Exit |
| --- | --- | --- | --- | --- | --- |
| `jevcode`, `jevcode chat` | yes | Ink `<App mode="session">` | Ink composer; first frame < 300 ms; no run | first Enter (or `-c`/`--resume` → picker/continue) | `/exit`, Ctrl-D ×2, Ctrl-C ×2 idle → 0 (`--exit-code=last-run` opt-in) |
| `jevcode run "<task>"`, `--task-file`, `--resume <id\|title>` | yes | Ink `<App mode="one-shot">` (today's monitor) | mounted for steering only (Enter = steer while live) | right after `run:ready` | `exitCodeFor(stop, error, degraded)` after `run:end` (§13.5) |
| `jevcode [chat] --plain` | yes | `plain.ts` + `node:readline` line composer (`tui/plain-composer.ts`) | readline `> `; same `dispatchCommand()`; Enter while live = steer | first line | as session |
| `jevcode run … --plain` | yes | `plain.ts` + readline steering | readline | immediately | one-shot codes |
| `--plain` on a pipe, `CI`, `TERM=dumb`, `--no-input` | no | `plain.ts`, no readline, no queries, no 2004 | none; task from argv / `--task-file` / stdin | immediately | one-shot codes; every prompt takes its safe default (C46) |
| `--json` (implies plain, non-interactive) | any | NDJSON writer (§8.9) | none | immediately | one-shot codes; `run:end.exitCode` on the stream |
| `bench`, `perf` | n/a | none / own | none | n/a | `RunMeta.source` = `bench`/`perf`; never write `sessions/index.jsonl` or `history.jsonl`; own root meter |
| `config [--json]`, `config set <k> <v>`, `login`, `logout`, `sessions [list\|reindex\|prune\|unlock <id>]`, `report <id>`, `why <id> <step> <ref>`, `calibration`, `completion bash\|zsh\|fish`, `upgrade`, `--version [--json]`, `--help` | any | stdout text before any Ink import | — | — | 0/1/2/5 |

Rules (A82, A93, A124, C46): `interactive = Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && !isInCi && TERM !== 'dumb' && !flags.plain && !flags.json && !flags.noInput` where `isInCi` is `CI`/`CONTINUOUS_INTEGRATION` set and not `0`/`false`. `--no-input` selecting the plain renderer is a choice, not an accident: an Ink composer is interactive and C46 says "don't prompt or do anything interactive" (composer-first §1.2 over minimal-robust's silence); `jevcode chat --no-input` is a usage error (`--no-input needs a task: use jevcode run`). `parseCliArgs([])` returns `{ command: 'chat' }`; a first token beginning with `-` that is not `--help`/`--version` parses as `chat` flags. `jevcode run` with no task on a TTY → `chat` (A101). The first frame of `chat` is built from argv, `process.env`, `isTTY` and `process.cwd()` only: header item `jevcode session · <basename(cwd)> | step 0/– starting`, the rule, the composer with its placeholder, the status line with the `step 0/–` sentinel. `resolveConfig`, `missingSecrets`, `sessions/index.jsonl`, `trust.json`, `AGENTS.md` and git are touched only after `renderer.firstFrame()` resolves (DESIGN §12 ordering contract; `perf/first-frame.ts` gains the `chat` geometry set, §18). `render()`'s mount-time options (`maxFps`, `incrementalRendering`, `isScreenReaderEnabled`) and the glyph/colour mode come from `resolveLaunchSettings(flags, process.env)` (§16: flag > env > default, pure, **no file**), so an unreadable `--config` still yields the first frame. `keybindings.json` (≤ 64 KiB) and `history.jsonl` (≤ 4 MiB, ≈ 3 ms) are read synchronously in the same tick right after `firstFrame()` resolves — before Ink can dispatch a key — so no key is ever resolved against default bindings or an empty history by timing. Task text from argv, `--task-file` or piped stdin passes `detectSecrets` before `createEngine` (§10.2).

**Session loop (`cli/session.ts` `createSessionController`, driven by `main.tsx` `commandChat`).**

```
render <App mode="session"> (argv only) → firstFrame()
→ read keybindings.json + history.jsonl (sync, same tick) → resolveConfig → renderer.setHost(host) → printWarnings(config.warnings) → missingSecrets(mode) → wizard? → trust gate? → sandbox line → listCandidates(root) once (idle; the `@` list before a run, §5.4)
→ fold sessions/index.jsonl once → recent-session hint row → sessionMeter = createSpendMeter(sessionCapUsd)
→ loop:
    await submit(text, kind)                     // composer Enter after the detectSecrets gate (§10.2)
    kind 'command' → dispatchCommand(line)       // idle-only commands while live → error item, draft kept
    kind 'prompt'  → follow-up gate (§9.3) → seed = buildSeed(seedSource) (§8.3) → run.lock → createEngine({ …, seed, session, instructions, blocker, exit, configDirs })   // git is probed inside createEngine (§12.1)
                   → attach → run() → run:end item (+ exit code) → post-run: index run:end line, epilogue item, re-probe git, notifier if enabled
    Ctrl-C×2 idle | /exit | Ctrl-D×2 → unmount → restoreTerminal() → exit 0
```

One engine is live at a time; `startRun` while live is a programming error (the composer routes Enter to `steer` while `state.done === null`). The one-shot `run` path is the same controller with `mode: 'one-shot'` and `maxRuns = 1`: after `run:end` it unmounts, prints the epilogue to stderr and returns `exitCodeFor`. Both share `RendererOptions.mode`/`host`/`ui` (§15 item 16).

## 2. Layout

### 2.1 `computeLayout(rows, columns, state)` (`src/tui/layout.ts`, pure)

Vertical order, top to bottom: `<Static>` scrollback · **rule** (carries the pane tab header) · **live** (≤ 2: stream tail, synth line, or the retry row) · **banner** (≤ 1: loop/replan) · **pane** (≤ 12: tabs d/p/t/s; the session picker renders in this slot) · **queue** (≤ 2 queued steers) · **overlay** (the one modal slot) · **preview** (review only, ≤ 8, `e` = rest) · **composer** (1–6, 8 at rows ≥ 40) · **status** (1). Allocation order = priority; F3's yield order is its reverse.

```ts
// src/tui/layout.ts (replaces App.tsx:43-58 computeLayout) — A10, A107, A109, C47, D1
export const MIN_ROWS = 8;
export const MIN_COLUMNS = 40;
export const CAP = { live: 2, queue: 2, pane: 12, reviewHeader: 8, preview: 8, wizard: 4, followup: 5, secret: 1,
  blocking: 4, palette: 8, undo: 1, exitConfirm: 1, minsize: 1, composer: 6, composerTall: 8, banner: 1 } as const;
export type OverlayKind = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo' | 'exitConfirm';
/** overlays that collapse the composer to one inactive row (F3) */
const COLLAPSING: ReadonlySet<OverlayKind> = new Set(['review', 'followup', 'blocking', 'exitConfirm']);
export interface LayoutInput {
  rows: number; columns: number;   // from useWindowSize() only (A93); never process.stdout.rows/columns
  overlay: OverlayKind;
  overlayWant: number;             // review 8 · wizard 2–4 · followup 5 · secret 1 · blocking 2–4 · palette 2–8 · undo 1 · exitConfirm 1
  previewWant: number;             // review only: confirmPreviewLines(req).length
  expanded: boolean;               // review `e`: preview may take the pane's rows
  composerWant: number;            // visual rows of the draft, ≥ 1
  queueWant: number;               // queued steers 0..8
  liveWant: number;                // 0..2
  bannerWant: 0 | 1;               // loop signature at x2/3 or a replan directive active (A45)
  paneWant: number;                // 0 until run:ready or a picker; rows the active tab can fill, ≤ 12
}
export interface Layout { budget: number; degraded: 'none' | 'minsize' | 'static-only'; status: number; rule: number; live: number;
  banner: number; pane: number; queue: number; overlay: number; preview: number; composer: number; total: number }
export function computeLayout(i: LayoutInput): Layout {
  const budget = Math.max(0, Math.floor(i.rows) - 2);
  let rem = budget;
  const take = (want: number): number => { const got = Math.max(0, Math.min(Math.floor(want), rem)); rem -= got; return got; };
  const z: Layout = { budget, degraded: 'none', status: 0, rule: 0, live: 0, banner: 0, pane: 0, queue: 0, overlay: 0, preview: 0, composer: 0, total: 0 };
  if (i.rows < 3) { z.degraded = 'static-only'; return z; }                       // budget 0 or 1: <Static> keeps flowing, nothing dynamic
  if (i.rows < MIN_ROWS || i.columns < MIN_COLUMNS) {                              // A100: status · notice · composer
    z.degraded = 'minsize'; z.status = take(1); z.overlay = take(CAP.minsize); z.composer = take(1); z.total = budget - rem; return z;
  }
  z.status = take(1);                                                              // 1 never yields
  z.rule = take(1);                                                                // 2 never yields at rows ≥ 8
  if (i.overlay !== 'wizard') z.composer = take(1);                                // 3 composer floor ("composer-to-1" is the last yield); the wizard IS the input (refund)
  z.overlay = take(i.overlay === 'none' ? 0 : i.overlayWant);                      // 4 modal slot (review header: keys line is row 2)
  const cap = COLLAPSING.has(i.overlay) ? 1 : i.rows >= 40 ? CAP.composerTall : CAP.composer;
  if (i.overlay !== 'wizard') z.composer += take(Math.min(i.composerWant, cap) - 1); // 5 composer growth
  z.queue = take(Math.min(i.queueWant, CAP.queue));                                // 6 queue ≤ 2
  z.preview = i.overlay === 'review' ? take(Math.min(i.previewWant, i.expanded ? rem : CAP.preview)) : 0; // 7
  z.live = i.overlay === 'review' ? 0 : take(Math.min(i.liveWant, CAP.live));      // 8 live rows are reclaimed by a pending review (A42)
  z.banner = take(i.bannerWant);                                                   // 9
  z.pane = i.expanded ? 0 : take(Math.min(i.paneWant, CAP.pane));                  // 10 pane yields first
  z.total = budget - rem;
  return z;
}
```

Invariants (unit-tested over rows 2..60 × columns 20..400 × every `OverlayKind` × wants 0..12): `total ≤ budget`; `status === 1` whenever `rows ≥ 3`; `composer ≥ 1` whenever `rows ≥ 5 && overlay !== 'wizard'`; `overlay === overlayWant` whenever `rows ≥ max(8, overlayWant + 5)` for every non-wizard overlay (status, rule and the composer floor take three rows of the `rows − 2` budget before the overlay is allocated: review want 8 is whole from rows 13, F-H at rows 12 gets 7) and whenever `rows ≥ max(8, overlayWant + 4)` for the wizard (no composer floor); under pressure the fields reach 0 in the order pane, banner, live, preview, queue, composer growth, overlay (never below what §6.1's ladder needs at rows ≥ 8: the review header always gets ≥ 3 rows); `computeLayout` ≤ 5 µs. The review header is cut by `reviewHeaderLines(req, n)` (§6.1), never by Ink wrapping; every pane is `<Box height={n} overflow="hidden">` of `<Text wrap="truncate">` rows. Below `MIN_ROWS` the transcript keeps flowing into `<Static>`.

Which designs disagreed and what was taken: jev-native's function granted the queue before composer growth (inverting F3); sessions' tables disagreed with its own function; composer-first hides the composer for the picker and help. Taken: minimal-robust's order (verified F3-correct by the engineering judge), jev-native's wizard refund (the wizard replaces the composer, so a `> (setup)` row is a wasted row), composer-first's `rows < 3` branch (minimal-robust lacked it), and the picker in the pane slot with the composer as the filter (a picker without a typing field would need its own input row).

### 2.2 Allocation table (rule·live·banner·pane·queue·overlay·preview·composer·status = total of budget), recomputed from the function

| State (wants) | rows 8 (b 6) | rows 12 (b 10) | rows 24 (b 22) | rows 40 (b 38) | rows 50 (b 48) |
| --- | --- | --- | --- | --- | --- |
| idle, session start (pane 0, composer 1) | 1·0·0·0·0·0·0·1·1 = 3 | 3 | 3 | 3 | 3 |
| idle after a run (pane 12, composer 1) | 1·0·0·3·0·0·0·1·1 = 6 | 1·0·0·7·0·0·0·1·1 = 10 | 1·0·0·12·0·0·0·1·1 = 15 | 15 | 15 |
| idle, 6-row draft (pane 12) | composer 4, pane 0 = 6 | composer 6, pane 2 = 10 | composer 6, pane 12 = 20 | 20 | 20 |
| idle, 9-row draft (cap 8 at ≥ 40) | composer 4 = 6 | composer 6 = 10 | composer 6 ↓3 marker = 20 | composer 8, pane 12 = 22 | 22 |
| live, streaming (live 2, pane 12) | 1·2·0·1·0·0·0·1·1 = 6 | 1·2·0·5·0·0·0·1·1 = 10 | 1·2·0·12·0·0·0·1·1 = 17 | 17 | 17 |
| live, 2 queued, 1-row draft (live 2, queue 2) | 1·1·0·0·2·0·0·1·1 = 6 | 1·2·0·3·2·0·0·1·1 = 10 | 1·2·0·12·2·0·0·1·1 = 19 | 19 | 19 |
| live, 2 queued, 3-row draft | composer 3, queue 1, live 0, pane 0 = 6 | composer 3, queue 2, live 2, pane 1 = 10 | composer 3, queue 2, live 2, pane 12 = 21 | 21 | 21 |
| live + loop banner (live 2, banner 1) | 1·2·1·0·0·0·0·1·1 = 6 (pane yields) | 1·2·1·4·0·0·0·1·1 = 10 | 1·2·1·12·0·0·0·1·1 = 18 | 18 | 18 |
| review pending (header 8, preview 4) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·0·0·7·0·1·1 = 10 | 1·0·0·7·0·8·4·1·1 = 22 | 1·0·0·12·0·8·4·1·1 = 27 | 27 |
| review + `e` (preview 30 lines) | as above | as above | 1·0·0·0·0·8·11·1·1 = 22 | 1·0·0·0·0·8·27·1·1 = 38 | 1·0·0·0·0·8·30·1·1 = 41 |
| palette open (8 rows incl. footer, composer 1) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·0·0·7·0·1·1 = 10 | 1·0·0·11·0·8·0·1·1 = 22 | 1·0·0·12·0·8·0·1·1 = 23 | 23 |
| picker open (pane slot, 12 rows incl. header) | 1·0·0·3·0·0·0·1·1 = 6 | 1·0·0·7·0·0·0·1·1 = 10 | 1·0·0·12·0·0·0·1·1 = 15 | 15 | 15 |
| onboarding wizard (4 rows; composer refunded) | 1·0·0·0·0·4·0·0·1 = 6 | 6 | 6 | 6 | 6 |
| `/login` mid-run (wizard 4, live 2, pane 12) | 6 | 1·2·0·2·0·4·0·0·1 = 10 | 1·2·0·12·0·4·0·0·1 = 20 | 20 | 20 |
| follow-up budget confirm (5, pane 12, composer 1) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·2·0·5·0·1·1 = 10 | 1·0·0·12·0·5·0·1·1 = 20 | 20 | 20 |
| retry row (live 1–2, pane 12) | 1·2·0·1·0·0·0·1·1 = 6 | 1·2·0·5·0·0·0·1·1 = 10 | 1·2·0·12·0·0·0·1·1 = 17 | 17 | 17 |
| secret gate row (overlay 1, 3-row draft) | 1·0·0·0·0·1·0·3·1 = 6 | 1·0·0·4·0·1·0·3·1 = 10 | 1·0·0·12·0·1·0·3·1 = 18 | 18 | 18 |
| blocking pane (4, pane 12, composer 1) | 1·0·0·0·0·3·0·1·1 = 6 | 1·0·0·3·0·4·0·1·1 = 10 | 1·0·0·12·0·4·0·1·1 = 19 | 19 | 19 |
| minimum size (rows 5–7 or columns < 40) | rows 6: notice 1 + composer 1 + status 1 = 3 of 4 | — | — | — | — |
| rows 3–4 | status 1 (+ notice at rows 4) | — | — | — | — |
| rows ≤ 2 | nothing dynamic; `<Static>` only | — | — | — | — |

At rows 40 and 50 nothing but the composer cap (8) changes; the region never exceeds 27 rows without `e`, and the remaining rows are scrollback (08 §11: an over-budget frame costs 29,765 B and one `ESC[2J` per keystroke). Columns change row contents (§6, §7), never row counts, except the 40-column minimum.

### 2.3 Worked frames

Legend: `>` composer prompt; `·` bar track; `⠹` spinner; `⎇` git zone (`br` in ASCII). Rows above the rule are `<Static>` scrollback shown only where they matter. Each caption gives `columns×rows` and the dynamic row count; §19.1 keeps a unit test that measures every fenced block of this file against its caption (widths ≤ columns, dynamic rows = caption).

**F-A. Idle composer, session start, 80×8 (3 dynamic rows; 3 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting
[sandbox] seatbelt — writes confined to the workspace and run dirs
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)
────────────────────────────────────────────────────────────────────────────────
> Describe the task…   / commands · @ files · ? help · Enter runs
idle                                       step 0/–  sess $0.00/10.00 ok  ? help
```

**F-B. Idle composer after run 7, 80×24 (15 dynamic rows; 3 scrollback rows above; decisions tab; `!` marks a near-threshold p)**

```
[step 7] judge succeeded=0.89 error_present=0.04 new_info=0.61 tests=41p/0f/0e …
[run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
[ui] stopped — max_steps (exit 4) · raise: /budget max-steps 14, then /resume
─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 context  tests/test_a.py  noul   █████▏···· !0.52  c 0.04~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~
> Follow-up or /command…   Enter runs · ↑ history · Esc Esc menu · ? help
idle exit 4      step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**F-C. Live run, generator streaming, 80×12 (10 dynamic rows: rule 1 + live 2 — the last two stream lines; the counter row `streaming… 1.2k chars` shows alone until the first line break arrives (§7, `liveLines()`) — + pane 5 + composer 1 + status 1)**

```
─── decisions s3 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
  the timezone. I will make parse_date return an aware datetime by replacing
  strptime with fromisoformat and normalising naive inputs to UTC before the
s3 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s3 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s3 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s3 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s3 context  tests/test_a.py  noul   ██████▏···  0.61  c 0.22~
> Type to steer the next step…   Esc pauses · Esc Esc aborts
⠹ propose       step 3/40 1m02s  run $0.09/2.00 ok  sess $0.40/10.00 ok  ? help
```

**F-D. Live run, streaming, 120×50 (17 dynamic rows; two tabs side by side because `columns ≥ 120 && rows ≥ 40 && overlay === 'none'` (§7.2); status gains the git zone and the Jev sparkline)**

```
─── decisions s3 · c~ derived |2p−1| ────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─── plan ─
  the timezone. I will make parse_date return an aware datetime by replacing strptime with fromisoformat and
  normalising naive inputs to UTC; the docstring will state the assumption and the CHANGELOG gets one line.
s3 intent  intent          edit  ██████▍··· 0.64 chosen      │ plan  done 2  remaining 3  unverified 1  problems 1
s3 intent  can_edit        noul  ████████▏· 0.81             │ [x] add failing test for parse_date       s1 done_0 0.91
s3 intent  can_verify      noul  ███▏······ 0.31             │ [x] locate the tz handling in parse_date  s2 done_0 0.88
s3 intent  plan_still_val… noul  ████████▊· 0.88             │ [?] update CHANGELOG                       s2 done_1 0.52
s3 context src/a.py        noul  ███████▊·· 0.78             │ [ ] make parse_date timezone-aware
s3 context tests/test_a.py noul  ██████▏··· 0.61             │ [ ] run full suite
s3 context src/utils.py    noul  ██▍······· 0.24             │ [ ] remove debug print in utils.py
s2 judge   succeeded       noul  █████████· 0.90             │ [!] replan s2 change_approach: try tz-aware parsing
s2 judge   error_present   noul  ▌········· 0.05             │
s2 judge   new_information noul  ██████▏··· 0.62             │
s2 judge   done_0          noul  ███████▊·· 0.78             │
s2 complete task_complete  noul  ████▍····· 0.44             │
> Type to steer the next step…   Esc pauses · Esc Esc aborts · ? help
⠹ propose                step 3/40 1m02s  run $0.09/2.00 ok  sess $0.40/10.00 ok  ⎇ main · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  ? help
```

**F-E. Live run with 2 queued steers, 80×24 (19 dynamic rows: rule + live 2 + pane 12 + queue 2 + composer 1 + status)**

```
─── decisions s5 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
$ pytest -q tests/test_a.py
....F                                                                    [100%]
s5 intent   intent           verify ███████▏··  0.71  c 0.60   chosen
s5 intent   can_verify       noul   ████████▌·  0.85  c 0.70~
s5 intent   plan_still_valid noul   ████████··  0.80  c 0.60~
s5 context  tests/test_a.py  noul   ████████▍·  0.84  c 0.68~
s5 context  src/a.py         noul   ███████···  0.70  c 0.40~
s4 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s4 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s4 risk     plan_mismatch    L0     ███████▌··  0.75  c 0.80   [ok]
s4 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s4 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s4 judge    succeeded        noul   ████████▍·  0.84  c 0.68~
s4 judge    error_present    noul   ▊·········  0.09  c 0.82~
↑1 queued for step 6: use datetime.fromisoformat instead of strptime
↑2 queued for step 6: also update CHANGELOG.md                    [↑ takes back]
> _
⠼ execute       step 5/40 2m41s  run $0.17/2.00 ok  sess $0.48/10.00 ok  ? help
```

**F-F. Live run, 2 queued steers, 3-row draft, 80×8 (6 dynamic rows: the F3 yield — live 0, pane 0, queue 1, composer 3)**

```
────────────────────────────────────────────────────────────────────────────────
↑2 queued for step 6: also update CHANGELOG.md                    [↑ takes back]
> and when the suite is green, update the docstring of parse_date so the tz
  assumption is spelled out; keep the public signature unchanged and do not
  add a version number to CHANGELOG.md
⠼ execute       step 5/40 2m41s  run $0.17/2.00 ok  sess $0.48/10.00 ok  ? help
```

**F-G. Review pending, 80×24 (22 dynamic rows: rule 1 + pane 7 + header 8 + preview 4 + composer 1 (inactive) + status 1)**

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
1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task asks
3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification step
4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restorable
5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of the…
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
> (review pending — keys above; d opens a note)
review           step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**F-H. Review pending, 80×12 (10 dynamic rows: header cut to 7 by `reviewHeaderLines(req, 7)` — ruler dropped, keys line survives)**

```
────────────────────────────────────────────────────────────────────────────────
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task asks
3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification step
4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restorable
5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of the…
> (review pending)
review           step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**F-I. Review pending, 80×8 (6 dynamic rows: header 3 — title, keys, one compact row with the two highest dimensions, max first)**

```
────────────────────────────────────────────────────────────────────────────────
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93
> (review pending)
review           step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**F-J. Review pending, 120×40 (27 dynamic rows: rule + pane 12 as one wide tab — not side by side, because `overlay !== 'none'` (§7.2) — + header 8 with `P(l) E[k] tail` + preview 4 + composer 1 + status)**

```
─── decisions s7 · c~ derived |2p−1| ─────────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  choice resolution → intent edit
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~             231ms  paired ≥ 0.5
s7 intent   can_verify       noul   ███▏······  0.31  c 0.38~             231ms  paired ≥ 0.5
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~             231ms  < 0.3 → stale_plan
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~             198ms  selected iff p ≥ 0.5
s7 context  tests/test_a.py  noul   █████▏···· !0.52  c 0.04~             198ms  selected iff p ≥ 0.5 (near)
s7 context  src/utils.py     noul   ██▍·······  0.24  c 0.52~             198ms  selected iff p ≥ 0.5
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]       244ms  band 0.3/0.7 (expected)
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]       244ms  band 0.3/0.7 (tail)
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]   244ms  band 0.3/0.7 (tail)
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]       244ms  band 0.3/0.7 (expected)
s7 risk     matches_intent   noul   ████████▊·  0.88  c 0.76~             244ms  < 0.3 → appended to the reason
review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"             jev 244ms
[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run
dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)
1 destructive  L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverable
2 out_of_scope L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]`/`task` asks
3 plan_mismatch L2 ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step
4 irreversible L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git cmd
5 matches_intent   ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent `edit`
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
> (review pending — keys above; d opens a note)
review              step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  ? help
```

**F-K. Palette open on `/b`, 80×24 (22 dynamic rows: rule + pane 11 (plan tab) + palette 8 + composer 1 + status)**

```
─── plan s7 · done 2 rem 3 unv 1 prob 2 ─── [d]ecisions [p]lan [t]ime [s]ynth ──
[x] add failing test for parse_date                 s4  done_0 0.91
[x] fix parse_date tz handling                      s6  done_0 0.78
[?] update CHANGELOG                                s7  done_1 0.52  unverified
[ ] run full suite
[ ] remove debug print in utils.py
[!] replan s6 change_approach: try tz-aware parsing instead of string ops
[!] rejected_claim s5: "tests pass" done_0 0.12




▌ /budget        show or set caps (spend-cap, session-spend-cap, …)  Suggested
  /abort         stop the run now (= Esc Esc); the step in flight is discarded
  /calibration   reliability bins, ECE and near-threshold counts (idle only)
  /budget spend-cap <usd>            run cap for the next /resume or run
  /budget session-spend-cap <usd>    session cap, applies now
  /budget max-steps <n>              step limit for the next /resume or run
  /budget max-wall <dur>             wall limit for the next /resume or run
  (1/3)  Tab completes · Enter runs an exact match · Esc closes
> /b_
palette          step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  Tab ⇥
```

**F-L. Session picker (`/resume`), 80×24 (15 dynamic rows: picker in the pane slot 12 incl. header; composer = filter)**

```
─── sessions · proj (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────
▌  2 h ago   7   max_steps   $0.31   fix parse_date tz
   1 d ago  12   complete    $0.98   add retry to the OpenRouter client
   3 d ago  25   spend_cap   $1.53   migrate tests to pytest
   5 d ago   4   human_pause $0.04   refactor CLI args                  ● live
   6 d ago   3   error       $0.02   explore repo layout
  preview: plan done 2/5 · remaining 3 · spend $0.310 · stop max_steps @ step 7
  [step 7] judge succeeded=0.89 … completion=0.68
  [run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
  Enter: continue as a follow-up · Space: preview · Ctrl-R: rename · x: delete



> filter: par_
picker           step 0/–  sess $0.00/10.00 ok  Esc closes
```

**F-M. Onboarding wizard, provider step, 80×24 (5 dynamic rows; 1 scrollback row above: rule + wizard 3 + status; composer refunded)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
No API key found. Pick the generator provider:
  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)
Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)
setup                                                                  step 0/–
```

**F-N. Onboarding wizard, key field, 40×8 (5 dynamic rows: the minimum geometry)**

```
────────────────────────────────────────
Jev API key (JEV_API_KEY)  2/2
> •••••••••••••••••••••••••••••••••••••
108 · Enter · ⌫ · ^U · Esc
setup                          step 0/–
```

**F-O. Trust gate, 80×24 (6 dynamic rows: rule + trust 4 + status)**

```
────────────────────────────────────────────────────────────────────────────────
Do you trust the files in /Users/x/repo?  (git root; stored per repository)
  AGENTS.md (2.1 KiB) → generator system prompt   ./.env (3 vars, 2 secret-like)
  jevcode.json (none)
  1 trust   2 this session only   3 don't trust (AGENTS.md ignored; .env read)
setup                                                                  step 0/–
```

**F-P. Follow-up budget confirm, 80×24 (20 dynamic rows: rule + pane 12 + box 5 + composer 1 (inactive) + status)**

```
─── decisions s7 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 context  tests/test_a.py  noul   █████▏···· !0.52  c 0.04~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~
┌ follow-up would exceed the session cap ──────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │
└──────────────────────────────────────────────────────────────────────────────┘
> also update the CHANGELOG                                 (waiting for y/r/n)
idle exit 4      step 7/7 4m12s  run $0.71/2.00 ok  sess $9.58/10.00 critical
```

**F-Q. Follow-up budget confirm, 80×12 (10 dynamic rows: rule + pane 2 + box 5 + composer 1 + status)**

```
─── decisions s12 ───────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
s12 judge   task_complete    noul   ████████▌·  0.85  c 0.70~
s12 risk    plan_mismatch    L0     █████████·  0.90  c 0.88   [ok]
┌ follow-up would exceed the session cap ──────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │
└──────────────────────────────────────────────────────────────────────────────┘
> now add the CHANGELOG entry                               (waiting for y/r/n)
idle exit 0     step 12/40 6m01s  run $0.71/2.00 ok  sess $9.58/10.00 critical
```

**F-R. Retry row inside the live region, 80×12 (10 dynamic rows; 1 Hz; spinner frozen under reduced motion)**

```
─── decisions s1 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now
last: HTTP 429 free-models-per-min · request-id gen-abc123
(no decisions yet)




> _
retrying 2/3    step 0/40 0m26s  run $0.00/2.00 ok  sess $0.00/10.00 ok  ? help
```

**F-S. Minimum-size notice, 80×6 (3 dynamic rows of a 4-row budget; 2 scrollback rows above; transcript keeps flowing)**

```
[step 2] outcome executed: applied edit to src/a.py changed=1: src/a.py
[step 3] intent=verify p=0.71 c=0.60
terminal 80×6 is below the 40×8 minimum — panes hidden, transcript above
> _
⠹ context       step 3/40 1m02s  run $0.09/2.00 ok
```

**F-T. Idle composer with a 6-row draft, 80×40 (20 dynamic rows: rule + pane 12 (timeline tab) + composer 6 + status)**

```
─── timeline s7 ─────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s
      s7  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 8.2s  h 31ms
time  s6  intent .20s  ctx .22s  propose 4.9s  risk .22s  exec 1.6s  judge .18s
      s6  ICPPPPPPPPPPPPPPPPPPPPPPRXXXXXXXXXXXXXXJ  total 7.4s  h 24ms
time  s5  intent .19s  ctx .25s  propose 4.4s  risk .21s  exec 1.7s  judge .17s
      s5  ICPPPPPPPPPPPPPPPPPPPPPRRXXXXXXXXXXXXXXJ  total 6.9s  h 27ms
time  s4  intent .22s  ctx .24s  propose 5.6s  risk .24s  exec 1.1s  judge .19s
      s4  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 7.7s  h 29ms
time  s3  intent .20s  ctx .21s  propose 5.0s  risk .22s  exec 1.3s  judge .18s
      s3  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXXXXJ  total 7.1s  h 25ms
time  s2  intent .20s  ctx .23s  propose 4.7s  risk .21s  exec 0.9s  judge .17s
      s2  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXJ  total 6.4s  h 22ms
> Next, make the CLI accept an ISO timestamp with an explicit offset and add
  a regression test for "2026-09-20T12:00:00+02:00". Keep the public signature
  of parse_date unchanged; add a keyword-only argument `assume_utc=True`.
  Update the docstring and CHANGELOG.
  [Pasted #1, 42 lines]
  (the previous run's notes are in the paste above)                           ↓2
idle exit 4      step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**F-U. Blocking pane (first-call 401), 80×24 (19 dynamic rows: rule + pane 12 + blocking 4 + composer 1 (inactive) + status)**

```
─── decisions s0 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
(no decisions yet)











jev: key rejected (HTTP 401 — "User not found.")
Set the decider key and retry. Consulted: env JEV_API_KEY, OPENROUTER_API_KEY
The key is never printed or logged.
[r] retry with the current key   [l] /login   [q] stop (exit 2)
> (paused — answer the pane above)
paused: key rejected   step 0/40 0m03s  run $0.00/2.00 ok  sess $0.00/10.00 ok
```

**F-V. Secret gate row, 80×12 (10 dynamic rows: rule + pane 4 + gate 1 + composer 3 + status; the detected 39-char span renders as `•` cells of equal width (§4.3), so no frame carries the bytes and §19.4's "any frame" sweep holds before submit)**

```
─── decisions s2 ────────────────────────── [d]ecisions [p]lan [t]ime [s]ynth ──
s2 judge    succeeded        noul   ████████▍·  0.84  c 0.68~
s2 judge    error_present    noul   ▊·········  0.09  c 0.82~
s2 judge    done_0           noul   ████████▊·  0.88  c 0.76~
s2 complete task_complete    noul   ███▏······  0.31  c 0.38~
Looks like this contains a secret (sk-ant-…). Send anyway? y/N
> use this key for the smoke test only: •••••••••••••••••••••••••••••••••••••••
  and then remove it from the config before you commit anything; run the
  suite twice
idle exit 0   step 2/40 0m41s  run $0.05/2.00 ok  sess $0.05/10.00 ok  ⚠ secret?
```

**F-W. Ctrl-D with a live run (second press), 80×24 (3 of 19 dynamic rows shown: the `exitConfirm` overlay is one row; composer collapsed)**

```
a run is live: [y] abort and exit   [n] stay              (Enter does nothing)
> (waiting for y/n)
⠼ execute       step 5/40 2m41s  run $0.17/2.00 ok  sess $0.48/10.00 ok  ? help
```

**F-X. Review pending, 120×8 (6 dynamic rows: rule + header 3 + composer 1 (inactive) + status 1; the 120-column compact row carries three dimensions, max-risk first; the status line keeps `review`, the git zone and the sparkline — nothing is dropped at 120 columns because the centre never appears below 140, §7.4)**

```
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"             jev 244ms
[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline      [ctrl-c] abort run
3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93 | 5 matches_intent p=0.88 noul c=0.76~
> (review pending)
review              step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  ? help
```

**F-Y. Retry row inside the live region with the pane, 120×12 (10 dynamic rows: rule + live 2 (retry row + `last:` cause row) + pane 5 with the `latencyMs` and `consumedBy` columns + composer 1 + status 1; two trailing spaces in the sparkline are two failed attempts; `retrying 2/3` occupies the ≤ 22-cell left zone)**

```
─── decisions s3 · c~ derived |2p−1| ─────────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)                                            [r] retry now
last: HTTP 429 free-models-per-min · request-id gen-abc123
s3 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  choice resolution → intent edit
s3 intent   can_edit         noul   ████████▏·  0.81  c 0.62~             231ms  paired ≥ 0.5
s3 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~             231ms  < 0.3 → stale_plan
s2 judge    succeeded        noul   ████████▉·  0.89  c 0.78~             198ms  reported
s2 complete task_complete    noul   ██████▊···  0.68  c 0.36~             198ms  ≥ 0.85 → stop
> _
retrying 2/3        step 3/40 1m26s  run $0.09/2.00 ok  sess $0.40/10.00 ok  ⎇ main · 1~  jev ▂▃▂▅▂▂▇▃▂▁    ? help
```

**F-Z. Palette open on `/b`, 120×24 (22 dynamic rows: rule + pane 11 (plan tab; 120 columns add the evidence / open-problem column) + palette 8 + composer 1 + status 1; drop order check: left `palette` 20 + right zone 95 = 115 cells, so the centre (needs ≥ 24 free) is absent and `Tab ⇥` survives)**

```
─── plan s7 · done 2 rem 3 unv 1 prob 2 ──────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
[x] add failing test for parse_date                 s4  done_0 0.91   evidence tests 41p/0f/0e
[x] fix parse_date tz handling                      s6  done_0 0.78   evidence tests 41p/0f/0e
[?] update CHANGELOG                                s7  done_1 0.52   unverified · no test evidence yet
[ ] run full suite
[ ] remove debug print in utils.py
[!] replan s6 change_approach: try tz-aware parsing instead of string ops
[!] rejected_claim s5: "tests pass" done_0 0.12                        open: test_parse_offsets is flaky




▌ /budget        show or set caps (spend-cap, session-spend-cap, max-steps, max-wall, max-replans)             Suggested
  /abort         stop the run now (= Esc Esc); the step in flight is discarded
  /calibration   reliability bins, ECE and near-threshold counts (idle only)
  /budget spend-cap <usd>            run cap for the next /resume or run
  /budget session-spend-cap <usd>    session cap, applies now
  /budget max-steps <n>              step limit for the next /resume or run
  /budget max-wall <dur>             wall limit for the next /resume or run
  (1/3)  Tab completes · Enter runs an exact match · Esc closes
> /b_
palette             step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  jev ▂▃▂▅▂▂▇▃▂▁▂▃  Tab ⇥
```

**F-AA. Idle composer with a 9-row draft, 80×50 (22 dynamic rows: rule + pane 12 + composer 8 (the ≥ 40-row cap; `↓1` marks the hidden ninth row) + status 1; at rows ≥ 40 only the composer cap changes — the remaining 26 rows are scrollback)**

```
─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 context  tests/test_a.py  noul   █████▏···· !0.52  c 0.04~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~
> Next, make the CLI accept an ISO timestamp with an explicit offset and add
  a regression test for "2026-09-20T12:00:00+02:00". Keep the public signature
  of parse_date unchanged; add a keyword-only argument `assume_utc=True`.
  Update the docstring and CHANGELOG. Then run the suite twice: once with
  TZ=UTC and once with TZ=Asia/Kolkata, and paste both summaries into the
  PR description. Do not touch the legacy/ directory or bump the version.
  [Pasted #1, 42 lines]
  (the previous run's notes are in the paste above)                           ↓1
idle exit 4      step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

At 120 columns every 80-column frame above keeps its row count (F-X, F-Y, F-Z, F-J and F-D are the 120-column witnesses at rows 8/12/24/40/50); rows gain the latency and `consumedBy` columns (pane — one wide tab unless §7.2's side-by-side rule `columns ≥ 120 && rows ≥ 40 && overlay === 'none'` holds), the `P(l) E[k] tail` columns (review), three dimensions per compact review row instead of two, the git zone and the sparkline. The status centre (run id or `/rename` title) appears only when ≥ 24 cells remain after the right zone; with the git zone and sparkline present that is never the case at 120 columns (F-X/F-Z: 115 of 120 cells used) and first happens at ≥ 140. `--ascii` twins substitute per §14.1's glyph table; `--screen-reader` renders the same `lines()` output without bars (§7.1).

## 3. Keymap, key contexts and the Ctrl-C / Esc / Ctrl-D state machine

### 3.1 Contexts and the resolver (A14, A17, A13)

One `useInput` and one `usePaste` in `<App>`, both `{ isActive: Boolean(isRawModeSupported) }`; no `useFocus` anywhere (nothing registers, so Tab keeps completion semantics). Every key goes through `resolveKey(ui: KeyState, k: KeyEvent, nowMs: number): KeyAction[]` (`src/tui/keys/resolve.ts`, pure) where

```ts
export interface KeyState {
  overlay: OverlayKind; reviewArmed: boolean;            // reviewArmed: the review box was drawn on a previous frame (§6.4)
  run: 'none' | 'starting' | 'live' | 'aborting' | 'pausing' | 'paused';
  draftEmpty: boolean; cursorRow: 'first' | 'mid' | 'last' | 'only'; historySearch: boolean; queue: number;   // 'only': a one-row draft is both first and last (§4.6: Up recalls older, Down newer)
  mode: 'session' | 'one-shot'; noteMode: boolean;
  retrying: boolean;                                     // the retry row is up (§13.2): bare `r` on an empty draft = retryNow
  armed: { ctrlCAt: number | null; escAt: number | null; ctrlDAt: number | null; escBufferAt: number | null };
}
```

Contexts in precedence order: **Minsize** (rows < 8: Ctrl-C/D, Enter, text only) · **Overlay** (review, wizard, follow-up, secret, blocking, palette, undo, exitConfirm; each consumes its own keys and passes the rest to the composer only where §3.3 says so) · **Picker** (modal, in the pane slot: ↑/↓, Ctrl-P/N, PgUp/PgDn, Enter, Tab, Space, Ctrl-A, Ctrl-R rename, `x` then `y`, Esc, printable = filter) · **Composer** · **Global** (Ctrl-C, Ctrl-D, Ctrl-L, Ctrl-O, Ctrl-Z, F1, and `[`/`]` only on an empty composer). Kitty stays disabled (F2), so `key.super/hyper` and `eventType` never arrive; the resolver still drops `eventType === 'release' | 'repeat'` for forward compatibility (A5). **On an empty composer only `[`, `]`, `/` (column 0), `@` and `?` are bound; `d p t s` are never keys** (the first letter of "do", "please", "the tests", "start" must insert text — judge-ux C1/M1 fixed).

### 3.2 Bindings (A8, A6, A7, A11, A19–A24, F4)

| Key(s) as Ink sees them | Action | Notes |
| --- | --- | --- |
| `return` (no shift/meta/ctrl, `input === '\r'`) | submit (task, follow-up, steer, `/command`, review note) | re-entrancy guard while `submitting` (A9); empty draft → no-op |
| `input === '\n'` (Ctrl+J), `return && meta` (Alt+Enter, `ESC \r`), `return && shift` (`CSI 13;2u` if ever), trailing `\` + Enter (backslash removed), `input` matching `/^\[27;[2-8];13~$/` | insert newline; the xterm form's text is swallowed | R7; universal set only (A6, C28) |
| `ctrl a`/`home`, `ctrl e`/`end` | logical line start/end | |
| `ctrl b`/`leftArrow`, `ctrl f`/`rightArrow` | move by grapheme; `→` at end of text accepts the ghost completion | |
| `meta b`/`ctrl leftArrow`, `meta f`/`ctrl rightArrow` | word back/forward (`Intl.Segmenter` word, `isWordLike`; `/ - _ .` separate) | |
| `ctrl k`, `ctrl u` | kill to end / start of the logical line → kill ring | |
| `ctrl w`, `backspace && meta` | kill word back (`unix-word-rubout`) | |
| `meta d`, `delete && meta`, `delete && ctrl` | kill word forward | |
| `ctrl y`, `meta y` | yank, yank-pop (only right after a yank) | ring 16 entries; survives submit |
| `ctrl t` | transpose the two graphemes around the cursor | |
| `input === '\u001f'` (Ctrl+_), `ctrl -` | undo; redo = `input === '\u001e'` (Ctrl+^) | 100 snapshots each way |
| `backspace` (= Ctrl+H), `delete`, `ctrl d` with text | delete back / forward; a chip is removed whole | |
| `upArrow`/`downArrow` | move by visual row; on the first/last row: history prev/next; on the first row with steers queued and an empty draft: `engine.unsteer()` puts the newest steer back | A7, C22 |
| `ctrl p`/`ctrl n` | history prev/next always | |
| `ctrl r` | reverse-incremental history search in the composer row; Ctrl-R again = older, Ctrl-S newer, Tab/`→` accept and keep editing, Enter accept + submit, Esc/Ctrl-C restore the draft, Backspace on an empty query cancels; Ctrl-A widens to all workspaces | A7; inside the picker Ctrl-R is rename (A56, F7) |
| `tab`, `tab && shift` | completion: palette/mention/argument accept or cycle; never focus | |
| `/` at column 0 of an empty draft | open the palette pre-filled with `/` | A34; never mid-prompt (judge-ux C4) |
| `@` anywhere | open the mention popup over the engine candidate list | A35 |
| `?` on an empty draft, `f1` | append the help block to `<Static>` (§5.3) | |
| `ctrl o` | append detail items (the last step's decision probabilities and criteria, then recent warnings) to `<Static>`; acknowledges `!n` | A22 |
| `ctrl g` | external editor via `suspendTerminal` (§4.8) | A11 |
| `ctrl l` | `useStdout().write('')`: Ink's `writeToStdout` (`ink.js:451–458`) runs `log.clear()` (erase-lines) → write → `restoreLastOutput()` inside one BSU/ESU pair, which is exactly "erase-lines + repaint" with zero clears; never `instance.clear()` (`ink.js:655–662` syncs the erased frame as already drawn, so a re-render with identical output writes nothing and the region stays blank) and never `ESC[2J` | A8; pty assertion: the frame bytes after Ctrl+L equal the frame before it (§19.5) |
| `ctrl z` (`input === '\u001a'`) | suspend (§14.2) | A23 |
| `[`, `]` on an empty draft | cycle pane tabs | A44, F16 |
| paste (`usePaste`) | §4.5 | |

Reserved and never rebindable (A24): Ctrl+C, Ctrl+D, Ctrl+M, Ctrl+[, Ctrl+I. Not bound in v1: Ctrl+S (no stash), Ctrl+V, Ctrl+P/Ctrl+K as palette (R8), a leader key (C16), `!` (C7).

### 3.3 Ctrl-C / Esc / Ctrl-D matrix (19 §4 with F5's choices; D2)

States: **S0** idle, draft empty · **S1** idle, draft text · **S2** live (or `starting`), draft empty · **S3** live, draft text · **S4** review armed (`overlay === 'review' && reviewArmed`) · **S5** other overlay, with sub-rows · **S6** `run: 'aborting'` · **S7** `run: 'pausing'` (Esc pressed, waiting for the step boundary). Windows: Ctrl-C 1.5 s, Ctrl-D 800 ms, Esc Esc 2 s, Esc re-buffer 30 ms (07 §1.5).

| Key | S0 idle·empty | S1 idle·text | S2 live·empty | S3 live·text | S4 review | S6 aborting | S7 pausing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ctrl-C ×1 | session: toast `press Ctrl-C again to exit`, arm 1.5 s; one-shot before the run: same | clear draft → history (through `detectSecrets`, §10.7); arm nothing | one-shot: `shutdown('human_abort')` → checkpoint → exit 130; session: `engine.abort('human_abort')` → S6, no exit | clear draft → history (never abort with text present) | draft empty: `engine.abort('human_abort')` **only** → S6 — the engine's signal rejects the pending `confirm()` (`useEngine.tsx` confirmer `onAbort`), `EngineImpl.confirm` emits `confirm:resolved { approved: false, aborted: true }` (`engine.ts:1132–1137`) and `handleStepError` applies rule 1: no `declined` step is committed, `counters.reviews`/`declined` stay 0, the window is unchanged and the resumed run asks again (never `resolveDetailed` first, which would commit a fabricated human decline); draft non-empty (typed during the deferral): clear draft → history, the box stays (F5's text rule outranks the review rule) | `process.exit(130)` immediately after `writeStateSync` (DESIGN §11; `EngineImpl.abort` second call, `engine.ts:492–495`) — through the injected `EngineOptions.exit` (§13.4: `restoreTerminal()` → epilogue on stderr → `process.exit`) | abort now → S6 |
| Ctrl-C ×2 ≤ 1.5 s | unmount → exit 0 | (as S0 after the clear) | (S6 rule) | (S1 rule, then S0) | (S6 rule) | `process.exit(130)` | (S6) |
| Esc ×1 | no-op; arm Esc Esc 2 s | arm Esc Esc; toast `Esc again clears the draft` | `engine.pause()` → S7; status `pausing after step N`; toast `Esc again aborts the run` | arm Esc Esc | decline | no-op | no-op |
| Esc ×2 ≤ 2 s (or `escape && meta`) | open the rewind/steer menu (palette pre-filtered to `/rewind /undo /resume /new`) | clear draft → history | `engine.abort('human_abort')` → S6 | clear draft → history | — | — | abort → S6 |
| Ctrl-D | toast `press Ctrl-D again to exit`, arm 800 ms; second press → exit 0 | delete-forward | toast `run is live — Ctrl-D again to choose`; second press ≤ 800 ms → `exitConfirm` overlay `a run is live: [y] abort and exit   [n] stay` (Enter inert; `y` → abort, then exit **0** after `run:end` — leaving is not a failure (17 §4.9), same as `/exit` `[y]`; the `run:end` item carries 130 for the aborted run) | delete-forward | ignored | ignored | as S2 |
| Enter | submit task / follow-up | submit | no-op | `engine.steer(text)` → queue | ignored (Enter never approves, A40) | ignored | steer → `pendingDirectives` (checkpointed in `state.json`; consumed by `/resume` at its first step start, or folded into the follow-up seed by `buildSeed`, §8.3 — never lost) |
| `y` | text | text | text (steer draft) | text | approve once | ignored | text |
| printable | insert | insert | insert | insert | **ignored**; toast `review pending: y n d e w · Esc declines` | ignored | insert |
| paste | chip/insert | chip/insert | chip/insert | chip/insert | ignored (a pasted string never matches a key) | ignored | chip/insert |

S5 sub-rows (composer-first's overlay rows, sessions' blocking rule):

| Overlay | Ctrl-C | Esc | Enter | Ctrl-D | other keys |
| --- | --- | --- | --- | --- | --- |
| palette / mention / picker / help-block none | close (draft kept, token remembered) | close | palette: run only on an exact name/alias match, else keep the draft and append `[ui] error: unknown command /foo; type / to list commands` (never a submission, judge-safety E2); mention: insert `@path `; picker: continue/resume the row | palette/mention: close; picker: ignored | printable filters; ↑↓/Ctrl-P/N/PgUp/PgDn move; Tab accepts and keeps editing; picker: Space preview, Ctrl-A all workspaces, Ctrl-R rename, `x` then `y` delete |
| history-search | cancel, restore draft | cancel, restore draft | accept + submit | — | printable = query; Ctrl-R older, Ctrl-S newer, Tab/→ accept |
| secret gate | cancel the send **and** clear the draft → history with hit spans `[REDACTED:draft]` (§10.7; F5's text rule) | dismiss (draft kept) | dismiss (draft kept) | dismiss (draft kept) | `y`/`Y` sends — only on a frame after the row was drawn and never within 150 ms of the Enter (§6.3's arming rule); anything else dismisses and is then handled by the composer |
| follow-up confirm | cancel (draft kept) | cancel | inert | ignored | `y` (armed one frame after the box, never from the Enter's input chunk, §6.3) start clamped; `r` prefill `/budget session-spend-cap <cap+runCap>`; `n` cancel |
| undo prompt | abort the undo | abort | = `n` | ignored | `y`, `n`, `a` all, `s` skip rest |
| exitConfirm | = `n` (stay) | stay | inert | ignored | `y` abort then exit; `n` stay |
| wizard (onboarding or `/login`) | no run exists → print the fix block to stderr after unmount, exit 2; a run exists (`/login` mid-run) → close the wizard, run continues | clear field / step back | submit field / reuse key | ignored | digits pick; printable + paste into the `useRef` buffer; Backspace/Delete; Ctrl-U clears |
| blocking pane (401/402/429-cap/disk/drift/sandbox) | that pane's `[q]` (401 → item `exit 2`; disk → `exit 3`; spend limit → `exit 5`) | no-op | inert | ignored | `r c q p l` as the pane lists |

Transitions on engine events: `run:start` → S2/S3; `run:end` → S0/S1 (composer reopens; `run: 'none'`); `confirm:request` → `pendingReview` set, **S4 only after the 1 s idle deferral with the input queue drained and one frame drawn** (§6.4; keys during the deferral go to the composer as text); `confirm:resolved` → S2/S3. **Precedence (F5):** the draft rule outranks the review rule — Ctrl-C with a non-empty draft under a visible review clears the draft and leaves the box; only an empty-draft Ctrl-C aborts. A `run:end` whose `stopReason === 'signal'` (external SIGINT/SIGTERM/SIGHUP; §14.2) does **not** reopen the composer in session mode: the controller unmounts, restores the terminal and exits 130/143/129 (§13.5). `human_pause` lands as `run:end` (stopReason `human_pause`, exit-4 family) with the epilogue line `paused after step N — Enter a follow-up or /resume`. Every Ctrl-C while `run: 'aborting'` is `process.exit` (never a hint). `/exit` while live: `exitConfirm` overlay first (`y` → `engine.abort('human_abort')`, wait for `run:end`, exit 0 — the engine's `'exit'` writer is installed, so `state.json` is final; judge-safety E4). One-shot mode has no idle states: the process exits at `run:end`.

**Interrupt reducer (composer-first graft; the unit-test shape).**

```ts
// src/tui/keys/interrupts.ts — pure over (state, key, nowMs)
export interface Interrupt { ctrlCAt: number | null; escAt: number | null; ctrlDAt: number | null }
export type InterruptAction = 'HINT_CTRL_C' | 'EXIT_0' | 'ABORT_STAY' | 'ABORT_EXIT_130' | 'EXIT_NOW_130' | 'CLEAR_DRAFT' | 'ABORT_REVIEW'
  | 'DECLINE' | 'PAUSE' | 'ABORT' | 'OPEN_REWIND_MENU' | 'HINT_ESC' | 'HINT_CTRL_D' | 'OPEN_EXIT_CONFIRM' | 'DELETE_FORWARD' | 'CLOSE_OVERLAY' | 'PANE_Q' | 'WIZARD_EXIT_2' | 'NONE';
export function reduceInterrupts(s: KeyState, key: 'ctrl-c' | 'esc' | 'ctrl-d' | 'other', now: number): { state: KeyState; action: InterruptAction };
// ctrl-c:  aborting → EXIT_NOW_130; text → CLEAR_DRAFT (also under a visible review: F5 precedence); review && draftEmpty → ABORT_REVIEW (engine.abort('human_abort') only, no resolveDetailed); overlay → per S5; live && one-shot → ABORT_EXIT_130;
//          live && session → ABORT_STAY (arm); idle → armed ≤ 1500 ? EXIT_0 : HINT_CTRL_C (arm)
// esc:     (after the 30 ms re-buffer; an Alt chord consumed it otherwise) overlay → CLOSE_OVERLAY; review → DECLINE;
//          text → armed ≤ 2000 ? CLEAR_DRAFT : HINT_ESC (arm); live → armed ≤ 2000 ? ABORT : PAUSE (arm); idle → armed ≤ 2000 ? OPEN_REWIND_MENU : arm
// ctrl-d:  text → DELETE_FORWARD; live → armed ≤ 800 ? OPEN_EXIT_CONFIRM : HINT_CTRL_D (arm); idle → armed ≤ 800 ? EXIT_0 : HINT_CTRL_D (arm)
// other:   clears all three arms
```

Hints are 2 s toasts in the status left zone (A37); Ctrl-C/Ctrl-D hints become `<Static>` items only when the second press follows (scrollback records `[ui] exited on Ctrl-C ×2`, never idle hints). **Esc re-buffer:** `key.escape && input === ''` starts a 30 ms timer; a letter/`\r`/arrow arriving inside it is re-dispatched as the Meta chord (`ESC b`, `ESC \r`; split `ESC [ A` is already joined by Ink at ≤ 20 ms); on expiry the Esc action of the current state fires (a lone Esc acts ~50 ms after the press; 07 §1.5 measured 21 ms baseline).

### 3.4 Keybindings file (A24, F14)

`${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json`: `{ "composer:externalEditor": "ctrl+g", "composer:killLine": "none", "global:help": ["?", "f1"], "session:export": "ctrl+x ctrl+s" }` — action ids are `namespace:action` from the key registry (`src/tui/keys/bindings.ts` `KEY_ACTIONS`), values a key string, an array, or `"none"`/`null` to unbind; a value with two space-separated keys is a chord completed within 3 s (the chord's first key is held in the same `armed` shape as Esc Esc); reserved keys refused with a `jevcode.log` warning; unknown ids warned, never fatal; read synchronously right after `firstFrame()` resolves (≤ 64 KiB; before Ink dispatches any key — a key can never be resolved against the defaults by timing) and by `/help reload`. Contexts: `global`, `composer`, `review`, `picker`, `palette`.

## 4. Composer

### 4.1 `TextBuffer` model and reducer (A1, 08 §8; `src/tui/composer/buffer.ts`, pure, ink-free)

```ts
export interface Snapshot { readonly text: string; readonly cursor: number }
export interface ChipRef { readonly n: number; readonly lines: number; readonly bytes: number; readonly label: string } // label `[Pasted #n, k lines]`
export interface TextBuffer {
  readonly text: string;                // logical text; only '\n' below 0x20 (tabs expanded on insert); chips appear as their label text
  readonly cursor: number;              // UTF-16 index, always on a grapheme boundary and never inside a chip label
  readonly preferredX: number | null;   // sticky visual column for ↑/↓
  readonly killRing: readonly string[]; // ≤ 16, newest first; survives submit for the process lifetime
  readonly yankIndex: number | null;    // set right after a yank so Alt+Y rotates
  readonly lastKill: 'append' | 'prepend' | null;   // consecutive kills concatenate (readline)
  readonly undo: readonly Snapshot[];   // ≤ 100
  readonly redo: readonly Snapshot[];
  readonly coalescing: boolean;         // consecutive single-grapheme inserts share one undo step until whitespace/newline/motion/2 s idle
  readonly chips: readonly ChipRef[];   // bodies live in a useRef Map (§4.5), never here
  readonly history: { level: number; stash: Snapshot | null; filter: 'workspace' | 'all' };  // level -1 = live draft
}
export type Motion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'wordLeft' | 'wordRight' | 'start' | 'finish';
export type BufferAction =
  | { type: 'insert'; text: string; paste?: boolean }              // already filtered (§4.4); paste = one undo step, no coalescing
  | { type: 'newline' } | { type: 'backspace' } | { type: 'delete' }
  | { type: 'move'; to: Motion; columns: number }                  // up/down need the wrap width
  | { type: 'kill'; what: 'toEnd' | 'toStart' | 'wordBack' | 'wordForward' }
  | { type: 'yank' } | { type: 'yankPop' } | { type: 'transpose' } | { type: 'undo' } | { type: 'redo' }
  | { type: 'setText'; text: string; cursor?: number; pushUndo: boolean }   // history recall, external editor, unsteer
  | { type: 'clear' }                                              // Ctrl-C / Esc Esc: one undo snapshot so C-_ brings it back
  | { type: 'chip'; chip: ChipRef }                                // insert a chip label as one atomic token
  | { type: 'history'; dir: -1 | 1; entries: readonly string[] };
export function reduceBuffer(b: TextBuffer, a: BufferAction): TextBuffer;
export function graphemeBoundaries(text: string): Uint32Array;            // one lazily created Intl.Segmenter('grapheme') singleton (`let seg: Intl.Segmenter | null = null`, built on first use: the constructor costs ~5.6 ms (12 §7) and must not sit on the first-frame path); memoised per logical line
export function wordBoundary(text: string, from: number, dir: -1 | 1): number; // lazily created Intl.Segmenter('word') singleton, isWordLike; `/ - _ .` are separators
```

Rules: the cursor moves only through `graphemeBoundaries` (fuzzed, §19.2); chips are atomic (motions skip them, Backspace/Delete/kill remove them whole and drop the `ChipRef`); `undo` pushes at most one snapshot per coalesced run; `kill` with `lastKill === 'append'` appends to `killRing[0]`, `'prepend'` prepends, else unshifts; `yankPop` replaces the yanked span with the next older entry; `transpose` at the end of a line acts on the two preceding graphemes; `clear` pushes a snapshot (so Ctrl+_ restores) and the caller writes the draft to history through §10.7. Segmenter cost is per logical line (0.37 ms per 3,240 chars, 08 §8), so a 12,000-char draft stays under 1 ms per keystroke. Neither segmenter exists until the first keystroke; `perf/first-frame.ts` reports the bundle's module-evaluation time as its own breakdown row so a new eager singleton (~11 ms for two) is caught by the gate.

### 4.2 `cellWidth` and rows (A2, C20; `src/tui/composer/width.ts`, `rows.ts`)

`cellWidth(cluster): 0 | 1 | 2` replicates `string-width@8.2.2`: (1) 0 when every code point matches `/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Nonspacing_Mark}|\p{Enclosing_Mark}|\p{Surrogate})+$/v`; (2) `/^\p{RGI_Emoji}$/v` → 2; (3) keycap `^[\d#*]️?⃣$` and ZWJ sequences with ≥ 2 `\p{Extended_Pictographic}` → 2; (4) Hangul L+V(+T) → 2; (5) EastAsianWidth Wide/Fullwidth of the first visible scalar → 2 via `eaw-table.ts` (125 + 3 ranges, binary search, generated by `scripts/gen-eaw.mjs` from the devDependency-visible `get-east-asian-width@1.7.0`, Unicode version in the header); ambiguous = narrow. `stringWidth(s)` = Σ clusters; `truncateCells(s, cells)` truncates by grapheme with `…`. `layoutRows(text, columns, gutter = 2): Row[]` (`Row = { start, end, hard, cells }`) splits on `\n`, soft-wraps by summed width, breaks after a space when one exists in the last 20 cells, never inside a grapheme or a chip; `cursorToRowX(rows, text, cursor)`; `viewport(cursorRow, height, scrollTop) = clamp(scrollTop, cursorRow − height + 1, cursorRow)`. Fixture test: 400 strings from 07 §4 plus the fuzzer pool against `string-width` (A108).

### 4.3 Rendering and cursor (A3, A10, A33)

The composer box is `<Box height={layout.composer} flexDirection="column" overflow="hidden">` with exactly `height` pre-sliced `<Text wrap="truncate">` rows (Ink never re-wraps them); row 0 is prefixed `> ` (yellow while a run is live = steer mode; `»` while the composer is a picker filter), continuation rows `  `; gutter markers `↑N`/`↓N` right-aligned on the first/last visible row when rows are hidden. The placeholder is a dim sibling `<Text>`, never buffer text (§24 lists them). Detected secret spans (§10.1, every family, warn-only included) render as `•` cells (`*` under `--ascii`) of the same cell width as the masked graphemes: `maskSpans(rowText, hits)` runs after `layoutRows`, so `cursorToRowX`, every row width and the cursor arithmetic are unchanged, the human still sees where the secret sits, and the pty capture never carries the bytes (§19.4's "any frame" sweep therefore holds before submit too; F-V). Real cursor: `useCursor().setCursorPosition({ x: gutter + cursorX, y: composerTop + cursorRow − scrollTop })` during render, where `composerTop = rule + live + banner + pane + queue + overlay + preview` from the same `Layout` object so cursor and frame cannot disagree; `setCursorPosition(undefined)` while a collapsing overlay owns input, during the review deferral, and while the wizard's masked field owns the cursor (the field places its own). No inverse-block fake cursor (R10). DECSCUSR steady bar `CSI 6 SP q` once at mount, `CSI 0 SP q` in the exit string (A3 followed; see §22 for why minimal-robust's drop is not taken).

### 4.4 Input filter (A5, A88, A92; applied before `insert`)

Drop when `key.ctrl || key.meta || key.super || key.hyper` (bindings resolved first); drop `eventType` release/repeat; drop code units `< 0x20` except `\t` (expanded to spaces) and the newline keys; drop `0x7f`; drop CSI-body leak-through matching `/^\[(?:I|O|\?\d+[uc]|\d+;\d+R|27;\d+;\d+~|<\d+;\d+;\d+[Mm]|\?62;[\d;]*c)$/` (`[I`, `[O`, `[24;80R`, `[27;2;13~`, `[?0u`, `[?62;22c`, `[<64;10;5M`) and OSC fragments `/^\]\d+;/` and `\\` (sessions graft: belt for a terminal answering an OSC unprompted); `sanitizeStream` (`plain.ts:80`) on every insert so C0/C1 never enter the buffer; bidi controls U+202A–202E and U+2066–2069 stripped; U+2028/2029 → `\n`; a multi-code-point chunk without ESC is text (IME commit) and is inserted whole; a dropped body increments a `key filtered` trace category. No timers (C21).

### 4.5 Paste lifecycle (A4, 16 §4.3, C10)

1. `usePaste(text)` (bracketed) or a multi-character `useInput` chunk with no modifiers (paste-like; C21, no timers). **Chunk splitting first** (`splitInputChunk`, pure, in `App.tsx`): with bracketed paste on, an unbracketed multi-byte `useInput` chunk is usually *coalesced keystrokes* (Node's blocking TTY stdout holds the loop while the terminal does not drain; the bytes typed meanwhile arrive as one read — research 20 §2), so before anything else the chunk is split at every control byte and CR/LF into its keys and text runs: `\x03` → Ctrl-C, `\x04` → Ctrl-D, `\x1b` → Esc, `\x7f`/`\b` → Backspace, other `\x01`–`\x1a` → their Ctrl letter, `\r`/`\n` → Enter (`'\x03\x03'` in one read is two Ctrl-C presses and completes the ×2 window; `'abc\r'` is the text `abc` then Enter — a trailing CR is the Enter the typist meant). A chunk with an **interior** newline and no other control byte stays paste-like (a terminal without 2004 pastes this way) and is inserted through step 2; when such a chunk ended with a CR the Enter is folded into the newline and the toast `input arrived in one chunk; Enter kept as a newline — press Enter to send` says so. A lone control byte with no flags is one whose ESC prefix Ink stripped (`\x1b\x03` parses as `\x03` with `ctrl: false`) and becomes Esc then the key; named keys, modifiers, single graphemes and text without control bytes pass through unchanged.
2. Normalise `\r\n` then `\r` → `\n`; `sanitizeStream` minus `\n\t`; strip bidi controls; U+2028/2029 → `\n`; NFC.
3. `> 1 MiB` → toast `paste of 3.2 MB refused (limit 1 MiB); write it to a file and @-mention it`; nothing inserted.
4. `> 3 lines || > 800 chars` (line threshold 2 below rows 12, 02 §3.3) → `chips.current.set(n, { text, lines, bytes, fp8 })` in `useRef<Map<number, PasteBlob>>` (`fp8` = the first 8 hex of the body's sha256 — a fingerprint for display, never the full digest: a full digest of a short paste is an offline oracle; chip identity on `--resume` is `n` + `bytes`) and `{ type: 'chip', chip }`; else `{ type: 'insert', text, paste: true }`.
5. At submit: `expandChips(text, chips.current)` in label order; a label whose blob is missing (after `--resume`) cancels with `[ui] remove [Pasted #1] or paste again`; history and `ui.json` carry labels only.
6. An expanded submission `> PROMPT_LIMITS.taskChars` (12,000, `prompts.ts:19`) appends the item `[ui] notice: only the first 12,000 characters reach the generator; @-mention a file for more` (P44/C50 per F9).

Bodies are never in React state, the reducer, an `EngineEvent`, `ui.json`, history or logs. Keystroke trace: `paste len=<n>` only.

### 4.6 History (A7, A60)

File `~/.jevcode/history.jsonl`, one line `{ "t": iso, "workspace": realpath, "kind": "prompt" | "steer" | "command", "text": … }`; `text` = `redactor.redact(expandChipsAsLabels(sanitizeStream(draft)))` written **after** `addSecret` (§10.2), chip label = `[Pasted #n: "<redacted first line ≤ 40>", k lines]` (P58 per F9); no digest in the label; 4 KiB per entry; 1,000 entries with atomic rewrite when exceeded; loaded once, synchronously, right after `firstFrame()` resolves (≤ 4 MiB, ≈ 3 ms), so Up/Ctrl-R can never see an empty store by timing; consecutive duplicates dropped; never written for `source !== 'cli'`, `--no-history`, `JEVCODE_NO_HISTORY=1`, or the wizard's key field; reads still work when writes are off. In memory: entries filtered by workspace realpath; Ctrl-A in Ctrl-R widens. Navigation: level −1 is the live draft; Up on the first visual row (or Ctrl-P) goes to level + 1, stashing the draft; Down past −1 restores the stash; the cursor lands at the end. `/history clear` truncates after `y/N`. Write failures on this file (and on `sessions/index.jsonl`, `trust.json`, `ui.json`): toast `! could not write <basename>: <code>` + log line, never fatal, never a retry loop (judge-safety rule d).

### 4.7 Undo/redo, kill ring, coalescing

100 snapshots each way; a paste, `setText`, kill, history recall, `clear` and an external-editor round trip are one step each; consecutive single-grapheme inserts coalesce until a motion, kill, whitespace/newline or 2 s idle. Kill ring 16 entries; consecutive kills concatenate; Alt+Y rotates; the ring survives submit and run boundaries (in-memory only).

### 4.8 External editor (A11)

Ctrl+G or `/editor`: refused with the toast `editor: the draft contains a secret (<label>); remove it or send it first` while `detectSecrets(draft)` has any hit (the file would otherwise carry the secret); otherwise write the draft (chip labels kept) to `<runDir>/drafts/edit-<seq>.md` (before a run: `~/.jevcode/drafts/edit-<pid>-<seq>.md`, dir 0700) with mode 0600 — **never** under `<runDir>/tmp/`, which is the sandboxed command's `TMPDIR` (`run.ts:123`) and explicitly readable and writable for a generator-proposed `run` (`seatbelt.ts:60`, `:108–110`), so a command could have read the unsent draft or rewritten what `setText` reads back; `drafts/` sits under `~/.jevcode` outside `runTmp`/`runHome`, where `(deny file-read-data (subpath ~/.jevcode))` and the default write deny keep it from every command (pty case §19.5: a `run cat $TMPDIR/*` during Ctrl+G sees no draft); `await useApp().suspendTerminal(() => spawnAndWait($VISUAL ?? $EDITOR ?? 'vi', [file], { stdio: 'inherit' }))` (the editor string is split through `/bin/sh -c` like git); engine events arriving during the suspension are queued in `useEngine` (a `suspended` flag on the bus) and dispatched after `resume()` because `<Static>` items appended during a suspension are dropped (08 §5); on exit 0 read back, normalise, re-collapse unchanged chip labels, `setText { pushUndo: true }`; non-zero → toast `editor exited 1; draft kept`; always `unlink`. Unavailable while a collapsing overlay owns input. The run is not back-pressured (Q11 open) — safe now that the draft is outside the sandbox's reach.

### 4.9 Submit routing (`src/tui/composer/submit.ts`)

```
onEnter():
  if submitting → return                                                      // A9
  if overlay === 'palette' → run only when the token equals a name or alias exactly; else keep the draft, item `[ui] error: unknown command /foo; type / to list commands`; return
  if text starts with '/' at column 0 → dispatchCommand(parseCommand(text)) ; parse/arg errors → item, draft kept; return
  if text starts with '//' → text = text.slice(1)                             // literal slash-leading prompt
  if text.trim() === '' → return
  full = expandChips(text); if a chip body is missing → cancel with the notice
  if host === null → hold (submitting stays true, toast `starting…`; the host attaches ~10 ms after firstFrame(), §1) ; return
  hits = host.detectSecrets(full); if hits.length → overlay = 'secret' (armed next frame, §6.3); return  // §10.2; only y continues, then send(full, hits.map(span))
send(full, secretSpans):
  if run live/starting → host.steer(full, { secretSpans }) → the host addSecret()s every span, then engine.steer(raw) → item from steer:queued ; history 'steer' ; clear (undoable)
  else                 → host.submit(full, { kind, secretSpans, pinnedFiles }) → the host addSecret()s every span, then the follow-up gate (§9.3) may interpose ; startRun(full, seed) ; history 'prompt'
  submitting = false
```

`exit`/`quit`/`:q` typed alone do **not** exit (a task may legitimately be the word "quit"; declared in §22 against A9). `submit.ts` is pure routing over `parseCommand`/`dispatchCommand`/`host.detectSecrets` and is owned by O3 (`test/unit/tui/commands/submit.test.ts`: `/foo` never submits, `//` literal, empty trim, missing chip cancels, a hit opens the gate, live → steer vs idle → submit, held until the host attaches).

### 4.10 Secret gate row (A154; §10.2)

`Looks like this contains a secret (sk-ant-…). Send anyway? y/N` (yellow, `wrap="truncate"`, one row in the overlay slot; plural: `Looks like this contains 2 secrets (sk-ant-…, AKIA…). Send anyway? y/N`; exact: `Looks like this contains your OPENROUTER_API_KEY. Send anyway? y/N`). Only `y`/`Y` sends, and only when it arrives on a frame **after** the row was drawn (`armed` set in a `useEffect` after the committed frame — §6.3's rule, applied to every `y`-gated overlay: this gate, the follow-up box, the exit confirm, the undo prompt, `Attach anyway?`), never from the input chunk that carried the Enter and never within 150 ms of it, so a typist whose continuation is "yes, and also…" is not confirming (16 §4.1); Enter, Esc, `n`, `N` and any other key dismiss the row, keep the draft and are then handled normally; Ctrl-C cancels the send **and** clears the draft to history with the hit spans masked (§10.7, F5's text rule). Dismiss shows the one-frame tip `Tip: put it in .env and refer to it by name`. No timeout, no default-yes, never remembered (R38). A dim ` ⚠ secret?` sits at the end of the status line while the draft has a hit (scan on every change: < 0.001 ms at 2 KB). Plain twin: readline `jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel:`; non-TTY cancels (exit 2).

## 5. Palette, slash-command grammar, `@` mention, fuzzy scorer

### 5.1 Grammar (`src/tui/commands/parse.ts`, pure)

```
line     := '/' name (ws arg)* ws?
name     := [a-z][a-z0-9-]*                        // case-insensitive; aliases resolved by the registry
arg      := bare | '"' (esc | [^"\\])* '"' | "'" [^']* "'"
bare     := (esc | [^ \t"'\\])+                     // esc := '\' any ; `--flag` and `--flag=value` become options
```

Tokeniser errors (`unterminated quote`, `dangling backslash`) → item `[ui] error: /rename: unterminated quote` and the draft stays with the cursor at the end. `Command.args` is validated by `ArgSpec[]` (`{ name, kind: 'enum' | 'int' | 'usd' | 'duration' | 'run' | 'step' | 'path' | 'setting' | 'text' | 'rest', values?, optional? }`): `run` = `RUN_ID_RE` or a unique title/prefix in the index fold (ambiguous → `[ui] error: /resume: "fix" matches 3 sessions: …`); `step` = integer `1..state.step` with `changedFiles`; `usd` = positive number or `none` (session cap only); `path` = workspace-relative, denylist checked; `rest` = raw remainder, trimmed, ≤ 600. A failed spec yields `[ui] error: /budget spend-cap: expected a positive USD amount, got "abc"`. Argument completion: Tab inside an `enum`/`run`/`step`/`path`/`setting` argument runs the fuzzy scorer over the spec's candidates (paths → engine candidate list; runs → index fold; steps → the reducer's `step:end` records; never a `steps.jsonl` read). `availableDuringTask`: `idle` commands while live → `[ui] error: /undo runs when the run is idle; Esc pauses first`; `live` commands while idle → `[ui] error: /pause needs a live run`. **Enter runs a command only on an exact name/alias match; a `/` token that matches nothing keeps the draft and never submits** (composer-first D1; a submitted line is a paid run).

### 5.2 Command table (`src/tui/commands/registry.ts`; one typed array feeds the dispatcher, the palette, help, `docs/COMMANDS.md`, the readline composer)

`avail`: idle | live | any. `plain`: the `--plain` readline composer supports it (sessions' Plain column).

| Command | Args | avail | plain | Semantics |
| --- | --- | --- | --- | --- |
| `/help [keys\|commands\|reload]` | enum? | any | yes | append the help block (keys by context, commands with one-liners, per-terminal notes); `reload` re-reads `keybindings.json` |
| `/new` | — | idle | yes | end the session; the next prompt starts a new session in this workspace (new `sessionId`, fresh root meter); item shows the old session's total |
| `/resume [id\|title]`, alias `/sessions`, `/continue` | run? | idle | `/resume <id>` only | picker (§8.4); with an argument continue that run (a stopped run resumes; a `complete` run seeds a follow-up unless `--force`); after `/undo`/`/rewind` of that run the human note rides in `EngineOptions.humanDirective` and `undoLog` (§12.4); `/continue` = most recently used run here |
| `/rename <title>` | rest | any | yes | session title ≤ 60 (through the secret gate and `redact`); index `rename` line; status centre |
| `/steer <text>` | rest | live | yes | = Enter with text while live (needed by `--plain`) |
| `/unsteer` | — | live | yes | = Up on the first row: `engine.unsteer()` |
| `/pause` | — | live | yes | `engine.pause()` (= Esc) |
| `/abort` | — | live | yes | `engine.abort('human_abort')` (= Esc Esc) |
| `/undo [n]` | step? | idle | yes (readline `y/N`) | §12.4 |
| `/rewind [step]` | step? | idle | yes | picker of steps with changed files → undo last…n → `files / plan+window / both` (§12.5) |
| `/diff [step] [--full] [--all]` | step?, flags | any (`--full` idle) | inline only | §12.6 |
| `/plan` | — | any | yes | append the plan ledger block |
| `/decisions [n] [stage]` | int?, enum? | any | yes | append the last n `DecisionRow`s (default 12) |
| `/why <ref\|digit>` | rest | any | yes | append the `/why` block (§7.4) for `s7.risk.plan_mismatch`, `risk.plan_mismatch` (current step) or a visible pane digit |
| `/calibration` | — | idle | yes | append the reliability block from `decisions.jsonl` + `steps.jsonl` of this workspace's runs (≤ 200 runs, streamed) |
| `/jev` | — | any | yes | decider model, resolved/drift@step, questions, latency p50/p95, Jev cost |
| `/cost` | — | any | yes | 12-row block (§9.6) |
| `/budget [spend-cap\|session-spend-cap\|max-steps\|max-wall\|max-replans <v>]` | setting, value | any | yes | show or set (§9.4) |
| `/model <id>`, `/provider <p>`, `/mode <m>` | text / enum | any | yes | pending for the **next** run only (memory); a differing `--model` on `/resume` stays `ConfigError` |
| `/config` | — | any | yes | masked table with `source` column, effective session cap, sandbox footer |
| `/login`, `/logout [generator\|jev]` | enum? | any | `/login` raw-mode prompt | wizard field re-entry (§11.4); `saved — applies to the next run` |
| `/trust` | — | idle | yes | reopen the trust gate |
| `/theme <dark\|light\|daltonized\|ansi>` | enum | any | n/a | new items and the dynamic region only |
| `/copy [last\|proposal\|diff\|draft]` | enum? | any | n/a | §10.5 |
| `/export [file]` | path? | idle | yes | §8.7 |
| `/status` | — | any | yes | run id, session id, step/max, stage, sandbox, workspace, git, stop reason, lock |
| `/errors` | — | any | yes | append recent warnings/errors as items; acknowledges `!n` |
| `/report` | — | idle | yes | `~/.jevcode/reports/<run-id>/` (§13.6) |
| `/history clear` | enum | any | yes | truncate `history.jsonl` after `y/N` |
| `/editor` | — | any | n/a | = Ctrl+G |
| `/exit`, `/quit` | — | any | yes | exit 0 (`exitConfirm` first while live; `--exit-code=last-run` opt-in) |

Deferred (§22): `/doctor` (CLI `jevcode doctor` first), `/cd`, project commands (A63), `/redo`.

### 5.3 Palette and help rendering (A34, A16)

Palette rows (≤ 8 in the overlay slot, above the composer): `▌ /name   one-line title   arg hint` with matched graphemes bold, a **Suggested** group first keyed on state (`/resume` after any stop, `/budget` after `spend_cap`/`token_cap`, `/login` after a 401 pane, `/undo` after a run with `changedFiles`, `/rewind` when the Esc Esc menu opened it), then score order; aliases hidden; `availableDuringTask` rows dim with `(idle only)`/`(live only)`; the last row is `(i/N)  Tab completes · Enter runs an exact match · Esc closes` with `▲`/`▼` when scrolled; label column ≤ 50 % of the width; Esc remembers the token so `/` stays closed while that token is unchanged (Codex rule). Ghost text: the rest of the top match dim after the cursor with `+N`; `→` accepts it. `?`/F1/`/help` append one `<Static>` block (≤ 60 lines: keys grouped by context, then commands, then per-terminal notes `Shift+Enter needs a keyboard protocol: use Ctrl+J or \ then Enter`, `macOS: turn on "Option as Meta" for Alt-b/Alt-f`); the ShortHelp for the current state is the status right zone's last cell (`? help`, `Tab ⇥`, `Esc closes`). Declared deviation from A21's two-level overlay (§22).

### 5.4 `@` mention (A35, A157) and the fuzzy scorer (F17)

`@` opens the mention popup (same overlay rows) over the candidate list — before the first run: `listCandidates(root, { secretPaths, redact })`, exported standalone from `workspace/files.ts` (the walker without the git snapshot; it needs neither a run dir nor a `Sandbox`, which do not exist before `createEngine`), called once by `createSessionController` after `firstFrame()` when idle; from `run:ready` on: the live engine's `workspace.listCandidates()` cache, handed over by `SessionHost.workspaceCandidates()`; ≤ 5,000 paths typical; the query is the text after `@` up to whitespace; results whose query moved on are dropped (synchronous over the in-memory list, ≤ 16 ms gate; async sessions deferred, §22); denied paths (`isSecretPath()` + `/credential/i` basename, `.npmrc`, `.pypirc`, `/\.(p12|pfx|jks)$/i`, `@`-only `.git/`) are never offered; a denied path typed in full shows `[ui] .env is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to override.` and the mention is dropped (the literal word stays). Enter/Tab inserts `@<rel> ` (spaces escaped `\ `); at submit the paths become `EngineOptions.seed.pinnedFiles` (a new run) or ride in the steer text (live): the context stage boosts them as `mentionsInTask + 1`, still inside the 12-file / 60 KB cap (P8: boost, never bypass).

```ts
// src/tui/commands/fuzzy.ts — dependency-free (F17)
export interface Scored { candidate: string; score: number; spans: readonly [number, number][] }   // spans grapheme-aligned
export function score(query: string, candidate: string): { score: number; spans: [number, number][] } | null;   // null = not a subsequence
export function rank(query: string, candidates: readonly string[], limit = 8): Scored[];
// 1. case-fold both; 2. exact → 1000; prefix → 900 − candidate.length; word-prefix (after / - _ : . or a lower→Upper hump) → 700 − wordIndex·10;
// 3. else greedy left-to-right subsequence: +10 per matched char, +25 when the match starts a word, +15 when contiguous with the previous match,
//    −1 per skipped char, −0.1 per candidate length; paths add +40 when the query matches inside the basename; every query char must match in order.
// Ties: shorter candidate, then original order. Precompute lower-cased candidates once per list. Early exit on the first missing char.
```

Unit test: 5,000 synthetic paths (depth 1–6, 60 % ASCII, 20 % CJK, 20 % mixed), 40 queries of 1–12 chars, p95 `rank()` ≤ 16 ms on the CI runner; fixed expected orderings for `res`, `sess`, `bud`, `parse_date`, `tst/a`; `score(q, c) !== null ⇔ q is a case-folded subsequence of c` (property test).

## 6. Review prompt (A39–A42, F6)

### 6.1 Rows (`reviewHeaderLines(req: ConfirmRequest, n: number, columns: number): string[]` in `src/tui/review/lines.ts` — the one signature, used verbatim in §15.2 and §19.1; `matchesIntent` and `jevLatencyMs` are read from `req` (§15 item 6 adds them to `ConfirmRequest`, filled by `EngineImpl.confirm` from `draft.matchesIntent`, `engine.ts:1004`); shared by Ink, `--plain`, SR)

Full header at 80 columns (8 rows): row 1 title `review  step N  risk R (bound)  <kind> <target> "<goal ≤ 40>"`; row 2 keys `[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline`; row 3 ruler `dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)` (the `┆` in bar cells 3 and 7 is the 0.3/0.7 band under `NO_COLOR`); rows 4–7 one gauge per dimension **in `RISK_DIMENSIONS` order with its fixed digit** (`1 destructive`, `2 out_of_scope`, `3 plan_mismatch`, `4 irreversible`; fixed order so `w`+digit is stable across reviews — judge-ux C7): `<digit> <name> L<k>  <bar10 of risk over a · track: cells 0–2 dim, 3–6 yellow, 7–9 red>  <risk>  <exp|tail>  <conf>  <level text = riskLevelTexts(evidence)(dim)[level], truncated>`; row 8 `5 matches_intent  <bar of p>  <p> noul <c>~ <criteria.true definition, truncated>` from `req.matchesIntent` (`5 matches_intent  —  not judged this step` when null). At 120 columns the ruler gains `P(l)  E[k]  tail` and each gauge row those three numbers (11 §4b); row 1 adds `(tail on plan_mismatch)`, the full goal and `jev <ms>`; row 2 adds `[ctrl-c] abort run`. Level texts come from `riskLevelTexts(evidence !== undefined)` (`src/loop/stages/risk.ts:89`).

Truncation ladder for `n < 8` (minimal-robust graft; the cut is a function, never Ink clipping): 7 → drop the ruler; 6 → drop `matches_intent`; 5..3 → title, keys, then `n − 2` compact rows carrying two dimensions each at 80 columns (three at ≥ 120, F-X), **the maximum-risk dimension first** (`3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93`, digits kept); `n ≤ 2` → title, keys. Preview: `confirmPreviewLines(req)` (today's function, `plain.ts:311`) indented two spaces, cut to `layout.preview` with the last row `…[k more preview lines · e expands]` only when rows are hidden, never a blank row inside a granted preview (judge-ux C6/S8); `e` toggles `expanded` (pane → 0, preview up to the budget) for this request only.

### 6.2 Keys and invariants

`y` approve once · `n`/Esc decline · `d` → the composer row becomes the note field `note (≤ 600, Enter sends, Esc cancels): _` (single line, chips disabled, same input filter); Enter → `confirmer.resolveDetailed(id, { approved: false, note })` · `e` expand/collapse · `w` then `1`–`5` (≤ 1.5 s) → append the `/why` block for that dimension (`5` = matches_intent); the box stays · Ctrl-C with an empty draft → `engine.abort('human_abort')` (the engine's rejected `confirm()` is the decline: rule-1 discard, no `declined` step, §3.3); with a draft → the draft is cleared and the box stays · anything else ignored with the toast `review pending: y n d e w · Esc declines`; a pasted string never matches a key. Invariants (tests §19.3): no key other than `y` resolves `approved: true`; Enter is inert on the box; no highlighted default; a second `confirm:request` declines the first (`createTuiConfirmer`, kept); the non-TTY confirmer declines after `confirmTimeoutMs`; `alwaysDecline` unchanged; no remembered/always/session approval; `--auto-decline` does not exist (P5 closed); the spinner is frozen while a review is pending (A50); the composer is collapsed to one **inactive** row for the box's lifetime (jev-native's editable-composer-under-review is rejected, judge-safety E1).

### 6.3 Deferral (A41; jev-native mechanics)

`confirm:request` arrives immediately (the engine awaits). The reducer stores it as `pendingReview` and computes `visibleAt = max(now, lastKeystrokeAt + 1000)`; the box renders only when `now ≥ visibleAt` **and** no key event is queued (`inputDrained`: the `useInput` handler sets `lastKeystrokeAt`; a 100 ms timer re-checks); the review key context is entered on the frame **after** the box is drawn (`reviewArmed` set in a `useEffect` after commit), so a key already in flight is never an approval. Until visible: status left zone `review pending…`, keys go to the composer as text, Ctrl-C keeps its live-run meaning. The opt-in notification timer (§14.1) starts when the box appears, restarts on every keystroke, fires at ~6 s (A85/C48). The same arming rule — `overlayArmed` is set only when **both** hold: a frame showing the overlay has been committed (a `useEffect` after the commit, `waitUntilRenderFlush()`) **and** ≥ 150 ms (`GATE_ARM_MS`) have passed since the overlay opened (the effect waits out the remainder), so keys from the Enter's own input chunk are text and a `y` within 150 ms of the Enter is ignored even when the frame was fast — applies to **every** `y`-gated overlay (secret gate, follow-up box, exit confirm, undo prompt, `Attach anyway?`, §4.10, §9.3), not only the review (whose arm is the committed frame alone, the 1 s idle deferral having already drained the input). The `d` note field replaces the review header's row 2 (the keys line) for its lifetime, so the single overlay slot is never double-booked and the note's own secret gate renders in that same row.

### 6.4 Decline-note path to Jev and the generator (P6)

`TuiConfirmer.resolveDetailed(id, { approved: false, note })`; the note passes `sanitizeStream → host.detectSecrets gate (§4.10; rendered in the header's row 2; only y continues) → host.redact → clip(oneLine(note), 600)` (jev-native graft). `EngineImpl.confirm` (`engine.ts:1123`) calls `confirmer.confirmDetailed?.(req, opts) ?? confirmer.confirm(req, opts).then((approved) => ({ approved }))`; on `{ approved: false, note }` the declined reason becomes `declined by reviewer: <risk.reason> — reviewer note: <note>` (`runStep`, `engine.ts:1021`) and `draft.notes.push('reviewer note: <note>')`, so the window entry carries it (`WindowEntry.reason` and `notes` → the generator's `## Recent steps`, and `recent[i].notes` in every later Jev common state). `confirm:resolved` gains `note?: string` (redacted at emit) so `transcript.log`, `--plain` and the TUI print `confirm <id> declined (note: …)` identically.

### 6.5 Plain and screen-reader twins

`--plain` TTY: the readline confirmer prints the 8 header lines (`[step 7] ` prefixed) and ≤ 20 preview rows, then prompts `[step 7] [y] approve  [n] decline  [d] decline+note > `; `d <note>` on the same line; `yes`/`no` accepted; five invalid answers decline (`READLINE_MAX_PROMPTS`). Non-TTY: declines after the timeout. Screen reader: `1 approve  2 decline  3 decline with a note` + `Enter selection (1-3):` as `<Static>` lines; when the review arms, the current draft is **stashed** (restored after the review) so a line already begun can never become the answer; only a line that is exactly `1`, `2`, `3`, `y` or `n` **and was typed after arming** answers — any other line is text/steer and re-announces the prompt (F6: no Enter default; A41's typed-ahead rule restated for the line form; §19.3); one BEL on open, bars replaced by `aria-label="plan_mismatch level 2, risk 0.44 tail, confidence 0.61, skips a planned verification step"`, no ruler row, same deferral.

## 7. Jev-native pane, status line, toasts (A43–A50, F16)

**Live region (≤ 2 rows; `liveLines()` at `App.tsx:64–73` stays the shared `lines()` function).** While the stream has no line break yet: one counter row `streaming… 1.2k chars` (bucketed like `kTokens`: `1.2k`, `12.4k`; `streaming action… 3.1k chars` for tool-argument deltas); after the first line break: the last two lines of the stream, each cut to `columns + 1`; never a counter and a tail together (F-C, F-D). In jev-only the last `synth` line; during a retry the retry row and the `last:` cause row (§13.2, F-R, F-Y); a pending review reclaims both rows (A42). The legacy modes keep exactly these rows; an agent run replaces them (§7.8).

**The stream scheduler (2026-09, TUI map top change 4; `src/tui/stream-scheduler.ts`).** Every streamed byte — generator deltas, command output, the chat reply the controller hands `renderer.live()` — reaches React through one leading-edge scheduler: the first append after a quiet interval flushes in the same tick (and bumps `UiState.paintSeq`, which hands `<Static>` a fresh style so Ink paints on its immediate path, as a key does), later appends flush at most once per interval measured from the last flush — `launch.fps` (33 ms at 30 fps), 67 ms over SSH, 250 ms under reduced motion. It replaces the trailing-only 50 ms coalescer (`LIVE_FLUSH_MS` stays exported as the window a test waits out). A timer exists only while an append waits, so an idle session runs none.

### 7.1 Decision model (jev-native graft; `src/tui/pane/model.ts`, pure over `Decision`)

```ts
export interface DecisionRow {
  step: number; stage: StageName; id: string; kind: 'noul' | 'choice' | 'score';
  label: string;                 // choice → answer.choice; score → `L${level}`; noul → 'noul'
  p: number; c: number; cDerived: boolean;       // Decision.probability / confidence; derived = noul (|2p − 1|)
  verdict: DecisionVerdict | undefined; latencyMs: number; requestHash: string; servedModel?: string;
  consumedBy: string;            // the code rule that read the answer (DESIGN §6 "Consumers of every Jev answer")
  near: { threshold: number; delta: number } | null;   // |p − threshold| ≤ 0.03 for the rule's threshold → `!` before p (11 §4i)
  text: string;                  // criteria text of the chosen option/level (≤ 300) for the 120-column column and /why
}
export function toDecisionRow(d: Decision, completeThreshold: number): DecisionRow;
```

`consumedBy` table: `intent.intent` → `choice resolution → intent <x>`; `can_*` → `paired ≥ 0.5`; `plan_still_valid` → `< 0.3 → stale_plan`; `context.<path>` → `selected iff p ≥ 0.5`; `risk.<dim>` → `band 0.3/0.7 (<bound>)`; `matches_intent` → `< 0.3 → appended to the reason`; `judge.succeeded|error_present` → `reported`; `judge.new_information` → `≥ 0.7 → Plan rule b`; `done_<j>` → `≥ 0.7 accept, < 0.3 reject`; `task_complete` → `≥ <completeThreshold> → stop`; `replan.next_move` → `choice resolution → move`; `replan.can_*` → `paired ≥ 0.5`; `task_impossible` → `≥ <impossibleThreshold> → stop`. The reducer keeps `rows` (last 12, `DECISIONS_KEPT`) and `byStep: Map<step, DecisionRow[]>` for the last 3 steps so `w`+digit and `/why <digit>` never read disk.

### 7.2 Tabs (`src/tui/pane/*.ts` `lines(state, rows, columns): string[]`; `src/tui/Pane.tsx` renders `rows` `<Text wrap="truncate">` rows)

`[`/`]` cycle; the active tab and step are on the rule row (`─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──`, the bracketed letters are labels, not keys); the tab is remembered per session; **in jev-only the default tab is `s` while a step's propose stage runs and `d` otherwise** (jev-native graft). Side-by-side rule (one rule; F-D vs F-J): the pane shows the active tab and the next one side by side (59 + 1 + 60 cells, narrow row form) **only when `columns ≥ 120 && rows ≥ 40 && overlay === 'none'`**; with any overlay, or fewer rows or columns, one wide tab with the 120-column columns of the table below. `overlay` is therefore an input of the pane: `lines(state, rows, columns, overlay)`. Below 80 columns (and in a 59-cell half) the narrow form hides `c` and keeps `p` and the verdict word (A100).

| Tab | Row format at 80 columns | 120 columns adds | Data |
| --- | --- | --- | --- |
| `d` decisions | `s7 stage(8) id(16) label(6) bar10 [!]p.pp  c c.cc[~]  [verdict]` — bar = eighth blocks of `p` over a `·` track; `~` after derived `c`; `!` in the cell before `p` when `near` | `latencyMs` and `consumedBy` (`(near)` suffix when set) | `DecisionRow`s, newest last |
| `p` plan ledger | rule row `plan s7 · done 2 rem 3 unv 1 prob 2`; rows `[x] text(48) sN done_j p.pp` accepted · `[?] … unverified` · `[ ] remaining` · `[!] replan\|rejected_claim\|stale_plan\|human sN: text` | evidence `tests 41p/0f/0e`, `openProblems` column | last `plan` event |
| `t` timeline | two rows per step, newest first: `time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s` / `      s7  ICPPPPRXXXJ…  total 8.2s  h 31ms` (letters `I C P R X J` sized `round(ms/total·40)`) | one row per step, N = 30, plus `gen 5.4k $0.032` | `stage:end`, `step:end.record.timing/usage` |
| `s` synth | `synth  <phase>: <detail verbatim>` / `candidates=… tested=…` when present; the structured two-row strip (`synth  goal 2/3 test_kth kth.py  site kth.py:12 …` / `sieve  verify  tested 37/137 ██▋·······  27%  t_run 0.9s x8 lanes  runs 41 jev 3`) lands when the synth team adopts the optional `synth` fields (A48; not in §15) | ledger `fixed/open/parked`, test command | `synth` events |

Bars: `eighthBar(p, cells = 10)` = `'█'.repeat(⌊p·cells⌋)` + partial `[▏▎▍▌▋▊▉]` + `'·'` fill (`src/tui/bars.ts`; `--ascii` → `#` on `-`; SR → `aria-label="probability 0.44 of 1"` and the plain row). Every bar cell is width 1 (11 §3.1).

### 7.3 Loop banner (A45)

One row, present only while a signature count ≥ 2 or a replan directive is active: `loop  run:pytest -q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12`; counts folded in the reducer from `step:end.record.loopSignatures`, reset on `replan` and on `steer:applied` (the detector resets too); `maxReplans` from the extended `run:ready`.

### 7.4 Status line (`statusLineText(state, columns)` in `src/tui/status/lines.ts`; A46, 14 §5.1, F16)

Three zones. **Left** (≤ 14 cells at 80, ≤ 22 at ≥ 100): the mode word or spinner + stage verb — `idle`, `idle exit N`, `setup`, `starting`, `⠹ propose` (`propose [synth]` kept in jev-only), `review`, `review pending…`, `pausing after step N`, `paused: <reason>`, `retrying 2/3`, `offline`, `disk ×N`, `aborting`, `palette`, `picker`, `still waiting` after 45 s in one stage; then badges `!n`, `sandbox: none` (yellow), `no-net`, `⚠ secret?`. **Centre** (only when ≥ 24 cells remain after the right zone): the `/rename` title in quotes or the run id. **Right**: `step 7/40 4m12s` (the `step N/` sentinel; `perf/first-frame.ts:27` searches the accumulated bytes, so the zone is free) · `run $x.xx/y.yy <word>` · `sess $x.xx/y.yy <word>` · git zone `⎇ main ↑2 · 3~ 1?` (≤ 24 cells; ≥ 100 columns only) · Jev sparkline `jev ▂▃▂▅▂▂▇▃▂▁▂▃` (last 12 requests, fixed 0–1000 ms scale, failed attempt = space; ≥ 100 columns) · ShortHelp `? help` / `Tab ⇥` / `Esc closes`. 10-cell meter bars only at ≥ 140 and tokens `gen 5.5k jev 28k` at ≥ 160 (A46 said 120/140; the F16 git zone and sparkline take those cells first — §22). Drop order when short: ShortHelp → sparkline → git → session meter → wall → centre. Level words `ok` (< 50 %), `half` (50–79), `high` (80–94), `critical` (≥ 95), `over` (exceeded; replaces `EXCEEDED`), `uncapped` (`none`, red). Spinner: braille frames at 8 fps only while a stage runs and no review is pending; `|/-\` under `--ascii`; static `•` under reduced motion with a 1 Hz functional tick; 1 Hz idle redraw for the wall clock only. Money uses two decimals in the status line (`usd2()`), three in items (`usd()`).

### 7.5 Toasts (A37; `src/tui/toasts.ts` `toastReducer`)

`! <text>` (2 s; 4 s for errors) and `✓ <text>` replace the left zone and are also `<Static>` items (`[ui] ! …`) except the Ctrl-C/Ctrl-D/Esc idle hints, which are toasts only unless the second press follows (§3.3). The queue holds ≤ 4; an error toast pre-empts an info toast.

### 7.6 `/why` and `/calibration` (A47, 11 §4h–4i; jev-native's worked text is the reference rendering)

Both are appended `<Static>` items with a multi-line `detail` (≤ 60 lines), `local: true`. `/why s7.risk.plan_mismatch` (or `w`+`3`):

```
[ui] why s7.risk.plan_mismatch  request a1b2c3d4  244ms  typesafe/jev-1.13-20260917
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

Nouls print instructions, `criteria.true/false.definition` and examples, `p`, `|2p−1|`, `consumedBy`; Choices print one bar per option including `none_of_these`, the paired Noul beside each and the resolution rule that fired (`chosen`/`overridden`/`fallback`). Ref grammar `s<step>.<stage>.<id>`, `<stage>.<id>` (current step) or a pane digit (last 3 steps in memory; older refs read `decisions.jsonl` idle-only). `/calibration` (idle-only; the scan is capped at the newest **50** runs or 32 MB of input, whichever comes first — 10 §14 measured `steps.jsonl` at 166 MB over 140 runs, so 200 runs would be a ~1 s main-thread stall; `decisions.jsonl` is read whole, `steps.jsonl` line by line through `readline` over `createReadStream(64 KiB)` extracting only the ≤ 20 label fields (`step`, `outcome.status`, `judge.succeeded`, `tests.parsed.*`, `risk.verdict`, `completion`, `decisions[].{id,probability}`), so each chunk costs ≈ 0.2 ms and the event loop never stalls (14.9 ms for the largest 4.4 MB file spread over ~70 awaits); toast `calibration: scanning N runs…` while it runs and the block appended on completion; never per frame): `[ui] calibration  N runs  N decisions  N with a label`, label sources (review verdict vs reviewer answer, `done_<j>` vs a later parsed test result, `task_complete` vs bench `pass`, `succeeded` vs `exec.ok`/`tests.allPassed`), 10 equal-width bins `bin  n  mean p  observed  bar`, `ECE 0.031 (10 equal-width bins)   near-threshold (|p−t| ≤ 0.03): 57 (1.2%)`, per-threshold counts `risk@.30 risk@.70 complete@.85 plan@.70 context@.50`, `sharpness: 71% outside 0.2–0.8`. Plain twins: `jevcode why <run-id> <step> <ref>` and `jevcode calibration [--runs-dir]` print the same blocks without the `[ui]` prefix.

### 7.7 Ctrl+O detail appends (A22)

Ctrl+O appends, as items, the last step's decisions as one `/why`-style block per stage (probabilities and criteria), then the recent warnings/errors (clearing `!n`). Never resizes or remounts the pane.

### 7.8 The agent stream surface (AGENT-LOOP-DESIGN §9.4, §A1, §A3, §A5; slice S5a)

An agent run (`mode: 'agent'`) gets `UiState.agent` (an `AgentUi`); every legacy run keeps `agent: null` and every frame described above. The view streams only while its run is in flight (`agentInFlight`: `live` / `aborting` / `pausing`); after `run:end` it only says how the run ended, so a later legacy-mode chat reply in the same session (`/mode llm-jev`) is the legacy live region again.

- **The reply block** (`src/tui/ReplyTail.tsx`, `src/tui/reply-state.ts`). The model's prose streams in place ABOVE the rule, as `[jevcode]` rows from the first token — a line with no newline yet is text, wrapped, with the caret `▍` on a free cell of its last row; never a `streaming… N chars` counter. The rows come from `proseItemRows` (`Transcript.tsx`), the same builder `<Static>` draws a committed prose item with, over `wrapProse` (`transcript/wrap.ts`: greedy, grapheme-aware, prefix-stable — no no-orphan rule) and a light markdown (`transcript/markdown.ts`: bold, inline code, bullets with a hang, numbered items, headings, fenced code in the `code` role; every marker a left-to-right toggle, so a partial line is a prefix of the finished one). `assistant:text` commits the buffer through its last newline and keeps the partial line (not a clear); the committed rows are the rows the block drew, so the move into the scrollback shifts nothing and clears nothing. All prose rows share the one `[jevcode]` label (a reply is one contiguous block; the spacer only between turns and around tool rows); blank lines are kept; no 600-char clip and no 24-row cap. When the block outgrows its grant — a long paragraph, a code block the shaper holds, or a budget that shrank because the composer grew, an overlay opened or the terminal resized — the reducer commits its oldest rows early (whole lines, then the finished rows of the line still streaming, never its last row, and never a spacer or label row without a body row under it — the block would otherwise tail-cut its spacer for a frame). The block and the committed rows draw one text: control characters and CRs dropped and format-pattern keys redacted (`patternRedact`) before the layout, so a cut offset means the same thing live and committed; a line still streaming is never cut inside its trailing key-character run or past a header anchor. `assistant:reset` drops the uncommitted text and leaves the dim `[jevcode]` row `reply restarted after a dropped stream`.
- **The live region** (`agentLiveLines`, `App.tsx`) shows the tool row executing now with the last lines of its output under it (tail-aligned; a partial line is text), else the read-only calls in flight (`Read a.ts · Grep "x" in src…`), else the call whose arguments stream (`writing edit_file src/a.ts… 1.2k chars`), else a dim `thinking… 1.2k chars · <tail>` while only reasoning has come (gone for the rest of the turn once its prose started).
- **Tool rows** are the agent `[step N]` rows (`agentStepText`, `plain.ts`): `Read calc/core.py, tests/test_core.py · Grep "parse" in calc (3 matches)` for a read-only batch, `Edit calc/core.py (+2 −2)`, `Write notes.md (+12 −0)`, `Bash python -m pytest -q · 7 passed` (or `· exit 1`), `Verify npm test · 12 passed` for the harness's own run, then the wall time and the cost of a step that sampled a turn — no `risk … ok`, no `judge …`. Consecutive step rows form one block. A read-only `tool:result` is a full-view row (`tool · read_file src/a.ts (lines 1-120) · 3 ms`); the finish row (`done`) is out of the compact view.
- **A reply is a reply** (§A1, §A5). Until the first tool activity (`isAgentToolActivity`: a tool call, a proposal other than `done`, a command) the run keeps the chat's chrome — the `(thinking…)` placeholder, the idle border and prompt colour, the status row `thinking` then `replying` with `step 0/–` — and Esc / Ctrl-C ABORT it (the controller treats that as "reply stopped"); a stopped reply winds down with the same chrome (`aborting` keeps it). Its run rows (`[run] started`, `instructions:`, informational notices, step rows) are held; the first tool call lands them and brings the run chrome (and the run-start sweep). A run that ends `answered` (or `isReplyOnlyRun`, or a stopped reply) shows only its prose: the held rows, the finish row and `[run] finished` are appended hidden, the status row is the chat's idle row (`idle · step 0/–`, no `exit 0`), and the rule row stays the brand row until a run that used a tool (`UiState.repliesEnded`). `[run] finished` of an agent run that used no Jev drops the `jev $0.000` part of its cost split.
- **Status words** (peer review C): `thinking` (a model turn), `reading` (a read-only batch), `editing` / `running` (the mutating call), `testing` (the harness's test run) — named from t = 0 of each step, before any engine `status` event. No Jev sparkline and no `jev …` token segment in agent mode; the rule strip reads `▸ s<N> · plan d/t · <k> tool calls`; the decisions tab of a run with no Jev decision reads `a normal agent run makes no Jev decisions`.
- **The mini indicator** (§A3, `src/tui/anim/frames.ts`). The 12-row 3D slot is gone from the layout in every mode. The status row's glyph cell holds a braille animation keyed on what runs: a ring with a travelling dark arc (donut) for a model turn, a ring with a sweeping meridian (globe) for reading, a box whose inner edge sweeps (cube) for an edit, a write or a command, a travelling sine (wave) for the harness's tests (legacy modes: by stage). It is 3 cells when the row has room (6 × 4 dots: enough for the ring to have a hole) and the old 1-cell slot otherwise — the two extra cells are the first thing the row gives up, so at 80 columns during a busy run it costs nothing; it steps on the spinner's own 125 ms tick (no timer of its own), is a still frame over SSH and under reduced motion, a one-cell ASCII twin under `--ascii` / NO_COLOR, and absent under a screen reader.
- **`--plain`** prints the prose as it arrives, each line under `[jevcode] ` (a blank line is `[jevcode]`, byte-equal to its transcript.log row), skips the `assistant:text` rows of a turn that streamed, holds the run rows until the first tool call and drops them for a reply — a tool-less turn prints only `[you] …` / `[jevcode] …`. `--json` keeps every event.

## 8. Sessions, steering, pause, history, export, `--json` (F7)

### 8.1 Data model (A52, A55)

```
~/.jevcode/runs/<run-id>/            unchanged files, plus (all additive, §15):
  run.json      RunMeta + sessionId?, parentRunId?, source?, title?, git?, instructions?
  state.json    CheckpointState + pendingDirectives?, undoLog?, checkpointDegraded?   (envelope version stays 1)
  steps.jsonl   StepRecord + planAfter?  (bench readers destructure known keys)
  pre/<step>/<sha256(relpath)>  pre-images; pre/<step>/dirs.json = directories the step created
  post/<step>.json              post-image hashes (§12.3); renamed post/<step>.undone.json by /undo
  ui.json       redacted draft + chips (§10.3), written at checkpoint boundaries and shutdown only
  jevcode.log   per-run log (§13.6)
  run.lock      { "pid", "startedAt", "host" } while an engine holds the run (§8.5)
  tmp/          diff patches; this is the sandboxed command's TMPDIR (readable and writable by commands — never a draft)
  drafts/       external-editor drafts, 0600, unlinked on return; outside runTmp/runHome so no command can read them (§4.8)
~/.jevcode/sessions/index.jsonl      append-only, ≤ 512-byte lines, v:1 (§8.2)
~/.jevcode/history.jsonl             §4.6
~/.jevcode/trust.json                §11.3
~/.jevcode/logs/jevcode-<pid>-<stamp>.log   pre-run and fallback logs (newest 10)
~/.jevcode/reports/<run-id>/         §13.6
~/.jevcode/trash/<run-id>/           picker `x` moves run dirs here (never rm -rf)
~/.jevcode/exports/<sessionId>.log   /export default target
```

Session = ordered runs in one workspace realpath; `sessionId` = first run id; a follow-up's `parentRunId` = the run it was seeded from; `/resume` keeps the `sessionId`. Legacy `run.json` reads as `{ sessionId: runId, parentRunId: null, source: workspace.includes('/bench-work/') ? 'bench' : 'cli', instructions: [] }` (`isRunMeta`/`isCheckpointState` at `store.ts:108–146` check v1 fields only, so old files load unchanged).

### 8.2 `~/.jevcode/sessions/index.jsonl` (A55; `src/session/index.ts`)

```jsonc
{"v":1,"t":"2026-09-20T14:02:11.123Z","kind":"run:start","sessionId":"…","runId":"…","parentRunId":null,"workspace":"/Users/me/proj","task60":"fix parse_date tz handling","mode":"jev-on","source":"cli","branch":"main","resumeOf":null}
{"v":1,"t":"…","kind":"run:end","sessionId":"…","runId":"…","stopReason":"complete","steps":9,"costUsd":{"generator":0.104,"jev":0.011},"wallMs":183000,"changedFiles":3,"exitCode":0,"resumable":true,"degraded":false}
{"v":1,"t":"…","kind":"rename","sessionId":"…","title60":"tz fixes"}
{"v":1,"t":"…","kind":"steer","sessionId":"…","runId":"…","step":4,"text60":"also update the docs"}
{"v":1,"t":"…","kind":"undo","sessionId":"…","runId":"…","step":7,"by":"undo","files":3,"skipped":1}
{"v":1,"t":"…","kind":"pause","sessionId":"…","runId":"…","step":5}
{"v":1,"t":"…","kind":"budget","sessionId":"…","runId":"…","setting":"session.spendCapUsd","from":"10","to":"15"}
```

`task60`/`title60`/`text60` = `clip(oneLine(redactor.redact(x)), 60)` (judge-safety E13). Writer: `appendFileSync(path, line + '\n')` under `O_APPEND` (one syscall, ≤ 512 B after JSON.stringify or the line is dropped with a log warning; P11: no lock file, `jevcode sessions reindex` is the repair path). Written only when `source === 'cli'`. `run:start` right after `store.create`/resume load; `run:end` after `finish()`'s final `writeState`. Fold:

```ts
export interface RunRow { runId: string; parentRunId: string | null; startedAt: string; endedAt: string | null; stopReason: StopReason | null; steps: number | null;
  costUsd: { generator: number; jev: number } | null; exitCode: number | null; resumable: boolean | null; resumes: number; live: boolean }
export interface SessionRow { sessionId: string; workspace: string; title: string; task60: string; runs: RunRow[]; lastUsed: string; createdAt: string; totalUsd: number; mode: EngineMode; branch: string | null }
export function foldIndex(lines: readonly string[]): { sessions: Map<string, SessionRow>; skipped: number }; // group by sessionId; per runId the last run:start/run:end win; title = last rename else first task60; lastUsed = max t over all kinds; a torn last line is skipped
export function readIndex(path: string): Promise<{ sessions: SessionRow[]; skipped: number }>;              // one readFile; 0.26 ms at 141 runs (14 §2.2)
export function appendIndexLine(path: string, line: IndexLine, redact: (s: string) => string): void;
export function reindex(runsDir: string, out: string): Promise<{ runs: number }>;                            // run.json + stat(state.json).mtime
```

Folded once per session open, `/resume`, `run:end` and `budget:override` (A139); the in-memory `SessionRow` is authoritative between.

### 8.3 Follow-up seeding (A52, 10 §15.2; `src/session/seed.ts`, pure)

```ts
export function buildSeed(parent: { meta: RunMeta; state: CheckpointState }, opts: { humanNotes: readonly string[]; pinnedFiles: readonly string[]; rewind?: { step: number; planAfter: PlanSnapshot | null } }): EngineSeed {
  const src = opts.rewind?.planAfter ?? parent.state.plan;
  const plan: Plan = {
    done: src.done, remaining: src.remaining, unverified: src.unverified, openProblems: [],          // generator-owned, replaced each step
    harnessProblems: [
      { kind: 'human', step: 0, text: `Follow-up to run ${parent.meta.runId} (stopped: ${parent.state.stopReason ?? 'in progress'}) whose task was "${clip(parent.meta.task, 200)}"; the task above is the human's next instruction` },
      ...opts.humanNotes.map((t) => ({ kind: 'human' as const, step: 0, text: clip(t, 600) })),    // 'human reverted step 7: …', '/rewind plan+window to step N'
      ...(parent.state.pendingDirectives ?? []).map((d) => ({ kind: 'human' as const, step: 0, text: clip(d.text, 600) })),   // steers queued while the parent was pausing/aborting: carried, never dropped (S7 Enter, §3.3)
    ],
  };
  const window = (opts.rewind ? parent.state.window.filter((e) => e.step <= opts.rewind!.step) : parent.state.window).slice(-4)
    .map((e) => ({ ...e, notes: [...e.notes, `from run ${parent.meta.runId}`].slice(0, 12) }));
  return { parentRunId: parent.meta.runId, plan, window, createdThisRun: parent.state.createdThisRun, lastTestRun: parent.state.lastTestRun, undoLog: parent.state.undoLog ?? [], pinnedFiles: [...opts.pinnedFiles] };
}
```

**Seed source rule** (sessions graft): the most recent run of the session with `state.step > 0`, else the most recent run; a run stopped at step 0 (config/401) contributes nothing but is still the `parentRunId`. Engine side (constructor, non-resume branch, `engine.ts:440`): `plan/window/createdThisRun/lastTestRun ← seed; lastChangeStep = null` (so `testsCurrent` is recomputed honestly); `undoLog ← seed.undoLog`; spend, wall, loop detector and `resolvedJevModel` start fresh; the run's `task` is the follow-up text and the completion Noul judges it alone (P7); step 1 of a seeded run passes `human: true` to `applyPlanDraft` so Plan rule (b) may drop obsolete `remaining` items without a `replan` problem. Transcript line (engine `notice kind:'seeded'`): `seeded from run <id>: plan done=4 remaining=2 unverified=1 · window 4 entries · 3 created files` plus ` · 1 pending steer carried` when the parent left `pendingDirectives` behind. Seed problems carry `step: 0` on purpose: `applyPendingDirectives` (§8.6) supersedes only steer problems (`step > 0`), so the follow-up framing and `/undo` notes survive the first mid-run steer.

### 8.4 Picker (A56, 10 §15.6; in the pane slot, composer = filter)

Data: the fold filtered by workspace realpath (Ctrl-A widens); `state.json` of the highlighted row parsed only on Space (plan counts, spend, stop, `interrupted`) plus a 4 KB tail of `transcript.log`; never `steps.jsonl`. Rows `time ago │ steps │ stop (verdict colours + word) │ $cost │ title-or-task60 │ (workspace when widened) │ ● live when a live `run.lock` exists`; header `─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────`. Keys: `↑/↓`, `Ctrl-P/N`, PgUp/PgDn, Enter (a stopped run → `/resume` flow with the §9.3 gate; a `complete` run → follow-up composer seeded from it), Tab (accept and keep filtering), Space preview, typing filters (title, task, id; §5.4 scorer), Ctrl-A, Ctrl-R rename (inline one-row field, index `rename` line), `x` then `y` delete (moves `<run-id>/` to `~/.jevcode/trash/`; never `rm -rf`; never for `source !== 'cli'`), Esc. Sort updated (default) / created (`/resume --sort created`). `-c/--continue` = the row with the greatest `lastUsed` in this workspace (A56, C37); `--resume <id|title>` matches a run id, then an exact title, then a unique case-insensitive title prefix; ambiguity → `ConfigError` listing candidates; on a different `git.head` it warns (P52). The recent-session hint row appears after the first frame from the same fold; `jevcode sessions reindex` is offered when `index.jsonl` is absent and `runs/` is not empty. `--list-sessions` prints the rows and exits.

### 8.5 `run.lock` (A55; sessions graft)

`<runDir>/run.lock` = `{ "pid": 4242, "startedAt": iso, "host": os.hostname() }` written by `createEngine` after `store.create`/resume load, removed in `finish()` (and by the `'exit'` handler). On resume: a lock whose `pid` is alive (`process.kill(pid, 0)` succeeds) on the same `host` → `ConfigError` (exit 2) `run <id> is in use by pid 4242 since <t> (another jevcode?); run 'jevcode sessions unlock <id>' if that process is gone`; a dead pid or another host → replaced with a `jevcode.log` warning. The picker shows `● live` on such rows.

### 8.6 Steering: consumption in the engine (A53, 10 §15.3; insertion points §15.2)

```ts
// EngineImpl (engine.ts), additive
steer(text: string, o: { secretsAcked?: number } = {}): SteerResult {
  if (this.lastResult !== null) return { ok: false, reason: 'finished', queued: this.pendingDirectives.length };
  const t = clip(sanitizeStream(text).trim(), 600);                    // RAW, exactly like PromptInput.task (F9/A156): emit()'s redactDeep (engine.ts:578), the store's
                                                                       // write-time redaction (store.ts:70,95) and state.ts:133 mask every artefact and Jev's state; the generator sees it raw
  if (t.length === 0) return { ok: false, reason: 'empty', queued: this.pendingDirectives.length };
  if (this.pendingDirectives.length >= 8) return { ok: false, reason: 'full', queued: 8 };
  const d: PendingDirective = { text: t, at: nowIso(), index: ++this.steerSeq };
  this.pendingDirectives.push(d);
  if (o.secretsAcked) this.emit({ type: 'secret-ack', step: this.step + 1, count: o.secretsAcked });   // the ack is true: the secret does reach the generator
  this.emit({ type: 'steer:queued', step: this.step + 1, index: d.index, text: t, queued: this.pendingDirectives.length });   // item `steer queued (1) for step 8: …` (text redacted at emit)
  return { ok: true, index: d.index, queued: this.pendingDirectives.length };
}
unsteer(): PendingDirective | null { const d = this.pendingDirectives.pop() ?? null; if (d) this.emit({ type: 'steer:withdrawn', step: this.step + 1, index: d.index }); return d; }
pause(): void { if (this.lastResult || this.pauseRequested) return; this.pauseRequested = true; this.emit({ type: 'pause:requested', step: this.step + 1 }); this.emitStatus(); }
retryNow(): boolean { const w = this.retryWaker; if (!w) return false; w.abort(); this.retryWaker = null; return true; }   // lifecycle §13.2: onRetry creates a fresh controller before every sleep
annotate(text: string, o: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' } = {}): boolean {          // §15.1: a renderer-originated line while the run is live
  if (this.lastResult !== null) return false;                                                                            // finished → the renderer keeps it local
  this.emit({ type: 'notice', step: this.step > 0 ? this.step : null, kind: 'ui', level: o.level ?? 'info', label: o.label ?? '[ui]',
    text: clip(sanitizeStream(text), 600), ...(o.detail ? { detail: clip(sanitizeStream(o.detail), 12_000) } : {}) });
  return true;
}

// main() loop (engine.ts:559–570) — the only consumption point: a §9.1 rule-1 boundary, after checkBudgets(), before runStep()
for (;;) {
  if (this.signal.aborted) return this.finish(classifyAbort(this.signal.reason).stop);
  const budget = checkBudgets(this.budgetInput()); if (budget !== null) { …; return this.finish(budget); }
  if (this.pauseRequested) return this.finish('human_pause');          // NEW: nothing in flight, the previous commit is whole
  if (this.blocked) { const a = await this.awaitBlocker(this.blocked); if (a === 'stop') return this.finish(this.blocked.stop); this.blocked = null; }   // NEW §13.3
  this.applyPendingDirectives();                                       // NEW
  const result = await this.runStep(); …
}
private applyPendingDirectives(): void {
  if (this.pendingDirectives.length === 0) return;
  const step = this.step + 1;
  const texts = this.pendingDirectives.map((d) => d.text);           // each ≤ 600, ≤ 8 of them → ≤ 4,800 chars; NEVER re-clipped as a batch (F7: max 8 × 600)
  const isSteer = (h: HarnessProblem): boolean => h.kind === 'human' && h.step > 0;   // seed / undo problems carry step 0 (§8.3) and are never superseded by a steer
  const superseded = this.plan.harnessProblems.filter((h) => isSteer(h) || h.kind === 'replan');
  const added: HarnessProblem[] = texts.map((text) => ({ kind: 'human', text, step }));   // one problem per directive: ≤ 8 of the 16 PLAN_MAX_HARNESS_PROBLEMS slots (plan.ts:16); planJson clips per problem at 600 (state.ts)
  this.plan = { ...this.plan, harnessProblems: [...this.plan.harnessProblems.filter((h) => !isSteer(h)), ...added].slice(-PLAN_MAX_HARNESS_PROBLEMS) };
  this.activeHuman = { texts, step };                                  // reaches exactly this step's prompt hints, common state and SynthesisContext.directive; cleared at commit
  this.detector.resetCounts();                                         // counts and tripped cleared; trips history and replanCount kept
  this.pendingDirectives = [];
  this.emit({ type: 'steer:applied', step, count: texts.length, superseded: superseded.map((h) => clip(h.text, 80)) });   // item names the superseded problem text, never silently
}
```

Where the directives reach each consumer: `promptInput()` (`engine.ts:1168`) sets `humanDirectives: this.activeHuman?.step === draft.step ? this.activeHuman.texts : []` → `hintsSection` (`prompts.ts:155`) renders **one line per directive** `- Instruction from the human for this step (it takes precedence over the plan's order): <text ≤ 600>` after the replan line (≤ 8 lines; `hintsSection` already clips per line at 600); `commonState()` (`engine.ts:1141`) passes `human: { directives: texts, step }` under the same step rule → `state.human.directives` (≤ 8 × 600, redacted by `redactJson` at `state.ts:133`) so intent, context, risk and judge see them (P1: Jev sees it — masked where the human acked a secret, raw otherwise); `synthesisContext()` (`engine.ts:861`) sets `directive: [draft.directive?.text, ...(this.activeHuman?.step === draft.step ? this.activeHuman.texts : [])].filter(Boolean).join('\n\n') || null` with **no 600-char clip on the join** (`parseDirective` only scans for a move name) — in jev-only `parseDirective` maps text naming no move to `FALLBACK_MOVE` (`change_approach`, `src/synth/search/directive.ts:104–108`, verified by the engineering judge), so a human steer works without touching `src/synth`. `activeHuman` is cleared in `commit()`; on `--resume` it is **re-derived** from `plan.harnessProblems.filter((h) => h.kind === 'human' && h.step === this.step + 1)` (no new checkpoint field), so a rule-1 discard or crash followed by a resume re-arms the hint, `state.human` and `SynthesisContext.directive` — the synthesizer's only channel. Steer problems (`step > 0`) are dropped by `applyPlanDraft` when superseded or when `step > h.step + 4`; seed and undo problems (`step === 0`) are never superseded by a steer and expire only when `step > 8`, so the follow-up framing F7 requires survives the first mid-run steer. `buildCheckpointState()` carries `pendingDirectives` (redacted on disk, P56) so a steer queued before a crash or during `pausing` survives `--resume` and, through `buildSeed` (§8.3), a follow-up; because `finish()` snapshots after `applyPendingDirectives`, a rule-1 discard still checkpoints the directives inside `harnessProblems` (nothing is lost). `y`/`n` during a review and slash commands never steer. This is the one plan mutation outside `commit()`; DESIGN §11's state-mutation rule is amended to "commit, and step start for human directives".

### 8.7 Pause, `/export`, `/theme`, `planAfter`

`human_pause` = `finish('human_pause')` at the loop top: the in-flight step commits whole first; `StopReason 'human_pause'` (exit-4 family); `storedStopBlocks` (`engine.ts:446`) and `BUDGET_STOP_REASONS` exclude it so `/resume` proceeds without `--force` (`token_cap` is the opposite: a plain budget stop — the resume branch rebuilds `generatorTokens = Σ generatorTokensPerStep` and `isPlainStopBudget`/`storedStopBlocks` gain `case 'token_cap': return generatorTokens >= lim.maxGeneratorTokens ? r : null`, so `/resume` is refused until `/budget max-generator-tokens <n>` raised the limit, §9.5); `run:end` item `end human_pause steps=5 …`; epilogue `paused after step 5 — /resume continues, or type a follow-up`; status `pausing after step N` between Esc and `run:end`; index `pause` line. Bench and `--plain` on a pipe never pause (no key can request it). `/export [file]` writes `<file | ~/.jevcode/exports/<sessionId>.log>`: per run `==== run <id> · <t> · <task60> · <stopReason> · $<cost> ====` then that run's `transcript.log` verbatim (already redacted; renderer-local `[ui]` items are not in it by construction), 64 MiB cap with a trailing `… truncated` line. `/theme` swaps the colour table for new items and the dynamic region only (no `<Static>` remount, R4). `StepRecord.planAfter?: PlanSnapshot` (bounded 20 × 200 per list) is written at commit so `/rewind N plan+window` seeds from step N without replaying drafts (P10).

### 8.8 `ui.json`

`<runDir>/ui.json` (or `~/.jevcode/sessions/ui-<pid>.json` before a run exists): `{ "v": 1, "text": <redact(draft) with detectSecrets spans → [REDACTED:draft]>, "cursor", "chips": [{ n, lines, bytes, fp8 }], "tab", "theme" }` (`fp8` = 8 hex of the body's sha256, like the wizard's fingerprints — never the full digest, which would be an offline oracle for a short paste; chip identity on resume is `n` + `bytes`), written at checkpoint boundaries and on exit, never per keystroke (16 §4.3; judge-safety E9). On `--resume` the draft is restored; an unrestored chip cancels a submission (§4.5).

### 8.9 `--json` stream (A61, A138, A158, A170; `src/cli/json-stream.ts`)

NDJSON on stdout. First line `{"v":1,"type":"stream:start","schema":"jevcode.events/1","jevcode":"<version>","t":iso}`; every further line is `{ "v": 1, "t": iso, "runId": string|null, "sessionId": string|null, ...EngineEvent }` — the redacted `EngineEvent` after `config.redact` — plus controller lines that involve no engine: `session:start { sessionId, runId, parentRunId, workspace }`, `session:end { reason: 'exit' | 'error', runs, exitCode }`, `session:budget { setting, from, to, appliesTo }` (a `/budget` change while idle), `session:refused { reason: 'session-cap' | 'unpriced' | 'secret'; spentUsd?; capUsd?; exitCode }` and `ui { text, label }` for idle-time renderer-local items; while a run is live renderer-originated lines are ordinary `notice { kind: 'ui' }` engine events (§15.1). `run:end` carries `exitCode`, `resumable`, `paths`. **Redaction guarantee** (16 §4.7, verbatim in DESIGN §10 and `--help`): every string is the `EngineEvent` after `config.redact` — configured secrets, `Send anyway`-confirmed values and recognised formats become `[REDACTED:<name>]`/`[REDACTED:pattern]`; the stream never contains keystrokes, composer drafts, pasted payloads or key material; a human turn is the `run:start` task line and `steer:queued` lines holding the redacted submitted text; `secret-ack` carries a count only (P59); an unrecognised-format secret typed inline passes through, as in `transcript.log`. Consumers ignore unknown `type`s; `v` increments only on an incompatible change; additive fields never bump it. No countdown ticks (`retry` carries `waitMs`); `status` events only with `--json=verbose`.

### 8.10 Backward compatibility

`CheckpointEnvelope.version` stays `1`; every new `CheckpointState`/`RunMeta`/`StepRecord` field is optional and absent-tolerant like `generatorTokensPerStep` today; `foldStepsIntoState` and the bench's `steps.jsonl` readers ignore `planAfter`; `BenchStopReason = StopReason | 'not_run'` widens automatically and `bench/metrics.ts` treats `human_pause`/`token_cap` as non-pass stops like every non-`complete` reason; `run-events.json` keeps type-checking because every event extension is optional (§15).

## 9. Money (A129–A139, F8)

### 9.1 Meter tree (D3)

`cli/session.ts` creates `sessionMeter = createSpendMeter(sessionCapUsd)` once per session (`none` → `+Infinity`, meter word `uncapped` in red); every run gets `sessionMeter.child(Math.min(runCapUsd, remaining))` where `remaining = sessionCap − sessionMeter.snapshot().totalUsd`. Two additive mechanisms replace the unstated or broken ones in the four designs: `SpendMeter.setCap?(capUsd)` (jev-native; `createSpendMeter` makes `cap` a `let`, so `/budget session-spend-cap` mutates the **same** root every live child forwards to — sessions' root recreation orphaned the child, judge-safety E3) and `SpendSnapshot.parent?: { totalUsd, capUsd }` (sessions; filled by `createSpendMeter(cap, parent)` from `parent.snapshot()`), so the engine can emit session-scope `budget:warn` after every `meter.add()` without knowing the parent object. After a raise a live child's `snapshot()` reports its own unchanged `capUsd` and the new `parent.capUsd`; `exceeded()` reads the parent's new cap on the next call. Default session cap = 5 × run cap: $10.00 for the $2.00 default, $1.25 for jev-only's $0.25 run default — the mode-keyed run default lives in `resolveConfig` after `--mode` is known (P45) and `jevcode config` prints `session.spendCapUsd  $10.000 (default: 5 × limits.spendCapUsd)`. **On `/resume`:** fold the index for the `sessionId` **excluding the resumed `runId`**, `sessionMeter.add()` per finished run's `run:end` costs, **then create the child** with `Math.min(runCapUsd, remaining)` computed **before** the resumed run's own spend is added (equivalently `min(runCap, remaining + resumedSpend)`), then `sessionMeter.add(state.spend)` and `runMeter.restore(state.spend)` (`restore()` never forwards and never touches the cap, `meter.ts:80–86`; the exclusion fixes the double count of judge-safety E11). Order matters: with cap $10.00, earlier runs $8.00 and a resumed run at $1.50 of $2.00, adding first would give `remaining` $0.50 → child cap $0.50 → `restore($1.50)` → `exceeded()` true at the first `checkBudgets` with $0.50 of session budget unspent (§19.4 case). Bench/perf keep their own root.

### 9.2 Thresholds (A131, C51)

After every `meter.add()` in `askRecorded` (`engine.ts:790`) and `generate` (`engine.ts:928`) the engine computes `pct = floor(100 × total / cap)` for the run (its own snapshot) and the session (`snapshot.parent`) and emits `budget:warn { scope, pct ∈ {50, 80, 95}, spentUsd, capUsd, step, stepsLeftEstimate, restored }` once per `(scope, pct)` per run (the session set is seeded from the controller so a threshold already crossed in an earlier run is not re-announced), highest only when one add crosses two, re-emitted once with `restored: true` after a resume, never for `+Infinity`. Surfaces: `<Static>` item `[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps left at $0.040/step` (session variant `[run] budget: session spend $8.000 is 80 % of the $10.000 session cap — raise it with /budget session-spend-cap <usd>`), 2 s toast (4 s at 95 %), the meter level word, opt-in BEL/OSC 9 only at 95 % and `budget:stop`; `JEVCODE_BUDGET_WARNINGS=0` / `ui.budgetWarnings: false` mutes toast and bell only — the item and the JSON event are never suppressed. When Jev outspends the generator at a crossing the item appends ` — Jev is the larger share ($0.031 vs $0.020); see /jev`. No 95 % pre-emption (P47).

### 9.3 Follow-up confirm and refusal (A132, 14 §4.3)

At Enter with `run === 'none'` after at least one run: `remaining ≥ runCap` → start; `0 < remaining < runCap` → the 5-row box (F-P/F-Q): `y` (armed one frame after the box, §6.3) start with the child cap clamped — the controller passes `session.clamp = { runCapUsd, clampedToUsd, sessionSpentUsd, sessionCapUsd }` in `EngineOptions` and `main()` emits `budget:clamp` right after `run:ready`, so the item is an **engine** item present in all three writers (a controller cannot inject an event into a store), `r` prefill `/budget session-spend-cap <sessionCap + runCap>` in the composer, `n`/Esc cancel (draft kept), **Enter inert**, composer inactive; `remaining ≤ 0` → refuse with the item `[run] session cap reached ($10.31 of $10.00). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.` + 4 s toast. `--plain`/`--json`/`--no-input`: `0 < remaining < runCap` → clamp silently (`budget:clamp` from the engine as above); `remaining ≤ 0` → the refusal line on stderr / `session:refused { reason: 'session-cap' }` on the `--json` stream (§8.9) and exit 4 — no engine exists yet, so there is no `budget:stop` event for this case (its `at` stays `StoppedAt`). The box's truncation at 3 rows: title, keys, session line.

### 9.4 `/budget` (A134, C45)

`/budget` alone prints run cap, session cap, both spends and pending values as one item block. `/budget spend-cap <v>` (`v` must exceed the target run's spend: `[ui] error: /budget spend-cap 1.20 is not above this run's spend $1.532; give a larger value`) applies to whichever comes first — the next `/resume` of the stopped run (through `reconcileResumeConfig` as an augmented `--spend-cap` flag → `run.json.overrides[]`, `budget:override { source: '/budget' }`) or the next new run (config source `session:/budget`) — never a live run; the pending value lives in memory only (P46) and `/cost` shows it as `pending`. `/budget session-spend-cap <v|none>` → `sessionMeter.setCap(v)` immediately + index `budget` line + the line `budget: session cap $10.00 → $15.00 (applies now)` — a renderer-local `[ui]` item while idle (no engine exists) and an `engine.annotate()` line while a run is live so it reaches `transcript.log` too (§15.1); `budget:override` is an **engine** event, emitted by `main()` only for the overrides recorded in `run.json.overrides[]` on this resume (`source: '/budget' | 'flag'`, `appliesTo: 'resume'`). `max-steps|max-wall|max-replans` follow the spend-cap rule. The `spend_cap` epilogue in session mode: `[ui] stopped by the run spend cap: $1.532 of $1.500 (over by $0.032, one judge call). Session $4.11/$10.00 ok.` + `continue this run: /budget spend-cap 3.00 then /resume` + `or start a follow-up run with a fresh $1.500 cap`; the `by: 'session'` variant names `/budget session-spend-cap` and the refusal.

### 9.5 Unknown pricing fails closed (A135–A137, gap 32)

`validateGenerator` (`validate.ts:96`) returns `priced: boolean` (`PRICING_TABLE` hit or both `JEVCODE_PRICE_*_PER_M` overrides); `provider === 'anthropic' && !priced && !allowUnpriced` → `ConfigError` on `generator.model` (exit 2): `generator.model "<id>" has no pricing entry, so the $2.000 spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.` (the flag is named). `--allow-unpriced` → `RunLimits.maxGeneratorTokens` (default `spendCapUsd / 15 × 1e6` ≈ 133k for $2.00, Q40 conservative), `BUDGET_ORDER` gains `token_cap` after `spend_cap`, `StopReason 'token_cap'` (exit 4), figures render `$?`, status `gen 43.1k/133k tok`; the counter survives `--resume` (rebuilt from `generatorTokensPerStep`) and `storedStopBlocks` treats `token_cap` like `spend_cap` — blocked until `/budget max-generator-tokens <n>` raises the limit (§8.7). OpenRouter/Jev `usage.cost` `null`/non-finite → `budget:unpriced` and stop `error unpriced_usage` after the step commits unless allowed. `config.warnings` are printed (`jevcode: <warning>` on stderr in plain, one `[run] warning: …` item in the TUI) (A136). `~` marks table-priced figures, none on provider `usage.cost`, `$?` under `--allow-unpriced`; cache rates derive as 0.1× / 1.25× input when absent with the source column saying `derived`.

### 9.6 Status meters and `/cost`

Right zone: `run $1.60/2.00 high  sess $4.11/10.00 ok` at ≥ 80 columns; bars at ≥ 140; tokens at ≥ 160. `/cost` = one `[ui]` block ≤ 12 rows: `run $0.310 of $2.000 (15 %)`, `session $4.11 of $10.00 (41 %, 5 runs)`, `per step p50 $0.023 · last $0.040 · about 10 steps left`, `gen $0.281 (~ table-priced) · jev $0.029 for 1,204 questions (~$2.4e-5 each, p50 237 ms)`, `basis: generator table (claude-sonnet-5), jev provider usage.cost`, `pending: spend-cap 3.00 (next /resume or run)`, `raise: /budget spend-cap <usd> · /budget session-spend-cap <usd|none>`; jev-only drops `gen`.

## 10. Secrets at every entry point (A153–A159, F9)

### 10.1 `detectSecrets` (`src/core/redact.ts`)

```ts
export interface SecretHit { family: string; label: string; start: number; end: number; warnOnly: boolean }
export const WARN_ONLY_PATTERNS: readonly { family: string; re: RegExp }[];   // AWS A3T…/AKIA/ASIA/ABIA/ACCA, Slack xox[abpers]-, hooks.slack.com/…, PEM with the PRIVATE KEY literal, JWT ey….ey…., Stripe (sk|rk)_(test|live|prod)_, npm_, hf_, glpat-
export function detectSecrets(s: string, exact?: Pick<Redactor, 'redact'>): readonly SecretHit[];
```

Families: the six `FORMAT_PATTERNS` (`redact.ts:42–49`, redacting; labels `sk-or-…`, `sk-ant-…`, `sk-proj-… (OpenAI)` (P55), `sk-…`, `AIza…`, `ghp_…`, `github_pat_…`) plus the warn-only families (C44 staging: promoted to redacting only after a week of real `history.jsonl` scans, Q35); `HEADER_PATTERN` excluded (9/9 false positives); `exact` present and `exact.redact(s) !== s` → a hit labelled `your <NAME>`. Labels carry ≤ 6 secret characters. `warnOnly` governs only whether `patternRedact` masks the family automatically; the gate's `y` hands **every** hit span to `addSecret` regardless (§10.2). Runs on every buffer change (the `⚠ secret?` marker) and at Enter; a 256 KB input must scan in < 5 ms (backtracking guard test).

### 10.2 Gate and `addSecret` (A154–A156)

Every composer submission, steer, `/rename` title and `d` note, in the TUI and the readline composer, passes the gate (§4.10) — and so does the task text `readTask()` returns from argv, `--task-file` or piped stdin (`main.tsx:31–41`), **before** `createEngine`: on a TTY one-shot the F-V row is shown before `run:ready` (the composer is mounted for steering anyway), `y` → `addSecret` + `EngineOptions.secretsAcked`; non-TTY, `--no-input` or `--json` → cancelled with `jevcode: the task contains a secret (<label>); refusing to start (exit 2)` on stderr (A154: a script piping a key fails loudly); bench keeps its own path. On `y`: for **every** hit span ≥ `MIN_SECRET_LENGTH` (8) — the six redacting families **and** the warn-only families alike (AWS `AKIA…`, JWT, Slack, Stripe, `npm_`, `hf_`, `glpat-`; PEM: the whole `-----BEGIN…END…-----` block via the end-anchored form) — the host calls `redactor.addSecret('composer#n', span)` (`SessionHost.addSecret`, §15 item 16) **before** `createEngine`/`engine.steer` receives the text. Adding the exact span the detector matched in the human's own text has zero false-positive cost, so C44's staging of the warn-only families applies only to `patternRedact`'s automatic masking, never to the gate; composer entries capped at 64 with `dropSecret` of the oldest. The engine then receives the **raw** text — `PromptInput.task` is not redacted (`prompts.ts:247`); a steer is stored raw in `pendingDirectives`/`activeHuman`/`plan.harnessProblems` (§8.6) and reaches `hintsSection` and `SynthesisContext.directive` raw exactly like `task`; the provider request stays raw by design (A156) — and emits `secret-ack { count }` → item `[step n] sent 1 secret to the generator on request` (`stepLabel`; `[run]` before step 1), which is therefore true for prompts and steers alike. Because `Engine.emit()` runs `redactDeep` (`engine.ts:578`), the store redacts every write (`store.ts:70,95`), and Jev state is redacted (`state.ts:133`), one `addSecret` masks `transcript.log`, `steps.jsonl`, `run.json`, `state.json` (so `pendingDirectives` restored from it are necessarily masked, P56), Jev requests, `--json`, error bodies, history, `sessions/index.jsonl`'s `task60` and `jevcode.log`. Scope = process; documented in README and `--help` as not surviving `--resume` (P56). `--no-input` → cancel. Before `renderer.setHost()` exists (the ~10 ms after `firstFrame()`) the composer detects with `patternRedact` only and holds any Enter until the host attaches (§4.9).

### 10.3 Paste chips and `ui.json`

§4.5 and §8.8. Chip bodies exist only in the `useRef` Map; history and `ui.json` store labels; `ui.json`'s draft text has `detectSecrets` spans replaced by `[REDACTED:draft]` so an unsent secret never reaches disk even before `y`.

### 10.4 `@` denylist and `--allow-secret-mention` (A157)

`isSecretPath()` (`sandbox/paths.ts:125`) gains `/credential/i` on the basename, `.npmrc`, `.pypirc`, `/\.(p12|pfx|jks)$/i`; `isMentionDenied(ws, rel, secretPaths)` adds the `@`-only `rel.startsWith('.git/')` rule; completion never offers a denied path; `--allow-secret-mention` / `JEVCODE_ALLOW_SECRET_MENTION=1` → per-mention `Attach anyway? y/N` row, `workspace.readSecretForMention(rel, 16_384)`, every `KEY=value` line whose value is ≥ 8 chars `addSecret`'ed as `mention:<KEY>` **regardless of the key's name** — a denylisted file is on the list because everything in it is presumed secret, and `DATABASE_URL=postgres://user:pass@host` or `SMTP_PASS=` never match `SECRET_NAME_RE` (`redact.ts:31`) — plus the `user:pass` component of every `scheme://user:pass@` URL and PEM bodies whole; the generator's own `read` keeps `SecretPathError`. No `.jevcodeignore` in v1.

### 10.5 Clipboard (A86, C12)

`/copy [last|proposal|diff|draft]`: payload = `redactor.redact(sanitizeStream(x))`, 64 KiB cap; native tool first (`pbcopy`, `wl-copy`, `xclip -selection clipboard`, `xsel --clipboard --input`; 2 s timeout), else OSC 52 **write** only behind `--osc52`/`ui.osc52` with the tmux DCS wrapper (doubled ESC); never OSC 52 read; `/copy draft` is the only unredacted source and reports `copied with 1 secret masked`.

### 10.6 Trace and logs (A12, A168)

`App.tsx:125–127` becomes `log.trace('key kind=<return|backspace|ctrl|escape|arrow|text|paste|filtered> len=<n> masked=<bool>')` unconditionally (never `input`; 13 §4.1 measured a 108-char key reconstructed from today's line); `usePaste` logs `paste len=<n>`; the wizard field logs `key masked len=1`. `JEVCODE_TRACE=<file>` is an alias for `JEVCODE_LOG=<file>` at level `trace`; the engine's `trace()` (`engine.ts:1570`) is routed to the same log.

### 10.7 Cleared drafts, index text, notes (new rules; judge-safety E6, E13)

A draft cleared by Ctrl-C/Esc Esc/the secret gate's Ctrl-C is written to `history.jsonl` only after `detectSecrets`: hit spans → `[REDACTED:draft]` (all families, warn-only included); `task60`/`title60`/`text60` on the index pass `redact` then clip; the `d` note passes the gate before `resolveDetailed`.

## 11. Onboarding, credentials, trust, `AGENTS.md` (A113–A128, F10)

### 11.1 Detection and state machine (`src/tui/onboarding/reducer.ts`, pure; key bytes in a `useRef<string>`)

```
firstFrame → resolveConfig → missingSecrets(mode) ─[]─▶ trust? ─▶ sandbox line ─▶ composer | argv task
                                  └[…]─▶ provider (3 rows; 1 anthropic · 2 openrouter; skipped when the generator key resolves or mode = jev-only; preselected from --provider/JEVCODE_PROVIDER)
                                          ▶ generatorKey (masked, 3 rows; Enter needs ≥ 8 chars; prefix hints sk-ant-/sk-or-v1- warn only)
                                          ▶ jevKey (masked; provider = openrouter and a key was just entered → "Enter = reuse it for Jev"; skipped when JEV_API_KEY/OPENROUTER_API_KEY resolve)
                                          ▶ save (addSecret FIRST → items `[setup] generator key: entered (sha256:e31150e9) source=wizard`, `[setup] saved ~/.config/jevcode/config.json (mode 0600, dir 0700)` → clear the ref → resolveConfig again)
                                          ▶ verify? (2 rows; explicit y only: GET openrouter.ai/api/v1/key $0 · GET api.anthropic.com/v1/models $0 · one Jev decision ~$0.0001 with the configured decider.model; 5 s AbortSignal.timeout chained to Ctrl-C; a rejected key returns to its field; n/Enter skips)
                                          ▶ trust (4 rows; 2 below rows 12) ▶ sandbox (one item, bold on the first run) ▶ composer
```

Reducer state holds `{ step, field: 'generator.apiKey' | 'decider.apiKey' | null, length }` only. Field rules (A114–A115): a multi-character `useInput` chunk is a paste; `sanitize` = `sanitizeStream` + strip all whitespace + NFC; a paste never submits, Enter does; Backspace/Delete drop one code point; Ctrl-U clears; Esc clears or steps back; **Ctrl-C prints the fix block (after unmount) and exits 2 only when no run exists; during `/login` mid-run it closes the wizard** (judge-safety E5). Mask = `'•'.repeat(min(len, columns − 3))` (`*` in ASCII) + `useCursor`; no `useFocus`. Non-TTY / `--plain` pipe / `CI` / `--no-input`: today's `ConfigError` line then the four-line fix block (`export ANTHROPIC_API_KEY=…`, `export JEV_API_KEY=…`, `printenv OPENROUTER_API_KEY | jevcode login --jev-key-stdin`, `jevcode login`) and `Keys are never accepted as command-line arguments in the interactive flow`, exit 2.

### 11.2 Persistence, shadowing, CLI twins (A117, A120, A125)

Write `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` (or `--config`/`JEVCODE_CONFIG`): read + merge (`provider`, `apiKey?`, `jevApiKey?` only), `writeFileAtomic(…, { mode: 0o600, mkdir: true })`, then `chmod` file 0600 / dir 0700; `resolve.ts:208` gains the XDG candidate before the legacy `~/.config/jevcode/config.json`, both checked, XDG preferred, one warning when both exist (P30); `./jevcode.json` present → warn that it wins for non-secret keys; never `./.env`, `./jevcode.json` or the extra `.env` file (A118); Windows prints `(Windows: protected by your user profile ACL)` instead of chmod (P41). Shadowing line at every start when env/dotenv holds a different fingerprint than the file: `[config] generator.apiKey: env ANTHROPIC_API_KEY (sha256:…) overrides file … (sha256:…) — unset the variable to use the saved key` (an item in every renderer, P43); `set but empty — treated as unset`. `jevcode login [--provider …] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]` (raw-mode masked byte loop on a TTY; one line per `*-stdin` flag on a pipe), `jevcode logout [--generator] [--jev]`, `jevcode config set <setting> <value>` (secret names refused: `secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument`). In-session `/login` re-enters the wizard at the missing field (the overlay takes rows from the pane first); on `saved` → `addSecret` immediately, toast `saved — applies to the next run (this run keeps its key)`; `/logout` rewrites atomically and reports env-sourced keys without touching them. A composer never accepts a credential: a key pasted into the composer is text under §10's gate (C43). The written file is read-denied to sandboxed commands wherever it lands: `cli/session.ts` passes `EngineOptions.configDirs = [xdgJevcodeDir(env), legacyJevcodeDir(home)]` → `SandboxCreateOptions.configDirs` → `ProfileOptions.configDirs` (§12.7), because today's `HOME_SECRET_SUBPATHS` covers `~/.config/jevcode` only (`seatbelt.ts:42`) and an `XDG_CONFIG_HOME` outside `~/.config` would leave the fresh key readable.

### 11.3 Trust gate and instruction files (A59, A122, D6)

`~/.jevcode/trust.json` (0600, inside the seatbelt-protected tree; P39): `{ "<realpath git root | workspace>": { "decision": "trust" | "session" | "none", "at": iso, "agents": { "path", "sha256" } | null } }`. Shown on the first interactive run per root when any untrusted input exists (`AGENTS.md`/`CLAUDE.md`, `./.env`, `./jevcode.json`), listing sizes and secret-looking counts, never values (F-O); options `1 trust · 2 this session only · 3 don't trust`; `3` → `run.json.instructions = []`, `./.env` still read for keys with the `dotenv: ./.env` source line in the item stream (P38), `jevcode.json` still read; a changed `AGENTS.md` sha256 re-prompts with `AGENTS.md changed since you trusted it (sha256 1a2b… → 9f8e…)`; `$HOME` as workspace never persisted; non-interactive: instruction files skipped with one stderr line unless `--trust-workspace`/`JEVCODE_TRUST_WORKSPACE=1`; `/trust` reopens. `AGENTS.md` (`src/config/instructions.ts` `loadInstructions(workspaceRoot, gitRoot, home)`): first match walking up from the workspace to the workspace root (never above it), `CLAUDE.md` fallback name, then `${XDG_CONFIG_HOME:-~/.config}/jevcode/AGENTS.md`; 32 KiB cap per file (truncated with a notice); read once per run after the first frame; `redact`ed; recorded as `run.json.instructions[]`; injected into `buildSystemPrompt` as `## Project instructions (from <path>, sha256 <8>)` **only** (never Jev state); every action still goes through the risk stage.

## 12. Git state, undo, rewind, diff (A140–A152, F11)

### 12.1 `GitState` at run start (A140; `src/workspace/gitstate.ts` `probeGitState`, `src/workspace/git.ts` `statusPorcelainV2`)

`probeGitState(root, { timeoutMs: 2000 })` (`src/workspace/gitstate.ts`) runs **two unsandboxed** spawns through `child_process.execFile('git', …, { cwd: root, env: GIT_ENV })` — (a) `git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel` and (b) `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all -z` (ten line kinds, `(initial)`, `(detached)`, `S…` submodules, NUL-separated renames; `sub`/`xy`/`hH`/`hI` kept per entry); never `rev-parse --abbrev-ref HEAD` — and is called by `createEngine` **before the sandbox exists**, which resolves the cycle the reviewers found (the seatbelt profile needs `gitDir`/`gitCommonDir`, while the old probe ran through that very sandbox inside `createWorkspace`, `files.ts:100–125`). Order inside `createEngine` (`engine.ts:1603–1632`, both branches): `createRunDir`/`validateResumeId` → `git = await probeGitState(root)` → `createSandbox({ …, gitDir: git.gitDir, gitCommonDir: git.commonDir, configDirs })` → `createWorkspace(root, runDir, { sandbox, secretPaths, redact, gitState: git })` — given a `gitState` it performs **zero** spawns: `isRepo`/`showPrefix`/`gitDir`/`statusPorcelain` are replaced by the probe's `repo`/`prefix`/`gitDir`/`dirty.entries` — → fresh: `store.create(meta)` with `meta.git = toRunGitMeta(git)`; resume: `store.updateMeta({ git: { …current, resumedOn: git.head } })` and the HEAD-drift warning (P52). A read-only `rev-parse` and a `--no-optional-locks status` need no sandbox: the sandbox confines generator-proposed commands, not harness probes, and neither writes the index. Unit test: a spawn counter at run start reads exactly 2 (A140 kept; `EngineOptions.git/gitDir/gitCommonDir` do not exist — everything is derived inside). `Workspace.gitState()` returns that `GitState`; `RunMeta.git` = the bounded `RunGitMeta` (no paths, **with `head.oid`** for the undo rule of §12.4); the `run:end` re-probe (P51, off-loop, unsandboxed) is persisted as `RunMeta.git.end` through `updateMeta({ git })`, whose patch type gains `'git'` (§15 item 10).

### 12.2 Banner and status zone (A141, A142)

`EngineEvent { type: 'workspace'; git; instructions; sandbox }` emitted right after `run:ready` (the bus buffers until `attach`, so the first-frame gate is untouched) → one item, level `info` (`warn` only for unmerged): `[run] git main ↑2 · 3 modified · 1 staged · 1 untracked` / `git detached 7d731c0e · clean` / `git wtbranch (linked worktree of /Users/me/proj) · clean` / `git main (unborn, no commits yet) · 2 untracked` / `git main · in subdirectory pkg/api/ of the repository` / `git none · not a git repository: changes made by commands are not recoverable, /diff compares against step pre-images only` / `git none · git not found on PATH: /undo and /diff use step pre-images only` / `git main · 412 modified · working tree has unmerged paths (u) — commands may fail on conflict markers`; ASCII `^2 v1`; never a gate, question or commit (R36). Zone (`src/tui/useGitHead.ts`): `fs.watch(gitDir, { persistent: false })` filtered on `!filename || filename === 'HEAD'`, 100 ms debounce, then read `<gitDir>/HEAD` (+ ref file / `packed-refs`) in-process (0.0–0.1 ms); dirty counts from the run-start snapshot and the `invalidateCandidates()` refresh after each `run` outcome (the controller reads `workspace.gitState()` after `outcome` events of kind `run`; zero spawns on the loop); one re-probe (15 ms, off-loop) at `run:end` for ahead/behind (P51); render `⎇ main ↑2 · 3~ 1?` / `⎇ 7d731c0e†` / `⎇ main (wt)` / ASCII `br main`; branch truncated by grapheme keeping the tail after the last `/`; ≤ 24 cells at ≥ 100 columns, hidden below 100 (F16); watcher error → frozen value. `--resume` on a different `head` warns: `[run] warning: HEAD was 7d731c0e at run start, now 91ab3c4d — the plan may not apply`.

### 12.3 Pre/post images (A143, A144, Q33; `src/checkpoint/images.ts`)

```
pre/<step>/<sha256(relpath)>   bytes before the step (edit|write|patch targets; the dirty set before `run`); files > 1 MiB skipped and recorded
pre/<step>/dirs.json           ["src/new/"] directories the step created (for unlink of created files)
post/<step>.json
{ "v": 1, "step": 7, "at": iso, "headOid": "7d731c0e…" | null,
  "files": { "src/a.py":  { "sha256": "…", "bytes": 812, "mode": 420, "source": "edit", "preImage": true,  "cleanAtStart": true },
             "build/out.txt": { "sha256": "…", "bytes": 91,  "source": "run",  "preImage": false, "cleanAtStart": false },
             "src/new.py": { "sha256": "…", "bytes": 40, "source": "write", "created": true },
             "old.txt": { "deleted": true, "preImage": true } },
  "skipped": [ { "path": "big.bin", "reason": "size", "bytes": 3145728 }, { "path": "…", "reason": "cap" } ], "hashSkipped": false }
```

Engine insertion: in `runStep()` right before `runExecuteStage` (`engine.ts:1054`): for `edit|write|patch` → `writePreImages(runDir, step, targets)` from `draft.patchTargets`/`action.path`; for `run` → copy `snapshotDirty ∪ statusEntries ∪ touched` (`workspace.dirtySet()`, in memory, no spawn), cap 200 files / 16 MiB, overflow `reason: 'cap'`; clean tracked files need no copy (recoverable from HEAD). After execute (`engine.ts:1062`, still inside `runStep()` so `harnessMs` — computed in `commit()` from `total − generatorMs − jevMs − execMs − confirmMs`, `engine.ts:1354–1362` — sees it): `await writePostImages(runDir, step, changedFiles, { cleanAtStart, headOid })` hashes each changed file by **streaming** `createReadStream(abs, { highWaterMark: 4 MiB })` into `createHash('sha256')` with a `setImmediate` yield between chunks — `node:crypto` costs 0.6 ms/MiB on the main thread (A143), so one 4 MiB chunk is ≈ 2.4 ms and the event loop never blocks longer while the composer is live (§18 lag gate p95 < 5 ms, max < 50 ms); **per-step hashing cap 16 MiB** (≈ 10 ms of hashing) → `hashSkipped: true` and each remaining file recorded with `sha256: null` (`/undo` treats it as the "ask" row); `StepTiming.imagesMs` (§15 item 3) records pre- plus post-image time, is part of `harnessMs`, and `perf/step-overhead.ts` gates `harnessMs` p95 < 50 ms **and** reports `imagesMs` p95 (< 15 ms). Nothing is hashed inside the overlapped checkpoint IIFE (`engine.ts:1441–1450`), where the gate could not see it. Non-git: only `touched` paths.

### 12.4 `/undo [n]` decision table (A145, A146; `src/undo/plan.ts` pure + `apply.ts`; idle-only, composer idle, all checks before the first write)

| Current file vs `post[N].files[p]` | Decision |
| --- | --- |
| sha256 equal | restore |
| missing and `deleted: true` | restore |
| differs and some later step M > N has `post[M].files[p].sha256 === current` | **refuse**: `src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together` |
| differs otherwise | **ask**, default `n` (one-row `undo` overlay): `src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort`; Enter = `n` |
| symlink / hard link (`lstat`, `nlink > 1`) | skip `link` |
| resolves outside `<ws>` or into `.git` | skip `escape` |
| submodule (`sub[0] === 'S'`) | skip `submodule` |
| `source === 'run'`, `cleanAtStart`, tracked, and `HEAD oid !== post[N].headOid` | skip `not recoverable — HEAD moved since step 7` (new rule, judge-safety E10) |

Restore source order: pre-image (`writeFileAtomic(abs, bytes, { mode })`) → `created` and no pre-image → `unlink` + remove recorded empty dirs → `source === 'run'` and `cleanAtStart` and tracked and HEAD unchanged → `git restore --source=HEAD --worktree -- <path>` through `runGit` with the neutralising flags (never `checkout --`, `--staged`, `stash`, `reset`, `checkout <branch>`, `clean`; nothing touches the index or refs; C40) → skip `not recoverable — changed by a command, not tracked by git`. Output item `[ui] undo step 7: restored 3 files (src/a.py, src/b.py, tests/test_a.py), skipped 1 (build/out.txt: not recoverable — changed by a command, not tracked by git)` / `[ui] no files restored (…)`; `post/7.json` → `post/7.undone.json`; index `undo` line; the next run's seed gets `humanNotes: ['human reverted step 7: src/a.py, src/b.py, tests/test_a.py']` and `undoLog` (carried in the **next** run's `CheckpointState`; the finished run's `state.json` is never rewritten — sessions graft, R21). **`/resume` of the undone run itself** (allowed after `human_pause` and budget stops): the controller passes the same note as `EngineOptions.humanDirective` — consumed at the first step start exactly like a steer, so the restored plan/window's claim that step N's files are changed is contradicted in the prompt hint, `state.human` and `SynthesisContext.directive` — and `EngineOptions.undoLog` (merged into the restored `undoLog`); the finished `state.json` still is not rewritten. No `/redo` (P54), no "restore to HEAD" option (P50: that is `git restore` in the user's shell). Non-git: rules 1–2 only, reason `not recoverable — no git repository`.

### 12.5 `/rewind [step]`

A picker of committed steps with `changedFiles` (from the reducer's `step:end` records of the last run; no `steps.jsonl` read) in the pane slot; Enter → undo steps `last…n` in reverse, stopping at the first refusal; then a one-row choice `files (done) · [p] plan+window · [b] both · Esc keep` → `plan+window` sets the next seed to `planAfter` of step n (or the parent's final plan when `planAfter` is absent, with a notice) and the window to entries `≤ n` (§8.3). Esc Esc on an empty idle composer opens the same picker (F5).

### 12.6 `/diff` (A147, A148, A151; `src/undo/diff.ts`)

`/diff` = one `[ui]` item: header `diff (run <id> · 12 files · +184 −37 · 2 untracked · 1 binary · 1 skipped)` then rows ` M src/a.py            +120 −12  ++++++++--` with letters `M/A/D/R/?/B/S`, `+n −m`, a ≤ 10-cell `+`/`-` bar scaled to the largest row, `†` for paths dirty before the run (legend `† also modified before this run`), one row per submodule (`--ignore-submodules=dirty`), unborn repos against the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, row cap 40 (`--all` lifts), path left-truncated by grapheme to `columns − 32`, colour additive only (signs carry the meaning). Data: `git diff --numstat -z HEAD -- <changedFiles>` (one sandbox spawn, ~35 ms, awaited off the loop) plus `git diff --no-index --numstat -z -- /dev/null <f>` per untracked file (first 20; the rest listed `?` with sizes); **exit 1 from `--no-index`/`--exit-code` is success** (A151). Allowed while live (the spawn is asynchronous and the parse is µs); `/diff <step>` = pre → post from the images with `(changed since)` rows; `/diff --full [step]` (idle-only) = unified text (`--color=always -c core.quotePath=false --no-ext-diff --no-textconv --submodule=short --ignore-submodules=dirty`, files > 1 MiB excluded) written to `<run>/tmp/diff-<seq>.patch` and shown via `useApp().suspendTerminal(spawn('/bin/sh', ['-c', pager + ' "$0"', file]))` with `$GIT_PAGER` → `$PAGER` → `less` (`core.pager` never consulted), `LESS=FRX` only when unset, `LESSCHARSET=utf-8`; `cat`/no TTY → inline block capped at 400 lines; engine events queued during the suspension and flushed after `resume()`. Human-only (P53). Non-git: per-file `--no-index` with `--- a/<rel>` / `+++ b/<rel>` header rewrite when `git` exists, else an in-process LCS line count for files ≤ 1 MiB with `git not found: showing before/after sizes only`.

### 12.7 Seatbelt (A149)

`ProfileOptions.gitDir?`/`gitCommonDir?` (`seatbelt.ts:18`) and `SandboxCreateOptions.gitDir?`/`gitCommonDir?` allow `file-write*` under the realpath'd `<gitDir>` and `<commonDir>` when they lie outside `<ws>` (linked worktrees, subdirectory workspaces); the denies (`seatbelt.ts:64`) move to `(literal <commonDir>/config) (subpath <commonDir>/hooks) (literal <gitDir>/config.worktree)` plus regexes for `<commonDir>/modules/*/config` and `modules/*/hooks`; README "in-workspace writes succeed" → "and the repository's `.git` directory". `ProfileOptions.configDirs?`/`SandboxCreateOptions.configDirs?` add the resolved `${XDG_CONFIG_HOME:-~/.config}/jevcode` and legacy `~/.config/jevcode` directories to the `file-read*` denies (with `XDG_CONFIG_HOME=/tmp/x` the wizard's key file would otherwise be readable by commands unless it happened to be in `secretPaths`). `src/sandbox/run.ts` (`createSandbox`, `:184–195`, owned by O5) forwards `gitDir`/`gitCommonDir`/`configDirs` to `buildProfile` and includes them in the profile-path hash (`:183`). Unit tests: the profile contains `(literal <commonDir>/config)` when `gitCommonDir` lies outside the workspace, and `(subpath /tmp/x/jevcode)` under `XDG_CONFIG_HOME=/tmp/x`. Profile snapshots byte-for-byte for the main tree stay unchanged when no option is passed.

## 13. Errors, retry, crash, logs, epilogue, exit codes (A160–A171, F12)

### 13.1 Severity → surface (17 §4.1)

| severity | status-zone word | toast | `<Static>` item | live region | blocking overlay | log |
| --- | --- | --- | --- | --- | --- | --- |
| info | — | — | dim item | — | — | info |
| notice (self-healing) | `retrying 2/3`, `offline`, `reconnecting` | 2 s `✓ jev back` / `✓ network back` on heal | only when the chain failed or lasted > 10 s | retry row §13.2 | — | info/warn |
| warning | `!n` until Ctrl+O / `/errors` (P65) | 2 s `! <short>` | yellow `warning: …` | — | — | warn |
| error (`fatal: false`) | `!n` | 4 s `! <code>: <short>` | red `error <code>: …` + `request-id` | — | — | error |
| blocking | `paused: <reason>` | — | red on entry, dim on resolve | — | ≤ 4 rows in the overlay slot | error |
| fatal | `done error` | — | `[run] end error …` | cleared | — | error + epilogue |

### 13.2 Retry events, row and pacing (A160, A165, P60, P61)

`AskOptions.onRetry`/`GenerateOptions.onRetry` are called at `client.ts:351–353` (before `await sleep(waitMs, opts.signal)`) and `sse.ts:300–302` (before `deps.sleep(delay, signal)`) with `RetryInfo`; the engine forwards them as `retry` / `retry:settled` events (settled in `finally`). Row (live row 1, 1 Hz tick owned by `useEngine`'s retry hook, cleared in the same action as `retry:settled`): `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now`; row 2 `last: HTTP 529 overloaded · request-id req_…` only when the cause changed; the spinner keeps 8 fps only while `reducedMotion` is off; `Retry-After` shown as capped at 60 s. `[r]` → `engine.retryNow()` → aborts the engine-owned `retryWaker` `AbortController`, which `sleep(ms, signal?, wake?)` (`time.ts:44`) treats as "resolve now" (`client.ts:199` and `sse.ts:312` already inject `deps.sleep`). **Waker lifecycle** (an `AbortController` aborts once, so one per sleep): the engine's `onRetry` handler — called at `client.ts:351` / `sse.ts:300` before each sleep — does `this.retryWaker = new AbortController()` and emits `retry`; the clients fetch the signal per attempt through the getter `AskOptions.wake?.()` / `GenerateOptions.wake?.()` (`await sleep(waitMs, opts.signal, opts.wake?.())`), so every sleep sees a fresh controller; `retryNow()` aborts the current one and nulls it (creating the next is `onRetry`'s job, so `[r]` stays alive for the whole chain and never turns it into a tight loop); `retry:settled` (in `finally`) nulls it too. Unit test: two `[r]` presses in one 3-attempt chain each shorten exactly one sleep. Esc during a retry = pause at the next boundary. **Session mode only:** after one exhausted chain with zero actions executed in the step, discard the step (rule 1) and enter `paused: jev unreachable` — blocking overlay `jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min) · [r] now  [q] stop`, mechanism §13.3 (`blocking:request { kind: 'jev-unreachable', retryInMs }` awaited through `EngineOptions.blocker` and raced against the auto-retry timer); bench and `--plain` on a pipe have no blocker and keep three failures → exit 5 (A165, P61). Network `cause.code` → status word `offline` and copy `offline: DNS lookup failed for <host>` (`ENOTFOUND|EAI_AGAIN`), `offline: cannot reach <host>` (`ENETUNREACH|EHOSTUNREACH|ECONNREFUSED`), `no response from <host> in 10 s` (`ETIMEDOUT`/`TimeoutError`); host only, never the URL; never a probe. Failed attempts are **not** persisted in `jev.jsonl` (P64).

### 13.3 Blocking panes (A163, A164, A166, A167)

**Mechanism (one for every blocking pause).** `EngineOptions.blocker?: (req: BlockingRequest) => Promise<BlockingAnswer>` (§15 item 11) is awaited by `main()` at the loop top (`this.blocked` is set by the failing stage after the rule-1 discard; `engine.ts:559–570`: nothing is in flight and the last commit is whole): the engine emits `blocking:request { request }`, awaits `Promise.race([blocker(req), autoRetry])` — `autoRetry` exists only for `kind: 'jev-unreachable'` (`sleep(req.retryInMs, signal, wake)` → `'retry'`; `retryInMs` 30 s doubling to 5 min across consecutive pauses) — emits `blocking:resolved { id, answer }`, then acts: `retry` → next loop iteration; `continue` (`checkpoint-degraded` only) → `checkpointDegraded = true`; `login`/`pin` → the controller opens `/login` or records the pin, then answers `retry` or `stop`; `stop` → `finish(req.stop)` with `req.exitCode`. **No blocker** (`--plain` pipe, `--no-input`, `--json`, bench) → the answer is `'stop'` at once and `jev-unreachable` keeps today's three failures → exit 5 (A165). The blocker never creates a new engine: `resumes` does not grow, `pendingDirectives`/`activeHuman` are untouched, and the rows render in the overlay slot from `blockingLines(req, rows, columns)` (§19.4 covers `retry`/`continue`/`stop` and the no-blocker default).

First-call 401/403 on either side → `run:end error` with exit 2 (`ConfigError` semantics) and, in session mode, the pane of F-U: `jev: key rejected (HTTP 401 — "User not found.")` / `Set the decider key and retry. Consulted: <SettingReader.sources()>` / `The key is never printed or logged.` / `[r] retry with the current key   [l] /login   [q] stop (exit 2)`; a later 401 (key revoked mid-run) → blocking pause, not three failed steps; the provider message clipped to 120 chars. Spend-cap 429 (Anthropic `enforced_spend_limit_reached`) / OpenRouter 402 → `provider: spend limit reached — "<message>" · this keeps failing until access resumes · [q] stop (exit 5)`, no auto-retry. First-call Jev alias drift → exit 2 with `[p] pin --jev-model <served> for the next run  [q] stop`; later drift → warning item + 4 s toast + `/jev` shows `configured / resolved / drift@step`. `seatbelt` explicitly requested but unavailable → blocking in session mode (exit 6 one-shot). Disk errors on the run dir (`ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE`) classified by `e.code` in `persist()` (`engine.ts:600–612`) and the commit checkpoint (`:1443–1451`) → `notice checkpoint:degraded` **once per (file, code)**, status word `disk ×N`, pause at the boundary with `checkpoint degraded: ENOSPC on state.json` / `state.json could not be written since step 1 — the run cannot be resumed from here.` / `[r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)`; `[r]` success → `checkpoint:restored` + toast; `[c]` sets `checkpointDegraded` so a later `complete` exits **3** and the epilogue says `state.json missing — not resumable`; `EACCES` on `~/.jevcode` at launch names the path and the fix; never `process.exit` from the disk path. `run:ready.sandbox/noNetwork` feed the `sandbox: seatbelt` (dim) / `sandbox: none` (yellow + one `warning:` item when `auto` degraded) / `no-net` badge and the `[sandbox] …` item (A123); a `run` failing with a network-looking error under `--no-network` appends `(sandbox network denied by --no-network)`.

### 13.4 `PaneBoundary` and `fatalExit` (A161, A162)

`class PaneBoundary extends React.Component<{ pane: string; onFail?: () => void }, { failed: Error | null }>` wraps `live`, `Pane`, `Overlay`, `Composer`, `StatusLine` and the `<Static>` child renderer separately; fallback one row `ui: <pane> pane failed to render (<Error.name>) — run continues; details in <log>`; `componentDidCatch` logs the redacted stack + `componentStack` to `jevcode.log` and dispatches a renderer-local error item; a failed `Overlay` holding a review **declines** it via `confirmer.resolveDetailed(id, { approved: false })`; a failed `StatusLine` renders `statusLineText()` in a bare `<Text>`; **a failed `Composer` falls back to a single-row plain input so keys still work** (minimal-robust graft); Ink's `InternalErrorBoundary` must never fire (it prints 42 rows and clears screen and scrollback); `JEVCODE_FAULT=render:<pane>` throws once. `fatalExit(e)` (`cli/fatal.ts`, replaces `main.tsx:288–293`): (1) `process.exitCode = err.exitCode`, idempotent guard; (2) synchronous terminal restore **before anything is printed** — `stdin.setRawMode(false)`, `fs.writeSync(1, RESTORE)` (§14.2), never `ESC c`/`ESC[2J`; (3) `engine?.abort('error', { error: serializeError(e, redact) })` (§15 item 15: the `'error'` branch stores `fatalError`, so `finish('error')` carries it and `exitCodeFor` returns its code) so the `'exit'` handler writes `state.json` synchronously, then `renderer.unmount()` raced with `UNMOUNT_TIMEOUT_MS`; (4) the epilogue via `fs.writeSync(2, epilogueLines(serializeError(e, redact), ctx, redact).join('\n'))` — `<msg>` and the `JEVCODE_DEBUG=1` stack pass `config.redact` when a config exists and `patternRedact` otherwise (DESIGN §11's single redacting `fatal()`; today's `main.tsx:289` prints `err.message` raw; unit test with a canary in the thrown message), then `process.exit(process.exitCode)`. `stdin/stdout/stderr` `'error'` listeners (EIO/EPIPE) are installed before any SIGHUP logic. **Hang-up rule, gated on `stdin.isTTY && stdin.isRaw` (Ink mounted):** stdin `'end'` or SIGHUP → `engine.abort('signal', { signal: 'SIGHUP' })` → checkpoint, no terminal writes, no epilogue, exit 129 (A81; 07 §3.4 measured the `end`-then-SIGHUP sequence only under raw mode on a pty). On a pipe stdin `'end'` is the normal completion of `readTask()` (`main.tsx:34–38`) or arrives at once with `--json </dev/null` and means nothing; the hang-up signals there are SIGHUP and EIO/EPIPE on stdout/stderr. In `--plain` on a TTY (cooked mode) EOF is readline `'close'` and takes F5's Ctrl-D meaning: idle → exit 0; live → `engine.abort('human_abort')` then exit 0 after `run:end` (a second press cannot follow an EOF, so the two-press hint is a raw-mode rule — §22). `installTerminalHygiene()` also registers `process.on('exit', restoreTerminal)` (idempotent: `fs.writeSync(1, RESTORE)` + `setRawMode(false)`), and `cli/session.ts`/`commandRun` pass `EngineOptions.exit = (code) => { restoreTerminal(); fs.writeSync(2, epilogue); process.exit(code) }`, so the engine's two own `process.exit` paths — the second Ctrl-C (`forceExit`, `engine.ts:512–521`) and the 5 s `SHUTDOWN_CHECKPOINT_BOUND_MS` timeout in `finish()` (`:1505–1511`) — reset DECSCUSR, raw mode and 2004 before exiting, in session mode too (that timeout ends the session process with the run's exit code; its epilogue is written by the hook, not dropped).

### 13.5 Epilogue and exit codes (A62, 17 §4.9)

Epilogue on every `run:end` and fatal path (stderr after unmount in one-shot mode; a `[ui]` item in session mode, printed to stderr only when the process exits), built by `epilogueLines(err, ctx, redact)` — `<msg>` always passes `redact`:

```
jevcode: stopped — jev_http: Jev HTTP 429: Rate limit exceeded (exit 5)
  run       20260920-191506-5gnampki
  files     ~/.jevcode/runs/20260920-191506-5gnampki/  (transcript.log, state.json, jevcode.log)
  resume    jevcode run --resume 20260920-191506-5gnampki        | state.json missing — not resumable
  report    jevcode report 20260920-191506-5gnampki   (redacted bundle written locally; nothing is sent)
```

| situation | one-shot | session (`run:end` item carries the code) |
| --- | --- | --- |
| complete / `generator_done` | 0 | item `exit 0`; process continues |
| budget (`max_steps`, `wall_time`, `spend_cap`, `max_replans`, `token_cap`), `replan_stop`, `impossible`, `human_pause` | 4 | item `exit 4`; composer reopens |
| ConfigError / usage at launch; unpriced refusal | 2 | 2 (process exits) |
| first-call 401/403, first-call drift | **2** (today 5) | pane `[q]` → item `exit 2` |
| API failure after retries; spend-limit `[q]` | 5 | item `exit 5` |
| checkpoint degraded and stopped (incl. `complete`); `--resume` unusable | **3** (today 0) | item `exit 3` + not-resumable notice |
| sandbox / path abort | 6 | item `exit 6` |
| Ctrl-C ×2 while a run is live / external SIGINT (`abort('signal', { signal: 'SIGINT' })`) | 130 | 130 for an external SIGINT (the process exits, the composer does not reopen); a TUI Ctrl-C ×2 while live is `human_abort` + stay |
| SIGTERM (`abort('signal', { signal: 'SIGTERM' })` → `AbortError.signalName` → `exitCodeFor(…, 'SIGTERM')`) | 143 | 143 (process exits) |
| SIGHUP / EIO (`signal: 'SIGHUP'`) | 129 | 129 |
| uncaught / render fault escalated | 1 | 1 |
| `/exit` (incl. `[y]` while live), Ctrl-D ×2 (incl. `[y]` while live), Ctrl-C ×2 idle | — | **0 always** — leaving is not a failure (17 §4.9); the aborted run's `run:end` item carries 130 (`--exit-code=last-run` opt-in) |

`exitCodeFor(reason, error?, degraded = false, signal?: SignalName)` in `loop/stop.ts` returns 3 when `degraded && reason !== 'error'`, 143 for `signal === 'SIGTERM'`, 129 for `'SIGHUP'`, 130 for `'signal'` otherwise, and is the one function `main.tsx` and the engine use (the private copy at `main.tsx:15–29` is deleted; the no-op ternary `forceExit(reason === 'signal' ? 130 : 130)` at `engine.ts:494` becomes `forceExit(exitCodeFor('signal', undefined, false, this.signalName))`; `run:end.exitCode` uses the same call).

### 13.6 Logs and `jevcode report` (A168, A169)

`<runDir>/jevcode.log` (`JEVCODE_LOG` override; pre-run and session-level events and the fallback when the run dir is unwritable go to `~/.jevcode/logs/jevcode-<pid>-<stamp>.log`, newest 10 kept, P63); levels `error|warn|info|debug|trace`, default `info`; `--verbose` / `JEVCODE_LOG_LEVEL=debug` adds decisions, request hashes, latencies and checkpoint timings **to the file only** (the in-frame twin is Ctrl+O / `/errors`); key=value lines ≤ 512 chars wrapped by `config.redact`; keystrokes as categories only; `warn`+ via `appendFileSync`, `info`− through a 250 ms buffer flushed synchronously in the `'exit'` handler; 8 MiB cap with one rotation; log-write failures swallowed; never stdout/stderr while Ink is mounted (`patchConsole: false` kept; `console.*` routed to the log). `jevcode report <id>` / `/report` writes `~/.jevcode/reports/<id>/` with `run.json`, `transcript.log`, `jevcode.log`, the last 20 `steps.jsonl` rows, `jevcode config --json`, `versions.txt` (node, jevcode, ink, `TERM`/`TERM_PROGRAM`, rows×cols), `README.txt` with the issues URL; everything through `redact`; `jev.jsonl` bodies only with `--include-requests`; nothing is sent.

## 14. Terminal posture and hygiene (A77–A97, F2, D13)

### 14.1 Posture table

| Item | v1 |
| --- | --- |
| Keyboard protocol | `kittyKeyboard: { mode: 'disabled' }`; universal newline keys (§3.2); xterm `CSI 27;m;13~` swallowed as newline; no tmux `CSI > 4 ; 2 m` (deferred with the handshake, §22) |
| Queries | none, before or after the first frame (no `CSI ? u`, DA1, `CSI ? 2026 $ p`, OSC 11, XTVERSION); tmux's 500 ms Esc floor is never triggered by JevCode (A112) |
| Rendering | `render({ stdout, stdin, exitOnCtrlC: false, patchConsole: false, maxFps: launch.fps, incrementalRendering: launch.renderMode === 'incremental', kittyKeyboard: { mode: 'disabled' }, isScreenReaderEnabled: launch.screenReader })` where `launch = resolveLaunchSettings(flags, process.env)` (§16: flag > env > default, pure, **no file** — Ink computes `renderThrottleMs` once in its constructor, `ink.js:193–199`, and a second `render()` on the same stdout is unsupported, so these three can never follow a value read after the first frame); `maxFps` 30 default, `--fps`/`JEVCODE_FPS`, 15 under `SSH_TTY`/`SSH_CONNECTION`; the stream scheduler's cadence `launch.fps` / 67 ms SSH / 250 ms reduced motion, leading edge first (§7; it replaced `LIVE_FLUSH_MS` 50); `<Static>` soft cap 20,000 items → keyed remount with a fresh small array (A28, C27); bucketed live counters (`streaming… 1.2k chars`); `useWindowSize()` replaces `useTerminalSize` (`App.tsx:90–103`) |
| Colour | `bin/jevcode.js` maps `NO_COLOR` → `FORCE_COLOR=0` (present) and a first-position side-effect import `src/tui/color-shim.ts` in `main.tsx` repeats it for tests (Q14); one `colorEnabled()` (flag > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > `hasColors?.(16)`); `--no-color`; ANSI-16 named colours; marker or word beside every colour; no backgrounds; `--theme dark\|light\|daltonized\|ansi` (daltonized swaps red↔blue for review/block; `ansi` = no dim); no auto-detect; 16 colours inside tmux |
| Cursor | real cursor via `useCursor`; DECSCUSR `CSI 6 SP q` once at mount, `CSI 0 SP q` in the exit string (A3) |
| Unicode | gate `TERM !== 'linux'` && UTF-8 locale (POSIX), allow-list (Windows); `--ascii`/`JEVCODE_ASCII=1`/auto on `TERM=dumb`; glyph table `─`→`-`, `›`→`>`, `✓ ✗`→`+ x`, `↑ ↓`→`^ v`, `⎇`→`br`, `†`→`+`, `•`→`*`, `·`→`-`, `┆`→`:`, `█▏▎▍▌▋▊▉`→`#` with `" 123456789#"`, spinner `\|/-\`, static spinner `•`→`*` (reduced motion, §14.2); ledger `[x] [ ] [?] [!]` already ASCII; never `⚠️` with VS16 |
| Mouse, alt screen, title, links | none; none; `--title` opt-in (`OSC 2 ; jevcode: <task head sanitised> ST`, cleared with `OSC 2 ; ST` on exit); OSC 8 deferred |
| Notifications | `--notify`/`ui.notify` default off (on in SR); BEL; OSC 9 (iTerm2/Ghostty/WezTerm/foot), OSC 99 (kitty), tmux DCS passthrough; payload a redacted one-liner never starting `<digit>;`; the review timer starts when the **deferred** box appears, restarts on keystrokes, fires at ~6 s; run-end timer starts at `run:end`, cancelled by any keystroke, fires at ~60 s; also at 95 % and `budget:stop` |
| Sizes | `useWindowSize()` only; 0×0 pty → Ink's 80×24; `MIN 40×8` notice; resize = 50 ms trailing debounce on the composer re-wrap only (Ink coalesces frames itself), budget recomputed from the same `rows` Ink uses, scrollback never rewritten (A30, C23); rule capped at `min(columns, 400)` |
| Slow links | fps 15, coalescer kept, no queries; mosh treated as unsupported for OSC 52/1004/kitty/2026 |
| IME | a multi-code-point chunk without ESC is text; grapheme cursor and deletion; no Alt inference from `å`-style text |
| Untrusted text | `sanitizeStream` is the single choke point (C0 minus `\t\n\r`, DEL, C1, bidi controls, U+2028/2029 → `\n`) for items, live region, pastes, clipboard (A88) |

### 14.2 Exit string, signals, Ctrl+Z, accessibility (A80, A81, A23, A94–A96)

`RESTORE = '\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m'` (+ `'\x1b[<u'` only if kitty is ever pushed; never `ESC c`/`ESC[2J`/`ESC[3J`), followed by `\r\n` when the cursor is mid-line, written once by an idempotent `restoreTerminal()` (`src/tui/terminal.ts`) from `fatalExit`, the SIGTSTP handler, SIGHUP, the `process.on('exit')` hook installed by `installTerminalHygiene()` and after `unmount()`; `stdin.setRawMode(false)` synchronously in that same `'exit'` hook, so even the engine's `forceExit` → `process.exit` (through the injected `EngineOptions.exit`, §13.4) leaves the shell with its cursor shape, cooked mode and 2004 off. SIGINT/SIGTERM listeners stay registered in session mode: while a run is live → `engine.abort('signal', { signal })`, and on that `run:end` the controller exits 130/143 without reopening the composer; while idle → unmount, restore, exit 130/143. In `--plain` on a TTY the readline composer runs `{ terminal: false }` (DESIGN §10: the tty stays in cooked mode and delivers SIGINT itself), so Ctrl-C **is** SIGINT and indistinguishable from an external kill — there SIGINT follows the F5 matrix instead (live → `abort('human_abort')`, stay; idle → `press Ctrl-C again to exit` on stderr, second within 1.5 s → exit 0), `'signal'` is reserved for SIGTERM, SIGHUP and non-TTY stdin, readline `'close'` (EOF) is the Ctrl-D rule of §13.4, and `/pause` is the only pause path (no Esc in cooked mode; a `--plain` pipe never pauses). **Ctrl+Z:** `process.on('SIGTSTP', suspend)` is installed at mount so an external `kill -TSTP` (or a cooked-mode Ctrl-Z after a SIGCONT termios race) restores the terminal too — installing the listener removes the default stop action, which is why the stop below is explicit; byte `0x1a` calls the same `suspend()`: `const s = await suspendTerminal()` (RESTORE written) → `process.once('SIGCONT', () => void s.resume())` → `process.kill(process.pid, 'SIGSTOP')` (uncatchable, so the process really stops: 07 §3.3, 12 §10.1 measured `T`); on `SIGCONT` also re-apply raw mode on the **next stdin chunk** (a job-control shell may restore cooked termios after CONT, 07 §3.3) and force one repaint; a self-sent SIGTSTP that does not stop the process (orphaned session leader, 12 §10.1) is detected by a 100 ms timer that simply resumes (minimal-robust; judge-safety E12). **SIGWINCH storms:** 30 events → one layout recompute after 50 ms. **Screen reader:** `--screen-reader` > `JEVCODE_SCREEN_READER` (`=0` overrides) > `ui.screenReader` (also `INK_SCREEN_READER`) → `isScreenReaderEnabled`; first item `[screen reader mode: on via flag|env|config]`; `aria-hidden` spinner and bars; status `aria-label` changes only on stage/threshold transitions; announcements as `<Static>` lines (`you:`/`steer:` prefixes on the human lines); live region off; reviews, wizard and pickers as numbered lists + `Enter selection (1-N):`; one BEL; roles `textbox`/`multiline`, `list`/`listitem`; `notify` defaults on; `--screen-reader` on a non-TTY implies `--plain`. **Reduced motion:** `--no-animation`/`JEVCODE_REDUCED_MOTION`/`ui.reducedMotion` (implied by SR): static `•`, a 1 Hz functional tick for the wall clock, `LIVE_FLUSH_MS` 250; a unit test greps `src/tui/**` for `setInterval(` outside `spinner.ts` and `retry.ts`. **Tiny terminals:** §2.1 `degraded`. **tmux/VS Code/Terminal.app:** 16 named colours inside tmux; `TERM_PROGRAM=vscode` without `TERM` → colour by `FORCE_COLOR` only; Terminal.app drops OSC 52 → native `pbcopy` first; never gate on a version string (A111).

## 15. Engine and core contract additions (F13; one ordered, additive, versioned list)

Header comment for `src/core/types.ts`: `// contract 1.1 (2026-09-20): additive TUI/session extensions per docs/TUI-DESIGN.md §15; every new field on an existing type is optional; CheckpointEnvelope.version stays 1.` Every item is a new union member, an optional field, a new type, or a new **required** method on `Engine` — the only interface the repo alone implements (`loop/engine.ts`; `loop/generator-only.ts:17–18` delegates to `createEngine`; the two fakes `test/unit/bench/helpers.ts:236` and `test/fixtures/tui/fixtures.ts:97` gain no-op methods in the same W0 PR); `Engine.abort`'s parameter is widened, which is source-compatible for every caller. There is no other exception: `GeneratorConfig.priced` is **optional** (item 17), so `test/unit/provider/helpers.ts:123–127` compiles unchanged. `tsc --strict` on today's consumers (`engine.ts:1126–1130`, `run-events.json`, `fixtures.ts`, `helpers.ts`, `test/unit/provider/**`) passes before any implementer starts.

**Assignment rule.** This repo compiles with `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true` (`tsconfig.json`), so **no optional property is ever assigned `undefined`**: every prescribed assignment below is a conditional spread — `...(parent ? { parentExceeded: parentExceeded(), parent: { totalUsd: p.totalUsd, capUsd: p.capUsd } } : {})`, `...(this.retryWaker ? { wake: () => this.retryWaker?.signal } : {})`, `...(r.note ? { note: r.note } : {})`, `...(draft.matchesIntent !== null ? { matchesIntent: draft.matchesIntent } : {})`, `{ sessionId: session?.sessionId ?? runId }` — the idiom already at `engine.ts:1628` and `run.ts:194`. W0 gate: `tsc -p tsconfig.json` passes on a branch that stubs every signature below. Anchors are `types.ts:<line>` at the symbol's declaration line as of HEAD (1,115 lines); a moved symbol is found by name.

```ts
// 1  StopReason (types.ts:219 `export type StopReason`) — two members; BenchStopReason (types.ts:983) widens automatically; stop.ts exitCodeFor default → 4;
//    storedStopBlocks (engine.ts:446) returns null for human_pause and, for token_cap, `this.generatorTokens >= lim.maxGeneratorTokens ? r : null` (isPlainStopBudget, engine.ts:294, gains 'token_cap')
export type StopReason = 'complete' | 'max_steps' | 'spend_cap' | 'wall_time' | 'max_replans' | 'human_abort' | 'signal'
  | 'replan_stop' | 'impossible' | 'generator_done' | 'error' | 'human_pause' | 'token_cap';
export type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP';      // AbortError.signalName (errors.ts:209); read by exitCodeFor(reason, error?, degraded?, signal?) → 130 / 143 / 129

// 2  HarnessProblemKind (types.ts:82) — planSection (prompts.ts:134) already renders `[human, step N]`; step 0 = seed / undo problem, step > 0 = steer (§8.6)
export type HarnessProblemKind = 'replan' | 'rejected_claim' | 'stale_plan' | 'human';

// 3  StepTiming (types.ts:291) and StepRecord (types.ts:302) — image time inside harnessMs; bounded snapshot for /rewind
export interface PlanSnapshot { done: PlanItemDone[]; remaining: string[]; unverified: PlanUnverified[]; harnessProblems: HarnessProblem[] }  // each list ≤ 20 × 200 chars
export interface StepTiming { /* …existing… */ imagesMs?: number }      // pre + post images (§12.3); already part of harnessMs, reported separately by perf/step-overhead.ts
export interface StepRecord { /* …existing… */ planAfter?: PlanSnapshot }

// 4  SerializedError (types.ts:337)
export interface SerializedError { name: string; code: string; message: string; exitCode: number;
  status?: number; retryable?: boolean; side?: 'jev' | 'generator'; requestId?: string | null }

// 5  Retry plumbing (GenerateOptions types.ts:410, AskOptions types.ts:427) — `wake` is a GETTER read before each sleep: one AbortController per sleep (§13.2)
export interface RetryCause { kind: 'http' | 'network' | 'timeout' | 'invalid' | 'stream'; status: number | null; code: string | null; message: string }  // message = redacted ≤ 200-char hint, never a body
export interface RetryInfo { attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: RetryCause }
export interface GenerateOptions { signal: AbortSignal; onDelta?: (text: string) => void; onToolDelta?: (fragment: string) => void;
  onRetry?: (info: RetryInfo) => void; wake?: () => AbortSignal | undefined }   // clients: `await sleep(waitMs, signal, opts.wake?.())`
export interface AskOptions { signal: AbortSignal; stage: StageName; step: number; onRetry?: (info: RetryInfo) => void; wake?: () => AbortSignal | undefined }

// 6  ConfirmRequest (types.ts:452) and Confirmer (types.ts:458) — additive; confirm() keeps Promise<boolean>; alwaysDecline, the readline confirmer and every fake compile unchanged
export interface ConfirmRequest { /* …existing id / step / proposal / risk… */
  matchesIntent?: number | null;   // draft.matchesIntent (engine.ts:1004) → row 8 of reviewHeaderLines(req, n, columns) (§6.1); spread in only when not null
  jevLatencyMs?: number;           // the risk stage's Jev latency for the 120-column title
}
export interface ConfirmOutcome { approved: boolean; note?: string }   // note: redacted, ≤ 600, one line; `...(note ? { note } : {})`
export interface Confirmer {
  confirm(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<boolean>;
  /** preferred by the engine when present; the TUI implements it for the `d` note */
  confirmDetailed?(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<ConfirmOutcome>;
  readonly identity: string;
}

// 7  Spend (SpendSnapshot types.ts:470, SpendMeter types.ts:477)
export interface SpendSnapshot { generator: TokenUsage; jev: TokenUsage; totalUsd: number; capUsd: number; exceeded: boolean;
  parentExceeded?: boolean; parent?: { totalUsd: number; capUsd: number } }   // createSpendMeter(cap, parent): `...(parent ? { parentExceeded: parentExceeded(), parent: { totalUsd: p.totalUsd, capUsd: p.capUsd } } : {})`
export interface SpendMeter { /* …existing… */
  /** root meter: replace the cap (USD or +Infinity); children keep forwarding to the same object; never recreate a meter */
  setCap?(capUsd: number): void;
}

// 8  Workspace (types.ts:539) and workspace/files.ts — mention-only read behind --allow-secret-mention; git facts without a spawn; a standalone walker for the pre-run `@` list
export interface Workspace { /* …existing… */
  readSecretForMention?(rel: string, maxBytes: number): Promise<FileView>;
  gitState?(): GitState | null;                 // the run-start probe handed in by createEngine (§12.1), refreshed by invalidateCandidates()
  dirtySet?(): ReadonlySet<string>;             // snapshotDirty ∪ statusEntries ∪ touched, in memory
}
// files.ts:65  createWorkspace(root, runDir, deps: WorkspaceDeps & { gitState?: GitState })   — zero spawns when gitState is given (§12.1)
// files.ts     export function listCandidates(root: string, o: { secretPaths: readonly string[]; redact: (s: string) => string; max?: number }): Promise<readonly Candidate[]>   — the walker alone: no run dir, no sandbox (§5.4)

// 9  CheckpointState (types.ts:635; new fields after `synthState?` at :670) — optional, absent-tolerant; isCheckpointState (store.ts:108) unchanged
export interface PendingDirective { text: string; at: string; index: number }   // raw in memory (§8.6); masked on disk by the store's write-time redaction (P56)
export type UndoSkipReason = 'link' | 'escape' | 'submodule' | 'not-recoverable' | 'head-moved' | 'refused' | 'declined' | 'cap' | 'size';
export interface UndoLogEntry { runId: string; step: number; at: string; by: 'undo' | 'rewind'; restored: string[]; skipped: { path: string; reason: UndoSkipReason }[] }
export interface CheckpointState { /* …existing… */
  pendingDirectives?: PendingDirective[];      // ≤ 8; steers queued and not yet applied (activeHuman is re-derived from plan.harnessProblems on resume, not stored)
  undoLog?: UndoLogEntry[];                    // ≤ 20; carried from the seed or EngineOptions.undoLog, never written into a finished run
  checkpointDegraded?: boolean;
}

// 10 RunMeta (types.ts:686) — isRunMeta (store.ts:132) unchanged; CheckpointStore.updateMeta (types.ts:720; store.ts:352) patch type gains 'title' | 'instructions' | 'git'
export type RunSource = 'cli' | 'bench' | 'perf';
export interface InstructionRecord { path: string; sha256: string; bytes: number }
export interface RunMeta { /* …existing… */
  sessionId?: string; parentRunId?: string | null; source?: RunSource; title?: string;
  git?: RunGitMeta; instructions?: InstructionRecord[];
}
export interface CheckpointStore { /* …existing… */
  updateMeta(patch: Partial<Pick<RunMeta, 'overrides' | 'resumes' | 'resolvedJevModel' | 'jevModelDrift' | 'title' | 'instructions' | 'git'>>): Promise<void>;   // git: scalar replace (run:end re-probe P51, resumedOn P52)
  writeUi?(ui: Json): Promise<void>;           // ui.json; optional so injected fakes still type-check
}

// 11 RunLimits (types.ts:742) and EngineOptions (types.ts:754; `exit?: (code: number) => never` at :787 exists today and is now always injected by cli/session.ts, §13.4)
export interface RunLimits { /* …existing… */ maxGeneratorTokens?: number }   // only under allowUnpriced
export interface EngineSeed {
  parentRunId: string;
  plan: Plan;                                  // done/remaining/unverified from the parent (or planAfter of a rewound step); openProblems []; harnessProblems = step-0 human problems: framing, undo notes, the parent's pendingDirectives (§8.3)
  window: WindowEntry[];                       // last 4 of the parent, notes += 'from run <id>'
  createdThisRun: string[];
  lastTestRun: LastTestRun | null;
  undoLog?: UndoLogEntry[];
  pinnedFiles?: string[];                      // @-mentions: boosted into the context candidates, never past the caps
}
export interface SessionClamp { runCapUsd: number; clampedToUsd: number; sessionSpentUsd: number; sessionCapUsd: number }   // §9.3: main() emits budget:clamp from it right after run:ready
export interface SessionRef { sessionId: string | null; parentRunId: string | null; source: RunSource; title?: string; clamp?: SessionClamp }
export type BlockingKind = 'jev-unreachable' | 'key-rejected' | 'spend-limit' | 'checkpoint-degraded' | 'drift' | 'sandbox-unavailable';
export type BlockingAnswer = 'retry' | 'continue' | 'stop' | 'login' | 'pin';
export interface BlockingRequest { id: string; step: number; kind: BlockingKind; side?: 'jev' | 'generator'; detail: string; sources?: string[]; retryInMs?: number; stop: StopReason; exitCode: number }
export interface EngineOptions { /* …existing… */
  seed?: EngineSeed;
  /** an initial pending directive consumed at the first step start exactly like a steer: typed while `starting`, or the /undo note on /resume (§12.4) */
  humanDirective?: string;
  /** /resume after /undo or /rewind: merged into the restored undoLog (§12.4) */
  undoLog?: UndoLogEntry[];
  /** written into run.json; default { sessionId: null → runId, parentRunId: null, source: 'cli' }; bench/conditions.ts passes source 'bench', the perf drivers `--source perf` */
  session?: SessionRef;
  /** AGENTS.md: text → generator system prompt only; files → run.json.instructions[] */
  instructions?: { files: InstructionRecord[]; text: string };
  secretsAcked?: number;                       // count for the run:start secret-ack item (never values)
  allowUnpriced?: boolean;
  /** every blocking pause (§13.3) is awaited here at the loop top; absent → every answer is 'stop' (bench, --plain pipe, --no-input, --json) */
  blocker?: (req: BlockingRequest) => Promise<BlockingAnswer>;
  /** resolved XDG + legacy jevcode config dirs → seatbelt read denies (§12.7) */
  configDirs?: readonly string[];
  // NOT here: git / gitDir / gitCommonDir — probed inside createEngine before createSandbox and handed to createWorkspace (§12.1)
}

// 12 Git (new, after WorkspaceInfo types.ts:526)
export interface StatusEntryV2 { xy: string; sub: string; path: string; from?: string; hH?: string; hI?: string; mode?: string }
export type GitHead = { kind: 'branch'; name: string; oid: string | null } | { kind: 'detached'; oid: string } | { kind: 'unborn'; name: string };
export interface GitState {
  repo: boolean; reason?: 'not-a-repo' | 'git-missing' | 'bare' | 'timeout';
  gitDir: string | null; commonDir: string | null; topLevel: string | null; prefix: string; linkedWorktree: boolean;
  head: GitHead | null; upstream: string | null; ahead: number | null; behind: number | null;
  dirty: { modified: number; staged: number; untracked: number; renamed: number; unmerged: number; submodules: number; entries: StatusEntryV2[] };
  probedAt: string; probeMs: number;
}
export type RunGitMeta = Pick<GitState, 'repo' | 'reason' | 'head' | 'upstream' | 'linkedWorktree' | 'prefix'> & {
  dirtyAtStart: { modified: number; staged: number; untracked: number };
  end?: Pick<GitState, 'head' | 'upstream' | 'ahead' | 'behind'> & { dirty: { modified: number; staged: number; untracked: number } };   // run:end re-probe (P51), persisted via updateMeta({ git })
  resumedOn?: GitHead | null;                  // set on --resume when head differs from `head` (P52)
};
export interface WorkspaceInfo { /* …existing… */ gitState?: GitState }
// workspace/gitstate.ts  export function probeGitState(root: string, o?: { timeoutMs?: number; execFile?: typeof execFile }): Promise<GitState>; export function toRunGitMeta(g: GitState): RunGitMeta   // two unsandboxed spawns (§12.1)

// 13 EngineStatus (types.ts:831)
export interface EngineStatus { /* …existing… */ maxReplans?: number; replans?: number; pausing?: boolean; pendingDirectives?: number; blocked?: BlockingKind | null;
  retrying?: { side: 'jev' | 'generator'; attempt: number; maxAttempts: number; untilMs: number } | null; generatorTokens?: { used: number; cap: number | null } }

// 14 EngineEvent (types.ts:841) — new members; run:ready (:844), confirm:resolved (:859), run:end (:872) extended with OPTIONAL fields
export type NoticeKind = 'offline' | 'online' | 'checkpoint:degraded' | 'checkpoint:restored' | 'sandbox' | 'drift' | 'seeded' | 'instructions' | 'config' | 'pricing' | 'lock' | 'ui';
export type UiLabel = '[ui]' | '[setup]' | '[config]' | '[sandbox]';   // the only labels formatTranscriptItem prints instead of stepLabel() (item 19, §15.1)
export type EngineEvent = /* …existing members… */
  | { type: 'run:ready'; runId: string; step: number; maxSteps: number; task: string; resumed: boolean;
      sessionId?: string; parentRunId?: string | null; sandbox?: SandboxLevel; noNetwork?: boolean; maxReplans?: number }   // built as `{ …, sessionId: session?.sessionId ?? runId, parentRunId: session?.parentRunId ?? null }`
  | { type: 'confirm:resolved'; step: number; id: string; approved: boolean; aborted: boolean; note?: string }
  | { type: 'run:end'; result: RunResult; exitCode?: number; resumable?: boolean; paths?: { runDir: string; transcript: string; log: string } }
  | { type: 'steer:queued'; step: number; index: number; text: string; queued: number }
  | { type: 'steer:applied'; step: number; count: number; superseded: string[] }
  | { type: 'steer:withdrawn'; step: number; index: number }
  | { type: 'pause:requested'; step: number }
  | { type: 'budget:warn'; scope: 'run' | 'session'; pct: 50 | 80 | 95; spentUsd: number; capUsd: number; step: number; stepsLeftEstimate: number | null; restored: boolean; jevShare?: { jevUsd: number; generatorUsd: number } }
  | { type: 'budget:stop'; scope: 'run' | 'session'; by: 'run' | 'session' | 'tokens'; spentUsd: number; capUsd: number; step: number; at: StoppedAt; raise: { command: string; flag: string; minimum: number } }   // the follow-up refusal is a controller line (§9.3, §8.9), not an event
  | { type: 'budget:clamp'; runCapUsd: number; clampedToUsd: number; sessionSpentUsd: number; sessionCapUsd: number }   // emitted by main() after run:ready from EngineOptions.session.clamp (§9.3)
  | { type: 'budget:override'; setting: string; from: string; to: string; appliesTo: 'resume'; source: '/budget' | 'flag' }   // emitted by main() per run.json.overrides[] entry recorded on this resume (§9.4); session-cap changes are note()/annotate() lines
  | { type: 'budget:unpriced'; side: SpendSource; model: string; step: number; tokens: { input: number; output: number } }
  | { type: 'retry'; side: 'jev' | 'generator'; step: number | null; stage: StageName | null; info: RetryInfo }
  | { type: 'retry:settled'; side: 'jev' | 'generator'; step: number | null; attempts: number; ok: boolean; totalWaitMs: number }
  | { type: 'notice'; step: number | null; kind: NoticeKind; level: 'info' | 'warn' | 'error'; text: string; detail?: string; label?: UiLabel }   // kind 'ui' + label = Engine.annotate() (§15.1); detail is the TUI-only body
  | { type: 'workspace'; git: RunGitMeta; instructions: InstructionRecord[]; sandbox: SandboxLevel }
  | { type: 'blocking:request'; request: BlockingRequest }
  | { type: 'blocking:resolved'; id: string; answer: BlockingAnswer; auto: boolean }   // auto = the jev-unreachable timer answered
  | { type: 'secret-ack'; step: number | null; count: number };
// The `synth` member (types.ts:842) is NOT extended here: the structured fields are the synth team's optional extension (A48, F16).

// 15 Engine (types.ts:882; `abort` at :890) — five required methods and one widened parameter; implementers: loop/engine.ts, test/unit/bench/helpers.ts:236, test/fixtures/tui/fixtures.ts:97
export type SteerResult = { ok: true; index: number; queued: number } | { ok: false; reason: 'empty' | 'full' | 'finished'; queued: number };
export interface Engine { /* …existing… */
  /** queue a human directive for the next step start (≤ 8 × 600 chars; raw in memory, masked on every artefact) */
  steer(text: string, opts?: { secretsAcked?: number }): SteerResult;
  /** withdraw the newest queued directive; null when none */
  unsteer(): PendingDirective | null;
  /** stop with 'human_pause' at the next §9.1 rule-1 point; idempotent */
  pause(): void;
  /** end the current retry sleep early (F12 `[r]`); false when no retry sleep is active */
  retryNow(): boolean;
  /** a renderer-originated transcript line while the run is live (§15.1); false once finished, then the renderer keeps it local */
  annotate(text: string, opts?: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' }): boolean;
  /** widened: 'error' stores opts.error as the fatal error (fatalExit, §13.4); opts.signal names the signal for exit codes 130 / 143 / 129 (§13.5) */
  abort(reason: 'human_abort' | 'signal' | 'error', opts?: { signal?: SignalName; error?: SerializedError }): void;
}

// 16 Renderer wiring (RendererOptions types.ts:900, Renderer types.ts:911) — launch settings fixed at mount; session settings through the full chain after firstFrame() (§16)
export interface LaunchSettings { fps: number; renderMode: 'standard' | 'incremental'; screenReader: boolean; ascii: boolean; noColor: boolean }   // resolveLaunchSettings(flags, env): flag > env > default; pure; no file
export interface UiConfig extends LaunchSettings { theme: 'dark' | 'light' | 'daltonized' | 'ansi'; title: boolean; reducedMotion: boolean; notify: boolean; osc52: boolean; history: boolean;
  noInput: boolean; trustWorkspace: boolean; budgetWarnings: boolean; allowSecretMention: boolean; exitCode: 'zero' | 'last-run';
  logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace'; logFile: string | null; keybindingsFile: string | null }   // the LaunchSettings members repeat the mount-time values (source flag | env | default only)
export interface SessionHost {                  // implemented by cli/session.ts over config.redact / config.addSecret; the renderer calls it, never the engine directly
  submit(text: string, opts: { kind: 'prompt' | 'follow-up'; secretSpans: readonly string[]; pinnedFiles: readonly string[] }): Promise<void>;   // addSecret('composer#n', span) per span BEFORE createEngine (§10.2)
  command(line: string): Promise<void>;
  steer(text: string, opts: { secretSpans: readonly string[] }): SteerResult;   // addSecret per span BEFORE engine.steer; secretsAcked = spans.length
  unsteer(): PendingDirective | null; pause(): void; abort(reason: 'human_abort'): void; retryNow(): boolean;
  /** a renderer-originated line: engine.annotate() while a run is live, else a local `[ui]` item + `--json` `ui` line (§15.1) */
  note(text: string, opts?: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' }): void;
  redact(s: string): string; addSecret(name: string, value: string): boolean; detectSecrets(s: string): readonly SecretHit[];   // §10.2; before setHost the composer detects with patternRedact only and holds Enter (§4.9)
  exit(code: number): void;
  index(): readonly SessionRow[]; history(): HistoryStore | null;
  workspaceCandidates(): Promise<readonly Candidate[]>;   // pre-run: files.ts listCandidates() once after firstFrame(); from run:ready: the live workspace.listCandidates() (§5.4)
}
export interface RunRow { runId: string; parentRunId: string | null; startedAt: string; endedAt: string | null; stopReason: StopReason | null; steps: number | null;
  costUsd: { generator: number; jev: number } | null; exitCode: number | null; resumable: boolean | null; resumes: number; live: boolean }
export interface SessionRow { sessionId: string; workspace: string; title: string; task60: string; runs: RunRow[]; lastUsed: string; createdAt: string; totalUsd: number; mode: EngineMode; branch: string | null }
export interface HistoryStore { entries(filter: 'workspace' | 'all'): readonly string[]; append(kind: 'prompt' | 'steer' | 'command', text: string): void; clear(): void }
export interface RendererOptions { /* …existing… */ mode?: 'one-shot' | 'session'; launch?: LaunchSettings; host?: SessionHost }   // `ui` (UiConfig) arrives through setUi() after resolveConfig
export interface Renderer { /* …existing… */
  setHost?(host: SessionHost): void;            // after firstFrame() + resolveConfig; a held submission flushes here (§4.9)
  setUi?(ui: UiConfig): void;                   // session settings; theme / notify / … apply to new items and the dynamic region only
  notify?(text: string, opts?: { level?: 'info' | 'warn' | 'error'; detail?: string; label?: UiLabel }): void;   // appends a local item — idle time only (§15.1)
}

// 17 ResolvedConfig (types.ts:951), GeneratorConfig (types.ts:931), ConfigSource (types.ts:924)
export type SecretSettingName = 'generator.apiKey' | 'decider.apiKey';
export interface GeneratorConfig { /* …existing… */ priced?: boolean }   // OPTIONAL: validateGenerator always sets it; resolveConfig / validate.ts treat absent as false (test/unit/provider/helpers.ts compiles unchanged)
export type ConfigSource = 'flag' | 'env' | `dotenv:${string}` | `file:${string}` | 'default' | 'run.json' | 'wizard' | 'derived' | 'session:/budget' | 'ignored:launch';   // ignored:launch = a file key for a launch setting (§16)
export interface ResolvedConfig { /* …existing… */
  missingSecrets(mode: EngineMode): readonly SecretSettingName[];   // non-throwing; skips generator.apiKey for jev-only and --mock*
  ui(launch: LaunchSettings): UiConfig;                              // session settings through the full chain; the launch members are copied from the argument, never re-resolved
  sessionSpendCap(mode: EngineMode): { value: number; source: ConfigSource; derived: boolean };   // 'none' → +Infinity
  addSecret(name: string, value: string): boolean; dropSecret(name: string): boolean;             // delegate to the redactor
  readonly configDirs: readonly string[];                            // resolved XDG + legacy jevcode dirs (§12.7)
}
// config/launch.ts  export function resolveLaunchSettings(flags: ParsedFlags, env: NodeJS.ProcessEnv): LaunchSettings   // pure; argv + env only (§1)

// 18 SandboxCreateOptions (types.ts:1085) and sandbox/seatbelt.ts ProfileOptions (seatbelt.ts:17)
export interface SandboxCreateOptions { /* …existing… */ gitDir?: string; gitCommonDir?: string; configDirs?: readonly string[] }
// ProfileOptions { …; gitDir?: string; gitCommonDir?: string; configDirs?: readonly string[] }   — sandbox/run.ts:184–195 forwards all three to buildProfile (O5)

// 19 Outside types.ts (same PR):
// core/redact.ts    Redactor { …; dropSecret(name: string): boolean }; export interface SecretHit { family; label; start; end; warnOnly }; export const WARN_ONLY_PATTERNS; export function detectSecrets(s, exact?)
// core/time.ts      export function sleep(ms: number, signal?: AbortSignal, wake?: AbortSignal): Promise<void>   // rejects on signal, resolves early on wake
// errors.ts         BudgetKind += 'token_cap'; class AbortError { readonly signalName: SignalName | null; constructor(reason: AbortReason, signalName: SignalName | null = null) }
// loop/stop.ts      export function exitCodeFor(reason: StopReason, error?: SerializedError, degraded?: boolean, signal?: SignalName): number; BUDGET_STOP_REASONS += 'token_cap' (not human_pause)
// loop/budget.ts    BUDGET_ORDER = ['spend_cap', 'token_cap', 'wall_time', 'max_steps', 'max_replans']; BudgetInput { …; generatorTokens?: number; maxGeneratorTokens?: number }
// loop/plan.ts      PlanUpdateInput { …; human?: boolean }  (rule (b) drop allowed; steer problems (step > 0) dropped when step > h.step + 4 or superseded; step-0 problems when step > 8)
// loop/loopdetect.ts LoopDetector { …; resetCounts(): void }   // counts/lastSignature/tripped cleared; trips history and replanCount kept
// provider/prompts.ts PromptInput { …; humanDirectives?: readonly string[]; pinnedFiles?: readonly string[] }; SystemPromptOptions { …; instructions?: string }   // hintsSection: one `- Instruction from the human …` line per directive, each clipped at 600 (§8.6)
// loop/state.ts     CommonStateInput { …; human?: { directives: readonly string[]; step: number } | null }  → state.human = { directives (≤ 8 × 600; masked by the existing redactJson at :133), step }
// tui/plain.ts      TranscriptKind += 'steer:queued' | 'steer:applied' | 'steer:withdrawn' | 'pause' | 'budget' | 'retry' | 'notice' | 'workspace' | 'blocking' | 'secret-ack' | 'ui';
//                   TranscriptItem { …; local?: boolean; label?: UiLabel }   // formatTranscriptItem = `${item.label ?? stepLabel(item.step)} ${item.text}`; only notice kind 'ui' and local items set label
// checkpoint/store.ts CHECKPOINT_FILES += { ui: 'ui.json', log: 'jevcode.log', lock: 'run.lock', pre: 'pre', post: 'post', tmp: 'tmp', drafts: 'drafts' }
// src/version.ts    declare const __JEVCODE_VERSION__: string | undefined; export const VERSION = typeof __JEVCODE_VERSION__ === 'string' ? __JEVCODE_VERSION__ : readPackageVersion()   // §17: safe under tsx and vitest
```

**Item 20 — `UiState` 1.1 (`tui/useEngine.tsx:17–43` today; O9 implements it, every other slot's pure functions consume it).** The exact shape, the action union and the per-event transition table, so §19.1's reducer tests are written one per row:

```ts
export type RunPhase = 'none' | 'starting' | 'live' | 'aborting' | 'pausing';   // no 'paused': a blocking pause is overlay 'blocking' with run 'live' (§13.3); human_pause ends the run (run:end)
export interface Toast { id: number; text: string; level: 'info' | 'error' | 'ok'; untilMs: number }
export interface RetryView { side: 'jev' | 'generator'; attempt: number; maxAttempts: number; untilMs: number; cause: RetryCause; lastCause: RetryCause | null }
export interface LoopView { signature: string; count: number; replan: { n: number; max: number; step: number; move: string; p: number; impossible: number } | null }
export interface GitZone { head: GitHead | null; ahead: number | null; behind: number | null; dirty: { modified: number; staged: number; untracked: number }; linkedWorktree: boolean; frozen: boolean }
export interface DraftMirror { empty: boolean; rows: number; cursorRow: 'first' | 'mid' | 'last'; secretHits: number }   // the TextBuffer lives in Composer's own reducer (§4.1); resolveKey and computeLayout need only this mirror
export interface UiState {
  /* today's fields, kept: items, seq, live, toolChars, synth, mode, decisions, status, ready, pendingConfirm, task, resumeId, runId, done */
  run: RunPhase;
  draft: DraftMirror;
  queue: PendingDirective[];                          // ≤ 8
  overlay: OverlayKind; overlayArmed: boolean;        // armed = drawn on a committed frame (§6.3; every y-gated overlay)
  pendingReview: ConfirmRequest | null; visibleAt: number | null; lastKeystrokeAt: number; expanded: boolean; noteMode: boolean;
  retrying: RetryView | null;
  errors: number;                                     // the `!n` badge
  stageStartedAt: number | null;                      // `still waiting` after 45 s
  rows: DecisionRow[]; byStep: Map<number, DecisionRow[]>;   // last 12 rows (DECISIONS_KEPT); rows of the last 3 steps
  loop: LoopView | null;
  toasts: Toast[];                                    // ≤ 4; an error toast pre-empts an info toast
  tab: 'd' | 'p' | 't' | 's';
  git: GitZone | null;
  paths: { runDir: string; transcript: string; log: string } | null;
  blocking: BlockingRequest | null;
  spend: { run: SpendSnapshot | null; session: { totalUsd: number; capUsd: number } | null };
  nowMs: number;                                      // the 1 Hz tick: wall clock, toast expiry, retry countdown, review visibility re-check
}
export type UiAction =
  | { type: 'event'; event: EngineEvent } | { type: 'live'; text: string; toolChars?: number }            // today
  | { type: 'confirm:request'; request: ConfirmRequest } | { type: 'confirm:settled'; id: string }       // today
  | { type: 'key'; at: number }                        // every key event: lastKeystrokeAt (review deferral)
  | { type: 'tick'; now: number }
  | { type: 'draft'; draft: DraftMirror }
  | { type: 'overlay'; overlay: OverlayKind } | { type: 'overlay:armed' }
  | { type: 'review:visible' } | { type: 'review:expand'; expanded: boolean } | { type: 'note'; on: boolean }
  | { type: 'run:starting' } | { type: 'run:aborting' } | { type: 'run:pausing' }                       // local phases the engine has no event for
  | { type: 'run:idle' }                               // a `starting` that never became a run (follow-up box n/Esc, a refusal, a missing key)
  | { type: 'thresholds'; complete: number; impossible: number }   // the controller's resolved --complete-threshold / --impossible-threshold (§7.1 rows)
  | { type: 'toast'; text: string; level: Toast['level']; ms: number } | { type: 'ack-errors' }
  | { type: 'tab'; tab: UiState['tab'] } | { type: 'git'; zone: GitZone | null }
  | { type: 'local-item'; item: TranscriptItem };     // idle-time renderer-local item (§15.1)
```

| Event / action | Fields touched (everything else unchanged) |
| --- | --- |
| `run:start` | `runId`, `mode`; **reset for the next run of the session**: `done: null`, `decisions: []`, `rows: []`, `byStep: new Map()`, `ready: null`, `status: null`, `live: ''`, `toolChars: 0`, `synth: null`, `retrying: null`, `loop: null`, `blocking: null`, `pendingConfirm: null`, `pendingReview: null`, `visibleAt: null`, `expanded: false`, `noteMode: false`, `overlay: 'none'`, `paths: null`, `stageStartedAt: now`; `run: 'live'`. (Today's reducer never clears `done`, `useEngine.tsx:69–71`/`:104`; with `attach()` re-subscribing per run the second run's Enter went to `submit` instead of `steer` and the spinner stayed off — this row is the fix.) |
| `run:ready` | `runId`, `ready { step, maxSteps }`, `run: 'live'` |
| `workspace` | `git` (zone seed from `e.git`); the `[run] git …` item through `items` |
| `decision` | `decisions` (last 12); `rows`/`byStep` via `toDecisionRow` (rows of the last 3 steps kept) |
| `status` | `status`; `stageStartedAt: now` when `status.stage` changed; `retrying` mirrored from `status.retrying` when present |
| `stage:start` / `stage:end` | `stageStartedAt` |
| `generator:start`, `exec:start`, `proposal`, `outcome` | `live: ''`, `toolChars: 0`, `synth: null` (today's rule) |
| `generator:tool-delta` | `toolChars` |
| `synth` | `synth` |
| `step:end` | `loop` folded from `record.loopSignatures` (a repeated signature with count ≥ 2 → banner); `spend.run` refreshed from `record.usage` when no `status` carried it |
| `plan` | pane data through `items`; `loop.replan` cleared when the plan's `harnessProblems` hold no replan any more |
| `replan` | `loop.replan = { n, max, step, move, p, impossible }` |
| `steer:queued` / `steer:withdrawn` | `queue` push / pop |
| `steer:applied` | `queue: []`, `loop: null` (the detector's counts reset too) |
| `pause:requested` | `run: 'pausing'` |
| `confirm:request` | `pendingConfirm`, `pendingReview`, `visibleAt = max(now, lastKeystrokeAt + 1000)`; `overlay` unchanged until `review:visible` |
| `review:visible` (tick/effect when `now ≥ visibleAt` and the input queue is drained) | `overlay: 'review'`, `overlayArmed: false` (armed by `overlay:armed` on the next commit) |
| `confirm:resolved` / `confirm:settled` | `pendingConfirm: null`, `pendingReview: null`, `visibleAt: null`, `overlay: 'none'`, `expanded: false`, `noteMode: false` |
| `retry` | `retrying { side, attempt, maxAttempts, untilMs: now + info.waitMs, cause, lastCause }` |
| `retry:settled` | `retrying: null` (+ the `warning:` item rule of §15.1) |
| `budget:warn` / `budget:stop` / `budget:clamp` / `budget:override` / `budget:unpriced` | `spend` and items; the toast is dispatched by the effect layer (`toast`) |
| `blocking:request` | `blocking`, `overlay: 'blocking'`, `overlayArmed: false` |
| `blocking:resolved` | `blocking: null`, `overlay: 'none'` |
| `notice` | items; `kind: 'checkpoint:degraded'` → `errors + 1`; `kind: 'ui'` → the item carries `label` |
| `error` (`fatal: false`) | `errors + 1`, items |
| `run:end` | `done: e.result`, `run: 'none'`, `pendingConfirm: null`, `pendingReview: null`, `visibleAt: null`, `overlay: 'none'`, `live: ''`, `toolChars: 0`, `synth: null`, `retrying: null`, `blocking: null`, `queue: []`, `paths: e.paths ?? null` |
| `key` | `lastKeystrokeAt` |
| `tick` | `nowMs`; expired toasts dropped; `review:visible` re-check |
| `run:starting` / `run:aborting` / `run:pausing` | `run` |
| `run:idle` | `run: 'none'` **only from `starting`** (the submit never became a run: the follow-up box answered `n`/Esc, the session-cap refusal, a missing key); a `live` / `aborting` / `pausing` run is untouched — it ends through `run:end` |
| `thresholds` | `thresholds { complete, impossible }` (defaults until the controller dispatches it right after `resolveConfig` and again before each run with that run's limits); `toDecisionRow` reads them for every later `decision`, so the `!` near-threshold marker and `consumedBy` follow a non-default `--complete-threshold`; non-finite values keep the current ones |
| `toast` | `toasts` (≤ 4, error pre-empts info); the item twin goes through `SessionHost.note()` |
| `ack-errors` | `errors: 0` |
| `tab`, `git`, `draft`, `overlay`, `overlay:armed`, `review:expand`, `note`, `local-item` | the named field |

### 15.1 Renderer-originated lines and the three-way identity (engineering judge §4.1; D12; F13)

`itemsFromEvent` (`plain.ts:206`) is the only source of transcript lines and `recordTranscript` (`engine.ts:585–592`) the only writer of `transcript.log`, so the three writers stay **line-for-line identical for the whole of a run** — F13's identity is kept, not narrowed. Every line a renderer originates while an engine is live (help, `/why`, `/plan`, `/decisions`, `/diff`, `/cost`, `/config`, `/status`, undo output, the 12,000-char notice, toasts-as-items, `[ui] error:` lines, `/budget` changes) travels `SessionHost.note()` → `Engine.annotate(text, { detail, label })` → `emit({ type: 'notice', kind: 'ui', label })` → `redactDeep` → `recordTranscript` → all three writers with the engine's `transcriptSeq`; `itemsFromEvent` turns it into one item whose `label` (`[ui]`, `[setup]`, `[config]`, `[sandbox]`) `formatTranscriptItem` prints instead of `stepLabel()`. While **no** engine is live (session start, between runs: the recent-session row, the sandbox line, idle help/`/cost`, the session epilogue, `[ui] error:` for idle commands, the `/new` summary, an idle `/budget session-spend-cap`) the renderer appends the same item shape with `local: true` — there is no `transcript.log` to hold it, `--plain` prints it, the `--json` stream carries it as `ui { text, label }` — so `/export` shows exactly what each run's `transcript.log` shows. Ephemeral hints (toasts that are not items, the Ctrl-C/Ctrl-D/Esc arm hints) reach none of the three.

Item table: **engine items** (all three writers) — every `itemsFromEvent` case including `notice` (all kinds), `steer:queued/applied/withdrawn`, `pause:requested`, `budget:warn/stop/clamp/override/unpriced`, `retry:settled` (one `warning:` line only when `ok === false` or `totalWaitMs > 10_000`), `workspace`, `blocking:request/resolved`, `secret-ack`, `confirm:resolved` (with `note`); **pane-only events** (no line) — `decision`, `status`, `stage:*`, `generator:*` deltas, `exec:output`, `retry`, `checkpoint`; **controller-only lines** (`--plain`, TUI, `--json` `session:*`/`ui`; never `transcript.log`) — the idle-time `local: true` items above and the `session:refused`/`session:budget` stream lines (§8.9). No `user` event exists: the human turn is the `run:start` task line and the `steer:queued` lines, which the engine emits. The §19.4 parity test replays engine events only; the idle-time items are asserted present in `--plain`/TUI and absent from every `transcript.log`.

### 15.2 Insertion points

| File | Where (today) | Change |
| --- | --- | --- |
| `loop/engine.ts` | fields after L370 | `pendingDirectives: PendingDirective[] = []`, `steerSeq = 0`, `pauseRequested = false`, `activeHuman: { texts: string[]; step: number } \| null = null`, `retryWaker: AbortController \| null = null`, `undoLog: UndoLogEntry[]`, `checkpointDegraded = false`, `warned = new Set<string>()`, `generatorTokens = 0`, `seeded = false`, `blocked: BlockingRequest \| null = null`, `signalName: SignalName \| null = null`, `fatalError: SerializedError \| null = null` |
| | constructor L399–439 (resume) | `pendingDirectives ← s.pendingDirectives ?? []`, `undoLog ← [...(s.undoLog ?? []), ...(opts.undoLog ?? [])]`, `checkpointDegraded ← s.checkpointDegraded ?? false`, `generatorTokens ← Σ generatorTokensPerStep` (so `token_cap` survives resume), `activeHuman` re-derived from `plan.harnessProblems` (§8.6) |
| | constructor L440–442 (fresh) | `else if (init.opts.seed) { plan/window/createdThisRun/lastTestRun/undoLog ← seed; lastChangeStep = null; seeded = true }`; `opts.humanDirective` → `pendingDirectives.push(...)` (both branches); `buildSystemPrompt({ …, instructions: opts.instructions?.text })` (L395) |
| | `isPlainStopBudget` L294, `storedStopBlocks()` L446–461 | `'token_cap'` joins the plain budget set: `case 'token_cap': return this.generatorTokens >= lim.maxGeneratorTokens ? r : null`; `human_pause` → null |
| | `abort()` L487–510, `forceExit()` L512–521 | `abort(reason, opts?)`: `signalName ← opts?.signal ?? null`, `fatalError ← opts?.error ?? null` for `'error'`; `new AbortError(reason, signalName)`; `forceExit(exitCodeFor('signal', undefined, false, this.signalName))` replaces the `130 : 130` ternary (L494); `forceExit` calls `this.opts.exit`, always injected by `cli/session.ts` (§13.4) |
| | `main()` L551 | `run:ready` payload adds `sessionId: session?.sessionId ?? runId`, `parentRunId`, `sandbox: this.sandbox.level`, `noNetwork: this.opts.noNetwork`, `maxReplans`; then `emit({ type: 'workspace', git, instructions, sandbox })`; `budget:clamp` when `opts.session?.clamp`; one `budget:override` per `run.json.overrides[]` entry recorded on this resume; `notice seeded` when seeded; `secret-ack` when `opts.secretsAcked` |
| | `main()` loop L559–570 | after the `checkBudgets` block: `if (this.pauseRequested) return this.finish('human_pause'); if (this.blocked) { … awaitBlocker … } this.applyPendingDirectives();` (§8.6, §13.3) |
| | class body after L510 | `steer/unsteer/pause/retryNow/annotate/applyPendingDirectives/awaitBlocker` (§8.6, §13.3) |
| | `persist()` L600–612 | classify `e.code` ∈ ENOSPC/EACCES/EROFS/EDQUOT/EIO/EMFILE → `notice checkpoint:degraded` once per (file, code); `blocked = { kind: 'checkpoint-degraded', stop: 'error', exitCode: 3, … }` for `state.json` |
| | `budgetInput()` L622–635 | `generatorTokens`, `maxGeneratorTokens` |
| | `buildCheckpointState()` L637–670 | `pendingDirectives`, `undoLog`, `checkpointDegraded` |
| | `askRecorded()` L779–835 (`meter.add` L790) | `onRetry: (info) => { this.retryWaker = new AbortController(); emit retry }` and `wake: () => this.retryWaker?.signal` in `AskOptions`; `retry:settled` in `finally` (nulls the waker); `emitBudgetWarn()` after `meter.add`; an exhausted chain with zero actions executed → `blocked = { kind: 'jev-unreachable', retryInMs, stop: 'error', exitCode: 5 }` when a blocker exists, else today's failure path |
| | `synthesisContext()` L861 | `directive: [draft.directive?.text, ...(this.activeHuman?.step === draft.step ? this.activeHuman.texts : [])].filter(Boolean).join('\n\n') \|\| null` (no batch clip) |
| | `generate()` L913–945 (`meter.add` L928) | the same `onRetry`/`wake` shape; `generatorTokens += in + out`; `emitBudgetWarn()` |
| | `runStep()` L1004, L1014–1026 | `const outcome = await this.confirm(…)` whose `req` gains `...(draft.matchesIntent !== null ? { matchesIntent: draft.matchesIntent } : {})` and `jevLatencyMs`; declined reason `+ (note ? ' — reviewer note: ' + note : '')`; `draft.notes.push('reviewer note: …')`; a rejected `confirm()` (abort) keeps propagating → rule-1 discard, counters untouched (S4 Ctrl-C, §3.3) |
| | `runStep()` before L1054 / after L1062 | `await writePreImages(…)` / `await writePostImages(…)` (§12.3: streamed, 16 MiB cap) with `draft.timing.imagesMs`; `headOid` from `workspace.gitState()` |
| | `confirm()` L1123–1139 | `const r = this.opts.confirmer.confirmDetailed ? await …confirmDetailed(req, o) : { approved: await …confirm(req, o) }`; `confirm:resolved` with `...(r.note ? { note: r.note } : {})`; return `r`; the catch path (L1132–1137) is unchanged — it is the S4 Ctrl-C decline |
| | `commonState()` L1148 | `human: this.activeHuman?.step === (draft?.step ?? this.step + 1) ? { directives: this.activeHuman.texts, step: this.activeHuman.step } : null` |
| | `promptInput()` L1176–1190 | `humanDirectives`, `pinnedFiles: this.opts.seed?.pinnedFiles ?? []` |
| | `commit()` L1314–1324, L1354–1362 | `applyPlanDraft({ …, human: (this.seeded && step === 1) \|\| this.activeHuman?.step === step })`; `timing.imagesMs = draft.timing.imagesMs` (already inside `harnessMs`); after L1417 `record.planAfter = planSnapshot(plan)`; `this.activeHuman = null` when its step committed; the checkpoint IIFE (L1441–1450) hashes nothing |
| | `finish()` L1463–1526 | `budget:stop` before `run:end` for `spend_cap`/`token_cap`; `run:end` gains `exitCode: exitCodeFor(reason, error ?? this.fatalError ?? undefined, this.checkpointDegraded, this.signalName ?? undefined)`, `resumable`, `paths`; release `run.lock`; the 5 s timeout's `forceExit` goes through the injected `exit` |
| | `createEngine()` L1603–1632 | order: `createRunDir`/`validateResumeId` → `git = await probeGitState(root)` → `createSandbox({ …, gitDir, gitCommonDir, configDirs })` → `createWorkspace(root, runDir, { sandbox, secretPaths, redact, gitState: git })` → fresh: `store.create(meta)` with `sessionId`, `parentRunId`, `source`, `title`, `git: toRunGitMeta(git)`, `instructions`, `versions.jevcode: VERSION`; resume: `updateMeta({ git: { …current, resumedOn } })`; write `run.lock` after create/load |
| `loop/stop.ts` | L15–29 | `exitCodeFor(reason, error?, degraded = false, signal?)`; `human_pause`/`token_cap` → 4; `degraded && reason !== 'error'` → 3; `signal` → 143 / 129 / 130 |
| `loop/budget.ts` | L10, L12–26, L33–52 | `token_cap` after `spend_cap`; `generatorTokens >= maxGeneratorTokens` |
| `loop/plan.ts` | L61–66, L96, L144 | `human?: boolean` in `PlanUpdateInput`; `dropAllowed = replan \|\| human \|\| newInfo ≥ 0.7`; steer problems dropped when `step > h.step + 4`, step-0 problems when `step > 8` |
| `loop/loopdetect.ts` | L144–156, L162 | `resetCounts()` |
| `loop/state.ts` | L66–83, L113–134 | `human?` input → `state.human = { directives: texts.map((t) => clip(t, 600)), step }` present only when non-null; masked by the existing `redactJson` at L133 |
| `provider/prompts.ts` | L51–70, L72–76, L82, L155–172 | `PromptInput.humanDirectives?`/`pinnedFiles?`; `SystemPromptOptions.instructions?` → append `\n\n## Project instructions\n<text>` at L106; `hintsSection` after L168: `for (const d of input.humanDirectives ?? []) lines.push(\`Instruction from the human for this step (it takes precedence over the plan's order): ${clip(d, 600)}\`)` |
| `core/time.ts` | L44–60 | `sleep(ms, signal?, wake?)`; `wake.addEventListener('abort', resolve, { once: true })` |
| `jev/client.ts` | L351–353 | `opts.onRetry?.({ attempt: httpAttempts, maxAttempts: JEV_RETRY.attempts, waitMs, retryAfter: err.retryAfterMs !== null, cause: causeOf(err) })`; `await sleep(waitMs, opts.signal, opts.wake?.())`; `JevHttpError.toJSON()` adds `status`, `retryable`, `side: 'jev'`, `requestId` |
| `provider/sse.ts` | L289–305 | `withRetry(deps, signal, attempt, hooks?: { onRetry?; wake? })`; `hooks?.onRetry?.({ attempt: i + 1, maxAttempts: MAX_ATTEMPTS, waitMs: delay, retryAfter: e.retryAfterMs !== null, cause })`; `deps.sleep(delay, signal, hooks?.wake?.())`; `ProviderHttpError.toJSON()` likewise (`side: 'generator'`) |
| `spend/meter.ts` | L41–93 | `let cap`; `setCap(capUsd) { cap = sanitiseCap(capUsd) }`; `snapshot()` returns `{ …, ...(parent ? { parentExceeded: parentExceeded(), parent: { totalUsd: p.totalUsd, capUsd: p.capUsd } } : {}) }` (never `parent: undefined`, exactOptionalPropertyTypes) |
| `core/redact.ts` | L17–25, L42–49 | `dropSecret`; `detectSecrets` (every family reports its spans; `warnOnly` is informational — the gate adds them all); `WARN_ONLY_PATTERNS` |
| `config/launch.ts` | (new) | `resolveLaunchSettings(flags, env)`: fps (flag > `JEVCODE_FPS` > 15 under `SSH_TTY`/`SSH_CONNECTION` > 30, clamped 5..30), renderMode, screenReader (`--screen-reader` > `JEVCODE_SCREEN_READER` > `INK_SCREEN_READER`), ascii (flag > `JEVCODE_ASCII` > auto from `TERM`/locale), noColor; pure, no I/O |
| `config/defaults.ts` | L10, L47–74 | `DEFAULT_SPEND_CAP_USD` stays 2; `JEV_ONLY_DEFAULT_SPEND_CAP_USD = 0.25` applied in `resolveConfig` after `--mode`; `SETTINGS` gains the §16 rows, launch rows flagged `launch: true` so `record()` prints `ignored:launch` for a file value |
| `config/validate.ts` | L96–127 | `priced = looked.known \|\| (inR && outR)` (optional on the type, always set here); the L123 warning becomes the fail-closed rule when `provider === 'anthropic' && !priced && !allowUnpriced` |
| `config/resolve.ts` | L208, L311–338 | XDG candidate first; `missingSecrets`, `ui(launch)`, `sessionSpendCap()`, `addSecret`/`dropSecret`, `configDirs`; `record()` gains the `ui.*`/`session.*` rows |
| `checkpoint/store.ts` | L28–37 (`CHECKPOINT_FILES`), L352 (`updateMeta`) | `CHECKPOINT_FILES` additions incl. `drafts`; `writeUi?`; `updateMeta` patch type incl. `git` (scalar replace) |
| `sandbox/paths.ts` | L108–110, L125–134 | basename rules; `isMentionDenied()` |
| `sandbox/seatbelt.ts` | L17–35, L42, L64 | `gitDir?`/`gitCommonDir?`/`configDirs?`; the moved denies; `configDirs` appended to the `file-read*` denies |
| `sandbox/run.ts` | L155, L183–195 | forward `gitDir`/`gitCommonDir`/`configDirs` to `buildProfile`; include them in the profile-path hash (O5) |
| `workspace/gitstate.ts` | (new) | `probeGitState(root, { timeoutMs, execFile })` — two unsandboxed spawns; `toRunGitMeta()` (§12.1) |
| `workspace/git.ts` | L151–178 | `statusPorcelainV2()` (pure parser over the probe's stdout), `restoreFromHead(sandbox, ws, paths)`; `statusPorcelain` (v1) kept for the per-command refresh |
| `workspace/files.ts` | L65, L100–125 | `createWorkspace(root, runDir, { …, gitState? })` — zero spawns when given; `gitState()`, `dirtySet()`, `readSecretForMention()`; standalone `listCandidates(root, { secretPaths, redact })` for the pre-run `@` list (§5.4) |
| `bench/conditions.ts` | L86–98 | `session: { sessionId: null, parentRunId: null, source: 'bench' }` in `buildEngineOptions` (O1, W2) |
| `src/version.ts` | (new) | `VERSION` with the `readPackageVersion()` fallback (§17); `engine.ts:1613` and `main.tsx` import it |
| `cli/args.ts` | L10–11, L78–124, L171–178, L233–235 | `COMMANDS += 'chat' \| 'login' \| 'logout' \| 'sessions' \| 'report' \| 'why' \| 'calibration' \| 'completion' \| 'upgrade'`; the §16 flags incl. the hidden `--source perf`; `--version --json`; bare argv / leading flag → `chat`; `--resume <value>` accepts any non-empty string — the `RUN_ID_RE` check at L233–235 moves to `cli/session.ts` after `firstFrame()` (`RUN_ID_RE` match → run id; else `resolveResumeTarget(fold, value)` → exact title → unique prefix → `ConfigError` listing candidates; on `--plain`/`--json`/a pipe a value that resolves to nothing → `UsageError`, exit 2, before any run) |
| `cli/main.tsx` | L15–29, L31–41, L81–210, L260–286, L288–296 | delete the local `exitCodeFor`; `readTask()` output through `detectSecrets` (§10.2); `resolveLaunchSettings` → `render()`; `commandRun`/`commandChat` share `cli/session.ts` (`setHost`, `setUi`, `blocker`, `exit`, `configDirs`); `printWarnings(config.warnings)`; `missingSecrets` probe after `firstFrame()`; `fatalExit` from `cli/fatal.ts`; SIGINT/SIGTERM → `abort('signal', { signal })`; new commands as dynamic imports; the jev-only branch untouched |
| `tui/plain.ts` | L30–46, L51–62, L206–275, L278, L287–308, L347–422, L447–502 | new `TranscriptKind`s, `local`, `label`; `formatTranscriptItem` prefers `label`; new `itemsFromEvent` cases; `CONFIRM_HEADER_ROWS = 8` with `confirmHeaderLines(req)` delegating to `reviewHeaderLines(req, 8, 80)` (6 → 8 rows: `test/unit/tui/plain.test.ts` expectations move with it, O10); readline `d <note>`; readline composer (`{ terminal: false }`, SIGINT per §14.2, `close` per §13.4) + `--json` writer |
| `tui/useEngine.tsx` | L17–43, L155–160, L169–224 | `UiState` 1.1 and `UiAction` exactly as item 20 with its transition table; `TuiConfirmer.resolveDetailed(id, outcome)` + `confirmDetailed` implementation; `pending().settle(false)` rule kept; the signal `onAbort` rejection kept (it is the S4 Ctrl-C path) |
| `tui/App.tsx` | L43–58, L64–73, L90–103, L123–140 | `computeLayout` → `tui/layout.ts`; `liveLines` bucketed counter; `useTerminalSize` → `useWindowSize`; the `useInput` body → `resolveKey`; Ctrl+L → `useStdout().write('')`; the L125–127 trace line → key classes; `useCursor` over `maskSpans` rows |

### 15.3 jev-only preservation checklist (tested by additions to `test/unit/loop/engine-jev-only.test.ts` and a `main.tsx` wiring test)

- `synth` events yield exactly one transcript line each (`itemsFromEvent` case at `plain.ts:229–231` unchanged) and the live-region line; the `s` tab renders `phase` + `detail` verbatim until the structured fields land.
- `propose [synth]` status marker unchanged (`SYNTH_MARKER`, `StatusLine.tsx:23`).
- `main.tsx`: `buildProvider` returns `createNullProvider()` for `jev-only` (L53–57) and `config.generator()` is never called (L162); `createSynthesizer({ decider, redact })` unchanged (L165–168); `missingSecrets('jev-only')` skips the generator key.
- `SynthesisContext.directive` stays `string | null`; the human texts are joined into it with `\n\n` and no batch clip (§8.6); no other `SynthesisContext` change; `SYNTH_STATE_MAX_BYTES` and `setSynthState` untouched.
- `src/synth/**` not modified; the structured `synth` fields are a separate PR by the synth team.
- `transcript.log`, `--plain` output and the TUI transcript remain line-identical for the whole run — `notice { kind: 'ui' }` lines from `annotate()` included (a fixture test replays `run-events.json` + the new events through all three writers and diffs the lines); idle-time `local: true` items are asserted present in `--plain`/TUI and absent from every `transcript.log`.
- Bench: `alwaysDecline` untouched; `bench/conditions.ts` sets `source: 'bench'`, which writes neither index nor history and keeps its own root meter; `BenchStopReason` compiles with the two new reasons; jev-only run cap default $0.25 / session $1.25 resolved after `--mode`.

## 16. Configuration schema (F14, D15; precedence flag > env > `./.env` > `<JEVCODE_EXTRA_ENV_FILE>` > file > default; `jevcode config` prints value + source per row; `jevcode config set <k> <v>` writes non-secret keys to the XDG file atomically)

Two resolution classes. **Launch settings** — `ui.fps`, `ui.renderMode`, `ui.screenReader`, `ui.ascii`, `ui.noColor` — are resolved by `resolveLaunchSettings(flags, env)` (`src/config/launch.ts`, pure, no I/O) as **flag > env > default** and passed to `render()` and the glyph table before the first frame: Ink computes `renderThrottleMs` once in its constructor and re-`render()` on the same stdout is unsupported (`ink.js:193–199`, `render.d.ts`), and F1 forbids any file read before `firstFrame()`, so a file value for these could never take effect honestly; `jevcode config` prints their source as `flag`/`env`/`default` and, when the file carries such a key, `ignored:launch` beside it. **Session settings** — everything else — follow the full chain after `firstFrame()` (`ResolvedConfig.ui(launch)`, delivered to the renderer through `setUi()`), and like `/theme` apply to new items and the dynamic region only. The four launch rows are marked below.

| Setting | Flag | Env | File key | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| `ui.theme` | `--theme dark\|light\|daltonized\|ansi` | `JEVCODE_THEME` | `theme` | `dark` | no auto-detect (C15); `/theme` applies to new items |
| `ui.fps` | `--fps <n>` | `JEVCODE_FPS` | — (`fps` in a file → `ignored:launch`) | `30`; `15` under `SSH_TTY`/`SSH_CONNECTION` | 5..30 (R14); **launch: flag > env > default, fixed at mount** |
| `ui.renderMode` | `--render-mode standard\|incremental` | `JEVCODE_RENDER_MODE` | — (`ignored:launch`) | `standard` | A31; **launch, fixed at mount** |
| `ui.ascii` | `--ascii` | `JEVCODE_ASCII` | — (`ignored:launch`) | auto (`TERM=dumb`, `TERM=linux`, non-UTF-8 locale) | A90; **launch** (the first frame's rule row already uses the glyph table) |
| `ui.title` | `--title` | `JEVCODE_TITLE` | `title` | `false` | OSC 2 opt-in |
| `ui.screenReader` | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | — (`ignored:launch`) | `false` | `=0` overrides; **launch, fixed at mount** (`isScreenReaderEnabled`) |
| `ui.reducedMotion` | `--no-animation` | `JEVCODE_REDUCED_MOTION` | `reducedMotion` | `false`; `true` under SR | A96 |
| `ui.notify` | `--notify` | `JEVCODE_NOTIFY` | `notify` | `false`; `true` under SR | BEL/OSC per terminal (§14.1) |
| `ui.osc52` | `--osc52` | `JEVCODE_OSC52` | `osc52` | `false` | write only |
| `ui.history` | `--no-history` | `JEVCODE_NO_HISTORY` | `history` | `true` | never for bench/perf |
| `ui.noInput` | `--no-input` | `JEVCODE_NO_INPUT` | — | `false` | plain renderer; wizard/trust/follow-up/secret/review take safe defaults |
| `ui.trustWorkspace` | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | — | `false` | scripts only |
| `ui.budgetWarnings` | `--no-budget-warnings` | `JEVCODE_BUDGET_WARNINGS` | `budgetWarnings` | `true` | mutes toast and bell only |
| `ui.allowSecretMention` | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | — | `false` | per-mention `y/N` |
| `ui.exitCode` | `--exit-code zero\|last-run` | `JEVCODE_EXIT_CODE` | `exitCode` | `zero` | session mode |
| `ui.keybindings` | `--keybindings <file>` | `JEVCODE_KEYBINDINGS` | `keybindings` | `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` | `namespace:action`, `"none"`, chords 3 s, reserved Ctrl+C/D/M/[/I (A24, F14) |
| `ui.noColor` | `--no-color` | `NO_COLOR` (→ `FORCE_COLOR=0` in the launcher) | — | terminal | A83 |
| `log.file` | `--log <file>` | `JEVCODE_LOG` (`JEVCODE_TRACE` = alias at level `trace`) | `log` | `<runDir>/jevcode.log` | fallback `~/.jevcode/logs/` |
| `log.level` | `--log-level <l>`, `--verbose` (= `debug`) | `JEVCODE_LOG_LEVEL` | `logLevel` | `info` | file only |
| `session.spendCapUsd` | `--session-spend-cap <usd\|none>` | `JEVCODE_SESSION_SPEND_CAP_USD` | `sessionSpendCapUsd` | `5 × limits.spendCapUsd` (source `derived`) | `none` = +∞ |
| `limits.spendCapUsd` | `--spend-cap <usd>` | `JEVCODE_SPEND_CAP_USD` | `spendCapUsd` | `2.00`; `0.25` when `--mode jev-only` | mode-keyed after `--mode` (P45) |
| `limits.allowUnpriced` | `--allow-unpriced` | `JEVCODE_ALLOW_UNPRICED` | `allowUnpriced` | `false` | A135 |
| `limits.maxGeneratorTokens` | `--max-generator-tokens <n>` | `JEVCODE_MAX_GENERATOR_TOKENS` | `maxGeneratorTokens` | `spendCapUsd / 15 × 1e6` (derived) | only under `allowUnpriced` |
| `generator.priceCacheReadPerM` / `…WritePerM` | — | `JEVCODE_PRICE_CACHE_READ_PER_M` / `_WRITE_PER_M` | `priceCacheReadPerM` / `priceCacheWritePerM` | `0.1 ×` / `1.25 ×` input (derived) | source column says `derived` |
| `update.notify` | `--update-notify` | `JEVCODE_UPDATE_NOTIFY`, `NO_UPDATE_NOTIFIER` | `updateNotify` | `false` | post-run only (A70) |
| `session.continue` / `run.resume` / `session.list` | `-c`/`--continue`, `--resume <id\|title>`, `--list-sessions` | — | — | — | `chat` and `run` |
| `configFile` | `--config <file>` | `JEVCODE_CONFIG` | — | `./jevcode.json`, else `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`, legacy `~/.config/jevcode/config.json` checked | XDG preferred, warn once (P30) |

Pending `/budget spend-cap`, `/model`, `/provider`, `/mode` values are memory-only (not settings). `jevcode config --json` includes `sandboxLevel`, `ui`, `session` with `source: 'derived'` on derived rows.

## 17. Packaging and release (A65–A72, F15, D14; documented and prepared, not published)

1. `package.json`: remove `"private": true`; `engines.node` → `>=22.12.0` (the `<27` upper bound is dropped: the tap's `depends_on "node"` follows Homebrew's current node — 26.x today, 27 next — and an engines mismatch for brew users is the worse failure, P28); `dependencies: {}` (ink/react → `devDependencies`, inlined by esbuild; P26); `files: ["bin/jevcode.js", "dist/jevcode.mjs", "dist/THIRD_PARTY_LICENSES.txt", "man/jevcode.1", "README.md", "LICENSE"]` (no `.map`, `meta.json`, `docs/`); `man`; `publishConfig: { access: 'public', provenance: true }`; `repository`; `prepublishOnly` refuses a publish outside CI; commit `LICENSE` (MIT; `license` already says MIT).
2. `scripts/build.mjs`: `minify: true` + `keepNames: true` (P27); `define: { __JEVCODE_VERSION__: JSON.stringify(pkg.version) }`, read **only** through `src/version.ts` — `declare const __JEVCODE_VERSION__: string | undefined; export const VERSION = typeof __JEVCODE_VERSION__ === 'string' ? __JEVCODE_VERSION__ : readPackageVersion()` (the fallback reads the `package.json` next to the module once) — so `npm run dev` (tsx) and every vitest engine test, where the identifier is undefined, never throw `ReferenceError`; `main.tsx` and `RunMeta.versions.jevcode` (`engine.ts:1613`) import `VERSION`; `dist/THIRD_PARTY_LICENSES.txt` generated by `scripts/licenses.mjs` from `result.metafile.inputs` (package name, version, `LICENSE*` text) because `legalComments` is `'none'`; `sourcemap` kept locally, excluded from the tarball; smoke step kept plus `chat --perf-exit-after-first-frame` and `node bin/jevcode.js --version --json`.
3. `bin/jevcode.js`: Node ≥ 22.12 guard, `NO_COLOR` shim, compile cache, no-network interceptor (all present); `--version [--json]` and `--help` answered in `main.tsx` before any Ink import (already: Ink is a dynamic import); `--version --json` → `{ "name": "jevcode", "version": "<v>", "node": "<v>", "ink": "7.1.1", "react": "19.3.0", "bundle": "<path>" }` (the two inlined runtime dependencies of item 1 are named).
4. `jevcode completion bash|zsh|fish` prints a **static** script generated from `FLAGS` + `COMMANDS` by `scripts/gen-docs.mjs` (run-id completion by a shell-side `ls $JEVCODE_HOME/runs`); destinations printed, never written. `man/jevcode.1` from the same table.
5. `jevcode upgrade [<version>|latest|next] [--check] [--method]` delegates to the detected manager from `realpath(process.argv[1])` (npx → nothing; brew; bun; pnpm; yarn; else `npm install -g jevcode@<v>`, never `npm update -g`); 2 s registry timeout; exit 0/2/5/6.
6. Notifier off by default; when on, a detached `unref()`'d `jevcode upgrade --check --write-cache` after `run:end` writes `${XDG_CACHE_HOME:-~/.cache}/jevcode/update-check.json`, read after the first frame next time; suppressed under `CI`, `NO_UPDATE_NOTIFIER`/`JEVCODE_NO_UPDATE_CHECK`, non-TTY, npx, < 24 h.
7. Homebrew tap `Formula/jevcode.rb` in the Node-formula shape (`depends_on "node"`, `std_npm_args`, `bin.install_symlink libexec.glob("bin/*")`, `generate_completions_from_executable(bin/"jevcode", "completion")`, `man1.install "man/jevcode.1"`); the release job rewrites `url`/`sha256` and asserts that the formula's node major (`brew info --json=v2 node`) satisfies `package.json` `engines`; no homebrew-core submission until notability is verified (C13).
8. CI gates: `test "$(npm pkg get private)" = "{}"`, `npm pack --dry-run --json` file list equals the `files` allowlist and the tarball is < 1.5 MB, `tar tzf` shows no `.map`/`.env`/`docs/`, `--version` smoke, `THIRD_PARTY_LICENSES.txt` non-empty, `docs/KEYS.md`/`docs/COMMANDS.md` regenerate cleanly; publish job on **Node 24 (≥ 24.5.0)** with `npm --version ≥ 11.5.1` asserted and `id-token: write` trusted publishing (P69); `.nvmrc` stays 22.23.2 for tests; dist-tags `next` for pre-releases, `latest` after the bench/perf gates (P31); GitHub Release with tarball + `SHA256SUMS`; per-version CHANGELOG.
9. Windows documented: TUI in ConPTY terminals with `--sandbox none`, sandboxed runs via WSL 2, ACL note instead of chmod.

## 18. Performance plan (F18, A103, A107, DESIGN §12)

| Gate | Threshold | How measured | Script |
| --- | --- | --- | --- |
| First frame, `chat` and `run` | cold p95 < 300 ms incl. the composer frame; zero network | `script -q /dev/null sh -c 'stty rows R cols C; exec node bin/jevcode.js chat --perf-exit-after-first-frame'` at 40×120, 24×80, 8×40 with `JEVCODE_ASSERT_NO_NETWORK=1`, `JEVCODE_HOME` non-existent (the index fold must not run before the frame), unreadable `--config`; sentinel `step 0/` in the accumulated bytes; the breakdown gains a module-evaluation row (bundle import → first `render()`), so an eager `Intl.Segmenter` or similar singleton is visible | `src/perf/first-frame.ts` gains the `chat` series |
| Composer keystroke → frame | p95 < 16 ms in a real pty at the A109 region (rows 24: pane 12 + live 2 + queue 2 + composer 6); also with a 6-row draft, with the palette open and with a review pending | Python `pty.fork` driver writes 500 printable bytes with timestamps at **≥ 100 ms spacing** (10 cps) over a 2,000-char draft; latency = write → first frame (`ESC[?2026l`) containing the grapheme. At ≥ 100 ms Ink's throttle (`maxFps` 30 → `renderThrottleMs` 34, `throttle(…, { leading: true, trailing: true })`, `ink.js:194–208`) renders every key on its leading edge, so the number measures the composer, not the throttle — provided no other frame opened a window: a spinner (8 fps) or 1 Hz tick frame drawn < 34 ms before the key made the key wait for the trailing edge (every 5th key live, every 10th idle; found 2026-09-21 once `<Transcript>` was memoised — TUI-DESIGN-2 D-F). Since D-F a key's commit re-renders `<Static>` with a fresh `style`, Ink's `isStaticDirty → onImmediateRender` path, so key frames are synchronous regardless of the spinner/tick phase; a 30 ms burst pays up to one throttle period by design (a key arriving < 34 ms after a render waits for the trailing edge — with 30 ms spacing every second key waits ≈ 30 ms) and is therefore reported, not gated, as a second series (`burst30`; its `dynamic` frame rate is gated, see "Frame rate"). The `live` series runs at `JEVCODE_MOCK_STEP_MS=200` (gated); a `live-stress` series at 0 ms is reported | `src/perf/composer-latency.ts` + `perf/drivers/pty_type.py` |
| Event-loop lag while typing during a live mocked run | lag p95 < 5 ms, max < 50 ms at the **realistic step rate**: `JEVCODE_MOCK_STEP_MS=200` (`src/cli/mock-trajectory.ts`: every mocked generator turn takes 200 ms, the mock decider answers at once → about 5 steps/s, still ten times faster than a real run, whose steps take 2–10 s). The zero-latency mock (≈ 35 steps/s, ≈ 460 committed `<Static>` rows/s — 50–100× any real run) is measured as a `stress` row and **reported, not gated**: its lag p95 of 5.3–5.8 ms (2026-09-21) is what a transcript-commit storm costs, not a budget a real run meets. The probe (`--perf-lag-probe`, a 10 ms `setInterval` recording `max(0, actual − 10)`) has a **floor**: in an idle Node process on macOS it reads about 2 ms per tick with nothing blocking — the kernel coalesces the kevent timeout libuv waits with (`kern.timer.coalescing_enabled`; a bare idle `node` measured p50 1.83 / p95 2.08 / max 2.71 ms on 2026-09-21, a loop kept spinning by a 1 ms interval 0.34 ms) — and a run paced at 5 steps/s idles between steps while the storm never does (realistic p50 2.03 ms, storm 0.65 ms). Each run therefore measures the floor with the identical probe in a bare idle `node` for the length of a typing window (`render-lag.ts` `measureLagBaseline`) and the gate applies to the **p95 net of the floor's median**; raw, floor and net are all reported, and when the floor itself reads ≥ 5 ms (a noisy machine) the raw p95 is gated. `renderTime` is not measured (the App registers no `onRender` callback) | `render-lag.ts` with the Python typist (10 keys/s, 150 keys) at rows 40, rows 12 and rows 40 under `--no-animation`, 120 columns, each at `JEVCODE_MOCK_STEP_MS=200`, plus rows 40 at 0 ms; the child's 10 ms `setInterval` probe (`--perf-lag-probe`) covers the whole session after a 500 ms warm-up | `src/perf/render-lag.ts` |
| Zero clears | 0 matches of `CLEAR_RE` (the three-way alternation given verbatim below this table — a JavaScript regex literal, where a backslash-pipe would be a literal pipe and match nothing) after the first frame, **asserted per geometry segment** (the bytes between two `resize` steps): a segment that begins with a *shrink in rows* may hold **≤ 1 clear** — one Ink `clearTerminal` write, `ESC[2J ESC[3J ESC[H`, which is **two** `CLEAR_RE` matches, so a per-segment count collapses a `2J` immediately followed by `3J` into one clear — because Ink's log-update cannot erase a previous frame taller than the new terminal line by line (research 20 §1); the renderer's `resize` listener (registered before Ink's) commits the shrunk budget synchronously (`instance.rerender()`, `App.tsx` mount) before Ink's own `resized` repaint, so the stale taller tree is never painted at the new viewport and a second clear never follows (measured 2026-09-21: 1 per shrink with the pane open at 40×100 → 12×60, `test/pty/run-smoke.sh resize-live`); every other segment, including every one that begins with a grow or a width-only change, holds 0; the script self-tests `CLEAR_RE` first — it must match `\x1b[2J`, `\x1b[3J`, `\x1bc`, `\x1b[?1049h` and not `\x1b[2K` — and fails if the self-test fails at every geometry and state (review, palette, picker, wizard, secret row, retry row, blocking, resize 40→12→40, `JEVCODE_FAULT=render:pane`) | pty captures | `render-lag.ts` regex extended; `src/perf/states.ts` drives each overlay with `JEVCODE_FAULT`/mock hooks |
| Frame rate | the frames of the busiest one-second bucket of the typing window are split into three classes (`src/perf/pty.ts` `classifyFrame`): **`static`** — a frame carrying new `<Static>` rows. Ink 7.1.1 renders a commit that changed the `<Static>` subtree immediately (`ink/build/reconciler.js` `resetAfterCommit`: `isStaticDirty` → `onImmediateRender`, which `ink.js` binds to the raw `onRender`, while every other commit goes through `throttle(onRender, renderThrottleMs, { leading: true, trailing: true })`), so one committed transcript item costs one frame **by design** and the static rate is the item commit rate. **`key`** — a frame within one throttle period (`ceil(1000 / maxFps)` = 34 ms at 30) after a keystroke: the throttle's leading-edge render of the key, which follows the offered key rate by design (10/s in the lag runs, 33/s in `burst30`). **`dynamic`** — the rest (spinner, 1 Hz clock, live flush, status-line and pane changes): the frames the `maxFps` throttle governs. Gate: **`dynamic` ≤ maxFps + 1** (31) at the realistic step rate at every geometry, reduced motion included — the earlier "≤ 4/s in reduced motion" is the 250 ms live-flush cadence (`App.tsx` `flushMs`), asserted in unit tests; a live run cannot separate flush frames from the state-change repaints of 5 steps/s — and in the composer `live` and `burst30` series; `static` and `key` are reported; the stress row reports all three; the retry row is not driven (`JEVCODE_FAULT=jev:429` is not implemented) | count `ESC[?2026h` per second bucket, each frame classified from the typist's chunk timestamps and `send` records | `src/perf/pty.ts`, `src/perf/render-lag.ts`, `src/perf/composer-latency.ts` |
| Cursor and hide/show | counted **per frame** (each `ESC[?2026h`…`ESC[?2026l` block): at most one `ESC[?25l`, and whenever the composer is active the frame ends with `ESC[?25h` (Ink's `buildReturnToBottomPrefix`/`buildCursorSuffix` hide and re-show on every changed frame once `useCursor` sets a position); a cursor-only frame writes only `hide + return + move + show` (`log-update.js:36`); the final byte state is cursor-shown. Today's "exactly one per run" figure came from cursor-less monitor captures and cannot hold with `useCursor` | pty bytes | `render-lag.ts` |
| Static microbenchmark | re-run 08 §11's append benchmark at the A109 region (22 rows) and with a review pending; report only (≤ 1,600 B/keystroke expected at 24×80) | ink-testing-library fake TTY | new `src/perf/static-append.ts` |
| Ctrl+L repaint | the frame bytes after Ctrl+L equal the frame before it; 0 clears; one erase-lines + rewrite inside one BSU/ESU pair | pty bytes | `src/perf/states.ts` |
| Fuzzy scorer | p95 ≤ 16 ms per keystroke over 5,000 candidates | vitest | `test/unit/tui/commands/fuzzy.test.ts` |
| Layout and rows | `computeLayout` ≤ 5 µs; `layoutRows` of a 12,000-char draft ≤ 2 ms | vitest micro-benchmarks | `test/unit/tui/layout/layout.test.ts`, `test/unit/tui/composer/rows.test.ts` |
| Index fold | ≤ 2 ms at 1,000 runs, ≤ 15 ms at 10,000; folded once per open/`run:end` | vitest | `test/unit/session/index.test.ts` |
| Harness overhead | `harnessMs` p95 < 50 ms per step unchanged with pre/post images (streamed hashing, 16 MiB cap) and `planAfter`; `imagesMs` p95 reported from `StepTiming.imagesMs` against a 15 ms target — a report row, not a gate (the copy is awaited inside `runStep()`, D8, so it is already inside the gated `harnessMs`) | existing `harnessMs` gate (images are awaited inside `runStep()`, so the gate sees them) plus the `imagesMs` series; the fixture adds `run` steps with 50 dirty files totalling 15 MiB (the worst in-cap case) and one 60 MiB artefact that must produce `hashSkipped: true` without stalling | `src/perf/step-overhead.ts` |

```ts
// src/perf/render-lag.ts — the clear-detection regex (review finding 9: the earlier draft wrote the alternation as an escaped `\|`, a literal pipe in a JS regex literal)
export const CLEAR_RE = /\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?1049[hl]/g;   // ESC[2J, ESC[3J, ESC c (RIS), alt-screen enter/leave
// self-test run before any gate: ['\x1b[2J', '\x1b[3J', '\x1bc', '\x1b[?1049h'].every((s) => CLEAR_RE.test(s)) && !CLEAR_RE.test('\x1b[2K')  (lastIndex reset between calls)
```

All perf runs use `NODE_ENV=production` and an env without `CI`; the live-run probes set `JEVCODE_MOCK_STEP_MS` explicitly (200 for the gated rows, 0 for the stress rows; unset it is 0, today's zero-latency `--mock` everywhere else); results go to `perf/results/latest.json`; `npm run perf` fails on any gate.

## 19. Testing plan (A102–A108, F18)

### 19.0 Module → test file → what it asserts (F18: every new module unit-tested offline; CI gate: every `src/**` file added by §20 has a matching `test/unit/**` file, checked by a sync test like the KEYS.md/COMMANDS.md one)

| Module (§20 owner) | Test file | Asserts |
| --- | --- | --- |
| `src/tui/layout.ts` (O3) | `test/unit/tui/layout/layout.test.ts` | §2.1 invariants exhaustively; every §2.2 cell; every fenced frame of this document (width ≤ W, dynamic rows = caption); `≤ 5 µs` |
| `src/tui/keys/{resolve,interrupts}.ts` (O3) | `test/unit/tui/keys/{resolve,interrupts}.test.ts` | every §3.3 cell with injected clocks; S4 empty → `ABORT_REVIEW`, S4 text → `CLEAR_DRAFT`; Esc re-buffer 30 ms; `d p t s` insert text |
| `src/tui/keys/{bindings,keybindings-file}.ts` (O3) | `test/unit/tui/keys/bindings.test.ts` | `KEY_ACTIONS` ↔ `docs/KEYS.md`; reserved keys refused; chords 3 s; `"none"` unbinds; unknown ids warn |
| `src/tui/commands/{parse,registry,dispatch}.ts` (O3) | `test/unit/tui/commands/{parse,registry,dispatch}.test.ts` | grammar errors; `ArgSpec` validation; `availableDuringTask` errors; registry ↔ `docs/COMMANDS.md` |
| `src/tui/commands/fuzzy.ts` (O3) | `test/unit/tui/commands/fuzzy.test.ts` | orderings; p95 ≤ 16 ms over 5,000 candidates; subsequence property |
| `src/tui/composer/submit.ts` (O3) | `test/unit/tui/commands/submit.test.ts` | `/foo` never submits; `//`; empty trim; missing chip cancels; hit → gate; live → steer vs idle → submit; held until the host attaches |
| `src/tui/composer/{buffer,killring,history,filter,paste}.ts` (O2) | `test/unit/tui/composer/{buffer,killring,history,filter,paste}.test.ts` | A105 vectors; kill ring 16; history cap/dedupe/redaction/cleared-draft; CSI/OSC leak filter; chip thresholds, 1 MiB refusal, `fp8` only |
| `src/tui/composer/{width,eaw-table,rows}.ts` (O2) | `test/unit/tui/composer/{width,rows}.test.ts` | 400 `string-width` fixtures; `layoutRows`/`cursorToRowX`/`maskSpans` keep widths; 12,000 chars ≤ 2 ms |
| `src/tui/review/lines.ts` (O4) | `test/unit/tui/review/lines.test.ts` | `reviewHeaderLines(req, n, columns)` n = 2..8 at 80/120; digits stable; max-first compact rows (2 at 80, 3 at 120); `matchesIntent` null row |
| `src/tui/pane/*.ts`, `src/tui/bars.ts`, `src/tui/glyphs.ts` (O4) | `test/unit/tui/pane/{model,decisions,plan,timeline,synth,banner,bars}.test.ts` | `toDecisionRow` (`consumedBy`, `near`); every tab at 59/80/120; side-by-side only under the §7.2 rule; `eighthBar` cells width 1; ASCII/SR twins |
| `src/tui/why.ts`, `src/tui/calibration.ts` (O4) | `test/unit/tui/pane/{why,calibration}.test.ts` | worked `/why` text; 50-run / 32 MB cap; label sources; ECE bins |
| `src/tui/status/lines.ts`, `src/tui/toasts.ts` (O5) | `test/unit/tui/status/{lines,toasts}.test.ts` | drop order at 40/60/80/100/120/140/160; centre only with ≥ 24 free cells; meter words; toast queue ≤ 4, error pre-emption, 2 s/4 s |
| `src/tui/useGitHead.ts` (O5) | `test/unit/tui/status/git-head.test.ts` | detached / packed-refs / unborn / symbolic ref parse; `HEAD`-only filter; 100 ms debounce; watch error → frozen value; zero spawns |
| `src/workspace/gitstate.ts`, `src/workspace/git.ts` (O5) | `test/unit/workspace/{gitstate,status-v2,restore}.test.ts` | seven repo shapes incl. `PATH` without git and timeout; exactly two `execFile` calls; ten porcelain-v2 line kinds; `restoreFromHead` never runs `checkout --` |
| `src/workspace/files.ts` (O5) | `test/unit/workspace/files.test.ts` | zero spawns with `gitState` given; standalone `listCandidates` without a sandbox; `readSecretForMention` denylist |
| `src/sandbox/{paths,seatbelt,run}.ts` (O5) | `test/unit/sandbox/{paths,seatbelt,run}.test.ts` | `isMentionDenied`; profile with `gitCommonDir` outside ws; `configDirs` under `XDG_CONFIG_HOME=/tmp/x`; main-tree snapshot unchanged; hash includes the new options |
| `src/session/{index,lock,seed,export,picker-lines}.ts` (O6) | `test/unit/session/{index,lock,seed,export,picker}.test.ts` | fold rules, torn lines, 512-byte cap; lock alive/dead/other host; `buildSeed` + seed-source rule + pending steers carried; export 64 MiB cap, headers, no local items; picker rows |
| `src/spend/meter.ts`, `src/tui/budget/lines.ts` (O6) | `test/unit/spend/{meter,budget-lines}.test.ts` | `setCap` observed by a live child; `parent` spread only when present; `/resume` child-cap order; thresholds; meter words |
| `src/config/{launch,ui,resolve,validate,defaults}.ts` (O6) | `test/unit/config/{launch,ui,resolve,validate,defaults}.test.ts` | `resolveLaunchSettings` pure (flag > env > default, SSH 15, clamp 5..30); `ignored:launch` source for a file key; full chain for session settings; `missingSecrets`; `sessionSpendCap` derivation; `priced` fail-closed; `configDirs` |
| `src/core/redact.ts` (O7) | `test/unit/core/redact.test.ts` (moved from `test/unit/config/`) | families incl. warn-only; FP survivors; 256 KB < 5 ms; `dropSecret`; PEM end-anchored form |
| `src/core/log.ts` (O7) | `test/unit/core/log.test.ts` | levels; 250 ms buffer; warn+ synchronous; 8 MiB rotation; a key never appears; fallback dir; `console.*` routed |
| `src/tui/onboarding/{reducer,lines}.ts` (O7) | `test/unit/tui/onboarding/{reducer,lines}.test.ts` | state machine; the reducer never holds a key; ≤ 4 rows; masked field twins |
| `src/tui/secrets/{gate-lines,clipboard}.ts` (O7) | `test/unit/tui/onboarding/{gate-lines,clipboard}.test.ts` | gate strings singular/plural/exact; native tool order, 2 s timeout, OSC 52 wrapper (tmux DCS), 64 KiB cap, never OSC 52 read |
| `src/config/{credentials,trust,instructions}.ts` (O7) | `test/unit/config/{credentials,trust,instructions}.test.ts` | merge + atomic 0600 write, XDG vs legacy, warn once; sha256 re-prompt, `$HOME` never persisted; walk-up, `CLAUDE.md` fallback, 32 KiB cap, record |
| `src/cli/login.ts` (O7) | `test/unit/config/login.test.ts` | `--*-stdin` paths; secret settings refused as arguments |
| `src/checkpoint/images.ts` (O8) | `test/unit/checkpoint/images.test.ts` | pre/post layout; streamed hashing with the 16 MiB cap and `sha256: null`; `imagesMs`; `dirs.json` |
| `src/checkpoint/store.ts` (O8, edit) | `test/unit/checkpoint/store.test.ts` (extended) | `writeUi`; `updateMeta({ git })`; `classifyDiskError`; `CHECKPOINT_FILES.drafts` |
| `src/undo/{plan,apply,diff,pager}.ts` (O8) | `test/unit/undo/{plan,apply,diff,pager}.test.ts` | decision table incl. staged-then-modified and HEAD-moved; numstat parsing; pager selection (`GIT_PAGER=cat`, `LESS` untouched when set) |
| `src/cli/epilogue.ts`, `src/cli/fatal.ts` (O8) | `test/unit/cli/epilogue.test.ts` | `epilogueLines` per situation; a canary in the thrown message is redacted; `RESTORE` written before the epilogue (spy order) |
| `src/tui/PaneBoundary.tsx`, `src/tui/blocking/lines.ts` (O8) | `test/unit/tui/pane-boundary.test.tsx`, `test/unit/tui/pane/blocking.test.ts` | one pane degrades; a failed review declines; blocking rows at 2..4 |
| `src/tui/terminal.ts` (O9) | `test/unit/tui/terminal.test.ts` | `RESTORE` bytes; `restoreTerminal` written once across `fatalExit` + `unmount` + `exit`; resize 50 ms debounce; suspension queue flush order |
| `src/tui/notify.ts` (O9) | `test/unit/tui/notify.test.ts` | BEL / OSC 9 / OSC 99 / tmux DCS payload; never starts `<digit>;`; timers 6 s / 60 s, keystroke restart |
| `src/tui/spinner.ts`, `src/tui/retry.ts` (O9) | `test/unit/tui/spinner.test.ts`, `test/unit/tui/retry.test.ts` | 8 fps only while a stage runs and no review pending; frozen under reduced motion; 1 Hz tick cleared on `retry:settled` |
| `src/tui/theme.ts`, `src/tui/color-shim.ts` (O9) | `test/unit/tui/theme.test.ts` | `colorEnabled()` precedence; daltonized swap; `ansi` no dim; shim sets `FORCE_COLOR=0` |
| `src/tui/useEngine.tsx` (O9) | `test/unit/tui/reducer.test.ts` (extended) | one test per row of the item 20 transition table; `run:start` resets `done` |
| `src/tui/{App,Composer,Overlay,Review,Pane,Picker,Wizard,MaskedField}.tsx` (O9) | `test/unit/tui/{app,composer,overlay,review,pane,picker,wizard}.test.tsx` | §19.3 |
| `src/cli/session.ts` (O10) | `test/unit/cli/session.test.ts` | host wiring (`addSecret` before `submit`/`steer`); `note()` routing; `/resume` fold + child cap; `blocker` answers; `exit` hook; `run:end` with `signal` exits |
| `src/cli/json-stream.ts` (O10) | `test/unit/cli/json-stream.test.ts` | envelope; `session:*`/`ui` lines; every line parses; no `status` |
| `src/cli/{completion,upgrade,report,sessions}.ts` (O10) | `test/unit/cli/{completion,upgrade,report,sessions}.test.ts` | static scripts from `FLAGS`; manager detection, 2 s timeout, exit codes; bundle contents redacted; `reindex`/`unlock`/`prune` |
| `src/tui/plain-composer.ts` (O10) | `test/unit/tui/plain-composer.test.ts` | `terminal: false`; SIGINT matrix; `close` = Ctrl-D rule; secret gate; steer while live |
| `src/version.ts` (O1) | `test/unit/loop/version.test.ts` | fallback when the define is absent; equals `package.json` version |

### 19.1 Pure units (vitest `unit`, ink-free, offline)

`computeLayout` invariants exhaustively over rows 2..60 × columns 20..400 × every `OverlayKind` × wants 0..12, plus every §2.2 cell as `it.each`; `reviewHeaderLines(req, n, columns)` for n = 2..8 at 80/120 (digit stability, max-first compact rows); `resolveKey`/`reduceInterrupts` over every cell of §3.3 with injected clocks (1.5 s / 2 s / 800 ms / 30 ms boundaries); `reduceBuffer` unit vectors (A105: split CSI, `ESC`+`x` at 5/25 ms, `\r\n\t` pastes, 64 KB paste, Ctrl+D empty/non-empty, `0x1a`, kitty `13;2u`, xterm `27;2;13~`, `[I`/`[O`, `[?0u`, `[?62;22c`, OSC 11 replies in both bit depths, SGR mouse noise, OSC fragments); `cellWidth` vs `string-width` fixtures (400 strings); `layoutRows`/`cursorToRowX`; `parse.ts` grammar (quotes, escapes, errors, unknown command never submits); `submit.ts` routing (`test/unit/tui/commands/submit.test.ts`); every §24 string as a shared-`lines()` parity fixture diffed across the three writers (labels `[ui]`/`[setup]`/`[config]`/`[sandbox]` via `TranscriptItem.label`, engine items via `stepLabel()`); `fuzzy.ts` ranking + timing + the subsequence property; `registry.ts` sync test against `docs/COMMANDS.md`, `KEY_ACTIONS` against `docs/KEYS.md`; `detectSecrets` (families, FP survivors of 16 §1.1, 256 KB < 5 ms); `toDecisionRow` (`consumedBy`, `near`); `whyBlock`/`calibrationBlock` over fixture `decisions.jsonl`; `buildSeed` + the seed-source rule; `foldIndex` (torn lines, duplicate `run:end`, rename after end, legacy runs, 512-byte cap, redaction of `task60`); `history` cap/dedupe/redaction/cleared-draft rule; `statusLineText` at 40/60/80/100/120/140/160 (drop order); pane `lines()` for every tab at 59/80/120; `budget-lines` thresholds (34/4/1 fixture) and the meter words; `createSpendMeter` `setCap`/`parent`; `statusPorcelainV2` (ten line kinds, `(initial)`, `(detached)`, `S.M.`, torn output); `probeGitState` across seven repo shapes incl. `PATH` without git; `images.ts` + the undo decision table incl. staged-then-modified and HEAD-moved; numstat parsing (`-\t-\t` binary, NUL renames, empty-tree base); pager selection (`GIT_PAGER=cat`, `LESS` untouched when set); `exitCodeFor(reason, error, degraded)`; onboarding reducer never holds a secret; `missingSecrets`; `sessionSpendCap` derivation; `epilogueLines`; `JsonStreamLine` envelope; `checkBudgets` with `token_cap`; `redactDeep` of every new event; source scans: no `process.stdout.rows/columns` outside `plain.ts`, no `setInterval(` outside `spinner.ts`/`retry.ts`, no `useFocus`; **a width/row test over this document's fenced frames** (captions `W×H (D dynamic rows[; S scrollback rows above])` or `(N of D dynamic rows shown)`; every row ≤ W cells by `string-width`; row count as captioned).

### 19.2 Property tests (A106)

mulberry32-seeded fuzzer over `{ insert(g ∈ pool of ASCII, CJK, emoji, combining), paste(\r\n text), move*, kill*, yank, yankPop, undo, redo, history, chip, raw parse-keypress sequences }` with `Intl.Segmenter` as the oracle: cursor on a grapheme boundary; `text === graphemes.join('')`; no control chars; `insert`+`backspace` and `kill`+`undo` identities; chips atomic; paste = one undo step; `width(row) ≤ columns` and the rendered cursor equals the summed widths; render is a pure function of `(text, cursor, columns)`; `computeLayout` invariants over random inputs; `score(q, c) !== null ⇔ q is a case-folded subsequence of c`; any redacted index line ≤ 512 bytes or dropped; 1,000–5,000 iterations, < 2 s per file, shrink by prefix replay, seed printed on failure.

### 19.3 ink-testing-library (`StubStdout(rows, columns)` extracted from `test/unit/tui/height.test.tsx:16` into `test/unit/tui/stub-stdout.ts`)

Every §2.2 state at rows 8/12/24/40/50 × columns 40/80/120: `dynamicRegion(frame).length ≤ rows − 2` and equal to `computeLayout(...).total`; review keys (`y` → `approved: true`; `n`/Esc → false; Enter inert; typed-ahead `y` during the deferral lands in the draft; the review context arms one frame after the box; a paste never matches; a second request declines the first; Ctrl-C with an empty draft calls `host.abort` and never `resolveDetailed` — the confirmer's promise rejects through the engine signal — while Ctrl-C with a draft clears the draft and keeps the box); `d` note path through the gate to `resolveDetailed`; secret gate (`y` on the armed frame sends and `host.addSecret` was called before `host.submit`/`host.steer` for every span — an `sk-ant-` canary, an AWS `AKIA…` key and a PEM body alike; a `y` in the Enter's input chunk or within 150 ms is text; Enter dismisses; Ctrl-C clears the draft to history with `[REDACTED:draft]`; the composer row shows `•` cells over the span, `test/unit/tui/composer-secrets.test.ts`); follow-up box (Enter inert; `y` clamps; `r` prefills); steer queue (Enter while live → `steer`; Up takes back; 9th refused); palette (exact match runs; typo keeps the draft); picker keys incl. Ctrl-R rename and `x`+`y`; wizard masked field (zero key bytes in every frame, no `<Static>` item with the key, `addSecret` before the item); resize (`stdout.emit('resize')` 40 → 12 → 40 keeps draft and cursor); `PaneBoundary` fallback per pane with `JEVCODE_FAULT=render:<pane>` (a failed review declines; a failed composer still accepts keys); retry row + 1 Hz tick cleared on `retry:settled`; toasts; `<Static>` item identity vs `--plain` output for the same event list, `notice { kind: 'ui' }` lines included, with idle-time `local` items present in both and absent from the transcript writer; screen-reader twins with `isScreenReaderEnabled: true` (a draft beginning with `1`/`y` when the review arms is stashed and cannot answer; only an exact `1`/`2`/`3`/`y`/`n` line typed after arming answers); 0×0 stdout → rule width 80; `renderToString` snapshots (dynamic region only, normalised serializer: SGR stripped, spinner → `⠿`, durations → `<t>`, run ids → `<id>`, money → `<$>`) at 40/80/120.

### 19.4 Engine and session integration (mock provider + decider; `test/unit/loop/engine-session.test.ts`, `test/unit/session/*.test.ts`)

`steer` → `pendingDirectives` in the next checkpoint (masked on disk, raw in memory); **eight** queued steers → `applyPendingDirectives` puts eight `human` problems into `plan.harnessProblems` (seed problems with `step: 0` untouched), eight hint lines, `state.human.directives.length === 8` and a `\n\n`-joined `SynthesisContext.directive`, resets loop counts, notes the superseded problems; a `y`-acked steer reaches the mock provider unmasked while `steps.jsonl`/`state.json` carry `[REDACTED:composer#1]`; after a rule-1 discard and `--resume` the hint, `state.human` and the synth directive re-arm from `harnessProblems`; `pause` → `human_pause` after the in-flight step commits, `--resume` proceeds; seed application and the step-1 rule (b) drop; `planAfter` recorded; `confirmDetailed` note reaches `WindowEntry.notes` and the declined reason; `retry` events forwarded, `retryNow()` ends exactly one sleep per press (two presses in one 3-attempt chain; no spin afterwards); `workspace` event after `run:ready`; `budget:warn` once per threshold per scope (session scope via `snapshot.parent`), highest only, `restored` on resume; `setCap` observed by a live child; `/resume` fold excludes the resumed run and the child cap is computed before the resumed spend is added (cap $10, earlier runs $8.00, resumed $1.50 of $2.00 → child cap $2.00, never $0.50); `token_cap` incl. `generatorTokens` rebuilt on resume and `storedStopBlocks` refusing until raised; unpriced refusal; pre/post images written before `state.json` (spy order) with `imagesMs` recorded inside `harnessMs`; the 16 MiB hashing cap (`hashSkipped`, `sha256: null`); `budget:clamp` emitted by the engine from `session.clamp` after `run:ready`; the blocker path (`retry`/`continue`/`stop`, the auto-retry timer, no-blocker default `'stop'`, `resumes` unchanged); Ctrl-C on a pending review → `counters.reviews === 0`, `state.interrupted.step === N`, window unchanged, `confirm:resolved aborted: true`, no `declined` step; exactly two spawns at run start (counter on `execFile`) and zero inside `createWorkspace` when `gitState` is given; a bench run's `run.json` has `source: 'bench'` and touches neither `index.jsonl` nor `history.jsonl`, a `--source perf` run has `source: 'perf'`; `buildSeed` carries the parent's `pendingDirectives` as step-0 problems; `/resume` after `/undo` passes `humanDirective` + `undoLog`; `run.lock` refusal and `sessions unlock`; `run:end` extension fields; the secret artefact sweep (an `sk-ant-` canary, an AWS `AKIA…` key and a PEM body — one redacting and two warn-only families — appear in no artefact — `transcript.log`, `steps.jsonl`, `run.json`, `state.json`, `state.prev.json`, `decisions.jsonl`, `jev.jsonl`, `generator.jsonl`, `history.jsonl`, `ui.json`, `jevcode.log`, `--plain` stdout, `--json` stdout, any frame — while the mocked provider received the raw canary and Jev's recorded state did not); `/undo` in a temp git repo (staged-then-modified, HEAD moved, created files, linked worktree on darwin); `--json` schema (every line parses, `schema` pinned, unknown-type tolerance); `--plain` parity line-for-line with `transcript.log` for the whole run (engine events replayed, `notice kind: 'ui'` from `annotate()` included; idle-time `local` items absent from every `transcript.log`); the jev-only checklist (§15.3).

### 19.5 pty suite (vitest project `pty`, `expect(1)`/`script(1)`, macOS, `CI` removed from the child env, `skipIf(!existsSync('/usr/bin/expect'))`; `stty` geometry set before the first frame; never `kill -WINCH`)

| Scenario | Assertion |
| --- | --- |
| `chat` first frame, then 200 chars + Enter under `--mock` | sentinel < 300 ms; `ESC[2J` = 0; composer echoes; run starts |
| Ctrl-C matrix walk (S0 hint → exit 0; S1 clear; S2 abort + reopen; S4 with an empty draft → abort with a rule-1 discard, S4 with a draft → the draft clears and the box stays; S6 second press exits 130 through the injected exit hook) | exit codes and bytes; `state.json` present after abort; no `declined` step in `steps.jsonl`; after the S6 exit `stty -a` shows `icanon echo` and the cursor shape is reset (`CSI 0 SP q` in the tail) |
| Esc pause / Esc Esc abort / Ctrl-D live box | `human_pause` in `state.json`; resume continues; `[y]` exits **0** while the `run:end` item says `exit 130`, `[n]` stays |
| `/exit` while live | `exitConfirm`, `y` → abort → `run:end` → exit 0 with a final `state.json` |
| Ctrl-Z through `bash -i` + `fg` | `ps` state `T`; `stty -a` cooked while stopped; raw again after `fg` and after the next keystroke; repaint; no checkpoint written by suspend |
| SIGHUP (close master) | exit 129; `state.json` written; no epilogue bytes |
| Resize storm 30 × `stty` 2 ms apart, 40 → 12 → 40, idle **and** with a live pane taller than 12 rows | one final layout; clears (one `clearTerminal` = `ESC[2J ESC[3J ESC[H` counts once, §18) per geometry segment: ≤ 1 in every shrink segment (40 → 12; research 20 §1 — the segment is delimited by a marker typed after the status line settled at the new width, never by a clock), 0 in every grow segment (12 → 40) and 0 before the first resize; region ≤ 10 rows at 12; draft intact |
| Review at rows 24, 12 and 8 | keys line present; a dimension row present at rows 8; `y` approves; `d` note reaches `transcript.log`; typed-ahead `y` never approves |
| 20 KB bracketed paste holding a `ghp_` token | chip label echoed; token bytes absent from the pty and every artefact; `y` at the gate sends; the mock provider saw the raw token; `secret-ack` count 1 |
| Wizard: bracketed paste, raw chunk, typing 3 ms/char, split marker 30 ms | 0 key bytes in the pty, trace, history, run dir; file 0600 / dir 0700; `saved` |
| `/login` mid-run then Ctrl-C | the wizard closes, the run continues (no exit 2) |
| `JEVCODE_FAULT=jev:429:12` | retry row at 1 fps ± 1; `[r]` shortens the wait; `ESC[2J` = 0 |
| `JEVCODE_FAULT=jev:401` | pane; `[q]` → exit 2 item; `[l]` opens `/login` |
| `JEVCODE_FAULT=persist:ENOSPC` (and opt-in `hdiutil` 1 MiB image with `JEVCODE_TEST_RAMDISK=1`) | degraded pane; `[q]` exit 3; `[c]` then `complete` exits 3; `[r]` then resume works |
| `JEVCODE_FAULT=render:decisions`, `render:composer` | fallback row; keys still handled; `ESC[2J ESC[3J` = 0 |
| Crash (`uncaughtException` injected) | `stty -a` shows `icanon echo`; epilogue bytes after the last frame; `state.json` present |
| `/diff --full` with `PAGER='sh -c "cat >/tmp/out; echo PAGED"'` | pager output above the redrawn frame; queued items flushed after resume |
| `/undo` bare Enter | declines |
| Ctrl+L with a 3-row draft and the pane open | the frame bytes after Ctrl+L equal the frame before; `ESC[2J` = 0; one `eraseLines` + rewrite inside one BSU/ESU pair |
| `echo task \| jevcode run --plain --mock` (stdin is a pipe, ends at once) | exits with the run's code, never 129; `--json </dev/null` likewise |
| Ctrl+G with `EDITOR='sh -c "cat $TMPDIR/* /tmp/probe 2>/dev/null; echo done > $0"'` while a mocked `run` step executes `cat $TMPDIR/*` | the sandboxed command's output contains no draft text; the draft file lives under `drafts/`, mode 0600, unlinked after return |
| Ctrl+G with a `ghp_` token in the draft | refused with the toast; no file written |
| `jevcode run "…AKIAIOSFODNN7EXAMPLE…"` on a TTY / on a pipe | TTY: the gate row before `run:ready`, `y` → `secret-ack` count 1 and the token masked in every artefact; pipe: exit 2 with the stderr line naming `AKIA…`, no run dir |
| external `kill -TERM` during a live run in session mode | `state.json` written; exit 143; no composer reopen; terminal restored |
| `--plain` TTY readline composer | same slash dispatcher; steer while live; secret gate via readline; `[ui]` lines present |
| `--json` on a pipe | first line `stream:start`; every line parses; no `status`; `run:end.exitCode` |
| 0×0 pty (no `stty`) | Ink 80×24 fallback; rule width 80 |
| `NO_COLOR=1`, `--ascii`, `--screen-reader` frames | no SGR; glyph table applied; numbered review with one BEL |

### 19.6 Fault injection (`JEVCODE_FAULT`, dev-only)

`render:<pane>`, `persist:ENOSPC`, `jev:429:12`, `jev:401`, `gen:529`, `disk:EACCES-runsdir`, `git:missing`, `watch:EMFILE`, `index:EACCES`; each has a unit test (reducer/engine) and a pty test where a frame is involved.

### 19.7 Acceptance scenario: the ten-run session (sessions graft; split by owner and wave: `test/unit/session/ten-run-seed.test.ts` — O6, wave 1, the pure seed/index/meter assertions of rows 1, 2, 4b, 6, 8, 9, 10 — and `test/unit/cli/ten-run.test.ts` — O10, wave 3, the controller-driven scenario incl. `/login`, `/budget`, `/export`, `/exit`)

| # | Human act | Effect asserted |
| --- | --- | --- |
| 1 | Enter "fix parse_date tz handling" | R1 `sessionId = R1`, `parentRunId = null`; `complete`; index `run:start` + `run:end`; meters $0.115 / $0.115; item `exit 0` |
| 2 | Enter "now update the docs"; at step 3 types "keep CHANGELOG format" Enter | R2 seeded from R1 (plan.done, window `from run R1`); `steer:queued` (step 4) → `steer:applied` at step 4 with the `human` problem and loop counts reset; index `steer` |
| 3 | Enter "add tests for edge cases"; Esc at step 5 | `pause:requested`; step 5 commits; `human_pause`; item `exit 4`; index `pause` |
| 3b | `/resume` | R3 continues (`resumes: 1`); the fold excluded R3's earlier `run:end`; `complete` |
| 4 | Enter "refactor date helpers" | R4 stops `spend_cap` at step 23; epilogue names `/budget spend-cap 3.00 then /resume` |
| 4b | `/budget spend-cap 3` then `/resume` | `run.json.overrides[]` gains `{ limits.spendCapUsd 2 → 3, atStep 23 }`; `budget:override`; `complete` |
| 5 | Enter "migrate loader to TOML"; Ctrl-C during propose | rule 1: step 6 discarded, `interrupted` set, `human_abort`; composer reopens, no exit; item `exit 130` |
| 6 | Enter "finish the TOML migration but skip legacy/" | R6 seeded from R5's committed plan (the discarded proposal is not in the seed) |
| 6b | `/undo` | R6 step 13: 3 restored, 1 skipped (`run`-changed untracked); `post/13.undone.json`; index `undo`; `state.json` of R6 byte-identical before/after |
| 7 | Enter "rerun the suite" with a revoked key | first Jev call 401 → pane; `[q]` → `run:end error` exit 2; composer reopens with `/login` suggested first |
| 7b | `/login` → new key | `addSecret` at once; `saved — applies to the next run`; `resolveConfig` re-run |
| 8 | Enter (same text) | R8 seeded from R6 (seed source skips the step-0 run R7); `undoLog` carried into R8's `state.json` |
| 9 | Enter "polish error messages" | `remaining 3.85 ≥ 2` → no confirm |
| 10 | Enter "final cleanup pass" | `remaining 2.14 ≥ 2` → no confirm; at step 19 the session cap trips through the child clamp (`parentExceeded`); `budget:stop by: 'session'`; epilogue names `/budget session-spend-cap` |
| 10b | Enter "one more"; `/budget session-spend-cap 15`; Enter; `/export`; `/exit` | refusal item + toast; `setCap(15)` + index `budget`; R11 starts clamped to `min(2, 5)`; export has 11 headers; `/exit` → 0 with the live run aborted first |

### 19.8 CI without a TTY

Unit, property, ink-testing-library and `--plain`/`--json` smoke on ubuntu and macOS; the `pty` and perf projects on `macos-latest` only with `CI` removed from the child env; snapshots fail on missing/obsolete in CI; the colour env matrix spawns the CLI and asserts SGR presence/absence.

## 20. Module map for parallel implementation (ten owner slots, disjoint files, waves)

A slot edits only its files; contract needs go to O1 as a diff request. `src/synth/**` is read-only for every slot.

| Slot | Files (new unless marked edit) | Exports | Depends on | Wave |
| --- | --- | --- | --- | --- |
| **O1 contract + engine** | `src/core/types.ts` (edit), `src/errors.ts` (edit: `BudgetKind`, `AbortError.signalName`), `src/version.ts` (new), `src/loop/stop.ts`, `src/loop/budget.ts`, `src/loop/plan.ts`, `src/loop/loopdetect.ts`, `src/loop/state.ts`, `src/provider/prompts.ts`, `src/loop/engine.ts`, `src/loop/generator-only.ts` (all edit), `src/core/time.ts`, `src/jev/client.ts`, `src/provider/sse.ts`, `src/provider/anthropic.ts`, `src/provider/openrouter.ts` (edit: `onRetry`/`wake` getter, `toJSON` fields, unpriced usage), `src/bench/conditions.ts` (edit: `session.source 'bench'`), `test/unit/bench/helpers.ts` + `test/fixtures/tui/fixtures.ts` (fake engines), `test/unit/loop/**`, `test/unit/provider/**` (`helpers.ts` compiles unchanged: `priced?`) | §15 items 1–15, 17 (`priced?`), 19, 20's engine-side events; `steer/unsteer/pause/retryNow/annotate`, `abort(reason, opts)`, `blocker`, seed, directives, `planAfter`, `imagesMs`, retry/budget/workspace/notice/blocking events, images hooks, `exitCodeFor(degraded, signal)`, `token_cap`, `sleep(wake)`, `VERSION` | — | 0 (types, stop, errors, version, fakes: one PR, ≤ 1 day) then 2 (engine, bench) |
| **O2 composer core** | `src/tui/composer/*.ts` **except** `Composer.tsx` (O9) and `submit.ts` (O3), i.e. `{buffer,width,eaw-table,rows,paste,history,killring,filter}.ts`, `scripts/gen-eaw.mjs`, `test/unit/tui/composer/**` | `reduceBuffer`, `graphemeBoundaries`, `wordBoundary`, `cellWidth`, `stringWidth`, `truncateCells`, `layoutRows`, `cursorToRowX`, `viewport`, `PasteStore`, `filterInput`, `HistoryStore` impl | none | 1 |
| **O3 keys + layout + commands** | `src/tui/layout.ts`, `src/tui/keys/{resolve,interrupts,bindings,keybindings-file}.ts`, `src/tui/commands/{parse,registry,fuzzy,dispatch}.ts`, `src/tui/composer/submit.ts` (pure routing, §4.9), `scripts/gen-docs.mjs` (KEYS.md, COMMANDS.md, man, completions), `test/unit/tui/{layout,keys,commands}/**` (incl. `commands/submit.test.ts`, `commands/fuzzy.test.ts`, `layout/layout.test.ts`) | `computeLayout`, `CAP`, `resolveKey`, `reduceInterrupts`, `KEY_ACTIONS`, `loadKeybindings`, `parseCommand`, `COMMANDS`, `rank`/`score`, `dispatchCommand`, `routeSubmit` | O1 types | 1 |
| **O4 review + pane + decisions** | `src/tui/review/lines.ts`, `src/tui/pane/{model,decisions,plan,timeline,synth,banner}.ts`, `src/tui/why.ts`, `src/tui/calibration.ts`, `src/tui/bars.ts`, `src/tui/glyphs.ts`, `test/unit/tui/{review,pane}/**` | `reviewHeaderLines`, `followupLines`, `toDecisionRow`, `decisionRows`, `planRows`, `timelineRows`, `synthRows`, `bannerRow`, `whyBlock`, `calibrationBlock`, `eighthBar`, `sparkline`, `GLYPHS` | O1 types | 1 |
| **O5 status + git + workspace** | `src/tui/status/lines.ts`, `src/tui/useGitHead.ts`, `src/tui/toasts.ts`, `src/workspace/gitstate.ts` (new: the two unsandboxed spawns), `src/workspace/git.ts` (edit), `src/workspace/files.ts` (edit: zero spawns with `gitState`, standalone `listCandidates`, `gitState()`, `dirtySet()`, `readSecretForMention()`), `src/sandbox/paths.ts` (edit: denylist, `isMentionDenied`), `src/sandbox/seatbelt.ts` (edit: `gitDir`/`gitCommonDir`/`configDirs`), `src/sandbox/run.ts` (edit: forward the three to `buildProfile`, include them in the profile-path hash at `:183`), `test/unit/{tui/status,workspace,sandbox}/**` | `statusLineText`, `useGitHead`, `toastReducer`, `probeGitState`, `toRunGitMeta`, `statusPorcelainV2`, `restoreFromHead`, `listCandidates`, `isMentionDenied` | O1 | 1 (pure) / 2 (I/O) |
| **O6 sessions + money + config** | `src/session/{index,lock,seed,export,picker-lines}.ts`, `src/spend/meter.ts` (edit), `src/tui/budget/lines.ts`, `src/config/resolve.ts`, `src/config/validate.ts`, `src/config/defaults.ts`, `src/config/types.ts` (edit), `src/config/ui.ts`, `src/config/launch.ts` (new), `test/unit/{session,spend}/**`, `test/unit/config/{launch,ui,resolve,validate,defaults,env,resume}.test.ts` (incl. `session/ten-run-seed.test.ts`) | `foldIndex`, `readIndex`, `appendIndexLine`, `reindex`, `acquireRunLock`/`releaseRunLock`, `buildSeed`, `seedSource`, `exportSession`, `pickerRows`, `setCap`/`parent`, `budgetItems`, `costBlock`, `missingSecrets`, `resolveLaunchSettings`, `ui(launch)`, `sessionSpendCap()`, `priced`, `configDirs` | O1 | 1 |
| **O7 secrets + onboarding + logs** | `src/core/redact.ts` (edit), `src/core/log.ts`, `src/tui/onboarding/{reducer,lines}.ts`, `src/tui/secrets/{gate-lines,clipboard}.ts`, `src/config/{credentials,trust,instructions}.ts`, `src/cli/login.ts`, `test/unit/core/**` (new directory; `test/unit/config/redact.test.ts` moves to `test/unit/core/redact.test.ts` in O7's first PR), `test/unit/config/{trust,credentials,instructions,login}.test.ts`, `test/unit/tui/onboarding/**` | `detectSecrets`, `dropSecret`, `createLog`, `onboardingReducer`, `wizardLines`, `gateLines`, `copyRedacted`, `writeCredentials`, `trustStore`, `loadInstructions`, `commandLogin/Logout/ConfigSet` | O1 | 1 |
| **O8 undo/diff + errors + fatal** | `src/checkpoint/images.ts`, `src/checkpoint/store.ts` (edit: `CHECKPOINT_FILES`, `writeUi?`, disk-error classifier `classifyDiskError`), `src/undo/{plan,apply,diff,pager}.ts`, `src/cli/epilogue.ts`, `src/cli/fatal.ts`, `src/tui/PaneBoundary.tsx`, `src/tui/blocking/lines.ts`, `test/unit/{checkpoint,undo,cli/epilogue}/**` | `writePreImages`, `writePostImages`, `readPostImages`, `planUndo`, `applyUndo`, `diffStatBlock`, `diffStep`, `openFullDiff`, `epilogueLines`, `fatalExit`, `PaneBoundary`, `blockingLines` | O1, O5 (`GitState`, `restoreFromHead`) | 1 (pure) / 2 (I/O) |
| **O9 Ink components + App** | `src/tui/App.tsx`, `src/tui/useEngine.tsx`, `src/tui/Transcript.tsx`, `src/tui/StatusLine.tsx` (edit), `src/tui/Decisions.tsx` + `src/tui/Confirm.tsx` (deleted; replaced by `Pane.tsx`/`Overlay.tsx`), `src/tui/composer/Composer.tsx`, `src/tui/Overlay.tsx` (review, wizard, follow-up, secret, blocking, palette, undo, exitConfirm, minsize), `src/tui/Review.tsx`, `src/tui/Pane.tsx`, `src/tui/Picker.tsx`, `src/tui/onboarding/{Wizard,MaskedField}.tsx`, `src/tui/spinner.ts`, `src/tui/retry.ts`, `src/tui/theme.ts`, `src/tui/color-shim.ts`, `src/tui/terminal.ts` (exit string, Ctrl-Z, SIGHUP, resize debounce, suspension queue), `src/tui/notify.ts`, `src/tui/index.ts` (edit), `test/unit/tui/*.test.{ts,tsx}` except `plain*.test.ts`/`plain-composer.test.ts` (O10) — this covers the existing `reducer.test.ts`, `app.test.tsx`, `height.test.tsx` — plus `test/unit/tui/stub-stdout.ts` | `createTuiRenderer`, `uiReducer`, `createTuiConfirmer` (+ `resolveDetailed`, `confirmDetailed`), `installTerminalHygiene`, `restoreTerminal` | O2–O8 | 3 |
| **O10 CLI + plain + packaging + perf/pty** | `src/cli/main.tsx`, `src/cli/args.ts` (edit), `src/cli/session.ts`, `src/cli/json-stream.ts`, `src/cli/{completion,upgrade,report,sessions,doctor-stub}.ts`, `src/tui/plain.ts` (edit), `src/tui/plain-composer.ts`, `bin/jevcode.js` (edit), `scripts/build.mjs` (edit), `scripts/licenses.mjs`, `package.json`, `LICENSE`, `Formula/jevcode.rb`, `.github/workflows/release.yml`, `src/perf/{first-frame,render-lag,step-overhead}.ts` (edit), `src/perf/{composer-latency,states,static-append}.ts`, `perf/drivers/pty_type.py`, `test/pty/**`, `test/unit/cli/**` (incl. `cli/ten-run.test.ts`, wave 3), `test/unit/tui/plain*.test.ts`, `test/unit/tui/plain-composer.test.ts`, `test/unit/config/args.test.ts` (tests `cli/args.ts`), `docs/*` | `commandChat`/`commandRun`, `createSessionController` (host: `redact`/`addSecret`/`detectSecrets`/`note`; `blocker`; `exit` hook; `--source perf`), `writeJsonStream`, `createPlainRenderer` (new kinds, `label`), `createReadlineComposer`, commands | O1, O3, O6, O7, O8 | 2 (args, plain, json-stream) / 3 (main, session) / 4 (pty, perf, packaging, docs) |

Waves: **W0** O1 lands `types.ts`, `errors.ts`, `stop.ts` and the two fake engines in one PR so every slot compiles (`tsc --strict` green). **W1** (parallel, ink-free, unit-tested): O2, O3, O4, O5 pure, O6, O7, O8 pure. **W2**: O1 engine changes; O5/O8 I/O parts; O10 `args.ts`, `plain.ts`, `json-stream.ts`. **W3**: O9 components over W1 outputs; O10 `main.tsx` + `session.ts`. **W4**: pty suite, perf gates, packaging, docs. Integration order inside W3: layout → composer → status → pane → overlay (review) → palette/mention → picker → wizard → follow-up/secret/blocking/exitConfirm → retry row. Shared fixture: `test/unit/tui/stub-stdout.ts` (O9 extracts it in W1 so O3/O4 tests can use it). **Ownership rule:** one directory, one owner; the globs above are disjoint by construction, and an existing test file that changes owner moves in the new owner's first PR (`test/unit/config/redact.test.ts` → `test/unit/core/redact.test.ts`, O7).

## 21. Documentation deliverables

`docs/KEYS.md` and `docs/COMMANDS.md` generated from `KEY_ACTIONS`/`COMMANDS` with sync tests; `man/jevcode.1` and `completions/jevcode.{bash,zsh,fish}` from `FLAGS` + `COMMANDS`; `docs/TUI.md` (user guide: modes, keys, sessions, money, secrets, undo/diff, exit codes); `docs/DESIGN.md` amendments — §4 (contract 1.1 pointer to §15), §9 (index, lock, images, seed, `human_pause`, seed-carried `undoLog`), §10 (composer, layout order, `label`led items and the `Engine.annotate()` path that keeps the three-way identity for the whole run, `--json` guarantee wording), §11 (state-mutation rule amendment, exit-code table, `fatalExit` order), §12 (new gates); `docs/DECISIONS.md` entries of §23; `docs/research/tui/terminal-matrix.md` checklist; README sections "Interactive session", "Sessions and follow-ups", "Money", "Secrets" (with "or in prompt history, clipboard payloads and the `--json` stream" and the `addSecret` resume caveat), "Exit codes", "Windows", "Install (zero dependencies, brew tap)"; `CHANGELOG.md`; `LICENSE`; `THIRD_PARTY_LICENSES.txt` (generated).

## 22. Deviations from research ADOPT rows and items deferred to v1.x

| Row | Deviation (one sentence) |
| --- | --- |
| A9 | Typing `exit`/`quit`/`:q` does not exit and there are no rotating placeholder examples: a task may legitimately be the word "quit", and a decorative timer violates the reduced-motion budget. |
| A21 | Help is an appended `<Static>` block plus the status-line ShortHelp, not a two-level overlay pane: one modal slot and zero extra rows outweigh Claude Code's overlay on this design. |
| A26 | No newline-gated per-line commit of generator text: the TUI would gain `<Static>` lines `transcript.log` lacks, breaking the identity; the ≤ 2-row live tail + whole proposal item stays. |
| A29 | `--replay-limit` dropped: resume replay is header + plan summary + 4 window entries, so batching is moot. |
| A34 | Enter on a non-matching `/` token keeps the draft and reports the error instead of submitting: in JevCode a submitted line is a paid run (composer-first D1). |
| A35 | The `@` search is synchronous over the in-memory candidate list under the 16 ms gate; the async session/abort machinery is deferred. |
| A46 | Meter bars at ≥ 140 columns and tokens at ≥ 160 (not 120/140): the F16 git zone and sparkline at ≥ 100 take those cells first. |
| A63 | Project commands `.jevcode/commands/*.md` deferred (not required by F1–F18; the registry has a `project` category reserved). |
| A75 | `jevcode doctor` deferred; `/config`, `/status` and `jevcode config` cover the read-only view. |
| A78 | tmux `CSI > 4 ; 2 m` not sent in v1 (Ink cannot parse `CSI 27;m;k~`; deferred with the kitty handshake). |
| A87 | OSC 8 hyperlinks deferred. |
| A143 | `undoLog` is carried in the next run's `CheckpointState` via the seed and the finished run gets `post/<N>.undone.json` + an index line: rewriting a finished run's `state.json` would violate DESIGN §9 / R21. |
| A160 | `[r] retry now` **is** in v1 via `Engine.retryNow()` (one method beyond F13's named trio) and `sleep(ms, signal?, wake?)`: F12 requires the key and a dead key is worse than one method. |
| 11 §4b | `matches_intent` is dropped first when the header is cut to 6 rows and compact two-per-row dimension rows follow below, so all four dimensions survive down to 4 header rows; dimension order stays fixed with digits shown so `w`+digit is stable. |
| 06 §17.3 | No `a` approve alias, no `s` steer key, no focus movement on the box (F6: exactly `y n Esc d e w`). |
| 10 §15.3 | `steer` refuses the ninth directive with a toast rather than silently evicting; idle-only commands typed while live error immediately instead of being queued to run end. |
| 13 §5.2 | Wizard Ctrl-C exits 2 only when no run exists; during `/login` mid-run it closes the wizard (the run must be checkpointed by `abort`, not `process.exit`). |
| 13 §5.12 | The wizard replaces the composer row entirely (refund) rather than keeping a `> (setup)` row. |
| A56 | Picker delete moves the run dir to `~/.jevcode/trash/`, never `rm -rf` (bench evidence lives in the same tree, R20). |
| C46 | `--no-input` selects the plain renderer on a TTY as well as suppressing prompts (an Ink composer is interactive). |
| A130 | `/resume` seeding folds the index excluding the resumed run before adding its `state.json.spend` (A130's wording double-counted). |
| DESIGN §10 | The three-way line identity is kept for the whole run — renderer-originated lines ride `Engine.annotate()` into `transcript.log` — and DESIGN §10 gains one sentence for the only lines outside it: idle-time items, for which no `transcript.log` exists. |
| F14 (constrained by F1) | `ui.fps`, `ui.renderMode`, `ui.screenReader` and `ui.ascii` resolve flag > env > default with no file key: F1's zero-file first frame and Ink's mount-time throttle make a file value for these unhonourable, so `jevcode config` reports such a key as `ignored:launch` rather than letting it silently do nothing (§16). |
| F5 (`--plain` TTY only) | Ctrl-D's two-press hint needs raw mode; in cooked-mode `--plain` an EOF is final, so a single EOF exits 0 (aborting a live run first), and Ctrl-C there is SIGINT routed through the F5 matrix (§13.4, §14.2). |
| F13 (`Engine` trio) | `Engine.annotate()` is the second method beyond the named trio (after `retryNow`): without it renderer lines could not enter `transcript.log` and F13's identity clause would break (§15.1); `Engine.abort` is widened, not added. |

Deferred to v1.x: the owned kitty handshake (`CSI ? u` + DA1 after the pty suite, C1); incremental rendering as default (soak test, C2); `--theme auto` behind a pre-Ink stdin demux (C15, Q13); focus tracking 1004 (C25); tmux extended keys; OSC 8; project commands; `jevcode doctor`; `/redo` (P54); the "restore to HEAD" undo option (P50); `/cd` workspace switching (second trust check); structured `synth` fields (synth team, A48); `.jevcodeignore`; persisted `addSecret` across `--resume` (P56); the `w` write-to-.env gate option (P57, conflicts with A118); promotion of warn-only secret families to redacting (C44, Q35); Windows/ConPTY tests (Q19); NVDA/VoiceOver validation (Q15/Q16); side-by-side tabs beyond two; vim mode; markdown rendering of generator text; `!` shell mode and `/compact` (fixed no); 95 % pre-emption (fixed no); `--auto-decline` (fixed no); Static remount cap tuning beyond 20,000 (Q10); `/why` for the context stage's top-k (P12).

## 23. Decision log entries (ready to append to `docs/DECISIONS.md`)

## 2026-09-20 Interactive TUI: minimal-robust spine with judge-required grafts

Four candidate designs were written and judged on three lenses (UX, engineering feasibility, safety). `minimal-robust` won two lenses and the aggregate (23 points) and becomes the spine of `docs/TUI-DESIGN.md`: one modal slot above the composer, one `computeLayout` whose allocation order is the reverse of the fixed yield order, one pure key resolver over states S0–S7, and `lines()` twins for every visual. Grafts taken because a judge required them: jev-native's `DecisionRow` (`consumedBy`, `near`), its `/why` text, its review-deferral mechanics and `SpendMeter.setCap`; sessions-long-horizon's `run.lock`, seed-source rule, `v:1` envelopes, seed-carried `undoLog`, `post/<step>.json` with `cleanAtStart`, the ten-run walkthrough and the blocking-pane Ctrl-C rule; composer-first's additive contract shape (`confirmDetailed?`, optional event fields), its interrupt reducer and its rule that a slash typo never becomes a paid run. Affects: everything under `src/tui/**`, `src/cli/**`, `src/session/**`, and the additive contract of §15.

## 2026-09-20 A submitted line is money: slash typos never start a run

Three of four designs followed A34 literally and submitted an unknown `/foo` as a prompt. In Claude Code a submission is a chat message; in JevCode it is `startRun()` with a fresh $2.00 cap or a steer into a live run. Enter on a `/` token that is not an exact name or alias keeps the draft and appends `[ui] error: unknown command /foo; type / to list commands`; there is no prefix execution. Affects `src/tui/composer/submit.ts`, `src/tui/commands/dispatch.ts`, the palette, and §22's A34 row.

## 2026-09-20 The review box owns its keys; the composer is inactive underneath

jev-native kept the composer editable under a visible review box, so the `y` of a typed "yes, also update docs" would have approved the action (A41's typed-ahead accident moved from before the box to during it). The composer collapses to one inactive row while a review is visible; printable keys and pastes are ignored with a toast; the review key context is armed only on the frame after the box is drawn, after ≥ 1 s of composer idleness with Ink's input queue drained. Affects `src/tui/keys/resolve.ts`, `src/tui/useEngine.tsx`, `src/tui/Overlay.tsx`.

## 2026-09-20 Contract 1.1 is additive by construction, with one named exception

`Confirmer.confirm()` keeps `Promise<boolean>` and gains an optional `confirmDetailed?`; `run:ready`, `run:end`, `confirm:resolved`, `ConfirmRequest`, `SpendSnapshot`, `PromptInput`, `GeneratorConfig` (`priced?`) and `RunMeta`/`CheckpointState`/`StepRecord`/`StepTiming` gain only optional fields, so `run-events.json`, the bench fakes, the provider test helpers and `store.ts`'s shape guards compile and load unchanged and `CheckpointEnvelope.version` stays 1; every prescribed assignment is a conditional spread because the repo compiles with `exactOptionalPropertyTypes`. The exception is `Engine`, which gains five required methods (`steer`, `unsteer`, `pause`, `retryNow`, `annotate`) and a widened `abort(reason, opts?)` because the repo alone implements it; the two fake engines are updated in the same W0 PR. `retryNow` and `annotate` are the two methods beyond F13's named trio: F12 requires `[r] retry now` and the renderer needs a handle to the engine-owned waker; F13 requires the three-way line identity and only the engine writes `transcript.log`. Affects `src/core/types.ts`, `test/unit/bench/helpers.ts`, `test/fixtures/tui/fixtures.ts`.

## 2026-09-20 Session-cap raises mutate the root meter; `/resume` folds exclude the resumed run

sessions-long-horizon proposed recreating the root `SpendMeter` on `/budget session-spend-cap`, which orphans every live child (`meter.ts:88–89` binds the parent by reference). The cap becomes a `let` behind `SpendMeter.setCap?()`; children keep forwarding to the same object; `SpendSnapshot.parent?` lets the engine emit session-scope `budget:warn` mid-run without knowing the parent. All four designs double-counted the resumed run's spend when seeding the session meter on `/resume`; the fold now excludes the resumed `runId` before `state.json.spend` is added. Affects `src/spend/meter.ts`, `src/cli/session.ts`, `src/loop/engine.ts`.

## 2026-09-20 Unsent drafts never reach disk with a secret in them

Every design wrote a Ctrl-C-cleared draft to `~/.jevcode/history.jsonl` through `redact` alone, which knows only configured secrets and the six redacting families; a warn-only AWS key or PEM block in an abandoned draft would have landed on disk with no `y` pressed. The clear→history path, `ui.json` drafts and the `d` decline note now run `detectSecrets` and replace every hit span (warn-only families included) with `[REDACTED:draft]`; the sent path is symmetric — `y` at the gate `addSecret`s every hit span, warn-only families included, because the exact span the human typed has no false-positive cost. The external-editor draft moves from `<runDir>/tmp/` (the sandboxed command's `TMPDIR`, readable and writable by a generator-proposed `run`) to `<runDir>/drafts/`, and Ctrl+G is refused while the draft has a hit; the composer itself renders detected spans as `•` cells so no frame ever carries the bytes. Affects `src/tui/composer/history.ts`, `src/checkpoint/store.ts` (`writeUi`), `src/tui/Review.tsx`, `src/tui/composer/Composer.tsx`, `src/cli/session.ts`.

## 2026-09-20 `/undo` rule 3 is gated on the recorded HEAD oid

`git restore --source=HEAD --worktree` assumes HEAD is the commit the step ran under. `post/<step>.json` records `headOid` (from the run-start probe and the `HEAD` watcher); when the current HEAD differs, the file is skipped with `not recoverable — HEAD moved since step N` instead of silently restoring another commit's content or reporting a no-op as restored. The finished run's `state.json` is never rewritten by `/undo`; the `undoLog` travels in the next run's seed. Affects `src/checkpoint/images.ts`, `src/undo/plan.ts`, `src/session/seed.ts`.

## 2026-09-20 Exit paths during a live run go through `engine.abort` first

`/exit`, Ctrl-D ×2 and a wizard Ctrl-C during `/login` must not `process.exit` past a live engine: the `'exit'` writer that makes `state.json` final is installed only inside `abort()` (`engine.ts:487–510`), and a stderr write into a mounted Ink frame corrupts it. `/exit` and Ctrl-D ×2 open a one-row `a run is live: [y] abort and exit  [n] stay` confirm; the wizard's Ctrl-C exits 2 only when no run exists; a blocking pane's Ctrl-C is that pane's `[q]` so one failure has one exit code. Affects `src/tui/keys/interrupts.ts`, `src/cli/session.ts`, `src/tui/onboarding/reducer.ts`.

## 2026-09-20 Renderer-originated lines ride the engine's transcript while a run is live

`/why`, `/plan`, `/diff`, `/cost`, help, undo output, the 12,000-char notice and `/budget` changes are produced by the renderer, while `transcript.log` is written only by the engine's `recordTranscript`. F13 fixes the line-for-line identity of `transcript.log`, `--plain` and the TUI, so instead of excluding these lines they go through `SessionHost.note()` → `Engine.annotate(text, { detail, label })` → `notice { kind: 'ui', label }` → `emit()` → all three writers with the engine's `transcriptSeq`; `formatTranscriptItem` prints the item's `label` (`[ui]`, `[setup]`, `[config]`, `[sandbox]`) instead of `stepLabel()`. Only lines produced while no engine is live (session start, between runs, the session epilogue) are renderer-local, because no `transcript.log` exists to hold them; they appear in `--plain`, the TUI and the `--json` stream (`ui { text, label }`). No `user` event is added: the human turn is the `run:start` task line and the engine's `steer:queued` lines. Affects `src/core/types.ts` (`Engine.annotate`), `src/loop/engine.ts`, `src/tui/plain.ts`, `src/tui/Transcript.tsx`, `src/cli/session.ts`, `docs/DESIGN.md` §10.

## 2026-09-20 `--no-input` means no interactive renderer

C46 ("don't prompt or do anything interactive") is read strictly: `--no-input` on a TTY selects the plain renderer without a composer, in addition to suppressing the wizard, trust gate, follow-up confirm (silent clamp), secret gate (cancel) and review prompts (decline); `jevcode chat --no-input` is a usage error. Affects `src/cli/main.tsx`, `src/cli/args.ts`.

## 24. Glossary of user-facing strings (every twin renders these exactly; `--ascii` substitutes per §14.1)

**Header and placeholders.** `jevcode session · <dir> | step 0/– starting` · `jevcode task: <task ≤ 160> | step 0/– starting` · `jevcode resuming <id> | step 0/– starting` · `Describe the task…   / commands · @ files · ? help · Enter runs` · `Follow-up or /command…   Enter runs · ↑ history · Esc Esc menu · ? help` · `Type to steer the next step…   Esc pauses · Esc Esc aborts` · `(review pending — keys above; d opens a note)` · `(review pending)` · `note (≤ 600, Enter sends, Esc cancels): ` · `(waiting for y/r/n)` · `(waiting for y/n)` · `(paused — answer the pane above)` · `filter: ` · `[ui] recent: "<title>" · <ago>  (Enter continues, /resume browses)` · `starting…` (Enter before the host attached).

**Status left-zone words.** `idle` · `idle exit N` · `setup` · `starting` · `intent` `context` `propose` `propose [synth]` `risk` `execute` `judge` `complete` `replan` (with the spinner) · `still waiting` · `review` · `review pending…` · `pausing after step N` · `paused: jev unreachable` · `paused: key rejected` · `paused: checkpoint degraded` · `paused: spend limit` · `retrying 2/3` · `offline` · `disk ×N` · `aborting` · `palette` · `picker` · `done <stopReason>`. Badges: `!n` · `sandbox: none` · `no-net` · `⚠ secret?`.

**Status right zone.** `step N/M` · `step N/–` · `<wall>` (`formatDuration`) · `run $x.xx/y.yy <word>` · `sess $x.xx/y.yy <word>` · `sess $x.xx/none uncapped` · `⎇ <branch> ↑a ↓b · m~ n?` · `⎇ <oid8>†` · `⎇ <branch> (wt)` · `jev ▂▃▂▅▂▂▇▃▂▁▂▃` · `? help` · `Tab ⇥` · `Esc closes`. Meter words: `ok` · `half` · `high` · `critical` · `over` · `uncapped`.

**Rule row.** `─── decisions s7 · c~ derived |2p−1| ────── [d]ecisions [p]lan [t]ime [s]ynth ──` · `─── plan s7 · done 2 rem 3 unv 1 prob 2 ───` · `─── timeline s7 ───` · `─── synth s7 ───` · `─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────` · `─── rewind · steps with changes ─ ↑↓ Enter Esc ───`.

**Pane rows.** decisions `sN <stage> <id> <label> <bar> [!]p.pp  c c.cc[~]  [ok|review|block|chosen|overridden|fallback]` · `(no decisions yet)` · plan `[x]` `[ ]` `[?]` `[!]` with `unverified` · timeline `time  sN  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s` / `      sN  I C P R X J  total 8.2s  h 31ms` · synth `synth  <phase>: <detail>` · banner `loop  <signature>  x2/3   replan 1/5 s6 <move> p .61 imp .12`.

**Queue rows.** `↑1 queued for step N: <text>` · `↑2 queued for step N: <text>                    [↑ takes back]`.

**Review box.** title `review  step N  risk R (<bound>)  <kind> <target> "<goal>"` (120: `(tail on <dim>)`, `jev <ms>`) · keys `[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline` (120: `[e] expand preview`, `[ctrl-c] abort run`) · ruler `dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)` (120: `P(l)  E[k]  tail`; `E[k]/4; tail = P(k≥3)`) · gauge `<d> <dim> L<k>  <bar>  <risk> <exp|tail> <conf>  <level text>` · `5 matches_intent  <bar>  <p> noul <c>~ <criteria>` · `5 matches_intent  —  not judged this step` · compact `3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93` (three dimensions per row at ≥ 120 columns, `5 matches_intent p=0.88 noul c=0.76~` as the third) · preview tail `…[k more preview lines · e expands]` · toast `review pending: y n d e w · Esc declines` · SR `1 approve  2 decline  3 decline with a note` / `Enter selection (1-3):`.

**Toasts and hints.** `press Ctrl-C again to exit` · `press Ctrl-D again to exit` · `run is live — Ctrl-D again to choose` · `Esc again clears the draft` · `Esc again aborts the run` · `✓ jev back` · `✓ network back` · `✓ checkpoint restored` · `! <code>: <short>` · `saved — applies to the next run (this run keeps its key)` · `steer queue full (8)` · `paste of <size> refused (limit 1 MiB); write it to a file and @-mention it` · `editor: the draft contains a secret (<label>); remove it or send it first` · `calibration: scanning N runs…` · `Tip: put it in .env and refer to it by name` · `copied with N secret(s) masked` · `copied` · `editor exited N; draft kept` · `could not write <file>: <code>`.

**Overlays.** secret gate `Looks like this contains a secret (<label>). Send anyway? y/N` / `Looks like this contains N secrets (<labels>). Send anyway? y/N` / `Looks like this contains your <NAME>. Send anyway? y/N` · `Attach anyway? y/N` · follow-up box `follow-up would exceed the session cap` / `[y] start, run cap clamped to $x.xx   [r] raise session cap   [n]/Esc cancel` / `session $a of $b (N runs) · run cap $c · last run $d` / `Enter does nothing here. A clamped run stops at the session cap (spend_cap).` · exit confirm `a run is live: [y] abort and exit   [n] stay              (Enter does nothing)` · undo `<path> changed since step N (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort` · rewind choice `files (done) · [p] plan+window · [b] both · Esc keep` · minimum size `terminal <W>×<H> is below the 40×8 minimum — panes hidden, transcript above` · palette footer `(i/N)  Tab completes · Enter runs an exact match · Esc closes` · `Suggested`.

**Blocking panes.** `jev: key rejected (HTTP 401 — "<msg ≤ 120>")` / `Set the decider key and retry. Consulted: <sources>` / `The key is never printed or logged.` / `[r] retry with the current key   [l] /login   [q] stop (exit 2)` · `generator: key rejected (HTTP 401 — "…")` (same rows) · `provider: spend limit reached — "<message>" · this keeps failing until access resumes · [q] stop (exit 5)` · `jev unreachable after 3 attempts · retrying in 30 s (auto, doubles to 5 min) · [r] now  [q] stop` · `checkpoint degraded: <code> on <file>` / `state.json could not be written since step N — the run cannot be resumed from here.` / `[r] retry the write   [c] continue without checkpoints   [q] stop now (exit 3)` · `jev: model alias <configured> resolved to <served> on the first call` / `[p] pin --jev-model <served> for the next run   [q] stop (exit 2)` · `sandbox: seatbelt requested but sandbox-exec is unavailable` / `[q] stop (exit 6)`.

**Retry row.** `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now` · `generator: retrying 2/3 in 8 s · HTTP 529 overloaded    [r] retry now` · `last: HTTP <status> <short> · request-id <id>` · offline copy `offline: DNS lookup failed for <host>` · `offline: cannot reach <host>` · `no response from <host> in 10 s` · `(sandbox network denied by --no-network)`.

**Wizard.** `No API key found. Pick the generator provider:` / `  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)` / `Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)` · `<Provider> API key (<ENV>)` · `Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  2/2` · `Enter = reuse the OpenRouter key for Jev` · `N chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back` (narrow: `N · Enter · ⌫ · ^U · Esc`) · `Verify the keys now? [y] yes (one priced Jev call, ~$0.0001)  [n] skip` · `[setup] generator key: entered (sha256:<8>) source=wizard` · `[setup] saved <path> (mode 0600, dir 0700)` · `(Windows: protected by your user profile ACL)` · `[setup] verified: openrouter key ok (label "<label>", limit remaining $x)` · `[setup] verification failed: <short> — the key was kept; fix it with /login` · trust `Do you trust the files in <root>?  (git root; stored per repository)` / `  AGENTS.md (<size>) → generator system prompt   ./.env (N vars, M secret-like)` / `  jevcode.json (<size>|none)` / `  1 trust   2 this session only   3 don't trust (AGENTS.md ignored; .env read)` · `AGENTS.md changed since you trusted it (sha256 <8> → <8>)` · sandbox `[sandbox] seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network` · `[sandbox] none — sandbox-exec is not available on <platform>: cwd confinement, env scrubbing, timeout, output cap and tree kill only` · shadowing `[config] generator.apiKey: env ANTHROPIC_API_KEY (sha256:<8>) overrides file <path> (sha256:<8>) — unset the variable to use the saved key` · `set but empty — treated as unset` · `dotenv: <path>` · fix block `export ANTHROPIC_API_KEY=…` / `export JEV_API_KEY=…` / `printenv OPENROUTER_API_KEY | jevcode login --jev-key-stdin` / `jevcode login` / `Keys are never accepted as command-line arguments in the interactive flow`.

**Engine items (transcript.log, --plain, TUI).** `steer queued (N) for step S: <text>` · `steer applied to step S (N directives; superseded: <text ≤ 80>)` · `steer withdrawn (N)` · `pause requested: stopping after step S` · `end human_pause steps=N …` · `[run] budget: run spend $a is P % of the $b run cap — about N steps left at $c/step` · `[run] budget: session spend $a is P % of the $b session cap — raise it with /budget session-spend-cap <usd>` · ` — Jev is the larger share ($x vs $y); see /jev` · `[run] budget stop: <by> cap $b reached at <at> — raise: <command>` · `[run] budget: run cap clamped to $x (session $a of $b)` · `[run] budget override: <setting> <from> → <to> (applies to this resume)` · `[run] budget: <side> usage.cost missing for <model> — unpriced` · `warning: <side> retry chain: N attempts over Ts — <short>` · `[run] git <banner>` (§12.2) · `[run] instructions: <path> (<bytes>, sha256 <8>)` · `[run] seeded from run <id>: plan done=a remaining=b unverified=c · window N entries · M created files` · `[step N] sent K secret(s) to the generator on request` (`[run]` before step 1; `stepLabel`, never `[turn N]`) · `confirm <id> declined (note: <note>)` · `checkpoint degraded: <code> on <file> (once per file and code)` · `resumed on <oid8>, run started on <oid8> — the plan may not apply` · `run <id> is in use by pid <pid> since <t> (another jevcode?); run 'jevcode sessions unlock <id>' if that process is gone`.

**Renderer-originated items** (`TranscriptItem.label` = `[ui]` · `[setup]` · `[config]` · `[sandbox]`; in all three writers via `annotate()` while a run is live, `--plain`/TUI/`--json` only while idle — §15.1). `[ui] budget: session cap $a → $b (applies now)` · `[ui] budget: <setting> <v> pending (next /resume or run)` · `[ui] stopped — <code>: <msg> (exit N)` + `run <id>` + `files <dir>  (transcript.log, state.json, jevcode.log)` + `resume    jevcode run --resume <id>` | `state.json missing — not resumable` + `report    jevcode report <id>   (redacted bundle written locally; nothing is sent)` · `[ui] paused after step N — /resume continues, or type a follow-up` · `[ui] stopped by the run spend cap: $a of $b (over by $c, one judge call). Session $d/$e <word>.` / `continue this run: /budget spend-cap <usd> then /resume` / `or start a follow-up run with a fresh $b cap` · `[ui] session cap reached ($a of $b). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.` · `[ui] error: unknown command /foo; type / to list commands` · `[ui] error: /<cmd>: <reason>` · `[ui] error: /undo runs when the run is idle; Esc pauses first` · `[ui] error: /pause needs a live run` · `[ui] notice: only the first 12,000 characters reach the generator; @-mention a file for more` · `[ui] remove [Pasted #N] or paste again` · `[ui] .env is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to override.` · `[ui] undo step N: restored K files (<list>), skipped M (<path>: <reason>)` · `[ui] no files restored (<reasons>)` · undo reasons `not recoverable — changed by a command, not tracked by git` · `not recoverable — HEAD moved since step N` · `not recoverable — no git repository` · `<path> was changed again by step M; use /rewind N to undo steps N–M together` · `[ui] diff (run <id> · N files · +a −b · c untracked · d binary · e skipped)` · `† also modified before this run` · `… N more files (/diff --all)` · `[ui] why <ref>  request <hash>  <ms>  <model>` · `[ui] calibration  N runs  N decisions  N with a label` · `[ui] exited on Ctrl-C ×2` · `[ui] exited on Ctrl-D ×2` · `[ui] ui: <pane> pane failed to render (<Error>) — run continues; details in <log>` · `[ui] session <id> ended: N runs, $x total` · `[screen reader mode: on via flag|env|config]`.

**CLI (stderr / stdout, before or after Ink).** `jevcode: stopped — <code>: <msg> (exit N)` (epilogue; `<msg>` redacted) · `jevcode: the task contains a secret (<label>); refusing to start (exit 2)` · `press Ctrl-C again to exit` (`--plain` TTY, stderr) · `jevcode: <warning>` · `jevcode: Node 22.12 or newer is required (found <v>); see .nvmrc` · `generator.model "<id>" has no pricing entry, so the $x spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.` · `--no-input needs a task: use jevcode run` · `secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument` · `session.spendCapUsd  $10.000 (default: 5 × limits.spendCapUsd)` · `--resume: "<x>" matches N sessions: <list>` · `no session in <path> yet`.

## 25. Review log

Three adversarial reviewers (arithmetic-perf, safety-invariants, implementability) returned 63 findings against the first synthesis. Every blocker and major was applied in place; every minor was applied too (none conflicted with a fixed decision once F1/F14 and F5/`--plain` were reconciled in §22). Duplicates across reviewers are resolved once and cross-referenced.

| # | Severity | Finding (short) | What changed |
| --- | --- | --- | --- |
| 1 | blocker | `render()` options read through the full config chain before the first frame | `LaunchSettings` (fps, renderMode, screenReader, ascii, noColor) resolved by `resolveLaunchSettings(flags, env)` — flag > env > default, no file — and fixed at mount; `UiConfig extends LaunchSettings` for the session settings after `firstFrame()`; §16 marks the four launch rows and `jevcode config` prints `ignored:launch` for a file key; `keybindings.json` and `history.jsonl` are read synchronously in the tick after `firstFrame()`, before any key can be dispatched (§1, §3.4, §4.6, §14.1, §15 items 16/17, §22) |
| 2 | blocker | keystroke → frame gate defeated by Ink's 34 ms throttle at 30 ms spacing | latency probe writes at ≥ 100 ms spacing (leading-edge render per key); the 30 ms burst is a reported `burst30` series only; the one-throttle-period cost of bursts is documented (§18) |
| 3 | major | `[ui]` lines excluded from `transcript.log` broke F13's identity | `Engine.annotate()` → `notice { kind: 'ui', label }` routes every renderer-originated line through `emit()`/`recordTranscript` while a run is live; only idle-time items (no run exists) are local; D12, §9.4, §15.1, §15.3, §22, §23 restated; ephemeral hints stay out of all three |
| 4 / 44 | major / blocker | git probe ↔ seatbelt ↔ `run.json` dependency cycle; `updateMeta` lacked `git` | `probeGitState(root)` runs unsandboxed inside `createEngine` before `createSandbox`; `createWorkspace(…, { gitState })` performs zero spawns; `store.create`/`updateMeta` after; `EngineOptions.git/gitDir/gitCommonDir` removed; `updateMeta` patch gains `git`; `RunGitMeta.end`/`resumedOn`; spawn-count test = 2 (§1, §12.1, §15 items 8/10/11/12, §15.2, D7) |
| 5 | major | 64 MiB synchronous hashing inside the overlapped checkpoint IIFE, invisible to the harness gate | streamed 4 MiB chunks with `setImmediate` yields, cap 16 MiB, awaited inside `runStep()` so `harnessMs` sees it, `StepTiming.imagesMs` recorded and gated, fixture 50 files / 15 MiB + one 60 MiB `hashSkipped` artefact (§12.3, §15 item 3, §18, D8) |
| 6 / 55 | major | eight steers concatenated and clipped to 600 | one `human` harness problem per directive (≤ 8 of 16 slots), `activeHuman.texts`, one hint line per directive, `state.human.directives`, `\n\n`-joined synth directive with no batch clip; §19.4 asserts eight problems (§8.6, §15 item 19, §15.2) |
| 7 / 23 | major | `steer()` redacted at queue time, so an acked secret reached the generator masked while `secret-ack` claimed otherwise | steers stored raw (sanitised + clipped) like `task`; `emit`/store/`state.ts` mask every artefact; `pendingDirectives` restored from disk are masked (P56); §19.4 asserts raw to the mock provider, masked in `steps.jsonl`/`state.json` (§8.6, §10.2) |
| 8 | major | Ctrl+L via `instance.clear()` leaves the region blank | `useStdout().write('')` — Ink's `writeToStdout` erases and repaints in one BSU/ESU pair; pty assertion frame-before = frame-after (§3.2, §0 F4, §18, §19.5) |
| 9 | major | clear-detection regex used an escaped pipe (a literal, not alternation) | `CLEAR_RE` rewritten with real alternation, given verbatim in a fenced block under the §18 table, plus a self-test the perf script runs first (§18) |
| 10 | major | "exactly one `ESC[?25l` per run" impossible with `useCursor` | per-frame rule: ≤ 1 hide per frame, frame ends with show while the composer is active, cursor-only frames write hide+return+move+show, final state shown (§18) |
| 11 | minor | layout invariant `rows ≥ overlayWant + 3` false | `rows ≥ max(8, overlayWant + 5)` for non-wizard overlays, `+ 4` for the wizard (§2.1) |
| 12 | minor | `/resume` child cap computed after adding the resumed spend | child created before the resumed spend is added (`min(runCap, remaining + resumedSpend)`); worked case + §19.4 test (§9.1) |
| 13 / 24 / 29 | minor / major / minor | S4 Ctrl-C "decline and abort" committed a fabricated `declined` step; no S4-with-text cell; secret-gate Ctrl-C inconsistent with §10.7 | S4 empty draft → `engine.abort('human_abort')` only (the rejected `confirm()` is the decline, rule-1 discard); S4 with a draft → clear the draft, box stays; precedence sentence (draft rule outranks); `ABORT_REVIEW` action; secret-gate Ctrl-C cancels and clears to history; §19.3/§19.4/§19.5 assertions (§3.3, §6.2, D2) |
| 14 | minor | side-by-side tabs contradicted F-J | one rule `columns ≥ 120 && rows ≥ 40 && overlay === 'none'`; `overlay` is a pane `lines()` input; F-D/F-J captions (§7.2) |
| 15 | minor | no 120×8/12/24 or 80×50 frames | F-X (120×8 review), F-Y (120×12 retry + pane), F-Z (120×24 palette), F-AA (80×50 9-row draft); closing paragraph re-derived (§2.3) |
| 16 / 35 | minor | steers queued while pausing lost on follow-up; `activeHuman` not restored on resume | `buildSeed` folds the parent's `pendingDirectives` into step-0 problems (notice counts them); `activeHuman` re-derived from `harnessProblems` on resume; S7 Enter cell reworded (§3.3, §8.3, §8.6, §15 items 9/11) |
| 17 | minor | two eager `Intl.Segmenter` singletons on the first-frame path | lazy singletons on first use; module-evaluation row in `perf/first-frame.ts` (§4.1, §18) |
| 18 | minor | `@` candidates before any engine/workspace exist | standalone `listCandidates(root, { secretPaths, redact })` from `workspace/files.ts`, called once after `firstFrame()`; hand-over at `run:ready` (§5.4, §15 items 8/16) |
| 19 | minor | `__JEVCODE_VERSION__` undefined under tsx/vitest; `engines <27` vs `depends_on "node"` | `src/version.ts` with a typeof guard and `readPackageVersion()` fallback; `engines.node >=22.12.0`; release-job check that the formula's node satisfies `engines` (§17, §15 item 19) |
| 20 | minor | `/calibration` scans 200 runs on the main thread | newest 50 runs or 32 MB; `readline` streaming of ≤ 20 fields; scanning toast (§7.6) |
| 21 | minor | F-C showed a counter and a tail together with an unbucketed number | live-region rule stated at the top of §7 (counter alone until the first line break, else the last two lines, `1.2k`); F-C and F-D redrawn |
| 22 | blocker | `addSecret` only for non-warn-only hits; PEM contradiction | `y` adds **every** hit span ≥ 8 (PEM whole block); C44 staging scoped to `patternRedact`; AWS + PEM canaries in §19.3/§19.4 (§10.1, §10.2, D4) |
| 25 | major | editor drafts written into the sandboxed `TMPDIR` | drafts under `<runDir>/drafts/` (pre-run `~/.jevcode/drafts/`), 0600, unlinked; Ctrl+G refused while the draft has a secret hit; pty case with a concurrent `run cat $TMPDIR/*` (§4.8, §8.1, §15 item 19, §19.5, §23) |
| 26 | major | stdin `'end'` → exit 129 applied to pipes and to `--plain` EOF | gated on `stdin.isTTY && stdin.isRaw`; pipe `end` is normal; `--plain` TTY EOF = F5 Ctrl-D rule (single press final, §22); pty case `echo task \| jevcode run --plain --mock` (§13.4, §19.5) |
| 27 | major | `forceExit`/5 s timeout `process.exit` without `restoreTerminal` | `process.on('exit', restoreTerminal)` in `installTerminalHygiene`; `EngineOptions.exit` always injected (`restoreTerminal` → epilogue → `process.exit`); S6 and the 5 s bound go through it (§3.3, §13.4, §14.2) |
| 28 | minor | SIGTERM → 143 unimplementable; Ctrl-D-live `[y]` 130 vs `/exit` 0 | `abort(reason, { signal })`, `AbortError.signalName`, `exitCodeFor(…, signal)` → 130/143/129, the `130 : 130` ternary fixed; Ctrl-D `[y]` exits 0 like `/exit` (item carries 130) (§3.3, §13.5, §15 items 1/15/19) |
| 30 | minor | Ctrl+Z self-sent SIGTSTP with no listener vs "RESTORE from SIGTSTP" | `process.on('SIGTSTP', suspend)` installed; stop via self-sent `SIGSTOP`; fallback timer and next-chunk raw re-apply kept (§14.2) |
| 31 | minor | external signals in session mode reopened the composer; `--plain` TTY Ctrl-C = SIGINT | `run:end` with `stopReason 'signal'` exits 130/143 without reopening; `--plain` TTY SIGINT follows the F5 matrix, readline `{ terminal: false }`, `'signal'` reserved for SIGTERM/SIGHUP/non-TTY, `/pause` the only plain pause path (§3.3, §14.2) |
| 32 | minor | `engine.abort('error')` not in the contract | `abort(reason: 'human_abort' \| 'signal' \| 'error', opts?: { signal?; error? })`; the `'error'` branch stores `fatalError` for `finish('error')` (§13.4, §15 item 15, §15.2) |
| 33 | minor | blocking pauses had no wait primitive | `EngineOptions.blocker(req) → Promise<BlockingAnswer>` awaited at the loop top, `blocking:request/resolved` events, auto-retry race for `jev-unreachable`, no-blocker default `'stop'`; §19.4 (§13.2, §13.3, §15 items 11/13/14, D10) |
| 34 | minor | typed-ahead defence only on the review box | §6.3's arming rule applied to every `y`-gated overlay (`armed` after the committed frame; same-chunk keys are text; 150 ms guard); the `d` note gate lives in the header's row 2 (§3.3, §4.10, §6.3, §9.3) |
| 36 | minor | argv/`--task-file`/stdin task text bypassed the gate | `readTask()` output through `detectSecrets` before `createEngine`: TTY gate row before `run:ready`; non-TTY/`--no-input`/`--json` exit 2 naming the label (§1, §10.2, §19.5) |
| 37 | minor | F-V `REDACTED-IN-FRAME` had no rule; "any frame" sweep unsatisfiable | the composer renders detected spans as `•` cells of equal width (`maskSpans` after `layoutRows`, cursor arithmetic unchanged); F-V redrawn; the sweep stands (§4.3, §2.3) |
| 38 | minor | SR review answer was a line-mode Enter approval | draft stashed when the review arms; only an exact `1`/`2`/`3`/`y`/`n` line typed after arming answers; §19.3 (§6.5) |
| 39 | minor | epilogue/fatal message not redacted | `epilogueLines(err, ctx, redact)`, `fatalExit` uses `serializeError(e, redact)`; canary test (§13.4, §13.5) |
| 40 | minor | `--allow-secret-mention` added only `SECRET_NAME_RE` lines | every `KEY=value` line with a value ≥ 8 chars plus `://user:pass@` components (§10.4) |
| 41 | minor | full sha256 of paste bodies in `ui.json`/history | 8-hex `fp8` fingerprint only; chip identity `n` + `bytes` (§4.5, §8.8) |
| 42 | minor | `/resume` after `/undo` carried no note | `EngineOptions.humanDirective` + `EngineOptions.undoLog` on that `/resume` (§5.2, §12.4, §15 item 11) |
| 43 | minor | XDG config dir not read-denied in the seatbelt | `configDirs` through `EngineOptions` → `SandboxCreateOptions` → `ProfileOptions`; test with `XDG_CONFIG_HOME=/tmp/x` (§11.2, §12.7, §15 items 11/17/18) |
| 45 | blocker | `undefined` assigned to optional properties under `exactOptionalPropertyTypes` | assignment rule in the §15 header; every prescribed assignment rewritten as a conditional spread (`parent`, `wake`, `note`, `matchesIntent`, `sessionId`); W0 `tsc` gate (§15, §15.2) |
| 46 | major | `GeneratorConfig.priced` required broke `test/unit/provider/helpers.ts` | `priced?: boolean` (always set by `validateGenerator`, absent = false); `test/unit/provider/**` added to O1 (§15 item 17, §20) |
| 47 | major | `budget:clamp`/`budget:override`/`budget:stop at 'follow-up'` emitted where no engine exists | `budget:clamp` from `EngineOptions.session.clamp` emitted by `main()`; `budget:override` only from `main()` for this resume's `overrides[]`; the session-cap change is a `note()`/`annotate()` line; the follow-up refusal is a controller line / `session:refused` (`at` back to `StoppedAt`); item table in §15.1 (§8.9, §9.3, §9.4, §15 items 11/14, §24) |
| 48 | major | the renderer had no redactor | `SessionHost.redact/addSecret/detectSecrets/note`; `Renderer.setHost()`/`setUi()` after the first frame; `addSecret` in `host.submit`/`host.steer` before `createEngine`/`engine.steer`; pre-host: `patternRedact` detection and Enter held (§4.9, §6.4, §10.2, §15 item 16, §19.3) |
| 49 | major | three `reviewHeaderLines` signatures; `matchesIntent` not on `ConfirmRequest` | one signature `reviewHeaderLines(req, n, columns)`; `ConfirmRequest.matchesIntent?`/`jevLatencyMs?` filled by `EngineImpl.confirm`; `confirmHeaderLines` 6 → 8 rows noted for O10 (§6.1, §15 item 6, §15.2, §19.0) |
| 50 | major | `submit.ts` had no owner | O3 owns it with `test/unit/tui/commands/submit.test.ts`; O2 list excludes it explicitly (§4.9, §19.0, §20) |
| 51 | major | `src/sandbox/run.ts` had no owner | O5 (`createSandbox` forwards `gitDir`/`gitCommonDir`/`configDirs`, hash includes them) + test (§12.7, §15.2, §20) |
| 52 | major | O6/O7 test globs overlapped; redaction tests in O6's tree | disjoint globs; `test/unit/config/redact.test.ts` moves to `test/unit/core/` in O7's first PR; "one directory, one owner" rule (§20) |
| 53 | major | `UiState`/`UiAction` left to O9; `run:start` never reset `done` | §15 item 20: exact `UiState` 1.1, `UiAction` union and the per-event transition table (`run:start` resets `done`, decisions, overlay, …); `'paused'` dropped from `RunPhase` (§15, §15.2, §19.0) |
| 54 | major | many new modules had no named offline test | §19.0 module → test file → assertions table for every §20 file plus the CI sync gate |
| 56 | major | `token_cap` did not survive `--resume` | `generatorTokens = Σ generatorTokensPerStep` on resume; `isPlainStopBudget`/`storedStopBlocks` gain `token_cap`; `/resume` rule and §19.4 (§8.7, §9.5, §15 item 1, §15.2) |
| 57 | minor | `retryWaker` lifecycle undefined | `onRetry` creates a fresh controller before each sleep; clients read `wake?.()` per attempt; `retryNow()` aborts the current one; `retry:settled` clears; unit test (§13.2, §15 item 5, §15.2) |
| 58 | minor | bench/perf `RunMeta.source` had no call-site owner | `src/bench/conditions.ts` (O1, W2) sets `source: 'bench'`; hidden `--source perf` for the perf drivers (O10); §19.4 assertion (§15 item 11, §15.2, §20) |
| 59 | minor | stale `types.ts` anchors; `store.ts L712` | anchors regenerated against HEAD as `types.ts:<line>` + symbol; `store.ts` row → `L28–37 (CHECKPOINT_FILES)`, `L352 (updateMeta)`; header says 1,115 lines (§15, §15.2) |
| 60 | minor | `[turn N]`, `[setup]`, `[config]`, `[sandbox]` labels no writer could print; unlabelled F-A row | `TranscriptItem.label?: UiLabel` preferred by `formatTranscriptItem` (renderer-local items and `notice kind 'ui'` only); `secret-ack` uses `[step N]`; F-A row `[ui] recent: …`; §24 strings in the parity fixtures (§2.3, §10.2, §15 items 14/19, §19.1, §24) |
| 61 | minor | `--resume <title>` validation placed in `args.ts` | `args.ts` accepts any non-empty value; `cli/session.ts` resolves id → title → prefix after `firstFrame()`; pipes get a `UsageError` before any run (§15.2) |
| 62 | minor | test paths outside owner globs; ten-run test in the wrong wave | paths normalised (`tui/commands/fuzzy`, `tui/layout/layout`, `tui/composer/rows`); O9 glob covers `reducer.test.ts`; ten-run split into O6 wave 1 (seed/index/meter) and O10 wave 3 (controller) (§18, §19.7, §20) |
| 63 | minor | the first steer deleted the seed's follow-up framing and `/undo` notes | seed/undo problems carry `step: 0` and are never superseded (steers are `step > 0`); step-0 problems expire at step > 8; §19.4 seed/steer test (§8.3, §8.6, §15 item 19) |

Not changed on purpose: none of the findings asked for a change that conflicts with F1–F18 once the F1/F14 and F5/`--plain` reconciliations above are recorded in §22; `retryNow` and `annotate` remain the two methods beyond F13's named `Engine` trio, each justified in §22.
