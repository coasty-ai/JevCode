/**
 * Kept-item EXTRACTION (docs/COORDINATION-DESIGN.md §8.6, fourth bullet; F26 of the finishing pass).
 *
 * §8.6: *"at each compaction the code extracts candidates (failing test ids + assertion lines, `edit applied to
 * X (1 match)` summaries, declined / blocked reasons, received handoffs). Whether Jev RANKS them is its own
 * switch."* `rankKept` (`compaction.ts`, TUI round-5 request R5-H2) landed with the ordering pass and its
 * question batch — and nothing ever produced a candidate. `CheckpointState.kept` had no writer, so `'code'`
 * ranked an empty list and `'jev'` had nothing to ask about: the switch was inert in both positions, and the
 * extraction that §8.6 calls "the whole mechanism" under `'code'` did not exist.
 *
 * This module is that extraction, and it is deliberately the same kind of thing the compactor is: **pure, free
 * and deterministic**. No clock, no I/O, no Jev, and no import outside `core` — the same inputs give the same
 * list on every device and after every resume (G3(d)), which is what lets `kept: 'code'` promise a prompt that
 * does not drift between two machines running the same bench arm. The failing test IDS are parsed by the
 * caller (the engine already owns `fastPathFailingIds`, the same reader the oracle uses) and handed in, so this
 * module never has to know a runner's output format.
 *
 * **What is a candidate.** A fact the RUN ESTABLISHED and that costs something to re-derive — not something the
 * prompt already carries. A file the run only *read* is in `## Files in view` already; a file it *edited* is a
 * fact about the workspace the generator would have to re-open to recover. A green suite is nothing to carry; a
 * red one is the assertion the next step is chasing.
 *
 * **What is NOT here.** The ordering (`rankKeptCode` / `rankKept`) and the bound (`KEPT_MAX`) belong to
 * `compaction.ts` and are imported, so there is exactly one definition of "the code order" and one of "24".
 */
import { clip } from '../../core/text.js';
import type { CheckpointState, FileMemory, HistoryEntry, LastTestRun, Plan } from '../../core/types.js';
import { KEPT_MAX, KEPT_TEXT_MAX, rankKeptCode, type KeptItem } from './compaction.js';

/** §8.6: at most this many failing ids become candidates — the rest are the same cluster said again. */
export const KEPT_FAILING_IDS_MAX = 8;

export interface KeptExtractInput {
  task: string;
  plan: Plan;
  history: readonly HistoryEntry[];
  fileMemory: FileMemory;
  lastTestRun: LastTestRun | null;
  /** the failing test ids of `lastTestRun`, as the engine's own reader (`fastPathFailingIds`) returned them */
  failingTests?: readonly string[];
  /** that run's output, scanned for each id's assertion line; never persisted, only mined */
  testOutput?: string | null;
  /**
   * §8.6: `/keep <text>` adds a human item. The human's own words are never ranked and never re-ordered — they
   * lead the list in the order they were given, and the cap eats the derived candidates first. Empty on a run
   * that was given none, which is every run until a surface can add one (`src/tui` owns `/keep`); a resume
   * carries them because they ride `CheckpointState.kept` like everything else.
   */
  human?: readonly KeptItem[];
  /**
   * §8.6 "do not re-derive", made true (review defect **A4**). The DERIVED items this run already holds — the
   * previous compaction's output, minus the human ones, which travel in `human` above.
   *
   * Without them the extraction is a pure function of the still-visible 12-entry history window
   * (`HISTORY_STEPS`), so a fact left this list at exactly the moment it left the prompt and `kept` could never
   * hold anything the prompt did not already carry. Measured on the review's own probe (18 steps,
   * `compactEvery: 2`): the `[replan, step 4]` line is on checkpoint 3 and gone by checkpoint 7, replaced by the
   * step-16 copy of the same sentence.
   *
   * They join the candidates as ordinary ones, so the (kind, text) dedup below keeps the NEWER step — a fact
   * re-derived this compaction refreshes rather than duplicates — and `KEPT_MAX` still bounds the whole list,
   * with `rankKeptCode`'s recency order cutting the oldest first. Accumulation is bounded, never unbounded.
   */
  carried?: readonly KeptItem[];
  /** default `KEPT_MAX` (24) */
  max?: number;
}

/** One line, clipped at §8.6's 300 chars, wherever a candidate's text comes from. */
function text(s: string): string {
  return clip(s.replace(/\s+/g, ' ').trim(), KEPT_TEXT_MAX);
}

/**
 * §8.6's "failing test ids + ASSERTION LINES": the first output line that names the id, which for every runner
 * the harness reads is the line carrying the reason (`FAILED tests/test_a.py::test_f - assert 1 == 2`). Null
 * when the output is absent or names the id nowhere, and then the id stands alone — a candidate either way.
 */
export function assertionLineFor(output: string | null | undefined, id: string): string | null {
  if (output === null || output === undefined) return null;
  for (const line of output.split('\n')) {
    if (line.includes(id) && line.trim().length > id.length) return text(line);
  }
  return null;
}

/**
 * The derived candidates, before the cap and before the order — exported so a test can assert the DERIVATION
 * separately from the ranking. Deduplicated on (kind, text): the same file edited at two steps, or the same
 * blocked reason hit twice, is one candidate at the NEWER step, because `keptKey` hashes {kind, text, step} and
 * two near-identical keys would spend two of the 16 Noul slots on one fact.
 */
export function keptCandidates(input: KeptExtractInput): KeptItem[] {
  const out: KeptItem[] = [];
  const add = (kind: KeptItem['kind'], raw: string, step: number): void => {
    const t = text(raw);
    if (t.length === 0) return;
    out.push({ kind, text: t, step, by: 'code' });
  };

  const run = input.lastTestRun;
  // 1. the failing-test summary — the counts the next step is working against. A GREEN run is not carried: there
  //    is nothing left to re-derive, and `## Recent steps` already says the suite passed.
  if (run !== null && !run.allPassed) add('fact', `${run.command} at step ${run.step}: ${run.passed} passed, ${run.failed} failed, ${run.errors} errors`, run.step);

  // 2. §8.6's first named source: each failing test id with its assertion line. These are the most expensive
  //    facts in the run to re-discover — recovering one costs a whole suite run — and the id is also the thing
  //    the generator must name exactly to talk about it.
  if (run !== null) {
    for (const id of [...(input.failingTests ?? [])].slice(0, KEPT_FAILING_IDS_MAX)) {
      const line = assertionLineFor(input.testOutput, id);
      add('fact', line === null ? `${id} fails (${run.command} at step ${run.step})` : `${id} fails at step ${run.step}: ${line}`, run.step);
    }
  }

  // 3. the files the run TOUCHED (edited, not merely read): `fileMemory.editedAt` is the engine's own record of
  //    it, and §8.6's "`edit applied to X` summaries" are exactly this fact without the free text.
  for (const [rel, m] of Object.entries(input.fileMemory)) {
    if (m.editedAt !== null) add('file', rel, m.editedAt);
  }

  // 4. declined / blocked / failed steps with a reason — §8.6's "declined / blocked reasons". A step that was
  //    refused is a constraint on every later step, and the reason is the only place it is written down.
  for (const e of input.history) {
    if (e.reason === undefined || e.reason.length === 0) continue;
    if (e.outcome !== 'declined' && e.outcome !== 'blocked' && e.outcome !== 'failed') continue;
    add('fact', `step ${e.step} ${e.action} was ${e.outcome}: ${e.reason}`, e.step);
  }

  // 5. the harness's own problems (loop trips, rejected claims, human steers), which carry their step
  for (const h of input.plan.harnessProblems) add('fact', `[${h.kind}, step ${h.step}] ${h.text}`, h.step);

  // 6. the task's constraints as the generator itself stated them: `plan.openProblems`. They carry no step (they
  //    are replaced each step and belong to the task, not to a moment), so they rank last by recency — which is
  //    right: a constraint that is still open is in `plan` and therefore already in the prompt.
  for (const p of input.plan.openProblems) add('fact', `open problem: ${p}`, 0);

  // 7. §8.6 "do not re-derive" (review defect A4): what this run already established and can no longer see.
  //    LAST, so that on an exact (kind, text, step) tie the fresh derivation is the one the dedup keeps and a
  //    carried item never pins a stale `by` over a fact the current compaction proved again for itself.
  for (const k of input.carried ?? []) {
    const t = text(k.text);
    if (t.length === 0) continue;
    out.push({ ...k, text: t });
  }

  const seen = new Map<string, KeptItem>();
  for (const item of out) {
    const key = `${item.kind}\u0000${item.text}`;
    const had = seen.get(key);
    if (had === undefined || item.step > had.step) seen.set(key, item);
  }
  return [...seen.values()];
}

/**
 * §8.6's extraction, complete: human `/keep` items first (in their own order, never ranked), then the derived
 * candidates in `rankKeptCode`'s deterministic order — newest step, then kind, then text — with the whole list
 * cut to `max` (`KEPT_MAX`, 24). The cut is applied BEFORE any ranking pass, which is what bounds the `'jev'`
 * request to §8.6's "one bounded request per compaction" whatever the run's history looks like.
 *
 * This is exactly what `CheckpointState.kept` persists, and under `kept: 'code'` — the default — it is the whole
 * mechanism: no request, no clock, no I/O, available in `jev-off`.
 */
export function extractKept(input: KeptExtractInput): KeptItem[] {
  const max = Math.max(0, input.max ?? KEPT_MAX);
  const human = (input.human ?? [])
    .filter((k) => k.text.trim().length > 0)
    .slice(0, max)
    .map((k) => ({ ...k, text: text(k.text), by: 'human' as const }));
  return [...human, ...rankKeptCode(keptCandidates(input), max - human.length)];
}

const KINDS: readonly KeptItem['kind'][] = ['fact', 'file', 'decision', 'memory'];
const BY: readonly KeptItem['by'][] = ['jev', 'human', 'code'];

/**
 * §9.3 / §10: a restored `state.json` (possibly mirrored from another device) is untrusted input, so `kept` is
 * validated and bounded on the way in exactly as `readContextExtension` does for `history` and `fileCache`. A
 * row of the wrong shape is dropped rather than repaired; a state written before the extractor existed yields
 * an empty list and the run fills it again at its next compaction.
 *
 * It lives here rather than in `readContextExtension` (`src/checkpoint/types.ts`) only because that module's
 * `ContextCheckpointExtension` is owned elsewhere; the validation belongs with the writer either way.
 */
export function readKeptItems(state: CheckpointState, max: number = KEPT_MAX): KeptItem[] {
  const raw: unknown = (state as unknown as Record<string, unknown>)['kept'];
  if (!Array.isArray(raw)) return [];
  const out: KeptItem[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const kind = r['kind'];
    const by = r['by'];
    const t = r['text'];
    const step = r['step'];
    if (typeof t !== 'string' || t.trim().length === 0) continue;
    if (!KINDS.includes(kind as KeptItem['kind']) || !BY.includes(by as KeptItem['by'])) continue;
    if (typeof step !== 'number' || !Number.isFinite(step) || step < 0) continue;
    out.push({ kind: kind as KeptItem['kind'], text: text(t), step: Math.floor(step), by: by as KeptItem['by'] });
    if (out.length >= max) break;
  }
  return out;
}
