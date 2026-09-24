/**
 * Types of the oracle-from-the-issue (docs/JEV-ONLY-DESIGN.md §1–§2: the search needs goals =
 * failing behaviours with an oracle; SWE-bench hands the agent an issue text and no failing
 * test, so every jev-only SWE run ended with an empty patch — bench/results/jev-only-swebench-1).
 * Code extracts candidate reproduction snippets from the issue, Jev judges which one reproduces
 * the bug and which shows the expected behaviour, code turns the pick into a runnable script
 * with a pass criterion, and goal.ts presents the result to the search as one failing test.
 */

// ---------------------------------------------------------------------------------------
// Extraction (extract.ts, pure code)
// ---------------------------------------------------------------------------------------

/** What a block contains: runnable code, a REPL transcript, a traceback, or printed output / other text. */
export type BlockKind = 'code' | 'repl' | 'traceback' | 'output';
/** Where the block was found: a markdown fence, a markdown indented block, or bare lines that read as code. */
export type BlockOrigin = 'fence' | 'indent' | 'bare';

export interface TracebackFrame {
  file: string;
  line: number;
  fn: string | null;
  /** the source line printed under the frame, when any */
  code: string | null;
}

export interface Traceback {
  /** outermost first, as Python prints them; empty for a bare `ExcType: message` line */
  frames: TracebackFrame[];
  exceptionType: string;
  message: string;
  /** python: `Traceback (most recent call last):`; pytest: `path:NN: in fn` frames + `E   ExcType: …`; line: a bare exception line */
  style: 'python' | 'pytest' | 'line';
}

export interface ReplStatement {
  /** one statement, continuation lines joined with '\n', prompts removed */
  source: string;
  /** printed output shown after the statement (trailing whitespace trimmed), null when none */
  shown: string | null;
  /** the traceback shown for the statement, when `shown` is one */
  traceback: Traceback | null;
}

export interface ReplTranscript {
  statements: ReplStatement[];
  /** `>>>` (Python) or `In [n]:` (IPython) */
  prompt: 'python' | 'ipython';
}

export interface CodeBlock {
  /** position in `Extraction.blocks` (the `blocks[i]` the questions refer to) */
  index: number;
  kind: BlockKind;
  origin: BlockOrigin;
  /** fence info string (`python`, `shell`, …) or null */
  lang: string | null;
  /** block text without fence markers, common indentation removed */
  text: string;
  /** 1-based line span in the task text */
  startLine: number;
  endLine: number;
  /** present when kind === 'repl' */
  repl?: ReplTranscript;
  /** the tracebacks printed inside the block (a traceback block has one; a REPL may have several) */
  tracebacks: Traceback[];
}

export type ExpectationPattern = 'expected' | 'should' | 'instead_of' | 'but_got' | 'returns' | 'raises';

/** One sentence of the issue that states expected or actual behaviour. */
export interface Expectation {
  /** the sentence, whitespace collapsed, bounded */
  text: string;
  pattern: ExpectationPattern;
  /** backticked or quoted values in the sentence, in order of appearance */
  values: string[];
  /** 1-based line of the task text the sentence starts on */
  line: number;
}

export interface Extraction {
  blocks: CodeBlock[];
  /** every traceback in the text, block-embedded ones included, in order */
  tracebacks: Traceback[];
  expectations: Expectation[];
}

/** A REPL transcript as a script plus the value the reporter shows per statement. */
export interface NormalisedRepl {
  /** statements joined with '\n' */
  script: string;
  statements: string[];
  /** statement index → shown output, only for statements that show something */
  shown: { statement: number; text: string; traceback: Traceback | null }[];
}

// ---------------------------------------------------------------------------------------
// Jev judgement (questions.ts)
// ---------------------------------------------------------------------------------------

export type FailureKind = 'wrong_value' | 'exception_raised' | 'should_raise_but_does_not' | 'wrong_type' | 'performance' | 'none_of_these';

export interface BlockJudgement {
  index: number;
  /** P(the block reproduces the reported bug when run against the repository) */
  isReproduction: number;
  /** P(the block shows the output the reporter expected) */
  showsExpected: number;
  /** P(the block shows the wrong behaviour observed) */
  showsActual: number;
}

export interface FrameJudgement {
  /** index into the frames offered (`OracleQuestionSet.frames`) */
  index: number;
  frame: TracebackFrame;
  /** P(the frame is inside the code that must change) */
  inFix: number;
}

export interface OracleJudgement {
  blocks: BlockJudgement[];
  failureKind: FailureKind;
  failureKindProbabilities: Record<string, number>;
  frames: FrameJudgement[];
  requests: number;
}

// ---------------------------------------------------------------------------------------
// Runner (runner.ts)
// ---------------------------------------------------------------------------------------

export interface ReproException {
  type: string;
  message: string;
  frames: TracebackFrame[];
}

/** One executed top-level statement of the reproduction script. */
export interface StatementResult {
  /** index of the source chunk (REPL statement or code block) the statement came from */
  chunk: number;
  /** index of the statement inside its chunk (a REPL statement has one) */
  stmt: number;
  source: string;
  kind: 'expr' | 'stmt' | 'syntax_error';
  /** repr() of an expression statement's value (None gives null, as the REPL prints nothing) */
  value: string | null;
  /** type(value).__name__ for an expression statement with a value */
  typeName: string | null;
  stdout: string;
  exception: ReproException | null;
  /** an `import X` / `from <package> import X` the runner added after a NameError, when any */
  fixup: string | null;
  /** the statement failed on a module the repository does not provide (numpy, the reporter's app): an environment gap, not evidence */
  environment: boolean;
  ms: number;
}

export interface ReproRunResult {
  status: 'ran' | 'timeout' | 'no_output' | 'error';
  python: string | null;
  statements: StatementResult[];
  exitCode: number | null;
  durationMs: number;
  /** raw tail of the combined output, for the transcript (bounded) */
  outputTail: string;
}

/** The pass criterion, built in code from the expected output (never from Jev). */
export type Criterion =
  | { form: 'no_exception' }
  | { form: 'raises'; exceptionType: string }
  | {
      form: 'values';
      expected: ExpectedValue[];
      /**
       * the wrong value the issue shows for the last compared statement, when known; enables the loose
       * tier (same tokens in another order counts, but never the recorded wrong value itself)
       */
      observedActual?: string;
    }
  | { form: 'type_name'; expected: string }
  | { form: 'differs_from_actual'; actual: string };

export interface ExpectedValue {
  /** chunk index of the statement whose output must match; 'last' = the last statement that produced a value or output */
  chunk: number | 'last';
  text: string;
}

export interface Verdict {
  pass: boolean;
  /** what the run produced at the compared statement(s): repr, stdout or `ExcType: message` */
  actual: string;
  expected: string;
  reason: string;
  /** the statement the verdict rests on */
  statement: StatementResult | null;
}

/** How much the criterion can tell apart: a stated expected value or exception vs "anything but the observed output". */
export type CriterionStrength = 'strong' | 'weak';
