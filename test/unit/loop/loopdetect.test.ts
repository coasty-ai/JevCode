import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../../src/core/types.js';
import { LOOP_TRIP_COUNT, computeSignatures, createLoopDetector, loopTripText, signatureKind } from '../../../src/loop/loopdetect.js';
import { execResult } from './fakes.js';

function prop(action: Proposal['action']): Proposal {
  return { goal: 'g', action, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
}
const base = { intentFallback: false, generatorFailReason: null, errorClass: null, observed: true, workspaceRoot: '/ws' };

describe('signatures (§6)', () => {
  it('run signature keys on normalised command and result; digits, hashes, durations and the workspace path are stripped', () => {
    const a = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'pytest -q' }), outcome: { status: 'executed', exec: execResult({ exitCode: 1 }), summary: '', changedFiles: [] }, output: 'FAILED test_a in 0.12s at /ws/x.py:12 abc1234def' });
    const b = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'pytest  -q' }), outcome: { status: 'executed', exec: execResult({ exitCode: 1 }), summary: '', changedFiles: [] }, output: 'FAILED test_a in 3.9s at /ws/x.py:99 fedcba9876' });
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatch(/^run:[0-9a-f]{12}:[0-9a-f]{12}$/);
    expect(a[1]).toMatch(/^fail:[0-9a-f]{12}$/);
    const c = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'pytest -q' }), outcome: { status: 'executed', exec: execResult({ exitCode: 0 }), summary: '', changedFiles: [] }, output: 'ok' });
    expect(c).toHaveLength(1);
    expect(c[0]).not.toBe(a[0]);
  });
  it('blocked/declined/failed/noop runs carry the status and reason in the result; edit/write/patch/read/done shapes', () => {
    const blocked = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm -rf x' }), outcome: { status: 'blocked', reason: 'destructive 0.9' }, output: null });
    const blocked2 = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm -rf x' }), outcome: { status: 'blocked', reason: 'destructive 0.8' }, output: null });
    expect(blocked).toEqual(blocked2);
    expect(computeSignatures({ ...base, proposal: prop({ kind: 'edit', path: 'a', old: 'x', new: 'y' }), outcome: { status: 'executed', summary: '', changedFiles: ['a'] }, output: null })[0]).toMatch(/^patch:/);
    expect(computeSignatures({ ...base, proposal: prop({ kind: 'read', paths: ['b', 'a'] }), outcome: { status: 'executed', summary: '', changedFiles: [] }, output: 'x' })).toEqual(computeSignatures({ ...base, proposal: prop({ kind: 'read', paths: ['a', 'b'] }), outcome: { status: 'executed', summary: '', changedFiles: [] }, output: 'y' }));
    expect(computeSignatures({ ...base, proposal: prop({ kind: 'done', summary: 'done at 12:00' }), outcome: { status: 'noop', summary: 's' }, output: null })[0]).toMatch(/^done:/);
    const failed = computeSignatures({ ...base, proposal: prop({ kind: 'edit', path: 'a', old: 'x', new: 'y' }), outcome: { status: 'failed', error: 'EditError: no match in a' }, output: null, errorClass: 'EditError' });
    expect(failed.map(signatureKind)).toEqual(['patch', 'fail']);
  });
  it('intent fallback, generator failure, and non-observed steps', () => {
    expect(computeSignatures({ ...base, proposal: null, outcome: null, output: null, intentFallback: true })).toEqual(['intent:unresolved']);
    expect(computeSignatures({ ...base, proposal: null, outcome: { status: 'failed', error: 'propose: generator_response' }, output: null, generatorFailReason: 'no tool call 1', errorClass: 'GeneratorResponseError' }).map(signatureKind)).toEqual(['fail:generator', 'fail']);
    expect(computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'x' }), outcome: { status: 'interrupted' }, output: null })).toEqual([]);
    expect(computeSignatures({ ...base, observed: false, proposal: prop({ kind: 'run', command: 'x' }), outcome: { status: 'executed', summary: '', changedFiles: [] }, output: '' })).toEqual([]);
  });
});

describe('detector', () => {
  it('trips at 3, resets counts, keeps trip history, and onReplan records directives and increments replanCount', () => {
    const d = createLoopDetector();
    expect(d.observe(1, ['run:a:b'])).toBeNull();
    expect(d.observe(2, ['run:a:b', 'fail:x'])).toBeNull();
    const trip = d.observe(3, ['run:a:b', 'fail:x']);
    expect(trip).toEqual({ signature: 'run:a:b', occurrences: LOOP_TRIP_COUNT });
    expect(d.tripped()).toBe(true);
    expect(d.trippedSignature()).toBe('run:a:b');
    expect(d.toState().counts).toEqual({});
    expect(d.trips('run:a:b')).toBe(1);
    d.onReplan(4, 'change approach');
    expect(d.tripped()).toBe(false);
    expect(d.replanCount()).toBe(1);
    expect(d.priorDirectives('run:a:b')).toEqual([{ step: 4, directive: 'change approach' }]);
    // a second trip of the same signature carries the history
    d.observe(4, ['run:a:b']);
    d.observe(5, ['run:a:b']);
    expect(d.observe(6, ['run:a:b'])).not.toBeNull();
    expect(d.trips('run:a:b')).toBe(2);
    // round-trips through state
    const copy = createLoopDetector(d.toState());
    expect(copy.toState()).toEqual(d.toState());
    expect(copy.tripped()).toBe(true);
  });
  it('the first signature in order that reaches 3 is reported when several trip together', () => {
    const d = createLoopDetector();
    d.observe(1, ['patch:x', 'fail:y']);
    d.observe(2, ['patch:x', 'fail:y']);
    expect(d.observe(3, ['patch:x', 'fail:y'])?.signature).toBe('patch:x');
  });
  it('loopTripText names the kind', () => {
    expect(loopTripText('patch:abc')).toBe('You have repeated the same edit 3 times. Change approach, or reply with a done action explaining why the task cannot be completed.');
    expect(loopTripText('run:a:b')).toMatch(/same run command with the same result 3 times/);
    expect(loopTripText('fail:generator:x')).toMatch(/malformed reply/);
  });
});
