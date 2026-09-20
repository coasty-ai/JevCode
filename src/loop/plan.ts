/**
 * Persistent plan rules (DESIGN.md §6 "Plan"): the generator returns a full PlanDraft each
 * step; the harness diffs it against the accepted Plan and applies rules (a) done claims,
 * (b) remaining, (c) open problems at the commit point. Pure functions; the engine owns the
 * Plan object and replaces it with the returned one.
 */
import { clip } from '../core/text.js';
import type { DoneClaimResult, HarnessProblem, Plan, PlanDraft } from '../core/types.js';

export const PLAN_ACCEPT_THRESHOLD = 0.7;
export const PLAN_REJECT_THRESHOLD = 0.3;
export const PLAN_MAX_ITEMS = 20;
export const PLAN_ITEM_MAX_CHARS = 200;
export const PLAN_MAX_CLAIMS = 8;
export const PLAN_MAX_OPEN_PROBLEMS = 16;
export const PLAN_MAX_HARNESS_PROBLEMS = 16;

export function emptyPlan(): Plan {
  return { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] };
}

export function normaliseItem(s: string): string {
  return clip(s.replace(/\s+/g, ' ').trim(), PLAN_ITEM_MAX_CHARS);
}

function dedupe(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const s = normaliseItem(raw);
    if (s.length > 0 && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Items newly present in draft.done (not already accepted), capped at PLAN_MAX_CLAIMS. */
export function newClaims(plan: Plan, draft: PlanDraft): { claims: string[]; dropped: number } {
  const accepted = new Set(plan.done.map((d) => d.text));
  const fresh = dedupe(draft.done).filter((t) => !accepted.has(t));
  return { claims: fresh.slice(0, PLAN_MAX_CLAIMS), dropped: Math.max(0, fresh.length - PLAN_MAX_CLAIMS) };
}

/** How done claims are judged this step. */
export type ClaimEvidence =
  /** jev-on with a judge answer per claim (text -> done_<j>) */
  | { kind: 'judged'; probabilities: ReadonlyMap<string, number> }
  /** jev-on without judge evidence (noop / blocked / declined / failed / stage failure / interrupted) */
  | { kind: 'none'; because: string }
  /** jev-off: accepted verbatim, judged -1 */
  | { kind: 'verbatim' };

export interface PlanUpdateInput {
  plan: Plan;
  /** null when the step produced no proposal: only expiry rules apply */
  draft: PlanDraft | null;
  step: number;
  claims: string[];
  claimsDropped: number;
  evidence: ClaimEvidence;
  /** judge new_information for this step (null when not judged) */
  newInformation: number | null;
  /** a replan directive was issued for this step */
  replan: { text: string } | null;
  /** plan_still_valid below 0.3 this step */
  stale: { probability: number } | null;
}

export interface PlanUpdateResult {
  plan: Plan;
  accepted: string[];
  rejected: { text: string; judged: number }[];
  unverified: { text: string; judged: number }[];
  /** items the generator dropped from remaining that the harness kept */
  retained: string[];
  doneClaims: DoneClaimResult[];
  /** window notes for this step (rejections, unverified, retained, dropped claims) */
  notes: string[];
}

function fmt(p: number): string {
  return p.toFixed(2);
}

/** Apply rules (a), (b), (c) and the harnessProblems expiry rules. */
export function applyPlanDraft(input: PlanUpdateInput): PlanUpdateResult {
  const { plan, draft, step } = input;
  const notes: string[] = [];
  const accepted: string[] = [];
  const rejected: { text: string; judged: number }[] = [];
  const unverified: { text: string; judged: number }[] = [];
  const doneClaims: DoneClaimResult[] = [];

  const done = plan.done.map((d) => ({ text: d.text, evidence: { ...d.evidence } }));
  let remaining = [...plan.remaining];
  let unverifiedList = plan.unverified.map((u) => ({ ...u }));
  // Expiry: stale-plan notes live for one step; the rest is handled below.
  let harness: HarnessProblem[] = plan.harnessProblems.filter((h) => !(h.kind === 'stale_plan' && h.step < step));

  if (draft) {
    // (a) done claims
    for (const text of input.claims) {
      let judged: number;
      let accept: boolean;
      if (input.evidence.kind === 'verbatim') {
        judged = -1;
        accept = true;
      } else if (input.evidence.kind === 'judged') {
        judged = input.evidence.probabilities.get(text) ?? 0;
        accept = judged >= PLAN_ACCEPT_THRESHOLD;
      } else {
        judged = 0;
        accept = false;
      }
      doneClaims.push({ text, judged, accepted: accept });
      if (accept) {
        accepted.push(text);
        done.push({ text, evidence: { step, judged } });
        remaining = remaining.filter((r) => r !== text);
        unverifiedList = unverifiedList.filter((u) => u.text !== text);
        harness = harness.filter((h) => !(h.kind === 'rejected_claim' && h.text.includes(`'${text}'`)));
        continue;
      }
      // Not accepted: the item stays in remaining whatever the generator did with it.
      if (!remaining.includes(text)) remaining.push(text);
      if (input.evidence.kind === 'judged' && judged >= PLAN_REJECT_THRESHOLD) {
        unverified.push({ text, judged });
        unverifiedList = unverifiedList.filter((u) => u.text !== text);
        unverifiedList.push({ text, step, judged });
        notes.push(`Jev was unsure (p=${fmt(judged)}) that '${text}' is finished; verify it (run the tests or the script) before marking it done`);
      } else {
        rejected.push({ text, judged });
        const why = input.evidence.kind === 'none' ? `no judge evidence (${input.evidence.because})` : `done_${input.claims.indexOf(text)} = ${fmt(judged)}`;
        const text2 = `'${text}' was not accepted as done: ${why}`;
        harness = harness.filter((h) => !(h.kind === 'rejected_claim' && h.text.includes(`'${text}'`)));
        harness.push({ kind: 'rejected_claim', text: clip(text2, 400), step });
        notes.push(text2);
      }
    }
    if (input.claimsDropped > 0) notes.push(`${input.claimsDropped} done claim(s) beyond ${PLAN_MAX_CLAIMS} per step were dropped; restate them next step`);

    // (b) remaining: additions accepted; drops only with a replan or new information
    const draftRemaining = dedupe(draft.remaining);
    const acceptedSet = new Set(done.map((d) => d.text));
    const mustKeep = new Set<string>([...unverified.map((u) => u.text), ...rejected.map((r) => r.text)]);
    const dropAllowed = input.replan !== null || (input.newInformation !== null && input.newInformation >= 0.7);
    const next: string[] = [];
    for (const r of draftRemaining) if (!acceptedSet.has(r)) next.push(r);
    const retained: string[] = [];
    for (const old of remaining) {
      if (acceptedSet.has(old) || next.includes(old)) continue;
      if (mustKeep.has(old) || !dropAllowed) {
        next.push(old);
        if (!mustKeep.has(old)) retained.push(old);
      }
    }
    for (const r of retained) notes.push(`'${r}' was dropped from remaining without a done claim and was retained by the harness`);
    remaining = next.slice(0, PLAN_MAX_ITEMS);
    unverifiedList = unverifiedList.filter((u) => remaining.includes(u.text)).slice(-PLAN_MAX_ITEMS);

    // (c) open problems replaced by the generator's list
    const openProblems = dedupe(draft.openProblems).slice(0, PLAN_MAX_OPEN_PROBLEMS);

    if (input.replan) {
      harness = harness.filter((h) => h.kind !== 'replan');
      harness.push({ kind: 'replan', text: clip(input.replan.text, 600), step });
    }
    if (input.stale) {
      harness = harness.filter((h) => h.kind !== 'stale_plan');
      harness.push({ kind: 'stale_plan', text: `Jev judged the plan stale at step ${step} (p=${fmt(input.stale.probability)})`, step });
    }
    harness = harness.slice(-PLAN_MAX_HARNESS_PROBLEMS);
    return {
      plan: { done, remaining, unverified: unverifiedList, openProblems, harnessProblems: harness },
      accepted,
      rejected,
      unverified,
      retained,
      doneClaims,
      notes,
    };
  }

  // No proposal this step: keep everything, apply only replan / stale bookkeeping.
  if (input.replan) {
    harness = harness.filter((h) => h.kind !== 'replan');
    harness.push({ kind: 'replan', text: clip(input.replan.text, 600), step });
  }
  if (input.stale) {
    harness = harness.filter((h) => h.kind !== 'stale_plan');
    harness.push({ kind: 'stale_plan', text: `Jev judged the plan stale at step ${step} (p=${fmt(input.stale.probability)})`, step });
  }
  return {
    plan: { done, remaining, unverified: unverifiedList, openProblems: [...plan.openProblems], harnessProblems: harness.slice(-PLAN_MAX_HARNESS_PROBLEMS) },
    accepted,
    rejected,
    unverified,
    retained: [],
    doneClaims,
    notes,
  };
}
