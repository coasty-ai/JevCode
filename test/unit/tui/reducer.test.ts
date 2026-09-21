/**
 * TUI-DESIGN §19.0 (`useEngine.tsx` row): one test per row of the §15 item 20 transition table (`run:start`
 * resets `done`, …), today's coalescer / item rules kept, the bus replay + §4.8 suspension queue, and the TUI
 * confirmer (`resolve`, `resolveDetailed`, `confirmDetailed`, "a second request declines the first", the signal
 * `onAbort` rejection = the S4 Ctrl-C path).
 */
import { describe, expect, it } from 'vitest';
import { DECISIONS_KEPT, DEFAULT_THRESHOLDS, REVIEW_DEFER_MS, STATIC_SOFT_CAP, createEventBus, createTuiConfirmer, initialUiState, uiReducer, type UiState } from '../../../src/tui/useEngine.js';
import { liveLines } from '../../../src/tui/App.js';
import { statusLineText } from '../../../src/tui/status/lines.js';
import { statusView } from '../../../src/tui/StatusLine.js';
import { AbortError } from '../../../src/errors.js';
import type { EngineEvent, RetryInfo, StepRecord } from '../../../src/core/types.js';
import { loadRunEvents, mkConfirmRequest, mkDecision, mkProposal, mkRunResult, mkStatus } from '../../fixtures/tui/fixtures.js';

const ev = (event: EngineEvent, at = 1000) => ({ type: 'event' as const, event, at });
const T0 = 1_000_000;

function reduceAll(events: readonly EngineEvent[], start = initialUiState('t', null, { nowMs: T0 })): UiState {
  return events.reduce((s, e) => uiReducer(s, ev(e, T0)), start);
}

function started(over: Partial<UiState> = {}): UiState {
  let s = initialUiState('t', null, { mode: 'session', nowMs: T0 });
  s = uiReducer(s, ev({ type: 'run:start', runId: 'r1', task: 't', mode: 'jev-on', resumedFromStep: null }, T0));
  s = uiReducer(s, ev({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 't', resumed: false, sandbox: 'seatbelt', noNetwork: true, maxReplans: 5 }, T0));
  return { ...s, ...over };
}

const retryInfo = (attempt: number, waitMs = 12_000, status = 429): RetryInfo => ({ attempt, maxAttempts: 3, waitMs, retryAfter: true, cause: { kind: 'http', status, code: null, message: 'rate limited' } });

function record(step: number, over: Partial<StepRecord> = {}): StepRecord {
  return {
    step,
    startedAt: 'x',
    intent: 'edit',
    intentAnswer: 'edit',
    contextFiles: [],
    proposal: mkProposal(),
    risk: null,
    outcome: { status: 'executed', summary: 'ok', changedFiles: ['src/a.py'] },
    judge: null,
    completion: null,
    decisions: [],
    jevRequests: [],
    usage: { generator: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, calls: 1 }, jev: { inputTokens: 1, outputTokens: 0, costUsd: 0.001, calls: 1 } },
    timing: { generatorMs: 1, jevMs: 1, execMs: 1, harnessMs: 1, totalMs: 4 },
    loopSignatures: [],
    ...over,
  };
}

describe("uiReducer: today's rules kept", () => {
  it('proposal commits exactly one item and clears the live buffer in the same update', () => {
    let s = initialUiState('task', null);
    s = uiReducer(s, ev({ type: 'generator:start', step: 1, attempt: 1 }));
    s = uiReducer(s, { type: 'live', text: 'line one\nline two' });
    expect(s.live).toBe('line one\nline two');
    const before = s.items.length;
    s = uiReducer(s, ev({ type: 'proposal', step: 1, proposal: mkProposal() }));
    expect(s.items.length).toBe(before + 1);
    expect(s.items[before]?.kind).toBe('proposal');
    expect(s.items[before]?.key).toBe(`1:proposal:${before}`);
    expect(s.live).toBe('');
  });

  it('keeps the last 12 decisions and never edits committed items; rows/byStep follow', () => {
    const decisions = Array.from({ length: 30 }, (_, i) => mkDecision({ id: `d${i}`, step: i }));
    const s = reduceAll(decisions.map((d) => ({ type: 'decision', decision: d }) as EngineEvent));
    expect(s.decisions.length).toBe(DECISIONS_KEPT);
    expect(s.decisions[0]?.id).toBe('d18');
    expect(s.decisions[11]?.id).toBe('d29');
    expect(s.rows.length).toBe(DECISIONS_KEPT);
    expect([...s.byStep.keys()].sort((a, b) => a - b)).toEqual([27, 28, 29]);
    expect([...s.decisionsByStep.keys()].sort((a, b) => a - b)).toEqual([27, 28, 29]);
    expect(s.items.length).toBe(0);
  });

  it('keys are unique and monotonic across the scripted run; pane-only events add no items', () => {
    const s = reduceAll(loadRunEvents());
    const keys = s.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(s.items.map((i) => i.seq)).toEqual(keys.map((_, i) => i));
    const kinds = s.items.map((i) => i.kind);
    expect(kinds).not.toContain('decision');
    expect(kinds).toContain('run:start');
    expect(kinds).toContain('run:end');
    expect(s.done?.stopReason).toBe('max_steps');
    expect(s.runId).toBe('20260919-120000-ab12');
    expect(s.ready).toEqual({ step: 0, maxSteps: 40 });
    expect(s.run).toBe('none');
  });

  it('generator:tool-delta drives `streaming action… N chars` (bucketed) while the text buffer is empty', () => {
    let s = uiReducer(initialUiState('t', null), ev({ type: 'generator:start', step: 1, attempt: 1 }));
    s = uiReducer(s, ev({ type: 'generator:tool-delta', step: 1, chars: 40 }));
    expect(s.toolChars).toBe(40);
    expect(liveLines(s.live, 2, 80, s.toolChars)).toEqual(['streaming action… 40 chars']);
    expect(uiReducer(s, ev({ type: 'generator:tool-delta', step: 1, chars: 40 }))).toBe(s);
    expect(liveLines('x'.repeat(1234), 2, 80)).toEqual(['streaming… 1.2k chars']);
    expect(liveLines('', 2, 80, 12_400)).toEqual(['streaming action… 12.4k chars']);
    expect(liveLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(liveLines('10%\r50%\r90%', 2)).toEqual(['50%', '90%']);
    expect(liveLines(`${'x'.repeat(5000)}\nshort`, 2, 80)).toEqual(['x'.repeat(81), 'short']);
    const committed = uiReducer(s, ev({ type: 'proposal', step: 1, proposal: mkProposal() }));
    expect(committed).toMatchObject({ live: '', toolChars: 0 });
  });

  it('status feeds the status line through statusView; `step 0/–` before any status; the synth marker in jev-only', () => {
    const s = uiReducer(initialUiState('t', null, { mode: 'session' }), ev({ type: 'status', status: mkStatus(3, 'risk') }));
    expect(s.status?.step).toBe(3);
    expect(statusLineText(statusView(initialUiState('t', null)), 80)).toContain('step 0/–');
    const jev = uiReducer(uiReducer(initialUiState('t', null), ev({ type: 'run:start', runId: 'r', task: 't', mode: 'jev-only', resumedFromStep: null })), ev({ type: 'status', status: mkStatus(1, 'propose') }));
    expect(statusLineText(statusView(jev), 80)).toContain('propose [synth]');
  });

  it('synth events: one item each, the last line for the live region, cleared at proposal / outcome / run:end', () => {
    let s = uiReducer(initialUiState('t', null), ev({ type: 'run:start', runId: 'r', task: 't', mode: 'jev-only', resumedFromStep: null }));
    s = uiReducer(s, ev({ type: 'synth', step: 1, phase: 'localise', detail: 'src/a.py:2', candidates: 3 }));
    s = uiReducer(s, ev({ type: 'synth', step: 1, phase: 'select', detail: 'chose return 2', candidates: 3, tested: 1 }));
    expect(s.items.map((i) => i.kind)).toEqual(['run:start', 'synth', 'synth']);
    expect(s.synth).toBe('synth select: chose return 2 (candidates=3, tested=1)');
    expect(s.synthView).toMatchObject({ step: 1, phase: 'select', tested: 1 });
    expect(liveLines(s.live, 2, 80, s.toolChars, s.synth)).toEqual(['synth select: chose return 2 (candidates=3, tested=1)']);
    expect(uiReducer(s, ev({ type: 'proposal', step: 1, proposal: mkProposal() })).synth).toBeNull();
    expect(uiReducer(s, ev({ type: 'outcome', step: 1, outcome: { status: 'noop', summary: 'x' } })).synth).toBeNull();
    expect(uiReducer(s, ev({ type: 'run:end', result: mkRunResult('max_steps') })).synth).toBeNull();
  });
});

describe('uiReducer: the §15 item 20 transition table', () => {
  it('run:start resets the previous run (done, decisions, rows, byStep, ready, status, live, retrying, loop, blocking, review, overlay, paths) and sets run live', () => {
    const first = reduceAll(loadRunEvents(), initialUiState('t', null, { mode: 'session', nowMs: T0 }));
    expect(first.done).not.toBeNull();
    const dirty: UiState = { ...first, retrying: { side: 'jev', attempt: 1, maxAttempts: 3, untilMs: 1, cause: { kind: 'http', status: 429, code: null, message: '' }, lastCause: null }, overlay: 'review', pendingReview: mkConfirmRequest(), paths: { runDir: 'a', transcript: 'b', log: 'c' } };
    const s = uiReducer(dirty, ev({ type: 'run:start', runId: 'r2', task: 'again', mode: 'jev-on', resumedFromStep: null }, T0 + 5));
    expect(s).toMatchObject({ runId: 'r2', mode: 'jev-on', done: null, decisions: [], rows: [], ready: null, status: null, live: '', toolChars: 0, synth: null, retrying: null, loop: null, blocking: null, pendingConfirm: null, pendingReview: null, visibleAt: null, expanded: false, noteMode: false, overlay: 'none', paths: null, stageStartedAt: T0 + 5, run: 'live' });
    expect(s.byStep.size).toBe(0);
  });

  it('run:ready sets runId, ready, run live, sandbox / noNetwork / maxReplans', () => {
    const s = started();
    expect(s.ready).toEqual({ step: 0, maxSteps: 40 });
    expect(s.run).toBe('live');
    expect(s.sandbox).toBe('seatbelt');
    expect(s.noNetwork).toBe(true);
    expect(s.loopFold.maxReplans).toBe(5);
  });

  it('workspace seeds the git zone from e.git; the banner item goes through items; no repo → null', () => {
    const s = uiReducer(started(), ev({ type: 'workspace', git: { repo: true, head: { kind: 'branch', name: 'main', oid: 'a'.repeat(40) }, upstream: 'origin/main', linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 3, staged: 1, untracked: 1 }, ahead: 2, behind: 0 }, instructions: [], sandbox: 'seatbelt' }));
    expect(s.git).toEqual({ head: { kind: 'branch', name: 'main', oid: 'a'.repeat(40) }, ahead: 2, behind: 0, dirty: { modified: 3, staged: 1, untracked: 1 }, linkedWorktree: false, frozen: false });
    expect(s.items.at(-1)?.kind).toBe('workspace');
    expect(uiReducer(started(), ev({ type: 'workspace', git: { repo: false, reason: 'not-a-repo', head: null, upstream: null, linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 0, staged: 0, untracked: 0 } }, instructions: [], sandbox: 'none' })).git).toBeNull();
  });

  it('decision: decisions (last 12), rows / byStep via toDecisionRow with the rows of the last 3 steps kept', () => {
    let s = started();
    for (let step = 1; step <= 5; step++) s = uiReducer(s, ev({ type: 'decision', decision: mkDecision({ step, id: `d${step}` }) }));
    expect([...s.byStep.keys()]).toEqual([3, 4, 5]);
    expect(s.rows.at(-1)).toMatchObject({ step: 5, id: 'd5', kind: 'score', label: 'L1' });
  });

  it('status: status; stageStartedAt when the stage changed; retrying mirrored from status.retrying when present; spend.run', () => {
    let s = uiReducer(started(), ev({ type: 'status', status: mkStatus(1, 'propose') }, T0 + 100));
    expect(s.stageStartedAt).toBe(T0 + 100);
    expect(s.spend.run?.totalUsd).toBeCloseTo(0.13);
    s = uiReducer(s, ev({ type: 'status', status: mkStatus(1, 'propose') }, T0 + 200));
    expect(s.stageStartedAt).toBe(T0 + 100);
    s = uiReducer(s, ev({ type: 'retry', side: 'jev', step: 1, stage: 'propose', info: retryInfo(1) }, T0 + 300));
    s = uiReducer(s, ev({ type: 'status', status: { ...mkStatus(1, 'propose'), retrying: { side: 'jev', attempt: 2, maxAttempts: 3, untilMs: T0 + 9000 } } }, T0 + 400));
    expect(s.retrying).toMatchObject({ attempt: 2, untilMs: T0 + 9000, cause: { status: 429 } });
  });

  it('stage:start / stage:end move stageStartedAt; stage:end folds the timeline', () => {
    let s = uiReducer(started(), ev({ type: 'stage:start', step: 1, stage: 'intent' }, T0 + 10));
    expect(s.stageStartedAt).toBe(T0 + 10);
    s = uiReducer(s, ev({ type: 'stage:end', step: 1, stage: 'intent', ms: 210 }, T0 + 220));
    expect(s.stageStartedAt).toBe(T0 + 220);
    expect(s.timeline[0]).toMatchObject({ step: 1, stages: { intent: 210 } });
  });

  it('generator:start / exec:start / proposal / outcome clear the live region', () => {
    const live = uiReducer(started(), { type: 'live', text: 'abc', toolChars: 3 });
    const events: EngineEvent[] = [
      { type: 'generator:start', step: 1, attempt: 1 },
      { type: 'exec:start', step: 1, action: { kind: 'run', command: 'ls' } },
      { type: 'proposal', step: 1, proposal: mkProposal() },
      { type: 'outcome', step: 1, outcome: { status: 'noop', summary: 'x' } },
    ];
    for (const e of events) expect(uiReducer(live, ev(e))).toMatchObject({ live: '', toolChars: 0, synth: null });
  });

  it('step:end folds the loop banner, the timeline, changedSteps and the step counter; a repeated signature ≥ 2 → banner', () => {
    let s = uiReducer(started(), ev({ type: 'step:end', record: record(1, { loopSignatures: ['run:pytest -q›exit 1'] }) }));
    expect(s.changedSteps).toEqual([1]);
    expect(s.step).toBe(1);
    expect(s.loop).toBeNull();
    s = uiReducer(s, ev({ type: 'step:end', record: record(2, { loopSignatures: ['run:pytest -q›exit 1'] }) }));
    expect(s.loop?.count).toBe(2);
    expect(s.timeline.map((t) => t.step)).toEqual([2, 1]);
  });

  it('plan sets the pane view and clears loop.replan when no replan problem remains; replan sets loop.replan', () => {
    const plan = { done: [], remaining: ['x'], unverified: [], openProblems: [], harnessProblems: [] };
    let s = uiReducer(started(), ev({ type: 'replan', step: 2, directive: { move: 'change_approach', probability: 0.61, confidence: 0.5, taskImpossible: 0.12, text: 'try tz-aware parsing' } }));
    expect(s.loop?.replan).toMatchObject({ n: 1, step: 2, move: 'change_approach' });
    s = uiReducer(s, ev({ type: 'plan', step: 2, plan, rejectedDone: [], unverifiedDone: [] }));
    expect(s.plan).toMatchObject({ step: 2, plan });
    expect(s.loop).toBeNull();
  });

  it('steer:queued / steer:withdrawn push and pop the queue; steer:applied empties it and resets the loop fold', () => {
    let s = uiReducer(started(), ev({ type: 'steer:queued', step: 2, index: 1, text: 'use fromisoformat', queued: 1 }));
    s = uiReducer(s, ev({ type: 'steer:queued', step: 2, index: 2, text: 'also CHANGELOG', queued: 2 }));
    expect(s.queue.map((d) => d.text)).toEqual(['use fromisoformat', 'also CHANGELOG']);
    expect(s.items.at(-1)?.kind).toBe('steer:queued');
    s = uiReducer(s, ev({ type: 'steer:withdrawn', step: 2, index: 2 }));
    expect(s.queue.map((d) => d.index)).toEqual([1]);
    s = uiReducer(s, ev({ type: 'steer:applied', step: 2, count: 1, superseded: [] }));
    expect(s.queue).toEqual([]);
    expect(s.loop).toBeNull();
  });

  it('pause:requested → run pausing', () => {
    expect(uiReducer(started(), ev({ type: 'pause:requested', step: 2 })).run).toBe('pausing');
  });

  it('confirm:request sets pendingConfirm / pendingReview / visibleAt = max(now, lastKeystrokeAt + 1000) and leaves the overlay alone until review:visible', () => {
    const req = mkConfirmRequest('c9', 4);
    const typed = uiReducer(started(), { type: 'key', at: T0 + 500 });
    let s = uiReducer(typed, ev({ type: 'confirm:request', request: req }, T0 + 700));
    expect(s.pendingConfirm?.id).toBe('c9');
    expect(s.pendingReview?.id).toBe('c9');
    expect(s.visibleAt).toBe(T0 + 500 + REVIEW_DEFER_MS);
    expect(s.overlay).toBe('none');
    expect(uiReducer(s, { type: 'confirm:request', request: req })).toBe(s);
    s = uiReducer(s, { type: 'review:visible' });
    expect(s.overlay).toBe('review');
    expect(s.overlayArmed).toBe(false);
    s = uiReducer(s, { type: 'overlay:armed' });
    expect(s.overlayArmed).toBe(true);
    const idle = uiReducer(started(), ev({ type: 'confirm:request', request: req }, T0 + 9000));
    expect(idle.visibleAt).toBe(T0 + 9000);
  });

  it('confirm:resolved / confirm:settled clear the review and its overlay; an unrelated id is ignored; run:end clears it too', () => {
    const req = mkConfirmRequest('c9', 4);
    const s = uiReducer(uiReducer(uiReducer(started(), ev({ type: 'confirm:request', request: req })), { type: 'review:visible' }), { type: 'review:expand', expanded: true });
    expect(uiReducer(s, ev({ type: 'confirm:resolved', step: 4, id: 'other', approved: true, aborted: false })).pendingConfirm?.id).toBe('c9');
    const resolved = uiReducer(s, ev({ type: 'confirm:resolved', step: 4, id: 'c9', approved: true, aborted: false }));
    expect(resolved).toMatchObject({ pendingConfirm: null, pendingReview: null, visibleAt: null, overlay: 'none', expanded: false, noteMode: false });
    expect(uiReducer(s, { type: 'confirm:settled', id: 'c9' }).pendingConfirm).toBeNull();
    expect(uiReducer(s, ev({ type: 'run:end', result: mkRunResult('human_abort') }))).toMatchObject({ pendingConfirm: null, overlay: 'none' });
  });

  it('retry sets the view (untilMs = now + waitMs, lastCause = the previous cause); retry:settled clears it', () => {
    let s = uiReducer(started(), ev({ type: 'retry', side: 'jev', step: 1, stage: 'propose', info: retryInfo(1, 12_000, 429) }, T0));
    expect(s.retrying).toMatchObject({ side: 'jev', attempt: 1, untilMs: T0 + 12_000, lastCause: null, retryAfter: true });
    s = uiReducer(s, ev({ type: 'retry', side: 'jev', step: 1, stage: 'propose', info: retryInfo(2, 8000, 529) }, T0 + 12_000));
    expect(s.retrying?.lastCause?.status).toBe(429);
    expect(s.retrying?.cause.status).toBe(529);
    s = uiReducer(s, ev({ type: 'retry:settled', side: 'jev', step: 1, attempts: 2, ok: true, totalWaitMs: 20_000 }));
    expect(s.retrying).toBeNull();
    expect(s.items.at(-1)?.kind).toBe('retry');
  });

  it('budget:warn / budget:stop / budget:clamp update the session spend and append items', () => {
    let s = uiReducer(started(), ev({ type: 'budget:warn', scope: 'session', pct: 80, spentUsd: 8, capUsd: 10, step: 3, stepsLeftEstimate: null, restored: false }));
    expect(s.spend.session).toEqual({ totalUsd: 8, capUsd: 10 });
    expect(s.items.at(-1)?.kind).toBe('budget');
    s = uiReducer(s, ev({ type: 'budget:clamp', runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10 }));
    expect(s.spend.session).toEqual({ totalUsd: 9.58, capUsd: 10 });
    expect(uiReducer(s, ev({ type: 'budget:warn', scope: 'run', pct: 50, spentUsd: 1, capUsd: 2, step: 3, stepsLeftEstimate: 10, restored: false })).spend.session).toEqual({ totalUsd: 9.58, capUsd: 10 });
  });

  it('blocking:request → blocking + overlay blocking (unarmed); blocking:resolved → cleared; a 401 marks unauthorized', () => {
    const request = { id: 'b1', step: 0, kind: 'key-rejected' as const, side: 'jev' as const, detail: 'HTTP 401', sources: ['env JEV_API_KEY'], stop: 'error' as const, exitCode: 2 };
    let s = uiReducer(started(), ev({ type: 'blocking:request', request }));
    expect(s).toMatchObject({ blocking: request, overlay: 'blocking', overlayArmed: false, unauthorized: true });
    s = uiReducer(s, ev({ type: 'blocking:resolved', id: 'b1', answer: 'retry', auto: false }));
    expect(s).toMatchObject({ blocking: null, overlay: 'none' });
  });

  it('notice checkpoint:degraded → errors + 1 and disk ×N; kind ui carries the label; error (fatal false) → errors + 1', () => {
    let s = uiReducer(started(), ev({ type: 'notice', step: 1, kind: 'checkpoint:degraded', level: 'error', text: 'ENOSPC on state.json' }));
    expect(s.errors).toBe(1);
    expect(s.diskErrors).toBe(1);
    s = uiReducer(s, ev({ type: 'notice', step: 1, kind: 'ui', level: 'info', text: 'help', label: '[ui]' }));
    expect(s.items.at(-1)?.label).toBe('[ui]');
    s = uiReducer(s, ev({ type: 'error', step: 1, error: { name: 'E', code: 'jev_http', message: 'x', exitCode: 5 }, fatal: false }));
    expect(s.errors).toBe(2);
    expect(uiReducer(s, ev({ type: 'error', step: 1, error: { name: 'E', code: 'x', message: 'x', exitCode: 1 }, fatal: true })).errors).toBe(2);
  });

  it('run:end: done, run none, review / live / retrying / blocking / queue cleared, paths kept, exit code carried', () => {
    const s = uiReducer({ ...started(), queue: [{ text: 'x', at: 'y', index: 1 }], live: 'abc' }, ev({ type: 'run:end', result: mkRunResult('complete'), exitCode: 0, resumable: true, paths: { runDir: '/r', transcript: '/r/t', log: '/r/l' } }));
    expect(s).toMatchObject({ run: 'none', live: '', toolChars: 0, synth: null, retrying: null, blocking: null, queue: [], paths: { runDir: '/r', transcript: '/r/t', log: '/r/l' }, doneExitCode: 0, runsEnded: 1 });
    expect(s.done?.stopReason).toBe('complete');
  });

  it('key → lastKeystrokeAt; tick → nowMs and expired toasts dropped', () => {
    let s = uiReducer(initialUiState('t', null, { nowMs: T0 }), { type: 'key', at: T0 + 1 });
    expect(s.lastKeystrokeAt).toBe(T0 + 1);
    s = uiReducer(s, { type: 'toast', text: 'press Ctrl-C again to exit', level: 'info', ms: 2000 });
    expect(s.toasts).toHaveLength(1);
    s = uiReducer(s, { type: 'tick', now: T0 + 3000 });
    expect(s.nowMs).toBe(T0 + 3000);
    expect(s.toasts).toHaveLength(0);
  });

  it('run:starting / run:aborting / run:pausing set the local phases (guarded)', () => {
    const idle = initialUiState('t', null);
    expect(uiReducer(idle, { type: 'run:starting' }).run).toBe('starting');
    expect(uiReducer(idle, { type: 'run:aborting' }).run).toBe('none');
    expect(uiReducer(started(), { type: 'run:aborting' }).run).toBe('aborting');
    expect(uiReducer(started(), { type: 'run:pausing' }).run).toBe('pausing');
  });

  it('toast ≤ 4 with error pre-emption; ack-errors; tab / git / draft / overlay / note / local / picker / title / spend:session set their fields', () => {
    let s = initialUiState('t', null, { nowMs: T0 });
    for (let i = 0; i < 6; i++) s = uiReducer(s, { type: 'toast', text: `t${i}`, level: 'info', ms: 2000 });
    expect(s.toasts.length).toBeLessThanOrEqual(4);
    s = uiReducer(s, { type: 'toast', text: 'boom', level: 'error', ms: 4000 });
    expect(s.toasts.some((t) => t.level === 'error')).toBe(true);
    s = uiReducer({ ...s, errors: 3 }, { type: 'ack-errors' });
    expect(s.errors).toBe(0);
    s = uiReducer(s, { type: 'tab', tab: 'p' });
    expect(s.tab).toBe('p');
    s = uiReducer(s, { type: 'draft', draft: { empty: false, rows: 2, cursorRow: 'last', secretHits: 1 } });
    expect(s.draft.rows).toBe(2);
    s = uiReducer(s, { type: 'overlay', overlay: 'palette' });
    expect(s.overlay).toBe('palette');
    s = uiReducer(s, { type: 'overlay:armed' });
    expect(s.overlayArmed).toBe(true);
    s = uiReducer(s, { type: 'note', on: true });
    expect(s.noteMode).toBe(true);
    s = uiReducer(s, { type: 'local', text: 'recent: "x" · 2 h ago', label: '[ui]' });
    expect(s.items.at(-1)).toMatchObject({ local: true, label: '[ui]', key: 'local:[ui]:0' });
    s = uiReducer(s, { type: 'picker', open: true });
    expect(s.picker).toBe(true);
    s = uiReducer(s, { type: 'title', title: 'tz fixes' });
    expect(s.title).toBe('tz fixes');
    s = uiReducer(s, { type: 'spend:session', session: { totalUsd: 1, capUsd: 10 } });
    expect(s.spend.session).toEqual({ totalUsd: 1, capUsd: 10 });
    s = uiReducer(s, { type: 'git', zone: null });
    expect(s.git).toBeNull();
  });

  it('the <Static> soft cap restarts the array with a new epoch (A28)', () => {
    let s = initialUiState('t', null);
    s = { ...s, items: Array.from({ length: STATIC_SOFT_CAP }, (_, i) => ({ key: `k${i}`, seq: i, step: null, kind: 'transcript' as const, level: 'info' as const, text: 'x' })), seq: STATIC_SOFT_CAP };
    const next = uiReducer(s, ev({ type: 'transcript', step: null, level: 'info', text: 'one more' }));
    expect(next.staticEpoch).toBe(1);
    expect(next.items).toHaveLength(1);
  });
});

describe('createTuiConfirmer', () => {
  it('resolves true/false from resolve(id) and rejects with AbortError on signal (the S4 Ctrl-C path)', async () => {
    const c = createTuiConfirmer();
    expect(c.identity).toBe('reviewer');
    const seen: string[] = [];
    c.onRequest((r) => seen.push(r.id));
    const ac = new AbortController();
    const p1 = c.confirm(mkConfirmRequest('a'), { signal: ac.signal });
    expect(seen).toEqual(['a']);
    expect(c.pending()?.id).toBe('a');
    expect(c.resolve('zzz', true)).toBe(false);
    expect(c.resolve('a', true)).toBe(true);
    await expect(p1).resolves.toBe(true);
    expect(c.pending()).toBeNull();
    const p3 = c.confirm(mkConfirmRequest('c'), { signal: ac.signal });
    ac.abort(new AbortError('human_abort'));
    await expect(p3).rejects.toBeInstanceOf(AbortError);
    await expect(p3).rejects.toMatchObject({ reason: 'human_abort' });
    await expect(c.confirm(mkConfirmRequest('d'), { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
  });

  it('confirmDetailed / resolveDetailed carry a one-line clipped note; confirm() is confirmDetailed().approved', async () => {
    const c = createTuiConfirmer();
    const signal = new AbortController().signal;
    const p = c.confirmDetailed(mkConfirmRequest('a'), { signal });
    expect(c.resolveDetailed('a', { approved: false, note: '  skip the\n tests  ' })).toBe(true);
    await expect(p).resolves.toEqual({ approved: false, note: 'skip the tests' });
    const p2 = c.confirmDetailed(mkConfirmRequest('b'), { signal });
    c.resolveDetailed('b', { approved: false, note: 'x'.repeat(700) });
    const r2 = await p2;
    expect(r2.note?.length).toBe(600);
    const p3 = c.confirmDetailed(mkConfirmRequest('c'), { signal });
    c.resolveDetailed('c', { approved: true });
    await expect(p3).resolves.toEqual({ approved: true });
    const p4 = c.confirm(mkConfirmRequest('d'), { signal });
    c.resolveDetailed('d', { approved: false, note: 'n' });
    await expect(p4).resolves.toBe(false);
  });

  it('auto-declines after the timeout when configured (piped stdin) and never auto-approves', async () => {
    const c = createTuiConfirmer({ autoDeclineMs: 5 });
    await expect(c.confirm(mkConfirmRequest('a'), { signal: new AbortController().signal })).resolves.toBe(false);
  });

  it('a second request while one is pending declines the first', async () => {
    const c = createTuiConfirmer();
    const signal = new AbortController().signal;
    const p1 = c.confirm(mkConfirmRequest('a'), { signal });
    const p2 = c.confirm(mkConfirmRequest('b'), { signal });
    await expect(p1).resolves.toBe(false);
    c.resolve('b', true);
    await expect(p2).resolves.toBe(true);
  });
});

describe('createEventBus', () => {
  it('replays events emitted before the first subscriber, in order', () => {
    const bus = createEventBus();
    bus.emit({ type: 'step:start', step: 1, startedAt: 'x' });
    bus.emit({ type: 'step:start', step: 2, startedAt: 'x' });
    const seen: number[] = [];
    const off = bus.subscribe((e) => {
      if (e.type === 'step:start') seen.push(e.step);
    });
    bus.emit({ type: 'step:start', step: 3, startedAt: 'x' });
    off();
    bus.emit({ type: 'step:start', step: 4, startedAt: 'x' });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('§4.8 suspension: events during a suspension are queued and flushed in order after resume()', () => {
    const bus = createEventBus();
    const seen: number[] = [];
    bus.subscribe((e) => {
      if (e.type === 'step:start') seen.push(e.step);
    });
    bus.suspend();
    expect(bus.suspended).toBe(true);
    bus.emit({ type: 'step:start', step: 1, startedAt: 'x' });
    bus.emit({ type: 'step:start', step: 2, startedAt: 'x' });
    expect(seen).toEqual([]);
    bus.resume();
    expect(seen).toEqual([1, 2]);
    bus.emit({ type: 'step:start', step: 3, startedAt: 'x' });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('uiReducer: the FIX-pass rows (findings 1, 4, 17, 18 and the replaced-request rule)', () => {
  it('run:idle returns a `starting` that never became a run to none (the follow-up box answered n/Esc, a refusal); it never touches a live / aborting / pausing run', () => {
    const s0 = initialUiState('t', null, { mode: 'session', nowMs: T0 });
    const starting = uiReducer(s0, { type: 'run:starting' });
    expect(starting.run).toBe('starting');
    expect(uiReducer(starting, { type: 'run:idle' }).run).toBe('none');
    expect(uiReducer(started(), { type: 'run:idle' }).run).toBe('live');
    expect(uiReducer(started({ run: 'aborting' }), { type: 'run:idle' }).run).toBe('aborting');
    expect(uiReducer(started({ run: 'pausing' }), { type: 'run:idle' }).run).toBe('pausing');
    expect(uiReducer(s0, { type: 'run:idle' })).toBe(s0);
  });

  it('review:visible never replaces an open overlay (exitConfirm, followup, undo, palette, secret, wizard, blocking); it shows once the overlay is none', () => {
    const req = mkConfirmRequest('c1', 3);
    const pending = uiReducer(started(), { type: 'confirm:request', request: req, at: T0 });
    for (const overlay of ['exitConfirm', 'followup', 'undo', 'palette', 'secret', 'wizard', 'blocking'] as const) {
      const withOverlay = uiReducer(pending, { type: 'overlay', overlay });
      const after = uiReducer(withOverlay, { type: 'review:visible' });
      expect(after).toBe(withOverlay);
      expect(after.overlay).toBe(overlay);
      expect(after.pendingReview?.id).toBe('c1');
    }
    const shown = uiReducer(pending, { type: 'review:visible' });
    expect(shown.overlay).toBe('review');
    expect(shown.overlayArmed).toBe(false);
  });

  it('a second confirm:request declines the first: its box, note field and expansion close and the new request defers again', () => {
    const first = mkConfirmRequest('c1', 3);
    let s = uiReducer(started({ lastKeystrokeAt: T0 - 5000 }), { type: 'confirm:request', request: first, at: T0 });
    s = uiReducer(s, { type: 'review:visible' });
    s = uiReducer(s, { type: 'overlay:armed' });
    s = uiReducer(s, { type: 'note', on: true });
    s = uiReducer(s, { type: 'review:expand', expanded: true });
    expect(s).toMatchObject({ overlay: 'review', overlayArmed: true, noteMode: true, expanded: true });
    const second = mkConfirmRequest('c2', 4);
    const t = uiReducer(s, ev({ type: 'confirm:request', request: second }, T0 + 500));
    expect(t.pendingReview?.id).toBe('c2');
    expect(t.pendingConfirm?.id).toBe('c2');
    expect(t).toMatchObject({ overlay: 'none', overlayArmed: false, noteMode: false, expanded: false });
    expect(t.visibleAt).toBe(T0 + 500);
    // the same id again is a no-op
    expect(uiReducer(t, { type: 'confirm:request', request: second, at: T0 + 900 })).toBe(t);
  });

  it('steer:queued carries the engine\'s target step on the entry; queueRows prints it', () => {
    const s = uiReducer(started(), ev({ type: 'steer:queued', step: 9, index: 1, text: 'use fromisoformat', queued: 1 }, T0));
    expect(s.queue).toEqual([{ text: 'use fromisoformat', at: new Date(T0).toISOString(), index: 1, step: 9 }]);
  });

  it('thresholds: the controller\'s resolved values replace the defaults and drive the decision rows\' `!` near-threshold marker', () => {
    const s0 = started();
    expect(s0.thresholds).toEqual(DEFAULT_THRESHOLDS);
    const s = uiReducer(s0, { type: 'thresholds', complete: 0.6, impossible: 0.9 });
    expect(s.thresholds).toEqual({ complete: 0.6, impossible: 0.9 });
    expect(uiReducer(s, { type: 'thresholds', complete: 0.6, impossible: 0.9 })).toBe(s);
    expect(uiReducer(s, { type: 'thresholds', complete: Number.NaN, impossible: 0.5 }).thresholds).toEqual({ complete: 0.6, impossible: 0.5 });
    // a completion probability of 0.62 is near a 0.6 threshold (|p − t| ≤ 0.03) but not near the default 0.85
    const decision = mkDecision({ step: 1, stage: 'complete', id: 'task_complete', question: { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } }, answer: { type: 'noul', noul: 0.62 }, probability: 0.62, confidence: 0.7 });
    const near = uiReducer(s, ev({ type: 'decision', decision }));
    const far = uiReducer(s0, ev({ type: 'decision', decision }));
    expect(near.rows[0]?.near).toEqual({ threshold: 0.6, delta: expect.closeTo(0.02, 5) as number });
    expect(far.rows[0]?.near).toBeNull();
  });
});
