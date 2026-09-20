/**
 * Question wordings and state shapes of the four localisation stages. Each is the shape that
 * was measured to work, reused verbatim where the contract allows:
 *   files      — experiments/results/probe-swebench-understanding.md Q6 (repo-wide Nouls, criteria once in the state)
 *   confirm    — Q3 (Nouls over files with top-level symbol outlines)
 *   functions  — Q2 (Choice over `file.functions`, module-level option, descriptions in the state)
 *   lines      — experiments/results/probe-localization.md variant D (Choice over lines with the
 *                tests and what the buggy program actually did on one failing test)
 * `issue` in the measured wordings becomes `task` here because the synthesizer receives a task,
 * not a GitHub issue. Every Choice gets its escape from choice(); every criteria'd Noul carries
 * definition + examples (REPORT §11); every reference is a backticked path (REPORT §14).
 */
import type { Json, Question } from '../../core/types.js';
import { choice, contextNoul, noul } from '../../jev/questions.js';
import type { FailureView } from '../types.js';
import { FAILURE_FIELD_CHARS_MAX, LINE_CHARS_MAX, TASK_CHARS_MAX, TRACEBACK_CHARS_MAX, clip, clipTail } from './budget.js';
import { lineKey } from './keys.js';
import type { CodeLine } from './outline.js';
import { MODULE_LEVEL_KEY } from './types.js';

// ---------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------

/** Bounded failing-test views for the file/function stages (id, call, expected, actual). */
export function failureViews(failures: readonly FailureView[], max: number): Json[] {
  return failures.slice(0, max).map((f) => ({
    test: clip(f.testId, FAILURE_FIELD_CHARS_MAX),
    call: clip(f.call, FAILURE_FIELD_CHARS_MAX),
    expected: clip(f.expected, FAILURE_FIELD_CHARS_MAX),
    actual: clip(f.actual, FAILURE_FIELD_CHARS_MAX),
  }));
}

/** Common head of the file/function states: the task, the failing tests and the traceback tail. */
function evidenceHead(task: string, failures: readonly FailureView[], traceback: string | undefined, maxTests: number): Record<string, Json> {
  const head: Record<string, Json> = { task: clip(task, TASK_CHARS_MAX) };
  if (failures.length > 0) head['failing_tests'] = failureViews(failures, maxTests);
  if (traceback !== undefined && traceback.trim() !== '') head['traceback'] = clipTail(traceback, TRACEBACK_CHARS_MAX);
  return head;
}

// ---------------------------------------------------------------------------------------
// Stage 1: files (Q6)
// ---------------------------------------------------------------------------------------

/** Criteria live once in the state (DESIGN §5.5 context-Noul exception), as measured in Q6. */
export const FILE_CRITERIA: Json = {
  yes_when: 'the code change that accomplishes the task lands in this file: it defines the function, class, table or constant whose behaviour the task or the failing tests describe as wrong or missing',
  no_when: 'the file merely imports, calls or tests the code that is changed elsewhere, or is unrelated to the symptoms',
};

export interface FileStageRequest {
  state: Json;
  questions: Record<string, Question>;
  /** question id -> path (ids are invisible to the model, REPORT §7; the path itself is the id) */
  paths: string[];
}

export function fileStage(task: string, failures: readonly FailureView[], traceback: string | undefined, paths: readonly string[], maxTests: number): FileStageRequest {
  const state: Json = { ...evidenceHead(task, failures, traceback, maxTests), criteria: FILE_CRITERIA, files: [...paths] };
  const questions: Record<string, Question> = {};
  for (const p of paths) questions[p] = contextNoul(`Must the file \`${p}\` (listed in \`files\`) be modified to accomplish \`task\`? Apply \`criteria\`.`);
  return { state, questions, paths: [...paths] };
}

// ---------------------------------------------------------------------------------------
// Stage 2: confirmation with outlines (Q3)
// ---------------------------------------------------------------------------------------

export function confirmStage(task: string, failures: readonly FailureView[], traceback: string | undefined, outlines: ReadonlyMap<string, readonly string[]>, maxTests: number): FileStageRequest {
  const files: Record<string, Json> = {};
  for (const [p, symbols] of outlines) files[p] = { top_level_symbols: [...symbols] };
  const state: Json = { ...evidenceHead(task, failures, traceback, maxTests), files };
  const questions: Record<string, Question> = {};
  for (const p of outlines.keys()) {
    questions[p] = noul(`Must the file \`files["${p}"]\` be modified to accomplish \`task\`? Answer yes only if the code change that accomplishes the task lands in this file.`, {
      true: { definition: 'the change edits code in this file', examples: ['the file defines the function whose wrong behaviour the failing test or the task describes', 'the file holds the table or constant the change must extend'] },
      false: { definition: 'the change does not touch this file', examples: ['the file merely imports or calls the code that is changed elsewhere', 'the file is unrelated to the symptoms in the task and the failing tests'] },
    });
  }
  return { state, questions, paths: [...outlines.keys()] };
}

// ---------------------------------------------------------------------------------------
// Stage 3: functions (Q2)
// ---------------------------------------------------------------------------------------

export const FUNCTION_QUESTION_ID = 'where';
export const MODULE_LEVEL_DESCRIPTION = 'code at module level: imports, constants, tables, class attributes; not inside any function or method';

export interface FunctionOption {
  key: string;
  /** "method Point.distance, line 266: def distance(self, p):" */
  description: string;
}

export function functionStage(task: string, failures: readonly FailureView[], traceback: string | undefined, path: string, options: readonly FunctionOption[], maxTests: number): { state: Json; questions: Record<string, Question> } {
  const functions: Record<string, Json> = {};
  for (const o of options) functions[o.key] = o.description;
  functions[MODULE_LEVEL_KEY] = MODULE_LEVEL_DESCRIPTION;
  const state: Json = { ...evidenceHead(task, failures, traceback, maxTests), file: { path, functions } };
  // Descriptions live in the state; the options are the keys (as measured in Q2 and the anchor probe).
  const keys: Record<string, Json | null> = {};
  for (const k of Object.keys(functions)) keys[k] = null;
  const q = choice(
    `\`file\` is the source file that must be edited to accomplish \`task\`. Which entry of \`file.functions\` must be modified (its body changed, or new code inserted directly into it) to accomplish the task? If the change is code outside every function, pick \`${MODULE_LEVEL_KEY}\`.`,
    keys,
  );
  return { state, questions: { [FUNCTION_QUESTION_ID]: q } };
}

// ---------------------------------------------------------------------------------------
// Stage 4: lines (variant D)
// ---------------------------------------------------------------------------------------

export const LINE_QUESTION_ID = 'buggy_line';
export const LINE_QUESTION = 'Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty.';
export const FAILING_RUN_SUFFIX = ' `failing_test_run` shows what the buggy program actually did on one failing test.';

export interface LineStageInput {
  task: string;
  failures: readonly FailureView[];
  traceback: string | undefined;
  lines: readonly CodeLine[];
  /** set when the listing is one function of a larger file (absent on the single-file flat path) */
  where?: { file: string; function: string };
  maxTests: number;
}

/**
 * Variant D state: `program` keyed `L<k>` by original line number, `tests` (call + expected),
 * `failing_test_run` (the first failing test with its actual outcome). The measured probe had
 * typed `input` arrays; FailureView carries the call as text, so `call` stands where `input` was.
 * `level` shrinks the state for fitToCap: 1 drops the traceback, 2 keeps one test.
 */
export function lineStage(input: LineStageInput, level = 0): { state: Json; questions: Record<string, Question> } {
  const program: Record<string, Json> = {};
  const options: Record<string, Json | null> = {};
  for (const l of input.lines) {
    program[`L${l.line}`] = clip(l.text, LINE_CHARS_MAX);
    options[lineKey(l.line)] = clip(l.text, LINE_CHARS_MAX);
  }
  const shown = input.failures.slice(0, level >= 2 ? 1 : input.maxTests);
  const first = input.failures[0];
  const state: Record<string, Json> = {
    task: clip(input.task, TASK_CHARS_MAX) + (first === undefined ? '' : FAILING_RUN_SUFFIX),
    program,
  };
  if (input.where !== undefined) {
    state['file'] = input.where.file;
    state['function'] = input.where.function;
  }
  if (shown.length > 0) state['tests'] = shown.map((f) => ({ call: clip(f.call, FAILURE_FIELD_CHARS_MAX), expected: clip(f.expected, FAILURE_FIELD_CHARS_MAX) }));
  if (first !== undefined) state['failing_test_run'] = { call: clip(first.call, FAILURE_FIELD_CHARS_MAX), expected: clip(first.expected, FAILURE_FIELD_CHARS_MAX), actual: clip(first.actual, FAILURE_FIELD_CHARS_MAX) };
  if (level < 1 && input.traceback !== undefined && input.traceback.trim() !== '') state['traceback'] = clipTail(input.traceback, TRACEBACK_CHARS_MAX);
  return { state, questions: { [LINE_QUESTION_ID]: choice(LINE_QUESTION, options) } };
}
