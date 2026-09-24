/**
 * The provider ids and their key environment variables — the single source of truth for both.
 *
 * FIRST-FRAME RULE: this file has ZERO imports and must never gain one (not even a type-only one). The config layer
 * (src/config/**) and the argv path run before the first frame is painted and need the id list and the key-env names;
 * for those two facts they read this file and nothing else. The two tables that used to declare their own copies now
 * derive from here, and neither may be pulled onto that path:
 *  - src/provider/registry.ts loads every adapter (seven HTTP clients) to build its factory rows;
 *  - src/models/** loads the catalogue, the disk cache and the search index.
 * Either would cost all of that to read seven strings. A test (test/unit/provider/ids.test.ts) reads this file as
 * text and fails on an import statement, so the rule is a gate rather than a convention.
 *
 * Membership is the registry's: `mock` / `null` are test doubles, and `typesafe` is the Jev DECIDER endpoint
 * (src/jev/providers.ts), not a generator — neither is an id here.
 */

/** Every provider the harness can talk to. */
export type ProviderId = 'anthropic' | 'openrouter' | 'openai' | 'gemini' | 'xai' | 'fireworks' | 'meta';

/**
 * Every id, in display order: the two the harness shipped with first, then the five 2026-09 additions. The order is
 * load-bearing — the catalogue picker breaks a score tie on it (src/models/search.ts `providerRank`), so of two
 * equally good models the one from the provider earlier in this list wins.
 */
export const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openrouter', 'openai', 'gemini', 'xai', 'fireworks', 'meta'];

/**
 * The environment variables a key may come from, in lookup order: JevCode's own name is always FIRST, a vendor SDK's
 * name is accepted after it. Two providers have a second name — `gemini` (the Google SDKs read GOOGLE_API_KEY) and
 * `meta` (the Model API docs name MODEL_API_KEY) — and for a user who has set both spellings the JevCode one wins.
 *
 * Typed as a non-empty tuple rather than a bare `readonly string[]` so that "every provider names at least one
 * variable" is the compiler's business and `PROVIDER_KEY_ENV[id][0]` — the canonical name, which is what
 * registry.ts stores — is a `string` under `noUncheckedIndexedAccess`. To every consumer it is a `readonly string[]`.
 */
export const PROVIDER_KEY_ENV: Readonly<Record<ProviderId, readonly [string, ...string[]]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  xai: ['XAI_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  meta: ['META_API_KEY', 'MODEL_API_KEY'],
};

/**
 * The GENERATOR base URL per provider — what `src/provider/registry.ts` rows and the adapters' own `*_BASE_URL`
 * constants read, and the seven-entry form of the config layer's `BASE_URLS` (TUI-DESIGN-5 §8.2 R14). `anthropic`
 * deliberately carries no `/v1`: `src/provider/anthropic.ts` appends its own version segment. These are NOT the
 * catalogue's `origin + versionPath` (the two agree for six of the seven and differ for `anthropic`). No trailing slash.
 */
export const PROVIDER_BASE_URL: Readonly<Record<ProviderId, string>> = {
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  meta: 'https://api.meta.ai/v1',
};

/**
 * The generator model each provider runs when the user names none: its latest fast model. `generator.model`'s default
 * layer resolves through this table keyed on the resolved provider (src/config/resolve.ts), so `--provider openai` alone
 * sends `gpt-5.6-luna`, never the OpenRouter id. `src/provider/registry.ts` rows and the adapters' `*_DEFAULT_MODEL`
 * constants read it; `openrouter` is config/defaults.ts `DEFAULT_MODEL` (a unit test pins the two equal).
 */
export const PROVIDER_DEFAULT_MODEL: Readonly<Record<ProviderId, string>> = {
  anthropic: 'claude-sonnet-5',
  openrouter: 'z-ai/glm-5.3-flash',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.8-flash',
  xai: 'grok-4.7',
  fireworks: 'accounts/fireworks/models/glm-5p3-flash',
  meta: 'muse-spark-1.3',
};

/**
 * What a picker column, a key-setup title, a registry row and an error label call each provider (R14). One spelling
 * per provider: the registry used to say `'xAI (Grok)'` while the catalogue said `'xAI'`; the catalogue's strings are
 * the ones the TUI pins (TUI-DESIGN-5 §12), so they are the table.
 */
export const PROVIDER_DISPLAY_NAME: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  xai: 'xAI',
  fireworks: 'Fireworks AI',
  meta: 'Meta',
};

/** Whether an untrusted string is a provider id. Reads no prototype key: `'toString'` is not an id. */
export function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

/** The environment variables holding `id`'s key, in lookup order (JevCode's own name first). */
export function keyEnvNames(id: ProviderId): readonly string[] {
  return PROVIDER_KEY_ENV[id];
}
