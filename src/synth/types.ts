/**
 * Shared types for the Jev-only synthesizer (docs/JEV-ONLY.md; measurements in
 * experiments/results/). Code proposes candidates, Jev decides, tests verify. Modules under
 * src/synth/* implement these interfaces; src/synth/search/ composes them (design in
 * docs/JEV-ONLY-DESIGN.md). Frozen for the parallel build; changes are reconciled centrally.
 */
import type { Answer, Decision, Json, Question, StageName } from '../core/types.js';
import type { PyModule, LineScope } from './py/structure.js';

// ---------------------------------------------------------------------------------------
// Where we are editing
// ---------------------------------------------------------------------------------------

/** A file under repair: path relative to the workspace root, its current source and analysis. */
export interface SourceFile {
  path: string;
  src: string;
  mod: PyModule;
}

/** A place a candidate edit applies to: one line (replace) or a gap (insert) in a function. */
export interface Site {
  file: SourceFile;
  /** 1-based line of the current text being replaced; for inserts, the line BEFORE which to insert */
  line: number;
  kind: 'replace' | 'insert';
  /** current text of `line` (trimmed of the trailing newline); '' for insert sites */
  currentLine: string;
  indent: string;
  /** enclosing function/class block line range (1-based inclusive), or null at module level */
  block: { name: string; startLine: number; endLine: number } | null;
  scope: LineScope;
  /** why this site is suspicious, for the Jev state and the transcript */
  evidence: SiteEvidence;
}

export interface SiteEvidence {
  /** probability from the localisation Choice / Noul, if any */
  jevProbability?: number;
  /** spectrum-based rank (1 = most suspicious) and score, if coverage was collected */
  sbflRank?: number;
  sbflScore?: number;
  /** free-text reasons (code-computed): "named in traceback", "in failing test's call chain", ... */
  notes: string[];
}

// ---------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------

export type CandidateSourceName = 'mutation' | 'template' | 'donor' | 'token_beam' | 'test_value' | 'history' | 'composite';

/** One concrete proposed edit at a site. `text` is the full replacement line (or inserted line). */
export interface Candidate {
  id: string;
  site: Site;
  text: string;
  source: CandidateSourceName;
  /** operator or template name, e.g. 'relational_swap', 'guard_none_return' */
  op: string;
  /** optional multi-line follow-up edits the candidate needs to be complete (same file), applied after `text` */
  extraEdits?: readonly LineEdit[];
  /** prior from the source (0..1), used only to order enumeration, never as a Jev substitute */
  prior?: number;
}

export interface LineEdit {
  path: string;
  line: number;
  kind: 'replace' | 'insert' | 'delete';
  text?: string;
}

/** Applies a candidate to the current sources and returns the new file contents (pure). */
export interface AppliedCandidate {
  candidate: Candidate;
  files: readonly { path: string; before: string; after: string }[];
  /** unified diff over all touched files, ready for `patch` actions and for the record */
  diff: string;
}

export interface EnumerateOptions {
  /** hard cap per site per source */
  cap: number;
  /** literals seen in the failing tests (expected values, arguments), code-extracted */
  testLiterals: readonly string[];
  /** identifiers that appear in the task text or the failing test, code-extracted */
  taskIdentifiers: readonly string[];
  /** other files of the workspace available as donor corpus (path -> SourceFile) */
  corpus: ReadonlyMap<string, SourceFile>;
}

export interface CandidateSource {
  readonly name: CandidateSourceName;
  /** Enumerate candidates at a site. Must be deterministic, pure, and syntactically filtered where possible. */
  enumerate(site: Site, opts: EnumerateOptions): Candidate[];
}

// ---------------------------------------------------------------------------------------
// Jev access inside the synthesizer (routed through the engine so everything is recorded)
// ---------------------------------------------------------------------------------------

export interface JevAsk {
  (stage: StageName, state: Json, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; rows: Decision[]; latencyMs: number }>;
}

// ---------------------------------------------------------------------------------------
// Ranking (experiments/results/probe-selection.md, probe-question-design.md)
// ---------------------------------------------------------------------------------------

export interface RankedCandidate {
  candidate: Candidate;
  /** P(candidate) from the Choice, or the per-candidate Noul/Score-derived probability */
  probability: number;
  rank: number;
}

export interface RankResult {
  ranked: RankedCandidate[];
  /** P(none_of_these) on the Choice (or max-Noul-based analogue) */
  escapeProbability: number;
  /** code-computed detector: fix probably not in this set (P(escape) − p_max ≥ 0.10, or max Noul < 0.5) */
  fixProbablyAbsent: boolean;
  method: 'choice' | 'nouls' | 'two_stage' | 'score';
  requests: number;
}

export interface Ranker {
  /** Rank up to 254 candidates at one site in one or two Jev requests; excludes the unchanged line from the options. */
  rank(candidates: readonly Candidate[], ctx: RankContext): Promise<RankResult>;
}

export interface RankContext {
  ask: JevAsk;
  task: string;
  /** failing tests with expected and actual output (code-computed, bounded) */
  failures: readonly FailureView[];
  /** numbered listing of the enclosing function (bounded) */
  functionListing: string;
  signal: AbortSignal;
}

export interface FailureView {
  testId: string;
  /** e.g. "gcd(13, 13)" or the pytest node id */
  call: string;
  expected: string;
  /** repr of the actual value, or "RecursionError: ..." / "timeout after 2 s" */
  actual: string;
}

// ---------------------------------------------------------------------------------------
// Localisation (probe-localization.md, probe-swebench-understanding.md)
// ---------------------------------------------------------------------------------------

export interface FileCandidate {
  path: string;
  probability: number;
  /** outline used for the confirmation pass */
  outline?: string[];
}

export interface FunctionCandidate {
  file: SourceFile;
  name: string;
  startLine: number;
  endLine: number;
  probability: number;
}

export interface LocalizeResult {
  files: FileCandidate[]; // ranked, top-5 beam
  functions: FunctionCandidate[]; // ranked across the file beam, top-5
  sites: Site[]; // ranked line sites (±3 windows around top line anchors), with evidence
  requests: number;
}

// ---------------------------------------------------------------------------------------
// Verification (probe-progress-judgment.md): tests are the oracle; deltas are computed in code
// ---------------------------------------------------------------------------------------

export interface TestRunSummary {
  command: string;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  total: number;
  /** ids of failing tests (code-computed from the runner output when available) */
  failing: string[];
  passing: string[];
  failures: FailureView[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** raw tail of the output for the Jev state and the transcript (bounded) */
  outputTail: string;
}

export interface Progress {
  before: TestRunSummary;
  after: TestRunSummary;
  newlyPassing: string[];
  newlyFailing: string[];
  /** code-computed verdicts */
  allPass: boolean;
  improved: boolean; // after.passed > before.passed
  regressed: boolean; // newlyFailing.length > 0
}

export type Move = 'accept_and_stop' | 'accept_and_continue' | 'revert_try_next' | 'revert_relocalise' | 'widen_sources' | 'give_up';

// ---------------------------------------------------------------------------------------
// Token-beam synthesis (probe-token-synthesis.md)
// ---------------------------------------------------------------------------------------

export interface BeamOptions {
  width: number; // 3
  maxTokens: number; // 25
  /** expand 1 when p(top) ≥ this (0.9), else up to `width` */
  confidentExpandThreshold: number;
}

export interface BeamResult {
  /** distinct complete lines, best first, with Σ log p (for ordering only; tests decide) */
  lines: { text: string; logProb: number }[];
  requests: number;
}

// ---------------------------------------------------------------------------------------
// Search trace (what the synthesizer reports per outer step; subset goes into synth events)
// ---------------------------------------------------------------------------------------

export interface SearchTrace {
  sitesConsidered: number;
  candidatesEnumerated: number;
  candidatesRanked: number;
  candidatesTested: number;
  jevRequests: number;
  testRuns: number;
  bySource: Record<CandidateSourceName, { enumerated: number; tested: number; passed: number }>;
  outcome: 'fixed' | 'partial' | 'no_progress' | 'exhausted' | 'budget';
  winner?: AppliedCandidate;
}
