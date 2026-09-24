/**
 * scripts/release/changelog.mjs: `promote` rewrites the release heading (the real `## [V] — DATE (not yet
 * published)` shape, or `## [Unreleased]`) and is idempotent; `notes` prints one section plus the install footer.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'release', 'changelog.mjs');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function file(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-changelog-'));
  dirs.push(dir);
  const path = join(dir, 'CHANGELOG.md');
  writeFileSync(path, text);
  return path;
}

function cli(...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const REAL = `# Changelog

Preamble.

## [0.6.0] — 2026-09-22 (not yet published)

Round 5.

### Changed

- one
- two

## [0.5.0] — 2026-09-22 (not yet published)

- older
`;

describe('changelog.mjs promote', () => {
  it('rewrites the real heading shape and touches nothing else', () => {
    const path = file(REAL);
    const r = cli('promote', '0.6.0', '--date', '2026-09-23', '--file', path);
    expect(r.code).toBe(0);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(REAL.replace('## [0.6.0] — 2026-09-22 (not yet published)', '## [0.6.0] — 2026-09-23'));
    // the older section keeps its marker
    expect(after).toContain('## [0.5.0] — 2026-09-22 (not yet published)');
  });

  it('is a no-op on an already promoted heading', () => {
    const path = file(REAL.replace('## [0.6.0] — 2026-09-22 (not yet published)', '## [0.6.0] — 2026-09-23'));
    const before = readFileSync(path, 'utf8');
    const r = cli('promote', '0.6.0', '--date', '2026-10-01', '--file', path);
    expect(r.code).toBe(0);
    expect(r.err).toContain('already promoted');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('promotes `## [Unreleased]` when there is no section for the version, then re-promotes as a no-op', () => {
    const path = file('# Changelog\n\n## [Unreleased]\n\n- new\n\n## [0.6.0] — 2026-09-23\n\n- old\n');
    expect(cli('promote', '0.7.0', '--date', '2026-10-02', '--file', path).code).toBe(0);
    const once = readFileSync(path, 'utf8');
    expect(once).toBe('# Changelog\n\n## [0.7.0] — 2026-10-02\n\n- new\n\n## [0.6.0] — 2026-09-23\n\n- old\n');
    expect(cli('promote', '0.7.0', '--date', '2026-10-05', '--file', path).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(once);
  });

  it('accepts `## V` and `## [V] — (not yet published)` headings', () => {
    const bare = file('## 0.7.0\n\n- x\n');
    expect(cli('promote', '0.7.0', '--date', '2026-10-02', '--file', bare).code).toBe(0);
    expect(readFileSync(bare, 'utf8')).toBe('## [0.7.0] — 2026-10-02\n\n- x\n');
    const pending = file('## [0.7.0-rc.1] — (not yet published)\n\n- x\n');
    expect(cli('promote', '0.7.0-rc.1', '--date', '2026-10-02', '--file', pending).code).toBe(0);
    expect(readFileSync(pending, 'utf8')).toBe('## [0.7.0-rc.1] — 2026-10-02\n\n- x\n');
  });

  it('fails with instructions when neither the version nor Unreleased has a section', () => {
    const path = file(REAL);
    const r = cli('promote', '0.9.0', '--file', path);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^::error::.*neither a "## \[0\.9\.0\]" nor a "## \[Unreleased\]" section; add/);
    expect(readFileSync(path, 'utf8')).toBe(REAL);
  });
});

describe('changelog.mjs notes', () => {
  it('prints the body up to the next `## ` heading, then the install footer', () => {
    const r = cli('notes', '0.6.0', '--file', file(REAL));
    expect(r.code).toBe(0);
    expect(r.out.startsWith('Round 5.\n\n### Changed\n\n- one\n- two\n\n---\n')).toBe(true);
    expect(r.out).not.toContain('older');
    expect(r.out).toContain('npm i -g jevcode@0.6.0');
    expect(r.out).toContain('brew install coasty-ai/jevcode/jevcode');
    expect(r.out).toContain('yay -S jevcode');
  });

  it('a prerelease footer names npm only', () => {
    const r = cli('notes', '0.7.0-rc.1', '--file', file('## [0.7.0-rc.1] — 2026-10-02\n\n- rc\n'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('npm i -g jevcode@0.7.0-rc.1');
    expect(r.out).not.toContain('brew');
    expect(r.out).not.toContain('yay');
  });

  it('fails on an empty or missing section', () => {
    expect(cli('notes', '0.7.0', '--file', file('## [0.7.0] — 2026-10-02\n\n## [0.6.0] — 2026-09-23\n\n- x\n')).err).toMatch(/section is empty/);
    expect(cli('notes', '0.8.0', '--file', file(REAL)).code).toBe(1);
  });

  it('reads the real CHANGELOG.md for the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const r = cli('notes', pkg.version);
    expect(r.err).toBe('');
    expect(r.out.length).toBeGreaterThan(200);
  });
});
