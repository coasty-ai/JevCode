/**
 * TUI-DESIGN §12.4 / §12.5 / §19.0: the /undo decision table incl. staged-then-modified and HEAD-moved; the ask
 * overlay reducer; the §24 output strings; /rewind planning.
 */
import { describe, expect, it } from 'vitest';
import type { PostImage, PostImageFile } from '../../../src/checkpoint/images.js';
import { stringCells } from '../../../src/undo/diff.js';
import {
  CHANGED_DURING_UNDO,
  KEPT_DECLINED,
  NOT_RECOVERABLE_CAP,
  NOT_RECOVERABLE_COMMAND,
  NOT_RECOVERABLE_NO_GIT,
  NOT_RECOVERABLE_SIZE,
  REWIND_CHOICE,
  REWIND_RULE,
  askPrompt,
  currentAsk,
  expectedState,
  headMovedMessage,
  planRewind,
  planUndo,
  reduceUndoAsk,
  refuseMessage,
  resolveAsks,
  rewindCandidates,
  rewindPickerRows,
  skipsFromDecisions,
  startUndoAsks,
  stillExpected,
  undoAsksDone,
  undoLogEntry,
  undoNote,
  undoSummaryLine,
  type CurrentFileState,
  type UndoPlanInput,
} from '../../../src/undo/plan.js';

const HEAD = '7d731c0e1234';

function image(step: number, files: Record<string, PostImageFile>, headOid: string | null = HEAD): PostImage {
  return { v: 1, step, at: '2026-09-20T12:00:00.000Z', headOid, files, skipped: [], hashSkipped: false };
}

function input(over: Partial<UndoPlanInput> & { post: PostImage }): UndoPlanInput {
  return { step: over.post.step, current: {}, later: [], headOid: HEAD, git: true, ...over };
}

const edited: PostImageFile = { sha256: 'aaa', bytes: 10, mode: 0o644, source: 'edit', preImage: true, cleanAtStart: true };
const cur = (sha256: string | null, exists = true, extra: Partial<CurrentFileState> = {}): CurrentFileState => ({ exists, sha256, ...extra });

describe('planUndo decision table (§12.4)', () => {
  it('sha256 equal → restore via the pre-image', () => {
    const plan = planUndo(input({ post: image(7, { 'src/a.py': edited }), current: { 'src/a.py': cur('aaa') } }));
    expect(plan.decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'pre-image', expected: { exists: true, sha256: 'aaa' } }]);
    expect(plan.refusals).toEqual([]);
    expect(plan.asks).toEqual([]);
  });

  it('missing and deleted: true → restore (the pre-image brings it back)', () => {
    const plan = planUndo(input({ post: image(7, { 'old.txt': { deleted: true, preImage: true, source: 'edit' } }) }));
    expect(plan.decisions).toEqual([{ kind: 'restore', path: 'old.txt', via: 'pre-image', expected: { exists: false, sha256: null } }]);
  });

  it('differs and a later step recorded the current state → refuse with the /rewind hint (latest matching step wins)', () => {
    const later8 = image(8, { 'src/a.py': { ...edited, sha256: 'bbb' } });
    const later9 = image(9, { 'src/a.py': { ...edited, sha256: 'ccc' } });
    const plan = planUndo(input({ post: image(7, { 'src/a.py': edited }), current: { 'src/a.py': cur('ccc') }, later: [later8, later9] }));
    expect(plan.decisions).toEqual([{ kind: 'refuse', path: 'src/a.py', laterStep: 9, message: 'src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together' }]);
    expect(plan.refusals).toHaveLength(1);
    expect(refuseMessage('x', 3, 5)).toBe('x was changed again by step 5; use /rewind 3 to undo steps 3–5 together');
    // a later step that deleted the file matches a missing file
    const later10 = image(10, { 'src/a.py': { deleted: true, preImage: true, source: 'run' } });
    const gone = planUndo(input({ post: image(7, { 'src/a.py': edited }), current: {}, later: [later10] }));
    expect(gone.decisions[0]).toMatchObject({ kind: 'refuse', laterStep: 10 });
    // later images of steps ≤ N are ignored even if handed in
    const stale = planUndo(input({ post: image(7, { 'src/a.py': edited }), current: { 'src/a.py': cur('zzz') }, later: [image(6, { 'src/a.py': { ...edited, sha256: 'zzz' } })] }));
    expect(stale.decisions[0]?.kind).toBe('ask');
  });

  it('differs otherwise → ask, default n, with the §24 prompt', () => {
    const plan = planUndo(input({ post: image(7, { 'src/a.py': edited }), current: { 'src/a.py': cur('zzz') } }));
    expect(plan.decisions).toEqual([{ kind: 'ask', path: 'src/a.py', via: 'pre-image', prompt: 'src/a.py changed since step 7 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort', expected: { exists: true, sha256: 'zzz' } }]);
    expect(plan.asks).toHaveLength(1);
    expect(askPrompt('p', 2)).toBe('p changed since step 2 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort');
  });

  it('a deleted file that exists again, and a recorded file that vanished, both differ → ask', () => {
    const back = planUndo(input({ post: image(7, { 'old.txt': { deleted: true, preImage: true, source: 'edit' } }), current: { 'old.txt': cur('new') } }));
    expect(back.decisions[0]?.kind).toBe('ask');
    const vanished = planUndo(input({ post: image(7, { 'src/a.py': edited }), current: {} }));
    expect(vanished.decisions[0]?.kind).toBe('ask');
  });

  it('sha256: null (hashing budget exhausted) is an ask row (§12.3)', () => {
    const plan = planUndo(input({ post: image(7, { 'big.bin': { ...edited, sha256: null } }), current: { 'big.bin': cur('whatever') } }));
    expect(plan.decisions[0]?.kind).toBe('ask');
  });

  it('symlink / hard link → skip link; escape → skip escape; submodule → skip submodule (before any comparison)', () => {
    const post = image(7, { l: edited, h: edited, e: edited, s: edited });
    const plan = planUndo(input({ post, current: { l: cur('aaa', true, { symlink: true }), h: cur('aaa', true, { nlink: 2 }), e: cur('aaa', true, { escapes: true }), s: cur('aaa', true, { submodule: true }) } }));
    expect(plan.decisions.map((d) => (d.kind === 'skip' ? d.reason : d.kind))).toEqual(['link', 'link', 'escape', 'submodule']);
  });

  it('a created file: unchanged → restore via unlink; changed → ask (overwrite = delete)', () => {
    const created: PostImageFile = { sha256: 'nnn', bytes: 4, mode: 0o644, source: 'write', created: true };
    expect(planUndo(input({ post: image(7, { 'new.py': created }), current: { 'new.py': cur('nnn') } })).decisions).toEqual([{ kind: 'restore', path: 'new.py', via: 'unlink', expected: { exists: true, sha256: 'nnn' } }]);
    expect(planUndo(input({ post: image(7, { 'new.py': created }), current: { 'new.py': cur('mmm') } })).decisions[0]).toMatchObject({ kind: 'ask', via: 'unlink' });
  });

  it('run-changed, clean at start, tracked, HEAD unchanged → git-restore; HEAD moved → skip head-moved (E10)', () => {
    const runFile: PostImageFile = { sha256: 'rrr', bytes: 9, mode: 0o644, source: 'run', preImage: false, cleanAtStart: true };
    const same = planUndo(input({ post: image(7, { 'src/a.py': runFile }), current: { 'src/a.py': cur('rrr') }, headOid: HEAD }));
    expect(same.decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'git-restore', expected: { exists: true, sha256: 'rrr' } }]);
    const moved = planUndo(input({ post: image(7, { 'src/a.py': runFile }), current: { 'src/a.py': cur('rrr') }, headOid: '91ab3c4d' }));
    expect(moved.decisions).toEqual([{ kind: 'skip', path: 'src/a.py', reason: 'head-moved', message: 'not recoverable — HEAD moved since step 7' }]);
    expect(headMovedMessage(7)).toBe('not recoverable — HEAD moved since step 7');
    // HEAD unborn at the step: nothing to restore from
    const unborn = planUndo(input({ post: image(7, { 'src/a.py': runFile }, null), current: { 'src/a.py': cur('rrr') }, headOid: null }));
    expect(unborn.decisions[0]).toMatchObject({ kind: 'skip', reason: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND });
    // HEAD moved but a pre-image exists (the file was dirty before the run): the pre-image wins, HEAD is irrelevant
    const withPre = planUndo(input({ post: image(7, { 'src/a.py': { ...runFile, preImage: true, cleanAtStart: false } }), current: { 'src/a.py': cur('rrr') }, headOid: 'other' }));
    expect(withPre.decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'pre-image', expected: { exists: true, sha256: 'rrr' } }]);
  });

  it('staged-then-modified: dirty at start means a pre-image was taken before the command, so it restores from it', () => {
    // `git add src/a.py` before the run (staged → dirty set) then the step's command rewrote it
    const staged: PostImageFile = { sha256: 'sss', bytes: 5, mode: 0o644, source: 'run', preImage: true, cleanAtStart: false };
    const plan = planUndo(input({ post: image(7, { 'src/a.py': staged }), current: { 'src/a.py': cur('sss') }, headOid: 'moved-too' }));
    expect(plan.decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'pre-image', expected: { exists: true, sha256: 'sss' } }]);
    // the same file changed by a command without a pre-image and not clean → not recoverable by a command
    const noPre = planUndo(input({ post: image(7, { 'build/out.txt': { ...staged, preImage: false } }), current: { 'build/out.txt': cur('sss') } }));
    expect(noPre.decisions).toEqual([{ kind: 'skip', path: 'build/out.txt', reason: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND }]);
  });

  it('non-git: rules 1–2 only, reason `not recoverable — no git repository`', () => {
    const runFile: PostImageFile = { sha256: 'rrr', bytes: 9, mode: 0o644, source: 'run', preImage: false, cleanAtStart: true };
    const plan = planUndo(input({ post: image(7, { 'src/a.py': runFile, 'pre.txt': edited, 'new.txt': { sha256: 'n', bytes: 1, mode: 0o644, source: 'write', created: true } }, null), current: { 'src/a.py': cur('rrr'), 'pre.txt': cur('aaa'), 'new.txt': cur('n') }, headOid: null, git: false }));
    expect(plan.decisions).toEqual([
      { kind: 'skip', path: 'src/a.py', reason: 'not-recoverable', message: NOT_RECOVERABLE_NO_GIT },
      { kind: 'restore', path: 'pre.txt', via: 'pre-image', expected: { exists: true, sha256: 'aaa' } },
      { kind: 'restore', path: 'new.txt', via: 'unlink', expected: { exists: true, sha256: 'n' } },
    ]);
  });

  it('a target whose pre-image was skipped for size or cap is explained with that reason, not the command text', () => {
    const big: PostImageFile = { sha256: 'aaa', bytes: 2_000_000, mode: 0o644, source: 'edit', preImage: false, cleanAtStart: true };
    const post = { ...image(7, { 'big.py': big }), skipped: [{ path: 'big.py', reason: 'size' as const, bytes: 2_000_000 }] };
    expect(planUndo(input({ post, current: { 'big.py': cur('aaa') } })).decisions).toEqual([{ kind: 'skip', path: 'big.py', reason: 'size', message: NOT_RECOVERABLE_SIZE }]);
    expect(NOT_RECOVERABLE_SIZE).toBe('not recoverable — no pre-image (file > 1 MiB)');
    const capped: PostImageFile = { sha256: 'ccc', bytes: 10, mode: 0o644, source: 'patch', preImage: false, cleanAtStart: false };
    const postCap = { ...image(7, { 'f200.py': capped }), skipped: [{ path: 'f200.py', reason: 'cap' as const, bytes: 10 }] };
    expect(planUndo(input({ post: postCap, current: { 'f200.py': cur('ccc') } })).decisions).toEqual([{ kind: 'skip', path: 'f200.py', reason: 'cap', message: NOT_RECOVERABLE_CAP }]);
    expect(NOT_RECOVERABLE_CAP).toBe('not recoverable — no pre-image (copy cap reached)');
    // the size / cap reason also beats the no-git text (the pre-image is what would have restored it)
    expect(planUndo(input({ post, current: { 'big.py': cur('aaa') }, git: false, headOid: null })).decisions[0]).toMatchObject({ kind: 'skip', reason: 'size' });
    // a `run` file that is clean at start with HEAD unchanged still restores from HEAD even when its dirty-set copy was capped
    const runClean: PostImageFile = { sha256: 'rrr', bytes: 9, mode: 0o644, source: 'run', preImage: false, cleanAtStart: true };
    const postRun = { ...image(7, { 'src/a.py': runClean }), skipped: [{ path: 'src/a.py', reason: 'cap' as const }] };
    expect(planUndo(input({ post: postRun, current: { 'src/a.py': cur('rrr') } })).decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'git-restore', expected: { exists: true, sha256: 'rrr' } }]);
    // …and once HEAD moved, the cap explains the missing copy before the HEAD-moved rule
    expect(planUndo(input({ post: postRun, current: { 'src/a.py': cur('rrr') }, headOid: 'moved' })).decisions[0]).toMatchObject({ kind: 'skip', reason: 'cap' });
    // a skip recorded for another path changes nothing
    const other = { ...image(7, { 'build/out.txt': { ...runClean, cleanAtStart: false } }), skipped: [{ path: 'elsewhere.py', reason: 'size' as const }] };
    expect(planUndo(input({ post: other, current: { 'build/out.txt': cur('rrr') } })).decisions[0]).toMatchObject({ kind: 'skip', reason: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND });
  });

  it('is pure: equal inputs give equal plans and the input is never mutated', () => {
    const later8 = image(8, { 'src/a.py': { ...edited, sha256: 'bbb' } });
    const frozen = Object.freeze(input({ post: Object.freeze(image(7, { 'src/a.py': edited, 'b.py': edited })), current: Object.freeze({ 'src/a.py': cur('bbb'), 'b.py': cur('zzz') }), later: Object.freeze([later8]) }));
    const a = planUndo(frozen);
    const b = planUndo(frozen);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.decisions.map((d) => d.kind)).toEqual(['refuse', 'ask']);
    expect(Object.keys(frozen.post.files)).toEqual(['src/a.py', 'b.py']);
  });

  it('an empty post image plans nothing; decisions keep the image order', () => {
    expect(planUndo(input({ post: image(7, {}) }))).toEqual({ step: 7, decisions: [], refusals: [], asks: [] });
    const plan = planUndo(input({ post: image(7, { z: edited, a: edited }), current: { z: cur('aaa'), a: cur('aaa') } }));
    expect(plan.decisions.map((d) => d.path)).toEqual(['z', 'a']);
  });
});

describe('the ask overlay (§12.4, §24)', () => {
  const plan = planUndo(input({ post: image(7, { a: edited, b: edited, c: edited, ok: edited }), current: { a: cur('x'), b: cur('y'), c: cur('z'), ok: cur('aaa') } }));

  it('y / n / Enter answer one row each; the sequence ends after the last', () => {
    let s = startUndoAsks(plan);
    expect(currentAsk(s)?.path).toBe('a');
    s = reduceUndoAsk(s, 'y');
    expect(currentAsk(s)?.path).toBe('b');
    s = reduceUndoAsk(s, 'enter');
    s = reduceUndoAsk(s, 'n');
    expect(undoAsksDone(s)).toBe(true);
    expect(currentAsk(s)).toBeNull();
    expect(s.answers).toEqual({ a: true, b: false, c: false });
    // inert once done
    expect(reduceUndoAsk(s, 'y')).toBe(s);
    const resolved = resolveAsks(plan, s.answers);
    expect(resolved.map((d) => d.kind)).toEqual(['restore', 'skip', 'skip', 'restore']);
    expect(resolved[1]).toEqual({ kind: 'skip', path: 'b', reason: 'declined', message: KEPT_DECLINED });
    // an answered `y` keeps the ask's expected snapshot: apply.ts re-verifies the bytes the user said yes to
    expect(resolved[0]).toEqual({ kind: 'restore', path: 'a', via: 'pre-image', expected: { exists: true, sha256: 'x' } });
  });

  it('expected snapshots (§12.4 re-verification): existence and hash; an unhashed plan-time file checks existence only', () => {
    expect(expectedState(cur('abc'))).toEqual({ exists: true, sha256: 'abc' });
    expect(expectedState(cur(null, false))).toEqual({ exists: false, sha256: null });
    expect(stillExpected({ exists: true, sha256: 'abc' }, cur('abc'))).toBe(true);
    expect(stillExpected({ exists: true, sha256: 'abc' }, cur('def'))).toBe(false);
    expect(stillExpected({ exists: true, sha256: 'abc' }, cur(null))).toBe(false); // grew past the hash bound or unreadable now
    expect(stillExpected({ exists: true, sha256: 'abc' }, cur(null, false))).toBe(false); // vanished
    expect(stillExpected({ exists: false, sha256: null }, cur(null, false))).toBe(true);
    expect(stillExpected({ exists: false, sha256: null }, cur('new'))).toBe(false); // reappeared
    expect(stillExpected({ exists: true, sha256: null }, cur('whatever'))).toBe(true);
    expect(stillExpected({ exists: true, sha256: null }, cur(null, false))).toBe(false);
    expect(CHANGED_DURING_UNDO).toBe('kept (changed during undo)');
    expect(KEPT_DECLINED).toBe('kept (declined)');
  });

  it('a = all remaining overwrite, s = skip rest, Esc = abort', () => {
    const all = reduceUndoAsk(reduceUndoAsk(startUndoAsks(plan), 'n'), 'a');
    expect(all.answers).toEqual({ a: false, b: true, c: true });
    expect(undoAsksDone(all)).toBe(true);
    const rest = reduceUndoAsk(startUndoAsks(plan), 's');
    expect(rest.answers).toEqual({ a: false, b: false, c: false });
    const esc = reduceUndoAsk(reduceUndoAsk(startUndoAsks(plan), 'y'), 'esc');
    expect(esc.aborted).toBe(true);
    expect(undoAsksDone(esc)).toBe(true);
    expect(currentAsk(esc)).toBeNull();
    // unanswered asks stay asks when partially resolved
    expect(resolveAsks(plan, { a: true }).map((d) => d.kind)).toEqual(['restore', 'ask', 'ask', 'restore']);
  });

  it('a plan without asks is done at once', () => {
    const s = startUndoAsks(planUndo(input({ post: image(7, { ok: edited }), current: { ok: cur('aaa') } })));
    expect(undoAsksDone(s)).toBe(true);
    expect(reduceUndoAsk(s, 'esc')).toBe(s);
  });
});

describe('output strings (§12.4, §24)', () => {
  it('undo summary: restored list, skipped with reasons, singular, none restored', () => {
    expect(undoSummaryLine(7, ['src/a.py', 'src/b.py', 'tests/test_a.py'], [{ path: 'build/out.txt', reason: 'not-recoverable', message: NOT_RECOVERABLE_COMMAND }])).toBe(
      'undo step 7: restored 3 files (src/a.py, src/b.py, tests/test_a.py), skipped 1 (build/out.txt: not recoverable — changed by a command, not tracked by git)',
    );
    expect(undoSummaryLine(7, ['a'], [])).toBe('undo step 7: restored 1 file (a)');
    expect(undoSummaryLine(7, [], [{ path: 'x', reason: 'head-moved', message: headMovedMessage(7) }])).toBe('no files restored (x: not recoverable — HEAD moved since step 7)');
    expect(undoSummaryLine(7, [], [])).toBe('no files restored (step 7 changed no files)');
    expect(undoSummaryLine(7, [], [{ path: 'x', reason: 'declined' }])).toBe('no files restored (x: declined)');
    // long lists are capped
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.py`);
    const line = undoSummaryLine(1, many, []);
    expect(line).toContain('restored 25 files (f0.py, f1.py');
    expect(line).toContain(', … 15 more)');
  });

  it('undo note and undoLog entry', () => {
    expect(undoNote(7, ['src/a.py', 'src/b.py'])).toBe('human reverted step 7: src/a.py, src/b.py');
    expect(undoLogEntry({ runId: 'r1', step: 7, at: 't', by: 'undo', restored: ['a'], skipped: [{ path: 'b', reason: 'link' }] })).toEqual({ runId: 'r1', step: 7, at: 't', by: 'undo', restored: ['a'], skipped: [{ path: 'b', reason: 'link' }] });
  });

  it('skipsFromDecisions: a refuse row is `refused` with its /rewind hint, an unanswered ask `declined`, restores are not skips', () => {
    const later9 = image(9, { 'src/a.py': { ...edited, sha256: 'ccc' } });
    const plan = planUndo(input({ post: image(7, { 'src/a.py': edited, 'b.py': edited, 'ok.py': edited, 'l.py': edited }), current: { 'src/a.py': cur('ccc'), 'b.py': cur('zzz'), 'ok.py': cur('aaa'), 'l.py': cur('aaa', true, { symlink: true }) }, later: [later9] }));
    expect(plan.decisions.map((d) => d.kind)).toEqual(['refuse', 'ask', 'restore', 'skip']);
    const skips = skipsFromDecisions(plan.decisions);
    expect(skips).toEqual([
      { path: 'src/a.py', reason: 'refused', message: 'src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together' },
      { path: 'b.py', reason: 'declined', message: 'kept (declined)' },
      { path: 'l.py', reason: 'link', message: 'symlink or hard link' },
    ]);
    // the entry carries the contract reasons only; the summary line carries the messages
    expect(undoLogEntry({ runId: 'r1', step: 7, at: 't', by: 'undo', restored: [], skipped: skips }).skipped).toEqual([
      { path: 'src/a.py', reason: 'refused' },
      { path: 'b.py', reason: 'declined' },
      { path: 'l.py', reason: 'link' },
    ]);
    expect(undoSummaryLine(7, [], skips)).toBe('no files restored (src/a.py: src/a.py was changed again by step 9; use /rewind 7 to undo steps 7–9 together, b.py: kept (declined), l.py: symlink or hard link)');
    // an answered ask (y) is a restore and drops out; (n) is declined
    expect(skipsFromDecisions(resolveAsks(plan, { 'b.py': true })).map((s) => s.path)).toEqual(['src/a.py', 'l.py']);
    expect(skipsFromDecisions(resolveAsks(plan, { 'b.py': false }))[1]).toEqual({ path: 'b.py', reason: 'declined', message: 'kept (declined)' });
    expect(skipsFromDecisions([])).toEqual([]);
  });
});

describe('/rewind planning (§12.5)', () => {
  const steps = [
    { step: 1, changedFiles: [] },
    { step: 2, changedFiles: ['a.py'], planAfter: { done: [], remaining: [], unverified: [], harnessProblems: [] } },
    { step: 3, changedFiles: ['b.py', 'c.py'] },
    { step: 4, changedFiles: [] },
    { step: 5, changedFiles: ['a.py'] },
  ];

  it('undoes steps last…n in reverse, only steps with changes; planAfter of n seeds when recorded', () => {
    expect(planRewind(steps, 2)).toEqual({ target: 2, order: [5, 3, 2], planAfterFrom: 2, windowUpTo: 2 });
    expect(planRewind(steps, 3)).toEqual({ target: 3, order: [5, 3], planAfterFrom: null, windowUpTo: 3 });
    expect(planRewind(steps, 6)).toEqual({ target: 6, order: [], planAfterFrom: null, windowUpTo: 6 });
    expect(planRewind(steps, 0).target).toBe(1);
    expect(planRewind(steps, Number.NaN).target).toBe(1);
    expect(planRewind([], 1)).toEqual({ target: 1, order: [], planAfterFrom: null, windowUpTo: 1 });
  });

  it('picker candidates and rows: steps with changes, oldest first, truncated to columns', () => {
    expect(rewindCandidates(steps).map((s) => s.step)).toEqual([2, 3, 5]);
    const rows = rewindPickerRows(steps, 80);
    expect(rows).toEqual(['s2   1 file  a.py', 's3   2 files  b.py, c.py', 's5   1 file  a.py']);
    expect(rewindPickerRows(steps, 10)).toEqual(['s2   1 fi…', 's3   2 fi…', 's5   1 fi…']);
    for (const r of rewindPickerRows(steps, 10)) expect([...r].length).toBe(10);
    expect(rewindPickerRows(steps, 1)).toEqual(['…', '…', '…']);
    expect(rewindPickerRows(steps, Number.NaN)[0]).toBe('s2   1 file  a.py');
    // a CJK path is cut in cells (§2.1): 14 columns hold the prefix and one wide character before the ellipsis
    const cjk = rewindPickerRows([{ step: 1, changedFiles: ['日本語日本語日本語.py'] }], 14);
    expect(cjk).toEqual(['s1   1 file  …']);
    for (const cols of [8, 14, 20, 30, 40]) {
      for (const row of rewindPickerRows([{ step: 1, changedFiles: ['日本語日本語日本語.py', 'émoji😀.py'] }], cols)) expect(stringCells(row), `cols=${cols}`).toBeLessThanOrEqual(cols);
    }
    expect(rewindPickerRows([{ step: 1, changedFiles: ['日本語.py'] }], 80)).toEqual(['s1   1 file  日本語.py']);
    expect(rewindPickerRows([{ step: 1, changedFiles: ['日本語日本語.py'] }], 20)).toEqual(['s1   1 file  日本語…']);
    expect(REWIND_RULE).toBe('─── rewind · steps with changes ─ ↑↓ Enter Esc ───');
    expect(REWIND_CHOICE).toBe('files (done) · [p] plan+window · [b] both · Esc keep');
  });
});
