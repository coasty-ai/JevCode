// Bundles the CLI into one ESM file (ink + react included) for fast startup.
// Measured 2026-09-19: an Ink hello-world bundled this way renders its first frame in
// ~70 ms under a pseudo-TTY on Node 22.23.2 (see docs/DECISIONS.md).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const t0 = performance.now();
const result = await build({
  entryPoints: ['src/cli/main.ts'],
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
  // Ink's reconciler dynamically imports ./devtools.js, which statically imports the
  // optional peer react-devtools-core. Alias it to an empty stub and turn the DEV branch
  // into dead code so the bundle has no unresolved import at startup.
  alias: { 'react-devtools-core': './scripts/stubs/react-devtools-core.js' },
  define: { 'process.env.DEV': '"false"', 'process.env.NODE_ENV': '"production"' },
  banner: { js: "import { createRequire as __jevRequire } from 'node:module'; const require = __jevRequire(import.meta.url);" },
});
writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
console.log(`build: dist/jevcode.mjs in ${Math.round(performance.now() - t0)} ms`);
