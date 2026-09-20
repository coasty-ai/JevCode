import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { appliedOnCommitted, createGuardMemory, forgetGoal, guardState, improvedBase } from '../../../../src/synth/search/bases.js';
import {
  ARBITRATE_TASK,
  GENUINE_FIX_INSTRUCTIONS,
  MAX_PERTURBED_INPUTS,
  OVERRIDE_HIGH,
  OVERRIDE_LOW,
  SINGLE_CLUSTER_MAX_MEMBERS,
  SUSPECT_ESCAPE_MIN,
  SUSPECT_NOUL_MAX,
  arbitrate,
  behaviourProbeCommand,
  clusterByBehaviour,
  commitSuspect,
  decide,
  editCost,
  generalInstructions,
  isPlausible,
  minEdit,
  p2pVector,
  parseBehaviourProbe,
  parseQuixbugsCall,
  perturbedInputs,
  probeTimeoutMs,
  representativesOf,
  mostPassing,
} from '../../../../src/synth/search/guard.js';
import type { PerturbedInput } from '../../../../src/synth/search/guard.js';
import type { Base, VerifyOutcome } from '../../../../src/synth/search/types.js';
import type { Candidate } from '../../../../src/synth/types.js';
import {
  DEPTH_FIRST_SEARCH,
  DEPTH_FIRST_SEARCH_FAILURES,
  DEPTH_FIRST_SEARCH_LINE,
  DEPTH_FIRST_SEARCH_OVERFITS,
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
    expect(d).toEqual({ kind: 'continue', plausible: 0, clusters: 0, arbitrated: false, requests: 0, fallbacks: [], probeError: null });
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
    expect(d).toEqual({ kind: 'continue', plausible: 7, clusters: 1, arbitrated: true, requests: 1, fallbacks: [], probeError: null });
    expect(guardState(mem).suspect).not.toBeNull();
    expect(guardState(mem).suspect?.goalId).toBe('g1');
    expect(text(guardState(mem).suspect!.outcome)).toBe('search_from(goalnode) for nextnode in node.successors');
    expect(guardState(mem).fallbacks).toBeNull();
    expect(SUSPECT_ESCAPE_MIN).toBe(0.9);
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
  it('escape high but a Noul ≥ 0.1 is not the signature: commit the argmax', async () => {
    const mem = createGuardMemory(DFS_BASE);
    const ask = scriptedAsk(arbitrationScript({ choice: { 'nextnode for nextnode in node.successors': 0.1 }, escape: 0.9, noul: { 'nextnode for nextnode in node.successors': 0.12 } }));
    const d = await decide(dfsPlausible(), mem, DFS_GOAL, ask);
    expect(d.kind).toBe('commit');
    expect(guardState(mem).suspect).toBeNull();
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
