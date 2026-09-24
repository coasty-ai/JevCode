/**
 * Contrarian follow-up (live Jev, cents): when exhaustive verification leaves SEVERAL test-passing
 * ("plausible") candidates, can Jev pick the genuine fix among them? This is the only place the
 * contrarian design asks Jev about candidates at all. Truth = the gold line (semantically
 * equivalent alternatives are reported as misses and listed for inspection).
 *
 * Input: experiments/results/contrarian-exhaustive.<scope>.jsonl (from exhaustive.mts).
 * Output: experiments/results/contrarian-arbitrate.<scope>.jsonl and a summary on stdout.
 * Run: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/contrarian/arbitrate.mts --scope truth
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Json, Question } from '../../src/core/types.ts';
import { choice, noul } from '../../src/jev/questions.ts';
import { createJev, p50 } from '../prototype/jev.mts';
import { loadProgram, type QuixProgram } from '../prototype/quixbugs.mts';
import { tokenize } from '../prototype/mutations.mts';
import { runTests } from '../prototype/verify.mts';

function arg(name: string, dflt: string): string { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : dflt; }
const SCOPE = arg('--scope', 'truth');
const IN = fileURLToPath(new URL(`../results/contrarian-exhaustive.${SCOPE}.jsonl`, import.meta.url));
const OUT = fileURLToPath(new URL(`../results/contrarian-arbitrate.${SCOPE}.jsonl`, import.meta.url));
const CAP_USD = Number(arg('--cap', '0.10'));
const INCLUDE_NOGOLD = process.argv.includes('--include-nogold') || SCOPE === 'all';

interface Plaus { line: number; text: string; op: string; isGold: boolean }
interface Row { name: string; plausible: Plaus[]; truthKind: string }

/** token edit distance between two lines (code-only baseline for "pick the minimal edit") */
function tokDist(a: string, b: string): number {
  const ta = tokenize(a.trim()).map((t) => t.s), tb = tokenize(b.trim()).map((t) => t.s);
  const dp: number[][] = Array.from({ length: ta.length + 1 }, (_, i) => Array.from({ length: tb.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= ta.length; i++) for (let j = 1; j <= tb.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (ta[i - 1] === tb[j - 1] ? 0 : 1));
  return dp[ta.length]![tb.length]!;
}

function programState(p: QuixProgram): Record<string, Json> {
  const program: Record<string, Json> = {};
  for (const i of p.codeLineIndices) program[`L${i + 1}`] = p.buggyLines[i]!;
  return { program };
}

async function main(): Promise<void> {
  const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.plausible.length >= 2);
  const jev = createJev(CAP_USD);
  writeFileSync(OUT, '');
  let choiceTop1 = 0, noulTop1 = 0, minEditTop1 = 0, goldPresent = 0, n = 0;
  const noGold: { name: string; n: number; escapeArgmax: boolean; pEscape: number; maxNoul: number; pTop: number }[] = [];
  const misses: string[] = [];
  for (const r of rows) {
    const p = loadProgram(r.name);
    const cands = r.plausible.slice(0, 254);
    const hasGold = cands.some((c) => c.isGold);
    if (!hasGold && !INCLUDE_NOGOLD) { console.log(`${r.name}: gold not among plausible (${cands.length}); skipped`); continue; }
    if (hasGold) { n++; goldPresent++; }
    // failing test of the buggy program (actual output) so Jev can judge cause, not just effect
    const base = await runTests(p, p.buggySource, { perTestTimeoutS: 2, hardTimeoutMs: 30_000 });
    const f = base.firstFailure;
    const tests: Json = p.kind === 'json'
      ? (p.tests ?? []).slice(0, 4).map(([input, expected]) => ({ input, expected }))
      : [{ pytest_source_head: p.pytestSource.slice(0, 1500) }];
    const state: Record<string, Json> = {
      task: INCLUDE_NOGOLD
        ? `The Python function in \`program\` had a bug. Every entry of \`candidates\` is a replacement for the line named in its \`line\` field that makes ALL of the program's tests pass. At most one of them is the genuine fix that is correct for every valid input; the others only satisfy the tests. It is possible that none is a genuine fix (for example when the real fix needs a new statement rather than a changed line).`
        : `The Python function in \`program\` had a bug. Every entry of \`candidates\` is a replacement for line \`${cands[0] ? `L${cands[0].line + 1}` : ''}\` (or the line named in its \`line\` field) that makes ALL of the program's tests pass. Exactly one of them is the genuine fix that is correct for every valid input; the others only satisfy the tests.`,
      ...programState(p),
      tests,
      buggy_program_failure: f ? { input: f.input ?? null, expected: f.expected ?? null, actual: f.actual } : null,
      candidates: Object.fromEntries(cands.map((c, i) => [`cand_${String(i + 1).padStart(2, '0')}`, { line: `L${c.line + 1}`, replaces: p.buggyLines[c.line]!.trim(), with: c.text.trim() }])),
    };
    const opts: Record<string, Json | null> = Object.fromEntries(cands.map((c, i) => [`cand_${String(i + 1).padStart(2, '0')}`, `L${c.line + 1}: ${c.text.trim()}`]));
    const questions: Record<string, Question> = {
      genuine_fix: choice('Every option makes all tests pass. Which option is the genuine fix of the defect: the replacement that makes `program` correct for every valid input, not only for `tests`? Read each option literally. Answer carefully and literally.', opts),
    };
    for (const [k] of Object.entries(opts)) {
      questions[`general_${k}`] = noul(`Is \`candidates.${k}\` a correct general fix: with this replacement, does \`program\` compute the right result for every valid input, not just for the listed \`tests\`?`, {
        true: { definition: 'The replacement repairs the actual defect; the algorithm is now correct in general and the change is the minimal one a maintainer would write.', examples: ['an off-by-one bound corrected so every element is visited', 'swapped arguments restored to the order the algorithm requires', 'a missing guard added exactly where the failing input reaches'] },
        false: { definition: 'The replacement makes the listed tests pass by coincidence: it special-cases the tested inputs, changes an unrelated part of the line, removes functionality the tests do not exercise, or is a boundary the tests cannot distinguish.', examples: ['a condition that happens to hold for the tested inputs only', 'deleting a branch no test reaches', 'returning a constant that matches the tested cases'] },
      });
    }
    const res = await jev.ask(state, questions, 'risk');
    const a = res.answers['genuine_fix']!;
    if (a.type !== 'choice') continue;
    const ranked = Object.entries(a.probabilities).filter(([k]) => k !== 'none_of_these').sort((x, y) => y[1] - x[1]);
    const goldKey = hasGold ? `cand_${String(cands.findIndex((c) => c.isGold) + 1).padStart(2, '0')}` : null;
    const choiceHit = goldKey !== null && ranked[0]![0] === goldKey;
    const escapeArgmax = (a.probabilities['none_of_these'] ?? 0) > ranked[0]![1];
    const nouls = Object.entries(res.answers).filter(([k]) => k.startsWith('general_')).map(([k, v]) => [k.slice('general_'.length), v.type === 'noul' ? v.noul : 0] as const).sort((x, y) => y[1] - x[1]);
    const noulHit = goldKey !== null && nouls[0]![0] === goldKey;
    const buggy = p.buggyLines[cands[0]!.line]!;
    const byEdit = cands.map((c, i) => ({ k: `cand_${String(i + 1).padStart(2, '0')}`, d: tokDist(p.buggyLines[c.line]!, c.text) })).sort((x, y) => x.d - y.d);
    const minEditHit = goldKey !== null && byEdit[0]!.k === goldKey && byEdit.filter((x) => x.d === byEdit[0]!.d).length === 1;
    if (hasGold) { choiceTop1 += +choiceHit; noulTop1 += +noulHit; minEditTop1 += +minEditHit; }
    if (!hasGold) { noGold.push({ name: r.name, n: cands.length, escapeArgmax, pEscape: a.probabilities['none_of_these'] ?? 0, maxNoul: nouls[0]![1], pTop: ranked[0]![1] }); }
    const rec = { name: r.name, n: cands.length, hasGold, goldKey, escapeArgmax, choiceTop: ranked[0]![0], pChoiceGold: goldKey ? a.probabilities[goldKey] : null, pChoiceTop: ranked[0]![1], pEscape: a.probabilities['none_of_these'], noulTop: nouls[0]![0], noulGold: goldKey ? nouls.find(([k]) => k === goldKey)![1] : null, noulTopP: nouls[0]![1], minEditTop: byEdit[0]!.k, minEditTie: byEdit.filter((x) => x.d === byEdit[0]!.d).length > 1, choiceHit, noulHit, minEditHit, candidates: cands.map((c, i) => ({ key: `cand_${String(i + 1).padStart(2, '0')}`, line: c.line + 1, text: c.text.trim(), op: c.op, isGold: c.isGold, pChoice: a.probabilities[`cand_${String(i + 1).padStart(2, '0')}`], noul: nouls.find(([k]) => k === `cand_${String(i + 1).padStart(2, '0')}`)![1] })), costUsd: res.usage.costUsd, latencyMs: res.latencyMs };
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`${r.name.padEnd(28)} n=${String(cands.length).padStart(2)} ${hasGold ? '' : 'NO-GOLD '}choice ${choiceHit ? 'HIT ' : 'miss'} p(gold)=${(goldKey ? a.probabilities[goldKey] ?? 0 : 0).toFixed(2)} top=${ranked[0]![1].toFixed(2)} esc=${(a.probabilities['none_of_these'] ?? 0).toFixed(2)} | noul ${noulHit ? 'HIT ' : 'miss'} gold=${(rec.noulGold ?? 0).toFixed(2)} top=${nouls[0]![1].toFixed(2)} | min-edit ${minEditHit ? 'HIT ' : 'miss'}${rec.minEditTie ? '(tie)' : ''}`);
    if (hasGold && (!choiceHit || !noulHit)) misses.push(`${r.name}: gold=${cands.find((c) => c.isGold)!.text.trim()} | choice top=${cands[Number(ranked[0]![0].slice(5)) - 1]!.text.trim()} | noul top=${cands[Number(nouls[0]![0].slice(5)) - 1]!.text.trim()}`);
  }
  console.log(`\nn=${n} programs with >=2 plausible and gold present: Choice top-1 ${choiceTop1}/${n}, Noul top-1 ${noulTop1}/${n}, min-edit baseline ${minEditTop1}/${n}; requests ${jev.meter.requests}, cost $${jev.meter.costUsd.toFixed(4)}, p50 ${p50(jev.meter.latenciesMs)} ms`);
  for (const m of misses) console.log('  ' + m);
  if (noGold.length) {
    console.log(`\nno-gold plausible sets (every candidate overfits): ${noGold.length}; escape argmax ${noGold.filter((x) => x.escapeArgmax).length}/${noGold.length}; max Noul < 0.5 on ${noGold.filter((x) => x.maxNoul < 0.5).length}/${noGold.length}`);
    for (const x of noGold) console.log(`  ${x.name}: n=${x.n} P(escape)=${x.pEscape.toFixed(2)} p(top)=${x.pTop.toFixed(2)} maxNoul=${x.maxNoul.toFixed(2)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
