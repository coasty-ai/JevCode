import { describe, expect, it } from 'vitest';
import { asciiAuto, isSshSession, parseEnvBoolean, parseFps, parseModeHint, resolveLaunchSettings, resolveLaunchSettingsWithSources, type LaunchFlags } from '../../../src/config/launch.js';

const none: LaunchFlags = {};

describe('resolveLaunchSettings (TUI-DESIGN §16: flag > env > default, pure, no file)', () => {
  it('defaults: fps 30, standard, no screen reader, Unicode glyphs, colour, motion; no modeHint (TUI-DESIGN-2 §6 item 14)', () => {
    expect(resolveLaunchSettings(none, {})).toEqual({ fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: false });
    expect('modeHint' in resolveLaunchSettings(none, {})).toBe(false);
    expect(resolveLaunchSettingsWithSources(none, {}).sources).toEqual({ fps: 'default', renderMode: 'default', screenReader: 'default', ascii: 'default', noColor: 'default', modeHint: 'default', reducedMotion: 'default' });
  });

  it('TUI-DESIGN-2 §6 item 14 modeHint: --mode > JEVCODE_MODE > absent (the App reads jev-only); a bad value is skipped here and reported by the `mode` setting with its source', () => {
    expect(resolveLaunchSettingsWithSources(none, { JEVCODE_MODE: 'jev-on' })).toMatchObject({ settings: { modeHint: 'jev-on' }, sources: { modeHint: 'env' } });
    expect(resolveLaunchSettingsWithSources({ mode: 'jev-off' }, { JEVCODE_MODE: 'jev-on' })).toMatchObject({ settings: { modeHint: 'jev-off' }, sources: { modeHint: 'flag' } });
    expect(resolveLaunchSettings({ mode: 'JEV-ONLY' }, {}).modeHint).toBe('jev-only');
    expect(resolveLaunchSettings({ mode: 'turbo' }, { JEVCODE_MODE: 'jev-on' }).modeHint).toBe('jev-on');
    expect('modeHint' in resolveLaunchSettings(none, { JEVCODE_MODE: 'turbo' })).toBe(false);
    expect('modeHint' in resolveLaunchSettings(none, { JEVCODE_MODE: '  ' })).toBe(false);
    expect(parseModeHint(' jev-on ')).toBe('jev-on');
    expect(parseModeHint('jev-only')).toBe('jev-only');
    expect(parseModeHint('x')).toBeNull();
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
