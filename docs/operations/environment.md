# Every JEVCODE_* switch

Every `JEVCODE_*` name the source reads, grouped by what it is for, with its default, its effect
and the file that reads it.

Three groups exist. The first is the environment twin of a setting you can also give as a flag
or a file key: those are documented once, in [Configuration](configuration.md), and only
summarised here. The second is a mechanism switch with no setting row. The third is a test and
measurement double, which is **not for users**.

Names that look like variables in the source but are not: `__JEVCODE_VERSION__` is a build-time
substitution, `__JEVCODE_INTROSPECT__` and `__JEVCODE_REPRO__` are markers inside generated
scripts, and `JEVCODE_WARM_READY` is a line a helper process prints on its own standard output.

<!-- the list is `grep -rhoE 'JEVCODE_[A-Z0-9_]+' src scripts | sort -u`, minus those four -->

## Group 1: the environment twin of a setting

Each of these sits at layer 2 of the precedence chain — above a `.env` file and the
configuration file, below a flag. Every one is read in `src/config/defaults.ts`, where the
settings table declares the variable name, the file key, the default and the accepted shape;
`src/config/resolve.ts` walks the layers. See [Configuration](configuration.md) for the flags
and the file keys.

### Generator and decider

| Variable | Setting | Default | Effect |
| --- | --- | --- | --- |
| `JEVCODE_PROVIDER` | `generator.provider` | `openrouter` | which of the seven generator providers writes the code |
| `JEVCODE_MODEL` | `generator.model` | `z-ai/glm-5.3-flash` | the model id at that provider |
| `JEVCODE_API_KEY` | `generator.apiKey` | — | the generator key. The provider's own variable is tried first once the provider is known |
| `JEVCODE_BASE_URL` | `generator.baseUrl` | the provider's | point the generator at a gateway or a local server |
| `JEVCODE_TEMPERATURE` | `generator.temperature` | the provider's | 0 to 2 |
| `JEVCODE_MAX_TOKENS` | `generator.maxTokens` | `4096` | output tokens per call |
| `JEVCODE_PRICE_IN_PER_M` | `generator.priceInPerM` | the pricing table's | override the input rate in USD per million tokens |
| `JEVCODE_PRICE_OUT_PER_M` | `generator.priceOutPerM` | the pricing table's | override the output rate |
| `JEVCODE_PRICE_CACHE_READ_PER_M` | `generator.priceCacheReadPerM` | 0.1 × input | override the cache-read rate |
| `JEVCODE_PRICE_CACHE_WRITE_PER_M` | `generator.priceCacheWritePerM` | 1.25 × input | override the cache-write rate |

The decider's four variables do not carry the `JEVCODE_` prefix: `JEV_PROVIDER`, `JEV_BASE_URL`,
`JEV_API_KEY` and `JEV_MODEL`. They are in the table further down.

### Mode, limits and money

| Variable | Setting | Default | Effect |
| --- | --- | --- | --- |
| `JEVCODE_MODE` | `mode` | `llm-jev` | which engine mode a run uses |
| `JEVCODE_AUTONOMY` | `autonomy` | `full` | `full`: a review-level risk verdict proceeds and is logged; `review`: it waits for the approval card. A block stops the action under both |
| `JEVCODE_SPEND_CAP_USD` | `limits.spendCapUsd` | `2`, or `0.25` in the decider-only mode | the hard cap for one run |
| `JEVCODE_SESSION_SPEND_CAP_USD` | `session.spendCapUsd` | 5 × the run cap | the cap across a whole session; `none` removes it |
| `JEVCODE_MAX_STEPS` | `limits.maxSteps` | `40` | steps before the run stops |
| `JEVCODE_MAX_WALL` | `limits.maxWall` | `30m` | wall-clock budget; accepts `90s`, `1h30m` |
| `JEVCODE_MAX_REPLANS` | `limits.maxReplans` | `5` | replans before the run stops |
| `JEVCODE_COMPLETE_THRESHOLD` | `limits.completeThreshold` | `0.85` | the probability at which the run is judged done |
| `JEVCODE_IMPOSSIBLE_THRESHOLD` | `limits.impossibleThreshold` | `0.85` | the probability at which the task is judged impossible |
| `JEVCODE_ALLOW_UNPRICED` | `limits.allowUnpriced` | `false` | run a model with no known price, under a token cap instead of a dollar cap |
| `JEVCODE_MAX_GENERATOR_TOKENS` | `limits.maxGeneratorTokens` | the spend cap ÷ 15 × 1,000,000 | that token cap |

### Paths, workspace and the sandbox

| Variable | Setting | Default | Effect |
| --- | --- | --- | --- |
| `JEVCODE_WORKSPACE` | `workspace` | the working directory | the directory a run may change |
| `JEVCODE_HOME` | `runsDir` | `~/.jevcode` | the JevCode home; the runs directory is `runs` inside it, and the coordination ledger and the model cache live beside it |
| `JEVCODE_EXTRA_ENV_FILE` | `extraEnvFile` | — | a checkout whose `.env` is read as an additional fallback layer, below `./.env` and above the configuration file. `docs/DESIGN.md` §3 still spells this row `--extra-env-file` / `JEVCODE_EXTRA_ENV_FILE`; the built name is the one above |
| `JEVCODE_CONFIG` | `configFile` | the search order | the configuration file to read |
| `JEVCODE_SANDBOX` | `sandbox` | `auto` | the sandbox profile; `none` disables the system profile |

### Context

| Variable | Setting | Default | Effect |
| --- | --- | --- | --- |
| `JEVCODE_CONTEXT_MODE` | `context.mode` | `relaxed` | `legacy` restores the older, narrower prompt exactly |
| `JEVCODE_CONTEXT_COMPACTION` | `context.compaction` | `code` | `llm` uses a model to compact the history; `off` disables compaction, but not the rest of the relaxed context |
| `JEVCODE_CONTEXT_COMPACT_EVERY` | `context.compactEvery` | `8` | compact every N steps; 0 disables the interval trigger |
| `JEVCODE_CONTEXT_HISTORY_STEPS` | `context.historySteps` | 12 | recent steps the generator sees |
| `JEVCODE_CONTEXT_FILE_CACHE_BYTES` | `context.fileCacheBytes` | 98,304 | file content re-read per step |
| `JEVCODE_CONTEXT_BUDGET_CHARS` | `context.budgetChars` | derived | the prompt budget, otherwise derived from the model window and the run cap |

### Rendering

Five of these are **launch** settings: they are fixed when the interface mounts and a
configuration file cannot change one.

| Variable | Setting | Default | Effect |
| --- | --- | --- | --- |
| `JEVCODE_THEME` | `ui.theme` | `dark` | `dark`, `light`, `daltonized` or `ansi` |
| `JEVCODE_RENDERER` | `ui.renderer` | `classic` | `fullscreen` pins the header on the alternate screen; needs 18 rows and 40 columns |
| `JEVCODE_FULLSCREEN_DUMP` | `ui.fullscreenDump` | `true` | write the transcript to the primary screen when the fullscreen renderer exits |
| `JEVCODE_FPS` | `ui.fps` (launch) | `30`, `15` over a remote shell | frames per second, clamped to 5–30 |
| `JEVCODE_RENDER_MODE` | `ui.renderMode` (launch) | `standard` | `incremental` changes how Ink repaints |
| `JEVCODE_ASCII` | `ui.ascii` (launch) | automatic | force the ASCII glyph table |
| `JEVCODE_SCREEN_READER` | `ui.screenReader` (launch) | `false` | screen-reader mode; `INK_SCREEN_READER` is also accepted |
| `JEVCODE_REDUCED_MOTION` | `ui.reducedMotion` | true under screen-reader mode | no spinner animation |
| `JEVCODE_WORDMARK` | `ui.wordmark` | `static` over a remote shell, else `sweep` | the idle wordmark animation; `off` disables it |
| `JEVCODE_TITLE` | `ui.title` | `false` | set the terminal title |
| `JEVCODE_NOTIFY` | `ui.notify` | true under screen-reader mode | terminal notifications |
| `JEVCODE_OSC52` | `ui.osc52` | `false` | copy to the clipboard through the terminal escape sequence |

### Session behaviour and logging

| Variable | Setting | Default | Effect |
| --- | --- | --- | --- |
| `JEVCODE_NO_HISTORY` | `ui.history`, inverted | history on | stop persisting composer history |
| `JEVCODE_NO_INPUT` | `ui.noInput` | `false` | no interactive prompts; each takes its safe default |
| `JEVCODE_TRUST_WORKSPACE` | `ui.trustWorkspace` | `false` | trust the workspace's instruction files without asking |
| `JEVCODE_BUDGET_WARNINGS` | `ui.budgetWarnings` | `true` | budget notices and the bell. The transcript item and the machine-readable event are never muted |
| `JEVCODE_ALLOW_SECRET_MENTION` | `ui.allowSecretMention` | `false` | allow mentioning a file recognised as a credential store, with a per-mention confirmation |
| `JEVCODE_EXIT_CODE` | `ui.exitCode` | `zero` | `last-run` makes a session exit with its last run's code |
| `JEVCODE_KEYBINDINGS` | `ui.keybindings` | the standard configuration path | a keybindings file |
| `JEVCODE_LOG` | `log.file` | the run directory's own log | where the run log is written |
| `JEVCODE_LOG_LEVEL` | `log.level` | `info` | `error`, `warn`, `info`, `debug` or `trace` |
| `JEVCODE_TRACE` | `log.file` plus the level | — | the same as the log file variable with the level forced to `trace` |
| `JEVCODE_UPDATE_NOTIFY` | `update.notify` | `false` | the post-run update notice; `NO_UPDATE_NOTIFIER` disables it |

<!-- src/config/defaults.ts:116-200 SETTINGS -->

### Variables that are not JevCode's own

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `XAI_API_KEY`, `FIREWORKS_API_KEY`, `META_API_KEY` or `MODEL_API_KEY` | the generator key for that provider |
| `JEV_PROVIDER`, `JEV_BASE_URL`, `JEV_API_KEY`, `JEV_MODEL` | the decider settings |
| `TYPESAFE_API_KEY` | the decider key at the native endpoint; also what makes `decider.provider: auto` resolve to it |
| `NO_COLOR` | disables colour |
| `FORCE_COLOR` | overrides the colour decision; `NO_COLOR` is mapped onto it at launch |
| `NO_UPDATE_NOTIFIER` | disables the post-run update notice |
| `XDG_CONFIG_HOME` | where the configuration file and keybindings live |
| `INK_SCREEN_READER` | a second accepted spelling of the screen-reader setting |

<!-- src/provider/ids.ts:36-44 PROVIDER_KEY_ENV; src/config/defaults.ts:70 KNOWN_KEY_ENV;
     src/tui/color-shim.ts:9-37 -->

Four of these join the redaction set whenever they are set in your shell, whichever provider you
selected: `JEV_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY`. A key
exported for another tool is therefore still masked in JevCode's output. On top of that, every
key in a loaded `.env` file or in the configuration file whose **name** contains `KEY`, `TOKEN`,
`SECRET`, `PASSWORD` or `CREDENTIAL` joins the set too, whatever it is called.

<!-- src/config/defaults.ts:70 KNOWN_KEY_ENV; src/config/resolve.ts:592-606;
     src/core/redact.ts:56 SECRET_NAME_RE -->

## A `.env` file is not the environment

This distinction matters for the two groups below. A `.env` file — the one in the working
directory, or the one under the path `extraEnvFile` names — is read as a **configuration layer**. Its values
never enter the process environment.

So a name from Group 1 works in a `.env` file, because the settings resolver reads that layer.
A name from Group 2 or Group 3 does **not**: those are read straight from the process
environment by the module that owns the mechanism, and nothing in JevCode copies a `.env` value
into it. Export them in your shell, or put them on the command line.

<!-- src/config/resolve.ts loads dotenv files into its own layer object; no code in src/ assigns
     into process.env except the colour shim's FORCE_COLOR mapping (src/tui/color-shim.ts:12-13) -->

## Group 2: mechanism switches with no setting row

These have no flag and no file key. They exist so a mechanism can be turned on for a measurement
without becoming a configuration surface. **Every one of them is off or inert by default.**

| Variable | Accepted | Default | Effect | Read by |
| --- | --- | --- | --- | --- |
| `JEVCODE_ROUTERS` | `on` | off | arms the speculative router table. Only the exact value `on` enables it, and the mode gate runs first: routers are never on outside the decider-plus-generator mode. An explicit option passed by the caller wins over this variable. | `src/jev/router.ts:260-264`, `src/loop/routers.ts:48-51` |
| `JEVCODE_FASTPATH` | `off` | armed only in the decider-plus-generator mode | only the exact value `off` is read, and it disarms the bounded fast path. In every other mode the fast path is off whatever this says. An explicit option wins. | `src/loop/engine.ts:442-447` |
| `JEVCODE_WARM` | `on`, `1`, `true` | off | arms the warm lane pool for the two Python test shapes. It is **off by default** after a live measurement found runs wedging with it on. Any speed number you publish must state whether this was on. | `src/synth/warm/plane.ts:45-46`, `:115-151` |
| `JEVCODE_HEDGE` | `on` | off | fires a second copy of a code-model sample that has not produced a first byte. The caller's own setting wins over this. | `src/synth/llm/source.ts:148-149`, `:189-193` |
| `JEVCODE_DEADLINE_GROWTH` | `served` | `always` | which samples grow the adaptive per-sample deadline: only those the provider actually served, or every one. | `src/synth/llm/source.ts:305-314` |
| `JEVCODE_JEV` | `off`, `escape`, `0`, `unreachable`, `down`, `503` | unset | replaces the decider with a deterministic double: either "no opinion" — every choice on its escape option, every probability inert, every score at its **most severe** level — or a hard outage. It costs nothing and answers instantly, so it is the continuous test that every fallback path really is a code path. | `src/jev/off.ts:91-96`, `:130-132` |
| `JEVCODE_TIMELINE` | any value that is not empty, `0` or `off` | unset | records a per-step span timeline. With it unset every entry point is an early return and the span helper is a shared no-op, so the recorder cannot show up in the step-overhead measurement. | `src/perf/timeline.ts:83-86` |
| `JEVCODE_SUBMIT_WATCHDOG_MS` | milliseconds | 45,000 | how long the interface waits for a sign of life after a submission before saying so. | `src/tui/useEngine.tsx:601` |
| `JEVCODE_CASE_TIMEOUT_MS` | milliseconds | adaptive, clamped to 0.5–2 s | the per-test-case limit passed into a generated Python test module. Normally set by JevCode itself, not by a person. | `src/synth/verify/quixbugs.ts:40`, `src/synth/search/budget.ts:42-52` |
| `JEVCODE_MAX_CASE_TIMEOUTS` | a count | 1 inside a lane run | stop a candidate after this many case timeouts. | `src/synth/verify/quixbugs.ts:41` |
| `JEVCODE_BENCH_CONTEXT` | `relaxed` | `legacy` | pins the context view for a benchmark arm, so an arm that is not measuring the context policy is not silently affected by it. | `src/bench/conditions.ts:353-354` |
| `JEVCODE_DEBUG` | `1` | unset | print the stack trace with a fatal error instead of only the message. | `src/cli/fatal.ts:75` |
| `JEVCODE_UPGRADE_DRY_RUN` | `1` | unset | the upgrade command prints the command it would run and stops. | `src/cli/upgrade.ts:197` |

### The default-off rule, stated once

Four mechanisms ship behind a switch and all four are **off** in a default run: the speculative
routers, the warm lane pool, the code-model hedge, and delegation. The bounded fast path is
armed only in the decider-plus-generator mode and off everywhere else. Any measurement quoted
anywhere in these pages states which of them were on.

## Group 3: test and measurement doubles — not for users

These exist for the test suite and the built-in performance probes. Setting one in normal use
will make JevCode behave incorrectly on purpose.

| Variable | What it does | Read by |
| --- | --- | --- |
| `JEVCODE_MOCK_STEP_MS` | paces each turn of the mock trajectory | `src/cli/mock-trajectory.ts:15` |
| `JEVCODE_MOCK_PATCH` | extends the mock trajectory with two patch turns | `src/cli/mock-trajectory.ts:39` |
| `JEVCODE_MOCK_JEV_MS` | delays the mock decider, for the latency probe | `src/cli/session.ts:737` |
| `JEVCODE_MOCK_INTAKE` | forces the mock decider's reading of what you typed | `src/cli/session.ts:732` |
| `JEVCODE_MOCK_REVIEW_AT` | makes the mock decider raise a review at one step | `src/cli/session.ts:722-727` |
| `JEVCODE_FAULT` | injects one of thirteen named interface faults | `src/tui/faults.ts:80` |
| `JEVCODE_ASSERT_HEIGHT` | asserts the rendered height | `src/tui/faults.ts:82` |
| `JEVCODE_ASSERT_NO_NETWORK` | any network request before the first frame throws | `src/perf/first-frame.ts:126`, `scripts/build.mjs:90` |
| `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME` | a configuration or git read before the first frame throws | `src/perf/first-frame.ts:127` |
| `JEVCODE_PERF_ONLY` | run one named probe instead of the release set | `src/perf/main.ts:56-64` |
| `JEVCODE_PERF_KEEP` | keep the terminal capture and timing files in a named directory as evidence | `src/perf/pty.ts:191` |
| `JEVCODE_PERF_CHILD` | marks the probe's own child process | `src/perf/main.ts:152` |

The two assertion variables are the interesting ones: the release build sets the network one and
runs a real terminal smoke test, so "no network before the first frame" is verified on every
build rather than asserted in prose.

<!-- scripts/build.mjs:90 -->

## Recipes

**Run against a local model server.**

```sh
JEVCODE_PROVIDER=openai \
JEVCODE_BASE_URL=http://localhost:8000/v1 \
JEVCODE_MODEL=my-local-model \
OPENAI_API_KEY=unused \
jevcode run "add a test for the empty-input case"
```

**Keep a run cheap and short.**

```sh
JEVCODE_SPEND_CAP_USD=0.25 JEVCODE_MAX_STEPS=8 JEVCODE_MAX_WALL=5m jevcode run "..."
```

**Check that every fallback path still finishes.** This makes no requests and costs nothing.

```sh
JEVCODE_JEV=off jevcode run "..."
```

**Drive a session from a script.**

```sh
JEVCODE_NO_INPUT=1 JEVCODE_EXIT_CODE=last-run jevcode run --plain "..."
```

**Keep everything out of your home directory.**

```sh
JEVCODE_HOME=/tmp/jevcode-scratch jevcode run "..."
```

**Trace the launch path.** The trace file records launch checkpoints only — never a key and
never a draft.

```sh
JEVCODE_TRACE=/tmp/jevcode-launch.log jevcode
```

## The environment a command sees

None of the above is visible to a command JevCode runs on your behalf. A command's environment
is built from an allow-list of exactly four variables — `PATH`, `LANG`, `LC_ALL`, `TERM` —
plus `HOME` and `TMPDIR` remapped into the run directory, plus `VIRTUAL_ENV` and an adjusted
`PATH` when the workspace has a Python virtual environment. No API key is ever in it.

<!-- src/sandbox/run.ts:31, :112-127 -->

## Related pages

- [Configuration](configuration.md) — the settings these variables are twins of.
- [Sandbox and security guarantees](sandbox-and-security.md) — the environment a command sees.
- [Bench, rings and replay](bench-and-rings.md) — where the mechanism switches are actually used.
