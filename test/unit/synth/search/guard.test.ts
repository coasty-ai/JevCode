import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ExecResult, Json, SynthesisContext } from '../../../../src/core/types.js';
import type { LanePool } from '../../../../src/synth/sieve/lanes.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { appliedOnCommitted, createGuardMemory, forgetGoal, guardState, improvedBase, siteKeyOf } from '../../../../src/synth/search/bases.js';
import {
  ARBITRATE_TASK,
  GENUINE_FIX_INSTRUCTIONS,
  HOLD_RESERVE_RUNS,
  HOLD_RESERVE_WALL_MS,
  LONE_PASSER_HOLD_MAX_NOUL,
  LONE_PASSER_VOUCH_MIN_NOUL,
  MAX_PERTURBED_INPUTS,
  OVERRIDE_HIGH,
  OVERRIDE_LOW,
  SINGLE_CLUSTER_MAX_MEMBERS,
  SUSPECT_ESCAPE_MIN,
  SUSPECT_NOUL_MAX,
  adviseLonePasser,
  arbitrate,
  behaviourProbeCommand,
  budgetAllowsHold,
  clusterByBehaviour,
  commitSuspect,
  createDecide,
  decide,
  editCost,
  generalInstructions,
  guardSubjects,
  isPlausible,
  linkedListInputs,
  linkedListShape,
  minEdit,
  noneDereference,
  p2pVector,
  parseBehaviourProbe,
  parseQuixbugsCall,
  perturbedInputs,
  perturbedInputsFromCases,
  probeTimeoutMs,
  representativesOf,
  mostPassing,
  sieveHoldApplies,
  siteBatchDone,
  STRONG_SIGNALS_MIN,
  suspicionSignals,
} from '../../../../src/synth/search/guard.js';
import type { HoldBudget, PerturbedInput } from '../../../../src/synth/search/guard.js';
import type { Base, Goal, VerifyOutcome } from '../../../../src/synth/search/types.js';
import type { Candidate } from '../../../../src/synth/types.js';
import {
  DEPTH_FIRST_SEARCH,
  DEPTH_FIRST_SEARCH_FAILURES,
  DEPTH_FIRST_SEARCH_LINE,
  DEPTH_FIRST_SEARCH_OVERFITS,
  DETECT_CYCLE,
  DETECT_CYCLE_FAILURES,
  DETECT_CYCLE_GOLD,
  DETECT_CYCLE_LINE,
  DETECT_CYCLE_TAIL,
  NODE,
  WRAP,
  WRAP_FAILURES,
  WRAP_GOLD,
  WRAP_GOLD_LINE,
  detectCycleOverfit,
  quixbugsTestFile,
  wrapOverfit,
  NEXT_PERMUTATION,
  NEXT_PERMUTATION_FAILURES,
  NEXT_PERMUTATION_LINE,
  NEXT_PERMUTATION_PLAUSIBLE,
  QUIXBUGS_DIR,
  arbitrationScript,
  candidate,
  committedBase,
  failure,
  goal,
  oracle,
  outcome,
  partialOutcome,
  plausibleOutcome,
  quixbugsProgram,
  scriptedAsk,
  siteAt,
  sourceFile,
  summary,
  throwingAsk,
} from './helpers.js';

// next_permutation: 8 JSON cases, 2 fail on the buggy program.
const NP_BASELINE = summary({ passed: 6, failing: NEXT_PERMUTATION_FAILURES.map((f) => f.testId), failures: NEXT_PERMUTATION_FAILURES });
const NP_BASE: Base = committedBase(NEXT_PERMUTATION, NP_BASELINE);
const NP_SITE = siteAt(NEXT_PERMUTATION, NEXT_PERMUTATION_LINE);
const NP_GOAL = goal(NEXT_PERMUTATION_FAILURES);
const npCands: Candidate[] = NEXT_PERMUTATION_PLAUSIBLE.map((t, i) => candidate(NP_SITE, t, { id: `np${i + 1}` }));
const npPlausible = (): VerifyOutcome[] => npCands.map((c) => plausibleOutcome(c, NP_BASE));
const text = (o: VerifyOutcome): string => o.applied.candidate.text.trim();

// depth_first_search: 5 module tests, 1 fails on the buggy program (pytest-style: no call inputs).
const DFS_BASELINE = summary({ passed: 4, failing: DEPTH_FIRST_SEARCH_FAILURES.map((f) => f.testId), failures: DEPTH_FIRST_SEARCH_FAILURES });
const DFS_BASE: Base = committedBase(DEPTH_FIRST_SEARCH, DFS_BASELINE);
const DFS_SITE = siteAt(DEPTH_FIRST_SEARCH, DEPTH_FIRST_SEARCH_LINE);
const DFS_GOAL = goal(DEPTH_FIRST_SEARCH_FAILURES);
const dfsPlausible = (): VerifyOutcome[] => DEPTH_FIRST_SEARCH_OVERFITS.map((t, i) => plausibleOutcome(candidate(DFS_SITE, t, { id: `dfs${i + 1}` }), DFS_BASE));

describe('perturbedInputs: code-derived extra inputs from the goal tests', () => {
  it('±1 on ints, drop/dup/empty/singleton on lists, swap of same-typed args; originals excluded, deduplicated', () => {
    const g = goal([failure('kth([1, 2, 3, 4], 2)', '3', '2'), failure('gcd(35, 21)', '7', '35')]);
    const inputs = perturbedInputs(g, oracle());
    const kinds = new Set(inputs.map((i) => i.how));
    expect([...kinds].sort()).toEqual(['int_minus_one', 'int_plus_one', 'list_drop_first', 'list_drop_last', 'list_dup_first', 'list_dup_last', 'list_empty', 'list_singleton', 'swap_same_type_args']);
    const asText = inputs.map((i) => JSON.stringify(i.input));
    expect(new Set(asText).size).toBe(asText.length);
    expect(asText).not.toContain('[[1,2,3,4],2]');
    expect(asText).not.toContain('[35,21]');
    expect(asText).toContain('[21,35]');
    expect(asText).toContain('[[2,3,4],2]');
    expect(asText).toContain('[[],2]');
    expect(asText).toContain('[[1,2,3,4],3]');
    expect(inputs.every((i) => i.derivedFrom === 'kth([1, 2, 3, 4], 2)' || i.derivedFrom === 'gcd(35, 21)')).toBe(true);
    expect(inputs.length).toBeLessThanOrEqual(MAX_PERTURBED_INPUTS);
  });
  it('is bounded and round-robins over the tests so one test does not take every slot', () => {
    const g = goal(Array.from({ length: 6 }, (_, k) => failure(`f([${k}, ${k + 1}, ${k + 2}], ${k})`)));
    const inputs = perturbedInputs(g, oracle(), 6);
    expect(inputs).toHaveLength(6);
    expect(new Set(inputs.map((i) => i.derivedFrom)).size).toBe(6);
  });
  it('pytest and unknown runners get none (the P2P vector is the signature there)', () => {
    expect(perturbedInputs(NP_GOAL, oracle({ runner: 'pytest' }))).toEqual([]);
    expect(perturbedInputs(NP_GOAL, oracle({ runner: 'other' }))).toEqual([]);
  });
  it('parseQuixbugsCall: JSON args, null for pytest ids and truncated calls', () => {
    expect(parseQuixbugsCall('gcd(13, 13)')).toEqual({ name: 'gcd', args: [13, 13] });
    expect(parseQuixbugsCall('hanoi(3, 1, 3)')).toEqual({ name: 'hanoi', args: [3, 1, 3] });
    expect(parseQuixbugsCall('shunting_yard([10, "-", 5, "-", 2])')).toEqual({ name: 'shunting_yard', args: [[10, '-', 5, '-', 2]] });
    expect(parseQuixbugsCall('test5: Case 5: Graph with cycles')).toBeNull();
    expect(parseQuixbugsCall('tests/test_x.py::test_a')).toBeNull();
    expect(parseQuixbugsCall('lis([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12…')).toBeNull();
  });
});

describe('clusterByBehaviour: identical behaviour → one cluster, min-edit representative', () => {
  it('the 7 depth_first_search overfits share the P2P vector and collapse to one cluster', () => {
    const clusters = clusterByBehaviour(dfsPlausible());
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toHaveLength(7);
    expect(clusters[0]?.id).toBe('cluster_1');
    // the measured min-edit member (minEditTop cand_02): one identifier substituted
    expect(text(clusters[0]!.representative)).toBe('search_from(goalnode) for nextnode in node.successors');
    expect(clusters[0]?.signature).toBe(p2pVector(dfsPlausible()[0]!));
  });
  it('probe signatures split the set; clusters are ordered by size, members by edit cost', () => {
    const outcomes = dfsPlausible();
    const sig = new Map<string, string>();
    outcomes.forEach((o, i) => sig.set(o.applied.candidate.id, i < 2 ? 'A' : i < 6 ? 'B' : 'C'));
    const clusters = clusterByBehaviour(outcomes, sig);
    expect(clusters.map((c) => c.members.length)).toEqual([4, 2, 1]);
    expect(clusters.map((c) => c.id)).toEqual(['cluster_1', 'cluster_2', 'cluster_3']);
    for (const c of clusters) {
      const costs = c.members.map((m) => editCost(m.applied.candidate));
      expect(costs).toEqual([...costs].sort((a, b) => a - b));
    }
  });
  it('the probe signature is joined with the P2P vector: same outputs on the perturbed inputs but a different suite vector never share a cluster', () => {
    const [a, b] = npPlausible();
    const other = summary({ passed: 7, failing: [], passing: [], total: 8 });
    const c: VerifyOutcome = { ...b!, full: other, subset: other, status: 'plausible' };
    const sig = new Map([[a!.applied.candidate.id, 'same'], [c.applied.candidate.id, 'same']]);
    const clusters = clusterByBehaviour([a!, c], sig);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((k) => k.signature)).toEqual([`${p2pVector(a!)}|same`, `${p2pVector(c)}|same`]);
  });
  it('next_permutation: `perm[j] > perm[i]` and the gold `perm[i] < perm[j]` are one cluster, the three `>=` forms another', () => {
    const outcomes = npPlausible();
    const sig = new Map<string, string>();
    for (const o of outcomes) sig.set(o.applied.candidate.id, /perm\[j\] > perm\[i\]|perm\[i\] < perm\[j\]/.test(text(o)) ? 'strict' : 'non_strict');
    const clusters = clusterByBehaviour(outcomes, sig);
    expect(clusters).toHaveLength(2);
    const [nonStrict, strict] = clusters;
    expect(nonStrict?.members.map(text)).toEqual(['if perm[j] >= perm[i]:', 'if not perm[j] < perm[i]:', 'if not (perm[j] < perm[i]):']);
    expect(text(nonStrict!.representative)).toBe('if perm[j] >= perm[i]:');
    expect(strict?.members.map(text)).toEqual(['if perm[j] > perm[i]:', 'if perm[i] < perm[j]:']);
    expect(text(strict!.representative)).toBe('if perm[j] > perm[i]:');
  });
  it('editCost counts token edits against the current line; inserts count their tokens plus extra edits', () => {
    expect(editCost(candidate(NP_SITE, '                if perm[j] > perm[i]:'))).toBe(1);
    expect(editCost(candidate(NP_SITE, '                if perm[i] < perm[j]:'))).toBe(2);
    const ins = candidate(siteAt(NEXT_PERMUTATION, 7, 'insert'), 'nodesvisited.add(node)', { extraEdits: [{ path: NEXT_PERMUTATION.path, line: 9, kind: 'delete' }] });
    expect(editCost(ins)).toBe(6 + 1);
    expect(text(minEdit(npPlausible()))).toBe('if perm[j] > perm[i]:');
  });
});

describe('behaviour probe (real python3, stdlib only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-guard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const buggy = quixbugsProgram('next_permutation');
  const variant = (name: string, line: string): string => {
    const p = join(dir, `${name}.py`);
    writeFileSync(p, buggy.replace('                if perm[j] < perm[i]:', `                ${line}`));
    return p;
  };
  const run = (cmd: string): string => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const inputs: PerturbedInput[] = [...perturbedInputs(NP_GOAL, oracle()), { input: [[1, 2, 1]], derivedFrom: 'extra', how: 'list_dup_first' }];

  it('equivalent lines give identical signatures; a boundary the tests cannot see separates on a duplicated element', () => {
    const sigs = new Map<string, string>();
    for (const [name, line] of [
      ['gold', 'if perm[i] < perm[j]:'],
      ['strict', 'if perm[j] > perm[i]:'],
      ['non_strict', 'if perm[j] >= perm[i]:'],
    ] as const) {
      const cmd = behaviourProbeCommand({ name: 'next_permutation', candidatePath: variant(name, line), inputs, perInputTimeoutMs: 1000, pythonPath: [join(QUIXBUGS_DIR, 'programs')] });
      expect(cmd.startsWith('PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 python3 - ')).toBe(true);
      const sig = parseBehaviourProbe(run(cmd));
      expect(sig).not.toBeNull();
      sigs.set(name, sig ?? '');
    }
    expect(sigs.get('gold')).toBe(sigs.get('strict'));
    expect(sigs.get('gold')).not.toBe(sigs.get('non_strict'));
    expect(sigs.get('gold')?.startsWith('outputs:')).toBe(true);
    expect(sigs.get('gold')?.split('\u001f')).toHaveLength(inputs.length);
  });
  it('import errors and per-input timeouts are behaviour too; garbage output is null', () => {
    const broken = join(dir, 'broken.py');
    writeFileSync(broken, 'def next_permutation(perm:\n    pass\n');
    expect(parseBehaviourProbe(run(behaviourProbeCommand({ name: 'next_permutation', candidatePath: broken, inputs, perInputTimeoutMs: 500 })))).toBe('import_error:SyntaxError');
    const looping = join(dir, 'looping.py');
    writeFileSync(looping, 'def next_permutation(perm):\n    if len(perm) == 0:\n        while True:\n            pass\n    print("noise on stdout")\n    return len(perm)\n');
    const only: PerturbedInput[] = [
      { input: [[1, 2]], derivedFrom: 't', how: 'list_drop_first' },
      { input: [[]], derivedFrom: 't', how: 'list_empty' },
    ];
    const sig = parseBehaviourProbe(run(behaviourProbeCommand({ name: 'next_permutation', candidatePath: looping, inputs: only, perInputTimeoutMs: 200 })));
    expect(sig).toBe('outputs:2\u001fTIMEOUT');
    expect(parseBehaviourProbe('Traceback (most recent call last): boom')).toBeNull();
    expect(probeTimeoutMs(only.length, 200)).toBe(2400);
  });
});

describe('arbitrate: Q15 + Q16 in one request, measured wording and state shape', () => {
  it('request shape: genuine_fix Choice with escape + general_cand_xx Nouls, candidates keyed cand_xx', async () => {
    const outcomes = npPlausible();
    const sig = new Map<string, string>();
    for (const o of outcomes) sig.set(o.applied.candidate.id, /perm\[j\] > perm\[i\]|perm\[i\] < perm\[j\]/.test(text(o)) ? 'strict' : 'non_strict');
    const clusters = clusterByBehaviour(outcomes, sig);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.79, 'if perm[j] >= perm[i]:': 0.02 }, escape: 0.06, noul: { 'if perm[j] > perm[i]:': 0.65, 'if perm[j] >= perm[i]:': 0.22 } }));
    const arb = await arbitrate({ goal: NP_GOAL }, clusters, ask);

    expect(ask.calls).toHaveLength(1);
    const call = ask.calls[0]!;
    expect(call.stage).toBe('propose');
    expect(Object.keys(call.questions)).toEqual(['genuine_fix', 'general_cand_01', 'general_cand_02']);
    const q15 = call.questions['genuine_fix']!;
    expect(q15.type).toBe('choice');
    expect(q15.instructions).toBe(GENUINE_FIX_INSTRUCTIONS);
    if (q15.type === 'choice') {
      expect(Object.keys(q15.criteria)).toEqual(['cand_01', 'cand_02', ESCAPE_KEY]);
      expect(q15.criteria['cand_01']).toBe('L6: if perm[j] >= perm[i]:');
      expect(q15.criteria['cand_02']).toBe('L6: if perm[j] > perm[i]:');
    }
    const q16 = call.questions['general_cand_01']!;
    expect(q16.type).toBe('noul');
    expect(q16.instructions).toBe(generalInstructions('cand_01'));
    expect(q16.instructions).toBe('Is `candidates.cand_01` a correct general fix: with this replacement, does `program` compute the right result for every valid input, not just for the listed `tests`?');
    const state = call.state as { [k: string]: Json };
    expect(state['task']).toBe(ARBITRATE_TASK);
    expect(state['candidates']).toEqual({
      cand_01: { line: 'L6', replaces: 'if perm[j] < perm[i]:', with: 'if perm[j] >= perm[i]:' },
      cand_02: { line: 'L6', replaces: 'if perm[j] < perm[i]:', with: 'if perm[j] > perm[i]:' },
    });
    expect(state['tests']).toEqual(NEXT_PERMUTATION_FAILURES.map((f) => ({ input: f.call, expected: f.expected })));
    expect(state['buggy_program_failure']).toEqual({ input: 'next_permutation([3, 2, 4, 1])', expected: '[3, 4, 1, 2]', actual: '[3, 4, 2, 1]' });
    const program = state['program'] as Record<string, string>;
    expect(Object.keys(program)).toEqual(['L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10']);
    expect(program['L6']).toBe('                if perm[j] < perm[i]:');
    expect(call).toMatchSnapshot();

    expect(text(arb.pick)).toBe('if perm[j] > perm[i]:');
    expect(arb.fallbacks.map(text)).toEqual(['if perm[j] >= perm[i]:']);
    expect(arb.pEscape).toBeCloseTo(0.07, 2);
    expect(arb.pChoice['cand_02']).toBeCloseTo(0.91, 2);
    expect(arb.noul).toEqual({ cand_01: 0.22, cand_02: 0.65 });
    expect(arb.suspect).toBe(false);
    expect(arb.requests).toBe(1);
    expect(arb.representatives.map((r) => r.key)).toEqual(['cand_01', 'cand_02']);
  });
  it('a single cluster of ≥ 2 passers is still arbitrated over its ≤ 5 smallest-edit members', () => {
    const reps = representativesOf(clusterByBehaviour(dfsPlausible()));
    expect(reps).toHaveLength(SINGLE_CLUSTER_MAX_MEMBERS);
    expect(reps.map((r) => r.key)).toEqual(['cand_01', 'cand_02', 'cand_03', 'cand_04', 'cand_05']);
    expect(text(reps[0]!.outcome)).toBe('search_from(goalnode) for nextnode in node.successors');
    const many = clusterByBehaviour(dfsPlausible(), new Map(dfsPlausible().map((o, i) => [o.applied.candidate.id, `s${i}`])));
    expect(representativesOf(many)).toHaveLength(7);
  });
  it('the program listing is the whole file when it fits (measured shape): a nested function shows its enclosing function too', async () => {
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.6 }, escape: 0.1, noul: {} }));
    await arbitrate({ goal: DFS_GOAL }, clusterByBehaviour(dfsPlausible()), ask);
    const program = (ask.calls[0]!.state as { program: Record<string, string> }).program;
    expect(Object.keys(program)).toEqual(['L1', 'L2', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L14']);
    expect(program['L2']).toBe('    nodesvisited = set()');
    expect(program['L14']).toBe('    return search_from(startnode)');
  });
  it('insert-site candidates say where they go; a lone representative is refused', async () => {
    const ins = siteAt(DEPTH_FIRST_SEARCH, 6, 'insert');
    const a = plausibleOutcome(candidate(ins, '        nodesvisited.add(node)', { id: 'ins1' }), DFS_BASE);
    const b = plausibleOutcome(candidate(DFS_SITE, DEPTH_FIRST_SEARCH_OVERFITS[0]!, { id: 'rep1' }), DFS_BASE);
    const clusters = clusterByBehaviour([a, b], new Map([['ins1', 'x'], ['rep1', 'y']]));
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nodesvisited.add(node)': 0.8 }, escape: 0.1, noul: { 'nodesvisited.add(node)': 0.77 } }));
    const arb = await arbitrate({ goal: DFS_GOAL, stage: 'judge' }, clusters, ask);
    expect(ask.calls[0]?.stage).toBe('judge');
    const state = ask.calls[0]!.state as { candidates: Record<string, Json> };
    expect(Object.values(state.candidates)).toContainEqual({ line: 'L6', replaces: null, with: 'nodesvisited.add(node)', position: 'inserted before L6' });
    const q = ask.calls[0]!.questions['genuine_fix']!;
    if (q.type === 'choice') expect(Object.values(q.criteria)).toContain('insert before L6: nodesvisited.add(node)');
    expect(text(arb.pick)).toBe('nodesvisited.add(node)');
    await expect(arbitrate({ goal: DFS_GOAL }, clusters.slice(0, 1), ask)).rejects.toThrow(/at least two representatives/);
  });
});

describe('decide: the §2.6 table', () => {
  it('nothing plausible, nothing partial → continue without Jev and without a base', async () => {
    const mem = createGuardMemory(NP_BASE);
    const regressed = outcome(npCands[0]!, NP_BASE, { subset: summary({ passed: 5, failing: ['next_permutation([3, 4, 5])', ...NP_BASELINE.failing] }) });
    const unchanged = outcome(npCands[1]!, NP_BASE, { subset: NP_BASELINE });
    const timedOut = outcome(npCands[2]!, NP_BASE, { subset: summary({ passed: 0, failing: ['<test run>'], timedOut: true }), status: 'timeout' });
    const d = await decide([regressed, unchanged, timedOut], mem, NP_GOAL, throwingAsk);
    expect(d).toEqual({ kind: 'continue', plausible: 0, clusters: 0, arbitrated: false, requests: 0, fallbacks: [], probeError: null, held: null, signals: [] });
    expect(improvedBase(mem)).toBeUndefined();
    expect(guardState(mem).suspect).toBeNull();
  });
  it('0 plausible with partials → holdBestPartial keeps the best one as the improved base, continue', async () => {
    const mem = createGuardMemory(NP_BASE);
    const one = partialOutcome(npCands[0]!, NP_BASE, [NEXT_PERMUTATION_FAILURES[0]!.testId]);
    const d = await decide([one], mem, NP_GOAL, throwingAsk);
    expect(d.kind).toBe('continue');
    const held = improvedBase(mem);
    expect(held?.origin).toBe('improved');
    expect(held?.fromGoal).toBe('g1');
    expect(held?.summary.passed).toBe(7);
    expect(held?.candidate?.candidate.id).toBe('np1');
    expect(held?.depth).toBe(1);
  });
  it('exactly one plausible → commit with no Jev gate at all', async () => {
    const mem = createGuardMemory(NP_BASE);
    const only = plausibleOutcome(npCands[3]!, NP_BASE);
    const partial = partialOutcome(npCands[0]!, NP_BASE, [NEXT_PERMUTATION_FAILURES[0]!.testId]);
    const d = await decide([partial, only], mem, NP_GOAL, throwingAsk);
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') {
      expect(d.applied).toBe(only.applied);
      expect(d.allGoalTestsPass).toBe(true);
      expect(d.note).toBeUndefined();
    }
    expect(d).toMatchObject({ plausible: 1, clusters: 1, arbitrated: false, requests: 0 });
    expect(improvedBase(mem)).toBeUndefined();
  });
  it('a "plausible" status without a full-suite run is not plausible (the regression run is part of the definition)', () => {
    const all = summary({ passed: 8, failing: [] });
    const noFull = outcome(npCands[0]!, NP_BASE, { subset: all, status: 'plausible' });
    expect(isPlausible(noFull, NP_GOAL)).toBe(false);
    expect(isPlausible(plausibleOutcome(npCands[0]!, NP_BASE), NP_GOAL)).toBe(true);
    const regressedFull = outcome(npCands[0]!, NP_BASE, { subset: all, full: summary({ passed: 7, failing: ['next_permutation([3, 4, 5])'] }), status: 'plausible' });
    expect(isPlausible(regressedFull, NP_GOAL)).toBe(false);
    const runFailed = outcome(npCands[0]!, NP_BASE, { subset: all, full: summary({ passed: 7, failing: ['<test run>'] }), status: 'plausible' });
    expect(isPlausible(runFailed, NP_GOAL)).toBe(false);
  });
  it('a collection error is never plausible: nothing passed and an error the base did not have (its failing id is the module, not a goal test)', () => {
    const collection = summary({ passed: 0, errors: 1, failing: ['tests/test_np.py'], passing: [] });
    const o = outcome(npCands[0]!, NP_BASE, { subset: collection, full: collection, status: 'plausible' });
    expect(isPlausible(o, NP_GOAL)).toBe(false);
    const erroring = summary({ passed: 8, errors: 1, failing: [] });
    expect(isPlausible(outcome(npCands[0]!, NP_BASE, { subset: erroring, full: erroring, status: 'plausible' }), NP_GOAL)).toBe(false);
  });
  it('among plausible candidates the one whose full suite passes the most tests wins before any Jev is asked (mostPassing)', async () => {
    // g1's tests pass under both; only the second also turns a sibling test green (a real fix vs a special case)
    const mem = createGuardMemory(NP_BASE);
    const narrow = outcome(npCands[0]!, NP_BASE, { subset: summary({ passed: 7, failing: ['other'] }), full: summary({ passed: 7, failing: ['other'] }), status: 'plausible' });
    const wide = plausibleOutcome(npCands[3]!, NP_BASE);
    expect(mostPassing([narrow, wide]).map((o) => o.applied.candidate.id)).toEqual([wide.applied.candidate.id]);
    expect(mostPassing([narrow, outcome(npCands[1]!, NP_BASE, { subset: summary({ passed: 7, failing: ['other'] }), full: summary({ passed: 7, failing: ['other'] }), status: 'plausible' })])).toHaveLength(2);
    const d = await decide([narrow, wide], mem, NP_GOAL, throwingAsk);
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe(wide.applied.candidate.id);
    expect(d).toMatchObject({ plausible: 1, arbitrated: false, requests: 0 });
  });
  it('plausible is goal-relative: a fix of this goal commits (allGoalTestsPass) while another goal\'s tests still fail in the full suite', async () => {
    // two goals on one file: g1 = the two next_permutation failures, g2 = an unrelated failing test
    const otherTest = 'next_permutation([9, 9])';
    const baseline = summary({ passed: 5, failing: [...NEXT_PERMUTATION_FAILURES.map((f) => f.testId), otherTest], failures: [...NEXT_PERMUTATION_FAILURES, failure(otherTest)] });
    const base = committedBase(NEXT_PERMUTATION, baseline);
    const mem = createGuardMemory(base);
    const after = summary({ passed: 7, failing: [otherTest], total: 8 });
    const fixesG1 = outcome(npCands[3]!, base, { subset: after, full: after, status: 'plausible' });
    expect(fixesG1.progress.allPass).toBe(false);
    expect(isPlausible(fixesG1, NP_GOAL)).toBe(true);
    expect(isPlausible(fixesG1, goal([failure(otherTest)], { id: 'g2' }))).toBe(false);
    const d = await decide([fixesG1], mem, NP_GOAL, throwingAsk);
    expect(d).toMatchObject({ kind: 'commit', allGoalTestsPass: true, plausible: 1 });
    if (d.kind === 'commit') expect(d.applied).toBe(fixesG1.applied);
    // for g2 the same outcome is only a partial (held), never a commit
    const d2 = await decide([fixesG1], mem, goal([failure(otherTest)], { id: 'g2' }), throwingAsk);
    expect(d2.kind).toBe('continue');
    expect(improvedBase(mem)?.fromGoal).toBe('g2');
  });
  it('a passer found on the improved base is committed as one patch of the committed workspace (both edits, applies cleanly)', async () => {
    const mem = createGuardMemory(NP_BASE);
    const first = partialOutcome(candidate(siteAt(NEXT_PERMUTATION, 3), '    for i in range(len(perm) - 2, -1, -1):  # step one', { id: 'step1' }), NP_BASE, [NEXT_PERMUTATION_FAILURES[0]!.testId]);
    await decide([first], mem, NP_GOAL, throwingAsk);
    const held = improvedBase(mem)!;
    expect(held.depth).toBe(1);
    const siteOnHeld = siteAt(held.files.get(NEXT_PERMUTATION.path)!, NEXT_PERMUTATION_LINE);
    const second = plausibleOutcome(candidate(siteOnHeld, '                if perm[i] < perm[j]:', { id: 'step2' }), held);
    expect(second.applied.diff).not.toContain('+    for i in range(len(perm) - 2, -1, -1):  # step one');
    const d = await decide([second], mem, NP_GOAL, throwingAsk);
    expect(d.kind).toBe('commit');
    if (d.kind !== 'commit') return;
    expect(d.applied.candidate.id).toBe('step2');
    expect(d.applied.files).toHaveLength(1);
    expect(d.applied.files[0]?.before).toBe(NEXT_PERMUTATION.src);
    expect(d.applied.diff).toContain('+    for i in range(len(perm) - 2, -1, -1):  # step one');
    expect(d.applied.diff).toContain('+                if perm[i] < perm[j]:');
    expect(d.applied.diff).toContain('-                if perm[j] < perm[i]:');
    expect(d.applied.files[0]?.after).toBe(second.applied.files[0]?.after);
    expect(appliedOnCommitted(mem, first)).toBe(first.applied);
  });
  it('≥ 2 plausible → cluster, arbitrate, commit the Choice argmax with the others as fallbacks (measured next_permutation numbers)', async () => {
    const mem = createGuardMemory(NP_BASE);
    const probe = async (plausible: readonly VerifyOutcome[], inputs: readonly PerturbedInput[]): Promise<ReadonlyMap<string, string>> => {
      expect(inputs.length).toBeGreaterThan(0);
      return new Map(plausible.map((o) => [o.applied.candidate.id, /perm\[j\] > perm\[i\]|perm\[i\] < perm\[j\]/.test(text(o)) ? 'strict' : 'non_strict']));
    };
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.79, 'if perm[j] >= perm[i]:': 0.02 }, escape: 0.06, noul: { 'if perm[j] > perm[i]:': 0.65, 'if perm[j] >= perm[i]:': 0.22 } }));
    const d = await decide(npPlausible(), mem, NP_GOAL, ask, { oracle: oracle(), probe });
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.text.trim()).toBe('if perm[j] > perm[i]:');
    expect(d).toMatchObject({ plausible: 5, clusters: 2, arbitrated: true, requests: 1 });
    expect(d.fallbacks.map(text)).toEqual(['if perm[j] >= perm[i]:']);
    expect(guardState(mem).fallbacks).toEqual({ goalId: 'g1', outcomes: d.fallbacks });
    expect(d.probeError).toBeNull();
    expect(ask.calls).toHaveLength(1);
    forgetGoal(mem, NP_GOAL);
    expect(guardState(mem).fallbacks).toBeNull();
  });
  it('a failing probe degrades to P2P clustering and reports the error; it never aborts a step with passers', async () => {
    const mem = createGuardMemory(NP_BASE);
    const probe = async (): Promise<ReadonlyMap<string, string>> => {
      throw new Error('lane 3: python3 not found');
    };
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.79 }, escape: 0.06, noul: { 'if perm[j] > perm[i]:': 0.65 } }));
    const d = await decide(npPlausible(), mem, NP_GOAL, ask, { oracle: oracle(), probe });
    expect(d).toMatchObject({ kind: 'commit', plausible: 5, clusters: 1, arbitrated: true, probeError: 'lane 3: python3 not found' });
    if (d.kind === 'commit') expect(text({ applied: d.applied } as VerifyOutcome)).toBe('if perm[j] > perm[i]:');
  });
  it('without a probe the P2P vectors alone cluster (pytest): one cluster, ≤ 5 members offered', async () => {
    const mem = createGuardMemory(DFS_BASE);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.6 }, escape: 0.1, noul: { 'nextnode for nextnode in node.successors': 0.8 } }));
    const d = await decide(dfsPlausible(), mem, DFS_GOAL, ask, { oracle: oracle({ runner: 'pytest' }) });
    expect(d).toMatchObject({ kind: 'commit', plausible: 7, clusters: 1, arbitrated: true });
    const q = ask.calls[0]!.questions['genuine_fix']!;
    if (q.type === 'choice') expect(Object.keys(q.criteria)).toHaveLength(SINGLE_CLUSTER_MAX_MEMBERS + 1);
  });
  it('the suspect signature (depth_first_search: escape 0.90, max Noul 0.06) → guardState(mem).suspect = min-edit, continue; committed at step end as possible overfit', async () => {
    const mem = createGuardMemory(DFS_BASE);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.1 }, escape: 0.9, noul: { 'nextnode for nextnode in node.successors': 0.06, 'search_from(goalnode) for nextnode in node.successors': 0.03, 'node for nextnode in node.successors': 0.04, 'any for nextnode in node.successors': 0.04, 'goalnode for nextnode in node.successors': 0.04 } }));
    const d = await decide(dfsPlausible(), mem, DFS_GOAL, ask);
    expect(d).toEqual({ kind: 'continue', plausible: 7, clusters: 1, arbitrated: true, requests: 1, fallbacks: [], probeError: null, held: 'suspect', signals: [] });
    expect(guardState(mem).suspect).not.toBeNull();
    expect(guardState(mem).suspect?.goalId).toBe('g1');
    expect(text(guardState(mem).suspect!.outcome)).toBe('search_from(goalnode) for nextnode in node.successors');
    expect(guardState(mem).fallbacks).toBeNull();
    expect(SUSPECT_ESCAPE_MIN).toBe(0.8);
    expect(SUSPECT_NOUL_MAX).toBe(0.1);

    // the suspect belongs to its goal: another goal's step end does not commit it, forgetGoal drops it
    const suspect = guardState(mem).suspect!;
    expect(commitSuspect(mem, { id: 'g2' })).toBeNull();
    expect(guardState(mem).suspect).toBe(suspect);
    const end = commitSuspect(mem, DFS_GOAL);
    // the commit carries the shadow run it rests on (search/proposal.ts turns it into Proposal.evidence)
    expect(end).toEqual({ kind: 'commit', applied: suspect.outcome.applied, allGoalTestsPass: true, note: 'possible overfit', outcome: suspect.outcome });
    expect(guardState(mem).suspect).toBeNull();
    expect(commitSuspect(mem, DFS_GOAL)).toBeNull();
    await decide(dfsPlausible(), mem, DFS_GOAL, ask);
    expect(guardState(mem).suspect).not.toBeNull();
    forgetGoal(mem, DFS_GOAL);
    expect(guardState(mem).suspect).toBeNull();
  });
  it('escape high but a Noul ≥ 0.1 is not the signature: commit the argmax; escape 0.89 with Nouls ≤ 0.06 (wrap, §13) is', async () => {
    const mem = createGuardMemory(DFS_BASE);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.1 }, escape: 0.9, noul: { 'nextnode for nextnode in node.successors': 0.12 } }));
    const d = await decide(dfsPlausible(), mem, DFS_GOAL, ask);
    expect(d.kind).toBe('commit');
    expect(guardState(mem).suspect).toBeNull();
    const wrapLike = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.06, 'search_from(goalnode) for nextnode in node.successors': 0.05 }, escape: 0.89, noul: { 'nextnode for nextnode in node.successors': 0.06, 'search_from(goalnode) for nextnode in node.successors': 0.05 } }));
    const held = await decide(dfsPlausible().slice(0, 2), createGuardMemory(DFS_BASE), DFS_GOAL, wrapLike);
    expect(held).toMatchObject({ kind: 'continue', held: 'suspect', arbitrated: true });
  });
  it('override rule: Choice argmax with Noul < 0.3 loses to a representative with Noul ≥ 0.7', async () => {
    const mem = createGuardMemory(NP_BASE);
    const two = [npPlausible()[0]!, npPlausible()[1]!];
    const sig = new Map([[two[0]!.applied.candidate.id, 'a'], [two[1]!.applied.candidate.id, 'b']]);
    const probe = async (): Promise<ReadonlyMap<string, string>> => sig;
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.6, 'if perm[j] >= perm[i]:': 0.3 }, escape: 0.1, noul: { 'if perm[j] > perm[i]:': 0.2, 'if perm[j] >= perm[i]:': 0.8 } }));
    const d = await decide(two, mem, NP_GOAL, ask, { oracle: oracle(), probe });
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.text.trim()).toBe('if perm[j] >= perm[i]:');
    expect(d.fallbacks.map(text)).toEqual(['if perm[j] > perm[i]:']);
    expect(OVERRIDE_LOW).toBe(0.3);
    expect(OVERRIDE_HIGH).toBe(0.7);
  });
  it('the override needs both halves: an advisory Noul (0.45) on the argmax, or no confident alternative, leaves the Choice alone', async () => {
    const two = [npPlausible()[0]!, npPlausible()[1]!];
    const probe = async (): Promise<ReadonlyMap<string, string>> => new Map([[two[0]!.applied.candidate.id, 'a'], [two[1]!.applied.candidate.id, 'b']]);
    for (const nouls of [
      { 'if perm[j] > perm[i]:': 0.45, 'if perm[j] >= perm[i]:': 0.9 },
      { 'if perm[j] > perm[i]:': 0.15, 'if perm[j] >= perm[i]:': 0.6 },
    ]) {
      const mem = createGuardMemory(NP_BASE);
      const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.6, 'if perm[j] >= perm[i]:': 0.3 }, escape: 0.1, noul: nouls }));
      const d = await decide(two, mem, NP_GOAL, ask, { oracle: oracle(), probe });
      expect(d.kind === 'commit' ? d.applied.candidate.text.trim() : '').toBe('if perm[j] > perm[i]:');
    }
  });
  it('a malformed Jev answer is an error, never a silent commit', async () => {
    const mem = createGuardMemory(NP_BASE);
    const ask = scriptedAsk((questions) => Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.5 }])));
    await expect(decide(npPlausible(), mem, NP_GOAL, ask)).rejects.toThrow(/genuine_fix answer missing or not a choice/);
  });
});

// ---------------------------------------------------------------------------------------
// The two run-3 overfits (jev-only-quixbugs-3-inspection.md §1) and the within-step holds
// ---------------------------------------------------------------------------------------

const DC_BASELINE = { ...summary({ passed: 5, failing: DETECT_CYCLE_FAILURES.map((f) => f.testId), failures: DETECT_CYCLE_FAILURES, total: 6 }), outputTail: DETECT_CYCLE_TAIL };
const DC_BASE: Base = committedBase(DETECT_CYCLE, DC_BASELINE, [NODE]);
const DC_GOAL = goal(DETECT_CYCLE_FAILURES);
const DC_TEST_MODULE = quixbugsTestFile('detect_cycle_test.py');
const dcGoldCand = (): Candidate => candidate(siteAt(DETECT_CYCLE, DETECT_CYCLE_LINE), DETECT_CYCLE_GOLD, { id: 'dc_gold', op: 'condition_extension' });
const dcGold = (): VerifyOutcome => plausibleOutcome(dcGoldCand(), DC_BASE);
const dcOverfit = (): VerifyOutcome => plausibleOutcome(detectCycleOverfit(), DC_BASE);
const dcUnchanged = (line: number, text: string, source: Candidate['source'] = 'mutation'): VerifyOutcome => outcome(candidate(siteAt(DETECT_CYCLE, line), text, { source }), DC_BASE, { subset: DC_BASELINE });
const dcLinkedLists = (): PerturbedInput[] => linkedListInputs(linkedListShape(DC_TEST_MODULE, 'detect_cycle', [DETECT_CYCLE, NODE])!, 'tests/detect_cycle_test.py');

const WRAP_BASELINE = summary({ passed: 0, failing: WRAP_FAILURES.map((f) => f.testId), failures: WRAP_FAILURES, total: 5 });
const WRAP_BASE: Base = committedBase(WRAP, WRAP_BASELINE);
const WRAP_GOAL = goal(WRAP_FAILURES);
const wrapGold = (): VerifyOutcome => plausibleOutcome(candidate(siteAt(WRAP, WRAP_GOLD_LINE, 'insert'), WRAP_GOLD, { id: 'wrap_gold', source: 'template', op: 'insert_append' }), WRAP_BASE);
const wrapOver = (): VerifyOutcome => plausibleOutcome(wrapOverfit(), WRAP_BASE);

const OVERFIT_TEXT = 'if tortoise.successor is None:';
const ample: HoldBudget = { exhausted: () => false, testWallLeftMs: 60_000, testRunsLeft: 500, jevRequestsLeft: 20 };
const thin: HoldBudget = { exhausted: () => false, testWallLeftMs: HOLD_RESERVE_WALL_MS - 1, testRunsLeft: 500, jevRequestsLeft: 20 };

describe('rule (b): code-computed structural signals on a lone passer', () => {
  it('noneDereference: the attribute the tests crash on and the receivers on the traceback line of the site file', () => {
    expect(noneDereference(DETECT_CYCLE_FAILURES, DETECT_CYCLE_TAIL, DETECT_CYCLE)).toEqual({ attr: 'successor', receivers: new Set(['hare']), line: 5 });
    expect(noneDereference(DETECT_CYCLE_FAILURES, '', DETECT_CYCLE)).toBeNull();
    expect(noneDereference([failure('t', '1', 'AssertionError: assert not True')], DETECT_CYCLE_TAIL, DETECT_CYCLE)).toBeNull();
    expect(noneDereference([failure('t', '', "TypeError: 'NoneType' object is not subscriptable")], 'prog.py:3: TypeError', sourceFile('prog.py', 'def f(xs):\n    a = 1\n    return xs[0]\n'))).toEqual({ attr: null, receivers: new Set(['xs']), line: 3 });
  });
  it('guardSubjects: the None / falsy subjects a candidate adds (the current line\'s own are not additions)', () => {
    expect(guardSubjects(detectCycleOverfit())).toEqual(['tortoise.successor']);
    expect(guardSubjects(dcGoldCand())).toEqual(['hare']);
    expect(guardSubjects(candidate(siteAt(DETECT_CYCLE, 5), '        if not node or hare.successor is None:'))).toEqual(['node']);
    expect(guardSubjects(candidate(siteAt(DETECT_CYCLE, 5), '        if hare.successor is not None:'))).toEqual([]);
    expect(guardSubjects(candidate(siteAt(DETECT_CYCLE, 5), '        if not f(x) or hare.successor is None:'))).toEqual([]);
  });
  it('detect_cycle: the committed guard copies lines 5-6, names a variable the traceback never dereferences and guards an expression nothing reads; the gold and a genuine inserted guard are clean', () => {
    expect(suspicionSignals(dcOverfit(), DC_GOAL)).toEqual(['duplicates_block', 'guards_other_variable', 'dead_guard']);
    expect(suspicionSignals(dcGold(), DC_GOAL)).toEqual([]);
    const genuine = plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 5, 'insert'), '        if hare is None:\n            return False', { id: 'guard_before' }), DC_BASE);
    expect(suspicionSignals(genuine, DC_GOAL)).toEqual([]);
    // without the traceback line only the dead-guard signal remains
    const noTail = committedBase(DETECT_CYCLE, { ...DC_BASELINE, outputTail: '' }, [NODE]);
    expect(suspicionSignals(plausibleOutcome(detectCycleOverfit(), noTail), DC_GOAL)).toEqual(['duplicates_block', 'dead_guard']);
  });
  it('wrap: the loop copied under itself duplicates a block; the one-line gold does not; two lines sharing one with the function do not', () => {
    expect(suspicionSignals(wrapOver(), WRAP_GOAL)).toEqual(['duplicates_block']);
    expect(suspicionSignals(wrapGold(), WRAP_GOAL)).toEqual([]);
    const twoLines = plausibleOutcome(candidate(siteAt(WRAP, WRAP_GOLD_LINE, 'insert'), '    if text:\n        lines.append(text)', { id: 'two' }), WRAP_BASE);
    expect(suspicionSignals(twoLines, WRAP_GOAL)).toEqual([]);
  });
  it('deletes_statement: a delete extra edit or an empty / `pass` replacement', () => {
    const del = plausibleOutcome(candidate(siteAt(WRAP, 3), '    while len(text) >= cols:', { id: 'del', extraEdits: [{ path: WRAP.path, line: 8, kind: 'delete' }] }), WRAP_BASE);
    expect(suspicionSignals(del, WRAP_GOAL)).toEqual(['deletes_statement']);
    expect(suspicionSignals(plausibleOutcome(candidate(siteAt(WRAP, 8), '        pass', { id: 'pass' }), WRAP_BASE), WRAP_GOAL)).toEqual(['deletes_statement']);
  });
  it('adviseLonePasser: Q16 alone over the one-candidate arbitration state', async () => {
    const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: 0.12 } }));
    const adv = await adviseLonePasser({ goal: DC_GOAL }, dcOverfit(), ask);
    expect(adv).toMatchObject({ p: 0.12, requests: 1 });
    expect(ask.calls).toHaveLength(1);
    expect(Object.keys(ask.calls[0]!.questions)).toEqual(['general_cand_01']);
    expect(ask.calls[0]!.questions['general_cand_01']?.instructions).toBe(generalInstructions('cand_01'));
    const state = ask.calls[0]!.state as { candidates: Record<string, Json>; program: Record<string, string>; task: string };
    expect(state.task).toBe(ARBITRATE_TASK);
    expect(state.candidates).toEqual({ cand_01: { line: 'L10', replaces: null, with: OVERFIT_TEXT, position: 'inserted before L10', also_edits: [{ line: 'L10', kind: 'insert', text: 'return False' }] } });
    expect(state.program['L5']).toBe('        if hare.successor is None:');
  });
});

describe('rule (b) in decide: hold the doubted lone passer, arbitrate it against the gold when it arrives', () => {
  it('detect_cycle: held on Q16 0.12, kept through a passer-less batch, then two clusters and Q15 picks the gold', async () => {
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const ask = scriptedAsk(arbitrationScript({ choice: { [DETECT_CYCLE_GOLD.trim()]: 0.8, [OVERFIT_TEXT]: 0.1 }, escape: 0.1, noul: { [DETECT_CYCLE_GOLD.trim()]: 0.85, [OVERFIT_TEXT]: 0.12 } }));
    let probed: readonly PerturbedInput[] = [];
    const probe = async (plausible: readonly VerifyOutcome[], inputs: readonly PerturbedInput[]): Promise<ReadonlyMap<string, string>> => {
      probed = inputs;
      return new Map(plausible.map((o) => [o.applied.candidate.id, o.applied.candidate.id === 'dc_gold' ? 'outputs:False' : 'outputs:ERROR AttributeError']));
    };
    const opts = { oracle: oracle(), probe, inputs: () => Promise.resolve(dcLinkedLists()), budget: ample };
    const over = dcOverfit();
    const d1 = await decide([over], mem, g, ask, opts);
    expect(d1).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['duplicates_block', 'guards_other_variable', 'dead_guard'], requests: 1, plausible: 1, clusters: 0, arbitrated: false });
    expect(guardState(mem).suspect).toEqual({ goalId: 'g1', outcome: over, phase: 'SEEDS', signals: ['duplicates_block', 'guards_other_variable', 'dead_guard'], noul: 0.12 });
    expect(ask.calls).toHaveLength(1);

    // the search runs on: another site's batch with nothing plausible keeps the hold and asks nothing
    const d2 = await decide([dcUnchanged(9, '        hare = hare.successor')], mem, g, ask, opts);
    expect(d2).toMatchObject({ kind: 'continue', held: 'suspect', requests: 0, plausible: 0, signals: [] });
    expect(ask.calls).toHaveLength(1);

    // the gold at line 5: the held passer joins, the probe separates them, one Q15/Q16 request decides
    const gold = dcGold();
    const d3 = await decide([gold], mem, g, ask, opts);
    expect(d3.kind).toBe('commit');
    if (d3.kind === 'commit') {
      expect(d3.applied.candidate.id).toBe('dc_gold');
      expect(d3.note).toBeUndefined();
    }
    expect(d3).toMatchObject({ plausible: 1, clusters: 2, arbitrated: true, requests: 1, held: null, probeError: null });
    expect(d3.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['dc_overfit']);
    expect(probed).toHaveLength(MAX_PERTURBED_INPUTS);
    expect(probed.every((p) => p.exprs !== undefined)).toBe(true);
    expect(guardState(mem).suspect).toBeNull();
    expect(guardState(mem).fallbacks?.outcomes.map((o) => o.applied.candidate.id)).toEqual(['dc_overfit']);
    expect(ask.calls).toHaveLength(2);
    const arbState = ask.calls[1]!.state as { candidates: Record<string, { with: string }> };
    expect(Object.values(arbState.candidates).map((c) => c.with).sort()).toEqual([DETECT_CYCLE_GOLD.trim(), OVERFIT_TEXT].sort());
  });
  it('wrap: the duplicated loop is held; the gold arriving from a later site wins the arbitration', async () => {
    const mem = createGuardMemory(WRAP_BASE);
    const g = goal(WRAP_FAILURES);
    const overText = 'while len(text) > cols:';
    const ask = scriptedAsk(arbitrationScript({ choice: { [WRAP_GOLD.trim()]: 0.9, [overText]: 0.05 }, escape: 0.05, noul: { [WRAP_GOLD.trim()]: 0.9, [overText]: 0.08 } }));
    const cases = JSON.parse(quixbugsTestFile('wrap.json')) as Json;
    const probe = async (plausible: readonly VerifyOutcome[], inputs: readonly PerturbedInput[]): Promise<ReadonlyMap<string, string>> => {
      expect(inputs.some((i) => i.how === 'str_first_word')).toBe(true);
      return new Map(plausible.map((o) => [o.applied.candidate.id, o.applied.candidate.id === 'wrap_gold' ? "outputs:['The']" : 'outputs:[]']));
    };
    const opts = { oracle: oracle(), probe, inputs: () => Promise.resolve(perturbedInputsFromCases(cases, 'wrap')), budget: ample };
    const d1 = await decide([wrapOver()], mem, g, ask, opts);
    expect(d1).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['duplicates_block'], requests: 1 });
    const d2 = await decide([wrapGold()], mem, g, ask, opts);
    expect(d2.kind).toBe('commit');
    if (d2.kind === 'commit') expect(d2.applied.candidate.id).toBe('wrap_gold');
    expect(d2).toMatchObject({ clusters: 2, arbitrated: true, held: null });
    expect(guardState(mem).suspect).toBeNull();
  });
  it('a passer with ≥ 2 signals is committed at once only when Jev vouches confidently (p ≥ LONE_PASSER_VOUCH_MIN_NOUL); the live 0.39 holds it', async () => {
    const run = async (p: number): Promise<ReturnType<typeof decide>> => {
      const mem = createGuardMemory(DC_BASE);
      const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: p } }));
      const g = goal(DETECT_CYCLE_FAILURES);
      const over = dcOverfit();
      g.exhausted.set(siteKeyOf(over.applied.candidate), new Set(['mutation', 'template']));
      return decide([over], mem, g, ask, { oracle: oracle(), budget: ample });
    };
    expect(await run(0.39)).toMatchObject({ kind: 'continue', held: 'suspect', requests: 1, signals: ['duplicates_block', 'guards_other_variable', 'dead_guard'] });
    expect(await run(0.69)).toMatchObject({ kind: 'continue', held: 'suspect' });
    expect(await run(0.75)).toMatchObject({ kind: 'commit', held: null, requests: 1, signals: ['duplicates_block', 'guards_other_variable', 'dead_guard'], plausible: 1, clusters: 1 });
    expect(LONE_PASSER_HOLD_MAX_NOUL).toBe(OVERRIDE_LOW);
    expect(LONE_PASSER_VOUCH_MIN_NOUL).toBe(OVERRIDE_HIGH);
    expect(STRONG_SIGNALS_MIN).toBe(2);
  });
  it('a passer with ONE signal is held only when Jev confidently doubts it (p < LONE_PASSER_HOLD_MAX_NOUL)', async () => {
    const run = async (p: number): Promise<ReturnType<typeof decide>> => {
      const mem = createGuardMemory(WRAP_BASE);
      const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { 'while len(text) > cols:': p } }));
      const g = goal(WRAP_FAILURES);
      const over = wrapOver();
      g.exhausted.set(siteKeyOf(over.applied.candidate), new Set(['mutation', 'template']));
      return decide([over], mem, g, ask, { oracle: oracle(), budget: ample });
    };
    expect(await run(0.07)).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['duplicates_block'] });
    expect(await run(0.39)).toMatchObject({ kind: 'commit', held: null, signals: ['duplicates_block'] });
  });
  it('a clean lone passer on a RANK oracle is committed without any Jev, exactly as before', async () => {
    const mem = createGuardMemory(DC_BASE);
    const d = await decide([dcGold()], mem, goal(DETECT_CYCLE_FAILURES), throwingAsk, { oracle: oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(d).toMatchObject({ kind: 'commit', held: null, requests: 0, signals: [] });
  });
  it('below the budget reserve nothing is held and no advisory is asked (the passer is committed)', async () => {
    const mem = createGuardMemory(DC_BASE);
    const d = await decide([dcOverfit()], mem, goal(DETECT_CYCLE_FAILURES), throwingAsk, { oracle: oracle(), budget: thin });
    expect(d).toMatchObject({ kind: 'commit', held: null, requests: 0, signals: ['duplicates_block', 'guards_other_variable', 'dead_guard'] });
    expect(budgetAllowsHold(undefined)).toBe(true);
    expect(budgetAllowsHold(ample)).toBe(true);
    expect(budgetAllowsHold(thin)).toBe(false);
    expect(budgetAllowsHold({ ...ample, testRunsLeft: HOLD_RESERVE_RUNS - 1 })).toBe(false);
    expect(budgetAllowsHold({ ...ample, jevRequestsLeft: 0 })).toBe(false);
    expect(budgetAllowsHold({ ...ample, exhausted: () => true })).toBe(false);
  });
  it('the held suspect survives every later phase of the step and is released as `possible overfit` only by the budget reserve or the step end', async () => {
    const hold = async (): Promise<{ mem: ReturnType<typeof createGuardMemory>; g: Goal; over: VerifyOutcome }> => {
      const mem = createGuardMemory(DC_BASE);
      const g = goal(DETECT_CYCLE_FAILURES);
      const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: 0.1 } }));
      const over = dcOverfit();
      expect((await decide([over], mem, g, ask, { oracle: oracle(), budget: ample })).held).toBe('suspect');
      return { mem, g, over };
    };
    const a = await hold();
    for (const phase of ['SKETCH', 'BEAM', 'WIDENED'] as const) {
      a.g.phase = phase;
      expect((await decide([], a.mem, a.g, throwingAsk, { oracle: oracle(), budget: ample })).held).toBe('suspect');
    }
    expect(guardState(a.mem).suspect?.phase).toBe('SEEDS');

    const b = await hold();
    const cut = await decide([dcUnchanged(9, '        hare = hare.successor')], b.mem, b.g, throwingAsk, { oracle: oracle(), budget: thin });
    expect(cut).toMatchObject({ kind: 'commit', note: 'possible overfit', held: null });

    // step end: commitSuspect commits the held suspect, marked
    const c = await hold();
    const end = commitSuspect(c.mem, c.g);
    expect(end).toEqual({ kind: 'commit', applied: c.over.applied, allGoalTestsPass: true, note: 'possible overfit', outcome: c.over });
    expect(guardState(c.mem).suspect).toBeNull();
  });
  it('a later passer that passes MORE tests than the held suspect replaces it outright (tests before Jev)', async () => {
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: 0.1 } }));
    // a base with a second failing test the overfit leaves failing: the overfit is plausible for g1, the gold also fixes the other
    const other = 'tests/detect_cycle_test.py::test6';
    const baseline = { ...summary({ passed: 4, failing: [...DETECT_CYCLE_FAILURES.map((f) => f.testId), other], failures: [...DETECT_CYCLE_FAILURES, failure(other)], total: 6 }), outputTail: DETECT_CYCLE_TAIL };
    const base = committedBase(DETECT_CYCLE, baseline, [NODE]);
    const memB = createGuardMemory(base);
    const narrow = summary({ passed: 5, failing: [other], total: 6 });
    const over = outcome(detectCycleOverfit(), base, { subset: narrow, full: narrow, status: 'plausible' });
    const d1 = await decide([over], memB, g, ask, { oracle: oracle(), budget: ample });
    expect(d1.held).toBe('suspect');
    const gold = plausibleOutcome(dcGoldCand(), base);
    const d2 = await decide([gold], memB, g, throwingAsk, { oracle: oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(d2).toMatchObject({ kind: 'commit', arbitrated: false, requests: 0, held: null });
    if (d2.kind === 'commit') expect(d2.applied.candidate.id).toBe('dc_gold');
    expect(guardState(memB).suspect).toBeNull();
    void mem;
  });
});

describe('rule (a) in decide: a SIEVE lone passer waits for the rest of its site batch', () => {
  const fast = oracle();
  const slow = oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } });
  const gold = (): VerifyOutcome => plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[3]!, { id: 'np_gold', source: 'mutation', op: 'operand_swap' }), NP_BASE);
  const siteUnchanged = (source: Candidate['source'], line = NEXT_PERMUTATION_LINE): VerifyOutcome => outcome(candidate(siteAt(NEXT_PERMUTATION, line), `                # ${source} ${line}`, { source }), NP_BASE, { subset: NP_BASELINE });
  const key = siteKeyOf(gold().applied.candidate);

  it('sieveHoldApplies: SIEVE oracle, seed phase, a seed source still unexhausted at the site', () => {
    const g = goal(NEXT_PERMUTATION_FAILURES);
    expect(sieveHoldApplies(g, gold(), fast)).toBe(true);
    expect(sieveHoldApplies(g, gold(), slow)).toBe(false);
    expect(sieveHoldApplies(g, gold(), undefined)).toBe(false);
    expect(sieveHoldApplies({ ...g, phase: 'SKETCH' }, gold(), fast)).toBe(false);
    expect(sieveHoldApplies({ ...g, phase: 'WIDENED' }, gold(), fast)).toBe(true);
    const done = goal(NEXT_PERMUTATION_FAILURES);
    done.exhausted.set(key, new Set(['template', 'donor']));
    expect(sieveHoldApplies(done, gold(), fast)).toBe(false);
    const composite = plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[3]!, { id: 'pair', source: 'composite' }), NP_BASE);
    expect(sieveHoldApplies(g, composite, fast)).toBe(false);
  });
  it('siteBatchDone: another site or composite ends it; the same site only once no other seed source is left; an empty batch says nothing', () => {
    const g = goal(NEXT_PERMUTATION_FAILURES);
    expect(siteBatchDone(g, [], key)).toBe(false);
    expect(siteBatchDone(g, [siteUnchanged('mutation', 3)], key)).toBe(true);
    expect(siteBatchDone(g, [siteUnchanged('composite')], key)).toBe(true);
    expect(siteBatchDone(g, [siteUnchanged('template')], key)).toBe(false);
    g.exhausted.set(key, new Set(['mutation']));
    expect(siteBatchDone(g, [siteUnchanged('template')], key)).toBe(false);
    g.exhausted.set(key, new Set(['mutation', 'template']));
    expect(siteBatchDone(g, [siteUnchanged('donor')], key)).toBe(true);
    expect(siteBatchDone(g, [siteUnchanged('template')], key)).toBe(false);
  });
  it('holds the clean lone passer, keeps it while the site has sources left, commits it when the site batch is done; no Jev anywhere', async () => {
    const mem = createGuardMemory(NP_BASE);
    const g = goal(NEXT_PERMUTATION_FAILURES);
    const passer = gold();
    const d1 = await decide([passer], mem, g, throwingAsk, { oracle: fast, budget: ample });
    expect(d1).toMatchObject({ kind: 'continue', held: 'pending', plausible: 1, clusters: 0, requests: 0, signals: [] });
    expect(guardState(mem).pending).toEqual({ goalId: 'g1', outcome: passer, siteKey: key, phase: 'SEEDS' });
    g.exhausted.set(key, new Set(['mutation']));
    const d2 = await decide([siteUnchanged('template')], mem, g, throwingAsk, { oracle: fast, budget: ample });
    expect(d2).toMatchObject({ kind: 'continue', held: 'pending', plausible: 0 });
    g.exhausted.set(key, new Set(['mutation', 'template']));
    const d3 = await decide([siteUnchanged('donor')], mem, g, throwingAsk, { oracle: fast, budget: ample });
    expect(d3).toMatchObject({ kind: 'commit', held: null, plausible: 0, clusters: 1, arbitrated: false, requests: 0 });
    if (d3.kind === 'commit') {
      expect(d3.applied).toBe(passer.applied);
      expect(d3.note).toBeUndefined();
    }
    expect(guardState(mem).pending).toBeNull();
  });
  it('a batch from another site releases the pending passer; so does the budget reserve', async () => {
    for (const [results, budget] of [
      [[siteUnchanged('mutation', 3)], ample],
      [[], thin],
    ] as const) {
      const mem = createGuardMemory(NP_BASE);
      const g = goal(NEXT_PERMUTATION_FAILURES);
      const passer = gold();
      expect((await decide([passer], mem, g, throwingAsk, { oracle: fast, budget: ample })).held).toBe('pending');
      const d = await decide(results, mem, g, throwingAsk, { oracle: fast, budget });
      expect(d).toMatchObject({ kind: 'commit', held: null });
      if (d.kind === 'commit') expect(d.applied).toBe(passer.applied);
      expect(guardState(mem).pending).toBeNull();
    }
  });
  it('a second passer at the site while one is pending → both are arbitrated (measured next_permutation numbers), the hold is cleared', async () => {
    const mem = createGuardMemory(NP_BASE);
    const g = goal(NEXT_PERMUTATION_FAILURES);
    const strict = plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[0]!, { id: 'np_strict', source: 'mutation' }), NP_BASE);
    expect((await decide([strict], mem, g, throwingAsk, { oracle: fast, budget: ample })).held).toBe('pending');
    const nonStrict = plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[1]!, { id: 'np_ge', source: 'template' }), NP_BASE);
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, o.applied.candidate.id === 'np_strict' ? 'strict' : 'non_strict']));
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.79, 'if perm[j] >= perm[i]:': 0.02 }, escape: 0.06, noul: { 'if perm[j] > perm[i]:': 0.65, 'if perm[j] >= perm[i]:': 0.22 } }));
    const d = await decide([nonStrict], mem, g, ask, { oracle: fast, probe, budget: ample });
    expect(d).toMatchObject({ kind: 'commit', plausible: 1, clusters: 2, arbitrated: true, requests: 1, held: null });
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('np_strict');
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['np_ge']);
    expect(guardState(mem).pending).toBeNull();
    expect(ask.calls).toHaveLength(1);
  });
  it('step end: commitSuspect drains the pending passer as a plain commit; forgetGoal clears it; another goal\'s end leaves it', async () => {
    const mem = createGuardMemory(NP_BASE);
    const g = goal(NEXT_PERMUTATION_FAILURES);
    const passer = gold();
    await decide([passer], mem, g, throwingAsk, { oracle: fast, budget: ample });
    expect(commitSuspect(mem, { id: 'g2' })).toBeNull();
    expect(commitSuspect(mem, g)).toEqual({ kind: 'commit', applied: passer.applied, allGoalTestsPass: true, outcome: passer });
    expect(guardState(mem).pending).toBeNull();
    await decide([passer], mem, g, throwingAsk, { oracle: fast, budget: ample });
    forgetGoal(mem, g);
    expect(guardState(mem).pending).toBeNull();
  });
});

describe('createDecide: the lane probe is wired by workspace layout, not by the oracle runner label', () => {
  it('a pytest-labelled QuixBugs workspace (the bench layout) probes both passers on the lanes and clusters them apart', async () => {
    const base = committedBase(DETECT_CYCLE, DC_BASELINE, [NODE]);
    const mem = { ...createGuardMemory(base), oracle: oracle({ runner: 'pytest' }), stepBudget: { ...ample, startedMs: 0, recursed: false } } as Parameters<ReturnType<typeof createDecide>>[1];
    const lane = { index: 0, dir: '/lanes/lane0', mode: 'candidate_file' as const, busy: false };
    const applied: string[] = [];
    const pool: LanePool = {
      mode: 'candidate_file',
      lanes: [lane],
      workspaceRoot: '/ws',
      pathInLane: (_l, rel) => `/lanes/lane0/${rel}`,
      withLane: async (fn) => fn(lane),
      applyToLane: async (_l, a) => {
        applied.push(a.candidate.id);
      },
      resetLane: async () => undefined,
      disposeLanes: async () => undefined,
    };
    mem.lanes = pool;
    const commands: string[] = [];
    const reads: string[] = [];
    const events: string[] = [];
    const ask = scriptedAsk(arbitrationScript({ choice: { [DETECT_CYCLE_GOLD.trim()]: 0.8, [OVERFIT_TEXT]: 0.1 }, escape: 0.1, noul: { [DETECT_CYCLE_GOLD.trim()]: 0.85, [OVERFIT_TEXT]: 0.12 } }));
    const ctx = {
      step: 3,
      ask,
      signal: new AbortController().signal,
      emit: (e: { type: string; detail?: string }) => {
        if (e.detail !== undefined) events.push(e.detail);
      },
      sandbox: {
        run: async (command: string): Promise<ExecResult> => {
          commands.push(command);
          // the gold answers every list; the overfit crashes on some: two signatures
          const outputs = command.includes('detect_cycle.py') && commands.length % 2 === 1 ? ['False'] : ['ERROR AttributeError'];
          return { ok: true, exitCode: 0, signal: null, stdout: `${JSON.stringify({ probe: 'ok', outputs })}\n`, stderr: '', truncated: false, bytesSeen: 10, killedBy: null } as ExecResult;
        },
      },
      workspace: {
        read: async (path: string) => {
          reads.push(path);
          if (path === 'tests/detect_cycle_test.py') return { path, content: DC_TEST_MODULE, bytes: DC_TEST_MODULE.length, truncatedBytes: 0 };
          throw new Error(`no such file: ${path}`);
        },
      },
    } as unknown as SynthesisContext;
    const decideLive = createDecide();
    const d = await decideLive(ctx, mem, goal(DETECT_CYCLE_FAILURES), [dcOverfit(), dcGold()]);
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('dc_gold');
    // one probe process per passer, importing the lane's detect_cycle.py with the lane on sys.path, 16 linked-list inputs
    expect(applied.sort()).toEqual(['dc_gold', 'dc_overfit']);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("'detect_cycle' '/lanes/lane0/detect_cycle.py'");
    expect(commands[0]).toContain('__jev_chain(__jev_class(\\"node\\", \\"Node\\"), \\"successor\\", 4, None)'.replace(/\\\\"/g, '\\"'));
    expect(commands[0]?.endsWith("'/lanes/lane0' <<'JEVCODE_BEHAVIOUR_PROBE'\n" + commands[0]!.split("<<'JEVCODE_BEHAVIOUR_PROBE'\n")[1]!)).toBe(true);
    expect(reads).toEqual(['tests/detect_cycle_test.py', 'tests/detect_cycle.json']);
    expect(events.some((e) => e.includes('probe 16 inputs, 2/2 signatures') && e.includes('2 clusters'))).toBe(true);
    // the test sources are read once per goal and memory
    await decideLive(ctx, mem, goal(DETECT_CYCLE_FAILURES), [dcOverfit(), dcGold()]);
    expect(reads).toHaveLength(2);
  });
  it('without lanes, or on a repository layout (no <name>.py beside the test module), no probe: P2P clustering as before', async () => {
    const events: string[] = [];
    const ask = scriptedAsk(arbitrationScript({ choice: { [DETECT_CYCLE_GOLD.trim()]: 0.8 }, escape: 0.1, noul: { [DETECT_CYCLE_GOLD.trim()]: 0.85 } }));
    const ctx = { step: 3, ask, signal: new AbortController().signal, emit: (e: { detail?: string }) => e.detail !== undefined && events.push(e.detail), sandbox: { run: async () => { throw new Error('no probe expected'); } }, workspace: { read: async () => { throw new Error('no read expected'); } } } as unknown as SynthesisContext;
    const noLanes = { ...createGuardMemory(DC_BASE), oracle: oracle() } as Parameters<ReturnType<typeof createDecide>>[1];
    const d = await createDecide()(ctx, noLanes, goal(DETECT_CYCLE_FAILURES), [dcOverfit(), dcGold()]);
    expect(d.kind).toBe('commit');
    expect(events.some((e) => e.includes('(no probe)') && e.includes('1 cluster'))).toBe(true);
    // a repository: the test module names `grades` but the source lives under src/
    const repoFile = sourceFile('src/grades.py', 'def grades(x):\n    return x\n');
    const repoBase = committedBase(repoFile, summary({ passed: 1, failing: ['tests/test_grades.py::test_a'], failures: [failure('tests/test_grades.py::test_a')] }));
    const repoMem = { ...createGuardMemory(repoBase), oracle: oracle({ runner: 'pytest' }), lanes: {} as LanePool } as Parameters<ReturnType<typeof createDecide>>[1];
    const g = goal([failure('tests/test_grades.py::test_a')]);
    const a = plausibleOutcome(candidate(siteAt(repoFile, 2), '    return x + 0', { id: 'r1' }), repoBase);
    const b = plausibleOutcome(candidate(siteAt(repoFile, 2), '    return x * 1', { id: 'r2' }), repoBase);
    const askRepo = scriptedAsk(arbitrationScript({ choice: { 'return x + 0': 0.6 }, escape: 0.1, noul: { 'return x + 0': 0.8 } }));
    const d2 = await createDecide()({ ...ctx, ask: askRepo } as unknown as SynthesisContext, repoMem, g, [a, b]);
    expect(d2.kind).toBe('commit');
    expect(events.filter((e) => e.includes('(no probe)'))).toHaveLength(2);
  });
});
