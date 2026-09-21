/**
 * Colour themes (TUI-DESIGN §14.1 "Colour", D13, F2): `--theme dark|light|daltonized|ansi`, ANSI-16 named
 * colours only, no backgrounds, and a textual marker paired with every colour so a frame reads the same with
 * colour off (`NO_COLOR`, `--no-color`, `TERM=dumb`). `daltonized` swaps red ↔ blue for the review/block roles;
 * `ansi` never dims. `/theme` swaps the table for new items and the dynamic region only (R4): the theme is a
 * prop, never a `<Static>` remount. Pure tables and pure functions.
 */
import type { TranscriptItem } from './plain.js';

export type ThemeName = 'dark' | 'light' | 'daltonized' | 'ansi';
export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'daltonized', 'ansi'];

/** The sixteen chalk / Ink colour names (and nothing else, TUI-DESIGN §14.1). */
export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright';

export const ANSI_COLORS: readonly AnsiColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
];

/** Everything the TUI colours; every role has a marker twin the rows already carry as text (§14.1 "marker or word beside every colour"). */
export type ColorRole = 'error' | 'warn' | 'ok' | 'block' | 'review' | 'steer' | 'dim' | 'accent' | 'secret' | 'chosen' | 'rule' | 'placeholder';

export const COLOR_ROLES: readonly ColorRole[] = ['error', 'warn', 'ok', 'block', 'review', 'steer', 'dim', 'accent', 'secret', 'chosen', 'rule', 'placeholder'];

export interface ColorSpec {
  readonly color?: AnsiColor;
  readonly dimColor?: boolean;
  readonly bold?: boolean;
  /** the text twin of the colour (what the row shows whether or not colour is on) */
  readonly marker: string;
}

export interface Theme {
  readonly name: ThemeName;
  readonly roles: Readonly<Record<ColorRole, ColorSpec>>;
}

const DARK: Theme = {
  name: 'dark',
  roles: {
    error: { color: 'red', marker: 'error' },
    warn: { color: 'yellow', marker: 'warning' },
    ok: { color: 'green', marker: '✓' },
    block: { color: 'red', bold: true, marker: '[block]' },
    review: { color: 'yellow', marker: '[review]' },
    steer: { color: 'yellow', marker: '>' },
    dim: { dimColor: true, marker: '' },
    accent: { color: 'cyan', marker: '' },
    secret: { color: 'yellow', marker: '⚠ secret?' },
    chosen: { color: 'green', marker: '[chosen]' },
    rule: { dimColor: true, marker: '─' },
    placeholder: { dimColor: true, marker: '…' },
  },
};

/** Light backgrounds: yellow is unreadable, so the warning family moves to blue; dim stays dim. */
const LIGHT: Theme = {
  name: 'light',
  roles: {
    ...DARK.roles,
    warn: { color: 'blue', marker: 'warning' },
    review: { color: 'blue', marker: '[review]' },
    steer: { color: 'blue', marker: '>' },
    secret: { color: 'blue', marker: '⚠ secret?' },
    accent: { color: 'magenta', marker: '' },
    ok: { color: 'green', marker: '✓' },
  },
};

/** TUI-DESIGN §14.1: red ↔ blue swapped for the review/block family (deuteranopia-safe pairs). */
const DALTONIZED: Theme = {
  name: 'daltonized',
  roles: {
    ...DARK.roles,
    error: { color: 'blue', marker: 'error' },
    block: { color: 'blue', bold: true, marker: '[block]' },
    review: { color: 'yellow', marker: '[review]' },
    ok: { color: 'cyan', marker: '✓' },
    chosen: { color: 'cyan', marker: '[chosen]' },
  },
};

/** TUI-DESIGN §14.1: `ansi` = no dim anywhere (some 16-colour terminals render dim as invisible). */
const ANSI: Theme = {
  name: 'ansi',
  roles: Object.fromEntries(Object.entries(DARK.roles).map(([k, v]) => [k, { ...v, dimColor: false, ...(v.dimColor === true && v.color === undefined ? { color: 'gray' as AnsiColor } : {}) }])) as Record<ColorRole, ColorSpec>,
};

export const THEMES: Readonly<Record<ThemeName, Theme>> = { dark: DARK, light: LIGHT, daltonized: DALTONIZED, ansi: ANSI };

/** TUI-DESIGN §16: the theme for a name; unknown or absent → `dark` (no auto-detect, C15). */
export function themeFor(name: string | null | undefined): Theme {
  return name !== null && name !== undefined && (THEME_NAMES as readonly string[]).includes(name) ? THEMES[name as ThemeName] : DARK;
}

/** The Ink `<Text>` props for a role — `{}` when colour is off (the marker text stays). */
export function textProps(theme: Theme, role: ColorRole, enabled: boolean): { color?: AnsiColor; dimColor?: boolean; bold?: boolean } {
  if (!enabled) return {};
  const s = theme.roles[role];
  return {
    ...(s.color !== undefined ? { color: s.color } : {}),
    ...(s.dimColor !== undefined ? { dimColor: s.dimColor } : {}),
    ...(s.bold !== undefined ? { bold: s.bold } : {}),
  };
}

/** The role a transcript item is coloured with (the former `itemColor` rule of Transcript.tsx, now theme-driven). */
export function itemRole(item: Pick<TranscriptItem, 'level' | 'verdict' | 'kind' | 'local'>): ColorRole | null {
  if (item.level === 'error' || item.verdict === 'block') return 'error';
  if (item.level === 'warn' || item.verdict === 'review') return 'warn';
  if (item.kind === 'proposal' || item.kind === 'run:start' || item.kind === 'run:end') return null;
  return 'dim';
}

/** Every theme uses ANSI-16 names only and pairs every colour with a marker (tested; the CI gate of §14.1). */
export function validateTheme(theme: Theme): string[] {
  const problems: string[] = [];
  for (const role of COLOR_ROLES) {
    const s = theme.roles[role];
    if (s.color !== undefined && !ANSI_COLORS.includes(s.color)) problems.push(`${theme.name}.${role}: ${s.color} is not an ANSI-16 name`);
    // dim / rule / placeholder / accent are de-emphasis and decoration, not meaning: they need no marker twin
    if (s.color !== undefined && s.marker === '' && role !== 'accent' && role !== 'dim' && role !== 'rule' && role !== 'placeholder') problems.push(`${theme.name}.${role}: a colour without a marker`);
    if (theme.name === 'ansi' && s.dimColor === true) problems.push(`ansi.${role}: dims`);
  }
  return problems;
}
