/**
 * Shared types for spectrum-based fault localisation (SBFL) over Python workspaces.
 * The tracer (trace_lines.py) produces PerTestResult; ochiai.ts ranks; run.ts wires them.
 */

export type TestOutcome = 'pass' | 'fail' | 'error' | 'timeout' | 'skip';

export interface PytestTestSpec {
  mode: 'pytest';
  /** pytest node id relative to the workspace, e.g. `tests/test_x.py::TestY::test_z[1-2]` */
  id: string;
}

/** QuixBugs-style oracle: call `module.fn(*args)` and compare with `expected` (JSON semantics). */
export interface CallTestSpec {
  mode: 'call';
  id: string;
  /** importable module name (from the workspace root) or a path ending in `.py` */
  module: string;
  fn: string;
  args: readonly unknown[];
  /** generators are drained with list(); tuples equal lists; bool is not int */
  expected: unknown;
  /** absolute float tolerance (default 1e-6), mirrors `pytest.approx(expected, abs=...)` */
  tolerance?: number;
}

export type TestSpec = PytestTestSpec | CallTestSpec;

export interface TestException {
  type: string;
  message: string;
}

/** One JSON line of tracer output. */
export interface PerTestResult {
  id: string;
  outcome: TestOutcome;
  /** file exactly as passed in `files` -> sorted 1-based line numbers this test executed */
  lines: Record<string, number[]>;
  exception: TestException | null;
  durationMs: number;
  /** call mode, on fail: repr() of the value the function returned */
  actual?: string;
  /** tail of the child's stderr (test prints, pytest report); absent on pass */
  log?: string;
}

export type Formula = 'ochiai' | 'tarantula' | 'dstar';

export interface LineScores {
  ochiai: number;
  tarantula: number;
  /** DStar(2); Infinity when executed by every failing test and no passing one */
  dstar: number;
}

export interface RankedLine {
  /** 1-based position after the deterministic tie-break (score desc, file asc, line asc) */
  rank: number;
  file: string;
  line: number;
  /** failing tests (fail | error | timeout) that executed the line */
  ef: number;
  /** passing tests that executed the line */
  ep: number;
  /** the selected formula's value */
  score: number;
  scores: LineScores;
}

export interface FunctionSpan {
  file: string;
  name: string;
  startLine: number;
  /** inclusive */
  endLine: number;
}

export interface RankedFunction {
  rank: number;
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  /** max over the covered lines inside the span */
  score: number;
  /** the lowest line attaining that max */
  bestLine: number;
  /** distinct covered lines inside the span */
  coveredLines: number;
}
