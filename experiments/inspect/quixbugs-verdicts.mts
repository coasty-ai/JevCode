/**
 * Per-program verdicts for a QuixBugs jev-only results directory (experiments/results/jev-only-audit.md
 * §6.3: the "27 gold-identical" of run 3 was a count with no per-program list and no code behind it).
 *
 * For every task in <resultsDir>/tasks.jsonl (last record per task wins):
 *   - the committed program is read from the run's bench workspace
 *     (~/.jevcode/runs/bench-work/<benchId>/<task>/jev-only/workspace/<task>.py), else rebuilt by
 *     applying the run's ~/.jevcode/runs/<runId>/model_patch.diff to bench/data/quixbugs/programs/<task>.py;
 *   - `miss`            the evaluator did not pass it (patch empty or a committed patch that still fails);
 *   - `gold-identical`  solved and token-identical to bench/data/quixbugs/correct/<task>.py (python
 *                       tokenize; comments, blank lines and the amount of whitespace ignored, indentation
 *                       structure kept);
 *   - otherwise both programs run on the evaluator's reference cases (run_tests.py) and on two
 *     code-generated input families, through the same probe shape the guard uses (one stdlib python3
 *     process per program: the candidate imported under the program's name with programs/ on sys.path,
 *     PYTHONHASHSEED=0, a SIGALRM timer per input, one JSON protocol line):
 *       (a) the perturbed inputs of src/synth/search/perturb.ts (JSON cases → ±1 / drop / duplicate /
 *           empty / singleton / word edits / swapped arguments; pytest Node chains → lengths ±1..3,
 *           acyclic and cyclic);
 *       (b) for the nine programs whose tests are pytest modules building Node/graph fixtures
 *           (topological_ordering, breadth_first_search, depth_first_search, detect_cycle,
 *           reverse_linked_list, minimum_spanning_tree, shortest_path_length, shortest_paths,
 *           shortest_path_lengths) a random-structure differential: --graph-n instances (default 500)
 *           from a fixed --seed (default 20260921), built identically in both processes — DAGs of 2–8
 *           nodes (plus the empty and the one-node list) checked by a validity oracle so any correct
 *           topological order counts as equal; random digraphs with a start and a goal; linked lists of
 *           0–12 nodes, acyclic or with the tail linked to a random node; random weighted graphs whose
 *           result must be a minimum spanning forest of the same weight; digraphs with distinct
 *           power-of-two lengths (so the reference's heap never compares two Nodes — a QuixBugs quirk);
 *           digraphs with negative weights but no negative cycles (potential reweighting).
 *       `equivalent`  every output (or exception class) matches the reference on every compared input,
 *       `overfit`     at least one differs,
 *       `unverified`  nothing could be compared (no perturbation applies and no generator) or the probe failed.
 *
 * Usage: node_modules/.bin/tsx experiments/inspect/quixbugs-verdicts.mts [resultsDir] [--out <file>] [--graph-n <N>] [--seed <int>]
 *   default resultsDir bench/results/jev-only-quixbugs-3, default out <resultsDir>/verdicts.md
 * Nothing here asks Jev; python3 (stdlib) is the only external program.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Json } from '../../src/core/types.ts';
import { behaviourProbeCommand, linkedListInputs, linkedListShape, perturbedInputsFromCases, probeTimeoutMs, type PerturbedInput } from '../../src/synth/search/perturb.ts';
import { shellQuote } from '../../src/synth/verify/text.ts';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const QB = join(ROOT, 'bench/data/quixbugs');
const RUNS = join(homedir(), '.jevcode/runs');
const PER_INPUT_TIMEOUT_MS = 2000;
const MAX_PERTURBED = 24;
const GRAPH_PER_INPUT_TIMEOUT_MS = 1000;
const DEFAULT_GRAPH_N = 500;
const DEFAULT_SEED = 20260921;

/** The pytest-module programs and the random-structure family the graph probe builds for each. */
const GRAPH_FAMILIES: Readonly<Record<string, string>> = {
  topological_ordering: 'random DAGs of 0–8 nodes (any valid topological order accepted)',
  breadth_first_search: 'random digraphs of 1–8 nodes with a start and a goal node',
  depth_first_search: 'random digraphs of 1–8 nodes with a start and a goal node',
  detect_cycle: 'random linked lists of 0–12 nodes, acyclic or tail linked to a random node',
  reverse_linked_list: 'random acyclic linked lists of 0–12 nodes (values walked from the returned head)',
  minimum_spanning_tree: 'random weighted graphs of 1–8 nodes (any minimum spanning forest of equal weight accepted)',
  shortest_path_length: 'random digraphs of 1–8 nodes with distinct power-of-two lengths',
  shortest_paths: 'random digraphs of 1–7 nodes, negative weights without negative cycles',
  shortest_path_lengths: 'random digraphs of 1–7 nodes, negative weights without negative cycles',
};

type Verdict = 'gold-identical' | 'equivalent' | 'overfit' | 'unverified' | 'miss';

interface TaskRecord {
  task: string;
  pass: boolean | null;
  runId: string | null;
  reason: string | null;
  stopReason: string | null;
  steps: number | null;
  patchEmpty: boolean | null;
}

interface Row {
  program: string;
  solved: boolean;
  verdict: Verdict;
  evidence: string;
}

function argv(): { resultsDir: string; out: string; graphN: number; seed: number } {
  const args = process.argv.slice(2);
  let resultsDir = 'bench/results/jev-only-quixbugs-3';
  let out: string | null = null;
  let graphN = DEFAULT_GRAPH_N;
  let seed = DEFAULT_SEED;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') out = args[++i] ?? null;
    else if (a === '--graph-n') graphN = Number(args[++i]);
    else if (a === '--seed') seed = Number(args[++i]);
    else resultsDir = a;
  }
  const dir = resolve(ROOT, resultsDir);
  return { resultsDir: dir, out: out === null ? join(dir, 'verdicts.md') : resolve(ROOT, out), graphN, seed };
}

function readRecords(dir: string): TaskRecord[] {
  const byTask = new Map<string, TaskRecord>();
  for (const line of readFileSync(join(dir, 'tasks.jsonl'), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    if (typeof r['task'] !== 'string') continue;
    byTask.set(r['task'], {
      task: r['task'],
      pass: typeof r['pass'] === 'boolean' ? r['pass'] : null,
      runId: typeof r['runId'] === 'string' ? r['runId'] : null,
      reason: typeof r['reason'] === 'string' ? r['reason'] : null,
      stopReason: typeof r['stopReason'] === 'string' ? r['stopReason'] : null,
      steps: typeof r['steps'] === 'number' ? r['steps'] : null,
      patchEmpty: typeof r['patchEmpty'] === 'boolean' ? r['patchEmpty'] : null,
    });
  }
  return [...byTask.values()].sort((a, b) => (a.task < b.task ? -1 : 1));
}

function benchIdOf(dir: string): string | null {
  const p = join(dir, 'summary.json');
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  return typeof s['benchId'] === 'string' ? s['benchId'] : null;
}

/** The committed program: the bench workspace file, else programs/<task>.py with model_patch.diff applied in a temp dir. */
async function patchedProgram(rec: TaskRecord, benchId: string | null, scratch: string): Promise<{ path: string; source: string; patchBytes: number }> {
  const buggy = join(QB, 'programs', `${rec.task}.py`);
  const diffPath = rec.runId === null ? null : join(RUNS, rec.runId, 'model_patch.diff');
  const patchBytes = diffPath !== null && existsSync(diffPath) ? readFileSync(diffPath).length : 0;
  if (benchId !== null) {
    const ws = join(RUNS, 'bench-work', benchId, rec.task, 'jev-only', 'workspace', `${rec.task}.py`);
    if (existsSync(ws)) return { path: ws, source: 'workspace', patchBytes };
  }
  if (diffPath !== null && patchBytes > 0) {
    const dir = join(scratch, rec.task);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    copyFileSync(buggy, join(dir, `${rec.task}.py`));
    try {
      await exec('git', ['apply', diffPath], { cwd: dir });
      return { path: join(dir, `${rec.task}.py`), source: 'model_patch.diff', patchBytes };
    } catch (e) {
      return { path: buggy, source: `model_patch.diff failed to apply: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, patchBytes };
    }
  }
  return { path: buggy, source: 'unchanged (no patch)', patchBytes };
}

const TOKEN_COMPARE = `
import sys, tokenize, io
def toks(path):
    with open(path, 'rb') as f:
        src = f.read()
    out = []
    for t in tokenize.tokenize(io.BytesIO(src).readline):
        if t.type in (tokenize.COMMENT, tokenize.NL, tokenize.ENCODING, tokenize.ENDMARKER):
            continue
        out.append((t.type, t.string))
    # a trailing NEWLINE before ENDMARKER is optional
    while out and out[-1][0] in (tokenize.NEWLINE, tokenize.DEDENT):
        out.pop()
    return out
a, b = toks(sys.argv[1]), toks(sys.argv[2])
if a == b:
    print('same')
else:
    n = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    print('differs at token %d: %r vs %r' % (n, a[n][1] if n < len(a) else '<end>', b[n][1] if n < len(b) else '<end>'))
`;

async function tokenIdentical(patched: string, reference: string): Promise<{ same: boolean; detail: string }> {
  const { stdout } = await exec('python3', ['-c', TOKEN_COMPARE, patched, reference]);
  const detail = stdout.trim();
  return { same: detail === 'same', detail };
}

interface RunTestsReport {
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
  total: number;
}

async function referenceCases(name: string, candidate: string): Promise<RunTestsReport | null> {
  try {
    const { stdout } = await exec('python3', [join(QB, 'run_tests.py'), name, candidate, '--timeout', '2'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return null;
    const r = JSON.parse(line) as Record<string, unknown>;
    const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
    return { passed: n('passed'), failed: n('failed'), errors: n('errors'), timeouts: n('timeouts'), total: n('total') };
  } catch (e) {
    // run_tests.py exits 1 when a case fails; the report is still on stdout
    const err = e as { stdout?: string };
    const line = (err.stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return null;
    const r = JSON.parse(line) as Record<string, unknown>;
    const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
    return { passed: n('passed'), failed: n('failed'), errors: n('errors'), timeouts: n('timeouts'), total: n('total') };
  }
}

/** The programs/ module that defines `class <className>` (QuixBugs: node.py), or null. */
function classModuleOf(className: string): string | null {
  const dir = join(QB, 'programs');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.py')) continue;
    if (new RegExp(`^class ${className}\\b`, 'm').test(readFileSync(join(dir, f), 'utf8'))) return f.slice(0, -3);
  }
  return null;
}

/** The perturbed inputs perturb.ts derives from the visible tests of `name`. */
function perturbedInputsOf(name: string): { inputs: PerturbedInput[]; basis: string } {
  const jsonPath = join(QB, 'tests', `${name}.json`);
  if (existsSync(jsonPath)) {
    const cases = JSON.parse(readFileSync(jsonPath, 'utf8')) as Json;
    return { inputs: perturbedInputsFromCases(cases, name, MAX_PERTURBED), basis: `tests/${name}.json` };
  }
  const pyPath = join(QB, 'tests', `${name}_test.py`);
  if (existsSync(pyPath)) {
    const parsed = linkedListShape(readFileSync(pyPath, 'utf8'), name, []);
    // perturb.ts resolves the class's module from the parsed workspace files; here (no parser) from programs/*.py
    const shape = parsed === null ? null : { ...parsed, module: parsed.module ?? classModuleOf(parsed.className) };
    if (shape !== null) return { inputs: linkedListInputs(shape, `${name}_test.py`, MAX_PERTURBED), basis: `tests/${name}_test.py (${shape.className} chains of lengths ${shape.lengths.join('/')}, class from ${shape.module ?? 'the program module'}.py)` };
    return { inputs: [], basis: `tests/${name}_test.py builds graph fixtures perturb.ts does not perturb` };
  }
  return { inputs: [], basis: 'no visible tests found' };
}

async function probeOutputs(name: string, candidatePath: string, inputs: readonly PerturbedInput[]): Promise<string[] | null> {
  const cmd = behaviourProbeCommand({ name, candidatePath, inputs, perInputTimeoutMs: PER_INPUT_TIMEOUT_MS, pythonPath: [join(QB, 'programs')] });
  try {
    const { stdout } = await exec('sh', ['-c', cmd], { timeout: probeTimeoutMs(inputs.length, PER_INPUT_TIMEOUT_MS), maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return null;
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o['probe'] === 'import_error') return [`import_error:${String(o['error'])}`];
    const outputs = o['outputs'];
    return Array.isArray(outputs) ? outputs.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : null;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------------------
// The random-structure differential for the pytest-module (graph / linked-list) programs
// ---------------------------------------------------------------------------------------

const GRAPH_PROBE_HEREDOC = 'JEVCODE_GRAPH_PROBE';

/**
 * Same process shape as perturb.ts's PROBE_SCRIPT (import under the program name, programs/ on
 * sys.path, stdout → stderr, SIGALRM per input, one protocol line), but the inputs are built inside
 * the process from `random.Random(seed)` — Node graphs cannot travel as JSON — and each family has
 * a checker that maps the result to a canonical text: a validity verdict where several answers are
 * correct (topological orders, minimum spanning forests), the walked values for a returned linked
 * list, sorted items for dicts and sets, repr() otherwise. The generator never reads the result, so
 * both processes build the same instance i for the same seed.
 */
const GRAPH_PROBE_SCRIPT = String.raw`
import importlib, importlib.util, json, os, random, signal, sys, types
name, path, timeout_s, seed, count = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
for extra in sys.argv[6:]:
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
    from node import Node
except BaseException as exc:
    proto.write(json.dumps({"probe": "import_error", "error": type(exc).__name__}) + "\n")
    proto.flush()
    sys.exit(0)
BOUND = 400
LABELS = "ABCDEFGHIJKL"
def canon(x):
    if isinstance(x, dict):
        return "{" + ", ".join("%s: %s" % (canon(k), canon(v)) for k, v in sorted(x.items(), key=lambda kv: canon(kv[0]))) + "}"
    if isinstance(x, (set, frozenset)):
        return type(x).__name__ + "{" + ", ".join(sorted(canon(v) for v in x)) + "}"
    if isinstance(x, (list, tuple)):
        inner = ", ".join(canon(v) for v in x)
        return "[" + inner + "]" if isinstance(x, list) else "(" + inner + ")"
    if isinstance(x, Node):
        return "Node(%r)" % (x.value,)
    return repr(x)
def val(x):
    return getattr(x, "value", x)
def components(nodes, edges):
    parent = {v: v for v in nodes}
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for u, v in edges:
        parent[find(u)] = find(v)
    groups = {}
    for v in nodes:
        groups.setdefault(find(v), set()).add(v)
    return sorted(tuple(sorted(g)) for g in groups.values())
def gen_topological_ordering(rng, i):
    n = 0 if i == 0 else 1 if i == 1 else rng.randint(2, 8)
    labels = list(LABELS[:n])
    hidden = labels[:]
    rng.shuffle(hidden)
    p = rng.uniform(0.15, 0.7)
    edges = [(hidden[a], hidden[b]) for a in range(n) for b in range(a + 1, n) if rng.random() < p]
    rng.shuffle(edges)
    nodes = {lab: Node(lab) for lab in labels}
    for lab in labels:
        nodes[lab].incoming_nodes = [nodes[u] for u, v in edges if v == lab]
        nodes[lab].outgoing_nodes = [nodes[v] for u, v in edges if u == lab]
    order = labels[:]
    rng.shuffle(order)
    arg = [nodes[lab] for lab in order]
    node_edges = [(nodes[u], nodes[v]) for u, v in edges]
    desc = "DAG n=%d nodes %s edges %s" % (n, "".join(order), ",".join("%s->%s" % e for e in edges) or "-")
    def check(result):
        try:
            items = list(result)
        except BaseException as exc:
            return "INVALID non-iterable %s" % type(exc).__name__
        if len(items) != len(arg) or set(map(id, items)) != set(map(id, arg)):
            return "INVALID %s" % canon([val(x) for x in items])
        pos = {id(x): k for k, x in enumerate(items)}
        for u, v in node_edges:
            if pos[id(u)] >= pos[id(v)]:
                return "INVALID order %s" % canon([val(x) for x in items])
        return "VALID n=%d" % n
    return desc, (arg,), check
def _digraph(rng, i, lo, hi, weights=None):
    n = 1 if i == 0 else rng.randint(1, 8)
    labels = list(LABELS[:n])
    p = rng.uniform(lo, hi)
    edges = [(u, v) for u in labels for v in labels if u != v and rng.random() < p]
    rng.shuffle(edges)
    nodes = {lab: Node(lab) for lab in labels}
    for lab in labels:
        nodes[lab].successors = [nodes[v] for u, v in edges if u == lab]
    return n, labels, edges, nodes
def gen_search(rng, i):
    n, labels, edges, nodes = _digraph(rng, i, 0.1, 0.6)
    start = rng.choice(labels)
    goal = start if rng.random() < 0.1 else rng.choice(labels)
    desc = "graph n=%d edges %s start %s goal %s" % (n, ",".join("%s->%s" % e for e in edges) or "-", start, goal)
    return desc, (nodes[start], nodes[goal]), canon
gen_breadth_first_search = gen_search
gen_depth_first_search = gen_search
def _chain(rng, i, allow_cycle):
    length = 0 if i == 0 else 1 if i == 1 else rng.randint(2, 12)
    nodes = [Node(k + 1) for k in range(length)]
    for a, b in zip(nodes, nodes[1:]):
        a.successor = b
    cycle_to = None
    if allow_cycle and length and rng.random() < 0.5:
        cycle_to = rng.randint(0, length - 1)
        nodes[-1].successor = nodes[cycle_to]
    head = nodes[0] if nodes else None
    return length, cycle_to, head, nodes
def gen_detect_cycle(rng, i):
    length, cycle_to, head, nodes = _chain(rng, i, True)
    desc = "list len=%d %s" % (length, "acyclic" if cycle_to is None else "tail->node%d" % (cycle_to + 1))
    return desc, (head,), canon
def gen_reverse_linked_list(rng, i):
    length, cycle_to, head, nodes = _chain(rng, i, False)
    desc = "list len=%d values %s" % (length, canon([n.value for n in nodes]))
    def check(result):
        out, cur, steps = [], result, 0
        while cur is not None:
            if steps > length + 1:
                return "INVALID walk %s..." % canon(out)
            out.append(val(cur))
            cur = getattr(cur, "successor", None)
            steps += 1
        return canon(out)
    return desc, (head,), check
def gen_minimum_spanning_tree(rng, i):
    n = 1 if i == 0 else rng.randint(2, 8)
    nodes = list(range(1, n + 1))
    p = rng.uniform(0.2, 0.8)
    edges = [(u, v) for u in nodes for v in nodes if u < v and rng.random() < p]
    rng.shuffle(edges)
    weight_by_edge = {e: rng.randint(1, 12) for e in edges}
    desc = "graph n=%d edges %s" % (n, ",".join("(%d,%d):%d" % (u, v, w) for (u, v), w in weight_by_edge.items()) or "-")
    def check(result):
        try:
            chosen = list(result)
        except BaseException as exc:
            return "INVALID non-iterable %s" % type(exc).__name__
        if any(e not in weight_by_edge for e in chosen) or len(set(chosen)) != len(chosen):
            return "INVALID edges %s" % canon(sorted(chosen, key=canon))
        parent = {v: v for v in nodes}
        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        for u, v in chosen:
            ru, rv = find(u), find(v)
            if ru == rv:
                return "INVALID cycle %s" % canon(sorted(chosen))
            parent[ru] = rv
        if components(nodes, edges) != components(nodes, chosen):
            return "INVALID not spanning %s" % canon(sorted(chosen))
        return "VALID %s weight=%d" % (type(result).__name__, sum(weight_by_edge[e] for e in chosen))
    return desc, (weight_by_edge,), check
def gen_shortest_path_length(rng, i):
    n, labels, edges, nodes = _digraph(rng, i, 0.15, 0.6)
    powers = [1 << k for k in range(len(edges))]
    rng.shuffle(powers)
    length_by_edge = {(nodes[u], nodes[v]): powers[k] for k, (u, v) in enumerate(edges)}
    start = rng.choice(labels)
    goal = start if rng.random() < 0.1 else rng.choice(labels)
    desc = "graph n=%d edges %s start %s goal %s" % (n, ",".join("%s->%s:%d" % (u.value, v.value, w) for (u, v), w in length_by_edge.items()) or "-", start, goal)
    return desc, (length_by_edge, nodes[start], nodes[goal]), canon
def _potential_weights(rng, labels, edges):
    pot = {lab: rng.randint(-8, 8) for lab in labels}
    return {(u, v): pot[v] - pot[u] + rng.randint(0, 6) for u, v in edges}
def gen_shortest_paths(rng, i):
    n = 1 if i == 0 else rng.randint(2, 7)
    labels = list(LABELS[:n])
    source = rng.choice(labels)
    edges = []
    for v in labels:
        if v != source:
            edges.append((rng.choice([u for u in labels if u != v]), v))
    p = rng.uniform(0.1, 0.5)
    for u in labels:
        for v in labels:
            if u != v and (u, v) not in edges and rng.random() < p:
                edges.append((u, v))
    rng.shuffle(edges)
    weight_by_edge = _potential_weights(rng, labels, edges)
    desc = "graph n=%d source %s edges %s" % (n, source, ",".join("%s->%s:%d" % (u, v, w) for (u, v), w in weight_by_edge.items()) or "-")
    return desc, (source, weight_by_edge), canon
def gen_shortest_path_lengths(rng, i):
    n = 1 if i == 0 else rng.randint(2, 7)
    labels = list(range(n))
    p = rng.uniform(0.15, 0.6)
    edges = [(u, v) for u in labels for v in labels if u != v and rng.random() < p]
    rng.shuffle(edges)
    length_by_edge = _potential_weights(rng, labels, edges)
    desc = "n=%d edges %s" % (n, ",".join("%d->%d:%d" % (u, v, w) for (u, v), w in length_by_edge.items()) or "-")
    return desc, (n, length_by_edge), canon
gen = globals().get("gen_" + name)
if gen is None:
    proto.write(json.dumps({"probe": "no_generator"}) + "\n")
    proto.flush()
    sys.exit(0)
rng = random.Random(seed)
outputs, descs = [], []
for i in range(count):
    desc, args, check = gen(rng, i)
    signal.setitimer(signal.ITIMER_REAL, timeout_s)
    try:
        result = fn(*args)
        if isinstance(result, types.GeneratorType):
            result = list(result)
        text = check(result)
    except _Timeout:
        text = "TIMEOUT"
    except BaseException as exc:
        text = "ERROR " + type(exc).__name__
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    outputs.append(text[:BOUND])
    descs.append(desc[:200])
proto.write(json.dumps({"probe": "ok", "outputs": outputs, "descs": descs}) + "\n")
proto.flush()
`.trim();

interface GraphProbeResult {
  outputs: string[];
  descs: string[];
}

function graphProbeCommand(name: string, candidatePath: string, seed: number, count: number): string {
  const args = [name, candidatePath, String(GRAPH_PER_INPUT_TIMEOUT_MS / 1000), String(seed), String(count), join(QB, 'programs')];
  return `PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 python3 - ${args.map(shellQuote).join(' ')} <<'${GRAPH_PROBE_HEREDOC}'\n${GRAPH_PROBE_SCRIPT}\n${GRAPH_PROBE_HEREDOC}`;
}

async function graphProbe(name: string, candidatePath: string, seed: number, count: number): Promise<GraphProbeResult | { error: string }> {
  try {
    const { stdout } = await exec('sh', ['-c', graphProbeCommand(name, candidatePath, seed, count)], { timeout: probeTimeoutMs(count, GRAPH_PER_INPUT_TIMEOUT_MS), maxBuffer: 16 * 1024 * 1024 });
    const line = stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
    if (line === undefined) return { error: 'no protocol line' };
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o['probe'] === 'import_error') return { error: `import_error:${String(o['error'])}` };
    if (o['probe'] !== 'ok') return { error: String(o['probe']) };
    const outputs = o['outputs'];
    const descs = o['descs'];
    if (!Array.isArray(outputs) || !Array.isArray(descs)) return { error: 'malformed protocol line' };
    return { outputs: outputs.map(String), descs: descs.map(String) };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  }
}

/** repr() of an object without __repr__ carries its address, so two processes can never agree on it. */
function addressBound(s: string): boolean {
  return / object at 0x[0-9a-f]+>/.test(s);
}

function inputText(p: PerturbedInput): string {
  return p.exprs !== undefined ? p.exprs.join(', ').replace(/__jev_chain\(__jev_class\([^)]*\), "[^"]*", (\d+), (None|\d+)\)/, (_m, n: string, c: string) => `${c === 'None' ? 'acyclic' : 'cyclic'} chain of ${n}`) : JSON.stringify(p.input);
}

function cut(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function judge(rec: TaskRecord, benchId: string | null, scratch: string, opts: { graphN: number; seed: number }): Promise<Row> {
  const name = rec.task;
  const reference = join(QB, 'correct', `${name}.py`);
  const patched = await patchedProgram(rec, benchId, scratch);
  const solved = rec.pass === true;
  if (!solved) {
    const what = patched.patchBytes === 0 ? 'no patch committed' : `a ${patched.patchBytes}-byte patch was committed and still fails`;
    return { program: name, solved, verdict: 'miss', evidence: `${what}; ${rec.stopReason ?? '?'} after ${rec.steps ?? '?'} steps${rec.reason ? `; ${cut(rec.reason, 90)}` : ''}` };
  }
  const ident = await tokenIdentical(patched.path, reference);
  if (ident.same) return { program: name, solved, verdict: 'gold-identical', evidence: `token-identical to correct/${name}.py (from ${patched.source})` };

  const [refCases, patCases] = await Promise.all([referenceCases(name, reference), referenceCases(name, patched.path)]);
  const cases = refCases !== null && patCases !== null ? `reference cases: patched ${patCases.passed}/${patCases.total}, reference ${refCases.passed}/${refCases.total}` : 'reference cases: run_tests.py gave no report';
  const head = `differs (${ident.detail}); ${cases}`;
  const matched: string[] = [];
  const diffs: string[] = [];
  const problems: string[] = [];

  // (a) the guard's perturbed inputs
  const { inputs, basis } = perturbedInputsOf(name);
  if (inputs.length > 0) {
    const [outPatched, outRef] = await Promise.all([probeOutputs(name, patched.path, inputs), probeOutputs(name, reference, inputs)]);
    if (outPatched === null || outRef === null) problems.push(`behaviour probe produced no result on ${inputs.length} perturbed inputs from ${basis}`);
    else {
      let compared = 0;
      const local: string[] = [];
      for (let i = 0; i < inputs.length; i++) {
        const p = outPatched[i] ?? '<none>';
        const r = outRef[i] ?? '<none>';
        if (addressBound(p) || addressBound(r)) continue; // repr(Node) differs per process
        compared++;
        if (p !== r) local.push(`${inputText(inputs[i]!)} → patched ${cut(p, 40)} vs reference ${cut(r, 40)}`);
      }
      const kinds = [...new Set(inputs.map((p) => p.how))].join(', ');
      if (compared === 0) problems.push(`${inputs.length} perturbed inputs from ${basis} return objects whose repr() is address-bound`);
      else if (local.length === 0) matched.push(`${compared} perturbed inputs (${kinds}) from ${basis}`);
      else diffs.push(`${local.length}/${compared} perturbed inputs from ${basis} differ, e.g. ${local[0]}`);
    }
  }

  // (b) the random-structure differential for the pytest-module programs
  const family = GRAPH_FAMILIES[name];
  if (family !== undefined) {
    const [gPatched, gRef] = await Promise.all([graphProbe(name, patched.path, opts.seed, opts.graphN), graphProbe(name, reference, opts.seed, opts.graphN)]);
    if ('error' in gRef) problems.push(`graph probe of the reference failed (${gRef.error})`);
    else if ('error' in gPatched) diffs.push(`graph probe of the patched program failed (${gPatched.error}) where the reference ran ${gRef.outputs.length} ${family}`);
    else {
      const local: string[] = [];
      for (let i = 0; i < gRef.outputs.length; i++) if (gPatched.outputs[i] !== gRef.outputs[i]) local.push(`${gRef.descs[i]} → patched ${cut(gPatched.outputs[i] ?? '<none>', 60)} vs reference ${cut(gRef.outputs[i] ?? '<none>', 40)}`);
      const what = `${gRef.outputs.length} ${family}, seed ${opts.seed}`;
      if (local.length === 0) matched.push(what);
      else diffs.push(`${local.length}/${gRef.outputs.length} of ${what} differ, e.g. ${local[0]}${local.length > 1 ? `; also ${local[1]}` : ''}`);
    }
  } else if (inputs.length === 0) problems.push(basis);

  if (diffs.length > 0) return { program: name, solved, verdict: 'overfit', evidence: `${head}; ${diffs.join('; ')}${matched.length > 0 ? `; identical on ${matched.join(' and ')}` : ''}` };
  if (matched.length > 0) return { program: name, solved, verdict: 'equivalent', evidence: `${head}; identical outputs on ${matched.join(' and on ')}${problems.length > 0 ? `; ${problems.join('; ')}` : ''}` };
  return { program: name, solved, verdict: 'unverified', evidence: `${head}; ${problems.join('; ') || 'nothing could be compared'}` };
}

function table(rows: readonly Row[]): string {
  const lines = ['| program | solved | verdict | evidence |', '| --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.program} | ${r.solved ? 'yes' : 'no'} | ${r.verdict} | ${r.evidence.replace(/\|/g, '\\|')} |`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { resultsDir, out, graphN, seed } = argv();
  const records = readRecords(resultsDir);
  const benchId = benchIdOf(resultsDir);
  const scratch = mkdtempSync(join(tmpdir(), 'quixbugs-verdicts-'));
  const rows: Row[] = [];
  try {
    for (const rec of records) {
      const row = await judge(rec, benchId, scratch, { graphN, seed });
      rows.push(row);
      console.log(`${row.program.padEnd(28)} ${row.solved ? 'solved' : 'miss  '} ${row.verdict.padEnd(15)} ${cut(row.evidence, 110)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const count = (v: Verdict): number => rows.filter((r) => r.verdict === v).length;
  const solved = rows.filter((r) => r.solved).length;
  const totals = { solved, goldIdentical: count('gold-identical'), equivalent: count('equivalent'), overfit: count('overfit'), unverified: count('unverified'), miss: count('miss') };
  const verified = totals.goldIdentical + totals.equivalent;
  const summary = [
    `Totals: solved ${solved}/${rows.length}; gold-identical ${totals.goldIdentical}, equivalent ${totals.equivalent}, overfit ${totals.overfit}, unverified ${totals.unverified}, miss ${totals.miss}.`,
    `Correct by this script: ${verified}/${rows.length} (gold-identical + equivalent); ${totals.unverified} more pass the reference cases but differ from the reference where nothing could be compared; ${totals.overfit} overfit the reference cases.`,
  ];
  const md = `# Per-program verdicts: ${resultsDir.replace(`${ROOT}/`, '')}

Generated by \`experiments/inspect/quixbugs-verdicts.mts\` (code only, no Jev). Bench id ${benchId ?? 'unknown'}; the committed program is the
run's bench workspace file (\`~/.jevcode/runs/bench-work/<benchId>/<task>/jev-only/workspace/<task>.py\`), else
\`model_patch.diff\` applied to \`bench/data/quixbugs/programs/<task>.py\`. "solved" is the bench evaluator's verdict on the
reference cases (\`bench/data/quixbugs/tests\`, the same cases the workspace exposes; there is no hidden suite).

Verdicts: \`gold-identical\` = token-identical to \`bench/data/quixbugs/correct/<task>.py\` (comments, blank lines and whitespace
width ignored); otherwise both programs ran on the reference cases, on the perturbed inputs \`src/synth/search/perturb.ts\`
derives from the visible tests (the guard's behaviour probe) and — for the nine programs whose tests are pytest modules
building Node/graph fixtures — on ${graphN} random structures per program from seed ${seed} (DAGs judged by a validity
oracle so any correct topological order counts, digraphs with a start and goal, linked lists with random cycles, weighted
graphs judged as minimum spanning forests, digraphs with distinct power-of-two lengths, digraphs with negative weights and no
negative cycle): \`equivalent\` = every compared output matches, \`overfit\` = at least one differs, \`unverified\` = nothing
could be compared or a probe gave no result; \`miss\` = not solved.

${table(rows)}

${summary.join('\n')}
`;
  writeFileSync(out, md);
  console.log('');
  for (const s of summary) console.log(s);
  console.log(`written ${out}`);
}

await main();
