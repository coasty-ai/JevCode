/**
 * The wiring of the harvested facts into the real sources (src/synth/index.ts): the run facts
 * registered by the controller reach the template and donor seeds as enriched EnumerateOptions
 * (`introspected`, `history`, `extraNames`), the verification queue's vocabulary accepts the
 * names the introspection-fed productions write, the history reversals AT the site ride with the
 * donor seed after the donors' top half (share-capped, `seedWithHistory`) and carry their
 * provenance, a reversal located at another site never reaches the seed nor the ranker (the
 * rung-3 defect of jev-only-rungs-1-2.md §21.5), and nothing changes for a run without facts.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryFacts } from '../../../src/synth/history/index.js';
import { HISTORY_SEED_MAX, createQueue, createSubGoalDeps, enrichEnumerateOptions, historySeedCap, seedWithHistory } from '../../../src/synth/index.js';
import { sameSpan } from '../../../src/synth/history/index.js';
import { replaceSiteAt } from '../../../src/synth/search/sites.js';
import { clearRunFacts, emptyIntrospection, setRunFacts } from '../../../src/synth/introspect/index.js';
import type { IntrospectedNames } from '../../../src/synth/introspect/index.js';
import { analyse, blockAt, scopeAt } from '../../../src/synth/py/structure.js';
import { enumerateOptions } from '../../../src/synth/search/subgoal.js';
import type { Base, VerifyJob } from '../../../src/synth/search/types.js';
import type { Candidate, CandidateSource, Site, SourceFile } from '../../../src/synth/types.js';
import { COMPILER_PATH, HISTORY_LINE, RANKED_LINE, compilerFixture } from './history/fixtures.js';
import { scriptedAnswers } from './rank/helpers.js';
import { fakeCtx, fakeGoal, fakeMemory, summary } from './search/controller-fakes.js';

function sf(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

function siteAt(file: SourceFile, line: number, kind: 'replace' | 'insert' = 'replace', indent?: string): Site {
  const b = blockAt(file.mod, kind === 'insert' ? Math.max(1, line - 1) : line);
  const current = kind === 'replace' ? (file.mod.lines[line - 1] ?? '') : '';
  return { file, line, kind, currentLine: current, indent: indent ?? (/^[ \t]*/.exec(current)?.[0] ?? ''), block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine }, scope: scopeAt(file.mod, kind === 'insert' ? Math.max(1, line - 1) : line), evidence: { notes: ['test'] } };
}

const PRINTER = ['class Printer(Base):', '    def _print_Foo(self, e):', '        return "foo"', '', '    def _print_Bar(self, e):', '        return "bar"', '', 'def free():', '    return 2', ''].join('\n');
const HASHED = ['def f(self):', '    return hash((', '        self.a,', '        self.b,', '    ))', ''].join('\n');

const introspected: IntrospectedNames = { ...emptyIntrospection('ran', 'test'), classes: ['Baz', 'Qux'], predicates: ['is_real'], operands: [{ expr: 'expr', typeName: 'Baz', classes: ['Baz', 'Qux'], predicates: ['is_real'], falsyPredicates: ['is_real'], attributes: [], frame: null, raisingReceiver: true }] };
const history: HistoryFacts = {
  files: ['m.py'],
  commands: 2,
  durationMs: 5,
  note: '1 commit, 1 change run in 1 file',
  commits: [{ sha: 'a1b2c3d4e5'.repeat(4), subject: 'Fixed #31750 -- hash the model too', time: 3, reason: 'ticket:#31750', hunks: [{ file: 'm.py', oldStart: 2, oldLines: ['    return hash(self.a)'], newStart: 2, newLines: ['    return hash((', '        self.a,', '        self.b,', '    ))'], before: ['def f(self):'], after: [] }] }],
};

function jobOn(c: Candidate, base: Base): VerifyJob {
  return { candidate: c, base, p: 0.5, sourcePrior: 0.9, key: [base.summary.passed, 0.5, 0.9] };
}

describe('enrichEnumerateOptions', () => {
  const printer = sf('p.py', PRINTER);
  const plain = enumerateOptions({ id: 'committed', origin: 'committed', fromGoal: null, files: new Map([[printer.path, printer]]), summary: summary({}), depth: 0 }, fakeGoal(), 'task');

  it('adds the introspection, the history and the per-file vocabulary additions (flat names ∪ the dispatch-prefix aliases); untouched without facts', () => {
    expect(enrichEnumerateOptions(siteAt(printer, 3), plain, null)).toBe(plain);
    const both = enrichEnumerateOptions(siteAt(printer, 3), plain, { introspected, history });
    expect(both.introspected).toBe(introspected);
    expect(both.history).toBe(history);
    expect(both.extraNames).toEqual(['Baz', 'Qux', 'is_real', '_print_Baz', '_print_Qux']);
    expect(both.phase).toBe('SEEDS');
    const onlyHistory = enrichEnumerateOptions(siteAt(printer, 3), plain, { introspected: null, history });
    expect(onlyHistory.introspected).toBeUndefined();
    expect(onlyHistory.extraNames).toBeUndefined();
    expect(onlyHistory.history).toBe(history);
  });
});

describe('the wired seeds and the queue read the run facts of the run being searched', () => {
  const printer = sf('p.py', PRINTER);
  const hashed = sf('m.py', HASHED);
  const baseline = summary({ failing: ['t::a'], passing: ['t::b'] });

  it('template: the MRO alias fires at a class-body gap with the facts and its names pass the queue vocabulary; without facts the same site yields no alias and the queue drops the name', () => {
    const ctx = fakeCtx({ runId: 'wiring-alias' });
    const mem = fakeMemory([printer, hashed], baseline);
    const goal = fakeGoal({ suspectedFiles: ['p.py'] });
    const base = mem.bases[0]!;
    const gap = siteAt(printer, 7, 'insert', '    ');
    const deps = createSubGoalDeps();
    // with the facts
    setRunFacts(ctx.runId, { introspected, history: null });
    const queue = createQueue(ctx, mem, goal);
    const withFacts = deps.seeds.template.enumerate(gap, enumerateOptions(base, goal, ctx.task, ctx.runId));
    const aliases = withFacts.filter((c) => c.op === 'mro_method_alias');
    expect(aliases.map((c) => c.text.trim())).toEqual(['_print_Baz = _print_Bar', '_print_Qux = _print_Bar', '_print_Baz = _print_Foo', '_print_Qux = _print_Foo']);
    expect(queue.addAll(aliases.map((c) => jobOn(c, base))).queued).toHaveLength(4);
    // without: the production is inert and `_print_Baz` is nowhere in the vocabulary
    clearRunFacts(ctx.runId);
    const bare = createQueue(ctx, mem, goal);
    const without = deps.seeds.template.enumerate(gap, enumerateOptions(base, goal, ctx.task, ctx.runId));
    expect(without.some((c) => c.op === 'mro_method_alias')).toBe(false);
    expect(bare.addAll(aliases.map((c) => jobOn(c, base))).queued).toHaveLength(0);
  });

  it('two runs in one process (bench --concurrency): each wired seed reads the facts of ITS run through opts.runId, not those of the run whose queue was created last', () => {
    const a = fakeCtx({ runId: 'wiring-race-a' });
    const b = fakeCtx({ runId: 'wiring-race-b' });
    const mem = fakeMemory([printer, hashed], baseline);
    const goal = fakeGoal({ suspectedFiles: ['p.py'] });
    const base = mem.bases[0]!;
    const gap = siteAt(printer, 7, 'insert', '    ');
    const deps = createSubGoalDeps();
    setRunFacts(a.runId, { introspected, history: null }); // run A harvested Baz/Qux …
    clearRunFacts(b.runId); // … run B harvested nothing
    const optsA = enumerateOptions(base, goal, a.task, a.runId);
    const optsB = enumerateOptions(base, goal, b.task, b.runId);
    createQueue(a, mem, goal);
    createQueue(b, mem, goal); // B's search starts after A's — the process-wide cell this replaces then held B's (empty) facts
    const aliasesA = deps.seeds.template.enumerate(gap, optsA).filter((c) => c.op === 'mro_method_alias');
    expect(aliasesA).toHaveLength(4);
    expect(deps.seeds.template.enumerate(gap, optsB).some((c) => c.op === 'mro_method_alias')).toBe(false);
    // and each run's queue accepts exactly its own names
    expect(createQueue(a, mem, goal).addAll(aliasesA.map((c) => jobOn(c, base))).queued).toHaveLength(4);
    expect(createQueue(b, mem, goal).addAll(aliasesA.map((c) => jobOn(c, base))).queued).toHaveLength(0);
    clearRunFacts(a.runId);
  });

  it('donor: the history reversal AT the statement site rides after the donors\' top half with its provenance and the site object itself; a run without history facts sees exactly the plain donors', () => {
    const ctx = fakeCtx({ runId: 'wiring-history' });
    const mem = fakeMemory([hashed, printer], baseline);
    const goal = fakeGoal({ suspectedFiles: ['m.py'] });
    const base = mem.bases[0]!;
    // buildGoalSites holds the statement-level site at the first line of `return hash((...))` (L2-5)
    const site = replaceSiteAt(hashed, 2, { notes: ['test'] });
    if (site === null) throw new Error('no site');
    expect(site.endLine).toBe(5);
    const deps = createSubGoalDeps();
    // no facts: the plain donor set
    clearRunFacts(ctx.runId);
    createQueue(ctx, mem, goal);
    const plain = deps.seeds.donor.enumerate(site, enumerateOptions(base, goal, ctx.task, ctx.runId));
    expect(plain.every((c) => c.source === 'donor')).toBe(true);
    // with the facts: the same donors, the reversal spliced in after their top half
    setRunFacts(ctx.runId, { introspected: null, history });
    createQueue(ctx, mem, goal);
    const cands = deps.seeds.donor.enumerate(site, enumerateOptions(base, goal, ctx.task, ctx.runId));
    const hist = cands.filter((c) => c.source === 'history');
    expect(hist).toHaveLength(1);
    const rev = hist[0]!;
    expect(rev.op).toBe('history_revert_change');
    expect(rev.text).toBe('    return hash(self.a)');
    expect(rev.site).toBe(site);
    expect(rev.extraEdits).toBeUndefined();
    expect(rev.provenance).toBe('reverse of a1b2c3d4e5 "Fixed #31750 -- hash the model too" (ticket:#31750)');
    expect(cands.indexOf(rev)).toBe(Math.ceil(plain.length / 2));
    expect(cands.filter((c) => c.source === 'donor').map((c) => c.id)).toEqual(plain.map((c) => c.id));
    // at the one-line site L2 the reversal (span L2-5) is not at the site: donors only
    const oneLine = siteAt(hashed, 2);
    expect(deps.seeds.donor.enumerate(oneLine, enumerateOptions(base, goal, ctx.task, ctx.runId)).every((c) => c.source === 'donor')).toBe(true);
    clearRunFacts(ctx.runId);
  });

  it('seedWithHistory: history\'s share is min(16, 25 % of the cap), placed after the donors\' top half, never displacing the top half, reversals at other sites dropped; the donors alone without reversals', () => {
    const file = sf('s.py', 'def f(x):\n    return x\n');
    const site = siteAt(file, 2);
    const elsewhere = siteAt(file, 1);
    const donors: Candidate[] = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, site, text: `    return x + ${i}`, source: 'donor', op: 'donor_line' }));
    const reversals: Candidate[] = [...Array.from({ length: 3 }, (_, i) => ({ id: `h${i}`, site, text: `    return x - ${i}`, source: 'history' as const, op: 'history_revert_change' })), { id: 'foreign', site: elsewhere, text: 'def g(x):', source: 'history', op: 'history_revert_change' }];
    expect([historySeedCap(254), historySeedCap(60), historySeedCap(8), historySeedCap(1), historySeedCap(0)]).toEqual([HISTORY_SEED_MAX, 15, 2, 0, 0]);
    expect(seedWithHistory(donors, reversals, site, 254).map((c) => c.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'h0', 'h1', 'h2', 'd5', 'd6', 'd7', 'd8', 'd9']);
    // the cap cuts the tail donors, the top half stays
    expect(seedWithHistory(donors, reversals, site, 12).map((c) => c.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'h0', 'h1', 'h2', 'd5', 'd6', 'd7', 'd8']);
    // a small cap shrinks history's share before the donors'
    expect(seedWithHistory(donors, reversals, site, 8).map((c) => c.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'h0', 'h1', 'd5']);
    expect(seedWithHistory(donors, reversals, site, 1).map((c) => c.id)).toEqual(['d0']);
    // no reversal at the site: the donors, unchanged in count and order
    expect(seedWithHistory(donors, [reversals[3]!], site, 254)).toEqual(donors);
    expect(seedWithHistory(donors, [], site, 254)).toEqual(donors);
    expect(seedWithHistory([], reversals, site, 254).map((c) => c.id)).toEqual(['h0', 'h1', 'h2']);
  });

  it('rung-3 reproduction (§21.5): with a reversal located at L1679 in the run facts, the donor seed of L1686 holds no history candidate, every candidate is at the site, the ranker accepts the set; a rogue history source emitting a foreign-site candidate is filtered by the wrapper', async () => {
    const { file, facts, siteAt: at } = compilerFixture();
    const ctx = fakeCtx({ runId: 'wiring-1679', ask: (questions, state) => scriptedAnswers(state, questions) });
    const mem = fakeMemory([file], baseline);
    const goal = fakeGoal({ suspectedFiles: [COMPILER_PATH] });
    const base = mem.bases[0]!;
    const site = at(RANKED_LINE);
    setRunFacts(ctx.runId, { introspected: null, history: facts });
    const deps = createSubGoalDeps();
    createQueue(ctx, mem, goal);
    const opts = enumerateOptions(base, goal, ctx.task, ctx.runId);
    const seed = deps.seeds.donor.enumerate(site, opts);
    expect(seed.some((c) => c.source === 'history')).toBe(false);
    expect(seed.every((c) => sameSpan(c.site, site))).toBe(true);
    // the reversal is at its own site
    const own = deps.seeds.donor.enumerate(at(HISTORY_LINE), opts).filter((c) => c.source === 'history');
    expect(own.map((c) => [c.site.line, c.text.trim()])).toEqual([[HISTORY_LINE, 'combinator = getattr(self.query, "combinator", None)']]);
    // what the seeds hand the ranker ranks without the invariant firing
    const cands = [...deps.seeds.mutation.enumerate(site, opts), ...seed].slice(0, 12);
    expect(cands.length).toBeGreaterThan(0);
    const ranked = await deps.rank(ctx, mem, cands, site, goal);
    expect(ranked.ranked.every((r) => sameSpan(r.candidate.site, site))).toBe(true);
    // a source that misbehaves (the old history source did) cannot get a foreign-site candidate through the donor wrapper
    const rogue: CandidateSource = { name: 'history', enumerate: () => [{ id: 'rogue', site: at(HISTORY_LINE), text: '            combinator = None', source: 'history', op: 'history_revert_change', provenance: 'reverse of 0c763317aa' }] };
    const withRogue = createSubGoalDeps({ history: rogue }).seeds.donor.enumerate(site, opts);
    expect(withRogue.some((c) => c.id === 'rogue')).toBe(false);
    expect(withRogue.map((c) => c.id)).toEqual(seed.map((c) => c.id));
    clearRunFacts(ctx.runId);
  });
});
