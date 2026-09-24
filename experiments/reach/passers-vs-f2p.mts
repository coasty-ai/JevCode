/**
 * Are the sieve's issue-oracle passers real fixes? For every passer recorded by sieve-at-site.mts
 * (experiments/reach/out/sieve-at-site.<id>.json) the candidate is rebuilt by re-enumerating the same
 * deterministic sources at the same site and matching the recorded canonical text, applied to a
 * private worktree with the instance's test patch, and the FAIL_TO_PASS test(s) are run. Passers
 * that pass F2P are test-equivalent fixes; the rest is oracle overfit (design §9 R2). $0.00.
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/passers-vs-f2p.mts <instance_id>
 * Output: experiments/reach/out/passers-vs-f2p.<instance_id>.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDonorSource } from '../../src/jev-modes/synth/donor/index.ts';
import { createMutationSource } from '../../src/jev-modes/synth/mutate/index.ts';
import { createCompositeSource } from '../../src/jev-modes/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/jev-modes/synth/search/subgoal.ts';
import { canonicalText } from '../../src/jev-modes/synth/sieve/queue.ts';
import { createTemplateSource } from '../../src/jev-modes/synth/templates/index.ts';
import type { Candidate, EnumerateOptions, FailureView, SourceFile } from '../../src/jev-modes/synth/types.ts';
import { applyCandidate } from '../../src/jev-modes/synth/verify/apply.ts';
import { loadFile, privateWorktree, replaceSiteAt, runF2P, sh, venvPython } from './lib.mts';
import type { F2PRecord } from './lib.mts';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT_DIR = join(import.meta.dirname, 'out');
const id = process.argv[2];
if (id === undefined) throw new Error('usage: passers-vs-f2p.mts <instance_id>');

interface Passer {
  source: string;
  op: string;
  site: string;
  text: string;
}
const sieve = JSON.parse(readFileSync(join(OUT_DIR, `sieve-at-site.${id}.json`), 'utf8')) as { passers: Passer[]; candidates: number };
const rec = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as (F2PRecord & { base_commit: string; problem_statement: string })[]).find((r) => r.instance_id === id)!;
const row = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows: { instance_id: string; goal?: { test_id: string; call: string; expected: string; actual: string } }[] }).rows.find((o) => o.instance_id === id);
const failures: FailureView[] = row?.goal === undefined ? [] : [{ testId: row.goal.test_id, call: row.goal.call, expected: row.goal.expected, actual: row.goal.actual }];
const python = venvPython(id);
if (python === null) throw new Error('no venv');
const ws = privateWorktree(id, rec.repo, rec.base_commit, '-f2p');
const tp = join('/tmp/jevonly/reach', `${id}.test.patch`);
writeFileSync(tp, rec.test_patch);
sh('git', ['apply', tp], ws);

// sanity: base fails F2P, gold passes
const goldPatch = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>)[id]!;
const baseRun = runF2P(rec, ws, python);
const gp = join('/tmp/jevonly/reach', `${id}.gold.patch`);
writeFileSync(gp, goldPatch);
sh('git', ['apply', gp], ws);
const goldRun = runF2P(rec, ws, python);
sh('git', ['apply', '-R', gp], ws);
console.log(`${id}: F2P at base ${baseRun.pass ? 'PASSES (bad)' : 'fails'} (${baseRun.ms} ms); with gold ${goldRun.pass ? 'passes' : 'FAILS'} (${goldRun.ms} ms)`);
if (baseRun.pass || !goldRun.pass) throw new Error(`F2P sanity failed: ${goldRun.tail}`);

// rebuild the candidates at the sieve's sites
const allPaths = sh('git', ['ls-files', '*.py'], ws).split('\n').filter((p) => p.endsWith('.py') && !isTestPath(p)).sort();
const corpus = new Map<string, SourceFile>();
for (const p of allPaths.slice(0, 400)) {
  try {
    corpus.set(p, loadFile(ws, p));
  } catch {
    // unparsable
  }
}
const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
const mutation = createMutationSource();
const template = createTemplateSource();
const donor = createDonorSource();
const composite = createCompositeSource({ singles: [mutation, template, donor], donorUnits: false, signatureUnits: false });
const bySite = new Map<string, Candidate[]>();
for (const siteKey of new Set(sieve.passers.map((p) => p.site))) {
  const [path, lineText] = siteKey.split(':');
  const file = corpus.get(path!) ?? loadFile(ws, path!);
  const site = replaceSiteAt(file, Number(lineText));
  const cands: Candidate[] = [];
  for (const s of [mutation, template, donor, composite]) cands.push(...s.enumerate(site, opts));
  bySite.set(siteKey, cands);
}

interface Result extends Passer {
  matched: boolean;
  f2pPass: boolean | null;
  ms: number;
  rawText?: string;
}
const results: Result[] = [];
for (const p of sieve.passers) {
  const cands = bySite.get(p.site) ?? [];
  const c = cands.find((x) => canonicalText(x).slice(0, 160) === p.text && x.source === p.source);
  if (c === undefined) {
    results.push({ ...p, matched: false, f2pPass: null, ms: 0 });
    console.log(`  ? unmatched ${p.source}/${p.op} ${p.text.slice(0, 80)}`);
    continue;
  }
  const applied = applyCandidate(c);
  const originals = new Map<string, string>();
  for (const f of applied.files) {
    originals.set(f.path, readFileSync(join(ws, f.path), 'utf8'));
    writeFileSync(join(ws, f.path), f.after);
  }
  let r: { pass: boolean; ms: number; tail: string };
  try {
    r = runF2P(rec, ws, python);
  } finally {
    for (const [path, src] of originals) writeFileSync(join(ws, path), src);
  }
  results.push({ ...p, matched: true, f2pPass: r.pass, ms: r.ms, rawText: [c.text, ...(c.extraEdits ?? []).map((e) => e.text ?? '')].join(' ⏎ ').trim().slice(0, 200) });
  console.log(`  ${r.pass ? 'F2P PASS' : 'f2p fail'} [${p.source}/${p.op}] ${p.site}: ${c.text.trim().slice(0, 120)}`);
}
sh('git', ['checkout', '--', '.'], ws);
const summary = { instance: id, sieve_candidates: sieve.candidates, oracle_passers: sieve.passers.length, matched: results.filter((r) => r.matched).length, f2p_pass: results.filter((r) => r.f2pPass === true).length, f2p_fail: results.filter((r) => r.f2pPass === false).length, results };
writeFileSync(join(OUT_DIR, `passers-vs-f2p.${id}.json`), JSON.stringify(summary, null, 1));
console.log(`${id}: ${summary.oracle_passers} oracle passers → ${summary.f2p_pass} pass F2P, ${summary.f2p_fail} fail F2P, ${summary.oracle_passers - summary.matched} unmatched`);
