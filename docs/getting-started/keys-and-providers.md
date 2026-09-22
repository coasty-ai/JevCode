# Keys

JevCode talks to two kinds of model: a **decision model** (Jev) and a **code model** (the
generator). One OpenRouter key can serve both. This page lists every key variable, says where
each is read, and states the rules the harness keeps about secrets.

## The short version

```sh
export OPENROUTER_API_KEY=sk-or-v1-...
jevcode
```

That is enough for the default mode. The same key reaches Jev through OpenRouter's decisions
endpoint and the code model through OpenRouter's completions endpoint.

## Every key variable

| Variable | Serves | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Jev **and** the code model | the one-key path, and the default |
| `TYPESAFE_API_KEY` | Jev, natively | preferred for Jev whenever it is set; pair it with `OPENROUTER_API_KEY` for the code model |
| `JEV_API_KEY` | Jev through OpenRouter | for when the Jev key is not the same OpenRouter key |
| `ANTHROPIC_API_KEY` | the code model | with `--provider anthropic` |
| `OPENAI_API_KEY` | the code model | with `--provider openai` |
| `GEMINI_API_KEY` | the code model | `GOOGLE_API_KEY` is accepted as a second spelling |
| `XAI_API_KEY` | the code model | |
| `FIREWORKS_API_KEY` | the code model | |
| `META_API_KEY` | the code model | `MODEL_API_KEY` is accepted as a second spelling |

The provider list and the variable names for each live in one file with no imports at all,
`src/provider/ids.ts`, because the configuration layer has to read them before the first frame
is painted. Where a provider has two spellings, JevCode's own name wins.

`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `JEV_API_KEY` and `ANTHROPIC_API_KEY` are also the
four variables whose values join the redaction set for the whole session, whichever provider
you selected — so a key exported in your shell stays masked in the transcript even when this
run does not use it.

## The two endpoints Jev can use

| Provider | Endpoint | Default model |
| --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13-20260917` |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` |

The setting is `decider.provider` (`--jev-provider`, `JEV_PROVIDER`, `jevProvider` in the
config file). Its default is `auto`, which means **TypeSafe when `TYPESAFE_API_KEY` is set, and
OpenRouter otherwise**.

The dated model id is deliberate: pinning a date makes a threshold reproducible. An undated
alias is accepted and resolved on the first call.

## Where each value comes from

Every setting resolves through the same chain, highest first:

1. the command-line flag
2. the process environment
3. `./.env` in the workspace
4. the `.env` of the checkout named by `--open-assist-path <dir>` / `OPEN_ASSIST_PATH`, if you named one
5. the config file
6. the built-in default

`jevcode config` prints the resolved value **and the source** for every setting, with secrets
shown as fingerprints. When an environment variable shadows a saved key, the harness says so
rather than silently preferring one.

The config file is `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`, written at file mode
`0600`. A per-workspace `./jevcode.json` is read too.

`.env.example` in the repository is a copyable template with every variable above.

## Saving a key

Four ways, all equivalent in effect:

```sh
# 1. the first-run wizard: one masked field, opened automatically when no key resolves

# 2. an interactive masked prompt
jevcode login

# 3. a pipe — one key for both sides
printenv OPENROUTER_API_KEY | jevcode login --key-stdin

# 4. the environment, or ./.env
export OPENROUTER_API_KEY=sk-or-v1-...
```

For the two-key shapes, `jevcode login --jev-provider typesafe --jev-key-stdin
--generator-key-stdin` reads the Jev key and the generator key from successive stdin lines.

`jevcode logout [--generator] [--jev]` removes a saved key.

## Keys are not command-line arguments

The wizard, `jevcode login` and `jevcode config set` never accept a key as an argument:
`jevcode config set` refuses secret settings outright. Use the masked prompt, the `--*-stdin`
forms, or the environment.

`--api-key` and `--jev-api-key` do exist for scripted use, and their own help text says *prefer
the env var*. A key passed that way is visible in your shell history and in the process list of
every other user on the machine.

Two further rules the harness keeps:

- **Keys never appear in logs**, at any log level.
- The transcript, the composer history, the `jevcode report` bundle and every `@`-mention path
  are scanned for secrets, and a task that contains one is refused.

## Checking a key

```sh
jevcode login --status    # which keys are set and where they come from — fingerprints only
jevcode login --verify    # actually call the endpoints
```

`--verify` makes exactly three calls:

| Call | What it is | Cost |
| --- | --- | --- |
| one real Jev decision | a single-question probe, about 320 input tokens | about $0.00002 |
| one code-model completion | 1 token | about $0.000002 |
| `GET /api/v1/key` | the OpenRouter key's label and remaining limit | $0 |

It names one outcome: `ok`, `rejected`, `no credits`, `unreachable`, or `unknown model`. A
rejected key or an unserved model exits 2; no credits or unreachable exits 5.

## Which key do I actually need?

| You want | Keys |
| --- | --- |
| the default mode, cheapest path | `OPENROUTER_API_KEY` alone |
| Jev natively, code model via OpenRouter | `TYPESAFE_API_KEY` + `OPENROUTER_API_KEY` |
| no generating model at all (`--mode jev-only`) | one Jev key: `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` |
| the code model from Anthropic | `ANTHROPIC_API_KEY` + a Jev key, with `--provider anthropic` |

See [The four modes](modes.md) for what each of those actually does, and what it costs.

## Next

- [The four modes](modes.md)
- [What Jev is](../concepts/what-is-jev.md)
- [CLI reference](../reference/cli.md)
