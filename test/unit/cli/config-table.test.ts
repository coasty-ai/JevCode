/**
 * TUI-DESIGN §16 / §24 (CLI) and TUI-DESIGN-4 §3.3 / §7.5: `/config` as a block. `configTableRows` is unchanged
 * data (derived rows print `(default: …)`, `<setting>.ignored` rows sit beside their effective row, secrets stay
 * fingerprints) plus `atDefault` and the §7.5 `problem`; `configTableLines` renders the rows through `renderBlock`
 * at a width, so **every row is at most `width` cells** at 40 / 80 / 120, default rows fold behind the footer, a
 * row with a problem is never folded, a path elides left and a derived suffix that does not fit moves to a note.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigRecordValue } from '../../../src/core/types.js';
import {
  CONFIG_SETTING_COL_MAX,
  HIDDEN_SETTINGS,
  SANDBOX_FOOTER,
  configBlock,
  configExitCode,
  configProblemLines,
  configSourceText,
  configTableLines,
  configTableRows,
  configValueText,
  sandboxFacts,
} from '../../../src/cli/config-table.js';
import { blockWidth, renderBlock } from '../../../src/tui/block/lines.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

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

describe('configSourceText — the short parenthetical of F-B3 (§3.3)', () => {
  it('drops a default entirely and shortens a file / dotenv path', () => {
    expect(configSourceText('default')).toBeNull();
    expect(configSourceText('flag')).toBe('flag');
    expect(configSourceText('env')).toBe('env');
    expect(configSourceText('file:/Users/me/proj/jevcode.json')).toBe('file');
    expect(configSourceText('dotenv:/Users/me/proj/.env')).toBe('dotenv');
    expect(configSourceText('derived')).toBe('derived');
    expect(configSourceText('derived (auto: TYPESAFE_API_KEY is set)')).toBe('auto: TYPESAFE_API_KEY is set');
    expect(configSourceText('ignored:launch (a launch setting: use the flag or the environment variable)')).toMatch(/^ignored: a launch setting/);
    expect(configSourceText('default (typesafe)')).toBe('default: typesafe');
  });
});

describe('configTableRows (§16, + §3.3 `atDefault`)', () => {
  it('places every .ignored row directly after its effective row, keeps record order otherwise, and explains ignored:launch', () => {
    const rows = configTableRows(record);
    const settings = rows.map((r) => r.setting);
    expect(settings.indexOf('ui.fps.ignored')).toBe(settings.indexOf('ui.fps') + 1);
    expect(settings.slice(0, 5)).toEqual(['generator.provider', 'generator.apiKey', 'limits.spendCapUsd', 'ui.fps', 'ui.fps.ignored']);
    expect(settings[settings.length - 1]).toBe('ui.screenReader.ignored');
    const fps = rows.find((r) => r.setting === 'ui.fps.ignored')!;
    expect(fps.value).toBe('20');
    expect(fps.source).toBe('ignored:launch (a launch setting: use the flag or the environment variable)');
    expect(rows.find((r) => r.setting === 'session.spendCapUsd')).toEqual({ setting: 'session.spendCapUsd', value: '$10.000 (default: 5 × limits.spendCapUsd)', source: 'derived', atDefault: false });
    expect(rows).toHaveLength(Object.keys(record).length);
  });

  it('`atDefault` is exactly `source === default` — the fold predicate of §3.3', () => {
    const rows = configTableRows(record);
    expect(rows.filter((r) => r.atDefault).map((r) => r.setting)).toEqual(['generator.provider', 'ui.fps', 'ui.renderMode']);
  });

  it('carries the §7.5 problem through to the row', () => {
    const rows = configTableRows({ 'limits.maxSteps': { value: 'lots', source: 'file:/x.json', problem: { kind: 'wrong-type', expected: 'an integer ≥ 1' } } });
    expect(rows[0]?.problem).toEqual({ kind: 'wrong-type', expected: 'an integer ≥ 1' });
  });
});

describe('configTableLines — every row fits the width (§3.3, the `commands-width` gate)', () => {
  for (const columns of [40, 80, 120]) {
    it(`no row exceeds blockWidth(${columns})`, () => {
      const width = blockWidth(columns);
      for (const all of [false, true]) {
        const lines = configTableLines(record, { sandboxLevel: 'seatbelt', width, all });
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) expect(cellWidth(l), `${columns}/${all}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(width);
      }
    });
  }

  it('the value column sits at min(28, longest + 2) and the header names both columns', () => {
    const lines = configTableLines(record, { sandboxLevel: 'seatbelt', width: 70, all: true });
    expect(lines[0]).toMatch(/^setting\s+value$/);
    expect(lines[0]?.indexOf('value')).toBe(CONFIG_SETTING_COL_MAX);
    const row = lines.find((l) => l.startsWith('limits.spendCapUsd'))!;
    expect(row.slice(CONFIG_SETTING_COL_MAX)).toBe('$2.000  (flag)');
  });

  it('folds the default rows behind the footer and `--all` unfolds them', () => {
    const folded = configTableLines(record, { sandboxLevel: 'seatbelt', width: 70 });
    expect(folded.some((l) => l.startsWith('ui.renderMode'))).toBe(false);
    expect(folded.some((l) => l === '… +3 settings at their defaults (/config --all)')).toBe(true);
    const all = configTableLines(record, { sandboxLevel: 'seatbelt', width: 70, all: true });
    expect(all.some((l) => l.startsWith('ui.renderMode'))).toBe(true);
    expect(all.some((l) => l.includes('/config --all'))).toBe(false);
  });

  it('the narrow head and footer use the short wording (F-B4)', () => {
    expect(configBlock(record, { sandboxLevel: 'seatbelt', width: 30 }).head).toBe('config · 8 set, 3 default');
    expect(configBlock(record, { sandboxLevel: 'seatbelt', width: 70 }).head).toBe('config · 8 set, 3 at their defaults');
    // a small record, because at width 30 the full one exceeds the §3.1.5 `/config` cap of 24 rows
    const small: Record<string, ConfigRecordValue> = { mode: { value: 'jev-on', source: 'flag' }, 'ui.fps': { value: '30', source: 'default' } };
    expect(configTableLines(small, { sandboxLevel: 'seatbelt', width: 30 })).toContain('… +1 default (/config --all)');
  });

  it('a row with a problem is NEVER folded, and carries `✗ expected …` (§3.3 edge 8, F-B3)', () => {
    const rec = { ...record, 'limits.maxSteps': { value: '40', source: 'default', problem: { kind: 'out-of-range', expected: 'an integer ≥ 1' } } satisfies ConfigRecordValue };
    const lines = configTableLines(rec, { sandboxLevel: 'seatbelt', width: 70 });
    const row = lines.find((l) => l.startsWith('limits.maxSteps'));
    expect(row).toBeDefined();
    expect(row).toContain('✗ expected an integer ≥ 1');
  });

  it('a clamped bound is a `⚠` row, not a `✗` (§7.5 edge cases), and `--ascii` substitutes both marks', () => {
    const rec: Record<string, ConfigRecordValue> = { 'ui.fps': { value: '240', source: 'env', problem: { kind: 'out-of-range', expected: 'clamped to 30' } } };
    expect(configTableLines(rec, { sandboxLevel: 'none', width: 70 }).find((l) => l.startsWith('ui.fps'))).toContain('⚠ clamped to 30');
    const ascii = configTableLines(rec, { sandboxLevel: 'none', width: 70, glyphs: GLYPHS.ascii });
    expect(ascii.find((l) => l.startsWith('ui.fps'))).toContain('! clamped to 30');
  });

  it('an `.ignored` row is never folded even though it is not a default row (§3.3 edge 3)', () => {
    const lines = configTableLines(record, { sandboxLevel: 'seatbelt', width: 110 });
    expect(lines.some((l) => l.startsWith('ui.fps.ignored'))).toBe(true);
  });

  it('a long path value elides LEFT and a masked secret is never cut inside its fingerprint (§3.3 edge 2)', () => {
    const rec: Record<string, ConfigRecordValue> = {
      runsDir: { value: '/very/long/prefix/a3-home-L5tIsG/runs', source: 'env' },
      'decider.apiKey': { value: { source: 'dotenv:/Users/me/a/very/long/project/path/.env', fingerprint: '3f9a2c1d' }, source: 'dotenv:/Users/me/a/very/long/project/path/.env' },
    };
    const lines = configTableLines(rec, { sandboxLevel: 'none', width: 44 });
    expect(lines.join('\n')).toContain('sha256:3f9a2c1d)');
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(44);
  });

  it('a derived suffix that does not fit moves to its own indented note row (§3.3)', () => {
    const rec: Record<string, ConfigRecordValue> = { 'session.spendCapUsd': { value: '10', source: 'derived' } };
    const lines = configTableLines(rec, { sandboxLevel: 'none', width: 34 });
    expect(lines.some((l) => /^ {2}\(/.test(l))).toBe(true);
    for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(34);
  });

  it('an empty record is the header row plus `no settings resolved yet` (§3.3 edge 1)', () => {
    const lines = configTableLines({}, { sandboxLevel: 'none', width: 70 });
    expect(lines[0]).toBe('  no settings resolved yet');
    expect(configBlock({}, { sandboxLevel: 'none', width: 70 }).head).toBe('config');
  });

  it('the sandbox footer is a rule caption plus one facts row, and names the network state', () => {
    const lines = configTableLines(record, { sandboxLevel: 'seatbelt', width: 70 });
    expect(lines).toContain('╶──── sandbox');
    expect(lines.join('\n')).toContain('seatbelt · writes only in the workspace and run dirs');
    expect(sandboxFacts('seatbelt', true)).toContain('network on (--no-network)');
    expect(sandboxFacts('none', false)).toContain('network off');
    expect(configTableLines(record, { sandboxLevel: 'none', width: 110 }).join('\n')).toContain('cwd confinement');
    // the §24 one-sentence twin of the `[sandbox]` item is unchanged
    expect(SANDBOX_FOOTER.seatbelt).toMatch(/^sandbox level: seatbelt/);
  });

  it('an unknown file key becomes one warning row naming the nearest valid setting (§7.5 item 4)', () => {
    const lines = configTableLines(record, { sandboxLevel: 'none', width: 110, unknownFileKeys: ['maxStep'] });
    expect(lines.join('\n')).toContain('maxStep is not a setting (did you mean maxSteps?)');
    const far = configTableLines(record, { sandboxLevel: 'none', width: 110, unknownFileKeys: ['zzzzzzzzzz'] });
    expect(far.join('\n')).toContain('zzzzzzzzzz is not a setting');
    expect(far.join('\n')).not.toContain('did you mean');
  });
});

describe('configExitCode (§7.5: exit 2 for wrong-type / out-of-range, exit 0 for unknown-key)', () => {
  it('is 2 only for a value the next run will reject', () => {
    expect(configExitCode(record)).toBe(0);
    expect(configExitCode({ a: { value: 'x', source: 'file:/x', problem: { kind: 'wrong-type', expected: 'true or false' } } })).toBe(2);
    expect(configExitCode({ a: { value: '0', source: 'file:/x', problem: { kind: 'out-of-range', expected: 'an integer ≥ 1' } } })).toBe(2);
    expect(configExitCode({ a: { value: '1', source: 'file:/x', problem: { kind: 'unknown-key', expected: 'a setting' } } })).toBe(0);
    expect(configExitCode({ a: { value: '240', source: 'env', problem: { kind: 'out-of-range', expected: 'clamped to 30' } } })).toBe(0);
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
    expect(configTableRows(rec)).toEqual([
      { setting: 'decider.provider', value: 'typesafe', source: 'derived (auto: TYPESAFE_API_KEY is set)', atDefault: false },
      { setting: 'decider.baseUrl', value: 'https://api.typesafe.ai/v1/systemone', source: 'default (typesafe)', atDefault: true },
      { setting: 'decider.apiKey', value: '<dotenv:/Users/me/proj/.env> (sha256:3f9a2c1d)', source: 'dotenv:/Users/me/proj/.env', atDefault: false },
      { setting: 'decider.model', value: 'jev-1.13.0', source: 'default (typesafe)', atDefault: true },
    ]);
    const lines = configTableLines(rec, { sandboxLevel: 'none', width: 110, all: true });
    expect(lines[1]).toMatch(/^decider\.provider\s+typesafe\s+\(auto: TYPESAFE_API_KEY is set\)$/);
    expect(lines[2]).toMatch(/^decider\.baseUrl\s+https:\/\/api\.typesafe\.ai\/v1\/systemone\s+\(default: typesafe\)$/);
    expect(lines[4]).toMatch(/^decider\.model\s+jev-1\.13\.0\s+\(default: typesafe\)$/);
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
    expect(configTableRows({ 'decider.provider': { value: 'typesafe', source: 'derived' } })[0]!.source).toBe('derived');
    const or = configTableRows({ 'decider.provider': { value: 'openrouter', source: 'env' }, 'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' }, 'decider.baseUrl': { value: 'https://proxy.test', source: 'flag' } });
    expect(or.map((r) => r.source)).toEqual(['env', 'default (openrouter)', 'flag']);
    expect(configTableRows({ 'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' } })[0]!.source).toBe('default');
  });
});

describe('TUI-DESIGN-2 §2.6 edge rows: an unknown provider value, the `mode` row', () => {
  it('a record whose decider.provider value is not a provider prints the raw value and plain `default` on the provider-keyed rows', () => {
    expect(
      configTableRows({
        'decider.provider': { value: 'foo', source: 'env' },
        'decider.baseUrl': { value: 'https://openrouter.ai/api/alpha/decisions', source: 'default' },
        'decider.model': { value: 'typesafe/jev-1.13-20260917', source: 'default' },
        'decider.providerSource': { value: 'env', source: 'derived' },
      }),
    ).toEqual([
      { setting: 'decider.provider', value: 'foo', source: 'env', atDefault: false },
      { setting: 'decider.baseUrl', value: 'https://openrouter.ai/api/alpha/decisions', source: 'default', atDefault: true },
      { setting: 'decider.model', value: 'typesafe/jev-1.13-20260917', source: 'default', atDefault: true },
    ]);
  });

  it('§1.2 / §12: the `mode` row prints like any plain row; a file source prints `(file)`', () => {
    expect(configTableRows({ mode: { value: 'jev-only', source: 'default' } })).toEqual([{ setting: 'mode', value: 'jev-only', source: 'default', atDefault: true }]);
    expect(configTableLines({ mode: { value: 'jev-only', source: 'default' } }, { sandboxLevel: 'none', width: 70, all: true })[1]).toMatch(/^mode\s+jev-only$/);
    expect(configTableLines({ mode: { value: 'jev-on', source: 'file:/Users/me/proj/jevcode.json' } }, { sandboxLevel: 'none', width: 70 })[1]).toMatch(/^mode\s+jev-on\s+\(file\)$/);
    expect(configTableRows({ mode: { value: 'jev-on', source: 'file:/Users/me/proj/jevcode.json' } })).toEqual([{ setting: 'mode', value: 'jev-on', source: 'file:/Users/me/proj/jevcode.json', atDefault: false }]);
  });
});

describe('TUI-DESIGN-3 §0.1 (D-Q): hidden bookkeeping rows', () => {
  it('seen.defaultMode is hidden from the table unless `all`; every other row is untouched; the record keeps it (`--json`)', () => {
    const withSeen: Record<string, ConfigRecordValue> = { ...record, 'seen.defaultMode': { value: 'jev-on', source: 'file:/x/config.json' } };
    expect(HIDDEN_SETTINGS.has('seen.defaultMode')).toBe(true);
    expect(configTableRows(withSeen).map((r) => r.setting)).not.toContain('seen.defaultMode');
    expect(configTableRows(withSeen)).toEqual(configTableRows(record));
    expect(configTableRows(withSeen, { all: true }).map((r) => r.setting)).toContain('seen.defaultMode');
    expect(configTableRows(withSeen, { all: true }).find((r) => r.setting === 'seen.defaultMode')).toEqual({ setting: 'seen.defaultMode', value: 'jev-on', source: 'file:/x/config.json', atDefault: false });
    expect(configTableLines(withSeen, { sandboxLevel: 'none', width: 110 }).some((l) => l.startsWith('seen.defaultMode'))).toBe(false);
    expect(configTableLines(withSeen, { sandboxLevel: 'none', width: 110, all: true }).some((l) => l.startsWith('seen.defaultMode'))).toBe(true);
  });
});

describe('configProblemLines — the `[setup]` items of §7.5 item 5', () => {
  const rec: Record<string, ConfigRecordValue> = {
    mode: { value: 'jev-on', source: 'flag' },
    'limits.maxSteps': { value: 'lots', source: 'file:/x.json', problem: { kind: 'wrong-type', expected: 'an integer ≥ 1' } },
    'ui.fps': { value: '240', source: 'file:/x.json', problem: { kind: 'out-of-range', expected: 'clamped to 30' } },
    'decider.model': { value: 'm', source: 'default' },
  };

  it('names every refused value once, and the unknown keys in one row', () => {
    expect(configProblemLines({ record: () => rec, unknownFileKeys: ['maxStep', 'zzzzzzzzzz'] })).toEqual([
      'limits.maxSteps: ✗ expected an integer ≥ 1',
      'ui.fps: ⚠ clamped to 30',
      'maxStep is not a setting (did you mean maxSteps?) · zzzzzzzzzz is not a setting',
    ]);
  });

  it('is empty when nothing is wrong, and an `unknown-key` problem is not repeated as a row', () => {
    expect(configProblemLines({ record: () => ({ mode: { value: 'jev-on', source: 'flag' } }) })).toEqual([]);
    expect(configProblemLines({ record: () => ({ nope: { value: '1', source: 'file:/x.json', problem: { kind: 'unknown-key', expected: 'a setting name' } } }) })).toEqual([]);
  });

  it('§7.5 exit code: 2 for a refused value, 0 for a clamp or an unknown key', () => {
    expect(configExitCode(rec)).toBe(2);
    expect(configExitCode({ 'ui.fps': rec['ui.fps'] as ConfigRecordValue })).toBe(0);
    expect(configExitCode({ nope: { value: '1', source: 'file:/x.json', problem: { kind: 'unknown-key', expected: 'a setting name' } } })).toBe(0);
    expect(configExitCode({ mode: { value: 'jev-on', source: 'flag' } })).toBe(0);
  });
});

describe('§3.3 / §3.1.5: `jevcode config` is UNCAPPED, and `--all` is never capped at all', () => {
  /** a record big enough that the 24-row block cap would fire */
  const big: Record<string, ConfigRecordValue> = Object.fromEntries(
    Array.from({ length: 61 }, (_, i) => [`setting.number${i}`, { value: `value-${i}`, source: i % 3 === 0 ? 'flag' : 'default' } as ConfigRecordValue]),
  );

  it('`configTableLines` with no `max` prints every row — the CLI is the command whose job is to print them', () => {
    const lines = configTableLines(big, { sandboxLevel: 'seatbelt', all: true, width: 70 });
    for (let i = 0; i < 61; i++) expect(lines.join('\n'), `setting.number${i}`).toContain(`setting.number${i}`);
    expect(lines.filter((l) => l.startsWith('… +'))).toEqual([]);
  });

  it('`--all` is never capped even when the caller asks for one, and never points a footer at a flag already set', () => {
    const lines = configTableLines(big, { sandboxLevel: 'seatbelt', all: true, width: 70, max: 24 });
    expect(lines.filter((l) => l.includes('/config --all'))).toEqual([]);
    expect(lines.join('\n')).toContain('setting.number60');
  });

  it('with `max` and without `--all` the cap fires — and the sandbox statement still survives it (§3.3 edge 4)', () => {
    for (const width of [30, 70, 110]) {
      const lines = configTableLines(big, { sandboxLevel: 'seatbelt', width, max: 24 });
      expect(lines.some((l) => l.startsWith('… +')), `width ${width}`).toBe(true);
      expect(lines, `width ${width}`).toContain('╶──── sandbox');
      // the security statement is the LAST thing in the block, never the thing the cap ate
      expect(lines[lines.length - 1], `width ${width}`).not.toMatch(/^… \+/);
      expect(lines.join('\n'), `width ${width}`).toContain('seatbelt');
      for (const l of lines) expect(cellWidth(l), `width ${width}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(width);
    }
  });

  it('the cap footer is §12\'s bare `… +<n> more rows` once the clause does not fit, never a cut token', () => {
    const lines = configTableLines(big, { sandboxLevel: 'seatbelt', width: 30, max: 24 });
    const footer = lines.find((l) => l.startsWith('… +')) ?? '';
    expect(footer).toMatch(/^… \+\d+ more rows$/);
  });
});

describe('§3.3: one geometry per record — `configTableLines` is exactly what a `block()` caller renders', () => {
  const rec: Record<string, ConfigRecordValue> = {
    mode: { value: 'jev-on', source: 'flag' },
    'generator.model': { value: 'z-ai/glm-5.3-flash', source: 'file:/x/jevcode.json' },
    'limits.spendCapUsd': { value: '2', source: 'env' },
    'session.spendCapUsd': { value: '10', source: 'derived' },
    workspace: { value: '/Users/me/T/a3-ws-eO2WYu', source: 'flag' },
    'ui.theme': { value: 'dark', source: 'default' },
    // a FOLDED row with the longest name: the pinned column is sized over every row, the natural one only over
    // the shown rows, so this is exactly the record on which dropping `tableCols` moves the value column
    'generator.priceCacheWritePerM': { value: '0.1', source: 'default' },
  };

  it('`configBlock`\'s pinned `tableCols` + `protectTail` reproduce `configTableLines` row for row at 30 / 70 / 110', () => {
    for (const width of [30, 70, 110]) {
      const opts = { sandboxLevel: 'seatbelt' as const, width, home: '/Users/me' };
      const cb = configBlock(rec, opts);
      // what `session.ts`'s `block()` does with the SAME record: the builder's columns, the builder's tail
      const viaBlock = renderBlock(cb.rows, width, GLYPHS.unicode, { tableCols: cb.tableCols, protectTail: cb.protectTail }).map((r) => r.text);
      expect(viaBlock, `width ${width}`).toEqual(configTableLines(rec, opts));
    }
  });

  it('dropping `tableCols` is what made the two disagree — the value column moves', () => {
    const cb = configBlock(rec, { sandboxLevel: 'seatbelt', width: 70, home: '/Users/me' });
    const without = renderBlock(cb.rows, 70, GLYPHS.unicode, { protectTail: cb.protectTail }).map((r) => r.text);
    expect(without).not.toEqual(configTableLines(rec, { sandboxLevel: 'seatbelt', width: 70, home: '/Users/me' }));
  });
});

describe('§3.3: `--all` and `--json` still carry the config FILE a value came from', () => {
  const rec: Record<string, ConfigRecordValue> = {
    a: { value: '1', source: 'file:/Users/me/.config/jevcode/jevcode.json' },
    b: { value: '2', source: 'file:/Users/me/proj/jevcode.json' },
    c: { value: '3', source: 'dotenv:/Users/me/proj/.env' },
  };

  it('`configSourceText` shortens by default and returns the whole source under `all`', () => {
    expect(configSourceText('file:/x/jevcode.json')).toBe('file');
    expect(configSourceText('dotenv:/x/.env')).toBe('dotenv');
    expect(configSourceText('file:/x/jevcode.json', true)).toBe('file:/x/jevcode.json');
    expect(configSourceText('dotenv:/x/.env', true)).toBe('dotenv:/x/.env');
    // a default is still nothing, `all` or not
    expect(configSourceText('default', true)).toBeNull();
  });

  it('`/config --all` tells the user WHICH of two config files set each value', () => {
    const lines = configTableLines(rec, { sandboxLevel: 'seatbelt', all: true, width: 110 }).join('\n');
    expect(lines).toContain('/Users/me/.config/jevcode/jevcode.json');
    expect(lines).toContain('/Users/me/proj/jevcode.json');
    expect(lines).toContain('dotenv:/Users/me/proj/.env');
    const folded = configTableLines(rec, { sandboxLevel: 'seatbelt', width: 110 }).join('\n');
    expect(folded).toContain('(file)');
    expect(folded).not.toContain('/Users/me/proj/jevcode.json');
  });
});
