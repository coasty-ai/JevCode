/**
 * Verification re-run (2026-09-20, adversarial check of probe-progress-judgment.md).
 * Re-asks Part 1 (3 variants), Part 2 variant A and Part 3 on a 6-program sample with the
 * exact wording of probe.mts, writes verify_rerun.json (does NOT touch results.json) and
 * prints agreement with the saved answers. Cost ~ $0.01.
 * Run: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/progress/verify_rerun.mts
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
const CAP_USD = 0.10;
let cost = 0; const lat: number[] = []; let requests = 0;
type TestRow = { id: number; input: Json; expected: Json; actual: Json; status: string };
type Run = { total: number; passed: number; failed: number; tests: TestRow[] };
type Labels = { correct: boolean; progress: boolean; broke: boolean; kind: string };
type Cand = { id: string; line_no: number; old_line: string; new_line: string; after: Run; labels: Labels };
type Prog = { program: string; before: Run; candidates: Cand[] };
const data = JSON.parse(readFileSync(join(HERE, 'candidates.json'), 'utf8')) as Record<string, Prog>;
const prev = JSON.parse(readFileSync(join(HERE, 'results.json'), 'utf8')) as { noulRows: any[]; moveRows: any[]; attackRows: any[] };
const SAMPLE = ['bitcount', 'bucketsort', 'sqrt', 'gcd', 'mergesort', 'hanoi'];
const programs = SAMPLE.map((p) => data[p]!);

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
async function ask(state: Json, qs: Record<string, Question>) {
  if (cost >= CAP_USD) throw new Error(`spend cap ${CAP_USD} reached`);
  const r = await jev.ask(state, qs, { signal, stage: 'judge', step: 1 });
  cost += r.usage.costUsd; lat.push(r.latencyMs); requests++;
  return r.answers;
}
async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]!); } }));
  return out;
}
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

type Item = { program: string; cand: Cand; before: Run };
const items: Item[] = programs.flatMap((p) => p.candidates.map((cand) => ({ program: p.program, cand, before: p.before })));
const VARIANTS: Variant[] = ['counts', 'raw', 'both'];
const noulRows = await pool(items.flatMap((it) => VARIANTS.map((v) => ({ it, v }))), 8, async ({ it, v }) => {
  const state: Json = { task: TASK(it.program), before: view(it.before, v), after: view(it.cand.after, v) };
  const a = await ask(state, { ...Q_NOULS, closeness: Q_SCORE });
  const p: Record<string, number> = {};
  for (const k of Object.keys(Q_NOULS)) { const ans = a[k]!; p[k] = ans.type === 'noul' ? ans.noul : NaN; }
  const sc = a['closeness']!; const probs = sc.type === 'score' ? Object.values(sc.probabilities) : [];
  const saved = prev.noulRows.find((r) => r.program === it.program && r.cand === it.cand.id && r.variant === v)!;
  const truth = { program_correct: it.cand.labels.correct, made_progress: it.cand.labels.progress, broke_something: it.cand.labels.broke };
  return { program: it.program, cand: it.cand.id, kind: it.cand.labels.kind, variant: v, truth, p, saved_p: saved.p, score_argmax: probs.indexOf(Math.max(...probs)), saved_score_argmax: saved.score_probs.indexOf(Math.max(...saved.score_probs)) };
});
const moveRows = await pool(items, 8, async (it) => {
  const saved = prev.moveRows.find((r) => r.program === it.program && r.cand === it.cand.id)!;
  const state: Json = { task: `${TASK(it.program)} \`edit\` is the candidate edit that was applied; \`search\` describes what the repair loop has left to try.`, edit: { line: it.cand.line_no, old_line: it.cand.old_line, new_line: it.cand.new_line }, before: view(it.before, 'both'), after: view(it.cand.after, 'both'), search: saved.search };
  const a = await ask(state, { next_move: Q_MOVE });
  const ans = a['next_move']!; if (ans.type !== 'choice') throw new Error('bad');
  const chosen = Object.entries(ans.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
  return { program: it.program, cand: it.cand.id, kind: it.cand.labels.kind, expected: saved.expected, chosen, saved_chosen: saved.chosen, ok: saved.expected.includes(chosen), p_keep_and_continue: ans.probabilities['keep_and_continue'] ?? 0, saved_p_keep_and_continue: saved.probs['keep_and_continue'] ?? 0 };
});
const attackRows = await pool(programs.filter((p) => p.before.failed >= 2), 8, async (p) => {
  const fails = p.before.tests.filter((t) => t.status !== 'pass').slice(0, 10);
  const opts: Record<string, Json> = Object.fromEntries(fails.map((t) => [`failing_test_${t.id}`, { input: trunc(t.input), expected: trunc(t.expected), actual: trunc(t.actual), status: t.status }]));
  const state: Json = { task: `The Python function \`${p.program}\` fails several tests. \`failing_tests\` lists them with input, expected output and actual result.`, failing_tests: opts };
  const qs = {
    neutral: choice('Which entry of `failing_tests` should the repair attack first?', Object.fromEntries(Object.keys(opts).map((k) => [k, null]))),
    explicit: choice('Which entry of `failing_tests` has the smallest and simplest input, so that the failure is easiest to understand and reproduce by hand?', Object.fromEntries(Object.keys(opts).map((k) => [k, null]))),
  };
  const a = await ask(state, qs);
  const n = a['neutral']!, e = a['explicit']!; if (n.type !== 'choice' || e.type !== 'choice') throw new Error('bad');
  const saved = prev.attackRows.find((r) => r.program === p.program)!;
  return { program: p.program, neutral_choice: n.choice, saved_neutral: saved.neutral_choice, explicit_choice: e.choice, saved_explicit: saved.explicit_choice };
});

// ---- agreement summary ----
let maxDiff = 0, sumDiff = 0, nd = 0, flips = 0, correct = 0, tot = 0, scoreAgree = 0;
for (const r of noulRows) for (const k of Object.keys(Q_NOULS)) {
  const d = Math.abs(r.p[k]! - r.saved_p[k]); maxDiff = Math.max(maxDiff, d); sumDiff += d; nd++;
  if ((r.p[k]! >= 0.5) !== (r.saved_p[k] >= 0.5)) flips++;
  if ((r.p[k]! >= 0.5) === (r.truth as any)[k]) correct++; tot++;
}
for (const r of noulRows) if (r.score_argmax === r.saved_score_argmax) scoreAgree++;
const moveAgree = moveRows.filter((r) => r.chosen === r.saved_chosen).length, moveOk = moveRows.filter((r) => r.ok).length;
const attAgreeN = attackRows.filter((r) => r.neutral_choice === r.saved_neutral).length, attAgreeE = attackRows.filter((r) => r.explicit_choice === r.saved_explicit).length;
lat.sort((a, b) => a - b);
const summary = { date: new Date().toISOString(), programs: SAMPLE, requests, costUsd: cost, latencyP50: lat[Math.floor(lat.length / 2)], noul_answers: tot, noul_correct_at_05: correct, noul_mean_abs_diff_vs_saved: sumDiff / nd, noul_max_abs_diff_vs_saved: maxDiff, noul_threshold_flips_vs_saved: flips, score_argmax_agree: `${scoreAgree}/${noulRows.length}`, move_n: moveRows.length, move_correct: moveOk, move_argmax_agree_with_saved: moveAgree, attack_n: attackRows.length, attack_neutral_agree: attAgreeN, attack_explicit_agree: attAgreeE };
writeFileSync(join(HERE, 'verify_rerun.json'), JSON.stringify({ summary, noulRows, moveRows, attackRows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log('partials (move A):', JSON.stringify(moveRows.filter((r) => r.kind.startsWith('partial')).map((r) => [r.program, r.chosen, r.saved_chosen, r.p_keep_and_continue, r.saved_p_keep_and_continue])));
