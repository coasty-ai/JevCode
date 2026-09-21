import { describe, expect, it } from 'vitest';
import type { StepRecord } from '../../../../src/core/types.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { bannerRow, describeSignature, emptyLoopFold, foldLoopPlan, foldLoopReplan, foldLoopStep, foldLoopSteer, loopView, shortP } from '../../../../src/tui/pane/banner.js';

const runRecord = (exitCode: number, sig: string): Pick<StepRecord, 'proposal' | 'outcome' | 'loopSignatures'> => ({
  proposal: { goal: 'g', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
  outcome: { status: 'executed', exec: { ok: exitCode === 0, exitCode, signal: null, stdout: '', stderr: '', truncated: false, bytesSeen: 0, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs: 1 }, summary: 's', changedFiles: [] },
  loopSignatures: [sig],
});

/** No lone surrogate: a cut that split an astral character would leave one (the tsconfig lib predates `String.prototype.isWellFormed`). */
const wellFormed = (s: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('bannerRow (TUI-DESIGN §7.3, §24)', () => {
  it('renders the §24 banner exactly', () => {
    expect(bannerRow({ signature: 'run:pytest -q›exit 1', count: 2, max: 3, replan: { n: 1, max: 5, step: 6, move: 'change_approach', p: 0.61, impossible: 0.12 } }, 80)).toBe(
      'loop  run:pytest -q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12',
    );
  });
  it('is absent below a count of 2 without a replan, present with either', () => {
    expect(bannerRow(null, 80)).toBeNull();
    expect(bannerRow({ signature: 'x', count: 1, max: 3, replan: null }, 80)).toBeNull();
    expect(bannerRow({ signature: 'run:x›exit 1', count: 2, max: 3, replan: null }, 80)).toBe('loop  run:x›exit 1  x2/3');
    expect(bannerRow({ signature: '', count: 0, max: 3, replan: { n: 2, max: 5, step: 9, move: 'gather_context', p: 1, impossible: 0 } }, 80)).toBe('loop  replan 2/5 s9 gather_context p 1.00 imp .00');
  });
  it('cuts the command by cells, never splitting a surrogate pair or leaking bidi controls', () => {
    const astral = { ...runRecord(1, 'run:a:b'), proposal: { goal: 'g', action: { kind: 'run' as const, command: `a${'😀'.repeat(20)}` }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } };
    const label = describeSignature('run:a:b', astral);
    expect(wellFormed(label)).toBe(true);
    expect(wellFormed(`a${'😀'.repeat(20)}`.slice(0, 24))).toBe(false);
    expect(label.startsWith('run:a😀')).toBe(true);
    expect(cellWidth(label)).toBeLessThanOrEqual('run:'.length + 24 + '›exit 1'.length);
    expect(label).toContain('…›exit 1');
    const cjk = { ...astral, proposal: { ...astral.proposal, action: { kind: 'run' as const, command: '日本語'.repeat(20) } } };
    expect(wellFormed(describeSignature('run:a:b', cjk))).toBe(true);
    expect(cellWidth(describeSignature('run:a:b', cjk))).toBeLessThanOrEqual(4 + 24 + 7);
    const bidi = { ...astral, proposal: { ...astral.proposal, action: { kind: 'run' as const, command: 'rm \u202e/tmp\u202c -rf\u2028x' } } };
    expect(describeSignature('run:a:b', bidi)).toBe('run:rm /tmp -rf x›exit 1');
    expect(bannerRow({ signature: 'run:\u202exyz\u2069', count: 2, max: 3, replan: null }, 80)).toBe('loop  run:xyz  x2/3');
  });
  it('respects columns and has an ascii twin', () => {
    const v = { signature: 'run:pytest -q›exit 1', count: 2, max: 3, replan: { n: 1, max: 5, step: 6, move: 'change_approach', p: 0.61, impossible: 0.12 } };
    for (const c of [10, 40, 60]) expect(cellWidth(bannerRow(v, c)!)).toBeLessThanOrEqual(c);
    expect(bannerRow(v, 0)).toBeNull();
    expect(shortP(Number.NaN)).toBe('nan');
  });
});

describe('loop fold (§7.3 counts from step:end, reset on replan and steer:applied)', () => {
  it('describes signatures from the record that produced them', () => {
    const r = runRecord(1, 'run:abc:def');
    expect(describeSignature('run:abc:def', r)).toBe('run:pytest -q›exit 1');
    expect(describeSignature('run:abc:def', r, GLYPHS.ascii)).toBe('run:pytest -q>exit 1');
    expect(describeSignature('run:abc:def', null)).toBe('run:abc:def');
    expect(describeSignature('patch:0123456789ab', { proposal: { goal: 'g', action: { kind: 'edit', path: 'src/a.py', old: '', new: '' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }, outcome: null })).toBe('patch:src/a.py');
    expect(describeSignature('read:0123456789ab', { proposal: { goal: 'g', action: { kind: 'read', paths: ['a', 'b'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }, outcome: null })).toBe('read:2 files');
    expect(describeSignature('done:0123456789ab', null)).toBe('done');
    expect(describeSignature('intent:unresolved', null)).toBe('intent:unresolved');
    expect(describeSignature('fail:generator:0123456789ab', null)).toBe('fail:generator');
    expect(describeSignature('fail:0123456789ab', runRecord(2, 'fail:0123456789ab'))).toBe('fail:exit 2');
    expect(describeSignature('run:abc:def', { ...runRecord(1, 'x'), outcome: { status: 'declined', reason: 'r' } })).toBe('run:pytest -q›refused');
  });
  it('counts a repeated signature, shows the banner at 2 and clears on replan / steer', () => {
    let f = emptyLoopFold(5);
    f = foldLoopStep(f, runRecord(1, 'run:a:b'));
    expect(loopView(f)).toBeNull();
    f = foldLoopStep(f, runRecord(1, 'run:a:b'));
    expect(loopView(f)).toEqual({ signature: 'run:pytest -q›exit 1', count: 2, max: 3, replan: null });
    f = foldLoopReplan(f, 6, { move: 'change_approach', probability: 0.61, confidence: 0.4, taskImpossible: 0.12, text: 't' });
    expect(loopView(f)).toEqual({ signature: '', count: 0, max: 3, replan: { n: 1, max: 5, step: 6, move: 'change_approach', p: 0.61, impossible: 0.12 } });
    f = foldLoopStep(f, runRecord(1, 'run:a:b'));
    f = foldLoopStep(f, runRecord(1, 'run:a:b'));
    expect(loopView(f)?.count).toBe(2);
    f = foldLoopSteer(f);
    expect(loopView(f)?.count).toBe(0);
    expect(loopView(f)?.replan?.n).toBe(1);
    f = foldLoopPlan(f, true);
    expect(loopView(f)?.replan).not.toBeNull();
    f = foldLoopPlan(f, false);
    expect(loopView(f)).toBeNull();
  });
  it('a step without signatures leaves the fold untouched; the leading signature is the most repeated', () => {
    let f = emptyLoopFold();
    const same = f;
    f = foldLoopStep(f, { ...runRecord(1, 'x'), loopSignatures: [] });
    expect(f).toBe(same);
    f = foldLoopStep(f, { ...runRecord(1, 'x'), loopSignatures: ['run:a:b', 'fail:c'] });
    f = foldLoopStep(f, { ...runRecord(1, 'x'), loopSignatures: ['fail:c'] });
    f = foldLoopStep(f, { ...runRecord(1, 'x'), loopSignatures: ['fail:c'] });
    expect(loopView(f)).toMatchObject({ signature: 'fail:exit 1', count: 3 });
  });
});
