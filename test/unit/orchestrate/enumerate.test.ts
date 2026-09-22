import { describe, expect, it } from 'vitest';
import { PRELUDE_SLUG, enumerateSplits, prefixTree, topLevelDirs, type EnumerateInput } from '../../../src/orchestrate/split/enumerate.js';
import { DEFAULT_SPLIT_POLICY, type DraftSplit } from '../../../src/orchestrate/types.js';

function base(over: Partial<EnumerateInput> = {}): EnumerateInput {
  return {
    plan: { remaining: [] },
    itemFiles: [],
    listing: [],
    lastTestRun: null,
    testImports: {},
    packages: [],
    asWritten: null,
    policy: { ...DEFAULT_SPLIT_POLICY },
    verifyFor: () => ['npm test'],
    ...over,
  };
}

/** A workspace in which all five enumerators apply: two packages, two top dirs, two failing tests. */
function allFive(over: Partial<EnumerateInput> = {}): EnumerateInput {
  return base({
    plan: { remaining: ['fix the app handler', 'fix the lib parser', 'tidy the docs'] },
    itemFiles: [['app/src/a.ts'], ['lib/src/b.ts'], []],
    listing: ['app/src/a.ts', 'lib/src/b.ts', 'test/a.test.ts', 'test/b.test.ts'],
    lastTestRun: { failingFiles: ['test/a.test.ts', 'test/b.test.ts'] },
    testImports: { 'test/a.test.ts': ['app/src/a.ts'], 'test/b.test.ts': ['lib/src/b.ts'] },
    packages: [
      { name: 'app', dir: 'app' },
      { name: 'lib', dir: 'lib' },
    ],
    asWritten: {
      kind: 'as_written',
      agents: [
        { slug: 'one', task: 'the app half', own: ['app/**'], verify: [] },
        { slug: 'two', task: 'the lib half', own: ['lib/**'], verify: [] },
      ],
    },
    ...over,
  });
}

describe('enumerateSplits (§3.2)', () => {
  it('returns the options in the fixed §3.5 order, with no_split always last', () => {
    const { options, rejected } = enumerateSplits(allFive());
    expect(options.map((o) => o.kind)).toEqual(['by_failing_test', 'by_layer', 'by_directory', 'by_plan_item', 'as_written', 'no_split']);
    expect(rejected).toEqual([]);
  });

  it('no_split is present even when nothing else applies', () => {
    const { options, rejected } = enumerateSplits(base());
    expect(options).toEqual([{ kind: 'no_split', agents: [] }]);
    expect(rejected).toEqual([]);
    expect(options[options.length - 1]?.kind).toBe('no_split');
  });

  it('gives every agent its items, an own set and the injected verify set', () => {
    const { options } = enumerateSplits(allFive({ verifyFor: (own) => [`npm test -- ${own.length}`] }));
    const byItem = options.find((o) => o.kind === 'by_plan_item');
    expect(byItem?.agents.map((a) => a.slug)).toEqual(['fix-the-app-handler', 'fix-the-lib-parser']);
    expect(byItem?.agents[0]?.own).toEqual(['app/src/a.ts']);
    expect(byItem?.agents[0]?.verify).toEqual(['npm test -- 1']);
    expect(byItem?.agents[0]?.task).toContain('fix the app handler');
    // every remaining index is covered exactly once, including the unassociated third item
    const covered = (byItem?.agents ?? []).flatMap((a) => a.items ?? []).sort();
    expect(covered).toEqual([0, 1, 2]);
  });

  it('a file two agents would need becomes a prelude everybody dependsOn (corner row 1)', () => {
    const input = base({
      plan: { remaining: ['widen the reader', 'widen the writer'] },
      itemFiles: [
        ['src/read.ts', 'src/types.ts'],
        ['src/write.ts', 'src/types.ts'],
      ],
      listing: ['src/read.ts', 'src/write.ts', 'src/types.ts'],
    });
    const option = enumerateSplits(input).options.find((o) => o.kind === 'by_plan_item');
    expect(option?.agents[0]?.slug).toBe(PRELUDE_SLUG);
    expect(option?.agents[0]?.own).toEqual(['src/types.ts']);
    expect(option?.agents.slice(1).map((a) => a.dependsOn)).toEqual([[PRELUDE_SLUG], [PRELUDE_SLUG]]);
    // the shared file leaves the other agents' own sets, so the specs are disjoint before rule 3 sees them
    expect(option?.agents.slice(1).map((a) => a.own)).toEqual([['src/read.ts'], ['src/write.ts']]);
  });

  it('a prelude over preludeMaxFiles deletes the option (corner row 1)', () => {
    const shared = ['src/one.ts', 'src/two.ts', 'src/three.ts'];
    const input = base({
      policy: { ...DEFAULT_SPLIT_POLICY, preludeMaxFiles: 2 },
      plan: { remaining: ['a side', 'b side'] },
      itemFiles: [
        ['src/a.ts', ...shared],
        ['src/b.ts', ...shared],
      ],
      listing: ['src/a.ts', 'src/b.ts', ...shared],
    });
    const { options, rejected } = enumerateSplits(input);
    expect(options.map((o) => o.kind)).toEqual(['no_split']);
    expect(rejected).toEqual([{ kind: 'by_plan_item', reason: 'the shared file set is 3 files (> preludeMaxFiles 2): the work is not separable', probability: null }]);
  });

  it('an unassociated plan item is merged, never dropped (corner row 3)', () => {
    const input = base({
      plan: { remaining: ['touch app', 'touch lib', 'no files at all'] },
      itemFiles: [['app/a.ts'], ['lib/b.ts'], []],
      listing: ['app/a.ts', 'lib/b.ts'],
    });
    const option = enumerateSplits(input).options.find((o) => o.kind === 'by_plan_item');
    expect(option?.agents.length).toBe(2);
    expect((option?.agents ?? []).flatMap((a) => a.items ?? []).sort()).toEqual([0, 1, 2]);
    expect(option?.agents[0]?.items).toEqual([0, 2]);
    expect(option?.agents[0]?.task).toBe('touch app; no files at all');
  });

  it('a leftover item with files joins the nearest agent by directory, widening its own', () => {
    const input = base({
      plan: { remaining: ['make a pass', 'make b pass', 'also fix the app helper'] },
      itemFiles: [['app/src/a.ts'], ['lib/src/b.ts'], ['app/other/c.ts']],
      listing: ['app/src/a.ts', 'lib/src/b.ts', 'app/other/c.ts', 'test/a.test.ts', 'test/b.test.ts'],
      lastTestRun: { failingFiles: ['test/a.test.ts', 'test/b.test.ts'] },
      testImports: { 'test/a.test.ts': ['app/src/a.ts'], 'test/b.test.ts': ['lib/src/b.ts'] },
    });
    const option = enumerateSplits(input).options.find((o) => o.kind === 'by_failing_test');
    expect(option?.agents[0]?.items).toEqual([0, 2]);
    expect(option?.agents[0]?.own).toContain('app/other/c.ts');
    expect(option?.agents[1]?.items).toEqual([1]);
  });

  it('by_failing_test owns the test file plus its single-hop imports, and nothing else', () => {
    const { options } = enumerateSplits(allFive());
    const option = options.find((o) => o.kind === 'by_failing_test');
    expect(option?.agents.map((a) => a.slug)).toEqual(['test-a-test', 'test-b-test']);
    expect(option?.agents[0]?.own).toEqual(['test/a.test.ts', 'app/src/a.ts']);
    expect(option?.agents[1]?.own).toEqual(['test/b.test.ts', 'lib/src/b.ts']);
  });

  it('by_failing_test needs two failing files; by_layer needs two packages', () => {
    const oneTest = enumerateSplits(allFive({ lastTestRun: { failingFiles: ['test/a.test.ts'] } }));
    expect(oneTest.options.map((o) => o.kind)).not.toContain('by_failing_test');
    expect(oneTest.rejected).toEqual([]);
    const onePackage = enumerateSplits(allFive({ packages: [{ name: 'app', dir: 'app' }] }));
    expect(onePackage.options.map((o) => o.kind)).not.toContain('by_layer');
    const noPackages = enumerateSplits(allFive({ packages: [] }));
    expect(noPackages.options.map((o) => o.kind)).not.toContain('by_layer');
  });

  it('by_directory and by_layer own whole trees', () => {
    const { options } = enumerateSplits(allFive());
    expect(options.find((o) => o.kind === 'by_directory')?.agents.map((a) => a.own)).toEqual([['app/**'], ['lib/**']]);
    expect(options.find((o) => o.kind === 'by_layer')?.agents.map((a) => a.own)).toEqual([['app/**'], ['lib/**']]);
  });

  it('by_directory needs two top-level directories', () => {
    const input = base({
      plan: { remaining: ['one', 'two'] },
      itemFiles: [['src/a.ts'], ['src/b.ts']],
      listing: ['src/a.ts', 'src/b.ts'],
    });
    expect(enumerateSplits(input).options.map((o) => o.kind)).toEqual(['by_plan_item', 'no_split']);
  });

  it('as_written passes the generator’s globs through and only infers items', () => {
    const { options } = enumerateSplits(allFive());
    const option = options.find((o) => o.kind === 'as_written');
    expect(option?.agents.map((a) => a.own)).toEqual([['app/**'], ['lib/**']]);
    expect(option?.agents.map((a) => a.task)).toEqual(['the app half', 'the lib half']);
    expect(option?.agents.map((a) => a.items)).toEqual([[0, 2], [1]]);
  });

  it('as_written is absent in jev-only, and when the generator wrote fewer than two agents', () => {
    expect(enumerateSplits(allFive({ asWritten: null })).options.map((o) => o.kind)).not.toContain('as_written');
    const one: DraftSplit = { kind: 'as_written', agents: [{ slug: 'solo', task: 't', own: ['app/**'], verify: [] }] };
    expect(enumerateSplits(allFive({ asWritten: one })).options.map((o) => o.kind)).not.toContain('as_written');
  });

  it('deletes an option in which one agent would own the whole repository (corner row 3)', () => {
    const input = base({
      plan: { remaining: ['everything', 'a corner'] },
      itemFiles: [['src/a.ts'], ['src/b.ts']],
      listing: ['src/a.ts', 'src/b.ts'],
      packages: [
        { name: 'root', dir: 'src' },
        { name: 'other', dir: 'src' },
      ],
      asWritten: {
        kind: 'as_written',
        agents: [
          { slug: 'all', task: 'everything', own: ['src/**'], verify: [] },
          { slug: 'corner', task: 'a corner', own: ['src/b.ts'], verify: [] },
        ],
      },
    });
    const { rejected } = enumerateSplits(input);
    expect(rejected.some((r) => r.kind === 'as_written' && r.reason === 'agent all would own the whole repository')).toBe(true);
  });
});

describe('the prefix tree (§3.2, §3.3)', () => {
  it('topLevelDirs is the deduped, sorted first segment of every path', () => {
    expect(topLevelDirs(['src/a.ts', 'src/b/c.ts', 'test/x.ts', 'README.md'])).toEqual(['src', 'test']);
    expect(topLevelDirs([])).toEqual([]);
  });

  it('prefixTree lists every directory prefix, shallowest first, bounded', () => {
    expect(prefixTree(['src/tui/a.ts', 'src/core/b.ts', 'test/x.ts', 'README.md'])).toEqual(['src', 'test', 'src/core', 'src/tui']);
    expect(prefixTree(['a/b/c/d.ts'], 2)).toEqual(['a', 'a/b']);
    expect(prefixTree(['a/b.ts'], 0)).toEqual([]);
  });
});
