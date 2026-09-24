/**
 * Context stage (DESIGN.md §5.5 context, §6): pre-filter candidates to <= 300 in code, ask
 * one Noul per candidate (path-keyed state, literal file names), select p >= 0.5 descending
 * under the 12-file / 60 KB caps, read each through the workspace with a 16 KB bound.
 *
 * contract 1.9 (Fastlane) S4 / docs/LLM-LOOP-DESIGN.md §2.2 **RL2** (F27, the finishing pass): with
 * `routers: 'on'` the ask above is a SPECULATIVE ROUTE over the code pre-filter, not an inline await. It was the
 * last ask on the loop that could still end a `jev-on-next` run through a Jev outage — slot B converted RL1, RL4,
 * RL5 and RL6 and left this one inline — so invariant **I1** ("Jev routes, it never gates") was not true end to
 * end until this conversion. With the routers off the stage is byte-for-byte the pre-1.9 stage: one `if`, false.
 */
import { contextNoul } from '../../jev/questions.js';
import { isAbortError, isBudgetError } from '../../errors.js';
import { routeSpeculative, type StepToken } from '../../jev/router.js';
import { RL2_CONTEXT_DEADLINE_MS, noteStepRoute, routersOn, stepTokenFor } from '../../loop/routers.js';
import type { Candidate, CandidateView, FileView, Intent, JsonObject, Question } from '../../core/types.js';
import type { StageContext } from '../../loop/engine.js';
import { buildContextState } from '../../loop/state.js';

export const CONTEXT_MAX_CANDIDATES = 300;

/**
 * How much of the candidate set Jev is asked about (2026-09-23, "the Jev part should be minimal and seamless"): a
 * workspace of `codeOnlyMax` candidates or fewer — or any task that names one of its files — takes the code order with
 * no ask at all, and a larger one asks about the first `askMax` of the pre-filter's order, the rest trailing in code
 * order. Before this the stage asked one Noul per candidate, up to 300, before the first step of every run: the user
 * saw "78 decisions" for a one-file task. The PRODUCT (src/cli, at its createEngine sites) passes `PRODUCT_CONTEXT_ASK`;
 * an engine built without a policy keeps the legacy always-ask (`LEGACY_CONTEXT_ASK`), which is what the bench arms were
 * measured with and what every engine test written around the ask expects.
 */
export interface ContextAskPolicy {
  codeOnlyMax: number;
  askMax: number;
  /** a task that names one of the workspace's files (its path or its basename with extension) takes the code order with no ask */
  namedFileShortcut: boolean;
}
export const CONTEXT_CODE_ONLY_MAX = 16;
export const CONTEXT_ASK_MAX = 24;
export const PRODUCT_CONTEXT_ASK: ContextAskPolicy = { codeOnlyMax: CONTEXT_CODE_ONLY_MAX, askMax: CONTEXT_ASK_MAX, namedFileShortcut: true };
export const LEGACY_CONTEXT_ASK: ContextAskPolicy = { codeOnlyMax: 0, askMax: CONTEXT_MAX_CANDIDATES, namedFileShortcut: false };

/** Does the task text name this file — its workspace path, or its basename with the extension (`temp.py`)? Not a loose word. */
export function taskNamesFile(task: string, path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return task.includes(path) || (base.includes('.') && task.includes(base));
}
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

/** The 12-file / 60 KB cut, applied to an already-ordered list (each candidate's bytes clipped to 16 KB). */
function underCaps(ordered: readonly CandidateView[]): CandidateView[] {
  const out: CandidateView[] = [];
  let total = 0;
  for (const c of ordered) {
    if (out.length >= CONTEXT_MAX_FILES) break;
    const size = Math.min(c.bytes, CONTEXT_MAX_FILE_BYTES);
    if (total + size > CONTEXT_MAX_TOTAL_BYTES) continue;
    total += size;
    out.push(c);
  }
  return out;
}

/** Selection in code: p >= 0.5, descending, cap 12 files and 60 KB (by candidate bytes, each clipped to 16 KB). */
export function selectCandidates(candidates: readonly CandidateView[], probabilities: ReadonlyMap<string, number>): CandidateView[] {
  const scored = candidates
    .map((c) => ({ c, p: probabilities.get(c.path) ?? 0 }))
    .filter((x) => x.p >= CONTEXT_SELECT_THRESHOLD)
    .sort((a, b) => b.p - a.p || a.c.path.localeCompare(b.c.path));
  return underCaps(scored.map((x) => x.c));
}

/**
 * **RL2's code order** (docs/LLM-LOOP-DESIGN.md §2.2: "today's pre-filter order; traceback frames and changed
 * files are always members"). This is the selection the step is ALREADY RUNNING when the route is issued — not a
 * fallback reached after a failure — so it must be sufficient alone: the prompt carries files whatever Jev does.
 *
 * Touched first, then the pre-filter's own key (mention count, then path). Touched leads because the 12-file cap
 * is the only thing that can drop a member, and the file this run just edited is the one the generator must not
 * lose. `selectCandidates(views, new Map())` is NOT the code order: with no answers it selects nothing (every
 * probability defaults to 0, below the 0.5 threshold), which would be Jev withholding every candidate by being
 * unreachable — the exact shape I1 forbids.
 */
export function selectCandidatesCode(candidates: readonly CandidateView[]): CandidateView[] {
  const ordered = [...candidates].sort((a, b) => Number(b.touchedThisRun) - Number(a.touchedThisRun) || b.mentionsInTask - a.mentionsInTask || a.path.localeCompare(b.path));
  return underCaps(ordered);
}

export interface ContextStageResult {
  files: FileView[];
  candidates: number;
  bytes: number;
  /** how the files were chosen: the code order alone, or Jev's ranking over the asked candidates */
  selection: 'code' | 'jev';
  /** candidates Jev was asked about (0 under the code order) */
  asked: number;
}

export async function runContextStage(ctx: StageContext, common: JsonObject, intent: { intent: Intent; answer: Intent | 'none_of_these'; probability: number }): Promise<ContextStageResult> {
  const listing = await ctx.workspace.listCandidates();
  const touched = new Set<string>([...ctx.changedFiles, ...ctx.createdThisRun]);
  const views = prefilterCandidates(ctx.task, listing, touched);
  const policy = ctx.contextAsk ?? LEGACY_CONTEXT_ASK;
  const mentioned = policy.namedFileShortcut && views.some((v) => taskNamesFile(ctx.task, v.path));
  let selected: CandidateView[] = [];
  let selection: ContextStageResult['selection'] = 'code';
  let askedCount = 0;
  if (views.length > 0 && (views.length <= policy.codeOnlyMax || mentioned)) {
    // small workspace, or the task names its files: the code order is the selection and Jev is not asked
    selected = selectCandidatesCode(views);
  } else if (views.length > 0) {
    const askViews = views.slice(0, Math.max(1, policy.askMax));
    askedCount = askViews.length;
    selection = 'jev';
    // The effective intent (§6 per-outcome table): a fallback resolves to `investigate`, and the
    // question text names that step kind, so `intent.choice` must agree with it.
    const state = buildContextState(common, { choice: intent.intent, probability: intent.probability }, askViews);
    const questions = buildContextQuestions(askViews, intent.intent);
    const probabilities = new Map<string, number>();
    // I4 at the WRITE site (§2.6): the step's own token, held from before the ask so a late answer can see that
    // its step has committed. Null on the routers-off path, where this callback is the pre-1.9 one, byte for byte.
    let routed: StepToken | null = null;
    const asked = async (signal?: AbortSignal): Promise<CandidateView[]> => {
      // jev-contract: RL2 context (docs/LLM-LOOP-DESIGN.md §2.2, §2.3)
      //   escape:   Nouls only; an unanswered Noul is inert — `probabilities` simply has no entry for that path,
      //             and no Choice, no option list and no escape key is involved. There is nothing for Jev to
      //             escape TO, so the escape is structural: silence leaves the code order in place.
      //   guard:    the CODE pre-filter enumerates the candidate set (`prefilterCandidates`, <= 300) and
      //             `selectCandidatesCode` — touched files first, then the pre-filter order, under the same
      //             12-file / 60 KB caps — is the selection the step is already running. `routeSpeculative` may
      //             replace that order with Jev's only inside RL2_CONTEXT_DEADLINE_MS and only while the step
      //             token is valid; Jev can add no candidate the pre-filter did not enumerate, lift no cap and
      //             reach no file the workspace would refuse.
      //   fallback: selectCandidatesCode(views), the code pre-filter order — touched files first, so the traceback's own frames (changed files by the time the loop is chasing them) stay members whatever Jev answers or fails to answer; test: test/unit/loop/router.test.ts
      //   no-gating: ordering only. A dropped, failed or escaped ask withholds no candidate, ends no run and
      //             blocks no action — the prompt's file section is the only consumer, so the whole cost of a
      //             wrong or missing answer is a worse file order in one prompt.
      await ctx.ask(
        'context',
        state,
        questions,
        (answers) => {
          // §7.5 seam (a) / §2.6: a cancelled or post-commit answer is not this step's answer — it selects
          // nothing. Both belts stay: the signal cannot see an answer that arrives after commit under a
          // controller nobody aborted, and the token cannot see a cancellation that never reaches this callback.
          if (signal?.aborted === true || routed?.valid === false) return;
          for (const v of askViews) {
            const a = answers[contextQuestionId(v.path)];
            if (a && a.type === 'noul') probabilities.set(v.path, a.noul);
          }
        },
        // §7.5 seam (a): the PER-CALL signal. A router that drops this ask aborts it, and `askRecorded` then
        // charges nothing, writes no `jev.jsonl` row and emits no `decision` — `undefined` on the routers-off
        // path, where the call is the pre-1.9 one.
        signal,
      );
      // Jev rated nothing worth showing (or was not heard): the code order stands rather than an empty file section
      const byJev = selectCandidates(askViews, probabilities);
      return byJev.length > 0 ? byJev : selectCandidatesCode(views);
    };
    if (!routersOn(ctx.mode, ctx.routers)) {
      selected = await asked();
    } else {
      const codeOrder = selectCandidatesCode(views);
      routed = stepTokenFor(ctx.runId, ctx.step);
      const route = await routeSpeculative<CandidateView[]>({
        id: 'RL2',
        token: routed,
        codeOrder: [codeOrder],
        deadlineMs: RL2_CONTEXT_DEADLINE_MS,
        signal: ctx.signal,
        ask: async (signal) => [await asked(signal)],
      });
      // §2.6 / §5.2: the drop (or the application) becomes a `StepRecord.router` row through `commitStepRouters`
      noteStepRoute(ctx.runId, ctx.step, route);
      selected = [...(route.order[0] ?? codeOrder)];
    }
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
  return { files, candidates: views.length, bytes, selection, asked: askedCount };
}
