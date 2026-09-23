/**
 * AGENT-LOOP-DESIGN §A5 (session bookkeeping): a tool-less agent turn is a REPLY — its run stops `answered` (`isReplyOnlyRun`)
 * and it never names the session. The fold takes the title (and the row's `task60`) from the first run that was not a reply; a
 * session of replies only is untitled; the picker's steps / stop come from the newest run that did work; the recent-session
 * placeholder skips an untitled session. Legacy sessions (no `answered` stop exists there) fold exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { foldIndex, type IndexLine } from '../../../src/session/index.js';
import { newestWorkRun, pickerRows } from '../../../src/session/picker-lines.js';
import { mostRecentSession, recentHintSession } from '../../../src/cli/session.js';
import type { StopReason } from '../../../src/core/types.js';
import { runId } from './helpers.js';

const S1 = runId(1);
const S2 = runId(40);
const WS = '/Users/me/proj';
const T = (n: number): string => `2026-09-20T14:${String(n).padStart(2, '0')}:00.000Z`;

function run(o: { sessionId?: string; runId: string; task: string; stop: StopReason | null; at: number; steps?: number; mode?: 'agent' | 'llm-jev' }): IndexLine[] {
  const sessionId = o.sessionId ?? S1;
  const lines: IndexLine[] = [{ v: 1, t: T(o.at), kind: 'run:start', sessionId, runId: o.runId, parentRunId: null, workspace: WS, task60: o.task, mode: o.mode ?? 'agent', source: 'cli', branch: 'main', resumeOf: null }];
  if (o.stop !== null) {
    lines.push({ v: 1, t: T(o.at + 1), kind: 'run:end', sessionId, runId: o.runId, stopReason: o.stop, steps: o.steps ?? 1, costUsd: { generator: 0.001, jev: 0 }, wallMs: 900, changedFiles: 0, exitCode: 0, resumable: false, degraded: false });
  }
  return lines;
}
const J = (ls: IndexLine[]): string[] => ls.map((l) => JSON.stringify(l));

describe('foldIndex: replies never name a session (§A5)', () => {
  it('hi → fix the tests → thanks: the title and task60 are the task, not the greeting', () => {
    const { sessions } = foldIndex(J([...run({ runId: runId(2), task: 'hi', stop: 'answered', at: 1 }), ...run({ runId: runId(3), task: 'fix the failing tests', stop: 'complete', at: 3, steps: 9 }), ...run({ runId: runId(4), task: 'thanks', stop: 'answered', at: 6 })]));
    const s = sessions.get(S1)!;
    expect(s.title).toBe('fix the failing tests');
    expect(s.task60).toBe('fix the failing tests');
    // the run records exist: three runs, the replies among them
    expect(s.runs.map((r) => r.stopReason)).toEqual(['answered', 'complete', 'answered']);
  });

  it('a session of replies only is untitled (title and task60 empty) — its greeting is not its name', () => {
    const { sessions } = foldIndex(J([...run({ runId: runId(2), task: 'hi', stop: 'answered', at: 1 }), ...run({ runId: runId(3), task: 'who made you', stop: 'answered', at: 3 })]));
    const s = sessions.get(S1)!;
    expect(s.title).toBe('');
    expect(s.task60).toBe('');
  });

  it('a live run (no run:end yet) is not known to be a reply and names the session; a rename still wins', () => {
    const live = foldIndex(J([...run({ runId: runId(2), task: 'hi', stop: 'answered', at: 1 }), ...run({ runId: runId(3), task: 'add a --dry-run flag', stop: null, at: 3 })]));
    expect(live.sessions.get(S1)!.title).toBe('add a --dry-run flag');
    const renamed = foldIndex([...J(run({ runId: runId(2), task: 'hi', stop: 'answered', at: 1 })), JSON.stringify({ v: 1, t: T(4), kind: 'rename', sessionId: S1, title60: 'my chat' })]);
    expect(renamed.sessions.get(S1)!.title).toBe('my chat');
    expect(renamed.sessions.get(S1)!.task60).toBe('');
  });

  it('legacy sessions fold as before: the first task60 in index order, whatever the stop', () => {
    const { sessions } = foldIndex(J([...run({ runId: runId(2), task: 'first task', stop: 'human_abort', at: 1, mode: 'llm-jev' }), ...run({ runId: runId(3), task: 'second task', stop: 'complete', at: 3, mode: 'llm-jev' })]));
    expect(sessions.get(S1)!.title).toBe('first task');
    expect(sessions.get(S1)!.task60).toBe('first task');
  });
});

describe('pickerRows / jevcode sessions: a reply is counted as a reply, never as the result (§A5)', () => {
  it('steps and stop come from the newest run that did work; the title is the task', () => {
    const { sessions } = foldIndex(J([...run({ runId: runId(2), task: 'fix the failing tests', stop: 'complete', at: 1, steps: 12 }), ...run({ runId: runId(3), task: 'thanks', stop: 'answered', at: 5, steps: 1 })]));
    const s = sessions.get(S1)!;
    expect(newestWorkRun(s)?.stopReason).toBe('complete');
    const [row] = pickerRows([s], { workspace: WS, widened: false, nowMs: Date.parse(T(10)), columns: 200 });
    expect(row).toContain(' 12 │ complete');
    expect(row).toContain('fix the failing tests');
    expect(row).not.toContain('thanks');
    expect(row).not.toContain('answered');
  });

  it('a session of replies only shows its newest reply as `answered` and its id as the name', () => {
    const { sessions } = foldIndex(J(run({ runId: runId(2), task: 'hi', stop: 'answered', at: 1 })));
    const s = sessions.get(S1)!;
    const [row] = pickerRows([s], { workspace: WS, widened: false, nowMs: Date.parse(T(10)), columns: 200 });
    expect(row).toContain('answered');
    expect(row).toContain(S1);
    expect(row).not.toContain('│ hi');
  });
});

describe('recentHintSession: the placeholder never offers a greeting (§A5)', () => {
  it('skips the newer untitled (replies-only) session and offers the titled one; -c keeps the most recent', () => {
    const { sessions } = foldIndex(J([...run({ sessionId: S2, runId: runId(41), task: 'fix the failing tests', stop: 'complete', at: 1 }), ...run({ runId: runId(2), task: 'hi', stop: 'answered', at: 20 })]));
    const rows = [...sessions.values()];
    expect(mostRecentSession(rows, WS)?.sessionId).toBe(S1);
    expect(recentHintSession(rows, WS)?.sessionId).toBe(S2);
    expect(recentHintSession(rows, WS)?.title).toBe('fix the failing tests');
    expect(recentHintSession(rows.filter((r) => r.sessionId === S1), WS)).toBeNull();
  });
});
