/**
 * Localizer contract details that src/synth/types.ts leaves to the module: the call context,
 * tunables with their measured defaults, and the internal candidate shapes shared by the stages.
 */
import type { StageName } from '../../core/types.js';
import type { RankedLine } from '../sbfl/types.js';
import type { FailureView, JevAsk, SourceFile } from '../types.js';

export interface LocalizeBudget {
  /** hard cap on Jev requests for one localize() call; stages shrink their beams to fit */
  maxRequests: number;
}

export interface LocalizeContext {
  ask: JevAsk;
  task: string;
  /** workspace Python files, path -> analysed source */
  files: ReadonlyMap<string, SourceFile>;
  /** failing tests with expected and actual output (code-computed, bounded) */
  failures: readonly FailureView[];
  /** raw traceback text of the failing run, when the runner captured one */
  traceback?: string;
  /** spectrum ranking from src/synth/sbfl (rankLines), when coverage was collected */
  sbfl?: readonly RankedLine[];
  signal: AbortSignal;
  budget: LocalizeBudget;
}

export interface LocalizerOptions {
  /** files kept after the Noul stage (probe-swebench-understanding: top-5 covers 28/30, top-10 30/30) */
  fileBeam: number;
  /** functions kept across the file beam (Q2: top-5 covers 35/37) */
  functionBeam: number;
  /** Jev line anchors per function (probe-localization: top-3 covers 36/40) */
  anchorsPerFunction: number;
  /**
   * Line anchors per function when the line Choice ESCAPED, so the code order stands in
   * (OOS iteration 3, item 4). `anchorsPerFunction` is 3 because a Jev top-3 covers 36/40 — it is
   * a bound on a RANKING. The code order is not a ranking: with no traceback frame and no coverage
   * it is the file's own line order, and a top-3 of it is the first three lines of the function,
   * which is why `--jev off` on `kth` (gold at L12), `mergesort` and `units` never produced a
   * replace site anywhere near the defect and replanned into the cap with `plausible 0` at every
   * step. With no ranking to trust, every line of the located function is offered and the site
   * budget (search/budget.ts `siteShare`) decides how far the step gets — the same thing WIDENED
   * already does one phase later. Bounded so a repository-sized function cannot blow the site
   * list up; a function longer than this still falls back to its first `escapedAnchors` lines.
   */
  escapedAnchors: number;
  /** SBFL lines unioned with the Jev anchors (union of two top-3 lists covered 38/40) */
  sbflAnchors: number;
  /** half-width of the site window around an anchor (Q4: within ±3 covers 94 %) */
  window: number;
  /** Nouls per request in the file stage (measured: ≤ 250 paths stays near 16k tokens) */
  fileChunkSize: number;
  /** estimated input tokens allowed for one request (state plus its longest question, as the wire counts; the cap there is 32,768) */
  stateTokenCap: number;
  /** Choice options excluding the escape (255 − none_of_these) */
  maxChoiceOptions: number;
  /** failing tests shown in the line-stage state (variant D used three) */
  testsInState: number;
  /** stage name recorded on every decision row */
  stage: StageName;
}

export const DEFAULT_LOCALIZER_OPTIONS: Readonly<LocalizerOptions> = {
  fileBeam: 5,
  functionBeam: 5,
  anchorsPerFunction: 3,
  escapedAnchors: 40,
  sbflAnchors: 3,
  window: 3,
  fileChunkSize: 250,
  stateTokenCap: 28_000,
  maxChoiceOptions: 254,
  testsInState: 3,
  stage: 'context',
};

/** Option key of the module-level entry in the function Choice (Q2 wording, verbatim). */
export const MODULE_LEVEL_KEY = 'module_level_code_outside_any_function';
/** Name reported for module-level FunctionCandidates (Site.block is null there). */
export const MODULE_LEVEL_NAME = '<module>';

/** A def enumerated for the function Choice: qualified name and physical span. */
export interface FunctionEntry {
  file: SourceFile;
  /** `Outer.Inner.method` for methods, plain name for functions, MODULE_LEVEL_NAME for module code */
  qualname: string;
  kind: 'function' | 'method' | 'module';
  startLine: number;
  endLine: number;
  /** the `def` line (decorators excluded), used for the option description */
  headerLine: number;
  /** null for the module-level pseudo-entry */
  blockIndex: number | null;
}

/** One frame of a Python traceback that resolves to a workspace file. */
export interface TracebackFrame {
  path: string;
  line: number;
  fn: string | null;
}
