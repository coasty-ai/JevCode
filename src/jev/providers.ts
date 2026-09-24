/**
 * The two Jev providers as one table (TUI-DESIGN-2 §2.2, §2.5; measured in docs/research/tui/round-2/typesafe-native-probe.md):
 * OpenRouter's decisions router (today's path) and TypeSafe's native endpoint. Pure — no I/O, no imports from the client, so
 * config/validate.ts, loop/engine.ts and jev/client.ts can all read it without a cycle. `JevProvider` and `JevProviderSource`
 * are declared in core/types.ts (§6 item 4) and re-exported here so `import { JevProvider } from './providers.js'` reads as §2.2.
 */
import type { JevProvider } from '../core/types.js';
import { APP_TITLE, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, DEFAULT_TYPESAFE_BASE_URL, DEFAULT_TYPESAFE_MODEL, JEV_INPUT_USD_PER_TOKEN } from './types.js';

export type { JevProvider, JevProviderSource } from '../core/types.js';

export interface JevProviderSpec {
  readonly name: JevProvider;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** prepended to the key lookup when the provider is explicit or typesafe-inferred (§2.3 step 3) */
  readonly keyEnv: string;
  readonly headers: (apiKey: string, referer: string) => Record<string, string>;
  readonly requestIdHeaders: readonly string[];
  readonly isPinned: (normalisedId: string) => boolean;
  readonly aliases: readonly string[];
  readonly pricing: { inputUsdPerToken: number; outputUsdPerToken: number };
  readonly displayHost: string;
  /** the `TypeSafe accepts …` / `OpenRouter accepts …` hint appended to the unknown-model ConfigError (§2.4) */
  readonly accepts: string;
}

/** Lowercase, trimmed, without a leading `typesafe/` (REPORT §2 accepts every one of these forms). Moved here from jev/client.ts, which re-exports it. */
export function normaliseModelId(id: string): string {
  const t = id.trim().toLowerCase();
  return t.startsWith('typesafe/') ? t.slice('typesafe/'.length) : t;
}

export const JEV_PROVIDERS: Readonly<Record<JevProvider, JevProviderSpec>> = {
  openrouter: {
    name: 'openrouter',
    baseUrl: DEFAULT_JEV_BASE_URL,
    defaultModel: DEFAULT_JEV_MODEL,
    keyEnv: 'OPENROUTER_API_KEY',
    displayHost: 'openrouter.ai',
    headers: (k, referer) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'HTTP-Referer': referer, 'X-Title': APP_TITLE }),
    requestIdHeaders: ['request-id', 'x-request-id', 'x-generation-id'],
    isPinned: (id) => /-\d{8}$/.test(id),
    aliases: ['jev-1.13', 'jev-latest'],
    pricing: { inputUsdPerToken: JEV_INPUT_USD_PER_TOKEN, outputUsdPerToken: 0 },
    accepts: 'OpenRouter accepts typesafe/jev-1.13-20260917 or typesafe/jev-1.13',
  },
  typesafe: {
    name: 'typesafe',
    baseUrl: DEFAULT_TYPESAFE_BASE_URL,
    defaultModel: DEFAULT_TYPESAFE_MODEL,
    keyEnv: 'TYPESAFE_API_KEY',
    displayHost: 'api.typesafe.ai',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    requestIdHeaders: ['x-typesafe-request-id', 'request-id', 'x-request-id'],
    isPinned: (id) => /^jev-\d+\.\d+\.\d+$/.test(id),
    // `jev-1.13` is 400 on TypeSafe (§2.1, PROBE) and is rejected offline (§2.5)
    aliases: ['jev-latest'],
    pricing: { inputUsdPerToken: JEV_INPUT_USD_PER_TOKEN, outputUsdPerToken: 0 },
    accepts: 'TypeSafe accepts jev-1.13.0 or jev-latest',
  },
};

/** the same weights under two naming schemes (PROBE + REPORT §1); used by --resume reconciliation only */
export const EQUIVALENT_IDS: ReadonlyArray<readonly [openrouter: string, typesafe: string]> = [['jev-1.13-20260917', 'jev-1.13.0']];

/**
 * §2.5 --resume reconciliation: the id the same weights carry under `target`'s naming, or null when EQUIVALENT_IDS has no
 * row for `id` (an alias, an unknown id, or an id already in the target's naming — the caller compares those directly).
 */
export function equivalentJevModel(id: string, target: JevProvider): string | null {
  const n = normaliseModelId(id);
  for (const [openrouter, typesafe] of EQUIVALENT_IDS) {
    if (target === 'typesafe' && n === openrouter) return typesafe;
    if (target === 'openrouter' && n === typesafe) return openrouter;
  }
  return null;
}

/**
 * §2.5 / §12 `[run] decider provider changed <from> → <to> (same weights: <openrouter id> ≡ <typesafe id>)`: the EQUIVALENT_IDS row
 * `id` belongs to under either naming, or null (an alias, an unknown id).
 */
export function equivalentIdsRow(id: string): readonly [openrouter: string, typesafe: string] | null {
  const n = normaliseModelId(id);
  return EQUIVALENT_IDS.find(([openrouter, typesafe]) => n === openrouter || n === typesafe) ?? null;
}

/** §2.5: the two ids name the same weights — equal after normalisation, or one EQUIVALENT_IDS row in either order. */
export function sameJevWeights(a: string, b: string): boolean {
  const x = normaliseModelId(a);
  const y = normaliseModelId(b);
  if (x === y) return true;
  return EQUIVALENT_IDS.some(([openrouter, typesafe]) => (x === openrouter && y === typesafe) || (x === typesafe && y === openrouter));
}

/** 'api.typesafe.ai' → typesafe · 'openrouter.ai' → openrouter · else null (an unparsable URL is null too, never a throw). */
export function providerForHost(baseUrl: string): JevProvider | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const spec of Object.values(JEV_PROVIDERS)) if (spec.displayHost === host) return spec.name;
  return null;
}

/** §2.5: pinned under the provider's own naming (openrouter `-YYYYMMDD`, typesafe `jev-<major>.<minor>.<patch>`). */
export function isPinnedJevModel(id: string, provider: JevProvider): boolean {
  return JEV_PROVIDERS[provider].isPinned(normaliseModelId(id));
}

/**
 * §2.5: does the served id satisfy the configured one? Pinned → equality; `jev-latest` → any `jev-*`; another alias → itself
 * or itself with a dated suffix (`jev-1.13` → `jev-1.13-20260917`, openrouter only). No `.` branch: TypeSafe serves no unpatched
 * alias (400 `Unknown model: jev-1.13`, PROBE), so `jev-1.13` never matches `jev-1.13.0`.
 */
export function jevModelMatches(configured: string, served: string, provider: JevProvider): boolean {
  const c = normaliseModelId(configured);
  const s = normaliseModelId(served);
  if (isPinnedJevModel(configured, provider)) return c === s;
  return aliasMatches(c, s);
}

/**
 * §2.5, the alias half of `jevModelMatches` over already-normalised ids, shared with jev/client.ts `checkServedModel` and
 * loop/engine.ts `checkModelDrift`, which learn `pinned` from the DeciderConfig rather than from the naming: `jev-latest`
 * accepts any `jev-*`; another alias accepts itself or itself with a dated suffix (`jev-1.13` → `jev-1.13-20260917`). A bare
 * prefix test would let `jev-1.1` accept `jev-1.13-…`, and there is no `.` branch (TypeSafe serves no unpatched alias, PROBE).
 */
export function aliasMatches(configuredNormalised: string, servedNormalised: string): boolean {
  if (configuredNormalised === 'jev-latest') return servedNormalised.startsWith('jev-');
  return servedNormalised === configuredNormalised || servedNormalised.startsWith(`${configuredNormalised}-`);
}
