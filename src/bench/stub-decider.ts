/**
 * The `llm-sieve` arm's Decider (docs/LLM-JEV-DESIGN.md §10.1, §9.2 stage 5): "a Decider that answers nothing". The
 * arm is `llm-jev` with zero Jev requests — the synthesizer in `mode: 'llm-sieve'` replaces every question by its code
 * default, and this stub is the guarantee behind it — a question that still reaches the decider slot (the shell's
 * harm-only risk Score on an unverified `run`, the record-only judge Nouls, a replan) is answered deterministically,
 * costs nothing, takes no time, and is COUNTED so the record shows how many requests the arm would otherwise have made.
 *
 * The answers are the inert values of DESIGN §5.4 rule 6: a Noul at 0.5 sits under every "yes" cut (0.7 / 0.9) and
 * above every "no" cut (≤ 0.3; `noulsFlagAbsent` is `< 0.5`), so no gate fires either way and rankings fall through to
 * the code order; a Choice puts all its mass on the FIRST non-escape option (arrival order — Q17's "order only", the
 * code's first-candidate tie-break) with zero escape mass; a Score answers level 0 (no harm: the bench confirmer
 * declines every review anyway, so a harmful `run` is neither approved nor executed). Nothing here reads the state.
 */
import { sha12 } from '../core/hash.js';
import { toJson } from '../core/json.js';
import type { Answer, AskOptions, AskResult, Decider, Json, Question, StageName } from '../core/types.js';
import { choiceAnswer, noulAnswer, scoreAnswer } from '../jev/mock.js';
import { ESCAPE_KEY } from '../jev/questions.js';

/** What summary.json and the drift check see as the decider model of the arm (normalises to itself: no drift). */
export const STUB_DECIDER_MODEL = 'none (llm-sieve: jev stubbed)';
/** The inert Noul (DESIGN §5.4 rule 6: under every yes-cut, above every no-cut). */
export const STUB_NOUL = 0.5;

export interface StubLedger {
  requests: number;
  questions: number;
  byStage: Record<string, number>;
  byType: Record<Question['type'], number>;
}

export interface StubDecider extends Decider {
  /** what the stub answered so far (the runner copies `requests` onto the record as `stubbedJevRequests`) */
  stubbed(): StubLedger;
}

function isEscape(key: string): boolean {
  return key === ESCAPE_KEY || key.startsWith('none_of');
}

/** The deterministic answer to one question (exported for the tests and for the report's description of the arm). */
export function stubAnswer(question: Question): Answer {
  switch (question.type) {
    case 'noul':
      return noulAnswer(STUB_NOUL);
    case 'choice': {
      const keys = Object.keys(question.criteria);
      const first = keys.find((k) => !isEscape(k)) ?? keys[0];
      return choiceAnswer(question, first === undefined ? {} : { [first]: 1 });
    }
    case 'score':
      return scoreAnswer(question, { 0: 1 });
  }
}

export function createStubDecider(): StubDecider {
  const ledger: StubLedger = { requests: 0, questions: 0, byStage: {}, byType: { noul: 0, choice: 0, score: 0 } };
  return {
    model: STUB_DECIDER_MODEL,
    stubbed: () => ({ ...ledger, byStage: { ...ledger.byStage }, byType: { ...ledger.byType } }),
    async ask(state: Json, questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> {
      if (opts.signal.aborted) throw opts.signal.reason;
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = stubAnswer(q);
        ledger.byType[q.type] += 1;
      }
      const stage: StageName = opts.stage;
      ledger.requests += 1;
      ledger.questions += Object.keys(questions).length;
      ledger.byStage[stage] = (ledger.byStage[stage] ?? 0) + 1;
      const requestHash = sha12(toJson({ model: STUB_DECIDER_MODEL, state, questions }));
      // calls: 0 — the record's `jevRequests` counts requests MADE; the stub made none (its own count travels as `stubbedJevRequests`)
      return { answers, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, latencyMs: 0, model: STUB_DECIDER_MODEL, requestHash, attempts: 1, id: `stubbed-${requestHash}` };
    },
  };
}
