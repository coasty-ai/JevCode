/**
 * TUI round-5 request R5-H2 — §8.6 `context.kept: 'code' | 'jev'`: the kept-items ORDERING pass.
 *
 * The named fallback test of the `jev-contract` block at `src/loop/context/compaction.ts` (`rankKept`). What it pins:
 *   - `'code'` is the default and NEVER asks — no request under `'code'`, under `jev-off`, or with no asker, so the
 *     `'code'` compactor stays free, deterministic across devices and resumes (G3(d)) and available in `jev-off`;
 *   - every route out of the Jev branch returns `rankKeptCode()`'s order UNCHANGED, with `fellBackTo` naming it;
 *   - Jev routes, never gates: it permutes only the answered candidates, human `/keep` items never move, and an
 *     unanswered candidate holds its code rank;
 *   - the question batch keeps the REPORT.md form (escape option, one absolute Noul per option, both-sided criteria
 *     with ≥ 2 examples each, no positional keys, nothing to count) and the state carries no transcript.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, AskResult, EngineMode, Json, Plan, Question } from '../../../src/core/types.js';
import { usesJev } from '../../../src/loop/engine.js';
import { ESCAPE_KEY } from '../../../src/jev/questions.js';
import {
  KEPT_ASKED_MAX,
  KEPT_CHOICE_ID,
  KEPT_FACT_PREFIX,
  KEPT_FILE_PREFIX,
  KEPT_MAX,
  KEPT_NOUL_FLOOR,
  buildKeptRequest,
  rankKept,
  rankKeptCode,
  type KeptItem,
  type KeptRankInput,
} from '../../../src/loop/context/compaction.js';
import { resolveContextPolicy } from '../../../src/loop/context/limits.js';

function plan(): Plan {
  return {
    done: [{ text: 'read the failing test', evidence: { step: 2, judged: 0.91, tests: [], verified: true } }],
    remaining: ['make tests/test_a.py::test_f pass', 'update the changelog'],
    unverified: [],
    openProblems: [],
    harnessProblems: [],
  } as unknown as Plan;
}

function item(over: Partial<KeptItem> = {}): KeptItem {
  return { kind: 'fact', text: 'a fact', step: 3, by: 'code', ...over };
}

function input(candidates: readonly KeptItem[], over: Partial<KeptRankInput> = {}): KeptRankInput {
  return { task: 'Fix f() in src/a.ts so that tests/test_a.py passes', plan: plan(), candidates, ...over };
}

function answered(answers: Record<string, Answer>): AskResult {
  return { answers, usage: { inputTokens: 100, outputTokens: 4, costUsd: 0.001, calls: 1 }, latencyMs: 170, model: 'jev-1.13-20260917', requestHash: 'h1', attempts: 1, id: null };
}

/** an asker that records what it was handed, so "never asked" is an assertion and not a hope */
function recorder(reply: (questions: Record<string, Question>) => AskResult) {
  const calls: { state: Json; questions: Record<string, Question> }[] = [];
  return {
    calls,
    ask: (state: Json, questions: Record<string, Question>): Promise<AskResult> => {
      calls.push({ state, questions });
      return Promise.resolve(reply(questions));
    },
  };
}

const THREE: KeptItem[] = [
  item({ text: 'tests/test_a.py::test_f fails: AssertionError: expected 3, got 2', step: 6 }),
  item({ text: 'src/a.ts', kind: 'file', step: 5 }),
  item({ text: 'the edit to src/b.ts was declined: it touches a path another session holds', kind: 'decision', step: 4 }),
];

describe("R5-H2 §8.6 `context.kept` — the policy member", () => {
  it("defaults to 'code' and carries 'jev' through resolveContextPolicy", () => {
    expect(resolveContextPolicy().kept).toBe('code');
    expect(resolveContextPolicy({}).kept).toBe('code');
    expect(resolveContextPolicy({ kept: 'code' }).kept).toBe('code');
    expect(resolveContextPolicy({ kept: 'jev' }).kept).toBe('jev');
  });

  it('is additive: adding it changes no other resolved bound', () => {
    const { kept: _a, ...without } = resolveContextPolicy({ compaction: 'llm', historySteps: 9 });
    const { kept: _b, ...with_ } = resolveContextPolicy({ compaction: 'llm', historySteps: 9, kept: 'jev' });
    expect(with_).toEqual(without);
  });
});

describe('R5-H2 rankKeptCode — the deterministic order', () => {
  it('puts human /keep items first, then the newest step, then kind, then text', () => {
    const items: KeptItem[] = [
      item({ text: 'old fact', step: 1 }),
      item({ text: 'the human said this', step: 1, by: 'human' }),
      item({ text: 'b newest', step: 9 }),
      item({ text: 'a newest', step: 9 }),
      item({ text: 'a newest file', step: 9, kind: 'file' }),
    ];
    expect(rankKeptCode(items).map((k) => k.text)).toEqual(['the human said this', 'a newest', 'b newest', 'a newest file', 'old fact']);
  });

  it('is a total order: every input permutation gives the same list', () => {
    const items: KeptItem[] = [item({ text: 'x', step: 4 }), item({ text: 'y', step: 4 }), item({ text: 'z', step: 7, by: 'jev' })];
    const forward = rankKeptCode(items).map((k) => k.text);
    expect(rankKeptCode([...items].reverse()).map((k) => k.text)).toEqual(forward);
    expect(rankKeptCode([items[1]!, items[2]!, items[0]!]).map((k) => k.text)).toEqual(forward);
  });

  it('cuts at KEPT_MAX (24) and never mutates its input', () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ text: `fact ${i}`, step: i }));
    const snapshot = many.map((k) => k.text);
    expect(rankKeptCode(many)).toHaveLength(KEPT_MAX);
    expect(rankKeptCode(many, 3)).toHaveLength(3);
    expect(rankKeptCode(many, 0)).toHaveLength(0);
    expect(many.map((k) => k.text)).toEqual(snapshot);
  });
});

describe('R5-H2 rankKept — every route back to the code order', () => {
  it("'code' (the default) never asks", async () => {
    const r = recorder(() => answered({}));
    const byDefault = await rankKept(input(THREE), { mode: 'jev-on', ask: r.ask });
    expect(byDefault.by).toBe('code');
    expect(byDefault.fellBackTo).toBe('policy');
    expect(byDefault.requests).toBe(0);
    const explicit = await rankKept(input(THREE), { mode: 'jev-on', kept: 'code', ask: r.ask });
    expect(explicit.fellBackTo).toBe('policy');
    expect(explicit.kept).toEqual(rankKeptCode(THREE));
    expect(r.calls).toHaveLength(0);
  });

  it("is REFUSED in jev-off even under kept: 'jev' (§8.6 — the arm that isolates the generator)", async () => {
    const r = recorder(() => answered({}));
    const out = await rankKept(input(THREE), { mode: 'jev-off', kept: 'jev', ask: r.ask });
    expect(out.by).toBe('code');
    expect(out.fellBackTo).toBe('jev-off');
    expect(out.requests).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(out.kept).toEqual(rankKeptCode(THREE));
  });

  it('the refusal is exactly `usesJev` (engine.ts:558) over all four modes', async () => {
    for (const mode of ['jev-on', 'jev-off', 'jev-only', 'llm-jev'] as EngineMode[]) {
      const r = recorder(() => answered({}));
      const out = await rankKept(input(THREE), { mode, kept: 'jev', ask: r.ask });
      expect(r.calls.length === 1, `mode ${mode}`).toBe(usesJev(mode));
      expect(out.fellBackTo === 'jev-off', `mode ${mode}`).toBe(!usesJev(mode));
    }
  });

  it('with no asker, and with nothing askable, the code order stands and nothing is spent', async () => {
    const noAsker = await rankKept(input(THREE), { mode: 'jev-on', kept: 'jev' });
    expect(noAsker.fellBackTo).toBe('no-asker');
    expect(noAsker.requests).toBe(0);

    const r = recorder(() => answered({}));
    const humanOnly = await rankKept(input([item({ text: 'the human said this', by: 'human' })]), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(humanOnly.fellBackTo).toBe('nothing-to-ask');
    expect(humanOnly.requests).toBe(0);
    expect(r.calls).toHaveLength(0);

    const empty = await rankKept(input([]), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(empty.fellBackTo).toBe('nothing-to-ask');
    expect(empty.kept).toEqual([]);
  });

  it('a throwing Decider falls back to the code order (the contract-block fallback)', async () => {
    const out = await rankKept(input(THREE), {
      mode: 'jev-on',
      kept: 'jev',
      ask: () => Promise.reject(new Error('502 from the gateway')),
    });
    expect(out.by).toBe('code');
    expect(out.fellBackTo).toBe('failed');
    expect(out.requests).toBe(1);
    expect(out.kept).toEqual(rankKeptCode(THREE));
  });

  it('every Noul under the 0.3 floor is an escape: the code order stands', async () => {
    const r = recorder((qs) => {
      const answers: Record<string, Answer> = {};
      for (const id of Object.keys(qs)) {
        if (id === KEPT_CHOICE_ID) continue;
        answers[id] = { type: 'noul', noul: KEPT_NOUL_FLOOR - 0.05 };
      }
      return answered(answers);
    });
    const out = await rankKept(input(THREE), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.by).toBe('code');
    expect(out.fellBackTo).toBe('escaped');
    expect(out.requests).toBe(1);
    expect(out.kept).toEqual(rankKeptCode(THREE));
  });

  it('an escape that outranks every candidate is an escape, whatever the Nouls say', async () => {
    const r = recorder((qs) => {
      const answers: Record<string, Answer> = {};
      const keys: string[] = [];
      for (const id of Object.keys(qs)) {
        if (id === KEPT_CHOICE_ID) continue;
        answers[id] = { type: 'noul', noul: 0.9 };
        keys.push(id.replace(KEPT_FACT_PREFIX, '').replace(KEPT_FILE_PREFIX, ''));
      }
      const probabilities: Record<string, number> = { [ESCAPE_KEY]: 0.8 };
      for (const k of keys) probabilities[k] = 0.05;
      answers[KEPT_CHOICE_ID] = { type: 'choice', choice: ESCAPE_KEY, probabilities, confidence: 0.7 };
      return answered(answers);
    });
    const out = await rankKept(input(THREE), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.fellBackTo).toBe('escaped');
    expect(out.pEscape).toBe(0.8);
    expect(out.kept).toEqual(rankKeptCode(THREE));
  });

  it('an answer with no Nouls at all (a truncated response) is an escape, not a crash', async () => {
    const r = recorder(() => answered({ [KEPT_CHOICE_ID]: { type: 'choice', choice: 'fact_deadbeef', probabilities: {}, confidence: 0.5 } }));
    const out = await rankKept(input(THREE), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.fellBackTo).toBe('escaped');
    expect(out.kept).toEqual(rankKeptCode(THREE));
  });
});

describe('R5-H2 rankKept — what Jev may and may not change', () => {
  /** Answer `nouls[i]` for the i-th asked candidate, in the order the request lists them. */
  function withNouls(values: readonly number[]) {
    return recorder((qs) => {
      const ids = Object.keys(qs).filter((id) => id !== KEPT_CHOICE_ID);
      const answers: Record<string, Answer> = {};
      ids.forEach((id, i) => {
        const v = values[i];
        if (v !== undefined) answers[id] = { type: 'noul', noul: v };
      });
      return answered(answers);
    });
  }

  it('reorders the answered candidates by Noul, best first', async () => {
    const r = withNouls([0.4, 0.95, 0.6]);
    const out = await rankKept(input(THREE), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.by).toBe('jev');
    expect(out.fellBackTo).toBeNull();
    expect(out.requests).toBe(1);
    const code = rankKeptCode(THREE);
    expect(out.kept.map((k) => k.text)).toEqual([code[1]!.text, code[2]!.text, code[0]!.text]);
    // the SET is untouched: an ordering pass never drops or invents an item
    expect([...out.kept].map((k) => k.text).sort()).toEqual([...code].map((k) => k.text).sort());
  });

  it('never moves a human /keep item, whatever Jev answers', async () => {
    const human = item({ text: 'always remember the deploy needs --no-cache', step: 1, by: 'human' });
    const items = [human, ...THREE];
    const r = withNouls([0.99, 0.98, 0.97]);
    const out = await rankKept(input(items), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.by).toBe('jev');
    expect(out.kept[0]).toBe(human);
    // the human item is not even in the batch
    const asked = buildKeptRequest(input(items), rankKeptCode(items));
    expect(asked?.asked.some(({ item: i }) => i === human)).toBe(false);
  });

  it('an unanswered candidate holds its code rank while the answered ones permute around it', async () => {
    const code = rankKeptCode(THREE);
    // answer only positions 0 and 2; position 1 is silent
    const r = recorder((qs) => {
      const ids = Object.keys(qs).filter((id) => id !== KEPT_CHOICE_ID);
      return answered({ [ids[0]!]: { type: 'noul', noul: 0.4 }, [ids[2]!]: { type: 'noul', noul: 0.9 } });
    });
    const out = await rankKept(input(THREE), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.by).toBe('jev');
    expect(out.kept[1]).toBe(code[1]);
    expect(out.kept.map((k) => k.text)).toEqual([code[2]!.text, code[1]!.text, code[0]!.text]);
  });

  it('the cut at KEPT_MAX is the code’s and ran before the ask', async () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ text: `fact ${i}`, step: i }));
    const r = withNouls(Array.from({ length: KEPT_ASKED_MAX }, () => 0.9));
    const out = await rankKept(input(many), { mode: 'jev-on', kept: 'jev', ask: r.ask });
    expect(out.kept).toHaveLength(KEPT_MAX);
    const ids = Object.keys(r.calls[0]!.questions).filter((id) => id !== KEPT_CHOICE_ID);
    expect(ids).toHaveLength(KEPT_ASKED_MAX);
  });
});

describe('R5-H2 buildKeptRequest — the REPORT.md form', () => {
  const req = buildKeptRequest(input(THREE), rankKeptCode(THREE))!;

  it('is ONE request (§5.4 rule 1) with a Choice that has an escape and one absolute Noul per option', () => {
    expect(req).not.toBeNull();
    const chooser = req.questions[KEPT_CHOICE_ID]!;
    expect(chooser.type).toBe('choice');
    const criteria = chooser.criteria as Record<string, unknown>;
    expect(Object.keys(criteria)).toContain(ESCAPE_KEY);
    for (const { key } of req.asked) {
      expect(Object.keys(criteria)).toContain(key);
      const noulId = Object.keys(req.questions).find((id) => id.endsWith(key) && id !== KEPT_CHOICE_ID)!;
      expect(req.questions[noulId]!.type).toBe('noul');
    }
    // one Noul per option, plus the Choice
    expect(Object.keys(req.questions)).toHaveLength(req.asked.length + 1);
  });

  it('every Noul carries both sides with >= 2 examples each (§5.4 rule 4)', () => {
    for (const [id, q] of Object.entries(req.questions)) {
      if (id === KEPT_CHOICE_ID) continue;
      const c = q.criteria as { true: { definition: string; examples: string[] }; false: { definition: string; examples: string[] } };
      for (const side of ['true', 'false'] as const) {
        expect(c[side].definition.length, `${id}.${side}`).toBeGreaterThan(20);
        expect(c[side].examples.length, `${id}.${side}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("uses §8.6's two Noul names over CONTENT-derived keys — never a position (REPORT §10)", () => {
    const ids = Object.keys(req.questions).filter((id) => id !== KEPT_CHOICE_ID);
    expect(ids.some((id) => id.startsWith(KEPT_FACT_PREFIX))).toBe(true);
    expect(ids.some((id) => id.startsWith(KEPT_FILE_PREFIX))).toBe(true);
    for (const id of ids) expect(id).not.toMatch(/_\d+$/);
    // the same item gets the same key on a second build, and a different item a different one
    const again = buildKeptRequest(input(THREE), rankKeptCode(THREE))!;
    expect(again.asked.map((a) => a.key)).toEqual(req.asked.map((a) => a.key));
    const other = buildKeptRequest(input([item({ text: 'something else entirely', step: 6 })]), rankKeptCode([item({ text: 'something else entirely', step: 6 })]))!;
    expect(other.asked[0]!.key).not.toBe(req.asked[0]!.key);
  });

  it('names every target with a backticked path and asks nothing that has to be counted (§5.4 rules 2 and 5)', () => {
    for (const [id, q] of Object.entries(req.questions)) {
      expect(String(q.instructions), id).toMatch(/`(candidates\.[a-z0-9_]+|plan\.remaining|task)`/);
      expect(String(q.instructions).toLowerCase(), id).not.toMatch(/how many|count |number of/);
    }
  });

  it('the state is plan + candidates and carries no transcript (§8.6)', () => {
    const state = req.state as Record<string, Json>;
    expect(Object.keys(state).sort()).toEqual(['candidates', 'keep_criteria', 'plan', 'task']);
    expect(Object.keys(state['plan'] as Record<string, Json>).sort()).toEqual(['done', 'remaining']);
    const json = JSON.stringify(state);
    for (const forbidden of ['history', 'recent', 'output', 'transcript', 'window']) expect(json).not.toContain(forbidden);
  });
});
