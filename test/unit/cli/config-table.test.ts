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
