import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../../src/core/types.js';
import { LOOP_TRIP_COUNT, REFUSED_RESULT, computeSignatures, createLoopDetector, directiveMove, loopTripText, signatureKind } from '../../../src/loop/loopdetect.js';
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
  it('a blocked or declined run is signed on the proposal alone (`:refused`, never the reason text); failed/noop keep status+reason; edit/write/patch/read/done shapes', () => {
    const blocked = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm -rf x' }), outcome: { status: 'blocked', reason: 'destructive 0.9' }, output: null });
    const blocked2 = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm -rf x' }), outcome: { status: 'blocked', reason: 'risk 0.80 (block) from plan_mismatch: … dominant level 4 "contradicts the plan…"' }, output: null });
    expect(blocked).toEqual(blocked2);
    // Fix 3: declined vs blocked, and the `matches_intent=` / quoted-level suffixes, no longer split one proposal into several signatures
    const declined = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm  -rf x' }), outcome: { status: 'declined', reason: 'not approved (no reviewer in bench runs): risk 0.43 (review) …; Jev judged the action does not carry out intent `investigate` (matches_intent=0.14)' }, output: null });
    expect(declined).toEqual(blocked);
    expect(blocked[0]).toMatch(new RegExp(`^run:[0-9a-f]{12}:${REFUSED_RESULT}$`));
    // a failed run (stage/sandbox error) still carries status + normalised error; a different command is a different signature
    const failedRun = computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm -rf x' }), outcome: { status: 'failed', error: 'execute: sandbox' }, output: null });
    expect(failedRun[0]).toMatch(/^run:[0-9a-f]{12}:[0-9a-f]{12}$/);
    expect(failedRun[0]).not.toBe(blocked[0]);
    expect(computeSignatures({ ...base, proposal: prop({ kind: 'run', command: 'rm -rf y' }), outcome: { status: 'blocked', reason: 'destructive 0.9' }, output: null })).not.toEqual(blocked);
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
  it('trips at 3, resets only the tripped signature, keeps trip history, and onReplan records directives and increments replanCount', () => {
    const d = createLoopDetector();
    expect(d.observe(1, ['run:a:b'])).toBeNull();
    expect(d.observe(2, ['run:a:b', 'fail:x'])).toBeNull();
    const trip = d.observe(3, ['run:a:b', 'fail:x']);
    expect(trip).toEqual({ signature: 'run:a:b', occurrences: LOOP_TRIP_COUNT });
    expect(d.tripped()).toBe(true);
    expect(d.trippedSignature()).toBe('run:a:b');
    // Fix 3: the untripped fail:x count (2) survives the run:a:b trip
    expect(d.toState().counts).toEqual({ 'fail:x': 2 });
    expect(d.trips('run:a:b')).toBe(1);
    d.onReplan(4, 'change approach');
    expect(d.tripped()).toBe(false);
    expect(d.replanCount()).toBe(1);
    expect(d.toState().counts).toEqual({ 'fail:x': 2 });
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
  it('the first signature in order that reaches 3 is reported when several trip together, and every co-tripped signature resets with it', () => {
    const d = createLoopDetector();
    d.observe(1, ['patch:x', 'fail:y']);
    d.observe(2, ['patch:x', 'fail:y']);
    expect(d.observe(3, ['patch:x', 'fail:y'])?.signature).toBe('patch:x');
    // the fail: of the same failing step reached 3 too: it is answered by the same replan, not a second trip next step
    expect(d.toState().counts).toEqual({});
    d.onReplan(4, 'change approach');
    expect(d.observe(4, ['patch:x', 'fail:y'])).toBeNull();
    expect(d.toState().counts).toEqual({ 'patch:x': 1, 'fail:y': 1 });
  });
  it('Fix 3: a declined-then-blocked identical run is one signature that trips at 3; a done count of 2 survives an interleaved read trip and its replan, then trips on the third done', () => {
    const run = (status: 'blocked' | 'declined', reason: string): string[] => computeSignatures({ ...base, proposal: prop({ kind: 'run', command: "python3 -m pytest -q 'tests/test_account.py'" }), outcome: { status, reason }, output: null });
    const d = createLoopDetector();
    expect(d.observe(3, run('declined', 'not approved (no reviewer in bench runs): risk 0.66 (review) …'))).toBeNull();
    expect(d.observe(4, run('blocked', 'risk 0.95 (block) from plan_mismatch …'))).toBeNull();
    const trip = d.observe(5, run('blocked', 'risk 0.86 (block) from plan_mismatch …; Jev judged the action does not carry out intent `edit` (matches_intent=0.09)'));
    expect(trip).toMatchObject({ occurrences: 3 });
    expect(trip?.signature).toMatch(/^run:[0-9a-f]{12}:refused$/);
    d.onReplan(6, 'After repeating the same run command with the same result 3 times, Jev directs `gather_context` (p=0.52, task_impossible=0.12): …');
    // account steps 9/12/15 of the ladder-4 run: the done count used to be wiped by the read trip at 10 and the replan at 11
    const done = (): string[] => computeSignatures({ ...base, proposal: prop({ kind: 'done', summary: 'partial: fixed 0 of 3 failing tests' }), outcome: { status: 'blocked', reason: 'risk 0.80 (block) …' }, output: null });
    const read = (): string[] => computeSignatures({ ...base, proposal: prop({ kind: 'read', paths: ['src/account.py'] }), outcome: { status: 'declined', reason: 'not approved …' }, output: null });
    expect(d.observe(7, done())).toBeNull();
    expect(d.observe(8, read())).toBeNull();
    expect(d.observe(9, read())).toBeNull();
    expect(d.observe(10, done())).toBeNull();
    const readTrip = d.observe(11, read());
    expect(readTrip?.signature).toMatch(/^read:/);
    expect(d.toState().counts[done()[0]!]).toBe(2);
    d.onReplan(12, 'After repeating the same read of the same files 3 times, Jev directs `gather_context` (p=0.81, task_impossible=0.09): …');
    expect(d.toState().counts[done()[0]!]).toBe(2);
    expect(d.toState().counts[read()[0]!]).toBeUndefined();
    const doneTrip = d.observe(12, done());
    expect(doneTrip).toEqual({ signature: done()[0], occurrences: 3 });
    expect(d.priorDirectives(done()[0]!)).toEqual([]);
    expect(d.priorDirectives(read()[0]!).map((x) => directiveMove(x.directive))).toEqual(['gather_context']);
  });
  it('directiveMove reads the move out of the stored directive text; the fallback wording has none', () => {
    expect(directiveMove('After repeating the same done proposal 3 times, Jev directs `stop_and_report` (p=0.45, task_impossible=0.10): stop the run and report; further steps would waste budget.')).toBe('stop_and_report');
    expect(directiveMove('Jev found no listed recovery applicable after repeating the same done proposal 3 times (p=0.13, task_impossible=0.13); propose a different action from anything shown in recent steps.')).toBeNull();
    expect(directiveMove('change approach')).toBeNull();
  });
  it('loopTripText names the kind', () => {
    expect(loopTripText('patch:abc')).toBe('You have repeated the same edit 3 times. Change approach, or reply with a done action explaining why the task cannot be completed.');
    expect(loopTripText('run:a:b')).toMatch(/same run command with the same result 3 times/);
    expect(loopTripText('fail:generator:x')).toMatch(/malformed reply/);
  });
});
