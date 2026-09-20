# 14. Cost guardrails for an interactive multi-run session

Research note for the JevCode TUI programme. Date of every fetch and measurement: 2026-09-20. Machine for
measurements: Apple Silicon, macOS 26 (Darwin 25.6.0), Node 22.23.2, ink 7.1.1, react 19.3.0,
ink-testing-library 4.0.0, string-width 8.2.2 (versions read from
`/Users/prateekjannu/Documents/vscode/JevCode/node_modules/*/package.json`, 2026-09-20). Scripts under
`/tmp/jev-cost/` (`measure.mjs`, `measure2.mjs`, `bench-status.mjs`, `bench-index.mjs`, `bench-render.tsx`).

Line references are to the working tree at `/Users/prateekjannu/Documents/vscode/JevCode` on 2026-09-20.

## 0. Why this file exists, and what could not be verified

The adopted session model (00-SUMMARY A52, A58; 10 §15.1–15.2) makes every follow-up prompt a **new run** with
its own `SpendMeter`, and 10 §15.2 rule 5 says so in one clause: "Spend, wall time, loop detector,
`resolvedJevModel` start fresh per run (budgets are per run; the status line shows run and session totals, the
latter summed from the index)". Nothing else in the 8,538 lines of `docs/research/tui/*` designs a session cap,
warning thresholds, the `spend_cap` stop in session mode, unknown-pricing behaviour, or `--json` budget events;
06 §11 has the only guardrail sentence ("Anything the user must not miss (budget stop, sandbox degraded,
spend > 80 %) should also be a `<Static>` transcript item so it survives the toast"). This file closes that gap.

UNVERIFIED items (what was tried):
- opencode's **per-message** `cost` schema field. `packages/opencode/src/session/message-v2.ts`,
  `packages/core/src/v1/session.ts` and `packages/schema/src/session-v1.ts` (all
  `https://raw.githubusercontent.com/anomalyco/opencode/dev/...`, fetched 2026-09-20) each re-export from another
  module and show no zod fields. The **session-level** cost display is verified (§3.6).
- Claude Code `/docs/en/errors` bodies for the spend-limit entries: only the headings were returned (page
  truncated by the fetch tool, 2026-09-20). Headings are quoted in §3.1; the offered actions are not.
- Claude Code's exact 75 %/95 % warning *text*: the gateway page states the thresholds but not the string
  (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits, fetched 2026-09-20).
- Absolute Ink render times in §2.4 are from a `tsx`-transpiled harness in `/tmp` and are not comparable with
  11 §3.1's 3.13 ms figure; only the with/without-session-meter delta is used.

## 1. What JevCode does today (code facts)

### 1.1 The meter (`src/spend/meter.ts`)

- `sanitiseCap`: "NaN or negative caps fail closed (0); +Infinity means \"no cap\" and is kept" (line 37).
- `exceeded()` is `totalUsd() >= cap || parentExceeded()` (lines 60–62): a **parent** meter's exhaustion already
  trips every child. The bench uses exactly this: `deps.createSpendMeter(opts.spendCapUsd)` as root and
  `root.child(taskSpendCapUsd)` per run (`src/bench/runner.ts` 354; DESIGN §13). A session cap is therefore a
  parent meter, not a new mechanism.
- `add()` "records (and forwards to the parent) first, then evaluates" (`src/core/types.ts` 1702); `restore()`
  "restores this meter only, does not re-add to the parent" (types.ts 1705; meter.ts 80–86). Consequence for
  sessions: a `--resume` inside a session must seed the **session** meter from the index/state files, because the
  run meter's `restore()` will not forward the stored spend upward.
- `SpendSnapshot { generator, jev, totalUsd, capUsd, exceeded }` (types.ts 1700) has no field saying *which*
  meter tripped; `bench/runner.ts` 579 reconstructs it (`childTripped || benchCapFired`).

### 1.2 Where the cap is checked, and the overrun bound

`checkBudgets` (`src/loop/budget.ts` 10, 33–52) runs `spend_cap` first, at step start (engine.ts 564:
`` `budget ${budget} reached at step start` ``) and immediately before execute (engine.ts 1045–1050:
`` `budget ${b} reached before execute; step ${step} discarded` ``). DESIGN §6: "Overrun is therefore bounded by
one generator call plus one judge call". Measured on the one `spend_cap` run on disk
(`~/.jevcode/runs/20260920-061350-u3gx4e34`): total $1.5318 against a $1.50 cap, **$0.0318 over (2.12 %)**,
last committed step 23 cost gen $0.1268 + jev $0.0020, `stoppedAt: step_start`; transcript tail
`[run] budget spend_cap reached at step start` / `[run] warn: stop: spend_cap at step 23` /
`[run] end spend_cap steps=23 wall=3m47s cost=$1.532 (gen $1.475, jev $0.056)` (`/tmp/jev-cost/measure2.mjs`).
Across 2,808 committed steps the per-step cost is p50 $0.023, p95 $0.046, p99 $0.065, max $0.135 (§2), so
"one step" of overrun is ≤ $0.14 in practice.

### 1.3 How a dollar figure is produced, and the fail-open hole

- Anthropic provider: `costFromPricing(cfg.pricing, out.tokens)` (`src/provider/anthropic.ts` 323;
  `src/provider/sse.ts` 322–324: `(t.input*p.inputPerM + t.cacheRead*p.cacheReadPerM + t.cacheWrite*p.cacheWritePerM
  + t.output*p.outputPerM) / 1e6`).
- OpenRouter provider: `out.cost ?? costFromPricing(cfg.pricing, out.tokens)` (`src/provider/openrouter.ts` 283;
  comment 282: "usage.cost is what OpenRouter bills; pricing is the fallback for BYOK / missing cost").
- Jev: `costUsd: response.usage.cost` (`src/jev/client.ts` 327); STATUS.md line 62 verifies
  "cost = tokens × 4.2e-8" live.
- Pricing table `PRICING_TABLE` (`src/config/defaults.ts` 34–38) has **three** keys: `claude-sonnet-5`,
  `anthropic/claude-sonnet-5`, `anthropic/claude-sonnet-5-20260630`. `lookupPricing` returns
  `{ pricing: ZERO_PRICING, known: false }` for anything else, with the comment "Unknown model: zeros plus a
  warning the caller surfaces once, so cost accounting is visibly off rather than silently wrong" (defaults.ts 40).
- `validateGenerator` (`src/config/validate.ts` 116–125) applies `JEVCODE_PRICE_IN_PER_M` / `_OUT_PER_M` to
  `inputPerM` / `outputPerM` **only** (cache read/write stay at 0 for an unknown model) and calls
  `` warn(`generator.model "${model}" has no pricing entry; costs default to $0/M unless JEVCODE_PRICE_IN_PER_M and
  JEVCODE_PRICE_OUT_PER_M are set`) ``.
- The warning goes into `ResolvedConfigWithDiagnostics.warnings` (`src/config/types.ts` 66–68), and **`jevcode run`
  never prints it**: `src/cli/main.tsx` prints only `loaded.warnings` (line 145, resume path); `grep -rn "\.warnings"
  src/` finds no other consumer (2026-09-20). Result: `--provider anthropic --model <anything not in the table>`
  runs with `cost gen $0.000` forever and the cap can never fire. This is the `?`-cost case the brief asks to fail
  closed; today it fails **open and silently**.
- `JEVCODE_PRICE_*` have no flag (`SettingSpec.flag` absent, defaults.ts 50–51; `src/config/types.ts` 34).

### 1.4 Overrides on resume (`src/config/resolve.ts` 396–470)

`reconcileResumeConfig` diffs `limits.spendCapUsd`, `limits.maxSteps`, `limits.maxReplans`, `limits.maxWall` and
appends `{ setting, from: String(from), to: String(to), atStep }` (types `ResumeOverride`, `src/config/types.ts`
113–118; `RunMeta.overrides`, `src/core/types.ts` 661). A stored `spend_cap` whose cap was not raised is an
immediate stop with the verbatim message
`` `stopped: spend_cap (spent $${s.spendTotalUsd.toFixed(4)}, cap $${limits.spendCapUsd}); raise --spend-cap above
${s.spendTotalUsd.toFixed(4)} to continue` `` (resolve.ts 459), exit 4 (`main.tsx` 141–145). **0 of 216** run
dirs on disk have a non-empty `overrides[]` and 2 have `resumes[]` (§2), so the mechanism exists but is unused
from the CLI in practice.

### 1.5 What the UI shows today

- Status line (`src/tui/StatusLine.tsx` 36–44), verbatim fields joined by two spaces:
  `` `cost gen ${usd(s.generator.costUsd)} jev ${usd(s.jev.costUsd)} / cap ${usd(s.capUsd)}${s.exceeded ? ' EXCEEDED' : ''}` ``,
  `usd()` = `$x.toFixed(3)` (`src/tui/plain.ts` 92–94). Pinned by
  `test/unit/tui/reducer.test.ts` 94 (`cost gen \$0\.120 jev \$0\.010 \/ cap \$2\.000`). No threshold, no colour, no
  session figure; `EXCEEDED` is the only word and it appears after the fact.
- Plain/transcript `run:end` (`plain.ts` 263–271):
  `` `end ${r.stopReason} steps=${r.steps} wall=${formatDuration(r.wallMs)} cost=${usd(gen+jev)} (gen ${usd(gen)}, jev ${usd(jev)})` ``.
- Non-interactive epilogue (`main.tsx` 204): `stop: <reason> after <n> steps, $<gen> generator + $<jev> jev; run <id>`.
- `--json` exists only on `jevcode config` (`src/cli/args.ts` 112); 10 §15.10 proposes `jevcode run --plain --json`
  as redacted `EngineEvent` JSONL. There is no budget event in `EngineEvent` (types.ts 806–837): a script can only
  infer the cap from `status` payloads.

### 1.6 The adopted session model, restated for cost

A52: "Session = ordered runs in one workspace; `sessionId` = first run id ... follow-up = new run seeded with the
parent's `plan.done`/`remaining`/`unverified`". A58: "`/model`, `/provider`, `/mode`, `/budget` apply to the next
run only". 10 §15.5: `~/.jevcode/sessions/index.jsonl` with
`{ t, kind: 'run:end', sessionId, runId, stopReason, steps, costUsd: { generator, jev }, wallMs, changedFiles: n }`.
So: the run cap is fully specified; the session total is "summed from the index"; **no cap, threshold, or
confirmation exists at the session level by construction**.

## 2. Measurements

### 2.1 Run directories (`/tmp/jev-cost/measure.mjs`, `measure2.mjs`, 2026-09-20)

| What | Value |
| --- | --- |
| `~/.jevcode/runs` | 217 dirs matching the run-id regex; 216 with parseable `state.json` (no `sessions/` dir exists yet) |
| `stopReason` | max_steps 122, generator_done 37, complete 35, max_replans 9, replan_stop 7, null 5, **spend_cap 1** (0.46 %; 10 §14 saw 1 of 140) |
| mode | jev-on 74, jev-off 66, jev-only 76 |
| `spend.capUsd` | $0.10 ×76 (jev-only bench), $1.50 ×73 (SWE-bench), $2.00 ×62 (CLI default), $0.80 ×3, $0.60 ×1, $1 ×1 |
| runs with spend > 0 | 186 (30 are zero-cost mocks) |
| per-run total, all live | min $0.0002, p25 $0.0042, p50 $0.0083, p75 $0.682, p90 $0.847, p95 $0.959, max $1.532; sum $55.45 |
| jev-on (n=74) | total p50 $0.152, p90 $0.984, max $1.532; gen p50 $0.146; **jev p50 $0.027, p90 $0.056, max $0.063; Jev share p50 8.7 %**; steps p50 21; cost/step p50 $0.015, p90 $0.040 |
| jev-off (n=36) | total p50 $0.706, p90 $0.847, max $0.954; steps p50 25; cost/step p50 $0.028 |
| jev-only (n=76) | total = Jev: p50 $0.0043, p90 $0.0073, max $0.060; steps p50 12; cost/step p50 $0.0004, p90 $0.0010; Jev calls p50 43, max 248 |
| per-step, 2,808 `steps.jsonl` records (194 MB scanned in 2.1 s) | total p50 $0.023, p90 $0.040, p95 $0.046, p99 $0.065, max $0.135; gen p50 $0.022, max $0.132; jev p50 $0.0004, p95 $0.0025, max $0.017 |
| spend / cap ratio at run end (186 live runs) | p50 4.7 %, p90 56.8 %, p95 63.9 %, max 102.1 %; **≥ 50 %: 34 runs, ≥ 80 %: 4, ≥ 95 %: 1** |
| overrides / resumes | `run.json.overrides.length > 0`: 0 runs; `resumes.length > 0`: 2 runs |
| provider / model | `anthropic/claude-sonnet-5` 136 runs (priced from the table), `openrouter/anthropic/claude-sonnet-5` 80 (priced from `usage.cost`) |
| pseudo-sessions (same workspace, < 60 min gap) among the 62 `$2` CLI runs | 62 sessions of exactly 1 run each: **no multi-run session exists on disk**; session-level spend cannot be measured, only extrapolated |

Reading: 50/80/95 % thresholds on the **run** cap would have fired in 34/4/1 of 186 live runs; the 50 % warning is
frequent enough to be informative and rare enough not to be noise. The Jev split is small in jev-on (p50 8.7 % of a
run, $0.0004 of a $0.023 step) and 100 % in jev-only, where a $0.10 cap already held all 76 runs (max $0.060).
Live anchors from `docs/STATUS.md` (2026-09-20): "`01-fix`, 9 steps, $0.115" (line 64); "60 runs, $46.25 total ...
cap not hit" at "$1.50 per run" (lines 71–74); jev-on "Jev itself cost $1.49 for 212k questions" (line 98),
≈ $7.0e-6 per question.

### 2.2 Session totals from the index (`/tmp/jev-cost/bench-index.mjs`)

Synthetic `index.jsonl` with one `run:start` + one `run:end` line per run at 275 B/line (10 §14 measured 284 B):

| Runs | Lines / bytes | read + `JSON.parse` + fold `run:end` by `sessionId`, best of 20 |
| --- | --- | --- |
| 141 | 282 / 77,503 B | **0.26 ms** |
| 1,000 | 2,000 / 549,652 B | 1.42 ms |
| 10,000 | 20,000 / 5,496,652 B | 13.4 ms |

Reading: fold **once** at session open (or `/resume`) and keep the session total in memory, adding each
`run:end` as it arrives; never re-fold per frame or per `status` event (a 13 ms fold on the render path would
break the 5 ms render p95 gate, DESIGN §12).

### 2.3 Status-line string with a session meter (`/tmp/jev-cost/bench-status.mjs`)

| Variant | Cost per build | Width |
| --- | --- | --- |
| today's 5 fields | 0.63 µs | 106 cols |
| run + session meters, two 10-cell bars, two level words | 1.12 µs | 130 cols |
| `string-width` of the 130-col line (block glyphs) | 57 µs per call | — |

Both are noise against the 20 fps coalescer; the width is the real constraint (§5.1): the full form needs
≥ 120 columns, and 11 §4g's rule "unchanged text at < 100 columns" applies.

### 2.4 Ink re-render with a session meter (`/tmp/jev-cost/bench-render.tsx`, ink-testing-library 4.0.0)

400 status re-renders of a `<Static>` + one-row `<Box height={1} overflow="hidden"><Text wrap="truncate">` tree:
**9.30 ms/re-render with the run meter only vs 8.89 ms with run + session meters** (delta within noise); one extra
`<Static>` item (a `budget:warn` line) cost 17.7 ms once in both variants. The absolute numbers come from a
`tsx`-transpiled harness run from `/tmp` (not the repo's build) and should not be compared with 11 §3.1's
3.13 ms; the finding is that the session meter adds no measurable render cost, and that a threshold item is a
one-off, not per frame.

## 3. Prior art (primary sources, fetched 2026-09-20)

### 3.1 Claude Code

- `/cost` "Alias for `/usage`"; the Session block prints `Total cost: $0.55 / Total duration (API): 6m 20s /
  Total duration (wall): 6h 33m 10s / Total code changes: 0 lines added, 0 lines removed / Usage by model: ...`;
  "These totals reset when `/clear` starts a new session, so the next session's total cost starts at $0";
  "Claude Code computes the dollar figure locally from token counts at list price, unless a `modelPricing` table is
  in effect"; "Across enterprise deployments, the average cost is around $13 per developer per active day and
  $150-250 per developer per month, with costs remaining below $30 per active day for 90% of users"
  (https://code.claude.com/docs/en/costs).
- `--max-budget-usd`: "Maximum dollar amount to spend on API calls before stopping (print mode only). Spend from
  subagents counts toward the cap. Once spend reaches the cap, spawning another subagent fails with `Budget limit
  reached`"; "Both flags apply to **print mode only**" (https://code.claude.com/docs/en/cli-reference). So Claude
  Code has **no interactive budget cap at all**; interactive users get warnings and plan limits only.
- `DISABLE_COST_WARNINGS`: "Set to `1` to turn off cost warnings that appear when you approach or exceed a spending
  limit. Requires Claude Code v2.1.181 or later" (https://code.claude.com/docs/en/env-vars).
- Gateway warnings: "Claude Code warns a developer as they approach their cap: once utilization passes 75%, and
  again past 95% of their most-consumed cap"; blocked requests show the gateway's `429` "as is"; the 429 text is
  "`spend limit reached (daily; resets 2026-08-08 00:00 UTC)`" with `retry-after`; unknown models are priced at
  "The unknown-model tier of $5/$25 per million input/output tokens, so an ID the meter can't place is never free.
  The gateway warns at boot and once per ID at runtime when it uses this tier"; "Client aborts are billed too ...
  a floor estimate of about four characters per output token"; store outage "fails open by default ... Set
  `enforcement.fail_closed_on_error: true` to fail closed instead, which returns the same `429 billing_error` but
  with the message `spend limit unavailable`" (https://code.claude.com/docs/en/claude-apps-gateway-spend-limits).
- Status line JSON: `cost.total_cost_usd` "Estimated session cost in USD, computed client-side at list price ...
  Resets to $0 when `/clear` starts a new session"; `rate_limits.spend_limit.used_percentage`,
  `rate_limits.spend_limit.resets_at` "The percentage runs from 0 to 100, or above 100 once you exceed the limit"
  (https://code.claude.com/docs/en/statusline).
- Error headings (bodies UNVERIFIED, §0): `You've hit your monthly spend limit`, `You've hit your individual spend
  limit`, `You've hit your org's monthly spend limit`, `You've hit your team's shared budget`, `Budget limit
  reached`, `Could not update your spend limit`, `spend limit reached`, `spend limit unavailable`
  (https://code.claude.com/docs/en/errors).

### 3.2 Claude Agent SDK

- `maxBudgetUsd: number` — "Stop the query when the client-side cost estimate reaches this USD value. Compared
  against the same estimate as `total_cost_usd`" (https://code.claude.com/docs/en/agent-sdk/typescript).
- Result subtype `error_max_budget_usd`: "`usage` leaves out the response that crossed the budget, while
  `total_cost_usd` and `modelUsage` include it"; "`maxBudgetUsd` ... is compared against the same running total, so
  a `/clear` also starts the budget over"; "The SDK doesn't provide a session-level total, so if your application
  makes multiple `query()` calls ... accumulate the totals yourself"; `modelUsage[model].costBasis` is "`list` for
  list price, `managed` for a `modelPricing` table, or `unknown` when neither matched the model ID"; the figures
  "are client-side estimates, not authoritative billing data ... Do not bill end users or trigger financial
  decisions from these fields" (https://code.claude.com/docs/en/agent-sdk/cost-tracking).

### 3.3 Codex

`/status` "show current session configuration and token usage" (04 §9, `slash_command.rs`). Rate-limit rows
(`codex-rs/tui/src/status/rate_limits.rs`): labels `"5h limit"`, `"Weekly limit"`, bar `"[{}{}]"` of 20 segments
`"█"`/`"░"` via `render_limit_progress_bar(percent_remaining, 20)`, summary `"{percent_remaining:.0}% left"`; "The
code contains no color thresholds or warning conditions". Token rows (`status/thread_usage.rs`): `"  Billed tokens"`
then `"{input_tokens} input"` `"({cached_tokens} cached)"` `"+"` `"{output_tokens} output"`;
`format_estimated_usd_micros()` renders `"~$0.0001"` / `"~$1.23"` — an estimate marker JevCode should copy
(https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/status/{rate_limits,thread_usage}.rs).

### 3.4 Gemini CLI

`/stats`, altNames `['usage']`, description `'Check session stats. Usage: /stats [session|model|tools]'`;
subcommands `'session'` "Show session-specific usage statistics", `'model'`, `'tools'`; duration
`now.getTime() - sessionStartTime.getTime()`
(https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/commands/statsCommand.ts).

### 3.5 aider

Per message: `cost_report = f"Cost: ${format_cost(self.message_cost)} message, ${format_cost(self.total_cost)}
session."` (05 §12; https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py). Unknown
model: `"Model foobar: Unknown context window size and costs, using sane defaults."` and aider "proceeds with the
chat session ... assumes the model is free" (https://aider.chat/docs/llms/warnings.html) — the fail-open
anti-pattern. `--show-model-warnings` "Only work with models that have meta-data available (default: True)";
`--max-chat-history-tokens VALUE` "Soft limit on tokens for chat history, after which summarization begins"
(https://aider.chat/docs/config/options.html) — a token, not dollar, guardrail.

### 3.6 opencode

Sidebar context widget: `tokens = last.tokens.input + last.tokens.output + last.tokens.reasoning +
last.tokens.cache.read + last.tokens.cache.write`, `Math.round((tokens / model.limit.context) * 100)`, rendered
`"{state().tokens.toLocaleString()} tokens"`, `"{state().percent ?? 0}% used"`, `"{money.format(cost())} spent"`
where cost is `session()?.cost ?? 0` — session-level, "no conditional styling based on thresholds"
(https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/feature-plugins/sidebar/context.tsx).
The footer renders no cost at all (`.../routes/session/footer.tsx`, same date).

### 3.7 Conventions already adopted elsewhere in this programme

- Toasts: lazygit "delay := lo.Ternary(kind == types.ToastKindError, time.Second*4, time.Second*2)"; under the height
  budget "toast text *replaces* the status-line left zone for 2 s / 4 s ... Anything the user must not miss ...
  should also be a `<Static>` transcript item" (06 §11).
- Confirms: clig.dev "Never _require_ a prompt", "If `--no-input` is passed, don't prompt"; JevCode review prompt
  keeps "explicit `y`/`n` ... **decline focused by default**, Esc = decline" (06 §12; 00 A39).
- Colour: WCAG 1.4.1 "Color is not used as the only visual means of conveying information"; "Marker + word with
  every colour; ANSI-16 named colours only" (06 §13, ADOPT; 12 §3.2).
- Notifications: BEL universal; OSC 9 "To post a notification: OSC 9 ; [Message content goes here] ST"; "Never
  start an OSC 9 payload with a digit and semicolon" (ConEmu progress conflict); tmux needs `allow-passthrough on`;
  adopted policy "emit BEL by default; emit OSC 9 additionally when `TERM_PROGRAM` ∈ {iTerm.app, ghostty, WezTerm}
  or `TERM` ∈ {xterm-kitty, xterm-ghostty, foot*}; OSC 99 for kitty" on `confirm:request` and `run:end` when
  FocusOut (07 §2.7).
- Screen reader: dynamic region "changes only on stage transitions", announcements as `<Static>` lines, spinner
  `aria-hidden`, status `aria-label` (12 §1, ADOPT rows 1–3; 00 A94).

## 4. Decisions and specification

### 4.1 Two caps, one meter tree

- **`session.spendCapUsd`** is a new limit: flag `--session-spend-cap <usd>` > env `JEVCODE_SESSION_SPEND_CAP_USD`
  > config-file key `sessionSpendCapUsd` > default. `SettingSpec` row:
  `{ name: 'session.spendCapUsd', flag: 'sessionSpendCap', env: ['JEVCODE_SESSION_SPEND_CAP_USD'], fileKey:
  'sessionSpendCapUsd', defaultValue: null, secret: false, description: 'session spend cap (USD)' }`; `null` means
  "derived". Same precedence chain as every other setting (DESIGN §3), recorded with its `source` in `run.json`.
- **Default = 5 × `limits.spendCapUsd`**, resolved to an absolute number once at session start (so a later
  `/budget spend-cap` does not silently move the session cap). With the $2.00 run default that is **$10.00 per
  session**: ≈ 65 median jev-on runs ($0.152), ≈ 10 p95 runs ($0.96), below Claude Code's "$13 per developer per
  active day" average (§3.1) and above any single run on disk (max $1.53). For `--mode jev-only` the run default
  should drop to **$0.25** (76 runs, max $0.060, all under the $0.10 bench cap; 4× headroom) and the session
  default follows at $1.25. Precedence for the mode-aware default: an explicit value from any layer wins.
- Parsing: `sanitiseCap` rules apply (NaN/negative → 0 = spend nothing). The literal `none` (flag/env/file) maps to
  `+Infinity`, the only way to get "no session cap"; it is echoed in `jevcode config` as `none (no session cap)`.
  A session cap below the run cap is allowed and clamps the run (below).
- **Implementation**: one root `SpendMeter` per session, `createSpendMeter(sessionCapUsd)`; every run in the
  session gets `sessionMeter.child(min(runCapUsd, remaining))` where `remaining = sessionCap − sessionSpent`
  (the clamp makes the *run* stop with `spend_cap` exactly at the session cap; no new `StopReason`). Add
  `parentExceeded: boolean` to `SpendSnapshot` (types.ts 1700) so the UI and `budget:stop` can say `by: 'session'`
  without the bench's reconstruction dance (runner.ts 579). Bench and perf runs (`source !== 'cli'`, A52) keep
  their own root and never see the session meter.
- **Seeding on `/resume` or `jevcode -r`**: fold `sessions/index.jsonl` for that `sessionId` (0.26 ms at 141 runs,
  §2.2), then for the run being resumed add `state.json.spend` of that run (its `run:end` line is absent or stale)
  and call `sessionMeter.add(source, usage)` per source. Because `restore()` never forwards to the parent (§1.1),
  the run meter is restored **after** the session meter is seeded, and the parent is never double-counted. If the
  index is unreadable the picker cannot list the session anyway (10 §15.6); a `run.json` without `sessionId`
  (pre-session run) resumes as a one-run session with `sessionSpent = state.spend.totalUsd`.
- Session spend is recomputed only on these events: session open, `run:end`, `budget:override`. Between them the
  in-memory root meter is authoritative; the index is the durable record.

### 4.2 Thresholds 50 / 80 / 95 %: one event, four surfaces

- New `EngineEvent` member, emitted by the engine right after each `meter.add()` (both sources) and once per
  `(scope, pct)` per run for `run`, per session for `session`:
  `{ type: 'budget:warn'; scope: 'run' | 'session'; pct: 50 | 80 | 95; spentUsd: number; capUsd: number; step: number; runId: string; sessionId: string }`.
  If one `add()` crosses two thresholds (a $0.13 step can jump 50 → 80 at a $0.25 jev-only cap), emit only the
  highest. On resume, thresholds already passed by the restored spend are re-emitted once with the transcript text
  suffixed ` (restored)` so a resumed transcript still explains the state. `budget:warn` never fires for a cap of
  `+Infinity`.
- **Surface 1 — `<Static>` transcript item** (06 §11 rule; survives scrollback; zero dynamic rows). Exact text,
  `usd()` formatting, percentage as an integer with a space before `%` (house style, 06 §11):
  `[run] budget: run spend $1.000 is 50 % of the $2.000 run cap`
  `[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps left at $0.040/step`
  `[run] budget: run spend $1.900 is 95 % of the $2.000 run cap — stops before the next step that would exceed it`
  `[run] budget: session spend $8.000 is 80 % of the $10.000 session cap — 3 runs so far; /budget session-spend-cap <usd> raises it`
  The "about N steps left" figure is `floor((cap − spent) / meanCostPerStep)` over this run's committed steps;
  omitted at step 0. Level words: `50 % → half`, `80 % → high`, `95 % → critical` (used on the meter, below);
  colours yellow at 80, red at 95, dim otherwise, **always with the word** (WCAG 1.4.1, 06 §13).
- **Surface 2 — toast**: the same sentence without the `[run] budget: ` prefix replaces the status line's left
  zone for 2 s (4 s at 95 %) with a `!` marker (lazygit model, 06 §11). No extra row.
- **Surface 3 — status-line meter**: `run $1.60/$2.00 ████████·· high` (10-cell eighth-block bar as in 11 §4g;
  `·` empty; **word after the bar**). At < 100 columns drop the bar and tokens, keep `run $1.60/2.00 high`.
- **Surface 4 — opt-in BEL / OSC 9**: config `ui.notify: 'off' | 'bell' | 'desktop'` (flag `--notify`), default
  `off` for `budget:warn` 50/80 and **on for 95 % and `budget:stop` only when the terminal has reported FocusOut**
  (07 §2.7 policy). Payload is a redacted one-liner that never starts with a digit: `JevCode: run spend 95 % of the
  $2.00 cap` (OSC 9 `ESC ] 9 ; <text> ESC \`), BEL `\x07` otherwise; tmux passthrough when `TMUX` is set. Never in
  `--plain`, `--json`, or screen-reader mode (BEL re-announces; 12 §1).
- `DISABLE_COST_WARNINGS`-style kill switch: `JEVCODE_BUDGET_WARNINGS=0` (env; config `ui.budgetWarnings:
  false`) suppresses surfaces 2 and 4 only. Surface 1 (the record) and the `budget:warn` JSON event are never
  suppressed — Claude Code's env var hides the warnings entirely (§3.1), which is the wrong default for a tool that
  spends real money on the user's behalf.

### 4.3 Confirming a follow-up that would exceed the session cap

Decision point: the composer's Enter while `state.done !== null` (a follow-up, 10 §15.4). Let
`remaining = sessionCap − sessionSpent`, `runCap = limits.spendCapUsd` (after `/budget`), and `lastRun` = the
previous run's total.

1. `remaining ≥ runCap` → start normally; the composer's hint row already shows `run cap $2.00 · session
   $3.42/$10.00 half`.
2. `0 < remaining < runCap` → **confirm box** (5 rows, inside the `rows − 2` budget; the decisions pane shrinks
   first, exactly like the review box, DESIGN §10). Keys: `y` start with the run cap clamped to `remaining`;
   `r` open `/budget session-spend-cap` prefilled with `sessionCap + runCap`; `n` or `Esc` cancel (the text stays
   in the composer). **Enter does nothing** (no default; clig "severe" class, 06 §12) and the keys line is row 2 so
   it survives at rows 12. The composer is inactive while the box is up; a stale keypress cannot start a run.
3. `remaining ≤ 0` → refuse: `<Static>` item
   `[run] session cap reached ($10.31 of $10.00). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.`
   plus the same sentence as a 4 s toast. No box; nothing to confirm.
4. `--plain` and `--json` scripts never see a prompt (clig "Never _require_ a prompt"): case 2 clamps silently and
   emits `budget:clamp` (below); case 3 exits 4 with the case-3 sentence on stderr and a `budget:stop
   { scope: 'session', at: 'follow-up' }` event.

### 4.4 The `spend_cap` stop in session mode

Today a `spend_cap` stop ends the process with exit 4 (`main.tsx` 204; `stop.ts` 26). In the session TUI the
process stays alive (10 §15.4) and the transcript needs an **epilogue** that names the fix, because a follow-up
(new run) would otherwise be the path of least resistance and would silently reset the cap (A52). Items appended
after the existing `run:end` line:

```
[run] end spend_cap steps=23 wall=3m47s cost=$1.532 (gen $1.475, jev $0.056)
[run] stopped by the run spend cap: $1.532 of $1.500 (over by $0.032, one judge call). Session $4.11/$10.00 ok.
[run] continue this run:  /budget spend-cap 3.00   then   /resume     (raises the cap for 20260920-061350-u3gx4e34 only; recorded in run.json.overrides[])
[run] or start a follow-up run with a fresh $1.500 cap: type a prompt and press Enter
```

- `by: 'session'` variant of line 2: `stopped by the session spend cap: session $10.02 of $10.00 (this run $0.52
  of a $2.000 cap clamped to $0.50)`; line 3 becomes `/budget session-spend-cap 15.00` and line 4 is replaced by the
  §4.3 case-3 refusal.
- `/budget spend-cap <v>` semantics (A58 said "next run only"; sharpened here): the value is stored in the session
  as the pending run cap and applies to **whichever comes first**, the next `/resume` of the stopped run
  (through `reconcileResumeConfig`, which records `{ setting: 'limits.spendCapUsd', from: '1.5', to: '3', atStep:
  23 }` in `run.json.overrides[]`, resolve.ts 438) or the next new run (where it is simply the run's config with
  `source: 'session:/budget'`). Argument validation: must be a finite number > current spend of the run it will
  apply to; rejection text `budget: spend-cap 1.20 is not above this run's spend $1.532; give a larger value`.
  `/budget` with no argument prints both caps, both spends, and the pending values.
- `/budget session-spend-cap <v>`: raises (or lowers, if ≥ spent) the root meter's cap immediately; appended to
  `sessions/index.jsonl` as `{ t, kind: 'budget', sessionId, setting: 'session.spendCapUsd', from, to, atRun:
  runId }` (a fifth line kind for 10 §15.5). `none` allowed, echoed as a red `critical` word `uncapped` on the
  meter so the state is never invisible.
- The `--resume` immediate-stop path stays as is (resolve.ts 459); in the TUI the same string is shown as a
  `<Static>` item instead of an exit, followed by the epilogue's line 3.

### 4.5 Unknown pricing fails closed (`$?` is not a number a cap can compare)

Today's behaviour is fail-open twice over (§1.3): zero pricing and a dropped warning. Decision:

1. `validateGenerator` returns `pricing` plus `priced: boolean` (known table entry, or overrides for **all four**
   rates). Add `JEVCODE_PRICE_CACHE_READ_PER_M` and `JEVCODE_PRICE_CACHE_WRITE_PER_M`; when only in/out are given,
   derive cache read = 0.1 × in and cache write = 1.25 × in (the Sonnet 5 table ratios 0.2/2 and 2.5/2,
   defaults.ts 31) and say so in the `jevcode config` source column (`derived from priceInPerM`).
2. `jevcode run` with `provider === 'anthropic'` and `priced === false` **refuses to start** (exit 2,
   `ConfigError`, setting `generator.model`):
   `generator.model "claude-foo" has no pricing entry, so the $2.000 spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.`
   This is the gateway's "never free" principle (§3.1) applied at the client, and the opposite of aider's "using
   sane defaults" (§3.5).
3. `--allow-unpriced` (boolean flag, no env) switches the run to a **token cap**: `limits.maxGeneratorTokens`
   (flag `--max-generator-tokens <n>`, env `JEVCODE_MAX_GENERATOR_TOKENS`, default `spendCapUsd / 15 × 1e6` tokens,
   i.e. the tokens $2.00 buys at the gateway's $5/$25 unknown tier weighted 2:1 input:output ≈ 133k tokens — the
   conservative tier keeps the *cost* bounded even when the *price* is unknown). Budget kind `token_cap` joins
   `BUDGET_ORDER` after `spend_cap`; StopReason `'token_cap'` (exit 4 family). Cost fields render as `$?` and the
   status line shows `gen 43.1k/133k tok` in place of dollars; `run:end` prints `cost=$? (unpriced; 96.2k tokens)`.
   Jev cost stays real (it comes from `usage.cost`).
4. OpenRouter: `out.cost ?? costFromPricing(...)` (openrouter.ts 283) must become `out.cost ?? (priced ?
   costFromPricing(...) : unpriced())`; a `null` `usage.cost` with unknown pricing marks the call `unpriced` and,
   without `--allow-unpriced`, stops the run with `error` code `unpriced_usage` after the step commits (fail closed
   at the first evidence, not at start, because BYOK cost absence is only visible per response).
5. Jev: a response whose `usage.cost` is absent or non-finite is treated the same way (`unpriced_usage`); today
   `sanitiseUsage` clamps it to 0 silently (meter.ts 15–27) — keep the clamp for the meter (it must never throw) but
   surface the fact through the event.
6. Print `config.warnings` in `jevcode run` (one `jevcode: <warning>` line each on stderr in plain mode, one
   `<Static>` item in the TUI) — the dropped-warning bug in `main.tsx` is independent of everything above and is
   the smallest fix in this file.
7. Display rule everywhere: a figure that is an estimate from the table (Anthropic provider) carries Codex's `~`
   (`~$0.281`); a figure from the provider's own `usage.cost` does not; `$?` only under `--allow-unpriced`.
   `/cost` prints the basis per source, mirroring the SDK's `costBasis: list | managed | unknown` (§3.2):
   `basis: generator table (claude-sonnet-5), jev provider usage.cost`.

### 4.6 Jev cost in the picture

- Keep the `gen`/`jev` split in the status line (already there) and in every budget line; a session meter needs no
  split (one number, one bar). `/cost` adds `jev $0.056 for 1,204 questions (~$4.7e-5 each, p50 237 ms)` using
  `RunResult.jevQuestions` and `jevLatencyMs` (types.ts; `assembleRunResult`, stop.ts 71–90).
- Warning copy in jev-only mode drops the word `gen`: `[run] budget: run spend $0.125 is 50 % of the $0.250 run
  cap (Jev only)`.
- Because Jev is ≤ 9 % of a jev-on run at p50 (§2.1), a **cap that fires because of Jev alone is a bug signal**
  (a loop of questions): when `jev.costUsd > generator.costUsd` at a threshold crossing, the transcript item
  appends ` — Jev is the larger share ($0.031 vs $0.020); see /jev`.

### 4.7 `--json` events for scripts (extends 10 §15.10)

`jevcode run --plain --json` writes redacted `EngineEvent`s as JSONL. New members (no key material, no task text
beyond what `run:start` already carries):

```
{"type":"budget:warn","scope":"run","pct":80,"spentUsd":1.6012,"capUsd":2,"step":17,"runId":"2026…","sessionId":"2026…"}
{"type":"budget:stop","scope":"run","by":"run","spentUsd":1.5318,"capUsd":1.5,"step":23,"stoppedAt":"step_start","runId":"…","sessionId":"…","raise":{"command":"/budget spend-cap","flag":"--spend-cap","minimum":1.5318}}
{"type":"budget:clamp","scope":"session","runCapUsd":2,"clampedToUsd":0.42,"sessionSpentUsd":9.58,"sessionCapUsd":10,"runId":"…","sessionId":"…"}
{"type":"budget:override","setting":"limits.spendCapUsd","from":"1.5","to":"3","atStep":23,"runId":"…","sessionId":"…","source":"/budget"}
{"type":"budget:unpriced","source":"generator","model":"claude-foo","step":4,"tokens":{"input":8123,"output":512},"runId":"…"}
```

`budget:stop` is emitted immediately before `run:end` (whose `result.stopReason` is `spend_cap` or `token_cap`);
`budget:override` is emitted when `/budget` is applied (resume or new run), not when typed. A script that stops
spending on the first cap and reads the minimum to raise:

```sh
jevcode run --plain --json --session-spend-cap 6 "fix tests" \
| jq -c 'select(.type=="budget:stop") | {by, spentUsd, capUsd, min: .raise.minimum}' \
| head -1
```

Exit codes are unchanged: 4 for `spend_cap`/`token_cap`, 2 for the unpriced refusal (§4.5 item 2).

### 4.8 Plain and screen-reader twins

- `--plain`: every `<Static>` string in §4.2–4.4 is emitted verbatim as a transcript line (they are transcript
  items, so `transcript.log`, plain and TUI agree line for line, DESIGN §10). No toast, no BEL, no bar.
- Screen reader (`--screen-reader`, A94): the status line's `aria-label` gains the words only —
  `status: step 17 of 40, stage risk, run spend 1 dollar 60 of 2, high; session 4 dollars 11 of 10, ok` — and changes
  only on stage transitions and threshold crossings, never per `status` tick (12 §1 ADOPT row 2). Threshold items
  are ordinary `<Static>` lines, which Ink's SR path writes before the dynamic region (12 §1.1). Bars are dropped
  (`aria-hidden`).

## 5. Frames (80 columns unless marked)

### 5.1 Status line

```
80 columns, run meter only (bar, tokens and the `? help` hint dropped below 100 columns; 76 cells):
step 17/40  ⠹ risk  wall 4m12s/30m  run $1.60/2.00 high  sess $4.11/10.00 ok

120 columns (11 §4g layout plus the session meter; 114 cells; the gen/jev token field returns at ≥ 140 columns):
step 17/40  ⠹ risk  wall 4m12s/30m ██▏·······  run $1.60/$2.00 ████████·· high  session $4.11/$10.00 ████······ ok
```

The `step <n>/<max>` sentinel stays first (perf/first-frame.ts, DESIGN §12). `EXCEEDED` (today) becomes the level
word `over` with the same red as `critical`: `run $1.53/1.50 over`.

### 5.2 Threshold item and toast (rows unchanged; the toast overwrites the left zone for 2 s; 80 columns, the right zone truncates to fit)

```
[run] budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps left at $0.040/step
! run spend $1.600 is 80 % of the $2.000 run cap  run $1.60/2.00 high
```

### 5.3 Confirm before a follow-up (§4.3 case 2), 5 rows, keys on row 2

```
┌ follow-up would exceed the session cap ──────────────────────────────────────┐
│ [y] start, run cap clamped to $0.42   [r] raise session cap   [n]/Esc cancel │
│ session $9.58 of $10.00 (5 runs) · run cap $2.00 · last run $0.71            │
│ Enter does nothing here. A clamped run stops at the session cap (spend_cap). │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 `/cost` (committed as one `<Static>` block; 12 rows)

```
cost — run 20260920-061350-u3gx4e34 (jev-on), session 20260920-054410-a3f9k2mq (4 runs)
  run      ~$1.532 of $1.500  over      gen ~$1.475 (23 calls, 127.0k in, 12.4k out)
                                         jev  $0.056 (1,204 questions, ~$4.7e-5 each, p50 237 ms)
  session   $4.114 of $10.000 ok        4 runs: $0.115 · $0.98 · $1.49 · $1.532 (this run)
  per step  p50 $0.023, p95 $0.046, max $0.127 (step 23)   projection: cap reached; raise or follow up
  basis     generator: table (anthropic/claude-sonnet-5, ~estimate)   jev: provider usage.cost
  pending   /budget spend-cap 3.00 → applies to /resume of this run or the next run
  raise     /budget spend-cap <usd>   /budget session-spend-cap <usd>   /budget (show)
```

### 5.5 `--plain --json` excerpt at the cap

```
{"type":"transcript","step":null,"level":"info","text":"budget spend_cap reached at step start"}
{"type":"budget:stop","scope":"run","by":"run","spentUsd":1.5318,"capUsd":1.5,"step":23,"stoppedAt":"step_start","runId":"20260920-061350-u3gx4e34","sessionId":"20260920-054410-a3f9k2mq","raise":{"command":"/budget spend-cap","flag":"--spend-cap","minimum":1.5318}}
{"type":"run:end","result":{"stopReason":"spend_cap","steps":23,"usage":{"generator":{"costUsd":1.4755,…},"jev":{"costUsd":0.0563,…}},…}}
```

## 6. Edge and corner cases (decided)

| Case | Rule |
| --- | --- |
| Session cap < run cap | Child cap = `min(runCap, remaining)`; the composer hint shows `run cap $2.00 → clamped $0.42`; `budget:clamp` emitted |
| One `add()` crosses two thresholds | Emit the highest only (§4.2) |
| Resume past a threshold | Re-emit once with ` (restored)`; no toast, no BEL |
| Cap `0` | Fail closed: the first `checkBudgets` at step 0 stops with `spend_cap` before any call (budget.ts 33) — do not special-case |
| Cap `none` (+Infinity) | No warnings; meter word `uncapped` in red; `/cost` prints `no cap` |
| `/budget` below current spend | Reject with the §4.4 sentence; nothing recorded |
| `/budget` while a run is live | Session cap applies immediately (root meter); run cap is pending until the run stops (a run must stay comparable with itself, DESIGN §9) |
| Two Ctrl-C during a warning toast | Existing shutdown path; the toast is display state only |
| Torn last line in `sessions/index.jsonl` | Skip with a warning (same rule as `steps.jsonl`, DESIGN §9); the live run's spend comes from memory anyway |
| Bench / perf runs | `source !== 'cli'`: no session meter, no index lines, no warnings beyond today's bench log (runner.ts 382) |
| Unknown model, Anthropic | Refuse (exit 2) unless `--allow-unpriced` → token cap (§4.5) |
| `usage.cost` missing, OpenRouter/Jev | `budget:unpriced` + stop with `error` `unpriced_usage` after the step commits, unless `--allow-unpriced` |
| Provider abort mid-stream | Tokens already streamed are metered from the partial `usage` frame when present; when absent, treat as unpriced for that call (the gateway bills a floor estimate, §3.1; JevCode has no billing side, so record `unpriced` honestly) |
| Screen reader | Words only, no bar, no BEL, transitions only (§4.8) |
| Height budget | Threshold items are `<Static>`; toast is zero rows; confirm box 5 rows replaces pane rows (DESIGN §10) |
| Logs | `budget:*` events carry amounts, ids, setting names; never key material, never the composer text or keys |

## 7. ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| A1 | Session cap as a parent `SpendMeter` (`createSpendMeter(sessionCap)`, runs as `child(min(runCap, remaining))`); add `SpendSnapshot.parentExceeded` | `exceeded()` already ORs the parent; the bench uses the same tree; zero new stop reasons | `src/spend/meter.ts` 60–62; `src/bench/runner.ts` 354, 579; DESIGN §13 |
| A2 | `session.spendCapUsd`: `--session-spend-cap` > `JEVCODE_SESSION_SPEND_CAP_USD` > `sessionSpendCapUsd` > default 5 × run cap ($10.00; jev-only run default $0.25 → $1.25); `none` = +Infinity, explicit only | Below the $13/day enterprise average, above every run on disk (max $1.53); Claude Code has no interactive cap at all | https://code.claude.com/docs/en/costs; https://code.claude.com/docs/en/cli-reference; §2.1 |
| A3 | `budget:warn` at 50/80/95 % per scope → `<Static>` item + 2 s/4 s toast + meter word (`half`/`high`/`critical`, never colour alone) + opt-in BEL/OSC 9 at 95 % and stop when unfocused | 34/4/1 of 186 live runs would have fired; Claude Code gateway warns at 75/95; WCAG 1.4.1 | §2.1; https://code.claude.com/docs/en/claude-apps-gateway-spend-limits; 06 §11, §13; 07 §2.7 |
| A4 | Confirm a follow-up only when `0 < remaining < runCap`; keys `y`/`r`/`n`/Esc, Enter inert; refuse outright at `remaining ≤ 0`; never prompt in `--plain`/`--json` | Severe-class confirmation (executes in the user's workspace, spends money); clig "Never _require_ a prompt" | 06 §12; 00 A39 |
| A5 | `spend_cap` epilogue naming `/budget spend-cap <v>` + `/resume` (override recorded in `run.json.overrides[]`) and the follow-up alternative with its fresh cap | A follow-up silently resets the cap; the override path exists and is unused (0 of 216 runs) | `src/config/resolve.ts` 438, 459; A52; §2.1 |
| A6 | `/budget spend-cap` applies to the next `/resume` **or** next run, whichever first; `/budget session-spend-cap` applies immediately and is logged as an index `budget` line | Keeps "a run must stay comparable with itself"; makes the session record complete | DESIGN §9; 10 §15.5 |
| A7 | Unknown pricing fails closed: refuse (exit 2) unless `--allow-unpriced` → `token_cap` on generator tokens; add cache-rate overrides; OpenRouter/Jev `null` cost → `unpriced_usage` | Today zero pricing + a dropped warning means the cap can never fire; the gateway prices unknown IDs at $5/$25 "so an ID the meter can't place is never free"; aider's "assume free" is the anti-pattern | `src/config/defaults.ts` 40–43; `src/config/validate.ts` 116–125; `src/cli/main.tsx` 145; gateway page; https://aider.chat/docs/llms/warnings.html |
| A8 | Print `config.warnings` in `jevcode run` | The unknown-pricing warning is computed and discarded | `src/cli/main.tsx` 145; `src/config/types.ts` 66–68 |
| A9 | `~` on table-priced figures, `$?` only under `--allow-unpriced`; `/cost` prints the pricing basis per source | Codex `~$0.0001`; SDK `costBasis: list \| managed \| unknown`; "not authoritative billing data" | codex `thread_usage.rs`; https://code.claude.com/docs/en/agent-sdk/cost-tracking |
| A10 | `--json` events `budget:warn`, `budget:stop` (with `raise.minimum`), `budget:clamp`, `budget:override`, `budget:unpriced` | Scripts today can only infer the cap from `status` payloads; SDK exposes `error_max_budget_usd` | `src/core/types.ts` 806–837; 10 §15.10; SDK cost-tracking page |
| A11 | Fold the index once per session open / resume, keep the total in memory; seed the session meter before `restore()` | 0.26 ms at 141 runs, 13.4 ms at 10k — never on the render path; `restore()` does not forward to the parent | §2.2; `src/spend/meter.ts` 80–86 |
| A12 | Status line: `run $x/y word` at ≥ 80 cols, bars only at ≥ 120 cols; `EXCEEDED` → `over` | 106 → 130 cells measured; string cost ≤ 1.1 µs; render delta ≈ 0 | §2.3, §2.4; 11 §4g |
| A13 | `JEVCODE_BUDGET_WARNINGS=0` hides toast/BEL only; `<Static>` record and JSON events never suppressed | Claude Code's `DISABLE_COST_WARNINGS` hides warnings entirely — wrong default for money | https://code.claude.com/docs/en/env-vars |
| A14 | Jev-share note when Jev exceeds generator spend at a crossing; `/cost` shows per-question cost | Jev is ≤ 9 % of a run at p50; a Jev-driven cap is a loop signal | §2.1; STATUS.md 98 |

## 8. REJECT

| What not to do | Why |
| --- | --- |
| A session cap that resets on every follow-up (status quo) | Unbounded session spend; the user sees a fresh `$0.000` per run and no cumulative figure |
| Warnings by colour only, or `EXCEEDED` only after the fact | WCAG 1.4.1; ~1 in 12 males red–green deficient (06 §13); the word must precede the stop |
| Enter as the default on the follow-up confirm | Severe confirmation class; Enter is also the composer submit key — a double-tap would start a clamped run |
| Pricing unknown models at $0 (today) or "sane defaults" (aider) | The cap becomes unenforceable; the gateway's "never free" rule is the industry direction |
| Re-folding `sessions/index.jsonl` per frame or per `status` event | 13.4 ms at 10k runs vs a 5 ms render p95 gate (DESIGN §12) |
| A new `StopReason 'session_spend_cap'` | The clamped child cap makes the run stop with `spend_cap`; `parentExceeded` in the snapshot disambiguates; every exit-code and resume rule stays intact |
| Applying `/budget spend-cap` to a live run | Violates "a run must stay comparable with itself" (DESIGN §9); overrides are recorded at resume for a reason |
| BEL/OSC 9 on every threshold by default | 07 §2.7 policy is BEL on confirm/run:end when unfocused; a bell per 50 % crossing is noise and re-announces in SR mode |
| Suppressing the `<Static>` budget record with a `DISABLE_*` env | The transcript is the audit trail; only the ephemeral surfaces may be muted |
| Modelling the fail-closed rule after the gateway's fail-**open** default | JevCode has no billing side that catches the miss later; the run is the only place the money is bounded |
| Hard-coding Claude Code's 75/95 % pair | 50 % is the earliest point at which "about N steps left" is a usable projection (p90 cost/step is 26 % of a p50 run), and 80 % is the number already written into 06 §11 |
| `OSC 9;4` progress reporting for the meter | ConEmu/Windows Terminal semantics conflict with OSC 9 notifications; foot ignores `9;<digit>` (07 §2.7) |

## 9. OPEN QUESTIONS

1. Should the jev-only mode-aware run default ($0.25) live in `config/defaults.ts` as a second `DEFAULT_SPEND_CAP_USD`
   keyed by mode, or in `resolveConfig` after `--mode` is known? The first-frame ordering contract (DESIGN §12) means
   the default is not needed before `run:ready` either way.
2. Whether `/budget spend-cap` pending state should survive process exit (write it to the index as a `budget` line
   with `setting: 'limits.spendCapUsd'`), or die with the session TUI. Codex persists queued submissions; Claude Code
   keeps them in memory (10 §15.3).
3. The token-cap default under `--allow-unpriced` uses the gateway's $5/$25 tier and a 2:1 input:output weighting;
   the measured generator mix is ~10:1 (127.0k in / 12.4k out on the cap run). A 10:1 weighting would allow
   ~330k tokens for $2.00 — pick the conservative or the measured mix?
4. Partial-stream usage on abort: does Anthropic's SSE always deliver a `message_delta` usage frame before the
   harness abort closes the socket? If not, the "unpriced" marking in §6 fires on every Ctrl-C mid-generate.
5. Should `budget:warn` at 95 % pre-empt the *next* step's before-execute check (i.e. stop early when
   `spent + p95StepCost > cap`) to eliminate the ≤ $0.14 overrun, at the cost of leaving budget unspent?
6. Session cap and `/new`: `/new` starts a session with a fresh cap by definition; should the TUI show the previous
   session's total on the first frame of the new one (opencode shows session cost only)?
7. Claude Code's exact warning sentences at 75/95 % and the bodies of its spend-limit error pages remain
   UNVERIFIED (§0); if the wording is later fetched, align the toast phrasing where it does not conflict with the
   `[run] budget:` house style.
8. Whether `jevcode config` should print the *effective* session cap when derived (`$10.000 (default: 5 × run
   cap)`) — the current table prints one value per setting with its source (DESIGN §3).
