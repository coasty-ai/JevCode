#!/usr/bin/env node
// Release gate for the npm tarball (TUI-DESIGN §17.8, F15, D14). Run after `npm run build`:
//
//   node scripts/check-pack.mjs
//
// Gates (every failure is reported; exit 1 if any fails):
//   1. `npm pkg get private` prints `{}` (the package is publishable)
//   2. LICENSE exists and is non-empty (npm always ships it; the package says MIT)
//   3. THIRD_PARTY_LICENSES.txt exists and is non-empty (scripts/licenses.mjs)
//   4. `dependencies` is empty: ink and react are inlined by esbuild, so `npm i -g jevcode` installs 0 packages
//   5. `npm pack --dry-run --json` lists exactly the allowlist derived from package.json `files`
//      (directories expanded recursively) plus package.json; extras and missing entries are named
//   6. no forbidden path: *.map, meta.json, src/, docs/, test files, .env*
//   7. unpacked size < 3 MB (the wave-3 bundle is 1.86 MB) and the gzipped tarball < 1.5 MB
//   8. `node bin/jevcode.js --version` prints the package.json version
//
// `npm pack` is run with --ignore-scripts so the `prepack` hook (a full rebuild) does not fire here.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNPACKED_MAX = 3_000_000; // bytes
const TARBALL_MAX = 1_500_000; // bytes
const FORBIDDEN = [
  [/\.map$/, 'source map'],
  [/(^|\/)meta\.json$/, 'esbuild metafile'],
  [/^src\//, 'TypeScript source'],
  [/^docs\//, 'design docs'],
  [/^test\//, 'tests'],
  [/(^|\/)__tests__\//, 'tests'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/(^|\/)\.env(\.|$)/, 'dotenv file'],
  [/(^|\/)\.(scratch|claude|vitest|git)(\/|$)/, 'local tooling state'],
  [/^(coverage|perf|bench|experiments|examples|node_modules)\//, 'non-shipping directory'],
];

const failures = [];
const ok = (msg) => console.log(`ok    ${msg}`);
const bad = (msg) => {
  failures.push(msg);
  console.log(`FAIL  ${msg}`);
};

const npm = (args) => spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'error' }, timeout: 120_000 });
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// 1. private
{
  const r = npm(['pkg', 'get', 'private']);
  const out = (r.stdout ?? '').trim();
  if (r.status === 0 && out === '{}' && pkg.private === undefined) ok('`npm pkg get private` is {} (publishable)');
  else bad(`package.json is private (\`npm pkg get private\` printed ${JSON.stringify(out)}); remove "private": true`);
}

// 2. LICENSE
{
  const p = join(ROOT, 'LICENSE');
  if (existsSync(p) && statSync(p).size > 0) ok(`LICENSE present (${statSync(p).size} bytes, license field "${pkg.license}")`);
  else bad('LICENSE is missing or empty (package.json says MIT; npm always ships LICENSE)');
}

// 3. THIRD_PARTY_LICENSES.txt
{
  const p = join(ROOT, 'THIRD_PARTY_LICENSES.txt');
  if (existsSync(p) && statSync(p).size > 0) ok(`THIRD_PARTY_LICENSES.txt present (${statSync(p).size} bytes)`);
  else bad('THIRD_PARTY_LICENSES.txt is missing or empty; run `npm run build` (scripts/licenses.mjs)');
}

// 4. zero runtime dependencies
{
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) ok('dependencies is empty (ink/react are inlined; `npm i -g jevcode` installs 0 packages)');
  else bad(`dependencies must be empty (found ${deps.join(', ')}); esbuild inlines them, move them to devDependencies`);
}

// 5–7. tarball contents and size
function walk(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}
const expected = new Set(['package.json']);
const missingOnDisk = [];
for (const entry of pkg.files ?? []) {
  const full = join(ROOT, entry);
  if (!existsSync(full)) {
    missingOnDisk.push(entry);
    continue;
  }
  if (statSync(full).isDirectory()) for (const f of walk(full, entry.replace(/\/+$/, ''))) expected.add(f);
  else expected.add(entry);
}
if (missingOnDisk.length > 0) bad(`"files" entries not on disk: ${missingOnDisk.join(', ')} (run \`npm run build\` / \`node scripts/gen-docs.mjs\`)`);

const packed = npm(['pack', '--dry-run', '--json', '--ignore-scripts']);
if (packed.status !== 0) {
  bad(`npm pack --dry-run failed:\n${(packed.stderr ?? '').trim()}`);
} else {
  let report;
  try {
    report = JSON.parse(packed.stdout)[0];
  } catch (e) {
    bad(`could not parse npm pack --json output: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (report) {
    const actual = new Set(report.files.map((f) => f.path));
    const extras = [...actual].filter((p) => !expected.has(p)).sort();
    const missing = [...expected].filter((p) => !actual.has(p)).sort();
    if (extras.length === 0 && missing.length === 0) ok(`tarball file list equals the "files" allowlist (${actual.size} files: ${[...actual].sort().join(', ')})`);
    else {
      if (extras.length > 0) bad(`tarball contains files outside the allowlist: ${extras.join(', ')}`);
      if (missing.length > 0) bad(`allowlisted files missing from the tarball: ${missing.join(', ')}`);
    }

    const forbidden = [];
    for (const p of actual) for (const [re, why] of FORBIDDEN) if (re.test(p)) forbidden.push(`${p} (${why})`);
    if (forbidden.length === 0) ok('no .map, meta.json, src/, docs/, test or .env files in the tarball');
    else bad(`forbidden files in the tarball: ${forbidden.join('; ')}`);

    const bundle = report.files.find((f) => f.path === 'dist/jevcode.mjs');
    const bundleNote = bundle ? `, dist/jevcode.mjs ${bundle.size} bytes` : '';
    if (report.unpackedSize < UNPACKED_MAX) ok(`unpacked size ${report.unpackedSize} bytes < ${UNPACKED_MAX}${bundleNote}`);
    else bad(`unpacked size ${report.unpackedSize} bytes exceeds ${UNPACKED_MAX}${bundleNote}`);
    if (report.size < TARBALL_MAX) ok(`tarball size ${report.size} bytes < ${TARBALL_MAX} (${report.filename})`);
    else bad(`tarball size ${report.size} bytes exceeds ${TARBALL_MAX} (${report.filename})`);
  }
}

// 8. --version smoke
{
  const r = spawnSync(process.execPath, ['bin/jevcode.js', '--version'], { cwd: ROOT, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status === 0 && out.includes(pkg.version)) ok(`\`node bin/jevcode.js --version\` printed "${out.split('\n')[0]}"`);
  else bad(`\`node bin/jevcode.js --version\` exit ${r.status}, output ${JSON.stringify(out.slice(0, 200))} (expected to contain ${pkg.version})`);
}

if (failures.length > 0) {
  console.error(`\ncheck-pack: ${failures.length} gate(s) failed`);
  process.exit(1);
}
console.log(`\ncheck-pack: all gates passed (${relative(ROOT, join(ROOT, 'package.json'))} ${pkg.name}@${pkg.version})`);
