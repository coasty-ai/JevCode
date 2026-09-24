/**
 * TUI-DESIGN-5 §4.7 / §7 row 48 (R5-4's §10 `agents-caps`): caps are checked against the **live fold**, never a
 * persisted counter — so a resumed or adopted child counts against `orchestrate.maxAgents` and a resume can never
 * silently take a free slot. The rule is written down now so the eventual `AgentSupervisor` cannot get it wrong.
 *
 * The fold is the REAL one (`foldOf` over records, then `listSessions(fold, self)`), because that is what the
 * supervisor will call — a hand-made shape here would prove nothing about the rule. `liveChildCount` itself takes a
 * structural parameter so `src/tui/agents/lines.ts` keeps its zero runtime imports outside `src/tui/` (G-R5-1).
 */
import { describe, expect, it } from 'vitest';
import { listSessions } from '../../../../src/coordination/fold.js';
import { agentCapVerdict, liveChildCount } from '../../../../src/tui/agents/lines.js';
import { DEV_A, SELF, claim, entry, foldOf, makeHeartbeat, makeSelf, runId, stamp } from '../../coordination/helpers.js';

const PARENT = runId(1);
const self = makeSelf();

/** one child heartbeat of `PARENT`, under its own run id (a resume gives it a NEW one — that is the point). */
function child(n: number, parentRunId: string | null = PARENT) {
  const rid = runId(n);
  return entry(makeHeartbeat({ runId: rid, sessionId: rid, pid: 5000 + n, stamp: stamp(n, DEV_A, rid), claim: claim({ runId: rid, pid: 5000 + n }), parentRunId }), SELF);
}

describe('§7 row 48: a resumed or adopted child counts against maxAgents via the fold', () => {
  it('a child that RESUMED under a NEW run id still occupies its slot (a counter would have freed it)', () => {
    const rows = listSessions(foldOf([child(2), child(3), child(4, null)]), self, { all: true });
    expect(liveChildCount(rows, PARENT)).toBe(2);
    expect(agentCapVerdict(rows, PARENT, 3)).toEqual({ ok: true, live: 2, remaining: 1 });
  });

  it('at the cap the next start is refused, and `remaining` is never negative when the fold is over-subscribed', () => {
    const rows = listSessions(foldOf([child(2), child(3), child(5)]), self, { all: true });
    expect(agentCapVerdict(rows, PARENT, 3)).toEqual({ ok: false, live: 3, remaining: 0 });
    expect(agentCapVerdict(rows, PARENT, 2)).toEqual({ ok: false, live: 3, remaining: 0 });
  });

  it("a child of ANOTHER parent never takes this parent's slot", () => {
    const rows = listSessions(foldOf([child(2, runId(9))]), self, { all: true });
    expect(liveChildCount(rows, PARENT)).toBe(0);
  });

  it('only `live` counts — a stale, gone or unknown child has released its slot', () => {
    const rows = [
      { liveness: 'live', heartbeat: { parentRunId: PARENT } },
      { liveness: 'stale', heartbeat: { parentRunId: PARENT } },
      { liveness: 'gone', heartbeat: { parentRunId: PARENT } },
      { liveness: 'stale-reused-pid', heartbeat: { parentRunId: PARENT } },
      { liveness: 'unknown', heartbeat: { parentRunId: PARENT } },
    ];
    expect(liveChildCount(rows, PARENT)).toBe(1);
  });

  it('a cap of 0 or a NaN cap refuses rather than admitting', () => {
    const rows = [{ liveness: 'live', heartbeat: { parentRunId: PARENT } }];
    expect(agentCapVerdict(rows, PARENT, 0).ok).toBe(false);
    expect(agentCapVerdict(rows, PARENT, Number.NaN).ok).toBe(false);
  });
});
