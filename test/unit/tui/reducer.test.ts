import { describe, expect, it } from 'vitest';
import { DECISIONS_KEPT, createEventBus, createTuiConfirmer, initialUiState, uiReducer, type UiState } from '../../../src/tui/useEngine.js';
import { computeLayout, liveLines } from '../../../src/tui/App.js';
import { formatStatusLine } from '../../../src/tui/StatusLine.js';
import { formatDecisionRow } from '../../../src/tui/Decisions.js';
import { AbortError } from '../../../src/errors.js';
import type { EngineEvent } from '../../../src/core/types.js';
import { loadRunEvents, mkConfirmRequest, mkDecision, mkProposal, mkRunResult, mkStatus } from '../../fixtures/tui/fixtures.js';

const ev = (event: EngineEvent) => ({ type: 'event' as const, event });

function reduceAll(events: readonly EngineEvent[], start = initialUiState('t', null)): UiState {
  return events.reduce((s, e) => uiReducer(s, ev(e)), start);
}

describe('uiReducer', () => {
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

  it('keeps the last 12 decisions and never edits committed items', () => {
    const decisions = Array.from({ length: 30 }, (_, i) => mkDecision({ id: `d${i}`, step: i }));
    const s = reduceAll(decisions.map((d) => ({ type: 'decision', decision: d }) as EngineEvent));
    expect(s.decisions.length).toBe(DECISIONS_KEPT);
    expect(s.decisions[0]?.id).toBe('d18');
    expect(s.decisions[11]?.id).toBe('d29');
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
  });

  it('confirm:request sets pendingConfirm; resolved / settled clear it; run:end clears it', () => {
    const req = mkConfirmRequest('c9', 4);
    let s = uiReducer(initialUiState('t', null), ev({ type: 'confirm:request', request: req }));
    expect(s.pendingConfirm?.id).toBe('c9');
    // the confirmer's own notification with the same id is a no-op
    expect(uiReducer(s, { type: 'confirm:request', request: req })).toBe(s);
    expect(uiReducer(s, ev({ type: 'confirm:resolved', step: 4, id: 'other', approved: true, aborted: false })).pendingConfirm?.id).toBe('c9');
    expect(uiReducer(s, ev({ type: 'confirm:resolved', step: 4, id: 'c9', approved: true, aborted: false })).pendingConfirm).toBeNull();
    expect(uiReducer(s, { type: 'confirm:settled', id: 'c9' }).pendingConfirm).toBeNull();
    s = uiReducer(s, ev({ type: 'run:end', result: mkRunResult('human_abort') }));
    expect(s.pendingConfirm).toBeNull();
  });

  it('generator:tool-delta drives `streaming action… N chars` while the text buffer is empty; proposal and a new call clear it', () => {
    let s = uiReducer(initialUiState('t', null), ev({ type: 'generator:start', step: 1, attempt: 1 }));
    s = uiReducer(s, ev({ type: 'generator:tool-delta', step: 1, chars: 12 }));
    s = uiReducer(s, ev({ type: 'generator:tool-delta', step: 1, chars: 40 }));
    expect(s.toolChars).toBe(40);
    expect(s.items).toHaveLength(0); // pane-only: never a transcript item
    expect(liveLines(s.live, 2, 80, s.toolChars)).toEqual(['streaming action… 40 chars']);
    // an unchanged count is a no-op (no re-render)
    expect(uiReducer(s, ev({ type: 'generator:tool-delta', step: 1, chars: 40 }))).toBe(s);
    // text in the live buffer wins over the tool counter
    const withText = uiReducer(s, { type: 'live', text: 'thinking' });
    expect(withText.toolChars).toBe(40);
    expect(liveLines(withText.live, 2, 80, withText.toolChars)).toEqual(['streaming… 8 chars']);
    // the coalescer's flush carries both values in one dispatch
    const flushed = uiReducer(s, { type: 'live', text: '', toolChars: 55 });
    expect(flushed.toolChars).toBe(55);
    expect(uiReducer(flushed, { type: 'live', text: '', toolChars: 55 })).toBe(flushed);
    const committed = uiReducer(flushed, ev({ type: 'proposal', step: 1, proposal: mkProposal() }));
    expect(committed).toMatchObject({ live: '', toolChars: 0 });
    expect(liveLines(committed.live, 2, 80, committed.toolChars)).toEqual([]);
    expect(uiReducer(flushed, ev({ type: 'generator:start', step: 2, attempt: 1 })).toolChars).toBe(0);
    expect(uiReducer(flushed, ev({ type: 'run:end', result: mkRunResult() })).toolChars).toBe(0);
    expect(liveLines('', 0, 80, 9)).toEqual([]);
  });

  it('status is taken from the status event only', () => {
    const s = uiReducer(initialUiState('t', null), ev({ type: 'status', status: mkStatus(3, 'risk') }));
    expect(s.status?.step).toBe(3);
    expect(formatStatusLine({ status: s.status, ready: null, done: null, spinnerFrame: 0 })).toMatch(/^step 3\/40 {2}. risk {2}wall 1m12s\/30m {2}tokens gen 12\.3k jev 4\.1k {2}cost gen \$0\.120 jev \$0\.010 \/ cap \$2\.000$/);
    expect(formatStatusLine({ status: null, ready: null, done: null, spinnerFrame: 0 })).toContain('step 0/–');
    expect(formatStatusLine({ status: null, ready: { step: 5, maxSteps: 40 }, done: null, spinnerFrame: 0 })).toContain('step 5/40');
  });
});

describe('formatDecisionRow', () => {
  it('labels Noul confidence as derived and shows verdict markers', () => {
    const noul = mkDecision({ stage: 'judge', id: 'succeeded', question: { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } }, answer: { type: 'noul', noul: 0.92 }, probability: 0.92, confidence: 0.84 });
    expect(formatDecisionRow(noul)).toBe('s3 judge succeeded noul=0.92 p=0.92 c=0.84 derived');
    expect(formatDecisionRow(mkDecision({ verdict: 'block' }))).toBe('s3 risk destructive score=1 p=0.80 c=0.83 [block]');
    expect(formatDecisionRow(mkDecision({ verdict: 'overridden', servedModel: 'jev-1.14' }))).toContain('[overridden] served=jev-1.14');
  });
});

describe('computeLayout', () => {
  it('never exceeds rows − 2 and prefers status, rule, live, confirmation, then decisions', () => {
    for (let rows = 0; rows <= 60; rows++) {
      for (const pending of [false, true]) {
        for (const preview of [0, 3, 40]) {
          const l = computeLayout(rows, pending, preview);
          expect(l.total).toBeLessThanOrEqual(Math.max(0, rows - 2));
          expect(l.total).toBe(l.rule + l.live + l.status + l.confirmHeader + l.preview + l.decisions);
          expect(l.decisions).toBeLessThanOrEqual(DECISIONS_KEPT);
          if (!pending) expect(l.confirmHeader + l.preview).toBe(0);
        }
      }
    }
    expect(computeLayout(12, true, 40)).toMatchObject({ budget: 10, status: 1, rule: 1, live: 2, confirmHeader: 6, preview: 0, decisions: 0 });
    expect(computeLayout(24, true, 40)).toMatchObject({ budget: 22, confirmHeader: 6, preview: 8, decisions: 4 });
    expect(computeLayout(24, false, 0)).toMatchObject({ decisions: 12, total: 16 });
  });

  it('liveLines shows a char count without a newline and the last two lines otherwise', () => {
    expect(liveLines('', 2)).toEqual([]);
    expect(liveLines('abc', 2)).toEqual(['streaming… 3 chars']);
    expect(liveLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(liveLines('a\nb\nc', 2)).toEqual(['b', 'c']);
    expect(liveLines('a\nb', 0)).toEqual([]);
    // a progress bar redrawn with \r shows its latest state; lines are cut to columns + 1 before Ink measures them
    expect(liveLines('10%\r50%\r90%', 2)).toEqual(['50%', '90%']);
    expect(liveLines('done\r\n', 2)).toEqual(['done']);
    expect(liveLines(`${'x'.repeat(5000)}\nshort`, 2, 80)).toEqual(['x'.repeat(81), 'short']);
  });
});

describe('createTuiConfirmer', () => {
  it('resolves true/false from resolve(id) and rejects with AbortError on signal', async () => {
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

    const p2 = c.confirm(mkConfirmRequest('b'), { signal: ac.signal });
    c.resolve('b', false);
    await expect(p2).resolves.toBe(false);

    const p3 = c.confirm(mkConfirmRequest('c'), { signal: ac.signal });
    ac.abort(new AbortError('human_abort'));
    await expect(p3).rejects.toBeInstanceOf(AbortError);
    await expect(p3).rejects.toMatchObject({ reason: 'human_abort' });
    await expect(c.confirm(mkConfirmRequest('d'), { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
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
});
