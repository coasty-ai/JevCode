# Judge verdict — engineering feasibility lens

Written 2026-09-20 after reading all four designs in full (`composer-first.md` 1,578 lines, `jev-native.md` 1,484,
`minimal-robust.md` 1,597, `sessions-long-horizon.md` 1,513), `00-SUMMARY.md` (1,152 lines) and the code the designs
must build on (`src/core/types.ts`, `src/loop/engine.ts`, `src/loop/{state,stop,budget,plan,loopdetect}.ts`,
`src/provider/prompts.ts`, `src/tui/*`, `src/cli/*`, `src/checkpoint/*`, `src/config/{resolve,validate,defaults}.ts`,
`src/spend/meter.ts`, `src/core/{redact,time}.ts`, `src/jev/client.ts`, `src/provider/sse.ts`, `src/workspace/{files,git}.ts`,
`src/sandbox/{seatbelt,paths}.ts`, `src/synth/search/directive.ts`, `bin/jevcode.js`, `node_modules/ink/build/*.d.ts`,
DESIGN §6/§9.1/§10/§11/§12).

**Lens.** Would it build and hold the constraints: ink 7.1.1 + react only; first frame < 300 ms with zero network; zero
clears (layout arithmetic at rows 8/12/24/40/50 checked by me, not taken from the tables); rendering never blocks the
loop (50 ms harness budget, 5 ms lag p95); additive contract whose signatures type-check against today's
`src/core/types.ts` and `engine.ts`; jev-only path and transcript parity preserved; module map really parallelisable
with disjoint files; credible test plan.

**Method.** Two checks were executed rather than read:

1. Each design's `computeLayout` was ported verbatim to `/tmp/judge/layouts.mjs` and run on the states its own
   allocation table and frames claim (the ports are the designs' code with `take()` semantics unchanged).
2. Three contested signatures were type-checked with the repo's `tsc --strict`: composer-first C11's conditional type,
   jev-native §15 item 3's `SteerResult`, and the `Promise<boolean | ConfirmVerdict>` widening of `Confirmer.confirm`
   used by minimal-robust (§15 item 6) and sessions-long-horizon (§15 item 19) against today's consumer in
   `engine.ts:1126-1130`.

Line numbers below are today's working tree.

---

## 1. Scores

| Design | Score | One line |
| --- | --- | --- |
| minimal-robust | **8** | Layout function correct and F3-ordered (verified); one modal slot makes the budget proof small; enumerated `resolveKey` state machine; the most concrete pty/fault table; contract precise with line cites. Costs: a consumer-breaking `Confirmer.confirm` widening, required fields on `run:ready`/`run:end`, five touched files without an owner. |
| composer-first | **7** | Layout verified correct and F3-ordered; the most carefully *additive* contract (optional fields, `confirmDetailed?`) and the best insertion-point list. Costs: C11's `RetryInfo.cause` is `never` (tsc), six touched files unowned including `useEngine.tsx` and `plain.ts`, `/calibration` allowed while live, no post-image hashing cap, `session-spend-cap` has no mechanism. |
| sessions-long-horizon | **6.5** | Deepest engine/session integration (ten-run state table, `run.lock`, seed-source rule, backward-compat section, hashing cap, exact `engine.ts` line ranges). Costs: its frames and tables disagree with its own `computeLayout` in three states (verified), `/budget session-spend-cap` by root-meter recreation orphans a live child (`meter.ts`), a parity self-contradiction on `retry`, required event fields, `files.ts` owned by two slots. |
| jev-native | **6** | Best decision model (`consumedBy`, `near`, `/why` rows) and the most complete module map. Costs: `computeLayout` gives the queue priority over composer growth (inverts F3, verified by execution), `SteerResult` is a syntax error (tsc), the `d` decline-note has no contract path from `TuiConfirmer` to the engine (F6 unimplementable as written), `SpendMeter.setCap` and `Engine.pendingDirectives` are required additions to frozen interfaces, session-scope `budget:warn` only at `run:end`. |

**Winner on this lens: minimal-robust.**

---

## 2. Per-design assessment

### 2.1 minimal-robust — 8

**Feasibility.** §2.1's `computeLayout` is the smallest of the four and the port reproduces every row of its §2.2 table
that I ran: `live + 2 queued, draft 1` at rows 8 → live 1, queue 2, composer 1 (total 6); `review, preview 4` at rows 24
→ overlay 8, preview 4, pane 7 (22); `review expanded 30` at rows 50 → 41 ≤ 48; `wizard 4` at rows 12 → 7; `secret + 3-row
draft` at rows 8 → overlay 1, composer 3 (6). The allocation order (status, rule, composer floor, overlay, composer
growth, queue, preview, live, banner, pane) is the exact reverse of F3's yield order, so the invariant "pane yields first,
composer-to-1 last" holds by construction. One modal slot (§0 "nine kinds of dynamic rows, one modal slot") means the
review header, wizard, follow-up confirm, secret row, blocking pane, palette and undo prompt can never coexist, which is
what makes the budget proof and the key resolver small; the §3.3 S0–S7 matrix is complete for {idle, text, live, review,
overlay, aborting, pausing} × {one-shot, session}. First frame: composer from argv, `resolveConfig`/`missingSecrets`/index/
trust/git after `firstFrame()` (§1), matching DESIGN §12's ordering contract; the sentinel moves to the right zone but
`perf/first-frame.ts:27` searches `step 0/` in the accumulated bytes, so the gate keeps working. Loop budget: `/calibration`
and `/diff` are idle-only (§5.2), `warn+` logging is sync per A168, the index fold runs once per open/`run:end`. jev-only
checklist §15.3 is correct (`NullProvider` at `main.tsx:54-57`, `gen` fallback at `:162`, `synth` one line at
`plain.ts:229-231`, `SynthesisContext.directive` is the only synth-facing change). Insertion table §15.2 cites real
lines (`engine.ts` L545–L575 `main()`, L1123 `confirm`, L1141 `commonState`, L1168 `promptInput`, L1300 `commit`,
L1463 `finish`; `client.ts` L351–L353 — actual `await sleep(waitMs, opts.signal)` is at :353; `sse.ts` L299–L302 — actual
`deps.sleep(delay, signal)` at :302). Ctrl+Z via `suspendTerminal()` without a callback (§14.2) matches
`AppContext.d.ts`'s `TerminalSuspension` form; `instance.clear()` for Ctrl+L exists on `Instance`.

**Errors (with evidence).**

1. **`Confirmer.confirm` return-type widening is not additive for consumers.** §15 item 6: `confirm(req, opts):
   Promise<boolean | ConfirmVerdict>`. Today's consumer `engine.ts:1126-1130` does `const approved = await
   this.opts.confirmer.confirm(req, …); … this.emit({ type: 'confirm:resolved', …, approved, aborted: false }); return
   approved;` where `approved: boolean` is required. `tsc --strict` on the widened shape: `error TS2322: Type 'boolean |
   ConfirmVerdict' is not assignable to type 'boolean'`. The design does say the engine normalises (§6.3, §15.2 row
   `confirm()`), so it compiles after the engine edit, but F13 asks for additions "against the current src/core/types.ts";
   composer-first's optional `confirmDetailed?` (C18) achieves the same without touching any existing signature.
2. **`run:ready` and `run:end` gain required fields.** §15 item 15: `{ type: 'run:ready'; …; maxReplans: number; …;
   sessionId: string; parentRunId: string | null; sandbox: SandboxLevel; noNetwork: boolean }` and `{ type: 'run:end';
   result; exitCode: number; resumable: boolean; paths: {…} }`. Every producer (`engine.ts:551`, `:1524`, the scripted
   engine in `test/unit/bench/helpers.ts`, `test/fixtures/tui/fixtures.ts`, `run-events.json` once typed) must change
   in the same PR; not additive in the sense of "existing readers and writers compile unchanged". Also `SpendSnapshot
   { parentExceeded: boolean }` (item 9) is required, breaking every literal `SpendSnapshot` in tests.
3. **Module map leaves F11/F10 files unowned.** §20 O5 creates `workspace/gitstate.ts` but §12.1 says
   "`createWorkspace()` (files.ts 100–130) replaces … four spawns", §15 item 13 adds `Workspace.readSecretForMention` and
   §5.4 extends `isSecretPath()`; `src/workspace/files.ts`, `src/workspace/git.ts` (today's `isRepo/showPrefix/gitDir/
   statusPorcelain` at `git.ts:85-160`) and `src/sandbox/paths.ts` (`isSecretPath` at :125) appear in no slot. Likewise
   `src/loop/plan.ts` (§8.5 "commit(): a `human` harness problem expires … > 4 steps old"; §8.3 rule (b) for seeded runs)
   and `src/config/defaults.ts` (`SETTINGS` at :47 must gain the §16 rows; `DEFAULT_SPEND_CAP_USD` at :10 must become
   mode-keyed) are not in O1/O6.
4. **Undocumented deviation from A3.** §4.3: "`DECSCUSR` is not sent (07 §2.8 …)". A3 adopts "DECSCUSR steady bar on
   start"; §22 has no row for it (the other three designs send `CSI 6 SP q` and reset it in the exit string).
5. **`--no-input` changes the renderer.** §1: `interactive iff … && !flags.noInput`. F10 defines `--no-input` as
   suppressing the wizard, trust gate, follow-up confirm, secret gate and reviews; nothing in F1/F10 makes it select the
   plain renderer on a TTY (jev-native §1.2 and sessions-long-horizon §1 keep the TUI). Minor, but D2/D5 ambiguity.
6. **Onboarding frame vs table.** §2.2 "onboarding wizard (4 rows, no run) … rows 12: 1·0·0·0·0·4·0·1·1 = 7" while the
   §2.3 24×80 wizard frame shows three overlay rows (`No API key found…`, `1 anthropic … 2 openrouter …`, `Keys are never
   shown…`) plus the composer `> (setup)`. The function gives 7 at rows 12 with `overlayWant 4` (verified); the frame is
   one row short. Cosmetic.

**D1–D15 status.** Resolved: D1 (F3 collapse, function verified), D4, D6, D7, D8, D9, D10, D11, D14, D15. Ambiguous or
partly unresolved: **D2** (`--no-input` → plain renderer, item 5), **D3** (`/budget session-spend-cap <v> applies to the
root meter immediately`, §9.4, but §15 item 9 adds only `parentExceeded()`; `createSpendMeter` closes over `cap` and
`child()` closes over the parent object — there is no API that changes a root cap), **D12** (items 1–2 above; renderer-
only items vs `transcript.log`, see §4 below), **D13** (DECSCUSR, item 4).

### 2.2 composer-first — 7

**Feasibility.** §2.2's function is verified: `live, 2 queued, 3-row draft` → rows 8: queue 1, composer 3 (6); rows 12:
live 2, pane 1, queue 2, composer 3 (10); rows 24: 21 — exactly the table. `review` at rows 24 → box 8, preview 8, pane
3, composer 1 (22); at rows 12 → box 7, composer 1 (10). Allocation order (status, rule, composer floor, box, secret,
search, composer growth, palette, queue, preview, live, banner, pane) is F3-compliant. The composer-focus model (§3.1
contexts, §3.3 pure `(state, key, nowMs)` reducer) is implementable with one `useInput` + one `usePaste`. §15 is the
best-formed contract list: every item is a new union member, an optional field, or an optional method (C9
`parentExceeded?`, C10 `run:ready`/`run:end` extensions optional, C18 `confirmDetailed?`), with insertion points that
match the code (`engine.ts:492-495` second Ctrl-C, `:562-567` loop top, `:1148`/`:1176`/`:861` directive consumers within
a few lines of the actual `:1141`/`:1168`/`:861`; `client.ts:352-353` and `sse.ts:301-302` exact). §8.5's consumption
algorithm sits after `checkBudgets()` and before `runStep()` as F7 requires, and `PLAN_MAX_HARNESS_PROBLEMS` exists
(`plan.ts:16`). `planSection` (`prompts.ts:134`) does already render every `harnessProblems` kind, so C1 costs no prompt
change. jev-only checklist §15.2 is correct.

**Errors (with evidence).**

1. **C11's `RetryInfo.cause` is `never`.** §15 C11: `cause: EngineEvent extends { type: 'retry'; cause: infer C } ? C :
   never`. `EngineEvent` is a union used in a non-distributive position, so the whole union is tested against the object
   type and fails; `tsc --strict` on that shape: `error TS2322: Type '{ kind: string; status: number; }' is not
   assignable to type 'never'`. `AskOptions.onRetry?: (r: RetryInfo) => void` therefore cannot be called with a real
   cause. Fix is `Extract<EngineEvent, { type: 'retry' }>['cause']` (verified to type-check).
2. **Six touched files have no owner in §20.** The design edits `src/tui/useEngine.tsx` (reducer: queue, retry tick,
   toasts, tabs, review deferral — §13.2 "1 Hz tick owned by the reducer hook"), `src/tui/plain.ts` (C10 "`itemsFromEvent`
   (plain.ts:206) gains one line per new item kind"; `CONFIRM_HEADER_ROWS` 6 → 8 at `plain.ts:287`; readline confirmer
   `d` path §6.4), `src/spend/meter.ts` (C9), `src/loop/budget.ts` (`token_cap`, §9.5), `src/loop/plan.ts` (`human`
   problems, §8.4 rule (b)), `src/config/defaults.ts` (§16 rows, mode-keyed default). None appears in S1–S10; S10 lists a
   new `tui/plain-composer.ts` but not `plain.ts`. Two of these (`useEngine.tsx`, `plain.ts`) are on the critical path of
   every other slot.
3. **`generator-only.ts mirrors (steer → prompt hints only)`** (C3) is unnecessary: `generator-only.ts:17-18` is
   `createEngine({ ...opts, mode: 'jev-off' }, deps)`, so it inherits every `EngineImpl` method. Harmless, but the real
   implementers that must change are `test/unit/bench/helpers.ts:240` (scripted engine) and `test/fixtures/tui/fixtures.ts:106`.
4. **Non-API Ink call.** §2.5 and §3.4: "Ctrl+L = Ink `eraseLines(frameHeight)`". Ink 7.1.1 exposes `Instance.clear()`
   (`render.d.ts`) and no `eraseLines`; the log-update `clear()` is internal. minimal-robust §3.2 uses `instance.clear()`.
5. **Loop-budget risks left open.** §5.3 `/calibration` avail `any` (reads `~/.jevcode/runs/*/decisions.jsonl` +
   `steps.jsonl`; 10 §14 measured 166 MB of `steps.jsonl` across 140 runs and 14.9 ms for one 4.4 MB file) while a run is
   live — JSON parsing of tens of MB on the event loop breaks the 5 ms lag p95 gate. §12.3 hashes every changed file
   with no per-step cap ("files > 1 MiB hashed but never copied"); at 0.6 ms/MiB (15 §4) a `run` step that writes a 200
   MB artefact costs 120 ms on the loop. sessions-long-horizon §12.3 caps at 64 MiB (`hashSkipped`, Q33).
6. **`/budget session-spend-cap` has no mechanism.** §9.4 "applies to the root meter immediately"; §15 adds only
   `SpendSnapshot.parentExceeded?` (C9). `createSpendMeter(capUsd)` (`meter.ts:41-42`) captures `cap` as a `const`; nothing
   can change it.
7. **Table slip.** §2.3 "secret gate row, 2-row draft … rows 8: secret 1, composer 2, pane 0 (6)"; the function gives
   pane 1 (verified). Cosmetic.
8. **`engine.wakeRetry()` is a hidden Engine method.** §13.2: "the engine exposes `engine.wakeRetry()` (internal to the
   renderer hook, not part of the frozen `Engine` surface — passed through `RendererOptions.session`)". Either it is on
   `EngineImpl` and must be in the additive list, or the renderer holds a second object; F13 asks for one collected list.

**D1–D15 status.** Resolved: D1 (verified), D4, D5, D6, D7, D8, D9, D11, D13, D14, D15. Ambiguous: **D2** (Ctrl-D with a
live run: §3.2 one-shot "hint … 2nd: abort + exit 130", session "abort, then exit 0 after the `run:end` item" — F5 says
"confirm if a run is live"; jev-native and minimal-robust show an explicit `[y/N]` box; also `interactive` excludes
`--no-input`), **D3** (item 6; who emits session-scope `budget:warn` is not stated), **D10** (item 8), **D12** (item 1; the
`you:` `<Static>` item in §4.9 and the `user` line in §8.8 have no `EngineEvent`, so `--plain` and `transcript.log` lack
the human turn while `--json` and the TUI have it — this contradicts §15.2's "every new item kind is produced by
`itemsFromEvent` and nowhere else", see §4).

### 2.3 sessions-long-horizon — 6.5

**Feasibility.** The engine side is the most precisely located of the four: §15's insertion table gives real ranges
(`engine.ts` 372–443 constructor, 487–510 `abort`, 551 `run:ready`, 637–670 `buildCheckpointState`, 600–612 `persist`,
774–828 `ask`, 913–945 `generate`, 1054/1062 execute, 1123–1139 `confirm`, 1141–1166 `commonState`, 1168–1191
`promptInput`, 1300–1457 `commit`, 1463–1526 `finish`, 1580–1634/1605 `createEngine`; `main.tsx` 15–29, 81–210, 276–285,
288–296; `args.ts` 10–11, 78–124, 171–178; `plain.ts` 287–308; `prompts.ts` 51–70, 155–172; `state.ts` 66–83, 113–134;
`resolve.ts` 208) and all of them are correct. §8.6's consumption point (after the pause check and `checkBudgets`, before
`runStep`) is right; `applyPlanDraft` (`plan.ts:96, 163-168`) filters only `stale_plan`/`replan`/`rejected_claim`, so a
`human` problem survives and the design's replace-on-apply rule is needed and present. §8.9's ten-run table is the only
end-to-end trace of session/meter/index/seed interplay and doubles as an integration test script; §8.10 is the only
explicit backward-compatibility section (`isCheckpointState`/`isRunMeta` at `store.ts:108-146` check v1 fields only —
true). §12.3 caps per-step hashing (Q33). The `undoLog`-in-the-next-run deviation (§22) is the one reading of A143 that
does not rewrite a finished `state.json` (R21).

**Errors (with evidence).**

1. **Frames and tables contradict the function (three states, verified by execution).**
   - §2.3 Frame G "Onboarding wizard … (rule 1 · wizard 4 · status 1 = 6; composer absent)" and §2.2 "onboarding wizard
     … composer absent → 1+2+1 = 4" — but §2.1 line 102 `L.composer = take(1);` is unconditional and, unlike jev-native's
     `rem += L.composer; L.composer = 0`, nothing refunds it. Port: rows 24 → `topOverlay 4, composer 1, total 7`; rows 8
     → `topOverlay 2, composer 1, total 5`.
   - §2.2 "live, 2 queued, 3-line draft | rows 8 (6) | 1+2+q2+c1(floor)+st1 = 7 > 6 → live yields to 1" — the function
     allocates composer growth before the queue and the queue before live: rows 8 → `queue 1, composer 3, live 0`
     (which is the F3-correct answer; the table is wrong).
   - §2.2 "idle composer (empty) | rows 8 | rule 1 c1 p2 st1 = 5" — the function gives `pane 3, total 6`.
   The function is right and F3-ordered; the documents an implementer would read are not.
2. **Root-meter recreation orphans a live child.** §9.4: "`/budget session-spend-cap <v>`: `sessionMeter` cap replaced
   immediately (… the root meter is recreated with the new cap and `restore()`d from its own snapshot, keeping
   `SpendMeter` frozen)". `meter.ts:41-93`: `child(childCapUsd)` returns `createSpendMeter(childCapUsd, meter)` — the
   child closes over the *old* root object; its `add()` forwards to that object and `exceeded()` reads that object's
   cap. After recreation, a live run keeps spending against the old cap and the new root never sees its spend, so the
   §9.1 accounting (`remaining = sessionCap − sessionMeter.snapshot().totalUsd`) diverges for the rest of the run. The
   design's own §5.3 makes `/budget` available "both" (idle and live). F8's "applies immediately" needs a mutable cap on
   the root (jev-native's `setCap`) or a re-parent hook.
3. **Parity self-contradiction on `retry`.** §15 insertion row for `plain.ts`: "`itemsFromEvent` gains `user`, `steer:*`,
   `budget:*`, `retry` (plain only, one line per attempt), `notice`, … (one line each, so `transcript.log` = `--plain` =
   TUI)". `itemsFromEvent` (`plain.ts:206`) is the single item source for all three writers (`engine.ts:583-590`
   `recordTranscript`, `plain.ts:481`, `Transcript.tsx`); a "plain only" line is not expressible through it and would
   break the identity the same sentence asserts.
4. **Required fields on existing events and inputs.** §15 item 10: `run:ready` gains required `sessionId`,
   `parentRunId`, `sandbox`, `noNetwork`, `maxReplans`; `run:end` gains required `exitCode`, `resumable`, `paths`; item
   17: `PromptInput { humanDirective: { text; step } | null }` required; item 7: `SpendSnapshot { parentExceeded: boolean }`
   required. Every producer and fixture must change in the same PR (see minimal-robust item 2).
5. **`Confirmer.confirm` widened** (§15 item 19) — same consumer break as minimal-robust item 1 (tsc-confirmed).
6. **Module map: `src/workspace/files.ts` is owned twice** — S8 ("`workspace/files.ts` (`readSecretForMention`)") and S9
   ("`files.ts` (two spawns, `gitState`, `dirtySet`)"). Unowned: `src/tui/useEngine.tsx` (the §15 insertion row
   "`useEngine.tsx` reducer: `retry` row + 1 Hz tick, `steer` queue, `budget` state, `pane` tabs, `toasts`" names it; S4
   has `App.tsx` only), `src/config/resolve.ts` (`missingSecrets`, `ui()`, `sessionSpendCap()`, XDG at :208 — S7 lists
   `validate.ts`/`defaults.ts` only), `src/spend/meter.ts` (item 7 "createSpendMeter … fills parentExceeded/parent").
7. **Mis-cited retry site.** §13.2 "`AskOptions.onRetry` (client.ts 388–391)"; the sleep is `client.ts:353` (`await
   sleep(waitMs, opts.signal)`), as composer-first and minimal-robust cite. The `sse.ts 299–301` cite is right.
8. **Frame A shows post-probe content as "first launch".** §2.3 Frame A's status line carries `⎇ main 3~ 1?` and the
   `[setup] sandbox` item; both come from probes that §1 correctly places after `waitUntilRenderFlush()`, so this is the
   second frame, not the gated one. Cosmetic, but the first-frame gate must be measured on the frame without them.

**D1–D15 status.** Resolved: D4, D6, D7, D8 (with the R21-compliant `undoLog` reading), D9, D10, D11, D13, D14, D15.
Ambiguous or wrong: **D1** (item 1), **D2** (Ctrl-D with a live run: §3.2 "hint … 2nd: abort → exit 130" / "abort, then
exit 0", no explicit confirm; F5 says "confirm if a run is live"), **D3** (item 2), **D5** (§11.2 "Shadowing line at
every start" — P43's `--plain` location, stderr vs item stream, is not stated), **D12** (items 3–5).

### 2.4 jev-native — 6

**Feasibility.** The review box and decision model are the most exact (§6.1's eight rows per column, `riskLevelTexts`
from `src/loop/stages/risk.ts`, §7.1 `consumedBy` table lifted from DESIGN §6's "Consumers of every Jev answer", `near`
markers for 11 §4i). §8.4's claim that a human steer reaches the jev-only synthesizer through `SynthesisContext.directive`
and lands on `FALLBACK_MOVE` is verified: `src/synth/search/directive.ts:104-108` returns `FALLBACK_MOVE`
(`'change_approach'`) for any non-empty text without a move name, so no `src/synth/**` edit is needed. §6.4's deferral
(`visibleAt = max(now, lastKeystrokeAt + 1000)`, 100 ms re-check, review context entered on the frame *after* the box is
drawn) is the most concrete A41 implementation. §20 is the most complete module map (only `src/spend/meter.ts` is
unowned). The loop-top consumption point is right.

**Errors (with evidence).**

1. **`computeLayout` inverts F3's queue/composer order.** §2.1 lines:
   `L.queue = take(Math.min(s.queue, QUEUE_MAX)); // yields 4th` then
   `if (o.kind !== 'review' && o.kind !== 'wizard') L.composer += take(Math.min(s.composerWant, composerCap(rows)) - 1); // yields last`.
   With `take()` semantics the earlier call has priority, so the queue is satisfied before composer growth — the composer
   yields *before* the queue, the opposite of F3 ("queue → composer-to-1") and of the design's own comments. Port, rows 8,
   live, 2 queued, 3-row draft: `queue 2, composer 2` (F3 and the §2.2 table want `composer 3, queue 1`). Swapping the two
   statements fixes it.
2. **`SteerResult` is a syntax error.** §15 item 3: `export interface SteerResult { ok: true; queued: number } | { ok:
   false; reason: 'full' | 'finished' | 'empty' };`. `tsc`: `error TS1109: Expression expected` / `TS1005: ',' expected`.
   Must be `export type SteerResult = …`.
3. **The `d` decline-note cannot reach the engine.** §6.3: "then `confirmer.resolve(id, false, note)`. The engine
   (`confirm()`) records `draft.declineNote = note`". The engine only sees what `Confirmer.confirm()` resolves
   (`engine.ts:1126`), which is `Promise<boolean>`; §15 changes `TuiConfirmer.resolve` (item 14, a renderer type in
   `useEngine.tsx`) and adds `StepRecord.declineNote?` and `confirm:resolved.note?`, but leaves `Confirmer` untouched. As
   written, F6's `d` (note "appended to the declined reason and to the window entry notes so Jev sees it") has no data
   path.
4. **Required additions to frozen interfaces.** Item 8 `SpendMeter { setCap(capUsd: number): void }` (required; every
   `SpendMeter` implementer/fake breaks); item 3 `Engine { readonly pauseRequested: boolean; readonly pendingDirectives:
   readonly PendingDirective[] }` (required fields beyond F13's methods); item 14 `PromptInput { humanDirective: string |
   null }` required; item 13 `ResolvedConfig { ui(): UiSettings; session(): {…} }` required. Each is implementable but
   is a breaking edit to the frozen contract rather than an optional addition.
5. **Session-scope thresholds only at run end.** §9.2: "Session-scope checks run in the controller on `run:end` and
   `budget:override` only (A139)". F8/A131 require `budget:warn` at 50/80/95 % "of each scope"; a session crossing 95 %
   mid-run gets no item, toast or BEL until the run ends. A139 forbids re-*folding the index* per frame, not computing a
   percentage from the in-memory root meter after `meter.add()`. Not listed in §22.
6. **Unilateral `synth` extension.** §15 item 12 adds `mode?`, `goal?`, `site?`, `source?`, `runs?`, `tRunMs?`, `lanes?`,
   `jevRequests?` to the `synth` event in `types.ts` while §7.2 renders `detail` "until the structured fields exist" and
   §22 says they "land when the synth team adopts the optional members". F16 says the extension is "coordinated with the
   synth team"; composer-first C24 explicitly reserves it instead. Optional fields compile, but the emitter is in
   `src/synth/**`, which this work may not touch, so the addition is dead until another team acts.
7. **Frame/table slips.** Frame 7 caption "(22 rows: pane 11, palette 4 of 8, composer 1)" — with `palette rows 4` the
   function gives `pane 12, total 19`; pane 11 needs palette 8. §2.2 "idle, 6-row draft | rows 8 | comp yields to 3 …
   pane1" — function: `composer 4, pane 0`; "rows 40 | comp cap 8: 1+1+8+12 = 22" for a 6-row draft — function: `composer
   6, total 20`. Frame 12 "status-only, 2×40" — the function's `rows < 3` branch has budget 0 and renders nothing.
8. **`/calibration` while live** (§5.3 "yes") — same loop-budget risk as composer-first item 5; no post-image hashing cap.
9. **`Renderer`/`SessionController` coupling.** Item 14 `RendererOptions.controller?: SessionController` puts a session
   object with `startRun`/`command`/`exit` into the renderer contract; workable, but it makes `createTuiRenderer` depend
   on slot 5's controller type in wave 2, which §20's wave plan (App in wave 3) only just accommodates.

**D1–D15 status.** Resolved: D4, D5, D6, D7, D8, D9, D10, D11, D14, D15. Wrong or ambiguous: **D1** (item 1, item 7),
**D3** (items 4 `setCap`, 5), **D12** (items 2, 3, 6; `user` emitter unspecified, see §4), **D13** (§14 "inside `TMUX` no
queries at all (A112)" — A78's `CSI > 4 ; 2 m` is a mode set, not a query; the design neither sends it nor lists its
omission in §22, while composer-first and sessions-long-horizon send it and minimal-robust defers it explicitly).

---

## 3. Grafts the final design must take

| From | What | Why |
| --- | --- | --- |
| composer-first | `Confirmer.confirmDetailed?(req, opts): Promise<ConfirmOutcome>` + `ConfirmOutcome { approved; note? }` (C18) and `TuiConfirmer.resolveDetailed`, instead of widening `confirm()`'s return type | Strictly additive: `engine.ts:1126` keeps calling `confirm()` until it opts in; `alwaysDecline`, the readline confirmer, bench and test fakes compile unchanged (tsc shows the widening breaks the consumer). Also closes jev-native's `d`-note hole. |
| composer-first | Make every event extension optional (`run:ready.sessionId?`, `parentRunId?`, `sandbox?`, `noNetwork?`, `maxReplans?`; `run:end.exitCode?`, `paths?`, `resumable?`; `SpendSnapshot.parentExceeded?`; `PromptInput.humanDirective?`) as in C9/C10/C17 | `run-events.json`, `test/unit/bench/helpers.ts`, `fixtures.ts` and `generator-only` paths keep compiling; readers already tolerate absence (`store.ts` `isCheckpointState` checks v1 fields only). |
| composer-first | The `Interrupt = { ctrlCArmedAt, escArmedAt, ctrlDArmedAt }` pure reducer over `(state, key, nowMs)` (§3.3) with the 30 ms Esc re-buffer as an injected clock | Makes every F5 cell a table test with fake timestamps; minimal-robust's `resolveKey` has the states but not the armed-timer shape spelled out. |
| composer-first | `Extract<EngineEvent, { type: 'retry' }>['cause']` (or a named `RetryCause`) for `RetryInfo.cause`, and `sleep(ms, signal?, wake?: EventTarget)` on `core/time.ts:44` with `client.ts:353`/`sse.ts:302` passing it | The optional third parameter is the smallest additive waker; `client.ts:199` already injects `deps.sleep`. Replaces both `Engine.retryNow()` (a fifth Engine method) and the C11 conditional type. |
| sessions-long-horizon | Per-step post-image hashing cap (64 MiB → `hashSkipped: true`, Q33) alongside the 200-file / 16 MiB pre-image cap | At 0.6 ms/MiB (15 §4) an uncapped `run` artefact hashes on the loop for hundreds of ms; the 50 ms harness budget is otherwise unguarded in all three other designs. |
| sessions-long-horizon | `undoLog` carried in the *next* run's `CheckpointState` via the seed, the finished run getting `post/<N>.undone.json` + an index `undo` line (§22) | The only reading of A143 that never rewrites a committed `state.json` (DESIGN §9, R21); the finished run stays byte-identical for the bench. |
| sessions-long-horizon | Seed-source rule "most recent run of the session with `state.step > 0`, else the most recent run" (§8.9) and `run.lock { pid, startedAt, host }` with `process.kill(pid, 0)` liveness, released in `finish()` (§8.4) | Closes 00 §8 items 13 and the step-0 follow-up case (401 at step 0) that the other designs' `session.last` seeding would feed a plan-less parent. |
| sessions-long-horizon | §8.10 backward-compatibility section and the §8.9 ten-run state table as an engine/session integration test | Legacy `run.json` classification, envelope version pinned at 1, `bench/metrics.ts` handling of the two new reasons; the table is a ready-made assertion script for meter/index/seed/exit-code interplay. |
| sessions-long-horizon | `SpendSnapshot.parent?: { totalUsd; capUsd }` filled by `createSpendMeter(cap, parent)` from `parent.snapshot()` (§15 item 7), so the *engine* emits session-scope `budget:warn` after every `meter.add()` | Session thresholds fire mid-run (F8 "each scope") without the engine knowing the parent object and without a controller-side hook; fixes jev-native's run-end-only timing. Keep the field optional. |
| jev-native | `SpendMeter.setCap?(capUsd: number): void` (optional) implemented in `createSpendMeter` (cap becomes `let`) as the mechanism for `/budget session-spend-cap` | The only design that names a mechanism; sessions-long-horizon's root recreation orphans the live child's `parent` closure (`meter.ts:88-90`), composer-first and minimal-robust name none. Optional keeps fakes compiling. |
| jev-native | `DecisionRow { consumedBy, near, cDerived, text }` model (§7.1) and the `w`+digit → `/why` block over the last 3 steps' rows kept in the reducer | Pure function over `Decision` rows already in `useEngine.tsx`; zero engine change (A47); the `consumedBy` table is DESIGN §6 verbatim and is what makes the pane Jev-native rather than a log. |
| jev-native | Review deferral mechanics: `visibleAt = max(now, lastKeystrokeAt + 1000)`, a 100 ms re-check, and entering the `review` key context only on the frame *after* the box is drawn (§6.4) | The A41 rule "a typed-ahead `y` must not approve" is otherwise stated but not mechanised; this is the testable form. |
| jev-native | Wizard refund in `computeLayout` (`rem += L.composer; L.composer = 0` when the overlay is the input, §2.1) | F10's wizard replaces the composer; minimal-robust keeps a `> (setup)` row and sessions-long-horizon's frames drop it while its function does not — take the explicit refund and test it. |

---

## 4. Issues shared by all four (must be settled in the final design; D12)

1. **Renderer-only `<Static>` items break the three-way line identity as stated.** `/why`, `/plan`, `/decisions`,
   `/diff`, `/cost`, `/config`, help blocks, the session-mode epilogue and the `you:`/`user` turn are appended by the
   renderer (composer-first §7.4, jev-native §7.4, minimal-robust §15 item 18 `Renderer.notify?(item)`,
   sessions-long-horizon §15 item 18 `Renderer.notify?(e)`), but `transcript.log` is written only by
   `EngineImpl.recordTranscript` (`engine.ts:583-590`) from engine events. Either these items are mirrored to the run's
   `transcript.log` through `store.appendTranscript` (a renderer→store hook, numbered by the engine's counter), or DESIGN
   §10's identity claim is narrowed to engine-produced lines. composer-first §15.2 ("every new item kind is produced by
   `itemsFromEvent` and nowhere else") contradicts its own §7.4; the other three are silent. The `user` event's emitter
   (engine vs bus) is unspecified everywhere; if it is bus-only, `transcript.log` lacks the human turn.
2. **Engine fakes.** Every design adds required `Engine` methods (`steer`, `unsteer`, `pause`, plus `retryNow`/`pending`/
   readonly fields). The implementers that must change are `src/loop/engine.ts`, `test/unit/bench/helpers.ts:240`,
   `test/fixtures/tui/fixtures.ts:106`, `test/unit/bench/jev-only.test.ts` and `test/unit/tui/reducer.test.ts`
   (`generator-only.ts` delegates to `createEngine` and needs nothing). Only composer-first names any of them.
3. **Ctrl-D with a live run.** F5: "second press within 800 ms exits (confirm if a run is live)". jev-native and
   minimal-robust render an explicit `[y/N]` box on the second press; composer-first and sessions-long-horizon abort and
   exit on the second press with the first-press hint as the only confirmation. Pick one and put it in the D2 table.
4. **Loop-budget hygiene for human commands.** `/calibration` (and `/diff`'s numstat parse) must be idle-only or run
   off-thread; two designs allow them while live. `detectSecrets` per keystroke (< 0.001 ms at 2 KB) and the 1 Hz retry
   tick are fine.

---

## 5. Verification log

- `computeLayout` ports: `/tmp/judge/layouts.mjs` (node 22), states listed in §2 above; outputs quoted where they
  disagree with a design's table or frame.
- `tsc --noEmit --strict` (repo `node_modules/.bin/tsc`) on `/tmp/judge/ts/check.ts`: jev-native `SteerResult` →
  `TS1109`/`TS1005`; composer-first C11 → `TS2322 … not assignable to type 'never'`; `Promise<boolean | ConfirmVerdict>`
  consumed as today's `engine.confirm()` does → `TS2322 … not assignable to type 'boolean'`.
- Code facts relied on: `engine.ts:492-495` (second Ctrl-C → `forceExit(130)`), `:560-571` loop top, `:1121-1139`
  `confirm()`, `:1141` `commonState`, `:1168` `promptInput`, `:861` `directive`, `:1300` `commit`, `:1463` `finish`,
  `:1580` `createEngine`; `time.ts:44` `sleep(ms, signal?)`; `client.ts:199, :353`; `sse.ts:289-302`; `stop.ts:15-29`
  `exitCodeFor` default → 4; `plan.ts:16, :96, :163-168`; `loopdetect.ts:196-204` `onReplan` already resets counts;
  `directive.ts:104-108` `parseDirective` → `FALLBACK_MOVE`; `meter.ts:41-93` (`cap` const, `child()` closes over `meter`);
  `files.ts:100-121` four git spawns; `git.ts:85-160`; `paths.ts:125`; `validate.ts:96, :116-123`; `defaults.ts:10, :42-47`;
  `resolve.ts:208`; `perf/first-frame.ts:27` `SENTINEL = 'step 0/'`; `bin/jevcode.js` Node guard + `NO_COLOR` shim
  present; `AppContext.d.ts` `suspendTerminal()` no-callback form; `render.d.ts` `Instance.clear()`, `kittyKeyboard`,
  `isScreenReaderEnabled`.
