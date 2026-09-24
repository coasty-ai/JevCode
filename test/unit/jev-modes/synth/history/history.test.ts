/**
 * Unit tests of src/jev-modes/synth/history: the issue-reference and identifier ranking, the diff parser
 * (change runs with context), the harvest against a real temporary git repository through a
 * sandbox-shaped `run` (bounded commands), and the source's reversals: a changed run comes back
 * as a statement-level replace, an addition as a deletion, a deletion as an insert after its
 * context — each emitted ONLY at the site it is located at (`sameSpan`, the site object being the
 * enumerated one) and applied cleanly by verify/apply.ts; reversals elsewhere are reached through
 * search/sites.ts `historySites` (tested there). The rung-3 reproduction: a reversal located at
 * L1679 never enters the seed of L1686 (jev-only-rungs-1-2.md §21.5 / §24).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HISTORY_MAX_COMMANDS, HISTORY_SITE_NOTE, HISTORY_WINDOW_LINES, createHistorySource, enumerateHistory, harvestHistory, issueRefs, locateLines, locateReversals, parseShowDiff, parseShowOutput, rankIdentifiers, sameSpan, spanEndOf } from '../../../../../src/jev-modes/synth/history/index.js';
import type { HistoryFacts } from '../../../../../src/jev-modes/synth/history/index.js';
import { analyse, blockAt, indentOf, scopeAt } from '../../../../../src/jev-modes/synth/py/index.js';
import { replaceSiteAt } from '../../../../../src/jev-modes/synth/search/sites.js';
import type { EnumerateOptions, Site, SourceFile } from '../../../../../src/jev-modes/synth/types.js';
import { applyCandidate } from '../../../../../src/jev-modes/synth/verify/apply.js';
import { compilerFixture } from './fixtures.js';
import type { VerifyRunFn } from '../../../../../src/jev-modes/synth/verify/types.js';

function sourceFromText(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

function replaceSite(file: SourceFile, line: number): Site {
  const currentLine = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return { file, line, kind: 'replace', currentLine, indent: indentOf(currentLine), block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine }, scope: scopeAt(file.mod, line), evidence: { notes: ['test'] } };
}

function insertSite(file: SourceFile, line: number, indent: string): Site {
  const b = blockAt(file.mod, Math.max(1, line - 1));
  return { file, line, kind: 'insert', currentLine: '', indent, block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine }, scope: scopeAt(file.mod, Math.max(1, line - 1)), evidence: { notes: ['test'] } };
}

/** The statement-level site search/sites.ts builds at the first line of a multi-line statement (what the Jev-ranked list holds there). */
function statementSite(file: SourceFile, line: number): Site {
  const s = replaceSiteAt(file, line, { notes: ['test'] });
  if (s === null) throw new Error(`no replace site at ${file.path}:${line}`);
  return s;
}

function options(over: Partial<EnumerateOptions> = {}): EnumerateOptions {
  return { cap: 254, testLiterals: [], taskIdentifiers: [], corpus: new Map(), ...over };
}

describe('references and identifiers', () => {
  it('issueRefs finds ticket numbers and commit hashes, not plain numbers or words', () => {
    expect(issueRefs('The bug was introduced in #31750 and again in #31750; see commit 502e75f9ed and deadbeef, not 1234567 or 12.')).toEqual([
      { kind: 'ticket', value: '#31750' },
      { kind: 'sha', value: '502e75f9ed' },
    ]);
    expect(issueRefs('nothing here')).toEqual([]);
  });

  it('rankIdentifiers prefers identifiers the localised files contain, then longer ones; short and odd tokens dropped', () => {
    const f = sourceFromText('a.py', 'def __hash__(self):\n    return hash(self.creation_counter)\n');
    expect(rankIdentifiers(['max_length', '__hash__', 'CharField', 'creation_counter', 'x1', '__hash__'], [f])).toEqual(['creation_counter', '__hash__', 'max_length', 'CharField']);
  });
});

const SHOW_ONE = [
  'diff --git a/pkg/m.py b/pkg/m.py',
  'index 1..2 100644',
  '--- a/pkg/m.py',
  '+++ b/pkg/m.py',
  '@@ -1,9 +1,12 @@',
  ' def a():',
  '-    return 1',
  '+    return (',
  '+        1',
  '+    )',
  ' ',
  ' def b():',
  '     x = 2',
  '+    y = 3',
  '     return x',
  ' ',
  ' def c():',
  '-    z = 0',
  '     return 4',
].join('\n');

describe('diff parsing', () => {
  it('parseShowDiff splits one hunk into change runs with old/new numbering and context', () => {
    const runs = parseShowDiff(SHOW_ONE);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ file: 'pkg/m.py', oldStart: 2, oldLines: ['    return 1'], newStart: 2, newLines: ['    return (', '        1', '    )'], before: ['def a():'], after: ['', 'def b():', '    x = 2'] });
    // an addition's oldStart is the old line it was inserted before (6: `return x`)
    expect(runs[1]).toMatchObject({ oldStart: 6, oldLines: [], newStart: 8, newLines: ['    y = 3'], before: ['', 'def b():', '    x = 2'], after: ['    return x', '', 'def c():'] });
    expect(runs[2]).toMatchObject({ oldStart: 9, oldLines: ['    z = 0'], newStart: 12, newLines: [], before: ['    return x', '', 'def c():'], after: ['    return 4'] });
  });

  it('parseShowOutput splits records on the separator, keeps sha/time/subject and the reason', () => {
    const out = `\u001e${'a'.repeat(40)}\u001f1700000000\u001fFixed #1 -- thing\n${SHOW_ONE}\n\u001e${'b'.repeat(40)}\u001f1600000000\u001fOlder\n`;
    const commits = parseShowOutput(out, new Map([['a'.repeat(40), 'ticket:#1']]));
    expect(commits.map((c) => [c.sha[0], c.time, c.subject, c.reason, c.hunks.length])).toEqual([['a', 1700000000, 'Fixed #1 -- thing', 'ticket:#1', 3], ['b', 1600000000, 'Older', '', 0]]);
  });

  it('locateLines finds a sequence exactly, then whitespace-insensitively, nearest the hint', () => {
    const lines = ['a', '  x = 1', 'b', 'x = 1', 'c'];
    expect(locateLines(lines, ['  x = 1'], 1)).toBe(2);
    expect(locateLines(lines, ['x  =  1'], 4)).toBe(4);
    expect(locateLines(lines, ['x  =  1'], 1)).toBe(2);
    expect(locateLines(lines, ['nope'], 1)).toBe(-1);
    expect(locateLines(lines, [], 1)).toBe(-1);
  });
});

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!gitAvailable)('harvest and source on a real repository', () => {
  let repo = '';
  let calls: string[] = [];
  const run: VerifyRunFn = async (command, opts) => {
    calls.push(command);
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeoutMs });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
  };
  const V1 = ['class Field:', '    def __init__(self, n):', '        self.counter = n', '', '    def __hash__(self):', '        return hash(self.counter)', '', '    def label(self):', '        return "f"', ''].join('\n');
  const V2 = ['class Field:', '    def __init__(self, n):', '        self.counter = n', '', '    def __hash__(self):', '        return hash((', '            self.counter,', '            self.label(),', '        ))', '', '    def label(self):', '        return "f"', ''].join('\n');
  const V3 = ['class Field:', '    def __init__(self, n):', '        self.counter = n', '        self.model = None', '', '    def __hash__(self):', '        return hash((', '            self.counter,', '            self.label(),', '        ))', '', '    def label(self):', '        return "f"', ''].join('\n');
  /** distinct committer dates so recency is well defined (three commits in one second would tie on %ct) */
  const git = (args: string[], date = '2020-01-01T00:00:00Z'): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'jev-history-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('mkdir', ['-p', join(repo, 'pkg')]);
    writeFileSync(join(repo, 'pkg', 'fields.py'), V1);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'Initial fields'], '2020-01-01T00:00:00Z');
    writeFileSync(join(repo, 'pkg', 'fields.py'), V2);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'Fixed #4242 -- Made Field hash include the label.'], '2020-01-02T00:00:00Z');
    writeFileSync(join(repo, 'pkg', 'fields.py'), V3);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'Added model attribute'], '2020-01-03T00:00:00Z');
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('harvestHistory finds the ticket commit and the -S commits within the command budget, with the runs parsed', async () => {
    calls = [];
    const facts = await harvestHistory(run, { workspace: repo, files: ['pkg/fields.py'], task: 'Field.__hash__ changes. The bug was introduced in #4242. We can revert the __hash__ change.', identifiers: ['__hash__', 'model', 'label', 'xy'], sources: [sourceFromText('pkg/fields.py', V3)] });
    expect(facts.commands).toBeLessThanOrEqual(HISTORY_MAX_COMMANDS);
    // 1 ticket query + 3 identifier queries (`xy` is too short) + 1 show
    expect(facts.commands).toBe(5);
    expect(calls.length).toBe(facts.commands);
    // all three occur in the file; then longest first, then code-point order
    expect(calls.filter((c) => c.includes(' -S')).map((c) => /-S'([^']+)'/.exec(c)?.[1])).toEqual(['__hash__', 'label', 'model']);
    expect(calls.every((c) => c.startsWith('git log') || c.startsWith('git show'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('git show'))).toHaveLength(1);
    expect(calls[0]).toContain("--grep='#4242'");
    const ticket = facts.commits.find((c) => c.reason === 'ticket:#4242');
    expect(ticket).toBeDefined();
    expect(ticket!.subject).toContain('#4242');
    expect(ticket!.hunks).toHaveLength(1);
    expect(ticket!.hunks[0]).toMatchObject({ file: 'pkg/fields.py', oldLines: ['        return hash(self.counter)'], newLines: ['        return hash((', '            self.counter,', '            self.label(),', '        ))'] });
    // most recent first; the identifier queries found the other commits too
    expect(facts.commits.map((c) => c.subject)).toEqual(['Added model attribute', 'Fixed #4242 -- Made Field hash include the label.', 'Initial fields']);
    expect(facts.note).toContain('3 commits');
  });

  it('a workspace without localised files or with unknown references runs no or few commands and yields no commits', async () => {
    calls = [];
    const none = await harvestHistory(run, { workspace: repo, files: [], task: '#4242', identifiers: ['__hash__'] });
    expect(none.commits).toEqual([]);
    expect(calls).toEqual([]);
    const unknown = await harvestHistory(run, { workspace: repo, files: ['pkg/fields.py'], task: 'see #99999 and 0123abc', identifiers: [] });
    expect(unknown.commits).toEqual([]);
    expect(unknown.commands).toBe(2);
  });

  it('the source reverses the changed run at the statement-level site of its current lines, the addition as a deletion at its own line, each only at its own site, applied cleanly', async () => {
    const facts: HistoryFacts = await harvestHistory(run, { workspace: repo, files: ['pkg/fields.py'], task: 'reverting #4242', identifiers: ['model'] });
    const file = sourceFromText('pkg/fields.py', V3);
    // every reversal of the file at its own location: the hash tuple L7-10 (a span) and the added `self.model = None` L4
    const located = locateReversals(file, facts);
    expect(located.map((r) => [r.candidate.site.line, r.candidate.site.kind, spanEndOf(r.candidate.site), r.candidate.op])).toEqual([[4, 'replace', 4, 'history_revert_addition'], [7, 'replace', 10, 'history_revert_change']]);
    expect(located.every((r) => r.candidate.site.evidence.notes[0]?.startsWith(HISTORY_SITE_NOTE) && r.candidate.site.evidence.notes[1] === r.candidate.provenance)).toBe(true);
    // at the statement site L7-10 (what buildGoalSites holds at L7): the change comes back, the candidate AT that site object, no extra edits (apply deletes the span)
    const site = statementSite(file, 7);
    expect(site.endLine).toBe(10);
    const cands = enumerateHistory(site, options({ history: facts }));
    expect(cands.map((c) => c.op)).toEqual(['history_revert_change']);
    const revert = cands[0]!;
    expect(revert.site).toBe(site);
    expect(revert.source).toBe('history');
    expect(revert.text).toBe('        return hash(self.counter)');
    expect(revert.extraEdits).toBeUndefined();
    expect(revert.provenance).toContain('#4242');
    expect(applyCandidate(revert).files[0]!.after).toBe(V1.replace('        self.counter = n\n', '        self.counter = n\n        self.model = None\n'));
    // at the one-line site L7 (span 7..7 ≠ 7..10) and at L8 nothing: the reversal is not at those sites
    expect(enumerateHistory(replaceSite(file, 7), options({ history: facts }))).toEqual([]);
    expect(enumerateHistory(replaceSite(file, 8), options({ history: facts }))).toEqual([]);
    // the addition's reversal only at L4, as a deletion of that line
    const at4 = enumerateHistory(replaceSite(file, 4), options({ history: facts }));
    expect(at4.map((c) => c.op)).toEqual(['history_revert_addition']);
    expect(at4[0]!.text).toBe('');
    expect(applyCandidate(at4[0]!).files[0]!.after).toBe(V2.replace('        self.counter = n\n', '        self.counter = n\n\n'));
    // the same set through the CandidateSource, and nothing without facts
    expect(createHistorySource().enumerate(site, options({ history: facts })).map((c) => c.id)).toEqual(cands.map((c) => c.id));
    expect(createHistorySource().enumerate(site, options())).toEqual([]);
  });

  it('a pure deletion comes back as an insert at the gap after its context, only there; a far change is offered at its own line whatever the distance, and never at another site', () => {
    const pad = Array.from({ length: HISTORY_WINDOW_LINES + 20 }, (_, i) => `x${i} = ${i}`).join('\n');
    const src = `${pad}\ndef f():\n    a = 1\n    return a\n`;
    const file = sourceFromText('m.py', src);
    const facts: HistoryFacts = {
      files: ['m.py'],
      commands: 1,
      durationMs: 0,
      note: '',
      commits: [
        { sha: 'c'.repeat(40), subject: 'Removed the guard', time: 2, reason: 'ident:a', hunks: [{ file: 'm.py', oldStart: 3, oldLines: ['    if a is None:', '        return 0'], newStart: 3, newLines: [], before: ['def f():', '    a = 1'], after: ['    return a'] }] },
        { sha: 'd'.repeat(40), subject: 'Far away', time: 1, reason: 'ident:x0', hunks: [{ file: 'm.py', oldStart: 1, oldLines: ['x0 = 100'], newStart: 1, newLines: ['x0 = 0'], before: [], after: ['x1 = 1'] }] },
      ],
    };
    const lastLine = file.mod.lines.length;
    // the deletion's reversal is an insert before `return a`: not at the replace site of that line, only at the gap
    expect(enumerateHistory(replaceSite(file, lastLine), options({ history: facts }))).toEqual([]);
    const gap = insertSite(file, lastLine, '    ');
    const cands = enumerateHistory(gap, options({ history: facts }));
    expect(cands.map((c) => c.op)).toEqual(['history_revert_deletion']);
    const ins = cands[0]!;
    expect(ins.site).toBe(gap);
    expect(applyCandidate(ins).files[0]!.after).toBe(`${pad}\ndef f():\n    a = 1\n    if a is None:\n        return 0\n    return a\n`);
    // the far change: at its own line, HISTORY_WINDOW_LINES away from everything else; nowhere else
    expect(enumerateHistory(replaceSite(file, 1), options({ history: facts })).map((c) => [c.op, c.text])).toEqual([['history_revert_change', 'x0 = 100']]);
    expect(enumerateHistory(replaceSite(file, 2), options({ history: facts }))).toEqual([]);
    // sameSpan: file, line, kind and span end; an insert's indent is not part of the identity
    expect(sameSpan(gap, insertSite(file, lastLine, ''))).toBe(true);
    expect(sameSpan(gap, replaceSite(file, lastLine))).toBe(false);
    expect(sameSpan(replaceSite(file, 1), { ...replaceSite(file, 1), endLine: 2 })).toBe(false);
  });

  it('rung-3 reproduction (§21.5): a reversal located at L1679 never enters the seed of the site L1686 in the same function; it is listed among the located reversals at its own site', () => {
    const { file, facts, siteAt } = compilerFixture();
    const site = siteAt(1686);
    expect(site.block?.name).toBe('as_sql');
    const located = locateReversals(file, facts);
    expect(located.map((r) => `${r.candidate.site.file.path}:${r.candidate.site.line}:${r.candidate.site.kind}`)).toEqual(['django/db/models/sql/compiler.py:1679:replace']);
    expect(located[0]!.candidate.site.block?.name).toBe('as_sql');
    // the site being enumerated gets none of it (before the fix: one foreign-site candidate, and the ranker threw)
    const seed = enumerateHistory(site, options({ history: facts, corpus: new Map([[file.path, file]]) }));
    expect(seed).toEqual([]);
    // at its own site the reversal is emitted, with that site object
    const own = siteAt(1679);
    const there = enumerateHistory(own, options({ history: facts }));
    expect(there.map((c) => [c.site === own, c.text.trim(), c.op])).toEqual([[true, 'combinator = getattr(self.query, "combinator", None)', 'history_revert_change']]);
    expect(there.every((c) => sameSpan(c.site, own))).toBe(true);
  });

  it('reading the file back confirms the fixture repository is what the harvest saw', () => {
    expect(readFileSync(join(repo, 'pkg', 'fields.py'), 'utf8')).toBe(V3);
  });
});
