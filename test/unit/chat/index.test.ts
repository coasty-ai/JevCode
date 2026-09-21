/**
 * TUI-DESIGN-2 §7.1 S3: `src/chat/index.ts` is the barrel every consumer imports — it re-exports the intake, the
 * catalogue, the facts, the lookup, the LLM turn, the ambiguity rows, the bubbles and the ledger.
 */
import { describe, expect, it } from 'vitest';
import * as chat from '../../../src/chat/index.js';

describe('src/chat barrel', () => {
  it('exposes the §3 surface', () => {
    for (const name of ['buildIntakeQuestions', 'buildIntakeState', 'resolveIntake', 'runIntake', 'routeOf', 'llmAnswerAllowed', 'chatKindAfterNo', 'INTAKE_RUN_FLOOR', 'REPLIES', 'buildReplyQuestion', 'pickReply', 'fillReply', 'harnessFacts', 'buildFactQuestions', 'selectFacts', 'FACT_FALSE_EXAMPLES', 'lookupCode', 'lookupLines', 'rankCandidates', 'lookupKeywords', 'buildChatRequest', 'llmChatTurn', 'CHAT_SYSTEM_PROMPT', 'intakeRowLines', 'intakeCardTitle', 'INTAKE_CARD_BODY', 'bubbleLines', 'createChatLedger'] as const) {
      expect(name in chat, name).toBe(true);
    }
    expect(chat.INTAKE_RUN_FLOOR).toBe(0.6);
    expect(chat.REPLIES).toHaveLength(14);
  });
});
