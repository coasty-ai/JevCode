# Judge verdict — lens: safety and edge cases

Written 2026-09-20 after reading `docs/research/tui/00-SUMMARY.md` (1,152 lines) in full, the four designs in full
(`composer-first.md` 1,578 lines, `jev-native.md` 1,484, `minimal-robust.md` 1,597, `sessions-long-horizon.md` 1,513),
the research files the lens depends on (10 §15, 12 §10, 13 §5, 15 §3/§6.4, 16 §1/§4, 17 §4, 19 §4) and the code the
designs build on (`src/tui/{App,useEngine,plain,Confirm,StatusLine}.tsx|ts`, `src/cli/{main.tsx,args.ts}`,
`src/core/{types,redact,time}.ts`, `src/loop/{engine,stop,budget,state}.ts`, `src/provider/prompts.ts`,
`src/checkpoint/{store,resume}.ts`, `src/config/resolve.ts`, `src/spend/meter.ts`, `src/sandbox/paths.ts`,
`src/jev/client.ts` retry loop, `src/provider/sse.ts` `withRetry`, `docs/DESIGN.md` §6/§9.1/§10/§11/§12,
`node_modules/ink/build/*.d.ts`). Line numbers below are the line numbers of the design files and of today's working
tree.

Lens: secrets at every entry point; the review invariants (never auto-approve); the Ctrl-C/Esc/Ctrl-D matrix and the
DESIGN §11 shutdown invariants; crash and terminal restore; SIGTSTP/SIGHUP; disk errors; provider outages; resize
storms; tiny terminals; undo safety (verify before write, index never touched); budget fail-closed; keys never in logs.
For each design the question was: which state did it forget, and what happens to the user's money, files, keys or
terminal in that state.

Design names: **CF** = composer-first, **JN** = jev-native, **MR** = minimal-robust, **SL** = sessions-long-horizon.

---

## 1. Scores on this lens

| Design | Score | One line |
| --- | --- | --- |
| minimal-robust | **8** | The only design whose key state machine has explicit `aborting` and `pausing` states, whose wizard Ctrl-C checks for a live run, whose Ctrl-Z handles the orphaned-group and shell-termios races, and whose review header has a truncation order that keeps a dimension at rows 8; loses points for a paid run started by a mistyped slash command and for no `run.lock`. |
| composer-first | **7** | The most complete Ctrl-C/Esc/Ctrl-D matrix (13 state rows), a safe review context, and the one design that refuses to turn a slash typo into a paid run (D1); loses points for `/login` mid-run Ctrl-C exiting 2 without a checkpoint, an ambiguous `ui.json` draft rule, no Ctrl-Z fallback and an internal contradiction on the rows-8 review box. |
| sessions-long-horizon | **6** | Best ledger semantics (run.lock with pid liveness, immutable finished checkpoints, `cleanAtStart` on post-images, a ten-run walkthrough that exercises 401/Ctrl-C/spend_cap), but `/exit` during a live run exits 0 with no abort, the session-cap raise orphans the live run's meter, and a slash typo starts a paid run. |
| jev-native | **5** | The richest review semantics (note through the secret gate, paste never a key, key context armed one frame after the box) undermined by one state it forgot: the composer stays editable while the review box is visible and only `y n d e w Esc Ctrl-C` are claimed by the review, so the `y` in a typed steer such as "yes, also update docs" approves the action. Plus an unspecified channel for the decline note, unique-prefix Enter that can run `/abort`, and `run.lock` deferred. |

### 1.1 minimal-robust — 8

§3.3 enumerates S0–S7 including **S6 `aborting`** and **S7 `pausing`**, and every cell is filled: "Every Ctrl-C while
`run: 'aborting'` is `process.exit` (never a hint), so a stuck final checkpoint can always be escaped" (l. 522) is the
DESIGN §11 invariant stated as a design rule, and the Enter row ("ignored (Enter never approves, A40)") and `y` row
make the no-accidental-approve property visible in the table itself. It is the **only** design that conditions the
wizard's Ctrl-C on whether a run exists — "wizard: print fix block, exit 2 when no run exists (else closes the wizard)"
(l. 511, repeated §11.2 l. 1016) — which matters because all four designs let `/login` re-enter the wizard while a run
is live (13 §5.2's "the run has not started, so nothing to checkpoint" is false in that state). §14.2 is the only Ctrl-Z
treatment that covers both measured failure modes of 12 §10.1: "re-apply raw mode on the next stdin chunk (Codex's
shell race) … a self-sent SIGTSTP that does not stop the process (orphaned group, 12 §10.1) is detected by a 100 ms
timer that simply resumes" (l. 1217–1218), and it keeps SIGINT/SIGTERM listeners registered while idle (l. 1215). §6.1
gives an explicit truncation order for the review header (7 → drop ruler, 6 → drop `matches_intent`, 5..3 → compact
two-dimension rows), so at rows 8 the box shows a dimension instead of a ruler; §10.3 applies 16 §4.3's `[REDACTED:draft]`
rule to `ui.json`; §13.4 gives the composer a PaneBoundary fallback ("a single-row plain input so keys still work");
§13.3 says "Never `process.exit` from the disk path". §19.4's pty table (SIGHUP close-master, resize storm 40→12→40,
crash `stty -a`, ENOSPC image, Ctrl-Z through `bash -i`) is the widest test surface on this lens. Deductions: §5.1
submits a mistyped `/` line as a **prompt** — in JevCode that is a paid run (E2); no `run.lock` at all, so two sessions
can resume one run (E16); the `d` note is not explicitly routed through the secret gate; the session-cap raise has no
mechanism (item 9 adds only `parentExceeded()`); it shares the four all-design gaps (E6, E10, E11) and makes
`run:ready`/`run:end` fields required rather than optional (E15).

### 1.2 composer-first — 7

§3.2 is the most complete matrix: thirteen state rows (idle-empty × mode, idle-text, live-empty × mode, live-text,
review, `aborting`, palette/mention/picker/help, history-search, wizard, budget confirm, blocking pane) × six columns,
and §3.3 reduces it to a pure `(state, key, nowMs)` machine with the three arm timers, which is the right shape for the
unit test. The review context is safe: "anything else | ignored; status toast `review pending: y n d e w · Esc
declines`" (l. 841) and the composer is collapsed and inactive while the box is up (§4.9). §22 D1 is the single best
money-safety decision in the four files: "Enter keeps the draft and reports the error; the text is never submitted …
a submitted line starts a paid run, so a typo must not become a task" (l. 1566). `/rename` text goes through the
secret gate (§10.1), the secret row is gated on `y`/`Y` only, `secret-ack` carries a count, the trace logs key classes
unconditionally, `fatalExit` is re-ordered with the full `EXIT_STRING`, SIGHUP/EIO listeners precede the SIGHUP logic,
disk errors pause with `[r]/[c]/[q]`, and `run.lock` refuses a second resume when the pid is alive. Deductions: the
wizard row "print the env/file fix block to stderr, exit 2" (l. 459) applies unconditionally, so `/login` mid-run
(§11.4 "while a run may be live behind it", l. 1170) exits 2 with no `engine.abort`, no `'exit'` writer and a stderr
write into a mounted Ink frame (E5); `ui.json` stores "`text: redactedDraft`" (l. 609) without 16 §4.3's detectSecrets
span rule (E9); the note field (§3.1 `note` context) is not routed through the secret gate; Ctrl-Z (§14) has no
orphaned-group or termios-race fallback (E12); §2.2's invariant "(title, keys, dominant dimension)" contradicts §6.1's
row 3 = ruler (E8); the Composer's own PaneBoundary fallback is unspecified; and the three all-design gaps.

### 1.3 sessions-long-horizon — 6

The strongest file on what happens **between** runs: §8.4 `run.lock` with `process.kill(pid, 0)` liveness, a `host`
field and `jevcode sessions unlock`; §22's refusal to rewrite a finished run's `state.json` for `undoLog` (carried in the
next seed instead — the R21 "never mutate a committed checkpoint" rule applied where the summary itself forgot it);
§12.3's `cleanAtStart` flag that makes undo rule 3 exact; §8.9's ten-run walkthrough that steps through 401 → exit-2
pane → `/login`, a mid-propose Ctrl-C (rule 1), a `spend_cap` with `/budget spend-cap 3` then `/resume`, and the
session clamp; the seed-source rule that skips a run stopped at step 0; §4.9's OSC-fragment filter; and the blocking
pane Ctrl-C defined as that pane's `[q]` (l. 411) so the 401 pane's exit code cannot flip between 2 and 130. Deductions
are all forgotten live-run states: `/exit` is listed as available in both states with "exit 0 always" and no confirm
(l. 611), while every other design confirms and aborts first — without `engine.abort` the engine's `'exit'` writer
(`engine.ts:500-509`) is never installed and the in-flight step's spend and `pendingDirectives` are lost, against
DESIGN §9.1 "state.json is always rewritten on any stop" (E4); `/budget session-spend-cap` "the root meter is recreated
with the new cap" (l. 914–915) orphans every live child meter, because `child()` closes over the old root
(`meter.ts:88-89`) (E3); Enter on an unknown slash "submits the typed text" (l. 554–555) (E2); the wizard/trust
Ctrl-C row "fix block to stderr, exit 2" (l. 412) while §11.2 re-enters the wizard as a top overlay mid-run (E5);
`ui.json` "text: redacted" (E9); no Ctrl-Z fallback (E12); wrong `client.ts` lines (E14); required `run:ready` fields
(E15); plus the all-design gaps.

### 1.4 jev-native — 5

On review semantics alone JN would lead: §6.3 routes the decline note through "`sanitizeStream` → the secret gate →
`config.redact`" (the only design to say so), §6.2 states "A pasted string never matches a key", §6.4 enters the review
key context "on the frame *after* the box is drawn, so a key already in flight is never an approval", §8.4 notes a
superseded human directive in the transcript "never silently", and §14's table is complete on SIGHUP/EIO, Ctrl-Z,
exit string and tmux queries. But it forgot the one state F6 exists for. §3.1 gives the Review context precedence and
lets it consume exactly "`y n d e w+digit Esc Ctrl-C`" (l. 449–450); §3.2 has a row "review pending, composer text |
… | delete-forward" (l. 496); Frame 4's composer placeholder reads "review pending — y n d e w answer it; **text here
is a steer for step 8**" (l. 310); §8.4 confirms "Frame 4's composer text is a steer draft". So the composer is live
under a visible review box and printable keys not in the review set go to it — the `y` of a typed "yes, also update
CHANGELOG" approves the action and "es, also…" is queued as a steer. That is A41/04 §8's typed-ahead approval, moved
from before the box to during it (E1). Further: the decline note has no channel from `TuiConfirmer.resolve(id, false,
note)` (l. 1275) to the engine while `Confirmer.confirm` still returns `Promise<boolean>` (`types.ts:460`) — "The
engine (`confirm()`) records `draft.declineNote = note`" (l. 729) names no mechanism (E7); §5.1 runs a command on a
"unique-prefix match" so Enter on `/ab` aborts a live run, and otherwise "submits the typed line" as a paid run (E2);
the wizard Ctrl-C exits 2 mid-run (E5); `run.lock` is deferred to v1.x (l. 1480) against A55 (E16); the index schema
(l. 850–855) never says `task60`/`title60`/`text60` pass `redact` (E13); `SpendMeter.setCap()` (l. 1236) makes the frozen
root cap mutable without saying what a live child's snapshot reports (partial credit: it is the only design with *a*
mechanism); no Ctrl-Z fallback (E12); plus the all-design gaps.

---

## 2. Errors (with evidence)

Severity: **H** = a key, file, dollar or the terminal is at risk; **M** = an invariant or promise is broken without
direct damage; **L** = wrong citation or hygiene.

| # | Design(s) | Sev | Error | Evidence (design line ↔ research row / code) |
| --- | --- | --- | --- | --- |
| E1 | JN | **H** | A typed steer while the review box is visible can approve: the composer stays editable under the box and the Review context claims only its seven keys, so a `y` inside ordinary text approves the pending action. | JN l. 310 `> review pending — y n d e w answer it; text here is a steer for step 8`; l. 496 `review pending, composer text \| either \| clear draft first \| as above \| decline (review context wins) \| — \| delete-forward`; l. 449–450 "**Review** (while the review box is *visible*) … consumes `y n d e w+digit Esc Ctrl-C`"; §8.4 "Frame 4's composer text is a steer draft". Contradicts F6/A41 (04 §8: "A typed-ahead `y` must not approve") and A40 (R17 fail-open). Compare CF l. 841 "anything else \| ignored" and SL l. 389 "everything else ignored". |
| E2 | JN, MR, SL | **H** | Enter on a `/` token that matches no command submits the text as a prompt — in JevCode a submitted prompt is a **paid run** (or a steer into a live run), so `/undoo`, `/dif`, `/bugdet 3` each start a run whose task is the typo. JN additionally runs a command on a *unique prefix*, so Enter on `/ab` executes `/abort` and on `/pa` executes `/pause`. | JN l. 626–627 "Enter (runs only on an exact or unique-prefix match, otherwise submits the typed line and reports `unknown command /dif`…)"; MR l. 650 "otherwise the text is submitted as a prompt and `Unknown command /bx (did you mean /budget?)` is toasted"; SL l. 554–555 "otherwise submits the typed text and reports `unknown command /bu`". A34 ("Enter runs only on a perfect match") is the source of the submit rule, but A34 describes Claude Code where a submission is a chat message; CF l. 1566 (D1) gives the JevCode reason: "a submitted line starts a paid run, so a typo must not become a task". 06 §3 / R18 forbid typo-tolerant Enter — JN's unique-prefix rule is exactly that. |
| E3 | SL | **H** | `/budget session-spend-cap` recreates the root meter; every live run's child meter still points at the **old** root, so (a) the raise never reaches the live run — it still stops at the old session cap via `parentExceeded()` — and (b) the live run's further `add()`s are forwarded to the orphaned root, not the new one, so the new root under-counts until `run:end` refolds the index. | SL l. 914–915 "(`createSpendMeter` gains `setCap(usd)`? — no: the root meter is recreated with the new cap and `restore()`d from its own snapshot, keeping `SpendMeter` frozen)". `src/spend/meter.ts:88-89` `child(childCapUsd) { return createSpendMeter(childCapUsd, meter); }` captures the creating meter by closure; `meter.ts:49-58` `parentExceeded()` calls `parent.exceeded()` on that captured object. F8 "`/budget session-spend-cap` applies immediately"; A129/14 §4.1. |
| E4 | SL | **H** | `/exit` is available while a run is live and "exit 0 always" with no confirm and no abort; the engine's `'exit'` writer is installed only inside `abort()`, so exiting a live run this way skips the final `state.json`, loses the in-flight step's spend and any `pendingDirectives`, and reports 0. | SL l. 611 `\| /exit, /quit \| — \| exit 0 always (--exit-code=last-run opt-in) \| both \| yes \|`; §3.3 arrow "/exit · Ctrl-D×2 · Ctrl-C×2(idle)" leaves any state. `src/loop/engine.ts:487-510` (`abort()` installs `process.on('exit', handler)`; `engine.ts:491` returns early once `lastResult` is set). DESIGN §9.1 "`state.json` is always rewritten on any stop (signal, human abort, budget, fatal error) … so no spend is ever lost"; §11 shutdown sequence. Compare CF l. 757 "exit 0 (confirm if a run is live: `y` aborts first)", MR l. 686 "confirms while live", JN l. 671 "(confirm if a run is live)". |
| E5 | CF, JN, SL | **H** | Wizard Ctrl-C "print the fix block to stderr, exit 2" is unconditional, but all three re-enter the wizard via `/login` while a run is live: the process exits 2 without `engine.abort` (no `'exit'` writer → no final checkpoint, sandbox tree not killed) and writes to stderr while Ink is mounted (`patchConsole: false`), corrupting the frame. | CF l. 459 `\| wizard \| either \| print the env/file fix block to stderr, exit 2 (13 §5.2) \|` and l. 1170–1171 "`/login` re-enters the wizard at the missing field while a run may be live behind it"; JN l. 497 "close overlay (wizard: print fix block, exit 2)" and §11.2 "`/login` re-enters at the missing field (mid-run: pane rows first…)"; SL l. 412 `\| wizard / trust \| fix block to stderr, exit 2 \|` and l. 994–995 "In-session `/login` re-enters the wizard as a top overlay". 13 §5.2's premise "Ctrl-C anywhere = §5.8's instruction block to stderr and exit 2 … the run has not started, so nothing to checkpoint" does not hold mid-run. 17 §4.8 step 2 (restore before printing) and DESIGN §11. MR l. 511 handles it: "wizard: print fix block, exit 2 when no run exists (else closes the wizard)". |
| E6 | **all four** | **H** | A cleared draft (Ctrl-C with text, Esc Esc with text, SL's secret-gate Ctrl-C) is written to `~/.jevcode/history.jsonl` **without** the `detectSecrets` gate. `redact` only knows configured secrets and the six `FORMAT_PATTERNS`; the warn-only families (AWS, PEM, JWT, Slack, Stripe, `npm_`, `hf_`, `glpat-`) pass through unchanged, so an unsent AWS key or private-key block lands on disk with no `y` ever pressed. | CF l. 451 "clear draft → history (`kind: 'prompt'`, draft marker)"; JN l. 491 "clear draft → history (`kind:'prompt'`, unsent)"; MR l. 564 "`clear` pushes the draft into history (`kind: 'prompt'`, unsent)"; SL l. 403/409/460 "clear draft → history", "dismiss gate + clear draft → history". 16 §4.6 requires history "written **after** §4.2 `addSecret`" — the clear path never reaches `addSecret`; 16 §4.3 already has the right rule for `ui.json` ("`detectSecrets` spans replaced by `[REDACTED:draft]`, so an unsent secret never reaches disk even before `y`") and no design applies it to the clear→history write. `src/core/redact.ts:42-49` (six families only). |
| E7 | JN | **M** | The decline note has no defined channel to the engine: `TuiConfirmer.resolve(id, approved, note?)` is added but `Confirmer.confirm()` still resolves `Promise<boolean>`, and the sentence that says the engine "records `draft.declineNote = note`" names no path; since the note's whole purpose is to reach Jev state and the generator window, the audit trail is unspecified. | JN l. 1275 `resolve(id: string, approved: boolean, note?: string): boolean`; l. 728–731 "then `confirmer.resolve(id, false, note)`. The engine (`confirm()`) records `draft.declineNote = note`"; `src/core/types.ts:460` `confirm(...): Promise<boolean>`; `src/loop/engine.ts:1128` `const approved = await this.opts.confirmer.confirm(req, …)`. Compare CF C18 `Confirmer.confirmDetailed?` and MR item 6 / SL item 19 `Promise<boolean \| ConfirmVerdict>`. |
| E8 | CF | **M** | At rows 8 the review box gets exactly 3 rows, and §6.1 fixes row 3 as the ruler, so the frame shows title, keys and a ruler with **no dimension**; §2.2's stated invariant claims the opposite. | CF l. 181–182 "a review box always receives ≥ 3 rows at `rows ≥ 8` (title, keys, dominant dimension)" vs l. 820–821 "Row 3 ruler: `dimension     lvl 0  ┆   ┆ 1 risk bnd  conf …`". 11 §5 / A39 want the dominant dimension to survive truncation. MR §6.1 (l. 727–729) is the fix: "5..3 → title, keys, then `n − 2` compact rows carrying two dimensions each". |
| E9 | CF, SL | **M** | `ui.json` stores the draft as "redacted"/"redactedDraft" without 16 §4.3's `detectSecrets`-span rule, so a draft holding an unsent warn-only-family secret reaches disk at the next checkpoint boundary. | CF l. 609 "persists `{ text: redactedDraft, cursor, chips: … }`"; SL l. 495–496 "`ui.json` … stores `{ text: redacted, cursor, chips … }`". 16 §4.3: "`text` has already passed `config.redact` **and** `detectSecrets` spans replaced by `[REDACTED:draft]`, so an unsent secret never reaches disk even before `y`". MR l. 972 and JN l. 936 state the rule. |
| E10 | **all four** | **M** | `/undo` rule 3 (`git restore --source=HEAD --worktree`) presumes HEAD is the commit the step started under; none records the HEAD oid per step or compares it before rule 3. After the user commits the run's changes (`current sha == post[N]`, "restore" is a silent no-op reported as `restored`) or switches branches (current differs → per-file prompt whose `y` writes another branch's content), the report is wrong. Not destructive thanks to the hash check, but the item text lies and the branch case is a foot-gun. | CF l. 1216–1218, JN l. 1085–1086, MR l. 1087–1089, SL l. 1081–1082 (restore order incl. `git restore --source=HEAD --worktree`); no design mentions HEAD in its undo section (grep `HEAD moved\|head differs\|HEAD oid` → none). 15 §6.4 rule 3's premise: "worktree == index == HEAD **at that moment**". SL already has `RunMeta.git.head` (§12.1) and a HEAD watcher (§12.2), so the check is cheap. |
| E11 | **all four** | **L/M** | `/resume` meter seeding "fold the index for the `sessionId`, add the resumed run's `state.json.spend`, then `restore()`" counts the resumed run's earlier spend **twice** when its `run:end` line is already in the index. Direction is fail-closed (over-count → earlier follow-up refusal / clamp), so no money is lost, but the promise "remaining" is wrong by the resumed run's prior cost. | CF l. 1033; JN l. 959–960; MR l. 913–914; SL l. 883–885 "`sessionMeter.add(source, usage)` per finished run's `run:end` costs, then add the resumed run's `state.json.spend`". Inherited from A130's wording; the fold must exclude the resumed `runId`. |
| E12 | CF, JN, SL | **M** | Ctrl-Z implemented as "raw off → `SIGTSTP` self → on `SIGCONT` raw on" with neither of 12 §10.1's two measured failure modes handled: a self-sent `SIGTSTP` did **not** stop an orphaned session leader (`ps` `Ss+`), and a job-control shell may restore cooked termios after `SIGCONT` so Ink believes raw mode is on while the terminal echoes (Codex `reapply_raw_mode_after_resume`). Result: a frozen "suspended" TUI with raw mode off, or a resumed TUI that echoes every keystroke twice. | CF l. 1333–1334; JN l. 1187; SL l. 1165–1167. 12 §10.1 "a self-sent `SIGTSTP` did **not** stop the process (`ps` state `Ss+`) … re-apply raw mode on `SIGCONT` *and* on the next stdin data"; 07 §3.3. MR l. 1217–1218 handles both. |
| E13 | JN | **L** | The `sessions/index.jsonl` schema never says `task60`/`title60`/`text60` pass `redact`; a task whose first 60 characters hold a pasted key would be indexed raw (the index is read by the picker of every later session). | JN l. 850–855 (schema lines) and §8.1 prose; A55/16 §4.6 (index and history written only through `redact`). MR l. 820 "`text60`/`task60`/`title60` pass `redactor.redact` then `clip(oneLine(x), 60)`", SL l. 726, CF l. 940 (`text60`; `task60` also unstated in CF). |
| E14 | SL | **L** | Wrong insertion lines for the Jev retry hook: "client.ts 388–391". The retry sleep is at `client.ts:351-353` (`if (!err.retryable \|\| httpAttempts >= JEV_RETRY.attempts) throw err; const waitMs = …; await sleep(waitMs, opts.signal);`). | SL l. 1113 "`AskOptions.onRetry` (client.ts 388–391)"; `src/jev/client.ts:351-353` (read today). CF l. 1255 and MR l. 1390 cite 352–353 / 351–353 correctly. |
| E15 | MR, SL | **L** | `run:ready` and `run:end` are extended with **required** fields (`sessionId`, `parentRunId`, `sandbox`, `noNetwork`, `maxReplans`; `exitCode`, `resumable`, `paths`), which is not additive under F13 ("ADDITIVE only … optional fields") and breaks every fixture that constructs these events today (`test/fixtures/tui/*`, bench readers). | MR l. 1337–1338; SL l. 1244–1245. F13; CF C10 and JN item 12 make the same fields optional (`sessionId?: string; …`). |
| E16 | MR, JN | **M** | No `run.lock`: MR never mentions one (grep: zero hits); JN defers it to v1.x (l. 1480). A55 adopts "`run.lock` refuses a second resume"; without it two interactive sessions can `/resume` the same run and both rewrite `state.json`/`steps.jsonl`, destroying "a run must stay comparable with itself" (DESIGN §9). | MR §8.2 covers only index-append atomicity ("Concurrency (P11): two interactive sessions append ≤ 512-byte lines"); JN l. 1480 "`run.lock` and PID liveness for concurrent sessions (P11)" under "Deferred to v1.x". A55 (10 §15.5, §17). CF l. 941–942 and SL §8.4 implement it. |

Verified-correct claims worth recording (so the final design does not re-litigate them): CF's `types.ts` insertion
lines in §15 are all exact (82, 219, 302, 337, 410/427, 458, 470, 531, 627, 678, 746, 823, 833, 874, 892, 943, 1077);
SL's `engine.ts` map in §15 is exact except E14; all four correctly place the steer/pause consumption after
`checkBudgets()` and before `runStep()` (`engine.ts:559-571`), correctly keep `createTuiConfirmer`'s "second request
declines the first" (`useEngine.tsx:192`), correctly cite `App.tsx:126` as the raw-key trace leak and `App.tsx:128-131`
as today's any-Ctrl-C-aborts, and correctly cite `validate.ts:123` + `main.tsx:145` as the fail-open pricing hole.
JN's claim that a human steer in jev-only maps to `change_approach` is verified: `src/synth/search/directive.ts:104-108`
returns `FALLBACK_MOVE` for text naming no move.

---

## 3. Forgotten states, per lens item

`✓` handled, `~` partial/ambiguous, `✗` forgotten. Row notes name the design section where the handling lives.

| Lens item / state | CF | JN | MR | SL | Notes |
| --- | --- | --- | --- | --- | --- |
| Secret typed/pasted and **submitted** (`y/N` gate, `addSecret` before send, count-only ack) | ✓ §4.9–4.10, §10.2 | ✓ §4.8, §10 | ✓ §4.9, §10.2 | ✓ §4.10, §10.2 | all four |
| Secret in a **cleared** draft → `history.jsonl` | ✗ | ✗ | ✗ | ✗ | E6 |
| Secret in an **unsent** draft → `ui.json` | ~ "redactedDraft" | ✓ §8.6 `[REDACTED:draft]` | ✓ §10.3 | ~ "redacted" | E9 |
| Secret in the `d` **decline note** (reaches Jev state and the generator window) | ~ redact only | ✓ §6.3 gate | ~ "every submission" | ~ "same input filter" | graft JN |
| Secret in `/rename` / `task60` / `text60` on the index | ✓ gate + redact | ✗ E13 | ✓ §8.2 | ✓ §8.2 | |
| Steer text through the gate | ✓ | ✓ | ✓ | ✓ | |
| Masked key field never in state/history/trace | ✓ §11.1 | ✓ §11.1 | ✓ §11.2 | ✓ §11.1 | all four |
| `JEVCODE_TRACE` key classes only, folded into the per-run log | ✓ §10.6 | ✓ §10 | ✓ §10.6 | ✓ §10.6 | all four |
| `@` denylist + `--allow-secret-mention` `y/N` | ✓ | ✓ | ✓ | ✓ | all four |
| **Review**: Enter inert, no default, no always, deferral until idle 1 s + drained | ✓ §6.2 | ✓ §6.4 | ✓ §6.2 | ✓ §6 | all four |
| **Review**: non-review printable keys while the box is visible | ✓ ignored | ✗ E1 | ✓ composer inactive | ✓ ignored | |
| **Review**: paste while the box is visible | ~ unspecified | ✓ "never matches a key" | ~ | ✓ | |
| **Review**: failed `Confirm` pane declines | ✓ | ✓ | ✓ | ✓ | |
| **Review**: second request declines the first (kept) | ✓ | ✓ | ✓ | ✓ | |
| Ctrl-C while `aborting` → `process.exit` (DESIGN §11) | ✓ l. 456 | ✓ l. 498 | ✓ S6 | ✓ l. 413 | all four |
| Ctrl-C in the wizard **mid-run** (`/login`) | ✗ E5 | ✗ E5 | ✓ | ✗ E5 | |
| `/exit` while a run is live | ✓ confirm + abort | ✓ confirm | ✓ confirm | ✗ E4 | |
| Ctrl-C ×2 after `run:end` (engine `abort()` is a no-op once `lastResult` is set) | ✓ "else exit 0" | ✓ "only while aborting" | ✓ S0 | ✓ "else exit 0" | |
| Ctrl-D live one-shot → confirm before exit | ✓ | ✓ `[y/N]` box | ✓ box, Enter inert | ✓ | |
| Esc single never destructive; 30 ms re-buffer | ✓ | ✓ | ✓ | ✓ | |
| `fatalExit` restore-before-print, `writeSync(2)`, no `ESC c`/`ESC[2J` | ✓ §13.4 | ✓ §13.2 | ✓ §13.4 | ✓ §13.6 | all four |
| Exit string incl. `?2004l ?2026l ?25h SGR0` (+ DECSCUSR reset iff sent) | ✓ | ✓ | ✓ (never sends DECSCUSR) | ✓ | |
| SIGHUP/EIO/EPIPE: error listeners first, checkpoint, no terminal writes, 129 | ✓ | ✓ | ✓ | ✓ | all four |
| SIGTSTP/SIGCONT basic | ✓ | ✓ | ✓ | ✓ | |
| Ctrl-Z orphaned-group fallback + termios re-apply on next chunk | ✗ E12 | ✗ E12 | ✓ §14.2 | ✗ E12 | |
| SIGINT/SIGTERM listeners while idle in session mode | ~ | ~ | ✓ §14.2 | ~ | `main.tsx:196-198` registers them only around `engine.run()` |
| Disk errors: once per (file, code), pause `[r]/[c]/[q]`, `[c]` → later exit 3 | ✓ | ✓ | ✓ + "never `process.exit`" | ✓ | all four |
| Write failures on files **outside** the run dir (`history.jsonl`, `index.jsonl`, `trust.json`, `ui.json`) | ✗ | ✗ | ~ log writes swallowed | ✗ | none says whether an `EACCES` on `~/.jevcode/sessions/` is a toast, a fatal, or silent |
| Provider outage: retry row, `paused: jev unreachable` 30 s→5 min session-only, bench/plain exit 5 | ✓ | ✓ | ✓ | ✓ | all four |
| First-call 401/403 → exit 2 / pane → `/login`; later 401 → pause | ✓ | ✓ | ✓ | ✓ | all four |
| Spend-limit 429 / 402 → no auto-retry | ✓ | ✓ | ✓ | ✓ | |
| Resize storm 50 ms debounce; budget from `useWindowSize` per render | ✓ | ✓ | ✓ | ✓ | all four |
| Tiny: rows < 3 status-only, < 8 notice + composer, 0×0 pty → 80×24 | ✓ | ✓ | ~ (no rows<3 branch; `take` yields 0 anyway) | ✓ | |
| Review header at rows 8 shows a dimension | ✗ E8 (ruler) | ~ header3 = title/keys/ruler | ✓ compact rows | ~ "hdr 3 (title, keys, ruler)" | |
| Undo: verify-before-write table, refuse on later-step overlap, per-file `n` default | ✓ | ✓ | ✓ | ✓ | all four |
| Undo: `git restore --source=HEAD --worktree`, never `checkout --`/`--staged`/stash/reset | ✓ | ✓ | ✓ | ✓ | all four |
| Undo: symlink/hardlink/escape/submodule skips | ✓ | ✓ | ✓ | ✓ (`nlink > 1` explicit) | |
| Undo: HEAD moved since the step | ✗ E10 | ✗ E10 | ✗ E10 | ✗ E10 (has the data) | |
| Undo: finished run's `state.json` not rewritten (R21) | ~ appends `undoLog` | ~ | ~ | ✓ §22 seed-carried | graft SL |
| Budget: unpriced Anthropic model refuses to start; flag named; `config.warnings` printed | ✓ | ✓ | ✓ | ✓ | all four |
| Budget: parent meter, `min(runCap, remaining)`, `remaining ≤ 0` refuse, Enter inert on the confirm | ✓ | ✓ | ✓ | ✓ | all four |
| Budget: `/budget session-spend-cap` **mechanism** with a live child | ~ unspecified | ~ `setCap` (mutable cap) | ~ unspecified | ✗ E3 | |
| Budget: `/resume` seeding double count | ✗ E11 | ✗ E11 | ✗ E11 | ✗ E11 | |
| Budget: slash typo → paid run | ✓ D1 | ✗ E2 | ✗ E2 | ✗ E2 | |
| Concurrency: `run.lock` on resume | ✓ dead-pid | ✗ deferred | ✗ E16 | ✓ pid+host | |
| Keys never in logs (`jevcode.log` levels, request hashes only, report bundle redacted) | ✓ | ✓ | ✓ | ✓ | all four |

---

## 4. D1–D15: what each design leaves unresolved or ambiguous

| Decision | CF | JN | MR | SL |
| --- | --- | --- | --- | --- |
| D1 layout cap set, yield order, frames 8/12/24/40 | Resolved; **ambiguous**: review-box content at rows 8 (E8). | Resolved; rows-8 review frame not drawn (table says header 3 = title/keys/ruler). | Resolved incl. truncation order. | Resolved; rows-8 review shows ruler, not a dimension. |
| D2 key/exit matrix, windows, exit-code table | Resolved; **unresolved**: wizard Ctrl-C mid-run (E5); blocking-pane Ctrl-C "as live-empty" makes the 401 pane exit 130 or 2 depending on key. | **Unresolved**: review + composer text (E1); wizard mid-run (E5); `--no-input` keeps an interactive composer (C46 says nothing interactive). | Resolved (only design with `aborting`/`pausing` states). | **Unresolved**: `/exit` while live (E4); wizard mid-run (E5). All four: whether "decline **and** abort" commits a declined step (counters `reviews`/`declined` +1) or is a rule-1 discard is not discussed. |
| D3 session model and money | Resolved; **ambiguous**: session-cap raise mechanism; resume double count (E11). | Resolved; `setCap` mutates a frozen cap — what a live child's `snapshot().capUsd` reports is unstated; E11. | Resolved; mechanism for the immediate session-cap raise unspecified; E11. | **Unresolved**: E3 (broken raise), E11. |
| D4 secrets at every entry point | **Unresolved**: cleared draft → history (E6); `ui.json` (E9); note gate unstated. | **Unresolved**: E6; index redaction (E13). | **Unresolved**: E6; note gate unstated. | **Unresolved**: E6; E9; note gate unstated. |
| D5 first-run and credentials | Resolved; **unresolved**: `/login` mid-run Ctrl-C (E5). | Resolved; E5. | Resolved. | Resolved; E5. |
| D6 workspace trust and `AGENTS.md` | Resolved (`~/.jevcode/trust.json`, sha drift re-prompt, `3` keeps `.env` with the `dotenv:` line). | Resolved. | Resolved. | Resolved. |
| D7 git state | Resolved (warn on head drift, re-probe at `run:end`). | Resolved. | Resolved. | Resolved. |
| D8 undo and rewind | Resolved; **ambiguous**: HEAD moved (E10); `undoLog` appended to a finished run's `state.json` vs R21. | Same. | Same. | Resolved except E10; R21 handled by the seed-carried `undoLog`. |
| D9 `/diff` | Resolved. | Resolved. | Resolved. | Resolved. |
| D10 error, retry, crash UX | Resolved. | Resolved. | Resolved (`Engine.retryNow()` as a fourth method, listed). | Resolved. |
| D11 logs and support bundles | Resolved. | Resolved. | Resolved. | Resolved. |
| D12 engine contract and `--json` | Resolved; **ambiguous**: no `user` EngineEvent, so the human turn is a `--json`/TUI line but not a `transcript.log` line (DESIGN §10 parity of the three transcripts). | **Unresolved**: decline-note channel (E7); `steer:queued` reused with `removed: true` for a withdrawal. | Resolved; required `run:ready`/`run:end` fields not strictly additive (E15). | Resolved; E15. |
| D13 terminal posture | Resolved. | Resolved; no tmux `CSI > 4;2m` (A78) and not listed in §22. | Resolved (deviation listed). | Resolved. |
| D14 packaging and release | Resolved. | Resolved. | Resolved. | Resolved. |
| D15 one `ui.*`/limits schema | Resolved. | Resolved (`notify off\|bell\|desktop`). | Resolved. | Resolved. |

---

## 5. Winner on this lens

**minimal-robust.** It is the only design that treats every failure class the research measured as a state the key
machine already has a transition for (S6 `aborting`, S7 `pausing`), checks for a live run before letting the wizard exit
the process, handles both measured Ctrl-Z races, keeps signal listeners while idle, degrades the review header to a
dimension rather than a ruler at rows 8, applies the `[REDACTED:draft]` rule to `ui.json`, gives every pane including
the composer a fallback, and writes the pty tests (SIGHUP, resize storm, crash `stty -a`, ENOSPC image, Ctrl-Z via
`bash -i`) that would catch regressions of all of the above. Its two lens defects — a slash typo starting a paid run
(E2) and no `run.lock` (E16) — are each one paragraph to fix and both have a ready graft below.

---

## 6. Grafts the final design must take

| From | What | Why |
| --- | --- | --- |
| composer-first §22 D1, §5.4, §4.9 | Enter on a `/` token that is not an exact name/alias match **keeps the draft** and appends `error: unknown command /foo; type / to list commands`; the text is never submitted as a task or steer. | A submitted line is a paid run; fixes E2 in JN/MR/SL. Also kills JN's unique-prefix execution (`/ab` → `/abort`). |
| composer-first §3.2–3.3 | The 13-row matrix (palette/mention/picker/help, history-search, wizard, budget confirm, blocking pane rows) and the pure `reduceInterrupts(state, key, nowMs)` machine with three arm timers as the unit-test shape; MR's S0–S7 states become the row keys. | MR's table omits the overlay-by-overlay rows CF has; CF's machine is directly testable with injected clocks. |
| composer-first §1.2 | `--no-input` forces the plain renderer (no composer at all) and cancels the secret gate / clamps the follow-up / declines reviews / prints the fix block. | C46 "don't prompt or do anything interactive": an Ink composer is interactive; JN keeps it. |
| jev-native §6.3 | The `d` note passes `sanitizeStream → detectSecrets gate → config.redact` before `resolve`; `confirm:resolved.note` is redacted at emit. | The note enters Jev state (`recent[i].notes`) and the generator window; only JN gates it. |
| jev-native §6.2, §6.4 | "A pasted string never matches a review key"; the review key context is armed on the frame **after** the box is drawn; `visibleAt = max(now, lastKeystrokeAt + 1000)` with an `inputDrained` re-check. | Closes the paste-as-`y` and in-flight-key holes precisely. Take the semantics, not JN's editable-composer-under-review (E1). |
| jev-native §8.4 | A superseding human directive notes the superseded `human`/`replan` problem text in the transcript item, never silently; `finish()` after `applyPendingDirectives` still checkpoints the directive inside `harnessProblems`. | Audit trail for the one plan mutation outside `commit()`. |
| jev-native §15 item 8 (amended) | Make the session-cap raise an explicit mechanism: a root meter whose cap is mutable through one method (`setCap`), with children referencing the same object, **or** an indirection object the children call — never recreation. Specify what a live child's `snapshot()` reports after a raise. | Fixes E3; CF/MR leave the mechanism unstated. |
| sessions-long-horizon §8.4 | `run.lock` `{ pid, startedAt, host }` written after `store.create`/load, removed in `finish()`; alive pid + same host → `ConfigError` exit 2 naming `jevcode sessions unlock <id>`; dead pid → replaced; picker shows `● live`. | A55; fixes E16 for MR/JN. CF's dead-pid version lacks the host check and the unlock command. |
| sessions-long-horizon §22, §12.3, §12.4 | Never rewrite a finished run's `state.json` for `/undo`: rename `post/<N>.json` → `post/<N>.undone.json`, append an index `undo` line, carry `undoLog` in the **next** run's seed; record `cleanAtStart` per file in `post/<step>.json` so rule 3 is exact; `dirs.json` for created directories. | R21 / DESIGN §9 "a run must stay comparable with itself"; the summary's `state.undoLog` (A143) contradicts it and SL is the only design that noticed. |
| sessions-long-horizon §8.6, §15 item 10 | Distinct events `steer:withdrawn` and `pause:requested` (not `steer:queued { removed: true }`). | Log and `--json` clarity; a consumer must not parse a "queued" line as a removal. |
| sessions-long-horizon §3.2 | Blocking-pane Ctrl-C = that pane's `[q]` semantics (401 pane → exit 2 item, disk pane → exit 3 item). | One exit code per failure regardless of which key ends it; CF's "as live-empty" makes the 401 pane exit 130 or 2. |
| sessions-long-horizon §8.9 | The ten-run walkthrough as an engine/session integration test script (401 → `/login`, mid-propose Ctrl-C rule 1, `spend_cap` → `/budget spend-cap` → `/resume`, session clamp, `remaining ≤ 0` refusal, seed source skipping step-0 runs). | It exercises more session states than any pty table in the four files. |
| sessions-long-horizon §4.9 | Drop OSC fragments (`/^\]\d+;/`, `\\`) in the composer input filter in addition to the CSI leak list. | Belt for any terminal that answers an OSC unprompted; zero cost. |
| minimal-robust §6.1 (already the winner's) | Review header truncation order 8 → 7 (drop ruler) → 6 (drop `matches_intent`) → 5..3 (compact two-dimension rows) → 2 (title, keys). | Fixes E8 and the JN/SL rows-8 frames. |
| **none of the four — add** | (a) The clear-draft → history path runs `detectSecrets`; hits → spans replaced by `[REDACTED:draft]` or the entry skipped (E6). (b) `/resume` meter seeding folds the index **excluding** the resumed `runId` before adding `state.json.spend` (E11). (c) Undo rule 3 requires `HEAD oid == oid recorded in post/<step>.json` (record it at step start; SL already probes/watches HEAD); otherwise skip `not recoverable — HEAD moved since step N` (E10). (d) One sentence on write failures for files outside the run dir (`history.jsonl`, `sessions/index.jsonl`, `trust.json`, `ui.json`): toast + log, never fatal, never a retry loop. | Shared blind spots; each is one rule. |

---

## 7. Must-fix list for the final design (ordered by severity)

1. Composer inactive (or its printable keys ignored) while the review box is visible; only `y n d e w Esc Ctrl-C`
   are live and a paste matches nothing (E1; take CF/MR/SL behaviour, JN's arming semantics).
2. Enter on an unknown `/` token keeps the draft and never submits; no prefix execution (E2; CF D1).
3. `/exit`, Ctrl-D ×2 and every other exit path during a live run go through `engine.abort('human_abort')` first,
   so the `'exit'` writer is installed and `state.json` is final (E4).
4. Wizard/trust Ctrl-C exits 2 **only when no run exists**; mid-run it closes the overlay (E5; MR).
5. Cleared drafts and `ui.json` drafts pass `detectSecrets` with hit spans replaced by `[REDACTED:draft]` (E6, E9).
6. Session-cap raise through a mutable root cap (or indirection) that live children observe; never recreate the root
   (E3); `/resume` seeding excludes the resumed run from the fold (E11).
7. `run.lock` with pid liveness on every resume (E16; SL §8.4).
8. Ctrl-Z: 100 ms fallback when the self-sent `SIGTSTP` does not stop the process; re-apply raw mode on `SIGCONT`
   **and** on the next stdin chunk (E12; MR §14.2).
9. Undo rule 3 gated on the recorded HEAD oid (E10).
10. The `d` note through the secret gate (JN §6.3); `Confirmer` note channel as `confirmDetailed?` or a
    `boolean | ConfirmVerdict` return (E7).
11. Review header truncation order so rows 8 shows a dimension (E8; MR §6.1).
12. `run:ready`/`run:end` extensions optional (E15); `task60`/`title60`/`text60` through `redact` (E13); fix the
    `client.ts` insertion lines to 351–353 (E14).
