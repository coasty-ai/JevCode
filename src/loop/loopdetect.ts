/**
 * Loop detection (DESIGN.md §6 "Loop detection"): per-step signatures computed from the
 * StepRecord, counts cumulative since run start, trip at LOOP_TRIP_COUNT.
 * The detector is mutated only at the commit point (`observe`) and at replan (`onReplan`).
 *
 * Refused proposals (experiments/results/jev-only-ladder-4-analysis.md §3, Fix 3): a blocked or
 * declined proposal is signed on the proposal alone (`run:<cmd>:refused`, `done:<summary>`,
 * `read:<paths>`, `patch:<diff>`), never on the outcome's reason text, so declined-then-blocked
 * copies of one proposal count as one loop. A trip resets only the signature(s) that reached the
 * count and a replan only the signature it answers, so an interleaved `read` or intent trip cannot
 * shelter a slower `done` loop and DESIGN §5.5's third-identical-`done` exit stays reachable.
 *
 * Failing test runs (experiments/results/jev-only-rungs-1-2.md §14.3, ladder round 6): the `fail:`
 * signature of a test-runner command that exits non-zero is the failure's identity, not its text —
 * the sorted set of failing/erroring test ids parsed from the output (`testFailureIdentity`), the
 * un-normalised pass/fail/error counts when no id is printed, and the old text hash only when nothing
 * parses. Two failing runs are "the same failure" only when their failing sets are identical, so a
 * suite going 6/10 → 8/10 → 9/10 is progress and never trips.
 */
import { sha12 } from '../core/hash.js';
import { firstLine, normaliseForSignature } from '../core/text.js';
import type { ActionOutcome, ExecResult, LoopDetectorState, Proposal, TestRunner } from '../core/types.js';
import { parseTestOutput, runnerFromCommand } from '../workspace/tests.js';

export const LOOP_TRIP_COUNT = 3;
export const INTENT_UNRESOLVED_SIGNATURE = 'intent:unresolved';
/** the result part of a `run` signature whose proposal was blocked or declined (it never ran, so it has no result) */
export const REFUSED_RESULT = 'refused';

export interface SignatureInput {
  proposal: Proposal | null;
  outcome: ActionOutcome | null;
  /** run: stdout+stderr; read: concatenated views */
  output: string | null;
  /** first stderr line (or last output line) for the fail: signature of a non-zero exit */
  intentFallback: boolean;
  /** reason of the second GeneratorResponseError (twice-malformed propose) */
  generatorFailReason: string | null;
  /** thrown error's class name for a failed outcome, when known */
  errorClass: string | null;
  /** interrupted steps and Jev/provider stage failures are not observed (§6) */
  observed: boolean;
  workspaceRoot: string;
  /**
   * The detected runner when this step's `run` was the workspace test command (the engine's
   * `draft.tests !== null`); absent or null → the runner is read from the command itself
   * (`runnerFromCommand`, python runners only).
   */
  testRunner?: TestRunner | null;
}

function norm(s: string, root: string): string {
  return normaliseForSignature(s, root);
}

/** Zero to three signatures, in the fixed order of §6 (run/patch/read/done, intent, fail:generator, fail:). */
export function computeSignatures(input: SignatureInput): string[] {
  if (!input.observed) return [];
  const sigs: string[] = [];
  const root = input.workspaceRoot;
  const { proposal, outcome } = input;
  if (proposal && outcome && outcome.status !== 'interrupted') {
    const a = proposal.action;
    switch (a.kind) {
      case 'run': {
        let result: string;
        if (outcome.status === 'executed') result = sha12(`${outcome.exec?.exitCode ?? 'null'}:${norm(input.output ?? '', root)}`);
        else if (outcome.status === 'blocked' || outcome.status === 'declined') result = REFUSED_RESULT;
        else result = sha12(`${outcome.status}:${norm(outcomeReason(outcome), root)}`);
        sigs.push(`run:${sha12(norm(a.command, root))}:${result}`);
        break;
      }
      case 'edit':
      case 'write':
      case 'patch':
        sigs.push(`patch:${patchContentHash(a)}`);
        break;
      case 'read':
        sigs.push(`read:${sha12([...a.paths].sort().join('\n'))}`);
        break;
      case 'done':
        sigs.push(`done:${sha12(norm(a.summary, root))}`);
        break;
    }
  }
  if (input.intentFallback) sigs.push(INTENT_UNRESOLVED_SIGNATURE);
  if (proposal === null && input.generatorFailReason !== null) sigs.push(`fail:generator:${sha12(norm(input.generatorFailReason, root))}`);
  if (outcome && outcome.status === 'failed') {
    const cls = input.errorClass ?? outcome.error.split(':')[0] ?? 'Error';
    sigs.push(`fail:${sha12(cls + norm(firstLine(outcome.error), root))}`);
  } else if (outcome && outcome.status === 'executed' && outcome.exec && outcome.exec.exitCode !== null && outcome.exec.exitCode !== 0 && !outcome.exec.signal) {
    const identity = proposal?.action.kind === 'run' ? testFailureIdentity(proposal.action.command, outcome.exec, input.testRunner ?? null) : null;
    if (identity !== null) {
      sigs.push(`fail:${sha12(identity)}`);
    } else {
      const line = firstNonEmptyLine(outcome.exec.stderr) ?? lastNonEmptyLine(outcome.exec.stdout) ?? '';
      sigs.push(`fail:${sha12(`exit:${outcome.exec.exitCode}` + norm(line, root))}`);
    }
  }
  return sigs;
}

// ---------------------------------------------------------------------------------------
// Failure identity of a test run (§6, ladder round 6)
// ---------------------------------------------------------------------------------------

/** pytest's short test summary (`FAILED tests/a.py::test_x - msg`, `ERROR tests/a.py`) and `-v` progress lines. */
const PYTEST_SUMMARY_ID = /^(?:FAILED|ERROR) ([^\s(]\S*)(?: - .*)?$/gm;
const PYTEST_VERBOSE_ID = /^(\S+::\S+) (?:FAILED|ERROR)\b/gm;
/** unittest / Django: `FAIL: test_x (pkg.mod.Class)`, `ERROR: test_x (pkg.mod.Class.test_x)` (3.11+), and `-v` rows `test_x (pkg.Class) ... FAIL`. */
const UNITTEST_HEADER_ID = /^(?:FAIL|ERROR): (\w+) \(([\w.]+)\)/gm;
const UNITTEST_VERBOSE_ID = /^(\w+) \(([\w.]+)\)(?: [^\n]*?)? \.\.\. (?:FAIL|ERROR)\s*$/gm;
/** sympy `bin/test` failure headers: `_____ sympy/core/tests/test_x.py:test_y _____`. */
const SYMPY_HEADER_ID = /^_{3,} (\S+\.py:\S+) _{3,}$/gm;
/** jest `● Suite › name` / `✕ name (3 ms)`, vitest ` FAIL  tests/x.test.ts > suite > name` / `× name`. */
const JEST_BULLET_ID = /^\s*● (.+?)\s*$/gm;
const JS_CROSS_ID = /^\s*[✕×] (.+?)(?: \(?\d+ ?ms\)?)?\s*$/gm;
const JS_FAIL_ID = /^\s*FAIL\s+(\S[^\n]*?)\s*$/gm;
/** cargo `test mod::name ... FAILED`, go `--- FAIL: TestName (0.00s)`. */
const CARGO_ID = /^test (\S+) \.\.\. FAILED\s*$/gm;
const GO_ID = /^\s*--- FAIL: (\S+)/gm;

function collect(out: Set<string>, text: string, re: RegExp, pick: (m: RegExpMatchArray) => string | null): void {
  for (const m of text.matchAll(re)) {
    const id = pick(m);
    if (id !== null && id.length > 0) out.add(id);
  }
}

function unittestId(m: RegExpMatchArray): string {
  const method = m[1] ?? '';
  const owner = m[2] ?? '';
  return owner.endsWith(`.${method}`) ? owner : `${owner}.${method}`;
}

/**
 * The failing and erroring test ids a runner printed, sorted and de-duplicated; empty when the
 * output names none (a killed run, `-qq`, a runner without per-test lines). `npm`/`unknown` try
 * every format, as `parseTestOutput` does for the counts.
 */
export function failingTestIds(runner: TestRunner, output: string): string[] {
  const ids = new Set<string>();
  const first = (m: RegExpMatchArray): string | null => m[1] ?? null;
  const pytest = (): void => {
    collect(ids, output, PYTEST_SUMMARY_ID, first);
    collect(ids, output, PYTEST_VERBOSE_ID, first);
  };
  const unittest = (): void => {
    collect(ids, output, UNITTEST_HEADER_ID, unittestId);
    collect(ids, output, UNITTEST_VERBOSE_ID, unittestId);
  };
  const js = (): void => {
    collect(ids, output, JEST_BULLET_ID, (m) => (/^Test suite failed to run/.test(m[1] ?? '') ? null : first(m)));
    collect(ids, output, JS_CROSS_ID, first);
    collect(ids, output, JS_FAIL_ID, first);
  };
  switch (runner) {
    case 'pytest':
      pytest();
      break;
    case 'django':
    case 'unittest':
      unittest();
      break;
    case 'sympy_bintest':
      collect(ids, output, SYMPY_HEADER_ID, first);
      break;
    case 'jest':
    case 'vitest':
      js();
      break;
    case 'cargo':
      collect(ids, output, CARGO_ID, first);
      break;
    case 'go':
      collect(ids, output, GO_ID, first);
      break;
    case 'npm':
    case 'unknown':
      pytest();
      if (ids.size === 0) unittest();
      if (ids.size === 0) js();
      if (ids.size === 0) collect(ids, output, CARGO_ID, first);
      if (ids.size === 0) collect(ids, output, GO_ID, first);
      break;
  }
  return [...ids].sort();
}

/**
 * The identity of a failing test run for the `fail:` signature (§6): `tests:` + the sorted failing
 * set when the runner printed ids, `counts:<passed>/<failed>/<errors>` (digits kept) when only a
 * summary parsed, null when the command is not a recognised test runner or nothing parsed — the
 * caller then falls back to the exit-code + first-line text hash.
 */
export function testFailureIdentity(command: string, exec: Pick<ExecResult, 'stdout' | 'stderr'>, knownRunner: TestRunner | null = null): string | null {
  const runner = knownRunner ?? runnerFromCommand(command);
  if (runner === null) return null;
  const output = exec.stderr.length > 0 ? `${exec.stdout}\n${exec.stderr}` : exec.stdout;
  const ids = failingTestIds(runner, output);
  if (ids.length > 0) return `tests:${ids.join('\n')}`;
  const counts = parseTestOutput(runner, output);
  if (counts !== null) return `counts:${counts.passed}/${counts.failed}/${counts.errors}`;
  return null;
}

/** The content identity of a workspace change (§6 `patch:` signature; risk.ts `priorPatches[].sameContent`). */
export function patchContentHash(a: Extract<Proposal['action'], { kind: 'edit' | 'write' | 'patch' }>): string {
  switch (a.kind) {
    case 'edit':
      return sha12(a.path + a.old + a.new);
    case 'write':
      return sha12(a.path + a.content);
    case 'patch':
      return sha12(a.diff);
  }
}

function outcomeReason(o: ActionOutcome): string {
  switch (o.status) {
    case 'blocked':
    case 'declined':
      return o.reason;
    case 'failed':
      return o.error;
    case 'noop':
      return o.summary;
    default:
      return '';
  }
}

function firstNonEmptyLine(s: string): string | null {
  for (const l of s.split('\n')) if (l.trim().length > 0) return l;
  return null;
}
function lastNonEmptyLine(s: string): string | null {
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim().length > 0) return lines[i]!;
  return null;
}

export type SignatureKind = 'run' | 'patch' | 'read' | 'done' | 'intent' | 'fail:generator' | 'fail';

export function signatureKind(sig: string): SignatureKind {
  if (sig.startsWith('run:')) return 'run';
  if (sig.startsWith('patch:')) return 'patch';
  if (sig.startsWith('read:')) return 'read';
  if (sig.startsWith('done:')) return 'done';
  if (sig === INTENT_UNRESOLVED_SIGNATURE) return 'intent';
  if (sig.startsWith('fail:generator:')) return 'fail:generator';
  return 'fail';
}

/** Human wording for the jev-off fixed loop text and the replan directive (§13). */
export function describeSignatureKind(kind: SignatureKind): string {
  switch (kind) {
    case 'run':
      return 'run command with the same result';
    case 'patch':
      return 'edit';
    case 'read':
      return 'read of the same files';
    case 'done':
      return 'done proposal';
    case 'intent':
      return 'step with no fitting intent';
    case 'fail:generator':
      return 'malformed reply';
    case 'fail':
      return 'failure';
  }
}

/** Jev-off: the fixed text injected on a trip (§13). */
export function loopTripText(sig: string): string {
  return `You have repeated the same ${describeSignatureKind(signatureKind(sig))} ${LOOP_TRIP_COUNT} times. Change approach, or reply with a done action explaining why the task cannot be completed.`;
}

/**
 * The move a stored replan directive names (src/jev-modes/stages/replan.ts directiveText writes "Jev directs
 * `<move>`"); null for the fallback wording. The checkpointed directive history keeps text only.
 */
export function directiveMove(text: string): string | null {
  const m = /Jev directs `([a-z_]+)`/.exec(text);
  return m?.[1] ?? null;
}

export interface TripInfo {
  signature: string;
  occurrences: number;
}

export interface LoopDetector {
  /** Commit-point observation; returns the trip (first signature in order to reach the count) or null. */
  observe(step: number, signatures: readonly string[]): TripInfo | null;
  tripped(): boolean;
  /** the tripped signature while tripped, else null */
  trippedSignature(): string | null;
  trips(signature: string): number;
  priorDirectives(signature: string): { step: number; directive: string }[];
  /** replan (jev-on) or fixed text (jev-off) issued: the answered signature's count reset, trip cleared, history kept */
  onReplan(step: number, directive: string): void;
  /** TUI-DESIGN §8.6 / §15 item 19: a human directive applied — counts, lastSignature and the trip cleared; trips history and replanCount kept */
  resetCounts(): void;
  replanCount(): number;
  toState(): LoopDetectorState;
}

export function emptyLoopDetectorState(): LoopDetectorState {
  return { counts: {}, lastSignature: null, tripped: false, replanCount: 0, tripsBySignature: {} };
}

export function createLoopDetector(initial?: LoopDetectorState): LoopDetector {
  const st: LoopDetectorState = initial
    ? {
        counts: { ...initial.counts },
        lastSignature: initial.lastSignature,
        tripped: initial.tripped,
        replanCount: initial.replanCount,
        tripsBySignature: Object.fromEntries(Object.entries(initial.tripsBySignature).map(([k, v]) => [k, { trips: v.trips, directives: v.directives.map((d) => ({ ...d })) }])),
      }
    : emptyLoopDetectorState();
  return {
    observe(_step, signatures) {
      let trip: TripInfo | null = null;
      const reached: string[] = [];
      for (const sig of signatures) {
        const n = (st.counts[sig] ?? 0) + 1;
        st.counts[sig] = n;
        if (n >= LOOP_TRIP_COUNT) {
          reached.push(sig);
          if (trip === null) trip = { signature: sig, occurrences: n };
        }
      }
      if (signatures.length > 0) st.lastSignature = signatures[signatures.length - 1] ?? null;
      if (trip) {
        // Only the signatures that reached the count reset: the reported one and any that co-tripped
        // with it in this step (the `fail:` of a failing `run:`), so the replan answers them together
        // and no second trip follows on the next step. Every other count survives (Fix 3); the trip
        // history per signature is kept for the replan state.
        for (const sig of reached) delete st.counts[sig];
        st.tripped = true;
        st.lastSignature = trip.signature;
        const h = st.tripsBySignature[trip.signature] ?? { trips: 0, directives: [] };
        h.trips += 1;
        st.tripsBySignature[trip.signature] = h;
      }
      return trip;
    },
    tripped: () => st.tripped,
    trippedSignature: () => (st.tripped ? st.lastSignature : null),
    trips: (sig) => st.tripsBySignature[sig]?.trips ?? 0,
    priorDirectives: (sig) => (st.tripsBySignature[sig]?.directives ?? []).map((d) => ({ ...d })),
    onReplan(step, directive) {
      const sig = st.lastSignature;
      if (sig !== null) {
        const h = st.tripsBySignature[sig] ?? { trips: 0, directives: [] };
        h.directives.push({ step, directive });
        st.tripsBySignature[sig] = h;
        // Only the signature the replan answers restarts; other loops keep their counts (Fix 3).
        delete st.counts[sig];
      }
      st.tripped = false;
      st.replanCount += 1;
    },
    resetCounts() {
      // TUI-DESIGN §8.6: the human changed course, so the repetition count restarts; what was tripped and directed before stays on record
      st.counts = {};
      st.lastSignature = null;
      st.tripped = false;
    },
    replanCount: () => st.replanCount,
    toState: () => ({
      counts: { ...st.counts },
      lastSignature: st.lastSignature,
      tripped: st.tripped,
      replanCount: st.replanCount,
      tripsBySignature: Object.fromEntries(Object.entries(st.tripsBySignature).map(([k, v]) => [k, { trips: v.trips, directives: v.directives.map((d) => ({ ...d })) }])),
    }),
  };
}
