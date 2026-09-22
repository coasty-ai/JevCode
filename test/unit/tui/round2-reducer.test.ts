/**
 * TUI-DESIGN-2 §6 items 15–16 / §8.1 S4 (`reducer.test.ts` ext.): `mode` (idle `/mode jev-on` → badge `jev+llm · next run`,
 * `run:start` → `jev+llm`), `thinking`, `chat-decisions`, `panel`, `transcript`, `turn`/`turns`; every splash cancel row flips
 * `splash` once (a key, run:start, confirm:request, an overlay change, blocking:request, `splash:done`); the compact filter
 * stamps `hidden` at append time and `/transcript full` shows new items only; `lastRisk` follows the risk event.
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { DEFAULT_MODE } from '../../../src/config/defaults.js';
import { modeBadge } from '../../../src/tui/status/lines.js';
import { mkRunResult } from '../../fixtures/tui/fixtures.js';
import { COMPACT_HIDDEN_KINDS, hiddenInCompact, initialUiState, uiReducer, visibleItems, type UiState } from '../../../src/tui/useEngine.js';
import { loadRunEvents, mkConfirmRequest, mkDecision, mkProposal } from '../../fixtures/tui/fixtures.js';

const ev = (event: EngineEvent, at = 1000) => ({ type: 'event' as const, event, at });
const start: EngineEvent = { type: 'run:start', runId: 'r1', task: 't', mode: 'jev-on', resumedFromStep: null };

function fresh(over: Parameters<typeof initialUiState>[2] = {}): UiState {
  return initialUiState('', null, { mode: 'session', nowMs: 5000, ...over });
}

describe('UiState round 2 (TUI-DESIGN-2 §6 item 16)', () => {
  it('starts with the badge from the mode hint (default DEFAULT_MODE, TUI-DESIGN-3 §1.1), no thinking, the splash `done` unless asked, the panel collapsed, compact, zero turns', () => {
    const s = fresh();
    expect(s.modeBadge).toEqual({ mode: DEFAULT_MODE, pending: null });
    expect(fresh({ modeHint: 'jev-on' }).modeBadge).toEqual({ mode: 'jev-on', pending: null });
    expect(fresh({ modeHint: 'jev-only' }).modeBadge).toEqual({ mode: 'jev-only', pending: null });
    expect(s.thinking).toBeNull();
    expect(s.chatRows).toEqual([]);
    expect(s.splash).toBe('done');
    expect(fresh({ splash: 'running' }).splash).toBe('running');
    expect(s.mountedAt).toBe(5000);
    expect(s.panel).toBe('collapsed');
    expect(s.transcript).toBe('compact');
    expect(s.turns).toBe(0);
    expect(s.lastRisk).toBeNull();
  });
  it('mode: idle `/mode jev-on` → `jev+llm · next run`; run:start promotes the pending mode and clears it', () => {
    let s = uiReducer(fresh(), { type: 'mode', mode: 'jev-only', pending: 'jev-on' });
    expect(s.modeBadge).toEqual({ mode: 'jev-only', pending: 'jev-on' });
    expect(modeBadge(s.modeBadge.mode, s.modeBadge.pending)).toBe('jev+llm · next run');
    s = uiReducer(s, ev(start));
    expect(s.modeBadge).toEqual({ mode: 'jev-on', pending: null });
    expect(modeBadge(s.modeBadge.mode, s.modeBadge.pending)).toBe('jev+llm');
    expect(uiReducer(s, { type: 'mode', mode: 'jev-on', pending: null })).toBe(s); // unchanged → same object
  });
  it('thinking, chat-decisions, panel, transcript, turn', () => {
    let s = uiReducer(fresh(), { type: 'thinking', phase: 'intake' });
    expect(s.thinking).toBe('intake');
    s = uiReducer(s, { type: 'thinking', phase: null });
    expect(s.thinking).toBeNull();
    const rows = [{ step: 0, stage: 'intent' as const, id: 'intake', kind: 'choice' as const, label: 'coding_task', p: 0.78, c: 0.72, cDerived: false, verdict: 'chosen' as const, latencyMs: 118, requestHash: 'h', consumedBy: 'resolveChoice → run floor 0.60 → coding_task', near: null, text: '' }];
    s = uiReducer(s, { type: 'chat-decisions', rows });
    expect(s.chatRows).toEqual(rows);
    s = uiReducer(s, { type: 'panel', panel: 'open' });
    expect(s.panel).toBe('open');
    expect(uiReducer(s, { type: 'panel', panel: 'open' })).toBe(s);
    s = uiReducer(s, { type: 'transcript', view: 'full' });
    expect(s.transcript).toBe('full');
    s = uiReducer(s, { type: 'turn' });
    expect(s.turns).toBe(1);
    s = uiReducer(s, ev(start));
    expect(s.turns).toBe(2); // a run is a turn too
    expect(s.panel).toBe('collapsed'); // run:start collapses the panel (§4.6)
    expect(s.chatRows).toEqual(rows); // the intakes survive a run
  });
  it('every splash cancel row flips `splash` once: a key, run:start, confirm:request, an overlay change, blocking:request, splash:done', () => {
    const running = fresh({ splash: 'running' });
    expect(uiReducer(running, { type: 'key', at: 5100 }).splash).toBe('done');
    expect(uiReducer(running, ev(start)).splash).toBe('done');
    expect(uiReducer(running, { type: 'confirm:request', request: mkConfirmRequest(), at: 5100 }).splash).toBe('done');
    expect(uiReducer(running, ev({ type: 'confirm:request', request: mkConfirmRequest() })).splash).toBe('done');
    expect(uiReducer(running, { type: 'overlay', overlay: 'palette' }).splash).toBe('done');
    expect(uiReducer(running, ev({ type: 'blocking:request', request: { id: 'b', step: 0, kind: 'key-rejected', detail: 'x', stop: 'error', exitCode: 2 } })).splash).toBe('done');
    expect(uiReducer(running, { type: 'splash:done' }).splash).toBe('done');
    // the 1 Hz tick never ends the splash (§5.2 row 14: the settle effect does); a repeated splash:done is a no-op
    expect(uiReducer(running, { type: 'tick', now: 9000 }).splash).toBe('running');
    const done = uiReducer(running, { type: 'splash:done' });
    expect(uiReducer(done, { type: 'splash:done' })).toBe(done);
    // an item append never ends it either (the first frame's header and `[config]` items arrive while it runs)
    expect(uiReducer(running, { type: 'local', text: 'decider: typesafe', label: '[config]' }).splash).toBe('running');
  });
  it('compact stamps the stage kinds hidden at append time; `full` shows new items only (R4); visibleItems is the declared subsequence', () => {
    let s = fresh();
    for (const e of loadRunEvents()) s = uiReducer(s, ev(e));
    const kinds = new Set<string>(s.items.map((i) => i.kind));
    for (const k of COMPACT_HIDDEN_KINDS) if (kinds.has(k)) expect(s.items.filter((i) => (i.kind as string) === k).every((i) => i.hidden === true), k).toBe(true);
    for (const i of s.items) if (!hiddenInCompact(i.kind)) expect(i.hidden).toBeUndefined();
    const visible = visibleItems(s.items);
    expect(visible.length).toBeLessThan(s.items.length);
    expect(visible.every((i) => !hiddenInCompact(i.kind))).toBe(true);
    expect(visible.map((i) => i.key)).toEqual(s.items.filter((i) => !hiddenInCompact(i.kind)).map((i) => i.key));
    expect(visible.some((i) => i.kind === 'run:start')).toBe(true);
    expect(visible.some((i) => i.kind === 'run:end')).toBe(true);
    expect(visible.some((i) => i.kind === 'run:ready')).toBe(false);
    // `/transcript full`: an item appended afterwards is shown, the earlier stamps stay
    const before = s.items.length;
    s = uiReducer(s, { type: 'transcript', view: 'full' });
    s = uiReducer(s, ev({ type: 'proposal', step: 9, proposal: mkProposal() }));
    expect(s.items.length).toBe(before + 1);
    expect(s.items.at(-1)?.hidden).toBeUndefined();
    expect(s.items.find((i) => i.kind === 'proposal' && i.step !== 9)?.hidden).toBe(true);
    expect(COMPACT_HIDDEN_KINDS.has('step')).toBe(false);
    expect(COMPACT_HIDDEN_KINDS.has('chat')).toBe(false);
    expect(COMPACT_HIDDEN_KINDS.has('ui')).toBe(false);
  });
  it('risk → lastRisk (the strip segment); run:start clears it; decisions still fold as before', () => {
    let s = uiReducer(fresh(), ev(start));
    expect(s.lastRisk).toBeNull();
    s = uiReducer(s, ev({ type: 'risk', step: 3, risk: { dims: {}, risk: 0.44, verdict: 'review', reason: 'x' } as never }));
    expect(s.lastRisk).toEqual({ risk: 0.44, verdict: 'review' });
    s = uiReducer(s, ev({ type: 'decision', decision: mkDecision({ step: 3 }) }));
    expect(s.rows).toHaveLength(1);
    s = uiReducer(s, ev({ ...start, runId: 'r2' }));
    expect(s.lastRisk).toBeNull();
  });
});

describe('TUI-DESIGN-3 §6 item 8: lastActivityAt, postRunKeySeen, the run:end banner clear (§3.6, §3.2, §5.1 rule 12)', () => {
  const end: EngineEvent = { type: 'run:end', result: mkRunResult('complete'), exitCode: 0 };
  it('lastActivityAt starts at the mount clock and is set by key, run:end, panel and resize — never by a reply (thinking → null / chat-decisions) or a tick', () => {
    const s0 = fresh();
    expect(s0.lastActivityAt).toBe(5000);
    expect(uiReducer(s0, { type: 'key', at: 5100 }).lastActivityAt).toBe(5100);
    let s = uiReducer(s0, ev(start, 6000));
    s = uiReducer(s, { type: 'tick', now: 7000 });
    expect(s.lastActivityAt).toBe(5000); // run:start and the tick do not count
    expect(uiReducer(s, ev(end, 8000)).lastActivityAt).toBe(8000);
    expect(uiReducer(s, { type: 'panel', panel: 'open' }).lastActivityAt).toBe(7000); // the tick's clock
    expect(uiReducer(s, { type: 'panel', panel: 'collapsed' })).toBe(s); // unchanged panel → same object
    expect(uiReducer(s, { type: 'resize' }).lastActivityAt).toBe(7000);
    // a reply calms: neither the phase clearing nor the intake rows move the clock
    let r = uiReducer(uiReducer(s, { type: 'thinking', phase: 'intake' }), { type: 'tick', now: 9000 });
    r = uiReducer(r, { type: 'thinking', phase: null });
    expect(r.lastActivityAt).toBe(5000);
    r = uiReducer(r, { type: 'chat-decisions', rows: [] });
    expect(r.lastActivityAt).toBe(5000);
  });
  it('postRunKeySeen: true at mount, false at run:end, true at the next key', () => {
    const s0 = fresh();
    expect(s0.postRunKeySeen).toBe(true);
    const live = uiReducer(s0, ev(start));
    expect(live.postRunKeySeen).toBe(true);
    const ended = uiReducer(live, ev(end, 8000));
    expect(ended.postRunKeySeen).toBe(false);
    expect(uiReducer(ended, { type: 'tick', now: 9000 }).postRunKeySeen).toBe(false);
    expect(uiReducer(ended, { type: 'panel', panel: 'open' }).postRunKeySeen).toBe(false);
    expect(uiReducer(ended, { type: 'key', at: 9000 }).postRunKeySeen).toBe(true);
  });
  it('run:end clears the loop banner and its fold (R5 F8) and keeps maxReplans; run:idle clears the App-set thinking phase (P7)', () => {
    let s = uiReducer(fresh(), ev(start));
    s = uiReducer(s, ev({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 't', resumed: false, maxReplans: 7 }));
    s = uiReducer(s, ev({ type: 'replan', step: 3, directive: { move: 'change_approach', probability: 0.61, confidence: 0.4, taskImpossible: 0.12, text: 't' } }));
    expect(s.loop).not.toBeNull();
    expect(s.loopFold.replans).toBe(1);
    const ended = uiReducer(s, ev(end));
    expect(ended.loop).toBeNull();
    expect(ended.loopFold.replans).toBe(0);
    expect(ended.loopFold.replan).toBeNull();
    expect(ended.loopFold.maxReplans).toBe(7);
    const thinking = uiReducer(uiReducer(fresh(), { type: 'run:starting' }), { type: 'thinking', phase: 'intake' });
    expect(thinking.thinking).toBe('intake');
    const idle = uiReducer(thinking, { type: 'run:idle' });
    expect(idle.run).toBe('none');
    expect(idle.thinking).toBeNull();
  });
});

describe('keySeq (TUI-DESIGN-2 §9 D-F: key frames take Ink\'s immediate render path)', () => {
  it('starts at 0 and advances on every key action — two keys in the same millisecond included — while lastKeystrokeAt follows the clock', () => {
    const s0 = fresh();
    expect(s0.keySeq).toBe(0);
    const s1 = uiReducer(s0, { type: 'key', at: 5100 });
    const s2 = uiReducer(s1, { type: 'key', at: 5100 });
    const s3 = uiReducer(s2, { type: 'key', at: 5400 });
    expect([s1.keySeq, s2.keySeq, s3.keySeq]).toEqual([1, 2, 3]);
    expect(s2).not.toBe(s1);
    expect(s3.lastKeystrokeAt).toBe(5400);
    // nothing else moves it
    expect(uiReducer(s3, { type: 'tick', now: 6400 }).keySeq).toBe(3);
    expect(uiReducer(s3, ev(start)).keySeq).toBe(3);
  });
});
