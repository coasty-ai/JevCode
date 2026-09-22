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
import { DEFAULT_MODE, JEV_PROVIDER_SETTING_VALUES, KNOWN_KEY_ENV, MODE_BADGE_MAX_CELLS, MODE_BADGE_WORD, MODE_SETTING_VALUES } from '../../../src/config/defaults.js';
import type { EngineMode } from '../../../src/core/types.js';
import { cellWidth } from '../../../src/tui/glyphs.js';

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
      'ui.wordmark', // TUI-DESIGN-3 §6 item 5
      'ui.renderer', // TUI-DESIGN-4 §8 item 5 (contract 1.6)
      'ui.fullscreenDump', // TUI-DESIGN-4 §8 item 5 (contract 1.6)
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
      'decider.provider', // TUI-DESIGN-2 §2.3
      'mode', // TUI-DESIGN-2 §1.2
      'seen.defaultMode', // TUI-DESIGN-3 §0.1 (D-Q)
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
    // TUI-DESIGN-3 §6 item 5: ui.wordmark — a file / env row with no default of its own (config/ui.ts derives static under SSH, sweep otherwise); not a launch row, no flag
    expect(settingSpec('ui.wordmark')).toMatchObject({ env: ['JEVCODE_WORDMARK'], fileKey: 'wordmark', defaultValue: null, secret: false });
    expect(settingSpec('ui.wordmark').launch).toBeUndefined();
    expect(settingSpec('ui.wordmark').flag).toBeUndefined();
    expect(settingSpec('ui.wordmark').boolFlag).toBeUndefined();
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

describe('TUI-DESIGN-2 §2.3: the decider.provider row and the known key variables', () => {
  it('sits directly before decider.baseUrl: --jev-provider / JEV_PROVIDER / jevProvider, default auto, not secret, the §2.3 description verbatim', () => {
    const names = SETTINGS.map((s) => s.name);
    expect(names.indexOf('decider.provider')).toBe(names.indexOf('decider.baseUrl') - 1);
    expect(settingSpec('decider.provider')).toMatchObject({ flag: 'jevProvider', env: ['JEV_PROVIDER'], fileKey: 'jevProvider', defaultValue: 'auto', secret: false });
    expect(settingSpec('decider.provider').description).toBe('Jev provider (auto | typesafe | openrouter); auto = typesafe when TYPESAFE_API_KEY is set, else openrouter');
    expect(settingSpec('decider.provider').launch).toBeUndefined();
    expect(JEV_PROVIDER_SETTING_VALUES).toEqual(['auto', 'typesafe', 'openrouter']);
    // the key row is unchanged: TYPESAFE_API_KEY arrives through resolve.ts's extraEnv (§2.3 step 3)
    expect(settingSpec('decider.apiKey').env).toEqual(['JEV_API_KEY', 'OPENROUTER_API_KEY']);
    expect(KNOWN_KEY_ENV).toEqual(['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']);
  });
});

describe('TUI-DESIGN-2 §1.2: the `mode` row', () => {
  it('sits directly after decider.model: --mode / JEVCODE_MODE / `mode`, default DEFAULT_MODE, not secret, not a launch row, the §1.2 description verbatim', () => {
    const names = SETTINGS.map((s) => s.name);
    expect(names.indexOf('mode')).toBe(names.indexOf('decider.model') + 1);
    expect(settingSpec('mode')).toMatchObject({ flag: 'mode', env: ['JEVCODE_MODE'], fileKey: 'mode', defaultValue: DEFAULT_MODE, secret: false });
    expect(settingSpec('mode').description).toBe('engine mode (jev-only | jev-on | jev-off | llm-jev); jev-only needs no generator key');
    expect(settingSpec('mode').launch).toBeUndefined();
    expect(settingSpec('mode').boolFlag).toBeUndefined();
    expect(MODE_SETTING_VALUES).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev']);
    expect(settingSpec('mode').defaultValue).toBe(DEFAULT_MODE);
  });
});

describe('TUI-DESIGN-3 §1.1 (D-G, D-N): DEFAULT_MODE, MODE_BADGE_WORD, MODE_BADGE_MAX_CELLS', () => {
  it('the default engine mode is llm-jev (badge llm+jev · verified; flipped 2026-09-22 on the verified head-to-head) — the one intentional pin of the value; every other expectation reads DEFAULT_MODE', () => {
    expect(DEFAULT_MODE).toBe('llm-jev'); // the one intentional value pin
    expect(MODE_SETTING_VALUES).toContain(DEFAULT_MODE);
    expect(MODE_BADGE_WORD[DEFAULT_MODE]).toBe('llm+jev · verified');
  });

  it('MODE_BADGE_WORD has a row for every MODE_SETTING_VALUES member, every word ≤ MODE_BADGE_MAX_CELLS cells, llm-jev reads llm+jev · verified', () => {
    for (const m of MODE_SETTING_VALUES) {
      const word = MODE_BADGE_WORD[m];
      expect(typeof word, m).toBe('string');
      expect(word.length, m).toBeGreaterThan(0);
      expect(cellWidth(word), `${m}: ${word}`).toBeLessThanOrEqual(MODE_BADGE_MAX_CELLS);
    }
    expect(Object.keys(MODE_BADGE_WORD).sort()).toEqual([...MODE_SETTING_VALUES].sort());
    expect(MODE_BADGE_WORD['llm-jev']).toBe('llm+jev · verified');
    expect(MODE_BADGE_WORD['jev-only']).toBe('jev-only');
    expect(MODE_BADGE_WORD['jev-on']).toBe('jev+llm');
    expect(MODE_BADGE_WORD['jev-off']).toBe('llm-only');
    expect(MODE_BADGE_MAX_CELLS).toBe(20);
    // the words are distinct: a badge names its mode unambiguously
    const words = MODE_SETTING_VALUES.map((m: EngineMode) => MODE_BADGE_WORD[m]);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe('TUI-DESIGN-4 §8 item 5 (contract 1.6): the ui.renderer and ui.fullscreenDump rows', () => {
  it('both are ordinary session rows (not launch rows): the mount-time value comes from resolveLaunchSettings, the file value persists for the relaunch', () => {
    expect(settingSpec('ui.renderer')).toMatchObject({ flag: 'renderer', env: ['JEVCODE_RENDERER'], fileKey: 'renderer', defaultValue: 'classic', secret: false });
    expect(settingSpec('ui.renderer').launch).toBeUndefined();
    expect(settingSpec('ui.renderer').ignoredFileKey).toBeUndefined();
    expect(settingSpec('ui.renderer').boolFlag).toBeUndefined();
    expect(settingSpec('ui.renderer').description).toContain('classic|fullscreen');
    expect(settingSpec('ui.fullscreenDump')).toMatchObject({ env: ['JEVCODE_FULLSCREEN_DUMP'], fileKey: 'fullscreenDump', defaultValue: 'true', secret: false });
    expect(settingSpec('ui.fullscreenDump').flag).toBeUndefined();
    expect(settingSpec('ui.fullscreenDump').boolFlag).toBeUndefined();
    expect(settingSpec('ui.fullscreenDump').launch).toBeUndefined();
    // the five launch rows are unchanged by contract 1.6 (the row above pins the list)
    expect(LAUNCH_SETTINGS.map((x) => x.name)).not.toContain('ui.renderer');
  });
});

describe('TUI-DESIGN-3 §0.1 (D-Q): the seen.defaultMode bookkeeping row', () => {
  it('is a file-only, non-secret, hidden row with no flag and no variable; the description names it bookkeeping', () => {
    const spec = settingSpec('seen.defaultMode');
    expect(spec).toMatchObject({ name: 'seen.defaultMode', env: [], fileKey: 'seenDefaultMode', defaultValue: null, secret: false, hidden: true });
    expect(spec.flag).toBeUndefined();
    expect(spec.boolFlag).toBeUndefined();
    expect(spec.launch).toBeUndefined();
    expect(spec.description).toContain('bookkeeping');
    // the only hidden row this round
    expect(SETTINGS.filter((s) => s.hidden === true).map((s) => s.name)).toEqual(['seen.defaultMode']);
  });
});
