import { describe, expect, it } from 'vitest';
import { FUNCTION_QUESTION_ID, LINE_QUESTION_ID, createLocalizer } from '../../../../../src/jev-modes/synth/localize/index.js';
import type { SourceFile } from '../../../../../src/jev-modes/synth/types.js';
import { answerAll, scriptedAsk, sf, signal, stateObject, workspace } from './helpers.js';

function bigWorkspace(n: number): { files: ReadonlyMap<string, SourceFile>; paths: string[] } {
  const list: SourceFile[] = [];
  for (let i = 0; i < n; i++) list.push(sf(`lib/pkg${Math.floor(i / 50)}/mod${String(i).padStart(3, '0')}.py`, `def f${i}(x):\n    return x * ${i}\n`));
  return { files: workspace(list), paths: list.map((f) => f.path) };
}

describe('file stage: batched Nouls over every path', () => {
  it('splits 600 paths into three concurrent requests of <= 250 and ranks the union by probability', async () => {
    const { files, paths } = bigWorkspace(600);
    const gold = 'lib/pkg11/mod599.py';
    let inFlight = 0;
    let maxInFlight = 0;
    const { ask: inner, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        (id) => (id === gold ? 0.93 : id === 'lib/pkg0/mod000.py' ? 0.5 : 0.02),
        (_id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          return { [keys[0]!]: 0.9 };
        },
      ),
    );
    const ask: typeof inner = async (stage, state, questions) => {
      // count only the file-stage requests (those whose state lists `files` as an array)
      const isFileStage = typeof state === 'object' && state !== null && !Array.isArray(state) && Array.isArray(state['files']);
      if (isFileStage) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await inner(stage, state, questions);
      } finally {
        if (isFileStage) inFlight -= 1;
      }
    };
    const res = await createLocalizer().localize({ ask, task: 'fix mod599', files, failures: [], signal: signal(), budget: { maxRequests: 40 } });
    const stage1 = calls.filter((c) => Array.isArray(stateObject(c)['files']));
    expect(stage1).toHaveLength(3);
    expect(stage1.map((c) => Object.keys(c.questions).length).sort((a, b) => a - b)).toEqual([100, 250, 250]);
    expect(maxInFlight).toBe(3);
    const asked = new Set(stage1.flatMap((c) => Object.keys(c.questions)));
    expect(asked.size).toBe(paths.length);
    // every question id is the path itself; the state lists the same paths
    for (const c of stage1) expect(stateObject(c)['files']).toEqual(Object.keys(c.questions));
    expect(res.files[0]!.path).toBe(gold);
    expect(res.files).toHaveLength(5);
    expect(res.requests).toBe(3 + 1 + 5 + calls.filter((c) => LINE_QUESTION_ID in c.questions).length);
  });

  it('puts traceback-named and task-named paths in the first chunk so a tight budget still sees them', async () => {
    const { files } = bigWorkspace(600);
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        () => 0.1,
        (_id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          return { [keys[0]!]: 0.9 };
        },
      ),
    );
    const traceback = 'Traceback (most recent call last):\n  File "/repo/lib/pkg7/mod377.py", line 2, in f377\n    return x * 377\nTypeError: bad';
    // budget 4: one chunk (the other two are dropped), confirm, one function Choice, one line Choice
    await createLocalizer().localize({ ask, task: 'mod123 returns the wrong value', files, failures: [], traceback, signal: signal(), budget: { maxRequests: 4 } });
    const stage1 = calls.filter((c) => Array.isArray(stateObject(c)['files']));
    expect(stage1).toHaveLength(1);
    const listed = stateObject(stage1[0]!)['files'] as string[];
    expect(listed[0]).toBe('lib/pkg7/mod377.py');
    expect(listed[1]).toBe('lib/pkg2/mod123.py');
    expect(listed).toHaveLength(250);
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => FUNCTION_QUESTION_ID in c.questions)).toHaveLength(1);
    expect(calls.filter((c) => LINE_QUESTION_ID in c.questions)).toHaveLength(1);
  });

  it('caps every Noul state well under the token cap for 250 paths', async () => {
    const { files } = bigWorkspace(250 * 2);
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        () => 0.1,
        (_id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          return { [keys[0]!]: 0.9 };
        },
      ),
    );
    await createLocalizer().localize({ ask, task: 'x'.repeat(20_000), files, failures: [], signal: signal(), budget: { maxRequests: 40 } });
    for (const c of calls) {
      const st = stateObject(c);
      // the task is clipped to 6k characters everywhere
      expect((st['task'] as string).length).toBeLessThan(6_100);
      expect(JSON.stringify(c.state).length / 3).toBeLessThan(28_000);
    }
  });
});
