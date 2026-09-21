/**
 * TUI-DESIGN §19.0 (`theme.test.ts`, §14.1): `colorEnabled()` precedence (flag > FORCE_COLOR > NO_COLOR > TERM=dumb
 * > hasColors(16)), the NO_COLOR shim (`FORCE_COLOR=0`), the four ANSI-16 tables with a marker beside every colour,
 * the daltonized red↔blue swap, `ansi` never dimming, `textProps` returning `{}` with colour off, and `itemRole`.
 */
import { describe, expect, it } from 'vitest';
import { applyNoColorShim, colorEnabled } from '../../../src/tui/color-shim.js';
import { ANSI_COLORS, COLOR_ROLES, THEMES, THEME_NAMES, itemRole, textProps, themeFor, validateTheme } from '../../../src/tui/theme.js';

describe('colorEnabled (§14.1)', () => {
  const tty = { isTTY: true, hasColors: (n?: number) => (n ?? 16) <= 256 };
  it('flag > FORCE_COLOR > NO_COLOR > TERM=dumb > hasColors(16)', () => {
    expect(colorEnabled({ noColor: true, env: { FORCE_COLOR: '1' }, stream: tty })).toBe(false);
    expect(colorEnabled({ env: { FORCE_COLOR: '1', NO_COLOR: '1' }, stream: tty })).toBe(true);
    expect(colorEnabled({ env: { FORCE_COLOR: '0' }, stream: tty })).toBe(false);
    expect(colorEnabled({ env: { NO_COLOR: '1' }, stream: tty })).toBe(false);
    expect(colorEnabled({ env: { NO_COLOR: '' }, stream: tty })).toBe(true);
    expect(colorEnabled({ env: { TERM: 'dumb' }, stream: tty })).toBe(false);
    expect(colorEnabled({ env: {}, stream: tty })).toBe(true);
    expect(colorEnabled({ env: {}, stream: { isTTY: true, hasColors: () => false } })).toBe(false);
    expect(colorEnabled({ env: {}, stream: { isTTY: false } })).toBe(false);
    expect(colorEnabled({ env: {}, stream: { isTTY: true } })).toBe(true);
    expect(colorEnabled({ env: {}, stream: null })).toBe(false);
  });

  it('the shim maps NO_COLOR → FORCE_COLOR=0 only when FORCE_COLOR is unset', () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
    expect(applyNoColorShim(env)).toBe(true);
    expect(env['FORCE_COLOR']).toBe('0');
    const kept: NodeJS.ProcessEnv = { NO_COLOR: '1', FORCE_COLOR: '3' };
    expect(applyNoColorShim(kept)).toBe(false);
    expect(kept['FORCE_COLOR']).toBe('3');
    expect(applyNoColorShim({ NO_COLOR: '' })).toBe(false);
    expect(applyNoColorShim({})).toBe(false);
  });
});

describe('themes (§14.1)', () => {
  it('four tables, ANSI-16 names only, every colour paired with a marker, ansi never dims', () => {
    expect(THEME_NAMES).toEqual(['dark', 'light', 'daltonized', 'ansi']);
    for (const name of THEME_NAMES) {
      const t = THEMES[name];
      expect(t.name).toBe(name);
      expect(validateTheme(t)).toEqual([]);
      for (const role of COLOR_ROLES) {
        const s = t.roles[role];
        if (s.color !== undefined) expect(ANSI_COLORS).toContain(s.color);
        if (name === 'ansi') expect(s.dimColor).not.toBe(true);
      }
    }
  });

  it('daltonized swaps red ↔ blue for the review / block family; light moves the warning family off yellow', () => {
    expect(THEMES.dark.roles.error.color).toBe('red');
    expect(THEMES.dark.roles.block.color).toBe('red');
    expect(THEMES.daltonized.roles.error.color).toBe('blue');
    expect(THEMES.daltonized.roles.block.color).toBe('blue');
    expect(THEMES.light.roles.warn.color).not.toBe('yellow');
    expect(THEMES.light.roles.review.color).not.toBe('yellow');
  });

  it('themeFor falls back to dark; textProps is {} with colour off and keeps the marker semantics otherwise', () => {
    expect(themeFor('light').name).toBe('light');
    expect(themeFor('nope').name).toBe('dark');
    expect(themeFor(null).name).toBe('dark');
    expect(textProps(THEMES.dark, 'error', false)).toEqual({});
    expect(textProps(THEMES.dark, 'error', true)).toEqual({ color: 'red' });
    expect(textProps(THEMES.dark, 'dim', true)).toEqual({ dimColor: true });
    expect(textProps(THEMES.ansi, 'dim', true)).toEqual({ color: 'gray', dimColor: false });
    expect(THEMES.dark.roles.review.marker).toBe('[review]');
    expect(THEMES.dark.roles.secret.marker).toBe('⚠ secret?');
  });

  it('itemRole: errors and blocks red, warnings and reviews yellow, proposal / run:start / run:end plain, the rest dim', () => {
    expect(itemRole({ level: 'error', kind: 'error' })).toBe('error');
    expect(itemRole({ level: 'info', kind: 'risk', verdict: 'block' })).toBe('error');
    expect(itemRole({ level: 'warn', kind: 'transcript' })).toBe('warn');
    expect(itemRole({ level: 'info', kind: 'risk', verdict: 'review' })).toBe('warn');
    expect(itemRole({ level: 'info', kind: 'proposal' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'run:end' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'ui', local: true })).toBe('dim');
  });
});
