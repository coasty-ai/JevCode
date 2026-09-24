/**
 * TUI-DESIGN-5 §10 R5-6 `config/provider.test.ts`: all seven ids resolve their env names **including**
 * `GOOGLE_API_KEY` and `MODEL_API_KEY` (the live bug of §6.3 row 1); `validate.ts` accepts all seven once R9 lands
 * and rejects a non-id.
 *
 * Plus §8.2 R14: `src/config/provider-tables.ts` is DELETED and `PROVIDER_BASE_URL` / `PROVIDER_DISPLAY_NAME` live
 * in `src/provider/ids.ts` beside `PROVIDER_KEY_ENV` — one zero-import home, read by the config layer and the argv
 * path, where one import would put the provider HTTP stack in front of the first frame.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDER_BASE_URL, PROVIDER_DISPLAY_NAME, PROVIDER_IDS, PROVIDER_KEY_ENV, isProviderId, keyEnvNames } from '../../../src/provider/ids.js';
import { PROVIDER_DISPLAY, PROVIDER_ENV } from '../../../src/tui/onboarding/lines.js';
import { BASE_URLS } from '../../../src/config/defaults.js';
import { validateGenerator, type SettingReader } from '../../../src/config/validate.js';
import { ConfigError } from '../../../src/errors.js';
import type { ProviderId } from '../../../src/provider/ids.js';

/**
 * Totality over `ProviderId`, checked by the compiler here once: a missing or misspelled id is a build error, not
 * a runtime hole.
 */
function totalOverProviderId(t: Readonly<Record<ProviderId, string>>): Readonly<Record<ProviderId, string>> {
  return t;
}
totalOverProviderId(PROVIDER_BASE_URL);
totalOverProviderId(PROVIDER_DISPLAY_NAME);

type Name = Parameters<SettingReader['get']>[0];
function reader(values: Partial<Record<Name, string>>): SettingReader {
  return { get: (n) => (values[n] === undefined ? undefined : { value: values[n], source: 'env' }), sources: () => ['--provider (flag)'] };
}

describe('every provider resolves its key env names (§6.3 row 1 — a LIVE bug today)', () => {
  it('all seven ids are covered, with jevcode’s own name first', () => {
    expect(PROVIDER_IDS).toHaveLength(7);
    for (const id of PROVIDER_IDS) {
      const names = keyEnvNames(id);
      expect(names.length).toBeGreaterThanOrEqual(1);
      expect(names[0]).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/);
    }
  });

  it('the two providers with a SECOND name are gemini and meta — GOOGLE_API_KEY and MODEL_API_KEY', () => {
    expect(keyEnvNames('gemini')).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    expect(keyEnvNames('meta')).toEqual(['META_API_KEY', 'MODEL_API_KEY']);
    // and they are exactly the two: a third would need a row in §6.3 and a line in `config/resolve.ts`
    expect(PROVIDER_IDS.filter((id) => PROVIDER_KEY_ENV[id].length > 1)).toEqual(['gemini', 'meta']);
  });

  it('`src/config/resolve.ts`’s private two-entry table STILL shadows them (the bug, pinned until R5-3 lands §6.3 row 1)', () => {
    const src = readFileSync('src/config/resolve.ts', 'utf8');
    const priv = /const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = \{([^}]*)\}/.exec(src);
    if (priv === null) {
      // R5-3 landed the fix: the private table is gone and `provider/ids.ts` is the source
      expect(src).toContain("from '../provider/ids.js'");
      return;
    }
    // not yet: this assertion is the reason the bug cannot be forgotten — `gemini` and `meta` are unreachable
    expect(priv[1]).not.toContain('gemini');
    expect(priv[1]).not.toContain('meta');
  });

  it('isProviderId accepts the seven and nothing else, and reads no prototype key', () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true);
    for (const s of ['', 'mock', 'typesafe', 'Anthropic', 'toString', 'constructor', '__proto__']) expect(isProviderId(s)).toBe(false);
  });
});

describe('validate.ts and the seven (§6.1, D-AP / §8.2 R9)', () => {
  const base: Partial<Record<Name, string>> = { 'generator.model': 'claude-sonnet-5', 'generator.apiKey': 'anthropic-key-1234', 'generator.maxTokens': '4096', 'limits.spendCapUsd': '2' };
  const warn = (): void => undefined;
  const validate = (id: string): { provider: string } => validateGenerator(reader({ ...base, 'generator.provider': id }), warn, { allowUnpriced: true });
  /**
   * §10's row reads "accepts all seven **once R9 lands**". R9/D-AP's widening of `ProviderName` and
   * `GeneratorConfig.provider` landed in W0, but the RUNTIME two-name check at `src/config/validate.ts:161` is
   * R5-3's file (§9.2, `src/config/{types,defaults,validate}.ts`), landed in its one W4 PR from R5-6's hunk. This
   * test asserts whichever state the tree is in and flips itself when the hunk lands, so it can never go stale.
   */
  const twoNameCheckStillThere = readFileSync('src/config/validate.ts', 'utf8').includes("provider !== 'anthropic' && provider !== 'openrouter'");

  it('accepts anthropic and openrouter always, and the other five once R5-3 lands the isProviderId hunk', () => {
    expect(validate('anthropic').provider).toBe('anthropic');
    expect(validate('openrouter').provider).toBe('openrouter');
    for (const id of PROVIDER_IDS.filter((p) => p !== 'anthropic' && p !== 'openrouter')) {
      if (twoNameCheckStillThere) expect(() => validate(id)).toThrow(/one of anthropic\|openrouter/);
      else expect(validate(id).provider).toBe(id);
    }
  });

  it('rejects a non-id either way', () => {
    expect(() => validate('llama')).toThrow(ConfigError);
    expect(() => validate('mock')).toThrow(ConfigError);
  });

  it('the type half of D-AP HAS landed: GeneratorConfig.provider and ProviderName are ProviderId (contract 1.8 item 6)', () => {
    const src = readFileSync('src/core/types.ts', 'utf8');
    expect(src).toMatch(/export type ProviderName = ProviderId \| 'mock';/);
    expect(src).toMatch(/provider: ProviderId;/);
  });
});

describe('§8.2 R14 — the tables live in src/provider/ids.ts and config/provider-tables.ts is gone', () => {
  it('src/config/provider-tables.ts no longer exists and nothing imports it', () => {
    expect(existsSync('src/config/provider-tables.ts')).toBe(false);
    for (const f of ['src/config/defaults.ts', 'src/cli/login.ts', 'src/tui/onboarding/lines.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toContain('provider-tables');
    }
    // `defaults.ts` re-exports the ids table under the config layer's historical name
    expect(readFileSync('src/config/defaults.ts', 'utf8')).toContain("export { PROVIDER_BASE_URL as BASE_URLS } from '../provider/ids.js';");
  });

  it('src/provider/ids.ts still has ZERO imports — one would put the catalogue on the argv path', () => {
    const src = readFileSync('src/provider/ids.ts', 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).toContain('ZERO imports');
  });

  it('both tables are total over ProviderId and carry no empty value', () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_BASE_URL[id]).toMatch(/^https:\/\/\S+$/);
      expect(PROVIDER_DISPLAY_NAME[id].trim()).not.toBe('');
    }
    expect(Object.keys(PROVIDER_BASE_URL).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(Object.keys(PROVIDER_DISPLAY_NAME).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it('it AGREES with the two-entry tables it is the superset of, so the swap is behaviour-neutral (§6.3)', () => {
    // `config/defaults.ts` BASE_URLS is now an alias of this very table (§6.3 row 2, R14)
    expect(PROVIDER_BASE_URL.anthropic).toBe(BASE_URLS.anthropic);
    expect(PROVIDER_BASE_URL.openrouter).toBe(BASE_URLS.openrouter);
    // `tui/onboarding/lines.ts` PROVIDER_DISPLAY reads this table (§6.3 row 5, R14); PROVIDER_ENV stays its own
    expect(PROVIDER_DISPLAY_NAME.anthropic).toBe(PROVIDER_DISPLAY.anthropic);
    expect(PROVIDER_DISPLAY_NAME.openrouter).toBe(PROVIDER_DISPLAY.openrouter);
    expect(keyEnvNames('anthropic')[0]).toBe(PROVIDER_ENV.anthropic);
    expect(keyEnvNames('openrouter')[0]).toBe(PROVIDER_ENV.openrouter);
  });

  it('anthropic’s base URL deliberately carries no version segment (the adapter appends /v1)', () => {
    expect(PROVIDER_BASE_URL.anthropic).toBe('https://api.anthropic.com');
    expect(PROVIDER_BASE_URL.openai).toBe('https://api.openai.com/v1');
  });
});

describe('the two-provider shadow tables of §6.3, row by row', () => {
  it('row 3: CredentialsPatch.provider is ProviderId (compile-time, asserted by the source)', () => {
    expect(readFileSync('src/config/credentials.ts', 'utf8')).toMatch(/provider\?: ProviderId;/);
  });
  it('row 4: WizardProvider deliberately stays two-member (D-AR), and says so', () => {
    const src = readFileSync('src/tui/onboarding/reducer.ts', 'utf8');
    expect(/export type WizardProvider = '(anthropic|openrouter)' \| '(anthropic|openrouter)'/.test(src)).toBe(true);
  });
  it('src/cli/args.ts names PROVIDER_IDS rather than re-declaring the pair', () => {
    const src = readFileSync('src/cli/args.ts', 'utf8');
    expect(src).toContain("import { PROVIDER_IDS } from '../provider/ids.js';");
    expect(src).not.toMatch(/oneOf\(command, 'provider', flags\.provider, \['anthropic', 'openrouter'\]\)/);
  });
});
