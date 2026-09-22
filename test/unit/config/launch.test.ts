import { describe, expect, it } from 'vitest';
import { asciiAuto, isSshSession, parseColorFgBg, parseThemeHint, parseEnvBoolean, parseFps, parseModeHint, resolveLaunchSettings, resolveLaunchSettingsWithSources, type LaunchFlags } from '../../../src/config/launch.js';
import { MODE_SETTING_VALUES } from '../../../src/config/defaults.js';

const none: LaunchFlags = {};

describe('resolveLaunchSettings (TUI-DESIGN §16: flag > env > default, pure, no file)', () => {
  it('defaults: fps 30, standard, no screen reader, Unicode glyphs, colour, motion, not SSH; no modeHint (TUI-DESIGN-2 §6 item 14), no themeHint (TUI-DESIGN-3 §6 item 8)', () => {
    expect(resolveLaunchSettings(none, {})).toEqual({ fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: false, ssh: false });
    expect('modeHint' in resolveLaunchSettings(none, {})).toBe(false);
    expect('themeHint' in resolveLaunchSettings(none, {})).toBe(false);
    expect(resolveLaunchSettingsWithSources(none, {}).sources).toEqual({
      fps: 'default',
      renderMode: 'default',
      screenReader: 'default',
      ascii: 'default',
      noColor: 'default',
      modeHint: 'default',
      reducedMotion: 'default',
      themeHint: 'default',
      ssh: 'default',
      // contract 1.6 (TUI-DESIGN-4 §8 item 6): `LaunchSources` is keyed on `keyof LaunchSettings`, so the two new
      // optional members have a row. W0 lands the type surface only — S1's §1.3.1 work resolves them.
      renderer: 'default',
      rendererRefusal: 'default',
    });
  });

  it('TUI-DESIGN-3 §6 item 8 ssh: SSH_TTY / SSH_CONNECTION → true with source env (the fps default follows); empty or absent → false', () => {
    expect(resolveLaunchSettingsWithSources(none, { SSH_TTY: '/dev/ttys001' })).toMatchObject({ settings: { ssh: true, fps: 15 }, sources: { ssh: 'env' } });
    expect(resolveLaunchSettingsWithSources(none, { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' })).toMatchObject({ settings: { ssh: true }, sources: { ssh: 'env' } });
    expect(resolveLaunchSettingsWithSources(none, { SSH_TTY: '' })).toMatchObject({ settings: { ssh: false }, sources: { ssh: 'default' } });
    // an explicit fps does not change what the launch source is
    expect(resolveLaunchSettingsWithSources({ fps: '30' }, { SSH_TTY: 'x' })).toMatchObject({ settings: { ssh: true, fps: 30 }, sources: { ssh: 'env', fps: 'flag' } });
  });

  it('TUI-DESIGN-3 §2.2 (D-R, edge 40) themeHint: COLORFGBG background 7 | 15 → light; a dark index or garbage → absent; an explicit known --theme / JEVCODE_THEME is the hint itself (frame 0 honours it)', () => {
    expect(resolveLaunchSettingsWithSources(none, { COLORFGBG: '0;15' })).toMatchObject({ settings: { themeHint: 'light' }, sources: { themeHint: 'env' } });
    expect(resolveLaunchSettings(none, { COLORFGBG: '0;7' }).themeHint).toBe('light');
    expect(resolveLaunchSettings(none, { COLORFGBG: '0;default;15' }).themeHint).toBe('light');
    expect('themeHint' in resolveLaunchSettings(none, { COLORFGBG: '15;0' })).toBe(false);
    expect('themeHint' in resolveLaunchSettings(none, { COLORFGBG: '12;8' })).toBe(false);
    expect('themeHint' in resolveLaunchSettings(none, { COLORFGBG: 'garbage' })).toBe(false);
    expect('themeHint' in resolveLaunchSettings(none, { COLORFGBG: '' })).toBe(false);
    // an explicit, known theme (flag or env) IS frame 0's hint (zero I/O — the splash never paints the dark palette first); it beats COLORFGBG
    expect(resolveLaunchSettingsWithSources({ theme: 'dark' }, { COLORFGBG: '0;15' })).toMatchObject({ settings: { themeHint: 'dark' }, sources: { themeHint: 'flag' } });
    expect(resolveLaunchSettings({ theme: 'light' }, { COLORFGBG: '0;15' }).themeHint).toBe('light');
    expect(resolveLaunchSettings({ theme: 'ANSI' }, {}).themeHint).toBe('ansi');
    expect(resolveLaunchSettingsWithSources(none, { COLORFGBG: '0;15', JEVCODE_THEME: 'dark' })).toMatchObject({ settings: { themeHint: 'dark' }, sources: { themeHint: 'env' } });
    expect(resolveLaunchSettings({ theme: 'light' }, { JEVCODE_THEME: 'dark' }).themeHint).toBe('light');
    // an unknown explicit value is left to the chain (it will be reported by the ui.theme setting) and suppresses the COLORFGBG hint
    expect('themeHint' in resolveLaunchSettings({ theme: 'neon' }, { COLORFGBG: '0;15' })).toBe(false);
    expect('themeHint' in resolveLaunchSettings(none, { COLORFGBG: '0;15', JEVCODE_THEME: 'neon' })).toBe(false);
    expect(resolveLaunchSettings({ theme: '  ' }, { COLORFGBG: '0;15' }).themeHint).toBe('light');
    expect(parseThemeHint(' Light ')).toBe('light');
    expect(parseThemeHint('neon')).toBeNull();
    expect(parseColorFgBg('0;15')).toBe('light');
    expect(parseColorFgBg(' 7;0;7 ')).toBe('light');
    expect(parseColorFgBg('15;0')).toBeNull();
    expect(parseColorFgBg('15')).toBeNull();
    expect(parseColorFgBg('0;1f')).toBeNull();
    expect(parseColorFgBg('')).toBeNull();
  });

  it('TUI-DESIGN-2 §6 item 14 modeHint: --mode > JEVCODE_MODE > absent (the App reads DEFAULT_MODE); a bad value is skipped here and reported by the `mode` setting with its source', () => {
    expect(resolveLaunchSettingsWithSources(none, { JEVCODE_MODE: 'jev-on' })).toMatchObject({ settings: { modeHint: 'jev-on' }, sources: { modeHint: 'env' } });
    expect(resolveLaunchSettingsWithSources({ mode: 'jev-off' }, { JEVCODE_MODE: 'jev-on' })).toMatchObject({ settings: { modeHint: 'jev-off' }, sources: { modeHint: 'flag' } });
    expect(resolveLaunchSettings({ mode: 'JEV-ONLY' }, {}).modeHint).toBe('jev-only');
    expect(resolveLaunchSettings({ mode: 'turbo' }, { JEVCODE_MODE: 'jev-on' }).modeHint).toBe('jev-on');
    expect('modeHint' in resolveLaunchSettings(none, { JEVCODE_MODE: 'turbo' })).toBe(false);
    expect('modeHint' in resolveLaunchSettings(none, { JEVCODE_MODE: '  ' })).toBe(false);
    expect(parseModeHint(' jev-on ')).toBe('jev-on');
    expect(parseModeHint('jev-only')).toBe('jev-only');
    expect(parseModeHint('x')).toBeNull();
    // TUI-DESIGN-3 §1.1 (R3 F2, edge 28): llm-jev is a launch hint too — `--mode llm-jev` shows `llm+jev · verified` from frame 0
    expect(parseModeHint('llm-jev')).toBe('llm-jev');
    expect(resolveLaunchSettingsWithSources({ mode: 'llm-jev' }, {})).toMatchObject({ settings: { modeHint: 'llm-jev' }, sources: { modeHint: 'flag' } });
    expect(resolveLaunchSettings(none, { JEVCODE_MODE: 'llm-jev' }).modeHint).toBe('llm-jev');
    for (const m of MODE_SETTING_VALUES) expect(parseModeHint(m)).toBe(m);
  });

  it('TUI-DESIGN-2 §6 item 14 / §5.3 reducedMotion: --no-animation > JEVCODE_REDUCED_MOTION (`=0` overrides) > screenReader', () => {
    expect(resolveLaunchSettingsWithSources(none, {})).toMatchObject({ settings: { reducedMotion: false }, sources: { reducedMotion: 'default' } });
    expect(resolveLaunchSettingsWithSources(none, { INK_SCREEN_READER: '1' })).toMatchObject({ settings: { screenReader: true, reducedMotion: true }, sources: { reducedMotion: 'default' } });
    expect(resolveLaunchSettingsWithSources(none, { JEVCODE_REDUCED_MOTION: '1' })).toMatchObject({ settings: { reducedMotion: true }, sources: { reducedMotion: 'env' } });
    expect(resolveLaunchSettings(none, { JEVCODE_REDUCED_MOTION: 'true' }).reducedMotion).toBe(true);
    expect(resolveLaunchSettings(none, { JEVCODE_REDUCED_MOTION: '0', INK_SCREEN_READER: '1' }).reducedMotion).toBe(false);
    expect(resolveLaunchSettingsWithSources({ noAnimation: true }, { JEVCODE_REDUCED_MOTION: '0' })).toMatchObject({ settings: { reducedMotion: true }, sources: { reducedMotion: 'flag' } });
    expect(resolveLaunchSettings({ noAnimation: false }, {}).reducedMotion).toBe(false);
    expect(resolveLaunchSettings({ screenReader: true }, {}).reducedMotion).toBe(true);
  });

  it('is pure: same inputs, same output; the env object is never mutated', () => {
    const env = { JEVCODE_FPS: '20', TERM: 'dumb' };
    const before = { ...env };
    expect(resolveLaunchSettings(none, env)).toEqual(resolveLaunchSettings(none, env));
    expect(env).toEqual(before);
  });

  it('fps: flag > JEVCODE_FPS > 15 under SSH > 30; clamped 5..30; unparsable layers are skipped', () => {
    expect(resolveLaunchSettings(none, { SSH_TTY: '/dev/ttys001' }).fps).toBe(15);
    expect(resolveLaunchSettings(none, { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }).fps).toBe(15);
    expect(resolveLaunchSettings(none, { SSH_TTY: '' }).fps).toBe(30);
    expect(resolveLaunchSettingsWithSources(none, { JEVCODE_FPS: '20', SSH_TTY: 'x' })).toMatchObject({ settings: { fps: 20 }, sources: { fps: 'env' } });
    expect(resolveLaunchSettingsWithSources({ fps: '25' }, { JEVCODE_FPS: '20' })).toMatchObject({ settings: { fps: 25 }, sources: { fps: 'flag' } });
    expect(resolveLaunchSettings({ fps: '1' }, {}).fps).toBe(5);
    expect(resolveLaunchSettings({ fps: '99' }, {}).fps).toBe(30);
    expect(resolveLaunchSettings({ fps: '12.6' }, {}).fps).toBe(13);
    for (const bad of ['abc', '', 'Infinity', 'NaN', '-3', '1e3', ' 7 ']) {
      const r = resolveLaunchSettingsWithSources({ fps: bad }, { JEVCODE_FPS: '20' });
      expect(r.settings.fps).toBe(bad.trim() === '7' ? 7 : 20);
    }
    expect(resolveLaunchSettings({ fps: 'abc' }, { JEVCODE_FPS: 'also bad' }).fps).toBe(30);
    expect(parseFps('0')).toBe(5);
    expect(parseFps('30.4')).toBe(30);
    expect(parseFps('x')).toBeNull();
    expect(isSshSession({})).toBe(false);
  });

  it('renderMode: flag > JEVCODE_RENDER_MODE > standard; unknown values fall through', () => {
    expect(resolveLaunchSettingsWithSources(none, { JEVCODE_RENDER_MODE: 'incremental' })).toMatchObject({ settings: { renderMode: 'incremental' }, sources: { renderMode: 'env' } });
    expect(resolveLaunchSettingsWithSources({ renderMode: 'standard' }, { JEVCODE_RENDER_MODE: 'incremental' })).toMatchObject({ settings: { renderMode: 'standard' }, sources: { renderMode: 'flag' } });
    expect(resolveLaunchSettings({ renderMode: 'weird' }, { JEVCODE_RENDER_MODE: 'INCREMENTAL' }).renderMode).toBe('incremental');
    expect(resolveLaunchSettings(none, { JEVCODE_RENDER_MODE: 'weird' }).renderMode).toBe('standard');
  });

  it('screenReader: --screen-reader > JEVCODE_SCREEN_READER > INK_SCREEN_READER > false; `=0` overrides', () => {
    expect(resolveLaunchSettingsWithSources(none, { INK_SCREEN_READER: '1' })).toMatchObject({ settings: { screenReader: true }, sources: { screenReader: 'env' } });
    expect(resolveLaunchSettings(none, { JEVCODE_SCREEN_READER: 'true' }).screenReader).toBe(true);
    expect(resolveLaunchSettings(none, { JEVCODE_SCREEN_READER: '0', INK_SCREEN_READER: '1' }).screenReader).toBe(false);
    expect(resolveLaunchSettings(none, { INK_SCREEN_READER: 'false' }).screenReader).toBe(false);
    expect(resolveLaunchSettingsWithSources({ screenReader: true }, { JEVCODE_SCREEN_READER: '0' })).toMatchObject({ settings: { screenReader: true }, sources: { screenReader: 'flag' } });
    expect(resolveLaunchSettings({ screenReader: false }, {}).screenReader).toBe(false);
  });

  it('ascii: --ascii > JEVCODE_ASCII (`=0` forces Unicode) > auto from TERM / locale', () => {
    expect(asciiAuto({})).toBe(false);
    expect(asciiAuto({ TERM: 'dumb' })).toBe(true);
    expect(asciiAuto({ TERM: 'Linux' })).toBe(true);
    expect(asciiAuto({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' })).toBe(false);
    expect(asciiAuto({ LANG: 'C' })).toBe(true);
    expect(asciiAuto({ LANG: 'en_US.utf8' })).toBe(false);
    expect(asciiAuto({ LC_ALL: 'POSIX', LANG: 'en_US.UTF-8' })).toBe(true);
    expect(asciiAuto({ LC_CTYPE: 'de_DE.UTF-8', LANG: 'C' })).toBe(false);
    expect(resolveLaunchSettingsWithSources(none, { TERM: 'dumb' })).toMatchObject({ settings: { ascii: true }, sources: { ascii: 'default' } });
    expect(resolveLaunchSettingsWithSources(none, { TERM: 'dumb', JEVCODE_ASCII: '0' })).toMatchObject({ settings: { ascii: false }, sources: { ascii: 'env' } });
    expect(resolveLaunchSettings(none, { JEVCODE_ASCII: '1' }).ascii).toBe(true);
    expect(resolveLaunchSettingsWithSources({ ascii: true }, { JEVCODE_ASCII: '0' })).toMatchObject({ settings: { ascii: true }, sources: { ascii: 'flag' } });
  });

  it('noColor: --no-color > NO_COLOR (any non-empty) or FORCE_COLOR=0 > terminal', () => {
    expect(resolveLaunchSettingsWithSources(none, { NO_COLOR: '1' })).toMatchObject({ settings: { noColor: true }, sources: { noColor: 'env' } });
    expect(resolveLaunchSettings(none, { NO_COLOR: 'yes please' }).noColor).toBe(true);
    expect(resolveLaunchSettings(none, { NO_COLOR: '' }).noColor).toBe(false);
    expect(resolveLaunchSettings(none, { FORCE_COLOR: '0' }).noColor).toBe(true);
    expect(resolveLaunchSettings(none, { FORCE_COLOR: '1' }).noColor).toBe(false);
    expect(resolveLaunchSettingsWithSources({ noColor: true }, {})).toMatchObject({ settings: { noColor: true }, sources: { noColor: 'flag' } });
  });

  it('parseEnvBoolean: 0/false/no/off/empty are false, anything else true', () => {
    for (const f of ['0', 'false', 'FALSE', 'no', 'off', '', '  ']) expect(parseEnvBoolean(f)).toBe(false);
    for (const t of ['1', 'true', 'yes', 'on', 'anything']) expect(parseEnvBoolean(t)).toBe(true);
  });

  it('ignores unrelated flag keys (a ParsedFlags object is accepted structurally)', () => {
    const flags = { command: 'chat', task: 'x', fps: '10' } as unknown as LaunchFlags;
    expect(resolveLaunchSettings(flags, {}).fps).toBe(10);
  });
});
