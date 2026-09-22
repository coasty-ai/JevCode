# JevCode TUI round 3 — implementation design (jev+llm by default, one-key onboarding, TypeSafe pink, the persistent wordmark, commands, polish)

Written 2026-09-21 against HEAD `2ea8c40` (0.3.0: `src/tui/App.tsx` 2,378 lines, `src/cli/session.ts` 3,664, `src/tui/useEngine.tsx`
1,024, `src/tui/theme.ts` 239, `src/tui/splash.ts` 179, `src/tui/layout.ts` 204, `src/tui/status/lines.ts` 588, `src/tui/commands/registry.ts`
556, `src/tui/commands/palette.ts` 361, `src/tui/onboarding/reducer.ts` 428, `src/tui/onboarding/lines.ts` 311; Ink 7.1.1, React 19.3.0,
Node 22, runtime deps `ink` + `react` only). It is the single implementation input for the five slots of §7 and synthesises the five
round-3 research reports under `docs/research/tui/round-3/`: `theme.md` (`R1 §n`), `wordmark.md` (`R2 §n`), `onboarding.md` (`R3 §n`),
`commands.md` (`R4 §n`), `polish.md` (`R5 §n`). `docs/TUI-DESIGN-2.md` is `TD2 §n`, `docs/TUI-DESIGN.md` is `TD §n`. Line anchors are
`file:line` at HEAD (the reports were written at `626fc40`/`d09e24c`; `src/cli/session.ts` and `src/cli/args.ts` changed since — `args.ts`
moved in `2ea8c40`: `--mode` help `:244`, the `oneOf` mode check `:646–649`, the usage tagline `:746`, the bare-`jevcode` sentence `:750` —
and every number below was re-read against `2ea8c40`). §13 is the review log: every finding of the design review and what moved. Where two reports disagree, §12 records which won and why; implementers
read this document and open a report only for rationale. Frames are captioned `**F-X. … W×H (D dynamic rows; S scrollback rows
above)**` in the `readFrames` grammar of TD2 §8.1 S4; every frame row below was width-checked by script at its geometry. `›` is the
composer prompt, `╭ ╮ ╰ ╯ │ ─ ├ ┤` the cli-boxes `round` set (`+ - |` under `--ascii`), `▓` the new spinner (§5.2), `–` the `step 0/–`
sentinel. Read §0 → §6 → §7 (your slot) → the sections your slot's row names.

Standing constraints every proposal keeps (the brief; §9 names the gate per change): first frame < 300 ms with zero network before
it; zero terminal clears outside shrink resizes; composer keystroke → frame p95 < 16 ms with key frames on Ink's immediate path
(TD2 D-F); dynamic frames ≤ maxFps + 1 during a live run; `--plain` / `transcript.log` / TUI line identity for transcript items (the
text of an item changes only in its one shared formatter, with tests); keys never printed or logged; no auto-approve; reduced motion
(`--no-animation`, `JEVCODE_REDUCED_MOTION`, `NO_COLOR`) and screen-reader mode keep working; the flat chrome tier below 16 rows and
the SSH fps-15 tier keep working; no new dependency; strict types, no `any`.

---

## 0. Owner decisions (D-G … D-R) and how each is honoured

The first three were taken before this document and are not reopened. D-J … D-R are this document's decisions (D-Q and D-R were added after the design review, §13); the ones marked
**ratify** need the owner's word before the slot that lands them starts (the `ownerDecisions` list of the workflow summary repeats
them with the recommendation).

| Decision | Status | Honoured in | How |
| --- | --- | --- | --- |
| **D-G** default engine mode `jev-on` (badge `jev+llm`): the generator writes code, Jev decides every step; one OpenRouter key serves Jev (`openrouter.ai/api/alpha/decisions`) and the default generator `z-ai/glm-5.3-flash`; `DEFAULT_MODE` stays a one-line constant so the peer's `llm-jev` can become the default later; TypeSafe native Jev stays supported and preferred whenever `TYPESAFE_API_KEY` exists | taken | §1 | `DEFAULT_MODE: EngineMode` (`src/config/defaults.ts:44`) is read by every fallback that names the default today (§1.1 table: ten source sites); the badge word comes from one table `MODE_BADGE_WORD` beside it; the session follows `config.mode` (§1.2); the wizard's one `key` step writes the file keys its `found` state calls for — four from one paste when nothing resolves, the generator key alone beside a resolving TypeSafe/Jev key, so a file `jevProvider` never displaces `TYPESAFE_API_KEY` (§1.4.3 save-shape table); TypeSafe rule 2c (`resolve.ts:354–371`) is untouched |
| **D-H** the TypeSafe pink palette measured on typesafe.ai 2026-09-21 (`#1e1e1e` bg, `#fefefe`/`#dedede`/`#e5e5e5` text, primary `#f386a1`, secondary `#d45bb6`, greys `#abbab9`/`#c4c4c4`, teal `#09aea1`, green `#03aa5c`) used everywhere the site is known for pink | taken | §2 | the `dark` theme becomes *TypeSafe pink* (id unchanged): primary = rest/brand (`accent`, `badge`, `assistant`, `chosen`, the idle `›`, the wordmark letters), secondary = active/selected (`borderFocus`, `you`, `accent2`, the palette `▌`); meaning colours (red/amber/green) unchanged in hue; every pink role keeps its text marker; light/daltonized/ansi twins recomputed with contrast numbers |
| **D-N** the peer's `llm-jev` badge word is `llm+jev · verified`; no string anywhere hard-codes which mode is the default | taken | §1.1, §10 | `MODE_BADGE_WORD['llm-jev'] = 'llm+jev · verified'`; `/mode` with no argument marks the default as ` (default)` computed from `DEFAULT_MODE`; a unit test greps `src/**`, `scripts/**` and the generated docs for `jev-only (default`, `the default | jev` and every literal that names a default outside `defaults.ts` |
| **D-I** the wordmark stays: it is the pane slot's idle tenant, whole or absent, shown while idle and thinking, hidden while a run is live or a panel/picker/review owns the slot, back under the strip after `run:end` (at once at ≥ 24 rows; at 21–23 rows on the first key after the end, so the epilogue stays on screen); shown only at ≥ 21 rows (`WORDMARK_MIN_ROWS`: no palette or draft ever hands it off and back); its animation continues as the splash's own 6-cell sweep looping at 4 fps peak / 1.6 fps mean with a 3 s quiet-after-key rule and attention decay; `ui.wordmark: sweep \| static \| off` is the escape hatch | **ratify** (recommended) | §3 | R2's design over R5's "hero until the first submission" (§12 row 1): the user's words were "keep that animation … not disappear once it loads"; the loop is that animation; the mark returning after a run is what makes every idle screenshot the brand. Measured cost ≈ 18 ms CPU/s attentive, 0 after 10 min |
| **D-J** one-key onboarding: the wizard opens on one masked `key` field when both secrets are missing and nothing infers a Jev provider; Esc on the empty field opens `options` (OpenRouter · TypeSafe · Jev only · Anthropic — a digit highlights and shows its one-line consequence, the same digit or Enter confirms; `3` at startup persists `mode: jev-only`); verification on an explicit `y` (Enter/Esc skip) sends one real Jev decision (~$0.00002), one 1-token GLM completion (~$0.000002) and `GET /api/v1/key` ($0), with four outcomes; a `[setup] spend caps` item after a wizard save; `jevcode login --key-stdin` | taken (R3's decision, adopted); **ratify** the one extension the review added — option `3` at startup writes `mode: jev-only` to the config file (a write the first draft avoided; §13 row 18) | §1.4–1.7 | OpenRouter's `/api/v1/key` cannot see the balance of an unlimited key and `/api/v1/credits` needs a management key (R3 F14), so only a priced request reveals a 402 |
| **D-K** shortcut aliases (§4.1: 21 new; `a` for `/abort` and `x` for `/exit` dropped and `/new` gets `nw` — no one-letter alias for a command whose Enter destroys state without a confirm), the exact-alias pin rule in the palette, alias column, `→ /owner` ghost, Popular/Recent groups, Tab completing arguments; the R4 audit's 23 findings fixed as §4.4 lists; availability errors clear the draft, fixable errors keep it | **ratify** the draft rule and the alias set | §4 | R4 P17 changes a TD §4.9 sentence ("errors keep the draft"): measured chains `› /steer x/pause` (R4 F21) show the kept draft turning the next command into garbage; only errors the user can fix by editing keep it |
| **D-L** a fixed 10-cell right-aligned label gutter in the TUI transcript (`[jevcode]`/`[sandbox]` flush, shorter labels padded), detail rows indented under column 10, segment-aware wrap at ` · ` with a no-orphan rule (a final token < 4 cells never sits alone) | **ratify** (recommended) | §5.1 | the visible price: `[you]` and `[run]` bodies lose four cells at 80 columns (a 71-character task that fits today wraps, F-R4); the gain: every body starts at column 10, `/jev`, `/cost`, the epilogue read as blocks, `exit` / `4` never wraps alone. The identity predicate becomes the §5.3 normaliser; no item text changes |
| **D-M** transcript **text** changes this round are limited to local `[ui]`/`[setup]` items (`/cost` head, `~$0.000006 each`, `/jev` last-intake row, the default-mode item) and the renderer-local `[sandbox]` item; R5 P5's `[run] start/end`, `replan`, `loop tripped` rewrites are **deferred** to round 4 | **ratify** (recommended: defer) | §5.3 | `src/perf/pty.ts:800` `END_PATTERN = 'end [a-z_]+ steps='` and twelve test files (`plain.test.ts`, `round2-transcript.test.tsx`, `height.test.tsx`, `picker.test.tsx`, three `test/unit/loop/*`, `ten-run-seed.test.ts`, four pty suites) pin the `steps=` form; §5.1's wrap rule removes the visible defect (F5) without touching `transcript.log` |
| **D-O** the composer prompt `›` is pink (`accent`) at rest and amber (`steer`) while a run is live; `[you]` and `[jevcode]` **labels** carry the two pinks (bold), **bodies** stay the terminal's default foreground | decided (R1 open question 2 / R5 §4 rule 2 reconciled) | §2.6, §5.1 | "messages super easy to read": a paragraph of magenta at 4.74:1 (4.27:1 on Solarized dark) is not; a 5-cell label is. The steering prompt must not look like the idle prompt (R1 §8) |
| **D-P** the spinner becomes the brand's shade pulse `░ ▒ ▓ █ ▓ ▒` in `accent` at the existing 8 fps (static `◆` under reduced motion; `. + # # + .` / `*` under `--ascii`); the status row colours the left word and the meter words only, never the whole row | decided | §5.2, §2.6 | the reveal head is already `▓▒░`; one glyph family for boot, idle and thinking. Frame count unchanged (the 125 ms tick is the same timer) |
| **D-Q** a keyed start (no wizard) whose `mode` resolves from `default` and whose config file has no `mode` row prints one `[setup]` item naming the default, its caps and the two ways to keep or change it (`defaultModeItem`, §1.7); it prints at every such start until a `mode` row exists — the row is the state, no marker file, no write on a keyed start | **ratify** (recommended) | §1.3.1, §1.7 | R3 §9 risk 2: a round-2 `OPENROUTER_API_KEY` user who never asked for an LLM now pays GLM on every run with caps raised from $0.25 / $1.25 to $2.00 / $10.00, and the first draft printed nothing ("a keyed start stays quiet"); a CHANGELOG line is not consent. The alternative — a one-time `seen.*` config key written on a keyed start — adds a config write to a path that never wrote before |
| **D-R** `COLORFGBG` (iTerm2, Konsole, rxvt, mintty set it) picks the default theme at launch: a background index of 7 or 15 selects `light` unless `--theme` / `JEVCODE_THEME` / `ui.theme` is set; env only, zero I/O, frame 0 already right | decided | §2.2, §2.8 | `themeFor` never auto-detects (C15) and Terminal.app's default Basic profile is black-on-white: cell 211 `#ff87af` on `#ffffff` is 2.25:1 — worse than the light-theme defect §2.2 fixes. Terminal.app sets no `COLORFGBG`, so `docs/TUI.md` gains the `config set ui.theme light` note and `HELP_NOTES` the `light terminal? /theme light` line |

**Kept from TD/TD2, untouched:** one modal slot, one `computeLayout`, `<Static>` the only scrollback writer, zero clears, `lines()`
twins, no new dependency, Jev decides; the review invariants (`app.test.tsx:342–461`); `itemsFromEvent`/`formatTranscriptItem` as the
one item source; `useAnimation(` only in `motion.ts`, `setInterval(` only in `spinner.ts`/`retry.ts` (`spinner.test.ts:99–116`);
`src/synth/**`, `src/bench/**`, `src/loop/**` read-only this round.

---

### 0.1 Owner ratification (2026-09-21, before implementation)

| Decision | Owner's word |
| --- | --- |
| D-I | **Ratified** as written (idle tenant at ≥ 21 rows, return rules, calm-on-reply, static under SSH, `ui.wordmark` escape hatch). |
| D-J extension | **Ratified**: option `3 Jev only` at a startup wizard persists `mode: jev-only` (one `writeConfigValue`); under `/login` it only pends. |
| D-K | **Ratified**: the 21-alias set with `nw` for `/new`, `q`/`quit` for `/exit`, no one-letter alias for `/abort`, `/exit`, `/new`; exact-alias pin; availability errors clear the draft, fixable errors keep it. |
| D-L | **Ratified**: the 10-cell right-aligned gutter, segment-aware wrap with the no-orphan rule, identity by the §5.3 normaliser. |
| D-M | **Ratified (defer)**: engine-item text rewrites (`[run] start/end`, `replan`, `loop tripped`) go to round 4; only the local `[ui]`/`[setup]`/`[sandbox]` texts change this round. |
| D-Q | **Ratified with one change — one-time, not every start.** The `[setup]` default-mode item (§1.7) prints on a keyed start whose `mode` resolves from `default` and whose config file has no `mode` row **only when the config file's `seen.defaultMode` value differs from `DEFAULT_MODE`**; printing it writes `seen.defaultMode = DEFAULT_MODE` (one `writeConfigValue`, the same write path the trust gate uses; a read-only config directory downgrades to printing at every start with no error). Consequences: a user who accepts the default sees the item once; a later flip of `DEFAULT_MODE` (to `llm-jev`) shows it once more with the new caps; a `mode` row in the file still suppresses it entirely. The designer's every-start variant is rejected because the common case — a user happy with the default — would read the same notice at every launch until typing a config command. §1.7 and §1.3.1 are to be read with this rule; the S3 implementer adds the `seen.defaultMode` config row (string, non-secret, hidden from `jevcode config` unless `--all`) and its tests (first start prints + writes; second start silent; file with `mode` row silent; `DEFAULT_MODE` change prints again; read-only directory prints and warns once in the log). |
| D-R | Noted as decided. |

### 0.2 Integration amendments (2026-09-21, owner, after the slots landed)

| Item | Amendment |
| --- | --- |
| D-R / §2.2 frame-0 theme | An explicit `--theme <name>` or `JEVCODE_THEME` naming a known theme (`dark` · `light` · `daltonized` · `ansi`, case-folded) is frame 0's theme too (`LaunchSettings.themeHint`, argv/env only, zero I/O; source `flag` / `env`) — the splash and the console never paint the dark palette before the resolved `ui.theme` takes over at `setUi`. An unknown explicit value leaves the hint absent (the `ui.theme` setting reports it) and still suppresses the COLORFGBG rule. Measured cause: `--theme light` painted `38;5;211` for the first 700 ms (theme-light / theme-ansi scenarios). |
| §9 V14 | Rows whose left zone is a toast (`! …`, `✓ …`, `• …`) are exempt from the ≤ 30 % coloured-span rule: a level-coloured toast such as `! press Ctrl-C again to exit` is 28 of 76 cells by design (§5.2 A7). |
| §4.4 F13 | The dispatcher passes `/rename`'s title whole; the controller clips once (`text60`, 59 cells + `…`) and appends ` (cut to 60 chars)`. |
| §3.1 return after `run:end` | The mark returns in the same frame as the `[run] end` item (the epilogue item and the state change commit together), one frame earlier than "the `end` frame itself (the epilogue item and the state change commit together)"; the scenarios accept either. |
| §10 `/jev` | The intake row and the last-intake row are two rows: `intake: <n> message(s) · p50 <ms> ms · $<usd>` and `last: <kind words> (<p>)`. |

## 1. Default jev+llm mode and one-key onboarding (D-G, D-J, D-N)

### 1.1 One constant, one table, and the ten fallbacks that stop naming a mode

```ts
// src/config/defaults.ts:43–44 — S3, commit 1 (type widened, value unchanged); the flip (commit 2, §1.10) changes the literal only
export const MODE_SETTING_VALUES = ['jev-only', 'jev-on', 'jev-off', 'llm-jev'] as const;
export const DEFAULT_MODE: EngineMode = 'jev-only';            // commit 2: 'jev-on' (D-G); later: 'llm-jev' (the peer's flip) — nothing else moves
/** D-N: the badge word per mode — the ONLY table that maps a mode to a word; `·` is folded to the glyph set's dot by `modeBadgeWord(mode, g)` */
export const MODE_BADGE_WORD: Readonly<Record<EngineMode, string>> = { 'jev-only': 'jev-only', 'jev-on': 'jev+llm', 'jev-off': 'llm-only', 'llm-jev': 'llm+jev · verified' };
/** the badge is capped so `<badge> · next run` fits the 60-column top edge (`consoleTopEdgeParts`, console-lines.ts:14 `TOP_EDGE_FIXED = 8`) */
export const MODE_BADGE_MAX_CELLS = 20;
```

Every site below reads `DEFAULT_MODE` (or the table) instead of a literal. `'jev-only'` comparisons that are **semantics** (a mode
that needs no generator: `resolve.ts:687`, `session.ts:2948,2954`, `reducer.ts:211`, `login.ts:507,517`, `ui.ts:82`
`defaultRunSpendCapUsd`, `status/lines.ts:356,438`, `budget/lines.ts:338`) stay as they are.

| Site (HEAD) | Today | After (S3 unless noted) |
| --- | --- | --- |
| `src/config/resolve.ts:374–377` `modeFromParsedFlags` | `m === 'jev-on' \|\| … ? m : 'jev-only'` | `MODE_SETTING_VALUES.includes(m) ? m : DEFAULT_MODE` |
| `src/config/resolve.ts:390` `modeRow` | `spec.defaultValue ?? 'jev-only'` | `spec.defaultValue ?? DEFAULT_MODE` |
| `src/config/launch.ts:37–40` `parseModeHint` | three literals (no `llm-jev`: R3 F2) | `MODE_SETTING_VALUES.includes(t) ? t : null` |
| `src/cli/main.tsx:38–41` `modeFromFlags` | duplicate of `modeFromParsedFlags` (no runtime consumer) | deleted; `main.test.ts:125–133` moves to `resolve.test.ts` |
| `src/cli/login.ts:247` `loginMode` | `?? 'jev-only'` | `?? DEFAULT_MODE` |
| `src/cli/tui-prompter.ts:172,178,204` | `?? 'jev-only'` / `?? 'jev-on'` (trust) | `?? DEFAULT_MODE` (all three) |
| `src/tui/App.tsx:560` | `modeHint: lx.modeHint ?? 'jev-only'` | `?? DEFAULT_MODE` (S2 lands, W2) |
| `src/tui/useEngine.tsx:366` | `opts.modeHint ?? 'jev-only'` | `?? DEFAULT_MODE` (S2) |
| `src/tui/onboarding/reducer.ts:197` `INITIAL_ONBOARDING.mode` | `'jev-only'` | `DEFAULT_MODE` |
| `src/tui/onboarding/lines.ts:303` `fixBlockLines(mode = 'jev-only', …)` | default argument | `mode: EngineMode` **required** (every caller passes it, §1.6) |
| `src/tui/theme.ts:108,127` `badge.marker: 'jev-only'` | the theme names the default | `marker: '<mode>'` (S1, §2.1) |
| `src/tui/status/lines.ts:105–109` `ModeBadge`, `modeBadgeWord` | a ternary with `llm-jev → 'llm-jev'` | `export type ModeBadge = string; export function modeBadgeWord(mode, g = GLYPHS.unicode) { return MODE_BADGE_WORD[mode].replaceAll(' · ', \` ${g.dot} \`); }` (S5 lands, W1 first thing) |
| `src/chat/replies.ts:98–100` `modeWord` | a second ternary | `export const modeWord = (m: EngineMode) => MODE_BADGE_WORD[m]` |
| `src/chat/facts.ts:110,118,126` | "Claude writes the code" ×3; a ternary of mode sentences | `MODE_SENTENCE: Record<EngineMode, string>` (§1.9) |
| `src/cli/session.ts:241–244, 2792` | four `MODE_*_SET` constants and a ternary chain | `MODE_SET_ITEM: Readonly<Record<EngineMode, string>>` + `modeSetItem(mode)`; the strings of §10 "Mode items" |
| `src/cli/args.ts:244` `--mode` help; `:750` the bare-`jevcode` usage sentence (`:746` is the tagline, §1.9; `:646–649` validates `--mode` against `MODES`, unchanged) | `jev-only (default; …)`; `in jev-only mode (one Jev key suffices; /mode jev-on adds the LLM)` | ``engine mode (default ${DEFAULT_MODE}): jev-only (Jev alone, no generating LLM), jev-on (Jev + the code model), jev-off (generator only), llm-jev (candidate patches, tests verify, Jev arbitrates)``; ``A bare `jevcode` opens the interactive session in ${MODE_BADGE_WORD[DEFAULT_MODE]} mode (one OpenRouter key serves Jev and the code model; /mode jev-only runs on Jev alone); `/` lists commands, `?` shows the keys.`` |
| `src/tui/commands/registry.ts:67` comment; `scripts/gen-docs.mjs:229` man ENVIRONMENT | "jev-only is the default"; `(jev\-only, the default \| jev\-on \| jev\-off)` | comment names no default; `${ENGINE_MODES.join(' | ')} (default ${DEFAULT_MODE})` derived (S4) |
| `test/pty/run-smoke.sh:16`, `README.md`, `docs/TUI.md` §Modes, `man/jevcode.1`, completions, `.env.example`, `CHANGELOG.md` | prose | §1.10 re-pin list (S5 / generated) |

**Test (S3, `test/unit/config/defaults.test.ts`):** `MODE_BADGE_WORD` has a row for every `MODE_SETTING_VALUES` member; every word ≤
`MODE_BADGE_MAX_CELLS`; `MODE_BADGE_WORD['llm-jev'] === 'llm+jev · verified'`. **Test (S3, new `test/unit/config/no-default-literal.test.ts`):**
reads every `.ts`/`.tsx` under `src/` and `scripts/gen-docs.mjs`, asserts no line matches `/jev-only \(default|, the default\)|is the default|default mode is/`
outside `src/config/defaults.ts`; asserts `docs/COMMANDS.md` and `man/jevcode.1` (after `gen-docs`) carry `default ${DEFAULT_MODE}` and no other
`default <mode>` token.

### 1.2 The session follows `config.mode`; the badge follows the session (R3 F1/F2 — a prerequisite of the flip)

Today `baseMode` is initialised from argv (`session.ts:1019 let baseMode: EngineMode = modeFromParsedFlags(flags)`) and `applyConfig()`
(`:1499–1507`) copies `workspace`, `ui`, `runCapUsd` and the thresholds but never `config.mode`; the badge action `{ type: 'mode' }` is
dispatched by `/mode` only (`:2791`). Under a `jev-on` default a round-2 user with `mode: "jev-only"` in `config.json` or `JEVCODE_MODE`
would get the caps of one mode and a session in the other, and the wizard at every start.

```ts
// src/cli/session.ts:1499–1507 — applyConfig(): the guarded copy and the badge dispatch added (S3, W2)
function applyConfig(): void {
  if (!config) return;
  workspaceRoot = config.workspace;
  // flag > JEVCODE_MODE > ./.env > <extra .env file> > file `mode` > DEFAULT_MODE (resolve.ts:384–391). A pending `/mode` re-enters the
  // flag layer through pendingFlagOverrides() (:1491–1497), so after a reresolve() config.mode equals the PENDING mode: the base moves only
  // while nothing is pending, and the badge action carries the pending mode separately (` · next run` survives a wizard save)
  if (pending.mode === undefined) baseMode = config.mode;
  extras.dispatch?.({ type: 'mode', mode: live() && current !== null ? currentRunMode : baseMode, pending: pending.mode ?? null });
  uiConfig = { ...config.ui(o.launch), ...(themeOverride !== null ? { theme: themeOverride } : {}) };
  renderer.setUi?.(uiConfig);
  runCapUsd = config.limits().spendCapUsd;
  pushThresholds(config.limits());
}
```

Edge cases: a `/mode` pending survives `reresolve()` because `pendingFlagOverrides()` (`:1491–1497`) re-enters `pending.mode` as the flag
layer — which is exactly why `baseMode` must **not** copy `config.mode` while `pending.mode` is set: `/mode jev-on` → wizard save →
`persistCredentials` → `reresolve()` would otherwise promote the pending mode before any run started, drop ` · next run` from the badge
(`status/lines.ts:110–112` shows the suffix only while `pending !== mode`) and make the F1 echo read `mode jev+llm — next run: jev+llm`;
`run:start` (`currentRunMode`) is the only promotion; the `--resume` path
(`:2072`) resolves with `opts.mode` for the run's identity and does **not** call `applyConfig` — only the startup `resolveConfig` (`:3496`)
and `reresolve()` (`:1485`) update `baseMode`; the first frame under a file-set mode shows the argv badge for one `resolveConfig`
(< 100 ms after the first frame — the same class as the `setUi` theme correction; R3 edge 27); `--mode llm-jev` shows
`llm+jev · verified` from frame 0 once `parseModeHint` accepts it. **Tests (S3):** `session.test.ts` new cases `env: { JEVCODE_MODE: 'jev-only' }`
with no mode flag → `controller.view.mode === 'jev-only'`, the startup wizard lists the Jev key only, `state.modeBadge.mode === 'jev-only'`
after `applyConfig`; `/mode jev-on` followed by a wizard save → the badge keeps `jev+llm · next run` until `run:start` and the `/mode` echo
names two different words; a file `mode: "jev-on"` with only `OPENROUTER_API_KEY` → no wizard, badge `jev+llm`; `launch.test.ts:13–21` gains
`--mode llm-jev` → `modeHint 'llm-jev'`; pty `r3-env-jev-only.steps` (S5) — `JEVCODE_MODE=jev-only` + fake `OPENROUTER_API_KEY`, expects
`╭─ jev-only` and no wizard.

### 1.3 The state matrix (behaviour after the flip; today's column is R3 §2)

Conventions: "wizard(X)" = the startup wizard opens at step X; "ConfigError" = exit 2 with `missing <names>: set the environment
variable or run jevcode login` followed by the fix block (§1.6); caps are run / session (`defaultRunSpendCapUsd`, `ui.ts:82`: $0.25 / $1.25
jev-only, $2.00 / $10.00 every other mode). Rules 2a–2e are `resolve.ts:354–371` (base-URL host → `JEV_API_KEY` → `TYPESAFE_API_KEY` →
`OPENROUTER_API_KEY` → `openrouter`).

**1.3.1 Keys present (any layer, valid) × a bare `jevcode` on a TTY, `DEFAULT_MODE = 'jev-on'`**

| Keys present | Behaviour |
| --- | --- |
| none | wizard(`key`): one masked OpenRouter field; Enter saves `apiKey` + `jevApiKey` + `provider: openrouter` + `jevProvider: openrouter` from one paste; Esc on the empty field → `options`; `y` at `verify` runs the three calls of §1.5; `[setup] spend caps` item; trust; sandbox; badge `jev+llm` from frame 0; Ctrl-C at `key`/`options` → the jev-on fix block, exit 2 |
| `OPENROUTER_API_KEY` only | no wizard; the key serves both (`generator.apiKey` via `OPENROUTER_API_KEY`, `resolve.ts:507–508`; `decider.apiKey` via row order, `defaults.ts:110`); badge `jev+llm`; caps $2.00 / $10.00; **one `[setup]` item** `defaultModeItem(…)` (§1.7, D-Q) because the `mode` row resolves from `default` and the file has no `mode` row — it stops once `jevcode config set mode <m>` writes one |
| `TYPESAFE_API_KEY` only | `missingSecrets('jev-on') = ['generator.apiKey']` → wizard(`key`) with the found-title `TypeSafe key found — Jev runs there. Code model: paste an OpenRouter key`; Enter saves **`apiKey` + `provider: openrouter` only** — never `jevProvider` / `jevApiKey` (rule 1 reads a file `jevProvider` before rule 2c and would send Jev to openrouter.ai at the next start, §1.4.3); Esc → `options`: `3` then `3` / Enter **persists `mode: jev-only`** (`writeConfigValue`, one row), prints `modeSavedItem(path)`, badge `jev-only` (the base mode, nothing pending), and the next start opens no wizard; Ctrl-C → fix block naming both routes, exit 2 (edge 15) |
| `ANTHROPIC_API_KEY` only | both missing (the default provider `openrouter` never reads the Anthropic key, R3 F16) → wizard(`key`) with the found-title `Anthropic key found — it writes the code. Jev needs an OpenRouter key:`; the field is the **Jev** key: Enter saves `jevApiKey` + `jevProvider: openrouter` + `provider: anthropic` (never `apiKey`, so GLM never silently replaces Anthropic); a TypeSafe key belongs to `options` `2` and the hint says so; Esc → `options` with `4` highlighted; Enter on `4` saves `provider: anthropic` alone (a provider-only save is allowed when the key resolves from the env) then `jevProvider` → `jevKey` (today's path) |
| `JEV_API_KEY` only (an OpenRouter key), or a Jev key a round-2 wizard saved (file `jevApiKey`) | Jev resolves (rule 2b, or the file); generator missing → wizard(`key`) with `Jev key found (JEV_API_KEY) — code model: paste an OpenRouter key` (`(config file)` / `(dotenv)` for the other sources — `found` reads the resolved entry's source, not the env alone, so an upgrading round-2 user never meets the `provider` step's `No API key found` title); Enter saves `apiKey` + `provider: openrouter` only; Enter on the empty field copies the found value into the file as the generator key when it starts with `sk-or-`, and the hint says the value will be written (edges 11, 17) |
| `OPENROUTER_API_KEY` + `TYPESAFE_API_KEY` | typesafe for Jev (2c beats 2d), generator from OpenRouter; no wizard; badge `jev+llm` (the owner's own round-2 `.env` opens with no question) |
| `OPENROUTER_API_KEY` + `ANTHROPIC_API_KEY` | no wizard; generator openrouter/GLM (the default provider wins; the Anthropic key is redacted, unused); `/provider anthropic` switches; `[config]`/facts name the generator provider |
| `TYPESAFE_API_KEY` + `ANTHROPIC_API_KEY` | generator missing under provider openrouter → the TypeSafe-found `key` wizard; Esc → `options` with `4` highlighted → Enter saves `provider: anthropic` only (the Anthropic key resolves from the env) |
| all three | typesafe Jev, generator openrouter/GLM; no wizard |
| `--mock` (any keys) | nothing missing (`resolve.ts:614–615,687–688`); badge `jev+llm`; the scripted `--mock` trajectory is a generator trajectory, so `MOCK_RUN_MODE` (`test/pty/helpers.ts:755`) becomes redundant — kept, harmless |

**1.3.2 Key state × where it bites (one OpenRouter key)**

| Key state | startup (offline) | `verify` on `y` | first `hi` (intake) | first run |
| --- | --- | --- | --- | --- |
| valid | no wizard | `verified: jev ok (typesafe/jev-1.13-20260917, 318 input tokens, $0.00002)` · `verified: z-ai/glm-5.3-flash ok (1 token, $0.000002)` · `verified: openrouter key ok (label "<l>", limit remaining $x)` | `[jevcode]` reply ≈ 250 ms, ≈ $0.00007 | as today |
| invalid (401/403) | no wizard (nothing is sent before the first frame) | `verification failed: openrouter HTTP 401 — the key was kept; fix it with /login`; the wizard returns to `key` with `HINT_REJECTED` | bubble `Jev rejected the key (HTTP 401). /login saves a new one.` + wizard reopened at the one `key` field (both sides are openrouter); the generator's 401 reads `z-ai/glm-5.3-flash rejected the key (HTTP 401). /login saves a new one.` | `key-rejected` pane, `[l] /login`, exit 2 (unchanged) |
| valid, no credits (402) | no wizard | `verification: no credits left on this OpenRouter key (HTTP 402) — add credits at openrouter.ai/credits; the key was kept` (reason `credits`, `login --verify` exit 5); the wizard continues | bubble `CREDITS_EXHAUSTED` (§1.7) instead of today's "unreachable" (R3 F10) | `spend-limit` pane, exit 5 (unchanged) |
| valid, rate-limited (429) | no wizard | `verification: OpenRouter is rate-limiting this key (HTTP 429) — try again in <Retry-After>s; the key was kept` (reason `unreachable`, exit 5) | client retries with `Retry-After`, then `INTAKE_UNREACHABLE` (unchanged) | `jev-unreachable` pane with auto-retry (unchanged) |
| valid for Jev, generator model 400/404 (`--model typo`) | `generator.model "<m>" has no pricing entry …` warning (`validate.ts:196–204`) | `verification: the code model "<m>" is not served by openrouter.ai (HTTP 404) — pass --model, or jevcode config set generator.model <id>; the key was kept` (reason `model`, exit 2) | code question: `LLM_UNREACHABLE` (unchanged) | step error, exit 5 (unchanged) |
| present but < 8 characters | `missingSecrets` counts it present; the redactor ignores it (`MIN_SECRET_LENGTH`) | 401 | 401 | 401 — unchanged; a typed key is floor-checked at Enter (`reducer.ts:337`) |

**1.3.3 Mode sources × renderers and environments**

| Cell | Behaviour |
| --- | --- |
| file `mode: "jev-only"` (a round-2 user), no flag | session jev-only after `applyConfig` (§1.2); first frame `jev+llm` for < 100 ms then `jev-only`; caps $0.25 / $1.25; no wizard with a TypeSafe or OpenRouter key; `jevcode config` prints `mode  jev-only  file:<path>` |
| `JEVCODE_MODE=jev-only` in the env | badge `jev-only` from frame 0 (`launch.modeHint`), session jev-only, the wizard asks the Jev key only |
| `JEVCODE_MODE=jev-only` in `./.env` | same; the badge corrects at `applyConfig` (dotenv is not a launch source) |
| `--mode <m>` / `--condition <m>` | flag layer for config and session (unchanged); `--mode llm-jev` badge from frame 0 |
| `--mode nope` | `UsageError` exit 2 (`args.ts:641–643`, unchanged) |
| pipe / non-TTY (`jevcode run "task"`), no keys | plain renderer, no prompter → `ConfigError missing generator.apiKey, decider.apiKey: set the environment variable or run jevcode login` + `fixBlockLines('jev-on', null)` (§1.6), exit 2, no run dir; with `TYPESAFE_API_KEY` only: `missing generator.apiKey: set OPENROUTER_API_KEY (the code model), run with --mode jev-only, or run jevcode login` |
| `--plain` on a TTY | readline composer + the rewritten plain wizard twin (§1.4.3): the same steps as text prompts; `jevProvider` written on the one-key path, never beside a resolving Jev key (the save-shape table) |
| `--screen-reader` | the Ink wizard with numbered options and the aria label (`SR_KEY_FIELD_LABEL`); the `key` step reads `OpenRouter API key — one key runs Jev and the code model` / `API key field, 0 characters entered, hidden` / `Enter saves; Escape clears, then Escape again for other options`; `options` reads three rows of ≤ 76 cells — `Other ways to start:` / `1. OpenRouter key for both  2. TypeSafe key for Jev  3. Jev only, no LLM` / `4. Anthropic key for the code model · Enter selection (1-4):` (the first draft's single 109-cell row lost option 4 in the flat tier at 80 columns) |
| `CI=1` / `TERM=dumb` / `--no-input` / `--json` | non-interactive (`session.ts:286–288`): no wizard; missing keys → ConfigError + the mode-aware fix block, exit 2; `--json` unchanged |
| SSH (`SSH_TTY`) | fps 15; wizard rows unchanged; the verify spinner is the static `verifying… (Ctrl-C cancels)` row (no new timer) |
| < 16 rows (flat) / < 12 rows (trust 2 rows) | `key` 3 rows, `options` 3 rows (`wizardRows`); the masked row is `<MaskedField>` with the cursor (`Wizard.tsx:305` reads `isFieldStep`, F-W9); the caps item is one static item; unchanged budgets |
| reduced motion / `NO_COLOR` | no spinner in the wizard (none today); unchanged |

### 1.4 The wizard flow (D-J)

```
detect ──[nothing missing]──▶ trust? ──▶ sandbox ──▶ done
   │
   ├─[generator + Jev missing, no provider inferred (rule 2e), provider null-or-openrouter]──▶ key ──Enter──▶ save ──▶ verify? ──▶ [caps item] ──▶ trust ──▶ sandbox ──▶ done
   │                                                                                            │ Esc (empty field)
   │                                                                                            ▼
   │                                                                                         options ── 1 ──▶ key (back)
   │                                                                                                 ── 2 ──▶ jevKey(typesafe) ──▶ generatorKey(openrouter, `Enter = skip` keeps jev-only pending) ──▶ save …
   │                                                                                                 ── 3 ──▶ outcome { kind: 'mode', mode: 'jev-only', persist: reason === 'missing' } ──▶ [jevProvider] ──▶ jevKey ──▶ save … (host writes `mode` at startup, pends it from /login)
   │                                                                                                 ── 4 ──▶ generatorKey(anthropic) ──▶ [jevProvider] ──▶ jevKey ──▶ save …
   ├─[Jev resolves (TYPESAFE_API_KEY / JEV_API_KEY / a saved Jev key), generator missing]──▶ key (found-title; saves the generator key ONLY; Esc → options where 3 = stay Jev-only, persisted)
   └─[generator resolves, Jev missing]──▶ today's [jevProvider] ──▶ jevKey (unchanged; `Enter = reuse` when an OpenRouter generator key was typed here)
```

Rules: `key` appears only when **both** secrets are missing and no §2.3 rule inferred a Jev provider (or when Jev resolves and only the
generator is missing — the found-title variant). `found` is computed from the **resolved** entries (`config.entries`), whatever the layer: a
Jev key a round-2 wizard saved counts as found (`'typesafe'` or `'jev'` with `foundSource: 'file'`). Under `jev-only` (flag/env/file) the round-2 flow is untouched (`detect → [jevProvider] →
jevKey → …`). The TypeSafe question appears (a) never when `TYPESAFE_API_KEY` exists (it is used), (b) from `options` `2`, (c) from `jevcode
login --jev-provider typesafe`, (d) from `/login` when the resolved provider is typesafe (`tui-prompter.ts:180–183` already passes
`jevProvider`). It never appears unprompted on the one-key path.

**1.4.1 Reducer changes (`src/tui/onboarding/reducer.ts`, S3, W1)**

```ts
export type WizardField = SecretSettingName | 'key';                                  // :20 — `key` is the one-paste field
export type WizardStep = 'detect' | 'key' | 'options' | 'jevProvider' | 'provider' | 'generatorKey' | 'jevKey' | 'save' | 'verify' | 'trust' | 'sandbox' | 'done' | 'exit';   // :22
export type FoundKey = 'typesafe' | 'jev' | 'anthropic' | null;                       // what detect found among the RESOLVED entries (names a source, never a value)
export type FoundSource = 'env' | 'dotenv' | 'file';                                  // the layer the found key came from (title text only)
// OnboardingState (:44–79) gains:  found: FoundKey;  foundSource: FoundSource | null;  optionsShown: boolean;  highlight: 1 | 2 | 3 | 4 | null;  pendMode: EngineMode | null;
// SaveRequest (:32–41) gains:      oneKey: boolean;   // the `key` field serves generator AND Jev (four file keys) — true ONLY when found === null
//                                  keyAs: 'both' | 'generator' | 'jev';   // what the `key` field's bytes become (the save-shape table of §1.4.3)
// OnboardingAction 'detect' (:83–95) gains: found?: FoundKey; foundSource?: FoundSource;
// OnboardingAction 'choose' (:97) widens:   option: 1 | 2 | 3 | 4 | 'enter'
export const WIZARD_OPTIONS_ORDER = ['openrouter', 'typesafe', 'jev-only', 'anthropic'] as const;   // the 1–4 of the options step
/** one predicate for both renderers' masked row (Console.tsx:128 and Wizard.tsx:305 read it; neither lists steps itself) */
export const isFieldStep = (step: WizardStep): boolean => step === 'key' || step === 'generatorKey' || step === 'jevKey';
```

`startFromDetect` (`:276–281`) gains, before the `needsGenerator` branch: `if (needsGenerator(s) && needsJev(s) && s.jevProvider === null &&
(s.provider === null || s.provider === 'openrouter')) return field(s, 'key');` (`keyAs: 'both'`); before `needsJev`: `if (needsGenerator(s) &&
!needsJev(s) && s.reason === 'missing' && (s.found === 'typesafe' || s.found === 'jev')) return field(s, 'key');` (`keyAs: 'generator'`); and when
`s.found === 'anthropic'` with both missing: `field({ ...s, provider: 'anthropic' }, 'key')` with `keyAs: 'jev'` (`field()` `:224–226` maps `'key'` →
step `'key'`).

**Keys on `key`.** `enter`: `length === 0` → `HINT_TOO_SHORT`, except `found === 'jev'` with the reuse hint shown → `toSave` with
`reuseJevForGenerator: true`; `0 < length < 8` → `HINT_TOO_SHORT`; a prefix mismatch against `'openrouter'` warns **once** with the `key` variant
`HINT_PREFIX_KEY` — it names the `Esc, then 2` route for a TypeSafe key, the route a plain "Enter again to keep it" hid (kept, the key is sent to
openrouter.ai, 401s on the first `hi` and the wizard reopens); then `toSave({ ...s, entered: ['key'] }, false)` with `oneKey: found === null` and
`keyAs`. `escape` with `length > 0` → **clears the buffer** (the host's `bytes.clear(field)`) and shows the empty-field hint, which names the next
Esc (`Esc: other ways to start`); `escape` with `length === 0` → `{ step: 'options', optionsShown: true, highlight: found === 'anthropic' ? 4 : null }`.
Ctrl-U clears as today. (Edge 9's "Esc with text → clears" stays true; the hints now say so instead of `Esc back`.)

**Keys on `options`.** A digit `1–4` **highlights** (row 2 marks it with `▌`, row 1 becomes `Other ways to start — Enter confirms <n>:`, row 3
shows that option's one-line consequence, §1.4.2); the same digit again, or Enter, **confirms**; ←/→ move the highlight; Enter with no highlight
→ hint `pick 1–4`; `escape` → back to `key` with `firstStepHint`. Confirm: `1` → `field(s, 'key')`; `2` → `{ ...s, jevProvider: 'typesafe',
jevProviderShown: true }` then `field(…, 'decider.apiKey')`, and after that key `nextAfterJevTypesafe` = `needsGenerator ? field(…,
'generator.apiKey')` with the ` — Enter = skip (stay Jev-only)` title suffix (an empty Enter there → `toSave` with `pendMode: 'jev-only'`) :
`toSave`; `3` → `{ ...s, pendMode: 'jev-only' }` then `toJevKey(s)` when Jev is missing, else `afterKeys` — the host receives `{ kind: 'mode', mode:
'jev-only', persist: s.reason === 'missing' }` (§1.4.3: a startup wizard **persists** the mode, a `/login` wizard pends it); `4` → `{ ...s, provider:
'anthropic', providerShown: true }` then `field(…, 'generator.apiKey')` (or, when the Anthropic key already resolves, `toSave(s, false)` with
`fields: []` and `provider: 'anthropic'` — the provider-only save — then `toJevKey`).

**Keys on `verify`.** `y` → `{ verifying: true }`; `n`, **Enter and Esc** → `afterKeys({ verify: 'skipped' })` — today `verify-answer` handles
`y`/`n` only (`reducer.ts:381–384`) and Enter/Esc are silent no-ops; a first-time user who does not want to spend must always have a visible way
past the step, so the title carries `[n] skip` inside 76 cells and the two ordinary keys do the same. `wizardRows` (`:409–423`): `key` 3,
`options` 3 (screen reader: 3). `wizardActive` unchanged. Ctrl-C (`cancel`, `:364–369`) is unchanged: exit 2 for a startup wizard with no run
live, close otherwise.

**1.4.2 Strings (all in `src/tui/onboarding/lines.ts`, one source for Ink, `--plain`, `--screen-reader`, `--ascii`; S3, W1)**

Every console-hosted row is drawn inside `consoleInnerWidth(columns) = columns − 4` (`console-lines.ts:22`) and clipped there
(`Console.tsx:129` `fitCells`, `lines.ts:102` `clipRow`) — the bound at 80 columns is **76 cells**, not 78, and a clipped row loses its tail,
which for a hint is the affordance the row exists to show (the first draft's rows measured 89–125 cells and lost `(prints how to set it)`,
`needs an OpenRouter key:` and `[n] skip`). Rule: every fixed string below is ≤ 76 cells (the number in parentheses is measured;
`lines.test.ts` asserts `≤ consoleInnerWidth(80)` for every row of every step at 80 columns and the wide `options` form at 120); a string that
wants more gets a narrow twin chosen by the inner width (`cellWidth(wide) ≤ inner`), never by a column threshold.

| Step | Row 1 (bold) | Row 2 | Row 3 (hint; `warn` colour when an error) | Console title |
| --- | --- | --- | --- | --- |
| `key` (both missing) | `WIZARD_KEY_TITLE = 'OpenRouter API key — one key runs Jev and the code model'` (56) | `maskedFieldRow(length, columns, ascii, prompt)` (`› ••••`; `> ` flat/plain/ascii) | empty: `WIZARD_KEY_HINT_EMPTY = 'Paste, then Enter · Esc: other ways to start · Ctrl-C quits (shows setup)'` (73); typing: `oneKeyHintRow(n, columns)` = `<n> chars · Enter saves · Ctrl-U clears · Esc clears (again: other ways)` (71 at n = 20; narrow twin `<n> · Enter · ^U · Esc` when it does not fit) — `generatorKey`/`jevKey` keep today's `keyHintRow` with `Esc back`; too short: `HINT_TOO_SHORT`; prefix: `HINT_PREFIX_KEY = 'not an OpenRouter key? Enter again keeps it · TypeSafe key: Esc, then 2'` (71); twice-pasted (edge 2): `HINT_PASTED_TWICE = 'looks like the key was pasted twice — Ctrl-U clears'`; rejected: `HINT_REJECTED` | `setup · key` |
| `key` (`found === 'typesafe'`) | `keyFoundTitle('typesafe')` = `'TypeSafe key found — Jev runs there. Code model: paste an OpenRouter key'` (72) | masked | empty: `'Paste it and press Enter · Esc: other ways (Jev only, Anthropic)'` (64); typing / prefix as above | `setup · key` |
| `key` (`found === 'jev'`) | `keyFoundTitle('jev', source)` = `'Jev key found (JEV_API_KEY) — code model: paste an OpenRouter key'` (65; `(config file)` / `(dotenv)` by `foundSource`) | masked | empty and the found value starts `sk-or-`: env/dotenv `WIZARD_REUSE_JEV_HINT = 'Enter = save the JEV_API_KEY value as the code-model key (config file)'` (70) — it says a secret from the environment is about to be written to disk; file: `'Enter = reuse the saved Jev key for the code model too'` (54) | `setup · key` |
| `key` (`found === 'anthropic'`) | `keyFoundTitle('anthropic')` = `'Anthropic key found — it writes the code. Jev needs an OpenRouter key:'` (70) | masked | `'Paste it and press Enter (Jev only) · TypeSafe key for Jev? Esc, then 2'` (71) | `setup · key` |
| `options` | `WIZARD_OPTIONS_TITLE = 'Other ways to start:'`; highlighted: `optionsTitle(n) = 'Other ways to start — Enter confirms <n>:'` (41) | wide when `cellWidth(wide) ≤ inner` (≥ 102 columns): `WIZARD_OPTIONS = '  1 OpenRouter for both (default)   2 TypeSafe for Jev   3 Jev only, no LLM   4 Anthropic for code'` (98; the first draft's 121-cell form was clipped at 100–124 columns); else `WIZARD_OPTIONS_NARROW = '  1 OpenRouter   2 TypeSafe   3 Jev only   4 Anthropic'` (54); the highlighted digit's leading space becomes `▌` (`>` ascii) | no highlight: `'pick 1–4 · Esc back'`; Enter without one: `'pick 1–4'`; highlighted, `optionHint(n, runCap, sessionCap)`: `1: one key runs Jev and the code model (default) · Enter confirms` (65) · `2: TypeSafe key for Jev, OpenRouter key for the code model · Enter confirms` (75) · `3: no LLM — code proposes, Jev decides, tests verify · caps $0.25 / $1.25` (73; amounts from `defaultRunSpendCapUsd('jev-only')` × `SESSION_CAP_MULTIPLIER`, never literal) · `4: Anthropic writes the code (~20× GLM's price) · Jev: OpenRouter/TypeSafe` (75; R3 §10 Q3's price ratio); ` (default)` is placed at render time after the option whose route equals `DEFAULT_MODE`'s | `setup · options` |
| `jevKey` (after `2`/`3`) | today's `jevKeyTitle(provider, counter)` | masked | today's hints | `setup · jev key` |
| `generatorKey` (after `2`/`4`) | today's `generatorKeyTitle(provider)`; after `2`: `'OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip (stay Jev-only)'` (70) | masked | today's hints | `setup · generator key` |
| `verify` | `WIZARD_VERIFY_TITLE_ONE_KEY = 'Verify now? [y] one Jev decision + 1 code-model token (< $0.0001)  [n] skip'` (75; jev-only wizards keep today's `WIZARD_VERIFY_TITLE`, 71) | `verifyDetail(jevProvider, mode)`: openrouter + generator `'decision ~$0.00002 · completion ~$0.000002 · key info $0 · Enter/Esc skip'` (73); typesafe + generator `'api.typesafe.ai decision ~$0.00002 · completion ~$0.000002 · key info $0'` (72); typesafe alone: today's `WIZARD_VERIFY_DETAIL_TYPESAFE`; while running: `WIZARD_VERIFYING`. The endpoints (`POST openrouter.ai/api/alpha/decisions`, `POST /api/v1/chat/completions max_tokens 1`, `GET /api/v1/key`) are the TUI-only `detail` of the `[setup] verified:` items and a `docs/TUI.md` table — never a console row (the first draft's 125-cell row) | — | `setup · verify` |
| `caps` (no rows; one item) | `capsItem(mode, runCap, sessionCap)` = `spend caps: $2.00 per run · $10.00 per session (jev+llm) — /budget changes them; /mode jev-only runs on Jev alone at $0.25 / $1.25` (`[setup]` label; `none (uncapped)` when the session cap is lifted) | | | — |
| `trust`, `sandbox` | unchanged (`trustLines`, `sandboxText` §5.1 rule 13) | | | `setup · trust` |

The console title comes from **one** function. `Console.tsx:29–34` today keeps a second `wizardConsoleTitle` with a `names` map that has no
`key` / `options` entries, and the App imports that one (`App.tsx:41`, used at `:2004`) — so F-R8 would have read `╭─ setup ─…`; the W3 Console
PR deletes the map and re-exports `onboarding/lines.ts`'s `wizardConsoleTitle` (which gains `key` → `setup · key`, `options` → `setup · options`;
`console.test.ts` pins both at 80 columns). Screen reader (`--screen-reader`, §1.3.3): `key` reads the title / `SR_KEY_FIELD_LABEL(n)` / `'Enter
saves; Escape clears, then Escape again for other options'` (63); `options` reads the three rows of §1.3.3. Errors that are not hints: a failed
save returns to the field with the write error as the hint (`save-failed`, `reducer.ts:375–380`); a verify that could not reach the host
appends `verificationFailedText(short)` and moves on. `[setup]` items after Enter on `key` with `found === null` (from `persistCredentials`,
`session.ts:1453–1481`): `generator key: entered (sha256:e31150e9) source=wizard` · `saved ~/.config/jevcode/config.json (mode 0600, dir
0700)` · `generator provider: openrouter (default)` · `jev provider: openrouter (openrouter.ai)`; the Jev fingerprint line is suppressed
when the two keys are equal (`:1466`, already). After the reuse Enter (`found === 'jev'`): `generator key: reused from JEV_API_KEY (sha256:…)
source=env→file` (`keyReusedText(source, fp)`), never `entered`.

**1.4.3 The host side (S3, W2).** `patchFromWizard` (`tui-prompter.ts:77–88`) writes what `keyAs` says — the **save-shape table**:

| `found` | `keyAs` | file keys written from the `key` field | `oneKey` | why |
| --- | --- | --- | --- | --- |
| `null` | `both` | `apiKey = jevApiKey = value`, `provider: 'openrouter'`, `jevProvider: 'openrouter'` | true | nothing resolves; one key serves both |
| `'typesafe'`, `'jev'` | `generator` | `apiKey = value`, `provider: 'openrouter'` — **never** `jevProvider` / `jevApiKey` | false | `resolveJevProvider` rule 1 (`resolve.ts:357–359`: a file `jevProvider` is explicit) runs **before** rule 2c (`:368`, `TYPESAFE_API_KEY`); a wizard-written `jevProvider: openrouter` would silently move Jev off api.typesafe.ai at the next start (D-G; the title said `Jev runs there`) |
| `'anthropic'` | `jev` | `jevApiKey = value`, `jevProvider: 'openrouter'`, `provider: 'anthropic'` — **never** `apiKey` | false | the hint promised "Anthropic writes the code"; a `provider: openrouter` save would have made GLM the generator without a word |

`reuseJevForGenerator` mirrors `reuseGeneratorForJev` (copies the resolved Jev value into `apiKey`; the item reads `reused from <source>`).
The `wizardHost` (`:140–159`) gains `verify: (i) => controls.verifyKeys(i)` (§1.5) and the `TuiPrompterControls` interface gains
`verifyKeys(input): Promise<{ ok; rejected; items }>`; `WizardOutcome` gains `{ kind: 'mode'; mode: EngineMode; persist: boolean }` (§6) — `runLogin`
(`session.ts:1513–1533`): `persist` (a startup wizard, reason `missing`) → `writeConfigValue('mode', mode, …)` (`credentials.ts:328`) then
`reresolve()` (so `applyConfig` moves `baseMode`, nothing pending, badge `jev-only` with no ` · next run`) and `note(modeSavedItem(displayPath))`
= `mode jev-only saved to <path> — jevcode config set mode <m> changes it`; otherwise `pending.mode = mode; extras.dispatch({ type: 'mode', … });
note(modeSetItem(mode))`; both return `false` (no key saved). Without the persist, `3 Jev only` built a wizard that reopened at every launch: the
no-key user's saved Jev key resolves, `missingSecrets('jev-on')` still lists the generator, and `startFromDetect` fell through to the
`provider` step titled `No API key found. Pick the generator provider:` (`lines.ts:56`) — wrong, at every launch, with `jevcode config set mode
jev-only` as the only exit (R3 §10 Q2 was closed the other way; §12 row 19).
`runLogin` computes `found` from the **resolved** entries: `config.entries.get('decider.apiKey')` present → `'typesafe'` when the resolved Jev
provider is typesafe, else `'jev'`, with `foundSource` from the entry's source (`env` / `dotenv` / `file`); no Jev key but `ANTHROPIC_API_KEY`
present in env or dotenv → `'anthropic'`; else `null` — and passes it through `prompter.wizard(missing, { provider, reason, mode, found,
foundSource })`. The masked row is special-cased in **two** renderers and both read `isFieldStep(step)` (§1.4.1): `Console.tsx:128` (`fieldRow`,
the boxed console; S5 lands, W3) and `Wizard.tsx:305` (`<MaskedField>` with the cursor, the flat tier under 16 rows; S3's own file) — with `key`
unlisted in the second, a 12-row SSH user saw the key row as plain dim text with the cursor parked elsewhere (F-W9 is the 12×80 twin).
`Wizard.tsx:216–222` adds the double-paste check (`bytes.peek(field)` contains `sk-or-` twice → `HINT_PASTED_TWICE`, pure, no bytes to the
reducer). The plain twin (`session.ts:863–889`) is rewritten over the same strings: `ask('other ways: [t] TypeSafe Jev · [j] Jev only · [a]
Anthropic · Enter continues: ')` (79) only when both are missing, then `askMasked('OpenRouter API key (one key: Jev + the code model): ')`, and
it **always** sets `patch.jevProvider` on the one-key path (R3 F4: a TypeSafe key typed there was sent to openrouter.ai) — and never on the
found-title path, like the Ink host.

### 1.5 Verification with four outcomes (`src/cli/login.ts:415–462` `verifyKeys`, S3, W1)

`VerifyResult.reason: 'rejected' | 'credits' | 'unreachable' | 'model'`; `VerifyInput` gains `mode: EngineMode`, `generatorModel: string`,
`jevBaseUrl: string`, `jevModel: string`. The OpenRouter Jev check becomes **one decision** (`POST <jevBaseUrl>` with `JEV_PROVIDERS.openrouter
.headers`, `VERIFY_PROBE_STATE`, `verifyProbeQuestions()`, `jevModel`), a **generator check** `POST https://openrouter.ai/api/v1/chat/completions
{ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, temperature: 0 }` (only when `mode !== 'jev-only'` and the provider is
openrouter; `GET /v1/models` stays for anthropic), and `GET /api/v1/key` kept for `label` / `limit_remaining`. Status → outcome: 2xx `ok`;
401/403 `rejected` (exit 2); 402 `credits` (exit 5); 400/404 on the completion `model` (exit 2); 408/429/5xx/thrown `unreachable` (exit 5;
429 surfaces `Retry-After`). Every call has `AbortSignal.any([AbortSignal.timeout(VERIFY_TIMEOUT_MS), input.signal])` so Ctrl-C at `verify`
aborts (edge 5). The decision is metered into the session meter directly — `meterVerify(usage)` = `sessionMeter.add('jev', usage); pushSessionSpend();`
beside `meterChat` (`session.ts:3296`), **not** through the chat ledger: `meterChat` needs a `ChatRoute` (`chat/intake.ts:217`, unowned this
round) and an `IntakeKind`, a probe is neither, and a ledger line would make `/cost`'s `chat $x for N messages` count the probe as a message —
so `/cost` shows it in the session total only. Texts: `verifiedJevText(model, tokens, usd)` = `verified: jev ok (<model>, <n> input
tokens, $<usd>)`; `verifiedGeneratorText(model, usd)` = `verified: <model> ok (1 token, $<usd>)`; `verificationCreditsText(status)`,
`verificationRateLimitedText(retryAfterS)`, `verificationModelText(model, status)` as §1.3.2 shows. **Tests (S3, `login.test.ts`):** injected
`fetch` per status (401, 402, 404 body `{"error":{"message":"… is not a valid model ID"}}`, 429 + `Retry-After: 20`, ECONNREFUSED); exit-code
map; `wizard.test.tsx`: `host.verify` receives `{ provider, jevProvider, fields, mode }` and a hanging verify resolves to `verify-result ok:false
rejected:null` on cancel. **Live (`test:live`, paid, skipped without the key):** one row per provider asserting `costUsd ≈ 320 × 4.2e-8` and
`usage.cost < 1e-5` for the GLM call; the GLM 1-token latency is recorded (unmeasured today — R3 F15).

### 1.6 `jevcode login`, `logout`, `config set`, `--status`, and the fix block

- **Interactive login, jev-on default, nothing resolves** (`login.ts:579–618`): first the line the Ink `options` step and the plain twin
  share — `other ways: [t] TypeSafe Jev · [j] Jev only · [a] Anthropic · Enter continues: ` (79 cells; `t` → the `--jev-provider typesafe`
  prompts, `j` → the Jev prompt then `mode jev-only saved …`, `a` → the `--provider anthropic` prompts; only when both secrets are missing) —
  then one prompt `OpenRouter API key (one key: Jev + the code model): ` (masked, 3 attempts), `[setup]` items as §1.4.2; `--verify` runs §1.5. With `TYPESAFE_API_KEY` resolving: `[setup] decider.apiKey:
  already set from env (sha256:…) — Jev key step skipped` then the generator prompt only. `--jev-provider typesafe` → `Jev API key
  (TYPESAFE_API_KEY): ` then `OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip: ` (jev-only stays possible via `jevcode config set mode
  jev-only`). `--provider anthropic` → `Anthropic API key (ANTHROPIC_API_KEY): ` then the Jev question as today.
- **Pipe:** new `--key-stdin` (`args.ts` flag spec + `loginFlagsFrom`, `main.tsx:372–383`): one line → `apiKey` + `jevApiKey` + `provider:
  openrouter` + `jevProvider: openrouter`; too short → `jevcode: apiKey: key too short (8+ characters) (first stdin line)` exit 2; a second
  line is ignored (edge 29); `--key-stdin --provider anthropic` → usage error `--key-stdin is the one-OpenRouter-key form; use
  --generator-key-stdin --jev-key-stdin`; `--key-stdin` on a TTY → the masked one-key prompt; `LOGIN_NEEDS_TTY_OR_STDIN` (`login.ts:44`) names
  `--key-stdin` first. `--generator-key-stdin --jev-key-stdin` (the key twice) unchanged.
- **`--status`** (`:375–389`) gains a third line `mode: <mode> (<source>) — needs: generator, jev` / `— needs: jev`.
- **`logout`** unchanged (`:656–678`); the doubled `[setup] [setup]` label (R4 F16) is fixed by `commandLogout(flags, io, { labelled: false })`
  when called from the session (`session.ts:2609` adds the label once).
- **`config set mode jev-only`** unchanged; the next start honours it because of §1.2.
- **The fix block** (`lines.ts:303–308`, the ONE formatter; `fixBlockLines(mode: EngineMode, provider: WizardProvider | null)`), for
  jev-on / llm-jev / jev-off with provider null or openrouter — the `#` column is cell 30 and every line is ≤ 76 cells (measured 61 / 55 /
  45 / 75 / 75 / 73; the first draft's aligned comments were 102 and 126 cells and wrapped mid-comment on an 80-column pipe):

```
export OPENROUTER_API_KEY=…   # one key: Jev + the code model
printenv OPENROUTER_API_KEY | jevcode login --key-stdin
jevcode login                 # masked prompt
export TYPESAFE_API_KEY=…     # Jev native; add OPENROUTER_API_KEY for code
                              # Jev alone: jevcode config set mode jev-only
Keys are never accepted as command-line arguments in the interactive flow
```

  `provider === 'anthropic'` inserts `export ANTHROPIC_API_KEY=…    # the code model under --provider anthropic` (73) before the
  footer; `jev-only` keeps today's five lines verbatim. Call sites pass the mode: `session.ts:1524` (`fixBlockLines(mode,
  providerOf(config))`), `:3510`, `:3608` (`fixBlockLines(modeOf(flags, env), null)` — the ConfigError path has a config), `:3405` (already
  passes `mode`). The pipe ConfigError (`:3507`) with `TYPESAFE_API_KEY` only reads `missing generator.apiKey: set OPENROUTER_API_KEY (the
  code model), run with --mode jev-only, or run jevcode login`.

### 1.7 Cost transparency

> **Owner ratification (§0.1, D-Q):** this item is one-time per `DEFAULT_MODE` value — gated on the config file's `seen.defaultMode`, written when the item prints; not "at every such start". Read the rest of this section with that rule.


| Moment | After |
| --- | --- |
| first frame / startup | badge `jev+llm`; `sess $0.00/10.00` after startup; a keyed start whose `mode` resolves from `default` with no file `mode` row prints `defaultModeItem(mode, runCap, sessionCap)` = `mode jev+llm (default) — caps $2.00 per run · $10.00 per session; /mode jev-only runs on Jev alone at $0.25 / $1.25; jevcode config set mode <m> keeps a choice` (159 cells, `[setup]`, D-Q; the badge word from `MODE_BADGE_WORD[DEFAULT_MODE]`, the amounts from `defaultRunSpendCapUsd`) — never under `--mock`, `--json`, a flag/env/file mode, or a default whose mode bills no generator |
| wizard `verify` | §1.4.2 row with the real per-call figures; both calls only on `y`; `--no-input`/pipe never verify |
| after a wizard save on a first run (`runLogin` after `saved && reason === 'missing'`) | `[setup] spend caps: $2.00 per run · $10.00 per session (jev+llm) — /budget changes them; /mode jev-only runs on Jev alone at $0.25 / $1.25` (`capsItem`; a keyed start prints `defaultModeItem` instead, D-Q) |
| facts `switch_mode` (`facts.ts:111`) | `Switch with /mode jev-only (Jev alone, $0.25 run cap) or /mode jev-on (alias /llm on); it applies to the next run. Persist it with jevcode config set mode <m>.` |
| 402 in chat (`session.ts:3078–3100` `chatFailure`) | `CREDITS_EXHAUSTED(side, 402)` = `OpenRouter says this key has no credits (HTTP 402). Add credits at openrouter.ai/credits, or /mode jev-only ($0.25 cap; Jev bills the same key).` (144 cells ≤ `REPLY_TEXT_MAX` 160, §5.1 rule 8 — the first draft was 177) — a `JevHttpError`/`ProviderHttpError` with status 402 and no `Retry-After` (an in-flight-budget 402 with `Retry-After` is retried by the provider first, `openrouter.ts:356–357`); TypeSafe has no documented 402, so the text keys on the host |

### 1.8 Edge cases, each with a test (R3 §6, adopted; owners in brackets)

| # | Case | Expected | Test |
| --- | --- | --- | --- |
| 1 | key pasted with a trailing newline / CR | `sanitizeKeyInput` (`reducer.ts:174–184`) strips all whitespace; Enter saves the clean key | unit `reducer.test.ts` (exists) + pty `r3-key-paste-newline.steps` [S5] |
| 2 | key pasted twice | `HINT_PASTED_TWICE`; Ctrl-U clears | unit `wizard.test.tsx` [S3] |
| 3 | Ctrl-C at `key` (startup) | exit 2, jev-on fix block, no idle console | pty `zero-arg-wizard` re-pinned [S5] |
| 4 | Ctrl-C at `options` | as 3 | pty `r3-options-ctrlc.steps` [S5] |
| 5 | Ctrl-C at `verify` while verifying | abort chained; `verification failed: AbortError …` item; wizard continues, key kept | unit `wizard.test.tsx` [S3] |
| 6 | Ctrl-C at `trust`/`sandbox` | exit 2 (today's rule) but **no** fix block when nothing is missing (`session.ts:3404–3406` guards on `missingSecrets`) | unit `session.test.ts` [S3] |
| 7 | Ctrl-C in `/login` or `/mode` wizards | closes, session continues (`cancelCloses`) | exists (`mode-switch`, `round2.pty.test.ts:328`) |
| 8 | resize during the wizard 24×80 → 12×60 → 40×120 | rows ≤ 3 in every tier; zero clears outside the shrink; at 12 rows the cursor sits on the `> ••••` row (F-W9, `Wizard.tsx:305`) | pty `r3-wizard-resize.steps` [S5] |
| 9 | Esc on the `key` field | empty → `options`; Esc again → `key` with `Ctrl-C quits`; with text → clears the buffer and shows the empty-field hint (the typing hint said `Esc clears (again: other ways)`, so nothing is a surprise) | unit `reducer.test.ts` [S3] |
| 10 | empty Enter on `key` | `HINT_TOO_SHORT` (no reuse offered) | unit `reducer.test.ts` |
| 11 | empty Enter on `key` with `JEV_API_KEY=sk-or-…` found | the hint announced the write; generator key = that value; item `generator key: reused from JEV_API_KEY (sha256:…) source=env→file`; `jevProvider` untouched | unit `tui-prompter.test.ts` (`patchFromWizard` with `reuseJevForGenerator`, `keyAs: 'generator'`) |
| 12 | 402 on the verify decision | `verificationCreditsText`; wizard continues; `login --verify` exit 5 | unit `login.test.ts` |
| 13 | 429 on verify | `… rate-limiting this key (HTTP 429) — try again in 20s; the key was kept`; exit 5 | unit `login.test.ts` |
| 14 | network down during verify | `verification failed: TypeError: fetch failed — the key was kept; fix it with /login`, exit 5 | unit `login.test.ts` + `wizard.test.tsx` |
| 15 | `TYPESAFE_API_KEY` only under jev-on | wizard(`key`) found-title; Esc → `options`; `3` `3` (or `3` Enter) → `mode: jev-only` written, `modeSavedItem`, badge `jev-only`; **restart with the same file → no wizard**; Ctrl-C → exit 2 with the fix block naming `--mode jev-only` and `config set mode jev-only` | pty `ts-only-start.steps` (replaces `mode-switch`'s implicit start) [S5] + unit `session.test.ts` (pick 3, save, restart) |
| 16 | `ANTHROPIC_API_KEY` only | found-title; the field is the Jev key (`keyAs: 'jev'`: `jevApiKey` + `jevProvider: openrouter` + `provider: anthropic`, never `apiKey`); Esc → `options` with `4` highlighted; Enter → `provider: anthropic` saved, then `jevProvider` → `jevKey` | unit `reducer.test.ts` + `tui-prompter.test.ts` + `resolve.test.ts` |
| 17 | `JEV_API_KEY` only (OpenRouter key) | found-title + reuse hint; Enter reuses; a pasted key saves `apiKey` + `provider` only | unit `reducer.test.ts`, `tui-prompter.test.ts` |
| 18 | `OPENROUTER_API_KEY` + `TYPESAFE_API_KEY` | no wizard; typesafe Jev; generator OR; badge `jev+llm` | unit `resolve.test.ts:743` region |
| 19 | key in `./.env` but wrong (401) | no wizard at start; first `hi` → `Jev rejected the key (HTTP 401). /login saves a new one.` + wizard at the one `key` field; the dotenv shadowing line at the next start | unit `session-chat.test.ts:622` region + `resolve.test.ts` |
| 20 | `jevcode run "task"` in a pipe, no keys | ConfigError `missing generator.apiKey, decider.apiKey: …` + jev-on fix block, exit 2, no run dir | pty `r3-pipe-nokeys.steps` (`expectedExit 2`) [S5] + unit `session.test.ts` |
| 21 | pipe, `TYPESAFE_API_KEY` only | ConfigError `missing generator.apiKey: set OPENROUTER_API_KEY (the code model), run with --mode jev-only, or run jevcode login`, exit 2 | unit `session.test.ts` |
| 22 | `--provider anthropic` with only `OPENROUTER_API_KEY` | generator missing (`ANTHROPIC_API_KEY`, `JEVCODE_API_KEY` consulted) → wizard `generatorKey(anthropic)` | unit `resolve.test.ts` |
| 23 | screen-reader wizard | numbered `options`, `Enter selection (1-4):`, `API key field, N characters entered, hidden`; the caps item as text | unit `lines.test.ts`; pty `r3-wizard-sr.steps` [S5] |
| 24 | `--plain` TTY wizard | text prompts from `lines.ts`; `jevProvider` written on the one-key path only; Ctrl-C (`\u0003`) → fix block, exit 2 | unit `plain-prompter.test.ts` (new `wizard` cases: one key; `[t]`; `[j]`); pty `r3-plain-wizard.steps` [S5] |
| 25 | config file with a nonexistent model | startup warning (existing); verify `y` → `verificationModelText`; a run's first generator call → step error exit 5 | unit `login.test.ts` |
| 26 | `JEVCODE_MODE=jev-only` in env | §1.2 | unit `session.test.ts`; pty `r3-env-jev-only.steps` [S5] |
| 27 | round-2 user, file `mode: "jev-only"` | §1.3.3 row 1 | unit `resolve.test.ts:888` region + `session.test.ts` |
| 28 | `--mode llm-jev` badge | `llm+jev · verified` from frame 0 | unit `launch.test.ts:13–21` |
| 29 | `login --key-stdin` with two lines piped | first line only; second ignored, nothing printed | unit `login.test.ts` |
| 30 | verify `y` under `--mock` | never reached at startup; `/login --verify` in a mock session prints `(mock session: verification uses the network)` | unit `session.test.ts` |
| 31 | `/mode jev-only` then `/mode jev-on` with one OR key | no wizard either way; items `modeSetItem(m)`; badge `… · next run` | exists (`session.test.ts:126–160`), re-pinned |
| 32 | a 7-character key | `HINT_TOO_SHORT`; same floor as the redactor and `credentials.ts:259` | exists |
| 33 | Windows save | `saved <path> (Windows: protected by your user profile ACL)` | exists |
| 34 | `TYPESAFE_API_KEY` resolving, one-key wizard, an OpenRouter key pasted | the file gains `apiKey` + `provider: openrouter` and **no** `jevProvider` / `jevApiKey`; `jevcode config` shows `decider.provider  typesafe  auto:typesafe-key` | unit `tui-prompter.test.ts` + `resolve.test.ts` (a file the wizard wrote never overrides an env TypeSafe key) [S3] |
| 35 | round-2 user: file `jevApiKey` + `jevProvider: typesafe`, no file `mode`, upgrading | `found = 'typesafe'` from the file layer → the found-title `key` wizard (never the `provider` step's `No API key found`); `3` persists `mode: jev-only` | unit `session.test.ts` [S3] |
| 36 | keyed start, `mode` from `default`, no file `mode` row | one `[setup] mode jev+llm (default) — caps …` item (D-Q); with `mode: jev-on` in the file → absent; under `--mock` / `--json` → absent | unit `session.test.ts` [S3] |
| 37 | `options`: a digit, then Enter / the same digit / another digit / Esc | highlight + consequence hint; confirm; re-highlight; back to `key`; Enter with no highlight → `pick 1–4` | unit `reducer.test.ts`, `lines.test.ts` [S3] |
| 38 | `verify`: Enter or Esc | both act as `n` (`verify: 'skipped'`, on to trust) | unit `reducer.test.ts` [S3] |
| 39 | a TypeSafe key pasted into the one-key field | `HINT_PREFIX_KEY` names `Esc, then 2`; Enter again keeps it (today's rule, unchanged) | unit `reducer.test.ts` [S3] |
| 40 | `COLORFGBG=0;15` (a white terminal), no theme set | default theme `light`; `15;0` → `dark`; `--theme dark` wins (D-R) | unit `launch.test.ts` [S3] |

### 1.9 Copy pass: the code model, not Claude (R3 F9 / R5 F13)

`src/chat/facts.ts`: `WHAT_IT_IS_TEXT` (`:110`) ends `… in jev+llm mode the code model writes the code.`; `HOW_TO_TASK_SUFFIX['jev-on']`
(`:118`) = ` The code model writes the code, Jev decides each step.`; `modeNowText` (`:126`) reads `MODE_SENTENCE[mode]`: `jev-only` →
`Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.`, `jev-on` → `Mode: jev+llm — the code model writes the code,
Jev decides every step.`, `jev-off` → `Mode: llm-only — the generator alone, no Jev (bench condition; reviews still ask).`, `llm-jev` →
`Mode: llm+jev · verified — the code model writes candidate patches, tests verify them, Jev arbitrates.`; `keysText` (`:160`) `generator:
none — needed for jev+llm; /mode jev-on asks for one.` unchanged. `session.ts:241–244` become `MODE_SET_ITEM` (§10 "Mode items").
`WIZARD_PROVIDER_HINT_MODE` (`lines.ts:66`) becomes `providerHintMode(current)` = `Keys are never shown or logged · Esc back · Ctrl-C keeps
<modeBadgeWord(current)>` (75 cells with the longest badge `llm+jev · verified`; the first draft's wording reached 83 and was clipped). `package.json` `description` ("Claude writes the code") and `args.ts:746` (`JevCode: Jev decides,
Claude writes.`) → `Jev decides, the code model writes.` (S3; the package gate re-runs).

### 1.10 The flip: two commits, and every pin that moves

**Commit 1 (S3, W1–W3):** §1.1–1.9 with `DEFAULT_MODE` still `'jev-only'`; every existing test passes; the new wizard/login/verify tests run
under `--mode jev-on` or `JEVCODE_MODE=jev-on`. **Commit 2 (W4, one PR: S3 edits `defaults.ts:44`; S5 edits `test/pty/**`, `src/perf/states.ts`,
README, TUI.md, STATUS, CHANGELOG; S4 re-runs `gen-docs`):** `DEFAULT_MODE = 'jev-on'` and the mechanical re-pin below, every expectation
written as `DEFAULT_MODE` / `modeBadgeWord(DEFAULT_MODE)` / `BADGE_DEFAULT` so the peer's later flip moves nothing.

- **Unit (S3 files):** `defaults.test.ts:153–162`; `resolve.test.ts:62–66,208–210,396–413` (zero-arg cap → `defaultRunSpendCapUsd(DEFAULT_MODE)`),
  `:506–510,716–724,743–750,831,888–944`; `launch.test.ts:13–21`; `login.test.ts:57–59` (`FIX_ONE_KEY` shape), `:191–196,382,395,433–458,535,705`;
  `tui-prompter.test.ts:164–169,250–281`; `onboarding/reducer.test.ts:34,45–46,67–96,323–333,407–458`; `onboarding/lines.test.ts:54–56,99–105,113,254–270,299,313,332`;
  `cli/session.test.ts:126–194,361–362,416–417,553`; `cli/session-chat.test.ts:64,80–87` (`Mode:` fact); fixtures passing `mode: 'jev-only'`
  explicitly stay (they test the mode). **Unit (S1):** `theme.test.ts:89` (the badge marker `<mode>`). **Unit (S2/S5 files, each owner):** `round2-lines.test.ts`, `console.test.ts`, `frames2.test.ts`,
  `round2-console.test.tsx`, `round2-reducer.test.ts`, `plain.test.ts`, `config/ui.test.ts`, `config/validate.test.ts`,
  `config/resume.test.ts`, `config/args.test.ts` — grep each for `'jev-only'` used as *the default* (a badge in a default frame, `mode  jev-only
  default`) versus as a value.
- **pty / smoke / perf (S5):** `zero-arg-chat.steps`, `zero-arg-run.steps` (`╭─ jev-only` → `╭─ jev\+llm`), `zero-arg-wizard.steps` (`expect
  Where do you reach Jev` → `expect OpenRouter API key`), `chrome-tiers.steps:6,10,14`, `chat-hi.steps:14`, `chat-facts.steps:15` (`Mode: jev-only`
  → `Mode: jev\+llm`), `mode-switch.steps` → `ts-only-start.steps` (§1.8 edge 15; the keyed variant passes `--mode jev-only` at start and switches
  to jev-on), `run-smoke.sh:16,174–177,233,242–244`, `round2.pty.test.ts:106,133–143,227,328–339,345–358,367–383,413,495,685,701,712–717,729–800`,
  `helpers.ts:81` (`BADGE_DEFAULT = modeBadgeWord(DEFAULT_MODE)` beside `BADGE_JEV_ONLY`), `chat.pty.test.ts:8,58,94–97,118`, `twins.pty.test.ts:42,58`,
  `src/perf/states.ts:190–198` (`expect Where do you reach Jev` → `expect OpenRouter API key`, exit 2 unchanged).
- **Docs and generated artefacts:** `README.md:9–11,57–77,95,103,115–129,182–197,267,276,335,566`; `docs/TUI.md:18,28–42,137–138,305,327–331,396–399,462–472,617`;
  `docs/COMMANDS.md`, `man/jevcode.1`, `completions/*` (regenerated); `CHANGELOG.md` 0.4.0; `docs/DECISIONS.md` (§11); `docs/STATUS.md` round-3 section;
  `.env.example` → `OPENROUTER_API_KEY=sk-or-v1-...  # one key: Jev + the code model`, `TYPESAFE_API_KEY=`, the optional Anthropic pair, `JEVCODE_SPEND_CAP_USD=2`
  (drop `JEVCODE_PROVIDER=anthropic` / `JEVCODE_MODEL=claude-sonnet-5`, which contradict the GLM default).

Perf-gate audit of §1: the first frame is still argv + env only (`DEFAULT_MODE`, `MODE_BADGE_WORD` are constants; `resolveConfig` stays after
`firstFrame()`, `session.ts:3456–3459`); no fetch before an explicit `y` (`JEVCODE_ASSERT_NO_NETWORK` smokes never press `y`); the masked field is
a key frame on the D-F path; `options` adds no timer; rows ≤ 3 per step so zero clears; `[setup]`/`[config]` items are session items produced by
`lines.ts`/`credentials.ts` formatters shared by Ink, `--plain` and the log (identity holds); `--plain` transcript identity unchanged.

---

## 2. The TypeSafe pink theme (D-H)

The theme engine needs no structural change (R1 §2): every consumer goes through `textProps(theme, role, depth)` (30 call sites in 10
files, R1 §2.3), so the work is a table swap for the `dark` id, one new role `accent2`, one new helper `labelRole`, and the consumer edits of
§2.6. The palette is called **TypeSafe pink**; its CLI/config id stays `dark` (`--theme dark|light|daltonized|ansi`, `JEVCODE_THEME`,
`ui.theme`, `DEFAULT_THEME`, `/theme`'s enum at `registry.ts:65`, `UI_THEMES` at `config/ui.ts:13`, the man page, completions and 37 pty
scenarios stay untouched; there is no cyan theme left to keep). The header comment of `theme.ts:1–8` names it: `dark = TypeSafe pink
(typesafe.ai palette, measured 2026-09-21)`.

### 2.1 Roles and the `dark` table (`src/tui/theme.ts:61–63,86,90–114`; S1, W1)

```ts
export type ColorRole = 'error' | 'warn' | 'ok' | 'block' | 'review' | 'steer' | 'dim' | 'accent' | 'secret' | 'chosen' | 'rule' | 'placeholder' | 'you' | 'assistant' | 'badge' | 'border' | 'borderFocus' | 'code' | 'sweep' | 'accent2';
// COLOR_ROLES gains 'accent2'; NO_MARKER_ROLES (:86) gains 'accent2' (decoration only: the splash fade step and the palette marker)
```

Every role, **bold** = changed from HEAD. Contrast is WCAG 2.x on `#1e1e1e` (R1 §7; body ≥ 4.5, marker/edge ≥ 3.0).

| Role | truecolor | 256 | ansi16 | dim/bold | marker | contrast | paints |
| --- | --- | ---: | --- | --- | --- | ---: | --- |
| `error` | `#F87171` | 203 | `red` | — | `error` | 6.03 | error items, blocking card edges |
| `warn` | `#FBBF24` | 214 | `yellow` | — | `warning` | 9.99 | retrying live rows, banner, wizard hint, cards, `idle exit N` word |
| `ok` | `#4ADE80` | **78** | `green` | — | `✓` | 9.57 | `✓` toasts, `complete` status word, meter `ok` |
| `block` | `#F87171` | 203 | `red` | bold | `[block]` | 6.03 | pane rows, review card edges |
| `review` | `#FBBF24` | 214 | `yellow` | — | `[review]` | 9.99 | pane rows, review card edges |
| `steer` | `#FBBF24` | 214 | `yellow` | — | `>` | 9.99 | the `›` prompt **while a run is live** (D-O) |
| `dim` | — | — | — | dim | `` | terminal: SGR 2 renders `#dedede` as `#6f6f6f` (halving — iTerm2, VS Code/xterm.js) = **3.3:1** or `#7e7e7e` (a 50 % blend) = 4.1:1 on `#1e1e1e`, below body grade; some 16-colour palettes and tmux without passthrough ignore SGR 2 altogether | **labels ≤ 12 cells other than `[jevcode]`/`[you]`, tags (`Suggested`, `recent`), the alias column, decoration (rules, borders at rest, `…`, the ghost, the palette footer, the caption version, the tagline, `CODE`)** — never a row body ≥ 20 cells: detail rows, the epilogue's value column and `[ui]` bodies are the default foreground (§5.1 rule 2) |
| `accent` | **`#f386a1`** | **211** | **`magentaBright`** | — | `` | 6.93 | brand row span, wordmark `JEV`, picker selected row, hosted console title, **the idle `›`**, **the spinner glyph** |
| `secret` | `#FBBF24` | 214 | `yellow` | — | `⚠ secret?` | 9.99 | gate row, review gate, status |
| `chosen` | **`#f386a1`** | **211** | **`magentaBright`** | — | `[chosen]` | 6.93 | pane decision rows (Jev's pick is a brand moment) |
| `rule` | — | — | — | dim | `─` | terminal | rule row fill |
| `placeholder` | — | — | — | dim | `…` | terminal | composer placeholder |
| `you` | **`#d45bb6`** | **169** | **`magenta`** | **bold** | `[you]` | 4.74 | **the `[you]` label only** (D-O) |
| `assistant` | **`#f386a1`** | **211** | **`magentaBright`** | **bold** | `[jevcode]` | 6.93 | **the `[jevcode]` label only** |
| `badge` | **`#f386a1`** | **211** | **`magentaBright`** | bold | **`<mode>`** | 6.93 | console top-edge mode word; flat-tier status prefix |
| `border` | — | — | — | dim | `╭` | terminal | console edges at rest, cards |
| `borderFocus` | **`#d45bb6`** | **169** | **`magenta`** | — | `live` | 4.74 | console edges while a run is live (the site's "primary button border") |
| `accent2` (new) | **`#d45bb6`** | **169** | **`magenta`** | — | `` | 4.74 | the wordmark caption's `◆` (§3.5); the palette / mention `▌` on the selected row; the middle step of the run-end edge fade (§5.2 P9) |
| `code` | **`#e5e5e5`** | 254 | `whiteBright` | — | `╶` | 13.23 | fence rows and fenced bodies |
| `sweep` | **`#fbd0dc`** | **224** | `whiteBright` | — | `` | 12.03 | reveal head `▓▒░`, the shimmer / idle band, the streaming caret |

Rationale (R1 §3.1): 211/169/224/78 are the nearest xterm cube cells by ΔE2000 (R1 §6.1 arithmetic); `ok` keeps `#4ADE80` (9.57:1) over the
site's `#03aa5c` (5.48:1) — success is not brand; `#ef4444` was rejected as a "more distinct red" at 4.43:1; the primary/secondary lightness
order (L\* 68.5 vs 56.9) survives at depth 16 (`TERM=screen`, `--theme ansi`; `screen-256color` / `tmux-256color` are depth 256 per
`color-shim.ts:96–97`) as `magentaBright` vs `magenta`. Pink is never a *semantic* colour: every pink
role's meaning is in its marker (`[chosen]`, `[you]`, `[jevcode]`, the mode word, `live`), so a deuteranope who cannot split pink from
salmon (ΔE 12.0, R1 §5.1) still reads the words.

`itemRole` (`theme.ts:203–210`): the `[you]` branch returns **null** (bodies default, D-O) and the `[ui]` → `dim` branch is deleted (§5.1 rule 2: `[ui]` bodies and detail rows read in the default foreground, only the label is dim); new export `labelRole(item): 'assistant' |
'you' | 'dim'` (`[jevcode]` → `assistant`, `[you]` → `you`, else `dim`) — the consumer is `Transcript.tsx` (S5, §5.1). `validateTheme`
unchanged (the badge marker only has to be non-empty, `:235`). Add a grep test that `src/tui/theme.ts` contains none of
`jev-only|jev+llm|llm-jev|llm-only`.

### 2.2 The `light` table (`theme.ts:117–133`; on `#fefefe`, also checked on `#ffffff` and Solarized `#fdf6e3`)

HEAD's `LIGHT` spreads `DARK.roles` and never overrides `error`, `block`, `chosen`: `#F87171` on `#fefefe` is **2.74:1**, `#4ADE80`
**1.73:1** — unreadable (R1 §2.5 defect 1). Fixed:

| Role | truecolor | 256 | ansi16 | dim/bold | contrast on `#fefefe` |
| --- | --- | ---: | --- | --- | ---: |
| `error`, `block` | **`#b91c1c`** | **124** | `red` | block bold | 6.42 |
| `warn`, `review`, `steer`, `secret` | `#0369A1` | 25 | `blue` | — | 5.88 |
| `ok` | **`#15803d`** | **29** | `green` | — | 4.97 |
| `accent`, `chosen`, `assistant`, `badge` | **`#be185d`** | **125** | **`magenta`** | assistant/badge bold | 5.99 |
| `you`, `borderFocus`, `accent2`, `sweep` | **`#831843`** | **89** | **`magenta`** | you bold | 9.57 |
| `code` | **`#1e1e1e`** | **234** | `black` | — | 16.53 |
| `dim`, `rule`, `placeholder`, `border` | — | — | — | dim | terminal |

`#9d174d` was the first light secondary but shares cube cell **125** with `#be185d` (accent and secondary identical at depth 256);
`#831843` → 89 avoids the collision. Light pinks use plain `magenta` (bright magenta on white is ≈ 1.6:1 in default 16-colour palettes).
`#166534` was rejected for `ok` (cell 23 is teal); the old `code` `#1E293B` → cell 17 is navy; `#1e1e1e` → 234 is exact.

**When `light` is the default (D-R).** `themeFor` never auto-detects (C15, `theme.ts:167–169`) and the default is `dark`; a first-time macOS
user on Terminal.app's untouched Basic profile (black on white; `TERM_PROGRAM=Apple_Terminal` → depth 256, `color-shim.ts:95`) would see the
wordmark, badge, `[jevcode]`, `[chosen]`, the idle `›` and the spinner in cell 211 `#ff87af` on `#ffffff` = **2.25:1**. Mitigation, env only,
zero I/O: `src/config/launch.ts` (S3) reads `COLORFGBG` (`<fg>;<bg>` or `<fg>;<x>;<bg>`; iTerm2, Konsole, rxvt, mintty set it) — a background
index of **7 or 15** makes `light` the default theme (`LaunchSettings.themeHint`, beside `modeHint`, so frame 0 is already right and
`config/ui.ts` resolves the same default); `--theme`, `JEVCODE_THEME` and `ui.theme` still win. Terminal.app sets no `COLORFGBG`, so
`HELP_NOTES` (S4, `palette.ts:248`) gains `light terminal? /theme light` and `docs/TUI.md`'s Terminal.app row gains "the Basic profile is white:
`jevcode config set ui.theme light`". Test (`launch.test.ts`): `15;0` → dark, `0;15` → light, `0;7` → light, `12;8` → dark, `garbage` → dark.

### 2.3 `daltonized` (`theme.ts:136–146`)

`dark` with the review/block family moved off red, as today: `error`/`block` → `#60A5FA` / 75 / `blue` (pink vs blue ΔE2000 **34.1**
deutan / 20.4 protan), `ok` → `#7DD3FC` / 117 / `cyan` (the freed old accent), `review` stays amber; **delete the `chosen` override** so
`[chosen]` inherits pink (pink vs blue-block is the 34/20 pair). Light-theme caveat (documented, not fixed): `#be185d` vs light ok `#15803d`
is ΔE 6.8 for deuteranopes — both mean "good", the `✓` carries it. The first `/help` block gains two notes: `colour-blind? /theme daltonized` and `light terminal? /theme light`
(S4 `HELP_NOTES`, `palette.ts:248`).

### 2.4 The `ansi` twin (`theme.ts:149–161`, derived mechanically from `dark`)

Primary family (`accent`, `badge`, `chosen`, `assistant`) → `magentaBright`; secondary family (`you`, `borderFocus`, `accent2`) → `magenta`;
`error`/`block` `red`; warn family `yellow`; `ok` `green`; `sweep`/`code` `whiteBright`; dim roles `gray`; never dims. No edit: the
derivation picks up every new member.

### 2.5 Contrast, every coloured role, three dark backgrounds (computed, R1 §7)

| Role → truecolor | `#1e1e1e` | `#000000` | `#002b36` (Solarized dark) | grade |
| --- | ---: | ---: | ---: | --- |
| accent / badge / chosen / assistant `#f386a1` | 6.93 | 8.74 | 6.24 | body |
| you / borderFocus / accent2 `#d45bb6` | 4.74 | 5.97 | 4.27 | body on TypeSafe & black; marker-grade on Solarized — acceptable: `you` is a 5-cell bold label after D-O, never a sentence |
| sweep `#fbd0dc` | 12.03 | 15.16 | 10.84 | — |
| code `#e5e5e5` | 13.23 | 16.67 | 11.92 | body |
| error / block `#F87171` | 6.03 | 7.59 | 5.43 | body |
| warn / review / steer / secret `#FBBF24` | 9.99 | 12.58 | 8.99 | body |
| ok `#4ADE80` | 9.57 | 12.05 | 8.62 | body |
| daltonized error `#60A5FA` | 6.56 | 8.26 | 5.90 | body |
| cell 211 `#ff87af` (what 256-colour terminals show) | 7.41 | 9.34 | 6.67 | body |
| cell 169 `#d75faf` | 4.88 | 6.15 | 4.39 | as `#d45bb6` |

Light (`#fefefe` / `#ffffff` / `#fdf6e3`): accent `#be185d` 5.99 / 6.04 / 5.60; secondary `#831843` 9.57 / 9.65 / 8.94; error `#b91c1c` 6.42 /
6.47 / 6.00; ok `#15803d` 4.97 / 5.02 / 4.65; blue `#0369A1` 5.88 / 5.93 / 5.50. The site's own pinks on white (`#f386a1` 2.38, `#d45bb6` 3.49)
can never be light-theme text — hence the darkened light pinks.

`dim` is not in the table because it has no colour: SGR 2 halves the foreground on most terminals (`#dedede` → `#6f6f6f`, **3.3:1** on
`#1e1e1e`) or blends it 50 % (`#7e7e7e`, 4.1:1); a 60 % implementation gives 5.3:1; a terminal that ignores SGR 2 shows no hierarchy at all.
Hence §2.1's rule that dim carries labels, tags and decoration only and every body ≥ 20 cells is the default foreground. The site's grey
`#abbab9` would be 8.3:1 and cell 145 `#afafaf` 7.6:1 — the fallback if the owner ever wants a coloured `dim` at depth ≥ 256; not taken this
round because it would recolour rules, borders and placeholders too and the light theme would need its own grey. Cell 211 on white
(`#ff87af` / `#ffffff`) is **2.25:1** — the Terminal.app Basic-profile case D-R handles at launch.

### 2.6 Consumer changes (who lands what)

| Change | File:line | Owner (lands in) | Detail |
| --- | --- | --- | --- |
| `[jevcode]` label pink bold, `[you]` label magenta bold, bodies default | `src/tui/Transcript.tsx:112–115` | S5 (W2, with §5.1) | `const labelProps = textProps(theme, labelRole(item), color); const role = itemRole(item)` (now null for `[you]`) |
| detail rows and `[ui]` bodies in the default foreground; only the label dim | `src/tui/Transcript.tsx:127–131`, `theme.ts:203–210` `itemRole` | S5 (W2, with §5.1); S1 the `itemRole` branch | §5.1 rule 2: dim is for ≤ 12-cell labels, tags and decoration; the epilogue's `resume` / `report` commands must read at body grade (3.3:1 at a 50 % dim) |
| composer prompt `›` pink at rest, amber while live | `src/tui/Console.tsx:142`, `src/tui/composer/Composer.tsx:620` | S5 lands (W3) | `const promptProps = p.live === true && p.active ? textProps(theme, 'steer', color) : p.active ? textProps(theme, 'accent', color) : {};` — the `filter` prompt takes the same props; the wizard-hosted console has no prompt row |
| the splash's two fade steps (600 / 650 ms) are removed: the mark is held in `accent` / `dim` from 550 ms on; `accent2` paints the caption `◆` | `src/tui/splash.ts:21–22,113` | S2 (W1) | §3.4 — R1's "fade 1 → `accent2`" is moot once the mark never fades (§12 row 3) |
| live rows / banner / queue rows pass `depth`, not the boolean `color` | `src/tui/App.tsx:2030,2039,2058` | S2 lands (W2) | measured as 66 `ESC[33m` vs 171 `38;5;214` SGRs in the shipped 24×80 capture (R1 §2.4) |
| spinner glyph in `accent`; status row spans | `src/tui/status/lines.ts` (`statusSpans`), `Console.tsx:174–200`, `StatusLine.tsx:65–82` | S5 (W1/W2) | §5.2 P6 / D-P: `statusRole` retires; the row is rendered from `{ text, spans }` |
| palette / mention `▌` on the selected row in `accent2`; matched spans bold | `src/tui/Overlay.tsx:195–216,246` | S4 (W3) | visual-only; a selected row is bold + one `accent2` marker + default text (≤ 3 colours per row, §5.1) |
| picker selected row stays `accent` | `src/tui/Pane.tsx:123` | — | unchanged |
| console edges while live `borderFocus` (magenta); run-end fade | `src/tui/Console.tsx:109` | S5 lands (W3) the `edgeRole?: ColorRole` prop S2 asks for | §5.2 P9 |
| `[chosen]` pink in the pane | `src/tui/Pane.tsx:82–90` | — | unchanged code; the table does it |
| theme tests | `test/unit/tui/theme.test.ts:62–66,89,91,94–111,130–133,154` | S1 (W1) | the §2.1/§2.2 values; new `test/unit/tui/theme-palette.test.ts` (§8 S1) |
| pty helpers | `test/pty/helpers.ts:48` (comment), `:73–75` `echoStep` → `expect ${PROMPT} ${SGR_GAP}text` (the idle prompt now closes an SGR before the body) | S5 (W4) | forgetting it fails ~30 scenarios at once — land with the prompt change |
| perf matcher | `src/perf/pty.ts:573` `composerEndsWithKey` | none | tests `endsWith(key)` on the composer row; the SGR precedes the body — verify on the first `npm run perf` |
| docs | `docs/TUI.md:56,272–273,342–346`; `docs/TUI-DESIGN-2.md:1003–1016` (one pointer line: "superseded by TUI-DESIGN-3 §2"); `docs/STATUS.md:901` (`ESC[1;38;5;117m` → `ESC[1;38;5;211m<mode word>`); README `--theme dark (TypeSafe pink)` | S5 (W4) | a one-off unit test greps `docs/TUI.md`, `docs/STATUS.md` for `7DD3FC\|38BDF8\|38;5;117\|38;5;74` and fails while any remains |
| `COLORFGBG` → default theme `light` (D-R) | `src/config/launch.ts` (`themeHint`), `src/config/ui.ts` (the `theme` default reads it) | S3 (W1) | §2.2; `launch.test.ts` |
| Terminal.app Basic-profile note; the two pinks | `docs/TUI.md` "Terminal setup notes", Terminal.app row (`docs/TUI.md:592`) | S5 (W4) | "the Basic profile is white: `jevcode config set ui.theme light`" |

### 2.7 Where pink never goes (the restraint that makes it read as an accent)

| Surface | Role | Why |
| --- | --- | --- |
| error items, blocking card, `[block]` rows, blocked review edges | `error` / `block` (red; blue in daltonized) | danger stays red |
| `[review]`, the live `›`, the secret gate, retry rows, banner, error toasts, wizard hint | amber | attention stays amber; the steering prompt must not look like the idle prompt |
| `✓`, `complete`, tests-passed, meter `ok` words | `ok` (green) | success ≠ brand |
| every label except the two chat labels (≤ 12 cells), tags, the alias column, queue-row prefixes, ghost text, the dir, rules, borders at rest, placeholders, `… n more rows`, palette footer, caption version, tagline | `dim` | the quiet layer is what makes pink stand out — and it is only quiet, not body text (3.3:1 at a 50 % dim, §2.5) |
| the `[jevcode]` **body**, the `[you]` **body**, live rows, step lines, `[run] start/end`, proposal items, **detail rows, `[ui]` bodies, the epilogue's value column** | default fg | the long text stays at the terminal's highest-contrast colour |
| code fences and fenced bodies | `code` | monospace content is neutral |
| status compartment text other than the left word / meter words | none | the status is a fact |
| palette rows other than the selection | bold / dim | ≤ 3 colours per row |

Rule of thumb for future surfaces: if the element *is* JevCode/Jev → primary; if it is *being acted on* (live, selected, the user's own
words) → secondary; if it *means* something → the semantic hue; otherwise dim/default.

### 2.8 Twins

`NO_COLOR` / `--no-color` / `TERM=dumb` (depth 0): `textProps` returns `{}`; every pink surface still carries its marker word; the idle
wordmark loop is **off** (§3.6: colour-only motion is invisible). `--theme ansi` / tmux depth 16: `magentaBright` / `magenta` as the
terminal defines them (Dracula `#ff79c6`, Solarized's bright magenta is violet — documented in `docs/TUI.md` "Terminal setup notes").
`--ascii`: glyphs change, colours do not. Screen reader: the flat tier draws the same text rows; no new colour surface. Reduced motion: no
change (colour is not motion). `COLORFGBG` with a white background (index 7 or 15): the `light` table is the default (D-R); every other twin
is unchanged.

---

## 3. The persistent wordmark (D-I)

### 3.1 The one rule and the visibility selector

The wordmark is **the pane slot's idle tenant**: it occupies the 5 pane rows between the rule row and the console whenever nothing else
needs the slot, and it is granted **whole or not at all**. Allocation order is unchanged (`YIELD_ORDER`, `layout.ts:124`: the pane still
yields first), so every round-2 frame with a run, a panel, a review or a picker is byte-for-byte what it is today. Today the slot is the
wordmark's only while `splash === 'running'` (`App.tsx:1916–1920`); `splashFrame` returns `[]` at t ≥ 700 (`splash.ts:106`); `useMotion`
deactivates its subscriber (`motion.ts:25–26`); the mark vanishes into the brand row (`Pane.tsx:58,61`). Measured on the shipped bundle
(R2 §0.2): idle after the settle writes **zero** frames and zero bytes at every geometry; the reveal writes 15 wordmark frames at 50 ms
(8 under `--fps 15`), 1.6–2.2 KB each at 24×80, ≈ 11 ms CPU per frame (upper bound under load). Any idle animation is a pure addition on
top of 0, so the gate is an absolute number (§3.9).

```ts
// src/tui/wordmark.ts (new, pure; S2, W1) — every input already exists in UiState / the App
export type WordmarkSetting = 'sweep' | 'static' | 'off';                       // ui.wordmark (§6), default 'sweep' ('static' under the SSH launch source, §3.2 twins)
export interface WordmarkInput {
  boxed: boolean;            // chromeRows(rows, columns, screenReader) === CAP.chrome  (App.tsx:548–549)
  rows: number;              // ≥ WORDMARK_MIN_ROWS (21): at 16–20 rows the palette (8 rows) or a tall draft would hand the mark off and back around every `/` command (R2 §9) — the boxed tier keeps today's brand row there
  postRun: boolean;          // ranBefore && !postRunKeySeen: after `run:end` the mark returns at once only at rows ≥ WORDMARK_POST_RUN_MIN_ROWS (24); below, the 8-row epilogue would scroll off in the frame that produced it — the mark returns on the first key instead
  columns: number;           // ≥ WORDMARK_MIN_COLUMNS (64)
  screenReader: boolean;     // never under a screen reader (already flat; kept explicit)
  run: RunPhase;             // hidden while runIsLive(run): 'live' | 'aborting' | 'pausing' (App.tsx:114–116); 'starting' (thinking) keeps it
  panel: PanelState;         // only while 'collapsed'
  pickerOpen: boolean;       // the picker owns the slot
  overlay: OverlayKind;      // hidden for 'review' (the review reclaims rows, TD A42); every other overlay keeps it if 5 whole rows remain
  expanded: boolean;         // review `e`: pane is 0 anyway
  setting: WordmarkSetting;  // 'off' → never
}
export function wordmarkWanted(i: WordmarkInput): boolean;   // the WANT; the layout's whole-or-absent grant decides the SHOW
```

`wordmarkWanted` is true iff `boxed ∧ rows ≥ 21 ∧ columns ≥ 64 ∧ ¬screenReader ∧ ¬runIsLive(run) ∧ panel === 'collapsed' ∧ ¬pickerOpen ∧
overlay ≠ 'review' ∧ ¬expanded ∧ setting ≠ 'off' ∧ (rows ≥ 24 ∨ ¬postRun)` (property-tested over 1,000 random inputs, §8 S2). The arithmetic
behind 21 (`computeLayout`, budget `rows − 2`): idle with the mark is 11 rows; the palette adds 8 (`min(8, n + 2)`, `Overlay.tsx:104–112`) →
19 ≤ 19 at 21 rows; a 6-row draft adds 5 → 16; the boxed intake card adds 3, the blocking pane ≤ 6, `followup` 5 — so at ≥ 21 rows no overlay
but `review` (hidden by rule; it reclaims the slot anyway) ever displaces the mark, and the whole-or-absent grant of §3.7 is a safety net,
not a daily event.

### 3.2 State → rows per tier

**Boxed tier with the mark (≥ 21 rows, ≥ 64 columns).** Dynamic-row counts at 24×80. At 16–20 rows the boxed tier is today's after the settle (brand row on the rule row + console = 6 dynamic rows): the reveal still runs, its held frame (550–700 ms) replaces today's two fade frames, and `splash:done` at 700 ms collapses to the brand row as today.

| State | Rule row | Pane slot | Dynamic rows | Notes |
| --- | --- | --- | --- | --- |
| first frame (t = 0) | plain rule | splash frame 0 (`J` + `▓▒░`) | 11 | **unchanged**: `step 0/–` sentinel in the console, `wordmarkCells > 0` (first-frame gate) |
| reveal / shimmer (0–550 ms) | plain rule | wordmark as today | 11 | frames 0–11 of TD2 §5.2 unchanged |
| **held (≥ 550 ms)** | plain rule | **resting mark** (`JEV` accent, `CODE` dim) + caption `◆ 0.3.0` (when `captionFits`: ≥ 73 cols for a 7-cell caption, §3.5) + tagline (≥ 104 cols) | 11 | the fade steps 600/650 and the collapse at 700 are removed; `splash:done` still fires at 700 (state hygiene) and changes no pixel |
| idle, no run yet | plain rule | resting mark; the loop runs (§3.4) | 11 | today: brand row + console = 6 |
| thinking (`run === 'starting'`) | plain rule | mark stays | 11 | the spinner row is the other dynamic row; a pass already running finishes |
| intake card `run this as a task?` | plain rule | mark stays | 14 | fits 21 rows with 5 to spare (budget 19) |
| wizard (first run, no key) | plain rule | mark stays | 13 | status 1 + rule 1 + chrome 3 + wizard 3 + pane 5 — the wizard is the input, so no composer floor (`layout.ts` step 3); the console hosts the wizard rows (F-R8) |
| palette | plain rule (the strip after a run) | mark stays | 19 | rule 1 + mark 5 + palette 8 + console 5; at 21 rows exactly the budget — no hand-off at any height the mark is shown at (F-P1) |
| `run:start` → live, before `run:ready` | **brand row** (as today, `Pane.tsx:61`) | **hidden** (pane 0) | 6 + live | zero animation frames during a run; the console edges turn `borderFocus` |
| live after `run:ready` | panel strip `▸ jev s3 · …` | hidden | 6–10 | as today |
| review pending | strip | hidden | as today | `overlay === 'review'` hides it before the layout does |
| `run:end` → idle | strip (`▸ jev s7 · 12 decisions …`) | **mark returns** at ≥ 24 rows; at 21–23 rows on the first key after the end | 11 (6 until then) | the strip keeps its information; the mark sits under it (F-W5). At 24 rows the 11-row region leaves 13 scrollback rows: `[run] end` (2) + spacer + the 8-row epilogue = 11 stay on screen (F-R6); at 21–23 rows `[ui] stopped`'s `resume` / `report` rows would scroll off in the same frame, so the epilogue keeps the rows until the user types (R2 §10 Q1's height rule) |
| panel open / full, picker | tab header | panel / picker rows | as today | `/panel off`, Alt+J, Esc bring the mark back |
| draft grows (any height the mark is shown at) | plain rule | mark stays | ≤ 16 | a 6-row draft is 11 + 5 = 16 ≤ 19 (R2 §0.4); the whole-or-absent grant of §3.7 is the safety net, never exercised at ≥ 21 rows |
| 16–20 rows, ≥ 64 columns (boxed, below `WORDMARK_MIN_ROWS`) | brand row | 0 | 6 | today's frames, unchanged (§3.1) |
| < 64 columns | brand row (static after 400 ms) | 0 | 6 | as today; **no idle pulse** (zero idle frames below 64 columns) |

**Flat tier (8–15 rows) and 8 rows:** the static brand row `─── ◆ jevcode 0.3.0 ───` on the rule row, today's `›` row and status row; 0
idle frames (F-W7). Decision: the 5-row mark stays a boxed-tier feature — at 12 rows the arithmetic allows it (8/10) but a 3-row draft
would hand it off and back while the user types; the flat tier is the minimal UI by design. `< 8 rows or < 40 columns` (minsize): status
· notice · composer, no brand.

**Twins.**

| Mode | Wordmark | Reveal | Loop | Idle frames |
| --- | --- | --- | --- | --- |
| `--no-animation` / `JEVCODE_REDUCED_MOTION` / `ui.reducedMotion` | **static resting mark from frame 0** (`JEV` accent, `CODE` dim, caption) | none | none (no subscriber mounted) | 0 |
| `--screen-reader` | none (flat tier; `wordmarkWanted` false) | none | none | 0 |
| `--plain` / pipe | nothing (no dynamic region) | — | — | — |
| `NO_COLOR` / `--no-color` / `TERM=dumb` (depth 0) | static resting mark; the reveal still runs (its head `▓▒░` is a cell change, visible without colour) | yes | **off** — the band is colour-only | 0 |
| `--ascii` | `#` letters, `#+.` head (as today); caption `* 0.3.0` | yes | yes | as Unicode |
| `--fps 15`; the SSH launch source (`SSH_TTY` / `SSH_CONNECTION`, `launch.ts:53–55`) | the resting mark; **`ui.wordmark` defaults to `static` when the SSH source is set** (flag/env/file override it, the same precedence as fps; `docs/TUI.md` SSH row) — eleven colour-only redraws of 2.1–2.8 KB arriving bunched on a metered or high-latency link tear a decoration; `--fps 15` alone keeps `sweep` (250 ms ticks are never coalesced by the 67 ms throttle) | 100 ms cadence (measured) | none under SSH; 4 fps peak with `--fps 15` alone | 0 under SSH |
| `ui.wordmark: static` | the resting mark, no loop | yes | none | 0 |
| `ui.wordmark: off` | today's frames (brand row idle) | the reveal still runs, then the brand row | none | 0 |

### 3.3 Hand-off rules (the reducer keeps its cancel rows; only the row source changes)

- **A key completes the reveal.** Today the first key ends the splash and the mark vanishes (`useEngine.tsx:415–418` → `endSplash`). New:
  the next frame shows the whole resting mark (no head, no band) and the character in the composer. `endSplash` keeps flipping `splash` to
  `done` (the reducer test `round2-reducer.test.ts:64–78` stays true); the App's row source becomes `wordmarkFrame(…)` whenever
  `wordmarkWanted` and `splash !== 'running'`, and `splashFrame(motion.time, …)` while `running`.
- `run:start`, `confirm:request`, overlay changes and `blocking:request` still flip `splash`; the visibility selector hides the mark where
  §3.2 says so — nothing new is stored for that.
- **Rule row** (`Pane.tsx:53–63`): `RuleRowInput` gains `wordmark: boolean` (the mark has rows this frame); `ruleRowText` returns
  `plainRule` while `wordmark`, replacing the `splash === 'running'` branch; the brand row is returned exactly where it is today otherwise
  (`!ranBefore`), the strip after `run:ready`. `RuleRow` / `brandSpan` untouched.
- Esc on an empty idle draft collapses the panel and brings the mark back (already: `panel: 'collapsed'`); `/panel off` likewise.
- **Post-run return at 21–23 rows.** `UiState.postRunKeySeen` (§6) is set false by the reducer at `run:end` and true by the next `key`;
  `wordmarkWanted`'s `postRun` is `ranBefore && !postRunKeySeen` (the App already knows `ranBefore`).

### 3.4 Frame tables and fps

**Reveal (unchanged frames 0–11, then held).** Phases: `reveal` < 450 · `shimmer` < 550 · **`held`** ≥ 550 (`SplashPhase` at `splash.ts:49`
becomes `'reveal' | 'shimmer' | 'held'`; `splashPhase` `:67–72` drops `fade`/`settled`; `SPLASH_FADE_1_MS`/`SPLASH_FADE_2_MS` (`:21–22`) are
deleted; `SPLASH_MS = 700` stays as the `splash:done` moment). `splashFrame(t, columns, g, version)` returns the resting frame **with the caption** for every t ≥ 550 and
never `[]` at ≥ 64 columns (without `version` the held frame would lack the caption and the App's switch to `wordmarkFrame` at 700 ms would
write one extra frame — `splash:done` must change no pixel, so the settle sentinel stays at 550); the letters' roles are `accent` (`JEV`) and
`dim` (`CODE`) throughout (no fade). Frame 0 is **cell-identical** to HEAD (H-A1 fixtures compare cells and pass unchanged); its SGR bytes follow
§2 (`38;5;117` → `38;5;211` once S1 lands) and its badge word §1.10 (`╭─ jev-only` → `╭─ jev+llm` in commit 2, `app.test.tsx:52`).

**The loop (candidate A of R2 §2.2, adopted):** the splash's own 6-cell `sweep` band crosses the 56-cell grid left → right at 4 cells per
frame, 4 fps (16 cells/s — a glide where the boot shimmer ran 500 cells/s). Colour only: letter cells inside the band take `sweep` over
`accent`/`dim`; blank cells stay blank; the caption and tagline are never in the band. One pass, `t` from the pass start, band `[max(0, s),
min(56, s + 6))`, `s = −6 + 4k`:

| k | t (ms) | band cells | written? | k | t (ms) | band cells | written? |
| ---: | ---: | --- | --- | ---: | ---: | --- | --- |
| 0 | 0 | ∅ | no (identical) | 9 | 2,250 | 30–35 | yes |
| 1 | 250 | 0–3 | yes | 10 | 2,500 | 34–39 | yes |
| 2 | 500 | 2–7 | yes | 11 | 2,750 | 38–43 | yes |
| 3 | 750 | 6–11 | yes | 12 | 3,000 | 42–47 | yes |
| 4 | 1,000 | 10–15 | yes | 13 | 3,250 | 46–51 | yes |
| 5 | 1,250 | 14–19 | yes | 14 | 3,500 | 50–55 | yes |
| 6 | 1,500 | 18–23 | yes (F-W2) | 15 | 3,750 | 54–55 | yes |
| 7 | 1,750 | 22–27 | yes | 16 | 4,000 | ∅ (`s = 58`) | yes (clears the band) |
| 8 | 2,000 | 26–31 | yes | rest | 4,000 → 9,750 | — | no ticks (one 5,750 ms wake at 9,750: the next pass's k = 0 writes nothing, its k = 1 lands at 10,000 → the 10 s period is exact) |

Per pass **16 written frames in 4.0 s (peak 4/s), then 6.0 s of silence → period 10 s, mean 1.6 fps**; ≤ 8 changed cells per row per
frame, ≤ 40 per frame; ≈ 2.1 KB per frame at 80 columns, 2.8 KB at 120. Under decay one pass per 30 s (mean 0.53 fps); static after
10 minutes. Ink facts that make this exact (R2 §0.3, verified on the real renderer): one shared animation timer with a single `setTimeout`
to the earliest deadline, due times from elapsed time (never drift); `useAnimation({ interval: 250 })` yields one render per tick at maxFps
30 **and** 15; the log throttle has wait `undefined` → 0 ms (`ink.js:221–236`), so a written animation frame opens **no** window for a
key's frame — an idle animation cannot add throttle latency to a keystroke (only CPU contention, bounded by one ≈ 11 ms render).

```ts
// src/tui/wordmark.ts — constants (one table; the owner can flip any of them)
export const LOOP_INTERVAL_MS = 250;        // 4 fps peak; ≥ any render throttle (34 / 67 ms) so no tick is coalesced
export const LOOP_STEP_CELLS = 4;
export const LOOP_BAND_CELLS = SWEEP_CELLS; // 6, the splash's
export const LOOP_PASS_TICKS = 17;          // k = 0..16; 16 visible frames
export const LOOP_REST_MS = 5_750;          // → period 10 s while attentive
export const LOOP_REST_CALM_MS = 25_750;    // → period 30 s after 60 s without activity
export const LOOP_ATTENTIVE_MS = 60_000;
export const LOOP_SLEEP_MS = 600_000;       // static after 10 min of inactivity
export const LOOP_QUIET_AFTER_KEY_MS = 3_000;
export const WORDMARK_MIN_ROWS = 21;        // §3.1: below it the boxed tier keeps the brand row (no palette / draft hand-off)
export const WORDMARK_POST_RUN_MIN_ROWS = 24; // §3.2: the mark returns right after run:end only when the epilogue still fits above it
export const CAPTION_GRID_CELL = 58;        // two cells after the last `E`; the span is [58, 58 + cellWidth(caption))
export function captionFits(columns: number, caption: string): boolean;     // wordmarkOffset(columns) + 58 + cellWidth(caption) ≤ columns — 73 for `◆ 0.3.0` (7 cells), 85 for a 13-cell `◆ 0.10.0-rc.1`
export const TAGLINE_MIN_COLUMNS = 104;     // ⌊(c−56)/2⌋ + 58 + 22 ≤ c ⇔  c ≥ 104
export const TAGLINE = 'Decisions, not strings';
export function loopBand(k: number): { from: number; to: number } | null;   // the table above, pure
export function wordmarkFrame(i: { columns: number; version: string; glyphs: GlyphSet }): { rows: string[]; spans(band: { from: number; to: number } | null): SplashSpan[] };   // rows never depend on the band (§3.8 ordering); spans(band) colours them
```

Candidates B (caption pulse, 1 fps, one row rewritten) and C (twinkle) are recorded in R2 §2.3–2.5; B is the fallback if the owner ever
wants a `'calm'` value (one constant table entry).

### 3.5 Caption, tagline, version, badge

- **Caption `◆ <version>`** (`g.brand` + `VERSION` from `src/version.ts`): the trailing cells of the mark's bottom row, two cells after the
  last `E`: grid span `[58, 58 + cellWidth(caption))` (7 cells for `◆ 0.3.0`, 13 for `◆ 0.10.0-rc.1`), drawn only when `captionFits(columns,
  caption)` — `wordmarkOffset(columns) + 58 + cellWidth(caption) ≤ columns`, i.e. ≥ 73 columns for a 7-cell caption, ≥ 85 for 13 (the first
  draft's fixed `[58, 67)` / 74 was wrong both ways: the caption is 7 cells, and a prerelease version overflowed at 74–76 columns); `◆` in
  `accent2`, the version in `dim`; `--ascii` `* 0.3.0`. It is the new **settle sentinel** (`expect ◆ \d+\.\d+\.\d+`, replacing `BRAND_STEP =
  'expect ◆ jevcode'`, `round2.pty.test.ts:81`); when the caption does not fit the settle is detected structurally (a wordmark frame whose
  bottom row is the complete `RAW[4]` with no `▓▒░` head).
- **Tagline `Decisions, not strings`** (the owner's copy line) in `dim`, two cells after the mark on row 0, at `columns ≥ 104` (F-W1w).
  `TAGLINE` is one constant; it is never in the band and never a transcript item. **Not** added as a sixth row (R5 P1's `CAP.hero = 6`):
  keeping `CAP.splash = 5` leaves frame 0, the layout tables and the splash gates untouched (§12 row 2).
- **Mode badge:** stays in the console's top edge one row under the mark (`Console.tsx:110–112,180–186`), word from `modeBadgeWord`;
  nothing in `wordmark.ts` names a mode.
- **Brand row** `─── ◆ jevcode 0.3.0 ───` (`splash.ts:156–158`) is kept verbatim for every state that hides the mark before the first
  `run:ready`, for < 64 columns and the flat tier. (`package.json` is 0.3.0; the shipped 0.2.0 in the round-2 captures was the pre-bump tree.)

### 3.6 The hook: `useIdleLoop` in `motion.ts` (the only module allowed to call `useAnimation(`)

```ts
// src/tui/motion.ts (S2, W1) — beside useMotion; spinner.test.ts:109–113 keeps passing
export type Attention = 'attentive' | 'calm' | 'asleep';
export type LoopPhase = 'rest' | 'pass';
export function attentionAt(nowMs: number, lastActivityAt: number): Attention;   // < 60 s attentive · < 10 min calm · else asleep
export interface IdleLoopInput {
  shown: boolean;            // wordmarkWanted(...) && layout.pane > 0 — the mark has rows this frame
  splashRunning: boolean;    // state.splash === 'running' — the hook never activates before the settle
  enabled: boolean;          // setting === 'sweep' && !reducedMotion && depth > 0
  attention: Attention;      // 'asleep' deactivates
  nowMs: number;             // state.nowMs (the 1 Hz tick's clock; App.tsx:522 `now`)
  lastKeystrokeAt: number;   // state.lastKeystrokeAt (useEngine.tsx:328 initial 0, :418 set by `key`)
  intervalMs?: number;       // test override of LOOP_INTERVAL_MS
}
export function useIdleLoop(i: IdleLoopInput): { phase: LoopPhase; k: number; band: { from: number; to: number } | null };
```

**A two-phase state machine, not a predicate.** The first draft put `nowMs − lastKeystrokeAt ≥ 3000` inside `isActive` and then said "a key
during a pass does not deactivate the hook" — contradictory: Ink resets `frame` to 0 the moment `isActive` flips false (`use-animation.js`:
`shouldReset` on `!previousOptions.isActive`; the effect re-subscribes on `[safeInterval, isActive, …]`), so the band would have vanished
mid-pass; and with `lastKeystrokeAt` starting at 0 the hook was active at mount, in the pass phase, ticking at 250 ms during the splash (extra
splash-bucket frames) and painting its first band ≈ 750 ms after the first frame — right after `splash:done`. Specified instead:

- `isActive = shown && !splashRunning && enabled && attention !== 'asleep'` — **nothing about keys**. While inactive the subscriber count is 0
  and no `setTimeout` is alive (`App.js:93–97`); `phaseRef` is reset to `'rest'`, so every activation starts with a rest.
- **Rest phase:** `useAnimation({ interval: restMs, isActive })` with `restMs = attention === 'calm' ? LOOP_REST_CALM_MS : LOOP_REST_MS`; `band =
  null` whatever `frame` says. At the first rest tick (`frame ≥ 1`) the hook evaluates the **quiet rule once**: `nowMs − lastKeystrokeAt ≥
  LOOP_QUIET_AFTER_KEY_MS` → `phaseRef = 'pass'` and the interval switches to `LOOP_INTERVAL_MS` (Ink resets `frame`/`time` on an interval change,
  so `k` counts from 0 in the new phase); not quiet → the interval becomes `LOOP_QUIET_AFTER_KEY_MS` (3 s) and the rule is re-evaluated at the
  next tick (a rest is never shorter than the quiet window and never longer than `restMs + 3 s`).
- **Pass phase:** `k = frame`, `band = loopBand(k)` (the §3.4 table); at `k ≥ LOOP_PASS_TICKS − 1` (16, the band cleared) `phaseRef = 'rest'` and the
  interval switches back. **A key during a pass changes nothing** — `lastKeystrokeAt` is read only at the rest → pass transition — so the pass
  finishes (≤ 4 s) rather than leaving a half-lit band; the next pass waits for the quiet rule.
- **The App renders `loop.band`, never `loopBand(loop.k)`:** at the rest wake `frame` becomes 1 in the render before the interval switch commits,
  and a consumer that mapped `k` to a band would paint cells 0–3 one extra time. `band` is computed inside the hook from `phaseRef` and is
  `null` in every rest render.
- Timeline: `splash:done` at 700 ms → active → rest 5,750 ms → pass starts at **6,450 ms**, first written band frame (k = 1) at 6,700 ms — the
  `splash-settle` pty step's "0 frames in the 5 s after the settle" holds with a second to spare; the `idle-loop` composer series (typist waits
  6.65 s) lands 200 ms into the first pass as intended; the splash bucket (≤ 22 dynamic frames in the first 700 ms) never sees a loop tick.

`UiState.lastActivityAt` (§6) is set by the reducer on `key`, `run:end`, `panel` and a geometry change — and **not** by a reply: a reply
(`chat-decisions` / `thinking → null`) leaves the loop in `calm` (a 30 s period) so the mark does not sweep every 10 s in the reader's
peripheral field for a minute while they read the answer above it (R2 §10 Q3, answered with the reading case); `key` and `run:end` still make
it `attentive`. `--no-animation` and `ui.reducedMotion` at `setUi` stop the loop mid-pass (the next frame is the resting mark: one write). Ctrl-L
repaints the current frame.

### 3.7 `computeLayout` 1.2 — the whole-or-absent pane grant (`src/tui/layout.ts:76–100,184`; S2, W1)

```ts
// LayoutInput gains
/** TUI-DESIGN-3 §3.7: grant the pane its whole want or nothing (the wordmark is never cut to its top rows); panel / picker keep partial grants */
paneWhole?: boolean;
// step 10 becomes
const want = Math.min(i.paneWant, CAP.pane);
z.pane = i.expanded ? 0 : i.paneWhole === true ? (rem >= want ? take(want) : 0) : take(want);
```

The App sets `paneWhole: wordmarkOn`. With `WORDMARK_MIN_ROWS = 21` (§3.1) the grant is a safety net rather than a daily event: the mark
is never *wanted* where an overlay or draft could displace it; the review card at 24×80 (pane 3 of 5 today) hides it (the review hides it
anyway). Invariants unchanged (`total ≤ budget`, yield order, ≤ 5 µs); new `TABLE` rows in `layout.test.ts:322–340` at 8/12/16/21/24/40 rows
(**totals**, not composer counts — the first draft's "= 6 at 16 with a 6-row draft" was the composer's count): idle + wordmark → `status 1 · rule
1 · composer 1 · chrome 3 · pane 5 = 11` at 21/24/40; idle at 16–20 → 6 (the mark is not wanted, `paneWant` 0); a 6-row draft at 21 → 16; the
palette at 21 → 19 (= budget); the wizard at 24 → 13 (no composer floor); `paneWhole` with `rem = 3, want = 5` → pane 0 (never 3).

### 3.8 App wiring (`src/tui/App.tsx`; S2, W2)

- `:561–574`: `useMotion(splashRunning, SPLASH_MS)` stays; add `const setting = ui?.wordmark ?? (launch.ssh ? 'static' : 'sweep')` (the
  `UiConfig` member is optional, §6 item 4; `config/ui.ts` resolves the same default from the file, so the two agree), `const wanted =
  wordmarkWanted({ …, rows, postRun: ranBefore && !state.postRunKeySeen })`, `const attention = attentionAt(state.nowMs, state.lastActivityAt)`,
  `const loop = useIdleLoop({ shown: wanted && paneRows > 0, splashRunning: state.splash === 'running', enabled: setting === 'sweep' &&
  !reducedMotion && depth > 0, attention, nowMs: state.nowMs, lastKeystrokeAt: state.lastKeystrokeAt })` — the quiet rule lives inside the hook
  (§3.6), never in `isActive`.
- `:1916–1920`: `const frame = !wanted ? null : state.splash === 'running' && motion.time < SPLASH_MS ? splashFrame(motion.time, columns, glyphs,
  VERSION) : wordmarkFrame({ columns, version: VERSION, glyphs })`, rendered with `frame.spans(loop.band)` — **`loop.band`, never `loopBand(loop.k)`** (§3.6);
  `wordmarkOn = frame !== null && frame.rows.length > 0`; `paneWant` unchanged in shape (`wordmarkOn ? CAP.splash : …`).
- `:988` (`case 'theme'`, the complete `UiConfig` literal): untouched — `wordmark` is optional (§6 item 4), so this line and the test fakes compile
  as they are; `postRunKeySeen` and the `resize` action are reducer work (§6 item 8).
- `:1922–1938` `layoutInput` gains `paneWhole: wordmarkOn`. **Ordering, no cycle:** `wanted` → the mark's rows (`wordmarkFrame` returns
  `{ rows, spans(band) }`; the rows never depend on the band) → `wordmarkOn` → `computeLayout` → `useIdleLoop({ shown: wanted && layout.pane > 0, … })`
  → `spans(loop.band)` at render. The band colours cells; it never feeds the layout.
- `:1980–1998` `ruleRowText({ …, wordmark: wordmarkOn && layout.pane > 0 })`.
- `:2044–2048`: render `frame.rows` when `layout.pane > 0 && wordmarkOn` (the `SplashRow` component is reused; a span with `role: 'accent2'` / `'dim'` for the caption / tagline).
- `:560` `?? DEFAULT_MODE`; `:2030,2039,2058` `depth` (S1's request); the run-start sweep and run-end fade motions of §5.2 P9.

### 3.9 Gates (new rows; old rows unchanged)

| Gate | Threshold | Kept by | Measured where |
| --- | --- | --- | --- |
| **idle dynamic fps** | ≤ 4 in any one-second bucket; mean ≤ 2/s over [1 s, 31 s] after the settle | `LOOP_INTERVAL_MS = 250`, 16 frames per 10 s | new `idle-frames` probe (§9), pty `wordmark-idle.steps` |
| **idle bytes** | ≤ 12 KB/s in the busiest second; ≤ 5 KB/s mean | ≤ 2.9 KB per frame × 4 | same probe (`Frame.body.length`) |
| idle CPU | reported (child `ps -o time` delta over 30 s), not gated in round 3; if > 30 ms/s mean, `LOOP_INTERVAL_MS` → 333 (one constant) | decay rules | same probe |
| first frame | < 300 ms; frame 0 **is** splash frame 0 — cell-identical (SGR bytes per §2, badge word per §1.10) | — | `first-frame.ts:79–90` |
| zero clears | 0 outside shrink segments | the region never exceeds `rows − 2` (whole-or-absent ≤ budget); hand-offs are height changes inside the budget, like `/panel` today | `render-lag.ts`, `states.ts`, every `.steps` |
| composer p95 | < 16 ms idle / live / palette / review — unchanged; new `idle-loop` series types 200 ms into a pass | D-F + log throttle 0 ms | `composer-latency.ts` |
| dynamic fps during a run | ≤ maxFps + 1 — unchanged (the mark is hidden while live) | — | `render-lag.ts` |
| splash bucket | ≤ 22 `dynamic` frames in the first 700 ms — unchanged (15 reveal frames; the loop activates at `splash:done`, starts in `rest`, and its first pass begins at 6,450 ms with the first band frame at 6,700 ms) | `useIdleLoop` starts in `rest` (§3.6) | `render-lag.ts:57–66` |
| reduced motion | 0 wordmark **frames** after frame 0 (the static mark is in frame 0) | no subscriber | `wordmark-reduced.steps` |
| line identity | unaffected: no transcript item changes; caption / tagline are dynamic rows, never `<Static>` | — | `plain.test.ts`, `app.test.tsx:299` untouched |

### 3.10 Frames (24×80 unless noted; the mark is `JEV` accent, `CODE` dim, caption `◆` accent2 + dim, tagline dim, band sweep)

The F-W frames show the **dynamic rows only** (their captions say so and carry no `scrollback rows above` clause, so `frames2.test.ts`
asserts the dynamic region alone); scrollback follows §5.1 — the 10-cell gutter, `<Static>` rows that wrap rather than clip — and is drawn in
F-R3 / F-R6 / F-R8 (§5.4). The first draft drew `[run] jevcode session …` flush left above F-W1 while §5.1 rule 1 and F-R8 put it at
`    [run] …`, and showed a `[config]` row clipped at column 80 that Ink would have wrapped; two slots would have shipped two scrollbacks.

**F-W1. Idle, wordmark resting, 24×80 (11 dynamic rows; dynamic rows only)**

```
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                   step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W1w. Idle with the tagline on row 0, 40×120 (11 dynamic rows; dynamic rows only)**

```
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ███████ ██    ██  ██████  ██████  ██████  ███████  Decisions, not strings
                                    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                                    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
                                ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
                                 ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                           step 0/–  sess $0.00/10.00 ok  ⎇ main · 3~ 1?  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**F-W2. Loop pass frame k = 6 (t = 1,500 ms into the pass): the band covers grid cells 18–23 — colour only, no cell changes** (rows as
F-W1; the annotation is not a frame row):

```
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
                              ^^^^^^  <- sweep band, k = 6
```

**F-W3. Thinking (intake in flight), 24×80 (11 dynamic rows; dynamic rows only)** — the mark stays; the spinner is the pink shade pulse; the
`    [you] hi` row above it is scrollback (F-R3).

```
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › (thinking…)                                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓ thinking                             step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W5. Idle after a run: the strip keeps the rule row, the mark returns below it, 24×80 (11 dynamic rows; dynamic rows only; at 21–23 rows
this frame appears on the first key after `[run] end`, §3.2)**

```
─── ▸ jev s3 · 7 decisions · risk 0.12 ok · plan 1/4 ──────── [d] [p] [t] [s] ──
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                  step 3/40  sess $0.04/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-W7. 12×80 flat tier: the static brand row, no wordmark, zero idle frames (3 dynamic rows, unchanged from today)**

```
─── ◆ jevcode 0.3.0 ────────────────────────────────────────────────────────────
› Say hi, ask a question, or describe a task…
jev+llm · idle                             step 0/–  sess $0.00/10.00 ok  ? help
```

**F-W8. 21×64, the smallest wordmark geometry: no caption (`captionFits` is false below 73 columns), no tagline (11 dynamic rows)**

```
────────────────────────────────────────────────────────────────
        ██ ███████ ██    ██  ██████  ██████  ██████  ███████
        ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
        ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
    ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
     ████  ███████   ████    ██████  ██████  ██████  ███████
╭─ jev+llm ───────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                │
├──────────────────────────────────────────────────────────────┤
│ idle                                        step 0/–  ? help │
╰──────────────────────────────────────────────────────────────╯
```

**F-W9. 12×80 flat tier, the wizard's `key` step (5 dynamic rows: brand row, three wizard rows, status): the masked row is `<MaskedField>` with
the cursor after the bullets (`Wizard.tsx:305` reads `isFieldStep`); the status row is `statusLineText`'s flat form and illustrative — the pty
step (`r3-wizard-resize.steps`) asserts the cursor position**

```
─── ◆ jevcode 0.3.0 ────────────────────────────────────────────────────────────
OpenRouter API key — one key runs Jev and the code model
> ••••••••••••••••••••
20 chars · Enter saves · Ctrl-U clears · Esc clears (again: other ways)
jev+llm · setup                                                         step 0/–
```

The hero + wizard frame is F-R8 in §5.4.

---

## 4. Commands: shortcuts, the palette, and the audit fixes (D-K)

The registry has **37 command names and 4 aliases** (`h`, `sessions`, `continue`, `quit`; `registry.ts:79–517`, `COMMAND_TOKENS`
`dispatch.ts:471`). A `/line` travels: grammar (`parse.ts:58–128`) → registry lookup (`BY_NAME` `:519–527`, case-folded names + aliases) →
`routeSubmit` (`submit.ts:150–173`: `submitting → ignore` first; palette overlay → exact token only) → the App's pre-router for `/panel` and
`/transcript` (`App.tsx:1064–1070`, `pane/commands.ts:11–12`, lower-case only) → App-local actions (`App.tsx:930–1057`: help, why,
decisions, plan, theme, editor, exit, pause, abort, unsteer, steer, copy) → `host.command(line)` → the controller's `execute()` switch
(`session.ts:2674–2858`, no `default`). The 14 pty probes and 23 findings of R4 §3–4 are taken as measured.

### 4.1 Shortcut aliases and the resolution rules

Every alias below was checked against the real scorer (`fuzzy.ts:236 rank`, R4 §5.1): the ones marked *pin* need rule 2 because a
prefix sibling outranks the owner today (`s` → steer, `p` → plan, `t` → trust, `l` → llm, `tr` → trust). `a` for `/abort` (R4's list), `x` for `/exit` and `n` for `/new` are
**dropped** by one test: no one-letter alias for a command whose Enter destroys state (a live run, the session, the conversation) without a
confirm — `/new` ends the session at once (`session.ts:2690–2702`, recoverable only via `/resume`), `/exit` and `/abort` run on Enter; `/undo`'s
`u` passes because `/undo` opens the `undo` confirm overlay (`App.tsx:1793`); `/new` gets `nw`, `/exit` keeps `q` (the letter every pager teaches) (D-K). `e` and `st` are not aliased (four popular
`e`-prefixes; `st` is ambiguous with `status` and Enter-while-live already steers).

| Command | Aliases after round 3 | Command | Aliases after round 3 |
| --- | --- | --- | --- |
| `/help` | `h` | `/panel` | `p` *(pin)* |
| `/mode` | `m` | `/plan` | `pl` |
| `/model` | `ml` | `/diff` | `d` |
| `/cost` | `c` | `/undo` | `u` |
| `/status` | `s` *(pin)* | `/theme` | `t` *(pin)* |
| `/resume` | `r`, `sessions`, `continue` | `/login` | `l` *(pin)* |
| `/new` | `nw` | `/budget` | `b` |
| `/exit` | `q`, `quit` | `/jev` | `j` |
| `/transcript` | `tr` *(pin)* | `/copy` | `cp` |
| `/config` | `cf` | `/rewind` | `rw` |
| `/why` | `w` | `/decisions` | `dc` |
| `/llm` | — (the word stays; `/m jev-on` is shorter) | `/abort`, `/steer` | — |

Every alias is a valid `NAME_RE` token (`parse.ts:35`), unique across names + aliases (`registry.test.ts:95` already asserts it), never
another command's name, and never collides with `PANEL_ARGS` / `TRANSCRIPT_VIEWS` / `LLM_STATES` (arguments live after the name). Rules:

1. **Enter: an exact alias wins** — already true (`findCommand`, `isExactCommand`, `routeSubmit`'s palette path; `submit.test.ts:40–49`).
2. **Palette ranking: an exact alias pins its owner to the top** (score 1000, like an exact name) instead of appending it last with score 0
   (`palette.ts:163–168`); prefix-alias hits keep their name score. Then `/s` shows `/status` first (steer second), `/p` `/panel`, `/t`
   `/theme`, `/l` `/login`. Typing is never reordered by popularity (rule 6).
3. **Ghost follows the top row:** when the top match is an alias hit whose name does not extend the token, `paletteGhost` returns `{ arrow:
   '/status' }` and the composer draws ` → /status` (dim; `->` under `--ascii`); `→` at the end of the text (`App.tsx:1609–1613`,
   `composer:right`) accepts it as `/status ` — that site reads `ghost.rest` today and is a type error under the `{ arrow }` variant, so it is an
   S4 request S2 lands in W3 (§7.2 App row). Prefix ghosts stay `+tatus (+N)`.
4. **Alias column:** command rows gain a 3-cell dim alias column between the name and the title: `NAME_COL` 15 → 12 + 3 (`palette.ts:53`;
   the alias `padEnd(2)` + one space), the title budget unchanged; hidden below 50 columns. A command with several aliases shows the
   **shortest**; ties → table order (`/resume` → `r`, `/exit` → `q`). Every command row of a frame is exactly the inner width (`palette.test.ts`
   asserts it).
5. **Fuzzy rules unchanged** (`fuzzy.ts:182–221`): prefix 900 − len > word-prefix 700 > subsequence; ties shorter then table order — so `ml`,
   `cp`, `rw`, `dc` match their owners by subsequence even before the alias lands, and `/bdgt` still finds `/budget`.
6. **Groups for an empty query:** *Suggested* (state-keyed, unchanged) → *Recent* (≤ 3 distinct commands from
   `host.history()?.records('workspace')` with `kind === 'command'`, newest first, computed **once at palette open** and cached on
   `paletteRef`; an alias entry resolves to its owner before de-duplication) → *Popular* (16 in a fixed order: help, mode, model, cost,
   status, resume, new, panel, plan, diff, undo, theme, login, budget, jev, exit; `POPULAR` in `registry.ts`) → the rest in table order.
   Rows carry a dim right-hand tag (`Suggested` today; `recent` new); Popular rows carry no tag — the alias column is the cue. A non-empty
   query collapses the groups into score order (Suggested first). The `rewindMenu` filter (`palette.ts:143`) is unchanged.
7. `/help` and `docs/COMMANDS.md` show aliases: the help block prints `  /status, /s   run id, …` (`palette.ts:341–345` today hides them);
   `gen-docs.mjs` already renders `alias \`/<a>\`` — a re-run propagates the table to `COMMANDS.md` and the man page (`registry.test.ts:186`
   `--check` fails until then). Completions never carry slash commands (correct).
8. **Value hints** (`valueHints`, today `/budget` only, `registry.ts:282–289`): add `/mode` (from the badge table: `jev-on  →  jev+llm: the
   code model writes, Jev decides every step`, `llm-jev  →  llm+jev · verified: candidate patches, tests verify, Jev arbitrates`, `jev-only  →
   no generating LLM; code proposes, Jev decides, tests verify`, `jev-off  →  the generator alone (bench condition)`; the row equal to
   `DEFAULT_MODE` is suffixed ` (default)` at render time), `/panel` (`d decisions · p plan · t timeline · s synth · off strip · full 12 rows`),
   `/transcript`, `/theme` (`dark  TypeSafe pink`, …), `/copy`, `/logout`, `/help`, `/decisions` stages. The sub-rows already render them.

### 4.2 Palette frames

**F-P1. `/` after a run that changed files; history holds `/cost` and `/status`; 24×80 (19 dynamic rows: strip 1 + mark 5 + palette 8 + console 5)**
— alias column, Suggested → recent → Popular; the same 8-row card and footer as today; the selected row's `▌` in `accent2`; the rule row is the
strip (a run ended) and the mark sits under it (rows ≥ 24, §3.2). The first draft captioned this frame "13 dynamic rows" and omitted the rule
row and the mark, which `computeLayout` grants here (§3.7):

```
─── ▸ jev s3 · 7 decisions · risk 0.12 ok · plan 1/4 ──────── [d] [p] [t] [s] ──
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ commands ───────────────────────────────────────────────────────────────────╮
│ ▌ /undo       u  restore the files a step changed (verify-before…  Suggested │
│   /cost       c  run and session spend, per-step cost, pending caps   recent │
│   /status     s  run id, session id, step/max, stage, sandbox, work…  recent │
│   /help       h  keys by context, commands with one-liners, per-terminal no… │
│   /mode       m  engine mode: show, or set for the next run                  │
│   (1/37)  Tab completes · Enter runs an exact match · Esc closes ▼           │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › /undo +36                                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ palette                                step 3/40  sess $0.04/10.00 ok  Tab ⇥ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-P2. `/m` typed** (the alias pins `/mode`; `/model` one row down; the enum sub-rows carry the value hints; the ghost is the alias arrow):

```
│ ▌ /mode       m  engine mode: show, or set for the next run                  │
│   /model      ml generator model for the next run only                       │
│   /mode jev-on                    jev+llm: the code model writes, Jev decid… │
│   /mode llm-jev                   llm+jev · verified: candidate patches, te… │
│   /mode jev-only                  no generating LLM; code proposes, Jev dec… │
│   (1/6)  Tab completes · Enter runs /mode · Esc closes                       │
…
│ › /m → /mode +5                                                              │
```

**F-P3. 12×60 flat tier, `/` typed** (the alias column kept at 60 columns; the row budget is today's 7; every palette row is exactly 60 cells —
the first draft's rows measured 54–60 and the tags did not align):

```
▌ /undo       u  restore the files a step change…  Suggested
  /cost       c  run and session spend, per-step co…  recent
  /help       h  keys by context, commands with one-liners,…
  /mode       m  engine mode: show, or set for the next run 
  /model      ml generator model for the next run only      
  /panel      p  Jev panel: toggle, open a tab (d|p|t|s), c…
  (1/37)  Tab completes · Enter runs an exact match · Esc c…
› /undo +36
jev+llm · palette       step 0/–  sess $0.00/10.00 ok  Tab ⇥
```

Row anatomy (76 cells inside the card, 60 flat): marker `▌ ` / two spaces (2) · name `padEnd(12)` · alias `padEnd(2)` + space (3) · title,
clipped with `…` to the remaining budget · two spaces + tag when a tag exists. `palette.test.ts` reads the **palette rows** (command rows,
sub-rows, footer) of F-P1–F-P3 back from this document (the `frameFKRows()` pattern at `:24–35`) and asserts every command row of a frame has one
width; the console and status rows under them are illustrative (`statusLineText` output is pinned in `status/lines.test.ts`) — the doc and the
renderer cannot drift on the rows the palette owns.

### 4.3 Tab completes arguments and never wipes a typed one (R4 F4)

`case 'complete'` (`App.tsx:1372–1384`) sets `/${pick} ` from the command match, so `› /budget spend-cap` + Tab becomes `› /budget `
(measured, `palette-tab.cap` frames 16→17); `argumentCandidates` (`dispatch.ts:452`) has no consumer. New (pure in
`src/tui/commands/local.ts`, S4; the App call site swapped by S2): `completeDraft(draft, cursor, dir, ctx, selected)` parses the draft with
`parseCommandLine`; cursor inside/after the name token → today's command completion; else `argIndex` = completed positionals (`--flags`
skipped), `partial` = the token under the cursor, `candidates = rank(partial, argumentCandidates(spec, argIndex, ctx))`; Tab / Shift+Tab
cycle `pal.selected` over them and **replace only the partial token** (the tail after the cursor is kept); the palette sub-rows filter to
the same candidates with the selected one highlighted; a `run` candidate with spaces is inserted quoted (`/resume "fix the docs" `, `"`
escaped); `rest`/`text`/`path` arguments (`/rename`, `/steer`, `/why`, `/model <id>`, `/export <file>`) have no candidates → Tab is a no-op
with the toast `no completions for <arg>`; after a value is accepted the value hint (`<usd>`, `<n>`, `<dur>`) shows as ghost text. Tests:
`app.test.tsx` sibling in S4's `round3-commands-app.test.tsx` (`/budget sp` Tab → `/budget spend-cap `, Tab cycles, `/budget spend-cap` Tab
keeps the value; `/decisions 5 ri` Tab → stage candidates at index 1); `dispatch.test.ts:219`; pty `commands-idle.steps`. Gate: palette
keystroke p95 < 16 ms (candidates ≤ 37 names, ≤ 8 values, ≤ steps, or the session index ≤ 1,000 titles → `rank` ≤ 1 ms).

### 4.4 The audit: every finding, its fix, its test

Severity as R4 (H breaks a documented behaviour or loses intent · M wrong or misleading output · L polish). Owner = who edits; when the
file belongs to another slot the row says "S3 lands" / "S2 lands" and the diff is this row.

| # | Sev | Finding (R4) | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | M | `/mode` with no argument names the pending mode twice (`mode jev+llm (next run: jev+llm)`; `session.ts:2774` `cur` is `next` unless live) | `const cur = live() && current !== null ? currentRunMode : baseMode; const next = pending.mode ?? baseMode;` then **two forms**: `cur === next` → `mode <badge>[ (default)]`; otherwise `mode <cur badge> — next run: <next badge>[ (default)]` — ` (default)` only after the word equal to `MODE_BADGE_WORD[DEFAULT_MODE]` (D-N), so idle with nothing pending reads `mode jev+llm (default)` and never `mode jev+llm (default) (next run: jev+llm (default))`; `applyConfig` keeps `baseMode` off the pending value (§1.2) so the two words stay different until `run:start` promotes the pending. S3 lands | `session.test.ts:126–150` (pin both forms; a wizard save between `/mode jev-on` and the echo); `round2.pty.test.ts:367` |
| F2 | M | the default mode hard-coded in prose (`registry.ts:67`, `gen-docs.mjs:229`, `run-smoke.sh:16`, `docs/TUI.md`); `MODE_*_SET` a ternary chain; `modeBadgeWord` a ternary | §1.1 (`MODE_BADGE_WORD`, `MODE_SET_ITEM`, derived man line; S4 owns `registry.ts` + `gen-docs.mjs`) | §1.1's grep test; `gen-docs --check` |
| F3 | H | `/panel` and `/transcript` have no `case` in `execute()` — `--plain` prints nothing although `plain: 'yes'`; `/Panel`, `/PANEL d` and `/panel` while the wizard is open reach the host and vanish; with the new aliases `p` / `tr`, every `/p d` and `/tr full` would bypass the App's literal lower-case pre-router (`pane/commands.ts:11` `PANEL_RE`) the same way | **The TUI keeps every spelling App-local.** `parsePanelCommand(line)` (S4, `pane/commands.ts`) first resolves the leading token through `findCommand` (case-folded names + aliases), so `/p d`, `/Panel full`, `/tr compact` all parse; the App's pre-router (`App.tsx:1064–1073`; S2 lands the one-line change) keeps its `nextPanel({ panel: s.panel, tab: s.tab }, arg)` toggle semantics — a second `/p d` on the open decisions tab collapses, which the host cannot reproduce (`UiAction 'panel'` carries a `PanelState` only, `useEngine.tsx:289`; the tab is a separate action and the host has neither state). The host gains the **plain** twins only: `case 'panel'`: `--plain` → `block(\`panel · <tab>\`, panelLines(paneState, size, columns, 'none', { size }))` with `(no decisions yet)` when empty; in the TUI (reachable only while the wizard owns the input) → `note('panel: handled by the TUI', { level: 'warn' })`, no dispatch; `case 'transcript'`: `--plain` → `note('transcript full (--plain is always full)')` (the registry row's `plain` column says `always full`); TUI → the same warn note. Add `default: assertNever(a)` so TypeScript flags a dropped kind. S3 lands the cases; S4 the parser, the registry row and `plain-composer.ts:53` | `round3-commands-app.test.tsx`: `/p d` twice → open then collapsed; `/Panel full` → full; `/tr compact` → compact; `session.test.ts` new (`--plain` `/panel` prints the block); `plain-composer.test.ts:304`; a `CommandAction['kind']` exhaustiveness type test |
| F4 | H | Tab wipes a typed argument | §4.3 | §4.3 |
| F5 | H | `/theme` is App-local: no `[ui]` item in the TUI, the host's `themeOverride` stays null so `/config` reports the old theme and the next `applyConfig` reverts it | the App keeps applying the theme at once (`bridge.ui`, `App.tsx:986–992`) **and** forwards the line to `h.command(line)` (host sets `themeOverride`, prints `theme <t> (new items and the dynamic region only)`, `renderer.setUi` is idempotent for the App); no host yet → local only. S2 lands the App line | `round3-commands-app.test.tsx` (host.commands contains `/theme light`; `bridge.ui.theme` survives a `setUi`); `session.test.ts:645` unchanged |
| F6 / F11 | M / L | `/decisions [n] [stage]` in the TUI ignores `stage` and uses `n` as a row budget of the pane projection; `/plan` and `/decisions` have two sources with no identity assertion | route both to the host (identity by construction): delete the App cases at `:974–985`; the host's `decisions` includes the last intake's rows when `currentStep() === 0`. S2 lands the deletion, S3 the intake rows | `session.test.ts:563` with a stage filter; identity test §8 S5 |
| F7 | H | `/copy diff` copies the **last transcript item** (OSC 52 payload decoded: `[ui] stopped — complete (exit 0)`) | `what === 'diff'` → the App asks the host: `h.command('/copy diff')`; the host builds the diff exactly as `/diff` does (`session.ts:2279–2336`: `diffStatBlockFromGit` or `diffStepLines`), then `copyFn(text, redact, { osc52 })` and the toast; `/copy`, `/copy proposal`, `/copy draft` stay App-local; no run → `nothing to copy for diff`; payload > 64 KiB clipped with a toast (`clipboard.ts:15`). S2 lands the App branch, S3 the host case | `session.test.ts` with a fake `copy` dep asserting the payload starts with `diff`; `round3-commands-app.test.tsx` (G2) |
| F8 | M | `/why` failure text differs by renderer (`App.tsx:962` vs `session.ts:2565,2569`) | `whyErrorText(ref, reason)` in `src/tui/why.ts` (S4) used by both; the App's local lookup keeps its fast path but **falls through to the host** when it finds nothing (the host has 400 decisions, the App only the pane projection) | identity §8 S5; `session-chat.test.ts:718` |
| F9 | M | two help formatters (`palette.ts:302` vs `session.ts:954`) → different transcript text; the plain form can exceed 80 cells | delete `session.ts:954–972`; the controller calls `helpLines(columns(), { ascii, topic, bindings, live })` — the palette formatter gains `live?: boolean` for the `(idle only)`/`(live only)` tags and prints aliases (rule 7); `HELP_TERMINAL_NOTES` (`session.ts:190`) is deleted in favour of `HELP_NOTES` (`palette.ts:248`); `columns()` on a pipe = 80. S4 owns `palette.ts`; S3 lands the session change | `session.test.ts:541–549` (the two-space form); `palette.test.ts:235` |
| F10 | H | `keybindings.json` never reaches the App: `session.ts:3465` loads it, `:2680` reloads, `main.tsx` never passes `opts.bindings` (`App.tsx:2248`), so `resolveKey` runs on `DEFAULT_BINDINGS` (`:553`) and `/help reload` reports success for nothing | `Renderer.setBindings?(b: Bindings)` (§6); `session.ts` calls it after the load (`:3465`) and in `case 'help' reload` (`:2680`); the App stores it in a ref read by `resolveKey` (`:1739,1743`) and `helpLines` (`:940,1310`); a chord in flight resets on swap; reserved keys are already refused (`keybindings-file.ts`). S3 lands the session lines, S2 the App ref | `round3-commands-app.test.tsx` (mount with `bindings` from `loadKeybindings` of a temp file mapping `global:help` to `none` → `?` inserts text); pty `--keybindings` scenario asserting the same and `/help reload` swapping live |
| F12 | M | `/new` before any session prints nothing | `note('no session yet — the next prompt starts one')`. S3 | `session.test.ts:500–518` |
| F13 | L | `/rename` silently cuts at 60 | append ` (cut to 60 chars)` when `title.length > 60`. S3 | `session.test.ts:528` |
| F14 | H | while the intake is thinking, Enter on a `/` line is dropped silently (`App.tsx:1074` exempts `/` lines from the toast; `routeSubmit` returns `ignore('submitting')`) | `routeSubmit` gains `allowCommandsWhileSubmitting: true` for `isCommandLine(text)`; `dispatchCommand` sees `run: 'none'` while `chatThinking(s)` (a chat request is not a run); idle-only commands during thinking answer `STILL_THINKING_TOAST` instead of `Esc pauses first`; `/exit` while thinking cancels the request and exits; `/steer` → `needs a live run`; a reply landing mid-command keeps ordering. S4 owns `submit.ts`/`dispatch.ts`; S2 lands the App lines | `round2-app.test.tsx:89` sibling in `round3-commands-app.test.tsx`; pty `commands-thinking.steps` |
| F15 | M | `/model` and `/provider` have no show form; no cross-check; silently irrelevant under `jev-only` | `optional: true` on both (S4 registry); no argument → `model <current> (next run: <pending>)` / `provider …`; setting either under a jev-only next mode appends ` — mode jev-only ignores the generator; /llm on to use it`; a `/model` id without `/` under openrouter (or with one under anthropic) appends a soft warning. S3 lands | `session.test.ts:565`; `dispatch.test.ts:152` |
| F16 | L | `/logout` items read `[setup] [setup] …` (`login.ts:648,662,673` + `session.ts:2609`) | `commandLogout(flags, io, { labelled: false })` from the session. S3 | `session.test.ts:1091–1098` |
| F17 | H | `/trust` reopens the trust card through the wizard; Esc and Enter inert; Ctrl-C **exits the session with 2** and `case 'trust'` prints the stale decision as new | the trust card opened by `/trust` gets `reason: 'trust'`: Esc and Ctrl-C **close it** and resolve `null` (like the `mode` wizard); `case 'trust'` prints `trust unchanged (<decision>)` when `trustGate` returned without a new decision; Enter stays inert (no default). S3 owns `tui-prompter.ts:194–207`, `Wizard.tsx`, `session.ts:2807–2810,1568` | `wizard.test.tsx`; pty `trust-esc.steps` (expected exit 0) |
| F18 | L | `/errors` never acks `!n` (only Ctrl+O dispatches `ack-errors`) | `extras.dispatch?.({ type: 'ack-errors' })` after the block. S3 | `round3-commands-app.test.tsx` (`!n` cleared) |
| F19 | L | `/login` re-entry shows the startup copy `No Jev key found. Where do you reach Jev?` | under reason `login` the jevProvider title reads `Where do you reach Jev?` (no "No Jev key found."). S3 (`lines.ts`) | `lines.test.ts` |
| F20 | L | the App's `dispatchCtx()` (`App.tsx:802–807`) lacks `isDeniedPath` and maps `sessions[].id = sessionId`; the host's (`session.ts:3423–3431`) uses `newestRunId ?? sessionId` and the denylist | `SessionHost` gains the optional `dispatchContext?(): Omit<DispatchContext, 'run'>` (§6 item 7 — today only the `ControllerHost` extension at `session.ts:470` declares it, so `bridge.host?.dispatchContext()` did not exist on the contract the App sees); the App asks `bridge.host?.dispatchContext?.()` when present and falls back to its own otherwise (one function, `local.ts` `dispatchCtxOf(host, state)`). S3 lands the contract line (W0), S2 the App | `round3-commands-app.test.tsx` |
| F21 | M | an errored command keeps the draft, so the next line appends (`› /steer x/pause`) | `DispatchResult` gains `keepDraft: boolean`: true for fixable errors (unknown command, tokeniser, bad argument), false for availability errors (`needs a live run`, `runs when the run is idle`, `not available in --plain`) and for `[ui] error:` results of a dispatched command (as `/why` already does); the App's `case 'error'` (`App.tsx:1100–1102`) clears when `!keepDraft`; the palette closes on a cleared draft; history never records an errored line. **D-K ratify.** S4 owns `dispatch.ts`/`submit.ts`; S2 lands the App line | `submit.test.ts:32`; `round3-commands-app.test.tsx` (`/budgett` keeps; `/undo` live clears) |
| F22 / F23 | M / L | aliases second-class in the palette; one-letter prefixes rank a different command first | §4.1 rules 2–4 | §4.1 tests (`registry.test.ts`: for every alias `paletteMatches('/'+alias)[0].spec.name === owner`; `paletteGhost` arrow for a non-prefix alias; `isExactCommand`; `routeSubmit` runs the owner) |
| G1–G5 | — | no controller test for `/calibration`, `/report`; no TUI test for `/copy`; no end-to-end `/history clear`; no pty matrix per state; nothing asserts every `CommandAction['kind']` is handled | §8 S4: the dispatch-loop test asserts every `COMMANDS[i].name` has a `/name` literal in a test outside the loop **and** a `case '<kind>'` in `App.tsx` `runCommand` or `session.ts` `execute()`; `assertNever` closes the switch; the pty matrix `commands-{idle,live,thinking}.steps` | landed as their own commit **before** the behaviour changes so every fix lands against a failing test |

### 4.5 Keys that equal commands; unbound-by-default actions

| Key(s) | Equals | Gap closed |
| --- | --- | --- |
| `?` / F1 (`global:help`) | `/help` | rebinding now honoured (F10) |
| Ctrl+O (`global:detail`) | `/why` for the step + `/errors` (acks `!n`) | `/errors` acks too (F18) |
| Esc / Esc Esc while live; Ctrl+C live with an empty draft | `/pause` / `/abort` | — |
| ↑ on the first row with steers queued | `/unsteer` | — |
| Alt+J / Alt+Shift+J / Alt+D/P/T/S, `[` `]` | `/panel …` | — |
| Ctrl+G | `/editor` | — |
| `session:export` (unbound) | `/export` | — |
| **new, unbound by default:** `session:cost`, `session:status`, `session:mode`, `files:diff`, `files:undo`, `ui:copy` (`keys/bindings.ts`, S4) | `/cost`, `/status`, `/mode`, `/diff`, `/undo`, `/copy` | a user binds e.g. `"session:cost": "ctrl+x c"`; no default keys (every free printable is text, every free Ctrl is a terminal risk); `docs/KEYS.md` regenerates |

Constraint check: nothing here runs before the first frame (the palette, history and aliases are consulted after `/`); the palette stays
≤ `CAP.palette` 8 rows (the alias column changes no row count); ranking stays O(37) per key and Recent is computed at open (composer p95
gate); no new timer (dynamic fps); every changed item string moves into one formatter shared by both renderers (identity); `/copy` still
goes through `redact`; Enter stays inert on the trust card (no auto-approve).

---

## 5. Message style guide, animation catalogue, identity (D-L, D-M, D-O, D-P)

### 5.1 The style guide (13 rules; the TUI renderer's, never the text's)

1. **Label gutter: 10 cells, right-aligned, bodies at column 10** (D-L). `[jevcode]`, `[sandbox]` (9) sit flush; `[you]`, `[run]`, `[ui]`,
   `[step 7]`, `[setup]`, `[config]` are padded on the left. `[step 100]` (10) touches the edge; steps ≥ 100 push the body by the excess
   (the default cap is 40). The row's **text** is unchanged: `formatTranscriptItem(item)` is still label + one space + text; only leading
   spaces are added. Implementation: `TranscriptRow` (`Transcript.tsx:108–134`) renders `label.padStart(LABEL_GUTTER − 1)` in a `flexShrink=0`
   box of width `LABEL_GUTTER − 1` and the body in a box starting at column 10 (`marginLeft={1}`), so wrapped rows hang at 10; `LABEL_GUTTER =
   10` exported from `Transcript.tsx`. Price: `[you]`/`[run]` bodies have 70 cells at 80 columns instead of 74 (F-R4).
2. **Label colour is the speaker; body colour is the meaning** (D-O). `[jevcode]` `assistant` (pink bold), `[you]` `you` (magenta bold),
   every other label `dim`. Bodies: default for chat, steps, `[ui]` notes **and every detail row** (the epilogue's `resume` / `report` commands are body text; a
   50 % dim is 3.3:1, §2.5); amber for `warn`/`[review]` rows; red for `error`/`[block]`; dim only for the ≤ 12-cell label and for `[run] git …`
   (`itemRole` loses its `[ui]` → dim branch). Never a pink body.
3. **Wrap at ` · ` before wrapping at spaces; never orphan a short token.** For any body containing ` · ` (steps, `blocking`, `/jev`, `/cost`
   rows): pack whole segments greedily into rows of `columns − 10`; a continuation row starts with `· ` (the separator leads); a segment
   wider than a row falls back to word wrap. For every body: a final token narrower than 4 cells (`4`, `5))`, `·`, `ok`) joins the previous
   word on the next row (so `[run] end … exit` / `4` becomes `… (gen $0.000, jev $0.025)` / `exit 4`, F-R6). Pure: `wrapBody(text, width, g):
   string[]` in new `src/tui/transcript/wrap.ts` (S5), one `<Text>` per pre-split row — which also removes Ink's trailing-space artefacts
   (`auto-24x80.txt:657`). `--ascii` bodies split on ` - ` (`glyphs.ts:159,168` `dot`).
4. **Detail rows (TUI-only) indent under the body column** (`Transcript.tsx:127–131` today draws them at column 0), and when a detail row
   matches `/^(\S+\s{2,})/` (the epilogue's `label     value` table, `epilogue.ts:75–82` `padEnd(10)`) its wrap hangs under the value.
5. **Sentence case, no trailing period on single-line items, one thought per row.** `[ui]` heads are nouns (`jev`, `cost`, `stopped —
   replan_stop (exit 4)`), never the first data row: `session.ts:2479` → `block('cost', costBlock(...))` (today the head is `run $0.025 of
   $0.250` — R5 F6).
6. **Numbers.** Money `$0.025` (three decimals; four below $0.001, `stepCostText` `plain.ts:423–426`), caps two (`$2.00`), never scientific
   notation: `budget/lines.ts:341` `~$${each.toExponential(1)} each` → `~$${each.toFixed(6).replace(/0+$/, '')} each` (`~$0.000006 each`);
   durations `4.9s`, `14s`, `1m02s`; probabilities two decimals; the `10 %` form of `/cost` keeps its space (a local item; pick one and keep it).
7. **Ids.** A run id appears in at most two scrollback rows per run today's text allows (`[run] start`, the epilogue's `run` row) and in
   `[run] end`'s surroundings only through the `[ui] stopped` detail; never in the status centre (the centre shows `/rename` titles only —
   `centreText`, `status/lines.ts:475`: drop the `else the run id` branch); loop signatures stay as today (D-M defers the `[step]` text).
8. **Max line length.** A `[jevcode]` reply ≤ 160 characters (`REPLY_TEXT_MAX`), a fact ≤ 240; `[ui]` heads ≤ 60 so they never wrap.
9. **Spacing rows.** One blank row above every `[you]` turn, above the first `[jevcode]` of a turn, above `[run] start` and `[run] end`
   (`spacerAbove`, `Transcript.tsx:96–101`) and — new — above a `[ui]` item that carries a `detail` body (`/jev`, `/cost`, the epilogue,
   `/help`), so a block reads as a block.
10. **Hidden in compact** unchanged (`COMPACT_HIDDEN_KINDS`, `useEngine.tsx:64`).
11. **Bubbles.** No box, no background, no rail glyph — the scrollback stays plain text (identity). The pink label *is* the bubble.
12. **Dynamic rows** (never transcript): the live `synth` row `dim`; the loop banner reads `loop · patch repeated 2 of 3` / `loop · replan 1
    of 5 · s7 gather_context (p 0.62 · impossible 0.20)` (`bannerRow`, `pane/banner.ts:115–125`: ` · ` separators like every other row; no
    identity cost) and is **cleared at `run:end`** (R5 F8: `useEngine.tsx:722–744` gains `loop: null, loopFold: emptyLoopFold(next.loopFold.maxReplans)`);
    the status row colours the left word and the meter words only (§5.2 P6).
13. **Copy.** Generator-neutral ("the code model writes the code"); "Jev decides every step" is the sentence to repeat; product names as
    typesafe.ai writes them (Jev, System One Models); the tagline exactly `Decisions, not strings`. The `[sandbox]` item becomes one thought:
    `sandboxText` (`onboarding/lines.ts:291–295`) → `seatbelt · writes only in the workspace and run dirs · secrets, ~/.ssh, ~/.aws unreadable ·
    network on (--no-network)` (117 cells: **two rows at 80 and at 120 columns** — the body width is 70 and 110 — broken at ` · ` by rule 3; the
    first draft claimed one row at 120), the `none` variant `none · sandbox-exec is not available on <platform> · cwd confinement, env scrubbing,
    timeout, output cap and tree kill only`; the item gains `detail` with today's sentence (TUI-only body). `[sandbox]` is a **renderer-local**
    item, not an engine notice (`session.ts:3524` `note(…, { label: '[sandbox]' })`, `Wizard.tsx:159` `onItem(line, '[sandbox]')`; `plain.ts:496–508`
    `localItem` — never in `transcript.log`), so this is a local-item text change like `/cost`'s (§5.3). Item text → its one formatter with tests
    (`onboarding/lines.test.ts`, facts tests, `grep -rn "writes confined" test`).

### 5.2 Animation catalogue (every tick through `useMotion`/`useIdleLoop` in `motion.ts` or the existing 8 fps spinner interval; none adds or removes rows while it runs)

| # | Animation | Frames / fps | Colour | Reduced-motion twin | `--ascii` | Gate | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | **Splash reveal → held mark** (§3.4): reveal 0–400 ms (7 cells/frame), shimmer 450–550, held from 550; no fade | 12 written frames, 20 fps nominal (≤ 15 by construction) | `JEV` accent, `CODE` dim, head/band sweep | static mark from frame 0 | `#` letters, `#+.` head | first frame unchanged; splash bucket ≤ 22 | S2 |
| A2 | **Idle sweep loop** (§3.4) | 16 frames per 4 s pass, period 10 s (30 s calm), asleep after 10 min; 4 fps peak, 1.6 mean | band sweep | none | same (colour-only) | idle fps ≤ 4 peak / ≤ 2 mean; ≤ 12 KB/s | S2 |
| A3 | **Thinking / stage spinner** (D-P): frames `░ ▒ ▓ █ ▓ ▒` at the existing 125 ms tick (750 ms cycle); words `thinking` · `looking` · `replying`, stage verbs live | 8 fps, unchanged tick | glyph `accent` (status spans) | static `◆` (`spinnerStatic`) | `. + # # + .`, static `*` | dynamic fps unchanged (same timer) | S2 (`glyphs.ts:121–122`, `spinner.ts:19–20`) |
| A4 | **Streaming caret** (jev-on / llm-jev live region): the last live row ends with `▍` while `spinnerFrame % 8 < 4`, nothing otherwise — a **1 Hz** blink (500 ms on / 500 ms off) riding the 8 fps tick, the cadence of a terminal cursor; the first draft's even/odd toggle was a 4 Hz flicker, above WCAG 2.3.1's three flashes per second and visibly nervous for the whole live phase | 0 extra frames | `sweep` | steady `▍` | `\|` | zero added frames (the live flush redraws these rows) | S2 (`liveLines` consumers, `App.tsx:185–202`) |
| A5 | **Run-start rule sweep**: at `run:start` a 12-cell band of the strip's `─` cells lights `borderFocus` and travels left → right for 300 ms; the console edges flip `border` → `borderFocus` in the first frame | 6 frames at 50 ms (`useMotion(runStarting, 300)` keyed by `state.runId`) | `borderFocus` on `─` cells | no sweep, instant flip | colour-only | ≤ 6 extra `dynamic` frames in the run's first second (a `run-start` bucket in `render-lag.ts` gated at maxFps + 1); zero clears | S2 (`RuleRow`, `App.tsx:2142–2159`) |
| A6 | **Run-end edge fade**: at `run:end` the console edges go `borderFocus` → `accent2` → `border` at 70 ms steps; the status left word takes its final colour in the first frame (amber for a non-complete stop, green for `complete`) | 3 frames (`useMotion(runEnded, 210)`); 16 colours: `magenta` → `magentaBright` → dim | as named | instant | colour-only | 3 frames; `Console` gets `edgeRole?: ColorRole` (S5 lands) | S2 |
| A7 | **Toast last-second dim**: in a toast's final 1,000 ms its text is `dim` (`toastPhase(t, nowMs) === 'fading'` ⇔ `untilMs − nowMs ≤ 1000`); colours by level: `!` info `accent`, `✓` ok `ok`, `!` error `error` | 0 extra frames (the 1 Hz tick already redraws the clock) | as named | same (a dim step is not motion) | `+` / `!` | none | S5 (`toasts.ts`, status spans) |
| A8 | **Review card arm**: frame 1 (the card's commit) keys row `dim`; frame 2 (`overlay:armed`, ≥ 150 ms or the flush) keys row bold in the verdict colour — the card "wakes up" exactly when `y` becomes live | 0 extra frames (the arm dispatch already commits) | verdict colour | same two frames (state, not motion) | — | review invariants untouched (drawing only; `resolveKey` unchanged) | S5 (`Review.tsx:165,183`, `OverlayData.review.armed`) |
| A9 | **Palette / picker selection**: the `▌` marker in `accent2`, matched spans bold | 0 | `accent2` | same | `> ` | palette composer p95 | S4 (`Overlay.tsx:195–216,246`) |

Deliberately **not** animated: transcript text (a typewriter fights `<Static>`'s write-once rule), panel open/close (rows appearing
gradually would move the composer under the cursor), the meters (they change with data), the placeholder (it changes with state; P7 removes
its only flicker).

**P6 — status spans (S5).** `statusSpans(state, columns, opts): { text: string; spans: { from: number; to: number; role: ColorRole }[] }` in
`status/lines.ts` beside `statusLineText` (positions from `statusZones`, `:497–559`): the leading spinner glyph (`accent`), the left word
when `done` (`ok` for `complete`, `warn` otherwise), meter words (`high` → `warn`, `critical`/`over` → `error`), `⚠ secret?` (`secret`), a
toast by level (A7). `Console.tsx:174–200` and `StatusLine.tsx:65–82` render the spans (`statusRole` retires; the whole-row `bold={done}`
goes). The flat tier's `<badge> · ` prefix takes `badge`.

**P7 — no wrong chrome between Enter and the bubble (S2 + S5).** Measured: one or two frames after every Enter read `starting` +
`Type to steer the next step…` because `composerMode` (`App.tsx:1961–1962,1972–1973`) reads `state.run !== 'none' ? 'steer'` while `run` is
already `'starting'`, and `leftWord` (`status/lines.ts:336`) returns `'starting'` for the same state. Fix: `send()` dispatches `{ type:
'thinking', phase: 'intake' }` together with `run:starting` for a session submission (S2), so the very first frame reads `▓ thinking` /
`(thinking…)`; and `composerMode` treats `run === 'starting' && !thinking` as the previous idle mode (`followup`/`task`), `leftWord` returns
`idle` for it (S5). The one-shot argv path (`kind: 'task'`) has no chat phase: `run:start` follows and the steer placeholder is right from
then on. Test: after Enter the first frame has neither `Type to steer` nor `│ starting`; the `intake-latency` probe's `thinking seen`
counter becomes 20/20.

### 5.3 Identity classification

| Proposal | Changes transcript **text**? | Where | Twins to update |
| --- | --- | --- | --- |
| §3 wordmark, §2 palette, §5.1 rules 1–4 (gutter, wrap, detail indent, spacer), §5.2 A1–A9, P6, P7, the banner text (dynamic row), status spans | **No** — colour, spacing, wrapping, dynamic rows only | `Transcript.tsx`, `transcript/wrap.ts`, `theme.ts`, `Console.tsx`, `StatusLine.tsx`, `Review.tsx`, `Overlay.tsx`, `App.tsx`, `useEngine.tsx`, `splash.ts`, `wordmark.ts`, `layout.ts`, `spinner.ts`, `glyphs.ts`, `banner.ts` | none for text; the frame-identity tests learn the normaliser below |
| §5.1 rules 5–6 (`/cost` head, `~$0.000006 each`), `/jev` row 3 `last: question about this tool (1.00)` (was the internal key) | **Yes, local `[ui]` items only** — printed by the TUI and `--plain`, never in `transcript.log` (`plain.ts:496–508` `localItem`) | `session.ts:2479,2526–2530`, `budget/lines.ts:341` | `round2.pty.test.ts:312` regex; `budget` unit tests; the `--plain` twin prints the same rows |
| §5.1 rule 13 `[sandbox]` | **Yes, a renderer-local item** (`note(…, { label: '[sandbox]' })`, `session.ts:3524`; `Wizard.tsx:159`; never in `transcript.log`) | `onboarding/lines.ts:291–295` + `detail` at the two `note` sites | `onboarding/lines.test.ts`, facts tests, `plainwarn.steps` if it greps the sentence; the `--plain` twin prints the same row |
| §1.9 copy, `MODE_SET_ITEM`, `modeSetItem`, `/mode` echo, `/new`, `/rename`, `/model`, `/provider`, `/why` error, help block, `/logout` label, `/trust` note, `CREDITS_EXHAUSTED`, caps item, `defaultModeItem` (D-Q), `modeSavedItem`, `panel: handled by the TUI` | **Yes, session items** (local when idle, engine `notice` while live for the facts) | `session.ts`, `facts.ts`, `replies.ts`, `palette.ts helpLines`, `why.ts` | one formatter each, shared by both renderers, with tests |
| R5 P5 (`[run] start/end`, `replan`, `loop tripped`, `stop:` forms) | **Yes — engine items in `transcript.log`** | — | **deferred (D-M)**: `src/perf/pty.ts:800`, twelve test files |
| R5 P13c (session header without `\| step 0/– starting`) | **Yes, the synthetic header** (TUI + `--plain` line 1) | — | **deferred**: the `step 0/` sentinel lives in the status row too, but `chat.pty.test.ts:81`, `taskfile-header.steps`, `perf/first-frame.ts` read it from the first frame; round 4 |

**The identity normaliser** (R5 `polish.md:521` verbatim; replaces `wrapLike` in `app.test.tsx:299` and `round2-transcript.test.tsx:23`, S2/S5 in
their own test files): for every visible item, take its rows, strip the leading spaces of the first row and the gutter of every continuation
row, join the rows with one space, collapse runs of spaces — the result equals `formatTranscriptItem(item)`. **No separator clause:** a
continuation row that starts with `· ` (rule 3) follows a row that ends with the previous segment's last token, so the plain join already
yields `… risk 0.00 ok · tests 4p/3f/0e …`; the first draft's "drop a leading `· ` when the previous row did not end with ` · `" would have fired
on every segment wrap and deleted the separator — failing the test against a correct renderer, or tempting an implementer to drop
separators and break TUI/`--plain` identity. Explicit cases in `transcript/wrap.test.ts` and `round2-transcript.test.tsx`: the F-R4 step row
(`… · risk 0.00 ok` / `· tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006`) and `[run] end … (gen $0.000, jev $0.025)` / `exit 4`. Stronger and simpler
than "word-wrapped at the commit width with a hanging indent of `label.length + 1`", and it holds under any wrap rule that never splits or
reorders tokens. `--plain` and `transcript.log` are untouched.

### 5.4 Replacement frames (24×80; the label gutter, the pink roles; every status row is `statusLineText(state, 76)` output with the jev-on caps)

Colour legend: `pink` = accent `#f386a1`, `magenta` = `#d45bb6`, `dim` = the terminal's faint attribute; bodies default.

**F-R3. Chatting (the reply), 24×80 (11 dynamic rows; 4 scrollback rows above).** `[you]` label magenta bold, `[jevcode]` label pink bold,
bodies default; the wrap hangs under column 10; the mark stays under the plain rule.

```
    [you] hi

[jevcode] Hi. I'm ready when you are — describe a change you want in proj, or
          ask what I can do.
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                   step 0/–  sess $0.00/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-R4. Run live, 24×80 (7 dynamic rows; 8 scrollback rows above).** The 71-character task bubble now wraps (the gutter's price); `[run]
start` keeps today's text (D-M) and wraps by the word rule; the step row breaks before ` · ` and the separator leads the continuation; the
strip's `▸ jev` is pink, the rest dim; the console edges magenta while live; the `›` amber (`steer`); the spinner pink; the live `synth`
row dim; the mark is hidden.

```
    [you] Fix the failing tests in tests/test_core.py without changing the
          tests.

    [run] start 20260921-212813-uo5luiq4 mode=jev-on task: Fix the failing tests
          in tests/test_core.py without changing the tests.
    [run] git main · 3 modified · 1 untracked
 [step 1] run $ python -m pytest -q tests/test_core.py · risk 0.00 ok
          · tests 4p/3f/0e · judge 0.49 · 4.9s · $0.006
─── ▸ jev s1 · 75 decisions · risk 0.00 ok · plan 0/2 ─────── [d] [p] [t] [s] ──
synth goal: g1: fix issue::d577757d in calc/core.py (1 test, attempt 1, picked …
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Type to steer the next step…  Esc pauses                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓ context    step 1/40 0m05s  run $0.01/2.00 ok  sess $0.01/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-R6. Run end, 24×80 (11 dynamic rows; 10 scrollback rows above).** `[run] end` keeps today's text; the orphan rule moves `exit 4` down
with its word; the epilogue's four detail rows are indented under the label column and hang under their own values; the loop banner is
gone; the edges fade back to dim; only the left word `idle exit 4` is amber; the mark returns under the strip at once because 24 rows meets
`WORDMARK_POST_RUN_MIN_ROWS` (§3.2) — the 13 scrollback rows above it keep `[run] end` and the whole epilogue on screen.

```
    [run] end replan_stop steps=9 wall=14s cost=$0.025 (gen $0.000, jev $0.025)
          exit 4

     [ui] stopped — replan_stop (exit 4)
          run       20260921-212813-uo5luiq4
          files     ~/.jevcode/runs/20260921-212813-uo5luiq4/
                    (transcript.log, state.json, jevcode.log)
          resume    jevcode run --resume 20260921-212813-uo5luiq4
          report    jevcode report 20260921-212813-uo5luiq4
                    (redacted bundle written locally; nothing is sent)
─── ▸ jev s9 · 75 decisions · risk 0.99 [block] ───────────── [d] [p] [t] [s] ──
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4  step 9/40 0m14s  run $0.03/2.00 ok  sess $0.03/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-R8. First run, no key anywhere: the wizard's one `key` step under the held mark, 24×80 (13 dynamic rows; 1 scrollback row above).**
The pane slot is not the console, so the first-run screen is the mark and one masked field. Rows: status 1 + rule 1 + chrome 3 + wizard 3 +
pane 5 (`computeLayout`: the wizard is the input, no composer floor — the first draft said 14). Every hosted row ≤ 76 cells (§1.4.2). Title bold,
the masked field, the hint dim;
`? help` is `''` under the wizard (`status/lines.ts:413–418`); no session meter yet.

```
    [run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██████  ███████
                ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
                ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
            ██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
             ████  ███████   ████    ██████  ██████  ██████  ███████  ◆ 0.3.0
╭─ setup · key ───────────────────────────────────────────────────────── proj ─╮
│ OpenRouter API key — one key runs Jev and the code model                     │
│ › ••••••••••••••••••••                                                       │
│ 20 chars · Enter saves · Ctrl-U clears · Esc clears (again: other ways)      │
├──────────────────────────────────────────────────────────────────────────────┤
│ setup                                                               step 0/– │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-R9. The `options` step after Esc on the empty field (the console rows only; the mark stays above); no highlight yet.**

```
╭─ setup · options ───────────────────────────────────────────────────── proj ─╮
│ Other ways to start:                                                         │
│   1 OpenRouter   2 TypeSafe   3 Jev only   4 Anthropic                       │
│ pick 1–4 · Esc back                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ setup                                                               step 0/– │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**F-R9h. After `3` (highlighted; the same digit or Enter confirms; the three body rows only):**

```
│ Other ways to start — Enter confirms 3:                                      │
│   1 OpenRouter   2 TypeSafe  ▌3 Jev only   4 Anthropic                       │
│ 3: no LLM — code proposes, Jev decides, tests verify · caps $0.25 / $1.25    │
```

The review card (R5 R-5), the error pane (R5 R-7) and the 40×120 twins change only by the gutter and the roles named above; `frames2.test.ts`
rebuilds them from the twins (§8 S5).

---

## 6. Contract changes — contract 1.3 (additive, ordered; S3 lands items 1–7 in W0, the rest are each owner's own files)

Header comment for `src/core/types.ts:9`: `// contract 1.3 (2026-09-21): TUI round 3 — renderer bindings, wizard `mode` outcome, ui.wordmark,
host dispatch context, per docs/TUI-DESIGN-3.md §6; every item is optional or a default-preserving widening; CheckpointEnvelope.version stays 1.`

```ts
// 1  Renderer (types.ts:1564) — the App receives the effective bindings (R4 F10); every fake keeps compiling.
//    `Bindings` (src/tui/keys/bindings.ts:203: table / chordPrefixes / keysOf / warnings over ReadonlyMaps) is imported `type`-only — the FIRST
//    core → tui import in the repo (`git grep "from '../tui" src/core` finds none today); recorded here as the contract's one inversion.
//    Alternative rejected: redeclaring the four-map shape in core would be a second source of truth for the key tables.
setBindings?(bindings: import('../tui/keys/bindings.js').Bindings): void;
// 2  WizardOutcome (src/cli/session.ts:335 — NOT core/types.ts; the type lives with Prompter) — the options step's `3 Jev only` pends or persists a mode without saving a key (§1.4)
export type WizardOutcome = { kind: 'saved'; patch: CredentialsPatch } | { kind: 'persisted' } | { kind: 'cancelled' } | { kind: 'mode'; mode: EngineMode; persist: boolean };
// 3  Prompter.wizard (src/cli/session.ts:347) — the detect-time hint of what already resolves (§1.4.3)
wizard?(missing: readonly SecretSettingName[], o: { provider: WizardProvider | null; reason: WizardReason; mode?: EngineMode; found?: 'typesafe' | 'jev' | 'anthropic' | null; foundSource?: 'env' | 'dotenv' | 'file' }): Promise<WizardOutcome>;
// 4  UiConfig (types.ts:1457) — the wordmark setting (§3.2 twins), OPTIONAL: App.tsx:988 builds a complete UiConfig literal in `case 'theme'`,
//    json-stream.ts and the test fakes construct one too — a required member would break tsc in W0 across files no slot lists. Readers:
//    `ui?.wordmark ?? (ssh ? 'static' : 'sweep')`
wordmark?: 'sweep' | 'static' | 'off';
// 5  SettingName (src/config/types.ts:31–42) gains 'ui.wordmark'; src/config/ui.ts:50–69 resolves it with enumSetting(reader, 'ui.wordmark', r, ['sweep','static','off']) default `launch.ssh ? 'static' : 'sweep'`; `jevcode config` prints `ui.wordmark  sweep  default` (`static  default (ssh)` over SSH); `jevcode config set ui.wordmark off` persists it
// 6  src/config/defaults.ts:43–44 — DEFAULT_MODE: EngineMode; MODE_BADGE_WORD; MODE_BADGE_MAX_CELLS (§1.1)
// 7  SessionHost (types.ts:1487) — F20: the App reads the host's dispatch context (today only ControllerHost, session.ts:470, declares it)
dispatchContext?(): Omit<DispatchContext, 'run'>;
// 8  not core, by owner:
//    LaunchSettings.themeHint?: 'light' (launch.ts, S3, D-R: COLORFGBG background 7 | 15); LaunchSettings.ssh: boolean (already computed for the fps default; exposed for ui.wordmark)
//    UiState (useEngine.tsx, S2): readonly lastActivityAt: number (set by key, run:end, panel, resize — not by a reply, §3.6); readonly postRunKeySeen: boolean (false at run:end, true at the next key, §3.2); SplashState unchanged ('running' | 'done'); the reducer's run:end clears `loop` / `loopFold` (§5.1 rule 12)
//    UiAction (useEngine.tsx, S2): | { type: 'resize' } (the App dispatches it from the geometry effect so lastActivityAt moves)
//    LayoutInput.paneWhole?: boolean (layout.ts, S2, §3.7) · RuleRowInput.wordmark: boolean (Pane.tsx, S2, §3.3)
//    SplashPhase = 'reveal' | 'shimmer' | 'held' (splash.ts, S2); splashFrame(t, columns, g, version) (§3.4); wordmarkFrame(i) returns { rows, spans(band) } (wordmark.ts, S2, §3.8); SplashSpan.role may be 'accent2' (caption ◆)
//    ColorRole gains 'accent2'; export function labelRole(item): 'assistant' | 'you' | 'dim'; itemRole drops the `[ui]` → dim branch (theme.ts, S1, §2.1, §5.1 rule 2)
//    ConsoleProps.edgeRole?: ColorRole (Console.tsx, S5 — A6 fade); ConsoleProps.status spans via statusSpans (S5, P6); ReviewProps.armed: boolean (Review.tsx, S5, A8)
//    WizardField | 'key'; WizardStep 'key' | 'options'; OnboardingState.found / foundSource / optionsShown / highlight / pendMode; SaveRequest.oneKey / keyAs; OnboardingAction choose option 1–4 | 'enter'; isFieldStep(step) (onboarding/reducer.ts, S3, §1.4.1)
//    WizardSaveInput gains oneKey / keyAs / reuseJevForGenerator; TuiWizardHost.verify; TuiPrompterControls.verifyKeys (tui-prompter.ts, S3)
//    VerifyInput { mode, generatorModel, jevBaseUrl, jevModel, signal? }; VerifyResult.reason 'rejected' | 'credits' | 'unreachable' | 'model' (login.ts, S3, §1.5)
//    LoginFlags.keyStdin; STRING/BOOLEAN flag spec `--key-stdin` (args.ts, S3)
//    CommandSpec.aliases (registry.ts, S4: 21 new strings); POPULAR: readonly string[]; DispatchResult.keepDraft: boolean (dispatch.ts, S4); PaletteState.recent: readonly string[]; PaletteGhost = { rest; more } | { arrow: string } (palette.ts, S4); KEY_ACTIONS 'session:cost' | 'session:status' | 'session:mode' | 'files:diff' | 'files:undo' | 'ui:copy' unbound (keys/bindings.ts, S4); parsePanelCommand resolves aliases and case (pane/commands.ts, S4)
//    ProbeName | 'idle-frames'; ComposerSeriesName | 'idle-loop' (src/perf, S5)
```

Config rows and defaults added this round: `ui.wordmark` (above); no other setting. `DEFAULT_MODE` flips in commit 2 (§1.10) — the only
default that changes.

---

## 7. Module map — five slots, exclusive files, waves

### 7.1 Slots and the files each may edit (every file has exactly one owner; a slot that needs a change in another slot's file sends the request — the rows of §7.2 are those requests, written here verbatim so the owner lands them without a second design pass)

| Slot | Owns (edit unless marked new) | Sections |
| --- | --- | --- |
| **S1 theme** | `src/tui/theme.ts`, `src/tui/color-shim.ts`, `test/unit/tui/theme.test.ts`, `test/unit/tui/theme-palette.test.ts` (new), `test/unit/tui/color-shim.test.ts` | §2 |
| **S2 wordmark + animations** | `src/tui/wordmark.ts` (new), `src/tui/splash.ts`, `src/tui/motion.ts`, `src/tui/layout.ts`, `src/tui/Pane.tsx`, `src/tui/glyphs.ts`, `src/tui/spinner.ts`, `src/tui/useEngine.tsx`, **`src/tui/App.tsx`**, `src/tui/pane/banner.ts`, `test/unit/tui/{wordmark,splash,motion,spinner,glyphs}.test.ts*`, `test/unit/tui/layout/**`, `test/unit/tui/{app,round2-app,round2-reducer,frames2,height}.test.tsx?`, `test/unit/tui/pane/banner.test.ts` | §3, §5.2 A1–A6, §1.1 (App/useEngine `DEFAULT_MODE`) |
| **S3 defaults + onboarding** | `src/core/types.ts` (§6 items 1, 4, 7, W0), `src/config/**`, `src/cli/args.ts`, `src/cli/main.tsx`, `src/cli/login.ts`, `src/cli/tui-prompter.ts`, **`src/cli/session.ts`**, `src/cli/config-table.ts`, `src/tui/onboarding/**` (incl. `Wizard.tsx`), `src/chat/facts.ts`, `src/chat/replies.ts`, `.env.example`, `package.json` (description only), `test/unit/config/**`, `test/unit/cli/**` **except** `test/unit/cli/epilogue.test.ts` (S5), `test/unit/tui/onboarding/**`, `test/unit/tui/wizard.test.tsx`, `test/unit/chat/**`, `test/live/**` | §1, §2.2 D-R (`launch.ts`), §4.4 rows marked "S3 lands" |
| **S4 commands + palette + audit fixes** | `src/tui/commands/**` (`local.ts` new), `src/tui/composer/submit.ts`, `src/tui/pane/commands.ts`, `src/tui/keys/**`, `src/tui/why.ts`, `src/tui/plain-composer.ts`, `src/tui/Overlay.tsx`, `scripts/gen-docs.mjs`, generated `docs/COMMANDS.md`, `docs/KEYS.md`, `man/jevcode.1`, `completions/*`, `test/unit/tui/commands/**`, `test/unit/tui/{submit,plain-composer,why,round2-overlay,keys}*.test.ts*`, `test/unit/tui/pane/commands.test.ts` (new), `test/unit/tui/round3-commands-app.test.tsx` (new) | §4, §5.2 A9 |
| **S5 message polish + pty/perf/docs** | `src/tui/Transcript.tsx`, `src/tui/transcript/wrap.ts` (new), **`src/tui/Console.tsx`**, `src/tui/StatusLine.tsx`, `src/tui/Review.tsx`, `src/tui/toasts.ts`, `src/tui/status/lines.ts`, `src/tui/plain.ts`, `src/tui/budget/lines.ts`, `src/cli/epilogue.ts`, `src/tui/composer/Composer.tsx`, `src/tui/console-lines.ts`, `test/unit/tui/{round2-transcript,transcript,round2-console,console,review,toasts}.test.ts*`, `test/unit/tui/status/**`, `test/unit/tui/plain*.test.ts`, `test/unit/tui/budget/**`, `test/unit/cli/epilogue.test.ts`, `test/unit/tui/round3-polish-app.test.tsx` (new), **`test/pty/**`**, **`src/perf/**`**, **`test/unit/perf/**`** (eight existing files + `idle-frames.test.ts`; unowned in the first draft although §9 changes `render-lag.ts` / `main.ts`), `perf/**`, `scripts/pty/polish-check.mjs` (new), `README.md`, `docs/TUI.md`, `docs/STATUS.md`, `CHANGELOG.md`, `docs/DECISIONS.md`, `docs/TUI-DESIGN-2.md` (pointer lines only), `docs/live/tui/round-3/**` | §5, §8, §9, §10, §11 |

Test rule: a slot that needs an App-level test writes it in **its own** `round3-<slot>-app.test.tsx` over the shared harness
(`test/unit/tui/app-harness.tsx` exports `mountApp`, `fakeHost`, `goLive`, `dynamicLines`, `waitFor`; read-only this round) — never in
`app.test.tsx` / `round2-app.test.tsx` (S2's).

### 7.2 Shared files: the owner, and every change another slot needs (land in the wave shown)

| File | Owner | For | Change (verbatim in the section named) | Wave |
| --- | --- | --- | --- | --- |
| `src/core/types.ts` | S3 | S4 (item 1), S2 (items 4 and 7 consumer), S5 (none) | §6 items 1, 4, 7 (items 2–3 are `session.ts`'s, item 6 `defaults.ts`'s) | W0 |
| `src/config/defaults.ts` | S3 | S5 (`modeBadgeWord` import), S4 (`/mode` hints, gen-docs), S1 (nothing — the theme names no mode) | `DEFAULT_MODE: EngineMode`, `MODE_BADGE_WORD`, `MODE_BADGE_MAX_CELLS` | W0 |
| `src/tui/status/lines.ts` | S5 | S3 (`modeBadgeWord` reads the table; `ModeBadge = string`), S2 (`leftWord` idle for `starting && !thinking`, P7) | §1.1 row; §5.2 P7 | W1 (the badge row first) |
| `src/tui/App.tsx` | S2 | S1 (`:2030,2039,2058` `depth`), S3 (`:560 DEFAULT_MODE`), S4 (`runCommand`: theme forward F5, decisions/plan deletion F6, copy diff F7, why fall-through F8, `bindings` ref F10, complete → `completeDraft` §4.3, thinking commands F14, `keepDraft` F21, `dispatchCtxOf` F20, `openPalette` recent §4.1 rule 6; **`:1609–1613` the ghost accept reads `ghost.arrow` as `/${owner} ` beside `ghost.rest` (§4.1 rule 3 — a type error otherwise)**; **`:1064–1073` the pre-router keeps calling `parsePanelCommand`, now alias- and case-aware (F3)**), S5 (`send()` dispatches `thinking` with `run:starting`, P7); S2's own: `:988` untouched (`wordmark` is optional) | §2.6, §1.1, §4.1, §4.3–4.4, §5.2 P7 | W2 (S2's own), W3 (the others, one PR) |
| `src/tui/useEngine.tsx` | S2 | S5 (`run:end` clears `loop`/`loopFold`, §5.1 rule 12), S3 (`:366 DEFAULT_MODE`) | §5.1 rule 12; §1.1 | W2 |
| `src/tui/Console.tsx` | S5 | S1 (`:142` prompt `accent` at rest), S2 (`edgeRole?` prop for A6), S3 (`:128` `fieldRow = isFieldStep(step) && !sr`; **`:29–34` delete the duplicate `wizardConsoleTitle` map and re-export `onboarding/lines.ts`'s, which knows `key` / `options`** — else F-R8 reads `╭─ setup ─`), S4 (ghost arrow rendering `:150–151`: `ghost.arrow ? \` ${g.arrow} ${ghost.arrow}\` : …`) | §2.6, §5.2 A6, §1.4.2–1.4.3, §4.1 rule 3 | W3 |
| `src/tui/composer/Composer.tsx` | S5 | S1 (`:620` prompt at rest), S4 (ghost arrow, flat tier) | §2.6, §4.1 rule 3 | W3 |
| `src/tui/Transcript.tsx` | S5 | S1 (`labelRole`) | §2.6 / §5.1 | W2 |
| `src/cli/session.ts` | S3 | S4 (`execute()`: F1 echo + ` (default)`, F3 panel/transcript cases + `assertNever`, F6 intake rows, F7 copy diff host case, F8 `whyErrorText`, F9 one help formatter, F10 `renderer.setBindings` at `:3465` and `:2680`, F12, F13, F15, F16, F17 `trust unchanged`, F18 `ack-errors`), S5 (`:2479` `block('cost', …)`, `:2526–2530` `/jev` row 3); S3's own: `meterVerify` beside `meterChat` (§1.5), the guarded `applyConfig` (§1.2), `defaultModeItem` (§1.7), the `persist` branch of `runLogin` (§1.4.3) | §4.4, §5.1 rules 5–6, §1.5 | W3 (one PR) |
| `src/tui/onboarding/lines.ts` | S3 | S5 (`sandboxText` §5.1 rule 13), S4 (F19 login title) | §5.1 rule 13; §4.4 F19 | W1 |
| `src/tui/commands/registry.ts` | S4 | S3 (`/mode` value hints read `MODE_BADGE_WORD`; the `mode` row's semantics stop naming a default), S2 (none) | §1.1, §4.1 rule 8 | W1 |
| `src/tui/glyphs.ts`, `src/tui/spinner.ts` | S2 | S5 (`spinnerStatic` `◆`, the shade-pulse frames the status spans colour) | §5.2 A3 | W1 |
| `src/tui/Overlay.tsx` | S4 | S5 (`OverlayData.review.armed` passed to `Review`), S1 (`accent2` marker) | §5.2 A8–A9 | W3 |
| `src/tui/pane/banner.ts` | S2 | S5 (the ` · ` banner copy, §5.1 rule 12) | §5.1 rule 12 | W1 |
| `src/tui/pane/commands.ts` | S4 | S2 (the App's pre-router keeps calling `parsePanelCommand`; only its resolution changes — aliases and case through `findCommand`) | §4.4 F3 | W1 |
| `src/tui/onboarding/Wizard.tsx` | S3 | S5 (none — `:305` `fieldRow` reads `isFieldStep`, S3's own, so the flat-tier masked row and the boxed one cannot drift) | §1.4.3 | W2 |
| `test/pty/**`, `src/perf/**`, `test/unit/perf/**` | S5 | S2 (the §3 `.steps` rewrites and the `idle-frames` probe), S3 (the §1.10 re-pin), S4 (`commands-*.steps`, `--keybindings`, `trust-esc`), S1 (`theme-pink.steps`, `echoStep` SGR gap) | §8, §9 | W4 |
| `docs/**`, `README.md`, `CHANGELOG.md` | S5 | every slot (the §1.10 doc list, §2.6 doc row, §3 TUI.md sentences, §4 COMMANDS/KEYS regen by S4) | §10, §11 | W4 |

`src/synth/**`, `src/bench/**`, `src/loop/**`, `src/jev/**`, `src/session/**` are read-only this round.

### 7.3 Waves

**W0** (S3, half a day): `types.ts` items 1, 4, 7 and `session.ts` items 2–3, `defaults.ts` table, `ui.wordmark` schema row, `launch.ts` `themeHint` / `ssh`; the fakes compile; `tsc --strict` green. **W1**
(parallel, pure, offline): S1 `theme.ts` + tests; S2 `wordmark.ts`, `splash.ts`, `motion.ts`, `layout.ts`, `glyphs.ts`, `spinner.ts`,
`banner.ts`; S3 `reducer.ts`, `lines.ts`, `login.ts`, `resolve.ts`, `launch.ts`, `facts.ts`, `replies.ts`, `args.ts`; S4 `registry.ts`,
`palette.ts`, `dispatch.ts`, `fuzzy.ts` (unchanged), `local.ts`, `why.ts`, `gen-docs.mjs`, `keys/bindings.ts`; S5 `status/lines.ts`
(`modeBadgeWord` first, then `statusSpans`), `transcript/wrap.ts`, `plain.ts` (nothing this round beyond tests), `budget/lines.ts`,
`epilogue.ts`, `toasts.ts`. **W2**: S2 `App.tsx` / `useEngine.tsx` / `Pane.tsx` wiring (the mark, the loop, A5/A6, P7's dispatch, the
`DEFAULT_MODE` and `depth` lines); S3 `session.ts` §1 (the guarded `applyConfig`, `runLogin` with the `persist` branch, `verifyKeys` wrapper + `meterVerify`, plain wizard, `chatFailure`, `capsItem`, `defaultModeItem`),
`tui-prompter.ts`, `Wizard.tsx`; S5 `Transcript.tsx`, `StatusLine.tsx`, `Review.tsx`, `Console.tsx` (own changes: spans, gutter). **W3**: S2
lands the App.tsx requests of S1/S3/S4/S5 in one PR; S3 lands the `execute()` block of S4 and S5's session rows; S5 lands the
Console/Composer requests of S1/S2/S3/S4; S4 `Overlay.tsx`, `submit.ts` wiring, `plain-composer.ts`. **W4**: S5 pty + perf + docs +
`polish-check.mjs`; the flip PR (§1.10 commit 2: S3's one line + S5's re-pin + S4's regen); live captures into
`docs/live/tui/round-3/` on both providers (paid, once). No paid call in any unit or pty test.

---

## 8. Tests per slot (vitest `unit` offline; pty `--mock` hermetic; perf under a real pty; live paid once)

**S1 theme.** `theme-palette.test.ts` (new): (1) for each theme × role × depth ∈ {16, 256, 24} `textProps` equals an inline golden table;
(2) WCAG contrast (a 12-line luminance function): every `dark` truecolor ≥ 4.5 on `#1e1e1e` for {error, warn, ok, block, review, steer,
secret, accent, chosen, assistant, badge, code} and ≥ 3.0 for {you, borderFocus, accent2, sweep}; every `light` truecolor the same on
`#fefefe`; every `daltonized` override on `#1e1e1e` — this test fails HEAD's light theme (2.74 / 1.73); (3) twins identity: every `ansi256` is
within RGB distance ≤ 48 of its truecolor's cube/grey cell (fails HEAD's `ok` 114, passes 78); two roles with different truecolors never
share an `ansi256` inside a theme (the 125 collision); every pink role's `ansi16 ∈ {magenta, magentaBright}`; `THEMES.ansi` equals `dark` with
deep members stripped; (4) `itemRole('[you]') === null` and `itemRole` of a `[ui]` note is null (§5.1 rule 2), `labelRole` for the three label classes; (5) `src/tui/theme.ts` names no mode word.
`theme.test.ts:62–66,89,91,94–111,130–133,154` re-pinned to §2.1/§2.2.

**S2 wordmark + animations.** `wordmark.test.ts` (new): `loopBand(k)` equals §3.4 for k = 0…16 and is `null` outside; every frame ≤ 8
changed cells per row vs the previous and ≤ 40 in total; `wordmarkFrame` rows are exactly 5, each ≤ `columns` cells, letters never change
between frames (colour only); caption iff `captionFits(columns, caption)` at grid span `[58, 58 + cellWidth(caption))` (73 for `◆ 0.3.0`, 85 for `◆ 0.10.0-rc.1`),
never inside a band span, `◆` span `accent2`; tagline iff `≥ 104`; `--ascii` twin pure ASCII (`* 0.3.0`); `wordmarkWanted` truth table (1,000 random inputs, §3.1 predicate). `splash.test.ts`: phases
`reveal < 450 · shimmer < 550 · held`; rows at t = 700 and 10,000 equal the resting frame **with the caption** (`splashFrame(…, version)` equals
`wordmarkFrame(…).rows` with `spans(null)` cell for cell, so `splash:done` writes nothing); frame 0 cell-unchanged (H-A1 fixtures); no `fade`; ≤ 12
changed cells per 50 ms tick still holds. `layout.test.ts`: `paneWhole` ⇒ `pane ∈ {0, want}`; `total ≤ budget`; §3.7's rows; ≤ 5 µs.
`motion.test.tsx` (new, real Ink renderer on a stub stdout and a fake clock, the `key-immediate-render.test.tsx` pattern): `useIdleLoop` starts in
`rest` when activated and writes no band before `LOOP_REST_MS`; a pass writes 16 frames (k = 1..16) and the rest none (a 20 ms interval override
through `intervalMs`); **a key at t = 1.2 s into a pass leaves `band` non-null for k = 5..16 and no pass starts within 3 s of it**; `band` is `null`
in the rest render where `frame` is already 1 (the wake glitch); inactive under reduced motion / depth 0 / hidden / `splashRunning` / `asleep`;
`attentionAt` tiers; subscriber count returns to 0 when hidden (observed through frame counts); a key commit 5 ms after an animation frame
paints synchronously (re-asserting R2 §0.3). `round2-reducer.test.ts`: `lastActivityAt` set by `key`, `run:end`, `panel`, `resize` and **not** by
`thinking → null` / `chat-decisions` (a reply calms, §3.6); `postRunKeySeen` false at `run:end`, true at the next `key`; `run:end` → `loop === null`; the `splash` cancel rows unchanged. `spinner.test.ts:18–45`: frames
`░▒▓█▓▒`, static `◆`, ASCII twin; the §14.2 source scan unchanged. `glyphs.test.ts:31–32` re-pinned. `app.test.tsx:42–61` (H-A3): after
`splash:done` 11 dynamic rows, plain rule, `WORDMARK[4]` + `◆ <version>` on the last mark row. `round2-app.test.tsx:171–200`: the rule row is
the plain rule while the mark shows; the brand row at `run:start` (mark hidden) until `run:ready` — the "never flickers to the strip"
assertion stays; `:243–270`: `dyn` length 11 after Esc (the mark returns). `frames2.test.ts:106–131`: H-A3/B2/C1/G1/H2/I1 rule = `plainRule`
for the boxed idle frames (H-J1/J2 flat keep `brandRow`); F-W1/F-W1w/F-W3/F-W5/F-W8/F-W9 added and rebuilt from the twins — **dynamic rows only** (their captions carry no scrollback clause). New
`round3-wordmark-app.test.tsx` (S2's own): A5 sweep ≤ 6 frames with unchanged row count (fake clock); A6 three frames; A4 caret on while `frame % 8 < 4` (1 Hz);
P7's dispatch (after Enter no frame has `Type to steer` / `│ starting`).

**S3 defaults + onboarding.** §1.1 tests (`defaults.test.ts`, `no-default-literal.test.ts`); §1.2 (`session.test.ts` env/file mode →
`baseMode`, badge dispatch; `launch.test.ts` llm-jev); §1.4 (`reducer.test.ts`: `key` / `options` flows, Esc, digits 1–4, rows ≤ 3, found
titles, reuse; `lines.test.ts`: every string, `--ascii` twins, SR rows (three `options` rows), every row of every step `≤ consoleInnerWidth(80)` = 76 at 80 columns, the wide `options` form `≤ consoleInnerWidth(120)` at 120 and the narrow form chosen at 100, `oneKeyHintRow`'s narrow twin; `wizard.test.tsx`: host round trips, double-paste hint,
verify cancel; `tui-prompter.test.ts`: `patchFromWizard` per `keyAs` (four keys from one field; generator-only beside a TypeSafe or Jev key — the file never gains `jevProvider`; Jev-only beside an Anthropic key — never `apiKey`), `reuseJevForGenerator`, `found` / `foundSource` passed, `verify` wired; `resolve.test.ts`: a wizard-written file under `TYPESAFE_API_KEY` keeps `decider.provider typesafe (auto:typesafe-key)`;
`plain-prompter.test.ts`: new `wizard` cases one key / `[t]` / `[j]`, `jevProvider` written on the one-key path only); §1.5 (`login.test.ts` per status, exit
codes, `--key-stdin` one line / two lines / too short / TTY prompt, `--status` third line); §1.6 (`lines.test.ts:99–105` fix-block shapes per
mode/provider, no key-looking token, every line ≤ 76 cells; `session.test.ts` pipe exit 2 lines); §1.7 (`capsItem` three modes + `none`; `defaultModeItem` present on a keyed start without a file `mode`, absent with one and under `--mock`;
`session-chat.test.ts` 402 → bubble, no wizard); §1.8 every "unit" row (rows 34–40 included: option `3` → `mode` row written → a restart with the same file opens no wizard; `launch.test.ts` `COLORFGBG`, D-R); §1.9 (`facts.test.ts`, no "Claude" in mode items or facts);
the §4.4 rows marked S3 (`session.test.ts:126–150,500–518,528,541–549,563,565,1091–1098`; F17 `wizard.test.tsx`). The §1.10 re-pin in
commit 2. **Live:** `test/live/verify.live.test.ts` (new; one row per provider; skipped without the key).

**S4 commands.** `registry.test.ts`: aliases ∪ names unique; every alias matches `NAME_RE`; popular aliases ≤ 2 characters; for every
alias `paletteMatches('/'+alias)[0].spec.name === owner`; `paletteGhost` arrow for a non-prefix alias; `isExactCommand`; `routeSubmit({ text:
'/'+alias, overlay: 'palette' })` runs the owner; `EXPECTED` aliases (`:85`); every `CommandAction['kind']` has a `case` in `App.tsx`
`runCommand` or `session.ts` `execute()` (source scan) and a test that drives it (G1–G5); `gen-docs --check`. `palette.test.ts`: groups
order (Suggested → recent → Popular → rest), alias column hidden < 50 columns and showing the shortest alias, F-P1/F-P2/F-P3 **palette rows** read
back from this document (`frameFKRows` pattern; every command row of a frame has one width), `helpLines` prints aliases and `live` tags,
`HELP_NOTES` gains the daltonized and light-terminal notes. `test/unit/tui/pane/commands.test.ts` (new, S4): `parsePanelCommand` resolves `/p d`, `/Panel full`, `/tr compact`. `dispatch.test.ts:152–160,219`: `keepDraft`
per error class; `argumentCandidates` consumed; F15 `optional`. `submit.test.ts:32,40`: `allowCommandsWhileSubmitting`; alias exact run.
`why.test.ts`: `whyErrorText`. `plain-composer.test.ts:304`: `/panel` prints rows, `/transcript` answers `always full`. `round2-overlay.test.tsx`:
`accent2` marker SGR. `keys/bindings.test.ts`: six unbound actions, `docs/KEYS.md` regenerated. `round3-commands-app.test.tsx` (new): Tab
argument completion cases (§4.3); `/p d` twice → open then collapsed, `/Panel full` → full (F3); `/theme light` forwarded and surviving `setUi`; `/copy diff` asks the host (G2); commands while thinking
(`/status` answers, `/new` toasts `one moment — still thinking`, `/exit` cancels and exits); `keepDraft` (`/budgett` keeps, `/undo` live
clears); `bindings` from a temp `keybindings.json` mapping `global:help` to `none` → `?` inserts text, `/help reload` swaps live; `/errors`
clears `!n`; `dispatchCtxOf` prefers the host's context.

**S5 polish + pty + perf + docs.** Unit: `round2-transcript.test.tsx` → the §5.3 normaliser; bodies at column 10 for every label; detail rows
indented and hanging under `label  value`; spacer above `[ui]` with detail; label roles; `transcript/wrap.test.ts` (new): the F4/F5 table
(the F-R4 step row breaking at `… · risk 0.00 ok` / `· tests 4p/3f/0e …` and re-joining to `formatTranscriptItem` under the §5.3 normaliser,
`[run] end … exit 4`, `[run] warn: stop: …`), no continuation row shorter than 4 cells over 1,000 random `StepRecord`s
(fast-check style like `buffer.property.test.ts`), `--ascii` separator; `status/lines.test.ts`: `statusSpans` positions and roles (spinner,
done word, meter words, secret, toast), `leftWord` idle for `starting && !thinking`, `centreText` never the run id, drop order unchanged;
`toasts.test.ts`: `toastPhase`; `round2-console.test.tsx` / `console.test.ts`: edge roles idle / live / `edgeRole` override; prompt `accent` at
rest, `steer` live; `fieldRow` for `key`; `wizardConsoleTitle` `setup · key` / `setup · options` at 80 columns; the badge `llm+jev · verified · next run` at 60/80/120 columns; `review.test.tsx`: unarmed dim →
armed bold; `budget` tests `~$0.000006 each`; `epilogue.test.ts` unchanged; `plain.test.ts` unchanged (D-M); `round3-polish-app.test.tsx`
(new): P7 first frame after Enter; the gutter in a mounted App; the identity normaliser over a mocked run at 80 columns.
**pty** (`test/pty/smoke/*.steps` + `round2.pty.test.ts` + new `round3.pty.test.ts`): `splash.steps`/`splash-wide.steps` (wordmark cells > 0
before **and after** the key; no `▓▒░` after the echo frame; idle frame 11 rows; 0 clears); `splash-settle.steps` (`expect ◆ \d+\.\d+\.\d+`;
≤ 15 wordmark frames before the caption frame; every frame after it carries the mark; 0 frames in the 5 s after the settle); new
`wordmark-idle.steps` (24×80 and 40×120; settle; sleep 12: exactly one pass, 14–18 frames in [6 s, 11 s] after the settle, ≤ 4 per 1-s bucket,
each ≤ 3 KB, band cells only in `sweep` SGR, letters unchanged, 0 clears, region 11 rows), `wordmark-key-during-pass.steps` (sleep 7.0; `send
h`; echo within the **50 ms max bound** — a key landing while a sweep frame renders waits out that ≈ 11 ms render before its own ≈ 5 ms frame
(R2 §0.2), so a single-sample 16 ms gate would be flaky by the design's own numbers; the 16 ms p95 gate stays in `composer-latency`'s `idle-loop`
series over 200 keys; the pass finishes — band frames continue; no new pass within 3 s), `wordmark-handoff.steps` (`fix the failing test\r` → no
wordmark frame between `[run] start` and `end`; the `end` frame itself (the epilogue item and the state change commit together) has the strip **and** the mark; `/panel\r` → mark gone; `/panel off\r`
→ back), `wordmark-reduced.steps` (replaces `splash-reduced`: frame 0 carries the complete mark and no `▓▒░`; 0 wordmark frames after; 11
rows), `wordmark-21.steps` (21×80: the mark shows and neither the palette nor a 6-row draft hides it; 20×80: the brand row, no mark, today's frames; 22×80 after a mock run: no mark until the first key, then F-W5), `wordmark-nocolor.steps`
(`--no-color`: 0 idle frames; the reveal still ran), `chrome-tiers.steps` (no wordmark at 12×60, back at 24×80, clears ≤ 1 in the shrink);
`theme-pink.steps` (`TERM=xterm-256color`: the first frame contains `38;5;211` and no `38;5;117`; after `run:start` `38;5;169` and no
`38;5;74`; `--theme light` → `38;5;125`; `--theme ansi` → `ESC[95m` and no `38;5;`; `NO_COLOR=1` → no `38;`); `polish.steps` at 24×80 and 40×120
through `chat-task`'s path with `scripts/pty/polish-check.mjs` evaluating V1–V21 (§9); the §1.8 pty rows (`r3-*.steps`, `ts-only-start.steps`,
`zero-arg-wizard` re-pinned, `r3-plain-wizard`, `r3-wizard-sr`, `r3-pipe-nokeys`); the §4.4 rows (`commands-{idle,live,thinking}.steps`,
`--keybindings`, `trust-esc` exit 0); twins: `chat-hi` under `--ascii`, `--no-color`, `--no-animation`, `--screen-reader`, and
`chat-ambiguous-flat` at 12×60 pass V6–V13 and V16–V18; every scenario keeps 0 clears, one `RESTORE`, no key bytes (`assertNoKeyBytes`),
`echoStep` with `SGR_GAP`. **perf:** §9. **Live** (paid, once per provider, into `docs/live/tui/round-3/`): `run-live.sh` for `auto-24x80`
and `auto-40x120` on the new bundle; `polish-check.mjs` over the captures; the README table (first frame, settle, `hi` → `[jevcode]`, task →
`[run] start`, clears, key bytes = none, idle fps).

---

## 9. Gates (every existing gate, plus the idle-animation gate and the hero-frame checklist)

| Gate | Threshold | Kept by | Evidence |
| --- | --- | --- | --- |
| first frame; splash frame 0 **is** the first frame | cold p95 < 300 ms at 40×120 / 24×80 / 8×40; zero network; `wordmarkCells > 0` at ≥ 16×64 (the reveal runs at 16–20 rows too; only the *held* mark needs 21) | frame 0 cell-identical; `DEFAULT_MODE`/`MODE_BADGE_WORD` constants; `resolveConfig` after `firstFrame()` | `perf/first-frame.ts:79–90`; `splash.steps`; `JEVCODE_ASSERT_NO_NETWORK` |
| zero clears after the first frame outside shrink segments | 0 | the pane is whole or absent (≤ budget); hand-offs are height changes inside the budget; wizard rows ≤ 3; palette ≤ 8 | `render-lag.ts` `CLEAR_RE`; `states.ts` (+ `wizard` at 24×80 shows the mark); every `.steps` |
| lag p95 net < 5 ms | at `JEVCODE_MOCK_STEP_MS=200` | the mark is hidden while live (no idle frames during a run) | `render-lag.ts` rows 40/12/reduced |
| composer keystroke → frame | p95 < 16 ms, max < 50 ms — idle / live / palette / review, **and the new `idle-loop` series** (200 keys at 100 ms starting 200 ms into the first pass; the typist waits 6.65 s after the first frame) | D-F immediate path; the log throttle's 0 ms wait; the prompt's SGR precedes the body (`composerEndsWithKey` unchanged) | `composer-latency.ts` |
| dynamic fps during a run | ≤ maxFps + 1 in every 1-s bucket; **plus a `run-start` bucket** (A5's ≤ 6 frames + the spinner's 8 + the live flush ≤ 31) | the mark never draws while live; A5 is 6 frames | `render-lag.ts` gains `runStartFrames` beside the splash bucket |
| splash bucket | ≤ 22 `dynamic` frames within 700 ms of the first frame | 15 reveal frames; the first pass at 6.45 s | `render-lag.ts:57–66` |
| **idle animation** (new probe `idle-frames`, `src/perf/idle-frames.ts`, `ProbeName` at `main.ts:46–47`) | `dynamic` frames ≤ 4 in any 1-s bucket and mean ≤ 2/s over [1 s, 31 s] after the settle; bytes ≤ 12 KB/s busiest second and ≤ 5 KB/s mean; 0 clears; region ≤ rows − 2; child CPU delta (`ps -o time`) **reported** | `LOOP_INTERVAL_MS = 250`, 16 frames per 10 s, decay | `chat --mock` at 24×80 and 40×120, 31 s idle, typist with no keys; one README row, one `latest.json` block; `test/unit/perf/idle-frames.test.ts` (bucketing and gate arithmetic on synthetic captures) |
| line identity | `transcript.log` / `--plain` / TUI | the §5.3 normaliser (text unchanged for every engine item, D-M); local items changed in their one formatter | `round2-transcript.test.tsx`, `round3-polish-app.test.tsx`, `twins.pty.test.ts:96`, `plain.test.ts` |
| no new runtime dependency | `dependencies` = `ink` + `react` | — | `pack:check` |
| keys never in logs or frames | — | masked rows, `assertNoKeyBytes`, `redact` on `/copy`, the verify request body carries no workspace text | onboarding tests; `round2.pty.test.ts:763–781`; `r3-wizard-masked-key` |
| review invariants | only `y` approves; Enter inert; no default | A8 is drawing only | `app.test.tsx:342–461`; `review-y/d.steps` |
| intake reply wall time | p95 < 1.5 s live, ≤ 40 ms mock; `thinking seen` 20/20 (P7) | one request | `intake-latency.ts` |
| rows − 2 at every geometry | `total ≤ budget` | `computeLayout` 1.2 invariants | `layout.test.ts`; `height.test.tsx` at 12/16/21/24/40 (21 = `WORDMARK_MIN_ROWS`, the palette at exactly the budget) |
| harness overhead | unchanged gate | untouched this round | `step-overhead.ts` |
| **hero-frame checklist** (`scripts/pty/polish-check.mjs` over a `.txt`/`.cap` pair; run on `polish.steps` and the live captures; V1–V21 below) | every V passes on both geometries and the twins | — | S5, W4 |

**The hero-frame checklist (predicates over a capture; the integrator ticks them from the artefact, not a screenshot).** `polish-check.mjs`
reads the `.cap` frame grammar, not the `.txt` alone: for every frame the rows above the rule row (the first row matching `^─{3,}`, or the plain
rule of `columns` `─`) are **scrollback**, the rule row and below are the **dynamic region**; a wordmark row is one with ≥ 12 leading spaces
followed by `██` (`##` under `--ascii`); a wrapped `<Static>` row (Ink wraps a `[config]` row wider than the terminal) is a row whose
predecessor is a labelled row of exactly `columns` cells. Predicates over scrollback skip wordmark rows and the first visible row (the capture's
top edge may cut a block). V1 the settled idle frame has ≥ 5 rows containing `██`, the caption `◆ <version>` (when `captionFits`), the `›`
prompt with `Say hi, ask a question, or describe a task…`, and 11 dynamic rows; V2 wordmark cells > 0 in the settled frame and in every idle
frame until the first `[run] start`; V3 distinct SGR foregrounds in a whole session ≤ 7 (pink, magenta, pale pink, grey/white, red, amber,
green) plus dim/bold; V4 ≤ 3 colours per row (dim/bold not counted); V5 no `[block]`/`[review]`/`error` token inside a pink span; V6 no row
wider than the terminal; V7 no scrollback continuation row (≥ 10 leading spaces, not a wordmark row) whose trimmed text is < 4 cells or matches
`^[\d)\]·]+$`; V8 every scrollback row is blank, or a label row with `]` at index 8, or `[step \d{3,}]` (steps ≥ 100 push the body, §5.1 rule
1), or a continuation/detail row starting with ≥ 10 spaces, or a wrapped `<Static>` row as defined above; V9 every non-ASCII code point is in
`GlyphSet`, the wordmark cells or the prose set `— – … ’ “ ” ×`; V10 a blank row precedes every `[you]`, the first `[jevcode]` of a turn, `[run]
start`, `[run] end`, and a `[ui]` head with detail — the first visible row excepted; V11 no `e-` scientific notation, every `$` figure matches
`\$\d+\.\d{2,4}`, durations match `\d+(\.\d)?s|\d+m\d{2}s|\d+h\d{2}m`; V12 a run id (`\d{8}-\d{6}-[a-z0-9]{8}`) never appears in a status row;
V13 (deferred with D-M); V14 the coloured span on the console status row covers ≤ 30 % of the inner width; V15 **when a spinner glyph leads the
status row**, the SGR before it is the accent (idle/done rows have no glyph and are exempt); V16 no frame contains both `starting` and `Type to
steer`; V17 no `loop ·` **banner row in the dynamic region** after `[run] end` (the scrollback's `loop tripped: <sig> xN` step item, `plain.ts:346`,
and any `[run] warn: … loop …` line are engine text and stay); V18 every row following a `[ui]` head until the next label starts with ≥ 10
spaces; V19 `hi` → `[jevcode]` **p95 ≤ 1.5 s over the capture's intakes** (the §9 gate; the median goes into the README table — the first
draft's single-sample 300 ms bound left 35–60 ms of headroom over the 240–265 ms round-2 numbers and would fail on ordinary jitter; 300 ms stays
the **mock-path** bound); V20 ≤ 15 wordmark frames in the first 700 ms, ≤ 6 sweep frames per run start, idle fps ≤ 4 peak, `dynamic` ≤ maxFps + 1
live, 0 clears outside shrink segments; V21 the same capture under `--ascii`, `--no-color`, `--no-animation`, `--screen-reader` and at 12×60
passes V6–V12 and V16–V18.

---

## 10. Glossary (every user-visible string this round adds or changes, once; `--ascii` substitutes per TD §14.1)

**Badges and modes.** `MODE_BADGE_WORD`: `jev-only` · `jev+llm` · `llm-only` · `llm+jev · verified` · suffix ` · next run` · `/mode` no-arg
`mode <badge>[ (default)]` when nothing differs, else `mode <cur badge> — next run: <next badge>[ (default)]` (` (default)` after the badge
equal to `MODE_BADGE_WORD[DEFAULT_MODE]`, F1) · `mode <badge> already` · `mode stays
<badge> — no generator key was saved`.

**Mode items (`MODE_SET_ITEM`, `session.ts`).** `jev-on` → `mode jev+llm from the next run — the code model writes the code, Jev still decides
every step (persist: jevcode config set mode jev-on)` · `jev-only` → `mode jev-only from the next run — no generating LLM; code proposes, Jev
decides, tests verify (persist: jevcode config set mode jev-only)` · `jev-off` → `mode llm-only from the next run — the generator alone, no Jev (bench condition; reviews still ask)` ·
`llm-jev` → `mode llm+jev · verified from the next run — the code model writes candidate patches, tests verify them, Jev arbitrates (persist:
jevcode config set mode llm-jev)`.

**Facts (`facts.ts`).** `MODE_SENTENCE` (§1.9) · `WHAT_IT_IS_TEXT` ending `… in jev+llm mode the code model writes the code.` ·
`HOW_TO_TASK_SUFFIX['jev-on']` ` The code model writes the code, Jev decides each step.` · `SWITCH_MODE_TEXT` `Switch with /mode jev-only (Jev
alone, $0.25 run cap) or /mode jev-on (alias /llm on); it applies to the next run. Persist it with jevcode config set mode <m>.`

**Wizard (`onboarding/lines.ts`; every console row ≤ 76 cells).** `OpenRouter API key — one key runs Jev and the code model` · `Paste, then
Enter · Esc: other ways to start · Ctrl-C quits (shows setup)` · `<n> chars · Enter saves · Ctrl-U clears · Esc clears (again: other ways)` · `not
an OpenRouter key? Enter again keeps it · TypeSafe key: Esc, then 2` · `TypeSafe key found — Jev runs there. Code model: paste an OpenRouter key`
· `Paste it and press Enter · Esc: other ways (Jev only, Anthropic)` · `Jev key found (JEV_API_KEY) — code model: paste an OpenRouter key`
(`(config file)` / `(dotenv)`) · `Enter = save the JEV_API_KEY value as the code-model key (config file)` · `Enter = reuse the saved Jev key for the
code model too` · `Anthropic key found — it writes the code. Jev needs an OpenRouter key:` · `Paste it and press Enter (Jev only) · TypeSafe key for
Jev? Esc, then 2` · `looks like the key was pasted twice — Ctrl-U clears` · `Other ways to start:` · `Other ways to start — Enter confirms <n>:` ·
wide `  1 OpenRouter for both (default)   2 TypeSafe for Jev   3 Jev only, no LLM   4 Anthropic for code` · narrow `  1 OpenRouter   2 TypeSafe
3 Jev only   4 Anthropic` (`▌` before the highlighted digit) · `pick 1–4 · Esc back` · `pick 1–4` · `1: one key runs Jev and the code model
(default) · Enter confirms` · `2: TypeSafe key for Jev, OpenRouter key for the code model · Enter confirms` · `3: no LLM — code proposes, Jev
decides, tests verify · caps $0.25 / $1.25` · `4: Anthropic writes the code (~20× GLM's price) · Jev: OpenRouter/TypeSafe` · `Verify now? [y] one
Jev decision + 1 code-model token (< $0.0001)  [n] skip` · `decision ~$0.00002 · completion ~$0.000002 · key info $0 · Enter/Esc skip` ·
`api.typesafe.ai decision ~$0.00002 · completion ~$0.000002 · key info $0` · `OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip (stay
Jev-only)` · console titles `setup · key` · `setup · options` · `Keys are never shown or logged · Esc back · Ctrl-C keeps <badge>` · login
re-entry title `Where do you reach Jev?` · SR `Enter saves; Escape clears, then Escape again for other options` · SR options `Other ways to
start:` / `1. OpenRouter key for both  2. TypeSafe key for Jev  3. Jev only, no LLM` / `4. Anthropic key for the code model · Enter selection
(1-4):` · plain / login `other ways: [t] TypeSafe Jev · [j] Jev only · [a] Anthropic · Enter continues: `.

**Setup items.** `mode jev+llm (default) — caps $2.00 per run · $10.00 per session; /mode jev-only runs on Jev alone at $0.25 / $1.25; jevcode
config set mode <m> keeps a choice` (D-Q) · `mode jev-only saved to <path> — jevcode config set mode <m> changes it` · `generator key: reused from
JEV_API_KEY (sha256:…) source=env→file` · `panel: handled by the TUI` (warn) · `spend caps: $2.00 per run · $10.00 per session (jev+llm) — /budget changes them; /mode jev-only runs on Jev alone at $0.25 /
$1.25` (`none (uncapped)` for a lifted session cap) · `verified: jev ok (<model>, <n> input tokens, $<usd>)` · `verified: <model> ok (1 token,
$<usd>)` · `verified: openrouter key ok (label "<l>", limit remaining $x)` (kept) · `verification failed: openrouter HTTP 401 — the key was
kept; fix it with /login` (kept) · `verification: no credits left on this OpenRouter key (HTTP 402) — add credits at openrouter.ai/credits; the
key was kept` · `verification: OpenRouter is rate-limiting this key (HTTP 429) — try again in <n>s; the key was kept` · `verification: the code
model "<m>" is not served by openrouter.ai (HTTP 404) — pass --model, or jevcode config set generator.model <id>; the key was kept` · `(mock
session: verification uses the network)` · `decider.apiKey: env TYPESAFE_API_KEY wins over the saved key (typesafe) — pass --jev-provider
openrouter to use the saved one`.

**Fix block (jev-on / llm-jev / jev-off; `#` at cell 30, every line ≤ 76).** `export OPENROUTER_API_KEY=…   # one key: Jev + the code model` ·
`printenv OPENROUTER_API_KEY | jevcode login --key-stdin` · `jevcode login                 # masked prompt` · `export TYPESAFE_API_KEY=…     # Jev
native; add OPENROUTER_API_KEY for code` · `                              # Jev alone: jevcode config set mode jev-only` · (anthropic) `export
ANTHROPIC_API_KEY=…    # the code model under --provider anthropic` · footer kept. ConfigError
`missing generator.apiKey: set OPENROUTER_API_KEY (the code model), run with --mode jev-only, or run jevcode login`.

**CLI.** `jevcode login --key-stdin` · `OpenRouter API key (one key: Jev + the code model): ` · `jevcode: apiKey: key too short (8+ characters)
(first stdin line)` · `--key-stdin is the one-OpenRouter-key form; use --generator-key-stdin --jev-key-stdin` · `LOGIN_NEEDS_TTY_OR_STDIN` names
`--key-stdin` first · `--status` line `mode: <mode> (<source>) — needs: generator, jev` / `— needs: jev` · `--mode` help and the usage line of
§1.1 · `JevCode: Jev decides, the code model writes.` · man ENVIRONMENT `engine mode (jev-only | jev-on | jev-off | llm-jev; default <DEFAULT_MODE>)`.

**Chat.** `CREDITS_EXHAUSTED`: `OpenRouter says this key has no credits (HTTP 402). Add credits at openrouter.ai/credits, or /mode jev-only ($0.25
cap; Jev bills the same key).` (144 ≤ `REPLY_TEXT_MAX`).

**Commands.** aliases of §4.1 · `no session yet — the next prompt starts one` · ` (cut to 60 chars)` · `model <current> (next run: <pending>)` ·
`provider <current> (next run: <pending>)` · ` — mode jev-only ignores the generator; /llm on to use it` · `trust unchanged (<decision>)` ·
`transcript full (--plain is always full)` · `panel · <tab>` block head · `no completions for <arg>` · palette tags `Suggested` (kept) ·
`recent` · the ghost arrow ` → /<owner>` (`-> ` ascii) · help rows `  /status, /s   <title>` · `HELP_NOTES` + `colour-blind? /theme daltonized` · `light terminal? /theme light` ·
`/mode` value hints `jev+llm: the code model writes, Jev decides every step` · `llm+jev · verified: candidate patches, tests verify, Jev
arbitrates` · `no generating LLM; code proposes, Jev decides, tests verify` · `the generator alone (bench condition)` · `/theme` hint `dark
TypeSafe pink` · `whyErrorText(ref, reason)`: `error: /why: no decision <ref> in the last 3 steps` (TUI and plain alike) · `error: /why: <ref>
is not a decision ref (s<N>.<stage>.<id>, a digit 1–5, or intake)`.

**Transcript and status (renderer-only unless stated).** the 10-cell gutter · continuation rows leading with `· ` · `[sandbox]` text (renderer-local
item, §5.1 rule 13) · `/cost` head `cost` and `~$0.000006 each` (local) · `/jev` row 3 `last: question about this tool (1.00)` (local) ·
banner `loop · patch repeated 2 of 3` / `loop · replan 1 of 5 · s7 gather_context (p 0.62 · impossible 0.20)` (dynamic) · status left words
`▓ thinking` · `▓ looking` · `▓ replying` (`◆ thinking` reduced motion; `# thinking` / `* thinking` ascii) · the stage verbs with the pulse.

**Splash and wordmark.** the wordmark rows (TD2 §5.1) · caption `◆ <version>` (`* <version>` ascii) · tagline `Decisions, not strings` · brand
row `◆ jevcode <version>` (kept) · `ui.wordmark` `sweep | static | off` (default `static` under the SSH launch source).

**Theme.** `--theme dark` = TypeSafe pink (ids unchanged) · `docs/TUI.md` "the two pinks: `#f386a1` marks JevCode and Jev (brand, the
`[jevcode]` label, the badge, Jev's `[chosen]`), `#d45bb6` marks what is live or selected (the console edges during a run, your `[you]` label,
the palette cursor)".

---

## 11. Decision-log entries (ready to append to `docs/DECISIONS.md`)

## 2026-09-21 Jev+LLM is the default; one OpenRouter key runs both

`DEFAULT_MODE` (`src/config/defaults.ts`) becomes `jev-on` (badge `jev+llm`): the generator writes the code, Jev decides every step; the
session follows `config.mode` through `applyConfig()` (flag > `JEVCODE_MODE` > dotenv > file > default), which it did not before (a file or
env mode reached the caps and `jevcode config` but never the running session). One `OPENROUTER_API_KEY` serves Jev at
`openrouter.ai/api/alpha/decisions` and the default generator `z-ai/glm-5.3-flash`; TypeSafe native Jev is preferred whenever
`TYPESAFE_API_KEY` exists. The first-run wizard opens on one masked field and writes the file keys the detected state calls for (four from one paste when nothing
resolves; the generator key alone beside a TypeSafe or Jev key, so a file `jevProvider` never displaces `TYPESAFE_API_KEY`); its `3 Jev only`
persists `mode: jev-only` at startup; a keyed start without a file `mode` row prints the default-mode caps item at every start until one exists
(D-Q); `jevcode login --key-stdin` is the pipe form. Reason: the round-2 default (jev-only) was chosen for "one key, no generator spend" — with GLM 5.3 Flash
at $0.09/M in the same key buys both, and the owner asked for the LLM mode by default. Consequences: caps $2.00 / $10.00 by default (the
`[setup] spend caps` item names them after a wizard save; `/mode jev-only` and the wizard's `3 Jev only` keep the $0.25 path); every
fallback that named a mode reads `DEFAULT_MODE`, the badge words come from one table (`MODE_BADGE_WORD`, `llm-jev` → `llm+jev · verified`),
and a unit test refuses any literal that names a default outside `defaults.ts` — the peer's `llm-jev` flip is one literal. The two-commit
order (behaviour first, flip + re-pin second) is recorded in TUI-DESIGN-3 §1.10.

## 2026-09-21 Verification sends one priced Jev decision and one 1-token completion, on `y` only

The wizard's `Verify now?` (Enter/Esc skip) and `jevcode login --verify` send one real Jev decision (~$0.00002, ~250 ms), one `max_tokens: 1`
completion on the generator (~$0.000002; only when the mode needs a generator) and `GET /api/v1/key` ($0), and classify the answer as ok
· rejected (401/403, exit 2) · credits (402, exit 5) · unreachable (408/429/5xx/network, exit 5) · model (400/404, exit 2). Reason:
OpenRouter's key endpoint cannot see the balance of a key with `limit: null` and `/api/v1/credits` needs a management key (docs fetched
2026-09-21), so only a priced request reveals a 402; a model id is verifiable only by asking for it; the Ink wizard's `y` was a no-op
before (no `verify` host member). Consequences: the decision is metered into the session (`/cost` shows it); nothing is sent before an
explicit `y`; `JEVCODE_ASSERT_NO_NETWORK` smokes never press it.

## 2026-09-21 The wordmark stays; the sweep loops at 4 fps peak and sleeps

The 5-row wordmark is the pane slot's idle tenant, granted whole or not at all (`computeLayout` 1.2 `paneWhole`): shown while idle and
thinking at ≥ 21 rows (below, the boxed tier keeps the brand row so no palette or draft hands it off), hidden while a run is live or a panel,
picker or review owns the slot, back under the strip after `run:end` (at once at ≥ 24 rows, on the next key at 21–23 so the epilogue stays in
view); a key completes the reveal instead of killing it. The splash's own 6-cell sweep band loops left → right at 4 cells per 250 ms tick — 16 written frames per 4 s
pass, 6 s of rest (mean 1.6 fps), one pass per 30 s after a minute without activity, static after ten minutes, no pass within 3 s of a key (evaluated only where a pass would start — a key never cuts a pass short), a
reply calms rather than wakes it, off under reduced motion, at colour depth 0 and by default over SSH (`ui.wordmark: static`). Reason: the owner asked to "keep that animation … not disappear once it loads"; idle
today writes zero frames, so the budget is an absolute one — Ink's log throttle has a 0 ms wait and `useAnimation({ interval: 250 })` yields
exactly one render per tick at maxFps 30 and 15 (verified on the real renderer), so the loop cannot add throttle latency to a keystroke,
only ≈ 11 ms of CPU per frame. Consequences: a new `idle-frames` perf probe gates ≤ 4 fps peak / ≤ 2 mean and ≤ 12 KB/s; the caption
`◆ <version>` replaces the brand row as the settle sentinel; `ui.wordmark: sweep | static | off` is the escape hatch; the flat tier, 16–20 rows, < 64
columns and the screen reader draw no mark and spend no frames.

## 2026-09-21 The pink is TypeSafe's; the default theme keeps its id

The `dark` theme becomes the typesafe.ai palette measured on 2026-09-21: primary `#f386a1` (211 / `magentaBright`) for what *is*
JevCode or Jev — the brand row, the wordmark letters, the badge, the `[jevcode]` label, `[chosen]`, the idle `›`, the spinner — and
secondary `#d45bb6` (169 / `magenta`) for what is *being acted on* — the console edges while a run is live, the `[you]` label, the
palette cursor; error/warn/ok keep their hues; the light theme gets darkened pinks (`#be185d` / `#831843`) and fixes its unreadable
inherited red and green (2.74:1 and 1.73:1 on white); daltonized keeps the red ↔ blue swap and lets `[chosen]` stay pink (pink vs blue ΔE
34). Reason: the site uses `#f386a1` as its block colour and `#d45bb6` as hover/selection/border, which is a ready rule for rest vs
active; pink is never a semantic colour, so every pink role keeps its text marker and a deuteranope who cannot split pink from salmon
(ΔE 12) still reads `[chosen]` vs `[block]`. Consequences: the id `dark` stays (six enum sites, the man page, completions and 37 pty
scenarios untouched); chat bodies stay the terminal's default foreground — the label is the bubble; the prompt is pink at rest and amber
while steering. A white terminal announced through `COLORFGBG` (background 7 or 15) gets the `light` table by default (D-R); Terminal.app,
which sets none, is told in `/help` and TUI.md.

## 2026-09-21 Aliases pin their owner; availability errors clear the draft

21 short aliases (`/s` status, `/p` panel, `/t` theme, `/l` login, `/m` mode, `/c` cost, …) join the registry; an exact alias pins its owner
to the top palette row (the fuzzy scorer ranked `/steer` above `/status` for `s`), the palette shows an alias column, a `→ /owner` ghost and
Suggested → recent → Popular groups for an empty query; Tab completes arguments and never wipes a typed one; an error the user cannot fix by
editing (`needs a live run`, `runs when the run is idle`, `not available in --plain`) clears the draft, a fixable one keeps it. Reason: the
audit measured `/budget spend-cap` + Tab collapsing to `/budget `, and kept drafts turning the next command into `/steer x/pause`. `a` for
`/abort`, `x` for `/exit` and `n` for `/new` were rejected (one-letter aliases for commands whose Enter destroys state without a confirm; `/new` is `nw`). Consequences: `docs/COMMANDS.md` and the man page regenerate;
the help block prints aliases; `/panel`, `/transcript`, `/theme`, `/copy diff`, `/decisions`, `/why`, `/help`, `/trust`, `/logout`, `/new`,
`/rename`, `/model`, `/provider`, `/errors` and `/help reload` behave as their rows promise (TUI-DESIGN-3 §4.4).

---

## 12. Where the research reports disagreed, and what this document takes

| # | Topic | R1 theme | R2 wordmark | R3 onboarding | R4 commands | R5 polish | Taken | Why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | wordmark lifetime | — | idle tenant for the whole session; returns after `run:end`; the loop animates | — | — | "hero" until the first submission, then the brand row carries the tagline; static after 700 ms | **R2** (D-I) | the user's words name the animation, not a static hero; R2 measured the cost (0 → ≤ 18 ms CPU/s) and proved keys never wait; a session whose every idle screen carries the mark is the shareable one. Owner ratifies |
| 2 | tagline row | — | at ≥ 104 columns on row 0 (5 rows kept) | — | — | a sixth row at every width (`CAP.hero = 6`) | **R2** | a sixth row moves every layout table, the splash gates and frame 0; at 80 columns the tagline is the caption's job |
| 3 | splash fade | fade 1 → `accent2` | no fade (held) | — | — | no fade | **R2/R5**: no fade; `accent2` paints the caption `◆` and the palette `▌` instead | a mark that never fades has no fade step |
| 4 | `you` role | body in secondary pink | — | — | — | `[you]` label bright bold, body default | **label in secondary pink (bold), body default** (D-O) | readability of long human text (4.74:1, 4.27 on Solarized) vs a 5-cell label; the two voices stay pink |
| 5 | `steer` prompt colour | amber while live (attention) | — | — | — | pink | **R1** (D-O) | the steering prompt must not look like the idle prompt; live already reads pink through the magenta edges |
| 6 | `ok` / `chosen` | `ok` `#4ADE80`/78, `chosen` pink | — | — | — | both the site green `#03aa5c` | **R1** | 9.57:1 vs 5.48:1; success is not brand; `[chosen]` is Jev's pick |
| 7 | `code`, `sweep` | `#e5e5e5`/254, `#fbd0dc`/224 | — | — | — | `#abbab9`/249, `#fefefe` | **R1** | the site's tertiary text token has an exact 256 twin; the pale pink tint reads as light on pink letters |
| 8 | spinner | — | — | — | — | shade pulse `░▒▓█▓▒` in a new `spinner` role | **pulse, coloured `accent`** (no new role) (D-P) | one glyph family for boot and thinking; a separate role buys nothing the `ansi` derivation does not already give |
| 9 | badge marker | `'<mode>'` | — | "check what reads it" | — | `'badge'` | `'<mode>'` | it is validated non-empty only (`theme.ts:235`); `<mode>` documents the twin |
| 10 | badge word table location | — | `modeBadgeWord` | `defaults.ts` or `lines.ts` | `MODE_TABLE` with `set` and `hint` | `BADGE_WORDS` in `status/lines.ts` | `MODE_BADGE_WORD` in `src/config/defaults.ts`; `MODE_SET_ITEM` in `session.ts`; hints in `registry.ts` read the word table | config/cli/chat/tui all import `defaults.ts`; the item and hint strings belong to their renderers |
| 11 | transcript text forms (`[run] start/end`, replan, loop) | — | — | — | — | rewrite (P5) | **deferred** (D-M) | `perf/pty.ts:800` and twelve test files pin `steps=`; the wrap rule removes the visible defect |
| 12 | `/decisions`, `/plan` in the TUI | — | — | — | host-routed (recommended) or App-local filter | — | host-routed | identity by construction; one extra ~1 ms round trip |
| 13 | `/transcript` in `--plain` | — | — | — | refusal or `always full` | — | `transcript full (--plain is always full)` | the registry row must say one thing; the answer is more useful than a refusal |
| 14 | alias `a` for `/abort`, `x` for `/exit` | — | — | — | keep both? | — | add `q`, drop `a` and `x` (today's exit aliases are `quit` only, `registry.ts:506` — `x` was never there to keep) | exit confirms while live but not when idle; one quit letter is enough and `q` is the one every pager teaches; abort never confirms |
| 15 | `ui.wordmark` + `/wordmark` command | — | both | — | — | — | the setting only | 37 commands is enough surface; `jevcode config set ui.wordmark off` and `--no-animation` cover it |
| 16 | `[sandbox]` text | — | — | — | — | one-line form + detail (P12) | taken (a renderer-local item, §5.3 — not an engine text change; D-M's engine forms stay deferred) | one string, one test, the first screen |
| 17 | session header `\| step 0/– starting` | — | — | — | — | drop the sentinel (P13c) | deferred | the sentinel is read from the first frame by `chat.pty.test.ts:81`, `taskfile-header.steps`, `first-frame.ts` |
| 18 | caps item on a keyed first start | — | — | per wizard save (no marker file); §9 risk 2 flags a one-time notice | — | — | **`defaultModeItem` on every keyed start whose `mode` resolves from `default` with no file `mode` row** (D-Q, ratify) | a paid default flipped under a keyed user needs more than a CHANGELOG line; the `mode` row is the state, so no marker file and no write on a keyed start |
| 19 | `options` `3 Jev only` persistence | — | — | pend only (Q2) | — | — | **persist `mode: jev-only` at startup** (reason `missing`); pend under `/login`; `MODE_SET_ITEM['jev-only']` names `jevcode config set mode jev-only` | pend-only rebuilt the wizard at every launch (the saved Jev key resolves, the generator is still missing, `found` was env-only) with the wrong `No API key found` title and no exit but `config set`; `/mode`'s contract is for a running session, not a first start |

## 13. Review log

Every finding of the design review, applied in place above; "changed" names the section that moved. Nothing was rejected outright; two
findings were taken in a form other than the one proposed and say why.

| # | Sev | Finding | Changed |
| --- | --- | --- | --- |
| 1 | blocker | §5.3 identity normaliser's `· ` clause inverted rule 3 and deleted separators | §5.3: R5's predicate verbatim (strip gutters, join with one space, collapse); explicit F-R4 step-row and `[run] end … / exit 4` cases named for `wrap.test.ts` and `round2-transcript.test.tsx` (§8 S5); `wrapLike` anchor `:23` |
| 2 | blocker | wizard rows 89–125 cells vs a 76-cell inner width; the bound "≤ 78" and the 100-column threshold both wrong | §1.4.2 rewritten: every string ≤ 76 (measured widths in the table), wide/narrow twins chosen by `cellWidth(wide) ≤ inner` (wide `options` 98 → ≥ 102 columns), verify title 75 with `[n] skip` visible, endpoints moved to the `[setup] verified:` items' `detail`; `lines.test.ts` asserts `≤ consoleInnerWidth(80)` and the 120-column wide form; F-R8/F-R9 redrawn; Enter/Esc at `verify` act as `n` (§1.4.1) |
| 3 | blocker | `useIdleLoop` contradictory (`isActive` carried the quiet rule; started in the pass phase at mount) | §3.6 rewritten as a two-phase machine: activation requires `!splashRunning`, starts in `rest`, quiet rule evaluated only at rest → pass, a key never ends a pass, the App renders `loop.band`; timeline 6,450 / 6,700 ms; §3.8, §3.9 and §8 S2 (`motion.test.tsx` with a fake clock) follow |
| 4 | major | one-key save wrote `jevProvider: openrouter` beside a resolving `TYPESAFE_API_KEY` (rule 1 beats 2c) | §1.4.3 save-shape table keyed on `found` (`keyAs`): generator-only beside a TypeSafe/Jev key; tests in `tui-prompter.test.ts` and `resolve.test.ts` (§8 S3, edge 34) |
| 5 | major | `/p d` / `/Panel full` bypassed the literal pre-router and reached a host `case 'panel'` that cannot toggle | §4.4 F3: `parsePanelCommand` resolves aliases and case through `findCommand` (S4), the App pre-router keeps the toggle semantics (S2 one line), the host keeps plain twins only and warns `panel: handled by the TUI` in the TUI; §7.2 `pane/commands.ts` row; tests |
| 6 | major | `Console.tsx`'s duplicate `wizardConsoleTitle` map lacks `key` / `options` | §1.4.2 closing paragraph and §7.2 Console row: delete the map, re-export `lines.ts`'s; `console.test.ts` pins `setup · key` / `setup · options` |
| 7 | major | `UiConfig.wordmark` required while the header promised optional; `App.tsx:988` and fakes would break | §6 item 4 `wordmark?`; readers `?? (ssh ? 'static' : 'sweep')`; §3.8 notes `:988` untouched |
| 8 | major | ownership gaps: `test/unit/perf/**`, `src/chat/intake.ts` / `meterChat` route, `epilogue.test.ts` in S3's glob, `dispatchContext` off the contract | §7.1 S5 owns `test/unit/perf/**`, S3's `test/unit/cli/**` excludes `epilogue.test.ts`; §1.5 `meterVerify` bypasses the chat ledger (no `ChatRoute` change, no phantom message in `/cost`); §6 item 7 `SessionHost.dispatchContext?()`, §4.4 F20 |
| 9 | major | `applyConfig`'s `baseMode = config.mode` promoted a pending `/mode` at every `reresolve()` | §1.2: copy only while `pending.mode === undefined`, dispatch `{ mode: baseMode, pending }`; test named (`/mode jev-on` + wizard save keeps ` · next run`) |
| 10 | minor | §6 anchors (`WizardOutcome`/`Prompter` are in `session.ts`; a core → tui import), caption span 9 vs 7 cells, `splashFrame` without `version` | §6 items 2–3 cite `session.ts:335,347`, item 1 records the type-only import as the one inversion; §3.4/§3.5 `captionFits(columns, caption)` with span `[58, 58 + cellWidth)` (73 for a 7-cell caption, 85 for 13); `splashFrame(t, columns, g, version)` so `splash:done` writes nothing |
| 11 | minor | frame row counts (F-R8 14 → 13; F-P1 13 → 19 with rule row and mark; §3.7's "= 6" was the composer count) | F-R8 caption and rows; F-P1 redrawn with the strip and the mark (19 rows); §3.7 totals per `computeLayout`; §3.2 wizard row 13 |
| 12 | minor | `[sandbox]` is renderer-local, its text 128 cells is two rows at 120; `CREDITS_EXHAUSTED` 177 > 160 | §5.1 rule 13 and §5.3 reclassify `[sandbox]` (117 cells, two rows at 80 and 120); `CREDITS_EXHAUSTED` cut to 144 (§1.7, §10) |
| 13 | minor | `ghost.rest` type error at `App.tsx:1609–1613` unlisted for S2; harness path `.tsx` | §4.1 rule 3 and §7.2 App row list the ghost-accept change as an S4 request S2 lands; `app-harness.tsx` |
| 14 | minor | `wordmark-key-during-pass` "echo within 16 ms" flaky by R2's own ≈ 11 ms render | §8 S5: the scenario gates at the 50 ms max bound; the 16 ms p95 gate stays in the `idle-loop` composer series |
| 15 | minor | HEAD is `2ea8c40`; `args.ts` anchors moved; `wrapLike` is at `:23`; `theme.test.ts` listed twice | header, §1.1 args row (`:244`, `:646–649`, `:746`, `:750`), §5.3 anchor, §1.10 (`theme.test.ts` S1 only) |
| 16 | blocker | (second width finding) ten strings clipped mid-sentence; SR options row 109; `providerHintMode(llm-jev)` 83; Enter/Esc at `verify` no-ops | as row 2, plus §1.3.3 SR `options` as three rows ≤ 76, §1.9 `providerHintMode` 75, §1.4.1 verify keys |
| 17 | blocker | found-title variants reused the four-key save; the anthropic title invited a TypeSafe key into an OpenRouter field | §1.4.1/§1.4.3: `keyAs` per `found` (`generator` beside TypeSafe/Jev, `jev` beside Anthropic with `provider: anthropic`), the anthropic title names an OpenRouter key and the hint the `Esc, then 2` route; §1.3.1 rows; edges 16, 34, 39 |
| 18 | blocker | `3 Jev only` pended only and rebuilt the wizard at every launch (wrong `provider` title); `MODE_SET_ITEM['jev-only']` had no persist clause | §1.4.1/§1.4.3/§1.3.1: `WizardOutcome.mode.persist` — a startup wizard writes `mode: jev-only` (`writeConfigValue`) and prints `modeSavedItem`; `found` is computed from resolved entries incl. the file (edge 35); `MODE_SET_ITEM['jev-only']` gains `(persist: …)` (§10); fix block names `config set mode jev-only` (§1.6); §12 row 19; test: pick 3, save, restart → no wizard |
| 19 | blocker | F-W frames drew scrollback flush left against §5.1 rule 1 and showed a clipped `[config]` row | §3.10: F-W frames are dynamic rows only (captions say so; `frames2.test.ts` asserts the dynamic region); scrollback is drawn in F-R3/F-R6/F-R8 |
| 20 | major | a keyed round-2 user silently moved to jev+llm with raised caps and no notice | D-Q (ratify): `defaultModeItem` on every keyed start whose `mode` resolves from `default` and whose file has no `mode` row (§1.3.1, §1.7, §10, §12 row 18, edge 36). Taken in the "presence of a `mode` row is the state" form rather than a one-time `seen.*` key, which would add a config write to a keyed start |
| 21 | major | the mark returned right at `run:end` and pushed the epilogue off-screen below 24 rows | §3.1/§3.2: `WORDMARK_POST_RUN_MIN_ROWS = 24`; at 21–23 rows the mark returns on the first key (`UiState.postRunKeySeen`, §3.3, §6 item 8); F-W5 caption; `wordmark-21.steps` |
| 22 | major | V19 `hi` → `[jevcode]` ≤ 300 ms live left 35–60 ms of headroom over a network round trip | §9 V19 = the 1.5 s p95 gate over the capture's intakes, median reported; 300 ms is the mock-path bound |
| 23 | major | V7/V8/V10/V15/V17 not evaluable from a `.txt` (wordmark rows, wrapped `[config]`, `[step 100]`, top edge, glyph-less status rows, `loop tripped` scrollback) | §9 checklist preamble defines scrollback vs dynamic from the `.cap` grammar, wordmark and wrapped rows; V8 `blank | ] at 8 | [step \d{3,}] | ≥ 10 spaces | wrapped`; V10 skips the first visible row; V15 "when a spinner glyph leads"; V17 scoped to the dynamic region |
| 24 | major | contrast computed on dark backgrounds only; Terminal.app's white Basic profile shows cell 211 at 2.25:1 with no mitigation | D-R: `COLORFGBG` background 7 / 15 → default `light` (`launch.ts`, S3; §2.2, §2.6, §2.8, edge 40); `HELP_NOTES` `light terminal? /theme light` (§2.3); TUI.md Terminal.app note (§2.6) |
| 25 | major | the flat-tier `Wizard.tsx:305` `fieldRow` guard was not updated for `key`; no 12-row wizard frame | §1.4.1 `isFieldStep` read by both renderers; §1.4.3 names `Wizard.tsx:305`; F-W9 (12×80 `key` step); `r3-wizard-resize.steps` asserts the cursor row (edge 8); §7.2 Wizard row |
| 26 | major | `dim` carried body-grade text at 3.3:1 (50 % halving) with no stated figure or fallback | §2.1 dim row states the figures; §2.5 paragraph; §2.7 and §5.1 rule 2: detail rows, `[ui]` bodies and the epilogue's value column are the default foreground, dim is for ≤ 12-cell labels, tags and decoration (`itemRole` drops the `[ui]` → dim branch); §2.6 row. The coloured-dim alternative (`#abbab9` / 145) is recorded and not taken |
| 27 | major | F-P3 rows 54–60 cells with misaligned tags pinned as the oracle; alias column unspecified for multi-alias commands | §4.2 F-P3 regenerated at 60 cells per row (also F-P1 at 76 inside the card) with the row anatomy stated; §4.1 rule 4: shortest alias, ties → table order; `palette.test.ts` asserts one width per frame and compares palette rows only |
| 28 | major | `verify` Enter/Esc no-ops; `options` Enter without a pick unspecified; `key` Esc-with-text cleared while the hint said `Esc back`; the prefix hint hid the TypeSafe route | §1.4.1 keys per step: Enter/Esc at `verify` = `n`; `pick 1–4`; the typing hint `Esc clears (again: other ways)` and SR `Escape clears, then Escape again …`; `HINT_PREFIX_KEY` names `Esc, then 2` (edges 9, 37–39) |
| 29 | minor | fix-block lines 102/126/92 cells; rule 13's "one row at 120" false; `CREDITS_EXHAUSTED` 177 | §1.6 fix block with `#` at cell 30 and a two-line TypeSafe entry (61/55/45/75/75/73; anthropic 73); rule 13 "two rows at 80 and 120"; credits 144 |
| 30 | minor | `n` for `/new` — a one-letter alias for an unconfirmed destructive command; `q`/`x` both exit | §4.1: `/new` → `nw`, `/exit` keeps `q` and `quit`, `x` dropped (the same test that dropped `a`); §11, §12 row 14 |
| 31 | minor | `/mode` echo would read `mode jev+llm (default) (next run: jev+llm (default))` | §4.4 F1 and §10: two forms — `mode <badge>[ (default)]` when nothing differs, else `mode <cur> — next run: <next>[ (default)]`; both pinned in `session.test.ts:126–150` |
| 32 | minor | a reply reset `lastActivityAt` and made the mark sweep every 10 s while the user reads | §3.6: a reply leaves the loop `calm` (30 s); only `key` and `run:end` make it attentive; §6 item 8, §8 S2 reducer test |
| 33 | minor | SSH kept 4 fps colour-only redraws over slow links | §3.2 twins and §6 item 5: `ui.wordmark` defaults to `static` when the SSH launch source is set (flag/env/file override); TUI.md SSH row |
| 34 | minor | A4 caret blinked at 4 Hz | §5.2 A4: `spinnerFrame % 8 < 4` — 1 Hz, a terminal cursor's cadence |
| 35 | minor | at 16–18 rows the palette and a tall draft handed the mark off and back around every `/` command | §3.1: `WORDMARK_MIN_ROWS = 21` with the arithmetic (palette 8 + idle 11 = 19 = budget at 21); §3.2 row for 16–20 rows; §3.7; F-W8 at 21×64; `wordmark-21.steps` |
| 36 | minor | the `found === 'jev'` reuse silently persisted an env secret and reported it as `entered` | §1.4.2: `Enter = save the JEV_API_KEY value as the code-model key (config file)` (file source: `reuse the saved Jev key …`); item `generator key: reused from JEV_API_KEY (sha256:…) source=env→file` (edge 11, §10) |
| 37 | minor | TTY `jevcode login` had no equivalent of the `options` step | §1.6: the `other ways: [t] … · [j] … · [a] … · Enter continues: ` line (79 cells) precedes the masked prompt when both secrets are missing; the same line serves the `--plain` twin (§1.4.3) |
| 38 | minor | the narrow `options` form dropped `(default)` and only option 3 had a consequence line | §1.4.1/§1.4.2: a digit highlights and shows `optionHint(n)` (four lines ≤ 76, ` (default)` placed at render time), the same digit or Enter confirms; F-R9h |
| 39 | minor | wording: "byte-identical" frame 0, tmux depth, "keep `x`" | §3.4/§3.9 "cell-identical; SGR bytes per §2, badge word per §1.10"; §2.1 "depth 16 (`TERM=screen`, `--theme ansi`)"; §12 row 14 "add `q`, drop `a` and `x`" |

Owner decisions after the review: D-I, D-K, D-L, D-M (unchanged, still to ratify), **D-Q** (the default-mode item on keyed starts — new, ratify;
recommended), the D-J extension (option `3` persists `mode: jev-only` at startup — ratify; recommended), D-R (decided). Standing constraints re-checked after the edits: first frame unchanged (`captionFits`, `WORDMARK_MIN_ROWS` and
`COLORFGBG` are constants and env reads); zero network before an explicit `y`; the D-F key path untouched (the idle loop starts only after
`splash:done` and never gates on keys); dynamic frames during a run unchanged (the mark is hidden while live); line identity holds (the
normaliser is R5's, `[sandbox]` and `defaultModeItem` are local items in one formatter each); keys never printed (the reuse hint names a
variable, never a value; `FoundKey` names sources); no auto-approve; reduced motion / `NO_COLOR` / screen reader / the flat tier / the SSH tier
each have a row in §3.2's twins; no new dependency; every new type is strict.
