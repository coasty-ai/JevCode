#!/usr/bin/env node
// Release version logic for .github/workflows/prepare-release.yml and release.yml. No dependencies.
//
//   node scripts/release/version.mjs next --bump B --version V --preid P   target version (prepare-release)
//   node scripts/release/version.mjs check                                 validate a tag run (release.yml validate)
//   node scripts/release/version.mjs compare A B                           prints -1, 0 or 1
//
// `next` and `check` print `key=value` lines for $GITHUB_OUTPUT on stdout. Any failure prints one `::error::`
// line on stderr and exits 1. Env for `check`: REF_TYPE, REF_NAME, PACKAGING_REF, GITHUB_SHA.
// NPM_REGISTRY overrides https://registry.npmjs.org (tests); MAIN_REF overrides origin/main.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSection, parseHeading } from './changelog.mjs';

const PKG_NAME = '@coasty/jevcode';
/** the packument path: the scope's slash encoded, as npm requests it */
const PKG_PATH = PKG_NAME.replace('/', '%2f');
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
export const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
export const PREID_RE = /^[a-z][a-z0-9]{0,15}$/;
export const BUMPS = ['current', 'patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease'];

class ReleaseError extends Error {}
const fail = (msg) => {
  throw new ReleaseError(msg);
};

/** `{major, minor, patch, pre}`; `pre` holds numbers for numeric identifiers. Null when not semver. */
export function parseSemver(s) {
  const m = SEMVER_RE.exec(String(s));
  if (m === null) return null;
  const pre = m[4] === undefined ? [] : m[4].slice(1).split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

function mustParse(s) {
  const v = parseSemver(s);
  if (v === null) fail(`not a semver version: ${JSON.stringify(s)}`);
  return v;
}

export function format(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length > 0 ? `-${v.pre.join('.')}` : ''}`;
}

/** semver precedence: -1, 0 or 1 */
export function compareSemver(a, b) {
  const x = mustParse(a);
  const y = mustParse(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = typeof p === 'number';
    const qn = typeof q === 'number';
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** npm's `inc('pre', preid)`: bump the last numeric identifier, then switch to `preid.0` unless already on preid */
function incPre(pre, preid) {
  let p = pre.slice();
  if (p.length === 0) p = [0];
  else {
    let i = p.length - 1;
    while (i >= 0 && typeof p[i] !== 'number') i -= 1;
    if (i >= 0) p[i] = p[i] + 1;
    else p.push(0);
  }
  if (p[0] !== preid || typeof p[1] !== 'number') p = [preid, 0];
  return p;
}

/** npm version semantics for each bump kind */
export function bump(current, kind, preid = 'rc') {
  const v = mustParse(current);
  const isPre = v.pre.length > 0;
  switch (kind) {
    case 'current':
      return format(v);
    case 'major':
      return isPre && v.minor === 0 && v.patch === 0 ? format({ ...v, pre: [] }) : format({ major: v.major + 1, minor: 0, patch: 0, pre: [] });
    case 'minor':
      return isPre && v.patch === 0 ? format({ ...v, pre: [] }) : format({ major: v.major, minor: v.minor + 1, patch: 0, pre: [] });
    case 'patch':
      return isPre ? format({ ...v, pre: [] }) : format({ ...v, patch: v.patch + 1, pre: [] });
    case 'premajor':
      return format({ major: v.major + 1, minor: 0, patch: 0, pre: [preid, 0] });
    case 'preminor':
      return format({ major: v.major, minor: v.minor + 1, patch: 0, pre: [preid, 0] });
    case 'prepatch':
      return format({ ...v, patch: v.patch + 1, pre: [preid, 0] });
    case 'prerelease':
      return isPre ? format({ ...v, pre: incPre(v.pre, preid) }) : format({ ...v, patch: v.patch + 1, pre: [preid, 0] });
    default:
      return fail(`unknown bump ${JSON.stringify(kind)}; expected one of ${BUMPS.join(', ')}`);
  }
}

const isPrerelease = (v) => mustParse(v).pre.length > 0;

const below = (version, held) => Boolean(held) && parseSemver(held) !== null && compareSemver(version, held) < 0;

/** `next` for a prerelease, `latest` for a stable one; `backport` when a newer version already holds that tag */
export function distTagFor(version, registryLatest, registryNext = '') {
  if (isPrerelease(version)) return below(version, registryNext) ? 'backport' : 'next';
  return below(version, registryLatest) ? 'backport' : 'latest';
}

function root() {
  return process.env['RELEASE_ROOT'] || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function pkgVersion() {
  return JSON.parse(readFileSync(join(root(), 'package.json'), 'utf8')).version;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: root(), encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** the unauthenticated packument, or null when the package does not exist. `?write=true` skips the CDN cache. */
async function packument() {
  const base = (process.env['NPM_REGISTRY'] || 'https://registry.npmjs.org').replace(/\/+$/, '');
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${base}/${PKG_PATH}?write=true`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return fail(`could not read ${base}/${PKG_PATH}: ${last}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument ${JSON.stringify(a)}`);
    const v = argv[i + 1];
    if (v === undefined) fail(`${a} needs a value`);
    out[a.slice(2)] = v;
    i += 1;
  }
  return out;
}

async function cmdNext(argv) {
  const a = parseArgs(argv);
  const kind = a['bump'] ?? 'current';
  const explicit = a['version'] ?? '';
  const preid = a['preid'] ?? 'rc';
  if (!BUMPS.includes(kind)) fail(`bump must be one of ${BUMPS.join(', ')}; got ${JSON.stringify(kind)}`);
  if (explicit !== '' && !SEMVER_RE.test(explicit)) fail(`version must be x.y.z or x.y.z-pre (no leading v); got ${JSON.stringify(explicit)}`);
  if (!PREID_RE.test(preid)) fail(`preid must match ${PREID_RE.source}; got ${JSON.stringify(preid)}`);
  const current = pkgVersion();
  const target = explicit !== '' ? explicit : bump(current, kind, preid);
  const cmp = compareSemver(target, current);
  const same = kind === 'current' || explicit === current;
  if (cmp < 0 || (cmp === 0 && !same)) fail(`target ${target} is not greater than package.json ${current}`);

  const tag = `v${target}`;
  if (git(['tag', '-l', tag]).out !== '') fail(`tag ${tag} already exists locally`);
  if (git(['remote', 'get-url', 'origin']).code === 0) {
    const r = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
    if (r.code !== 0) fail(`git ls-remote origin failed: ${r.err}`);
    if (r.out !== '') fail(`tag ${tag} already exists on origin`);
  }
  const doc = await packument();
  if (doc !== null && doc.versions && Object.hasOwn(doc.versions, target)) fail(`${PKG_NAME}@${target} is already on the npm registry`);
  const tags = doc?.['dist-tags'] ?? {};
  return { version: target, prerelease: String(isPrerelease(target)), dist_tag: distTagFor(target, tags.latest ?? '', tags.next ?? '') };
}

async function cmdCheck() {
  const env = process.env;
  const refType = env['REF_TYPE'] ?? '';
  const refName = env['REF_NAME'] ?? '';
  const packagingRef = env['PACKAGING_REF'] ?? '';
  if (refType !== 'tag') fail(`release.yml must run on a tag ref (got ${JSON.stringify(refType)} ${JSON.stringify(refName)}); dispatch it with "Use workflow from" → Tags`);
  if (!TAG_RE.test(refName)) fail(`tag ${JSON.stringify(refName)} is not v<semver>`);
  if (packagingRef !== '' && packagingRef !== 'main' && !TAG_RE.test(packagingRef)) fail(`packaging_ref must be empty, main or a v<semver> tag; got ${JSON.stringify(packagingRef)}`);
  const version = refName.slice(1);
  const pkg = pkgVersion();
  if (pkg !== version) fail(`tag ${refName} does not match package.json version ${pkg}`);

  const changelog = readFileSync(join(root(), 'CHANGELOG.md'), 'utf8');
  const section = findSection(changelog, version);
  if (section === null) fail(`CHANGELOG.md has no "## [${version}]" section`);
  if (/not yet published/i.test(parseHeading(section.heading)?.paren ?? '')) fail(`CHANGELOG.md still marks ${version} "not yet published"; run node scripts/release/changelog.mjs promote ${version}`);

  const mainRef = env['MAIN_REF'] || 'origin/main';
  const sha = env['GITHUB_SHA'] || 'HEAD';
  const anc = git(['merge-base', '--is-ancestor', `${sha}^{commit}`, mainRef]);
  if (anc.code === 1) fail(`${refName} (${sha}) is not on ${mainRef}; release only commits that are on main`);
  if (anc.code !== 0) fail(`git merge-base failed: ${anc.err}`);

  const doc = await packument();
  const tags = doc?.['dist-tags'] ?? {};
  const distTag = distTagFor(version, tags.latest ?? '', tags.next ?? '');
  if (packagingRef !== '' && packagingRef !== refName) {
    // the channel jobs will run this ref's scripts with the channel secrets; the approver should see that
    const msg = `packaging_ref=${packagingRef}: the Homebrew and AUR jobs run Formula/, packaging/ and scripts/release/ from ${packagingRef}, not from ${refName}`;
    process.stderr.write(`::warning::${msg}\n`);
    if (env['GITHUB_STEP_SUMMARY']) appendFileSync(env['GITHUB_STEP_SUMMARY'], `> [!WARNING]\n> ${msg}. Approve only if you expect that.\n`);
  }
  return {
    version,
    dist_tag: distTag,
    prerelease: String(isPrerelease(version)),
    is_latest: String(distTag === 'latest'),
    packaging_ref: packagingRef === '' ? refName : packagingRef,
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  let out;
  if (cmd === 'next') out = await cmdNext(rest);
  else if (cmd === 'check') out = await cmdCheck();
  else if (cmd === 'compare') {
    if (rest.length !== 2) fail('usage: version.mjs compare A B');
    process.stdout.write(`${compareSemver(rest[0], rest[1])}\n`);
    return;
  } else fail('usage: version.mjs next|check|compare');
  for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}=${v}\n`);
  process.stderr.write(`release: ${Object.entries(out).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    const msg = e instanceof ReleaseError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`::error::${msg.replace(/\r?\n/g, ' ')}\n`);
    process.exit(1);
  });
}
