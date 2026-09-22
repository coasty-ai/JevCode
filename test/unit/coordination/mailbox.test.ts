/**
 * §5 messaging. §11 rows: 12 (secrets — redacted, refused, never truncated), 25 (a flood: caps, mute, control expiry),
 * 28 (a message to a session that never returns), 42 (two Macs with one label → `#id4`), 45 (`sessions pause` from
 * anywhere), 50 (a message never widens rights). Review blockers 5 / 6: a message's authority comes from the path it was
 * read from and its hmac — a forged "same device" `pause` in a shared mirror is a `[y]` row, never applied.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ack, awaitAck, classifyIncoming, consumerIdOf, inbox, loadSeen, resolveTarget, send, MUTE_THRESHOLD_PER_MIN, SEEN_MAX } from '../../../src/coordination/mailbox.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { commonsPaths } from '../../../src/coordination/paths.js';
import { CONTROL_MESSAGE_TTL_MS, MESSAGE_TTL_MS, parseRecord, serializeRecord } from '../../../src/coordination/records.js';
import { DIRECTIVE_MAX_CHARS } from '../../../src/core/types.js';
import { ackOrigin, authorityOf } from '../../../src/coordination/index.js';
import type { LedgerHandle, Message, RecordOrigin } from '../../../src/coordination/index.js';
import { DEV_A, DEV_B, KEY_A, REPO, SELF, T0, TRUSTED, UNVERIFIED, claim, entry, fakeClock, fakeTimers, foldOf, iso, makeAck, makeDevice, makeHeartbeat, makeMessage, makeSelf, putAck, putHeartbeat, putMessage, runId, stamp, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // LIFO: a ledger must close (draining its write chain) before its temp dir is removed
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(o: { self?: Partial<ReturnType<typeof makeSelf>>; redact?: (s: string) => string; commonsKey?: string | null } = {}) {
  const t = await tempHome();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const timers = fakeTimers();
  const l: LedgerHandle = openLedger({
    home: t.home,
    self: makeSelf(o.self ?? {}),
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    timers,
    isPidAlive: () => true,
    pid: 4242,
    scanOnly: true,
    commonsKey: o.commonsKey ?? null,
    trustKeys: new Map(),
    ...(o.redact !== undefined ? { redact: o.redact } : {}),
  });
  cleanups.push(() => l.close());
  await l.open();
  return { t, l, clock, timers };
}

describe('send (§5.1)', () => {
  it('writes inbox/<myDevice>/<target>/<t>-<seq>.json with a parseable id and an hmac when paired', async () => {
    const { t, l } = await harness({ commonsKey: KEY_A });
    const r = await send(l, { to: `@${REPO}`, type: 'heads-up', text: 'editing src/x.ts', refs: { files: ['src/x.ts'] }, by: 'engine' });
    expect(r.id).toMatch(/^[a-z2-7]{8}-[a-z2-7]{8}-\d{1,9}$/);
    expect(r.path).toBe(join(commonsPaths(t.root).deviceDir('inbox', DEV_A), `@${REPO}`, `${T0}-${r.id.split('-')[2]}.json`));
    const text = (await nodeFs.readBounded(r.path, 4096)).text;
    const parsed = parseRecord(text, 'message', { deviceId: DEV_A, target: `@${REPO}` });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.type).toBe('heads-up');
    expect(parsed.record.refs.files).toEqual(['src/x.ts']);
    expect(parsed.record.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(parsed.record.expiresAt)).toBe(T0 + MESSAGE_TTL_MS);
  });

  it('§5.1: control types expire in 10 min so a stale pause never applies later', async () => {
    const { l } = await harness();
    const r = await send(l, { to: runId(9), type: 'pause', text: 'pause at step end', by: 'human' });
    const m = [...l.fold.leases.keys()].length === 0 ? l.ownEntries().find((e) => e.kind === 'message')?.record as Message | undefined : undefined;
    expect(m?.id).toBe(r.id);
    expect(Date.parse(m?.expiresAt ?? '')).toBe(T0 + CONTROL_MESSAGE_TTL_MS);
  });

  it('§11 row 12: every leaf is redacted; a secret never reaches the file', async () => {
    const { l } = await harness({ redact: (s) => s.replace(/sk-[a-z0-9]+/g, '[REDACTED:key]') });
    const r = await send(l, { to: '@all', type: 'note', text: 'token is sk-deadbeef42' });
    const text = (await nodeFs.readBounded(r.path, 4096)).text;
    expect(text).not.toContain('sk-deadbeef42');
    expect(text).toContain('[REDACTED:key]');
  });

  it('§11 row 12: over 600 chars or over 2 KiB is REFUSED, never truncated', async () => {
    const { l } = await harness();
    await expect(send(l, { to: '@all', type: 'note', text: 'x'.repeat(DIRECTIVE_MAX_CHARS + 1) })).rejects.toThrow(/message too large/);
    await expect(send(l, { to: '@all', type: 'note', text: 'ok', refs: { files: Array.from({ length: 32 }, () => `src/${'p'.repeat(200)}.ts`) } })).rejects.toThrow(/message too large/);
  });

  it('an invalid target is refused before anything is written', async () => {
    const { l } = await harness();
    await expect(send(l, { to: '../../etc', type: 'note', text: 'x' })).rejects.toThrow(/is not a session id/);
    await expect(send(l, { to: '@main', type: 'note', text: 'x' })).rejects.toThrow(/is not a session id/);
  });

  it('§11 row 25: more than 60 messages a minute mutes the sender for 10 min', async () => {
    const { l } = await harness();
    for (let i = 0; i < MUTE_THRESHOLD_PER_MIN; i++) await send(l, { to: '@all', type: 'note', text: `n${i}` });
    await expect(send(l, { to: '@all', type: 'note', text: 'one too many' })).rejects.toThrow(/muted for 10 min/);
    await expect(send(l, { to: '@all', type: 'note', text: 'still muted' })).rejects.toThrow(/muted for/);
  });

  it('a resumed run never re-mints an id its earlier process published (review #12)', async () => {
    const { l } = await harness();
    const first = await send(l, { to: '@all', type: 'note', text: 'before the pause' });
    // the resume folds its own outbox, so the Lamport seed is above everything published
    await l.refresh('all');
    await l.setIdentity({ runId: runId(1), sessionId: runId(1) });
    const second = await send(l, { to: '@all', type: 'note', text: 'after the resume' });
    expect(second.id).not.toBe(first.id);
    expect(Number(second.id.split('-')[2])).toBeGreaterThan(Number(first.id.split('-')[2]));
  });
});

describe('inbox (pure) and the seen set', () => {
  const self = makeSelf();

  it('the union over my targets, minus expired, minus seen, minus my own — in stamp order', () => {
    const mine = makeMessage({ id: `${DEV_A}-abcdefgh-1`, from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, to: '@all', stamp: stamp(1, DEV_A, runId(1)) });
    const entries = [
      entry(mine, SELF),
      entry(makeMessage({ id: `${DEV_B}-abcdefgh-5`, to: runId(1), stamp: stamp(5, DEV_B, runId(9)) }), TRUSTED),
      entry(makeMessage({ id: `${DEV_B}-abcdefgh-2`, to: `@${REPO}`, stamp: stamp(2, DEV_B, runId(9)) }), TRUSTED),
      entry(makeMessage({ id: `${DEV_B}-abcdefgh-3`, to: '@all', expiresAt: iso(T0 - 1), stamp: stamp(3, DEV_B, runId(9)) }), TRUSTED),
      entry(makeMessage({ id: `${DEV_B}-abcdefgh-4`, to: '@all', stamp: stamp(4, DEV_B, runId(9)) }), TRUSTED),
    ];
    const fold = foldOf(entries);
    const got = inbox(fold, self, new Set([`${DEV_B}-abcdefgh-4`]));
    expect(got.map((m) => m.id)).toEqual([`${DEV_B}-abcdefgh-2`, `${DEV_B}-abcdefgh-5`]);
  });

  it('review #13: the consumer is a PROCESS — a sessionless TUI keeps its own seen file', async () => {
    // + review major 8: a consumer is a PROCESS — `${sessionId ?? 'tui'}-${actor8}`, unique per writer either way
    expect(consumerIdOf({ sessionId: runId(1) }, 'abcdefgh')).toBe(`${runId(1)}-abcdefgh`);
    expect(consumerIdOf({ sessionId: null }, 'abcdefgh')).toBe('tui-abcdefgh');
    const { t, l } = await harness({ self: { sessionId: null, runId: null } });
    expect([...(await loadSeen(l))]).toEqual([]);
    // §3.1: the seen file lives under inbox/seen/<deviceId>/, where no deviceId regex can ever match the 'seen' level
    expect(commonsPaths(t.root).seenFile(DEV_A, consumerIdOf(l.self, l.actor8))).toBe(join(t.root, 'inbox', 'seen', DEV_A, `tui-${l.actor8}.json`));
  });
});

describe('ack / awaitAck (§5.1)', () => {
  it('writes acks/<myDevice>/<msgId>/<mySession>.json, appends to seen, and the sender folds it', async () => {
    const { t, l } = await harness({ commonsKey: KEY_A });
    const msgId = `${DEV_B}-abcdefgh-3`;
    l.trackAck(msgId);
    await ack(l, msgId, 'applied', 'paused at step end');
    const file = commonsPaths(t.root).ackFile(DEV_A, msgId, consumerIdOf(l.self, l.actor8));
    const parsed = parseRecord((await nodeFs.readBounded(file, 4096)).text, 'ack', { deviceId: DEV_A });
    expect(parsed.ok && parsed.record.outcome).toBe('applied');
    expect(parsed.ok && parsed.record.detail60).toBe('paused at step end');
    expect(parsed.ok && parsed.record.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect([...(await loadSeen(l))]).toEqual([msgId]);
    await expect(ack(l, 'nope', 'delivered')).rejects.toThrow(/is not a message id/);
  });

  it('§11 row 28: awaitAck resolves with the ack, or null after the timeout — never a busy loop', async () => {
    const { l, timers } = await harness();
    const msgId = `${DEV_B}-abcdefgh-3`;
    const pending = awaitAck(l, msgId, 5_000);
    timers.tick(5_000);
    expect(await pending).toBeNull();
  });

  it('an ack already on disk resolves at once', async () => {
    const { t, l } = await harness();
    const msgId = `${DEV_B}-abcdefgh-3`;
    await putAck(t.root, makeAck({ msgId, deviceId: DEV_A, by: runId(1) }));
    l.trackAck(msgId);
    await l.refresh('all');
    // + review blocker 3: BELIEVED only — this ack is in our own local subtree, for a message our own session sent
    const got = await awaitAck(l, msgId, 1);
    expect(got?.outcome).toBe('delivered');
    expect(authorityOf(ackOrigin(l.fold, got as NonNullable<typeof got>))).toBe('self');
  });

  /**
   * + review major 8: TWO PROCESSES ON ONE SESSION (`jevcode -c` twice on a paused session, or a TUI and the run it
   * spawned). The old `acks/<dev>/<msgId>/<sessionId>.json` gave them ONE file name and two writers — the second
   * `writeAtomic` silently replaced the first, and `seen/<sessionId>.json` lost whichever process wrote first.
   * The consumer id is per PROCESS, so each writes its own file and neither loses the other's.
   */
  it('two processes on ONE session ack one broadcast into two files (§5.1, review major 8)', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const msgId = `${DEV_B}-abcdefgh-3`;
    const rid = runId(1);
    const consumers: string[] = [];
    // the RUN of the session, and a second process attached to the same session id (`jevcode -c` on a paused session):
    // one session, two writers — the `actor8` is what separates them
    for (const runIdOf of [rid, null]) {
      const l = openLedger({
        home: t.home,
        self: makeSelf({ runId: runIdOf, sessionId: rid }),
        now: clock.now,
        monotonicNow: clock.monotonicNow,
        scanOnly: true,
        isPidAlive: () => true,
        random: () => Uint8Array.from([0x22, 0x22, 0x22, 0x22, 0x22]),
      });
      await l.open();
      await ack(l, msgId, 'delivered');
      consumers.push(consumerIdOf(l.self, l.actor8));
      await l.close();
    }
    const files = (await nodeFs.readdir(commonsPaths(t.root).ackDir(DEV_A, msgId))).sort();
    expect(files).toHaveLength(2);
    expect(files).toEqual(consumers.map((c) => `${c}.json`).sort());
    // both parse under the path binding, and both name the same session
    for (const f of files) {
      const parsed = parseRecord((await nodeFs.readBounded(join(commonsPaths(t.root).ackDir(DEV_A, msgId), f), 4096)).text, 'ack', { deviceId: DEV_A });
      expect(parsed.ok && parsed.record.by.startsWith(`${rid}-`)).toBe(true);
    }
  });

  it('+ review major 8: a SESSIONLESS consumer may ack `delivered`, but not claim an outcome only a run can produce', async () => {
    const { l } = await harness({ self: { sessionId: null, runId: null } });
    const msgId = `${DEV_B}-abcdefgh-3`;
    await expect(ack(l, msgId, 'delivered')).resolves.toBeUndefined();
    await expect(ack(l, msgId, 'applied')).rejects.toThrow(/no session id/);
  });
});

describe('the permission boundary (§5.4, §10.3, §11 row 50)', () => {
  const trusted = new Set([DEV_B]);
  const self = { deviceId: DEV_A };
  const msg = (type: Message['type'], from = DEV_B): Message => makeMessage({ type, from: { deviceId: from, label: 'studio', sessionId: runId(9), runId: runId(9), user: 'p' } });

  it('an untrusted `steer` is downgraded to a note; a trusted, hmac-valid one is a directive', () => {
    const untrusted = classifyIncoming(msg('steer'), { self, trusted, remoteControl: 'confirm', origin: UNVERIFIED });
    expect(untrusted).toMatchObject({ action: 'note', downgraded: true, authority: 'unverified' });
    const paired = classifyIncoming(msg('steer'), { self, trusted, remoteControl: 'confirm', origin: TRUSTED });
    expect(paired).toMatchObject({ action: 'steer', downgraded: false, authority: 'trusted' });
    // listed but NOT hmac-valid is still unverified (review blocker 5)
    expect(classifyIncoming(msg('steer'), { self, trusted, remoteControl: 'allow', origin: { self: false, source: null, authenticated: false } }).action).toBe('note');
  });

  it('`abort` ALWAYS needs the local [y], even from this device', () => {
    for (const origin of [SELF, TRUSTED, UNVERIFIED]) expect(classifyIncoming(msg('abort'), { self, trusted, remoteControl: 'allow', origin }).needsConfirm).toBe(true);
  });

  it('review blocker 6: a FORGED same-device pause read from a MIRROR is a [y] row, never applied', () => {
    const forged = msg('pause', DEV_A); // from.deviceId === my own device id
    const mirror: RecordOrigin = { self: false, source: '/shared/jevcode-commons', authenticated: false };
    const d = classifyIncoming(forged, { self, trusted, remoteControl: 'confirm', origin: mirror });
    expect(d.authority).toBe('unverified');
    expect(d.needsConfirm).toBe(true);
    // and under 'allow' a forged resume still cannot spawn a run unattended
    expect(classifyIncoming(msg('resume', DEV_A), { self, trusted, remoteControl: 'allow', origin: mirror }).needsConfirm).toBe(true);
    // the genuine local file applies without a prompt
    expect(classifyIncoming(forged, { self, trusted, remoteControl: 'confirm', origin: SELF }).needsConfirm).toBe(false);
  });

  it('remoteControl never / confirm / allow (§5.4)', () => {
    expect(classifyIncoming(msg('pause'), { self, trusted, remoteControl: 'never', origin: TRUSTED })).toMatchObject({ action: 'note', downgraded: true });
    expect(classifyIncoming(msg('pause'), { self, trusted, remoteControl: 'never', origin: TRUSTED }).refused).toMatch(/remoteControl: never/);
    expect(classifyIncoming(msg('pause'), { self, trusted, remoteControl: 'confirm', origin: TRUSTED })).toMatchObject({ action: 'pause', needsConfirm: true });
    expect(classifyIncoming(msg('pause'), { self, trusted, remoteControl: 'allow', origin: TRUSTED })).toMatchObject({ action: 'pause', needsConfirm: false });
  });

  it('facts never need a decision: note / heads-up / handoff / who / request-release pass through', () => {
    for (const type of ['note', 'heads-up', 'handoff', 'who', 'request-release', 'ack'] as const) {
      const d = classifyIncoming(msg(type), { self, trusted, remoteControl: 'never', origin: UNVERIFIED });
      expect(d).toMatchObject({ action: type, downgraded: false, needsConfirm: false, refused: null });
    }
  });
});

describe('the target grammar (§5.3, §11 row 42)', () => {
  const self = makeSelf();
  const peer = (n: number, patch: Parameters<typeof makeHeartbeat>[0] = {}) => {
    const rid = runId(n);
    return entry(makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, label: 'studio', stamp: stamp(n, DEV_B, rid), claim: claim({ deviceId: DEV_B, runId: rid, pid: 900 + n }), ...patch }), TRUSTED);
  };

  it('me / all / repo / tree', () => {
    const fold = foldOf([entry(makeHeartbeat(), SELF), peer(9)]);
    expect(resolveTarget(fold, self, 'all')).toEqual({ ok: true, to: ['@all'] });
    expect(resolveTarget(fold, self, 'me')).toEqual({ ok: true, to: [runId(1)] });
    expect(resolveTarget(fold, self, 'repo')).toEqual({ ok: true, to: [`@${REPO}`] });
    expect(resolveTarget(fold, self, 'tree')).toEqual({ ok: true, to: [runId(9)] });
    expect(resolveTarget(fold, self, '')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(resolveTarget(fold, makeSelf({ sessionId: null }), 'me')).toMatchObject({ ok: false });
  });

  it('§5.3: the trailing 8 random chars of a run id resolve; two runs of one day are ambiguous', () => {
    const fold = foldOf([entry(makeHeartbeat(), SELF), peer(9)]);
    expect(resolveTarget(fold, self, runId(9).slice(-8))).toEqual({ ok: true, to: [runId(9)] });
    expect(resolveTarget(fold, self, '20260921')).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('a title or unique prefix resolves', () => {
    const fold = foldOf([peer(9, { title60: 'rotate the store' })]);
    expect(resolveTarget(fold, self, 'rotate the')).toEqual({ ok: true, to: [runId(9)] });
    expect(resolveTarget(fold, self, 'nothing like this')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('§11 row 42: two Macs with one label need the #id4 form', () => {
    const dupLabel = 'MacBook-Pro.local';
    const fold = foldOf([
      entry(makeDevice({ label: dupLabel }), SELF),
      entry(makeDevice({ deviceId: DEV_B, label: dupLabel }), TRUSTED),
      entry(makeHeartbeat({ label: dupLabel }), SELF),
      peer(9, { label: dupLabel }),
    ]);
    expect(resolveTarget(fold, self, `device:${dupLabel}`)).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(resolveTarget(fold, self, `device:${dupLabel}#${DEV_B.slice(0, 4)}`)).toEqual({ ok: true, to: [runId(9)] });
    expect(resolveTarget(fold, self, `device:${DEV_B}`)).toEqual({ ok: true, to: [runId(9)] });
  });
});

describe('§11 row 45: `sessions pause <id>` from any shell reaches the run', () => {
  it('a CLI twin with no run mints its own actor8, sends, and the run folds the message', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const rid = runId(1);
    await putHeartbeat(t.root, makeHeartbeat({ runId: rid, sessionId: rid, phase: 'blocked', blocked: 'spend-limit', claim: claim({ runId: rid, pid: 4242 }) }));
    // the twin: no sessionId, no runId
    const twin = openLedger({ home: t.home, self: makeSelf({ sessionId: null, runId: null }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, isPidAlive: () => true });
    await twin.open();
    const sent = await send(twin, { to: rid, type: 'pause', text: 'pause at step end', by: 'human' });
    expect(sent.id.split('-')[1]).toBe(twin.actor8);
    await twin.close();
    // the run, parked on a pane for a day, folds it
    clock.advance(24 * 3_600_000);
    const run = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, isPidAlive: () => true });
    await run.open();
    const got = inbox(run.fold, run.self, new Set());
    expect(got).toHaveLength(0); // the control message expired after 10 min — a day-old pause never applies late
    await run.close();
    // within the window it is delivered
    const clock2 = fakeClock();
    await putMessage(t.root, makeMessage({ to: rid, type: 'pause', text: 'pause now', from: { deviceId: DEV_B, label: 'studio', sessionId: null, runId: null, user: 'p' }, expiresAt: iso(T0 + CONTROL_MESSAGE_TTL_MS), stamp: stamp(40, DEV_B, 'abcdefgh') }), T0);
    const run2 = openLedger({ home: t.home, self: makeSelf({ runId: rid, sessionId: rid }), now: clock2.now, monotonicNow: clock2.monotonicNow, scanOnly: true, isPidAlive: () => true });
    await run2.open();
    const delivered = inbox(run2.fold, run2.self, new Set());
    expect(delivered.filter((m) => m.from.deviceId === DEV_B).map((m) => m.type)).toEqual(['pause']);
    await run2.close();
    expect(SEEN_MAX).toBe(2_000);
    expect(serializeRecord({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe('§3.2 / §5.4 rule 5 (revision 5): bootId, pid and the cloned-device suspension', () => {
  const base = { self: { deviceId: DEV_A, bootId: 'boot-mine' }, trusted: new Set([DEV_B]), remoteControl: 'confirm' as const };

  /**
   * ITEM 5 FIXTURE — `bootId` DENIES the no-confirm same-device path.
   *
   * "Same device" is the READ LOCATION, which is necessary but no longer sufficient: a `pause` sitting in my own
   * local subtree written by another BOOT SESSION under one shared `deviceId` is not mine to apply silently, because
   * the machine that wrote it is not this machine (§3.2 `duplicate-identity`).
   *
   * Fails before the fix: `Message.from` has no `bootId` and the local-subtree `pause` applies with no confirm.
   */
  it('a control message from ANOTHER boot in my own subtree needs the local [y]', () => {
    const mine = makeMessage({ type: 'pause', from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p', pid: 4242, bootId: 'boot-mine' }, stamp: stamp(3, DEV_A, runId(1)) });
    expect(classifyIncoming(mine, { ...base, origin: SELF })).toMatchObject({ action: 'pause', needsConfirm: false });
    const otherBoot = makeMessage({ type: 'pause', from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p', pid: 4242, bootId: 'boot-other' }, stamp: stamp(3, DEV_A, runId(1)) });
    expect(classifyIncoming(otherBoot, { ...base, origin: SELF })).toMatchObject({ action: 'pause', needsConfirm: true });
    // an older build wrote no bootId at all: unknown stays permissive, exactly as an unknown hostKey does
    const legacy = makeMessage({ type: 'pause', from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, stamp: stamp(3, DEV_A, runId(1)) });
    expect(classifyIncoming(legacy, { ...base, origin: SELF })).toMatchObject({ action: 'pause', needsConfirm: false });
  });

  it('a CLONED device loses every gated action until it is re-paired', () => {
    const from = { deviceId: DEV_B, label: 'studio', sessionId: runId(9), runId: runId(9), user: 'p', pid: 900, bootId: 'boot-b' };
    const steer = makeMessage({ type: 'steer', from, stamp: stamp(3, DEV_B, runId(9)) });
    // paired and hmac-valid: a steer applies
    expect(classifyIncoming(steer, { ...base, origin: TRUSTED })).toMatchObject({ action: 'steer', downgraded: false });
    // … but two live beats under one deviceId with different bootIds mean one deviceKey on two machines, so that
    // key can no longer speak for either of them (§3.2, §10.3): the steer is a note and a control type asks.
    const cloned = new Set([DEV_B]);
    expect(classifyIncoming(steer, { ...base, origin: TRUSTED, cloned })).toMatchObject({ action: 'note', downgraded: true });
    const pause = makeMessage({ type: 'pause', from, stamp: stamp(4, DEV_B, runId(9)) });
    expect(classifyIncoming(pause, { ...base, origin: TRUSTED, remoteControl: 'allow', cloned })).toMatchObject({ needsConfirm: true });
    expect(classifyIncoming(pause, { ...base, origin: TRUSTED, remoteControl: 'allow' })).toMatchObject({ needsConfirm: false });
  });

  it('`from.pid` travels for display and audit, and is NEVER a liveness input', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const l = openLedger({ home: t.home, self: makeSelf(), now: clock.now, monotonicNow: clock.monotonicNow, scanOnly: true, fs: nodeFs, isPidAlive: () => true, bootId: 'boot-mine', pid: 4242 });
    await l.open();
    const sent = await send(l, { to: runId(9), type: 'note', text: 'hello' });
    const text = (await nodeFs.readBounded(sent.path, 4096)).text;
    const parsed = parseRecord(text, 'message', { deviceId: DEV_A, target: runId(9) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.from.pid).toBe(4242);
    expect(parsed.record.from.bootId).toBe('boot-mine');
    await l.close();
  });
});
