/**
 * TUI-DESIGN §17 items 5–6 / §19.0 `src/cli/upgrade.ts`: manager detection from the install path, the delegated
 * command per manager (never `npm update -g`), version comparison, the registry check with its 2 s timeout and
 * `--write-cache`, the dry-run print, `--method` validation and the exit codes 0 / 2 / 5 / 6.
 */
import { describe, expect, it } from 'vitest';
import { EXIT_MANAGER_FAILED, checkRegistry, commandUpgrade, compareVersions, detectPackageManager, updateCachePath, upgradeArgv, type UpgradeIo } from '../../../src/cli/upgrade.js';

function io(over: Partial<UpgradeIo> = {}): UpgradeIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {}, home: '/home/me', argv1: '/usr/local/lib/node_modules/jevcode/bin/jevcode.js', dryRun: true, current: '0.1.0', out, err, ...over };
}

const fetchJson = (status: number, body: unknown): typeof fetch => (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

describe('detectPackageManager / upgradeArgv (§17 item 5)', () => {
  it('detects brew, bun, pnpm, yarn, npx and defaults to npm', () => {
    expect(detectPackageManager('/opt/homebrew/Cellar/jevcode/0.1.0/libexec/bin/jevcode.js', {})).toBe('brew');
    expect(detectPackageManager('/Users/me/.bun/install/global/node_modules/jevcode/bin/jevcode.js', {})).toBe('bun');
    expect(detectPackageManager('/Users/me/Library/pnpm/global/5/node_modules/jevcode/bin/jevcode.js', {})).toBe('pnpm');
    expect(detectPackageManager('/Users/me/.yarn/bin/jevcode', {})).toBe('yarn');
    expect(detectPackageManager('/Users/me/.npm/_npx/abc/node_modules/jevcode/bin/jevcode.js', {})).toBe('npx');
    expect(detectPackageManager('/x/jevcode.js', { npm_command: 'exec' })).toBe('npx');
    expect(detectPackageManager('/usr/local/lib/node_modules/jevcode/bin/jevcode.js', {})).toBe('npm');
  });
  it('builds the install command per manager; npx has nothing to upgrade', () => {
    expect(upgradeArgv('npm', 'latest')).toEqual(['npm', 'install', '-g', 'jevcode@latest']);
    expect(upgradeArgv('npm', '1.2.3')).toEqual(['npm', 'install', '-g', 'jevcode@1.2.3']);
    expect(upgradeArgv('brew', 'latest')).toEqual(['brew', 'upgrade', 'jevcode']);
    expect(upgradeArgv('bun', 'next')).toEqual(['bun', 'install', '-g', 'jevcode@next']);
    expect(upgradeArgv('pnpm', 'latest')).toEqual(['pnpm', 'add', '-g', 'jevcode@latest']);
    expect(upgradeArgv('yarn', 'latest')).toEqual(['yarn', 'global', 'add', 'jevcode@latest']);
    expect(upgradeArgv('npx', 'latest')).toBeNull();
  });
  it('compareVersions orders releases and pre-releases', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('v1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('x', '1.0.0')).toBeNull();
  });
});

describe('checkRegistry (§17 item 5)', () => {
  it('reports a newer version, up to date, a bad status and an unreachable registry without throwing', async () => {
    const now = (): Date => new Date('2026-09-20T15:00:00.000Z');
    expect(await checkRegistry('latest', { fetch: fetchJson(200, { version: '0.2.0' }), now, current: '0.1.0' })).toEqual({ current: '0.1.0', latest: '0.2.0', tag: 'latest', newer: true, checkedAt: '2026-09-20T15:00:00.000Z', error: null });
    expect((await checkRegistry('latest', { fetch: fetchJson(200, { version: '0.1.0' }), current: '0.1.0' })).newer).toBe(false);
    expect((await checkRegistry('latest', { fetch: fetchJson(404, {}), current: '0.1.0' })).error).toBe('registry HTTP 404');
    const failing: typeof fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    }) as unknown as typeof fetch;
    expect((await checkRegistry('latest', { fetch: failing, current: '0.1.0' })).error).toMatch(/^registry unreachable: Error: getaddrinfo/);
  });
  it('the fetch carries a 2 s timeout signal', async () => {
    let seen: RequestInit | undefined;
    const f: typeof fetch = (async (_u: unknown, init?: RequestInit) => {
      seen = init;
      return { ok: true, status: 200, json: async () => ({ version: '0.1.0' }) };
    }) as unknown as typeof fetch;
    await checkRegistry('next', { fetch: f, current: '0.1.0' });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('commandUpgrade (§17 items 5–6)', () => {
  it('--check prints the verdict (exit 0) and writes the cache with --write-cache; an unreachable registry is exit 5', async () => {
    const writes: { path: string; text: string }[] = [];
    const i = io({ fetch: fetchJson(200, { version: '9.9.9' }), writeFile: async (path, text) => void writes.push({ path, text }), env: { XDG_CACHE_HOME: '/cache' } });
    expect(await commandUpgrade({ command: 'upgrade', check: true, writeCache: true }, i)).toBe(0);
    expect(i.out.join('')).toBe('jevcode 0.1.0 → 9.9.9 is available (latest); run jevcode upgrade\n');
    expect(writes[0]?.path).toBe('/cache/jevcode/update-check.json');
    expect(JSON.parse(writes[0]!.text)).toMatchObject({ current: '0.1.0', latest: '9.9.9', newer: true });
    expect(updateCachePath({}, '/home/me')).toBe('/home/me/.cache/jevcode/update-check.json');
    const same = io({ fetch: fetchJson(200, { version: '0.1.0' }) });
    expect(await commandUpgrade({ command: 'upgrade', check: true }, same)).toBe(0);
    expect(same.out.join('')).toBe('jevcode 0.1.0 is up to date (latest: 0.1.0)\n');
    const down: typeof fetch = (async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof fetch;
    const bad = io({ fetch: down });
    expect(await commandUpgrade({ command: 'upgrade', check: true }, bad)).toBe(5);
    expect(bad.err.join('')).toMatch(/^jevcode upgrade: registry unreachable/);
  });
  it('prints the delegated command (dry run) and respects --method; an unknown method is exit 2; npx has nothing to do', async () => {
    const i = io();
    expect(await commandUpgrade({ command: 'upgrade' }, i)).toBe(0);
    expect(i.out.join('')).toBe('upgrade via npm: npm install -g jevcode@latest\n');
    const brew = io({ argv1: '/opt/homebrew/Cellar/jevcode/0.1.0/libexec/bin/jevcode.js' });
    await commandUpgrade({ command: 'upgrade', upgradeTarget: 'next' }, brew);
    expect(brew.out.join('')).toBe('upgrade via brew: brew upgrade jevcode\n');
    const forced = io();
    await commandUpgrade({ command: 'upgrade', method: 'pnpm', upgradeTarget: '1.2.3' }, forced);
    expect(forced.out.join('')).toBe('upgrade via pnpm: pnpm add -g jevcode@1.2.3\n');
    const badMethod = io();
    expect(await commandUpgrade({ command: 'upgrade', method: 'apt' }, badMethod)).toBe(2);
    const npx = io({ argv1: '/Users/me/.npm/_npx/abc/node_modules/jevcode/bin/jevcode.js' });
    expect(await commandUpgrade({ command: 'upgrade' }, npx)).toBe(0);
    expect(npx.out.join('')).toMatch(/nothing installed to upgrade/);
  });
  it('runs the manager when not a dry run: a non-zero exit or a spawn error is exit 6', async () => {
    const ran: string[][] = [];
    const ok = io({
      dryRun: false,
      spawn: async (argv) => {
        ran.push([...argv]);
        return { exitCode: 0, error: null };
      },
    });
    expect(await commandUpgrade({ command: 'upgrade' }, ok)).toBe(0);
    expect(ran).toEqual([['npm', 'install', '-g', 'jevcode@latest']]);
    const failed = io({ dryRun: false, spawn: async () => ({ exitCode: 1, error: null }) });
    expect(await commandUpgrade({ command: 'upgrade' }, failed)).toBe(EXIT_MANAGER_FAILED);
    const missing = io({ dryRun: false, spawn: async () => ({ exitCode: null, error: 'spawn npm ENOENT' }) });
    expect(await commandUpgrade({ command: 'upgrade' }, missing)).toBe(6);
    expect(missing.err.join('')).toContain('could not run: spawn npm ENOENT');
  });
});
