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

/** NaN or negative caps fail closed (0); +Infinity means "no cap" and is kept. */
export function sanitiseCap(capUsd: number): number {
  return typeof capUsd === 'number' && capUsd >= 0 ? capUsd : 0;
}

/** TUI-DESIGN §9.1 / §15 item 7: `createSpendMeter(cap, parent)`; the root of a session tree gains `setCap`. */
export function createSpendMeter(capUsd: number, parent?: SpendMeter): SpendMeter {
  let cap = sanitiseCap(capUsd);
  let generator = zeroUsage();
  let jev = zeroUsage();

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
    // exactOptionalPropertyTypes: `parent` / `parentExceeded` are spread in only with a parent, never assigned undefined
    return {
      generator: { ...generator },
      jev: { ...jev },
      totalUsd: totalUsd(),
      capUsd: cap,
      exceeded: exceeded(),
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
      // A snapshot read from a checkpoint is external input: a missing object restores zero.
      const snap: Partial<SpendSnapshot> = typeof s === 'object' && s !== null ? s : {};
      generator = sanitiseUsage(snap.generator);
      jev = sanitiseUsage(snap.jev);
    },
    child(childCapUsd: number): SpendMeter {
      return createSpendMeter(childCapUsd, meter);
    },
    setCap(newCapUsd: number): void {
      // TUI-DESIGN §9.1: the same object keeps its usage and its children; only the cap changes (+Infinity = `none`).
      cap = sanitiseCap(newCapUsd);
    },
  };
  return meter;
}
