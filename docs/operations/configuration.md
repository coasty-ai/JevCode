# Configuration

Every setting can be given four ways: a command-line flag, an environment variable, a key in a
`.env` file, or a key in a configuration file. They are resolved once, in one place, and every
value records where it came from.

Run `jevcode config` to see the resolved table for the current directory, with the source of
each row. Add `--json` for the machine-readable form, `--all` to include bookkeeping rows.

## Precedence

Highest first:

1. **a flag** on the command line
2. **the process environment**
3. **`./.env`** in the working directory
4. **the `.env` of the checkout `openAssistPath` names**, if you named one
5. **a configuration file**
6. **the built-in default**

The configuration file is found in this order, and the first that exists wins: the path given by
`--config` or `JEVCODE_CONFIG`, then `./jevcode.json`, then
`${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`, then the pre-standard
`~/.config/jevcode/config.json` if that differs — which is read with a one-time warning telling
you to move it.

The configuration file cannot come from the additional `.env` file, and it cannot name itself.

<!-- src/config/resolve.ts:4-8 the precedence sentence; :450-505 the layer construction -->

## Two resolution classes

Most settings follow the full chain above. **Launch settings** do not: they are fixed when the
interface mounts, so they are resolved from flag, then environment, then default, and never from
a file. Ink fixes several of them in its constructor and they cannot be changed in place.

A configuration file that sets a launch setting is not an error. The value is ignored, the row
is printed with the source `ignored:launch`, and a warning names the flag or variable to use
instead.

The launch settings are `ui.fps`, `ui.renderMode`, `ui.ascii`, `ui.screenReader` and
`ui.noColor`.

<!-- src/config/resolve.ts:10-13; src/config/defaults.ts:276 LAUNCH_SETTINGS -->

## Derived rows

Four settings have no default of their own and are computed from another setting when you have
not set them. `jevcode config` prints the derivation next to the value.

| Setting | Derivation |
| --- | --- |
| `session.spendCapUsd` | 5 × `limits.spendCapUsd` |
| `limits.maxGeneratorTokens` | `limits.spendCapUsd` ÷ 15 × 1,000,000 |
| `generator.priceCacheReadPerM` | 0.1 × `generator.priceInPerM` |
| `generator.priceCacheWritePerM` | 1.25 × `generator.priceInPerM` |

One more default is keyed on another setting rather than derived from it: the run spend cap is
$2.00 in every mode except the decider-only mode, where it is $0.25 — and the session cap then
follows at 5 ×, which is $1.25.

The decider provider can also be derived. When `decider.provider` is `auto`, the source column
says which rule fired: the base URL named a host, a decider key is set, a TypeSafe key is set,
or an OpenRouter key is set.

<!-- src/cli/config-table.ts:26-41 DERIVATIONS and PROVIDER_DERIVATIONS; src/config/defaults.ts:13-17 -->

## Secrets

A setting marked secret is never printed. `jevcode config` shows the source and a hash
fingerprint instead of the value, in both the table and the machine-readable output. The two
secret settings are `generator.apiKey` and `decider.apiKey`.

`jevcode config set` refuses a secret setting. Use `jevcode login`, which writes credentials to
`${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json` with file mode 0600 and directory mode 0700,
or supply the key through an environment variable.

<!-- src/config/defaults.ts:306 SECRET_SETTINGS; src/cli/config-table.ts:68-72;
     src/config/credentials.ts:263-280 writeCredentials -->

## Validation

Most settings declare a shape, and `jevcode config` checks the resolved value against it. A row
whose value the next run would reject is marked with a cross and the expected form — "expected
an integer ≥ 1", "expected one of code|llm|off". A value that is merely out of a clamped range
is marked with a warning and the value it will be clamped to; `ui.fps` is the one clamped row,
between 5 and 30.

Booleans accept `1`, `true`, `yes`, `on` and their negatives `0`, `false`, `no`, `off`.
Durations accept forms such as `30m`, `90s` and `1h30m`. Money accepts a plain number or a
`$`-prefixed one, and the session cap also accepts `none`.

<!-- src/config/defaults.ts:186-266 expectedText, settingProblem, isClampProblem -->

## The settings

Sixty-one rows. `—` means the setting has no flag, no variable or no file key. A blank default
means the setting is unset unless you set it.

### Generator

| Setting | Flag | Variable | File key | Default |
| --- | --- | --- | --- | --- |
| `generator.provider` | `--provider` | `JEVCODE_PROVIDER` | `provider` | `openrouter` |
| `generator.model` | `--model` | `JEVCODE_MODEL` | `model` | `z-ai/glm-5.3-flash` |
| `generator.apiKey` | `--api-key` | `JEVCODE_API_KEY`, plus the provider's own name | `apiKey` | — (secret) |
| `generator.baseUrl` | `--base-url` | `JEVCODE_BASE_URL` | `baseUrl` | the provider's |
| `generator.temperature` | `--temperature` | `JEVCODE_TEMPERATURE` | `temperature` | — |
| `generator.maxTokens` | `--max-tokens` | `JEVCODE_MAX_TOKENS` | `maxTokens` | `4096` |
| `generator.priceInPerM` | — | `JEVCODE_PRICE_IN_PER_M` | `priceInPerM` | the table's |
| `generator.priceOutPerM` | — | `JEVCODE_PRICE_OUT_PER_M` | `priceOutPerM` | the table's |
| `generator.priceCacheReadPerM` | — | `JEVCODE_PRICE_CACHE_READ_PER_M` | `priceCacheReadPerM` | derived |
| `generator.priceCacheWritePerM` | — | `JEVCODE_PRICE_CACHE_WRITE_PER_M` | `priceCacheWritePerM` | derived |

### Decider

| Setting | Flag | Variable | File key | Default |
| --- | --- | --- | --- | --- |
| `decider.provider` | `--jev-provider` | `JEV_PROVIDER` | `jevProvider` | `auto` |
| `decider.baseUrl` | `--jev-base-url` | `JEV_BASE_URL` | `jevBaseUrl` | `https://openrouter.ai/api/alpha/decisions` |
| `decider.apiKey` | `--jev-api-key` | `JEV_API_KEY`, `OPENROUTER_API_KEY` | `jevApiKey` | — (secret) |
| `decider.model` | `--jev-model` | `JEV_MODEL` | `jevModel` | `typesafe/jev-1.13-20260917` |

### Mode, limits and money

| Setting | Flag | Variable | File key | Default |
| --- | --- | --- | --- | --- |
| `mode` | `--mode` | `JEVCODE_MODE` | `mode` | `llm-jev` |
| `limits.spendCapUsd` | `--spend-cap` | `JEVCODE_SPEND_CAP_USD` | `spendCapUsd` | `2` |
| `session.spendCapUsd` | `--session-spend-cap` | `JEVCODE_SESSION_SPEND_CAP_USD` | `sessionSpendCapUsd` | derived |
| `limits.maxSteps` | `--max-steps` | `JEVCODE_MAX_STEPS` | `maxSteps` | `40` |
| `limits.maxWall` | `--max-wall` | `JEVCODE_MAX_WALL` | `maxWall` | `30m` |
| `limits.maxReplans` | `--max-replans` | `JEVCODE_MAX_REPLANS` | `maxReplans` | `5` |
| `limits.completeThreshold` | `--complete-threshold` | `JEVCODE_COMPLETE_THRESHOLD` | `completeThreshold` | `0.85` |
| `limits.impossibleThreshold` | `--impossible-threshold` | `JEVCODE_IMPOSSIBLE_THRESHOLD` | `impossibleThreshold` | `0.85` |
| `limits.allowUnpriced` | `--allow-unpriced` | `JEVCODE_ALLOW_UNPRICED` | `allowUnpriced` | `false` |
| `limits.maxGeneratorTokens` | `--max-generator-tokens` | `JEVCODE_MAX_GENERATOR_TOKENS` | `maxGeneratorTokens` | derived |

### Paths and the sandbox

| Setting | Flag | Variable | File key | Default |
| --- | --- | --- | --- | --- |
| `workspace` | `--workspace` | `JEVCODE_WORKSPACE` | `workspace` | the working directory |
| `runsDir` | `--runs-dir` | `JEVCODE_HOME` | `runsDir` | `~/.jevcode/runs` |
| `openAssistPath` | `--open-assist-path <dir>` | `OPEN_ASSIST_PATH` | `openAssistPath` | — |
| `configFile` | `--config` | `JEVCODE_CONFIG` | — | the search order above |
| `sandbox` | `--sandbox` | `JEVCODE_SANDBOX` | `sandbox` | `auto` |
| `noNetwork` | `--no-network` | — | `noNetwork` | `false` |

`openAssistPath` names a checkout whose `.env` is read as an additional fallback layer. It sits
between `./.env` and the configuration file in the precedence chain, so it fills in what neither
the environment nor the local `.env` supplied. (`docs/DESIGN.md` §3 spells this row
`--extra-env-file` / `JEVCODE_EXTRA_ENV_FILE`; the built flag, variable and file key are the
three above.)

`JEVCODE_HOME` names the JevCode home directory, and the runs directory is `runs` inside it.
`--runs-dir` sets the runs directory itself.

### Context

None of these has a flag.

| Setting | Variable | File key | Default |
| --- | --- | --- | --- |
| `context.mode` | `JEVCODE_CONTEXT_MODE` | `contextMode` | `relaxed` |
| `context.compaction` | `JEVCODE_CONTEXT_COMPACTION` | `contextCompaction` | `code` |
| `context.compactEvery` | `JEVCODE_CONTEXT_COMPACT_EVERY` | `contextCompactEvery` | `8` |
| `context.historySteps` | `JEVCODE_CONTEXT_HISTORY_STEPS` | `contextHistorySteps` | 12 |
| `context.fileCacheBytes` | `JEVCODE_CONTEXT_FILE_CACHE_BYTES` | `contextFileCacheBytes` | 98,304 |
| `context.budgetChars` | `JEVCODE_CONTEXT_BUDGET_CHARS` | `contextBudgetChars` | derived from the model window and the run cap |

`context.mode: legacy` restores the older, narrower prompt exactly. Turning compaction off alone
does not: the tiered history, the file cache and the whole-output files all stay on.

### Interface

| Setting | Flag | Variable | File key | Default |
| --- | --- | --- | --- | --- |
| `ui.theme` | `--theme` | `JEVCODE_THEME` | `theme` | `dark` |
| `ui.renderer` | `--renderer`, `--fullscreen` | `JEVCODE_RENDERER` | `renderer` | `classic` |
| `ui.fullscreenDump` | — | `JEVCODE_FULLSCREEN_DUMP` | `fullscreenDump` | `true` |
| `ui.fps` | `--fps` | `JEVCODE_FPS` | ignored (`fps`) | `30`, `15` over a remote shell |
| `ui.renderMode` | `--render-mode` | `JEVCODE_RENDER_MODE` | ignored (`renderMode`) | `standard` |
| `ui.ascii` | `--ascii` | `JEVCODE_ASCII` | ignored (`ascii`) | automatic |
| `ui.screenReader` | `--screen-reader` | `JEVCODE_SCREEN_READER`, `INK_SCREEN_READER` | ignored (`screenReader`) | `false` |
| `ui.noColor` | `--no-color` | `NO_COLOR` | — | automatic |
| `ui.reducedMotion` | `--no-animation` | `JEVCODE_REDUCED_MOTION` | `reducedMotion` | true under screen-reader mode |
| `ui.wordmark` | — | `JEVCODE_WORDMARK` | `wordmark` | `static` over a remote shell, else `sweep` |
| `ui.title` | `--title` | `JEVCODE_TITLE` | `title` | `false` |
| `ui.notify` | `--notify` | `JEVCODE_NOTIFY` | `notify` | true under screen-reader mode |
| `ui.osc52` | `--osc52` | `JEVCODE_OSC52` | `osc52` | `false` |
| `ui.history` | `--no-history` | `JEVCODE_NO_HISTORY` inverts it | `history` | `true` |
| `ui.noInput` | `--no-input` | `JEVCODE_NO_INPUT` | — | `false` |
| `ui.trustWorkspace` | `--trust-workspace` | `JEVCODE_TRUST_WORKSPACE` | — | `false` |
| `ui.budgetWarnings` | `--no-budget-warnings` | `JEVCODE_BUDGET_WARNINGS` | `budgetWarnings` | `true` |
| `ui.allowSecretMention` | `--allow-secret-mention` | `JEVCODE_ALLOW_SECRET_MENTION` | — | `false` |
| `ui.exitCode` | `--exit-code` | `JEVCODE_EXIT_CODE` | `exitCode` | `zero` |
| `ui.keybindings` | `--keybindings` | `JEVCODE_KEYBINDINGS` | `keybindings` | `${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json` |
| `plain` | `--plain` | — | `plain` | `false` |

### Logging and updates

| Setting | Flag | Variable | File key | Default |
| --- | --- | --- | --- | --- |
| `log.file` | `--log` | `JEVCODE_LOG`, `JEVCODE_TRACE` | `log` | `<run dir>/jevcode.log` |
| `log.level` | `--log-level` | `JEVCODE_LOG_LEVEL` | `logLevel` | `info` |
| `update.notify` | `--update-notify` | `JEVCODE_UPDATE_NOTIFY`, `NO_UPDATE_NOTIFIER` inverts it | `updateNotify` | `false` |

`JEVCODE_TRACE=<file>` is the same as `JEVCODE_LOG=<file>` with the level set to `trace`.
`--verbose` is the same as `--log-level debug`.

### Bookkeeping

One row, `seen.defaultMode`, remembers which default mode the one-time setup note was shown for.
`jevcode config` hides it unless you pass `--all`.

<!-- the whole table is src/config/defaults.ts:116-274 SETTINGS, 61 rows; the flag spellings are
     src/cli/args.ts's FLAGS table -->

## What is not in this table

Two subsystems have settings that are **not** rows here, so `jevcode config` does not print them
and a configuration file does not carry them. Their defaults live in code:

- coordination — `coordination.claims`, `coordination.sync` and the rest arrive as engine options;
  see [The coordination ledger](../architecture/coordination.md).
- orchestration — `orchestrate.split` and its policy arrive the same way; see
  [Orchestration](../architecture/orchestration.md).

A number of mechanism and test-only switches are environment variables with no setting row at
all. They are listed in [Every JEVCODE_* switch](environment.md).

## Setting a value that sticks

```sh
jevcode config                          # the resolved table, with sources
jevcode config --json                   # the same as JSON
jevcode config --all                    # including hidden bookkeeping rows
jevcode config set ui.theme light       # write one row to the configuration file
```

`jevcode config set` refuses secret settings, and it refuses a value the shape check rejects.

<!-- src/cli/args.ts:510-517 and :740 the usage lines -->

## Related pages

- [Every JEVCODE_* switch](environment.md) — the full variable list, including the ones with no setting row.
- [Providers and the model catalogue](../architecture/providers-and-models.md) — what a provider row means.
- [Sandbox and security guarantees](sandbox-and-security.md) — what `sandbox` and `noNetwork` change.
- [Exit codes](exit-codes.md) — a configuration error is exit 2.
