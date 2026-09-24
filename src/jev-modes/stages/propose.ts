/**
 * Propose stage (DESIGN.md §6, §7): the generator streams one proposal through the
 * propose_action tool (fenced json fallback); one retry on a malformed reply carrying the
 * reason and the raw-text tail; the second failure ends the step (§6 stage table). A call the
 * provider DROPPED at its own deadline (docs/LLM-JEV-DESIGN.md §10.1 "drop-not-retry":
 * `stopReason` `DROPPED_CALL_STOP_REASON`, no tool call) is neither parsed nor re-asked — the
 * step ends at once under the same rule as a twice-malformed reply, and its generator.jsonl row
 * stays unmarked (it is a dropped call, not a malformed reply).
 */
import { GeneratorResponseError } from '../../errors.js';
import type { ChatMessage, GenerateRequest, Proposal } from '../../core/types.js';
import { PROPOSE_ACTION_TOOL, parseProposal, proposeActionToolFor, rawTextTail } from '../../provider/actions.js';
import { RESEARCH_ACTION_KINDS } from '../../core/types.js';
import { buildPrompt, buildRetryMessage, type PromptBuild, type PromptInput } from '../../provider/prompts.js';
import type { StageContext } from '../../loop/engine.js';

/** docs/COORDINATION-DESIGN.md §12.0.3: the meter is recomputed once the step's prompt is built, before the generator call. */
export interface ProposeStageHooks {
  onPrompt?: (build: PromptBuild) => void;
}

export const PROPOSE_MAX_ATTEMPTS = 2;
/**
 * The `GenerateResult.stopReason` of a call the provider dropped at its deadline (bench/tuned-provider.ts; the engine writes
 * the same value on a sample its own deadline aborted, core/types.ts GeneratorCallRecord). No real finish_reason spells it.
 */
export const DROPPED_CALL_STOP_REASON = 'timeout';

export interface ProposeStageResult {
  proposal: Proposal;
  attempts: number;
  /** characters of the user message(s) sent (for the flat-tokens test) */
  promptChars: number;
}

export async function runProposeStage(ctx: StageContext, systemPrompt: string, input: PromptInput, hooks?: ProposeStageHooks): Promise<ProposeStageResult> {
  const built = buildPrompt(input);
  hooks?.onPrompt?.(built);
  // ORCHESTRATION-DESIGN §2.5(b) / corner row 24: a `role: 'research'` child is never OFFERED edit | write | patch —
  // the restriction is in the tool schema as well as in code, so the model cannot even shape a write.
  const tool = ctx.orchestration?.role === 'research' ? proposeActionToolFor(RESEARCH_ACTION_KINDS) : PROPOSE_ACTION_TOOL;
  const userMessage = built.text;
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }];
  let promptChars = userMessage.length;
  let lastError: GeneratorResponseError | null = null;
  for (let attempt = 1; attempt <= PROPOSE_MAX_ATTEMPTS; attempt++) {
    const req: GenerateRequest = {
      system: systemPrompt,
      messages,
      maxTokens: ctx.generation.maxTokens,
      temperature: ctx.generation.temperature,
      tools: [tool],
      toolChoice: { name: tool.name },
    };
    const result = await ctx.generate(req, attempt);
    // §10.1 drop-not-retry: the row is recorded (metered from the provider's estimate), the step ends here
    if (result.stopReason === DROPPED_CALL_STOP_REASON && result.toolCalls.length === 0) throw new GeneratorResponseError(`call dropped at the provider's deadline (stopReason ${DROPPED_CALL_STOP_REASON}); not re-asked`, '');
    try {
      const parsed = parseProposal(result);
      const proposal: Proposal = { ...parsed, rawText: ctx.redact(parsed.rawText) };
      ctx.emit({ type: 'proposal', step: ctx.step, proposal });
      return { proposal, attempts: attempt, promptChars };
    } catch (e) {
      if (!(e instanceof GeneratorResponseError)) throw e;
      lastError = e;
      ctx.noteMalformed(attempt);
      if (attempt < PROPOSE_MAX_ATTEMPTS) {
        const retry = buildRetryMessage(e.reason, ctx.redact(rawTextTail(e.rawText)), PROPOSE_ACTION_TOOL.name);
        const assistantText = e.rawText.trim().length > 0 ? ctx.redact(e.rawText) : '(empty reply)';
        messages.push({ role: 'assistant', content: assistantText }, { role: 'user', content: retry });
        promptChars += retry.length;
      }
    }
  }
  throw new GeneratorResponseError(lastError?.reason ?? 'malformed', ctx.redact(lastError?.rawText ?? ''));
}
