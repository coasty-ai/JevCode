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

/** Whether an untrusted string is a provider id. Reads no prototype key: `'toString'` is not an id. */
export function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

/** The environment variables holding `id`'s key, in lookup order (JevCode's own name first). */
export function keyEnvNames(id: ProviderId): readonly string[] {
  return PROVIDER_KEY_ENV[id];
}
