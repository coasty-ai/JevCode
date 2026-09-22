/**
 * OOS iteration 3, item 2 — the gold-free-pool rule as its adversarial review re-specified it
 * (`/tmp/review-iter3-2026-09-22.md` findings 2, 4, 6, 8, 9, 11, 13).
 *
 * What the rule is for is unchanged, and the record still says it: in
 * `~/.jevcode/runs/20260922-013715-nlsygcax` the 0.44 the analysis quotes is the LONE-PASSER
 * advisory and it DID hold the passer; the hole is that the moment a fifth passer arrived the
 * ≥ 2 path never computed `suspicionSignals` at all, so `fewestSpecialCases` committed a
 * different guard insert by code out of a pool whose every member inserts a guard at L9/L10
 * while the gold REPLACES L4.
 *
 * Five things the review changed:
 *   2  — a refused pick is HELD as the `suspect`, exactly as on the lone path, never `dropped`.
 *        The old code was strictly harsher than the rule it claimed to copy.
 *   6  — the pool ask is gated on `jevRequestsLeft`; with none left the code rules decide.
 *   11 — a missing or non-Noul answer for the pick falls through to the code rules, never drops.
 *   8, 13 — the signals are NOT in the Q15/Q16 state: the 0.3 / 0.7 bounds were calibrated on a
 *        signal-free state, so gating them on a Noul asked over a state that names the
 *        candidate's suspicious properties compares against a number nobody measured.
 *   9  — only a SWEPT signal counts toward `STRONG_SIGNALS_MIN`; `adds_special_case` rides on
 *        every inserted guard and made the 0.3 branch dead.
 */
import { describe, expect, it } from 'vitest';

import { ESCAPE_KEY, noul } from '../../../../src/jev/questions.js';
import { createGuardMemory, guardState } from '../../../../src/synth/search/bases.js';
import {
  GENERAL_CRITERIA,
  LONE_PASSER_HOLD_MAX_NOUL,
  commitSuspect,
  POOL_SUSPECT_SIGNALS,
  SUSPICION_SIGNAL_WHY,
  arbitrateState,
  decide,
  generalInstructions,
  representativesOf,
  clusterByBehaviour,
  suspicionSignals,
} from '../../../../src/synth/search/guard.js';
import type { SuspicionSignal } from '../../../../src/synth/search/guard.js';
import type { Answer, Json } from '../../../../src/core/types.js';
import type { HoldBudget } from '../../../../src/synth/search/guard.js';
import type { PerturbedInput } from '../../../../src/synth/search/perturb.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { candidate, committedBase, failure, goal as goalOf, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

// ---------------------------------------------------------------------------------------
// An all-`mutates_new_argument` pool — the only signal swept clean enough to say "no gold here"
// ---------------------------------------------------------------------------------------

const SRC = ['def total(items, extra):', '    n = 0', '    for x in items:', '        n += x', '    return n', ''].join('\n');
const FILE = sourceFile('src/agg.py', SRC);
const TEST = 'tests/test_agg.py::test_total_with_extra';
const BASE = committedBase(FILE, summary({ passed: 4, failing: [TEST], failures: [{ testId: TEST, call: 'total([1, 2], 3)', expected: '6', actual: '3' }] }));
const GOAL = goalOf([failure(TEST, '6', '3')], { suspectedFiles: ['src/agg.py'] });

/** A passer that appends to the parameter `items`, which `total` never hands back: `mutates_new_argument`. */
function mutator(id: string, text: string, source: 'mutation' | 'template' | 'donor' = 'mutation'): VerifyOutcome {
  return plausibleOutcome(candidate(siteAt(FILE, 2, 'insert'), text, { id, source, op: 'statement_insert' }), BASE);
}
/** Three independent sources; `m_a` and `m_b` behave alike, so their cluster holds 2 of the 3 supports. */
const POOL = (): VerifyOutcome[] => [mutator('m_a', '    items.append(extra)'), mutator('m_b', '    items.insert(0, extra)', 'template'), mutator('m_c', '    items.extend([extra])', 'donor')];

const SIG = new Map<string, string>([
  ['m_a', 'outputs:6|6'],
  ['m_b', 'outputs:6|6'],
  ['m_c', 'outputs:7|6'],
]);
const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, SIG.get(o.applied.candidate.id) ?? '']));
/** two perturbed inputs, so the probe actually runs and the outputs above do the clustering */
const INPUTS: PerturbedInput[] = [
  { input: [[1, 2], 3], derivedFrom: TEST, how: 'list_empty' },
  { input: [[4], 1], derivedFrom: TEST, how: 'list_singleton' },
];
const ORACLE = { runner: 'quixbugs' as const, lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: 1000, runTimeoutMs: 30_000, baselineDurationMs: 300 };
const opts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ probe, oracle: ORACLE, inputs: () => Promise.resolve(INPUTS), ...over });

/** Answers keyed by option KEY, so a record's cand_01..cand_0N rows replay verbatim. `null` = no Noul at all. */
function replay(choiceP: Record<string, number>, nouls: Record<string, number | null>): ReturnType<typeof scriptedAsk> {
  return scriptedAsk((questions) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        const probabilities: Record<string, number> = {};
        for (const k of keys) probabilities[k] = choiceP[k] ?? 0;
        const best = keys.reduce((a, b) => ((probabilities[b] ?? 0) > (probabilities[a] ?? 0) ? b : a), keys[0] ?? '');
        out[id] = { type: 'choice', choice: best, probabilities, confidence: 0.5 };
      } else {
        const p = nouls[id.replace(/^general_/, '')];
        // a Jev that escaped the Noul answers the wrong shape, exactly as review finding 11 has it
        out[id] = p === null || p === undefined ? ({ type: 'choice', choice: ESCAPE_KEY, probabilities: { [ESCAPE_KEY]: 1 }, confidence: 0 } as Answer) : { type: 'noul', noul: p };
      }
    }
    return out;
  });
}

const spentBudget: HoldBudget = { exhausted: () => true, testWallLeftMs: 0, testRunsLeft: 0, jevRequestsLeft: 0 };
const ampleBudget: HoldBudget = { exhausted: () => false, testWallLeftMs: 600_000, testRunsLeft: 5000, jevRequestsLeft: 8 };

describe('the pool the rule is for', () => {
  it('every contender carries the one swept signal, and the swept set is exactly that one signal', () => {
    for (const o of POOL()) expect(suspicionSignals(o, GOAL)).toContain('mutates_new_argument');
    expect([...POOL_SUSPECT_SIGNALS]).toEqual(['mutates_new_argument']);
    for (const s of ['adds_special_case', 'deletes_statement', 'duplicates_block', 'guards_other_variable', 'dead_guard', 'late_guard'] as const) expect(POOL_SUSPECT_SIGNALS.has(s)).toBe(false);
    // every signal still has a plain-English line for the transcript
    const all: SuspicionSignal[] = ['deletes_statement', 'duplicates_block', 'guards_other_variable', 'dead_guard', 'adds_special_case', 'mutates_new_argument', 'late_guard'];
    for (const s of all) expect(SUSPICION_SIGNAL_WHY[s].length).toBeGreaterThan(10);
  });

  it('the code ranking rules are skipped and Q15/Q16 is asked', async () => {
    const notes: string[] = [];
    const ask = replay({ cand_01: 0.6, cand_02: 0.2, cand_03: 0.1 }, { cand_01: 0.9, cand_02: 0.1, cand_03: 0.1 });
    const d = await decide(POOL(), createGuardMemory(BASE), GOAL, ask, opts({ budget: ampleBudget, note: (n: string) => notes.push(n) }));
    expect(d).toMatchObject({ kind: 'commit', arbitrated: true, requests: 1, codeRule: null });
    expect(notes.some((n) => n.includes('gold-free pool'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Finding 2 — hold, never drop
// ---------------------------------------------------------------------------------------

describe('review finding 2: a refused pick is HELD exactly as on the lone path, never dropped', () => {
  /**
   * The review's probe, as an identity: the SAME candidate at the SAME Noul must reach the same
   * disposition alone and in a pool. On `c469c9e` it was `held=suspect` alone and `dropped=2`
   * in a pool, and `commitSuspect` could revive the first and not the second.
   */
  it('the same candidate at the same Noul reaches the same disposition alone and in a pool', async () => {
    const low = 0.2;
    const alone = createGuardMemory(BASE);
    const dAlone = await decide([mutator('m_a', '    items.append(extra)')], alone, GOAL, replay({}, { cand_01: low }), opts({ budget: ampleBudget }));
    expect(dAlone).toMatchObject({ kind: 'continue', held: 'suspect' });
    expect(guardState(alone).suspect?.noul).toBe(low);

    const pooled = createGuardMemory(BASE);
    const dPool = await decide(POOL(), pooled, GOAL, replay({ cand_01: 0.6, cand_02: 0.2, cand_03: 0.2 }, { cand_01: low, cand_02: 0.1, cand_03: 0.1 }), opts({ budget: ampleBudget }));
    expect(dPool).toMatchObject({ kind: 'continue', held: 'suspect', dropped: 0 });
    expect(guardState(pooled).suspect?.noul).toBe(low);

    // and step end treats them identically — the old path cleared the hold and could not revive it
    expect(commitSuspect(alone, GOAL)).toEqual(commitSuspect(pooled, GOAL));
  });

  it('the held pick is the arbitration`s pick, carries its signals, and stays in the guard state for the reserve release', async () => {
    const mem = createGuardMemory(BASE);
    const d = await decide(POOL(), mem, GOAL, replay({ cand_01: 0.6, cand_02: 0.2, cand_03: 0.2 }, { cand_01: 0.05, cand_02: 0.02, cand_03: 0.02 }), opts({ budget: ampleBudget }));
    expect(d).toMatchObject({ kind: 'continue', held: 'suspect', dropped: 0 });
    expect(d.signals).toContain('mutates_new_argument');
    expect(guardState(mem).suspect?.outcome.applied.candidate.id).toBe('m_a');
  });
});

// ---------------------------------------------------------------------------------------
// Finding 6 — the pool ask is gated on the Jev budget
// ---------------------------------------------------------------------------------------

describe('review finding 6: a spent Jev budget falls through to the code rules', () => {
  it('with `jevRequestsLeft: 0` the batch commits by code with requests 0 and Jev is never asked', async () => {
    const notes: string[] = [];
    const d = await decide(POOL(), createGuardMemory(BASE), GOAL, throwingAsk, opts({ budget: spentBudget, note: (n: string) => notes.push(n) }));
    expect(d.kind).toBe('commit');
    expect(d).toMatchObject({ requests: 0, arbitrated: false, dropped: 0 });
    expect(d.codeRule).not.toBeNull();
    expect(notes.some((n) => n.includes('no Jev request is left to arbitrate them'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Finding 11 — a missing Noul is not evidence
// ---------------------------------------------------------------------------------------

describe('review finding 11: a missing or non-Noul answer for the pick never drops the pool', () => {
  it('an escaped Noul falls through to the code rules instead of refusing every contender', async () => {
    const notes: string[] = [];
    const ask = replay({ cand_01: 0.6, cand_02: 0.2, cand_03: 0.2 }, { cand_01: null, cand_02: null, cand_03: null });
    const d = await decide(POOL(), createGuardMemory(BASE), GOAL, ask, opts({ budget: ampleBudget, note: (n: string) => notes.push(n) }));
    expect(d.kind).toBe('commit');
    expect(d).toMatchObject({ dropped: 0, requests: 1 });
    expect(notes.some((n) => n.includes('Jev returned no Noul for the pick'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Findings 8, 9, 13 — calibration
// ---------------------------------------------------------------------------------------

describe('review findings 8 and 13: the arbitration state carries no signals', () => {
  it('`arbitrateState` emits exactly the measured keys — no `signals`, no `signals_note`', () => {
    const reps = representativesOf(clusterByBehaviour(POOL(), SIG));
    const state = arbitrateState({ goal: GOAL }, reps) as Record<string, Json>;
    expect(Object.keys(state).sort()).toEqual(['buggy_program_failure', 'candidates', 'program', 'task', 'tests']);
  });

  it('and the request the pool path makes is the same shape the lone-passer advisory was calibrated on', async () => {
    const ask = replay({ cand_01: 0.6, cand_02: 0.2, cand_03: 0.2 }, { cand_01: 0.9, cand_02: 0.1, cand_03: 0.1 });
    await decide(POOL(), createGuardMemory(BASE), GOAL, ask, opts({ budget: ampleBudget }));
    const state = ask.calls[0]!.state as Record<string, Json>;
    expect(state['signals']).toBeUndefined();
    expect(state['signals_note']).toBeUndefined();
  });
});

describe('review finding 9: only a swept signal raises the bound', () => {
  it('a pick carrying `mutates_new_argument` plus the ubiquitous `adds_special_case` is held to 0.3, not 0.7', async () => {
    // an inserted `if` always adds a conditional, so the pick carries two signals of which one is swept
    const withIf = (id: string, text: string): VerifyOutcome => plausibleOutcome(candidate(siteAt(FILE, 2, 'insert'), text, { id, source: 'mutation', op: 'statement_insert' }), BASE);
    const pool = [withIf('g_a', '    if extra:\n        items.append(extra)'), withIf('g_b', '    if extra:\n        items.insert(0, extra)')];
    for (const o of pool) {
      const s = suspicionSignals(o, GOAL);
      expect(s).toContain('adds_special_case');
      expect(s).toContain('mutates_new_argument');
      expect(s.filter((x) => POOL_SUSPECT_SIGNALS.has(x))).toHaveLength(1);
    }
    const sig = new Map([['g_a', 'outputs:6|6'], ['g_b', 'outputs:6|7']]);
    const p = async (pl: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(pl.map((o) => [o.applied.candidate.id, sig.get(o.applied.candidate.id) ?? '']));
    // 0.45 is below the two-signal 0.7 and above the one-signal 0.3: it must COMMIT
    const notes: string[] = [];
    const d = await decide(pool, createGuardMemory(BASE), GOAL, replay({ cand_01: 0.6, cand_02: 0.3 }, { cand_01: 0.45, cand_02: 0.1 }), opts({ probe: p, budget: ampleBudget, note: (n: string) => notes.push(n) }));
    expect(d.kind).toBe('commit');
    expect(notes.some((n) => n.includes(`≥ ${LONE_PASSER_HOLD_MAX_NOUL}`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Finding 4 — the Q16 wording
// ---------------------------------------------------------------------------------------

describe('review finding 4: the Q16 examples must read as TRUE on the `stats` gold', () => {
  it('the `true` example no longer requires the guard to name the variable the failure names', () => {
    const t = GENERAL_CRITERIA.true.examples;
    expect(t).not.toContain('a missing guard added exactly where the failing input reaches');
    expect(t.some((x) => x.includes('in front of the code that uses the value'))).toBe(true);
    // the name-match clause is what marked `stats`' gold down: it guards `values`, the failure
    // is an IndexError on the derived `ordered`
    expect(t.some((x) => x.includes('naming the variable the failure names'))).toBe(false);
    expect(t.join(' ')).not.toMatch(/the failure names|the same (variable|name)/);
  });

  it('the `false` counter-example is about the data path, not a name match', () => {
    const f = GENERAL_CRITERIA.false.examples;
    expect(f.some((x) => x.includes('not on the path from the failing input to the failure'))).toBe(true);
    expect(f.some((x) => x.includes('a different variable than the one the failure dereferences'))).toBe(false);
    // the placement counter-example stays: it is the one `detect_cycle` needed
    expect(f.some((x) => x.includes('after the statements that already use the value it guards'))).toBe(true);
  });

  it('REPORT.md form holds: a definition plus ≥ 2 examples both sides, no counting, no 0.5', () => {
    expect(GENERAL_CRITERIA.true.examples.length).toBeGreaterThanOrEqual(2);
    expect(GENERAL_CRITERIA.false.examples.length).toBeGreaterThanOrEqual(2);
    expect(() => noul(generalInstructions('cand_01'), GENERAL_CRITERIA)).not.toThrow();
    const text = [GENERAL_CRITERIA.true.definition, GENERAL_CRITERIA.false.definition, ...GENERAL_CRITERIA.true.examples, ...GENERAL_CRITERIA.false.examples].join(' ');
    expect(text).not.toMatch(/how many|count/i);
    expect(text).not.toMatch(/0\.5/);
  });
});
