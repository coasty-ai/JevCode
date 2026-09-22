# Jev-only audit: is everything decided by Jev, is nothing else called, and are the numbers honest?

Date: 2026-09-20. Read-only audit of the working tree at `c8c291b` plus the uncommitted `src/synth/search/{bases,guard,perturb}.ts`.
No live calls were made ($0.00); nothing under `src/**` was edited. Method: assume the claim is false and try to
falsify it with greps and file reads; every finding carries `file:line`. The exact greps are listed in §8.

The claim under test (docs/JEV-ONLY.md "Non-negotiables"): in `jev-only` mode everything is decided by Jev
(`typesafe/jev-1.13-20260917` through the OpenRouter decisions endpoint), no other LLM is called for anything, the
bench asserts zero generator usage, and the measurements mean what the docs say.

## 0. Verdict table

| # | Item | Verdict | One line |
| --- | --- | --- | --- |
| 1 | Network call sites / NullProvider on every path | **PASS** | Three LLM `fetch` sites exist; in jev-only only `POST <decider.baseUrl>` (default `https://openrouter.ai/api/alpha/decisions`) is reachable, with the dated model id. Generator slot is `createNullProvider()` on the CLI and bench paths, and `engine.generate()` throws before the provider on top of that. No embeddings, no summariser LLM, no lazily built default provider. |
| 2 | Bench asserts `generatorCalls === 0`, results carry it | **PASS** | `buildRecord` invalidates on calls, tokens or cost; unit-tested. All 21 result sets: every finished record has `generatorCalls: 0`, `cost.generator: 0`, `generatorTokensPerStep` all 0; `summary.json.spentUsd.generator = 0` everywhere. |
| 3 | Hidden non-Jev "intelligence" in `src/synth` | **PARTIAL** | No fix tables, no gold lookup, no program/task/test-name keys, no ladder gold text. But the Q7 `edit_class` option descriptions and one Q5 criterion embed **ten QuixBugs gold fixes verbatim** as "examples" and are sent to Jev on every QuixBugs run. Benchmark-format adapters (QuixBugs runner parser, QuixBugs-shaped perturbation) exist and are allowed. |
| 4 | Design Q1–Q17 vs implementation; REPORT rules | **PARTIAL** | Q1–Q16 are asked live; **Q17 is never asked** (dead code, docs say otherwise). Several judgment-bearing constants are code thresholds, two of them retuned to specific QuixBugs programs after live runs; six 0.5 cuts on Jev probabilities; Q9 is compact-only where the design promised full criteria; Q6 fallback is one request per statement. |
| 5 | Secrets hygiene | **PASS** (one gap) | Sandbox env is an allowlist (PATH/LANG/LC_ALL/TERM + TMPDIR/HOME); checkpoints, transcripts, synth state and every error string are redacted; no key prefix in any checked-in results file. Gap: `bench/results/*/tasks.jsonl` is written without a redaction pass and evaluator `reason` strings carry raw subprocess tails. |
| 6 | Measurement honesty | **PARTIAL** | "solved" is the bench evaluator's verdict on the full suite, never the agent's claim. But neither QuixBugs nor the ladder has a hidden suite (evaluator cases == workspace cases), so "solved" means "passes the visible suite"; the run-3 "34/40 correct by inspection" is backed per program only for the 10 non-gold passers, the 27 "gold-identical" are a count with no per-program list and no code that computes it. |

---

## 1. Network call sites and the NullProvider (PASS)

### 1.1 Every place the process can open a socket to an LLM

| Site | Endpoint | Model id | Reachable in jev-only? |
| --- | --- | --- | --- |
| `src/provider/anthropic.ts:263` (`d.fetch(url`) with `url = ${cfg.baseUrl}/v1/messages` at `:246`, header `x-api-key` at `:265` | Anthropic Messages | `GeneratorConfig.model` (default `claude-sonnet-5`, `src/config/defaults.ts:5`) | **No**: only built by `src/cli/main.tsx:68-69` after the `mode === 'jev-only'` early return at `:54-56`, and by `src/bench/cli.ts:52` inside `if (requiresGenerator(conditions))` (`:47`), where `requiresGenerator` is `conditions.some(c => c !== 'jev-only')` (`src/bench/conditions.ts:30-31`). |
| `src/provider/openrouter.ts:216` (`d.fetch(url`) with `url = ${cfg.baseUrl}/chat/completions` at `:200`, `authorization: Bearer` at `:219` | OpenRouter chat completions | `GeneratorConfig.model` | **No**: same two guarded factories (`main.tsx:64-66`, `bench/cli.ts:51`). |
| `src/jev/client.ts:256` (`doFetch(cfg.baseUrl, { method: 'POST', headers, body })`) | `DeciderConfig.baseUrl`; default `https://openrouter.ai/api/alpha/decisions` (`src/jev/types.ts:12`, `src/config/defaults.ts:7`) | `cfg.model` in the body (`client.ts:308`); default `typesafe/jev-1.13-20260917` (`src/jev/types.ts:9`, `src/config/defaults.ts:9`) | **Yes**: this is the only reachable LLM endpoint. |
| `src/provider/sse.ts:309` (`fetch: deps.fetch ?? globalThis.fetch`) | helper only | – | Imported solely by `anthropic.ts:27` and `openrouter.ts:29`. |

Non-LLM network in the bench harness (allowed, noted for completeness): `git clone --bare` of the SWE-bench repo (`src/bench/swebench/evaluator.ts:57`), `pip install` for SWE venvs (`:93-102`), the ladder pytest venv (`src/bench/ladder/venv.ts:50`), and the Terminal-Bench shim (`src/bench/terminalbench/shim.ts:293`). `summary.json.conditions.jev-only.noNetwork` is `false` in every result set, consistent with these.

Greps that returned nothing relevant: `undici`, `node:http(s)`, `chat/completions|/messages|\.messages\.create|completions\.create|responses\.create` outside `src/provider/`, `embedding|text-embedding|gpt-|deepseek|qwen|llama|gemini` (only `claude-sonnet-5` pricing rows in `src/config/defaults.ts:36-38`).

### 1.2 The generator slot is the NullProvider on every jev-only path

- CLI `jevcode run --mode jev-only`: `src/cli/main.tsx:53-56` `buildProvider()` returns `createNullProvider()` before any config validation; `:161-162` skips `config.generator()` entirely in jev-only (no key required); `:165-168` builds the synthesizer.
- Bench: `src/bench/runner.ts:499` `const provider = jevOnly ? createNullProvider() : mocked ? mockProvider() : deps.liveProvider!` per condition, so even a mixed `--conditions jev-on,jev-only` bench (where a live provider is built at `bench/cli.ts:47-53`) never hands it to the jev-only engine.
- `src/provider/null.ts:9-27`: `generate()` rejects with `NullProviderCalledError` and its `model` is `'none (jev-only)'`.
- Defence in depth: `src/loop/engine.ts:913-915` `generate()` throws `ConfigError('jev-only mode: the generating LLM must not be called')` before touching `this.opts.provider`; `:991-1000` the propose stage calls `runSynthStage` and never `runProposeStage` in jev-only; `:1581` `createEngine` refuses jev-only without a synthesizer. The only `.generate(` consumer in `src/` is `engine.ts:920` (reached from `src/loop/stages/propose.ts:35`), so planner/replan, judge, intent, context, risk all go through `ctx.ask` → `askRecorded` → `this.opts.decider.ask` (`engine.ts:778-786`).
- `src/loop/generator-only.ts` (jev-off engine) is gated on `mode === 'jev-off'` at `main.tsx:191` and `conditions.ts:113`.
- TUI: no reference to `decider`, `provider.`, `.generate(` or `fetch` in `src/tui/**`. The "summarisers" are code: `src/provider/actions.ts:214 summariseAction`, `src/checkpoint/resume.ts:53`, `src/loop/stages/execute.ts:50 summariseExec`, `src/synth/verify/index.ts:95 summarize`.
- Lazily created default provider: `config.generator()` is memoised (`src/config/resolve.ts:312-315`) and called only from `main.tsx:63` (inside the non-jev-only branch) and `bench/cli.ts:48` (guarded). `DEFAULT_PROVIDER = 'anthropic'` / `DEFAULT_MODEL = 'claude-sonnet-5'` (`defaults.ts:4-5`) exist but are unreachable in jev-only.

### 1.3 The synthesizer only talks to Jev, and only through the metered path

`src/synth/index.ts:42-43` documents the raw `decider` option as "prefer `ctx.ask`"; `createSynthesizer(_opts)` at `:149` does not use it. Every ask in `src/synth/**` goes through `ctx.ask` / an `asker` wrapping it: `index.ts:97`, `search/subgoal.ts:121`, `search/sites.ts:510,519`, `search/goals.ts:718`, `search/guard.ts:503`, `donor/holes.ts:288`, `localize/index.ts:79,192,206,264,337`, `fill/beam.ts:225,311`. `test/unit/synth/search/controller.test.ts:436` asserts a synthesizer works with a raw decider that throws. The engine's `askRecorded` (`engine.ts:778-800`) meters every request as `'jev'` and appends it to `jev.jsonl`, so the cost split in §2 is complete.

### 1.4 Model pinning

`isDatedModelId` / `checkServedModel` (`src/jev/client.ts:33-57`); the bench refuses an alias unless `--allow-model-alias` (`src/bench/cli.ts:39-41`); the engine aborts on the first drifted response and records later drift (`engine.ts:878-912`). All 21 `summary.json` files record `deciderModel: "typesafe/jev-1.13-20260917"` (§2.2). The `jevcode run` path only warns on an alias (`engine.ts:890-892`), which is acceptable outside the bench.

---

## 2. Bench assertion and the checked-in results (PASS)

### 2.1 The assertion

`src/bench/runner.ts:241-245`:

```ts
const g = result.usage.generator;
if (input.condition === 'jev-only' && (g.calls > 0 || g.costUsd > 0 || g.inputTokens + g.outputTokens > 0)) {
  rec.pass = null; rec.evaluator = 'invalid'; rec.reason = JEV_ONLY_GENERATOR_CALLED;
}
```

`generatorCalls = result.usage.generator.calls` is copied on every record (`:236`); `JEV_ONLY_GENERATOR_CALLED = 'generator called in jev-only'` (`:37`); `summary.json` row `generator calls (jev-only asserts 0)` (`src/bench/report.ts:158`). Unit-tested in `test/unit/bench/jev-only.test.ts:56-65` (invalidation) and `:98` (every jev-only record has `generatorCalls === 0 && cost.generator === 0 && generatorTokensPerStep all 0`). Note the counter is only incremented in `engine.generate()` (`engine.ts:928-929`), so the assertion and the throwing NullProvider are belt and braces: a bypass of `generate()` would surface as an error record, not as a silent zero.

### 2.2 The results, parsed (node, `JSON.parse` per line, last record per task wins)

| result set | records | tasks | Σ generatorCalls | Σ cost.generator | Σ cost.jev | Σ generator tokens | pass / fail / null | evaluator | invalid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev-only-ladder-1 | 12 | 12 | 0 | 0 | 0.2773 | 0 | 4/8/0 | local ×12 | 0 |
| jev-only-ladder-2 | 12 | 12 | 0 | 0 | 0.1035 | 0 | 10/2/0 | local ×12 | 0 |
| jev-only-ladder-2-tagcloud | 1 | 1 | 0 | 0 | 0.0019 | 0 | 1/0/0 | local | 0 |
| jev-only-ladder-3-policy | 3 | 3 | 0 | 0 | 0.0386 | 0 | 3/0/0 | local | 0 |
| jev-only-ladder-3-policy-b | 1 | 1 | 0 | 0 | 0.0096 | 0 | 1/0/0 | local | 0 |
| jev-only-ladder-3-policy-c | 1 | 1 | 0 | 0 | 0.0052 | 0 | 1/0/0 | local | 0 |
| jev-only-ladder-4 | 12 | 12 | 0 | 0 | 0.1370 | 0 | 11/1/0 | local ×12 | 0 |
| jev-only-quixbugs-1 | 40 | 40 | 0 | 0 | 0.1906 | 0 | 34/6/0 | local ×40 | 0 |
| jev-only-quixbugs-1-pre | 40 | 40 | 0 | 0 | 0.2413 | 0 | 32/8/0 | local ×40 | 0 |
| jev-only-quixbugs-1b | 40 | 40 | 0 | 0 | 0.2352 | 0 | 34/6/0 | local ×40 | 0 |
| jev-only-quixbugs-1c | 40 | 40 | 0 | 0 | 0.1779 | 0 | 34/6/0 | local ×40 | 0 |
| jev-only-quixbugs-2-rejected | 3 | 3 | 0 | 0 | 0.0165 | 0 | 2/1/0 | local | 0 |
| jev-only-quixbugs-2-slow | 5 | 5 | 0 | 0 | 0.0423 | 0 | 3/2/0 | local | 0 |
| jev-only-quixbugs-2-slow-b | 5 | 5 | 0 | 0 | 0.0308 | 0 | 4/1/0 | local | 0 |
| jev-only-quixbugs-3 | 40 | 40 | 0 | 0 | 0.1654 | 0 | 36/4/0 | local ×40 | 0 |
| jev-only-quixbugs-3-insert | 4 | 4 | 0 | 0 | 0.0135 | 0 | 4/0/0 | local | 0 |
| jev-only-quixbugs-3-insert-dfs | 1 | 1 | 0 | 0 | 0.0018 | 0 | 1/0/0 | local | 0 |
| jev-only-quixbugs-4-overfit | 3 | 3 | 0 | 0 | 0.0059 | 0 | 3/0/0 | local | 0 |
| jev-only-quixbugs-4-overfit-b | 3 | 3 | 0 | 0 | 0.0069 | 0 | 3/0/0 | local | 0 |
| jev-only-quixbugs-4-skew | 5 | 5 | 0 | 0 | 0.0139 | 0 | 5/0/0 | local | 0 |
| jev-only-swebench-1 | 42 lines | 22 | 0 (20 records) | 0 | 0.6032 | 0 | 0/20/2 | local-venv ×20, none ×2 | 0 |

Every finished record has `generatorCalls: 0`; `condition` is `jev-only` on all of them. `jev-only-swebench-1/tasks.jsonl` holds 42 lines for 22 tasks: 20 finished (all `pass: false`) plus `pytest-dev__pytest-10081` and `pytest-dev__pytest-7205` that only ever got an `in_progress` placeholder (no `generatorCalls` field, no `summary.json`). The docs' "0/30" (docs/JEV-ONLY.md:181) is therefore backed by 20 evaluated instances, not 30 (see §6.4).

### 2.3 Cost attribution

Every `summary.json` (21 files, `jev-only-swebench-1` has none) records `spentUsd.generator: 0`, `spentUsd.jev > 0`, `generatorModel: "none (jev-only)"`, `deciderModel: "typesafe/jev-1.13-20260917"`, `conditionOrder: ["jev-only"]`. Per record `cost.generator` is 0 and `cost.jev` is positive. Because the synthesizer's requests all pass through `askRecorded` (§1.3), the Jev figure includes the search's own requests (`jevRequests` per record, e.g. 1,309 on quixbugs-3). Test-runner CPU is not a dollar cost and is not in the split; the design says so (§4.5).

Design §5.6 also promised `SearchTrace` totals (`jevRequests`, `testRuns`, `candidatesTested`, `bySource`) per record "so cost and CPU are auditable"; `BenchRecord` (`src/bench/types.ts`) carries only `jevRequests`/`jevQuestions` from the engine, no `testRuns`/`candidatesTested`/`bySource`. The keys of a quixbugs-3 record confirm it. Minor gap, not a correctness issue.

---

## 3. Hidden non-Jev intelligence in `src/synth` (PARTIAL)

### 3.1 What was looked for and not found

- Program-name keys: every one of the 40 QuixBugs program names grepped as a whole word in non-comment `src/**`. Hits are all benign homonyms or algorithm names: `levenshtein` (the similarity metric, `src/synth/py/similarity.ts:52`), `sieve` (the verification module `src/synth/sieve/`), `wrap` (template family `src/synth/templates/common.ts:35,41`), `sqrt` (`Math.sqrt` in `src/synth/sbfl/ochiai.ts:57`, stdlib import table `src/synth/templates/imports.ts:38`), `gcd` (stdlib table `imports.ts:38`), `flatten`/`gcd` in question examples (see 3.2), `mergesort`/`hanoi`/`sqrt` in `src/bench/quixbugs/pytest.ts:55,99,134,153` (the bench's generated test module reproduces QuixBugs' own oracle rules: `sqrt` absolute tolerance, `hanoi` tuple comparison, matching `run_tests.py` and the upstream `python_testcases`; bench side, not synthesizer).
- Ladder task names (`account` … `units`): no non-comment hit in `src/synth` beyond generic English (`table` as a local variable, `events` in a comment).
- Ladder test function names (94 `def test_*`): 0 hits in `src/`.
- Ladder gold lines (every `>` line of `diff src/ gold/` per task): 0 hits in `src/synth`.
- QuixBugs gold lines (every `>` line of `diff programs/ correct/` per program, ≥ 8 chars): hits only in comments (`src/synth/search/sites.ts:467`, `src/synth/localize/sites.ts:70-73`, `src/synth/donor/names.ts:8,19`, `src/synth/fill/state.ts:58`, `src/synth/sketch/pool.ts:84`, `src/synth/templates/statements.ts:45`) that cite the measurement that motivated a generic rule.
- Gold lookup: `index.json`'s `bugLine`/`buggyLine`/`fixedLine` are read by `src/bench/quixbugs/tasks.ts:23-27,51-56` for validation and by `loader.ts:51-55,180-183` for the **mock** trajectory only; `taskText()` (`loader.ts:39-42`) is the generic sentence; the workspace receives `programs/<name>.py`, `node.py` and `tests/` only (`loader.ts:113-120`). Ladder setup copies `src/` and `tests/`, never `gold/` (`src/bench/ladder/loader.ts:62-63`). `grep -i 'gold|correct/' src/synth` (non-comment) → only `oracle/goal.ts:102` comment.
- Benchmark-conditional logic: `grep -i 'quixbugs|ladder|swebench|django|sympy|pylint|pytest-7205'` in `src/synth` hits only the test-output format adapters (`src/synth/verify/quixbugs.ts`, `verify/runners.ts` sympy/unittest parsers, `verify/index.ts:69-72` format sniffing) and comments citing instances. Adapters for a test runner's output are oracle plumbing, not fix knowledge.

### 3.2 What was found: benchmark gold fixes inside Jev question wordings

`src/synth/sketch/questions.ts:34-39` (`EDIT_CLASSES`, the Q7 `edit_class` option descriptions, sent to Jev at `src/synth/search/subgoal.ts:121`) uses these "examples", matched here against `bench/data/quixbugs/index.json` `buggyLine → fixedLine`:

| example in the wording | QuixBugs program whose gold fix it is |
| --- | --- |
| `enumerate(arr)` -> `enumerate(counts)` | `bucketsort` |
| `while lo <= hi` -> `while lo < hi` | `find_first_in_sorted` |
| `mid` -> `mid + 1` | `find_in_sorted` (`binsearch(mid, end)` → `binsearch(mid + 1, end)`) |
| `arr` -> `arr[k:]` | `kheapsort` |
| `if total < 0` -> `if total < 0 or not coins` | `possible_change` |
| `x + y` -> `max(0, x + y)` | `max_sublist_sum` (`max(0, max_ending_here + x)`) |
| `yield flatten(x)` -> `yield x` | `flatten` |
| `gcd(a % b, b)` -> `gcd(b, a % b)` | `gcd` |
| `perm[j] < perm[i]` -> `perm[i] < perm[j]` | `next_permutation` |
| `xs[a].update(ys[b])` -> `xs[a] = ys[b]` | `minimum_spanning_tree` (`group_by_node[node].update(...)` → `group_by_node[node] = group_by_node[u]`) |

and `src/synth/beam/state.ts:135` (`CURRENT_LINE_CORRECT_CRITERIA.false.examples`, a Q5-family Noul) uses "`return gcd(a % b, b)` recurses forever where `tests` expect `gcd(b, a % b)`".

Why this matters even though it is not a fix table: (a) it is a benchmark-specific string constant in `src/synth` that reaches the model on every QuixBugs run, which the brief classifies as a violation; (b) the Q7 measurement the design cites (top-1 28–29/40, "measured wording verbatim") was taken with the answers to ten of the forty programs in the prompt; (c) the docs' "code proposes, Jev decides" story is intact (Q7 is a soft source-order prior, `subgoal.ts:55-56,177`, `sites.ts:87`; it cannot produce a candidate), but the Jev side of the decision is contaminated for ten programs. Fix: replace the examples with synthetic ones drawn from no benchmark and re-run the Q7 probe.

### 3.3 Benchmark-shaped code that is allowed but should be labelled

- `src/synth/search/perturb.ts` (uncommitted): behaviour-clustering probes that parse QuixBugs JSON case files and pytest `Node(...)` chains (`:6-15,42,50,87,577`). It is keyed on test-file shape, not on program names (no `name ===` anywhere), and was written after seeing the two run-3 overfits (`detect_cycle`, `wrap`; header `:15`). Allowed by the design (§2.6 `perturbedInputs`), but it is a benchmark-motivated component and its effect on `wrap`/`detect_cycle` is an in-sample result until measured on programs it was not written against.
- `src/synth/search/budget.ts:162-216` and `src/synth/verify/quixbugs.ts:107-108` rebuild the `run_tests.py <name> <candidate>` command per lane and parse its JSON; `src/synth/search/guard.ts:74-80` and `src/synth/search/sites.ts:101` carry constants retuned after specific QuixBugs programs (§4.3).
- The bench harness knows the QuixBugs reference directory (`quixbugsDir`, `src/bench/quixbugs/evaluator.ts:98`) and its `correct/` folder; no code path in `src/synth` references `correct/`, `bench/data` or `index.json` (grep). Whether the agent's sandbox could *read* the repo's `bench/data/quixbugs/correct/` was not verified here (the seatbelt profile denies listed secret paths, `src/sandbox/seatbelt.ts:42,90`, and the synthesizer only reads workspace files); it does not matter for the claim because the synthesizer is code with no such read, but a live run could confirm with a `read` of that path being denied.

---

## 4. Decisions: Jev or code thresholds? (PARTIAL)

### 4.1 Q1–Q17 status against `docs/JEV-ONLY-DESIGN.md` §2.7

| Q | design id | implemented id / site | asked live? | code rules around it, and whether each is a fact or a judgment |
| --- | --- | --- | --- | --- |
| Q1 | `attack_first` | `attack_first`, `src/synth/search/goals.ts:58-60,644-719` | yes | skipped when one active or one open goal (`goals.ts:707,710`): **fact**. Argmax must beat runner-up by `DEFAULT_TIE_MARGIN` 0.02 (`verify/questions.ts:19`) else code tiebreak: design rule, Jev noise band. |
| Q2 | `fix_file_<path>` | key = path, `contextNoul`, `src/synth/localize/questions.ts:60-63`, asked chunked at `localize/index.ts:183-197` | yes | consumed by rank, never by threshold (`index.ts:7`). Skipped when the workspace is one file or every file fits the beam (`index.ts:144-149`): **fact**. |
| Q3 | `fix_file_confirm_<path>` | key = path, full-criteria `noul`, `questions.ts:71-77`, `index.ts:205` | yes | – |
| Q4 | `fix_function` | `functionStage`, keys from `functionKey()` (`localize/keys.ts:12`), `questions.ts:98`, `index.ts:245` | yes | – |
| Q5 / Q5n | `buggy_line` / `line_<k>` | `lineStage` (`questions.ts:137-142`, keys `line_<n>` `keys.ts:34`), asked at `search/sites.ts:510,519` | yes | `Q5_ANCHOR_MIN_P` 0.05, `Q5N_SHORT_CIRCUIT_P` 0.9, `Q5_ESCAPE_INSERT_FIRST` 0.3 (`sites.ts:75-85`): design values. |
| Q6 | `insert_after` | `askGaps`, keys `before_l1`/`after_l<i>` (`sites.ts:723-724,831`) | yes | fallback keeps extra gaps at `Q6_FALLBACK_MIN_P` 0.2 (`sites.ts:101`, not in the design; comment: tuned to `reverse_linked_list`'s neighbours "0.43 / ~0.3"): **judgment threshold, benchmark-tuned**. One request per statement template, ≤ 5 (`sites.ts:826-827`, `:99`): batching violation (§4.4). |
| Q7 | `edit_class` | `edit_class`, `sketch/questions.ts:31-39`, asked alone at `subgoal.ts:121` | yes | soft prior only; `insert_new_line ≥ 0.5` reorders (`subgoal.ts:56`, `sites.ts:87`): design value, ordering only. Wording carries gold fixes (§3.2). |
| Q8 | `fix` | `CHOICE_QUESTION_ID = 'fix'` (`rank/questions.ts:89`) | yes | `fixProbablyAbsent = P(escape) − p_max ≥ 0.10` (`rank/index.ts:68,166-167`): design. |
| Q9 | `is_fix_<xx>` | id = candidate key (`cand_xx`), **compact only** (`contextNoul`, `rank/questions.ts:276-279`) | yes | `NOUL_ABSENT_THRESHOLD` 0.5 (`rank/index.ts:70,171-172`) switches candidate source: a **routing judgment on a 0.5 cut** (design-sanctioned wording "max p < 0.5", REPORT §14 warns against it). Design promised full-criteria Nouls for 11–150 candidates (the 39–40/40 top-3 figure); only the compact form exists, whose measured figure is 36–40/40. |
| Q10 / Q10r | shortlist Choice / shuffled re-ask | `rank/index.ts:397-402`; `shouldShuffleRerank` `:95,476-480` | yes | `SHUFFLE_RERANK_MARGIN` 0.1: design. |
| Q11 | `hole_<k>` | `donor/holes.ts:288`, one request per hole | yes | design says one per request (measured). |
| Q12 | `sketch` | `SKETCH_QUESTION_ID = 'sketch'`, keys `sketch_aa…` (`sketch/questions.ts:23,58-60,98`) | yes | K = 3, or 5 when `P(top) < 0.5` or `P(escape) ≥ 0.3` (`:47-48`): design values; the 0.5 is a widening cut, not a gate. |
| Q13 | `slot_<hyp>` | `slot_${key}` (`fill/beam.ts:301`), B items per request (`:225`) | yes | expand 1 when `p(top) ≥ 0.9` else B = 3 (`beam.ts:31,262`; `index.ts:50`): design. |
| Q14 | `next_token` | `beam/` (`next_token`, `end_of_line`) | yes | – |
| Q15 | `genuine_fix` | `GENUINE_FIX_ID` (`guard.ts:356,503-508`) | yes | argmax proposed; suspect when `P(escape) ≥ SUSPECT_ESCAPE_MIN` **0.8** and `max Noul < 0.1` (`guard.ts:81-82`). The design says 0.9; the comment (`:74-80`) explains 0.9 "missed the second [`wrap`] by one wire tick", i.e. **retuned to a specific QuixBugs program after a live run**. |
| Q16 | `general_<xx>` | `GENERAL_PREFIX` (`guard.ts:357`), same request as Q15; alone for a lone passer (`:539`) | yes | override rule 0.3/0.7 (`:88-89`): design. Lone-passer "hold" rules (b): a test-passing candidate with ≥ 1 code-detected "structural signal" (`guard.ts:273` None-attribute guard, `:302` "expression read elsewhere") is delayed within the step unless its Q16 p ≥ 0.7 (`:94-105`). The design (§2.6, §2.7 "Not asked anywhere") says a lone passer is never withheld on a Noul threshold; the implementation withholds it until step end. **Judgment by code + Noul threshold; softened but a deviation.** |
| Q17 | `program_correct`, `made_progress`, `broke_something`, `closeness` | `progressQuestions()` (`verify/questions.ts:66-92`), exposed on the interface (`verify/index.ts:58`) | **no** | no caller anywhere in `src/` (grep `progressQuestions\(|codeVerdicts\(`); `bases.ts:99-100` keeps a `closeness` cache "so an incumbent is judged once" that nothing fills. Progress is decided by code arithmetic (`verify/progress.ts`): a **fact** and the design's own preference (240/240). But the design's consistency check, the "≥ 3 disagreements flags the runner parser" alarm and the `closeness` tie-break do not exist, while `docs/JEV-ONLY-DESIGN.md` §2.7 says they are asked "on commits and held partials". |

Loop-side rules that override or bypass a Jev answer in jev-only, and their nature:

- `src/loop/stages/intent.ts:133-155 resolveIntentWithLedger`: with an open ledger, an `edit` intent becomes `verify` while a change is unverified, and a `fallback` is rescued when Jev's raw answer was `edit`/`verify` with p ≥ `LEDGER_CHOICE_FLOOR` 0.3 (`:38`). Whether the last change is verified is a **fact** the harness knows; the 0.3 rescue is a judgment threshold but recorded as `overridden` in the decision rows.
- Risk stage `evidence_consistent` (`src/loop/stages/risk.ts:26,134-146`) and `MATCHES_INTENT_THRESHOLD` 0.3 affect reason text only (`:24-26,174`).
- Context stage selects files at `p ≥ 0.5` (`src/loop/stages/context.ts:16,59`); §6 Choice resolution uses `PAIRED_NOUL_FLOOR` 0.5 (`src/loop/stages/choose.ts:10`); plan acceptance 0.7/0.3 (`src/loop/plan.ts:10-11`). These are engine-wide (DESIGN.md), not jev-only specific, but they are 0.5 cuts on Jev outputs.

### 4.2 Design principle check: fact or judgment

Facts the harness knows, correctly decided by code: one goal → no Q1; one file → no Q2–Q4; `|plausible| == 1` → commit without Jev (`guard`); `mem.tried` exclusion; SIEVE vs RANK by measured `t_run`; progress arithmetic; change verified → `verify` intent.

Judgments decided by code thresholds on Jev's numbers (each is design-sanctioned in form; the constants are the issue): suspect-hold `0.8/0.1` (retuned), lone-passer hold `0.3/0.7` + structural signals (not in design), `fixProbablyAbsent` `0.5`, Q6 fallback gap keep `0.2` (tuned), oracle block pick `PICK_THRESHOLD` 0.5 with `TIE_MARGIN` 0.05 (`src/synth/oracle/questions.ts:30,202,224-243`; mitigated by code verifying the block fails on the base commit).

### 4.3 Benchmark-tuned constants (the ones to hold out)

- `guard.ts:81 SUSPECT_ESCAPE_MIN = 0.8` (design 0.9; moved for `wrap`, `guard.ts:74-80`).
- `sites.ts:101 Q6_FALLBACK_MIN_P = 0.2` (for `reverse_linked_list`).
- `guard.ts:94-105` lone-passer hold/vouch rules (introduced for `detect_cycle`, `guard.ts:99-101`).
- `perturb.ts` probes (for `detect_cycle`, `wrap`, `:15`).

None is a program-name key; all were set by looking at the failing programs of the very benchmark whose score is reported. The quixbugs-4-overfit results (3/3) that exercise them are therefore in-sample.

### 4.4 REPORT.md rules (the private research report, §14) against the code

| rule | status | evidence |
| --- | --- | --- |
| Batch every question about one state in one request | **violation (minor)** | Q6 fallback asks one Choice per statement template over the same state, up to `Q6_FALLBACK_STATEMENTS` 5 (`src/synth/search/sites.ts:99,826-827`). Q11 one hole per request (`donor/holes.ts:288`) is design-sanctioned and measured. Localiser chunks ≤ 250 per request concurrently (`localize/index.ts:183-197`), Q15+Q16 one request (`guard.ts:503`), Q13 B per request: compliant. |
| Every Choice has an escape or paired Nouls | **pass** | `choice()` always appends `none_of_these` unless another escape is named (`src/jev/questions.ts:63-74`); no raw `type: 'choice'` literal in `src/synth` or `src/loop` (grep). Q5/Q5n, Q8/Q9, Q15/Q16 are paired; Q1, Q4, Q6, Q7, Q11–Q14 rely on the escape (allowed). |
| Criteria as definition + examples | **pass with a doc mismatch** | `noul()` enforces both sides with ≥ 2 examples (`questions.ts:32-46`). `contextNoul` (criteria once in state, §5.5 exception) is used for Q2 (`localize/questions.ts:63`) and for **all** Q9 Nouls (`rank/questions.ts:279`); the design table promised full criteria at 11–150 candidates. |
| Never ask Jev to count or compare numbers | **violation in text, dead or reason-only** | Q17 `made_progress` asks "does the program pass strictly more tests in `after` than in `before`" with criteria "the number of passing tests in `after` is larger" (`verify/questions.ts:74-76`), and `program_correct` examples compare `after.passed` with `after.total` (`:68-69`); never asked (§4.1). Risk `evidence_consistent` (`risk.ts:134-146`) asks whether claimed counts are plausible given `recent` counts; live in jev-only, reason text only. |
| Pin the dated model id | **pass** | §1.4. |
| No 0.5 thresholds on borderline decisions | **violation (six sites)** | `rank/index.ts:70 NOUL_ABSENT_THRESHOLD`, `oracle/questions.ts:30 PICK_THRESHOLD`, `loop/stages/context.ts:16 CONTEXT_SELECT_THRESHOLD`, `loop/stages/choose.ts:10 PAIRED_NOUL_FLOOR`; soft/ordering only: `subgoal.ts:56 INSERT_FIRST_MIN_P`, `sites.ts:87 Q7_INSERT_NEW_LINE_FIRST`, `sketch/questions.ts:47 LOW_CONFIDENCE_P_TOP`. The design itself sanctions three of these in wording; REPORT §6 measured ±0.02 noise at 0.5, so each will flip run to run. |

---

## 5. Secrets hygiene (PASS, one gap)

- Subprocess env: `src/sandbox/run.ts:30-31,111-126` builds the child env from an allowlist (`PATH`, `LANG`, `LC_ALL`, `TERM`) plus `TMPDIR`, `HOME` (run-local), `VIRTUAL_ENV`, and caller `extra`. Callers pass only constants: `src/synth/sieve/runner.ts:15,27-32` (`PYTHONDONTWRITEBYTECODE`, case-timeout vars), `src/synth/oracle/runner.ts:249-254` (`opts.env` rendered as an `env K=V` prefix), `src/workspace/git.ts:14-30` (`GIT_ENV`, "never process.env"), `src/bench/terminalbench/{evaluator.ts:216,loader.ts:80}` (PATH/HOME), `src/sandbox/kill.ts:48` (`PATH` only). `src/synth/sbfl/tracer.ts:475 env = dict(os.environ)` runs inside the already-scrubbed sandbox child. No `...process.env` spread anywhere in `src/` (grep); `process.env` reads are `PATH`, `HOME`, `JEVCODE_TRACE`, `JEVCODE_DEBUG`, `npm_package_version` and the config loader.
- Sandbox profile: secret home subpaths denied (`src/sandbox/seatbelt.ts:42,90`), secret basenames `.env`, `.netrc`, `*.pem`, `*.key`, `id_*` denied with `.env.example` excepted (`src/sandbox/paths.ts:108-110`).
- Redaction: `SecretSet` = every resolved secret setting plus every `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` variable in each loaded `.env`/config (`src/config/resolve.ts:289-298`, `src/core/redact.ts:31`); format patterns for `sk-or-v1-`, `sk-ant-`, `sk-(proj|live|test)`, `AIza`, `gh*_`, `github_pat_` and header values (`redact.ts:40-51`). Checkpoint store redacts state, records, meta and transcript on every write (`src/checkpoint/store.ts:69-77,96,223,266,418`); synth state is redacted and bounded before it can reach a checkpoint (`engine.ts:864-872`); engine error messages (`engine.ts:1255,1279`), Jev client errors and URL echoes (`client.ts:210,213,222-231,266,290,297`) pass through `redact`. `configRecord` is `maskEntries()` (`resolve.ts:331`).
- Checked-in artefacts: `grep -rl 'sk-or-|sk-ant-|sk-proj-' bench/results experiments/results` → **0 files**. Real-looking keys (prefix + ≥ 40 chars) anywhere in the repo excluding `node_modules`/`.git`: only `test/fixtures/config/{redaction.env,exec-output.txt}`, `test/unit/jev/helpers.ts`, `test/unit/config/{resolve,validate}.test.ts`, `test/unit/provider/helpers.ts`, which are the redaction tests' deliberate fakes. Hits in `docs/**` and `dist/jevcode.mjs*` are the prefixes in prose and the bundled regex. `.env` and `.env.*` are gitignored (`.gitignore`), only `.env.example` is tracked. `JEVCODE_TRACE` output carries names, statuses and byte counts only (`client.ts:255-263`, `engine.ts:488-1502`).
- **Gap**: `src/bench/runner.ts:396` and `:631` write `tasks.jsonl` with `JSON.stringify(r)` and no redaction pass, although `opts.redact` is in scope (`:424,502`). `rec.reason` can carry raw evaluator output tails (`tail(res, 300)` in `src/bench/swebench/evaluator.ts:66-69`, used by `quixbugs/evaluator.ts:103` and `ladder/evaluator.ts:48`) and unredacted `toJevCodeError(e).message` from setup/evaluator/runner failures (`runner.ts:481-483,534-535,566,574,618`). Exposure needs a secret in sandboxed command output, which the env scrub and basename denial make unlikely, but the bench writer has no defence-in-depth of its own.

---

## 6. Measurement honesty (PARTIAL)

### 6.1 "solved" is the evaluator's verdict, not the agent's

`buildRecord` copies `evaluation.pass` (`src/bench/runner.ts:205-207`); the agent's `done` never sets it.

- QuixBugs: `evaluateQuixbugs` runs `bench/data/quixbugs/run_tests.py <name> <workspace>/<name>.py` (`src/bench/quixbugs/evaluator.ts:81-82,98-108`); `run_tests.py` loads the cases from its own `tests/` next to itself (`run_tests.py:40 TESTS_DIR = HERE/tests`, `:196`), so an agent editing `tests/` in the workspace cannot affect the verdict. `pass` iff exit 0, `failed == 0`, `errors == 0`, `passed > 0`.
- Ladder: `evaluateLadder` first fails the record if `git status --porcelain -- tests/` is non-empty, then runs `pytest tests` in the workspace (`src/bench/ladder/evaluator.ts:27-29,41-49`).
- `jev-only-quixbugs-3`: 36 pass, misses `depth_first_search`, `longest_common_subsequence`, `reverse_linked_list`, `shunting_yard` (from `tasks.jsonl`), matching `experiments/results/jev-only-quixbugs-3-inspection.md` §3. `jev-only-ladder-4`: 11 pass, `account` fails `passed 7, failed 3` (from `tasks.jsonl`), matching `docs/JEV-ONLY.md:195-196` and the per-task table in `experiments/results/jev-only-ladder-4-analysis.md:9-19`.

### 6.2 But there is no hidden suite

The QuixBugs workspace receives the complete `tests/<name>.json` and a generated pytest module over **all** its cases (`src/bench/quixbugs/loader.ts:113-120`), and the evaluator runs the same cases (the two `slow` cases are skipped in both). The ladder workspace receives the whole `tests/` directory that the evaluator runs. So "solved" means "passes the full suite, which the agent could see", and `jev-only-quixbugs-3-inspection.md` §3 says so ("evaluator = visible tests"). Wording to fix: `experiments/results/jev-only-rungs-1-2.md:33,184,440` say "fails the hidden third test" / "the hidden evaluator" where the meaning is "the full suite versus the attacked goal subset"; nothing is hidden from the agent. The overfit detection reported in the inspection file came from the inspector's extra inputs, not from any bench oracle.

### 6.3 "correct by inspection" backing

- Run 1 (`docs/JEV-ONLY.md:158`, `docs/STATUS.md:109`: 34/40 repaired, 31 correct): backed per program by the table at `experiments/results/jev-only-rungs-1-2.md:51-94` (`correct by diff` column).
- Run 3 (`jev-only-quixbugs-3-inspection.md` §3: 36/40 pass, 34 correct): per-program verdicts exist for the 10 passers whose patch differs from the reference (§1 table) and the 4 misses. The **27 "gold-identical" programs are a count, not a list**; the file attributes 26 to "the bench", but no code under `src/bench` or `src/synth` computes gold identity (grep `gold-identical|goldIdentical`) and `tasks.jsonl` has no such field, so that number's provenance is undocumented. The patched files it was computed from live under `~/.jevcode/runs/bench-work/…` and are not checked in, so the count cannot be re-derived from the repository.
- Ladder-4: per-task table at `jev-only-ladder-4-analysis.md:9-19`; no inspection claim beyond pass/fail is made.

### 6.4 Other claims cross-checked

- `docs/JEV-ONLY.md:181` "SWE-bench rung 3, first attempt: 0/30": `bench/results/jev-only-swebench-1/tasks.jsonl` has 20 evaluated instances (all fail) and 2 that never finished; no `summary.json`. The honest statement is 0/20 evaluated, 2 unfinished.
- `docs/JEV-ONLY.md:196` "$0.137, generator calls 0" for ladder-4: matches `summary.json` (`spentUsd.jev 0.1370`) and the records.
- `docs/STATUS.md:107-110`: matches quixbugs-1.

---

## 7. Ranked list of violations to fix

1. **(§3.2, medium) QuixBugs gold fixes embedded in the Q7 `edit_class` option descriptions and in `CURRENT_LINE_CORRECT_CRITERIA`** — `src/synth/sketch/questions.ts:34-39`, `src/synth/beam/state.ts:135`. Replace with synthetic examples from no benchmark; re-measure Q7 top-1/top-2 and the edit-class prior's effect on QuixBugs.
2. **(§4.1, medium) Q17 is documented as asked and is dead code** — `src/synth/verify/questions.ts:66-92` has no caller; `bases.ts:99-100` `closeness` cache is never filled. Either wire the consistency check (one request per commit, `synth` event on a confident disagreement) or delete it and amend `docs/JEV-ONLY-DESIGN.md` §2.7 Q17 and `bases.ts:7`.
3. **(§4.3, medium) Thresholds retuned to named QuixBugs programs after live runs** — `guard.ts:81` (0.9 → 0.8 for `wrap`), `sites.ts:101` (0.2 for `reverse_linked_list`), `guard.ts:94-105` lone-passer hold for `detect_cycle`, `perturb.ts` for `detect_cycle`/`wrap`. Report quixbugs-4-overfit and any score that depends on them as in-sample, or hold out the programs used to set them.
4. **(§6.2–6.3, medium) Measurement wording and backing** — remove "hidden" from `jev-only-rungs-1-2.md:33,184,440`; state in `docs/JEV-ONLY.md` that the evaluator suite is the visible suite; add a per-program `gold-identical / equivalent / overfit / miss` table for run 3 and archive the 40 patched files (or their diffs) under `experiments/results/`; state SWE-bench as 0/20 evaluated + 2 unfinished.
5. **(§4.4, low–medium) 0.5 cuts on Jev probabilities** — `rank/index.ts:70`, `oracle/questions.ts:30`, `loop/stages/context.ts:16`, `loop/stages/choose.ts:10` (plus ordering-only `subgoal.ts:56`, `sites.ts:87`, `sketch/questions.ts:47`). Move each to a measured cut from the relevant probe's confidence-vs-accuracy plot, or add the ±0.02 band handling the tie-margin code already has.
6. **(§4.1 Q16, low) Lone-passer hold contradicts the design's "never withheld on a Noul threshold"** — `guard.ts:94-105`. Either amend the design (within-step delay is allowed) or drop the hold in favour of the behaviour probe.
7. **(§4.4, low) Q9 compact-only vs the design's full-criteria promise at 11–150 candidates** — `rank/questions.ts:276-279`. Implement the full form or change the design row and the cited 39/40 figure to the compact 36–40/40.
8. **(§4.4, low) Q6 fallback batching** — `sites.ts:826-827`: ≤ 5 requests over one state; ask all statement templates as independent Choices in one request.
9. **(§5, low) Bench writer has no redaction pass** — `src/bench/runner.ts:396,631`: run `opts.redact` over `reason` (or the whole record) before writing; redact evaluator `tail()` output.
10. **(§4.4, low) Numeric-comparison wordings** — `verify/questions.ts:68-76` (dead) and `risk.ts:134-146` (reason-only). Reword to set membership ("a test in `before.failing_tests` is absent from `after.failing_tests`") if kept.
11. **(§2.3, info) Design §5.6's per-record `SearchTrace` totals are not written** — `src/bench/types.ts` has no `testRuns`/`candidatesTested`/`bySource`; add them or drop the promise.

Items 1–3 change no pass count on their own (Q7 is a prior; the thresholds only gate the overfit guard) but they are what an outside reader would call benchmark contamination and tuning, so they should be fixed or disclosed before any of the QuixBugs numbers are quoted as out-of-sample.

---

## 8. Exact greps and scripts run (all from the repo root, read-only)

```
# 1. network / providers / models / modes
grep -rn --include='*.ts' -E "\bfetch\s*\(" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' --include='*.tsx' -E "doFetch\(|deps\.fetch|globalThis\.fetch|d\.fetch\(" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "from ['\"](node:)?(http|https|undici|net|http2)['\"]" src
grep -rn --include='*.ts' -E "https?://" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -i -E "openai|anthropic|openrouter|chat/completions|/messages|/v1/|\.messages\.create|completions\.create|responses\.create" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "jev-1\.13|typesafe/|claude-|gpt-|o[134]-mini|deepseek|qwen|llama|gemini|text-embedding|embedding" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "jev-only|jevOnly|JEV_ONLY|NullProvider|createNullProvider|NullProviderCalledError" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "createProvider|createOpenAIProvider|createAnthropicProvider|createOpenRouterProvider|createMockProvider|resolveProvider|providerFor|getProvider|defaultProvider|new OpenAI|new Anthropic" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "\.generate\s*\(|provider\.generate|generate\(" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' --include='*.tsx' -E "\.generator\(\)|generator\(\)" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "fetch\(|generate\(|provider|createJevClient|decider\.|\.ask\(" src/synth | grep -v "\.test\.ts"
grep -rn --include='*.ts' --include='*.tsx' -E "decider|provider\.|\.generate\(|createJevDecider|fetch" src/tui | grep -v "\.test\."
grep -rn --include='*.ts' -E "function summari[sz]e[A-Za-z]*\(" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "pip install|git clone|curl |wget |urllib|requests\.get" src | grep -v "\.test\.ts"
grep -n -E "fetch|baseUrl|model|url|pinned|dated|20260917" src/jev/client.ts
grep -n -E "provider|Provider|jev-only|mode|createNullProvider|generator\(\)|decider\(\)" src/cli/main.tsx

# 2. bench assertion and results
sed -n 190,260p src/bench/runner.ts; sed -n 470,560p src/bench/runner.ts; cat src/bench/conditions.ts; sed -n 1,80p src/bench/cli.ts
for d in bench/results/jev-only-*; do f="$d/tasks.jsonl"; grep -c '"generatorCalls":0[,}]' "$f"; grep -E -c '"generatorCalls":[1-9]' "$f"; grep -c '"evaluator":"invalid"' "$f"; done
node -e '<parse every tasks.jsonl: Σ generatorCalls, Σ cost.generator, Σ cost.jev, Σ generatorTokensPerStep, pass/fail/null, evaluator, condition, invalid>'
for d in bench/results/jev-only-*; do node -e '<print summary.json spentUsd.generator, spentUsd.jev, generatorModel, conditions["jev-only"].deciderModel, conditionOrder>' "$d/summary.json"; done
grep -n -E "invalid|generator called|generatorCalls|NullProvider" test/unit/bench/jev-only.test.ts
grep -n -E "jevRequests|testRuns|candidatesTested|bySource|synth|trace" src/bench/types.ts

# 3. hidden intelligence
ls bench/data/quixbugs/programs | sed 's/\.py$//'      # 40 names
for n in <40 names>; do grep -rn --include='*.ts' -w "$n" src | grep -v "\.test\.ts" | grep -v -E "^\S+:\s*(//|\*|/\*\*)"; done
for n in account calendar_utils events grades inventory profiles shipping stats table tagcloud textstats units; do grep -rn --include='*.ts' -w "$n" src/synth | grep -v "\.test\.ts" | grep -v -E "^\S+:\s*(//|\*|/\*\*)"; done
grep -rhn "def test_" bench/data/ladder/tasks/*/tests/*.py | sed 's/.*def //;s/(.*//' | sort -u | while read t; do grep -rn --include='*.ts' -F -- "$t" src | grep -v "\.test\.ts"; done
for p in bench/data/quixbugs/programs/*.py; do diff "$p" bench/data/quixbugs/correct/$(basename $p) | grep '^>' | sed 's/^> //;s/^[[:space:]]*//;s/[[:space:]]*#.*$//' | while read -r frag; do [ ${#frag} -ge 8 ] && grep -rn --include='*.ts' -F -- "$frag" src/synth | grep -v "\.test\.ts"; done; done
for t in bench/data/ladder/tasks/*/; do for g in $t/gold/*.py; do diff "$t/src/$(basename $g)" "$g" | grep '^>' | sed 's/^> //;s/^[[:space:]]*//' | while read -r line; do [ ${#line} -ge 10 ] && grep -rn --include='*.ts' -F -- "$line" src/synth | grep -v "\.test\.ts"; done; done; done
grep -rn --include='*.ts' -i -E "quixbugs|ladder|swebench|swe-bench|gold|correct/|\.gold|task_id|instance_id|django|sympy|pylint|pytest-7205|astropy|sphinx|requests-|matplotlib|scikit|xarray" src/synth | grep -v "\.test\.ts" | grep -v -E "^\S+:\s*(//|\*)"
grep -rn --include='*.ts' -E "quixbugsDir|run_tests\.py|programs/|correct" src/synth | grep -v "\.test\.ts" | grep -v -E "^\S+:\s*(//|\*)"
grep -rln -i -E "gold-identical|goldIdentical|gold_identical" experiments scripts src/bench src/synth
node -e '<match Q7 example fragments against bench/data/quixbugs/index.json buggyLine/fixedLine>'
sed -n 20,60p src/synth/templates/common.ts; sed -n 28,42p src/synth/sketch/questions.ts; sed -n 128,140p src/synth/beam/state.ts
sed -n 40,70p src/bench/ladder/loader.ts; sed -n 36,50p src/bench/quixbugs/loader.ts; sed -n 95,150p src/bench/quixbugs/loader.ts

# 4. questions and thresholds
for q in attack_first fix_file_ fix_file_confirm fix_function buggy_line line_ insert_after edit_class "'fix'" is_fix_ hole_ "'sketch'" slot_ next_token genuine_fix general_ program_correct made_progress broke_something closeness none_of_these correct_fix_criteria end_of_line module_level_code_outside_any_function failure_kind is_reproduction shows_expected shows_actual; do grep -rn --include='*.ts' -F "$q" src/synth | grep -v "\.test\.ts" | wc -l; done
grep -rn --include='*.ts' -E "progressQuestions\(|codeVerdicts\(|askProgress|progressCheck|consistencyCheck" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "pickGoal\(|attackFirst|ATTACK_FIRST|'attack_first'" src/synth | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "fileStage\(|confirmStage\(|functionStage\(|lineStage\(" src/synth | grep -v "\.test\.ts"
grep -n -E "FIX_CHOICE_ID|CHOICE_ID|NOUL_PREFIX|cand_|is_fix|correct_fix_criteria|export const [A-Z_]+ = '" src/synth/rank/questions.ts
grep -n -E "full|compact|contextNoul|noul\(|criteria" src/synth/rank/questions.ts
grep -rn --include='*.ts' -E "(>=|<=|>|<)\s*0\.[0-9]+|0\.[0-9]+\s*(>=|<=|>|<)|_THRESHOLD|_MARGIN|THRESH|= 0\.[0-9]+;" src/synth | grep -v "\.test\.ts" | grep -v -E "^\S+:\s*(//|\*)"
grep -rn --include='*.ts' -E "(>=|<=|>|<)\s*0\.5\b|=\s*0\.5;|0\.5\s*(>=|<=|>|<)|THRESHOLD\s*=\s*0\.[0-9]+|FLOOR\s*=\s*0\.[0-9]+" src/loop src/core src/jev | grep -v "\.test\.ts"
grep -rn --include='*.ts' -i -E "how many|count the|number of|is longer|more than [0-9]|fewer than|at least [0-9]|greater than|exceeds" src/synth src/loop/stages src/loop/state.ts | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "type:\s*'(choice|noul|score)'" src/synth src/loop | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "pairedNouls|PAIRED_PREFIX|can_" src/synth src/loop/stages | grep -v "\.test\.ts"
grep -rn --include='*.ts' "contextNoul" src/synth | grep -v "\.test\.ts"
grep -n -E "export function (choice|noul|contextNoul|score)|escape|none_of_these|ESCAPE|criteria|definition|examples" src/jev/questions.ts
sed -n 70,120p src/synth/search/guard.ts; sed -n 95,105p src/synth/search/sites.ts; sed -n 800,845p src/synth/search/sites.ts
sed -n 55,110p src/synth/verify/questions.ts; sed -n 125,170p src/loop/stages/intent.ts
grep -n -E "evidence|override|skip|fact|verdict =" src/loop/stages/risk.ts
grep -n -E "singleFile|files\.length|=== 1|skip|chunk|CHUNK|254|250" src/synth/localize/index.ts
grep -n -E "length === 1|length <= 1|one goal|skip" src/synth/search/goals.ts
grep -n -E "ctx\.ask\(|askArbitrate|questions\[|GENUINE_FIX_ID\]|generalKey|general_" src/synth/search/guard.ts
grep -n -i -E "rule|must|never|always|batch|escape|Noul|threshold|0\.5|dated|pin|count|compute|definition|example" <research-report>

# 5. secrets
grep -rn --include='*.ts' -E "env\b|process\.env|API_KEY|apiKey|scrub|allowlist|ALLOW|PATH" src/sandbox | grep -v "\.test\.ts"
grep -rn --include='*.ts' --include='*.tsx' -E "process\.env" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "env:\s*\{|env:\s*[a-zA-Z]|\benv\b\s*=" src/bench src/synth src/workspace src/loop | grep -v "\.test\.ts"
grep -rn --include='*.ts' --include='*.tsx' -E "\bspawn\(|execFile\(|\bexec\(|execSync|spawnSync|child_process" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "apiKey" src | grep -v "\.test\.ts"
grep -rn --include='*.ts' -E "configRecord|secretPaths|apiKey|process\.env|redact" src/checkpoint src/config/resolve.ts | grep -v "\.test\.ts"
grep -n -E "configRecord|summary|writeFile|redact|JSON.stringify" src/bench/runner.ts
grep -n -E "redact|error\.message|errorRecord\(|toJevCodeError" src/bench/runner.ts
grep -n -E "error:\s*\{|error = \{|code: .*message: " src/loop/engine.ts
grep -rn --include='*.ts' -E "jtrace\(|^\s*trace\(" src/jev/client.ts src/loop/engine.ts
cat src/core/redact.ts; sed -n 285,340p src/config/resolve.ts; grep -n -A6 "export function tail" src/bench/swebench/evaluator.ts
for p in 'sk-or-' 'sk-ant-' 'sk-proj-'; do grep -rl -- "$p" bench/results experiments/results | wc -l; done                      # 0 0 0
for p in 'sk-or-' 'sk-ant-' 'sk-proj-'; do grep -rl --exclude-dir=node_modules -- "$p" docs src test scripts .scratch dist perf examples; done
for re in 'sk-or-v1-[A-Za-z0-9]{40,}' 'sk-ant-[A-Za-z0-9_-]{40,}' 'sk-proj-[A-Za-z0-9_-]{40,}' 'sk-[A-Za-z0-9_-]{40,}'; do grep -rEl --exclude-dir=node_modules --exclude-dir=.git -- "$re" .; done   # test fixtures/helpers only
cat .gitignore; git ls-files | grep -i -E "^\.env|/\.env"    # .env.example only

# 6. measurement honesty
sed -n 1,110p src/bench/quixbugs/evaluator.ts; grep -n -E "tests|json|_test\.py|import|sys\.path|candidate|node" bench/data/quixbugs/run_tests.py
grep -n -E "evaluate|pass|hidden|check\.py|evaluator|pytest|exit|git diff|tests" src/bench/ladder/evaluator.ts src/bench/ladder/loader.ts
grep -n -E "visible|hidden|slow|cases|filter|slice" src/bench/quixbugs/pytest.ts; grep -n -i -E "hidden|visible|slow" bench/data/quixbugs/README.md
cat experiments/results/jev-only-quixbugs-3-inspection.md
grep -n "^## " experiments/results/jev-only-rungs-1-2.md; grep -n -E "^\| (program|task) \|" experiments/results/jev-only-rungs-1-2.md
grep -n -i "by inspection\|correct by\|gold-identical\|equivalent\|overfit" experiments/results/jev-only-rungs-1-2.md
grep -rn -E "quixbugs-3|ladder-4|3[0-9]/40|1[01]/12|correct by inspection" docs/STATUS.md docs/RESEARCH.md docs/JEV-ONLY.md README.md
grep -o '"gold[A-Za-z]*":[^,]*' bench/results/jev-only-quixbugs-3/tasks.jsonl | sort | uniq -c   # none
node -e '<per-task pass/stopReason/steps/reason for jev-only-quixbugs-3 and jev-only-ladder-4>'
node -e '<jev-only-swebench-1: tasks, finished vs in_progress-only>'
```
