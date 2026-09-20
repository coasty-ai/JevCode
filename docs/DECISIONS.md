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
  that clones the repo at `base_commit`, builds a `venv` with the instance's install
  command, applies `test_patch`, and runs `FAIL_TO_PASS` plus `PASS_TO_PASS`. Each task
  record states which evaluator produced `pass` (`local-venv`, `docker`, or `none`).
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

The CLI is bundled by esbuild into one ESM file with Ink and React inside. Two fixes
were needed: alias Ink's optional `react-devtools-core` import to an empty stub, and
define `process.env.DEV` as `"false"` so the reconciler's devtools branch is dead code.
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
probes; `sandbox-exec` with a `(deny default)` SBPL profile on macOS behind explicit
modes; a cold-start perf baseline in `npm run perf`. Also adopted from harness research
(`04` §3): bounded format-error re-queries, cost cap alongside step cap, hashed tool-call
loop detection with a judge (Jev), confirm-before-finish as a decision node, and
execution-based test evidence feeding the judge. Rejected: a Rust rewrite, Bun, Node
`--build-snapshot`, forking Ink, Docker as default sandbox, alternate-screen by default,
startup network probes, and a SEA binary.
