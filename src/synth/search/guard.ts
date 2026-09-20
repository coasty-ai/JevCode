/**
 * The overfit guard and the decision on a run batch (docs/JEV-ONLY-DESIGN.md §2.6; wordings §2.7
 * Q15/Q16, measured in experiments/contrarian/arbitrate.mts → contrarian-arbitrate.{truth,all}.jsonl).
 *
 * Code first, Jev only where tests cannot decide:
 *   0 plausible → hold the best partial (bases.ts) and keep searching;
 *   1 plausible → commit; tests are the oracle and no Noul threshold withholds a lone passer
 *                 (`quicksort` gold Noul 0.15);
 *   ≥ 2        → cluster by behaviour on code-generated perturbed inputs (pytest: the P2P outcome
 *                 vector), then ONE request: Q15 `genuine_fix` Choice over ≤ 20 representatives +
 *                 Q16 `general_<xx>` Nouls; the measured all-overfit signature
 *                 (P(escape) ≥ 0.9 ∧ max Noul < 0.1: `depth_first_search` 0.90 / 0.06) flags a
 *                 `suspect` and continues; otherwise the Choice argmax is committed, with the
 *                 Choice/Noul override rule of DESIGN §5.4 and the other representatives as fallbacks.
 *
 * The guard never overrides the tests: a candidate failing a goal test is never proposed, a passing
 * one is proposed at step end even when flagged (`openProblems: possible overfit`).
 */
import type { Json, StageName, SynthesisContext } from '../../core/types.js';
import { isJsonArray, isJsonObject, isString, parseJson } from '../../core/json.js';
import { choice, ESCAPE_KEY, noul } from '../../jev/questions.js';
import type { NoulCriteriaSpec } from '../../jev/questions.js';
import { codeLines, moduleCodeLines } from '../localize/index.js';
import { codeTokens, levenshtein, tokenizeFragment } from '../py/index.js';
import type { Candidate, FailureView, JevAsk, SourceFile } from '../types.js';
import { RUN_FAILURE_ID, shellQuote } from '../verify/text.js';
import { appliedOnCommitted, guardState, holdBestPartial, isPartial, outcomeSummary } from './bases.js';
import type { GuardMemory, HoldOptions } from './bases.js';
import type { Arbitration, BehaviourCluster, Decision, Goal, OracleModel, VerifyOutcome } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement behind it)
// ---------------------------------------------------------------------------------------

/**
 * The all-overfit signature (§2.6): the one set where every passer overfits (`depth_first_search`,
 * 7 candidates, contrarian-arbitrate.all.jsonl) answered P(escape) 0.90 with max Noul 0.06, while
 * every set containing the gold had P(escape) ≤ 0.38 and a Noul ≥ 0.45. Both bounds sit far from
 * the observed values on either side; 0.5 would be a coin flip on neither.
 */
export const SUSPECT_ESCAPE_MIN = 0.9;
export const SUSPECT_NOUL_MAX = 0.1;
/**
 * DESIGN §5.4 Choice/Noul resolution rule: the Choice argmax is overridden only when its own Noul
 * is confidently false (< 0.3) and another representative's is confidently true (≥ 0.7). Gold
 * Nouls ranged 0.15–0.96 (below 0.7 on 4/10, below 0.3 on 1/10), so the Noul stays advisory.
 */
export const OVERRIDE_LOW = 0.3;
export const OVERRIDE_HIGH = 0.7;
/** Q15 offered ≤ 20 representatives (contrarian §3.4; the measured sets had 2–7). */
export const MAX_REPRESENTATIVES = 20;
/** One cluster of ≥ 2 passers is still arbitrated (judge 2), over its ≤ 5 smallest-edit members. */
export const SINGLE_CLUSTER_MAX_MEMBERS = 5;
/** The measured state listed the first 4 tests. */
export const TESTS_IN_STATE = 4;
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
/** Program lines shown to Jev in the Q15 state (Q5's Choice window; measured programs were ≤ 20 lines). */
export const PROGRAM_LINES_MAX = 254;

export class GuardError extends Error {
  constructor(message: string) {
    super(`GuardError: ${message}`);
    this.name = 'GuardError';
  }
}

// ---------------------------------------------------------------------------------------
// Perturbed inputs (code) for the QuixBugs runner
// ---------------------------------------------------------------------------------------

export type PerturbationKind = 'int_plus_one' | 'int_minus_one' | 'list_drop_first' | 'list_drop_last' | 'list_dup_first' | 'list_dup_last' | 'list_empty' | 'list_singleton' | 'swap_same_type_args';

export interface PerturbedInput {
  /** positional arguments for `fn(*input)` */
  input: Json[];
  /** test id the input was derived from */
  derivedFrom: string;
  how: PerturbationKind;
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

function perturbationsOf(args: readonly Json[]): { input: Json[]; how: PerturbationKind }[] {
  const out: { input: Json[]; how: PerturbationKind }[] = [];
  const withArg = (i: number, v: Json): Json[] => args.map((a, k) => (k === i ? v : a));
  args.forEach((a, i) => {
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
    }
  });
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

/**
 * Extra inputs derived from the goal's failing tests (§2.6): ±1 on integer arguments, drop or
 * duplicate a list element, the empty and singleton list, swapping two same-typed arguments.
 * Deduplicated against each other and the originals, bounded by MAX_PERTURBED_INPUTS, round-robin
 * over the tests so no single test dominates. Empty for pytest and unknown runners (there the
 * P2P outcome vector is the signature).
 */
export function perturbedInputs(goal: Goal, oracle: OracleModel, max = MAX_PERTURBED_INPUTS): PerturbedInput[] {
  if (oracle.runner !== 'quixbugs') return [];
  const originals = new Set<string>();
  const perTest: PerturbedInput[][] = [];
  for (const f of goal.failures) {
    const parsed = parseQuixbugsCall(f.call);
    if (parsed === null) continue;
    originals.add(JSON.stringify(parsed.args));
    perTest.push(perturbationsOf(parsed.args).map((p) => ({ input: p.input, derivedFrom: f.testId, how: p.how })));
  }
  const seen = new Set<string>(originals);
  const out: PerturbedInput[] = [];
  for (let round = 0; out.length < max; round++) {
    let any = false;
    for (const list of perTest) {
      const p = list[round];
      if (p === undefined) continue;
      any = true;
      const key = JSON.stringify(p.input);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= max) break;
    }
    if (!any) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The behaviour probe: one stdlib python3 process per candidate, all inputs, per-input timeout
// ---------------------------------------------------------------------------------------

const PROBE_HEREDOC = 'JEVCODE_BEHAVIOUR_PROBE';

/**
 * The probe script mirrors run_tests.py's child: import the candidate under the program's name,
 * call `fn(*deepcopy(input))`, materialise generators, and record repr(result) or the exception
 * class, each under a SIGALRM timer so one looping perturbation does not hide the others. The
 * candidate's own prints go to stderr so they cannot corrupt the one protocol line.
 */
const PROBE_SCRIPT = String.raw`
import copy, importlib.util, json, os, signal, sys, types
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
outputs = []
for inp in inputs:
    signal.setitimer(signal.ITIMER_REAL, timeout_s)
    try:
        result = fn(*copy.deepcopy(inp))
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

/**
 * The `sh -c` command that prints one JSON line `{"probe":"ok","outputs":[...]}`. PYTHONHASHSEED=0
 * makes repr() of sets and dicts of strings stable across candidates, so equal behaviour gives
 * equal text; PYTHONDONTWRITEBYTECODE avoids the stale-`.pyc` pitfall of probe-question-design.md §8.
 */
export function behaviourProbeCommand(o: ProbeCommandOptions): string {
  const args = [o.name, o.candidatePath, String(o.perInputTimeoutMs / 1000), JSON.stringify(o.inputs.map((i) => i.input)), ...(o.pythonPath ?? [])];
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

/** The pytest signature: which tests pass in the widest run available (the P2P outcome vector). */
export function p2pVector(o: VerifyOutcome): string {
  const s = outcomeSummary(o);
  const failing = [...s.failing].sort();
  return `p2p:${s.passed}/${s.total};failing=${failing.join(',')}`;
}

/** Combine the P2P vector with a probe result (identical behaviour ⇔ identical string). */
export function behaviourSignature(o: VerifyOutcome, probe: string | null): string {
  return probe === null ? p2pVector(o) : `${p2pVector(o)}|${probe}`;
}

/** Runs the probe for each plausible candidate; the sieve's lanes own the execution. */
export type BehaviourProbe = (plausible: readonly VerifyOutcome[], inputs: readonly PerturbedInput[]) => Promise<ReadonlyMap<string, string>>;

// ---------------------------------------------------------------------------------------
// Behaviour clustering (code)
// ---------------------------------------------------------------------------------------

function tokensOf(text: string): string[] {
  return codeTokens(tokenizeFragment(text)).map((t) => t.text);
}

/**
 * Token edit distance between the site's current line and the candidate (plus the tokens of any
 * extra edits): the code-only notion of "minimal edit" the contrarian baseline measured (3/10 on
 * its own, so it only picks representatives and breaks ties here, never the fix).
 */
export function editCost(c: Candidate): number {
  const base = c.site.kind === 'replace' ? tokensOf(c.site.currentLine) : [];
  let cost = levenshtein(base, tokensOf(c.text));
  for (const e of c.extraEdits ?? []) cost += e.kind === 'delete' ? 1 : tokensOf(e.text ?? '').length;
  return cost;
}

function byEditCost(a: VerifyOutcome, b: VerifyOutcome): number {
  return editCost(a.applied.candidate) - editCost(b.applied.candidate) || a.applied.candidate.text.length - b.applied.candidate.text.length || a.applied.candidate.id.localeCompare(b.applied.candidate.id);
}

/** The smallest-edit member of a set (the `suspect` when every passer looks like an overfit). */
export function minEdit(outcomes: readonly VerifyOutcome[]): VerifyOutcome {
  const sorted = [...outcomes].sort(byEditCost);
  const first = sorted[0];
  if (first === undefined) throw new GuardError('minEdit of an empty set');
  return first;
}

/**
 * Group plausible candidates whose behaviour is identical: the P2P outcome vector always, joined
 * with the probe signature when `signatures` (keyed by candidate id) has one, so two candidates
 * that agree on every perturbed input but not on the suite never share a cluster. Members are
 * ordered by edit cost and the representative is the smallest edit; clusters are ordered by size,
 * then representative cost.
 */
export function clusterByBehaviour(outcomes: readonly VerifyOutcome[], signatures: ReadonlyMap<string, string> = new Map()): BehaviourCluster[] {
  const groups = new Map<string, VerifyOutcome[]>();
  for (const o of outcomes) {
    const sig = behaviourSignature(o, signatures.get(o.applied.candidate.id) ?? null);
    const list = groups.get(sig) ?? [];
    list.push(o);
    groups.set(sig, list);
  }
  const clusters = [...groups.entries()].map(([signature, members]) => {
    const sorted = [...members].sort(byEditCost);
    const representative = sorted[0];
    if (representative === undefined) throw new GuardError('empty behaviour cluster');
    return { id: '', members: sorted, representative, signature };
  });
  clusters.sort((a, b) => b.members.length - a.members.length || byEditCost(a.representative, b.representative));
  return clusters.map((c, i) => ({ ...c, id: `cluster_${i + 1}` }));
}

// ---------------------------------------------------------------------------------------
// Q15 + Q16: one request
// ---------------------------------------------------------------------------------------

/** Measured task text (arbitrate.mts, the `--include-nogold` variant: nothing here knows a gold exists). */
export const ARBITRATE_TASK =
  'The Python function in `program` had a bug. Every entry of `candidates` is a replacement for the line named in its `line` field that makes ALL of the program\'s tests pass. At most one of them is the genuine fix that is correct for every valid input; the others only satisfy the tests. It is possible that none is a genuine fix (for example when the real fix needs a new statement rather than a changed line).';
/** Q15, measured verbatim. */
export const GENUINE_FIX_INSTRUCTIONS =
  'Every option makes all tests pass. Which option is the genuine fix of the defect: the replacement that makes `program` correct for every valid input, not only for `tests`? Read each option literally. Answer carefully and literally.';
export const GENUINE_FIX_ID = 'genuine_fix';
export const GENERAL_PREFIX = 'general_';

/** Q16 criteria, measured verbatim. */
export const GENERAL_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'The replacement repairs the actual defect; the algorithm is now correct in general and the change is the minimal one a maintainer would write.',
    examples: ['an off-by-one bound corrected so every element is visited', 'swapped arguments restored to the order the algorithm requires', 'a missing guard added exactly where the failing input reaches'],
  },
  false: {
    definition: 'The replacement makes the listed tests pass by coincidence: it special-cases the tested inputs, changes an unrelated part of the line, removes functionality the tests do not exercise, or is a boundary the tests cannot distinguish.',
    examples: ['a condition that happens to hold for the tested inputs only', 'deleting a branch no test reaches', 'returning a constant that matches the tested cases'],
  },
};

export function generalInstructions(key: string): string {
  return `Is \`candidates.${key}\` a correct general fix: with this replacement, does \`program\` compute the right result for every valid input, not just for the listed \`tests\`?`;
}

export interface ArbitrateContext {
  goal: Goal;
  /** default 'propose' so the rows land in decisions.jsonl with the synthesizer's other questions */
  stage?: StageName;
}

export interface Representative {
  key: string;
  outcome: VerifyOutcome;
  cluster: BehaviourCluster;
}

export interface ArbitrationResult extends Arbitration {
  representatives: Representative[];
  state: Json;
}

/**
 * Who gets asked about (§2.6): one representative per cluster (smallest edit) when clusters
 * disagree, ≤ MAX_REPRESENTATIVES; when there is a single cluster of ≥ 2 passers its
 * ≤ SINGLE_CLUSTER_MAX_MEMBERS smallest-edit members, so an all-overfit set is still caught.
 */
export function representativesOf(clusters: readonly BehaviourCluster[]): Representative[] {
  const picked: { outcome: VerifyOutcome; cluster: BehaviourCluster }[] = [];
  if (clusters.length === 1) {
    const only = clusters[0];
    if (only !== undefined) for (const m of only.members.slice(0, SINGLE_CLUSTER_MAX_MEMBERS)) picked.push({ outcome: m, cluster: only });
  } else {
    for (const c of clusters.slice(0, MAX_REPRESENTATIVES)) picked.push({ outcome: c.representative, cluster: c });
  }
  return picked.map((p, i) => ({ key: `cand_${String(i + 1).padStart(2, '0')}`, ...p }));
}

function lineKeyOf(line: number): string {
  return `L${line}`;
}

/** The outermost def/class containing `line` (a nested function's fix is judged with its enclosing function, as the measured state showed the whole program). */
function outermostBlock(file: SourceFile, line: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const b of file.mod.blocks) {
    if (b.startLine > line || line > b.endLine) continue;
    if (best === null || b.startLine < best.start || (b.startLine === best.start && b.endLine > best.end)) best = { start: b.startLine, end: b.endLine };
  }
  return best;
}

/**
 * `program` for the Q15 state: every code line of the file when it fits PROGRAM_LINES_MAX (the
 * measured shape: the whole QuixBugs program), otherwise the outermost functions enclosing the
 * edited lines (module-level code when an edit sits outside every def), cut at the cap.
 */
function listing(file: SourceFile, siteLines: readonly number[]): { [k: string]: Json } {
  const seen = new Set<number>();
  const out: { [k: string]: Json } = {};
  let lines = codeLines(file.mod, 1, file.mod.lines.length);
  if (lines.length > PROGRAM_LINES_MAX) {
    const ranges = siteLines.map((l) => outermostBlock(file, l)).filter((r): r is { start: number; end: number } => r !== null);
    lines = ranges.length === 0 ? moduleCodeLines(file.mod) : ranges.flatMap((r) => codeLines(file.mod, r.start, r.end));
  }
  for (const l of lines.sort((a, b) => a.line - b.line)) {
    if (seen.has(l.line) || seen.size >= PROGRAM_LINES_MAX) continue;
    seen.add(l.line);
    out[lineKeyOf(l.line)] = l.text;
  }
  return out;
}

function testsJson(failures: readonly FailureView[]): Json[] {
  return failures.slice(0, TESTS_IN_STATE).map((f) => ({ input: f.call, expected: f.expected }));
}

function candidateJson(c: Candidate, primaryPath: string): Json {
  const entry: { [k: string]: Json } = { line: lineKeyOf(c.site.line), replaces: c.site.kind === 'replace' ? c.site.currentLine.trim() : null, with: c.text.trim() };
  if (c.site.kind === 'insert') entry['position'] = `inserted before ${lineKeyOf(c.site.line)}`;
  if (c.site.file.path !== primaryPath) entry['file'] = c.site.file.path;
  if (c.extraEdits !== undefined && c.extraEdits.length > 0) entry['also_edits'] = c.extraEdits.map((e) => ({ line: lineKeyOf(e.line), kind: e.kind, text: (e.text ?? '').trim() }));
  return entry;
}

function optionDescription(c: Candidate): string {
  return c.site.kind === 'replace' ? `${lineKeyOf(c.site.line)}: ${c.text.trim()}` : `insert before ${lineKeyOf(c.site.line)}: ${c.text.trim()}`;
}

/** The measured state: `{ task, program, tests, buggy_program_failure, candidates }`. */
export function arbitrateState(ctx: ArbitrateContext, reps: readonly Representative[]): Json {
  const files = new Map<string, { file: SourceFile; lines: number[]; n: number }>();
  for (const r of reps) {
    const site = r.outcome.applied.candidate.site;
    const entry = files.get(site.file.path) ?? { file: site.file, lines: [], n: 0 };
    entry.n++;
    entry.lines.push(site.line);
    files.set(site.file.path, entry);
  }
  // The program listing is the file most representatives edit; other files are listed beside it.
  const ordered = [...files.values()].sort((a, b) => b.n - a.n || a.file.path.localeCompare(b.file.path));
  const primary = ordered[0];
  if (primary === undefined) throw new GuardError('arbitrateState needs at least one representative');
  const state: { [k: string]: Json } = {
    task: ARBITRATE_TASK,
    program: listing(primary.file, primary.lines),
    tests: testsJson(ctx.goal.failures),
    buggy_program_failure: null,
  };
  const first = ctx.goal.failures[0];
  if (first !== undefined) state['buggy_program_failure'] = { input: first.call, expected: first.expected, actual: first.actual };
  if (ordered.length > 1) {
    const others: { [k: string]: Json } = {};
    for (const o of ordered.slice(1)) others[o.file.path] = listing(o.file, o.lines);
    state['other_files'] = others;
  }
  const candidates: { [k: string]: Json } = {};
  for (const r of reps) candidates[r.key] = candidateJson(r.outcome.applied.candidate, primary.file.path);
  state['candidates'] = candidates;
  return state;
}

/**
 * Q15 + Q16 in one request over the representatives of `clusters`. Returns the Choice argmax as
 * `pick` after the §5.4 override rule, the suspect flag, and the other representatives as
 * fallbacks ordered by Choice probability. Throws GuardError when Jev's answer shape is wrong.
 */
export async function arbitrate(ctx: ArbitrateContext, clusters: readonly BehaviourCluster[], ask: JevAsk): Promise<ArbitrationResult> {
  const reps = representativesOf(clusters);
  if (reps.length < 2) throw new GuardError(`arbitrate needs at least two representatives, got ${reps.length}`);
  const state = arbitrateState(ctx, reps);
  const options: Record<string, Json | null> = {};
  for (const r of reps) options[r.key] = optionDescription(r.outcome.applied.candidate);
  const questions = { [GENUINE_FIX_ID]: choice(GENUINE_FIX_INSTRUCTIONS, options) };
  const withNouls: Record<string, ReturnType<typeof noul>> = { ...questions };
  for (const r of reps) withNouls[`${GENERAL_PREFIX}${r.key}`] = noul(generalInstructions(r.key), GENERAL_CRITERIA);

  const res = await ask(ctx.stage ?? 'propose', state, withNouls);
  const answer = res.answers[GENUINE_FIX_ID];
  if (answer === undefined || answer.type !== 'choice') throw new GuardError(`${GENUINE_FIX_ID} answer missing or not a choice`);
  const pChoice: Record<string, number> = {};
  const nouls: Record<string, number> = {};
  for (const r of reps) {
    pChoice[r.key] = answer.probabilities[r.key] ?? 0;
    const n = res.answers[`${GENERAL_PREFIX}${r.key}`];
    nouls[r.key] = n !== undefined && n.type === 'noul' ? n.noul : 0;
  }
  const pEscape = answer.probabilities[ESCAPE_KEY] ?? 0;
  const maxNoul = Math.max(...reps.map((r) => nouls[r.key] ?? 0));
  const suspect = pEscape >= SUSPECT_ESCAPE_MIN && maxNoul < SUSPECT_NOUL_MAX;

  // Choice argmax (ties → smaller edit), then the override rule.
  const byChoice = [...reps].sort((a, b) => (pChoice[b.key] ?? 0) - (pChoice[a.key] ?? 0) || byEditCost(a.outcome, b.outcome));
  let pick = byChoice[0];
  if (pick === undefined) throw new GuardError('no representative to pick');
  if ((nouls[pick.key] ?? 0) < OVERRIDE_LOW) {
    const confident = reps.filter((r) => (nouls[r.key] ?? 0) >= OVERRIDE_HIGH).sort((a, b) => (nouls[b.key] ?? 0) - (nouls[a.key] ?? 0) || byEditCost(a.outcome, b.outcome));
    const c = confident[0];
    if (c !== undefined) pick = c;
  }
  const chosen = pick;
  const fallbacks = byChoice.filter((r) => r.key !== chosen.key).map((r) => r.outcome);
  return { pick: chosen.outcome, fallbacks, pChoice, pEscape, noul: nouls, suspect, requests: 1, representatives: reps, state };
}

// ---------------------------------------------------------------------------------------
// decide (§2.6 pseudo-code)
// ---------------------------------------------------------------------------------------

export type GuardDecision = Decision & {
  plausible: number;
  clusters: number;
  arbitrated: boolean;
  requests: number;
  /** other arbitrated representatives, for later steps if the judge rejects the pick */
  fallbacks: VerifyOutcome[];
  /** the behaviour probe failed and clustering fell back to the P2P vectors (message), else null */
  probeError: string | null;
};

export interface DecideOptions extends HoldOptions {
  /** for `perturbedInputs`; absent → P2P vectors only */
  oracle?: OracleModel;
  /** runs the behaviour probe on the lanes; absent → P2P vectors only */
  probe?: BehaviourProbe;
}

/**
 * Plausible in the design's sense (§2.6): every test of the GOAL passes in the goal-subset run and
 * in the full-suite regression run, which exists, finished, and shows nothing newly failing. The
 * check is goal-relative on purpose: on a multi-goal task (ladder, 2–3 independent hunks) the
 * other goals' tests still fail after a genuine fix of this one, and the ledger commits one
 * verified sub-goal per step. The runner's status is trusted but re-checked, so a passer whose
 * regression run was skipped is never committed as plausible.
 */
export function isPlausible(o: VerifyOutcome, goal: Pick<Goal, 'tests'>): boolean {
  if (o.status !== 'plausible') return false;
  if (o.full === undefined || o.full.timedOut || o.subset.timedOut || o.progress.regressed) return false;
  for (const run of [o.subset, o.full]) {
    if (run.total === 0) return false;
    // nothing passed, or an error the base did not have (a collection error names the module in
    // `failing`, never a goal test): the goal's tests did not run, let alone pass
    if (run.passed === 0 || run.errors > o.progress.before.errors) return false;
    const failing = new Set(run.failing);
    if (failing.has(RUN_FAILURE_ID) || goal.tests.some((t) => failing.has(t))) return false;
    // with passing ids (pytest -rA) a goal test that vanished from the run is not a pass
    if (run.passing.length > 0) {
      const passing = new Set(run.passing);
      if (goal.tests.some((t) => !passing.has(t))) return false;
    }
  }
  return true;
}

/**
 * Tests are the oracle before Jev is: among plausible candidates, only those whose full-suite run
 * passes the most tests stay in contention. A goal is one failing-test cluster, and on pytest
 * workspaces the clusters are one test each (tracebacks show only test frames, goals.ts), so a
 * candidate that special-cases the attacked test is "plausible" for it while the genuine fix also
 * turns its sibling tests green (the ladder's two tests per hunk, bench/data/ladder/README.md);
 * the sibling count separates them at no Jev cost. Ties (the common case) go on to clustering
 * and Q15/Q16 as before.
 */
export function mostPassing(plausible: readonly VerifyOutcome[]): VerifyOutcome[] {
  let best = -1;
  for (const o of plausible) best = Math.max(best, o.full?.passed ?? o.subset.passed);
  return plausible.filter((o) => (o.full?.passed ?? o.subset.passed) === best);
}

/** A commit is always a patch of the committed workspace, whichever base the candidate ran on. */
function commit(mem: GuardMemory, o: VerifyOutcome, extra: Omit<GuardDecision, 'kind' | 'applied' | 'allGoalTestsPass'>): GuardDecision {
  return { kind: 'commit', applied: appliedOnCommitted(mem, o), allGoalTestsPass: true, outcome: o, ...extra };
}

/**
 * The decision on one run batch. Nothing here writes to the workspace: regressed, unchanged and
 * timed-out candidates are simply dropped (they are already in `tried`).
 */
export async function decide(results: readonly VerifyOutcome[], mem: GuardMemory, goal: Goal, ask: JevAsk, opts: DecideOptions = {}): Promise<GuardDecision> {
  const plausible = mostPassing(results.filter((o) => isPlausible(o, goal)));
  const partial = results.filter((o) => !isPlausible(o, goal) && isPartial(o));

  if (plausible.length === 0) {
    const holdOpts: HoldOptions = { ask, stage: opts.stage ?? 'propose' };
    if (opts.subject !== undefined) holdOpts.subject = opts.subject;
    const held = await holdBestPartial(mem, partial, goal, holdOpts);
    return { kind: 'continue', plausible: 0, clusters: 0, arbitrated: false, requests: held.requests, fallbacks: [], probeError: null };
  }
  const only = plausible[0];
  if (plausible.length === 1 && only !== undefined) {
    // Tests are the oracle: a lone passer is committed without any Jev gate.
    return commit(mem, only, { plausible: 1, clusters: 1, arbitrated: false, requests: 0, fallbacks: [], probeError: null });
  }

  // The probe is best effort: a lane or interpreter failure must not abort a step that has
  // test-passing candidates, so it degrades to the P2P vectors (the design's pytest behaviour).
  let signatures: ReadonlyMap<string, string> = new Map();
  let probeError: string | null = null;
  if (opts.probe !== undefined && opts.oracle !== undefined) {
    const inputs = perturbedInputs(goal, opts.oracle);
    if (inputs.length > 0) {
      try {
        signatures = await opts.probe(plausible, inputs);
      } catch (e) {
        probeError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  const clusters = clusterByBehaviour(plausible, signatures);
  const arbCtx: ArbitrateContext = { goal };
  if (opts.stage !== undefined) arbCtx.stage = opts.stage;
  const arb = await arbitrate(arbCtx, clusters, ask);
  const common = { plausible: plausible.length, clusters: clusters.length, arbitrated: true, requests: arb.requests, probeError };

  if (arb.suspect) {
    // Every passer looks like an overfit: remember the smallest edit and keep searching (gap
    // sites next); it is committed at step end with `possible overfit` if nothing better appears.
    const st = guardState(mem);
    const candidate = minEdit(plausible);
    if (st.suspect === null || st.suspect.goalId !== goal.id || byEditCost(candidate, st.suspect.outcome) < 0) st.suspect = { goalId: goal.id, outcome: candidate };
    return { kind: 'continue', ...common, fallbacks: [] };
  }
  guardState(mem).fallbacks = { goalId: goal.id, outcomes: arb.fallbacks };
  return commit(mem, arb.pick, { ...common, fallbacks: arb.fallbacks });
}

/**
 * Step-end rule (§2.3): a flagged passer of `goal` is still proposed, marked, because the guard
 * never overrides the tests. Clears the suspect so the next step starts clean; another goal's
 * suspect is left alone (and null is returned). Without `goal` any remembered suspect is
 * committed (callers that search one goal per step should pass it so a parked goal's flagged
 * passer never surfaces under a later goal).
 */
export function commitSuspect(mem: GuardMemory, goal?: Pick<Goal, 'id'>): Decision | null {
  const st = guardState(mem);
  const s = st.suspect;
  if (s === null || (goal !== undefined && s.goalId !== goal.id)) return null;
  st.suspect = null;
  return { kind: 'commit', applied: appliedOnCommitted(mem, s.outcome), allGoalTestsPass: true, note: 'possible overfit', outcome: s.outcome };
}

// ---------------------------------------------------------------------------------------
// Adapter for the sub-goal controller (search/subgoal.ts SubGoalDeps.guard)
// ---------------------------------------------------------------------------------------

/** What the adapter reads from the run's SearchMemory (memory.ts); `oracle` selects the runner for perturbed inputs. */
export interface SearchMemoryLike extends GuardMemory {
  oracle?: OracleModel;
}

/**
 * `decide` in the controller's argument order, with `ctx.ask` as the Jev and `mem.oracle` as the
 * oracle. Without a `probe` (the lanes belong to the sieve) candidates cluster on their P2P vectors
 * only, which is the design's pytest behaviour and still arbitrates a single cluster of ≥ 2.
 */
export function createDecide(opts: { probe?: BehaviourProbe; stage?: StageName } = {}): (ctx: SynthesisContext, mem: SearchMemoryLike, goal: Goal, results: readonly VerifyOutcome[]) => Promise<Decision> {
  return (ctx, mem, goal, results) => {
    const o: DecideOptions = { stage: opts.stage ?? 'propose' };
    if (opts.probe !== undefined) o.probe = opts.probe;
    if (mem.oracle !== undefined) o.oracle = mem.oracle;
    return decide(results, mem, goal, ctx.ask, o);
  };
}

/** The default adapter (P2P-vector clustering; no probe until the lanes provide one). */
export const decideForSearch = createDecide();
