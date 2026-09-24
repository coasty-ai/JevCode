# Judge verdict — lens: user-experience quality and fidelity to the research

Written 2026-09-20 after reading, in full, `docs/research/tui/00-SUMMARY.md` (1,152 lines), the four designs
(`composer-first.md` 1,578 lines, `jev-native.md` 1,484, `minimal-robust.md` 1,597, `sessions-long-horizon.md` 1,513),
the research anchors the designs lean on (11 §4a–4c, §4j, §5; 19 §4, §5; 10 §15.3; 02 §3.5; 06 §17) and the code the
designs must build on (`src/core/types.ts`, `src/tui/App.tsx`, `useEngine.tsx`, `plain.ts`, `Confirm.tsx`, `Decisions.tsx`,
`StatusLine.tsx`, `src/cli/main.tsx`, `args.ts`, `src/loop/engine.ts`, `stop.ts`, `budget.ts`, `plan.ts`, `src/provider/prompts.ts`,
`src/loop/state.ts`, `src/spend/meter.ts`, `src/core/redact.ts`, `src/synth/search/directive.ts`, `node_modules/ink/build/*.d.ts`,
DESIGN §10–§12). Every line number quoted below was re-checked against the working tree today.

Lens questions, in the order they weighed: (1) does the frame feel like the best of opencode / Claude Code / Codex while
putting Jev's decisions in front of the human; (2) are the frames coherent at rows 8/12/24/40/50 and do the allocation
tables agree with the `computeLayout` code; (3) is the keymap learnable and consistent (no key does two things in one
context; no common first letter is stolen); (4) are the `--plain` / `--screen-reader` / `--ascii` twins complete; (5) does the
design honour every ADOPT row and every fixed decision F1–F18, or say why not in one sentence.

Scores (1–10): **composer-first 8 · jev-native 7 · minimal-robust 7 · sessions-long-horizon 6.5**. Winner on this lens:
**composer-first**, with the grafts in §6 mandatory.

---

## 1. composer-first — 8/10

**Why.** It is the only design whose frame behaves the way an opencode / Claude Code user expects from the first
keystroke: the idle session frame is three rows (rule, composer, status; §2.2 "an idle composer with no run costs 3 rows … the
compact idle frame opencode and Claude Code users expect"), the composer grows before anything else and shrinks last, and
the tabbed Jev pane sits on the rule row so tabs cost no row (§2.1). Its `computeLayout()` is a single priority-ordered
`take()` loop (§2.2) whose reverse is exactly F3's yield order; I recomputed every cell of its §2.3 allocation table against the
code and found no disagreement (e.g. rows 8, two queued steers, 3-row draft → composer 3, queue 1, as the table says). The
key-context table (§3.1) is the most complete of the four — it names the `note`, `undo`, `budget`, `blocking`, `pager` and
`history-search` contexts and says what each falls through to — and the interrupt state machine (§3.3) is written as one pure
reducer over `(state, key, nowMs)`, which is what 06 §17 / A17 asked for. The palette (§5.4) is the best Claude-Code-faithful
one: ghost text with `+N`, "Suggested" first, Esc remembers the token (Codex rule), argument completion per `ArgSpec.kind`,
and — the one deviation on this lens that is *right* for JevCode — Enter on a typo keeps the draft instead of starting a paid
run (§22 D1: "in JevCode a submitted line starts a paid run, so a typo must not become a task"). The review box (§6) follows
11 §4b/§4j row for row, adds the `note ›` sub-mode for `d`, and its contract change for the note is the only purely additive
one of the four (`Confirmer.confirmDetailed?` optional, C18). Its F13 list (C1–C24) carries insertion points that all
resolved to real lines today (`planSection` at `prompts.ts:134` really does render `[${h.kind}, step ${h.step}]`; `storedStopBlocks`
is `engine.ts:446`; `stop.ts:15`'s default branch returns 4; `validate.ts:96`; `paths.ts:125`; `seatbelt.ts:18`; `main.tsx:268-275`
answers `--version`/`--help` before Ink). Twins are systematic: every pane is a `lines()` function shared with
`--plain --decisions|--plan|--timing`, the review has plain and SR rows (§6.4), the secret gate has a readline twin (§4.10).
What keeps it from 9: one genuine keymap bug (single letters `d p t s` stolen on an empty composer, §7.1), two undeclared
deviations from F16 (status `step` in the left zone; git zone drawn at 80 columns), a palette that pops mid-prompt after a
space, a missing signature for the session-cap mutation it promises, and one sloppy frame (D).

**Errors (with evidence).**

| # | Error | Evidence |
| --- | --- | --- |
| C1 | Single letters `d`, `p`, `t`, `s` switch pane tabs on an empty composer, so a prompt beginning "do…", "please…", "the tests…", "start…" loses its first letter to a tab switch. | §7.1: "the letter keys switch only when the composer is empty and no box has focus — otherwise they are text". F16 fixes only "'[' and ']' cycle tabs"; 11 §4a's header `[d] decisions [p] plan [t] time` uses the letters as *labels*; A44 lists `d/p/t/s` as tab names and `[`/`]` as the cycle keys. 06 §17 / A17's rule that the composer owns printable keys is broken for four common first letters. |
| C2 | Undeclared deviation from F16's zone layout: `step N/M` is placed first in the *left* zone, not the right zone, and §22 has no row for it. | §7.3: "**left** `step 7/40  ⠹ risk 12s` (sentinel first, always)". F16: "right step/max, wall, run and session cost meters". DESIGN §12 only needs the sentinel to *appear* ("first appearance of the status-line sentinel `step 0/` in the accumulated bytes"), not to lead the row. |
| C3 | Undeclared deviation from F16 on the git zone: frames A, B, D at 80 columns show `⎇ main · 3~ 1?`. | F16: "git zone at >= 100 columns". §7.3 itself says "≤ 24 cells at ≥ 100, ≤ 14 below" (A142's rule), which is the ADOPT row but not the fixed decision. |
| C4 | The palette also opens mid-prompt after a space, so "see /etc/hosts for the mapping" pops a command list. | §5.4: "Opens when `/` is typed at column 0 of an empty composer, or after a space mid-prompt when followed by ≥ 1 letter". F4: "'/' at column 0 opens the palette"; A34 likewise. Not in §22. |
| C5 | `/budget session-spend-cap` "applies to the root meter immediately" but no contract item lets a `SpendMeter` change its cap. | §9.4 vs §15 C9 (`SpendSnapshot.parentExceeded?: boolean` only). `src/spend/meter.ts`: the cap is a closure constant (`const cap = sanitiseCap(capUsd)`), `restore()` restores usage only ("the cap belongs to this run's configuration"), and `child()` binds the parent by reference. F13 asks for exact signatures; jev-native's `SpendMeter.setCap(capUsd)` is the missing item. |
| C6 | Frame D (80×24) grants "preview 8" yet shows four content rows, three blank rows and "…[3 more preview lines · e expands]" — rows are both hidden and left empty. | §2.4 D versus §6.1 "Preview rows (≤ 8 …) are today's `confirmPreviewLines` indented two spaces, last row `…[N more preview lines · e expands]`". `Confirm.tsx` today fills every granted row. |
| C7 | With dimensions sorted by risk (§22 D2), `w`+digit "picks a row 1–5 in the displayed (sorted) order", so the digit for `destructive` changes from review to review. | §6.1. 11 §4j: `w` + digit "for one of the four dimensions or `matches_intent`" — a stable mapping. The sort is a good call for truncation (C7 keeps the dominant row); the digit remap should be reconsidered (fixed digits, sorted rows, digit shown in the row). |

**D1–D15.** Resolved: D1, D2, D4, D5, D6, D7, D8, D9, D10, D11, D13, D14, D15. **Ambiguous: D3** — the
mechanism for the immediate session-cap change has no signature (C5 above). D2 is resolved but the "confirm if a run is live"
clause of F5 for Ctrl-D is satisfied only by the first-press hint (`run live — Ctrl-D again exits after abort`), not an explicit
`y/N`; acceptable, noted.

---

## 2. jev-native — 7/10

**Why.** This is the design that best answers "what is unique about Jev": its `DecisionRow` model (§7.1) attaches to every
decision the code rule that consumed it (`consumedBy`: "band 0.3/0.7 (bound)", "selected iff p ≥ 0.5", "≥ 0.7 accept, < 0.3
reject") and a `near` flag for answers within 0.03 of their threshold, rendered as a `!` before `p` — that is exactly the
calibration-first instinct of 11 §2/§4i and nothing in the other three matches it. Its `/why` block (§7.4) is a worked example
with the level bars, `argmax`, `E[k]`, `P(k≥3)`, the confidence formula and the rule consumed; `/calibration` (§7.5) names its
label sources. In jev-only the pane defaults to the `s` tab during propose and back to `d` otherwise (§7.2) — the one design that
thought about which tab the sieve user needs when. The review deferral (§6.4, `visibleAt = max(now, lastKeystrokeAt + 1000)` plus
a drained-input check, review context entered on the frame *after* the box is drawn) is the most precise reading of A41. Its
contract list is the only one that adds `SpendMeter.setCap()` and it verified a real synth fact (`parseDirective` → `FALLBACK_MOVE`
= `change_approach` at `src/synth/search/directive.ts:104-107`, confirmed) so a human steer works in jev-only without touching
`src/synth`. The §3.3 state diagram is the clearest overview of composer/run/review modes in the four.
What costs it points: its `computeLayout` code contradicts its own allocation table and F3's yield order; Frame 4 turns the
collapsed composer into a "steer draft" while the review keys still capture `y n d e w`; the `d` note has no engine-facing
signature; the idle frame spends twelve pane rows on nine blank lines (the opposite of the compact opencode/Claude Code idle
frame); and there are internal contradictions (chip label; sparkline threshold) that §22 does not own.

**Errors (with evidence).**

| # | Error | Evidence |
| --- | --- | --- |
| J1 | `computeLayout` takes the queue before the composer's growth, so under pressure the composer shrinks *before* the queue — inverting F3 ("queue → composer-to-1") — and the code contradicts the design's own table. | §2.1 code: `L.queue = take(Math.min(s.queue, QUEUE_MAX)); // yields 4th` then `L.composer += take(Math.min(s.composerWant, composerCap(rows)) - 1); // yields last`. A `take()` that runs *later* yields *earlier*. Recomputed at rows 8 (budget 6), 2 queued, 3-row draft: status 1, rule 1, composer 1 → rem 3; queue 2 → rem 1; composer growth gets 1 → composer 2, queue 2. §2.2 table says "1+1+3+queue1 = 6" (composer 3, queue 1). 19 §5 / A109: yield "pane → live → preview → queue → composer-to-1". |
| J2 | While the review box is visible the composer row invites steer text, but the Review context consumes `y n d e w` first, so a steer beginning "yes, but…" approves the action and `d`/`e`/`w`/`n` cannot be typed at all. | Frame 4 composer row: "> review pending — y n d e w answer it; text here is a steer for step 8"; §3.1 precedence "**Review** (while the review box is *visible*, §6.4) → **Composer**"; §8.4 "`y`/`n` while a review is visible are review keys, never steers (Frame 4's composer text is a steer draft)". F3/19 §5: "a pending review collapses the composer to one row" (an inactive row); A41's whole point is that a typed `y` must not approve. |
| J3 | The `d` decline-note has no channel from the confirmer to the engine in the F13 list. | §6.3: "`confirmer.resolve(id, false, note)`. The engine (`confirm()`) records `draft.declineNote = note`"; §15 item 14 changes only `TuiConfirmer.resolve(id, approved, note?)`; `Confirmer.confirm` stays `Promise<boolean>` (`types.ts:299-300`, unchanged in §15). Nothing carries `note` into `engine.ts:1123 confirm()`. |
| J4 | Two different history chip labels. | §4.6: "history (labels only, `[Pasted #1, 120 lines, sha256:9f86d081]`)"; §10: "History chip label = redacted first line ≤ 40 chars + `, k lines` (P58)". F9 fixes the second. |
| J5 | Palette Enter runs on a "unique-prefix match" and otherwise "submits the typed line" — the first is R18's guessed execution, the second starts a paid run on a slash typo. | §5.1: "Enter (runs only on an exact or unique-prefix match, otherwise submits the typed line and reports `unknown command /dif — did you mean /diff?`)". R18: "Typo-tolerant Enter on the `/` menu; hidden commands guessed from partial input" rejected; A34 "Enter runs only on a perfect match". |
| J6 | Sparkline threshold moved from ≥ 100 to ≥ 140 columns without a §22 row. | §7.3: "Jev latency sparkline `jev p50 237ms ▂▃…` … at ≥ 140". F16: "Jev latency sparkline at >= 100 columns". §22 lists the A46 *tokens* deviation but not this one. |
| J7 | Idle frame with no run allocates the full 12-row pane to three hint lines and nine blank rows, pushing the composer to row 14 at 24 rows. | Frame 1 "(15 dynamic rows; 7 spare)": rows 5–13 are empty. 08 §11: every dynamic row is rewritten per keystroke; 01 §2.1 / 02 §3: opencode and Claude Code open on input + one hint. composer-first §2.2 and minimal-robust §2.2 keep this frame at 3 rows. |
| J8 | Undeclared deviation from F16's zones: `step N/M` leads the left zone. | §7.3 "**left** `step N/M` sentinel first (perf gate)". F16 puts step/max in the right zone; DESIGN §12 only needs the sentinel to appear. |

**D1–D15.** Resolved: D5–D11, D13, D14, D15. **Ambiguous: D1** (code vs table, J1), **D2** (review-pending composer text, J2),
**D4** (chip label, J4), **D12** (note path has no `Confirmer` signature, J3). D3 resolved (and best of the four on the meter:
`setCap`). D5 minor: the paid verification step says "one Jev decision ~$0.0001" without naming `decider.model` (F10 fixes it).

---

## 3. minimal-robust — 7/10

**Why.** On coherence at every row count this is the strongest: it is the only design with a review frame at rows **8**
(title, keys, one compact two-dimension row) and a written truncation ladder for the header (`reviewHeaderLines(req, n)`: 8 → drop
the ruler → drop `matches_intent` → compact two-per-row dimension rows with the max dimension first → title + keys), so the box
degrades by design rather than by Ink clipping (§6.1). Its `resolveKey` state machine S0–S7 (§3.3) enumerates Enter and `y` as
rows, which is where approval accidents hide; its one modal slot makes `computeLayout` provable (§2.1), and its allocation table
agrees with its code everywhere I recomputed. It is the only design that gives the `Composer` a `PaneBoundary` fallback ("a
failed `Composer` falls back to a single-row plain input so keys still work", §13.4), the only one that proposes a unit test
checking the widths of the design's own fenced frames (§19.1), and its `--plain` parity discipline is explicit (every tab is
`lines(state, rows, columns)`). It honestly lists sixteen deviations (§22).
What costs it points on *this* lens: it deviates from two **fixed** decisions (chords in the keybindings file, F14; picker
`Ctrl-R`/`x` keys, F7→A56), repeats the single-letter tab-key bug, lets a slash typo start a paid run, makes `/diff` idle-only,
replaces the help overlay with a `<Static>` block (declared, but it is the least Claude-Code-like help of the four), and its
"additive" contract widens an existing method's return type and makes new `run:ready`/`run:end` fields required.

**Errors (with evidence).**

| # | Error | Evidence |
| --- | --- | --- |
| M1 | Single letters `d p t s` on an empty draft select tabs — same first-letter theft as composer-first C1. | §3.2: "`[`, `]` on an empty draft | cycle pane tabs; `d p t s` on an empty draft select". F16 fixes `[`/`]` only; 11 §4a letters are labels. |
| M2 | Chords are deferred, contradicting a fixed decision. | §22 A24: "Keybindings file supports single-key remaps and `"none"` only; chords are deferred". F14: "keybindings file at ~/.config/jevcode/keybindings.json (namespace:action ids, 'none' unbinds, **chords 3 s**, reserved Ctrl+C/D/M/[/I)". |
| M3 | Picker rename and delete keys dropped, contradicting F7's "picker rows and keys per summary A56". | §8.4: "Rename is `/rename`; row delete is deferred (`jevcode sessions prune`)"; picker frame: "x: n/a in v1". A56: "Ctrl-R rename, `x` delete with confirm". (The Ctrl-R clash argument is real — but F7 fixed A56; the fix is a picker-local `r`, not deletion of the feature.) |
| M4 | A slash typo starts a paid run. | §5.1: "Enter runs a command only on an exact name match; otherwise the text is submitted as a prompt and `Unknown command /bx (did you mean /budget?)` is toasted (A34, R18)". A34 is Claude Code's rule for a *chat* message; in JevCode a submitted prompt is `startRun()` (14 §4.3 treats starting a run as a severe-class action). composer-first §22 D1 gives the right correction. |
| M5 | The "additive" contract changes an existing signature and makes new fields on existing events required. | §15 item 6: `confirm(req, opts): Promise<boolean \| ConfirmVerdict>` (today `Promise<boolean>`, `types.ts:300`); item 15: `{ type: 'run:ready'; …; maxReplans: number; …; sessionId: string; parentRunId: string \| null; sandbox: SandboxLevel; noNetwork: boolean }` and `{ type: 'run:end'; result; exitCode: number; resumable: boolean; paths: {…} }` with no `?`. F13: "Engine contract additions are ADDITIVE only". Every existing emitter and `test/fixtures/tui/run-events.json` consumer stops type-checking. |
| M6 | `DECSCUSR` dropped without a §22 row. | §4.3: "`DECSCUSR` is not sent (07 §2.8: terminal-side preference; avoids one more thing to restore)". A3: "DECSCUSR steady bar on start". |
| M7 | `/diff` is idle-only even for the inline stat block, and the git-zone sentence contradicts itself. | §5.2 table: "`/diff [step] [--full] [--all]` | … | **no** | §12.5 (human-only)" — F11 says human-only, not idle-only; 15 §6.6's purpose is seeing what a run changed while it runs. §7.3: "git zone `⎇ main ↑2 · 3~ 1?` at ≥ 100 (≤ 24 cells; ≤ 14 at 80–99; hidden < 60)" — "at ≥ 100" and "≤ 14 at 80–99" cannot both hold. |
| M8 | Help is an appended `<Static>` block, not the two-level overlay; declared, but it is the weakest fidelity point on this lens. | §22 A21; §5.3 "`?`/F1/`/help` append a `<Static>` block (≤ 60 lines)". 06 §17.5 / A21: ShortHelp + FullHelp overlay "inside the budget"; Claude Code `?` toggles an overlay. A 60-line block in scrollback every time a user presses `?` is not what any reference tool does. |

**D1–D15.** Resolved: D1, D2, D4, D6, D7, D8, D10, D11, D13, D14. **Ambiguous: D3** (no cap-mutation signature, item 9 adds
only `parentExceeded()`), **D9** (`/diff` availability stricter than F11), **D12** (non-additive items, M5), **D15** (contradicts
F14 on chords, M2). D5 minor: verification model unnamed.

---

## 4. sessions-long-horizon — 6.5/10

**Why.** For the user this angle serves — hours on one repository, tens of runs — §8 is the best material in any of the four:
the ten-run walkthrough (§8.9) shows, run by run, what the human did, what the engine did, what `state.json`, the index, the
seed and the two meters hold and which exit code the item carries (including the R7 401 → `/login` → R8 seeded from R6 path and
the "seed source = latest run with `step > 0`" rule); `run.lock` with `jevcode sessions unlock` closes 00 §8 item 13; the fold
types (`SessionRow`/`RunRow`, `reindex`), the `v:1` line envelope, the trash-not-`rm -rf` delete, the `/rewind` step picker, the
per-command "Plain" column in the command table, §8.10 backward compatibility, and the two-tabs-side-by-side frame at 50×120
(Frame O) are all things the final design should take. The steering consumption algorithm (§8.6) is the most carefully worded
of the four (`activeHuman` scoped to *this* step; `pendingDirectives` checkpointed so a steer survives a crash).
On the lens questions it is weaker: the allocation table contradicts its own `computeLayout` and F3; the immediate session-cap
change is implemented by recreating the root meter, which silently orphans a live run's child; the "additive" contract makes
new `run:ready`/`run:end`/`PromptInput` fields required; the review frames drop the digit from `[w] why`; the rows-8 review keeps
the ruler instead of the dominant dimension; some line numbers were copied from the summary rather than read from the tree the
preamble claims; and the composer/keymap sections are the thinnest of the four (no Ctrl-D confirm, no note sub-mode detail).

**Errors (with evidence).**

| # | Error | Evidence |
| --- | --- | --- |
| S1 | Allocation table contradicts the code and inverts F3. | §2.2 row "live, 2 queued, 3-line draft | rows 8 (6): 1+2+q2+c1(floor)+st1 = 7 > 6 → live yields to 1" (composer 1, queue 2, live 1). §2.1 code order: `L.composer += take(composerWant - 1)` → `L.queue` → … → `L.live`, which at budget 6 yields composer 3, queue 1, live 0. F3: live yields before the queue and the composer. |
| S2 | `/budget session-spend-cap` recreates the root meter, so a live run's child keeps forwarding to the *old* root and F8's "applies immediately" is not met while a run is live. | §9.4: "the root meter is recreated with the new cap and `restore()`d from its own snapshot, keeping `SpendMeter` frozen". `src/spend/meter.ts`: `child(childCapUsd) { return createSpendMeter(childCapUsd, meter); }` binds the parent by reference; `parentExceeded()` reads that parent; `restore()` "restores this meter only, does not re-add to the parent" (`types.ts`). |
| S3 | Non-additive contract items. | §15 item 10: `run:ready` with `sessionId: string; parentRunId: string \| null; sandbox: SandboxLevel; noNetwork: boolean; maxReplans: number` and `run:end` with `exitCode: number; resumable: boolean; paths: {…}` required; item 17: `PromptInput { humanDirective: { text: string; step: number } \| null }` required; item 19: `Confirmer.confirm(): Promise<boolean \| ConfirmVerdict>`. F13: "ADDITIVE only". |
| S4 | Line numbers copied from the summary, not the tree. | §13.2: "`AskOptions.onRetry` (client.ts 388–391)". `src/jev/client.ts:353` is `await sleep(waitMs, opts.signal);` today (A160's "client.ts:388-391" is the stale source). The preamble promises "Line numbers are those of the working tree read today". |
| S5 | Review keys line omits the digit that F6 fixes. | Frames D and K: `[y] approve  [n] decline  [d] decline+note  [e] expand  [w] why  [esc] decline`. F6: "w+digit (/why for a dimension)"; §6 text does say `w` + `1`–`5`, the frames do not teach it. |
| S6 | At rows 8 the review header keeps the ruler instead of the dominant dimension. | §2.2: "review pending (preview 8) | rows 8: … → hdr 3 (title, keys, ruler)". 11 §4b: the level text of the dominant dimension *is* the "why"; a ruler with no gauge under it carries nothing. minimal-robust §6.1 and composer-first §2.2 keep the dominant row. |
| S7 | Ctrl-D with a live run exits on the second press with no explicit confirmation. | §3.2 live-empty rows: 1st "hint `run is live — Ctrl-D again exits after aborting`", 2nd "abort → exit 130". F5: "second press within 800 ms exits (confirm if a run is live)". jev-native and minimal-robust open a `[y/N]` box; a hint is a weaker reading. |
| S8 | Frame D leaves rows blank inside a granted preview. | Frame D: "(4 more preview lines)" followed by two empty rows and "…[e] expands" in an 8-row preview. |

**D1–D15.** Resolved with depth: D6, D7, D8, D9, D10, D11, D13, D14, D15; D2 mostly resolved (S7 loose). **Ambiguous: D1**
(S1), **D3** (S2 makes "immediately" false for a live run), **D12** (S3). D4, D5 resolved (D5 names `decider.model`).

---

## 5. Cross-design observations on the lens

- **Learnability, shared defect.** Two designs (composer-first, minimal-robust) bind `d p t s` on an empty composer. In a chat
  TUI the empty composer is the *normal* state before every prompt; the first letter of a task must never do anything but insert.
  F16 mandates only `[`/`]`; the final design must bind nothing but `[`, `]`, `/` (column 0), `@` and `?` on an empty composer.
- **Typo → paid run.** Three designs follow A34 literally ("submits the typed text"). A34 was written from Claude Code, where a
  submitted line is a chat message; here it is `startRun()` with a fresh `$2.00` cap. composer-first §22 D1 is the correct
  reading and should be adopted as a summary correction.
- **Review-pending composer.** F3's "collapses the composer to one row" is best read as *inactive* (composer-first, minimal-robust,
  sessions); jev-native's "text here is a steer" reading cannot coexist with single-letter review keys.
- **Status `step` position.** Three designs lead the left zone with `step N/M` and only sessions declares it (§22 A46). The
  perf sentinel needs presence, not position; either follow F16 (right zone) or declare the deviation in every design.
- **Frames.** Only minimal-robust supplies a review frame at rows 8; only composer-first and minimal-robust keep the idle
  no-run frame at 3 rows; only sessions and jev-native show 50×120. Blank rows inside granted previews appear in composer-first D
  and sessions D — a frame should never draw rows it then hides.
- **Twins.** All four state the `lines()` rule; composer-first and minimal-robust spell out the plain flags per tab; sessions
  alone has a per-command "Plain" column (and correctly marks `/copy` and `/theme` as not applicable); jev-native has the best
  `aria-label` wording for gauge rows (§6.5).
- **Contract additivity.** composer-first is the only design whose list is additive throughout (optional fields, optional
  `confirmDetailed?`). The other three either widen `Confirmer.confirm`'s return type or make new event fields required.

---

## 6. Grafts the final design must take (from the non-winners)

| From | What | Why |
| --- | --- | --- |
| jev-native §7.1 | `DecisionRow` with `consumedBy` (the code rule that read the answer) and `near` (|p − threshold| ≤ 0.03 → `!` before `p`); `byStep` map for the last 3 steps so `w`+digit and `/why <digit>` never read disk | This is the single most Jev-specific idea in the four: it tells the reviewer *which rule* a probability fed and when it was a coin-flip (11 §2, §4i). |
| jev-native §7.2 | Default tab `s` while a jev-only step is in propose, `d` otherwise; tab remembered per session | In jev-only the sieve is the only live content (11 §1, A48); the winner does not say which tab is shown when. |
| jev-native §7.4 | The worked `/why` block (level bars, `argmax`, `E[k]`, `P(k≥3)`, bound, confidence formula, rule consumed) as the reference rendering | The winner names the block's fields; jev-native shows the exact text, which is what the `lines()` test needs. |
| jev-native §15 item 8 | `SpendMeter.setCap(capUsd: number): void` (root meter only) | Closes the winner's C5 gap and sessions' S2 flaw: `/budget session-spend-cap` must mutate the *same* root the live child forwards to. |
| jev-native §6.4 | `visibleAt = max(now, lastKeystrokeAt + 1000)` + drained-input check; the review key context is entered on the frame *after* the box is drawn | The most exact statement of A41; the winner's "setTimeout(0) after the last useInput call" is looser. |
| jev-native §3.3 | The composer/run/review state diagram | One picture that the keymap table, the interrupt reducer and the session controller can all be checked against. |
| minimal-robust §6.1 | `reviewHeaderLines(req, n)` truncation ladder: 8 → 7 (drop ruler) → 6 (drop `matches_intent`) → 5..3 (title, keys, compact two-dimension rows, max dimension first) → 2 (title, keys); plus the rows-8 review frame | The winner's review at rows 8 is "box 3 (title, keys, dominant dimension)"; minimal-robust shows all four dimensions surviving down to four header rows and makes the cut a function, not Ink clipping. |
| minimal-robust §3.3 | The S0–S7 `resolveKey` matrix with **Enter** and **`y`** as explicit rows, and the Ctrl-D live-run confirm box `a run is live: [y] abort and exit [n] stay` (Enter inert) | Enumerating Enter/`y` per state is where approval accidents are caught; the explicit box is the literal reading of F5's "confirm if a run is live". |
| minimal-robust §13.4, §19.1 | `PaneBoundary` fallback for the `Composer` (single-row plain input so keys still work); a unit test that measures the widths of the design document's own fenced frames | A dead composer is the one pane failure that strands the user; the width test turns the frames from illustrations into fixtures. |
| minimal-robust §5.3 | "Suggested" palette rows keyed on state (`/resume` after a stop, `/budget` after `spend_cap`, `/login` after 401) | A16/A34's "Suggested first" made concrete; the winner lists categories but not the state-driven suggestion set. |
| sessions §8.9 | The ten-run session walkthrough as the acceptance scenario for the pty/engine integration suite | It exercises follow-up seeding, steer, pause/resume, spend-cap override, abort-and-reopen, `/undo`, 401 → `/login`, the seed-source rule and the session-cap clamp in one table; no other design has an end-to-end scenario. |
| sessions §8.2–8.4, §15 | `v:1` on every index line and stream line; `SessionRow`/`RunRow` fold types; `reindex`; `run.lock` `{ pid, startedAt, host }` with `jevcode sessions unlock <id>` and the picker's `● live` marker; seed source = most recent run with `state.step > 0`; `x` delete = move to `~/.jevcode/trash/`; `PlanSnapshot` for `planAfter` (bounded lists) | Closes 00 §8 items 6 and 13; a reversible delete respects R20's "bench results are research data"; the seed rule handles the R7 (step 0, exit 2) case the winner does not mention. |
| sessions §5.3, §12.5, Frame O | Per-command "Plain" availability column; `/rewind` as a picker of steps with changed files; two tabs side by side at ≥ 120 columns when rows ≥ 40 | The Plain column makes twin completeness auditable; the picker beats typing a step number; 11 §5's side-by-side note is otherwise unused. |
| sessions §8.6 | `activeHuman` scoped to `draft.step` so the directive reaches exactly one step's prompt, common state and `SynthesisContext.directive`, then is cleared at commit; `pause()` idempotent with `pause:requested` event | The winner clears `activeHumanDirective` at commit too, but sessions states the step-equality rule that prevents a directive leaking into a resumed run's next step. |
| sessions §22 | `undoLog` carried into the *next* run's checkpoint via the seed rather than rewriting the finished run's `state.json` | Keeps DESIGN §9 / R21 ("never mutate a committed checkpoint") intact; the winner writes `state.undoLog` into the finished run. |
| all three | Declare the `step N/M` left-zone placement as a deviation from F16 (or follow F16); never bind `d p t s` on an empty composer; palette only at column 0 | Cross-cutting fixes from §5 above. |

---

## 7. Winner

**composer-first**, at 8/10, because on this lens it is the design a user of opencode, Claude Code or Codex can sit down in
front of and use without a manual (three-row idle frame, readline set verbatim, `/` `@` `?` on an empty composer, ghost-text
palette that never starts a run on a typo, queue rows that Up takes back), while still putting the risk gauges, the tabbed Jev
pane and `/why` in the frame exactly as 11 §4a–4j drew them — and because its layout code, its allocation table and its frames
agree with one another and with F3. It must fix C1 (letter keys), declare or revert C2–C4, take jev-native's `setCap` (C5),
redraw Frame D (C6), fix the `w`+digit mapping (C7), and absorb the grafts in §6 — above all jev-native's `DecisionRow`,
minimal-robust's review truncation ladder and rows-8 frame, and sessions' ten-run walkthrough, index/lock schema and seed
rule.
