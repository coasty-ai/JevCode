/**
 * docs/AGENT-LOOP-DESIGN.md §6.1, §7.6, §9.2, §14, §15 S1: the agent loop's shared contract and its mode data.
 *
 * S1 is what the provider, agent-core, engine and TUI slices code against, so this file pins three things:
 *  - every allow-list that rejects an unknown mode silently (§14.1: "missing one breaks resume or the session picker
 *    without a type error") accepts `agent`, and `stuck` folds like every other stop reason;
 *  - the new shapes exist with the design's exact spellings — types have no runtime, so each is exercised by a value
 *    that must compile (a misspelt member is a tsc error in `npm run typecheck`, which includes test/);
 *  - the absent decider and the agent stub behave as §14.2 / §15 S1 say, and nothing about a legacy mode moved.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentDriver } from '../../../src/agent/index.js';
import { HOW_TO_TASK_SUFFIX, MODE_SENTENCE } from '../../../src/chat/facts.js';
import { isCheckpointState, isRunMeta, parseEnvelope, serialiseEnvelope } from '../../../src/checkpoint/store.js';
import { MODES, parseCliArgs } from '../../../src/cli/args.js';
import { commandConfigSet, type CommandIo } from '../../../src/cli/login.js';
import { MODE_SET_ITEM } from '../../../src/cli/session.js';
import {
  ADVERTISED_MODES,
  AGENT_DEFAULT_MAX_STEPS,
  DEFAULT_MAX_STEPS,
  LEGACY_MODES,
  MODE_BADGE_MAX_CELLS,
  MODE_BADGE_WORD,
  MODE_SETTING_VALUES,
  settingProblem,
  settingSpec,
} from '../../../src/config/defaults.js';
import { isEngineMode, readConfigFile, resolveMode } from '../../../src/config/resolve.js';
import { parseModeSetting } from '../../../src/config/validate.js';
import type {
  Action,
  AgentAssistantBlock,
  AgentCallSummary,
  AgentContext,
  AgentDriver,
  AgentDriverFactory,
  AgentGate,
  AgentGenerateHooks,
  AgentMessage,
  AgentNext,
  AgentObservation,
  AgentObserveResult,
  AgentRequest,
  AgentToolName,
  AgentUserBlock,
  AskOptions,
  BenchCondition,
  CheckpointState,
  ConversationCarry,
  EngineEvent,
  EngineMode,
  EngineOptions,
  GenerateOptions,
  GenerateReasoning,
  GenerateRequest,
  GenerateResult,
  LoopTrip,
  MockTurn,
  Proposal,
  ProviderReplayState,
  RiskAssessment,
  RiskDimension,
  RiskDimensionResult,
  RunCounters,
  StageName,
  StepAgentSummary,
  StepProposer,
  StepRecord,
  StopReason,
  ToolCall,
  ToolCallDelta,
} from '../../../src/core/types.js';
import { EXIT_CODES, JevError, JevHttpError } from '../../../src/errors.js';
import { ABSENT_DECIDER_MODEL, JevUnavailableError, createAbsentDecider } from '../../../src/jev/absent.js';
import { createStepToken, isRouterFatal, routeSpeculative } from '../../../src/jev/router.js';
import { exitCodeFor } from '../../../src/loop/stop.js';
import { effortOf } from '../../../src/provider/openai-compat.js';
import { openAiReasoningEffort } from '../../../src/provider/openai.js';
import { buildManifest, manifestPath, readManifest, writeManifest, type ManifestIo } from '../../../src/orchestrate/manifest.js';
import type { AgentSpec } from '../../../src/orchestrate/types.js';
import { STOP_REASONS, foldIndex, isStopReason, parseIndexLine, readIndex, reindex, type IndexLine } from '../../../src/session/index.js';
import { MODE_VALUE_HINTS } from '../../../src/tui/commands/registry.js';
import { makeMeta, makeState, runId, spend } from '../session/helpers.js';

const ROOT = join(import.meta.dirname, '../../..');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-agent-contract-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// §14.1 mode data
// ---------------------------------------------------------------------------------------

describe('§14.1: agent is accepted everywhere; the advertised and legacy lists partition the accepted modes', () => {
  it('MODE_SETTING_VALUES appends agent; ADVERTISED_MODES ∪ LEGACY_MODES equals it, with no overlap', () => {
    expect(MODE_SETTING_VALUES).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent']);
    expect(ADVERTISED_MODES).toEqual(['agent', 'jev-only']);
    expect(LEGACY_MODES).toEqual(['llm-jev', 'jev-on', 'jev-off']);
    const union: string[] = [...ADVERTISED_MODES, ...LEGACY_MODES];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...MODE_SETTING_VALUES].sort());
  });

  it('--mode / --condition, the settings shape, the config reader and isEngineMode accept agent; unknown modes stay refused', () => {
    expect(MODES).toEqual(['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent']);
    expect(parseCliArgs(['run', 'fix the tests', '--mode', 'agent']).mode).toBe('agent');
    expect(parseCliArgs(['run', 'fix the tests', '--condition', 'AGENT']).mode).toBe('agent');
    expect(() => parseCliArgs(['run', 'fix the tests', '--mode', 'agents'])).toThrow(/--mode: expected one of jev-only\|jev-on\|jev-off\|llm-jev\|agent/);
    expect(settingProblem(settingSpec('mode'), 'agent')).toBeNull();
    expect(settingProblem(settingSpec('mode'), 'turbo')).not.toBeNull();
    expect(parseModeSetting({ value: ' Agent ', source: 'env' })).toBe('agent');
    expect(() => parseModeSetting({ value: 'turbo', source: 'env' })).toThrow('mode: "turbo" (from env) is not one of jev-only|jev-on|jev-off|llm-jev|agent');
    expect(isEngineMode('agent')).toBe(true);
    expect(isEngineMode('turbo')).toBe(false);
  });

  it('`jevcode config set mode agent` validates: it writes the file and the next resolution reads mode agent', async () => {
    const home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    const out: string[] = [];
    const err: string[] = [];
    const io: CommandIo = {
      stdin: new PassThrough(),
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { XDG_CONFIG_HOME: join(home, 'xdg') },
      home,
      cwd: dir,
      platform: 'darwin',
    };
    expect(await commandConfigSet('mode', 'agent', io)).toBe(EXIT_CODES.ok);
    expect(err).toEqual([]);
    expect(out.join('')).toBe('mode = agent  (file:~/xdg/jevcode/config.json)\n');
    const path = join(home, 'xdg', 'jevcode', 'config.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ mode: 'agent' });
    const file = await readConfigFile(path);
    expect(resolveMode({ flags: parseCliArgs(['chat']), env: {}, dotenvs: [], file, extraEnv: {} })).toBe('agent');
  });

  it("the badge is the quoted key 'agent': 'agent' (test/pty/run-smoke.sh parses quoted keys only) and fits the badge cap", () => {
    expect(MODE_BADGE_WORD['agent']).toBe('agent');
    expect(MODE_BADGE_WORD['agent'].length).toBeLessThanOrEqual(MODE_BADGE_MAX_CELLS);
    // the same two regexes run-smoke.sh's default_badge() runs over the source
    const text = readFileSync(join(ROOT, 'src/config/defaults.ts'), 'utf8');
    const table = /MODE_BADGE_WORD[^=]*=\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
    const parsed = Object.fromEntries([...table.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
    expect(parsed).toEqual({ ...MODE_BADGE_WORD });
    expect(parsed['agent']).toBe('agent');
  });

  it('AGENT_DEFAULT_MAX_STEPS is 250 and the legacy default stays 40', () => {
    expect(AGENT_DEFAULT_MAX_STEPS).toBe(250);
    expect(DEFAULT_MAX_STEPS).toBe(40);
  });

  it('the agent rows of the four mode tables carry the §14.5 texts verbatim, the badge word read from MODE_BADGE_WORD', () => {
    expect(HOW_TO_TASK_SUFFIX['agent']).toBe(' The code model works through tools and your tests verify it.');
    expect(MODE_SENTENCE['agent']).toBe('Mode: agent — the code model works through tools, tests verify, Jev makes a few quick routing calls.');
    expect(MODE_SET_ITEM['agent']).toBe('mode agent from the next run — the code model works through tools, tests verify (persist: jevcode config set mode agent)');
    expect(MODE_VALUE_HINTS['agent'].title).toBe('agent: the code model works through tools, tests verify');
    // every Record<EngineMode, …> table has exactly one row per accepted mode
    for (const table of [MODE_BADGE_WORD, HOW_TO_TASK_SUFFIX, MODE_SENTENCE, MODE_SET_ITEM, MODE_VALUE_HINTS]) {
      expect(Object.keys(table).sort()).toEqual([...MODE_SETTING_VALUES].sort());
    }
  });
});

// ---------------------------------------------------------------------------------------
// checkpoint, session index, manifest, exit code
// ---------------------------------------------------------------------------------------

describe('§10 / §14.1: resume, the session picker and delegation keep an agent run', () => {
  const agentState = { v: 1, turns: 3, transcriptSeq: 17, verifyRuns: 1, continueNudges: 0, blocks: 0, changedSinceVerify: false, todos: [], loopWindow: [], lastProgressTurn: null, jevDisabled: false, replayDisabled: false, systemHash: 'a1b2c3d4e5f6', carriedFrom: null, compactions: 0, lastCompactionAt: null };
  const counters: RunCounters = { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 4, loopNudges: 2 };

  it('isCheckpointState accepts mode agent with an agentState and counters.loopNudges, and the envelope round-trips them', () => {
    const state: CheckpointState = makeState({ runId: runId(3), mode: 'agent', step: 6, counters, agentState, stopReason: 'stuck' });
    expect(isCheckpointState(state)).toBe(true);
    const parsed = parseEnvelope(serialiseEnvelope(state, (s) => s));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.state.mode).toBe('agent');
    expect(parsed.state.agentState).toEqual(agentState);
    expect(parsed.state.counters.loopNudges).toBe(2);
    expect(parsed.state.stopReason).toBe('stuck');
    // the allow-list still rejects a mode nobody wrote
    expect(isCheckpointState({ ...state, mode: 'turbo' })).toBe(false);
    // and a legacy checkpoint without either member is unchanged
    expect(isCheckpointState(makeState({ runId: runId(4) }))).toBe(true);
  });

  it('isRunMeta accepts a run.json with mode agent', () => {
    expect(isRunMeta(makeMeta({ runId: runId(3), mode: 'agent' }))).toBe(true);
    expect(isRunMeta({ ...makeMeta({ runId: runId(3) }), mode: 'turbo' })).toBe(false);
  });

  it('the session index keeps a run:start with mode agent and a run:end with stopReason stuck', () => {
    const sid = runId(1);
    const rid = runId(2);
    const start: IndexLine = { v: 1, t: '2026-09-23T10:00:00.000Z', kind: 'run:start', sessionId: sid, runId: rid, parentRunId: null, workspace: '/w', task60: 'fix the parser', mode: 'agent', source: 'cli', branch: 'main', resumeOf: null };
    const end: IndexLine = { v: 1, t: '2026-09-23T10:05:00.000Z', kind: 'run:end', sessionId: sid, runId: rid, stopReason: 'stuck', steps: 31, costUsd: { generator: 0.2, jev: 0 }, wallMs: 300_000, changedFiles: 2, exitCode: 4, resumable: true, degraded: false };
    expect(parseIndexLine(JSON.stringify(start))).toMatchObject({ kind: 'run:start', mode: 'agent' });
    expect(parseIndexLine(JSON.stringify(end))).toMatchObject({ kind: 'run:end', stopReason: 'stuck' });
    const { sessions, skipped } = foldIndex([JSON.stringify(start), JSON.stringify(end)]);
    expect(skipped).toBe(0);
    const row = sessions.get(sid);
    expect(row?.mode).toBe('agent');
    expect(row?.runs).toEqual([{ runId: rid, parentRunId: null, startedAt: start.t, endedAt: end.t, stopReason: 'stuck', steps: 31, costUsd: { generator: 0.2, jev: 0 }, exitCode: 4, resumable: true, resumes: 0, live: false }]);
    expect(isStopReason('stuck')).toBe(true);
    expect(STOP_REASONS).toContain('stuck');
    // an unknown mode is still skipped rather than folded into a typed row
    expect(parseIndexLine(JSON.stringify({ ...start, mode: 'turbo' }))).toBeNull();
  });

  it('reindex rebuilds an agent run that stopped stuck from its run directory', async () => {
    const runs = join(dir, 'runs');
    const id = runId(9);
    await mkdir(join(runs, id), { recursive: true });
    await writeFile(join(runs, id, 'run.json'), JSON.stringify(makeMeta({ runId: id, mode: 'agent', createdAt: '2026-09-23T10:00:00.000Z' })));
    await writeFile(join(runs, id, 'state.json'), serialiseEnvelope(makeState({ runId: id, mode: 'agent', step: 31, stopReason: 'stuck', counters, agentState, spend: spend(0.2, 0), updatedAt: '2026-09-23T10:05:00.000Z' }), (s) => s));
    const out = join(dir, 'sessions', 'index.jsonl');
    expect(await reindex(runs, out)).toEqual({ runs: 1, skipped: 0, newer: 0 });
    const folded = await readIndex(out);
    expect(folded.sessions[0]?.mode).toBe('agent');
    expect(folded.sessions[0]?.runs[0]).toMatchObject({ runId: id, stopReason: 'stuck', steps: 31, live: false });
  });

  it('exitCodeFor(stuck) is 4, the resumable budget family', () => {
    expect(exitCodeFor('stuck')).toBe(4);
    expect(exitCodeFor('stuck')).toBe(EXIT_CODES.budget);
  });

  it('a delegation manifest accepts an agent-mode child and refuses an unknown mode', async () => {
    const child = (slug: string, mode: EngineMode): AgentSpec => ({ slug, task: `do the ${slug} work`, own: [`src/${slug}/**`], role: 'code', verify: ['npm test'], dependsOn: [], capUsd: 0.3, maxSteps: 12, maxWallMs: 900_000, mode, branch: `jevcode/${slug}` });
    const built = buildManifest({
      split: { kind: 'by_directory', agents: [child('tui-rows', 'agent'), child('cli-args', 'jev-on')], manifestId: '', secretHits: 0, clampReason: null },
      verdict: 'chosen',
      probability: 0.8,
      confidence: 0.42,
      runId: 'run-0123456789abcdef',
      sessionId: 'run-0123456789abcdef',
      step: 7,
      task: 'make the tests pass',
      remaining: ['one'],
      baseSha: 'a'.repeat(40),
      repoKey: 'repo-1',
      syncedDirty: [],
      dirtyOverlap: [],
      reserveUsd: 0.9,
      reserveFrom: 'session',
      rejected: [],
      demand: 'disjoint_directories',
      redact: (s) => s,
      now: () => Date.UTC(2026, 8, 23, 12, 0, 0),
    });
    if (!built.ok) throw new Error(built.reason);
    const files = new Map<string, string>();
    const io: ManifestIo = {
      async write(rel, text) {
        files.set(rel, text);
      },
      async read(rel) {
        return files.get(rel) ?? null;
      },
    };
    expect(await writeManifest(io, built.manifest)).toMatchObject({ ok: true });
    const read = await readManifest(io, 7, { task: 'make the tests pass', remaining: ['one'] });
    if (!read.ok) throw new Error(read.reason);
    expect(read.manifest.agents.map((a) => a.mode)).toEqual(['agent', 'jev-on']);
    // the same file with a mode no build writes is refused, not adopted
    files.set(manifestPath(7), (files.get(manifestPath(7)) ?? '').replace('"mode":"agent"', '"mode":"turbo"'));
    const refused = await readManifest(io, 7, { task: 'make the tests pass', remaining: ['one'] });
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.reason).toContain('mode is not an engine mode');
  });
});

// ---------------------------------------------------------------------------------------
// §14.2 the absent decider, §15 S1 the stub
// ---------------------------------------------------------------------------------------

describe('§14.2: the absent decider', () => {
  const opts = (signal: AbortSignal = new AbortController().signal): AskOptions => ({ signal, stage: 'loop', step: 3, quick: true });

  it('names itself by ABSENT_DECIDER_MODEL and rejects every ask with JevUnavailableError, sending nothing', async () => {
    const d = createAbsentDecider();
    expect(ABSENT_DECIDER_MODEL).toBe('none (no Jev key)');
    expect(d.model).toBe(ABSENT_DECIDER_MODEL);
    expect(d.provider).toBe('openrouter');
    const rejected = d.ask({ task: 'x' }, {}, opts());
    await expect(rejected).rejects.toBeInstanceOf(JevUnavailableError);
    await expect(d.ask({}, {}, opts())).rejects.toThrow('Jev is not available in this session (no Jev key); the loop ask was not sent');
  });

  it('is a JevError (exit 5) and NOT a JevHttpError, so no "jev unreachable" pane ever auto-retries it', () => {
    const e = new JevUnavailableError('intent');
    expect(e).toBeInstanceOf(JevError);
    expect(e).not.toBeInstanceOf(JevHttpError);
    expect(e.name).toBe('JevUnavailableError');
    expect(e.code).toBe('jev_http');
    expect(e.exitCode).toBe(5);
    expect(new JevUnavailableError().message).toBe('Jev is not available in this session (no Jev key); the ask was not sent');
  });

  it('an already-aborted signal rejects with the signal reason, like every other decider', async () => {
    const ac = new AbortController();
    const reason = new Error('paused');
    ac.abort(reason);
    await expect(createAbsentDecider().ask({}, {}, opts(ac.signal))).rejects.toBe(reason);
  });

  it('is not router-fatal: routeSpeculative takes the code order when the absent decider is asked', async () => {
    const d = createAbsentDecider();
    expect(isRouterFatal(new JevUnavailableError('loop'))).toBe(false);
    const r = await routeSpeculative<string>({
      id: 'RL1',
      token: createStepToken(3),
      codeOrder: ['change_approach', 'gather_context'],
      ask: async (signal) => {
        await d.ask({}, {}, { signal, stage: 'loop', step: 3, quick: true });
        return ['gather_context'];
      },
    });
    expect(r.source).toBe('code');
    expect(r.order[0]).toBe('change_approach');
    expect(r.drop).toBe('error');
  });
});

describe('§15 S1: the agent entry point (the stub replaced by slice S3)', () => {
  it('createAgentDriver is an AgentDriverFactory that returns a fresh driver per run', () => {
    const factory: AgentDriverFactory = createAgentDriver;
    const a = factory();
    const b = factory();
    expect(a).not.toBe(b);
    expect(a.name).toBe('agent');
    expect(typeof a.next).toBe('function');
    expect(typeof a.observe).toBe('function');
  });
});

// ---------------------------------------------------------------------------------------
// the shapes (compile-time; the values keep them honest at runtime)
// ---------------------------------------------------------------------------------------

describe('§6.1: the provider contract additions', () => {
  it('the agent transcript threads tool results by id; GenerateRequest.agent replaces messages; the result carries the replay state', () => {
    const replay: ProviderReplayState = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', data: { reasoning_details: [{ type: 'reasoning.text', text: 'look at a.ts', index: 0 }] } };
    const assistant: AgentAssistantBlock[] = [
      { type: 'text', text: 'Reading both files.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'src/a.ts' } },
      { type: 'tool_use', id: 'call_2', name: 'read_file', input: { path: 'src/b.ts' } },
    ];
    const results: AgentUserBlock[] = [
      { type: 'tool_result', toolUseId: 'call_1', name: 'read_file', content: '1\texport const a = 1;' },
      { type: 'tool_result', toolUseId: 'call_2', name: 'read_file', content: 'no such file: src/b.ts', isError: true },
      { type: 'text', text: 'note: 2 results' },
    ];
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '# Task\nfix the parser' }] },
      { role: 'assistant', content: assistant, providerState: replay },
      { role: 'user', content: results },
    ];
    const agent: AgentRequest = { messages, parallelToolCalls: true, cacheKey: 'session-1', replayReasoning: true, strictReplay: true, clearToolResults: { triggerTokens: 100_000, keep: 6, clearAtLeastTokens: 5_000 } };
    const req: GenerateRequest = { system: 's', messages: [], maxTokens: 16_384, temperature: null, toolChoice: 'auto', agent };
    const legacy: GenerateRequest = { system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 4096, temperature: 0 };
    expect(req.agent?.messages).toHaveLength(3);
    expect('agent' in legacy).toBe(false);
    // every tool_use of the assistant turn is answered by a tool_result with its id
    const ids = assistant.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
    const answered = results.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : []));
    expect(answered).toEqual(ids);

    const call: ToolCall = { name: 'read_file', input: { path: 'src/a.ts' }, rawJson: '{"path":"src/a.ts"}', id: 'call_1' };
    const legacyCall: ToolCall = { name: 'propose_action', input: {}, rawJson: '{}' };
    expect(call.id).toBe('call_1');
    expect(legacyCall.id).toBeUndefined();
    const res: GenerateResult = { text: '', toolCalls: [call], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, model: 'm', stopReason: 'tool_use', latencyMs: 1, providerState: replay, contextEdits: { clearedToolUses: 4, clearedInputTokens: 12_000 }, warnings: ['input_transformations: thinking_block_dropped'] };
    expect(res.providerState?.provider).toBe('openrouter');
    expect(res.contextEdits?.clearedToolUses).toBe(4);
  });

  it('GenerateOptions gains onToolCall and onReasoning next to onToolDelta; AskOptions gains quick; MockTurn gains toolCalls, providerState and reasoning', () => {
    const deltas: ToolCallDelta[] = [];
    const reasoning: string[] = [];
    const o: GenerateOptions = { signal: new AbortController().signal, onToolDelta: () => undefined, onToolCall: (d) => deltas.push(d), onReasoning: (f) => reasoning.push(f) };
    o.onToolCall?.({ index: 0, id: 'call_1', name: 'bash', fragment: '{"command":"ls"' });
    o.onToolCall?.({ index: 0, fragment: '}' });
    o.onReasoning?.('thinking…');
    expect(deltas.map((d) => d.fragment).join('')).toBe('{"command":"ls"}');
    expect(reasoning).toEqual(['thinking…']);
    const quick: AskOptions = { signal: new AbortController().signal, stage: 'loop', step: 1, quick: true };
    expect(quick.quick).toBe(true);
    const turn: MockTurn = { text: 'Reading.', reasoning: 'plan', providerState: { sig: 'abc' }, toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }, { name: 'glob', input: { pattern: '**/*.ts' }, rawJson: '{"pattern":"**/*.ts"}' }] };
    expect(turn.toolCalls).toHaveLength(2);
  });

  it("ReasoningEffort spells §6.3's Anthropic effort 'high'; the adapters pass it through unrewritten", () => {
    // §6.3: the Anthropic agent constant is {effort:'high'} → output_config.effort; every other provider row is {effort:'low'}.
    const anthropic: GenerateReasoning = { effort: 'high' };
    const others: GenerateReasoning = { effort: 'low' };
    expect(effortOf(anthropic)).toBe('high');
    expect(effortOf(others)).toBe('low');
    expect(openAiReasoningEffort(anthropic, 'gpt-5.6-terra')).toBe('high');
    const req: GenerateRequest = { system: 's', messages: [], maxTokens: 16_384, temperature: null, reasoning: anthropic };
    expect(req.reasoning).toEqual({ effort: 'high' });
  });

  it("Action 'run' gains cwd (workspace-relative); the legacy run action is unchanged", () => {
    const run: Action = { kind: 'run', command: 'npm test', timeoutMs: 120_000, cwd: 'packages/core' };
    const legacy: Action = { kind: 'run', command: 'npm test' };
    expect(run.kind === 'run' ? run.cwd : null).toBe('packages/core');
    expect(legacy.kind === 'run' ? legacy.cwd : null).toBeUndefined();
  });
});

describe('§15 S1: the engine-facing unions and members', () => {
  it('EngineMode, StepProposer, StageName and StopReason each gain one member; BenchCondition excludes agent', () => {
    const mode: EngineMode = 'agent';
    const proposer: StepProposer = 'agent';
    const stage: StageName = 'loop';
    const stop: StopReason = 'stuck';
    const arms: BenchCondition[] = ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve'];
    // @ts-expect-error — the bench has no agent arm (§14.1)
    const noArm: BenchCondition = 'agent';
    void noArm;
    expect([mode, proposer, stage, stop]).toEqual(['agent', 'agent', 'loop', 'stuck']);
    expect(arms).toHaveLength(5);
    const tools: AgentToolName[] = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'todo_write'];
    expect(new Set(tools).size).toBe(7);
  });

  it('StepRecord.agent, CheckpointState.agentState, RunCounters.loopNudges and RiskAssessment.rule are optional additions', () => {
    const trip: LoopTrip = { signature: 'a1b2c3d4e5f6', count: 3, rule: 'repeat', tool: 'bash' };
    const calls: AgentCallSummary[] = [{ id: 'call_1', name: 'read_file', summary: 'read_file src/a.ts (lines 1-120)', ok: true, ms: 3 }];
    const summary: StepAgentSummary = { kind: 'observe', turn: 2, calls, seqAfter: 9, loopTrip: trip };
    const verify: StepAgentSummary = { kind: 'verify', turn: null, calls: [], seqAfter: 12 };
    const withAgent: Pick<StepRecord, 'agent' | 'proposer'> = { agent: summary, proposer: 'agent' };
    const legacy: Pick<StepRecord, 'agent'> = {};
    expect(withAgent.agent?.loopTrip?.rule).toBe('repeat');
    expect(verify.loopTrip).toBeUndefined();
    expect(legacy.agent).toBeUndefined();
    const zero: RiskDimensionResult = { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 };
    const dims: Record<RiskDimension, RiskDimensionResult> = { destructive: zero, out_of_scope: zero, plan_mismatch: zero, irreversible: zero };
    const rule: RiskAssessment = { dims, risk: 1, verdict: 'block', reason: 'rm -rf outside the workspace', rule: 'rm_outside' };
    const jev: RiskAssessment = { dims, risk: 0, verdict: 'ok', reason: '' };
    expect(rule.rule).toBe('rm_outside');
    expect(jev.rule).toBeUndefined();
    const counters: RunCounters = { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 };
    expect(counters.loopNudges).toBeUndefined();
    const state: Pick<CheckpointState, 'agentState'> = {};
    expect(state.agentState).toBeUndefined();
  });

  it('EngineOptions gains agent and conversation; ConversationCarry carries the chat and the parent run', () => {
    const carry: ConversationCarry = { chat: [{ role: 'you', text: 'the parser drops tz' }, { role: 'jevcode', text: 'I can fix that.' }], parent: { runId: runId(1), runDir: '/runs/r1', mode: 'agent' } };
    const none: ConversationCarry = { chat: [], parent: null };
    const driver: AgentDriver = { name: 'fake', next: async () => Promise.reject(new Error('unused')), observe: async () => ({ loopTrip: null, seqAfter: 0 }) };
    const opts: Pick<EngineOptions, 'agent' | 'conversation'> = { agent: driver, conversation: carry };
    const legacy: Pick<EngineOptions, 'agent' | 'conversation'> = {};
    expect(opts.conversation?.parent?.mode).toBe('agent');
    expect(none.parent).toBeNull();
    expect(legacy.agent).toBeUndefined();
  });

  it('EngineEvent gains the five §9.2 members; generator:tool-delta gains tool and target', () => {
    const events: EngineEvent[] = [
      { type: 'assistant:text', step: 2, turn: 1, attempt: 1, text: 'Reading both files.\n', final: false },
      { type: 'assistant:reset', step: 2, turn: 1, attempt: 2 },
      { type: 'generator:reasoning', step: 2, turn: 1, chars: 1200, tail: 'check the tz branch' },
      { type: 'tool:call', step: 2, turn: 1, id: 'call_1', name: 'read_file', summary: 'read_file src/a.ts', readOnly: true },
      { type: 'tool:result', step: 2, turn: 1, id: 'call_1', name: 'invalid', ok: false, summary: 'unknown tool', ms: 0, chars: 12, readOnly: true },
      { type: 'generator:tool-delta', step: 2, chars: 1200, tool: 'edit_file', target: 'src/a.ts' },
      { type: 'generator:tool-delta', step: 2, chars: 40 },
    ];
    expect(events.map((e) => e.type)).toEqual(['assistant:text', 'assistant:reset', 'generator:reasoning', 'tool:call', 'tool:result', 'generator:tool-delta', 'generator:tool-delta']);
  });
});

describe('§2.2 / §15 S1: the driver seam compiles against a scripted driver', () => {
  /** a driver that finishes on its first turn — the smallest thing S4's engine tests inject through EngineOptions.agent */
  function scriptedDriver(): AgentDriver & { seen: AgentObservation[] } {
    const seen: AgentObservation[] = [];
    return {
      name: 'scripted',
      seen,
      async next(ctx: AgentContext): Promise<AgentNext> {
        const proposal: Proposal = { goal: 'finish', action: { kind: 'done', summary: `done: ${ctx.task}` }, plan: { done: [], remaining: [], openProblems: [] }, rawText: 'All fixed.' };
        return { kind: 'finish', proposal, summary: { kind: 'finish', turn: 1, calls: [], seqAfter: 3 } };
      },
      async observe(_ctx: AgentContext, o: AgentObservation): Promise<AgentObserveResult> {
        seen.push(o);
        return { loopTrip: null, seqAfter: 4 };
      },
    };
  }

  it('next → finish, observe → seqAfter; act carries its gate and call id; observe carries a finished outcome', async () => {
    const d = scriptedDriver();
    // only the members this driver reads; S4 builds the real context (Engine.agentContext)
    const ctx = { task: 'fix the parser' } as unknown as AgentContext;
    const next = await d.next(ctx);
    expect(next.kind).toBe('finish');
    expect(next.proposal.action).toEqual({ kind: 'done', summary: 'done: fix the parser' });
    const obs: AgentObservation = { step: 1, outcome: { status: 'noop', summary: 'done' }, output: '', changedFiles: [], tests: null, error: null };
    expect(await d.observe(ctx, obs)).toEqual({ loopTrip: null, seqAfter: 4 });
    expect(d.seen).toEqual([obs]);

    const gate: AgentGate = { verdict: 'block', reason: 'rm -rf outside the workspace', rule: 'rm_outside' };
    const proposal: Proposal = { goal: '', action: { kind: 'run', command: 'rm -rf /', cwd: '.' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
    const act: AgentNext = { kind: 'act', proposal, callId: 'call_7', gate, summary: { kind: 'act', turn: 4, calls: [], seqAfter: 20 } };
    const observe: AgentNext = { kind: 'observe', proposal: { ...proposal, action: { kind: 'read', paths: ['src/a.ts'] } }, outcome: { status: 'executed', summary: 'read 1 file', changedFiles: [] }, output: 'read_file src/a.ts', execMs: 3, summary: { kind: 'observe', turn: 4, calls: [], seqAfter: 21 } };
    expect(act.kind === 'act' ? act.gate.rule : null).toBe('rm_outside');
    expect(observe.kind === 'observe' ? observe.outcome.status : null).toBe('executed');
    const tests: AgentObservation['tests'] = { command: 'npm test', parsed: { passed: 12, failed: 0, errors: 0, skipped: 0 }, allPassed: true };
    expect(tests?.allPassed).toBe(true);
  });

  it('AgentGenerateHooks: turn is required; silent is the literal true', () => {
    const texts: string[] = [];
    const hooks: AgentGenerateHooks = { turn: 3, onText: (t) => texts.push(t), onAttemptReset: () => texts.splice(0), silent: true };
    hooks.onText?.('a');
    hooks.onAttemptReset?.(2);
    expect(texts).toEqual([]);
    expect(hooks.silent).toBe(true);
  });
});
