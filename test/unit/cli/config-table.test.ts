/**
 * TUI-DESIGN §16 / §24 (CLI): the `jevcode config` table lines — derived rows print `(default: …)`
 * (`session.spendCapUsd  $10.000 (default: 5 × limits.spendCapUsd)`), `<setting>.ignored` rows sit beside their
 * effective row with `ignored:launch`, secrets stay fingerprints, the sandbox footer twins the `[sandbox]` item.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigRecordValue } from '../../../src/core/types.js';
import { SANDBOX_FOOTER, configTableLines, configTableRows, configValueText } from '../../../src/cli/config-table.js';

const record: Record<string, ConfigRecordValue> = {
  'generator.provider': { value: 'anthropic', source: 'default' },
  'generator.apiKey': { value: { source: 'env ANTHROPIC_API_KEY', fingerprint: 'e31150e9' }, source: 'env' },
  'limits.spendCapUsd': { value: '2', source: 'flag' },
  'ui.fps': { value: '30', source: 'default' },
  'ui.renderMode': { value: 'standard', source: 'default' },
  'session.spendCapUsd': { value: '10', source: 'derived' },
  'limits.maxGeneratorTokens': { value: '133333', source: 'derived' },
  'generator.priceCacheReadPerM': { value: '0.3', source: 'derived' },
  'generator.priceCacheWritePerM': { value: '3.75', source: 'derived' },
  'ui.fps.ignored': { value: '20', source: 'ignored:launch' },
  'ui.screenReader.ignored': { value: 'true', source: 'ignored:launch' },
};

describe('configValueText (§16)', () => {
  it('renders derived rows with their derivation, money with three decimals, secrets as fingerprints', () => {
    expect(configValueText('session.spendCapUsd', record['session.spendCapUsd']!)).toBe('$10.000 (default: 5 × limits.spendCapUsd)');
    expect(configValueText('limits.maxGeneratorTokens', record['limits.maxGeneratorTokens']!)).toBe('133333 (default: limits.spendCapUsd / 15 × 1e6)');
    expect(configValueText('generator.priceCacheReadPerM', record['generator.priceCacheReadPerM']!)).toBe('0.3 (default: 0.1 × generator.priceInPerM)');
    expect(configValueText('generator.priceCacheWritePerM', record['generator.priceCacheWritePerM']!)).toBe('3.75 (default: 1.25 × generator.priceInPerM)');
    expect(configValueText('limits.spendCapUsd', record['limits.spendCapUsd']!)).toBe('$2.000');
    expect(configValueText('session.spendCapUsd', { value: 'none', source: 'flag' })).toBe('none');
    expect(configValueText('session.spendCapUsd', { value: 'Infinity', source: 'session:/budget' })).toBe('none');
    expect(configValueText('generator.apiKey', record['generator.apiKey']!)).toBe('<env ANTHROPIC_API_KEY> (sha256:e31150e9)');
    expect(configValueText('x.y', { value: '1', source: 'derived' })).toBe('1 (derived)');
    expect(configValueText('ui.fps', record['ui.fps']!)).toBe('30');
  });
});

describe('configTableRows / configTableLines (§16)', () => {
  it('places every .ignored row directly after its effective row, keeps record order otherwise, and explains ignored:launch', () => {
    const rows = configTableRows(record);
    const settings = rows.map((r) => r.setting);
    expect(settings.indexOf('ui.fps.ignored')).toBe(settings.indexOf('ui.fps') + 1);
    expect(settings.slice(0, 5)).toEqual(['generator.provider', 'generator.apiKey', 'limits.spendCapUsd', 'ui.fps', 'ui.fps.ignored']);
    // no effective row for ui.screenReader in this record: the ignored row is kept at the end, never dropped
    expect(settings[settings.length - 1]).toBe('ui.screenReader.ignored');
    const fps = rows.find((r) => r.setting === 'ui.fps.ignored')!;
    expect(fps.value).toBe('20');
    expect(fps.source).toBe('ignored:launch (a launch setting: use the flag or the environment variable)');
    expect(rows.find((r) => r.setting === 'session.spendCapUsd')).toEqual({ setting: 'session.spendCapUsd', value: '$10.000 (default: 5 × limits.spendCapUsd)', source: 'derived' });
    expect(rows).toHaveLength(Object.keys(record).length);
  });

  it('aligns the columns under a header and ends with the sandbox footer', () => {
    const lines = configTableLines(record, { sandboxLevel: 'seatbelt' });
    expect(lines[0]).toMatch(/^setting\s+value\s+source$/);
    const w0 = Math.max(...Object.keys(record).map((k) => k.length));
    for (const l of lines.slice(1, -2)) expect(l.slice(w0, w0 + 2)).toBe('  ');
    expect(lines).toContain(`${'session.spendCapUsd'.padEnd(w0)}  ${'$10.000 (default: 5 × limits.spendCapUsd)'.padEnd(Math.max(...configTableRows(record).map((r) => r.value.length)))}  derived`);
    expect(lines[lines.length - 2]).toBe('');
    expect(lines[lines.length - 1]).toBe(SANDBOX_FOOTER.seatbelt);
    expect(configTableLines({}, { sandboxLevel: 'none' }).at(-1)).toBe(SANDBOX_FOOTER.none);
    expect(configTableLines({}, { sandboxLevel: 'none' })[0]).toBe('setting  value  source');
  });
});

describe('TUI-DESIGN-2 §2.6: the decider.provider row, provider-keyed defaults and the folded providerSource row', () => {
  const rec: Record<string, ConfigRecordValue> = {
    'decider.provider': { value: 'typesafe', source: 'derived' },
    'decider.baseUrl': { value: 'https://api.typesafe.ai/v1/systemone', source: 'default' },
    'decider.apiKey': { value: { source: 'dotenv:/Users/me/proj/.env', fingerprint: '3f9a2c1d' }, source: 'dotenv:/Users/me/proj/.env' },
    'decider.model': { value: 'jev-1.13.0', source: 'default' },
    'decider.providerSource': { value: 'auto:typesafe-key', source: 'derived' },
  };

  it('prints the §2.6 block: `derived (auto: TYPESAFE_API_KEY is set)`, `default (typesafe)`, the fingerprint; providerSource is not a row', () => {
    const rows = configTableRows(rec);
    expect(rows).toEqual([
      { setting: 'decider.provider', value: 'typesafe', source: 'derived (auto: TYPESAFE_API_KEY is set)' },
      { setting: 'decider.baseUrl', value: 'https://api.typesafe.ai/v1/systemone', source: 'default (typesafe)' },
      { setting: 'decider.apiKey', value: '<dotenv:/Users/me/proj/.env> (sha256:3f9a2c1d)', source: 'dotenv:/Users/me/proj/.env' },
      { setting: 'decider.model', value: 'jev-1.13.0', source: 'default (typesafe)' },
    ]);
    const lines = configTableLines(rec, { sandboxLevel: 'none' });
    expect(lines[1]).toMatch(/^decider\.provider\s+typesafe\s+derived \(auto: TYPESAFE_API_KEY is set\)$/);
    expect(lines[2]).toMatch(/^decider\.baseUrl\s+https:\/\/api\.typesafe\.ai\/v1\/systemone\s+default \(typesafe\)$/);
    expect(lines[4]).toMatch(/^decider\.model\s+jev-1\.13\.0\s+default \(typesafe\)$/);
    expect(lines.some((l) => l.includes('providerSource'))).toBe(false);
  });

  it('every providerSource has its derivation text; an explicit source prints itself; a configured model keeps its source', () => {
    const at = (source: ConfigRecordValue['source'], providerSource: string): string => configTableRows({ 'decider.provider': { value: 'openrouter', source }, 'decider.providerSource': { value: providerSource, source: 'derived' } })[0]!.source;
    expect(at('derived', 'auto:openrouter-key')).toBe('derived (auto: JEV_API_KEY or OPENROUTER_API_KEY is set)');
    expect(at('derived', 'auto:base-url')).toBe('derived (auto: decider.baseUrl names it)');
    expect(at('derived', 'auto:something-new')).toBe('derived (auto:something-new)');
    expect(at('env', 'env')).toBe('env');
    expect(at('flag', 'flag')).toBe('flag');
    expect(at('default', 'default')).toBe('default');
    // no providerSource row (an older run.json): plain `derived`
    expect(configTableRows({ 'decider.provider': { value: 'typesafe', source: 'derived' } })[0]!.source).toBe('derived');
    const or = configTableRows({ 'decider.provider': { value: 'openrouter', source: 'env' }, 'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' }, 'decider.baseUrl': { value: 'https://proxy.test', source: 'flag' } });
    expect(or.map((r) => r.source)).toEqual(['env', 'default (openrouter)', 'flag']);
    // no provider row at all (a record from before the row): defaults print as before
    expect(configTableRows({ 'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' } })[0]!.source).toBe('default');
  });
});

describe('TUI-DESIGN-2 §2.6 edge rows: an unknown provider value, the `mode` row', () => {
  it('a record whose decider.provider value is not a provider (an older or hand-edited run.json) prints the raw value and plain `default` on the provider-keyed rows', () => {
    const rows = configTableRows({
      'decider.provider': { value: 'foo', source: 'env' },
      'decider.baseUrl': { value: 'https://openrouter.ai/api/alpha/decisions', source: 'default' },
      'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' },
      'decider.providerSource': { value: 'env', source: 'derived' },
    });
    expect(rows).toEqual([
      { setting: 'decider.provider', value: 'foo', source: 'env' },
      { setting: 'decider.baseUrl', value: 'https://openrouter.ai/api/alpha/decisions', source: 'default' },
      { setting: 'decider.model', value: 'typesafe/jev-1.13-20260917', source: 'default' },
    ]);
  });

  it('§1.2 / §12: `mode  jev-only  default` prints like any plain row; a file source prints its path', () => {
    expect(configTableRows({ mode: { value: 'jev-only', source: 'default' } })).toEqual([{ setting: 'mode', value: 'jev-only', source: 'default' }]);
    expect(configTableLines({ mode: { value: 'jev-only', source: 'default' } }, { sandboxLevel: 'none' })[1]).toMatch(/^mode\s+jev-only\s+default$/);
    expect(configTableRows({ mode: { value: 'jev-on', source: 'file:/Users/me/proj/jevcode.json' } })).toEqual([{ setting: 'mode', value: 'jev-on', source: 'file:/Users/me/proj/jevcode.json' }]);
  });
});
