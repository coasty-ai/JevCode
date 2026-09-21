/**
 * The overfit guard and the decision on a run batch (docs/JEV-ONLY-DESIGN.md §2.6; wordings §2.7
 * Q15/Q16, measured in experiments/contrarian/arbitrate.mts → contrarian-arbitrate.{truth,all}.jsonl).
 *
 * Code first, Jev only where tests cannot decide:
 *   0 plausible → hold the best partial (bases.ts) and keep searching;
 *   1 plausible → commit; tests are the oracle and no Noul threshold withholds a lone passer
 *                 (`quicksort` gold Noul 0.15) — at STEP END. Within the step two holds delay it
 *                 (jev-only-quixbugs-3-inspection.md §1: `detect_cycle` and `wrap` committed the
 *                 first lone passer of the step while the gold's site was still unvisited):
 *                 (a) SIEVE mode: a lone passer waits until its site's other seed sources ran, so
 *                     the decision sees the whole site batch (`pending`, rule (a) below);
 *                 (b) a lone passer that is structurally suspicious by code-computed signals
 *                     (deletes a statement, duplicates a block, guards a different variable than
 *                     the failing traceback dereferences, guards an expression nothing reads) is
 *                     put to Q16 as an advisory; below LONE_PASSER_HOLD_MAX_NOUL (one signal) or
 *                     below LONE_PASSER_VOUCH_MIN_NOUL (two or more) it is held as the `suspect`
 *                     and the search runs on through the remaining sources and sites of the step.
 *                     A later passer is arbitrated against it.
 *                 Both holds are released by the next decision once the step's budget is inside
 *                 HOLD_RESERVE_* (the last batch of a step always ends in a decision), and by
 *                 `commitSuspect` at step end; nothing is ever withheld past the step.
 *   ≥ 2        → cluster by behaviour on code-generated perturbed inputs (perturb.ts: the goal's
 *                 calls, the JSON cases, the linked lists the tests build; pytest: the P2P outcome
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
import { choice, ESCAPE_KEY, noul } from '../../jev/questions.js';
import type { NoulCriteriaSpec } from '../../jev/questions.js';
import { codeLines, moduleCodeLines } from '../localize/index.js';
import { codeTokens, levenshtein, normaliseLine, tokenizeFragment } from '../py/index.js';
import type { LanePool } from '../sieve/lanes.js';
import type { Candidate, CandidateSourceName, FailureView, JevAsk, SourceFile } from '../types.js';
import { RUN_FAILURE_ID } from '../verify/text.js';
import { MAX_PARTIALS_REMEMBERED, appliedOnCommitted, commitPartial, committedBase, guardState, holdBestPartial, isPartial, outcomeSummary, siteKeyOf } from './bases.js';
import type { GuardMemory, HeldPasser, PartialAdvice } from './bases.js';
import { SIEVE_MAX_T_RUN_MS } from './budget.js';
import { DEFAULT_PROBE_TIMEOUT_MS, MAX_PERTURBED_INPUTS, TEST_SOURCE_MAX_BYTES, createLaneProbe, inputKey, perturbedInputs, perturbedInputsFor, programNameOf, readTestSources } from './perturb.js';
import type { BehaviourProbe, PerturbedInput } from './perturb.js';
import type { Arbitration, BehaviourCluster, Decision, Goal, OracleModel, StepBudget, VerifyOutcome } from './types.js';

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_PERTURBED_INPUTS,
  PROBE_OUTPUT_BOUND,
  behaviourProbeCommand,
  createLaneProbe,
  linkedListInputs,
  linkedListShape,
  parseBehaviourProbe,
  parseQuixbugsCall,
  perturbationsOf,
  perturbedInputs,
  perturbedInputsFor,
  perturbedInputsFromCases,
  probeTimeoutMs,
  programNameOf,
  readTestSources,
} from './perturb.js';
export type { BehaviourProbe, LinkedListShape, PerturbationKind, PerturbedInput, ProbeCommandOptions, TestSources } from './perturb.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement behind it)
// ---------------------------------------------------------------------------------------

/**
 * The all-overfit signature (§2.6): the sets where every passer overfits answered P(escape) 0.90
 * with max Noul 0.06 (`depth_first_search`, 7 candidates, contrarian-arbitrate.all.jsonl), 0.89 /
 * 0.90 / 0.88 / 0.91 / 0.88 with max Noul 0.05–0.07 (`wrap`, the duplicated-loop passers of
 * jev-only-quixbugs-4-overfit, §13 of jev-only-rungs-1-2.md) and 0.75 / 0.67 with max Noul 0.08
 * (ladder `masked` runs 3 and 3b, §20: five `return 0` inserts into `total_ms`, committed under the
 * 0.8 bound and killing the goal's remaining tests), while every set containing the gold had
 * P(escape) ≤ 0.38 and a Noul ≥ 0.45. Both halves of the signature must hold (`arbitrate`), and the
 * Noul half alone separates the two populations; 0.5 sits between the highest gold escape (0.38)
 * and the lowest all-overfit one (0.67). A flagged set is never withheld past the step: the
 * smallest edit is held as the `suspect` while the remaining sites run and is committed at step
 * end as `possible overfit` if nothing better appears.
 */
export const SUSPECT_ESCAPE_MIN = 0.5;
export const SUSPECT_NOUL_MAX = 0.1;
/**
 * DESIGN §5.4 Choice/Noul resolution rule: the Choice argmax is overridden only when its own Noul
 * is confidently false (< 0.3) and another representative's is confidently true (≥ 0.7). Gold
 * Nouls ranged 0.15–0.96 (below 0.7 on 4/10, below 0.3 on 1/10), so the Noul stays advisory.
 */
export const OVERRIDE_LOW = 0.3;
export const OVERRIDE_HIGH = 0.7;
/**
 * Rule (b): a lone passer with ONE structural signal is held when its Q16 `general` p is below
 * this (the "confidently false" bound of OVERRIDE_LOW; 1/10 measured golds sat below it, and a
 * held gold is only delayed within the step, never withheld).
 */
export const LONE_PASSER_HOLD_MAX_NOUL = OVERRIDE_LOW;
/**
 * A lone passer with TWO OR MORE structural signals is committed at once only when Jev vouches
 * for it confidently (the "confidently true" bound of OVERRIDE_HIGH); anything less holds it. The
 * first live run of the rule (jev-only-rungs-1-2.md §13) had `detect_cycle`'s committed guard —
 * a copied block, guarding a variable the traceback never dereferences, read by nothing — answer
 * 0.39 and commit under the single bound.
 */
export const LONE_PASSER_VOUCH_MIN_NOUL = OVERRIDE_HIGH;
/** Signals from which the stronger (vouch) bound applies. */
export const STRONG_SIGNALS_MIN = 2;
/**
 * A hold is started or kept only while the step has this much left: the wall of ~15 median
 * QuixBugs runs per lane and two lanes' worth of SIEVE batches, so the decision that releases the
 * hold always comes before `visitSource` finds no run left (jev-only-rungs-1-2.md §13). A hold
 * otherwise lasts to the step end (`commitSuspect`): the phase that visits the remaining sites of
 * a single-file workspace (WIDENED) is three phases after SEEDS, so no phase count bounds it.
 */
export const HOLD_RESERVE_WALL_MS = 15_000;
export const HOLD_RESERVE_RUNS = 16;
/**
 * The seed sources a site's batch consists of in SEEDS/WIDENED (subgoal.ts SEED_SOURCES, listed
 * here rather than imported so the guard does not depend on the controller). Composite runs after
 * these are exhausted at the site and never delays a passer.
 */
export const SITE_BATCH_SOURCES: readonly CandidateSourceName[] = ['mutation', 'template', 'donor'];
/** Q15 offered ≤ 20 representatives (contrarian §3.4; the measured sets had 2–7). */
export const MAX_REPRESENTATIVES = 20;
/** One cluster of ≥ 2 passers is still arbitrated (judge 2), over its ≤ 5 smallest-edit members. */
export const SINGLE_CLUSTER_MAX_MEMBERS = 5;
/** The measured state listed the first 4 tests. */
export const TESTS_IN_STATE = 4;
/** Program lines shown to Jev in the Q15 state (Q5's Choice window; measured programs were ≤ 20 lines). */
export const PROGRAM_LINES_MAX = 254;

export class GuardError extends Error {
  constructor(message: string) {
    super(`GuardError: ${message}`);
    this.name = 'GuardError';
  }
}

// ---------------------------------------------------------------------------------------
// Behaviour signatures and clustering (code)
// ---------------------------------------------------------------------------------------

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
// Structural suspicion signals (code) on a lone passer
// ---------------------------------------------------------------------------------------

export type SuspicionSignal = 'deletes_statement' | 'duplicates_block' | 'guards_other_variable' | 'dead_guard';

/** The candidate's own lines (site text and non-delete extra edits), trimmed, non-empty. */
function candidateLines(c: Candidate): string[] {
  const raw = [...c.text.split('\n'), ...(c.extraEdits ?? []).filter((e) => e.kind !== 'delete').flatMap((e) => (e.text ?? '').split('\n'))];
  return raw.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

/** Code lines of the site's enclosing block (the whole file at module level), with their numbers. */
function functionLines(c: Candidate): { line: number; text: string }[] {
  const mod = c.site.file.mod;
  const start = c.site.block?.startLine ?? 1;
  const end = c.site.block?.endLine ?? mod.lines.length;
  const out: { line: number; text: string }[] = [];
  for (let line = start; line <= end; line++) {
    const text = (mod.lines[line - 1] ?? '').trim();
    if (text !== '' && !text.startsWith('#')) out.push({ line, text });
  }
  return out;
}

const NONE_GUARD = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+is\s+None\b/g;
const NOT_GUARD = /(?<!\bis\s)\bnot\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b(?!\s*\()/g;
const CONDITION_HEAD = /^(?:if|elif|while)\b/;

/** `X` of every `X is None` / `not X` in the condition lines of `text`. */
function guardSubjectsIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!CONDITION_HEAD.test(t)) continue;
    for (const m of t.matchAll(NONE_GUARD)) out.push(m[1] ?? '');
    for (const m of t.matchAll(NOT_GUARD)) out.push(m[1] ?? '');
  }
  return out.filter((s) => s !== '' && s !== 'None' && s !== 'True' && s !== 'False');
}

/** Null/empty-guard subjects the candidate ADDS: those of its lines minus those already on the site's current line. */
export function guardSubjects(c: Candidate): string[] {
  const own = guardSubjectsIn(candidateLines(c).join('\n'));
  const before = new Set(c.site.kind === 'replace' ? guardSubjectsIn(c.site.currentLine) : []);
  return [...new Set(own.filter((s) => !before.has(s)))];
}

const NONE_ATTRIBUTE = /'NoneType' object has no attribute '([A-Za-z_]\w*)'/;
const NONE_OPERATION = /'NoneType' object is not (?:subscriptable|iterable|callable)|unsupported operand type\(s\)[^\n]*'NoneType'/;
const TRACE_LINE = /(?:^|\s)([^\s:'"]+\.py):(\d+)(?=:|\s|$)/gm;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The dereference the failing tests crash on: the attribute a `'NoneType' object has no attribute`
 * message names (or a subscript/iteration/call on None), and the root variables dereferenced that
 * way on the traceback line of the site's file (`detect_cycle.py:5: AttributeError` in the test
 * output tail → line 5 `if hare.successor is None:` → `hare`). Null when the failure is not a
 * None dereference or the traceback line is not in the tail.
 */
export function noneDereference(failures: readonly FailureView[], outputTail: string, file: SourceFile): { attr: string | null; receivers: Set<string>; line: number } | null {
  let attr: string | null = null;
  let none = false;
  for (const f of failures) {
    const m = NONE_ATTRIBUTE.exec(f.actual);
    if (m !== null) {
      attr = m[1] ?? null;
      none = true;
      break;
    }
    if (NONE_OPERATION.test(f.actual)) none = true;
  }
  if (!none) return null;
  const base = file.path.split('/').pop() ?? file.path;
  let line: number | null = null;
  for (const m of outputTail.matchAll(TRACE_LINE)) {
    const path = m[1] ?? '';
    if ((path.split('/').pop() ?? path) !== base) continue;
    const n = Number(m[2]);
    if (Number.isInteger(n) && n >= 1 && n <= file.mod.lines.length) line = n;
  }
  if (line === null) return null;
  const text = file.mod.lines[line - 1] ?? '';
  const receivers = new Set<string>();
  if (attr !== null) {
    for (const m of text.matchAll(new RegExp(`([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\.${escapeRe(attr)}\\b`, 'g'))) receivers.add((m[1] ?? '').split('.')[0] ?? '');
  } else {
    for (const m of text.matchAll(/([A-Za-z_]\w*)\s*[[(]/g)) receivers.add(m[1] ?? '');
  }
  receivers.delete('');
  return { attr, receivers, line };
}

/** True when the expression `s` is read somewhere in `lines` other than as a bare value: `s.`, `s[`, `s(`, `in s`, passed to a call. */
function isUsed(s: string, lines: readonly string[]): boolean {
  const e = escapeRe(s);
  const patterns = [new RegExp(`(?:^|[^\\w.])${e}\\s*[.[(]`), new RegExp(`\\bin\\s+${e}\\b`), new RegExp(`\\(\\s*${e}\\s*[,)]`), new RegExp(`,\\s*${e}\\s*[,)]`)];
  return lines.some((l) => patterns.some((p) => p.test(l)));
}

/**
 * Code-computed reasons to doubt a lone passer before it is committed (rule (b)); each is a
 * shape the run-3 overfits had and the golds did not:
 *   - `deletes_statement`: an extra edit deletes a line, or the replacement is empty / `pass`;
 *   - `duplicates_block`: ≥ 2 added lines and at least half of them (≥ 2) are, identifiers and
 *     literals abstracted, lines the function already has (`wrap`: the loop copied under itself);
 *   - `guards_other_variable`: the tests crash dereferencing None and the added `X is None` /
 *     `not X` guards name no root variable dereferenced on the traceback line (`detect_cycle`:
 *     `tortoise.successor` guarded, `hare.successor` crashed);
 *   - `dead_guard`: an added guard statement whose subject expression nothing in the function
 *     reads (`tortoise.successor` is never dereferenced, indexed, iterated or passed).
 * Advisory only: the signals trigger a Q16 question, never a rejection.
 */
export function suspicionSignals(o: VerifyOutcome, goal: Pick<Goal, 'failures'>): SuspicionSignal[] {
  const c = o.applied.candidate;
  const out: SuspicionSignal[] = [];
  const added = candidateLines(c);
  if ((c.extraEdits ?? []).some((e) => e.kind === 'delete') || (c.site.kind === 'replace' && /^(?:pass)?$/.test(c.text.trim()))) out.push('deletes_statement');

  const fn = functionLines(c).filter((l) => !(c.site.kind === 'replace' && l.line === c.site.line));
  if (added.length >= 2) {
    const norm = new Set(fn.map((l) => normaliseLine(l.text).join(' ')));
    const dup = added.filter((l) => norm.has(normaliseLine(l).join(' '))).length;
    if (dup >= Math.max(2, Math.ceil(added.length / 2))) out.push('duplicates_block');
  }

  const subjects = guardSubjects(c);
  if (subjects.length > 0) {
    const deref = noneDereference(goal.failures, o.job.base.summary.outputTail, c.site.file);
    if (deref !== null && deref.receivers.size > 0 && subjects.every((s) => !deref.receivers.has(s.split('.')[0] ?? s))) out.push('guards_other_variable');
    // an added guard statement (an insert, or a replace that wraps the current line in new lines)
    const addsStatement = c.site.kind === 'insert' || added.length >= 2;
    if (addsStatement && subjects.every((s) => !isUsed(s, fn.map((l) => l.text)))) out.push('dead_guard');
  }
  return out;
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

/** The one-candidate key of the Q16 advisory (rule (b)): the same state shape as an arbitration over one representative. */
export const LONE_PASSER_KEY = 'cand_01';

/**
 * Rule (b)'s advisory: Q16 `general_cand_01` alone (no Choice: one option is not a choice) over the
 * arbitration state of the lone passer. Returns Jev's p, or null when the answer is not a Noul.
 */
export async function adviseLonePasser(ctx: ArbitrateContext, o: VerifyOutcome, ask: JevAsk): Promise<{ p: number | null; requests: number; state: Json }> {
  const reps = representativesOf(clusterByBehaviour([o]));
  const state = arbitrateState(ctx, reps);
  const id = `${GENERAL_PREFIX}${LONE_PASSER_KEY}`;
  const res = await ask(ctx.stage ?? 'propose', state, { [id]: noul(generalInstructions(LONE_PASSER_KEY), GENERAL_CRITERIA) });
  const a = res.answers[id];
  return { p: a !== undefined && a.type === 'noul' ? a.noul : null, requests: 1, state };
}

// ---------------------------------------------------------------------------------------
// decide (§2.6 pseudo-code, with the two within-step holds)
// ---------------------------------------------------------------------------------------

export type HoldKind = 'pending' | 'suspect';

/** The bookkeeping every guard decision carries beside the Decision itself. */
export interface GuardFields {
  /** plausible candidates in THIS batch (held ones are not counted again) */
  plausible: number;
  clusters: number;
  arbitrated: boolean;
  requests: number;
  /** other arbitrated representatives, for later steps if the judge rejects the pick */
  fallbacks: VerifyOutcome[];
  /** the behaviour probe failed and clustering fell back to the P2P vectors (message), else null */
  probeError: string | null;
  /** a lone passer is being held (rule (a) `pending`, rule (b) `suspect`) after this decision */
  held: HoldKind | null;
  /** the structural signals computed on a fresh lone passer this decision */
  signals: SuspicionSignal[];
}

export type GuardDecision = Decision & GuardFields;

/** What a hold reads from the step budget (search/types.ts StepBudget). */
export type HoldBudget = Pick<StepBudget, 'exhausted' | 'testWallLeftMs' | 'testRunsLeft' | 'jevRequestsLeft'>;

export interface DecideOptions {
  /** stage of the Q15/Q16 requests (default 'propose') */
  stage?: StageName;
  /** e.g. "the Python function `gcd`" for the arbitration state */
  subject?: string;
  /** for `perturbedInputs` and the SIEVE hold; absent → P2P vectors only, no hold */
  oracle?: OracleModel;
  /** runs the behaviour probe on the lanes; absent → P2P vectors only */
  probe?: BehaviourProbe;
  /** extra probe inputs beyond the goal's calls (test-file-derived, perturb.ts), fetched only when ≥ 2 passers need them */
  inputs?: () => Promise<readonly PerturbedInput[]>;
  /** the step budget; a hold is started or kept only inside HOLD_RESERVE_* (absent → no budget limit, as in unit tests) */
  budget?: HoldBudget;
  /** transcript note (`synth` event) for holds and releases */
  note?: (detail: string) => void;
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
function commit(mem: GuardMemory, o: VerifyOutcome, extra: GuardFields & { note?: 'possible overfit' }): GuardDecision {
  return { kind: 'commit', applied: appliedOnCommitted(mem, o), allGoalTestsPass: true, outcome: o, ...extra, clusters: Math.max(1, extra.clusters) };
}

/** The passers held for `goal` (rule (a) pending, rule (b) suspect), pending first. */
function heldPassers(mem: GuardMemory, goal: Pick<Goal, 'id'>): VerifyOutcome[] {
  const st = guardState(mem);
  const out: VerifyOutcome[] = [];
  if (st.pending !== null && st.pending.goalId === goal.id) out.push(st.pending.outcome);
  if (st.suspect !== null && st.suspect.goalId === goal.id && !out.includes(st.suspect.outcome)) out.push(st.suspect.outcome);
  return out;
}

function clearHeld(mem: GuardMemory, goal: Pick<Goal, 'id'>): void {
  const st = guardState(mem);
  if (st.pending !== null && st.pending.goalId === goal.id) st.pending = null;
  if (st.suspect !== null && st.suspect.goalId === goal.id) st.suspect = null;
}

function dedupeById(outcomes: readonly VerifyOutcome[]): VerifyOutcome[] {
  const seen = new Set<string>();
  const out: VerifyOutcome[] = [];
  for (const o of outcomes) {
    const id = o.applied.candidate.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(o);
  }
  return out;
}

/** The step can still afford to keep a passer waiting (see HOLD_RESERVE_*); no budget → yes. */
export function budgetAllowsHold(budget: HoldBudget | undefined): boolean {
  if (budget === undefined) return true;
  return !budget.exhausted() && budget.testWallLeftMs >= HOLD_RESERVE_WALL_MS && budget.testRunsLeft >= HOLD_RESERVE_RUNS && budget.jevRequestsLeft >= 1;
}

/**
 * Rule (a): does the batch that just ran tell us the pending passer's site batch is over? A batch
 * from another site or from composite (which only runs after the seed sources) says yes; a batch
 * at the same site says yes when no seed source other than its own is left to run there (the
 * controller marks a source exhausted after its batch, so the batch's own source is counted as
 * done). An empty batch (every job deferred) says nothing.
 */
export function siteBatchDone(goal: Pick<Goal, 'exhausted'>, results: readonly VerifyOutcome[], pendingSiteKey: string): boolean {
  const first = results[0]?.job.candidate;
  if (first === undefined) return false;
  if (first.source === 'composite' || siteKeyOf(first) !== pendingSiteKey) return true;
  const exhausted = goal.exhausted.get(pendingSiteKey) ?? new Set<CandidateSourceName>();
  return SITE_BATCH_SOURCES.every((s) => s === first.source || exhausted.has(s));
}

/**
 * Rule (a) applies to a fresh lone passer when the tests are the ranker (SIEVE: t_run within
 * budget.SIEVE_MAX_T_RUN_MS) in a seed phase and another seed source is still to run at its site.
 */
export function sieveHoldApplies(goal: Pick<Goal, 'phase' | 'exhausted'>, o: VerifyOutcome, oracle: OracleModel | undefined): boolean {
  if (oracle === undefined || oracle.tRunMs.goalSubset > SIEVE_MAX_T_RUN_MS) return false;
  if (goal.phase !== 'SEEDS' && goal.phase !== 'WIDENED') return false;
  const c = o.applied.candidate;
  if (!SITE_BATCH_SOURCES.includes(c.source)) return false;
  const exhausted = goal.exhausted.get(siteKeyOf(c)) ?? new Set<CandidateSourceName>();
  return SITE_BATCH_SOURCES.some((s) => s !== c.source && !exhausted.has(s));
}

/** Probe inputs for the goal: its calls' perturbations plus the test-file-derived ones, deduplicated and bounded. */
async function probeInputs(goal: Goal, opts: DecideOptions): Promise<PerturbedInput[]> {
  if (opts.oracle === undefined) return [];
  const out: PerturbedInput[] = [];
  const seen = new Set<string>();
  const add = (list: readonly PerturbedInput[]): void => {
    for (const p of list) {
      if (out.length >= MAX_PERTURBED_INPUTS) return;
      const k = inputKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  };
  add(perturbedInputs(goal, opts.oracle));
  if (opts.inputs !== undefined) add(await opts.inputs());
  return out;
}

function describe(o: VerifyOutcome): string {
  const c = o.applied.candidate;
  return `${c.source}/${c.op} at ${siteKeyOf(c)}`;
}

/**
 * The decision on one run batch. Nothing here writes to the workspace: regressed, unchanged and
 * timed-out candidates are simply dropped (they are already in `tried`). Passers held from
 * earlier batches of the goal join this batch's before anything is decided.
 */
export async function decide(results: readonly VerifyOutcome[], mem: GuardMemory, goal: Goal, ask: JevAsk, opts: DecideOptions = {}): Promise<GuardDecision> {
  const st = guardState(mem);
  const note = opts.note ?? ((): void => undefined);
  const fresh = mostPassing(results.filter((o) => isPlausible(o, goal)));
  const partial = results.filter((o) => !isPlausible(o, goal) && isPartial(o));
  const carried = heldPassers(mem, goal);
  const plausible = mostPassing(dedupeById([...carried, ...fresh]));
  const base = { plausible: fresh.length, clusters: 0, arbitrated: false, requests: 0, fallbacks: [] as VerifyOutcome[], probeError: null as string | null, held: null as HoldKind | null, signals: [] as SuspicionSignal[] };

  if (plausible.length === 0) {
    // Code only: strictly more passed wins, ties by the bases.ts tie-break rule (no Jev request).
    holdBestPartial(mem, partial, goal);
    return { kind: 'continue', ...base };
  }

  const only = plausible[0];
  if (plausible.length === 1 && only !== undefined) {
    const budgetOk = budgetAllowsHold(opts.budget);
    // A held passer, still alone: keep it, or release it when the step cannot afford more.
    if (st.suspect !== null && st.suspect.goalId === goal.id && st.suspect.outcome === only) {
      if (!budgetOk) {
        clearHeld(mem, goal);
        note(`${goal.id}: releases the held suspect ${describe(only)} (budget reserve); committing as possible overfit`);
        return commit(mem, only, { ...base, note: 'possible overfit' });
      }
      return { kind: 'continue', ...base, held: 'suspect' };
    }
    if (st.pending !== null && st.pending.goalId === goal.id && st.pending.outcome === only) {
      const siteKey = st.pending.siteKey;
      const done = siteBatchDone(goal, results, siteKey);
      if (done || !budgetOk) {
        clearHeld(mem, goal);
        note(`${goal.id}: site batch ${siteKey} ${done ? 'complete' : 'cut by the budget reserve'}; committing its lone passer ${describe(only)}`);
        return commit(mem, only, base);
      }
      return { kind: 'continue', ...base, held: 'pending' };
    }
    // A fresh lone passer (a held one with fewer passing tests, if any, is dropped by mostPassing).
    clearHeld(mem, goal);
    const signals = suspicionSignals(only, goal);
    let requests = 0;
    if (signals.length > 0 && budgetOk) {
      const arbCtx: ArbitrateContext = { goal };
      if (opts.stage !== undefined) arbCtx.stage = opts.stage;
      const adv = await adviseLonePasser(arbCtx, only, ask);
      requests += adv.requests;
      const bound = signals.length >= STRONG_SIGNALS_MIN ? LONE_PASSER_VOUCH_MIN_NOUL : LONE_PASSER_HOLD_MAX_NOUL;
      if (adv.p !== null && adv.p < bound) {
        const held: HeldPasser = { goalId: goal.id, outcome: only, phase: goal.phase, signals, noul: adv.p };
        st.suspect = held;
        note(`${goal.id}: holds the lone passer ${describe(only)} as suspect (${signals.join(', ')}; general ${adv.p.toFixed(2)} < ${bound}); searching on through the step's remaining sources and sites`);
        return { kind: 'continue', ...base, requests, signals, held: 'suspect' };
      }
      note(`${goal.id}: lone passer ${describe(only)} looks ${signals.join(', ')} but general ${adv.p === null ? 'n/a' : adv.p.toFixed(2)} ≥ ${bound} keeps it`);
    }
    if (budgetOk && sieveHoldApplies(goal, only, opts.oracle)) {
      st.pending = { goalId: goal.id, outcome: only, siteKey: siteKeyOf(only.applied.candidate), phase: goal.phase };
      note(`${goal.id}: holds the lone passer ${describe(only)} until its site's seed sources ran`);
      return { kind: 'continue', ...base, requests, signals, held: 'pending' };
    }
    return commit(mem, only, { ...base, requests, signals });
  }

  // ≥ 2 passers (this batch's and the held ones). The probe is best effort: a lane or interpreter
  // failure must not abort a step that has test-passing candidates, so it degrades to the P2P
  // vectors (the design's pytest behaviour).
  let signatures: ReadonlyMap<string, string> = new Map();
  let probeError: string | null = null;
  let probed = 0;
  if (opts.probe !== undefined && opts.oracle !== undefined) {
    try {
      const inputs = await probeInputs(goal, opts);
      probed = inputs.length;
      if (inputs.length > 0) signatures = await opts.probe(plausible, inputs);
    } catch (e) {
      probeError = e instanceof Error ? e.message : String(e);
    }
  }
  const clusters = clusterByBehaviour(plausible, signatures);
  const arbCtx: ArbitrateContext = { goal };
  if (opts.stage !== undefined) arbCtx.stage = opts.stage;
  const arb = await arbitrate(arbCtx, clusters, ask);
  const common = { ...base, plausible: fresh.length, clusters: clusters.length, arbitrated: true, requests: arb.requests, probeError };
  const probeNote = opts.probe === undefined ? 'no probe' : `probe ${probed} inputs, ${signatures.size}/${plausible.length} signatures${probeError === null ? '' : `, error: ${probeError}`}`;
  note(`${goal.id}: arbitrated ${plausible.length} passers (${carried.length} held) in ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} (${probeNote}); escape ${arb.pEscape.toFixed(2)}, max general ${Math.max(...Object.values(arb.noul)).toFixed(2)}; ${arb.suspect ? `all-overfit signature, holding ${describe(minEdit(plausible))}` : `pick ${describe(arb.pick)}`}`);

  if (arb.suspect) {
    // Every passer looks like an overfit: remember the smallest edit and keep searching (gap
    // sites next); it is committed at step end with `possible overfit` if nothing better appears.
    const candidate = minEdit(plausible);
    clearHeld(mem, goal);
    st.suspect = { goalId: goal.id, outcome: candidate, phase: goal.phase, signals: [] };
    return { kind: 'continue', ...common, held: 'suspect' };
  }
  clearHeld(mem, goal);
  guardState(mem).fallbacks = { goalId: goal.id, outcomes: arb.fallbacks };
  return commit(mem, arb.pick, { ...common, fallbacks: arb.fallbacks });
}

/**
 * Step-end rule (§2.3): a passer held for `goal` is still proposed, because the guard never
 * overrides the tests: rule (a)'s pending passer as a plain commit, rule (b)'s or the
 * all-overfit suspect marked `possible overfit`. Clears the hold so the next step starts clean;
 * another goal's hold is left alone (and null is returned). Without `goal` any held passer is
 * committed (callers that search one goal per step should pass it so a parked goal's flagged
 * passer never surfaces under a later goal).
 */
export function commitSuspect(mem: GuardMemory, goal?: Pick<Goal, 'id'>): Decision | null {
  const st = guardState(mem);
  const p = st.pending;
  if (p !== null && (goal === undefined || p.goalId === goal.id)) {
    st.pending = null;
    if (st.suspect !== null && st.suspect.goalId === p.goalId) st.suspect = null;
    return { kind: 'commit', applied: appliedOnCommitted(mem, p.outcome), allGoalTestsPass: true, outcome: p.outcome };
  }
  const s = st.suspect;
  if (s === null || (goal !== undefined && s.goalId !== goal.id)) return null;
  st.suspect = null;
  return { kind: 'commit', applied: appliedOnCommitted(mem, s.outcome), allGoalTestsPass: true, note: 'possible overfit', outcome: s.outcome };
}

// ---------------------------------------------------------------------------------------
// The gate on a progress commit: the held partial at a budget exit or at exhaustion
// ---------------------------------------------------------------------------------------

export type PartialVerdict = 'clean' | 'vouched' | 'held' | 'no_request';

export interface PartialGate {
  /** the progress commit, or null when the partial stays held (doubtful, or no request left to ask) */
  decision: Decision | null;
  requests: number;
  signals: SuspicionSignal[];
  /** Jev's Q16 `general` p on the partial when asked (this step or an earlier one), else null */
  noul: number | null;
  verdict: PartialVerdict;
}

function rememberAdvice(mem: GuardMemory, id: string, advice: PartialAdvice): void {
  const st = guardState(mem);
  st.partialAdvice.set(id, advice);
  while (st.partialAdvice.size > MAX_PARTIALS_REMEMBERED) {
    const oldest = st.partialAdvice.keys().next().value;
    if (oldest === undefined) break;
    st.partialAdvice.delete(oldest);
  }
}

/**
 * The guard on a progress commit (subgoal.ts commitProgress), exactly rule (b) on a lone passer:
 * the code-computed suspicion signals on `verified` — the held partial with its full-suite
 * regression run attached — and, when any fires, ONE Q16 advisory over the same one-candidate
 * arbitration state. No signal → commit. Signals → held below LONE_PASSER_HOLD_MAX_NOUL (one
 * signal) or LONE_PASSER_VOUCH_MIN_NOUL (two or more), committed at or above. The advisory is
 * cached per candidate in the guard state: a partial that stays the incumbent across steps is
 * asked about once, and one Jev rated doubtful stays held without another request. A flagged
 * partial the step cannot ask about (no Jev request left) is held as well and asked next step —
 * unlike a lone passer, a partial closes no goal, so a step's wait withholds nothing the tests
 * decided. Held means: the base stays in the beam (a strictly better partial may replace it, a
 * later batch may still pass every goal test) and the controller's budget/park bookkeeping
 * applies as before; an all-signals doubtful partial is never committed.
 */
export async function gateHeldPartial(mem: GuardMemory, goal: Goal, verified: VerifyOutcome, ask: JevAsk, opts: { budget?: Pick<HoldBudget, 'jevRequestsLeft'>; stage?: StageName; note?: (detail: string) => void } = {}): Promise<PartialGate> {
  const st = guardState(mem);
  const note = opts.note ?? ((): void => undefined);
  const signals = suspicionSignals(verified, goal);
  const after = outcomeSummary(verified);
  const id = verified.applied.candidate.id;
  if (signals.length === 0) return { decision: commitPartial(mem, goal, { outcome: verified, after }), requests: 0, signals, noul: null, verdict: 'clean' };

  let advice = st.partialAdvice.get(id);
  let requests = 0;
  if (advice === undefined || advice.noul === null) {
    const canAsk = opts.budget === undefined || opts.budget.jevRequestsLeft >= 1;
    if (!canAsk) {
      note(`${goal.id}: the held partial ${describe(verified)} looks ${signals.join(', ')} and no Jev request is left to ask about it; held until the next step`);
      return { decision: null, requests, signals, noul: null, verdict: 'no_request' };
    }
    const arbCtx: ArbitrateContext = { goal };
    if (opts.stage !== undefined) arbCtx.stage = opts.stage;
    const adv = await adviseLonePasser(arbCtx, verified, ask);
    requests += adv.requests;
    advice = { goalId: goal.id, signals: [...signals], noul: adv.p };
    rememberAdvice(mem, id, advice);
  }
  const bound = signals.length >= STRONG_SIGNALS_MIN ? LONE_PASSER_VOUCH_MIN_NOUL : LONE_PASSER_HOLD_MAX_NOUL;
  const p = advice.noul;
  if (p !== null && p >= bound) {
    note(`${goal.id}: the held partial ${describe(verified)} looks ${signals.join(', ')} but general ${p.toFixed(2)} ≥ ${bound} keeps it; committing it as a partial fix`);
    return { decision: commitPartial(mem, goal, { outcome: verified, after }), requests, signals, noul: p, verdict: 'vouched' };
  }
  note(`${goal.id}: holds the partial ${describe(verified)} (${signals.join(', ')}; general ${p === null ? 'n/a' : p.toFixed(2)} < ${bound}); not committed`);
  return { decision: null, requests, signals, noul: p, verdict: 'held' };
}

// ---------------------------------------------------------------------------------------
// Adapter for the sub-goal controller (search/subgoal.ts SubGoalDeps.guard)
// ---------------------------------------------------------------------------------------

/**
 * What the adapter reads from the run's SearchMemory (memory.ts, sieve/runner.ts RunnerMemory):
 * `oracle` selects the runner for perturbed inputs, `stepBudget` bounds the holds, `lanes` (the
 * runner's pool, present once a batch ran) executes the behaviour probe.
 */
export interface SearchMemoryLike extends GuardMemory {
  oracle?: OracleModel;
  stepBudget?: StepBudget;
  lanes?: LanePool;
}

const PROBE_INPUTS = new WeakMap<GuardMemory, Map<string, PerturbedInput[]>>();

/** Read a workspace file through the engine's Workspace; null when unreadable, absent or truncated. */
async function readWorkspaceFile(ctx: Pick<SynthesisContext, 'workspace'>, path: string): Promise<string | null> {
  try {
    const view = await ctx.workspace.read(path, TEST_SOURCE_MAX_BYTES);
    return view.truncatedBytes > 0 ? null : view.content;
  } catch {
    return null;
  }
}

/**
 * The test-file-derived probe inputs of a goal (perturb.ts `perturbedInputsFor`), read through the
 * workspace once per goal and memory (the tests never change during a run).
 */
async function testDerivedInputs(ctx: Pick<SynthesisContext, 'workspace'>, mem: SearchMemoryLike, goal: Goal, program: string): Promise<PerturbedInput[]> {
  let cache = PROBE_INPUTS.get(mem);
  if (cache === undefined) {
    cache = new Map();
    PROBE_INPUTS.set(mem, cache);
  }
  const hit = cache.get(goal.id);
  if (hit !== undefined) return hit;
  const files = committedBase(mem).files;
  const sources = await readTestSources((path) => readWorkspaceFile(ctx, path), goal, program);
  const inputs = perturbedInputsFor(goal, mem.oracle ?? { runner: 'other' }, program, files, sources);
  cache.set(goal.id, inputs);
  return inputs;
}

/**
 * `decide` in the controller's argument order, with `ctx.ask` as the Jev, `mem.oracle` as the
 * oracle and `mem.stepBudget` as the hold bound. On a QuixBugs-layout workspace (a test module
 * `tests/<name>_test.py` or `tests/test_<name>.py` beside `<name>.py`, `programNameOf`) whose
 * lanes exist, the behaviour probe runs on them (perturb.ts `createLaneProbe`) with the goal's
 * calls, its JSON cases and the linked lists its test module builds as inputs. The gate is the
 * layout, not `oracle.runner`: the bench's QuixBugs workspaces are pytest modules and `fitOracle`
 * labels them `pytest`. Elsewhere (repositories, or a `probe` given here) candidates cluster on
 * their P2P vectors, which is the design's pytest behaviour and still arbitrates a single cluster
 * of ≥ 2.
 */
export function createDecide(opts: { probe?: BehaviourProbe; stage?: StageName } = {}): (ctx: SynthesisContext, mem: SearchMemoryLike, goal: Goal, results: readonly VerifyOutcome[]) => Promise<Decision> {
  return (ctx, mem, goal, results) => {
    const o: DecideOptions = { stage: opts.stage ?? 'propose', note: (detail) => ctx.emit({ type: 'synth', step: ctx.step, phase: 'guard', detail }) };
    if (mem.oracle !== undefined) o.oracle = mem.oracle;
    if (mem.stepBudget !== undefined) o.budget = mem.stepBudget;
    if (opts.probe !== undefined) o.probe = opts.probe;
    else if (mem.oracle !== undefined && mem.lanes !== undefined) {
      const program = programNameOf(goal, committedBase(mem).files);
      if (program !== null) {
        const perInput = Math.min(mem.oracle.perTestTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
        o.probe = createLaneProbe(ctx, mem.lanes, program, perInput);
        o.inputs = () => testDerivedInputs(ctx, mem, goal, program);
      }
    }
    return decide(results, mem, goal, ctx.ask, o);
  };
}

/** The default adapter (lane probe on QuixBugs oracles, P2P-vector clustering elsewhere). */
export const decideForSearch = createDecide();
