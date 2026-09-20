/**
 * Code-derived perturbed inputs and the behaviour probe behind the guard's clustering step
 * (docs/JEV-ONLY-DESIGN.md §2.6 `clusterByBehaviour(plausible, perturbedInputs(goal))`).
 *
 * Every input here is derived from the visible tests by structural perturbation, in code:
 *   - JSON-tested programs (`tests/<name>.json`, or the failing calls when they parse): ±1 on
 *     integers; drop / duplicate an element, the empty and the singleton list; a trailing word,
 *     the first word alone, the last word dropped and the empty string on strings; two same-typed
 *     arguments swapped.
 *   - linked lists built in a pytest module (`node5 = Node(5, node4)` chains, `detect_cycle`):
 *     the chain lengths the tests build, ±1..3, each acyclic and with the tail linked back to the
 *     head. These cannot be JSON, so they travel as Python expressions the probe evaluates in the
 *     candidate module's namespace (`__jev_chain(__jev_class('node', 'Node'), 'successor', 4, None)`).
 *
 * Why (jev-only-quixbugs-3-inspection.md §1): the two overfits of run 3 pass every visible test
 * and differ from the gold only on inputs the tests do not build — `detect_cycle`'s committed
 * guard crashes on acyclic lists of even length ≥ 4 (the tests use lengths 1, 2, 5), `wrap`'s
 * duplicated loop drops the remainder when the text fits or its last split is long (the tests'
 * paragraphs happen to end short). Behaviour clustering can only separate what it can run.
 *
 * The probe is one stdlib python3 process per candidate on a sieve lane; nothing here asks Jev.
 */
import { dirname } from 'node:path';

import type { Json, Sandbox } from '../../core/types.js';
import { isJsonArray, isJsonObject, isString, parseJson } from '../../core/json.js';
import type { LanePool } from '../sieve/lanes.js';
import type { Goal, OracleModel, VerifyOutcome } from './types.js';
import type { SourceFile } from '../types.js';
import { shellQuote } from '../verify/text.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement or design rule behind it)
// ---------------------------------------------------------------------------------------

/**
 * Perturbed inputs per goal: each costs one guarded call per plausible candidate inside one probe
 * process, worst case `perTestTimeoutMs` (≤ 2 s) each, so 16 keeps a candidate's probe ≤ 32 s even
 * when every perturbation loops forever (§4.3 budgets the clustering step as one run).
 */
export const MAX_PERTURBED_INPUTS = 16;
/** Per-input timeout of the probe when the oracle has none (QuixBugs default `--timeout 2`). */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;
/** repr() of one output kept in a signature; longer values are cut (only equality matters). */
export const PROBE_OUTPUT_BOUND = 400;
/** Linked-list lengths tried around each length the tests build (±1..3: the brief's rule). */
export const LINKED_LIST_LENGTH_SPREAD = 3;
/** Longest chain built (a cycle detector on 12 nodes is still instant; longer adds nothing). */
export const LINKED_LIST_MAX_LENGTH = 12;
/** A test module or JSON case file larger than this is not read (the QuixBugs files are ≤ 10 KB). */
export const TEST_SOURCE_MAX_BYTES = 256 * 1024;
/** Output cap of one probe process (16 outputs × 400 chars plus a traceback fit easily). */
export const PROBE_OUTPUT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------
// Perturbed inputs
// ---------------------------------------------------------------------------------------

export type PerturbationKind =
  | 'int_plus_one'
  | 'int_minus_one'
  | 'list_drop_first'
  | 'list_drop_last'
  | 'list_dup_first'
  | 'list_dup_last'
  | 'list_empty'
  | 'list_singleton'
  | 'str_trailing_word'
  | 'str_drop_last_word'
  | 'str_first_word'
  | 'str_empty'
  | 'swap_same_type_args'
  | 'linked_list_acyclic'
  | 'linked_list_cycle';

export interface PerturbedInput {
  /** positional arguments for `fn(*input)`; ignored when `exprs` is set */
  input: Json[];
  /** test id (or case) the input was derived from */
  derivedFrom: string;
  how: PerturbationKind;
  /** Python expressions for the positional arguments, evaluated by the probe in the candidate module's namespace (linked lists) */
  exprs?: string[];
}

/** `gcd(13, 13)` → { name: 'gcd', args: [13, 13] }; null for pytest ids or a truncated (`…`) call. */
export function parseQuixbugsCall(call: string): { name: string; args: Json[] } | null {
  if (call.endsWith('…')) return null;
  const m = /^([A-Za-z_]\w*)\((.*)\)$/s.exec(call.trim());
  if (m === null) return null;
  const name = m[1] ?? '';
  const inner = m[2] ?? '';
  const parsed = parseJson(`[${inner}]`);
  if (!parsed.ok || !isJsonArray(parsed.value)) return null;
  return { name, args: parsed.value };
}

function jsonType(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Round-robin merge of per-argument lists so the first few perturbations of an input already vary every argument and kind. */
function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  for (let k = 0; ; k++) {
    let any = false;
    for (const l of lists) {
      const x = l[k];
      if (x === undefined) continue;
      any = true;
      out.push(x);
    }
    if (!any) return out;
  }
}

/** The structural perturbations of one positional-argument list, in code. */
export function perturbationsOf(args: readonly Json[]): { input: Json[]; how: PerturbationKind }[] {
  const withArg = (i: number, v: Json): Json[] => args.map((a, k) => (k === i ? v : a));
  const perArg: { input: Json[]; how: PerturbationKind }[][] = args.map((a, i) => {
    const out: { input: Json[]; how: PerturbationKind }[] = [];
    if (typeof a === 'number' && Number.isInteger(a)) {
      out.push({ input: withArg(i, a + 1), how: 'int_plus_one' });
      out.push({ input: withArg(i, a - 1), how: 'int_minus_one' });
    } else if (Array.isArray(a)) {
      if (a.length > 0) {
        out.push({ input: withArg(i, a.slice(1)), how: 'list_drop_first' });
        out.push({ input: withArg(i, a.slice(0, -1)), how: 'list_drop_last' });
        out.push({ input: withArg(i, [a[0] ?? null, ...a]), how: 'list_dup_first' });
        out.push({ input: withArg(i, [...a, a[a.length - 1] ?? null]), how: 'list_dup_last' });
        out.push({ input: withArg(i, [a[0] ?? null]), how: 'list_singleton' });
      }
      out.push({ input: withArg(i, []), how: 'list_empty' });
    } else if (typeof a === 'string' && a !== '') {
      // words split on single spaces: a text that fits, a longer tail, a shorter tail, nothing
      const words = a.split(' ').filter((w) => w !== '');
      const first = words[0] ?? a;
      if (words.length > 1) out.push({ input: withArg(i, first), how: 'str_first_word' });
      out.push({ input: withArg(i, `${a} ${first}`), how: 'str_trailing_word' });
      out.push({ input: withArg(i, ''), how: 'str_empty' });
      if (words.length > 1) out.push({ input: withArg(i, a.slice(0, a.lastIndexOf(' '))), how: 'str_drop_last_word' });
    }
    return out;
  });
  const out = interleave(perArg);
  for (let i = 0; i < args.length; i++) {
    for (let j = i + 1; j < args.length; j++) {
      const a = args[i];
      const b = args[j];
      if (a === undefined || b === undefined || jsonType(a) !== jsonType(b) || JSON.stringify(a) === JSON.stringify(b)) continue;
      const swapped = [...args];
      swapped[i] = b;
      swapped[j] = a;
      out.push({ input: swapped, how: 'swap_same_type_args' });
    }
  }
  return out;
}

/** Key of an input for deduplication: the JSON arguments, or the expressions. */
export function inputKey(p: Pick<PerturbedInput, 'input' | 'exprs'>): string {
  return p.exprs !== undefined ? `py:${p.exprs.join('\u001f')}` : JSON.stringify(p.input);
}

/**
 * Merge per-source lists (one per test or case) into ≤ `max` inputs, deduplicated against
 * `exclude` (the originals) and each other. First pass: round-robin over the sources, each
 * contributing its first perturbation of a KIND not taken yet, so five cases that share one
 * paragraph (wrap: 5 × the same text at different widths) still yield every kind rather than
 * five first-word variants; second pass: plain round-robin over what is left, so no single
 * test dominates.
 */
function roundRobin(perSource: readonly (readonly PerturbedInput[])[], exclude: ReadonlySet<string>, max: number): PerturbedInput[] {
  const seen = new Set<string>(exclude);
  const kinds = new Set<PerturbationKind>();
  const taken = perSource.map(() => new Set<number>());
  const out: PerturbedInput[] = [];
  const take = (s: number, k: number, p: PerturbedInput): void => {
    taken[s]?.add(k);
    const key = inputKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    kinds.add(p.how);
    out.push(p);
  };
  for (let progress = true; progress && out.length < max; ) {
    progress = false;
    perSource.forEach((list, s) => {
      if (out.length >= max) return;
      const k = list.findIndex((p, i) => !(taken[s]?.has(i) ?? false) && !kinds.has(p.how) && !seen.has(inputKey(p)));
      const p = list[k];
      if (k < 0 || p === undefined) return;
      take(s, k, p);
      progress = true;
    });
  }
  for (let round = 0; out.length < max; round++) {
    let any = false;
    perSource.forEach((list, s) => {
      const p = list[round];
      if (p === undefined) return;
      any = true;
      if (out.length >= max || (taken[s]?.has(round) ?? false)) return;
      take(s, round, p);
    });
    if (!any) break;
  }
  return out;
}

/**
 * Extra inputs derived from the goal's failing tests (§2.6) when their calls parse as
 * `name(json, ...)`: ±1 on integer arguments, drop or duplicate a list element, the empty and
 * singleton list, string word perturbations, swapping two same-typed arguments. Empty for pytest
 * and unknown runners (there the P2P outcome vector is the signature) and for pytest node ids.
 */
export function perturbedInputs(goal: Pick<Goal, 'failures'>, oracle: Pick<OracleModel, 'runner'>, max = MAX_PERTURBED_INPUTS): PerturbedInput[] {
  if (oracle.runner !== 'quixbugs') return [];
  const originals = new Set<string>();
  const perTest: PerturbedInput[][] = [];
  for (const f of goal.failures) {
    const parsed = parseQuixbugsCall(f.call);
    if (parsed === null) continue;
    originals.add(JSON.stringify(parsed.args));
    perTest.push(perturbationsOf(parsed.args).map((p) => ({ input: p.input, derivedFrom: f.testId, how: p.how })));
  }
  return roundRobin(perTest, originals, max);
}

/** `wrap("The leaves…", 50)` for a JSON case, bounded like the runner's ids. */
function caseId(name: string, args: readonly Json[]): string {
  const text = `${name}(${args.map((v) => JSON.stringify(v)).join(', ')})`;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * The same perturbations over the JSON cases of `tests/<name>.json` (`[{ input, expected }]`),
 * which carry the full inputs where the failure views are cut at VALUE_BOUND (a 945-character
 * paragraph never parses back from a `…` call). Anything that is not that shape gives [].
 */
export function perturbedInputsFromCases(cases: Json, name: string, max = MAX_PERTURBED_INPUTS): PerturbedInput[] {
  if (!isJsonArray(cases)) return [];
  const originals = new Set<string>();
  const perCase: PerturbedInput[][] = [];
  for (const c of cases) {
    if (!isJsonObject(c) || !('input' in c)) continue;
    const input = c['input'] ?? null;
    const args: Json[] = isJsonArray(input) ? input : [input];
    originals.add(JSON.stringify(args));
    const id = caseId(name, args);
    perCase.push(perturbationsOf(args).map((p) => ({ input: p.input, derivedFrom: id, how: p.how })));
  }
  return roundRobin(perCase, originals, max);
}

// ---------------------------------------------------------------------------------------
// Linked lists built in a pytest module
// ---------------------------------------------------------------------------------------

/** What the test module builds: `Node` chains linked through `successor`, of these lengths. */
export interface LinkedListShape {
  className: string;
  /** module (file stem) defining the class when a corpus file does; null → the program module's namespace */
  module: string | null;
  /** the link attribute (`successor`) */
  attr: string;
  /** distinct chain lengths the tests pass to the function, ascending */
  lengths: number[];
  /** the tests also close a cycle (`node1.successor = node5`) */
  cyclic: boolean;
}

const CONSTRUCTION = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Z]\w*)\s*\((.*)\)\s*$/;
const LINK_ASSIGN = /^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*$/;

function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/** The class block named `cls` in `files` and its `__init__` parameter names (without self), if any. */
function classInit(cls: string, files: readonly SourceFile[]): { module: string; params: string[] } | null {
  for (const f of files) {
    const block = f.mod.blocks.find((b) => b.kind === 'class' && b.name === cls);
    if (block === undefined) continue;
    const init = f.mod.blocks.find((b) => b.kind === 'def' && b.name === '__init__' && b.parent === block.index);
    const params = init === undefined ? [] : init.params.filter((p) => p.star === '').map((p) => p.name).slice(1);
    const module = f.path.replace(/\.py$/, '').split('/').pop() ?? f.path;
    return { module, params };
  }
  return null;
}

/**
 * Recognise linked lists a test module builds: assignments `name = Cls(args)` where one argument
 * is an earlier constructed name (the link), the link attribute from `x.attr = y` statements
 * between constructed names or from `Cls.__init__`'s parameter at the link's position, and the
 * chain lengths of the names passed to `functionName(...)`. Null when the module builds none.
 */
export function linkedListShape(testSource: string, functionName: string, files: readonly SourceFile[]): LinkedListShape | null {
  const built = new Map<string, { cls: string; args: string[] }>();
  const links = new Map<string, string>();
  let linkIndex: number | null = null;
  const classes = new Map<string, number>();
  for (const line of testSource.split('\n')) {
    const m = CONSTRUCTION.exec(line);
    if (m === null) continue;
    const name = m[1] ?? '';
    const cls = m[2] ?? '';
    const args = splitArgs(m[3] ?? '');
    built.set(name, { cls, args });
    args.forEach((a, k) => {
      const target = built.get(a);
      if (target === undefined || target.cls !== cls) return;
      links.set(name, a);
      linkIndex ??= k;
      classes.set(cls, (classes.get(cls) ?? 0) + 1);
    });
  }
  if (classes.size === 0) return null;
  const className = [...classes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '';
  const init = classInit(className, files);

  // the link attribute: what the tests assign between two constructed nodes, else __init__'s parameter at the link position
  let attr: string | null = null;
  let cyclic = false;
  for (const line of testSource.split('\n')) {
    const m = LINK_ASSIGN.exec(line);
    if (m === null) continue;
    const [, recv, a, val] = m;
    if (recv === undefined || a === undefined || val === undefined || !built.has(recv) || !built.has(val)) continue;
    attr ??= a;
    cyclic = true;
  }
  if (attr === null && init !== null && linkIndex !== null) attr = init.params[linkIndex] ?? null;
  if (attr === null) return null;

  const lengthOf = (name: string): number => {
    let n = 0;
    const seen = new Set<string>();
    for (let cur: string | undefined = name; cur !== undefined && built.has(cur) && !seen.has(cur); cur = links.get(cur)) {
      seen.add(cur);
      n++;
    }
    return n;
  };
  const roots = new Set<string>();
  const callRe = new RegExp(`\\b${functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(\\s*([A-Za-z_]\\w*)`, 'g');
  for (const m of testSource.matchAll(callRe)) if (built.has(m[1] ?? '')) roots.add(m[1] ?? '');
  const names = roots.size > 0 ? [...roots] : [...built.keys()].filter((n) => built.get(n)?.cls === className);
  const lengths = [...new Set(names.map(lengthOf).filter((n) => n > 0))].sort((a, b) => a - b);
  if (lengths.length === 0) return null;
  return { className, module: init?.module ?? null, attr, lengths, cyclic };
}

/** The probe-side expression building a chain of `n` nodes, the tail linked to `cycleTo` (index) or nowhere. */
export function chainExpr(shape: Pick<LinkedListShape, 'className' | 'module' | 'attr'>, n: number, cycleTo: number | null): string {
  const mod = shape.module === null ? 'None' : JSON.stringify(shape.module);
  return `__jev_chain(__jev_class(${mod}, ${JSON.stringify(shape.className)}), ${JSON.stringify(shape.attr)}, ${n}, ${cycleTo === null ? 'None' : String(cycleTo)})`;
}

/**
 * Linked-list inputs around the lengths the tests build (each ±1..LINKED_LIST_LENGTH_SPREAD,
 * clipped to 1..LINKED_LIST_MAX_LENGTH), acyclic and with the tail linked back to the head,
 * interleaved by length so a cut at `max` keeps both toggles of the short lists.
 */
export function linkedListInputs(shape: LinkedListShape, derivedFrom: string, max = MAX_PERTURBED_INPUTS): PerturbedInput[] {
  const lengths = new Set<number>();
  for (const l of shape.lengths) for (let d = -LINKED_LIST_LENGTH_SPREAD; d <= LINKED_LIST_LENGTH_SPREAD; d++) if (l + d >= 1 && l + d <= LINKED_LIST_MAX_LENGTH) lengths.add(l + d);
  const out: PerturbedInput[] = [];
  for (const n of [...lengths].sort((a, b) => a - b)) {
    out.push({ input: [], exprs: [chainExpr(shape, n, null)], derivedFrom, how: 'linked_list_acyclic' });
    out.push({ input: [], exprs: [chainExpr(shape, n, 0)], derivedFrom, how: 'linked_list_cycle' });
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------------------
// Test-derived sources: which files to read, and the combined input set
// ---------------------------------------------------------------------------------------

/** What the workspace's tests give the perturbation: the JSON cases and the pytest module sources. */
export interface TestSources {
  /** parsed `tests/<name>.json`, null when absent */
  cases: Json | null;
  /** test module path → source */
  modules: ReadonlyMap<string, string>;
}

export const NO_TEST_SOURCES: TestSources = { cases: null, modules: new Map() };

/** Workspace-relative test module paths named by the goal's test ids (`tests/x_test.py::test4` → `tests/x_test.py`). */
export function testModulePaths(goal: Pick<Goal, 'tests'>): string[] {
  const out = new Set<string>();
  for (const id of goal.tests) {
    const path = id.split('::')[0] ?? '';
    if (path.endsWith('.py')) out.add(path);
  }
  return [...out];
}

/**
 * The QuixBugs program name behind the goal: the test module's stem without `test_` / `_test`
 * (`tests/test_wrap.py` → `wrap`, `tests/detect_cycle_test.py` → `detect_cycle`), when
 * `<name>.py` is a workspace file; else the parsed name of a failing call; else null.
 */
export function programNameOf(goal: Pick<Goal, 'tests' | 'failures'>, files: ReadonlyMap<string, SourceFile>): string | null {
  for (const path of testModulePaths(goal)) {
    const stem = (path.split('/').pop() ?? '').replace(/\.py$/, '');
    const name = stem.replace(/^test_/, '').replace(/_tests?$/, '');
    if (name !== '' && files.has(`${name}.py`)) return name;
  }
  for (const f of goal.failures) {
    const parsed = parseQuixbugsCall(f.call);
    if (parsed !== null && files.has(`${parsed.name}.py`)) return parsed.name;
  }
  return null;
}

/** Read the test sources through `read` (null on any failure): the goal's test modules and `tests/<name>.json`. */
export async function readTestSources(read: (path: string) => Promise<string | null>, goal: Pick<Goal, 'tests'>, program: string | null): Promise<TestSources> {
  const modules = new Map<string, string>();
  for (const path of testModulePaths(goal)) {
    const src = await read(path);
    if (src !== null) modules.set(path, src);
  }
  let cases: Json | null = null;
  if (program !== null) {
    const raw = await read(`tests/${program}.json`);
    if (raw !== null) {
      const parsed = parseJson(raw);
      if (parsed.ok) cases = parsed.value;
    }
  }
  return { cases, modules };
}

/**
 * Every perturbed input the guard can run for `goal`: from the failing calls, from the JSON cases,
 * and from the linked lists the test modules build; deduplicated, bounded by `max`, with the
 * test-file-derived inputs filling what the calls leave (they are the fuller source). Gated on
 * the program (`programNameOf`: the QuixBugs layout), NOT on `oracle.runner`: the bench's QuixBugs
 * workspaces run under pytest modules, so `fitOracle` labels them `pytest` (the runner is read
 * from the baseline command) and the first live run of the probe never started for that reason
 * (jev-only-rungs-1-2.md §13). The calls' own perturbations keep the runner gate they always had.
 */
export function perturbedInputsFor(goal: Pick<Goal, 'tests' | 'failures'>, oracle: Pick<OracleModel, 'runner'>, program: string | null, files: ReadonlyMap<string, SourceFile>, sources: TestSources, max = MAX_PERTURBED_INPUTS): PerturbedInput[] {
  if (program === null) return [];
  const out: PerturbedInput[] = [];
  const seen = new Set<string>();
  const add = (list: readonly PerturbedInput[]): void => {
    for (const p of list) {
      if (out.length >= max) return;
      const k = inputKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  };
  const lists: PerturbedInput[][] = [perturbedInputs(goal, oracle, max)];
  if (sources.cases !== null) lists.push(perturbedInputsFromCases(sources.cases, program, max));
  const corpus = [...files.values()];
  for (const [path, src] of sources.modules) {
    const shape = linkedListShape(src, program, corpus);
    if (shape !== null) lists.push(linkedListInputs(shape, path, max));
  }
  // the fuller sources first when the calls gave nothing; otherwise the calls' own inputs lead
  for (const list of lists) add(list);
  return out;
}

// ---------------------------------------------------------------------------------------
// The behaviour probe: one stdlib python3 process per candidate, all inputs, per-input timeout
// ---------------------------------------------------------------------------------------

const PROBE_HEREDOC = 'JEVCODE_BEHAVIOUR_PROBE';

/**
 * The probe script mirrors run_tests.py's child: import the candidate under the program's name,
 * call `fn(*deepcopy(input))` (or `fn(*[eval(e) for e in exprs])` for expression inputs, built
 * in the module's namespace with the linked-list helpers), materialise generators, and record
 * repr(result) or the exception class, each under a SIGALRM timer so one looping perturbation
 * does not hide the others. The candidate's own prints go to stderr so they cannot corrupt the
 * one protocol line.
 */
const PROBE_SCRIPT = String.raw`
import copy, importlib, importlib.util, json, os, signal, sys, types
name, path, timeout_s = sys.argv[1], sys.argv[2], float(sys.argv[3])
inputs = json.loads(sys.argv[4])
for extra in sys.argv[5:]:
    if extra and extra not in sys.path:
        sys.path.insert(0, extra)
proto = os.fdopen(os.dup(1), "w")
sys.stdout = sys.stderr
class _Timeout(BaseException):
    pass
def _alarm(signum, frame):
    raise _Timeout()
signal.signal(signal.SIGALRM, _alarm)
try:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    fn = getattr(module, name)
except BaseException as exc:
    proto.write(json.dumps({"probe": "import_error", "error": type(exc).__name__}) + "\n")
    proto.flush()
    sys.exit(0)
def __jev_class(module_name, class_name):
    obj = getattr(module, class_name, None)
    if obj is None and module_name:
        obj = getattr(importlib.import_module(module_name), class_name, None)
    if obj is None:
        raise NameError(class_name)
    return obj
def __jev_chain(cls, attr, n, cycle_to):
    nodes = []
    for i in range(n):
        try:
            node = cls(i + 1)
        except TypeError:
            node = cls()
        nodes.append(node)
    for a, b in zip(nodes, nodes[1:]):
        setattr(a, attr, b)
    if cycle_to is not None and nodes:
        setattr(nodes[-1], attr, nodes[cycle_to])
    return nodes[0] if nodes else None
ns = dict(vars(module))
ns["__jev_class"] = __jev_class
ns["__jev_chain"] = __jev_chain
outputs = []
for inp in inputs:
    signal.setitimer(signal.ITIMER_REAL, timeout_s)
    try:
        if isinstance(inp, dict):
            args = [eval(e, dict(ns)) for e in inp["py"]]
        else:
            args = copy.deepcopy(inp)
        result = fn(*args)
        if isinstance(result, types.GeneratorType):
            result = list(result)
        text = repr(result)
    except _Timeout:
        text = "TIMEOUT"
    except BaseException as exc:
        text = "ERROR " + type(exc).__name__
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    outputs.append(text[:${PROBE_OUTPUT_BOUND}])
proto.write(json.dumps({"probe": "ok", "outputs": outputs}) + "\n")
proto.flush()
`.trim();

export interface ProbeCommandOptions {
  /** the QuixBugs program name (module and function name) */
  name: string;
  /** the candidate file to import */
  candidatePath: string;
  inputs: readonly PerturbedInput[];
  /** per input; the process gets inputs × this + a margin from `probeTimeoutMs` */
  perInputTimeoutMs: number;
  /** extra sys.path entries (the QuixBugs `programs/` dir for `from node import Node`) */
  pythonPath?: readonly string[];
}

/** The wire form of one input: the JSON arguments, or `{"py": [expr, ...]}`. */
function wireInput(p: PerturbedInput): Json {
  return p.exprs !== undefined ? { py: [...p.exprs] } : p.input;
}

/**
 * The `sh -c` command that prints one JSON line `{"probe":"ok","outputs":[...]}`. PYTHONHASHSEED=0
 * makes repr() of sets and dicts of strings stable across candidates, so equal behaviour gives
 * equal text; PYTHONDONTWRITEBYTECODE avoids the stale-`.pyc` pitfall of probe-question-design.md §8.
 */
export function behaviourProbeCommand(o: ProbeCommandOptions): string {
  const args = [o.name, o.candidatePath, String(o.perInputTimeoutMs / 1000), JSON.stringify(o.inputs.map(wireInput)), ...(o.pythonPath ?? [])];
  return `PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 python3 - ${args.map(shellQuote).join(' ')} <<'${PROBE_HEREDOC}'\n${PROBE_SCRIPT}\n${PROBE_HEREDOC}`;
}

/** Wall-clock limit for one probe process: every input timing out plus interpreter start-up. */
export function probeTimeoutMs(inputs: number, perInputTimeoutMs: number): number {
  return inputs * perInputTimeoutMs + 2000;
}

/**
 * The behaviour signature from a probe's stdout: the outputs joined, or `import_error:<Class>`;
 * null when the process produced no protocol line (killed, crashed) — the caller then falls back
 * to the P2P vector rather than inventing a cluster.
 */
export function parseBehaviourProbe(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    const parsed = parseJson(line);
    if (!parsed.ok || !isJsonObject(parsed.value)) continue;
    const o = parsed.value;
    if (o['probe'] === 'import_error') return `import_error:${isString(o['error']) ? o['error'] : 'unknown'}`;
    const outputs = o['outputs'];
    if (o['probe'] === 'ok' && isJsonArray(outputs)) return `outputs:${outputs.map((v) => (isString(v) ? v : JSON.stringify(v))).join('\u001f')}`;
  }
  return null;
}

/** Runs the probe for each plausible candidate; the sieve's lanes own the execution. */
export type BehaviourProbe = (plausible: readonly VerifyOutcome[], inputs: readonly PerturbedInput[]) => Promise<ReadonlyMap<string, string>>;

export interface LaneProbeContext {
  sandbox: Pick<Sandbox, 'run'>;
  signal: AbortSignal;
}

/**
 * The probe on the sieve's lanes: each plausible candidate is written into a free lane (its base's
 * files first, as the runner does), `<program>.py` is imported from there with the lane on
 * `sys.path` (so `from node import Node` sees the lane's copy), and the signature is parsed from
 * the one protocol line. A candidate whose process produced none gets no signature and clusters
 * on its P2P vector alone. Candidates run concurrently up to the lane count.
 */
export function createLaneProbe(ctx: LaneProbeContext, pool: LanePool, program: string, perInputTimeoutMs: number): BehaviourProbe {
  return async (plausible, inputs) => {
    const out = new Map<string, string>();
    await Promise.all(
      plausible.map(async (o) => {
        const sig = await pool.withLane(async (lane) => {
          await pool.applyToLane(lane, o.applied, o.job.base.files);
          const candidatePath = pool.pathInLane(lane, `${program}.py`);
          const command = behaviourProbeCommand({ name: program, candidatePath, inputs, perInputTimeoutMs, pythonPath: [dirname(candidatePath)] });
          const res = await ctx.sandbox.run(command, { timeoutMs: probeTimeoutMs(inputs.length, perInputTimeoutMs), maxOutputBytes: PROBE_OUTPUT_BYTES, signal: ctx.signal, cwd: lane.dir });
          return parseBehaviourProbe(res.stdout);
        });
        if (sig !== null) out.set(o.applied.candidate.id, sig);
      }),
    );
    return out;
  };
}
