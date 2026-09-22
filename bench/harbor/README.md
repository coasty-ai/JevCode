# Running JevCode under Harbor (Terminal-Bench 4.0)

This directory is reserved for the Harbor adapter that lets JevCode be evaluated the way the official Terminal-Bench 4.0 leaderboard runs agents: inside Harbor-managed Linux sandboxes, with Harbor's verifier producing the reward. The Python adapter itself is not written yet; this README fixes the design so it can be written without re-research. All Harbor facts below come from `docs/research/03-terminal-bench.md` (fetched 2026-09-19) and the primary URLs cited there.

## Why a Harbor adapter at all

- The local runner in `bench/data/terminal-bench/` (10 path-rewritten tasks, Python 3.9, no containers) can only ever produce "plausibly solved" numbers on a subset. Leaderboard-comparable numbers need Harbor + the published dataset `terminal-bench/terminal-bench@4.0.0` (66 tasks, 5 attempts each = 330 trials) on a Linux sandbox provider.
- Harbor is the official harness: `harbor` on PyPI, **0.23.0** (2026-09-12), `requires_python >= 3.12` (the reference machine has 3.9, so install a 3.12+ first: `uv python install 3.12` or Homebrew). Install: `uv tool install 'harbor[modal]'` or `pip install 'harbor[modal,daytona]'` (TB `tasks/README.md`).
- Sandboxes: Docker is the default `-e docker` and is not installed here. Options on the reference machine: `-e apple-container` (Apple's `container` CLI, macOS 26 + arm64 — both true here; single-container tasks only, so 14 of 66 TB tasks are excluded), `-e podman` (Linux VM), or the providers the TB maintainers use: `-e modal` / `-e daytona` (needed for the 3 GPU and 11 multi-container tasks). See research §5.

## Which Harbor base class

Harbor has two agent styles (docs `agents/index.mdx`): **external agents** subclass `harbor.agents.base.BaseAgent` and drive the sandbox from the host through `environment.exec(...)`; **installed agents** subclass `harbor.agents.installed.base.BaseInstalledAgent`, get installed *into* the task container and run headless there. JevCode is a Node CLI that must see `/app` as its workspace and run its own tool loop, so it is an **installed agent**, like Harbor's built-in `claude-code`, `codex` and `gemini-cli` wrappers.

Base class source (fetched 2026-09-19): https://raw.githubusercontent.com/harbor-framework/harbor/main/src/harbor/agents/installed/base.py (repo view: https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/installed/base.py). Parent: https://raw.githubusercontent.com/harbor-framework/harbor/main/src/harbor/agents/base.py. Node helper: https://raw.githubusercontent.com/harbor-framework/harbor/main/src/harbor/agents/installed/node_install.py.

Members the adapter must implement or may use (names verbatim from those files):

| member | kind | what JevCode does with it |
|---|---|---|
| `@staticmethod name() -> str` | abstract (`BaseAgent`) | return `"jevcode"` |
| `version() -> str \| None` | `BaseAgent` | return the `package.json` version (`0.1.0`) |
| `async install(self, environment: BaseEnvironment) -> None` | abstract (`BaseInstalledAgent`) | install Node 22 + JevCode into the container (below) |
| `@with_prompt_template async run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None` | abstract (`BaseAgent`), decorator from `harbor.agents.installed.base` | run `jevcode run --plain ...` with the instruction |
| `populate_context_post_run(self, context: AgentContext) -> None` | optional hook | fill token/cost fields from JevCode's run logs |
| `exec_as_root(environment, command=...)`, `exec_as_agent(environment, command=...)` | helpers | "handle logging, environment variable merging, `set -o pipefail`, and error handling" |
| `SYSTEM_PACKAGES: list[str]` + `ensure_system_dependencies()` | declarative | `["curl", "ca-certificates", "git"]` — needed by the nvm installer and by tasks that expect `git` |
| `ENV_VARS: list[EnvVar]`, `CLI_FLAGS: list[CliFlag]` | declarative | declare `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `JEV_API_KEY`, `JEV_BASE_URL`, `JEVCODE_PROVIDER`, `JEVCODE_MODEL`, `JEVCODE_SPEND_CAP_USD`, `JEVCODE_MAX_STEPS`, `JEVCODE_MAX_WALL` so `--ae KEY=VALUE` passes them through |
| `ERROR_PATTERNS: list[ErrorPattern]` | declarative | regexes over JevCode's plain-renderer output mapped to Harbor's `ApiRateLimitError`, `ContextWindowExceededError`, `AgentAuthenticationError` so retries (`--max-retries`) trigger correctly |
| `options_model: ClassVar[type[AgentOptions] \| None]` | `BaseAgent` | a `JevCodeAgentOptions(AgentOptions)` with `max_steps`, `spend_cap_usd`, `max_wall`, `provider`; unknown `--ak` keys then fail at preflight. Caveat from research §7: this validation is listed under "Unreleased" in Harbor's CHANGELOG and may post-date the 0.23.0 wheel — check after installing. |
| `logs_dir: Path`, `model_name: str` | attributes set by Harbor | `logs_dir` is the host directory mirrored at `/logs/agent` in the container; `model_name` is the `-m` value (LiteLLM style `provider/model`) |
| `harbor.agents.installed.node_install.nvm_node_install_snippet(node_major)` | helper | returns a shell snippet that installs nvm + Node `<major>` and leaves nvm loaded so `npm install -g ...` can be chained in the same command |

`BaseEnvironment` (https://raw.githubusercontent.com/harbor-framework/harbor/main/src/harbor/environments/base.py) also offers `upload_file`, `upload_dir`, `download_file`, `download_dir` and `exec(command, cwd=None, env=None, timeout_sec=None, user=None) -> ExecResult{stdout, stderr, return_code}`.

Harbor's call order per trial (research §4): build/start the environment → `setup(environment)` (which for installed agents calls `install()`) → `run(instruction, environment, context)` with `instruction` = the full text of `instruction.md` → artifact collection → verifier. Nothing is injected into the container for you: the instruction reaches JevCode only because `run()` passes it on the command line.

## Wiring plan (`bench/harbor/jevcode_agent.py`)

```
bench/harbor/
├── README.md              this file
├── __init__.py            (empty; makes `bench.harbor` importable)
└── jevcode_agent.py       class JevCodeAgent(BaseInstalledAgent)   <- to be written
```

Import path for `harbor run -a`: `bench.harbor.jevcode_agent:JevCodeAgent`, run from the repo root with `PYTHONPATH=$PWD` (Harbor imports the module inside its own virtualenv; the adapter must only import `harbor.*` and the standard library).

### `install()` — Node 22 + JevCode inside the container

Two supported routes; pick with an option (`--ak install_mode=bundle|npm`, default `bundle`):

1. **bundle** (no registry dependency; what "copy the bundle" means): on the host, `npm run build && npm pack` produces `jevcode-0.1.0.tgz` containing `bin/jevcode.js`, `dist/jevcode.mjs` and `package.json`. In `install()`:
   ```python
   await self.exec_as_root(environment, command="apt-get update && apt-get install -y curl ca-certificates git")  # or SYSTEM_PACKAGES + ensure_system_dependencies()
   await environment.upload_file(local_tgz, "/tmp/jevcode.tgz")
   await self.exec_as_root(environment, command=nvm_node_install_snippet(22) + " && npm install -g /tmp/jevcode.tgz && ln -sf \"$(command -v jevcode)\" /usr/local/bin/jevcode")
   ```
   The `ln -sf` matters: nvm puts `jevcode` under `~/.nvm/versions/node/v22.x/bin`, which is on `PATH` only in the shell that sourced nvm; `exec_as_agent` starts fresh shells (and may run as a different user), so expose a fixed path.
2. **npm**: same, with `npm install -g jevcode@<version>` — only once the package is published.

`nvm_node_install_snippet(22)` matches the repo's `.nvmrc`/`engines` (`>=22.12.0 <27`); TB images are Debian/Ubuntu/python/node based, all of which the nvm installer supports. Images that already ship Node (`node:20-slim` in `react-lead-form`) still get Node 22 via nvm so JevCode's engine range is met without touching the task's own toolchain.

### `run()` — the exact command

```python
import shlex
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template

class JevCodeAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "jevcode"

    @with_prompt_template
    async def run(self, instruction, environment, context) -> None:
        provider, _, model = (self.model_name or "anthropic/claude-sonnet-5").partition("/")
        cmd = (
            "cd /app && "
            "JEVCODE_HOME=/logs/agent/jevcode "
            f"JEVCODE_PROVIDER={shlex.quote(provider)} JEVCODE_MODEL={shlex.quote(model)} "
            "jevcode run --plain --workspace /app "
            f"--task {shlex.quote(instruction)} "
            f"--max-wall {shlex.quote(self.max_wall)} --max-steps {self.max_steps} "
            f"--spend-cap {self.spend_cap_usd} "
            "2>&1 | tee -a /logs/agent/jevcode.log"
        )
        await self.exec_as_agent(environment, command=cmd)
```

Points that are fixed by JevCode's own design (`docs/DESIGN.md` §2 config table, §8, §9, §11):

- `--plain` selects `tui/plain.ts` (also chosen automatically when `stdout.isTTY` is false, which it is under `exec`); no Ink frames in the log.
- `--workspace /app` is where every TB task puts its files and where `artifacts` are collected from; JevCode's path guard confines writes to it.
- `--task` receives the *whole* `instruction.md` (2–6 KB) via `shlex.quote`; TB instructions reference `/app/...` paths literally, which is correct inside the container.
- `JEVCODE_HOME=/logs/agent/jevcode` redirects `~/.jevcode/runs/<run-id>/` (`run.json`, `state.json`, `steps.jsonl`, `decisions.jsonl`, `generator.jsonl`, `transcript.log`) into the directory Harbor mirrors back to the host as `jobs/<job>/<trial>/agent/`, so trajectories survive the container.
- `-m provider/model` (Harbor's LiteLLM-style model id) is split on the first `/` into `JEVCODE_PROVIDER` (`anthropic` or `openrouter`) and `JEVCODE_MODEL` (`claude-sonnet-5` default). Keys travel only as `--ae` env vars; never bake them into the command or the image.
- Budgets: TB 4.0 sets a flat `[agent].timeout_sec = 28800` (8 h). Set `--max-wall` below it (e.g. `7h30m`) so JevCode stops itself, writes its checkpoint and exits cleanly instead of being killed by Harbor; `--spend-cap` bounds generator + Jev spend per trial (multiply by 330 for a full run).
- Sandbox: `--sandbox` defaults to `auto` = seatbelt on darwin, none elsewhere; inside a Linux container it degrades to cwd + env scrubbing + timeout + output cap + tree kill, which is fine because the container is the sandbox.
- Exit code: JevCode's non-zero exits (e.g. 3 for a corrupt checkpoint) must not be raised as agent errors by `exec_as_agent` — catch and record them in `context.metadata["exit_code"]`; the verifier decides pass/fail from `/app`, not from the agent's status.

### `populate_context_post_run()`

Read `self.logs_dir / "jevcode" / "runs" / <run-id>` on the host: sum `generator.jsonl` token counts into `context.n_input_tokens`, `n_output_tokens`, `n_cache_tokens`, add Jev usage from `decisions.jsonl`, set `context.cost_usd` from the `SpendMeter` total in `state.json`, and put `steps`, `stopReason`, `loops`, `reviews` under `context.metadata`. Optionally write an ATIF `trajectory.json` next to them (Harbor's `docs/agents/trajectory-format.mdx`; format details not yet verified, see research §4).

## Command lines

Full leaderboard-style run (5 attempts, 66 tasks, remote sandboxes):

```bash
export PYTHONPATH="$PWD"                     # so bench.harbor.jevcode_agent is importable
harbor run -d terminal-bench/terminal-bench@4.0.0 \
  -a bench.harbor.jevcode_agent:JevCodeAgent \
  -m anthropic/claude-sonnet-5 \
  --ae ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --ae JEV_API_KEY="$JEV_API_KEY" \
  --ak max_wall=7h30m --ak spend_cap_usd=5 --ak install_mode=bundle \
  -n 8 -k 5 -e modal \
  -o bench/results/harbor --job-name jevcode-tb4
```

Smoke test on the 10 checked-in tasks (local dataset dir; single attempt; Apple `container` once installed, or `-e docker` on a Linux box):

```bash
harbor run -p bench/data/terminal-bench/tasks \
  -a bench.harbor.jevcode_agent:JevCodeAgent -m anthropic/claude-sonnet-5 \
  --ae ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --ae JEV_API_KEY="$JEV_API_KEY" \
  -i 'cargo-flight-dispatch' -i 'sound-change-cascade' -n 2 -k 1 -e apple-container
```

Sanity checks Harbor's CONTRIBUTING.md prescribes before trusting any agent number: `harbor run -p bench/data/terminal-bench/tasks/<name> -a oracle -e <env>` must give reward 1.0 and `-a nop` must give 0. Our copies keep `solution/` under `gold/<name>/`, so for the oracle check symlink or copy `gold/<name>` to `tasks/<name>/solution` first (Harbor mounts `solution/` at `/solution` and runs `solve.sh`).

Other flags worth knowing (research §4 table, from `harbor/cli/jobs.py`): `-i/--include-task-name` and `-x/--exclude-task-name` (globs, repeatable), `-l/--n-tasks`, `-n/--n-concurrent` (default 4), `-k/--n-attempts`, `-r/--max-retries` with `--retry-include/--retry-exclude` by exception class, `--timeout-multiplier` / `--agent-timeout-multiplier` / `--verifier-timeout-multiplier`, `--upload` (Harbor Hub; leaderboard submissions are `-k 5` over all 66), `harbor view jobs` (viewer at http://127.0.0.1:8080), `harbor agent list`, `harbor agent schema <name>`, `harbor check tasks/<name> -m <model>`.

## Output to expect

```
bench/results/harbor/jevcode-tb4/
├── config.json, result.json          JobResult: n_total_trials, stats{evals{pass_at_k, reward_stats}, n_input_tokens, cost_usd}, trial_results[]
└── <task>__<id>/                     one per trial
    ├── config.json, lock.json, trial.log, result.json   TrialResult: agent_info, agent_result (our AgentContext), verifier_result{rewards}, exception_info, timings
    ├── agent/                        = /logs/agent: jevcode.log + jevcode/runs/<run-id>/{run.json,state.json,steps.jsonl,decisions.jsonl,generator.jsonl,transcript.log}
    ├── verifier/                     = /logs/verifier: reward.txt|reward.json, ctrf.json, test-stdout.txt, test-stderr.txt
    └── artifacts/manifest.json (+ collected files)
```

`jevcode bench --suite terminal-bench` should learn to ingest `result.json`/`<trial>/result.json` from such a job dir (evaluator recorded as `harbor`) next to its own `local` evaluator, so the comparison tables in `bench/results/<id>/comparison.md` can show both.

## Open items before writing the adapter

1. Confirm on an installed `harbor==0.23.0` whether `options_model`/`AgentOptions` validation exists in the wheel (research §7 item 8) — otherwise read `--ak` kwargs from `**kwargs` in `__init__`.
2. Confirm `exec_as_agent` user semantics per environment (some TB images set `USER agent`, e.g. `rs-archive-clone`); the `ln -sf /usr/local/bin/jevcode` step assumes root during `install()`.
3. Decide whether to publish `jevcode` to npm (route 2) or keep uploading the `npm pack` tarball (route 1).
4. ATIF trajectory export from `steps.jsonl` (optional; only needed for `--upload` with trajectories).
