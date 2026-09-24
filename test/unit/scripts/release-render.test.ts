/**
 * scripts/release/render-packaging.mjs against the real Formula/jevcode.rb and packaging/aur/PKGBUILD: the anchor
 * lines the packaging files and the renderer share, the REPO-ONLY block, and the failure on a missing anchor.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release', 'render-packaging.mjs');
const FORMULA = join(ROOT, 'Formula', 'jevcode.rb');
const PKGBUILD = join(ROOT, 'packaging', 'aur', 'PKGBUILD');
const SHA = 'a'.repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function render(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function tmpFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-render-'));
  dirs.push(dir);
  const path = join(dir, 'in');
  writeFileSync(path, text);
  return path;
}

const count = (text: string, re: RegExp): number => text.split('\n').filter((l) => re.test(l)).length;

describe('the shared anchor lines in the canonical packaging files', () => {
  it('Formula/jevcode.rb has one url and one sha256 anchor and a REPO-ONLY block', () => {
    const t = readFileSync(FORMULA, 'utf8');
    expect(count(t, /^ {2}url "[^"]*"/)).toBe(1);
    expect(count(t, /^ {2}sha256 "[^"]*"/)).toBe(1);
    expect(count(t, /^# BEGIN-REPO-ONLY$/)).toBe(1);
    expect(count(t, /^# END-REPO-ONLY$/)).toBe(1);
  });

  it('packaging/aur/PKGBUILD has one of each anchor and a REPO-ONLY block', () => {
    const t = readFileSync(PKGBUILD, 'utf8');
    for (const re of [/^_npmver=/, /^pkgver=/, /^pkgrel=/, /^sha256sums=\('[^']*'\)$/, /^# Maintainer:/, /^# BEGIN-REPO-ONLY$/, /^# END-REPO-ONLY$/]) {
      expect(count(t, re), re.source).toBe(1);
    }
  });
});

describe('render-packaging.mjs formula', () => {
  it('replaces exactly the url and sha256 lines and drops the REPO-ONLY block', () => {
    const r = render(['formula', '--version', '0.6.0', '--sha256', SHA]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(count(r.out, /^ {2}url "https:\/\/registry\.npmjs\.org\/jevcode\/-\/jevcode-0\.6\.0\.tgz"$/)).toBe(1);
    expect(count(r.out, new RegExp(`^ {2}sha256 "${SHA}"$`))).toBe(1);
    expect(r.out).not.toMatch(/REPO-ONLY|PLACEHOLDER|0\.0\.0/);
    // everything else is the template minus the block
    const template = readFileSync(FORMULA, 'utf8').split('\n');
    const kept = template.slice(template.indexOf('# END-REPO-ONLY') + 1);
    const out = r.out.split('\n');
    expect(out).toHaveLength(kept.length);
    expect(out.filter((l, i) => l !== kept[i])).toHaveLength(2);
    expect(r.out).toContain('class Jevcode < Formula');
  });

  it('takes a file:// url for the PR dry run', () => {
    const r = render(['formula', '--version', '0.6.0', '--sha256', SHA, '--url', 'file:///tmp/x/jevcode-0.6.0.tgz']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  url "file:///tmp/x/jevcode-0.6.0.tgz"\n');
  });

  it('rejects a bad sha, a bad version and a url with a quote', () => {
    expect(render(['formula', '--version', '0.6.0', '--sha256', 'A'.repeat(64)]).code).toBe(1);
    expect(render(['formula', '--version', 'v0.6.0', '--sha256', SHA]).code).toBe(1);
    expect(render(['formula', '--version', '0.6.0', '--sha256', SHA, '--url', 'https://x/"a']).code).toBe(1);
  });

  it('exits 1 naming a missing or duplicated anchor', () => {
    const missing = tmpFile('class X < Formula\n  sha256 "x"\nend\n');
    const r = render(['formula', '--version', '0.6.0', '--sha256', SHA, '--in', missing]);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/formula url: expected exactly one line .* found 0/);
    const twice = tmpFile('  url "a"\n  url "b"\n  sha256 "x"\n');
    expect(render(['formula', '--version', '0.6.0', '--sha256', SHA, '--in', twice]).err).toMatch(/formula url: .* found 2/);
    const open = tmpFile('# BEGIN-REPO-ONLY\n  url "a"\n  sha256 "x"\n');
    expect(render(['formula', '--version', '0.6.0', '--sha256', SHA, '--in', open]).err).toMatch(/BEGIN-REPO-ONLY without # END-REPO-ONLY/);
  });
});

describe('render-packaging.mjs pkgbuild', () => {
  it('sets _npmver, pkgver (no "-"), pkgrel and sha256sums and drops the REPO-ONLY block', () => {
    const r = render(['pkgbuild', '--version', '0.7.0-rc.1', '--sha256', SHA, '--pkgrel', '3']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(count(r.out, /^_npmver=0\.7\.0-rc\.1$/)).toBe(1);
    expect(count(r.out, /^pkgver=0\.7\.0_rc\.1$/)).toBe(1);
    expect(count(r.out, /^pkgrel=3$/)).toBe(1);
    expect(count(r.out, new RegExp(`^sha256sums=\\('${SHA}'\\)$`))).toBe(1);
    expect(r.out).not.toMatch(/REPO-ONLY|PLACEHOLDER|0\.0\.0|0{64}/);
    expect(r.out).toContain('package() {');
  });

  it('pkgrel defaults to 1; the Maintainer line comes from --maintainer, else AUR_MAINTAINER, else the template', () => {
    const template = readFileSync(PKGBUILD, 'utf8').split('\n').find((l) => l.startsWith('# Maintainer:'));
    const plain = render(['pkgbuild', '--version', '0.6.0', '--sha256', SHA]);
    expect(count(plain.out, /^pkgrel=1$/)).toBe(1);
    expect(plain.out).toContain(`${template}\n`);
    const fromEnv = render(['pkgbuild', '--version', '0.6.0', '--sha256', SHA], { AUR_MAINTAINER: 'Some One <some at example dot com>' });
    expect(fromEnv.out).toMatch(/^# Maintainer: Some One <some at example dot com>$/m);
    const fromFlag = render(['pkgbuild', '--version', '0.6.0', '--sha256', SHA, '--maintainer', 'Flag <f>'], { AUR_MAINTAINER: 'Env <e>' });
    expect(fromFlag.out).toMatch(/^# Maintainer: Flag <f>$/m);
    expect(render(['pkgbuild', '--version', '0.6.0', '--sha256', SHA, '--maintainer', 'a\nb']).code).toBe(1);
  });

  it('exits 1 naming a missing anchor and rejects a bad pkgrel', () => {
    const template = readFileSync(PKGBUILD, 'utf8');
    const r = render(['pkgbuild', '--version', '0.6.0', '--sha256', SHA, '--in', tmpFile(template.replace(/^pkgrel=.*$/m, ''))]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/PKGBUILD pkgrel: expected exactly one line .* found 0/);
    expect(render(['pkgbuild', '--version', '0.6.0', '--sha256', SHA, '--pkgrel', '0']).code).toBe(1);
  });
});
