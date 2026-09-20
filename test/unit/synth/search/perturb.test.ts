import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Json } from '../../../../src/core/types.js';
import {
  LINKED_LIST_MAX_LENGTH,
  MAX_PERTURBED_INPUTS,
  NO_TEST_SOURCES,
  behaviourProbeCommand,
  chainExpr,
  inputKey,
  linkedListInputs,
  linkedListShape,
  parseBehaviourProbe,
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
