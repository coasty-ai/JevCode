# Providers and the model catalogue

Two different services sit behind a JevCode run, and they are not interchangeable.

The **generator** is an ordinary chat model that writes code. It speaks a messages-and-tools
API, it streams, and it is billed per input and output token. Seven generator providers are in
the registry.

The **decider** answers structured questions — a choice among named options, a calibrated
probability, an ordinal score — and returns numbers rather than prose. It is reached at two
endpoints, and it is priced per input token with a zero output rate.

Keeping them apart is why the registry has seven rows and not eight.

## The seven generator rows

| Id | Display name | Key variable | Base URL | Default model |
| --- | --- | --- | --- | --- |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | `claude-sonnet-5` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `z-ai/glm-5.3-flash` |
| `openai` | OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-5.6-terra` |
| `gemini` | Google Gemini | `GEMINI_API_KEY`, then `GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.8-flash` |
| `xai` | xAI | `XAI_API_KEY` | `https://api.x.ai/v1` | `grok-4.7` |
| `fireworks` | Fireworks AI | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/glm-5p3-flash` |
| `meta` | Meta | `META_API_KEY`, then `MODEL_API_KEY` | `https://api.meta.ai/v1` | `muse-spark-1.3` |

Where a provider names two variables, JevCode's own spelling is tried first and the vendor
software development kit's spelling second.

The list order is load-bearing: the model picker breaks a score tie on it, so of two equally
good models the one from the provider earlier in the list wins.

Capabilities are declared per row. Six rows declare tools, structured output, reasoning and
vision. The `meta` row declares no structured-output surface and no vision, and carries an
explicit note that its API rejects a forced tool choice — a named or required choice is
downgraded to automatic, and the client uses the non-streaming surface because streaming there
drops tool calls and usage.

<!-- src/provider/ids.ts:18-60; src/provider/registry.ts:174-256 -->

## Why `typesafe` is deliberately not a row

`typesafe` is the decider endpoint, not a chat surface. It serves decisions: no messages, no
tools, no streaming, nothing a generator adapter could be built on. Giving it a registry row
would put it in the model picker and in `--provider`, where it cannot work.

The decider keeps its own two-row table instead.

| Decider provider | Host | Key variable | Default model | Accepted aliases |
| --- | --- | --- | --- | --- |
| `openrouter` | `openrouter.ai` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13-20260917` | `jev-1.13`, `jev-latest` |
| `typesafe` | `api.typesafe.ai` | `TYPESAFE_API_KEY` | `jev-1.13.0` | `jev-latest` |

Both rows price input per token with an output rate of zero. The two id spellings name the same
weights, and a table of equivalences lets a resumed run recognise that its decider provider
changed without its model changing.

`decider.provider` defaults to `auto`, which resolves in a fixed order: an explicit base URL
that names a host wins, then a configured decider key, then a TypeSafe key, then an OpenRouter
key. `jevcode config` prints which rule fired.

<!-- src/provider/registry.ts:10-14; src/jev/providers.ts:33-66; src/config/resolve.ts:360-372 -->

The two test doubles, `mock` and `null`, are not registry rows either. The null provider is what
the decider-only engine mode puts in the generator slot so that any generator usage is visibly
an error rather than a silent cost.

## The catalogue

A model picker needs hundreds of rows with prices, context windows and capabilities. Fetching
those takes a network round trip per provider, and the first frame must not wait for one. The
catalogue therefore has three layers, and a picker uses them in this order.

**First frame: no input or output at all.** A bundled snapshot returns every provider's
flagship models with prices, windows and capabilities. It is compiled in, so it needs no key, no
network and no disk. Paint it immediately.

**Behind the frame: refresh what has a key.** Each provider with a key is refreshed from the
network, falling back to `~/.jevcode/models/<provider>.json` and then to the snapshot. The cache
lives for 24 hours. Revalidation by entity tag is supported, but on the day the adapters were
written no provider offered one, so a refresh should be budgeted as a full re-download.

The load never throws and never returns an empty list. Each result carries its source
(`network`, `cache` or `static`), when it was fetched, whether it is stale, and an optional
error — so a picker can say *why* it is showing yesterday's prices instead of silently showing
them.

**Every keystroke: rank, purely.** Ranking is synchronous, deterministic and side-effect free.
Each hit reports whether it matched exactly, by prefix, by word or fuzzily, so a picker can
highlight differently.

<!-- src/models/index.ts:1-40; src/models/cache.ts:22-23 CACHE_TTL_MS -->

The bundled snapshot carries its own provenance date and is refreshed by hand: re-run the list
endpoints, diff, and update the date. Treat its prices as a fallback, not as a live quote —
where a provider returns a cost with the response, that reported cost wins.

## Checking a key without spending anything

`verifyProvider` answers "does this key work" with exactly one request, and that request is
never a generation. There is no retry: a key check must answer now, and the caller decides
whether to offer another attempt.

The endpoint is chosen per provider. OpenRouter's model list answers without a key at all, so it
proves nothing; the check calls its key-info endpoint instead. xAI has a dedicated key-metadata
endpoint, which is smaller than its model list. Every other provider is checked against its own
model list, which also yields a model count worth showing.

Nothing from the response body is returned or logged. The result carries only whether it
worked, how long it took, which endpoint was used, a model count and a redacted error. The
redactor is never the identity function, because a gateway that echoes an authorisation header
into its error body would otherwise put the pasted key straight into the result.

<!-- src/models/verify.ts:1-18, :38-60 -->

## Pricing

Where the API reports a cost with the response, that number is used. Where it does not, a small
table of rates in USD per million tokens fills in. Two derived rates exist for providers that
publish neither: a cache read is taken as 0.1 times the input rate and a cache write as 1.25
times the input rate.

An unknown model gets zeros plus a warning that the caller surfaces once, so cost accounting is
visibly off rather than quietly wrong. A run against an unpriced model is refused unless you
opt in, and then it runs under a token cap derived from the spend cap instead of a dollar cap.

<!-- src/config/defaults.ts:20-22 CACHE_READ_FACTOR / CACHE_WRITE_FACTOR, :100-114 the table and lookupPricing -->

## Recommendations

For onboarding and the model command, a pure, synchronous shortlist ranks the catalogue for one
of two tasks and explains each row.

- **Generator**: tool calling is close to mandatory, structured output and a large context
  matter, price is a tie-breaker.
- **Decider**: price and structured output dominate; context barely matters.

Three budget ceilings are defined, measured on a blended input-heavy token mix: cheap at $1 per
million, balanced at $6, premium at $30.

<!-- src/models/recommend.ts:1-25 BUDGET_CAPS -->

## A rule worth knowing if you are reading the code

The file that owns the provider ids and their key variables has **zero imports** and must never
gain one, not even a type-only import. The configuration layer and the command-line parser run
before the first frame is painted and need the id list and the key names; for those two facts
they read that one file. Importing the registry instead would load seven HTTP clients to read
seven strings. A test reads the file as text and fails on an import statement, so the rule is a
gate rather than a convention.

<!-- src/provider/ids.ts:1-15 -->

## Related pages

- [Configuration](../operations/configuration.md) — how a provider, model and key are resolved.
- [Every JEVCODE_* switch](../operations/environment.md) — the variables named above.
- [The TUI](tui.md) — where the picker and the key wizard appear.
