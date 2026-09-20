/**
 * Progress-judgment probe (live Jev, ~$0.15): can Jev steer a repair search from test results?
 * Input: candidates.json (from gen_candidates.py). Output: results.json + tables.md in this dir.
 * Run: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/progress/probe.mts [maxPrograms]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, noul, score } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
const CAP_USD = 1.0;
let cost = 0; const lat: number[] = []; let requests = 0;

type TestRow = { id: number; input: Json; expected: Json; actual: Json; status: string };
type Run = { total: number; passed: number; failed: number; tests: TestRow[] };
type Labels = { correct: boolean; progress: boolean; broke: boolean; kind: string; newly_passing: number[]; newly_failing: number[] };
type Cand = { id: string; line_no: number; old_line: string; new_line: string; code: string; after: Run; labels: Labels };
type Prog = { program: string; bug_line_no: number; excluded_tests: number[]; before: Run; candidates: Cand[] };

const data = JSON.parse(readFileSync(join(HERE, 'candidates.json'), 'utf8')) as Record<string, Prog>;
const maxPrograms = Number(process.argv[2] ?? 1000);
const programs = Object.values(data).slice(0, maxPrograms);

// ---------- state builders ----------
const trunc = (v: Json): Json => { const s = JSON.stringify(v); return s.length > 240 ? `${s.slice(0, 240)}…` : v; };
function failures(run: Run): Json[] { return run.tests.filter((t) => t.status !== 'pass').map((t) => ({ test: `test_${t.id}`, input: trunc(t.input), expected: trunc(t.expected), actual: trunc(t.actual), status: t.status })); }
type Variant = 'counts' | 'raw' | 'both';
function view(run: Run, v: Variant): Json {
  const first = run.tests.find((t) => t.status !== 'pass');
  if (v === 'counts') return { passed: run.passed, failed: run.failed, total: run.total, first_failure: first ? { input: trunc(first.input), expected: trunc(first.expected), actual: trunc(first.actual) } : null };
  if (v === 'raw') return { failing_tests: failures(run) };
  return { passed: run.passed, failed: run.failed, total: run.total, failing_tests: failures(run) };
}
const TASK = (p: string) => `A candidate edit was applied to the Python function \`${p}\`. \`before\` is the test result of the program before the edit; \`after\` is the test result after the edit. Judge from the test results only. A test counts as failing if its status is fail, error or timeout.`;

async function ask(state: Json, qs: Record<string, Question>, tag: string) {
  if (cost >= CAP_USD) throw new Error(`spend cap ${CAP_USD} reached`);
  const r = await jev.ask(state, qs, { signal, stage: 'judge', step: 1 });
  cost += r.usage.costUsd; lat.push(r.latencyMs); requests++;
  if (requests % 50 === 0) console.error(`[${tag}] requests=${requests} cost=$${cost.toFixed(4)}`);
  return r.answers;
}
async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]!); } }));
  return out;
}

// ---------- questions ----------
const Q_NOULS: Record<string, Question> = {
  program_correct: noul('After the edit, does `after` show the program passing every test, so that the program is now correct?', {
    true: { definition: 'every test passes in `after`; no failing, erroring or timed-out test remains', examples: ['`after.failed` is 0 and `after.passed` equals `after.total`', '`after.failing_tests` is an empty list'] },
    false: { definition: 'at least one test still fails, errors or times out in `after`', examples: ['`after` lists two failing tests', '`after.passed` is 8 of 9', 'one test times out after the edit'] },
  }),
  made_progress: noul('Compared with `before`, did this edit make progress: does the program pass strictly more tests in `after` than in `before`?', {
    true: { definition: 'the number of passing tests in `after` is larger than in `before` (fewer tests fail after the edit than before it)', examples: ['before passed 1 of 9, after passes 4 of 9', 'a test listed under `before.failing_tests` is missing from `after.failing_tests` and no new failure appeared'] },
    false: { definition: 'the same number or fewer tests pass after the edit; the results are unchanged or worse', examples: ['before and after list the same failing tests', 'after passes fewer tests than before', 'the failing tests changed but their number did not shrink'] },
  }),
  broke_something: noul('Did the edit break something that worked: is there a test that passed in `before` but fails, errors or times out in `after`?', {
    true: { definition: 'at least one test that was passing before the edit is failing after it', examples: ['a test appears in `after.failing_tests` that is not in `before.failing_tests`', 'before passed 5 of 6, after passes 0 of 6'] },
    false: { definition: 'every test that passed before the edit still passes after it', examples: ['the set of failing tests shrank or stayed exactly the same', 'before passed 1 of 9, after passes 9 of 9'] },
  }),
};
const Q_SCORE = score('Judging from `after` only, how close is the program to correct?', [
  'nothing works: every test fails, errors or times out',
  'mostly broken: a small minority of the tests pass, most fail',
  'half way: roughly as many tests pass as fail',
  'nearly correct: most tests pass, a few still fail',
  'correct: every test passes, no failures remain',
]);
const MOVE_OPTS: Record<string, string> = {
  keep_and_stop: 'every test passes in `after`: keep the edit and finish the task',
  keep_and_continue: 'the edit made some previously failing tests pass without breaking any, and failures remain: keep the edit and work on the remaining failing tests',
  revert_and_try_next_candidate: 'the edit did not help or broke tests, and `search.candidates_remaining_for_this_line` is above zero: revert the edit and try the next candidate edit for the same line',
  revert_and_relocalise: 'the edit did not help or broke tests, no candidates remain for this line, and `search.untried_suspicious_lines` is above zero: revert and move to a different suspicious line',
  widen_search: 'the edit did not help or broke tests, no candidates remain for this line and no untried suspicious lines remain: revert and widen the search to more lines or another source of candidate edits',
};
const Q_MOVE = choice('What should the repair loop do next, given `edit`, `before`, `after` and `search`?', MOVE_OPTS);

function expectedMove(c: Cand, search: { candidates_remaining_for_this_line: number; untried_suspicious_lines: number }): string[] {
  if (c.labels.kind === 'fix') return ['keep_and_stop'];
  if (c.labels.kind === 'partial') return ['keep_and_continue'];
  if (c.labels.kind === 'partial_mixed') return ['keep_and_continue', 'revert_and_try_next_candidate'];
  if (search.candidates_remaining_for_this_line > 0) return ['revert_and_try_next_candidate'];
  if (search.untried_suspicious_lines > 0) return ['revert_and_relocalise'];
  return ['widen_search'];
}

// ---------- run ----------
type Item = { program: string; cand: Cand; before: Run };
const items: Item[] = programs.flatMap((p) => p.candidates.map((cand) => ({ program: p.program, cand, before: p.before })));
console.error(`programs=${programs.length} candidates=${items.length}`);

// Part 1 + 4: nouls and score per variant
const VARIANTS: Variant[] = ['counts', 'raw', 'both'];
type NoulRow = { program: string; cand: string; kind: string; variant: Variant; truth: Record<string, boolean>; p: Record<string, number>; score_probs: number[]; score_expected: number; true_fraction: number };
const noulRows = (await pool(items.flatMap((it) => VARIANTS.map((v) => ({ it, v }))), 8, async ({ it, v }) => {
  const state: Json = { task: TASK(it.program), before: view(it.before, v), after: view(it.cand.after, v) };
  const a = await ask(state, { ...Q_NOULS, closeness: Q_SCORE }, `nouls/${v}`);
  const p: Record<string, number> = {};
  for (const k of Object.keys(Q_NOULS)) { const ans = a[k]!; p[k] = ans.type === 'noul' ? ans.noul : NaN; }
  const sc = a['closeness']!; const probs = sc.type === 'score' ? Object.values(sc.probabilities) : [];
  const expected = probs.reduce((s, q, i) => s + q * i, 0);
  return { program: it.program, cand: it.cand.id, kind: it.cand.labels.kind, variant: v, truth: { program_correct: it.cand.labels.correct, made_progress: it.cand.labels.progress, broke_something: it.cand.labels.broke }, p, score_probs: probs, score_expected: expected, true_fraction: it.cand.after.passed / it.cand.after.total } satisfies NoulRow;
}));
console.error(`part1/4 done cost=$${cost.toFixed(4)}`);

// Part 2: next move
type MoveRow = { program: string; cand: string; kind: string; search: Json; expected: string[]; chosen: string; p_expected: number; probs: Record<string, number>; ok: boolean };
const SEARCH_CTX = [{ candidates_remaining_for_this_line: 3, untried_suspicious_lines: 2 }, { candidates_remaining_for_this_line: 0, untried_suspicious_lines: 2 }, { candidates_remaining_for_this_line: 0, untried_suspicious_lines: 0 }];
let ctxIdx = 0;
const moveRows = (await pool(items, 8, async (it) => {
  const wrong = !['fix', 'partial', 'partial_mixed'].includes(it.cand.labels.kind);
  const search = wrong ? SEARCH_CTX[ctxIdx++ % 3]! : SEARCH_CTX[0]!;
  const exp = expectedMove(it.cand, search);
  const state: Json = { task: `${TASK(it.program)} \`edit\` is the candidate edit that was applied; \`search\` describes what the repair loop has left to try.`, edit: { line: it.cand.line_no, old_line: it.cand.old_line, new_line: it.cand.new_line }, before: view(it.before, 'both'), after: view(it.cand.after, 'both'), search };
  const a = await ask(state, { next_move: Q_MOVE }, 'move');
  const ans = a['next_move']!; if (ans.type !== 'choice') throw new Error('bad');
  const chosen = Object.entries(ans.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
  return { program: it.program, cand: it.cand.id, kind: it.cand.labels.kind, search, expected: exp, chosen, p_expected: Math.max(...exp.map((e) => ans.probabilities[e] ?? 0)), probs: ans.probabilities, ok: exp.includes(chosen) } satisfies MoveRow;
}));
console.error(`part2 done cost=$${cost.toFixed(4)}`);

// Part 3: which failing test first (programs with >= 2 failing tests before)
type AttackRow = { program: string; n_failing: number; lengths: number[]; neutral_choice: string; explicit_choice: string; simplest: string; neutral_rank_of_simplest: number; explicit_rank_of_simplest: number; neutral_probs: Record<string, number>; explicit_probs: Record<string, number> };
const attackRows = (await pool(programs.filter((p) => p.before.failed >= 2), 8, async (p) => {
  const fails = p.before.tests.filter((t) => t.status !== 'pass').slice(0, 10);
  const opts: Record<string, Json> = Object.fromEntries(fails.map((t) => [`failing_test_${t.id}`, { input: trunc(t.input), expected: trunc(t.expected), actual: trunc(t.actual), status: t.status }]));
  const lengths = fails.map((t) => JSON.stringify(t.input).length);
  const simplestIdx = lengths.indexOf(Math.min(...lengths));
  const simplest = `failing_test_${fails[simplestIdx]!.id}`;
  const state: Json = { task: `The Python function \`${p.program}\` fails several tests. \`failing_tests\` lists them with input, expected output and actual result.`, failing_tests: opts };
  const qs = {
    neutral: choice('Which entry of `failing_tests` should the repair attack first?', Object.fromEntries(Object.keys(opts).map((k) => [k, null]))),
    explicit: choice('Which entry of `failing_tests` has the smallest and simplest input, so that the failure is easiest to understand and reproduce by hand?', Object.fromEntries(Object.keys(opts).map((k) => [k, null]))),
  };
  const a = await ask(state, qs, 'attack');
  const rank = (ans: Record<string, number>) => Object.entries(ans).filter(([k]) => k !== 'none_of_these').sort((x, y) => y[1] - x[1]).findIndex(([k]) => k === simplest) + 1;
  const n = a['neutral']!, e = a['explicit']!; if (n.type !== 'choice' || e.type !== 'choice') throw new Error('bad');
  return { program: p.program, n_failing: fails.length, lengths, neutral_choice: n.choice, explicit_choice: e.choice, simplest, neutral_rank_of_simplest: rank(n.probabilities), explicit_rank_of_simplest: rank(e.probabilities), neutral_probs: n.probabilities, explicit_probs: e.probabilities } satisfies AttackRow;
}));
console.error(`part3 done cost=$${cost.toFixed(4)}`);

lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length / 2)] ?? 0, p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
writeFileSync(join(HERE, 'results.json'), JSON.stringify({ meta: { date: new Date().toISOString(), model: jev.model, programs: programs.length, candidates: items.length, requests, costUsd: cost, latencyP50: p50, latencyP95: p95 }, noulRows, moveRows, attackRows }, null, 1));
console.log(`requests=${requests} cost=$${cost.toFixed(4)} p50=${p50}ms p95=${p95}ms`);
