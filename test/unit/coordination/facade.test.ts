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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BOOT_ID_DEADLINE_MS, BOOT_ID_PATH_LINUX, bootIdMemoisable, bootIdOf, type BootProbe } from '../../../src/coordination/boot.js';
import { CoordinationError, commonsPaths, coordinationRoot, hostKeyOf, nodeFs, openCoordination, peerViewOf, readRepoKeyCache, withChecksum } from '../../../src/coordination/index.js';
import type { Ledger, LedgerBase } from '../../../src/coordination/index.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import type { CoordinationStatus, EngineRunPhase, PeerView } from '../../../src/core/types.js';
// F20 (c) is about AGREEING with these three renderers, so the test calls them rather than restating their rules.
import { PEER_LEASE_KEYS, PEER_STALE_KEYS, peerLeaseRows, peerOpenNotice } from '../../../src/tui/blocking/lines.js';
import { peersText } from '../../../src/tui/status/lines.js';
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

/**
 * D8: what a boot id must look like — and it is only required to EXIST under `JEVCODE_LIVE=1`.
 *
 * `bootIdOf`'s default probe spawns `sysctl` on darwin and reads `/proc/sys/kernel/random/boot_id` on linux. A
 * sandbox that blocks `child_process`, a PATH without `sysctl` and a container that masks `/proc/sys` all answer
 * `null` with the module behaving exactly as designed, so asserting non-null on `process.platform` alone makes a
 * correct build fail on a hardened CI. The darwin/linux BRANCHES are covered for value by the injected-probe cases
 * above; what the default path owes here is a well-formed answer or an honest `null`.
 */
function expectBootIdShape(id: string | null | undefined): void {
  expect(id === null || id === undefined || BOOT_ID_SHAPE.test(id)).toBe(true);
  if (process.env['JEVCODE_LIVE'] === '1' && (process.platform === 'darwin' || process.platform === 'linux')) expect(typeof id).toBe('string');
}
const BOOT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

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
    // NOTE: `startedMsAgo` is deliberately NOT defaulted — "the producer reports no start time" is the case that
    // used to be papered over with `beatAgeMs`, so it has to be this helper's default.

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
    expectBootIdShape(first);
  });

  /**
   * D3. `bootIdOf({ timeoutMs })` used to be keyed as "not injected": the call was served the memo (silently
   * ignoring its own deadline) and, cold, WROTE its answer into it. On this host `await bootIdOf({ timeoutMs: 1 })`
   * answered `null` — `sysctl` cannot be spawned in 1 ms — and every later `bootIdOf()` in the process got that
   * `null`, permanently and silently, so `lockReplaceVerdict`'s `other-boot` branch went dead on a machine that
   * reads its boot id perfectly well.
   */
  it('D3: a caller-supplied timeoutMs is neither served from the memo nor written into it', async () => {
    // this host's real answer, from the module the rest of the file has already warmed
    const warm = await bootIdOf();

    // The poisoning needs the 1 ms call to be the FIRST in the process, so the review's input runs against a fresh
    // module registry — a fresh memo is the only thing `vi.resetModules()` is here for.
    vi.resetModules();
    const fresh = await import('../../../src/coordination/boot.js');
    const short = await fresh.bootIdOf({ timeoutMs: 1 });
    expectBootIdShape(short);

    // the default call must still answer what this machine actually says. Before the fix this was the `null` the
    // 1 ms budget produced — permanently, for every later `bootIdOf()` in that process. (On a host that cannot read
    // its boot id at all, `warm` is null too and there was never anything to poison: the claim is agreement, not
    // non-nullness, so a hardened sandbox is not coupled to this case.)
    const dflt = await fresh.bootIdOf();
    expect(dflt).toBe(warm);
    expect(await fresh.bootIdOf()).toBe(dflt);

    // and the memo key itself, because a wrong one is otherwise unobservable: every branch answers `string | null`,
    // so it fails silently and permanently rather than loudly.
    expect(bootIdMemoisable({})).toBe(true);
    expect(bootIdMemoisable({ timeoutMs: 1 })).toBe(false);
    expect(bootIdMemoisable({ timeoutMs: BOOT_ID_DEADLINE_MS })).toBe(false);
    expect(bootIdMemoisable({ probe: failingProbe })).toBe(false);
    expect(bootIdMemoisable({ platform: 'linux' })).toBe(false);
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

    // F09: `bootId` has a producer now, and the handle is seated with whatever it produced. D8: the SHAPE is the
    // assertion — a hardened sandbox that blocks `child_process` or masks `/proc/sys` answers `null` with the code
    // perfectly correct, and this suite is otherwise hermetic. `JEVCODE_LIVE=1` opts into the stronger claim.
    expectBootIdShape(r.self.bootId);
    expect(r.ledger.bootId).toBe(r.self.bootId);

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

  /**
   * D6. The `repo` option's docblock promised that a caller WITHOUT repo facts gets its keys from this host's
   * `repokeys/` cache — but nothing in `src/` had ever called `writeRepoKeyCache` (one caller in the whole tree, a
   * unit test), so that branch could only ever answer `null`, forever, and `openCoordination` threw away the keys
   * it had just derived. Supplying facts now fills the cache, which is the only thing that makes the fallback real.
   */
  it('D6: repo facts fill this host\'s repokeys/ cache, so the no-facts branch has a producer', async () => {
    const home = await tempHome();
    const base = {
      home,
      workspaceRealpath: '/tmp/ws-facade-cache',
      sessionId: null,
      runId: null,
      jevcodeVersion: '0.3.0',
      bootProbe: { exec: () => Promise.resolve('B00T-0002'), read: () => Promise.resolve('B00T-0002') } satisfies BootProbe,
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    };
    const withFacts = await openCoordination({ ...base, repo: { rootOids: ['b'.repeat(40)], shallow: false, originUrl: 'git@github.com:acme/two.git' }, commonDir: '/tmp/ws-facade-cache/.git' });
    cleanups.push(() => withFacts.close());
    await withFacts.close();
    expect(withFacts.self.repoKey).toMatch(/^[0-9a-f]{16}$/);

    // the entry is on disk, under THIS host's subtree, with the kind and the common dir the caller supplied
    const hostDir = commonsPaths(coordinationRoot(home), withFacts.self.hostKey).hostDir;
    expect(await readRepoKeyCache(nodeFs, hostDir, '/tmp/ws-facade-cache')).toMatchObject({
      v: 1,
      repoKey: withFacts.self.repoKey,
      remoteKey: withFacts.self.remoteKey,
      kind: 'roots',
      commonDir60: '/tmp/ws-facade-cache/.git',
    });

    // …and the next open, with no probe of its own, reads them back instead of answering null
    const noFacts = await openCoordination(base);
    cleanups.push(() => noFacts.close());
    expect(noFacts.self.repoKey).toBe(withFacts.self.repoKey);
    expect(noFacts.self.remoteKey).toBe(withFacts.self.remoteKey);
    await noFacts.close();

    // a workspace whose keys have NOT moved is not rewritten: the steady state is a read, not a write, and the
    // entry's own `at` is the witness — a later open with identical facts leaves it exactly where it was
    const at = (await readRepoKeyCache(nodeFs, hostDir, '/tmp/ws-facade-cache'))?.at;
    const again = await openCoordination({ ...base, now: () => Date.parse('2027-01-01T00:00:00.000Z'), repo: { rootOids: ['b'.repeat(40)], shallow: false, originUrl: 'git@github.com:acme/two.git' }, commonDir: '/tmp/ws-facade-cache/.git' });
    cleanups.push(() => again.close());
    await again.close();
    expect((await readRepoKeyCache(nodeFs, hostDir, '/tmp/ws-facade-cache'))?.at).toBe(at);
  });

  /**
   * D7. `'foreign'` (`devices/<hostKey>/device.json` names another host + user, §11 row 27) used to be reported
   * only as a data field, while the `self` handed back in the same object already carried the OTHER machine's
   * `deviceId` and the ledger was ready to write records as that device. A caller that forgot to branch wrote as
   * someone else's device — the one identity rule left for the consumer to know, in the entry point that exists so
   * consumers need not know identity rules.
   */
  it('D7: a foreign device.json refuses by default, and is reported only when the caller opts in', async () => {
    const home = await tempHome();
    const base = {
      home,
      workspaceRealpath: '/tmp/ws-facade-foreign',
      sessionId: null,
      runId: null,
      jevcodeVersion: '0.3.0',
      hostname: 'mbp.local',
      username: 'ann',
      bootProbe: { exec: () => Promise.resolve('B00T-0003'), read: () => Promise.resolve('B00T-0003') } satisfies BootProbe,
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    };
    const mine = await openCoordination(base);
    cleanups.push(() => mine.close());
    await mine.close();

    // hand-edit the record under MY OWN hostKey to name another host and user (§3.2's one remaining ask)
    const hostKey = hostKeyOf('mbp.local', 'ann');
    const file = join(commonsPaths(coordinationRoot(home), hostKey).hostDir, 'device.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const theirs = withChecksum({ ...stored, host: 'studio.local', user: 'bob', checksum: '' });
    await nodeFs.writeAtomic(file, `${JSON.stringify(theirs)}\n`, { fsync: false, mode: 0o600 });

    await expect(openCoordination(base)).rejects.toThrow(CoordinationError);
    await expect(openCoordination(base)).rejects.toMatchObject({ code: 'not-ours' });

    // opting in is how a surface that WILL prompt gets the record; nothing has been written and the ledger is shut
    const opted = await openCoordination({ ...base, allowForeign: true });
    cleanups.push(() => opted.close());
    expect(opted.device.status).toBe('foreign');
    expect(opted.device.device.host).toBe('studio.local');
    expect(opted.ledger.opened).toBe(false);
    await opted.close();
  });

  /**
   * D9. `os.uptime()` was the one unwrapped OS read in `bootAtOf`, beside `os.hostname()` and `os.userInfo()`,
   * which are wrapped precisely so "a container with no passwd entry" degrades. A throw here escaped
   * `openCoordination` and took the surface's whole startup with it, where the documented intent is "a worse
   * `hostKey`/`bootAt`, never a crash".
   */
  it('D9: an OS read that throws degrades bootAt to now, it does not take startup down', async () => {
    const home = await tempHome();
    const nowMs = Date.parse('2026-09-21T12:00:00.000Z');
    const r = await openCoordination({
      home,
      workspaceRealpath: '/tmp/ws-facade-uptime',
      sessionId: null,
      runId: null,
      jevcodeVersion: '0.3.0',
      now: () => nowMs,
      uptimeMs: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
      bootProbe: { exec: () => Promise.resolve('B00T-0004'), read: () => Promise.resolve('B00T-0004') },
      watch: (() => {
        throw Object.assign(new Error('no fs.watch in tests'), { code: 'ENOSYS' });
      }) as never,
    });
    cleanups.push(() => r.close());
    expect(r.self.bootAt).toBe('2026-09-21T12:00:00.000Z');
    await r.close();
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
  /**
   * D4 / D5. The first cut of this case did two things it could not do.
   *
   * D4: `expect(header).not.toContain('the ONLY import path')` passed only because the header happens to WRAP
   * between `ONLY` and `import` — the sentence is still in there, quoting the old claim. So the guard asserted
   * nothing, and would have fired on a reflow that changed no fact. Normalising the comment furniture first is what
   * makes it mean something; after normalising, the phrase IS present (once, in quotes, in the past tense), so the
   * honest assertion is "exactly one mention, and it is the retrospective one".
   *
   * D5: the importer walk was a tripwire that could not distinguish "an importer appeared and the sentence did not
   * move" from "the TUI wiring landed and the sentence moved with it" — it failed on both, which is what index.ts
   * claimed it did NOT do. It now reads the claim out of the header and checks exactly the directories the header
   * names, so updating the sentence updates the test. It also resolves specifiers instead of grepping for a path
   * string: a doc comment that mentions `coordination/index.js` is not an importer, and `from '../coordination'` is.
   */
  it('D4: says what is true about the header, not what is absent from its prose', async () => {
    const flat = flatHeader(await readFile('src/coordination/index.ts', 'utf8'));
    expect(flat).toContain('the engine imports it through `src/loop/coordination.ts`');
    expect(flat).toContain('`src/session/**`, `src/cli/**` and `src/tui/**` have no importer yet');
    // the discarded claim survives ONCE, in the past tense and in quotes; re-asserting it as fact fails here
    expect(flat.split('the ONLY import path').length - 1).toBe(1);
    expect(flat).toContain('The header used to call this "the ONLY import path for');
  });

  it('D5: checks exactly the directories the header claims have no importer, by resolving specifiers', async () => {
    const flat = flatHeader(await readFile('src/coordination/index.ts', 'utf8'));
    const claimed = dirsClaimedImporterFree(flat);
    // the parse itself is an assertion: a rewritten sentence this cannot read would silently check nothing
    expect(claimed).toEqual(['src/session', 'src/cli', 'src/tui']);
    for (const dir of claimed) expect([dir, await facadeImportersIn(dir)]).toEqual([dir, []]);

    // and the walk really does find an importer: the one the header DOES claim is checked the same way
    expect(await facadeImportersIn('src/loop')).toContain('src/loop/coordination.ts');
  });

  it('D5: a mention is not an importer, and an extensionless import is', () => {
    const doc = "/** see src/coordination/index.js for the facade */\nimport { x } from './local.js';";
    expect(importsFacadeFrom('src/tui/pane.ts', doc)).toBe(false);
    expect(importsFacadeFrom('src/tui/pane.ts', "import { openLedger } from '../coordination/index.js';")).toBe(true);
    expect(importsFacadeFrom('src/tui/pane.ts', "import { openLedger } from '../coordination';")).toBe(true);
    expect(importsFacadeFrom('src/tui/pane.ts', "const m = await import('../coordination/index.js');")).toBe(true);
    // the engine's own module is `src/loop/coordination.ts`, a FILE with a similar specifier — never the facade
    expect(importsFacadeFrom('src/loop/engine.ts', "import { x } from './coordination.js';")).toBe(false);
  });
});

/** the header with its comment furniture folded away, so an assertion on it cannot be broken by a reflow */
function flatHeader(text: string): string {
  return text.slice(0, 2_500).replace(/\n\s*\*\s?/g, ' ');
}

/** the directories the header CLAIMS have no importer, parsed out of the sentence that claims it */
function dirsClaimedImporterFree(flat: string): string[] {
  const m = /([^.]*?) have no importer yet/.exec(flat);
  if (m === null || m[1] === undefined) return [];
  return [...m[1].matchAll(/`src\/([a-z]+)\/\*\*`/g)].map((x) => `src/${x[1]}`);
}

const FACADE_MODULES = new Set([resolve('src/coordination/index'), resolve('src/coordination')]);

/** true when `text` really IMPORTS the facade — a resolved specifier, not a path string anywhere in the file */
function importsFacadeFrom(file: string, text: string): boolean {
  const dir = dirname(file);
  for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec === undefined || !spec.startsWith('.')) continue;
    if (FACADE_MODULES.has(resolve(dir, spec).replace(/\.(?:js|ts|tsx)$/, ''))) return true;
  }
  return false;
}

async function facadeImportersIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await walk(dir)) if (importsFacadeFrom(file, await readFile(file, 'utf8'))) out.push(file);
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

// ── F20 (c): one peer projection, and it is the one the three renderers already read ─────────────────────────────────

/**
 * D1 / D2 — the item, finished.
 *
 * The first cut shipped `peerViewOf` and tested it against itself. It copied `CoordinationStatus.live` into
 * `PeerView.live`, but those two numbers do not mean the same thing: `CoordinationStatus.peers` is "one row per peer
 * run that is NOT this run" (§3.6), while every `PeerView` consumer reads `live` as the number of instances here
 * INCLUDING this one. So the one projection F20 (c) exists to make the surfaces agree made all three of them show
 * the wrong thing for the exact case they exist for — which is why these cases assert through the real renderers
 * instead of restating the arithmetic.
 *
 * D2 is the second half: `oldestStartedMsAgo` was filled with `max(beatAgeMs)`, and both consumers render it
 * verbatim as a START age. A live row's beat age is bounded ABOVE by the honoured heartbeat TTL, so an instance
 * that had been running all day was reported as "started 4s ago".
 */
describe('peerViewOf', () => {
  it('D1: one other live instance holding an exclusive lease — all three surfaces say so', () => {
    const status = statusOf([peerRow({ runId: 'r-live', live: true, beatAgeMs: 4_000, startedMsAgo: 240_000 })], {
      waiting: { paths: ['src/a.ts'], holder: 'mbp', untilMs: 1_000 },
    });
    const view: PeerView = peerViewOf(status);

    // `PeerView.live` counts instances HERE, this one included: `status.live` (self-exclusive) plus this run
    expect(view.live).toBe(2);
    expect(view.live).toBe(status.live + 1);
    expect(view).toEqual({ live: 2, stale: 0, oldestStartedMsAgo: 240_000, exclusive: true });

    // the ⇄ zone IS `peersText(PeerView)` — there is no separate renderer — and it must not be empty here
    expect(peersText(view)).toBe('2 here');
    // the `[ui]` item at session open
    expect(peerOpenNotice(view)).toBe('another jevcode is working in this workspace (started 4m ago) — /peers lists them');
    // and the blocking pane offers the wait, never `[c] continue` with a nonsense '0 stale entries'
    const rows = peerLeaseRows(view);
    expect(rows.title).toEqual(['another jevcode holds this workspace (2 here)']);
    expect(rows.keys).toBe(PEER_LEASE_KEYS);
  });

  it('D1: a lone instance is `live: 1`, and every surface stays quiet', () => {
    const view = peerViewOf(statusOf([]));
    expect(view).toEqual({ live: 1, stale: 0, oldestStartedMsAgo: null, exclusive: false });
    expect(peersText(view)).toBe('');
    expect(peerOpenNotice(view)).toBeNull();
    // NOTE for the integrator (out of slot): `/peers`' empty state in `src/cli/session.ts` tests
    // `view.live === 0 && view.stale === 0` and must become `view.live <= 1 && view.stale === 0`.
  });

  it('projects a live same-device peer and two stale ones to exactly what the ⇄ zone displays', () => {
    const status = statusOf([
      peerRow({ runId: 'r-live', sameDevice: true, live: true, beatAgeMs: 4_000, startedMsAgo: 4_000 }),
      peerRow({ runId: 'r-stale-1', live: false, beatAgeMs: 900_000, startedMsAgo: 900_000 }),
      peerRow({ runId: 'r-stale-2', live: false, beatAgeMs: 300_000, startedMsAgo: 300_000 }),
    ]);
    const view: PeerView = peerViewOf(status);
    expect(view).toEqual({ live: 2, stale: 2, oldestStartedMsAgo: 4_000, exclusive: false });
    expect(view.live).toBe(status.live + 1);
    // a stale row's age is never the start age: it measures when a DEAD instance stopped
    expect(peersText(view)).toBe('2 here · 2 stale');
  });

  it('edge 1: only stale rows — the zone is empty and the pane offers [c] continue with the real count', () => {
    const view = peerViewOf(statusOf([peerRow({ runId: 'r-stale', live: false, beatAgeMs: 900_000 })]));
    expect(view).toEqual({ live: 1, stale: 1, oldestStartedMsAgo: null, exclusive: false });
    expect(peersText(view)).toBe('');
    const rows = peerLeaseRows(view);
    expect(rows.title).toEqual(['the peer registry lists 1 stale entry for this workspace']);
    expect(rows.keys).toBe(PEER_STALE_KEYS);
  });

  it('counts a same-device peer exactly as the ⇄ zone counts it (edge 6: two instances in one multiplexer)', () => {
    const status = statusOf([peerRow({ sameDevice: true, live: true }), peerRow({ runId: 'r2', sameDevice: false, live: true })]);
    expect(peerViewOf(status).live).toBe(3);
    expect(peerViewOf(status).stale).toBe(0);
    expect(peersText(peerViewOf(status))).toBe('3 here');
  });

  it('is exclusive exactly while a peer lease is holding this step', () => {
    const held = statusOf([peerRow({ live: true, beatAgeMs: 2_000 })], { waiting: { paths: ['src/a.ts'], holder: 'mbp', untilMs: 1_000 } });
    expect(peerViewOf(held).exclusive).toBe(true);
    expect(peerViewOf(statusOf([peerRow({ live: true })])).exclusive).toBe(false);
  });

  it('D2: declines a start age rather than substituting a heartbeat age', () => {
    // the review's input: a peer that may have been running all day, whose last beat landed 4 s ago
    const status = statusOf([peerRow({ live: true, beatAgeMs: 4_000 })]);
    const view = peerViewOf(status);
    expect(view.oldestStartedMsAgo).toBeNull();
    // `/peers` prints '—' and the open notice drops the parenthetical; neither says "started 4s ago"
    expect(peerOpenNotice(peerViewOf(statusOf([peerRow({ live: true, beatAgeMs: 4_000 }), peerRow({ runId: 'r2', live: true, beatAgeMs: 1_000 })])))).toBe(
      'another jevcode is working in this workspace — /peers lists them',
    );
  });

  it('D2: the start age is the LONGEST-running live peer, and a stale row never contributes', () => {
    const status = statusOf([
      peerRow({ runId: 'r1', live: true, beatAgeMs: 1_000, startedMsAgo: 60_000 }),
      peerRow({ runId: 'r2', live: true, beatAgeMs: 2_000, startedMsAgo: 3_600_000 }),
      peerRow({ runId: 'r3', live: false, beatAgeMs: 900_000, startedMsAgo: 86_400_000 }),
    ]);
    expect(peerViewOf(status).oldestStartedMsAgo).toBe(3_600_000);
    expect(peerOpenNotice(peerViewOf(status))).toContain('(started 1h ago)');
  });

  it('never invents a number from a non-finite or negative start age', () => {
    const status = statusOf([peerRow({ live: true, startedMsAgo: Number.NaN }), peerRow({ runId: 'r2', live: true, startedMsAgo: -5 })]);
    expect(peerViewOf(status)).toEqual({ live: 3, stale: 0, oldestStartedMsAgo: 0, exclusive: false });
  });
});
