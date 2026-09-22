/**
 * TUI-DESIGN-5 §2.3 / §2.4 / §10 (slot R5-1): `peerViewOf` over twelve fold fixtures, the two new mappers
 * (`activityView`, `selfView`) and `/who`'s row builder — every field asserted, plus the two property tests §10
 * names: **no `peerViewOf` output string carries a path or a pid**, and **`selfView` never emits `hostKey`**
 * (§7 row 61).
 */
import { describe, expect, it } from 'vitest';
import { HOLDING_LEASE_TYPES, listSessions, sameRepo, type Fold, type Heartbeat, type Lease, type Liveness, type SelfIdentity } from '../../../src/coordination/index.js';
import { emptyFold } from '../../../src/coordination/fold.js';
import {
  activityView,
  flagSuffixes,
  foldCapNotice,
  keptCells,
  labelResolver,
  peerViewOf,
  selfView,
  shortAge,
  WHO_CELLS_MAX,
  WHO_EMPTY,
  whoCells,
  whoFlagRow,
  whoGlyphs,
  whoHeader,
  whoPlainRow,
  whoRows,
  whoRowText,
  whoSentence,
  whoShownCells,
} from '../../../src/session/peers.js';
import { BOOT, DEV_A, DEV_B, REPO, SELF, T0, TRUSTED, UNVERIFIED, WS, claim, iso, makeHeartbeat, makeLease, makeSelf, runId } from '../coordination/helpers.js';
import { GLYPHS, glyphSet } from '../../../src/tui/glyphs.js';
import { blockWidth, renderBlock } from '../../../src/tui/block/lines.js';
import type { SessionActivityView } from '../../../src/core/types.js';

const NOW = { wallMs: T0, monoMs: 1_000_000 };

interface FixtureRow {
  hb: Heartbeat;
  liveness: Liveness;
  where: 'live' | 'gone' | 'fork' | 'ignored';
  origin?: typeof SELF;
  goneAgoMs?: number;
}

/** Build a `Fold` by hand: the fixtures need exact liveness verdicts and exact origins, which `buildFold` derives. */
function foldOf(rows: readonly FixtureRow[], leases: readonly Lease[] = [], patch: Partial<Fold> = {}): Fold {
  const fold = emptyFold(NOW);
  for (const r of rows) {
    const withArrival = { ...r.hb, arrivalMono: NOW.monoMs - 2_000 };
    const key = `${r.hb.deviceId}/${r.hb.runId}/${r.hb.pid}`;
    fold.origins.set(`${r.hb.deviceId}/${r.hb.runId}`, r.origin ?? TRUSTED);
    fold.liveness.set(key, r.liveness);
    if (r.where === 'live') fold.live.set(r.hb.runId, withArrival);
    else if (r.where === 'gone') fold.gone.set(r.hb.runId, { ...withArrival, goneAtMono: NOW.monoMs - (r.goneAgoMs ?? 60_000) });
    else if (r.where === 'ignored') fold.ignored.set(key, withArrival);
    else {
      fold.forks ??= new Map();
      const list = fold.forks.get(r.hb.runId) ?? [];
      list.push(withArrival);
      fold.forks.set(r.hb.runId, list);
    }
  }
  for (const l of leases) fold.leases.set(l.leaseId, l);
  return { ...fold, ...patch };
}

const SELF_ID: SelfIdentity = makeSelf({ hostKey: 'deadbeefcafe1234', runId: runId(1), sessionId: runId(1) });

/** the SELF row: this session's own beat, read from its own subtree (§2.1 rule 4 — the origin, never the deviceId) */
const selfRow: FixtureRow = { hb: makeHeartbeat({ runId: runId(1), pid: 4242 }), liveness: 'live', where: 'live', origin: SELF };

function peerHb(patch: Parameters<typeof makeHeartbeat>[0] = {}): Heartbeat {
  return makeHeartbeat({ deviceId: DEV_B, label: 'air', pid: 7, ...patch });
}

/**
 * The gap-closure wave's recorded problem, closed: `/who` and `/peers` DISAGREED about one fold. `listSessions`
 * pushes every `fold.live` row as `'live'`, while `peerViewOf` read `fold.liveness`, which only carries a key
 * once `livenessOf` has been called for it — so a freshly adopted OWN row counted as neither live nor stale and
 * the capture read `who · 1 live, 0 gone` beside `peers · 0 here, 0 stale`. `consider` now takes the bucket the
 * row came out of as its fallback.
 */
describe('peerViewOf — a fold row with no recomputed liveness verdict falls back to its BUCKET', () => {
  it('a freshly adopted own row with no `fold.liveness` entry counts as live, and /who and /peers agree', () => {
    const fold = foldOf([selfRow]);
    fold.liveness.clear();
    expect(peerViewOf(fold, SELF_ID)).toEqual({ live: 1, stale: 0, oldestStartedMsAgo: null, exclusive: false });
    // the two readers of one fold now answer the same number
    expect(listSessions(fold, SELF_ID, { all: false })).toHaveLength(peerViewOf(fold, SELF_ID).live);
  });

  it('a `fold.gone` row with no verdict counts as stale, and a fork with none counts as neither', () => {
    const gone = foldOf([{ hb: peerHb({ runId: runId(2) }), liveness: 'gone', where: 'gone' }]);
    gone.liveness.clear();
    expect(peerViewOf(gone, SELF_ID).stale).toBe(1);
    expect(peerViewOf(gone, SELF_ID).live).toBe(0);

    const fork = foldOf([{ hb: peerHb({ runId: runId(3) }), liveness: 'unknown', where: 'fork' }]);
    fork.liveness.clear();
    expect(peerViewOf(fork, SELF_ID)).toMatchObject({ live: 0, stale: 0 });
  });

  it('a recomputed verdict still WINS over the bucket — it may have aged past it', () => {
    // in `fold.live`, but `livenessOf` has since judged it stale: the verdict, not the bucket
    const aged = foldOf([{ hb: peerHb({ runId: runId(2) }), liveness: 'stale', where: 'live' }]);
    expect(peerViewOf(aged, SELF_ID)).toMatchObject({ live: 0, stale: 1 });
  });
});

describe('peerViewOf (TUI-DESIGN-5 §2.4) — twelve fold fixtures', () => {
  it('1 — an empty fold: no peers, no age, not exclusive', () => {
    expect(peerViewOf(emptyFold(NOW), SELF_ID)).toEqual({ live: 0, stale: 0, oldestStartedMsAgo: null, exclusive: false });
  });

  it('2 — self alone: `live` counts this session too (TD4 `<n> here`), and the peer facts stay null/false', () => {
    const v = peerViewOf(foldOf([selfRow]), SELF_ID);
    expect(v).toEqual({ live: 1, stale: 0, oldestStartedMsAgo: null, exclusive: false });
  });

  it('3 — one live peer beside self: two here, and the age is the PEER’s, never self’s', () => {
    const hb = peerHb({ runId: runId(2), startedAt: iso(T0 - 300_000) });
    const v = peerViewOf(foldOf([selfRow, { hb, liveness: 'live', where: 'live' }]), SELF_ID);
    expect(v.live).toBe(2);
    expect(v.stale).toBe(0);
    expect(v.oldestStartedMsAgo).toBe(300_000);
    expect(v.exclusive).toBe(false);
  });

  it('4 — one stale peer: `stale`, never `live`; `unknown` is neither (absence is not death)', () => {
    const stale = peerHb({ runId: runId(2) });
    const unknown = peerHb({ runId: runId(3), pid: 8 });
    const v = peerViewOf(foldOf([{ hb: stale, liveness: 'stale', where: 'gone', goneAgoMs: 900_000 }, { hb: unknown, liveness: 'unknown', where: 'live' }]), SELF_ID);
    expect(v.live).toBe(0);
    expect(v.stale).toBe(1);
  });

  it('5 — a live peer holding an EXCLUSIVE lease: `exclusive` is true', () => {
    const hb = peerHb({ runId: runId(2) });
    const lease = makeLease({ runId: runId(2), deviceId: DEV_B, type: 'exclusive', leaseId: 'l-ex' });
    const v = peerViewOf(foldOf([selfRow, { hb, liveness: 'live', where: 'live' }], [lease]), SELF_ID);
    expect(v).toMatchObject({ live: 2, exclusive: true });
  });

  it('5a — every member of `HOLDING_LEASE_TYPES` holds and `intent` does not (the re-declared set, §2.1 rule 6)', () => {
    const hb = peerHb({ runId: runId(2) });
    const rows = [selfRow, { hb, liveness: 'live' as const, where: 'live' as const }];
    for (const type of HOLDING_LEASE_TYPES) {
      const lease = makeLease({ runId: runId(2), deviceId: DEV_B, type, leaseId: `l-${type}` });
      expect(peerViewOf(foldOf(rows, [lease]), SELF_ID).exclusive, type).toBe(true);
    }
    const intent = makeLease({ runId: runId(2), deviceId: DEV_B, type: 'intent', leaseId: 'l-intent' });
    expect(peerViewOf(foldOf(rows, [intent]), SELF_ID).exclusive).toBe(false);
    // a RELEASED holding lease is not held any more
    const released = makeLease({ runId: runId(2), deviceId: DEV_B, type: 'exclusive', leaseId: 'l-rel', released: { at: iso(T0), outcome: 'committed', changed: {} } });
    expect(peerViewOf(foldOf(rows, [released]), SELF_ID).exclusive).toBe(false);
  });

  it('5b — this session’s OWN exclusive lease is not a peer fact', () => {
    const mine = makeLease({ runId: runId(1), deviceId: DEV_A, type: 'exclusive', leaseId: 'l-mine' });
    expect(peerViewOf(foldOf([selfRow], [mine]), SELF_ID).exclusive).toBe(false);
  });

  it('6 — a cloned device: its row still counts and is never hidden (§7 row 13)', () => {
    const hb = peerHb({ runId: runId(2) });
    const fold = foldOf([selfRow, { hb, liveness: 'live', where: 'live' }]);
    fold.cloned.add(DEV_B);
    expect(peerViewOf(fold, SELF_ID).live).toBe(2);
  });

  it('7 — an ignored device: its rows are in `fold.ignored`, so they never reach the counts', () => {
    const hb = peerHb({ runId: runId(2) });
    const v = peerViewOf(foldOf([selfRow, { hb, liveness: 'live', where: 'ignored' }]), SELF_ID);
    expect(v.live).toBe(1);
    expect(v.stale).toBe(0);
  });

  it('8 — a bench heartbeat counts like any other live session', () => {
    const hb = peerHb({ runId: runId(4), kind: 'bench', bench: { benchId: 'glm-vs-jev', tasks: { live: 4, done: 12, total: 30 }, lanes: 8, spendUsd: 1 } });
    expect(peerViewOf(foldOf([{ hb, liveness: 'live', where: 'live' }]), SELF_ID).live).toBe(1);
  });

  it('9 — a gone row INSIDE the 10-minute window is `stale` for the count and carries the oldest age', () => {
    const hb = peerHb({ runId: runId(2), startedAt: iso(T0 - 600_000) });
    const v = peerViewOf(foldOf([{ hb, liveness: 'gone', where: 'gone', goneAgoMs: 120_000 }]), SELF_ID);
    expect(v).toEqual({ live: 0, stale: 1, oldestStartedMsAgo: 600_000, exclusive: false });
  });

  it('10 — a gone row OUTSIDE the window (`stale`) counts the same way; the fold keeps the verdict, not the clock', () => {
    const hb = peerHb({ runId: runId(2) });
    const v = peerViewOf(foldOf([{ hb, liveness: 'stale', where: 'gone', goneAgoMs: 1_800_000 }]), SELF_ID);
    expect(v.stale).toBe(1);
  });

  it('11 — a fork (two records for one runId) is counted once per RECORD, by `${deviceId}/${runId}/${pid}`', () => {
    const holder = peerHb({ runId: runId(2), pid: 7 });
    const fork = peerHb({ runId: runId(2), pid: 9, deviceId: DEV_B });
    const v = peerViewOf(foldOf([{ hb: holder, liveness: 'live', where: 'live' }, { hb: fork, liveness: 'live', where: 'fork' }]), SELF_ID);
    expect(v.live).toBe(2);
  });

  it('12 — a live session in ANOTHER workspace is skipped (`sameRepo`’s rule, re-declared §2.1 rule 6)', () => {
    const elsewhere = peerHb({ runId: runId(5), repo: { wsKey: 'ws:other', repoKey: 'other-repo-key', remoteKey: null } });
    const v = peerViewOf(foldOf([selfRow, { hb: elsewhere, liveness: 'live', where: 'live' }]), SELF_ID);
    expect(v.live).toBe(1);
    // the re-declared rule agrees with the facade's own, on the same two inputs
    expect(sameRepo(elsewhere.repo, SELF_ID)).toBe(false);
    expect(sameRepo(makeHeartbeat().repo, SELF_ID)).toBe(true);
  });

  it('a fold with no self run (`self.runId === null`) treats every record as a peer', () => {
    const idle = makeSelf({ runId: null, sessionId: null, hostKey: 'deadbeefcafe1234' });
    const v = peerViewOf(foldOf([{ ...selfRow, hb: makeHeartbeat({ startedAt: iso(T0 - 90_000) }) }]), idle);
    expect(v).toMatchObject({ live: 1, oldestStartedMsAgo: 90_000 });
  });

  it('PROPERTY (§10, §7 row 61): no serialised `peerViewOf` output carries a path, a pid or a device id', () => {
    const hb = peerHb({ runId: runId(2), touched: { step: 7, files: ['src/loop/engine.ts'] }, pid: 31337 });
    const lease = makeLease({ runId: runId(2), deviceId: DEV_B, type: 'exclusive', leaseId: 'l-ex', paths: ['src/loop/engine.ts'] });
    for (const all of [true, false]) {
      void all;
      const text = JSON.stringify(peerViewOf(foldOf([selfRow, { hb, liveness: 'live', where: 'live' }], [lease]), SELF_ID));
      expect(text).not.toContain('/');
      expect(text).not.toContain('31337');
      expect(text).not.toContain('4242');
      expect(text).not.toContain(DEV_A);
      expect(text).not.toContain(DEV_B);
      expect(text).not.toContain('air');
      expect(text).not.toContain('engine.ts');
      expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['exclusive', 'live', 'oldestStartedMsAgo', 'stale']);
    }
  });
});

describe('activityView (§8.1 item 4) — the flattened projection', () => {
  const view = (patch: Parameters<typeof makeHeartbeat>[0] = {}, liveness: Liveness = 'live'): SessionActivityView => {
    const hb = makeHeartbeat({ deviceId: DEV_B, label: 'air', ...patch });
    const fold = foldOf([{ hb, liveness, where: liveness === 'gone' || liveness === 'stale' || liveness === 'stale-reused-pid' ? 'gone' : 'live' }]);
    const rows = listSessions(fold, SELF_ID, { all: true });
    const a = rows.find((r) => r.runId === hb.runId);
    expect(a, 'listSessions produced a row').toBeDefined();
    return activityView(a!);
  };

  it('ALL FIVE `Liveness` members survive, `stale-reused-pid` included (§14.2 #11, S3a)', () => {
    const seen = new Set<string>();
    for (const l of ['live', 'stale', 'stale-reused-pid', 'gone', 'unknown'] as const) {
      const hb = makeHeartbeat({ deviceId: DEV_B, runId: runId(9) });
      const fold = foldOf([{ hb, liveness: l, where: 'live' }]);
      // drive activityView through the SessionActivity listSessions built, then force the verdict the fold holds
      const a = listSessions(fold, SELF_ID, { all: true })[0];
      expect(a).toBeDefined();
      seen.add(activityView({ ...a!, liveness: l }).liveness);
    }
    expect([...seen].sort()).toEqual(['gone', 'live', 'stale', 'stale-reused-pid', 'unknown']);
  });

  it('carries `authority` and every one of the eight flags', () => {
    const v = view();
    expect(v.authority).toBe('trusted');
    expect(Object.keys(v.flags).sort()).toEqual(['cloned', 'forked', 'hung', 'ignoredDevice', 'noLock', 'skewed', 'takenOver', 'unverified']);
  });

  it('`authority` is `unverified` for an unauthenticated origin — §2.9’s `(unverified)` rendering depends on it', () => {
    const hb = makeHeartbeat({ deviceId: DEV_B, runId: runId(9) });
    const fold = foldOf([{ hb, liveness: 'live', where: 'live', origin: UNVERIFIED }]);
    expect(activityView(listSessions(fold, SELF_ID)[0]!).authority).toBe('unverified');
  });

  it('`subwork` counts the four kinds — the ONLY source of S1’s `lanes 2 · samples 3`', () => {
    const entries = [
      { kind: 'lane' as const, id: 'l1', since: iso(T0), stage: 'execute', detail60: '' },
      { kind: 'lane' as const, id: 'l2', since: iso(T0), stage: 'execute', detail60: '' },
      { kind: 'sample' as const, id: 's1', since: iso(T0), stage: 'propose', detail60: '' },
      { kind: 'sample' as const, id: 's2', since: iso(T0), stage: 'propose', detail60: '' },
      { kind: 'sample' as const, id: 's3', since: iso(T0), stage: 'propose', detail60: '' },
      { kind: 'probe' as const, id: 'p1', since: iso(T0), stage: 'propose', detail60: '' },
      { kind: 'child' as const, id: 'c1', since: iso(T0), stage: 'coordinate', detail60: '' },
    ];
    expect(view({ subwork: entries }).subwork).toEqual({ lanes: 2, samples: 3, probes: 1, children: 1 });
  });

  it('`subwork: null` means TRUNCATED AWAY (§15.1 Q20) and an EMPTY array means "none", which renders `lanes 0`', () => {
    expect(view({ subwork: [], truncated: true }).subwork).toBeNull();
    expect(view({ subwork: [] }).subwork).toEqual({ lanes: 0, samples: 0, probes: 0, children: 0 });
  });

  it('`spend.totalUsd` is `sessionUsd ?? generatorUsd + jevUsd` — the beat carries no `totalUsd`', () => {
    expect(view().spend).toEqual({ totalUsd: 0.15, capUsd: 2 });
    expect(view({ spend: { generatorUsd: 0.12, jevUsd: 0.03, sessionUsd: 0.42, capUsd: 2 } }).spend).toEqual({ totalUsd: 0.42, capUsd: 2 });
  });

  it('`bench` un-nests `tasks.done` / `tasks.total`, and is null on a run row', () => {
    expect(view().bench).toBeNull();
    expect(view({ kind: 'bench', bench: { benchId: 'glm-vs-jev', tasks: { live: 4, done: 12, total: 30 }, lanes: 8, spendUsd: 1 } }).bench).toEqual({ benchId: 'glm-vs-jev', done: 12, tasks: 30, lanes: 8 });
  });

  it('`deviceId8` is eight characters and the FULL device id never appears; `leaseCount` is a count, never the paths', () => {
    const hb = makeHeartbeat({ deviceId: 'zz5wq7cdzz5wq7cd', label: 'air', runId: runId(2) });
    const lease = makeLease({ runId: runId(2), deviceId: 'zz5wq7cdzz5wq7cd', paths: ['src/secret/path.ts'], leaseId: 'l1' });
    const fold = foldOf([{ hb, liveness: 'live', where: 'live' }], [lease]);
    const v = activityView(listSessions(fold, SELF_ID)[0]!);
    expect(v.deviceId8).toBe('zz5wq7cd');
    expect(v.leaseCount).toBe(1);
    expect(JSON.stringify(v)).not.toContain('zz5wq7cdzz5wq7cd');
    expect(JSON.stringify(v)).not.toContain('secret/path.ts');
  });

  it('the remaining straight-through fields', () => {
    const v = view({ step: 7, maxSteps: 40, stage: 'propose', mode: 'jev-on', repo: { branch: 'main', head: '3f9a2c1' + 'b'.repeat(33) }, touched: { step: 7, files: ['src/loop/engine.ts', 'src/x.ts'] } });
    expect(v).toMatchObject({ step: 7, maxSteps: 40, stage: 'propose', mode: 'jev-on', branch: 'main', ctxPct: 41, kind: 'run', sameRepo: true, sameBranch: true });
    expect(v.head?.startsWith('3f9a2c1')).toBe(true);
    expect(v.editing).toEqual(['src/loop/engine.ts', 'src/x.ts']);
    expect(v.beatAgeMs).toBe(0);
  });
});

describe('selfView (§8.1 item 4, §7 row 61)', () => {
  it('projects the three public fields and counts this device’s own live records', () => {
    const second = makeHeartbeat({ runId: runId(6), pid: 99 });
    const fold = foldOf([selfRow, { hb: second, liveness: 'live', where: 'live', origin: SELF }]);
    expect(selfView(SELF_ID, fold)).toEqual({ deviceId8: DEV_A.slice(0, 8), label: 'mbp', sameDeviceCount: 2 });
  });

  it('PROPERTY (§10, §7 row 61): the serialised view never emits `hostKey` or any of its bytes', () => {
    const secret = 'c0ffee1234abcd99';
    const self = makeSelf({ hostKey: secret, deviceId: 'k3q7m2abEXTRA' });
    for (const fold of [emptyFold(NOW), foldOf([selfRow])]) {
      const text = JSON.stringify(selfView(self, fold));
      expect(text).not.toContain(secret);
      expect(text).not.toContain('hostKey');
      expect(text).not.toContain('bootId');
      expect(text).not.toContain('k3q7m2abEXTRA');
      expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['deviceId8', 'label', 'sameDeviceCount']);
    }
  });
});

describe('/who rows (§2.3, §12.1 S1–S10)', () => {
  const g = GLYPHS.unicode;
  const ascii = glyphSet({ ascii: true });
  const mkView = (patch: Partial<SessionActivityView> = {}): SessionActivityView => ({
    runId: runId(2),
    sessionId: runId(2),
    label: 'mbp',
    parentSessionId: null,
    deviceId8: DEV_B,
    sameDevice: false,
    kind: 'run',
    liveness: 'live',
    authority: 'trusted',
    flags: { hung: false, skewed: false, forked: false, takenOver: false, noLock: false, ignoredDevice: false, unverified: false, cloned: false },
    beatAgeMs: 2_000,
    arrivalAgeMs: 2_000,
    skewMs: null,
    syncLagMs: null,
    sameRepo: true,
    sameBranch: true,
    leaseCount: 1,
    step: 7,
    maxSteps: 40,
    stage: 'propose',
    mode: 'jev-on',
    branch: 'main',
    head: '3f9a2c1' + 'b'.repeat(33),
    ctxPct: 41,
    spend: { totalUsd: 0.12, capUsd: 2 },
    editing: ['src/loop/engine.ts', 'src/x.ts'],
    subwork: { lanes: 2, samples: 3, probes: 0, children: 0 },
    bench: null,
    ...patch,
  });
  const me = { deviceId8: DEV_A, label: 'mbp-self', sameDeviceCount: 1 };

  it('S7 — the header counts live and gone, and STALE is its own clause (§14.2 #58)', () => {
    expect(whoHeader([mkView(), mkView({ liveness: 'gone' }), mkView({ liveness: 'unknown' })], g)).toBe('who · 1 live, 1 gone');
    // a stale row is not a gone row: S3 and S3b were split for exactly this reason
    expect(whoHeader([mkView(), mkView({ liveness: 'stale' }), mkView({ liveness: 'stale-reused-pid' }), mkView({ liveness: 'gone' })], g)).toBe('who · 1 live, 2 stale, 1 gone');
    expect(whoHeader([mkView({ liveness: 'stale' })], g)).toBe('who · 0 live, 1 stale, 0 gone');
  });

  it('S8 — the empty state, and S9 only under `--all` (§7 row 11), in BOTH branches', () => {
    expect(whoRows([], me, { width: 80, g })).toEqual([{ kind: 'note', flush: true, text: WHO_EMPTY }]);
    // §7 row 11 phrases the notice as a `/who --all` behaviour: the empty branch used to print it unconditionally
    // while the non-empty branch gated it, so one fold state produced two different outputs
    expect(whoRows([], me, { width: 80, g, skipped: 3 })).toEqual([{ kind: 'note', flush: true, text: WHO_EMPTY }]);
    expect(whoRows([], me, { width: 80, g, skipped: 3, all: true })[1]).toEqual({ kind: 'note', flush: true, text: foldCapNotice(3) });
    const rows = whoRows([mkView()], me, { width: 80, g, skipped: 3 });
    expect(rows.some((r) => r.kind === 'note' && r.text === foldCapNotice(3))).toBe(false);
    expect(whoRows([mkView()], me, { width: 80, g, skipped: 3, all: true }).at(-1)).toEqual({ kind: 'note', flush: true, text: foldCapNotice(3) });
    expect(foldCapNotice(1)).toBe('1 device past the fold cap — jevcode sessions gc lists them');
  });

  it('S1 — the widest run row carries every cell, and the head is clipped to seven characters', () => {
    const cells = whoCells(mkView(), whoGlyphs(g));
    expect(cells[0]).toBe('● mbp');
    expect(cells).toContain('main@3f9a2c1');
    expect(cells).toContain('jev-on');
    expect(cells).toContain('ctx 41%');
    expect(cells).toContain('$0.12/2.00');
    expect(cells).toContain('editing src/loop/engine.ts (+1)');
    expect(cells).toContain('lanes 2 · samples 3');
    expect(cells).toContain('beat 2 s');
  });

  it('S2 — a bench row is a DIFFERENT row shape, not a variant (§7 row 12)', () => {
    const b = mkView({ kind: 'bench', bench: { benchId: 'glm-vs-jev', done: 12, tasks: 30, lanes: 8 }, subwork: { lanes: 4, samples: 0, probes: 0, children: 0 } });
    expect(whoCells(b, whoGlyphs(g))).toEqual(['● mbp', 'bench glm-vs-jev', '12/30 tasks', 'live 4 · lanes 8']);
  });

  it('the liveness glyph per member, with its ascii twin (S3 corrected to `.`, S3b `○`→`o`, §14.2 #43)', () => {
    const by = (l: SessionActivityView['liveness'], set = g): string => whoCells(mkView({ liveness: l }), whoGlyphs(set))[0] ?? '';
    expect(by('live')).toBe('● mbp');
    expect(by('stale')).toBe('◌ mbp');
    expect(by('stale-reused-pid')).toBe('◌ mbp');
    expect(by('gone')).toBe('○ mbp');
    expect(by('unknown')).toBe('? mbp');
    expect(by('live', ascii)).toBe('* mbp');
    expect(by('stale', ascii)).toBe('. mbp');
    expect(by('gone', ascii)).toBe('o mbp');
  });

  it('S10 — the eight flag suffixes come out in the fixed order, `⚠` through the glyph set', () => {
    const flagged = mkView({ flags: { hung: true, skewed: true, forked: true, takenOver: true, noLock: true, ignoredDevice: true, unverified: true, cloned: true }, skewMs: 412_000 });
    expect(flagSuffixes(flagged, g)).toEqual(['⚠ hung', '⚠ skewed 412s', '⚠ forked', 'taken over', 'no lock', 'ignored', 'unverified', '⚠ cloned']);
    expect(flagSuffixes(flagged, ascii)[0]).toBe('! hung');
    // §7 row 13: a flagged row is NEVER hidden
    expect(whoRows([flagged], me, { width: 120, g }).length).toBe(2);
  });

  it('§2.3 width ladder: 120 keeps all NINE cells (`lanes · samples` included), 80 drops the tail, 40 is the three-cell form', () => {
    const row = mkView();
    // a run row HAS nine cells, and §2.14 consequence 1 makes the ninth the only place `subwork` is ever rendered
    expect(whoCells(row, whoGlyphs(g))).toHaveLength(WHO_CELLS_MAX);
    expect(keptCells(120)).toBe(WHO_CELLS_MAX);
    // `blockWidth(120) = 110` — the block width the TUI actually passes at 120 columns — keeps them too
    expect(keptCells(blockWidth(120))).toBe(WHO_CELLS_MAX);
    const shown = (w: number): string[] => whoShownCells(row, whoGlyphs(g), w);
    expect(shown(120)).toHaveLength(9);
    expect(shown(120).join('  ')).toBe('● mbp  main@3f9a2c1  step 7/40 propose  jev-on  ctx 41%  $0.12/2.00  editing src/loop/engine.ts (+1)  lanes 2 · samples 3  beat 2 s');
    expect(shown(120)).toContain('lanes 2 · samples 3');
    expect(shown(80)).toHaveLength(6);
    expect(shown(80)).not.toContain('lanes 2 · samples 3');
    // §2.3's 40-column form, verbatim — and `beat` survives because cells drop in `whoCells`' order, not S1's
    expect(shown(40)).toEqual(['● mbp', 'step 7/40 propose', 'beat 2 s']);
    expect(shown(blockWidth(40))).toEqual(['● mbp', 'step 7/40 propose', 'beat 2 s']);
  });

  it('§13 / blocker 1: the row the RENDERER draws equals `whoPlainRow` at 40, 80 and 120 — no table-column cap', () => {
    const row = mkView();
    for (const columns of [40, 80, 120]) {
      const w = blockWidth(columns);
      const drawn = renderBlock(whoRows([row], me, { width: w, g }), w, g).map((r) => r.text);
      expect(drawn, `columns ${columns}`).toEqual([whoPlainRow(row, { width: w, g })]);
      // and the drawn row is one line: `renderBlock`'s `facts`/`wrap:false` arm never re-wraps a pre-built row
      expect(drawn).toHaveLength(1);
    }
  });

  it('§13 / gate G-R5-6: the flag row is clipped to the width in both sinks, and it is the same string', () => {
    const flagged = mkView({ flags: { hung: true, skewed: true, forked: true, takenOver: true, noLock: true, ignoredDevice: true, unverified: true, cloned: true }, skewMs: 412_000 });
    const w = blockWidth(40);
    const built = whoRows([flagged], me, { width: w, g });
    const drawn = renderBlock(built, w, g).map((r) => r.text);
    const flagRow = whoFlagRow(flagged, { width: w, g });
    expect(flagRow).not.toBeNull();
    expect(flagRow?.length).toBeLessThanOrEqual(w);
    expect(drawn).toEqual([whoPlainRow(flagged, { width: w, g }), flagRow]);
    for (const line of drawn) expect(line.length).toBeLessThanOrEqual(w);
    // at a width that holds them, all eight flags are there
    expect(whoFlagRow(flagged, { width: 200, g })).toBe('  ⚠ hung · ⚠ skewed 412s · ⚠ forked · taken over · no lock · ignored · unverified · ⚠ cloned');
  });

  it('§13: the `--plain` twin IS the row the TUI drew at the same width', () => {
    for (const w of [40, 80, 120]) {
      const built = whoRows([mkView()], me, { width: w, g })[0];
      const text = built !== undefined && built.kind === 'facts' ? (built.segments[0] ?? '') : '';
      expect(whoPlainRow(mkView(), { width: w, g })).toBe(text);
    }
  });

  it('§13 / §2.3: a DUPLICATE device label is qualified in both sinks — the twin never prints the bare label', () => {
    const a = mkView({ label: 'mbp', deviceId8: 'aaaaaaaa' });
    const b = mkView({ label: 'mbp', deviceId8: 'bbbbbbbb', runId: runId(3) });
    const built = whoRows([a, b], me, { width: 120, g });
    const label = labelResolver([a, b], me);
    expect(label(a)).toBe('mbp#aaaaaaaa');
    const tui = built.filter((r) => r.kind === 'facts').map((r) => (r.kind === 'facts' ? (r.segments[0] ?? '') : ''));
    expect(tui[0]?.startsWith('● mbp#aaaaaaaa')).toBe(true);
    expect(tui).toEqual([whoPlainRow(a, { width: 120, g, label: label(a) }), whoPlainRow(b, { width: 120, g, label: label(b) })]);
    // the divergence the single-label fixture could not see: without the resolver the twin says `mbp`
    expect(whoPlainRow(a, { width: 120, g }).startsWith('● mbp  ')).toBe(true);
  });

  it('§12.1 S1–S5 SR: the screen-reader GLYPH SET makes the row the sentence — `whoSentence` has a sink', () => {
    const sr = glyphSet({ screenReader: true });
    expect(sr.mode).toBe('sr');
    const row = mkView();
    expect(whoRowText(row, { width: 120, g: sr })).toBe(whoSentence(row));
    const built = whoRows([row], me, { width: 120, g: sr })[0];
    expect(built?.kind === 'facts' ? built.segments[0] : '').toBe(whoSentence(row));
    // the flags are spoken inside the sentence, so there is no second dim row to read out
    const flagged = mkView({ flags: { ...row.flags, cloned: true } });
    expect(whoFlagRow(flagged, { width: 120, g: sr })).toBeNull();
    expect(whoSentence(flagged)).toContain('cloned device');
  });

  it('§2.3: two devices sharing one label are qualified `label#id8`; a unique label never is', () => {
    const a = mkView({ label: 'mbp', deviceId8: 'aaaaaaaa' });
    const b = mkView({ label: 'mbp', deviceId8: 'bbbbbbbb', runId: runId(3) });
    const solo = mkView({ label: 'air', deviceId8: 'cccccccc' });
    const resolve = labelResolver([a, b, solo], me);
    expect(resolve(a)).toBe('mbp#aaaaaaaa');
    expect(resolve(b)).toBe('mbp#bbbbbbbb');
    expect(resolve(solo)).toBe('air');
    // self's own label counts: one peer named `mbp-self` is ambiguous against this device
    expect(labelResolver([mkView({ label: 'mbp-self', deviceId8: 'dddddddd' })], me)(mkView({ label: 'mbp-self', deviceId8: 'dddddddd' }))).toBe('mbp-self#dddddddd');
  });

  it('§7 row 82: the screen-reader sentence carries every fact the sighted row does (§14.2 #60)', () => {
    const s = whoSentence(mkView());
    // §12.1 S1's SR cell is `spent 12 cents of 2 dollars`, not the digits of the sighted cell (fix pass, finding 16)
    for (const part of ['mbp', 'live', 'main at 3f9a2c1', 'step 7 of 40 propose', 'mode jev on', 'context 41 percent', 'spent 12 cents of 2 dollars', 'editing 2 files', '2 lanes and 3 samples', 'last beat 2 seconds ago']) {
      expect(s, part).toContain(part);
    }
    expect(whoSentence(mkView({ liveness: 'stale-reused-pid' }))).toContain('the process id was reused');
    expect(whoSentence(mkView({ spend: { totalUsd: 0.01, capUsd: 1 } }))).toContain('spent 1 cent of 1 dollar');
    expect(whoSentence(mkView({ spend: { totalUsd: 1.5, capUsd: 2 } }))).toContain('spent 1.50 dollars of 2 dollars');
    // the resolved label reaches the sentence too, so the SR twin of a duplicate label is not a lie either
    expect(whoSentence(mkView({ label: 'mbp' }), 'mbp#aaaaaaaa').startsWith('mbp#aaaaaaaa,')).toBe(true);
    expect(whoSentence(mkView({ kind: 'bench', bench: { benchId: 'glm-vs-jev', done: 12, tasks: 30, lanes: 8 }, subwork: { lanes: 4, samples: 0, probes: 0, children: 0 } }))).toContain('12 of 30 tasks');
  });

  it('`shortAge` reads in seconds, minutes, hours and days', () => {
    expect([shortAge(2_000), shortAge(240_000), shortAge(7_200_000), shortAge(200_000_000)]).toEqual(['2 s', '4 m', '2 h', '2 d']);
    expect(shortAge(Number.NaN)).toBe('0 s');
  });

  it('a row with nothing to say degrades rather than lying (`step —`, no ctx, no spend, no editing)', () => {
    const bare = mkView({ step: null, maxSteps: null, stage: null, mode: null, branch: null, head: null, ctxPct: null, spend: null, editing: [], subwork: null });
    const built = whoRows([bare], me, { width: 120, g })[0];
    expect(built !== undefined && built.kind === 'facts' ? built.segments : []).toEqual(['● mbp  step —  beat 2 s']);
  });
});

describe('the re-declared peer values agree with the facade (§2.1 rule 6)', () => {
  it('`HOLDING_LEASE_TYPES` still has exactly the six members `peers.ts` re-declares', () => {
    expect([...HOLDING_LEASE_TYPES].sort()).toEqual(['agent', 'command', 'exclusive', 'lane', 'takeover', 'worktree']);
  });

  it('the fold’s own `boot`/origin plumbing is untouched by the mappers (they read, never derive)', () => {
    const fold = foldOf([selfRow]);
    expect(fold.origins.get(`${DEV_A}/${runId(1)}`)).toEqual(SELF);
    expect(SELF_ID.bootAt).toBe(BOOT);
    expect(claim().runId).toBe(runId(1));
    expect(WS.startsWith('ws:')).toBe(true);
    expect(REPO.length).toBe(16);
  });
});
