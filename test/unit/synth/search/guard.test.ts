import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ExecResult, Json, SynthesisContext } from '../../../../src/core/types.js';
import type { LanePool } from '../../../../src/synth/sieve/lanes.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { appliedOnCommitted, createGuardMemory, forgetGoal, guardState, heldPartialOutcome, holdBestPartial, improvedBase, improvedBaseFor, siteKeyOf } from '../../../../src/synth/search/bases.js';
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
  PERTURBATION_NOTE,
  SINGLE_CLUSTER_MAX_MEMBERS,
  SUSPECT_ESCAPE_MIN,
  SUSPECT_NOUL_MAX,
  adviseLonePasser,
  arbitrate,
  behaviourProbeCommand,
  budgetAllowsHold,
  clusterByBehaviour,
  clusterSupport,
  commitSuspect,
  createDecide,
  decide,
  editCost,
  fewestSpecialCases,
  gateHeldPartial,
  generalInstructions,
  guardSubjects,
  isPlausible,
  linkedListInputs,
  linkedListShape,
  majorityCluster,
  minEdit,
  noneDereference,
  PROBE_OUTPUT_SEP,
  probeMajorityCluster,
  seedOnlySplit,
  p2pVector,
  parseBehaviourProbe,
  parseQuixbugsCall,
  perturbationTable,
  perturbedInputs,
  perturbedInputsFromCases,
  probeTimeoutMs,
  representativesOf,
  mostPassing,
  sieveHoldApplies,
  siteBatchDone,
  specialCaseScore,
  STRONG_SIGNALS_MIN,
  POOL_SUSPECT_SIGNALS,
  structuralRejection,
  suspicionSignals,
  unreleasable,
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
  REPO_ROOT,
  arbitrationScript,
  candidate,
  committedBase,
  failure,
  goal,
  noulAnswer,
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
    expect(d).toEqual({ kind: 'continue', plausible: 0, clusters: 0, arbitrated: false, requests: 0, fallbacks: [], probeError: null, held: null, signals: [], dropped: 0, structuralDrops: 0, codeRule: null });
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
  it('the all-overfit signature (depth_first_search: escape 0.90, max Noul 0.06) → the set is DROPPED: nothing held, nothing committed at step end, the batch\'s partial kept', async () => {
    const mem = createGuardMemory(DFS_BASE);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.1 }, escape: 0.9, noul: { 'nextnode for nextnode in node.successors': 0.06, 'search_from(goalnode) for nextnode in node.successors': 0.03, 'node for nextnode in node.successors': 0.04, 'any for nextnode in node.successors': 0.04, 'goalnode for nextnode in node.successors': 0.04 } }));
    const d = await decide(dfsPlausible(), mem, DFS_GOAL, ask);
    expect(d).toEqual({ kind: 'continue', plausible: 7, clusters: 1, arbitrated: true, requests: 1, fallbacks: [], probeError: null, held: null, signals: [], dropped: 7, structuralDrops: 0, codeRule: null });
    expect(guardState(mem).suspect).toBeNull();
    expect(guardState(mem).pending).toBeNull();
    expect(guardState(mem).fallbacks).toBeNull();
    // rule (1): no step-end release and no reserve release exist for a dropped set
    expect(commitSuspect(mem, DFS_GOAL)).toBeNull();
    expect(commitSuspect(mem)).toBeNull();
    // 0.5: between the highest gold-containing escape measured (0.38, with a Noul ≥ 0.45) and the lowest all-overfit one (0.67, max Noul 0.08: ladder `masked` run 3b, §20);
    // 0.3: the "confidently false" bound of §5.4, above the head-to-head's committed textstats (0.12) and django-15315 (0.11) sets
    expect(SUSPECT_ESCAPE_MIN).toBe(0.5);
    expect(SUSPECT_NOUL_MAX).toBe(0.3);
    expect(SUSPECT_NOUL_MAX).toBe(OVERRIDE_LOW);

    // a second decision over the same set drops it again (nothing was remembered as held)
    const again = await decide(dfsPlausible().slice(0, 3), mem, DFS_GOAL, ask);
    expect(again).toMatchObject({ kind: 'continue', dropped: 3, held: null });
    forgetGoal(mem, DFS_GOAL);
    expect(guardState(mem).suspect).toBeNull();
  });
  it('escape high with a Noul ≥ 0.3 is not the signature (commit); textstats 0.86 / 0.12, wrap 0.89 / 0.06 and masked 0.67 / 0.08 are (dropped); the gold set 0.38 / 0.45 commits', async () => {
    const mem = createGuardMemory(DFS_BASE);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.1 }, escape: 0.9, noul: { 'nextnode for nextnode in node.successors': 0.35 } }));
    const d = await decide(dfsPlausible(), mem, DFS_GOAL, ask);
    expect(d.kind).toBe('commit');
    expect(guardState(mem).suspect).toBeNull();
    // llm-jev-headtohead.md §5.2: `tokens.append(n)` committed at escape 0.86, max general 0.12 under the old 0.1 bound
    const textstatsLike = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.08, 'search_from(goalnode) for nextnode in node.successors': 0.06 }, escape: 0.86, noul: { 'nextnode for nextnode in node.successors': 0.12, 'search_from(goalnode) for nextnode in node.successors': 0.1, 'node for nextnode in node.successors': 0.07 } }));
    const textstats = await decide(dfsPlausible().slice(0, 3), createGuardMemory(DFS_BASE), DFS_GOAL, textstatsLike);
    expect(textstats).toMatchObject({ kind: 'continue', held: null, arbitrated: true, dropped: 3 });
    const wrapLike = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.06, 'search_from(goalnode) for nextnode in node.successors': 0.05 }, escape: 0.89, noul: { 'nextnode for nextnode in node.successors': 0.06, 'search_from(goalnode) for nextnode in node.successors': 0.05 } }));
    const wrap = await decide(dfsPlausible().slice(0, 2), createGuardMemory(DFS_BASE), DFS_GOAL, wrapLike);
    expect(wrap).toMatchObject({ kind: 'continue', held: null, arbitrated: true, dropped: 2 });
    // ladder `masked` runs 3 / 3b (§20): five `return 0` inserts, escape 0.75 / 0.67 with max Noul 0.08 — the signature
    const maskedLike = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.2, 'search_from(goalnode) for nextnode in node.successors': 0.13 }, escape: 0.67, noul: { 'nextnode for nextnode in node.successors': 0.08, 'search_from(goalnode) for nextnode in node.successors': 0.05 } }));
    const masked = await decide(dfsPlausible().slice(0, 2), createGuardMemory(DFS_BASE), DFS_GOAL, maskedLike);
    expect(masked).toMatchObject({ kind: 'continue', held: null, dropped: 2 });
    // the highest gold-containing escape measured (0.38) came with a Noul ≥ 0.45: committed
    const goldLike = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.5 }, escape: 0.38, noul: { 'nextnode for nextnode in node.successors': 0.45 } }));
    const committed = await decide(dfsPlausible().slice(0, 2), createGuardMemory(DFS_BASE), DFS_GOAL, goldLike);
    expect(committed.kind).toBe('commit');
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

// The ladder `shipping` task (bench/data/ladder/tasks/shipping): the head-to-head committed the seed
// `subtotal ** 2` as a lone passer with 14 s of test wall left (llm-jev-headtohead.md §5.2, §9 class A).
const SHIPPING = sourceFile('src/shipping.py', readFileSync(join(REPO_ROOT, 'bench/data/ladder/tasks/shipping/src/shipping.py'), 'utf8'));
const SHIPPING_INIT = sourceFile('src/__init__.py', '');
/** `    cost = 0.0 if subtotal >= CONFIG["free_over"] else rate` */
const SHIPPING_COST_LINE = SHIPPING.mod.lines.findIndex((l) => l.includes('cost = 0.0 if subtotal >= CONFIG["free_over"] else rate')) + 1;
/** `    "free_over": 500.0,` */
const SHIPPING_CONFIG_LINE = SHIPPING.mod.lines.findIndex((l) => l.includes('"free_over": 500.0,')) + 1;
const SHIPPING_SQUARED = '    cost = 0.0 if subtotal ** 2 >= CONFIG["free_over"] else rate';
const SHIPPING_GOLD = '    "free_over": 50.0,';
const SHIPPING_TESTS = ['test_free_at_threshold', 'test_free_over_threshold_any_method', 'test_remote_surcharge_still_applies_when_free', 'test_describe'].map((t) => `tests/test_shipping.py::${t}`);
const SHIPPING_FAILURES = SHIPPING_TESTS.map((t) => failure(t, '0.0', '4.99'));
const SHIPPING_BASE: Base = committedBase(SHIPPING, summary({ passed: 6, failing: SHIPPING_TESTS, failures: SHIPPING_FAILURES, total: 10 }), [SHIPPING_INIT]);
const shippingSquared = (): VerifyOutcome => plausibleOutcome(candidate(siteAt(SHIPPING, SHIPPING_COST_LINE), SHIPPING_SQUARED, { id: 'ship_sq', source: 'mutation', op: 'operand_power' }), SHIPPING_BASE);
const shippingGold = (): VerifyOutcome => plausibleOutcome(candidate(siteAt(SHIPPING, SHIPPING_CONFIG_LINE), SHIPPING_GOLD, { id: 'ship_gold', source: 'template', op: 'literal_from_test' }), SHIPPING_BASE);

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
  // OOS iteration 4 briefly added `guards_derived_local` here; its review showed the prior use
  // that carried it (`if hare.successor is None:`) is not a use a falsy `hare.successor.successor`
  // would have broken, so the corrected rule is silent on this patch and the list is the
  // iteration-3 four again.
  it('detect_cycle: the committed guard copies lines 5-6, names a variable the traceback never dereferences, guards an expression nothing reads and adds a special case; the gold adds a clause (one signal), a genuine inserted guard too', () => {
    expect(suspicionSignals(dcOverfit(), DC_GOAL)).toEqual(['duplicates_block', 'guards_other_variable', 'dead_guard', 'adds_special_case']);
    // `hare is None or` adds a conditional (`or`) and a literal (`None`) over the replaced line: the advisory is asked, and the measured gold answered 0.85
    expect(suspicionSignals(dcGold(), DC_GOAL)).toEqual(['adds_special_case']);
    expect(specialCaseScore(dcGoldCand())).toEqual({ conditionals: 1, literals: 1, total: 2 });
    const genuine = plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 5, 'insert'), '        if hare is None:\n            return False', { id: 'guard_before' }), DC_BASE);
    expect(suspicionSignals(genuine, DC_GOAL)).toEqual(['adds_special_case']);
    // without the traceback line the other-variable signal goes
    const noTail = committedBase(DETECT_CYCLE, { ...DC_BASELINE, outputTail: '' }, [NODE]);
    expect(suspicionSignals(plausibleOutcome(detectCycleOverfit(), noTail), DC_GOAL)).toEqual(['duplicates_block', 'dead_guard', 'adds_special_case']);
  });
  it('wrap: the loop copied under itself duplicates a block and adds a `while` with literals; the one-line gold is clean; GLM\'s `if text:` adds one conditional', () => {
    expect(suspicionSignals(wrapOver(), WRAP_GOAL)).toEqual(['duplicates_block', 'adds_special_case']);
    expect(specialCaseScore(wrapOverfit()).conditionals).toBe(2);
    expect(specialCaseScore(wrapOverfit()).literals).toBe(4);
    expect(suspicionSignals(wrapGold(), WRAP_GOAL)).toEqual([]);
    expect(specialCaseScore(wrapGold().applied.candidate)).toEqual({ conditionals: 0, literals: 0, total: 0 });
    const twoLines = plausibleOutcome(candidate(siteAt(WRAP, WRAP_GOLD_LINE, 'insert'), '    if text:\n        lines.append(text)', { id: 'two' }), WRAP_BASE);
    expect(suspicionSignals(twoLines, WRAP_GOAL)).toEqual(['adds_special_case']);
    expect(specialCaseScore(twoLines.applied.candidate)).toEqual({ conditionals: 1, literals: 0, total: 1 });
  });
  it('specialCaseScore counts what the edit ADDS over the replaced line: `** 2` and `return 0` a literal, `if x:` a conditional, `<= 1` for `== 0` and `>=` for `>` nothing', () => {
    const shipping = sourceFile('src/shipping.py', ['def shipping_cost(subtotal, method):', '    rate = 4.99', '    cost = 0.0 if subtotal >= CONFIG["free_over"] else rate', '    return round(cost, 2)', ''].join('\n'));
    expect(specialCaseScore(candidate(siteAt(shipping, 3), '    cost = 0.0 if subtotal ** 2 >= CONFIG["free_over"] else rate'))).toEqual({ conditionals: 0, literals: 1, total: 1 });
    expect(specialCaseScore(candidate(siteAt(shipping, 3, 'insert'), '    return 0'))).toEqual({ conditionals: 0, literals: 1, total: 1 });
    expect(specialCaseScore(candidate(siteAt(shipping, 3, 'insert'), '    if not method:\n        return None'))).toEqual({ conditionals: 1, literals: 1, total: 2 });
    const grades = sourceFile('src/grades.py', ['def letter(score, minimum):', '    if score > minimum:', '        return "A"', '    return "B"', ''].join('\n'));
    expect(specialCaseScore(candidate(siteAt(grades, 2), '    if score >= minimum:')).total).toBe(0);
    const merge = sourceFile('mergesort.py', ['def mergesort(arr):', '    if len(arr) == 0:', '        return arr', ''].join('\n'));
    expect(specialCaseScore(candidate(siteAt(merge, 2), '    if len(arr) <= 1:')).total).toBe(0);
    // a replaced line that already had the guard is not an addition
    expect(specialCaseScore(candidate(siteAt(grades, 2), '    if score > minimum and score > 0:'))).toEqual({ conditionals: 1, literals: 1, total: 2 });
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
  it('detect_cycle: held on Q16 0.12 (never released), kept through a passer-less batch, then two singleton clusters split — no LLM member and equal support, so Q15/Q16 picks the gold, never the special-case count (class A′)', async () => {
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
    const signals = ['duplicates_block', 'guards_other_variable', 'dead_guard', 'adds_special_case'];
    const d1 = await decide([over], mem, g, ask, opts);
    expect(d1).toMatchObject({ kind: 'continue', held: 'suspect', signals, requests: 1, plausible: 1, clusters: 0, arbitrated: false });
    expect(guardState(mem).suspect).toEqual({ goalId: 'g1', outcome: over, phase: 'SEEDS', signals, noul: 0.12 });
    expect(unreleasable(guardState(mem).suspect!)).toBe(true);
    expect(ask.calls).toHaveLength(1);

    // the search runs on: another site's batch with nothing plausible keeps the hold and asks nothing
    const d2 = await decide([dcUnchanged(9, '        hare = hare.successor')], mem, g, ask, opts);
    expect(d2).toMatchObject({ kind: 'continue', held: 'suspect', requests: 0, plausible: 0, signals: [] });
    expect(ask.calls).toHaveLength(1);

    // the gold at line 5: the held passer joins and the probe splits them, but both clusters are one
    // seed at support 1 with no LLM member — the majority vote has nothing to weigh (class A′), so the
    // count is not consulted and Q15/Q16 decides on the perturbation table; the measured answers pick the gold
    const gold = dcGold();
    const d3 = await decide([gold], mem, g, ask, opts);
    expect(d3.kind).toBe('commit');
    if (d3.kind === 'commit') {
      expect(d3.applied.candidate.id).toBe('dc_gold');
      expect(d3.note).toBeUndefined();
    }
    expect(d3).toMatchObject({ plausible: 1, clusters: 2, arbitrated: true, requests: 1, held: null, probeError: null, codeRule: null });
    expect(d3.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['dc_overfit']);
    expect(probed).toHaveLength(MAX_PERTURBED_INPUTS);
    expect(probed.every((p) => p.exprs !== undefined)).toBe(true);
    expect(guardState(mem).suspect).toBeNull();
    expect(guardState(mem).fallbacks?.outcomes.map((o) => o.applied.candidate.id)).toEqual(['dc_overfit']);
    expect(ask.calls).toHaveLength(2);
    // the request carried the differing inputs and both outputs (the table, not the diffs alone)
    const table = (ask.calls[1]!.state as { perturbations?: { outputs: Record<string, string> }[] }).perturbations;
    expect(table === undefined ? 0 : table.length).toBeGreaterThan(0);
  });
  it('wrap: the duplicated loop is held; the gold arriving from a later site is picked by Q15/Q16 (two seed singletons, class A′: the count never decides there)', async () => {
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
    expect(d1).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['duplicates_block', 'adds_special_case'], requests: 1 });
    const d2 = await decide([wrapGold()], mem, g, ask, opts);
    expect(d2.kind).toBe('commit');
    if (d2.kind === 'commit') expect(d2.applied.candidate.id).toBe('wrap_gold');
    expect(d2).toMatchObject({ clusters: 2, arbitrated: true, requests: 1, held: null, codeRule: null });
    expect(guardState(mem).suspect).toBeNull();
    expect(ask.calls).toHaveLength(2);
  });
  it('a passer with ≥ 2 signals is committed at once only when Jev vouches confidently (p ≥ LONE_PASSER_VOUCH_MIN_NOUL); the live 0.39 holds it', async () => {
    const signals = ['duplicates_block', 'guards_other_variable', 'dead_guard', 'adds_special_case'];
    const run = async (p: number): Promise<ReturnType<typeof decide>> => {
      const mem = createGuardMemory(DC_BASE);
      const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: p } }));
      const g = goal(DETECT_CYCLE_FAILURES);
      const over = dcOverfit();
      g.exhausted.set(siteKeyOf(over.applied.candidate), new Set(['mutation', 'template']));
      return decide([over], mem, g, ask, { oracle: oracle(), budget: ample });
    };
    expect(await run(0.39)).toMatchObject({ kind: 'continue', held: 'suspect', requests: 1, signals });
    expect(await run(0.69)).toMatchObject({ kind: 'continue', held: 'suspect' });
    expect(await run(0.75)).toMatchObject({ kind: 'commit', held: null, requests: 1, signals, plausible: 1, clusters: 1 });
    expect(LONE_PASSER_HOLD_MAX_NOUL).toBe(OVERRIDE_LOW);
    expect(LONE_PASSER_VOUCH_MIN_NOUL).toBe(OVERRIDE_HIGH);
    expect(STRONG_SIGNALS_MIN).toBe(2);
  });
  it('a passer with ONE signal (shipping: `subtotal ** 2` adds a literal) is held only when Jev confidently doubts it (p < LONE_PASSER_HOLD_MAX_NOUL)', async () => {
    const run = async (p: number): Promise<ReturnType<typeof decide>> => {
      const mem = createGuardMemory(SHIPPING_BASE);
      const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [SHIPPING_SQUARED.trim()]: p } }));
      const g = goal(SHIPPING_FAILURES);
      const over = shippingSquared();
      // the site batch is over (no rule (a) hold), so the decision is the advisory's alone
      g.exhausted.set(siteKeyOf(over.applied.candidate), new Set(['mutation', 'template', 'donor']));
      return decide([over], mem, g, ask, { oracle: oracle(), budget: ample });
    };
    expect(await run(0.07)).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['adds_special_case'] });
    const kept = await run(0.39);
    expect(kept).toMatchObject({ kind: 'commit', held: null, signals: ['adds_special_case'], requests: 1 });
    // one signal, p ≥ the hold bound: a plain commit, not `possible overfit`
    expect(kept).not.toHaveProperty('note');
  });
  it('a clean lone passer (next_permutation gold: an operand swap adds nothing) on a RANK oracle is committed without any Jev, exactly as before', async () => {
    const mem = createGuardMemory(NP_BASE);
    const d = await decide([plausibleOutcome(npCands[3]!, NP_BASE)], mem, NP_GOAL, throwingAsk, { oracle: oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(d).toMatchObject({ kind: 'commit', held: null, requests: 0, signals: [], codeRule: null });
    // grades-class: `>=` for `>` and `sum` for `len` are general-looking changes — no signal, no request
    const grades = sourceFile('src/grades.py', ['def letter(score, minimum):', '    if score > minimum:', '        return "A"', '    return "B"', ''].join('\n'));
    const gBase = committedBase(grades, summary({ passed: 1, failing: ['tests/test_grades.py::test_boundary'], failures: [failure('tests/test_grades.py::test_boundary')] }));
    const d2 = await decide([plausibleOutcome(candidate(siteAt(grades, 2), '    if score >= minimum:', { id: 'ge' }), gBase)], createGuardMemory(gBase), goal([failure('tests/test_grades.py::test_boundary')]), throwingAsk, { oracle: oracle({ runner: 'pytest', tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(d2).toMatchObject({ kind: 'commit', requests: 0, signals: [] });
  });
  it('inside the budget reserve the advisory is still asked (shipping was committed unasked with 14 s left): doubted → possible overfit, confidently doubted → held and never released; no request left → committed', async () => {
    const signals = ['duplicates_block', 'guards_other_variable', 'dead_guard', 'adds_special_case'];
    const doubted = await decide([dcOverfit()], createGuardMemory(DC_BASE), goal(DETECT_CYCLE_FAILURES), scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: 0.5 } })), { oracle: oracle(), budget: thin });
    expect(doubted).toMatchObject({ kind: 'commit', note: 'possible overfit', held: null, requests: 1, signals });
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const confident = await decide([dcOverfit()], mem, g, scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: 0.1 } })), { oracle: oracle(), budget: thin });
    expect(confident).toMatchObject({ kind: 'continue', held: 'suspect', requests: 1, signals });
    expect(commitSuspect(mem, g)).toBeNull();
    expect(guardState(mem).suspect).toBeNull();
    const noRequest = await decide([dcOverfit()], createGuardMemory(DC_BASE), goal(DETECT_CYCLE_FAILURES), throwingAsk, { oracle: oracle(), budget: { ...thin, jevRequestsLeft: 0 } });
    expect(noRequest).toMatchObject({ kind: 'commit', held: null, requests: 0, signals });
    expect(budgetAllowsHold(undefined)).toBe(true);
    expect(budgetAllowsHold(ample)).toBe(true);
    expect(budgetAllowsHold(thin)).toBe(false);
    expect(budgetAllowsHold({ ...ample, testRunsLeft: HOLD_RESERVE_RUNS - 1 })).toBe(false);
    expect(budgetAllowsHold({ ...ample, jevRequestsLeft: 0 })).toBe(false);
    expect(budgetAllowsHold({ ...ample, exhausted: () => true })).toBe(false);
  });
  it('a vouch-bound hold (p 0.5, ≥ 2 signals) survives every later phase and is released as `possible overfit` by the reserve or the step end; a confidently doubted hold (p 0.1) is never released — commitSuspect drops it', async () => {
    const hold = async (p: number): Promise<{ mem: ReturnType<typeof createGuardMemory>; g: Goal; over: VerifyOutcome }> => {
      const mem = createGuardMemory(DC_BASE);
      const g = goal(DETECT_CYCLE_FAILURES);
      const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: p } }));
      const over = dcOverfit();
      expect((await decide([over], mem, g, ask, { oracle: oracle(), budget: ample })).held).toBe('suspect');
      return { mem, g, over };
    };
    const a = await hold(0.5);
    for (const phase of ['SKETCH', 'BEAM', 'WIDENED'] as const) {
      a.g.phase = phase;
      expect((await decide([], a.mem, a.g, throwingAsk, { oracle: oracle(), budget: ample })).held).toBe('suspect');
    }
    expect(guardState(a.mem).suspect?.phase).toBe('SEEDS');
    expect(unreleasable(guardState(a.mem).suspect!)).toBe(false);

    const b = await hold(0.5);
    const cut = await decide([dcUnchanged(9, '        hare = hare.successor')], b.mem, b.g, throwingAsk, { oracle: oracle(), budget: thin });
    expect(cut).toMatchObject({ kind: 'commit', note: 'possible overfit', held: null });

    // step end: commitSuspect commits the vouch-bound suspect, marked
    const c = await hold(0.5);
    const end = commitSuspect(c.mem, c.g);
    expect(end).toEqual({ kind: 'commit', applied: c.over.applied, allGoalTestsPass: true, note: 'possible overfit', outcome: c.over });
    expect(guardState(c.mem).suspect).toBeNull();

    // rule (3): confidently doubted — the reserve does not release it, the step end drops it (the goal parks or ends on its partial)
    const d = await hold(0.1);
    expect(unreleasable(guardState(d.mem).suspect!)).toBe(true);
    for (const phase of ['SKETCH', 'BEAM', 'WIDENED'] as const) {
      d.g.phase = phase;
      expect((await decide([], d.mem, d.g, throwingAsk, { oracle: oracle(), budget: thin })).held).toBe('suspect');
    }
    expect(await decide([dcUnchanged(9, '        hare = hare.successor')], d.mem, d.g, throwingAsk, { oracle: oracle(), budget: thin })).toMatchObject({ kind: 'continue', held: 'suspect' });
    expect(commitSuspect(d.mem, { id: 'g2' })).toBeNull();
    expect(guardState(d.mem).suspect).not.toBeNull();
    expect(commitSuspect(d.mem, d.g)).toBeNull();
    expect(guardState(d.mem).suspect).toBeNull();
    expect(commitSuspect(d.mem, d.g)).toBeNull();
  });
  it('a later passer that passes MORE tests than the held suspect replaces it outright (tests before Jev); its own advisory is asked alone', async () => {
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [OVERFIT_TEXT]: 0.1, [DETECT_CYCLE_GOLD.trim()]: 0.85 } }));
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
    // the gold adds a clause (`adds_special_case`), so its own Q16 is asked — alone, never against the dropped suspect
    const d2 = await decide([gold], memB, g, ask, { oracle: oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(d2).toMatchObject({ kind: 'commit', arbitrated: false, requests: 1, held: null, signals: ['adds_special_case'] });
    if (d2.kind === 'commit') expect(d2.applied.candidate.id).toBe('dc_gold');
    expect(guardState(memB).suspect).toBeNull();
    expect(Object.keys(ask.calls[1]!.questions)).toEqual(['general_cand_01']);
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
    // two seed singletons at support 1 with no LLM member (class A′): the count decides nothing, Q15/Q16 picks the gold
    expect(d).toMatchObject({ codeRule: null, arbitrated: true, requests: 1 });
    expect(ask.calls).toHaveLength(1);
    // one probe process per passer, importing the lane's detect_cycle.py with the lane on sys.path, 16 linked-list inputs
    expect(applied.sort()).toEqual(['dc_gold', 'dc_overfit']);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("'detect_cycle' '/lanes/lane0/detect_cycle.py'");
    expect(commands[0]).toContain('__jev_chain(__jev_class(\\"node\\", \\"Node\\"), \\"successor\\", 4, None)'.replace(/\\\\"/g, '\\"'));
    expect(commands[0]?.endsWith("'/lanes/lane0' <<'JEVCODE_BEHAVIOUR_PROBE'\n" + commands[0]!.split("<<'JEVCODE_BEHAVIOUR_PROBE'\n")[1]!)).toBe(true);
    expect(reads).toEqual(['tests/detect_cycle_test.py', 'tests/detect_cycle.json']);
    expect(events.some((e) => e.includes('probe 16 inputs, 2/2 signatures') && e.includes('2 behaviour clusters') && e.includes('no LLM member and equal support') && e.includes('the special-case count does not decide here'))).toBe(true);
    // the test sources are read once per goal and memory
    await decideLive(ctx, mem, goal(DETECT_CYCLE_FAILURES), [dcOverfit(), dcGold()]);
    expect(reads).toHaveLength(2);
  });
  it('without lanes, or on a repository layout (no <name>.py beside the test module, no src/ package), no probe: P2P clustering as before', async () => {
    const events: string[] = [];
    const ask = scriptedAsk(arbitrationScript({ choice: { [DETECT_CYCLE_GOLD.trim()]: 0.8 }, escape: 0.1, noul: { [DETECT_CYCLE_GOLD.trim()]: 0.85 } }));
    const ctx = { step: 3, ask, signal: new AbortController().signal, emit: (e: { detail?: string }) => e.detail !== undefined && events.push(e.detail), sandbox: { run: async () => { throw new Error('no probe expected'); } }, workspace: { read: async () => { throw new Error('no read expected'); } } } as unknown as SynthesisContext;
    const noLanes = { ...createGuardMemory(DC_BASE), oracle: oracle() } as Parameters<ReturnType<typeof createDecide>>[1];
    const d = await createDecide()(ctx, noLanes, goal(DETECT_CYCLE_FAILURES), [dcOverfit(), dcGold()]);
    expect(d.kind).toBe('commit');
    expect(events.some((e) => e.includes('(no probe)') && e.includes('1 cluster'))).toBe(true);
    // a repository: the test module names `grades` but the source lives in a package that is not `src/`
    const repoFile = sourceFile('lib/grades.py', 'def grades(x):\n    return x\n');
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
  it('a ladder-class layout (src/<module>.py + tests/test_*.py) harvests the test calls once on a lane and replays them per passer; the clusters split and, with no LLM member at equal support, Q15/Q16 picks the literal fix over `** 2`', async () => {
    const mem = { ...createGuardMemory(SHIPPING_BASE), oracle: oracle({ runner: 'pytest', perTestTimeoutMs: null }), stepBudget: { ...ample, startedMs: 0, recursed: false } } as Parameters<ReturnType<typeof createDecide>>[1];
    const lane = { index: 0, dir: '/lanes/lane0', mode: 'copy' as const, busy: false };
    const applied: { id: string; files: number }[] = [];
    const pool: LanePool = {
      mode: 'copy',
      lanes: [lane],
      workspaceRoot: '/ws',
      pathInLane: (_l, rel) => `/lanes/lane0/${rel}`,
      withLane: async (fn) => fn(lane),
      applyToLane: async (_l, a) => {
        applied.push({ id: a.candidate.id, files: a.files.length });
      },
      resetLane: async () => undefined,
      disposeLanes: async () => undefined,
    };
    mem.lanes = pool;
    const commands: string[] = [];
    const events: string[] = [];
    const blob = Buffer.from('pickle').toString('base64');
    const records = [
      { module: 'src.shipping', qualname: 'shipping_cost', blob: `${blob}A`, how: 'recorded', source: 'test_shipping.py::test_free_at_threshold', text: "shipping_cost(50.0, 'standard')" },
      { module: 'src.shipping', qualname: 'shipping_cost', blob: `${blob}B`, how: 'float_minus_half', source: 'perturbed from test_shipping.py::test_free_at_threshold', text: "shipping_cost(49.5, 'standard')" },
      { module: 'src.shipping', qualname: 'describe', blob: `${blob}C`, how: 'none', source: 'perturbed from test_shipping.py::test_describe', text: 'describe(20.0, None)' },
    ];
    const askShip = scriptedAsk(arbitrationScript({ choice: { [SHIPPING_GOLD.trim()]: 0.72, [SHIPPING_SQUARED.trim()]: 0.08 }, escape: 0.2, noul: { [SHIPPING_GOLD.trim()]: 0.81, [SHIPPING_SQUARED.trim()]: 0.1 } }));
    const ctx = {
      step: 2,
      ask: askShip,
      signal: new AbortController().signal,
      emit: (e: { type: string; detail?: string }) => {
        if (e.detail !== undefined) events.push(e.detail);
      },
      sandbox: {
        run: async (command: string): Promise<ExecResult> => {
          commands.push(command);
          const replays = commands.filter((c) => c.includes(" 'replay' ")).length;
          const line = command.includes(" 'harvest' ")
            ? JSON.stringify({ probe: 'ok', recorded: 1, inputs: 3, functions: 7, stats: { tests_run: 10 }, import_errors: {}, records })
            : // both passers ship 50.0 free; on the perturbed 49.5 one charges 4.99 and the other ships free (the squared seed): two signatures
              JSON.stringify({ probe: 'ok', outputs: [{ r: '0.0', t: false, a: "((50.0, 'standard'), {})", m: false }, { r: replays % 2 === 1 ? '4.99' : '0.0', t: true, a: "((49.5, 'standard'), {})", m: false }, { r: "'Standard shipping: $4.99'", t: true, a: '((20.0, None), {})', m: false }] });
          return { ok: true, exitCode: 0, signal: null, stdout: `${line}\n`, stderr: '', truncated: false, bytesSeen: 10, killedBy: null } as ExecResult;
        },
      },
      workspace: { read: async () => { throw new Error('no read expected on the ladder layout'); } },
    } as unknown as SynthesisContext;
    const decideLive = createDecide();
    const d = await decideLive(ctx, mem, goal(SHIPPING_FAILURES), [shippingSquared(), shippingGold()]);
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('ship_gold');
    // two seed singletons of equal support (class A′): the special-case count never commits there — Q15/Q16 does, on the replayed table
    expect(d).toMatchObject({ clusters: 2, arbitrated: true, requests: 1, codeRule: null });
    // one harvest on the committed tree (a candidate named, no files written), then one replay per passer over the 3 harvested calls
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain(" 'harvest' '/lanes/lane0' 'src.shipping' 'tests/test_shipping.py' ");
    expect(commands[0]?.endsWith("'-' <<'JEVCODE_LADDER_HARNESS'\n" + commands[0]!.split("<<'JEVCODE_LADDER_HARNESS'\n")[1]!)).toBe(true);
    expect(applied[0]?.files).toBe(0);
    expect(commands.slice(1).every((c) => c.includes(" 'replay' '/lanes/lane0' ") && c.includes('shipping_cost') && c.includes('"blob":"'))).toBe(true);
    expect(applied.slice(1).map((a) => a.id).sort()).toEqual(['ship_gold', 'ship_sq']);
    expect(events.some((e) => e.includes('harvested 1 test calls over 7 functions of src.shipping (tests/test_shipping.py); 3 perturbed inputs'))).toBe(true);
    expect(events.some((e) => e.includes('probe 3 inputs, 2/2 signatures') && e.includes('2 behaviour clusters'))).toBe(true);
    // the harvest is cached per goal and memory: a second decision replays only
    await decideLive(ctx, mem, goal(SHIPPING_FAILURES), [shippingSquared(), shippingGold()]);
    expect(commands.filter((c) => c.includes(" 'harvest' "))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// The five head-to-head overfits (experiments/results/llm-jev-headtohead.md §5, §8.1, §9 class A)
// ---------------------------------------------------------------------------------------

describe('head-to-head fix (a): textstats / django-15315 — the all-overfit signature is dropped, never released; the honest partial is what the step keeps', () => {
  it('two seeds in one P2P cluster answered escape 0.86 / max general 0.12: dropped, no suspect, commitSuspect null; the batch\'s partial becomes the improved base', async () => {
    const mem = createGuardMemory(NP_BASE);
    // the measured textstats numbers on two test-equivalent seeds (both `plausible`), plus a partial in the same batch
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.08, 'if perm[j] >= perm[i]:': 0.06 }, escape: 0.86, noul: { 'if perm[j] > perm[i]:': 0.12, 'if perm[j] >= perm[i]:': 0.1 } }));
    const partial = partialOutcome(candidate(siteAt(NEXT_PERMUTATION, 3), '    for i in range(len(perm) - 2, -1, -1):  # partial', { id: 'np_partial' }), NP_BASE, [NEXT_PERMUTATION_FAILURES[0]!.testId]);
    const d = await decide([npPlausible()[0]!, npPlausible()[1]!, partial], mem, NP_GOAL, ask, { oracle: oracle({ runner: 'pytest' }) });
    expect(d).toMatchObject({ kind: 'continue', plausible: 2, clusters: 1, arbitrated: true, requests: 1, held: null, dropped: 2, codeRule: null });
    expect(guardState(mem).suspect).toBeNull();
    expect(commitSuspect(mem, NP_GOAL)).toBeNull();
    expect(improvedBase(mem)?.candidate?.candidate.id).toBe('np_partial');
    expect(heldPartialOutcome(mem, NP_GOAL)).toBe(partial);
    // the honest partial is the progress commit the step ends on (subgoal.ts commitProgress → gateHeldPartial): clean, no request
    const gate = await gateHeldPartial(mem, NP_GOAL, partial, throwingAsk);
    expect(gate.verdict).toBe('clean');
    expect(gate.decision).toMatchObject({ kind: 'commit', note: 'partial', allGoalTestsPass: false });
  });
  it('a suspect held under rule (b) that joins an all-overfit arbitration is dropped with the set', async () => {
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const other = 'if tortoise is None:';
    const ask = scriptedAsk(arbitrationScript({ choice: { [OVERFIT_TEXT]: 0.05, [other]: 0.05 }, escape: 0.9, noul: { [OVERFIT_TEXT]: 0.5, [other]: 0.06 } }));
    expect((await decide([dcOverfit()], mem, g, ask, { oracle: oracle(), budget: ample })).held).toBe('suspect');
    // a second doubtful insert at the same gap, behaving differently on the probe
    const second = plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 10, 'insert'), `        ${other}`, { id: 'dc_other', source: 'template', extraEdits: [{ path: DETECT_CYCLE.path, line: 10, kind: 'insert', text: '            return True' }] }), DC_BASE);
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, `outputs:${o.applied.candidate.id}`]));
    const askAll = scriptedAsk(arbitrationScript({ choice: { [OVERFIT_TEXT]: 0.05, [other]: 0.05 }, escape: 0.9, noul: { [OVERFIT_TEXT]: 0.06, [other]: 0.06 } }));
    const d = await decide([second], mem, g, askAll, { oracle: oracle(), probe, inputs: () => Promise.resolve(dcLinkedLists()), budget: ample });
    // both add the same special cases (one conditional, two literals): a residual tie → Q15/Q16 → the signature → dropped, the held one too
    expect(d).toMatchObject({ kind: 'continue', clusters: 2, arbitrated: true, dropped: 2, held: null });
    expect(guardState(mem).suspect).toBeNull();
    expect(commitSuspect(mem, g)).toBeNull();
  });
});

describe('head-to-head fix (b): wrap — generality by code before Jev; Q15 only on a residual tie, with the perturbation table', () => {
  const cases = JSON.parse(quixbugsTestFile('wrap.json')) as Json;
  const wrapInputs = (): PerturbedInput[] => perturbedInputsFromCases(cases, 'wrap').slice(0, 3);
  const llmVariant = (): VerifyOutcome => plausibleOutcome(candidate(siteAt(WRAP, WRAP_GOLD_LINE), '    if text:\n        lines.append(text)\n    return lines', { id: 'llm:sample_3_0', source: 'llm', op: 'sample_3_0', prior: 1 }), WRAP_BASE);

  it('three passers in three clusters (gold seed, GLM\'s `if text:`, the copied loop): the code metric commits the gold; Jev — who chose the guarded variant at 0.95 — is not asked', async () => {
    const mem = createGuardMemory(WRAP_BASE);
    const g = goal(WRAP_FAILURES);
    const sig: Record<string, string> = {
      wrap_gold: "outputs:['The']\u001f['']\u001f['a', 'b']",
      'llm:sample_3_0': "outputs:['The']\u001f[]\u001f['a', 'b']",
      wrap_overfit: "outputs:[]\u001f[]\u001f['a', 'b']",
    };
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, sig[o.applied.candidate.id] ?? '']));
    const d = await decide([wrapGold(), llmVariant(), wrapOver()], mem, g, throwingAsk, { oracle: oracle(), probe, inputs: () => Promise.resolve(wrapInputs()), budget: ample });
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') {
      expect(d.applied.candidate.id).toBe('wrap_gold');
      expect(d.note).toBeUndefined();
    }
    expect(d).toMatchObject({ plausible: 3, clusters: 3, arbitrated: false, requests: 0, codeRule: 'fewest_special_cases', held: null });
    // fallbacks by added special cases: the one-conditional LLM variant before the loop
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['llm:sample_3_0', 'wrap_overfit']);
    expect(guardState(mem).fallbacks?.outcomes.map((o) => o.applied.candidate.id)).toEqual(['llm:sample_3_0', 'wrap_overfit']);
    const reps = clusterByBehaviour([wrapGold(), llmVariant(), wrapOver()], new Map(Object.entries(sig))).map((c) => c.representative);
    expect(fewestSpecialCases(reps)?.applied.candidate.id).toBe('wrap_gold');
    expect(majorityCluster(clusterByBehaviour([wrapGold(), llmVariant(), wrapOver()], new Map(Object.entries(sig))))).toBeNull();
  });
  it('a residual tie on the metric (next_permutation `>` vs `>=`, both add nothing) goes to Q15 with the perturbation table: the differing input and each output', async () => {
    const mem = createGuardMemory(NP_BASE);
    const [strict, nonStrict] = npPlausible();
    const inputs: PerturbedInput[] = [
      { input: [[1, 2, 1]], derivedFrom: 'extra', how: 'list_dup_first' },
      { input: [[1, 2, 3]], derivedFrom: 'extra', how: 'list_dup_last' },
    ];
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, o === strict || o.applied.candidate.id === strict!.applied.candidate.id ? 'outputs:[2, 1, 1]\u001f[1, 3, 2]' : 'outputs:[1, 1, 2]\u001f[1, 3, 2]']));
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if perm[j] > perm[i]:': 0.79, 'if perm[j] >= perm[i]:': 0.02 }, escape: 0.06, noul: { 'if perm[j] > perm[i]:': 0.65, 'if perm[j] >= perm[i]:': 0.22 } }));
    const d = await decide([strict!, nonStrict!], mem, NP_GOAL, ask, { oracle: oracle({ runner: 'pytest' }), probe, inputs: () => Promise.resolve(inputs), budget: ample });
    expect(d).toMatchObject({ kind: 'commit', clusters: 2, arbitrated: true, requests: 1, codeRule: null });
    if (d.kind === 'commit') expect(d.applied.candidate.text.trim()).toBe('if perm[j] > perm[i]:');
    expect(ask.calls).toHaveLength(1);
    const state = ask.calls[0]!.state as { perturbations?: Json; perturbations_note?: string; candidates: Record<string, { with: string }> };
    expect(state.perturbations_note).toBe(PERTURBATION_NOTE);
    const nonStrictKey = Object.entries(state.candidates).find(([, c]) => c.with === 'if perm[j] >= perm[i]:')![0];
    const strictKey = Object.entries(state.candidates).find(([, c]) => c.with === 'if perm[j] > perm[i]:')![0];
    expect(state.perturbations).toEqual([{ input: '([1,2,1])', how: 'list_dup_first', outputs: { [strictKey]: '[2, 1, 1]', [nonStrictKey]: '[1, 1, 2]' } }]);
    // the table builder alone: no `outputs:` signatures → no table
    const reps = representativesOf(clusterByBehaviour([strict!, nonStrict!], new Map([[strict!.applied.candidate.id, 'a'], [nonStrict!.applied.candidate.id, 'b']])));
    expect(perturbationTable(reps, inputs, new Map([[strict!.applied.candidate.id, 'a'], [nonStrict!.applied.candidate.id, 'b']]))).toEqual([]);
  });
  it('majority by independent support: a seed and an LLM sample agreeing on every perturbed input outvote a lone seed by code; one source at one site never outvotes (next_permutation 3 vs 2)', async () => {
    const mem = createGuardMemory(NP_BASE);
    const seed = plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[0]!, { id: 'np_seed', source: 'mutation' }), NP_BASE);
    const llm = plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[3]!, { id: 'llm:np', source: 'llm', op: 'sample_0_0', prior: 2 }), NP_BASE);
    const other = plausibleOutcome(candidate(NP_SITE, NEXT_PERMUTATION_PLAUSIBLE[1]!, { id: 'np_other', source: 'template' }), NP_BASE);
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, o.applied.candidate.id === 'np_other' ? 'outputs:B' : 'outputs:A']));
    const d = await decide([seed, llm, other], mem, NP_GOAL, throwingAsk, { oracle: oracle(), probe, budget: ample });
    expect(d).toMatchObject({ kind: 'commit', clusters: 2, arbitrated: false, requests: 0, codeRule: 'majority_cluster' });
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('llm:np');
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['np_other']);
    const clusters = clusterByBehaviour([seed, llm, other], new Map([['np_seed', 'A'], ['llm:np', 'A'], ['np_other', 'B']]));
    expect(clusters.map(clusterSupport)).toEqual([2, 1]);
    expect(majorityCluster(clusters)?.members.map((m) => m.applied.candidate.id)).toEqual(['llm:np', 'np_seed']);
    // the measured next_permutation set: three `>=` forms against two strict ones, all mutations at one site — support 1 vs 1, no majority, metric tie → Q15 (the test above)
    const measured = npPlausible();
    const sig = new Map(measured.map((o) => [o.applied.candidate.id, /perm\[j\] > perm\[i\]|perm\[i\] < perm\[j\]/.test(text(o)) ? 'strict' : 'non_strict']));
    const np = clusterByBehaviour(measured, sig);
    expect(np.map((c) => c.members.length)).toEqual([3, 2]);
    expect(np.map(clusterSupport)).toEqual([1, 1]);
    expect(majorityCluster(np)).toBeNull();
    expect(fewestSpecialCases(np.map((c) => c.representative))).toBeNull();
    // two clusters of equal support with the metric tied: null both ways
    expect(majorityCluster(clusterByBehaviour([seed, other], new Map([['np_seed', 'A'], ['np_other', 'B']])))).toBeNull();
  });
});

describe('head-to-head fix (c) and (d): shipping `** 2` and the grades/mergesort-class lone passers', () => {
  it('shipping: the lone `** 2` seed inside the budget reserve is asked about, held on 0.1, kept by every later thin decision, and dropped at step end (commitSuspect null → the step ends on its partial or parks)', async () => {
    const mem = createGuardMemory(SHIPPING_BASE);
    const g = goal(SHIPPING_FAILURES);
    const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [SHIPPING_SQUARED.trim()]: 0.1 } }));
    const notes: string[] = [];
    const reserve: HoldBudget = { exhausted: () => false, testWallLeftMs: 14_000, testRunsLeft: 22, jevRequestsLeft: 8 };
    const d1 = await decide([shippingSquared()], mem, g, ask, { oracle: oracle({ runner: 'pytest' }), budget: reserve, note: (n) => notes.push(n) });
    expect(d1).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['adds_special_case'], requests: 1, plausible: 1 });
    expect(guardState(mem).suspect).toMatchObject({ goalId: 'g1', noul: 0.1 });
    expect(notes.some((n) => n.includes('never released on the budget reserve'))).toBe(true);
    const d2 = await decide([], mem, g, throwingAsk, { oracle: oracle({ runner: 'pytest' }), budget: { ...reserve, testWallLeftMs: 1000 } });
    expect(d2).toMatchObject({ kind: 'continue', held: 'suspect' });
    expect(commitSuspect(mem, g)).toBeNull();
    expect(guardState(mem).suspect).toBeNull();
    expect(ask.calls).toHaveLength(1);
  });
  it('shipping: the held `** 2` against the gold literal fix arriving later — the probe splits them, and because both clusters are one seed at equal support the gold is committed by Q15/Q16, not by the count (class A′)', async () => {
    const mem = createGuardMemory(SHIPPING_BASE);
    const g = goal(SHIPPING_FAILURES);
    const ask = scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { [SHIPPING_SQUARED.trim()]: 0.1 } }));
    expect((await decide([shippingSquared()], mem, g, ask, { oracle: oracle({ runner: 'pytest' }), budget: ample })).held).toBe('suspect');
    const calls: PerturbedInput[] = [{ input: [], derivedFrom: 'perturbed from test_shipping.py::test_free_at_threshold', how: 'float_minus_half', call: { module: 'src.shipping', qualname: 'shipping_cost', blob: 'AAAA', text: "shipping_cost(49.5, 'standard')" } }];
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, o.applied.candidate.id === 'ship_gold' ? 'outputs:4.99' : 'outputs:0.0']));
    const askGold = scriptedAsk(arbitrationScript({ choice: { [SHIPPING_GOLD.trim()]: 0.72, [SHIPPING_SQUARED.trim()]: 0.08 }, escape: 0.2, noul: { [SHIPPING_GOLD.trim()]: 0.81, [SHIPPING_SQUARED.trim()]: 0.1 } }));
    const d = await decide([shippingGold()], mem, g, askGold, { oracle: oracle({ runner: 'pytest' }), probe, inputs: () => Promise.resolve(calls), budget: ample });
    expect(d).toMatchObject({ kind: 'commit', clusters: 2, arbitrated: true, requests: 1, codeRule: null, held: null });
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('ship_gold');
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).toEqual(['ship_sq']);
    expect(guardState(mem).suspect).toBeNull();
  });
  it('grades/mergesort-class: a lone `return 0` insert doubted at 0.2 parks; `>=` for `>` and `<= 1` for `== 0` commit at once with no request (the design\'s overfit-free path)', async () => {
    const grades = sourceFile('src/grades.py', ['def average(total, weights):', '    if not weights:', '        raise ValueError("no weights")', '    return total / len(weights)', ''].join('\n'));
    const test = 'tests/test_grades.py::test_weighted_average';
    const gBase = committedBase(grades, summary({ passed: 3, failing: [test], failures: [failure(test)], total: 4 }));
    const g = goal([failure(test)]);
    // (d) the special-case seed: `return 0` inserted before the division
    const memHold = createGuardMemory(gBase);
    const zero = plausibleOutcome(candidate(siteAt(grades, 4, 'insert'), '    return 0', { id: 'ret0', source: 'template', op: 'return_constant' }), gBase);
    const held = await decide([zero], memHold, g, scriptedAsk(arbitrationScript({ choice: {}, escape: 0, noul: { 'return 0': 0.2 } })), { oracle: oracle({ runner: 'pytest' }), budget: ample });
    expect(held).toMatchObject({ kind: 'continue', held: 'suspect', signals: ['adds_special_case'], requests: 1 });
    expect(commitSuspect(memHold, g)).toBeNull();
    // the general-looking change: `sum` for `len` — no signal, committed at once, Jev never asked
    const memClean = createGuardMemory(gBase);
    const clean = plausibleOutcome(candidate(siteAt(grades, 4), '    return total / sum(weights)', { id: 'sum', source: 'mutation', op: 'call_swap' }), gBase);
    const d = await decide([clean], memClean, g, throwingAsk, { oracle: oracle({ runner: 'pytest', tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(d).toMatchObject({ kind: 'commit', held: null, requests: 0, signals: [], codeRule: null });
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('sum');
    // mergesort: `if len(arr) <= 1:` for `== 0` changes a literal, adds none
    const merge = sourceFile('mergesort.py', ['def mergesort(arr):', '    if len(arr) == 0:', '        return arr', '    return arr', ''].join('\n'));
    const mBase = committedBase(merge, summary({ passed: 4, failing: ['mergesort([1])'], failures: [failure('mergesort([1])')], total: 5 }));
    const m = await decide([plausibleOutcome(candidate(siteAt(merge, 2), '    if len(arr) <= 1:', { id: 'le1' }), mBase)], createGuardMemory(mBase), goal([failure('mergesort([1])')]), throwingAsk, { oracle: oracle({ tRunMs: { goalSubset: 5000, fullSuite: 5000 } }), budget: ample });
    expect(m).toMatchObject({ kind: 'commit', requests: 0, signals: [] });
  });
});

// ---------------------------------------------------------------------------------------
// gateHeldPartial: the guard on a progress commit (jev-only-rungs-1-2.md §19.7)
// ---------------------------------------------------------------------------------------

describe('gateHeldPartial: the held partial passes the lone-passer rule (b) before it is committed as a partial fix', () => {
  const first = NEXT_PERMUTATION_FAILURES[0]!.testId;
  const notes: string[] = [];
  const note = (d: string): void => {
    notes.push(d);
  };

  it('no signal → committed at once as `partial` with the verified run as `after`, no request; the base leaves the beam', async () => {
    const mem = createGuardMemory(NP_BASE);
    const o = partialOutcome(npCands[0]!, NP_BASE, [first]);
    expect(holdBestPartial(mem, [o], NP_GOAL).replaced).toBe(true);
    expect(heldPartialOutcome(mem, NP_GOAL)).toBe(o);
    const g = await gateHeldPartial(mem, NP_GOAL, o, throwingAsk, { note });
    expect(g).toMatchObject({ verdict: 'clean', requests: 0, signals: [], noul: null });
    expect(g.decision).toMatchObject({ kind: 'commit', note: 'partial', allGoalTestsPass: false, after: o.subset, outcome: o });
    expect(improvedBase(mem)).toBeUndefined();
    expect(heldPartialOutcome(mem, NP_GOAL)).toBeNull();
  });

  it('a signal (an emptied statement) → ONE Q16 advisory; below the bound the partial is held (base kept), the advice is cached and a later call asks nothing', async () => {
    const mem = createGuardMemory(NP_BASE);
    const o = partialOutcome(candidate(NP_SITE, '                pass', { id: 'np-pass' }), NP_BASE, [first]);
    holdBestPartial(mem, [o], NP_GOAL);
    expect(suspicionSignals(o, NP_GOAL)).toEqual(['deletes_statement']);
    const ask = scriptedAsk((qs) => Object.fromEntries(Object.keys(qs).map((id) => [id, noulAnswer(0.12)])));
    const g = await gateHeldPartial(mem, NP_GOAL, o, ask, { note });
    expect(g).toMatchObject({ verdict: 'held', requests: 1, signals: ['deletes_statement'], noul: 0.12, decision: null });
    expect(ask.calls).toHaveLength(1);
    expect(Object.keys(ask.calls[0]!.questions)).toEqual(['general_cand_01']);
    expect(improvedBaseFor(mem, NP_GOAL)).toBeDefined();
    expect(guardState(mem).partialAdvice.get('np-pass')).toEqual({ goalId: NP_GOAL.id, signals: ['deletes_statement'], noul: 0.12 });
    // the next step: the cached advice decides, no request (a throwing ask proves it)
    const again = await gateHeldPartial(mem, NP_GOAL, o, throwingAsk, { note });
    expect(again).toMatchObject({ verdict: 'held', requests: 0, noul: 0.12, decision: null });
    expect(notes.filter((n) => /holds the partial .*deletes_statement; general 0\.12 < 0\.3.*not committed/.test(n))).toHaveLength(2);
    expect(guardState(mem).partialAdvice.size).toBe(1);
  });

  it('a signal but Jev vouches (p ≥ the bound) → committed; and with no Jev request left the flagged partial is held without asking', async () => {
    const mem = createGuardMemory(NP_BASE);
    const o = partialOutcome(candidate(NP_SITE, '                pass', { id: 'np-pass-2' }), NP_BASE, [first]);
    holdBestPartial(mem, [o], NP_GOAL);
    // nothing to ask with: held, not committed, no advice remembered (it is asked next step)
    const noRequest = await gateHeldPartial(mem, NP_GOAL, o, throwingAsk, { budget: { jevRequestsLeft: 0 }, note });
    expect(noRequest).toMatchObject({ verdict: 'no_request', requests: 0, decision: null, noul: null });
    expect(guardState(mem).partialAdvice.size).toBe(0);
    expect(improvedBaseFor(mem, NP_GOAL)).toBeDefined();
    // a request available and Jev at 0.8 ≥ 0.3: the partial is committed
    const ask = scriptedAsk((qs) => Object.fromEntries(Object.keys(qs).map((id) => [id, noulAnswer(0.8)])));
    const vouched = await gateHeldPartial(mem, NP_GOAL, o, ask, { budget: { jevRequestsLeft: 3 }, note });
    expect(vouched).toMatchObject({ verdict: 'vouched', requests: 1, noul: 0.8 });
    expect(vouched.decision).toMatchObject({ kind: 'commit', note: 'partial', allGoalTestsPass: false });
    expect(improvedBase(mem)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// Head-to-head v2, class A′ (experiments/results/llm-jev-headtohead-v2.md §8.2, §9): the two
// overfits `fewest_special_cases` committed when every cluster held only seeds at equal support
// ---------------------------------------------------------------------------------------

describe('head-to-head v2 fix, class A′: an all-seed split of equal support is decided by the probe\'s majority, never by the special-case count', () => {
  // the ladder `stats` shape: the goal is `test_median_empty_raises`, the defect IS a missing guard
  const STATS = sourceFile(
    'src/stats.py',
    [
      'def median(values):',
      '    """The middle value, or the mean of the two middle values for even lengths."""',
      '    ordered = sorted(values)',
      '    mid = len(ordered) // 2',
      '    if len(ordered) % 2:',
      '        return float(ordered[mid])',
      '    return (ordered[mid - 1] + ordered[mid]) / 2',
      '',
    ].join('\n'),
  );
  const STATS_TESTS = ['tests/test_stats.py::test_median_empty_raises', 'tests/test_stats.py::test_summary_empty_raises'];
  const STATS_FAILURES = STATS_TESTS.map((t) => failure(t, 'ValueError', 'IndexError: list index out of range'));
  const STATS_BASE: Base = committedBase(STATS, summary({ passed: 8, failing: STATS_TESTS, failures: STATS_FAILURES, total: 10 }));
  const STATS_SITE = siteAt(STATS, 3, 'insert');
  const RAISE = '        raise ValueError("median of empty sequence")';
  /** four `template` guards at one site — one behaviour, `support` 1 (source × site), the gold shape at the minimum edit */
  const statsGuards = (): VerifyOutcome[] =>
    (
      [
        ['stats_guard_raise', '    if not values:', RAISE],
        ['stats_guard_len', '    if len(values) == 0:', RAISE],
        ['stats_guard_not_len', '    if not len(values):', RAISE],
        ['stats_guard_list', '    if len(list(values)) == 0:', RAISE],
      ] as const
    ).map(([id, head, raise]) => plausibleOutcome(candidate(STATS_SITE, head, { id, source: 'template', op: 'guard_empty_raise', extraEdits: [{ path: STATS.path, line: 3, kind: 'insert', text: raise }] }), STATS_BASE));
  /** the committed overfit: `values.remove(mid)` — +0c/+0l, the minimum of the count metric */
  const statsOverfit = (): VerifyOutcome => plausibleOutcome(candidate(STATS_SITE, '    values.remove(mid)', { id: 'stats_remove', source: 'mutation', op: 'statement_template' }), STATS_BASE);
  // the harvested ladder inputs (`LADDER_HARNESS` replay): the guards raise where the mutation mangles the caller's list
  const statsInputs = (): PerturbedInput[] =>
    (
      [
        ['tuple_for_list', 'median((4, 1, 3, 2))'],
        ['list_drop_last', 'median([1, 2])'],
        ['list_empty', 'median([])'],
        ['recorded', 'median([3, 1, 2])'],
      ] as const
    ).map(([how, text]): PerturbedInput => ({ input: [], derivedFrom: 'perturbed from tests/test_stats.py::test_median_odd_and_even', how, call: { module: 'src.stats', qualname: 'median', blob: 'AAAA', text } }));
  const statsSignatures = (): Map<string, string> => {
    const guard = `outputs:2.5${PROBE_OUTPUT_SEP}1.5${PROBE_OUTPUT_SEP}ValueError${PROBE_OUTPUT_SEP}2.0`;
    const overfit = `outputs:AttributeError${PROBE_OUTPUT_SEP}1.5 [arguments mutated to ([2],)]${PROBE_OUTPUT_SEP}IndexError${PROBE_OUTPUT_SEP}2.0`;
    const map = new Map<string, string>([['stats_remove', overfit]]);
    for (const o of statsGuards()) map.set(o.applied.candidate.id, guard);
    return map;
  };

  it('stats: the 4-member guard cluster outvotes the single `values.remove(mid)` on the perturbed inputs and is committed by code — the count would have committed the +0c mutation', async () => {
    const mem = createGuardMemory(STATS_BASE);
    const g = goal(STATS_FAILURES);
    const sig = statsSignatures();
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, sig.get(o.applied.candidate.id) ?? '']));
    const notes: string[] = [];
    const passers = [...statsGuards(), statsOverfit()];
    // Ranked change 5 (OOS 2026-09-22 Q6, record 20260922-014311-65ul43qh): `values.remove(mid)`
    // mutates a parameter the pre-patch `median` left alone, so the structural rule refuses it
    // BEFORE any clustering — the probe majority below is no longer what keeps it out of the
    // commit, and the four guards are left as one behaviour cluster for the residual arbitration.
    const ask = scriptedAsk(arbitrationScript({ choice: { 'if not values:': 0.8 }, escape: 0.1, noul: { 'if not values:': 0.8, 'if len(values) == 0:': 0.6, 'if not len(values):': 0.6, 'if len(list(values)) == 0:': 0.6 } }));
    const d = await decide(passers, mem, g, ask, { oracle: oracle({ runner: 'pytest' }), probe, inputs: () => Promise.resolve(statsInputs()), budget: ample, note: (n) => notes.push(n) });
    expect(d.kind).toBe('commit');
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('stats_guard_raise');
    expect(d).toMatchObject({ plausible: 4, clusters: 1, structuralDrops: 1, held: null, codeRule: null });
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).not.toContain('stats_remove');
    expect(notes.some((n) => n.includes('stats_remove') && n.includes('mutates in place a parameter the pre-patch code left alone'))).toBe(true);
    // the rule the v2 run used would have committed the mutation (fewest added special cases: +0c/+0l against +1c/+1l)
    const clusters = clusterByBehaviour(passers, sig);
    expect(clusters.map((c) => c.members.length)).toEqual([4, 1]);
    expect(clusters.map(clusterSupport)).toEqual([1, 1]);
    expect(seedOnlySplit(clusters)).toBe(true);
    expect(majorityCluster(clusters)).toBeNull();
    expect(fewestSpecialCases(clusters.map((c) => c.representative))?.applied.candidate.id).toBe('stats_remove');
    const maj = probeMajorityCluster(clusters, sig);
    expect(maj.differing).toBe(3);
    expect([...maj.agreement.values()]).toEqual([3, 0]);
    expect(maj.winner?.representative.applied.candidate.id).toBe('stats_guard_raise');
    // the class A′ rule still names the guard cluster on the full set; it is simply no longer the
    // rule that keeps `values.remove(mid)` out of the commit (the structural refusal is)
    expect([...maj.agreement.entries()].map(([id, n]) => `${id}=${n}`)).toEqual(['cluster_1=3', 'cluster_2=0']);
  });

  it('detect_cycle: three seed clusters (2/2/1) the probe cannot separate — the break-guard is not committed by its +1c/+0l minimum; Q15/Q16 decides on the perturbation table', async () => {
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const breakGuard = (id: string, head: string): VerifyOutcome =>
      plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 9, 'insert'), head, { id, source: 'template', op: 'guard_empty_break', extraEdits: [{ path: DETECT_CYCLE.path, line: 9, kind: 'insert', text: '            break' }] }), DC_BASE);
    const returnGuard = (id: string, head: string): VerifyOutcome =>
      plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 9, 'insert'), head, { id, source: 'template', op: 'guard_empty_return', extraEdits: [{ path: DETECT_CYCLE.path, line: 9, kind: 'insert', text: '            return False' }] }), DC_BASE);
    const BREAK_TEXT = '        if not hare.successor.successor:';
    const RETURN_TEXT = '        if hare.successor.successor is None:';
    const passers = [
      breakGuard('dc_break', BREAK_TEXT),
      breakGuard('dc_break_alt', '        if hare.successor.successor is None or hare.successor is None:'),
      returnGuard('dc_return', RETURN_TEXT),
      returnGuard('dc_return_alt', '        if hare.successor.successor is None or hare.successor.successor is False:'),
      plausibleOutcome(detectCycleOverfit(), DC_BASE),
    ];
    // 4 linked lists: the two guard families differ on the acyclic ones (None against False), the donor at line 10
    // agrees with the returning family there and crashes on the 1-node list — nowhere is one family alone at the top
    const sig = new Map<string, string>([
      ['dc_break', `outputs:None${PROBE_OUTPUT_SEP}None${PROBE_OUTPUT_SEP}True${PROBE_OUTPUT_SEP}None`],
      ['dc_break_alt', `outputs:None${PROBE_OUTPUT_SEP}None${PROBE_OUTPUT_SEP}True${PROBE_OUTPUT_SEP}None`],
      ['dc_return', `outputs:False${PROBE_OUTPUT_SEP}False${PROBE_OUTPUT_SEP}True${PROBE_OUTPUT_SEP}False`],
      ['dc_return_alt', `outputs:False${PROBE_OUTPUT_SEP}False${PROBE_OUTPUT_SEP}True${PROBE_OUTPUT_SEP}False`],
      ['dc_overfit', `outputs:False${PROBE_OUTPUT_SEP}False${PROBE_OUTPUT_SEP}True${PROBE_OUTPUT_SEP}ERROR AttributeError`],
    ]);
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, sig.get(o.applied.candidate.id) ?? '']));
    const ask = scriptedAsk(arbitrationScript({ choice: { [RETURN_TEXT.trim()]: 0.66, [BREAK_TEXT.trim()]: 0.1, [OVERFIT_TEXT]: 0.06 }, escape: 0.18, noul: { [RETURN_TEXT.trim()]: 0.7, [BREAK_TEXT.trim()]: 0.22, [OVERFIT_TEXT]: 0.1 } }));
    const notes: string[] = [];
    const d = await decide(passers, mem, g, ask, { oracle: oracle(), probe, inputs: () => Promise.resolve(dcLinkedLists()), budget: ample, note: (n) => notes.push(n) });
    const clusters = clusterByBehaviour(passers, sig);
    expect(clusters.map((c) => c.members.length)).toEqual([2, 2, 1]);
    expect(clusters.map(clusterSupport)).toEqual([1, 1, 1]);
    expect(seedOnlySplit(clusters)).toBe(true);
    // the count's minimum is the break guard (+1c/+0l) — the overfit the v2 run committed
    expect(fewestSpecialCases(clusters.map((c) => c.representative))?.applied.candidate.id).toBe('dc_break');
    const maj = probeMajorityCluster(clusters, sig);
    expect(maj.differing).toBe(3);
    expect(maj.winner).toBeNull();
    // Ranked change 5 (OOS 2026-09-22 Q6, record 20260922-013715-nlsygcax): both `guard_empty_break`
    // members put a `break` in the `while True:` the pre-patch function could only `return` out of,
    // so each adds an implicit-None exit and is refused before clustering. What is left are the two
    // returning guards and the donor.
    //
    // What is left are the two returning guards and the donor, whose probe majority commits
    // `dc_return` by code — Q15/Q16 is not reached at all, and the break guard is never a pick
    // or a fallback.
    //
    // OOS iteration 4 made this batch a GOLD-FREE POOL (arbitrated, one request) by admitting
    // `guards_derived_local`, and its review then withdrew that signal from the pool set: the
    // prior use carrying it here is `if hare.successor is None:`, a dereference of `hare`, and
    // a falsy `hare.successor.successor` would not have broken it. With the rule corrected the
    // signal is silent on this patch, `POOL_SUSPECT_SIGNALS` is `{mutates_new_argument}` again,
    // and this batch is back to the iteration-3 behaviour recorded below. The hole
    // `20260922-013715-nlsygcax` showed — a guard at L9 committed by code with no Jev request
    // while the gold replaces L5 — is therefore STILL OPEN, and this assertion is what says so.
    expect(d).toMatchObject({ kind: 'commit', plausible: 3, clusters: 2, arbitrated: false, requests: 0, structuralDrops: 2, codeRule: 'probe_majority', held: null });
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('dc_return');
    expect(ask.calls).toHaveLength(0);
    expect(notes.some((n) => n.includes('gold-free pool'))).toBe(false);
    // the mechanism, stated: no contender carries a signal in the swept set, so `poolSuspect`
    // is false — the batch is not called gold-free and the code ranking rules decide
    const survivors = passers.filter((o) => structuralRejection(o.applied) === null);
    expect(survivors.map((o) => o.applied.candidate.id)).toEqual(['dc_return', 'dc_return_alt', 'dc_overfit']);
    for (const o of survivors) expect(suspicionSignals(o, g).filter((s) => POOL_SUSPECT_SIGNALS.has(s))).toEqual([]);
    expect(suspicionSignals(survivors[0]!, g)).toEqual(['dead_guard', 'adds_special_case']);
    expect(d.fallbacks.map((o) => o.applied.candidate.id)).not.toContain('dc_break');
    expect(notes.filter((n) => n.includes('adds a path that leaves a function with an implicit `return None`'))).toHaveLength(2);
  });

  it('the probe majority still decides a three-cluster split when one behaviour is the majority; an LLM member or unequal support keeps the count rule', async () => {
    const mem = createGuardMemory(DC_BASE);
    const g = goal(DETECT_CYCLE_FAILURES);
    const guard = (id: string, head: string, tail: string, op: string): VerifyOutcome =>
      plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 9, 'insert'), head, { id, source: 'template', op, extraEdits: [{ path: DETECT_CYCLE.path, line: 9, kind: 'insert', text: tail }] }), DC_BASE);
    const RETURN_TEXT = '        if not hare.successor.successor:';
    const a1 = guard('a1', RETURN_TEXT, '            return False', 'guard_empty_return');
    const a2 = guard('a2', '        if hare.successor.successor is None:', '            return False', 'guard_empty_return');
    const a3 = guard('a3', '        if hare.successor.successor is None or hare.successor is None:', '            return False', 'guard_empty_return');
    const b1 = guard('b1', '        if hare.successor.successor is None:', '            break', 'guard_empty_break');
    const c1 = plausibleOutcome(detectCycleOverfit(), DC_BASE);
    const sig = new Map<string, string>([
      ['a1', `outputs:False${PROBE_OUTPUT_SEP}False`],
      ['a2', `outputs:False${PROBE_OUTPUT_SEP}False`],
      ['a3', `outputs:False${PROBE_OUTPUT_SEP}False`],
      ['b1', `outputs:None${PROBE_OUTPUT_SEP}None`],
      ['dc_overfit', `outputs:ERROR AttributeError${PROBE_OUTPUT_SEP}ERROR AttributeError`],
    ]);
    const probe = async (plausible: readonly VerifyOutcome[]): Promise<ReadonlyMap<string, string>> => new Map(plausible.map((o) => [o.applied.candidate.id, sig.get(o.applied.candidate.id) ?? '']));
    const passers = [a1, a2, a3, b1, c1];
    // three votes for the returning behaviour against one and one on both inputs: the family is the majority
    const maj = probeMajorityCluster(clusterByBehaviour(passers, sig), sig);
    expect([...maj.agreement.entries()].map(([id, n]) => `${id}=${n}`)).toEqual(['cluster_1=2', 'cluster_2=0', 'cluster_3=0']);
    // ranked change 5 refuses `b1` (a `break` out of `while True:` = an implicit-None exit)
    // before clustering, so the probe majority decides between the two clusters that are left.
    // OOS iteration 4 briefly routed this through Q15/Q16 as a gold-free pool; its review
    // withdrew `guards_derived_local` from the pool set, so `throwingAsk` is right again — no
    // contender carries a swept signal, so no Jev request is made.
    const d = await decide(passers, mem, g, throwingAsk, { oracle: oracle(), probe, inputs: () => Promise.resolve(dcLinkedLists()), budget: ample });
    expect(d).toMatchObject({ kind: 'commit', clusters: 2, arbitrated: false, requests: 0, structuralDrops: 1, codeRule: 'probe_majority' });
    if (d.kind === 'commit') expect(d.applied.candidate.id).toBe('a1');
    // an LLM member in any cluster, or supports that differ, leave `fewestSpecialCases` in charge
    const llm = plausibleOutcome(candidate(siteAt(DETECT_CYCLE, 9, 'insert'), '        if hare.successor.successor is None:\n            return False', { id: 'llm:dc', source: 'llm', op: 'sample_0_0', prior: 1 }), DC_BASE);
    const withLlm = clusterByBehaviour([a1, b1, llm], new Map([...sig, ['llm:dc', `outputs:False${PROBE_OUTPUT_SEP}False`]]));
    expect(seedOnlySplit(withLlm)).toBe(false);
    const unequal = clusterByBehaviour([a1, c1, b1], new Map([...sig, ['dc_overfit', `outputs:False${PROBE_OUTPUT_SEP}False`]]));
    expect(unequal.map(clusterSupport)).toEqual([2, 1]);
    expect(seedOnlySplit(unequal)).toBe(false);
  });
});
