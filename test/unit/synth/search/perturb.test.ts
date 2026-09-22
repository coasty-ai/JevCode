import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import {
  LADDER_HARVEST_SEED,
  LADDER_MAX_PROBE_INPUTS,
  LADDER_PER_FUNCTION_CAP,
  LINKED_LIST_MAX_LENGTH,
  MAX_PERTURBED_INPUTS,
  NO_TEST_SOURCES,
  behaviourProbeCommand,
  chainExpr,
  describeInput,
  inputKey,
  ladderHarvestCommand,
  ladderLayoutOf,
  ladderOutputText,
  ladderReplayCommand,
  linkedListInputs,
  linkedListShape,
  parseBehaviourProbe,
  parseLadderHarvest,
  parseLadderReplay,
  perturbationsOf,
  perturbedInputs,
  perturbedInputsFor,
  perturbedInputsFromCases,
  programNameOf,
  readTestSources,
  testModulePaths,
} from '../../../../src/synth/search/perturb.js';
import type { PerturbedInput } from '../../../../src/synth/search/perturb.js';
import { applyCandidate } from '../../../../src/synth/verify/index.js';
import {
  DETECT_CYCLE,
  DETECT_CYCLE_FAILURES,
  DETECT_CYCLE_GOLD,
  DETECT_CYCLE_LINE,
  NODE,
  QUIXBUGS_DIR,
  REPO_ROOT,
  WRAP,
  WRAP_FAILURES,
  WRAP_GOLD,
  WRAP_GOLD_LINE,
  candidate,
  detectCycleOverfit,
  failure,
  goal,
  oracle,
  quixbugsTestFile,
  siteAt,
  sourceFile,
  wrapOverfit,
} from './helpers.js';

const DC_TEST_MODULE = quixbugsTestFile('detect_cycle_test.py');
/** The bench's generated pytest module for a JSON-tested program builds no object chains (the cases live in wrap.json). */
const WRAP_TEST_MODULE = ['import json, os', 'from wrap import wrap', '', 'with open(os.path.join(os.path.dirname(__file__), "wrap.json")) as _f:', '    CASES = json.load(_f)', '', 'def test_wrap(case):', '    assert wrap(*case["input"]) == case["expected"]', ''].join('\n');
const WRAP_CASES = JSON.parse(quixbugsTestFile('wrap.json')) as Json;
const DC_GOAL = goal(DETECT_CYCLE_FAILURES);
const WRAP_GOAL = goal(WRAP_FAILURES);
const DC_FILES = new Map([[DETECT_CYCLE.path, DETECT_CYCLE], [NODE.path, NODE]]);
const WRAP_FILES = new Map([[WRAP.path, WRAP]]);

const run = (cmd: string): string => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
const outputsOf = (sig: string | null): string[] => (sig ?? '').replace(/^outputs:/, '').split('\u001f');

describe('perturbationsOf: strings join the code-derived perturbations', () => {
  it('a string argument gets its first word, a trailing word, the empty string and the last word dropped; kinds interleave across arguments', () => {
    const ps = perturbationsOf(['hello big world', 6]);
    expect(ps.map((p) => p.how)).toEqual(['str_first_word', 'int_plus_one', 'str_trailing_word', 'int_minus_one', 'str_empty', 'str_drop_last_word']);
    expect(ps.map((p) => p.input)).toEqual([['hello', 6], ['hello big world', 7], ['hello big world hello', 6], ['hello big world', 5], ['', 6], ['hello big', 6]]);
  });
  it('a one-word string has no first/drop-last variant; an empty string none at all', () => {
    expect(perturbationsOf(['hello']).map((p) => p.how)).toEqual(['str_trailing_word', 'str_empty']);
    expect(perturbationsOf(['']).map((p) => p.how)).toEqual([]);
  });
  it('perturbedInputs keeps the measured list/int behaviour and adds nothing for pytest node ids', () => {
    // kinds first (+1, -1, swap), then the rest of the argument-wise round-robin
    expect(perturbedInputs(goal([failure('gcd(35, 21)')]), oracle()).map((p) => p.input)).toEqual([[36, 21], [34, 21], [21, 35], [35, 22], [35, 20]]);
    expect(perturbedInputs(DC_GOAL, oracle())).toEqual([]);
    expect(perturbedInputs(WRAP_GOAL, oracle())).toEqual([]);
  });
});

describe('perturbedInputsFromCases: the JSON cases carry the full inputs the failure views cut', () => {
  it('wrap: 5 cases × string and width perturbations, round-robin, ≤ 16, originals excluded', () => {
    const inputs = perturbedInputsFromCases(WRAP_CASES, 'wrap');
    expect(inputs).toHaveLength(MAX_PERTURBED_INPUTS);
    const kinds = new Set(inputs.map((i) => i.how));
    expect([...kinds].sort()).toEqual(['int_minus_one', 'int_plus_one', 'str_drop_last_word', 'str_empty', 'str_first_word', 'str_trailing_word']);
    // the kind-diversity pass: the first six inputs cover all six kinds, one per case and round
    expect(new Set(inputs.slice(0, 6).map((i) => i.how)).size).toBe(6);
    expect(inputs.every((i) => i.derivedFrom.startsWith('wrap("The leaves did not stir'))).toBe(true);
    expect(inputs.every((i) => i.derivedFrom.length <= 80)).toBe(true);
    const originals = new Set((WRAP_CASES as { input: Json[] }[]).map((c) => JSON.stringify(c.input)));
    expect(inputs.some((i) => originals.has(JSON.stringify(i.input)))).toBe(false);
    expect(inputs.some((i) => i.how === 'str_first_word' && JSON.stringify(i.input) === '["The",50]')).toBe(true);
    expect(new Set(inputs.map(inputKey)).size).toBe(inputs.length);
  });
  it('anything that is not a case list gives nothing', () => {
    expect(perturbedInputsFromCases(null, 'x')).toEqual([]);
    expect(perturbedInputsFromCases({ input: [1] }, 'x')).toEqual([]);
    expect(perturbedInputsFromCases([{ expected: 1 }], 'x')).toEqual([]);
    expect(perturbedInputsFromCases([{ input: 7, expected: 1 }], 'f').map((p) => p.input)).toEqual([[8], [6]]);
  });
});

describe('linkedListShape / linkedListInputs: the Node chains detect_cycle_test.py builds', () => {
  it('reads the class, the link attribute, the module and the chain lengths passed to the function', () => {
    const shape = linkedListShape(DC_TEST_MODULE, 'detect_cycle', [DETECT_CYCLE, NODE]);
    expect(shape).toEqual({ className: 'Node', module: 'node', attr: 'successor', lengths: [1, 2, 5], cyclic: true });
  });
  it("falls back to __init__'s parameter at the link position when the tests never assign the link", () => {
    const src = ['a = Node(1)', 'b = Node(2, a)', 'c = Node(3, b)', 'assert not detect_cycle(c)', ''].join('\n');
    expect(linkedListShape(src, 'detect_cycle', [DETECT_CYCLE, NODE])).toEqual({ className: 'Node', module: 'node', attr: 'successor', lengths: [3], cyclic: false });
    // no class definition anywhere and no link assignment: the attribute is unknown
    expect(linkedListShape(src, 'detect_cycle', [DETECT_CYCLE])).toBeNull();
    // no chains at all
    expect(linkedListShape(WRAP_TEST_MODULE, 'wrap', [WRAP])).toBeNull();
    expect(linkedListShape('x = 3\n', 'f', [])).toBeNull();
  });
  it('lengths ±1..3 clipped to 1..12, acyclic and cyclic interleaved, bounded', () => {
    const shape = { className: 'Node', module: 'node', attr: 'successor', lengths: [1, 2, 5], cyclic: true };
    const inputs = linkedListInputs(shape, 'tests/detect_cycle_test.py');
    expect(inputs).toHaveLength(MAX_PERTURBED_INPUTS);
    expect(inputs.map((i) => i.how)).toEqual(Array.from({ length: 16 }, (_, k) => (k % 2 === 0 ? 'linked_list_acyclic' : 'linked_list_cycle')));
    expect(inputs[0]?.exprs).toEqual([chainExpr(shape, 1, null)]);
    expect(inputs[1]?.exprs).toEqual([chainExpr(shape, 1, 0)]);
    expect(inputs[6]?.exprs).toEqual(["__jev_chain(__jev_class(\"node\", \"Node\"), \"successor\", 4, None)"]);
    expect(inputs.every((i) => i.input.length === 0 && i.derivedFrom === 'tests/detect_cycle_test.py')).toBe(true);
    const long = linkedListInputs({ ...shape, lengths: [11] }, 't', 40);
    expect(Math.max(...long.map((i) => Number(/, (\d+), /.exec(i.exprs?.[0] ?? '')?.[1])))).toBe(LINKED_LIST_MAX_LENGTH);
    expect(chainExpr({ className: 'Node', module: null, attr: 'next' }, 3, 1)).toBe('__jev_chain(__jev_class(None, "Node"), "next", 3, 1)');
  });
});

describe('test-derived sources', () => {
  it('testModulePaths / programNameOf resolve the QuixBugs layouts', () => {
    expect(testModulePaths(DC_GOAL)).toEqual(['tests/detect_cycle_test.py']);
    expect(testModulePaths(WRAP_GOAL)).toEqual(['tests/test_wrap.py']);
    expect(programNameOf(DC_GOAL, DC_FILES)).toBe('detect_cycle');
    expect(programNameOf(WRAP_GOAL, WRAP_FILES)).toBe('wrap');
    expect(programNameOf(goal([failure('gcd(13, 13)')]), new Map([['gcd.py', WRAP]]))).toBe('gcd');
    expect(programNameOf(DC_GOAL, WRAP_FILES)).toBeNull();
  });
  it('readTestSources reads the goal modules and tests/<name>.json through the given reader, tolerating failures', async () => {
    const reads: string[] = [];
    const read = async (path: string): Promise<string | null> => {
      reads.push(path);
      if (path === 'tests/test_wrap.py') return 'module source';
      if (path === 'tests/wrap.json') return '[{"input": ["a b", 1], "expected": ["a", " b"]}]';
      return null;
    };
    const s = await readTestSources(read, WRAP_GOAL, 'wrap');
    expect(reads).toEqual(['tests/test_wrap.py', 'tests/wrap.json']);
    expect([...s.modules.entries()]).toEqual([['tests/test_wrap.py', 'module source']]);
    expect(s.cases).toEqual([{ input: ['a b', 1], expected: ['a', ' b'] }]);
    const none = await readTestSources(async () => null, DC_GOAL, null);
    expect(none).toEqual({ cases: null, modules: new Map() });
    const bad = await readTestSources(async (p) => (p.endsWith('.json') ? 'not json' : null), DC_GOAL, 'detect_cycle');
    expect(bad.cases).toBeNull();
  });
  it('perturbedInputsFor: detect_cycle gets 16 linked lists, wrap 16 case perturbations, no program nothing', async () => {
    const dc = perturbedInputsFor(DC_GOAL, oracle(), 'detect_cycle', DC_FILES, { cases: null, modules: new Map([['tests/detect_cycle_test.py', DC_TEST_MODULE]]) });
    expect(dc).toHaveLength(16);
    expect(dc.every((i) => i.how.startsWith('linked_list_'))).toBe(true);
    const w = perturbedInputsFor(WRAP_GOAL, oracle(), 'wrap', WRAP_FILES, { cases: WRAP_CASES, modules: new Map([['tests/test_wrap.py', WRAP_TEST_MODULE]]) });
    expect(w).toHaveLength(16);
    expect(w.every((i) => i.exprs === undefined)).toBe(true);
    // the gate is the program (the QuixBugs layout), not the oracle's runner label: the bench's QuixBugs workspaces are `pytest` oracles
    expect(perturbedInputsFor(DC_GOAL, oracle({ runner: 'pytest' }), 'detect_cycle', DC_FILES, { cases: null, modules: new Map([['tests/detect_cycle_test.py', DC_TEST_MODULE]]) })).toHaveLength(16);
    expect(perturbedInputsFor(DC_GOAL, oracle({ runner: 'pytest' }), 'detect_cycle', DC_FILES, NO_TEST_SOURCES)).toEqual([]);
    expect(perturbedInputsFor(DC_GOAL, oracle(), null, DC_FILES, NO_TEST_SOURCES)).toEqual([]);
    // the calls' own inputs lead and the cases fill without repeating them
    const g = goal([failure('gcd(35, 21)')]);
    const both = perturbedInputsFor(g, oracle(), 'gcd', new Map([['gcd.py', WRAP]]), { cases: [{ input: [35, 21], expected: 7 }, { input: [4, 6], expected: 2 }], modules: new Map() });
    expect(both.slice(0, 5).map((p) => p.input)).toEqual([[36, 21], [34, 21], [21, 35], [35, 22], [35, 20]]);
    expect(both.slice(5).map((p) => p.input)).toEqual([[3, 6], [5, 6], [4, 7], [4, 5], [6, 4]]);
  });
});

describe('behaviour probe (real python3): the run-3 overfits and their golds land in different clusters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perturb-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, text: string): string => {
    const p = join(dir, `${name}.py`);
    writeFileSync(p, text);
    return p;
  };

  it('detect_cycle: the gold answers every linked list, the committed guard crashes on acyclic even lengths ≥ 4', () => {
    const shape = linkedListShape(DC_TEST_MODULE, 'detect_cycle', [DETECT_CYCLE, NODE])!;
    const inputs = linkedListInputs(shape, 'tests/detect_cycle_test.py');
    const gold = write('gold_detect_cycle', applyCandidate(candidate(siteAt(DETECT_CYCLE, DETECT_CYCLE_LINE), DETECT_CYCLE_GOLD)).files[0]!.after);
    const overfit = write('overfit_detect_cycle', applyCandidate(detectCycleOverfit()).files[0]!.after);
    const probe = (path: string): string | null => {
      // the candidate file is imported under the program name from its own directory; node.py comes from the programs dir
      const cmd = behaviourProbeCommand({ name: 'detect_cycle', candidatePath: path, inputs, perInputTimeoutMs: 1000, pythonPath: [join(QUIXBUGS_DIR, 'programs')] });
      return parseBehaviourProbe(run(cmd));
    };
    const g = outputsOf(probe(gold));
    const o = outputsOf(probe(overfit));
    expect(g).toHaveLength(16);
    // acyclic → False, cyclic → True, for every length 1..8
    expect(g).toEqual(inputs.map((i) => (i.how === 'linked_list_acyclic' ? 'False' : 'True')));
    expect(o).not.toEqual(g);
    const crashed = inputs.filter((_, k) => o[k] === 'ERROR AttributeError').map((i) => Number(/, (\d+), /.exec(i.exprs?.[0] ?? '')?.[1]));
    expect(crashed).toEqual([4, 6, 8]);
    expect(inputs.filter((_, k) => o[k] === 'ERROR AttributeError').every((i) => i.how === 'linked_list_acyclic')).toBe(true);
  });

  it('wrap: the gold keeps the remainder, the duplicated loop drops it on a text that fits and on a longer tail', () => {
    const inputs = perturbedInputsFromCases(WRAP_CASES, 'wrap');
    const gold = write('gold_wrap', applyCandidate(candidate(siteAt(WRAP, WRAP_GOLD_LINE, 'insert'), WRAP_GOLD)).files[0]!.after);
    const overfit = write('overfit_wrap', applyCandidate(wrapOverfit()).files[0]!.after);
    const probe = (path: string): string | null => parseBehaviourProbe(run(behaviourProbeCommand({ name: 'wrap', candidatePath: path, inputs, perInputTimeoutMs: 1000 })));
    const g = outputsOf(probe(gold));
    const o = outputsOf(probe(overfit));
    expect(g).toHaveLength(16);
    expect(g.every((x) => x.startsWith('['))).toBe(true);
    expect(o).not.toEqual(g);
    const first = inputs.findIndex((i) => i.how === 'str_first_word');
    expect(g[first]).toBe("['The']");
    expect(o[first]).toBe('[]');
    const differing = inputs.filter((_, k) => o[k] !== g[k]).map((i) => i.how);
    expect(new Set(differing)).toContain('str_first_word');
    expect(new Set(differing)).toContain('str_empty');
  });

  it('expression inputs that fail to build are behaviour too, not a probe failure', () => {
    const p = write('build_error', 'def build_error(x):\n    return x\n');
    const inputs: PerturbedInput[] = [{ input: [], exprs: ['__jev_class(None, "Missing")'], derivedFrom: 't', how: 'linked_list_acyclic' }, { input: [1], derivedFrom: 't', how: 'int_plus_one' }];
    expect(parseBehaviourProbe(run(behaviourProbeCommand({ name: 'build_error', candidatePath: p, inputs, perInputTimeoutMs: 500 })))).toBe('outputs:ERROR NameError\u00011'.replace('\u0001', '\u001f'));
  });
});

// ---------------------------------------------------------------------------------------
// Ladder-class workspaces: the harvested test calls (LADDER_HARNESS, moved here from
// experiments/inspect/ladder-verdicts.mts; the head-to-head's shipping / textstats / grades)
// ---------------------------------------------------------------------------------------

describe('ladder-class workspaces: harvest and replay of the test calls (real python3, the bench shipping task)', () => {
  const TASK = join(REPO_ROOT, 'bench/data/ladder/tasks/shipping');
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-ladder-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // the buggy tree (free_over 500.0) and the gold tree (50.0), each `src/` + `tests/`
  const buggy = join(dir, 'buggy');
  const gold = join(dir, 'gold');
  for (const t of [buggy, gold]) {
    cpSync(join(TASK, 'src'), join(t, 'src'), { recursive: true });
    cpSync(join(TASK, 'tests'), join(t, 'tests'), { recursive: true });
  }
  cpSync(join(TASK, 'gold', 'shipping.py'), join(gold, 'src', 'shipping.py'));
  const runIn = (cmd: string, cwd: string): string => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 60_000, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const SHIPPING_FILES = new Map([
    ['src/shipping.py', sourceFile('src/shipping.py', readFileSync(join(TASK, 'src', 'shipping.py'), 'utf8'))],
    ['src/__init__.py', sourceFile('src/__init__.py', '')],
  ]);
  const SHIPPING_GOAL = goal([failure('tests/test_shipping.py::test_free_at_threshold', '0.0', '4.99')]);
  const harvest = (): NonNullable<ReturnType<typeof parseLadderHarvest>> => {
    const h = parseLadderHarvest(runIn(ladderHarvestCommand({ tree: buggy, modules: ['src.shipping'], testModules: ['tests/test_shipping.py'] }), buggy));
    if (h === null) throw new Error('no harvest');
    return h;
  };

  it('ladderLayoutOf: the src/ modules and the goal\'s test modules; null for a QuixBugs program, a package outside src/, or no test module', () => {
    expect(ladderLayoutOf(SHIPPING_GOAL, SHIPPING_FILES)).toEqual({ modules: ['src.shipping'], testModules: ['tests/test_shipping.py'] });
    const nested = new Map([...SHIPPING_FILES, ['src/util/money.py', sourceFile('src/util/money.py', 'X = 1\n')], ['src/util/__init__.py', sourceFile('src/util/__init__.py', '')]]);
    expect(ladderLayoutOf(SHIPPING_GOAL, nested)?.modules).toEqual(['src.shipping', 'src.util.money']);
    expect(ladderLayoutOf(WRAP_GOAL, WRAP_FILES)).toBeNull();
    expect(ladderLayoutOf(SHIPPING_GOAL, new Map([['lib/shipping.py', sourceFile('lib/shipping.py', 'X = 1\n')]]))).toBeNull();
    expect(ladderLayoutOf(goal([failure('shipping_cost(20.0, "standard")')]), SHIPPING_FILES)).toBeNull();
  });

  it('harvest: the recorder sees the test calls and the nested ones; perturbed calls first, round-robin over the functions, recorded originals last; ≤ LADDER_MAX_PROBE_INPUTS, deduplicated', () => {
    const h = harvest();
    expect(h.functions).toBe(7);
    expect(h.recorded).toBeGreaterThanOrEqual(10);
    expect(h.importErrors).toEqual({});
    expect(h.inputs).toHaveLength(LADDER_MAX_PROBE_INPUTS);
    expect(h.inputs.every((p) => p.call?.module === 'src.shipping' && p.input.length === 0)).toBe(true);
    expect(new Set(h.inputs.map(inputKey)).size).toBe(h.inputs.length);
    const kinds = new Set(h.inputs.map((p) => p.how));
    expect(kinds.has('float_minus_half')).toBe(true);
    expect(kinds.has('none')).toBe(true);
    expect(kinds.has('str_empty')).toBe(true);
    // half-step float perturbations the visible tests never make (`shipping_cost(49.5, …)`, `describe(79.5, …)`; which survive the seeded per-function cap varies)
    expect(h.inputs.some((p) => /^(?:shipping_cost|describe|quote|cheapest_method)\(\d+\.5[,)]/.test(p.call?.text ?? ''))).toBe(true);
    // round-robin: the first six inputs cover the six functions that take arguments (`methods()` has none to perturb); a recorded original never precedes a perturbed one
    expect(new Set(h.inputs.slice(0, 6).map((p) => p.call?.qualname)).size).toBe(6);
    const firstRecorded = h.inputs.findIndex((p) => p.how === 'recorded');
    if (firstRecorded >= 0) expect(h.inputs.slice(firstRecorded).every((p) => p.how === 'recorded')).toBe(true);
    expect(describeInput(h.inputs[0]!)).toBe(h.inputs[0]!.call?.text);
    expect(h.inputs[0]?.derivedFrom.startsWith('perturbed from test_shipping.py::')).toBe(true);
    // a smaller cap keeps the ordering
    const five = parseLadderHarvest(runIn(ladderHarvestCommand({ tree: buggy, modules: ['src.shipping'], testModules: ['tests/test_shipping.py'], perFnCap: 2 }), buggy), 5);
    expect(five?.inputs).toHaveLength(5);
    // no test module named and none under tests/: nothing recorded, no inputs, still a protocol line
    const bare = join(dir, 'bare');
    mkdirSync(join(bare, 'src'), { recursive: true });
    writeFileSync(join(bare, 'src', '__init__.py'), '');
    writeFileSync(join(bare, 'src', 'm.py'), 'def f(x):\n    return x\n');
    const none = parseLadderHarvest(runIn(ladderHarvestCommand({ tree: bare, modules: ['src.m', 'src.missing'], testModules: [] }), bare));
    expect(none).toMatchObject({ inputs: [], recorded: 0, functions: 1, importErrors: { 'src.missing': 'ModuleNotFoundError' } });
  });

  it('replay: the buggy and the gold tree differ exactly on the calls that cross the threshold; the signature is `outputs:` like the QuixBugs probe', () => {
    const h = harvest();
    const b = parseLadderReplay(runIn(ladderReplayCommand({ tree: buggy, inputs: h.inputs, perInputTimeoutMs: 1000 }), buggy));
    const g = parseLadderReplay(runIn(ladderReplayCommand({ tree: gold, inputs: h.inputs, perInputTimeoutMs: 1000 }), gold));
    expect(b?.startsWith('outputs:')).toBe(true);
    expect(g?.startsWith('outputs:')).toBe(true);
    expect(b).not.toBe(g);
    const bo = outputsOf(b);
    const go = outputsOf(g);
    expect(bo).toHaveLength(h.inputs.length);
    const differing = h.inputs.filter((_, k) => bo[k] !== go[k]);
    expect(differing.length).toBeGreaterThan(0);
    // every differing call goes through the threshold (shipping_cost, or a caller of it) with a subtotal between 50.0 and 500.0 — only the fix decides it
    expect(differing.every((p) => /^(?:shipping_cost|describe|quote|cheapest_method)\((\d+(?:\.\d+)?)/.test(p.call?.text ?? ''))).toBe(true);
    for (const p of differing) {
      const subtotal = Number(/\((\d+(?:\.\d+)?)/.exec(p.call?.text ?? '')?.[1]);
      expect(subtotal).toBeGreaterThanOrEqual(50);
      expect(subtotal).toBeLessThan(500);
    }
    // the agreeing calls (the 4.99 rate below the threshold, the remote surcharge, the unknown method) are the bulk
    expect(differing.length).toBeLessThan(h.inputs.length / 2);
  });

  it('a fix that mutates its arguments is a different behaviour: the replay marks it (textstats `tokens.append(n)`)', () => {
    const tree = join(dir, 'mut');
    mkdirSync(join(tree, 'src'), { recursive: true });
    mkdirSync(join(tree, 'tests'), { recursive: true });
    writeFileSync(join(tree, 'src', '__init__.py'), '');
    writeFileSync(join(tree, 'src', 'ngrams.py'), 'def count(tokens, n):\n    tokens.append(n)\n    return len(tokens)\n');
    writeFileSync(join(tree, 'tests', 'test_ngrams.py'), 'from src.ngrams import count\n\n\ndef test_count():\n    assert count(["a", "b"], 2) == 3\n');
    const h = parseLadderHarvest(runIn(ladderHarvestCommand({ tree, modules: ['src.ngrams'], testModules: ['tests/test_ngrams.py'] }), tree));
    expect(h?.recorded).toBe(1);
    const recorded = h!.inputs.find((p) => p.how === 'recorded')!;
    expect(recorded.call?.text).toBe("count(['a', 'b'], 2)");
    const sig = parseLadderReplay(runIn(ladderReplayCommand({ tree, inputs: [recorded], perInputTimeoutMs: 1000 }), tree));
    // the canonical `(args, kwargs)` after the call, as the verdict script compares it
    expect(sig).toBe("outputs:3 [arguments mutated to ((['a', 'b', 2], 2), {})]");
    expect(ladderOutputText('3', 'x', false)).toBe('3');
  });

  it('commands and parsers: argv shapes, inline or file-borne inputs, tolerated garbage', () => {
    const call = { module: 'src.a', qualname: 'f', blob: 'QUJD', text: 'f(1)' };
    const input: PerturbedInput = { input: [], derivedFrom: 't', how: 'int_plus_one', call };
    expect(inputKey(input)).toBe('call:src.a.f:QUJD');
    const hv = ladderHarvestCommand({ tree: '/t', modules: ['src.a', 'src.b'], testModules: ['tests/test_a.py'] });
    expect(hv.startsWith(`PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 python3 - 'harvest' '/t' 'src.a,src.b' 'tests/test_a.py' '${LADDER_HARVEST_SEED}' '${LADDER_PER_FUNCTION_CAP}' '-' <<'JEVCODE_LADDER_HARNESS'\n`)).toBe(true);
    expect(ladderHarvestCommand({ tree: '/t', modules: ['src.a'], testModules: [], outPath: '/x/inputs.json', seed: 1, perFnCap: 80 })).toContain(" 'harvest' '/t' 'src.a' '' '1' '80' '/x/inputs.json' ");
    const rp = ladderReplayCommand({ tree: '/t', inputs: [input, { input: [1], derivedFrom: 't', how: 'int_plus_one' }], perInputTimeoutMs: 500 });
    expect(rp).toContain(` 'replay' '/t' '[{"module":"src.a","qualname":"f","blob":"QUJD"}]' '0.5' `);
    expect(ladderReplayCommand({ tree: '/t', inputs: [input], perInputTimeoutMs: 500, inputsPath: '/x/inputs.json' })).toContain(" 'replay' '/t' '@/x/inputs.json' '0.5' ");
    expect(parseLadderHarvest('Traceback: boom')).toBeNull();
    expect(parseLadderHarvest('{"probe":"import_error"}')).toBeNull();
    expect(parseLadderHarvest('{"probe":"ok","recorded":0,"functions":0,"records":[{"module":"m","qualname":"f","blob":"x","how":"unknown_kind","text":"f()"}]}')).toMatchObject({ inputs: [], recorded: 0, functions: 0 });
    expect(parseLadderReplay('nothing')).toBeNull();
    expect(parseLadderReplay('{"probe":"ok","outputs":"x"}')).toBeNull();
    expect(parseLadderReplay('{"probe":"ok","outputs":[{"r":"1","t":true,"a":"((1,), {})","m":false},{"r":"ERROR ValueError","t":null,"a":"","m":true}]}')).toBe('outputs:1\u001fERROR ValueError [arguments mutated to ]');
  });
});
