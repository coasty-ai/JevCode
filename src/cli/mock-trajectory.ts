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
 *
 * Agent mode (AGENT-LOOP-DESIGN §14.4, §15 S5, §A1): `mockAgentTurns` scripts NATIVE multi-call turns (`MockTurn.toolCalls`, streamed
 * and returned with ids by the mock provider, slice S2) and picks them per run from the message itself, the way every chat message
 * becomes an agent run: a greeting or a question gets one prose-only turn (the run ends `answered`), anything else the five-turn
 * task — prose + two parallel `read_file` + `todo_write`; `write_file`; a read-only `bash` (`ls`) + a mutating `bash` that exits 0;
 * `edit_file`; prose. With `JEVCODE_MOCK_CHAT_STREAM` set, the run's FIRST prose turn streams the preset at the configured gaps, so
 * the stream-latency probe measures the agent-mode reply. The `propose_action` trajectory above stays for the legacy modes.
 */
import { writeFileSync } from 'node:fs';
import type { Action, GenerateRequest, Json, MockTurn, PlanDraft } from '../core/types.js';
import { streamPreset, streamPresetName, type StreamPresetName } from '../perf/stream-fixture.js';
import { MOCK_CHAT_REPLY, type MockEmit } from '../provider/mock.js';

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

// ---------------------------------------------------------------------------------------
// Agent mode (AGENT-LOOP-DESIGN §14.4, §15 S5): native tool calls, one trajectory per run
// ---------------------------------------------------------------------------------------

/** the one file the agent task trajectory creates, edits and leaves behind (it touches nothing it did not create) */
export const MOCK_AGENT_FILE = 'scratch_agent.py';
/** the file the trajectory's mutating `bash` writes */
export const MOCK_AGENT_LOG = 'scratch_agent.log';
/** the task trajectory's opening prose (turn 1, before its calls) */
export const MOCK_AGENT_OPENING = "I'll read the workspace first, then make the change.";
/** the task trajectory's closing prose (turn 5, no calls): the run's answer */
export const MOCK_AGENT_CLOSING = `Done: created ${MOCK_AGENT_FILE}, checked the shell and set VALUE to 2.`;

const MOCK_TURN_USAGE = { inputTokens: 1200, outputTokens: 150, costUsd: 0, calls: 1 } as const;

/** a greeting, thanks or small talk, alone or with a word or two — answered in prose, no tools (the mock's heuristic only; the real model decides for itself) */
const MOCK_AGENT_GREETING_RE = /^\s*(hi|hello|hey|yo|thanks?|thank you|bye|ok(ay)?|cool|nice|great|perfect|awesome|lol|good (morning|evening|afternoon))\b[\s!.,]*(\w+[\s!.,]*){0,2}$/i;
/** a question by its opener (`who made you` has no `?`) */
const MOCK_AGENT_QUESTION_RE = /^\s*(?:who|whom|whose|what|which|why|how|when|where|can|could|is|are|am|was|were|do|does|did|should|would|will)\b/i;

/** true when the mock answers `text` with one prose-only turn (a reply); false when it runs the task trajectory */
export function isMockConversational(text: string): boolean {
  const t = text.trim();
  return t === '' || MOCK_AGENT_GREETING_RE.test(t) || /\?\s*$/.test(t) || MOCK_AGENT_QUESTION_RE.test(t);
}

/**
 * The task text of an agent request: the last `# New task` / `# Task` section of the last user message (AGENT-LOOP-DESIGN §5.3,
 * §7.6), else that message's whole text; a legacy request's last user message; '' when there is none.
 */
export function mockTaskText(req: Pick<GenerateRequest, 'messages' | 'agent'>): string {
  let text = '';
  if (req.agent !== undefined) {
    for (let i = req.agent.messages.length - 1; i >= 0; i--) {
      const m = req.agent.messages[i]!;
      if (m.role !== 'user') continue;
      const parts = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
      if (parts.length === 0) continue;
      text = parts.join('\n');
      break;
    }
  } else {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i]!;
      if (m.role === 'user') {
        text = m.content;
        break;
      }
    }
  }
  const sections = [...text.matchAll(/^# (?:New task|Task)[ \t]*\n([\s\S]*?)(?=\n# |$(?![\s\S]))/gm)];
  const last = sections.at(-1);
  return (last?.[1] ?? text).trim();
}

function call(turn: number, k: number, name: string, input: Json): { id: string; name: string; input: Json; rawJson: string } {
  return { id: `mock-t${turn}-${k}`, name, input, rawJson: JSON.stringify(input) };
}

/** a turn's prose: the stream preset's timed deltas when the probe set one (the run's first prose turn), else `text` */
function prose(text: string, latencyMs: number, stream: MockTurn | undefined): Pick<MockTurn, 'text' | 'deltas' | 'deltaGapMs' | 'latencyMs'> {
  if (stream?.deltas !== undefined) return { deltas: stream.deltas, ...(stream.deltaGapMs !== undefined ? { deltaGapMs: stream.deltaGapMs } : {}), ...(latencyMs > 0 ? { latencyMs } : {}) };
  return { text, ...(latencyMs > 0 ? { latencyMs } : {}) };
}

/**
 * The five-turn agent task of the design (§15 S5): (1) prose + two parallel `read_file` + a `todo_write`; (2) `write_file`;
 * (3) a read-only `bash` (`ls`) + a mutating `bash` that exits 0; (4) `edit_file`; (5) prose only. `stream` (the stream probe's
 * preset turn) replaces the opening prose.
 */
export function mockAgentTaskTurns(latencyMs: number = mockStepMs(process.env), stream?: MockTurn): MockTurn[] {
  const lat = latencyMs > 0 ? { latencyMs } : {};
  const todos: Json = {
    todos: [
      { content: `create ${MOCK_AGENT_FILE}`, status: 'in_progress' },
      { content: 'check the shell works', status: 'pending' },
      { content: `edit ${MOCK_AGENT_FILE}`, status: 'pending' },
    ],
  };
  return [
    {
      ...prose(`${MOCK_AGENT_OPENING}\n`, latencyMs, stream),
      toolCalls: [call(1, 0, 'read_file', { path: 'README.md' }), call(1, 1, 'read_file', { path: 'package.json' }), call(1, 2, 'todo_write', todos)],
      usage: MOCK_TURN_USAGE,
      stopReason: 'tool_use',
    },
    { toolCalls: [call(2, 0, 'write_file', { path: MOCK_AGENT_FILE, content: 'VALUE = 1\n' })], usage: MOCK_TURN_USAGE, stopReason: 'tool_use', ...lat },
    {
      toolCalls: [call(3, 0, 'bash', { command: 'ls', description: 'list the workspace' }), call(3, 1, 'bash', { command: `printf 'ok\\n' > ${MOCK_AGENT_LOG}`, description: 'check the shell works' })],
      usage: MOCK_TURN_USAGE,
      stopReason: 'tool_use',
      ...lat,
    },
    { toolCalls: [call(4, 0, 'edit_file', { path: MOCK_AGENT_FILE, old_string: 'VALUE = 1', new_string: 'VALUE = 2' })], usage: MOCK_TURN_USAGE, stopReason: 'tool_use', ...lat },
    { text: `${MOCK_AGENT_CLOSING}\n`, usage: MOCK_TURN_USAGE, stopReason: 'end_turn', ...lat },
  ];
}

/** The prose-only reply turn (a greeting or a question): the stream probe's preset when set, else `MOCK_CHAT_REPLY`. */
export function mockAgentReplyTurn(latencyMs: number = mockStepMs(process.env), stream?: MockTurn): MockTurn {
  return { ...prose(MOCK_CHAT_REPLY, latencyMs, stream), usage: MOCK_TURN_USAGE, stopReason: 'end_turn' };
}

/**
 * The `--mock` provider's turns under `--mode agent` (function form, `MockProviderOptions.turns`). One provider is built per run
 * (`buildProvider`), so the closure's cursor is the run's: the first tool-offering request picks the trajectory from the task
 * text — a reply turn for a greeting or a question, the five task turns otherwise — and later requests walk it; past its end the
 * closing prose repeats (a continuation never fails the run). A request with no tools (a compaction writer) gets prose and
 * leaves the cursor where it was.
 */
export function mockAgentTurns(stream?: MockTurn, latencyMs: number = mockStepMs(process.env)): (req: GenerateRequest) => MockTurn {
  let plan: MockTurn[] | null = null;
  let i = 0;
  return (req: GenerateRequest): MockTurn => {
    if (req.tools === undefined || req.tools.length === 0) return { text: MOCK_CHAT_REPLY, usage: MOCK_TURN_USAGE, stopReason: 'end_turn' };
    plan ??= isMockConversational(mockTaskText(req)) ? [mockAgentReplyTurn(latencyMs, stream)] : mockAgentTaskTurns(latencyMs, stream);
    const turn = plan[i] ?? plan[plan.length - 1]!;
    i += 1;
    return turn;
  };
}
