/**
 * The agent's three in-run Jev placements (docs/AGENT-LOOP-DESIGN.md §13, §A4). Each is a trivial routing call:
 *
 *   RA0 effortHint      the first turn of a run: is the message conversational? → that one turn at low effort
 *   RA1 chooseLoopNudge after a loop trip: which of four nudge wordings to send
 *   RA2 progressCheck   after 30 turns, every 10: add one "step back" hint?
 *
 * Every placement follows §13.1: routed through `routeSpeculative` with the step's route token and a quick deadline
 * (RA0 300 ms, RA1/RA2 400 ms), a named code fallback on a deadline, an error, a malformed or empty answer, skipped
 * outright when Jev is absent or disabled for the run, and never fatal — only the run's own abort or budget stop
 * propagates. A served-model drift or a question-build error disables Jev for the rest of the run (one transcript line).
 * No answer gates anything: it picks a hint text, adds one hint, or lowers one turn's effort.
 */
import type { AgentContext, Answer, JsonObject } from '../core/types.js';
import { clip } from '../core/text.js';
import { JevModelDriftError } from '../errors.js';
import { QuestionBuildError, choice, noul } from '../jev/questions.js';
import { routeSpeculative, type RouterId } from '../jev/router.js';
import {
  AGENT_PROGRESS_THRESHOLD,
  JEV_EFFORT_HINT_DEADLINE_MS,
  JEV_EFFORT_HINT_MESSAGE_CHARS,
  JEV_EFFORT_HINT_THRESHOLD,
  JEV_EFFORT_HINT_TURNS,
  JEV_NUDGE_RECENT_STEPS,
  JEV_PROGRESS_RECENT_STEPS,
  JEV_PROGRESS_TASK_CHARS,
  JEV_QUICK_DEADLINE_MS,
} from './limits.js';
import { LOOP_NUDGE_KINDS, type LoopNudgeKind } from './prompt.js';
import type { AgentStateV1 } from './state.js';

/** What the placements read about the run: step one-liners, test counts and file counts — never tool output. */
export interface RunFacts {
  recentSteps: readonly string[];
  lastTests: { passed: number; failed: number; errors: number } | null;
  testTrend: readonly string[];
  changedFiles: number;
  filesRead: number;
  filesEdited: number;
}

/** Whether a placement may ask at all (§13.1 rule 4): a key, the real decider, and no drift this run. */
function mayAsk(ctx: AgentContext, state: AgentStateV1): boolean {
  return ctx.jevAvailable && !state.jevDisabled;
}

/** §13.1 rule 2: drift and a malformed question batch turn Jev off for the run; abort and budget stops propagate. */
function absorb(ctx: AgentContext, state: AgentStateV1, id: RouterId, e: unknown): void {
  if (e instanceof JevModelDriftError || e instanceof QuestionBuildError) {
    state.jevDisabled = true;
    const why = e instanceof JevModelDriftError ? `Jev served ${e.served} instead of ${e.configured}` : 'a Jev question could not be built';
    ctx.emit({ type: 'transcript', step: ctx.step, level: 'warn', text: `${why}; the agent's quick Jev hints (${id}) are off for the rest of this run` });
    return;
  }
  throw e;
}

function choiceOf(a: Answer | undefined): string | null {
  return a !== undefined && a.type === 'choice' ? a.choice : null;
}

function noulOf(a: Answer | undefined): number | null {
  return a !== undefined && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : null;
}

// ---------------------------------------------------------------------------------------
// RA0: the first-turn effort hint (§A4)
// ---------------------------------------------------------------------------------------

function conversationalQuestion(): ReturnType<typeof noul> {
  return noul('Can this message to a coding agent be answered without reading or changing the workspace?', {
    true: {
      definition: 'a greeting, thanks, small talk, or a question about the assistant itself or general knowledge — answerable in prose right away',
      examples: ['hi there', 'who made you?', 'thanks, that looks good'],
    },
    false: {
      definition: 'a request for work in the workspace, or a question that needs its files, its tests or its history',
      examples: ['fix the failing tests', 'what does src/math.js export?', 'add a --verbose flag to the CLI'],
    },
  });
}

/** RA0: true → send the run's first turn at the provider's low reasoning effort. Fallback: false (the default effort). */
export async function effortHint(ctx: AgentContext, state: AgentStateV1): Promise<boolean> {
  if (!mayAsk(ctx, state)) return false;
  try {
    const questions = { conversational: conversationalQuestion() };
    const facts: JsonObject = {
      message: clip(ctx.task, JEV_EFFORT_HINT_MESSAGE_CHARS),
      recent_turns: (ctx.conversation?.chat ?? []).slice(-JEV_EFFORT_HINT_TURNS).map((t) => `${t.role}: ${clip(t.text.replace(/\s+/g, ' '), 200)}`),
    };
    const r = await routeSpeculative<'low' | 'default'>({
      id: 'RA0',
      token: ctx.routeToken(),
      codeOrder: ['default'],
      deadlineMs: JEV_EFFORT_HINT_DEADLINE_MS,
      signal: ctx.signal,
      ask: async (signal) => {
        // jev-contract: RA0 effort_hint (docs/AGENT-LOOP-DESIGN.md §A4)
        //   escape: one noul(); an inert 0.5 is below the 0.8 threshold, so the default effort stands
        //   guard: only the first turn's reasoning effort changes; every later turn and the tool set are code constants
        //   fallback: the default effort — test: test/unit/agent/jev.test.ts
        //   no-gating: a speed setting of one request; it gates no action, no stop and no completion
        const res = await ctx.ask(facts, questions, signal);
        const p = noulOf(res.answers['conversational']);
        return p === null ? null : [p >= JEV_EFFORT_HINT_THRESHOLD ? 'low' : 'default'];
      },
    });
    return r.order[0] === 'low';
  } catch (e) {
    absorb(ctx, state, 'RA0', e);
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// RA1: the loop-nudge wording (§13.3)
// ---------------------------------------------------------------------------------------

const NUDGE_OPTIONS: Readonly<Record<LoopNudgeKind, string>> = {
  change_approach: 'the agent keeps retrying the same thing and should try a different approach',
  gather_context: 'the agent is missing information and should read the relevant code or error output first',
  fix_environment: 'the failure looks environmental: a missing dependency, a wrong command or a wrong directory',
  revert_changes: "the agent's recent edits made things worse and it should review and revert them",
};

function isNudge(s: string | null): s is LoopNudgeKind {
  return s !== null && (LOOP_NUDGE_KINDS as readonly string[]).includes(s);
}

/** RA1: the wording of the loop nudge after a trip. Fallback: `change_approach`. */
export async function chooseLoopNudge(ctx: AgentContext, state: AgentStateV1, trip: { rule: string; tool: string; count: number }, facts: RunFacts): Promise<LoopNudgeKind> {
  if (!mayAsk(ctx, state)) return 'change_approach';
  try {
    const questions = {
      loop_nudge: choice('A coding agent repeated a tool call with the same result (a loop). Which hint is most likely to get it unstuck?', { ...NUDGE_OPTIONS }),
    };
    const snapshot: JsonObject = {
      trip: { rule: trip.rule, tool: trip.tool, count: trip.count },
      recent_steps: facts.recentSteps.slice(-JEV_NUDGE_RECENT_STEPS).map((s) => clip(s, 200)),
      last_tests: facts.lastTests,
      changed_files: facts.changedFiles,
    };
    const r = await routeSpeculative<LoopNudgeKind>({
      id: 'RA1',
      token: ctx.routeToken(),
      codeOrder: ['change_approach'],
      deadlineMs: JEV_QUICK_DEADLINE_MS,
      signal: ctx.signal,
      ask: async (signal) => {
        // jev-contract: RA1 loop_nudge (docs/AGENT-LOOP-DESIGN.md §13.3)
        //   escape: choice() over four code-enumerated nudge texts plus the escape option; the escape keeps change_approach
        //   guard: only the wording of one harness note changes; the detector and the stop bound are code
        //   fallback: change_approach — test: test/unit/agent/jev.test.ts
        //   no-gating: a note in the next user message; it gates no action, no stop and no completion
        const res = await ctx.ask(snapshot, questions, signal);
        const picked = choiceOf(res.answers['loop_nudge']);
        return isNudge(picked) ? [picked] : null;
      },
    });
    return r.order[0] ?? 'change_approach';
  } catch (e) {
    absorb(ctx, state, 'RA1', e);
    return 'change_approach';
  }
}

// ---------------------------------------------------------------------------------------
// RA2: the progress check (§13.3)
// ---------------------------------------------------------------------------------------

function unproductiveQuestion(): ReturnType<typeof noul> {
  return noul('Is this coding agent repeating actions or making no progress toward its task?', {
    true: {
      definition: 'the recent steps repeat the same reads, edits or commands, or undo each other, without moving the task forward',
      examples: ['the same test fails the same way after five edits to the same function', 'the agent re-reads the same three files every few steps and changes nothing'],
    },
    false: {
      definition: 'the recent steps make progress: new code understood, edits that change the test results, a plan being worked through',
      examples: ['each step reads or edits a different part of the code the task names', 'the failing tests went from 6 to 2 over the last steps'],
    },
  });
}

/** RA2: true → add PROGRESS_NUDGE to the next turn. Fallback: false (no hint). */
export async function progressCheck(ctx: AgentContext, state: AgentStateV1, facts: RunFacts): Promise<boolean> {
  if (!mayAsk(ctx, state)) return false;
  try {
    const questions = { unproductive: unproductiveQuestion() };
    const todo = (s: string): number => state.todos.filter((t) => t.status === s).length;
    const snapshot: JsonObject = {
      task: clip(ctx.task, JEV_PROGRESS_TASK_CHARS),
      recent_steps: facts.recentSteps.slice(-JEV_PROGRESS_RECENT_STEPS).map((s) => clip(s, 200)),
      files_read: facts.filesRead,
      files_edited: facts.filesEdited,
      test_trend: [...facts.testTrend],
      todos: { completed: todo('completed'), in_progress: todo('in_progress'), pending: todo('pending') },
    };
    const r = await routeSpeculative<'hint' | 'no_hint'>({
      id: 'RA2',
      token: ctx.routeToken(),
      codeOrder: ['no_hint'],
      deadlineMs: JEV_QUICK_DEADLINE_MS,
      signal: ctx.signal,
      ask: async (signal) => {
        // jev-contract: RA2 progress_check (docs/AGENT-LOOP-DESIGN.md §13.3)
        //   escape: one noul(); an inert 0.5 is below the 0.9 threshold, so no hint
        //   guard: at most one fixed hint text per 10 turns; nothing else changes
        //   fallback: no hint — test: test/unit/agent/jev.test.ts
        //   no-gating: a note in the next user message; it gates no action, no stop and no completion
        const res = await ctx.ask(snapshot, questions, signal);
        const p = noulOf(res.answers['unproductive']);
        return p === null ? null : [p >= AGENT_PROGRESS_THRESHOLD ? 'hint' : 'no_hint'];
      },
    });
    return r.order[0] === 'hint';
  } catch (e) {
    absorb(ctx, state, 'RA2', e);
    return false;
  }
}
