/**
 * SpendMeter (DESIGN.md §4, §6 Budgets; TUI-DESIGN §9.1 D3): the only home of spend. Generator and Jev cost are
 * kept apart, summed for the cap, and forwarded to an optional parent (the bench-wide meter, or the session meter).
 *
 * add() never throws: a meter that could fail would turn a bookkeeping bug into a lost step,
 * and the caller has already paid for the tokens it is reporting. Malformed numbers are
 * clamped to 0 rather than poisoning the total with NaN, which would silently disable the cap.
 *
 * TUI-DESIGN §9.1: `setCap()` replaces the cap of the same object (`/budget session-spend-cap` mutates the root every
 * live child forwards to — a recreated root would orphan the child), and `snapshot().parent` carries the parent's
 * totals so the engine can emit session-scope `budget:warn` without knowing the parent object.
 *
 * ORCHESTRATION-DESIGN §6.2 [G6] [D6]: `hold(agentId, usd)` / `release(agentId)` / `heldUsd()` reserve money for spawned agents. They are STORAGE only —
 * `exceeded()` is deliberately untouched, because on a run meter (a real finite cap) it must keep meaning "this run spent
 * its cap", not "this session is holding money for agents"; the enforcement is `sessionRemainingUsd(cap, spent, heldUsd)`.
 * A hold belongs to the meter that took it and is never forwarded to the parent.
 */
import type { SpendMeter, SpendSnapshot, SpendSource, TokenUsage } from '../core/types.js';

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}

function nonNegative(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function sanitiseUsage(u: TokenUsage | undefined | null): TokenUsage {
  if (typeof u !== 'object' || u === null) return zeroUsage();
  return {
    inputTokens: nonNegative(u.inputTokens),
    outputTokens: nonNegative(u.outputTokens),
    costUsd: nonNegative(u.costUsd),
    calls: nonNegative(u.calls),
  };
}

function addInto(target: TokenUsage, u: TokenUsage): void {
  target.inputTokens += u.inputTokens;
  target.outputTokens += u.outputTokens;
  target.costUsd += u.costUsd;
  target.calls += u.calls;
}

/**
 * §6.2 [G6]: `restore()` recovers only the TOTAL held (a `SpendSnapshot` carries no per-agent breakdown), so it lands
 * under this reserved id. Adoption (§4.4) then rebuilds the real per-agent holds from `orchestrate/manifest-*.json`
 * crossed with the live `run.lock`s and must `release(RESTORED_HOLD_ID)` once it has, or the reserve is counted twice.
 */
export const RESTORED_HOLD_ID = '__restored__';

/** NaN or negative caps fail closed (0); +Infinity means "no cap" and is kept. */
export function sanitiseCap(capUsd: number): number {
  return typeof capUsd === 'number' && capUsd >= 0 ? capUsd : 0;
}

/** TUI-DESIGN §9.1 / §15 item 7: `createSpendMeter(cap, parent)`; the root of a session tree gains `setCap`. */
export function createSpendMeter(capUsd: number, parent?: SpendMeter): SpendMeter {
  let cap = sanitiseCap(capUsd);
  let generator = zeroUsage();
  let jev = zeroUsage();
  /**
   * §6.2 [G6]: money reserved for live agents and not yet spent, KEYED BY agent id. Never negative, never
   * non-finite, never forwarded. Keyed rather than a running total so `release` is idempotent (a double release,
   * or an adopted tree whose manifest disagrees with the ledger, cannot drive the sum negative and hand
   * `sessionRemainingUsd` more money than the cap allows) and so a re-`hold` for one agent REPLACES its reserve.
   */
  const holds = new Map<string, number>();
  function heldUsd(): number {
    let sum = 0;
    for (const v of holds.values()) sum += v;
    return sum;
  }

  function totalUsd(): number {
    return generator.costUsd + jev.costUsd;
  }
  function parentExceeded(): boolean {
    if (parent === undefined) return false;
    try {
      return parent.exceeded();
    } catch {
      return false;
    }
  }
  function exceeded(): boolean {
    return totalUsd() >= cap || parentExceeded();
  }
  /** The parent's totals for `snapshot().parent`; null when the parent misbehaves (bookkeeping never throws). */
  function parentTotals(): { totalUsd: number; capUsd: number } | null {
    if (parent === undefined) return null;
    try {
      const p = parent.snapshot();
      return { totalUsd: nonNegative(p.totalUsd), capUsd: sanitiseCap(p.capUsd) };
    } catch {
      return null;
    }
  }
  function snapshot(): SpendSnapshot {
    const p = parentTotals();
    // exactOptionalPropertyTypes: `parent` / `parentExceeded` are spread in only with a parent, never assigned undefined.
    // `heldUsd` is optional on the type (every pre-1.5 snapshot lacks it) but is ALWAYS written here, as a number — the
    // disk store must round-trip it so an adopting session can rebuild the holds after a supervisor SIGKILL (§6.2 [G6]).
    return {
      generator: { ...generator },
      jev: { ...jev },
      totalUsd: totalUsd(),
      capUsd: cap,
      exceeded: exceeded(),
      heldUsd: heldUsd(),
      ...(p ? { parentExceeded: parentExceeded(), parent: { totalUsd: p.totalUsd, capUsd: p.capUsd } } : {}),
    };
  }

  const meter: SpendMeter = {
    add(source: SpendSource, usage: TokenUsage): SpendSnapshot {
      const u = sanitiseUsage(usage);
      if (source === 'generator') addInto(generator, u);
      else addInto(jev, u);
      if (parent !== undefined) {
        try {
          parent.add(source, u);
        } catch {
          // The parent is bookkeeping too; its failure must not lose this meter's record.
        }
      }
      return snapshot();
    },
    exceeded,
    snapshot,
    restore(s: SpendSnapshot): void {
      // Only the usage is restored: the cap belongs to this run's configuration (a resume may
      // raise --spend-cap), and the parent has its own record (a bench seeds it from tasks.jsonl).
      // ORCHESTRATION-DESIGN §6.2 [G6]: `heldUsd` IS restored, and that does not weaken the rule above — a hold is
      // usage-shaped, not cap-shaped (it is money three live agents are already carrying), so an adopting session
      // that drops it under-counts in-flight spend by up to `reserveUsd` and can start a run the cap cannot afford.
      // A snapshot read from a checkpoint is external input: a missing object restores zero.
      const snap: Partial<SpendSnapshot> = typeof s === 'object' && s !== null ? s : {};
      generator = sanitiseUsage(snap.generator);
      jev = sanitiseUsage(snap.jev);
      holds.clear();
      const restored = nonNegative(snap.heldUsd);
      if (restored > 0) holds.set(RESTORED_HOLD_ID, restored);
    },
    child(childCapUsd: number): SpendMeter {
      return createSpendMeter(childCapUsd, meter);
    },
    setCap(newCapUsd: number): void {
      // TUI-DESIGN §9.1: the same object keeps its usage and its children; only the cap changes (+Infinity = `none`).
      cap = sanitiseCap(newCapUsd);
    },
    hold(agentId: string, usd: number): void {
      // §6.2 [G6]: reserve money for one spawned agent. NOT forwarded to the parent — the hold belongs to the meter
      // that took it (the session meter holds for its own children; a run meter's hold is that run's, not the
      // session's). Non-finite, negative and +Infinity amounts are ignored by `nonNegative`, exactly like a
      // malformed usage; a hold of 0 still records the id, so `release` of a known agent stays meaningful.
      if (typeof agentId !== 'string' || agentId.length === 0) return;
      holds.set(agentId, nonNegative(usd));
    },
    release(agentId: string): void {
      // §6.2 [G6]: drop one agent's reserve. Idempotent by construction — an unknown id is a no-op, and there is no
      // subtraction that could underflow. Not forwarded, like `hold`.
      if (typeof agentId !== 'string' || agentId.length === 0) return;
      holds.delete(agentId);
    },
    heldUsd,
  };
  return meter;
}
