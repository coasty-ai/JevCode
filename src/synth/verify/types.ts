/**
 * Verifier-local types (docs/JEV-ONLY.md; experiments/results/probe-progress-judgment.md).
 * The shared contract (TestRunSummary, Progress, Move, FailureView, AppliedCandidate) lives in
 * ../types.ts; everything here is what the verifier needs on top of it.
 */
import type { FailureView } from '../types.js';

/** What the verifier needs from a command runner: the engine's Sandbox.run minus the signal. */
export interface VerifyRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
}

/** ExecResult-like: only the fields the parsers read. Sandbox's ExecResult satisfies it. */
export interface VerifyRunResult {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  /** killed on the timeout (ExecResult.timedOut); when absent, `killedBy === 'timeout'` is used */
  timedOut?: boolean;
  killedBy?: string | null;
  durationMs?: number;
}

export type VerifyRunFn = (command: string, opts: VerifyRunOptions) => Promise<VerifyRunResult>;

export interface VerifierDeps {
  run: VerifyRunFn;
  /** per test run (default 120 s: QuixBugs' per-case subprocesses and a pytest module both fit) */
  timeoutMs?: number;
  /** default 256 KB; the parsers only need the summary and the failure sections */
  maxOutputBytes?: number;
  cwd?: string;
}

export interface RunTestsOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

/** Which runner produced the output the summary was built from (unittest covers Django's runtests.py). */
export type TestOutputFormat = 'quixbugs_json' | 'pytest' | 'unittest' | 'sympy_bintest' | 'unknown';

/**
 * What the search has left to try when `route()` is asked for the next move. Counters are
 * code-computed by the search module; the verifier never asks Jev to compare them.
 */
export interface SearchState {
  /** candidates of the current source not yet tested at the current site */
  candidatesRemainingAtSite: number;
  /** candidate sources not yet enumerated at the current site */
  sourcesRemainingAtSite: number;
  /** localised sites not yet visited (0 means the site list is exhausted and localisation must widen) */
  sitesRemaining: number;
  /** Jev requests, test runs or wall-clock budget spent */
  budgetExhausted: boolean;
  /** id of the failing test this candidate was chosen to fix, if the search attacks one test at a time */
  attackedTestId?: string;
}

/** Result of the "which failing test to attack first" decision. */
export interface PickedTest {
  testId: string;
  failure: FailureView;
  /** P(option) on the Choice; 1 when no request was made */
  probability: number;
  /**
   * single: only one failing test; jev: the Choice's argmax; tiebreak: the code tiebreak on
   * input size decided (several options within the noise band, or the escape option won)
   */
  method: 'single' | 'jev' | 'tiebreak';
  requests: number;
}

export interface PickOptions {
  /** offer at most this many failing tests (measured with 10) */
  max?: number;
  /** what fails, e.g. "the Python function `gcd`" (the measured wording); default "the program under repair" */
  subject?: string;
  /** options whose probability is within this margin of the maximum tie (Jev's noise band is ±0.02) */
  tieMargin?: number;
}

/** The per-question probabilities of one progress judgment plus the code comparison. */
export interface ProgressJudgment {
  /** P(true) per Noul id; only ids that were asked */
  nouls: Record<string, number>;
  /** expected level of `closeness` (0..4) when asked, else null */
  closenessExpected: number | null;
  /** Noul ids where Jev is confident (≤ 0.3 or ≥ 0.7) and disagrees with the code verdict */
  disagreements: string[];
  /** Noul ids in the 0.3..0.7 band, neither agreeing nor disagreeing */
  unsure: string[];
  requests: number;
  latencyMs: number;
}

export class VerifyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`VerifyError: ${message}`, options);
    this.name = 'VerifyError';
  }
}
