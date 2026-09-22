/**
 * TUI-DESIGN §19.0 (`theme.test.ts`, §14.1): `colorEnabled()` precedence (flag > FORCE_COLOR > NO_COLOR > TERM=dumb
 * > hasColors(16)), the NO_COLOR shim (`FORCE_COLOR=0`), the four ANSI-16 tables with a marker beside every colour,
 * the daltonized red↔blue swap, `ansi` never dimming, `textProps` returning `{}` with colour off, `itemRole` and
 * `labelRole`. TUI-DESIGN-3 §2 re-pins the tables to TypeSafe pink (`dark`, id unchanged), the darkened `light` twins and
 * the new `accent2` role; the arithmetic behind the values (cube cells, contrast, ΔE) is `theme-palette.test.ts`. The `itemRole`
 * fixtures are the real emitters' rows (`gitBannerLine`, `headDriftWarning`, the `instructions:` row of plain.ts), never invented
 * strings, so the `git ` prefix rule is pinned to what the TUI actually receives.
 */
import { describe, expect, it } from 'vitest';
import type { GitState, UiLabel } from '../../../src/core/types.js';
import { applyNoColorShim, colorDepth, colorEnabled } from '../../../src/tui/color-shim.js';
import { GLYPHS, glyphTwin } from '../../../src/tui/glyphs.js';
import { ANSI_COLORS, COLOR_ROLES, THEMES, THEME_NAMES, colorAt, depthOf, itemRole, labelRole, textProps, themeFor, validateTheme, type ColorRole, type Theme } from '../../../src/tui/theme.js';
import { bannerInput, gitBannerLine, headDriftWarning, notRepoState } from '../../../src/workspace/gitstate.js';

// ----- the emitters' rows (test/unit/workspace/gitstate.test.ts fixture shape): what plain.ts hands the TUI as `workspace` items
const AT = { probedAt: '2026-09-21T10:00:00.000Z', probeMs: 14 };
const OID = '7d731c0e9f2a4b5c6d7e8f9a0b1c2d3e4f5a6b7c';
function gitState(over: Partial<GitState> = {}): GitState {
  return {
    repo: true,
    gitDir: '/r/.git',
    commonDir: '/r/.git',
    topLevel: '/r',
    prefix: '',
    linkedWorktree: false,
    head: { kind: 'branch', name: 'main', oid: OID },
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    dirty: { modified: 3, staged: 1, untracked: 1, renamed: 0, unmerged: 0, submodules: 0, entries: [] },
    ...AT,
    ...over,
  };
}
const CLEAN_DIRTY: GitState['dirty'] = { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] };
/** a `workspace` item the way plain.ts:385–390 builds one (label-less; the `[run]` label is the formatter's) */
const workspaceItem = (row: { text: string; level: 'info' | 'warn' }): { level: 'info' | 'warn'; kind: 'workspace'; text: string } => ({ level: row.level, kind: 'workspace', text: row.text });

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
    expect(colorAt({ ansi16: 'magentaBright', ansi256: 211, truecolor: '#f386a1' }, 24)).toBe('#f386a1');
    expect(colorAt({ ansi16: 'magentaBright', ansi256: 211, truecolor: '#f386a1' }, 256)).toBe('ansi256(211)');
    expect(colorAt({ ansi16: 'magentaBright', ansi256: 211, truecolor: '#f386a1' }, 16)).toBe('magentaBright');
    expect(colorAt({ ansi16: 'magentaBright', ansi256: 211 }, 24)).toBe('ansi256(211)');
    expect(colorAt({ ansi16: 'magentaBright' }, 24)).toBe('magentaBright');
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
    // the new roles carry their markers: `[you]`, the badge placeholder (the rendered word is MODE_BADGE_WORD's, never the theme's), the fence glyph
    expect(THEMES.dark.roles.you.marker).toBe('[you]');
    expect(THEMES.dark.roles.badge.marker).toBe('<mode>');
    expect(THEMES.dark.roles.code.marker).toBe('╶');
    // TUI-DESIGN-3 §2.1: the `[jevcode]` label is the primary pink, bold (D-O)
    expect(THEMES.dark.roles.assistant.color).toEqual({ ansi16: 'magentaBright', ansi256: 211, truecolor: '#f386a1' });
    expect(THEMES.dark.roles.assistant.bold).toBe(true);
    expect(THEMES.dark.roles.assistant.marker).toBe('[jevcode]');
    expect(COLOR_ROLES).toContain('accent2');
    expect(COLOR_ROLES).toHaveLength(20);
  });

  it('the §2.1 table (TypeSafe pink): accent #f386a1 / 211 / magentaBright (dark), #be185d / 125 / magenta (light); you, borderFocus, accent2, code, sweep twins', () => {
    const primary = { ansi16: 'magentaBright', ansi256: 211, truecolor: '#f386a1' };
    const secondary = { ansi16: 'magenta', ansi256: 169, truecolor: '#d45bb6' };
    expect(THEMES.dark.roles.accent.color).toEqual(primary);
    expect(THEMES.dark.roles.chosen.color).toEqual(primary);
    expect(THEMES.dark.roles.assistant.color).toEqual(primary);
    expect(THEMES.dark.roles.badge.color).toEqual(primary);
    expect(THEMES.dark.roles.badge.bold).toBe(true);
    expect(THEMES.dark.roles.you.color).toEqual(secondary);
    expect(THEMES.dark.roles.you.bold).toBe(true);
    expect(THEMES.dark.roles.borderFocus.color).toEqual(secondary);
    expect(THEMES.dark.roles.borderFocus.bold).toBeUndefined();
    expect(THEMES.dark.roles.accent2.color).toEqual(secondary);
    expect(THEMES.dark.roles.accent2.marker).toBe('');
    expect(THEMES.dark.roles.code.color).toEqual({ ansi16: 'whiteBright', ansi256: 254, truecolor: '#e5e5e5' });
    expect(THEMES.dark.roles.sweep.color).toEqual({ ansi16: 'whiteBright', ansi256: 224, truecolor: '#fbd0dc' });
    expect(THEMES.dark.roles.border.dimColor).toBe(true);
    expect(THEMES.ansi.roles.border.color).toEqual({ ansi16: 'gray' });
    expect(THEMES.dark.roles.error.color?.truecolor).toBe('#F87171');
    expect(THEMES.dark.roles.warn.color?.ansi256).toBe(214);
    expect(THEMES.dark.roles.ok.color).toEqual({ ansi16: 'green', ansi256: 78, truecolor: '#4ADE80' });
    // §2.2: the light table — darkened pinks on plain magenta, the inherited red / green fixed, the warning family blue, code #1e1e1e
    const lightPrimary = { ansi16: 'magenta', ansi256: 125, truecolor: '#be185d' };
    const lightSecondary = { ansi16: 'magenta', ansi256: 89, truecolor: '#831843' };
    expect(THEMES.light.roles.accent.color).toEqual(lightPrimary);
    expect(THEMES.light.roles.chosen.color).toEqual(lightPrimary);
    expect(THEMES.light.roles.assistant.color).toEqual(lightPrimary);
    expect(THEMES.light.roles.assistant.bold).toBe(true);
    expect(THEMES.light.roles.badge.color).toEqual(lightPrimary);
    expect(THEMES.light.roles.badge.bold).toBe(true);
    expect(THEMES.light.roles.you.color).toEqual(lightSecondary);
    expect(THEMES.light.roles.you.bold).toBe(true);
    expect(THEMES.light.roles.borderFocus.color).toEqual(lightSecondary);
    expect(THEMES.light.roles.accent2.color).toEqual(lightSecondary);
    expect(THEMES.light.roles.sweep.color).toEqual(lightSecondary);
    expect(THEMES.light.roles.error.color).toEqual({ ansi16: 'red', ansi256: 124, truecolor: '#b91c1c' });
    expect(THEMES.light.roles.block.color).toEqual({ ansi16: 'red', ansi256: 124, truecolor: '#b91c1c' });
    expect(THEMES.light.roles.block.bold).toBe(true);
    expect(THEMES.light.roles.ok.color).toEqual({ ansi16: 'green', ansi256: 29, truecolor: '#15803d' });
    for (const role of ['warn', 'review', 'steer', 'secret'] as const) expect(THEMES.light.roles[role].color).toEqual({ ansi16: 'blue', ansi256: 25, truecolor: '#0369A1' });
    expect(THEMES.light.roles.code.color).toEqual({ ansi16: 'black', ansi256: 234, truecolor: '#1e1e1e' });
    for (const role of ['dim', 'rule', 'placeholder', 'border'] as const) {
      expect(THEMES.light.roles[role].dimColor).toBe(true);
      expect(THEMES.light.roles[role].color).toBeUndefined();
    }
    // the markers survive the light overrides
    for (const role of COLOR_ROLES) expect(THEMES.light.roles[role].marker).toBe(THEMES.dark.roles[role].marker);
  });

  it('daltonized swaps red ↔ blue for the review / block family, ok takes the freed cyan, [chosen] inherits pink; light moves the warning family off yellow', () => {
    expect(THEMES.dark.roles.error.color?.ansi16).toBe('red');
    expect(THEMES.dark.roles.block.color?.ansi16).toBe('red');
    expect(THEMES.daltonized.roles.error.color).toEqual({ ansi16: 'blue', ansi256: 75, truecolor: '#60A5FA' });
    expect(THEMES.daltonized.roles.block.color).toEqual({ ansi16: 'blue', ansi256: 75, truecolor: '#60A5FA' });
    expect(THEMES.daltonized.roles.block.bold).toBe(true);
    expect(THEMES.daltonized.roles.ok.color).toEqual({ ansi16: 'cyan', ansi256: 117, truecolor: '#7DD3FC' });
    expect(THEMES.daltonized.roles.review.color).toEqual(THEMES.dark.roles.review.color);
    // §2.3: no `chosen` override — pink vs the blue block is the ΔE 34 / 20 pair
    expect(THEMES.daltonized.roles.chosen).toEqual(THEMES.dark.roles.chosen);
    for (const role of COLOR_ROLES) if (!['error', 'block', 'ok'].includes(role)) expect(THEMES.daltonized.roles[role]).toEqual(THEMES.dark.roles[role]);
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
    expect(textProps(THEMES.dark, 'accent', 256)).toEqual({ color: 'ansi256(211)' });
    expect(textProps(THEMES.dark, 'accent', 24)).toEqual({ color: '#f386a1' });
    expect(textProps(THEMES.dark, 'badge', 24)).toEqual({ color: '#f386a1', bold: true });
    expect(textProps(THEMES.dark, 'you', 256)).toEqual({ color: 'ansi256(169)', bold: true });
    expect(textProps(THEMES.dark, 'accent2', 24)).toEqual({ color: '#d45bb6' });
    expect(textProps(THEMES.light, 'accent', 24)).toEqual({ color: '#be185d' });
    expect(textProps(THEMES.ansi, 'accent', 24)).toEqual({ color: 'magentaBright', dimColor: false });
    expect(textProps(THEMES.ansi, 'you', 24)).toEqual({ color: 'magenta', dimColor: false, bold: true });
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
    const deep: Theme = { name: 'ansi', roles: { ...THEMES.ansi.roles, accent: { color: { ansi16: 'magentaBright', truecolor: '#f386a1' }, marker: '' }, dim: { dimColor: true, marker: '' } } };
    expect(validateTheme(deep)).toEqual(expect.arrayContaining(['ansi.accent: carries a 256/truecolor member', 'ansi.dim: dims']));
  });

  it('itemRole: errors and blocks red, warnings and reviews yellow, the `[run] git …` status banner dim, every other body plain (TUI-DESIGN-3 §5.1 rule 2)', () => {
    expect(itemRole({ level: 'error', kind: 'error' })).toBe('error');
    expect(itemRole({ level: 'info', kind: 'risk', verdict: 'block' })).toBe('error');
    expect(itemRole({ level: 'warn', kind: 'transcript' })).toBe('warn');
    expect(itemRole({ level: 'info', kind: 'risk', verdict: 'review' })).toBe('warn');
    expect(itemRole({ level: 'info', kind: 'proposal' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'run:end' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'run:start' })).toBeNull();
    // §5.1 rule 2: `[ui]` notes, steps and stage lines read in the default foreground — only the label is dim (the `[ui]` → dim branch is gone)
    expect(itemRole({ level: 'info', kind: 'ui', local: true })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'ui', local: true, text: 'mode set' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'step', text: 'edit kth.py · risk 0.12 ok' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'judge' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'chat', label: '[jevcode]' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'workspace' })).toBeNull();
    // D-O: `[you]` and `[jevcode]` bodies are the default foreground; the label carries the pink (labelRole)
    expect(itemRole({ level: 'info', kind: 'ui', local: true, label: '[you]' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'ui', local: true, label: '[jevcode]' })).toBeNull();
    // meaning still wins over the speaker
    expect(itemRole({ level: 'error', kind: 'ui', local: true, label: '[you]' })).toBe('error');
  });

  it('itemRole on the real `[run] git …` rows: the one-line status banner (branch / detached / unborn / linked worktree / --ascii) is dim; the `git none · …` guidance rows are body grade; unmerged and HEAD drift take warn', () => {
    // the status banner, every shape gitBannerLine emits for a repository, unicode and `--ascii`
    const dirty = gitBannerLine(bannerInput(gitState()));
    expect(dirty.text).toBe('git main ↑2 · 3 modified · 1 staged · 1 untracked');
    expect(itemRole(workspaceItem(dirty))).toBe('dim');
    const clean = gitBannerLine(bannerInput(gitState({ ahead: 0, dirty: CLEAN_DIRTY })));
    expect(clean.text).toBe('git main · clean');
    expect(itemRole(workspaceItem(clean))).toBe('dim');
    const detached = gitBannerLine(bannerInput(gitState({ head: { kind: 'detached', oid: OID }, upstream: null, ahead: null, behind: null, dirty: CLEAN_DIRTY })));
    expect(detached.text).toBe('git detached 7d731c0e · clean');
    expect(itemRole(workspaceItem(detached))).toBe('dim');
    const unborn = gitBannerLine(bannerInput(gitState({ head: { kind: 'unborn', name: 'main' }, upstream: null, ahead: null, behind: null, dirty: CLEAN_DIRTY })));
    expect(unborn.text).toBe('git main (unborn, no commits yet) · clean');
    expect(itemRole(workspaceItem(unborn))).toBe('dim');
    const linked = gitBannerLine(bannerInput(gitState({ linkedWorktree: true, commonDir: '/Users/me/proj/.git', head: null, upstream: null, ahead: null, behind: null, dirty: CLEAN_DIRTY })));
    expect(linked.text).toBe('git HEAD (linked worktree of /Users/me/proj) · clean');
    expect(itemRole(workspaceItem(linked))).toBe('dim');
    const ascii = gitBannerLine(bannerInput(gitState()), { ascii: true });
    expect(ascii.text).toBe('git main ^2 - 3 modified - 1 staged - 1 untracked');
    expect(itemRole(workspaceItem(ascii))).toBe('dim');
    const subdir = gitBannerLine(bannerInput(gitState({ prefix: 'pkg/', ahead: 0, dirty: CLEAN_DIRTY })));
    expect(subdir.text).toBe('git main · in subdirectory pkg/ of the repository');
    expect(itemRole(workspaceItem(subdir))).toBe('dim');
    // the `git none · …` rows carry /undo and /diff guidance (90–115 cells): body grade, never dim (§2.1's dim row; a 50 % dim is 3.3:1)
    for (const reason of ['not-a-repo', 'git-missing', 'bare', 'timeout'] as const) {
      for (const opts of [{}, { ascii: true }]) {
        const none = gitBannerLine(bannerInput(notRepoState(reason, AT)), opts);
        expect(none.level).toBe('info');
        expect(none.text.startsWith('git none')).toBe(true);
        expect(none.text.length).toBeGreaterThanOrEqual(70);
        expect(itemRole(workspaceItem(none)), `${reason} ${JSON.stringify(opts)}`).toBeNull();
      }
    }
    expect(gitBannerLine(bannerInput(notRepoState('not-a-repo', AT))).text).toBe('git none · not a git repository: changes made by commands are not recoverable, /diff compares against step pre-images only');
    // warn wins: the unmerged banner is level warn (amber, not dim); so is the HEAD-drift warning of --resume, which never starts with `git `
    const unmerged = gitBannerLine(bannerInput(gitState({ dirty: { ...CLEAN_DIRTY, unmerged: 2 } })));
    expect(unmerged.level).toBe('warn');
    expect(unmerged.text.startsWith('git main')).toBe(true);
    expect(itemRole(workspaceItem(unmerged))).toBe('warn');
    const drift = headDriftWarning({ kind: 'branch', name: 'main', oid: OID }, { kind: 'detached', oid: 'abcdef0123456789abcdef0123456789abcdef01' });
    expect(drift.startsWith('warning: HEAD was ')).toBe(true);
    expect(drift.startsWith('git ')).toBe(false);
    expect(itemRole(workspaceItem({ text: drift, level: 'warn' }))).toBe('warn');
    // the `instructions:` row (plain.ts:389) is a workspace item too — body grade
    expect(itemRole({ level: 'info', kind: 'workspace', text: 'instructions: AGENTS.md (412, sha256 0123abcd)' })).toBeNull();
  });

  it('itemRole never returns a pink role (§2.7: never a pink body) — the range is {error, warn, dim, null} over the emitters’ rows and a chat / ui / step sample', () => {
    const allowed: ReadonlySet<ColorRole | null> = new Set<ColorRole | null>(['error', 'warn', 'dim', null]);
    const pink: readonly ColorRole[] = ['accent', 'accent2', 'you', 'assistant', 'badge', 'chosen', 'borderFocus'];
    const samples: readonly Parameters<typeof itemRole>[0][] = [
      workspaceItem(gitBannerLine(bannerInput(gitState()))),
      workspaceItem(gitBannerLine(bannerInput(gitState({ dirty: { ...CLEAN_DIRTY, unmerged: 1 } })))),
      ...(['not-a-repo', 'git-missing', 'bare', 'timeout'] as const).map((reason) => workspaceItem(gitBannerLine(bannerInput(notRepoState(reason, AT))))),
      workspaceItem({ text: headDriftWarning(null, { kind: 'branch', name: 'main', oid: OID }), level: 'warn' }),
      { level: 'info', kind: 'workspace', text: 'instructions: AGENTS.md (412, sha256 0123abcd)' },
      { level: 'info', kind: 'chat', local: true, label: '[you]', text: 'fix the flaky test' },
      { level: 'info', kind: 'chat', local: true, label: '[jevcode]', text: 'Jev decides every step' },
      { level: 'info', kind: 'ui', local: true, label: '[ui]', text: 'theme light' },
      { level: 'info', kind: 'ui', local: true, label: '[setup]' },
      { level: 'info', kind: 'ui', local: true, label: '[config]' },
      { level: 'info', kind: 'ui', local: true, label: '[sandbox]' },
      { level: 'info', kind: 'step', text: 'edit kth.py · risk 0.12 ok' },
      { level: 'info', kind: 'risk', verdict: 'ok' },
      { level: 'info', kind: 'risk', verdict: 'review' },
      { level: 'info', kind: 'risk', verdict: 'block' },
      { level: 'error', kind: 'error', text: 'boom' },
      { level: 'warn', kind: 'transcript' },
      { level: 'info', kind: 'proposal' },
      { level: 'info', kind: 'run:start' },
      { level: 'info', kind: 'run:end' },
    ];
    for (const item of samples) {
      const role = itemRole(item);
      expect(allowed.has(role), JSON.stringify(item)).toBe(true);
      expect(pink.includes(role as ColorRole), JSON.stringify(item)).toBe(false);
    }
  });

  it('labelRole (TUI-DESIGN-3 §2.1, D-O): `[jevcode]` → assistant, `[you]` → you, every other label dim — every `UiLabel` value, and its `--ascii` twin', () => {
    expect(labelRole({ label: '[jevcode]' })).toBe('assistant');
    expect(labelRole({ label: '[you]' })).toBe('you');
    expect(labelRole({ label: '[ui]' })).toBe('dim');
    expect(labelRole({ label: '[setup]' })).toBe('dim');
    expect(labelRole({ label: '[sandbox]' })).toBe('dim');
    expect(labelRole({})).toBe('dim');
    // the whole label union (a new UiLabel member fails to compile here until it is classified — a label never goes pink silently)
    const EXPECTED: Readonly<Record<UiLabel, 'assistant' | 'you' | 'dim'>> = { '[jevcode]': 'assistant', '[you]': 'you', '[ui]': 'dim', '[setup]': 'dim', '[config]': 'dim', '[sandbox]': 'dim' };
    for (const label of Object.keys(EXPECTED) as UiLabel[]) {
      expect(labelRole({ label })).toBe(EXPECTED[label]);
      // `--ascii` changes glyphs, not labels: every label is printable ASCII, so its twin is itself and the role cannot drift
      expect(glyphTwin(label, GLYPHS.ascii)).toBe(label);
      expect(glyphTwin(label, GLYPHS.sr)).toBe(label);
    }
    expect(Object.values(EXPECTED).filter((r) => r !== 'dim')).toHaveLength(2);
    // the two chat labels are the only pink labels; both roles are bold in every coloured theme and never dim
    for (const name of THEME_NAMES) {
      expect(THEMES[name].roles.assistant.bold).toBe(true);
      expect(THEMES[name].roles.you.bold).toBe(true);
      expect(THEMES[name].roles.assistant.dimColor).not.toBe(true);
      expect(THEMES[name].roles.you.dimColor).not.toBe(true);
    }
  });
});
