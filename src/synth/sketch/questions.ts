/**
 * Q12 `sketch` and Q7 `edit_class` for one site, asked in one request (docs/JEV-ONLY-DESIGN.md
 * §2.7; wording verbatim from experiments/designs/grammar-synthesis.md Appendix A, script
 * experiments/grammar-synthesis/sketch-probe.mts). Code builds the option set from the pool
 * (opaque keys `sketch_aa`…, description `{ shape, change }`: probe-question-design §3 found
 * opaque keys with descriptions fine and code-slug keys worse), Jev picks, and `keepK` turns the
 * answer into the K hypotheses the slot beam fills.
 *
 * Measured (Appendix A, three runs): sketch top-1 23–26/40, top-3 29–31/40, top-5 32–33/40 at
 * $0.00019 and 238 ms per request; edit_class top-1 28–29/40, top-2 35–36/40, hence a soft
 * order only, never a filter. Calibration: P(top) ≥ 0.5 on 27 programs → top-3 25/27; P(top)
 * < 0.5 on 13 → top-3 4/13, which is the K = 5 widening rule.
 */
import type { Answer, Json, Question } from '../../core/types.js';
import { ESCAPE_KEY, choice } from '../../jev/questions.js';
import type { SketchHypothesis } from '../search/types.js';
import { MARK, baseState } from '../beam/state.js';
import type { FailureView, Site } from '../types.js';
import { hasChange, sketchText } from './pool.js';
import { EDIT_CLASS_IDS, PRODUCTION_IDS, editClassesOf } from './productions.js';
import type { EditClass, ProductionId } from './productions.js';

export const SKETCH_QUESTION_ID = 'sketch';
export const EDIT_CLASS_QUESTION_ID = 'edit_class';

/** Measured Q12 wording (Appendix A.1), verbatim. */
export const SKETCH_INSTRUCTIONS = `Each option is a sketch of the corrected line for the \`${MARK}\` marker in \`program\`. In a sketch, \`_\` stands for one identifier, number, string or True/False/None still to be chosen, \`<op>\` stands for one operator still to be chosen, and every other token is shown literally. Which sketch is the shape of the correct replacement line, so that with the right tokens in its holes every entry of \`tests\` passes? Read the sketches literally and compare them with \`buggy_line\`. Choose \`none_of_these\` if no listed sketch fits the correct line.`;

/** Measured Q7 wording (Appendix A.1), verbatim. */
export const EDIT_CLASS_INSTRUCTIONS = `Which kind of edit turns \`buggy_line\` into the correct line for the \`${MARK}\` marker in \`program\`, so that every entry of \`tests\` passes? Judge the edit that would be written. Answer carefully and literally.`;

/** Measured Q7 options: definition + two examples each (Appendix A.1), verbatim. */
export const EDIT_CLASSES: Readonly<Record<EditClass, string>> = {
  substitute_one_token: 'one token of `buggy_line` is wrong and must be replaced by another of the same kind (a name, a literal or an operator); the line keeps its length. Example: `while lo <= hi` -> `while lo < hi`; `enumerate(arr)` -> `enumerate(counts)`',
  insert_fragment: 'every token of `buggy_line` stays and a fragment is added: an extra term, index, slice, argument or condition. Example: `mid` -> `mid + 1`; `arr` -> `arr[k:]`; `if total < 0` -> `if total < 0 or not coins`; `x + y` -> `max(0, x + y)`',
  delete_fragment: 'tokens are removed from `buggy_line` and nothing is added. Example: `return 1 + f(x)` -> `return f(x)`; `yield flatten(x)` -> `yield x`',
  reorder_tokens: 'the same tokens in a different order: swapped arguments, operands or indices. Example: `gcd(a % b, b)` -> `gcd(b, a % b)`; `perm[j] < perm[i]` -> `perm[i] < perm[j]`',
  reshape_line: 'the line is restructured in a way not covered above (several coordinated changes). Example: `xs[a].update(ys[b])` -> `xs[a] = ys[b]`',
  insert_new_line: '`buggy_line` is not wrong; a statement is missing and a new line must be inserted at the marker',
};

/** K when the sketch Choice is confident (Appendix A: P(top) ≥ 0.5 → top-3 holds 25/27). */
export const KEEP_BASE = 3;
/** K when it is not (P(top) < 0.5 → top-3 only 4/13; top-5 32–33/40 overall). */
export const KEEP_WIDE = 5;
/** Widening rule thresholds (grammar-synthesis §1.2 and §1.5: "P(top) < 0.5 or P(escape) ≥ 0.3 → K = 5"). */
export const LOW_CONFIDENCE_P_TOP = 0.5;
export const HIGH_ESCAPE_P = 0.3;
/** Edit classes used as the soft order prior: top-2 covers 35–36/40 (Appendix A). */
export const TOP_EDIT_CLASSES = 2;
/**
 * Choice probabilities arrive as two-decimal values whose sum is 1 up to rounding, so a measured
 * "0.50" or "0.30" can read 0.4999999999 or 0.2999999999; the tolerance makes the rule fire as
 * the pilot counted it (rank/index.ts DETECTOR_EPSILON does the same for its margin).
 */
export const RULE_EPSILON = 1e-9;

/** `sketch_aa`, `sketch_ab`, … (254 ≤ 26 × 26): the measured opaque keys. */
export function sketchOptionKey(i: number): string {
  return `sketch_${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
}

export interface SketchContext {
  /** the user's task text (kept in the state as `goal`; the measured `task` sentence is code-built) */
  task: string;
  failures: readonly FailureView[];
  /** include Q7 in the request (default true); false when the controller already asked it alone this step */
  withEditClass?: boolean;
}

export interface SketchRequest {
  state: Json;
  questions: Record<string, Question>;
  /** option key → hypothesis, in pool order */
  byKey: Map<string, SketchHypothesis>;
}

/** Fallback `change` text when a hypothesis reaches the questions without its pool description. */
function changeOf(h: SketchHypothesis): string {
  return hasChange(h) ? h.change : `shape from production ${h.production}`;
}

/**
 * The Q12 + Q7 request for a site. `pool` is `sketchPool(site, opts)` (≤ 254, deduplicated).
 * Q7 is asked at every site kind: at an insert site `buggy_line` is null and the measured task
 * sentence says a line must be inserted, so `insert_new_line` is the literal answer there.
 */
export function sketchQuestions(site: Site, pool: readonly SketchHypothesis[], ctx: SketchContext): SketchRequest {
  if (pool.length === 0) throw new RangeError('sketchQuestions: the pool is empty');
  if (pool.length > 254) throw new RangeError(`sketchQuestions: ${pool.length} sketches exceed the 254-option cap`);
  const options: Record<string, Json> = {};
  const byKey = new Map<string, SketchHypothesis>();
  pool.forEach((h, i) => {
    const key = sketchOptionKey(i);
    options[key] = { shape: sketchText(h), change: changeOf(h) };
    byKey.set(key, h);
  });
  const questions: Record<string, Question> = { [SKETCH_QUESTION_ID]: choice(SKETCH_INSTRUCTIONS, options) };
  if (ctx.withEditClass ?? true) questions[EDIT_CLASS_QUESTION_ID] = editClassQuestion();
  return { state: baseState(site, ctx.task, ctx.failures), questions, byKey };
}

/** The Q7 Choice on its own (the controller asks it alone when no sketch round runs). */
export function editClassQuestion(): Question {
  const editOptions: Record<string, Json> = {};
  for (const c of EDIT_CLASS_IDS) editOptions[c] = EDIT_CLASSES[c];
  return choice(EDIT_CLASS_INSTRUCTIONS, editOptions);
}

/** Option key → hypothesis for a pool, as `sketchQuestions` assigns them (positional `sketch_aa`…). */
export function optionMap(pool: readonly SketchHypothesis[]): Map<string, SketchHypothesis> {
  return new Map(pool.map((h, i) => [sketchOptionKey(i), h]));
}

export interface KeepResult {
  /** top-K hypotheses with `pSketch` set, reordered so the top-2 edit classes come first */
  kept: SketchHypothesis[];
  k: number;
  /** highest non-escape sketch probability */
  pTop: number;
  pEscape: number;
  /** the widening rule fired (K = 5) */
  widened: boolean;
  /** Q7 classes best first (empty when that answer was not given) */
  editClasses: EditClass[];
}

/** K = 3, or 5 when the Choice is unsure of its top pick or leans to the escape. */
export function keepCount(pTop: number, pEscape: number): number {
  return pTop < LOW_CONFIDENCE_P_TOP - RULE_EPSILON || pEscape >= HIGH_ESCAPE_P - RULE_EPSILON ? KEEP_WIDE : KEEP_BASE;
}

function rankedNonEscape(a: Extract<Answer, { type: 'choice' }>): [string, number][] {
  return Object.entries(a.probabilities)
    .filter(([k, p]) => k !== ESCAPE_KEY && Number.isFinite(p))
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

function isProductionId(s: string): s is ProductionId {
  return (PRODUCTION_IDS as readonly string[]).includes(s);
}
function isEditClass(s: string): s is EditClass {
  return (EDIT_CLASS_IDS as readonly string[]).includes(s);
}

/**
 * Stable reorder: hypotheses whose production belongs to one of `top` classes first (keeping
 * their sketch-probability order), then the rest. Nothing is dropped: the prior is soft
 * (Appendix A.4 §3; kind Choices are 53–75 % elsewhere, hence "never a gate").
 */
export function orderByEditClass(hyps: readonly SketchHypothesis[], top: readonly EditClass[], siteKind: Site['kind']): SketchHypothesis[] {
  if (top.length === 0) return [...hyps];
  const fits = (h: SketchHypothesis): boolean => isProductionId(h.production) && editClassesOf(h.production, siteKind).some((c) => top.includes(c));
  return [...hyps.filter(fits), ...hyps.filter((h) => !fits(h))];
}

/**
 * Consume the answers of a `sketchQuestions` request (or of the pool it was built from: the
 * option keys are positional). The escape never stops the search: at P(escape) ≥ 0.3 it widens
 * K instead (Appendix A.4 §2) and the controller decides what to do with the kept set.
 */
export function keepK(answers: Record<string, Answer>, source: SketchRequest | readonly SketchHypothesis[]): KeepResult {
  const request: Pick<SketchRequest, 'byKey'> = Array.isArray(source) ? { byKey: optionMap(source) } : (source as SketchRequest);
  const sketch = answers[SKETCH_QUESTION_ID];
  if (sketch === undefined || sketch.type !== 'choice') throw new TypeError(`keepK: expected a choice answer for "${SKETCH_QUESTION_ID}"`);
  const ranked = rankedNonEscape(sketch);
  const pTop = ranked[0]?.[1] ?? 0;
  const pEscape = sketch.probabilities[ESCAPE_KEY] ?? 0;
  const k = keepCount(pTop, pEscape);
  const kept: SketchHypothesis[] = [];
  for (const [key, p] of ranked) {
    if (kept.length >= k) break;
    const h = request.byKey.get(key);
    if (h === undefined) throw new TypeError(`keepK: the answer names an option that was not offered: ${key}`);
    kept.push({ ...h, pSketch: p });
  }
  const edit = answers[EDIT_CLASS_QUESTION_ID];
  const editClasses: EditClass[] = edit !== undefined && edit.type === 'choice' ? rankedNonEscape(edit).map(([c]) => c).filter(isEditClass) : [];
  const first = kept[0];
  const ordered = first === undefined ? kept : orderByEditClass(kept, editClasses.slice(0, TOP_EDIT_CLASSES), first.site.kind);
  return { kept: ordered, k, pTop, pEscape, widened: k === KEEP_WIDE, editClasses };
}
