/**
 * Base URLs and display names for the seven provider ids — the R14 fallback (TUI-DESIGN-5 §6.3 row 2, §8.2 R14).
 *
 * FIRST-FRAME RULE, the same one `src/provider/ids.ts` states and a test enforces: this file has **ZERO imports**
 * and must never gain one (not even a type-only one). It exists because `src/config/defaults.ts:77`'s two-entry
 * `BASE_URLS` and `src/tui/onboarding/lines.ts:41`'s two-entry `PROVIDER_DISPLAY` re-declare the provider set, and
 * the prescribed fix — reading `providerSpec(id).baseUrl` / `providerDisplayName(id)` from `src/models/providers.ts`
 * — would put `src/provider/openrouter.js` (imported at `providers.ts:23`) on the argv path through
 * `config/defaults.ts` ← `cli/args.ts`, breaking `providers.ts:28–31`'s own stated rule and failing gate G-R5-1.
 *
 * **This module is deleted when §8.2 R14 lands `PROVIDER_BASE_URL` / `PROVIDER_DISPLAY_NAME` in
 * `src/provider/ids.ts`** (the right home: pure data beside `PROVIDER_KEY_ENV`, already zero-import). Until then
 * every TUI/config consumer reads them from here, so there is exactly one copy rather than seven.
 *
 * Totality against `ProviderId` is a compile-time assertion in `test/unit/config/provider.test.ts`, not an
 * annotation here — an annotation would need the import this module may not make.
 *
 * Values, verified 2026-09-22 against the modules that own them:
 *  - base URLs are the **generator** base URLs of `src/provider/registry.ts:176–256` (`ProviderSpec.baseUrl`), which
 *    is what `BASE_URLS` feeds; they are NOT the catalogue's `origin + versionPath` (the two agree for six of the
 *    seven and differ for `anthropic`, whose generator base URL carries no `/v1`).
 *  - display names are `src/models/providers.ts`'s `PROVIDERS[id].displayName` — the picker's column, which is what
 *    §12 S102's `errorLabel` prints. `src/provider/registry.ts:247` spells xAI `'xAI (Grok)'`; the two tables
 *    disagree today and R14 has to pick one. This file follows the catalogue, because the strings §12 pins are the
 *    catalogue's.
 */

/**
 * The generator base URL per provider id — the seven-entry form of `config/defaults.ts`'s `BASE_URLS`.
 * `anthropic` deliberately has no `/v1`: `src/provider/anthropic.ts` appends its own version segment.
 */
export const PROVIDER_BASE_URL = {
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  meta: 'https://api.meta.ai/v1',
} as const;

/** What a picker column, a key-setup title and `errorLabel` call each provider. */
export const PROVIDER_DISPLAY_NAME = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  xai: 'xAI',
  fireworks: 'Fireworks AI',
  meta: 'Meta',
} as const;
