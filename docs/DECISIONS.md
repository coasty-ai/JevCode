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
