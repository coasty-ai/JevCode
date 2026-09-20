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
 */
import { sha12 } from '../core/hash.js';
import { firstLine, normaliseForSignature } from '../core/text.js';
import type { ActionOutcome, LoopDetectorState, Proposal } from '../core/types.js';

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
        sigs.push(`patch:${sha12(a.path + a.old + a.new)}`);
        break;
      case 'write':
        sigs.push(`patch:${sha12(a.path + a.content)}`);
        break;
      case 'patch':
        sigs.push(`patch:${sha12(a.diff)}`);
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
    const line = firstNonEmptyLine(outcome.exec.stderr) ?? lastNonEmptyLine(outcome.exec.stdout) ?? '';
    sigs.push(`fail:${sha12(`exit:${outcome.exec.exitCode}` + norm(line, root))}`);
  }
  return sigs;
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
 * The move a stored replan directive names (stages/replan.ts directiveText writes "Jev directs
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
