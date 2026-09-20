import { describe, expect, it } from 'vitest';
import { AbortError } from '../../../../src/errors.js';
import { FUNCTION_QUESTION_ID, LINE_QUESTION_ID, MODULE_LEVEL_KEY, createLocalizer } from '../../../../src/synth/localize/index.js';
import { GEOMETRY_FAILURE, GEOMETRY_TRACEBACK, answerAll, scriptedAsk, sf, signal, stateObject, twoFileWorkspace, workspace } from './helpers.js';

const TASK = 'Fix Point.distance in pkg/geometry.py so that test_distance passes.';

/** Scripted Jev that puts pkg/geometry.py, Point.distance and line 17 first at every stage. */
function goldScript() {
  return scriptedAsk((call) =>
    answerAll(
      call,
      (id) => (id === 'pkg/geometry.py' ? 0.91 : 0.04),
      (id, q) => {
        if (id === FUNCTION_QUESTION_ID) {
          const st = stateObject(call);
          const file = st['file'] as { path: string };
          if (file.path === 'pkg/geometry.py') return { point_distance: 0.7, midpoint: 0.1 };
          return { clamp: 0.4 };
        }
        if (id === LINE_QUESTION_ID) {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {});
          if (keys.includes('line_17')) return { line_17: 0.6, line_15: 0.15, line_16: 0.1 };
          if (keys.includes('line_25')) return { line_25: 0.5 };
          return { [keys[0]!]: 0.5 };
        }
        throw new Error(`unexpected question ${id}`);
      },
    ),
  );
}

describe('localizer pipeline on the two-file fixture', () => {
  it('ranks the gold file, function and line first, with the measured request shape', async () => {
    const { ask, calls } = goldScript();
    const res = await createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], traceback: GEOMETRY_TRACEBACK, signal: signal(), budget: { maxRequests: 20 } });

    // two files fit in the beam: stage 1 is skipped, stage 2 confirms with outlines
    const confirm = calls[0]!;
    expect(Object.keys(confirm.questions).sort()).toEqual(['pkg/geometry.py', 'pkg/utils.py']);
    const confirmState = stateObject(confirm);
    expect(confirmState['files']).toEqual({
      'pkg/geometry.py': { top_level_symbols: ['class Point', 'midpoint()', 'clamp_point()'] },
      'pkg/utils.py': { top_level_symbols: ['clamp()', 'mean()'] },
    });
    expect(confirmState['failing_tests']).toEqual([{ test: GEOMETRY_FAILURE.testId, call: GEOMETRY_FAILURE.call, expected: '5.0', actual: 'ValueError: math domain error' }]);
    expect(typeof confirmState['traceback']).toBe('string');
    const q = confirm.questions['pkg/geometry.py']!;
    expect(q.type).toBe('noul');
    expect(q.instructions).toBe('Must the file `files["pkg/geometry.py"]` be modified to accomplish `task`? Answer yes only if the code change that accomplishes the task lands in this file.');

    expect(res.files.map((f) => f.path)).toEqual(['pkg/geometry.py', 'pkg/utils.py']);
    expect(res.files[0]!.probability).toBe(0.91);
    expect(res.files[0]!.outline).toEqual(['class Point', 'midpoint()', 'clamp_point()']);

    // stage 3: one Choice per file (2), options are keys with descriptions in the state
    const fnCalls = calls.filter((c) => FUNCTION_QUESTION_ID in c.questions);
    expect(fnCalls).toHaveLength(2);
    const geo = fnCalls.find((c) => (stateObject(c)['file'] as { path: string }).path === 'pkg/geometry.py')!;
    const fns = (stateObject(geo)['file'] as { functions: Record<string, string> }).functions;
    expect(fns).toEqual({
      point_init: 'method Point.__init__, line 10: def __init__(self, x, y):',
      point_distance: 'method Point.distance, line 14: def distance(self, other):',
      point_meta_describe: 'method Point.Meta.describe, line 20: def describe(self):',
      midpoint: 'function midpoint, line 24: def midpoint(a, b):',
      clamp_point: 'function clamp_point, line 29: def clamp_point(p, lo, hi):',
      [MODULE_LEVEL_KEY]: 'code at module level: imports, constants, tables, class attributes; not inside any function or method',
    });
    const fq = geo.questions[FUNCTION_QUESTION_ID]!;
    expect(fq.type).toBe('choice');
    if (fq.type === 'choice') {
      expect(Object.keys(fq.criteria)).toEqual([...Object.keys(fns), 'none_of_these']);
      expect(Object.values(fq.criteria).every((v) => v === null)).toBe(true);
    }

    expect(res.functions[0]).toMatchObject({ name: 'Point.distance', startLine: 14, endLine: 17, probability: 0.7 });
    expect(res.functions[0]!.file.path).toBe('pkg/geometry.py');
    // ranked by file × function probability: utils.clamp (0.04 × 0.4) sits below geometry's midpoint (0.91 × 0.1)
    expect(res.functions.map((f) => f.name).slice(0, 2)).toEqual(['Point.distance', 'midpoint']);
    expect(res.functions.length).toBeLessThanOrEqual(5);

    // stage 4: line Choice per function with the D state shape, listing cut to the function
    const lineCalls = calls.filter((c) => LINE_QUESTION_ID in c.questions);
    expect(lineCalls.length).toBe(res.functions.length);
    const distanceCall = lineCalls.find((c) => stateObject(c)['function'] === 'Point.distance')!;
    const st = stateObject(distanceCall);
    expect(st['program']).toEqual({ L14: '    def distance(self, other):', L15: '        dx = self.x - other.x', L16: '        dy = self.y - other.y', L17: '        return math.sqrt(dx * dx - dy * dy)' });
    expect(st['file']).toBe('pkg/geometry.py');
    expect(st['tests']).toEqual([{ call: GEOMETRY_FAILURE.call, expected: '5.0' }]);
    expect(st['failing_test_run']).toEqual({ call: GEOMETRY_FAILURE.call, expected: '5.0', actual: 'ValueError: math domain error' });
    expect(st['task']).toBe(`${TASK} \`failing_test_run\` shows what the buggy program actually did on one failing test.`);
    expect(distanceCall.questions[LINE_QUESTION_ID]!.instructions).toBe('Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty.');

    // sites: the gold line is the first site; its evidence carries the Choice p and the traceback note
    const first = res.sites[0]!;
    expect(first).toMatchObject({ line: 17, kind: 'replace', currentLine: '        return math.sqrt(dx * dx - dy * dy)', indent: '        ' });
    expect(first.file.path).toBe('pkg/geometry.py');
    expect(first.block).toEqual({ name: 'Point.distance', startLine: 14, endLine: 17 });
    expect(first.evidence.jevProbability).toBe(0.6);
    expect(first.evidence.notes).toContain('in traceback');
    expect(first.evidence.notes).toContain('jev anchor #1 in Point.distance');
    expect(first.scope.params).toEqual(['self', 'other']);
    expect(first.scope.locals).toEqual(expect.arrayContaining(['dx', 'dy']));

    // request count: 1 confirm + 2 functions + N lines
    expect(res.requests).toBe(1 + 2 + res.functions.length);
    expect(res.requests).toBe(calls.length);
    for (const c of calls) expect(c.stage).toBe('context');
  });

  it('runs the batched file stage when the workspace exceeds the file beam and consumes by rank', async () => {
    const files = [sf('pkg/geometry.py', twoFileWorkspace().get('pkg/geometry.py')!.src), sf('pkg/utils.py', twoFileWorkspace().get('pkg/utils.py')!.src)];
    for (let i = 0; i < 8; i++) files.push(sf(`extra/mod${i}.py`, `def f${i}(x):\n    return x + ${i}\n`));
    const probs: Record<string, number> = { 'pkg/geometry.py': 0.35, 'extra/mod3.py': 0.3, 'pkg/utils.py': 0.2, 'extra/mod1.py': 0.1, 'extra/mod7.py': 0.08, 'extra/mod0.py': 0.07 };
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        (id) => probs[id] ?? 0.01,
        (_id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these' && k !== MODULE_LEVEL_KEY);
          return { [keys[0]!]: 0.8 };
        },
      ),
    );
    const res = await createLocalizer().localize({ ask, task: TASK, files: workspace(files), failures: [GEOMETRY_FAILURE], signal: signal(), budget: { maxRequests: 30 } });
    const stage1 = calls[0]!;
    expect(Object.keys(stage1.questions)).toHaveLength(10);
    const st = stateObject(stage1);
    expect(st['files']).toEqual(Object.keys(stage1.questions));
    expect(st['criteria']).toHaveProperty('yes_when');
    expect(stage1.questions['pkg/utils.py']).toEqual({ type: 'noul', instructions: 'Must the file `pkg/utils.py` (listed in `files`) be modified to accomplish `task`? Apply `criteria`.' });
    // beam of 5 by rank even though only 3 files exceed 0.5 - never by threshold
    const confirm = calls[1]!;
    expect(Object.keys(confirm.questions)).toEqual(['pkg/geometry.py', 'extra/mod3.py', 'pkg/utils.py', 'extra/mod1.py', 'extra/mod7.py']);
    expect(res.files).toHaveLength(5);
    // stage 3 asked one Choice per beam file, stage 4 one per function in the beam
    expect(calls.filter((c) => FUNCTION_QUESTION_ID in c.questions)).toHaveLength(5);
    expect(res.functions).toHaveLength(5);
    expect(res.requests).toBe(1 + 1 + 5 + 5);
  });

  it('shrinks beams to stay inside the request budget', async () => {
    const { ask, calls } = goldScript();
    const res = await createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], signal: signal(), budget: { maxRequests: 3 } });
    // 1 confirm + 1 function Choice (one file, keeping one for lines) + 1 line Choice
    expect(res.requests).toBe(3);
    expect(calls).toHaveLength(3);
    expect(res.functions[0]!.name).toBe('Point.distance');
    expect(res.sites[0]!.line).toBe(17);
  });

  it('asks nothing when the budget is zero and reports zero requests', async () => {
    const { ask, calls } = goldScript();
    const res = await createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [], signal: signal(), budget: { maxRequests: 0 } });
    expect(calls).toHaveLength(0);
    expect(res.requests).toBe(0);
    expect(res.sites).toEqual([]);
    expect(res.files.map((f) => f.path)).toEqual(['pkg/geometry.py', 'pkg/utils.py']);
  });

  it('honours the abort signal before asking', async () => {
    const { ask, calls } = goldScript();
    const c = new AbortController();
    c.abort();
    await expect(createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [], signal: c.signal, budget: { maxRequests: 9 } })).rejects.toBeInstanceOf(AbortError);
    expect(calls).toHaveLength(0);
  });

  it('returns an empty result for an empty workspace', async () => {
    const { ask } = goldScript();
    const res = await createLocalizer().localize({ ask, task: TASK, files: new Map(), failures: [], signal: signal(), budget: { maxRequests: 9 } });
    expect(res).toEqual({ files: [], functions: [], sites: [], requests: 0 });
  });

  it('falls through a confident none_of_these on the function Choice instead of stopping', async () => {
    const { ask } = scriptedAsk((call) =>
      answerAll(
        call,
        (id) => (id === 'pkg/geometry.py' ? 0.8 : 0.1),
        (id, q) => {
          if (id === FUNCTION_QUESTION_ID) return { none_of_these: 0.7, ...(Object.keys(q.type === 'choice' ? q.criteria : {}).includes('point_distance') ? { point_distance: 0.2 } : { clamp: 0.2 }) };
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          return { [keys[keys.length - 1]!]: 0.5 };
        },
      ),
    );
    const res = await createLocalizer().localize({ ask, task: TASK, files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], signal: signal(), budget: { maxRequests: 20 } });
    expect(res.functions[0]!.name).toBe('Point.distance');
    expect(res.sites.length).toBeGreaterThan(0);
  });
});
