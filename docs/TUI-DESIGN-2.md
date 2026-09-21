# JevCode TUI round 2 — implementation design (defaults, providers, conversation, visual redesign, splash)

Written 2026-09-21 against HEAD `080331a` (`src/core/types.ts` 1,540 lines, `src/cli/session.ts` 2,878, `src/tui/App.tsx`
2,033, `src/tui/useEngine.tsx` 860, `src/tui/layout.ts` 151, `src/tui/status/lines.ts` 538, `src/jev/client.ts` 447; Ink
7.1.1, React 19, Node 22, runtime deps `ink` + `react` only). It is the single implementation input for the six slots of
§7 and supersedes, where they overlap, the two round-2 designs it synthesises: `docs/research/tui/round-2/design-visual.md`
(`A §n`, frames `G-*`) and `docs/research/tui/round-2/design-conversation.md` (`B §n`, frames `F-B*`). `docs/TUI-DESIGN.md`
is `TD §n`, `docs/research/tui/01-opencode.md` is `OC §n`, the TypeSafe probe `docs/research/tui/round-2/typesafe-native-probe.md`
is `PROBE`. Line anchors are `file:line` at HEAD. Where A and B disagreed, §10.2 records which won and why; implementers
read this document and open A or B only for rationale. Frames are captioned `**H-X. … W×H (D dynamic rows; S scrollback
rows above)**` in the `readFrames` grammar of §8.1 S4 (the `H-` extension of `test/unit/tui/layout/layout.test.ts:353–379`);
every status row below is `statusLineText(state, W)` output, every rule row `ruleRow`/`panelStrip`/`paneRuleRow` output,
every card and console row exactly W cells (re-derived in the review of §13, findings 2, 3, 5, 8). `›` is the composer prompt, `╭ ╮ ╰ ╯ │ ─ ├ ┤` the cli-boxes
`round` set (`+ - |` under `--ascii`), `⠹` the spinner, `–` the `step 0/–` sentinel. Read §6 → §7 (your slot) → the
sections your slot's row names.

---

## 0. Thesis, and how D-A … D-E are honoured

**Thesis.** Three faults, one rule. (1) `jevcode` alone opened a two-key wizard because the default mode was
`jev-on` (`src/config/resolve.ts:312–315`, `src/cli/main.tsx:38–41`): the default becomes `jev-only`, one key suffices,
Jev + LLM is one `/mode jev-on` away. (2) Every Enter was `startRun()` (`src/cli/session.ts:2568–2573`), so `hi` bought
a run: every non-command submission now passes **one Jev request** (the intake, §3) and only `coding_task` at Jev's own
p ≥ 0.6 starts a run. (3) The screen was crowded — seven `<Static>` rows per step (`src/tui/plain.ts:276–345`), a
12-row pane pinned open (`App.tsx:1723`), a bare `> ` over a packed status row (`Composer.tsx:35`, `App.tsx:1841`):
the transcript becomes `[you]` / `[jevcode]` bubbles and one `[step N]` line per step; everything interactive lives in
one rounded console (badge, composer, divider, three-zone status), everything modal in a rounded card; the Jev panel
collapses to a one-row strip; a ≤ 700 ms wordmark settles into a brand rule row. Nothing reopens TD's fifteen
decisions: one modal slot, one `computeLayout`, `<Static>` the only scrollback writer, zero clears, `lines()` twins, no
new dependency, Jev decides.

| Decision | Honoured in | How |
| --- | --- | --- |
| **D-A** default mode jev-only; one key; `/mode jev-on` (alias `/llm on`) switches the next run and opens the wizard's generator step in place when no generator key exists; the badge always shows the mode | §1, §4.4, §4.10 | `mode` setting row (flag > `JEVCODE_MODE` > dotenv > file > default `jev-only`); `modeFromParsedFlags`/`modeFromFlags` fall back to `jev-only`; `/mode` no-arg shows, with an argument pends; `runLogin('mode', m)` opens the wizard with `reason: 'mode'`; badge `jev-only` · `jev+llm` · `llm-only` (+ ` · next run`) in the console's top edge (boxed) or leading the status left zone (flat), from the first frame via `launch.modeHint` |
| **D-B** Jev via TypeSafe native and OpenRouter; `--jev-provider`/`JEV_PROVIDER`; auto = typesafe when `TYPESAFE_API_KEY`; per-provider ids, URLs, cost derivation; both in `test:live`; `jevcode config` and `/jev` show the provider | §2 | `JevProvider`, `JEV_PROVIDERS` table, `DeciderConfig.provider/pricing/providerSource`, `jevModelMatches`, cost = `input × 4.2e-8` with `costBasis: 'table'` when `usage.cost` is absent, `x-typesafe-request-id`, 400/422 `Unknown model` → `ConfigError` exit 2 |
| **D-C** intake Choice over five readings with the REPORT question rules, ≪ 1 s, charged to the session meter; greeting → catalogue reply; tool question → facts; code question → lookup (jev-only) or one LLM turn (jev+llm); task → run; ambiguous → one-row confirmation; bubbles as transcript items with line identity | §3, §4.7 | `src/chat/**`: one `decider.ask` with groups A (intake + paired Nouls), B (reply Choice), C (fact Nouls); `resolveIntake` with the run floor; `REPLIES` (14) and `harnessFacts` (14) as data; `lookupCode`; `llmChatTurn`; `intake` overlay; `[you]`/`[jevcode]` in `UiLabel`, one item per line, renderer-local while idle, `annotate()` while live |
| **D-D** rounded boxes for composer, review card, dialogs; chat bubbles with dim labels; one line per step by default; Jev panel collapsed, ≤ 6 rows unless expanded, `/decisions`; boxed three-zone status bar with the badge; truecolor/256 with the ANSI-16 twin; rows − 2, zero clears; splash ≤ 700 ms, ≤ 30 fps, first frame < 300 ms, reduced motion static, typing aborts | §4, §5 | chrome tiers (boxed ≥ 16 rows, flat below), `CAP.chrome = 3`, `computeLayout` 1.1 with `chrome`, the console, `card.ts`, `panelStrip`/`panelLines`, compact transcript filter, `stepSummaryText`, `ColorTriple` + `colorDepth`, `splash.ts` + `motion.ts` over Ink's `useAnimation` |
| **D-E** every existing gate | §9 | first frame is splash frame 0 with the `step 0/–` sentinel; the console adds 4 fixed rows; the splash ticks through Ink's throttle; the TUI's rows satisfy the identity predicate of §9 (`full`: `formatTranscriptItem(item)` per item, wrapped, the fence rule excepted; `compact`: a declared subsequence); no new dependency (cli-boxes glyphs copied as literals); wizard rows stay `maskedFieldRow(length)`; the review card changes drawing only |

**Kept from TD, untouched:** `itemsFromEvent`/`formatTranscriptItem` as the one item source, the `NullProvider` path
(`session.ts:457–460`), `alwaysDecline`, `createTuiConfirmer`, `LIVE_FLUSH_MS = 50`, `DECISIONS_KEPT = 12`, the review
invariants (`app.test.tsx:342–461`), S0–S7 plus §3.1's rows, `src/synth/**` read-only, `src/bench/**` unchanged.

---

## 1. Defaults and mode switching (D-A)

### 1.1 What zero arguments resolves to

| Invocation | Today | After |
| --- | --- | --- |
| `jevcode`, `jevcode chat`, `jevcode run` (no task, TTY) | `{ command: 'chat' }`, `baseMode = 'jev-on'` (`session.ts:811`), wizard asks provider + generator key + Jev key | the same session in **jev-only**; wizard asks the **Jev key only** (and the Jev provider only when no rule of §2.3 infers it); with the user's `.env` (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, no `JEV_API_KEY`) no wizard appears: provider `typesafe`, model `jev-1.13.0` |
| `jevcode run "<task>"`, `--task-file`, stdin | jev-on one-shot | jev-only one-shot; `--mode jev-on` restores today; the task never passes intake (§3.8 `kind: 'task'`) |
| `jevcode --mode jev-on` / `JEVCODE_MODE=jev-on` / file `mode` | flag only | the full chain (§1.2) |
| `jevcode bench` | own default | unchanged |

The first frame stays argv-only (TD §1): the badge word comes from `launch.modeHint` (`--mode` > `JEVCODE_MODE` >
`'jev-only'`, `resolveLaunchSettings`, no file); a file or dotenv that sets another mode updates the badge at `setUi`.

### 1.2 `mode` becomes a setting

```ts
// src/config/defaults.ts — new SETTINGS row, directly after `decider.model` (defaults.ts:79); S1 lands it (§7.2)
{ name: 'mode', flag: 'mode', env: ['JEVCODE_MODE'], fileKey: 'mode', defaultValue: 'jev-only', secret: false,
  description: 'engine mode (jev-only | jev-on | jev-off); jev-only needs no generator key' },
// src/config/types.ts:6 — SettingName gains 'mode' | 'decider.provider'
// src/config/resolve.ts:351 — `const mode = opts.mode ?? modeFromParsedFlags(flags)` stays as an argv-only hint (`layers.dotenvs` is empty and
// `layers.file` null on that line; steps 1–3 fill them). The setting is resolved AFTER step 3 (config file loaded) and BEFORE the
// `limits.spendCapUsd` default at resolve.ts:452, which reads it:
const mode = opts.mode ?? resolveMode(layers);   // lookup(layers, settingSpec('mode')) → validated → entries.set('mode', …); `defaultRunSpendCapUsd(mode)` (:452) uses this value
export function resolveMode(layers: Layers): EngineMode;   // ConfigError `mode: "<v>" (from <source>) is not one of jev-only|jev-on|jev-off`
// resolve.test.ts row (S1): file `mode: jev-on`, no flag, no env → `mode` source `file:<path>`, `limits.spendCapUsd` default $2.00, `jevcode config` prints `mode  jev-on  file:<path>`
// src/config/resolve.ts:312 and src/cli/main.tsx:38 — both fallbacks become 'jev-only'
export function modeFromParsedFlags(flags: ParsedFlags): EngineMode { const m = flags.mode ?? flags.condition; return m === 'jev-on' || m === 'jev-off' ? m : 'jev-only'; }
```

`ResolvedConfig.mode` (§6 item 9); `jevcode config` prints `mode  jev-only  default`; `run.json.config` records the
row; `jevcode config set mode jev-on` persists it (`writeConfigValue`). `baseMode` (`session.ts:811`) starts as
`modeFromParsedFlags(flags)` and is re-read from `config.mode` in `applyConfig()` (`:1250`, so every `reresolve()` follows the
file); `pendingFlagOverrides()` still wins as the flag layer. Mode-keyed spend caps are
unchanged: **$0.25 run / $1.25 session under jev-only**, $2.00 / $10.00 under jev-on. `--mode` help (`args.ts:238`) becomes `engine mode: jev-only (default; no generating LLM), jev-on (Jev +
LLM), jev-off (generator only)`; the usage lines `args.ts:676,680` reorder the enum to `jev-only|jev-on|jev-off`.

### 1.3 `/mode` and `/llm`

```ts
// src/tui/commands/registry.ts:316–325 — the `mode` row changes; `llm` is new (S2)
{ name: 'mode', aliases: [], args: [{ name: 'm', kind: 'enum', values: ['jev-only', 'jev-on', 'jev-off'], optional: true, hint: '[jev-only|jev-on|jev-off]' }],
  availableDuringTask: 'any', plain: 'yes', title: 'engine mode: show, or set for the next run', usage: '[jev-only|jev-on|jev-off]',
  semantics: 'no argument: current and next mode; with one: pending for the **next** run (memory); `jev-on` with no generator key opens the wizard\'s generator step in place; persist with `jevcode config set mode <m>`', category: 'config' },
{ name: 'llm', aliases: [], args: [{ name: 'state', kind: 'enum', values: ['on', 'off'], hint: '<on|off>' }],
  availableDuringTask: 'any', plain: 'yes', title: 'Jev + LLM on (= /mode jev-on) or off (= /mode jev-only)', usage: '<on|off>',
  semantics: '`/llm on` = `/mode jev-on`, `/llm off` = `/mode jev-only`', category: 'config' },
// src/tui/commands/dispatch.ts:57 — CommandAction widens
| { kind: 'mode'; mode: EngineMode | null }      // /llm on → { kind: 'mode', mode: 'jev-on' }; /llm off → { kind: 'mode', mode: 'jev-only' }
```

```ts
// src/cli/session.ts:2464–2467 — execute(), case 'mode' (S3 owns the file; this block is S2's request, §7.3)
case 'mode': {
  const next = pending.mode ?? baseMode;
  const cur = live() ? currentRunMode : next;
  if (a.mode === null) { note(`mode ${modeBadgeWord(cur)} (next run: ${modeBadgeWord(next)})`); return; }
  if (a.mode === next) { note(`mode ${modeBadgeWord(a.mode)} already`); return; }
  if (config && config.missingSecrets(a.mode).length > 0) {
    const saved = await runLogin('mode', a.mode);                       // the wizard's generator step, in place (§1.4)
    if (!saved) { note(`mode stays ${modeBadgeWord(next)} — no generator key was saved`, { level: 'warn' }); return; }
  }
  pending.mode = a.mode;
  extras.dispatch?.({ type: 'mode', mode: live() ? currentRunMode : baseMode, pending: a.mode });   // §6 item 15: the badge reads `<next> · next run` until run:start promotes it (§1.5)
  note(a.mode === 'jev-only' ? MODE_JEV_ONLY_SET : a.mode === 'jev-on' ? MODE_JEV_ON_SET : MODE_JEV_OFF_SET);
  return;
}
```

Strings: §12 "Mode items". `runLogin(reason, mode)` (`session.ts:1261`) gains the reason `'mode'` and an explicit target
mode (`missing = config.missingSecrets(mode)` for **that** mode; the wizard gets `reason: 'mode'`). `/mode` while live is
allowed (`any`): it applies to the next run; idle or live, the badge reads `<next> · next run` from the command until
`run:start` promotes the pending mode (H-G1; `mode-switch.steps` expects `jev\+llm · next run` in the idle case).
`PendingSettings.mode`, `reresolve()` and `startRun`'s re-resolution (`session.ts:1438–1440`) are unchanged.

### 1.4 The wizard for a jev-only first run, and the generator step on demand

`WizardStep` (`src/tui/onboarding/reducer.ts:19`) gains `'jevProvider'`; flows:

```
detect → [jevProvider] → jevKey → save → verify? → trust → sandbox → done          jev-only first run (default)
detect → provider → generatorKey → [jevProvider] → jevKey → save → …                 jev-on first run (today + the Jev provider when needed)
reopen(reason 'mode') → provider → generatorKey → save → verify? → done              /mode jev-on with no generator key
```

```ts
// reducer.ts:191 startFromDetect
function startFromDetect(s: OnboardingState): OnboardingState {
  if (s.missing.length === 0) return afterKeys(s);
  if (needsGenerator(s)) return { ...s, step: 'provider', providerShown: true };
  if (needsJev(s)) return s.jevProvider === null ? { ...s, step: 'jevProvider', jevProviderShown: true } : field(s, 'decider.apiKey');
  return afterKeys(s);
}
// OnboardingAction.detect gains `jevProvider: JevProvider | null` and `reason: 'missing' | 'login' | 'rejected' | 'mode'`
// OnboardingAction.reopen widens (reducer.ts:99): { type: 'reopen'; at: 'provider' | WizardField; runLive: boolean; reason?: 'login' | 'rejected' | 'mode'; mode?: EngineMode }
//   `case 'reopen'` (reducer.ts:224–228) sets `reason` (default 'login') and `mode` (default state.mode); reason 'mode' forces `at: 'provider'`, `providerShown: true`
//   and the title WIZARD_PROVIDER_TITLE_MODE — never the stale provider/mode of the startup detect
//   `case 'cancel'` (reducer.ts:283–287): `state.runLive || state.reason === 'mode' || state.reason === 'login'` → `{ step: 'done' }`; else `{ step: 'exit', exitCode: WIZARD_EXIT_CODE }`
//   `save-failed` (reducer.ts:304–306): `needsGenerator(state)` reads the target `state.mode`, so a failed save returns to generator.apiKey under reason 'mode'
// src/cli/tui-prompter.ts:166–168 `wizard()` (S3, request from S2): `if (o.reason === 'mode') r.reopenWizard('provider', runLive, { reason: 'mode', mode: o.mode })`, else today's
//   two branches; `openWizard({ …, mode: controls?.mode() ?? 'jev-only', jevProvider })` (was 'jev-on'); `Renderer.reopenWizard` gains the optional third argument
// OnboardingState gains `jevProvider`, `jevProviderShown`, `reason`; SaveRequest gains `jevProvider: JevProvider | null` (file key `jevProvider`, written only when the step was shown)
// `choose` on jevProvider: 1 → typesafe, 2 → openrouter, Enter → preselection; then field(s, 'decider.apiKey'); wizardRows gives jevProvider 3 rows
```

`jevProvider` is shown only when `providerSource === 'default'` and no Jev key resolves (skipped when the generator
provider is `openrouter`). Ctrl-C in a `reason: 'mode'` wizard **never exits**: `cancel` → `done` and the session
continues (a wizard opened by a command closes; one opened by a missing key at startup exits 2). Strings (§12
"Wizard"): `WIZARD_JEV_PROVIDER_TITLE`, `WIZARD_JEV_PROVIDER_OPTIONS` (+ narrow), `jevKeyTitle(provider, counter)`,
`WIZARD_PROVIDER_TITLE_MODE`, `WIZARD_PROVIDER_HINT_MODE`; `fixBlockLines(mode)` leads with the two Jev variables and
adds the Anthropic line only when the mode needs a generator. Boxed tier: the wizard renders inside the console (A §3.5)
under the title `setup · <step>` (`jev provider` · `provider` · `generator key` · `jev key` · `verify` · `trust`), masked
row `› •••••`, status word `setup` (frame H-H2; `setup · provider` precedes it when no provider resolves). `jevcode
login` gains `--jev-provider typesafe|openrouter` and skips the generator prompt in jev-only unless `--provider` is given.
`commandLogin` (`login.ts:289`) records the provider with the key: with `--jev-key-stdin` and no `--jev-provider` it infers
the provider by §2.3 rules 2a–2d; when nothing infers it, a TTY asks `Where do you reach Jev?  1 typesafe  2 openrouter`
and a pipe exits 2 with `jevcode login: pass --jev-provider typesafe|openrouter with --jev-key-stdin`; whenever the
provider is known, `jevProvider` is written alongside `jevApiKey` (`CredentialsPatch.jevProvider?: JevProvider`,
`credentials.ts:232–235`), so a TypeSafe key saved on a machine without `TYPESAFE_API_KEY` exported never resolves to
openrouter (rule 2e) and is never sent to openrouter.ai. The printed fix block reads `printenv TYPESAFE_API_KEY | jevcode
login --jev-provider typesafe --jev-key-stdin` (§12 "Wizard"; `login.test.ts` S2).

### 1.5 The badge

```ts
// src/tui/status/lines.ts (S4)
export type ModeBadge = 'jev-only' | 'jev+llm' | 'llm-only';
export function modeBadgeWord(mode: EngineMode): ModeBadge;                       // jev-only → 'jev-only'; jev-on → 'jev+llm'; jev-off → 'llm-only'
export function modeBadge(mode: EngineMode, pending: EngineMode | null): string;   // `jev-only`; `jev+llm · next run` while pending differs
```

`UiState.modeBadge: { mode; pending }` starts as `{ mode: launch.modeHint ?? 'jev-only', pending: null }`, follows
`UiAction { type: 'mode' }` (after `resolveConfig` and on every `/mode`) and `run:start.mode` (`resetForRun`,
`useEngine.tsx:449`: `mode ← e.mode`, `pending ← null` — the run promotes the pending mode; nothing happens at `run:end`).
`modeBadge` prints the pending word: `jev+llm · next run` while `pending !== null && pending !== mode`, else the word of `mode`. Boxed → the console's top edge (role `badge`); flat → `${badge} · ${leftWord}` leading the status left
zone, dropped before `help` when short. The word is its own marker.

---

## 2. Jev providers (D-B)

### 2.1 The two endpoints as measured (PROBE; `docs/RESEARCH.md:258–288`)

| | OpenRouter decisions router (today) | TypeSafe native |
| --- | --- | --- |
| URL | `POST https://openrouter.ai/api/alpha/decisions` (`src/jev/types.ts:12`) | `POST https://api.typesafe.ai/v1/systemone` |
| Auth | `Authorization: Bearer <key>` + `HTTP-Referer` + `X-Title` (`client.ts:296–300`) | `Authorization: Bearer <TYPESAFE_API_KEY>`; no referer/title |
| Body | `{ model, state, questions }` | identical |
| Model ids | `typesafe/jev-1.13-20260917` (pinned default), `typesafe/jev-1.13`, `jev-1.13` | `jev-1.13.0` (pinned; also what `jev-latest` serves); **400** for `jev-1.13`, `typesafe/jev-1.13`, `jev-1.13-20260917` |
| Response | `{ model, answers, usage: { input_tokens, output_tokens, cost }, id: 'gen-dec-…', provider }`; headers `x-generation-id` | `{ model: 'jev-1.13.0', answers, usage: { input_tokens, output_tokens } }` — **no `cost`**, no `id`; header `x-typesafe-request-id` on every response |
| Errors | 400 `{ error: { message, code } }` | 400 `{ detail: { error_type: 'api_usage_error', message: 'Unknown model: …' } }`; 422 on malformed bodies; 401 bad key |
| Price | `usage.cost = input_tokens × 4.2e-8` exactly | none on the wire; $0.042 per million input tokens, output free |
| Latency · limits | ≈ 237 ms p50 (30-task run) | 109–112 ms per request; 1,200 requests/min |

### 2.2 Types and the provider table

```ts
// src/jev/providers.ts — NEW, pure (S1)
export type JevProvider = 'typesafe' | 'openrouter';
export interface JevProviderSpec {
  readonly name: JevProvider; readonly baseUrl: string; readonly defaultModel: string;
  readonly keyEnv: string;                                       // prepended to the key lookup when the provider is explicit or typesafe-inferred (§2.3 step 3)
  readonly headers: (apiKey: string, referer: string) => Record<string, string>;
  readonly requestIdHeaders: readonly string[];
  readonly isPinned: (normalisedId: string) => boolean;
  readonly aliases: readonly string[];
  readonly pricing: { inputUsdPerToken: number; outputUsdPerToken: number };
  readonly displayHost: string;
  readonly accepts: string;                                      // the `TypeSafe accepts …` / `OpenRouter accepts …` hint
}
export const JEV_PROVIDERS: Readonly<Record<JevProvider, JevProviderSpec>> = {
  openrouter: { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', defaultModel: 'typesafe/jev-1.13-20260917', keyEnv: 'OPENROUTER_API_KEY', displayHost: 'openrouter.ai',
    headers: (k, referer) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'HTTP-Referer': referer, 'X-Title': APP_TITLE }), requestIdHeaders: ['request-id', 'x-request-id', 'x-generation-id'],
    isPinned: (id) => /-\d{8}$/.test(id), aliases: ['jev-1.13', 'jev-latest'], pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 }, accepts: 'OpenRouter accepts typesafe/jev-1.13-20260917 or typesafe/jev-1.13' },
  typesafe: { name: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1/systemone', defaultModel: 'jev-1.13.0', keyEnv: 'TYPESAFE_API_KEY', displayHost: 'api.typesafe.ai',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }), requestIdHeaders: ['x-typesafe-request-id', 'request-id', 'x-request-id'],
    isPinned: (id) => /^jev-\d+\.\d+\.\d+$/.test(id), aliases: ['jev-latest'] /* `jev-1.13` is 400 on TypeSafe (§2.1, PROBE) and is rejected offline (§2.5) */, pricing: { inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 }, accepts: 'TypeSafe accepts jev-1.13.0 or jev-latest' },
};
/** the same weights under two naming schemes (PROBE + REPORT §1); used by --resume reconciliation only */
export const EQUIVALENT_IDS: ReadonlyArray<readonly [openrouter: string, typesafe: string]> = [['jev-1.13-20260917', 'jev-1.13.0']];
export function providerForHost(baseUrl: string): JevProvider | null;   // 'api.typesafe.ai' → typesafe · 'openrouter.ai' → openrouter · else null
export function isPinnedJevModel(id: string, provider: JevProvider): boolean;
export function jevModelMatches(configured: string, served: string, provider: JevProvider): boolean;   // §2.5
```

`src/jev/types.ts` keeps the OpenRouter `DEFAULT_JEV_MODEL` / `DEFAULT_JEV_BASE_URL` (every import compiles) and gains
`DEFAULT_TYPESAFE_MODEL = 'jev-1.13.0'`, `DEFAULT_TYPESAFE_BASE_URL`; `JEV_INPUT_USD_PER_TOKEN` stays `4.2e-8`.
`DeciderConfig` (§6 item 4) gains `provider`, provider-aware `pinned`, `pricing`, `providerSource`.

### 2.3 Configuration: `--jev-provider`, `JEV_PROVIDER`, auto-detection, precedence

```ts
// src/config/defaults.ts — new row before `decider.baseUrl` (defaults.ts:77); `decider.apiKey` keeps env ['JEV_API_KEY', 'OPENROUTER_API_KEY'] (defaults.ts:78); TYPESAFE_API_KEY arrives through `extraEnv` (step 3)
{ name: 'decider.provider', flag: 'jevProvider', env: ['JEV_PROVIDER'], fileKey: 'jevProvider', defaultValue: 'auto', secret: false,
  description: 'Jev provider (auto | typesafe | openrouter); auto = typesafe when TYPESAFE_API_KEY is set, else openrouter' },
// src/cli/args.ts:23 STRING_FLAGS gains 'jevProvider'; FLAG_SPECS gains
{ key: 'jevProvider', name: 'jev-provider', type: 'string', commands: COMMON, arg: 'auto|typesafe|openrouter', help: 'Jev provider (default auto: typesafe when TYPESAFE_API_KEY is set, else openrouter)' },
```

Resolution inside `resolveConfig` (the `generator.provider` block at `resolve.ts:416–421` is the model):

| Step | Rule | `providerSource` |
| --- | --- | --- |
| 1 | `decider.provider` through `lookup`: flag > `JEV_PROVIDER` > `./.env` > `<OPEN_ASSIST_PATH>/.env` > file `jevProvider` > default `auto`; any other value → `ConfigError` (exit 2) naming the source | `flag` · `env` · `dotenv:<path>` · `file:<path>` |
| 2a | `auto` + a configured `decider.baseUrl` (any layer but default) whose host `providerForHost` recognises | `auto:base-url` |
| 2b | `auto` + `JEV_API_KEY` set (env or dotenv) → `openrouter` — today's users configured it for OpenRouter and are not redirected to a host their key does not belong to | `auto:openrouter-key` |
| 2c | `auto` + `TYPESAFE_API_KEY` set (env or dotenv) → `typesafe` | `auto:typesafe-key` |
| 2d | `auto` + `OPENROUTER_API_KEY` set → `openrouter` | `auto:openrouter-key` |
| 2e | nothing → `openrouter`; the wizard asks (§1.4); nothing is sent | `default` |
| 3 | **Key order, by provider source.** `envNames()` *prepends* `Layers.extraEnv` (`resolve.ts:219–222`, "extra env names checked first"), and the design uses exactly that: when the provider came from `flag` · `env` · `dotenv:` · `file:` · `auto:base-url` · `auto:typesafe-key`, `layers.extraEnv['decider.apiKey'] = [JEV_PROVIDERS[p].keyEnv]` so the provider's variable is consulted **first**, then the row's own `JEV_API_KEY`, `OPENROUTER_API_KEY`; when it came from `auto:openrouter-key` (`JEV_API_KEY` or `OPENROUTER_API_KEY` set, rules 2b/2d) **no** `extraEnv` is added and today's order `['JEV_API_KEY', 'OPENROUTER_API_KEY']` applies unchanged — no existing user's paying key changes. Consulted-list strings: typesafe `--jev-api-key (flag), TYPESAFE_API_KEY / JEV_API_KEY / OPENROUTER_API_KEY (env), … (dotenv:…), jevApiKey (file:…)`; openrouter `--jev-api-key (flag), JEV_API_KEY / OPENROUTER_API_KEY (env), …`. Under `typesafe` a key that resolved from `OPENROUTER_API_KEY` is refused offline: `ConfigError decider.apiKey: resolved from OPENROUTER_API_KEY but decider.provider is typesafe (from <source>); set TYPESAFE_API_KEY or pass --jev-provider openrouter`. resolve.test.ts rows: `--jev-provider typesafe` + `JEV_API_KEY` + `TYPESAFE_API_KEY` → `TYPESAFE_API_KEY`; `JEV_API_KEY` + `OPENROUTER_API_KEY` (auto) → `JEV_API_KEY` (as today) | — |
| 4 | `decider.baseUrl` / `decider.model` default to the provider's values when unset (`entries.set(name, { value, source: 'default' })`); a configured model is validated per provider (§2.5). A configured base URL whose `providerForHost` is non-null and **differs** from the resolved provider fails offline in `validateDecider`: `ConfigError decider.baseUrl: "<url>" (from <source>) is <host-provider>'s endpoint but decider.provider is <provider> (from <source>); pass --jev-provider <host-provider> or drop --jev-base-url` — TypeSafe headers and `jev-1.13.0` never reach openrouter.ai | — |

With the user's `.env` (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`; no `JEV_API_KEY`): **typesafe**
(`auto:typesafe-key`), key `TYPESAFE_API_KEY` (`dotenv:<cwd>/.env`), model `jev-1.13.0`; `--jev-provider openrouter` flips to OpenRouter.

**Redaction.** Today's `SecretSet` holds resolved secret settings plus secret-looking dotenv/config-file variables and
sweeps **no** process-environment variable (`resolve.ts:475–481`), so a `TYPESAFE_API_KEY` exported in the shell while the
session runs `--jev-provider openrouter` (or an `OPENROUTER_API_KEY` under typesafe) would never be redacted. The set
therefore gains every non-empty value of `KNOWN_KEY_ENV = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY',
'ANTHROPIC_API_KEY']` present in `env`, regardless of the selected provider (known key names, ≥ `MIN_SECRET_LENGTH`),
in addition to the resolved `decider.apiKey` and the dotenv/file variables matching `SECRET_NAME_RE`. No format pattern is
added (the TypeSafe key's shape is unknown); `looksLikeKey` (`reducer.ts:121`) returns `true` for `typesafe`.
resolve.test.ts row: `TYPESAFE_API_KEY` in `env` + `--jev-provider openrouter` → `config.redact()` masks it.

### 2.4 Client changes (`src/jev/client.ts`, S1)

| Where | Change |
| --- | --- |
| `client.ts:295–300` headers | `spec.headers(cfg.apiKey, deps.referer ?? DEFAULT_REFERER)` |
| `client.ts:137–139` `requestIdOf` | takes `spec.requestIdHeaders`; the typesafe id is redacted and clipped to `REQUEST_ID_MAX_CHARS`, rides `JevHttpError.requestId` → `last: … · request-id <id>` |
| `client.ts:176` `errorHint` | reads `error.message`, then `detail.message`, then a string `detail`, then the body; ≤ 200 chars, redacted first |
| `attempt()` after `httpError(...)` | status **400 or 422** whose hint matches `/unknown model/i` (TypeSafe) or `/is not a valid model\|no endpoints found/i` (OpenRouter) → `new ConfigError(\`--jev-model: "${cfg.model}" is not served by ${new URL(cfg.baseUrl).host} (${hint}); ${spec.accepts}\`, { setting: 'decider.model' })` — the host actually used, not `spec.displayHost` (a mismatched URL is already refused offline, §2.3 row 4); exit 2, never retried, never billed (a 400 carries no `usage`) |
| `src/jev/validate.ts:134` `validateUsage` | `cost` optional (`JevUsage.cost?: number`, §6 item 5); a present non-finite or negative cost still fails transient |
| `client.ts:410–425` `ask()` result | `const provided = response.usage.cost; const table = in × cfg.pricing.inputUsdPerToken + out × cfg.pricing.outputUsdPerToken; costUsd = typeof provided === 'number' ? (Number.isFinite(provided) ? provided : NaN) : table;` `costBasis: typeof provided === 'number' ? 'provider' : 'table'`; `id: response.id ?? h.generationId ?? requestId ?? null` |
| `Decider` | gains `readonly provider: JevProvider` (§6 item 7) |
| 422 / 401 / 429 | unchanged: 422 non-retryable (`isRetryableStatus`), 401/403 → key-rejected pane, 429 → `Retry-After` |

`costBlock` (`src/tui/budget/lines.ts:322`) prints `jev table $0.042/M input, output free (typesafe)` when every Jev
request of the run had `costBasis === 'table'`, else `jev provider usage.cost`; the item form is `jev $0.003 (~
table-priced)`.

### 2.5 Model ids, pinning, drift

```ts
// src/jev/providers.ts (S1); called by checkServedModel (client.ts:44), EngineImpl.checkModelDrift (engine.ts:1656–1693), validateDecider (config/validate.ts:182)
export function isPinnedJevModel(id: string, provider: JevProvider): boolean { return JEV_PROVIDERS[provider].isPinned(normaliseModelId(id)); }
export function jevModelMatches(configured: string, served: string, provider: JevProvider): boolean {
  const c = normaliseModelId(configured), s = normaliseModelId(served);
  if (isPinnedJevModel(configured, provider)) return c === s;
  if (c === 'jev-latest') return s.startsWith('jev-');
  return s === c || s.startsWith(`${c}-`);                              // jev-1.13 → jev-1.13-20260917 (openrouter only); no `.` branch: TypeSafe serves no unpatched alias (400 `Unknown model: jev-1.13`, PROBE)
}
```

`validateDecider` accepts `^[a-z0-9][a-z0-9._/-]*$` and rejects offline a model of the other provider (`typesafe/…`,
`-YYYYMMDD` **or an unpatched `jev-\d+\.\d+$`** under `typesafe`; `jev-\d+\.\d+\.\d+` under `openrouter`): `decider.model: "<id>" (from <source>) is an
OpenRouter id; the typesafe provider serves jev-1.13.0 (or pass --jev-provider openrouter)`. Drift semantics are
unchanged (alias warning `engine.ts:1667`, `drift` pane `[p] pin --jev-model jev-1.13.0 for the next run`, later
`jevModelDrift`); **`jev-1.13.0` is the pinned resolution on TypeSafe**; `RunResult.resolvedJevModel` is verbatim.
`EngineOptions.deciderModel` gains `provider` (§6 item 8). `--resume` (`reconcileResumeConfig`): `run.json.config` gains
the `decider.provider` row; a cross-provider resume is allowed when `EQUIVALENT_IDS` maps the run's resolved model (item
`[run] decider provider changed openrouter → typesafe (same weights: jev-1.13-20260917 ≡ jev-1.13.0)`), else
`ConfigError` `--resume: run <id> used decider.provider openrouter with <model>; pass --jev-provider openrouter, or start
a follow-up`; a run without the row reads as `openrouter`.

### 2.6 `jevcode config` rows and `/jev`

```
decider.provider  typesafe                               derived (auto: TYPESAFE_API_KEY is set)
decider.baseUrl   https://api.typesafe.ai/v1/systemone   default (typesafe)
decider.apiKey    <dotenv:/Users/me/proj/.env> (sha256:3f9a2c1d)  dotenv:/Users/me/proj/.env
decider.model     jev-1.13.0                             default (typesafe)
mode              jev-only                               default
```

`DERIVATIONS` (`src/cli/config-table.ts:17`) gains `'decider.provider'` from `providerSource`; provider-keyed defaults
print `default (<provider>)`; `--json` adds `providerSource`. `/jev` (`session.ts:2206–2228`) becomes three lines:

```
[ui] jev
  typesafe · api.typesafe.ai · jev-1.13.0 (pinned) → resolved jev-1.13.0
  questions 212 · latency p50 112 ms · p95 189 ms · jev cost $0.003 (~ table-priced: $0.042/M input, output free)
  intake: 4 messages · p50 118 ms · $0.0003 · last: greeting_or_smalltalk 0.94
```

The startup `[config]` item after the shadowing lines: `[config] decider: <provider> · <model> (pinned|alias) · key
<ENV> (<source>) · about <p50> ms per decision` (the latency clause only when a previous session measured one).

### 2.7 Verification

`verifyKeys` (`src/cli/login.ts:240–268`): under `typesafe` the Jev check is one priced decision (a one-Noul probe over
`{ message: 'hi' }`, ≈ $0.00002); `WIZARD_VERIFY_DETAIL` becomes provider-keyed (`one Jev decision at api.typesafe.ai
~$0.00002 (jev-1.13.0)` / today's text); `VerifyInput` gains `jevProvider`.

### 2.8 Live tests (`test:live`, paid, skipped without the key; nothing was run while writing this)

```ts
// test/live/jev.live.test.ts (S1) — a table over both providers
const CASES = [
  { provider: 'openrouter' as const, key: env.OPENROUTER_API_KEY ?? env.JEV_API_KEY ?? '', model: 'typesafe/jev-1.13-20260917', expectId: /^gen-dec-/, basis: 'provider' },
  { provider: 'typesafe' as const,   key: env.TYPESAFE_API_KEY ?? '',                       model: 'jev-1.13.0',                 expectId: /.+/,          basis: 'table' },
];  // per case: today's three questions; served model === c.model and checkServedModel ok; costBasis === c.basis; costUsd === inputTokens × 4.2e-8 (± 1e-9);
    // typesafe only: model 'jev-1.13-20260917' → ConfigError exit 2 with no meter add; 'jev-latest' → served /^jev-1\.13\./ via the alias warning path; requestId non-null on both; latency printed
```

`test/live/jev-typesafe.live.test.ts` / `jev-openrouter.live.test.ts` select one row each; §8.3 adds `intake.live.test.ts` (S3).

---

## 3. Conversational intake (D-C)

### 3.1 The state machine of a submission

`routeSubmit` (`src/tui/composer/submit.ts`) is unchanged: slash lines, steers while live, the secret gate and chips
stay where they are. What changes is what `host.submit()` does with a `submit` decision.

| # | State | Trigger | Next | Visible effect |
| --- | --- | --- | --- | --- |
| 1 | idle, draft ready | Enter | `you-committed` | `[you] <text>` item appended (renderer-local); composer cleared; `thinking('intake')` → status `⠹ thinking`, placeholder `(thinking…)`; history not yet appended |
| 2 | `you-committed` | no Jev key resolves | wizard (`runLogin('missing', mode)`) then back to 2 once, else `[ui] error: missing decider.apiKey: …` → idle | — |
| 3 | `you-committed` | `sessionMeter.exceeded()` | idle | `[jevcode] The session cap ($<cap>) is reached, so I'm not sending anything to Jev. …` (no request) |
| 4 | `you-committed` | one `decider.ask` (groups A + B + C, stage `intent`, step 0) | one of 5–9 by `resolveIntake` | meter `sess $…` moves; `chat` `--json` line; `s0 intake` rows to the panel |
| 5 | `coding_task` (p ≥ 0.6 chosen, paired ≥ 0.5) | — | today's `startRun(text, so)` | `run:starting` → `[run] start …`; history kind `prompt` |
| 6 | `greeting_or_smalltalk` | — | idle | `[jevcode] <catalogue text>` (one item); history kind `chat` |
| 7 | `question_about_this_tool` | — | idle | one `[jevcode]` item per selected fact (≤ 4); history `chat` |
| 8 | `question_about_the_code` | jev-only | `looking` → idle | `⠹ looking`; one more Jev request (lookup); `[jevcode]` header + ≤ 3 hit lines per file + footer |
| 8′ | `question_about_the_code` | jev+llm | `replying` → idle | `⠹ replying`; generator streams into the live region; on completion one `[jevcode]` item per reply line |
| 9 | `ambiguous` (incl. fallback and any weak `coding_task`) | — | `intake` overlay (§3.7), status `asking` | card `run this as a task?`; `y` → 5; `n` → the best non-run reading from the same answers (no new request) → 6/7/8; Esc/Ctrl-C → text restored into the composer + `[jevcode] Okay — edit it and press Enter, or ask me something.` |
| 10 | any of 4–8′ | Ctrl-C ×1 while `thinking !== null` | idle | request aborted (`chatSignal`); the `AbortError` is caught by `chatFailure` (§3.8): toast `stopped thinking`, **no bubble**, draft not restored, `became: 'nothing'`, no arm (a second Ctrl-C ≤ 1.5 s exits as today) |
| 11 | 4–8 | Enter while `thinking !== null` | same | ignored with toast `one moment — still thinking`; the draft keeps accepting text |
| 12 | 4, 8 | Jev unreachable / `JevHttpError` after the client's retries (intake or lookup) | idle | `[jevcode] I couldn't reach Jev to read that (<short>). Press Enter to send it again.`; the meter is unchanged (a failed request carries no `usage`) |
| 12′ | 8′ | generator `ProviderHttpError` / network failure during the LLM turn, or `config.generator()` throwing | idle | `[jevcode] I couldn't get an answer from <model> (<short>). Ask again, or /mode jev-only for the lookup.` (`LLM_UNREACHABLE`); the live region empties; meter unchanged |
| 13 | 4, 8, 8′ | `ConfigError` anywhere (unknown model, bad URL, invalid generator section) | idle | `[ui] error: config: <redacted message>`, no bubble, `became: 'nothing'` |

Only path 5 and the `y` of path 9 reach `startRun`. One-shot tasks (`submitTask`, `session.ts:2786`) pass `kind: 'task'` and
skip intake (`jevcode run "hi"` runs a task named `hi`); a follow-up after a run passes intake too (`did it pass?` → `last_tests`).

### 3.2 The intake state (tiny, code-computed, redacted)

```ts
// src/chat/intake.ts (S3)
export interface IntakeStateInput {
  message: string;                       // ≤ 1,200 chars (head 1,000 + ' … ' + tail 200 via headTail)
  conversation: readonly ChatTurn[];     // last ≤ 6 turns { role: 'you' | 'jevcode', text ≤ 200, kind? }
  workspace: { name: string; git: boolean; hasTests: boolean; testRunner: TestRunner | null; files: 'none' | 'few' | 'some' | 'many' };  // 0 / < 20 / < 500 / ≥ 500 candidates
  session: { mode: EngineMode; runs: number; lastRun: { task: string /* ≤ 120 */; stopReason: StopReason; steps: number; testsAllPassed: boolean | null } | null; pendingMode: EngineMode | null };
  mentions: readonly string[];           // `@path` mentions, ≤ 5, paths only
}
export function buildIntakeState(i: IntakeStateInput, redact: (s: string) => string): JsonObject;
```

No counts Jev would have to compute (bucket words replace numbers); paths back-ticked; workspace name =
`basename(realpath)`; nothing from `.env`, the credentials file or a paste body (chips are expanded by `expandChips`
first; a pasted secret was already `addSecret`ed, so `redact` masks it).

### 3.3 Group A — the `intake` Choice and its paired Nouls (verbatim)

```ts
export const INTAKE_KINDS = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code', 'coding_task', 'ambiguous'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];
export const INTAKE_OPTIONS: Readonly<Record<IntakeKind, string>> = {
  greeting_or_smalltalk: 'a greeting, thanks, goodbye, a check that someone is there, or small talk that asks for no information and no work',
  question_about_this_tool: 'a question about JevCode itself: what it can do, its mode, its keys or cost, its commands, what the last run did, how to use it',
  question_about_the_code: 'a question about the code in `workspace` (what a file or function does, where something lives, why a test fails) that wants an explanation, not a change',
  coding_task: 'an instruction to change, create, fix, refactor, test, run, install or check something in `workspace`',
  ambiguous: 'the message reads both as a request for work and as a question or remark, and the difference decides whether a paid run starts',
};
/** REPORT rule 4 (docs/RESEARCH.md:318, accuracy 0.55 → 0.80): every Choice option's criteria is definition + examples — the table's `true` column, reused */
export const INTAKE_CRITERIA: Readonly<Record<IntakeKind, { definition: string; examples: readonly string[] }>> =
  Object.fromEntries(INTAKE_KINDS.map((k) => [k, { definition: PAIRED_TRUE[k], examples: PAIRED_TRUE_EXAMPLES[k] }])) as Record<IntakeKind, { definition: string; examples: readonly string[] }>;
export function buildIntakeQuestions(): Record<string, Question> {   // jev/questions.ts `choice` (accepts object criteria, questions.ts:63), `pairedNouls`, `ref`
  return { intake: choice(`What is the human asking of this coding-agent session in ${ref('message')}, read with ${ref('conversation')}, ${ref('workspace')} and ${ref('session')}?`, INTAKE_CRITERIA),   // INTAKE_OPTIONS (one-line descriptions) feed only the paired-Noul instructions below
    ...pairedNouls(INTAKE_OPTIONS, (option, desc) => ({ instructions: `Is \`${option}\` (${desc}) the right reading of ${ref('message')} given ${ref('conversation')}?`,
      criteria: { true: { definition: PAIRED_TRUE[option], examples: PAIRED_TRUE_EXAMPLES[option] }, false: { definition: PAIRED_FALSE[option], examples: PAIRED_FALSE_EXAMPLES[option] } } })) };
}
```

| option | true.definition | true.examples | false.definition | false.examples |
| --- | --- | --- | --- | --- |
| `greeting_or_smalltalk` | `message` opens, closes or keeps up a conversation and would be complete with a one-line friendly answer | `hi` · `thanks, that worked` · `you still there?` · `good morning` | `message` names a file, a test, an error or a change, or asks what something does | `hi, can you fix the failing test` · `thanks — now run the suite` |
| `question_about_this_tool` | `message` asks about JevCode, Jev, the mode, keys, cost, commands, the sandbox or the last run, and is answered from the session's own facts | `what can you do?` · `which mode is this?` · `how much has this cost?` · `did the last run pass?` | `message` asks about the project's code or asks for work | `what does parse_date do?` · `add a test for parse_date` |
| `question_about_the_code` | `message` asks how the code in `workspace` works or where something is, and an explanation would satisfy it | `where is the date parsing?` · `why does test_parse_date fail?` · `what does utils/dates.py export?` | `message` asks for a change, or asks about JevCode rather than the project | `fix the date parsing` · `what mode are you in?` |
| `coding_task` | `message` tells the agent to make or check a change in `workspace`; carrying it out means editing, creating, running or installing something | `fix the failing test in utils/dates.py` · `add a --dry-run flag` · `run the tests` · `also update the CHANGELOG` | `message` only asks a question, greets, or comments on a result | `looks good` · `what did you change?` |
| `ambiguous` | `message` can be read as work or as a question and `conversation` does not settle it | `the date parsing` · `tests?` · `parse_date is wrong` | one reading is clearly meant | `fix parse_date` · `what does parse_date do?` |

```ts
export const INTAKE_RUN_FLOOR = 0.6;   // a paid run needs Jev's own `coding_task` at p ≥ 0.6 and its paired Noul ≥ 0.5 (PAIRED_NOUL_FLOOR); anything weaker asks
export interface IntakeResolution { kind: IntakeKind; verdict: ChoiceVerdict; answer: string; probability: number; pairedNoul: number; near: boolean }
export function resolveIntake(answers: Record<string, Answer>): IntakeResolution {
  const r = resolveChoice<IntakeKind>({ choiceId: 'intake', answers, options: INTAKE_KINDS, escape: 'none_of_these', fallback: 'ambiguous' });   // loop/stages/choose.ts:45
  const near = Math.abs(r.probability - INTAKE_RUN_FLOOR) <= 0.03;
  if (r.option === 'coding_task' && (r.verdict !== 'chosen' || r.probability < INTAKE_RUN_FLOOR)) return { ...r, kind: 'ambiguous', near };
  return { ...r, kind: r.option, near };
}
export type ChatKind = Exclude<IntakeKind, 'coding_task' | 'ambiguous'>;
export function chatKindAfterNo(res: IntakeResult): ChatKind;   // argmax of the three from answers.intake.probabilities; ties → question_about_this_tool
/** the LLM path has a floor too (a paid generator turn is neither cheap nor reversible): chosen at p ≥ 0.5, or the paired Noul ≥ 0.5 */
export const LLM_ANSWER_FLOOR = 0.5;
export function llmAnswerAllowed(r: IntakeResolution, mode: EngineMode): boolean {
  return mode !== 'jev-only' && r.kind === 'question_about_the_code' && ((r.verdict === 'chosen' && r.probability >= LLM_ANSWER_FLOOR) || r.pairedNoul >= PAIRED_NOUL_FLOOR);
}
export type ChatRoute = 'run' | 'asked' | 'reply' | 'facts' | 'lookup' | 'llm';
export function routeOf(r: IntakeResolution, mode: EngineMode): ChatRoute;   // coding_task → run · ambiguous → asked · greeting → reply · tool → facts · code → llmAnswerAllowed ? llm : lookup; recorded in the `chat` index and --json lines (§6 item 17)
/** one request, all three groups; the controller's only entry point (§3.8) */
export interface IntakeResult { intake: IntakeResolution; answers: Record<string, Answer>; rows: readonly Decision[]; usage: TokenUsage; latencyMs: number; requestHash: string; provider: JevProvider }
export async function runIntake(i: { decider: Decider; state: JsonObject; facts: readonly Fact[]; signal: AbortSignal; redact: (s: string) => string }): Promise<IntakeResult>;
// = decider.ask(i.state, { ...buildIntakeQuestions(), reply: buildReplyQuestion(), ...buildFactQuestions(i.facts) }, { signal: i.signal, stage: 'intent', step: 0 });
//   rows = the AskResult's decisions (core `Decision`, step 0; the App maps them with `toDecisionRow`), requestHash = the client's hash, provider = decider.provider
```

Asymmetric on purpose: a reply from the catalogue or the facts is cheap and reversible, a run is money and a file change;
the one paid reply (the LLM turn) carries its own floor. No keyword list ever starts a run.

### 3.4 Group B — the reply catalogue (`src/chat/replies.ts`, verbatim)

```ts
export interface ReplySpec { readonly key: string; readonly when: string; readonly examples: readonly string[]; readonly text: string /* template ≤ 160 chars; <dir> <last> <mode> <runsDir> filled by fillReply */ }
export const REPLIES: readonly ReplySpec[];  export const REPLY_FALLBACK_KEY = 'smalltalk_other';   // the 14 rows below, in this order
export function buildReplyQuestion(): Question;   // choice(`Which reply in the catalogue answers ${ref('message')} best, read with ${ref('conversation')} and ${ref('session')}?`, Object.fromEntries(REPLIES.map(r => [r.key, { definition: r.when, examples: r.examples }])))
export function pickReply(answers: Record<string, Answer>): { key: string; probability: number };   // argmax; none_of_these / missing → REPLY_FALLBACK_KEY at p 0
export function fillReply(spec: ReplySpec, facts: { dir: string; lastRun: string | null; mode: EngineMode; runsDir: string }): string;   // runsDir `~`-abbreviated (`tildify`), never hardcoded
```

| key | when | examples | text |
| --- | --- | --- | --- |
| `hello_first` | a first greeting in this session, no question attached | `hi` · `hello` · `hey there` | `Hi. I'm ready when you are — describe a change you want in <dir>, or ask what I can do.` |
| `hello_again` | a greeting after earlier turns in `conversation` | `hi again` · `hello?` after a reply | `Hi again. Same session, same workspace — what's next?` |
| `how_are_you` | asks how the agent is doing | `how are you?` · `how's it going` | `Doing well: idle, keys loaded, nothing running. What can I look at?` |
| `good_morning` | a morning greeting | `good morning` · `morning!` | `Good morning. Fresh session on <dir> — tell me what to work on.` |
| `good_evening` | an afternoon, evening or night greeting | `good evening` · `late night here` | `Good evening. I'm here whenever you're ready.` |
| `thanks` | thanks or appreciation for something done | `thanks` · `thank you, that worked` | `You're welcome. Anything else on <dir>?` |
| `bye` | a goodbye or sign-off | `bye` · `see you` · `that's all for today` | `Bye for now. /exit closes the session; runs are saved under <runsDir>.` (`JEVCODE_HOME` / `--runs-dir` relocate it, so the path comes from `FactsInput.runsDir`) |
| `praise` | praise for the agent or the result | `nice work` · `perfect` | `Thanks — Jev did the deciding. Want to take on the next one?` |
| `apology` | the human apologises or says they made a mistake | `sorry, wrong window` · `my bad` | `No harm done — nothing was run, so we can just carry on.` |
| `checking_alive` | asks whether the agent is present or working | `you there?` · `still alive?` · `hello??` | `Yes, I'm here: idle and listening. Type a task or a question.` |
| `ok_ack` | a bare acknowledgement | `ok` · `okay` · `got it` · `cool` | `Okay. Whenever you're ready.` |
| `whats_up` | asks what is happening or what is new | `what's up?` · `anything new?` | `Not much: the composer's open, the workspace is <dir>, <last>.` |
| `laughing` | laughter or a joke | `lol` · `haha` · `ha` | `Glad that landed. What shall we do next?` |
| `smalltalk_other` | small talk none of the others fit (the fallback) | `nice weather` · `how was your weekend` | `Happy to chat, though I'm best at code. Ask me anything about <dir>, or hand me a task.` |

`fillReply`: `<dir>` → `basename(workspaceRoot)`; `<last>` → `nothing has run yet` / `the last run ended <stopReason> after
<steps> steps` / `the last run is paused after step <n> (/resume continues)`; `<mode>` → `jev-only` / `jev+llm`; `<runsDir>` →
`tildify(runsDir)` (`~/.jevcode/runs` by default). `replies.test.ts`: every template containing a path placeholder fills it from the input. No emoji; a
`/command` inside a reply is literal; adding a row changes the Choice's option set and nothing else.

### 3.5 Group C — the harness facts (`src/chat/facts.ts`, verbatim)

```ts
export type FactKey = 'what_it_is' | 'mode_now' | 'switch_mode' | 'workspace' | 'last_run' | 'last_tests' | 'keys' | 'cost_so_far' | 'sandbox' | 'how_to_task' | 'review' | 'undo' | 'commands' | 'provider';
export interface Fact { readonly key: FactKey; readonly topic: string; readonly examples: readonly string[]; readonly text: string }
/** core types only — `src/chat/facts.ts` imports nothing from `src/cli/` (no cycle with the controller's `RunRecord`) */
export interface FactsLastRun { runId: string; task: string; stopReason: StopReason; steps: number; costUsd: { generator: number; jev: number }; paused: boolean }
export interface FactsInput { mode: EngineMode; nextMode: EngineMode; workspace: { root: string; git: GitState | null; hasTests: boolean; testCommand: string | null }; lastRun: FactsLastRun | null; lastTests: LastTestRun | null /* core types.ts:739 */; keys: { jev: { provider: JevProvider; source: string } | null; generator: { provider: string; source: string } | null }; spend: { sessionUsd: number; sessionCapUsd: number; runs: number; chats: number }; sandbox: SandboxLevel; runsDir: string; provider: { name: JevProvider; host: string; model: string; p50Ms: number | null } | null }
export function harnessFacts(i: FactsInput): readonly Fact[];                         // 14 facts; sources and fingerprints only, never a key value; `examples` = the table's column
export const FACT_FALSE_EXAMPLES: Readonly<Record<FactKey, readonly string[]>>;      // the table's `false examples` column, verbatim (≥ 2 per key; `noul()` throws below two, questions.ts:31–34)
export function buildFactQuestions(facts: readonly Fact[]): Record<string, Question>;   // about_<key>: noul(`Does ${ref('message')} ask about ${fact.topic}?`, { true: { definition: `the human wants to know ${fact.topic}`, examples: fact.examples }, false: { definition: `${fact.topic} is not what the message is about`, examples: FACT_FALSE_EXAMPLES[fact.key] } })
export const FACT_SELECT_FLOOR = 0.5; export const FACT_MAX_LINES = 4;
export function selectFacts(facts: readonly Fact[], answers: Record<string, Answer>): readonly Fact[];   // p ≥ 0.5 sorted by p desc, ≤ 4; none ≥ 0.5 → the top 2
```

| key | topic | examples (`Fact.examples`) | false examples (`FACT_FALSE_EXAMPLES`) | text |
| --- | --- | --- | --- | --- |
| `what_it_is` | what JevCode is and how it works | `what can you do?` · `what are you?` · `how does this work?` | `what does parse_date do?` · `fix the failing test` | `JevCode is a coding agent where Jev, a decision model, makes every decision: what kind of step comes next, which files matter, how risky an action is, whether a step worked. In jev-only mode code proposes fixes and tests verify them; in jev+llm mode Claude writes the code.` |
| `mode_now` | which mode the session is in | `which mode is this?` · `are you using the LLM?` · `is Claude on?` | `what does parse_date do?` · `run the tests` | `Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.` / `Mode: jev+llm — Claude writes the code, Jev decides every step.` (+ ` Next run: <nextMode>.` when pending differs) |
| `switch_mode` | how to switch between jev-only and jev+llm | `how do I turn the LLM on?` · `switch to jev+llm?` · `how do I change mode?` | `which mode is this?` · `add a --dry-run flag` | `Switch with /mode jev-on (alias /llm on) or /mode jev-only; it applies to the next run. Persist it with jevcode config set mode <m>.` |
| `workspace` | which directory and repository it is working on | `which folder are you in?` · `what repo is this?` · `where are we?` | `where is the date parsing?` · `hi` | `Workspace: <root> (git <branch>, <m> modified · <u> untracked; tests: <command>)` / `Workspace: <root> (not a git repository; no test command found)` |
| `last_run` | what the last run did and how it ended | `what did the last run do?` · `did it finish?` · `what happened just now?` | `run the tests` · `what does utils/dates.py export?` | `Last run <id>: "<task60>" ended <stopReason> after <steps> steps, $<cost>; /resume continues, /diff shows the changes.` / `Nothing has run yet in this session.` |
| `last_tests` | whether the tests pass | `did the tests pass?` · `how many tests failed?` · `is the suite green?` | `run the tests` · `why does test_parse_date fail?` | `Last test run: <passed> passed, <failed> failed, <errors> errors (step <n>).` / `No test run has been parsed in this session yet.` |
| `keys` | which API keys are configured and where they come from | `which keys are you using?` · `is my API key set?` · `where does the key come from?` | `how much has this cost?` · `thanks` | `Keys: Jev through <provider> (<ENV or file>, never printed); generator: <provider> (<source>)` / `…; generator: none — needed for jev+llm; /mode jev-on asks for one.` |
| `cost_so_far` | how much the session has cost | `how much has this cost?` · `what have I spent?` · `how much money so far?` | `which mode is this?` · `fix the date parsing` | `Session spend: $<x> of $<cap> (<runs> run(s), <chats> chat message(s)). /cost has the breakdown.` |
| `sandbox` | how commands are sandboxed | `are commands sandboxed?` · `can you touch the network?` · `is this safe to run?` | `run the tests` · `what did you change?` | `sandboxText(level)` (`onboarding/lines.ts:200`) |
| `how_to_task` | how to start a run or give it work | `how do I give you a task?` · `how do I start?` · `what do I type to make a change?` | `fix the failing test` · `what did the last run do?` | `Describe the change in plain words and press Enter; a run starts, shows every decision, and stops to ask before anything risky.` + by `nextMode`: jev-only ` In jev-only I fix what tests can verify; for open-ended changes switch with /mode jev-on.` · jev-on ` Claude writes the code, Jev decides each step.` · jev-off ` The generator alone runs it; reviews still ask.` |
| `review` | how approvals and reviews work | `what does the review card do?` · `how do I approve a step?` · `will you ask before deleting?` | `undo that` · `what does parse_date do?` | `Risky actions stop for review: y approves once, n declines, d declines with a note. Nothing is ever auto-approved; Enter does nothing there.` |
| `undo` | how to undo or inspect changes | `how do I undo that?` · `can I revert the last step?` · `how do I see the diff?` | `revert the last commit` · `did the tests pass?` | `/undo reverts the last step's file changes, /rewind picks a step, /diff shows what changed.` |
| `commands` | which commands exist | `what commands are there?` · `how do I see the help?` · `what does /panel do?` | `run the tests` · `hi` | `Commands start with /; type / to list them, /help for keys.` |
| `provider` | how Jev is reached, its model, latency and price | `which Jev model is this?` · `are you on typesafe or openrouter?` · `how fast is Jev?` | `which mode is this?` · `what does parse_date do?` | `Jev: <provider> (<host>), model <model>, about <p50> ms per decision, $0.042 per million input tokens (output free).` (`about <p50> ms` only when `provider.p50Ms !== null`) |

The bubble is **one `[jevcode]` item per selected fact**, in probability order (the answer leads with what was asked).
`facts.test.ts` (S3): `buildFactQuestions(harnessFacts(fixture))` builds without throwing for every fixture (keyed, keyless, no
run, paused run); every text that contains a path (`workspace`, `bye`'s twin in replies) derives it from the input; no key
value in any text.

### 3.6 `question_about_the_code`

**jev-only — the honest lookup (`src/chat/lookup.ts`), no engine run.** The jev-only synthesizer proposes no `read`
under any intent (`src/synth/search/index.ts:634–638`) and opens with the baseline test run (`:568–582`), so a forced
"investigate" run would be a test run ending in `max_replans`. What jev-only does well is select: one request of Nouls
over candidate files (`contextNoul`, `src/jev/questions.ts:52`), then code-computed excerpts.

```ts
export interface LookupInput { message: string; mentions: readonly string[]; candidates: readonly Candidate[]; read: (rel: string, maxBytes: number) => Promise<FileView>; ask: (state: Json, questions: Record<string, Question>) => Promise<AskResult>; redact: (s: string) => string; signal: AbortSignal }
export interface LookupHit { path: string; p: number; lines: { n: number; text: string }[] }                 // ≤ 3 lines per file, each ≤ 120 cells
export interface LookupResult { hits: LookupHit[]; considered: number; usage: TokenUsage; latencyMs: number; provider: JevProvider }
export const LOOKUP_CANDIDATES_MAX = 60; export const LOOKUP_HITS_MAX = 3; export const LOOKUP_SELECT_FLOOR = 0.5; export const LOOKUP_READ_BYTES = 64 * 1024;
export function lookupKeywords(message: string): string[];                                                  // identifiers and words ≥ 3 chars minus a 60-word stoplist, ≤ 12, lower-cased
export function rankCandidates(candidates: readonly Candidate[], keywords: readonly string[], mentions: readonly string[]): Candidate[];   // mentions first, path-token overlap desc, shorter paths; ≤ 60; ≤ 1 ms over 20,000
export async function lookupCode(i: LookupInput): Promise<LookupResult>;   // state { message, files: [{ path, bytes }…] }, questions file_<i> = contextNoul(`Would reading \`${path}\` help answer ${ref('message')}?`) with the criteria written once; p ≥ 0.5, top 3; read ≤ 64 KiB each (denylist first, `isMentionDenied`); keep ≤ 3 keyword lines, definition lines first
export function lookupLines(r: LookupResult, dir: string): string[];      // the bubble below, or the miss line
```

```
[jevcode] In jev-only mode I can point at code but not explain it — Jev decides, it doesn't write. Likely places:
[jevcode]   utils/dates.py:12  def parse_date(s: str, tz: str | None = None) -> datetime:
[jevcode]   utils/dates.py:31      return datetime.strptime(s, FMT).replace(tzinfo=tz)
[jevcode]   tests/test_dates.py:8  def test_parse_date_tz():
[jevcode] Switch with /mode jev-on to get an explanation from the LLM, or describe the change and I'll make it.
```

No hit ≥ 0.5 → `[jevcode] I couldn't find a file in <dir> that clearly answers that (looked at <considered> candidates).
Name the file or function, or switch with /mode jev-on for an explanation.` ≈ 1,200 input tokens, one round trip plus
≤ 3 bounded reads.

**jev+llm — one generator chat turn, no tools (`src/chat/llm-turn.ts`).**

```ts
export interface LlmTurnInput { provider: Provider; message: string; conversation: readonly ChatTurn[]; facts: readonly Fact[]; context: { plan: Plan | null; window: readonly WindowEntry[]; files: readonly FileView[] } /* last run's plan, window ≤ 4, @-mentioned files ≤ 3 × 8 KiB after the denylist */; instructions: string | null /* AGENTS.md only when trusted */; generation: { maxTokens: number; temperature: number | null } /* min(800, cfg.maxTokens), null */; signal: AbortSignal; onDelta: (text: string) => void; redact: (s: string) => string }
export const CHAT_SYSTEM_PROMPT = [
  'You are the assistant of JevCode, a coding agent in which Jev (a decision model) makes every decision. You are in a conversation about the code in the workspace named below.',
  'Answer the question. Do not propose file edits, patches or commands to run: the human starts a run for that by describing a task, and Jev then decides each step.',
  'Be concrete, cite paths and line numbers you were shown, and keep the answer under twelve lines. If the shown files do not contain the answer, say what to open next.',
].join('\n');
export function buildChatRequest(i: LlmTurnInput): GenerateRequest;   // system = CHAT_SYSTEM_PROMPT + '\n\n## Session facts\n' + facts + optional '## Instructions (AGENTS.md)' + '## Last run plan' + '## Recent steps' + '## Files'; messages = conversation (≤ 6, you→user, jevcode→assistant) + the message; no tools, no toolChoice
export async function llmChatTurn(i: LlmTurnInput): Promise<{ text: string; usage: TokenUsage; latencyMs: number; model: string }>;
```

**Floor and caps before the request.** The LLM turn runs only when `llmAnswerAllowed(res.intake, mode)` (§3.3: verdict
`chosen` at p ≥ `LLM_ANSWER_FLOOR` 0.5, or the paired Noul ≥ 0.5); a weaker `question_about_the_code` reading under jev+llm
takes the jev-only lookup above (≈ $0.00005) and appends `[jevcode] Ask again more specifically for an LLM answer.`
(`LLM_FLOORED_HINT`); the `n` of the ambiguity card routes through the same check. Before `llmChatTurn` the controller
re-checks `sessionMeter.exceeded()` and `sessionTotal() + chatEstimateUsd(gen, text) > sessionCapOf()` (`chatEstimateUsd` =
(`CHAT_FIXED_INPUT_TOKENS` 1,200 + text.length × 0.25 + file bytes / 4) × `pricing.inputUsdPerToken` + `min(800, gen.maxTokens)`
× `pricing.outputUsdPerToken`) — over → `SESSION_CAP_CHAT_REFUSAL`, no request. Deltas stream into the live region
(`liveLines`, the generator-proposal choreography) under `⠹ replying`; on completion one `[jevcode]` item per non-empty
line and the live region empties. Cost → `sessionMeter.add('generator', usage)`. An unpriced generator refuses before
sending unless `--allow-unpriced`: `[jevcode] I can't answer through the LLM: <model> has no pricing entry and
--allow-unpriced is off (jev-only lookup still works).` A `ProviderHttpError`/network failure → `[jevcode] I couldn't get an
answer from <model> (<short>). Ask again, or /mode jev-only for the lookup.` (`LLM_UNREACHABLE(model, short)`, §3.8
`chatFailure`), the live region empties, the meter is unchanged. A returned tool call is dropped with a `jevcode.log`
warning. Greetings never call the LLM.

### 3.7 `ambiguous` — the confirmation card, never a silent run

`OverlayKind` gains `'intake'` (`layout.ts:36`; in `COLLAPSING`; `overlayWant` 3 boxed via `cardLines`, 1 flat). Rows
(`src/chat/lines.ts`, shared by Ink, `--plain`, SR):

| Twin | Rows |
| --- | --- |
| boxed, < 100 inner cells | card title `run this as a task?`; body `[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)` |
| boxed, ≥ 100 | title `"<message ≤ 40, one line>" — run this as a task?`; same body |
| flat | one row, by width (`intakeRowLines`, tested at 40/80/100/120): ≥ 100 columns `run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)` (95 cells) · ≥ 72 `run this as a task?  [y] run it  [n] just chatting  Esc keeps the text` (70; frame H-J1) · else `run this as a task?  [y] [n]  Esc keeps` (39) |
| `--plain` readline | `run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ` — `y`/`yes`, `n`/`no`; empty or anything else keeps; five invalid answers = keep (`READLINE_MAX_PROMPTS`) |
| screen reader | `1 run it  2 just chatting  3 keep the text` / `Enter selection (1-3):` (typed-line rule, draft stash, TD §6.5) |

Keys (new S5 sub-row of TD §3.3): `y` → run; `n` → `chatKindAfterNo` → a reply from the answers in hand (no new
request); Esc / Ctrl-C → close, `renderer.restoreDraft(text)`, `[jevcode] Okay — edit it and press Enter, or ask me
something.`; Enter inert; printable → toast `intake pending: y n · Esc keeps the text`; paste never matches; armed per
TD §6.3 (committed frame **and** `GATE_ARM_MS` 150 ms) so the submitting Enter can never answer `y`. Placeholder
`(waiting for y/n)`, status word `asking`. Without a composer (`--no-input`, a pipe) the C46 default is `'keep'`.

### 3.8 The controller's submit path (`src/cli/session.ts`, S3)

```ts
// host.submit (session.ts:2568) — returns SubmitOutcome (§6 item 10)
async submit(text, so): Promise<SubmitOutcome> {
  await startupDone;
  for (const span of so.secretSpans) config?.addSecret(`composer#${++secretSeq}`, span);
  if (so.kind === 'task') { await startRun(text, { kind: ranBefore() ? 'follow-up' : 'prompt', pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length }); return { became: live() ? 'run' : 'nothing' }; }
  return converse(text, so);
},
```

```ts
async function converse(text: string, so: { kind: 'prompt' | 'follow-up'; pinnedFiles: readonly string[]; secretSpans: readonly string[] }): Promise<SubmitOutcome> {
  if (exiting) return { became: 'nothing' };
  if (live()) { uiError('a run is live; Enter steers it (Esc pauses, Esc Esc aborts)'); return { became: 'nothing' }; }
  if (!config) { uiError('configuration not ready yet'); return { became: 'nothing' }; }
  say('you', redact(text).split('\n').filter((l) => l.trim() !== ''));                     // the [you] bubble, always first: redacted at emission, one item per line (§3.10)
  if (config.missingSecrets('jev-only').length > 0 && !(await runLogin('missing', pending.mode ?? baseMode))) { uiError(MISSING_JEV_KEY); return { became: 'nothing' }; }
  const cfg = config;                                                                       // read AFTER the wizard: persistCredentials → reresolve() replaced the object (session.ts:1230–1240); a stale capture would validate keyless entries
  if (!cfg || cfg.missingSecrets('jev-only').length > 0) { uiError(MISSING_JEV_KEY); return { became: 'nothing' }; }
  if (sessionMeter.exceeded()) { say('jevcode', [SESSION_CAP_CHAT_REFUSAL(sessionCapOf())]); return { became: 'chat' }; }   // the root meter exists since startup (§3.9); the cap is the mode default, never $Infinity
  const mode = pending.mode ?? baseMode;
  thinking('intake');
  let res: IntakeResult;
  try { res = await runIntake({ decider: await deciderOf(cfg, flags), state: intakeState(text, so.pinnedFiles), facts: harnessFacts(factsInput()), signal: chatSignal(), redact }); }
  catch (e) { return chatFailure(e, 'jev'); }
  finally { thinking(null); }
  const route = routeOf(res.intake, mode);
  meterChat('jev', res.usage, res.provider, route); chatDecisions(res.rows); ledger.push(youTurn(text, res)); json?.chat(chatLine(res, route), ctx());
  log.info(`intake ${res.intake.kind} p=${res.intake.probability.toFixed(2)} ${Math.round(res.latencyMs)}ms ${res.requestHash} → ${route}`);   // never the message
  const run = async (): Promise<SubmitOutcome> => { await startRun(text, { kind: so.kind, pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length }); return { became: live() ? 'run' : 'nothing' }; };
  switch (res.intake.kind) {
    case 'coding_task': return run();
    case 'ambiguous': {
      const a = prompter?.intake ? await prompter.intake(text) : 'keep';                     // --no-input / a pipe: keep (C46) — never a run
      if (a === 'run') return run();
      if (a === 'keep') { say('jevcode', [INTAKE_KEPT]); renderer.restoreDraft?.(text); return { became: 'nothing' }; }
      return reply(text, res, chatKindAfterNo(res), so);
    }
    default: return reply(text, res, res.intake.kind, so);
  }
}
async function reply(text: string, res: IntakeResult, kind: ChatKind, so: { pinnedFiles: readonly string[] }): Promise<SubmitOutcome> {
  const mode = pending.mode ?? baseMode;
  const viaLlm = kind === 'question_about_the_code' && llmAnswerAllowed(res.intake, mode);   // §3.3 / §3.6 floor; false in jev-only and for weak readings
  let lines: string[];
  try {
    if (kind === 'greeting_or_smalltalk') lines = [fillReply(replyByKey(pickReply(res.answers).key), replyFacts())];
    else if (kind === 'question_about_this_tool') lines = selectFacts(harnessFacts(factsInput()), res.answers).map((f) => f.text);
    else if (!viaLlm) {
      thinking('lookup'); const r = await lookupCode(lookupInput(text, so.pinnedFiles)); meterChat('jev', r.usage, r.provider, 'lookup');
      lines = lookupLines(r, basename(workspaceRoot)); if (mode !== 'jev-only') lines.push(LLM_FLOORED_HINT);
    } else {
      const gen = config!.generator();                                                       // ConfigError (invalid generator section) → chatFailure → [ui] error
      if (gen.priced !== true && flags.allowUnpriced !== true) lines = [LLM_UNPRICED_REFUSAL(gen.model)];
      else if (sessionMeter.exceeded() || sessionTotal() + chatEstimateUsd(gen, text, so.pinnedFiles) > sessionCapOf()) lines = [SESSION_CAP_CHAT_REFUSAL(sessionCapOf())];
      else { thinking('replying'); const r = await llmChatTurn(llmInput(text, so.pinnedFiles, gen)); meterChat('generator', r.usage, 'generator', 'llm'); lines = r.text.split('\n').filter((l) => l.trim() !== ''); }
    }
  } catch (e) { renderer.live?.(''); return chatFailure(e, viaLlm ? 'generator' : 'jev'); }
  finally { thinking(null); }
  say('jevcode', lines); ledger.push({ role: 'jevcode', text: lines.join('\n'), at: nowIso() });
  return { became: 'chat' };
}
/** every failure of a chat request lands here (§3.1 rows 10, 12, 12′, 13); the meter is never touched (a failed request carries no usage) */
function chatFailure(e: unknown, side: 'jev' | 'generator'): SubmitOutcome {
  if (isAbortError(e)) { uiToast('stopped thinking'); return { became: 'nothing' }; }                        // Ctrl-C ×1 / exit: no bubble, the draft is not restored
  if (e instanceof ConfigError) { uiError(`config: ${redact(e.message)}`); return { became: 'nothing' }; }
  const short = redact(describe(e)).slice(0, 80);                                                             // JevHttpError · ProviderHttpError · network
  say('jevcode', [side === 'jev' ? INTAKE_UNREACHABLE(short) : LLM_UNREACHABLE(generatorModelLabel(), short)]);
  return { became: 'chat' };
}
```

```ts
// the controller helpers the code above uses (all in src/cli/session.ts, S3); pure builders live in src/chat/**
function intakeState(text: string, pinned: readonly string[]): JsonObject;           // buildIntakeState({ message: text, conversation: ledger.recent(6), workspace: workspaceFacts(), session: sessionFacts(), mentions: pinned.slice(0, 5) }, redact)
function factsInput(): FactsInput;                                                   // from config (mode, keys' sources, provider spec), runs (last RunRecord → FactsLastRun), lastTests, sessionMeter.snapshot(), ledger.stats(), detectSandboxLevel, runsDir
function replyFacts(): { dir: string; lastRun: string | null; mode: EngineMode; runsDir: string };
function lookupInput(text: string, pinned: readonly string[]): LookupInput;          // candidates = await candidates (the startup listing, session.ts:2741), ask = decider.ask(s, q, { signal: chatSignal(), stage: 'context', step: 0 })
function llmInput(text: string, pinned: readonly string[], gen: GeneratorConfig): LlmTurnInput;   // provider = providerOf(gen), conversation = ledger.recent(6), facts = harnessFacts(factsInput()), onDelta = renderer.live ?? noop
function meterChat(source: 'jev' | 'generator', usage: TokenUsage, provider: JevProvider | 'generator', route: ChatRoute): void;   // sessionMeter.add(source, usage) → 50/80/95 % thresholds (budgetItems, once each) → pushSessionSpend() → the `chat` index line (buffered with deferredBudgetLines before the first run, §3.9)
function chatDecisions(rows: readonly Decision[]): void;                             // keeps the last ≤ 3 intakes; extras.dispatch?.({ type: 'chat-decisions', rows: kept.map((d) => toDecisionRow(d)) })
function youTurn(text: string, res: IntakeResult): ChatTurn;                         // { role: 'you', text: redact(text), at: nowIso(), kind: res.intake.kind, requestHash: res.requestHash, latencyMs: res.latencyMs, costUsd: res.usage.costUsd, provider: res.provider }
function chatLine(res: IntakeResult, route: ChatRoute): JsonChatLine;                // §6 item 17: { type: 'chat', intake, probability, route, provider, costUsd, latencyMs, requestHash }
function replyByKey(key: string): ReplySpec;                                         // REPLIES.find((r) => r.key === key) ?? the REPLY_FALLBACK_KEY row
function chatEstimateUsd(gen: GeneratorConfig, text: string, pinned: readonly string[]): number;   // §3.6: (1,200 + text.length × 0.25 + pinned bytes / 4) × in-price + min(800, gen.maxTokens) × out-price
function generatorModelLabel(): string;                                              // config?.generatorModelId() ?? 'the LLM' — never throws (used inside chatFailure)
function chatSignal(): AbortSignal;                                                   // one AbortController per submission; aborted by Ctrl-C ×1 while thinking, /exit, SIGINT/SIGTERM
function thinking(phase: 'intake' | 'lookup' | 'replying' | null): void;              // extras.dispatch?.({ type: 'thinking', phase })
function uiToast(text: string): void;                                                 // extras.dispatch?.({ type: 'toast', text, level: 'info', ms: TOAST_INFO_MS }); the --plain composer prints `(text)` as a bare line — never an item (TD §15.1)
```

`say(role, lines)` appends one item per line through `note(line, { label })` (`session.ts:961–973`: `annotate()` while live, a
local item while idle). `startRun` (S3) mirrors the config re-read: `const cfg = config` **after** `runLogin` returned true,
never before. The App (`App.tsx:789–809`, S4) dispatches `thinking: 'intake'` instead of `run:starting` (the controller
dispatches `run:starting` at the top of `startRun`, `session.ts:1449`), appends history from `SubmitOutcome` (`run` → the
draft's kind, `chat` → `'chat'`, `nothing` → none) and flips the composer to `followup` on `run` or `chat` (§4.4). The
`--plain` composer (`plain-composer.ts:204`) wraps `await host.submit()` in the same `try/catch` as its command path and
prints `[ui] error: <redacted>` for anything `chatFailure` did not absorb.

### 3.9 Money, ledger, history, redaction

- **Meter.** The root session meter is created **once, at startup** (`newSessionMeter(); pushSessionSpend()`,
  `session.ts:2743–2744`, before `startupDone` resolves; `host.submit` awaits `startupDone` first, so the `+Infinity`
  placeholder of `:824` never meets a chat request and `sessionCapOf()` is the mode default — $1.25 under jev-only). Every
  chat request is charged to it (`sess $x.xx/1.25` moves from the first reply; a greeting ≈ $0.00007). **`startRun`'s
  first-run rebuild goes away**: `session.ts:1452` `if (runs.length === 0 && sessionId === null && !sessionCapExplicit)
  newSessionMeter()` becomes `sessionMeter.setCap?.(config.sessionSpendCap(mode).value)` (`SpendMeter.setCap`,
  `types.ts:553`: "never recreate a meter"), so the accumulated intake/lookup spend, the threshold state and
  `deferredBudgetLines` (`:848`) survive into the first run and the buffered `chat` index lines are written with the first
  run's session id (`:1612`); `newSessionMeter()` stays for startup and `/new`. `meterChat` checks the 50/80/95 %
  thresholds (`budgetItems`, `budget/lines.ts:156`, once each); at or over the cap chat refuses too (§3.1 row 3).
  `session-chat.test.ts` row: `hi`, `hi`, then a task → the run's `run.json`/index session total includes both intakes; the
  cap refusal fires at the cap before any run; the meter object is identical before and after `run:start`.
- **Ledger.** `src/chat/ledger.ts` `ChatLedger` (≤ 200 turns; the last 6 go to Jev): `ChatTurn { role, text, at, kind?,
  requestHash?, latencyMs?, costUsd?, provider? }`; `stats()` feeds `/jev` line 3 and `/cost`'s `chat $0.0003 for 4
  messages (~$7.5e-5 each, p50 118 ms)`. The `chat` index line (§6 item 17) lets `seedMeterFromIndex` (`session.ts:1353`)
  restore chat spend on `/resume`; before the first run the lines are buffered like `deferredBudgetLines` (`:848`,
  `:1612`) and written with the first run's session id (a session that never runs drops them — documented).
- **History.** `HistoryKind` gains `'chat'`: a submission that became a run is `prompt`, a reply or lookup is `chat`, one
  taken back with Esc is not appended; replies are never history; Up-arrow and Ctrl-R include chat lines.
- **Redaction.** The message reaches Jev through `redact` and the generator raw (like a task); catalogue and facts carry
  sources and fingerprints only; the ledger stores `text` through `redact`; `jevcode.log` never records the message.

### 3.10 Bubbles: labels, items, identity

`UiLabel` gains `'[you]' | '[jevcode]'` (§6 item 1); `TranscriptKind` gains `'chat'`. **One item per line** (≤
`TRANSCRIPT_TEXT_MAX`), so `formatTranscriptItem` prints `[you] hi` / `[jevcode] Hi. I'm ready …` and `--plain`, the
`<Static>` rows and `--json` `ui` lines carry the same text; `detail` (TUI-only, `plain.ts:76`) is **not** used for
replies. **Bubbles are redacted at emission and split per line**: `say('you', redact(text).split('\n').filter(nonBlank))`
— the composer's acknowledged spans were `addSecret`ed one line earlier, so a pasted secret is masked exactly as the engine
masks the task in `[run] start`, and a multi-line draft yields one item per line instead of `localItem`'s `oneLine()`
flattening (`plain.ts:406–414`); `notifyLocal` (`session.ts:948–953`) therefore never forwards raw text. `bubbles.test.ts`
asserts both. Idle → renderer-local items (`localItem`, `plain.ts:406`) through `SessionHost.note()`; live → `engine.annotate()`.
Identity rule for §4.5's dress, testable: **after `stripAnsi`, every TUI row of a chat item equals
`formatTranscriptItem(item)` word-wrapped at the commit width with a hanging indent of `label.length + 1` cells**.
`--json` gains one controller line `chat { intake, probability, provider, costUsd, latencyMs, requestHash }` per intake.

### 3.11 The intake in the Jev panel and `/why`

The intake's answers are `Decision` rows (`toDecisionRow`, `pane/model.ts:164`) with `step: 0`, `stage: 'intent'`, ids
`intake`, `can_*`, `reply`, `about_*`; the controller keeps the last ≤ 3 intakes and dispatches `chat-decisions`, so the
panel shows `s0 intake  intake  coding_task  ███████▊··  0.78  c 0.72  chosen` above `s1 intent` (H-E1) and `/why intake`
(refs `intake`, `intake.reply`, `intake.about_<key>`) prints the standard block; `consumedBy`: `resolveChoice → run floor
0.60 → <kind>` · `argmax → catalogue` · `≥ 0.5 → answer line`. Never written to `decisions.jsonl`; `/calibration` ignores
them; `EngineOptions.session.intake` (§6 item 13) records why a run started.

### 3.12 Latency budget

| Segment | Budget | Measured by |
| --- | --- | --- |
| Enter → `[you]` bubble + `⠹ thinking` frame | ≤ 16 ms p95 (the composer gate) | `src/perf/intake-latency.ts` (S5) against `--mock` |
| harness work per intake excl. Jev (state, questions, resolution, items) | ≤ 5 ms p95 | `test/unit/chat/intake.test.ts` `[measured]` over 1,000 builds |
| Jev round trip, TypeSafe native | 110–250 ms p50 | `test/live/intake.live.test.ts` prints p50/p95 over 14 messages per provider |
| Jev round trip, OpenRouter | ≈ 240 ms p50 | same |
| **Enter → `[jevcode]` reply frame, live** | **wall p95 < 1.5 s** (the round-2 gate, §9) | live suite + the S6 scenario's `mark` timings |
| Enter → reply frame, mock at 0 ms | ≤ 40 ms p95 | `intake-latency.ts` |
| lookup (jev-only code question) | ≤ 600 ms p95 native | live suite, one message |
| LLM chat turn | provider-bound, not gated | the live region shows progress |

Token estimate per message (REPORT §4: 271 fixed + ≈ 9 per short Noul + 0.196 tokens/char): ≈ 1,650 input tokens ≈ $0.00007; `intake.test.ts` fails above 3,000.

### 3.13 The mock decider (`src/jev/mock.ts`, S1 lands S3's spec)

`intake` → `greeting_or_smalltalk` on `/^\s*(hi|hello|hey|yo|thanks?|thank you|bye|ok(ay)?|good (morning|evening|afternoon))\b[!. ]*$/i`;
`question_about_this_tool` on `?` + `/\b(you|jevcode|jev|mode|cost|key|command|run)\b/i`; `question_about_the_code` on
any other `?`; `ambiguous` for ≤ 2 words without `?`; else `coding_task` at p 0.9 with `can_coding_task` 0.9. `reply` →
`hello_first` (`hello_again` when `conversation` is non-empty), `thanks`, `bye`, `ok_ack` by the same regexes. `about_*` →
0.8 for `mode_now` on `/mode/`, `cost_so_far` on `/cost|spent|money/`, `what_it_is` on `/what can you do|what are you/`,
else 0.1. `file_<i>` → 0.7 when the path shares a keyword. `JEVCODE_MOCK_INTAKE=<kind>` forces the intake answer;
`JEVCODE_MOCK_JEV_MS=<ms>` delays the mock (for the latency probe).

---

## 4. Visual redesign (D-D)

### 4.1 Chrome tiers (A §2.1)

| Tier | When | Console | Cards | Splash form |
| --- | --- | --- | --- | --- |
| **boxed** | `rows ≥ 16 && columns ≥ 40 && !screenReader` | top edge + divider + bottom edge = **3 rows** (`CAP.chrome`) | +2 rows each (title edge, bottom edge) | 5-row wordmark at `columns ≥ 64`, else the one-line brand row |
| **flat** | rows 8–15, or a screen reader | 0: today's `› ` row over today's status row; the badge leads the left zone | 0: TD's row layouts (F-G…F-I, F-P, F-W) | brand row on the rule |
| **minsize / static-only** | TD §2.1 | — | — | none |

The tier is a function of geometry alone (`chromeRows(rows, columns, screenReader): 0 | 3`), never of remaining budget, so
a box is never half-drawn: a shrink to 12 rows switches to flat in the same commit the early `resize` listener forces
(`App.tsx:1917–1924`), inside the one clear a shrink is allowed (TD §18).

### 4.2 Caps and `computeLayout` 1.1 (`src/tui/layout.ts`, S4)

```ts
export const CAP = { live: 2, queue: 2, pane: 12, panel: 6 /* NEW open size */, reviewHeader: 8, reviewCard: 9 /* NEW boxed */, preview: 8,
  wizard: 4, followup: 5, secret: 1, blocking: 4, palette: 8, undo: 1, exitConfirm: 1, intake: 1 /* NEW flat; boxed = 1 + card */, minsize: 1,
  card: 2 /* NEW edges a card adds */, composer: 6, composerTall: 8, banner: 1, chrome: 3 /* NEW */, splash: 5 /* NEW */ } as const;
export const BOXED_MIN_ROWS = 16; export const WORDMARK_MIN_COLUMNS = 64;
export type OverlayKind = 'none' | 'review' | 'wizard' | 'followup' | 'secret' | 'blocking' | 'palette' | 'undo' | 'exitConfirm' | 'intake';
const COLLAPSING = new Set<OverlayKind>(['review', 'followup', 'blocking', 'exitConfirm', 'intake']);
export function chromeRows(rows: number, columns: number, screenReader: boolean): 0 | 3;
export interface LayoutInput { /* TD §2.1 */ chrome: 0 | 3; gate: 0 | 1 }   // gate: the secret-gate row the console hosts (boxed tier only; the flat tier keeps the `secret` overlay)
export interface Layout { /* TD §2.1 */ chrome: number; gate: 0 | 1 }
export function computeLayout(i: LayoutInput): Layout {
  // TD §2.1 verbatim, plus step 3b after the composer floor and before the overlay:
  //   z.chrome = i.chrome === 3 && rows >= BOXED_MIN_ROWS ? take(3) : 0;   // whole or absent; never yields (like status and rule)
  //   the composer floor is `1 + i.gate` in the boxed tier (the gate row never yields); `z.composer` includes it; `z.gate = i.chrome === 3 ? i.gate : 0`
  // step 4 unchanged: a card's want already includes its two edges; step 10: paneWant is 0 (collapsed) · 6 (open) · 12 (full/picker) · 5 (splash, only while `motion.time < SPLASH_MS`, §5.3)
}
/** the console's top-edge row (boxed) — identical to today's composerTop (layout.ts:147–151) in the flat tier */
export function consoleTop(l: Layout): number { return l.rule + l.live + l.banner + l.pane + l.queue + l.overlay + l.preview; }
/** the `›` row: one below the top edge, below the gate row when it is up */
export function composerTop(l: Layout): number { return consoleTop(l) + (l.chrome > 0 ? 1 + l.gate : 0); }
```

Cursor and gate, one rule (a cursor test covers idle, gate-up and a 3-row draft): `ConsoleProps.top = consoleTop(layout)`;
the cursor is `{ x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row }` — the only formula, used by `Console`
and by the App's `setCursorPosition`. In the boxed tier the secret gate is a **console-hosted row** (`LayoutInput.gate = 1`
while `routeSubmit` holds the gate; `overlayWant('secret') = 0` when `chrome === 3`, `Overlay.tsx:44–70`), never the `secret`
overlay — one of the two, not both; the flat tier keeps the `secret` overlay exactly as today.

Yield order unchanged (`pane → banner → live → preview → queue → composer growth → overlay → composer-to-1`); chrome, rule
and status never yield. Boxed ⇒ rows ≥ 16 ⇒ budget ≥ 14; the fixed rows (status 1 + rule 1 + composer 1 + chrome 3) leave
≥ 8, so the review card ladder always has its three mandatory rows; the full 9-row card is whole from rows 17. New
invariants: `chrome ∈ {0, 3}`; `chrome === 3 ⇒ rows ≥ 16`; a boxed non-wizard overlay of want `w` is whole at `rows ≥ w +
8` (wizard `w + 7`); `computeLayout ≤ 5 µs`. Boxed `overlayWant` (`Overlay.tsx:44–70`): review 9, followup 5, blocking
`min(6, rows + 2)`, undo 3, exitConfirm 3, intake 3, palette 8 (its two edges replace the footer row and one list row),
secret 0 (the gate is `LayoutInput.gate`, §4.2) and wizard `wizardRows` (inside the console). Allocation at 80×24 (budget 22): splash 11 · idle 6 · live
jev-only 7 · panel open 12 · full 18 · review card + 4 preview = 19 · review + panel open = 22 · wizard 8 · exit/undo/intake
card 9 · blocking 12 · palette 14.

### 4.3 The console (A §3)

Boxed tier, inner width `W = columns − 4`: top edge `╭─ <badge>[ · next run] ──…── <dir> ─╮` (badge in the `badge`
role, workspace basename right; a hosted title such as `setup · generator key` or `sessions · filter` replaces the
badge) · composer rows 1..cap (`› ` on row 0, `  ` continuations; the secret-gate row above them when up) · divider
`├──┤` · `statusLineText(state, W)` · bottom edge `╰──╯`.

```ts
// src/tui/console.ts (NEW, pure, S4) — the shared lines() for Ink, frame tests and --ascii
export interface ConsoleInput { columns: number; badge: string; dir: string; title?: string | null; body: readonly string[]; gate?: string | null; status: string; glyphs?: GlyphSet }
export function consoleTopEdge(badgeOrTitle: string, dir: string, columns: number, g?: GlyphSet): string;   // exactly `columns` cells; badge and dir truncated before the fill goes negative
export function consoleRow(text: string, columns: number, g?: GlyphSet): string;                             // `│ ` + fitCells(text, columns − 4) + ` │`
export function consoleDivider(columns: number, g?: GlyphSet): string; export function consoleBottom(columns: number, g?: GlyphSet): string;
export function consoleLines(i: ConsoleInput): string[];                                                      // top, gate?, body…, divider, status, bottom = body.length + (gate ? 1 : 0) + 4 rows
export function consoleInnerWidth(columns: number): number;                                                   // Math.max(1, columns − 4)
// src/tui/Console.tsx (NEW, S4); boxed tier only — the flat tier renders <Composer> + <StatusLine> as today
export interface ConsoleProps { buffer: TextBuffer; columns: number; height: number; top: number; scrollTop: number; cursor: (pos: CursorPosition | undefined) => void; active: boolean; mode: ComposerMode; rows: number; live?: boolean; spans?: readonly Span[]; ghost?: { rest: string; more: number } | null; searchRow?: string | null; badge: string; dir: string; title?: string | null; gate?: string | null; status: StatusLineState; statusOptions: StatusLineOptions; wizard?: { state: OnboardingState; trust: TrustInputs | null } | null; glyphs?: GlyphSet; theme?: Theme; depth?: ColorDepth; onScroll?: (n: number) => void }
export function Console(p: ConsoleProps): React.JSX.Element;
```

Text rows, not `<Box borderStyle="round">` (Ink's border renderer has no title slot, `render-border.js:36–40` — an
absolute-positioned title over a bordered Box is possible in Ink 7.1.1 but would put the title outside the string twins;
§10.3). Cursor at `{ x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row }` with `ConsoleProps.top =
consoleTop(layout)` (§4.2). `composerView`, `draftRows` and `statusLineText` run at `W`; the status drop order applies at `W`
(live jev-only at 80 columns drops `? help` first, H-D1); git zone and sparkline (`≥ 100`) appear from 104 terminal
columns. Hosted rows: the secret gate (role `secret`, `Layout.gate`) above the draft; the wizard's 2–4 rows with the composer refunded;
the picker filter `› filter: par_` under `sessions · filter`; the collapsed composer under a review as one dim row.

### 4.4 Composer prompt and placeholders (`Composer.tsx`, S4)

`PROMPT_UNICODE = '› '`, `PROMPT_ASCII = '> '` (`glyphs.prompt`); `plain-composer.ts` keeps `> `; `placeholderFor(mode, rows, innerColumns)` gains the width argument.

| `ComposerMode` | Placeholder (< 100 inner cells) | appended at ≥ 100 |
| --- | --- | --- |
| `task` | `Say hi, ask a question, or describe a task…` | `   / commands · @ files` |
| `followup` | `Follow-up, question, or /command…` | `   ↑ history · Esc Esc menu` |
| `steer` | `Type to steer the next step…  Esc pauses` | `   Esc Esc aborts` |
| `review` | `(review pending — keys in the card; d opens a note)`; `(review pending)` below 16 rows | — |
| `thinking` (new) | `(thinking…)` — the draft stays editable; Enter queued (§3.1 row 11) | — |
| `intakeWait` (new) | `(waiting for y/n)` | — |
| `followupWait` `exitWait` `blocked` `filter` `done` | unchanged | — |

Mode rule: **`followup` once the session has any turn — a run (`run:end`, today's `ranBefore()`) or a chat reply
(`SubmitOutcome.became === 'chat'`, §3.8); `task` only before the first turn.** A command alone (`/mode`, `/help`) is not a
turn (H-G1 keeps `task`; H-B2/H-C1 show `followup`); the App keeps a `turns` counter for it (`useEngine` `UiState.turns`).

### 4.5 The transcript as a conversation (A §4)

Every `<Static>` row is built from `glyphTwin(formatTranscriptItem(item))` (`Transcript.tsx:52–55`) under the identity
predicate of §9 (wrapping and the fence rule are the only transformations; `compact` is a declared subsequence). Two
declared additions: (1) **a default kind filter** — `UiState.transcript: 'compact' | 'full'` (default `compact`) hides the stage
kinds `intent` `context` `synth` `proposal` `risk` `outcome` `judge` `plan` and `run:ready`, shows `step` (new),
`run:start`, `run:end`, `confirm:resolved`, `error`, `transcript`, `loop:tripped`, `replan`, `steer:*`, `pause`,
`budget`, `retry`, `notice`, `workspace`, `blocking`, `secret-ack`, `ui`, `chat`; stamped at append time (`appendItems`,
`useEngine.tsx:387–391`, `hidden: true`) and **filtered before `<Static>`**: `<Transcript>` receives `visibleItems`
(`items.filter((i) => !i.hidden)`, memoised on `items.length`; a filtered append-only array is append-only, A25 holds) while
`UiState.items` keeps every item for `/export` and for `/transcript full` (new items only, R4). A hidden-only batch therefore
dirties no `<Static>` subtree — no `isStaticDirty → onImmediateRender` pass (`ink/build/reconciler.js:109–112`), the commit
coalesces under the render throttle like any dynamic change. `--plain` is the `full` twin. Test (`transcript.test.tsx`):
mount inside `<Profiler onRender>` (React 19) and assert a hidden-only batch leaves the commit count and `frames().length`
unchanged. (2) **Decoration that never changes text** —
a spacer row above a turn (`marginTop={1}` inside the item's Box), a dim label span, a hanging indent for wrapped rows
(label box + `flexGrow` body box), fence rows drawn as `╶──── <lang>` / `╶────` (the only text substitution beyond
`--ascii`, limited to lines matching `/^```\w*$/`).

| Item | Static rows | Colour | Plain twin |
| --- | --- | --- | --- |
| `[you] <text>` | spacer · `[you]` dim + text in the `you` role; wrapped rows hang under the text column | `you` | `[you] <text>` |
| `[jevcode] <text>` | spacer before the first item of a turn only · `[jevcode]` dim + text default; consecutive `[jevcode]` items have no spacer between them | default | `[jevcode] <text>` |
| `[step N] …` | no spacer; label dim; `[review]`/`[block]` by `itemRole` | as today | unchanged |
| `[run] start` / `[run] end` | spacer above; `end` in `ok`/`warn` by stop reason | as today | unchanged |
| `[ui]` `[setup]` `[config]` `[sandbox]` | no spacer; dim unless level ≥ warn | as today | unchanged |

**The step summary line** — `step:end` yields one item of the new kind `'step'` in all three sinks (`plain.ts`, S3):

```ts
export function stepSummaryText(r: StepRecord, costUsd?: { generator: number; jev: number }): string;
// `[step N] <action> · risk <r> <verdict> · <outcome> · tests <p>p/<f>f/<e>e · judge <p>[ · complete <c>] · <wall> · <cost>`
```

| Segment | Source | Form |
| --- | --- | --- |
| action | `describeAction(r.proposal.action)` (`plain.ts:142`); target ≤ 40 cells; goal in quotes only for `edit`/`write`/`patch` and ≤ 32 chars | `edit kth.py "guard k > len"` · `run $ pytest -q` · `read tests/test_kth.py, kth.py` · `done <summary ≤ 40>` |
| risk | `r.risk.risk`, `r.risk.verdict` | `risk 0.12 ok` · `risk 0.44 [review]` · `risk 0.81 [block]` |
| outcome | `r.outcome.status`, `changedFiles.length` | `1 file` / `2 files`; `declined` · `failed` · `skipped` · `blocked`; nothing for a plain executed step |
| evidence | `r.judge.tests` when `source === 'parsed'` | `tests 41p/0f/0e` |
| judge | `r.judge.succeeded`, `r.completion` | `judge 0.89`; ` · complete 0.93` when `completion ≥ thresholds.complete` |
| wall | `r.timing.totalMs` | `1.2s` · `12s` · `1m02s` |
| cost or tokens | `costUsd` when the event carries it (§6 item 3), else `r.usage` | `$0.004` (three decimals; four below $0.001); without cost `jev 1.4k` / `gen 5.4k jev 1.4k` |
| interrupted | `r.interruptedAt` | `[step 3] interrupted at intent (human_abort)` |

Rows word-wrap at the commit width (A33), never truncate; action and verdict come first so wall and cost wrap (H-D1/H-D1w). A
`complete` stop's epilogue is a bubble: `[jevcode] Done — <summary ≤ 80>. /diff shows the change, /undo reverts it.`

### 4.6 The Jev panel (A §5)

`UiState.panel: 'collapsed' | 'open' | 'full'` (default `collapsed`; reset to `collapsed` at `run:start`; the picker
forces `full`). `paneWant` (`App.tsx:1723`) = `pickerOpen ? PICKER_PANE_WANT : splash === 'running' ? CAP.splash :
panel === 'open' ? CAP.panel : panel === 'full' ? CAP.pane : 0`.

| State | Rule row | Pane rows | How |
| --- | --- | --- | --- |
| collapsed | the **strip** | 0 | default; `Alt+J`, `/panel off`, Esc on an empty idle draft while open |
| open | today's tab header (`paneRuleRow`, `pane/model.ts:337`) with `▾ ` before the tab name | ≤ 6; the 6th is `  … <n> more rows · /panel full expands` when the tab has more; the decisions tab shows the **newest** rows | `Alt+J`, `/panel`, `/panel d\|p\|t\|s`, `[`/`]` on an empty draft |
| full | same header | ≤ 12 (TD's pane; `sideBySide` applies) | `/panel full`, `Alt+Shift+J`; the review's `e` still zeroes the pane |

```ts
// src/tui/pane/model.ts (S4)
export const PANEL_WIDE_COLUMNS = 120;   // ONE threshold for the strip and the open header (paneRuleRow's `wide`, pane/model.ts:339–341, reads it too)
export function panelStrip(state: PaneState & { latencies: readonly (number | null)[] }, columns: number, g?: GlyphSet): string;
// = ruleRow(`▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5[ · jev 231ms]`, wide ? ` [d]ecisions [p]lan [t]imeline [s]ynth ─────` : ` [d] [p] [t] [s] ──`, columns)
// wide = columns >= PANEL_WIDE_COLUMNS: long tab labels, the `jev <ms>ms` segment and the 5-rule tail (the header's `g.rule.repeat(wide ? 5 : 2)`); below: short labels, no latency, 2-rule tail — the strip and the open header never label a tab differently at any width (tests at 100 and 119 → short in both; 120 → long in both)
// segments dropped from the right when short
// before any run: the brand row (§5.6); with no decisions yet: `─── ▸ jev · no decisions yet ──── [d] [p] [t] [s] ──`
export function panelLines(state: PaneState, rows: number, columns: number, overlay: PaneOverlay, opts: PaneOptions & { size: 'open' | 'full' }): string[];
```

Keys (`keys/bindings.ts`, S4): `global:panelToggle` `meta+j` · `global:panelFull` `meta+shift+j` ·
`global:panelDecisions/Plan/Timeline/Synth` `meta+d/p/t/s` (a second press on the same tab collapses) · `]`/`[` on an
empty draft open a collapsed panel · Esc on an empty idle draft collapses an open panel before arming Esc Esc. Bracketed
letters in the strip are **labels, not keys** (TD §3.1). Commands (`registry.ts`, S2 lands S4's rows): `/panel
[d|p|t|s|off|full]` (`inspect`, `any`; plain twin prints the rows) and `/transcript [compact|full]`; `/decisions` unchanged.

### 4.7 Cards (`src/tui/card.ts`, S4)

```ts
export function cardTop(title: string, columns: number, g?: GlyphSet): string;      // `╭─ <title ≤ columns − 6> ─…─╮`; '' → `╭──…──╮`
export function cardRow(text: string, columns: number, g?: GlyphSet): string;       // `│ ` + fitCells(text, columns − 4) + ` │`
export function cardBottom(columns: number, g?: GlyphSet): string;                  // `╰──…──╯`
export function cardLines(title: string, body: readonly string[], columns: number, g?: GlyphSet): string[];   // body.length + 2 rows
// src/tui/review/lines.ts (S4)
export function reviewCardTitle(req: ConfirmRequest, columns: number, g?: GlyphSet): string;   // `review · step 7 · risk 0.44 (tail) · edit src/a.py "<goal>"`; ≥ 120 adds `(tail on <dim>)`, the full goal, ` · jev <ms>ms`
/** boxed ladder: n ≥ 9 full · 8 drop the ruler · 7 drop matches_intent · 6..4 title edge, keys, n − 3 compact rows, bottom edge · 3 title edge, keys, bottom edge · n ≤ 2 → the flat ladder */
export function reviewCardLines(req: ConfirmRequest, n: number, previewRows: number, columns: number, g?: GlyphSet, note?: ReviewNote | null): string[];
```

Edge colours follow the card's meaning: review `review` (yellow) or `block` (red, bold) by `req.risk.verdict`
(`Review.tsx:105`); follow-up, undo, exit confirm, intake `warn`; blocking `error`; palette `border`. Review card (want
`CAP.reviewCard = 9` + preview): title edge · keys row (`reviewKeys`; the `d` note field replaces it) · ruler · four
gauges · `5 matches_intent` · `k` preview rows indented two cells with the `…[k more preview lines · e expands]` tail ·
bottom edge (H-F1/H-F1w). The cut is a function, never Ink clipping; `resolveKey`, deferral, arming and
`createTuiConfirmer` are untouched. Others: follow-up `followupLines` with round glyphs; exit confirm
`cardLines('exit?', [EXIT_CONFIRM_ROW])`; undo `cardLines('undo', [row])`; blocking `cardLines(firstRow, rest)` ≤ 6;
palette `cardLines('commands', paletteRows(…, 6, W))` ≤ 8 with the footer as the last inner row (mention popup: title
`files`); intake §3.7. Flat tier: every card degrades to today's rows.

### 4.8 Status bar

TD §7.4's three zones are unchanged in text and drop order; boxed → the console's status compartment at width `W`; flat →
the badge leads the left zone (`jev-only · idle`). `StatusLineState` gains `modeBadge?` and `thinking?: ThinkingPhase |
null`; `leftWord` gains, before the `s.run === 'none'` branch, `${spinnerGlyph(o)} ${THINKING_WORDS[s.thinking]}` with
`THINKING_WORDS = { intake: 'thinking', lookup: 'looking', replying: 'replying' }`, `asking` while the `intake` overlay is
up, `• thinking` under reduced motion. `shortHelp` (`lines.ts:374`) returns `''` for `intake` — its card/row lists the keys,
like wizard/follow-up/secret/blocking/undo — and keeps `? help` for `none`, `review` and `exitConfirm` in both tiers (so
the review card's console row still ends `? help`, H-F1). `StatusLine.tsx` is unchanged in the flat tier and unused in the
boxed tier.

### 4.9 Theme: depth detection, palette, glyphs (`theme.ts`, `color-shim.ts`, `glyphs.ts`, S4)

```ts
export type ColorDepth = 0 | 16 | 256 | 24;
/** --no-color / NO_COLOR / TERM=dumb → 0; FORCE_COLOR 3 → 24, 2 → 256, 1 → 16; COLORTERM ∈ {truecolor, 24bit} → 24; TERM_PROGRAM iTerm.app · WezTerm · ghostty · vscode → 24, Apple_Terminal → 256; TERM /-256(color)?$/ or alacritty · xterm-kitty · wezterm · foot → 256; else 16 */
export function colorDepth(opts: ColorEnabledOptions): ColorDepth;        // chalk's supports-color order; a wrong guess only loses fidelity (Ink downsamples #rrggbb); no terminal query ever (A112)
export interface ColorTriple { readonly ansi16: AnsiColor; readonly ansi256?: number; readonly truecolor?: `#${string}` }
export interface ColorSpec { readonly color?: ColorTriple; readonly dimColor?: boolean; readonly bold?: boolean; readonly marker: string }
export type ColorRole = /* existing 12 */ | 'you' | 'assistant' | 'badge' | 'border' | 'borderFocus' | 'code' | 'sweep';
export function textProps(theme: Theme, role: ColorRole, depth: ColorDepth): { color?: string; dimColor?: boolean; bold?: boolean };   // 'cyan' | 'ansi256(117)' | '#7DD3FC' by depth; {} at 0
```

| Role | dark truecolor / 256 / 16 | light | ansi | Marker |
| --- | --- | --- | --- | --- |
| `accent` | `#7DD3FC` / 117 / `cyan` | `#0369A1` / 25 / `blue` | `cyan` | '' (decoration) |
| `badge` | accent, bold | accent, bold | `cyan`, bold | the word |
| `border` | dim | dim | `gray` | the box glyphs |
| `borderFocus` (console while a run is live) | `#38BDF8` / 74 / `cyan` | `#0284C7` / 31 / `blue` | `cyan` | the status word |
| `you` | `#A5B4FC` / 147 / `blueBright` | `#4338CA` / 61 / `blue` | `blueBright` | `[you]` |
| `assistant` | default | default | default | `[jevcode]` |
| `code` | `#E2E8F0` / 254 / `whiteBright` | `#1E293B` / 236 / `black` | `whiteBright` | the fence rows |
| `sweep` (splash head) | `#E0F2FE` / 195 / `whiteBright` | `#075985` / 24 / `blue` | `whiteBright` | — (motion only) |
| existing 12 | 16-colour names unchanged; 256/truecolor twins `#F87171`/203 error, `#FBBF24`/214 warn, `#4ADE80`/114 ok, … | as `theme.ts:87–115` | unchanged | unchanged |

`validateTheme` (`theme.ts:137`) gains: `ansi16` ∈ `ANSI_COLORS`; `truecolor` matches `/^#[0-9a-f]{6}$/i`; `ansi256`
0..255; the `ansi` theme has no `truecolor`/`ansi256` members and never dims; `you`, `badge`, `code` carry a marker. Depth
is computed at mount (`App.tsx:472`) and at `setUi` for `ui.noColor`. No backgrounds (F2). New glyphs (all one cell under
`cellWidth`, `glyphs.ts:344`; no VS16, no emoji; `glyphTwin` maps them so `--ascii` draws `+- jev-only ------ proj -+`):

| Glyph key | Unicode | ASCII | Used by |
| --- | --- | --- | --- |
| `roundTopLeft` `roundTopRight` `roundBottomLeft` `roundBottomRight` | `╭ ╮ ╰ ╯` | `+` | console, cards |
| `teeLeft` `teeRight` | `├ ┤` | `+` | console divider |
| `prompt` | `›` | `>` | composer, wizard field, picker filter |
| `chevronRight` `chevronDown` | `▸ ▾` | `>` `v` | panel strip / header |
| `fence` | `╶` | `-` | code-fence rules |
| `shade3` `shade2` `shade1` | `▓ ▒ ░` | `# + .` | splash sweep head |
| `brand` | `◆` | `*` | brand rule row |

Every new glyph is one cell under `cellWidth` (`glyphs.ts:344`, EAW ambiguous = 1); nothing with VS16, no emoji;
`glyphTwin` picks them up through the pairwise table, so `--ascii` draws `+- jev-only ------ proj -+`.

### 4.10 Frames

Legend: rows above the rule are `<Static>` scrollback (cut with `…` where a terminal would wrap; chat and step rows show
Ink's word-wrapped form); dynamic rows are the rule row and everything below; every dynamic count is inside `rows − 2`.
Every console status row below is `statusLineText(state, columns − 4)` output (the 12-cell sparkline is right-aligned inside
its `jev` segment, hence `jev         ▂▂▁▂`), every rule row `ruleRow`/`panelStrip`/`paneRuleRow` output at the terminal
width; §8.1 S4's frame test rebuilds them and asserts equality. The first-frame frames (H-A1…H-A2w) carry no session meter
and no git zone — both arrive after `resolveConfig` (§5.3).

**H-A1. Splash frame 0 = the first frame (t = 0): the `J` and the sweep head, the console complete with `step 0/–` — argv-only: no `sess`, no `⎇`, no `[config]` item yet, 80×24 (11 dynamic rows; 1 scrollback row above)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ▓▒░
                ██ ▓▒░
                ██ ▓▒░
            ██  ██ ▓▒░
             ████  ▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                                        step 0/–  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-A1w. Splash frame 0, 120×40 (11 dynamic rows; 1 scrollback row above)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ▓▒░
                                    ██ ▓▒░
                                    ██ ▓▒░
                                ██  ██ ▓▒░
                                 ████  ▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                                                step 0/–  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-A2. Splash mid frame (t ≈ 300 ms, frame 6: 42 of 56 cells revealed), 80×24 (11 dynamic rows; 1 scrollback row above)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  █▓▒░
                ██ ██      ██    ██ ██      ██    ██ █▓▒░
                ██ █████   ██    ██ ██      ██    ██ █▓▒░
            ██  ██ ██       ██  ██  ██      ██    ██ █▓▒░
             ████  ███████   ████    ██████  ██████  █▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                                        step 0/–  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-A2w. Splash mid frame, 120×40 (11 dynamic rows; 1 scrollback row above)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ███████ ██    ██  ██████  ██████  █▓▒░
                                    ██ ██      ██    ██ ██      ██    ██ █▓▒░
                                    ██ █████   ██    ██ ██      ██    ██ █▓▒░
                                ██  ██ ██       ██  ██  ██      ██    ██ █▓▒░
                                 ████  ███████   ████    ██████  ██████  █▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                                                step 0/–  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-A3. Splash settled (t = 700 ms) = idle after the splash; the brand row is the rule row; `sess` and the git zone have arrived with `pushSessionSpend`/`useGitHead`, 80×24 (6 dynamic rows; 2 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: typesafe · jev-1.13.0 (pinned) · key TYPESAFE_API_KEY (dotenv…
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-A3w. Idle after the splash, 120×40 (6 dynamic rows; 2 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: typesafe · jev-1.13.0 (pinned) · key TYPESAFE_API_KEY (dotenv:/Users/me/proj/.env) · about 110 ms per…
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                            step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-B2. A chat exchange (`hello_first`; the reply wraps with a hanging indent) in jev-only, 80×24 (6 dynamic rows; 6 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting

[you] hi

[jevcode] Hi. I'm ready when you are — describe a change you want in proj, or
          ask what I can do.
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-B2w. The same exchange, 120×40 (6 dynamic rows; 5 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting

[you] hi

[jevcode] Hi. I'm ready when you are — describe a change you want in proj, or ask what I can do.
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                          step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  jev         ▂▂▁▂  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-C1. A question about the tool: three facts selected by Jev (`about_what_it_is` 0.91, `about_mode_now` 0.77, `about_switch_mode` 0.62), one item each, 80×24 (6 dynamic rows; 10 scrollback rows above)**

```
[you] what can you do?

[jevcode] JevCode is a coding agent where Jev, a decision model, makes every
          decision: what kind of step comes next, which files matter, how risky
          an action is, whether a step worked. In jev-only mode code proposes
          fixes and tests verify them; in jev+llm mode Claude writes the code.
[jevcode] Mode: jev-only — no generating LLM; code proposes, Jev decides, tests
          verify.
[jevcode] Switch with /mode jev-on (alias /llm on) or /mode jev-only; it applies
          to the next run. Persist it with jevcode config set mode <m>.
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-C1w. The same reply, 120×40 (6 dynamic rows; 8 scrollback rows above)**

```
[you] what can you do?

[jevcode] JevCode is a coding agent where Jev, a decision model, makes every decision: what kind of step comes next,
          which files matter, how risky an action is, whether a step worked. In jev-only mode code proposes fixes and
          tests verify them; in jev+llm mode Claude writes the code.
[jevcode] Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.
[jevcode] Switch with /mode jev-on (alias /llm on) or /mode jev-only; it applies to the next run. Persist it with
          jevcode config set mode <m>.
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                          step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1?  jev        ▂▂▁▂▂  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-D1. A task run, live, jev-only, panel collapsed (strip on the rule, one `[step N]` line per step), 80×24 (7 dynamic rows; 7 scrollback rows above)**

```
[you] make the failing test pass

[run] start r1 mode=jev-only task: make the failing test pass
[step 1] read tests/test_kth.py, kth.py · risk 0.02 ok · judge 0.71 · 0.9s ·
$0.0004
[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 40p/1f/0e ·
judge 0.52 · 1.6s · $0.0006
─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ──────── [d] [p] [t] [s] ──
synth sieve: tested 37/137 candidates (candidates=137, tested=37)
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Type to steer the next step…  Esc pauses                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⠹ propose [synth]     step 3/40 0m41s  run $0.00/0.25 ok  sess $0.00/1.25 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-D1w. The same run, 120×40 (7 dynamic rows; 5 scrollback rows above)**

```
[you] make the failing test pass

[run] start r1 mode=jev-only task: make the failing test pass
[step 1] read tests/test_kth.py, kth.py · risk 0.02 ok · judge 0.71 · 0.9s · $0.0004
[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 40p/1f/0e · judge 0.52 · 1.6s · $0.0006
─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 · jev 110ms ─────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
synth sieve: tested 37/137 candidates (candidates=137, tested=37)
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Type to steer the next step…  Esc pauses   Esc Esc aborts                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⠹ propose [synth]      step 3/40 0m41s  run $0.00/0.25 ok  sess $0.00/1.25 ok  ⎇ main · 1~  jev ▂▁▂▁▁▂▁▂▁▁▁▂  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-E1. The Jev panel open (6 rows) after run 7 in jev+llm; the `s0 intake` row first, 80×24 (12 dynamic rows; 2 scrollback rows above)**

```
[run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
[ui] stopped — max_steps (exit 4) · raise: /budget max-steps 14, then /resume
─── ▾ decisions s7 · c~ derived |2p−1| ──── [d]ecisions [p]lan [t]ime [s]ynth ──
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen
s7 risk     destructive      L1          █████████·  0.90  c 0.93   [ok]
s7 risk     plan_mismatch    L2          ████▍·····  0.44  c 0.61   [review]
s7 judge    succeeded        noul        ████████▉·  0.89  c 0.78~
s7 complete task_complete    noul        ██████▊···  0.68  c 0.36~
  … 8 more rows · /panel full expands
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4   step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-E1w. The panel open, 120×40 (12 dynamic rows; 2 scrollback rows above; rows gain `latencyMs` and `consumedBy`)**

```
[run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
[ui] stopped — max_steps (exit 4) · raise: /budget max-steps 14, then /resume
─── ▾ decisions s7 · c~ derived |2p−1| ───────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
s0 intake   intake           coding_task ███████▊··  0.78  c 0.72   chosen     118ms  resolveChoice → run floor 0.60 → …
s7 risk     destructive      L1          █████████·  0.90  c 0.93   [ok]       244ms  band 0.3/0.7 (expected)
s7 risk     plan_mismatch    L2          ████▍·····  0.44  c 0.61   [review]   244ms  band 0.3/0.7 (tail)
s7 judge    succeeded        noul        ████████▉·  0.89  c 0.78~             198ms  reported
s7 complete task_complete    noul        ██████▊···  0.68  c 0.36~             198ms  ≥ 0.85 → stop
  … 8 more rows · /panel full expands
╭─ jev+llm ───────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4                           step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-F1. The review card with 4 preview rows, composer collapsed, 80×24 (19 dynamic rows; 1 scrollback row above)**

```
[step 6] run $ pytest -q tests/test_a.py · risk 0.03 ok · tests 40p/1f/0e · jud…
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] ──────────── [d] [p] [t] [s] ──
╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py "make parse_date timez… ─╮
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)     │
│ 1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…  │
│ 2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task a… │
│ 3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification… │
│ 4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restora… │
│ 5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of…  │
│   --- old                                                                    │
│   return datetime.strptime(s, FMT)                                           │
│   +++ new                                                                    │
│   return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)              │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › (review pending — keys in the card; d opens a note)                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ review       step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-F1w. The review card, 120×40 (19 dynamic rows; 1 scrollback row above; `P(l) E[k] tail` columns, full goal and `jev 244ms` in the title)**

```
[step 6] run $ pytest -q tests/test_a.py · risk 0.03 ok · tests 40p/1f/0e · judge 0.61 · 2.4s · $0.031
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 · jev 244ms ──── [d]ecisions [p]lan [t]imeline [s]ynth ─────
╭─ review · step 7 · risk 0.44 (tail on plan_mismatch) · edit src/a.py "make parse_date timezone-aware" · jev 244ms ───╮
│ [y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline         [ctrl-c] abort run │
│ dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k… │
│ 1 destructive  L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recover… │
│ 2 out_of_scope L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]`/`task` a… │
│ 3 plan_mismatch L2 ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step                │
│ 4 irreversible L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git c… │
│ 5 matches_intent   ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent `edit`   │
│   --- old                                                                                                            │
│   return datetime.strptime(s, FMT)                                                                                   │
│   +++ new                                                                                                            │
│   return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)                                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › (review pending — keys in the card; d opens a note)                                                                │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ review                               step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-G1. The mode badge after `/mode jev-on` with a generator key configured, 80×24 (6 dynamic rows; 3 scrollback rows above)**

```
[you] /mode jev-on
[ui] mode jev+llm from the next run — Claude writes the code, Jev still decides
every step (persist: jevcode config set mode jev-on)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev+llm · next run ────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-G1w. The same, 120×40 (6 dynamic rows; 3 scrollback rows above)**

```
[you] /mode jev-on
[ui] mode jev+llm from the next run — Claude writes the code, Jev still decides every step (persist: jevcode config set
mode jev-on)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev+llm · next run ────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                    step 0/–  sess $0.00/1.25 ok  ⎇ main  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-H2. `/mode jev-on` with no generator key: the wizard's generator-key step inside the console (after `1` on the provider step); the session meter is already up; Enter saves and the badge flips, 80×24 (8 dynamic rows; 1 scrollback row above)**

```
[you] /mode jev-on
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ setup · generator key ─────────────────────────────────────────────── proj ─╮
│ Anthropic API key (ANTHROPIC_API_KEY)                                        │
│ › ••••••••••••••••••••                                                       │
│ 20 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back     │
├──────────────────────────────────────────────────────────────────────────────┤
│ setup                                           step 0/–  sess $0.00/1.25 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-H2w. The same, 120×40 (8 dynamic rows; 1 scrollback row above)**

```
[you] /mode jev-on
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ setup · generator key ─────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ Anthropic API key (ANTHROPIC_API_KEY)                                                                                │
│ › ••••••••••••••••••••                                                                                               │
│ 20 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back                                             │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ setup                                                                           step 0/–  sess $0.00/1.25 ok  ⎇ main │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-I1. The intake card (`ambiguous`): `run this as a task?` above the collapsed composer, status word `asking`, no `? help` (the card lists the keys), 80×24 (9 dynamic rows; 3 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting

[you] the date parsing
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ run this as a task? ────────────────────────────────────────────────────────╮
│ [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)    │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › (waiting for y/n)                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ asking                                          step 0/–  sess $0.00/1.25 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**H-I1w. The same card; the title quotes the message at ≥ 100 inner cells, 120×40 (9 dynamic rows; 3 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting

[you] the date parsing
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ "the date parsing" — run this as a task? ───────────────────────────────────────────────────────────────────────────╮
│ [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)                                            │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › (waiting for y/n)                                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ asking                                                                  step 0/–  sess $0.00/1.25 ok  ⎇ main · 3~ 1? │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**H-J1. The flat tier (rows < 16): the one-row intake twin over `› (waiting for y/n)`, the badge leading the status left zone, 80×12 (4 dynamic rows; 1 scrollback row above)**

```
[you] the date parsing
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
run this as a task?  [y] run it  [n] just chatting  Esc keeps the text
› (waiting for y/n)
jev-only · asking                                   step 0/–  sess $0.00/1.25 ok
```

**H-J2. The flat tier idle after startup: brand row, bare `›` row, `jev-only · idle` status, 80×12 (3 dynamic rows; 2 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting
[config] decider: typesafe · jev-1.13.0 (pinned) · key TYPESAFE_API_KEY (dotenv…
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
› Say hi, ask a question, or describe a task…
jev-only · idle                             step 0/–  sess $0.00/1.25 ok  ? help
```

---

## 5. Startup splash (A §8)

### 5.1 Wordmark and signatures

Seven 5-row block letters on a 56-cell grid, two-tone (`JEV` in `accent`, `CODE` in `dim`), centred at `⌊(columns − 56) / 2⌋`
when `columns ≥ 64`, else the one-line brand row carries the splash; `--ascii` uses `#`; a screen reader never sees it.
**Every one of the five `WORDMARK` strings is padded with blanks to exactly 56 cells** (invisible in the listing below, whose
rows 2–4 would otherwise measure 51, 54 and 51): the reveal edge `⌈56 · t / 400⌉`, the sweep band positions and the
"≤ 10 changed cells per row" bound are all stated on that grid; `splashFrame` computes `spans` on the 56-cell grid and
right-trims each row only afterwards.

```
    ██ ███████ ██    ██  ██████  ██████  ██████  ███████
    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
 ████  ███████   ████    ██████  ██████  ██████  ███████
```

```ts
// src/tui/splash.ts (NEW, pure, S4)
export const SPLASH_MS = 700; export const SPLASH_INTERVAL_MS = 50;   // 20 fps ≤ maxFps 30; 67 ms under SSH (launch.fps 15)
export const WORDMARK: readonly [string, string, string, string, string]; export const WORDMARK_CELLS = 56;   // splash.test.ts: WORDMARK.every((r) => cellWidth(r) === WORDMARK_CELLS)
export type SplashPhase = 'reveal' | 'shimmer' | 'fade' | 'settled';
export interface SplashFrame { rows: string[]; spans: readonly { row: number; from: number; to: number; role: ColorRole }[]; phase: SplashPhase }
export function splashFrame(t: number, columns: number, g?: GlyphSet): SplashFrame;   // exactly CAP.splash rows ≤ columns cells, or [] once settled / when columns < 64
export function brandRow(version: string, columns: number, t: number | null, g?: GlyphSet): string;   // `─── ◆ jevcode 0.2.0 ─────…`; the one-line form pulses `◆` through ░ ▒ ▓ ◆ twice over 400 ms
// src/tui/motion.ts (NEW, S4)
export function useMotion(active: boolean, durationMs: number): { time: number; settled: boolean };
// time = elapsed ms from Ink's useAnimation({ interval: SPLASH_INTERVAL_MS, isActive: active && time < durationMs }); settled = time >= durationMs.
// The subscriber deactivates itself at durationMs (Ink's hook keeps calling setAnimState while isActive is true, use-animation.js) — no tick after 700 ms;
// the App's settle effect dispatches { type: 'splash:done' } in the commit where `settled` first turns true. The third module allowed to drive time.
```

### 5.2 Schedule (phase computed from elapsed time, never from a frame count — a slow terminal skips frames instead of running long)

| Frame | t (ms) | Phase | Change vs the previous frame |
| --- | --- | --- | --- |
| 0 | 0 (first frame) | reveal | columns 0–6 (the `J`) in `accent`; the 3-cell head `▓▒░` at 7–9; the console, badge and `step 0/–` complete in this same frame |
| 1–8 | 50–400 | reveal | the revealed edge advances 7 cells per frame (`⌈56 · t / 400⌉`), the head with it: ≤ 10 changed cells per row |
| 9–11 | 450–550 | shimmer | the wordmark complete; a 6-cell `sweep` band runs left → right once; ≤ 12 changed cells per frame |
| 12 | 600 | fade | `JEV` accent → default (one SGR change per row) |
| 13 | 650 | fade | every letter → `dim` |
| 14 | 700 | settled | `useMotion` reports `settled`; the App's settle effect dispatches `splash:done` in the same commit — never the 1 Hz `tick` (`useEngine.tsx:59`, `:841–845`), which could lag up to ~1 s; `paneWant` reads `splash === 'running' && motion.time < SPLASH_MS`, so no frame ever grants the 5-row slot without wordmark rows (no blank hole between the rule and the console); the rule row becomes the brand row; the subscriber is inactive — nothing ticks |

### 5.3 Rendering path, cancellation, reduced motion

- **Timer and bytes.** One shared `useAnimation` timer, coalesced by Ink's render throttle (`dynamic ≤ maxFps + 1` by
  construction; the `setInterval(` grep gains `useAnimation(` with the same allow-list); 11 rows ≈ 1.0 KB per frame, 15
  frames ≈ 15 KB in 700 ms; content diff ≤ 12 cells per frame.
- **First frame.** Mount with `splash: 'running'`, `mountedAt = now`, pane 5 (boxed) or 0 (flat); the frame carries
  `step 0/–`, so `perf/first-frame.ts` (`SENTINEL = 'step 0/'`) is satisfied by the same frame; zero network. **No session
  meter, no git zone, no `[config]` item** — those arrive with `setUi`/`pushSessionSpend` (`session.ts:2743–2744`, after
  `resolveConfig`, the trust gate and the index fold) and `useGitHead`'s effect (`useGitHead.ts:115–121`), i.e. after the
  first commit (H-A1 vs H-A3; today's measured first frame in `perf/results/latest.json` shows `idle … step 0/–  ? help`
  and nothing else). The probe keeps `JEVCODE_ASSERT_NO_NETWORK=1` and gains `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1`
  (`resolveConfig` or a `.git/HEAD` read before the first stdout write throws), so a regression that pulls config ahead of
  frame 0 fails the probe instead of silently moving the 108–115 ms baseline.
- **Cancel.** `splash: 'done'` on the first `{ type: 'key' }` (top of `handleKey`, `App.tsx:1525`), `run:start`,
  `confirm:request`, any `overlay` change, `blocking:request`, or the settle effect (`useMotion().settled`, §5.2 row 14 — not the 1 Hz `tick`); the key
  still reaches the composer — frame `k + 1` shows the character and no wordmark. `splash.test.ts` (S4): no committed
  frame with `t ≥ 700` has `layout.pane > 0` without wordmark rows; no animation subscriber call after 700 ms.
- **Reduced motion / SR / plain / resize.** `launch.reducedMotion` (`--no-animation` > `JEVCODE_REDUCED_MOTION` >
  `screenReader`; the file key snaps to `done` at `setUi`) or `launch.screenReader` → mount `done` with a static brand
  row; `--plain` has no splash; `--ascii` draws `#` letters with `# + .` heads; below 64 columns the rows vanish and the
  brand row continues from the same elapsed time. The `<Static>` header is unchanged; the splash settles into the brand
  rule row, never into `<Static>`. Never: network, file reads, `<Static>` writes, clears, motion after 700 ms, `rows < 8`.

### 5.4 Brand row

`─── ◆ jevcode 0.2.0 ─────…` (`ruleRow('◆ jevcode 0.2.0', '', columns)`, `glyphs.ts:410`; version from `src/version.ts`),
`◆` and `jevcode` in `accent`, the rest `rule`; the idle rule row until the first `run:ready`, then the panel strip (§4.6).

---

## 6. Contract additions — contract 1.2 (additive, ordered; S1 lands items 1–13 in W0)

Header comment for `src/core/types.ts:9`: `// contract 1.2 (2026-09-21): conversational intake, Jev providers, mode setting,
chat labels per docs/TUI-DESIGN-2.md §6; items 4 and 7 add required fields (every constructor and fake is listed there), item 8 is optional, everything else is optional or a default-preserving widening; CheckpointEnvelope.version stays 1.`

```ts
// 1  UiLabel (types.ts:1100)
export type UiLabel = '[ui]' | '[setup]' | '[config]' | '[sandbox]' | '[you]' | '[jevcode]';
export type ChatLabel = Extract<UiLabel, '[you]' | '[jevcode]'>;
// 2  IntakeKind (new, core)
export type IntakeKind = 'greeting_or_smalltalk' | 'question_about_this_tool' | 'question_about_the_code' | 'coding_task' | 'ambiguous';
// 3  EngineEvent step:end (types.ts:1130) — money for the step summary line; absent → tokens
| { type: 'step:end'; record: StepRecord; costUsd?: { generator: number; jev: number } }
// 4  DeciderConfig (types.ts:1349) — three REQUIRED fields. Builders: config/validate.ts:182 `validateDecider` (the only production constructor); test fakes in test/unit/config/**, test/unit/jev/**, test/fixtures/tui/fixtures.ts.
//    cli/session.ts:1470 and :1793 are `{ model, pinned }` mock stubs in a union with `cfg.decider()` read for `.model` only — they compile unchanged. bench/cli.ts:37 and perf/step-overhead.ts:154 build `deciderModel` (item 8), not DeciderConfig.
export type JevProvider = 'typesafe' | 'openrouter';
export type JevProviderSource = 'flag' | 'env' | `dotenv:${string}` | `file:${string}` | 'auto:base-url' | 'auto:typesafe-key' | 'auto:openrouter-key' | 'default';
export interface DeciderConfig { provider: JevProvider; baseUrl: string; apiKey: string; model: string; pinned: boolean; pricing: { inputUsdPerToken: number; outputUsdPerToken: number }; providerSource: JevProviderSource }
// 5  JevUsage (types.ts:172) — TypeSafe's native response carries no cost
export interface JevUsage { input_tokens: number; output_tokens: number; cost?: number }
// 6  AskResult (types.ts:482)
export interface AskResult { /* existing */ costBasis?: 'provider' | 'table' }
// 7  Decider (types.ts:493) — REQUIRED `provider`; every implementation sets it: src/jev/client.ts (cfg.provider), src/jev/mock.ts ('openrouter'), the fakes in test/unit/bench/helpers.ts, test/unit/loop/**, test/unit/cli/helpers.ts, test/fixtures/tui/fixtures.ts
export interface Decider { readonly model: string; readonly provider: JevProvider; ask(state: Json, questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> }
// 8  EngineOptions.deciderModel (types.ts:988)
deciderModel: { configured: string; pinned: boolean; provider?: JevProvider };   // OPTIONAL — the engine defaults to 'openrouter', so src/bench/cli.ts:37 and src/perf/step-overhead.ts:154 compile untouched and src/bench/** stays read-only
// 9  ResolvedConfig (types.ts:1358)
readonly mode: EngineMode;
// 10 SessionHost.submit (types.ts:1235) — `kind: 'task'` = one-shot argv path (never intake)
export type SubmitOutcome = { became: 'run' | 'chat' | 'nothing' };
submit(text: string, opts: { kind: 'prompt' | 'follow-up' | 'task'; secretSpans: readonly string[]; pinnedFiles: readonly string[] }): Promise<SubmitOutcome>;
// 11 Renderer (types.ts:1303) — optional hooks; every fake keeps compiling
restoreDraft?(text: string): void;   // §3.7 Esc on the intake card
live?(text: string): void;           // §3.6 the LLM turn's streamed text for the live region
// 12 HistoryStore (types.ts:1280)
append(kind: 'prompt' | 'steer' | 'command' | 'chat', text: string): void;
// 13 SessionRef (types.ts:944) — why the run started (run.json, the `s0 intake` row)
intake?: { kind: IntakeKind; probability: number; requestHash: string };
// 14 LaunchSettings (src/config/launch.ts, S1) — argv + env only
modeHint?: EngineMode; reducedMotion: boolean;   // --mode / JEVCODE_MODE; --no-animation > JEVCODE_REDUCED_MOTION > screenReader
// 15 UiAction (src/tui/useEngine.tsx:182, S4)
| { type: 'mode'; mode: EngineMode; pending: EngineMode | null } | { type: 'thinking'; phase: 'intake' | 'lookup' | 'replying' | null } | { type: 'chat-decisions'; rows: readonly DecisionRow[] }
| { type: 'splash:done' } | { type: 'panel'; panel: 'collapsed' | 'open' | 'full' } | { type: 'transcript'; view: 'compact' | 'full' }
// 16 UiState (useEngine.tsx:94, S4)
readonly modeBadge: { mode: EngineMode; pending: EngineMode | null }; readonly thinking: 'intake' | 'lookup' | 'replying' | null; readonly chatRows: readonly DecisionRow[];
readonly splash: 'running' | 'done'; readonly mountedAt: number; readonly panel: 'collapsed' | 'open' | 'full'; readonly transcript: 'compact' | 'full'; readonly turns: number /* runs + chat replies; §4.4 placeholder rule */;
// 17 not core, by owner: TranscriptKind gains 'step' | 'chat' and TranscriptItem.hidden?: boolean (plain.ts, S3) · OverlayKind 'intake', CAP additions (layout.ts, S4) · HistoryKind 'chat' (composer/history.ts, S3)
//    IndexLine | { v: 1; t: string; kind: 'chat'; sessionId: string; intake: IntakeKind; route: ChatRoute; costUsd: number; provider: JevProvider | 'generator' } (session/index.ts, S3)
//    JsonStream line { type: 'chat'; intake: IntakeKind; probability: number; route: ChatRoute; provider: JevProvider | 'generator'; costUsd: number; latencyMs: number; requestHash: string } (json-stream.ts, S3)
//    Prompter.intake?(message: string): Promise<'run' | 'chat' | 'keep'>; Prompter.wizard reason gains 'mode' and `mode: EngineMode` (the target); Renderer.reopenWizard(at, runLive, opts?: { reason: 'login' | 'rejected' | 'mode'; mode?: EngineMode }) (session.ts:246, S3) · CommandAction { kind: 'mode'; mode: EngineMode | null } | { kind: 'panel'; … } | { kind: 'transcript'; … } (dispatch.ts, S2)
//    SettingName 'mode' | 'decider.provider' (config/types.ts, S1) · STRING_FLAGS 'jevProvider' (args.ts, S2) · WizardStep 'jevProvider' (onboarding/reducer.ts, S2)
```

W0: items 1–13 plus the fakes (`test/unit/bench/helpers.ts`, `test/fixtures/tui/fixtures.ts`, `test/unit/provider/helpers.ts`, `src/jev/mock.ts`); `tsc --strict` green before W1.

---

## 7. Module map — six slots, disjoint files, waves

### 7.1 Slots

| Slot | Owns (new unless marked edit) | Sections |
| --- | --- | --- |
| **S1 providers + contract** | `src/core/types.ts` (edit, §6 items 1–13), `src/jev/**` (`providers.ts` new; `client.ts`, `validate.ts`, `types.ts`, `mock.ts` edit incl. §3.13), `src/config/**` (`defaults.ts` rows `mode` + `decider.provider`; `resolve.ts` `resolveMode` + provider resolution; `validate.ts`; `types.ts`; `launch.ts` `modeHint`/`reducedMotion`; `credentials.ts` `jevProvider`; `ui.ts`), `src/cli/config-table.ts`, `src/loop/engine.ts` (edit: `checkModelDrift`, `deciderModel.provider`, `step:end.costUsd`), `test/live/jev*.live.test.ts`, `test/unit/jev/**`, `test/unit/config/**` **except** `args.test.ts` and `login.test.ts` (S2), `test/unit/cli/config-table.test.ts`, `test/unit/loop/**`, `test/unit/bench/helpers.ts`, `test/fixtures/tui/fixtures.ts`, `test/unit/provider/helpers.ts` | §1.2, §2, §6 |
| **S2 defaults + mode + wizard** | `src/cli/args.ts`, `src/cli/main.tsx`, `src/cli/login.ts`, `src/tui/onboarding/**`, `src/tui/commands/{registry,dispatch,parse}.ts`, `scripts/gen-docs.mjs` (regen of `docs/COMMANDS.md`, `docs/KEYS.md`, `man/jevcode.1`, completions), `test/unit/tui/onboarding/**`, `test/unit/tui/commands/**`, `test/unit/tui/wizard.test.tsx`, `test/unit/cli/main.test.ts`, `test/unit/config/args.test.ts`, `test/unit/config/login.test.ts` | §1.1, §1.3, §1.4 |
| **S3 intake + chat** | `src/chat/**` (new: `intake.ts`, `replies.ts`, `facts.ts`, `lookup.ts`, `llm-turn.ts`, `lines.ts`, `bubbles.ts`, `ledger.ts`), `src/cli/session.ts`, `src/cli/json-stream.ts`, `src/cli/tui-prompter.ts`, `src/tui/plain.ts`, `src/tui/plain-composer.ts`, `src/tui/composer/history.ts`, `src/tui/budget/lines.ts`, `src/tui/why.ts`, `src/session/index.ts`, `test/unit/chat/**`, `test/unit/cli/**` **except** `main.test.ts` (S2) and `config-table.test.ts` (S1), `test/unit/session/**`, `test/unit/tui/plain*.test.ts`, `test/unit/tui/plain-composer.test.ts`, `test/unit/tui/why.test.ts`, `test/live/intake.live.test.ts` | §3, §4.5 step line |
| **S4 visual components** | `src/tui/{App,Overlay,Review,Pane,Picker,StatusLine,Transcript,Console}.tsx`, `src/tui/composer/Composer.tsx`, `src/tui/{theme,color-shim,layout,glyphs,splash,motion,console,card,index}.ts`, `src/tui/useEngine.tsx`, `src/tui/status/lines.ts`, `src/tui/pane/**`, `src/tui/review/lines.ts`, `src/tui/keys/**`, `src/tui/onboarding/Wizard.tsx` rendering hooks excluded (S2 owns the file; S4 passes `ConsoleProps.wizard`), `test/unit/tui/**` **except** `onboarding/**`, `commands/**`, `wizard.test.tsx` (S2) and `plain*.test.ts`, `plain-composer.test.ts`, `why.test.ts` (S3) — every test file has exactly one owner | §1.5, §4, §5 |
| **S5 pty + perf + docs** | `test/pty/**`, `src/perf/**` (`intake-latency.ts` new), `perf/drivers/**`, `README.md`, `docs/TUI.md`, `docs/STATUS.md`, `CHANGELOG.md`, `docs/DECISIONS.md` (§11 entries) | §8.2, §9 |
| **S6 live verification** | `docs/live/tui/round-2/**` (steps, captures, README, timing) | §8.3 |

### 7.2 Shared files: single owner and the requests other slots send

| File | Owner | Request from | What |
| --- | --- | --- | --- |
| `src/core/types.ts` | S1 | S3 (items 1, 2, 10–13), S4 (items 3, 15–16 are S4's own files; item 3 is S1's engine) | §6 verbatim; W0 |
| `src/config/defaults.ts`, `resolve.ts`, `launch.ts` | S1 | S2 (`mode` row, `resolveMode`, `modeFromParsedFlags` fallback, `modeHint`), S4 (`reducedMotion`) | §1.2, §5.3 |
| `src/cli/args.ts` | S2 | S1 (`jevProvider` flag + `FLAG_SPECS` row) | §2.3 |
| `src/cli/login.ts` | S2 | S1 (`--jev-provider`, provider-keyed `verifyKeys`) | §2.7 |
| `src/cli/session.ts` | S3 | S2 (`case 'mode'`, `runLogin('mode', m)`, `MODE_*` strings, `/jev` line 1), S1 (`/jev` provider line, `[config] decider:` item), S4 (`extras.dispatch` of `mode`/`thinking`/`chat-decisions`) | §1.3, §2.6, §3.8 |
| `src/tui/commands/registry.ts`, `dispatch.ts` | S2 | S4 (`/panel`, `/transcript` rows and actions) | §4.6 |
| `src/tui/plain.ts` | S3 | S4 (`'step'` kind, `stepSummaryText`, `itemsFromEvent` `step:end`, `hidden?`) | §4.5 |
| `src/tui/useEngine.tsx` | S4 | S3 (`thinking`, `chat-decisions`, `chatRows`), S2 (`mode` action semantics) | §6 items 15–16 |
| `src/tui/layout.ts`, `Overlay.tsx` | S4 | S3 (`'intake'` overlay: `COLLAPSING`, want 3/1, the card from `src/chat/lines.ts`) | §3.7 |
| `src/tui/keys/**` | S4 | S3 (the S5 `intake` key sub-row; Ctrl-C ×1 while `thinking`) | §3.1 rows 9–11 |
| `src/tui/App.tsx` | S4 | S3 (`SubmitOutcome` history rule, `thinking` dispatch, `restoreDraft`, `live`) | §3.8 |
| `src/jev/mock.ts` | S1 | S3 (§3.13 heuristics, `JEVCODE_MOCK_INTAKE`, `JEVCODE_MOCK_JEV_MS`) | §3.13 |
| `src/tui/budget/lines.ts` | S3 | S1 (`costBlock` basis suffix) | §2.4 |
| `src/tui/onboarding/**` | S2 | S4 (console titles `setup · <step>`, `›` masked row via `glyphs.prompt`) | §1.4, §4.3 |
| `src/cli/tui-prompter.ts` | S3 | S2 (`wizard()` passes `reason`, `mode: target`, `jevProvider`; `reason === 'mode'` → `reopenWizard('provider', runLive, { reason: 'mode', mode })`; default mode `'jev-only'`, was `'jev-on'`) | §1.4 |
| `src/cli/login.ts` (`commandLogin`) | S2 | S1 (`jevProvider` in `CredentialsPatch`, provider inference by §2.3 rules 2a–2d) | §1.4, §2.3 |
| `test/pty/**` | S5 | S3, S4 (new sentinels: placeholders, `[you]`, `[jevcode]`, `jev-only`) | §8.2 |

A request is a diff in the owner's slot notes with the section number, landed in the owner's next PR. `src/synth/**` and `src/bench/**` are read-only.

### 7.3 Waves

**W0** S1: `types.ts` items 1–13 + fakes + `providers.ts` skeleton, `tsc --strict` green. **W1** (parallel, pure,
offline): S1 providers/config/client; S2 args/registry/onboarding; S3 `src/chat/**`, `plain.ts`, `history.ts`; S4
`layout`, `card`, `console`, `splash`, `theme`, `status/lines`, `pane/model`, `review/lines`, `glyphs`. **W2**: S1 engine +
mock; S3 `session.ts`, `json-stream`, `tui-prompter`, `session/index`; S4 `useEngine`. **W3**: S4 `App`, `Console`,
`Transcript`, `Overlay/Review/Pane`, `Composer`, `keys`; S2 `Wizard.tsx`, `main.tsx`, `login.ts`, gen-docs. **W4**: S5 pty
+ perf + docs; S6 live on both providers. No paid call in any unit or pty test.

---

## 8. Tests

### 8.1 Unit (vitest `unit`, offline; the §19.0 sync test extends to `src/chat/**`)

| Owner | File | Asserts |
| --- | --- | --- |
| S1 | `test/unit/jev/providers.test.ts` | `JEV_PROVIDERS` table; `isPinnedJevModel` (`jev-1.13.0` pinned on typesafe, alias on openrouter; `-20260917` pinned on openrouter, rejected by `validateDecider` on typesafe); `jevModelMatches` (`jev-latest` → `jev-1.13.0`; `jev-1.13` → `jev-1.13-20260917` on openrouter only, rejected offline by `validateDecider` on typesafe; `jev-1.1` ↛ `jev-1.13.0`); `providerForHost`; `EQUIVALENT_IDS` |
| S1 | `test/unit/jev/client.test.ts` (ext.) | typesafe headers (no referer); `x-typesafe-request-id` captured/redacted/clipped; `detail.message` hint; 400 `Unknown model` → `ConfigError` without retry and no meter add; 422 non-retryable; cost `input × 4.2e-8` with `costBasis 'table'` when absent, `'provider'` when present |
| S1 | `test/unit/config/resolve.test.ts` (ext.) | the auto table of §2.3 (`JEV_API_KEY` → openrouter; `TYPESAFE_API_KEY` → typesafe; both → openrouter only with `JEV_API_KEY`; base URL host wins); `mode` chain and default `jev-only`, file `mode: jev-on` → source `file:`, cap default $2.00 (§1.2); key order (`--jev-provider typesafe` + `JEV_API_KEY` + `TYPESAFE_API_KEY` → `TYPESAFE_API_KEY`; `JEV_API_KEY` + `OPENROUTER_API_KEY` auto → `JEV_API_KEY`); `OPENROUTER_API_KEY` resolved under typesafe → `ConfigError`; configured base URL of the other host → `ConfigError` (§2.3 rows 3–4); `TYPESAFE_API_KEY` in `env` + `--jev-provider openrouter` → `redact()` masks it (§2.3 Redaction); provider-keyed defaults; `record()` rows of §2.6 |
| S1 | `test/unit/jev/mock.test.ts` (ext.) | §3.13 heuristics per message class; `JEVCODE_MOCK_INTAKE` |
| S2 | `test/unit/tui/onboarding/reducer.test.ts` (ext.) | jev-only detect → `jevProvider` when no provider inferred, else `jevKey`; `reopen` with `reason: 'mode'` → step `provider`, `providerShown: true`, title `jev+llm needs a generator. Pick the provider:`, `mode` = the target; `cancel` under reason `mode`/`login` → `done`, never `exit` (idle `/mode jev-on` → Ctrl-C → session continues, exit code untouched); `save-failed` under reason `mode` → `generator.apiKey`; `SaveRequest.jevProvider` only when shown |
| S2 | `test/unit/config/login.test.ts` (ext.) | `--jev-provider` written as `jevProvider` next to `jevApiKey`; `--jev-key-stdin` without a provider: inferred from env (rules 2a–2d), else TTY prompt / piped stdin → exit 2 `jevcode login: pass --jev-provider typesafe|openrouter with --jev-key-stdin`; `fixBlockLines('jev-only')` contains `--jev-provider typesafe --jev-key-stdin` |
| S3 | `test/unit/cli/tui-prompter.test.ts` (ext.) | `wizard({ reason: 'mode', mode: 'jev-on' })` → `reopenWizard('provider', runLive, { reason: 'mode', mode: 'jev-on' })`; `reason: 'missing'` → `openWizard` with mode `jev-only` by default |
| S2 | `test/unit/tui/commands/{registry,parse,dispatch}.test.ts` | `/mode` no-arg, `/llm on|off` mapping, `/panel …`, `/transcript …`; `docs/COMMANDS.md` sync |
| S2 | `test/unit/config/args.test.ts` | `--jev-provider` enum; `--mode` help text; `modeFromFlags([]) === 'jev-only'` |
| S3 | `test/unit/chat/intake.test.ts` | question snapshot (every Choice has `none_of_these`; **every Choice option's criteria is `{ definition, examples ≥ 2 }`** — intake and reply; every Noul has definition + ≥ 2 examples both sides; keys pass `KEY_SHAPE`); `llmAnswerAllowed` table (jev-only → false; chosen 0.5 → true; fallback 0.7 with paired 0.4 → false; paired 0.6 → true); `routeOf`; state bounds; `resolveIntake` table (0.61 → run, 0.59 → ambiguous, `overridden` → ambiguous, escape → ambiguous, `near` 0.57–0.63); `chatKindAfterNo`; `[measured]` ≤ 5 ms p95 over 1,000 builds; token estimate < 3,000 |
| S3 | `test/unit/chat/{replies,facts,lookup,llm-turn,lines,bubbles,ledger}.test.ts` | 14 rows, unique keys, templates ≤ 160, no emoji, `fillReply` incl. `<runsDir>` from the input; `buildFactQuestions(harnessFacts(fixture))` builds without throwing for every fixture; every path in a text derives from the input; `how_to_task` suffix by `nextMode`; no key material in any fact text for a keyed fixture; `selectFacts` ≥ 0.5 / top-2 / ≤ 4; `rankCandidates` ≤ 1 ms over 20,000, denylist dropped, ≤ 3 lines ≤ 120 cells; `buildChatRequest` no tools, temperature null, ≤ 6 turns, system prompt literal, tool call dropped; `intakeRowLines` at 40/80/100/120 (the three flat forms of §3.7) + ascii + SR; bubbles redacted at emission and split per line (§3.10); identity rule of §3.10; ledger stats |
| S3 | `test/unit/cli/session-chat.test.ts` | scripted fake decider: `hi` → one `[you]` + one `[jevcode]`, no `run:start`, meter +cost, history `chat`, `--json` `chat` line; `fix the test` → `run:start`; ambiguous → `Prompter.intake`, `keep` restores the draft; cap reached → refusal, zero requests; unreachable → retry bubble, zero runs; `kind: 'task'` skips intake; `hi`, `hi`, then a task → `run.json`/index session total includes both intakes and the meter object is identical across `run:start` (`setCap`, §3.9); abort during intake or lookup → no bubble, toast only, `became: 'nothing'`; provider 500 during the LLM turn → `LLM_UNREACHABLE` bubble, meter unchanged; `ConfigError` from `config.generator()` → `[ui] error: config:` only; weak code question under jev+llm → lookup + `LLM_FLOORED_HINT`, zero generator calls; no key → wizard saves → `hi` gets a reply with zero config errors (§3.8 re-read); `route` in the `chat` index and `--json` lines |
| S3 | `test/unit/tui/plain.test.ts` (ext.) | `stepSummaryText` (full, interrupted, jev-only cost, cuts); the plain renderer prints `step` and every stage line; `[you]`/`[jevcode]` items |
| S4 | `test/unit/tui/layout/layout.test.ts` (ext.) | sweep gains `chrome ∈ {0, 3}` and `gate ∈ {0, 1}`; new invariants of §4.2; `consoleTop`/`composerTop`; **`readFrames` v2**: a second `DESIGN2 = docs/TUI-DESIGN-2.md` path, id regex `^\*\*(H-[A-Z0-9]+w?)\.\s+(.*)$` beside today's `F-` regex, the same caption grammar (`W×H (D dynamic rows; S scrollback rows above)`); asserts the id list is exactly `H-A1 H-A1w H-A2 H-A2w H-A3 H-A3w H-B2 H-B2w H-C1 H-C1w H-D1 H-D1w H-E1 H-E1w H-F1 H-F1w H-G1 H-G1w H-H2 H-H2w H-I1 H-I1w H-J1 H-J2` (24), and per frame: every row ≤ W cells; rows starting with `╭ │ ├ ╰` (console and cards) exactly W; the rule row exactly W; `dynamic ≤ rows − 2`; `body.length === dynamic + scrollback`; and (the twin test of finding 2) every console status row equals `│ ` + `statusLineText(frameState(id), W − 4)` + ` │` and every rule row equals `panelStrip`/`paneRuleRow`/`brandRow` for the frame's state, so the drawings cannot drift from the functions again |
| S4 | `test/unit/tui/cursor.test.tsx` | cursor `y` = `composerTop(layout) + row` for idle (`consoleTop + 1`), gate up (`consoleTop + 2`), a 3-row draft on row 2 (`consoleTop + 3`), flat tier (today's values) |
| S4 | `test/unit/tui/{console,card,splash,theme,glyphs}.test.ts` | every row exactly `columns` cells for 40..400; `consoleLines().length === body + gate + 4`; `cardLines().length === body + 2`; `splashFrame(t)` 5 rows (0 at < 64 / t ≥ 700), monotone reveal, ≤ 12 changed cells per 50 ms; `WORDMARK.every((r) => cellWidth(r) === 56)`; no committed frame with `t ≥ 700` has `layout.pane > 0` without wordmark rows; no `useAnimation` subscriber call after 700 ms (fake timers); ≤ 15 frames in 700 ms; `colorDepth` truth table; `textProps` by depth; `validateTheme` rejections; new glyphs one cell, `--ascii` twins |
| S4 | `test/unit/tui/{reducer,app,transcript,status/lines,pane/model,review/lines,overlay,composer}.test.*` (ext.) | every splash cancel row flips `splash` once and the settle effect flips it at 700 ms without a `tick`; `mode`/`thinking`/`chat-decisions`/`panel`/`transcript`/`turns`; idle `/mode jev-on` → badge `jev+llm · next run`, `run:start` → `jev+llm`; a hidden-only batch leaves the `<Profiler>` commit count and `frames().length` unchanged; `PANEL_WIDE_COLUMNS`: strip and header short at 100 and 119, long at 120; placeholder `task` before the first turn, `followup` after a chat reply; first frame contains `step 0/` and the `J` column; a key at t = 100 ms removes the wordmark and shows the character in the same frame; reduced motion mounts with the brand row; `compact` subsequence rule; identity in `full`; badge words and ` · next run`; strip drop order; `open` newest 5 + more row; boxed ladder n = 9..2; review invariants in the boxed tier; placeholders verbatim; `?`/F1 help |

### 8.2 pty (`test/pty/smoke/*.steps` + `test/pty/chat.pty.test.ts`, `--mock`, S5)

| Scenario | Steps | Gates |
| --- | --- | --- |
| `chat-hi.steps` (24×80) | `expect Say hi` → `send hi\r` → `expect \[you\] hi` → `expect \[jevcode\] Hi\.` → `expect jev-only` → `/exit` | exit 0; 0 clears; `restores=1`; **no `[run] ready`**; wall Enter → `[jevcode]` ≤ 1.5 s (`mark` pairs in timing.jsonl) |
| `chat-facts.steps` | `send what can you do?\r` → `expect \[jevcode\] JevCode is a coding agent` → `expect Mode: jev-only` | no run |
| `chat-task.steps` (today's `chat-run-exit`) | `fix the failing test` → `expect \[step 1\]` → `expect end (complete\|max_steps)` → `expect Follow-up, question` | run dir + `jevcode.log`; the stage rows are absent from the capture (compact) |
| `chat-ambiguous.steps` | `JEVCODE_MOCK_INTAKE=ambiguous`; `send the date parsing\r` → `expect run this as a task\?` → sleep 0.25 → `send n` → `expect \[jevcode\]`; second scenario `send y` → `expect ready` | Enter before the arm never answers |
| `mode-switch.steps` | home with only a Jev key: `send /mode jev-on\r` → `expect Pick the provider` → Ctrl-C → `expect mode stays jev-only`; with `ANTHROPIC_API_KEY`: `expect jev\+llm from the next run` → `expect jev\+llm · next run` | badge in the top edge |
| `splash.steps` / `splash-reduced.steps` | `expect step 0/` → sleep 0.1 → `send h` → `expect › h`; wordmark rows (`████`) absent after the key; reduced: no `███` anywhere | 0 clears; first frame < 300 ms |
| `panel.steps` | after a run: `send /panel\r` → `expect ▾ decisions` → `expect more rows` → `send /panel off\r` → `expect ▸ jev` | ≤ 6 pane rows |
| `chrome-tiers.steps` (24×80 → 12×60 → 24×80) | boxed rows vanish and return | clears ≤ 1 in the shrink segment |
| `review-y.steps`, `review-d.steps` (ext.) | `expect ╭─ review` in the boxed tier | invariants unchanged |

Existing steps and probes move to the new strings (`expect Describe the task` → `expect Say hi`; `expect Follow-up or /command` → `expect Follow-up, question`; `expect > half a thought` → `expect half a thought`; `test/pty/helpers.ts` `CHAT_OPEN`/`EXIT_IDLE`; `src/perf/{states,render-lag,composer-latency}.ts`).

### 8.3 Live (S1 + S3 suites, S6 scenario; paid; once per provider before merge; tables into `docs/STATUS.md`)

`test/live/intake.live.test.ts`: 14 messages (`hi`, `thanks, that worked`, `you there?`, `what can you do?`, `which mode
is this?`, `how much has this cost?`, `where is the date parsing?`, `why does test_parse_date fail?`, `fix the failing
test in utils/dates.py`, `add a --dry-run flag to the cli`, `run the tests`, `also update the CHANGELOG`, `the date
parsing`, `tests?`); expected kinds for the first twelve, `ambiguous`-or-question tolerated for the last two; asserts
≥ 11 of 12 match and **no unambiguous non-task message resolves `coding_task`**; prints the confusion table, p50/p95 and
cost per provider (≈ $0.001). S6 (`docs/live/tui/round-2/`): `live-round2-typesafe.steps` and
`live-round2-openrouter.steps` (`JEV_PROVIDER` per run), each: first frame (`mark first-frame`), splash, `hi` (`mark
hi-sent` → `expect \[jevcode\]` → `mark hi-reply`), `what can you do?`, a real task on `examples/demo-py` with reviews
answered by the driver, `/jev` (`expect typesafe · api.typesafe.ai` / `openrouter · openrouter.ai`), `/mode jev-on`,
`/exit`; the README records the intake wall times from `timing.jsonl` (p95 across both providers against the 1.5 s
gate), cost, and the redactor check that no key byte is in any artefact, like `docs/live/tui/README.md`.

---

## 9. Gates (D-E, unchanged, plus two)

| Gate | Threshold | Kept by | Evidence |
| --- | --- | --- | --- |
| first frame (`chat`, `run`); **splash first frame** | cold p95 < 300 ms; zero network; the first frame **is** splash frame 0 | frame 0 = splash frame 0 + console; `modeHint`/`reducedMotion` are argv + env | `perf/first-frame.ts` at 40×120, 24×80, 8×40 with `JEVCODE_ASSERT_NO_NETWORK=1`; `splash.steps` |
| zero clears after the first frame outside shrink segments | 0 | no alt screen; region bounded by `computeLayout` incl. chrome; the splash shrink is a height decrease | `render-lag.ts` `CLEAR_RE`; `states.ts` scenarios `review-card`, `palette-card`, `wizard-console`, `intake-card`, flat `review` at 12×60; `chrome-tiers.steps` |
| lag p95 net < 5 ms | at `JEVCODE_MOCK_STEP_MS=200` | one `<Static>` commit per step instead of ~7, and hidden batches never dirty `<Static>` (§4.5, so renders drop with the bytes); ≈ 4 splash frames (t ≤ 700 ms) fall inside the gated window after the probe's 500 ms warm-up (`render-lag.ts:21–22`) | `render-lag.ts` rows 40/12/reduced |
| composer keystroke → frame | p95 < 16 ms | the console adds 4 fixed rows; a key during the splash cancels it in the same commit | `composer-latency.ts` idle/live/palette |
| dynamic fps | ≤ maxFps + 1 | the splash ticks through Ink's `useAnimation` at a 50 ms interval — ≤ 15 frames in 700 ms by construction (`splash.test.ts`) | `render-lag.ts` gains a `splash` bucket: `framesPerSecondByClass(frames, …, 0, SPLASH_MS)` over the first 700 ms, reported and gated at `maxFps + 1` beside the typing-window bucket (`:287–290`); `perf/results/latest.json` is re-baselined once S4 lands |
| line identity | `transcript.log` / `--plain` / TUI | **the predicate**: (a) in `full`, after `stripAnsi` and dropping the blank spacer rows, the TUI rows equal `formatTranscriptItem(item)` per item, word-wrapped at the commit width with a hanging indent of `label.length + 1` cells, except lines matching `/^```\w*$/`, which render as the fence rule `╶──── <lang>` / `╶────`; (b) in `compact` (default) the TUI rows are the subsequence of `transcript.log` selected by `TranscriptKind` (§4.5); (c) `--plain` = `full`, byte for byte; `transcript.log` and `--plain` stay identical to each other. Chat items one per line | `app.test.tsx:299` mounted with `transcript: 'full'`, asserting the wrapped form (`wrapLike(formatTranscriptItem(item), width, label.length + 1)`) instead of `toContain`; a compact-subsequence test; a fence fixture (`transcript.test.tsx`); `plain.test.ts` |
| no new runtime dependency | `dependencies` empty | cli-boxes glyphs copied as literals | `pack:check` |
| keys never in logs | — | wizard rows `maskedFieldRow(length)`; `intake …` log line carries no message; redaction of `TYPESAFE_API_KEY` | onboarding tests; `session-chat.test.ts` |
| review invariants | only `y` approves; Enter inert; no default | drawing-only change | `app.test.tsx:342–461`; `review-y/d.steps` |
| **intake reply wall time** | **p95 < 1.5 s live**, ≤ 40 ms mock | one request, ≤ 1,650 tokens, no sequential requests for a greeting or a tool question | `intake.live.test.ts`, S6 `mark` pairs, `intake-latency.ts` |
| rows − 2 at every geometry | `total ≤ budget` | `computeLayout` invariants with `chrome` | `layout.test.ts`; `height.test.tsx` at 12/16/24/40 |

---

## 10. Deviations

### 10.1 From `docs/TUI-DESIGN.md`

| TD | Deviation | Why |
| --- | --- | --- |
| §1 / `resolve.ts:312` default `jev-on` | default `jev-only`; `mode` is a setting | D-A |
| §24 placeholders `Describe the task…   / commands · @ files · ? help · Enter runs`, `Follow-up or /command…   Enter runs · …` | §4.4's shorter placeholders; `? help` lives in the status right zone only | D-D "why is it so crowded" |
| §4.3 prompt `> ` | `› ` (`> ` ascii and `--plain`) | D-D; identical cell width |
| §7.4 status row at full width | at `W = columns − 4` inside the console; git zone / sparkline from 104 terminal columns | the console's edges |
| §7.2 pane = 12 rows whenever `ready` | collapsed strip by default, open 6, full 12 | D-D |
| §15.1 items yield per stage in the TUI | one `[step N]` line by default (`compact`); stage lines stay in `transcript.log`/`--plain` and the panel | D-D |
| §15.1 / F13 "the three writers stay line-for-line identical for the whole of a run — F13's identity is kept, not narrowed" (TD:1766) | **narrowed** to the predicate of §9: `full` keeps line identity modulo word-wrapping and the fence rule; `compact` (the default) is a declared subsequence of `transcript.log`; `--plain` and `transcript.log` are untouched and identical to each other | D-D "why is it so crowded"; the narrowing is declared once (§9, §10.1, §11) and tested as such |
| §2.1 `CAP` and `computeLayout` | `chrome`, `panel`, `reviewCard`, `card`, `intake`, `splash`; step 3b | §4.2 |
| §6.1 review header rows | inside a card in the boxed tier; flat tier unchanged | D-D |
| §11.1 wizard `Ctrl-C quits (prints fix)` | a wizard opened by `/mode` closes instead | D-A |
| §16 `decider.apiKey` env `['JEV_API_KEY', 'OPENROUTER_API_KEY']` | unchanged; `TYPESAFE_API_KEY` is prepended through `Layers.extraEnv` when the provider is explicit or typesafe-inferred (§2.3 step 3); the auto-openrouter case keeps today's order | D-B |

### 10.2 Where A and B disagreed, and what this document takes

| Topic | A | B | Taken | Why |
| --- | --- | --- | --- | --- |
| placeholders, prompt glyph, status placement | console, `› `, `Say hi, ask a question, or describe a task…` | `> `, `Say hi, ask about the code, …   / commands · ? help`, status row under a plain box | **A** | B's own rule: A's pixels win where both draw the same row |
| reply bodies | one item with `detail` lines (facts as `· ` bullets), `detail` written to all sinks | one item per line, no `detail` | **B** | `detail` is TUI-only by contract (`plain.ts:76`); one item per line keeps identity without a writer change; the hanging indent survives as Ink wrapping |
| mode action | `{ type: 'mode'; mode; pending }` + `launch.modeHint` | `{ type: 'next-mode' }` + `RendererOptions.nextMode` | **A** | one action carries live and pending; the first frame stays argv + env |
| mode item strings; `/mode jev-on` without a key | `mode: jev+llm for the next run (…)`; `reopenWizard('generator.apiKey')` from the App | `mode jev+llm from the next run — …`; `runLogin('mode', m)` from the controller | **B** | A declared them D-A strings; the controller owns `missingSecrets(mode)` and persistence (the console title is A's) |
| ambiguity row | — | one row | card in the boxed tier, B's row in the flat tier | consistency with A's cards |
| splash | 5-row wordmark, `◆ jevcode 0.2.0` brand row | one-line `[ui] jevcode 0.2.0 · …` sketch | **A** | A owns D-D |
| greeting frame text | `Hi. Jev decides every step here — …` | catalogue `hello_first` | **B** | B owns the catalogue |
| `stepSummaryText` | `[step N] <action> · risk …` | `[step N] <intent> · <action> · …` | **A** | A owns the transcript |

### 10.3 From the owner's decisions (D-A … D-E)

| Decision text | Taken | Why |
| --- | --- | --- |
| D-D "rounded-border boxes (Ink `Box borderStyle round`)" | text rows drawn from the cli-boxes `round` glyph set (`╭ ─ ╮ │ ╯ ─ ╰ │`, `node_modules/cli-boxes/boxes.json`, copied as literals into `glyphs.ts` — the single glyph source) through `consoleLines`/`cardLines`, not `<Box borderStyle="round">` | every row must exist as a string for `--ascii`, `--plain`, the frame tests and the `PaneBoundary` fallbacks; Ink's border renderer has no title slot (`render-border.js:36–40`); an absolute-positioned title (`position: 'absolute'`, `top`/`left`, `styles.d.ts:12`) is possible in Ink 7.1.1 but would live outside the string twins. The pixels are the ones the decision asked for |

Everything else in D-A … D-E is taken as written (§0 table).

---

## 11. Decision-log entries (ready to append to `docs/DECISIONS.md`)

## 2026-09-21 Jev-only is the default; a session needs one key

`jevcode` alone opened a two-key wizard because the default mode was `jev-on`. The default becomes `jev-only` through a
`mode` setting (flag > `JEVCODE_MODE` > dotenv > file > default); `/mode jev-on` (alias `/llm on`) switches the next run
and opens the wizard's generator step in place when no generator key exists; the mode is a badge in every frame.
Affects `src/config/**`, `src/cli/{args,main,session}.ts`, `src/tui/onboarding/**`, `registry.ts`.

## 2026-09-21 Jev decides what a submission is

Every Enter was a paid run. A submission now passes one Jev request (an intake Choice with paired Nouls, a reply Choice
and fact Nouls folded in); only `coding_task` at Jev's own p ≥ 0.6 with its paired Noul ≥ 0.5 starts a run; weaker
readings ask `run this as a task?`. No keyword classifier exists outside the mock decider. Affects `src/chat/**`,
`src/cli/session.ts`, `UiLabel`, the Jev panel.

## 2026-09-21 Two Jev providers, one client

TypeSafe native (`jev-1.13.0`, ≈ 110 ms, no `usage.cost`) and OpenRouter (`typesafe/jev-1.13-20260917`, ≈ 240 ms) differ
in ids, headers, errors and cost reporting; `JEV_PROVIDERS` carries the differences, auto-detection prefers `JEV_API_KEY`
→ openrouter then `TYPESAFE_API_KEY` → typesafe, cost is derived from the published rate when absent (`costBasis:
'table'`), `jev-1.13.0` is the pinned resolution on TypeSafe. Affects `src/jev/**`, `src/config/**`, `engine.ts` drift.

## 2026-09-21 The console, the compact transcript and the splash; identity kept by a declared filter

Boxes exist only where rows exist (boxed ≥ 16 rows); the console shares its edges between composer and status (+3 rows);
the transcript shows one `[step N]` line per step through a kind filter stamped at append time; the Jev panel collapses to
a strip; a ≤ 700 ms splash ticks through Ink's own timer and dies on the first key. In `full` every `<Static>` row is still
`formatTranscriptItem(item)` (word-wrapped; fence rows drawn as a rule); `compact` narrows the TUI to a declared subsequence
of `transcript.log` — a recorded deviation from TD §15.1/F13 (§10.1). Affects `src/tui/**`.

---

## 12. Glossary (every user-visible string of this round, once; `--ascii` substitutes per TD §14.1)

**Console.** top edge `╭─ <badge>[ · next run] ─…─ <dir> ─╮` · badges `jev-only` · `jev+llm` · `llm-only` · titles
`setup · jev provider` · `setup · provider` · `setup · generator key` · `setup · jev key` · `setup · verify` · `setup ·
trust` · `sessions · filter` · `rewind · filter` · prompt `› ` · placeholders and suffixes of §4.4.

**Status.** left words `⠹ thinking` · `⠹ looking` · `⠹ replying` · `asking` (`• thinking` reduced motion) · flat-tier
prefix `<badge> · ` · toasts `stopped thinking` · `one moment — still thinking` · `intake pending: y n · Esc keeps the
text` · `saved — jev+llm from the next run`.

**Rule row.** brand `─── ◆ jevcode <version> ───…` · strip `─── ▸ jev s<N> · <n> decisions · risk <r> <ok|[review]|[block]>
· plan <a>/<b>[ · jev <ms>ms] ─── [d] [p] [t] [s] ──` (≥ 100: `[d]ecisions [p]lan [t]imeline [s]ynth`) · `─── ▸ jev · no
decisions yet ───` · open header `─── ▾ decisions s7 · c~ derived |2p−1| ────…` · more row `  … <n> more rows · /panel
full expands`.

**Transcript.** `[you] <text>` · `[jevcode] <text>` · `[step N] <action> · risk <r> <verdict> · <outcome> · tests
<p>p/<f>f/<e>e · judge <p>[ · complete <c>] · <wall> · $<cost>|jev <k>` · `[step N] interrupted at <stage> (<reason>)`
· `[jevcode] Done — <summary>. /diff shows the change, /undo reverts it.` · fence `╶──── <lang>` / `╶────` · the 14
catalogue texts (§3.4) · the 14 fact texts (§3.5) · the lookup header, line, footer and miss (§3.6) · unreachable `I
couldn't reach Jev to read that (<short>). Press Enter to send it again.` · cap `The session cap ($<cap>) is reached, so
I'm not sending anything to Jev. Raise it with /budget session-spend-cap <usd>, or /new for a fresh session.` · unpriced
`I can't answer through the LLM: <model> has no pricing entry and --allow-unpriced is off (jev-only lookup still works).`
· kept `Okay — edit it and press Enter, or ask me something.` · LLM unreachable `I couldn't get an answer from <model>
(<short>). Ask again, or /mode jev-only for the lookup.` · floored `Ask again more specifically for an LLM answer.`

**Cards.** review title `review · step <N> · risk <r> (<bound>) · <kind> <target> "<goal>"` (120: `(tail on <dim>)`, ` ·
jev <ms>ms`) · `exit?` · `undo` · `commands` · `files` · `follow-up would exceed the session cap` · the intake card title `run this as a task?` / `"<message ≤ 40>" — run this as
a task?`, body `[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)`, the three flat rows of §3.7 and
the readline/SR twins.

**Mode items.** `mode <badge> (next run: <badge>)` · `mode <badge> already` · `mode jev+llm from the next run — Claude
writes the code, Jev still decides every step (persist: jevcode config set mode jev-on)` · `mode jev-only from the next
run — no generating LLM; code proposes, Jev decides, tests verify` · `mode llm-only from the next run — the generator
alone, no Jev (bench condition; reviews still ask)` · `mode stays <badge> — no generator key was saved` · the three
`[ui] error:` texts of §3.8 (`MISSING_JEV_KEY` = `missing decider.apiKey: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or run
jevcode login`; `a run is live; Enter steers it (Esc pauses, Esc Esc aborts)`; `configuration not ready yet`) · `config:
<message>`.

**Wizard.** `No Jev key found. Where do you reach Jev?` · `  1 typesafe (TYPESAFE_API_KEY, api.typesafe.ai)   2 openrouter
(OPENROUTER_API_KEY, also the generator)` (narrow `  1 typesafe   2 openrouter`) · `Jev API key (TYPESAFE_API_KEY)  1/1` ·
`Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)  1/1` · `jev+llm needs a generator. Pick the provider:` ·
`Keys are never shown, logged or echoed · Esc back · Ctrl-C keeps jev-only` · verify detail `one Jev decision at
api.typesafe.ai ~$0.00002 (jev-1.13.0)` · fix block `export TYPESAFE_API_KEY=…` / `export OPENROUTER_API_KEY=…` /
`printenv TYPESAFE_API_KEY | jevcode login --jev-provider typesafe --jev-key-stdin` / `jevcode login` / (jev-on only) `export
ANTHROPIC_API_KEY=…` · login prompt `Where do you reach Jev?  1 typesafe  2 openrouter` · usage error `jevcode login: pass
--jev-provider typesafe|openrouter with --jev-key-stdin`.

**Config, `/jev`, `/cost`, CLI.** `decider.provider  typesafe  derived (auto: TYPESAFE_API_KEY is set)` · `default
(typesafe)` / `default (openrouter)` · `mode  jev-only  default` · `/jev` line 1 `<provider> · <host> · <model>
(pinned|alias) → resolved <served>[ · drift@step N → <served>]` · line 2 suffix `(~ table-priced: $0.042/M input, output
free)` / `(provider usage.cost)` · line 3 `intake: <n> messages · p50 <ms> ms · $<usd> · last: <kind> <p>` · `/cost` `chat
$<usd> for <n> messages (~$<each> each, p50 <ms> ms)` · `jev $<usd> (~ table-priced)` · `[config] decider: <provider> ·
<model> (pinned|alias) · key <ENV> (<source>)[ · about <p50> ms per decision]` · the `ConfigError` and `[run]` texts of
§2.4–2.5 · `mode: "<v>" (from <source>) is not one of jev-only|jev-on|jev-off` · `decider.baseUrl: "<url>" (from <source>) is
<host-provider>'s endpoint but decider.provider is <provider> (from <source>); pass --jev-provider <host-provider> or drop
--jev-base-url` · `decider.apiKey: resolved from OPENROUTER_API_KEY but decider.provider is typesafe (from <source>); set
TYPESAFE_API_KEY or pass --jev-provider openrouter` · `decider.model: "<id>" (from <source>) is an OpenRouter id; the typesafe
provider serves jev-1.13.0 (or pass --jev-provider openrouter)` · the help texts of §1.2 / §2.3.

**Keys and commands.** `Alt-J` toggle panel · `Alt-Shift-J` full · `Alt-D` `Alt-P` `Alt-T` `Alt-S` tabs · `/panel
[d|p|t|s|off|full]` · `/transcript [compact|full]` · `/mode [jev-only|jev-on|jev-off]` · `/llm <on|off>`.

**Splash.** the wordmark rows (§5.1) · brand `◆ jevcode <version>` · sweep head `▓▒░` (`#+.` ascii).

---

## 13. Review log (2026-09-21, second synthesis pass)

Thirty findings from the review of the first synthesis; every blocker and major is applied, every minor too (none contradicted
D-A … D-E). Frames and tables were re-derived from the real functions (`statusLineText`, `ruleRow`, `paneRuleRow`) with the
frames' states; §4.10's legend names the twins. Line anchors are still HEAD `080331a`.

| # | Severity | Where | What changed |
| --- | --- | --- | --- |
| 1 | major | §5.1, §5.2 row 14, §5.3 Cancel, §4.2 step 10 | `useMotion(active, durationMs)` returns `{ time, settled }` and passes `isActive: active && time < durationMs` to `useAnimation`, so nothing ticks after 700 ms; the App's settle effect dispatches `splash:done` in the same commit (never the 1 Hz `tick`); `paneWant` reads `splash === 'running' && motion.time < SPLASH_MS`, so no frame grants the 5-row slot without wordmark rows; two `splash.test.ts` rows added (§8.1 S4) |
| 2 | major | §4.10 H-E1, H-E1w, H-F1, H-H2, H-H2w, H-B2w, H-C1w, H-D1w, H-F1w; §4.8 | Status rows regenerated with `statusLineText(state, 76 · 116)`: `? help` returns to H-E1/H-F1 (`shortHelp` keeps it for `none`/`review`), `sess $0.00/1.25 ok` appears in H-H2/H-H2w (the meter is up by then), the sparkline shows its real 12-cell right-aligned form; the open header and the ≥ 120 strips end in the 5-rule tail of `paneRuleRow`; `shortHelp` returns `''` for `intake` (stated in §4.8); §8.1 S4's frame test rebuilds every status/rule row from the twins and asserts equality |
| 3 | major | §4.10 H-A1, H-A1w, H-A2, H-A2w, captions of H-A1/H-A3; §5.3 First frame; §9 | First-frame frames redrawn as argv-only: `idle … step 0/–  ? help`, no `sess`, no `⎇`; `sess` and the git zone first appear in H-A3; §5.3 states that the meter, git zone and `[config]` item arrive after `resolveConfig`/`pushSessionSpend`/`useGitHead`'s effect; `perf/first-frame.ts` gains `JEVCODE_ASSERT_NO_CONFIG_BEFORE_FRAME=1` |
| 4 | major | §0 D-E, §4.5, §9 "line identity", §10.1, §11 | The two "verbatim" sentences replaced by the precise predicate: `full` = `formatTranscriptItem(item)` per item, wrapped with the label-width hanging indent, fence lines excepted; `compact` = a declared `TranscriptKind` subsequence; `--plain` = `full`. Test changes specified (`app.test.tsx:299` in `full` asserting the wrapped form, compact-subsequence test, fence fixture). Recorded as a deviation from TD §15.1/F13 in §10.1 and in the §11 entry |
| 5 | major | §4.10 (H-I1, H-I1w, H-J1, H-J2), §3.7, §8.1 S4 | Four frames added: the intake card at 80×24 and 120×40 (rule + card 3 + console 5 = 9 dynamic rows, status word `asking`, collapsed composer `› (waiting for y/n)`), the flat-tier intake row at 80×12 (4 dynamic rows) and a flat idle frame showing `jev-only · idle` (3 dynamic rows). The flat row gained a width ladder (95 / 70 / 39 cells) because the single row did not fit 80 columns. `readFrames` v2 spelled out: `DESIGN2` path, id regex `^\*\*(H-[A-Z0-9]+w?)\.`, the 24-id list, per-frame assertions |
| 6 | minor | §4.2, §4.3, §8.1 S4 | `consoleTop(l)` (top-edge row) and `composerTop(l) = consoleTop(l) + (chrome ? 1 + gate : 0)` defined; one cursor formula `y = composerTop(layout) + view.cursor.row`; `ConsoleProps.top = consoleTop`. The secret gate in the boxed tier is a console-hosted row (`LayoutInput.gate`, `overlayWant('secret') = 0`), not the `secret` overlay; flat keeps the overlay. `cursor.test.tsx` added (idle, gate up, 3-row draft, flat) |
| 7 | minor | §4.3, §10.3 (new) | §10.3 "From the owner's decisions" records the one deviation: D-D's `Box borderStyle="round"` → text rows from the cli-boxes `round` glyph set (`glyphs.ts` the single glyph source), because every row must exist as a string for `--ascii`/`--plain`/frame tests/`PaneBoundary` and Ink's border has no title slot (an absolute-positioned title is possible but outside the twins) |
| 8 | minor | §4.6, §4.10 H-D1w/H-F1w/H-E1w, §8.1 S4 | One exported `PANEL_WIDE_COLUMNS = 120` drives `panelStrip` (long labels, `jev <ms>ms` segment, 5-rule tail) and `paneRuleRow` (`[t]imeline`, 5-rule tail); the strip's earlier ≥ 100 threshold is gone; the three 120-column rule rows regenerated; tests at 100/119 (short) and 120 (long) |
| 9 | minor | §9 lag and fps rows | Lag wording corrected to "≈ 4 splash frames inside the gated window" (500 ms warm-up vs 700 ms splash); the fps gate gains a `splash` bucket in `render-lag.ts` (`framesPerSecondByClass` over 0–700 ms, gated at `maxFps + 1`) and the splash is also bounded by construction (≤ 15 frames, `splash.test.ts`); `perf/results/latest.json` to be re-baselined after S4 |
| 10 | minor | §5.1 | `WORDMARK` declared as five strings each padded to exactly 56 cells (rows 2–4 measured 51/54/51 unpadded); `splashFrame` computes spans on the 56-cell grid and right-trims afterwards; `splash.test.ts` asserts `cellWidth(r) === WORDMARK_CELLS` for every row |
| 11 | minor | §4.4, §3.8, §6 item 16 | Rule stated: `followup` once the session has any turn (a run or a chat reply), `task` only before the first turn; a command is not a turn (H-G1 keeps `task`, H-B2/H-C1 show `followup`); the App flips the mode on `SubmitOutcome.became ∈ {run, chat}`; `UiState.turns` added |
| 12 | minor | §4.5, §9 lag row, §8.1 S4 | Hidden items are filtered before `<Static>` (`visibleItems`, memoised, still append-only — A25 holds) while `UiState.items` keeps everything for `/export` and `/transcript full`; a hidden-only batch dirties no `<Static>` subtree; test with React `<Profiler onRender>` commit count and `frames().length` |
| 13 | **blocker** | §3.8, §3.9, §8.1 S3 | The root session meter already exists from startup (`newSessionMeter(); pushSessionSpend()`, `session.ts:2743–2744`, before `startupDone`), so the `+Infinity` placeholder never meets a chat request; the real fault — `startRun`'s first-run `newSessionMeter()` at `:1452` discarding chat spend, threshold state and `deferredBudgetLines` — is removed: it becomes `sessionMeter.setCap?.(…)` (`SpendMeter.setCap`, "never recreate a meter"); chat index lines survive to the first run's session id; `session-chat.test.ts` row `hi, hi, then a task → both intakes in the run's session total; cap refusal before any run; same meter object across run:start` |
| 14 | **blocker** | §6 header, items 4/7/8, §7.1, §7.2, §8.1 | Item 8 `deciderModel.provider` is optional (engine default `openrouter`), so `src/bench/cli.ts:37` and `src/perf/step-overhead.ts:154` compile untouched and `src/bench/**` stays read-only; item 4's builder list corrected to `validateDecider` + fakes (the `session.ts:1470/:1793` stubs compile unchanged); item 7's implementers listed; header says which items are required. Test ownership made disjoint: `config/{args,login}.test.ts` → S2 (excluded from S1's glob), `cli/main.test.ts` → S2, `cli/config-table.test.ts` → S1, `tui/why.test.ts` → S3, `tui/wizard.test.tsx` → S2, S4's exception list explicit. §7.2 rows added for `src/cli/tui-prompter.ts` (S3 ← S2: `reason`, `mode: target`, `jevProvider`, default `jev-only`) and `src/cli/login.ts` |
| 15 | major | §1.4, §8.1 S2/S3 | `reopen` widened to `{ at, runLive, reason?, mode? }`; the reducer sets `reason`/`mode`, forces `at: 'provider'` + `providerShown` for reason `mode`; `cancel` → `done` for `runLive || reason ∈ {mode, login}` (idle `/mode jev-on` → Ctrl-C never exits 2); `save-failed` reads the target mode; `tui-prompter.ts` `wizard()` calls `reopenWizard('provider', runLive, { reason: 'mode', mode })` and defaults the mode to `jev-only`; reducer and prompter test rows added |
| 16 | major | §3.1 rows 10/12/12′/13, §3.6, §3.8, §8.1 S3, §12 | One `chatFailure(e, side)` catches everything from `converse` and `reply`: `AbortError` → toast `stopped thinking`, no bubble, draft kept, `became: 'nothing'`; `ConfigError` → `[ui] error: config: …`; `JevHttpError`/network → `INTAKE_UNREACHABLE`; generator failures → new `LLM_UNREACHABLE(model, short)` (`I couldn't get an answer from <model> (<short>). Ask again, or /mode jev-only for the lookup.`); the live region empties; the meter is never touched. `--plain` composer wraps `host.submit()` in try/catch. Test rows for abort and provider 500 |
| 17 | major | §2.2 `keyEnv`, §2.3 step 3, §10.1, §8.1 S1 | Key order made explicit and matched to `envNames()`'s prepend: provider from flag/env/dotenv/file/auto:base-url/auto:typesafe-key → the provider's variable first; `auto:openrouter-key` → no `extraEnv`, today's `['JEV_API_KEY', 'OPENROUTER_API_KEY']` unchanged (no existing user's paying key flips). Per-case consulted-list strings; an `OPENROUTER_API_KEY` resolved under typesafe is refused offline; two resolve.test.ts rows |
| 18 | major | §3.3, §8.1 S3 | `INTAKE_CRITERIA: Record<IntakeKind, { definition, examples }>` (reusing the table's `true` column) is what the intake `choice()` receives; `INTAKE_OPTIONS` keeps feeding only the paired-Noul instructions; snapshot test asserts every Choice option's criteria is `{ definition, examples ≥ 2 }` |
| 19 | major | §3.5, §8.1 S3 | The facts table gained `examples` (≥ 2) and `false examples` (≥ 2) columns for all 14 facts; `FACT_FALSE_EXAMPLES` is that column verbatim; `facts.test.ts` asserts `buildFactQuestions(harnessFacts(fixture))` builds without throwing for every fixture |
| 20 | major | §3.3, §3.5, §3.8, §12 | Declared: `IntakeResult`, `runIntake(...)`, `ChatKind`, `ChatRoute`, `routeOf`, `llmAnswerAllowed`, and every controller helper (`intakeState`, `factsInput`, `replyFacts`, `lookupInput`, `llmInput`, `meterChat`, `chatDecisions`, `youTurn`, `chatLine`, `replyByKey`, `chatEstimateUsd`, `generatorModelLabel`, `chatSignal`, `thinking`, `uiToast`) with signatures; `FactsInput` uses core types only (`FactsLastRun`, `LastTestRun` — no `RunRecord` import cycle, no phantom `JudgeTests`); every new string listed in §12 with its text (`MISSING_JEV_KEY`, `INTAKE_UNREACHABLE`, `LLM_UNREACHABLE`, `LLM_FLOORED_HINT`, `INTAKE_KEPT`, `LLM_UNPRICED_REFUSAL`, `SESSION_CAP_CHAT_REFUSAL`) |
| 21 | major | §1.2, §8.1 S1 | `resolveMode(layers)` anchored after step 3 (config file loaded) and before the `limits.spendCapUsd` default at `resolve.ts:452`; `:351` keeps only an argv hint; `baseMode` re-read from `config.mode` in `applyConfig()`; `pendingFlagOverrides()` still the flag layer; resolve.test.ts row: file `mode: jev-on` → source `file:`, cap $2.00 |
| 22 | major | §3.3, §3.6, §3.8, §6 item 17, §8.1 S3 | The LLM path has a floor: `llmAnswerAllowed` (chosen at p ≥ `LLM_ANSWER_FLOOR` 0.5, or paired ≥ 0.5); weaker `question_about_the_code` readings under jev+llm fall back to the lookup with `LLM_FLOORED_HINT`; the `n` of the ambiguity card passes the same check; `sessionMeter.exceeded()` and `chatEstimateUsd` are checked before `llmChatTurn`; `route: ChatRoute` recorded in the `chat` index and `--json` lines |
| 23 | minor | §2.2, §2.5, §8.1 S1 | `typesafe.aliases = ['jev-latest']`; `validateDecider` rejects an unpatched `jev-\d+\.\d+$` under typesafe with the OpenRouter-id message; `jevModelMatches` drops the `s.startsWith(\`${c}.\`)` branch; providers.test row corrected |
| 24 | minor | §1.4, §12 Wizard, §8.1 S2 | Fix-block line `printenv TYPESAFE_API_KEY \| jevcode login --jev-provider typesafe --jev-key-stdin`; `commandLogin` infers the provider (rules 2a–2d), prompts on a TTY, exits 2 with a usage line on a pipe, and always writes `jevProvider` next to `jevApiKey` (`CredentialsPatch.jevProvider`); login.test.ts row |
| 25 | minor | §1.3, §1.5 | Idle `/mode` dispatches `{ mode: baseMode, pending: a.mode }`, so the badge reads `jev+llm · next run` until `run:start` (`resetForRun`) promotes `pending` → `mode`; the earlier "at `run:end`" sentence removed; §1.3's badge sentence rewritten; consistent with H-G1 and `mode-switch.steps` |
| 26 | minor | §3.8, §8.1 S3 | `converse` re-reads `config` **after** `runLogin` returned true (`persistCredentials → reresolve()` replaces the object) and re-checks `missingSecrets('jev-only')`; `startRun` mirrors it; test row `no key → wizard saves → hi replies with zero config errors` |
| 27 | minor | §3.8, §3.10, §8.1 S3 | `say('you', redact(text).split('\n').filter(nonBlank))`: bubbles redacted at emission and one item per line, so `notifyLocal` never forwards raw text and `localItem`'s `oneLine()` never flattens a draft; `bubbles.test.ts` asserts both |
| 28 | minor | §2.3 Redaction, §8.1 S1 | The over-claim removed; the `SecretSet` gains every non-empty process-env value of `KNOWN_KEY_ENV` (`JEV_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`) regardless of the selected provider; resolve.test.ts row `TYPESAFE_API_KEY in env + --jev-provider openrouter → redact() masks it` |
| 29 | minor | §3.4, §3.5, §8.1 S3 | `bye` → `runs are saved under <runsDir>` filled from `FactsInput.runsDir` (`~`-abbreviated); `how_to_task` gains a `nextMode`-keyed sentence (jev-only: "I fix what tests can verify; for open-ended changes switch with /mode jev-on"; jev-on: "Claude writes the code, Jev decides each step"); tests assert every path in a text derives from the input |
| 30 | minor | §2.3 step 4, §2.4, §12 | A configured base URL of the other host fails offline in `validateDecider` (`decider.baseUrl: "<url>" (from <source>) is <host-provider>'s endpoint but decider.provider is <provider> …`); the 400/422 message names `new URL(cfg.baseUrl).host` instead of `spec.displayHost` |

Not changed, on purpose: the reply catalogue's 14 rows and the intake option texts (no finding); `CAP.splash = 5`, `SPLASH_MS = 700`,
`SPLASH_INTERVAL_MS = 50`; the one-request intake (groups A + B + C); `INTAKE_RUN_FLOOR = 0.6`; the frame set's 80×24 / 120×40 pairs
(the two 80×12 frames are additions, not replacements).
