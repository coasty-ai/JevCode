/**
 * Question builders enforcing the REPORT.md rules (DESIGN.md §5.4): criteria as
 * definition + examples on both sides, every Choice with an escape option and a paired Noul
 * per option, descriptive option keys, Score levels as situations (2..10 levels).
 */
import type { Json, Question } from '../core/types.js';

export const ESCAPE_KEY = 'none_of_these';
export const PAIRED_PREFIX = 'can_';

export interface CriteriaSide {
  definition: string;
  examples: string[];
}
export interface NoulCriteriaSpec {
  true: CriteriaSide;
  false: CriteriaSide;
}

/** Option keys that carry a name prior (REPORT §10): single letters, alpha/beta, bare numbers. */
const BAD_KEY = /^([a-z]|alpha|beta|gamma|option_?[a-z0-9]+|\d+)$/i;
const KEY_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;

export class QuestionBuildError extends Error {
  constructor(message: string) {
    super(`QuestionBuildError: ${message}`);
    this.name = 'QuestionBuildError';
  }
}

function checkSide(side: CriteriaSide, which: 'true' | 'false'): void {
  if (!side.definition || side.definition.trim().length === 0) throw new QuestionBuildError(`criteria.${which}.definition is empty`);
  if (!Array.isArray(side.examples) || side.examples.length < 2) throw new QuestionBuildError(`criteria.${which}.examples needs at least two examples`);
}

/** A Noul with both-sided definition + examples criteria (rule 4). */
export function noul(instructions: Json, criteria: NoulCriteriaSpec): Question {
  if (instructions === '' || instructions === null) throw new QuestionBuildError('noul instructions are empty');
  checkSide(criteria.true, 'true');
  checkSide(criteria.false, 'false');
  return {
    type: 'noul',
    instructions,
    criteria: {
      true: { definition: criteria.true.definition, examples: criteria.true.examples },
      false: { definition: criteria.false.definition, examples: criteria.false.examples },
    },
  };
}

/** Context-stage exception (§5.5): instructions only, criteria live once in the state. */
export function contextNoul(instructions: Json): Question {
  if (instructions === '' || instructions === null) throw new QuestionBuildError('noul instructions are empty');
  return { type: 'noul', instructions };
}

export interface ChoiceOptions {
  /** escape option key (default none_of_these) */
  escape?: string;
}

/** A Choice with descriptive keys and a guaranteed escape option (rule 3). */
export function choice(instructions: Json, options: Record<string, Json | null>, opts: ChoiceOptions = {}): Question {
  const escape = opts.escape ?? ESCAPE_KEY;
  const keys = Object.keys(options);
  if (keys.length === 0) throw new QuestionBuildError('choice needs at least one option');
  for (const k of keys) {
    if (!KEY_SHAPE.test(k)) throw new QuestionBuildError(`option key "${k}" must be snake_case ascii, 2..64 chars`);
    if (BAD_KEY.test(k)) throw new QuestionBuildError(`option key "${k}" carries a name prior; use a descriptive word`);
  }
  const criteria: Record<string, Json | null> = { ...options };
  if (!(escape in criteria)) criteria[escape] = null;
  if (Object.keys(criteria).length > 255) throw new QuestionBuildError('choice has more than 255 options');
  return { type: 'choice', instructions, criteria };
}

/** A Score over 2..10 situation-described levels (rule 8: one quantity per Score). */
export function score(instructions: Json, levels: Json[]): Question {
  if (levels.length < 2 || levels.length > 10) throw new QuestionBuildError(`score needs 2..10 levels, got ${levels.length}`);
  for (const [i, l] of levels.entries()) {
    if (l === null || l === '' ) throw new QuestionBuildError(`score level ${i} is empty`);
  }
  return { type: 'score', instructions, criteria: levels };
}

/** Paired Nouls `can_<option>` for every non-escape option of a Choice (rule 3). */
export function pairedNouls(
  options: Record<string, string>,
  build: (option: string, description: string) => { instructions: Json; criteria: NoulCriteriaSpec },
  escape: string = ESCAPE_KEY,
): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const [opt, desc] of Object.entries(options)) {
    if (opt === escape) continue;
    const spec = build(opt, desc);
    out[`${PAIRED_PREFIX}${opt}`] = noul(spec.instructions, spec.criteria);
  }
  return out;
}

/** Validate a batch before sending: unique non-empty ids, ≤ 1000 questions. */
export function assertQuestionBatch(qs: Record<string, Question>): void {
  const ids = Object.keys(qs);
  if (ids.length === 0) throw new QuestionBuildError('a request needs at least one question');
  if (ids.length > 1000) throw new QuestionBuildError(`too many questions in one request: ${ids.length}`);
  for (const id of ids) if (id.trim().length === 0) throw new QuestionBuildError('empty question id');
}

/** Backticked path reference for instructions (rule 2). */
export function ref(path: string): string {
  return `\`${path}\``;
}
