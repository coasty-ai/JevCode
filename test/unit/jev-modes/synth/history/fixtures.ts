/**
 * The shape of the rung-3 defect (experiments/results/jev-only-rungs-1-2.md §21.5, fixed in §24): a
 * `compiler.py` whose `as_sql` spans L1674-1688, a harvested commit that changed L1679, and the
 * Jev-ranked site L1686 in the same function (7 lines away: inside the old proximity window and
 * the block, so the old `enumerateHistory` offered the L1679 reversal at L1686 and the ranker threw).
 * Shared by the history, wiring and sites tests.
 */
import type { HistoryFacts } from '../../../../../src/jev-modes/synth/history/index.js';
import { analyse, blockAt, indentOf, scopeAt } from '../../../../../src/jev-modes/synth/py/index.js';
import type { Site, SourceFile } from '../../../../../src/jev-modes/synth/types.js';

export const COMPILER_PATH = 'django/db/models/sql/compiler.py';
/** the line the harvested commit changed */
export const HISTORY_LINE = 1679;
/** the Jev-ranked site of the live run */
export const RANKED_LINE = 1686;

export function replaceSiteOf(file: SourceFile, line: number): Site {
  const currentLine = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return { file, line, kind: 'replace', currentLine, indent: indentOf(currentLine), block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine }, scope: scopeAt(file.mod, line), evidence: { notes: ['Q5 anchor'] } };
}

export function compilerFixture(): { file: SourceFile; facts: HistoryFacts; siteAt: (line: number) => Site } {
  const lines: string[] = [];
  for (let i = 1; i <= 1670; i++) lines.push(`v${i} = ${i}`);
  lines.push('', '', 'class SQLCompiler:', '    def as_sql(self, with_limits=True):', '        refcounts_before = self.query.alias_refcount.copy()', '        try:', '            extra_select, order_by, group_by = self.pre_sql_setup()', '            for_update_part = None', '            combinator = self.query.combinator', '            features = self.connection.features', '            if combinator:', '                result, params = self.get_combinator_sql(combinator, self.query.combinator_all)', '            else:', '                distinct_fields, distinct_params = self.get_distinct()', "                result = ['SELECT']", "            return ' '.join(result), tuple(params)", '        finally:', '            self.query.reset_refcounts(refcounts_before)', '');
  const src = lines.join('\n');
  const file: SourceFile = { path: COMPILER_PATH, src, mod: analyse(src) };
  const facts: HistoryFacts = {
    files: [COMPILER_PATH],
    commands: 3,
    durationMs: 1,
    note: '1 commit, 1 change run in 1 file',
    commits: [{ sha: '0c763317'.padEnd(40, 'a'), subject: 'Fixed #12345 -- Read the combinator from the query.', time: 10, reason: 'ticket:#12345', hunks: [{ file: COMPILER_PATH, oldStart: HISTORY_LINE, oldLines: ['            combinator = getattr(self.query, "combinator", None)'], newStart: HISTORY_LINE, newLines: ['            combinator = self.query.combinator'], before: ['            extra_select, order_by, group_by = self.pre_sql_setup()', '            for_update_part = None'], after: ['            features = self.connection.features'] }] }],
  };
  return { file, facts, siteAt: (line) => replaceSiteOf(file, line) };
}

/** `compilerFixture` plus an older commit whose run sits far from the ranked site (L5), for the recency-then-proximity order of `historySites`. */
export function compilerFixtureWithOlderFarCommit(): ReturnType<typeof compilerFixture> {
  const base = compilerFixture();
  const older = { sha: 'deadbeef'.padEnd(40, 'b'), subject: 'Older: renumbered v5', time: 5, reason: 'ident:v5', hunks: [{ file: COMPILER_PATH, oldStart: 5, oldLines: ['v5 = 50'], newStart: 5, newLines: ['v5 = 5'], before: ['v3 = 3', 'v4 = 4'], after: ['v6 = 6'] }] };
  return { ...base, facts: { ...base.facts, commits: [...base.facts.commits, older] } };
}
