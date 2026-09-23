import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LaunchSettings, Resolved } from '../../../src/core/types.js';
import { ConfigError } from '../../../src/errors.js';
import { EXIT_CODE_POLICIES, LOG_LEVELS, RENDERERS, UI_THEMES, WORDMARK_MODES, defaultRunSpendCapUsd, resolveSessionSpendCap, resolveUiConfig, runSpendCapUsd } from '../../../src/config/ui.js';
import type { SettingName } from '../../../src/config/types.js';
import type { SettingReader } from '../../../src/config/validate.js';

const HOME = '/home/me';
const CWD = '/work/proj';
const launch: LaunchSettings = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: false };

function reader(values: Partial<Record<SettingName, string | Resolved<string>>>): SettingReader {
  const m = new Map<SettingName, Resolved<string>>();
  for (const [k, v] of Object.entries(values)) m.set(k as SettingName, typeof v === 'string' ? { value: v, source: 'env' } : (v as Resolved<string>));
  return { get: (n) => m.get(n), sources: (n) => [`${n} (test)`] };
}

describe('resolveUiConfig (TUI-DESIGN §16 session settings)', () => {
  it('defaults with the launch members copied from the argument', () => {
    expect(resolveUiConfig(reader({}), launch, { home: HOME, cwd: CWD, env: {} })).toEqual({
      fps: 30,
      renderMode: 'standard',
      screenReader: false,
      ascii: false,
      noColor: false,
      theme: 'dark',
      title: false,
      reducedMotion: false,
      notify: false,
      osc52: false,
      history: true,
      noInput: false,
      trustWorkspace: false,
      budgetWarnings: true,
      allowSecretMention: false,
      exitCode: 'zero',
      logLevel: 'info',
      logFile: null,
      keybindingsFile: join(HOME, '.config', 'jevcode', 'keybindings.json'),
      wordmark: 'sweep',
      // contract 1.6 (TUI-DESIGN-4 §8 items 4–5): `classic` and the on-exit dump on
      renderer: 'classic',
      fullscreenDump: true,
    });
  });

  it('TUI-DESIGN-3 §6 item 5 ui.wordmark: sweep | static | off through the chain (case-folded); default static under the SSH launch source, sweep otherwise', () => {
    expect(WORDMARK_MODES).toEqual(['sweep', 'static', 'off']);
    expect(resolveUiConfig(reader({}), launch, { home: HOME, cwd: CWD, env: {} }).wordmark).toBe('sweep');
    expect(resolveUiConfig(reader({}), { ...launch, ssh: false }, { home: HOME, cwd: CWD, env: {} }).wordmark).toBe('sweep');
    expect(resolveUiConfig(reader({}), { ...launch, ssh: true }, { home: HOME, cwd: CWD, env: {} }).wordmark).toBe('static');
    expect(resolveUiConfig(reader({ 'ui.wordmark': 'Off' }), launch, { home: HOME, cwd: CWD, env: {} }).wordmark).toBe('off');
    expect(resolveUiConfig(reader({ 'ui.wordmark': ' STATIC ' }), launch, { home: HOME, cwd: CWD, env: {} }).wordmark).toBe('static');
    // a configured value beats the SSH default either way
    expect(resolveUiConfig(reader({ 'ui.wordmark': { value: 'sweep', source: 'file:/x' } }), { ...launch, ssh: true }, { home: HOME, cwd: CWD, env: {} }).wordmark).toBe('sweep');
  });

  it('never re-resolves a launch member: a reader value for ui.fps / ui.ascii is ignored', () => {
    const sr: LaunchSettings = { ...launch, fps: 5, screenReader: true, ascii: true, noColor: true, renderMode: 'incremental' };
    const ui = resolveUiConfig(reader({ 'ui.fps': '25', 'ui.ascii': 'false', 'ui.screenReader': 'false' }), sr, { home: HOME, cwd: CWD, env: {} });
    expect(ui).toMatchObject({ fps: 5, screenReader: true, ascii: true, noColor: true, renderMode: 'incremental' });
  });

  it('screen-reader mode defaults reducedMotion and notify to true unless set explicitly (A96)', () => {
    const sr: LaunchSettings = { ...launch, screenReader: true };
    expect(resolveUiConfig(reader({}), sr, { home: HOME, cwd: CWD, env: {} })).toMatchObject({ reducedMotion: true, notify: true });
    expect(resolveUiConfig(reader({ 'ui.reducedMotion': 'false', 'ui.notify': 'no' }), sr, { home: HOME, cwd: CWD, env: {} })).toMatchObject({ reducedMotion: false, notify: false });
  });

  it('reads every session setting through the chain (booleans in every accepted spelling, enums case-folded, paths resolved)', () => {
    const ui = resolveUiConfig(
      reader({
        'ui.theme': 'Light',
        'ui.title': '1',
        'ui.osc52': 'yes',
        'ui.history': 'false',
        'ui.noInput': 'true',
        'ui.trustWorkspace': 'TRUE',
        'ui.budgetWarnings': '0',
        'ui.allowSecretMention': 'yes',
        'ui.exitCode': 'LAST-RUN',
        'log.level': 'Trace',
        'log.file': 'logs/run.log',
        'ui.keybindings': '../keys.json',
      }),
      launch,
      { home: HOME, cwd: CWD, env: {} },
    );
    expect(ui).toMatchObject({ theme: 'light', title: true, osc52: true, history: false, noInput: true, trustWorkspace: true, budgetWarnings: false, allowSecretMention: true, exitCode: 'last-run', logLevel: 'trace', logFile: join(CWD, 'logs', 'run.log'), keybindingsFile: join('/work', 'keys.json') });
  });

  it('the default keybindings path follows XDG_CONFIG_HOME', () => {
    expect(resolveUiConfig(reader({}), launch, { home: HOME, cwd: CWD, env: { XDG_CONFIG_HOME: '/tmp/x' } }).keybindingsFile).toBe('/tmp/x/jevcode/keybindings.json');
    expect(resolveUiConfig(reader({}), launch, { home: HOME, cwd: CWD, env: { XDG_CONFIG_HOME: 'relative' } }).keybindingsFile).toBe(join(HOME, '.config', 'jevcode', 'keybindings.json'));
    expect(resolveUiConfig(reader({ 'ui.keybindings': '   ' }), launch, { home: HOME, cwd: CWD, env: {} }).keybindingsFile).toBe(join(HOME, '.config', 'jevcode', 'keybindings.json'));
  });

  it('bad values are ConfigErrors naming the setting, the value, the source and the sources consulted', () => {
    const cases: [SettingName, string, RegExp][] = [
      ['ui.theme', 'neon', /ui\.theme: "neon" \(from env\) is not one of dark\|light\|daltonized\|ansi/],
      ['ui.wordmark', 'neon', /ui\.wordmark: "neon" \(from env\) is not one of sweep\|static\|off/],
      ['ui.exitCode', 'maybe', /ui\.exitCode: "maybe" \(from env\) is not one of zero\|last-run/],
      ['log.level', 'loud', /log\.level: "loud" \(from env\) is not one of error\|warn\|info\|debug\|trace/],
      ['ui.title', 'sometimes', /ui\.title: "sometimes" \(from env\) is not a boolean/],
      ['ui.allowSecretMention', 'on', /ui\.allowSecretMention/],
    ];
    for (const [name, value, re] of cases) {
      let err: unknown;
      try {
        resolveUiConfig(reader({ [name]: value }), launch, { home: HOME, cwd: CWD, env: {} });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(re);
      expect((err as ConfigError).message).toContain(`${name} (test)`);
      expect((err as ConfigError).setting).toBe(name);
    }
    expect(UI_THEMES).toEqual(['dark', 'light', 'daltonized', 'ansi']);
    expect(EXIT_CODE_POLICIES).toEqual(['zero', 'last-run']);
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug', 'trace']);
  });

  it('TUI-DESIGN-4 §8 items 4–6 (contract 1.6): ui.renderer is copied from the launch member when it carries one, else read off the chain; ui.fullscreenDump defaults on', () => {
    expect(RENDERERS).toEqual(['classic', 'fullscreen']);
    const ui = (values: Partial<Record<SettingName, string | Resolved<string>>>, l: LaunchSettings = launch) => resolveUiConfig(reader(values), l, { home: HOME, cwd: CWD, env: {} });
    // no launch member (every LaunchSettings literal that predates contract 1.6): the chain answers, case-folded
    expect(ui({}).renderer).toBe('classic');
    expect(ui({ 'ui.renderer': ' FullScreen ' }).renderer).toBe('fullscreen');
    // a launch member is never re-resolved: it is the value Ink mounted with, already past §1.3.1's refusal matrix
    expect(ui({ 'ui.renderer': 'fullscreen' }, { ...launch, renderer: 'classic' }).renderer).toBe('classic');
    expect(ui({}, { ...launch, renderer: 'fullscreen' }).renderer).toBe('fullscreen');
    // the refusal note rides along only when there is one (exactOptionalPropertyTypes: absent, never undefined)
    expect('rendererRefusal' in ui({})).toBe(false);
    expect(ui({}, { ...launch, renderer: 'classic', rendererRefusal: 'fullscreen needs 18 rows (now 12) — the classic renderer is used' }).rendererRefusal).toContain('18 rows');
    // the on-exit dump: default on, off through the chain
    expect(ui({}).fullscreenDump).toBe(true);
    expect(ui({ 'ui.fullscreenDump': 'false' }).fullscreenDump).toBe(false);
    // a bad value is a ConfigError naming the setting, like every other enum row
    expect(() => ui({ 'ui.renderer': 'nope' })).toThrow(/ui\.renderer: "nope"/);
  });
});

describe('sessionSpendCap derivation (TUI-DESIGN §9.1, §16)', () => {
  it('llm-jev (docs/LLM-JEV-DESIGN.md) pays a generator: the $10.00 run default and the derived $50.00 session cap, like jev-on', () => {
    expect(defaultRunSpendCapUsd('llm-jev')).toBe(10);
    expect(runSpendCapUsd(reader({}), 'llm-jev')).toBe(10);
    expect(resolveSessionSpendCap(reader({}), 'llm-jev')).toEqual({ value: 50, source: 'derived', derived: true });
  });

  it('mode-keyed run default: $10.00, $1.00 under jev-only', () => {
    expect(defaultRunSpendCapUsd('jev-on')).toBe(10);
    expect(defaultRunSpendCapUsd('jev-off')).toBe(10);
    expect(defaultRunSpendCapUsd('jev-only')).toBe(1);
    expect(runSpendCapUsd(reader({}), 'jev-only')).toBe(1);
    expect(runSpendCapUsd(reader({ 'limits.spendCapUsd': { value: '10', source: 'default' } }), 'jev-only')).toBe(1);
    expect(runSpendCapUsd(reader({ 'limits.spendCapUsd': { value: '4', source: 'flag' } }), 'jev-only')).toBe(4);
    expect(runSpendCapUsd(reader({ 'limits.spendCapUsd': { value: 'abc', source: 'flag' } }), 'jev-on')).toBe(10);
    expect(runSpendCapUsd(reader({ 'limits.spendCapUsd': { value: '-1', source: 'env' } }), 'jev-on')).toBe(10);
  });

  it('absent → 5 × the run cap with source derived; configured → its own source; none → +Infinity', () => {
    expect(resolveSessionSpendCap(reader({}), 'jev-on')).toEqual({ value: 50, source: 'derived', derived: true });
    expect(resolveSessionSpendCap(reader({}), 'jev-only')).toEqual({ value: 5, source: 'derived', derived: true });
    expect(resolveSessionSpendCap(reader({ 'limits.spendCapUsd': { value: '3', source: 'env' } }), 'jev-on')).toEqual({ value: 15, source: 'derived', derived: true });
    expect(resolveSessionSpendCap(reader({ 'session.spendCapUsd': { value: '15', source: 'flag' } }), 'jev-on')).toEqual({ value: 15, source: 'flag', derived: false });
    expect(resolveSessionSpendCap(reader({ 'session.spendCapUsd': { value: ' None ', source: 'file:/x' } }), 'jev-on')).toEqual({ value: Number.POSITIVE_INFINITY, source: 'file:/x', derived: false });
    expect(resolveSessionSpendCap(reader({ 'session.spendCapUsd': { value: '   ', source: 'env' } }), 'jev-on').derived).toBe(true);
  });

  it('rejects zero, negative, non-numeric and non-finite values', () => {
    for (const bad of ['0', '-5', 'abc', 'Infinity', 'NaN']) {
      expect(() => resolveSessionSpendCap(reader({ 'session.spendCapUsd': bad }), 'jev-on')).toThrow(ConfigError);
      expect(() => resolveSessionSpendCap(reader({ 'session.spendCapUsd': bad }), 'jev-on')).toThrow(/session\.spendCapUsd/);
    }
  });
});
