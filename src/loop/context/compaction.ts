/**
 * Code compaction (docs/COORDINATION-DESIGN.md §8.6, `context.compaction: 'code'`, the default): pure, free, deterministic.
 * Same inputs → the same summary text, byte for byte (no clock inside; `at` is an input). It writes the rolling summary
 * (`Objective · Completed · Active · Blocked · Files · Tests · Notes`, ≤ 3 KiB) and collapses every history entry older than
 * the newest 2 to its one-line facts; each folded entry keeps a pointer (`dropped`) to its whole output on disk. Works in
 * jev-only. The `'llm'` template and the Jev-kept request are not here (they are calls; §8.6 second and fourth bullets).
 *
 * Trigger (`compactionDue`): every `compactEvery` steps (8; 0 disables) OR the built prompt ≥ 85 % of the budget OR a manual
 * request — evaluated by the engine at the commit of the triggering step, before the next intent.
 */
import { clip } from '../../core/text.js';
import type { LastTestRun, Plan } from '../../core/types.js';
import { collapseHistory, oneLiner } from './history.js';
import {
  COMPACT_AT_PCT,
  HISTORY_WHOLE,
  SUMMARY_ACTIVE_ITEMS,
  SUMMARY_BLOCKED_CHARS,
  SUMMARY_BLOCKED_ITEMS,
  SUMMARY_COMPLETED_ITEMS,
  SUMMARY_FILES_ITEMS,
  SUMMARY_NOTES_MAX,
  SUMMARY_OBJECTIVE_CHARS,
  SUMMARY_TEXT_MAX_CHARS,
} from './limits.js';
import type { CompactionMode, FileMemory, HistoryEntry } from '../../core/types.js';
import type { ContextSummary, SummarySection } from './types.js';

export const SUMMARY_SECTIONS: readonly SummarySection[] = ['Objective', 'Completed', 'Active', 'Blocked', 'Files', 'Tests', 'Notes'];

export interface CompactionInput {
  /** the step whose commit triggers the fold */
  step: number;
  /** ISO time, recorded on the summary; not part of `text` */
  at: string;
  task: string;
  plan: Plan;
  history: readonly HistoryEntry[];
  fileMemory: FileMemory;
  lastTestRun: LastTestRun | null;
  /** the previous summary, whose Notes roll forward */
  previous: ContextSummary | null;
  /** entries kept verbatim (default 2) */
  keepNewest?: number;
}

/** A folded entry's pointer: the one-line fact and where the whole output is. */
export interface DroppedPointer {
  step: number;
  line: string;
  ref: string | null;
}

export interface CompactionResult {
  summary: ContextSummary;
  history: HistoryEntry[];
  dropped: DroppedPointer[];
  /** persisted history + summary chars before → after (what the `context:compacted` event reports) */
  chars: { before: number; after: number };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function counts(t: LastTestRun): string {
  return `${t.passed} passed, ${t.failed} failed, ${t.errors} errors`;
}

function byPath(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** The seven sections, each a list of one-line items, bounded as §8.6 states. */
export function buildSummarySections(input: CompactionInput, folded: readonly HistoryEntry[]): Record<SummarySection, string[]> {
  const plan = input.plan;
  const tests = input.lastTestRun;
  const completed = plan.done.slice(-SUMMARY_COMPLETED_ITEMS).map((d) => {
    const judged = d.evidence.judged >= 0 ? `, judged ${d.evidence.judged.toFixed(2)}` : '';
    const verified = tests !== null && tests.step === d.evidence.step ? `; tests ${counts(tests)}` : '';
    return clip(`${oneLine(d.text)} (step ${d.evidence.step}${judged}${verified})`, 200);
  });
  const files = Object.entries(input.fileMemory)
    .sort((a, b) => Math.max(b[1].readAt ?? 0, b[1].editedAt ?? 0) - Math.max(a[1].readAt ?? 0, a[1].editedAt ?? 0) || byPath(a, b))
    .slice(0, SUMMARY_FILES_ITEMS)
    .map(([rel, m]) => {
      const when: string[] = [];
      if (m.readAt !== null) when.push(`read at step ${m.readAt}`);
      if (m.editedAt !== null) when.push(`edited at step ${m.editedAt}`);
      const sha = m.sha12 === null ? '' : ` (sha ${m.sha12.slice(0, 4)}…)`;
      return clip(`${rel} — ${when.length > 0 ? when.join(', ') : 'known'}${sha}`, 200);
    });
  const notes = [...(input.previous?.sections.Notes ?? []), ...folded.map((e) => oneLiner(e))].slice(-SUMMARY_NOTES_MAX);
  return {
    Objective: [clip(oneLine(input.task), SUMMARY_OBJECTIVE_CHARS)],
    Completed: completed,
    Active: plan.remaining.slice(0, SUMMARY_ACTIVE_ITEMS).map((r) => clip(oneLine(r), 200)),
    Blocked: plan.harnessProblems.slice(-SUMMARY_BLOCKED_ITEMS).map((h) => clip(`[${h.kind}, step ${h.step}] ${oneLine(h.text)}`, SUMMARY_BLOCKED_CHARS)),
    Files: files,
    Tests: tests === null ? ['no parsed test run yet'] : [`${oneLine(tests.command)}: ${counts(tests)} (step ${tests.step}${tests.allPassed ? ', all passed' : ''})`],
    Notes: notes,
  };
}

function renderOnce(sections: Record<SummarySection, string[]>): string {
  const lines: string[] = [];
  for (const name of SUMMARY_SECTIONS) {
    const items = sections[name];
    if (items.length === 0) continue;
    lines.push(`${name}:`);
    for (const it of items) lines.push(`- ${it}`);
  }
  return lines.join('\n');
}

/** The summary text, ≤ 3 KiB: the oldest Notes go first when it does not fit, then Files, then a last-resort clip. */
export function renderSummary(sections: Record<SummarySection, string[]>, max: number = SUMMARY_TEXT_MAX_CHARS): string {
  const s: Record<SummarySection, string[]> = { ...sections, Notes: [...sections.Notes], Files: [...sections.Files] };
  let text = renderOnce(s);
  while (text.length > max && s.Notes.length > 0) {
    s.Notes.shift();
    text = renderOnce(s);
  }
  while (text.length > max && s.Files.length > 0) {
    s.Files.pop();
    text = renderOnce(s);
  }
  return text.length > max ? clip(text, max) : text;
}

function persistedChars(history: readonly HistoryEntry[], summary: ContextSummary | null): number {
  return JSON.stringify(history).length + (summary === null ? 0 : summary.text.length);
}

/** §8.6 `'code'`: fold everything older than the newest `keepNewest` entries into the rolling summary. Pure and deterministic. */
export function compactCode(input: CompactionInput): CompactionResult {
  const keepNewest = input.keepNewest ?? HISTORY_WHOLE;
  const { history, folded } = collapseHistory(input.history, keepNewest);
  const sections = buildSummarySections(input, folded);
  const text = renderSummary(sections);
  const summary: ContextSummary = { v: 1, step: input.step, at: input.at, by: 'code', sections, text };
  const dropped = folded.map((e) => ({ step: e.step, line: oneLiner(e), ref: e.outputRef ?? null }));
  return { summary, history, dropped, chars: { before: persistedChars(input.history, input.previous), after: persistedChars(history, summary) } };
}

/**
 * §8.6: every trigger. `'manual'` is `/compact` — the TUI command owns that verb, so the engine seam is
 * `compactionDue({ manual: true })`; `'resume'` is the §8.6 fourth trigger, taken only when the resume folded rows past
 * the history window (review finding 53).
 * `/compact now` reaches it through `Engine.compact()` (contract 1.4, §12.0.2).
 */
export type CompactionTrigger = 'interval' | 'budget' | 'manual' | 'resume';

export interface CompactionDueInput {
  step: number;
  /** `context.compactEvery`; 0 disables the interval trigger */
  compactEvery: number;
  /** the meter's pct after the step's prompt was built */
  pct: number;
  compactAtPct?: number;
  mode: CompactionMode;
  /** entries a fold would actually collapse (`foldableCount`); 0 → nothing is due (review finding 53) */
  foldable: number;
  /** `/compact` was requested (the TUI verb; see `CompactionTrigger`) */
  manual?: boolean;
  /** §8.6 fourth trigger: this is the first prompt after a resume that folded rows past the history window */
  resume?: boolean;
}

/** Structural check of a `context/summary.json` read back from disk. */
export function isContextSummary(v: unknown): v is ContextSummary {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o['v'] !== 1 || typeof o['step'] !== 'number' || typeof o['at'] !== 'string' || typeof o['text'] !== 'string') return false;
  if (o['by'] !== 'code' && o['by'] !== 'llm') return false;
  const sections = o['sections'];
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) return false;
  const s = sections as Record<string, unknown>;
  return SUMMARY_SECTIONS.every((name) => Array.isArray(s[name]) && (s[name] as unknown[]).every((x) => typeof x === 'string'));
}

/**
 * Which trigger fires at this commit, or null. Nothing fires under `'off'` or when a fold would collapse nothing — so
 * "deterministic" holds for the fold AND for the counters: the same (state, budget) yields the same `compactions`
 * whatever the resume history (review finding 53).
 */
export function compactionDue(i: CompactionDueInput): CompactionTrigger | null {
  if (i.mode === 'off') return null;
  if (i.foldable <= 0) return null;
  if (i.manual) return 'manual';
  if (i.resume) return 'resume';
  if (i.pct >= (i.compactAtPct ?? COMPACT_AT_PCT)) return 'budget';
  if (i.compactEvery > 0 && i.step % i.compactEvery === 0) return 'interval';
  return null;
}
