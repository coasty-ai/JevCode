/**
 * TUI-DESIGN-5 §2 / §9.1 (slot R5-1) — the coordination surface at the MOUNTED App boundary.
 *
 * The five §2 surfaces are mounted, key-routed and state-held by R5-4's shared React shell, which is that slot's
 * ONE W3 PR (§9.2, §9.3 constraint (h)). What this file pins today is the half R5-1 owns and that must hold
 * before and after that PR lands:
 *
 *  1. **Additivity.** `SessionHost.who?()` and `SessionHost.peers?()` are optional, so an App mounted on a host
 *     that has neither renders exactly as it does today (contract 1.8 items 3 / 4 are default-preserving).
 *  2. **§1.4 promise 1.** Before `LedgerHandle.open()` resolves both reads answer `null`, and the App paints its
 *     first frame from argv alone — never a spinner, never a blocked frame.
 *  3. **§7 row 61 / gate G-R5-9.** Nothing the fold carries — a device id, a `hostKey`, a pid, a lease path —
 *     reaches a frame through either read. The mappers are the boundary, and this is the test at the far side.
 */
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerView, SessionActivityView, SelfIdentityView } from '../../../src/core/types.js';
import { emptyFold } from '../../../src/coordination/fold.js';
import { listSessions, type Fold, type Heartbeat } from '../../../src/coordination/index.js';
import { activityView, labelResolver, peerViewOf, selfView, whoPlainRow, whoRows } from '../../../src/session/peers.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { DEV_A, DEV_B, T0, SELF, TRUSTED, iso, makeHeartbeat, makeLease, makeSelf, runId } from '../coordination/helpers.js';
import { dynamicLines, fakeHost, mountApp, stripSgr, type FakeHost } from './app-harness.js';
import { makeController, type Harness } from '../cli/helpers.js';
import type { Claim, SelfIdentity, SessionActivity } from '../../../src/coordination/index.js';
import type { SessionLedger } from '../../../src/session/publish.js';

afterEach(() => cleanup());

const NOW = { wallMs: T0, monoMs: 1_000_000 };
const HOST_KEY = 'c0ffee1234abcd99';
const SELF_ID = makeSelf({ hostKey: HOST_KEY });

/** one live peer on another device, holding an exclusive lease over a real path, with a pid and a device key */
function liveFold(): Fold {
  const fold = emptyFold(NOW);
  const mine: Heartbeat = makeHeartbeat({ runId: runId(1), pid: 4242 });
  const peer: Heartbeat = makeHeartbeat({
    deviceId: DEV_B,
    label: 'air',
    pid: 31337,
    runId: runId(2),
    startedAt: iso(T0 - 300_000),
    touched: { step: 7, files: ['src/loop/engine.ts'] },
  });
  for (const [hb, origin] of [
    [mine, SELF],
    [peer, TRUSTED],
  ] as const) {
    fold.origins.set(`${hb.deviceId}/${hb.runId}`, origin);
    fold.liveness.set(`${hb.deviceId}/${hb.runId}/${hb.pid}`, 'live');
    fold.live.set(hb.runId, { ...hb, arrivalMono: NOW.monoMs - 2_000 });
  }
  const lease = makeLease({ leaseId: 'l-ex', runId: runId(2), deviceId: DEV_B, type: 'exclusive', paths: ['src/loop/engine.ts'] });
  fold.leases.set(lease.leaseId, lease);
  return fold;
}

/** the host the controller builds in `src/cli/session.ts`: `peers()` and `who()` over the live fold, or `null` */
function coordHost(fold: Fold | null): FakeHost {
  const h = fakeHost();
  const wired: FakeHost = Object.assign(h, {
    peers: (): PeerView | null => (fold === null ? null : peerViewOf(fold, SELF_ID)),
    who: (): readonly SessionActivityView[] | null => (fold === null ? null : listSessions(fold, SELF_ID).map(activityView)),
  });
  return wired;
}

describe('1 — contract 1.8 items 3 / 4 are additive at the App boundary', () => {
  it('a host with NEITHER read mounts and paints its first frame unchanged', () => {
    const plain = mountApp({ mode: 'session', host: fakeHost() });
    expect(plain.host?.who).toBeUndefined();
    expect(plain.host?.peers).toBeUndefined();
    expect(plain.frames.length).toBeGreaterThanOrEqual(1);
    expect(stripSgr(plain.frames[0] ?? '')).toContain('step 0/–');
  });

  it('a host WITH both reads mounts to the same first frame — the coordination half is invisible until asked', () => {
    const bare = mountApp({ mode: 'session', host: fakeHost() });
    const first = stripSgr(bare.frames[0] ?? '');
    const bareRows = dynamicLines(bare.lastFrame()).length;
    cleanup();
    const wired = mountApp({ mode: 'session', host: coordHost(liveFold()) });
    expect(stripSgr(wired.frames[0] ?? '')).toBe(first);
    expect(dynamicLines(wired.lastFrame()).length).toBe(bareRows);
  });
});

describe('2 — §1.4 promise 1: before the ledger opens, both reads are null and every surface is empty', () => {
  it('`peers()` and `who()` answer `null`, not a spinner and not a false zero', () => {
    const m = mountApp({ mode: 'session', host: coordHost(null) });
    expect(m.host?.peers?.()).toBeNull();
    expect(m.host?.who?.()).toBeNull();
    // and the frame is the ordinary idle frame — no `⇄`, no `who`, no placeholder row
    const f = stripSgr(m.lastFrame());
    expect(f).not.toContain('⇄');
    expect(f).not.toContain('who ·');
  });

  it('an OPEN but empty fold answers the honest zero, which renders nothing (TD4’s `here <= 1` rule)', () => {
    const m = mountApp({ mode: 'session', host: coordHost(emptyFold(NOW)) });
    expect(m.host?.peers?.()).toEqual({ live: 0, stale: 0, oldestStartedMsAgo: null, exclusive: false });
    expect(m.host?.who?.()).toEqual([]);
    expect(stripSgr(m.lastFrame())).not.toContain('⇄');
  });

  it('a live fold answers both reads, and the rows are the ONE view model `sessions who --json` emits (§14.2 #12)', () => {
    const m = mountApp({ mode: 'session', host: coordHost(liveFold()) });
    expect(m.host?.peers?.()).toMatchObject({ live: 2, stale: 0, exclusive: true });
    const rows = m.host?.who?.() ?? [];
    expect(rows).toHaveLength(2);
    const peer = rows.find((r) => r.label === 'air');
    expect(peer).toMatchObject({ kind: 'run', liveness: 'live', deviceId8: DEV_B.slice(0, 8), leaseCount: 1, editing: ['src/loop/engine.ts'] });
  });
});

describe('3 — §7 row 61 / gate G-R5-9: nothing the fold carries reaches a frame', () => {
  const FORBIDDEN: readonly [string, string][] = [
    ['the reader’s hostKey', HOST_KEY],
    ['a peer’s pid', '31337'],
    ['this session’s pid', '4242'],
    ['a full device id', DEV_B],
    ['a lease path', 'src/loop/engine.ts'],
  ];

  it.each(FORBIDDEN)('a mounted frame never contains %s', (_what, needle) => {
    const m = mountApp({ mode: 'session', host: coordHost(liveFold()) });
    for (const frame of m.frames) expect(stripSgr(frame)).not.toContain(needle);
  });

  it('`peerViewOf`’s answer — what the status zone renders — is four scalars and nothing else', () => {
    const view = peerViewOf(liveFold(), SELF_ID);
    const text = JSON.stringify(view);
    for (const [, needle] of FORBIDDEN) expect(text).not.toContain(needle);
    expect(Object.keys(view).sort()).toEqual(['exclusive', 'live', 'oldestStartedMsAgo', 'stale']);
  });

  it('`selfView` is the only self shape that crosses the boundary, and it has no `hostKey`', () => {
    const self: SelfIdentityView = selfView(SELF_ID, liveFold());
    expect(self).toEqual({ deviceId8: DEV_A.slice(0, 8), label: 'mbp', sameDeviceCount: 1 });
    expect(JSON.stringify(self)).not.toContain(HOST_KEY);
  });

  it('the `/who` rows a frame WOULD draw carry the 8-char device id at most, never the full one or a pid', () => {
    const rows = listSessions(liveFold(), SELF_ID).map(activityView);
    const self = selfView(SELF_ID, liveFold());
    const built = whoRows(rows, self, { width: 120, g: GLYPHS.unicode });
    const text = built.map((r) => (r.kind === 'facts' ? r.segments.join(' ') : r.kind === 'note' ? r.text : '')).join('\n');
    expect(text).not.toContain(HOST_KEY);
    expect(text).not.toContain('31337');
    expect(text).not.toContain(DEV_B);
    // the EDITING cell is a workspace-relative path the peer chose to publish, which is the one path `/who` shows
    expect(text).toContain('editing src/loop/engine.ts');
    // and the `--plain` twin is the same row (§13) — the WHOLE row, not just its first cell
    const label = labelResolver(rows, self);
    for (const row of rows) expect(text).toContain(whoPlainRow(row, { width: 120, g: GLYPHS.unicode, label: label(row) }));
  });
});

// ── 4 — the controller half: the write wiring, `/who --all` and the 15th fact (§2.14, §2.3, §8.1 item 10) ────────

/**
 * `SessionDeps.openSessionLedger` is the §2.14 seam: `createPublisher` still gates it behind
 * `renderer.firstFrame()`, so what a fake ledger changes is only WHERE the fold comes from. Everything below is
 * unreachable without it — nothing tested `startPublishing`, `host.who()`'s `all` branch or `FactsInput.peers`.
 */
function fakeSessionLedger(fold: Fold, self: SelfIdentity): SessionLedger & { readonly listCalls: { all?: boolean }[]; readonly log: string[] } {
  const listCalls: { all?: boolean }[] = [];
  const log: string[] = [];
  const claim: Claim = { deviceId: self.deviceId, runId: self.runId ?? runId(1), pid: 4242, at: iso(T0), epoch: 1 };
  const all = listSessions(fold, self, { all: true });
  const near = listSessions(fold, self);
  return {
    listCalls,
    log,
    fold,
    self,
    repoKeys: { repoKey: 'repo:aaaa', remoteKey: null },
    open: async () => {
      log.push('open');
    },
    close: async () => {
      log.push('close');
    },
    list: (opts = {}): readonly SessionActivity[] => {
      listCalls.push(opts);
      return opts.all === true ? all : near;
    },
    subscribe: () => () => undefined,
    claimRefusal: () => null,
    mintClaim: async () => {
      log.push('mintClaim');
    },
    mintedClaim: () => claim,
    startHeartbeat: () => {
      log.push('startHeartbeat');
      return {
        stop: (): void => {
          log.push('stopHeartbeat');
        },
      };
    },
    declare: async () => ({ release: () => undefined }),
  };
}

describe('4 — the controller wires the write half, `/who --all` and the `peers` fact', () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    for (const h of harnesses.splice(0)) h.cleanup();
  });

  async function wired(fold: Fold): Promise<{ h: Harness; led: ReturnType<typeof fakeSessionLedger>; inputs: Record<string, unknown>[] }> {
    const led = fakeSessionLedger(fold, SELF_ID);
    const inputs: Record<string, unknown>[] = [];
    const h = await makeController({
      deps: {
        openSessionLedger: async (input) => {
          inputs.push({ ...input });
          return led;
        },
      },
    });
    harnesses.push(h);
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    return { h, led, inputs };
  }

  it('§2.14: the run publishes — the ledger opens, the claim is minted and the writer starts, in that order', async () => {
    const { led, inputs } = await wired(liveFold());
    expect(led.log.slice(0, 3)).toEqual(['open', 'mintClaim', 'startHeartbeat']);
    // §2.14 / §12.1 S1: the field mapping reaches the ledger (nothing tested `startPublishing` before)
    const input = inputs[0] ?? {};
    expect(input['runId']).toMatch(/^\d{8}-\d{6}-/);
    expect(input['repoKey']).toBeUndefined();
    expect(input['remoteKey']).toBeUndefined();
    expect(typeof input['repoFacts']).toBe('function');
    expect(input['parentSessionId']).toBeNull();
    expect(input['linkedWorktree']).toBe(false);
  });

  it('§2.3: `/who --all` reaches `listSessions`’ WIDER branch; `/who` does not (finding 6)', async () => {
    const { h, led } = await wired(liveFold());
    led.listCalls.length = 0;
    await h.command('/who');
    expect(led.listCalls).toEqual([{ all: false }]);
    await h.command('/who --all');
    expect(led.listCalls).toEqual([{ all: false }, { all: true }]);
  });

  it('§2.4: `/peers` prints the head-plus-counts block, never TD4’s superseded `workspace` kv row (finding 17)', async () => {
    const { h } = await wired(liveFold());
    const before = h.renderer.notes.length;
    await h.command('/peers');
    const printed = h.renderer.notes.slice(before);
    const text = printed.map((n) => `${n.text}\n${n.detail ?? ''}`).join('\n');
    expect(text).toContain('peers · 2 here, 0 stale');
    expect(text).toContain('/who shows what each is doing');
    // TD4's three kv rows are superseded by §2.4, and `workspace` was always the literal `.`
    expect(text).not.toMatch(/^\s*workspace\s/m);
    expect(text).not.toContain('exclusive lease held');
    expect(text).toContain('one holds an exclusive lease');
  });

  it('§8.1 item 10: `host.peers()` answers the live fold once the ledger is open, so the 15th fact is not a lie', async () => {
    const { h } = await wired(liveFold());
    expect(h.host.peers?.()).toMatchObject({ live: 2, exclusive: true });
    expect(h.host.who?.()).toHaveLength(2);
  });
});
