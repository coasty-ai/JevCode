/**
 * OOS iteration 3, item 2 — why `detect_cycle` was outvoted, read off the record, and the two
 * things that change.
 *
 * The record is `~/.jevcode/runs/20260922-013715-nlsygcax` (the OOS slice's `detect_cycle`;
 * `decisions.jsonl` and `transcript.log`). Two lines of it say everything:
 *
 *   [step 1] synth guard: g1: holds the lone passer donor/statement_donor at detect_cycle.py:10:insert
 *     as suspect (duplicates_block, guards_other_variable, dead_guard, adds_special_case;
 *     general 0.44 < 0.7); searching on …
 *   [step 1] synth guard: g1: 5 passers (1 held) in 3 behaviour clusters …; the clusters split;
 *     committing template/guard_empty_break at detect_cycle.py:9:insert with the fewest added
 *     special-case guards (+1c/+0l; +1c/+1l; +1c/+2l) by code (no arbitration)
 *
 * So the analysis' Q6 row ("arbitrated, `general_cand_01` noul 0.44 — above `SUSPECT_NOUL_MAX` 0.3,
 * so the all-overfit drop never fired") is only half the story, and the half it names is not the
 * hole. `general_cand_01` 0.44 is the LONE-PASSER advisory, and it did its job: with four signals
 * the passer was held, not committed. The hole is what happened next — a fifth passer arrived, and
 * on the ≥ 2 path `decide` never computed `suspicionSignals` at all. The four signals were thrown
 * away, `fewestSpecialCases` ranked the remaining suspects by a count, and the winner it committed
 * (`guard_empty_break`, +1c/+0l) was never examined. Every one of those five passers inserts a
 * guard at L9/L10; `detect_cycle`'s gold REPLACES L4. The pool had no gold in it, and the code
 * rules cannot see that — they rank suspects against each other.
 *
 * Two changes, neither of them a threshold:
 *
 *  1. The Q16 wording. The record's `true` side offered "a missing guard added exactly where the
 *     failing input reaches", which READS AS SATISFIED by a patch that is literally a missing
 *     guard being added, while the `false` side had no example of a guard in the wrong place or on
 *     the wrong variable — the two shapes the code signals had already found. The example is
 *     qualified and the two counter-examples are added (both sides keep ≥ 2 examples, and
 *     `src/jev/questions.ts` enforces that at build time).
 *  2. The arbitration weighs the structural signal. `decide` computes the signals for every
 *     contender; when EVERY contender carries a shape signal the code ranking rules are skipped
 *     (they would be ranking a gold-free pool) and Q15/Q16 is asked with the signals in the state;
 *     the pick is then held to the SAME bound a lone passer with the same signals would face
 *     (`LONE_PASSER_VOUCH_MIN_NOUL` at two or more). At the recorded 0.44 that refuses the commit.
 */
import { describe, expect, it } from 'vitest';

import { ESCAPE_KEY, noul } from '../../../../src/jev/questions.js';
import { createGuardMemory } from '../../../../src/synth/search/bases.js';
import {
  GENERAL_CRITERIA,
  LONE_PASSER_VOUCH_MIN_NOUL,
  POOL_SUSPECT_SIGNALS,
  SIGNALS_NOTE,
  SUSPICION_SIGNAL_WHY,
  clusterByBehaviour,
  clusterSupport,
  decide,
  generalInstructions,
  seedOnlySplit,
  suspicionSignals,
} from '../../../../src/synth/search/guard.js';
import type { SuspicionSignal } from '../../../../src/synth/search/guard.js';
import type { Answer } from '../../../../src/core/types.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { DETECT_CYCLE, DETECT_CYCLE_FAILURES, DETECT_CYCLE_GOLD, DETECT_CYCLE_LINE, DETECT_CYCLE_TAIL, NODE, candidate, committedBase, goal as goalOf, plausibleOutcome, scriptedAsk, siteAt, summary } from './helpers.js';

const DC_BASELINE = summary({ passed: 5, failing: [DETECT_CYCLE_FAILURES[0]!.testId], failures: DETECT_CYCLE_FAILURES.map((f) => ({ testId: f.testId, call: f.call, expected: f.expected, actual: f.actual })) });
const DC_BASE = committedBase(DETECT_CYCLE, { ...DC_BASELINE, outputTail: DETECT_CYCLE_TAIL }, [NODE]);
const DC_GOAL = goalOf(DETECT_CYCLE_FAILURES, { suspectedFiles: [DETECT_CYCLE.path] });
/** The recorded lone-passer advisory of `20260922-013715-nlsygcax`. */
const RECORDED_NOUL = 0.44;

/** A guard inserted before `hare = hare.successor.successor` (L9) or after it (L10), returning False. */
function guardInsert(id: string, line: number, head: string, source: 'template' | 'donor' = 'template'): VerifyOutcome {
  return plausibleOutcome(
    candidate(siteAt(DETECT_CYCLE, line, 'insert'), head, { id, source, op: source === 'donor' ? 'statement_donor' : 'guard_empty_return', extraEdits: [{ path: DETECT_CYCLE.path, line, kind: 'insert', text: '            return False' }] }),
    DC_BASE,
  );
}

/** The gold: a REPLACE of L4's guard, which the whole recorded pool missed. */
function goldPasser(): VerifyOutcome {
  return plausibleOutcome(candidate(siteAt(DETECT_CYCLE, DETECT_CYCLE_LINE), DETECT_CYCLE_GOLD, { id: 'dc_gold', source: 'mutation', op: 'condition_widen' }), DC_BASE);
}

/** Answers keyed by option KEY, so a record's cand_01..cand_0N rows can be replayed verbatim. */
function replay(choiceP: Record<string, number>, nouls: Record<string, number>): ReturnType<typeof scriptedAsk> {
  return scriptedAsk((questions) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        const probabilities: Record<string, number> = {};
        for (const k of keys) probabilities[k] = choiceP[k] ?? 0;
        const best = keys.reduce((a, b) => ((probabilities[b] ?? 0) > (probabilities[a] ?? 0) ? b : a), keys[0] ?? '');
        out[id] = { type: 'choice', choice: best, probabilities, confidence: 0.5 };
      } else if (q.type === 'noul') {
        out[id] = { type: 'noul', noul: nouls[id.replace(/^general_/, '')] ?? RECORDED_NOUL };
      } else {
        throw new Error(`unexpected question ${id}`);
      }
    }
    return out;
  });
}

describe('change 1: the Q16 wording the record answered 0.44 on', () => {
  it('the `true` example that read as satisfied by the overfit now says where the guard must go, and the `false` side names both shapes the code signals found', () => {
    const t = GENERAL_CRITERIA.true.examples;
    const f = GENERAL_CRITERIA.false.examples;
    // the record's text, verbatim, is gone — it was true of `if not hare.successor.successor: break`
    expect(t).not.toContain('a missing guard added exactly where the failing input reaches');
    expect(t.some((x) => x.includes('in front of the code that uses the value') && x.includes('naming the variable the failure names'))).toBe(true);
    // `late_guard` and `guards_other_variable` now have a home on the FALSE side
    expect(f.some((x) => x.includes('after the statements that already use the value it guards'))).toBe(true);
    expect(f.some((x) => x.includes('a different variable than the one the failure dereferences'))).toBe(true);
    // REPORT.md form: a definition plus ≥ 2 examples on BOTH sides, enforced by the builder
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(f.length).toBeGreaterThanOrEqual(2);
    expect(() => noul(generalInstructions('cand_01'), GENERAL_CRITERIA)).not.toThrow();
    const q = noul(generalInstructions('cand_01'), GENERAL_CRITERIA);
    expect(q.type).toBe('noul');
    // never a count and no 0.5 anywhere in the wording
    expect(`${GENERAL_CRITERIA.true.definition} ${GENERAL_CRITERIA.false.definition}`).not.toMatch(/how many|count/i);
  });

  it('every signal has a plain-English line for the state, and the note says the signals are evidence rather than a verdict', () => {
    const all: SuspicionSignal[] = ['deletes_statement', 'duplicates_block', 'guards_other_variable', 'dead_guard', 'adds_special_case', 'mutates_new_argument', 'late_guard'];
    for (const s of all) expect(SUSPICION_SIGNAL_WHY[s].length).toBeGreaterThan(10);
    expect(SIGNALS_NOTE).toContain('evidence, not a verdict');
    expect(SIGNALS_NOTE).toContain('still passes every test');
  });
});

describe('change 2: the pool of the record, and the clean pool beside it', () => {
  /** The recorded shape: every passer a guard INSERTED at L9/L10 while the gold replaces L4. */
  function goldFreePool(): VerifyOutcome[] {
    return [
      guardInsert('dc_a', 9, '        if hare.successor.successor is None:'),
      guardInsert('dc_b', 9, '        if not hare.successor.successor:'),
      guardInsert('dc_c', 10, '        if tortoise.successor is None:', 'donor'),
    ];
  }

  const SIG = new Map<string, string>([
    ['dc_a', 'outputs:False|False'],
    ['dc_b', 'outputs:None|None'],
    ['dc_c', 'outputs:ERROR AttributeError|ERROR AttributeError'],
  ]);
  const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, SIG.get(o.applied.candidate.id) ?? '']));

  it('every passer of the recorded pool carries a shape signal, and `adds_special_case` is NOT one of them', () => {
    for (const o of goldFreePool()) {
      const s = suspicionSignals(o, DC_GOAL);
      expect(s.some((x) => POOL_SUSPECT_SIGNALS.has(x))).toBe(true);
      expect(s).toContain('late_guard');
    }
    // the gold carries only the ranking signal, which is exactly why the count cannot be the evidence
    expect(suspicionSignals(goldPasser(), DC_GOAL)).toEqual(['adds_special_case']);
    expect(POOL_SUSPECT_SIGNALS.has('adds_special_case')).toBe(false);
  });

  /**
   * The membership rule, and what breaking it cost. A signal may only say "this pool has no gold"
   * when it has been SWEPT against the golds and found on none of them; `late_guard` and
   * `mutates_new_argument` have been, the other four have not. `deletes_statement` is the proof:
   * it fires on a gold-shaped REWRITE, which deletes statements by construction. Ladder `units`
   * with Jev ON (run `20260922-165453-txeukybg`) dropped its three passers because the pick
   * `composite/donor_body_unit:parse_size:2stmt at src/units.py:25:replace`
   * (`deletes_statement, adds_special_case`) answered general 0.50 < 0.7 — and the `units` gold
   * IS a rewrite of `parse_duration`'s three statements into five. That task passed before the
   * rule and `replan_stop`s at 15 steps with `deletes_statement` in the set.
   */
  it('only a signal with a gold sweep behind it may call a pool gold-free; a rewrite`s `deletes_statement` may not', () => {
    expect([...POOL_SUSPECT_SIGNALS].sort()).toEqual(['late_guard', 'mutates_new_argument']);
    for (const s of ['adds_special_case', 'deletes_statement', 'duplicates_block', 'guards_other_variable', 'dead_guard'] as const) expect(POOL_SUSPECT_SIGNALS.has(s)).toBe(false);
    // and they are all still signals: the lone-passer advisory sees every one of them
    for (const s of POOL_SUSPECT_SIGNALS) expect(SUSPICION_SIGNAL_WHY[s]).toBeTruthy();
  });

  it('the pool is no longer committed by a code rule: Q15/Q16 is asked, the signals are in the state, and the recorded 0.44 refuses the pick', async () => {
    const mem = createGuardMemory(DC_BASE);
    const notes: string[] = [];
    const ask = replay({ cand_01: 0.52, cand_02: 0.2, cand_03: 0.1, [ESCAPE_KEY]: 0.18 }, { cand_01: RECORDED_NOUL, cand_02: 0.22, cand_03: 0.1 });
    const d = await decide(goldFreePool(), mem, DC_GOAL, ask, { probe, oracle: { runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: 1000, runTimeoutMs: 30_000, baselineDurationMs: 300 }, inputs: () => Promise.resolve([]), note: (n) => notes.push(n) });
    expect(d).toMatchObject({ kind: 'continue', arbitrated: true, requests: 1, dropped: 3, codeRule: null });
    expect(ask.calls).toHaveLength(1);
    const state = ask.calls[0]!.state as { signals?: Record<string, string[]> };
    expect(Object.keys(state.signals ?? {}).length).toBeGreaterThanOrEqual(2);
    expect(Object.values(state.signals ?? {}).flat()).toContain(SUSPICION_SIGNAL_WHY.late_guard);
    expect(notes.some((n) => n.includes('gold-free pool'))).toBe(true);
    expect(notes.some((n) => n.includes(`general ${RECORDED_NOUL.toFixed(2)} < ${LONE_PASSER_VOUCH_MIN_NOUL}`))).toBe(true);
  });

  it('the same pool with ONE structurally clean contender is not a gold-free pool: the batch is decided as before and nothing is dropped', async () => {
    const mem = createGuardMemory(DC_BASE);
    const passers = [...goldFreePool(), goldPasser()];
    const sig = new Map([...SIG, ['dc_gold', 'outputs:False|True']]);
    const withGold = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, sig.get(o.applied.candidate.id) ?? '']));
    const clusters = clusterByBehaviour(passers, sig);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters.map(clusterSupport).every((n) => n >= 1)).toBe(true);
    const notes: string[] = [];
    const d = await decide(passers, mem, DC_GOAL, replay({}, {}), { probe: withGold, oracle: { runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: 1000, runTimeoutMs: 30_000, baselineDurationMs: 300 }, inputs: () => Promise.resolve([]), note: (n) => notes.push(n) });
    // the clean contender's presence is what makes the pool decidable: nothing is dropped, and the
    // gold-free rule stays silent, so `fewestSpecialCases` / `probeMajorityCluster` keep their ground
    expect(d).toMatchObject({ kind: 'commit', dropped: 0 });
    expect(notes.some((n) => n.includes('gold-free pool'))).toBe(false);
    // seedOnlySplit is unchanged by any of this: the class A′ rule still reads the clusters
    expect(typeof seedOnlySplit(clusters)).toBe('boolean');
  });

  it('a vouched pick of a suspect pool is still committed: the bound is the lone-passer rule, not a new refusal', async () => {
    const mem = createGuardMemory(DC_BASE);
    const ask = replay({ cand_01: 0.7, cand_02: 0.2, cand_03: 0.1 }, { cand_01: 0.9, cand_02: 0.1, cand_03: 0.1 });
    const d = await decide(goldFreePool(), mem, DC_GOAL, ask, { probe, oracle: { runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: 1000, runTimeoutMs: 30_000, baselineDurationMs: 300 }, inputs: () => Promise.resolve([]) });
    expect(d).toMatchObject({ kind: 'commit', arbitrated: true, requests: 1 });
  });
});
