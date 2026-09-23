#!/usr/bin/env node
// Generates the README's brand assets from the program's own sources, so the front page cannot drift
// from what the TUI draws — and so nothing on it needs a third-party image service to render:
//
//   docs/media/wordmark-{dark,light}.svg   the 5-row mark, in the splash's own geometry
//   docs/media/rule-{dark,light}.svg       the section rule, in the two pinks
//   docs/media/badge-<name>.svg            the header badges
//   docs/media/swatch-<hex>.svg            the palette swatches in the Colour table
//
//   node scripts/gen-brand.mjs           write every target
//   node scripts/gen-brand.mjs --check   exit 1 and list the targets that are stale
//
// Everything that decides how these look is READ, never retyped here:
//   src/tui/splash.ts  — WORDMARK (the five rows), JEV_END_CELL, CAPTION_GRID_CELL, TAGLINE, captionText
//   src/tui/theme.ts   — THEMES.dark / THEMES.light, roles `accent` (primary pink), `accent2` (secondary
//                        pink), `code` (the foreground the dim roles are dimmed from), and the meaning
//                        roles the swatch table shows
//   package.json       — version, engines.node, licence, and the dependency count the "runtime deps" badge asserts
// The wordmark's colour split is splash.ts's own: cells [0, JEV_END_CELL) take `accent`, cells
// [JEV_END_CELL, 56) take `dim` (restingFrame's two spans per row), the caption's brand glyph takes
// `accent2` and its version `dim`, and the tagline is `dim`.
//
// Two numbers here are rendering choices rather than readings, and they are the only two:
// DIM_OPACITY (a terminal's `dim` is reduced intensity, which has no hex) and the badge geometry below.
//
// Glyph cells are drawn as rects, not as `█` in a <text>, so the mark renders identically without a
// monospace font installed; every text run carries `textLength` so it keeps its width on a renderer
// whose fallback font has a different advance. No <style>, no script, no external reference: GitHub's
// sanitiser passes presentation attributes through untouched.
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(ROOT, 'docs/media');

// ----- geometry: one terminal cell, and the page the wordmark grid is laid out on
const CELL_W = 11;
const CELL_H = 22;
const PAD_X = 8;
const PAD_Y = 10;
/** a terminal's `dim` is reduced intensity, not a colour — this is the alpha that stands in for it */
const DIM_OPACITY = 0.45;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";

// ----- badge geometry (flat-square, monospace so the width is exact rather than font-dependent)
const B_H = 20;
const B_FONT = 11;
const B_CH = 6.7;
const B_PAD = 7;
/** the label half of every badge: the theme's own dark contrast base, so one file works on a light or a dark page */
const B_LABEL_BG = '#1e1e1e';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cells = (s) => [...s].length;

/** WCAG 2.1 relative luminance, used to pick the readable text colour on a filled pill */
function luminance(hex) {
  const ch = (i) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** black or white, whichever reads better on `bg` — never a guess */
const inkOn = (bg) => (contrast(bg, '#1e1e1e') >= contrast(bg, '#ffffff') ? '#1e1e1e' : '#ffffff');

async function load() {
  const { register } = await import('tsx/esm/api');
  const unregister = register();
  try {
    const [splash, theme] = await Promise.all([
      import(pathToFileURL(join(ROOT, 'src/tui/splash.ts')).href),
      import(pathToFileURL(join(ROOT, 'src/tui/theme.ts')).href),
    ]);
    return { splash, theme, pkg: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) };
  } finally {
    unregister();
  }
}

/** the truecolor member of a role, which every role both themes use here carries */
function hex(theme, role) {
  const c = theme.roles[role].color;
  if (c === undefined || c.truecolor === undefined) throw new Error(`${theme.name}.${role} has no truecolor member`);
  return c.truecolor;
}

// ----------------------------------------------------------------- wordmark

/** one row of the mark as rects, merging each run of `█` into a single rect (small file, no seams) */
function rowRects(row, y, splitAt, onColor, offColor) {
  const out = [];
  let run = null;
  const flush = () => {
    if (run === null) return;
    out.push(
      `<rect x="${PAD_X + run.from * CELL_W}" y="${y}" width="${(run.to - run.from) * CELL_W}" height="${CELL_H}" fill="${run.color.fill}"${run.color.opacity === undefined ? '' : ` fill-opacity="${run.color.opacity}"`}/>`,
    );
    run = null;
  };
  [...row].forEach((cell, i) => {
    if (cell !== '█') return flush();
    const color = i < splitAt ? onColor : offColor;
    if (run !== null && run.color === color && run.to === i) run.to = i + 1;
    else {
      flush();
      run = { from: i, to: i + 1, color };
    }
  });
  flush();
  return out;
}

function wordmarkSvg({ splash, theme, version }) {
  const { WORDMARK, WORDMARK_ROWS, JEV_END_CELL, CAPTION_GRID_CELL, TAGLINE, captionText } = splash;
  const caption = captionText(version);
  const width = PAD_X * 2 + (CAPTION_GRID_CELL + cells(TAGLINE)) * CELL_W;
  const height = PAD_Y * 2 + WORDMARK_ROWS * CELL_H;

  const pink = { fill: hex(theme, 'accent') };
  const pink2 = { fill: hex(theme, 'accent2') };
  const dim = { fill: hex(theme, 'code'), opacity: DIM_OPACITY };

  const body = [];
  for (let r = 0; r < WORDMARK_ROWS; r++) body.push(...rowRects(WORDMARK[r], PAD_Y + r * CELL_H, JEV_END_CELL, pink, dim));

  const textX = PAD_X + CAPTION_GRID_CELL * CELL_W;
  const baseline = (r) => PAD_Y + r * CELL_H + CELL_H * 0.72;
  const span = (s) => cells(s) * CELL_W;
  body.push(
    `<text x="${textX}" y="${baseline(0)}" font-family="${MONO}" font-size="${CELL_H * 0.62}" textLength="${span(TAGLINE)}" lengthAdjust="spacingAndGlyphs" fill="${dim.fill}" fill-opacity="${dim.opacity}">${esc(TAGLINE)}</text>`,
  );
  // captionText is `<brand glyph> <version>`: the glyph takes accent2, the version dim (restingFrame's two spans)
  const glyph = [...caption][0];
  body.push(
    `<text x="${textX}" y="${baseline(WORDMARK_ROWS - 1)}" font-family="${MONO}" font-size="${CELL_H * 0.62}" textLength="${span(caption)}" lengthAdjust="spacingAndGlyphs">` +
      `<tspan fill="${pink2.fill}">${esc(glyph)}</tspan>` +
      `<tspan fill="${dim.fill}" fill-opacity="${dim.opacity}">${esc(caption.slice(glyph.length))}</tspan>` +
      `</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="JevCode — ${esc(TAGLINE)}">`,
    `<title>JevCode — ${esc(TAGLINE)}</title>`,
    ...body,
    `</svg>`,
  ].join('\n');
}

/** the section rule: the two pinks fading out, at the width of the wordmark page */
function ruleSvg({ splash, theme }) {
  const width = PAD_X * 2 + (splash.CAPTION_GRID_CELL + cells(splash.TAGLINE)) * CELL_W;
  const id = `r-${theme.name}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="2" viewBox="0 0 ${width} 2" role="presentation">`,
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${hex(theme, 'accent')}" stop-opacity="0"/>`,
    `<stop offset="0.5" stop-color="${hex(theme, 'accent')}" stop-opacity="0.9"/>`,
    `<stop offset="1" stop-color="${hex(theme, 'accent2')}" stop-opacity="0"/>`,
    `</linearGradient></defs>`,
    `<rect x="0" y="0" width="${width}" height="2" fill="url(#${id})"/>`,
    `</svg>`,
  ].join('\n');
}

// ----------------------------------------------------------------- badges

/**
 * A flat-square badge. With a label: a dark label half and a coloured message half. Without one
 * (`label: null`): a single coloured pill. Monospace + `textLength` keeps the drawn width equal to the
 * width this function measured, on any renderer.
 */
function badgeSvg({ label, message, color }) {
  const textW = (s) => Math.round(cells(s) * B_CH);
  const msgW = textW(message) + B_PAD * 2;
  const labW = label === null ? 0 : textW(label) + B_PAD * 2;
  const width = labW + msgW;
  const y = B_H / 2 + B_FONT * 0.35;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${B_H}" viewBox="0 0 ${width} ${B_H}" role="img" aria-label="${esc(label === null ? message : `${label}: ${message}`)}">`,
    `<title>${esc(label === null ? message : `${label}: ${message}`)}</title>`,
  ];
  if (label !== null) {
    parts.push(`<rect x="0" y="0" width="${labW}" height="${B_H}" fill="${B_LABEL_BG}"/>`);
    parts.push(
      `<text x="${B_PAD}" y="${y}" font-family="${MONO}" font-size="${B_FONT}" textLength="${textW(label)}" lengthAdjust="spacingAndGlyphs" fill="#e5e5e5">${esc(label)}</text>`,
    );
  }
  parts.push(`<rect x="${labW}" y="0" width="${msgW}" height="${B_H}" fill="${color}"/>`);
  parts.push(
    `<text x="${labW + B_PAD}" y="${y}" font-family="${MONO}" font-size="${B_FONT}" textLength="${textW(message)}" lengthAdjust="spacingAndGlyphs" fill="${inkOn(color)}">${esc(message)}</text>`,
  );
  parts.push(`</svg>`);
  return parts.join('\n');
}

/** one solid pill naming its own hex — the swatches in the README's Colour table */
function swatchSvg(color) {
  const label = color.toLowerCase();
  const w = Math.round(cells(label) * B_CH) + B_PAD * 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${B_H}" viewBox="0 0 ${w} ${B_H}" role="img" aria-label="${esc(label)}">`,
    `<title>${esc(label)}</title>`,
    `<rect x="0" y="0" width="${w}" height="${B_H}" fill="${color}"/>`,
    `<text x="${B_PAD}" y="${B_H / 2 + B_FONT * 0.35}" font-family="${MONO}" font-size="${B_FONT}" textLength="${Math.round(cells(label) * B_CH)}" lengthAdjust="spacingAndGlyphs" fill="${inkOn(color)}">${esc(label)}</text>`,
    `</svg>`,
  ].join('\n');
}

// -----------------------------------------------------------------

function build({ splash, theme: themeMod, pkg }) {
  const dark = themeMod.THEMES.dark;
  const light = themeMod.THEMES.light;
  const out = {
    'wordmark-dark.svg': wordmarkSvg({ splash, theme: dark, version: pkg.version }),
    'wordmark-light.svg': wordmarkSvg({ splash, theme: light, version: pkg.version }),
    'rule-dark.svg': ruleSvg({ splash, theme: dark }),
    'rule-light.svg': ruleSvg({ splash, theme: light }),
  };

  // every badge's message is read from package.json, so a version or engines bump regenerates rather than rots
  const deps = Object.keys(pkg.dependencies ?? {}).length;
  const badges = [
    ['version', { label: 'version', message: pkg.version, color: hex(dark, 'accent') }],
    ['node', { label: 'node', message: `≥ ${String(pkg.engines.node).replace(/^>=\s*/, '')}`, color: hex(dark, 'accent2') }],
    ['deps', { label: 'runtime deps', message: String(deps), color: hex(dark, 'accent') }],
    // not derivable from package.json: a statement about the sandbox and the test machinery, which need POSIX
    ['platform', { label: null, message: 'macOS · Linux · WSL 2', color: hex(dark, 'accent2') }],
    ['licence', { label: 'licence', message: pkg.license, color: hex(dark, 'accent') }],
  ];
  for (const [name, spec] of badges) out[`badge-${name}.svg`] = badgeSvg(spec);

  // the swatches the Colour table shows: every role it lists, in both themes, deduplicated by hex
  const SWATCH_ROLES = ['accent', 'accent2', 'ok', 'review', 'block'];
  const hexes = new Set();
  for (const t of [dark, light]) for (const role of SWATCH_ROLES) hexes.add(hex(t, role));
  for (const h of hexes) out[`swatch-${h.slice(1).toLowerCase()}.svg`] = swatchSvg(h);

  return out;
}

async function main() {
  const built = build(await load());
  const check = process.argv.includes('--check');
  const stale = [];

  for (const [name, text] of Object.entries(built)) {
    const path = join(MEDIA, name);
    const want = `${text}\n`;
    let have = null;
    try {
      have = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      /* absent */
    }
    if (have === want) continue;
    if (check) stale.push(name);
    else {
      writeFileSync(path, want);
      console.log(`wrote docs/media/${name}`);
    }
  }

  // a generated file this run did not produce is a leftover (a renamed badge, a retired swatch): it must go,
  // or the README keeps rendering a colour the theme no longer has
  const GENERATED = /^(wordmark|rule|badge|swatch)-.*\.svg$/;
  for (const name of readdirSync(MEDIA)) {
    if (!GENERATED.test(name) || Object.hasOwn(built, name)) continue;
    if (check) stale.push(`${name} (orphan)`);
    else {
      unlinkSync(join(MEDIA, name));
      console.log(`removed docs/media/${name} (no longer generated)`);
    }
  }

  if (check) {
    if (stale.length > 0) {
      console.error(`stale (run \`npm run brand\`):\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`brand assets are current (${Object.keys(built).length} files)`);
  }
}

await main();
