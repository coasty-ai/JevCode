/**
 * The conversation ledger (TUI-DESIGN-2 §3.9 "Ledger"): the turns of this session's chat, bounded to
 * `LEDGER_MAX_TURNS`; the last `LEDGER_RECENT` go to Jev as `conversation` (§3.2), `stats()` feeds `/jev` line 3
 * and `/cost`'s chat line (§12 "Config, /jev, /cost, CLI"). Every `text` is stored through the caller's redactor
 * (§3.9 "Redaction"); nothing here touches the process.
 */
import type { IntakeKind, JevProvider } from '../core/types.js';

/** one turn of the conversation — the human's `[you]` line or a `[jevcode]` reply (§3.9) */
export interface ChatTurn {
  readonly role: 'you' | 'jevcode';
  /** redacted at emission (§3.10) */
  readonly text: string;
  /** ISO timestamp */
  readonly at: string;
  /** the intake reading of a `you` turn (§3.3) */
  readonly kind?: IntakeKind;
  /** Jev's probability for that reading (`/jev` line 3 `last: <kind> <p>`) */
  readonly probability?: number;
  readonly requestHash?: string;
  readonly latencyMs?: number;
  /** the Jev (or generator) cost the turn incurred */
  readonly costUsd?: number;
  readonly provider?: JevProvider | 'generator';
}

/** turns kept in memory (§3.9: "≤ 200 turns; the last 6 go to Jev") */
export const LEDGER_MAX_TURNS = 200;
export const LEDGER_RECENT = 6;

/** `/jev` line 3 and `/cost` inputs: `intake: <n> messages · p50 <ms> ms · $<usd> · last: <kind> <p>` */
export interface ChatStats {
  /** `you` turns that passed intake */
  messages: number;
  /** Σ costUsd over every turn (intake, lookup and LLM replies) */
  costUsd: number;
  /** p50 of the intake latencies; null before the first */
  p50Ms: number | null;
  last: { kind: IntakeKind; probability: number } | null;
}

export interface ChatLedger {
  push(turn: ChatTurn): void;
  /** the newest `n` turns, oldest first */
  recent(n?: number): readonly ChatTurn[];
  stats(): ChatStats;
  /** every turn kept (≤ LEDGER_MAX_TURNS) */
  readonly turns: readonly ChatTurn[];
  /** the `you` turns so far (the `chats` count of §3.5 `cost_so_far`) */
  readonly messages: number;
}

export function createChatLedger(max: number = LEDGER_MAX_TURNS): ChatLedger {
  const turns: ChatTurn[] = [];
  return {
    push(turn) {
      turns.push(turn);
      if (turns.length > max) turns.splice(0, turns.length - max);
    },
    recent(n = LEDGER_RECENT) {
      return n <= 0 ? [] : turns.slice(-n);
    },
    stats() {
      const you = turns.filter((t) => t.role === 'you');
      const latencies = you.map((t) => t.latencyMs).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
      const p50 = latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) / 2)] ?? null;
      let cost = 0;
      for (const t of turns) if (typeof t.costUsd === 'number' && Number.isFinite(t.costUsd)) cost += t.costUsd;
      const lastYou = [...you].reverse().find((t) => t.kind !== undefined);
      return {
        messages: you.length,
        costUsd: cost,
        p50Ms: p50,
        last: lastYou && lastYou.kind !== undefined ? { kind: lastYou.kind, probability: lastYou.probability ?? 0 } : null,
      };
    },
    get turns() {
      return turns;
    },
    get messages() {
      return turns.reduce((n, t) => (t.role === 'you' ? n + 1 : n), 0);
    },
  };
}
