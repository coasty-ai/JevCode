/**
 * TUI-DESIGN-5 §2.14 / §2.8 / §7 rows 15, 26, 27 (slot R5-1): `openSessionLedger` itself, over a MOCKED
 * coordination facade — the one place the real tree is loaded, so the seam is the module boundary.
 *
 * Two invariants nothing else can see:
 *
 *  1. **One epoch.** `mintClaim()` decides the epoch, and the heartbeat base carries the SAME claim. Peers rank
 *     forks by the epoch on the BEAT (`compareClaim` is epoch-desc first, `claims.ts:85`); a beat that kept
 *     `FIRST_EPOCH` after a `--force-takeback` broadcast a claim this session had just beaten.
 *  2. **The repo identity is resolved, cached and published.** `repoKeyOf` over the injected probe, written back
 *     through `writeRepoKeyCache`, and carried by both `SelfIdentity` and the beat's `repo` — otherwise
 *     `sameRepo` degrades to exact `wsKey` equality and two worktrees of one repo never meet (§7 rows 7–9).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({
  projection: [] as { runId: string; claims: { epoch: number }[] }[],
  heartbeatBase: null as null | { claim: { epoch: number }; repo: { repoKey: string | null; remoteKey: string | null; head: string | null; linkedWorktree: boolean } },
  cacheWrites: [] as { repoKey: string | null; remoteKey: string | null; commonDir60: string }[],
  cacheEntry: null as null | { v: 1; repoKey: string | null; remoteKey: string | null; kind: 'roots' | 'remote' | 'none'; commonDir60: string; at: string },
  seen: [] as number[],
}));

vi.mock('../../../src/coordination/index.js', () => {
  const fold = { at: { wallMs: 0, monoMs: 0 }, devices: new Map(), live: new Map(), gone: new Map(), leases: new Map(), origins: new Map(), liveness: new Map(), skipped: 0 };
  return {
    coordinationRoot: (home: string) => `${home}/coordination`,
    commonsPaths: (root: string, hostKey?: string) => ({ hostDir: hostKey === undefined ? root : `${root}/devices/${hostKey}` }),
    nodeFs: {},
    deviceIdentity: async () => ({ device: { deviceId: 'k3q7m2ab1111222233334444', label: 'mbp' }, hostKey: 'hostkey00112233' }),
    wsKeyOf: (p: string) => `ws:${p.length}`,
    readRepoKeyCache: async () => spy.cacheEntry,
    writeRepoKeyCache: async (_fs: unknown, _dir: string, _ws: string, entry: { repoKey: string | null; remoteKey: string | null; commonDir60: string }) => {
      spy.cacheWrites.push(entry);
    },
    repoKeyOf: (f: { rootOids: readonly string[]; shallow: boolean; originUrl: string | null }) => ({
      repoKey: f.shallow || f.rootOids.length === 0 ? null : `repo:${f.rootOids.join('+')}`,
      remoteKey: f.originUrl === null ? null : `rm:${f.originUrl}`,
      kind: 'roots' as const,
    }),
    mintClaim: (o: { deviceId: string; runId: string; pid: number; at: string }) => ({ ...o, epoch: 1 }),
    openLedger: () => ({
      fold,
      open: async () => undefined,
      close: async () => undefined,
      subscribe: () => () => undefined,
      writeClaimsProjection: async (p: { runId: string; claims: { epoch: number }[] }) => {
        spy.projection.push(p);
      },
    }),
    listSessions: () => [],
    seenEpochs: () => spy.seen,
    byRunId: () => [],
    authorityOf: () => 'trusted',
    originOf: () => ({ self: true }),
    claimRefusal: () => null,
    MAX_CLAIM_EPOCH: 1_000_000_000,
    ordinaryMintEpoch: (seen: readonly number[]) => Math.max(1, ...seen, 0),
    forceTakebackEpoch: (seen: readonly number[]) => Math.max(1, ...seen, 0) + 1,
    createHeartbeatWriter: (o: { base: { claim: { epoch: number }; repo: { repoKey: string | null; remoteKey: string | null; head: string | null; linkedWorktree: boolean } } }) => {
      spy.heartbeatBase = o.base;
      return { start: () => undefined, stop: () => undefined };
    },
    declare: () => ({}),
    release: () => undefined,
  };
});

const { openSessionLedger } = await import('../../../src/session/publish.js');

const INPUT = {
  home: '/home/.jevcode',
  workspace: '/w/repo',
  hostname: 'mac',
  username: 'me',
  jevcode: '0.5.0',
  pid: 4242,
  runId: '20260921-234432-rpywkq2v',
  sessionId: '20260921-234432-rpywkq2v',
  parentSessionId: null,
  parentRunId: null,
  source: 'cli' as const,
  task60: 'fix store rotation',
  title60: null,
  mode: 'jev-on',
  maxSteps: 40,
  maxWallMs: 1_800_000,
  branch: 'main',
  head: '3f9a2c1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  dirtyAtStart: false,
  linkedWorktree: true,
  worktreeSlug: null,
  bootAt: '2026-09-20T09:00:00.000Z',
  commonDir: '/w/repo/.git',
  repoFacts: async () => ({ rootOids: ['aaaa1111'], shallow: false, originUrl: 'git@github.com:me/repo.git' }),
};

beforeEach(() => {
  spy.projection = [];
  spy.heartbeatBase = null;
  spy.cacheWrites = [];
  spy.cacheEntry = null;
  spy.seen = [];
});

describe('openSessionLedger — one epoch, on the projection AND on the beat (§7 rows 15/26/27)', () => {
  it('`--force-takeback` past seen epoch 3 mints 4, and the heartbeat base carries 4 — not FIRST_EPOCH', async () => {
    spy.seen = [3];
    const led = await openSessionLedger(INPUT);
    await led.mintClaim({ forceTakeback: true });
    led.startHeartbeat();
    expect(spy.projection).toHaveLength(1);
    expect(spy.projection[0]?.claims[0]?.epoch).toBe(4);
    expect(spy.heartbeatBase?.claim.epoch).toBe(4);
    expect(led.mintedClaim().epoch).toBe(4);
    // the two can no longer diverge: they are the same object
    expect(spy.heartbeatBase?.claim).toBe(led.mintedClaim());
  });

  it('an ordinary mint past seen epoch 3 keeps 3 on both, and an unminted ledger beats with the identity claim', async () => {
    spy.seen = [3];
    const led = await openSessionLedger(INPUT);
    await led.mintClaim({ forceTakeback: false });
    led.startHeartbeat();
    expect(spy.projection[0]?.claims[0]?.epoch).toBe(3);
    expect(spy.heartbeatBase?.claim.epoch).toBe(3);
  });
});

describe('openSessionLedger — the repo identity (§3.2, §7 rows 7–9)', () => {
  it('resolves `repoKey`/`remoteKey` through the probe, caches them, and publishes them on self AND on the beat', async () => {
    const led = await openSessionLedger(INPUT);
    led.startHeartbeat();
    expect(led.repoKeys).toEqual({ repoKey: 'repo:aaaa1111', remoteKey: 'rm:git@github.com:me/repo.git' });
    expect(led.self.repoKey).toBe('repo:aaaa1111');
    expect(spy.heartbeatBase?.repo.repoKey).toBe('repo:aaaa1111');
    expect(spy.heartbeatBase?.repo.remoteKey).toBe('rm:git@github.com:me/repo.git');
    // §12.1 S1's `@sha` and §7 row 8's linked worktree reach the beat as given
    expect(spy.heartbeatBase?.repo.head).toBe(INPUT.head);
    expect(spy.heartbeatBase?.repo.linkedWorktree).toBe(true);
    expect(spy.cacheWrites).toEqual([{ repoKey: 'repo:aaaa1111', remoteKey: 'rm:git@github.com:me/repo.git', kind: 'roots', commonDir60: '/w/repo/.git', at: expect.any(String) }]);
  });

  it('a cache hit for this `commonDir` skips the probe entirely', async () => {
    spy.cacheEntry = { v: 1, repoKey: 'repo:cached', remoteKey: null, kind: 'roots', commonDir60: '/w/repo/.git', at: '2026-09-21T00:00:00.000Z' };
    let probed = 0;
    const led = await openSessionLedger({ ...INPUT, repoFacts: async () => { probed += 1; return { rootOids: ['aaaa1111'], shallow: false, originUrl: null }; } });
    expect(led.repoKeys).toEqual({ repoKey: 'repo:cached', remoteKey: null });
    expect(probed).toBe(0);
    expect(spy.cacheWrites).toEqual([]);
  });

  it('a cache entry from ANOTHER checkout is ignored, and a failing probe degrades to `{ null, null }` rather than failing the open', async () => {
    spy.cacheEntry = { v: 1, repoKey: 'repo:elsewhere', remoteKey: null, kind: 'roots', commonDir60: '/other/.git', at: '2026-09-21T00:00:00.000Z' };
    const led = await openSessionLedger({ ...INPUT, repoFacts: async () => null });
    expect(led.repoKeys).toEqual({ repoKey: null, remoteKey: null });
    const thrown = await openSessionLedger({ ...INPUT, repoFacts: () => Promise.reject(new Error('git missing')) });
    expect(thrown.repoKeys).toEqual({ repoKey: null, remoteKey: null });
  });

  it('keys the caller already has win over both the cache and the probe', async () => {
    let probed = 0;
    const led = await openSessionLedger({ ...INPUT, repoKey: 'repo:given', remoteKey: null, repoFacts: async () => { probed += 1; return null; } });
    expect(led.repoKeys).toEqual({ repoKey: 'repo:given', remoteKey: null });
    expect(probed).toBe(0);
  });
});
