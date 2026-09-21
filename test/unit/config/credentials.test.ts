/** config/credentials.ts (TUI-DESIGN §11.2; §19.0 row O7): merge + atomic 0600 write, XDG vs legacy, warn once, shadowing line. */
import { readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configDirs,
  credentialsPath,
  displayPath,
  isJevcodeConfigDir,
  jevcodeJsonWarning,
  keyEnteredText,
  savedText,
  shadowingText,
  legacyJevcodeDir,
  legacyWarning,
  readCredentialsFile,
  removeCredentials,
  shadowingLine,
  writeConfigValue,
  writeCredentials,
  xdgConfigHome,
  xdgJevcodeDir,
} from '../../../src/config/credentials.js';
import { fingerprint } from '../../../src/core/hash.js';
import { ConfigError } from '../../../src/errors.js';

let dir: string;
let home: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-cred-'));
  home = join(dir, 'home');
  cwd = join(dir, 'ws');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
const OR_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

describe('paths (pure)', () => {
  it('XDG_CONFIG_HOME wins when absolute; relative or empty falls back to ~/.config; legacy is ~/.config/jevcode', () => {
    expect(xdgConfigHome({}, '/home/u')).toBe('/home/u/.config');
    expect(xdgConfigHome({ XDG_CONFIG_HOME: '/tmp/x' }, '/home/u')).toBe('/tmp/x');
    expect(xdgConfigHome({ XDG_CONFIG_HOME: 'relative' }, '/home/u')).toBe('/home/u/.config');
    expect(xdgConfigHome({ XDG_CONFIG_HOME: '  ' }, '/home/u')).toBe('/home/u/.config');
    expect(xdgJevcodeDir({ XDG_CONFIG_HOME: '/tmp/x' }, '/home/u')).toBe('/tmp/x/jevcode');
    expect(legacyJevcodeDir('/home/u')).toBe('/home/u/.config/jevcode');
    expect(configDirs({}, '/home/u')).toEqual(['/home/u/.config/jevcode']);
    expect(configDirs({ XDG_CONFIG_HOME: '/tmp/x' }, '/home/u')).toEqual(['/tmp/x/jevcode', '/home/u/.config/jevcode']);
  });

  it('credentialsPath: --config > JEVCODE_CONFIG > XDG file', () => {
    expect(credentialsPath({ env: {}, home: '/home/u', cwd: '/w' })).toEqual({ path: '/home/u/.config/jevcode/config.json', source: 'xdg' });
    expect(credentialsPath({ env: { JEVCODE_CONFIG: 'cfg.json' }, home: '/home/u', cwd: '/w' })).toEqual({ path: '/w/cfg.json', source: 'env' });
    expect(credentialsPath({ env: { JEVCODE_CONFIG: '/e.json' }, home: '/home/u', cwd: '/w', configFlag: '/f.json' })).toEqual({ path: '/f.json', source: 'flag' });
    expect(credentialsPath({ env: {}, home: '/home/u', cwd: '/w', configFlag: '  ' }).source).toBe('xdg');
    expect(displayPath('/home/u/.config/jevcode/config.json', '/home/u')).toBe('~/.config/jevcode/config.json');
    expect(displayPath('/etc/x.json', '/home/u')).toBe('/etc/x.json');
    expect(displayPath('/home/user2/x', '/home/u')).toBe('/home/user2/x');
  });
});

describe('writeCredentials', () => {
  it('creates the XDG file atomically with mode 0600 and dir 0700, merging provider/apiKey/jevApiKey and preserving other keys; items carry fingerprints only', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const target = join(home, 'xdg', 'jevcode', 'config.json');
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    await writeFile(target, JSON.stringify({ model: 'claude-sonnet-5', apiKey: 'old-key-value-000' }));
    const res = await writeCredentials({ provider: 'anthropic', apiKey: KEY, jevApiKey: OR_KEY }, { env, home, cwd, platform: 'darwin' });
    expect(res.path).toBe(target);
    expect(res.displayPath).toBe('~/xdg/jevcode/config.json');
    expect(await mode(target)).toBe(0o600);
    expect(await mode(join(home, 'xdg', 'jevcode'))).toBe(0o700);
    const written = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({ model: 'claude-sonnet-5', provider: 'anthropic', apiKey: KEY, jevApiKey: OR_KEY });
    expect((await readFile(target, 'utf8')).endsWith('\n')).toBe(true);
    expect(res.items).toEqual([
      `generator key: entered (sha256:${fingerprint(KEY)}) source=wizard`,
      `jev key: entered (sha256:${fingerprint(OR_KEY)}) source=wizard`,
      'saved ~/xdg/jevcode/config.json (mode 0600, dir 0700)',
    ]);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(res.fingerprints).toEqual({ generator: fingerprint(KEY), jev: fingerprint(OR_KEY) });
    expect(res.warnings).toEqual([]);
    // a second write with only the Jev key keeps the generator key
    await writeCredentials({ jevApiKey: 'another-jev-key-000' }, { env, home, cwd, platform: 'darwin' }, 'login');
    const again = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(again['apiKey']).toBe(KEY);
    expect(again['jevApiKey']).toBe('another-jev-key-000');
    expect(again['jevProvider']).toBeUndefined();
    expect(await mode(target)).toBe(0o600);
    // TUI-DESIGN-2 §2.3 / §1.4: `login --jev-provider typesafe` saves the provider beside the Jev key as the `jevProvider` file key
    await writeCredentials({ jevApiKey: 'ts-key-value-000000', jevProvider: 'typesafe' }, { env, home, cwd, platform: 'darwin' }, 'login');
    const withProvider = await readCredentialsFile(target);
    expect(withProvider.jevProvider).toBe('typesafe');
    expect(withProvider.jevApiKey).toBe('ts-key-value-000000');
    expect(withProvider.apiKey).toBe(KEY);
    expect(withProvider.values['jevProvider']).toBe('typesafe');
  });

  it('honours --config and JEVCODE_CONFIG; prints the Windows ACL note instead of the mode on win32', async () => {
    const res = await writeCredentials({ apiKey: KEY }, { env: {}, home, cwd, configFlag: join(dir, 'custom', 'c.json'), platform: 'win32' });
    expect(res.path).toBe(join(dir, 'custom', 'c.json'));
    expect(res.windows).toBe(true);
    expect(res.items[res.items.length - 1]).toBe(`saved ${join(dir, 'custom', 'c.json')} (Windows: protected by your user profile ACL)`);
    const viaEnv = await writeCredentials({ apiKey: KEY }, { env: { JEVCODE_CONFIG: 'e.json' }, home, cwd, platform: 'darwin' });
    expect(viaEnv.path).toBe(join(cwd, 'e.json'));
    expect(viaEnv.dirSecured).toBe(false);
    expect(viaEnv.items[viaEnv.items.length - 1]).toBe(`saved ${join(cwd, 'e.json')} (mode 0600)`);
  });

  it('a --config / JEVCODE_CONFIG file inside the workspace or $HOME leaves the parent directory mode unchanged (only the jevcode config dir is 0700)', async () => {
    await chmod(cwd, 0o755);
    await chmod(home, 0o755);
    const inWs = await writeCredentials({ apiKey: KEY }, { env: { JEVCODE_CONFIG: 'jevcode-creds.json' }, home, cwd, platform: 'darwin' });
    expect(await mode(cwd)).toBe(0o755);
    expect(await mode(inWs.path)).toBe(0o600);
    expect(inWs.dirSecured).toBe(false);
    const inHome = await writeCredentials({ apiKey: KEY }, { env: {}, home, cwd, configFlag: join(home, 'jevcode.json'), platform: 'darwin' });
    expect(await mode(home)).toBe(0o755);
    expect(await mode(inHome.path)).toBe(0o600);
    expect(inHome.items[inHome.items.length - 1]).toBe('saved ~/jevcode.json (mode 0600)');
    // a --config pointing INTO the jevcode config dir is still secured
    const legacy = await writeCredentials({ apiKey: KEY }, { env: {}, home, cwd, configFlag: join(home, '.config', 'jevcode', 'config.json'), platform: 'darwin' });
    expect(legacy.dirSecured).toBe(true);
    expect(await mode(join(home, '.config', 'jevcode'))).toBe(0o700);
    expect(legacy.items[legacy.items.length - 1]).toBe('saved ~/.config/jevcode/config.json (mode 0600, dir 0700)');
    expect(isJevcodeConfigDir(join(home, '.config', 'jevcode'), {}, home)).toBe(true);
    expect(isJevcodeConfigDir('/tmp/x/jevcode', { XDG_CONFIG_HOME: '/tmp/x' }, home)).toBe(true);
    expect(isJevcodeConfigDir(cwd, {}, home)).toBe(false);
    expect(isJevcodeConfigDir(home, {}, home)).toBe(false);
  });

  it('EACCES on the config dir surfaces as ConfigError `could not write <file>: <code>` (exit 2); nothing else changes', async () => {
    if (process.getuid?.() === 0) return;
    const ro = join(dir, 'ro');
    await mkdir(ro, { recursive: true });
    await chmod(ro, 0o500);
    try {
      const env = { XDG_CONFIG_HOME: ro };
      const err = await writeCredentials({ apiKey: KEY }, { env, home, cwd, platform: 'darwin' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toBe(`could not write ${join(ro, 'jevcode', 'config.json')}: EACCES`);
      expect((err as ConfigError).exitCode).toBe(2);
      expect((err as ConfigError).setting).toBe('configFile');
      await expect(writeConfigValue('theme', 'light', { env, home, cwd })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await chmod(ro, 0o755);
    }
  });

  it('the atomic write creates its temp file 0600 (no world-readable window) and leaves no temp file behind', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const target = join(home, 'xdg', 'jevcode', 'config.json');
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    // a large existing file makes the write window observable (25–60 samples per run on a laptop SSD)
    await writeFile(target, JSON.stringify({ padding: 'p'.repeat(12 * 1024 * 1024) }));
    const tmpModes: number[] = [];
    let done = false;
    const write = writeCredentials({ apiKey: KEY }, { env, home, cwd, platform: 'darwin' }).finally(() => {
      done = true;
    });
    while (!done) {
      for (const n of readdirSync(join(home, 'xdg', 'jevcode'))) {
        if (!n.includes('.tmp-')) continue;
        try {
          tmpModes.push(statSync(join(home, 'xdg', 'jevcode', n)).mode & 0o777);
        } catch {
          /* renamed away between readdir and stat */
        }
      }
      await new Promise((r) => setImmediate(r));
    }
    await write;
    expect(tmpModes.length).toBeGreaterThan(0);
    for (const m of tmpModes) expect(m).toBe(0o600);
    expect(readdirSync(join(home, 'xdg', 'jevcode')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(await mode(target)).toBe(0o600);
    const written = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(written['apiKey']).toBe(KEY);
  });

  it('two concurrent logins keep the file valid JSON at 0600 with no temp files left', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const results = await Promise.all([
      writeCredentials({ provider: 'anthropic', apiKey: KEY }, { env, home, cwd, platform: 'darwin' }, 'login'),
      writeCredentials({ jevApiKey: OR_KEY }, { env, home, cwd, platform: 'darwin' }, 'login'),
      writeConfigValue('theme', 'light', { env, home, cwd, platform: 'darwin' }),
    ]);
    const target = results[0].path;
    const text = await readFile(target, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(typeof parsed).toBe('object');
    expect(parsed['apiKey'] === KEY || parsed['jevApiKey'] === OR_KEY || parsed['theme'] === 'light').toBe(true);
    expect(await mode(target)).toBe(0o600);
    expect(readdirSync(join(home, 'xdg', 'jevcode')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('the §24 item builders live here (config never imports the TUI)', () => {
    expect(keyEnteredText('generator', 'e31150e9abcdef', 'login')).toBe('generator key: entered (sha256:e31150e9) source=login');
    expect(savedText('~/.config/jevcode/config.json')).toBe('saved ~/.config/jevcode/config.json (mode 0600, dir 0700)');
    expect(savedText('/ws/c.json', false, false)).toBe('saved /ws/c.json (mode 0600)');
    expect(savedText('C:\\x\\c.json', true, false)).toBe('saved C:\\x\\c.json (Windows: protected by your user profile ACL)');
    expect(shadowingText('decider.apiKey', 'JEV_API_KEY', 'aaaaaaaabbbb', '~/x', 'ccccccccdddd')).toBe('decider.apiKey: env JEV_API_KEY (sha256:aaaaaaaa) overrides file ~/x (sha256:cccccccc) — unset the variable to use the saved key');
  });

  it('refuses short keys, whitespace and a malformed existing file with ConfigError (exit 2); never writes ./.env or ./jevcode.json', async () => {
    await expect(writeCredentials({ apiKey: 'short' }, { env: {}, home, cwd })).rejects.toBeInstanceOf(ConfigError);
    await expect(writeCredentials({ jevApiKey: 'has space in it' }, { env: {}, home, cwd })).rejects.toBeInstanceOf(ConfigError);
    const target = join(home, '.config', 'jevcode', 'config.json');
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await writeFile(target, '{ not json');
    await expect(writeCredentials({ apiKey: KEY }, { env: {}, home, cwd })).rejects.toBeInstanceOf(ConfigError);
    expect(await readFile(target, 'utf8')).toBe('{ not json');
    await writeFile(target, '[]');
    await expect(writeCredentials({ apiKey: KEY }, { env: {}, home, cwd })).rejects.toBeInstanceOf(ConfigError);
    await rm(target);
    await writeFile(join(cwd, '.env'), 'X=1\n');
    await writeCredentials({ apiKey: KEY }, { env: {}, home, cwd, platform: 'darwin' });
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('X=1\n');
    await expect(stat(join(cwd, 'jevcode.json'))).rejects.toThrow();
  });

  it('warns once when both the XDG and the legacy file exist, and when ./jevcode.json shadows non-secret keys', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await writeFile(join(home, '.config', 'jevcode', 'config.json'), '{}');
    await writeFile(join(cwd, 'jevcode.json'), '{"apiKey":"in-workspace-000"}');
    const res = await writeCredentials({ apiKey: KEY }, { env, home, cwd, platform: 'darwin' });
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toBe('both ~/xdg/jevcode/config.json and ~/.config/jevcode/config.json exist — the XDG file wins; remove the legacy file to silence this');
    expect(res.warnings[1]).toBe(jevcodeJsonWarning('~/xdg/jevcode/config.json'));
    expect(res.warnings[1]).toBe('./jevcode.json takes precedence for non-secret keys; keys were saved to ~/xdg/jevcode/config.json — remove any apiKey there');
    expect(await legacyWarning({}, home)).toBeNull();
    // ./jevcode.json is left untouched
    expect(await readFile(join(cwd, 'jevcode.json'), 'utf8')).toBe('{"apiKey":"in-workspace-000"}');
  });
});

describe('readCredentialsFile / removeCredentials / writeConfigValue', () => {
  it('reads tolerantly: missing → exists false; malformed → error; values kept', async () => {
    const p = join(dir, 'c.json');
    expect(await readCredentialsFile(p)).toEqual({ path: p, exists: false, values: {}, provider: null, apiKey: null, jevApiKey: null, jevProvider: null, error: null });
    await writeFile(p, '{"provider":"openrouter","apiKey":"","jevApiKey":"jjjjjjjjjj","extra":1}');
    const f = await readCredentialsFile(p);
    expect(f.exists).toBe(true);
    expect(f.provider).toBe('openrouter');
    expect(f.apiKey).toBeNull();
    expect(f.jevApiKey).toBe('jjjjjjjjjj');
    expect(f.jevProvider).toBeNull();
    expect(f.values['extra']).toBe(1);
    await writeFile(p, 'nope');
    expect((await readCredentialsFile(p)).error).toContain('not a JSON object');
    await mkdir(join(dir, 'adir'));
    expect((await readCredentialsFile(join(dir, 'adir'))).error).toContain('EISDIR');
  });

  it('removeCredentials drops the named keys, rewrites atomically at 0600, reports fingerprints and absent keys', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    await writeCredentials({ provider: 'openrouter', apiKey: KEY, jevApiKey: OR_KEY }, { env, home, cwd, platform: 'darwin' });
    const res = await removeCredentials(['apiKey'], { env, home, cwd, platform: 'darwin' });
    expect(res.removed).toEqual([{ key: 'apiKey', fingerprint: fingerprint(KEY) }]);
    expect(res.absent).toEqual([]);
    expect(res.items).toEqual([`removed generator key (sha256:${fingerprint(KEY)}) from ~/xdg/jevcode/config.json`]);
    const left = JSON.parse(await readFile(res.path, 'utf8')) as Record<string, unknown>;
    expect(left).toEqual({ provider: 'openrouter', jevApiKey: OR_KEY });
    expect(await mode(res.path)).toBe(0o600);
    const again = await removeCredentials(['apiKey', 'jevApiKey'], { env, home, cwd, platform: 'darwin' });
    expect(again.removed.map((r) => r.key)).toEqual(['jevApiKey']);
    expect(again.absent).toEqual(['apiKey']);
    expect(again.items).toEqual([`removed jev key (sha256:${fingerprint(OR_KEY)}) from ~/xdg/jevcode/config.json`, 'generator key: not in ~/xdg/jevcode/config.json']);
    const none = await removeCredentials(['apiKey'], { env: { XDG_CONFIG_HOME: join(home, 'empty') }, home, cwd });
    expect(none.removed).toEqual([]);
    expect(none.items).toEqual(['generator key: not in ~/empty/jevcode/config.json']);
  });

  it('writeConfigValue merges a non-secret key into the same file with the same modes', async () => {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    await writeCredentials({ apiKey: KEY }, { env, home, cwd, platform: 'darwin' });
    const r = await writeConfigValue('theme', 'light', { env, home, cwd, platform: 'darwin' });
    expect(r.displayPath).toBe('~/xdg/jevcode/config.json');
    const written = JSON.parse(await readFile(r.path, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({ apiKey: KEY, theme: 'light' });
    expect(await mode(r.path)).toBe(0o600);
    await writeFile(r.path, '{broken');
    await expect(writeConfigValue('theme', 'dark', { env, home, cwd })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('shadowingLine (pure, P43)', () => {
  it('fires only for env/dotenv sources with a different fingerprint than the file', () => {
    const file = '/home/u/.config/jevcode/config.json';
    const line = shadowingLine('generator.apiKey', { value: KEY, source: 'env' }, 'ANTHROPIC_API_KEY', file, OR_KEY, '/home/u');
    expect(line).toBe(`generator.apiKey: env ANTHROPIC_API_KEY (sha256:${fingerprint(KEY)}) overrides file ~/.config/jevcode/config.json (sha256:${fingerprint(OR_KEY)}) — unset the variable to use the saved key`);
    expect(line).not.toContain(KEY);
    expect(shadowingLine('generator.apiKey', { value: KEY, source: 'env' }, 'ANTHROPIC_API_KEY', file, KEY, '/home/u')).toBeNull();
    expect(shadowingLine('generator.apiKey', { value: KEY, source: `file:${file}` }, 'ANTHROPIC_API_KEY', file, OR_KEY, '/home/u')).toBeNull();
    expect(shadowingLine('generator.apiKey', { value: KEY, source: 'flag' }, 'ANTHROPIC_API_KEY', file, OR_KEY, '/home/u')).toBeNull();
    expect(shadowingLine('generator.apiKey', undefined, 'ANTHROPIC_API_KEY', file, OR_KEY, '/home/u')).toBeNull();
    expect(shadowingLine('generator.apiKey', { value: KEY, source: 'env' }, 'ANTHROPIC_API_KEY', file, null, '/home/u')).toBeNull();
    expect(shadowingLine('decider.apiKey', { value: KEY, source: 'dotenv:/w/.env' }, 'JEV_API_KEY', file, OR_KEY, '/home/u')).toContain('env JEV_API_KEY (dotenv:/w/.env) (sha256:');
  });
});
