#!/usr/bin/env node
// Render the canonical Homebrew formula or AUR PKGBUILD for one release. Output goes to stdout.
//
//   node scripts/release/render-packaging.mjs formula  --version V --sha256 H [--url U] [--in Formula/jevcode.rb]
//   node scripts/release/render-packaging.mjs pkgbuild --version V --sha256 H [--pkgrel N] [--maintainer M] [--in packaging/aur/PKGBUILD]
//
// Anchors (each must occur exactly once outside the REPO-ONLY block):
//   formula:  ^  url "…"   ^  sha256 "…"          (anything after the closing quote is dropped)
//   pkgbuild: ^_npmver=  ^pkgver=  ^pkgrel=  ^sha256sums=('…')$
// Every line from `# BEGIN-REPO-ONLY` through `# END-REPO-ONLY` is removed. The PKGBUILD `# Maintainer:` line is
// replaced by --maintainer, else by a non-empty AUR_MAINTAINER env value, else kept.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;

class RenderError extends Error {}
const fail = (msg) => {
  throw new RenderError(msg);
};

/** drop every `# BEGIN-REPO-ONLY` … `# END-REPO-ONLY` block, markers included */
export function stripRepoOnly(text) {
  const out = [];
  let inside = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '# BEGIN-REPO-ONLY') {
      if (inside) fail('nested # BEGIN-REPO-ONLY');
      inside = true;
    } else if (t === '# END-REPO-ONLY') {
      if (!inside) fail('# END-REPO-ONLY without # BEGIN-REPO-ONLY');
      inside = false;
    } else if (!inside) out.push(line);
  }
  if (inside) fail('# BEGIN-REPO-ONLY without # END-REPO-ONLY');
  return out;
}

/** replace the single line matching `re` with `line`; fails naming the anchor when it is missing or repeated */
function replaceOne(lines, re, line, label) {
  const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
  if (hits.length !== 1) fail(`${label}: expected exactly one line matching ${re.source}, found ${hits.length}`);
  lines[hits[0]] = line;
}

export function renderFormula(template, { version, sha256, url }) {
  const lines = stripRepoOnly(template);
  const u = url || `https://registry.npmjs.org/jevcode/-/jevcode-${version}.tgz`;
  replaceOne(lines, /^ {2}url "[^"]*"/, `  url "${u}"`, 'formula url');
  replaceOne(lines, /^ {2}sha256 "[^"]*"/, `  sha256 "${sha256}"`, 'formula sha256');
  return lines.join('\n');
}

export function renderPkgbuild(template, { version, sha256, pkgrel = '1', maintainer = '' }) {
  const lines = stripRepoOnly(template);
  replaceOne(lines, /^_npmver=/, `_npmver=${version}`, 'PKGBUILD _npmver');
  replaceOne(lines, /^pkgver=/, `pkgver=${version.replaceAll('-', '_')}`, 'PKGBUILD pkgver');
  replaceOne(lines, /^pkgrel=/, `pkgrel=${pkgrel}`, 'PKGBUILD pkgrel');
  replaceOne(lines, /^sha256sums=\('[^']*'\)$/, `sha256sums=('${sha256}')`, 'PKGBUILD sha256sums');
  if (maintainer !== '') replaceOne(lines, /^# Maintainer:/, `# Maintainer: ${maintainer}`, 'PKGBUILD Maintainer');
  return lines.join('\n');
}

function parseArgs(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k.startsWith('--') || !allowed.includes(k.slice(2))) fail(`unexpected argument ${JSON.stringify(k)}`);
    if (v === undefined) fail(`${k} needs a value`);
    out[k.slice(2)] = v;
  }
  return out;
}

function main(argv) {
  const [kind, ...rest] = argv;
  if (kind !== 'formula' && kind !== 'pkgbuild') fail('usage: render-packaging.mjs formula|pkgbuild --version V --sha256 H [...]');
  const a = parseArgs(rest, kind === 'formula' ? ['version', 'sha256', 'url', 'in'] : ['version', 'sha256', 'pkgrel', 'maintainer', 'in']);
  const version = a['version'] ?? '';
  const sha256 = a['sha256'] ?? '';
  if (!SEMVER_RE.test(version)) fail(`--version must be x.y.z or x.y.z-pre; got ${JSON.stringify(version)}`);
  if (!SHA_RE.test(sha256)) fail('--sha256 must be 64 lowercase hex characters');
  let text;
  if (kind === 'formula') {
    const url = a['url'] ?? '';
    if (url !== '' && !/^(https|file):\/\/[^\s"\\]+$/.test(url)) fail(`--url must be an https:// or file:// url without quotes or spaces; got ${JSON.stringify(url)}`);
    text = renderFormula(readFileSync(a['in'] ?? join(ROOT, 'Formula', 'jevcode.rb'), 'utf8'), { version, sha256, url });
  } else {
    const pkgrel = a['pkgrel'] ?? '1';
    if (!/^[1-9]\d{0,3}$/.test(pkgrel)) fail(`--pkgrel must be a positive integer; got ${JSON.stringify(pkgrel)}`);
    const maintainer = (a['maintainer'] ?? process.env['AUR_MAINTAINER'] ?? '').trim();
    if (maintainer.length > 200 || /[\u0000-\u001f\u007f]/.test(maintainer)) fail('the maintainer must be one line of at most 200 characters');
    text = renderPkgbuild(readFileSync(a['in'] ?? join(ROOT, 'packaging', 'aur', 'PKGBUILD'), 'utf8'), { version, sha256, pkgrel, maintainer });
  }
  process.stdout.write(text);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof RenderError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`::error::render-packaging: ${msg.replace(/\r?\n/g, ' ')}\n`);
    process.exit(1);
  }
}
