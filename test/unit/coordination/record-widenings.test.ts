/**
 * contract 1.4 (W2b), COORDINATION-DESIGN §3.1 / §5.4 / §12.0.4: the four message types and the one lease type the
 * orchestration wave asked for, and the ONE rule that makes a widening safe here — "TypeScript is the schema for the
 * writer; the reader validates every field itself" (§12.0.4). A union member that `parseRecord`'s bounded list does
 * not also carry is a member the writer can emit and no reader will ever accept, which is worse than not having it.
 *
 * So each half is held to the other: the union is the compile-time twin (`satisfies`), `parseRecord` is the runtime
 * one, and a type that is NOT in the union is still `shape`-rejected — the list is a bound, not a formality.
 */
import { describe, expect, it } from 'vitest';
import { CONTROL_MESSAGE_TYPES, HOLDING_LEASE_TYPES, classifyIncoming, keyDir, parseRecord } from '../../../src/coordination/index.js';
import type { Lease, MessageType, RecordOrigin, SelfIdentity } from '../../../src/coordination/index.js';
import { DEV_A, DEV_B, REPO, makeHeartbeat, makeLease, makeMessage, runId } from './helpers.js';

/** contract 1.4 (W2b): the four facts, named once so both halves below read the same list. */
const NEW_MESSAGE_TYPES = ['budget', 'review', 'kick', 'land'] as const satisfies readonly MessageType[];
const NEW_LEASE_TYPE = 'agent' satisfies Lease['type'];

const leaseCtx = { origin: 'local' as const, deviceId: DEV_A, hostKey: 'abcd1234', keyDir: keyDir(REPO) };
const msgCtx = { origin: 'local' as const, deviceId: DEV_B, hostKey: 'abcd1234', target: runId(1), msgId: `${DEV_B}-abcdefgh-3` };

describe("contract 1.4 (W2b): parseRecord's bounded lists carry every widened member", () => {
  it("Lease['type'] += 'agent' parses, holds, and an invented type is still shape-rejected", () => {
    const r = parseRecord(JSON.stringify(makeLease({ type: NEW_LEASE_TYPE })), 'lease', leaseCtx);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (r.ok) expect(r.record.type).toBe('agent');
    // it HOLDS: a parent's claim on the paths it delegated to a child is a real hold for the child's life, not an intent
    expect(HOLDING_LEASE_TYPES.has('agent')).toBe(true);
    // and the list is a bound, not a formality
    const bogus = parseRecord(JSON.stringify({ ...makeLease(), type: 'supervisor' }), 'lease', leaseCtx);
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.reason).toBe('shape');
  });

  it("MessageType += 'budget' | 'review' | 'kick' | 'land' parses; an invented type is shape-rejected", () => {
    for (const t of NEW_MESSAGE_TYPES) {
      const r = parseRecord(JSON.stringify(makeMessage({ type: t })), 'message', msgCtx);
      expect(r.ok, `${t}: ${r.ok ? '' : r.reason}`).toBe(true);
      if (r.ok) expect(r.record.type).toBe(t);
    }
    const bogus = parseRecord(JSON.stringify({ ...makeMessage(), type: 'shutdown' }), 'message', msgCtx);
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.reason).toBe('shape');
  });

  it("Heartbeat.context speaks ContextUsage's names: budgetTokens + windowTokens, and `windowBudget` is rejected", () => {
    const hbCtx = { origin: 'local' as const, deviceId: DEV_A, hostKey: 'abcd1234' };
    const good = makeHeartbeat();
    const r = parseRecord(JSON.stringify(good), 'heartbeat', hbCtx);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (r.ok) {
      // §12.0.3: `pct` is a share of the BUDGET, and the budget is itself ~55 % of the window — two numbers, so a
      // peer's `sessions who` row can say `ctx 41% · budget 70k of 128k` instead of implying 41 % of the window
      expect(r.record.context.budgetTokens).toBe(70_400);
      expect(r.record.context.windowTokens).toBe(128_000);
    }
    // the old spelling is not an accepted alias: a record that still carries it is `shape`-rejected rather than
    // folded with a silently-zero meter, which is the whole reason there is no alias
    const { budgetTokens: _b, windowTokens: _w, ...rest } = good.context;
    const stale = parseRecord(JSON.stringify({ ...good, context: { ...rest, windowBudget: 70_400 } }), 'heartbeat', hbCtx);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('shape');
  });

  it('none of the four is CONTROL: they can never pause, end, abort or steer a run, and never need a [y]', () => {
    const self: Pick<SelfIdentity, 'deviceId' | 'bootId'> = { deviceId: DEV_A, bootId: 'b1' };
    // the worst case for a fact: read from a MIRROR, from an unpaired device, under the strictest remoteControl
    const origin: RecordOrigin = { self: false, source: '/shared', authenticated: false };
    for (const t of NEW_MESSAGE_TYPES) {
      expect(CONTROL_MESSAGE_TYPES.has(t)).toBe(false);
      const d = classifyIncoming(makeMessage({ type: t }), { self, trusted: new Set(), remoteControl: 'never', origin });
      expect(d.action, t).toBe(t);
      expect(d.needsConfirm, t).toBe(false);
      expect(d.downgraded, t).toBe(false);
      expect(d.refused, t).toBeNull();
      expect(d.authority, t).toBe('unverified');
    }
    // the contrast that makes the claim mean something: a `pause` from the same unpaired mirror is dropped outright
    const control = classifyIncoming(makeMessage({ type: 'pause' }), { self, trusted: new Set(), remoteControl: 'never', origin });
    expect(control.action).toBe('note');
    expect(control.refused).toContain('remote pause disabled');
  });
});
