/**
 * The agent's loop detector and the progress-check schedule (docs/AGENT-LOOP-DESIGN.md §3.6).
 *
 * A call's signature is `sha12(name, canonical arguments, result)`, so a call whose result changes — the next page of a
 * file, a re-read after an edit, 6/10 failing becoming 8/10 — is never a loop. It trips on:
 *
 *   (a) the last 3 signed calls identical (OpenCode's `DOOM_LOOP_THRESHOLD`, plus the result);
 *   (b) one signature more than 5 times in the last 10 signed calls (Crush's rule; it catches A-B-A-B alternation).
 *
 * The window is cleared after a trip. `todo_write` is never signed. A trip only nudges; the engine stops the run as
 * `stuck` at the AGENT_MAX_LOOP_NUDGES-th trip. The legacy detector (src/loop/loopdetect.ts) is not used in this mode;
 * only its `testFailureIdentity` is, so a test run's signature is its failing set.
 */
import type { AgentToolName, ExecResult, Json, JsonObject, LoopTrip, TestRunner } from '../core/types.js';
import { sha12 } from '../core/hash.js';
import { testFailureIdentity } from '../loop/loopdetect.js';
import { AGENT_LOOP_CONSECUTIVE, AGENT_LOOP_WINDOW, AGENT_LOOP_WINDOW_MAX, AGENT_PROGRESS_EVERY, AGENT_PROGRESS_FIRST_TURN } from './limits.js';

/** `bash` arguments compare with the command's whitespace collapsed; everything else as sent (keys sorted by sha12). */
export function canonicalArgs(name: AgentToolName | 'invalid', args: JsonObject): Json {
  if (name !== 'bash') return args;
  const command = typeof args['command'] === 'string' ? args['command'].replace(/\s+/g, ' ').trim() : '';
  return { command, workdir: typeof args['workdir'] === 'string' ? args['workdir'] : '.' };
}

/** `sha12(name, canonical(arguments), resultHash)`; `sha12` serialises with sorted keys, so argument order never matters. */
export function callSignature(name: AgentToolName | 'invalid', args: JsonObject, resultHash: string): string {
  return sha12([name, canonicalArgs(name, args), resultHash]);
}

/** The result half of a signature (§3.6 table). A failing run of the detected test command is its failing set. */
export function resultHash(o: { kind: 'text'; text: string } | { kind: 'refused' } | { kind: 'test'; command: string; exec: Pick<ExecResult, 'stdout' | 'stderr'>; runner: TestRunner | null; fallback: string }): string {
  if (o.kind === 'refused') return 'refused';
  if (o.kind === 'text') return sha12(o.text);
  const identity = testFailureIdentity(o.command, o.exec, o.runner);
  return identity !== null ? sha12(`fail:${identity}`) : sha12(o.fallback);
}

export interface LoopFeed {
  name: AgentToolName | 'invalid';
  signature: string;
  /** the detected test command, when this call ran it and it failed (the nudge's wording names it) */
  testCommand: string | null;
}

export interface LoopTripWithTest extends LoopTrip {
  testCommand: string | null;
}

/**
 * Feed one signed call. `window` (mutated in place) holds the signatures of the last 10 signed calls before this one;
 * rule (b) counts this call against them, so a strict A-B alternation trips at the 6th A (5 in the window + this one),
 * which a window that already contained the call could never reach. Returns the trip, and clears the window, when it trips.
 */
export function feedLoop(window: string[], call: LoopFeed): LoopTripWithTest | null {
  if (call.name === 'todo_write') return null;
  const previous = window.slice(-(AGENT_LOOP_CONSECUTIVE - 1));
  const repeat = previous.length === AGENT_LOOP_CONSECUTIVE - 1 && previous.every((s) => s === call.signature);
  const count = window.filter((s) => s === call.signature).length + 1;
  window.push(call.signature);
  while (window.length > AGENT_LOOP_WINDOW) window.shift();
  if (repeat) {
    window.length = 0;
    return { signature: call.signature, count: AGENT_LOOP_CONSECUTIVE, rule: 'repeat', tool: call.name, testCommand: call.testCommand };
  }
  if (count > AGENT_LOOP_WINDOW_MAX) {
    window.length = 0;
    return { signature: call.signature, count, rule: 'window', tool: call.name, testCommand: call.testCommand };
  }
  return null;
}

/** §3.6: RA2 is due after 30 turns, then every 10 turns. */
export function progressCheckDue(turns: number, lastProgressTurn: number | null): boolean {
  if (turns < AGENT_PROGRESS_FIRST_TURN) return false;
  return lastProgressTurn === null || turns - lastProgressTurn >= AGENT_PROGRESS_EVERY;
}

/** The trip as the step record and `loop:tripped` carry it (the test command only words the nudge). */
export function toLoopTrip(t: LoopTripWithTest): LoopTrip {
  return { signature: t.signature, count: t.count, rule: t.rule, tool: t.tool };
}
