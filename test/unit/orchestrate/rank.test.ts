/**
 * §3.5 ranking, every code fallback, and §5.2's landing order.
 *
 * The first test is the M2 / O1(a) property: when only `no_split` survives, `deps.ask` is never called. Its
 * spy fails the test if it is.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/types.js';
import { OPTION_KEY_OF, WHICH_SPLIT, selfContainedId } from '../../../src/orchestrate/split/questions.js';
import { rankLandingOrder, rankSplits, type RankInput } from '../../../src/orchestrate/split/rank.js';
import type { Answer, Decision, Question } from '../../../src/core/types.js';
import type { AgentSpec, AskFn, NormalizedSplit, SplitKind } from '../../../src/orchestrate/types.js';

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

function split(kind: SplitKind, agents: readonly AgentSpec[]): NormalizedSplit {
  return { kind, agents, manifestId: 'm'.repeat(64), secretHits: 0, clampReason: null };
}

function noulA(v: number): Answer {
  return { type: 'noul', noul: v };
}

function choiceA(keys: readonly string[], chosen: string, p = 0.7): Answer {
  const rest = keys.filter((k) => k !== chosen);
  const probabilities: Record<string, number> = { [chosen]: p };
  for (const k of rest) probabilities[k] = (1 - p) / Math.max(1, rest.length);
  return { type: 'choice', choice: chosen, probabilities, confidence: 0.8 };
}

function row(id: string, question: Question, answer: Answer): Decision {
  return { step: 3, stage: 'intent', id, question, answer, probability: 0.7, confidence: 0.42, latencyMs: 1, requestHash: 'h' };
}

/** An `AskFn` that returns the scripted answers and a `which_split` decision row the module may annotate. */
function scripted(answers: Record<string, Answer>): { ask: AskFn; rows: Decision[]; calls: () => number } {
  const rows: Decision[] = [];
  let calls = 0;
  const ask: AskFn = async (_state, questions) => {
    calls += 1;
    const q = questions[WHICH_SPLIT];
    const a = answers[WHICH_SPLIT];
    rows.length = 0;
    if (q !== undefined && a !== undefined) rows.push(row(WHICH_SPLIT, q, a));
    return { answers, rows };
  };
  return { ask, rows, calls: () => calls };
}

const BASE: Omit<RankInput, 'options' | 'auto'> = {
  task: 'make the tests pass',
  remaining: ['one', 'two', 'three'],
  unverified: [],
  directories: ['src', 'test'],
  failingTests: ['test/a.test.ts'],
  verification: ['npm test'],
  rejected: [{ kind: 'by_layer', reason: 'no workspace manifest', probability: null }],
  policy: DEFAULT_SPLIT_POLICY,
};

const TWO = [split('by_directory', [agent('tui-rows'), agent('cli-args')]), split('by_plan_item', [agent('alpha-one'), agent('beta-two')])];
const DIR_KEY = OPTION_KEY_OF['by_directory'];
const ITEM_KEY = OPTION_KEY_OF['by_plan_item'];

// ---------------------------------------------------------------------------------------

describe('§3.5 rankSplits', () => {
  it('M2 / O1(a): only no_split survived -> no Jev request is made at all', async () => {
    let called = false;
    const ask: AskFn = async () => {
      called = true;
      throw new Error('rankSplits must not ask Jev when only no_split survives');
    };
    const r = await rankSplits({ ...BASE, options: [], auto: false }, { ask });
    expect(called).toBe(false);
    expect(r).toMatchObject({ split: null, splitKind: 'no_split', verdict: 'code', askedJev: false });
    expect(r.rejected).toEqual(BASE.rejected);
  });

  it('(a) no decider (jev-off) -> no_split, verdict code, askedJev false', async () => {
    const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask: null });
    expect(r).toMatchObject({ split: null, splitKind: 'no_split', verdict: 'code', askedJev: false });
    expect(r.rejected.map((x) => x.kind)).toEqual(['by_layer', 'by_directory', 'by_plan_item']);
    expect(r.rejected.every((x) => x.probability === null)).toBe(true);
  });

  it('(b) corner row 4: the decider rejects -> no_split, verdict fallback, askedJev true, nothing thrown', async () => {
    for (const boom of [new Error('ETIMEDOUT'), new Error('401 unauthorized')]) {
      const ask: AskFn = async () => {
        throw boom;
      };
      const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask });
      expect(r).toMatchObject({ split: null, splitKind: 'no_split', verdict: 'fallback', askedJev: true });
      expect(r.rejected.some((x) => x.reason.includes('did not answer'))).toBe(true);
    }
  });

  it('(c) corner row 5: every paired Noul below the floor -> no_split, and the row reads fallback', async () => {
    const s = scripted({
      [WHICH_SPLIT]: choiceA([DIR_KEY, ITEM_KEY, 'none_of_these'], DIR_KEY, 0.9),
      [`can_${DIR_KEY}`]: noulA(0.49),
      [`can_${ITEM_KEY}`]: noulA(0.2),
    });
    const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask: s.ask });
    expect(r).toMatchObject({ split: null, splitKind: 'no_split', verdict: 'fallback', askedJev: true });
    expect(s.calls()).toBe(1);
    expect(s.rows[0]?.verdict).toBe('fallback');
    // every option that reached ranking records Jev's probability; the code-deleted one keeps null
    expect(r.rejected.find((x) => x.kind === 'by_layer')?.probability).toBeNull();
    expect(r.rejected.find((x) => x.kind === 'by_directory')?.probability).toBe(0.9);
  });

  it('(d) corner row 6: the escape is chosen -> identical to row 5, even with a strong paired Noul', async () => {
    const s = scripted({
      [WHICH_SPLIT]: choiceA([DIR_KEY, ITEM_KEY, 'none_of_these'], 'none_of_these', 0.6),
      [`can_${DIR_KEY}`]: noulA(0.95),
      [`can_${ITEM_KEY}`]: noulA(0.9),
    });
    const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask: s.ask });
    expect(r).toMatchObject({ split: null, splitKind: 'no_split', verdict: 'fallback', askedJev: true });
    expect(r.rejected.some((x) => x.reason.includes('none_of_these'))).toBe(true);
    expect(s.rows[0]?.verdict).toBe('fallback');
  });

  it('a missing which_split answer falls back rather than guessing', async () => {
    const s = scripted({ [`can_${DIR_KEY}`]: noulA(0.9) });
    const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask: s.ask });
    expect(r).toMatchObject({ splitKind: 'no_split', verdict: 'fallback', askedJev: true });
  });

  it('a chosen option above the floor wins, carries its probability and confidence, and annotates the row', async () => {
    const s = scripted({
      [WHICH_SPLIT]: choiceA([DIR_KEY, ITEM_KEY, 'none_of_these'], DIR_KEY, 0.8),
      [`can_${DIR_KEY}`]: noulA(0.9),
      [`can_${ITEM_KEY}`]: noulA(0.3),
    });
    const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask: s.ask });
    expect(r).toMatchObject({ splitKind: 'by_directory', verdict: 'chosen', probability: 0.8, confidence: 0.42, askedJev: true });
    expect(r.split?.agents.map((a) => a.slug)).toEqual(['tui-rows', 'cli-args']);
    expect(s.rows[0]?.verdict).toBe('chosen');
    expect(r.rejected.find((x) => x.kind === 'by_plan_item')?.reason).toContain('ranked below');
  });

  it('(corner row 7) drop-one: a below-floor self-contained Noul merges that agent into its nearest neighbour', async () => {
    const three = split('by_directory', [
      agent('tui-rows', { own: ['src/tui/rows/**'], capUsd: 0.3 }),
      agent('tui-pane', { own: ['src/tui/pane/**'], capUsd: 0.2 }),
      agent('cli-args', { own: ['src/cli/**'], capUsd: 0.25, dependsOn: ['tui-pane'] }),
    ]);
    const s = scripted({
      [WHICH_SPLIT]: choiceA([DIR_KEY, 'none_of_these'], DIR_KEY, 0.8),
      [`can_${DIR_KEY}`]: noulA(0.9),
      [selfContainedId('tui-rows')]: noulA(0.95),
      [selfContainedId('tui-pane')]: noulA(0.2),
      [selfContainedId('cli-args')]: noulA(0.7),
    });
    const r = await rankSplits({ ...BASE, options: [three], auto: false }, { ask: s.ask });
    expect(r.splitKind).toBe('by_directory');
    expect(r.split?.agents.map((a) => a.slug)).toEqual(['tui-rows', 'cli-args']);
    const receiver = r.split?.agents[0];
    // nearest directory by longest shared prefix: src/tui/rows/** shares two segments with src/tui/pane/**,
    // src/cli/** shares one, so tui-rows receives the merge. The union is deduped, not over-collapsed.
    expect(receiver?.task).toContain('merged from the dropped agent `tui-pane`');
    expect(receiver?.own).toEqual(['src/tui/rows/**', 'src/tui/pane/**']);
    expect(receiver?.capUsd).toBeCloseTo(0.5, 10);
    // the dropped slug leaves every dependsOn, and the manifest records the slug and the value
    expect(r.split?.agents[1]?.dependsOn).toEqual([]);
    const note = r.rejected.find((x) => x.reason.includes('tui-pane'));
    expect(note?.reason).toContain('0.20');
    expect(note?.probability).toBe(0.2);
    // the merged option is not re-normalised here, so its id is left for buildManifest to recompute
    expect(r.split?.manifestId).toBe('');
  });

  it('(corner row 7) below two self-contained agents -> no_split', async () => {
    const two = split('by_directory', [agent('tui-rows'), agent('cli-args')]);
    const s = scripted({
      [WHICH_SPLIT]: choiceA([DIR_KEY, 'none_of_these'], DIR_KEY, 0.8),
      [`can_${DIR_KEY}`]: noulA(0.9),
      [selfContainedId('tui-rows')]: noulA(0.1),
      [selfContainedId('cli-args')]: noulA(0.9),
    });
    const r = await rankSplits({ ...BASE, options: [two], auto: false }, { ask: s.ask });
    expect(r).toMatchObject({ split: null, splitKind: 'no_split', verdict: 'fallback' });
    expect(r.rejected.some((x) => x.reason.includes('fewer than two agents'))).toBe(true);
  });

  it('an agent with no self-contained Noul is never dropped: absence is not below the floor', async () => {
    const s = scripted({
      [WHICH_SPLIT]: choiceA([DIR_KEY, ITEM_KEY, 'none_of_these'], DIR_KEY, 0.8),
      [`can_${DIR_KEY}`]: noulA(0.9),
    });
    const r = await rankSplits({ ...BASE, options: TWO, auto: false }, { ask: s.ask });
    expect(r.split?.agents).toHaveLength(2);
  });

  it('(e) auto takes the first option in enumerate order, asks nothing, and repeats exactly on relaunch', async () => {
    let called = false;
    const ask: AskFn = async () => {
      called = true;
      throw new Error('--split=auto must not ask');
    };
    const input: RankInput = { ...BASE, options: TWO, auto: true };
    const a = await rankSplits(input, { ask });
    const b = await rankSplits(input, { ask: null });
    expect(called).toBe(false);
    expect(a).toMatchObject({ splitKind: 'by_directory', verdict: 'code', askedJev: false });
    expect(a.split).toBe(TWO[0]);
    expect(b).toEqual(a);
    expect(a.rejected.map((x) => x.kind)).toEqual(['by_layer', 'by_plan_item']);
  });
});

describe('§5.2 rankLandingOrder', () => {
  const agents = [
    { slug: 'zeta', dependsOn: ['prelude'] },
    { slug: 'alpha', dependsOn: ['prelude'] },
    { slug: 'prelude', dependsOn: [] },
    { slug: 'omega', dependsOn: ['alpha'] },
  ];

  it('is topological first, then Score descending, then slug', () => {
    expect(rankLandingOrder({ prelude: 1, zeta: 4, alpha: 2, omega: 4 }, agents)).toEqual(['prelude', 'zeta', 'alpha', 'omega']);
    expect(rankLandingOrder({ prelude: 0, zeta: 1, alpha: 4, omega: 3 }, agents)).toEqual(['prelude', 'alpha', 'omega', 'zeta']);
  });

  it('ties on the Score break by slug', () => {
    // prelude frees zeta and alpha (alpha wins on slug); alpha then frees omega, which wins on slug over zeta
    expect(rankLandingOrder({ zeta: 3, alpha: 3, prelude: 3, omega: 3 }, agents)).toEqual(['prelude', 'alpha', 'omega', 'zeta']);
  });

  it('with no scores at all it is the pure code fallback: topological, then slug', () => {
    expect(rankLandingOrder({}, agents)).toEqual(['prelude', 'alpha', 'omega', 'zeta']);
    expect(rankLandingOrder({ alpha: Number.NaN }, agents)).toEqual(['prelude', 'alpha', 'omega', 'zeta']);
  });

  it('never loses an agent: an unknown dependency is ignored and a cycle still emits everything', () => {
    expect(rankLandingOrder({}, [{ slug: 'one', dependsOn: ['nobody'] }])).toEqual(['one']);
    const cyclic = [
      { slug: 'a', dependsOn: ['b'] },
      { slug: 'b', dependsOn: ['a'] },
      { slug: 'c', dependsOn: [] },
    ];
    expect(rankLandingOrder({ a: 1, b: 2 }, cyclic).sort()).toEqual(['a', 'b', 'c']);
    expect(rankLandingOrder({}, [])).toEqual([]);
  });
});
