import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALIZER_OPTIONS, LINE_QUESTION_ID, centredWindow, createLocalizer, estimateTokens, fitToCap } from '../../../../../src/jev-modes/synth/localize/index.js';
import { answerAll, scriptedAsk, sf, signal, stateObject, workspace } from './helpers.js';

/** A 5,000-line module: one 4,000-line function plus 250 four-line helpers. */
function hugeSource(): string {
  const out: string[] = ['import math', '', '', 'def giant(values):', '    total = 0'];
  for (let i = 0; i < 3_997; i++) out.push(`    total = total + values[${i % 97}] * ${i}  # step ${i}`);
  out.push('    return total', '', '');
  for (let i = 0; out.length < 5_000; i++) out.push(`def helper_${i}(x):`, `    y = x + ${i}`, `    return y`, '');
  return `${out.join('\n')}\n`;
}

describe('state size under the 32k-token cap', () => {
  it('keeps every state under the cap on a 5,000-line file and never exceeds 254 line options', async () => {
    const big = sf('big.py', hugeSource());
    expect(big.mod.lines.length).toBeGreaterThanOrEqual(5_000);
    const traceback = 'Traceback (most recent call last):\n  File "big.py", line 2000, in giant\n    total = total + values[57] * 1996\nTypeError: bad operand';
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        () => 0.2,
        (id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          if (id === LINE_QUESTION_ID) return { [keys.includes('line_2000') ? 'line_2000' : keys[0]!]: 0.7 };
          return { [keys.includes('giant') ? 'giant' : keys[0]!]: 0.8 };
        },
      ),
    );
    const res = await createLocalizer().localize({ ask, task: 'giant returns the wrong total', files: workspace([big]), failures: [{ testId: 't', call: 'giant([1])', expected: '1', actual: '0' }], traceback, signal: signal(), budget: { maxRequests: 20 } });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(estimateTokens(c.state)).toBeLessThanOrEqual(DEFAULT_LOCALIZER_OPTIONS.stateTokenCap);
      expect(JSON.stringify(c.state).length).toBeLessThan(32_768 * 3);
      for (const q of Object.values(c.questions)) if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(255);
    }
    // the single file has > 254 code lines, so the function stage ran on it, with the module option and <= 254 options
    const fnCall = calls.find((c) => 'file' in stateObject(c) && typeof stateObject(c)['file'] === 'object')!;
    const fq = Object.values(fnCall.questions)[0]!;
    expect(fq.type === 'choice' ? Object.keys(fq.criteria).length : 0).toBeLessThanOrEqual(255);
    expect(fq.type === 'choice' ? 'module_level_code_outside_any_function' in fq.criteria : false).toBe(true);
    // the giant function's listing was cut to the function and centred on the traceback line
    const giantCall = calls.find((c) => stateObject(c)['function'] === 'giant')!;
    const program = stateObject(giantCall)['program'] as Record<string, string>;
    const lines = Object.keys(program).map((k) => Number(k.slice(1)));
    expect(lines.length).toBeLessThanOrEqual(254);
    expect(lines).toContain(2000);
    expect(Math.min(...lines)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...lines)).toBeLessThanOrEqual(4002);
    expect(res.sites[0]!.line).toBe(2000);
    expect(res.sites[0]!.block!.name).toBe('giant');
    expect(res.sites[0]!.evidence.notes).toContain('in traceback');
  });

  it('shrinks a listing whose lines are long until the estimate fits', async () => {
    // 200 lines × 200 kept characters ≈ 40k characters of listing + options: over a 4k-token cap, so levels kick in
    const lines = ['def wide(x):'];
    for (let i = 0; i < 200; i++) lines.push(`    x = x + ${'a'.repeat(300)}${i}`);
    lines.push('    return x');
    const file = sf('wide.py', `${lines.join('\n')}\n`);
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        () => 0.2,
        (_id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          return { [keys[0]!]: 0.9 };
        },
      ),
    );
    await createLocalizer({ stateTokenCap: 4_000 }).localize({ ask, task: 'fix wide', files: workspace([file]), failures: [], traceback: 'x'.repeat(3000), signal: signal(), budget: { maxRequests: 4 } });
    const lineCall = calls.find((c) => LINE_QUESTION_ID in c.questions)!;
    const st = stateObject(lineCall);
    expect(estimateTokens(lineCall.state)).toBeLessThanOrEqual(4_000);
    expect('traceback' in st).toBe(false); // dropped at level 1
    const program = st['program'] as Record<string, string>;
    expect(Object.keys(program).length).toBeLessThan(200);
    for (const text of Object.values(program)) expect(text.length).toBeLessThan(260); // per-line clip with marker
    // options match the surviving listing exactly
    const q = lineCall.questions[LINE_QUESTION_ID]!;
    if (q.type === 'choice') expect(Object.keys(q.criteria).filter((k) => k !== 'none_of_these').map((k) => `L${k.slice(5)}`)).toEqual(Object.keys(program));
  });
});

describe('function Choice over a file with more than 253 defs', () => {
  it('keeps the module-level option and prefers defs named in the traceback and the task', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 300; i++) parts.push(`def f${i}(x):`, `    return x + ${i}`, '');
    const file = sf('many.py', `${parts.join('\n')}\n`);
    const traceback = 'Traceback (most recent call last):\n  File "many.py", line 842, in f280\n    return x + 280\nTypeError: bad';
    const { ask, calls } = scriptedAsk((call) =>
      answerAll(
        call,
        () => 0.2,
        (id, q) => {
          const keys = Object.keys(q.type === 'choice' ? q.criteria : {}).filter((k) => k !== 'none_of_these');
          if (id === LINE_QUESTION_ID) return { [keys[0]!]: 0.7 };
          return { f280: 0.8 };
        },
      ),
    );
    const res = await createLocalizer().localize({ ask, task: 'f150 is wrong', files: workspace([file]), failures: [], traceback, signal: signal(), budget: { maxRequests: 10 } });
    const fnCall = calls.find((c) => typeof stateObject(c)['file'] === 'object')!;
    const q = Object.values(fnCall.questions)[0]!;
    if (q.type !== 'choice') throw new Error('not a choice');
    const keys = Object.keys(q.criteria);
    expect(keys).toHaveLength(255); // 253 defs + module-level + escape
    expect(keys).toContain('module_level_code_outside_any_function');
    expect(keys).toContain('f280'); // traceback frame
    expect(keys).toContain('f150'); // named in the task
    expect(keys).not.toContain('f299'); // the tail of the source order is what gets dropped
    // options stay in source order after the preference cut
    const defs = keys.filter((k) => /^f\d+$/.test(k)).map((k) => Number(k.slice(1)));
    expect([...defs].sort((a, b) => a - b)).toEqual(defs);
    expect(res.functions[0]!.name).toBe('f280');
    expect(res.sites[0]!.block!.name).toBe('f280');
  });
});

describe('budget helpers', () => {
  it('centredWindow keeps the focus line and clips at the ends', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ line: i + 1 }));
    expect(centredWindow(lines, 5, 10).map((l) => l.line)).toEqual([8, 9, 10, 11, 12]);
    expect(centredWindow(lines, 5, 1).map((l) => l.line)).toEqual([1, 2, 3, 4, 5]);
    expect(centredWindow(lines, 5, 20).map((l) => l.line)).toEqual([16, 17, 18, 19, 20]);
    expect(centredWindow(lines, 5, null).map((l) => l.line)).toEqual([9, 10, 11, 12, 13]); // centre index floor(20 / 2) = line 11
    expect(centredWindow(lines, 50, 3)).toHaveLength(20);
    expect(centredWindow(lines, 0, 3)).toEqual([]);
  });

  it('fitToCap returns the first level that fits and the last one otherwise', () => {
    const r = fitToCap(10, (level) => (level > 2 ? null : { pad: 'x'.repeat(60 - level * 25) }));
    expect(r.level).toBe(2);
    expect(r.tokens).toBeLessThanOrEqual(10);
    const last = fitToCap(1, (level) => (level > 1 ? null : { pad: 'x'.repeat(100) }));
    expect(last.level).toBe(1);
    expect(() => fitToCap(1, () => null)).toThrow();
  });
});
