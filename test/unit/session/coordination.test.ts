/**
 * TUI-DESIGN-5 §2.10 / §12.1 / §13.3 — **gap 1**: `openCoordination()`, the production constructor
 * `docs/STATUS.md`'s "Not driven by a store in this build" item 1 says nothing had.
 *
 * Three things are under test, and the third is the reason the file exists:
 *
 *  1. **The pre-flight** (`src/session/coordination.ts`): coordination off in the configuration, and a home that
 *     cannot be written, are two different answers with two different sentences — and both keep the landed
 *     `the session ledger is not available in this build` as their PREFIX, so every pin in
 *     `test/unit/cli/sessions.test.ts` and `test/pty/round5.pty.test.ts` still matches.
 *  2. **Every one of the thirteen coordination verbs, over an injected ledger.** The coordination facade is
 *     mocked at the module boundary — the same seam `publish-ledger.test.ts` uses — with the REAL `listSessions`,
 *     `inbox`, `messageOrigin` and `authorityOf` behind it, so the projections are exercised, not stubbed.
 *  3. **The property §10 asks for: no string any verb prints carries a path, a pid or a `hostKey`** (§7 row 61),
 *     over all four fold fixtures (no peers, one live, one stale, a cloned device) and every verb's stdout.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Ack, DeviceRecord, Fold, Heartbeat, Liveness, Message, SelfIdentity, SyncStatus } from '../../../src/coordination/index.js';
import { emptyFold } from '../../../src/coordination/fold.js';
import { BOOT, DEV_A, DEV_B, SELF, T0, TRUSTED, UNVERIFIED, iso, makeAck, makeDevice, makeHeartbeat, makeMessage, makeSelf, runId } from '../coordination/helpers.js';

// ── the fixture state every mocked facade member reads ───────────────────────────────────────────────────────────

const NOW = { wallMs: T0, monoMs: 1_000_000 };

const spy = vi.hoisted(() => ({
  fold: null as Fold | null,
  opened: 0,
  closed: 0,
  refreshed: 0,
  subscribed: 0,
  unsubscribed: 0,
  sent: [] as { to: string; type: string; text: string }[],
  sendThrows: null as string | null,
  trusted: [] as { deviceId: string; label: string; pairedAt: string }[],
  labelled: [] as string[],
  unpaired: [] as string[],
  ignored: [] as string[],
  gcCalls: 0,
  syncDisabled: 0,
  sync: { mode: 'off', state: 'off', code: null, lagMs: null, pending: 0, offlineForMs: null, refused: null } as SyncStatus,
  openLedgerThrows: null as string | null,
  deviceIdThrows: null as string | null,
  allDeviceIds: [] as string[],
  /** every `openLedger({...})` this process saw — the blocker-1 and finding-13 assertions read it */
  openOptions: [] as { actor8?: string; scanOnly?: boolean }[],
  actor8Minted: 0,
  watchers: 0,
  resolveDeviceRefCalls: [] as string[],
}));

vi.mock('../../../src/coordination/index.js', async () => {
  const fold = await import('../../../src/coordination/fold.js');
  const claims = await import('../../../src/coordination/claims.js');
  const mailbox = await import('../../../src/coordination/mailbox.js');
  const handle = {
    get fold(): Fold {
      return spy.fold!;
    },
    paths: { hostDir: '/tmp/host' },
    open: async (): Promise<void> => {
      spy.opened += 1;
    },
    close: async (): Promise<void> => {
      spy.closed += 1;
    },
    refresh: async (): Promise<void> => {
      spy.refreshed += 1;
    },
    subscribe: (): (() => void) => {
      spy.subscribed += 1;
      return (): void => {
        spy.unsubscribed += 1;
      };
    },
    allDeviceIds: async (): Promise<string[]> => spy.allDeviceIds,
    resolveDeviceRef: (ref: string, extra: readonly string[]): string | null => {
      spy.resolveDeviceRefCalls.push(ref);
      // the real one also understands `label#id4`; the fixture models the HEAD of that grammar
      const head = ref.includes('#') ? (ref.split('#')[1] ?? '') : ref;
      return extra.find((d) => d === head || d.startsWith(head)) ?? null;
    },
  };
  const records = await import('../../../src/coordination/records.js');
  return {
    publicMessage: records.publicMessage,
    coordinationRoot: (home: string) => `${home}/coordination`,
    nodeFs: {},
    deviceIdentity: async () => {
      if (spy.deviceIdThrows !== null) throw new Error(spy.deviceIdThrows);
      return { device: makeDevice(), hostKey: 'deadbeefcafe1234deadbeefcafe1234' };
    },
    wsKeyOf: () => 'ws:3f9a2c1d8bc0d11e',
    mintActor8: (): string => {
      spy.actor8Minted += 1;
      // base32 (`ACTOR8_RE`), distinct per call — exactly what the real `mintActor8` guarantees
      return `aaaaaaa${'bcdefghijklmnop'[spy.actor8Minted % 15] ?? 'b'}`;
    },
    openLedger: (o: { actor8?: string; scanOnly?: boolean }) => {
      spy.openOptions.push({ ...(o.actor8 !== undefined ? { actor8: o.actor8 } : {}), ...(o.scanOnly !== undefined ? { scanOnly: o.scanOnly } : {}) });
      // `LedgerImpl.open()` builds a watcher unless `scanOnly` is set (`ledger.ts:547`)
      if (o.scanOnly !== true) spy.watchers += 1;
      if (spy.openLedgerThrows !== null) throw new Error(spy.openLedgerThrows);
      return handle;
    },
    // the REAL projections: the verbs must exercise them, not a stub of them
    listSessions: fold.listSessions,
    messageOrigin: fold.messageOrigin,
    authorityOf: claims.authorityOf,
    inbox: mailbox.inbox,
    loadSeen: async () => new Set<string>(),
    readTrusted: async () => spy.trusted,
    send: async (_l: unknown, m: { to: string; type: string; text: string }) => {
      if (spy.sendThrows !== null) throw new Error(spy.sendThrows);
      spy.sent.push(m);
      // the real id is `<deviceId>-<actor8>-<n>` (`MSG_ID_RE`); the fixture keeps the actor8 term, which is the
      // whole point of blocker 1 — two processes over one home must not mint the same id
      return { id: `${DEV_A}-${spy.openOptions.at(-1)?.actor8 ?? 'abcdefgh'}-${spy.sent.length}`, path: '/tmp/msg.json' };
    },
    setDeviceLabel: async (_l: unknown, label: string): Promise<DeviceRecord> => {
      spy.labelled.push(label);
      return makeDevice({ label });
    },
    unpairDeviceOn: async (_l: unknown, ref: string): Promise<void> => {
      spy.unpaired.push(ref);
    },
    ignoreDeviceOn: async (_l: unknown, ref: string): Promise<void> => {
      spy.ignored.push(ref);
    },
    gc: async () => {
      spy.gcCalls += 1;
      return { removed: 3, byKind: { heartbeat: 1, lease: 1, message: 1, ack: 0 }, seen: 0, staleLanes: [], failed: [] };
    },
    syncStatus: () => spy.sync,
    syncDisable: async () => {
      spy.syncDisabled += 1;
      return { removed: ['runs', 'inbox'] };
    },
  };
});

const { openCoordination, commandSessions, SESSIONS_VERBS } = await import('../../../src/cli/sessions.js');
type SessionsIo = import('../../../src/cli/sessions.js').SessionsIo;
const { COORDINATION_NOT_OPENABLE, COORDINATION_UNAVAILABLE, COORDINATION_OFF_CLAUSE, coordinationAvailability, coordinationEnabledFrom, coordinationHomeWritable, coordinationOffText, withoutPaths } = await import('../../../src/session/coordination.js');

// ── fold fixtures: 0 peers, one live, one stale, a cloned device ─────────────────────────────────────────────────

interface Row {
  hb: Heartbeat;
  liveness: Liveness;
  where: 'live' | 'gone';
}

function foldOf(rows: readonly Row[], patch: Partial<Fold> = {}): Fold {
  const f = emptyFold(NOW);
  for (const r of rows) {
    const withArrival = { ...r.hb, arrivalMono: NOW.monoMs - 2_000 };
    f.origins.set(`${r.hb.deviceId}/${r.hb.runId}`, r.hb.deviceId === DEV_A ? SELF : TRUSTED);
    f.liveness.set(`${r.hb.deviceId}/${r.hb.runId}/${r.hb.pid}`, r.liveness);
    if (r.where === 'live') f.live.set(r.hb.runId, withArrival);
    else f.gone.set(r.hb.runId, { ...withArrival, goneAtMono: NOW.monoMs - 60_000 });
    f.devices.set(r.hb.deviceId, { ...makeDevice({ deviceId: r.hb.deviceId, label: r.hb.label }), lastSeen: iso(T0), syncLagMs: null, ignored: false, cloned: false });
  }
  return { ...f, ...patch };
}

const SELF_ID: SelfIdentity = makeSelf({ hostKey: 'deadbeefcafe1234deadbeefcafe1234', runId: null, sessionId: null });
const PEER = makeHeartbeat({ deviceId: DEV_B, label: 'air', pid: 7, runId: runId(2), sessionId: runId(2), title60: 'rotate the store' });

const FIXTURES: Readonly<Record<'none' | 'live' | 'stale' | 'cloned', () => Fold>> = {
  none: () => emptyFold(NOW),
  live: () => foldOf([{ hb: PEER, liveness: 'live', where: 'live' }]),
  stale: () => foldOf([{ hb: PEER, liveness: 'stale', where: 'gone' }]),
  cloned: () => {
    const f = foldOf([{ hb: PEER, liveness: 'live', where: 'live' }]);
    f.cloned.add(DEV_B);
    const d = f.devices.get(DEV_B);
    if (d !== undefined) f.devices.set(DEV_B, { ...d, cloned: true });
    return f;
  },
};

const HOME_OK = { access: async (): Promise<void> => undefined };
const HOME_RO = {
  access: async (): Promise<void> => {
    throw new Error('EACCES: permission denied');
  },
};
/** a home that does NOT exist yet: `access(home)` is ENOENT, `access(parent)` succeeds — the probe must not create it */
function homeAbsent(paths: string[]): { access: (p: string, mode: number) => Promise<void> } {
  return {
    access: async (p: string): Promise<void> => {
      paths.push(p);
      if (p === '/home/u/.jevcode') {
        const e = new Error("ENOENT: no such file or directory, access '/home/u/.jevcode'") as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
      }
    },
  };
}

const INPUT = { home: '/home/u/.jevcode', workspace: '/w/repo', hostname: 'mbp.local', username: 'p', jevcode: '0.5.0', pid: 4242, redact: (s: string): string => s, bootAt: BOOT, homeIo: HOME_OK };

function io(): SessionsIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (s: string) => out.push(s), columns: 120 },
    stderr: { write: (s: string) => err.push(s) },
    runsDir: '/home/u/.jevcode/runs',
    indexPath: '/home/u/.jevcode/sessions/index.jsonl',
    workspace: '/w/repo',
    redact: (s: string) => s,
    now: () => T0,
  };
}

beforeEach(() => {
  spy.fold = FIXTURES.live();
  spy.opened = 0;
  spy.closed = 0;
  spy.refreshed = 0;
  spy.subscribed = 0;
  spy.unsubscribed = 0;
  spy.sent = [];
  spy.sendThrows = null;
  spy.trusted = [];
  spy.labelled = [];
  spy.unpaired = [];
  spy.ignored = [];
  spy.gcCalls = 0;
  spy.syncDisabled = 0;
  spy.sync = { mode: 'off', state: 'off', code: null, lagMs: null, pending: 0, offlineForMs: null, refused: null };
  spy.openLedgerThrows = null;
  spy.deviceIdThrows = null;
  spy.allDeviceIds = [DEV_A, DEV_B, 'ffffffff'];
  spy.openOptions = [];
  spy.actor8Minted = 0;
  spy.watchers = 0;
  spy.resolveDeviceRefCalls = [];
});

// ── 1. the pre-flight (src/session/coordination.ts) ──────────────────────────────────────────────────────────────

describe('the pre-flight: which of the two reasons (§12.1, gap 1)', () => {
  it('`coordination.claims = off` is the off switch, and an absent / unreadable setting is ON', () => {
    expect(coordinationEnabledFrom(() => undefined)).toBe(true);
    expect(coordinationEnabledFrom((n) => (n === 'coordination.claims' ? 'advisory' : undefined))).toBe(true);
    expect(coordinationEnabledFrom((n) => (n === 'coordination.claims' ? 'strict' : undefined))).toBe(true);
    expect(coordinationEnabledFrom((n) => (n === 'coordination.claims' ? 'off' : undefined))).toBe(false);
    expect(coordinationEnabledFrom((n) => (n === 'coordination.claims' ? ' OFF ' : undefined))).toBe(false);
  });

  it('`coordination.enabled` — the row a later build may add — WINS over `coordination.claims`, so the swap is no edit', () => {
    const read = (n: string): string | undefined => (n === 'coordination.enabled' ? 'false' : n === 'coordination.claims' ? 'advisory' : undefined);
    expect(coordinationEnabledFrom(read)).toBe(false);
    expect(coordinationEnabledFrom((n) => (n === 'coordination.enabled' ? 'true' : n === 'coordination.claims' ? 'off' : undefined))).toBe(true);
  });

  it('an unwritable home is `false`, a writable one `true`, and neither ever throws', async () => {
    await expect(coordinationHomeWritable('/x', HOME_OK)).resolves.toBe(true);
    await expect(coordinationHomeWritable('/x', HOME_RO)).resolves.toBe(false);
  });

  /**
   * Fix pass, finding 16: a probe that asks "can a ledger be opened here?" must not be the thing that makes it
   * openable. The old form ran `mkdir -p` first, so merely typing `/who` or `/peers` in a session whose
   * coordination never opens created the whole `JEVCODE_HOME` tree.
   */
  it('a home that does not exist is probed through its PARENT, and the probe creates nothing', async () => {
    const seen: string[] = [];
    await expect(coordinationHomeWritable('/home/u/.jevcode', homeAbsent(seen))).resolves.toBe(true);
    expect(seen).toEqual(['/home/u/.jevcode', '/home/u']);

    // ... and over the REAL filesystem: a non-existent home stays non-existent
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-preflight-'));
    const home = path.join(base, 'not-there', 'jevcode');
    try {
      await expect(coordinationHomeWritable(path.join(base, 'not-there'))).resolves.toBe(true);
      expect(await fs.readdir(base)).toEqual([]);
      // two levels down the PARENT is missing too, so the honest answer is `false` and still nothing is created
      await expect(coordinationHomeWritable(home)).resolves.toBe(false);
      expect(await fs.readdir(base)).toEqual([]);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('configuration is reported BEFORE the disk: a user who turned it off is not told their disk is broken', async () => {
    const off = (n: string): string | undefined => (n === 'coordination.claims' ? 'off' : undefined);
    await expect(coordinationAvailability({ home: '/x', read: off, io: HOME_RO })).resolves.toEqual({ kind: 'off', reason: 'disabled' });
    await expect(coordinationAvailability({ home: '/x', io: HOME_RO })).resolves.toEqual({ kind: 'off', reason: 'unwritable' });
    await expect(coordinationAvailability({ home: '/x', io: HOME_OK })).resolves.toEqual({ kind: 'on' });
  });

  it('every sentence keeps the landed one as its PREFIX and names the cause — and carries no path, pid or key', () => {
    for (const reason of ['disabled', 'unwritable'] as const) {
      const text = coordinationOffText(COORDINATION_UNAVAILABLE, reason);
      expect(text.startsWith(COORDINATION_UNAVAILABLE), reason).toBe(true);
      expect(text).toContain(COORDINATION_OFF_CLAUSE[reason]);
      expectNoSecrets(text);
    }
    // `null` is a build with no wiring at all: the bare sentence, unchanged (N6)
    expect(coordinationOffText(COORDINATION_UNAVAILABLE, null)).toBe(COORDINATION_UNAVAILABLE);
  });

  it('the disabled clause names the setting a user can actually change', () => {
    expect(COORDINATION_OFF_CLAUSE.disabled).toContain('coordination.claims = off');
    expect(COORDINATION_OFF_CLAUSE.disabled).toContain('jevcode config set coordination.claims advisory');
  });
});

// ── 2. openCoordination: the three off answers, and the open one ─────────────────────────────────────────────────

describe('openCoordination (§2.10, gap 1) — the constructor', () => {
  it('off by configuration: no ledger is opened at all', async () => {
    const r = await openCoordination({ ...INPUT, read: (n) => (n === 'coordination.claims' ? 'off' : undefined) });
    expect(r.kind).toBe('off');
    if (r.kind !== 'off') throw new Error('unreachable');
    expect(r.reason).toBe('disabled');
    expect(r.message.startsWith(COORDINATION_UNAVAILABLE)).toBe(true);
    expect(spy.opened).toBe(0);
  });

  it('an unwritable home: no ledger is opened, and the sentence says so without naming the directory', async () => {
    const r = await openCoordination({ ...INPUT, homeIo: HOME_RO });
    expect(r.kind).toBe('off');
    if (r.kind !== 'off') throw new Error('unreachable');
    expect(r.reason).toBe('unwritable');
    expect(spy.opened).toBe(0);
    expect(r.message).not.toContain(INPUT.home);
    expectNoSecrets(r.message);
  });

  /**
   * Fix pass, finding 2 (a blocker): the cause is stripped of paths BEFORE the redactor, and the base sentence
   * is no longer the "in this build" one.
   *
   * The landed version ran the cause through `io.redact` only, and `createRedactor` substitutes known secret
   * VALUES plus API-key SHAPES — nothing in it strips a path, so every errno message printed its absolute path
   * to stderr. The only test of the path injected a bespoke path-stripping redactor, so production was
   * unmeasured; this one uses `createRedactor`, the one the CLI really builds.
   */
  it('a ledger that THROWS is a value, names the HOME not the build, and loses its path under the PRODUCTION redactor', async () => {
    spy.openLedgerThrows = "ENOTDIR: not a directory, mkdir '/Users/p/.jevcode/coordination/devices/4d4e6845'";
    const { createRedactor } = await import('../../../src/core/redact.js');
    const production = createRedactor([{ name: 'generator.apiKey', value: `sk-${'x'.repeat(40)}` }]);
    const r = await openCoordination({ ...INPUT, redact: (x) => production.redact(x) });
    expect(r.kind).toBe('off');
    if (r.kind !== 'off') throw new Error('unreachable');
    expect(r.reason).toBe('error');
    // the base names the HOME, not the build: a build that can throw ENOTDIR from `openLedger` plainly has a ledger
    expect(r.message.startsWith(COORDINATION_NOT_OPENABLE)).toBe(true);
    expect(r.message).not.toContain(COORDINATION_UNAVAILABLE);
    // the errno and the syscall survive — the path, and the hostKey its basename is, do not
    expect(r.message).toContain('ENOTDIR');
    expect(r.message).toContain('<path>');
    expect(r.message).not.toContain('4d4e6845');
    expectNoSecrets(r.message);
  });

  /**
   * Fix pass, blocker 1. Without `actor8` the ledger takes the SESSIONLESS path: it persists `tuiActor8` in
   * `machine.json` and reuses it on every launch, while the stamp counter `n` is seeded only from records the
   * process can fold — and a message addressed at a PEER's sessionId is not in our own target set. Three
   * consecutive `jevcode sessions tell` processes therefore minted the SAME `<deviceId>-<actor8>-<n>`, and
   * `foldRecords` drops duplicate ids, so two of the three messages were silently lost while the CLI printed
   * `delivered to 1 session` for each.
   */
  it('two CLI processes over one home mint DIFFERENT message ids (blocker 1)', async () => {
    const one = await openOk();
    const two = await openOk();
    const a = await one.send({ to: runId(2), type: 'note', text: 'first' });
    const b = await two.send({ to: runId(2), type: 'note', text: 'second' });
    expect(spy.actor8Minted).toBe(2);
    expect(spy.openOptions.map((o) => o.actor8)).toHaveLength(2);
    expect(spy.openOptions[0]?.actor8).not.toBe(spy.openOptions[1]?.actor8);
    expect(a.messageId).not.toBe(b.messageId);
    // the id really is `<deviceId>-<actor8>-<n>` (`MSG_ID_RE`), so the actor8 term is what makes it unique
    expect(a.messageId).toMatch(/^[a-z2-7]{8}-[a-z2-7]{8}-\d{1,9}$/);
    await one.close();
    await two.close();
  });

  it('an injected `actor8` wins, so a caller that already resolved one is not overridden', async () => {
    const r = await openCoordination({ ...INPUT, actor8: 'qqqqqqqq' });
    if (r.kind !== 'open') throw new Error('unreachable');
    expect(spy.openOptions[0]?.actor8).toBe('qqqqqqqq');
    expect(spy.actor8Minted).toBe(0);
    await r.coordination.close();
  });

  /**
   * Fix pass, finding 13: a one-shot verb exits milliseconds later and passes no `onChange`, so the `fs.watch`
   * handles on every device subtree and the 15 s poll timer `open()` builds had no consumer at all.
   */
  it('the CLI path opens a SCAN-ONLY ledger; a caller that wants changes gets the watcher', async () => {
    const quiet = await openOk();
    expect(spy.openOptions[0]?.scanOnly).toBe(true);
    expect(spy.watchers).toBe(0);
    await quiet.close();

    const live = await openCoordination({ ...INPUT, onChange: () => undefined });
    if (live.kind !== 'open') throw new Error('unreachable');
    expect(spy.openOptions[1]?.scanOnly).toBeUndefined();
    expect(spy.watchers).toBe(1);
    await live.coordination.close();
  });

  it('a device identity that throws is the same value answer', async () => {
    spy.deviceIdThrows = 'EACCES';
    const r = await openCoordination(INPUT);
    expect(r.kind).toBe('off');
  });

  it('on: ONE `openLedger`, ONE `open()`, and the mount read happens before any verb answers (§15.2)', async () => {
    const r = await openCoordination(INPUT);
    expect(r.kind).toBe('open');
    if (r.kind !== 'open') throw new Error('unreachable');
    expect(spy.opened).toBe(1);
    // the read-half identity: a CLI twin is NOT a session, so it can never appear in its own `who`
    const rows = await r.coordination.activity({ all: true });
    expect(rows.map((x) => x.runId)).toEqual([runId(2)]);
    await r.coordination.close();
    expect(spy.closed).toBe(1);
  });

  it('a reader subscribes only when a caller wants changes, and `close()` drops the subscription with the handle', async () => {
    const quiet = await openCoordination(INPUT);
    if (quiet.kind !== 'open') throw new Error('unreachable');
    expect(spy.subscribed).toBe(0);
    await quiet.coordination.close();

    let changes = 0;
    const live = await openCoordination({ ...INPUT, onChange: () => (changes += 1) });
    if (live.kind !== 'open') throw new Error('unreachable');
    expect(spy.subscribed).toBe(1);
    await live.coordination.close();
    expect(spy.unsubscribed).toBe(1);
    expect(changes).toBe(0);
  });
});

// ── 3. every verb, over the injected ledger ──────────────────────────────────────────────────────────────────────

async function openOk(): Promise<import('../../../src/cli/sessions.js').SessionsCoordination> {
  const r = await openCoordination(INPUT);
  if (r.kind !== 'open') throw new Error(`expected an open ledger, got ${r.message}`);
  return r.coordination;
}

type Verb = NonNullable<SessionsIo['verb']>;

async function run(verb: Verb, args: readonly string[] = [], flags: Record<string, unknown> = {}): Promise<{ code: number; out: string; err: string }> {
  const i = io();
  const coord = await openOk();
  const code = await commandSessions({ command: 'sessions', ...flags } as Parameters<typeof commandSessions>[0], { ...i, verb, args, coordination: coord });
  return { code, out: i.out.join(''), err: i.err.join('') };
}

describe('the thirteen coordination verbs against a real ledger (§2.10)', () => {
  it('`who` prints the peer row, and `--json` carries the projected rows plus `SelfIdentityView` (no hostKey)', async () => {
    const plain = await run('who');
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('air');
    const asJson = await run('who', [], { json: true });
    const parsed = JSON.parse(asJson.out) as { sessions: { runId: string }[]; self: Record<string, unknown> };
    expect(parsed.sessions).toHaveLength(1);
    expect(Object.keys(parsed.self).sort()).toEqual(['deviceId8', 'label', 'sameDeviceCount']);
    expect(asJson.out).not.toContain('hostKey');
  });

  it('`who` over the four fold fixtures: none → the empty state; live/stale/cloned → exactly one row each', async () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      spy.fold = make();
      const r = await run('who', ['--all']);
      expect(r.code, name).toBe(0);
      if (name === 'none') expect(r.out, name).toContain('no other jevcode is working here');
      else expect(r.out, name).toContain('air');
      expectNoSecrets(r.out);
    }
  });

  it('`who --all` reports the fold cap notice from `Fold.skipped` (§7 row 11)', async () => {
    spy.fold = { ...FIXTURES.live(), skipped: 4 };
    expect((await run('who', ['--all'])).out).toContain('4 devices past the fold cap');
    // …and never without `--all`, which is how §7 row 11 phrases it
    expect((await run('who')).out).not.toContain('past the fold cap');
  });

  it('`pause|resume|end <target>` route ONE control message each, to the peer’s SESSION id, never its run id', async () => {
    for (const verb of ['pause', 'resume', 'end'] as const) {
      spy.sent = [];
      const r = await run(verb, [runId(2), 'now']);
      expect(r.code, verb).toBe(0);
      expect(spy.sent, verb).toEqual([{ to: runId(2), type: verb, text: `${verb} now`, by: 'human' }]);
      expect(r.out, verb).toContain('air');
    }
  });

  it('a target that resolves to nothing is exit 2 and the grammar’s own sentence — the same one `/pause` prints', async () => {
    const r = await run('pause', ['nosuchthing']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('no session matches "nosuchthing"');
    expect(spy.sent).toEqual([]);
  });

  it('`tell` and `request` carry the body and the right `MessageType`; `headsup` broadcasts with NO target', async () => {
    spy.sent = [];
    await run('tell', [runId(2), 'commit', 'and', 'move', 'on']);
    expect(spy.sent).toEqual([{ to: runId(2), type: 'note', text: 'commit and move on', by: 'human' }]);
    spy.sent = [];
    await run('request', [runId(2), 'release', 'engine.ts']);
    expect(spy.sent[0]?.type).toBe('request-release');
    spy.sent = [];
    // §2.9 / fix-pass finding 8: the WHOLE tail is the body and the target is always the broadcast
    const r = await run('headsup', ['editing', 'src/loop/engine.ts']);
    expect(spy.sent).toEqual([{ to: '@all', type: 'heads-up', text: 'editing src/loop/engine.ts', by: 'human' }]);
    expect(r.out).toContain('every live session on this repo');
  });

  /**
   * Fix pass, finding 3: `delivered` is the number of SESSIONS that can read the message, never the number of
   * write attempts. `routeOf('@all')` is the single literal `['@all']` — one outbox file — so the loop
   * hard-wired `delivered: 1` and `ok: true` for a broadcast on a machine with no other session at all.
   */
  it('`headsup` with 0 live peers reports `delivered: 0, ok: false`; with 2 it reports 2', async () => {
    spy.fold = FIXTURES.none();
    const empty = await run('headsup', ['nobody is here'], { json: true });
    expect(JSON.parse(empty.out)).toMatchObject({ ok: false, delivered: 0 });
    expect(spy.sent).toHaveLength(1); // the write still happened: a broadcast is an outbox, not a fan-out

    spy.fold = foldOf([
      { hb: PEER, liveness: 'live', where: 'live' },
      { hb: makeHeartbeat({ deviceId: DEV_B, label: 'air', pid: 8, runId: runId(3), sessionId: runId(3) }), liveness: 'live', where: 'live' },
    ]);
    const two = await run('headsup', ['editing the store'], { json: true });
    expect(JSON.parse(two.out)).toMatchObject({ ok: true, delivered: 2 });

    spy.fold = foldOf([{ hb: PEER, liveness: 'live', where: 'live' }]);
    const one = await run('headsup', ['editing the store']);
    expect(one.out).toContain('delivered to 1 session');
  });

  it('a broadcast whose one write FAILED is `delivered: 0`, not "every live session"', async () => {
    spy.sendThrows = 'EROFS: read-only file system';
    const r = await run('headsup', ['nobody will read this'], { json: true });
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, delivered: 0 });
  });

  /**
   * Fix pass, finding 3: `toSessionsTarget` resolved over `fold.live ∪ fold.gone`, so a control verb aimed at a
   * session that had already ended wrote into a mailbox nothing reads and answered `asked air / delivered 1`.
   */
  it('a control verb aimed at a GONE row is refused by name, and writes nothing', async () => {
    spy.fold = FIXTURES.stale();
    const r = await run('pause', [runId(2)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('has ended');
    expect(r.err).toContain('who --all');
    expect(spy.sent).toEqual([]);
    const asJson = await run('pause', [runId(2)], { json: true });
    expect(JSON.parse(asJson.out)).toMatchObject({ ok: false, reason: 'gone' });
  });

  it('a LIVE row still resolves even when a gone row would also match the text', async () => {
    spy.fold = foldOf([
      { hb: PEER, liveness: 'live', where: 'live' },
      { hb: makeHeartbeat({ deviceId: DEV_B, label: 'air', pid: 9, runId: runId(4), sessionId: runId(4) }), liveness: 'stale', where: 'gone' },
    ]);
    expect((await run('pause', [runId(2)])).code).toBe(0);
    expect(spy.sent).toHaveLength(1);
  });

  /**
   * Fix pass, finding 4: the loop iterates over SESSION ids and truncated one of those into a field §13.3 names
   * `deviceId`, so a `--json` consumer joining `refused[].deviceId` against `devices[].id8` got the DATE head of
   * a run id (`"20260922"`).
   */
  it('`refused[].deviceId8` is a real device id8 — one of `devices[].id8` — and `target` says what was addressed', async () => {
    spy.sendThrows = 'message too large (3000 > 600 chars)';
    const r = await run('tell', [runId(2), 'x'.repeat(30)], { json: true });
    const parsed = JSON.parse(r.out) as { refused: { deviceId8: string; target: string; detail60: string }[] };
    expect(parsed.refused).toHaveLength(1);
    const row = parsed.refused[0]!;
    // the promise the field name makes
    const devices = [DEV_A.slice(0, 8), DEV_B.slice(0, 8)];
    expect(devices).toContain(row.deviceId8);
    expect(row.deviceId8).toBe(DEV_B.slice(0, 8));
    // the old value — the head of the session id — is not what the field carries any more
    expect(row.deviceId8).not.toBe(runId(2).slice(0, 8));
    expect(row.target).toBe(runId(2));
    expect(row.detail60).toContain('message too large');
  });

  it('a `send` that throws is one redacted line and exit 2, never a crash (§1.4 promise 2)', async () => {
    spy.sendThrows = 'message too large\nafter redaction';
    const r = await run('tell', [runId(2), 'x']);
    expect(r.code).toBe(0);
    // the per-target failure is `refused`, not a thrown verb: the CLI reports the count
    expect(r.out).toContain('1 refused');
  });

  it('`inbox` flattens the fold’s messages and acks — no hostKey, no checksum, no hmac (§13.2 clause 8)', async () => {
    const f = FIXTURES.live();
    f.inbox.push(makeMessage({ to: 'ws:3f9a2c1d8bc0d11e', hostKey: 'deadbeefcafe1234deadbeefcafe1234' }) as Message);
    f.origins.set(`msg:${f.inbox[0]!.id}`, TRUSTED);
    f.acks.set('m1', [makeAck() as Ack]);
    spy.fold = f;
    const r = await run('inbox', [], { json: true });
    expect(r.out).not.toContain('hostKey');
    expect(r.out).not.toContain('checksum');
    expect(r.out).not.toContain('hmac');
    const parsed = JSON.parse(r.out) as { messages: unknown[]; acks: { deviceId8: string }[] };
    expect(parsed.acks).toHaveLength(1);
    // §7 row 61 / finding 10: the ack row carries the id8 under a name that SAYS id8
    expect(parsed.acks[0]!.deviceId8).toBe(DEV_A.slice(0, 8));
    expect(Object.keys(parsed.acks[0]!)).not.toContain('deviceId');
  });

  it('`label` writes through the facade and answers the new row', async () => {
    const r = await run('label', ['studio']);
    expect(spy.labelled).toEqual(['studio']);
    expect(r.out).toContain('this device is now "studio"');
    // §15.2: the read AFTER the own write
    expect(spy.refreshed).toBeGreaterThan(0);
  });

  it('`unpair <ref>` names the device it forgot and prints the whole S35 sentence', async () => {
    const r = await run('unpair', [DEV_B]);
    expect(spy.unpaired).toEqual([DEV_B]);
    expect(r.out).toContain('unpaired air');
    expect(r.out).toContain("run 'jevcode sessions pair --rotate' to invalidate it everywhere.");
  });

  /**
   * Fix pass, finding 12: the label in S35 is resolved by the SAME resolver that performed the write.
   *
   * The local lookup took the first `deviceId === ref || startsWith(ref) || label === ref` hit out of
   * `fold.devices`, with no ambiguity check and no `label#id4` grammar, while `unpairDeviceOn` uses
   * `resolveDeviceRef` over the DISK walk. With `label#id4` the local lookup missed and the sentence printed the
   * raw ref; with two devices sharing a label prefix the two could name different devices.
   */
  it('`unpair <label#id4>` names the device the WRITE resolved, not the one a looser matcher found', async () => {
    const r = await run('unpair', [`air#${DEV_B.slice(0, 4)}`]);
    expect(spy.unpaired).toEqual([`air#${DEV_B.slice(0, 4)}`]);
    // the resolver the write used is the one that produced the label
    expect(spy.resolveDeviceRefCalls).toContain(`air#${DEV_B.slice(0, 4)}`);
    expect(r.out).toContain('unpaired air');
    expect(r.out).not.toContain('#');
  });

  it('two devices sharing a label prefix: the sentence names the one `resolveDeviceRef` picked', async () => {
    const twin = 'zz5wq7ce';
    const f = FIXTURES.live();
    f.devices.set(twin, { ...makeDevice({ deviceId: twin, label: 'airfoil' }), lastSeen: iso(T0), syncLagMs: null, ignored: false, cloned: false });
    spy.fold = f;
    spy.allDeviceIds = [DEV_A, DEV_B, twin];
    const r = await run('unpair', [twin]);
    expect(r.out).toContain('unpaired airfoil');
  });

  /**
   * Fix pass, finding 11: `ignoreDeviceOn` writes a LOCAL TOMBSTONE and deletes nothing (its own doc: "nothing
   * foreign is ever deleted", §4.6 row 4), so `gc removed 1 record of <ref>` told the user records had gone
   * that were still on disk. The verb now says what the tombstone does and when the records really go.
   */
  it('`gc` reports the removed count; `gc --device <ref>` says IGNORED, never "removed N records" (§7 row 14)', async () => {
    expect((await run('gc')).out).toContain('gc removed 3 records');
    expect(spy.gcCalls).toBe(1);
    const r = await run('gc', ['--device', 'ffffffff']);
    // `ffffffff` is on disk and NOT in `fold.devices` — exactly the case the verb exists for
    expect(spy.ignored).toEqual(['ffffffff']);
    expect(r.out).toContain('ffffffff is now ignored');
    expect(r.out).toContain('hidden from /who');
    expect(r.out).not.toMatch(/removed \d+ record/);
    // …and `--json` carries the two numbers apart, so a consumer is not told 1 record went either
    const asJson = await run('gc', ['--device', 'ffffffff'], { json: true });
    const parsed = JSON.parse(asJson.out) as { removed: number; ignored: number };
    expect(parsed).toMatchObject({ removed: 0, ignored: 1 });
  });

  it('`sync status` reads the mirror and `sync disable` removes our subtrees', async () => {
    spy.sync = { mode: 'shared-dir', state: 'offline', code: 'ENOENT', lagMs: 4_000, pending: 2, offlineForMs: 9_000, refused: null };
    const s = await run('sync', ['status']);
    expect(s.out).toContain('sync shared-dir: offline');
    expect(s.out).toContain('lag 4s');
    const d = await run('sync', ['disable']);
    expect(spy.syncDisabled).toBe(1);
    expect(d.out).toContain('removed 2 subtrees');
  });

  it('`pair` refuses by name — the phrase transport of CD §10.3 has no builder in the facade (request R5-H5)', async () => {
    const r = await run('pair');
    expect(r.code).toBe(2);
    expect(r.err).toContain('pairing is not wired in this build');
    // the two device verbs that DO work are named, so the refusal is also its own documentation
    expect(r.err).toContain('jevcode sessions label');
  });

  it('the `paired` column of a device row comes from `trusted-devices.json`, awaited before the row is built', async () => {
    spy.trusted = [{ deviceId: DEV_B, label: 'air', pairedAt: iso(T0) }];
    const r = await run('gc', [], { json: true });
    const parsed = JSON.parse(r.out) as { devices: { id8: string; paired: boolean }[] };
    expect(parsed.devices.find((d) => d.id8 === DEV_B.slice(0, 8))?.paired).toBe(true);
  });

  /**
   * Fix pass, the review's "cross-device coverage" gap, as far as an injected fold can reach it: everything
   * measured before was ONE device (`sameDevice: true`, `authority: 'self'`). This fixture is a FOREIGN device
   * whose records are `unverified` (no trust key) beside a `trusted` one, and it asserts the three places the
   * distinction is supposed to show: the `who` row's flag, the inbox row's `unverified`, and the `paired`
   * column of the device list. A real `--force-takeback` needs two processes with two device keys and is a
   * `test/pty/**` scenario, not one this seam can stand in for — recorded in the report as an open item.
   */
  it('a foreign UNVERIFIED origin and a TRUSTED device are two different answers on the same fold', async () => {
    const f = FIXTURES.live();
    // the peer's heartbeat origin is unverified: `authorityOf` must not call it trusted
    f.origins.set(`${DEV_B}/${PEER.runId}`, UNVERIFIED);
    // `sessionTargets(self)` for a SESSIONLESS reader is `{'@all'}` alone (`fold.ts:65`): a CLI twin has no
    // sessionId and no repo keys, so a broadcast is the only message it can be a recipient of
    const msg = makeMessage({ to: '@all' }) as Message;
    f.inbox.push(msg);
    f.origins.set(`msg:${msg.id}`, UNVERIFIED);
    spy.fold = f;
    spy.trusted = [{ deviceId: DEV_B, label: 'air', pairedAt: iso(T0) }];

    const who = await run('who', ['--all'], { json: true });
    const rows = (JSON.parse(who.out) as { sessions: { flags: { unverified: boolean }; sameDevice: boolean }[] }).sessions;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flags.unverified).toBe(true);
    expect(rows[0]?.sameDevice).toBe(false);
    expectNoSecrets(who.out);

    const inbox = await run('inbox', [], { json: true });
    const messages = (JSON.parse(inbox.out) as { messages: { unverified: boolean }[] }).messages;
    expect(messages.at(-1)?.unverified).toBe(true);

    // `paired` is `trusted-devices.json`, which is a DIFFERENT question from record authority
    const gc = await run('gc', [], { json: true });
    const devices = (JSON.parse(gc.out) as { devices: { id8: string; paired: boolean }[] }).devices;
    expect(devices.find((d) => d.id8 === DEV_B.slice(0, 8))?.paired).toBe(true);
  });

  it('the dispatcher closes the ONE handle in its `finally`, even for the verb that refused', async () => {
    spy.closed = 0;
    await run('pair');
    expect(spy.closed).toBe(1);
  });
});

// ── 4. the property §10 asks for ─────────────────────────────────────────────────────────────────────────────────

const HOSTKEY = 'deadbeefcafe1234deadbeefcafe1234';

function expectNoSecrets(text: string): void {
  // §7 row 61: no absolute path, no `pid <n>`, no 32-hex host key, no full device id in a printed sink
  expect(text, 'an absolute path').not.toMatch(/(?:^|\s|")\/(?:home|Users|tmp|var|private)\//);
  expect(text, 'a pid').not.toMatch(/\bpid[\s:=]+\d+/i);
  expect(text, 'a hostKey').not.toContain(HOSTKEY);
  expect(text, 'a 32-hex key').not.toMatch(/\b[0-9a-f]{32}\b/);
}

describe('§10 / §7 row 61 — no verb prints a path, a pid or a hostKey, over every fold fixture', () => {
  const calls: readonly { verb: Verb; args: readonly string[] }[] = [
    { verb: 'who', args: [] },
    { verb: 'who', args: ['--all'] },
    { verb: 'pause', args: [runId(2)] },
    { verb: 'resume', args: [runId(2)] },
    { verb: 'end', args: [runId(2), 'now'] },
    { verb: 'tell', args: [runId(2), 'hello'] },
    { verb: 'request', args: [runId(2), 'engine.ts'] },
    { verb: 'headsup', args: ['editing the store'] },
    { verb: 'inbox', args: [] },
    { verb: 'label', args: ['studio'] },
    { verb: 'unpair', args: [DEV_B] },
    { verb: 'gc', args: [] },
    { verb: 'sync', args: ['status'] },
  ];

  for (const [name, make] of Object.entries(FIXTURES)) {
    it(`fixture "${name}": every verb’s stdout, stderr and --json are clean`, async () => {
      for (const call of calls) {
        spy.fold = make();
        const plain = await run(call.verb, call.args);
        expectNoSecrets(`${plain.out}\n${plain.err}`);
        spy.fold = make();
        const asJson = await run(call.verb, call.args, { json: true });
        expectNoSecrets(`${asJson.out}\n${asJson.err}`);
      }
    });
  }

  it('the fixture ledger really does carry a hostKey — so the assertions above are not vacuous', () => {
    expect(SELF_ID.hostKey).toBe(HOSTKEY);
    expect(makeHeartbeat({ deviceId: DEV_A }).deviceId).toBe(DEV_A);
  });

  /**
   * Fix pass, finding 2 (a blocker): the two NEW error sinks, run with the PRODUCTION redactor.
   *
   * The landed test of the open-failure path injected a bespoke path-stripping redactor, so it proved nothing
   * about what a user sees; `createRedactor` substitutes secret VALUES and API-key SHAPES and strips no path at
   * all. Both sinks — `coordinationOff` (an `openLedger` that threw) and `commandSessions`' `catch` (a verb that
   * threw) — are driven here with an errno message that carries `/Users/…`, against every verb.
   */
  it('every verb’s open-failure line and every thrown verb’s line survive `expectNoSecrets` under the REAL redactor', async () => {
    const { createRedactor } = await import('../../../src/core/redact.js');
    const production = createRedactor([{ name: 'generator.apiKey', value: `sk-${'y'.repeat(40)}` }]);
    const redact = (x: string): string => production.redact(x);
    const errno = "EACCES: permission denied, open '/Users/p/Library/Application Support/jevcode/coordination/devices/4d4e6845/heartbeat.json'";

    for (const call of calls) {
      // (a) the ledger threw on the way up: `main.tsx` hands the message to `commandSessions` as `coordinationOff`
      spy.fold = FIXTURES.live();
      spy.openLedgerThrows = errno;
      const off = await openCoordination({ ...INPUT, redact });
      spy.openLedgerThrows = null;
      if (off.kind !== 'off') throw new Error('unreachable');
      for (const json of [false, true]) {
        const i = io();
        const code = await commandSessions({ command: 'sessions', ...(json ? { json: true } : {}) } as Parameters<typeof commandSessions>[0], { ...i, redact, verb: call.verb, args: call.args, coordinationOff: off.message, coordinationOffReason: 'error' });
        expect(code, `${call.verb} open-failure exit`).toBe(2);
        expectNoSecrets(`${i.out.join('')}\n${i.err.join('')}`);
      }

      // (b) the verb itself threw with an errno message: `commandSessions`' own catch
      spy.fold = FIXTURES.live();
      spy.sendThrows = null;
      const coord = await openOk();
      const boom: import('../../../src/cli/sessions.js').SessionsCoordination = {
        ...coord,
        activity: () => Promise.reject(new Error(errno)),
        resolve: () => Promise.reject(new Error(errno)),
        inbox: () => Promise.reject(new Error(errno)),
        label: () => Promise.reject(new Error(errno)),
        unpair: () => Promise.reject(new Error(errno)),
        gc: () => Promise.reject(new Error(errno)),
        syncStatus: () => Promise.reject(new Error(errno)),
        syncDisable: () => Promise.reject(new Error(errno)),
        send: () => Promise.reject(new Error(errno)),
      };
      for (const json of [false, true]) {
        const i = io();
        const code = await commandSessions({ command: 'sessions', ...(json ? { json: true } : {}) } as Parameters<typeof commandSessions>[0], { ...i, redact, verb: call.verb, args: call.args, coordination: boom });
        // a plain `Error` is a FAULT, not a refusal (finding 14)
        expect(code, `${call.verb} throw exit`).toBe(1);
        expectNoSecrets(`${i.out.join('')}\n${i.err.join('')}`);
      }
    }
  });

  it('`withoutPaths` keeps a relative path and a slash-command whole — it is not a blunt instrument', () => {
    expect(withoutPaths('editing src/loop/engine.ts')).toBe('editing src/loop/engine.ts');
    expect(withoutPaths('/who --all lists them')).toBe('/who --all lists them');
    expect(withoutPaths("mkdir '/Users/p/.jevcode/coordination'")).toBe("mkdir '<path>'");
  });
});

// ── 5. the wiring contract the CLI depends on ────────────────────────────────────────────────────────────────────

describe('gap 1 wiring (§2.10)', () => {
  it('`SESSIONS_VERBS` still has the four index verbs that must NEVER open a ledger', () => {
    expect(SESSIONS_VERBS.slice(0, 4)).toEqual(['list', 'reindex', 'prune', 'unlock']);
  });

  /**
   * Fix pass, finding 14: a verb that THREW is branched, and `--json` gets the SHAPE.
   *
   * Every throw used to be `EXIT_CODES.config` (2) and a bare line on stderr even under `--json`, so a
   * `TypeError` inside `sessionsList` was reported to the user as a configuration problem and a `--json`
   * consumer got nothing on stdout at all.
   */
  it('a thrown verb: a refusal is exit 2, a fault is exit 1, and `--json` always gets `{ ok:false, reason, message }`', async () => {
    const coord = await openOk();
    const coordErr = Object.assign(new Error('no device matches "nope"'), { name: 'CoordinationError', code: 'unknown-device' });
    const refusing: import('../../../src/cli/sessions.js').SessionsCoordination = { ...coord, gc: () => Promise.reject(coordErr) };
    const faulting: import('../../../src/cli/sessions.js').SessionsCoordination = { ...coord, gc: () => Promise.reject(new TypeError('x is not a function')) };

    const a = io();
    expect(await commandSessions({ command: 'sessions' }, { ...a, verb: 'gc', args: ['--device', 'nope'], coordination: refusing })).toBe(2);
    expect(a.err.join('')).toContain('no device matches');

    const b = io();
    expect(await commandSessions({ command: 'sessions', json: true } as Parameters<typeof commandSessions>[0], { ...b, verb: 'gc', args: ['--device', 'nope'], coordination: refusing })).toBe(2);
    expect(JSON.parse(b.out.join(''))).toMatchObject({ ok: false, reason: 'unknown-device' });
    expect(b.err.join('')).toBe('');

    const c = io();
    // a fault is NOT a configuration problem: `sessionsReindex` has always answered `unexpected` for one
    expect(await commandSessions({ command: 'sessions' }, { ...c, verb: 'gc', coordination: faulting })).toBe(1);

    const d = io();
    expect(await commandSessions({ command: 'sessions', json: true } as Parameters<typeof commandSessions>[0], { ...d, verb: 'gc', coordination: faulting })).toBe(1);
    expect(JSON.parse(d.out.join(''))).toMatchObject({ ok: false, reason: 'unexpected' });
  });

  it('`pair` is a REFUSAL, so it keeps exit 2 under the new branch', async () => {
    const r = await run('pair');
    expect(r.code).toBe(2);
    expect(r.err).toContain('pairing is not wired in this build');
  });

  /** Fix pass, finding 17: `main.tsx`'s gate and this dispatcher compute the verb with the one helper. */
  it('`sessionsVerbOf` is the ONE verb computation, and `io.verb` is only consulted when `args.ts` parsed none', async () => {
    const { sessionsVerbOf, sessionsVerbNeedsCoordination, SESSIONS_INDEX_VERBS } = await import('../../../src/cli/sessions.js');
    expect(sessionsVerbOf({ command: 'sessions' })).toBe('list');
    expect(sessionsVerbOf({ command: 'sessions' }, { verb: 'who' })).toBe('who');
    expect(sessionsVerbOf({ command: 'sessions', sessionsOp: 'prune' } as Parameters<typeof sessionsVerbOf>[0], { verb: 'who' })).toBe('prune');
    expect([...SESSIONS_INDEX_VERBS]).toEqual(['list', 'reindex', 'prune', 'unlock']);
    for (const v of SESSIONS_VERBS) expect(sessionsVerbNeedsCoordination(v), v).toBe(!SESSIONS_INDEX_VERBS.includes(v));
  });

  it('an absent coordination with a REASON prints the reason; with none, the landed sentence unchanged', async () => {
    const withReason = io();
    const code = await commandSessions({ command: 'sessions' }, { ...withReason, verb: 'who', coordinationOff: coordinationOffText(COORDINATION_UNAVAILABLE, 'disabled') });
    expect(code).toBe(2);
    expect(withReason.err.join('')).toContain(`jevcode sessions who: ${COORDINATION_UNAVAILABLE}`);
    expect(withReason.err.join('')).toContain('coordination.claims = off');

    const bare = io();
    await commandSessions({ command: 'sessions' }, { ...bare, verb: 'who' });
    expect(bare.err.join('')).toBe(`jevcode sessions who: ${COORDINATION_UNAVAILABLE}\n`);
  });

  /** Fix pass, finding 14: the no-coordination refusal is a `--json` SHAPE too, never bare text on stderr. */
  it('`--json` with no coordination emits `{ ok:false, reason, message }` on stdout and nothing on stderr', async () => {
    const i = io();
    const code = await commandSessions({ command: 'sessions', json: true } as Parameters<typeof commandSessions>[0], {
      ...i,
      verb: 'who',
      coordinationOff: coordinationOffText(COORDINATION_UNAVAILABLE, 'unwritable'),
      coordinationOffReason: 'unwritable',
    });
    expect(code).toBe(2);
    expect(i.err.join('')).toBe('');
    const parsed = JSON.parse(i.out.join('')) as { ok: boolean; reason: string; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('unwritable');
    expect(parsed.message).toContain(COORDINATION_OFF_CLAUSE.unwritable);
    expectNoSecrets(parsed.message);
  });
});
