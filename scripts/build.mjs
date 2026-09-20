// Bundles the CLI into one ESM file (ink + react included) for fast startup (DESIGN.md §12).
// Measured 2026-09-19: an Ink hello-world bundled this way renders its first frame in
// ~70 ms under a pseudo-TTY on Node 22.23.2 (docs/DECISIONS.md).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

mkdirSync('dist', { recursive: true });
const t0 = performance.now();
const result = await build({
  entryPoints: ['src/cli/main.tsx'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/jevcode.mjs',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  // Ink's reconciler dynamically imports ./devtools.js, which statically imports the optional
  // peer react-devtools-core. Alias it to an empty stub and turn the DEV branch into dead code.
  alias: { 'react-devtools-core': './src/tui/devtools-stub.ts' },
  define: { 'process.env.DEV': '"false"', 'process.env.NODE_ENV': '"production"' },
  // CJS dependencies inside Ink's tree (signal-exit) call require() at module init.
  banner: { js: "import { createRequire as __jevRequire } from 'node:module'; const require = __jevRequire(import.meta.url);" },
});
writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
console.log(`build: dist/jevcode.mjs in ${Math.round(performance.now() - t0)} ms`);

// Smoke step: the bundle must load and print the first-frame sentinel with no network.
if (!process.argv.includes('--no-smoke')) {
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
  console.log('build smoke: ok');
}
