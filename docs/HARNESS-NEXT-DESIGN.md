# Harness-next: Fastlane — the warm-path, speculative JevCode harness (Jev routes, never gates)

**Date: 2026-09-21.** Design doc, read-only round: nothing in `src/**` was edited and nothing was committed while writing it.

Spine: **Fastlane** (the winning design of the harness-next panel — two independent adversarial judgements scored it 34/40 and 35/40 against 27/29 and 21/23 for the two rivals). Grafts from the two runner-up designs are marked inline as **[graft: Capability-first]** (Designer 2 — code-owned repo map, language plane, write-path hardening) and **[graft: Dispatch]** (Designer 3 — agentic-first: subagents, background work, hooks, plan mode). Corrections that came out of the judgements or out of my own measurements this session are marked **[fix]** and **[measured 2026-09-21]**.

Companion documents: `docs/DESIGN.md` §1, §6, §22 (what is in the tree); `docs/LLM-JEV-DESIGN.md` §2–§7 (the mode this design accelerates); `docs/COORDINATION-DESIGN.md` §6–§8 (the parallel workstream this must not collide with); `experiments/designs/llm-jev-map.md` §3, §6 (what Jev is measurably good at, and where the wall goes); `experiments/results/llm-jev-headtohead.md` (the v1 numbers every claim below is measured against); `experiments/designs/harness-next/research.json` (the six dated harness surveys behind §2).

---

## 1. Goal, and the Jev-safety principle

### 1.1 The goal

Make JevCode the fastest correct open coding harness by importing the best mechanisms the 2026 open harnesses have converged on, **in code**, and using Jev for exactly one job on the new surface: **routing**. Nothing here trades correctness for speed; several mechanisms buy correctness back as a side effect (§3.11, §3.12).

The starting point is measured, not assumed. At `626fc40` on 28 paired tasks (`experiments/results/llm-jev-headtohead.md`, 2026-09-21), `llm-jev` already beats the same GLM-5.3-flash run generator-only:

| quantity | `jev-off` (GLM alone) | `llm-jev` | ratio |
|---|---|---|---|
| pass | 19/28 | 22/28 (23/28 with the outage re-run) | +3…4 |
| median wall / task | 391 s | 80 s | 0.20× |
| steps, mean | 10.8 | 3.6 | 0.33× |
| $ / solved task | $0.0266 | $0.0123 | 0.46× |
| `wall_time` stops | 10 | 0 | — |

So the question is not "is the mode good"; it is "where is the remaining wall, and can it be removed without touching the arbiter". The head-to-head answers the first half precisely (§6 of that report). A step is **not one cost, it is six queues**, and only one of them has ever been optimised:

| # | queue | measured size | source |
|---|---|---|---|
| 1 | **lane / candidate verification** | `synthMs` is **99 % / 99 % / 84 %** of wall (QuixBugs / ladder / SWE); **13,746** QuixBugs + **26,948** ladder + 2,128 SWE candidate runs across 28 tasks | headtohead §6 |
| 2 | **GLM sample latency** | fit 6.6 s + 16.4 ms per output+reasoning token; valid p50 2.7 s, p90 25.6 s, all-calls p90 60 s, max 171 s; **77 of 228** samples (34 %) lost to the 20/30 s deadline, **31 of 34** on django-15128; 19 samples lost to `HTTP 429` | headtohead §3, §6 |
| 3 | **Jev** | p50 237 ms / p95 547 ms × 741 requests over 28 tasks (179 on sympy-11618); **74 % of `llm-jev` dollars** ($0.2010 of $0.2704) but only 3.7 / 7.3 / 8.0 % of wall | `docs/STATUS.md:86`; headtohead §4, §6 |
| 4 | **whole-repo reload** | `loadPythonFiles` (`src/synth/search/index.ts:352`) re-reads up to 1,200 `.py` files *every step*, re-using the parse only on byte equality | source + its own doc comment |
| 5 | **per-command process cost** | every lane reset, every `ast.parse` check and every candidate test is a fresh `sandbox-exec -f <profile> /bin/sh -c …` (`src/sandbox/run.ts:250`, spawn at `:270`) | source |
| 6 | **harness** | p95 **45.7 / 51.1 / 52.6 / 49.6 ms** across four recorded perf runs against a **50 ms** gate (`docs/STATUS.md:392`, `:724`, `:769`, `:832`) | STATUS |

Queue 1 is by far the largest and has never been attacked. I measured its fixed cost on this machine today:

**[measured 2026-09-21, this machine, darwin 25.6, n = 8–15 per row, p50]**

| what | p50 | note |
|---|---|---|
| bare `/bin/sh -c true` | **2.8 ms** | the floor |
| `sandbox-exec -f <profile> /bin/sh -c true` | **6.8 ms** | the seatbelt wrapper costs ≈ **4 ms**, not more |
| `python3 -c pass` | **13.4 ms** | interpreter start |
| `python3 -c "import pytest"` | **67.3 ms** (p95 98.2) | the real fixed cost |
| `python -m pytest -q` on one trivial test | **91.9 ms** | ⇒ ≈ 92 ms fixed per pytest invocation |
| the same through the sandbox | **108.3 ms** (p95 129.4) | |
| **a real QuixBugs candidate run** (`python3 run_tests.py gcd programs/gcd.py`) | **67.8 ms** bare / **74.3 ms** sandboxed | `bench/data/quixbugs/run_tests.py` |
| **a real ladder candidate run** (`python3 -m pytest -q` in `bench/data/ladder/tasks/account`) | **182.7 ms** | 10 tests, 3 failing |
| the same work as `pytest.main()` in an **already-warm** interpreter | **42–48 ms** per call after the first | ⇒ **3.9×** |
| 6 test cases as fresh `python3` subprocesses | **66.8 ms** | today's `run_tests.py` shape (one subprocess per case) |
| 6 test cases as `fork()` from a warm parent | **2.5 ms** | ⇒ **26×**, and `fork()` keeps address-space isolation *and* the per-case SIGKILL timeout |

That is the whole thesis in one table. **Per-candidate fixed process cost is 70–180 ms; nearly all of it is removable without weakening isolation.** At 1,375 QuixBugs candidate runs per task over 8 lanes that is ≈ 12.8 s of lane wall per task against a 34 s median; at 2,246 ladder candidate runs per task it is ≈ 28–51 s against a 47 s median. Fastlane's mechanism 6 (§3.6) is therefore the top lever, and everything else is second.

**[fix, from both judgements]** Fastlane's own draft called speculative router dispatch "the core of this design". It is not: routers target under 8 % of wall. The core is the warm runner and the sample tail. `routeSpeculative` is *cheap insurance* that makes Jev latency structurally invisible — valuable, but it is wave S4, not wave S1. The waves in §6 follow the measured wall.

### 1.2 The Jev-safety principle

Jev is a **router**, never an **authority**. Stated once, enforced structurally.

**[graft: Dispatch]** Every Jev call site introduced or moved by this design satisfies four conditions, checked by a lint rule that lands in wave S0 (`scripts/jev-contract.mjs`, run from `npm run check` beside the existing `scripts/no-any.mjs`) *and* by one unit test per call site:

1. **Code enumerates the options.** Jev never invents a path, a command, a test scope or a candidate. Every Choice carries `ESCAPE_KEY` (`src/jev/questions.ts:8` — `'none_of_these'`), and `assertQuestionBatch` already enforces both-sided definitions and the escape rule at build time.
2. **A code guard runs after, and can only tighten.** A routed action still passes the code deny-list, the seatbelt profile (`src/sandbox/seatbelt.ts`), the hooks (§3.14) and — for anything correctness-bearing — the tests. Jev can escalate to `ask`/`block`; it can never release what code denies.
3. **There is a deterministic code fallback, and it is exercised.** Every router names its fallback, taken on: Jev unreachable, HTTP 5xx (a real Jev `503 no healthy upstream` / `529` outage between 23:31 and 23:34 Z killed three SWE runs in the head-to-head), the 400 ms soft deadline, confidence below the call's calibrated floor, or the escape option. **[graft: Capability-first]** Each fallback has its own unit test driven by a `Decider` that throws.
4. **Being wrong costs wall-clock, never correctness.** A wrong queue order costs one extra lane run. A wrong prewarm bundle costs slack CPU. A wrong "replay the cached round" costs one 10 s deadline. None of them can delete a file, force-push, accept a failing patch, or declare a task complete.

**[graft: Dispatch]** And a CI gate that turns the principle into a continuously tested property: **`--jev off` must still complete all five Ring-2 tasks of §5, only slower.** Ring 1 replay (§3.15) makes this gate nearly free.

Structurally excluded from Jev, each with its measured reason:

- **Arithmetic and counting** — hedge deadlines, budgets, `max_tokens`, lane counts, `t_run` sizing, `newlyPassing`, compaction triggers. Jev answers "r in strawberry" at 0.52 and "within 1 %" at 0.73 (map §3 item 12). Code only. Spend ceilings stay in `src/spend/meter.ts` + `src/loop/budget.ts`, **outside every router** — which is precisely the SWE-agent `Chooser` failure (issue #1491: a bare `except Exception` swallowed `TotalCostLimitExceededError` and silently defaulted to option index 0).
- **The destructive gate** — a code deny-list first (history-rewriting git, `rm` on the workspace root or `$HOME`, writes under `.git`/`.jevcode`/the config dir, a remote added mid-run) that bypasses Jev entirely, then the existing harm-only Q20 (`destructive`, `irreversible`) for the ambiguous band only. A failed or timed-out Q20 means **ask**, and safe-default decline under `--plain`. Never allow.
- **Completion** — `isCompleteByFact()` on the harness's own green run (`docs/LLM-JEV-DESIGN.md` §6.6). Q21/Q22 stay recorded-only.
- **The cold confirmation of any hot-screened passer** — the entire point of §3.6 is that a speculatively-screened result is only ever validated by a fresh, isolated run.
- **Plan and intent judgment** — 100 % of jev-on's 223 bench refusals came from the alignment dimensions; the intent Choice fell back 46 % of the time; jev-on scored 9/29 against jev-off's 10/29. `llm-jev` deleted both stages and this design does not bring them back. **This is also why the Dispatch design lost the panel**: subagent selection, plan mode and 60-tool routing are plan judgment wearing different clothes.
- **Never the sole reason a patch is committed** — the guard's code rules (majority independent support, fewest special cases, the all-overfit drop signature, `preferLlmInCluster`) run first; Jev only breaks the residual tie among *test-passing candidates in distinct behaviour clusters*, which is its best-measured job (gold-or-equivalent 10/10, map §3 item 4).

Why routing in particular is the right Jev shape: its three strongest measured abilities are **choosing among ≤ 255 concrete options when the right one is present** (36/40 top-1 at N = 10; 100 % on a 200-option city→country set), **ranking near-duplicates with one full-criteria Noul each** (top-3 40/40 at N ≤ 50), and **yes/no on literal facts already in the state** (acc 0.983; 240/240 on code-computed counts). Every router in §3 is exactly one of those three shapes over options **code enumerated**. And Jev's latency is **flat in question count** (1,000 Nouls in 466 ms), which is why routers are merged into as few requests as the dependency order allows and cached by digest (§3.9).

---

## 2. Research digest

Every row was fetched **2026-09-21** (the six surveys in `experiments/designs/harness-next/research.json` record the same date; rows marked † I re-measured or re-verified against this tree myself this session). Verdict `adopt` means it lands in §3 with a mechanism number; `skip` means §7 names why.

| harness / source | mechanism | evidence URL (fetched 2026-09-21) | verdict |
|---|---|---|---|
| **PASTE** (speculative agent execution) | graded speculation on a slack budget: side-effecting work limited to "shallow preparatory actions, including runtime warm-up, container or environment initialization"; unsafe work only as "transformed speculation … such as dry-run execution"; promotion on arrival, preemption by utility, "speculative execution never delays authoritative tasks" | https://arxiv.org/html/2603.18897v1 | **adopt** → M1, M5, M6, M10 (the policy) / **skip** the mined pattern predictions (§7) |
| **SpecBox** | intent-aware sandbox prewarming overlapped with LLM decoding; keyword router 95.0 % match at 323 ms; provisioning latency −4.53×, P99 −2.9× | https://arxiv.org/html/2607.23933v1 | **adopt** → M5 (shape only) / **skip** its τc = 0.8 semantic cache (§7) |
| **OpenRouter** | provider routing: `order`, `only`, `allow_fallbacks` (default true), `require_parameters`, `sort: price\|throughput\|latency`, `max_price` | https://openrouter.ai/docs/features/provider-routing | **adopt** → M2 (`order` + `sort` only; never `only`) |
| **OpenRouter** | prompt caching: "routes subsequent requests to the same provider endpoint after a cached request … sessions expiring after 10 minutes of inactivity"; Z.AI/GLM caches automatically; `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, `cache_discount` | https://openrouter.ai/docs/features/prompt-caching | **adopt** → M3 |
| **Anthropic** | caching rules: prefix match, render order `tools → system → messages`, max 4 breakpoints, min cacheable prefix 512–4096 tokens, default TTL 5 min, `cache_control {type:'ephemeral', ttl:'1h'}`, read ≈ 0.1× / write ≈ 1.25×, verify with `usage.cache_read_input_tokens`, `max_tokens: 0` to pre-warm | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | **adopt** → M3 |
| "Don't Break the Cache" | 41–80 % cost and 13–31 % TTFT from cache discipline; **full-context caching can *increase* latency** — cache only the stable zone | https://arxiv.org/abs/2601.06007 | **adopt** → M3 (and it is why the stagger is `'auto'`) |
| **aider** | prompt-cache prefix order: system → read-only files → repo map → editable files → conversation | https://aider.chat/docs/usage/caching.html | **adopt** → M3 |
| **OpenRouter** | reasoning tokens: `{max_tokens}` is a thinking budget (one of effort / max_tokens) | https://openrouter.ai/docs/use-cases/reasoning-tokens | **adopt** → M4 / `{enabled:false}` is HTTP 400 on this endpoint † (`experiments/results/llm-jev-probes-off.md`) → **skip** |
| warm-pool practice (Modal, Blaxel, E2B) | pre-provisioned pools sub-90 ms; Firecracker ≈ 150 ms; Docker 1–3 s; snapshot/restore 125 ms vs 5–30 ms | https://modal.com/resources/best-code-execution-sandboxes-coding-agents · https://blaxel.ai/blog/code-execution-sandboxes-for-ai-agents · https://bex.co/blog/2026/07/31/e2b-sandbox-growth-firecracker-self-hosted-agent-sandbox (search-surfaced; *shape* only, magnitudes not portable to a local seatbelt model) | **adopt** → M5, M6 (shape) |
| **opencode** | mtime/size-keyed caches, bounded reads (`tool/read.ts`: 2,000-line default, 2,000-char line cap, 50 KB refusal without offset) | https://opencode.ai/docs/ | **adopt** → M7, M13 |
| **aider** | repo map: tree-sitter tags → `networkx` MultiDiGraph → personalised PageRank toward chat files → token-budget binary search against `--map-tokens` (default 1k); weights ×50 chat / ×10 mentioned / ×0.1 private; disk cache `.aider.tags.cache.v{N}` keyed by mtime; cache the rendered map only when `map_processing_time > 1.0 s`; "above about 25k tokens of context, most models start to become distracted" | https://aider.chat/docs/repomap.html · https://aider.chat/2023/10/22/repomap.html · https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py | **adopt** → M8 (no tree-sitter: reuse `src/synth/py/structure.ts`) |
| **SWE-agent** ACI ablation | lint-gated edit 18.0 % vs 15.0 %; 100-line file viewer 18.0 % vs 30-line 14.3 % vs full file 12.7 %; file-list-only search 18.0 % vs per-match 12.0 % (SWE-bench Lite) | https://arxiv.org/html/2405.15793 · https://swe-agent.com/latest/background/aci/ | **adopt** → M12, M13, M13b |
| **SWE-agent** `filemap` | elides function bodies ≥ 5 lines with `... eliding lines a-b ...`; on by default | https://raw.githubusercontent.com/SWE-agent/SWE-agent/main/tools/filemap/bin/filemap | **adopt** → M13 |
| **SWE-agent** issue #1491 | a bare `except Exception` in the `Chooser` swallowed `TotalCostLimitExceededError` and silently defaulted to index 0 | https://github.com/SWE-agent/SWE-agent/issues/1491 | **adopt as a rule**: cost ceilings live outside every selection path (§1.2) |
| **opencode** `tool/edit.ts` | nine fuzzy replacers in order (Simple, LineTrimmed, BlockAnchor at similarity ≥ 0.65, WhitespaceNormalized, IndentationFlexible, EscapeNormalized, TrimmedBoundary, ContextAware, MultiOccurrence); CRLF/BOM preserved; multiple matches a hard error | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/edit.ts | **adopt** → M11 (with a stricter acceptance rule) |
| **opencode** LSP doc | language servers "get out of sync, use significant memory … and slow down agent workflows … it is better to have the agent run lint, typecheck, or other diagnostic CLI tools directly" | https://opencode.ai/docs/lsp/ | **adopt the feedback shape** → M12 / **skip the servers** (§7) |
| **aider** | auto-lint and auto-test after every edit, on by default | https://aider.chat/docs/usage/lint-test.html | **adopt** → M12 |
| **opencode** `tool/truncate.ts` | spill to disk with head/tail preview + path; `MAX_LINES 2000`, `MAX_BYTES 50*1024`, 7-day retention | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/truncate.ts | **adopt** → M13 (the contract is already written as `docs/COORDINATION-DESIGN.md` §8.3) |
| **opencode** `session/overflow.ts` | model-aware threshold `usable = input_limit − min(20k, maxOutput)`; a separate `small_model` slot for housekeeping | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/overflow.ts | **adopt** → M13c **[graft: Capability-first]** |
| **Claude Code** hooks | `async: true` "runs in the background without blocking" (timeout not enforced); `asyncRewake: true` wakes on exit code 2; `PostToolBatch` fires "After a full batch of parallel tool calls resolves, before the next model call"; timeouts 600/30/60 s; **exit 2 blocks** | https://code.claude.com/docs/en/hooks | **adopt** → M14 |
| **Claude Code** tools ref | Bash `run_in_background: true`; "did not complete within its 120s timeout and was moved to the background"; `Monitor` feeds output back; `TaskStop` | https://code.claude.com/docs/en/tools-reference | **adopt** → M19 **[graft: Dispatch]** |
| **OpenHands SDK V1** | event sourcing: per-event persist 0.20 ms median / 0.31 ms P95; crash recovery "under 20 ms" at 358 events; 380 KB median; 61 % drop in system-attributable failures | https://arxiv.org/html/2511.03690 | **adopt** → M15 (replay as the iteration engine) |
| **OpenHands** `StuckDetector` | 20-event bounded scan; same action/observation 4+; same action erroring 3+; 3+ agent messages; A-B-A-B for 6+ cycles; on by default | https://docs.openhands.dev/sdk/guides/agent-stuck-detector | **adopt the alternation signature only** → M18 |
| **OpenHands** issue #5355 | loop detection killed agents that were legitimately polling long-running processes | https://github.com/All-Hands-AI/OpenHands/issues/5355 | **adopt as the escape** → M18 |
| **OpenHands** parallel tools | `tool_concurrency_limit` default 1, "2-8 … for most use cases"; never parallelise writes to the same files | https://docs.openhands.dev/sdk/guides/parallel-tool-execution.md | **adopt the bound** → M10, M5 |
| **mini-SWE-agent** | batch runner `--workers`; process-wide `MSWEA_GLOBAL_COST_LIMIT` / `MSWEA_GLOBAL_CALL_LIMIT`; `cost_limit 3` beside `step_limit 250`; v2.4.x fixes: count billed-but-unparseable calls against the cap, deep-copy per-worker config, kill the process group on timeout | https://mini-swe-agent.com/latest/usage/swebench/ | **adopt** → M16 |
| **SWE-ReX** | "30 SWE-bench instances in parallel" | https://github.com/SWE-agent/SWE-ReX | **adopt the shape** → M16 |
| **opencode v2** `steps` | on the last step "OpenCode removes tools and asks the model to summarize in text. New user input resets the allowance" | https://opencode.ai/v2/docs/agents/ | **adopt** → M17 |
| **Efficient Benchmarking of AI Agents** | iterate on a mid-difficulty subset (30–70 % historical pass), motivated by Item Response Theory; 44–70 % task reduction (median 58 %); LOSO Spearman 0.92 | https://arxiv.org/html/2603.23749 | **adopt as the §5 task-selection rule** |
| **Trae Agent** | patch normalisation → dedupe → regression prune → select, with an early consensus stop at ⌈N/2⌉ | https://arxiv.org/abs/2507.23370 | **adopt the normalised dedupe** → M9b; **skip** the ensemble (§7) |
| **OpenHands** critic | 60.6 % → 66.4 % at N = 5, "log-linear"; Qwen-2.5-Coder-32B with a TD-learning regression head | https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model | **skip as a default** (§7) |
| **SWE-agent** `action_sampler.py` | `BinaryTrajectoryComparison`: min 4 / max 10 samples, N−1 pairwise "first"/"second" generator calls | https://raw.githubusercontent.com/SWE-agent/SWE-agent/main/sweagent/agent/action_sampler.py | **adopt the trigger, skip the mechanism** → R2 (§3.10) |
| **aider** architect/editor | Sonnet 3.5 77.4 → 80.5; GPT-4o 71.4 → 75.2; but the top pairings "are therefore quite slow, so probably not practical for interactive use" | https://aider.chat/2024/09/26/architect.html | **skip as a default**, config-only escape hatch (§7) |
| **aider** edit formats | per-model SEARCH/REPLACE vs whole; fall back to `whole` on repeated edit failures | https://aider.chat/docs/more/edit-formats.html · https://aider.chat/docs/troubleshooting/edit-errors.html | **adopt the escalation** → M11b **[graft: Capability-first]** |
| **opencode** permissions | `doom_loop` (identical tool input ×3) | https://opencode.ai/docs/permissions/ | **skip** — a strict subset of `src/loop/loopdetect.ts` (§7) |
| **opencode** snapshots | shadow git-dir per turn (`objects/info/alternates` + copied index) because a naive `git add --all` "can take minutes" on a chromium checkout | https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/snapshot/index.ts | **skip / defer** (§7) |
| **opencode** MCP + Code Mode | MCP servers "add to your context" (GitHub MCP "can easily exceed the context limit"); experimental `execute` tool over namespaced MCP tools | https://opencode.ai/docs/mcp-servers/ | **skip** (§7) |
| **Claude Code** subagents | own context window; 20 concurrent / 3 layers; "Resumed subagents retain their full conversation history"; `maxTurns` marks output partial | https://code.claude.com/docs/en/sub-agents | **skip as a default** (§7) — but the *file loader* shape is grafted into M14 |
| **Live-SWE-agent** | runtime tool self-evolution: 77.4 % vs 74.2 % at $0.68 vs $0.56 per issue | https://arxiv.org/html/2511.13646 | **skip as a default** (§7) |
| **TypeScript Repository Indexing** / **Codebase-Memory** | would have strengthened the index-over-grep case | https://arxiv.org/pdf/2604.18413 · https://arxiv.org/pdf/2603.27277 | **unverified** — the PDFs' results sections did not extract (reported by Designer 2 and not independently confirmed). Nothing in §3 depends on them. |

---

## 3. The adopted mechanisms, in full

All repo paths are absolute under `/Users/prateekjannu/Documents/vscode/JevCode`; `new` marks a file that does not exist yet. Magnitudes marked **[proj]** are projections from the components named in §1.1, decided by the probes of §5 — they are not results. Magnitudes marked **[measured]** are from the table in §1.1.

### M1 — Tail-cutting hedged samples

**What.** Fire a twin of any sample that has produced no first byte by `hedgeAfterMs`; take the first to complete; cancel the other.

**Why.** Not a harness feature anyone publishes — it is derived from the measured fat tail (valid p50 2.7 s, p90 25.6 s, all-calls p90 60 s, max 171 s; 34 % of samples lost to deadlines) plus PASTE's promotion/preemption on a dynamic slack budget.

**How it lands.** `src/synth/llm/source.ts`: `hedgeAfterMs = clamp(2 × running p50 of TTFB, 3_000, 8_000)`, `LLM_HEDGES_PER_ROUND = 1`. New `CancelReason 'hedge'` beside the existing `'commit' | 'budget' | 'abort'`. TTFB comes from a new first-byte hook on the stream in `src/provider/sse.ts` (the same place `linkedAbort` already lives at `:442`), recorded once per sample into `LlmRoundSummary.ttfbMs[]`. The hedge twin rotates `provider.order` (M2) so it is not another draw on the same throttled endpoint.

**Jev role.** None. Deadlines and budgets are arithmetic, Jev's measured weakness.

**Code fallback / guard.** Pure code; no fallback needed. The hedge is **refused** when `llmUsdLeft` cannot hold one extra sample at the estimated full cost (`budget.ts llmRoundAffordable`), and cancelled samples stay metered at estimated full cost per `docs/LLM-JEV-DESIGN.md` §2 principle 8 (the probes measured aborted samples billed at 0.59× the full-price estimate; the tree books them conservatively).

**Expected effect.** Round p90 25.6 s → ≈ 8 s + p50 ≈ 10.7 s, i.e. **−40…60 % on round p90** [proj]. On django-15128 it converts most of the 31/34 deadline losses into arrivals.

### M2 — Provider pinning, throughput sort, sticky-cache routing

**What.** Widen the OpenRouter provider preferences from the single field the tree sends today.

**How it lands.** `src/provider/types.ts:243-244` — `OpenRouterProviderPrefs` today is exactly `{ require_parameters: boolean }`; widen to `{ require_parameters, order?, only?, allow_fallbacks?, sort?, max_price? }`. `src/provider/openrouter.ts:130` `providerPrefsOf` maps them verbatim (it is already the single funnel, called from `:114`). Widen `GenerateRequest.providerPrefs` in `src/core/types.ts`. New config keys `generator.providerOrder`, `generator.providerSort` (default `'throughput'`), `generator.maxPrice` in `src/config/{types,defaults,resolve,validate}.ts` + `src/cli/args.ts` + `src/cli/config-table.ts`. The round sets them once in `src/synth/llm/source.ts`.

**Jev role.** None.

**Code fallback / guard.** `allow_fallbacks` stays **`true`** and `only` is **never set** — the head-to-head lost the ladder task `shipping`'s entire LLM round to 3/3 `HTTP 429` and committed a seed overfit as the direct consequence. A pinned provider that 429s falls through to the next in `order`.

**Expected effect.** Removes the multi-provider variance behind the observed Wafer / CoreWeave / OpenInference / Together spread, and is the precondition for M3's sticky cache. **−1…3 s per sample** [proj].

### M3 — Byte-stable prompt prefix, explicit breakpoints, cache-warm stagger

**What.** Make samples 1..N−1 of a round share a byte-identical prefix with sample 0, then release them on sample 0's first byte so there is one cache write and N−1 reads.

**How it lands.**
- `src/synth/llm/prompt.ts`: freeze the prefix as `system → # Goal → ## Task → ## Failing behaviour → ## Localisation → ## Code → ## Other files`, and move **every per-sample-volatile section last** — `## Earlier attempts this run`, `## Best partial so far`, `## Hint` (h0–h4 differ per sample), `## Reply`. A unit test asserts byte-identity of the prefix across a round.
- `src/synth/llm/source.ts`: on the **repository class** (which fires all N at once today, `docs/LLM-JEV-DESIGN.md` §4.2) release 1..N−1 on **sample 0's first byte** rather than immediately. The QuixBugs/ladder class already staggers on the seed batch, so it inherits the effect for free.
- `src/provider/openrouter.ts:274-275` already parses `cached_tokens` and `cache_write_tokens`; surface them as `LlmRoundSummary.cacheRead` / `.cacheWrite` and a `cacheHitRate` row.
- `src/provider/anthropic.ts` already sets two ephemeral breakpoints; add the `ttl:'1h'` option behind `generator.cacheTtl`, and fix the prefix order in `src/provider/prompts.ts` to `system → repo map → files → window` so the `jev-on` / `jev-off` prefix is byte-stable **between steps**, not only within a round.

**Jev role.** None.

**Code fallback / guard.** `generator.cacheWarmStagger: 'auto' | 'on' | 'off'`, default `'auto'`. A round that reports zero `cached_tokens` raises a `notice` and auto-disables the stagger for the rest of the run. This matters because "Don't Break the Cache" reports that full-context caching can *increase* latency: the bet is that prefix processing dominates, and the auto-off is the hedge against being wrong.

**Expected effect.** Prompt input cost of a round **−~80 %** [proj]; prefix-processing wall removed from N−1 samples. **This is the only lever that also cuts Jev-free dollars**, so it also improves the `jev-off` and `jev-on` arms.

### M4 — Reasoning-token cap

**What.** Send `reasoning: {maxTokens: 256}` on the cheap classes instead of `{effort: 'low'}`.

**Why.** The probes measured **266 reasoning tokens per call** at **16.4 ms per output+reasoning token** ⇒ ≈ 4.4 s of pure thinking per sample.

**How it lands.** `src/synth/llm/source.ts` for the QuixBugs/ladder class; validation already exists in `src/provider/openrouter.ts:64-65`. Repository class keeps `{effort:'low'}`.

**Jev role.** None.

**Code fallback / guard.** Revert to `{effort:'low'}` if the valid-sample rate drops below the probes' 97 % gate. `{enabled:false}` is **not** an option — HTTP 400, "Reasoning is mandatory for this endpoint".

**Expected effect.** **−0…2 s per sample** [proj], measured directly by probe P1.

### M5 — Warm lane pool and interpreter prewarm, overlapped with localisation

**What.** Create the lane pool and prime the test runner's import cache at **run start**, concurrently with the oracle and localisation, instead of lazily inside the first seed batch.

**How it lands.** New `src/synth/sieve/prewarm.ts`. `createLanes` (`src/synth/sieve/lanes.ts`, the `git worktree add --detach` fan-out at `:214`) is called from `src/synth/search/index.ts` at run start concurrently with the oracle (1–6 s) and `locate` (1–1.5 s); the pool already survives steps in the synthesizer's `mem.lanes`. Lane 0 runs one warm-up invocation of the detected runner. Every job is load-aware (reusing `LOAD_QUIET = 2` from `src/perf/main.ts:44`), cancellable on `ctx.signal`, and disposed through the `disposeSignal` path `docs/COORDINATION-DESIGN.md` §6.7 already specifies. Lanes register as `type:'lane'` leases through the additive `SynthesisContext.coordination` hook of §6.2 of that design, so the worktree sweep never removes a live lane.

**[fix]** The draft claimed a lane-0 `python -c "import pytest"` "primes the import cache". **It does not help a fresh process**: page-cache warmth saves only a few ms; the 67.3 ms is interpreter work repeated in every new process [measured]. The prewarm's real value is the `git worktree add` fan-out and the first-run collection cost; the per-process import cost is M6's job.

**Jev role — R3 `prewarm_first`.** A Choice over ≤ 8 code-built bundles `{laneMode, lanes, firstScope, filesToRead ≤ 6, reproNeeded}` plus the escape. Cut: argmax iff P(top) ≥ 0.7 (the bin where selection precision measured 0.98–1.00).

**Code fallback / guard.** The `mem.oracle.tRunMs` / `oracle.lanes` heuristic — exactly today's behaviour. A wrong router answer burns slack CPU only; a prewarmed artefact nobody uses is discarded. PASTE's rule holds: speculative work never delays authoritative work.

**Expected effect.** **−1…5 s on step 1** of repository runs [proj]; the 8-lane worktree fan-out leaves the critical path.

### M6 — "Screen hot, confirm cold" verification with a persistent lane runner  ← **the top lever**

**What.** A small pool of pre-spawned sandboxed shells for **harness-owned** work, plus a persistent, sandboxed **test-runner server** per lane for candidate screening — and a hard rule that every plausible passer produced on a warm worker is re-verified by a cold, fresh-spawn run before the guard sees it.

**Why, with numbers [measured 2026-09-21].** Per-candidate fixed process cost is 70–180 ms:

| layer | cost | removable by a warm runner? |
|---|---|---|
| `sandbox-exec` wrapper | 4 ms | yes (paid once per lane per run) |
| `/bin/sh -c` | 3 ms | yes |
| `python3` interpreter start | 13 ms | yes |
| `import pytest` (ladder class) | 54 ms | yes |
| pytest collection (ladder `account`) | ≈ 90 ms | partly (warm `pytest.main()` = 42–48 ms vs 183 ms cold ⇒ **3.9×**) |
| QuixBugs per-case subprocess fan-out (6 cases) | 67 ms | **yes, 26×** — `fork()` from a warm parent is 2.5 ms and keeps isolation *and* the per-case SIGKILL timeout |

Scale: **1,375** QuixBugs candidate runs per task × 74.3 ms / 8 lanes ≈ **12.8 s of lane wall per task** against a 34 s median; **2,246** ladder candidate runs per task × 182.7 ms / 8 lanes ≈ **51 s** (conservatively **≈ 28 s** if a third of queued candidates never reach a run) against a 47 s median. `synthMs` is 99 % of wall on both suites.

**How it lands.**
- New `src/sandbox/pool.ts`: a pool of pre-spawned `sandbox-exec -f <profile> /bin/sh` processes reading commands on a pipe with a sentinel, with an **explicit allowlist of harness-owned callers** — lane resets, `git` bookkeeping, and the `createAstCompileCheck` `ast.parse` calls at `src/synth/llm/candidates.ts:131`. A hard rule, unit-tested: `Action.kind === 'run'` **never** uses the pool; the agent's own commands keep `src/sandbox/run.ts` with its three-pass tree kill, per-command env scrub and per-command timeout.
- New `bench/data/quixbugs/run_tests_server.py`: a **zygote** variant of `run_tests.py` — read `{name, candidatePath}` on stdin, `importlib` the candidate, `fork()` per case with the existing SIGALRM/wall timeout, print the same one-line JSON. Same output contract, same isolation, 26× cheaper on the per-case layer. Driven from `src/synth/sieve/runner.ts` for the `candidate_file` lane mode.
- For pytest lanes: a warm-interpreter `pytest.main(['-q','-p','no:cacheprovider', …])` loop in the same server shape, with `importlib.invalidate_caches()` plus an explicit `sys.modules` purge of the workspace packages between candidates.
- New rule in `src/synth/sieve/runner.ts`: **every plausible passer produced on a warm worker is re-verified by a cold, fresh-spawn run before it reaches `src/synth/search/guard.ts decide`**, and the candidate carries `screened: true` into `ProposalEvidence`. The repository path already has exactly this shape (`src/synth/oracle/verify.ts:18-28`, a same-lane confirmation re-run that caught 1/64 false passes) — this generalises it.

**Jev role.** None. The sieve is arithmetic.

**Code fallback / guard.** The worker is opt-in per lane mode. A worker crash, a sentinel desync, or **any** screen/confirm disagreement disables the worker for the whole run, re-queues the batch cold, and emits a `synth` `screen:mismatch` line. `screenMismatches` must be **0** in every Ring-2 run (§5) or the mechanism does not ship.

**Expected effect.** **−10…30 s per task** on QuixBugs/ladder [proj from the measured table]; probe P2 decides it before a line is written.

### M7 — Stat-gated incremental repo load

**What.** Stat before read; skip the read entirely when `(size, mtimeMs)` are unchanged.

**How it lands.** `src/workspace/files.ts` gains `readIfChanged(path, {size, mtimeMs}, maxBytes)`. `loadPythonFiles` (`src/synth/search/index.ts:352`) stats first and keeps today's byte-equality check as the **second** gate. `src/workspace/candidates.ts` (already cache-based, invalidated only by a `run`) gains the same short-circuit. The rule is the `fileMemory {sha12, bytes, readAt, editedAt}` stat-then-sha rule already specified in `docs/COORDINATION-DESIGN.md` §8.4.

**Jev role.** None.

**Code fallback / guard.** Any stat mismatch falls through to today's full read + parse. `JEVCODE_INDEX=off` restores today's path exactly, for filesystems with coarse or unreliable mtime.

**Expected effect.** On a ≈ 1,200-file sympy tree this removes ~1,200 reads per step: **tens to hundreds of ms per step** [proj], measured by probe P3.

### M8 — Persistent, background-warmed repo index (tags + personalised PageRank)

**What.** An aider-style ranking over a code-extracted symbol graph, warmed in the background, used only to **order** candidate sets.

**How it lands.** New `src/workspace/index/{tags,rank,store}.ts` writing `~/.jevcode/index/<repoKey>/tags.json` keyed by `path+size+mtime`. **No tree-sitter dependency** — the tree ships zero runtime dependencies; Python tags come from the existing tokenizer and structure analyser (`src/synth/py/structure.ts`), with a sibling brace/indent scanner for TS/JS. Warmed by a single `unref`ed timer **after the first frame only** (the < 300 ms zero-network first-frame rule, `docs/DESIGN.md` §12). Consumed by `src/synth/localize/outline.ts` to order the repository-class `## Other files` outlines, and by the pre-filter in `src/loop/stages/context.ts` (300-candidate cap) for the `jev-on` path.

**[graft: Capability-first]** The full spec, because determinism is load-bearing: personalised power-iteration PageRank, damping 0.85, ≤ 30 iterations, `‖Δ‖₁ < 1e-6`, **fixed sorted node order**; aider's multipliers (×50 in-view, ×10 mentioned, ×10 identifiers ≥ 8 chars with case boundaries, ×0.1 `_private`, ×0.1 defined in > 5 files, √ of reference counts); the token-budget binary search (`middle = min(budget/25, n)`, accept at `pct_err < 0.15`); and **a unit test asserting byte-identical output across two runs on a fixture**, because `--resume` determinism and the `tried` dedupe in `src/synth/search/memory.ts` require it. Rebuild the whole map only when the edge set changed; cache the rendered map only when the last build took > 1 s (aider's `map_refresh auto` rule).

**Jev role — R7.** The existing localisation questions Q2–Q6 now rank **within** the index's shortlist rather than over the raw list.

**Code fallback / guard.** Index missing, stale or over its `repomapMs` budget ⇒ today's `mentionedInTask` sort (`src/synth/search/index.ts:358`). The index is **only ever an ordering input, never the content the model sees** — files are still read through the workspace before listing — so a stale index costs a worse order, never wrong content.

**Expected effect.** Shrinks the `jev-on` context stage (60k Jev tokens/step at 300 candidates, 71 % of jev-on's Jev cost) and cuts repository listing assembly: **−0.2…0.5 s and −30…60 % Jev context tokens** [proj].

**Honest scope note.** `llm-jev` does **not run the context stage at all** (`docs/LLM-JEV-DESIGN.md` §3 stage 3: "not run; the synthesizer loads every non-test `.py`"), so the 71 % figure accrues to `jev-on`, the arm that lost 9/29 vs 10/29. In the winning arm M8's value is the repository-class `## Other files` ordering only. That is why M8 is wave S3 and not S1 — this was the decisive flaw in the Capability-first design, and importing the mechanism without importing its priority is the point.

### M9 — Exact-digest Jev answer cache, request merging, keep-alive

**What.** Memoise Jev answers by digest; merge independent routers into one request; keep the connection warm.

**Why.** Jev is **74 % of `llm-jev` dollars** and 741 requests / 28 tasks, and its latency is **flat in question count** (1,000 Nouls in 466 ms) — so merging is nearly free and caching is pure profit.

**How it lands.** New `src/jev/cache.ts`: an in-run memo plus `<runDir>/cache/jev/<sha12>.json`, keyed by `(deciderModel, questionsDigest, stateDigest)`, **exact match only**, never across model ids, `--jev-cache off`. An explicit keep-alive dispatcher in `src/jev/client.ts`. Q17 (`src/synth/llm/rank.ts`) is **merged into the same request** as Q8–Q10 when both fire in a step (`src/synth/rank/index.ts`). New `StepTiming.jevWaitMs` (wall actually *blocked* on Jev) beside today's `jevMs` (sum of latencies) in `src/core/types.ts:380-390`. The spend cap stays in `src/spend/meter.ts` and `src/loop/budget.ts`, never inside a router.

**M9b [graft: Trae]** — **normalised dedupe before ranking**: strip whitespace and comment differences and hash candidate patches before they become Jev options or lane jobs. 60–61 % of valid QuixBugs and ladder samples were already dropped as `duplicate` of sample 0; normalising catches the near-duplicates that survive, removing both Jev options and lane runs for free.

**Jev role.** This *is* the mechanism that makes every other Jev use affordable.

**Code fallback / guard.** A cache miss is today's request. A `JevError` leaves the code default in place.

**Expected effect.** **−30…50 % requests**, **−$0.06…0.10 per 28 tasks**, and **−0.2…0.6 s of blocked wall per step** [proj].

### M10 — Speculative router dispatch with reorder-on-arrival

**What.** One dispatch contract under which every router runs: **speculate first, reorder on arrival, drop at 400 ms**.

**How it lands.** New `src/loop/router.ts`:

```ts
export const ROUTER_DEADLINE_MS = 400;           // Jev p50 237 / p95 547 (docs/STATUS.md:86)

export interface RouteResult<T> {
  order: readonly T[];
  source: 'jev' | 'code';
  appliedAt: number | null;
  dropped: boolean;
}

export async function routeSpeculative<T>(input: {
  codeOrder: readonly T[];                       // always non-empty, always sufficient alone
  dispatch: (item: T) => Promise<unknown>;       // starts immediately, in this tick
  ask: (signal: AbortSignal) => Promise<readonly T[] | null>;
  deadlineMs?: number;                           // default ROUTER_DEADLINE_MS
}): Promise<RouteResult<T>>;
```

Semantics, and the reason Jev can never cost wall:

1. `dispatch(codeOrder[0])` is called **before** anything is awaited.
2. `ask()` is issued in the same tick with its own `AbortController` linked to the step signal (the `linkedAbort` pattern already used per sample, `src/provider/sse.ts:442`).
3. If the answer lands within `deadlineMs` **and** before the in-flight job settles, only the **pending tail** is re-ordered; `source: 'jev'`, `appliedAt` recorded.
4. Otherwise the answer is abandoned (`dropped: true`, `synth` phase `router:dropped`) and the code order stands. A `JevError`, a 503/529, or a timeout are the same branch.
5. Invariant asserted by `test/unit/loop/router.test.ts`: **`StepTiming.jevWaitMs` contributed by any router is 0.** `jevMs` may grow; `jevWaitMs` may not.

New `synth` phases `router:issued | router:applied | router:dropped` in `src/core/types.ts`; `GoalSearchTrace` gains `router: {issued, applied, dropped}[]`.

**[fix, from both judgements]** The consumers are the **real** Jev awaits inside the synthesizer, which the draft mis-cited. Verified against HEAD this session:

| call | line | today |
|---|---|---|
| `await deps.rank(ctx, mem, fresh, site, goal)` | `src/synth/search/subgoal.ts:848` | blocks the seed batch |
| `await deps.rank(ctx, mem, cands, site, goal)` | `src/synth/search/subgoal.ts:1575` | blocks the best-guess path |
| `await gateHeldPartial(...)` | `src/synth/search/subgoal.ts:763` | blocks the partial gate |
| `await ctx.ask('propose', …)` (edit-class Q7) | `src/synth/search/subgoal.ts:156` | blocks site entry |

Lines `:786` and `:799` — which the draft named — are `seedSource` and `enumerateSeed`, both synchronous. Routing the wrong lines would have been a no-op.

**Jev role.** All routers run through it, and only through it.

**Code fallback / guard.** A dropped answer *is* the code order, recorded as `routerDropped`.

**Expected effect.** Makes Jev latency structurally invisible: `jevWaitMs_router == 0` **by construction**. Note honestly that this insures under 8 % of wall — it is cheap, not central.

### M11 — Fuzzy edit replacer ladder (`jev-on` / `jev-off` `edit` only)

**What.** opencode's nine replacers, in order, behind the existing entry point.

**How it lands.** `src/workspace/edit.ts` is today 50 lines with a single exact, unique-occurrence match (`applyEditToContent` at `:25`, `countOccurrences` at `:12`). It grows to ≈ 260 lines returning `{content, tier, matches}`, with tiers `exact | line-trimmed | block-anchor | ws-normalised | indent-flexible | escape-normalised | trimmed-boundary | context-aware | multi-occurrence`. CRLF and BOM preserved. The tier is recorded in `ActionOutcome` and rendered in `src/tui/Review.tsx`. The three anchoring implementations in the tree — this one and `anchorHunk` at `src/synth/llm/candidates.ts:77`, used again at `:359` and `:387` — collapse into one shared `src/workspace/anchor.ts`.

**M11b [graft: Capability-first]** — aider's escalation: **two consecutive apply failures on the same file** (`EditError` / `PatchError` / `misanchored`) ⇒ the next attempt must use `write` with the whole file (≤ 64 KB). State on `StepDraft` and in `synthState`; hint `h5` in `src/synth/llm/prompt.ts`. This converts an unbounded retry loop into at most two attempts.

**Jev role.** None — and explicitly **not** added to `src/synth/llm/candidates.ts`, whose three-tier anchor already measured **58/58 hunks anchored, 0 % misanchored**.

**Code fallback / guard.** A non-unique match stays a hard `EditError`. **[graft: Capability-first]** And the stricter acceptance rule that upstream lacks: **any tier beyond `ws-normalised` must pass the M12 syntax gate before commit.** opencode accepts a lone BlockAnchor candidate at only 0.65 mean similarity and throws only on multiple matches; a wrongly-anchored edit that applies cleanly is worse than a failed edit. Optionally, a non-`exact` tier triggers one advisory Jev Score shown in the diff.

**Expected effect.** A failed `edit` costs a whole step (≈ 11–16 s + one generator call); this removes the commonest cause.

### M12 — Post-edit fast diagnostics instead of LSP

**What.** A millisecond-scale syntax **gate**, and project-wide checks as **advisory diagnostics** that can never fail a step.

**[graft: Capability-first]** The split is the graft, and it matters: Fastlane's draft budgeted a single ≈ 300 ms "file-scoped check", which is unreachable for TypeScript because `tsc` is project-scoped, not file-scoped.

**How it lands.**
- **Gate (hard, ms-scale):** new `src/checks/syntax.ts` — lift `createAstCompileCheck` out of `src/synth/llm/candidates.ts:131`, add `node --check` for `.js/.cjs/.mjs`. Called from `src/loop/stages/execute.ts` after `edit`/`write`/`patch`, through the M6 pool. On failure the outcome is `failed` with the compiler message, and **only the changed paths** are reverted via `src/workspace/git.ts restoreFromHead` (created files unlinked through the workspace).
- **Diagnostics (advisory, bounded):** new `src/checks/diagnostics.ts` — project-marker detected (`ruff check`, `tsc --noEmit`, `go vet`) via new `src/checks/detect.ts` (markers: `package.json` deps, `pyproject.toml [tool.ruff]`, `go.mod`). **10 s cap, output bounded to 40 lines, auto-off for any project whose first run exceeds the cap, never fails a step.** Appended as an `errors detected in <file>, please fix` block on `ActionOutcome`, so it reaches the generator through the window and reaches `codeJudge` as a fact.
- New `src/checks/format.ts` (prettier / ruff / gofmt), **default off**.
- Config rows `checks.syntax` (on), `checks.diagnostics` (`changed-files`), `checks.format` (off), `edit.ladder` (on).

**Jev role.** None. The signal is a code fact the recorded Q21 can read.

**Code fallback / guard.** Check missing or over budget ⇒ skipped silently. The gate is syntax-only, so it cannot be slow enough to matter.

**Expected effect.** Prevents a wasted step (≈ 11–16 s) per broken edit; SWE-agent's ablation puts the lint-gated edit at 18.0 % vs 15.0 %.

### M13 — Bounded reads, outlines, spill-to-disk, one bounds module

**What.** One place for every cap; outline and window read modes; long outputs on disk with a re-read path.

**How it lands.**
- New `src/core/limits.ts`, per `docs/COORDINATION-DESIGN.md` §8.1, replacing the duplicated caps at `src/loop/window.ts:10-15`, `src/checkpoint/resume.ts:20-24`, `src/provider/prompts.ts:15,220,227` and `src/loop/stages/execute.ts:64-80`. **[graft: Capability-first]** Take the fuller list: `READ_MAX_FILES 16`, `READ_MAX_FILE_BYTES 32_768`, `READ_MAX_TOTAL_BYTES 131_072`, `READ_MAX_LINES 2_000`, `READ_MAX_LINE_CHARS 2_000`, `WINDOW_LINES 100`, `OUTLINE_MIN_BODY 5`, `SPILL_BYTES 12_288`.
- New `src/workspace/outline.ts`: body elision for bodies ≥ 5 lines with `... eliding lines a-b ...`, regex/indent based (Python reuses `src/synth/py/structure.ts`; a sibling scanner for TS/JS). `Action.read` gains `mode?: 'outline' | 'window' | 'full'` and `line?: number` (additive; `outline` default above 400 lines, `full` below) in `src/core/types.ts`, `src/provider/actions.ts` (schema + `validateAction`) and `src/loop/stages/execute.ts`.
- Long outputs spilled to `<runDir>/outputs/step-<n>.txt` through the store's per-file chain (`src/checkpoint/store.ts`), redacted through `src/core/redact.ts`, **outside every sandbox-writable root** so a command cannot forge one, with the `jevcode:outputs/step-<n>.txt` pseudo-path accepted by `read` — exactly the contract in `docs/COORDINATION-DESIGN.md` §8.3.
- Every clip carries its recovery path (§8.5 of that design): `…[N chars omitted; full text: read jevcode:outputs/step-7.txt]`.

**M13b [graft: Capability-first]** — **file-list-first search output.** New `src/loop/output-shape.ts`: detect grep-family `run` commands (`grep` / `rg` / `ag` / `git grep` at the head of the parsed command) and reshape the output into `path (N matches)` lines, ≤ 50 files, with the hint `read <path> --window <line>`. SWE-agent's ablation: file-list 18.0 % vs per-match 12.0 %. A 5,000-line ripgrep dump becomes ≤ 2 KB and the commonest "output cap reached" step disappears. Unrecognised commands pass through under the existing 200 KB cap.

**M13c [graft: Capability-first]** — **model-aware overflow threshold.** Add a `contextTokens` column to `PRICING_TABLE` in `src/config/defaults.ts` (already flagged as `docs/COORDINATION-DESIGN.md` §14 Q4) and compute `usable = input_limit − min(20k, maxOutput)` in `src/core/limits.ts`. A few lines; it stops compaction firing on near-empty sessions and lets the 1M-context GLM default actually use its window — which directly supports M3's long stable prefix.

**Jev role.** None; caps are code constants.

**Expected effect.** GLM costs 16.4 ms per output token, and removing plan re-emission was already worth ≈ 15 s per call in the `jev-off` baseline. Every token removed is wall removed.

### M14 — Async, non-blocking hooks and batch-boundary hooks

**What.** A per-stage `before/after` seam over the existing discrete stages, with async hooks that never touch the step path.

**How it lands.** New `src/loop/hooks.ts` over `src/loop/stages/*.ts`: JSON on stdin, **exit 2 blocks**, `async: true` for formatters and loggers, a `stepBatch` hook at the commit point, and a per-hook deadline so a slow plugin cannot stall a step (a hook that misses its deadline is killed and recorded as a non-blocking error). Markdown command templates wired into `src/tui/commands/registry.ts`.

**[graft: Dispatch]** Two additions the draft omitted:
1. **Precedence, stated once:** a hook's exit-2 block **cannot be overridden by any later allow**, from Jev or from anything else. Blocks compose by intersection.
2. **Reuse the existing loader:** hook and command files are discovered with the walk-up + symlink-realpath + 32 KiB cap + sha256 machinery already in `src/config/instructions.ts:1-60`, and each loaded file is recorded in `run.json` as `{path, sha256, bytes}` exactly like `instructions[]` — so user-supplied policy on the step path is auditable after the fact.

**Jev role.** None.

**Expected effect.** Keeps user policy and formatting off the 50 ms harness budget.

### M15 — Zero-API replay as the iteration engine

**What.** Rebuild engine state from the records a finished run already wrote, with recorded provider and decider responses.

**How it lands.** New `src/loop/replay.ts` rebuilding from `~/.jevcode/runs/<id>/{steps,decisions,generator}.jsonl` with `src/provider/mock.ts`, `src/jev/mock.ts` and `src/bench/stub-decider.ts` as record-replay stubs; surfaced as `jevcode inspect --replay <run-id>` in `src/cli/inspect.ts`. The records already carry everything needed (`proposal.rawText`, `risk`, `outcome`, `decisions`, `timing`), and `foldStepsIntoState` (`src/checkpoint/resume.ts:147`) already knows how to fold them. OpenHands' SDK paper reports per-event persist at 0.20 ms median and crash recovery under 20 ms at 358 events, so this is a cheap shape.

**Jev role.** None.

**Expected effect.** **This is the "make it super quick" lever**: engine, router, queue-order, window and TUI iteration at **zero dollars and ≈ 0 s per trial**, over the 28 head-to-head run dirs as a corpus.

### M16 — `--quick` preset with global caps

**How it lands.** `src/bench/cli.ts` gains `--quick` = the five tasks of §5, `--concurrency 3`, replay-by-default, `--spend-cap 0.05`. `src/bench/runner.ts`: **deep-copy the per-worker config** (the mini-swe-agent v2.4.4 regression), and keep charging cancelled/unparseable samples at estimated full cost (already true in `src/synth/llm/source.ts`).

**[fix]** The draft also asked for the `CONDITIONS` arm-list drift to be fixed — the head-to-head lost the entire `jev-off-tuned` arm to it. **Already done**: `src/cli/args.ts:295` now reads `['jev-on','jev-off','jev-only','llm-jev','llm-sieve','jev-off-tuned']`, matching `src/bench/conditions.ts`. What remains is the standing rule: derive it from `parseConditions` rather than keeping a second literal, so it cannot drift again.

**Expected effect.** A full iteration cycle in ≈ 2 min and ≈ $0.01 instead of the 26–36 min / $0.30 head-to-head.

### M17 — Graceful last step instead of a wall-clock stop

**How it lands.** `src/loop/stop.ts` + `src/loop/budget.ts`: when a budget is one step from firing, run one final reduced-action-set call (`done` only) and store the handoff in the checkpoint at the pause point (`docs/COORDINATION-DESIGN.md` §7.2).

**Jev role.** None; code budgets stay authoritative.

**Expected effect.** The `jev-off` baseline lost **10 of 28** tasks to `wall_time` at 8–25 min each. A graceful stop makes the resume cheap instead of restarting.

### M18 — Alternation loop signature plus a "legitimate waiting" escape

**How it lands.** `src/loop/loopdetect.ts` gains one signature kind — **alternation (A-B-A-B) over a bounded 20-step scan** — and keeps its stronger failing-test-identity rule. **[graft: Capability-first]** Also `consecutive_timeouts: 3`, from SWE-agent's `max_consecutive_execution_timeouts`. The replan Choice (Q19) gains a hard-capped "legitimate waiting" escape, because OpenHands issue #5355 records its detector killing agents that were legitimately polling.

**Jev role.** Q19 (existing) resolves the trip; a code cap limits how many times the escape may be taken.

**Expected effect.** A trip saves whole steps; alternation is the one case JevCode's hash signatures miss.

### M19 — Auto-background on first timeout, plus `poll`  **[graft: Dispatch]**

**What.** A command that hits its timeout and is code-classified as long-lived is **moved to the background** instead of killed.

**Why.** Fastlane had no answer for a dead 120 s timeout; the head-to-head recorded a live step that hit it and cost 127 s. Claude Code's own wording is the precedent: "Command did not complete within its 120s timeout and was moved to the background".

**How it lands.** New `src/sandbox/background.ts` on top of the existing detached process-group spawn (`src/sandbox/run.ts:270`, `detached: true`) and three-pass tree kill (`src/sandbox/kill.ts`). `Action.run` gains `background?: true`; a new `Action` `{kind:'poll'; id; lines?}` reads the spilled output file from M13. A code classifier decides (`*dev`, `*watch`, `*serve`, `tail -f`, full suites); on first timeout a classified command is backgrounded rather than killed.

**Jev role.** One Noul, `finishes_within_step`, asked **only** when the code classifier is undecided (unknown program, no marker).

**Code fallback / guard.** Classifier undecided and Jev unavailable ⇒ foreground with today's clamped timeout. A backgrounded process is still in the run's process group and is still killed by the three-pass tree kill at run end.

**Expected effect.** Recovers a whole 120 s dead timeout per occurrence.

### 3.x The routers, one table

Every router is speed-only, every cut is a calibration point that held in the probes, and none sits at 0.5 on a borderline question (`docs/DESIGN.md` §5.4 rule 6).

| id | question | built in | what it orders / avoids | cut | code fallback | cost of a wrong answer |
|---|---|---|---|---|---|---|
| **R1** | **Q23 `run_first`** — Choice over ≤ 10 *concrete* commands + escape (e.g. `python -m pytest tests/test_x.py::test_y`, file scope, module scope, the detected full suite); state = failing test ids + the scope's file set + measured `t_run` per scope | new `src/synth/oracle/scope.ts`, consumed by `src/synth/oracle/verify.ts runRepositoryQueue` | which suite scope runs **first** on lane 0 — the largest wall lever on repositories, where the scoped suite is 11–100 s | argmax iff it beats the runner-up by > 0.05, else the narrowest code-detected scope | narrowest code scope from `src/workspace/tests.ts scopeBuilderFor` (`:358`), then full | one extra run. **Never gates the claiming run**: `ProposalEvidence.completion` and `isCompleteByFact()` still require the harness's own code-detected suite |
| **R2** | **Q17 `fix` + `is_fix_patch_<sha4>`** (exists, `src/synth/llm/rank.ts`) | unchanged, but dispatched through `routeSpeculative` instead of awaited | order of ≤ 8 distinct samples in the verify queue; the queue already stops on the first plausible outcome, so a good order directly removes lane runs | order-only keys carry no position; fix-absent signals stay **recorded** only | `sourcePriorAt()` order — today's behaviour | at worst today's number of runs |
| **R3** | **Q24 `prewarm_first`** — Choice over ≤ 8 code-built bundles + escape | new, `src/synth/sieve/prewarm.ts` | what the prewarm pool builds **while** the oracle and `locate` run | argmax iff P(top) ≥ 0.7 | `mem.oracle.tRunMs` / `oracle.lanes` heuristic = today | slack CPU only |
| **R4** | **Q25 `same_situation`** — one Noul over two code-computed digests (listing hash, attempts hash) plus the count of distinct untried cached candidates | new, beside `llmCacheKey` in `src/synth/llm/source.ts` | whether a cached LLM round may be **replayed** instead of re-fired | replay only at **p ≥ 0.9** (the Noul-per-line 17/17 bin) **and** only with ≥ N distinct untried candidates | fire the round | if every replayed candidate turns out `tried`, the round fires immediately — one wasted `LLM_REPLAY_DEADLINE_MS` |
| **R5** | `keep_<i>` / `still_relevant_<rel>` (≤ 16 + ≤ 16 Nouls, one request per compaction; `docs/COORDINATION-DESIGN.md` §8.6) | planned `src/loop/compaction.ts`, `src/loop/context-cache.ts` | which facts and files stay in view — fewer input tokens ⇒ lower TTFT | ≥ 0.5 with criteria (the 48/48 bin) | LRU by `lastUsedStep` with pins human > jev > edit > read | a dropped fact is re-derived; the trigger and thresholds stay code, so a Jev outage never blocks compaction |
| **R6** | **Q1 `attack_first`** (exists, `src/synth/search/goals.ts pickGoalDetailed`) | unchanged | goal order — the cheapest and earliest router | argmax iff it beats the runner-up by > 0.02; skipped with one open goal | code order | one goal attempted in a worse order |
| **R7** | **Q2–Q6 localisation** (exists, `src/synth/localize/*`, `src/synth/search/sites.ts`) | unchanged, but now ranking **within** the M8 index shortlist | shrinks listings ⇒ fewer generator output+reasoning tokens at 16.4 ms/token | h1 hint stays gated at Q5 P(top) ≥ 0.9 (`H1_MIN_TOP_P`), the 92 % bin | traceback frames are **always** listing members regardless of Jev's rank | a worse listing; the model still sees the traceback functions |
| **R8** | `finishes_within_step` (M19), asked only when the code classifier is undecided | new, `src/sandbox/background.ts` | foreground vs background for an unclassified long-running command | ≥ 0.7 to background | foreground with today's clamped timeout | one command in the wrong lane; the tree kill still applies |

**[graft: Capability-first] Two invariants that apply to all of R1–R8, unit-tested:**

1. **Scope usability.** A scoped test command's result may be used as evidence **only** if the run reported a non-zero collected/total count; otherwise fall back to the full suite and record `scope_unusable` in the step record. Without this, a too-narrow scope reads "0 failing" as success — the one way R1 could touch correctness rather than just cost a run.
2. **No withholding.** **No Jev answer may remove a candidate from the run queue.** This is the Q17 rule of `docs/LLM-JEV-DESIGN.md` §4 stage 4g, generalised: routers order, they never veto.

---

## 4. The fast step: the new per-step timeline, with the wall arithmetic

### 4.1 How the wall is apportioned today

From `experiments/results/llm-jev-headtohead.md` §6, `timing.*` over the 28 as-run tasks:

| share of wall | QuixBugs | ladder | SWE |
|---|---|---|---|
| `synthMs` (the whole synthesizer) | 99 % | 99 % | 84 % |
| of which generator wait (exposed, not overlapped) | 29 % | 30 % | 6 % |
| of which Jev (`jevMs` / `wallMs`) | 3.7 % | 7.3 % | 8.0 % |
| **residual = lane verification + localisation + harness** | **≈ 66 %** | **≈ 62 %** | **≈ 70 %** |
| harness commit path | < 1 % | < 1 % | < 1 % |

Median task / steps: QuixBugs 34 s / 2.7 → **≈ 12.6 s per step**; ladder 47 s / ≈ 2.6 → **≈ 18 s per step**; SWE (sympy-15345) 2m37s / 2 → **≈ 78 s per step**.

**The load caveat, stated plainly.** My per-run measurements in §1.1 are on an **idle** machine. The bench ran at 1-minute load **22–37** with 8 worktree lanes per run and peaked at 4.49 GB RSS, so its effective per-candidate cost was several times the idle floor (66 % of a 12.6 s QuixBugs step over ≈ 1,375 candidate runs per task implies ≈ 280 ms effective per run against my 74 ms idle measurement). That cuts **both** ways and the direction matters: the removable part — `sandbox-exec` + `/bin/sh` + interpreter start + `import pytest` + the per-case subprocess fan-out — is **≈ 91 % of a QuixBugs candidate run and ≈ 50 % of a ladder one at idle**, and it is inflated by load at the same rate as everything else. So the *ratios* (3.9× warm pytest, 26× fork-per-case) are what carry, and the absolute saving under the bench's real load is **larger** than the idle arithmetic below, not smaller.

### 4.2 The new step, QuixBugs / ladder class

Ordered by what is on the critical path, not by stage number.

```
t=0     run start (step 1 only) ─┬─ oracle (code)                        1–6 s
                                 ├─ locate  (Jev R7, chunked)            0.2–1.5 s
                                 └─ PREWARM (M5): createLanes + runner
                                    server boot, load-aware, cancellable  ← overlapped, not on the path

t=0     step start ──┬─ dispatch(codeOrder[0]) for every router          ← M10: nothing is awaited
                     ├─ R1/R2/R3/R6 issued in one merged request (M9)    0.24 s, dropped at 0.4 s
                     └─ LLM round L1 fired (M1 hedge armed, M3 stagger)

t≈0.0   seed sieve begins on the WARM runner (M6)                        ← the old 8.3 s becomes 2–3 s
t≈TTFB  sample 0's first byte releases samples 1..N−1 (M3)               one cache write, N−1 reads
t≈h     any sample with no first byte at hedgeAfterMs gets a twin (M1)
t≈?     first plausible passer → COLD confirm re-run (M6)                +1 fresh run, ~0.1–0.2 s
        guard decides over seeds ∪ arrived LLM candidates
t≈+0    risk: code `ok` for a verified patch (already true)              0 s
t≈+0.05 execute: git apply                                               50 ms
t≈+0.0  judge: code; Q21/Q22 recorded only, merged (M9)                  0 s blocked
t≈+0.03 commit + async checkpoint                                        25–50 ms  (gate: p95 < 50 ms)
```

Arithmetic, per step, QuixBugs class. **[proj]** except where marked.

| component | today | after | lever | note |
|---|---|---|---|---|
| lane verification | ≈ 8.3 s | **2.1–3.3 s** | M6 (2.5–4× conservative; the idle measurement says 9×) | the single biggest line |
| generator, exposed | ≈ 3.7 s | **3.0–5.0 s** | M1 + M3 + M4 shorten the round, but M6 **exposes more of it** | see below |
| Jev, blocked | ≈ 0.47 s | **≈ 0 s** | M9 (cache + merge) + M10 (`jevWaitMs == 0` by construction) | invariant-tested |
| harness | ≈ 0.05 s | ≈ 0.05 s | gated, not improved | `step-overhead` p95 < 50 ms |
| **step total** | **≈ 12.6 s** | **≈ 6–8 s** | | **0.5–0.65×** |
| **task total** (2.7 steps) | **34 s** | **≈ 18–22 s** | | vs the `jev-off` baseline's 93 s |

Ladder class, same arithmetic at 18 s/step: lane 11 s → 3–4.5 s, generator exposed 5.4 s → 4–7 s, Jev 1.3 s → 0 ⇒ **≈ 9–12 s per step**, task 47 s → **≈ 25–32 s**.

**The structural point, and it is the most important sentence in this section.** Today the ladder step is bounded by the lane wall (≈ 33 s of runs on 8 lanes at step 1 of `account`, against a 23.9 s LLM round hidden inside it). **The moment M6 lands, the generator becomes the critical path** — the round is no longer hidden, so a naive reading of the Ring-2 table will show the generator's share jumping from 30 % to 55–70 %. That is the mechanism working, not failing. It is also exactly why M1–M4 must land in the very next wave: without them, M6's win is capped by the round it uncovers.

### 4.3 The new step, repository class

| component | today (sympy-15345, ≈ 78 s/step) | after | lever |
|---|---|---|---|
| lane creation (8 × `git worktree add`) | on the critical path at step 1 | **0** | M5 (overlapped with oracle + locate) |
| whole-repo reload (≈ 1,200 `.py`) | every step | **≈ 0 after step 1** | M7 (stat gate), M8 (ordering) |
| scoped suite, first choice | 11–100 s, narrowest-code-scope guess | **first choice is the informed one** | R1 `run_first`, with the scope-usability guard |
| sample deadlines | 31 of 34 samples lost on django-15128 | most become arrivals | M1 hedging + M2 fallback rotation |
| Jev, blocked | 8.0 % of wall, 17–179 requests/task | ≈ 0 blocked, **fewer requests** | M9 + M10 |

**[proj] −10…30 s on step 1** of a repository run, and the deadline-loss class largely converted into arrivals. Repository *correctness* is explicitly out of scope for this round and stays with the head-to-head — the sympy canary in §5 watches `laneWarmMs`, `indexReuse`, R1's chosen scope and the TTFB distribution, not the verdict.

### 4.4 What is measured, additively, to make all of the above checkable

All fields optional, conditional-spread under `exactOptionalPropertyTypes`, `CheckpointEnvelope.version` stays `1` (`docs/DESIGN.md` §4 Contract 1.1), so a pre-Fastlane checkpoint still loads.

- `StepTiming` (`src/core/types.ts:380-390`) gains `jevWaitMs?`, `prewarmMs?`, `screenMs?`, `confirmMs?`, `checkMs?`, `repomapMs?`.
- `LlmRoundSummary` gains `ttfbMs[]`, `hedges`, `hedgesWon`, `cacheRead`, `cacheWrite`.
- `GoalSearchTrace` gains `router: {issued, applied, dropped}[]`, `screened`, `screenMismatches`, `scopeUnusable`.
- New counters surfaced per run: `indexReuse` (files skipped / files listed in `loadPythonFiles`), `laneWarmMs`, `laneSpawnMs`, `replacerTier`, `poolCandidates`, `earlyStopAt`, `readBytes`.

---

## 5. Quick-iteration plan

**Principle: no benchmark until a probe says the change is real.** Three rings, each strictly cheaper than the one above it. Ring 0 costs $0 and seconds; Ring 2 costs ≈ $0.01 and ≈ 2 minutes. A change reaches Ring 2 only after Ring 0 and Ring 1 agree, and reaches the head-to-head only after Ring 2 shows ≥ 10 % median-wall improvement with **zero verdict changes**.

Task selection follows "Efficient Benchmarking of AI Agents" (https://arxiv.org/html/2603.23749, 2026-09-21): iterate on a **mid-difficulty subset** rather than a full suite — the paper reports 44–70 % task reduction (median 58 %) at LOSO Spearman 0.92. Every task below is one JevCode already passes, so a regression is unambiguous.

### Ring 0 — micro-probes: no network, no API (seconds, $0)

Five probes, wired into `src/perf/main.ts` (`ProbeName` at `:48` is today `'first-frame' | 'step-overhead' | 'static-append' | 'render-lag' | 'composer-latency' | 'intake-latency' | 'idle-frames' | 'states'`; `ALL_PROBES` at `:49` and the `src/perf/readme.ts` rows extend with it).

| probe | new file | measures | gate |
|---|---|---|---|
| **P2 `lane-run`** **[fix — this is the re-spec, and it is the most important correction in the document]** | `src/perf/lane-run.ts` | p50/p95 of **one real candidate run** — `python3 run_tests.py <name> <candidate>` for `candidate_file` mode and `python -m pytest -q <goal files>` for pytest mode — cold-spawn vs through the persistent runner of M6 | **M6 ships only if the warm path is ≥ 2× on this probe.** |
| P2b `sandbox-spawn` | `src/perf/sandbox-spawn.ts` | the wrapper alone: `sandbox-exec -f <profile> /bin/sh -c true` vs bare | **report only, never a gate** |
| P3 `py-load` | `src/perf/py-load.ts` | `loadPythonFiles` over a synthetic 1,200-file fixture: cold, warm-parse (today), stat-gated (new) | stat gate ≥ 3× the warm-parse path |
| P4 `jev-batch` | `src/perf/jev-batch.ts` | mocked decider: 5 sequential requests vs 1 merged vs 5 concurrent, plus the cache-hit path | the merge must be within noise of one request |
| P5 `router` | `test/unit/loop/router.test.ts` (unit, not perf) | `routeSpeculative` with an `ask` that never resolves adds **0 ms** of blocked wall and returns `source:'code'`, `dropped:true` | hard pass/fail |
| P1 `llm-sample` | `src/perf/llm-sample.ts` (`--live` only) | 6 real `propose_fix` calls on one checked-in prompt: TTFB, total, `reasoning_tokens`, `cached_tokens`, `cache_write_tokens`, `servedProvider` — `{effort:'low'}` vs `{maxTokens:256}`, staggered vs simultaneous release | ≈ $0.003; decides M3 and M4 |

**Why P2 had to be re-specified.** The draft's P2 compared pooled vs unpooled `ctx.sandbox.run('true')`. I measured that today: the seatbelt wrapper is **6.8 ms vs 2.8 ms bare — about 4 ms**. Against a 4 ms baseline a pool looks like a 12× win and would sail through a ≥ 2× gate while telling you nothing, because the real cost is the **interpreter and the test framework**: `python3 -c pass` 13.4 ms, `import pytest` 67.3 ms, a real QuixBugs candidate run 74.3 ms, a real ladder candidate run 182.7 ms. P2 must measure a candidate run end to end or it measures the wrong thing.

Plus the existing gate must not move: `step-overhead` harness p95 **< 50 ms**. **[fix]** This is not a margin to defend, it is a live regression: the four recorded runs read **45.7** (with a reviewer's 50.1 FAIL), **51.1 FAIL**, **52.6 FAIL**, **49.6 pass** (`docs/STATUS.md:392`, `:724`, `:769`, `:832`). Wave S0 owes a **fix** — the named contributors are the `run`-step path (p95 64.8 ms in the failing run) and `imagesMs` (p95 19.9–24.5 ms) — not merely a promise not to make it worse. Every later "harness p95 unchanged" gate is meaningless against a failing baseline. `promptBuildMs` p95 < 5 ms is gated alongside it.

### Ring 1 — replay (seconds, $0)

`jevcode inspect --replay <run-id>` (new `src/loop/replay.ts`, M15) rebuilds a finished run from `~/.jevcode/runs/<id>/{steps,decisions,generator}.jsonl` with recorded provider and decider responses. Every engine-side change — router dispatch, queue order, prewarm scheduling, window and limits, loop signatures, TUI rendering — is iterated here at **no dollars and no latency**. The 28 head-to-head run dirs are the corpus. Acceptance: identical committed patches on all 28, or a named and explained difference.

**[graft: Dispatch]** Ring 1 also runs the safety gate: **`--jev off` must complete all of Ring 2's tasks**, only slower. It is nearly free here, so it runs on every iteration.

### Ring 2 — the tiny live tasks (≈ 2 min wall, ≈ $0.01)

`jevcode bench --quick --live --conditions llm-jev --concurrency 3 --spend-cap 0.05`

| # | task | suite | today (`llm-jev`) | why this one |
|---|---|---|---|---|
| 1 | `gcd` | QuixBugs | pass, 3 steps, 16 s, $0.0005, 4 Jev req, committed by `sieve` | seeds win the race — the "LLM must cost one sample" case; M3's stagger must not slow it |
| 2 | `tagcloud` | ladder short | pass, 2 steps, 11 s, $0.0005, 9 Jev req, `sieve` | **the floor**: any regression here is pure harness overhead |
| 3 | `units` | ladder short | pass (equivalent), 2 steps, 22 s, $0.0008, 8 Jev req, committed by `llm` | the LLM-decides path with a small prompt |
| 4 | `kth` | QuixBugs | pass, 3 steps, 33 s, $0.0007, 4 Jev req | second sieve-heavy program; **449 candidates tested in one step** on this class — the screen/confirm mismatch detector |
| 5 | `mergesort` | QuixBugs | pass, 3 steps, **2m58s**, $0.0140, **36 Jev req**, committed by `rank` | the RANK/Q17 path and the Jev-request outlier — **M9 and R2 live or die here** |
| 6 **[graft: Capability-first]** | `q-self-edit` | **this repo**, offline | n/a (new) | "make `countOccurrences` in `src/workspace/edit.ts` reject an empty needle" with a new failing test in `test/unit/workspace/edit.test.ts` — the only task that exercises a **non-Python** path end to end, at $0 against a local repo. It is also the task that will *fail* until the scope-builder graft lands, which is the point. |
| 7 **[graft: Capability-first]** | `q-drifted-edit` | fixture, mock provider | n/a (new) | `test/fixtures/drift/`: the model's `old` string differs by indentation and trailing space. Pure code path, **$0**, exercises M11 tiers 2–7 plus the M12 syntax guard. |

**One repository canary, not a suite.** `sympy__sympy-15345` (today: 2 steps, 2m37s, 17 Jev req, `complete` but FAIL) runs **once per wave**, live, as a single task — to watch `laneWarmMs`, `indexReuse`, R1's chosen scope and the TTFB distribution on a real 1,200-file tree. Not to score correctness.

### What is measured on every Ring-2 run

Summarised by a new `experiments/fastlane/quick-table.mts` from `steps.jsonl`:

- **wall** per step p50/p90 and per task median (baseline: 16 / 11 / 22 / 33 / 178 s)
- **steps**, **verdict** (gold-identical / equivalent / **overfit**), **stopReason**
- **$** split generator vs Jev, and **Jev requests** (baseline 4 / 9 / 8 / 4 / 36)
- **`jevWaitMs`** (new; must stay ≈ 0 for routers) vs `jevMs`
- sample **TTFB** p50/p90, hedges fired, hedges won, cancels by reason
- **`cacheRead` / `cacheWrite` / `cacheHitRate`** per round, `servedProvider`
- `laneWarmMs`, `laneSpawnMs`, `screenMs`, `confirmMs`, **`screenMismatches` (must be 0)**
- `indexReuse` = files skipped / files listed in `loadPythonFiles`
- `scopeUnusable` count (must be 0 on these tasks)
- harness p95 (gate 50 ms) and `promptBuildMs` p95 (gate 5 ms)

### The loop

1. **Write the probe first.**
2. Run Ring 0.
3. Run Ring 1 over the 28 replay dirs, including the `--jev off` gate.
4. Run Ring 2 **twice** — the ladder `stats` and `shipping` overfits in the head-to-head came from seed/LLM race timing, so any wall change must be run twice before it is believed.
5. **Accept only if**: median wall **−≥ 10 %** on at least three of the five live tasks; **no verdict changed**; **[graft: Capability-first] overfit count not increased** (baseline: 5 overfits vs the `jev-off` baseline's 0 — a speculation-heavy design must not be able to trade that away silently); `screenMismatches = 0`; `scopeUnusable = 0`; harness p95 unchanged; Jev requests not increased.
6. Record the row in `experiments/results/fastlane-quick.md` and move to the next mechanism.

Mechanisms land in the §6 order precisely because each is independently measurable on this one table.

### Micro-gates on every `npm run check` (no API, < 20 s)

`test/unit/loop/router.test.ts` (the P5 invariant) · `test/unit/sandbox/pool.test.ts` (allowlist: a `run` action is refused the pool) · `test/unit/synth/sieve/screen-confirm.test.ts` (a screened passer that fails cold disables the worker and re-queues) · `test/unit/workspace/edit-ladder.test.ts` (one case per tier + the multi-match hard error) · `test/unit/checks/syntax.test.ts` · `test/unit/workspace/repomap.test.ts` (known PageRank order, cache hit by mtime, **byte-identical output on two runs**) · `test/unit/loop/output-shape.test.ts` · **[graft: Capability-first]** one **Jev-down test per Jev path** (R1–R8): a `Decider` that throws must produce the exact documented fallback · and the **no-withholding invariant**: no Jev answer removes a candidate from the run queue.

---

## 6. Implementation plan, in waves

Seven waves. Every wave leaves `npm run typecheck && npm run test && npm run perf` green, is independently revertible, sits behind a config row whose default is today's behaviour, and is gated by the Ring-0/1/2 table of §5. LOC excludes tests. All paths under `/Users/prateekjannu/Documents/vscode/JevCode`.

**[fix — wave order changed from the winning design.]** Fastlane's draft ran the generator wave (its S1) before the warm-runner wave (its S2). The measured wall says the opposite: the lane queue is ≈ 62–66 % of wall and the exposed generator wait is 29–30 %, and on a ladder step the LLM round is *hidden inside* the lane wall today (step 1 of `account`: ≈ 33 s of runs against a 23.9 s round). Landing the generator wave first would measure ≈ 0 improvement on the cheap classes and wrongly discredit hedging. **The runner goes first.** Both judgements asked for this ordering.

---

### S0 — measure, make iteration free, and fix the perf gate (1 day, ≈ 550 LOC, no behaviour change)

Ships first and alone, because everything after it is judged by it.

- `src/core/types.ts`: the additive fields of §4.4. `CheckpointEnvelope.version` stays `1`; every field optional with conditional spread.
- `src/provider/sse.ts`: a first-byte callback on the stream so TTFB is recorded once per sample (beside `linkedAbort` at `:442`).
- New `src/loop/replay.ts` + `--replay <run-id>` in `src/cli/inspect.ts`, reusing `src/provider/mock.ts`, `src/jev/mock.ts`, `src/bench/stub-decider.ts`.
- New probes `src/perf/{lane-run,sandbox-spawn,py-load,jev-batch,llm-sample}.ts`; extend `ProbeName` and `ALL_PROBES` (`src/perf/main.ts:48-49`) and the rows in `src/perf/readme.ts`.
- **Fix the harness gate**, do not merely protect it: profile the `run`-step path (p95 64.8 ms in the failing run) and `imagesMs` (p95 19.9–24.5 ms, target 15 ms) and land the reduction. Gate: three consecutive `step-overhead` runs at p95 < 50 ms before S1 starts.
- `src/bench/cli.ts`: the `--quick` preset (§5 Ring 2, concurrency 3, replay default, `--spend-cap 0.05`); `src/bench/runner.ts`: **deep-copy the per-worker config**; derive `CONDITIONS` in `src/cli/args.ts:295` from `src/bench/conditions.ts parseConditions` instead of the parallel literal.
- New `scripts/jev-contract.mjs` — the four-clause lint rule of §1.2 — wired into `npm run check` beside `scripts/no-any.mjs`.
- New `experiments/fastlane/quick-table.mts`.

**Tests.** `test/unit/bench/{quick,replay}.test.ts`; `test/unit/loop/replay.test.ts` (28-dir corpus, fixture-backed); a fixture checkpoint captured **before** S0 that must still load through `foldStepsIntoState` (`src/checkpoint/resume.ts:147`).

**Gate.** `step-overhead` p95 < 50 ms three times running; all probes report; replay reproduces a known run byte-for-byte on its committed patch.

---

### S1 — the warm verification plane: persistent lane runner, screen hot / confirm cold (2 days, ≈ 700 LOC)  ← **the top lever**

- New `src/sandbox/pool.ts`: pre-spawned `sandbox-exec -f <profile> /bin/sh` workers with sentinel-delimited commands, an **explicit allowlist of harness-owned callers**, a per-command deadline, and the hard rule (unit-tested) that `Action.kind === 'run'` never uses it — the agent's own commands keep `src/sandbox/run.ts` with its three-pass tree kill (`src/sandbox/kill.ts`), per-command env scrub and per-command timeout.
- New `bench/data/quixbugs/run_tests_server.py`: the **zygote** variant — stdin command loop, `importlib` the candidate, `fork()` per case with the existing SIGALRM/wall timeout, identical one-line JSON output. Driven from `src/synth/sieve/runner.ts` for `candidate_file` mode.
- Warm-interpreter `pytest.main(['-q','-p','no:cacheprovider', …])` loop for pytest lane modes, with `importlib.invalidate_caches()` and an explicit `sys.modules` purge of workspace packages between candidates.
- `src/synth/llm/candidates.ts`: `createAstCompileCheck` (`:131`) routed through the pool (its content-hash verdict cache is already there).
- `src/synth/sieve/runner.ts`: the **screen-hot / confirm-cold** rule — a passer produced on a warm worker is re-verified by a fresh cold spawn before `src/synth/search/guard.ts decide`; `screened: true` recorded into `ProposalEvidence`; `screen:mismatch` disables the worker for the run and re-queues the batch cold.
- **[graft: Capability-first]** `src/workspace/tests.ts`: add `jestScope`, `vitestScope`, `cargoScope`, `goScope` and their `scopeBuilderFor` cases (`:358`) — the parsers already exist (`parseJest :596`, `parseCargo :628`, `parseGo :641`, all already in `ALL_PARSERS :653`). ≈ 120 LOC. This is the highest value-per-line change in the plan: without it, the warm pool, the prewarm and the screen/confirm machinery are all reachable only behind the `.py` gate at `src/synth/index.ts:305`. Plus the **scope-usability guard**: a scoped run's result is usable as evidence only if it reported a non-zero collected/total count, else fall back to the full suite and record `scope_unusable`.
- **Deferred, named explicitly:** widening `synthesizerHandles` (`src/synth/index.ts:305`) so the synthesizer itself runs on non-Python trees is **not** in this round. It would move the dominance claim, which is a correctness question, not a speed one. The scope builders land now because M12 and Ring-2 task 6 need them; the handler widening gets its own design round and its own gate.

**Tests.** `test/unit/sandbox/pool.test.ts` (allowlist refuses a `run` action; sentinel desync disables; worker crash re-queues cold) · `test/unit/synth/sieve/screen-confirm.test.ts` (a screened passer failing cold disables the worker, emits `screen:mismatch`, and never reaches `decide`) · `test/unit/workspace/tests-scope.test.ts` (each new scope builder; `scope_unusable` on a zero-collected run) · a zygote-vs-cold output-equality test over all QuixBugs programs.

**Gate.** **P2 `lane-run` ≥ 2×** or the mechanism is dropped, not softened. `screenMismatches = 0` on `kth` and `mergesort`. Harness p95 unchanged. **[graft: Capability-first]** overfit count not increased.

---

### S2 — the generator path: hedging, pinning, cache prefix, reasoning cap (1½ days, ≈ 400 LOC)

Lands immediately after S1 because S1 **uncovers** the round (§4.2).

- `src/provider/types.ts:243-244`: widen `OpenRouterProviderPrefs`; `src/provider/openrouter.ts:130` `providerPrefsOf` maps verbatim; widen `GenerateRequest.providerPrefs` in `src/core/types.ts`; config rows `generator.providerOrder`, `generator.providerSort` (default `'throughput'`), `generator.maxPrice`, `generator.cacheTtl`, `generator.cacheWarmStagger` (default `'auto'`) across `src/config/{types,defaults,resolve,validate}.ts` + `src/cli/args.ts` + `src/cli/config-table.ts` + completions + `man/jevcode.1` + `docs/COMMANDS.md`.
- `src/synth/llm/prompt.ts`: freeze the stable prefix; move every per-sample-volatile section last; a unit test asserts byte-identity of the prefix across a round.
- `src/synth/llm/source.ts`: the cache-warm stagger on the repository class (release 1..N−1 on sample 0's first byte); `reasoning: {maxTokens: 256}` on the cheap classes; **hedging** — `hedgeAfterMs = clamp(2 × running TTFB p50, 3_000, 8_000)`, `LLM_HEDGES_PER_ROUND = 1`, `CancelReason 'hedge'`, refused when `llmUsdLeft` cannot hold one more estimated-full-cost sample, twin rotates `provider.order`.
- `src/provider/anthropic.ts`: the `ttl:'1h'` option; `src/provider/prompts.ts`: prefix order `system → repo map → files → window` so the `jev-on`/`jev-off` prefix is byte-stable **between** steps.
- Surface `cacheRead` / `cacheWrite` / `cacheHitRate` from the already-parsed `cached_tokens` / `cache_write_tokens` (`src/provider/openrouter.ts:274-275`).

**Tests.** `test/unit/synth/llm/prompt-prefix.test.ts` (byte-identity) · `test/unit/synth/llm/hedge.test.ts` (fires at the threshold, one per round, loser cancelled with reason `hedge`, both metered, refused under budget) · `test/unit/provider/provider-prefs.test.ts` (`only` is never emitted; `allow_fallbacks` defaults true) · `test/unit/synth/llm/stagger.test.ts` (auto-disables on a zero-`cached_tokens` round).

**Gate.** Probe P1 + Ring 2. Expected: round p90 −40…60 %, prompt input cost −≈ 80 %.

---

### S3 — incremental indexing and one bounds module (1½ days, ≈ 550 LOC)

- `src/workspace/files.ts`: `readIfChanged(path, {size, mtimeMs}, maxBytes)`; `loadPythonFiles` (`src/synth/search/index.ts:352`) stats first with byte-equality as the second gate; the same short-circuit in `src/workspace/candidates.ts`.
- New `src/workspace/index/{tags,rank,store}.ts` → `~/.jevcode/index/<repoKey>/tags.json` keyed by `path+size+mtime`; warmed by one `unref`ed timer **after** the first frame; personalised PageRank per the M8 spec; consumed by `src/synth/localize/outline.ts` and the pre-filter in `src/loop/stages/context.ts`.
- New `src/workspace/outline.ts` (body elision ≥ 5 lines; Python via `src/synth/py/structure.ts`, a sibling scanner for TS/JS) and new `src/core/limits.ts` absorbing the caps at `src/loop/window.ts:10-15`, `src/checkpoint/resume.ts:20-24`, `src/provider/prompts.ts:15,220,227`, `src/loop/stages/execute.ts:64-80`, plus **[graft: Capability-first]** the `contextTokens` column in `PRICING_TABLE` (`src/config/defaults.ts`) and `usable = input_limit − min(20k, maxOutput)`.
- `Action.read` gains `mode?: 'outline'|'window'|'full'`, `line?` in `src/core/types.ts`, `src/provider/actions.ts` and `src/loop/stages/execute.ts`.

**Tests.** `test/unit/workspace/repomap.test.ts` (fixed PageRank order on a 6-file fixture; cache hit by mtime; **byte-identical output on two runs**) · `test/unit/workspace/read-if-changed.test.ts` · `test/unit/loop/execute-read-modes.test.ts` · `test/unit/core/limits.test.ts` (no cap is defined twice).

**Gate.** P3 ≥ 3×; `indexReuse > 0.9` on the sympy canary; first-frame p95 < 300 ms unchanged; `repomapMs` warm < 150 ms, cold < 1.5 s on this repo.

---

### S4 — Jev as router (1½ days, ≈ 550 LOC)

- New `src/loop/router.ts` (`routeSpeculative`, `ROUTER_DEADLINE_MS = 400`) + the P5 invariant test; new `synth` phases `router:issued|applied|dropped` in `src/core/types.ts`.
- New `src/jev/cache.ts` (exact-digest, in-run memo + `<runDir>/cache/jev/<sha12>.json`, `--jev-cache off`); keep-alive dispatcher in `src/jev/client.ts`; Q17 merged into the Q8–Q10 request across `src/synth/rank/index.ts` and `src/synth/llm/rank.ts`; normalised patch dedupe (M9b) before options are built.
- **R2**: replace the real awaits with `routeSpeculative` — `src/synth/search/subgoal.ts:848`, `:1575` (`deps.rank`), `:763` (`gateHeldPartial`), `:156` (`ctx.ask` edit-class). **[fix]** Not `:786`/`:799`, which are synchronous.
- **R1**: new `src/synth/oracle/scope.ts` (Q23 `run_first`, ≤ 10 concrete commands + escape, 0.05 margin), consumed by `src/synth/oracle/verify.ts runRepositoryQueue`, with the S1 scope-usability guard in front of it; the claiming run stays code-detected.
- **R3**: Q24 `prewarm_first` in the new `src/synth/sieve/prewarm.ts`, and `createLanes` (`src/synth/sieve/lanes.ts:214`) moved to run start in `src/synth/search/index.ts`, load-aware via `LOAD_QUIET` (`src/perf/main.ts:44`), cancellable on `ctx.signal`, disposed through `disposeSignal` (`docs/COORDINATION-DESIGN.md` §6.7), registered as `type:'lane'` leases through the `SynthesisContext.coordination` hook (§6.2 of that design).
- **R4**: Q25 `same_situation` beside `llmCacheKey` in `src/synth/llm/source.ts` (p ≥ 0.9, and only with ≥ N distinct untried cached candidates).
- Every question built with `choice()/noul()/contextNoul()/score()` from `src/jev/questions.ts` so `assertQuestionBatch` enforces the both-sided-definition and escape rules at build time; all of them reach the decider only through `ctx.ask`, so they land in `decisions.jsonl`, `jev.jsonl`, the meter and the pane.

**Tests.** `test/unit/loop/router.test.ts` (the `jevWaitMs == 0` invariant; a never-resolving `ask`; a 503; a timeout; reorder-on-arrival of the pending tail only) · **[graft: Capability-first]** one throwing-`Decider` test per router R1–R8 asserting the exact documented fallback · the **no-withholding** invariant test · `test/unit/jev/cache.test.ts` (never crosses model ids; `--jev-cache off`) · `test/unit/synth/oracle/scope.test.ts` (a zero-collected scope is `scope_unusable` and falls back).

**Gate.** `jevWaitMs ≈ 0`; **Jev requests down** on `mergesort` (36 today) and the sympy canary (17); no verdict change; `scopeUnusable = 0`.

**Scheduling note.** S4 is the wave that touches `src/loop/engine.ts` and `src/core/types.ts`, which the coordination workstream is also editing (`docs/COORDINATION-DESIGN.md` W0–W2). Resolve the ordering with that owner **before** S4 starts.

---

### S5 — step avoidance: the write path, diagnostics, background, loops, graceful stop (1½ days, ≈ 550 LOC)

- `src/workspace/edit.ts`: the replacer ladder (M11); the three anchoring implementations (`edit.ts:25`, `src/synth/llm/candidates.ts:77`) collapse into `src/workspace/anchor.ts`; multiple matches stay a hard `EditError`; the tier is recorded in `ActionOutcome` and rendered in `src/tui/Review.tsx`; **any tier beyond `ws-normalised` requires a passing syntax check**. Explicitly **not** applied to the `llm-jev` anchor path (58/58, 0 % misanchored).
- M11b escalation to whole-file `write` after two consecutive apply failures on the same file, with hint `h5` in `src/synth/llm/prompt.ts`.
- New `src/checks/{syntax,diagnostics,format,detect}.ts` (M12), called from `src/loop/stages/execute.ts` after `edit`/`write`/`patch`, through the S1 pool; revert of changed paths only via `src/workspace/git.ts restoreFromHead`.
- New `src/loop/output-shape.ts` (M13b, grep-family file-list reshaping) and the `<runDir>/outputs/step-<n>.txt` spill + `jevcode:outputs/step-<n>.txt` pseudo-path through `src/checkpoint/store.ts`, redacted via `src/core/redact.ts`.
- **[graft: Dispatch]** New `src/sandbox/background.ts` (M19): auto-background on first timeout for code-classified long-lived commands; `Action.run.background?`; the new `poll` action; the `finishes_within_step` Noul only for the undecided case.
- `src/loop/loopdetect.ts`: the alternation signature over a bounded 20-step scan, `consecutive_timeouts: 3`, and the hard-capped "legitimate waiting" escape on Q19.
- `src/loop/stop.ts` + `src/loop/budget.ts`: the graceful last step (reduced action set, handoff summary stored at the pause point).

**Tests.** `test/unit/workspace/edit-ladder.test.ts` (one case per tier, the multi-match hard error, CRLF/BOM preserved, the syntax-gate coupling) · `test/unit/checks/{syntax,detect}.test.ts` · `test/unit/loop/execute-check.test.ts` (a syntax-broken edit never commits and reverts only the changed paths) · `test/unit/loop/output-shape.test.ts` · `test/unit/sandbox/background.test.ts` (backgrounded process stays in the run's group and dies with the tree kill) · `test/unit/loop/loopdetect-alternation.test.ts` (A-B-A-B trips; 6/10 → 8/10 → 9/10 still does **not**).

**Gate.** `checkMs` p95 ≤ 400 ms on the syntax gate; a syntax-broken edit never commits; `q-drifted-edit` passes at $0; the ladder floor task `tagcloud` (11 s) does not regress at all.

---

### S6 — hooks, TUI coalescing, gates, docs (1 day, ≈ 350 LOC)

- New `src/loop/hooks.ts` (M14): per-stage `before/after` seam, JSON on stdin, **exit 2 blocks and cannot be overridden by any allow**, `async: true` for non-blocking hooks, a `stepBatch` hook at the commit point, per-hook deadlines; discovery and sha256 recording through `src/config/instructions.ts`'s machinery; markdown command templates wired into `src/tui/commands/registry.ts`.
- `src/tui/useEngine.tsx`: 16 ms event coalescing into one batched store update; the 100-entry message cap.
- New perf rows and gates in `src/perf/main.ts` / `src/perf/readme.ts`.
- Docs: `docs/DESIGN.md` gains §23 "Fastlane" with the per-stage table amended; `docs/LLM-JEV-DESIGN.md` §7 updated with the new speed plan; `docs/DECISIONS.md` records R1–R8 and their fallbacks; `docs/STATUS.md` gains the new counters; every adopted mechanism cited with URL + fetch date in `docs/RESEARCH.md`; `CHANGELOG.md` per wave.

**Gate.** Full `npm run check && npm run perf`; the `--jev off` CI gate green; the corner-case table complete.

---

**Total: ≈ 10 engineer-days, ≈ 3,650 LOC excluding tests**, with a measurable gate at the end of every wave and the whole plan revertible wave by wave.

| wave | days | LOC | targets | measured share of wall it attacks |
|---|---|---|---|---|
| S0 measure + fix the gate | 1 | 550 | — | makes everything else checkable |
| **S1 warm verification** | **2** | **700** | **M6, scope builders** | **62–66 %** |
| S2 generator path | 1½ | 400 | M1–M4 | 29–30 %, rising to 55–70 % after S1 |
| S3 indexing + limits | 1½ | 550 | M7, M8, M13 | queue 4, plus tokens |
| S4 routers | 1½ | 550 | M9, M10, R1–R4 | 3.7–8.0 %, plus 74 % of dollars |
| S5 step avoidance | 1½ | 550 | M11–M13b, M17–M19 | whole steps, not fractions |
| S6 hooks + docs | 1 | 350 | M14 | protects the 50 ms gate |

---

## 7. What is deliberately not adopted, and why

| rejected | source (fetched 2026-09-21) | why not, for a speed-first JevCode |
|---|---|---|
| **Language servers (LSP)** | opencode `lsp/lsp.ts`, https://opencode.ai/docs/lsp/ | opencode's own docs say servers "get out of sync, use significant memory, vary by version or project, and slow down agent workflows" and recommend CLI diagnostics instead. JevCode has a < 300 ms first-frame budget and a 50 ms harness gate that is **already oscillating around failure**. Adopt the feedback *shape* (M12), not the servers. |
| **A tree-sitter runtime dependency** | aider `repomap.py` | `package.json` has devDependencies only. M8 reuses the in-tree Python tokenizer and structure analyser (`src/synth/py/structure.ts` — a real tokenizer, not regex) and adds a brace/indent scanner for TS/JS. A `lang.<id>.tagsCommand` escape hatch may shell out to `ast-grep`/`tree-sitter` **if the user already has it**, never bundled. |
| **Embedding / vector retrieval** | various 2026 indexing papers | Needs a network call or a model on the startup path and an index to invalidate. PageRank over a symbol graph is deterministic, offline, cacheable by mtime, and explainable in the `/context` pane. |
| **Aider's architect/editor split as a default** | https://aider.chat/2024/09/26/architect.html | Worth 77.4 → 80.5 for Sonnet, but the same post concedes the top pairings "are therefore quite slow, so probably not practical for interactive use". With one fast model it is a pure extra round trip: +6.6 s intercept per call at GLM's measured fit. Keep it as a config-only escape hatch (`editor.provider/model`), **off by default**, and only flip it if a §5 sweep shows both lower wall/step **and** lower $. |
| **A trained critic / best-of-N whole-attempt rollouts as the default** | OpenHands 32B critic, 60.6 → 66.4 at N = 5 | The biggest *accuracy* lever and a straight multiplier on wall and dollars — the opposite of this brief. JevCode already has the cheap version: shadow lanes eliminate by test, then Jev arbitrates among survivors (gold-or-equivalent 10/10). Keep N = 2–4 whole-attempt rollouts behind an explicit `--attempts` flag. Note also the load reality: the bench already hit 4.49 GB RSS and 1-minute load 22–37 with 8 lanes on one task. |
| **Per-step action sampling with N−1 pairwise LLM comparisons** | SWE-agent `BinaryTrajectoryComparison` (min 4 / max 10 samples) | The comparison chain is N−1 generator calls at GLM's p50 2.7 s / p90 25.6 s. One Jev Choice over the deduped set (R2 / Q17) is the same decision at ≈ 237 ms and ≈ $0.001. Adopt the **trigger** heuristic (extra samples only when ≥ 2 distinct candidates and the step is edit-ish), not the mechanism. |
| **Trae's ensemble + recursive tournament voting** | https://arxiv.org/abs/2507.23370 | The normalised dedupe is adopted (M9b); the ensemble is another N-multiplier on generator spend. |
| **Persistent shell workers for the agent's own `run` action** | warm-pool practice; OpenHands persistent terminal with `is_input`/`reset` | A pooled process weakens the three-pass tree kill, the per-command env scrub and the per-command timeout in `src/sandbox/run.ts` — all correctness- and safety-critical. The M6 pool is restricted to **harness-owned** work by an explicit allowlist, unit-tested. |
| **`provider.only` + `allow_fallbacks: false`** | https://openrouter.ai/docs/features/provider-routing | The head-to-head lost the ladder task `shipping`'s entire LLM round to 3/3 `HTTP 429` and committed a seed overfit as a direct result. Pin with `order` + `sort: "throughput"`; keep `allow_fallbacks: true`. |
| **`preferred_max_latency` / `preferred_min_throughput`** | same page | The docs state they "do *not* guarantee you will get a provider or model with this performance level" — preferences only, rolling 5-minute percentiles, no SLA. Hedging (M1) is the enforceable version. |
| **`reasoning: {enabled: false}`** | in-tree probe `experiments/results/llm-jev-probes-off.md`; the note at `src/provider/openrouter.ts:87-88` | HTTP 400: "Reasoning is mandatory for this endpoint and cannot be disabled". Use `{maxTokens}` (M4). |
| **opencode's `doom_loop` (identical input ×3)** | https://opencode.ai/docs/permissions/ | A strict subset of `src/loop/loopdetect.ts`, which signs a failing test run by the **set of failing test ids** so 6/10 → 8/10 → 9/10 never trips. Adopting it would be a regression. Take only OpenHands' alternation signature and `consecutive_timeouts` (M18). |
| **Shadow git-dir snapshots per step** | opencode `snapshot/index.ts` (`objects/info/alternates` + copied index) | Genuinely clever — it exists because a naive `git add --all` "can take minutes" on a chromium checkout — but it is an *undo* feature that costs disk and time per step, and opencode's own config docs tell large-repo users to disable it. JevCode's checkpoints plus `src/undo/apply.ts` already give per-step reversibility. Defer to the coordination/undo workstream. |
| **Remote `instructions:` URL fetch at startup; session sharing / upload** | https://opencode.ai/docs/rules/ (5 s timeout); https://opencode.ai/docs/share/ | Network on the startup path violates the zero-network first frame; upload violates "no secrets in any artefact" (`docs/DESIGN.md` §1). Local `/export` only. |
| **MCP and the experimental Code Mode** | https://opencode.ai/docs/mcp-servers/, `tool/code-mode.ts` | MCP servers "add to your context" (the GitHub MCP "can easily exceed the context limit"), and JevCode proposes exactly one action per step, so there is nothing to collapse. Watch item. |
| **Subagents / background child sessions as a default** — i.e. the whole Dispatch design | Claude Code sub-agents (20 concurrent / 3 layers); opencode `tool/task.ts`; Codex `[agents]`; Goose `GOOSE_SUBAGENT_MAX_TURNS` | Three reasons, in order. (1) **Jev is measured worst here**: dispatch quality is plan judgment in a different costume, and jev-on's plan/intent judgment scored 9/29 vs jev-off's 10/29 with 208 blocks and 170 declined reviews. (2) **The speed argument is circular**: JevCode has no delegation today, so there is no generator routing turn to replace — the design makes fast a surface it introduces. (3) **The machine cannot afford it**: 4.49 GB RSS and load 22–37 with 8 lanes on one task; three live children is negative speed on a laptop. Keep the sub-work contract of `docs/COORDINATION-DESIGN.md` §6, `lanes.maxConcurrent` small, `childDepth: 1`. **What is grafted instead**: the four-clause Jev contract as a lint rule, the `--jev off` CI gate, hook-block precedence, the agent-file loader shape (M14), and auto-background (M19). |
| **SpecBox's semantic cache at τc = 0.8** | https://arxiv.org/html/2607.23933v1 (37.4 % hit vs 33.6 % exact) | +3.8 pp is not worth serving a *functionally different* result from a cache in a harness whose whole claim is that tests arbitrate. JevCode's Jev cache (M9) and round cache stay **exact-digest**; the near-miss judgment is R4, gated at p ≥ 0.9 and always re-verified by running the candidates. |
| **PASTE-style pattern mining over trajectories** | https://arxiv.org/html/2603.18897v1 (27.8 % top-1, 93.8 % hit) | Adopt the *policy* (graded speculation, slack budget, promotion/preemption) and the *prewarm* half. Skip the mined value-mapping predictions: one action per step gives too few in-run patterns, and Jev already answers "what next" better than a first-order model would. |
| **Runtime tool self-evolution on by default** | Live-SWE-agent, 77.4 % vs 74.2 % at $0.68 vs $0.56 per issue | +$0.12/issue and a per-step reflection call — the reflection is where the cost goes and it is a straight wall tax. Opt-in, confined to `<runDir>/tmp/scratch/`, asked at most once at replan. |
| **Cache keepalive pings** | aider `--cache-keepalive-pings` | Money spent while idle. Off by default; only while a run is explicitly paused, with a visible cost line. |
| **Aider's auto-commit / dirty-commit defaults** | https://aider.chat/docs/usage/lint-test.html | Checkpoints plus `src/undo/apply.ts` already give per-step reversibility, and a git write outside a judged step is forbidden (`docs/COORDINATION-DESIGN.md` §6.5). |
| **A second model as the approval reviewer** | Codex `approvals_reviewer = "auto_review"`; the Claude Code auto-mode classifier | JevCode already has calibrated harm Scores. What is taken instead is the **hard rule list around them**: a never-auto-approve set that bypasses Jev entirely, and "a failed or timed-out risk call means `ask`, never `allow`". |
| **A bash-only tool space / sentinel finish** | mini-SWE-agent | mini-SWE-agent proves a scaffold need not add tools, but JevCode's six actions are exactly what make the code-owned applier, the replacer ladder and the verified-evidence risk short-circuit possible. Keep six; do **not** add `grep`, `search` or `lsp` actions — M13b shapes output instead. (`poll` in M19 is the one addition, and it is a read of a file the harness already wrote.) |
| **Client/server split, OpenTUI / Bun / Zig, Effect-style rewrites** | opencode's stack; local note `docs/research/tui/01-opencode.md` | Valuable but orthogonal to speed, and not portable to Node 22 + Ink. Copy patterns (16 ms event coalescing, the 100-message cap, the keybind schema), never the stack. The client/server question belongs to the coordination owner. |
| **Widening `synthesizerHandles` beyond `.py` in this round** | in-tree, `src/synth/index.ts:305` | The scope builders land (S1) because M12 and the self-edit task need them, but widening the handler moves the **dominance claim**, which is a correctness question with its own bar (`docs/LLM-JEV-DESIGN.md` §1.3). It gets its own round. |

---

## 8. Risks

Ordered by how much of the design they can take down.

**R-1. Warm-worker state leakage is the one place this design can touch correctness.** A candidate that mutates module globals, registers an `atexit` handler, or leaves a file handle open can make a *later* candidate pass on a shared interpreter. The pytest path is the exposed one: `pytest.main()` in a warm interpreter reuses `sys.modules`, and my own measurement of it (42–48 ms vs 183 ms cold) was taken *with* that reuse. Mitigation is structural, not hopeful: the warm path only **screens**; every plausible passer is re-run **cold and isolated** before `src/synth/search/guard.ts decide` sees it; `screened: true` rides into `ProposalEvidence`; `importlib.invalidate_caches()` plus an explicit `sys.modules` purge runs between candidates; and **one** screen/confirm disagreement disables the worker for the whole run and emits `screen:mismatch`. If probe P2 shows the warm path under 2× the mechanism is **dropped, not softened**. The ladder overfits already in the head-to-head (5, vs 0 for the baseline) mean this harness cannot afford a new false-pass channel — which is why overfit count is a blocking Ring-2 metric.

**R-2. The idle-machine measurements may not transfer.** Every number in §1.1 was taken on an idle laptop; the bench ran at 1-minute load 22–37 and 4.49 GB RSS. The *ratios* should transfer (fixed overhead inflates with load at the same rate as the work), but under heavy load the fork-per-case win could shrink if the limiting resource becomes memory bandwidth rather than process creation. Mitigation: probe P2 runs under `LOAD_QUIET` **and** is re-run once under a synthetic 8-lane load; the Ring-2 acceptance rule requires the improvement to hold on two runs.

**R-3. Prewarm can make a loaded laptop slower.** Creating the lane pool at run start, plus a prefetch pool, plus a background index warm, can push a developer machine into swap and lose more wall than it saves. Mitigations: prewarm is load-aware through `LOAD_QUIET` (`src/perf/main.ts:44`); the prefetch pool is capped at 4 read-only jobs; the index warm is a single `unref`ed timer after the first frame; every job is cancelled on `ctx.signal` and disposed through `disposeSignal`. Ring-2 acceptance requires the `tagcloud` floor task (11 s today) **not to regress at all**.

**R-4. The 50 ms harness gate is already failing, intermittently.** Four recorded runs: 45.7 (with a reviewer's 50.1 FAIL), 51.1 FAIL, 52.6 FAIL, 49.6 pass (`docs/STATUS.md:392`, `:724`, `:769`, `:832`). Any Fastlane work on the step path — index lookups, router bookkeeping, hook dispatch, the extra timing fields — can flip it. Rule enforced in review: **new work is background, `unref`ed and cancellable, or it does not ship**; `step-overhead` is re-run at the end of every wave; and S0 must *fix* the gate (the `run`-step path and `imagesMs` are the named contributors) before S1 begins, or every later "unchanged" claim is measured against a failing baseline.

**R-5. Jev routers can add requests instead of removing them.** Jev is already 74 % of `llm-jev` dollars ($0.2010 of $0.2704 over 28 tasks; 741 requests; 179 on one SWE task). Four new questions (Q23–Q25 plus the merged Q17) risk making the cheap arm expensive. Mitigations: routers must be **merged** into requests whose state already exists rather than issued separately; the exact-digest cache (`src/jev/cache.ts`) lands in the **same wave**; and Ring-2 acceptance explicitly requires Jev requests **not** to increase on `mergesort` (36 today) or the sympy canary (17).

**R-6. Hedging doubles spend on exactly the most expensive samples, and the billing is unverified.** OpenRouter's treatment of a cancelled stream on the z-ai endpoint is unknown; the probes measured aborted samples billed at **0.59×** the full-price estimate, and the tree conservatively books cancels at estimated full cost. A hedge storm under a rate limit could burn `llmUsdLeft` and leave a goal with no round at all. Mitigations: `LLM_HEDGES_PER_ROUND = 1`; the hedge is refused unless the budget can hold one more estimated-full-cost sample; the twin rotates `provider.order` so it is not another draw on the same throttled endpoint.

**R-7. Provider pinning can convert a slow provider into a failed round.** The head-to-head lost `shipping`'s entire LLM round to 3/3 `HTTP 429` and committed a seed overfit as the direct consequence. So `only` is never set and `allow_fallbacks` stays `true`; the pin is `order` + `sort: "throughput"`. Residual risk: `sort: "throughput"` routes to a provider with worse anchoring or tool-call fidelity — watched via the probes' 97 % valid-sample and 0 % misanchored gates.

**R-8. The cache-warm stagger is a bet that prefix processing dominates.** On the repository class it *delays* samples 1..N−1 by sample 0's TTFB (0.5–2 s). If GLM's cost is dominated by the measured 6.6 s intercept and 266 reasoning tokens rather than by the 3–6k-token prefix, the stagger is a straight loss — and "Don't Break the Cache" (https://arxiv.org/abs/2601.06007) reports that full-context caching can *increase* latency. It is therefore `'auto'` by default, auto-disables on a zero-`cached_tokens` round, and ships only if probe P1 shows staggered release beating simultaneous release on total round wall.

**R-9. Jev endpoint outages are real and already cost this repo three runs.** `HTTP 503 no healthy upstream` and one `529` between 23:31 and 23:34 Z killed sympy-17139, django-15128 and django-15315 with `stopReason: error`. Fastlane makes *routers* cheap by construction (`routeSpeculative` drops a dead router at 400 ms), but the **non-router** Jev uses — Q1, Q2–Q6 localisation, Q15/Q16 arbitration, Q20 harm — still fail the step. This design does not fix that; it only guarantees the speed layer adds no exposure. The `consecutiveStageFailures` limit of 3 and `--resume` remain the answer, and the `--jev off` CI gate at least proves a degraded path exists.

**R-10. `ROUTER_DEADLINE_MS = 400` is a measured trade, not a principle.** It sits between Jev's p50 (237 ms) and p95 (547 ms), so roughly one healthy router answer in ten is dropped — dropped answers are invisible speed left on the table, and a longer deadline is blocked wall. `routerDropped` is recorded in `GoalSearchTrace` and the deadline is retuned from the Ring-2 distribution rather than argued about.

**R-11. R1 (`run_first`) picks a test scope, and a too-narrow scope can make a regression invisible for a step.** Guards, in order: the scope-usability rule (a run reporting zero collected tests is `scope_unusable` and falls back to the full suite); the router only chooses what runs *first*; `ProposalEvidence.completion` and `isCompleteByFact()` still require the harness's own code-detected suite; `engineRunContradictsBaseline` still refuses to adopt a lane run the engine's own run disagrees with; the revert route is untouched. Worst case is one extra run, which is also the fallback.

**R-12. The persistent index can go stale in ways mtime does not catch** — a build that rewrites files with preserved timestamps, a coarse-granularity filesystem, a `git checkout` restoring identical mtimes. Mitigations: the index is only ever an **ordering** input, never the content the model sees (files are still read through `ctx.workspace.read` before listing); byte equality remains the second gate; `JEVCODE_INDEX=off` restores today's path exactly.

**R-13. The edit replacer ladder has a known silent-failure mode upstream.** opencode accepts a single BlockAnchor candidate at only 0.65 mean similarity and throws only on multiple matches; a wrongly-anchored edit that applies cleanly is worse than a failed edit. Mitigations: the unique-occurrence hard error is kept; **any tier beyond `ws-normalised` must pass the syntax gate**; the tier that fired is recorded and shown in the diff; optionally one advisory Jev Score before commit. It is also deliberately kept off the `llm-jev` anchor path, which already measures 0 % misanchored over 58/58 hunks.

**R-14. Scope builders for jest/vitest/cargo/go are new code paths on untested runners.** A wrong scope string silently runs zero tests and "0 failing" reads as success. Mitigation is the scope-usability guard (R-11), plus the rule that the guard is unit-tested per runner before the builder is wired.

**R-15. Merge risk with the coordination workstream.** This is a large, cross-cutting change to the module that produced the repo's only head-to-head win, landing on a tree with 2,000+ unit tests and a thin perf margin, while the coordination design is also editing `src/loop/engine.ts`, `src/core/types.ts`, `src/loop/window.ts` and `src/checkpoint/*` — and that design is itself still under adversarial review (7 blockers at `a2fee9c`). Wave S0 and the additive-fields discipline (every new field optional, conditional spread, `CheckpointEnvelope.version` stays 1) bound the merge cost, but the ordering conflict with COORDINATION W0–W2 is a **scheduling** risk to resolve with that owner before S4.

**R-16. Several cited magnitudes are from papers and vendor pages, not from this codebase.** PASTE's 48.5 % task-completion reduction and SpecBox's 2.9× P99 / 4.53× provisioning numbers were measured on serving-layer agent workloads with different bottlenecks (network tools, 150 ms–3 s container cold starts) than JevCode's local seatbelt-plus-shell model, and the sandbox cold-start ladder came from search-surfaced pages that were not individually re-fetched. They justify the **shape** of the mechanisms (prewarm, slack-budget speculation, promotion/preemption, graded safety), never the magnitudes. Every magnitude in this design is either **[measured]** on this machine today or labelled **[proj]** and decided by probes P1–P3. Two 2026 indexing papers (arXiv 2604.18413, arXiv 2603.27277) could not be verified at all and nothing here depends on them.

**R-17. The wave reordering is itself a bet.** Landing S1 (the warm runner) before S2 (the generator path) assumes the lane queue really is the critical path on the cheap classes. If probe P2 or the first Ring-2 run shows the queue was never the binding constraint — for instance because the 8 lanes were starved by the awaitable queue rather than busy — then S1's measured win will be small and the waves should swap back. The probe exists precisely so that this is decided in seconds and for free, before two days of work.

---

## 9. As built: waves S0 and S1 (2026-09-22)

Written after the two waves landed, in the style of COORDINATION-DESIGN §14 item 19: every row is a change to
**this design's text**, verified by reading the code on `main` and naming the symbol. Where the code deviates from
what §6 specified, the deviation is stated with its reason rather than absorbed. Nothing in §1–§8 is withdrawn.

### 9.1 S0 — measure, make iteration free, fix the perf gate (branch `s0`, merged fast-forward at `aca06e2`)

S0's own work is `7e78ee7` (the wave) and `38c1817` (the adversarial review's ten defects); `aca06e2` is the last
of four `main` merges taken into the branch before the fast-forward.

| § | As built | Note |
| --- | --- | --- |
| §4.4 the buckets | `src/perf/timeline.ts`. `TIMELINE_BUCKETS = ['lane','sample','jev','exec','images','store','serialise','listing']`; `TOP_LEVEL_BUCKETS` is the first four, the last four are harness SUB-buckets that overlap `harnessMs` rather than partitioning the step. `harnessMs = wall − lane − sample − jev − exec`, mirroring the engine's own subtraction | a bucket's `ms` is the **union** of its spans, so eight concurrent lanes are 1 s of lane wall, not 8 s; `sumMs` keeps the summed busy time beside it and `n` the count. That is what makes "`jevWaitMs` must stay ≈ 0" checkable |
| §4.4 cost | off unless `JEVCODE_TIMELINE` is set — every entry point early-returns and `span()` is a shared no-op. Entries capped at `MAX_ENTRIES_PER_STEP` (500) with a dropped count | §8 R-4: new work is off the step or it does not ship. A QuixBugs step runs ~1,375 candidates |
| §4.4 flush | once, at run end, to `<runDir>/timeline.json` (`TIMELINE_FILE`, `writeTimelineFile`, `engine.ts:5351`); `writeTimelineFile` calls `endRun()` after the snapshot is on disk | never per step. `beginRun` only sets `contended` when a step of the previous run is still open, so a session host running two engines in sequence still records run 2 (review defect 9) |
| §4.4 wiring | three choke points: `src/loop/engine.ts` (`beginRun` / `beginStep` / `stage`, the `jev` span around `askRecorded`, `sample` around the generator wait, `images:pre` / `images:post`, `store:pending-checkpoint`, `serialise:checkpoint-state`, `listing:candidates`), `src/sandbox/run.ts` (`exec` when the current stage is `execute`, else `lane`, labelled by `commandLabel(command)` = argv0), and `src/perf/step-overhead.ts`, which prints the per-bucket rows under the gate | the sandbox wrapper is one branch on the disabled path: `if (!stepTimeline.isEnabled()) return run(command, o)` |
| §4.4 `jevWallMs` | `StepDraft.timing.jevWallMs` (and `synthJevWallMs` for the shell/synth split) measures the wall the engine actually spent inside `decider.ask`. `jevChargedMs(draft) = max(draft.timing.jevMs, draft.timing.jevWallMs)` | **Correction to the wave's own commit message, stated:** there are **two** `jevChargedMs()` call sites on main (`engine.ts:4412`, `:5078`), not three. The third derivation is `llmJevTiming`'s `shellJevMs = max(jevMs − synthJevMs, jevWallMs − synthJevWallMs)` at `:4424`, which charges the same larger-of-two without going through the helper. All three subtract `coordWaitMs`; none subtracts `decomposeMs`, which is inside `harnessMs` by its own contract |
| §4.4 why | every decider the harness measures itself against (`jev/mock.ts`, `bench/stub-decider.ts`, `jev/off.ts`) reports `latencyMs: 0` while doing its work on this thread, so `draft.timing.jevMs += res.latencyMs` charged the double's CPU to the gated `harnessMs` — and the gate could be "fixed" by making the double faster | the recorded quantities (`jev.jsonl.latencyMs`, `StepTiming.jevMs`, the run's `jevMs`) are untouched; only the subtraction moved. `test/unit/loop/engine-jev-timing.test.ts` fails by 346 ms against a 150 ms bound without the fix. The per-run Jev cache (`src/jev/cache.ts`, wrapping every run's decider at `engine.ts:963`) sits inside the same `askT0` span and the `jev` bucket; a hit reports `latencyMs: 0`, so its in-process CPU correctly stays inside `harnessMs` |
| §3 M7 stat gate | `src/workspace/candidates.ts`: `noteChanged` inspects at `STAT_CONCURRENCY = 32` (results applied in input order, so the cache is what the serial loop produced) and `statGateHit(prev, st)` skips the 8 KB sniff only when `bytes`, `mtimeMs` **and** `ctimeMs` are all unchanged | mtime alone was wrong: `tar -x`, `cp -p`, `rsync -t`, `unzip` and a restored build cache set mtime from the archive, so a same-size file can gain new content under an unchanged — or older — mtime, and a file that became binary stayed a listed text candidate. ctime moves on every write and on `utimes`, cannot be set backwards, and rides the same `lstat` (review defect 8). `listing:note-changed` 36 → 26 ms on the fixture |
| §1.1 the mock | `src/jev/mock.ts`'s candidate finder was scanning every candidate key for every context Noul with a `JSON.stringify` and two `String.includes` per pair (≈ 300 × 50 per request) — **12.8 ms/step of the gated `harnessMs` was the test double**. The lookup is inverted: the literal spellings are read off the instructions once per question and probed against the candidate map | same answers, tested against the real `buildContextQuestions`; `jev` p50 14.4 → 1.6 ms |
| §1.2 the lint | `scripts/jev-contract.mjs`, wired into `npm run check` (`"check": "npm run typecheck && npm run jev-contract && npm test"`). Every `.ask(` site under `src/**` either carries a four-clause block (escape / guard / fallback with a NAMED unit test that must exist / no-gating) or takes an allow-list row stating why, counted **per file** so a new site in an old file still trips. Plus: no hand-built `Question` literal outside `jev/questions.ts`, and no authority-shaped question id | **32 sites as of `7efac12`: 2 with a four-clause block, 30 allow-listed** (26 at `7e78ee7`; the orchestration and import waves added the rest). The scanner follows a formatter-wrapped `await ctx.decider` / newline / `.ask(…)` and anchors the site at the receiver's line, so the contract block above it still counts (review defect 7); the ratchet test no longer hardcodes the engine row's count, which legitimately moves as waves land |
| §1.2 `--jev off` | `src/jev/off.ts`: `JEVCODE_JEV=off\|escape\|unreachable` (`off` and `0` map to `escape`; `down` and `503` to `unreachable`) swaps the Decider for a deterministic double. Every Choice is answered with the escape option (`ESCAPE_KEY`, else the last key), every Noul inert at `JEV_OFF_NOUL = 0.5`, and **every Score at its TOP level** | **Deviation from §1.2 as drafted and from `7e78ee7`, stated:** the inert Score was level 0, which for `destructive` reads "nothing existing is lost" and for `irreversible` "no lasting effect" — `verdict ok, risk 0.000` on everything, from a double replacing a mock that escalates those same Scores on a `DANGEROUS_COMMAND` match. Turning the safety switch on weakened the destructive gate, which §1.2 clause 2 forbids. Every Score in this tree is a risk dimension with levels ascending in severity, so the inert answer is the top level — the only one that cannot release what code denies. `test/unit/jev/off.test.ts` drives the real Q20 batch (`harmOnlyQuestions()`) through `assessRisk` and asserts `block` / risk 1. `withJevOff` is applied as `stub ?? withJevOff(…)` so a stubbed bench arm is never served a drifted model (review defect 6) |
| §5 the rings | `experiments/harness-next/quick.mts`, rings 0 / 1 / 2, running the **BUILT** bundle (`BIN = join(ROOT, 'bin/jevcode.js')`). `--ring`, `--spend-cap` and `--concurrency` are validated — `--ring 7` and `--ring abc` used to run nothing and report success (review defect 10) — and `run()` can *unset* an env key, so the Jev-on arm of the paired gate cannot inherit a `JEVCODE_JEV` from the shell | `experiments/fastlane/quick-table.mts` exists under the name §6 S0 gives it: the §5 table and accept rule as a module the ring imports, plus a script that summarises any bench directory |
| §5 Ring 1 | **the gate is a PAIRED comparison and it is RED.** The ring runs both arms of the same tasks (Jev on, then `JEVCODE_JEV=off`) and gates on `rec.pass`: every task the Jev-on arm passes, the Jev-off arm must pass. "Only slower" is reported beside it; the false-green signature (ended sooner **and** did not solve it) gets its own row; a Jev-on arm that solved nothing reads `·`, not `pass` | the old ring counted records whose `stopReason` was neither `error` nor `not_run` as "finished" and never read `pass` — a run that replans into `max_replans` is neither, and is *faster* than the run that solved the task, so the gate could not fail. Measured 2026-09-22 (mocked, offline): quixbugs on 1/3 → off 0/3 (`gcd` lost); ladder on 2/2 → off 1/2 (`units` lost), both with the false-green signature. **Cause: one clause-3 failure** — with every Choice escaped and every Noul inert the localiser returns no site at all (`sitesConsidered: 0`, `outcome: 'exhausted'`), so the sieve enumerates nothing and the run replans into the cap with `candidatesTested: 0`. The allow-list row for `src/synth/localize/index.ts` claims "code order is the fallback"; the measurement says the candidate list is dropped instead. Closing it is the localiser's own change and belongs with the wave that gives every site a named, tested fallback. S0's job was to make the property falsifiable, and it now falsifies |
| §5 Ring 0 probes | `src/perf/lane-run.ts` (one real candidate run in both lane modes, cold spawn against a `WarmRunner` S1 injects, with the §5 floor rows; gate arithmetic in `laneGate()` — `pending`, never `pass`, with no warm arm, and FAIL at any speed if the warm arm disagreed with the cold exit code, §8 R-1) and `src/perf/sandbox-spawn.ts` (the wrapper alone, report-only by construction). Both **opt-in** via `RING0_PROBES = ['lane-run','sandbox-spawn']`, which is NOT part of `ALL_PROBES` | naming one makes the perf run `partial`, which by that module's own contract is never a release number and never reaches the README — so the release gate, its wall and its python3 dependency are byte-for-byte what they were. Measured: `candidate_file` cold p50 79.1 ms; floors 2.2 / 15.9 / 71.6 ms, reproducing §1.1's 2.8 / 13.4 / 67.3; the wrapper 4.9 ms on 2.8 ms bare. Every arm is validated before it is timed, because the pytest mode fails silently and fast on a bare checkout (the sandbox scrubs `HOME`, so a user-site-packages pytest is not importable and `python3 -m pytest` exits 1 in 30 ms — which reads as a lane run three times faster than the interpreter floor, i.e. a free 2× for any warm arm to beat); it reports `unavailable` with that reason instead |
| §5, §8 R-4 the gate | paired A/B of the built bundle, alternating arms so machine noise hits both (load 6.4–19.5; `LOAD_QUIET` never reached — sibling worktrees were benching): **harness p95 54.9 / 51.9 / 50.1 → 36.1 / 42.5 / 31.9 ms** (FAIL → pass, 3/3 under the 45 ms target), p50 30.8 → 18.2, `run`-step p50 48.5 → 29.0, process CPU per step 48.5 / 47.7 / 51.8 → 32.0 / 31.6 / 34.9 ms (−33 %) | **These numbers were measured PRE-merge on the S0 tree at `7e78ee7`. The merged tree has NOT been re-measured.** Two reasons, both stated rather than worked around. (a) The machine is shared with sibling worktrees that bench continuously, so nothing since has been taken under `LOAD_QUIET`, and a number taken under contention is not a release number. (b) `38c1817` changed what `harnessMs` *is* — it no longer includes the mock's CPU — so the post-fix `harnessMs` is **a different quantity** from both the four recorded runs in `docs/STATUS.md` (45.7 / 51.1 / 52.6 / 49.6) and from `7e78ee7`'s own 36.1 / 42.5 / 31.9, and a re-run would not produce a comparable figure. What the buckets say instead, with `JEVCODE_TIMELINE=1` on the `step-overhead` fixture: `jev` 98 ms over 203 asks (p50 1.8 ms/step, no longer in `harnessMs`), `listing:note-changed` 26 ms, `store` 117 ms, and **`images:pre` 386 ms total, p95 38.1 ms** — the whole of the run's harness p95 |
| §6 S0 `imagesMs` | **DEFERRED, explicitly.** The cost is the serial 15 MiB pre-image copy in `src/checkpoint/images.ts`, which another branch owns. S0 instrumented it (`images:pre` / `images:post`) and did not reduce it; with the attribution fixed it is now the entire gated number | recorded in three places so it cannot be lost: at the `images:pre` span in `src/loop/engine.ts`, on the `imagesMs` row of Ring 0 (`report only … DEFERRED, see below`), and in `quick.mts`'s `DEFERRED` list, which prints on every run with its reason |
| §6 S0 other | landed: the per-worker config deep copy (`buildEngineOptions`), so `--concurrency N` engines cannot observe each other's `configRecord`. Not landed, and printed by `quick.mts` as deferred with an owner: `src/loop/replay.ts` + `jevcode inspect --replay <run-id>` (M15), the TTFB callback on `src/provider/sse.ts`, and `--quick` in `src/bench/cli.ts` | all three land with other owners' branches; `src/loop/replay.ts` does not exist on main and neither does `--quick` |
| tooling | **`scripts/gen-docs.mjs manDate()`.** The man page's `.TH` date is deterministic: `SOURCE_DATE_EPOCH` > the commit that introduced the **current `package.json` blob** > today. S0 added the `jev-contract` step to `npm run check`, which moved `package.json` and made the checked-in man page's date stale — caught by `test/unit/tui/commands/registry.test.ts` ("gen-docs --check exits 0") | **any branch that touches `package.json` must re-run `node scripts/gen-docs.mjs`.** The key is the blob, not the path (`cb14172`): keying off the path depends on merge topology, so `gen-docs --check` was red on a feature branch and green on the same tree merged into main |

### 9.2 S1 — the warm verification plane (merged `66aa019`)

`7c99ce0` is the wave, `6cd0e76` the review fixes (13 items).

| § | As built | Note |
| --- | --- | --- |
| M6 the plane | `src/synth/warm/{plane,worker,protocol,server-source,index}.ts` — a persistent per-interpreter lane runner forked from a warm interpreter. `WarmPlane` (+ `WarmPlaneOptions`, `WarmScreen`, `WarmStats`, `warmModeFor`, `warmDelta`, `warmNote`, `emptyWarmStats`, `WARM_ENV_FLAG`, `WARM_MAX_RESTARTS_PER_LANE`), `WarmWorker` (+ `WARM_BOOT_TIMEOUT_MS`, `WARM_IDLE_MS`, `WARM_MAX_LIFETIME_MS`, `WARM_RESPONSE_SLACK_MS`, `writeWarmServer`), the line protocol (`requestFor`, `pytestRequestFor`, `quixbugsRequestFor`, `parseResponse`) and the Python server source | one facade, `src/synth/warm/index.ts`. `parseResponse` turns anything unexpected into an `error` response, never a silent pass |
| M6 screen / confirm | `src/synth/sieve/runner.ts`: the warm plane **screens**; it never decides. A passer any part of which was produced on a warm worker is re-verified by a fresh COLD spawn before the guard sees it; `screened: true` rides into the outcome with `confirmedCold: true` beside it, and one `screen:mismatch` disables the plane for the run and re-queues the whole batch cold (`requeueScreened`) | §8 R-1's mitigation, as designed. A warm verdict nothing cold confirmed is only a screen; once one screened passer disagrees with its cold confirmation, every other candidate that batch classified warm is suspect too. When the subset run WAS the whole suite, the cold confirmation replaces it outright rather than being carried alongside it |
| M6 output bound | `WARM_OUTPUT_BYTES = 256 * 1024` in `src/synth/warm/protocol.ts`, **exactly** the sieve's own `RUN_OUTPUT_BYTES`, shared across the two streams, with the cold path's `TAIL_BYTES`; a truncated warm run carries the same marker a cold run's would (`ExecResult.truncated`) | a warm path with a different output budget would make the two paths disagree about a candidate purely because one of them was cut off |
| M6 interpreter | `interpreterFor(mode, command)` returns the interpreter word of a servable command **verbatim** (`python3`, `python3.11`, `/ws/.venv/bin/python`) or `null`, taken from the word the parser already extracted and never guessed from the line; a **console-script head is refused** (the `isPythonWord` gate) because the interpreter behind one is only knowable by reading its shebang. `WarmPlane.serve` re-checks this per request against the interpreter the plane actually booted | a plane booted on a different interpreter than the cold command names has different site-packages, so the candidates it screens are classified against the wrong environment. A lane command that changes interpreter mid-run runs cold rather than on the wrong one |
| M6 deadlines | the worker charges the deadline wall from **before its fork** and subtracts what it measured a cold run to spend on process start, so `deadlineMs` buys the same amount of CANDIDATE compute on both paths. On top of that, `newDeadlineHit(run, baseline)`: a warm run that hits a deadline the BASELINE does not already hit is **never a verdict** — it is discarded and re-run cold, which decides (`runner.ts:745`, counted as `WarmStats.deadlineRechecks`, reported by `warmNote` as "deadline recheck(s) cold") | the subtraction can only be an approximation, which is why the re-check exists (§8 R-2). "New" is what keeps the guard affordable: a candidate that hangs exactly where the baseline hangs tells the same story on both paths — `bitcount`'s 203 hanging candidates, whose wall IS the per-case cap — and re-running each cold would double the wall of the task class the plane was built for while deciding nothing |
| M6 / R-14 scopes | `src/workspace/tests.ts`: the `ScopeBuilder` type and `scopeBuilderFor` now cover all eight runners — `pytestScope`, `djangoScope`, `sympyScope`, `unittestScope`, `jestScope`, `vitestScope`, `cargoScope`, `goScope` — plus `scopeUsable(counts)`: a scoped run is evidence only if it reported a non-zero collected/total count, else the run widens to the full suite (`runner.ts:783`, counted as `WarmStats.scopeUnusable`) | R-14's mitigation: a wrong scope string silently runs zero tests on every runner here, and "0 failing" then reads as success. The graft the design called "the highest value-per-line change in the plan" landed in full |
| M6 the oracle | **only COLD runs teach the oracle** (`runner.ts:847`: `if (mode === 'first' && !sub.warm)`). Warm durations are excluded from `subsetDurations`, so `tRunMs.goalSubset` / `.fullSuite`, the lane timeouts, the SIEVE/RANK plan and the load scaling stay statements about a fresh process | a warm run's 20 ms would make the estimate describe a path the cold confirmation does not take; keeping the estimate cold is also what reserves enough remaining wall (`minRunWallMs`) for the cold confirmation of a passer found late in a batch. Pinned by `test/unit/synth/sieve/screen-confirm-budget.test.ts` — "the 4 ms screen never reaches `tRunMs.goalSubset`, so `runsLeft` and `poolFitsRunBudget` still price COLD runs", beside "a warm screen is never the passer that ends a SIEVE sweep" and "a screen the cold run contradicts is no passer at all" |
| M6 scripts | `experiments/fastlane/warm-parity-sweep.mts` and `experiments/fastlane/warm-lane-probe.mts` | the parity sweep is the zygote-vs-cold output-equality check §6 S1 asked for |

**Not built in S1, and named.** `src/sandbox/pool.ts` does not exist: the warm plane is its own per-interpreter
worker (`src/synth/warm/worker.ts`) rather than a generic pool of `sandbox-exec -f <profile> /bin/sh` workers, so
`createAstCompileCheck` was not routed through one and the pool's allowlist test has no subject. The hard rule the
pool was to carry — `Action.kind === 'run'` never leaves `src/sandbox/run.ts` — is satisfied structurally instead,
because the warm plane is reachable only from the sieve. Widening `synthesizerHandles` stays deferred, as §6 S1
already states.

#### 9.2.1 S1 wedge and fix (2026-09-22, 07df581)

The first live measurement of the merged tree found the plane wedging every `llm-jev` run (see `docs/DECISIONS.md`, "The warm
verification plane is off by default …", for the mechanism: blocking FIFO opens/reads exhausting libuv's four-thread pool with
eight lanes). As built after the fix: `src/synth/warm/worker.ts` drives both FIFO ends as raw `O_NONBLOCK` descriptors with
`readSync`/`writeSync` on an in-flight-only timer; `WarmPlane.serve()` races a watchdog and disables the plane (`disabledReason`)
on any hang — a worker timeout on first occurrence, crashes under the per-lane budget plus `WARM_MAX_FAILURES_PER_RUN` = 4; the
server source is written once per run; `test/unit/synth/warm/real-lane.test.ts` is the real-worker gate (screen + cold
confirm, truncation, six concurrent lanes, two hang shapes). `warmModeFor` defaults OFF (`JEVCODE_WARM=on` enables the two
Python shapes); the M6 gate is measured behind that switch until a real-model A/B on the 18-task slice. Micro-benchmark, 8 lanes
× 12 runs: warm 1.13 s vs cold 11.4 s; mock bench one task: 23.6 s vs 31.6 s.

**As built after the iteration-2 measurement (2026-09-22, `warm-plane-fix-2`).** The real-model A/B that switch was
put in for (`experiments/results/llm-jev-iter2.md` §7) found the transport sound — 93,460/93,460 screened over seven
warm-on arms, 0 fallbacks, 0 restarts, 0 `screen:mismatch`, 0 `disabledReason`, 0 wedges — and 23 % faster at matched
load (median per-task ratio 0.767, faster on 7/7), but it FAILED the pre-registered pass-parity criterion: warm-on lost
QuixBugs `topological_ordering` twice independently and `shortest_path_length` once. Four defects are fixed here; the
default stays **OFF** until the A/B is re-run. (1) *The t_run calibration sample was selected by failure.*
`runQueue` taught `oracle.tRunMs` from cold runs only, and with the plane on the only candidates that reach the cold
path are the ones whose hot screen hit a deadline and was discarded — so the sample was nothing but timeouts: on the
recorded 185-candidate `topological_ordering` batch it taught `run median 11655 ms` where the identical batch measured
510 ms cold, which sized `laneTimeoutMs`, `minRunWallMs` and the run plan, collapsed `runs left` 1,315 → 16, and left
every later batch reporting `0 tested (nothing ran)`. The sample is now built by `sampleRun`
(`src/synth/sieve/runner.ts`): a deadline re-run teaches **nothing** (`LaneRun.recheck` — a timeout is a bound, not a
measurement of the candidate, on either path); a cold run that was nobody's re-run is the truth, as before; and a hot
screen is kept in its own sample as a **lower bound** on the cold run it stands for (its served duration plus
`PROCESS_OVERHEAD_MS`, the process start a screen does not pay), which may hold or RAISE `tRunMs` but never lower it.
The one-way bound is deliberate: a screen skips more than process start — in pytest mode the warm parent has already
imported the suite — and pricing the step's run budget on one would send pools to SIEVE that only the SCREEN can
afford while every confirmation is still a cold run (`test/unit/synth/sieve/screen-confirm-budget.test.ts` pins that
from the other side, and it is why the original rule excluded warm runs outright). Replayed on the recorded batch:
**t_run 11,655 ms → 510 ms**, which is exactly what the warm-off arm measured on the identical 185 candidates. The
load scaling and the in-flight-timeout rule read the cold samples when the batch has any and the hot bounds otherwise,
and a hot-only batch's event says `run median ≥ N ms hot` rather than claiming a measurement. (1b) *The screen was bounded by the lane RUN
cap.* `warm.serve` was handed `capMs()`; a screen that hits a deadline is thrown away and re-run cold, so the step paid
both (≈14 s + 14 s per diverging candidate). It is now given `screenDeadline` — the lane run timeout's own shape with
the cold path's 10 s process-start slack replaced by one per-case cap, floored at `MIN_RUN_TIMEOUT_MS` and never above
the cold cap (13,200 ms → 2,030 ms on the recorded oracle) — and, because that bound is tighter than the cold run's,
**any** timed-out screen is now re-run cold rather than only one that hits a deadline the baseline does not
(`newDeadlineHit` alone would accept a whole-run kill against a timed-out baseline). (2) *The counters were
unobservable from a bench run.* `WarmStats` existed only in `warmNote()`'s clause on the sieve's `synth · verify`
event, and `--archive-runs` does not copy `transcript.log`, so every warm number in the iteration-2 report was
harvested by hand from the live run directory. The sieve now sums them per step on `RunnerMemory.warmStep`,
`search/index.ts` reports them at `reportVerify`, and they are persisted as **`StepRecord.verify.warm`**
(`StepWarmSummary`, `src/core/types.ts`: `mode`, `offered`, `screened`, `confirmed`, `mismatches`, `fallbacks`,
`restarts`, `invalidations`, `scopeUnusable`, `deadlineRechecks`, `screenMs`, `confirmMs`, `disabledReason?`) and
summed onto **`StepsSummary.warm`** (`src/bench/types.ts`, with `disabled` and the mode unioned the way
`deadlineGrowth` is). (3) *`timing.jevWallMs` was declared and never written* — the number `jevChargedMs` charges
`harnessMs` by when a decider under-reports; it is now an optional member of `StepTiming`, on the step record and
summed onto the run's. (4) *`JEVCODE_WARM=on` was a silent no-op on an unsupported runner* — SWE-bench's oracle runner
is `other`, so the "18-task warm A/B" was really 14. `warmRequested()` now separates "the flag is off" from "the flag
is on and this oracle has no warm shape", and the latter records `warm.mode = 'unsupported-runner'`
(or `'unsupported-command'`) plus one `synth` line per step. All four record members are optional and absent unless
the flag asked for the plane, so every warm-off record is byte-identical to one written before them.

### 9.3 S2–S6 — status

None has started. Verified by the absence, on main, of the symbol each wave is defined by.

| Wave | What it is | Status | Evidence on main |
| --- | --- | --- | --- |
| S2 | the generator path: hedging, pinning, cache prefix, reasoning cap | not started | no `hedgeAfterMs`, no `LLM_HEDGES_PER_ROUND`; no TTFB callback on `src/provider/sse.ts`; no `--quick` in `src/bench/cli.ts` |
| S3 | incremental indexing and one bounds module | not started | no `JEVCODE_INDEX` switch. M7's stat gate landed early, inside S0, as `statGateHit` — the only part of S3's ground that is occupied |
| S4 | Jev as router | not started | no `routeSpeculative`, no `ROUTER_DEADLINE_MS`. M9's exact-digest cache landed ahead of its wave as `src/jev/cache.ts` and is already wrapped around every run's decider (`f9d033e`) |
| S5 | step avoidance: the write path, diagnostics, background, loops, graceful stop | not started | no M11 replacer ladder, no `poll` command |
| S6 | hooks, TUI coalescing, gates, docs | not started | — |

**Pending Ring-0 probes, exactly as `quick.mts` lists them** (`PENDING_PROBES`, each with its owning wave):

| Probe | Why it is pending |
| --- | --- |
| `py-load` | wave S3 (M7): `loadPythonFiles` cold / warm-parse / stat-gated — owner: the S3 indexing wave |
| `jev-batch` | wave S4 (M9): 5 sequential vs 1 merged vs 5 concurrent, plus the cache hit — owner: the S4 router wave |
| `llm-sample` | wave S2 (M1–M4): 6 real `propose_fix` calls, `--live` only (≈ $0.003) — owner: the S2 generator wave |

`PENDING_TASKS` is printed the same way: `q-self-edit` ("this repo, offline: needs the jest/vitest scope builders
of wave S1") and `q-drifted-edit` ("fixture + mock provider: needs the M11 replacer ladder of wave S5"). The first
row's stated blocker is now cleared — `jestScope` and `vitestScope` landed with S1 (see §9.2) — so the task is
waiting on nothing but being wired into the ring.
