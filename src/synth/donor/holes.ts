/**
 * Identifier hole filling by Jev (experiments/results/probe-donor-and-templates.md §2): the
 * donor line with one identifier written as `__HOLE__`, the buggy line visible in `program`,
 * one Choice over the in-scope identifiers (+ the builder's `none_of_these`). Measured: the
 * identifier that actually changes is top-1 13/13 with the buggy line visible; one template per
 * request (a shared state leaks sibling holes, §2 "Leak"); sequential filling beats parallel
 * 35/40 vs 32/40 (probe-token-synthesis §T5). Wordings below are the measured ones.
 *
 * `fillHolesSequentially` runs a width-2 beam over the holes and returns the top fillings for
 * the verification beam; same-family pairs (`i`/`j`, `a`/`b`) come back in both orders because
 * that is the one judgement Jev keeps missing (§2 finding ii).
 */
import type { Answer, Decision, Json, Question } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import { ESCAPE_KEY, choice } from '../../jev/questions.js';
import type { LineScope } from '../py/structure.js';
import type { FailureView, RankContext, Site } from '../types.js';
import { swapFamilyPairs } from './adapt.js';
import { ATTRIBUTE_FAMILIES, distinctNames, familySiblings, isInScope, nameOccurrences, uniq } from './names.js';

export const HOLE_MARKER = '__HOLE__';
/** The 22 builtins offered alongside the program's identifiers in the measured probe. */
export const COMMON_BUILTINS: readonly string[] = ['len', 'max', 'min', 'all', 'any', 'range', 'enumerate', 'abs', 'sum', 'sorted', 'list', 'set', 'dict', 'str', 'int', 'float', 'zip', 'reversed', 'tuple', 'True', 'False', 'None'];
/** Lines of the enclosing function shown in `program` (centered on the site when longer). */
export const MAX_PROGRAM_LINES = 80;
/** Holes asked about per donor line; beyond it only must-change holes are filled. */
export const MAX_HOLES = 6;
/** Identifiers offered per hole: a Choice takes at most 255 options and the builder adds the escape. */
export const MAX_HOLE_OPTIONS = 254;

export interface IdentifierHole {
  /** question / template id: `hole_<n>` (single-letter keys carry a name prior, REPORT §10) */
  key: string;
  name: string;
  kind: 'identifier' | 'attribute';
  /** every span of `name` in the donor line; all are written as the hole together */
  spans: readonly { start: number; end: number }[];
  /** option key → identifier text */
  options: Record<string, string>;
  /** the donor name does not resolve at the site: it has to change */
  mustChange: boolean;
}

/** `ident_<name>` / `attr_<name>` option keys: snake_case ascii, unique, never a bare letter. */
export function optionKey(prefix: string, name: string, used: Set<string>): string {
  let base = `${prefix}_${name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(base)) base = `${prefix}_name`;
  let key = base.slice(0, 60);
  for (let n = 2; used.has(key); n++) key = `${base.slice(0, 56)}_${n}`;
  used.add(key);
  return key;
}

export interface HoleOptions {
  /** offer attribute holes with family siblings (default true) */
  attributeFamilies?: boolean;
  /** extra identifiers to offer (e.g. from the task text) — only those that resolve at the site are kept */
  extraIdentifiers?: readonly string[];
  /** attribute names seen in the site's file, offered for attribute holes */
  fileAttributes?: readonly string[];
}

/**
 * In-scope identifiers offered for an identifier hole: params, locals, module names, imports,
 * then the common builtins (the measured order, §2). A module with hundreds of top-level names
 * would overflow the 255-option Choice, so past MAX_HOLE_OPTIONS the function-level names, the
 * extras and the builtins are kept whole and the module-level tail (imports first, then module
 * names, which QuixBugs fixes never needed) is cut.
 */
export function holeIdentifierOptions(scope: LineScope, extra: readonly string[] = []): string[] {
  const near = uniq([...scope.params, ...scope.locals]);
  const far = uniq([...scope.module, ...scope.imports]).filter((n) => !near.includes(n));
  const extras = uniq(extra.filter((n) => isInScope(n, scope)));
  const builtins = COMMON_BUILTINS.filter((b) => scope.builtins.includes(b));
  const all = uniq([...near, ...far, ...extras, ...builtins]);
  if (all.length <= MAX_HOLE_OPTIONS) return all;
  const kept = uniq([...near, ...extras, ...builtins]);
  const room = Math.max(0, MAX_HOLE_OPTIONS - kept.length);
  const tail = uniq([...scope.imports, ...scope.module]).filter((n) => !kept.includes(n)).slice(0, room);
  return uniq([...near, ...tail, ...extras, ...builtins]).slice(0, MAX_HOLE_OPTIONS);
}

/**
 * One hole per distinct identifier of the donor line (and per attribute with a family sibling).
 * Options are the site's in-scope identifiers; the donor's own name is an option only when it
 * resolves at the site.
 */
export function identifierHoles(donorText: string, scope: LineScope, opts: HoleOptions = {}): IdentifierHole[] {
  const occ = nameOccurrences(donorText);
  const identOptions = holeIdentifierOptions(scope, opts.extraIdentifiers ?? []);
  const holes: IdentifierHole[] = [];
  let n = 0;
  for (const name of distinctNames(occ, 'identifier')) {
    const used = new Set<string>();
    const options: Record<string, string> = {};
    for (const id of identOptions) options[optionKey('ident', id, used)] = id;
    if (Object.keys(options).length === 0) continue;
    holes.push({ key: `hole_${++n}`, name, kind: 'identifier', spans: occ.filter((o) => o.kind === 'identifier' && o.name === name).map(({ start, end }) => ({ start, end })), options, mustChange: !isInScope(name, scope) });
  }
  if (opts.attributeFamilies !== false) {
    for (const name of distinctNames(occ, 'attribute')) {
      const siblings = uniq([name, ...familySiblings(name, ATTRIBUTE_FAMILIES), ...(opts.fileAttributes ?? [])]).slice(0, MAX_HOLE_OPTIONS);
      if (siblings.length < 2) continue;
      const used = new Set<string>();
      const options: Record<string, string> = {};
      for (const a of siblings) options[optionKey('attr', a, used)] = a;
      holes.push({ key: `hole_${++n}`, name, kind: 'attribute', spans: occ.filter((o) => o.kind === 'attribute' && o.name === name).map(({ start, end }) => ({ start, end })), options, mustChange: false });
    }
  }
  return holes;
}

/** The donor line with `filled` names substituted and `hole` written as the marker (other holes keep the donor's names). */
export function holeTemplate(donorText: string, holes: readonly IdentifierHole[], hole: IdentifierHole | null, filled: Readonly<Record<string, string>>): string {
  const edits: { start: number; end: number; to: string }[] = [];
  for (const h of holes) {
    const to = h === hole ? HOLE_MARKER : filled[h.key];
    if (to === undefined || (h !== hole && to === h.name)) continue;
    for (const s of h.spans) edits.push({ ...s, to });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = donorText;
  for (const e of edits) out = out.slice(0, e.start) + e.to + out.slice(e.end);
  return out;
}

/** What the questions need to know about the site and the run; a RankContext plus the site. */
export interface HoleContext extends RankContext {
  site: Site;
  /** where the donor line came from, for the state (`src/units.py` line 15, `parse_size`) */
  donor?: { path: string; line: number; block: string | null };
}

function programListing(site: Site): { program: Record<string, string>; ref: string } {
  const lines = site.file.mod.lines;
  let start: number;
  let end: number;
  if (site.block !== null) {
    start = site.block.startLine;
    end = site.block.endLine;
  } else {
    start = Math.max(1, site.line - 15);
    end = Math.min(lines.length, site.line + 15);
  }
  if (end - start + 1 > MAX_PROGRAM_LINES) {
    start = Math.max(start, site.line - Math.floor(MAX_PROGRAM_LINES / 2));
    end = Math.min(end, start + MAX_PROGRAM_LINES - 1);
  }
  const program: Record<string, string> = {};
  for (let l = start; l <= end; l++) {
    const text = lines[l - 1] ?? '';
    if (site.kind === 'insert' && l === site.line) program[`L${l}`] = `<<< MISSING LINE >>>\n${text}`;
    else program[`L${l}`] = text;
  }
  // an insert past the last listed line still needs a marker to point at
  if (site.kind === 'insert' && (site.line < start || site.line > end)) program[`L${site.line}`] = '<<< MISSING LINE >>>';
  return { program, ref: `L${site.line}` };
}

function failureViews(failures: readonly FailureView[]): Json[] {
  return failures.map((f) => ({ test: f.testId, call: f.call, expected: f.expected, actual: f.actual }));
}

/** The measured state shape (§2): task, program, faulty_line / insert_before, tests, replacement_templates. */
export function holeState(ctx: HoleContext, templates: Readonly<Record<string, string>>): Json {
  const fn = ctx.site.block?.name ?? ctx.site.file.path;
  const { program, ref } = programListing(ctx.site);
  const where = ctx.site.kind === 'replace' ? `has a single-line bug at \`program.${ref}\`` : `is missing one statement, which belongs directly before \`program.${ref}\` (the \`<<< MISSING LINE >>>\` marker)`;
  const what = ctx.site.kind === 'replace' ? 'the proposed replacement for that line' : 'the proposed missing statement';
  const state: Record<string, Json> = {
    task: `The function \`${fn}\` ${where}. Each entry of \`replacement_templates\` is ${what} with one identifier removed and written as \`${HOLE_MARKER}\`. The filled line must make every case in \`tests\` pass.`,
    task_description: ctx.task,
    program,
    tests: failureViews(ctx.failures),
    replacement_templates: { ...templates },
  };
  state[ctx.site.kind === 'replace' ? 'faulty_line' : 'insert_before'] = ref;
  if (ctx.donor !== undefined) {
    state['template_origin'] = `copied from \`${ctx.donor.path}\` line ${ctx.donor.line}${ctx.donor.block === null ? '' : ` (function \`${ctx.donor.block}\`)`}; identifiers copied from there may need to change to names in scope at \`program.${ref}\``;
  }
  return state;
}

/** The measured question (§2), one Choice per hole; attribute holes ask for an attribute name. */
export function holeQuestion(hole: IdentifierHole, site: Site): Question {
  const ref = `L${site.line}`;
  const target = site.kind === 'replace' ? `the completed line at \`program.${ref}\`` : `the completed statement inserted before \`program.${ref}\``;
  const what = hole.kind === 'identifier' ? 'identifier, in scope in `program`,' : 'attribute name';
  return choice(`Which ${what} fills \`${HOLE_MARKER}\` in \`replacement_templates.${hole.key}\` so that ${target} makes all \`tests\` pass?`, { ...hole.options });
}

export interface HoleQuestionSet {
  state: Json;
  questions: Record<string, Question>;
  templates: Record<string, string>;
}

/**
 * One request's worth of hole questions: every hole in `holes` as an independent Choice over
 * one shared state. Pass a single hole for the leak-free sequential form (`fillHolesSequentially`
 * does); passing all holes at once is the parallel form (measured 32/40 vs 35/40 sequential),
 * useful only when a request budget forbids the round trips.
 */
export function holeQuestions(donorLine: string, holes: readonly IdentifierHole[], scope: LineScope, ctx: HoleContext, filled: Readonly<Record<string, string>> = {}): HoleQuestionSet {
  const all = holes.length > 0 ? holes : identifierHoles(donorLine, scope);
  const asked = all.filter((h) => filled[h.key] === undefined);
  const templates: Record<string, string> = {};
  const questions: Record<string, Question> = {};
  for (const h of asked) {
    templates[h.key] = holeTemplate(donorLine, all, h, filled);
    questions[h.key] = holeQuestion(h, ctx.site);
  }
  return { state: holeState(ctx, templates), questions, templates };
}

export interface HoleFilling {
  text: string;
  /** hole key → chosen identifier */
  assignments: Record<string, string>;
  /** Σ log p over the asked holes (ordering only) */
  logProb: number;
  /** smallest P(chosen) among the asked holes */
  minProbability: number;
  /** largest P(none_of_these) seen along this path: a hint that no in-scope name fits */
  maxEscapeProbability: number;
  /** produced by swapping a same-family pair of another filling, not asked */
  swapped: boolean;
}

export interface FillResult {
  fillings: HoleFilling[];
  requests: number;
  rows: Decision[];
}

export interface FillOptions {
  /** beam width and number of fillings returned (default 2) */
  width?: number;
  /** add both orders of same-family pairs (default true) */
  familySwaps?: boolean;
  /** holes asked about (default MAX_HOLES); must-change holes always come first */
  maxHoles?: number;
}

function rankedOptions(answer: Answer, hole: IdentifierHole): { key: string; name: string; p: number }[] {
  if (answer.type !== 'choice') return [];
  return Object.entries(hole.options)
    .map(([key, name]) => ({ key, name, p: answer.probabilities[key] ?? 0 }))
    .sort((a, b) => b.p - a.p || (a.key < b.key ? -1 : 1));
}

interface Partial {
  assignments: Record<string, string>;
  logProb: number;
  minProbability: number;
  maxEscapeProbability: number;
}

/**
 * Fill the holes left to right, one Choice per request, keeping the `width` best partial
 * fillings (product of probabilities). Holes whose donor name already resolves at the site are
 * still asked (the probe's "unchanged" rows: 103/107 with the buggy line visible) unless the
 * hole budget forces us to keep only must-change ones. Escape mass is recorded, never acted on:
 * the tests decide.
 */
export async function fillHolesSequentially(donorLine: string, holes: readonly IdentifierHole[], scope: LineScope, ctx: HoleContext, opts: FillOptions = {}): Promise<FillResult> {
  const width = Math.max(1, opts.width ?? 2);
  const maxHoles = opts.maxHoles ?? MAX_HOLES;
  const all = holes.length > 0 ? holes : identifierHoles(donorLine, scope);
  const must = all.filter((h) => h.mustChange);
  const optional = all.filter((h) => !h.mustChange);
  const asked = [...must, ...optional].slice(0, Math.max(maxHoles, must.length));
  // ask in donor-line order so earlier (left) slots are filled when later ones are asked
  asked.sort((a, b) => (a.spans[0]?.start ?? 0) - (b.spans[0]?.start ?? 0));

  let beam: Partial[] = [{ assignments: {}, logProb: 0, minProbability: 1, maxEscapeProbability: 0 }];
  let requests = 0;
  const rows: Decision[] = [];
  for (const hole of asked) {
    const next: Partial[] = [];
    for (const partial of beam) {
      // the project's AbortError, so the search loop sees a cancellation, not a failed source
      if (ctx.signal.aborted) throw new AbortError('signal');
      // one template per request: sibling templates in a shared state reconstruct the whole
      // line and leak the answer (probe-donor §2 "Leak"); holes not asked keep the donor name
      const template = holeTemplate(donorLine, all, hole, partial.assignments);
      const state = holeState(ctx, { [hole.key]: template });
      const r = await ctx.ask('propose', state, { [hole.key]: holeQuestion(hole, ctx.site) });
      requests++;
      rows.push(...r.rows);
      const answer = r.answers[hole.key];
      if (answer === undefined || answer.type !== 'choice') {
        next.push({ ...partial, assignments: { ...partial.assignments, [hole.key]: hole.name } });
        continue;
      }
      const escape = answer.probabilities[ESCAPE_KEY] ?? 0;
      const top = rankedOptions(answer, hole).slice(0, width);
      if (top.length === 0) {
        next.push({ ...partial, assignments: { ...partial.assignments, [hole.key]: hole.name }, maxEscapeProbability: Math.max(partial.maxEscapeProbability, escape) });
        continue;
      }
      for (const o of top) {
        next.push({
          assignments: { ...partial.assignments, [hole.key]: o.name },
          logProb: partial.logProb + Math.log(Math.max(o.p, 1e-6)),
          minProbability: Math.min(partial.minProbability, o.p),
          maxEscapeProbability: Math.max(partial.maxEscapeProbability, escape),
        });
      }
    }
    next.sort((a, b) => b.logProb - a.logProb || JSON.stringify(a.assignments).localeCompare(JSON.stringify(b.assignments)));
    beam = next.slice(0, width);
  }

  const fillings: HoleFilling[] = [];
  const seen = new Set<string>();
  for (const p of beam) {
    const text = holeTemplate(donorLine, all, null, p.assignments);
    if (seen.has(text)) continue;
    seen.add(text);
    fillings.push({ text, assignments: p.assignments, logProb: p.logProb, minProbability: p.minProbability, maxEscapeProbability: p.maxEscapeProbability, swapped: false });
  }
  if (opts.familySwaps !== false) {
    for (const f of [...fillings]) {
      for (const s of swapFamilyPairs(f.text, scope)) {
        if (seen.has(s.text)) continue;
        seen.add(s.text);
        fillings.push({ ...f, text: s.text, swapped: true });
      }
    }
  }
  return { fillings, requests, rows };
}
