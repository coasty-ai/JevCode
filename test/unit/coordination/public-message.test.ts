/**
 * TUI round-5 request R5-H1 — `publicMessage(m)`, the projection a `--json` sink serialises instead of a `Message`.
 *
 * Two properties, both structural on purpose:
 *   (1) TOTALITY over `MessageType`. The map below is a `Record<MessageType, …>`, so a sixteenth member added to the
 *       union fails `tsc` here before it can reach a sink un-projected — the four contract-1.4 kinds (`budget`,
 *       `review`, `kick`, `land`) and the eleven older ones are all walked.
 *   (2) The KEY SET of the projection, asserted EXACTLY (not "does not contain hostKey"): a future additive member of
 *       `Message` — another `hostKey`-shaped one — cannot ride into the sink by being forgotten here.
 */
import { describe, expect, it } from 'vitest';
import { publicMessage } from '../../../src/coordination/records.js';
import { publicMessage as fromFacade } from '../../../src/coordination/index.js';
import type { Message, MessageType } from '../../../src/coordination/types.js';
import { DEV_A, DEV_B, makeMessage, runId } from './helpers.js';

/** Exhaustive by type: `tsc` fails here when `MessageType` grows a member. */
const EVERY_TYPE: Record<MessageType, true> = {
  'heads-up': true,
  handoff: true,
  note: true,
  'request-release': true,
  steer: true,
  pause: true,
  resume: true,
  end: true,
  abort: true,
  ack: true,
  who: true,
  budget: true,
  review: true,
  kick: true,
  land: true,
};
const TYPES = Object.keys(EVERY_TYPE) as MessageType[];

/** Every member a `Message` can carry, including the ones the projection must drop. */
function fullMessage(type: MessageType, over: Partial<Message> = {}): Message {
  return makeMessage({
    type,
    // a DISTINCTIVE `user`: the leak assertion below is a substring test, and the fixtures' one-letter 'p' matches
    // half the alphabet soup of a serialised record
    from: { deviceId: DEV_B, label: 'studio', sessionId: runId(9), runId: runId(9), user: 'unix-user-xyzzy', pid: 4242, bootId: 'boot-uuid-1234' },
    hostKey: '7e21ab90',
    refs: { commit: 'a'.repeat(40), branch: 'main', files: ['src/a.ts'], leaseId: `${runId(9)}-3`, runId: runId(9), step: 7, msgId: `${DEV_B}-abcdefgh-2`, target: '@all' },
    hmac: 'f'.repeat(64),
    ...over,
  });
}

const KEYS_WITHOUT_BY = ['id', 'from', 'to', 'type', 'text', 'refs', 't'];
const FROM_KEYS = ['deviceId8', 'label', 'sessionId', 'runId'];

describe('R5-H1 publicMessage', () => {
  it('is total over MessageType: every kind projects to exactly the same key set', () => {
    expect(TYPES).toHaveLength(15);
    for (const type of TYPES) {
      const p = publicMessage(fullMessage(type));
      expect(Object.keys(p).sort(), `keys for type ${type}`).toEqual([...KEYS_WITHOUT_BY].sort());
      expect(Object.keys(p.from).sort(), `from keys for type ${type}`).toEqual([...FROM_KEYS].sort());
      expect(p.type).toBe(type);
    }
  });

  it('`by` is the only conditional member, and it appears exactly when the record carries one', () => {
    for (const type of TYPES) {
      const human = publicMessage(fullMessage(type, { by: 'human' }));
      expect(Object.keys(human).sort(), `by:human keys for ${type}`).toEqual([...KEYS_WITHOUT_BY, 'by'].sort());
      expect(human.by).toBe('human');
      const engine = publicMessage(fullMessage(type, { by: 'engine' }));
      expect(engine.by).toBe('engine');
      expect('by' in publicMessage(fullMessage(type))).toBe(false);
    }
  });

  it('drops every device-secret derivative and every wire member, serialised (§7 row 61)', () => {
    for (const type of TYPES) {
      const m = fullMessage(type);
      const json = JSON.stringify(publicMessage(m));
      const secrets = [m.hostKey, String(m.from.pid), m.from.bootId, m.from.user, m.hmac, m.checksum, m.expiresAt];
      for (const leaked of secrets) {
        expect(typeof leaked).toBe('string');
        expect(json, `type ${type} must not carry ${String(leaked)}`).not.toContain(String(leaked));
      }
      expect(json).not.toContain('"kind"');
      expect(json).not.toContain('"stamp"');
      expect(json).not.toContain('"v"');
    }
  });

  it('carries what a reader needs: id, target, text, refs, time and the 8-char device id', () => {
    const m = fullMessage('land', { text: 'branch ready for the landing queue' });
    const p = publicMessage(m);
    expect(p.id).toBe(m.id);
    expect(p.to).toBe(m.to);
    expect(p.text).toBe('branch ready for the landing queue');
    expect(p.t).toBe(m.t);
    expect(p.from.deviceId8).toBe(DEV_B);
    expect(p.from.deviceId8).toHaveLength(8);
    expect(p.from.label).toBe('studio');
    expect(p.refs).toEqual(m.refs);
  });

  it('copies `refs`, so a caller mutating the projection cannot reach back into the record', () => {
    const m = fullMessage('review');
    const p = publicMessage(m);
    expect(p.refs).not.toBe(m.refs);
    expect(p.refs.files).not.toBe(m.refs.files);
    p.refs.branch = 'other';
    p.refs.files!.push('src/leaked.ts');
    expect(m.refs.branch).toBe('main');
    expect(m.refs.files).toEqual(['src/a.ts']);
  });

  it('a null sessionId / runId sender (a `sessions` CLI twin) projects with nulls, not with absent members', () => {
    const m = makeMessage({ type: 'who', from: { deviceId: DEV_A, label: 'mbp', sessionId: null, runId: null, user: 'p' } });
    const p = publicMessage(m);
    expect(Object.keys(p.from).sort()).toEqual([...FROM_KEYS].sort());
    expect(p.from.sessionId).toBeNull();
    expect(p.from.runId).toBeNull();
  });

  it('is reachable from the facade — the only import path outside src/coordination (§12.0.4)', () => {
    expect(fromFacade).toBe(publicMessage);
  });
});
