/**
 * Propose stage (DESIGN.md §6, §7): the generator streams one proposal through the
 * propose_action tool (fenced json fallback); one retry on a malformed reply carrying the
 * reason and the raw-text tail; the second failure ends the step (§6 stage table).
 */
import { GeneratorResponseError } from '../../errors.js';
import type { ChatMessage, GenerateRequest, Proposal } from '../../core/types.js';
import { PROPOSE_ACTION_TOOL, parseProposal, rawTextTail } from '../../provider/actions.js';
import { buildRetryMessage, buildUserMessage, type PromptInput } from '../../provider/prompts.js';
import type { StageContext } from '../engine.js';

export const PROPOSE_MAX_ATTEMPTS = 2;

export interface ProposeStageResult {
  proposal: Proposal;
  attempts: number;
  /** characters of the user message(s) sent (for the flat-tokens test) */
  promptChars: number;
}

export async function runProposeStage(ctx: StageContext, systemPrompt: string, input: PromptInput): Promise<ProposeStageResult> {
  const userMessage = buildUserMessage(input);
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }];
  let promptChars = userMessage.length;
  let lastError: GeneratorResponseError | null = null;
  for (let attempt = 1; attempt <= PROPOSE_MAX_ATTEMPTS; attempt++) {
    const req: GenerateRequest = {
      system: systemPrompt,
      messages,
      maxTokens: ctx.generation.maxTokens,
      temperature: ctx.generation.temperature,
      tools: [PROPOSE_ACTION_TOOL],
      toolChoice: { name: PROPOSE_ACTION_TOOL.name },
    };
    const result = await ctx.generate(req, attempt);
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
