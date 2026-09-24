/**
 * Live probe: fault localisation on all 40 QuixBugs Python programs with Jev only.
 * Variants: A Choice over lines + 3 tests; B same, 0 tests; C Noul per line ranked by p;
 * D Choice + actual output of the buggy program on a failing test; E coarse (function/block)
 * then line for programs > 15 lines.
 * Prereq: python3 experiments/probe-localize/quixbugs_run.py (writes quixbugs-runs.json).
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-localize/quixbugs-localize.mts [programs...]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, noul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = '/tmp/quixbugs';
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
const GRAPH = new Set(['breadth_first_search', 'depth_first_search', 'detect_cycle', 'minimum_spanning_tree', 'reverse_linked_list', 'shortest_path_length', 'shortest_path_lengths', 'shortest_paths', 'topological_ordering']);

type Run = { kind: 'json' | 'graph'; tests: Record<string, Json>[]; first_failing: number | null };
const runs = JSON.parse(readFileSync(join(HERE, 'quixbugs-runs.json'), 'utf8')) as Record<string, Run>;

function codeOnly(src: string): string[] {
  const i = src.indexOf('\n"""');
  return (i > 0 ? src.slice(0, i) : src).replace(/\s+$/, '').split('\n');
}
type Line = { text: string; lineNo: number }; // lineNo = 1-based original line number
function lines(src: string): Line[] {
  return codeOnly(src).map((text, i) => ({ text, lineNo: i + 1 })).filter((l) => l.text.trim() !== '' && !l.text.trim().startsWith('#'));
}
/** Ground truth: buggy line(s) that must change. For insertions, both neighbours of the insertion point count. */
function truth(buggy: Line[], fixed: Line[]): { keys: Set<number>; kind: 'replace' | 'insert' } {
  const b = buggy.map((l) => l.text), f = fixed.map((l) => l.text);
  let i = 0;
  while (i < b.length && i < f.length && b[i] === f[i]) i++;
  let bi = b.length - 1, fi = f.length - 1;
  while (bi >= i && fi >= i && b[bi] === f[fi]) { bi--; fi--; }
  // b[i..bi] replaced by f[i..fi]
  if (bi < i) return { keys: new Set([buggy[Math.max(0, i - 1)]!.lineNo, buggy[Math.min(i, buggy.length - 1)]!.lineNo]), kind: 'insert' };
  return { keys: new Set(buggy.slice(i, bi + 1).map((l) => l.lineNo)), kind: 'replace' };
}
function indent(s: string): number { return s.length - s.trimStart().length; }
/** Coarse units: innermost enclosing `def` per line; if only one def, the top-level statements of its body. */
function units(ls: Line[]): { name: string; lines: Line[] }[] {
  const defs = ls.filter((l) => /^\s*def /.test(l.text));
  if (defs.length > 1) {
    const out: { name: string; lines: Line[] }[] = [];
    const stack: { name: string; ind: number; lines: Line[] }[] = [];
    for (const l of ls) {
      const ind = indent(l.text);
      while (stack.length && ind <= stack[stack.length - 1]!.ind && !/^\s*def /.test(l.text) === false) stack.pop();
      while (stack.length && ind <= stack[stack.length - 1]!.ind) stack.pop();
      if (/^\s*def /.test(l.text)) {
        const name = /def\s+(\w+)/.exec(l.text)![1]!;
        const u = { name: `function_${name}`, ind, lines: [l] };
        stack.push(u); out.push(u);
      } else if (stack.length) stack[stack.length - 1]!.lines.push(l);
      else { const u = { name: 'module_level', ind: -1, lines: [l] }; out.push(u); }
    }
    return out.map((u) => ({ name: u.name, lines: u.lines }));
  }
  // single function: blocks = top-level statements of the body
  const def = defs[0]!; const bodyInd = ls.find((l) => l.lineNo > def.lineNo) ? indent(ls.find((l) => l.lineNo > def.lineNo)!.text) : 4;
  const out: { name: string; lines: Line[] }[] = [{ name: 'signature', lines: [def] }];
  for (const l of ls) {
    if (l === def) continue;
    if (indent(l.text) <= bodyInd) out.push({ name: `block_${out.length}_line_${l.lineNo}`, lines: [l] });
    else out[out.length - 1]!.lines.push(l);
  }
  return out;
}
function rankOf(probs: Record<string, number>, keys: Set<number>, prefix: string): { rank: number; ranked: string[]; pTruth: number } {
  const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]).map(([k]) => k);
  let rank = Infinity, pTruth = 0;
  for (const k of keys) { const r = ranked.indexOf(`${prefix}${k}`) + 1; if (r > 0 && r < rank) rank = r; pTruth = Math.max(pTruth, probs[`${prefix}${k}`] ?? 0); }
  return { rank, ranked, pTruth };
}

type Row = { program: string; variant: string; nLines: number; truth: number[]; truthKind: string; rank: number; top1: string; pTop: number; pTruth: number; costUsd: number; latencyMs: number; inputTokens: number; requests: number; note?: string };
const rows: Row[] = [];
const LINE_Q = 'Which line of `program` contains the bug? Pick the single line that must change so that the function is correct. Choose `none_of_these` only if no listed line is faulty.';

function testsForState(p: string, run: Run, idx: number[]): Json[] {
  return idx.map((i) => run.tests[i]!).map((t) => run.kind === 'json'
    ? { input: t['input']!, expected: t['expected']! }
    : { name: t['name']!, description: t['doc']!, source: t['source']! });
}
function failingRun(run: Run): Json {
  const t = run.tests[run.first_failing ?? 0]!;
  const outcome = t['timeout'] ? t['error']! : t['error'] ? t['error']! : run.kind === 'json' ? { actual_output: t['actual']! } : 'assertion failed';
  return run.kind === 'json'
    ? { input: t['input']!, expected: t['expected']!, actual: outcome }
    : { name: t['name']!, description: t['doc']!, source: t['source']!, outcome };
}

async function ask(state: Json, qs: Record<string, Question>) {
  const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 });
  return r;
}

async function probe(p: string): Promise<void> {
  const run = runs[p]!;
  const buggy = lines(readFileSync(join(ROOT, 'python_programs', `${p}.py`), 'utf8'));
  const fixed = lines(readFileSync(join(ROOT, 'correct_python_programs', `${p}.py`), 'utf8'));
  const tr = truth(buggy, fixed);
  const program: Json = Object.fromEntries(buggy.map((l) => [`L${l.lineNo}`, l.text]));
  const lineOpts: Record<string, Json> = Object.fromEntries(buggy.map((l) => [`line_${l.lineNo}`, l.text]));
  const taskA = `The Python function \`${p}\` has a single-line bug. \`tests\` give inputs and the expected output (or, for graph programs, the test source); at least one of them fails on the buggy program. Exactly one line of \`program\` must change to fix it.`;
  const taskB = `The Python function \`${p}\` has a single-line bug. Exactly one line of \`program\` must change to fix it.`;
  const firstThree = [0, 1, 2].filter((i) => i < run.tests.length);
  const stateA: Json = { task: taskA, program, tests: testsForState(p, run, firstThree) };
  const stateB: Json = { task: taskB, program };
  const stateD: Json = { task: taskA + ' `failing_test_run` shows what the buggy program actually did on one failing test.', program, tests: testsForState(p, run, firstThree), failing_test_run: failingRun(run) };
  const truthArr = [...tr.keys];
  const base = { program: p, nLines: buggy.length, truth: truthArr, truthKind: tr.kind };

  const choiceVariant = async (variant: string, state: Json) => {
    const r = await ask(state, { buggy_line: choice(LINE_Q, lineOpts) });
    const a = r.answers['buggy_line']!; if (a.type !== 'choice') throw new Error('not choice');
    const { rank, ranked, pTruth } = rankOf(a.probabilities, tr.keys, 'line_');
    rows.push({ ...base, variant, rank, top1: ranked[0]!, pTop: a.probabilities[ranked[0]!]!, pTruth, costUsd: r.usage.costUsd, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens, requests: 1 });
    return { probs: a.probabilities, ranked };
  };
  const rA = await choiceVariant('A_choice_3tests', stateA);
  await choiceVariant('B_choice_0tests', stateB);
  await choiceVariant('D_choice_actual_output', stateD);

  // C: Noul per line, one request
  const crit = {
    true: { definition: 'This line contains the defect: changing this line, and only this line, makes every test pass. The wrong operator, bound, argument, index, condition or return value is on this line.', examples: ['a `while` condition that never becomes false and the test times out', 'a recursive call whose arguments are swapped', 'a `return` of the wrong value or shape', 'an `if` bound using `<` where `<=` is needed'] },
    false: { definition: 'This line is correct as written. It may compute a value the faulty line misuses, be a `def` line, or an unrelated statement.', examples: ['the `def` line of the function', 'an initialisation such as `result = []` that the tests do not contradict', 'a line whose value is consumed by another line where the actual mistake is'] },
  };
  const nouls: Record<string, Question> = Object.fromEntries(buggy.map((l) => [`line_${l.lineNo}`, noul(`Is line \`program.L${l.lineNo}\` the line that must change to fix the bug in \`${p}\`? Judge this line only; other lines are judged separately.`, crit)]));
  const rC = await ask(stateA, nouls);
  const probsC: Record<string, number> = Object.fromEntries(Object.entries(rC.answers).map(([k, a]) => [k, a.type === 'noul' ? a.noul : 0]));
  { const { rank, ranked, pTruth } = rankOf(probsC, tr.keys, 'line_');
    const above = Object.values(probsC).filter((x) => x >= 0.5).length;
    rows.push({ ...base, variant: 'C_noul_per_line', rank, top1: ranked[0]!, pTop: probsC[ranked[0]!]!, pTruth, costUsd: rC.usage.costUsd, latencyMs: rC.latencyMs, inputTokens: rC.usage.inputTokens, requests: 1, note: `lines_p>=0.5=${above}` }); }

  // E: coarse then fine for programs > 15 lines; otherwise reuse A
  if (buggy.length > 15) {
    const us = units(buggy);
    const unitOpts: Record<string, Json> = Object.fromEntries(us.map((u) => [u.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(), u.lines.map((l) => l.text).join('\n')]));
    const r1 = await ask(stateA, { buggy_unit: choice('Which part of `program` (a function or a top-level statement block, given as its source) contains the bug that makes `tests` fail? Choose `none_of_these` only if no listed part is faulty.', unitOpts) });
    const a1 = r1.answers['buggy_unit']!; if (a1.type !== 'choice') throw new Error('not choice');
    const pickKey = Object.entries(a1.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
    const pick = us.find((u) => u.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase() === pickKey);
    const unitHit = pick ? pick.lines.some((l) => tr.keys.has(l.lineNo)) : false;
    let cost = r1.usage.costUsd, tok = r1.usage.inputTokens, lat = r1.latencyMs;
    if (pick && pick.lines.length > 1) {
      const fineOpts: Record<string, Json> = Object.fromEntries(pick.lines.map((l) => [`line_${l.lineNo}`, l.text]));
      const r2 = await ask({ ...(stateA as Record<string, Json>), suspected_part: pick.lines.map((l) => l.text).join('\n') }, { buggy_line: choice('`suspected_part` is the part of `program` believed to contain the bug. Which of its lines (the options) is the single line that must change? Choose `none_of_these` only if no listed line is faulty.', fineOpts) });
      const a2 = r2.answers['buggy_line']!; if (a2.type !== 'choice') throw new Error('not choice');
      cost += r2.usage.costUsd; tok += r2.usage.inputTokens; lat = Math.max(lat, r2.latencyMs);
      // rank within the picked unit; lines outside the unit ranked after, by A's order
      const inner = Object.entries(a2.probabilities).filter(([k]) => k !== 'none_of_these').sort((x, y) => y[1] - x[1]).map(([k]) => k);
      const rest = rA.ranked.filter((k) => !inner.includes(k));
      const ranked = [...inner, ...rest];
      let rank = Infinity; for (const k of tr.keys) { const r = ranked.indexOf(`line_${k}`) + 1; if (r > 0 && r < rank) rank = r; }
      const pTruth = Math.max(...[...tr.keys].map((k) => a2.probabilities[`line_${k}`] ?? 0));
      rows.push({ ...base, variant: 'E_hierarchical', rank, top1: ranked[0]!, pTop: a2.probabilities[inner[0]!]!, pTruth, costUsd: cost, latencyMs: lat, inputTokens: tok, requests: 2, note: `units=${us.length} unit_pick=${pickKey} p=${a1.probabilities[pickKey]!.toFixed(2)} unit_hit=${unitHit}` });
    } else {
      const only = pick?.lines[0];
      const ranked = only ? [`line_${only.lineNo}`, ...rA.ranked.filter((k) => k !== `line_${only.lineNo}`)] : rA.ranked;
      let rank = Infinity; for (const k of tr.keys) { const r = ranked.indexOf(`line_${k}`) + 1; if (r > 0 && r < rank) rank = r; }
      rows.push({ ...base, variant: 'E_hierarchical', rank, top1: ranked[0]!, pTop: a1.probabilities[pickKey]!, pTruth: unitHit ? a1.probabilities[pickKey]! : 0, costUsd: cost, latencyMs: lat, inputTokens: tok, requests: 1, note: `units=${us.length} unit_pick=${pickKey} single-line unit unit_hit=${unitHit}` });
    }
  } else {
    const a = rows.find((r) => r.program === p && r.variant === 'A_choice_3tests')!;
    rows.push({ ...a, variant: 'E_hierarchical', costUsd: 0, inputTokens: 0, requests: 0, note: 'program <= 15 lines: reused A (no extra request)' });
  }
  const fmt = (v: string) => { const r = rows.find((x) => x.program === p && x.variant.startsWith(v))!; return `${v}:${r.rank === 1 ? 'Y' : r.rank}/${r.pTruth.toFixed(2)}`; };
  console.log(`${p.padEnd(28)} ${String(buggy.length).padStart(2)} lines truth=${truthArr.join('|')}(${tr.kind}) ${['A', 'B', 'C', 'D', 'E'].map(fmt).join(' ')}`);
}

const all = readdirSync(join(ROOT, 'python_programs')).filter((f) => f.endsWith('.py') && !f.endsWith('_test.py') && f !== 'node.py').map((f) => f.slice(0, -3)).sort();
const wanted = process.argv.length > 2 ? process.argv.slice(2) : all;
const queue = [...wanted]; const CONC = 6;
await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) { const p = queue.shift()!; try { await probe(p); } catch (e) { console.error(`FAIL ${p}: ${(e as Error).message}`); } } }));

writeFileSync(join(HERE, `quixbugs-localize.rows${process.env['RUN_SUFFIX'] ?? ''}.json`), JSON.stringify(rows, null, 1));
const variants = [...new Set(rows.map((r) => r.variant))].sort();
console.log('\nvariant                    n  top1  top3   MRR   cost      p50ms  in_tok');
for (const v of variants) {
  const rs = rows.filter((r) => r.variant === v);
  const top1 = rs.filter((r) => r.rank === 1).length, top3 = rs.filter((r) => r.rank <= 3).length;
  const mrr = rs.reduce((s, r) => s + (isFinite(r.rank) ? 1 / r.rank : 0), 0) / rs.length;
  const cost = rs.reduce((s, r) => s + r.costUsd, 0); const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(`${v.padEnd(26)} ${String(rs.length).padStart(2)} ${String(top1).padStart(5)} ${String(top3).padStart(5)} ${mrr.toFixed(3).padStart(6)}  $${cost.toFixed(4)}  ${String(lat[Math.floor(lat.length / 2)]).padStart(5)}  ${rs.reduce((s, r) => s + r.inputTokens, 0)}`);
}
console.log(`total cost $${rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
