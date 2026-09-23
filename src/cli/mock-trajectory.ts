/**
 * Scripted generator turns for offline runs (`--mock`, perf, tests): a cycle of
 * write -> read -> run -> edit that touches only files it created, ending with `done`.
 * Every turn is a tool call so the tool-calling path is what gets measured.
 *
 * Step pacing (TUI-DESIGN §18, `src/perf/render-lag.ts`): `JEVCODE_MOCK_STEP_MS=<ms>` gives every turn that
 * `latencyMs` (`MockTurn.latencyMs`, honoured by `src/provider/mock.ts` as one awaited sleep before the delta), so a
 * mocked run paces its steps — `200` is about 5 steps/s with the instant mock decider, still ten times faster than a
 * real run. Unset, empty or not a whole number → 0, today's zero-latency behaviour, so every existing test and smoke is
 * unchanged. Read here rather than in `buildProvider` (`src/cli/session.ts`) because this is the one seam every `--mock`
 * provider goes through; `mockTrajectory(steps, latencyMs)` takes the value explicitly for callers with their own env.
 *
 * Streamed chat replies (`src/perf/stream-latency.ts`): `mockChatReplyFromEnv` turns three knobs into the `--mock`
 * chat turn — `JEVCODE_MOCK_CHAT_STREAM=<preset>` (`mixed` | `long`, `src/perf/stream-fixture.ts`) streams that reply's
 * deltas, `JEVCODE_MOCK_DELTA_MS=<ms>` is the gap between them (default 30), and `JEVCODE_PERF_STREAM_LOG=<path>`
 * collects each delta's emission time (`process.hrtime.bigint()`) in memory and writes them once, at process exit, so
 * no file write ever sits between an emission and its paint. They are read here, in the one seam of the mock
 * provider, so they are honoured only under `--mock`; unset (or an unknown preset), the chat reply is the one-delta
 * `MOCK_CHAT_REPLY` and every existing smoke and pty test is byte-unchanged.
 */
import { writeFileSync } from 'node:fs';
import type { Action, MockTurn, PlanDraft } from '../core/types.js';
import { streamPreset, streamPresetName, type StreamPresetName } from '../perf/stream-fixture.js';
import type { MockEmit } from '../provider/mock.js';

/** `JEVCODE_MOCK_STEP_MS` as a non-negative whole number of milliseconds; 0 when unset or malformed. */
export function mockStepMs(env: NodeJS.ProcessEnv): number {
  const v = env['JEVCODE_MOCK_STEP_MS'];
  if (v === undefined) return 0;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return 0;
  return Number(t);
}

function turn(goal: string, action: Action, plan: PlanDraft, latencyMs: number): MockTurn {
  return {
    text: `${goal}\n`,
    toolCall: { name: 'propose_action', input: { goal, action: action as unknown as Record<string, string>, plan } as never, rawJson: JSON.stringify({ goal, action, plan }) },
    usage: { inputTokens: 1200, outputTokens: 150, costUsd: 0, calls: 1 },
    ...(latencyMs > 0 ? { latencyMs } : {}),
  };
}

/**
 * TUI-DESIGN-4 §6.9: `JEVCODE_MOCK_PATCH=1` extends the cycle with two `patch` turns — one that edits two files at
 * once and one that is deliberately unappliable — so the patch card, the patch title and the patch failure text get
 * pty coverage. **Off by default**, so every existing smoke and perf number is byte-unchanged (edge 1).
 */
export function mockPatchEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['JEVCODE_MOCK_PATCH'] === '1';
}

/** §6.9: the two-file patch of turn 5 — it modifies the scratch file turn 4 last edited and creates one new file. */
export function mockTwoFilePatch(target: number, from: number, to: number): string {
  return [
    `--- a/scratch_${target}.py`,
    `+++ b/scratch_${target}.py`,
    '@@ -1 +1 @@',
    `-VALUE_${target} = ${from}`,
    `+VALUE_${target} = ${to}`,
    '--- /dev/null',
    `+++ b/notes_${to}.md`,
    '@@ -0,0 +1 @@',
    `+patched at step ${to}`,
    '',
  ].join('\n');
}

/** §6.9: the patch that must fail at `git apply --check`, leaving the tree clean (edge 3). */
export function mockBadPatch(target: number): string {
  return [`--- a/scratch_${target}.py`, `+++ b/scratch_${target}.py`, '@@ -1 +1 @@', '-THIS LINE IS NOT IN THE FILE', '+nor is this one', ''].join('\n');
}

export function mockTrajectory(steps: number, latencyMs: number = mockStepMs(process.env), patch: boolean = mockPatchEnabled(process.env)): MockTurn[] {
  const turns: MockTurn[] = [];
  const remaining = ['create the scratch module', 'exercise it', 'verify with a command'];
  const cycle = patch ? 6 : 4;
  for (let i = 0; i < Math.max(1, steps - 1); i++) {
    const k = i % cycle;
    const plan: PlanDraft = { done: [], remaining, openProblems: [] };
    if (k === 0) turns.push(turn(`Create scratch_${i}.py`, { kind: 'write', path: `scratch_${i}.py`, content: `VALUE_${i} = ${i}\n` }, plan, latencyMs));
    else if (k === 1) turns.push(turn(`Read scratch_${i - 1}.py`, { kind: 'read', paths: [`scratch_${i - 1}.py`] }, plan, latencyMs));
    else if (k === 2) turns.push(turn('Check the shell works', { kind: 'run', command: `printf 'ok %s\\n' ${i}` }, plan, latencyMs));
    else if (k === 3) turns.push(turn(`Edit scratch_${i - 3}.py`, { kind: 'edit', path: `scratch_${i - 3}.py`, old: `VALUE_${i - 3} = ${i - 3}`, new: `VALUE_${i - 3} = ${i}` }, plan, latencyMs));
    else if (k === 4) turns.push(turn(`Patch scratch_${i - 4}.py and add notes_${i}.md`, { kind: 'patch', diff: mockTwoFilePatch(i - 4, i - 1, i) }, plan, latencyMs));
    else turns.push(turn(`Patch scratch_${i - 5}.py (this one does not apply)`, { kind: 'patch', diff: mockBadPatch(i - 5) }, plan, latencyMs));
  }
  turns.push(turn('All done', { kind: 'done', summary: 'scratch work complete' }, { done: remaining, remaining: [], openProblems: [] }, latencyMs));
  return turns;
}

/** `JEVCODE_MOCK_DELTA_MS` when unset or malformed: the stream probe's slow series (a delta every 30 ms, ~33 tokens/s) */
export const MOCK_DELTA_MS_DEFAULT = 30;

/** The `--mock` chat turn and its emission hook (`src/cli/session.ts` `buildProvider`). */
export interface MockChatSetup {
  /** undefined = `withMockChat`'s default, the one-delta `MOCK_CHAT_REPLY` */
  reply?: MockTurn;
  /** set only with `JEVCODE_PERF_STREAM_LOG` and a preset */
  onEmit?: (e: MockEmit) => void;
}

/** One emission as the log file carries it: the stream (one per chat turn), the delta, its length, its `hrtime` in ns. */
export interface StreamLogEmission {
  s: number;
  i: number;
  chars: number;
  ns: string;
}

/** The JSON written to `JEVCODE_PERF_STREAM_LOG` at exit. */
export interface StreamLogFile {
  preset: StreamPresetName;
  gapMs: number;
  deltas: number;
  emissions: StreamLogEmission[];
}

interface StreamLog {
  path: string;
  preset: StreamPresetName;
  gapMs: number;
  deltas: number;
  streams: number;
  records: { s: number; i: number; chars: number; ns: bigint }[];
}

/** one log per process: every `buildProvider` call (one per chat turn) appends to it, and one exit hook writes it */
let streamLog: StreamLog | null = null;

function streamLogFileOf(log: StreamLog): StreamLogFile {
  return { preset: log.preset, gapMs: log.gapMs, deltas: log.deltas, emissions: log.records.map((r) => ({ s: r.s, i: r.i, chars: r.chars, ns: r.ns.toString() })) };
}

/** The emission log collected so far in this process, as the exit hook writes it; null when no log was asked for. */
export function streamLogSnapshot(): StreamLogFile | null {
  return streamLog === null ? null : streamLogFileOf(streamLog);
}

function streamLogHook(path: string, preset: StreamPresetName, gapMs: number, deltas: number): (e: MockEmit) => void {
  if (streamLog === null || streamLog.path !== path) {
    const log: StreamLog = { path, preset, gapMs, deltas, streams: 0, records: [] };
    streamLog = log;
    process.once('exit', () => {
      try {
        writeFileSync(log.path, JSON.stringify(streamLogFileOf(log)));
      } catch {
        // evidence only: the probe reports a missing log as a failed series
      }
    });
  }
  const log = streamLog;
  // the hot path: one array push, no formatting (the bigint is stringified at exit)
  return (e: MockEmit): void => {
    if (e.i === 0) log.streams += 1;
    log.records.push({ s: log.streams - 1, i: e.i, chars: e.chars, ns: e.ns });
  };
}

/**
 * The `--mock` chat turn from the environment: `{}` (today's `MOCK_CHAT_REPLY`) unless `JEVCODE_MOCK_CHAT_STREAM` names a
 * preset, then the preset's deltas at `JEVCODE_MOCK_DELTA_MS` apart, plus the emission log when `JEVCODE_PERF_STREAM_LOG`
 * names a file.
 */
export function mockChatReplyFromEnv(env: NodeJS.ProcessEnv): MockChatSetup {
  const preset = streamPresetName(env['JEVCODE_MOCK_CHAT_STREAM']);
  if (preset === null) return {};
  const raw = env['JEVCODE_MOCK_DELTA_MS']?.trim();
  const gapMs = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : MOCK_DELTA_MS_DEFAULT;
  const { deltas } = streamPreset(preset);
  const reply: MockTurn = { deltas, deltaGapMs: gapMs };
  const path = env['JEVCODE_PERF_STREAM_LOG']?.trim();
  return path === undefined || path === '' ? { reply } : { reply, onEmit: streamLogHook(path, preset, gapMs, deltas.length) };
}
