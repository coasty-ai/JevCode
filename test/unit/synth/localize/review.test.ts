/**
 * Review tests: determinism under concurrent completion, budget-starved paths, and the caps
 * measured as the wire measures them (state plus the longest question).
 */
import { describe, expect, it } from 'vitest';
import type { Question } from '../../../../src/core/types.js';
import { AbortError } from '../../../../src/errors.js';
import { DEFAULT_LOCALIZER_OPTIONS, FUNCTION_QUESTION_ID, LINE_QUESTION_ID, MODULE_LEVEL_KEY, MODULE_LEVEL_NAME, createLocalizer, estimateRequestTokens, estimateTokens } from '../../../../src/synth/localize/index.js';
import type { RankedLine } from '../../../../src/synth/sbfl/types.js';
import type { JevAsk, SourceFile } from '../../../../src/synth/types.js';
import { GEOMETRY_FAILURE, GEOMETRY_TRACEBACK, answerAll, scriptedAsk, sf, signal, stateObject, twoFileWorkspace, workspace } from './helpers.js';

function bigWorkspace(n: number): { files: ReadonlyMap<string, SourceFile>; paths: string[] } {
  const list: SourceFile[] = [];
  for (let i = 0; i < n; i++) list.push(sf(`lib/pkg${Math.floor(i / 50)}/mod${String(i).padStart(3, '0')}.py`, `def f${i}(x):\n    return x * ${i}\n`));
  return { files: workspace(list), paths: list.map((f) => f.path) };
}

function pickFirst(_id: string, q: Question): Record<string, number> {
  const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
  return { [keys[0]!]: 0.9 };
}

function kindOf(call: { state: unknown; questions: Record<string, Question> }): 'files' | 'confirm' | 'functions' | 'lines' {
  const st = call.state as Record<string, unknown>;
  if (Array.isArray(st['files'])) return 'files';
  if (FUNCTION_QUESTION_ID in call.questions) return 'functions';
  if (LINE_QUESTION_ID in call.questions) return 'lines';
  return 'confirm';
}

/** Delay each call so requests of `kind` complete in reverse order of issue. */
function reordering(inner: JevAsk, kind: ReturnType<typeof kindOf>, reverse: boolean): JevAsk {
  let issued = 0;
  return async (stage, state, questions) => {
    if (kindOf({ state, questions }) === kind) {
      const i = issued++;
      await new Promise((r) => setTimeout(r, reverse ? Math.max(0, 6 - i) * 8 : i * 8));
    }
    return inner(stage, state, questions);
  };
}

describe('determinism under concurrent completion order', () => {
  it('breaks file-stage ties by mention order, not by which chunk answered first', async () => {
    const { files } = bigWorkspace(600);
    const run = async (reverse: boolean): Promise<string[]> => {
      const { ask } = scriptedAsk((call) => answerAll(call, (id) => (id === 'lib/pkg11/mod599.py' ? 0.93 : 0.02), pickFirst));
      const res = await createLocalizer().localize({ ask: reordering(ask, 'files', reverse), task: 'fix', files, failures: [], signal: signal(), budget: { maxRequests: 40 } });
      return res.files.map((f) => f.path);
    };
    const forward = await run(false);
    const backward = await run(true);
    expect(forward[0]).toBe('lib/pkg11/mod599.py');
    expect(backward).toEqual(forward);
    // ties at 0.02 resolve to the alphabetically first paths (no traceback or task mention here)
    expect(forward.slice(1)).toEqual(['lib/pkg0/mod000.py', 'lib/pkg0/mod001.py', 'lib/pkg0/mod002.py', 'lib/pkg0/mod003.py']);
  });

  it('ranks tied functions and lines in beam order regardless of completion order', async () => {
    const run = async (reverse: boolean): Promise<string[]> => {
      const { ask } = scriptedAsk((call) => answerAll(call, () => 0.5, pickFirst)); // every file, function and line tied
      let a: JevAsk = reordering(ask, 'functions', reverse);
      a = reordering(a, 'lines', reverse);
      const res = await createLocalizer().localize({ ask: a, task: 'fix', files: twoFileWorkspace(), failures: [], signal: signal(), budget: { maxRequests: 20 } });
      return [...res.functions.map((f) => `fn:${f.file.path}:${f.name}`), ...res.sites.map((s) => `${s.file.path}:${s.line}:${s.kind}`)];
    };
    const forward = await run(false);
    const backward = await run(true);
    expect(backward).toEqual(forward);
  });
});

describe('budget-starved paths', () => {
  it('budget 3 on 600 files spends it on one file chunk, one function Choice and one line Choice', async () => {
    const { files } = bigWorkspace(600);
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, pickFirst));
    const res = await createLocalizer().localize({ ask, task: 'fix', files, failures: [], signal: signal(), budget: { maxRequests: 3 } });
    expect(calls.map(kindOf)).toEqual(['files', 'functions', 'lines']);
    expect(Object.keys(calls[0]!.questions)).toHaveLength(250);
    expect(res.requests).toBe(3);
    expect(res.files).toHaveLength(5);
  });

  it('budget 2 on 600 files never asks a confirm over the whole workspace: the beam is cut by mention order', async () => {
    const { files } = bigWorkspace(600);
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, pickFirst));
    const traceback = 'Traceback (most recent call last):\n  File "/repo/lib/pkg7/mod377.py", line 2, in f377\n    return x * 377\nTypeError: bad';
    const res = await createLocalizer().localize({ ask, task: 'mod123 is wrong', files, failures: [], traceback, signal: signal(), budget: { maxRequests: 2 } });
    expect(calls.map(kindOf)).toEqual(['functions', 'lines']);
    for (const c of calls) expect(Object.keys(c.questions).length).toBeLessThanOrEqual(5);
    expect(res.files).toHaveLength(5);
    expect(res.files.slice(0, 2).map((f) => f.path)).toEqual(['lib/pkg7/mod377.py', 'lib/pkg2/mod123.py']);
    expect(res.functions[0]!.name).toBe('f377');
    expect(res.sites[0]!.file.path).toBe('lib/pkg7/mod377.py');
  });

  it('budget 1 on a multi-file workspace still asks one line Choice in the traceback function', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, () => ({ line_17: 0.8 })));
    const res = await createLocalizer().localize({ ask, task: 'fix', files: twoFileWorkspace(), failures: [GEOMETRY_FAILURE], traceback: GEOMETRY_TRACEBACK, signal: signal(), budget: { maxRequests: 1 } });
    expect(calls.map(kindOf)).toEqual(['lines']);
    expect(stateObject(calls[0]!)['function']).toBe('Point.distance');
    expect(res.requests).toBe(1);
    expect(res.functions.map((f) => f.name)).toEqual(['Point.distance']);
    expect(res.sites[0]).toMatchObject({ line: 17, kind: 'replace' });
    expect(res.sites[0]!.evidence.jevProbability).toBe(0.8);
  });

  it('budget 1 without a traceback falls back to the best SBFL line to pick the function', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, () => ({ line_13: 0.6 })));
    const row = (file: string, line: number, rank: number): RankedLine => ({ rank, file, line, ef: 1, ep: 0, score: 1 / rank, scores: { ochiai: 1 / rank, tarantula: 0, dstar: 0 } });
    const sbfl = [row('pkg/utils.py', 13, 1), row('pkg/geometry.py', 17, 2)];
    const res = await createLocalizer().localize({ ask, task: 'fix', files: twoFileWorkspace(), failures: [], sbfl, signal: signal(), budget: { maxRequests: 1 } });
    expect(calls.map(kindOf)).toEqual(['lines']);
    expect(stateObject(calls[0]!)['file']).toBe('pkg/utils.py');
    expect(stateObject(calls[0]!)['function']).toBe('mean');
    // the beam lists both SBFL-named functions by rank; only the first was affordable to ask
    expect(res.functions.map((f) => f.name)).toEqual(['mean', 'Point.distance']);
    // the Jev anchor first, then the SBFL union brings geometry:17 in as an anchor without a Choice probability
    expect(res.sites[0]).toMatchObject({ line: 13, kind: 'replace' });
    const g17 = res.sites.find((s) => s.file.path === 'pkg/geometry.py' && s.line === 17 && s.kind === 'replace')!;
    expect(g17.evidence).toEqual({ sbflRank: 2, sbflScore: 0.5, notes: ['sbfl rank 2'] });
  });

  it('budget 1 with no traceback and no SBFL asks nothing rather than guessing a function', async () => {
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, pickFirst));
    const res = await createLocalizer().localize({ ask, task: 'fix', files: twoFileWorkspace(), failures: [], signal: signal(), budget: { maxRequests: 1 } });
    expect(calls).toHaveLength(0);
    expect(res.requests).toBe(0);
    expect(res.sites).toEqual([]);
  });

  it('a one-file beam is not confirmed: a file with more than 254 code lines goes straight to the function Choice', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 300; i++) parts.push(`def f${i}(x):`, `    return x + ${i}`, '');
    const file = sf('many.py', `${parts.join('\n')}\n`);
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, pickFirst));
    const res = await createLocalizer().localize({ ask, task: 'fix', files: workspace([file]), failures: [], signal: signal(), budget: { maxRequests: 10 } });
    expect(calls.map(kindOf)).toEqual(['functions', 'lines', 'lines', 'lines', 'lines', 'lines']);
    expect(res.files).toEqual([{ path: 'many.py', probability: 1 }]);
  });

  it('a beam file without any def costs no function Choice and yields its module-level entry', async () => {
    const consts = sf('pkg/consts.py', 'LIMIT = 10\nNAMES = ["a", "b"]\n');
    const files = workspace([...twoFileWorkspace().values(), consts]);
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        (id) => (id === 'pkg/consts.py' ? 0.9 : id === 'pkg/geometry.py' ? 0.6 : 0.1),
        (id, q) => (id === FUNCTION_QUESTION_ID && Object.keys(q.type === 'choice' ? q.criteria : {}).includes('point_distance') ? { point_distance: 0.5 } : pickFirst(id, q)),
      ),
    );
    const res = await createLocalizer().localize({ ask, task: 'fix', files, failures: [], signal: signal(), budget: { maxRequests: 20 } });
    const fnCalls = calls.filter((c) => kindOf(c) === 'functions');
    expect(fnCalls.map((c) => (stateObject(c)['file'] as { path: string }).path).sort()).toEqual(['pkg/geometry.py', 'pkg/utils.py']);
    expect(res.functions[0]).toMatchObject({ name: MODULE_LEVEL_NAME, startLine: 1, endLine: 2, probability: 1 });
    expect(res.functions[0]!.file.path).toBe('pkg/consts.py');
    // the module-level listing was asked as a line Choice and produced a null-block site
    const consts_lines = calls.find((c) => kindOf(c) === 'lines' && stateObject(c)['file'] === 'pkg/consts.py')!;
    expect(stateObject(consts_lines)['function']).toBe(MODULE_LEVEL_NAME);
    expect(res.sites.find((s) => s.file.path === 'pkg/consts.py')!.block).toBeNull();
  });
});

describe('abort handling', () => {
  it('rejects with AbortError when the signal fires between requests and issues nothing further', async () => {
    const controller = new AbortController();
    const { ask: inner, calls } = scriptedAsk((call) => answerAll(call, (id) => (id === 'pkg/geometry.py' ? 0.9 : 0.1), pickFirst));
    const ask: JevAsk = async (stage, state, questions) => {
      const r = await inner(stage, state, questions);
      controller.abort(); // abort as soon as the first answer lands
      return r;
    };
    await expect(createLocalizer().localize({ ask, task: 'fix', files: twoFileWorkspace(), failures: [], signal: controller.signal, budget: { maxRequests: 20 } })).rejects.toBeInstanceOf(AbortError);
    expect(calls).toHaveLength(1); // the confirm request only; the function stage checked the signal first
  });
});

describe('caps measured as the wire measures them', () => {
  it('function Choice with 253 long-named methods is cut until state + question fit the cap, keeping the module option', async () => {
    const parts: string[] = [`class ${'VeryLongClassName'.repeat(4)}:`];
    for (let i = 0; i < 253; i++) parts.push(`    def ${'extremely_long_method_name_segment_'.repeat(3)}${i}(self, ${Array.from({ length: 12 }, (_, k) => `argument_number_${k}`).join(', ')}):`, `        return ${i}`, '');
    const file = sf('m.py', `${parts.join('\n')}\n`);
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, pickFirst));
    await createLocalizer().localize({ ask, task: 'x'.repeat(6000), files: workspace([file]), failures: [], signal: signal(), budget: { maxRequests: 10 } });
    const fn = calls.find((c) => kindOf(c) === 'functions')!;
    expect(estimateRequestTokens(fn.state, fn.questions)).toBeLessThanOrEqual(DEFAULT_LOCALIZER_OPTIONS.stateTokenCap);
    const q = fn.questions[FUNCTION_QUESTION_ID]!;
    const keys = Object.keys(q.type === 'choice' ? q.criteria : {});
    expect(keys.length).toBeLessThan(255);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(keys).toContain(MODULE_LEVEL_KEY);
    expect(keys).toContain('none_of_these');
  });

  it('line Choice over 254 lines of 200 characters fits state + question under the cap and keeps the traceback line', async () => {
    const lines = ['def wide(values):'];
    for (let i = 0; i < 300; i++) lines.push(`    values = values + [${'7, '.repeat(60)}${i}]`);
    lines.push('    return values');
    const file = sf('wide.py', `${lines.join('\n')}\n`);
    const traceback = 'Traceback (most recent call last):\n  File "wide.py", line 40, in wide\n    values = values + [7]\nTypeError: bad';
    const { ask, calls } = scriptedAsk((call) => answerAll(call, () => 0.1, (_id, q) => (Object.keys(q.type === 'choice' ? q.criteria : {}).includes('line_40') ? { line_40: 0.7 } : pickFirst(_id, q))));
    const res = await createLocalizer().localize({ ask, task: 'wide is wrong', files: workspace([file]), failures: [GEOMETRY_FAILURE], traceback, signal: signal(), budget: { maxRequests: 10 } });
    const line = calls.find((c) => kindOf(c) === 'lines')!;
    // state alone is well under the cap, but the options repeat the listing: the request estimate is what is bounded
    expect(estimateTokens(line.state)).toBeLessThan(DEFAULT_LOCALIZER_OPTIONS.stateTokenCap);
    expect(estimateRequestTokens(line.state, line.questions)).toBeLessThanOrEqual(DEFAULT_LOCALIZER_OPTIONS.stateTokenCap);
    const program = stateObject(line)['program'] as Record<string, string>;
    expect(Object.keys(program)).toContain('L40');
    expect(Object.keys(program).length).toBeLessThan(254);
    expect(res.sites[0]!.line).toBe(40);
  });
});
