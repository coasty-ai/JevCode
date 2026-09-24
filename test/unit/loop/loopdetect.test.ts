import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../../src/core/types.js';
import { LOOP_TRIP_COUNT, REFUSED_RESULT, computeSignatures, createLoopDetector, directiveMove, failingTestIds, loopTripText, signatureKind, testFailureIdentity } from '../../../src/loop/loopdetect.js';
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

describe('resetCounts (TUI-DESIGN §8.6: a human directive restarts the repetition count)', () => {
  it('clears counts, the trip and lastSignature; keeps the trips history and replanCount', () => {
    const d = createLoopDetector();
    d.observe(1, ['run:a:b']);
    d.observe(2, ['run:a:b']);
    expect(d.observe(3, ['run:a:b'])).toEqual({ signature: 'run:a:b', occurrences: 3 });
    d.onReplan(4, 'Jev directs `change_approach`');
    d.observe(4, ['run:a:b']);
    d.observe(5, ['run:a:b']);
    expect(d.toState().counts).toEqual({ 'run:a:b': 2 });
    d.resetCounts();
    const st = d.toState();
    expect(st.counts).toEqual({});
    expect(st.tripped).toBe(false);
    expect(st.lastSignature).toBeNull();
    expect(st.replanCount).toBe(1);
    expect(st.tripsBySignature['run:a:b']).toEqual({ trips: 1, directives: [{ step: 4, directive: 'Jev directs `change_approach`' }] });
    expect(d.trippedSignature()).toBeNull();
    // the third identical result after the reset counts from one again: no trip until three more
    expect(d.observe(6, ['run:a:b'])).toBeNull();
    expect(d.observe(7, ['run:a:b'])).toBeNull();
    expect(d.observe(8, ['run:a:b'])).toEqual({ signature: 'run:a:b', occurrences: 3 });
    // a tripped detector is untripped by the reset (the replan the human pre-empted never runs)
    const t = createLoopDetector();
    for (let i = 1; i <= 3; i++) t.observe(i, ['done:x']);
    expect(t.tripped()).toBe(true);
    t.resetCounts();
    expect(t.tripped()).toBe(false);
    expect(t.replanCount()).toBe(0);
  });
});

describe('fail: signature of a failing test run is the failing set (§6, ladder round 6)', () => {
  const run = (command: string, stdout: string, stderr = ''): string[] =>
    computeSignatures({ ...base, proposal: prop({ kind: 'run', command }), outcome: { status: 'executed', exec: execResult({ exitCode: 1, stdout, stderr }), summary: 'exit 1', changedFiles: [] }, output: stdout + stderr });
  const failOf = (sigs: string[]): string => sigs.find((x) => x.startsWith('fail:'))!;
  /** the units run of ladder round 5 (steps 1, 4, 6): `-qq` output, no count line, the last FAILED line identical each time */
  const unitsOut = (ids: readonly string[]): string =>
    `${'F'.repeat(ids.length)}${'.'.repeat(10 - ids.length)}                                                               [100%]\n=================================== FAILURES ===================================\n${ids.map((id) => `__________________ ${id.split('::')[1]} __________________\n\n    def ${id.split('::')[1]}():\n>       assert parse_duration("1 S") == 1000\nE       AssertionError: assert 1 == 1000\n\ntests/test_units.py:12: AssertionError`).join('\n')}\n=========================== short test summary info ============================\n${ids.map((id) => `FAILED ${id} - AssertionEr...`).join('\n')}\n`;
  const T = (n: string): string => `tests/test_units.py::${n}`;
  const four = [T('test_parse_duration_millisecond_unit'), T('test_parse_duration_fractional'), T('test_parse_duration_bare_number_is_milliseconds'), T('test_parse_duration_case_and_spaces')];
  const two = four.slice(2);
  const one = four.slice(3);

  it('6/10 → 8/10 → 9/10 progressing runs carry three different fail: signatures and never trip', () => {
    const s1 = run('python3 -m pytest -q', unitsOut(four));
    const s2 = run('python3 -m pytest -q', unitsOut(two));
    const s3 = run('python3 -m pytest -q', unitsOut(one));
    expect(new Set([failOf(s1), failOf(s2), failOf(s3)]).size).toBe(3);
    const d = createLoopDetector();
    expect(d.observe(1, s1)).toBeNull();
    expect(d.observe(4, s2)).toBeNull();
    expect(d.observe(6, s3)).toBeNull();
    expect(Object.values(d.toState().counts).every((n) => n === 1)).toBe(true);
    // the old text rule hashed the last stdout line, identical in all three runs
    expect(unitsOut(four).trimEnd().split('\n').pop()).toBe(unitsOut(one).trimEnd().split('\n').pop());
  });
  it('three identical failing sets trip at 3, whatever the message text, the ordering of the FAILED lines or the scope of the command', () => {
    const a = run('python3 -m pytest -q', unitsOut([four[0]!, four[3]!]));
    const b = run("python3 -m pytest -q 'tests/test_units.py'", unitsOut([four[3]!, four[0]!]).replace('assert 1 == 1000', 'assert 7 == 1000').replace(/ - AssertionEr\.\.\./g, ' - assert 7 == ...'));
    const c = run('python3 -m pytest -q', unitsOut([four[0]!, four[3]!]));
    expect(failOf(a)).toBe(failOf(b));
    expect(failOf(b)).toBe(failOf(c));
    const d = createLoopDetector();
    d.observe(1, a);
    d.observe(2, b);
    const trip = d.observe(3, c);
    expect(trip).toEqual({ signature: failOf(c), occurrences: LOOP_TRIP_COUNT });
  });
  it('identity: sorted ids; counts when no id is printed (digits kept); null for a command that is not a test runner', () => {
    expect(testFailureIdentity('pytest -q', { stdout: 'FAILED tests/b.py::test_b - x\nFAILED tests/a.py::test_a\nERROR tests/c.py - ImportError\n1 failed, 1 passed in 0.1s\n', stderr: '' })).toBe('tests:tests/a.py::test_a\ntests/b.py::test_b\ntests/c.py');
    // `-qq` progress only: the un-normalised counts, so 6/10 and 8/10 differ while the same counts twice agree
    expect(testFailureIdentity('python -m pytest -qq', { stdout: 'FFFF......                                                               [100%]\n', stderr: '' })).toBe('counts:6/4/0');
    expect(testFailureIdentity('python -m pytest -qq', { stdout: '..FF......                                                               [100%]\n', stderr: '' })).toBe('counts:8/2/0');
    expect(testFailureIdentity('make', { stdout: 'FAILED tests/a.py::test_a\n', stderr: 'make: *** [all] Error 2' })).toBeNull();
    // a known runner from the engine's detected test command overrides the command's own shape
    expect(testFailureIdentity('npm test', { stdout: ' FAIL  tests/x.test.ts > suite > name\n Tests  1 failed | 2 passed (3)\n', stderr: '' }, 'vitest')).toBe('tests:tests/x.test.ts > suite > name');
    expect(testFailureIdentity('pytest -q', { stdout: 'Killed', stderr: '' })).toBeNull();
    // stderr is part of the parsed output
    expect(testFailureIdentity('pytest -q', { stdout: '', stderr: 'FAILED tests/a.py::test_a - boom\n' })).toBe('tests:tests/a.py::test_a');
  });
  it('failingTestIds per runner; unittest\'s `FAILED (failures=1)` is not an id; verbose and 3.11 unittest forms agree', () => {
    expect(failingTestIds('pytest', 'tests/a.py::test_x FAILED                                                [ 50%]\ntests/a.py::test_y PASSED\nFAILED (failures=1)\n')).toEqual(['tests/a.py::test_x']);
    expect(failingTestIds('unittest', 'FAIL: test_x (pkg.mod.Case)\nERROR: test_y (pkg.mod.Case.test_y)\ntest_z (pkg.mod.Case) ... FAIL\nRan 3 tests in 0.001s\n\nFAILED (failures=2, errors=1)\n')).toEqual(['pkg.mod.Case.test_x', 'pkg.mod.Case.test_y', 'pkg.mod.Case.test_z']);
    expect(failingTestIds('django', 'FAIL: test_x (app.tests.Case)\n')).toEqual(['app.tests.Case.test_x']);
    expect(failingTestIds('sympy_bintest', '________________ sympy/core/tests/test_x.py:test_y ________________\n')).toEqual(['sympy/core/tests/test_x.py:test_y']);
    expect(failingTestIds('cargo', 'test a::b ... FAILED\ntest a::c ... ok\n')).toEqual(['a::b']);
    expect(failingTestIds('go', '--- FAIL: TestX (0.00s)\n    --- FAIL: TestX/sub (0.00s)\n')).toEqual(['TestX', 'TestX/sub']);
    expect(failingTestIds('jest', '  ● Suite › does a thing\n  ✕ does a thing (3 ms)\n  ● Test suite failed to run\nFAIL src/x.test.ts\n')).toEqual(['Suite › does a thing', 'does a thing', 'src/x.test.ts']);
    expect(failingTestIds('unknown', 'FAILED tests/a.py::test_a\n')).toEqual(['tests/a.py::test_a']);
    expect(failingTestIds('pytest', '')).toEqual([]);
  });
  it('a non-runner command that exits non-zero keeps the exit-code + first-line text hash; a failed outcome keeps the error-class hash', () => {
    const a = run('make build', 'x', 'make: *** [all] Error 2');
    const b = run('make build', 'y', 'make: *** [all] Error 3');
    expect(failOf(a)).toBe(failOf(b));
    expect(failOf(a)).not.toBe(failOf(run('make build', '', 'gcc: fatal error')));
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
