/**
 * Colour themes (TUI-DESIGN §14.1 "Colour", D13, F2; TUI-DESIGN-2 §4.9; TUI-DESIGN-3 §2): `--theme dark|light|daltonized|ansi`,
 * every role a `ColorTriple` — the ANSI-16 name every terminal has, plus the 256-colour index and the truecolor hex the
 * depth detection (`colorDepth`, color-shim.ts) unlocks — no backgrounds, and a textual marker paired with every
 * colour so a frame reads the same with colour off (`NO_COLOR`, `--no-color`, `TERM=dumb`).
 *
 * `dark` = TypeSafe pink (typesafe.ai palette, measured 2026-09-21; D-H): the primary `#f386a1` is rest / brand (`accent`,
 * `badge`, `assistant`, `chosen`, the idle prompt, the wordmark letters), the secondary `#d45bb6` is active / selected
 * (`borderFocus`, `you`, `accent2`); the meaning colours (red, amber, green) keep their hues and pink is never a semantic
 * colour — every pink role's meaning is in its marker. `light` darkens the two pinks (`#be185d` / `#831843`) and fixes the
 * inherited red / green (2.74:1 / 1.73:1 on white). `daltonized` moves the review/block family off red (blue; `[chosen]`
 * inherits pink — pink vs blue is the ΔE 34 / 20 pair); `ansi` is the ANSI-16 twin: no 256/truecolor members and never
 * dims. `/theme` swaps the table for new items and the dynamic region only (R4): the theme is a prop, never a `<Static>`
 * remount. Pure tables and pure functions.
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
 * TUI-DESIGN-3 §2.1 adds `accent2` — the secondary pink: the wordmark caption's `◆`, the palette / mention `▌` on the
 * selected row, the middle step of the run-end edge fade (decoration only, no marker).
 */
export type ColorRole = 'error' | 'warn' | 'ok' | 'block' | 'review' | 'steer' | 'dim' | 'accent' | 'secret' | 'chosen' | 'rule' | 'placeholder' | 'you' | 'assistant' | 'badge' | 'border' | 'borderFocus' | 'code' | 'sweep' | 'accent2';

export const COLOR_ROLES: readonly ColorRole[] = ['error', 'warn', 'ok', 'block', 'review', 'steer', 'dim', 'accent', 'secret', 'chosen', 'rule', 'placeholder', 'you', 'assistant', 'badge', 'border', 'borderFocus', 'code', 'sweep', 'accent2'];

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
const NO_MARKER_ROLES: ReadonlySet<ColorRole> = new Set<ColorRole>(['accent', 'dim', 'rule', 'placeholder', 'sweep', 'assistant', 'accent2']);

const c = (ansi16: AnsiColor, ansi256?: number, truecolor?: `#${string}`): ColorTriple => ({ ansi16, ...(ansi256 !== undefined ? { ansi256 } : {}), ...(truecolor !== undefined ? { truecolor } : {}) });

// ----- TUI-DESIGN-3 §2.1: the two pinks (xterm cube cells 211 / 169 by ΔE2000; `magentaBright` / `magenta` keep the lightness order at depth 16)
const PINK_PRIMARY = c('magentaBright', 211, '#f386a1');
const PINK_SECONDARY = c('magenta', 169, '#d45bb6');
// ----- §2.2: the light twins — the site's pinks on white are 2.38:1 / 3.49:1, so the light theme darkens both (5.99:1 / 9.57:1 on #fefefe)
const LIGHT_PINK_PRIMARY = c('magenta', 125, '#be185d');
const LIGHT_PINK_SECONDARY = c('magenta', 89, '#831843');
const LIGHT_BLUE = c('blue', 25, '#0369A1');

/**
 * TUI-DESIGN-3 §2.1 — the `dark` table (TypeSafe pink). Contrast on `#1e1e1e`: primary 6.93:1, secondary 4.74:1, sweep 12.03:1,
 * code 13.23:1, red 6.03:1, amber 9.99:1, green 9.57:1 (every body role ≥ 4.5:1; the secondary is a label / edge colour).
 * The badge's marker is a neutral placeholder: the rendered word comes from `MODE_BADGE_WORD` (config/defaults.ts), never from here.
 */
const DARK: Theme = {
  name: 'dark',
  roles: {
    error: { color: c('red', 203, '#F87171'), marker: 'error' },
    warn: { color: c('yellow', 214, '#FBBF24'), marker: 'warning' },
    ok: { color: c('green', 78, '#4ADE80'), marker: '✓' },
    block: { color: c('red', 203, '#F87171'), bold: true, marker: '[block]' },
    review: { color: c('yellow', 214, '#FBBF24'), marker: '[review]' },
    steer: { color: c('yellow', 214, '#FBBF24'), marker: '>' },
    dim: { dimColor: true, marker: '' },
    accent: { color: PINK_PRIMARY, marker: '' },
    secret: { color: c('yellow', 214, '#FBBF24'), marker: '⚠ secret?' },
    chosen: { color: PINK_PRIMARY, marker: '[chosen]' },
    rule: { dimColor: true, marker: '─' },
    placeholder: { dimColor: true, marker: '…' },
    // ----- TUI-DESIGN-2 §4.9 roles, TUI-DESIGN-3 §2.1 colours
    you: { color: PINK_SECONDARY, bold: true, marker: '[you]' },
    assistant: { color: PINK_PRIMARY, bold: true, marker: '[jevcode]' },
    badge: { color: PINK_PRIMARY, bold: true, marker: '<mode>' },
    border: { dimColor: true, marker: '╭' },
    borderFocus: { color: PINK_SECONDARY, marker: 'live' },
    code: { color: c('whiteBright', 254, '#e5e5e5'), marker: '╶' },
    sweep: { color: c('whiteBright', 224, '#fbd0dc'), marker: '' },
    // ----- TUI-DESIGN-3 §2.1
    accent2: { color: PINK_SECONDARY, marker: '' },
  },
};

/**
 * TUI-DESIGN-3 §2.2 — light backgrounds (`#fefefe`; also checked on `#ffffff` and Solarized `#fdf6e3`): yellow is unreadable, so the
 * warning family moves to blue; red / green darken (`#b91c1c` 6.42:1, `#15803d` 4.97:1 — the inherited `#F87171` / `#4ADE80` were 2.74 /
 * 1.73); the pinks darken to `#be185d` (5.99:1) / `#831843` (9.57:1) on plain `magenta` (bright magenta on white is ≈ 1.6:1); `code` is
 * the site's `#1e1e1e` (cell 234, exact). `#9d174d` was rejected for the secondary: it shares cube cell 125 with `#be185d`. Dim stays dim.
 */
const LIGHT: Theme = {
  name: 'light',
  roles: {
    ...DARK.roles,
    error: { color: c('red', 124, '#b91c1c'), marker: 'error' },
    block: { color: c('red', 124, '#b91c1c'), bold: true, marker: '[block]' },
    warn: { color: LIGHT_BLUE, marker: 'warning' },
    review: { color: LIGHT_BLUE, marker: '[review]' },
    steer: { color: LIGHT_BLUE, marker: '>' },
    secret: { color: LIGHT_BLUE, marker: '⚠ secret?' },
    ok: { color: c('green', 29, '#15803d'), marker: '✓' },
    accent: { color: LIGHT_PINK_PRIMARY, marker: '' },
    chosen: { color: LIGHT_PINK_PRIMARY, marker: '[chosen]' },
    assistant: { color: LIGHT_PINK_PRIMARY, bold: true, marker: '[jevcode]' },
    badge: { color: LIGHT_PINK_PRIMARY, bold: true, marker: '<mode>' },
    you: { color: LIGHT_PINK_SECONDARY, bold: true, marker: '[you]' },
    borderFocus: { color: LIGHT_PINK_SECONDARY, marker: 'live' },
    accent2: { color: LIGHT_PINK_SECONDARY, marker: '' },
    sweep: { color: LIGHT_PINK_SECONDARY, marker: '' },
    code: { color: c('black', 234, '#1e1e1e'), marker: '╶' },
  },
};

/**
 * TUI-DESIGN §14.1 / TUI-DESIGN-3 §2.3: `dark` with the review/block family moved off red — `error` / `block` blue (pink vs blue is
 * ΔE2000 34.1 for deuteranopes, 20.4 for protanopes), `ok` the freed cyan, `review` amber; `[chosen]` inherits pink (no override).
 */
const DALTONIZED: Theme = {
  name: 'daltonized',
  roles: {
    ...DARK.roles,
    error: { color: c('blue', 75, '#60A5FA'), marker: 'error' },
    block: { color: c('blue', 75, '#60A5FA'), bold: true, marker: '[block]' },
    review: { color: c('yellow', 214, '#FBBF24'), marker: '[review]' },
    ok: { color: c('cyan', 117, '#7DD3FC'), marker: '✓' },
  },
};

/**
 * TUI-DESIGN §14.1 / TUI-DESIGN-2 §4.9 / TUI-DESIGN-3 §2.4: `ansi` = the ANSI-16 twin, derived mechanically from `dark` — no
 * 256/truecolor members, no dim anywhere (some 16-colour terminals render dim as invisible); the primary family is `magentaBright`,
 * the secondary family `magenta`, dim roles `gray`. The derivation picks up every new member.
 */
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

/** TUI-DESIGN §16: the theme for a name; unknown or absent → `dark` (no auto-detect, C15; the `COLORFGBG` hint of D-R is resolved by config/launch.ts, not here). */
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

/** TUI-DESIGN-2 §4.9: the Ink colour string of a triple at a depth — `'magentaBright'` · `'ansi256(211)'` · `'#f386a1'` (the deepest member the theme carries, downshifting when absent). */
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
 * The role a transcript item's **body** is coloured with (the former `itemColor` rule of Transcript.tsx, now theme-driven).
 * TUI-DESIGN-3 §5.1 rule 2 / D-O: label colour is the speaker, body colour is the meaning — red for `error` / `[block]`, amber for
 * `warn` / `[review]`, dim for the `[run] git …` status banner, and the terminal's default foreground for everything else: chat bodies
 * (`[you]` and `[jevcode]` alike — the label carries the pink, `labelRole`), steps, `[ui]` notes, proposals, `[run] start` / `end`.
 * The dim branch is the one-line status banner only (`git main · 3 modified`, `git detached 7d731c0e · clean`, `git HEAD (linked
 * worktree of …) · clean`): the `git none · …` rows (`gitBannerLine` for a non-repository, a missing git, a bare repository or a timed-out
 * probe) are 90–115-cell sentences carrying `/undo` / `/diff` guidance and read at body grade — §2.1's dim row (never a body ≥ 20 cells
 * of guidance; a 50 % dim is 3.3:1, §2.5). The unmerged banner and the HEAD-drift warning arrive as `warn` and take amber first.
 */
export function itemRole(item: Pick<TranscriptItem, 'level' | 'verdict' | 'kind' | 'local' | 'label'> & { readonly text?: string }): ColorRole | null {
  if (item.level === 'error' || item.verdict === 'block') return 'error';
  if (item.level === 'warn' || item.verdict === 'review') return 'warn';
  if (item.kind === 'workspace' && item.text !== undefined && item.text.startsWith('git ') && !item.text.startsWith('git none')) return 'dim';
  return null;
}

/**
 * TUI-DESIGN-3 §2.1 / §5.1 rule 2 (D-O): the role of a transcript item's **label** — `[jevcode]` takes `assistant` (the primary pink,
 * bold), `[you]` takes `you` (the secondary pink, bold), every other label is the dim marker beside a coloured or plain body.
 */
export function labelRole(item: Pick<TranscriptItem, 'label'>): 'assistant' | 'you' | 'dim' {
  if (item.label === '[jevcode]') return 'assistant';
  if (item.label === '[you]') return 'you';
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
