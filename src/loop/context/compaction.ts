/**
 * Code compaction (docs/COORDINATION-DESIGN.md §8.6, `context.compaction: 'code'`, the default): pure, free, deterministic.
 * Same inputs → the same summary text, byte for byte (no clock inside; `at` is an input). It writes the rolling summary
 * (`Objective · Completed · Active · Blocked · Files · Tests · Notes`, ≤ 3 KiB) and collapses every history entry older than
 * the newest 2 to its one-line facts; each folded entry keeps a pointer (`dropped`) to its whole output on disk. Works in
 * jev-only. The `'llm'` template is not here (it is a generator call; §8.6 second bullet).
 *
 * §8.6 fourth bullet, `context.kept: 'code' | 'jev'` (TUI round-5 request R5-H2, landed below as `rankKept`): the KEPT
 * ITEMS' ranking pass. Extraction stays the caller's (code, always) and lives in `./kept.ts` (`extractKept`, F26 of
 * the finishing pass — it did not exist when `rankKept` landed, so this pass ranked an empty list in both switch
 * positions); this module owns the ORDER. `'code'` — the default —
 * never touches `compactCode` and never asks anything, so the `'code'` compactor stays pure, free, deterministic across
 * devices and resumes (G3(d)) and available in `jev-off`. `'jev'` spends ONE bounded request per compaction and falls
 * back to the code order on an escape or any failure.
 *
 * Trigger (`compactionDue`): every `compactEvery` steps (8; 0 disables) OR the built prompt ≥ 85 % of the budget OR a manual
 * request — evaluated by the engine at the commit of the triggering step, before the next intent.
 */
import { clip } from '../../core/text.js';
import { sha12 } from '../../core/hash.js';
import type { Answer, AskResult, CheckpointState, EngineMode, Json, LastTestRun, Plan, Question } from '../../core/types.js';
import { ESCAPE_KEY, assertQuestionBatch, choice, noul, type NoulCriteriaSpec } from '../../jev/questions.js';
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

// ---------------------------------------------------------------------------------------
// §8.6 kept items — `context.kept: 'code' | 'jev'` (TUI round-5 request R5-H2)
// ---------------------------------------------------------------------------------------

/** §8.6 / contract 1.6: one kept item, exactly the shape `CheckpointState.kept` persists. */
export type KeptItem = NonNullable<CheckpointState['kept']>[number];

/** §8.6: `CheckpointState.kept` holds at most 24 items. */
export const KEPT_MAX = 24;
/** §8.6: the one request asks about at most 16 candidates — the `keep_*` / `still_relevant_*` budget. */
export const KEPT_ASKED_MAX = 16;
/** §8.6: an item's text is ≤ 300 chars wherever it is shown. */
export const KEPT_TEXT_MAX = 300;
/** the `task` line placed in the Jev state (`SUMMARY_OBJECTIVE_CHARS`' sibling) */
export const KEPT_TASK_CHARS = 400;
/** §8.6: the state is plan + candidates and NEVER the transcript; this bounds the plan half */
export const KEPT_PLAN_ITEMS = 8;
/**
 * DESIGN §5.4 rule 6 / REPORT §14: the rejection end of the calibrated 0.3 / 0.7 band — never 0.5. When no candidate
 * clears it, Jev found nothing worth carrying and the deterministic code order stands.
 */
export const KEPT_NOUL_FLOOR = 0.3;
export const KEPT_CHOICE_ID = 'most_needed';
/** §8.6's two Noul names, kept verbatim */
export const KEPT_FACT_PREFIX = 'keep_';
export const KEPT_FILE_PREFIX = 'still_relevant_';

/** §5.4 rule 4: both sides, definition + ≥ 2 examples. The §8.6 question, made absolute. */
export const KEPT_FACT_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'Getting this fact back would cost the generator a command re-run, a file re-read or a re-derivation, and a plan item that is still open needs it.',
    examples: [
      'the exact id and assertion line of a test that still fails, while the open plan item is to make that test pass',
      'the one-line reason an edit was declined, while the plan still has to land that edit another way',
    ],
  },
  false: {
    definition: 'The fact is already visible elsewhere in the prompt, belongs to work the plan has finished, or costs nothing to look up again.',
    examples: [
      'a file path that the prompt already lists under its files-in-view section',
      'the outcome of a step whose plan item is in `plan.done`',
    ],
  },
};

/** §8.6's `still_relevant_<rel>` half: the same shape, asked about a file rather than a fact. */
export const KEPT_FILE_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'A plan item still open reads or edits this file, so its content is worth carrying into the next steps.',
    examples: [
      'a source file the next entry of `plan.remaining` edits',
      'the test file whose failing case an open plan item is still chasing',
    ],
  },
  false: {
    definition: 'Nothing left in `plan.remaining` reads or edits this file; it was in view for work that is finished.',
    examples: [
      'a config file read once to confirm a setting that has not changed since',
      'a file whose only plan item is in `plan.done`',
    ],
  },
};

const KEPT_CRITERIA_STATE: Json = {
  worth_keeping: KEPT_FACT_CRITERIA.true.definition,
  worth_keeping_examples: [...KEPT_FACT_CRITERIA.true.examples],
  not_worth_keeping: KEPT_FACT_CRITERIA.false.definition,
  not_worth_keeping_examples: [...KEPT_FACT_CRITERIA.false.examples],
};

/**
 * The deterministic code order (§8.6 `'code'`, the default). Total by construction, so it is the same on every device
 * and after every resume (G3(d)): human `/keep` items first — the human's own words are never ranked below anything a
 * router said — then newest step first, then kind, then text.
 */
function keptOrder(a: KeptItem, b: KeptItem): number {
  const human = (k: KeptItem): number => (k.by === 'human' ? 0 : 1);
  if (human(a) !== human(b)) return human(a) - human(b);
  if (a.step !== b.step) return b.step - a.step;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/** §8.6 `context.kept: 'code'`: the whole mechanism — pure, free, and identical on every device. */
export function rankKeptCode(candidates: readonly KeptItem[], max: number = KEPT_MAX): KeptItem[] {
  return [...candidates].sort(keptOrder).slice(0, Math.max(0, max));
}

/**
 * A CONTENT-derived option key (REPORT §10: an order-only key such as `keep_1` carries a position prior and collapses;
 * `src/jev-modes/synth/llm/rank.ts patchKey` takes the same route). `sha12` is over the item, so the same candidate gets the same
 * key in every request and two runs are comparable.
 */
export function keptKey(item: KeptItem, taken: ReadonlySet<string>): string {
  const base = item.kind === 'file' ? 'file' : 'fact';
  const sha = sha12({ kind: item.kind, text: item.text, step: item.step });
  for (let n = 6; n <= sha.length; n += 2) {
    const key = `${base}_${sha.slice(0, n)}`;
    if (!taken.has(key)) return key;
  }
  let i = 2;
  while (taken.has(`${base}_${sha}_${i}`)) i += 1;
  return `${base}_${sha}_${i}`;
}

export interface KeptRankInput {
  task: string;
  plan: Plan;
  /** what the code extracted this compaction (§8.6: failing test ids, edit summaries, declined reasons, handoffs) */
  candidates: readonly KeptItem[];
  /** default `KEPT_MAX` */
  max?: number;
}

/** The ONE request (§5.4 rule 1): the Choice with its escape, one absolute Noul per option, and the bounded state. */
export interface KeptRequest {
  state: Json;
  questions: Record<string, Question>;
  /** the asked candidates in code order, each with the key it was given */
  asked: readonly { key: string; item: KeptItem }[];
}

function noulIdOf(key: string, item: KeptItem): string {
  return `${item.kind === 'file' ? KEPT_FILE_PREFIX : KEPT_FACT_PREFIX}${key}`;
}

/**
 * §8.6: ONE request over ≤ 16 candidates. `null` when there is nothing to ask about — a batch of human `/keep` items
 * only, or no candidates at all — so the caller never spends a request that cannot change the order.
 */
export function buildKeptRequest(input: KeptRankInput, ordered: readonly KeptItem[]): KeptRequest | null {
  const askable = ordered.filter((k) => k.by !== 'human').slice(0, KEPT_ASKED_MAX);
  if (askable.length === 0) return null;
  const taken = new Set<string>();
  const asked = askable.map((item) => {
    const key = keptKey(item, taken);
    taken.add(key);
    return { key, item };
  });
  const candidates: Record<string, Json> = {};
  const options: Record<string, Json | null> = {};
  const questions: Record<string, Question> = {};
  for (const { key, item } of asked) {
    const text = clip(oneLine(item.text), KEPT_TEXT_MAX);
    candidates[key] = { kind: item.kind, text, step: item.step };
    options[key] = text;
    questions[noulIdOf(key, item)] =
      item.kind === 'file'
        ? noul(`Does any plan item still open in \`plan.remaining\` read or edit the file in \`candidates.${key}\`? Judge this file only; the others are judged separately.`, KEPT_FILE_CRITERIA)
        : noul(`Will the generator need the fact in \`candidates.${key}\` to finish \`task\` without re-discovering it? Judge this fact only; the others are judged separately.`, KEPT_FACT_CRITERIA);
  }
  options[ESCAPE_KEY] = 'None of these is worth carrying: every one of them is already in view, or belongs to work the plan has finished.';
  questions[KEPT_CHOICE_ID] = choice(
    `Which entry of \`candidates\` would cost the generator the most to re-discover while finishing \`task\`? Read each entry literally. Choose \`${ESCAPE_KEY}\` if none of them is worth carrying.`,
    options,
  );
  assertQuestionBatch(questions);
  const state: Json = {
    // §8.6: plan + candidates, NEVER the transcript — no history entry, no output body and no file content reaches here
    task: clip(oneLine(input.task), KEPT_TASK_CHARS),
    plan: {
      done: input.plan.done.slice(-KEPT_PLAN_ITEMS).map((d) => clip(oneLine(d.text), 200)),
      remaining: input.plan.remaining.slice(0, KEPT_PLAN_ITEMS).map((r) => clip(oneLine(r), 200)),
    },
    candidates,
    keep_criteria: KEPT_CRITERIA_STATE,
  };
  return { state, questions, asked };
}

/** Why the code order stands, or `null` when Jev ordered the kept items. */
export type KeptFallback = 'policy' | 'jev-off' | 'no-asker' | 'nothing-to-ask' | 'escaped' | 'failed' | null;

export interface KeptRankResult {
  kept: KeptItem[];
  by: 'code' | 'jev';
  fellBackTo: KeptFallback;
  /** the Noul per asked key — a `/why` row and a calibration sample, never a gate */
  nouls: Record<string, number>;
  pEscape: number | null;
  requests: number;
}

export interface KeptRankDeps {
  /** `ResolvedContextPolicy.kept`; anything but `'jev'` never asks */
  kept?: 'code' | 'jev';
  /**
   * §8.6: the pass is REFUSED in `jev-off`. The predicate is `usesJev` (`src/loop/engine.ts:558`) written out rather
   * than imported — the engine imports this module, so the import would be a cycle — and `context-kept.test.ts` pins
   * the four modes against it.
   */
  mode: EngineMode;
  /** the metered seam the engine already owns; absent means there is nothing to ask with */
  ask?: (state: Json, questions: Record<string, Question>) => Promise<AskResult>;
}

/**
 * Only the ANSWERED candidates are permuted, and only among the positions they already occupied: a human item and an
 * unanswered candidate both hold their code rank whatever Jev said. That is what makes the pass an ORDERING of the
 * code's own list rather than a second selection.
 */
function permuteAnswered(ordered: readonly KeptItem[], asked: readonly { key: string; item: KeptItem }[], nouls: Record<string, number>): KeptItem[] {
  const noulOf = new Map<KeptItem, number>();
  for (const { key, item } of asked) {
    const n = nouls[key];
    if (n !== undefined) noulOf.set(item, n);
  }
  const index = new Map<KeptItem, number>();
  ordered.forEach((item, i) => index.set(item, i));
  const positions = ordered.map((item, i) => (noulOf.has(item) ? i : -1)).filter((i) => i >= 0);
  const promoted = positions
    .map((i) => ordered[i] as KeptItem)
    .sort((a, b) => (noulOf.get(b) ?? 0) - (noulOf.get(a) ?? 0) || (index.get(a) ?? 0) - (index.get(b) ?? 0));
  const out = [...ordered];
  positions.forEach((pos, k) => {
    out[pos] = promoted[k] as KeptItem;
  });
  return out;
}

/**
 * §8.6 `context.kept`: the kept items in the order the prompt's `## Kept (do not re-derive)` renders them.
 *
 * `'code'` (the default) is `rankKeptCode` and nothing else — no request, no clock, no I/O, byte-identical in
 * `jev-off` and on every device. `'jev'` spends ONE request and can only PERMUTE the answered part of that same list;
 * every route out of the Jev branch (policy, `jev-off`, no asker, nothing askable, an escape, a throw) returns the
 * code order untouched, with `fellBackTo` naming which one it was.
 */
export async function rankKept(input: KeptRankInput, deps: KeptRankDeps): Promise<KeptRankResult> {
  const ordered = rankKeptCode(input.candidates, input.max ?? KEPT_MAX);
  const codeOrder = (fellBackTo: KeptFallback, nouls: Record<string, number> = {}, pEscape: number | null = null, requests = 0): KeptRankResult => ({
    kept: ordered,
    by: 'code',
    fellBackTo,
    nouls,
    pEscape,
    requests,
  });
  if ((deps.kept ?? 'code') !== 'jev') return codeOrder('policy');
  if (deps.mode === 'jev-off') return codeOrder('jev-off');
  if (deps.ask === undefined) return codeOrder('no-asker');
  const request = buildKeptRequest(input, ordered);
  if (request === null) return codeOrder('nothing-to-ask');

  let answers: Record<string, Answer>;
  try {
    // jev-contract: R5-H2 kept_rank — the §8.6 kept-items ordering pass behind `context.kept: 'jev'` (TUI round-5 R5-H2)
    //   escape: the batch is built by src/jev/questions.ts — choice() guarantees ESCAPE_KEY on `most_needed`, and every non-escape option carries its own absolute Noul (§8.6's `keep_*` / `still_relevant_*`); an escape at or above the best candidate, or every Noul under KEPT_NOUL_FLOOR (0.3 — the §5.4 rule 6 band, never 0.5), IS the escape and the code order stands
    //   guard: human `/keep` items are never asked about and never move; permuteAnswered() reorders only the ANSWERED candidates and only within the positions they already held; the KEPT_MAX cut is the code's and ran before the ask
    //   fallback: rankKeptCode()'s deterministic order, returned unchanged under 'code', under jev-off, with no asker, with nothing askable, on an escape and on any throw; test: test/unit/loop/context-kept.test.ts
    //   no-gating: ordering only — a kept item is a prompt hint, so being wrong costs the generator one re-read of something it already knew; nothing here touches completion, acceptance or a test result, and compactCode() is byte-identical either way
    const got = await deps.ask(request.state, request.questions);
    answers = got.answers;
  } catch {
    return codeOrder('failed', {}, null, 1);
  }

  const nouls: Record<string, number> = {};
  for (const { key, item } of request.asked) {
    const a = answers[noulIdOf(key, item)];
    if (a !== undefined && a.type === 'noul' && Number.isFinite(a.noul)) nouls[key] = a.noul;
  }
  const picked = answers[KEPT_CHOICE_ID];
  const probabilities = picked !== undefined && picked.type === 'choice' ? picked.probabilities : null;
  const pEscape = probabilities === null ? null : (probabilities[ESCAPE_KEY] ?? null);
  const pBest = probabilities === null ? null : Math.max(0, ...request.asked.map(({ key }) => probabilities[key] ?? 0));
  const values = Object.values(nouls);
  const escaped = values.length === 0 || Math.max(...values) < KEPT_NOUL_FLOOR || (pEscape !== null && pBest !== null && pEscape >= pBest);
  if (escaped) return codeOrder('escaped', nouls, pEscape, 1);
  return { kept: permuteAnswered(ordered, request.asked, nouls), by: 'jev', fellBackTo: null, nouls, pEscape, requests: 1 };
}
