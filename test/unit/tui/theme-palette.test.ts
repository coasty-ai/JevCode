/**
 * TUI-DESIGN-3 §2 / §8 S1 (`theme-palette.test.ts`): the arithmetic behind the TypeSafe pink tables. (1) `textProps` for every
 * theme × role × depth ∈ {16, 256, 24} against an inline golden table; (2) WCAG 2.x contrast of every coloured role on `#1e1e1e`,
 * `#000000` and Solarized `#002b36` (light: `#fefefe`, `#ffffff`, `#fdf6e3`) at the §2 thresholds — body ≥ 4.5:1, marker / edge ≥ 3:1 —
 * with the one documented exception named (the secondary pink on Solarized dark, 4.27:1); the §2.5 table reproduced to two decimals;
 * the same thresholds over every `ansi256` **cell** (what a 256-colour terminal renders — Apple_Terminal, `xterm-256color` without
 * `COLORTERM`), with its two named exceptions (light `ok` cell 29 on Solarized light 4.20; cell 169 on Solarized dark 4.39, the cell twin
 * of the 4.27 row); (3) twins: every `ansi256` is the nearest xterm-256 cell of its truecolor by the cube / grey-ramp arithmetic (R1 §6.1)
 * and within RGB distance ≤ 48, the §2.1 "nearest by ΔE2000" rationale for 211 / 169 / 224 / 78, two roles with different truecolors never
 * share a cell (the 125 collision), every pink role is `magenta` / `magentaBright`, the deliberate 16-colour collapse of the two light
 * pinks (§2.2), `THEMES.ansi` is `dark` with the deep members stripped and never dims; (4) the deuteranopia / protanopia ΔE2000 rules
 * §2.1 / §2.3 state (Machado 2009 simulation, severity 1.0) and the full meaning-pair matrix (error, warn, ok, accent, you) × {normal,
 * deutan, protan} × {truecolor, cell} per theme with every weak pair (< 15) named beside the marker that carries it; (5) markers wherever
 * §2 requires one; (6) `itemRole` / `labelRole` over the whole `UiLabel` union (§5.1 rule 2, D-O); (7) `src/tui/theme.ts` names no mode word (D-N).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UiLabel } from '../../../src/core/types.js';
import { COLOR_ROLES, THEMES, THEME_NAMES, itemRole, labelRole, textProps, validateTheme, type AnsiColor, type ColorRole, type ColorSpec, type ThemeName } from '../../../src/tui/theme.js';

// ---------------------------------------------------------------------------------------------------------------------------------
// (1) the golden table — §2.1 (dark), §2.2 (light), §2.3 (daltonized); `ansi` is derived (§2.4)
// ---------------------------------------------------------------------------------------------------------------------------------

type Golden = { readonly ansi16: AnsiColor; readonly ansi256: number; readonly truecolor: `#${string}`; readonly bold?: true } | { readonly dim: true };
type GoldenTable = Readonly<Record<ColorRole, Golden>>;

const PINK = { ansi16: 'magentaBright', ansi256: 211, truecolor: '#f386a1' } as const;
const PINK2 = { ansi16: 'magenta', ansi256: 169, truecolor: '#d45bb6' } as const;
const RED = { ansi16: 'red', ansi256: 203, truecolor: '#F87171' } as const;
const AMBER = { ansi16: 'yellow', ansi256: 214, truecolor: '#FBBF24' } as const;
const GREEN = { ansi16: 'green', ansi256: 78, truecolor: '#4ADE80' } as const;
const DIM = { dim: true } as const;

const DARK_GOLDEN: GoldenTable = {
  error: RED,
  warn: AMBER,
  ok: GREEN,
  block: { ...RED, bold: true },
  review: AMBER,
  steer: AMBER,
  dim: DIM,
  accent: PINK,
  secret: AMBER,
  chosen: PINK,
  rule: DIM,
  placeholder: DIM,
  you: { ...PINK2, bold: true },
  assistant: { ...PINK, bold: true },
  badge: { ...PINK, bold: true },
  border: DIM,
  borderFocus: PINK2,
  code: { ansi16: 'whiteBright', ansi256: 254, truecolor: '#e5e5e5' },
  sweep: { ansi16: 'whiteBright', ansi256: 224, truecolor: '#fbd0dc' },
  accent2: PINK2,
  // TUI-DESIGN-4 §6.2: the four diff roles reuse the already-checked meaning colours (no new cube cell)
  added: GREEN,
  removed: RED,
  hunk: PINK,
  diffMeta: DIM,
};

const LPINK = { ansi16: 'magenta', ansi256: 125, truecolor: '#be185d' } as const;
const LPINK2 = { ansi16: 'magenta', ansi256: 89, truecolor: '#831843' } as const;
const LRED = { ansi16: 'red', ansi256: 124, truecolor: '#b91c1c' } as const;
const LBLUE = { ansi16: 'blue', ansi256: 25, truecolor: '#0369A1' } as const;

const LIGHT_GOLDEN: GoldenTable = {
  error: LRED,
  warn: LBLUE,
  ok: { ansi16: 'green', ansi256: 29, truecolor: '#15803d' },
  block: { ...LRED, bold: true },
  review: LBLUE,
  steer: LBLUE,
  dim: DIM,
  accent: LPINK,
  secret: LBLUE,
  chosen: LPINK,
  rule: DIM,
  placeholder: DIM,
  you: { ...LPINK2, bold: true },
  assistant: { ...LPINK, bold: true },
  badge: { ...LPINK, bold: true },
  border: DIM,
  borderFocus: LPINK2,
  code: { ansi16: 'black', ansi256: 234, truecolor: '#1e1e1e' },
  sweep: LPINK2,
  accent2: LPINK2,
  added: { ansi16: 'green', ansi256: 29, truecolor: '#15803d' },
  removed: LRED,
  hunk: LPINK,
  diffMeta: DIM,
};

const DBLUE = { ansi16: 'blue', ansi256: 75, truecolor: '#60A5FA' } as const;
const DALTONIZED_GOLDEN: GoldenTable = {
  ...DARK_GOLDEN,
  error: DBLUE,
  block: { ...DBLUE, bold: true },
  ok: { ansi16: 'cyan', ansi256: 117, truecolor: '#7DD3FC' },
  // §6.2: `removed` moves onto the same blue; `added` keeps green
  removed: DBLUE,
};

const GOLDEN: Readonly<Record<Exclude<ThemeName, 'ansi'>, GoldenTable>> = { dark: DARK_GOLDEN, light: LIGHT_GOLDEN, daltonized: DALTONIZED_GOLDEN };

/** the `<Text>` props the golden entry means at a depth (the `ansi` twin: the ANSI name, `dimColor: false`, `gray` for dim roles) */
function expectedProps(g: Golden, depth: 16 | 256 | 24, ansiTwin: boolean): { color?: string; dimColor?: boolean; bold?: boolean } {
  if ('dim' in g) return ansiTwin ? { color: 'gray', dimColor: false } : { dimColor: true };
  const color = ansiTwin || depth === 16 ? g.ansi16 : depth === 256 ? `ansi256(${g.ansi256})` : g.truecolor;
  return { color, ...(ansiTwin ? { dimColor: false } : {}), ...(g.bold === true ? { bold: true } : {}) };
}

const DEPTHS = [16, 256, 24] as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// colour maths (12-line WCAG luminance; xterm cube; Machado simulation + CIEDE2000)
// ---------------------------------------------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** WCAG 2.x relative luminance */
function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => linear(c / 255)) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, unrounded */
function contrastRaw(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.x contrast ratio, rounded to two decimals like the §2.5 table */
function contrast(fg: string, bg: string): number {
  return Number(contrastRaw(fg, bg).toFixed(2));
}

const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/** the rgb of an xterm-256 cell (16–231 the 6×6×6 cube, 232–255 the grey ramp) */
function cellRgb(index: number): Rgb {
  if (index >= 232) {
    const v = 8 + 10 * (index - 232);
    return [v, v, v];
  }
  const i = index - 16;
  return [CUBE_LEVELS[Math.floor(i / 36)]!, CUBE_LEVELS[Math.floor(i / 6) % 6]!, CUBE_LEVELS[i % 6]!];
}

const distance = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const hexOf = (rgb: Rgb): string => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** the `#rrggbb` a 256-colour terminal renders for a cell (xterm's default table) */
const cellHex = (index: number): string => hexOf(cellRgb(index));

/** R1 §6.1: `16 + 36·r + 6·g + b` with every channel snapped to the nearest cube level */
function cubeCell(hex: string): number {
  const snap = (v: number): number => CUBE_LEVELS.reduce((best, lvl, i) => (Math.abs(lvl - v) < Math.abs(CUBE_LEVELS[best]! - v) ? i : best), 0);
  const [r, g, b] = rgbOf(hex).map(snap) as unknown as Rgb;
  return 16 + 36 * r + 6 * g + b;
}

/** the nearest of the 240 colour cells by RGB distance (the cube cell or the grey ramp) */
function nearestCell(hex: string): number {
  const rgb = rgbOf(hex);
  let best = 16;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 16; i <= 255; i++) {
    const d = distance(rgb, cellRgb(i));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

type Cvd = 'normal' | 'protan' | 'deutan';
/** Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear sRGB (R1 §5) */
const CVD: Readonly<Record<Cvd, readonly (readonly [number, number, number])[]>> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function simulateLab(hex: string, kind: Cvd): readonly [number, number, number] {
  const lin = rgbOf(hex).map((c) => linear(c / 255)) as unknown as Rgb;
  const m = CVD[kind];
  const [r, g, b] = m.map((row) => Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))) as unknown as Rgb;
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number): number => (t > Math.pow(6 / 29, 3) ? Math.cbrt(t) : t / (3 * Math.pow(6 / 29, 2)) + 4 / 29);
  const fx = f(X / 0.95047);
  const fy = f(Y / 1);
  const fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005) */
function deltaE2000(l1: readonly [number, number, number], l2: readonly [number, number, number]): number {
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number): number => {
    if (a === 0 && b === 0) return 0;
    const t = Math.atan2(b, a) * deg;
    return t < 0 ? t + 360 : t;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp: number;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
  else hbp = (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const RC = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt(Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2) + RT * (dCp / SC) * (dHp / SH));
}

/** ΔE2000 between two colours as a viewer of the given kind sees them */
const deltaE = (a: string, b: string, kind: Cvd): number => deltaE2000(simulateLab(a, kind), simulateLab(b, kind));

/** the 240 colour cells ranked by ΔE2000 (normal vision) from a truecolor — the §2.1 rationale's "nearest by ΔE2000" */
function cellsByDeltaE(hex: string): readonly (readonly [number, number])[] {
  const lab = simulateLab(hex, 'normal');
  const scored: (readonly [number, number])[] = [];
  for (let i = 16; i <= 255; i++) scored.push([i, deltaE2000(lab, simulateLab(cellHex(i), 'normal'))]);
  return scored.sort((a, b) => a[1] - b[1]);
}

const truecolorOf = (s: ColorSpec): string | null => s.color?.truecolor ?? null;

// ---------------------------------------------------------------------------------------------------------------------------------

describe('(1) textProps × theme × role × depth equals the golden table (§2.1–2.4)', () => {
  for (const name of ['dark', 'light', 'daltonized'] as const) {
    it(`${name}: every role at depths 16 / 256 / 24`, () => {
      const theme = THEMES[name];
      const golden = GOLDEN[name];
      for (const role of COLOR_ROLES) for (const depth of DEPTHS) expect(textProps(theme, role, depth), `${name}.${role}@${depth}`).toEqual(expectedProps(golden[role], depth, false));
      // and the table itself: the triple, bold and dim members (nothing the golden table does not name)
      for (const role of COLOR_ROLES) {
        const s = theme.roles[role];
        const g = golden[role];
        if ('dim' in g) {
          expect(s.color, `${name}.${role}`).toBeUndefined();
          expect(s.dimColor).toBe(true);
        } else {
          expect(s.color, `${name}.${role}`).toEqual({ ansi16: g.ansi16, ansi256: g.ansi256, truecolor: g.truecolor });
          expect(s.bold, `${name}.${role} bold`).toBe(g.bold);
          expect(s.dimColor).toBeUndefined();
        }
      }
    });
  }
  it('ansi: the dark golden table at every depth with the ANSI name only, dimColor false, gray for the dim roles (§2.4)', () => {
    for (const role of COLOR_ROLES) for (const depth of DEPTHS) expect(textProps(THEMES.ansi, role, depth), `ansi.${role}@${depth}`).toEqual(expectedProps(DARK_GOLDEN[role], depth, true));
  });
  it('colour off → {} for every theme and role; `true` is depth 16', () => {
    for (const name of THEME_NAMES) {
      for (const role of COLOR_ROLES) {
        expect(textProps(THEMES[name], role, 0)).toEqual({});
        expect(textProps(THEMES[name], role, false)).toEqual({});
        expect(textProps(THEMES[name], role, true)).toEqual(textProps(THEMES[name], role, 16));
      }
    }
  });
});

describe('(2) WCAG contrast at the §2 thresholds (body ≥ 4.5:1, marker / edge ≥ 3:1)', () => {
  const DARK_BGS = ['#1e1e1e', '#000000', '#002b36'] as const;
  const LIGHT_BGS = ['#fefefe', '#ffffff', '#fdf6e3'] as const;
  const BODY_ROLES: readonly ColorRole[] = ['error', 'warn', 'ok', 'block', 'review', 'steer', 'secret', 'accent', 'chosen', 'assistant', 'badge', 'code'];
  const MARKER_ROLES: readonly ColorRole[] = ['you', 'borderFocus', 'accent2', 'sweep'];

  it('dark: every body role ≥ 4.5 and every marker role ≥ 3.0 on #1e1e1e, #000000 and Solarized #002b36', () => {
    for (const bg of DARK_BGS) {
      for (const role of BODY_ROLES) expect(contrast(truecolorOf(THEMES.dark.roles[role])!, bg), `dark.${role} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const role of MARKER_ROLES) expect(contrast(truecolorOf(THEMES.dark.roles[role])!, bg), `dark.${role} on ${bg}`).toBeGreaterThanOrEqual(3.0);
    }
  });
  it('the secondary pink is body grade on TypeSafe and black; the one documented exception is Solarized dark (4.27, marker grade — `you` is a 5-cell bold label after D-O)', () => {
    for (const role of ['you', 'borderFocus', 'accent2'] as const) {
      expect(contrast(truecolorOf(THEMES.dark.roles[role])!, '#1e1e1e')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(truecolorOf(THEMES.dark.roles[role])!, '#000000')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(truecolorOf(THEMES.dark.roles[role])!, '#002b36')).toBe(4.27);
    }
    // no other coloured dark role is below body grade on any of the three backgrounds
    for (const role of COLOR_ROLES) {
      const tc = truecolorOf(THEMES.dark.roles[role]);
      if (tc === null || ['you', 'borderFocus', 'accent2'].includes(role)) continue;
      for (const bg of DARK_BGS) expect(contrast(tc, bg), `dark.${role} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('the §2.5 table, two decimals, every coloured dark role and the two 256 cells', () => {
    const rows: readonly (readonly [string, number, number, number])[] = [
      ['#f386a1', 6.93, 8.74, 6.24],
      ['#d45bb6', 4.74, 5.97, 4.27],
      ['#fbd0dc', 12.03, 15.16, 10.84],
      ['#e5e5e5', 13.23, 16.67, 11.92],
      ['#F87171', 6.03, 7.59, 5.43],
      ['#FBBF24', 9.99, 12.58, 8.99],
      ['#4ADE80', 9.57, 12.05, 8.62],
      ['#60A5FA', 6.56, 8.26, 5.9],
      ['#ff87af', 7.41, 9.34, 6.67],
      ['#d75faf', 4.88, 6.15, 4.39],
    ];
    for (const [fg, ...ratios] of rows) expect(DARK_BGS.map((bg) => contrast(fg, bg)), fg).toEqual(ratios);
    // the two cube cells stand in for the truecolors the way the table says
    expect(cellRgb(211)).toEqual(rgbOf('#ff87af'));
    expect(cellRgb(169)).toEqual(rgbOf('#d75faf'));
  });
  it('light: every body role ≥ 4.5 and every marker role ≥ 3.0 on #fefefe, #ffffff and Solarized light #fdf6e3 (fails the inherited #F87171 2.74 / #4ADE80 1.73)', () => {
    for (const bg of LIGHT_BGS) {
      for (const role of BODY_ROLES) expect(contrast(truecolorOf(THEMES.light.roles[role])!, bg), `light.${role} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const role of MARKER_ROLES) expect(contrast(truecolorOf(THEMES.light.roles[role])!, bg), `light.${role} on ${bg}`).toBeGreaterThanOrEqual(3.0);
    }
    // the defect this test exists for (R1 §2.5 defect 1), and the reason the site's pinks cannot be light-theme text
    expect(contrast('#F87171', '#fefefe')).toBe(2.74);
    expect(contrast('#4ADE80', '#fefefe')).toBe(1.73);
    expect(contrast('#f386a1', '#fefefe')).toBe(2.38);
    expect(contrast('#d45bb6', '#fefefe')).toBe(3.49);
    // the §2.5 light numbers
    expect(LIGHT_BGS.map((bg) => contrast('#be185d', bg))).toEqual([5.99, 6.04, 5.6]);
    expect(LIGHT_BGS.map((bg) => contrast('#831843', bg))).toEqual([9.57, 9.65, 8.94]);
    expect(LIGHT_BGS.map((bg) => contrast('#b91c1c', bg))).toEqual([6.42, 6.47, 6.0]);
    expect(LIGHT_BGS.map((bg) => contrast('#15803d', bg))).toEqual([4.97, 5.02, 4.65]);
    expect(LIGHT_BGS.map((bg) => contrast('#0369A1', bg))).toEqual([5.88, 5.93, 5.5]);
    // D-R: cell 211 on Terminal.app's white Basic profile is what COLORFGBG saves the user from
    expect(contrast('#ff87af', '#ffffff')).toBe(2.25);
  });
  it('daltonized: every override ≥ 4.5 on the three dark backgrounds; the inherited roles are dark’s', () => {
    for (const role of ['error', 'block', 'ok'] as const) for (const bg of DARK_BGS) expect(contrast(truecolorOf(THEMES.daltonized.roles[role])!, bg), `daltonized.${role} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(DARK_BGS.map((bg) => contrast('#60A5FA', bg))).toEqual([6.56, 8.26, 5.9]);
  });

  // ----- what 256-colour terminals render: the same thresholds over every `ansi256` cell (depth 256 is the common case — every
  // `TERM=xterm-256color` without `COLORTERM`, and Apple_Terminal is forced to 256 by color-shim.ts — the very D-R light-terminal case)
  const BGS_OF: Readonly<Record<Exclude<ThemeName, 'ansi'>, readonly string[]>> = { dark: DARK_BGS, light: LIGHT_BGS, daltonized: DARK_BGS };
  /** the documented cell exceptions: theme.role on a background, the rounded ratio, and the marker that carries the meaning */
  const CELL_EXCEPTIONS: readonly { readonly theme: Exclude<ThemeName, 'ansi'>; readonly role: ColorRole; readonly bg: string; readonly ratio: number; readonly carriedBy: string }[] = [
    // light `ok` renders as cell 29 `#00875f`: body grade on white (4.50 — 4.4964 unrounded, at the edge), 4.53 on #ffffff, below body on Solarized light
    { theme: 'light', role: 'ok', bg: '#fdf6e3', ratio: 4.2, carriedBy: '✓' },
    // TUI-DESIGN-4 §6.2: light `added` is the same darkened green (cell 29), so it carries the same one exception — with `+` as its marker
    { theme: 'light', role: 'added', bg: '#fdf6e3', ratio: 4.2, carriedBy: '+' },
  ];
  it('every ansi256 cell meets the body / marker threshold on its theme’s three backgrounds, except the two named: light ok / added cell 29 on Solarized light (4.20)', () => {
    const seen: string[] = [];
    for (const name of ['dark', 'light', 'daltonized'] as const) {
      for (const role of COLOR_ROLES) {
        const cell = THEMES[name].roles[role].color?.ansi256;
        if (cell === undefined) continue;
        const threshold = MARKER_ROLES.includes(role) ? 3.0 : 4.5;
        for (const bg of BGS_OF[name]) {
          const ratio = contrast(cellHex(cell), bg);
          const exception = CELL_EXCEPTIONS.find((e) => e.theme === name && e.role === role && e.bg === bg);
          if (exception !== undefined) {
            expect(ratio, `${name}.${role} cell ${cell} on ${bg}`).toBe(exception.ratio);
            expect(ratio).toBeLessThan(threshold);
            expect(THEMES[name].roles[role].marker).toBe(exception.carriedBy);
            seen.push(`${name}.${role}@${bg}`);
          } else {
            expect(ratio, `${name}.${role} cell ${cell} (${cellHex(cell)}) on ${bg}`).toBeGreaterThanOrEqual(threshold);
          }
        }
      }
    }
    // every listed exception is real (the list shrinks when the palette improves; it never carries a stale row)
    expect(seen).toHaveLength(CELL_EXCEPTIONS.length);
    // the edge: cell 29 on #fefefe rounds to 4.50 and is 4.4964 unrounded — the owner's call whether a darker light green (cell 22 `#005f00`) replaces it
    expect(contrastRaw(cellHex(29), '#fefefe')).toBeCloseTo(4.4964, 3);
    expect(contrast(cellHex(29), '#fefefe')).toBe(4.5);
  });
  it('the secondary pink’s cell 169 (#d75faf) is body grade on TypeSafe and black and 4.39 on Solarized dark — the cell twin of the 4.27 exception (marker grade, ≥ 3.0)', () => {
    expect(cellHex(169)).toBe('#d75faf');
    expect(DARK_BGS.map((bg) => contrast(cellHex(169), bg))).toEqual([4.88, 6.15, 4.39]);
    for (const role of ['you', 'borderFocus', 'accent2'] as const) {
      expect(THEMES.dark.roles[role].color?.ansi256).toBe(169);
      expect(THEMES.daltonized.roles[role].color?.ansi256).toBe(169);
    }
    expect(contrast(cellHex(169), '#002b36')).toBeGreaterThanOrEqual(3.0);
    expect(contrast(cellHex(169), '#002b36')).toBeLessThan(4.5);
  });
  it('the cell table, two decimals (the §2.5 rows 211 / 169 and every other cell the three themes carry)', () => {
    const rows: readonly (readonly [Exclude<ThemeName, 'ansi'>, number, string, readonly number[]])[] = [
      ['dark', 203, '#ff5f5f', [5.6, 7.05, 5.04]],
      ['dark', 214, '#ffaf00', [9.04, 11.38, 8.14]],
      ['dark', 78, '#5fd787', [9.17, 11.56, 8.26]],
      ['dark', 211, '#ff87af', [7.41, 9.34, 6.67]],
      ['dark', 169, '#d75faf', [4.88, 6.15, 4.39]],
      ['dark', 254, '#e4e4e4', [13.11, 16.52, 11.81]],
      ['dark', 224, '#ffd7d7', [12.66, 15.95, 11.4]],
      ['light', 124, '#af0000', [7.38, 7.44, 6.9]],
      ['light', 25, '#005faf', [6.4, 6.45, 5.98]],
      ['light', 29, '#00875f', [4.5, 4.53, 4.2]],
      ['light', 125, '#af005f', [6.97, 7.03, 6.52]],
      ['light', 89, '#87005f', [9.48, 9.57, 8.87]],
      ['light', 234, '#1c1c1c', [16.9, 17.04, 15.8]],
      ['daltonized', 75, '#5fafff', [7.19, 9.06, 6.48]],
      ['daltonized', 117, '#87d7ff', [10.47, 13.19, 9.43]],
    ];
    for (const [theme, cell, hex, ratios] of rows) {
      expect(cellHex(cell), `cell ${cell}`).toBe(hex);
      expect(BGS_OF[theme].map((bg) => contrast(hex, bg)), `${theme} cell ${cell}`).toEqual(ratios);
    }
    // the table covers every cell the three themes carry
    const carried = new Set<string>();
    for (const name of ['dark', 'light', 'daltonized'] as const) for (const role of COLOR_ROLES) {
      const cell = THEMES[name].roles[role].color?.ansi256;
      if (cell === undefined) continue;
      // daltonized inherits dark's cells except its two overrides (75 blue, 117 cyan)
      const owner = name === 'daltonized' ? (cell === 75 || cell === 117 ? 'daltonized' : 'dark') : name;
      carried.add(`${owner}:${cell}`);
    }
    expect([...carried].sort()).toEqual(rows.map(([theme, cell]) => `${theme}:${cell}`).sort());
  });
});

describe('(3) twins: the xterm-256 cube arithmetic, no shared cells, the ANSI-16 families, the ansi theme (§2.1, §2.4, R1 §6)', () => {
  it('every ansi256 is the nearest cell of its truecolor and within RGB distance ≤ 48 (fails the old ok 114; 78 passes)', () => {
    for (const name of ['dark', 'light', 'daltonized'] as const) {
      for (const role of COLOR_ROLES) {
        const s = THEMES[name].roles[role];
        if (s.color?.truecolor === undefined) continue;
        expect(s.color.ansi256, `${name}.${role}`).toBe(nearestCell(s.color.truecolor));
        expect(distance(rgbOf(s.color.truecolor), cellRgb(s.color.ansi256!)), `${name}.${role} distance`).toBeLessThanOrEqual(48);
      }
    }
    expect(nearestCell('#4ADE80')).toBe(78);
    expect(distance(rgbOf('#4ADE80'), cellRgb(114))).toBeGreaterThan(48);
  });
  it('R1 §6.1 cube rows: `16 + 36·r + 6·g + b` with snapped channels; the greys on the ramp', () => {
    const rows: readonly (readonly [string, number])[] = [
      ['#f386a1', 211],
      ['#d45bb6', 169],
      ['#fbd0dc', 224],
      ['#4ADE80', 78],
      ['#be185d', 125],
      ['#831843', 89],
      ['#b91c1c', 124],
      ['#15803d', 29],
      ['#F87171', 203],
      ['#FBBF24', 214],
      ['#60A5FA', 75],
      ['#7DD3FC', 117],
      ['#0369A1', 25],
    ];
    for (const [hex, cell] of rows) expect(cubeCell(hex), hex).toBe(cell);
    expect(nearestCell('#e5e5e5')).toBe(254);
    expect(nearestCell('#1e1e1e')).toBe(234);
    expect(cellRgb(254)).toEqual([228, 228, 228]);
    expect(cellRgb(234)).toEqual([28, 28, 28]);
    // the §2.2 collision `#831843` avoids: `#9d174d` shares cell 125 with `#be185d`
    expect(cubeCell('#9d174d')).toBe(125);
    expect(cubeCell('#9d174d')).toBe(cubeCell('#be185d'));
    expect(cubeCell('#831843')).not.toBe(cubeCell('#be185d'));
  });
  it('two roles with different truecolors never share an ansi256 inside a theme', () => {
    for (const name of ['dark', 'light', 'daltonized'] as const) {
      const byCell = new Map<number, Set<string>>();
      for (const role of COLOR_ROLES) {
        const s = THEMES[name].roles[role];
        if (s.color?.ansi256 === undefined || s.color.truecolor === undefined) continue;
        const set = byCell.get(s.color.ansi256) ?? new Set<string>();
        set.add(s.color.truecolor.toLowerCase());
        byCell.set(s.color.ansi256, set);
      }
      for (const [cell, tcs] of byCell) expect([...tcs], `${name} cell ${cell}`).toHaveLength(1);
    }
  });
  it('the ANSI-16 families: primary pink magentaBright / secondary magenta (dark, daltonized), every light pink plain magenta; red, yellow / blue, green / cyan', () => {
    const PRIMARY = ['accent', 'chosen', 'assistant', 'badge'] as const;
    const SECONDARY = ['you', 'borderFocus', 'accent2'] as const;
    for (const name of ['dark', 'daltonized'] as const) {
      for (const role of PRIMARY) expect(THEMES[name].roles[role].color?.ansi16, `${name}.${role}`).toBe('magentaBright');
      for (const role of SECONDARY) expect(THEMES[name].roles[role].color?.ansi16, `${name}.${role}`).toBe('magenta');
      for (const role of ['warn', 'review', 'steer', 'secret'] as const) expect(THEMES[name].roles[role].color?.ansi16).toBe('yellow');
    }
    for (const role of [...PRIMARY, ...SECONDARY, 'sweep'] as const) expect(THEMES.light.roles[role].color?.ansi16, `light.${role}`).toBe('magenta');
    for (const role of ['warn', 'review', 'steer', 'secret'] as const) expect(THEMES.light.roles[role].color?.ansi16).toBe('blue');
    for (const name of ['dark', 'light'] as const) {
      expect(THEMES[name].roles.error.color?.ansi16).toBe('red');
      expect(THEMES[name].roles.block.color?.ansi16).toBe('red');
      expect(THEMES[name].roles.ok.color?.ansi16).toBe('green');
    }
    expect(THEMES.daltonized.roles.error.color?.ansi16).toBe('blue');
    expect(THEMES.daltonized.roles.block.color?.ansi16).toBe('blue');
    expect(THEMES.daltonized.roles.ok.color?.ansi16).toBe('cyan');
    // every pink role in every coloured theme is one of the two magentas
    for (const name of ['dark', 'light', 'daltonized', 'ansi'] as const) for (const role of [...PRIMARY, ...SECONDARY]) expect(['magenta', 'magentaBright'], `${name}.${role}`).toContain(THEMES[name].roles[role].color?.ansi16);
  });
  it('THEMES.ansi equals dark with the deep members stripped: no 256 / truecolor member, never dims, gray for the dim roles, bold kept', () => {
    for (const role of COLOR_ROLES) {
      const d = THEMES.dark.roles[role];
      const a = THEMES.ansi.roles[role];
      expect(a.marker, role).toBe(d.marker);
      expect(a.bold, role).toBe(d.bold);
      expect(a.dimColor, role).toBe(false);
      expect(a.color?.ansi256, role).toBeUndefined();
      expect(a.color?.truecolor, role).toBeUndefined();
      expect(a.color?.ansi16, role).toBe(d.color !== undefined ? d.color.ansi16 : d.dimColor === true ? 'gray' : undefined);
    }
    expect(validateTheme(THEMES.ansi)).toEqual([]);
  });
  it('§2.1 rationale: 211 / 169 / 224 / 78 are also the nearest cells by ΔE2000 (3.4 / 2.2 / 4.8 / 2.7); `#be185d` ties 125 / 161 and `#0369A1` prefers 24 by ΔE — the table follows the Euclidean rule', () => {
    const NEW_CELLS: readonly (readonly [string, number, number])[] = [
      ['#f386a1', 211, 3.4],
      ['#d45bb6', 169, 2.2],
      ['#fbd0dc', 224, 4.8],
      ['#4ADE80', 78, 2.7],
    ];
    for (const [hex, cell, de] of NEW_CELLS) {
      const ranked = cellsByDeltaE(hex);
      expect(ranked[0]![0], `${hex} ΔE-nearest`).toBe(cell);
      expect(Math.abs(ranked[0]![1] - de), `${hex} ΔE to ${cell}`).toBeLessThan(1);
      expect(nearestCell(hex), `${hex} Euclid`).toBe(cell);
    }
    // every other truecolor agrees too, except the two documented disagreements — the table's rule is `nearestCell` (RGB Euclid, R1 §6.1)
    const EUCLID_ONLY: Readonly<Record<string, { readonly byDeltaE: number; readonly chosen: number }>> = {
      '#be185d': { byDeltaE: 161, chosen: 125 }, // 4.89 vs 4.92 — a tie at one decimal; 125 keeps the plain-magenta family's cube row
      '#0369a1': { byDeltaE: 24, chosen: 25 }, // 5.13 vs 5.37
    };
    for (const name of ['dark', 'light', 'daltonized'] as const) {
      for (const role of COLOR_ROLES) {
        const c = THEMES[name].roles[role].color;
        if (c?.truecolor === undefined || c.ansi256 === undefined) continue;
        const ranked = cellsByDeltaE(c.truecolor);
        const disagreement = EUCLID_ONLY[c.truecolor.toLowerCase()];
        if (disagreement !== undefined) {
          expect(ranked[0]![0], `${name}.${role} ΔE-nearest`).toBe(disagreement.byDeltaE);
          expect(c.ansi256).toBe(disagreement.chosen);
          expect(ranked[1]![0], `${name}.${role} ΔE runner-up`).toBe(disagreement.chosen);
          expect(ranked[1]![1] - ranked[0]![1], `${name}.${role} ΔE gap`).toBeLessThan(0.3);
        } else {
          expect(ranked[0]![0], `${name}.${role} ΔE-nearest`).toBe(c.ansi256);
        }
      }
    }
    const tie = cellsByDeltaE('#be185d');
    expect(Number(tie[0]![1].toFixed(1))).toBe(Number(tie[1]![1].toFixed(1)));
  });
  it('§2.2, deliberate: at depth 16 the light theme’s two pinks collapse to one `magenta` (bright magenta on white is ≈ 1.6:1); dark keeps the lightness order magentaBright / magenta (L* 68.5 vs 56.9)', () => {
    // the collapse — labels, the `live` word and `[chosen]` carry the distinction on that twin (documented in docs/TUI.md's setup notes)
    expect(textProps(THEMES.light, 'accent', 16)).toEqual({ color: 'magenta' });
    expect(textProps(THEMES.light, 'you', 16)).toEqual({ color: 'magenta', bold: true });
    expect(textProps(THEMES.light, 'borderFocus', 16)).toEqual({ color: 'magenta' });
    expect(textProps(THEMES.light, 'assistant', 16)).toEqual({ color: 'magenta', bold: true });
    for (const role of ['accent', 'chosen', 'assistant', 'badge', 'you', 'borderFocus', 'accent2', 'sweep'] as const) expect(THEMES.light.roles[role].color?.ansi16, `light.${role}`).toBe('magenta');
    // and the reason it is accepted: the bright twin cannot be light-theme text, while the two darkened pinks still differ at 256 (125 / 89) and truecolor
    expect(textProps(THEMES.light, 'accent', 256)).not.toEqual(textProps(THEMES.light, 'accent2', 256));
    expect(textProps(THEMES.light, 'accent', 24)).not.toEqual(textProps(THEMES.light, 'accent2', 24));
    // dark: the order survives at every depth
    expect(textProps(THEMES.dark, 'accent', 16)).toEqual({ color: 'magentaBright' });
    expect(textProps(THEMES.dark, 'accent2', 16)).toEqual({ color: 'magenta' });
    expect(textProps(THEMES.ansi, 'accent', 16).color).not.toBe(textProps(THEMES.ansi, 'you', 16).color);
    expect(Math.abs(simulateLab('#f386a1', 'normal')[0] - 68.5)).toBeLessThan(0.5);
    expect(Math.abs(simulateLab('#d45bb6', 'normal')[0] - 56.9)).toBeLessThan(0.5);
  });
});

describe('(4) colour-blindness: the ΔE2000 rules §2.1 and §2.3 state (Machado 2009, severity 1.0; within 1 of R1 §5.1)', () => {
  const accent = '#f386a1';
  const you = '#d45bb6';
  const error = '#F87171';
  const blue = '#60A5FA';
  it('pink vs salmon red is ΔE ≈ 12 for a deuteranope — confusable at a glance, so every pink role carries its marker (§2.1)', () => {
    const d = deltaE(accent, error, 'deutan');
    expect(Math.abs(d - 12.0)).toBeLessThan(1);
    expect(d).toBeLessThan(20);
    expect(Math.abs(deltaE(accent, error, 'protan') - 17.0)).toBeLessThan(1);
    expect(Math.abs(deltaE(accent, error, 'normal') - 11.4)).toBeLessThan(1);
  });
  it('daltonized: pink vs the blue block is the 34 / 20 pair (deutan 34.1, protan 20.4) — why `[chosen]` inherits pink there (§2.3)', () => {
    const deutan = deltaE(accent, blue, 'deutan');
    const protan = deltaE(accent, blue, 'protan');
    expect(Math.abs(deutan - 34.1)).toBeLessThan(1);
    expect(Math.abs(protan - 20.4)).toBeLessThan(1);
    expect(deutan).toBeGreaterThanOrEqual(20);
    expect(protan).toBeGreaterThanOrEqual(15);
    expect(deltaE(accent, blue, 'normal')).toBeGreaterThanOrEqual(20);
    // the theme carries exactly those two colours
    expect(THEMES.daltonized.roles.chosen.color?.truecolor).toBe(accent);
    expect(THEMES.daltonized.roles.block.color?.truecolor).toBe(blue);
  });
  it('the two voices stay apart: primary vs secondary ΔE 16.8 normal / 24.7 deutan / 19.3 protan; `you` vs red > 20 for both', () => {
    expect(Math.abs(deltaE(accent, you, 'normal') - 16.8)).toBeLessThan(1);
    expect(Math.abs(deltaE(accent, you, 'deutan') - 24.7)).toBeLessThan(1);
    expect(Math.abs(deltaE(accent, you, 'protan') - 19.3)).toBeLessThan(1);
    expect(deltaE(you, error, 'deutan')).toBeGreaterThan(20);
    expect(deltaE(you, error, 'protan')).toBeGreaterThan(20);
    // and why `you` is not the site's teal: ΔE 6.0 against the primary for a protanope
    expect(Math.abs(deltaE(accent, '#09aea1', 'protan') - 6.0)).toBeLessThan(1);
  });
  it('light caveat (documented, not fixed): light accent vs light ok is ΔE 6.8 for a deuteranope — both mean "good", the ✓ carries it', () => {
    const d = deltaE(THEMES.light.roles.accent.color!.truecolor!, THEMES.light.roles.ok.color!.truecolor!, 'deutan');
    expect(Math.abs(d - 6.8)).toBeLessThan(1);
    expect(THEMES.light.roles.ok.marker).toBe('✓');
  });

  // ----- the full meaning-pair matrix: one representative per family (error = error / block; warn = warn / review / steer / secret;
  // ok; accent = accent / chosen / assistant / badge; you = you / borderFocus / accent2), truecolor and the 256 cell, three viewers
  type Meaning = 'error' | 'warn' | 'ok' | 'accent' | 'you';
  const MEANING: readonly Meaning[] = ['error', 'warn', 'ok', 'accent', 'you'];
  const KINDS: readonly Cvd[] = ['normal', 'deutan', 'protan'];
  type Triple = readonly [number, number, number];
  type PairRow = { readonly tc: Triple; readonly cell: Triple };
  type PairKey = 'error/warn' | 'error/ok' | 'error/accent' | 'error/you' | 'warn/ok' | 'warn/accent' | 'warn/you' | 'ok/accent' | 'ok/you' | 'accent/you';
  type Matrix = Readonly<Record<PairKey, PairRow>>;
  /** ΔE2000 n / d / p at truecolor and at the cells, one decimal (independent run of 2026-09-21; asserted within 1.0, R1 §5.1's tolerance) */
  const MATRIX: Readonly<Record<Exclude<ThemeName, 'ansi'>, Matrix>> = {
    dark: {
      'error/warn': { tc: [41.1, 17.0, 26.0], cell: [37.9, 14.7, 24.0] },
      'error/ok': { tc: [71.5, 6.9, 22.7], cell: [71.4, 9.0, 22.7] },
      'error/accent': { tc: [11.4, 11.9, 16.6], cell: [17.3, 18.1, 25.6] },
      'error/you': { tc: [24.2, 35.8, 33.9], cell: [24.1, 34.9, 34.6] },
      'warn/ok': { tc: [37.9, 13.9, 9.9], cell: [41.7, 16.1, 12.1] },
      'warn/accent': { tc: [47.1, 24.3, 34.8], cell: [47.5, 26.0, 38.3] },
      'warn/you': { tc: [63.6, 49.0, 57.4], cell: [58.1, 45.1, 53.4] },
      'ok/accent': { tc: [71.5, 12.2, 30.1], cell: [71.5, 12.5, 32.0] },
      'ok/you': { tc: [84.4, 37.6, 52.1], cell: [78.8, 32.2, 47.4] },
      'accent/you': { tc: [16.8, 25.0, 19.5], cell: [13.9, 19.5, 15.4] },
    },
    light: {
      'error/warn': { tc: [47.6, 49.6, 42.4], cell: [46.6, 53.8, 49.1] },
      'error/ok': { tc: [65.0, 8.5, 16.0], cell: [63.2, 17.9, 23.6] },
      'error/accent': { tc: [18.6, 14.9, 27.8], cell: [25.3, 19.9, 35.1] },
      'error/you': { tc: [20.9, 20.7, 26.9], cell: [30.6, 34.3, 40.5] },
      'warn/ok': { tc: [43.3, 41.4, 43.1], cell: [40.5, 36.0, 40.1] },
      'warn/accent': { tc: [46.4, 34.1, 15.7], cell: [39.5, 30.3, 16.0] },
      'warn/you': { tc: [43.6, 30.3, 22.1], cell: [36.8, 17.3, 17.4] },
      'ok/accent': { tc: [73.6, 6.9, 32.9], cell: [72.6, 6.8, 34.3] },
      'ok/you': { tc: [67.9, 15.3, 35.6], cell: [72.0, 22.1, 41.0] },
      'accent/you': { tc: [11.7, 12.7, 7.8], cell: [9.4, 15.5, 6.6] },
    },
    daltonized: {
      'error/warn': { tc: [55.5, 61.0, 57.9], cell: [53.3, 60.1, 55.4] },
      'error/ok': { tc: [14.9, 12.6, 12.6], cell: [12.7, 11.7, 11.4] },
      'error/accent': { tc: [39.5, 34.3, 20.1], cell: [42.9, 30.0, 16.0] },
      'error/you': { tc: [39.2, 12.2, 15.6], cell: [43.1, 14.9, 17.4] },
      'warn/ok': { tc: [50.4, 51.5, 48.6], cell: [50.3, 51.3, 47.5] },
      'warn/accent': { tc: [47.1, 24.3, 34.8], cell: [47.5, 26.0, 38.3] },
      'warn/you': { tc: [63.6, 49.0, 57.4], cell: [58.1, 45.1, 53.4] },
      'ok/accent': { tc: [51.2, 28.3, 19.3], cell: [50.9, 24.2, 16.1] },
      'ok/you': { tc: [50.0, 15.6, 25.1], cell: [50.2, 17.0, 25.2] },
      'accent/you': { tc: [16.8, 25.0, 19.5], cell: [13.9, 19.5, 15.4] },
    },
  };
  /** a pair is weak for a viewer when ΔE < 15 (the lower of §2.3's two bars) at truecolor or at the cells; every weak pair is named here with the marker that carries it */
  const WEAK_BAR = 15;
  const WEAK: readonly { readonly theme: Exclude<ThemeName, 'ansi'>; readonly pair: PairKey; readonly kind: Cvd; readonly carriedBy: string }[] = [
    // dark — §2.1: pink vs salmon is 12.0 for a deuteranope (and 11.4 for everyone); every pink role carries its marker
    { theme: 'dark', pair: 'error/accent', kind: 'normal', carriedBy: '`error` / `[block]` vs `[chosen]` / `[jevcode]` / the mode word' },
    { theme: 'dark', pair: 'error/accent', kind: 'deutan', carriedBy: '`error` / `[block]` vs `[chosen]` / `[jevcode]` / the mode word' },
    // dark — the red / green / amber meaning hues for a deuteranope or protanope: what `/theme daltonized` exists for (`colour-blind? /theme daltonized`, §2.3)
    { theme: 'dark', pair: 'error/ok', kind: 'deutan', carriedBy: '`error` vs `✓` (daltonized moves error to blue: 48 / 51)' },
    { theme: 'dark', pair: 'error/warn', kind: 'deutan', carriedBy: '`error` vs `warning` / `[review]` (cell 14.7)' },
    { theme: 'dark', pair: 'warn/ok', kind: 'deutan', carriedBy: '`warning` / `[review]` vs `✓`' },
    { theme: 'dark', pair: 'warn/ok', kind: 'protan', carriedBy: '`warning` / `[review]` vs `✓`' },
    // dark — finding 1 of the round-3 fix pass: `[chosen]` vs `✓` for a deuteranope is 12.2
    { theme: 'dark', pair: 'ok/accent', kind: 'deutan', carriedBy: '`✓` vs `[chosen]`' },
    // dark — the two pinks at the cells are 13.9 apart for everyone; the L* order, bold and the `[you]` / `[jevcode]` words carry it
    { theme: 'dark', pair: 'accent/you', kind: 'normal', carriedBy: '`[you]` vs `[jevcode]`, bold, L* 68.5 vs 56.9 (cells 211 / 169: 13.9)' },
    // light — the darkened pinks are close for everyone (11.7 / 9.4) and 7.8 / 6.6 for a protanope
    { theme: 'light', pair: 'accent/you', kind: 'normal', carriedBy: '`[you]` vs `[jevcode]`, bold' },
    { theme: 'light', pair: 'accent/you', kind: 'deutan', carriedBy: '`[you]` vs `[jevcode]`, bold' },
    { theme: 'light', pair: 'accent/you', kind: 'protan', carriedBy: '`[you]` vs `[jevcode]`, bold (cells 125 / 89: 6.6)' },
    // light — §2.3's documented caveat (6.8) and the red / green pair
    { theme: 'light', pair: 'ok/accent', kind: 'deutan', carriedBy: '`✓` vs `[chosen]` (§2.3: both mean "good")' },
    { theme: 'light', pair: 'error/ok', kind: 'deutan', carriedBy: '`error` vs `✓`' },
    { theme: 'light', pair: 'error/accent', kind: 'deutan', carriedBy: '`error` / `[block]` vs `[chosen]` (14.9)' },
    // daltonized — finding 1: the theme built for colour-blind users has its weakest meaning pair between `✓` (cyan) and `error` (blue): 12.6 / 12.6 (cells 11.7 / 11.4)
    { theme: 'daltonized', pair: 'error/ok', kind: 'normal', carriedBy: '`error` / `[block]` vs `✓` (cells 75 / 117: 12.7)' },
    { theme: 'daltonized', pair: 'error/ok', kind: 'deutan', carriedBy: '`error` / `[block]` vs `✓` — keeping green instead would give 48 / 51 here but 13.9 / 9.9 against amber; the owner’s call' },
    { theme: 'daltonized', pair: 'error/ok', kind: 'protan', carriedBy: '`error` / `[block]` vs `✓`' },
    { theme: 'daltonized', pair: 'error/you', kind: 'deutan', carriedBy: '`error` / `[block]` vs `[you]` / `live` (blue vs magenta: 12.2)' },
    { theme: 'daltonized', pair: 'accent/you', kind: 'normal', carriedBy: '`[you]` vs `[jevcode]`, bold (as dark)' },
  ];
  /** the ten unordered pairs in MEANING order — the keys of `Matrix` */
  const PAIRS: readonly (readonly [Meaning, Meaning, PairKey])[] = [
    ['error', 'warn', 'error/warn'],
    ['error', 'ok', 'error/ok'],
    ['error', 'accent', 'error/accent'],
    ['error', 'you', 'error/you'],
    ['warn', 'ok', 'warn/ok'],
    ['warn', 'accent', 'warn/accent'],
    ['warn', 'you', 'warn/you'],
    ['ok', 'accent', 'ok/accent'],
    ['ok', 'you', 'ok/you'],
    ['accent', 'you', 'accent/you'],
  ];
  it('the ten pairs are exactly the unordered pairs of the five meaning families', () => {
    expect(PAIRS.map(([a, b, key]) => `${a}/${b}` === key)).toEqual(PAIRS.map(() => true));
    expect(PAIRS).toHaveLength((MEANING.length * (MEANING.length - 1)) / 2);
    expect(new Set(PAIRS.map(([, , key]) => key)).size).toBe(PAIRS.length);
  });

  it('the matrix: ΔE2000 of every meaning pair at truecolor and at the cells, three viewers, three themes — within 1.0 of the independent run', () => {
    for (const name of ['dark', 'light', 'daltonized'] as const) {
      for (const [a, b, key] of PAIRS) {
        const ca = THEMES[name].roles[a].color!;
        const cb = THEMES[name].roles[b].color!;
        const row = MATRIX[name][key];
        KINDS.forEach((kind, i) => {
          expect(Math.abs(deltaE(ca.truecolor!, cb.truecolor!, kind) - row.tc[i]!), `${name} ${key} ${kind} truecolor`).toBeLessThan(1);
          expect(Math.abs(deltaE(cellHex(ca.ansi256!), cellHex(cb.ansi256!), kind) - row.cell[i]!), `${name} ${key} ${kind} cell`).toBeLessThan(1);
        });
      }
    }
  });
  it('every pair below 15 for a viewer (truecolor or cell) is a named exception with the marker that carries it; nothing else is below 15; the named ones really are', () => {
    const found: string[] = [];
    for (const name of ['dark', 'light', 'daltonized'] as const) {
      for (const [a, b, key] of PAIRS) {
        const ca = THEMES[name].roles[a].color!;
        const cb = THEMES[name].roles[b].color!;
        for (const kind of KINDS) {
          const weakest = Math.min(deltaE(ca.truecolor!, cb.truecolor!, kind), deltaE(cellHex(ca.ansi256!), cellHex(cb.ansi256!), kind));
          const named = WEAK.find((w) => w.theme === name && w.pair === key && w.kind === kind);
          if (weakest < WEAK_BAR) {
            expect(named, `${name} ${key} ${kind} is ${weakest.toFixed(1)} — an unlisted weak pair`).toBeDefined();
            found.push(`${name} ${key} ${kind}`);
          } else {
            expect(named, `${name} ${key} ${kind} is ${weakest.toFixed(1)} — a stale exception`).toBeUndefined();
          }
        }
      }
    }
    expect(found).toHaveLength(WEAK.length);
    // the markers the exceptions lean on exist in every theme
    for (const name of THEME_NAMES) {
      expect(THEMES[name].roles.ok.marker).toBe('✓');
      expect(THEMES[name].roles.error.marker).toBe('error');
      expect(THEMES[name].roles.block.marker).toBe('[block]');
      expect(THEMES[name].roles.chosen.marker).toBe('[chosen]');
      expect(THEMES[name].roles.you.marker).toBe('[you]');
      expect(THEMES[name].roles.assistant.marker).toBe('[jevcode]');
      expect(THEMES[name].roles.borderFocus.marker).toBe('live');
    }
  });
  it('the two headline weak pairs of the fix pass, to one decimal: daltonized ✓ vs error 12.6 / 12.6 (cells 11.7 / 11.4); dark [chosen] vs ✓ deutan 12.2 — and the alternative the owner may prefer', () => {
    const dOk = THEMES.daltonized.roles.ok.color!;
    const dErr = THEMES.daltonized.roles.error.color!;
    expect(Math.abs(deltaE(dOk.truecolor!, dErr.truecolor!, 'deutan') - 12.6)).toBeLessThan(0.5);
    expect(Math.abs(deltaE(dOk.truecolor!, dErr.truecolor!, 'protan') - 12.6)).toBeLessThan(0.5);
    expect(Math.abs(deltaE(cellHex(dOk.ansi256!), cellHex(dErr.ansi256!), 'deutan') - 11.7)).toBeLessThan(0.5);
    expect(Math.abs(deltaE(cellHex(dOk.ansi256!), cellHex(dErr.ansi256!), 'protan') - 11.4)).toBeLessThan(0.5);
    expect(Math.abs(deltaE('#4ADE80', '#f386a1', 'deutan') - 12.2)).toBeLessThan(0.5);
    // keeping green in daltonized would give ok vs error 48.1 / 50.9 but ok vs warn 13.9 / 9.9 — either choice has one weak pair
    expect(Math.abs(deltaE('#4ADE80', '#60A5FA', 'deutan') - 48.1)).toBeLessThan(1);
    expect(Math.abs(deltaE('#4ADE80', '#60A5FA', 'protan') - 50.9)).toBeLessThan(1);
    expect(Math.abs(deltaE('#4ADE80', '#FBBF24', 'deutan') - 13.9)).toBeLessThan(1);
    expect(Math.abs(deltaE('#4ADE80', '#FBBF24', 'protan') - 9.9)).toBeLessThan(1);
    // the strong pairs the daltonized table is built on hold at the cells too: blue error vs pink ≥ 15 for both, amber vs everything ≥ 24
    expect(deltaE(cellHex(75), cellHex(211), 'deutan')).toBeGreaterThanOrEqual(20);
    expect(deltaE(cellHex(75), cellHex(211), 'protan')).toBeGreaterThanOrEqual(15);
    for (const other of [75, 117, 211, 169]) for (const kind of KINDS) expect(deltaE(cellHex(214), cellHex(other), kind), `214 vs ${other} ${kind}`).toBeGreaterThanOrEqual(24);
  });
});

describe('(5) markers wherever §2.1 requires one; identical in every theme', () => {
  const MARKERS: Readonly<Record<ColorRole, string>> = {
    error: 'error',
    warn: 'warning',
    ok: '✓',
    block: '[block]',
    review: '[review]',
    steer: '>',
    dim: '',
    accent: '',
    secret: '⚠ secret?',
    chosen: '[chosen]',
    rule: '─',
    placeholder: '…',
    you: '[you]',
    assistant: '[jevcode]',
    badge: '<mode>',
    border: '╭',
    borderFocus: 'live',
    code: '╶',
    sweep: '',
    accent2: '',
    added: '+',
    removed: '-',
    hunk: '@@',
    diffMeta: '···',
  };
  it('the §2.1 marker column, in all four themes; validateTheme passes each', () => {
    for (const name of THEME_NAMES) {
      for (const role of COLOR_ROLES) expect(THEMES[name].roles[role].marker, `${name}.${role}`).toBe(MARKERS[role]);
      expect(validateTheme(THEMES[name])).toEqual([]);
    }
  });
  it('every coloured role outside the decoration set (accent, dim, rule, placeholder, sweep, assistant, accent2) has a non-empty marker', () => {
    const decoration: ReadonlySet<ColorRole> = new Set<ColorRole>(['accent', 'dim', 'rule', 'placeholder', 'sweep', 'assistant', 'accent2']);
    for (const name of THEME_NAMES) for (const role of COLOR_ROLES) if (!decoration.has(role) && THEMES[name].roles[role].color !== undefined) expect(THEMES[name].roles[role].marker.length, `${name}.${role}`).toBeGreaterThan(0);
    // the pink roles that mean something keep their words; accent2 is decoration only
    for (const role of ['chosen', 'you', 'badge', 'borderFocus'] as const) expect(THEMES.dark.roles[role].marker.length).toBeGreaterThan(0);
    expect(THEMES.dark.roles.accent2.marker).toBe('');
  });
});

describe('(6) itemRole / labelRole (§5.1 rule 2, D-O)', () => {
  it('`[you]` and `[ui]` bodies are null; the label roles are assistant / you / dim', () => {
    expect(itemRole({ level: 'info', kind: 'chat', local: true, label: '[you]' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'chat', local: true, label: '[jevcode]' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'ui', local: true, label: '[ui]', text: 'mode jev-on' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'ui', local: true, label: '[setup]' })).toBeNull();
    expect(itemRole({ level: 'info', kind: 'workspace', text: 'git main · clean' })).toBe('dim');
    expect(labelRole({ label: '[jevcode]' })).toBe('assistant');
    expect(labelRole({ label: '[you]' })).toBe('you');
    expect(labelRole({ label: '[ui]' })).toBe('dim');
    expect(labelRole({ label: '[config]' })).toBe('dim');
  });
  it('labelRole over the whole UiLabel union: exactly two labels are pink; a new label member fails to compile until classified here', () => {
    const EXPECTED: Readonly<Record<UiLabel, 'assistant' | 'you' | 'dim'>> = { '[jevcode]': 'assistant', '[you]': 'you', '[ui]': 'dim', '[setup]': 'dim', '[config]': 'dim', '[sandbox]': 'dim', '[session]': 'dim' };
    for (const label of Object.keys(EXPECTED) as UiLabel[]) expect(labelRole({ label }), label).toBe(EXPECTED[label]);
    expect(Object.values(EXPECTED).filter((r) => r !== 'dim')).toEqual(['assistant', 'you']);
    // the two label roles are bold pinks in every coloured theme; `dim` has no colour
    for (const name of THEME_NAMES) {
      expect(THEMES[name].roles.assistant.bold).toBe(true);
      expect(THEMES[name].roles.you.bold).toBe(true);
      expect(['magenta', 'magentaBright']).toContain(THEMES[name].roles.assistant.color?.ansi16);
      expect(['magenta', 'magentaBright']).toContain(THEMES[name].roles.you.color?.ansi16);
    }
    expect(THEMES.dark.roles.dim.color).toBeUndefined();
  });
  it('itemRole never returns a pink role; the `git none · …` guidance rows are body grade while the status banner is dim (§2.1 dim row, §5.1 rule 2)', () => {
    const pink: readonly ColorRole[] = ['accent', 'accent2', 'you', 'assistant', 'badge', 'chosen', 'borderFocus'];
    const rows: readonly Parameters<typeof itemRole>[0][] = [
      { level: 'info', kind: 'workspace', text: 'git main · 3 modified · 1 staged · 1 untracked' },
      { level: 'info', kind: 'workspace', text: 'git none · not a git repository: changes made by commands are not recoverable, /diff compares against step pre-images only' },
      { level: 'info', kind: 'workspace', text: 'git none - git not found on PATH: /undo and /diff use step pre-images only' },
      { level: 'warn', kind: 'workspace', text: 'warning: HEAD was main@7d731c0e at run start, now detached abcdef01 — the plan may not apply' },
      { level: 'info', kind: 'chat', local: true, label: '[you]', text: 'hi' },
      { level: 'info', kind: 'chat', local: true, label: '[jevcode]', text: 'hello' },
      { level: 'info', kind: 'ui', local: true, label: '[ui]', text: 'theme light' },
    ];
    for (const row of rows) expect(pink.includes(itemRole(row) as ColorRole), row.text).toBe(false);
    expect(itemRole(rows[0]!)).toBe('dim');
    expect(itemRole(rows[1]!)).toBeNull();
    expect(itemRole(rows[2]!)).toBeNull();
    expect(itemRole(rows[3]!)).toBe('warn');
  });
});

describe('(7) the theme names no mode (D-N)', () => {
  it('src/tui/theme.ts contains none of jev-only | jev+llm | llm-jev | llm-only; the badge marker is a placeholder', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'tui', 'theme.ts'), 'utf8');
    expect(source).not.toMatch(/jev-only|jev\+llm|llm-jev|llm-only/);
    for (const name of THEME_NAMES) expect(THEMES[name].roles.badge.marker).toBe('<mode>');
  });
});
