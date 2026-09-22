/**
 * §3.5 request 1 and §5.5 request 2: the REPORT.md rules made mechanical.
 *
 * The walks below are structural on purpose — "every Noul has two examples on both sides" is asserted by
 * traversing the built objects, not by reading them, so a later edit that drops an example fails here.
 */
import { describe, expect, it } from 'vitest';

import { getPath } from '../../../src/core/json.js';
import {
  DECOMPOSE_STATE_LIMITS,
  MAX_DECOMPOSE_QUESTIONS,
  MAX_RANK_QUESTIONS,
  OPTION_KEY_OF,
  RANK_LEVELS,
  RANK_STATE_LIMITS,
  SPLIT_ESCAPE,
  SPLIT_KIND_OF,
  WHICH_SPLIT,
  buildDecomposeQuestions,
  buildDecomposeState,
  buildRankQuestions,
  buildRankState,
  optionKeyOf,
  planDecomposeQuestions,
  rankScoreId,
  selfContainedId,
} from '../../../src/orchestrate/split/questions.js';
import type { Json, Question } from '../../../src/core/types.js';
import type { AgentSpec, NormalizedSplit, SplitKind } from '../../../src/orchestrate/types.js';

// ---------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------

function agent(slug: string, over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    slug,
    task: `do the ${slug} work`,
    own: [`src/${slug}/**`],
    role: 'code',
    verify: ['npm test'],
    dependsOn: [],
    capUsd: 0.3,
    maxSteps: 12,
    maxWallMs: 900_000,
    mode: 'jev-on',
    branch: `jevcode/${slug}`,
    ...over,
  };
}

function split(kind: SplitKind, slugs: readonly string[]): NormalizedSplit {
  return { kind, agents: slugs.map((s) => agent(s)), manifestId: 'x'.repeat(64), secretHits: 0, clampReason: null };
}

/** Every string leaf of a question: the instructions and every criteria string. */
function strings(q: Question): string[] {
  const out: string[] = [];
  const walk = (v: Json | undefined): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(q.instructions);
  if (q.type === 'noul') {
    walk(q.criteria?.true);
    walk(q.criteria?.false);
  } else if (q.type === 'choice') {
    for (const v of Object.values(q.criteria)) walk(v);
  } else {
    for (const v of q.criteria) walk(v);
  }
  return out;
}

function examplesOf(q: Question, side: 'true' | 'false'): Json {
  if (q.type !== 'noul' || q.criteria === undefined) return null;
  return getPath(q.criteria[side], 'examples') ?? null;
}

const ALL_KINDS: readonly Exclude<SplitKind, 'no_split'>[] = ['by_failing_test', 'by_layer', 'by_directory', 'by_plan_item', 'as_written'];

// ---------------------------------------------------------------------------------------

describe('§3.5 request 1 — the decompose questions', () => {
  it('the Choice carries every surviving kind plus the escape, and the key mapping round-trips', () => {
    const options = ALL_KINDS.map((k) => split(k, ['alpha-one', 'beta-two']));
    const qs = buildDecomposeQuestions(options, options[0] ?? null);
    const choice = qs[WHICH_SPLIT];
    expect(choice?.type).toBe('choice');
    if (choice?.type !== 'choice') throw new Error('unreachable');
    expect(Object.keys(choice.criteria).sort()).toEqual([...ALL_KINDS.map((k) => OPTION_KEY_OF[k]), SPLIT_ESCAPE].sort());
    expect(choice.criteria[SPLIT_ESCAPE]).toBeNull();
    for (const k of ALL_KINDS) {
      const key = OPTION_KEY_OF[k];
      expect(SPLIT_KIND_OF[key]).toBe(k);
      expect(optionKeyOf(k)).toBe(key);
    }
    expect(optionKeyOf('no_split')).toBeNull();
  });

  it('there is one paired Noul per non-escape option and none for the escape', () => {
    const options = ALL_KINDS.map((k) => split(k, ['alpha-one']));
    const qs = buildDecomposeQuestions(options, null);
    for (const k of ALL_KINDS) expect(qs[`can_${OPTION_KEY_OF[k]}`]?.type).toBe('noul');
    expect(qs[`can_${SPLIT_ESCAPE}`]).toBeUndefined();
    expect(Object.keys(qs)).toHaveLength(1 + ALL_KINDS.length);
  });

  it('every Noul has a definition and >= 2 examples on BOTH sides (the REPORT.md rule, walked)', () => {
    const options = ALL_KINDS.map((k) => split(k, ['alpha-one', 'beta-two']));
    const qs = buildDecomposeQuestions(options, options[2] ?? null);
    const nouls = Object.entries(qs).filter(([, q]) => q.type === 'noul');
    expect(nouls.length).toBeGreaterThanOrEqual(ALL_KINDS.length + 2);
    for (const [id, q] of nouls) {
      if (q.type !== 'noul') throw new Error('unreachable');
      for (const side of ['true', 'false'] as const) {
        const def = getPath(q.criteria?.[side] ?? null, 'definition');
        expect(typeof def, `${id}.${side}.definition`).toBe('string');
        expect(String(def).length).toBeGreaterThan(20);
        const ex = examplesOf(q, side);
        expect(Array.isArray(ex), `${id}.${side}.examples`).toBe(true);
        expect(Array.isArray(ex) ? ex.length : 0, `${id}.${side}.examples`).toBeGreaterThanOrEqual(2);
        // concrete, not a restatement: every example is longer than the shortest possible restatement
        for (const e of Array.isArray(ex) ? ex : []) expect(String(e).length).toBeGreaterThan(30);
      }
    }
  });

  it('one self-contained Noul per agent of the LEADING option only, phrased over the two texts', () => {
    const leading = split('by_directory', ['tui-rows', 'cli-args']);
    const other = split('by_plan_item', ['alpha-one', 'beta-two']);
    const qs = buildDecomposeQuestions([other, leading], leading);
    expect(qs[selfContainedId('tui-rows')]?.type).toBe('noul');
    expect(qs[selfContainedId('cli-args')]?.type).toBe('noul');
    expect(qs[selfContainedId('alpha-one')]).toBeUndefined();
    const text = String(qs[selfContainedId('tui-rows')]?.instructions ?? '');
    expect(text).toContain('Compare two given texts');
    expect(text).toContain('`options.split_by_directory.agents.0.task`');
    expect(text).toContain('`options.split_by_directory.agents.0.owns`');
    expect(text).toContain('Answer carefully and literally.');
  });

  it('the batch never exceeds 13 questions: self-contained Nouls are dropped from the end and recorded', () => {
    const options = ALL_KINDS.map((k) => split(k, ['alpha-one']));
    const leading = split('by_failing_test', ['a-one', 'b-two', 'c-three', 'd-four', 'e-five', 'f-six', 'g-seven', 'h-eight', 'i-nine', 'j-ten']);
    const plan = planDecomposeQuestions([leading, ...options.slice(1)], leading);
    expect(Object.keys(plan.questions).length).toBe(MAX_DECOMPOSE_QUESTIONS);
    expect(plan.askedSelfContained).toEqual(['a-one', 'b-two', 'c-three', 'd-four', 'e-five', 'f-six', 'g-seven']);
    expect(plan.droppedSelfContained).toEqual(['h-eight', 'i-nine', 'j-ten']);
    for (const s of plan.droppedSelfContained) expect(plan.questions[selfContainedId(s)]).toBeUndefined();
  });

  it('a single option with no leading split is still a well-formed batch', () => {
    const qs = buildDecomposeQuestions([split('as_written', ['alpha-one'])], null);
    expect(Object.keys(qs)).toEqual([WHICH_SPLIT, 'can_split_as_written']);
  });

  it('NO question asks Jev to count anything', () => {
    const options = ALL_KINDS.map((k) => split(k, ['alpha-one', 'beta-two']));
    const all: Question[] = [
      ...Object.values(buildDecomposeQuestions(options, options[0] ?? null)),
      ...Object.values(buildRankQuestions([{ slug: 'alpha-one', task: 't', own: ['src/a/**'], stat: { files: 1, added: 2, removed: 0 }, sample: ['+x'] }])),
    ];
    const banned = ['how many', 'count', 'number of'];
    for (const q of all) {
      for (const s of strings(q)) {
        for (const b of banned) expect(s.toLowerCase(), `"${s}"`).not.toContain(b);
      }
    }
  });
});

describe('§3.5 — the decompose state is bounded and O(1) in the transcript', () => {
  const long = (n: number, c: string): string[] => Array.from({ length: n }, (_, i) => `${i}-${c.repeat(400)}`);

  const state = buildDecomposeState({
    task: 'T'.repeat(9_000),
    remaining: long(30, 'r'),
    unverified: long(30, 'u'),
    directories: long(30, 'd'),
    failingTests: long(30, 'f'),
    verification: long(30, 'v'),
    options: [
      {
        kind: 'by_directory',
        agents: [agent('tui-rows', { task: 'A'.repeat(900), own: Array.from({ length: 20 }, (_, i) => `src/x${i}/**`), verify: ['a', 'b', 'c', 'd'] })],
        manifestId: 'y'.repeat(64),
        secretHits: 0,
        clampReason: null,
      },
      { kind: 'no_split', agents: [], manifestId: 'z'.repeat(64), secretHits: 0, clampReason: null },
    ],
  });

  const arrAt = (path: string): Json[] => {
    const v = getPath(state, path);
    if (!Array.isArray(v)) throw new Error(`${path} is not an array`);
    return v;
  };

  it('holds the §3.5 list bounds 12 / 8 / 12 / 8 / 4', () => {
    expect(arrAt('plan.remaining')).toHaveLength(DECOMPOSE_STATE_LIMITS.remaining);
    expect(arrAt('plan.unverified')).toHaveLength(DECOMPOSE_STATE_LIMITS.unverified);
    expect(arrAt('repo.directories')).toHaveLength(DECOMPOSE_STATE_LIMITS.directories);
    expect(arrAt('repo.failing_tests')).toHaveLength(DECOMPOSE_STATE_LIMITS.failingTests);
    expect(arrAt('repo.verification')).toHaveLength(DECOMPOSE_STATE_LIMITS.verification);
    expect([DECOMPOSE_STATE_LIMITS.remaining, DECOMPOSE_STATE_LIMITS.unverified, DECOMPOSE_STATE_LIMITS.directories, DECOMPOSE_STATE_LIMITS.failingTests, DECOMPOSE_STATE_LIMITS.verification]).toEqual([12, 8, 12, 8, 4]);
  });

  it('clips every string to its character bound', () => {
    expect(String(getPath(state, 'task')).length).toBe(DECOMPOSE_STATE_LIMITS.taskChars);
    expect(String(arrAt('plan.remaining')[0]).length).toBe(DECOMPOSE_STATE_LIMITS.remainingChars);
    expect(String(arrAt('plan.unverified')[0]).length).toBe(DECOMPOSE_STATE_LIMITS.unverifiedChars);
    expect(String(arrAt('repo.directories')[0]).length).toBe(DECOMPOSE_STATE_LIMITS.directoryChars);
    expect(String(arrAt('repo.failing_tests')[0]).length).toBe(DECOMPOSE_STATE_LIMITS.failingTestChars);
    expect(String(arrAt('repo.verification')[0]).length).toBe(DECOMPOSE_STATE_LIMITS.verificationChars);
  });

  it('keys options by their Choice key, skips no_split, and bounds each agent', () => {
    expect(Object.keys(getPath(state, 'options') ?? {})).toEqual(['split_by_directory']);
    expect(String(getPath(state, 'options.split_by_directory.agents.0.task')).length).toBe(DECOMPOSE_STATE_LIMITS.agentTaskChars);
    expect(arrAt('options.split_by_directory.agents.0.owns')).toHaveLength(DECOMPOSE_STATE_LIMITS.agentOwns);
    expect(arrAt('options.split_by_directory.agents.0.verify')).toHaveLength(DECOMPOSE_STATE_LIMITS.agentVerify);
  });
});

describe('§5.5 request 2 — the landing-order Score', () => {
  const agents = Array.from({ length: 12 }, (_, i) => ({
    slug: `a-${i}`,
    task: 'T'.repeat(900),
    own: Array.from({ length: 20 }, (_, j) => `src/x${j}/**`),
    stat: { files: 3, added: 40, removed: 2 },
    sample: [
      ...['diff --git a/one b/one', ...Array.from({ length: 80 }, (_, k) => `+line ${k} ${'z'.repeat(400)}`)],
      ...['diff --git a/two b/two', ...Array.from({ length: 80 }, (_, k) => `+two ${k}`)],
      ...['diff --git a/three b/three', '+three'],
      ...['diff --git a/four b/four', '+four'],
      ...['diff --git a/five b/five', '+five'],
    ],
  }));

  it('is one Score per agent, at most 8, with 5 levels written as situations', () => {
    const qs = buildRankQuestions(agents);
    expect(Object.keys(qs)).toHaveLength(MAX_RANK_QUESTIONS);
    expect(Object.keys(qs)[0]).toBe(rankScoreId('a-0'));
    const q = qs[rankScoreId('a-0')];
    expect(q?.type).toBe('score');
    if (q?.type !== 'score') throw new Error('unreachable');
    expect(q.criteria).toHaveLength(5);
    expect(q.criteria).toEqual([...RANK_LEVELS]);
    expect(String(q.criteria[0])).toContain('the diff does none of what the task describes');
    expect(String(q.criteria[4])).toContain('adds a test for it');
    // situations, not quantities: every level describes what the diff looks like
    for (const l of q.criteria) expect(String(l).startsWith('the diff ')).toBe(true);
  });

  it('bounds the diff sample to <= 40 lines per file for <= 4 files, and clips each line', () => {
    const state = buildRankState(agents);
    const one = getPath(state, 'agents.0.sample');
    if (!Array.isArray(one)) throw new Error('sample is not an array');
    // 4 files x (1 header + <= 39 body) — never the whole diff
    expect(one.length).toBeLessThanOrEqual(RANK_STATE_LIMITS.sampleFiles * RANK_STATE_LIMITS.sampleLinesPerFile);
    expect(one.length).toBe(40 + 40 + 2 + 2);
    for (const l of one) expect(String(l).length).toBeLessThanOrEqual(RANK_STATE_LIMITS.sampleLineChars);
    expect(one.some((l) => String(l).includes('b/five'))).toBe(false);
    const agentsJson = getPath(state, 'agents');
    expect(Array.isArray(agentsJson) ? agentsJson.length : 0).toBe(MAX_RANK_QUESTIONS);
    expect(String(getPath(state, 'agents.0.task')).length).toBe(RANK_STATE_LIMITS.taskChars);
    expect(getPath(state, 'agents.0.stat.added')).toBe(40);
  });
});
