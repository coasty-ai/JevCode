// Generates src/tui/composer/eaw-table.ts (TUI-DESIGN §4.2, A2, C20): the East Asian Width Wide + Fullwidth
// ranges that `cellWidth` needs, as one sorted flat array of inclusive [start, end] pairs for binary search.
// Source: the devDependency-visible `get-east-asian-width` package under node_modules (the same table Ink's
// `string-width@8.2.2` consults), else the checked-in FALLBACK list below (a copy of get-east-asian-width@1.7.0,
// Unicode 17.0). Run once and commit the generated table as source: `node scripts/gen-eaw.mjs`.
// The composer never imports get-east-asian-width at runtime (F18: ink + react are the only runtime deps).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'tui', 'composer', 'eaw-table.ts');

// get-east-asian-width@1.7.0 lookup-data.js (Unicode 17.0.0): 125 Wide pairs + 3 Fullwidth pairs.
const FALLBACK = {
  version: '1.7.0',
  unicode: '17.0.0',
  wide: [
    0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
    0x2630, 0x2637, 0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
    0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd,
    0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797,
    0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5,
    0x2ff0, 0x2fff, 0x3001, 0x303e, 0x3041, 0x3096, 0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e,
    0x3220, 0x3247, 0x3250, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe52,
    0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff6, 0x17000, 0x18cda, 0x18cff, 0x18d20, 0x18d80, 0x18df2, 0x18e00, 0x19191,
    0x191a0, 0x191d2, 0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b128, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155,
    0x1b164, 0x1b168, 0x1b170, 0x1b2fb, 0x1d300, 0x1d356, 0x1d360, 0x1d376, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a,
    0x1f1ae, 0x1f1ae, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335,
    0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440,
    0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f,
    0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d9, 0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7da, 0x1f7da,
    0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fac6, 0x1fac8, 0x1fac8,
    0x1facc, 0x1fadd, 0x1fadf, 0x1faeb, 0x1faef, 0x1fafa, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
  ],
  fullwidth: [0x3000, 0x3000, 0xff01, 0xff60, 0xffe0, 0xffe6],
};

async function loadSource() {
  const pkgDir = join(root, 'node_modules', 'get-east-asian-width');
  const dataFile = join(pkgDir, 'lookup-data.js');
  if (!existsSync(dataFile)) return { ...FALLBACK, origin: 'checked-in fallback (get-east-asian-width not installed)' };
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const data = await import(pathToFileURL(dataFile).href);
  const wide = Array.from(data.wideRanges, Number);
  const fullwidth = Array.from(data.fullwidthRanges, Number);
  // The package does not export its Unicode version; the ranges are the Unicode 17.0.0 table for 1.7.0.
  const unicode = pkg.version === FALLBACK.version ? FALLBACK.unicode : 'see package release notes';
  return { version: pkg.version, unicode, wide, fullwidth, origin: `node_modules/get-east-asian-width@${pkg.version}` };
}

/** Merge Wide + Fullwidth into one sorted, non-overlapping flat pair list. */
function mergeRanges(...lists) {
  const pairs = [];
  for (const flat of lists) {
    if (flat.length % 2 !== 0) throw new Error('range list must have an even length');
    for (let i = 0; i < flat.length; i += 2) {
      const a = flat[i];
      const b = flat[i + 1];
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b || a < 0 || b > 0x10ffff) throw new Error(`bad range ${a}..${b}`);
      pairs.push([a, b]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of pairs) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

const src = await loadSource();
const merged = mergeRanges(src.wide, src.fullwidth);
const hex = (n) => `0x${n.toString(16)}`;
const rows = [];
for (let i = 0; i < merged.length; i += 4) {
  rows.push('  ' + merged.slice(i, i + 4).map(([a, b]) => `${hex(a)}, ${hex(b)}`).join(', ') + ',');
}
const body = `// GENERATED by scripts/gen-eaw.mjs — do not edit by hand. Re-run: node scripts/gen-eaw.mjs
// TUI-DESIGN §4.2 (A2, C20): East Asian Width Wide (W) + Fullwidth (F) ranges as one sorted flat array of
// inclusive [start, end] code point pairs (${src.wide.length / 2} W + ${src.fullwidth.length / 2} F source ranges, ${merged.length} after merging adjacent ones).
// Source: ${src.origin}; Unicode ${src.unicode}. Ambiguous (A) is narrow, as Ink's string-width default.

/** Unicode version of the EastAsianWidth.txt these ranges were derived from (TUI-DESIGN §4.2). */
export const EAW_UNICODE_VERSION = '${src.unicode}';

/** Sorted flat [start, end] pairs of every W and F code point; searched by \`isWideCodePoint\` in width.ts (TUI-DESIGN §4.2). */
export const EAW_WIDE_RANGES: readonly number[] = [
${rows.join('\n')}
];
`;
writeFileSync(out, body);
process.stdout.write(`gen-eaw: wrote ${out} (${merged.length} ranges, Unicode ${src.unicode}, from ${src.origin})\n`);
