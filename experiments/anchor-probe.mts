/**
 * Anchor probe (live, ~$0.01): on QuixBugs Python programs, can Jev (a) pick the buggy line among
 * all lines (Choice), and (b) pick the correct replacement among mutation candidates (Choice)?
 * Usage: node --env-file=.env node_modules/.bin/tsx experiments/anchor-probe.mts [n]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createJevDecider } from '../src/jev/client.ts';
import { choice } from '../src/jev/questions.ts';
import type { Json } from '../src/core/types.ts';

const ROOT = '/tmp/quixbugs';
const n = Number(process.argv[2] ?? 12);
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;

function codeOnly(src: string): string[] {
  // strip the trailing docstring block QuixBugs appends
  const i = src.indexOf('\n"""');
  return (i > 0 ? src.slice(0, i) : src).replace(/\s+$/, '').split('\n');
}
function firstDiffLine(buggy: string[], fixed: string[]): { idx: number; fixedLine: string } | null {
  const fb = fixed.filter((l) => l.trim() !== '');
  const bb = buggy.filter((l) => l.trim() !== '');
  for (let i = 0; i < Math.max(fb.length, bb.length); i++) if (fb[i] !== bb[i]) return { idx: i, fixedLine: fb[i] ?? '' };
  return null;
}
const MUTATIONS: [RegExp, string][] = [
  [/<=/g, '<'], [/>=/g, '>'], [/(?<![<>=!])<(?!=)/g, '<='], [/(?<![<>=!])>(?!=)/g, '>='], [/==/g, '!='], [/!=/g, '=='],
  [/\+ 1\b/g, '- 1'], [/- 1\b/g, '+ 1'], [/\band\b/g, 'or'], [/\bor\b/g, 'and'], [/\+/g, '-'], [/(?<!\*)\*(?!\*)/g, '/'],
  [/\bTrue\b/g, 'False'], [/\bFalse\b/g, 'True'], [/\bnot /g, ''], [/\[0\]/g, '[-1]'], [/\[-1\]/g, '[0]'], [/\/\//g, '/'], [/(?<!\/)\/(?!\/)/g, '//'],
];
function mutants(line: string): string[] {
  const out = new Set<string>();
  for (const [re, rep] of MUTATIONS) { const m = line.replace(re, rep); if (m !== line) out.add(m); }
  // argument swap for f(a, b)
  const sw = line.replace(/\(([^(),]+), ([^(),]+)\)/, '($2, $1)'); if (sw !== line) out.add(sw);
  return [...out];
}

const programs = readdirSync(join(ROOT, 'python_programs')).filter((f) => f.endsWith('.py') && !f.endsWith('_test.py')).map((f) => basename(f, '.py')).filter((p) => existsSync(join(ROOT, 'json_testcases', `${p}.json`))).slice(0, n);
let locTop1 = 0, locTop3 = 0, selTop1 = 0, selN = 0, cost = 0; const lat: number[] = [];
for (const p of programs) {
  const buggy = codeOnly(readFileSync(join(ROOT, 'python_programs', `${p}.py`), 'utf8'));
  const fixed = codeOnly(readFileSync(join(ROOT, 'correct_python_programs', `${p}.py`), 'utf8'));
  const nonEmpty = buggy.map((l, i) => [l, i] as const).filter(([l]) => l.trim() !== '');
  const d = firstDiffLine(buggy, fixed); if (!d) continue;
  const buggyLine = nonEmpty[d.idx]![0];
  const tests = (JSON.parse(`[${readFileSync(join(ROOT, 'json_testcases', `${p}.json`), 'utf8').trim().split('\n').join(',')}]`) as Json[]).slice(0, 3);
  const state: Json = { task: `The function \`${p}\` has a single-line bug. Tests give the input and the expected output.`, program: Object.fromEntries(nonEmpty.map(([l, i]) => [`L${i + 1}`, l])), tests: tests.map((t) => ({ input: (t as Json[])[0]!, expected: (t as Json[])[1]! })) };
  const lineOpts: Record<string, Json> = Object.fromEntries(nonEmpty.map(([l, i]) => [`line_${i + 1}`, l]));
  const qs = { buggy_line: choice('Which line of `program` contains the bug that makes `tests` fail? Pick the single line that must change.', lineOpts) };
  const r1 = await jev.ask(state, qs, { signal, stage: 'context', step: 1 }); cost += r1.usage.costUsd; lat.push(r1.latencyMs);
  const a1 = r1.answers['buggy_line']!; if (a1.type !== 'choice') continue;
  const ranked = Object.entries(a1.probabilities).sort((x, y) => y[1] - x[1]).map(([k]) => k);
  const truth = `line_${nonEmpty[d.idx]![1] + 1}`;
  const hit1 = ranked[0] === truth, hit3 = ranked.slice(0, 3).includes(truth); locTop1 += +hit1; locTop3 += +hit3;
  // (b) candidate selection at the true line
  const cands = mutants(buggyLine); if (!cands.includes(d.fixedLine)) cands.push(d.fixedLine); cands.push(buggyLine);
  const candOpts: Record<string, Json> = Object.fromEntries(cands.map((c, i) => [`candidate_${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`, c]));
  const truthKey = Object.entries(candOpts).find(([, v]) => v === d.fixedLine)![0];
  const r2 = await jev.ask({ ...state, buggy_line: buggyLine, candidates: candOpts }, { fix: choice(`\`buggy_line\` is the faulty line. Which entry of \`candidates\` is the correct replacement that makes all \`tests\` pass?`, Object.fromEntries(Object.keys(candOpts).map((k) => [k, null]))) }, { signal, stage: 'risk', step: 1 });
  cost += r2.usage.costUsd; lat.push(r2.latencyMs);
  const a2 = r2.answers['fix']!; if (a2.type !== 'choice') continue;
  const r2ranked = Object.entries(a2.probabilities).sort((x, y) => y[1] - x[1]);
  const sel1 = r2ranked[0]![0] === truthKey; selTop1 += +sel1; selN++;
  console.log(`${p.padEnd(26)} loc top1=${hit1 ? 'Y' : 'n'} top3=${hit3 ? 'Y' : 'n'} (p=${(a1.probabilities[truth] ?? 0).toFixed(2)}, ${nonEmpty.length} lines) | select ${cands.length} cands top1=${sel1 ? 'Y' : 'n'} p_true=${(a2.probabilities[truthKey] ?? 0).toFixed(2)} top=${(r2ranked[0]![1]).toFixed(2)}`);
}
lat.sort((a, b) => a - b);
console.log(`\nprograms=${selN} localization top1=${locTop1}/${selN} top3=${locTop3}/${selN} | selection top1=${selTop1}/${selN} | cost $${cost.toFixed(4)} | jev p50=${lat[Math.floor(lat.length / 2)]}ms`);
