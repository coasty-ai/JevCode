/**
 * Colour themes (TUI-DESIGN §14.1 "Colour", D13, F2; TUI-DESIGN-2 §4.9): `--theme dark|light|daltonized|ansi`, every
 * role a `ColorTriple` — the ANSI-16 name every terminal has, plus the 256-colour index and the truecolor hex the
 * depth detection (`colorDepth`, color-shim.ts) unlocks — no backgrounds, and a textual marker paired with every
 * colour so a frame reads the same with colour off (`NO_COLOR`, `--no-color`, `TERM=dumb`). `daltonized` swaps red ↔
 * blue for the review/block roles; `ansi` is the ANSI-16 twin: no 256/truecolor members and never dims. `/theme` swaps
 * the table for new items and the dynamic region only (R4): the theme is a prop, never a `<Static>` remount. Pure
 * tables and pure functions.
 */
import type { ColorDepth } from './color-shim.js';
import type { TranscriptItem } from './plain.js';

export type { ColorDepth } from './color-shim.js';

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

/**
 * Everything the TUI colours; every role has a marker twin the rows already carry as text (§14.1 "marker or word
 * beside every colour"). TUI-DESIGN-2 §4.9 adds `you` (`[you]`), `assistant` (`[jevcode]`), `badge` (the mode word),
 * `border` / `borderFocus` (the box glyphs / the status word), `code` (the fence rows) and `sweep` (splash motion only).
 */
export type ColorRole = 'error' | 'warn' | 'ok' | 'block' | 'review' | 'steer' | 'dim' | 'accent' | 'secret' | 'chosen' | 'rule' | 'placeholder' | 'you' | 'assistant' | 'badge' | 'border' | 'borderFocus' | 'code' | 'sweep';

export const COLOR_ROLES: readonly ColorRole[] = ['error', 'warn', 'ok', 'block', 'review', 'steer', 'dim', 'accent', 'secret', 'chosen', 'rule', 'placeholder', 'you', 'assistant', 'badge', 'border', 'borderFocus', 'code', 'sweep'];

/** TUI-DESIGN-2 §4.9: one colour at three depths — the ANSI-16 name always, the 256 index and the truecolor hex when the theme has them. */
export interface ColorTriple {
  readonly ansi16: AnsiColor;
  readonly ansi256?: number;
  readonly truecolor?: `#${string}`;
}

export interface ColorSpec {
  readonly color?: ColorTriple;
  readonly dimColor?: boolean;
  readonly bold?: boolean;
  /** the text twin of the colour (what the row shows whether or not colour is on) */
  readonly marker: string;
}

export interface Theme {
  readonly name: ThemeName;
  readonly roles: Readonly<Record<ColorRole, ColorSpec>>;
}

/** decoration roles that need no marker twin (de-emphasis or motion, never meaning) */
const NO_MARKER_ROLES: ReadonlySet<ColorRole> = new Set<ColorRole>(['accent', 'dim', 'rule', 'placeholder', 'sweep', 'assistant']);

const c = (ansi16: AnsiColor, ansi256?: number, truecolor?: `#${string}`): ColorTriple => ({ ansi16, ...(ansi256 !== undefined ? { ansi256 } : {}), ...(truecolor !== undefined ? { truecolor } : {}) });

const DARK: Theme = {
  name: 'dark',
  roles: {
    error: { color: c('red', 203, '#F87171'), marker: 'error' },
    warn: { color: c('yellow', 214, '#FBBF24'), marker: 'warning' },
    ok: { color: c('green', 114, '#4ADE80'), marker: '✓' },
    block: { color: c('red', 203, '#F87171'), bold: true, marker: '[block]' },
    review: { color: c('yellow', 214, '#FBBF24'), marker: '[review]' },
    steer: { color: c('yellow', 214, '#FBBF24'), marker: '>' },
    dim: { dimColor: true, marker: '' },
    accent: { color: c('cyan', 117, '#7DD3FC'), marker: '' },
    secret: { color: c('yellow', 214, '#FBBF24'), marker: '⚠ secret?' },
    chosen: { color: c('green', 114, '#4ADE80'), marker: '[chosen]' },
    rule: { dimColor: true, marker: '─' },
    placeholder: { dimColor: true, marker: '…' },
    // ----- TUI-DESIGN-2 §4.9
    you: { color: c('blueBright', 147, '#A5B4FC'), marker: '[you]' },
    assistant: { marker: '[jevcode]' },
    badge: { color: c('cyan', 117, '#7DD3FC'), bold: true, marker: 'jev-only' },
    border: { dimColor: true, marker: '╭' },
    borderFocus: { color: c('cyan', 74, '#38BDF8'), marker: 'live' },
    code: { color: c('whiteBright', 254, '#E2E8F0'), marker: '╶' },
    sweep: { color: c('whiteBright', 195, '#E0F2FE'), marker: '' },
  },
};

/** Light backgrounds: yellow is unreadable, so the warning family moves to blue; dim stays dim. */
const LIGHT: Theme = {
  name: 'light',
  roles: {
    ...DARK.roles,
    warn: { color: c('blue', 25, '#0369A1'), marker: 'warning' },
    review: { color: c('blue', 25, '#0369A1'), marker: '[review]' },
    steer: { color: c('blue', 25, '#0369A1'), marker: '>' },
    secret: { color: c('blue', 25, '#0369A1'), marker: '⚠ secret?' },
    accent: { color: c('blue', 25, '#0369A1'), marker: '' },
    ok: { color: c('green', 114, '#4ADE80'), marker: '✓' },
    badge: { color: c('blue', 25, '#0369A1'), bold: true, marker: 'jev-only' },
    borderFocus: { color: c('blue', 31, '#0284C7'), marker: 'live' },
    you: { color: c('blue', 61, '#4338CA'), marker: '[you]' },
    code: { color: c('black', 236, '#1E293B'), marker: '╶' },
    sweep: { color: c('blue', 24, '#075985'), marker: '' },
  },
};

/** TUI-DESIGN §14.1: red ↔ blue swapped for the review/block family (deuteranopia-safe pairs). */
const DALTONIZED: Theme = {
  name: 'daltonized',
  roles: {
    ...DARK.roles,
    error: { color: c('blue', 75, '#60A5FA'), marker: 'error' },
    block: { color: c('blue', 75, '#60A5FA'), bold: true, marker: '[block]' },
    review: { color: c('yellow', 214, '#FBBF24'), marker: '[review]' },
    ok: { color: c('cyan', 117, '#7DD3FC'), marker: '✓' },
    chosen: { color: c('cyan', 117, '#7DD3FC'), marker: '[chosen]' },
  },
};

/** TUI-DESIGN §14.1 / TUI-DESIGN-2 §4.9: `ansi` = the ANSI-16 twin — no 256/truecolor members, no dim anywhere (some 16-colour terminals render dim as invisible). */
const ANSI: Theme = {
  name: 'ansi',
  roles: Object.fromEntries(
    Object.entries(DARK.roles).map(([k, v]) => [
      k,
      {
        ...v,
        dimColor: false,
        ...(v.color !== undefined ? { color: { ansi16: v.color.ansi16 } } : v.dimColor === true ? { color: { ansi16: 'gray' as AnsiColor } } : {}),
      },
    ]),
  ) as Record<ColorRole, ColorSpec>,
};

export const THEMES: Readonly<Record<ThemeName, Theme>> = { dark: DARK, light: LIGHT, daltonized: DALTONIZED, ansi: ANSI };

/** TUI-DESIGN §16: the theme for a name; unknown or absent → `dark` (no auto-detect, C15). */
export function themeFor(name: string | null | undefined): Theme {
  return name !== null && name !== undefined && (THEME_NAMES as readonly string[]).includes(name) ? THEMES[name as ThemeName] : DARK;
}

/** `true` = ANSI-16 (today's callers), `false` = off; a `ColorDepth` selects the member of the triple. */
export type ColorOn = boolean | ColorDepth;

/** The depth a `ColorOn` value means. */
export function depthOf(on: ColorOn): ColorDepth {
  if (on === true) return 16;
  if (on === false) return 0;
  return on;
}

/** TUI-DESIGN-2 §4.9: the Ink colour string of a triple at a depth — `'cyan'` · `'ansi256(117)'` · `'#7DD3FC'` (the deepest member the theme carries, downshifting when absent). */
export function colorAt(triple: ColorTriple, depth: ColorDepth): string {
  if (depth === 24 && triple.truecolor !== undefined) return triple.truecolor;
  if ((depth === 24 || depth === 256) && triple.ansi256 !== undefined) return `ansi256(${triple.ansi256})`;
  return triple.ansi16;
}

/** The Ink `<Text>` props for a role — `{}` when colour is off (the marker text stays); the colour member follows the depth. */
export function textProps(theme: Theme, role: ColorRole, on: ColorOn): { color?: string; dimColor?: boolean; bold?: boolean } {
  const depth = depthOf(on);
  if (depth === 0) return {};
  const s = theme.roles[role];
  return {
    ...(s.color !== undefined ? { color: colorAt(s.color, depth) } : {}),
    ...(s.dimColor !== undefined ? { dimColor: s.dimColor } : {}),
    ...(s.bold !== undefined ? { bold: s.bold } : {}),
  };
}

/**
 * The role a transcript item is coloured with (the former `itemColor` rule of Transcript.tsx, now theme-driven; TUI-DESIGN-2 §4.5:
 * `[you]` items take the `you` role, `[jevcode]` items the default).
 */
export function itemRole(item: Pick<TranscriptItem, 'level' | 'verdict' | 'kind' | 'local' | 'label'>): ColorRole | null {
  if (item.level === 'error' || item.verdict === 'block') return 'error';
  if (item.level === 'warn' || item.verdict === 'review') return 'warn';
  if (item.label === '[you]') return 'you';
  if (item.label === '[jevcode]') return null;
  if (item.kind === 'proposal' || item.kind === 'run:start' || item.kind === 'run:end') return null;
  return 'dim';
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Every theme pairs every colour with a marker and names ANSI-16 colours only in `ansi16`; `truecolor` is `#rrggbb`,
 * `ansi256` is 0..255; the `ansi` theme has no 256/truecolor members and never dims; `you`, `badge` and `code` carry a
 * marker (tested; the CI gate of §14.1 / TUI-DESIGN-2 §4.9).
 */
export function validateTheme(theme: Theme): string[] {
  const problems: string[] = [];
  for (const role of COLOR_ROLES) {
    const s = theme.roles[role];
    if (s === undefined) {
      problems.push(`${theme.name}.${role}: missing`);
      continue;
    }
    if (s.color !== undefined) {
      if (!ANSI_COLORS.includes(s.color.ansi16)) problems.push(`${theme.name}.${role}: ${s.color.ansi16} is not an ANSI-16 name`);
      if (s.color.truecolor !== undefined && !HEX_RE.test(s.color.truecolor)) problems.push(`${theme.name}.${role}: truecolor ${s.color.truecolor} is not #rrggbb`);
      if (s.color.ansi256 !== undefined && !(Number.isInteger(s.color.ansi256) && s.color.ansi256 >= 0 && s.color.ansi256 <= 255)) problems.push(`${theme.name}.${role}: ansi256 ${s.color.ansi256} is outside 0..255`);
      if (theme.name === 'ansi' && (s.color.ansi256 !== undefined || s.color.truecolor !== undefined)) problems.push(`ansi.${role}: carries a 256/truecolor member`);
    }
    // de-emphasis and decoration roles need no marker twin; everything that means something does
    if (s.color !== undefined && s.marker === '' && !NO_MARKER_ROLES.has(role)) problems.push(`${theme.name}.${role}: a colour without a marker`);
    if ((role === 'you' || role === 'badge' || role === 'code') && s.marker === '') problems.push(`${theme.name}.${role}: needs a marker`);
    if (theme.name === 'ansi' && s.dimColor === true) problems.push(`ansi.${role}: dims`);
  }
  return problems;
}
