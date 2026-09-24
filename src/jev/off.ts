/**
 * `--jev off` — the degraded path, as a code path (HARNESS-NEXT-DESIGN §1.2 last paragraph, §5 Ring 1, §8 R-9).
 *
 * The Jev-safety principle is only worth what it is tested at, so the design turns it into a continuously exercised
 * property: **with Jev off, every router takes its named code fallback and the run still finishes, only slower.**
 * This module is that switch. It replaces the Decider slot with one of two deterministic doubles:
 *
 *   `escape`      — every Choice is answered with all its mass on the escape option (`ESCAPE_KEY`, or whatever
 *                   `none_of…` key the batch carries), every Noul with the inert 0.5 of DESIGN §5.4 rule 6, and
 *                   every Score at its **top** level. The escape option is one of the five fallback triggers of
 *                   §1.2 clause 3, so this is "Jev has no opinion": each call site runs its documented code path,
 *                   and a site that silently used Jev's answer anyway shows up as a behaviour difference, not as
 *                   a crash.
 *
 *                   The Score polarity is the one place "no opinion" is not symmetric, and getting it wrong would
 *                   invert the safety principle. Every Score in this tree is a risk dimension whose levels run
 *                   ascending in severity (`src/jev-modes/stages/risk.ts RISK_LEVEL_TEXTS`, `src/jev-modes/synth/oracle/questions.ts`,
 *                   `src/perf/jev-latency.ts`): level 0 of `destructive` is "nothing existing is lost" and of
 *                   `irreversible` is "no lasting effect". An inert level 0 would therefore answer every harm Score
 *                   with the most permissive reading available — `verdict ok, risk 0.000` on a proposal the mock
 *                   decider it replaces escalates to levels n−2/n−1 on a `DANGEROUS_COMMAND` match (contract 1.9
 *                   §2.4: that deny-list is production code in `src/jev/danger.ts` now — `dangerousCommand()`, the
 *                   reason-returning form the risk stage's code-first verdict reads; `src/jev/mock.ts` re-exports the
 *                   same object, so this sentence names exactly what it always did) — which is
 *                   exactly what §1.2 clause 2 forbids ("Jev can escalate to ask/block; it can never release what
 *                   code denies") and what the harm-gate bullet spells out ("A failed or timed-out Q20 means ask …
 *                   Never allow"). The top level is the only inert answer that cannot release anything: it can cost
 *                   wall-clock (a `review`/`block` the code guard then resolves) and never correctness.
 *   `unreachable` — every ask rejects with a `JevHttpError` 503, the real outage of §8 R-9 (`no healthy upstream`
 *                   killed three runs in the head-to-head). This is what the per-router fallback tests drive.
 *
 * It is deliberately NOT the `jev-off` bench condition, which is a different thing: that arm is the generator-only
 * engine (no synthesizer, no Jev anywhere). This switch keeps the whole `llm-jev` machine and removes only the
 * router's opinions — the comparison the design's CI gate wants.
 *
 * Reached ONLY from the environment (`JEVCODE_JEV=off|escape|unreachable`) by the bench and the perf probes, which set
 * it themselves (`npm run bench` / `npm run perf`). It is a bench/perf fault switch, not a product setting: every
 * product command REFUSES to start while it is set — exit 2 (`EXIT_CODES.config`), before any network, `--plain`
 * identical, the value redacted to its first 16 code points — with the `[setup]` sentence
 *   `JEVCODE_JEV is set ("<value>") — it is a bench/perf fault switch, not a product setting; unset it, or run the bench and perf suites through npm run bench / npm run perf, which set it themselves`
 * and the fix line `unset JEVCODE_JEV` (src/cli, 0.6.0). There is no `--jev off` CLI flag.
 */
import { sha12 } from '../core/hash.js';
import { toJson } from '../core/json.js';
import type { Answer, AskOptions, AskResult, Decider, Json, Question } from '../core/types.js';
import { JevHttpError } from '../errors.js';
import { choiceAnswer, noulAnswer, scoreAnswer } from './mock.js';
import { ESCAPE_KEY } from './questions.js';

export const JEV_SWITCH_ENV = 'JEVCODE_JEV';
/** What the drift check and `summary.json` see as the decider model of a run with Jev off (normalises to itself). */
export const JEV_OFF_MODEL = 'none (--jev off)';
/** The inert Noul of DESIGN §5.4 rule 6: under every yes-cut, above every no-cut. */
export const JEV_OFF_NOUL = 0.5;

export type JevOffMode = 'escape' | 'unreachable';

export interface JevOffLedger {
  /** asks the switch answered (or refused) — the requests the run would otherwise have made */
  requests: number;
  questions: number;
  byStage: Record<string, number>;
}

export interface JevOffDecider extends Decider {
  readonly jevOff: JevOffMode;
  ledger(): JevOffLedger;
}

function isEscape(key: string): boolean {
  return key === ESCAPE_KEY || key.startsWith('none_of');
}

/** The deterministic "no opinion" answer to one question (exported for the router fallback tests). */
export function jevOffAnswer(question: Question): Answer {
  switch (question.type) {
    case 'noul':
      return noulAnswer(JEV_OFF_NOUL);
    case 'choice': {
      const keys = Object.keys(question.criteria);
      // the escape option, which §1.2 clause 3 names as a fallback trigger; a batch without one (there should be
      // none — `choice()` adds it) falls back to the last option, never to a confident first pick
      const escape = keys.find(isEscape) ?? keys[keys.length - 1];
      return choiceAnswer(question, escape === undefined ? {} : { [escape]: 1 });
    }
    case 'score':
      // the top level, never level 0: see the header — Score levels are ascending in severity everywhere in this
      // tree, so the conservative "no opinion" is the most severe one. `criteria` is Score's level list (2..10).
      return scoreAnswer(question, { [Math.max(0, question.criteria.length - 1)]: 1 });
  }
}

/** `JEVCODE_JEV`: `off` (= escape), `escape`, `unreachable`, anything else / unset → null (Jev on). */
export function jevOffModeFrom(env: NodeJS.ProcessEnv = process.env): JevOffMode | null {
  const v = (env[JEV_SWITCH_ENV] ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'escape' || v === '0') return 'escape';
  if (v === 'unreachable' || v === 'down' || v === '503') return 'unreachable';
  return null;
}

/**
 * The Decider a run uses with Jev off. Costs nothing, takes no time, counts what it answered, and never reads the
 * state — so a router that "works" against it is working off the code path, which is the whole point of the gate.
 */
export function createJevOffDecider(mode: JevOffMode = 'escape'): JevOffDecider {
  const ledger: JevOffLedger = { requests: 0, questions: 0, byStage: {} };
  return {
    model: JEV_OFF_MODEL,
    // contract 1.2 (TUI-DESIGN-2 §6 item 7): every Decider carries a provider; this is a substitution, like the bench stub
    provider: 'openrouter',
    jevOff: mode,
    ledger: () => ({ ...ledger, byStage: { ...ledger.byStage } }),
    async ask(state: Json, questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> {
      if (opts.signal.aborted) throw opts.signal.reason;
      ledger.requests += 1;
      ledger.questions += Object.keys(questions).length;
      ledger.byStage[opts.stage] = (ledger.byStage[opts.stage] ?? 0) + 1;
      if (mode === 'unreachable') {
        // the shape of the outage that cost the head-to-head three runs (§8 R-9)
        throw new JevHttpError('jev off (--jev off, unreachable): 503 no healthy upstream', { status: 503, retryable: false, body: '' });
      }
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = jevOffAnswer(q);
      const requestHash = sha12(toJson({ model: JEV_OFF_MODEL, state, questions }));
      // calls: 0 — no request was made; the count travels in the ledger instead
      return { answers, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, latencyMs: 0, model: JEV_OFF_MODEL, requestHash, attempts: 1, id: `jev-off-${requestHash}` };
    },
  };
}

/** The decider a caller should use: the switch's double when `JEVCODE_JEV` asks for it, else the one it was given. */
export function withJevOff(decider: Decider, env: NodeJS.ProcessEnv = process.env): Decider {
  const mode = jevOffModeFrom(env);
  return mode === null ? decider : createJevOffDecider(mode);
}
