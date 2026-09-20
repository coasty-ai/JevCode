/** Verifier self-test: every correct program passes all (non-slow) tests, every buggy program fails at least one. No Jev. */
import { performance } from 'node:perf_hooks';
import { listPrograms, loadProgram } from './quixbugs.mts';
import { runTests } from './verify.mts';

const t0 = performance.now();
const names = listPrograms();
const rows: string[] = [];
const anomalies: string[] = [];
const queue = names.slice();
async function worker(): Promise<void> {
  for (;;) {
    const n = queue.shift(); if (!n) return;
    const p = loadProgram(n);
    const [c, b] = await Promise.all([runTests(p, p.correctSource), runTests(p, p.buggySource)]);
    if (!c.passedAll) anomalies.push(`${n}: correct program ${c.passed}/${c.total} (${c.runnerError ?? c.firstFailure?.actual ?? ''})`);
    if (b.passedAll) anomalies.push(`${n}: buggy program passes everything`);
    if (b.runnerError) anomalies.push(`${n}: buggy runnerError ${b.runnerError}`);
    rows.push(`| ${n} | ${p.kind} | ${c.total}${c.skipped ? ` (+${c.skipped} slow skipped)` : ''} | ${c.passed} | ${b.passed} | ${b.firstFailure ? `${b.firstFailure.id}: ${b.firstFailure.actual.slice(0, 60)}` : '-'} | ${c.durationMs} / ${b.durationMs} ms |`);
  }
}
await Promise.all([worker(), worker(), worker()]);
// a non-compiling candidate must be reported as a runner error with 0 passed, for both kinds
for (const n of ['gcd', 'breadth_first_search']) {
  const p = loadProgram(n);
  const r = await runTests(p, p.correctSource.replace('\n', '(\n'));
  rows.push(`| ${n} (broken candidate) | ${p.kind} | ${r.total} | - | ${r.passed} | runnerError=${r.runnerError ? JSON.stringify(r.runnerError.slice(0, 50)) : 'null'} | ${r.durationMs} ms |`);
  if (r.passed !== 0 || !r.runnerError) anomalies.push(`${n}: broken candidate not reported as runner error`);
}
console.log('| program | kind | tests | correct passed | buggy passed | buggy first failure | duration correct / buggy |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows.sort()) console.log(r);
console.log(`\n${names.length} programs, anomalies: ${anomalies.length}${anomalies.length ? '\n  ' + anomalies.join('\n  ') : ''}\nwall ${((performance.now() - t0) / 1000).toFixed(1)} s`);
