/**
 * scripts/release/version.mjs: the bump table (npm semantics), input validation for prepare-release, and the
 * release.yml `validate` check. The CLI runs as a subprocess against a scratch git repository (RELEASE_ROOT) and
 * a local HTTP registry (NPM_REGISTRY), so nothing reaches the network.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'release', 'version.mjs');

/** what the fake registry answers for GET /@coasty%2fjevcode (the scoped packument, slash encoded); null = 404 */
let packument: unknown = null;
/** the query string and the raw path of the last registry request */
let lastQuery = '';
let lastPath = '';
let server: Server;
let registry = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    lastQuery = new URL(req.url ?? '/', 'http://x').search;
    lastPath = (req.url ?? '/').split('?')[0] ?? '';
    // exactly the path npm itself requests; `/@coasty/jevcode` or the unscoped `/jevcode` would 404 here
    if (lastPath === '/@coasty%2fjevcode' && packument !== null) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(packument));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const roots: string[] = [];
afterEach(() => {
  packument = null;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/** a scratch repo with package.json at `version` and a CHANGELOG, committed on main */
function repo(version: string, changelog: string): string {
  const root = mkdtempSync(join(tmpdir(), 'release-version-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@coasty/jevcode', version }, null, 2)}\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env['PATH'] ?? '', NPM_REGISTRY: registry, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, out: stdout, err: stderr });
    });
  });
}

/** `key=value` lines as a map */
const outputs = (s: string): Record<string, string> => Object.fromEntries(s.trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const PROMOTED = '# Changelog\n\n## [0.6.0] — 2026-09-23\n\n- a change\n';
const UNPROMOTED = '# Changelog\n\n## [0.6.0] — 2026-09-22 (not yet published)\n\n- a change\n';

describe('version.mjs next: the bump table', () => {
  const cases: Array<[string, string, string, string]> = [
    ['0.6.0', 'current', 'rc', '0.6.0'],
    ['0.6.0', 'patch', 'rc', '0.6.1'],
    ['0.6.0', 'minor', 'rc', '0.7.0'],
    ['0.6.0', 'major', 'rc', '1.0.0'],
    ['0.6.0', 'prepatch', 'rc', '0.6.1-rc.0'],
    ['0.6.0', 'preminor', 'rc', '0.7.0-rc.0'],
    ['0.6.0', 'premajor', 'beta', '1.0.0-beta.0'],
    ['0.6.0', 'prerelease', 'rc', '0.6.1-rc.0'],
    ['0.7.0-rc.1', 'prerelease', 'rc', '0.7.0-rc.2'],
    ['0.7.0-alpha.1', 'prerelease', 'beta', '0.7.0-beta.0'],
    ['0.7.0-rc.1', 'patch', 'rc', '0.7.0'],
    ['0.7.0-rc.1', 'minor', 'rc', '0.7.0'],
    ['0.7.1-rc.1', 'minor', 'rc', '0.8.0'],
    ['1.0.0-rc.3', 'major', 'rc', '1.0.0'],
    ['0.7.0-rc.1', 'prepatch', 'rc', '0.7.1-rc.0'],
  ];
  it.each(cases)('%s + %s (preid %s) = %s', async (from, kind, preid, want) => {
    const root = repo(from, PROMOTED);
    const r = await run(['next', '--bump', kind, '--version', '', '--preid', preid], { RELEASE_ROOT: root });
    expect(r.err).not.toContain('::error::');
    expect(r.code).toBe(0);
    const o = outputs(r.out);
    expect(o['version']).toBe(want);
    expect(o['prerelease']).toBe(String(want.includes('-')));
    expect(o['dist_tag']).toBe(want.includes('-') ? 'next' : 'latest');
  });

  it('an explicit version overrides the bump', async () => {
    const root = repo('0.6.0', PROMOTED);
    const r = await run(['next', '--bump', 'patch', '--version', '0.9.0-rc.1', '--preid', 'rc'], { RELEASE_ROOT: root });
    expect(r.code).toBe(0);
    expect(outputs(r.out)['version']).toBe('0.9.0-rc.1');
  });
});

describe('version.mjs next: rejects bad input with one ::error:: line', () => {
  const bad: Array<[string, string[]]> = [
    ['shell in the version', ['--bump', 'current', '--version', '1.2.3;rm -rf', '--preid', 'rc']],
    ['command substitution', ['--bump', 'current', '--version', '$(x)', '--preid', 'rc']],
    ['a leading v', ['--bump', 'current', '--version', 'v1.2.3', '--preid', 'rc']],
    ['empty version and a bad bump', ['--bump', 'sideways', '--version', '', '--preid', 'rc']],
    ['a bad preid', ['--bump', 'prerelease', '--version', '', '--preid', 'RC;x']],
    ['a version below package.json', ['--bump', 'current', '--version', '0.5.9', '--preid', 'rc']],
  ];
  it.each(bad)('%s', async (_name, args) => {
    const root = repo('0.6.0', PROMOTED);
    const r = await run(['next', ...args], { RELEASE_ROOT: root });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(/^::error::/);
  });

  it('fails when the tag exists locally or on origin, or the registry has the version', async () => {
    const root = repo('0.6.0', PROMOTED);
    git(root, 'tag', 'v0.6.0');
    expect((await run(['next', '--bump', 'current', '--version', '', '--preid', 'rc'], { RELEASE_ROOT: root })).err).toMatch(/v0\.6\.0 already exists locally/);

    const origin = mkdtempSync(join(tmpdir(), 'release-origin-'));
    roots.push(origin);
    git(origin, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '-q', 'origin', 'v0.6.0');
    git(root, 'tag', '-d', 'v0.6.0');
    expect((await run(['next', '--bump', 'current', '--version', '', '--preid', 'rc'], { RELEASE_ROOT: root })).err).toMatch(/v0\.6\.0 already exists on origin/);

    packument = { 'dist-tags': { latest: '0.6.1' }, versions: { '0.6.1': {} } };
    const r = await run(['next', '--bump', 'patch', '--version', '', '--preid', 'rc'], { RELEASE_ROOT: root });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/@coasty\/jevcode@0\.6\.1 is already on the npm registry/);
  });
});

describe('version.mjs check: the release.yml validate job', () => {
  const env = (root: string, extra: Record<string, string> = {}): Record<string, string> => ({
    RELEASE_ROOT: root,
    REF_TYPE: 'tag',
    REF_NAME: 'v0.6.0',
    PACKAGING_REF: '',
    MAIN_REF: 'main',
    GITHUB_SHA: 'HEAD',
    ...extra,
  });

  it('a good tag prints every output', async () => {
    const root = repo('0.6.0', PROMOTED);
    const r = await run(['check'], env(root));
    expect(r.err).not.toContain('::error::');
    expect(r.code).toBe(0);
    expect(outputs(r.out)).toEqual({ version: '0.6.0', dist_tag: 'latest', prerelease: 'false', is_latest: 'true', packaging_ref: 'v0.6.0' });
  });

  it('dist_tag is backport below the registry latest and next for a prerelease; packaging_ref passes through', async () => {
    const root = repo('0.6.0', PROMOTED);
    packument = { 'dist-tags': { latest: '0.7.0' }, versions: { '0.7.0': {} } };
    const back = outputs((await run(['check'], env(root, { PACKAGING_REF: 'main' }))).out);
    expect(back).toMatchObject({ dist_tag: 'backport', is_latest: 'false', packaging_ref: 'main' });

    const pre = repo('0.8.0-rc.1', '## [0.8.0-rc.1] — 2026-09-23\n\n- rc\n');
    const o = outputs((await run(['check'], env(pre, { REF_NAME: 'v0.8.0-rc.1' }))).out);
    expect(o).toMatchObject({ version: '0.8.0-rc.1', dist_tag: 'next', prerelease: 'true', is_latest: 'false' });

    // an older pre-release does not take `next` back from a newer one
    packument = { 'dist-tags': { latest: '0.7.0', next: '0.8.0-rc.2' }, versions: { '0.7.0': {}, '0.8.0-rc.2': {} } };
    const old = outputs((await run(['check'], env(pre, { REF_NAME: 'v0.8.0-rc.1' }))).out);
    expect(old).toMatchObject({ dist_tag: 'backport', prerelease: 'true', is_latest: 'false' });
    // the uncached read: the CDN caches the plain packument URL, 404s included
    expect(lastQuery).toBe('?write=true');
    // the scoped package's packument, its slash encoded
    expect(lastPath).toBe('/@coasty%2fjevcode');
  });

  it('warns in the job summary when packaging_ref is not the tag', async () => {
    const root = repo('0.6.0', PROMOTED);
    const summary = join(root, 'summary.md');
    const r = await run(['check'], env(root, { PACKAGING_REF: 'main', GITHUB_STEP_SUMMARY: summary }));
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/::warning::packaging_ref=main/);
    expect(readFileSync(summary, 'utf8')).toMatch(/run Formula\/, packaging\/ and scripts\/release\/ from main, not from v0\.6\.0/);
    const same = await run(['check'], env(root, { PACKAGING_REF: 'v0.6.0' }));
    expect(same.err).not.toMatch(/::warning::/);
  });

  const failing: Array<[string, string, Record<string, string>, RegExp]> = [
    ['tag and package.json differ', PROMOTED, { REF_NAME: 'v0.6.1' }, /does not match package\.json version 0\.6\.0/],
    ['a branch ref', PROMOTED, { REF_TYPE: 'branch', REF_NAME: 'main' }, /must run on a tag ref/],
    ['a tag that is not semver', PROMOTED, { REF_NAME: 'v0.6' }, /is not v<semver>/],
    ['a bad packaging_ref', PROMOTED, { PACKAGING_REF: 'feature/x' }, /packaging_ref must be empty, main or a v<semver> tag/],
    ['the CHANGELOG still says not yet published', UNPROMOTED, {}, /still marks 0\.6\.0 "not yet published"/],
    ['no CHANGELOG section', '# Changelog\n\n## [0.5.0] — 2026-09-01\n\n- old\n', {}, /has no "## \[0\.6\.0\]" section/],
  ];
  it.each(failing)('fails: %s', async (_name, changelog, extra, message) => {
    const root = repo('0.6.0', changelog);
    const r = await run(['check'], env(root, extra));
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(message);
  });

  it('fails when the tagged commit is not on main', async () => {
    const root = repo('0.6.0', PROMOTED);
    git(root, 'checkout', '-q', '-b', 'side');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'off main');
    const r = await run(['check'], env(root));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is not on main/);
  });
});
