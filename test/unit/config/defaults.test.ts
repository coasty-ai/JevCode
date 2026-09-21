import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CACHE_READ_FACTOR,
  CACHE_WRITE_FACTOR,
  DEFAULT_FPS,
  DEFAULT_SPEND_CAP_USD,
  JEV_ONLY_DEFAULT_SPEND_CAP_USD,
  LAUNCH_SETTINGS,
  MAX_FPS,
  MIN_FPS,
  SESSION_CAP_MULTIPLIER,
  SETTINGS,
  SSH_FPS,
  TRACE_ENV,
  UNPRICED_TOKENS_PER_USD,
  configDirsFor,
  defaultKeybindingsPath,
  legacyConfigDir,
  settingSpec,
  xdgConfigDir,
} from '../../../src/config/defaults.js';
import type { SettingName } from '../../../src/config/types.js';

const HOME = '/home/me';

describe('the §16 SETTINGS table', () => {
  it('has one row per §16 setting name, unique names, unique env / file keys', () => {
    const names = SETTINGS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const expected: SettingName[] = [
      'ui.theme',
      'ui.fps',
      'ui.renderMode',
      'ui.ascii',
      'ui.title',
      'ui.screenReader',
      'ui.reducedMotion',
      'ui.notify',
      'ui.osc52',
      'ui.history',
      'ui.noInput',
      'ui.trustWorkspace',
      'ui.budgetWarnings',
      'ui.allowSecretMention',
      'ui.exitCode',
      'ui.keybindings',
      'ui.noColor',
      'log.file',
      'log.level',
      'session.spendCapUsd',
      'limits.spendCapUsd',
      'limits.allowUnpriced',
      'limits.maxGeneratorTokens',
      'generator.priceCacheReadPerM',
      'generator.priceCacheWritePerM',
      'update.notify',
      'configFile',
    ];
    for (const n of expected) expect(names).toContain(n);
    const envNames = SETTINGS.flatMap((s) => [...s.env, ...(s.negateEnv ?? [])]);
    expect(new Set(envNames).size).toBe(envNames.length);
    const fileKeys = SETTINGS.flatMap((s) => [s.fileKey, s.ignoredFileKey].filter((k): k is string => typeof k === 'string'));
    expect(new Set(fileKeys).size).toBe(fileKeys.length);
    expect(fileKeys.some((k) => envNames.includes(k))).toBe(false);
  });

  it('the five launch rows: flag > env > default, no file key, an ignored file key for those a file might carry', () => {
    expect(LAUNCH_SETTINGS.map((s) => s.name).sort()).toEqual(['ui.ascii', 'ui.fps', 'ui.noColor', 'ui.renderMode', 'ui.screenReader']);
    for (const s of LAUNCH_SETTINGS) {
      expect(s.launch).toBe(true);
      expect(s.fileKey).toBeUndefined();
    }
    expect(settingSpec('ui.fps')).toMatchObject({ flag: 'fps', env: ['JEVCODE_FPS'], ignoredFileKey: 'fps', defaultValue: '30' });
    expect(settingSpec('ui.renderMode')).toMatchObject({ flag: 'renderMode', env: ['JEVCODE_RENDER_MODE'], ignoredFileKey: 'renderMode', defaultValue: 'standard' });
    expect(settingSpec('ui.screenReader')).toMatchObject({ boolFlag: { key: 'screenReader', negate: false }, env: ['JEVCODE_SCREEN_READER', 'INK_SCREEN_READER'], ignoredFileKey: 'screenReader' });
    expect(settingSpec('ui.ascii')).toMatchObject({ boolFlag: { key: 'ascii', negate: false }, env: ['JEVCODE_ASCII'], ignoredFileKey: 'ascii' });
    expect(settingSpec('ui.noColor')).toMatchObject({ boolFlag: { key: 'noColor', negate: false }, env: ['NO_COLOR'] });
  });

  it('session rows carry the §16 flags, env names, file keys and defaults', () => {
    expect(settingSpec('ui.theme')).toMatchObject({ flag: 'theme', env: ['JEVCODE_THEME'], fileKey: 'theme', defaultValue: 'dark' });
    // inverted-polarity variables live in negateEnv (TUI-DESIGN §16: JEVCODE_NO_HISTORY=1 disables, NO_UPDATE_NOTIFIER=1 disables)
    expect(settingSpec('ui.history')).toMatchObject({ boolFlag: { key: 'noHistory', negate: true }, env: [], negateEnv: ['JEVCODE_NO_HISTORY'], fileKey: 'history', defaultValue: 'true' });
    expect(settingSpec('ui.budgetWarnings')).toMatchObject({ boolFlag: { key: 'noBudgetWarnings', negate: true }, env: ['JEVCODE_BUDGET_WARNINGS'], fileKey: 'budgetWarnings', defaultValue: 'true' });
    expect(settingSpec('ui.reducedMotion')).toMatchObject({ boolFlag: { key: 'noAnimation', negate: false }, env: ['JEVCODE_REDUCED_MOTION'], fileKey: 'reducedMotion', defaultValue: null });
    expect(settingSpec('ui.exitCode')).toMatchObject({ flag: 'exitCode', env: ['JEVCODE_EXIT_CODE'], fileKey: 'exitCode', defaultValue: 'zero' });
    expect(settingSpec('ui.keybindings')).toMatchObject({ flag: 'keybindings', env: ['JEVCODE_KEYBINDINGS'], fileKey: 'keybindings', defaultValue: null });
    expect(settingSpec('log.file')).toMatchObject({ flag: 'log', env: ['JEVCODE_LOG', 'JEVCODE_TRACE'], fileKey: 'log', defaultValue: null });
    expect(TRACE_ENV).toBe('JEVCODE_TRACE');
    expect(settingSpec('log.level')).toMatchObject({ flag: 'logLevel', env: ['JEVCODE_LOG_LEVEL'], fileKey: 'logLevel', defaultValue: 'info' });
    expect(settingSpec('session.spendCapUsd')).toMatchObject({ flag: 'sessionSpendCap', env: ['JEVCODE_SESSION_SPEND_CAP_USD'], fileKey: 'sessionSpendCapUsd', defaultValue: null });
    expect(settingSpec('limits.allowUnpriced')).toMatchObject({ boolFlag: { key: 'allowUnpriced', negate: false }, env: ['JEVCODE_ALLOW_UNPRICED'], fileKey: 'allowUnpriced', defaultValue: 'false' });
    expect(settingSpec('limits.maxGeneratorTokens')).toMatchObject({ flag: 'maxGeneratorTokens', env: ['JEVCODE_MAX_GENERATOR_TOKENS'], fileKey: 'maxGeneratorTokens', defaultValue: null });
    expect(settingSpec('generator.priceCacheReadPerM')).toMatchObject({ env: ['JEVCODE_PRICE_CACHE_READ_PER_M'], fileKey: 'priceCacheReadPerM' });
    expect(settingSpec('generator.priceCacheWritePerM')).toMatchObject({ env: ['JEVCODE_PRICE_CACHE_WRITE_PER_M'], fileKey: 'priceCacheWritePerM' });
    expect(settingSpec('update.notify')).toMatchObject({ boolFlag: { key: 'updateNotify', negate: false }, env: ['JEVCODE_UPDATE_NOTIFY'], negateEnv: ['NO_UPDATE_NOTIFIER'], fileKey: 'updateNotify', defaultValue: 'false' });
    // every inverted name is a boolean setting with a positive default or a boolFlag (there is nothing else to invert)
    for (const s of SETTINGS.filter((x) => (x.negateEnv ?? []).length > 0)) expect(s.boolFlag).toBeDefined();
    // the two eager booleans now go through the generic boolean-flag binding
    expect(settingSpec('noNetwork')).toMatchObject({ boolFlag: { key: 'noNetwork', negate: false } });
    expect(settingSpec('plain')).toMatchObject({ boolFlag: { key: 'plain', negate: false } });
    expect(() => settingSpec('nope' as SettingName)).toThrow(/unknown setting/);
  });

  it('constants: run cap $2 / $0.25 (jev-only), session ×5, token cap 1e6/15 per USD, cache 0.1× / 1.25×, fps 30 / 15 / 5..30', () => {
    expect(DEFAULT_SPEND_CAP_USD).toBe(2);
    expect(JEV_ONLY_DEFAULT_SPEND_CAP_USD).toBe(0.25);
    expect(SESSION_CAP_MULTIPLIER).toBe(5);
    expect(Math.floor(2 * UNPRICED_TOKENS_PER_USD)).toBe(133_333);
    expect(CACHE_READ_FACTOR).toBe(0.1);
    expect(CACHE_WRITE_FACTOR).toBe(1.25);
    expect([DEFAULT_FPS, SSH_FPS, MIN_FPS, MAX_FPS]).toEqual([30, 15, 5, 30]);
  });
});

describe('XDG paths (TUI-DESIGN §16, §12.7)', () => {
  it('xdgConfigDir honours an absolute XDG_CONFIG_HOME only; legacy is ~/.config/jevcode', () => {
    expect(xdgConfigDir(HOME, {})).toBe(join(HOME, '.config', 'jevcode'));
    expect(xdgConfigDir(HOME, { XDG_CONFIG_HOME: '/tmp/x' })).toBe('/tmp/x/jevcode');
    expect(xdgConfigDir(HOME, { XDG_CONFIG_HOME: 'rel/path' })).toBe(join(HOME, '.config', 'jevcode'));
    expect(xdgConfigDir(HOME, { XDG_CONFIG_HOME: '   ' })).toBe(join(HOME, '.config', 'jevcode'));
    expect(legacyConfigDir(HOME)).toBe(join(HOME, '.config', 'jevcode'));
  });
  it('configDirsFor: XDG first, legacy second, deduplicated when equal', () => {
    expect(configDirsFor(HOME, {})).toEqual([join(HOME, '.config', 'jevcode')]);
    expect(configDirsFor(HOME, { XDG_CONFIG_HOME: '/tmp/x' })).toEqual(['/tmp/x/jevcode', join(HOME, '.config', 'jevcode')]);
  });
  it('defaultKeybindingsPath', () => {
    expect(defaultKeybindingsPath(HOME, {})).toBe(join(HOME, '.config', 'jevcode', 'keybindings.json'));
    expect(defaultKeybindingsPath(HOME, { XDG_CONFIG_HOME: '/tmp/x' })).toBe('/tmp/x/jevcode/keybindings.json');
  });
});
