// Bundles the CLI into one ESM file (ink + react included) for fast startup (DESIGN.md §12; TUI-DESIGN §17.2).
// Measured 2026-09-19: an Ink hello-world bundled this way renders its first frame in
// ~70 ms under a pseudo-TTY on Node 22.23.2 (docs/DECISIONS.md). Measured 2026-09-20
// (docs/research/tui/09-packaging-distribution.md §10.3): minifying halves the bundle at −1…−3 ms startup.
//
//   node scripts/build.mjs [--no-smoke] [--no-measure]
//
// Outputs: dist/jevcode.mjs (minified with keepNames, so stack traces and `fn.name` keep their identifiers),
// dist/jevcode.mjs.map (local debugging; excluded from the tarball by package.json "files") and dist/meta.json
//
// The map is emitted with `sourcemap: 'external'`, NOT `true` (F24c, 2026-09-22): `true` appends
// `//# sourceMappingURL=jevcode.mjs.map` to the bundle, and since the map is excluded from the tarball — and
// scripts/check-pack.mjs forbids any *.map in it — every installed copy carried a reference to a file that is not
// there, which `node --enable-source-maps` and every trace-reading tool then fail to open. `external` writes the
// same map beside the bundle for local debugging and leaves the bundle pointing at nothing.
// (the esbuild metafile; scripts/licenses.mjs derives THIRD_PARTY_LICENSES.txt from it because
// legalComments 'none' strips every attribution comment from the bundle). The version is injected from
// package.json through the `__JEVCODE_VERSION__` define that src/version.ts reads (tsx/vitest fall back
// to package.json). Unless --no-measure is given, an in-memory unminified pass runs first so the log line
// reports the bundle bytes before and after minification.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
  console.error(`build: package.json version is not semver-shaped: ${JSON.stringify(pkg.version)}`);
  process.exit(1);
}
const noSmoke = process.argv.includes('--no-smoke');
const noMeasure = process.argv.includes('--no-measure');

const common = {
  entryPoints: ['src/cli/main.tsx'],
  outfile: 'dist/jevcode.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  jsx: 'automatic',
  jsxImportSource: 'react',
  alias: {
    // Ink's reconciler dynamically imports ./devtools.js, which statically imports the optional
    // peer react-devtools-core. Alias it to an empty stub and turn the DEV branch into dead code.
    'react-devtools-core': './src/tui/devtools-stub.ts',
    // ink/build/devtools.js also imports the `ws` WebSocket client (~126 KB unminified). It is only
    // reachable when process.env.DEV === 'true', which the define below fixes to "false", yet the
    // dynamic import still lands in the bundle; the same stub keeps it out of the tarball.
    ws: './src/tui/devtools-stub.ts',
  },
  define: {
    'process.env.DEV': '"false"',
    'process.env.NODE_ENV': '"production"',
    // TUI-DESIGN §17.2: the one source of truth for the version is package.json; src/version.ts reads this.
    __JEVCODE_VERSION__: JSON.stringify(pkg.version),
  },
  // CJS dependencies inside Ink's tree (signal-exit) call require() at module init.
  banner: { js: "import { createRequire as __jevRequire } from 'node:module'; const require = __jevRequire(import.meta.url);" },
};

mkdirSync('dist', { recursive: true });
const t0 = performance.now();

// Pass 1 (measurement only, nothing written): the unminified size, so the before/after is exact for this tree.
let rawBytes = null;
if (!noMeasure) {
  const raw = await build({ ...common, write: false, minify: false, sourcemap: false });
  rawBytes = raw.outputFiles.find((f) => f.path.endsWith('.mjs'))?.contents.byteLength ?? null;
}

// Pass 2: the shipped artefact. `sourcemap: 'external'` — the map is written, the bundle carries no directive (see the
// header): the map never ships, so a directive would dangle in every install.
const result = await build({ ...common, sourcemap: 'external', minify: true, keepNames: true, metafile: true });
writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
const minBytes = statSync('dist/jevcode.mjs').size;
const ms = Math.round(performance.now() - t0);
if (rawBytes !== null) {
  const saved = (100 - (minBytes / rawBytes) * 100).toFixed(1);
  console.log(`build: dist/jevcode.mjs ${rawBytes} bytes unminified -> ${minBytes} bytes minified (${saved} % smaller, keepNames) in ${ms} ms`);
} else {
  console.log(`build: dist/jevcode.mjs ${minBytes} bytes minified (keepNames) in ${ms} ms`);
}

// Smoke step: the bundle must load and print the first-frame sentinel with no network, and --version
// must print the package.json version (the define above, through src/version.ts).
if (!noSmoke) {
  const ws = mkdtempSync(join(tmpdir(), 'jevcode-smoke-'));
  const r = spawnSync(process.execPath, ['bin/jevcode.js', 'run', 'smoke task', '--workspace', ws, '--plain', '--perf-exit-after-first-frame'], {
    encoding: 'utf8',
    env: { ...process.env, JEVCODE_ASSERT_NO_NETWORK: '1', JEVCODE_HOME: join(ws, 'no-runs-dir') },
    timeout: 20_000,
  });
  rmSync(ws, { recursive: true, force: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 || !/FIRST_FRAME_MS=/.test(out)) {
    console.error('build smoke failed:\n' + out.slice(0, 4000));
    process.exit(1);
  }
  const frame = /FIRST_FRAME_MS=(\d+)/.exec(out);
  console.log(`build smoke: first frame ok${frame ? ` (${frame[1]} ms)` : ''}`);

  const v = spawnSync(process.execPath, ['bin/jevcode.js', '--version'], {
    encoding: 'utf8',
    env: { ...process.env, JEVCODE_ASSERT_NO_NETWORK: '1' },
    timeout: 20_000,
  });
  const vout = `${v.stdout ?? ''}${v.stderr ?? ''}`.trim();
  if (v.status !== 0 || !vout.includes(pkg.version)) {
    console.error(`build smoke failed: --version exit ${v.status}, printed ${JSON.stringify(vout.slice(0, 400))}, expected ${pkg.version}`);
    process.exit(1);
  }
  console.log(`build smoke: --version ok (${vout.split('\n')[0]})`);
}
