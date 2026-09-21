/**
 * The wiring of the harvested facts into the real sources (src/synth/index.ts): the run facts
 * registered by the controller reach the template and donor seeds as enriched EnumerateOptions
 * (`introspected`, `history`, `extraNames`), the verification queue's vocabulary accepts the
 * names the introspection-fed productions write, the history reversals ride first with the donor
 * seed and carry their provenance, and nothing changes for a run without facts.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryFacts } from '../../../src/synth/history/index.js';
import { createQueue, createSubGoalDeps, enrichEnumerateOptions } from '../../../src/synth/index.js';
import { clearRunFacts, emptyIntrospection, setRunFacts } from '../../../src/synth/introspect/index.js';
import type { IntrospectedNames } from '../../../src/synth/introspect/index.js';
import { analyse, blockAt, scopeAt } from '../../../src/synth/py/structure.js';
import { enumerateOptions } from '../../../src/synth/search/subgoal.js';
import type { Base, VerifyJob } from '../../../src/synth/search/types.js';
import type { Candidate, Site, SourceFile } from '../../../src/synth/types.js';
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
    const withFacts = deps.seeds.template.enumerate(gap, enumerateOptions(base, goal, ctx.task));
    const aliases = withFacts.filter((c) => c.op === 'mro_method_alias');
    expect(aliases.map((c) => c.text.trim())).toEqual(['_print_Baz = _print_Bar', '_print_Qux = _print_Bar', '_print_Baz = _print_Foo', '_print_Qux = _print_Foo']);
    expect(queue.addAll(aliases.map((c) => jobOn(c, base))).queued).toHaveLength(4);
    // without: the production is inert and `_print_Baz` is nowhere in the vocabulary
    clearRunFacts(ctx.runId);
    const bare = createQueue(ctx, mem, goal);
    const without = deps.seeds.template.enumerate(gap, enumerateOptions(base, goal, ctx.task));
    expect(without.some((c) => c.op === 'mro_method_alias')).toBe(false);
    expect(bare.addAll(aliases.map((c) => jobOn(c, base))).queued).toHaveLength(0);
  });

  it('donor: the history reversals come first with their provenance, then the donors, within opts.cap; a run without history facts sees the plain donors', () => {
    const ctx = fakeCtx({ runId: 'wiring-history' });
    const mem = fakeMemory([hashed, printer], baseline);
    const goal = fakeGoal({ suspectedFiles: ['m.py'] });
    const base = mem.bases[0]!;
    const site = siteAt(hashed, 2);
    const deps = createSubGoalDeps();
    setRunFacts(ctx.runId, { introspected: null, history });
    createQueue(ctx, mem, goal);
    const cands = deps.seeds.donor.enumerate(site, enumerateOptions(base, goal, ctx.task));
    expect(cands.length).toBeGreaterThan(0);
    const first = cands[0]!;
    expect(first.source).toBe('history');
    expect(first.op).toBe('history_revert_change');
    expect(first.text).toBe('    return hash(self.a)');
    expect(first.extraEdits).toEqual([3, 4, 5].map((line) => ({ path: 'm.py', line, kind: 'delete' })));
    expect(first.provenance).toBe('reverse of a1b2c3d4e5 "Fixed #31750 -- hash the model too" (ticket:#31750)');
    expect(cands.slice(1).every((c) => c.source === 'donor')).toBe(true);
    // the cap bounds the union
    expect(deps.seeds.donor.enumerate(site, { ...enumerateOptions(base, goal, ctx.task), cap: 1 })).toHaveLength(1);
    // no facts: no reversal, the plain donor set
    clearRunFacts(ctx.runId);
    createQueue(ctx, mem, goal);
    const plain = deps.seeds.donor.enumerate(site, enumerateOptions(base, goal, ctx.task));
    expect(plain.every((c) => c.source === 'donor')).toBe(true);
    expect(plain.map((c) => c.id)).toEqual(cands.slice(1).map((c) => c.id));
  });
});
