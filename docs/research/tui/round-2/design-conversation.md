# JevCode TUI round 2 — Designer B: conversation, defaults, providers (D-A, D-B, D-C)

Written 2026-09-21 against the working tree at HEAD `080331a` (`src/core/types.ts` 1,540 lines, `src/cli/session.ts`
2,878, `src/loop/engine.ts` 2,693, `src/jev/client.ts` 447, `src/tui/App.tsx` 2,033) and the documents the round-2
brief names: `docs/TUI-DESIGN.md` (§0–3, §6–8, §15 item 20, §20, §24), `docs/TUI.md`, `docs/STATUS.md` "Interactive
TUI", `docs/research/tui/01-opencode.md` (§2.1–2.5, §8), `docs/research/tui/00-SUMMARY.md`, and the TypeSafe probe of
this morning, `docs/research/tui/round-2/typesafe-native-probe.md`. Line anchors are written `file:line` as of that
tree; a drifted line is found by the symbol named beside it. Product decisions D-A…D-E are fixed inputs; the visual
redesign (D-D) belongs to Designer A — every frame below uses D-D's vocabulary (rounded `╭─╮` boxes, chat bubbles,
a boxed three-zone status bar) only where a conversation state needs it, and Designer A's pixels win wherever the two
documents draw the same row.

This document is written to be implemented without questions by the owner slots of TUI-DESIGN §20: O1 (contract,
engine, Jev client), O6 (config), O7 (onboarding), O9 (Ink App), O10 (CLI, session controller, plain, pty, docs). A
new slot **O11 chat** owns `src/chat/**` and `test/unit/chat/**` (§5).

---

## 0. Thesis, and how the user's four requirements are met

**Thesis.** A submitted line is money today: every Enter starts intent → context → propose → risk → execute → judge
(`src/cli/session.ts:2568` `host.submit` → `startRun`, `:1428`). The user typed `hi` and watched a coding run start.
The fix is not a regex in front of the engine; it is the same design rule that already governs every other choice in
this harness — **Jev decides**. Every non-command submission first passes one Jev request (the INTAKE, §3) whose
answers say what the human meant, which short reply fits, and which facts about the tool they asked for; the
controller then does exactly one of five things, and only one of them costs a run. Because Jev answers a request of
any question count in one round trip (`docs/JEV-ONLY.md` "~170–250 ms per request regardless of question count";
the native endpoint measured 109–112 ms this morning, `typesafe-native-probe.md`), a greeting gets its reply in one
network hop for about eight hundredths of a cent.

| Requirement (user, verbatim in spirit) | Where | What changes |
| --- | --- | --- |
| (1) `jevcode` with no arguments; jev-only by default; switch to Jev + LLM in one step | §1, §6, §7 | `modeFromParsedFlags` (`src/config/resolve.ts:312`) and `modeFromFlags` (`src/cli/main.tsx:37`) default to `'jev-only'`; a new `mode` setting (flag > `JEVCODE_MODE` > `./.env` > file > default); the first-run wizard asks for the Jev key only; `/mode jev-on` (alias `/llm on`) opens the wizard's generator step in place when no generator key exists; the status bar carries the `jev-only` / `jev+llm` badge in every state |
| (2) opencode-grade cleanliness | Designer A (D-D) | this document supplies the conversation states' content and their identity rules (§3.8, §10) |
| (3) `hi` must not start a run; conversational in the highest degree | §3, §4, §5 | the INTAKE decision, the reply catalogue, the harness-fact answers, the honest jev-only code lookup, the jev+llm chat turn, the ambiguity row |
| (4) Jev through OpenRouter **and** TypeSafe's native API, both keys in `.env` | §2, §9.3 | `DeciderConfig.provider`, `--jev-provider` / `JEV_PROVIDER` with auto-detection (`TYPESAFE_API_KEY` → typesafe), per-provider base URL / model / headers / error mapping / cost derivation / pinned-id rule, `test:live` over both providers |

Standing rules kept from TUI-DESIGN (every one is a gate in D-E): the first frame is argv-only and touches no network;
zero clears after it; `<Static>` is the only scrollback writer; every visual has a `lines()` twin for `--plain`,
`--screen-reader` and `--ascii`; keys never reach logs; the review box owns its keys and nothing auto-approves; no new
runtime dependency; `transcript.log` / `--plain` / TUI line identity for the whole of a run (§15.1 of TUI-DESIGN —
chat happens while no engine is live, so its items are renderer-local exactly like today's `[ui]` items, §3.8).

**Reading order for implementers.** §8 (contract) first, then §5 (modules and signatures), §4 (the controller's
submit path), §3 (the intake, replies, facts, lookup, LLM turn, ambiguity), §2 (providers), §1 and §6–§7 (defaults,
wizard, badge), §9 (tests), §10 (frames), §11 (strings), §12 (risks).

---

## 1. D-A: `jevcode` alone, jev-only by default, one step to jev+llm

### 1.1 What "zero arguments" resolves to today, and what it resolves to after

Today `parseCliArgs([])` is `{ command: 'chat' }` (`src/cli/args.ts`, TUI-DESIGN §1) and the session opens with
`baseMode = modeFromParsedFlags(flags)` = `'jev-on'` (`src/cli/session.ts:811`, `src/config/resolve.ts:312-315`). A
keyless user therefore meets the wizard's **generator** step first (`onboardingReducer` `startFromDetect`,
`src/tui/onboarding/reducer.ts:207-212`: `needsGenerator(s)` is true for every mode but `jev-only`), is asked for a
provider and two keys, and the assistant message the user replied to had to spell out `--provider openrouter --model
anthropic/claude-sonnet-5`. After this round:

- `jevcode` (and `jevcode chat`, and `jevcode run` with no task on a TTY) opens a **jev-only** session. Nothing
  about the argv-only first frame changes (TUI-DESIGN §1: header, rule, composer, status from argv/env/isTTY/cwd);
  the mode word reaches the frame as the status badge `jev-only` (§7) because the default needs no file.
- A session needs **one** key — the Jev key — from any of: `--jev-api-key` (scripts only), `JEV_API_KEY`,
  `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `./.env`, `<extra .env file>`, or the credentials file written by
  the wizard (`jevApiKey`, `src/config/credentials.ts`). `missingSecrets('jev-only')` already returns only
  `decider.apiKey` (`src/config/resolve.ts:564-568`) and `buildProvider` already installs the `NullProvider` for
  jev-only (`src/cli/session.ts:457-460`); `config.generator()` is never called (§15.3 of TUI-DESIGN, kept).
- `jevcode run "<task>"` (one-shot) is jev-only by default too; `--mode jev-on` restores today's behaviour.
- The bench keeps its own default `--conditions jev-on,jev-off` (`src/cli/args.ts:252`); nothing in `src/bench/**`
  or `src/synth/**` changes (F13's `src/synth/**` untouched rule holds).

### 1.2 `mode` becomes a setting, not only a flag

Add to `SettingName` (`src/config/types.ts:6`) and to `SETTINGS` (`src/config/defaults.ts:67`), directly after the
`decider.*` rows:

```ts
// src/config/defaults.ts — new row (O6)
{ name: 'mode', flag: 'mode', env: ['JEVCODE_MODE'], fileKey: 'mode', defaultValue: 'jev-only', secret: false,
  description: 'engine mode (jev-only | jev-on | jev-off); jev-only needs no generator key' },
```

`resolveConfig` (`src/config/resolve.ts:351`, `const mode = opts.mode ?? modeFromParsedFlags(flags)`) becomes
`const mode = opts.mode ?? resolveMode(layers)` where `resolveMode` reads the new row through `lookup` (flag > env >
`./.env` > file > default) and validates it (`ConfigError` `mode: "<v>" (from <source>) is not one of
jev-only|jev-on|jev-off`); `--condition` stays the hidden alias folded into `flags.mode` by `args.ts:623-634`. The
resolved mode is recorded (`entries.set('mode', …)`), so `jevcode config` prints `mode  jev-only  default` and
`run.json.config.mode` records it (the mode already rides `RunMeta.mode`; the record row adds the source). The
mode-keyed spend-cap default (`defaultRunSpendCapUsd(mode)`, `resolve.ts` after `TRACE_ENV`) is unchanged: **$0.25
run / $1.25 session under jev-only**, $2.00 / $10.00 under jev-on (`JEV_ONLY_DEFAULT_SPEND_CAP_USD`,
`SESSION_CAP_MULTIPLIER`, `src/config/defaults.ts:13-15`). Chat spend (§3.9) is charged to the **session** meter and
shows in `sess $x.xx/1.25` from the first reply.

`ResolvedConfig` (`src/core/types.ts:1358`) gains `readonly mode: EngineMode` (§8 item 7). The session controller's
`baseMode` (`src/cli/session.ts:811`) is initialised from `modeFromParsedFlags(flags)` for the ~100 ms before
`resolveConfig` resolves (the badge of the first frame) and then set to `config.mode` in `startup()` right after
`config = await resolveConfig(…)` (`:2697`). `jevcode config set mode jev-on` persists the preference through
`writeConfigValue` (`src/config/credentials.ts`, the non-secret file writer that `config set` already uses).

`modeFromParsedFlags` (`resolve.ts:312`) and `modeFromFlags` (`main.tsx:37`) both change their fallback to
`'jev-only'`; both keep accepting `jev-off`. The `--mode` help text (`args.ts:238`) becomes `engine mode: jev-only
(default; no generating LLM), jev-on (Jev + LLM), jev-off (generator only)`; the usage lines at `args.ts:676,680`
reorder the enum to `jev-only|jev-on|jev-off`.

### 1.3 Switching: `/mode jev-on`, alias `/llm on`

The registry row `mode` (`src/tui/commands/registry.ts:316-325`) keeps its enum and gains no-argument form; a new
row `llm` is a pure alias with a friendlier argument:

```ts
// src/tui/commands/registry.ts — the `mode` row changes; the `llm` row is new (O3)
{ name: 'mode', aliases: [], args: [{ name: 'm', kind: 'enum', values: ['jev-only', 'jev-on', 'jev-off'], optional: true, hint: '[jev-only|jev-on|jev-off]' }],
  availableDuringTask: 'any', plain: 'yes', title: 'engine mode: show, or set for the next run',
  usage: '[jev-only|jev-on|jev-off]', semantics: 'no argument: current and next mode; with one: pending for the **next** run (memory); `jev-on` with no generator key opens the wizard\'s generator step in place; persist with `jevcode config set mode <m>`', category: 'config' },
{ name: 'llm', aliases: [], args: [{ name: 'state', kind: 'enum', values: ['on', 'off'], hint: '<on|off>' }],
  availableDuringTask: 'any', plain: 'yes', title: 'Jev + LLM on (= /mode jev-on) or off (= /mode jev-only)',
  usage: '<on|off>', semantics: '`/llm on` = `/mode jev-on`, `/llm off` = `/mode jev-only`', category: 'config' },
```

`CommandAction` (`src/tui/commands/dispatch.ts:57`) widens to `{ kind: 'mode'; mode: EngineMode | null }`; the
dispatcher maps `/llm on` → `{ kind: 'mode', mode: 'jev-on' }` and `/llm off` → `{ kind: 'mode', mode: 'jev-only' }`.
`scripts/gen-docs.mjs` regenerates `docs/COMMANDS.md`, the man page and the completions from the table (the sync test
`test/unit/tui/commands/registry.test.ts` catches a stale copy).

Controller semantics (`src/cli/session.ts:2464-2467` `case 'mode'` is replaced):

```ts
// src/cli/session.ts — execute(), case 'mode' (O10)
case 'mode': {
  const cur = live() && current ? currentRunMode : (pending.mode ?? baseMode);      // the live run's mode while live
  if (a.mode === null) { note(modeShowText(cur, pending.mode ?? baseMode)); return; } // `mode jev-only (next run: jev-only)`
  if (a.mode === (pending.mode ?? baseMode)) { note(`mode ${a.mode} already`); return; }
  if (config && config.missingSecrets(a.mode).length > 0) {
    // D-A: the wizard's generator step opens in place; §11.1's reopen path with reason 'mode'
    const saved = await runLogin('mode', a.mode);
    if (!saved) { note(`mode stays ${pending.mode ?? baseMode} — no generator key was saved`, { level: 'warn' }); return; }
  }
  pending.mode = a.mode;
  renderer.dispatch?.({ type: 'next-mode', mode: a.mode });                          // the badge follows at once (§7)
  note(a.mode === 'jev-only' ? MODE_JEV_ONLY_SET : a.mode === 'jev-on' ? MODE_JEV_ON_SET : MODE_JEV_OFF_SET);
  return;
}
```

with the strings (§11): `MODE_JEV_ON_SET = 'mode jev+llm from the next run — Claude writes the code, Jev still decides
every step (persist: jevcode config set mode jev-on)'`, `MODE_JEV_ONLY_SET = 'mode jev-only from the next run — no
generating LLM; code proposes, Jev decides, tests verify'`, `MODE_JEV_OFF_SET = 'mode llm-only from the next run —
the generator alone, no Jev (bench condition; reviews still ask)'`. `runLogin(reason, mode)` (`session.ts:1261`)
gains the `reason` value `'mode'` and an explicit target mode, computes `missing = config.missingSecrets(mode)` for
**that** mode (today it reads `pending.mode ?? baseMode`, which would still be jev-only) and hands the wizard
`reason: 'mode'`; §6 has the wizard side. A `/mode jev-on` while a run is live is allowed (the row is `any`); it
applies to the next run and the badge shows the live mode until `run:end`, then the pending one (§7.2).

`PendingSettings.mode` (`session.ts:411`) and `reresolve()` (`:1233`) are unchanged: `startRun` already re-resolves
with `pendingFlagOverrides()` when `pending.mode` is set (`:1438-1440`), so the next run's spend-cap default, session
cap (`newSessionMeter()` at `:1451` happens once; a mode change after the first run keeps the session cap — document
in `/cost`'s `pending:` line), provider and decider follow the new mode.

### 1.4 What a jev-only first run looks like, end to end

`jevcode` → first frame (argv only, badge `jev-only`) → `resolveConfig` → `missingSecrets('jev-only')` = `['decider.apiKey']`
unless `.env` or the environment holds `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `JEV_API_KEY` → wizard (§6: **Jev
provider pick only when it cannot be inferred**, then the masked Jev key, save, optional verify, trust, sandbox line)
→ composer with the chat placeholder (§7.3) → the human types anything → INTAKE (§3). With the user's `.env`
(`TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` present, no `JEV_API_KEY`) the wizard never appears: provider auto =
`typesafe` (§2.3), key = `TYPESAFE_API_KEY`, and the first submission answers in one Jev round trip.

---

## 2. D-B: the Jev provider abstraction (TypeSafe native and OpenRouter)

### 2.1 The two endpoints as measured

| | OpenRouter decisions router (today's path) | TypeSafe native |
| --- | --- | --- |
| URL | `POST https://openrouter.ai/api/alpha/decisions` (`src/jev/types.ts:12`) | `POST https://api.typesafe.ai/v1/systemone` (probe) |
| Auth | `Authorization: Bearer <OPENROUTER_API_KEY or JEV_API_KEY>` + `HTTP-Referer` + `X-Title` (`src/jev/client.ts:277-282`) | `Authorization: Bearer <TYPESAFE_API_KEY>`; no referer/title headers |
| Body | `{ model, state, questions }` | identical |
| Model ids | `typesafe/jev-1.13-20260917` (pinned default), `typesafe/jev-1.13`, `jev-1.13` (`docs/RESEARCH.md:258`) | `jev-1.13.0` (TypeSafe's versioned id; served for the alias too), `jev-latest`; **400 for** `jev-1.13`, `typesafe/jev-1.13`, `jev-1.13-20260917` (probe table) |
| Response | `{ model, answers, usage: { input_tokens, output_tokens, cost }, id: 'gen-dec-…', provider: 'TypeSafe' }`; headers `x-generation-id`, `x-provider-name` | `{ model: 'jev-1.13.0', usage: { input_tokens, output_tokens } }` — **no `cost`**, no `id`, no `provider`; header `x-typesafe-request-id` on every response |
| Errors | 400 `{ error: { message, code } }` (zod and upstream shapes, `test/fixtures/jev/live-probe.json` `errors`) | 400 `{ detail: { error_type: 'api_usage_error', message: 'Unknown model: …' } }` (probe); 422 on malformed bodies (REPORT); 401 on a bad key |
| Price | `usage.cost = input_tokens × 4.2e-8` exactly (`RESEARCH.md:288`) | none on the wire; published $0.042 per million input tokens, output free |
| Latency | ≈ 237 ms p50 in the 30-task run (`STATUS.md`) | 109–112 ms per request (probe, California → api.typesafe.ai) |
| Limits | OpenRouter's | 1,200 requests/min, 250,000 tok/s (`RESEARCH.md:270`); irrelevant for an interactive session (≤ 2 requests per submission) |

### 2.2 `DeciderConfig.provider` and the provider table

```ts
// src/core/types.ts:1349 — DeciderConfig (O1; §8 item 2 has the diff against HEAD)
export type JevProvider = 'typesafe' | 'openrouter';
export interface DeciderConfig {
  provider: JevProvider;
  baseUrl: string;
  apiKey: string;
  /** configured id, verbatim */
  model: string;
  /** pinned per provider: openrouter = normalised id ends in -YYYYMMDD; typesafe = jev-<major>.<minor>.<patch> */
  pinned: boolean;
  /** cost derivation when usage.cost is absent (typesafe); USD per input token, output free */
  pricing: { inputUsdPerToken: number; outputUsdPerToken: number };
  /** how the provider was chosen — printed by `jevcode config` and `/jev` */
  providerSource: 'flag' | 'env' | `dotenv:${string}` | `file:${string}` | 'auto:base-url' | 'auto:typesafe-key' | 'auto:openrouter-key' | 'default';
}
```

```ts
// src/jev/providers.ts — NEW, pure (O1)
export interface JevProviderSpec {
  readonly name: JevProvider;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** env names for decider.apiKey after JEV_API_KEY (which always comes first, §2.3) */
  readonly keyEnv: string;
  readonly headers: (apiKey: string) => Record<string, string>;
  readonly requestIdHeaders: readonly string[];
  readonly isPinned: (normalisedId: string) => boolean;
  readonly aliases: readonly string[];
  readonly pricing: { inputUsdPerToken: number; outputUsdPerToken: number };
  readonly displayHost: string;
}
export const JEV_PROVIDERS: Readonly<Record<JevProvider, JevProviderSpec>> = {
  openrouter: {
    name: 'openrouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', defaultModel: 'typesafe/jev-1.13-20260917', keyEnv: 'OPENROUTER_API_KEY',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'HTTP-Referer': DEFAULT_REFERER, 'X-Title': APP_TITLE }),
    requestIdHeaders: ['request-id', 'x-request-id', 'x-generation-id'],
    isPinned: (id) => /-\d{8}$/.test(id), aliases: ['jev-1.13', 'jev-latest'],
    pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 }, displayHost: 'openrouter.ai',
  },
  typesafe: {
    name: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1/systemone', defaultModel: 'jev-1.13.0', keyEnv: 'TYPESAFE_API_KEY',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    requestIdHeaders: ['x-typesafe-request-id', 'request-id', 'x-request-id'],
    isPinned: (id) => /^jev-\d+\.\d+\.\d+$/.test(id), aliases: ['jev-latest', 'jev-1.13'],
    pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 }, displayHost: 'api.typesafe.ai',
  },
};
/** the same weights under two naming schemes (REPORT §1 + this morning's probe): used by --resume reconciliation only */
export const EQUIVALENT_IDS: ReadonlyArray<readonly [openrouter: string, typesafe: string]> = [['jev-1.13-20260917', 'jev-1.13.0']];
export function providerForHost(baseUrl: string): JevProvider | null;   // 'api.typesafe.ai' → typesafe; 'openrouter.ai' → openrouter; else null
```

`src/jev/types.ts` keeps `DEFAULT_JEV_MODEL` / `DEFAULT_JEV_BASE_URL` as the OpenRouter values (every existing import
and test compiles) and gains `DEFAULT_TYPESAFE_MODEL = 'jev-1.13.0'`, `DEFAULT_TYPESAFE_BASE_URL`; `JEV_INPUT_USD_PER_TOKEN`
stays `4.2e-8` (the published $0.042/M) and is the `pricing.inputUsdPerToken` of both providers.

### 2.3 Configuration: `--jev-provider`, `JEV_PROVIDER`, auto-detection, precedence

New rows in `SETTINGS` (`src/config/defaults.ts:77-79` neighbourhood) and `SettingName`:

```ts
{ name: 'decider.provider', flag: 'jevProvider', env: ['JEV_PROVIDER'], fileKey: 'jevProvider', defaultValue: 'auto', secret: false,
  description: 'Jev provider (auto | typesafe | openrouter); auto = typesafe when TYPESAFE_API_KEY is set, else openrouter' },
```

`STRING_FLAGS` (`src/cli/args.ts:25-46`) gains `'jevProvider'`; `FLAG_SPECS` gains `{ key: 'jevProvider', name:
'jev-provider', type: 'string', commands: COMMON, arg: 'auto|typesafe|openrouter', help: 'Jev provider (default auto:
typesafe when TYPESAFE_API_KEY is set, else openrouter)' }`; `oneOf(command, 'jev-provider', …)` validates at parse time
like `--mode`.

Resolution order inside `resolveConfig` (the block at `resolve.ts:419-420` that prepends the generator's
provider-specific env name is the model):

1. `decider.provider` through `lookup`: flag > `JEV_PROVIDER` > `./.env` > `<extra .env file>` > file `jevProvider`
   > default `auto`. A value other than `auto|typesafe|openrouter` is a `ConfigError` (exit 2) naming the source.
2. `auto` resolves, in this order (the first rule that fires wins; the source records which):
   - a configured `decider.baseUrl` (any layer but default) whose host `providerForHost` recognises → that provider
     (`auto:base-url`);
   - `JEV_API_KEY` set (env or dotenv) → `openrouter` (`auto:openrouter-key`) — today's users configured that variable
     for OpenRouter and must not be redirected to a host their key does not belong to;
   - `TYPESAFE_API_KEY` set (env or dotenv, or the file's `jevProvider` absent but `typesafeApiKey` present) → `typesafe`
     (`auto:typesafe-key`);
   - `OPENROUTER_API_KEY` set → `openrouter` (`auto:openrouter-key`);
   - nothing → `openrouter` with source `default` (the wizard asks, §6; nothing is sent).
3. With the provider known, `layers.extraEnv['decider.apiKey'] = [JEV_PROVIDERS[p].keyEnv]` is **appended after**
   `JEV_API_KEY` (the `SETTINGS` row for `decider.apiKey` becomes `env: ['JEV_API_KEY']` and the provider name is added
   per resolution, exactly as `generator.apiKey` gets `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` at `resolve.ts:419`).
   The consulted list therefore reads `--jev-api-key (flag), JEV_API_KEY / TYPESAFE_API_KEY (env), … (dotenv:…),
   jevApiKey (file:…)`.
4. `decider.baseUrl` and `decider.model` default to the provider's values when unset (`entries.set(name, { value,
   source: 'default' })`, the mode-keyed spend-cap idiom); a configured value wins. A configured model is validated
   per provider by `validateDecider` (§2.5).

With the user's `.env` — `TYPESAFE_API_KEY=…`, `OPENROUTER_API_KEY=…`, `ANTHROPIC_API_KEY=…`, no `JEV_API_KEY` —
auto resolves to **typesafe** (`auto:typesafe-key`), key `TYPESAFE_API_KEY` (`dotenv:<cwd>/.env`), model
`jev-1.13.0`, base URL `api.typesafe.ai`. `jevcode --jev-provider openrouter` flips to OpenRouter with
`OPENROUTER_API_KEY` and `typesafe/jev-1.13-20260917`. Both are exercised by `test:live` (§9.3).

**Redaction.** `TYPESAFE_API_KEY` joins the `SecretSet` twice over: as the resolved `decider.apiKey` (named
`decider.apiKey` in markers, `resolve.ts:478-481`) and as a `.env` variable whose name matches `SECRET_NAME_RE`
(`/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i`, `src/core/redact.ts`, `resolve.ts:482`). No format pattern is added for
TypeSafe keys: their prefix shape is unknown to this document (the key was never read while writing it), the exact
layer covers the configured value, and a wrong pattern would either miss or mangle ordinary output (§8.4 of DESIGN:
no generic long-token rule). The wizard's prefix hint (`looksLikeKey`, `src/tui/onboarding/reducer.ts:130`) returns
`true` for the typesafe provider (no known prefix → no warning), and `KEY_PREFIXES` gains no typesafe entry. The
`[setup]` items print fingerprints only, as today.

### 2.4 Client: headers, request id, error mapping, cost derivation

`createJevDecider(cfg, deps)` (`src/jev/client.ts:246`) reads `JEV_PROVIDERS[cfg.provider]`:

- `headers = spec.headers(cfg.apiKey)` replaces the literal at `client.ts:277-282`. `deps.referer` still overrides the
  OpenRouter referer.
- `requestIdOf(h, redact, spec.requestIdHeaders)` replaces the fixed three-header chain at `client.ts:168-173`; the
  typesafe id (`x-typesafe-request-id`) is redacted and clipped to `REQUEST_ID_MAX_CHARS` like `x-generation-id` and
  rides `JevHttpError.requestId` → the §13.2 `last: … · request-id <id>` row and `SerializedError.requestId`.
- `errorHint(text)` (`client.ts:197-207`) reads, in order, `error.message` (OpenRouter), `detail.message`
  (TypeSafe `api_usage_error`), a string `detail`, then the body; still ≤ 200 chars, redacted before the clip.
- **Unknown model on the first call is configuration, not an outage.** In `attempt()` after `httpError(...)` is built:
  a status **400 or 422** whose hint matches `/unknown model/i` (TypeSafe) or `/is not a valid model|no endpoints found/i`
  (OpenRouter) throws `new ConfigError(\`--jev-model: "${cfg.model}" is not served by ${spec.displayHost} (${hint});
  ${spec.name === 'typesafe' ? 'TypeSafe accepts jev-1.13.0 or jev-latest' : 'OpenRouter accepts typesafe/jev-1.13-20260917 or typesafe/jev-1.13'}\`,
  { setting: 'decider.model' })` — exit 2, never retried, never billed (the probe shows no `usage` on a 400). The
  session controller renders it as `[ui] error: config: --jev-model: …` and stays idle; a one-shot run exits 2.
- 422 stays non-retryable (`isRetryableStatus(422)` is already `false`); 401/403 keep the key-rejected pane (§13.3 of
  TUI-DESIGN); 429 keeps `Retry-After` handling.
- `validateUsage` (`src/jev/validate.ts:146-153`) makes `cost` optional: `JevUsage.cost?: number` (§8 item 3); a present
  non-finite or negative cost still fails transient. In `ask()` (`client.ts:388-395`):

```ts
const provided = response.usage.cost;
const table = response.usage.input_tokens * cfg.pricing.inputUsdPerToken + response.usage.output_tokens * cfg.pricing.outputUsdPerToken;
const costUsd = typeof provided === 'number' ? (Number.isFinite(provided) ? provided : Number.NaN) : table;
const usage: TokenUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, costUsd, calls: 1 };
return { answers: response.answers, usage, latencyMs, model: response.model, requestHash, attempts, id: response.id ?? h.generationId ?? requestId ?? null, costBasis: typeof provided === 'number' ? 'provider' : 'table' };
```

  `AskResult.costBasis?: 'provider' | 'table'` (§8 item 4). The engine's `noteUsage` (`engine.ts:1553`) is unchanged
  (a finite cost); the meter is unchanged. `costBlock` (`src/tui/budget/lines.ts:322`) prints the basis line as `jev
  table $0.042/M input, output free (typesafe)` when every recorded Jev request had `costBasis === 'table'`, else
  `jev provider usage.cost`; the `~` table-priced marker the generator uses (`gen $x (~ table-priced)`) is reused:
  `jev $0.003 (~ table-priced)`.
- `Decider` gains `readonly provider: JevProvider` (§8 item 5) so `/jev` and the drift pane name the host without a
  config lookup.

### 2.5 Model ids, pinning and the drift check per provider

`normaliseJevModelId` (`src/config/validate.ts:84`) and `normaliseModelId` (`client.ts:29`) keep lower-casing and
stripping `typesafe/`. Pinning becomes provider-aware:

```ts
// src/config/validate.ts (O6) and src/jev/client.ts (O1) — one rule, exported from src/jev/providers.ts
export function isPinnedJevModel(id: string, provider: JevProvider): boolean { return JEV_PROVIDERS[provider].isPinned(normaliseModelId(id)); }
export function jevModelMatches(configured: string, served: string, provider: JevProvider): boolean {
  const c = normaliseModelId(configured); const s = normaliseModelId(served);
  if (isPinnedJevModel(configured, provider)) return c === s;
  if (c === 'jev-latest') return s.startsWith('jev-');                     // the alias resolves to whatever TypeSafe serves today
  return s === c || s.startsWith(`${c}-`) || s.startsWith(`${c}.`);       // `jev-1.13` → `jev-1.13-20260917` (openrouter) or `jev-1.13.0` (typesafe)
}
```

`checkServedModel(configured: { model; pinned; provider }, served, resolved)` (`client.ts:46-60`) and
`EngineImpl.checkModelDrift` (`engine.ts:1656-1693`) call `jevModelMatches` instead of their inline prefix tests;
`EngineOptions.deciderModel` (`types.ts:987`) gains `provider: JevProvider`. `validateDecider` (`validate.ts:181-194`)
accepts `^[a-z0-9][a-z0-9._/-]*$` and rejects a model that is **known to belong to the other provider** before any
network call: `typesafe/…` or a `-YYYYMMDD` id under `typesafe`, or `jev-\d+\.\d+\.\d+` under `openrouter`, is
`ConfigError` `decider.model: "<id>" (from <source>) is an OpenRouter id; the typesafe provider serves jev-1.13.0
(or pass --jev-provider openrouter)` — the probe's four 400s become one offline message. `TypeSafe accepts` /
`OpenRouter accepts` example ids live in `JEV_PROVIDERS[p].defaultModel` and `aliases`.

Drift semantics are otherwise unchanged: alias → `jev model alias jev-latest resolved to jev-1.13.0; pin it with
--jev-model jev-1.13.0 for reproducible thresholds` (`engine.ts:1667`); first-call mismatch → the `drift` blocking
pane with `[p] pin --jev-model jev-1.13.0 for the next run` (`driftDetail`, `src/tui/blocking/lines.ts:77`), later
mismatch → `jevModelDrift` recorded and the `!` warning. **`jev-1.13.0` is the pinned resolution on TypeSafe** exactly
as `typesafe/jev-1.13-20260917` is on OpenRouter: `RunResult.resolvedJevModel` holds the served string verbatim.

`--resume` reconciliation (`reconcileResumeConfig`, `resolve.ts`): `run.json.config` gains the `decider.provider` row,
so `ResumeIdentity` gains `jevProvider: string | null`. A resume whose provider differs from the run's: allowed when
`EQUIVALENT_IDS` maps the run's resolved model to the new provider's configured/default model (warning item
`[run] decider provider changed openrouter → typesafe (same weights: jev-1.13-20260917 ≡ jev-1.13.0)`), else
`ConfigError` `--resume: run <id> used decider.provider openrouter with typesafe/jev-1.13-20260917; pass --jev-provider
openrouter, or start a follow-up`. A run started before this round (no `decider.provider` row) reads as `openrouter`.

### 2.6 `jevcode config` rows and `/jev`

`jevcode config` (`src/cli/config-table.ts`) prints, in record order:

```
decider.provider  typesafe                               derived (auto: TYPESAFE_API_KEY is set)
decider.baseUrl   https://api.typesafe.ai/v1/systemone   default (typesafe)
decider.apiKey    <dotenv:/Users/me/proj/.env> (sha256:3f9a2c1d)  dotenv:/Users/me/proj/.env
decider.model     jev-1.13.0                             default (typesafe)
mode              jev-only                               default
```

`DERIVATIONS` (`config-table.ts:17`) gains `'decider.provider': 'auto: <rule>'` rendered from `providerSource`;
provider-keyed defaults print `default (<provider>)` through a new `defaultQualifier(setting, record)` that reads the
`decider.provider` row. `--json` prints the raw record (`source: 'derived'`, `value: 'typesafe'`) plus
`providerSource`.

`/jev` (`session.ts:2206-2228`) becomes a three-line block:

```
[ui] jev
  typesafe · api.typesafe.ai · jev-1.13.0 (pinned) → resolved jev-1.13.0
  questions 212 · latency p50 112 ms · p95 189 ms · jev cost $0.003 (~ table-priced: $0.042/M input, output free)
  intake: 4 messages · p50 118 ms · $0.0003 · last: greeting_or_smalltalk 0.94
```

Line 1 reads `decider.provider`, host, model, `pinned`/`alias`, `resolvedJevModel`, and ` · drift@step N → <served>`
when set; line 2 is today's line with the basis suffix; line 3 is new (§3.9: the chat ledger). Under OpenRouter line
1 reads `openrouter · openrouter.ai · typesafe/jev-1.13-20260917 (pinned) → resolved typesafe/jev-1.13-20260917` and
line 2's suffix is `(provider usage.cost)`.

### 2.7 Verification (`[y] verify` in the wizard, `jevcode login --verify`)

`verifyKeys` (`src/cli/login.ts:240-268`) checks the Jev key with OpenRouter's `GET /api/v1/key` today. TypeSafe has
no key-status endpoint this document could verify (UNVERIFIED), so under `typesafe` the Jev check is **one priced
decision**: the 319-token Noul probe of this morning (`{ message: 'hi' }`, one Noul) costs 319 × 4.2e-8 = $0.0000134.
`WIZARD_VERIFY_DETAIL` (`src/tui/onboarding/lines.ts:45`) becomes provider-keyed: `one Jev decision at api.typesafe.ai
~$0.00002 (jev-1.13.0)` / today's text for OpenRouter. `VerifyInput` gains `jevProvider: JevProvider`. Exit codes and
the `verified:` / `verification failed:` items are unchanged.

---

## 3. D-C: the conversational intake

### 3.1 One request, five outcomes

Every composer submission that `routeSubmit` classifies as `submit` (`src/tui/composer/submit.ts`, `SubmitDecision`
kind `'submit'`; slash lines, steers, the secret gate and chips are unchanged) reaches `host.submit()`
(`src/cli/session.ts:2568`). Today that is `startRun`. After this round it is `converse(text, opts)` (§4), whose first
act is **one** Jev request carrying three question groups:

| Group | Questions | Consumed by |
| --- | --- | --- |
| A — intake | `intake` (Choice, 5 options + `none_of_these`) and its five paired Nouls `can_<option>` | `resolveChoice` (`src/loop/stages/choose.ts:45`) with `fallback: 'ambiguous'`, then the run floor (§3.3) |
| B — reply | `reply` (Choice over the 14-entry catalogue + `none_of_these`) | used only when A resolves `greeting_or_smalltalk`, or after `[n]` on the ambiguity row |
| C — facts | 13 Nouls `about_<fact>` | used only when A resolves `question_about_this_tool`, or after `[n]` |

Jev answers a request of any question count in one round trip (JEV-ONLY.md "~170–250 ms per request regardless of
question count"; native 109–112 ms measured), so folding B and C into the intake request costs tokens, not time,
and a greeting is answered in **one network hop**. Token estimate (REPORT §4: 271 fixed + ≈ 9 per short Noul +
0.196 tokens/char): state ≈ 600 chars → 120; group A ≈ 2,400 chars → 470; group B (14 options × ~110 chars) → 300;
group C (13 Nouls × ~180 chars) → 460; ≈ **1,650 input tokens ≈ $0.00007** per message at $0.042/M. A thousand
greetings cost seven cents. Output tokens are free.

The five outcomes and what each costs:

| `intake` resolution | The controller does | Jev requests | Money |
| --- | --- | --- | --- |
| `greeting_or_smalltalk` | appends the `[jevcode]` bubble chosen by `reply` (§3.4) | 1 (the intake) | ≈ $0.00007 |
| `question_about_this_tool` | assembles the bubble from the facts whose `about_*` Noul is ≥ 0.5 (§3.5) | 1 | ≈ $0.00007 |
| `question_about_the_code` | jev-only: the honest lookup (§3.6.1), one more request; jev+llm: one generator turn, no tools (§3.6.2) | 2 / 1 + LLM | ≈ $0.0001 / LLM tokens |
| `coding_task` | today's `startRun` (§3.7) | the run's | the run's |
| `ambiguous` (incl. fallback) | the one-row `run this as a task? [y] / just chatting [n]` overlay (§3.8); never a silent run | 1 (+ the run on `y`) | ≈ $0.00007 |

### 3.2 The intake state (tiny, code-computed, redacted)

```ts
// src/chat/intake.ts (O11) — the state Jev sees; every string passes `redact` and the bounds below
export interface IntakeStateInput {
  message: string;                       // the submission, ≤ 1,200 chars (head 1,000 + ' … ' + tail 200 via headTail)
  conversation: readonly ChatTurn[];     // the last ≤ 6 turns, each { role: 'you' | 'jevcode', text ≤ 200, kind?: IntakeKind }
  workspace: { name: string; git: boolean; hasTests: boolean; testRunner: TestRunner | null; files: 'none' | 'few' | 'some' | 'many' }; // buckets: 0 / < 20 / < 500 / ≥ 500 candidates
  session: { mode: EngineMode; runs: number; lastRun: { task: string /* ≤ 120 */; stopReason: StopReason; steps: number; testsAllPassed: boolean | null } | null; pendingMode: EngineMode | null };
  mentions: readonly string[];           // `@path` mentions found by mentionedPaths(), ≤ 5, paths only
}
export function buildIntakeState(i: IntakeStateInput, redact: (s: string) => string): JsonObject;
```

No counts Jev would have to compute (REPORT rule "no counting": the file bucket words replace a number; `runs` is a
fact Jev reads, not something it counts); every path is written back-ticked inside instructions; the workspace name is
`basename(realpath)`; nothing from `.env`, the credentials file or a paste body (chips are expanded into `message` by
`expandChips` before intake — a pasted key already went through the secret gate and its span was `addSecret`ed, so
`redact` masks it in the state as `[REDACTED:composer#n]`, the same rule steers follow at `engine.ts` `steer()`).

### 3.3 Group A: the `intake` Choice and its paired Nouls (REPORT rules: escape option, criteria = definition + examples, descriptive keys, backticked paths, no counting)

```ts
// src/chat/intake.ts (O11) — built with jev/questions.ts `choice`, `pairedNouls`, `ref`
export const INTAKE_KINDS = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code', 'coding_task', 'ambiguous'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];
export const INTAKE_OPTIONS: Readonly<Record<IntakeKind, string>> = {
  greeting_or_smalltalk: 'a greeting, thanks, goodbye, a check that someone is there, or small talk that asks for no information and no work',
  question_about_this_tool: 'a question about JevCode itself: what it can do, its mode, its keys or cost, its commands, what the last run did, how to use it',
  question_about_the_code: 'a question about the code in `workspace` (what a file or function does, where something lives, why a test fails) that wants an explanation, not a change',
  coding_task: 'an instruction to change, create, fix, refactor, test, run, install or check something in `workspace`',
  ambiguous: 'the message reads both as a request for work and as a question or remark, and the difference decides whether a paid run starts',
};
export function buildIntakeQuestions(): Record<string, Question> {
  return {
    intake: choice(`What is the human asking of this coding-agent session in ${ref('message')}, read with ${ref('conversation')}, ${ref('workspace')} and ${ref('session')}?`, INTAKE_OPTIONS),
    ...pairedNouls(INTAKE_OPTIONS, (option, desc) => ({
      instructions: `Is \`${option}\` (${desc}) the right reading of ${ref('message')} given ${ref('conversation')}?`,
      criteria: { true: { definition: PAIRED_TRUE[option], examples: PAIRED_TRUE_EXAMPLES[option] }, false: { definition: PAIRED_FALSE[option], examples: PAIRED_FALSE_EXAMPLES[option] } },
    })),
  };
}
```

The criteria text, verbatim (the unit test `test/unit/chat/intake.test.ts` snapshots the built questions so a wording
change is a reviewed diff):

| option | true.definition | true.examples | false.definition | false.examples |
| --- | --- | --- | --- | --- |
| `greeting_or_smalltalk` | `message` opens, closes or keeps up a conversation and would be complete with a one-line friendly answer | `hi`, `thanks, that worked`, `you still there?`, `good morning` | `message` names a file, a test, an error or a change, or asks what something does | `hi, can you fix the failing test`, `thanks — now run the suite` |
| `question_about_this_tool` | `message` asks about JevCode, Jev, the mode, keys, cost, commands, the sandbox or the last run, and is answered from the session's own facts | `what can you do?`, `which mode is this?`, `how much has this cost?`, `did the last run pass?` | `message` asks about the project's code or asks for work | `what does parse_date do?`, `add a test for parse_date` |
| `question_about_the_code` | `message` asks how the code in `workspace` works or where something is, and an explanation would satisfy it | `where is the date parsing?`, `why does test_parse_date fail?`, `what does utils/dates.py export?` | `message` asks for a change, or asks about JevCode rather than the project | `fix the date parsing`, `what mode are you in?` |
| `coding_task` | `message` tells the agent to make or check a change in `workspace`; carrying it out means editing, creating, running or installing something | `fix the failing test in utils/dates.py`, `add a --dry-run flag`, `run the tests`, `also update the CHANGELOG` | `message` only asks a question, greets, or comments on a result | `looks good`, `what did you change?` |
| `ambiguous` | `message` can be read as work or as a question and `conversation` does not settle it | `the date parsing`, `tests?`, `parse_date is wrong` | one reading is clearly meant | `fix parse_date`, `what does parse_date do?` |

Resolution, in code (`resolveIntake`):

```ts
export const INTAKE_RUN_FLOOR = 0.6;   // a paid run needs Jev's own choice at p ≥ 0.6 with its paired Noul ≥ 0.5 (PAIRED_NOUL_FLOOR); anything weaker asks
export interface IntakeResolution { kind: IntakeKind; verdict: ChoiceVerdict; answer: string; probability: number; pairedNoul: number; near: boolean }
export function resolveIntake(answers: Record<string, Answer>): IntakeResolution {
  const r = resolveChoice<IntakeKind>({ choiceId: 'intake', answers, options: INTAKE_KINDS, escape: 'none_of_these', fallback: 'ambiguous' });
  const near = Math.abs(r.probability - INTAKE_RUN_FLOOR) <= 0.03;            // the `!` marker of the Jev panel row (TUI-DESIGN §7.1 `near`)
  if (r.option === 'coding_task' && (r.verdict !== 'chosen' || r.probability < INTAKE_RUN_FLOOR)) return { ...r, kind: 'ambiguous', near };
  return { ...r, kind: r.option, near };
}
```

The rule is asymmetric on purpose: a greeting, a fact answer or a lookup is cheap and reversible, so Jev's argmax
suffices; a **run** is money and a possible file change, so it needs Jev's own `coding_task` at ≥ 0.6 **and** the paired
Noul ≥ 0.5 — otherwise the human is asked (§3.8). `none_of_these` and a missing/invalid answer fall to `ambiguous`
through `resolveChoice`'s fallback. There is no code-side override toward running: no keyword list ever starts a run.

### 3.4 Group B: the reply catalogue (`src/chat/replies.ts`)

```ts
export interface ReplySpec {
  readonly key: string;                 // the Choice option key (snake_case, descriptive — REPORT rule 10: no letters/numbers)
  readonly when: string;                // criteria definition: which message this reply fits
  readonly examples: readonly string[]; // ≥ 2 examples
  readonly text: string;                // ≤ 160 chars; placeholders <dir>, <last>, <mode> filled by fillReply()
}
export const REPLIES: readonly ReplySpec[] = [ /* the 14 rows below, in this order */ ];
export const REPLY_FALLBACK_KEY = 'smalltalk_other';
export function buildReplyQuestion(): Question;   // choice(`Which reply in the catalogue answers ${ref('message')} best, read with ${ref('conversation')} and ${ref('session')}?`, Object.fromEntries(REPLIES.map(r => [r.key, { definition: r.when, examples: r.examples }])))
export function pickReply(answers: Record<string, Answer>): { key: string; probability: number };  // the Choice's argmax; `none_of_these` or missing → REPLY_FALLBACK_KEY at p 0
export function fillReply(spec: ReplySpec, facts: { dir: string; lastRun: string | null; mode: EngineMode }): string;
```

| key | when (criteria definition) | examples | text |
| --- | --- | --- | --- |
| `hello_first` | a first greeting in this session, no question attached | `hi`, `hello`, `hey there` | `Hi. I'm ready when you are — describe a change you want in <dir>, or ask what I can do.` |
| `hello_again` | a greeting after earlier turns in `conversation` | `hi again`, `hello?` after a reply | `Hi again. Same session, same workspace — what's next?` |
| `how_are_you` | asks how the agent is doing | `how are you?`, `how's it going` | `Doing well: idle, keys loaded, nothing running. What can I look at?` |
| `good_morning` | a morning greeting | `good morning`, `morning!` | `Good morning. Fresh session on <dir> — tell me what to work on.` |
| `good_evening` | an afternoon, evening or night greeting | `good evening`, `late night here` | `Good evening. I'm here whenever you're ready.` |
| `thanks` | thanks or appreciation for something done | `thanks`, `thank you, that worked` | `You're welcome. Anything else on <dir>?` |
| `bye` | a goodbye or sign-off | `bye`, `see you`, `that's all for today` | `Bye for now. /exit closes the session; everything is saved under ~/.jevcode.` |
| `praise` | praise for the agent or the result | `nice work`, `perfect` | `Thanks — Jev did the deciding. Want to take on the next one?` |
| `apology` | the human apologises or says they made a mistake | `sorry, wrong window`, `my bad` | `No harm done — nothing was run, so we can just carry on.` |
| `checking_alive` | asks whether the agent is present or working | `you there?`, `still alive?`, `hello??` | `Yes, I'm here: idle and listening. Type a task or a question.` |
| `ok_ack` | a bare acknowledgement | `ok`, `okay`, `got it`, `cool` | `Okay. Whenever you're ready.` |
| `whats_up` | asks what is happening or what is new | `what's up?`, `anything new?` | `Not much: the composer's open, the workspace is <dir>, <last>.` |
| `laughing` | laughter or a joke | `lol`, `haha`, `ha` | `Glad that landed. What shall we do next?` |
| `smalltalk_other` | small talk none of the others fit (the fallback) | `nice weather`, `how was your weekend` | `Happy to chat, though I'm best at code. Ask me anything about <dir>, or hand me a task.` |

`fillReply`: `<dir>` → `basename(workspaceRoot)`; `<last>` → `nothing has run yet` / `the last run ended <stopReason>
after <steps> steps` / `the last run is paused after step <n> (/resume continues)`; `<mode>` → `jev-only` / `jev+llm`.
Texts have no emoji, one sentence or two, no exclamation beyond a greeting; a `/command` named inside a reply is
literal so the human can type it. The catalogue is data: adding a row changes the Choice's option set, nothing else.
When `intake` is `greeting_or_smalltalk` and the human has **never run anything** in this session, `hello_first`,
`good_morning` and `smalltalk_other` end with the composer hint; after a run the same keys still print the same text
(the `<dir>` sentence is the hint) — no per-state variants beyond `<last>`.

### 3.5 Group C: the harness facts (`src/chat/facts.ts`)

```ts
export type FactKey = 'what_it_is' | 'mode_now' | 'switch_mode' | 'workspace' | 'last_run' | 'last_tests' | 'keys' | 'cost_so_far' | 'sandbox' | 'how_to_task' | 'review' | 'undo' | 'commands' | 'provider';
export interface Fact { readonly key: FactKey; readonly topic: string; readonly examples: readonly string[]; readonly text: string }
export interface FactsInput {
  mode: EngineMode; nextMode: EngineMode; workspace: { root: string; git: GitState | null; hasTests: boolean; testCommand: string | null };
  lastRun: RunRecord | null; lastTests: JudgeTests | null; keys: { jev: { provider: JevProvider; source: string } | null; generator: { provider: string; source: string } | null };
  spend: { sessionUsd: number; sessionCapUsd: number; runs: number; chats: number }; sandbox: SandboxLevel; runsDir: string;
}
export function harnessFacts(i: FactsInput): readonly Fact[];                       // 14 facts, code-computed, no key values (sources + fingerprints only)
export function buildFactQuestions(facts: readonly Fact[]): Record<string, Question>; // `about_<key>`: noul(`Does ${ref('message')} ask about ${fact.topic}?`, { true: { definition: `the human wants to know ${fact.topic}`, examples: fact.examples }, false: { definition: `${fact.topic} is not what the message is about`, examples: FACT_FALSE_EXAMPLES[key] } })
export const FACT_SELECT_FLOOR = 0.5; export const FACT_MAX_LINES = 4;
export function selectFacts(facts: readonly Fact[], answers: Record<string, Answer>): readonly Fact[];   // p ≥ 0.5, sorted by p desc, ≤ 4; none ≥ 0.5 → the top 2 by p
```

The fourteen facts (the `text` column is what the bubble prints; values are filled at answer time):

| key | topic (in the Noul) | text |
| --- | --- | --- |
| `what_it_is` | what JevCode is and how it works | `JevCode is a coding agent where Jev, a decision model, makes every decision: what kind of step comes next, which files matter, how risky an action is, whether a step worked. In jev-only mode code proposes fixes and tests verify them; in jev+llm mode Claude writes the code.` |
| `mode_now` | which mode the session is in | `Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.` / `Mode: jev+llm — Claude writes the code, Jev decides every step.` (+ ` Next run: <nextMode>.` when pending differs) |
| `switch_mode` | how to switch between jev-only and jev+llm | `Switch with /mode jev-on (alias /llm on) or /mode jev-only; it applies to the next run. Persist it with jevcode config set mode <m>.` |
| `workspace` | which directory and repository it is working on | `Workspace: <root> (git <branch>, <m> modified · <u> untracked; tests: <command>)` / `(not a git repository; no test command found)` |
| `last_run` | what the last run did and how it ended | `Last run <id>: "<task60>" ended <stopReason> after <steps> steps, $<cost>; /resume continues, /diff shows the changes.` / `Nothing has run yet in this session.` |
| `last_tests` | whether the tests pass | `Last test run: <passed> passed, <failed> failed, <errors> errors (step <n>).` / `No test run has been parsed in this session yet.` |
| `keys` | which API keys are configured and where they come from | `Keys: Jev through <provider> (<ENV or file>, never printed); generator: <provider> (<source>)` / `generator: none — needed for jev+llm; /mode jev-on asks for one.` |
| `cost_so_far` | how much the session has cost | `Session spend: $<x> of $<cap> (<runs> run(s), <chats> chat message(s)). /cost has the breakdown.` |
| `sandbox` | how commands are sandboxed | `sandboxText(level)` (`src/tui/onboarding/lines.ts`) |
| `how_to_task` | how to start a run or give it work | `Describe the change in plain words and press Enter; a run starts, shows every decision, and stops to ask before anything risky.` |
| `review` | how approvals and reviews work | `Risky actions stop for review: y approves once, n declines, d declines with a note. Nothing is ever auto-approved; Enter does nothing there.` |
| `undo` | how to undo or inspect changes | `/undo reverts the last step's file changes, /rewind picks a step, /diff shows what changed.` |
| `commands` | which commands exist | `Commands start with /; type / to list them, /help for keys.` |
| `provider` | how Jev is reached, its model, latency and price | `Jev: <provider> (<host>), model <model>, about <p50> ms per decision, $0.042 per million input tokens (output free).` |

`selectFacts` orders by probability, never by table order, so the answer leads with what was asked. The bubble is one
line per fact (§3.10). A question that selects nothing ≥ 0.5 still answers (the top two) rather than shrugging: the
human asked about the tool and the tool knows itself.

### 3.6 `question_about_the_code`

#### 3.6.1 jev-only: an honest, code-computed lookup (`src/chat/lookup.ts`) — no engine run

Jev evaluates and chooses; it does not write (JEV-ONLY.md "The constraint"). A jev-only session therefore **cannot
explain code**, and the design says so instead of pretending. The alternative the brief names — a read-only engine run
with intent forced to `investigate` — was rejected: the jev-only synthesizer proposes **no `read` under any intent**
(`src/synth/search/index.ts:634-638`: reads "were declined at review-band risk 7–12 times per miss" and tripped the
loop detector), its very first proposal is always the baseline test `run` (`:568-582`, `ESTABLISH_GOAL`), and a step
costs six Jev requests plus a test run — a "question" would start the test suite and end in `max_replans`. What
jev-only *can* do well is **select**: one request of Nouls over candidate files (the context stage's own shape,
`contextNoul`, `src/jev/questions.ts:52`), then code-computed excerpts.

```ts
export interface LookupInput {
  message: string; mentions: readonly string[]; candidates: readonly Candidate[];           // host.workspaceCandidates() (idle: files.ts listCandidates, TUI-DESIGN §5.4)
  read: (rel: string, maxBytes: number) => Promise<FileView>;                                 // workspace/files.ts read with the §10.4 denylist (isMentionDenied) applied first
  ask: (state: Json, questions: Record<string, Question>) => Promise<AskResult>; redact: (s: string) => string; signal: AbortSignal;
}
export interface LookupHit { path: string; p: number; lines: { n: number; text: string }[] }   // ≤ 3 lines per file, each clipped to 120 cells
export interface LookupResult { hits: LookupHit[]; considered: number; usage: TokenUsage; latencyMs: number }
export const LOOKUP_CANDIDATES_MAX = 60; export const LOOKUP_HITS_MAX = 3; export const LOOKUP_SELECT_FLOOR = 0.5; export const LOOKUP_READ_BYTES = 64 * 1024;
export function lookupKeywords(message: string): string[];                                    // identifiers and words ≥ 3 chars, minus a 60-word stoplist, ≤ 12, lower-cased
export function rankCandidates(candidates: readonly Candidate[], keywords: readonly string[], mentions: readonly string[]): Candidate[];  // mentions first, then path-token overlap desc, then shorter paths; ≤ LOOKUP_CANDIDATES_MAX
export async function lookupCode(i: LookupInput): Promise<LookupResult>;
```

`lookupCode`: (1) keywords + `rankCandidates` (pure, ≤ 1 ms over 20,000 candidates — the `@` scorer's budget, F17);
(2) one Jev request, state `{ message, files: [{ path, bytes }…] }` (≤ 60 rows ≈ 1,500 chars), questions
`file_<i>: contextNoul(\`Would reading \`${path}\` help answer ${ref('message')}?\`)` with the criteria written once in
the state (`criteria: { true: 'the file defines, tests or configures what the message asks about', false: 'the file is
unrelated to the message' }`, the §5.5 context exception); (3) select `p ≥ 0.5`, top 3; (4) `read` each (≤ 64 KiB,
denylist first), keep ≤ 3 lines containing a keyword (definition lines — `def`, `class`, `function`, `export` — first);
(5) return. The bubble (§3.10), exact lines:

```
[jevcode] In jev-only mode I can point at code but not explain it — Jev decides, it doesn't write. Likely places:
[jevcode]   utils/dates.py:12  def parse_date(s: str, tz: str | None = None) -> datetime:
[jevcode]   utils/dates.py:31      return datetime.strptime(s, FMT).replace(tzinfo=tz)
[jevcode]   tests/test_dates.py:8  def test_parse_date_tz():
[jevcode] Switch with /mode jev-on to get an explanation from the LLM, or describe the change and I'll make it.
```

No hit ≥ 0.5: `[jevcode] I couldn't find a file in <dir> that clearly answers that (looked at <considered> candidates).
Name the file or function, or switch with /mode jev-on for an explanation.` Cost ≈ 271 + 60 × 9 + 400 ≈ 1,200 tokens
(≈ $0.00005); latency one round trip plus ≤ 3 bounded reads. The lookup honours the secret denylist exactly like `@`
(`isMentionDenied`, TUI-DESIGN §10.4): a denied mention is dropped and reported with the existing
`<path> is on the secret denylist; JevCode never reads it. …` item.

#### 3.6.2 jev+llm: one generator chat turn, no tools (`src/chat/llm-turn.ts`)

```ts
export interface LlmTurnInput {
  provider: Provider; message: string; conversation: readonly ChatTurn[]; facts: readonly Fact[];
  context: { plan: Plan | null; window: readonly WindowEntry[]; files: readonly FileView[] };   // last run's plan (RunRecord → lastPlan) and window ≤ 4; @-mentioned files ≤ 3 × 8 KiB, denylist applied
  instructions: string | null;                                                                  // AGENTS.md text when the workspace is trusted (EngineOptions.instructions.text)
  generation: { maxTokens: number; temperature: number | null };                                // maxTokens = min(800, cfg.maxTokens)
  signal: AbortSignal; onDelta: (text: string) => void; redact: (s: string) => string;
}
export const CHAT_SYSTEM_PROMPT = [
  'You are the assistant of JevCode, a coding agent in which Jev (a decision model) makes every decision. You are in a conversation about the code in the workspace named below.',
  'Answer the question. Do not propose file edits, patches or commands to run: the human starts a run for that by describing a task, and Jev then decides each step.',
  'Be concrete, cite paths and line numbers you were shown, and keep the answer under twelve lines. If the shown files do not contain the answer, say what to open next.',
].join('\n');
export function buildChatRequest(i: LlmTurnInput): GenerateRequest;   // system = CHAT_SYSTEM_PROMPT + '\n\n## Session facts\n' + facts.map(f => f.text) + optional '## Instructions (AGENTS.md)' + '## Last run plan' + '## Recent steps' + '## Files' (path + fenced content); messages = conversation (≤ 6, roles mapped you→user, jevcode→assistant) + { role: 'user', content: message }; no `tools`, no `toolChoice`; temperature null
export async function llmChatTurn(i: LlmTurnInput): Promise<{ text: string; usage: TokenUsage; latencyMs: number; model: string }>;
```

`llmChatTurn` calls `provider.generate(req, { signal, onDelta })` once; the deltas stream into the **live region**
(`liveLines`, TUI-DESIGN §7: the last two lines, `streaming… 1.2k chars` until the first line break) under the status
word `⠹ replying`; on completion the text is committed as `[jevcode]` bubble lines (§3.10) and the live region empties
(the same choreography as a generator proposal today, so no new live-region code). Cost → `sessionMeter.add('generator',
usage)`; a `NaN` cost (OpenRouter `usage.cost` null and the model unpriced) **refuses before sending** when
`cfg.generator().priced !== true && !flags.allowUnpriced`: `[jevcode] I can't answer through the LLM: <model> has no
pricing entry and --allow-unpriced is off (jev-only lookup still works).` — the §9.5 fail-closed rule for a chat turn.
Tool calls never appear (`tools` absent); if a provider returns one anyway (`GenerateResult.toolCalls.length > 0`) the
text is used and the call is dropped with a `jevcode.log` warning. The generator sees the message **raw** (like
`PromptInput.task`, F9/A156 — the secret gate already ran and `secret-ack` is not emitted here because no engine exists;
the chat ledger line carries `secretsAcked: n`). Instructions (`AGENTS.md`) reach the system prompt only when the trust
gate allowed them, exactly as for a run.

### 3.7 `coding_task`: today's run, with the bubble in front

The `[you]` bubble is already in the scrollback (§3.10); `startRun(text, so)` runs unchanged (`session.ts:1428`): the
follow-up gate (§9.3 of TUI-DESIGN), the seed (§8.3), `createEngine`, the transcript. One addition: the intake's
`IntakeResolution` rides `EngineOptions.session.intake?: { kind: IntakeKind; probability: number; requestHash: string }`
(§8 item 11) so `run.json` records why the run started and the `s0 intake` row sits above `s1 intent` in the Jev panel
(§3.11). A follow-up after a run (`so.kind === 'follow-up'`) passes intake too: "also update the docs" → `coding_task`
→ seeded run; "did it pass?" → `question_about_this_tool` → the `last_tests` fact.

### 3.8 `ambiguous`: the one-row confirmation, never a silent run

A new `OverlayKind` `'intake'` (`src/tui/layout.ts`, `COLLAPSING` gains it: the composer collapses to one inactive
row like `exitConfirm`; `CAP.intake = 1`). Rows (`src/chat/lines.ts` `intakeRowLines(msg, columns)`, shared by Ink,
`--plain`, SR):

- 80 columns: `run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)`
- ≥ 100 columns: `"<message ≤ 40, one line>" — run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)`
- `--plain` (readline): `run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ` — `y`/`yes`,
  `n`/`no`; an empty line or anything else keeps the text; five invalid answers = keep (`READLINE_MAX_PROMPTS`).
- screen reader: `1 run it  2 just chatting  3 keep the text` / `Enter selection (1-3):` (the §6.5 typed-line rule; the
  draft stash applies).

Keys (S5 sub-row added to TUI-DESIGN §3.3): `y` → `coding_task` path (§3.7); `n` → the chat reply picked from the
answers already in hand — `argmax` over `{ greeting_or_smalltalk, question_about_this_tool, question_about_the_code }`
of the intake probabilities, then §3.4/§3.5/§3.6 with **no new intake request**; Esc / Ctrl-C → the overlay closes,
the message is **restored into the composer** (the `[you]` bubble stays: it is what was said) and a dim
`[jevcode] Okay — edit it and press Enter, or ask me something.` is appended; Enter inert; printable ignored with the
toast `intake pending: y n · Esc keeps the text`. Arming: the §6.3 rule — `overlayArmed` only after a committed frame
**and** 150 ms (`GATE_ARM_MS`), so the Enter that submitted can never answer `y`. Status left word while open:
`asking`. The `y` path is the **only** way an `ambiguous` message becomes a run.

### 3.9 Money, ledger, history, redaction

- **Meter.** Every chat request is `sessionMeter.add('jev', res.usage)` (or `'generator'` for the LLM turn) — the root
  meter of D3; `pushSessionSpend()` refreshes `sess $x.xx/1.25`. The session-scope thresholds (50/80/95 %) are
  evaluated by the controller after each add (the engine's `budget:warn` has no engine here): crossing one appends the
  `[ui] budget: session spend $a is P % of the $b session cap — raise it with /budget session-spend-cap <usd>` item
  (`budgetItems`, `src/tui/budget/lines.ts:156`, same text) once per threshold per session. A session at or over its cap
  **refuses chat too**: `[jevcode] The session cap ($1.25) is reached, so I'm not sending anything to Jev. Raise it with
  /budget session-spend-cap <usd>, or /new for a fresh session.` — no request is made.
- **Ledger.** `chat: ChatTurn[]` in the controller (≤ 200 turns in memory; the last 6 go to Jev), each
  `{ role, text, at, kind?, requestHash?, latencyMs?, costUsd?, provider? }`; `/jev` line 3 and `/cost` read it
  (`/cost` gains `chat $0.0003 for 4 messages (~$7.5e-5 each, p50 118 ms)` on the `gen · jev` line). `sessions/index.jsonl`
  gains a line kind `chat` (`IndexLine` union, `src/session/index.ts:24`): `{ v: 1, t, kind: 'chat', sessionId, intake:
  IntakeKind, costUsd: number, provider: JevProvider | 'generator' }` (≤ 120 bytes) so `seedMeterFromIndex` (`session.ts:1353`)
  restores chat spend on `/resume` and the fold's `totalUsd` includes it. Before the first run there is no
  `sessionId`; chat lines are buffered like `deferredBudgetLines` (`session.ts:857`) and written with the first run's
  session id — a session that ends without a run drops them (at most a few hundredths of a cent, documented).
- **History.** `HistoryKind` (`src/tui/composer/history.ts:21`) gains `'chat'`; `HistoryStore.append` (`types.ts:1282`)
  widens accordingly. A submission that became a run is `prompt` (today), one that became a reply or a lookup is
  `chat`, one the human took back with Esc on the ambiguity row is not appended (it is back in the composer). Replies
  are never in history (they are not the human's input). The App learns which it was from the new return value of
  `host.submit()` (§4, §8 item 8). Up-arrow recall includes chat lines; Ctrl-R searches them.
- **Redaction.** The message reaches Jev through `redact` (state) and the generator raw (like a task); the reply
  catalogue and the facts contain no secret material by construction (sources, fingerprints, paths); the chat ledger
  stores `text` through `redact`; `jevcode.log` records `intake <kind> p=<p> <ms>ms <hash>` — never the message. Nothing
  here changes the composer's secret gate (`routeSubmit` runs before `submit()`).

### 3.10 Bubbles: labels, items, identity

`UiLabel` (`src/core/types.ts:1100`) gains `'[you]' | '[jevcode]'`; `TranscriptKind` (`src/tui/plain.ts:44`) gains
`'chat'`. A bubble is one or more transcript items with the same label; **one item per line of the reply** (a reply
line ≤ 600 chars, `TRANSCRIPT_TEXT_MAX`), so `formatTranscriptItem` prints `[you] hi` / `[jevcode] Hi. I'm ready …`
and `--plain`, the TUI's `<Static>` rows and `--json` `ui` lines carry the same text. The multi-line `detail` body is
**not** used for replies (it is TUI-only by contract, `plain.ts:95`), which is what keeps the twins identical. The
TUI groups consecutive items with the same chat label into one visual bubble (`groupBubbles(items)`, pure, in
`src/chat/bubbles.ts`; Designer A owns the dress — role label dimmed, brand colour on `[jevcode]`, a gutter). The
identity rule for D-D's dress is stated here so the unit test can hold it: **after `stripAnsi`, the row text of a chat
item minus a fixed leading gutter of ≤ 2 cells equals `formatTranscriptItem(item)`** — colour and a gutter are dress;
changed words are not.

While no engine is live (every chat until a run starts) the items are renderer-local (`localItem`, `plain.ts:406`,
`local: true`), appended through `SessionHost.note()` with the chat label — exactly today's `[ui]` mechanics
(`session.ts:949-973` `notifyLocal` / `note`), so they print in `--plain`, in the TUI and as `--json` `ui` lines and
never enter a `transcript.log` (there is none). If a chat ever happens while a run is live — it cannot through the
composer (Enter steers while live, `routeSubmit`), but `--plain`'s `/steer`-less readline could reach `submit` in a
race — `note()` already routes through `engine.annotate()` (`engine.ts:917`), so the line rides the run's transcript
with its label. `--json` gains no new line type for the bubbles; it gains one controller line
`chat { intake: IntakeKind, probability, provider, costUsd, latencyMs, requestHash }` after each intake (§8 item 12).

### 3.11 The intake in the Jev panel and `/why`

The intake's answers are `Decision`-shaped (`toDecisionRow`, `src/tui/pane/model.ts`) with `step: 0`, `stage:
'intent'`, ids `intake`, `can_*`, `reply`, `about_*`, `requestHash`, `latencyMs`; the controller keeps the last ≤ 3
intakes' rows in `chatDecisions` and dispatches them to the reducer (`UiAction` `{ type: 'chat-decisions', rows }`) so
the collapsed Jev panel shows `s0 intake  greeting_or_smalltalk  ████████▍·  0.84  chosen` as its first row and `/why
intake` (ref grammar gains `intake`, `intake.reply`, `intake.about_<key>`) prints the standard `/why` block for it
(`whyBlock`, `src/tui/why.ts`). `consumedBy` for `intake` is `resolveChoice → run floor 0.60 → <kind>`; for `reply`
`argmax → catalogue`; for `about_*` `≥ 0.5 → answer line`. They are not written to any `decisions.jsonl` (no run
directory exists); `/calibration` ignores them.

### 3.12 Latency budget and its measurement

| Segment | Budget | How measured |
| --- | --- | --- |
| Enter → `[you]` bubble + `⠹ thinking` frame | ≤ 16 ms p95 (the composer keystroke gate, D-E) | `src/perf/composer-latency.ts` gains an `enter-chat` series against `--mock` (the mock decider answers intake) |
| harness work per intake (state build, question build, resolution, bubble items) excluding Jev | ≤ 5 ms p95 | `test/unit/chat/intake.test.ts` `[measured]` line over 1,000 iterations (the `computeLayout` micro-gate pattern) |
| Jev round trip, native | 110–250 ms p50 (measured 109–112 ms this morning; budget ≤ 400 ms p95 at the network's mercy) | `test/live/intake.live.test.ts` prints p50/p95 over 12 messages per provider (§9.3) |
| Jev round trip, OpenRouter | ≈ 240 ms p50 (STATUS.md: 237 ms) | same |
| lookup (jev-only code question) | 1 round trip + ≤ 3 reads ≤ 64 KiB: ≤ 600 ms p95 native | live suite, one message |
| LLM chat turn | provider-bound; first delta typically < 1 s | not gated; the live region shows progress |
| Enter → reply frame, mock at 0 ms | ≤ 40 ms p95 end to end | `src/perf/intake-latency.ts` (new probe, `jevcode perf`, reports; gates the ≤ 40 ms) |

"Well under a second of Jev latency" holds by construction: one request, ≤ 1,650 input tokens, no sequential
requests for a greeting or a tool question. The status left zone shows `⠹ thinking` from the Enter frame so the
100–250 ms never look like a hang; reduced motion shows `• thinking`.

---

## 4. The session controller: the submit path after this round (`src/cli/session.ts`, O10)

### 4.1 `host.submit()` becomes `converse()`

Today (`session.ts:2568-2573`):

```ts
async submit(text, so) {
  await startupDone;
  for (const span of so.secretSpans) config?.addSecret(`composer#${++secretSeq}`, span);
  await startRun(text, { kind: so.kind, pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length });
},
```

After:

```ts
async submit(text, so): Promise<SubmitOutcome> {
  await startupDone;
  for (const span of so.secretSpans) config?.addSecret(`composer#${++secretSeq}`, span);
  // §3: the argv / --task-file / stdin task of a one-shot run never passes intake (kind 'task' is set by submitTask, §4.4)
  if (so.kind === 'task') { await startRun(text, { kind: ranBefore() ? 'follow-up' : 'prompt', pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length }); return { became: live() ? 'run' : 'nothing' }; }
  return converse(text, so);
},
```

```ts
/** §3.1: one Jev request, five outcomes; the only path from a composer submission to startRun */
async function converse(text: string, so: { kind: 'prompt' | 'follow-up'; pinnedFiles: readonly string[]; secretSpans: readonly string[] }): Promise<SubmitOutcome> {
  if (exiting) return { became: 'nothing' };
  if (live()) { uiError('a run is live; Enter steers it (Esc pauses, Esc Esc aborts)'); return { became: 'nothing' }; }
  const cfg = config;
  if (!cfg) { uiError('configuration not ready yet'); return { became: 'nothing' }; }
  say('you', [text]);                                                              // §3.10: the [you] bubble, always first
  const mode = pending.mode ?? baseMode;
  if (cfg.missingSecrets('jev-only').length > 0) {                                 // no Jev key: the wizard, then retry once
    const saved = await runLogin('missing', mode);
    if (!saved) { uiError(`missing decider.apiKey: run jevcode login or set TYPESAFE_API_KEY / OPENROUTER_API_KEY`); return { became: 'nothing' }; }
  }
  if (sessionMeter.exceeded()) { say('jevcode', [SESSION_CAP_CHAT_REFUSAL(sessionCapOf())]); return { became: 'chat' }; }
  thinking('intake');                                                              // status `⠹ thinking` (renderer.dispatch, §7.2)
  let res: IntakeResult;
  try {
    const decider = await deciderOf(cfg, flags);
    res = await runIntake({ decider, state: intakeState(text, so.pinnedFiles), signal: chatSignal(), redact });
  } catch (e) {
    thinking(null);
    const err = isJevCodeError(e) ? e : null;
    if (err instanceof ConfigError) { uiError(`config: ${redact(err.message)}`); return { became: 'nothing' }; }   // unknown model, bad URL: exit-2 class, idle
    say('jevcode', [INTAKE_UNREACHABLE(redact(describe(e)))]);                     // `I couldn't reach Jev to read that (<short>). Press Enter to send it again.`
    return { became: 'chat' };
  }
  meterChat('jev', res.usage, res.provider); chatDecisions(res.rows);
  chat.push({ role: 'you', text, at: nowIso(), kind: res.intake.kind, requestHash: res.requestHash, latencyMs: res.latencyMs, costUsd: res.usage.costUsd });
  json?.chat({ intake: res.intake.kind, probability: res.intake.probability, provider: res.provider, costUsd: res.usage.costUsd, latencyMs: res.latencyMs, requestHash: res.requestHash }, ctx());
  log.info(`intake ${res.intake.kind} p=${res.intake.probability.toFixed(2)} ${Math.round(res.latencyMs)}ms ${res.requestHash}`);
  switch (res.intake.kind) {
    case 'coding_task': thinking(null); await startRun(text, { kind: so.kind, pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length }); return { became: live() ? 'run' : 'nothing' };
    case 'ambiguous': {
      thinking(null);
      const a = prompter?.intake ? await prompter.intake(text) : 'keep';       // --no-input / a pipe: the safe default keeps the text (C46) — never a run
      if (a === 'run') { await startRun(text, { kind: so.kind, pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length }); return { became: live() ? 'run' : 'nothing' }; }
      if (a === 'keep') { say('jevcode', [INTAKE_KEPT]); renderer.restoreDraft?.(text); return { became: 'nothing' }; }
      return reply(text, res, chatKindAfterNo(res), so);                        // 'chat': the best non-run reading from the same answers (§3.8)
    }
    default: return reply(text, res, res.intake.kind, so);
  }
}
```

```ts
async function reply(text: string, res: IntakeResult, kind: Exclude<IntakeKind, 'coding_task' | 'ambiguous'>, so: { pinnedFiles: readonly string[] }): Promise<SubmitOutcome> {
  let lines: string[];
  try {
    if (kind === 'greeting_or_smalltalk') lines = [fillReply(replyByKey(pickReply(res.answers).key), replyFacts())];
    else if (kind === 'question_about_this_tool') lines = selectFacts(harnessFacts(factsInput()), res.answers).map((f) => f.text);
    else if ((pending.mode ?? baseMode) === 'jev-only') {                            // §3.6.1
      thinking('lookup');
      const decider = await deciderOf(config!, flags);
      const r = await lookupCode({ message: text, mentions: so.pinnedFiles, candidates: await candidates, read: readForLookup, ask: (s, q) => decider.ask(s, q, { signal: chatSignal(), stage: 'context', step: 0 }), redact, signal: chatSignal() });
      meterChat('jev', r.usage, decider.provider);
      lines = lookupLines(r, basename(workspaceRoot));
    } else {                                                                        // §3.6.2
      const gen = config!.generator();
      if (gen.priced !== true && flags.allowUnpriced !== true) lines = [LLM_UNPRICED_REFUSAL(gen.model)];
      else {
        thinking('replying');
        const provider = await providerOf(config!, flags, 'jev-on');
        const r = await llmChatTurn({ provider, message: text, conversation: chat.slice(-6), facts: harnessFacts(factsInput()), context: llmContext(so.pinnedFiles), instructions: instructions?.text ?? null, generation: { maxTokens: Math.min(800, gen.maxTokens), temperature: null }, signal: chatSignal(), onDelta: (t) => renderer.live?.(t), redact });
        meterChat('generator', r.usage, gen.provider);
        lines = r.text.split('\n').filter((l) => l.trim() !== '');
      }
    }
  } finally { thinking(null); }
  say('jevcode', lines);
  chat.push({ role: 'jevcode', text: lines.join('\n'), at: nowIso() });
  return { became: 'chat' };
}
```

`say(role, lines)` appends one item per line with label `[you]` / `[jevcode]` through `note(line, { label })`
(§3.10; `note` already picks `annotate()` while live, a local item while idle — `session.ts:961-973`), and appends the
turn to the ledger. `thinking(phase)` calls `extras.dispatch?.({ type: 'thinking', phase })` (§7.2). `chatSignal()` is
an `AbortController` the controller aborts on Ctrl-C ×1 while idle (S0: today a hint; with a chat request in flight
the first Ctrl-C aborts the request — a new S0 sub-rule, §4.3), on `/exit` and on a signal. `meterChat(source, usage,
provider)` = `sessionMeter.add(source, usage)` + the threshold check + `pushSessionSpend()` + the deferred/immediate
`chat` index line (§3.9).

### 4.2 The one-shot path and `--plain`

`submitTask()` (`session.ts:2786`) passes `kind: 'task'` so an argv / `--task-file` / stdin task **never** passes
intake: `jevcode run "hi"` starts a run named `hi`, as scripts expect (a script that wants the intake uses `chat` on a
TTY). The readline composer (`src/tui/plain-composer.ts`) calls the same `host.submit()` and prints the bubbles as
`[you] …` / `[jevcode] …` lines; its `Prompter.intake` (§8 item 9) is the `y/n/Esc` readline row of §3.8. On a pipe,
`CI`, `TERM=dumb` or `--no-input` there is no composer, so `converse` is unreachable — the C46 safe default
(`'keep'`) is written into the code path anyway.

### 4.3 Key matrix additions (TUI-DESIGN §3.3)

| State | Key | Action |
| --- | --- | --- |
| S0 idle · empty **with a chat request in flight** (`thinking !== null`) | Ctrl-C ×1 | abort the chat request (`chatSignal`), toast `stopped thinking`, no arm — the request is money already spent, the reply is dropped; a second Ctrl-C ≤ 1.5 s exits as today |
| S0/S1 with `thinking !== null` | Enter | queued: the composer keeps accepting text; Enter is ignored with the toast `one moment — still thinking` (re-entrancy: `submitting` stays true until `submit()` resolves, `App.tsx:797-808`) |
| S5 `intake` overlay | `y` / `n` / Esc / Ctrl-C / Enter / printable / paste | §3.8 (armed per §6.3; Enter inert; paste never matches) |

### 4.4 `SubmitOutcome` and history in the App (`src/tui/App.tsx:790-809`, O9)

```ts
// App.tsx send(), case 'submit'
composer.clear();
submittingRef.current = true;
dispatch({ type: 'thinking', phase: 'intake' });                                  // replaces dispatch({ type: 'run:starting' }) — the host dispatches run:starting itself when a run begins
void h.submit(decision.full, { kind: decision.promptKind, secretSpans: decision.secretSpans, pinnedFiles: decision.pinnedFiles })
  .then((o) => { if (o.became !== 'nothing') appendHistory(o.became === 'run' ? hist.kind : 'chat', redact(hist.text)); })
  .catch((e: unknown) => noteLine(`error: ${e instanceof Error ? e.message : String(e)}`, { label: '[ui]', level: 'error' }))
  .finally(() => { submittingRef.current = false; if (stateRef.current.run === 'starting') dispatch({ type: 'run:idle' }); dispatch({ type: 'thinking', phase: null }); });
```

The host dispatches `{ type: 'run:starting' }` through `extras.dispatch` at the top of `startRun` (`phase = 'starting'`,
`session.ts:1449`) so the status word goes `⠹ thinking` → `starting` → `⠹ intent …` in that order and never shows
`starting` for a greeting.

---

## 5. New modules and exact signatures (slot O11 `src/chat/**`; every module ink-free, unit-tested offline)

| File | Exports | Depends on |
| --- | --- | --- |
| `src/chat/intake.ts` | `INTAKE_KINDS`, `IntakeKind`, `INTAKE_OPTIONS`, `INTAKE_RUN_FLOOR`, `buildIntakeState`, `buildIntakeQuestions`, `resolveIntake`, `runIntake`, `chatKindAfterNo`, `IntakeResult`, `IntakeResolution` | `jev/questions.ts`, `loop/stages/choose.ts` (`resolveChoice`), `core/text.ts` (`clip`, `headTail`), `chat/replies.ts`, `chat/facts.ts` |
| `src/chat/replies.ts` | `REPLIES`, `ReplySpec`, `REPLY_FALLBACK_KEY`, `buildReplyQuestion`, `pickReply`, `replyByKey`, `fillReply` | `jev/questions.ts` |
| `src/chat/facts.ts` | `FactKey`, `Fact`, `FactsInput`, `harnessFacts`, `buildFactQuestions`, `selectFacts`, `FACT_SELECT_FLOOR`, `FACT_MAX_LINES` | `tui/onboarding/lines.ts` (`sandboxText`), `tui/budget/lines.ts` (`usd2`), `workspace/gitstate.ts` (`gitBannerLine` pieces) |
| `src/chat/lookup.ts` | `lookupKeywords`, `rankCandidates`, `lookupCode`, `lookupLines`, `LOOKUP_*` | `jev/questions.ts` (`contextNoul`), `core/text.ts` |
| `src/chat/llm-turn.ts` | `CHAT_SYSTEM_PROMPT`, `buildChatRequest`, `llmChatTurn` | `provider/*` through the `Provider` interface only |
| `src/chat/lines.ts` | `intakeRowLines(message, columns, opts: { ascii?, screenReader? }): string[]`, `INTAKE_*` strings, `thinkingWord(phase, spinnerFrame, ascii, reducedMotion)` | `tui/composer/width.ts` (`stringWidth`, `truncateCells`) |
| `src/chat/bubbles.ts` | `groupBubbles(items: readonly TranscriptItem[]): Bubble[]`, `isChatLabel(label)`, `CHAT_LABELS` | `tui/plain.ts` types only |
| `src/chat/ledger.ts` | `ChatTurn`, `ChatLedger` (`push`, `recent(n)`, `stats()`), `chatIndexLine` | `session/index.ts` (`IndexLine`) |

```ts
// src/chat/intake.ts — the request/response shape the controller uses
export interface RunIntakeInput { decider: Decider; state: JsonObject; signal: AbortSignal; redact: (s: string) => string; facts?: readonly Fact[] /* default harnessFacts is the controller's; tests pass a fixed list */ }
export interface IntakeResult {
  intake: IntakeResolution; answers: Record<string, Answer>; rows: Decision[];      // rows: step 0, stage 'intent', one per question (toDecisionRow-ready)
  usage: TokenUsage; latencyMs: number; requestHash: string; provider: JevProvider; model: string;
}
export async function runIntake(i: RunIntakeInput): Promise<IntakeResult>;          // one decider.ask with groups A+B+C; stage 'intent', step 0
export function chatKindAfterNo(res: IntakeResult): 'greeting_or_smalltalk' | 'question_about_this_tool' | 'question_about_the_code'; // argmax of the three from answers.intake.probabilities; ties → question_about_this_tool
```

```ts
// src/chat/ledger.ts
export interface ChatTurn { role: 'you' | 'jevcode'; text: string; at: string; kind?: IntakeKind; requestHash?: string; latencyMs?: number; costUsd?: number; provider?: JevProvider | 'generator' }
export interface ChatStats { messages: number; jevUsd: number; generatorUsd: number; p50Ms: number | null; last: { kind: IntakeKind; probability: number } | null }
```

The mock decider (`src/jev/mock.ts`, O1) gains default heuristics for the new question ids so `--mock` sessions and
the pty smoke converse without a key: `intake` → `greeting_or_smalltalk` when `state.message` matches
`/^\s*(hi|hello|hey|yo|thanks?|thank you|bye|ok(ay)?|good (morning|evening|afternoon))\b[!. ]*$/i`,
`question_about_this_tool` when it contains `?` and `/\b(you|jevcode|jev|mode|cost|key|command|run)\b/i`,
`question_about_the_code` when it contains `?` otherwise, `ambiguous` when it is ≤ 2 words without `?`, else
`coding_task` at p 0.9 with `can_coding_task` 0.9; `reply` → `hello_first` (or `hello_again` when `conversation` is
non-empty), `thanks`, `bye`, `ok_ack` by the same regexes; `about_*` → 0.8 for `mode_now` when `/mode/`, `cost_so_far`
when `/cost|spent|money/`, `what_it_is` when `/what can you do|what are you/`, else 0.1; `file_<i>` → 0.7 when the
path shares a keyword with the message. `JEVCODE_MOCK_INTAKE=<kind>` forces the intake answer for tests.

---

## 6. The wizard for a Jev-only first run, and the generator step on demand (`src/tui/onboarding/*`, O7)

### 6.1 Steps

`WizardStep` (`reducer.ts:20`) gains `'jevProvider'`; the flow becomes

```
detect → [jevProvider] → jevKey → save → verify? → trust → sandbox → done            (jev-only, the default first run)
detect → provider → generatorKey → [jevProvider] → jevKey → save → …                   (jev-on: today's flow + the Jev provider when needed)
reopen('generator') → provider → generatorKey → save → verify? → done                  (/mode jev-on with no generator key; reason 'mode')
```

`jevProvider` is shown only when **no rule of §2.3 chose a provider** (`providerSource === 'default'`) and no Jev key
resolves; when the generator provider is `openrouter` the step is skipped too (reuse). `OnboardingAction.detect`
gains `jevProvider: JevProvider | null` and `reason: 'missing' | 'login' | 'rejected' | 'mode'`; `OnboardingState`
gains `jevProvider: JevProvider | null`, `jevProviderShown: boolean`, `reason`. `startFromDetect` (`reducer.ts:207`):

```ts
function startFromDetect(s: OnboardingState): OnboardingState {
  if (s.missing.length === 0) return afterKeys(s);
  if (needsGenerator(s)) return { ...s, step: 'provider', providerShown: true };
  if (needsJev(s)) return s.jevProvider === null ? { ...s, step: 'jevProvider', jevProviderShown: true } : field(s, 'decider.apiKey');
  return afterKeys(s);
}
```

`choose` on the `jevProvider` step: `1` → typesafe, `2` → openrouter, Enter → the preselection; then `field(s,
'decider.apiKey')`. `SaveRequest` gains `jevProvider: JevProvider | null` (persisted as the file key `jevProvider`
only when the step was shown — the same rule as `provider`). `wizardRows` gives `jevProvider` 3 rows.
`reuseGeneratorForJev` stays limited to `provider === 'openrouter' && jevProvider !== 'typesafe'`.

### 6.2 Rows and strings (`lines.ts`, §24 additions)

- `WIZARD_JEV_PROVIDER_TITLE = 'No Jev key found. Where do you reach Jev?'`
- `WIZARD_JEV_PROVIDER_OPTIONS = '  1 typesafe (TYPESAFE_API_KEY, api.typesafe.ai)   2 openrouter (OPENROUTER_API_KEY, also the generator)'`
  (narrow: `'  1 typesafe   2 openrouter'`)
- `WIZARD_PROVIDER_HINT` unchanged (`Keys are never shown, logged or echoed · Esc back · Ctrl-C quits (prints fix)`)
- Jev key title becomes provider-keyed: `jevKeyTitle(p, counter)` → `'Jev API key (TYPESAFE_API_KEY)  1/1'` /
  `'Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1'` (jev-only: `1/1`; jev-on: `2/2`, as today)
- the generator step opened by `/mode jev-on`: `WIZARD_PROVIDER_TITLE_MODE = 'jev+llm needs a generator. Pick the provider:'`
  with the same options row (`  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)`) and the
  hint `'Keys are never shown, logged or echoed · Esc back · Ctrl-C keeps jev-only'`
- verify detail per provider (§2.7); `[setup]` items unchanged (`jev key: entered (sha256:…) source=wizard`, `saved …`)
- after a `/mode` save: toast and item `[setup] saved — jev+llm from the next run` (the §11.2 `LOGIN_SAVED_TOAST`
  wording, mode-flavoured)

Ctrl-C in a `reason: 'mode'` wizard **never exits**: `cancel` with `reason === 'mode'` goes to `done` (the run may or
may not be live; the session continues in jev-only) — the `runLive` rule of E5 generalised to "a wizard opened by a
command closes, a wizard opened by a missing key at startup exits 2". The fix block (`fixBlockLines`, `lines.ts`) is
reordered for the new default: `export TYPESAFE_API_KEY=…` / `export OPENROUTER_API_KEY=…` / `printenv TYPESAFE_API_KEY |
jevcode login --jev-key-stdin` / `jevcode login` / footer; the Anthropic line appears only when the mode needs a
generator.

### 6.3 `jevcode login`

`commandLogin` (`src/cli/login.ts:285`) gains `--jev-provider typesafe|openrouter`; without it the Jev prompt is
`Jev API key (TYPESAFE_API_KEY or OPENROUTER_API_KEY — JevCode picks the host from the variable you set): ` and the
saved file key is `jevApiKey` plus `jevProvider` when given; `--status` prints `decider.provider` with its source.
In jev-only the generator prompt is skipped unless `--provider` is passed (mirrors the wizard).

---

## 7. The status badge and the composer strings

### 7.1 Badge text and placement (`src/tui/status/lines.ts`, O5)

```ts
export function modeBadge(mode: EngineMode): 'jev-only' | 'jev+llm' | 'llm-only' { return mode === 'jev-only' ? 'jev-only' : mode === 'jev-on' ? 'jev+llm' : 'llm-only'; }
```

`StatusLineState` gains `readonly nextMode: EngineMode` and `readonly thinking: ThinkingPhase | null`; `leftZoneText`
becomes `[leftZoneWord(s, o), modeBadge(s.run !== 'none' && s.mode !== null ? s.mode : s.nextMode), ...badges(s)].join('  ')`
— the badge is the **first** badge, always present (§24: badges `jev-only` · `jev+llm` · `llm-only` join `!n` ·
`sandbox: none` · `no-net`), separated by two spaces like the zones. While a run is live it shows the live run's
mode; idle it shows the next run's (`pending.mode ?? baseMode`), so `/mode jev-on` during a run changes the badge at
`run:end`. Colour role `accent` (the theme's decoration role, marker-free by `validateTheme`'s rule — the badge word
is its own marker). A toast replaces the whole left zone for its 2 s as today. `leftWord` gains, before the `s.run ===
'none'` branch: `if (s.thinking !== null) return \`${spinnerGlyph(o)} ${THINKING_WORDS[s.thinking]}\`` with
`THINKING_WORDS = { intake: 'thinking', lookup: 'looking', replying: 'replying', asking: 'asking' }`. In `--ascii`
the badge is unchanged (`+` is ASCII); the sparkline/git/help drop order is unchanged (the badge is in the left zone
and yields only with the left zone's truncation rule).

### 7.2 Reducer additions (`src/tui/useEngine.tsx`, O9)

`UiState` gains `nextMode: EngineMode` (initial: `modeFromParsedFlags(flags)` passed through `RendererOptions.nextMode`,
so the **first frame** already carries `jev-only`), `thinking: ThinkingPhase | null`, `chatRows: readonly DecisionRow[]`.
`UiAction` gains `{ type: 'next-mode'; mode: EngineMode }`, `{ type: 'thinking'; phase: ThinkingPhase | null }`,
`{ type: 'chat-decisions'; rows: readonly DecisionRow[] }`. The controller reaches them through the existing
`extras.dispatch` channel (`session.ts:920-927`, used today for `thresholds`). `run:start` sets `mode` (today) and
clears `thinking`; `run:end` leaves `nextMode` untouched.

### 7.3 Composer placeholders (`src/tui/composer/Composer.tsx:47-50`, §24)

```ts
export const PLACEHOLDERS = {
  task:      'Say hi, ask about the code, or describe a task…   / commands · ? help',                       // < 100 columns
  taskWide:  'Say hi, ask about this code, or describe a task…   / commands · @ files · ? help · Enter sends', // ≥ 100 columns
  followup:  'Ask, or describe the next task…   Enter sends · ↑ history · ? help',
  steer:     'Type to steer the next step…   Esc pauses · Esc Esc aborts',                                    // unchanged
  thinking:  '(thinking…)',                                                                                    // composer stays editable; Enter queued (§4.3)
  intakeWait: '(waiting for y/n)',                                                                              // the ambiguity row is up
  …today's review / followupWait / exitWait / blocked / done entries unchanged
} as const;
```

`placeholderFor(mode, rows, columns)` gains the `columns` argument for the `task` / `taskWide` split. The first frame
prints `task` (or `taskWide`) exactly as it prints `Describe the task…` today; the `perf/first-frame.ts` sentinel is the
status `step 0/–`, not the placeholder, so nothing in the gate moves.

---

## 8. Contract additions (`src/core/types.ts`, contract 1.2 — additive; O1 lands them in one W0 PR)

Header comment: `// contract 1.2 (2026-09-21): conversational intake, Jev providers, mode setting per
docs/research/tui/round-2/design-conversation.md §8; every new field on an existing type is optional or has a
default-preserving widening; CheckpointEnvelope.version stays 1.` The assignment rule of TUI-DESIGN §15 holds
(`exactOptionalPropertyTypes`: conditional spreads, never `= undefined`). Anchors are `types.ts:<line>` at HEAD.

```ts
// 1  UiLabel (types.ts:1100) — two members; formatTranscriptItem prints them like the four existing labels
export type UiLabel = '[ui]' | '[setup]' | '[config]' | '[sandbox]' | '[you]' | '[jevcode]';
/** the chat labels (src/chat/bubbles.ts groups consecutive items carrying one of them into a bubble) */
export type ChatLabel = Extract<UiLabel, '[you]' | '[jevcode]'>;

// 2  DeciderConfig (types.ts:1349) — provider, pricing, source; every existing constructor site gains the three fields
//    (resolve.ts validateDecider; bench/cli.ts:37; cli/session.ts:1469, :1792 mock stub; perf/step-overhead.ts:154; test fakes)
export type JevProvider = 'typesafe' | 'openrouter';
export type JevProviderSource = 'flag' | 'env' | `dotenv:${string}` | `file:${string}` | 'auto:base-url' | 'auto:typesafe-key' | 'auto:openrouter-key' | 'default';
export interface DeciderConfig {
  provider: JevProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  pinned: boolean;
  pricing: { inputUsdPerToken: number; outputUsdPerToken: number };
  providerSource: JevProviderSource;
}

// 3  JevUsage (types.ts:172) — cost optional: TypeSafe's native response carries none (validate.ts reads it as optional; client.ts derives)
export interface JevUsage { input_tokens: number; output_tokens: number; cost?: number }

// 4  AskResult (types.ts:482) — how costUsd was obtained
export interface AskResult { /* …existing… */ costBasis?: 'provider' | 'table' }

// 5  Decider (types.ts:493) — the provider, for /jev and the drift pane (mock and fakes: 'openrouter')
export interface Decider { readonly model: string; readonly provider: JevProvider; ask(state: Json, questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> }

// 6  EngineOptions.deciderModel (types.ts:987) — the provider the drift rule keys on
export interface EngineOptions { /* … */ deciderModel: { configured: string; pinned: boolean; provider: JevProvider }; /* … */ }

// 7  ResolvedConfig (types.ts:1358) — the resolved mode (flag > JEVCODE_MODE > dotenv > file > default 'jev-only')
export interface ResolvedConfig { /* … */ readonly mode: EngineMode; /* … */ }

// 8  SessionHost.submit (types.ts:1235) — the outcome the renderer needs for history kind and the status word; `kind: 'task'` = one-shot argv path (never intake)
export type SubmitOutcome = { became: 'run' | 'chat' | 'nothing' };
export interface SessionHost {
  submit(text: string, opts: { kind: 'prompt' | 'follow-up' | 'task'; secretSpans: readonly string[]; pinnedFiles: readonly string[] }): Promise<SubmitOutcome>;
  /* …the other members unchanged… */
}

// 9  Renderer (types.ts:1303) — optional hooks the controller uses for chat (every fake keeps compiling)
export interface Renderer {
  /* …existing… */
  /** §3.8 Esc on the ambiguity row: the message goes back into the composer */
  restoreDraft?(text: string): void;
  /** §3.6.2: the LLM turn's streamed text for the live region (the same channel a generator proposal uses) */
  live?(text: string): void;
}
//    Prompter (cli/session.ts:246, not core) gains: intake?(message: string): Promise<'run' | 'chat' | 'keep'>

// 10 HistoryStore (types.ts:1282)
export interface HistoryStore { entries(filter: 'workspace' | 'all'): readonly string[]; append(kind: 'prompt' | 'steer' | 'command' | 'chat', text: string): void; clear(): void }

// 11 SessionRef (types.ts:944) — why the run started, for run.json and the `s0 intake` row
export interface SessionRef { /* …existing… */ intake?: { kind: IntakeKind; probability: number; requestHash: string } }
export type IntakeKind = 'greeting_or_smalltalk' | 'question_about_this_tool' | 'question_about_the_code' | 'coding_task' | 'ambiguous';

// 12 RendererOptions (types.ts:1286) — the first frame's badge
export interface RendererOptions { /* … */ nextMode?: EngineMode }

// 13 EngineMode (types.ts:371) — unchanged; the default moves to 'jev-only' in modeFromParsedFlags / modeFromFlags / the `mode` setting

// 14 (not in core) src/session/index.ts IndexLine gains
//    | { v: 1; t: string; kind: 'chat'; sessionId: string; intake: IntakeKind; costUsd: number; provider: JevProvider | 'generator' }
//    src/cli/json-stream.ts gains the controller line  { type: 'chat'; intake: IntakeKind; probability: number; provider: JevProvider | 'generator'; costUsd: number; latencyMs: number; requestHash: string }
//    src/tui/plain.ts TranscriptKind gains 'chat'; src/tui/layout.ts OverlayKind gains 'intake' (COLLAPSING, CAP.intake = 1)
//    src/tui/composer/history.ts HistoryKind gains 'chat'
//    src/config/types.ts SettingName gains 'decider.provider' | 'mode'; src/cli/args.ts STRING_FLAGS gains 'jevProvider'
```

Compile order (W0): items 1–13 plus the fake engines/deciders in `test/unit/bench/helpers.ts`, `test/fixtures/tui/fixtures.ts`,
`test/unit/provider/helpers.ts` and `src/jev/mock.ts` (`provider: 'openrouter'`, `costBasis: 'provider'`); `tsc --strict`
green before O6/O7/O9/O10/O11 start. Widening `submit()`'s return type is source-compatible for every caller that
ignores it (`App.tsx:801`, `plain-composer.ts`); `kind: 'task'` is new and only `submitTask` passes it.

---

## 9. Tests, probes, live suites

### 9.1 Unit (vitest `unit`, offline; one file per new module — the §19.0 sync test extends to `src/chat/**`)

| File | Asserts |
| --- | --- |
| `test/unit/chat/intake.test.ts` | question snapshot (every Choice has `none_of_these`; every Noul has definition + ≥ 2 examples both sides; keys pass `KEY_SHAPE`/`BAD_KEY`); state bounds (message 1,200, conversation 6 × 200, mentions 5); `resolveIntake` table: chosen `coding_task` 0.61 → run, 0.59 → ambiguous, `overridden` → ambiguous, escape → ambiguous, `near` at 0.58–0.63; `chatKindAfterNo` argmax and tie rule; `[measured]` harness ≤ 5 ms p95 over 1,000 builds |
| `test/unit/chat/replies.test.ts` | 14 rows, unique keys, texts ≤ 160 chars, no emoji, ≥ 2 examples each; `fillReply` placeholders; `pickReply` escape → fallback |
| `test/unit/chat/facts.test.ts` | every fact text contains no key material for a fixture config with keys (`sha256` fingerprints and env names only); `selectFacts` ≥ 0.5 / top-2 fallback / order by p / ≤ 4 |
| `test/unit/chat/lookup.test.ts` | keywords/stoplist; `rankCandidates` mentions-first and the ≤ 60 cap in ≤ 1 ms over 20,000 candidates; denylist paths dropped; excerpt lines ≤ 3 per file ≤ 120 cells; the two bubble shapes |
| `test/unit/chat/llm-turn.test.ts` | `buildChatRequest` has no `tools`, temperature `null`, ≤ 6 turns, files fenced, system prompt literal; a mock provider's tool call is dropped with a warning; unpriced refusal text |
| `test/unit/chat/lines.test.ts` | `intakeRowLines` at 40/80/100/120 columns, ascii and SR twins, widths ≤ columns |
| `test/unit/chat/bubbles.test.ts` | grouping of consecutive labels; the identity rule `stripGutter(rowText) === formatTranscriptItem(item)` against the D-D renderer's dress |
| `test/unit/jev/providers.test.ts` | `JEV_PROVIDERS` table; `isPinnedJevModel` (`jev-1.13.0` pinned on typesafe, alias on openrouter; `-20260917` pinned on openrouter, rejected by `validateDecider` on typesafe); `jevModelMatches` (`jev-latest` → `jev-1.13.0`; `jev-1.13` → `jev-1.13.0` and `jev-1.13-20260917`; `jev-1.1` ↛ `jev-1.13.0`); `providerForHost`; `EQUIVALENT_IDS` |
| `test/unit/jev/client.test.ts` (extended) | typesafe headers (no referer), `x-typesafe-request-id` captured/redacted/clipped, `detail.message` hint, 400 `Unknown model` → `ConfigError` exit 2 without retry, 422 non-retryable, cost derivation `input × 4.2e-8` with `costBasis 'table'` when `usage.cost` is absent, `'provider'` when present |
| `test/unit/config/resolve.test.ts` (extended) | the auto table of §2.3 (JEV_API_KEY → openrouter; TYPESAFE_API_KEY → typesafe; both → openrouter only with JEV_API_KEY; base URL host wins); `mode` row precedence and default `jev-only`; provider-keyed defaults; `record()` rows |
| `test/unit/cli/session-chat.test.ts` | the controller with a fake decider scripted per message: `hi` → one `[you]` + one `[jevcode]` item, no `run:start`, session meter +cost, history `chat`, `--json` `chat` line; `fix the test` → `run:start`; ambiguous → `Prompter.intake` called, `keep` restores the draft; cap reached → refusal, zero requests; Jev unreachable → the retry bubble, zero runs |
| `test/unit/tui/onboarding/reducer.test.ts` (extended) | jev-only detect → `jevProvider` when no provider inferred, else `jevKey`; `reason: 'mode'` Ctrl-C → `done`, never `exit` |
| `test/unit/tui/status/lines.test.ts` (extended) | badge first, live vs next mode, `⠹ thinking` words, ascii twin |
| `test/unit/tui/reducer.test.ts` (extended) | `next-mode`, `thinking`, `chat-decisions` rows; `run:start` clears `thinking` |

### 9.2 pty (`test/pty/smoke/*.steps` + `test/pty/chat.pty.test.ts`, `--mock`)

- `chat-hi.steps`: `expect Say hi` → `send hi\r` → `expect \[you\] hi` → `expect \[jevcode\] Hi\.` → `expect jev-only` (badge)
  → `/exit` → eof; gates: exit 0, `clears_after_first_frame=0`, `restores=1`, **no `[run] ready`** in the capture.
- `chat-ambiguous.steps`: `JEVCODE_MOCK_INTAKE=ambiguous`; `send the date parsing\r` → `expect run this as a task\?` →
  `send n` (≥ 200 ms after the row) → `expect \[jevcode\]` → no run; a second scenario answers `y` → `expect ready`.
- `mode-switch.steps`: `send /mode jev-on\r` in a home with only a Jev key → `expect Pick the provider` → Ctrl-C →
  `expect mode stays jev-only` → badge still `jev-only`; then with `ANTHROPIC_API_KEY` set → `expect jev\+llm from the next run`
  and the badge `jev+llm`.
- `chat-run-exit.steps` (existing) keeps passing: `fix the failing test` is `coding_task` under the mock heuristics.

### 9.3 Live (`vitest --project live`, `JEVCODE_LIVE=1 node --env-file=.env …`; paid, skipped without the key; nothing here was run while writing)

`test/live/jev.live.test.ts` becomes a table over the two providers:

```ts
const CASES = [
  { provider: 'openrouter' as const, key: process.env['OPENROUTER_API_KEY'] ?? process.env['JEV_API_KEY'] ?? '', model: 'typesafe/jev-1.13-20260917', expectId: /^gen-dec-/, basis: 'provider' },
  { provider: 'typesafe' as const,   key: process.env['TYPESAFE_API_KEY'] ?? '',                                     model: 'jev-1.13.0',                 expectId: /.+/,          basis: 'table' },
];
describe.each(CASES.filter((c) => live && c.key.length > 0))('jev live · $provider', (c) => { /* today's three questions; plus: */
  // served model === c.model and checkServedModel ok; res.costBasis === c.basis; costUsd === inputTokens × 4.2e-8 (± 1e-9) on both;
  // typesafe: an ask with model 'jev-1.13-20260917' rejects with ConfigError (exit 2) and no meter add; 'jev-latest' resolves to /^jev-1\.13\./ and reports the alias warning path;
  // requestId non-null on both; latency printed
});
```

`test/live/intake.live.test.ts` (new): the 14-message table — `hi`, `thanks, that worked`, `you there?`, `what can you
do?`, `which mode is this?`, `how much has this cost?`, `where is the date parsing?`, `why does test_parse_date fail?`,
`fix the failing test in utils/dates.py`, `add a --dry-run flag to the cli`, `run the tests`, `also update the CHANGELOG`,
`the date parsing`, `tests?` — with the expected kind for the first twelve and `ambiguous`-or-question tolerated for
the last two; asserts **≥ 11 of 12 unambiguous cases match**, **no unambiguous non-task message resolves `coding_task`**
(the failure that started this round), prints the confusion table, p50/p95 latency and total cost per provider
(expected ≈ 14 × 1,650 tokens × 4.2e-8 ≈ $0.001 per provider). Run once on both providers before merge; record the
table in `docs/STATUS.md` (the way the 30-task run is recorded).

### 9.4 Perf (`jevcode perf`, D-E gates kept)

`src/perf/intake-latency.ts` (new): `chat --mock` in a 24×80 pty, 20 messages alternating greeting / task-shaped,
measures Enter → `[you]` frame (gate p95 < 16 ms, the composer gate) and Enter → `[jevcode]` frame at mock latency 0
(gate p95 < 40 ms) and at `JEVCODE_MOCK_JEV_MS=110` (report; ≈ 110 + overhead). The existing gates (first frame < 300 ms;
lag p95 net < 5 ms; fps ≤ maxFps + 1; zero clears; composer p95 < 16 ms) run unchanged; the badge and the `thinking`
word add one status re-render per intake, inside the 1 Hz tick budget.

---
## 10. Frames (ASCII, 80 and 120 columns)

Legend: rows above the first `╭` are `<Static>` scrollback (a scrollback item longer than the width wraps in a real terminal; here it is cut at the frame edge with `…`); the composer is a rounded box (D-D); the status row is the three-zone row of TUI-DESIGN §7.4 with the mode badge as its first badge (§7.1) and its drop order (ShortHelp → sparkline → git → session meter → wall) applied — Designer A may wrap it in D-D's status box, which adds two rows to every dynamic count below and changes no text. Every dynamic count is inside `rows − 2`. Chat items print exactly as `formatTranscriptItem` writes them (`[you] …`, `[jevcode] …`); D-D's bubble dress (dim label, brand colour, ≤ 2-cell gutter) is colour and gutter only (§3.10). `⠹` is the spinner, `–` the `step 0/–` sentinel. The TUI-DESIGN §19.1 unit test that measures every fenced block against its caption applies to this file too.

**F-B1. Idle after the splash, jev-only, keys found in `.env` (TypeSafe auto-detected), 80×24 (4 dynamic rows; 4 scrollback rows shown)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: typesafe · jev-1.13.0 · key TYPESAFE_API_KEY (dotenv:./.env)
[sandbox] seatbelt — writes confined to the workspace and run dirs; harness sec…
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Say hi, ask about the code, or describe a task…   / commands · ? help      │
╰──────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                              step 0/–  sess $0.00/1.25 ok  ? help
```

**F-B1w. The same, 120 columns, 120×40 (4 dynamic rows; 4 scrollback rows shown)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: typesafe · jev-1.13.0 (pinned) · key TYPESAFE_API_KEY (dotenv:/Users/me/proj/.env) · about 110 ms per…
[sandbox] seatbelt — writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; re…
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Say hi, ask about this code, or describe a task…   / commands · @ files · ? help · Enter sends                     │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                         proj                         step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  ? help
```

**F-B2a. `hi` just sent: the `[you]` bubble is committed, Jev is being asked (one request), 80×24 (4 dynamic rows; 6 scrollback rows shown)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: typesafe · jev-1.13.0 · key TYPESAFE_API_KEY (dotenv:./.env)
[sandbox] seatbelt — writes confined to the workspace and run dirs; harness sec…
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)

[you] hi
╭──────────────────────────────────────────────────────────────────────────────╮
│ > (thinking…)                                                                │
╰──────────────────────────────────────────────────────────────────────────────╯
⠹ thinking  jev-only                        step 0/–  sess $0.00/1.25 ok  ? help
```

**F-B2b. The reply, 118 ms later, and a second exchange; the composer shows the follow-up placeholder, 80×24 (4 dynamic rows; 9 scrollback rows shown)**

```
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)

[you] hi
[jevcode] Hi. I'm ready when you are — describe a change you want in proj, or a…
[jevcode] what I can do.

[you] thanks
[jevcode] You're welcome. Anything else on proj?

╭──────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help         │
╰──────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                              step 0/–  sess $0.00/1.25 ok  ? help
```

**F-B2w. The same exchange at 120 columns (one line per reply; the status gains the git zone and the Jev sparkline), 120×40 (4 dynamic rows; 8 scrollback rows shown)**

```
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)

[you] hi
[jevcode] Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.

[you] thanks
[jevcode] You're welcome. Anything else on proj?

╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                    proj                    step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  jev ▂▂▁▂  ? help
```

**F-B3. A question about the tool: three facts selected by Jev (`about_what_it_is` 0.91, `about_mode_now` 0.77, `about_switch_mode` 0.62), 80×24 (4 dynamic rows; 8 scrollback rows shown)**

```
[you] what can you do?
[jevcode] JevCode is a coding agent where Jev, a decision model, makes every de…
[jevcode] what kind of step comes next, which files matter, how risky an action…
[jevcode] whether a step worked. In jev-only mode code proposes fixes and tests…
[jevcode] them; in jev+llm mode Claude writes the code.
[jevcode] Mode: jev-only — no generating LLM; code proposes, Jev decides, tests…
[jevcode] Switch with /mode jev-on (alias /llm on) or /mode jev-only; it applie…
[jevcode] next run. Persist it with jevcode config set mode <m>.
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help         │
╰──────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                              step 0/–  sess $0.00/1.25 ok  ? help
```

**F-B3w. The same at 120 columns (a fact is one item; the renderer wraps a long fact line, the plain twin prints it whole), 120×40 (4 dynamic rows; 6 scrollback rows shown)**

```
[you] what can you do?
[jevcode] JevCode is a coding agent where Jev, a decision model, makes every decision: what kind of step comes next, wh…
[jevcode] files matter, how risky an action is, whether a step worked. In jev-only mode code proposes fixes and tests v…
[jevcode] them; in jev+llm mode Claude writes the code.
[jevcode] Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.
[jevcode] Switch with /mode jev-on (alias /llm on) or /mode jev-only; it applies to the next run. Persist it with jevco…
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                   proj                    step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  jev ▂▂▁▂▂  ? help
```

**F-B4a. A code question in jev-only: the honest lookup (one Jev request over 41 candidates, two files ≥ 0.5), 80×24 (4 dynamic rows; 7 scrollback rows shown)**

```
[you] where is the date parsing?
[jevcode] In jev-only mode I can point at code but not explain it — Jev decides…
[jevcode] doesn't write. Likely places:
[jevcode]   utils/dates.py:12  def parse_date(s: str, tz: str | None = None) ->…
[jevcode]   utils/dates.py:31      return datetime.strptime(s, FMT).replace(tzi…
[jevcode]   tests/test_dates.py:8  def test_parse_date_tz():
[jevcode] Switch with /mode jev-on to get an explanation from the LLM, or descr…
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help         │
╰──────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                              step 0/–  sess $0.00/1.25 ok  ? help
```

**F-B4b. The same question in jev+llm while the generator streams (live region 2 rows, status `⠹ replying`), 80×24 (6 dynamic rows; 1 scrollback rows shown)**

```
[you] where is the date parsing?
  parse_date in utils/dates.py:12 builds a datetime with strptime and then repl…
  the tzinfo (line 31), which is why a naive input keeps the local offset; the …
╭──────────────────────────────────────────────────────────────────────────────╮
│ > (thinking…)                                                                │
╰──────────────────────────────────────────────────────────────────────────────╯
⠹ replying  jev+llm                        step 0/–  sess $0.01/10.00 ok  ? help
```

**F-B4c. The committed jev+llm reply at 120 columns (one item per line; the live region is empty again), 120×40 (4 dynamic rows; 4 scrollback rows shown)**

```
[you] where is the date parsing?
[jevcode] parse_date in utils/dates.py:12 builds a datetime with strptime and then replaces the tzinfo (line 31), which…
[jevcode] a naive input keeps the local offset; tests/test_dates.py:8 (test_parse_date_tz) is the test that pins the be…
[jevcode] If you want it timezone-aware, describe the change and a run will make it — I don't edit from here.
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
idle  jev+llm                   proj                   step 0/–  sess $0.01/10.00 ok  ⎇ main · 3~ 1?  jev ▂▂▁▂▂▃  ? help
```

**F-B5. `ambiguous` (`the date parsing`, `coding_task` 0.48): the one-row overlay; the composer is collapsed and inactive; Enter does nothing, 80×24 (5 dynamic rows; 2 scrollback rows shown)**

```
[you] the date parsing

run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Ent…
╭──────────────────────────────────────────────────────────────────────────────╮
│ > (waiting for y/n)                                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
asking  jev-only                            step 0/–  sess $0.00/1.25 ok  ? help
```

**F-B5w. The same at 120 columns (the message is echoed in the row), 120×40 (5 dynamic rows; 2 scrollback rows shown)**

```
[you] the date parsing

"the date parsing" — run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > (waiting for y/n)                                                                                                  │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
asking  jev-only                        proj                        step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  ? help
```

**F-B6a. `/mode jev-on` with a generator key present: the item, and the badge follows at once (idle shows the NEXT run's mode), 80×24 (4 dynamic rows; 3 scrollback rows shown)**

```
[you] thanks
[jevcode] You're welcome. Anything else on proj?
[ui] mode jev+llm from the next run — Claude writes the code, Jev still decides…
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help         │
╰──────────────────────────────────────────────────────────────────────────────╯
idle  jev+llm                              step 0/–  sess $0.00/10.00 ok  ? help
```

**F-B6b. Live run under jev+llm: the badge is the live run's mode; the collapsed Jev panel (≤ 6 rows, D-D) has the `s0 intake` row first; `? help` dropped by the §7.4 order, 80×24 (13 dynamic rows; 2 scrollback rows shown)**

```
[you] fix the failing test in utils/dates.py
[run] ready 20260921-141203-k2n8v4qa step 0/40
─── jev  s2 · d expands ────────────────────────────────────────────────────────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen
s1 intent   intent           investigate ██████▍···  0.64  c 0.55   chosen
s1 context  utils/dates.py   noul        ████████▏·  0.81  c 0.62~
s2 intent   intent           edit        ███████▏··  0.71  c 0.64   chosen
s2 risk     destructive      L1          █████████·  0.90  c 0.93   [ok]
s2 risk     plan_mismatch    L0          ██████████  1.00  c 1.00   [ok]
  the timezone. I will make parse_date return an aware datetime by replacing
  strptime with fromisoformat and normalising naive inputs to UTC before the
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Type to steer the next step…   Esc pauses · Esc Esc aborts                 │
╰──────────────────────────────────────────────────────────────────────────────╯
⠹ propose  jev+llm       step 2/40 0m41s  run $0.06/2.00 ok  sess $0.06/10.00 ok
```

**F-B6w. Live run at 120 columns, jev-only (propose = [synth]); badge, git zone, sparkline, 120×40 (13 dynamic rows; 2 scrollback rows shown)**

```
[you] fix the failing test in utils/dates.py
[run] ready 20260921-141203-k2n8v4qa step 0/40
─── jev  s2 · d expands ────────────────────────────────────────────────────────────────────────────────────────────────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen      118ms  resolveChoice → run floor 0.60 →…
s1 intent   intent           investigate ██████▍···  0.64  c 0.55   chosen      112ms  choice resolution → intent inves…
s1 context  utils/dates.py   noul        ████████▏·  0.81  c 0.62~              112ms  selected iff p ≥ 0.5
s2 intent   intent           verify      ███████▏··  0.71  c 0.64   chosen      109ms  choice resolution → intent verify
s2 risk     destructive      L0          ██████████  1.00  c 1.00   [ok]        121ms  band 0.3/0.7 (expected)
s2 risk     plan_mismatch    L0          █████████▌  0.95  c 0.96   [ok]        121ms  band 0.3/0.7 (tail)
synth  verify: the engine has not run the suite on this workspace: pytest -q tests/test_dates.py
synth  baseline: 1 of 12 fails in the synthesizer's own run
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Type to steer the next step…   Esc pauses · Esc Esc aborts                                                         │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
⠹ propose [synth]  jev-only         step 2/40 0m41s  run $0.02/0.25 ok  sess $0.02/1.25 ok  ⎇ main · 3~ 1?  jev ▂▂▁▂▂▃▂▂
```

**F-B7. `/mode jev-on` with no generator key: the wizard's generator step opens in place (3 rows; the composer is refunded, TUI-DESIGN D1), 80×24 (4 dynamic rows; 3 scrollback rows shown)**

```
[you] thanks
[jevcode] You're welcome. Anything else on proj?

jev+llm needs a generator. Pick the provider:
  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)
Keys are never shown, logged or echoed · Esc back · Ctrl-C keeps jev-only
setup  jev-only                                     step 0/–  sess $0.00/1.25 ok
```

**F-B7b. The masked generator key field after `1`; Enter saves, the `[setup]` items follow and the badge flips (no key byte ever reaches a frame), 80×24 (4 dynamic rows; 3 scrollback rows shown)**

```
[you] thanks
[jevcode] You're welcome. Anything else on proj?

Anthropic API key (ANTHROPIC_API_KEY)
> ••••••••••••••••••••••••••••••••
32 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back
setup  jev-only                                     step 0/–  sess $0.00/1.25 ok
```

**F-B7w. The generator step at 120 columns, 120×40 (4 dynamic rows; 3 scrollback rows shown)**

```
[you] thanks
[jevcode] You're welcome. Anything else on proj?

jev+llm needs a generator. Pick the provider:
  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)
Keys are never shown, logged or echoed · Esc back · Ctrl-C keeps jev-only
setup  jev-only                            proj                             step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?
```

**F-B8. A task run with D-D's collapsed one-line-per-step summary (Designer A owns the rows; shown for the `[you]` bubble, the `s0 intake` line and the badge), 80×24 (7 dynamic rows; 6 scrollback rows shown)**

```
[you] fix the failing test in utils/dates.py
[run] ready 20260921-141203-k2n8v4qa step 0/40
[step 1] investigate · read utils/dates.py, tests/test_dates.py · ok · 3.1s · $…
[step 2] verify · run pytest -q tests/test_dates.py · 1 failed · 2.4s · $0.003
[step 3] edit · patch utils/dates.py (+4 −2) · risk ok · 6.8s · $0.004
[step 4] verify · run pytest -q tests/test_dates.py · 12 passed · 2.2s · $0.002
─── jev  s5 · d expands ────────────────────────────────────────────────────────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen
s5 complete task_complete    noul        ████████▊·  0.88  c 0.76~
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Type to steer the next step…   Esc pauses · Esc Esc aborts                 │
╰──────────────────────────────────────────────────────────────────────────────╯
⠹ complete  jev-only      step 5/40 0m58s  run $0.02/0.25 ok  sess $0.02/1.25 ok
```

**F-B8w. The same at 120 columns, 120×40 (7 dynamic rows; 6 scrollback rows shown)**

```
[you] fix the failing test in utils/dates.py
[run] ready 20260921-141203-k2n8v4qa step 0/40
[step 1] investigate · read utils/dates.py, tests/test_dates.py · ok · 3.1s · $0.002
[step 2] verify · run pytest -q tests/test_dates.py · 1 failed 11 passed · 2.4s · $0.003
[step 3] edit · patch utils/dates.py (+4 −2) · risk ok (destructive L1 0.90, plan_mismatch L0 1.00) · 6.8s · $0.004
[step 4] verify · run pytest -q tests/test_dates.py · 12 passed · 2.2s · $0.002
─── jev  s5 · d expands ────────────────────────────────────────────────────────────────────────────────────────────────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen      118ms  resolveChoice → run floor 0.60 →…
s5 complete task_complete    noul        ████████▊·  0.88  c 0.76~              104ms  ≥ 0.85 → stop
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Type to steer the next step…   Esc pauses · Esc Esc aborts                                                         │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
⠹ complete  jev-only    step 5/40 0m58s  run $0.02/0.25 ok  sess $0.02/1.25 ok  ⎇ main · 4~ 1?  jev ▂▂▁▂▂▃▂▂▂▁▂▂  ? help
```

**F-B9. The Jev panel expanded with `d` (12 rows; the intake rows of the message that started the run come first), 80×24 (17 dynamic rows; 1 scrollback rows shown)**

```
[step 4] verify · run pytest -q tests/test_dates.py · 12 passed · 2.2s · $0.002
─── jev  s5 · expanded · d collapses ───────────────────────────────────────────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen
s0 intake   can_coding_task  noul        ████████▍·  0.84  c 0.68~
s0 intake   can_question_ab… noul        █▏········  0.12  c 0.76~
s0 intake   reply            none_of_th… █▌········  0.15  c 0.09
s5 intent   intent           finish      ████████▏·  0.81  c 0.76   chosen
s5 intent   can_finish       noul        ████████▊·  0.88  c 0.76~
s5 intent   plan_still_valid noul        █████████·  0.90  c 0.80~
s5 risk     destructive      L0          ██████████  1.00  c 1.00   [ok]
s5 risk     out_of_scope     L0          ██████████  1.00  c 1.00   [ok]
s5 risk     plan_mismatch    L0          █████████▌  0.95  c 0.96   [ok]
s5 judge    succeeded        noul        ████████▉·  0.89  c 0.78~
s5 complete task_complete    noul        ████████▊·  0.88  c 0.76~
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help         │
╰──────────────────────────────────────────────────────────────────────────────╯
idle exit 0  jev-only      step 5/5 0m58s  run $0.02/0.25 ok  sess $0.02/1.25 ok
```

**F-B9w. The expanded panel at 120 columns (`latencyMs` and `consumedBy` columns; the intake rows carry their own rule text), 120×40 (12 dynamic rows; 1 scrollback rows shown)**

```
[step 4] verify · run pytest -q tests/test_dates.py · 12 passed · 2.2s · $0.002
─── jev  s5 · expanded · d collapses ───────────────────────────────────────────────────────────────────────────────────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen      118ms  resolveChoice → run floor 0.60 →…
s0 intake   can_coding_task  noul        ████████▍·  0.84  c 0.68~              118ms  paired ≥ 0.5
s0 intake   reply            none_of_th… █▌········  0.15  c 0.09              118ms  argmax → catalogue (unused: not a…
s5 intent   intent           finish      ████████▏·  0.81  c 0.76   chosen      104ms  choice resolution → intent finish
s5 risk     destructive      L0          ██████████  1.00  c 1.00   [ok]        121ms  band 0.3/0.7 (expected)
s5 judge    succeeded        noul        ████████▉·  0.89  c 0.78~              104ms  reported
s5 complete task_complete    noul        ████████▊·  0.88  c 0.76~              104ms  ≥ 0.85 → stop
╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > Ask, or describe the next task…   Enter sends · ↑ history · ? help                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
idle exit 0  jev-only    step 5/5 0m58s  run $0.02/0.25 ok  sess $0.02/1.25 ok  ⎇ main · 4~ 1?  jev ▂▂▁▂▂▃▂▂▂▁▂▂  ? help
```

**F-B10. The review card (D-D rounded box; rows and keys are TUI-DESIGN §6.1 verbatim — Designer A owns the box; shown for the badge: the composer collapses, the badge stays), 80×24 (14 dynamic rows; 1 scrollback rows shown)**

```
[step 3] risk review (destructive L2 0.44 tail)
╭──────────────────────────────────────────────────────────────────────────────╮
│ review  step 3  risk 0.44 (tail)  run "rm -rf build/ && make"                │
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  dominant level (why)           │
│ 1 destructive L2  ████▍·····  0.44 tail 0.61  deletes generated files        │
│ 2 out_of_scope L0 ··········  0.02 exp  0.98  within the task's files        │
│ 3 plan_mismatch L0 ▌········  0.05 exp  0.94  matches intent and the plan    │
│ 4 irreversible L1 ██▍·······  0.24 exp  0.80  recoverable from git           │
│ 5 matches_intent  ████████▊·  0.88 noul 0.76~ carries out the goal           │
╰──────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────╮
│ > (review pending — keys above; d opens a note)                              │
╰──────────────────────────────────────────────────────────────────────────────╯
review  jev-only  step 3/40 0m47s  run $0.02/0.25 ok  sess $0.02/1.25 ok  ? help
```

**F-B11a. Splash frame 1 (t = 0; the first frame, argv only, < 300 ms; Designer A's wordmark — this sketch shows only the rows the badge and status need), 80×24 (8 dynamic rows; 0 scrollback rows shown)**

```

   ▐▛▀▜ ▄▄▄ ▄   ▄ ▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄▄▄


╭──────────────────────────────────────────────────────────────────────────────╮
│ > Say hi, ask about the code, or describe a task…   / commands · ? help      │
╰──────────────────────────────────────────────────────────────────────────────╯
starting  jev-only                                              step 0/–  ? help
```

**F-B11b. Splash mid frame (t ≈ 350 ms; a tiny diff per frame at ≤ 30 fps; typing aborts the reveal), 80×24 (8 dynamic rows; 0 scrollback rows shown)**

```

   ▐▛▀▜ ▄▄▄ ▄   ▄ ▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄▄▄
     ▐  ▙▄▄ ▜▄▄▄▛ ▐     ▐   ▐ ▐   ▌ ▙▄▄

╭──────────────────────────────────────────────────────────────────────────────╮
│ > Say hi, ask about the code, or describe a task…   / commands · ? help      │
╰──────────────────────────────────────────────────────────────────────────────╯
starting  jev-only                                              step 0/–  ? help
```

**F-B11c. Splash final frame (t ≤ 700 ms) settled into the header; the brand row carries the mode badge from the first frame onward, 80×24 (4 dynamic rows; 2 scrollback rows shown)**

```
[run] jevcode session · proj | step 0/– starting
[ui] jevcode 0.2.0 · jev-only · Jev decides every step · / commands · ? help
╭──────────────────────────────────────────────────────────────────────────────╮
│ > Say hi, ask about the code, or describe a task…   / commands · ? help      │
╰──────────────────────────────────────────────────────────────────────────────╯
idle  jev-only                              step 0/–  sess $0.00/1.25 ok  ? help
```


---

## 11. Glossary additions (TUI-DESIGN §24; every twin renders these exactly; `--ascii` substitutes per §14.1)

**Placeholders.** `Say hi, ask about the code, or describe a task…   / commands · ? help` (< 100 columns) ·
`Say hi, ask about this code, or describe a task…   / commands · @ files · ? help · Enter sends` (≥ 100) ·
`Ask, or describe the next task…   Enter sends · ↑ history · ? help` · `(thinking…)` · `(waiting for y/n)` (the
ambiguity row) · `(setup)`.

**Status left-zone words and badges.** `⠹ thinking` · `⠹ looking` · `⠹ replying` · `asking` (the ambiguity row) ·
badges `jev-only` · `jev+llm` · `llm-only` (always first; live = the live run's mode, idle = the next run's).

**Chat items.** `[you] <message>` · `[jevcode] <reply line>` (one item per line) · the 14 catalogue texts of §3.4 ·
the 14 fact texts of §3.5 · lookup header `In jev-only mode I can point at code but not explain it — Jev decides, it
doesn't write. Likely places:` · lookup line `  <path>:<n>  <code ≤ 120 cells>` · lookup footer `Switch with /mode jev-on to
get an explanation from the LLM, or describe the change and I'll make it.` · lookup miss `I couldn't find a file in <dir>
that clearly answers that (looked at <n> candidates). Name the file or function, or switch with /mode jev-on for an
explanation.` · unreachable `I couldn't reach Jev to read that (<short>). Press Enter to send it again.` · cap
`The session cap ($<cap>) is reached, so I'm not sending anything to Jev. Raise it with /budget session-spend-cap <usd>,
or /new for a fresh session.` · unpriced LLM `I can't answer through the LLM: <model> has no pricing entry and
--allow-unpriced is off (jev-only lookup still works).` · kept `Okay — edit it and press Enter, or ask me something.`

**Ambiguity row.** `run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)` ·
≥ 100 columns: `"<message ≤ 40>" — run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does
nothing)` · `--plain`: `run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ` · SR: `1 run it
2 just chatting  3 keep the text` / `Enter selection (1-3):` · toast `intake pending: y n · Esc keeps the text`.

**Toasts.** `stopped thinking` (Ctrl-C during a chat request) · `one moment — still thinking` (Enter during one) ·
`saved — jev+llm from the next run`.

**Mode items.** `mode jev-only (next run: jev-only)` · `mode jev+llm from the next run — Claude writes the code, Jev still
decides every step (persist: jevcode config set mode jev-on)` · `mode jev-only from the next run — no generating LLM; code
proposes, Jev decides, tests verify` · `mode llm-only from the next run — the generator alone, no Jev (bench condition;
reviews still ask)` · `mode stays jev-only — no generator key was saved` · `mode <m> already`.

**Wizard.** `No Jev key found. Where do you reach Jev?` / `  1 typesafe (TYPESAFE_API_KEY, api.typesafe.ai)   2 openrouter
(OPENROUTER_API_KEY, also the generator)` (narrow `  1 typesafe   2 openrouter`) · `Jev API key (TYPESAFE_API_KEY)  1/1` ·
`Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1` · `jev+llm needs a generator. Pick the provider:` ·
`Keys are never shown, logged or echoed · Esc back · Ctrl-C keeps jev-only` · verify detail `one Jev decision at
api.typesafe.ai ~$0.00002 (jev-1.13.0)` · fix block `export TYPESAFE_API_KEY=…` / `export OPENROUTER_API_KEY=…` / `printenv
TYPESAFE_API_KEY | jevcode login --jev-key-stdin` / `jevcode login` / (jev-on only) `export ANTHROPIC_API_KEY=…`.

**Config and `/jev`.** `decider.provider  typesafe  derived (auto: TYPESAFE_API_KEY is set)` · `default (typesafe)` /
`default (openrouter)` · `/jev` line 1 `<provider> · <host> · <model> (pinned|alias) → resolved <served>[ · drift@step N →
<served>]` · line 2 suffix `(~ table-priced: $0.042/M input, output free)` / `(provider usage.cost)` · line 3 `intake: <n>
messages · p50 <ms> ms · $<usd> · last: <kind> <p>` · `/cost` `chat $<usd> for <n> messages (~$<each> each, p50 <ms> ms)`.

**Engine / CLI.** `[run] decider provider changed openrouter → typesafe (same weights: jev-1.13-20260917 ≡ jev-1.13.0)` ·
`--jev-model: "<id>" is not served by <host> (<hint>); TypeSafe accepts jev-1.13.0 or jev-latest` · `decider.model: "<id>"
(from <source>) is an OpenRouter id; the typesafe provider serves jev-1.13.0 (or pass --jev-provider openrouter)` ·
`--resume: run <id> used decider.provider openrouter with <model>; pass --jev-provider openrouter, or start a follow-up` ·
`mode: "<v>" (from <source>) is not one of jev-only|jev-on|jev-off` · `[config] decider: <provider> · <model> · key <ENV>
(<source>)` (the startup line after the shadowing lines, §1.4).

---

## 12. Risks, open questions, rejected alternatives

### 12.1 Risks (and the mitigation designed in)

1. **Intake misclassification toward `coding_task`** — the failure that started this round, inverted: a question read
   as work. Mitigation: the run floor (Jev's own `coding_task` ≥ 0.6 **and** paired Noul ≥ 0.5, else the ambiguity
   row), the escape option, `ambiguous` as an explicit option **and** the fallback, `conversation` in the state, the
   live confusion table (§9.3) recorded before merge. Residual: Jev is noisy ±0.02 in the 0.55–0.80 band
   (JEV-ONLY.md), so a message near 0.6 will sometimes ask when it could have run; asking costs one keystroke, a wrong
   run costs money — the asymmetry is intended.
2. **Misclassification toward chat** ("run the tests" read as a question). Mitigation: `run`, `fix`, `add` are in the
   `coding_task` examples; the `[n]`-path never needs a second request; the human sees the `[jevcode]` reply and
   rephrases (`/steer`-free). Residual: none dangerous — nothing runs.
3. **Latency perception.** 110–250 ms is not instant. Mitigation: the `[you]` bubble and `⠹ thinking` land on the
   Enter frame (≤ 16 ms), so the wait reads as the tool working, not hanging; the reply arrives in one hop. Under a
   Jev outage the retry row and `offline:` copy of §13.2 apply (the client's retry policy is unchanged), and Ctrl-C ×1
   stops the request.
4. **Token growth of the folded request.** ≈ 1,650 input tokens today; adding facts or replies grows it linearly.
   Mitigation: the `[measured]` token estimate in `intake.test.ts` (`JEV_TOKENS_PER_CHAR` × chars + overhead) fails
   above 3,000; catalogue and facts are data tables with caps (§3.4: 14 + 14). Splitting B/C into a second request
   remains a one-line change (`runIntake` already builds the groups separately) if the estimate ever binds.
5. **TypeSafe key format unknown.** No format pattern; the exact-secret layer and `SECRET_NAME_RE` cover it. Residual:
   a TypeSafe key typed into the composer of a *different* session where it is not configured is caught only if it
   matches an existing family — the same gap as any unknown-format secret (TUI-DESIGN §10.1 C44 staging).
6. **TypeSafe error shapes beyond the probe** (a 422 body, a 429 `Retry-After` form, a 5xx page). The client treats
   any non-200 as today (retryable set unchanged, bodies redacted and clipped, `detail.message` read when present); the
   live suite records what arrives. `x-typesafe-request-id` is logged redacted for support bundles.
7. **Auto-detection surprises.** A user with both `JEV_API_KEY` (OpenRouter) and `TYPESAFE_API_KEY` set gets OpenRouter
   (§2.3 rule 2 — today's behaviour preserved) and may expect TypeSafe. Mitigation: the `[config] decider: …` startup
   line names provider, model and key variable; `--jev-provider typesafe` or `JEV_PROVIDER=typesafe` overrides.
8. **`kind: 'task'` bypass.** A one-shot `jevcode run "hi"` runs a task named `hi`. Intended (scripts), documented in
   `--help` and `docs/TUI.md`.
9. **Chat spend before the first run** is indexed only once a session id exists (§3.9); a session that never runs
   loses a few hundredths of a cent from `sessions/index.jsonl` (the meter in memory is exact). Open question 3.
10. **Renderer dress vs identity.** D-D's bubble gutter must stay ≤ 2 cells and colour-only, or the identity test of
    §3.10 fails — the test is the guard; Designer A is asked to keep the rule.

### 12.2 Open questions (owner decisions; defaults chosen here)

1. Should `hello_first` carry the composer hint after the first run too? Default here: the text is fixed per key; `<dir>`
   is the hint (§3.4).
2. Should `/mode jev-on` **persist** by default rather than pend for the next run? Default: pend (today's `/mode`
   semantics, TUI-DESIGN §5.2) with the `persist:` hint in the item; `jevcode config set mode jev-on` persists.
3. Should chat lines before the first run be written under a synthetic session id so `sessions/index.jsonl` never loses
   spend? Default: deferred and dropped when no run happens (§3.9); the alternative changes `sessionId = first run id`
   (TUI-DESIGN §8.1) and is out of this round's scope.
4. `question_about_the_code` in jev-only: is the lookup enough, or should the reply also offer a **one-step
   investigation run** (`read` proposals) once the synthesizer can propose reads? Default: lookup only, honest text
   (§3.6.1); revisit when `src/synth` grows a read proposer.
5. Should the LLM chat turn see **all** files the last run touched (`RunRecord.changedFiles`) rather than only
   `@`-mentions? Default: mentions only (bounded, explicit, denylist-checked); the plan and window already summarise
   the run.
6. Should `jevcode run` (one-shot) on a TTY pass intake when the task reads like a greeting? Default: no (`kind:
   'task'`), scripts first.
7. `/why intake` reads memory (the last ≤ 3 intakes); should intake decisions be written to a per-session
   `chat.jsonl` for `jevcode why`? Default: no file; `/jev` line 3 and `--json` `chat` lines are the record.

### 12.3 Rejected alternatives (and why)

| Alternative | Why not |
| --- | --- |
| A regex/keyword classifier in front of the engine (`^(hi|hello)…$` → reply) | It is not how this harness decides anything; it fails on `hi, can you fix the test` and `thanks — now run the suite` (both in the false examples); the owner fixed D-C as a Jev decision. The regexes exist only in the **mock** decider (§5) so `--mock` sessions converse offline. |
| Two sequential requests (intake, then reply/facts) | Doubles the perceived latency of a greeting (220–500 ms) for a saving of ≈ 1,000 tokens (≈ $0.00004). Jev's latency is per request, not per question. |
| A read-only engine run for code questions in jev-only | The synthesizer never proposes `read` (`src/synth/search/index.ts:634`), always opens with the baseline test run (`:568`), and a step costs six Jev requests and a test run; the result would be a test run, not an answer. The lookup answers in one request and tells the truth about the mode. |
| An LLM call for greetings in jev+llm | A greeting needs no generator; the catalogue Choice is cheaper, faster and predictable; the LLM is reserved for code questions where it adds something Jev cannot. |
| `usage.cost` required for TypeSafe (fail closed as `budget:unpriced`) | The price is published and constant ($0.042/M input, output free) and the identity `cost = input × 4.2e-8` is exact on OpenRouter (`RESEARCH.md:288`); deriving it is the same arithmetic. `costBasis` records that it was derived. |
| One `JEV_API_KEY` for both providers with the provider inferred from the key | TypeSafe's key format is unknown; inferring a host from a secret's shape is fragile and would send a key to the wrong host on a miss (a 401 that leaks nothing, but a confusing one). The variable name carries the provider instead. |
| Making `mode` a persisted **file-only** preference (no env) | Scripts and CI set env; `JEVCODE_MODE` follows every other setting's chain (TUI-DESIGN §16). |
| Bubbles as one item with a multi-line `detail` | `detail` is TUI-only by contract (`plain.ts:95`); the plain twin would print the first line only and identity would break. One item per line keeps the three writers identical. |
| Auto-approving a `coding_task` above some very high probability without the review machinery | Unrelated to reviews (which are per action and unchanged), but stated for completeness: the run floor gates **starting** a run, never approving an action; F6's invariants are untouched. |

---

## Appendix A — slot map for this round (disjoint files; TUI-DESIGN §20 ownership rule)

| Slot | Files | Sections |
| --- | --- | --- |
| O1 contract + engine + Jev client | `src/core/types.ts`, `src/jev/{client,validate,types,mock}.ts`, `src/jev/providers.ts` (new), `src/loop/engine.ts` (`checkModelDrift`, `deciderModel.provider`), fakes | §2.2, §2.4, §2.5, §8 |
| O3 keys + layout + commands | `src/tui/layout.ts` (`intake` overlay), `src/tui/keys/*` (S5 row, S0 in-flight rule), `src/tui/commands/{registry,dispatch}.ts` (`/mode` no-arg, `/llm`), `scripts/gen-docs.mjs` output | §1.3, §3.8, §4.3 |
| O5 status | `src/tui/status/lines.ts` (`modeBadge`, `thinking`) | §7.1 |
| O6 config | `src/config/{defaults,types,resolve,validate}.ts` (`mode`, `decider.provider`, auto rule, provider defaults), `src/cli/config-table.ts` | §1.2, §2.3, §2.5, §2.6 |
| O7 onboarding + login | `src/tui/onboarding/{reducer,lines,Wizard}.tsx`, `src/cli/login.ts`, `src/config/credentials.ts` (`jevProvider`) | §6, §2.7 |
| O9 Ink App | `src/tui/App.tsx` (`SubmitOutcome`, `thinking`, `restoreDraft`, `live`), `src/tui/useEngine.tsx`, `src/tui/Overlay.tsx` (intake row), `src/tui/composer/Composer.tsx` (placeholders), `src/tui/Transcript.tsx` (bubble dress with Designer A) | §3.8, §3.10, §4.4, §7.2, §7.3 |
| O10 CLI + plain + pty + docs | `src/cli/{session,main,args,json-stream,tui-prompter}.ts`, `src/tui/{plain,plain-composer}.ts`, `src/session/index.ts` (`chat` line), `src/tui/composer/history.ts` (`chat`), `test/pty/**`, `src/perf/intake-latency.ts`, `docs/{TUI,COMMANDS,KEYS,STATUS}.md`, `README.md` | §1, §3.9, §4, §9.2, §9.4 |
| **O11 chat (new)** | `src/chat/{intake,replies,facts,lookup,llm-turn,lines,bubbles,ledger}.ts`, `test/unit/chat/**`, `test/live/intake.live.test.ts`, `test/live/jev.live.test.ts` (with O1) | §3, §5, §9.1, §9.3 |

Waves: W0 O1 (contract + fakes, `tsc --strict` green) → W1 O3, O5, O6, O7, O11 (pure, offline) in parallel → W2 O1
client/engine, O10 `session.ts` + `plain` → W3 O9 → W4 pty, perf, live tables, docs. No paid call is made by any unit
or pty test; the two live suites run once on both providers before merge and their tables go into `docs/STATUS.md`.
