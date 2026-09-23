<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/media/wordmark-light.svg">
  <img alt="JevCode — Decisions, not strings" src="docs/media/wordmark-dark.svg" width="780">
</picture>

<br>

**A terminal coding agent where a decision model picks every step — and your tests decide what lands.**

<br>

<!-- after the first npm publish, swap the first badge for the live one:
     https://img.shields.io/npm/v/jevcode?style=flat-square&label=npm&color=f386a1&labelColor=1e1e1e -->
<img alt="version 0.6.0" src="https://img.shields.io/badge/version-0.6.0-f386a1?style=flat-square&labelColor=1e1e1e">
<img alt="node >=22.12" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-d45bb6?style=flat-square&labelColor=1e1e1e">
<img alt="zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-f386a1?style=flat-square&labelColor=1e1e1e">
<img alt="macOS, Linux, WSL 2" src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20WSL%202-d45bb6?style=flat-square&labelColor=1e1e1e">
<img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-f386a1?style=flat-square&labelColor=1e1e1e">

<br><br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rule-dark.svg">
  <img alt="" src="docs/media/rule-light.svg" width="100%">
</picture>

</div>

## Watch it work

<div align="center">

![Two terminals fixing the same bug, one in each mode](docs/media/side-by-side.gif)

</div>

Two terminals, one bug, the same code model in both — not a mock-up, two live runs rendered from
the bytes the terminal actually received. On the left JevCode in its default mode. On the right the
same binary with `--mode jev-off`, where the model drives every step on its own and nothing
arbitrates. Both panes start at zero and replay at the same speed. **The left one stops after 40
seconds. The right one keeps going for another two minutes.**

The task, the exact commands, the machine and the one-line fix both runs landed on:
[docs/media/side-by-side.md](docs/media/side-by-side.md).

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rule-dark.svg">
  <img alt="" src="docs/media/rule-light.svg" width="100%">
</picture>
</div>

## Install

```sh
npm install -g jevcode     # once the first release is on npm
npx jevcode                # same, without installing
```

<details>
<summary><b>Today: build it from the checkout</b> — the package is gated but not published yet</summary>

<br>

The first release has not shipped, so `registry.npmjs.org/jevcode` is still a 404. Until it lands,
this is the line that runs:

```sh
git clone https://github.com/coasty-ai/JevCode && cd JevCode
npm ci && npm run build && npm link
```

Progress and the remaining steps are in [docs/RELEASE.md](docs/RELEASE.md).

</details>

<details>
<summary><b>Other package managers</b> — Homebrew, mise, pnpm, bun, yarn</summary>

<br>

```sh
brew install coasty-ai/jevcode/jevcode   # tap; lands with the first release
mise use -g npm:jevcode                  # any OS, via mise's npm backend
pnpm add -g jevcode
bun  install -g jevcode
yarn global add jevcode
```

`jevcode upgrade` detects which of these installed it and delegates to that one, so `brew` and
`npm` never disagree about what is on your PATH.

</details>

**Requirements.** Node 22.12 or newer — the launcher checks it and exits with a clear message on
anything older. macOS and Linux. On Windows use WSL 2: the sandbox and the machinery that runs your
tests both depend on POSIX features.

### First run

One key is enough. `OPENROUTER_API_KEY` serves both the decision model and the code model:

```sh
export OPENROUTER_API_KEY=…    # or a .env file in the directory you run jevcode from
jevcode
```

With **no key at all**, just run `jevcode`. The wordmark appears first, then a two-step wizard asks
which provider writes the code, takes the key at a masked prompt — never echoed, never accepted as a
command-line argument — and offers to reuse it for Jev. It tells you the price of verifying the keys
before it does so: one real Jev decision at about $0.00002, one 1-token completion at about
$0.000002, and a free key-info call. Keys land in `~/.config/jevcode/config.json`, written `0600` in
a `0700` directory.

Without a terminal — `--no-input`, `--json`, or a pipe — JevCode never prompts. It exits `2` and
prints the exact environment variable or `jevcode login` command that would fix it.

### Try it in 60 seconds

`examples/demo-py` in the checkout is a small Python package with two planted bugs:

```sh
cp -r examples/demo-py /tmp/demo && cd /tmp/demo
git init -q && git add -A && git commit -qm init
python3 -m venv .venv && .venv/bin/pip -q install pytest
jevcode run "Fix the failing tests in tests/test_core.py without changing the tests."
```

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rule-dark.svg">
  <img alt="" src="docs/media/rule-light.svg" width="100%">
</picture>
</div>

## Options

### Modes

`--mode <name>`, or `mode` in the config file, or `JEVCODE_MODE`.

| Mode | Badge | What runs | Keys it needs |
| --- | --- | --- | --- |
| `llm-jev` *(default)* | `llm+jev · verified` | The code model writes candidate patches, tests verify them, Jev arbitrates. | code model + Jev |
| `jev-on` | `jev+llm` | The code model writes the code and Jev decides every step. | code model + Jev |
| `jev-only` | `jev-only` | No generating LLM at all: the synthesizer proposes, Jev decides, tests verify. | Jev only |
| `jev-off` | `llm-only` | The generator alone, no Jev. This is the baseline the numbers below are measured against. | code model |

### Commands

| | |
| --- | --- |
| `jevcode` · `chat` | open the TUI session |
| `jevcode run "<task>"` | one task, start to finish |
| `jevcode doctor` | read-only diagnostics: version, install method, paths, sandbox level, whether `pytest` imports for the Python the sandbox runs |
| `jevcode config` | every setting with the source it came from |
| `jevcode login` · `logout` | re-run the key wizard · forget stored keys |
| `jevcode sessions` · `report` · `why` | resume a run · bundle one for a bug report · explain one decision |
| `jevcode models` · `import` · `agents` | list models · pull in an existing config · manage delegates |
| `jevcode bench` · `perf` · `calibration` | the measurement harnesses |
| `jevcode completion <bash\|zsh\|fish>` | print a static completion script |
| `jevcode upgrade` | delegate to whichever package manager installed it |

### Flags worth knowing

| Flag | Effect |
| --- | --- |
| `--mode <name>` | the table above |
| `--model <id>` · `--provider <name>` | the code model and who serves it (default `z-ai/glm-5.3-flash` on OpenRouter) |
| `--theme <dark\|light\|daltonized\|ansi>` | colour theme; no auto-detect |
| `--sandbox <auto\|seatbelt\|none>` | macOS seatbelt, or nothing |
| `--plain` · `--json` · `--no-input` | readline instead of the TUI · machine-readable · never prompt |
| `--spend-cap <usd>` | hard stop on spend (default `$2`, or `$0.25` under `jev-only`) |

Full tables: [docs/COMMANDS.md](docs/COMMANDS.md) (41 slash commands) ·
[docs/KEYS.md](docs/KEYS.md) (key bindings) · `man jevcode`.

### Colour

Four themes, every one of them checked for contrast, and **every colour paired with a text marker**
so a frame reads the same with colour off — `NO_COLOR`, `--no-color` and `TERM=dumb` lose nothing
but the hue. Pink is brand, never meaning: `[block]` is red *and* says `[block]`.

| Role | Dark | Light | Marker |
| --- | --- | --- | --- |
| brand / accent | ![#f386a1](https://img.shields.io/badge/%23f386a1-f386a1?style=flat-square) | ![#be185d](https://img.shields.io/badge/%23be185d-be185d?style=flat-square) | — |
| selected / active | ![#d45bb6](https://img.shields.io/badge/%23d45bb6-d45bb6?style=flat-square) | ![#831843](https://img.shields.io/badge/%23831843-831843?style=flat-square) | `[you]`, `live` |
| ok | ![#4ADE80](https://img.shields.io/badge/%234ADE80-4ADE80?style=flat-square) | ![#15803d](https://img.shields.io/badge/%2315803d-15803d?style=flat-square) | `✓` |
| review | ![#FBBF24](https://img.shields.io/badge/%23FBBF24-FBBF24?style=flat-square) | ![#0369A1](https://img.shields.io/badge/%230369A1-0369A1?style=flat-square) | `[review]` |
| block / error | ![#F87171](https://img.shields.io/badge/%23F87171-F87171?style=flat-square) | ![#b91c1c](https://img.shields.io/badge/%23b91c1c-b91c1c?style=flat-square) | `[block]` |

`daltonized` moves the block/error family off red onto blue; `ansi` is the ANSI-16 twin for
terminals without 256 colours. `/theme` swaps live. The wordmark at the top of this page is not a
drawing of the program — it is generated from these same tables and from the splash grid, by
[`scripts/gen-wordmark.mjs`](scripts/gen-wordmark.mjs); `npm run wordmark -- --check` fails if the
two have drifted apart.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rule-dark.svg">
  <img alt="" src="docs/media/rule-light.svg" width="100%">
</picture>
</div>

## Measured

Three claims, each with the run behind it. The caveats are part of the claim, not a disclaimer
under it.

- **Solves more, faster, cheaper than a plain LLM loop.** On a 28-task development set, same build
  and same code model, one run per arm: 28/28 solved against a plain generator-only loop's 21/28
  (one-sided sign test, p = 0.0078); 0.225× the wall clock on the 21 tasks both arms finished; and
  0.245× the dollars — where 78 % of JevCode's cost figure is estimated or rate-card against 0 % of
  the baseline's, because the Jev endpoint returns no cost. Passing the tests and being the right
  fix are scored separately: 26/28 behaviourally correct against the baseline's 20/28, with two
  tasks where the baseline was right and JevCode was not. The guard thresholds were tuned on some
  of those very programs, which is exactly why the next row exists.
  [Measurements](docs/measurements/README.md)
- **It holds up out of sample.** On a fresh 18-task slice that nothing was fitted against, and
  against a *tuned* generator-only loop rather than a naive one: 14/18 against 9/18, p = 0.031, at
  flat cost. On easy single-file bugs a tuned loop is slightly faster than JevCode, so "faster" is
  a claim about the plain loop only, never a general one. On a wider out-of-sample slice that adds
  multi-hunk and repository tasks the advantage disappears — 13/22 against 12/22, not significant —
  and the pages below say so before they say anything else.
  [Iterations 1–4](docs/measurements/iterations.md) ·
  [Out of sample](docs/measurements/out-of-sample.md)
- **It installs as one bundled JavaScript file plus a two-line launcher and starts instantly.** Zero
  runtime dependencies — Ink and React are compiled in, and `npm install jevcode` adds exactly one
  package — a tarball of about 1 MB, and a first frame in about 130 ms in a real terminal with the
  network untouched, against a design budget of 300 ms.
  [Install](docs/getting-started/install.md) ·
  [Startup and overhead](docs/measurements/performance.md)

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rule-dark.svg">
  <img alt="" src="docs/media/rule-light.svg" width="100%">
</picture>
</div>

## How it works

JevCode splits the work between two models.

**Jev is a calibrated decision model.** It answers every control question — what this step is for,
which files matter, whether an action is safe to run, whether the output succeeded, whether the task
is done. It does not write code.

**A code model writes the code.** The default is `z-ai/glm-5.3-flash` through OpenRouter; Anthropic
models are an option, not a requirement.

In the default mode the patch you get is picked by a **synthesizer** that runs inside JevCode: it
builds candidate fixes, runs your test suite against each one, and calls the code model only when the
search needs the help. Your tests decide what landed, not a model's confidence. The synthesizer
covers Python workspaces with a test runner JevCode can detect — anywhere else the agent falls back
to a plain write-it-and-check-it step loop, still with Jev deciding each step.

<!-- default model: src/config/defaults.ts:8 (DEFAULT_MODEL). default mode: src/config/defaults.ts:60.
     synthesizer applicability: src/synth/index.ts:299 (synthesizerHandles).
     launcher guard: bin/jevcode.js:11-15. sandbox is macOS-only seatbelt or nothing:
     src/sandbox/seatbelt.ts:275 (detectSandboxLevel). modes: src/core/types.ts:808.
     badges: src/config/defaults.ts:62 (MODE_BADGE_WORD). palette: src/tui/theme.ts. -->

## Documentation

- [Documentation index](docs/README.md) — everything below, plus the full research record
- [Install and first run](docs/getting-started/install.md)
- [How it works](docs/architecture/overview.md) — the step loop, the synthesizer, the sandbox
- [Measurements](docs/measurements/README.md) — every number on this page, with its run
- [Decisions](docs/DECISIONS.md) — what was chosen, and what was given up for it
- [Releasing](docs/RELEASE.md) — how a version gets to npm and the Homebrew tap
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md) — how to report a problem, and what the sandbox does not protect you from
- [MIT licence](LICENSE)

<div align="center">
<br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rule-dark.svg">
  <img alt="" src="docs/media/rule-light.svg" width="100%">
</picture>
<br><br>
<sub><b>Decisions, not strings.</b></sub>
</div>
