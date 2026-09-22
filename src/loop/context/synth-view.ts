/**
 * contract 1.4 (COORDINATION-DESIGN §8.8 column 3, §12.0.3) / TUI-DESIGN-5 §8.2 R13: the relaxed view as
 * `SynthesisContext.contextText`.
 *
 * `llm-jev` builds the SAME message the generator modes build — `buildPrompt({ ...promptInput, context })`, one
 * `contextView(step)`, one `notePromptBuilt` — because the meter, the compaction trigger and `/context` must read the
 * same object whatever the mode (§12.0.3: "in `jev-only` / `llm-jev` after `SynthesisContext.contextText` is
 * assembled"). What a synthesizer must NOT be handed is the last section of that message: `## Your reply` names
 * `propose_action`, and the llm-jev candidate source answers `propose_fix` (docs/LLM-JEV-DESIGN.md §4.4). Handing it
 * over would tell the sample to call a tool that is not in its request.
 *
 * So exactly one section is cut, by its header, and nothing else is rewritten: the text a synthesizer receives is
 * byte-for-byte the prefix of the message the meter counted, which is what makes `promptChars` an honest number and
 * the fix prompt's `promptHash` (sha12 of system + messages) deterministic for a given step.
 */

/** The separator + header `assembleRelaxed` ends every relaxed message with (`replySection`, `src/provider/prompts.ts`). */
export const RELAXED_REPLY_HEADER = '\n\n## Your reply\n';

/**
 * The relaxed message minus its trailing `## Your reply` block. A message the §8.2 last-resort `headTail` clip
 * already cut has no such block left; it is then returned as it stands (already inside the budget).
 */
export function synthContextText(promptText: string): string {
  const cut = promptText.lastIndexOf(RELAXED_REPLY_HEADER);
  return (cut === -1 ? promptText : promptText.slice(0, cut)).trimEnd();
}
