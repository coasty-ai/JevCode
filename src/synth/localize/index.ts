/**
 * Jev-only fault localisation (docs/JEV-ONLY.md; measurements in
 * experiments/results/probe-localization.md and probe-swebench-understanding.md).
 *
 * One pipeline with beams, code proposes and Jev decides at every level:
 *   1. files      Nouls "must `path` change to accomplish `task`" over every workspace path,
 *                 ≤ 250 per request, concurrent; consume by rank (top-5), never by threshold.
 *   2. confirm    one request of Nouls over the beam with top-level symbol outlines; re-rank.
 *   3. functions  one Choice per beam file over its defs (signature line, nested classes
 *                 flattened, module-level option); global top-5 by file × function probability.
 *   4. lines      one Choice per function over its code lines with the failing tests and what
 *                 the buggy program actually did (variant D, the only wording that moved top-1
 *                 materially); top-3 anchors per function, unioned with SBFL's top-3 when given.
 * Sites are ±3-line windows around the anchors plus an insert gap before and after each anchor.
 * A one-file workspace skips stages 1–3 and asks one flat line Choice (hierarchy did not help on
 * small files). Listings are cut to the function and shrunk until the 32k-token cap holds.
 */
import type { Answer, Json, Question } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import type { RankedLine } from '../sbfl/types.js';
import type { FileCandidate, FunctionCandidate, LocalizeResult, SourceFile } from '../types.js';
import { centredWindow, estimateRequestTokens, fitRequestToCap } from './budget.js';
import { functionKey, lineOfKey } from './keys.js';
import { codeLines, entryAt, functionEntries, moduleCodeLines, moduleEntry, outline, tracebackFrames } from './outline.js';
import type { CodeLine } from './outline.js';
import { FUNCTION_QUESTION_ID, LINE_QUESTION_ID, confirmStage, fileStage, functionStage, lineStage } from './questions.js';
import type { FunctionOption, LineStageInput } from './questions.js';
import { buildSites, sbflKey } from './sites.js';
import type { Anchor } from './sites.js';
import { DEFAULT_LOCALIZER_OPTIONS, MODULE_LEVEL_KEY } from './types.js';
import type { FunctionEntry, LocalizeContext, LocalizerOptions, TracebackFrame } from './types.js';

export { DEFAULT_LOCALIZER_OPTIONS, MODULE_LEVEL_KEY, MODULE_LEVEL_NAME } from './types.js';
export type { FunctionEntry, LocalizeBudget, LocalizeContext, LocalizerOptions, TracebackFrame } from './types.js';
export { CHARS_PER_TOKEN, TASK_CHARS_MAX, TRACEBACK_CHARS_MAX, centredWindow, clip, clipTail, estimateRequestTokens, estimateTokens, fitRequestToCap, fitToCap } from './budget.js';
export type { JevRequestShape } from './budget.js';
export { functionKey, lineKey, lineOfKey, pathKey } from './keys.js';
export { OUTLINE_MAX, codeLines, entryAt, functionEntries, moduleCodeLines, moduleEntry, outline, tracebackFrames } from './outline.js';
export type { CodeLine } from './outline.js';
export { FAILING_RUN_SUFFIX, FILE_CRITERIA, FUNCTION_QUESTION_ID, LINE_QUESTION, LINE_QUESTION_ID, MODULE_LEVEL_DESCRIPTION, confirmStage, failureViews, fileStage, functionStage, lineStage } from './questions.js';
export type { FileStageRequest, FunctionOption, LineStageInput } from './questions.js';
export { buildSites, functionGapSlots, gapIndentsAfter, indentAfter, indentBefore, sbflKey } from './sites.js';
export type { Anchor, GapIndents, GapPosition, GapSlot, SiteBuildInput } from './sites.js';

export interface Localizer {
  localize(ctx: LocalizeContext): Promise<LocalizeResult>;
}

export function createLocalizer(opts: Partial<LocalizerOptions> = {}): Localizer {
  const o: LocalizerOptions = { ...DEFAULT_LOCALIZER_OPTIONS, ...opts };
  return { localize: (ctx) => localize(ctx, o) };
}

// ---------------------------------------------------------------------------------------
// Request accounting
// ---------------------------------------------------------------------------------------

/** Counts requests against the budget and checks the abort signal before every call. */
class Asker {
  requests = 0;
  private readonly ctx: LocalizeContext;
  private readonly o: LocalizerOptions;
  constructor(ctx: LocalizeContext, o: LocalizerOptions) {
    this.ctx = ctx;
    this.o = o;
  }
  /** Can `n` more requests be made while leaving `reserve` for the later stages? */
  canAsk(n = 1, reserve = 0): boolean {
    return this.requests + n + reserve <= this.ctx.budget.maxRequests;
  }
  /** How many requests fit now, keeping `reserve` (never negative). */
  affordable(reserve: number): number {
    return Math.max(0, this.ctx.budget.maxRequests - this.requests - reserve);
  }
  async ask(state: Json, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    if (this.ctx.signal.aborted) throw new AbortError('signal');
    if (!this.canAsk()) throw new Error(`localize: request budget of ${this.ctx.budget.maxRequests} exhausted`);
    this.requests += 1;
    const r = await this.ctx.ask(this.o.stage, state, questions);
    return r.answers;
  }
}

function noulP(a: Answer | undefined): number {
  return a !== undefined && a.type === 'noul' ? a.noul : 0;
}

/** Option probabilities of a Choice answer minus the escape (ranking falls through the escape, measured §8). */
function choiceProbs(a: Answer | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (a === undefined || a.type !== 'choice') return out;
  for (const [k, p] of Object.entries(a.probabilities)) if (k !== 'none_of_these') out.set(k, p);
  return out;
}

function byProbabilityDesc<T>(items: readonly T[], p: (t: T) => number): T[] {
  // stable: equal probabilities keep their input order (deterministic under ties)
  return items.map((t, i) => ({ t, i })).sort((x, y) => p(y.t) - p(x.t) || x.i - y.i).map((x) => x.t);
}

// ---------------------------------------------------------------------------------------
// Ordering of paths (matters only when the budget cuts the file stage short)
// ---------------------------------------------------------------------------------------

function mentionScore(path: string, frames: readonly TracebackFrame[], text: string): number {
  if (frames.some((f) => f.path === path)) return 2;
  const stem = path.split('/').pop()?.replace(/\.py$/, '') ?? path;
  if (stem !== '' && stem !== '__init__' && text.includes(stem)) return 1;
  return 0;
}

function orderedPaths(ctx: LocalizeContext, frames: readonly TracebackFrame[]): string[] {
  const text = `${ctx.task}\n${ctx.failures.map((f) => `${f.testId} ${f.call} ${f.actual}`).join('\n')}`;
  return [...ctx.files.keys()].sort((a, b) => mentionScore(b, frames, text) - mentionScore(a, frames, text) || (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------

interface FileBeamEntry {
  file: SourceFile;
  probability: number;
  outline?: string[];
}

interface FunctionBeamEntry {
  entry: FunctionEntry;
  fileProbability: number;
  probability: number;
  /** fileProbability × probability: the beam-search path score */
  joint: number;
}

async function localize(ctx: LocalizeContext, o: LocalizerOptions): Promise<LocalizeResult> {
  if (ctx.signal.aborted) throw new AbortError('signal');
  const asker = new Asker(ctx, o);
  const frames = tracebackFrames(ctx.traceback, ctx.files);
  const sbfl = new Map<string, RankedLine>();
  for (const r of ctx.sbfl ?? []) if (ctx.files.has(r.file)) sbfl.set(sbflKey(r.file, r.line), r);

  if (ctx.files.size === 0) return { files: [], functions: [], sites: [], requests: 0 };

  const single = ctx.files.size === 1 ? [...ctx.files.values()][0]! : null;
  if (single !== null && codeLines(single.mod, 1, single.mod.lines.length).length <= o.maxChoiceOptions) {
    return singleFileFlat(ctx, o, asker, single, frames, sbfl);
  }

  // Stage 1: files (skipped when every file fits in the beam: the Nouls would only order them,
  // and the confirmation pass does that with more evidence). It needs one request plus one each
  // for the function and line stages; when the budget cannot pay for it the beam is cut by
  // mention order (traceback, then task text) so no later request ever spans the whole workspace.
  const paths = orderedPaths(ctx, frames);
  let fileBeam: FileBeamEntry[];
  if (paths.length > o.fileBeam && asker.canAsk(1, 2)) {
    fileBeam = await stageFiles(ctx, o, asker, paths);
  } else {
    const kept = paths.slice(0, o.fileBeam);
    fileBeam = kept.map((p) => ({ file: ctx.files.get(p)!, probability: 1 / kept.length }));
  }

  // Stage 2: confirm with outlines, one request. A beam of one has nothing to re-rank.
  if (fileBeam.length > 1 && asker.canAsk(1, 2)) fileBeam = await stageConfirm(ctx, o, asker, fileBeam);

  // Stage 3: functions, one Choice per beam file; when not even one Choice is affordable, the
  // traceback and SBFL name the functions in code so the last request can still go to lines.
  let fnBeam = await stageFunctions(ctx, o, asker, fileBeam, frames, sbfl);
  if (fnBeam.length === 0 && asker.canAsk()) fnBeam = codeDerivedFunctions(fileBeam, frames, sbfl, o.functionBeam);

  // Stage 4: lines, one Choice per beam function.
  const anchors = await stageLines(ctx, o, asker, fnBeam, frames, sbfl);
  addSbflAnchors(anchors, ctx, o, sbfl);

  return {
    files: fileBeam.map((f) => (f.outline === undefined ? { path: f.file.path, probability: f.probability } : { path: f.file.path, probability: f.probability, outline: f.outline })),
    functions: fnBeam.map((f) => ({ file: f.entry.file, name: f.entry.qualname, startLine: f.entry.startLine, endLine: f.entry.endLine, probability: f.probability })),
    sites: buildSites({ anchors, sbfl, frames, window: o.window }),
    requests: asker.requests,
  };
}

async function stageFiles(ctx: LocalizeContext, o: LocalizerOptions, asker: Asker, paths: readonly string[]): Promise<FileBeamEntry[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < paths.length; i += o.fileChunkSize) chunks.push(paths.slice(i, i + o.fileChunkSize));
  // Keep three requests for confirm, functions and lines; chunks beyond the budget are not asked
  // (paths are ordered so the traceback- and task-named files sit in the first chunk).
  const asked = chunks.slice(0, Math.max(1, asker.affordable(3)));
  const probs = new Map<string, number>();
  await Promise.all(
    asked.map(async (chunk) => {
      const req = fileStage(ctx.task, ctx.failures, ctx.traceback, chunk, o.testsInState);
      const answers = await asker.ask(req.state, req.questions);
      for (const p of req.paths) probs.set(p, noulP(answers[p]));
    }),
  );
  // Ties (two-decimal probabilities make them common) break on the mention order of `paths`,
  // never on which chunk request happened to finish first.
  const ranked = byProbabilityDesc(paths.filter((p) => probs.has(p)), (p) => probs.get(p) ?? 0);
  return ranked.slice(0, o.fileBeam).map((p) => ({ file: ctx.files.get(p)!, probability: probs.get(p) ?? 0 }));
}

async function stageConfirm(ctx: LocalizeContext, o: LocalizerOptions, asker: Asker, beam: readonly FileBeamEntry[]): Promise<FileBeamEntry[]> {
  const outlines = new Map<string, string[]>();
  for (const f of beam) outlines.set(f.file.path, outline(f.file.mod));
  const req = confirmStage(ctx.task, ctx.failures, ctx.traceback, outlines, o.testsInState);
  const answers = await asker.ask(req.state, req.questions);
  const confirmed = beam.map((f) => ({ file: f.file, probability: noulP(answers[f.file.path]), outline: outlines.get(f.file.path) ?? [], prior: f.probability }));
  // Re-rank by the confirmation Noul (Q3: gold first on 31/33); the stage-1 order breaks ties.
  return byProbabilityDesc(confirmed, (f) => f.probability).map((f) => ({ file: f.file, probability: f.probability, outline: f.outline }));
}

/** Functions of a file as Choice options; when there are too many, the ones named in the evidence come first. */
function functionOptions(file: SourceFile, ctx: LocalizeContext, frames: readonly TracebackFrame[], max: number): { options: FunctionOption[]; byKey: Map<string, FunctionEntry> } {
  let entries = functionEntries(file);
  if (entries.length > max) {
    const text = `${ctx.task}\n${ctx.failures.map((f) => `${f.call} ${f.actual}`).join('\n')}`;
    const score = (e: FunctionEntry): number => (frames.some((f) => f.path === file.path && f.line >= e.startLine && f.line <= e.endLine) ? 2 : text.includes(e.qualname.split('.').pop() ?? '') ? 1 : 0);
    entries = entries
      .map((e, i) => ({ e, i }))
      .sort((x, y) => score(y.e) - score(x.e) || x.i - y.i)
      .slice(0, max)
      .map((x) => x.e)
      .sort((a, b) => a.startLine - b.startLine);
  }
  const used = new Set<string>([MODULE_LEVEL_KEY, 'none_of_these']);
  const byKey = new Map<string, FunctionEntry>();
  const options: FunctionOption[] = [];
  for (const e of entries) {
    const key = functionKey(e.qualname, used);
    byKey.set(key, e);
    const header = (file.mod.lines[e.headerLine - 1] ?? '').trim().slice(0, 160);
    options.push({ key, description: `${e.kind} ${e.qualname}, line ${e.headerLine}: ${header}` });
  }
  return { options, byKey };
}

/** Smallest option count the function Choice is cut to when the state would exceed the cap. */
const FUNCTION_OPTIONS_MIN = 8;

/** The function Choice request for one file, options halved until the estimate fits the cap. */
function functionRequest(f: FileBeamEntry, ctx: LocalizeContext, o: LocalizerOptions, frames: readonly TracebackFrame[]): { state: Json; questions: Record<string, Question>; byKey: Map<string, FunctionEntry> } {
  let max = o.maxChoiceOptions - 1;
  for (;;) {
    const { options, byKey } = functionOptions(f.file, ctx, frames, max);
    const req = functionStage(ctx.task, ctx.failures, ctx.traceback, f.file.path, options, o.testsInState);
    if (estimateRequestTokens(req.state, req.questions) <= o.stateTokenCap || max <= FUNCTION_OPTIONS_MIN) return { ...req, byKey };
    max = Math.max(FUNCTION_OPTIONS_MIN, Math.floor(max / 2));
  }
}

async function stageFunctions(ctx: LocalizeContext, o: LocalizerOptions, asker: Asker, beam: readonly FileBeamEntry[], frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>): Promise<FunctionBeamEntry[]> {
  // A file without a single def has only module-level code: no Choice to ask, the answer is code.
  const free: FunctionBeamEntry[] = [];
  const askable: FileBeamEntry[] = [];
  for (const f of beam) {
    if (functionEntries(f.file).length === 0) free.push({ entry: moduleEntry(f.file), fileProbability: f.probability, probability: 1, joint: f.probability });
    else askable.push(f);
  }
  // One request per file, keeping one for the line stage.
  const files = askable.slice(0, asker.affordable(1));
  const perFile = await Promise.all(
    files.map(async (f): Promise<FunctionBeamEntry[]> => {
      const req = functionRequest(f, ctx, o, frames);
      const answers = await asker.ask(req.state, req.questions);
      const out: FunctionBeamEntry[] = [];
      for (const [key, p] of choiceProbs(answers[FUNCTION_QUESTION_ID])) {
        const entry = key === MODULE_LEVEL_KEY ? moduleEntry(f.file) : req.byKey.get(key);
        if (entry === undefined) continue;
        out.push({ entry, fileProbability: f.probability, probability: p, joint: f.probability * p });
      }
      // §1.2 clause 3 (OOS iteration 2, question 5): an all-escape Choice leaves `choiceProbs`
      // EMPTY — the escape is a named fallback trigger, so the answer is the code order for this
      // file, not the loss of its functions. With `--jev off` every Choice is that answer.
      return out.some((e) => e.probability > 0) ? out : escapedFunctions(f, frames, sbfl, o.functionBeam);
    }),
  );
  // Flattened in beam order (not completion order) so equal joint scores rank deterministically.
  return byProbabilityDesc([...free, ...perFile.flat()], (e) => e.joint).slice(0, o.functionBeam);
}

/**
 * Function beam without a Jev request: the defs at the traceback frames (innermost first, across
 * every beam file) and then at the SBFL lines by global rank. Used only when the budget left no
 * room for a function Choice; the file probability stands in for the function's.
 */
function codeDerivedFunctions(beam: readonly FileBeamEntry[], frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>, max: number): FunctionBeamEntry[] {
  const byPath = new Map<string, { file: FileBeamEntry; entries: FunctionEntry[] }>();
  for (const f of beam) byPath.set(f.file.path, { file: f, entries: functionEntries(f.file) });
  const out: FunctionBeamEntry[] = [];
  const seen = new Set<string>();
  const add = (path: string, line: number): void => {
    const hit = byPath.get(path);
    if (hit === undefined) return;
    const e = entryAt(hit.entries, line) ?? moduleEntry(hit.file.file);
    const k = `${path}:${e.qualname}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ entry: e, fileProbability: hit.file.probability, probability: hit.file.probability, joint: hit.file.probability });
  };
  for (const fr of [...frames].reverse()) add(fr.path, fr.line);
  for (const r of [...sbfl.values()].sort((a, b) => a.rank - b.rank)) add(r.file, r.line);
  return out.slice(0, max);
}

/**
 * The function order for a file whose Choice ESCAPED (§1.2 clause 3, OOS iteration 2 question 5):
 * its traceback- and SBFL-named defs first, and — when the evidence names none — its own defs in
 * file order. This is only reached for a file Jev was ASKED about and had no opinion on, so it
 * never guesses on a budget the caller chose not to spend (`codeDerivedFunctions` above keeps
 * that contract: with no code evidence it stays empty and the stage asks nothing).
 */
function escapedFunctions(f: FileBeamEntry, frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>, max: number): FunctionBeamEntry[] {
  const named = codeDerivedFunctions([f], frames, sbfl, max);
  if (named.length > 0) return named;
  const entries = functionEntries(f.file);
  const all = entries.length === 0 ? [moduleEntry(f.file)] : entries;
  return all.slice(0, max).map((entry) => ({ entry, fileProbability: f.probability, probability: f.probability, joint: f.probability }));
}

/**
 * The line order a Choice would have ranked, in code (OOS iteration 2, question 5): the focus
 * line (innermost traceback frame in the entry, else its best SBFL line), then the entry's other
 * traceback frames innermost first, then its SBFL lines by rank, then its own code lines top
 * down. Used when the line Choice comes back with no option carrying mass — an escape, which
 * §1.2 clause 3 names as a fallback trigger, not as "there is no line".
 */
function codeDerivedLines(entry: FunctionEntry, listing: readonly CodeLine[], focus: number | null, frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>, max: number): number[] {
  const inListing = new Set(listing.map((l) => l.line));
  const out: number[] = [];
  const add = (line: number | null): void => {
    if (line === null || !inListing.has(line) || out.includes(line)) return;
    out.push(line);
  };
  add(focus);
  for (const fr of [...frames].reverse()) if (fr.path === entry.file.path) add(fr.line);
  for (const r of [...sbfl.values()].sort((a, b) => a.rank - b.rank)) if (r.file === entry.file.path) add(r.line);
  for (const l of listing) add(l.line);
  return out.slice(0, Math.max(0, max));
}

/** The most suspicious line of `entry` known before asking: innermost traceback frame, else the best SBFL line. */
function focusFor(file: SourceFile, range: { startLine: number; endLine: number }, frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>): number | null {
  const inRange = (l: number): boolean => l >= range.startLine && l <= range.endLine;
  const frame = [...frames].reverse().find((f) => f.path === file.path && inRange(f.line));
  if (frame !== undefined) return frame.line;
  let best: RankedLine | undefined;
  for (const r of sbfl.values()) if (r.file === file.path && inRange(r.line) && (best === undefined || r.rank < best.rank)) best = r;
  return best?.line ?? null;
}

/** Lines of one function (or module-level code), cut to the option cap around the most suspicious line. */
function listingFor(entry: FunctionEntry, focus: number | null, max: number): CodeLine[] {
  const lines = entry.kind === 'module' ? moduleCodeLines(entry.file.mod) : codeLines(entry.file.mod, entry.startLine, entry.endLine);
  return centredWindow(lines, max, focus);
}

type LineRequest = ReturnType<typeof lineStage>;

/**
 * Shrink levels for the cap: 0 full, 1 no traceback, 2 one test, then halve the listing around
 * its focus (the traceback or SBFL line, so the suspicious region is what survives).
 */
function buildLineRequest(base: Omit<LineStageInput, 'lines'>, listing: readonly CodeLine[], focus: number | null): (level: number) => LineRequest | null {
  return (level) => {
    let lines: CodeLine[] = [...listing];
    for (let k = 3; k <= level; k++) lines = centredWindow(lines, Math.floor(lines.length / 2), focus);
    if (lines.length < 4 && level >= 3) return null;
    return lineStage({ ...base, lines }, Math.min(level, 2));
  };
}

async function askLines(ctx: LocalizeContext, o: LocalizerOptions, asker: Asker, file: SourceFile, listing: readonly CodeLine[], focus: number | null, where: { file: string; function: string } | undefined): Promise<Map<number, number>> {
  const base: Omit<LineStageInput, 'lines'> = where === undefined ? { task: ctx.task, failures: ctx.failures, traceback: ctx.traceback, maxTests: o.testsInState } : { task: ctx.task, failures: ctx.failures, traceback: ctx.traceback, where, maxTests: o.testsInState };
  // Measured as the wire measures: the Choice's options repeat the listing, so state alone would under-count by half.
  const { request } = fitRequestToCap(o.stateTokenCap, buildLineRequest(base, listing, focus));
  const answers = await asker.ask(request.state, request.questions);
  const out = new Map<number, number>();
  for (const [k, p] of choiceProbs(answers[LINE_QUESTION_ID])) {
    const line = lineOfKey(k);
    if (line !== null && file.mod.lines[line - 1] !== undefined) out.set(line, p);
  }
  return out;
}

async function stageLines(ctx: LocalizeContext, o: LocalizerOptions, asker: Asker, beam: readonly FunctionBeamEntry[], frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>): Promise<Anchor[]> {
  const asked = beam.slice(0, asker.affordable(0));
  const perFunction = await Promise.all(
    asked.map(async (f): Promise<{ anchor: Anchor; score: number }[]> => {
      const focus = focusFor(f.entry.file, f.entry, frames, sbfl);
      const listing = listingFor(f.entry, focus, o.maxChoiceOptions);
      if (listing.length === 0) return [];
      const probs = await askLines(ctx, o, asker, f.entry.file, listing, focus, { file: f.entry.file.path, function: f.entry.qualname });
      const top = byProbabilityDesc([...probs.keys()], (l) => probs.get(l) ?? 0).slice(0, o.anchorsPerFunction);
      const out: { anchor: Anchor; score: number }[] = [];
      top.forEach((line, i) => {
        const p = probs.get(line) ?? 0;
        if (p <= 0) return;
        out.push({
          anchor: { file: f.entry.file, line, entry: f.entry.kind === 'module' ? null : f.entry, jevProbability: p, lineProbabilities: probs, notes: [`jev anchor #${i + 1} in ${f.entry.qualname}`] },
          score: f.joint * p,
        });
      });
      if (out.length > 0) return out;
      // §1.2 clause 3: no option carried mass (an escape, or a Jev with no opinion) — the code
      // order stands in, with no `jevProbability`: these anchors carry no Jev evidence and say so.
      // OOS iteration 3, item 4: and it stands in with `escapedAnchors`, not the Jev beam's 3 —
      // the code order is not a ranking, so cutting it at a ranking's width leaves the defect out
      // of the site list whenever it is not in the first three lines of its function.
      return codeDerivedLines(f.entry, listing, focus, frames, sbfl, o.escapedAnchors).map((line, i) => ({
        anchor: { file: f.entry.file, line, entry: f.entry.kind === 'module' ? null : f.entry, lineProbabilities: new Map<number, number>(), notes: [`code anchor #${i + 1} in ${f.entry.qualname} (no Jev opinion: the line Choice escaped)`] },
        score: f.joint / (i + 1),
      }));
    }),
  );
  // Flattened in beam order so equal scores rank deterministically regardless of completion order.
  return byProbabilityDesc(perFunction.flat(), (s) => s.score).map((s) => s.anchor);
}

/** Union with SBFL: its top-k lines become anchors too (measured: union of two top-3 lists covered 38/40). */
function addSbflAnchors(anchors: Anchor[], ctx: LocalizeContext, o: LocalizerOptions, sbfl: ReadonlyMap<string, RankedLine>): void {
  const top = [...sbfl.values()].sort((a, b) => a.rank - b.rank).slice(0, o.sbflAnchors);
  for (const r of top) {
    const existing = anchors.find((a) => a.file.path === r.file && a.line === r.line);
    if (existing !== undefined) {
      existing.notes.push(`sbfl rank ${r.rank}`);
      continue;
    }
    const file = ctx.files.get(r.file);
    if (file === undefined || file.mod.lines[r.line - 1] === undefined) continue;
    const entry = entryAt(functionEntries(file), r.line) ?? null;
    // When a Jev line Choice already covered this line, keep its probability as evidence.
    const covered = anchors.find((a) => a.file.path === r.file && a.lineProbabilities.has(r.line));
    const p = covered?.lineProbabilities.get(r.line);
    const anchor: Anchor = { file, line: r.line, entry, lineProbabilities: covered?.lineProbabilities ?? new Map(), notes: [`sbfl rank ${r.rank}`] };
    if (p !== undefined) anchor.jevProbability = p;
    anchors.push(anchor);
  }
}

// ---------------------------------------------------------------------------------------
// One-file workspaces: a single flat Choice over every code line (probe-localization §8.6)
// ---------------------------------------------------------------------------------------

async function singleFileFlat(ctx: LocalizeContext, o: LocalizerOptions, asker: Asker, file: SourceFile, frames: readonly TracebackFrame[], sbfl: ReadonlyMap<string, RankedLine>): Promise<LocalizeResult> {
  const files: FileCandidate[] = [{ path: file.path, probability: 1, outline: outline(file.mod) }];
  const entries = functionEntries(file);
  if (!asker.canAsk()) return { files, functions: [], sites: [], requests: 0 };
  const listing = codeLines(file.mod, 1, file.mod.lines.length);
  const focus = focusFor(file, { startLine: 1, endLine: file.mod.lines.length }, frames, sbfl);
  let probs = await askLines(ctx, o, asker, file, listing, focus, undefined);
  // §1.2 clause 3 (OOS iteration 2, question 5): an all-escape Choice answers an empty map, which
  // used to leave this workspace with no anchor, no function and no site — the Ring-1 `gcd` /
  // `mergesort` losses. The code order stands in; the probabilities are code-derived ranks, so
  // the mass ordering below still works and nothing claims a Jev opinion it does not have.
  // OOS iteration 3, item 4: `escapedAnchors` lines, not the Jev beam's 3 — see LocalizerOptions.
  const escaped = [...probs.values()].every((p) => p <= 0);
  if (escaped) {
    const derived = codeDerivedLines(moduleEntry(file), listing, focus, frames, sbfl, o.escapedAnchors);
    probs = new Map(derived.map((line, i) => [line, 1 / (i + 1)]));
  }

  // Functions are derived in code by summing the line mass inside each def (no extra request).
  const mass = new Map<FunctionEntry | null, number>();
  for (const [line, p] of probs) {
    const e = entryAt(entries, line) ?? null;
    mass.set(e, (mass.get(e) ?? 0) + p);
  }
  const functions: FunctionCandidate[] = byProbabilityDesc([...mass.entries()], ([, p]) => p)
    .filter(([, p]) => p > 0)
    .slice(0, o.functionBeam)
    .map(([e, p]) => {
      const entry = e ?? moduleEntry(file);
      return { file, name: entry.qualname, startLine: entry.startLine, endLine: entry.endLine, probability: Math.min(1, p) };
    });

  const top = byProbabilityDesc([...probs.keys()], (l) => probs.get(l) ?? 0).slice(0, escaped ? o.escapedAnchors : o.anchorsPerFunction);
  const anchors: Anchor[] = [];
  top.forEach((line, i) => {
    const p = probs.get(line) ?? 0;
    if (p <= 0) return;
    const entry = entryAt(entries, line) ?? null;
    const anchor: Anchor = escaped
      ? { file, line, entry, lineProbabilities: new Map<number, number>(), notes: [`code anchor #${i + 1} (no Jev opinion: the line Choice escaped)`] }
      : { file, line, entry, jevProbability: p, lineProbabilities: probs, notes: [`jev anchor #${i + 1}`] };
    anchors.push(anchor);
  });
  addSbflAnchors(anchors, ctx, o, sbfl);
  return { files, functions, sites: buildSites({ anchors, sbfl, frames, window: o.window }), requests: asker.requests };
}
