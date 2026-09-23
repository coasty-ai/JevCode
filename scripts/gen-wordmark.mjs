#!/usr/bin/env node
// Generates the README's brand assets from the program's own sources, so the picture on the front page
// cannot drift from what the TUI draws: docs/media/wordmark-{dark,light}.svg and docs/media/rule-{dark,light}.svg.
//
//   node scripts/gen-wordmark.mjs           write every target
//   node scripts/gen-wordmark.mjs --check   exit 1 and list the targets that are stale
//
// Everything that decides how the mark looks is READ, never retyped here:
//   src/tui/splash.ts  — WORDMARK (the five rows), JEV_END_CELL, CAPTION_GRID_CELL, TAGLINE, captionText
//   src/tui/theme.ts   — THEMES.dark / THEMES.light, roles `accent` (primary pink), `accent2` (secondary pink),
//                        `code` (the foreground the dim roles are dimmed from)
//   package.json       — the version in the caption
// The colour split is splash.ts's own: cells [0, JEV_END_CELL) take `accent`, cells [JEV_END_CELL, 56) take `dim`
// (restingFrame, the two spans it pushes per row), the caption's brand glyph takes `accent2` and its version `dim`,
// and the tagline is `dim`. A terminal renders `dim` as reduced intensity, which has no hex; DIM_OPACITY below is
// this file's one rendering choice and the only number here that is not read from the source.
//
// Cells are drawn as rects, not as `█` in a <text>, so the mark renders identically without a monospace font
// installed; only the tagline and caption are text. No <style>, no script, no external reference: GitHub's
// sanitiser passes presentation attributes through untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ----- geometry: one terminal cell, and the page the grid is laid out on
const CELL_W = 11;
const CELL_H = 22;
/** the tagline ends at cell 80 (CAPTION_GRID_CELL 58 + 'Decisions, not strings'); the page is that wide */
const PAD_X = 8;
const PAD_Y = 10;
/** a terminal's `dim` is reduced intensity, not a colour — this is the alpha that stands in for it */
const DIM_OPACITY = 0.45;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace";

const TARGETS = {
  'wordmark-dark': 'docs/media/wordmark-dark.svg',
  'wordmark-light': 'docs/media/wordmark-light.svg',
  'rule-dark': 'docs/media/rule-dark.svg',
  'rule-light': 'docs/media/rule-light.svg',
};

async function load() {
  const { register } = await import('tsx/esm/api');
  const unregister = register();
  try {
    const [splash, theme] = await Promise.all([
      import(pathToFileURL(join(ROOT, 'src/tui/splash.ts')).href),
      import(pathToFileURL(join(ROOT, 'src/tui/theme.ts')).href),
    ]);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return { splash, theme, version: pkg.version };
  } finally {
    unregister();
  }
}

/** the truecolor member of a role, which every pink in both themes carries */
function hex(theme, role) {
  const c = theme.roles[role].color;
  if (c === undefined || c.truecolor === undefined) throw new Error(`${theme.name}.${role} has no truecolor member`);
  return c.truecolor;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * One row of the mark as rects, merging each run of `█` into a single rect: 56 cells become ~4 rects a row,
 * which keeps the file small and removes the hairline seams some renderers draw between abutting rects.
 */
function rowRects(row, y, splitAt, onColor, offColor) {
  const cells = [...row];
  const out = [];
  let run = null; // { from, to, color }
  const flush = () => {
    if (run === null) return;
    const x = PAD_X + run.from * CELL_W;
    const w = (run.to - run.from) * CELL_W;
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${CELL_H}" fill="${run.color.fill}"${run.color.opacity === undefined ? '' : ` fill-opacity="${run.color.opacity}"`}/>`);
    run = null;
  };
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== '█') {
      flush();
      continue;
    }
    const color = i < splitAt ? onColor : offColor;
    if (run !== null && run.color === color && run.to === i) run.to = i + 1;
    else {
      flush();
      run = { from: i, to: i + 1, color };
    }
  }
  flush();
  return out;
}

function wordmarkSvg({ splash, theme, version }) {
  const { WORDMARK, WORDMARK_ROWS, JEV_END_CELL, CAPTION_GRID_CELL, TAGLINE, captionText } = splash;
  const caption = captionText(version);
  const gridCells = CAPTION_GRID_CELL + [...TAGLINE].length;
  const width = PAD_X * 2 + gridCells * CELL_W;
  const height = PAD_Y * 2 + WORDMARK_ROWS * CELL_H;

  const pink = { fill: hex(theme, 'accent') };
  const pink2 = { fill: hex(theme, 'accent2') };
  const dim = { fill: hex(theme, 'code'), opacity: DIM_OPACITY };

  const body = [];
  for (let r = 0; r < WORDMARK_ROWS; r++) {
    body.push(...rowRects(WORDMARK[r], PAD_Y + r * CELL_H, JEV_END_CELL, pink, dim));
  }

  // the tagline on row 0 and the caption on the last row, both at grid cell CAPTION_GRID_CELL (splash.ts `tail`)
  const textX = PAD_X + CAPTION_GRID_CELL * CELL_W;
  const baseline = (r) => PAD_Y + r * CELL_H + CELL_H * 0.72;
  // `textLength` pins each string to the exact number of cells it occupies in the terminal, so the mark keeps
  // the splash's geometry on a renderer whose monospace fallback has a different advance width (without it the
  // tagline overruns the page on some renderers).
  const cells = (s) => [...s].length * CELL_W;
  body.push(
    `<text x="${textX}" y="${baseline(0)}" font-family="${MONO}" font-size="${CELL_H * 0.62}" textLength="${cells(TAGLINE)}" lengthAdjust="spacingAndGlyphs" fill="${dim.fill}" fill-opacity="${dim.opacity}">${esc(TAGLINE)}</text>`,
  );
  // captionText is `<brand glyph> <version>`: the glyph takes accent2, the version dim (restingFrame's two spans)
  const glyph = [...caption][0];
  const rest = caption.slice(glyph.length);
  body.push(
    `<text x="${textX}" y="${baseline(WORDMARK_ROWS - 1)}" font-family="${MONO}" font-size="${CELL_H * 0.62}" textLength="${cells(caption)}" lengthAdjust="spacingAndGlyphs">` +
      `<tspan fill="${pink2.fill}">${esc(glyph)}</tspan>` +
      `<tspan fill="${dim.fill}" fill-opacity="${dim.opacity}">${esc(rest)}</tspan>` +
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
  const gridCells = splash.CAPTION_GRID_CELL + [...splash.TAGLINE].length;
  const width = PAD_X * 2 + gridCells * CELL_W;
  const h = 2;
  const id = `r-${theme.name}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="presentation">`,
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="${hex(theme, 'accent')}" stop-opacity="0"/>`,
    `<stop offset="0.5" stop-color="${hex(theme, 'accent')}" stop-opacity="0.9"/>`,
    `<stop offset="1" stop-color="${hex(theme, 'accent2')}" stop-opacity="0"/>`,
    `</linearGradient></defs>`,
    `<rect x="0" y="0" width="${width}" height="${h}" fill="url(#${id})"/>`,
    `</svg>`,
  ].join('\n');
}

async function main() {
  const { splash, theme: themeMod, version } = await load();
  const dark = themeMod.THEMES.dark;
  const light = themeMod.THEMES.light;
  const built = {
    'wordmark-dark': wordmarkSvg({ splash, theme: dark, version }),
    'wordmark-light': wordmarkSvg({ splash, theme: light, version }),
    'rule-dark': ruleSvg({ splash, theme: dark }),
    'rule-light': ruleSvg({ splash, theme: light }),
  };

  const check = process.argv.includes('--check');
  const stale = [];
  for (const [name, rel] of Object.entries(TARGETS)) {
    const path = join(ROOT, rel);
    const want = `${built[name]}\n`;
    let have = null;
    try {
      have = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      /* absent */
    }
    if (have === want) continue;
    if (check) stale.push(rel);
    else {
      writeFileSync(path, want);
      console.log(`wrote ${rel}`);
    }
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`stale (run \`node scripts/gen-wordmark.mjs\`):\n  ${stale.join('\n  ')}`);
      process.exit(1);
    }
    console.log('wordmark assets are current');
  }
}

await main();
