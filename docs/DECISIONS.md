# JevCode decisions log

Each entry: date, decision, why, what it affects. Newest at the bottom. Deviations from
the build prompt or from `~/Documents/jev-research/REPORT.md` are also listed in
`docs/DESIGN.md` under "Deviations".

## 2026-09-19 Repository lives at `vscode/JevCode` as its own git repo

The parent folder `vscode/` already had an empty `.git` with no commits. JevCode is
initialised as its own repository so the package has an independent history and can be
published or moved without the sibling checkouts (Open Assist, CoArena, ...). Nothing is
imported from Open Assist; the only relationship is the optional `<OPEN_ASSIST_PATH>/.env`
fallback in config precedence.

## 2026-09-19 Live generator runs go through OpenRouter, default stays Anthropic

`ANTHROPIC_API_KEY` is empty in both `JevCode/.env` and `open-assist/.env`;
`OPENROUTER_API_KEY` is set. The default config remains provider `anthropic`, model
`claude-sonnet-5` as the prompt requires. Every live run in this build passes
`--provider openrouter` (or `JEVCODE_PROVIDER=openrouter`) with an OpenRouter Claude
Sonnet model id, verified against `GET https://openrouter.ai/api/v1/models` during
research. The Anthropic provider is exercised offline with recorded SSE fixtures and is
skipped, with an explicit skip reason, in `test:live` when no key is present.

## 2026-09-19 No Docker on the dev machine: bench evaluation strategy

`docker` is not installed and cannot be installed without the user (no Homebrew, Docker
Desktop needs an interactive installer). Python is the system 3.9.6 with pip 21 and
`venv`; clang and git are present. Consequences:

- SWE-bench Verified: the official harness (Docker images per instance) cannot run here.
  The bench records predictions in the official `predictions.jsonl` shape so they can be
  evaluated with `swebench` / `sb-cli` elsewhere, and additionally runs a local evaluator
  that builds a `venv` at `environment_setup_commit`, checks out `base_commit`, runs the
  instance's install command, applies `model_patch` and `test_patch`, runs `test_cmd` on
  the test files named in `test_patch`, and grades with ported log parsers under the
  official FULL rule (`FAIL_TO_PASS` in PASSED/XFAIL, `PASS_TO_PASS` also SKIPPED; see
  `docs/DESIGN.md` §13). Each task record states which evaluator produced `pass`
  (`local-venv`, `invalid`, `docker`, or `none`).
- The 30-task subset is chosen from repos that install under Python 3.9 without native
  builds, with mixed `difficulty` labels and several repos. This is a selection
  constraint, not an agent heuristic; the agent loop has no benchmark-specific code.
- Terminal-Bench: tasks are Docker-first. JevCode ships a Harbor-compatible installed
  agent adapter for the official harness, and a local runner that executes a task's
  instruction in a sandboxed temp workspace and runs its `tests/` locally when the task
  needs only tools present on the machine. Records state `evaluator: local` and list
  tasks skipped as `unsupported-locally`.

## 2026-09-19 Paid runs are capped

Live bench and live tests run under an explicit `--spend-cap`. The 3-task slice runs
first; the full 30-task run only proceeds if the slice's numbers are sane, with its own
cap recorded in the summary JSON.

## 2026-09-19 Toolchain pins and the bundling approach (measured)

Pinned from the npm registry on 2026-09-19 (see `docs/RESEARCH.md`): `ink 7.1.1`,
`react 19.3.0`, `@types/react 19.3.0`, `@types/node 22.20.4`, `typescript 7.0.2`,
`vitest 5.0.1` + `vite 8.3.0` + `@vitest/coverage-v8 5.0.1`, `esbuild 0.28.2`,
`tsx 4.23.13`, `ink-testing-library 4.0.0`. Node is pinned to the installed `22.23.2`
(Maintenance LTS until 2027-04-30) in `.nvmrc`, with `engines` `>=22.12.0 <27` and
`engine-strict=true`; Node 24 is Active LTS but not installed here, and Ink 7 needs
only `>=22`.

The CLI is bundled by esbuild into one ESM file with Ink and React inside. Three fixes
are needed: alias Ink's optional `react-devtools-core` import to an empty stub, define
`process.env.DEV` as `"false"` so the reconciler's devtools branch is dead code, and a
`createRequire` banner supplying `require` for CJS dependencies in Ink's tree (`signal-exit`
calls `require("assert")` at module init; the two-fix bundle fails at load on it). The
design review of 2026-09-19 found the third fix missing here; `docs/DESIGN.md` §12 has the
exact build command.
Smoke measurement of an Ink hello-world bundled this way, spawned under `script -q
/dev/null` (a pseudo-TTY), 5 cold runs: first frame at 69, 72, 70, 70, 70 ms after
process spawn; with `NODE_COMPILE_CACHE` 64–70 ms; bare `node -e` is 17 ms. Unbundled
via `tsx` the same app took 643 ms, so bundling is what makes the 300 ms budget
comfortable. Piped (non-TTY) output was the two `<Static>` lines and the last frame with
no escape codes, matching Ink's documented CI/non-interactive behaviour.

## 2026-09-19 Bench targets after research: SWE-bench v5 task repo, Terminal-Bench 4.0 on Harbor

- SWE-bench Verified's official harness is `swebench` 5.0.2 (Python >=3.10, Docker or
  Modal). Install and test specs now live in the `SWE-bench/swe-bench-tasks` repo
  (`dockerfile_gen/constants.py`, per-instance `tasks/<id>/{task.yaml,tests.json,eval.sh}`).
  The checked-in subset copies the spec and `eval.sh` per instance so the local evaluator
  reproduces the official test invocation (`git checkout <base> <test files>`, apply
  `test_patch`, run `test_cmd <test files>`, parse `PASSED`/`FAILED` lines, pass iff every
  `FAIL_TO_PASS` and `PASS_TO_PASS` test passes). Numbers are labelled "local, unofficial";
  `predictions.jsonl` is emitted for `sb-cli` or Modal grading elsewhere.
- Subset repos: sympy, django 4.1/4.2, pytest, pylint, requests (minus `psf__requests-2317`,
  which needs network). These 169 Verified instances install on Python 3.9 with
  `pip install -e .` and no native builds. Selection is deterministic and documented in
  `bench/data/README.md`.
- Terminal-Bench is version 4.0 (66 tasks, released 2026-08-30) run by Harbor 0.23.0; the
  1.x `tb` CLI is legacy. Every 4.0 task uses a separate verifier container and tests
  hardcode `/app`, `/tests`, `/logs/verifier`. Without Docker (or Apple's `container` CLI,
  which needs an admin install) no official run is possible here. JevCode checks in a
  10-task subset chosen for local feasibility, runs them in a sandboxed temp workspace with
  a path shim, labels results `evaluator: local`, and ships a Harbor installed-agent
  adapter so the official harness can run JevCode where containers exist.
- Patches: `patch` actions are applied with `git apply --check` then `git apply` through
  the sandbox runner (never `--unsafe-paths`). Local tests on git 2.50.1 showed it rejects
  `../`, `-p0` absolute paths and symlink traversal, and it works outside a git repository.
  A hand-written TypeScript diff applier would be more code for less safety.
- Primary edit format is exact-match search/replace with uniqueness (the Anthropic text
  editor and Claude Code convention; Aider's data shows Claude models at 97–99.6 % correct
  with exact-match blocks). Unified diff stays as a secondary action.

## 2026-09-19 No third benchmark in this build

The research survey (`docs/research/04-benchmarks-and-harnesses.md` §2) recommends
SWE-bench Pro's public set as the one justified addition: explicitly long-horizon,
multi-file, multi-language, with headroom (top public score 61.5 %) and comparable
mini-SWE-agent baselines. Its evaluation needs prebuilt Docker images
(`--use_local_docker`), which this machine cannot run, so adding it would produce a task
adapter with no way to evaluate it here. Decision: keep the two required benchmarks, and
list SWE-bench Pro as the recommended next addition in `docs/DESIGN.md` §17 (open
questions) and the README. The bench task adapter is written so a Pro adapter is a data
loader plus an eval-script runner, not a change to the engine.

## 2026-09-19 Adopt/reject from the CLI-architecture research

Adopted (see `docs/research/05-cli-architectures.md` §5): `<Static>` transcript plus a
non-static live region; one esbuild ESM bundle with a dependency-free launcher that
enables the compile cache and renders before any network call; a plain non-interactive
renderer chosen by `stdout.isTTY`; telemetry-free startup with no hardware or network
probes; `sandbox-exec` with an SBPL profile on macOS behind explicit modes (the profile
is `(allow default)` plus write denials and secret-read denials, not `(deny default)`, which
breaks toolchains; `docs/DESIGN.md` §8); a cold-start perf baseline in `npm run perf`. Also adopted from harness research
(`04` §3): bounded format-error re-queries, cost cap alongside step cap, hashed tool-call
loop detection with a judge (Jev), confirm-before-finish as a decision node, and
execution-based test evidence feeding the judge. Rejected: a Rust rewrite, Bun, Node
`--build-snapshot`, forking Ink, Docker as default sandbox, alternate-screen by default,
startup network probes, and a SEA binary.

## 2026-09-19 Parallel build: eight module owners, eight independent reviewers

The implementation was split by the file ownership in `docs/DESIGN.md` §19.8 against the
frozen contract `src/core/types.ts`. Each owner typechecked and tested only their own files
(per-module `tsconfig.<module>.json`, deleted at integration) and an independent reviewer
re-read the design sections and fixed defects in place before hand-off. Outcome: 8/8 modules
green in isolation, 713 offline unit tests across 55 files at the first whole-project run,
and 7 whole-project typecheck errors, all in the integrator's own wiring drafts. Seams the
reviewers raised were closed in a single integration pass and recorded in DESIGN.md §20:
shared transcript-item formatter, `generator:tool-delta` event, per-dimension `probability`,
`RunResult.jevQuestions`, `.venv/bin` on the sandbox PATH for live SWE-bench agents, extra
writable roots for the Terminal-Bench stand-in dirs, `FileNotFoundError`, and the
stage-failure counter resetting only on a step without a stage failure.

## 2026-09-19 Live demo choreography

The end-to-end live run (build-prompt item 2) uses `examples/demo-py` copied to
`/tmp/jevcode-demo` with a git history, an untracked `notes.txt`, and a `.venv` holding
pytest. Five tasks exercise every stage: a real fix (complete), a destructive request
(blocked at risk ≥ 0.7), removing the untracked scratch file (human review, answered in the
TUI), a `--no-network` task needing a missing package (identical install failure ×3 → loop
detection → replan), and a Ctrl-C mid-step followed by `--resume`. The TUI is driven under a
pseudo-TTY with `expect` so keystrokes (`y`/`n`, Ctrl-C) are real terminal input; the
transcripts are saved under `docs/live/`.

## 2026-09-19 The session's own ANTHROPIC_API_KEY is not used

The shell this build runs in carries an `ANTHROPIC_API_KEY` that belongs to the Claude Code
session, not to the project (`JevCode/.env` and `open-assist/.env` both have it empty). The
first `test:live` run picked it up through normal env precedence and the Anthropic-direct
generator test passed (one call, $0.0019), which incidentally verified `provider/anthropic.ts`
against the real Messages API. From this point every live command is run with that variable
unset (`env -u ANTHROPIC_API_KEY …`) and with `--provider openrouter`, so all paid work goes
through the user's OpenRouter key and is capped as described above. The README documents
that the default provider is `anthropic` and works when the user supplies a key.

## 2026-09-19 Seatbelt: deny contents under `~/.jevcode`, not metadata

The first profile denied `file-read*` on `~/.jevcode`. That blocked `mkdir -p`, `cd` and `git
clone` into the bench work dirs and the run's own `TMPDIR` (which live under it), because
even stat'ing a parent directory needs metadata reads: the mocked bench failed at setup with
`Operation not permitted`. The profile now denies `file-read-data` under `~/.jevcode` (other
runs' prompts, outputs and checkpoints stay unreadable, including the run's own `state.json`
and `sandbox.sb`) and re-allows reads under every writable root. A finding worth keeping:
an SBPL deny on the specific operation `file-read-data` outranks a later allow on the
`file-read*` family, so the re-allow must name `file-read-data` explicitly (verified on
macOS 26 with a write-then-read probe in the run's temp dir, a denied read of another run's
`state.json`, and a denied listing of `~/.jevcode/runs`).

## 2026-09-19 Mocked bench outcome and what it does and does not prove

`jevcode bench --suite all --tasks 3` (mocked) passes 3/3 SWE-bench instances in both
conditions: the gold trajectory is replayed through the real engine, sandbox, checkpoint,
patch extraction (`git diff --binary` captured from stdout) and the mock evaluator (gold
patch reverses cleanly). Over the 10 checked-in Terminal-Bench tasks the mocked run passes
2 (`react-lead-form`, `wal-recovery-ordering`); the other eight replay upstream `solve.sh`
scripts that need `uv`, apt packages or pip wheels absent here, and `shadow-relay`'s
environment setup script fails under Python 3.9. This is by design: the mocked bench proves
the pipeline, not the tasks. Three sandbox-profile bugs surfaced only through the mocked
bench (jevcode-home read deny, `--shared` clones needing the object cache readable, patch
files written where the post-run sandbox cannot read them), each fixed before any live run.

## 2026-09-19 Live 3-task slice: what changed before the full 30

First live slice (`bench/results/live-slice-3`): all six runs completed but none evaluated.
Two causes, both fixed: the evaluator's fresh clone hit the seatbelt `.git/hooks` write
deny (that rule protects the agent's workspace; bench infrastructure sandboxes now pass
`protectGit: false`), and jev-on made almost no progress because 14 of 25 steps in one run
were reviews on `plan_mismatch` with Jev confidence 0.00 (flat distributions), which the
bench counts as blocked. The risk mapping now uses the expected-level term only for the
harm dimensions (`destructive`, `irreversible`) and tail mass `P(level >= 3)` for the
alignment dimensions (`out_of_scope`, `plan_mismatch`), so an uncertain low-level
alignment answer is not a risk while a confident "contradicts the plan / repeats a failed
step" still blocks (DESIGN.md §5.3). Second slice (`live-slice-3b`): all six runs evaluated
by the local-venv evaluator; jev-on 3/3 passed (18–25 steps, $0.48–0.64 per run, Jev p50
225–233 ms, 2–5 blocked and 2–4 reviews each), jev-off 2/3 passed (25 steps each,
$0.69–0.78, never declared done). Sane, so the full 30 runs with `--spend-cap 45`,
`--task-spend-cap 1.5`, `--max-steps 25`, `--max-wall 20m`, concurrency 3.

## 2026-09-19 Full 30-task live run, first pass

`bench/results/live-swebench-30`: 60 runs, $24.20 total (jev-on $14.45, jev-off $9.75). The
15 sympy, pylint and requests tasks evaluated in both conditions: jev-on 5/15, jev-off 5/15.
Every django and pytest task failed environment setup in `pip install -e .`: the venv's pip
21 hands editable installs of pyproject-based projects to a nested `setup.py develop` that
fails with "No module named pip". The evaluator now upgrades pip, setuptools and wheel in
each venv before the spec install (the official images get a recent pip from conda), and
the 15 pairs are re-run with `bench --resume`.

Observations kept for the report: jev-on's five solved tasks all ran to the 25-step budget
with a correct patch on disk (the completion Noul never reached 0.85, because verification
rarely re-ran the whole detected test command after the last edit), while jev-off's five
stopped when the generator said done (15–20 steps); jev-on spent 97 blocked and 76 declined
reviews over 15 runs (reviews are declined in bench by design) and produced an empty patch in
6 runs; the combined tokens-per-step figure (74k vs 12k) is dominated by Jev's context Nouls
over up to 300 candidate files, which cost $0.78 in total, so the report now shows generator
and Jev token series separately.

## 2026-09-19 The "Ctrl-C stall" was two things

The interactive stall seen in demo 5 came from a step-2→3 boundary where a live Jev request
was in flight; the offline reproduction that seemed to confirm it was in fact a review box
waiting for an answer the driver never gave (14,285 renders of the box; wall time stopped it
cleanly). The genuine difference between the stalled process and every working
reproduction was `AbortSignal.any([engineSignal, AbortSignal.timeout(10 s)])` in the Jev
client: composite signals are held only weakly by their sources, and Node's garbage
collector under the TUI's render pressure can collect the dependent signal, after which an
abort never reaches the fetch. The client now uses a per-attempt `AbortController` linked
to the engine signal by an explicit listener and an explicit timer, both strongly held for
the attempt (the providers already used this pattern through `linkedAbort`).

## 2026-09-19 Root cause of the interactive stall, confirmed by trace

The previous entry's composite-signal theory was not the cause: the per-attempt controller
rewrite alone did not fix the stall (it is kept as hardening). Fine-grained tracing of every
await boundary showed the exact shape: the Jev response headers arrived, Ctrl-C landed in the
same millisecond, and the following body `reader.read()` never settled; undici had destroyed
the socket but left the reader-locked body stream's pending read unresolved. The providers'
SSE reader already raced each read against the abort signal (`readWithTimeout`), which is
why generator streams never stalled; the Jev client's body reader did not. `readBodyBounded`
now races every read against the attempt signal and cancels the reader on abort. A unit test
reproduces the shape (headers, then a body that never delivers) and asserts a prompt
`AbortError`; the live TUI reproduction (`--mock-generator`, live Jev, Ctrl-C mid-request)
now shuts down cleanly: step discarded per §9.1 rule 1, final checkpoint written, exit 130.

## 2026-09-20 Full 30-task live run, completed

`bench --resume` did not re-run the 15 setup failures because a zero-step `error` record
counted as final; `planPair` now re-queues records with `pass: null`, `evaluator: 'none'`,
`steps: 0`, `stopReason: 'error'` (infrastructure, not a verdict). With the pip upgrade in
place every django and pytest environment built and all 30 pairs completed: 60 runs, $46.25
total, 29 paired (one jev-off `invalid`). Paired result: jev-on 9/29 vs jev-off 10/29,
generator tokens per step 5,519 vs 6,767, `read` actions 83 vs 124, cost $24.21 vs $20.44,
208 blocks and 170 declined reviews on the jev-on side, Jev p50 237 ms. The full table and
reading are in `docs/STATUS.md`; the per-task records, summary, comparison and prediction
files are committed under `bench/results/live-swebench-30`.

## 2026-09-20 Pivot: a Jev-only mode with no generating LLM

The user asked for a coding agent that uses only Jev. Jev does not generate text, so the
mode is built as search: code proposes candidate edits (mutation operators, fix templates,
donor lines from the repository, test-derived values, grammar-guided synthesis by Choice),
Jev decides (localisation, ranking, progress, every existing loop decision), tests verify.
An anchor probe on 14 QuixBugs programs gave localisation top-1 13/14 and selection 14/14 for
$0.0009, so the plan is to measure each decision Jev must make (eight live probes), survey
search-based repair and guided synthesis, run a design competition on the measurements, and
only then implement `src/synth/`. The contract gained `EngineMode 'jev-only'`, a
`Synthesizer` interface (`synthesize(ctx) → Proposal`) that replaces the propose stage, a
`synth` event, and a `NullProvider` that throws if a generator is ever called; the bench's
`jev-only` condition asserts zero generator usage. Evaluation ladder: QuixBugs 40 →
hand-made multi-hunk tasks → the 30 SWE-bench instances. Brief: `docs/JEV-ONLY.md`.

## 2026-09-20 Environment side effect: pytest installed into the user-site Python

Two agents installed `pytest` 8.4.2 (and its dependencies) into
`~/Library/Python/3.9/lib/python/site-packages` with `python3 -m pip install --user pytest`
so that the SBFL tracer's real-pytest path and the QuixBugs/ladder runners could be verified
on the system interpreter. This is outside the repository. It is reversible with
`python3 -m pip uninstall pytest pluggy iniconfig exceptiongroup tomli`; the affected tests
skip cleanly when pytest is absent. Bench runs use their own venvs and do not depend on it.

## 2026-09-20 Jev-only architecture chosen: "Ledger + Sieve"

Eleven measurement files (eight live probes, two literature surveys, one coverage study, each
adversarially verified) and a naive prototype (QuixBugs 32/40, $0.035) fed a design competition:
four architects (repair-search, grammar-synthesis, test-driven decomposition, contrarian
"sieve") and three judges (reach, reliability/cost, long-horizon integration). All three judges
ranked test-driven decomposition first: a persistent ledger of sub-goals, one verified sub-goal
per outer step, partials held as a second base, regressions never kept, `patch → run`
alternation so the engine's completion Noul sees the oracle. Grafted from the contrarian: when
the whole candidate set at a site fits a measured run budget (median 3.8 s for a QuixBugs
first-order set; the gold is the only passer in 25/36), run it all and let the tests rank; Jev
ranks only when tests are expensive (SWE-bench modules 5–60 s). Grafted from repair-search:
insert gaps as first-class sites, a global verification queue, SBFL top-5 unioned into
localisation. Grafted from grammar-synthesis: the sketch Choice as a cheap reach round before
the token beam. Jev's irreplaceable jobs are where to look, which failing behaviour to attack
next, and which of several test-passing patches is genuine; everything else is code and
`python3`. The doc is `docs/JEV-ONLY-DESIGN.md`; the rejected alternatives and why are its §10.

## 2026-09-20 Jev-only on SWE-bench: no oracle, no search

The first `jev-only` SWE-bench run (30 instances, $0.83) produced empty patches everywhere in
under a minute each. Two causes, both structural: the workspace's test command was detected
as `pytest -q` although Django and sympy ship their own runners, and, decisive, an issue-driven
task has no failing test in the workspace, so the Ledger + Sieve design (goals = clusters of
failing tests) starts with an empty ledger. Decision: add an issue-derived oracle module
(`src/synth/oracle/`): extract reproduction snippets, REPL transcripts, tracebacks and
expected-vs-actual statements from the task text; Jev judges which block reproduces the bug and
which lines show expected and observed behaviour; code turns the snippet into a script with a
code-computed pass criterion and confirms it fails on the base commit; the search then treats
it as the failing behaviour, with the module's related test files as the regression oracle.
When no oracle can be extracted, the agent localises from the issue text (measured: gold file
#1 on 23/30), enumerates and Jev-ranks candidates, checks regressions only, and commits its
best guess once, labelled as such in the evidence. The oracle's validity is measured first
(fails on base, passes on gold) before the integration.

## 2026-09-20 Q7 `edit_class` examples were QuixBugs gold fixes; replaced and re-measured

The audit (`experiments/results/jev-only-audit.md` §3.2) found that the Q7 option descriptions in
`src/synth/sketch/questions.ts` and one Q5 example in `src/synth/beam/state.ts` quoted ten QuixBugs
gold fixes verbatim (`enumerate(counts)`, `while lo < hi`, `gcd(b, a % b)`, `perm[i] < perm[j]`, …),
so the measured Q7 figure (top-1 28–29/40) had the answers to ten of the forty programs in the
prompt. Decision: every example is now invented generic Python from no benchmark (definition plus
at least two examples per option, REPORT.md form; `insert_new_line` gained two examples it never
had), and `test/unit/synth/sketch/no-benchmark-leakage.test.ts` builds a corpus at test time from
`bench/data` (QuixBugs `correct/` and `programs/` lines, `index.json` buggy/fixed lines and the
fixed fragment, ladder gold-only lines, SWE-bench gold `+` lines, Terminal-Bench gold files;
whitespace-normalised, ≥ 12 chars, trailing colon optional) and asserts none of it appears in the
question texts those two files produce; it also asserts the old wording would have been flagged.
Re-measured with the same probe (`experiments/inspect/q7-clean-probe.mts`, a copy of
`experiments/grammar-synthesis/sketch-probe.mts` that imports the wording from `src`): top-1
**24/40** in both repeats, top-2 **34–35/40** ($0.0078 each), against 28–29 / 35–36 before. The
drop is on the quoted programs (8/10 → 5/10 top-1 in both repeats; the other thirty 20–21 → 19).
Q7 stays what it was designed as, a soft source-order prior that cannot produce or drop a
candidate; the header of `sketch/questions.ts` and `TOP_EDIT_CLASSES` carry the clean numbers.
Also from the audit's §5 gap: `src/bench/runner.ts` now writes every `tasks.jsonl` line through
`serialiseRedacted` (every string leaf passes the run's redact function; `reason` carries evaluator
output tails and error messages), tested in `test/unit/bench/runner-redact.test.ts`.

## 2026-09-20 Q17 progress questions are code-computed facts; scheduled for deletion

`experiments/results/probe-progress-judgment.md` shows the three progress Nouls (240/240) and the
`closeness` Score (230/240) are a pure function of the pass counts the harness already computes
(`src/synth/verify/progress.ts`), so by the design rule "never ask Jev to count or compute" they
should not be asked. The audit called `progressQuestions` dead code; that is not quite right: the
consistency check it was documented as (a `synth` event on a confident disagreement, "≥ 3
disagreements flags the runner parser") was never built and nothing reads
`ProgressJudgment.disagreements`/`unsure`, but `src/synth/search/bases.ts:270-323 closenessOf`
calls `verify.judgeProgress` when two partials tie on `passed` (or a challenger ties the incumbent)
and uses the Score's E[level] as the tiebreak, with `ask` supplied from `guard.ts:739-741`. Greps
of every `jev.jsonl` of `jev-only-quixbugs-1`, `jev-only-quixbugs-3` and `jev-only-ladder-4` show
it was asked 0 times. A tie is between programs with identical counts, so the tiebreak is Jev
noise on identical facts. Decision: delete Q17 and the `closeness` cache, and break `passed` ties
in code (list order, as `pickNextFailingTest` does). Not done in this change because the callers
live in files owned by other agents; the exact deletion, for their owners:
`src/synth/verify/questions.ts:24` (`ProgressQuestionId`), `:60-97` (`progressQuestions`,
`codeVerdicts`), `:99-135` (`expectedLevel`, `judgeProgress`) and the `noul`/`score` imports;
`src/synth/verify/index.ts:13,24,30,34,40` (re-exports), `:58-60` (`Verifier.progressQuestions`,
`progressState`, `judgeProgress`), `:153`; `src/synth/verify/types.ts` `ProgressJudgment` and
`closenessExpected`; `src/synth/search/bases.ts:7,15` (header), `:25` (import), `:99-100,118`
(`GuardState.closeness`), `:210-…` (`HoldOptions.ask/stage/subject`), `:266-282` (`closenessOf`),
`:286,301-310,313-323,326-328` (tie handling in `holdBestPartial`), `:411`; `guard.ts:739-741`
(`holdOpts`); tests `test/unit/synth/verify/{questions,index}.test.ts`,
`test/unit/synth/search/bases.test.ts`, `test/live/synth-verify.live.test.ts`. The design table
row (`docs/JEV-ONLY-DESIGN.md` §2.7 Q17) now states the implemented behaviour; §2.2's pseudo-code
comment, §4.4, §4.5's cost row and §6's module table still mention the `closeness` tiebreak and
should be updated with the deletion.

## 2026-09-20 In-sample thresholds and 0.5 cuts disclosed; QuixBugs rung-1a is "36/40 with these programs in-sample"

`docs/JEV-ONLY-DESIGN.md` §7 now carries a disclosure paragraph. Constants set or moved after a
live run on a named program, so every score depending on them is in-sample for that program
(audit §4.3): `src/synth/search/guard.ts:81 SUSPECT_ESCAPE_MIN` 0.9 → 0.8 (`wrap`);
`src/synth/search/sites.ts:101 Q6_FALLBACK_MIN_P` 0.2 (`reverse_linked_list`); the lone-passer
hold/vouch rules `guard.ts:94-105` (`detect_cycle`); `src/synth/search/perturb.ts` (`detect_cycle`,
`wrap`); the skew-aware per-case timeout `src/synth/search/budget.ts:60-65` and load scaling
`:74-75` (`longest_common_subsequence`, `sqrt`, `bitcount`, run-3 contention) and `SIEVE_KEEP_FACTOR`
(`shunting_yard`); the insertion-site anchors `src/synth/search/sites.ts:12-32`,
`src/synth/localize/sites.ts:64-140` (`shunting_yard`, `reverse_linked_list`, `depth_first_search`,
`wrap`); the vocabulary pre-check's import-path exemption `src/synth/sieve/queue.ts:171-178`
(ladder `tagcloud`). No constant was changed here (the files belong to other agents); the claim
is reported as in-sample instead. The 0.5 cuts on Jev probabilities the audit found, with their
nature: **decisions** (a borderline threshold; REPORT §6 measured ±0.02 noise at 0.5, so each will
flip run to run and must be reported as such): `src/synth/rank/index.ts:70 NOUL_ABSENT_THRESHOLD`
(`noulsFlagAbsent` switches the candidate source when max Noul < 0.5),
`src/synth/oracle/questions.ts:30 PICK_THRESHOLD` (a block is taken as the reproduction /
expected output only at p ≥ 0.5; mitigated by code checking the block fails on the base commit),
`src/loop/stages/context.ts:16 CONTEXT_SELECT_THRESHOLD` (a file enters the context iff p ≥ 0.5),
`src/loop/stages/choose.ts:10 PAIRED_NOUL_FLOOR` (the Choice argmax is accepted iff its paired
Noul ≥ 0.5, else overridden or the fallback). **Ordering-only** (fine): `src/synth/search/subgoal.ts:56
INSERT_FIRST_MIN_P` and `src/synth/search/sites.ts:87 Q7_INSERT_NEW_LINE_FIRST` (put templates,
donors and insert sites first; nothing is dropped), `src/synth/sketch/questions.ts:47
LOW_CONFIDENCE_P_TOP` (widens K from 3 to 5; never a gate). Per-program correctness for run 3 is now
code-generated (`experiments/inspect/quixbugs-verdicts.mts` → `bench/results/jev-only-quixbugs-3/verdicts.md`):
gold-identical 27, equivalent 5, overfit 2, unverified 2, miss 4, i.e. 32/40 verified correct;
"34 correct by inspection" adds the two unverified graph programs on the inspector's reasoning.
The wording "hidden test/evaluator" in `experiments/results/jev-only-rungs-1-2.md` (three lines)
now reads "the evaluator's reference cases (the same cases the workspace exposes; there is no
hidden suite)".


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

## 2026-09-20 Q17 deleted

Executes "Q17 progress questions are code-computed facts; scheduled for deletion" (above). Removed: `src/synth/verify/questions.ts` `ProgressQuestionId`, `UNSURE_LOW`, `UNSURE_HIGH`, `ProgressStateOptions`, `progressState`, `progressQuestions` (the three Noul texts and the five-level `closeness` Score text are gone from the code), `codeVerdicts`, `expectedLevel`, `judgeProgress` and the `noul`/`score` imports (`STATE_FAILURES_BOUND` stays: `src/synth/search/goals.ts` derives `GOAL_FAILURES_BOUND` from it); `src/synth/verify/index.ts` their re-exports and `Verifier.progressQuestions`/`progressState`/`judgeProgress`; `src/synth/verify/types.ts` `ProgressJudgment`; `src/synth/search/bases.ts` `GuardState.closeness`, `MAX_CLOSENESS_REQUESTS`, `HoldOptions`, `closenessOf` and `HoldResult.requests` — `holdBestPartial(mem, partials, goal)` is now synchronous and takes no Jev; `src/synth/search/guard.ts` `decide` no longer builds `holdOpts` (`DecideOptions` declares `stage`/`subject` itself). A tie on `passed` between partials (several in one batch, or a challenger against the incumbent) is the code rule `compareTieKeys` over `TieKey { newlyFailing, diffChars }`: fewer newly-failing tests first (0 for every partial by construction, since `isPartial` rejects a regression; kept so the rule stays complete if that definition moves), then the smaller diff on the COMMITTED workspace (`diffSize`: fewer changed `+`/`-` lines, then fewer characters in them — context lines are excluded because they depend on where the edit sits; `appliedOnCommitted`, so a partial on the improved base is measured by the cumulative edit it would commit), then the earlier one — list order within a batch, the incumbent (held first) against a later challenger. Every input is a fact the harness computes before the decision; no Jev request is spent on a tie. Tests: `test/unit/synth/search/bases.test.ts` ("a tie on passed against the incumbent is broken in code…", "several tied challengers in one batch…", "the tie key…"); `test/unit/synth/verify/{questions,index}.test.ts` and `test/live/synth-verify.live.test.ts` lost their Q17 cases (the live check is now one request, the attack-first Choice). Docs: `docs/JEV-ONLY-DESIGN.md` §2.2 pseudo-code, the §2.7 Q17 row, §4.4 and the §6 `bases.ts` row state the code rule. Left for their owners: the "Q17 consistency" row of §4.5's cost table and `docs/JEV-ONLY.md` §"open" line 236, which still describe Q17 as scheduled.

## 2026-09-20 Repository run cap follows the measured oracle; a budget-hit step that reached a new site is progress

The design's repository-class cap of 16 runs per step (`docs/JEV-ONLY-DESIGN.md` §4.3: 12 subset + 3
full + 1 baseline) was sized for the case where every candidate costs a full suite. With the issue
oracle the goal-subset run is the reproduction script (sympy-15345: 2.06 s against an 18.6 s scoped
`bin/test`; Django 0.9–2.8 s against 5–100 s of `runtests.py`) and only the ≤ 5 passers pay the scoped
suite, so on `bench/results/jev-only-swebench-2-oracle` the cap let 16 of 727 enumerated candidates run
per step on `sympy__sympy-15345`, 15 of them at the first site, and the rule "2 consecutive budget-hit
steps" parked the goal with sites 3–12 never visited. Decision (commit `4d5eec2`): the run count is
derived from the measured oracle, `runs = floor((testWall − 5 × t_run(fullSuite)) / t_run(goalSubset))
× lanes`, bounded to [16, 160] (`src/synth/search/budget.ts repositoryRunsPerStep`; sympy-15345 gets 108,
a Django instance with a 100 s scope 140; the QuixBugs class keeps 1,500), and in RANK mode the take per
site is its share of the runs left. A budget-hit step counts toward the stagnation park only when it
tested nothing new — no fresh candidate at a site no earlier step of the goal had tested
(`src/synth/search/goals.ts noteBudgetHit(goal, progress)`); a step that reached a new site is the same
search continued and counts neither toward the 2 nor toward "3 searches without a commit". A hard cap of
4 consecutive budget-hit steps parks whatever they tested (`MAX_BUDGET_HIT_STEPS`), because each such
step is one more goal-subset `run` with the same signature and the loop detector trips at 3. Both rules
are dated paragraphs in `docs/JEV-ONLY-DESIGN.md` §4.3 and §5.3. Not yet measured on the full 30 (rung 3
in progress).

## 2026-09-20 Reproductions run under a fixed hash seed and are confirmed by a second run

`django__django-15315`'s reproduction (`assert f in d`, whose outcome depends on `Field.__hash__`) flipped verdict
between processes because CPython randomises `str` hashes per process, so a lane verdict was not a fact
of the code. Decision (commit `4d5eec2`): every reproduction — the base run, the lanes and the workspace
re-run — executes under `PYTHONHASHSEED=0` (`src/synth/oracle/runner.ts REPRO_HASH_SEED`), and a
passing verdict is confirmed by a second run before it counts (`src/synth/oracle/search.ts`; the note
reads `confirmed by a second run in N ms`, or `confirmation run did not report (...); first verdict kept`
when the second run timed out or errored). The behaviour probe of the guard already ran under the same
seed (`src/synth/search/perturb.ts`).

## 2026-09-20 A lone passer may be held within a step: suspicion signals and a Q16 advisory

Design §2.6 said "1 plausible → commit" and that a lone passer is never withheld on a Noul threshold.
In QuixBugs run 3 both overfits (`detect_cycle`, `wrap`) were the first lone passer of a step, committed
while the site list still had the gold's site ahead; both golds were enumerated by more than one source
(`experiments/results/jev-only-rungs-1-2.md` §13). Decision (commit `3d0d803`, `src/synth/search/guard.ts`,
`bases.ts`, new `perturb.ts`): (a) on a SIEVE oracle a clean lone passer waits until its site's seed
sources have run; (b) a lone passer carrying a code-computed structural signal (`deletes_statement`,
`duplicates_block`, `guards_other_variable`, `dead_guard`) gets one Q16 Noul as an advisory — held when
p < 0.3 with one signal, committed at once only when p ≥ 0.7 with two or more; (c) every hold lives
inside a budget reserve (15 s / 16 runs / 1 request) and is released at the step end or on a budget
exit, never past the step, so a genuine fix is delayed, never withheld. The behaviour probe derives
inputs from the visible tests (JSON cases, pytest `Node` chains) and runs on the sieve's lanes, so
≥ 2 passers cluster by behaviour rather than by the pass vector alone; `SUSPECT_ESCAPE_MIN` moved
0.9 → 0.8 after `wrap`'s all-overfit arbitration answered 0.89. Live: `detect_cycle` repaired
(correct on 48 linked lists, not gold-identical), `depth_first_search` gold-identical 3/3; `wrap` needed
the loop-exit gap of the next entry. The constants are in-sample for those programs (design §7).

## 2026-09-20 Partials survive a park; pairs run before it; a held passer commits on a budget exit; `change_approach` reopens every parked goal

The ladder-4 dissection (`experiments/results/jev-only-ladder-4-analysis.md` §1) showed `account`'s two
gold half-fixes found, ranked first (p 0.97 / 0.98), classified `partial` because frame clustering
merged two bugs into one goal, and dropped when the goal parked (`forgetGoal` on park; `pairsOfPartials`
starved by the budget; `change_approach` reopening only the newest parked goal). Decision (commit
`1f7611e`, `src/synth/search/{bases,subgoal,index,directive,sites}.ts`, `sieve/runner.ts`): `forgetHeld`
is the park-time form that keeps the remembered partials, persisted ≤ 4 per goal in `synthState`; the
pairs run inside a 15 s / 16-run reserve before the batch that would spend it, at step start, on every
budget exit and before a park; a passer the guard still holds is committed before any park; a site's
seed sources run as one SIEVE batch decided once; an all-killed batch under load is re-queued once with a
load-scaled lane timeout; WIDENED sites are evidence-ordered and the gap a loop exits into is an
anchor's third gap. Live: `account` 3/3 hunks gold-identical in 2/2 runs, `wrap` gold-identical, the
five regression programs unchanged. Still open after this change: a *lone* partial — a goal whose first
correct fix passes only some of its tests — is never committed, which is the dominant defect of the
long tier (`masked`, `long_chain`, `shared_frame`, two `six_hunks` goals); the fix in flight commits the
best regression-free partial as a progress commit and lets the next baseline re-cluster the rest.

## 2026-09-20 Loop-side rules for jev-only: verified completion, verification run, novel verified patch, failing-set signatures, no-op `done` carries the run

Round 4 of the ladder solved 11/12 but spent 58 of 137 steps on refused proposals, 30 of them two
mechanisms: the engine's own green verification `run` and the `done` after it landed in the review band
on spread probability mass (bench has no reviewer, so review = decline), and a declined proposal was then
read back from `recent` as "a step that already failed" (`jev-only-ladder-4-analysis.md` §2–§4).
Decisions, all code rules over facts the harness knows (`workspace.testsCurrent`,
`lastTestRun.allPassed`, the detected test command, the outcome status, the parsed failing set), with
Jev's answers kept in the record: (1) a `done` with an empty `plan.remaining` after the engine's own
green, current run is not refused by the risk stage (`src/loop/stages/risk.ts completionVerifiedByRun`;
the completion Noul still decides the stop); (2) one plain invocation of the test command with harm
dimensions at expected level ≤ 1 never lands in the review band on alignment mass
(`isVerificationRun`); (3) refused proposals are signed by the proposal alone, a trip resets only the
tripped signature, `intent:unresolved` is emitted only when the fallback differs from Jev's argmax, and
a second `gather_context` for the same refused `done:` is `stop_and_report`
(`src/loop/loopdetect.ts`, `engine.ts repeatedGatherContextExit`); (4) `fail:` is the sorted set of
failing test ids, not the last output line, so progressing runs (4 → 2 → 1 failing) no longer read as
the same failure three times (`testFailureIdentity`; `docs/DESIGN.md` §6 dated paragraph); (5) the judge
state of a no-op `done` carries the last run's parsed counts and a `lastRun` block
(`src/loop/state.ts doneExecutedJson`, `stages/complete.ts`); (6) a change proposal whose evidence is
verified with no newly-failing tests and whose content differs from every applied earlier patch is
gated by harm alone (`novelVerifiedPatch`, `PatchHistory`, `proposal.priorPatches` in the risk state).
Commits `a030381` (1–3) and `42d9f09` (4–6). Measured: refusals 58 → 17 in round 5; on
`grades`/`shipping`/`table` 47 → 20 → 19 steps with loop replans 8 → 0 → 0
(`bench/results/jev-only-ladder-5`, `-6-done`, `-6-done-item3`); on `django__django-15315` six refusals
of four distinct verified patches → 0 (the task still fails for an oracle-side reason).

## 2026-09-20 Leakage test and task-log redaction are recorded above; the leakage guard now covers every new source

The leakage test on question wordings (`test/unit/synth/sketch/no-benchmark-leakage.test.ts`, a corpus
built at test time from every benchmark's gold under `bench/data`) and the redaction of every
`tasks.jsonl` line (`src/bench/runner.ts serialiseRedacted`) are recorded in the entry "Q7 `edit_class`
examples were QuixBugs gold fixes" above and are not repeated here. Added with the introspection and
history sources (`experiments/results/jev-only-rungs-1-2.md` §18.1): the same corpus is asserted against
the `introspect` template family's example wordings and against the module texts of the new sources
(`test/unit/synth/templates/introspect.test.ts`), so a source added for a named SWE-bench instance
cannot carry that instance's gold text. Q7 re-measured with clean wordings is top-1 24/40, top-2
34–35/40, and that is the figure cited.

## 2026-09-20 Repository mode: the best-guess commit is labelled unverified and happens once per run

The SWE-bench decision above planned a regression-only best guess when no oracle can be extracted
(21 of 30 instances). What landed (commit `df0855c`): the best-guess goal has its own synthetic test id
(`issue::…`, `src/synth/oracle/search.ts`), its search ranks candidates and checks the scoped regression
suite only, its `patch` proposal's goal text reads `apply best-guess fix (no reproduction oracle;
unverified): <source>/<op> at <site>; <regression counts>` and its `openProblems` carries
`no reproduction oracle: best-guess fix, unverified` (`src/synth/search/proposal.ts BEST_GUESS_NOTE`), so
the risk stage and the completion Noul read an honest claim; after its one commit (or the engine's
rejection of it) the goal parks with the reason `best-guess fix committed, unverified (no reproduction
oracle)` and re-opens only for one re-proposal (`search/index.ts`). No best-guess pass has been recorded.

## 2026-09-20 The long tier measures the horizon, not the reach

Eight tasks (`bench/data/ladder`, tier `long`, ids 13–20; commit `7ea40b2`) test whether the ledger can
chain many verified sub-goals: five independent bugs, masked failures that re-cluster, two bugs raising at
the same helper line, a coordinated two-file pair, an import plus a None-guard, a regression trap, six
bugs with complementary partials, a six-stage pipeline. Every planted line is a one-line replace or the
guard template's insert, and a probe confirms 34/34 are enumerated by a code source, so a miss measures
the horizon and never the vocabulary (six lines of the first authoring were out of reach and were
re-authored before run 1b; those run-1 misses are marked as authoring). `meta.json` gains `tier` and
`expected_failing` (verified against a real pytest run by `check.py` and
`test/unit/bench/ladder-long.test.ts`); the loader orders short tier then long so `--tasks 12` still
selects the original twelve; the long-tier `pytest.ini` carries no `-q` because the engine's own `-q`
would make it `-qq` and drop the counts line (the `long_chain` first run never registered its baseline
for exactly this reason). Results: 2/8, 1/4 of the re-authored four, 2/8 on `d610d75`
(`bench/results/jev-only-ladder-long-{1,1b,2}`, ≈ $0.18–0.27 each); the dominant defect is the lone
partial (previous entry).

## 2026-09-20 Re-baseline file cache and an LRU of run memories

The nine-instance SWE-bench run (`bench/results/jev-only-swebench-2-oracle`) died with
`FATAL ERROR: Reached heap limit` at 4 GB on two Django tasks; the full-30 budget round died at 8 GB
after eight records (commit `43ce244`). Measured (`experiments/results/jev-only-rungs-1-2.md` §20.2):
one analysed Django corpus is ≈ 149 MB, and every re-baseline of every Django step analysed 858 files
again while older copies were still reachable, and every finished run's memory stayed in the registry
for the life of the bench process. Decision (commit `5486f7a`, `src/synth/search/memory.ts`,
`search/index.ts loadPythonFiles`): a per-run file cache hands back the same `SourceFile` object for
every unchanged file (so the identity-keyed caches in `sites.ts` / `composite.ts` survive) and analyses
only changed text — a re-baseline costs +3 MB in 31 ms instead of +148 MB in 380 ms — and the run
registry is an LRU of four memories (`MEMORIES_MAX`), dropping the least recently used with its run
facts. Repository benches are launched with `NODE_OPTIONS=--max-old-space-size=8192` and
`--concurrency 2` regardless.

## 2026-09-20 Rung 3 is measured on a frozen worktree

Every earlier live number was taken on a working tree that other sessions were editing (the round-5 and
round-6 ladder tables state this confound). Decision: the rung-1a repeats and long-tier run 2 ran from
`.claude/worktrees/bench-clean` at `d610d75` (`node_modules` symlinked, `.env` from the main checkout),
and the SWE-bench full-30 run of rung 3 runs from `.claude/worktrees/swe-clean` at `5486f7a` (the
wiring commit; process cwd confirmed with `lsof`), writing its records to the main checkout's
`bench/results/jev-only-swebench-3` with `NODE_OPTIONS=--max-old-space-size=8192 --concurrency 2
--max-steps 25 --max-wall 25m --spend-cap 4 --task-spend-cap 0.4`. Nothing in that worktree changes
while the run lasts, so the number, when it lands, is attributable to one commit. Its result goes to
`experiments/results/jev-only-rungs-1-2.md` §21 and to the `RUNG3` placeholders in `README.md` and
`docs/JEV-ONLY-DESIGN.md` §7.

## 2026-09-21 Report solved and correct separately

The independent verification of the final-tree numbers (rungs report §26.5) found two cases where a
task counted as repaired is wrong: QuixBugs `topological_ordering` passes its three visible graph
fixtures but drops the `issuperset(incoming_nodes)` check and is invalid on 462/1000 random DAGs (the
verdict script labelled it `unverified`, and "0 overfit" therefore hid it), and the ladder's `grades`
(`letter_grade(89.5)` → `'A'`) and `textstats` (`ngrams` raises on a tuple, mutates the caller's
list) pass their whole suites while behaving differently from gold, with no ladder correctness check
at all. Both suites have no hidden tests — the evaluator runs the cases the workspace exposes, which
are also the sieve's fitness function — so the evaluator count measures what the search optimised,
not whether the program is right.

Decision: every headline carries two numbers, never one standing for the other. **Solved** is the
exposed / evaluator suite: QuixBugs reference cases, the ladder's `tests/`, the SWE-bench local-venv
FAIL_TO_PASS + PASS_TO_PASS (labelled unofficial). **Correct** is a check the search did not see:
the verdict script's gold-identical or perturbation-equivalent classes, or a differential test
against gold on inputs outside the suite. `unverified` is reported as unverified, never folded into
correct; a "0 overfit" is scoped to the programs the probe can perturb; hunk counts use one rule
(gold-identical by strict `diff -U0`, with equivalents in parentheses where they differ); SWE-bench
passes carry no correctness claim beyond the tests they pass until graded officially and compared
with the upstream fix. Rows are also marked with how many runs on that tree they rest on.

Consequences: the ladder gets a verdict pass (`experiments/inspect/ladder-verdicts.mts`, in progress:
gold vs patched on hand-written inputs per task); the nine pytest-fixture QuixBugs programs need
graph perturbations or a held-out DAG set in `quixbugs-verdicts.mts` so `topological_ordering`
classifies as overfit rather than unverified; run records should store the engine's git sha (open —
today the tree identity is inferred from `run.json`'s workspace path and timing). Rejected: keep
reporting the evaluator count alone because it is what the benchmarks call "resolved" — true for
SWE-bench, where the tests are withheld, and false for the two suites whose tests the search reads.
