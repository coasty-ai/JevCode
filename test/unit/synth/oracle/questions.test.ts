import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Answer } from '../../../../src/core/types.js';
import { ESCAPE_KEY, choice } from '../../../../src/jev/questions.js';
import { extractBlocks } from '../../../../src/synth/oracle/extract.js';
import { FAILURE_KINDS, FAILURE_KIND_ID, MAX_FRAMES, chooseBlocks, framesToOffer, isRunnable, oracleQuestions, readOracleAnswers } from '../../../../src/synth/oracle/questions.js';
import type { Extraction } from '../../../../src/synth/oracle/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (id: string): string => readFileSync(join(here, `../../../fixtures/synth/oracle/${id}.md`), 'utf8');

const sympy17139 = extractBlocks(fixture('sympy__sympy-17139'));
const sympy20428Like: Extraction = {
  blocks: [
    { index: 0, kind: 'repl', origin: 'fence', lang: null, text: '>>> x = 1\n>>> x\n1', startLine: 1, endLine: 3, tracebacks: [], repl: { prompt: 'python', statements: [{ source: 'x = 1', shown: null, traceback: null }, { source: 'x', shown: '1', traceback: null }] } },
    { index: 1, kind: 'output', origin: 'fence', lang: null, text: 'Poly(0, x)', startLine: 5, endLine: 5, tracebacks: [] },
    { index: 2, kind: 'traceback', origin: 'fence', lang: null, text: 'Traceback…', startLine: 7, endLine: 9, tracebacks: [{ frames: [{ file: 'a.py', line: 1, fn: 'f', code: null }], exceptionType: 'IndexError', message: 'x', style: 'python' }] },
  ],
  tracebacks: [{ frames: [{ file: 'a.py', line: 1, fn: 'f', code: null }], exceptionType: 'IndexError', message: 'x', style: 'python' }],
  expectations: [],
};

describe('oracleQuestions', () => {
  const set = oracleQuestions({ repository: 'sympy/sympy', problemStatement: fixture('sympy__sympy-17139'), extraction: sympy17139 });

  it('one request: three Nouls per block, the failure_kind Choice with the escape, one Noul per offered frame', () => {
    const ids = Object.keys(set.questions);
    expect(ids).toContain('is_reproduction_0');
    expect(ids).toContain('shows_expected_0');
    expect(ids).toContain('shows_actual_0');
    expect(ids).toContain(FAILURE_KIND_ID);
    const kind = set.questions[FAILURE_KIND_ID]!;
    expect(kind.type).toBe('choice');
    if (kind.type === 'choice') {
      expect(Object.keys(kind.criteria)).toEqual([...Object.keys(FAILURE_KINDS)]);
      expect(kind.criteria).toHaveProperty(ESCAPE_KEY);
    }
    // sympy-17139's traceback has 16 frames; `<stdin>` is dropped and two (file, function) repeats (bottom_up, <lambda>) folded, so 13 are offered
    expect(set.frames).toHaveLength(13);
    expect(ids.filter((i) => i.startsWith('frame_in_fix_'))).toHaveLength(13);
    for (const [id, q] of Object.entries(set.questions)) if (id !== FAILURE_KIND_ID) expect(q.type, id).toBe('noul');
  });

  it('every Noul carries definition + two examples on both sides (the builders would have thrown otherwise)', () => {
    for (const [id, q] of Object.entries(set.questions)) {
      if (q.type !== 'noul') continue;
      const c = q.criteria as { true: { definition: string; examples: string[] }; false: { definition: string; examples: string[] } };
      expect(c.true.definition.length, id).toBeGreaterThan(10);
      expect(c.true.examples.length, id).toBeGreaterThanOrEqual(2);
      expect(c.false.examples.length, id).toBeGreaterThanOrEqual(2);
    }
  });

  it('the state carries the issue, every block with its statements, and the frames the questions reference', () => {
    const state = set.state as { issue: { repository: string; problem_statement: string }; blocks: Record<string, { kind: string; statements?: unknown[]; exceptions?: string[] }>; frames: Record<string, { file: string; line: number; function: string }> };
    expect(state.issue.repository).toBe('sympy/sympy');
    expect(state.blocks['block_0']?.kind).toBe('repl');
    expect(state.blocks['block_0']?.statements).toHaveLength(3);
    expect(state.blocks['block_0']?.exceptions).toEqual(['TypeError: Invalid comparison of complex I']);
    expect(state.frames['frame_12']).toMatchObject({ file: '/home/e/se/sympy/core/expr.py', line: 406, function: '__lt__' });
    for (const q of Object.values(set.questions)) {
      const m = /`(blocks\.block_\d+|frames\.frame_\d+)`/.exec(String(q.instructions));
      if (m === null) continue;
      const [group, key] = (m[1] ?? '').split('.') as [string, string];
      expect((state as unknown as Record<string, Record<string, unknown>>)[group]).toHaveProperty(key);
    }
  });

  it('FAILURE_KINDS are valid descriptive option keys', () => {
    expect(() => choice('which?', FAILURE_KINDS)).not.toThrow();
  });
});

describe('framesToOffer', () => {
  it('drops REPL frames, folds duplicate (file, function) frames and caps at MAX_FRAMES keeping the innermost', () => {
    const frames = framesToOffer(sympy17139);
    expect(frames.some((f) => f.file === '<stdin>')).toBe(false);
    const keys = frames.map((f) => `${f.file}::${f.fn ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    const many: Extraction = { blocks: [], expectations: [], tracebacks: [{ frames: Array.from({ length: 40 }, (_, i) => ({ file: `f${i}.py`, line: i, fn: `g${i}`, code: null })), exceptionType: 'E', message: '', style: 'python' }] };
    const capped = framesToOffer(many);
    expect(capped).toHaveLength(MAX_FRAMES);
    expect(capped.at(-1)?.file).toBe('f39.py');
  });
});

describe('readOracleAnswers + chooseBlocks', () => {
  const set = oracleQuestions({ repository: 'sympy/sympy', problemStatement: 'x', extraction: sympy20428Like });

  it('reads the probabilities back, picks the runnable block over the threshold and the expected/actual blocks', () => {
    const answers: Record<string, Answer> = {
      is_reproduction_0: { type: 'noul', noul: 0.91 },
      shows_expected_0: { type: 'noul', noul: 0.2 },
      shows_actual_0: { type: 'noul', noul: 0.7 },
      is_reproduction_1: { type: 'noul', noul: 0.95 }, // an output block: not runnable, never the reproduction
      shows_expected_1: { type: 'noul', noul: 0.8 },
      shows_actual_1: { type: 'noul', noul: 0.1 },
      is_reproduction_2: { type: 'noul', noul: 0.3 },
      shows_expected_2: { type: 'noul', noul: 0.05 },
      shows_actual_2: { type: 'noul', noul: 0.9 },
      [FAILURE_KIND_ID]: { type: 'choice', choice: 'wrong_value', probabilities: { wrong_value: 0.6, exception_raised: 0.3, none_of_these: 0.1 }, confidence: 0.5 },
      frame_in_fix_0: { type: 'noul', noul: 0.66 },
    };
    const j = readOracleAnswers(set, answers);
    expect(j.blocks.map((b) => b.isReproduction)).toEqual([0.91, 0.95, 0.3]);
    expect(j.failureKind).toBe('wrong_value');
    expect(j.frames[0]).toMatchObject({ inFix: 0.66, frame: { file: 'a.py' } });
    expect(j.requests).toBe(1);
    const c = chooseBlocks(sympy20428Like, j);
    expect(c.reproduction?.index).toBe(0);
    expect(c.expected?.index).toBe(1);
    expect(c.actual?.index).toBe(2);
    expect(c.anchors.map((a) => a.frame.file)).toEqual(['a.py']);
  });

  it('tied reproduction candidates: the one whose last statement shares identifiers with the expected block wins', () => {
    const b0 = { index: 0, kind: 'repl' as const, origin: 'fence' as const, lang: null, text: '', startLine: 1, endLine: 1, tracebacks: [], repl: { prompt: 'python' as const, statements: [{ source: 'bad_poly.is_zero', shown: 'False', traceback: null }] } };
    const b1 = { index: 1, kind: 'repl' as const, origin: 'fence' as const, lang: null, text: '', startLine: 2, endLine: 2, tracebacks: [], repl: { prompt: 'python' as const, statements: [{ source: 'bad_poly.rep', shown: 'DMP([EX(0)], EX, None)', traceback: null }] } };
    const b2 = { index: 2, kind: 'repl' as const, origin: 'fence' as const, lang: null, text: '', startLine: 3, endLine: 3, tracebacks: [], repl: { prompt: 'python' as const, statements: [{ source: 'Poly(0, x, domain="EX").rep', shown: 'DMP([], EX, None)', traceback: null }] } };
    const ex: Extraction = { blocks: [b0, b1, b2], tracebacks: [], expectations: [] };
    const s2 = oracleQuestions({ repository: 'sympy/sympy', problemStatement: 'x', extraction: ex });
    const j = readOracleAnswers(s2, {
      is_reproduction_0: { type: 'noul', noul: 0.93 }, shows_expected_0: { type: 'noul', noul: 0.1 }, shows_actual_0: { type: 'noul', noul: 0.9 },
      is_reproduction_1: { type: 'noul', noul: 0.9 }, shows_expected_1: { type: 'noul', noul: 0.1 }, shows_actual_1: { type: 'noul', noul: 0.9 },
      is_reproduction_2: { type: 'noul', noul: 0.4 }, shows_expected_2: { type: 'noul', noul: 0.95 }, shows_actual_2: { type: 'noul', noul: 0.1 },
      [FAILURE_KIND_ID]: { type: 'choice', choice: 'wrong_value', probabilities: { wrong_value: 1 }, confidence: 1 },
    });
    const c = chooseBlocks(ex, j);
    expect(c.expected?.index).toBe(2);
    expect(c.reproduction?.index).toBe(1);
    // outside the tie band the higher probability wins regardless of similarity
    j.blocks[0]!.isReproduction = 0.99;
    expect(chooseBlocks(ex, j).reproduction?.index).toBe(0);
  });

  it('a test module is never the reproduction even at p 0.99 (it needs a pytest command oracle)', () => {
    const testFile = { index: 0, kind: 'code' as const, origin: 'fence' as const, lang: 'python', text: 'import pytest\n\n@pytest.mark.parametrize("d", [b"x"])\ndef test_data(d):\n    pass', startLine: 1, endLine: 5, tracebacks: [] };
    expect(isRunnable(testFile)).toBe(false);
    const ex: Extraction = { blocks: [testFile], tracebacks: [], expectations: [] };
    const s2 = oracleQuestions({ repository: 'pytest-dev/pytest', problemStatement: 'x', extraction: ex });
    const j = readOracleAnswers(s2, { is_reproduction_0: { type: 'noul', noul: 0.99 }, shows_expected_0: { type: 'noul', noul: 0 }, shows_actual_0: { type: 'noul', noul: 0 }, [FAILURE_KIND_ID]: { type: 'choice', choice: 'exception_raised', probabilities: { exception_raised: 1 }, confidence: 1 } });
    expect(chooseBlocks(ex, j).reproduction).toBeNull();
  });

  it('missing answers read as 0 and an unknown kind as the escape; nothing over the threshold means null picks', () => {
    const j = readOracleAnswers(set, { [FAILURE_KIND_ID]: { type: 'choice', choice: 'made_up', probabilities: { made_up: 1 }, confidence: 1 } });
    expect(j.failureKind).toBe('none_of_these');
    const c = chooseBlocks(sympy20428Like, j);
    expect(c.reproduction).toBeNull();
    expect(c.expected).toBeNull();
    expect(c.anchors).toEqual([]);
  });
});
