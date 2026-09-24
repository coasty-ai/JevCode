/**
 * D11 `src/cli/upgrade.ts`: an install that nix, pacman (AUR) or mise owns is detected from the resolved install path
 * and gets that manager's command printed (exit 0, nothing spawned); every earlier kind keeps its detection, argv and
 * output byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { commandUpgrade, detectPackageManager, manualUpgrade, pacmanPackage, upgradeArgv, type UpgradeIo } from '../../../src/cli/upgrade.js';
import type { ParsedFlags } from '../../../src/cli/args.js';

const NIX = '/nix/store/0c3k9x1y2z-jevcode-0.6.0/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js';
const MISE = '/home/me/.local/share/mise/installs/npm-coasty-ai-jevcode/0.6.0/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js';
const AUR = '/usr/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js';
const PACMAN_DB = ['glibc-2.42+r3-1', 'jevcode-0.6.0-1', 'nodejs-24.8.0-1'];

function io(over: Partial<UpgradeIo> = {}): UpgradeIo & { out: string[]; err: string[]; spawned: string[][] } {
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[][] = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: {},
    home: '/home/me',
    argv1: '/usr/local/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js',
    dryRun: false,
    current: '0.6.0',
    pacmanDb: () => [],
    spawn: async (argv) => {
      spawned.push([...argv]);
      return { exitCode: 0, error: null };
    },
    out,
    err,
    spawned,
    ...over,
  };
}

const upgrade = (over: Partial<ParsedFlags> = {}): ParsedFlags => ({ command: 'upgrade', ...over });

describe('detectPackageManager: nix, aur and mise (D11)', () => {
  it('a nix store path is nix, whatever else the path contains', () => {
    expect(detectPackageManager(NIX, {}, () => [])).toBe('nix');
    expect(detectPackageManager('/nix/store/abc-jevcode-0.6.0/lib/node_modules/@coasty-ai/jevcode/node_modules/pnpm/x.js', {}, () => [])).toBe('nix');
  });
  it('a mise npm-backend install dir is mise, under the default data dir, a Windows path or MISE_DATA_DIR', () => {
    expect(detectPackageManager(MISE, {}, () => [])).toBe('mise');
    expect(detectPackageManager('C:\\Users\\me\\AppData\\Local\\mise\\installs\\npm-jevcode\\0.6.0\\node_modules\\@coasty-ai\\jevcode\\bin\\jevcode.js', {}, () => [])).toBe('mise');
    expect(detectPackageManager('/opt/tools/installs/npm-jevcode/0.6.0/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', { MISE_DATA_DIR: '/opt/tools/' }, () => [])).toBe('mise');
    expect(detectPackageManager('/opt/tools/installs/npm-jevcode/0.6.0/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('npm');
  });
  it('/usr/lib/node_modules/@coasty-ai/jevcode is aur only when pacman has a jevcode package; the db is read only for that path', () => {
    expect(detectPackageManager(AUR, {}, () => PACMAN_DB)).toBe('aur');
    expect(detectPackageManager(AUR, {}, () => ['jevcode-git-r120.1a2b3c4-1'])).toBe('aur');
    expect(detectPackageManager(AUR, {}, () => ['glibc-2.42+r3-1'])).toBe('npm');
    let reads = 0;
    const counting = (): readonly string[] => {
      reads++;
      return PACMAN_DB;
    };
    expect(detectPackageManager('/usr/local/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, counting)).toBe('npm');
    expect(detectPackageManager(NIX, {}, counting)).toBe('nix');
    expect(reads).toBe(0);
  });
  it('pacmanPackage reads <name>-<pkgver>-<pkgrel> entries and prefers the exact name', () => {
    expect(pacmanPackage(PACMAN_DB)).toBe('jevcode');
    expect(pacmanPackage(['jevcode-git-r120.1a2b3c4-1'])).toBe('jevcode-git');
    expect(pacmanPackage(['jevcode-git-r120.1a2b3c4-1', 'jevcode-0.6.0-1'])).toBe('jevcode');
    expect(pacmanPackage(['jevcodex-1.0-1', 'jevcode', 'glibc-2.42+r3-1'])).toBeNull();
  });
  it('npx still wins over the new kinds', () => {
    expect(detectPackageManager(NIX, { npm_command: 'exec' }, () => [])).toBe('npx');
  });
  it('the new kinds never produce an argv to spawn', () => {
    expect(upgradeArgv('nix', 'latest')).toBeNull();
    expect(upgradeArgv('aur', 'latest')).toBeNull();
    expect(upgradeArgv('mise', 'latest')).toBeNull();
  });
});

describe('commandUpgrade on nix, aur and mise installs prints the command and exits 0 (D11)', () => {
  it('nix: profile upgrade, nix run, and the config-managed note', async () => {
    const i = io({ argv1: NIX });
    expect(await commandUpgrade(upgrade(), i)).toBe(0);
    expect(i.spawned).toEqual([]);
    expect(i.err).toEqual([]);
    expect(i.out.join('')).toBe(
      `jevcode is installed through nix (${NIX}); jevcode upgrade does not change it. Upgrade with:\n` +
        '  nix profile upgrade JevCode       # a nix profile install\n' +
        '  nix run github:coasty-ai/JevCode  # run the newest main without installing\n' +
        'a NixOS, home-manager or nix-darwin install: update that flake input and rebuild\n',
    );
  });
  it('nix with a version points at its v tag; a dist-tag asks for a version', async () => {
    const v = io({ argv1: NIX });
    expect(await commandUpgrade(upgrade({ upgradeTarget: '0.7.0' }), v)).toBe(0);
    expect(v.out.join('')).toContain('  nix profile remove JevCode && nix profile install github:coasty-ai/JevCode/v0.7.0  # a nix profile install, moved to v0.7.0\n');
    expect(v.out.join('')).toContain('nix run github:coasty-ai/JevCode/v0.7.0');
    const next = manualUpgrade('nix', 'next');
    expect(next.rows[0]?.[0]).toBe('nix profile upgrade JevCode');
    expect(next.notes).toContain('next is an npm dist-tag; pass a version instead (jevcode upgrade <x.y.z>)');
  });
  it('aur: the AUR helper commands for the owning package, never npm', async () => {
    const i = io({ argv1: AUR, pacmanDb: () => PACMAN_DB });
    expect(await commandUpgrade(upgrade(), i)).toBe(0);
    expect(i.spawned).toEqual([]);
    expect(i.out.join('')).toBe(
      `jevcode is installed through pacman (package jevcode) (${AUR}); jevcode upgrade does not change it. Upgrade with:\n` +
        '  yay -Syu jevcode   # with yay\n' +
        '  paru -Syu jevcode  # with paru\n',
    );
    const git = io({ argv1: AUR, pacmanDb: () => ['jevcode-git-r120.1a2b3c4-1'], dryRun: true });
    expect(await commandUpgrade(upgrade({ upgradeTarget: 'next' }), git)).toBe(0);
    expect(git.out.join('')).toContain('  yay -Syu jevcode-git   # with yay\n');
    expect(git.out.join('')).toContain('the AUR package follows the latest stable release; next is not published there\n');
  });
  it('mise: mise upgrade npm:@coasty-ai/jevcode; a version pins it; a dist-tag asks for a version', async () => {
    const i = io({ argv1: MISE });
    expect(await commandUpgrade(upgrade(), i)).toBe(0);
    expect(i.spawned).toEqual([]);
    expect(i.out.join('')).toBe(`jevcode is installed through mise (${MISE}); jevcode upgrade does not change it. Upgrade with:\n` + '  mise upgrade npm:@coasty-ai/jevcode  # within the version your mise config allows\n');
    expect(manualUpgrade('mise', 'v0.7.0').rows).toEqual([['mise use -g npm:@coasty-ai/jevcode@0.7.0', 'pin v0.7.0']]);
    expect(manualUpgrade('mise', 'next').notes).toEqual(['next is an npm dist-tag; pass a version instead (jevcode upgrade <x.y.z>)']);
  });
  it('--method still forces a runnable manager over a detected nix/aur/mise install', async () => {
    const i = io({ argv1: NIX });
    expect(await commandUpgrade(upgrade({ method: 'npm' }), i)).toBe(0);
    expect(i.spawned).toEqual([['npm', 'install', '-g', '@coasty-ai/jevcode@latest']]);
    const bad = io({ argv1: NIX });
    expect(await commandUpgrade(upgrade({ method: 'nix' }), bad)).toBe(2);
    expect(bad.err.join('')).toBe('jevcode upgrade: --method expects npm|brew|bun|pnpm|yarn, got "nix"\n');
  });
});

describe('the scoped npm package @coasty-ai/jevcode: every install path it lands in', () => {
  it('mise: the scoped install dir in each plausible spelling, and the unscoped one, under the default data dir and MISE_DATA_DIR', () => {
    const lib = '0.6.0/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js';
    for (const dir of ['npm-coasty-ai-jevcode', 'npm-@coasty-ai-jevcode', 'npm-@coasty-ai/jevcode', 'npm-jevcode']) {
      expect(detectPackageManager(`/home/me/.local/share/mise/installs/${dir}/${lib}`, {}, () => []), dir).toBe('mise');
      expect(detectPackageManager(`/opt/tools/installs/${dir}/${lib}`, { MISE_DATA_DIR: '/opt/tools' }, () => []), dir).toBe('mise');
      expect(detectPackageManager(`/opt/tools/installs/${dir}/${lib}`, {}, () => []), `${dir} outside a mise dir`).toBe('npm');
    }
    expect(detectPackageManager('C:\\Users\\me\\AppData\\Local\\mise\\installs\\npm-coasty-ai-jevcode\\0.6.0\\node_modules\\@coasty-ai\\jevcode\\bin\\jevcode.js', {}, () => [])).toBe('mise');
    // another tool's install dir is not jevcode's
    for (const dir of ['npm-jevcodex', 'npm-other-ai-jevcode', 'npm-coasty-ai-jevcode-extra', 'npm-coasty-ai']) {
      expect(detectPackageManager(`/home/me/.local/share/mise/installs/${dir}/${lib}`, {}, () => []), dir).toBe('npm');
    }
  });
  it('aur: /usr/lib/node_modules/@coasty-ai/jevcode, and the unscoped path of a pre-scope build, with a pacman package', () => {
    expect(detectPackageManager('/usr/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => PACMAN_DB)).toBe('aur');
    expect(detectPackageManager('/usr/lib/node_modules/jevcode/bin/jevcode.js', {}, () => PACMAN_DB)).toBe('aur');
    expect(detectPackageManager('/usr/lib/node_modules/@other/jevcode/bin/jevcode.js', {}, () => PACMAN_DB)).toBe('npm');
    expect(detectPackageManager('/usr/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('npm');
  });
  it('npx cache, Homebrew libexec, bun, pnpm and yarn global dirs of the scoped package', () => {
    expect(detectPackageManager('/Users/me/.npm/_npx/0a1b2c3d/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('npx');
    expect(detectPackageManager('/opt/homebrew/Cellar/jevcode/0.6.0/libexec/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('brew');
    expect(detectPackageManager('/home/linuxbrew/.linuxbrew/Cellar/jevcode/0.6.0/libexec/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('brew');
    expect(detectPackageManager('/Users/me/.bun/install/global/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('bun');
    expect(detectPackageManager('/Users/me/Library/pnpm/global/5/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('pnpm');
    expect(detectPackageManager('/Users/me/.config/yarn/global/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('yarn');
    expect(detectPackageManager('/nix/store/abc-jevcode-0.6.0/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {}, () => [])).toBe('nix');
  });
  it('npm, bun, pnpm, yarn and mise name the scoped package; brew and pacman keep the name jevcode', () => {
    expect(upgradeArgv('npm', '0.7.0')).toEqual(['npm', 'install', '-g', '@coasty-ai/jevcode@0.7.0']);
    expect(upgradeArgv('bun', '0.7.0')).toEqual(['bun', 'install', '-g', '@coasty-ai/jevcode@0.7.0']);
    expect(upgradeArgv('pnpm', '0.7.0')).toEqual(['pnpm', 'add', '-g', '@coasty-ai/jevcode@0.7.0']);
    expect(upgradeArgv('yarn', '0.7.0')).toEqual(['yarn', 'global', 'add', '@coasty-ai/jevcode@0.7.0']);
    expect(upgradeArgv('brew', '0.7.0')).toEqual(['brew', 'upgrade', 'jevcode']);
    expect(manualUpgrade('mise', 'latest').rows).toEqual([['mise upgrade npm:@coasty-ai/jevcode', 'within the version your mise config allows']]);
    expect(manualUpgrade('aur', 'latest').rows[0]).toEqual(['yay -Syu jevcode', 'with yay']);
  });
});

describe('regression: the earlier kinds are unchanged (D11)', () => {
  const cases: { argv1: string; env?: NodeJS.ProcessEnv; manager: string; argv: string[] | null }[] = [
    { argv1: '/opt/homebrew/Cellar/jevcode/0.1.0/libexec/bin/jevcode.js', manager: 'brew', argv: ['brew', 'upgrade', 'jevcode'] },
    { argv1: '/home/linuxbrew/.linuxbrew/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', manager: 'brew', argv: ['brew', 'upgrade', 'jevcode'] },
    { argv1: '/Users/me/.bun/install/global/node_modules/@coasty-ai/jevcode/bin/jevcode.js', manager: 'bun', argv: ['bun', 'install', '-g', '@coasty-ai/jevcode@latest'] },
    { argv1: '/Users/me/Library/pnpm/global/5/node_modules/@coasty-ai/jevcode/bin/jevcode.js', manager: 'pnpm', argv: ['pnpm', 'add', '-g', '@coasty-ai/jevcode@latest'] },
    { argv1: '/Users/me/.yarn/bin/jevcode', manager: 'yarn', argv: ['yarn', 'global', 'add', '@coasty-ai/jevcode@latest'] },
    { argv1: '/usr/local/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', manager: 'npm', argv: ['npm', 'install', '-g', '@coasty-ai/jevcode@latest'] },
    // a plain `sudo npm i -g` on a distro whose npm prefix is /usr, with no pacman package
    { argv1: AUR, manager: 'npm', argv: ['npm', 'install', '-g', '@coasty-ai/jevcode@latest'] },
    { argv1: '/Users/me/.npm/_npx/abc/node_modules/@coasty-ai/jevcode/bin/jevcode.js', manager: 'npx', argv: null },
    { argv1: '/x/jevcode.js', env: { npm_command: 'exec' }, manager: 'npx', argv: null },
  ];
  it.each(cases)('$argv1 → $manager', async ({ argv1, env, manager, argv }) => {
    expect(detectPackageManager(argv1, env ?? {}, () => [])).toBe(manager);
    const i = io({ argv1, env: env ?? {} });
    expect(await commandUpgrade(upgrade(), i)).toBe(0);
    if (argv === null) {
      expect(i.spawned).toEqual([]);
      expect(i.out.join('')).toBe(`jevcode runs through npx here (${argv1}); there is nothing installed to upgrade — npx fetches the requested version each time\n`);
    } else {
      expect(i.spawned).toEqual([argv]);
      expect(i.out.join('')).toBe(`upgrade via ${manager}: ${argv.join(' ')}\n`);
    }
    expect(i.err).toEqual([]);
  });
  it('the two-argument call still works (the default pacman read never runs off /usr/lib/node_modules/@coasty-ai/jevcode)', () => {
    expect(detectPackageManager('/usr/local/lib/node_modules/@coasty-ai/jevcode/bin/jevcode.js', {})).toBe('npm');
    expect(detectPackageManager('/opt/homebrew/Cellar/jevcode/0.1.0/libexec/bin/jevcode.js', {})).toBe('brew');
  });
});
