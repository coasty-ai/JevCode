/**
 * Jev state builders (DESIGN.md §5.5): the common state every stage sends plus the per-stage
 * additions. Everything here is code-computed (counts, testsCurrent, lastTestRun); every string
 * passes `redact` and the text bounds, so no Jev request is ever O(transcript).
 */
import { headTail, clip } from '../core/text.js';
import { toJson } from '../core/json.js';
import type {
  ActionOutcome,
  CandidateView,
  ExecResult,
  Intent,
  Json,
  JsonObject,
  LastTestRun,
  Plan,
  PlanDraft,
  Proposal,
  SandboxLevel,
  TargetInfo,
  TestCounts,
  WindowEntry,
} from '../core/types.js';

export const STATE_LIMITS = {
  taskChars: 12_000,
  planItemChars: 200,
  planItems: 20,
  judgeOutputHead: 3_000,
  judgeOutputTail: 1_000,
  actionTextChars: 4_000,
  summaryChars: 1_000,
  candidates: 300,
} as const;

export type Redact = (s: string) => string;

/** Walk a Json value and redact every string leaf. */
export function redactJson(v: Json, redact: Redact): Json {
  if (typeof v === 'string') return redact(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, redact));
  const out: JsonObject = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactJson(x, redact);
  return out;
}

export interface CommonStateInput {
  task: string;
  plan: Plan;
  recent: readonly WindowEntry[];
  workspace: {
    root: string;
    git: boolean;
    hasTests: boolean;
    testCommand: string | null;
    changedFiles: readonly string[];
    createdThisRun: readonly string[];
    lastChangeStep: number | null;
    lastTestRun: LastTestRun | null;
    sandbox: SandboxLevel;
  };
  budget: { stepsUsed: number; stepsMax: number; spentUsd: number; capUsd: number };
  redact: Redact;
}

/** testsCurrent (§5.5): true iff no file has changed since the last parsed test run. */
export function testsCurrent(lastTestRun: LastTestRun | null, lastChangeStep: number | null): boolean {
  return lastTestRun !== null && (lastChangeStep === null || lastTestRun.step > lastChangeStep);
}

function planJson(plan: Plan): JsonObject {
  const item = (s: string): string => clip(s, STATE_LIMITS.planItemChars);
  return {
    done: plan.done.slice(-STATE_LIMITS.planItems).map((d) => ({ text: item(d.text), step: d.evidence.step })),
    remaining: plan.remaining.slice(0, STATE_LIMITS.planItems).map(item),
    unverified: plan.unverified.slice(-STATE_LIMITS.planItems).map((u) => ({ text: item(u.text), step: u.step, judged: u.judged })),
    openProblems: plan.openProblems.slice(0, 16).map(item),
    harnessProblems: plan.harnessProblems.slice(-16).map((h) => ({ kind: h.kind, text: clip(h.text, 600), step: h.step })),
  };
}

function recentJson(recent: readonly WindowEntry[]): Json[] {
  return recent.map((e) => {
    const o: JsonObject = { step: e.step, intent: e.intent, action: e.action, outcome: e.outcome, shownFiles: e.shownFiles, notes: e.notes };
    if (e.reason !== undefined) o['reason'] = e.reason;
    if (e.judge) o['judge'] = toJson(e.judge);
    if (e.completion !== undefined) o['completion'] = e.completion;
    if (e.output !== undefined) o['output'] = e.output;
    if (e.truncated) o['truncated'] = true;
    return o;
  });
}

export function buildCommonState(input: CommonStateInput): JsonObject {
  const ws = input.workspace;
  const state: JsonObject = {
    task: clip(input.task, STATE_LIMITS.taskChars),
    plan: planJson(input.plan),
    recent: recentJson(input.recent),
    workspace: {
      root: ws.root,
      git: ws.git,
      hasTests: ws.hasTests,
      testCommand: ws.testCommand,
      changedFiles: ws.changedFiles.slice(0, 100),
      createdThisRun: ws.createdThisRun.slice(0, 100),
      lastChangeStep: ws.lastChangeStep,
      lastTestRun: ws.lastTestRun ? { ...ws.lastTestRun } : null,
      testsCurrent: testsCurrent(ws.lastTestRun, ws.lastChangeStep),
      sandbox: ws.sandbox,
    },
    budget: { stepsUsed: input.budget.stepsUsed, stepsMax: input.budget.stepsMax, spentUsd: round4(input.budget.spentUsd), capUsd: input.budget.capUsd },
  };
  return redactJson(state, input.redact) as JsonObject;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

export function actionJson(proposal: Proposal): JsonObject {
  const a = proposal.action;
  const t = (s: string): string => headTail(s, STATE_LIMITS.actionTextChars, 500);
  switch (a.kind) {
    case 'read':
      return { kind: 'read', paths: a.paths.slice(0, 12) };
    case 'edit':
      return { kind: 'edit', path: a.path, old: t(a.old), new: t(a.new) };
    case 'write':
      return { kind: 'write', path: a.path, content: t(a.content) };
    case 'patch':
      return { kind: 'patch', diff: t(a.diff) };
    case 'run':
      return a.timeoutMs !== undefined ? { kind: 'run', command: t(a.command), timeoutMs: a.timeoutMs } : { kind: 'run', command: t(a.command) };
    case 'done':
      return { kind: 'done', summary: clip(a.summary, STATE_LIMITS.summaryChars) };
  }
}

function planDraftJson(draft: PlanDraft): JsonObject {
  const item = (s: string): string => clip(s, STATE_LIMITS.planItemChars);
  return { done: draft.done.slice(0, 20).map(item), remaining: draft.remaining.slice(0, 20).map(item), openProblems: draft.openProblems.slice(0, 16).map(item) };
}

/** `proposal` object shared by the risk and judge states. */
export function proposalJson(proposal: Proposal, redact: Redact): JsonObject {
  const o: JsonObject = {
    goal: clip(proposal.goal, 600),
    action: actionJson(proposal),
    planClaim: planDraftJson(proposal.plan),
    claimsDone: proposal.plan.remaining.length === 0,
  };
  return redactJson(o, redact) as JsonObject;
}

export interface IntentStateInfo {
  choice: Intent | 'none_of_these';
  probability: number;
}

export function buildIntentState(common: JsonObject): JsonObject {
  return { ...common };
}

export const CONTEXT_CRITERIA: JsonObject = {
  definition:
    'Show the file when reading it is likely to change what the engineer does on this step: it is named by the task or by `plan.remaining`, it is the file being changed or tested, it defines something the change depends on, or it was touched this run and its current content matters.',
  examples: {
    yes: [
      'the module the task asks to fix, on an edit step',
      'a test file that exercises the function being changed, on a verify step',
      'a file changed earlier this run that the next edit builds on',
      'the config or manifest an environment fix must change',
    ],
    no: [
      'an unrelated module in another package',
      'a large generated or vendored file',
      'a file already shown in `recent` that has not changed since',
      'documentation unrelated to the change on an edit step',
    ],
  },
};

export function buildContextState(common: JsonObject, intent: IntentStateInfo, candidates: readonly CandidateView[]): JsonObject {
  const cands: JsonObject = {};
  for (const c of candidates.slice(0, STATE_LIMITS.candidates)) cands[c.path] = { bytes: c.bytes, mentionsInTask: c.mentionsInTask, touchedThisRun: c.touchedThisRun };
  return { ...common, intent: { choice: intent.choice, probability: intent.probability }, candidates: cands, criteria: { context: CONTEXT_CRITERIA } };
}

function targetJson(t: TargetInfo): JsonObject {
  return { path: t.path, existsBefore: t.existsBefore, tracked: t.tracked, createdThisRun: t.createdThisRun, recoverable: t.recoverable };
}

export function buildRiskState(common: JsonObject, proposal: Proposal, intent: IntentStateInfo, targets: readonly TargetInfo[], redact: Redact): JsonObject {
  const p = proposalJson(proposal, redact);
  if (proposal.action.kind === 'patch') p['targets'] = targets.map(targetJson);
  else if (targets[0] && (proposal.action.kind === 'edit' || proposal.action.kind === 'write')) p['target'] = targetJson(targets[0]);
  return { ...common, intent: { choice: intent.choice, probability: intent.probability }, proposal: p };
}

export interface ExecutedTests {
  command: string;
  parsed: TestCounts | null;
  allPassed: boolean | null;
}

export interface ExecutedInfo {
  outcome: ActionOutcome;
  /** run: stdout+stderr; read: concatenated views; otherwise '' */
  output: string;
  changedFiles: readonly string[];
  tests: ExecutedTests | null;
}

export function execJson(exec: ExecResult | undefined): JsonObject {
  return {
    exitCode: exec?.exitCode ?? null,
    killedBy: exec?.killedBy ?? null,
    truncated: exec?.truncated ?? false,
    bytesSeen: exec?.bytesSeen ?? 0,
    sandboxExecDenied: exec?.sandboxExecDenied ?? false,
    orphans: exec?.orphans ?? [],
    durationMs: exec?.durationMs ?? 0,
  };
}

/** judge+complete state (§5.5): common (recent already includes this step) + executed + proposal + claims. */
export function buildJudgeState(common: JsonObject, proposal: Proposal, executed: ExecutedInfo, claims: readonly string[], redact: Redact): JsonObject {
  const a = proposal.action;
  let executedJson: JsonObject;
  if (executed.outcome.status === 'noop') {
    executedJson = { action: 'done', summary: clip(a.kind === 'done' ? a.summary : '', STATE_LIMITS.summaryChars), exitCode: null, output: '' };
  } else {
    const exec = executed.outcome.status === 'executed' ? executed.outcome.exec : undefined;
    executedJson = {
      action: actionJson(proposal),
      ...execJson(exec),
      output: headTail(executed.output, STATE_LIMITS.judgeOutputHead, STATE_LIMITS.judgeOutputTail),
      changedFiles: executed.changedFiles.slice(0, 100),
      tests: executed.tests
        ? {
            command: executed.tests.command,
            parsed: executed.tests.parsed ? { passed: executed.tests.parsed.passed, failed: executed.tests.parsed.failed, errors: executed.tests.parsed.errors } : null,
            allPassed: executed.tests.allPassed,
          }
        : null,
    };
  }
  const state: JsonObject = { ...common, executed: redactJson(executedJson, redact), proposal: proposalJson(proposal, redact), claims: claims.map((c) => redact(clip(c, STATE_LIMITS.planItemChars))) };
  return state;
}

export interface LoopStateInfo {
  signature: string;
  kind: string;
  occurrences: number;
  lastOutcomes: readonly (string | null)[];
  trips: number;
  priorDirectives: readonly { step: number; directive: string }[];
}

export function buildReplanState(common: JsonObject, loop: LoopStateInfo): JsonObject {
  return {
    ...common,
    trigger: 'loop',
    loop: {
      signature: loop.signature,
      kind: loop.kind,
      occurrences: loop.occurrences,
      lastOutcomes: [...loop.lastOutcomes],
      trips: loop.trips,
      priorDirectives: loop.priorDirectives.map((d) => ({ step: d.step, directive: clip(d.directive, 600) })),
    },
  };
}

/** allPassed (§5.5): parsed !== null && failed === 0 && errors === 0 && passed > 0. */
export function testsAllPassed(parsed: TestCounts | null): boolean | null {
  if (parsed === null) return null;
  return parsed.failed === 0 && parsed.errors === 0 && parsed.passed > 0;
}
