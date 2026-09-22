/**
 * The coordination FACADE as a consumer sees it (COORDINATION-DESIGN §12.0.4, finishing pass items F09 / F20).
 *
 * F09 — the plane was built, contract-typed and unit-tested but had no entry point: a caller had to assemble eleven
 * `SelfIdentity` fields by hand, and `bootId` had NO producer anywhere in the tree, so `lockReplaceVerdict`'s
 * `other-boot` branch was dead. `bootIdOf` is that producer and `openCoordination` is that entry point.
 *
 * F20 — three surface defects: two same-named `Ledger` concepts with no note saying which to type against, a header
 * claiming importers that do not exist, and two unrelated peer projections (`SessionHost.peers()` vs
 * `EngineStatus.coordination.peers`) that could disagree. `peerViewOf` makes them one projection by construction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOT_ID_DEADLINE_MS, BOOT_ID_PATH_LINUX, bootIdOf, type BootProbe } from '../../../src/coordination/boot.js';
import { openCoordination, peerViewOf } from '../../../src/coordination/index.js';
import type { Ledger, LedgerBase } from '../../../src/coordination/index.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import type { CoordinationStatus, EngineRunPhase, PeerView } from '../../../src/core/types.js';
import { makeSelf } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'jevcode-facade-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** a probe whose every read fails the way a locked-down container's does */
const failingProbe: BootProbe = {
  exec: () => Promise.reject(Object.assign(new Error('spawn sysctl ENOENT'), { code: 'ENOENT' })),
  read: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
};

function peerRow(patch: Partial<CoordinationStatus['peers'][number]> = {}): CoordinationStatus['peers'][number] {
  return {
    runId: '20260921-120000-aaaaaaaa',
    sessionId: '20260921-120000-aaaaaaaa',
    deviceId: 'k3q7m2ab',
    label: 'mbp',
    step: 3,
    stage: 'generate',
    phase: 'running' as EngineRunPhase,
    beatAgeMs: 1_000,
    sameDevice: false,
    blocked: null,
    live: true,
    cloned: false,
    ...patch,
  };
}

function statusOf(peers: CoordinationStatus['peers'], patch: Partial<CoordinationStatus> = {}): CoordinationStatus {
  return { peers, live: peers.filter((p) => p.live).length, conflicts: 0, inbox: 0, mirror: null, off: null, waiting: null, ...patch };
}

// ── F09 (a): `bootIdOf` — the one producer of `SelfIdentity.bootId` ───────────────────────────────────────────────────

describe('bootIdOf', () => {
  it('returns null without throwing when the injected exec fails', async () => {
    await expect(bootIdOf({ probe: failingProbe, platform: 'darwin' })).resolves.toBeNull();
    await expect(bootIdOf({ probe: failingProbe, platform: 'linux' })).resolves.toBeNull();
  });

  it('returns null on a platform with no boot identity, without calling the probe', async () => {
    let calls = 0;
    const probe: BootProbe = {
      exec: () => {
        calls += 1;
        return Promise.resolve('nope');
      },
      read: () => {
        calls += 1;
        return Promise.resolve('nope');
      },
    };
    expect(await bootIdOf({ probe, platform: 'win32' })).toBeNull();
    expect(calls).toBe(0);
  });

  it('reads `sysctl -n kern.bootsessionuuid` on darwin and the proc file on linux, one line, trimmed', async () => {
    const seen: string[] = [];
    const probe: BootProbe = {
      exec: (cmd, args) => {
        seen.push([cmd, ...args].join(' '));
        return Promise.resolve('  9F8A1C2E-0000-4A00-9000-1122334455AA \n');
      },
      read: (path) => {
        seen.push(path);
        return Promise.resolve('1f2e3d4c-5b6a-4790-8123-456789abcdef\n');
      },
    };
    expect(await bootIdOf({ probe, platform: 'darwin' })).toBe('9F8A1C2E-0000-4A00-9000-1122334455AA');
    expect(await bootIdOf({ probe, platform: 'linux' })).toBe('1f2e3d4c-5b6a-4790-8123-456789abcdef');
    expect(seen).toEqual(['sysctl -n kern.bootsessionuuid', BOOT_ID_PATH_LINUX]);
  });

  it('refuses a probe answer that is not a boot id (empty, or a shell error page)', async () => {
    const answers = ['', '   \n', 'sysctl: unknown oid\nusage: sysctl [-bdehiNnoqTtx]', 'x'.repeat(200)];
    for (const text of answers) {
      expect(await bootIdOf({ probe: { exec: () => Promise.resolve(text), read: () => Promise.resolve(text) }, platform: 'darwin' })).toBeNull();
    }
  });

  it('gives up at the deadline when the probe never settles', async () => {
    const started = Date.now();
    const probe: BootProbe = { exec: () => new Promise<string>(() => {}), read: () => new Promise<string>(() => {}) };
    expect(await bootIdOf({ probe, platform: 'darwin', timeoutMs: 40 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(BOOT_ID_DEADLINE_MS * 10);
  });

  it('memoises the default probe per process (the production path spawns at most once)', async () => {
    const first = await bootIdOf();
    const second = await bootIdOf();
    expect(second).toBe(first);
    if (process.platform === 'darwin' || process.platform === 'linux') expect(first).not.toBeNull();
  });
});

// ── F09 (b): `openCoordination` — the composed entry point ────────────────────────────────────────────────────────────

describe('openCoordination', () => {
  it('composes identity, keys, the boot id and the ledger over a temp home; close() releases', async () => {
    const home = await tempHome();
    const r = await openCoordination({
      home,
      workspaceRealpath: '/tmp/ws-facade',
      sessionId: null,
      runId: null,
      jevcodeVersion: '0.3.0',
      redact: (s) => s,
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    });
    cleanups.push(() => r.close());

    // the eleven fields the caller used to assemble by hand
    expect(r.self.deviceId).toMatch(/^[a-z2-7]{8}$/);
    expect(r.self.wsKey).toMatch(/^ws:[0-9a-f]{16}$/);
    expect(r.self.hostKey).toMatch(/^[0-9a-f]{8}$/);
    expect(r.self.repoKey).toBeNull();
    expect(r.self.sessionId).toBeNull();
    expect(Number.isFinite(Date.parse(r.self.bootAt))).toBe(true);
    expect(r.device.status).toBe('created');
    // the handle carries the same identity, and the ledger did no scanning yet (§3.5: zero I/O before open())
    expect(r.ledger.self.deviceId).toBe(r.self.deviceId);
    expect(r.ledger.opened).toBe(false);

    // F09: `bootId` has a producer now — `lockReplaceVerdict`'s `other-boot` branch is reachable on this platform
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(r.self.bootId).not.toBeNull();
      expect(r.ledger.bootId).toBe(r.self.bootId);
    }

    await r.ledger.open();
    expect(r.ledger.opened).toBe(true);
    const entries = await readdir(join(home, 'coordination', 'devices'));
    expect(entries).toEqual([r.self.hostKey]);
    await r.close();
    expect(r.ledger.opened).toBe(false);
  });

  it('takes the repo facts and the boot probe from the caller, and a second open re-loads the same device', async () => {
    const home = await tempHome();
    const probe: BootProbe = { exec: () => Promise.resolve('B00T-0001'), read: () => Promise.resolve('B00T-0001') };
    const opts = {
      home,
      workspaceRealpath: '/tmp/ws-facade-2',
      sessionId: '20260921-120000-aaaaaaaa',
      runId: '20260921-120000-aaaaaaaa',
      jevcodeVersion: '0.3.0',
      branch: 'main',
      bootProbe: probe,
      repo: { rootOids: ['a'.repeat(40)], shallow: false, originUrl: 'git@github.com:acme/repo.git' },
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    };
    const a = await openCoordination(opts);
    cleanups.push(() => a.close());
    expect(a.self.repoKey).toMatch(/^[0-9a-f]{16}$/);
    expect(a.self.remoteKey).toMatch(/^rm:[0-9a-f]{16}$/);
    expect(a.self.branch).toBe('main');
    expect(a.self.runId).toBe('20260921-120000-aaaaaaaa');
    // an injected probe is never memoised, so a test's answer is the one that lands
    expect(a.self.bootId).toBe('B00T-0001');
    await a.close();

    const b = await openCoordination(opts);
    cleanups.push(() => b.close());
    expect(b.device.status).toBe('loaded');
    expect(b.self.deviceId).toBe(a.self.deviceId);
    await b.close();
  });
});

// ── F20 (a): one `Ledger` name, and it is the one `openLedger` returns ────────────────────────────────────────────────

describe('the facade type list', () => {
  it("exports `Ledger` as what `openLedger` returns, so a consumer never meets `asHandle()`'s throw", async () => {
    const home = await tempHome();
    // TYPE-level assertion first: before F20 the facade's `Ledger` was the 7-member base and this annotation did not
    // admit a writer's member, so `npx tsc -p tsconfig.json --noEmit` is where this case fails first.
    const ledger: Ledger = openLedger({
      home,
      self: makeSelf({ runId: null, sessionId: null }),
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    });
    cleanups.push(() => ledger.close());
    expect(typeof ledger.enqueue).toBe('function');
    expect(typeof ledger.writeOwn).toBe('function');
    expect(typeof ledger.forkVerdict).toBe('function');
    // the narrow base is still reachable under its own name, for a READER that holds nothing else
    const base: LedgerBase = ledger;
    expect(typeof base.subscribe).toBe('function');
    await ledger.close();
  });
});

// ── F20 (b): the header claims only importers that exist ──────────────────────────────────────────────────────────────

describe('the facade header', () => {
  it('names the importer that exists and does not claim the three directories that have none', async () => {
    const header = (await readFile('src/coordination/index.ts', 'utf8')).slice(0, 2_000);
    const importers: string[] = [];
    for (const dir of ['src/session', 'src/cli', 'src/tui']) {
      for (const file of await walk(dir)) {
        if ((await readFile(file, 'utf8')).includes('coordination/index.js')) importers.push(file);
      }
    }
    // the claim and the tree must agree; when the TUI wires the facade up, this line is the one that says so
    expect(importers).toEqual([]);
    expect(header).toContain('src/loop/coordination.ts');
    expect(header).not.toContain('the ONLY import path');
  });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

// ── F20 (c): one peer projection ──────────────────────────────────────────────────────────────────────────────────────

describe('peerViewOf', () => {
  it('projects a live same-device peer and two stale ones to exactly what the ⇄ zone displays', () => {
    const status = statusOf([
      peerRow({ runId: 'r-live', sameDevice: true, live: true, beatAgeMs: 4_000 }),
      peerRow({ runId: 'r-stale-1', live: false, beatAgeMs: 900_000 }),
      peerRow({ runId: 'r-stale-2', live: false, beatAgeMs: 300_000 }),
    ]);
    const view: PeerView = peerViewOf(status);
    // the `⇄ <n> live` number and `/peers`'s `<n> here` are now the SAME number, computed from the same array
    expect(view.live).toBe(status.live);
    expect(view).toEqual({ live: 1, stale: 2, oldestStartedMsAgo: 4_000, exclusive: false });
  });

  it('counts a same-device peer exactly as the ⇄ zone counts it (edge 6: two instances in one multiplexer)', () => {
    const status = statusOf([peerRow({ sameDevice: true, live: true }), peerRow({ runId: 'r2', sameDevice: false, live: true })]);
    expect(peerViewOf(status).live).toBe(2);
    expect(peerViewOf(status).stale).toBe(0);
  });

  it('is exclusive exactly while a peer lease is holding this step, and empty for an empty fold', () => {
    const empty = statusOf([]);
    expect(peerViewOf(empty)).toEqual({ live: 0, stale: 0, oldestStartedMsAgo: null, exclusive: false });
    const held = statusOf([peerRow({ live: true, beatAgeMs: 2_000 })], { waiting: { paths: ['src/a.ts'], holder: 'mbp', untilMs: 1_000 } });
    expect(peerViewOf(held).exclusive).toBe(true);
  });

  it('never invents a number from a non-finite or negative beat age', () => {
    const status = statusOf([peerRow({ live: true, beatAgeMs: Number.NaN }), peerRow({ runId: 'r2', live: true, beatAgeMs: -5 })]);
    expect(peerViewOf(status)).toEqual({ live: 2, stale: 0, oldestStartedMsAgo: 0, exclusive: false });
  });
});
