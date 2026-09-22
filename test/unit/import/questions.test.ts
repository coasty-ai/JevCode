/**
 * src/import/questions.ts (IMPORT-DESIGN §4.4.3 the five groups, §4.4.4 cost, §4.9 the
 * degradation matrix, §6 rows 91, 93).
 *
 * Three properties, asserted on every group: the REPORT rules hold by construction (escape
 * option, a paired `can_` Noul per option, a definition and ≥ 2 examples on both sides of every
 * Noul, 2–10 situation levels on every Score, and Jev is never asked to count anything); the
 * state carries **no value bytes**; and `askImport` never throws — a null decider, a throwing
 * decider, an aborted signal and an exhausted budget all return a *complete* outcome.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Answer, AskResult, Decider, Json, Question } from '../../../src/core/types.js';
import { JevHttpError } from '../../../src/errors.js';
import { ESCAPE_KEY, PAIRED_PREFIX, assertQuestionBatch } from '../../../src/jev/questions.js';
import { PAIRED_NOUL_FLOOR as CHOOSE_PAIRED_FLOOR } from '../../../src/loop/stages/choose.js';
import { INTAKE_RUN_FLOOR } from '../../../src/chat/intake.js';
import { JEV_INPUT_USD_PER_TOKEN as CLIENT_PRICE, JEV_TOKENS_PER_CHAR as CLIENT_PER_CHAR, JEV_TOKEN_OVERHEAD as CLIENT_OVERHEAD } from '../../../src/jev/types.js';
import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import {
  CHOICE_FLOOR,
  FILE_KIND_OPTIONS,
  JEV_INPUT_USD_PER_TOKEN,
  JEV_TOKENS_PER_CHAR,
  JEV_TOKEN_OVERHEAD,
  PAIRED_NOUL_FLOOR,
  RANK_LEVELS,
  askImport,
  contradictsQuestions,
  fileKindQuestions,
  mattersHereQuestions,
  mergeBatches,
  pairedIdFor,
  resolveChoice,
  resolveNoul,
  resolveScore,
  sameMeaningQuestions,
  secretQuestions,
} from '../../../src/import/questions.js';
import type { QuestionBatch } from '../../../src/import/questions.js';
import { shapeOf } from '../../../src/import/secrets.js';

/** The value that must never appear in any request body. */
const FIXTURE_VALUE = 'a7f3b2c1d4e5f60718293a4b5c6d7e8f';

const secretCands = [
  { id: 's1', dotted: 'integration.clientId', leaf: 'clientId', path: '~/.cursor/mcp.json', shape: shapeOf(FIXTURE_VALUE), fileClass: 'config' },
  { id: 's2', dotted: 'oauth.clientId', leaf: 'clientId', path: '~/.codex/config.toml', shape: shapeOf('b'.repeat(40)), fileClass: 'config' },
];
const fileCands = [
  { id: 'f1', path: '~/.claude/notes.md', bytes: 120, lines: 4, fences: 0, frontmatterKeys: [], headings: ['Today', 'Next'] },
  { id: 'f2', path: 'docs/data.csv', bytes: 900, lines: 40, fences: 0, frontmatterKeys: [], headings: [] },
];
const pairCands = [
  {
    id: 'p1',
    a: { path: 'AGENTS.md', tool: 'codex', bytes: 678, sha8: '3c4d5e6f', headings: ['Rules'] },
    b: { path: '~/.codex/AGENTS.md', tool: 'codex', bytes: 1120, sha8: 'e7f8091a', headings: ['Rules'] },
    jaccard: 0.78,
    commonHeadingRun: 1,
  },
];
const noteCands = [
  { id: 'n1', path: '~/.claude/memory/project-jevcode.md', kind: 'project', scope: 'project', bytes: 4200 },
  { id: 'n2', path: '~/.claude/memory/old.md', kind: 'reference', scope: 'user', bytes: 300 },
];
const conflictCands = [
  {
    id: 'c1',
    headings: ['Patching'],
    noun: 'patch',
    positiveMarker: 'always',
    negativeMarker: 'never',
    sentences: ['always explain before patching', 'never write prose before a patch'],
  },
];

function allBatches(sample: 'none' | 'headings' | 'head400' = 'headings'): QuestionBatch[] {
  return [
    secretQuestions(secretCands),
    fileKindQuestions(fileCands, sample),
    sameMeaningQuestions(pairCands),
    mattersHereQuestions(noteCands, '/ws'),
    contradictsQuestions(conflictCands, sample),
  ];
}

// ---------------------------------------------------------------------------------------
// The REPORT rules, on every group
// ---------------------------------------------------------------------------------------

describe('§4.4.3 the five groups obey the REPORT rules', () => {
  it('every batch passes assertQuestionBatch', () => {
    for (const b of allBatches()) expect(() => assertQuestionBatch(b.questions)).not.toThrow();
  });

  it('every Noul has a definition and ≥ 2 examples on BOTH sides', () => {
    for (const b of allBatches()) {
      for (const [id, q] of Object.entries(b.questions)) {
        if (q.type !== 'noul') continue;
        const c = q.criteria;
        expect(c, id).toBeDefined();
        for (const side of ['true', 'false'] as const) {
          const s = c?.[side] as { definition?: string; examples?: string[] } | undefined;
          expect(typeof s?.definition, `${id}.${side}`).toBe('string');
          expect((s?.definition ?? '').length, `${id}.${side}`).toBeGreaterThan(0);
          expect((s?.examples ?? []).length, `${id}.${side}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('every Choice has the escape option and a paired can_ Noul per non-escape option', () => {
    const batch = fileKindQuestions(fileCands, 'headings');
    const choices = Object.entries(batch.questions).filter(([, q]) => q.type === 'choice');
    expect(choices).toHaveLength(fileCands.length);
    for (const [id, q] of choices) {
      if (q.type !== 'choice') continue;
      expect(Object.keys(q.criteria), id).toContain(ESCAPE_KEY);
      for (const option of Object.keys(FILE_KIND_OPTIONS)) {
        const paired = pairedIdFor(id, option);
        expect(paired.startsWith(PAIRED_PREFIX), paired).toBe(true);
        expect(batch.questions[paired], paired).toBeDefined();
        expect(batch.questions[paired]?.type).toBe('noul');
      }
      expect(batch.questions[pairedIdFor(id, ESCAPE_KEY)]).toBeUndefined();
    }
  });

  it('every Score has 2–10 situation levels and is never a count', () => {
    const batch = mattersHereQuestions(noteCands, '/ws');
    const scores = Object.values(batch.questions).filter((q): q is Extract<Question, { type: 'score' }> => q.type === 'score');
    expect(scores).toHaveLength(noteCands.length);
    for (const q of scores) {
      expect(q.criteria.length).toBeGreaterThanOrEqual(2);
      expect(q.criteria.length).toBeLessThanOrEqual(10);
      expect(q.criteria).toEqual([...RANK_LEVELS]);
      for (const level of q.criteria) expect(String(level)).not.toMatch(/^\s*\d+\s*$/);
    }
    // no question anywhere asks Jev to count
    for (const b of allBatches()) for (const [id, q] of Object.entries(b.questions)) expect(String(q.instructions), id).not.toMatch(/\bhow many\b|\bcount\b/i);
  });
});

// ---------------------------------------------------------------------------------------
// §0 principle 3 — the state carries shapes, never content
// ---------------------------------------------------------------------------------------

describe('§0 principle 3 the state carries no value bytes', () => {
  it('group I carries length, charset, bucket, family — and no substring of the value', () => {
    const batch = secretQuestions(secretCands);
    const serialised = JSON.stringify(batch);
    expect(serialised).not.toContain(FIXTURE_VALUE);
    for (let i = 0; i + 4 <= FIXTURE_VALUE.length; i++) expect(serialised.includes(FIXTURE_VALUE.slice(i, i + 4))).toBe(false);
    const state = batch.state as { candidates: { length: number; charset: string; entropyBucket: string; fingerprint?: string }[] };
    expect(state.candidates[0]?.length).toBe(32);
    expect(state.candidates[0]?.charset).toBe('hex');
    expect(state.candidates[0]?.fingerprint).toBeUndefined();
  });

  it('group II carries headings only under headings/head400', () => {
    const none = fileKindQuestions(fileCands, 'none');
    expect(JSON.stringify(none.state)).not.toContain('Today');
    expect(JSON.stringify(fileKindQuestions(fileCands, 'headings').state)).toContain('Today');
    expect(JSON.stringify(fileKindQuestions(fileCands, 'head400').state)).toContain('Today');
  });

  it('group V is suppressed under `none`, carries no sentence under `headings`, and both under `head400` [G2.4]', () => {
    expect(contradictsQuestions(conflictCands, 'none').questions).toEqual({});
    expect(contradictsQuestions(conflictCands, 'none').groups).toEqual([]);
    const headings = contradictsQuestions(conflictCands, 'headings');
    expect(Object.keys(headings.questions)).toEqual(['contradicts_0']);
    expect(JSON.stringify(headings.state)).not.toContain('write prose');
    expect(JSON.stringify(headings.state)).toContain('patch');
    const head400 = contradictsQuestions(conflictCands, 'head400');
    expect(JSON.stringify(head400.state)).toContain('write prose');
  });

  it('every group is empty for an empty candidate list', () => {
    expect(secretQuestions([]).questions).toEqual({});
    expect(fileKindQuestions([], 'headings').questions).toEqual({});
    expect(sameMeaningQuestions([]).questions).toEqual({});
    expect(mattersHereQuestions([], '/ws').questions).toEqual({});
    expect(contradictsQuestions([], 'head400').questions).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------
// §4.4.3 batching
// ---------------------------------------------------------------------------------------

describe('mergeBatches', () => {
  it('folds I + II + III into one request when all three are non-empty', () => {
    const merged = mergeBatches([secretQuestions(secretCands), fileKindQuestions(fileCands, 'headings'), sameMeaningQuestions(pairCands)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.groups).toEqual(['I', 'II', 'III']);
    const state = merged[0]?.state as { candidates?: unknown; files?: unknown; pairs?: unknown };
    expect(state.candidates).toBeDefined();
    expect(state.files).toBeDefined();
    expect(state.pairs).toBeDefined();
  });

  it('keeps them apart when one is empty, or when the batch is over the question budget', () => {
    expect(mergeBatches([secretQuestions(secretCands), fileKindQuestions(fileCands, 'headings')])).toHaveLength(2);
    expect(mergeBatches([secretQuestions(secretCands), fileKindQuestions(fileCands, 'headings'), sameMeaningQuestions(pairCands)], 3)).toHaveLength(3);
  });

  it('drops empty batches and keeps groups IV and V in their own requests', () => {
    const out = mergeBatches(allBatches());
    expect(out.length).toBeLessThanOrEqual(IMPORT_LIMITS.jevRequests);
    expect(out.flatMap((b) => b.groups)).toEqual(['I', 'II', 'III', 'IV', 'V']);
  });
});

// ---------------------------------------------------------------------------------------
// §4.9 — askImport never throws
// ---------------------------------------------------------------------------------------

function fakeDecider(answers: Record<string, Answer>, costUsd = 0.0003): Decider {
  return {
    model: 'jev-1.13.0',
    provider: 'openrouter',
    ask: vi.fn(
      async (): Promise<AskResult> => ({
        answers,
        usage: { inputTokens: 6000, outputTokens: 0, costUsd, calls: 1 },
        latencyMs: 12,
        model: 'jev-1.13.0',
        requestHash: 'h',
        attempts: 1,
        id: null,
      }),
    ),
  };
}

function throwingDecider(e: unknown): Decider {
  return {
    model: 'jev-1.13.0',
    provider: 'openrouter',
    ask: vi.fn(async () => {
      throw e;
    }),
  };
}

describe('§4.9 askImport returns a complete outcome, always', () => {
  const batches = mergeBatches(allBatches());
  const signal = new AbortController().signal;

  it('a null decider (--no-jev / --mock) asks nothing and reports it', async () => {
    const out = await askImport(batches, { decider: null, signal, maxUsd: 0.01 });
    expect(out.requests).toBe(0);
    expect(out.answers).toEqual({});
    expect(out.reason).toBe('not asked (--no-jev)');
    expect(out.fallbacks).toBeGreaterThan(0);
  });

  it('a throwing decider — 401, 402, 429 and a timeout each name themselves', async () => {
    for (const status of [401, 402, 429]) {
      const out = await askImport(batches, { decider: throwingDecider(new JevHttpError('nope', { status, retryable: false })), signal, maxUsd: 0.01 });
      expect(out.reason, String(status)).toBe(`not asked (HTTP ${status})`);
      expect(out.requests).toBe(0);
      expect(out.answers).toEqual({});
    }
    const timedOut = await askImport(batches, { decider: throwingDecider(new Error('request timed out after 10000ms')), signal, maxUsd: 0.01 });
    expect(timedOut.reason).toBe('not asked (timeout)');
  });

  it('an over-budget cap stops asking and takes the fallbacks', async () => {
    const out = await askImport(batches, { decider: fakeDecider({}), signal, maxUsd: 1e-9 });
    expect(out.requests).toBe(0);
    expect(out.reason).toContain('jevMaxUsd');
    const zero = await askImport(batches, { decider: fakeDecider({}), signal, maxUsd: 0 });
    expect(zero.reason).toBe('not asked (jevMaxUsd $0.0000)');
  });

  it('an aborted signal is a reason, not a throw', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await askImport(batches, { decider: fakeDecider({}), signal: ac.signal, maxUsd: 0.01 });
    expect(out.reason).toBe('not asked (cancelled)');
  });

  it('a working decider accumulates answers, requests, questions and usd, and never exceeds the caps', async () => {
    const answers: Record<string, Answer> = { secret_0: { type: 'noul', noul: 0.8 } };
    const out = await askImport(batches, { decider: fakeDecider(answers), signal, maxUsd: 0.01 });
    expect(out.requests).toBeLessThanOrEqual(IMPORT_LIMITS.jevRequests);
    expect(out.questions).toBeLessThanOrEqual(IMPORT_LIMITS.jevQuestions);
    expect(out.usd).toBeGreaterThan(0);
    expect(out.answers['secret_0']).toEqual({ type: 'noul', noul: 0.8 });
    expect(out.reason).toBeUndefined();
    expect(out.fallbacks).toBeGreaterThan(0);
  });

  it('no batches at all is a complete, silent outcome', async () => {
    const out = await askImport([], { decider: fakeDecider({}), signal, maxUsd: 0.01 });
    expect(out).toEqual({ answers: {}, requests: 0, questions: 0, usd: 0, fallbacks: 0 });
  });

  it('§4.4.4 — the realistic batch stays under the cost cap', async () => {
    const out = await askImport(batches, { decider: fakeDecider({}, 0.00025), signal, maxUsd: 0.01 });
    expect(out.usd).toBeLessThanOrEqual(0.01);
  });
});

// ---------------------------------------------------------------------------------------
// The floors — one confidence convention in the codebase, not two
// ---------------------------------------------------------------------------------------

describe('the intake floors', () => {
  it('the restated constants equal the ones they cite', () => {
    expect(PAIRED_NOUL_FLOOR).toBe(CHOOSE_PAIRED_FLOOR);
    expect(CHOICE_FLOOR).toBe(INTAKE_RUN_FLOOR);
    expect(JEV_INPUT_USD_PER_TOKEN).toBe(CLIENT_PRICE);
    expect(JEV_TOKEN_OVERHEAD).toBe(CLIENT_OVERHEAD);
    expect(JEV_TOKENS_PER_CHAR).toBe(CLIENT_PER_CHAR);
  });

  it('resolveNoul applies its floor', () => {
    const answers: Record<string, Answer> = { a: { type: 'noul', noul: 0.55 }, b: { type: 'noul', noul: 0.49 } };
    expect(resolveNoul(answers, 'a')).toBe(0.55);
    expect(resolveNoul(answers, 'b')).toBe(null);
    expect(resolveNoul(answers, 'a', 0.6)).toBe(null);
    expect(resolveNoul(answers, 'missing')).toBe(null);
  });

  it('resolveChoice needs p ≥ 0.6 AND its paired Noul ≥ 0.5, and never takes the escape option', () => {
    const chosen = (p: number, paired: number): Record<string, Answer> => ({
      kind_3: { type: 'choice', choice: 'instructions_for_an_agent', probabilities: { instructions_for_an_agent: p }, confidence: p },
      [pairedIdFor('kind_3', 'instructions_for_an_agent')]: { type: 'noul', noul: paired },
    });
    expect(resolveChoice(chosen(0.82, 0.71), 'kind_3')).toEqual({ option: 'instructions_for_an_agent', p: 0.82, paired: 0.71 });
    expect(resolveChoice(chosen(0.59, 0.71), 'kind_3')).toBe(null);
    expect(resolveChoice(chosen(0.82, 0.49), 'kind_3')).toBe(null);
    expect(resolveChoice({ kind_3: { type: 'choice', choice: ESCAPE_KEY, probabilities: {}, confidence: 1 } }, 'kind_3')).toBe(null);
    expect(resolveChoice({}, 'kind_3')).toBe(null);
  });

  it('resolveScore returns the level index', () => {
    const answers: Record<string, Answer> = { rank_0: { type: 'score', score: 2, legend: {}, probabilities: {}, confidence: 0.8 } };
    expect(resolveScore(answers, 'rank_0')).toBe(2);
    expect(resolveScore({}, 'rank_0')).toBe(null);
  });
});

describe('the whole request body carries no candidate value', () => {
  it('every serialised batch is free of the fixture value', () => {
    const bodies: Json[] = mergeBatches(allBatches('head400')).map((b) => ({ state: b.state, questions: b.questions as unknown as Json }));
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain(FIXTURE_VALUE);
  });
});
