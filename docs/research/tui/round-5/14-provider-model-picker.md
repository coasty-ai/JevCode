# Round-5 topic 14 — provider picker, model picker, key setup

Verified against `.claude/worktrees/r5-design` (branch `r5-design`), 2026-09-22. Every symbol below was read
directly from the files named; line numbers are as-seen in this worktree, not copied from a design doc. This topic
is **not** in `docs/research/tui/round-5/00-contract-digest.md` (grepped for `model|provider|picker|/key`: no hits
outside coordination's unrelated `ForkVerdict`/`Ledger` rows) — it is greenfield round-5 work, not a reconciliation
against a peer design.

## 1. What the designs and code say (verified, file:line)

### 1.1 The harness side (`src/models/**`, `src/provider/**`) is finished; the TUI side never calls it

`src/models/index.ts:1-42` is a facade written *for* this feature — its own docblock is a numbered call order for
"what a picker calls, in what order": `instantCatalogue()` for the zero-I/O first frame, `catalogue.load({keys})`
behind it (network → 24 h disk cache → bundled snapshot, never throws, never empty), `rankModels()` on every
keystroke, `modelSummary()`/`sourceLabel()`/`errorLabel()` for rows, `recommend()` for the empty-query shortlist,
`keyEnvNames()`/`verifyProvider()` for key setup. `grep -rln "models/index.js\|models/list.js\|models/search.js" src/cli
src/tui` returns **zero matches** — nothing in the TUI-owned tree imports any of it yet. `grep -c "provider/ids.js"
src/cli/*.ts src/tui/**/*.ts*` is likewise zero outside the files this doc names below.

- **`src/provider/ids.ts`** (54 lines, zero imports, the only provider module allowed on the argv path per its own
  docblock lines 4-11): `ProviderId` is a 7-member union (`:18`), `PROVIDER_IDS` is the display/tie-break order
  (`:25`), `PROVIDER_KEY_ENV` (`:36-44`) names every env var per provider **in lookup order**, JevCode's own name
  first (`gemini`: `GEMINI_API_KEY` then `GOOGLE_API_KEY`; `meta`: `META_API_KEY` then `MODEL_API_KEY`).
- **`src/provider/registry.ts:174-256`** (`PROVIDERS`) has a full `ProviderSpec` row — `create()`, `listModels()`,
  `keyEnv`, `baseUrl`, `defaultModel`, `docsUrl`, capability flags — for all seven ids, backed by seven real HTTP
  clients (`anthropic.ts`, `openrouter.ts`, `openai.ts`, `gemini.ts`, `fireworks.ts`, `meta.ts`, `xai.ts`).
- **`src/models/providers.ts:70-165`** (`PROVIDERS`, the catalogue table) has `keyUrl`, `keyCheckPath`, `listPath`,
  pagination and auth-header rules for all seven, verified live 2026-09-21 per its own docblock (`:5-18`).
- **`src/models/search.ts`** — `rankModels`/`matchModel`/`findModel`/`nearMisses` (`:87-228`) is a complete,
  deterministic, pure fuzzy ranker (exact > prefix > word-start > subsequence, tie-broken live-before-deprecated,
  tools-first, cheapest, provider order, id) with a "did-you-mean" function already built for `/model <id>`
  validation.
- **`src/models/verify.ts:37-93`** — `verifyProvider`/`verifyProviders`, one free catalogue GET (or OpenRouter's
  `/key`) per provider, never a generation, redacted by construction (`:44-46`).
- **`src/models/cache.ts:22-37`** — `~/.jevcode/models/<provider>.json`, 24 h TTL (`CACHE_TTL_MS`), tolerant parse
  (any malformed file reads as a miss, never an error), `modelsCacheDir()` honours `JEVCODE_HOME`.
- **`src/models/format.ts`** — `modelSummary`/`sourceLabel`/`errorLabel`/`catalogueSummary` (`:40,67,82,101`) are
  already exactly the plain-string rows a picker, `--plain` and a screen reader would all print unchanged.

**Conclusion:** there is no backend work left for this topic. Every open item below is in the TUI-owned tree
(`src/tui/**`, `src/cli/**`, `src/session/**`, `src/config/**`) or in `src/core/types.ts`'s TUI-facing contract.

### 1.2 The TUI-owned tree hardcodes a 2-provider world in at least eight places

`GeneratorConfig.provider: 'anthropic' | 'openrouter'` (`src/core/types.ts:2005`) and `ProviderName = 'anthropic' |
'openrouter' | 'mock'` (`:649`) are the root cause: `src/provider/registry.ts:16-19`'s own "CONTRACT NOTE" states
core owns these two unions and that "widening those two core unions to `ProviderId` makes `createProvider()` return
exactly a core `Provider` with no other change here" — the harness side is already waiting on this. Runtime
enforcement is at **`src/config/validate.ts:161`**: `if (provider !== 'anthropic' && provider !== 'openrouter')
throw invalid(reader, 'generator.provider', providerR, 'one of anthropic|openrouter')` — today, configuring
`generator.provider=openai` (or gemini/xai/fireworks/meta) is a hard `ConfigError`, even though the adapter, the
registry row and the catalogue all exist. `models/providers.ts:172` documents the same fact from its side:
`GENERATOR_PROVIDERS = ['anthropic', 'openrouter']`, "typed against core `GeneratorConfig['provider']` so the link
is visible: when an adapter lands, core's union widens and this list is where the catalogue learns about it."

That two-member assumption is independently re-declared, not imported, in every one of these TUI-owned files:

| # | File:line | What it hardcodes |
|---|---|---|
| 1 | `src/config/resolve.ts:89` | `const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' }` — used at `:514` to decide which env var feeds `generator.apiKey`. **This is a live bug independent of the contract widening**: it does not import `provider/ids.ts`'s 7-entry, multi-name-aware `PROVIDER_KEY_ENV`, so it is also missing `gemini`'s `GOOGLE_API_KEY` fallback and `meta`'s `MODEL_API_KEY` fallback that `ids.ts:29-30` documents as intentional. |
| 2 | `src/config/defaults.ts:67` | `BASE_URLS: Readonly<Record<'anthropic' \| 'openrouter', string>>` — same 2-entry shadow of `registry.ts`'s `baseUrl` field, read at `validate.ts:171`. |
| 3 | `src/config/credentials.ts:235` | `CredentialsPatch.provider?: 'anthropic' \| 'openrouter'` — the file-write path for `config.json`'s `provider` key. |
| 4 | `src/tui/onboarding/reducer.ts:22` | `WizardProvider = 'anthropic' \| 'openrouter'`, plus `KEY_PREFIXES` (`:196-199`: `sk-ant-`, `sk-or-v1-`/`sk-or-`) used by `looksLikeKey`. |
| 5 | `src/tui/onboarding/lines.ts:39,41` | `PROVIDER_ENV` and `PROVIDER_DISPLAY`, both `Record<WizardProvider, string>` — a **third** independent copy of `keyEnvNames`/`providerDisplayName`. |
| 6 | `src/tui/commands/registry.ts:357` | `/provider`'s `ArgSpec.values: ['anthropic', 'openrouter']`. |
| 7 | `src/tui/commands/dispatch.ts:59` | `DispatchResult` discriminant `{ kind: 'provider'; provider: 'anthropic' \| 'openrouter' \| null }`. |
| 8 | `src/cli/session.ts:1818` | inline ternary `providerOfConfig(config) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'` inside the shadowing-line note. |

None of these eight import `provider/ids.ts` or `models/providers.ts`; each was written by hand against the two
providers that existed when it was written. This is the same shape of drift `models/providers.ts:24-32` already
fixed once (it imports and re-exports `ids.ts` rather than repeating it) — six-plus more places didn't get the memo.

### 1.3 The onboarding wizard is a hardened, provider-binary state machine — not a place to grow to seven

`src/tui/onboarding/reducer.ts:1-16`'s own header draws the whole flow as five paths through `WizardStep` (12
members, `:26`), keyed on the two providers above (`options` step row 4 is literally "generatorKey(anthropic)",
`:8`). `Wizard.tsx`'s docblock (`:1-9`) reflects three design rounds of edge-case hardening (TUI-DESIGN §11.1/§11.2,
TUI-DESIGN-2 §1.4, TUI-DESIGN-3 §1.4-§1.8: paste-twice detection, the pasted-newline-as-Enter edge (`Wizard.tsx:235-
253`), the OpenRouter-key-reused-for-Jev shortcut, Ctrl-C-aborts-verify-only). Growing this reducer to 5 more
providers multiplies edge cases (5 more `KEY_PREFIXES` entries, 5 more `options` rows, 5 more provider/jevProvider
interactions) for a first-run flow most users adding a 6th key don't need at startup.

**Verification of the wizard's "verify" is a different, priced check.** `Wizard.tsx:69` calls `WizardHost.verify()`,
implemented by `src/cli/session.ts:1781` `verifyForWizard` → `src/cli/login.ts`'s `realVerifyKeys` (imported at
`session.ts:190`). `login.ts:75` names `VERIFY_PROBE_STATE = { message: 'hi' }` — "one Jev decision, one 1-token
completion" (comment at `Wizard.tsx:69`) — a real, priced call through the **decider**, not `models/verify.ts`'s
free catalogue GET. `grep -n "verifyProvider\|models/verify" src/cli/session.ts src/cli/login.ts` returns nothing:
the harness's free, provider-agnostic `verifyProvider` (§1.1 above) is never called anywhere in the TUI tree today.

### 1.4 `/model` and `/provider` exist but do nothing today

`src/tui/commands/registry.ts:343-364`: `/model [id]` (`args: [{ kind: 'text' }]`, no `values`) and `/provider
[anthropic|openrouter]` (`args: [{ kind: 'enum', values: [...] }]`). Handlers at `src/cli/session.ts:3062-3088`:
`/model <id>` sets `pending.model = id` verbatim — **no lookup, no validation, no fuzzy match** — and prints one
warning heuristic (`:3073`, an OpenRouter id without a `/` or an Anthropic id with one). `/provider <p>` just sets
`pending.provider`. Neither imports anything from `src/models/**`.

**Palette mechanics rule out a naive fix.** `docs/TUI-DESIGN-4.md` §4.2 (`:1608-1654`) specifies `PaletteNavState`
as nine states over a **static** `spec.args[0].values: readonly string[]` baked into `CommandSpec` at module load
(`registry.ts:19`); `palette.ts:329-344` filters that fixed array with `rank()` and lets Tab/↓ cycle it in place —
designed for enums of a handful of values (`/mode`, `/budget`'s five settings), not a catalogue of 400+ OpenRouter
models that also needs a network refresh and a spinner. Two existing precedents show the pattern the catalogue
should follow instead:

- **`/resume [id|title]`** (`registry.ts:128`) is `kind: 'run'` — free text, no static `values`, validated at
  dispatch time. **Opening `/resume` with no argument opens a *separate* full picker** (`session/picker-lines.ts`,
  rendered in the pane slot, filtered by the live composer text — `picker-lines.ts:1-4,27`: "the picker renders in
  the pane slot with the composer as its filter... case-folded subsequence over title, task60 and ids"), not the
  8-row command palette.
- **round 4's `--plain`/screen-reader numbered list** (`TUI-DESIGN-4.md` §4.6, `:1787-1820`) is the precedent for a
  non-Ink twin of a *large* ranked list: `paletteNumberedLines` prints `1..N`, sets a one-shot `pendingList`, and
  changes the readline prompt to `pick 1-41, or type a message > ` for exactly one turn so a stray digit can never
  misfire (`:1801-1813`).

Both precedents point the same way: `/model` should get a dedicated picker like `/resume`'s, not a palette
argument-value list; its non-Ink twin should reuse round 4's numbered-list-plus-changed-prompt mechanism, not
invent a third one.

### 1.5 Round 4 does not touch this topic

`grep -in "model picker\|provider picker\|key setup" docs/TUI-DESIGN-4.md` returns nothing; the only "model" hits
are `src/tui/pane/model.ts` (an unrelated pane-layout module — **do not confuse it with the LLM model catalogue**,
`TUI-DESIGN-4.md:151,371,2974`) and the palette's own `/model` as an example row (`:1715,1829`). Round 4's D-U block
grammar (`block(head, rows: BlockRow[], opts)`, `kv`/`facts`/`table`/`rule`/`note` row kinds, §3.1) is nonetheless
directly reusable for `jevcode models list`/`/model` output once it lands — see §5.6.

### 1.6 The credentials file has one key slot per secret, not one per provider

`src/config/credentials.ts:115-123` `CredentialsFile` has exactly `apiKey: string | null` and `jevApiKey: string |
null` (`CREDENTIAL_KEYS`, `:24`) — one generator key, tagged by the single `provider` field beside it. There is no
per-provider key map on disk. Multiple *simultaneous* provider keys already work today only through the **process
environment** (`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` can both be exported; `PROVIDER_KEY_ENV` picks the right one
once `generator.provider` says which), never through `jevcode login`'s saved file, which holds one key at a time.

### 1.7 A secondary redaction gap, cross-cutting but not TUI-owned

`src/core/redact.ts:68-75` (`FORMAT_PATTERNS`, harness-owned) has prefix regexes for OpenRouter (`sk-or-v1-`),
Anthropic (`sk-ant-`), OpenAI (`sk-`/`sk-proj-`) and Google (`AIza`) — **none for xAI, Fireworks or Meta key
shapes**. The exact-secret layer (`createRedactor`, `:93-164`) still catches a key *after* it is saved via
`addSecret`, and the chat composer's own secret gate (`src/tui/secrets/gate-lines.ts`) reads the same
`detectSecrets` families — so a pasted-but-unsaved xAI/Fireworks/Meta key typed into the ordinary chat composer (not
`/login`) would not be caught by the pattern layer today. Flagged in §6; `src/core/redact.ts` is harness-owned, not
a file this topic's slot can edit.

## 2. What the best tools do (cited)

- **Claude Code's `/model`** opens an interactive picker with no argument, or switches immediately with
  `/model <alias|name>`; inside the picker, **Enter switches and saves as the user's default, `s` switches for the
  current session only** — a Save-vs-session-only fork this project's `/model` (pending, next-run-only, `session.ts
  :3062-3075`) does not have. Resolution order is command > `--model` flag > `ANTHROPIC_MODEL` env > settings file >
  `ANTHROPIC_DEFAULT_MODEL` for new sessions. Provider-specific aliases resolve differently per backend (Bedrock,
  Foundry, direct API) from one table. ([Model configuration – Claude Code Docs](https://code.claude.com/docs/en/model-config))
- **opencode's `/connect`** adds a provider key once, stored centrally at `~/.local/share/opencode/auth.json`
  (never in the project config), separate from `opencode.json` (project-level, version-controlled) which can add
  per-model overrides and a `baseURL` override per provider; precedence is env vars as the baseline, config file
  overrides them, per-model settings narrow further. `/models` lists everything connected providers expose, with
  `blacklist`/`whitelist` to curate a catalogue that can run past 75+ providers.
  ([Providers | OpenCode](https://opencode.ai/docs/providers/))
- **Aider** has no interactive picker at all: `--list-models <substring>` is a one-shot CLI filter (e.g. `aider
  --list-models turbo`), `--model <id>` switches for the run, and a provider's key is set with `--api-key
  provider=<key>` (which sets `<PROVIDER>_API_KEY` for you) or picked up from a `.env` searched in the home
  directory, the git root, the cwd, or `--env-file`. This is the closest existing precedent to a pure-CLI,
  non-interactive `jevcode models search <query>` twin. ([API Keys | aider](https://aider.chat/docs/config/api-keys.html); [Models and API keys | aider](https://aider.chat/docs/troubleshooting/models-and-keys.html))

Takeaways this project should borrow: (1) Claude Code's Enter-saves-default / session-only-key fork is a real gap
in today's "next run only" `/model` semantics (§5.2); (2) opencode's env-baseline-then-config-file precedence is
already this project's own rule (`resolve.ts:4` "flag > process env > ./.env > ... > config file > default") —
nothing to change there; (3) Aider's substring `--list-models` is the right shape for a non-interactive
`jevcode models search`, not a new invention.

## 3. Edge cases

1. **Empty cache, first run, offline.** `instantCatalogue()` (`list.ts:284-286`) is the only thing painted before
   any network call — it is the bundled snapshot, always non-empty. A picker that awaits `loadCatalogue()` before
   its first paint violates the "first frame < 300 ms, zero network before it" project rule; it must paint the
   snapshot first and refresh in place.
2. **Stale cache (> 24 h).** `isFresh()` (`cache.ts:160-165`) says no; `listModels` (`list.ts:205-249`) still serves
   the stale entry immediately (`fromCache(..., error)`) while a fresh fetch runs behind it — the picker's row for
   that provider should read `sourceLabel` (`cached 3 h ago`) and update in place if the refresh changes the list,
   never block on it.
3. **Offline mid-session.** `opts.offline === true` short-circuits to cache-or-static with a `network`-kind error
   (`list.ts:218-221`); `errorLabel('network', ...)` → `"<Provider>: offline — showing the last list"`
   (`format.ts:91-92`) is the exact row text.
4. **No key for a provider.** `listNeedsKey` (`list.ts:194-196`): every provider except OpenRouter needs a key just
   to list models; `noKeyError` (`:88-90`) plus `errorLabel`'s `no_key` branch names the env var
   (`format.ts:85-86`). A provider with no key still shows its cached/static rows, dimmed, with that reason — it
   is never hidden outright (OpenRouter's own list needs no key at all).
5. **A key that is present but rejected.** `kindOfStatus` maps 401/403 to `'auth'` (`list.ts:70-76`);
   `errorLabel`'s `auth` branch is `"<Provider>: key rejected (401)"` — this is a *stale/expired key*, distinct from
   *no key configured*.
6. **The clock is briefly wrong.** `isFresh` explicitly treats a `fetchedAt` timestamp in the future as *not*
   fresh (`cache.ts:158-159`, own comment: "a clock that was briefly set forward... would otherwise pin the
   catalogue until the wall clock catches up") — no picker-side workaround needed, but the picker must not
   second-guess this by trusting a cached entry's own claimed freshness.
7. **Rate limited mid-refresh.** `kindOfStatus` → `'rate_limit'`; `errorLabel` → `"<Provider>: rate limited —
   showing the last list"` — the picker keeps the old rows on screen, not a blank state.
8. **A provider-qualified id vs. a bare one.** `haystacks()` (`search.ts:78-84`) matches `gpt6` against both
   `gpt-6-astra` and `openai/gpt-6-astra`; `providerFromModelId()` (`models/providers.ts:288-299`) is a heuristic
   guess (namespaced id ⇒ OpenRouter, `claude-` ⇒ Anthropic, etc.) for when a user types a bare id with no
   provider context — never a substitute for the catalogue's own `findModel`.
9. **A typo'd model id.** `findModel` returns `null`; `nearMisses(id, models, 3)` (`search.ts:221-228`) gives a
   "did you mean" shortlist, excluding the id itself and anything that already resolves as its alias. `/model
   <bad-id>` should print this list, not a bare "not found."
10. **OpenRouter routing-variant suffixes (`:free`, `:batch`, `:nitro`, `:extended`).** `isRoutingVariant`
   (`search.ts:126-128`) flags them; `compareModels`'s tie-break (`:146-167`) ranks them behind their standard
   route on the empty-query default list specifically because `:free` prices at `$0` and would otherwise sweep the
   top — but a typed query still finds them (own comment, `:141-145`).
11. **A model the current provider set cannot generate with yet.** Until §5.1's contract widening lands,
    `isGeneratorProvider(model.provider)` (`models/providers.ts:219-221`) is false for openai/gemini/xai/fireworks/
    meta — the picker must show these rows (for browsing/pricing/verification) but mark them "browse only" and
    refuse to pend them as `pending.model`/`pending.provider` for a real run, with a message naming why, not a
    silent no-op.
12. **A pasted key with the wrong shape.** `looksLikeKey`/`KEY_PREFIXES` (`reducer.ts:196-205`) only recognise
    `sk-ant-`/`sk-or(-v1)-` today; extending key-shape hinting to the other five providers needs their prefixes
    (OpenAI `sk-`/`sk-proj-`, Google `AIza…`, per `redact.ts:69-72`) — xAI/Fireworks/Meta have **no** pattern in
    the tree anywhere yet (§1.7) and would need one invented and verified live before a shape hint could be shown.
13. **A key that used to work and now doesn't (rotated/expired).** Same as edge case 5 from the picker's polling
    path; from `/login`'s explicit verify, `verifyForWizard`'s `rejected` field (`Wizard.tsx:50`) already exists
    for this — the new-provider path should produce the analogous outcome via `VerifyResult.error.kind === 'auth'`.
14. **Terminal width.** At 40 columns `modelSummary`'s full row (`"z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx →
    944k out · $0.15/M in · $0.50/M out · tools · json · reasoning"`, `format.ts:36-49`) does not fit; the picker
    needs its own column budget (id + price, dropping capabilities first) the same way `paletteRows`
    (`palette.ts:318-321`) computes `avail` before cutting a title — `modelSummary` is a *compose-your-own-row*
    set of parts (`contextSummary`, `formatPricing`, `capabilitySummary` are separately exported, `models/index.ts
    :148-160`), not a single fixed string, precisely so a narrow render can drop parts instead of truncating mid-row.
15. **A corporate proxy/gateway `baseUrl` that echoes the `Authorization` header into its error body.**
    `models/list.ts:47-51`'s own comment names this as the reason `redact` defaults to `patternRedact`, never
    identity — every `ModelsError.message` a picker renders is pre-redacted; nothing extra needed on the TUI side
    as long as the picker always renders `ModelsError`/`VerifyResult.error` fields, never a raw thrown error.
16. **Ctrl-C during a verify or a refresh.** The wizard's existing pattern (`Wizard.tsx:140,178-203,354-361`: an
    `AbortController` per verify, cancel aborts only the in-flight request, the key already typed is kept) is the
    template; `verifyProvider`/`listModels` already accept `opts.signal` (`verify.ts:37`, `list.ts:205`), so the
    new key-setup path reuses the same abort-on-Ctrl-C shape rather than inventing one.

## 4. Pinned strings and twins

Almost all row text for this feature already exists as pure, tested-in-place string functions in `src/models/
format.ts` and needs no new copy, only layout:

| Purpose | Function | Example |
|---|---|---|
| One picker row | `modelSummary(model)` (`format.ts:40`) | `z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · tools · json · reasoning` |
| Catalogue provenance | `sourceLabel(result, now)` (`:67`) | `live` / `cached 3 h ago` / `bundled snapshot` |
| A provider's failure | `errorLabel(provider, error)` (`:82`) | `Google Gemini: no API key — set GEMINI_API_KEY` |
| Header summary | `catalogueSummary(results)` (`:101`) | `7 providers · 512 models · 2 unavailable` |
| Key-setup copy | `providerSpec(id).keyUrl` (`providers.ts:70-165`) | `https://console.x.ai` |

Because these are plain strings with no Ink/colour dependency, the **Ink picker, the `--plain` numbered-list twin,
the screen-reader twin and `jevcode models --json`'s human-readable sibling all call the same functions** — the
only genuinely new twin work is the *layout* (columns, cuts, cursor) and the *interaction* (fuzzy-as-you-type,
Enter/Tab semantics), not the text.

New strings this topic needs (none of these exist in the tree yet — proposed, not pinned):

- Picker header, mirroring `pickerHeader`'s shape (`session/picker-lines.ts`): `─── models · 512 of 7 providers ·
  by relevance ─ ↑↓ Enter Tab Esc ────`.
- Browse-only row suffix (edge case 10): ` — browse only, generation not yet available` — needed only until §5.1
  lands; should be a single constant so it can be deleted in one place.
- `/model` "did you mean" line, built from `nearMisses` (`search.ts:221`): `no model named <id> — did you mean
  <id1>, <id2> or <id3>? (/model to browse)`.
- Key-verify outcomes for the five new providers, parallel to the existing `verifiedGeneratorText`/
  `verificationFailedText` (`onboarding/lines.ts:242,493`) but sourced from `VerifyResult`
  (`models/types.ts`) rather than the decider probe: `<provider> key verified — <n> models` /
  `<provider> key rejected (401)` / `<provider>: rate limited — try again`.
- `--plain`/pipe numbered list header, reusing round 4's exact shape (`TUI-DESIGN-4.md:1793-1798`): `models (1-40
  of 512) — type a number, "more", or a query, then Enter` with the changed prompt `pick 1-40, or type a query >
  `.
- Screen-reader line, mirroring the palette's own (`TUI-DESIGN-4.md:1814-1817`): `models: 3 of 40 · z-ai/glm-5.3-
  flash · OpenRouter · $0.15/M in · Enter picks, Tab narrows, Esc closes`, coalesced ≤ 1 per 400 ms.
- `jevcode models list|search|refresh --json` output: `{ "provider": "...", "models": [...], "source": "cache",
  "fetchedAt": "...", "stale": true, "error": {...} }` — the `ListResult`/`CatalogueLoad` shape already defined in
  `models/types.ts`, serialised as-is rather than re-modelled, mirroring `sessions list --json`'s
  `{ sessions, skipped }` pattern (`cli/sessions.ts:34-37`).

Every one of the above needs the usual four twins per the project's own rule: `--plain` (readline, numbered list
above), `--json` (only where a CLI verb exists — `jevcode models`, not `/model` inside a running session), `--ascii`/
screen-reader (glyph substitution table, `·` → ` - `, `→` → `->`, same rule `palette.ts:351` and `cutTitle` already
use), and a 40/80/120-column behaviour (drop capabilities → drop context window → id + price only, per edge case
13).

## 5. Recommended decisions with options and a recommendation

### 5.1 Widen `GeneratorConfig.provider` / `ProviderName` (contract), or leave the 5 new adapters catalogue-only?

- **Option A — widen now.** Add the 5 ids to both unions in `src/core/types.ts` (additive, matches contract 1.x's
  own "optional or default-preserving widening" rule — this is a union widening on a *required* field, which is
  the same shape orchestration's own pending contract-1.5 change already accepted per the digest's §B item 2
  framing "a relocation, not a reshape"). Drop `validate.ts:161`'s two-name check to `PROVIDER_IDS.includes(...)`.
  Unblocks real generation through all seven adapters immediately; `registry.ts:16-19`'s own comment says this is
  the *only* change needed on the harness side.
- **Option B — leave it catalogue-only this round.** Ship the picker, `/provider`, `jevcode models` and key setup
  for browsing/pricing/verification across all 7, but keep `pending.provider`/`pending.model` refusing to arm a
  run on the 5 new ids (edge case 10) until a later round.
- **Recommendation: A.** The blocking work is one union widening plus deleting one hardcoded check; every adapter,
  registry row and catalogue entry needed to make it real already exists and is unused. Shipping B first only to
  do A later means building the "browse only" refusal copy (§4) and then deleting it — pure waste for a change
  this small. Land it as this round's own contract entry (main's later history, not yet in this checkout, already
  reserves **contract 1.8** for "TUI round 5" per commit `aa7dc3c`'s message — confirm the number before writing
  the header, §6 Q1).

### 5.2 Where does the fuzzy picker live: the command palette, or a dedicated overlay?

- **Option A — grow the palette's `S-ARG` machinery** to accept a dynamic (not compile-time) `values` source for
  `/model`'s arg 0. Keeps everything inside one mechanism.
- **Option B — a dedicated picker**, mirroring `/resume`: `/model` with no argument opens a full-pane picker keyed
  to the composer text (reusing `rank`-style fuzzy filtering, this time over `rankModels`), `/model <id>` (typed
  directly, bypassing the picker) is `kind: 'run'`-style free text validated at dispatch via `findModel`/
  `nearMisses`.
- **Recommendation: B.** §1.4 already shows the palette's static `ArgSpec.values` was sized for a handful of enum
  members (`/mode`'s 4, `/budget`'s 5), not a 400+-row catalogue that also needs a background refresh and a
  provenance row per provider; forcing it through S-ARG would need a parallel spinner/async story the palette's
  synchronous `paletteRows` has nowhere to hang. `/resume` already proves the "bare command opens a dedicated
  picker, typed argument validates directly" split works for exactly this shape of problem in this codebase.

### 5.3 Does the onboarding wizard grow to 7 providers, or stay binary?

- **Option A — widen the wizard.** Add `openai`/`gemini`/`xai`/`fireworks`/`meta` to `WizardProvider`, `KEY_PREFIXES`,
  the `options` step, `PROVIDER_ENV`/`PROVIDER_DISPLAY`.
- **Option B — leave the wizard exactly as-is** (still the fast anthropic/openrouter/typesafe first-run path); add
  the other five entirely through `/provider <id>` (post-first-run) plus a widened `jevcode login --provider <id>`
  / `/login <id>`, which is a much shallower surface (one masked field, one verify call, no multi-step state
  machine).
- **Recommendation: B.** §1.3 shows the reducer is a three-design-round-hardened state machine with real
  documented edge cases (paste-twice, pasted-newline-as-Enter, OpenRouter-key-reuse-for-Jev). None of those edges
  are provider-specific in a way that adding 5 more branches simplifies; all of them multiply. A user's first run
  needs *one* working key fast (today: anthropic or openrouter) — a sixth provider is an opt-in a settled user
  reaches for deliberately, which `/provider`+`/login` already serves without touching the hardened path at all.

### 5.4 How does key verification for the 5 new providers work: reuse the priced decider probe, or the free catalogue check?

- **Option A — extend `login.ts`'s priced 1-token probe** to the new providers.
- **Option B — call `models/verify.ts`'s free `verifyProvider`/`verifyProviders`** instead.
- **Recommendation: B, unconditionally, independent of §5.1's outcome.** §1.3 shows the priced probe verifies the
  **decider** (Jev) path, which is meaningless for a key that (until §5.1 lands) is catalogue-only; even after
  §5.1, `verifyProvider` is free, already provider-agnostic across all 7, already redacted, and already returns
  exactly the fields a key-setup flow wants (`ok`, `latencyMs`, `modelCount`). There is no reason to spend a token
  to prove an OpenAI key merely lists models.

### 5.5 One `apiKey` per provider on disk, or keep the single-slot file?

- **Option A — widen `CredentialsFile`** to `apiKeys?: Partial<Record<ProviderId, string>>`, letting `jevcode
  login` remember more than one provider's key at a time and `/provider` swap between saved keys with no re-entry.
- **Option B — keep the single `apiKey`+`provider` pair** (§1.6); a user who wants two providers available
  simultaneously exports both as env vars (already fully supported by `PROVIDER_KEY_ENV`'s per-provider lookup),
  and `jevcode login`'s saved file stays "whichever provider you logged into last."
- **Recommendation: B for this round.** The env-var path already gives a power user every provider at once with
  zero file-format change; widening `CredentialsFile` is a real migration (existing `config.json` files, `jevcode
  logout`'s semantics, `--config` path handling) for a convenience (skip re-pasting a key when switching providers
  via `/provider`) that most users hit rarely. Revisit only if `/provider` cycling turns out to be a frequent
  workflow once shipped — flagged as a explicit follow-up, not closed off (§6 Q3).

### 5.6 Render `jevcode models` / `/model`'s catalogue output through round 4's block grammar or ad hoc strings?

- **Recommendation:** through round 4's `block(head, rows: BlockRow[], opts)` (`TUI-DESIGN-4.md` §3.1, D-U) once
  it lands — a `table` row kind for the ranked list, `kv` for a single model's detail, `note` for `errorLabel`
  rows — since round 4 explicitly lands before round 5 implements (per this round's own repo rules) and every
  other command's output is moving to this grammar in the same wave; writing `/model`'s output as a one-off
  `string[]` block would be dead on arrival the moment round 4 merges.

### 5.7 Fix the eight hardcoded 2-provider tables (§1.2) regardless of the above

**Recommendation: yes, as its own small, low-risk change, not gated on §5.1-§5.5.** Each of the eight sites should
import `keyEnvNames`/`PROVIDER_IDS`/`providerDisplayName` from `provider/ids.ts`/`models/providers.ts` instead of
repeating a private copy — this is what `models/providers.ts:24-32` itself already did once and documents as the
pattern. Doing this first, before §5.1 lands, has no behavioural effect (the two live providers' env vars and base
URLs are unchanged) but removes eight places that will otherwise silently drift again the next time a provider is
added.

## 6. Open questions

1. Main's later history (not present in this checkout) already carries a commit message ("contract numbers 1.8
   (TUI round 5) and 1.9 (Fastlane / HARNESS-NEXT) assigned") that this worktree's `docs/DECISIONS.md` does not
   show (`git merge-base --is-ancestor aa7dc3c HEAD` → no). Is contract **1.8** actually reserved for round 5's
   provider/model widening specifically, or for something else in round 5 — should this topic's contract entry
   (§5.1) claim 1.8, or ask the owner first?
2. §5.1 recommends widening `GeneratorConfig.provider`/`ProviderName` as part of round 5. `src/core/types.ts` is
   listed as harness-owned "other than TUI contract blocks" — is a widening of these two *specific* unions (used
   by TUI-owned `/provider`, the wizard, and `config/validate.ts`) something round 5's TUI slot may add as its own
   contract block, or does it need the harness peer session to land it (since `src/provider/registry.ts` and
   `src/config/validate.ts` sit on different sides of the file-ownership line for this one change)?
3. §5.5 recommends keeping the single-slot credentials file. Is there already a known user request or a peer
   design (Fastlane/HARNESS-NEXT, contract 1.9) that assumes multiple saved provider keys, which would force
   Option A sooner?
4. §1.7's redaction gap (no xAI/Fireworks/Meta `FORMAT_PATTERNS` entries in `src/core/redact.ts`, harness-owned) —
   is adding those three prefix families already planned, or should this topic file it as a dependency the way
   the contract digest files harness gaps for other rounds?
5. §5.4 assumes `verifyProvider`'s free catalogue GET is an acceptable "does this key work" answer for a key-setup
   flow. Is there a project reason (cost, or a wish to prove the *generation* path specifically) to still want a
   priced probe for the 5 new providers once §5.1 lands, rather than the free check staying the permanent answer?
6. Should `jevcode models refresh` be allowed to run unattended (e.g. from a shell prompt hook) given it touches
   the network for up to seven providers at once, or should it always require the same explicit user action the
   picker's own refresh does (project rule: "fetch-on-demand", never silent)?
