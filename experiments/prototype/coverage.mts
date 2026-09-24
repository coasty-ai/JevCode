/**
 * Coverage: is the reference fix line in the candidate set enumerated for the true buggy line?
 * No Jev. Usage: node node_modules/.bin/tsx experiments/prototype/coverage.mts [--cap 200]
 */
import { performance } from 'node:perf_hooks';
import { listPrograms, loadProgram, normLine } from './quixbugs.mts';
import { buildContext, enumerateCandidates, filterSyntactic } from './mutations.mts';

const capArg = process.argv.indexOf('--cap');
const CAP = capArg >= 0 ? Number(process.argv[capArg + 1]) : 200;
const t0 = performance.now();
let covered = 0, replaceable = 0, coveredUncapped = 0;
const opCount: Record<string, number> = {};
const rows: string[] = [];
const missing: string[] = [];
for (const name of listPrograms()) {
  const p = loadProgram(name);
  if (p.truth.kind !== 'replace') { rows.push(`| ${name} | ${p.truth.kind} | – | – | – | – | n/a (needs a new line) |`); continue; }
  replaceable++;
  const ctx = buildContext(p, p.buggyLines, p.truth.buggyLineIndex);
  const raw = enumerateCandidates(ctx, CAP);
  const cands = filterSyntactic(ctx, raw);
  const fixNorm = normLine(p.truth.fixedLine!);
  const pos = cands.findIndex((c) => normLine(c.text) === fixNorm);
  const all = filterSyntactic(ctx, enumerateCandidates(ctx, 100_000));
  const posAll = all.findIndex((c) => normLine(c.text) === fixNorm);
  if (pos >= 0) { covered++; opCount[cands[pos]!.op] = (opCount[cands[pos]!.op] ?? 0) + 1; }
  if (posAll >= 0) coveredUncapped++;
  else missing.push(`${name}: ${JSON.stringify(p.truth.buggyLine.trim())} -> ${JSON.stringify(p.truth.fixedLine!.trim())}`);
  rows.push(`| ${name} | replace | ${raw.length} → ${cands.length} | ${all.length} | ${pos >= 0 ? `Y (${pos + 1}, ${cands[pos]!.op})` : 'n'} | ${posAll >= 0 ? posAll + 1 : '–'} | ${pos < 0 && posAll >= 0 ? 'lost to cap' : ''} |`);
}
console.log(`| program | truth | candidates (raw → compiling, cap ${CAP}) | uncapped compiling | fix in set (pos, operator) | uncapped pos | note |`);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) console.log(r);
console.log(`\nCoverage at cap ${CAP}: ${covered}/${replaceable} replaceable (${covered}/40 of all); uncapped: ${coveredUncapped}/${replaceable}. Wall ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log('Fix produced by operator:', JSON.stringify(opCount));
if (missing.length) { console.log('\nNot covered even uncapped:'); for (const m of missing) console.log('  ' + m); }
