/** config/trust.ts (TUI-DESIGN §11.3; §19.0 row O7): sha256 re-prompt, $HOME never persisted, 0600, --trust-workspace, non-interactive skip. */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTrustStore,
  decisionFromOption,
  evaluateTrust,
  parseTrustFile,
  probeTrustInputs,
  trustFilePath,
  trustKey,
  trustWorkspaceFlag,
  type TrustRecord,
} from '../../../src/config/trust.js';

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-trust-'));
  home = join(dir, 'home');
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const agentsA = { path: '/repo/AGENTS.md', sha256: SHA_A };
const agentsB = { path: '/repo/AGENTS.md', sha256: SHA_B };
const base = { agents: agentsA, hasUntrustedInputs: true, interactive: true, trustWorkspace: false };
const rec = (decision: TrustRecord['decision'], agents: TrustRecord['agents'] = agentsA): TrustRecord => ({ decision, at: '2026-09-20T00:00:00.000Z', agents });

describe('pure helpers', () => {
  it('paths, options, flags, keys', () => {
    expect(trustFilePath('/home/u')).toBe('/home/u/.jevcode/trust.json');
    expect(decisionFromOption(1)).toBe('trust');
    expect(decisionFromOption(2)).toBe('session');
    expect(decisionFromOption(3)).toBe('none');
    expect(trustWorkspaceFlag({}, undefined)).toBe(false);
    expect(trustWorkspaceFlag({}, true)).toBe(true);
    expect(trustWorkspaceFlag({ JEVCODE_TRUST_WORKSPACE: '1' }, undefined)).toBe(true);
    expect(trustWorkspaceFlag({ JEVCODE_TRUST_WORKSPACE: 'true' }, undefined)).toBe(true);
    expect(trustWorkspaceFlag({ JEVCODE_TRUST_WORKSPACE: '0' }, undefined)).toBe(false);
    expect(trustWorkspaceFlag({ JEVCODE_TRUST_WORKSPACE: 'false' }, false)).toBe(false);
    expect(trustWorkspaceFlag({ JEVCODE_TRUST_WORKSPACE: '' }, undefined)).toBe(false);
    expect(trustKey('/g', '/w', (p) => `${p}/real`)).toBe('/g/real');
    expect(trustKey(null, '/w', (p) => `${p}/real`)).toBe('/w/real');
    expect(
      trustKey(null, '/missing/../w', () => {
        throw new Error('ENOENT');
      }),
    ).toBe('/w');
  });

  it('parseTrustFile is tolerant and never loads session entries', () => {
    expect(parseTrustFile('')).toEqual({});
    expect(parseTrustFile('[]')).toEqual({});
    expect(parseTrustFile('{bad')).toEqual({});
    const text = JSON.stringify({
      '/a': { decision: 'trust', at: 't', agents: { path: '/a/AGENTS.md', sha256: SHA_A } },
      '/b': { decision: 'none', at: 't', agents: null },
      '/c': { decision: 'session', at: 't', agents: null },
      '/d': { decision: 'maybe', at: 't', agents: null },
      '/e': 'nope',
      '/f': { decision: 'trust', agents: { path: 1 } },
    });
    expect(parseTrustFile(text)).toEqual({
      '/a': { decision: 'trust', at: 't', agents: { path: '/a/AGENTS.md', sha256: SHA_A } },
      '/b': { decision: 'none', at: 't', agents: null },
      '/f': { decision: 'trust', at: '', agents: null },
    });
  });
});

describe('evaluateTrust (pure)', () => {
  it('--trust-workspace wins; nothing untrusted → nothing to ask', () => {
    expect(evaluateTrust({ ...base, record: null, trustWorkspace: true })).toEqual({ kind: 'trusted', via: 'flag' });
    expect(evaluateTrust({ ...base, record: null, hasUntrustedInputs: false })).toEqual({ kind: 'trusted', via: 'nothing' });
  });

  it('no record: prompt when interactive, untrusted (skip) when not', () => {
    expect(evaluateTrust({ ...base, record: null })).toEqual({ kind: 'prompt', reason: 'none', changed: null });
    expect(evaluateTrust({ ...base, record: null, interactive: false })).toEqual({ kind: 'untrusted', via: 'non-interactive' });
  });

  it('stored trust holds while the sha256 matches; a changed sha256 re-prompts with the 8-char pair; a new instruction file prompts', () => {
    expect(evaluateTrust({ ...base, record: rec('trust') })).toEqual({ kind: 'trusted', via: 'stored' });
    expect(evaluateTrust({ ...base, record: rec('trust'), agents: agentsB })).toEqual({ kind: 'prompt', reason: 'changed', changed: { from: 'aaaaaaaa', to: 'bbbbbbbb' } });
    expect(evaluateTrust({ ...base, record: rec('trust'), agents: agentsB, interactive: false })).toEqual({ kind: 'untrusted', via: 'non-interactive' });
    expect(evaluateTrust({ ...base, record: rec('trust', null) })).toEqual({ kind: 'prompt', reason: 'none', changed: null });
    expect(evaluateTrust({ ...base, record: rec('trust', null), agents: null })).toEqual({ kind: 'trusted', via: 'stored' });
    expect(evaluateTrust({ ...base, record: rec('trust'), agents: null })).toEqual({ kind: 'trusted', via: 'stored' });
  });

  it("'none' stays untrusted; a session decision trusts for the process", () => {
    expect(evaluateTrust({ ...base, record: rec('none') })).toEqual({ kind: 'untrusted', via: 'stored' });
    expect(evaluateTrust({ ...base, record: rec('none'), agents: agentsB })).toEqual({ kind: 'untrusted', via: 'stored' });
    expect(evaluateTrust({ ...base, record: rec('session') })).toEqual({ kind: 'trusted', via: 'session' });
  });
});

describe('createTrustStore', () => {
  it('persists trust/none atomically at 0600 keyed by root with AGENTS.md@sha256; load reads it back; get prefers session', async () => {
    const path = trustFilePath(home);
    const store = createTrustStore(path);
    await store.load();
    expect(store.get('/repo')).toBeNull();
    expect(await store.set('/repo', 'trust', agentsA, '2026-09-20T19:15:06.123Z', home)).toEqual({ persisted: true });
    expect(((await stat(path)).mode & 0o777)).toBe(0o600);
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({ '/repo': { decision: 'trust', at: '2026-09-20T19:15:06.123Z', agents: { path: '/repo/AGENTS.md', sha256: SHA_A } } });
    expect(await store.set('/other', 'none', null, 't2', home)).toEqual({ persisted: true });
    const fresh = createTrustStore(path);
    await fresh.load();
    expect(fresh.get('/repo')).toEqual({ decision: 'trust', at: '2026-09-20T19:15:06.123Z', agents: agentsA });
    expect(fresh.get('/other')).toEqual({ decision: 'none', at: 't2', agents: null });
    expect(fresh.evaluate('/repo', base)).toEqual({ kind: 'trusted', via: 'stored' });
    expect(fresh.evaluate('/repo', { ...base, agents: agentsB })).toEqual({ kind: 'prompt', reason: 'changed', changed: { from: 'aaaaaaaa', to: 'bbbbbbbb' } });
    expect(fresh.evaluate('/nowhere', base)).toEqual({ kind: 'prompt', reason: 'none', changed: null });
    // a session decision overrides in memory and is not written
    expect(await fresh.set('/repo', 'session', agentsB, 't3', home)).toEqual({ persisted: false });
    expect(fresh.get('/repo')?.decision).toBe('session');
    expect(fresh.snapshot()['/repo']?.decision).toBe('trust');
    const disk = JSON.parse(await readFile(path, 'utf8')) as Record<string, { decision: string }>;
    expect(disk['/repo']?.decision).toBe('trust');
  });

  it('$HOME as the workspace is never persisted; a missing or malformed file loads as empty; a failed write returns persisted false', async () => {
    const path = trustFilePath(home);
    const store = createTrustStore(path);
    await store.load();
    expect(await store.set(home, 'trust', null, 't', home)).toEqual({ persisted: false });
    expect(store.get(home)?.decision).toBe('trust');
    await expect(stat(path)).rejects.toThrow();
    await mkdir(join(home, '.jevcode'), { recursive: true });
    await writeFile(path, '{oops');
    const broken = createTrustStore(path);
    await broken.load();
    expect(broken.snapshot()).toEqual({});
    const failing = createTrustStore(path, {
      writeFile: async () => {
        throw new Error('EACCES');
      },
    });
    await failing.load();
    expect(await failing.set('/x', 'trust', null, 't', home)).toEqual({ persisted: false });
    expect(failing.get('/x')?.decision).toBe('trust');
  });

  it('set before load merges with the file instead of clobbering it', async () => {
    const path = trustFilePath(home);
    await mkdir(join(home, '.jevcode'), { recursive: true });
    await writeFile(path, JSON.stringify({ '/old': { decision: 'trust', at: 't', agents: null } }));
    const store = createTrustStore(path);
    await store.set('/new', 'none', null, 't', home);
    const disk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(disk).sort()).toEqual(['/new', '/old']);
  });
});

describe('probeTrustInputs', () => {
  it('lists sizes and counts only: AGENTS.md bytes, .env var/secret-like counts, jevcode.json bytes; never a value', async () => {
    const ws = join(dir, 'ws');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-secretvaluesecretvaluesecret\nSOME_PLAIN=x\nDB_PASSWORD=hunter22\n');
    await writeFile(join(ws, 'jevcode.json'), '{"maxSteps": 3}');
    const t = await probeTrustInputs(ws, '/repo', { path: join(ws, 'AGENTS.md'), sha256: SHA_A, bytes: 2150 }, 'AGENTS.md');
    expect(t).toEqual({ root: '/repo', agents: { name: 'AGENTS.md', bytes: 2150 }, dotenv: { vars: 3, secretLike: 2 }, jevcodeJson: { bytes: 15 }, changed: null, hasUntrustedInputs: true });
    expect(JSON.stringify(t)).not.toContain('secretvalue');
    const empty = await probeTrustInputs(join(dir, 'nowhere'), '/x', null, null);
    expect(empty).toEqual({ root: '/x', agents: null, dotenv: null, jevcodeJson: null, changed: null, hasUntrustedInputs: false });
    const changed = await probeTrustInputs(join(dir, 'nowhere'), '/x', { path: 'p', sha256: SHA_B, bytes: 1 }, 'CLAUDE.md', { from: 'aaaaaaaa', to: 'bbbbbbbb' });
    expect(changed.agents).toEqual({ name: 'CLAUDE.md', bytes: 1 });
    expect(changed.changed).toEqual({ from: 'aaaaaaaa', to: 'bbbbbbbb' });
  });

  it('an oversize .env (readDotenv throws ConfigError) is listed as unreadable and still counts as an untrusted input; a .env directory is no .env', async () => {
    const ws = join(dir, 'ws-big');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, '.env'), `BIG=${'x'.repeat(1024 * 1024 + 10)}\n`);
    const big = await probeTrustInputs(ws, '/repo', null, null);
    expect(big.dotenv).toEqual({ vars: 0, secretLike: 0, unreadable: true });
    expect(big.hasUntrustedInputs).toBe(true);
    const wsDir = join(dir, 'ws-dir');
    await mkdir(join(wsDir, '.env'), { recursive: true });
    const asDir = await probeTrustInputs(wsDir, '/repo', null, null);
    expect(asDir.dotenv).toBeNull();
    expect(asDir.hasUntrustedInputs).toBe(false);
    if (process.getuid?.() !== 0) {
      const wsRo = join(dir, 'ws-ro');
      await mkdir(wsRo, { recursive: true });
      await writeFile(join(wsRo, '.env'), 'A=1\n');
      await chmod(join(wsRo, '.env'), 0o000);
      try {
        const denied = await probeTrustInputs(wsRo, '/repo', null, null);
        expect(denied.dotenv).toEqual({ vars: 0, secretLike: 0, unreadable: true });
        expect(JSON.stringify(denied)).not.toContain('A=1');
      } finally {
        await chmod(join(wsRo, '.env'), 0o644);
      }
    }
  });
});

describe('createTrustStore: $HOME by realpath and an unreadable trust.json', () => {
  it('a root given as a symlink to $HOME (or as $HOME’s realpath) is never persisted', async () => {
    const path = trustFilePath(home);
    const store = createTrustStore(path);
    await store.load();
    const link = join(dir, 'home-link');
    await symlink(home, link);
    expect(await store.set(link, 'trust', null, 't', home)).toEqual({ persisted: false });
    expect(store.get(link)?.decision).toBe('trust');
    expect(await store.set(await realpath(home), 'trust', null, 't', home)).toEqual({ persisted: false });
    await expect(stat(path)).rejects.toThrow();
    // a sibling directory is persisted as usual
    const repo = join(dir, 'repo');
    await mkdir(repo);
    expect(await store.set(repo, 'trust', null, 't', home)).toEqual({ persisted: true });
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)).toEqual([repo]);
  });

  it('trust.json unreadable (EACCES) loads as empty → prompt every run; an unwritable dir → persisted false, decision held in memory', async () => {
    if (process.getuid?.() === 0) return;
    const path = trustFilePath(home);
    await mkdir(join(home, '.jevcode'), { recursive: true });
    await writeFile(path, JSON.stringify({ '/repo': { decision: 'trust', at: 't', agents: null } }));
    await chmod(path, 0o000);
    await chmod(join(home, '.jevcode'), 0o500);
    try {
      const store = createTrustStore(path);
      await store.load();
      expect(store.snapshot()).toEqual({});
      expect(store.evaluate('/repo', base)).toEqual({ kind: 'prompt', reason: 'none', changed: null });
      expect(await store.set('/repo', 'trust', agentsA, 't', home)).toEqual({ persisted: false });
      expect(store.get('/repo')?.decision).toBe('trust');
      expect(store.evaluate('/repo', base)).toEqual({ kind: 'trusted', via: 'stored' });
      const again = createTrustStore(path);
      await again.load();
      expect(again.evaluate('/repo', base)).toEqual({ kind: 'prompt', reason: 'none', changed: null });
    } finally {
      await chmod(join(home, '.jevcode'), 0o755);
      await chmod(path, 0o600);
    }
  });
});
