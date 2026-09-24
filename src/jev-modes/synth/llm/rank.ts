/**
 * Q17 — ordering the LLM's distinct samples (docs/LLM-JEV-DESIGN.md §3 row 4g, §5 Q17). Asked
 * only when `|distinct| > runsLeft` or `t_run > 2,000 ms`, and it never withholds a run: the
 * Choice `fix` over ≤ 8 candidates (+ escape) sets the queue order, one full-criteria Noul per
 * candidate (`is_fix_patch_<sha4>`, chunks ≤ 50) breaks ties and orders the candidates beyond
 * the Choice. Keys carry no position (order-only keys collapse, REPORT §10); descriptions are the
 * hunks as `{file, lines, replaces, with}` (≤ 400 chars per hunk, ≤ 3 shown) and nothing else —
 * the sample's own `rationale` (`LlmCandidate.provenance`) is transcript-only: Jev reads the hunks
 * literally and is never handed the generator's plea for its patch (§5 Q17). The fix-absent
 * signals (strong: P(escape) − p_max ≥ 0.10 ∧ max Noul < 0.3; weak: exactly one of the two)
 * are recorded for routing after the runs returned 0 passers — never consumed as a gate.
 */
import { clip } from '../../../core/text.js';
import type { Answer, Json, Question, StageName } from '../../../core/types.js';
import { ESCAPE_KEY, assertQuestionBatch, choice, noul, type NoulCriteriaSpec } from '../../../jev/questions.js';
import { LITERAL_SUFFIX } from '../rank/questions.js';
import type { FailureView, JevAsk, LineEdit, SourceFile } from '../types.js';
import type { LlmApplied } from './candidates.js';
import { listingAt } from './prompt.js';

export const Q17_CHOICE_ID = 'fix';
export const Q17_NOUL_PREFIX = 'is_fix_';
export const Q17_CHOICE_MAX = 8;
export const Q17_NOUL_CHUNK = 50;
/** the run cost above which the order is worth one request even when every distinct sample will run */
export const Q17_T_RUN_MS = 2000;
export const Q17_HUNKS_SHOWN = 3;
export const Q17_HUNK_CHARS = 400;
export const Q17_TESTS = 3;
export const Q17_TASK_CHARS = 2000;
export const Q17_PROGRAM_LINES = 120;
export const Q17_PROGRAM_FUNCTIONS = 6;
export const Q17_STRONG_MARGIN = 0.1;
export const Q17_ABSENT_NOUL = 0.3;
const DETECTOR_EPSILON = 1e-9;

/** Correct-fix criteria for a multi-hunk patch (both sides, ≥ 2 examples each). */
export const PATCH_FIX_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'Applied to `program`, the patch makes every test in `tests` pass, including the ones that currently fail, and keeps the behaviour the passing tests rely on; every hunk is needed or harmless.',
    examples: ['the guard, index or operator the bug got wrong is corrected in every place the failing tests exercise', 'a missing statement is inserted where the traceback shows it is needed and nothing else changes behaviour'],
  },
  false: {
    definition: 'The patch leaves the failing behaviour in place, introduces a different bug, edits an unrelated block, or would break a test that passes today.',
    examples: ['a hunk that changes a different function than the one the traceback names', 'a change that makes the failing input return the expected value by special-casing it while other inputs regress', 'two hunks that contradict each other'],
  },
};

const PATCH_FIX_CRITERIA_STATE: Json = {
  correct_fix: PATCH_FIX_CRITERIA.true.definition,
  correct_fix_examples: [...PATCH_FIX_CRITERIA.true.examples],
  not_a_fix: PATCH_FIX_CRITERIA.false.definition,
  not_a_fix_examples: [...PATCH_FIX_CRITERIA.false.examples],
};

/**
 * Order only when the queue cannot run every distinct sample — the same "can I just run them
 * all?" test the seed path takes (`search/budget.ts poolFitsRunBudget`, SIEVE/RANK).
 *
 * OOS 2026-09-22 ranked change 1: the old second clause (`t_run > Q17_T_RUN_MS`) asked for an
 * order over a pool every member of which was going to run anyway. `runsLeft` already prices
 * t_run — it divides the wall left by the measured run at the current lane count — so an
 * expensive run shrinks `runsLeft` and the first clause fires on its own when it should. The
 * measured value of the order it bought was nil: of 65,076 `candidate_*` Noul answers 96.3 % fell
 * in [0.0, 0.1) and 13 reached 0.5, and 99–100 % of the requests fired in `plausible = 0` steps.
 * `tRunMs` stays in the signature: the caller has it, and dropping a parameter from a predicate
 * this load-bearing would silently re-order every call site.
 */
export function q17Needed(distinct: number, runsLeft: number, _tRunMs: number): boolean {
  return distinct > 1 && distinct > runsLeft;
}

// ---------------------------------------------------------------------------------------
// Hunk views
// ---------------------------------------------------------------------------------------

export interface HunkView {
  file: string;
  /** `L<a>-L<b>` (before-edit numbering) */
  lines: string;
  replaces: string;
  with: string;
}

function beforeLines(a: LlmApplied, path: string): string[] {
  const f = a.files.find((x) => x.path === path);
  const src = f?.before ?? (path === a.candidate.site.file.path ? a.candidate.site.file.src : '');
  return src.split('\n').map((l) => l.replace(/\r$/, ''));
}

/** The candidate's hunks in reading order: the site span first, then every extra-edit run (a replace followed by its deletions, or a deletion run). */
export function hunksOf(a: LlmApplied): HunkView[] {
  const c = a.candidate;
  const out: HunkView[] = [];
  const spanOf = (path: string, start: number, end: number): string => beforeLines(a, path).slice(start - 1, end).join('\n');
  out.push({ file: c.site.file.path, lines: c.site.span.endLine > c.site.line ? `L${c.site.line}-L${c.site.span.endLine}` : `L${c.site.line}`, replaces: spanOf(c.site.file.path, c.site.line, c.site.span.endLine), with: c.text });
  let open: { path: string; start: number; end: number; text: string } | null = null;
  const flush = (): void => {
    if (open === null) return;
    out.push({ file: open.path, lines: open.end > open.start ? `L${open.start}-L${open.end}` : `L${open.start}`, replaces: spanOf(open.path, open.start, open.end), with: open.text });
    open = null;
  };
  for (const e of c.extraEdits ?? []) {
    const edit: LineEdit = e;
    if (edit.kind === 'delete' && open !== null && open.path === edit.path && edit.line === open.end + 1) {
      open.end = edit.line;
      continue;
    }
    flush();
    if (edit.kind === 'insert') out.push({ file: edit.path, lines: `before L${edit.line}`, replaces: '', with: edit.text ?? '' });
    else open = { path: edit.path, start: edit.line, end: edit.line, text: edit.kind === 'replace' ? (edit.text ?? '') : '' };
  }
  flush();
  return out;
}

function hunkJson(h: HunkView): Json {
  return { file: h.file, lines: h.lines, replaces: clip(h.replaces, Q17_HUNK_CHARS), with: clip(h.with, Q17_HUNK_CHARS) };
}

/** `patch_<sha4>` from the candidate id (`llm:<sha12>`), lengthened on a collision. */
export function patchKey(candidateId: string, taken: ReadonlySet<string>): string {
  const sha = candidateId.replace(/^llm:/, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';
  for (let n = 4; n <= sha.length; n += 2) {
    const key = `patch_${sha.slice(0, n)}`;
    if (!taken.has(key)) return key;
  }
  let i = 2;
  while (taken.has(`patch_${sha}_${i}`)) i += 1;
  return `patch_${sha}_${i}`;
}

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

export interface Q17Input {
  task: string;
  failures: readonly FailureView[];
  /** distinct samples (one per diff), arrival order */
  candidates: readonly LlmApplied[];
  files: ReadonlyMap<string, SourceFile>;
}

export interface Q17Request {
  state: Json;
  questions: Record<string, Question>;
  /** candidate keys this request asks about */
  keys: string[];
  hasChoice: boolean;
}

export interface Q17Plan {
  requests: Q17Request[];
  /** candidate id → key */
  keyOf: Map<string, string>;
  /** key → candidate id */
  idOf: Map<string, string>;
  /** the ≤ 8 keys the Choice ranks */
  choiceKeys: string[];
}

function programOf(input: Q17Input, cands: readonly LlmApplied[]): Json {
  const program: Record<string, Record<string, string>> = {};
  const seen = new Set<string>();
  let functions = 0;
  for (const a of cands) {
    for (const h of hunksOf(a)) {
      if (functions >= Q17_PROGRAM_FUNCTIONS) break;
      const line = Number(/L(\d+)/.exec(h.lines)?.[1] ?? '1');
      const l = listingAt(input.files, { path: h.file, line }, 'jev', Q17_PROGRAM_LINES);
      if (l === null) continue;
      const key = `${l.path}:${l.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      functions += 1;
      const lines = program[l.path] ?? {};
      l.lines.forEach((text, i) => (lines[`L${l.startLine + i}`] = text));
      program[l.path] = lines;
    }
  }
  return program;
}

function testsOf(input: Q17Input): Json {
  return input.failures.slice(0, Q17_TESTS).map((f) => ({ id: f.testId, call: clip(f.call, 400), expected: clip(f.expected, 400), actual_with_bug: clip(f.actual, 400) }));
}

/** The option description and the state entry of one candidate: its hunks only (no `rationale` — the generator's prose stays in the transcript). */
function candidateJson(a: LlmApplied): Json {
  const hunks = hunksOf(a);
  const shown = hunks.slice(0, Q17_HUNKS_SHOWN).map(hunkJson);
  const out: Record<string, Json> = { hunks: shown };
  if (hunks.length > shown.length) out['more_hunks'] = hunks.length - shown.length;
  return out;
}

function stateFor(input: Q17Input, cands: readonly LlmApplied[], keys: readonly string[]): Json {
  const candidates: Record<string, Json> = {};
  cands.forEach((a, i) => (candidates[keys[i]!] = candidateJson(a)));
  return { task: clip(input.task, Q17_TASK_CHARS), program: programOf(input, cands), tests: testsOf(input), candidates, correct_fix_criteria: PATCH_FIX_CRITERIA_STATE };
}

function choiceQuestion(cands: readonly LlmApplied[], keys: readonly string[]): Question {
  const options: Record<string, Json | null> = {};
  cands.forEach((a, i) => (options[keys[i]!] = candidateJson(a)));
  options[ESCAPE_KEY] = 'No candidate is a correct fix; every candidate leaves the failing tests failing or breaks the program.';
  return choice(`Which candidate patch in \`candidates\`, applied to \`program\`, makes every test in \`tests\` pass, including the tests that currently fail? Read each candidate's hunks literally. Choose \`${ESCAPE_KEY}\` if no candidate is a correct fix.${LITERAL_SUFFIX}`, options);
}

function noulQuestion(key: string): Question {
  return noul(`Is \`candidates.${key}\` a correct fix: applied to \`program\`, does it make every test in \`tests\` pass, including the ones that currently fail, without breaking the others? Judge the hunks literally against the failing behaviour.`, PATCH_FIX_CRITERIA);
}

/**
 * The requests: one request with the Choice over the first ≤ 8 candidates plus the Nouls of the
 * first chunk (≤ 50), then Noul-only chunks (≤ 50 each) for the rest. Keys restart per candidate
 * set, never per position.
 */
export function buildQ17(input: Q17Input): Q17Plan {
  const keyOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const a of input.candidates) {
    const key = patchKey(a.candidate.id, taken);
    taken.add(key);
    keyOf.set(a.candidate.id, key);
    idOf.set(key, a.candidate.id);
  }
  const keyAt = (a: LlmApplied): string => keyOf.get(a.candidate.id)!;
  const requests: Q17Request[] = [];
  const choiceCands = input.candidates.slice(0, Q17_CHOICE_MAX);
  const choiceKeys = choiceCands.map(keyAt);
  for (let offset = 0; offset < input.candidates.length; offset += Q17_NOUL_CHUNK) {
    const chunk = input.candidates.slice(offset, offset + Q17_NOUL_CHUNK);
    const keys = chunk.map(keyAt);
    const questions: Record<string, Question> = {};
    const first = offset === 0;
    if (first && choiceCands.length > 0) questions[Q17_CHOICE_ID] = choiceQuestion(choiceCands, choiceKeys);
    for (const k of keys) questions[`${Q17_NOUL_PREFIX}${k}`] = noulQuestion(k);
    assertQuestionBatch(questions);
    requests.push({ state: stateFor(input, chunk, keys), questions, keys, hasChoice: first });
  }
  return { requests, keyOf, idOf, choiceKeys };
}

// ---------------------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------------------

export interface Q17Order {
  /** candidate ids, best first */
  order: string[];
  pChoice: Record<string, number>;
  pEscape: number | null;
  pMax: number | null;
  nouls: Record<string, number>;
  maxNoul: number | null;
  /** P(escape) − p_max ≥ 0.10 ∧ max Noul < 0.3 (routing only) */
  strong: boolean;
  /** exactly one of the two detectors fired (routing only) */
  weak: boolean;
  requests: number;
}

/** The recorded fix-absent signals (§5 Q8–Q10 / Q17): never a gate on whether a candidate runs. */
export function fixAbsentSignals(pEscape: number | null, pMax: number | null, maxNoul: number | null): { strong: boolean; weak: boolean } {
  const escapeFlag = pEscape !== null && pMax !== null && pEscape - pMax >= Q17_STRONG_MARGIN - DETECTOR_EPSILON;
  const noulFlag = maxNoul !== null && maxNoul < Q17_ABSENT_NOUL;
  return { strong: escapeFlag && noulFlag, weak: escapeFlag !== noulFlag };
}

export function readQ17(plan: Q17Plan, answers: readonly Record<string, Answer>[]): Q17Order {
  const pChoice: Record<string, number> = {};
  const nouls: Record<string, number> = {};
  let pEscape: number | null = null;
  plan.requests.forEach((r, i) => {
    const a = answers[i];
    if (a === undefined) return;
    const c = a[Q17_CHOICE_ID];
    if (r.hasChoice && c !== undefined && c.type === 'choice') {
      for (const [k, p] of Object.entries(c.probabilities)) {
        if (k === ESCAPE_KEY) pEscape = p;
        else if (plan.idOf.has(k)) pChoice[plan.idOf.get(k)!] = p;
      }
    }
    for (const k of r.keys) {
      const n = a[`${Q17_NOUL_PREFIX}${k}`];
      if (n !== undefined && n.type === 'noul') nouls[plan.idOf.get(k)!] = n.noul;
    }
  });
  const noulOf = (id: string): number => nouls[id] ?? 0;
  const choiceIds = plan.choiceKeys.map((k) => plan.idOf.get(k)!);
  const restIds = [...plan.keyOf.keys()].filter((id) => !choiceIds.includes(id));
  const order = [...choiceIds.sort((x, y) => (pChoice[y] ?? 0) - (pChoice[x] ?? 0) || noulOf(y) - noulOf(x)), ...restIds.sort((x, y) => noulOf(y) - noulOf(x))];
  const choiceValues = choiceIds.map((id) => pChoice[id]).filter((p): p is number => p !== undefined);
  const pMax = choiceValues.length === 0 ? null : Math.max(...choiceValues);
  const noulValues = Object.values(nouls);
  const maxNoul = noulValues.length === 0 ? null : Math.max(...noulValues);
  const signals = fixAbsentSignals(pEscape, pMax, maxNoul);
  return { order, pChoice, pEscape, pMax, nouls, maxNoul, ...signals, requests: answers.length };
}

/** Ask the plan's requests through `ask` (abort-aware) and read the order; the caller charges the StepBudget with `requests`. */
export async function orderByQ17(input: Q17Input, ask: JevAsk, signal: AbortSignal, stage: StageName = 'propose'): Promise<Q17Order> {
  const plan = buildQ17(input);
  const answers: Record<string, Answer>[] = [];
  for (const r of plan.requests) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    const res = await ask(stage, r.state, r.questions);
    answers.push(res.answers);
  }
  return readQ17(plan, answers);
}
