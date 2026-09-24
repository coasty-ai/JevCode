/**
 * The decider of a session with no Jev key (docs/AGENT-LOOP-DESIGN.md §14.2).
 *
 * In `agent` mode the Jev key is optional: Jev makes only quick routing calls, each with a code fallback, so a run
 * without it is the same run minus those hints. The engine still needs a `Decider` in its options, and a resume
 * rebuilds one, so both session engine-building sites pass this one when no Jev key resolves — otherwise an agent run
 * of a user without a Jev key could be neither started nor resumed.
 *
 * It never sends anything. `ask` rejects with the typed `JevUnavailableError`, which `routeSpeculative`'s single drop
 * branch turns into the site's code fallback like any other Jev failure (it is not one of the router-fatal errors). The
 * engine recognises the decider by its model, `ABSENT_DECIDER_MODEL`, and sets `AgentContext.jevAvailable = false`, so
 * no agent placement asks in the first place and no wait is spent.
 *
 * `JevUnavailableError` is a `JevError` and deliberately NOT a `JevHttpError`: the engine's blocking classifier opens
 * the auto-retrying "jev unreachable" pane only for HTTP failures, and there is nothing to retry when no key exists.
 * The legacy modes never see this decider — they require the Jev key (`missingSecrets`).
 */
import type { AskOptions, AskResult, Decider, Json, Question } from '../core/types.js';
import { JevError } from '../errors.js';

/** What the engine and `summary.json` see as the decider model of a session without a Jev key. */
export const ABSENT_DECIDER_MODEL = 'none (no Jev key)';

/** Every ask of the absent decider rejects with this: no Jev key resolved, so the request was never sent. */
export class JevUnavailableError extends JevError {
  constructor(stage?: string) {
    super('jev_http', `Jev is not available in this session (no Jev key); ${stage === undefined ? 'the' : `the ${stage}`} ask was not sent`);
  }
}

/** The Decider a session builds when no Jev key resolves: costs nothing, sends nothing, answers nothing. */
export function createAbsentDecider(): Decider {
  return {
    model: ABSENT_DECIDER_MODEL,
    // every Decider carries a provider (contract 1.2 item 7); like the --jev off double, this one is a substitution
    provider: 'openrouter',
    async ask(_state: Json, _questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> {
      if (opts.signal.aborted) throw opts.signal.reason;
      throw new JevUnavailableError(opts.stage);
    },
  };
}
