/**
 * The single source of truth for provider ids and key env names, and the first-frame rule that makes it one:
 * `src/provider/ids.ts` must stay importless so the config layer can read the ids without loading an adapter or the
 * model catalogue. The text gate below is that rule; the rest check that the two derived tables still agree with it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDERS as REGISTRY_PROVIDERS } from '../../../src/provider/registry.js';
import { PROVIDERS as CATALOGUE_PROVIDERS, keyEnvNames as catalogueKeyEnvNames } from '../../../src/models/providers.js';
import { PROVIDER_BASE_URL, PROVIDER_DISPLAY_NAME, PROVIDER_IDS, PROVIDER_KEY_ENV, isProviderId, keyEnvNames, type ProviderId } from '../../../src/provider/ids.js';

const SOURCE = readFileSync(new URL('../../../src/provider/ids.ts', import.meta.url), 'utf8');

/** The file with its block and line comments stripped, so prose about importing cannot satisfy the gate either way. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ENV_NAME = /^[A-Z][A-Z0-9_]*_API_KEY$/;

describe('the first-frame rule', () => {
  it('src/provider/ids.ts contains no import statement at all', () => {
    expect(CODE).not.toMatch(/\bimport\b/);
    expect(CODE).not.toMatch(/\brequire\s*\(/);
    // an `export … from` is an import in disguise
    expect(CODE).not.toMatch(/\bfrom\s*['"]/);
  });

  it('states the rule in its own doc comment, so the next editor knows why', () => {
    expect(SOURCE).toMatch(/first-frame/i);
  });
});

describe('PROVIDER_IDS', () => {
  it('is the exact display order the picker breaks ties on', () => {
    expect(PROVIDER_IDS).toEqual(['anthropic', 'openrouter', 'openai', 'gemini', 'xai', 'fireworks', 'meta']);
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });

  it('covers exactly the registry rows and the catalogue table (no third list can drift)', () => {
    const ids = [...PROVIDER_IDS].sort();
    expect(REGISTRY_PROVIDERS.map((p) => p.id).sort()).toEqual(ids);
    expect(Object.keys(CATALOGUE_PROVIDERS).sort()).toEqual(ids);
    expect(Object.keys(PROVIDER_KEY_ENV).sort()).toEqual(ids);
  });

  it('holds no decider or test-double id', () => {
    for (const notAProvider of ['typesafe', 'mock', 'null']) expect(PROVIDER_IDS).not.toContain(notAProvider);
  });
});

describe('PROVIDER_KEY_ENV', () => {
  it('names at least one plausible variable per provider', () => {
    for (const id of PROVIDER_IDS) {
      const names = keyEnvNames(id);
      expect(names.length, id).toBeGreaterThan(0);
      for (const name of names) expect(name, id).toMatch(ENV_NAME);
      expect(new Set(names).size, id).toBe(names.length);
    }
  });

  it("puts jevcode's own name first, ahead of a vendor SDK's spelling", () => {
    expect(keyEnvNames('gemini')).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    expect(keyEnvNames('meta')).toEqual(['META_API_KEY', 'MODEL_API_KEY']);
    for (const id of PROVIDER_IDS) expect(keyEnvNames(id)[0], id).toBe(PROVIDER_KEY_ENV[id][0]);
  });

  it('is what both tables derive from: the registry stores the first name, the catalogue the whole list', () => {
    for (const spec of REGISTRY_PROVIDERS) expect(spec.keyEnv, spec.id).toBe(PROVIDER_KEY_ENV[spec.id][0]);
    for (const id of PROVIDER_IDS) {
      expect(CATALOGUE_PROVIDERS[id].keyEnv, id).toEqual(PROVIDER_KEY_ENV[id]);
      expect(catalogueKeyEnvNames(id), id).toEqual(keyEnvNames(id));
    }
  });
});

describe('PROVIDER_BASE_URL and PROVIDER_DISPLAY_NAME (R14: the two tables live beside the ids, zero-import)', () => {
  it('are total over PROVIDER_IDS and hold nothing else', () => {
    const ids = [...PROVIDER_IDS].sort();
    expect(Object.keys(PROVIDER_BASE_URL).sort()).toEqual(ids);
    expect(Object.keys(PROVIDER_DISPLAY_NAME).sort()).toEqual(ids);
  });

  it('base URLs are https origins with an optional version path and no trailing slash; anthropic alone carries no version segment', () => {
    for (const id of PROVIDER_IDS) {
      const url = PROVIDER_BASE_URL[id];
      expect(url, id).toMatch(/^https:\/\/[a-z0-9.-]+(\/[a-z0-9./-]*[a-z0-9])?$/);
      expect(url.endsWith('/'), id).toBe(false);
    }
    expect(PROVIDER_BASE_URL.anthropic).toBe('https://api.anthropic.com');
    for (const id of PROVIDER_IDS) if (id !== 'anthropic') expect(PROVIDER_BASE_URL[id], id).toMatch(/\/v1(beta)?$/);
  });

  it('is what the registry rows read: every generator baseUrl and displayName equals the table (no second spelling of xAI)', () => {
    for (const spec of REGISTRY_PROVIDERS) {
      expect(spec.baseUrl, spec.id).toBe(PROVIDER_BASE_URL[spec.id]);
      expect(spec.displayName, spec.id).toBe(PROVIDER_DISPLAY_NAME[spec.id]);
    }
    expect(PROVIDER_DISPLAY_NAME.xai).toBe('xAI');
  });

  it('is what the catalogue table reads for display names, and agrees with its origin + versionPath for the six versioned providers', () => {
    for (const id of PROVIDER_IDS) {
      expect(CATALOGUE_PROVIDERS[id].displayName, id).toBe(PROVIDER_DISPLAY_NAME[id]);
      const cat = CATALOGUE_PROVIDERS[id] as { origin?: string; versionPath?: string };
      if (id !== 'anthropic' && cat.origin !== undefined && cat.versionPath !== undefined) {
        expect(`${cat.origin}${cat.versionPath}`.replace(/\/$/, ''), id).toBe(PROVIDER_BASE_URL[id]);
      }
    }
  });

  it('display names are short, human, unique', () => {
    const names = PROVIDER_IDS.map((id) => PROVIDER_DISPLAY_NAME[id]);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Za-z][A-Za-z ]{1,19}$/);
  });
});

describe('isProviderId', () => {
  it('accepts every id and nothing else', () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id), id).toBe(true);
    for (const s of ['', 'nope', 'typesafe', 'mock', 'Anthropic', ' anthropic', 'toString', 'constructor', '__proto__']) {
      expect(isProviderId(s), s).toBe(false);
    }
  });

  it('narrows the type for the compiler', () => {
    const raw: string = 'xai';
    if (!isProviderId(raw)) throw new Error('unreachable');
    const id: ProviderId = raw;
    expect(keyEnvNames(id)).toEqual(['XAI_API_KEY']);
  });
});
