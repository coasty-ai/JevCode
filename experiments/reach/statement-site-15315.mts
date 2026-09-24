/**
 * Capability probe for django-15315: the gold replaces a 5-physical-line `return hash((...))`
 * statement by `return hash(self.creation_counter)`. The engine's replace sites are physical lines
 * (localize/sites.ts replaceSite: `currentLine = lines[line-1]`), so no source can emit a candidate
 * that also removes lines 546-549. Here the statement is joined onto one physical line (what a
 * "statement-level site" capability would hand the sources) and the same sources are enumerated to
 * see whether the gold line is then in the set. $0.00.
 *
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/reach/statement-site-15315.mts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDonorSource } from '../../src/jev-modes/synth/donor/index.ts';
import { createMutationSource } from '../../src/jev-modes/synth/mutate/index.ts';
import { analyse } from '../../src/jev-modes/synth/py/structure.ts';
import { createCompositeSource } from '../../src/jev-modes/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath, taskIdentifiers, testLiterals } from '../../src/jev-modes/synth/search/subgoal.ts';
import { sketchPool } from '../../src/jev-modes/synth/sketch/pool.ts';
import { instantiates } from '../../src/jev-modes/synth/sketch/productions.ts';
import { toks } from '../../src/jev-modes/synth/beam/tokens.ts';
import { createTemplateSource } from '../../src/jev-modes/synth/templates/index.ts';
import type { EnumerateOptions, FailureView, SourceFile } from '../../src/jev-modes/synth/types.ts';
import { REPOS, loadFile, normLine, parseHunks, replaceSiteAt, sh } from './lib.mts';

const ROOT = join(import.meta.dirname, '..', '..');
const ID = 'django__django-15315';
const ws = join(REPOS, ID);
const rec = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.json'), 'utf8')) as { instance_id: string; problem_statement: string }[]).find((r) => r.instance_id === ID)!;
const gold = (JSON.parse(readFileSync(join(ROOT, 'bench/data/swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>)[ID]!;
const h = parseHunks(gold)[0]!;
const goldLine = normLine(h.addedCode[0]!);

// the file with the statement's physical lines joined into one
const orig = loadFile(ws, h.file);
const lines = [...orig.mod.lines];
const joined = lines
  .slice(h.oldLine - 1, h.oldLine - 1 + h.removed.length)
  .map((l, i) => (i === 0 ? l : l.trim()))
  .join(' ')
  .replace(/\(\s+/g, '(')
  .replace(/,\s*\)\)/, '))');
lines.splice(h.oldLine - 1, h.removed.length, joined);
const src = `${lines.join('\n')}\n`;
const file: SourceFile = { path: h.file, src, mod: analyse(src) };
console.log(`statement-level site line: ${joined.trim()}`);
console.log(`gold: ${goldLine}`);

const allPaths = sh('git', ['ls-files', '*.py'], ws).split('\n').filter((p) => p.endsWith('.py') && !isTestPath(p)).sort();
const corpus = new Map<string, SourceFile>();
for (const p of allPaths.slice(0, 400)) {
  try {
    corpus.set(p, loadFile(ws, p));
  } catch {
    // unparsable
  }
}
const failure: FailureView = { testId: 'repro::e7fbbfa8', call: 'assert f in d', expected: 'completes without raising AssertionError', actual: 'AssertionError: ' };
const site = replaceSiteAt(file, h.oldLine);
const mutation = createMutationSource();
const template = createTemplateSource();
const donor = createDonorSource();
const composite = createCompositeSource({ singles: [mutation, template, donor], donorUnits: false, signatureUnits: false });
for (const cap of [ENUMERATE_CAP, 1_000_000]) {
  const opts: EnumerateOptions = { cap, testLiterals: testLiterals([failure]), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
  for (const [name, s] of [['mutation', mutation], ['template', template], ['donor', donor], ['composite', composite]] as const) {
    if (name === 'composite' && cap !== ENUMERATE_CAP) continue;
    const t0 = Date.now();
    const cands = s.enumerate(site, opts);
    const hits = cands.map((c, i) => ({ c, i })).filter(({ c }) => c.text.split('\n').some((l) => normLine(l) === goldLine) && (c.extraEdits ?? []).length === 0);
    console.log(`cap ${cap} ${name}: ${cands.length} candidates in ${Date.now() - t0} ms; gold line present: ${hits.length > 0 ? `yes (op ${hits[0]!.c.op}, index ${hits[0]!.i})` : 'no'}`);
  }
}
const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: testLiterals([failure]), taskIdentifiers: taskIdentifiers(rec.problem_statement), corpus };
const pool = sketchPool(site, opts);
const gt = toks(h.addedCode[0]!.trim());
const m = pool.findIndex((e) => instantiates(e.toks, gt));
console.log(`sketch pool ${pool.length}: gold shape ${m >= 0 ? `at ${m} (${pool[m]!.production}: ${pool[m]!.toks.join(' ')})` : 'absent'}`);
