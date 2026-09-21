#!/usr/bin/env node
// Generates THIRD_PARTY_LICENSES.txt for the published tarball (TUI-DESIGN §17.2, F15, D14).
//
// scripts/build.mjs bundles ink, react and their dependency trees into dist/jevcode.mjs with
// esbuild `legalComments: 'none'`, which strips every license header from the output. The
// attributions therefore have to be produced explicitly: this script walks the bundle's metafile
// (dist/meta.json, written by the build), maps every `node_modules/…` input to its nearest
// package.json, and writes one deterministic notice file with the package name, version, SPDX
// license field and the package's LICENSE/LICENCE/COPYING text when it ships one.
//
//   node scripts/licenses.mjs            write THIRD_PARTY_LICENSES.txt (run after the build)
//   node scripts/licenses.mjs --check    exit 1 if the file on disk differs from what would be written
//
// Exit 1 (with the offending packages listed) when a bundled package has neither a `license`
// field nor a license file — shipping it unattributed is not an option.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = join(ROOT, 'dist', 'meta.json');
const OUT = join(ROOT, 'THIRD_PARTY_LICENSES.txt');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|_|$)/i;

const check = process.argv.includes('--check');

function fail(msg) {
  console.error(`licenses: ${msg}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The SPDX-ish license string of a package.json, or null when it declares none. */
function licenseField(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && typeof l.type === 'string' ? l.type : null)).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return null;
}

/** Nearest ancestor directory (within node_modules) whose package.json names a package. */
function nearestPackageDir(inputPath) {
  let dir = dirname(join(ROOT, inputPath));
  for (let i = 0; i < 64; i++) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const pkg = readJson(pj);
        if (typeof pkg.name === 'string' && pkg.name) return { dir, pkg };
      } catch {
        // malformed nested package.json: keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir.split(sep).pop() === 'node_modules') break;
    dir = parent;
  }
  return null;
}

function licenseFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => LICENSE_FILE.test(name))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

if (!existsSync(META)) fail(`${relative(ROOT, META)} not found; run \`node scripts/build.mjs\` first`);
const rootPkg = readJson(join(ROOT, 'package.json'));
const meta = readJson(META);
const inputs = Object.keys(meta.inputs ?? {});
if (inputs.length === 0) fail('the metafile lists no inputs');

/** @type {Map<string, { name: string, version: string, dir: string, license: string | null, files: string[], homepage: string | null, repository: string | null }>} */
const packages = new Map();
for (const input of inputs) {
  const normalized = input.split(sep).join('/');
  if (!normalized.includes('node_modules/')) continue; // first-party source (src/**) is covered by LICENSE
  const found = nearestPackageDir(input);
  if (!found) fail(`no package.json found above bundled input ${input}`);
  const { dir, pkg } = found;
  const key = `${pkg.name}@${pkg.version ?? '?'}#${relative(ROOT, dir)}`;
  if (packages.has(key)) continue;
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && typeof pkg.repository.url === 'string' ? pkg.repository.url : null;
  packages.set(key, {
    name: pkg.name,
    version: typeof pkg.version === 'string' ? pkg.version : '?',
    dir,
    license: licenseField(pkg),
    files: licenseFiles(dir),
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
    repository: repo,
  });
}

const sorted = [...packages.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
const unlicensed = sorted.filter((p) => p.license === null && p.files.length === 0);
if (unlicensed.length > 0) {
  fail(`bundled package(s) with no license field and no license file:\n  ${unlicensed.map((p) => `${p.name}@${p.version} (${relative(ROOT, p.dir)})`).join('\n  ')}`);
}

const lines = [];
lines.push(`Third-party notices for jevcode ${rootPkg.version}`);
lines.push('');
lines.push('dist/jevcode.mjs is a single-file bundle that inlines the packages listed below (the only');
lines.push('runtime dependencies are ink and react; the rest is their dependency tree). The bundler strips');
lines.push("license comments from the output (esbuild legalComments: 'none'), so this file carries the");
lines.push('attributions. Each entry gives the package name, version, the SPDX license expression from its');
lines.push('package.json and, when the package ships one, the full text of its license file.');
lines.push('');
lines.push(`Packages: ${sorted.length}`);
for (const p of sorted) lines.push(`  ${p.name}@${p.version}  ${p.license ?? '(see license file)'}`);
lines.push('');
for (const p of sorted) {
  lines.push('='.repeat(78));
  lines.push(`${p.name}@${p.version}`);
  lines.push(`License: ${p.license ?? '(not declared in package.json; see the license text below)'}`);
  if (p.homepage) lines.push(`Homepage: ${p.homepage}`);
  if (p.repository) lines.push(`Repository: ${p.repository}`);
  lines.push('='.repeat(78));
  if (p.files.length === 0) {
    lines.push(`(The package ships no license file; it is licensed under ${p.license} per its package.json.)`);
  } else {
    for (const f of p.files) {
      if (p.files.length > 1) lines.push(`--- ${f} ---`);
      lines.push(readFileSync(join(p.dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd());
    }
  }
  lines.push('');
}
const text = lines.join('\n') + '\n';

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (current !== text) fail(`${relative(ROOT, OUT)} is stale or missing; run \`node scripts/licenses.mjs\``);
  console.log(`licenses: ${relative(ROOT, OUT)} up to date (${sorted.length} packages)`);
} else {
  writeFileSync(OUT, text);
  const withFile = sorted.filter((p) => p.files.length > 0).length;
  console.log(`licenses: ${relative(ROOT, OUT)} written: ${sorted.length} packages (${withFile} with a license file, ${sorted.length - withFile} field-only), ${Buffer.byteLength(text)} bytes`);
}
