# 19 — Re-verification of twelve claims in `00-SUMMARY.md` against primary sources

Written 2026-09-20. Scope: the twelve claims listed in the task, each re-checked against the primary source
(installed `node_modules`, repo files, raw GitHub files, official docs, npm registry JSON, GitHub REST API) or
against a measurement made today under `/tmp/jevverify`. Every quote below is verbatim from the source named.
Verdicts: **VERIFIED** (the claim as stated holds), **REFUTED** (with the correction), **UNVERIFIED** (what was
tried), and **VERIFIED — wording defect** where the summary's *facts* hold but the sentence in `00-SUMMARY.md`
misstates them (the fix is a rewording, not a redesign).

Tooling used today: `curl` against `raw.githubusercontent.com`, `api.github.com`, `registry.npmjs.org`,
`code.claude.com`, `devblogs.microsoft.com`, `can-i-use-terminal.github.io`; a Python `pty.fork` driver; the
installed `ink@7.1.1`, `terminal-size@4.0.1`; Node v22.23.2 (`node --version`) and its bundled npm 10.9.8
(`npm --version`), both read on this machine 2026-09-20. `tmux` and `brew` are absent (`command not found`).

---

## 0. Verdict table

| # | Claim (abridged) | Verdict | One-line correction |
| --- | --- | --- | --- |
| 1 | "Alternate screen and mouse capture are rejected by all twelve files" | **VERIFIED** (the summary overstates) | 09, 10, 11 never mention either; alt-screen is rejected in 9 files, mouse in 5. Say "by every file that discusses them". |
| 2 | "Claude Code dropped `<Static>` and paid with a from-scratch renderer" vs U2 UNVERIFIED | **VERIFIED — wording defect** | Both statements are true and compatible once §1 names its source: a first-person HN comment by the Claude Code rendering engineer. U2 asks a different question (is the `ink` in the binary upstream Ink). |
| 3 | §5.3 "`getWindowSize() = [0,0]`" vs A93 "Ink 80×24 fallback" | **VERIFIED — wording defect** | The `[0,0]` is Node's `tty.WriteStream#getWindowSize()` (array shape); `terminal-size` returned `{0,0}`; Ink's `getWindowSize` returned `{80,24}`. Measured again today; 07 §3.7 already said so. |
| 4 | Ctrl-C state machine is self-contradictory / unspecified | **VERIFIED** | A18 (exit 130 on empty Ctrl-C), A54/10 §15.4 (process stays open), 06 §17.1 (first Ctrl-C = interrupt) and DESIGN §11 (any Ctrl-C = `shutdown('human_abort')`) disagree; no file gives the idle/live/review/text × one-shot/session matrix. |
| 5 | Height-budget numbers disagree; §1 shape cannot fit 22 rows | **VERIFIED** | Composer 1–6 (A10, 08) vs ≤ 8 (A107, 04 Q4); queue ≤ 2 (A53, 10) vs ≤ 3 (A107, 04, 02 §9). §1 shape sums to 40–41 rows with a review pending and 24–25 without, against a 22-row budget. |
| 6 | Publish plan ignores `"private": true`; LICENSE missing | **PARTIALLY REFUTED** | `package.json` has `"private": true` and no LICENSE exists; A65 and 09 §11.7 omit `private`, **but** 09 §11.1's rationale paragraph does say "Drop `"private": true` when publishing". Both files note the missing LICENSE. |
| 7 | Heuristic secret filter (`sk-…`, `ghp_…`) is "future work" | **REFUTED** | `src/core/redact.ts` `patternRedact` already covers `sk-or-v1-`, `sk-ant-`, `sk-(proj-\|live_\|test_)?`, `AIza`, `gh[pousr]_`, `github_pat_`, `authorization: bearer`, `x-api-key:` (tested). Not covered: AWS `AKIA…`, PEM, JWT. File 16 §1.1 already records this. |
| 8 | OSC 52 in "VS Code 1.93 (June 2024 addon)" | **REFUTED** | VS Code **1.91** ("June 2024 (version 1.91)", dated 2024-07-03) added OSC 52 via `@xterm/addon-clipboard@0.2.0-beta.4` (PR #214262 merged 2024-06-06). 1.93 is the August 2024 release (2024-09-05) and its notes never mention OSC 52. The "1.93" came from can-i-use-terminal, which is wrong. |
| 9 | xterm.js #5600 2026-01-10; VS Code 1.109 (2026-02-04) `enableKittyKeyboardProtocol` default true; WT Preview 1.25 (2026-03-05) | **PARTIALLY REFUTED** | PR and both dates VERIFIED. **Default true at 1.109 is REFUTED**: tag `1.109.0` ships `default: false, tags: ['experimental','advanced'], experiment: { mode: 'auto' }`; the default is `true` from tag `1.110.1` onward (checked 1.110.1–1.117.0 and `main`). |
| 10 | Trusted publishing needs npm ≥ 11.5.1, Node ≥ 22.14 | **VERIFIED** + material addendum | docs: "requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher". **No Node 22.x release bundles npm 11**: 22.22.3 → npm 10.9.8, and this machine's 22.23.2 reports npm 10.9.8. First Node to bundle npm 11.5.1 is **24.5.0 (2025-07-31)**. npm 11.5.1 `engines`: `^20.17.0 \|\| >=22.9.0`, so `npm i -g npm@11` works on 22.23.2. |
| 11 | tmux 3.7 DECRQM 2026 / synchronized output / `escape-time` 500 ms while requests pending | **VERIFIED** against CHANGES + 3.7 source; **UNVERIFIED** locally | All three items are in "CHANGES FROM 3.6b TO 3.7"; 3.7 released 2026-06-26. The 500 ms is a *floor* applied to `escape-time` while queries are pending (`if (delay < 500) delay = 500;`, `tty-keys.c`) and `INPUT_REQUEST_TIMEOUT 500` (`input.c`). 3.7b fixed a sync-update redraw regression. No local install possible (no tmux, no brew). |
| 12 | Notifications: review after ~6 s idle; run end after ~60 s | **VERIFIED** with clarification | docs:hooks: `permission_prompt` "once you haven't typed for about six seconds. The timer starts when the permission prompt appears, and each keystroke defers it" (an idle gate with debounce semantics, not a fixed delay); `idle_prompt` "about 60 seconds after Claude finishes responding, and only if you haven't typed since". |

---

## 1. "Alternate screen and mouse capture are rejected by all twelve files" (§1)

**Method.** `grep -ci` over the twelve files 01–12 for `1049`, `alternate screen|alt-screen|alternate-screen|altscreen|alt screen`,
and `mouse`; then the REJECT section of each file read for a row naming either (2026-09-20).

| File | `1049` | "alternate screen" | `mouse` | REJECT row for alt-screen | REJECT row for mouse |
| --- | --- | --- | --- | --- | --- |
| 01 | 3 | 6 | 12 | "Alternate screen (`\x1b[?1049h`) as the default" | "Mouse capture by default (`\x1b[?1000/1002/1003/1006h`)" |
| 02 | 2 | 6 | 10 | "Alternate-screen "fullscreen" mode as the default" | "Mouse tracking (`CSI ? 1000/1002/1003/1006 h`)" |
| 03 | 0 | 0 | 3 | R2 "The private Ink fork features: … `alternateBuffer`/`terminalBuffer`/`renderProcess` …" (Gemini's name for it) | none (mouse parsing mentioned in R1 only as part of the rejected stdin parser) |
| 04 | 0 | 14 | 3 | R2 "Alternate screen for the main chat (`tui_fullscreen_transcript` "owned" mode)" | R8 "Mouse capture (`?1000/1002/1003/1006h`)" |
| 05 | 0 | 5 | 12 | R1 "Alternate screen + virtualized history (Qwen PR #4146 path, ~2,800 LoC)" | R2 "Mouse capture / SGR mouse tracking" |
| 06 | 0 | 2 | 0 | "Alternate screen (`render({ alternateScreen: true })`)" | none |
| 07 | 2 | 8 | 18 | "`alternateScreen: true` for the default TUI" | "Mouse reporting (1000/1002/1006)" |
| 08 | 1 | 7 | 2 | R2 "`alternateScreen: true` / an in-app scrolling transcript" | none |
| 09 | 0 | 0 | 0 | — | — |
| 10 | 0 | 0 | 0 | — | — |
| 11 | 0 | 0 | 0 | — | — |
| 12 | 3 | 8 | 0 | "Alternate screen buffer for the chat mode" | none |

**Verdict: VERIFIED.** Files 09, 10 and 11 contain zero mentions of `1049`, "alternate screen" or "mouse" (their
topics are packaging, sessions and the Jev pane). Alternate screen is rejected in 9 of 12 files (03 under Gemini's
`alternateBuffer` name); mouse capture is rejected in 5 (01, 02, 04, 05, 07). The rejection is unanimous among the
files that discuss each item; "all twelve" is an overstatement. Files 13–17 (written after the summary) also never
mention either, except 15 (one "alt" hit unrelated to the screen buffer).

**Correction for §1:** "Alternate screen is rejected by every file that discusses it (01–08, 12; 09–11 are silent),
mouse capture by every file that discusses it (01, 02, 04, 05, 07)."

---

## 2. "Claude Code dropped `<Static>` and paid with a from-scratch renderer" (§1) vs U2 (§7.3)

**Primary source re-fetched:** HN Algolia item API, `https://hn.algolia.com/api/v1/items/46701013` (2026-09-20).
- Parent comment by `chrislloyd`, `created_at` 2026-01-21T04:11:40Z: "we shipped our differential renderer to
  everyone today. We rewrote our rendering system from scratch".
- Child comment 46701325 by the same author, 2026-01-21T05:00:14Z: "Since we no longer have <Static> components the
  app re-renders much more frequently with larger component trees." and "The new renderer double buffers and blits
  similar cells between the front and back buffer to reduce memory pressure."
- 02 §2.2 quotes the same comments and adds the author's self-description "I work on TUI rendering for Claude Code".

**What U2 actually asks** (00 §7.3 row U2, verbatim): "Whether Claude Code's shipped `ink` is upstream Ink or an
in-house renderer (binary strings, leak write-ups, HN comment only; the 2026-04-01 dev.to article is not relied on)".
02 §2.4 concludes: "CC's rendering layer is at minimum a heavily customised Ink-like layer with its own renderer; do
not assume upstream Ink behaviour from CC's behaviour or vice versa."

**Verdict: VERIFIED — wording defect, not a contradiction.** Two different propositions: (a) *Claude Code's team
removed `<Static>` and rewrote the renderer* — supported by a first-person statement from the engineer responsible
(a primary statement in a secondary venue; not code); (b) *whether the `ink` identifiers in the shipped binary are
upstream `ink@x` or a fork* — genuinely UNVERIFIED (no source tree available). §1 states (a) as fact without naming
the source; §7.3 flags (b). They reconcile if §1 reads: "By its rendering engineer's own account (HN, 2026-01-21;
02 §2.2) Claude Code dropped `<Static>` and rewrote its renderer from scratch; whether the result still wraps upstream
Ink is UNVERIFIED (U2)."

Design consequence unchanged: JevCode keeps `<Static>` + the `rows − 2` budget (08 §11 numbers) regardless of (b).

---

## 3. "0×0 pty: `columns: 0, rows: 0`, `getWindowSize() = [0,0]`" (§5.3) vs A93 "Ink 80×24 fallback"

**Sources.**
- Node 22 docs (`https://nodejs.org/docs/latest-v22.x/api/tty.html`, 2026-09-20): "`writeStream.getWindowSize()`
  returns the size of the TTY corresponding to this `WriteStream`. The array is of the type `[numColumns, numRows]`";
  "`writeStream.columns` … A `number` specifying the number of columns the TTY currently has. This property is updated
  whenever the `'resize'` event is emitted."
- Installed `node_modules/ink/build/utils.js` (ink 7.1.1, read 2026-09-20), verbatim:
  ```js
  export const getWindowSize = (stdout) => {
      // `stdout.columns`/`rows` can be 0 or undefined in non-TTY environments.
      const { columns, rows } = stdout;
      if (columns && rows) {
          return { columns, rows };
      }
      const fallbackSize = terminalSize();
      return {
          columns: columns || fallbackSize.columns || 80,
          rows: rows || fallbackSize.rows || 24,
      };
  };
  ```
- Installed `node_modules/terminal-size/index.js` (4.0.1): `if (stdout?.columns && stdout?.rows) { return create(…) }`
  … `if (env.COLUMNS && env.LINES) { return create(env.COLUMNS, env.LINES); }` … on darwin `return devTty() ?? tput()
  ?? fallback;` where `devTty` does `const {columns, rows} = tty.WriteStream(fs.openSync('/dev/tty', flags)); return
  {columns, rows};` — no zero check, so a 0×0 controlling tty yields `{columns: 0, rows: 0}` and Ink's `|| 80` / `|| 24`
  supplies the defaults. (`tput` output goes through `createIfNotDefault`, which *discards* an 80×24 answer; the
  `/dev/tty` path does not.)
- Ink call sites (`node_modules/ink/build/ink.js`): line 753 `const viewportRows = isTty ?
  getWindowSize(this.options.stdout).rows : 24;`; `hooks/use-window-size.js` line 9 `useState(() => getWindowSize(stdout))`.

**Measurement made today** (`/tmp/jevverify/pty0.py` forks node via `pty.fork`, sets `TIOCSWINSZ`, child runs
`/tmp/jevverify/size.mjs` importing Ink's and terminal-size's functions from this repo's `node_modules`; output verbatim):

```
--- 0x0 pty ---
{"isTTY":true,"columns":0,"rows":0,"node_getWindowSize":[0,0],"terminal_size":{"columns":0,"rows":0},"ink_getWindowSize":{"columns":80,"rows":24},"env":{}}
--- 0x0 pty + COLUMNS=100 LINES=30 ---
{"isTTY":true,"columns":0,"rows":0,"node_getWindowSize":[0,0],"terminal_size":{"columns":100,"rows":30},"ink_getWindowSize":{"columns":100,"rows":30},"env":{"COLUMNS":"100","LINES":"30"}}
--- 20x5 pty ---
{"isTTY":true,"columns":20,"rows":5,"node_getWindowSize":[20,5],"terminal_size":{"columns":20,"rows":5},"ink_getWindowSize":{"columns":20,"rows":5},"env":{}}
--- pipe (no tty) ---
{"node_getWindowSize":"n/a","terminal_size":{"columns":80,"rows":24},"ink_getWindowSize":{"columns":80,"rows":24},"env":{}}
```

**What 07 §3.7 actually says** (verbatim): "a pty with `TIOCSWINSZ` 0×0 gives `columns: 0, rows: 0`, `getWindowSize()
= [0,0]`; Ink's `getWindowSize` falls through to `terminal-size` 4.0.1 which returned `{columns:0, rows:0}` in 0.13 ms
(no spawn on a TTY), then Ink defaults to `80×24`". The array shape `[0,0]` can only be Node's method; 07 then names
Ink's separately. So 07 measured *both* and was explicit; 00 §5.3 compressed the sentence and lost the owner of
`getWindowSize()`.

**Verdict: VERIFIED — wording defect in §5.3 only.** A93 is correct. Correction: "`process.stdout.columns/rows` = 0,
Node `stdout.getWindowSize()` = `[0,0]`, `terminal-size` = `{0,0}`, Ink `getWindowSize` = `{80,24}`".

**Design rule this implies (new):** no JevCode code may read `process.stdout.columns`/`rows` directly for layout; use
Ink's `useWindowSize()` (or `useStdout().stdout` through Ink's helper), otherwise a 0×0 pty (what `expect` and
`pty.fork` start with, 12 §12.6) gives a 0-column rule and `Math.max`-less negative widths while Ink itself renders 80×24.

---

## 4. Ctrl-C: "composer empty → `human_abort` (checkpoint, exit 130); second press → exit" (A18, §1)

**Statements found, verbatim.**
- 00 A18: "Ctrl-C: composer non-empty → clear (draft to history); empty → `human_abort` (checkpoint, exit 130); second
  press → exit; window length to decide (1 s Codex, 1.5 s, 3 s Gemini)".
- 00 A54: "in the session TUI the process stays open after `run:end` and the next prompt is a follow-up; `jevcode run
  "task"` keeps exit-after-run".
- 00 C17 resolution: "**10's split:** Esc = pause at the step boundary, Esc Esc/Ctrl-C = abort, Ctrl-C twice = exit."
- 10 §15.4: "Esc = gentle, Esc Esc = hard, Ctrl-C = hard, Ctrl-C twice = `process.exit` as today" and "The process does
  **not** exit after a run stops in the interactive TUI; the composer becomes active".
- 06 §17.1: "`C-c` (1st) | Interrupt the running step (`engine.abort` is too coarse — add `engine.interrupt()` → steer);
  if idle and composer non-empty, clear composer" / "`C-c` (2nd within 1.5 s, or when idle+empty) | `human_abort`:
  checkpoint, exit 130".
- `docs/DESIGN.md` §11 (read 2026-09-20): "130: `human_abort` (Ctrl-C) or `SIGINT`; 143: `SIGTERM`; after the checkpoint
  is written." and "(a) Ink `useInput` on Ctrl-C → `shutdown('human_abort')` (under raw mode the kernel never delivers
  SIGINT, so this is the only Ctrl-C path while the TUI is mounted)" and "Any further Ctrl-C byte or SIGINT/SIGTERM while
  `aborting` is set, or expiry of the 5 s bound, writes `state.json` synchronously … and calls `process.exit(exitCode)`
  immediately".
- `src/tui/App.tsx` lines 128–131 today: `if (key.ctrl && input === 'c') { onAbort('human_abort'); return; }` — every
  Ctrl-C, regardless of state, aborts.

**Verdict: VERIFIED.** Four incompatible readings coexist: (i) A18/06: first Ctrl-C on an empty composer = abort *and*
exit 130; (ii) A54/10: abort does not exit in session mode, second Ctrl-C exits; (iii) 06 §17.1: first Ctrl-C during a
run is a *steer* (`engine.interrupt()`), not an abort; (iv) DESIGN §11 + `App.tsx`: any Ctrl-C = `shutdown('human_abort')`
= exit 130 once the checkpoint is written. C17 only settles the live-run case. No file enumerates the matrix
{idle-empty, idle-text, live-empty, live-text, review pending} × {one-shot `jevcode run`, session `jevcode`}.

**Proposed matrix (to be decided; recorded here so the design can accept or amend it):**

| State | Mode | 1st Ctrl-C | 2nd Ctrl-C within window | Exit code |
| --- | --- | --- | --- | --- |
| idle, composer empty | session | print "press Ctrl-C again to exit" hint on the status line | exit (no run to checkpoint) | 0 |
| idle, composer text | either | clear draft → history | as idle-empty | — |
| live run, composer empty | one-shot | `shutdown('human_abort')` → checkpoint → exit | `process.exit` immediately (DESIGN §11) | 130 |
| live run, composer empty | session | `engine.abort('human_abort')` → checkpoint → `run:end` in `<Static>`, composer active, **no exit** | exit | 130 only if exiting |
| live run, composer text | either | clear draft (never abort while text is present) | as live-empty | — |
| review pending | either | decline the review *and* abort (a pending confirm is inside a live run) | `process.exit` | 130 |

The window (1 s Codex, 1.5 s 06, 3 s Gemini) stays open; the one non-negotiable is DESIGN §11's rule that a Ctrl-C while
`aborting` is set exits immediately.

---

## 5. Height-budget numbers (A10 vs A107 vs A53 vs §1)

**Numbers and where each came from (verbatim).**
- Composer **1–6**: 00 A10 "Composer 1–6 rows inside `rows − 2`"; 08 §12 A7 "Keep the `rows − 2` budget; composer 1–6
  rows inside it; decisions pane shrinks first"; 08 §11 benchmark used a "bordered 6-row composer".
- Composer **≤ 8**: 00 A107 "composer ≤ 8 + queue ≤ 3 + decisions ≤ 12 + status 1 ≈ 24 rows"; 04 §14 Q4 "Realistic
  dynamic-region size: composer (1–8 rows) + queue preview (≤ 3) + decisions pane (≤ 12)".
- Queue **≤ 2**: 00 A53 "queued lines above the composer ≤ 2 rows"; 10 §15.3 "height budget (≤ 2 rows,
  `wrap="truncate"`, the decisions pane shrinks first)".
- Queue **≤ 3**: 04 §14 Q4 above; 02 §9 "prompt box (1–N rows, capped), queue list (≤ 3 rows), status line (1)".
- Queue **≤ 2–3**: 00 §1 only (a merge of the two).
- Review box **up to 16**: 11 §5 "confirm 8 + preview 8 = 18 → pane 4" at rows 24 (header 8 = "title, keys, ruler, 4
  gauges, matches_intent").

**Arithmetic.** §1's shape at 24 rows (budget `rows − 2` = 22): live 2 + pane 12 + review 16 + queue 3 + composer 6 +
status 1 = **40**, plus the rule/tab-header row 11 §5 counts = **41**. With no review pending: 2 + 12 + 3 + 6 + 1 (+1) =
**24–25**, still over 22. 11 §5's own table never includes a composer row at all (its columns are today's monitor:
status, rule, live, confirm, pane), and 05 §17 Q1 already warned "confirm (≤ 8+header) a 5-row composer overflows a
24-row terminal; which pane shrinks first".

**Verdict: VERIFIED.** The summary carries three composer caps (1–6, ≤ 8, "1 growing to 5–6" in Q8), three queue caps
(≤ 2, ≤ 3, ≤ 2–3), and a §1 shape that exceeds the budget at 24 rows with or without a review. It is consistent only
if read as "each component's *maximum*, never simultaneously", which §1 does not say. Q8 (allocation order and who
yields) is the missing rule; until it exists, A107's benchmark spec ("≈ 24 rows") also exceeds the 22-row budget it
is supposed to model.

**Correction:** one cap set in §1/A10/A53/A107 — composer 1–6 (8 only when `rows ≥ 40`), queue ≤ 2, pane ≤ 12,
review = header 8 + preview ≤ 8 — and an explicit yield order (pane → live → preview → queue → composer-to-1), with the
24-row worked example: no review: 1 status + 1 rule + 2 live + 2 queue + 6 composer = 12 → pane 10; review pending:
1 + 1 + 0 live + 8 header + 2 queue + 1 composer (collapsed) = 13 → preview 8 → pane 1 → preview shrinks to 7, pane 2.

---

## 6. `"private": true` and LICENSE in the publish plan (A65, 09 §11.1)

**Repo facts (read 2026-09-20).** `package.json`: `"license": "MIT",` `"private": true,` `"files": ["bin", "dist",
"README.md", "docs"]`. `ls LICENSE*` → "no matches found".

**npm docs** (`https://docs.npmjs.com/cli/v11/configuring-npm/package-json`, 2026-09-20): "If you set `"private": true`
in your package.json, then npm will refuse to publish it." and "Certain files are always included, regardless of
settings: `package.json`, `README`, `LICENSE` / `LICENCE`, The file in the "main" field, The file(s) in the "bin" field".

**What the research files say.**
- 09 §11.1 manifest block: no `private` key (omitting it is the fix, but the block does not say so).
- 09 §11.1 rationale paragraph (verbatim): "Drop `"private": true` when publishing; keep `.npmrc engine-strict=true
  save-exact=true` for contributors." and the manifest comment: "add a LICENSE file: the repo has none (ls LICENSE* →
  no match, 2026-09-20); npm always includes it".
- 09 §11.7 release checklist and 00 A65: neither mentions `private`; A65 says "add a `LICENSE`".

**Verdict: PARTIALLY REFUTED.** The claim "09 §11.1's proposed manifest never mention[s]" `private` is wrong for 09
(it does, in prose directly under the block) and right for 00 A65 and 09 §11.7. LICENSE is noted in both. Correction:
add "remove `"private": true` (npm refuses to publish otherwise) and commit `LICENSE`" to A65 and to the §11.7
checklist, with a CI gate `test "$(npm pkg get private)" = "{}"` before `npm publish`.

---

## 7. "Heuristic secret filter (`sk-…`, `ghp_…`)" as future work (P19, C19, 05 §17 Q8)

**`src/core/redact.ts` (read 2026-09-20), verbatim:**
```ts
export const PATTERN_MARKER = '[REDACTED:pattern]';
const FORMAT_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g,
];
const HEADER_PATTERN = /(authorization:\s*bearer|x-api-key:)\s*(?!\[REDACTED:)\S+/gi;
/** Format-pattern redaction only; safe to use before `resolveConfig()` has run. */
export function patternRedact(s: string): string { … }
```
Header comment: "There is deliberately no generic long-token rule: 40-hex git SHAs, npm integrity hashes and base64
blobs are ordinary output for a coding agent and must survive intact." Tests: `test/unit/config/redact.test.ts` lines
37–49 assert redaction of `sk-or-v1-…`, `sk-ant-api03-…`, `sk-proj-…`, `AIzaSy…`, `ghp_…`, `gho_…`, `ghs_…`,
`github_pat_…`, and line 70 asserts `'sk-short'`, `'ghp_short'`, `'AIzaTooShort'`, a SHA and `'authorization: none'`
survive. `patternRedact` is used by `src/config/resolve.ts` and `src/perf/step-overhead.ts`.

**Coverage table.**

| Token family | In `redact.ts`? | Note |
| --- | --- | --- |
| OpenRouter `sk-or-v1-`, Anthropic `sk-ant-`, OpenAI `sk-`/`sk-proj-`/`sk-live_`/`sk-test_` | yes | lookbehind forbids an alphanumeric before `sk-` |
| Google `AIza` (39 chars) | yes | |
| GitHub `ghp_` `gho_` `ghu_` `ghs_` `ghr_` (≥ 36) and `github_pat_` | **yes** | `gh[pousr]_` — the summary's "`ghp_…` future work" is already shipped |
| `Authorization: Bearer …`, `x-api-key: …` header values | yes | name kept, value replaced |
| AWS `AKIA`/`ASIA`… (16 upper/2–7) | **no** | gitleaks/trufflehog rule quoted in 16 §2 |
| PEM `-----BEGIN … PRIVATE KEY-----` | **no** | |
| JWT `eyJ….eyJ….` | **no** | |
| GitLab `glpat-`, npm `npm_`, Slack `xox[baprs]-` | **no** | |

**Verdict: REFUTED.** P19/C19/05 §17 Q8 describe as future work a filter that exists, is tested, and already covers
`ghp_`. The open item is narrower: whether to add AWS, PEM, JWT (and `glpat-`/`npm_`/`xox`) patterns to
`FORMAT_PATTERNS`, mindful of the header comment's false-positive policy. 16 §1.1 (written 12:19, after the summary at
11:50) already says: "None of them cites `patternRedact`, which is that heuristic." The history file (A60) should call
`createRedactor(secrets).redact`, which applies the exact set *then* `patternRedact`.

---

## 8. OSC 52: "VS Code 1.93 (June 2024 addon)" (§5.7, §6, 07 §2.5, 12 §9)

**Primary sources (all 2026-09-20).**
- `https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_91.md`: front-matter `Date:
  2024-7-3`, heading `# June 2024 (version 1.91)`, section "### Support for copy and paste escape sequence (OSC 52)":
  "The Operating System Command (OSC) 52 escape sequence is now supported. This can be used by anything running in the
  terminal but the primary use case is clipboard access for `tmux`."
- `https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_93.md`: `Date: 2024-9-5`, heading
  `# August 2024 (version 1.93)`; `grep -i 'OSC 52\|clipboard'` → no hits.
- `https://raw.githubusercontent.com/microsoft/vscode/1.91.0/package.json` line 85: `"@xterm/addon-clipboard":
  "0.2.0-beta.4",`; the same grep on tag `1.90.0` finds no `addon-clipboard`.
- GitHub API `pulls/214262`: title "Support for OSC52 clipboard access", `merged_at` 2024-06-06T15:03:39Z, milestone
  "June 2024"; `issues/193508` "Request for OSC52 escape sequence character support for terminal", closed
  2024-06-06T15:03:40Z, milestone "June 2024".
- can-i-use-terminal (`https://can-i-use-terminal.github.io/features/osc52copy.html`, table row parsed from the HTML):
  "VSCode Terminal | … | Supported since v1.93", linking issue #193508 and PR #214262 — i.e. the same PR that shipped in
  1.91. This is the source of 12 §9's "VS Code ≥ 1.93".

**Verdict: REFUTED.** OSC 52 write landed in VS Code **1.91** (June 2024 iteration, released 2024-07-03) via
`@xterm/addon-clipboard@0.2.0-beta.4`; 07 §2.5's "June 2024 via `@xterm/addon-clipboard`" is right, 12 §9's "≥ 1.93"
(from can-i-use-terminal) and 00 §5.7's hybrid "1.93 (June 2024 addon)" are wrong. Correction: "VS Code ≥ 1.91
(2024-07-03)". Also note for the matrix: the 1.91 note says nothing about Remote-SSH; 07's "silently ignored when
connected via Remote SSH" rests on `vscode-remote-release#11475` (secondary) and stays as is.

---

## 9. Kitty keyboard protocol adoption dates (§5.7, §6, 07 §1.2)

**xterm.js PR #5600** (`https://github.com/xtermjs/xterm.js/pull/5600`, 2026-09-20): title "Implement kitty keyboard
protocol (CSI =|?|>|< u)", author Tyriar, "merged commit 91c4761 into xtermjs:master on Jan 10, 2026". **VERIFIED.**

**VS Code 1.109** (`https://raw.githubusercontent.com/microsoft/vscode-docs/main/release-notes/v1_109.md`, 2026-09-20):
`Date: 2026-02-04`, heading `# January 2026 (version 1.109)`; highlights bullet "Kitty keyboard support is now available
to all users"; Terminal section: "**Setting**: `setting(terminal.integrated.enableKittyKeyboardProtocol)`" and "The
[Kitty keyboard protocol](…) has been implemented and will be rolling out to stable this release." and "This requires
the program running in the terminal to support the protocol and request to enable it when it runs. A big benefit you
will see immediately is shift+enter should work in some agentic CLIs without the need to run something like
`/terminalSetup`." Date **VERIFIED**; the notes never say "default true".

**Setting default, read from source at release tags** (`src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts`,
`raw.githubusercontent.com/microsoft/vscode/<tag>/…`, 2026-09-20):

| Tag | `default` | `tags` | extra |
| --- | --- | --- | --- |
| 1.109.0 (commit bdd88df) | **`false`** | `['experimental', 'advanced']` | `experiment: { mode: 'auto' }` (server-side rollout) |
| 1.110.1 | `true` | — | (1.110.0 tag does not exist: HTTP 404) |
| 1.111.0 … 1.117.0 | `true` | `['advanced']` | |
| `main` | `true` | `['advanced']` | description now reads "This can, for example, enable `Shift+Enter` to be handled by the program." |

**Verdict for "1.109 default true": REFUTED.** In 1.109 the schema default was `false` and the feature was turned on by
an A/B experiment ("rolling out"); the default flipped to `true` in 1.110 (tag 1.110.1). For the matrix write "VS Code
1.109 (experiment) / ≥ 1.110 default on". One more sentence from the 1.109 notes matters for 07 §1.2's characterisation
of VS Code as a terminal that "speaks CSI u unprompted": VS Code says the program must "request to enable it when it
runs" — i.e. it is a normal kitty implementation (nothing arrives in CSI u until the app pushes flags); Shift+Enter in
VS Code *without* the app pushing flags comes from the `/terminal-setup` keybinding (`\x1b\r`, 02 §3.1), not the protocol.

**Windows Terminal Preview 1.25.** GitHub REST `releases` (2026-09-20): `v1.25.622.0`, `published_at`
2026-03-05T21:34:29Z, name "Windows Terminal Preview v1.25.622.0", body: "It sports a new search experience inside the
Settings page, the ability to edit actions, command palette entries and key bindings with a rich editor--rather than
just their key bindings--support for Kitty's keyboard protocol and two completely new community translations!" and
"* Windows Terminal now supports the Kitty Keyboard Protocol, which allows applications to receive the state of modifier
keys, disambiguate <kbd>Esc</kbd> from <kbd>Ctrl+[</kbd>, and more (#19817)". Follow-up `v1.25.923.0` (2026-04-03):
"* Disabling the Kitty Keyboard Protocol in the Settings now actually works (#19995)" (so it is on by default and has a
toggle). Dev blog (`https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-25-release/`, page dated
"March 6, 2026"): "Windows Terminal now ships with built-in support for Kitty 's Keyboard protocol, which allows
commandline applications to disambiguate keys such as Esc from Ctrl+[ and receive information about which modifiers
were pressed." **VERIFIED** (2026-03-05 UTC on GitHub; 03-06 on the blog).

---

## 10. Trusted publishing: "npm ≥ 11.5.1, Node ≥ 22.14" (A72, 09 §9)

**Primary sources (2026-09-20).**
- `https://docs.npmjs.com/trusted-publishers/`: "Trusted publishing requires npm CLI version 11.5.1 or later and Node
  version 22.14.0 or higher." "When you publish using trusted publishing from GitHub Actions or GitLab CI/CD, npm
  automatically generates and publishes provenance attestations for your package." "This automatic generation only
  applies when all of these conditions are met: Publishing via trusted publishing (OIDC); Publishing from a public
  repository; Publishing a public package". "Provenance generation is not supported for private repositories, even when
  publishing public packages."
- `https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/` (2025-07-31):
  "This feature requires npm CLI v11.5.1 or later." "When using trusted publishing, npm CLI publishes provenance
  attestations by default. The `--provenance` flag is no longer needed." (No Node requirement stated there.)
- `https://github.com/npm/cli/releases/tag/v11.5.1`: released July 24, 2025; sole fix "provenance should only default
  for oidc" (#8457). `raw.githubusercontent.com/npm/cli/v11.5.1/package.json` → `"engines": { "node": "^20.17.0 ||
  >=22.9.0" }`. `registry.npmjs.org/npm/latest` → 12.0.2, engines `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Node changelogs (`raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V22.md`, `…_V24.md`): every
  Node 22 npm bump is 10.x — the last is "deps: upgrade npm to 10.9.8" in 22.22.3 (2026-05-13); 22.23.0/22.23.1/22.23.2
  (2026-06-18/06-23/07-29) carry no npm bump. In V24, "deps: upgrade npm to 11.5.1 (npm team) #59199" is under
  "2025-07-31, Version 24.5.0 (Current)"; 24.21.0 (2026-09-08) bundles npm 11.19.0.
- This machine: `node --version` → v22.23.2; `npm --version` → **10.9.8**.

**Verdict: VERIFIED** (the quoted requirement is exact) **with a material addendum:** no Node 22.x LTS bundles npm ≥
11.5.1, so on the pinned 22.23.2 a publish job must `npm install -g npm@11` (11.5.1 accepts `>=22.9.0`) or run the
publish step on Node 24 (≥ 24.5.0). `.nvmrc` = 22.23.2 stays correct for runtime/tests; 09 §11.7 should add the npm
upgrade step and a `npm --version` assertion (`≥ 11.5.1`) before `npm publish`.

---

## 11. tmux 3.7: DECRQM 2026, synchronized output, `escape-time` 500 ms (A80, §5.8, §6, 07 §2.1/§1.5)

**Primary: `https://raw.githubusercontent.com/tmux/tmux/master/CHANGES`** (4,427 lines, 2026-09-20), section
`CHANGES FROM 3.6b TO 3.7`, verbatim:
- "* Respond to DECRQM 2026 (from David Turnbull in issue 4887) and various others (from Ayman Bagabas in issue 5118)."
- "* Reduce request timeout to 500 milliseconds to match the extended escape-time, and discard palette requests if
  receiving a reply for a different index."
- "* Extend escape timeout if there are active forwarded requests not just tmux's own requests (issue 4793)."
- "* Add support for applications to use synchronized output mode (DECSET 2026) to prevent screen tearing during rapid
  updates (from Chris Lloyd in issue 4744)."
Related: `CHANGES FROM 3.4 TO 3.5`: "* Reduce default escape-time to 10 milliseconds." `CHANGES FROM 3.7a TO 3.7b`:
"* Fix so that the end of a synchronized update again triggers a redraw." `CHANGES FROM 3.7c TO 3.8`: "* Fix redraw
issues around synchronized updates, copy mode, tabs, padding, status lines, menus, popups, wide characters and floating
panes."

**Release dates** (GitHub REST `repos/tmux/tmux/releases`, 2026-09-20): 3.6b 2026-05-20; **3.7 2026-06-26**; 3.7a and
3.7b 2026-07-01; 3.7c 2026-08-17; 3.8-rc 2026-09-09.

**Where the 500 ms lives** (`raw.githubusercontent.com/tmux/tmux/3.7/tty-keys.c` lines 969–984 and `input.c` line 75):
```c
delay = options_get_number(global_options, "escape-time");
if (delay == 0)
        delay = 1;
if ((tty->flags & TTY_BRACKETPASTE) && tty_keys_partial_paste_end(buf, len)) {
        log_debug("%s: increasing delay (partial paste end)", c->name);
        if (delay < 500)
                delay = 500;
}
if ((tty->flags & (TTY_WAITFG|TTY_WAITBG) ||
    (tty->flags & TTY_ALL_REQUEST_FLAGS) != TTY_ALL_REQUEST_FLAGS) ||
    !TAILQ_EMPTY(&c->input_requests)) {
        log_debug("%s: increasing delay (active query)", c->name);
        if (delay < 500)
                delay = 500;
}
```
`#define INPUT_REQUEST_TIMEOUT 500` (input.c). So "500 ms while requests pending" is a *floor on escape-time* (default 10
ms) applied while (a) tmux's own startup queries (fg/bg colour, device attributes) are unanswered, (b) an application's
forwarded request is outstanding, or (c) a bracketed paste end marker is split — plus a matching 500 ms request timeout.

**Verdict: VERIFIED** against CHANGES and source; **UNVERIFIED locally** — `tmux` is not installed (`command not found`),
no Homebrew, and building from source needs libevent/ncurses headers not present; the summary's own §5.3 row says
"`tmux` absent". Corrections: (1) §5.7's "tmux 3.7 (`DECRQM 2026` response)" conflates two 3.7 items — DECSET 2026
support (issue 4744) and the DECRQM 2026 reply (issue 4887); list both. (2) Add "≥ 3.7b" wherever 2026 inside tmux is
trusted, because 3.7/3.7a had "end of a synchronized update" not triggering a redraw. (3) For JevCode's Esc handling
(07 §1.5, 30 ms re-buffer): inside tmux an `ESC` typed while any query is outstanding is held up to 500 ms by tmux
itself, so a DA1/kitty handshake issued by JevCode delays Esc delivery for its duration — one more reason to keep
handshakes out of v1 (07 §1.2 decision) and never to issue OSC 11.

---

## 12. Notification timing: "~6 s idle" for a pending review, "~60 s" after run end (A85, 02 §5.2, §7.3)

**Primary: `https://code.claude.com/docs/en/hooks.md`** (329,656 bytes fetched with curl, 2026-09-20), verbatim:
- Table row: "`permission_prompt` | Claude needs you to approve a tool use or a sandboxed command's network request, and
  the prompt has waited about six seconds"; "`idle_prompt` | Claude finished responding about 60 seconds ago and you
  haven't typed since"; "`elicitation_dialog` | An MCP server opens an elicitation form and you haven't typed for about
  six seconds".
- "The `permission_prompt`, `idle_prompt`, `elicitation_dialog`, and `elicitation_url_dialog` types share their timing
  with desktop notifications, so in terminal sessions you only see them when you appear to be away from the terminal:"
- "* Expect `permission_prompt` once you haven't typed for about six seconds. The timer starts when the permission prompt
  appears, and each keystroke defers it. To run a hook immediately when Claude asks for permission to use a tool, use
  PermissionRequest instead."
- "* Expect `idle_prompt` about 60 seconds after Claude finishes responding, and only if you haven't typed since."
- SDK-hosted sessions differ: "Expect `permission_prompt` about six seconds after Claude asks for permission. Claude Code
  doesn't defer it while you type."
- PermissionRequest section: "Claude Code runs a Notification hook with the `permission_prompt` type only after the prompt
  has waited about six seconds."

**`https://code.claude.com/docs/en/terminal-config`** (2026-09-20): "When Claude finishes a task or pauses for a
permission prompt, and you appear to be away from the terminal, it fires a notification event. See when each
notification type fires for the exact timing." and "By default Claude Code sends a desktop notification only in Ghostty,
Kitty, and iTerm2. In other terminals, set `preferredNotifChannel` to `"terminal_bell"`".

**Verdict: VERIFIED.** Both numbers are in docs:hooks, exactly as 02 §5.2/§7.3 quoted them. Clarification the summary
should carry: the ~6 s is an **idle gate with debounce semantics** in terminal sessions (timer starts when the prompt
appears; every keystroke restarts it), a **fixed delay** only in SDK-hosted sessions; the 60 s is post-response idle,
also cancelled by typing. For JevCode: start the review-notification timer when the *deferred* review box appears (A39
defers it until the composer has been idle ~1 s), restart on any key, fire at ~6 s; start the run-end timer at
`run:end`, cancel on any key, fire at ~60 s.

---

## 13. Measurements made today (all 2026-09-20, this machine: macOS Darwin 25.6.0, Node v22.23.2, npm 10.9.8)

| What | Result | How |
| --- | --- | --- |
| 0×0 pty sizes | `stdout.columns/rows` 0/0; Node `getWindowSize()` `[0,0]`; `terminal-size` `{0,0}`; Ink `getWindowSize` `{80,24}` | `/tmp/jevverify/pty0.py` (`pty.fork` + `TIOCSWINSZ`) → `/tmp/jevverify/size.mjs` |
| 0×0 pty + `COLUMNS=100 LINES=30` | `terminal-size` `{100,30}`; Ink `{100,30}`; Node still `[0,0]` | same |
| 20×5 pty | all three agree `20×5` | same |
| Pipe (no tty) | Node `getWindowSize` absent; `terminal-size` and Ink `{80,24}` | `node size.mjs \| cat` |
| Alt-screen / mouse mentions per file | table in §1 | `grep -ci` over 01–12 |
| `tmux` present? | no (`command not found`); `brew` also absent | `which tmux; tmux -V` |
| Bundled npm on Node 22.23.2 | 10.9.8 | `npm --version` |
| VS Code kitty default per tag | 1.109.0 `false`+experiment; 1.110.1–1.117.0 `true` | `curl` of `terminalConfiguration.ts` at 9 tags |
| VS Code `@xterm/addon-clipboard` first appearance | 1.91.0 (`0.2.0-beta.4`); absent in 1.90.0 | `curl` of `package.json` at both tags |

---

## ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| V1 | Reword 00 §1: alt-screen rejected by every file that discusses it (9/12), mouse by every file that discusses it (5/12) | 09/10/11 are silent; "all twelve" is unsupported | §1 table; grep 2026-09-20 |
| V2 | Attribute "dropped `<Static>`, rewrote renderer" to the HN first-person comment (02 §2.2) and keep U2 open | The two propositions differ; the design does not depend on U2 | hn.algolia.com items 46701013/46701325 (2026-09-20) |
| V3 | Never read `process.stdout.columns`/`rows` for layout; use Ink's `useWindowSize()`; add a 0×0-pty unit test asserting the rule width is 80 | Node reports 0 while Ink renders 80×24 | `ink/build/utils.js`; measurement §13 |
| V4 | Write the Ctrl-C matrix (§4 proposal) into the design; keep DESIGN §11's "second Ctrl-C while aborting → `process.exit`" invariant | Four incompatible readings today; `App.tsx` aborts on any Ctrl-C | A18/A54/C17; 10 §15.4; 06 §17.1; DESIGN §11 |
| V5 | One cap set: composer 1–6 (8 at ≥ 40 rows), queue ≤ 2, pane ≤ 12, review 8 + ≤ 8; explicit yield order pane → live → preview → queue → composer; worked 12/24/40-row examples | §1 shape is 40–41 rows vs a 22-row budget | 08 §11/§12 A7; 04 §14 Q4; 10 §15.3; 11 §5 |
| V6 | Release checklist: delete `"private": true`, commit `LICENSE` (MIT), CI gate `npm pkg get private` = `{}` and `npm pack --dry-run` file list | npm "will refuse to publish" a private package | package.json; docs.npmjs.com package-json (2026-09-20) |
| V7 | History/steer/notes redaction = `createRedactor(secrets).redact` (exact set + `patternRedact`); open a small PR adding AWS `AKIA/ASIA`, PEM, JWT, `glpat-`, `npm_`, `xox[baprs]-` to `FORMAT_PATTERNS` with negative tests per the header-comment policy | `ghp_`/`sk-` already covered and tested; AWS/PEM/JWT are not | `src/core/redact.ts`; `test/unit/config/redact.test.ts` |
| V8 | Matrix: OSC 52 write "VS Code ≥ 1.91 (2024-07-03)" | 1.91 notes + PR #214262 + `addon-clipboard` in 1.91.0 | vscode-docs v1_91.md; vscode 1.91.0 package.json |
| V9 | Matrix: kitty "VS Code 1.109 experiment-gated, ≥ 1.110 default on"; "Windows Terminal Preview 1.25.622.0 (2026-03-05), toggle fixed in 1.25.923.0" | 1.109.0 source `default: false`; 1.110.1 `true` | terminalConfiguration.ts at tags; microsoft/terminal releases API |
| V10 | Publish job: `npm install -g npm@11` (or Node 24 ≥ 24.5.0 for that job only) + assert `npm --version ≥ 11.5.1`; keep `.nvmrc` 22.23.2 | No Node 22 bundles npm 11; 22.23.2 ships 10.9.8 | nodejs CHANGELOG_V22/V24; docs.npmjs.com trusted-publishers |
| V11 | Matrix: "2026 in tmux ≥ 3.7b (3.7 2026-06-26; redraw fix 3.7b 2026-07-01)"; note the 500 ms escape-time floor while queries are pending as one more reason for no startup handshakes in v1 | CHANGES + `tty-keys.c` | tmux CHANGES; tmux 3.7 source |
| V12 | Notification timers: review → start when the deferred box appears, restart on keystroke, fire ~6 s; run end → start at `run:end`, cancel on keystroke, fire ~60 s | Matches docs:hooks semantics exactly | code.claude.com hooks.md (2026-09-20) |

## REJECT

| # | What not to do | Why |
| --- | --- | --- |
| X1 | Keep "rejected by all twelve files" | Three files never discuss it; the claim invites a reader to look for a row that does not exist |
| X2 | Treat "VS Code 1.109 default true" as the v1.x kitty-handshake trigger | The 1.109 default was `false` behind an experiment; use "≥ 1.110" and detect at runtime (DA1 + `CSI ? u` reply), never by version string |
| X3 | Cite "VS Code 1.93" for OSC 52 | Wrong by two releases; can-i-use-terminal's version field is unreliable — verify against the PR milestone |
| X4 | List `ghp_`/`sk-` filters as future work | Already implemented and tested in `src/core/redact.ts`; the real gap is AWS/PEM/JWT |
| X5 | Assume Node 22 LTS CI can run `npm publish` with trusted publishing unmodified | Bundled npm is 10.9.8; publish fails the 11.5.1 requirement |
| X6 | Publish with the current `package.json` | `"private": true` blocks it; `files` ships `docs/` and a 2.5 MB map; no LICENSE file |
| X7 | Ship the §1 layout (live 2 + pane 12 + review 16 + queue 3 + composer 6 + status 1) | 40–41 rows on a 22-row budget → Ink overflow → `ESC[2J` per keystroke (08 §11: 29,765 B) |
| X8 | Read `process.stdout.columns` in composer/rule code | 0 in a 0×0 pty; Ink's helper already falls back to `COLUMNS`/`LINES` then 80×24 |
| X9 | Build tmux from source on this machine to "confirm locally" | No libevent/ncurses headers; not a project dependency; CHANGES + tagged source are the primary record |
| X10 | Model the 6 s notification as a fixed delay | It is an idle gate deferred by keystrokes in terminal sessions |
| X11 | Trust 2026 inside tmux 3.7/3.7a | 3.7b's "end of a synchronized update again triggers a redraw" fix |

## OPEN QUESTIONS

1. **Ctrl-C matrix decision.** Accept §4's proposal or amend it — in particular whether a first Ctrl-C during a live run
   in *session* mode aborts (10 §15.4) or steers (06 §17.1), and whether a Ctrl-C with a review pending declines *and*
   aborts. Whatever is chosen must keep DESIGN §11's exit-130-after-checkpoint for the one-shot path.
2. **Height allocation (Q8).** Confirm the cap set and yield order in V5; decide whether the review box collapses the
   composer to one row (proposed) or hides the queue first.
3. **Redaction patterns.** Add AWS/PEM/JWT/`glpat-`/`npm_`/`xox` to `FORMAT_PATTERNS`? PEM blocks and JWTs can appear
   legitimately in coding-agent output (test fixtures); the header-comment policy ("ordinary output … must survive")
   argues for JWT and AWS (both high-precision) and against a bare PEM rule without the `PRIVATE KEY` literal.
4. **History default (C19)** remains open; V7 fixes only the mechanism.
5. **VS Code and CSI u.** 07 §1.2 describes VS Code (setting on) as a terminal that "speaks CSI u unprompted"; VS Code's
   notes say the program must "request to enable it". Re-test with a real VS Code ≥ 1.110 pty: does anything arrive in
   CSI u form before JevCode pushes flags? If not, the composer's `[27;2;13~`/`[13;2u` leak filter is only needed after
   an explicit push.
6. **Publish job runtime.** Node 24 (≥ 24.5.0) for the publish job only, or `npm i -g npm@11` on 22.23.2? npm 12.0.2's
   engines (`^22.22.2 || ^24.15.0 || >=26.0.0`) allow either; the Node-24 route avoids a global install step in CI.
7. **Windows Terminal stable.** Only the Preview channel (1.25.x) was checked; confirm which stable release carries kitty
   before writing "Windows Terminal ✅" without "Preview" in the matrix.
8. **tmux local verification.** When a machine with tmux ≥ 3.7b is available: `printf '\e[?2026$p'` → expect
   `\e[?2026;2$y` (or `;1`), and measure Esc latency with an outstanding DA1 request to confirm the 500 ms floor.
9. **Notification gate vs A39's 1 s review deferral.** The review box itself is deferred until the composer is idle ~1 s;
   decide whether the ~6 s notification timer starts at the *request* or at the *box appearing* (V12 proposes the latter,
   matching "The timer starts when the permission prompt appears").
10. **can-i-use-terminal as a source.** Its OSC 52 version for VS Code is wrong; audit the other version numbers 12 §9
    took from it (kitty ≥ 0.36.2, Windows Terminal 1.2.2022.0, tmux 2.5) against release notes before the matrix freezes.
