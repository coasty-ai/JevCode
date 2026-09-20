/**
 * Reach after capabilities 4, 5 and 6 of experiments/results/swebench-reach-oracle-9.md (statement-level
 * replace sites + `collapse_collection_to_element`, stdlib-sibling callee substitution carrying its
 * import, depth-2 wraps in WIDENED): at the gold sites of django-15315, sympy-11618 and sympy-19954,
 * enumerate the real sources (mutation, templates, donors, composite; ENUMERATE_CAP 254; the engine's
 * 400-file corpus plus the gold file) at the site the engine built before (the physical line, SEEDS)
 * and at the site/phase the capability adds (the statement-level site; the WIDENED phase), report the
 * counts and the index of the test-equivalent candidate, then apply that candidate with
 * verify/apply.ts into a private worktree (test patch applied) and run the instance's FAIL_TO_PASS
 * tests with the bench venv. $0.00: no Jev call.
 *
 * Usage: node node_modules/.bin/tsx experiments/reach/capabilities-4-5-6.mts [--only a,b] [--no-f2p]
 * Output: experiments/reach/out/capabilities-4-5-6.json and a markdown table on stdout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDonorSource } from '../../src/synth/donor/index.ts';
import { statementSiteAt } from '../../src/synth/localize/sites.ts';
import { createMutationSource } from '../../src/synth/mutate/index.ts';
import { createCompositeSource } from '../../src/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/synth/search/subgoal.ts';
import { createTemplateSource } from '../../src/synth/templates/index.ts';
import type { Candidate, CandidateSource, EnumerateOptions, FailureView, Site, SourceFile } from '../../src/synth/types.ts';
import { applyCandidate } from '../../src/synth/verify/apply.ts';
import { REPOS, loadFile, normLine, privateWorktree, replaceSiteAt, runF2P, sh, venvPython } from './lib.mts';
import type { F2PRecord } from './lib.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');
const MAX_WORKSPACE_PY_FILES = 400;

interface Target {
  id: string;
  file: string;
  line: number;
  /** the test-equivalent line (code tokens compared) */
  target: string;
  /** the extra edit the candidate must carry (an import), if any */
  extraText?: string;
  /** the capability under test */
  after: { statementSite: boolean; phase?: 'WIDENED' };
  capability: string;
}

const TARGETS: Target[] = [
  { id: 'django__django-15315', file: 'django/db/models/fields/__init__.py', line: 545, target: 'return hash(self.creation_counter)', after: { statementSite: true }, capability: '4 statement-level site + collapse_collection_to_element' },
  {
    id: 'sympy__sympy-11618',
    file: 'sympy/geometry/point.py',
    line: 269,
    target: 'return sqrt(sum([(a - b)**2 for a, b in zip_longest(self.args, p.args if isinstance(p, Point) else p, fillvalue=0)]))',
    extraText: 'from itertools import zip_longest',
    after: { statementSite: true },
    capability: '5 stdlib-sibling callee substitution carrying its import (at the statement-level site)',
  },
  { id: 'sympy__sympy-19954', file: 'sympy/combinatorics/perm_groups.py', line: 2198, target: 'for i, r in reversed(list(enumerate(rep_blocks))):', after: { statementSite: false, phase: 'WIDENED' }, capability: '6 depth-2 wraps (WIDENED)' },
];

interface Rec extends F2PRecord {
  base_commit: string;
  problem_statement: string;
}

interface OracleRow {
  instance_id: string;
  goal?: { test_id: string; call: string; expected: string; actual: string };
}

interface SourceCount {
  source: string;
  count: number;
  ms: number;
  targetIndex: number | null;
  op: string | null;
}

interface SiteResult {
  label: string;
  site: string;
  currentLine: string;
  counts: SourceCount[];
  total: number;
  found: { source: string; index: number; op: string; extraEdits: string[] } | null;
}

interface Result {
  id: string;
  capability: string;
  before: SiteResult;
  after: SiteResult;
  f2p: { pass: boolean; ms: number; tail: string; diff: string } | null;
}

function siteLabel(s: Site): string {
  return `${s.file.path}:${s.line}${s.endLine !== undefined ? `-${s.endLine}` : ''}`;
}

function candidateLines(c: Candidate): string[] {
  const out = c.text.split('\n');
  for (const e of c.extraEdits ?? []) if (e.text !== undefined) out.push(...e.text.split('\n'));
  return out;
}

function matches(c: Candidate, t: Target): boolean {
  const goal = normLine(t.target);
  if (!c.text.split('\n').some((l) => normLine(l) === goal)) return false;
  if (t.extraText === undefined) return true;
  return (c.extraEdits ?? []).some((e) => e.text !== undefined && normLine(e.text) === normLine(t.extraText!));
}

function enumerateAt(site: Site, opts: EnumerateOptions, sources: readonly [string, CandidateSource][], t: Target, label: string): { result: SiteResult; candidate: Candidate | null } {
  const counts: SourceCount[] = [];
  let found: SiteResult['found'] = null;
  let candidate: Candidate | null = null;
  for (const [name, src] of sources) {
    const t0 = Date.now();
    let cands: Candidate[] = [];
    try {
      cands = src.enumerate(site, opts);
    } catch (e) {
      console.error(`  ${name} failed: ${String(e).slice(0, 200)}`);
    }
    const ms = Date.now() - t0;
    const k = cands.findIndex((c) => matches(c, t));
    counts.push({ source: name, count: cands.length, ms, targetIndex: k < 0 ? null : k, op: k < 0 ? null : cands[k]!.op });
    if (k >= 0 && found === null) {
      found = { source: name, index: k, op: cands[k]!.op, extraEdits: (cands[k]!.extraEdits ?? []).map((e) => `${e.kind}@${e.line}: ${e.text ?? ''}`) };
      candidate = cands[k]!;
    }
    console.error(`  [${label}] ${name}: ${cands.length} in ${ms} ms${k >= 0 ? ` — target at ${k} (${cands[k]!.op})` : ''}`);
  }
  return { result: { label, site: siteLabel(site), currentLine: site.currentLine.trim().slice(0, 160), counts, total: counts.reduce((s, c) => s + c.count, 0), found }, candidate };
}

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const only = onlyArg === undefined ? null : onlyArg.slice('--only='.length).split(',');
const noF2p = argv.includes('--no-f2p');
const records = JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as Rec[];
const oracle = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows: OracleRow[] }).rows;
mkdirSync(OUT_DIR, { recursive: true });
const results: Result[] = [];

for (const t of TARGETS) {
  if (only !== null && !only.includes(t.id)) continue;
  const rec = records.find((r) => r.instance_id === t.id);
  if (rec === undefined) throw new Error(`${t.id} not in the bench data`);
  const ws = join(REPOS, t.id);
  const head = sh('git', ['rev-parse', 'HEAD'], ws).trim();
  if (!head.startsWith(rec.base_commit.slice(0, 10)) || sh('git', ['status', '--short'], ws).trim() !== '') throw new Error(`${ws} is not clean at ${rec.base_commit}`);
  console.error(`${t.id}: ${t.capability}`);
  const t0 = Date.now();
  const allPaths = sh('git', ['ls-files', '*.py'], ws).split('\n').filter((p) => p.endsWith('.py') && !isTestPath(p)).sort();
  const corpus = new Map<string, SourceFile>();
  for (const p of allPaths.slice(0, MAX_WORKSPACE_PY_FILES)) {
    try {
      corpus.set(p, loadFile(ws, p));
    } catch {
      // unparsable
    }
  }
  const file = corpus.get(t.file) ?? loadFile(ws, t.file);
  corpus.set(t.file, file);
  console.error(`  corpus ${corpus.size} files in ${Date.now() - t0} ms`);
  const row = oracle.find((o) => o.instance_id === t.id);
  const failures: FailureView[] = row?.goal === undefined ? [] : [{ testId: row.goal.test_id, call: row.goal.call, expected: row.goal.expected, actual: row.goal.actual }];
  const seeds: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
  const sources: [string, CandidateSource][] = [
    ['mutation', createMutationSource()],
    ['template', createTemplateSource()],
    ['donor', createDonorSource()],
    ['composite', createCompositeSource()],
  ];
  const physical = replaceSiteAt(file, t.line);
  const before = enumerateAt(physical, seeds, sources, t, 'before: physical line, SEEDS');
  const afterSite = t.after.statementSite ? statementSiteAt(file, t.line, { notes: ['gold site'] }) : physical;
  if (afterSite === null) throw new Error(`${t.id}: no statement-level site at ${t.file}:${t.line}`);
  const afterOpts: EnumerateOptions = t.after.phase === undefined ? seeds : { ...seeds, phase: t.after.phase };
  const after = enumerateAt(afterSite, afterOpts, sources, t, `after: ${t.after.statementSite ? 'statement-level site' : 'physical line'}, ${t.after.phase ?? 'SEEDS'}`);
  let f2p: Result['f2p'] = null;
  if (!noF2p && after.candidate !== null) {
    const python = venvPython(t.id);
    if (python === null) console.error('  no venv: F2P skipped');
    else {
      const applied = applyCandidate(after.candidate);
      const wt = privateWorktree(t.id, rec.repo, rec.base_commit, '-cap456');
      const tp = join('/tmp/jevonly/reach', `${t.id}.test.patch`);
      writeFileSync(tp, rec.test_patch);
      sh('git', ['apply', tp], wt);
      for (const f of applied.files) writeFileSync(join(wt, f.path), f.after);
      const r = runF2P(rec, wt, python);
      f2p = { pass: r.pass, ms: r.ms, tail: r.tail, diff: applied.diff };
      console.error(`  F2P ${r.pass ? 'PASS' : 'FAIL'} in ${r.ms} ms`);
      sh('git', ['checkout', '--', '.'], wt);
    }
  }
  results.push({ id: t.id, capability: t.capability, before: before.result, after: after.result, f2p });
}

writeFileSync(join(OUT_DIR, 'capabilities-4-5-6.json'), JSON.stringify({ ran_at: new Date().toISOString(), spend_usd: 0, results }, null, 1));
const fmt = (s: SiteResult): string => s.counts.map((c) => `${c.count}`).join(' + ') + ` = ${s.total}`;
console.log('| instance | capability | before: site / SEEDS candidates (m + t + d + c) | target before | after: site / phase / candidates | target after (source, index, op) | F2P |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  const fb = r.before.found === null ? 'absent' : `${r.before.found.source} #${r.before.found.index} (${r.before.found.op})`;
  const fa = r.after.found === null ? 'absent' : `${r.after.found.source} #${r.after.found.index} (${r.after.found.op})${r.after.found.extraEdits.length > 0 ? ` + ${r.after.found.extraEdits.join('; ')}` : ''}`;
  console.log(`| ${r.id} | ${r.capability} | ${r.before.site}: ${fmt(r.before)} | ${fb} | ${r.after.site} (${r.after.label.replace('after: ', '')}): ${fmt(r.after)} | ${fa} | ${r.f2p === null ? 'not run' : `${r.f2p.pass ? 'PASS' : 'FAIL'} (${(r.f2p.ms / 1000).toFixed(1)} s)`} |`);
}
console.log(`\nwritten ${join(OUT_DIR, 'capabilities-4-5-6.json')}`);
