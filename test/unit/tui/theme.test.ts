/**
 * TUI-DESIGN §19.0 (`theme.test.ts`, §14.1): `colorEnabled()` precedence (flag > FORCE_COLOR > NO_COLOR > TERM=dumb
 * > hasColors(16)), the NO_COLOR shim (`FORCE_COLOR=0`), the four ANSI-16 tables with a marker beside every colour,
 * the daltonized red↔blue swap, `ansi` never dimming, `textProps` returning `{}` with colour off, and `itemRole`.
 */
import { describe, expect, it } from 'vitest';
import { applyNoColorShim, colorDepth, colorEnabled } from '../../../src/tui/color-shim.js';
import { ANSI_COLORS, COLOR_ROLES, THEMES, THEME_NAMES, colorAt, depthOf, itemRole, textProps, themeFor, validateTheme, type Theme } from '../../../src/tui/theme.js';

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

describe('colorDepth (TUI-DESIGN-2 §4.9)', () => {
  const tty = { isTTY: true, hasColors: (n?: number) => (n ?? 16) <= 256 };
  it('the truth table: off → 0; FORCE_COLOR 3/2/1; COLORTERM; TERM_PROGRAM; TERM; else 16', () => {
    expect(colorDepth({ noColor: true, env: { COLORTERM: 'truecolor' }, stream: tty })).toBe(0);
    expect(colorDepth({ env: { NO_COLOR: '1', COLORTERM: 'truecolor' }, stream: tty })).toBe(0);
    expect(colorDepth({ env: { TERM: 'dumb' }, stream: tty })).toBe(0);
    expect(colorDepth({ env: { FORCE_COLOR: '3' }, stream: tty })).toBe(24);
    expect(colorDepth({ env: { FORCE_COLOR: '2' }, stream: tty })).toBe(256);
    expect(colorDepth({ env: { FORCE_COLOR: '1', COLORTERM: 'truecolor' }, stream: tty })).toBe(16);
    expect(colorDepth({ env: { COLORTERM: 'truecolor' }, stream: tty })).toBe(24);
    expect(colorDepth({ env: { COLORTERM: '24bit' }, stream: tty })).toBe(24);
    for (const program of ['iTerm.app', 'WezTerm', 'ghostty', 'vscode']) expect(colorDepth({ env: { TERM_PROGRAM: program, TERM: 'xterm' }, stream: tty })).toBe(24);
    expect(colorDepth({ env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, stream: tty })).toBe(256);
    expect(colorDepth({ env: { TERM: 'xterm-256color' }, stream: tty })).toBe(256);
    expect(colorDepth({ env: { TERM: 'screen-256' }, stream: tty })).toBe(256);
    for (const term of ['alacritty', 'xterm-kitty', 'wezterm', 'foot']) expect(colorDepth({ env: { TERM: term }, stream: tty })).toBe(256);
    expect(colorDepth({ env: { TERM: 'xterm' }, stream: tty })).toBe(16);
    expect(colorDepth({ env: {}, stream: tty })).toBe(16);
    expect(colorDepth({ env: {}, stream: { isTTY: false } })).toBe(0);
  });
  it('depthOf maps the boolean callers; colorAt picks the deepest member the triple carries', () => {
    expect(depthOf(true)).toBe(16);
    expect(depthOf(false)).toBe(0);
    expect(depthOf(256)).toBe(256);
    expect(colorAt({ ansi16: 'cyan', ansi256: 117, truecolor: '#7DD3FC' }, 24)).toBe('#7DD3FC');
    expect(colorAt({ ansi16: 'cyan', ansi256: 117, truecolor: '#7DD3FC' }, 256)).toBe('ansi256(117)');
    expect(colorAt({ ansi16: 'cyan', ansi256: 117, truecolor: '#7DD3FC' }, 16)).toBe('cyan');
    expect(colorAt({ ansi16: 'cyan', ansi256: 117 }, 24)).toBe('ansi256(117)');
    expect(colorAt({ ansi16: 'cyan' }, 24)).toBe('cyan');
  });
});

describe('themes (§14.1, TUI-DESIGN-2 §4.9)', () => {
  it('four tables, ANSI-16 names in ansi16, every colour paired with a marker, ansi never dims and carries no 256/truecolor member', () => {
    expect(THEME_NAMES).toEqual(['dark', 'light', 'daltonized', 'ansi']);
    for (const name of THEME_NAMES) {
      const t = THEMES[name];
      expect(t.name).toBe(name);
      expect(validateTheme(t)).toEqual([]);
      for (const role of COLOR_ROLES) {
        const s = t.roles[role];
        if (s.color !== undefined) expect(ANSI_COLORS).toContain(s.color.ansi16);
        if (name === 'ansi') {
          expect(s.dimColor).not.toBe(true);
          expect(s.color?.ansi256).toBeUndefined();
          expect(s.color?.truecolor).toBeUndefined();
        }
      }
    }
    // the new roles carry their markers: `[you]`, the badge word, the fence glyph
    expect(THEMES.dark.roles.you.marker).toBe('[you]');
    expect(THEMES.dark.roles.badge.marker).toBe('jev-only');
    expect(THEMES.dark.roles.code.marker).toBe('╶');
    expect(THEMES.dark.roles.assistant.color).toBeUndefined();
  });

  it('the §4.9 table: accent #7DD3FC / 117 / cyan (dark), #0369A1 / 25 / blue (light); you, borderFocus, code, sweep twins', () => {
    expect(THEMES.dark.roles.accent.color).toEqual({ ansi16: 'cyan', ansi256: 117, truecolor: '#7DD3FC' });
    expect(THEMES.light.roles.accent.color).toEqual({ ansi16: 'blue', ansi256: 25, truecolor: '#0369A1' });
    expect(THEMES.dark.roles.badge.bold).toBe(true);
    expect(THEMES.dark.roles.borderFocus.color).toEqual({ ansi16: 'cyan', ansi256: 74, truecolor: '#38BDF8' });
    expect(THEMES.light.roles.borderFocus.color).toEqual({ ansi16: 'blue', ansi256: 31, truecolor: '#0284C7' });
    expect(THEMES.dark.roles.you.color).toEqual({ ansi16: 'blueBright', ansi256: 147, truecolor: '#A5B4FC' });
    expect(THEMES.light.roles.you.color).toEqual({ ansi16: 'blue', ansi256: 61, truecolor: '#4338CA' });
    expect(THEMES.dark.roles.code.color).toEqual({ ansi16: 'whiteBright', ansi256: 254, truecolor: '#E2E8F0' });
    expect(THEMES.light.roles.code.color).toEqual({ ansi16: 'black', ansi256: 236, truecolor: '#1E293B' });
    expect(THEMES.dark.roles.sweep.color).toEqual({ ansi16: 'whiteBright', ansi256: 195, truecolor: '#E0F2FE' });
    expect(THEMES.light.roles.sweep.color).toEqual({ ansi16: 'blue', ansi256: 24, truecolor: '#075985' });
    expect(THEMES.dark.roles.border.dimColor).toBe(true);
    expect(THEMES.ansi.roles.border.color).toEqual({ ansi16: 'gray' });
    expect(THEMES.dark.roles.error.color?.truecolor).toBe('#F87171');
    expect(THEMES.dark.roles.warn.color?.ansi256).toBe(214);
    expect(THEMES.dark.roles.ok.color?.ansi256).toBe(114);
  });

  it('daltonized swaps red ↔ blue for the review / block family; light moves the warning family off yellow', () => {
    expect(THEMES.dark.roles.error.color?.ansi16).toBe('red');
    expect(THEMES.dark.roles.block.color?.ansi16).toBe('red');
    expect(THEMES.daltonized.roles.error.color?.ansi16).toBe('blue');
    expect(THEMES.daltonized.roles.block.color?.ansi16).toBe('blue');
    expect(THEMES.light.roles.warn.color?.ansi16).not.toBe('yellow');
    expect(THEMES.light.roles.review.color?.ansi16).not.toBe('yellow');
  });

  it('themeFor falls back to dark; textProps is {} with colour off, the ANSI-16 name at true / 16, ansi256(n) at 256, #rrggbb at 24', () => {
    expect(themeFor('light').name).toBe('light');
    expect(themeFor('nope').name).toBe('dark');
    expect(themeFor(null).name).toBe('dark');
    expect(textProps(THEMES.dark, 'error', false)).toEqual({});
    expect(textProps(THEMES.dark, 'error', 0)).toEqual({});
    expect(textProps(THEMES.dark, 'error', true)).toEqual({ color: 'red' });
    expect(textProps(THEMES.dark, 'error', 16)).toEqual({ color: 'red' });
    expect(textProps(THEMES.dark, 'accent', 256)).toEqual({ color: 'ansi256(117)' });
    expect(textProps(THEMES.dark, 'accent', 24)).toEqual({ color: '#7DD3FC' });
    expect(textProps(THEMES.dark, 'badge', 24)).toEqual({ color: '#7DD3FC', bold: true });
    expect(textProps(THEMES.ansi, 'accent', 24)).toEqual({ color: 'cyan', dimColor: false });
    expect(textProps(THEMES.dark, 'dim', true)).toEqual({ dimColor: true });
    expect(textProps(THEMES.ansi, 'dim', true)).toEqual({ color: 'gray', dimColor: false });
    expect(THEMES.dark.roles.review.marker).toBe('[review]');
    expect(THEMES.dark.roles.secret.marker).toBe('⚠ secret?');
  });

  it('validateTheme rejects a non-ANSI ansi16, a malformed truecolor, an ansi256 outside 0..255, a dimming or deep `ansi` theme and a marker-less you/badge/code', () => {
    const bad: Theme = {
      name: 'dark',
      roles: {
        ...THEMES.dark.roles,
        error: { color: { ansi16: 'crimson' as never, truecolor: '#12345' as `#${string}`, ansi256: 300 }, marker: 'error' },
        you: { color: { ansi16: 'blue' }, marker: '' },
      },
    };
    const problems = validateTheme(bad);
    expect(problems).toContain('dark.error: crimson is not an ANSI-16 name');
    expect(problems).toContain('dark.error: truecolor #12345 is not #rrggbb');
    expect(problems).toContain('dark.error: ansi256 300 is outside 0..255');
    expect(problems).toContain('dark.you: needs a marker');
    const deep: Theme = { name: 'ansi', roles: { ...THEMES.ansi.roles, accent: { color: { ansi16: 'cyan', truecolor: '#7DD3FC' }, marker: '' }, dim: { dimColor: true, marker: '' } } };
    expect(validateTheme(deep)).toEqual(expect.arrayContaining(['ansi.accent: carries a 256/truecolor member', 'ansi.dim: dims']));
  });

  it('itemRole: errors and blocks red, warnings and reviews yellow, proposal / run:start / run:end plain, the rest dim', () => {
    expect(itemRole({ level: 'error', kind: 'error' })).toBe('error');
    expect(itemRole({ level: 'info', kind: 'risk', verdict: 'block' })).toBe('error');
    expect(itemRole({ level: 'warn', kind: 'transcript' })).toBe('warn');
    expect(itemRole({ level: 'info', kind: 'risk', verdict: 'review' })).toBe('warn');
    expect(itemRole({ level: 'info', kind: 'proposal' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'run:end' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'ui', local: true })).toBe('dim');
    // TUI-DESIGN-2 §4.5: `[you]` bodies take the `you` role, `[jevcode]` bodies the default
    expect(itemRole({ level: 'info', kind: 'ui', local: true, label: '[you]' })).toBe('you');
    expect(itemRole({ level: 'info', kind: 'ui', local: true, label: '[jevcode]' })).toBeNull();
  });
});
