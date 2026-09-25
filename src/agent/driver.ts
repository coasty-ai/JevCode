/**
 * The agent driver (docs/AGENT-LOOP-DESIGN.md §2.3, §3): one model-driven loop, mapped onto engine steps.
 *
 * `next()` restores (or builds) the transcript once, absorbs steers and a `/compact` request, then derives the queue —
 * the calls of the latest assistant record that have no result — from the transcript, every time. A non-empty queue
 * yields the next segment: a run of resolvable calls (an `observe` step, resolved here in parallel batches of 8) or one
 * mutating call (an `act` step the engine executes). An empty queue samples a turn — after the pending loop nudge
 * (RA1), the due progress check (RA2), and masking or compaction — and a turn without calls first absorbs a steer the user
 * sent while it streamed (one more turn answers it), then goes through the stop rules: continue, verify, or finish.
 *
 * `observe()` receives the engine's result of an act / verify / finish step before the checkpoint: the tool result goes
 * into the transcript (memory first, then disk), the counters and the loop detector are updated, and the state is handed
 * back for `state.json`. Deriving the queue from the transcript means a step the engine discards needs no hook: its call
 * is simply issued again, and no request ever carries a `tool_use` without its `tool_result`.
 */
import type { AgentCallSummary, AgentContext, AgentDriver, AgentNext, AgentObservation, AgentObserveResult, AgentToolName, PlanDraft, Proposal, StepAgentSummary, ToolSpec } from '../core/types.js';
import { sha12 } from '../core/hash.js';
import { headTail } from '../core/text.js';
import { AbortError } from '../errors.js';
import { changesWorkspace, dispose, failedDisposition, failedResult, reportAct, type CallEnv, type PreparedAct } from './calls.js';
import { ContextEstimate, budgetFor, codeSummary, compactionDue, compactionText, compactionWriter, contextUsage, llmSummary, maskCandidates, maskDue, type Budget } from './context.js';
import { buildHead } from './head.js';
import { chooseLoopNudge, effortHint, progressCheck, type RunFacts } from './jev.js';
import { AGENT_FINISH_SUMMARY_CHARS, AGENT_MAX_CALLS_PER_TURN, AGENT_OBSERVE_OUTPUT_CHARS, AGENT_PARALLEL_READS, AGENT_RAW_TEXT_CHARS, AGENT_VERIFY_MAX, AGENT_VERIFY_TIMEOUT_MS } from './limits.js';
import { callSignature, feedLoop, progressCheckDue, resultHash, toLoopTrip, type LoopTripWithTest } from './loop.js';
import { NOT_EXECUTED_STEER, PROGRESS_NUDGE, buildAgentSystemPrompt, loopNudgeText, loopTripWhat, steerNote, verifyResult, verifyTimeout } from './prompt.js';
import { lowEffortReasoning, agentReasoning, maskingModeFor, providerLabel, sameReasoning, type MaskingMode } from './providers.js';
import { deriveCall, type NormalisedCall } from './repair.js';
import { initialState, parseState, stateJson, type AgentStateV1 } from './state.js';
import { decideStop, isUnscopedTestRun } from './stop.js';
import { bashStatusLine, clipMiddle, oneLine } from './tools/format.js';
import type { ReadHashes } from './tools/read.js';
import { createRgProbe } from './tools/search.js';
import { AGENT_TOOL_NAMES, RESEARCH_TOOL_NAMES, toolsFor } from './tools/specs.js';
import { planOf } from './tools/todo.js';
import type { ToolResult } from './tools/result.js';
import { sampleTurn, buildRequest, requestChars, type TurnSetup } from './turn.js';
import { AgentTranscriptMissingError, Transcript, readTranscript, transcriptPath, wireToolName, type AssistantRecord, type NoteRecord, type NoteTag, type RecordedCall } from './transcript.js';
import { isDocsOnlyChange } from '../workspace/docs-paths.js';
import { isTestCommand } from '../workspace/tests.js';

type Pending =
  | { kind: 'act'; call: NormalisedCall; act: PreparedAct; startedAt: number }
  | { kind: 'verify'; command: string; timeoutMs: number }
  | { kind: 'finish' };

const RECENT_STEPS_KEPT = 12;

/** One resolvable call of an observe segment, ready to run. */
interface BatchItem {
  call: NormalisedCall;
  run: (part: number | undefined) => Promise<ToolResult>;
  name: AgentCallSummary['name'];
  callSummary: string;
}

class Driver implements AgentDriver {
  readonly name = 'agent';
  private transcript: Transcript | null = null;
  private state: AgentStateV1 = initialState('');
  private system = '';
  private tools: ToolSpec[] = [];
  private toolNames: readonly AgentToolName[] = AGENT_TOOL_NAMES;
  private systemHash = '';
  /**
   * The latest turn's calls as the model sent them, before the transcript's redaction: a write_file whose content holds
   * a secret-shaped fixture runs with the real text, as a legacy action does. After a resume only the redacted record
   * is left, and the call is derived from it.
   */
  private live = new Map<string, NormalisedCall>();
  private budget: Budget = budgetFor(null);
  private maskingMode: MaskingMode = 'client';
  private readonly estimate = new ContextEstimate();
  private readonly readHashes: ReadHashes = new Map();
  private readonly rg = createRgProbe();
  private readonly warned = new Set<string>();
  private pending: Pending | null = null;
  private compactRequested = false;
  private readonly recent: string[] = [];
  private readonly testTrend: string[] = [];
  private readonly filesRead = new Set<string>();
  private readonly filesEdited = new Set<string>();

  // ---------------------------------------------------------------------------------------
  // Restore (§3.1 step 1)
  // ---------------------------------------------------------------------------------------

  private async restore(ctx: AgentContext): Promise<Transcript> {
    if (this.transcript !== null) return this.transcript;
    const role = ctx.orchestration?.role === 'research' ? 'research' : 'default';
    this.tools = toolsFor(role);
    this.toolNames = role === 'research' ? RESEARCH_TOOL_NAMES : AGENT_TOOL_NAMES;
    this.system = buildAgentSystemPrompt({
      model: ctx.provider.model,
      providerLabel: providerLabel(ctx.provider.name),
      sandboxLevel: ctx.sandbox.level,
      testCommand: ctx.workspaceInfo.testCommand?.command ?? null,
      autonomy: ctx.autonomy,
      instructions: ctx.instructions,
      memoryIndex: ctx.memoryIndex,
    });
    this.systemHash = sha12([this.system, this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))]);
    this.budget = budgetFor(ctx.windowTokens);
    this.maskingMode = maskingModeFor(ctx.provider.name, ctx.provider.model);
    const t = new Transcript(transcriptPath(ctx.runDir), () => ctx.now());
    const saved = parseState(ctx.state);
    if (ctx.resumed && saved !== null) {
      const records = await readTranscript(t.file);
      if (records === null) throw new AgentTranscriptMissingError(t.file);
      // §10: records past the checkpoint belong to a step that never committed; their calls count as unresolved
      await t.reset(records.filter((r) => r.seq <= saved.transcriptSeq));
      this.state = { ...saved, systemHash: this.systemHash };
      this.transcript = t;
    } else {
      const head = await buildHead(ctx, this.systemHash);
      await t.reset(head.records);
      this.state = { ...initialState(this.systemHash), carriedFrom: head.carriedFrom };
      this.transcript = t;
      // §7.6: the head is checkpointed at once, so a run that ends before its first step (a provider 4xx, a failed retry,
      // Esc or Ctrl-C during the first reply) still leaves `agentState` — the next message then carries the conversation
      // with this run's own user message, instead of starting over from a fresh first message (the S6 review's carry hole)
      this.snapshot(ctx);
    }
    return t;
  }

  private env(ctx: AgentContext): CallEnv {
    return { ctx, tools: this.toolNames, readHashes: this.readHashes, rg: this.rg, setTodos: (todos) => (this.state.todos = todos) };
  }

  private plan(): PlanDraft {
    return planOf(this.state.todos);
  }

  private snapshot(ctx: AgentContext): number {
    const t = this.transcript!;
    this.state.transcriptSeq = t.lastSeq();
    ctx.setState(stateJson(this.state));
    return this.state.transcriptSeq;
  }

  private async note(text: string, tag: NoteTag): Promise<void> {
    await this.transcript!.append({ kind: 'note', text, tag });
  }

  private remember(line: string): void {
    this.recent.push(line);
    while (this.recent.length > RECENT_STEPS_KEPT) this.recent.shift();
  }

  private facts(ctx: AgentContext): RunFacts {
    const last = ctx.lastTestRun;
    return {
      recentSteps: this.recent,
      lastTests: last === null ? null : { passed: last.passed, failed: last.failed, errors: last.errors },
      testTrend: this.testTrend.slice(-6),
      changedFiles: this.filesEdited.size,
      filesRead: this.filesRead.size,
      filesEdited: this.filesEdited.size,
    };
  }

  // ---------------------------------------------------------------------------------------
  // next()
  // ---------------------------------------------------------------------------------------

  async next(ctx: AgentContext): Promise<AgentNext> {
    const t = await this.restore(ctx);
    await this.absorbSteers(ctx, t);
    if (ctx.takeCompactRequest()) this.compactRequested = true;
    let turn: number | null = null;
    for (;;) {
      const queue = t.unresolved();
      if (queue.length > 0) return this.segment(ctx, queue, turn);
      let reply: AssistantRecord | null = t.trailingReply();
      if (reply === null) {
        const sampled = await this.sample(ctx, t);
        turn = sampled.turn;
        if (sampled.calls.length > 0) continue;
        reply = sampled.record;
      }
      // §10 Steer: a message the user sent while this turn streamed is answered before the stop rules may finish past it — one
      // more turn per absorbed steer; the continuation and verify rules then apply to that turn as to any other
      if (await this.absorbSteers(ctx, t)) continue;
      // §3.3 rule 2 is the `agent.verify tests` opt-in: by default the model decides what to run, and nothing is run for it
      const d = decideStop(reply, this.state, ctx.verify === 'tests' ? ctx.workspaceInfo.testCommand : null);
      if (d.kind === 'continue') {
        this.state.continueNudges += 1;
        await this.note(d.note, 'continue');
        continue;
      }
      if (d.kind === 'verify_nudge') {
        // the model has the failure once, from its own run: the reply that follows finishes, and the harness does not run
        // the same suite again; only a new change re-arms rule 2
        this.state.verifyRuns += 1;
        this.state.failedTest = null;
        this.state.changedSinceVerify = false;
        await this.note(d.note, 'verify');
        continue;
      }
      if (d.kind === 'verify') return this.verifyStep(ctx, d.command, turn);
      return this.finishStep(ctx, reply, turn);
    }
  }

  /**
   * §3.1 step 2 / §10: steers answer every unresolved call and reach the model as a note before the next turn. Asked at the top of
   * `next()` and again after a turn with no tool call (nothing is unresolved then); true when a steer was absorbed.
   */
  private async absorbSteers(ctx: AgentContext, t: Transcript): Promise<boolean> {
    const steers = ctx.takeSteers();
    if (steers.length === 0) return false;
    for (const c of t.unresolved()) await t.append({ kind: 'result', toolUseId: c.id, name: c.name, content: NOT_EXECUTED_STEER, isError: true, summary: `${c.name} (not executed)` });
    for (const s of steers) await this.note(steerNote(ctx.redact(s)), 'steer');
    this.pending = null;
    return true;
  }

  /** §3.1 step 4: the notes and context policy of a turn build, then the turn itself. */
  private async sample(ctx: AgentContext, t: Transcript): Promise<{ turn: number; record: AssistantRecord; calls: NormalisedCall[] }> {
    const trip = this.state.pendingLoop;
    if (trip !== null) {
      const kind = await chooseLoopNudge(ctx, this.state, trip, this.facts(ctx));
      await this.note(loopNudgeText(kind, loopTripWhat(trip)), 'loop');
      this.state.pendingLoop = null;
    }
    if (progressCheckDue(this.state.turns, this.state.lastProgressTurn)) {
      this.state.lastProgressTurn = this.state.turns;
      if (await progressCheck(ctx, this.state, this.facts(ctx))) await this.note(PROGRESS_NUDGE, 'progress');
    }
    const t0 = ctx.now();
    const setup = (lowEffort: boolean): TurnSetup => ({ ctx, state: this.state, transcript: t, system: this.system, systemHash: this.systemHash, tools: this.tools, budget: this.budget, maskingMode: this.maskingMode, estimate: this.estimate, lowEffort, warned: this.warned });
    const measure = (): number => requestChars(buildRequest(setup(false), !this.state.replayDisabled));
    let chars = measure();
    const writer = compactionWriter(ctx.compaction);
    const tokensBefore = this.estimate.tokens(chars);
    if ((this.compactRequested || (writer !== 'off' && compactionDue(tokensBefore, this.budget))) && t.unresolved().length === 0) {
      chars = await this.compact(ctx, t, writer === 'llm' ? 'llm' : 'code', chars, measure);
      this.compactRequested = false;
    } else if (this.maskingMode === 'client') {
      const m = maskCandidates(t);
      if (maskDue(this.maskingMode, tokensBefore, this.budget, m.reclaim)) {
        await t.append({ kind: 'mask', ids: m.ids });
        this.estimate.reset();
        chars = measure();
      }
    }
    ctx.reportContext(contextUsage({ tokens: this.estimate.tokens(chars), budget: this.budget, promptChars: chars, turns: this.state.turns, state: this.state, writer, buildMs: ctx.now() - t0 }));
    // §A4 RA0: the first turn of a run may go at low effort — asked only when that could change the request (not for a
    // GLM model, whose default is already low)
    const low = lowEffortReasoning(ctx.provider.name);
    const lowEffort = this.state.turns === 0 && low !== null && !sameReasoning(agentReasoning(ctx.provider.name, ctx.provider.model), low) ? await effortHint(ctx, this.state) : false;
    const sampled = await sampleTurn(setup(lowEffort));
    this.live = new Map(sampled.calls.map((c) => [c.id, c]));
    return sampled;
  }

  /** §7.4: replace the history with one user message (head, summary, last results, edited files). Returns the new size. */
  private async compact(ctx: AgentContext, t: Transcript, writer: 'llm' | 'code', before: number, measure: () => number): Promise<number> {
    const fromSeq = t.live()[0]?.seq ?? 1;
    const toSeq = t.lastSeq();
    let summary = writer === 'llm' ? await llmSummary(ctx, t, this.state, this.state.turns + 1) : null;
    const by = summary === null ? 'code' : 'llm';
    summary ??= codeSummary(ctx, t, this.state);
    const text = ctx.redact(await compactionText(ctx, t, summary));
    // the notes this turn was to carry (a steer, a loop or progress nudge, the verify outcome) are not history yet: they
    // follow the compaction record verbatim, as text blocks of the same one user message
    const since = t.latestAssistant()?.seq ?? 0;
    const pending = t.live().filter((r): r is NoteRecord => r.kind === 'note' && r.seq > since);
    await t.append({ kind: 'compaction', text, fromSeq, toSeq, by });
    for (const n of pending) await this.note(n.text, n.tag);
    this.state.compactions += 1;
    this.state.lastCompactionAt = new Date(ctx.now()).toISOString();
    this.state.lastCompactionStep = ctx.step;
    this.estimate.reset();
    const after = measure();
    ctx.emit({ type: 'context:compacted', step: ctx.step, chars: { before, after }, by });
    return after;
  }

  // ---------------------------------------------------------------------------------------
  // Segments (§3.2)
  // ---------------------------------------------------------------------------------------

  private rawText(t: Transcript, calls: readonly NormalisedCall[]): string {
    const a = t.latestAssistant();
    const first = a !== null && calls.length > 0 && a.calls[0]?.id === calls[0]!.id;
    const parts = [...(first && a.text.trim() !== '' ? [a.text] : []), ...calls.map((c) => `${c.rawName} ${JSON.stringify(c.replayInput)}`)];
    return parts.join('\n').slice(0, AGENT_RAW_TEXT_CHARS);
  }

  private async segment(ctx: AgentContext, queue: readonly RecordedCall[], turn: number | null): Promise<AgentNext> {
    const t = this.transcript!;
    const env = this.env(ctx);
    const batch: BatchItem[] = [];
    for (const rec of queue) {
      const call = this.live.get(rec.id) ?? deriveCall(rec, ctx.workspace.root);
      const d = await dispose(env, call).catch((e: unknown) => failedDisposition(ctx, call, e));
      if (d.kind === 'act') {
        if (batch.length === 0) return this.actStep(ctx, call, d.act, turn);
        break;
      }
      batch.push({ call, run: d.run, name: d.name, callSummary: d.callSummary });
    }
    return this.observeStep(ctx, t, batch, turn);
  }

  /** Resolve a run of resolvable calls: batches of 8, `tool:call` for a whole batch before it starts, results in order. */
  private async observeStep(ctx: AgentContext, t: Transcript, batch: readonly BatchItem[], turn: number | null): Promise<AgentNext> {
    const started = ctx.now();
    // the queue is always the latest assistant record's calls, so they belong to the latest turn
    const eventTurn = this.state.turns;
    const bashCount = batch.filter((b) => b.call.name === 'bash').length;
    let bashIndex = 0;
    const parts = batch.map((b) => (b.call.name === 'bash' && bashCount > 1 ? (bashIndex += 1) : undefined));
    const results: { result: ToolResult; ms: number }[] = [];
    for (let i = 0; i < batch.length; i += AGENT_PARALLEL_READS) {
      const slice = batch.slice(i, i + AGENT_PARALLEL_READS);
      for (const b of slice) ctx.emit({ type: 'tool:call', step: ctx.step, turn: eventTurn, id: b.call.id, name: b.name, summary: ctx.redact(b.callSummary), readOnly: true });
      const done = await Promise.all(
        slice.map(async (b, k) => {
          const t0 = ctx.now();
          const result = await b.run(parts[i + k]).catch((e: unknown) => failedResult(ctx, b.callSummary, e));
          const ms = ctx.now() - t0;
          ctx.emit({ type: 'tool:result', step: ctx.step, turn: eventTurn, id: b.call.id, name: b.name, ok: result.ok, summary: ctx.redact(result.summary), ms, chars: result.text.length, readOnly: true });
          return { result, ms };
        }),
      );
      results.push(...done);
    }
    // a pause-now aborted the step mid-batch: nothing is appended, and the calls are issued again after the resume
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new AbortError('human_pause');
    let trip: LoopTripWithTest | null = null;
    const readPaths: string[] = [];
    const calls: AgentCallSummary[] = [];
    // every result is in memory before the first disk write is awaited: a failed append un-resolves nothing
    const writes: Promise<unknown>[] = [];
    for (const [k, b] of batch.entries()) {
      const { result, ms } = results[k]!;
      writes.push(t.append({ kind: 'result', turn: eventTurn, toolUseId: b.call.id, name: b.call.name === 'invalid' ? wireToolName(b.call.rawName) : b.call.name, content: ctx.redact(result.text), isError: !result.ok, summary: ctx.redact(result.summary), ...(result.pointer !== undefined ? { pointer: result.pointer } : {}) }));
      if (result.hashBasis !== null) trip = feedLoop(this.state.loopWindow, { name: b.name, signature: callSignature(b.name, b.call.args, resultHash({ kind: 'text', text: result.hashBasis })), testCommand: null }) ?? trip;
      for (const p of result.readPaths ?? []) {
        if (!readPaths.includes(p)) readPaths.push(p);
        this.filesRead.add(p);
      }
      if (calls.length < AGENT_MAX_CALLS_PER_TURN) calls.push({ id: b.call.id, name: b.name, summary: ctx.redact(result.summary), ok: result.ok, ms });
    }
    if (trip !== null) this.state.pendingLoop = trip;
    await Promise.all(writes);
    this.remember(`observe: ${calls.map((c) => c.summary).join('; ')}`);
    const output = batch.map((b, k) => `## ${b.callSummary}\n${results[k]!.result.text}`).join('\n\n');
    const proposal: Proposal = { goal: oneLine(batch.map((b) => b.callSummary).join(' · '), 200), action: { kind: 'read', paths: readPaths }, plan: this.plan(), rawText: ctx.redact(this.rawText(t, batch.map((b) => b.call))) };
    const seqAfter = this.snapshot(ctx);
    const summary: StepAgentSummary = { kind: 'observe', turn, calls, seqAfter, ...(trip !== null ? { loopTrip: toLoopTrip(trip) } : {}) };
    return {
      kind: 'observe',
      proposal,
      outcome: { status: 'executed', summary: calls.map((c) => c.summary).join('\n'), changedFiles: [] },
      output: headTail(output, AGENT_OBSERVE_OUTPUT_CHARS - 8_192, 8_000),
      execMs: ctx.now() - started,
      summary,
    };
  }

  private actStep(ctx: AgentContext, call: NormalisedCall, act: PreparedAct, turn: number | null): AgentNext {
    const t = this.transcript!;
    this.pending = { kind: 'act', call, act, startedAt: ctx.now() };
    const name = call.name === 'invalid' ? 'invalid' : call.name;
    ctx.emit({ type: 'tool:call', step: ctx.step, turn: this.state.turns, id: call.id, name, summary: ctx.redact(act.goal), readOnly: false });
    const proposal: Proposal = { goal: act.goal, action: act.action, plan: this.plan(), rawText: ctx.redact(this.rawText(t, [call])) };
    const seqAfter = this.snapshot(ctx);
    return { kind: 'act', proposal, callId: call.id, gate: act.gate, summary: { kind: 'act', turn, calls: [{ id: call.id, name, summary: ctx.redact(act.goal), ok: true, ms: 0 }], seqAfter } };
  }

  private verifyStep(ctx: AgentContext, command: string, turn: number | null): AgentNext {
    const timeoutMs = Math.max(1, Math.floor(Math.min(AGENT_VERIFY_TIMEOUT_MS, ctx.wallRemainingMs())));
    this.pending = { kind: 'verify', command, timeoutMs };
    const proposal: Proposal = { goal: `verify: ${command}`, action: { kind: 'run', command, timeoutMs }, plan: this.plan(), rawText: '' };
    const seqAfter = this.snapshot(ctx);
    return { kind: 'verify', proposal, summary: { kind: 'verify', turn, calls: [], seqAfter } };
  }

  private finishStep(ctx: AgentContext, reply: AssistantRecord, turn: number | null): AgentNext {
    this.pending = { kind: 'finish' };
    const proposal: Proposal = { goal: 'finish', action: { kind: 'done', summary: reply.text.slice(0, AGENT_FINISH_SUMMARY_CHARS) }, plan: this.plan(), rawText: reply.text.slice(0, AGENT_RAW_TEXT_CHARS) };
    const seqAfter = this.snapshot(ctx);
    return { kind: 'finish', proposal, summary: { kind: 'finish', turn, calls: [], seqAfter } };
  }

  // ---------------------------------------------------------------------------------------
  // observe() (§3.4)
  // ---------------------------------------------------------------------------------------

  async observe(ctx: AgentContext, o: AgentObservation): Promise<AgentObserveResult> {
    const t = await this.restore(ctx);
    const p = this.pending;
    this.pending = null;
    let trip: LoopTripWithTest | null = null;
    if (p?.kind === 'act') trip = await this.observeAct(ctx, t, p, o);
    else if (p?.kind === 'verify') await this.observeVerify(ctx, p, o);
    if (trip !== null) this.state.pendingLoop = trip;
    const seqAfter = this.snapshot(ctx);
    return { loopTrip: trip === null ? null : toLoopTrip(trip), seqAfter };
  }

  private async observeAct(ctx: AgentContext, t: Transcript, p: Extract<Pending, { kind: 'act' }>, o: AgentObservation): Promise<LoopTripWithTest | null> {
    const { act, call } = p;
    const report = await reportAct(ctx, act, o);
    const test = ctx.workspaceInfo.testCommand;
    const testRun = act.tool === 'bash' && act.command !== null && isTestCommand(act.command, test);
    const unscoped = act.tool === 'bash' && act.command !== null && isUnscopedTestRun(act.command, act.workdir, test);
    // memory first (the call is resolved even if the disk append then fails), then the counters
    const appending = t.append({ kind: 'result', turn: this.state.turns, toolUseId: call.id, name: call.name === 'invalid' ? wireToolName(call.rawName) : call.name, content: ctx.redact(report.text), isError: !report.ok, summary: ctx.redact(report.summary), ...(report.pointer !== undefined ? { pointer: report.pointer } : {}) });
    if (changesWorkspace(act, o, testRun)) {
      // a change to docs alone (README.md, LICENSE, an image) is nothing a test run can check: it arms no verification
      const paths = [...(act.path !== null ? [act.path] : []), ...o.changedFiles];
      if (!isDocsOnlyChange(paths)) {
        this.state.changedSinceVerify = true;
        this.state.failedTest = null;
      }
      if (act.path !== null) this.filesEdited.add(act.path);
      for (const f of o.changedFiles) this.filesEdited.add(f);
      // the agent's own edit is not an outside change: the next edit of this file must not report a stale read
      if (act.path !== null && act.after !== null && act.tool !== 'bash') this.readHashes.set(act.path, sha12(act.after));
    }
    if (unscoped && o.outcome.status === 'executed') {
      const parsed = o.tests?.parsed ?? null;
      const exitOk = o.outcome.exec?.ok ?? false;
      if (exitOk && (parsed === null || o.tests?.allPassed !== false)) {
        this.state.changedSinceVerify = false;
        this.state.failedTest = null;
      } else if (this.state.changedSinceVerify) this.state.failedTest = { passed: parsed?.passed ?? 0, failed: parsed?.failed ?? 0, errors: parsed?.errors ?? 0, parsed: parsed !== null, exitCode: o.outcome.exec?.exitCode ?? null };
    }
    if (testRun && o.tests?.parsed) this.testTrend.push(`${o.tests.parsed.passed}p/${o.tests.parsed.failed}f`);
    if (report.refused) this.state.blocks += 1;
    const hash = report.refused
      ? resultHash({ kind: 'refused' })
      : report.failingTest && o.outcome.status === 'executed' && o.outcome.exec !== undefined
        ? resultHash({ kind: 'test', command: act.command ?? '', exec: o.outcome.exec, runner: test?.runner ?? null, fallback: report.hashBasis ?? report.text })
        : resultHash({ kind: 'text', text: report.hashBasis ?? report.text });
    const name = call.name === 'invalid' ? 'invalid' : call.name;
    const trip = feedLoop(this.state.loopWindow, { name, signature: callSignature(name, call.args, hash), testCommand: report.failingTest && testRun ? act.command : null });
    ctx.emit({ type: 'tool:result', step: ctx.step, turn: this.state.turns, id: call.id, name, ok: report.ok, summary: ctx.redact(report.summary), ms: ctx.now() - p.startedAt, chars: report.text.length, readOnly: false });
    this.remember(`act: ${report.summary}`);
    await appending;
    return trip;
  }

  private async observeVerify(ctx: AgentContext, p: Extract<Pending, { kind: 'verify' }>, o: AgentObservation): Promise<void> {
    this.state.verifyRuns += 1;
    const exec = o.outcome.status === 'executed' || o.outcome.status === 'interrupted' ? o.outcome.exec : undefined;
    let text: string;
    if (exec !== undefined && (exec.killedBy === 'timeout' || exec.killedBy === 'wall_time')) {
      text = verifyTimeout(p.command, Math.round(p.timeoutMs / 1000));
      // "not verified" is the answer: the note asks for a summary, and a second verify would only time out again
      this.state.verifyRuns = Math.max(this.state.verifyRuns, AGENT_VERIFY_MAX);
    } else if (exec !== undefined) {
      const clipped = clipMiddle(o.output, 6_000, 1_500, 4_500).text;
      text = verifyResult(p.command, bashStatusLine(exec, null, o.tests?.parsed ?? null), clipped);
      const parsed = o.tests?.parsed ?? null;
      // pass or fail, the result is handed to the model once, in the note below: a reply with no new change finishes (a
      // failure it explains is not nudged again, and the suite is not run again); a new change arms the next verify
      this.state.changedSinceVerify = false;
      this.state.failedTest = null;
      if (parsed !== null) this.testTrend.push(`${parsed.passed}p/${parsed.failed}f`);
    } else {
      text = verifyResult(p.command, o.outcome.status === 'failed' ? `could not run (${o.outcome.error})` : o.outcome.status, '');
      // the command did not run (it could not start, or it was refused or declined): a second verify would end the same way
      this.state.verifyRuns = Math.max(this.state.verifyRuns, AGENT_VERIFY_MAX);
    }
    this.remember(`verify: ${p.command} → ${exec !== undefined ? (exec.exitCode ?? 'killed') : o.outcome.status}`);
    await this.note(ctx.redact(text), 'verify');
  }
}

/** A fresh driver per run (docs/AGENT-LOOP-DESIGN.md §2.2). */
export function createDriver(): AgentDriver {
  return new Driver();
}
