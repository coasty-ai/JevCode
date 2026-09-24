/**
 * Site probe: enumerate every jev-only source at one replace site of an instance's base checkout and
 * say whether a target line (whitespace-normalised code tokens) is among the candidates, at which
 * index, by which operator; plus the sketch pool check. Used for test-equivalent one-line fixes whose
 * site is not a gold site (sympy-19954: the `for` header at perm_groups.py:2198). $0.00.
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/probe-line.mts <instance_id> <file> <line> '<target line>'
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toks } from '../../src/jev-modes/synth/beam/tokens.ts';
import { createDonorSource } from '../../src/jev-modes/synth/donor/index.ts';
import { buildSlotVocabulary } from '../../src/jev-modes/synth/fill/state.ts';
import { createMutationSource } from '../../src/jev-modes/synth/mutate/index.ts';
import { createCompositeSource } from '../../src/jev-modes/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/jev-modes/synth/search/subgoal.ts';
import { sketchPool } from '../../src/jev-modes/synth/sketch/pool.ts';
import { instantiates, productionsFor } from '../../src/jev-modes/synth/sketch/productions.ts';
import { createTemplateSource } from '../../src/jev-modes/synth/templates/index.ts';
import type { EnumerateOptions, FailureView, SourceFile } from '../../src/jev-modes/synth/types.ts';
import { REPOS, loadFile, normLine, replaceSiteAt, sh } from './lib.mts';

const ROOT = join(import.meta.dirname, '..', '..');
const [id, path, lineArg, target] = process.argv.slice(2);
if (id === undefined || path === undefined || lineArg === undefined || target === undefined) throw new Error('usage: probe-line.mts <instance_id> <file> <line> <target>');
const line = Number(lineArg);
const ws = join(REPOS, id);
const rec = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as { instance_id: string; problem_statement: string }[]).find((r) => r.instance_id === id)!;
const row = (JSON.parse(readFileSync(join(ROOT, 'experiments/oracle/results.json'), 'utf8')) as { rows: { instance_id: string; goal?: { test_id: string; call: string; expected: string; actual: string } }[] }).rows.find((o) => o.instance_id === id);
const failures: FailureView[] = row?.goal === undefined ? [] : [{ testId: row.goal.test_id, call: row.goal.call, expected: row.goal.expected, actual: row.goal.actual }];

const file = loadFile(ws, path);
const site = replaceSiteAt(file, line);
console.log(`site ${path}:${line}: ${site.currentLine.trim()}`);
console.log(`target: ${target.trim()}`);
const goal = normLine(target);
const allPaths = sh('git', ['ls-files', '*.py'], ws).split('\n').filter((p) => p.endsWith('.py') && !isTestPath(p)).sort();
const corpus = new Map<string, SourceFile>();
for (const p of allPaths.slice(0, 400)) {
  try {
    corpus.set(p, loadFile(ws, p));
  } catch {
    // unparsable
  }
}
const mutation = createMutationSource();
const template = createTemplateSource();
const donor = createDonorSource();
const composite = createCompositeSource({ singles: [mutation, template, donor], donorUnits: false, signatureUnits: false });
for (const cap of [ENUMERATE_CAP, 1_000_000]) {
  const opts: EnumerateOptions = { cap, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
  for (const [name, s] of [['mutation', mutation], ['template', template], ['donor', donor], ['composite', composite]] as const) {
    if (name === 'composite' && cap !== ENUMERATE_CAP) continue;
    const t0 = Date.now();
    const cands = s.enumerate(site, opts);
    const hit = cands.map((c, i) => ({ c, i })).find(({ c }) => c.text.split('\n').some((l) => normLine(l) === goal));
    console.log(`cap ${cap} ${name}: ${cands.length} candidates in ${Date.now() - t0} ms; target present: ${hit === undefined ? 'no' : `yes (op ${hit.c.op}, index ${hit.i})`}`);
  }
}
const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals(failures), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
const pool = sketchPool(site, opts);
const all = productionsFor(site, opts);
const gt = toks(target.trim());
const m = pool.findIndex((e) => instantiates(e.toks, gt));
const mu = all.findIndex((s) => instantiates(s.toks, gt));
console.log(`sketch pool ${pool.length} (uncapped ${all.length}): target shape ${m >= 0 ? `at ${m} (${pool[m]!.production}: ${pool[m]!.toks.join(' ')})` : mu >= 0 ? `only uncapped at ${mu} (${all[mu]!.production})` : 'absent'}`);
if (m >= 0) {
  const sv = buildSlotVocabulary(site, opts);
  const idents = new Set([...sv.identifiers, ...sv.literals].map((o) => o.tok.text));
  const holes = pool[m]!.toks.map((t, i) => (t === '_' || t === '<op>' ? `${gt[i]!.text}:${idents.has(gt[i]!.text) ? 'in-vocab' : 'MISSING'}` : null)).filter((x) => x !== null);
  console.log(`holes: ${holes.join(', ')}`);
}
