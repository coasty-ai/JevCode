/**
 * Context stage (DESIGN.md §5.5 context, §6): pre-filter candidates to <= 300 in code, ask
 * one Noul per candidate (path-keyed state, literal file names), select p >= 0.5 descending
 * under the 12-file / 60 KB caps, read each through the workspace with a 16 KB bound.
 */
import { contextNoul } from '../../jev/questions.js';
import { isAbortError, isBudgetError } from '../../errors.js';
import type { Candidate, CandidateView, FileView, Intent, JsonObject, Question } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { buildContextState } from '../state.js';

export const CONTEXT_MAX_CANDIDATES = 300;
export const CONTEXT_MAX_FILES = 12;
export const CONTEXT_MAX_TOTAL_BYTES = 61_440;
export const CONTEXT_MAX_FILE_BYTES = 16_384;
export const CONTEXT_SELECT_THRESHOLD = 0.5;

const WORD_RE = /[A-Za-z0-9_][A-Za-z0-9_./-]*/g;

/** Count of task tokens that name the path or its basename (stem included). */
export function mentionsInTask(task: string, path: string, taskTokens?: readonly string[]): number {
  const tokens = taskTokens ?? tokenise(task);
  const base = path.split('/').pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, '');
  let n = 0;
  for (const t of tokens) {
    if (t === path || t === base || t.endsWith(`/${path}`) || t.endsWith(`/${base}`)) n += 1;
    else if (stem.length >= 4 && t === stem) n += 1;
  }
  return n;
}

export function tokenise(task: string): string[] {
  return task.match(WORD_RE) ?? [];
}

/** Build views and pre-filter to <= CONTEXT_MAX_CANDIDATES by mention count, then recency (touched first), then path. */
export function prefilterCandidates(task: string, candidates: readonly Candidate[], touched: ReadonlySet<string>): CandidateView[] {
  const tokens = tokenise(task);
  const views: CandidateView[] = candidates.map((c) => ({ path: c.path, bytes: c.bytes, mentionsInTask: mentionsInTask(task, c.path, tokens), touchedThisRun: touched.has(c.path) }));
  views.sort((a, b) => b.mentionsInTask - a.mentionsInTask || Number(b.touchedThisRun) - Number(a.touchedThisRun) || a.path.localeCompare(b.path));
  return views.slice(0, CONTEXT_MAX_CANDIDATES);
}

export function contextQuestionId(path: string): string {
  return `show:${path}`;
}

export function buildContextQuestions(candidates: readonly CandidateView[], intent: Intent): Record<string, Question> {
  const qs: Record<string, Question> = {};
  for (const c of candidates) {
    qs[contextQuestionId(c.path)] = contextNoul(
      `Should the engineer be shown the file \`${c.path}\` (details at \`candidates["${c.path}"]\`) for an \`${intent}\` step (\`intent.choice\`)? Apply \`criteria.context\`.`,
    );
  }
  return qs;
}

/** Selection in code: p >= 0.5, descending, cap 12 files and 60 KB (by candidate bytes, each clipped to 16 KB). */
export function selectCandidates(candidates: readonly CandidateView[], probabilities: ReadonlyMap<string, number>): CandidateView[] {
  const scored = candidates
    .map((c) => ({ c, p: probabilities.get(c.path) ?? 0 }))
    .filter((x) => x.p >= CONTEXT_SELECT_THRESHOLD)
    .sort((a, b) => b.p - a.p || a.c.path.localeCompare(b.c.path));
  const out: CandidateView[] = [];
  let total = 0;
  for (const { c } of scored) {
    if (out.length >= CONTEXT_MAX_FILES) break;
    const size = Math.min(c.bytes, CONTEXT_MAX_FILE_BYTES);
    if (total + size > CONTEXT_MAX_TOTAL_BYTES) continue;
    total += size;
    out.push(c);
  }
  return out;
}

export interface ContextStageResult {
  files: FileView[];
  candidates: number;
  bytes: number;
}

export async function runContextStage(ctx: StageContext, common: JsonObject, intent: { intent: Intent; answer: Intent | 'none_of_these'; probability: number }): Promise<ContextStageResult> {
  const listing = await ctx.workspace.listCandidates();
  const touched = new Set<string>([...ctx.changedFiles, ...ctx.createdThisRun]);
  const views = prefilterCandidates(ctx.task, listing, touched);
  let selected: CandidateView[] = [];
  if (views.length > 0) {
    // The effective intent (§6 per-outcome table): a fallback resolves to `investigate`, and the
    // question text names that step kind, so `intent.choice` must agree with it.
    const state = buildContextState(common, { choice: intent.intent, probability: intent.probability }, views);
    const questions = buildContextQuestions(views, intent.intent);
    const probabilities = new Map<string, number>();
    await ctx.ask('context', state, questions, (answers) => {
      for (const v of views) {
        const a = answers[contextQuestionId(v.path)];
        if (a && a.type === 'noul') probabilities.set(v.path, a.noul);
      }
    });
    selected = selectCandidates(views, probabilities);
  }
  const files: FileView[] = [];
  let bytes = 0;
  for (const c of selected) {
    try {
      const view = await ctx.workspace.read(c.path, CONTEXT_MAX_FILE_BYTES);
      if (bytes + view.content.length > CONTEXT_MAX_TOTAL_BYTES) continue;
      bytes += view.content.length;
      files.push({ ...view, content: ctx.redact(view.content) });
    } catch (e) {
      // Shutdown and wall-time must reach the engine's §9.1 handling, not continue into propose.
      if (ctx.signal.aborted || isAbortError(e) || isBudgetError(e)) throw e;
      // A file that vanished or escapes the workspace is dropped, not fatal: the generator can `read` it.
      ctx.emit({ type: 'transcript', step: ctx.step, level: 'warn', text: `context: could not read ${c.path}: ${e instanceof Error ? ctx.redact(e.message) : String(e)}` });
    }
  }
  ctx.emit({ type: 'context', step: ctx.step, files: files.map((f) => f.path), bytes, candidates: views.length });
  return { files, candidates: views.length, bytes };
}
