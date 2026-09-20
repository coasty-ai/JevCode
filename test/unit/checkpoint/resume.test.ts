import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Action, StepRecord } from '../../../src/core/types.js';
import { CheckpointError, ConfigError } from '../../../src/errors.js';
import { createRunDir } from '../../../src/checkpoint/run-id.js';
import { CHECKPOINT_FILES, createCheckpointStore } from '../../../src/checkpoint/store.js';
import {
  FOLDED_NOTE,
  OUTPUT_MAX,
  WINDOW_SIZE,
  boundOutput,
  foldStepsIntoState,
  loadForResume,
  makeWindowEntryFromRecord,
  summariseAction,
} from '../../../src/checkpoint/resume.js';
import { fakeRedact, makeExec, makeProposal, makeState, makeMeta, makeStepRecord, withTempDir } from '../../fixtures/checkpoint/make.js';

const AT = '2026-09-19T14:00:00.000Z';

describe('summariseAction', () => {
  const table: [Action, string][] = [
    [{ kind: 'read', paths: ['a.py', 'b.py'] }, 'read a.py, b.py'],
    [{ kind: 'edit', path: 'src/a.py', old: 'x', new: 'y' }, 'edit src/a.py'],
    [{ kind: 'write', path: 'new.txt', content: 'c' }, 'write new.txt'],
    [{ kind: 'patch', diff: 'a\nb\nc' }, 'patch (3 lines)'],
    [{ kind: 'run', command: 'pytest -q' }, 'run pytest -q'],
    [{ kind: 'done', summary: 'all good' }, 'done'],
  ];
  it.each(table)('%j', (action, expected) => {
    expect(summariseAction(action)).toBe(expected);
  });

  it('bounds a huge command', () => {
    expect(summariseAction({ kind: 'run', command: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(200);
  });
});

describe('boundOutput', () => {
  it('keeps short output verbatim and bounds long output to 600 chars with head and tail', () => {
    expect(boundOutput('short')).toBe('short');
    const long = `${'H'.repeat(1000)}${'T'.repeat(1000)}`;
    const out = boundOutput(long);
    expect(out.length).toBeLessThanOrEqual(OUTPUT_MAX);
    expect(out.startsWith('H'.repeat(400))).toBe(true);
    expect(out.endsWith('T')).toBe(true);
    expect(out).toMatch(/chars omitted/);
  });
});

describe('makeWindowEntryFromRecord', () => {
  it('executed run with exec: output, exit note, changed files, shownFiles from context', () => {
    const r = makeStepRecord(3, {
      outcome: { status: 'executed', exec: makeExec({ stdout: 'out', stderr: 'err', exitCode: 1, ok: false, truncated: true }), summary: 's', changedFiles: ['a.py', 'b.py'] },
    });
    const e = makeWindowEntryFromRecord(r);
    expect(e).toEqual({
      step: 3,
      intent: 'verify',
      action: 'run pytest -q',
      outcome: 'executed',
      output: 'out\nerr',
      truncated: true,
      shownFiles: ['src/a.py'],
      notes: ['exit 1', 'changed: a.py, b.py'],
    });
  });

  it('executed edit without exec uses the summary as output', () => {
    const r = makeStepRecord(1, {
      proposal: makeProposal({ action: { kind: 'edit', path: 'src/a.py', old: 'a', new: 'b' } }),
      outcome: { status: 'executed', summary: 'edited src/a.py', changedFiles: ['src/a.py'] },
    });
    const e = makeWindowEntryFromRecord(r);
    expect(e.action).toBe('edit src/a.py');
    expect(e.output).toBe('edited src/a.py');
    expect(e.notes).toEqual(['changed: src/a.py']);
    expect(e.truncated).toBeUndefined();
  });

  it('blocked / declined carry the reason, failed carries the error, each bounded to 600', () => {
    const long = 'r'.repeat(1000);
    expect(makeWindowEntryFromRecord(makeStepRecord(1, { outcome: { status: 'blocked', reason: long } })).reason?.length).toBe(600);
    expect(makeWindowEntryFromRecord(makeStepRecord(1, { outcome: { status: 'declined', reason: 'reviewer said no' } })).reason).toBe('reviewer said no');
    const failed = makeWindowEntryFromRecord(makeStepRecord(1, { outcome: { status: 'failed', error: 'EditError: no match' } }));
    expect(failed.outcome).toBe('failed');
    expect(failed.reason).toBe('EditError: no match');
    expect(failed.output).toBeUndefined();
  });

  it('interrupted during execute (§9.1 rule 2) shows partial output and the interruption note', () => {
    const r = makeStepRecord(2, {
      outcome: { status: 'interrupted', exec: makeExec({ stdout: 'partial', exitCode: null, signal: 'SIGTERM', killedBy: 'abort', ok: false }) },
      interruptedAt: { stage: 'execute', reason: 'human_abort' },
    });
    const e = makeWindowEntryFromRecord(r);
    expect(e.outcome).toBe('interrupted');
    expect(e.output).toBe('partial');
    expect(e.notes).toEqual(['killed by abort', 'interrupted during execute (human_abort)']);
  });

  it('interrupted before judge (§9.1 rule 3) keeps the real outcome plus the note', () => {
    const r = makeStepRecord(2, { interruptedAt: { stage: 'judge', reason: 'signal' } });
    const e = makeWindowEntryFromRecord(r);
    expect(e.outcome).toBe('executed');
    expect(e.notes).toEqual(['interrupted before judge']);
  });

  it('stage errors: judge -> unjudged, other -> "<stage> failed"; no proposal is named', () => {
    const judgeErr = makeWindowEntryFromRecord(makeStepRecord(1, { error: { stage: 'judge', code: 'jev_http', message: 'boom' } }));
    expect(judgeErr.notes).toEqual(['unjudged: jev_http']);
    const noProposal = makeWindowEntryFromRecord(
      makeStepRecord(1, { proposal: null, outcome: { status: 'failed', error: 'propose: generator_response' }, error: { stage: 'propose', code: 'generator_response', message: 'x' } }),
    );
    expect(noProposal.action).toBe('(no proposal: propose failed)');
    expect(noProposal.notes).toEqual(['propose failed: generator_response']);
    expect(makeWindowEntryFromRecord(makeStepRecord(1, { proposal: null, outcome: null })).action).toBe('(no proposal)');
  });

  it('read paths join shownFiles, de-duplicated; judge and completion pass through', () => {
    const judge = { succeeded: 0.9, errorPresent: 0.1, newInfo: 0.5, tests: null, doneClaims: [] };
    const r = makeStepRecord(1, {
      contextFiles: ['a.py', 'b.py'],
      proposal: makeProposal({ action: { kind: 'read', paths: ['b.py', 'c.py'] } }),
      outcome: { status: 'executed', summary: 'views', changedFiles: [] },
      judge,
      completion: 0.42,
    });
    const e = makeWindowEntryFromRecord(r);
    expect(e.shownFiles).toEqual(['a.py', 'b.py', 'c.py']);
    expect(e.judge).toEqual(judge);
    expect(e.completion).toBe(0.42);
  });
});

describe('foldStepsIntoState', () => {
  it('with no records: step unchanged, stopReason cleared, resumes incremented, updatedAt set', () => {
    const s = makeState({ step: 3, stopReason: 'signal', resumes: 1, error: { stage: 'judge', code: 'jev_http' } });
    const out = foldStepsIntoState(s, [], AT);
    expect(out.step).toBe(3);
    expect(out.stopReason).toBeNull();
    expect(out.resumes).toBe(2);
    expect(out.updatedAt).toBe(AT);
    expect('error' in out).toBe(false);
    expect(out.window).toEqual([]);
    // input untouched
    expect(s.stopReason).toBe('signal');
    expect(s.resumes).toBe(1);
  });

  it('ignores records at or below state.step', () => {
    const s = makeState({ step: 3 });
    const out = foldStepsIntoState(s, [makeStepRecord(1), makeStepRecord(3)], AT);
    expect(out.step).toBe(3);
    expect(out.window).toEqual([]);
  });

  it('folds later records into the window in step order with the folded note and advances step', () => {
    const s = makeState({ step: 2, window: [{ step: 2, intent: 'edit', action: 'edit a', outcome: 'executed', shownFiles: [], notes: [] }] });
    const out = foldStepsIntoState(s, [makeStepRecord(4, { intent: 'edit' }), makeStepRecord(3)], AT);
    expect(out.step).toBe(4);
    expect(out.window.map((w) => w.step)).toEqual([2, 3, 4]);
    expect(out.window[1]?.notes).toEqual([FOLDED_NOTE]);
    expect(out.window[2]?.intent).toBe('edit');
    expect(s.window).toHaveLength(1);
  });

  it('bounds the window to the last 4 entries and keeps the last record per step', () => {
    const records: StepRecord[] = [1, 2, 3, 4, 5, 6].map((n) => makeStepRecord(n));
    records.push(makeStepRecord(6, { intent: 'finish' }));
    const out = foldStepsIntoState(makeState({ step: 0 }), records, AT);
    expect(out.step).toBe(6);
    expect(out.window).toHaveLength(WINDOW_SIZE);
    expect(out.window.map((w) => w.step)).toEqual([3, 4, 5, 6]);
    expect(out.window[3]?.intent).toBe('finish');
    for (const w of out.window) expect((w.output ?? '').length).toBeLessThanOrEqual(OUTPUT_MAX);
  });

  it('clears a rule-1 interrupted diagnostic only when a folded step supersedes it', () => {
    const interrupted = { step: 3, stage: 'propose' as const, proposal: null };
    const kept = foldStepsIntoState(makeState({ step: 2, interrupted }), [], AT);
    expect(kept.interrupted).toEqual(interrupted);
    const cleared = foldStepsIntoState(makeState({ step: 2, interrupted }), [makeStepRecord(3)], AT);
    expect(cleared.interrupted).toBeNull();
  });

  it('does not reconstruct plan, spend or counters from folded records', () => {
    const s = makeState({ step: 1 });
    const out = foldStepsIntoState(s, [makeStepRecord(2, { outcome: { status: 'executed', summary: 's', changedFiles: ['a.py'] } })], AT);
    expect(out.plan).toBe(s.plan);
    expect(out.spend).toBe(s.spend);
    expect(out.counters).toBe(s.counters);
    expect(out.tokensPerStep).toBe(s.tokensPerStep);
  });
});

describe('loadForResume', () => {
  const now = (): Date => new Date(AT);

  it('loads, folds the steps.jsonl tail, reports previous stop reason, and writes nothing', () =>
    withTempDir(async (tmp) => {
      const runsDir = join(tmp, 'runs');
      const { runId, runDir } = await createRunDir(runsDir, new Date('2026-09-19T12:00:00Z'));
      const store = createCheckpointStore(runDir, fakeRedact);
      await store.create(makeMeta({ runId }));
      await store.writeState(makeState({ runId, step: 1 }));
      await store.writeState(makeState({ runId, step: 2, stopReason: 'signal' }));
      for (const n of [1, 2, 3, 4]) await store.appendStep(makeStepRecord(n));
      const before = await readFile(join(runDir, CHECKPOINT_FILES.state), 'utf8');
      const beforeMeta = await readFile(join(runDir, CHECKPOINT_FILES.meta), 'utf8');

      const r = await loadForResume(runsDir, runId, { redact: fakeRedact, now });
      expect(r.store.dir).toBe(await import('node:fs/promises').then((fs) => fs.realpath(runDir)));
      expect(r.meta.runId).toBe(runId);
      expect(r.recoveredFrom).toBe('state');
      expect(r.checkpointStep).toBe(2);
      expect(r.previousStopReason).toBe('signal');
      expect(r.foldedSteps.map((s) => s.step)).toEqual([3, 4]);
      expect(r.state.step).toBe(4);
      expect(r.state.stopReason).toBeNull();
      expect(r.state.resumes).toBe(1);
      expect(r.state.updatedAt).toBe(AT);
      expect(r.state.window.map((w) => w.step)).toEqual([3, 4]);
      expect(r.state.window[0]?.notes).toContain(FOLDED_NOTE);
      expect(r.warnings).toEqual([]);
      expect(await readFile(join(runDir, CHECKPOINT_FILES.state), 'utf8')).toBe(before);
      expect(await readFile(join(runDir, CHECKPOINT_FILES.meta), 'utf8')).toBe(beforeMeta);
    }));

  it('recovers from prev when state.json is corrupt and surfaces the warnings', () =>
    withTempDir(async (tmp) => {
      const runsDir = join(tmp, 'runs');
      const { runId, runDir } = await createRunDir(runsDir, new Date('2026-09-19T12:00:00Z'));
      const store = createCheckpointStore(runDir, fakeRedact);
      await store.create(makeMeta({ runId }));
      await store.writeState(makeState({ runId, step: 1 }));
      await store.writeState(makeState({ runId, step: 2 }));
      await store.appendStep(makeStepRecord(1));
      await store.appendStep(makeStepRecord(2));
      await writeFile(join(runDir, CHECKPOINT_FILES.state), '{"version":1,"checksum":"bad","state":{}}');
      const r = await loadForResume(runsDir, runId, { redact: fakeRedact, now });
      expect(r.recoveredFrom).toBe('prev');
      expect(r.checkpointStep).toBe(1);
      // the step that existed only in steps.jsonl reappears in the window; the next step is one higher
      expect(r.foldedSteps.map((s) => s.step)).toEqual([2]);
      expect(r.state.step).toBe(2);
      expect(r.warnings.join(' ')).toMatch(/falling back to state\.prev\.json/);
    }));

  it('maps id and directory failures to ConfigError / CheckpointError', () =>
    withTempDir(async (tmp) => {
      await expect(loadForResume(tmp, 'bogus', { redact: fakeRedact })).rejects.toBeInstanceOf(ConfigError);
      await expect(loadForResume(tmp, '20260919-120000-aaaaaaaa', { redact: fakeRedact })).rejects.toBeInstanceOf(CheckpointError);
      const { runId } = await createRunDir(tmp, new Date('2026-09-19T12:00:00Z'));
      // directory exists but holds no run.json / state.json
      await expect(loadForResume(tmp, runId, { redact: fakeRedact })).rejects.toBeInstanceOf(CheckpointError);
    }));
});

describe('kill wording in the window (§6)', () => {
  it('wall-time kill reads as a budget stop, timeout as a command timeout, abort as a kill', () => {
    const wall = makeWindowEntryFromRecord(
      makeStepRecord(2, {
        outcome: { status: 'interrupted', exec: makeExec({ exitCode: null, signal: 'SIGTERM', killedBy: 'wall_time', ok: false }) },
        interruptedAt: { stage: 'execute', reason: 'wall_time' },
      }),
    );
    expect(wall.outcome).toBe('interrupted');
    expect(wall.notes).toEqual(['stopped by wall-time budget', 'interrupted during execute (wall_time)']);
    const timeout = makeWindowEntryFromRecord(
      makeStepRecord(2, {
        outcome: { status: 'executed', exec: makeExec({ exitCode: null, signal: 'SIGKILL', killedBy: 'timeout', timedOut: true, ok: false }), summary: 's', changedFiles: [] },
      }),
    );
    expect(timeout.outcome).toBe('executed');
    expect(timeout.notes).toEqual(['command timed out']);
  });
});

describe('foldStepsIntoState: lastChangeStep', () => {
  it('advances lastChangeStep for a folded step that changed files so testsCurrent cannot go stale', () => {
    const lastTestRun = { step: 1, command: 'pytest -q', passed: 1, failed: 0, errors: 0, allPassed: true };
    const s = makeState({ step: 1, lastChangeStep: null, lastTestRun });
    const out = foldStepsIntoState(
      s,
      [
        makeStepRecord(2, { outcome: { status: 'executed', summary: 'edited', changedFiles: ['a.py'] } }),
        makeStepRecord(3, { outcome: { status: 'executed', exec: makeExec(), summary: 'ran', changedFiles: [] } }),
      ],
      AT,
    );
    expect(out.lastChangeStep).toBe(2);
    expect(out.lastTestRun).toBe(s.lastTestRun);
    // untouched when no folded step changed anything
    expect(foldStepsIntoState(makeState({ step: 1, lastChangeStep: 1 }), [makeStepRecord(2)], AT).lastChangeStep).toBe(1);
  });
});
