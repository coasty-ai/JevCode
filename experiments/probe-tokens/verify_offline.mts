/** Offline (no Jev) checks for the verification: tokenizer round trip, candidate coverage, grammar filter admission,
 * option counts, fix lines pass tests, correct/buggy programs under run_tests.py, uncovered-template analysis. */
import { readFileSync } from 'node:fs'; import { join } from 'node:path';
import { HERE, QB, loadCorpus, tokenize, detokenize, sameTokens, candidateSet, tokenOptions, filterOptions, legalNext, runTests, END_KEY, type Tok } from './common.mts';
const corpus = loadCorpus();
let rt = 0, cov = 0, tgt = 0, admit = 0, pos = 0, optsSum = 0, gOptsSum = 0, fixPass = 0; const lens: number[] = []; const perProg: number[] = []; const notAdmitted: string[] = []; const uncovered: string[] = [];
for (const it of corpus) {
  const toks = tokenize(it.fix_line); lens.push(toks.length);
  if (sameTokens(tokenize(detokenize(toks)), toks)) rt++;
  const { cands, byText } = candidateSet(it); const nOpts = Object.keys(tokenOptions(cands)).length; perProg.push(nOpts);
  for (const t of toks) { tgt++; if (byText.has(t.text)) cov++; else uncovered.push(`${it.name}:${t.text}`); }
  for (let p = 0; p <= toks.length; p++) {
    pos++; optsSum += nOpts; const f = filterOptions(cands, toks.slice(0, p)); gOptsSum += Object.keys(f).length;
    const ok = legalNext(toks.slice(0, p)); const t = p < toks.length ? toks[p]! : '<END>';
    if (ok(t as Tok | '<END>')) admit++; else notAdmitted.push(`${it.name}@${p}:${p < toks.length ? toks[p]!.text : 'EOL'}`);
  }
  if (runTests(it, detokenize(toks)).pass) fixPass++;
}
console.log(`round trip ${rt}/40; fix-line tokens min ${Math.min(...lens)} max ${Math.max(...lens)} mean ${(lens.reduce((a, b) => a + b) / 40).toFixed(1)}; positions ${pos}`);
console.log(`candidate coverage ${cov}/${tgt} uncovered=${JSON.stringify(uncovered)}`);
console.log(`options per program (incl end_of_line, excl none_of_these): min ${Math.min(...perProg)} max ${Math.max(...perProg)} mean ${(perProg.reduce((a, b) => a + b) / 40).toFixed(1)}; per position mean ${(optsSum / pos).toFixed(1)}; grammar-filtered mean ${(gOptsSum / pos).toFixed(1)}`);
console.log(`grammar filter admits true next token ${admit}/${pos}; not admitted: ${JSON.stringify(notAdmitted)}`);
console.log(`detokenised fix lines pass tests ${fixPass}/40`);
// correct and buggy programs under run_tests.py
import { execFileSync } from 'node:child_process';
let cp = 0, bf = 0; const bad: string[] = [];
for (const it of corpus) {
  const run = (f: string) => { try { return execFileSync('python3', [join(HERE, 'run_tests.py'), QB, it.name, f], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }).startsWith('PASS'); } catch (e) { return ((e as { stdout?: string }).stdout ?? '').startsWith('PASS'); } };
  if (run(`${QB}/correct_python_programs/${it.name}.py`)) cp++; else bad.push(`correct:${it.name}`);
  if (!run(`${QB}/python_programs/${it.name}.py`)) bf++; else bad.push(`buggy-passes:${it.name}`);
}
console.log(`run_tests: correct programs pass ${cp}/40, buggy programs fail ${bf}/40 ${bad.length ? JSON.stringify(bad) : ''}`);
// uncovered template analysis: did the top template equal the buggy line's template?
const tp = JSON.parse(readFileSync(join(HERE, 'out/templates.json'), 'utf8')) as { rows: { name: string; covered: boolean; top_template: string }[] };
const isSlot = (t: Tok) => t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal';
const tpl = (l: string) => detokenize(tokenize(l).map((t) => (isSlot(t) ? { text: '_', cls: 'identifier' as const } : t)));
let eqBuggy = 0, none = 0, other: string[] = [];
for (const r of tp.rows.filter((r) => !r.covered)) { const it = corpus.find((c) => c.name === r.name)!; if (r.top_template === 'none_of_these') none++; else if (it.buggy_line && tpl(it.buggy_line) === r.top_template) eqBuggy++; else other.push(`${r.name}: top=${r.top_template} buggyTpl=${it.buggy_line ? tpl(it.buggy_line) : null}`); }
console.log(`uncovered (n=${tp.rows.filter((r) => !r.covered).length}): none_of_these ${none}, buggy-line template ${eqBuggy}, other ${other.length}: ${JSON.stringify(other)}`);
