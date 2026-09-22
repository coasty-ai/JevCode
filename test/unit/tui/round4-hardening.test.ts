/**
 * TUI-DESIGN-4 §7.8 (P-D8) and §7.13 (a, b) — S6's pure halves of the App-level hardening.
 *
 * The App wiring itself (`abortRun`, the `.finally()`, `EXIT_NOW_130`, the `guard()` latch) lives in
 * `src/tui/App.tsx`, which is S1's file this round; §9.2 routes those rows to S1's W3 PR. What is testable here
 * is the reducer's bounds and the watchdog's arithmetic, which is where the two defects actually are.
 */
import { describe, expect, it } from 'vitest';
import type { Decision, EngineEvent } from '../../../src/core/types.js';
import type { TranscriptItem } from '../../../src/tui/plain.js';
import {
  DECISIONS_PER_STEP_KEPT,
  DECISION_STEPS_KEPT,
  NOTHING_TO_ABORT_TOAST,
  STATIC_SOFT_CAP,
  SUBMIT_WATCHDOG_ENV_VAR,
  SUBMIT_WATCHDOG_MAX_MS,
  SUBMIT_WATCHDOG_MIN_MS,
  SUBMIT_WATCHDOG_MS,
  initialUiState,
  submitWatchdogDue,
  submitWatchdogLine,
  submitWatchdogMs,
  uiReducer,
  type UiState,
} from '../../../src/tui/useEngine.js';
import { mkDecision } from '../../fixtures/tui/fixtures.js';

const T0 = 1_000_000;
const ev = (event: EngineEvent) => ({ type: 'event' as const, event, at: T0 });
const decision = (step: number, i: number): Decision => mkDecision({ step, id: `steer-${i}` });
const start = (): UiState => initialUiState('t', null, { nowMs: T0 });

describe('§7.13 (b): a steer storm inside one step is bounded', () => {
  it('keeps the last DECISIONS_PER_STEP_KEPT decisions of a step and the last DECISION_STEPS_KEPT steps', () => {
    let s = start();
    const n = DECISIONS_PER_STEP_KEPT + 500;
    for (let i = 0; i < n; i++) s = uiReducer(s, ev({ type: 'decision', decision: decision(1, i) }));
    const step1 = s.decisionsByStep.get(1) ?? [];
    expect(step1).toHaveLength(DECISIONS_PER_STEP_KEPT);
    // the newest survive: `/why` reads the tail
    expect(step1.at(-1)?.id).toBe(`steer-${n - 1}`);
    expect(step1[0]?.id).toBe(`steer-${n - DECISIONS_PER_STEP_KEPT}`);
    // the step bound is unchanged
    for (const step of [2, 3, 4, 5]) s = uiReducer(s, ev({ type: 'decision', decision: decision(step, 0) }));
    expect([...s.decisionsByStep.keys()].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(DECISION_STEPS_KEPT).toBe(3);
  });
});

describe('§7.8 (P-D8): the submission watchdog', () => {
  it('fires only after the window, on a monotonic clock, and never without a sign of life to measure from', () => {
    expect(SUBMIT_WATCHDOG_MS).toBe(45_000);
    expect(submitWatchdogDue(1_000, 1_000 + SUBMIT_WATCHDOG_MS - 1)).toBe(false);
    expect(submitWatchdogDue(1_000, 1_000 + SUBMIT_WATCHDOG_MS)).toBe(true);
    expect(submitWatchdogDue(1_000, 1_000 + SUBMIT_WATCHDOG_MS + 10_000)).toBe(true);
    // no submission in flight
    expect(submitWatchdogDue(null, 1_000_000)).toBe(false);
    // edges 1 and 2 — any live byte, thinking change or retry row resets `lastSignMs`, so the window restarts
    // (MINIMAL, MARKED, NOT S4's FILE: the colon before `any` tripped `scripts/no-any.mjs`, which must stay green)
    const submittedAt = 1_000;
    const firstToken = submittedAt + 40_000;
    expect(submitWatchdogDue(firstToken, submittedAt + SUBMIT_WATCHDOG_MS)).toBe(false);
    // edge 4: the deadline is `performance.now()`-shaped; a Date.now-sized value with a non-finite partner is inert
    expect(submitWatchdogDue(Number.NaN, 1_000)).toBe(false);
    expect(submitWatchdogDue(1_000, Number.NaN)).toBe(false);
    // a custom window (the pty scenario shortens it)
    expect(submitWatchdogDue(0, 2_000, 2_000)).toBe(true);
  });

  it('§12: the row and the toast are the design`s strings', () => {
    expect(submitWatchdogLine()).toBe('the request has not answered in 45s — Esc cancels it, or press Ctrl-C twice to leave');
    expect(submitWatchdogLine(10_000)).toBe('the request has not answered in 10s — Esc cancels it, or press Ctrl-C twice to leave');
    expect(NOTHING_TO_ABORT_TOAST).toBe('nothing to abort');
  });
});

describe('§7.13 (a): the `<Static>` soft cap is a bound, and the comment now says so', () => {
  it('past the cap the array restarts with a new epoch — `UiState.items` is not an /export archive', () => {
    let s = start();
    const item = (i: number): TranscriptItem => ({ kind: 'notice', key: `k${i}`, seq: i, step: null, label: '[ui]', text: `row ${i}`, level: 'info', local: true });
    for (let i = 0; i <= STATIC_SOFT_CAP; i++) s = uiReducer(s, { type: 'local-item', item: item(i) });
    expect(s.staticEpoch).toBeGreaterThan(0);
    expect(s.items.length).toBeLessThanOrEqual(STATIC_SOFT_CAP);
  });
});

/**
 * TUI-DESIGN-4 §7.8 (review finding 6): `test/pty/smoke/stuck-submit.steps` sets
 * `JEVCODE_SUBMIT_WATCHDOG_MS=1500` because a 45 s wait does not fit `drive.exp`'s 60 s budget — and nothing in
 * `src/` read it, so the scenario could not pass however the App wiring landed. The seam is here, clamped, and
 * `run-smoke.sh` unsets the variable for every other scenario.
 */
describe('§7.8: the watchdog window has a clamped development override', () => {
  it('defaults to 45 s, takes a sane override, and ignores a typo', () => {
    expect(SUBMIT_WATCHDOG_ENV_VAR).toBe('JEVCODE_SUBMIT_WATCHDOG_MS');
    expect(submitWatchdogMs({})).toBe(SUBMIT_WATCHDOG_MS);
    expect(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '' })).toBe(SUBMIT_WATCHDOG_MS);
    expect(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '1500' })).toBe(1500);
    // a typo must never silently disable the watchdog or make it fire on every slow first token
    expect(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: 'soon' })).toBe(SUBMIT_WATCHDOG_MS);
    expect(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '0' })).toBe(SUBMIT_WATCHDOG_MIN_MS);
    expect(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '-5' })).toBe(SUBMIT_WATCHDOG_MIN_MS);
    expect(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '99999999' })).toBe(SUBMIT_WATCHDOG_MAX_MS);
    // the line follows the effective window, so the pty scenario's row says 2s, not 45s
    expect(submitWatchdogLine(submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '1500' }))).toContain('has not answered in 2s');
    expect(submitWatchdogDue(0, 1500, submitWatchdogMs({ JEVCODE_SUBMIT_WATCHDOG_MS: '1500' }))).toBe(true);
  });
});
