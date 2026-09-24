/**
 * The one Jev request of the oracle (REPORT-compliant through src/jev/questions.ts): over the
 * blocks code extracted from the issue, three Nouls per block (does it reproduce the bug; does it
 * show the expected behaviour; does it show the wrong behaviour observed), one Choice for the
 * kind of failure (which decides the shape of the pass criterion the runner builds in code), and
 * one Noul per traceback frame (is this frame inside the code that must change, rather than the
 * reporter's script or the test runner) that localisation can use as an anchor.
 *
 * Every option key is descriptive snake_case, every Choice has the `none_of_these` escape and
 * every Noul carries definition + examples on both sides (REPORT rules 3 and 4). Jev decides;
 * `chooseBlocks` only reads the probabilities back with fixed thresholds.
 */
import type { Answer, Json, Question } from '../../../core/types.js';
import { assertQuestionBatch, choice, noul } from '../../../jev/questions.js';
import type { NoulCriteriaSpec } from '../../../jev/questions.js';
import { isTestModule } from './extract.js';
import type { BlockJudgement, CodeBlock, Extraction, FailureKind, FrameJudgement, OracleJudgement, TracebackFrame } from './types.js';

export const FAILURE_KIND_ID = 'failure_kind';
export const IS_REPRODUCTION_PREFIX = 'is_reproduction_';
export const SHOWS_EXPECTED_PREFIX = 'shows_expected_';
export const SHOWS_ACTUAL_PREFIX = 'shows_actual_';
export const FRAME_IN_FIX_PREFIX = 'frame_in_fix_';

/** Frames offered to Jev per issue (pytest-7205 pastes 19; duplicates by file+function are folded first). */
export const MAX_FRAMES = 24;
/** Problem statement chars kept in the state (the blocks are repeated in full beside it). */
export const ISSUE_CHARS_MAX = 12_000;
/** A block is taken as the reproduction / the expected output when its Noul is at least this. */
export const PICK_THRESHOLD = 0.5;

export const FAILURE_KINDS: Record<FailureKind, string> = {
  wrong_value: 'The code runs to completion but returns, prints or renders a wrong value: a wrong number, string, list, SQL, generated code or formatting. Example: `latex(x*y)` printing `x y` where the reporter expects `x \\cdot y`.',
  exception_raised: 'The code raises an exception, assertion or warning-as-error where it should complete normally. Example: `TypeError: Invalid comparison of complex I` from `simplify(cos(x)**I)`.',
  should_raise_but_does_not: 'The code completes silently where it should raise an error or refuse the input. Example: an invalid option accepted without a `ValueError`.',
  wrong_type: 'The result has the wrong type or class, or a wrong C/SQL type is emitted, while the value would otherwise be acceptable. Example: a `list` where a `tuple` is documented, `double x` where `double *x` is needed.',
  performance: 'The code is correct but too slow, loops forever or uses too much memory. Example: a query taking minutes because an index is not used.',
  none_of_these: 'The report asks for a new feature, a documentation change or a design change rather than describing a failing behaviour, or the failure is of another kind.',
};

export const REPRODUCTION_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'the block is Python code or a REPL transcript that, run against the repository at the reported version, exercises the library and shows the wrong behaviour the issue is about',
    examples: ['a `>>>` transcript whose last statement prints the wrong value or raises the reported exception', 'a short script the reporter says fails, with the imports it needs from the library'],
  },
  false: {
    definition: 'the block is not runnable code that triggers the bug: it is printed output, a traceback, a version listing, a shell command, the fix the reporter proposes, or code that works correctly',
    examples: ['a `pip list` or `--version` listing', 'the counterexample the reporter shows working fine, or generated C/SQL output rather than the code that produced it'],
  },
};

export const SHOWS_EXPECTED_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'the block shows the output, value or behaviour the reporter considers correct (what a fixed library would produce)',
    examples: ['a REPL transcript where the shown value is the one the reporter says should appear', 'a block the text introduces with "should be", "expected", "works" or "correct"'],
  },
  false: {
    definition: 'the block shows the wrong behaviour, or shows no output at all (only code, commands or a traceback of the bug)',
    examples: ['a traceback of the reported exception', 'a snippet with no printed values'],
  },
};

export const SHOWS_ACTUAL_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'the block shows the wrong behaviour the reporter observed: the wrong value printed, the traceback raised, the message emitted',
    examples: ['a REPL transcript whose shown value the text calls wrong', 'a traceback ending in the reported exception'],
  },
  false: {
    definition: 'the block shows correct behaviour, or shows no output at all',
    examples: ['the output the reporter says is expected', 'a snippet with no printed values'],
  },
};

export const FRAME_IN_FIX_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'the frame is a function of the library under repair whose code must change (or whose caller in the library must change) to fix the issue',
    examples: ['the innermost library frame where a wrong comparison raised', 'the library function that formats the value wrongly'],
  },
  false: {
    definition: 'the frame belongs to the reporter\'s own script or test, to the interpreter, to the test runner or to a dependency, or is deep library plumbing that merely forwarded the call',
    examples: ['`File "<stdin>", line 1, in <module>`', 'a `pluggy` hook dispatcher frame or `runner.py` calling a hook'],
  },
};

export interface OracleQuestionSet {
  state: Json;
  questions: Record<string, Question>;
  /** block indices offered, in the order of `blocks.block_<i>` */
  blockIndices: number[];
  /** frames offered, index → frame */
  frames: TracebackFrame[];
}

export interface OracleQuestionInput {
  repository: string;
  problemStatement: string;
  extraction: Extraction;
}

/** Fold duplicate (file, function) frames, drop the reporter's REPL frames, keep the innermost up to MAX_FRAMES. */
export function framesToOffer(extraction: Extraction, max = MAX_FRAMES): TracebackFrame[] {
  const seen = new Set<string>();
  const out: TracebackFrame[] = [];
  for (const tb of extraction.tracebacks) {
    for (const f of tb.frames) {
      if (/^<(stdin|input|string|ipython[^>]*|console)>$/i.test(f.file)) continue;
      const key = `${f.file}::${f.fn ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  // innermost frames carry the failure; when too many, keep the tail of each traceback's order
  return out.length > max ? out.slice(out.length - max) : out;
}

function blockView(b: CodeBlock): Json {
  const view: Record<string, Json> = { kind: b.kind, found_as: b.origin === 'fence' ? 'fenced code block' : b.origin === 'indent' ? 'indented block' : 'bare lines', text: b.text };
  if (b.lang !== null) view['language_tag'] = b.lang;
  if (b.repl !== undefined) view['statements'] = b.repl.statements.map((s) => ({ source: s.source, shown: s.shown }));
  if (b.tracebacks.length > 0) view['exceptions'] = b.tracebacks.map((t) => (t.message === '' ? t.exceptionType : `${t.exceptionType}: ${t.message}`));
  return view;
}

/** Build the state and the question batch (one request); throws QuestionBuildError on a malformed batch. */
export function oracleQuestions(input: OracleQuestionInput): OracleQuestionSet {
  const blocks = input.extraction.blocks;
  const frames = framesToOffer(input.extraction);
  const blocksState: Record<string, Json> = {};
  for (const b of blocks) blocksState[`block_${b.index}`] = blockView(b);
  const framesState: Record<string, Json> = {};
  frames.forEach((f, k) => {
    const v: Record<string, Json> = { file: f.file, line: f.line, function: f.fn ?? '<module>' };
    if (f.code !== null) v['code'] = f.code;
    framesState[`frame_${k}`] = v;
  });
  const state: Record<string, Json> = {
    issue: { repository: input.repository, problem_statement: input.problemStatement.slice(0, ISSUE_CHARS_MAX) },
    blocks: blocksState,
  };
  if (frames.length > 0) state['frames'] = framesState;
  const questions: Record<string, Question> = {};
  for (const b of blocks) {
    const ref = `\`blocks.block_${b.index}\``;
    questions[`${IS_REPRODUCTION_PREFIX}${b.index}`] = noul(`Does ${ref} reproduce the reported bug when run against the repository \`issue.repository\`? Read the code and \`issue.problem_statement\`; answer literally about this block, not about the issue as a whole.`, REPRODUCTION_CRITERIA);
    questions[`${SHOWS_EXPECTED_PREFIX}${b.index}`] = noul(`Does ${ref} show the output the reporter expected (the correct behaviour)?`, SHOWS_EXPECTED_CRITERIA);
    questions[`${SHOWS_ACTUAL_PREFIX}${b.index}`] = noul(`Does ${ref} show the wrong behaviour the reporter observed?`, SHOWS_ACTUAL_CRITERIA);
  }
  questions[FAILURE_KIND_ID] = choice('Read `issue.problem_statement` and `blocks`. Which kind of failure does the reporter observe when the reproduction is run against the current code? Judge the observed behaviour, not the fix.', FAILURE_KINDS);
  frames.forEach((_, k) => {
    questions[`${FRAME_IN_FIX_PREFIX}${k}`] = noul(`Is \`frames.frame_${k}\` inside the code that must change to fix \`issue\` (not the reporter's own script, the interpreter, a dependency or the test runner)?`, FRAME_IN_FIX_CRITERIA);
  });
  assertQuestionBatch(questions);
  return { state, questions, blockIndices: blocks.map((b) => b.index), frames };
}

function noulOf(answers: Record<string, Answer>, id: string): number {
  const a = answers[id];
  return a !== undefined && a.type === 'noul' ? a.noul : 0;
}

/** Read the answers of one request back into a judgement (missing answers read as 0 / escape). */
export function readOracleAnswers(set: OracleQuestionSet, answers: Record<string, Answer>): OracleJudgement {
  const blocks: BlockJudgement[] = set.blockIndices.map((index) => ({
    index,
    isReproduction: noulOf(answers, `${IS_REPRODUCTION_PREFIX}${index}`),
    showsExpected: noulOf(answers, `${SHOWS_EXPECTED_PREFIX}${index}`),
    showsActual: noulOf(answers, `${SHOWS_ACTUAL_PREFIX}${index}`),
  }));
  const kindAnswer = answers[FAILURE_KIND_ID];
  let failureKind: FailureKind = 'none_of_these';
  let failureKindProbabilities: Record<string, number> = {};
  if (kindAnswer !== undefined && kindAnswer.type === 'choice') {
    failureKindProbabilities = kindAnswer.probabilities;
    if (isFailureKind(kindAnswer.choice)) failureKind = kindAnswer.choice;
  }
  const frames: FrameJudgement[] = set.frames.map((frame, index) => ({ index, frame, inFix: noulOf(answers, `${FRAME_IN_FIX_PREFIX}${index}`) }));
  return { blocks, failureKind, failureKindProbabilities, frames, requests: 1 };
}

export function isFailureKind(s: string): s is FailureKind {
  return s in FAILURE_KINDS;
}

export interface BlockChoice {
  /** the block to run: highest `is_reproduction` among runnable blocks at or above PICK_THRESHOLD, else null */
  reproduction: CodeBlock | null;
  /** the block whose shown values are the expected output: highest `shows_expected` at or above the threshold */
  expected: CodeBlock | null;
  /** the block whose shown values are the observed wrong output */
  actual: CodeBlock | null;
  /** frames with P(in fix) at or above the threshold, most probable first */
  anchors: FrameJudgement[];
}

/** A block runner.ts can execute as statements: code or a REPL transcript that is not a test module. */
export function isRunnable(block: CodeBlock): boolean {
  return (block.kind === 'code' || block.kind === 'repl') && !(block.kind === 'code' && isTestModule(block.text));
}

/** Probabilities within this band of the maximum are a tie (Jev's noise band is ±0.02; verify/questions uses the same margin). */
export const TIE_MARGIN = 0.05;

function lastStatementOf(block: CodeBlock): string {
  if (block.repl !== undefined) return block.repl.statements.at(-1)?.source ?? '';
  return block.text.trim().split('\n').at(-1) ?? '';
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.match(/[A-Za-z_]\w*/g) ?? []);
  const tb = new Set(b.match(/[A-Za-z_]\w*/g) ?? []);
  if (ta.size === 0 || tb.size === 0) return 0;
  let n = 0;
  for (const t of ta) if (tb.has(t)) n++;
  return n / Math.max(ta.size, tb.size);
}

/**
 * Code reading of the judgement with fixed thresholds; runnable = a code or REPL block. Among
 * reproduction candidates tied within TIE_MARGIN of the best, the one whose last statement shares
 * the most identifiers with the expected block's statement wins (sympy-20428: `bad_poly.rep` pairs
 * with `Poly(0, x, domain="EX").rep`, not with the `is_zero` transcript).
 */
export function chooseBlocks(extraction: Extraction, judgement: OracleJudgement, threshold = PICK_THRESHOLD): BlockChoice {
  const byIndex = new Map(extraction.blocks.map((b) => [b.index, b]));
  const candidates = (score: (j: BlockJudgement) => number, runnableOnly: boolean): { block: CodeBlock; p: number }[] => {
    const out: { block: CodeBlock; p: number }[] = [];
    for (const j of judgement.blocks) {
      const block = byIndex.get(j.index);
      if (block === undefined) continue;
      if (runnableOnly && !isRunnable(block)) continue;
      const p = score(j);
      if (p >= threshold) out.push({ block, p });
    }
    return out.sort((a, b) => b.p - a.p || a.block.index - b.block.index);
  };
  const expected = candidates((j) => j.showsExpected, false)[0]?.block ?? null;
  const actual = candidates((j) => j.showsActual, false)[0]?.block ?? null;
  const repros = candidates((j) => j.isReproduction, true);
  let reproduction = repros[0]?.block ?? null;
  if (repros.length > 1 && expected !== null && expected.index !== reproduction?.index) {
    const top = repros[0]!.p;
    const tied = repros.filter((r) => top - r.p <= TIE_MARGIN && r.block.index !== expected.index);
    const target = lastStatementOf(expected);
    let best = tied[0];
    for (const r of tied) if (best !== undefined && tokenOverlap(lastStatementOf(r.block), target) > tokenOverlap(lastStatementOf(best.block), target)) best = r;
    reproduction = best?.block ?? reproduction;
  }
  return {
    reproduction,
    expected,
    actual,
    anchors: judgement.frames.filter((f) => f.inFix >= threshold).sort((a, b) => b.inFix - a.inFix),
  };
}
