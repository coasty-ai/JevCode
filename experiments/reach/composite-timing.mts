/**
 * Wall time of the composite source's signature units (and optionally the donor-body units) at one
 * replace site of a SWE-bench base checkout with the engine's 400-file corpus; the performance
 * hazard of swebench-reach-oracle-9.md ("did not return within 10 minutes" at sympy/core/function.py:510).
 * Run under an external cap (python3 subprocess timeout) so a runaway call is reported, not waited for.
 *
 * Usage: node node_modules/.bin/tsx experiments/reach/composite-timing.mts <instance_id> <file> <line> [--donor-units]
 */
import { join } from 'node:path';
import { createCompositeSource } from '../../src/jev-modes/synth/search/composite.ts';
import { ENUMERATE_CAP, isTestPath } from '../../src/jev-modes/synth/search/subgoal.ts';
import type { EnumerateOptions, SourceFile } from '../../src/jev-modes/synth/types.ts';
import { REPOS, loadFile, replaceSiteAt, sh } from './lib.mts';

const [id, path, lineArg, ...flags] = process.argv.slice(2);
if (id === undefined || path === undefined || lineArg === undefined) throw new Error('usage: composite-timing.mts <instance_id> <file> <line> [--donor-units]');
const ws = join(REPOS, id);
const t0 = Date.now();
const allPaths = sh('git', ['ls-files', '*.py'], ws).split('\n').filter((p) => p.endsWith('.py') && !isTestPath(p)).sort();
const corpus = new Map<string, SourceFile>();
for (const p of allPaths.slice(0, 400)) {
  try {
    corpus.set(p, loadFile(ws, p));
  } catch {
    // unparsable
  }
}
const file = corpus.get(path) ?? loadFile(ws, path);
corpus.set(path, file);
console.log(`corpus ${corpus.size} files loaded in ${Date.now() - t0} ms; site ${path}:${lineArg}: ${(file.mod.lines[Number(lineArg) - 1] ?? '').trim()}`);
const site = replaceSiteAt(file, Number(lineArg));
const opts: EnumerateOptions = { cap: ENUMERATE_CAP, testLiterals: [], taskIdentifiers: [], corpus };
const composite = createCompositeSource();
const t1 = Date.now();
const sig = composite.enumerateSignatureUnits(site, opts);
console.log(`signature units: ${sig.length} in ${Date.now() - t1} ms`);
if (flags.includes('--donor-units')) {
  const t2 = Date.now();
  const du = composite.enumerateDonorBodyUnits(site, opts);
  console.log(`donor-body units: ${du.length} in ${Date.now() - t2} ms`);
}
